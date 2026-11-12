/** 使用有限的主题搜索、已选地点的路线及建议停留时间生成单日行程。 */
import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { dayItineraryQuerySchema, type DayItineraryQuery, type DayItineraryResult, type ItineraryItem, type ItineraryVisit } from '../contracts/day-itinerary.ts'
import type { EndpointReference } from '../contracts/routes.ts'
import ItineraryPlannerService from '../services/itinerary-planner.ts'
import type {} from '../services/route-planner.ts'
import type {} from '../services/saved-places.ts'
import type { QueryExecution } from '../services/travel-data.ts'

const themes = {
  culture: { keywords: ['博物馆', '美术馆'], match: /博物馆|美术馆|纪念馆|展览馆|文化馆/u, stay: 90 },
  park: { keywords: ['公园', '植物园'], match: /公园|植物园|湿地|绿道/u, stay: 60 },
  landmark: { keywords: ['地标景点', '历史街区'], match: /塔$|地标|景区|古城|古镇|广场|老街|街区|步行街/u, stay: 60 },
} as const
const ancillary = /停车|售票|出入口|地铁站|公交站|服务中心|管理处|卫生间|咖啡|酒店|分店|(?:入口|出口|[东西南北正后侧]门)[）)]?$/u

function minutes(time: string): number {
  const [hour, minute] = time.split(':').map(Number)
  return hour * 60 + minute
}

function cityKey(city: string): string {
  return city.trim().replace(/市$/u, '')
}

function queryMessage(error: unknown, fallback: string): string {
  if (error instanceof HarnessError) {
    if (error.code === 'TRIP_AGENT_QUERY_BUDGET') return error.message
    if (error.code.startsWith('TRIP_')) return fallback
  }
  if (error instanceof Error && error.name === 'TimeoutError') return fallback
  throw error
}

function schedule(route: NonNullable<DayItineraryResult['route']>, visits: ItineraryVisit[], start: number) {
  const stops = 'stops' in route ? route.stops : [route.origin, route.destination]
  const legs = 'stops' in route ? route.legs.map(leg => leg.route?.durationSeconds ?? null)
    : [route.status === 'found' ? route.routes[0]?.durationSeconds ?? null : null]
  const timeline: ItineraryItem[] = []
  let cursor: number | null = start
  function add(kind: ItineraryItem['kind'], title: string, duration: number | null, legIndex: number | null, placeId?: string) {
    const endMinute: number | null = cursor === null || duration === null ? null : cursor + duration
    timeline.push({ kind, title, startMinute: cursor, endMinute, legIndex, ...(placeId ? { placeId } : {}) })
    cursor = endMinute
  }
  stops.forEach((stop, index) => {
    const label = stop.alias ?? stop.name
    if (index > 0) {
      const seconds = legs[index - 1]
      const previous = stops[index - 1]
      add('travel', (previous.alias ?? previous.name) + ' → ' + label, seconds == null ? null : Math.ceil(seconds / 60), index - 1)
    }
    const visit = visits.find(point => point.placeId === stop.placeId)
    if (visit) add('visit', '游览' + label, visit.stayMinutes, null, visit.placeId)
  })
  return { timeline, finishMinute: timeline.at(-1)?.endMinute ?? null }
}

export default class ItineraryPlanner extends ItineraryPlannerService {
  static inject = ['travelData', 'routePlanner', 'savedPlaces']
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<DayItineraryResult>>()

  constructor(ctx: Context) {
    super(ctx)
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('行程规划服务已卸载'))
      await Promise.allSettled(this.pending)
    })
  }

  override async plan(query: DayItineraryQuery, execution: QueryExecution): Promise<DayItineraryResult> {
    const parsed = dayItineraryQuerySchema.safeParse(query)
    if (!parsed.success) throw new HarnessError('请提供城市、支持的主题和交通方式，时间使用 HH:mm。', 'TRIP_INVALID_ITINERARY')
    const request = parsed.data
    const startMinute = minutes(request.startTime ?? '10:00')
    const endMinute = minutes(request.endTime ?? '18:00')
    if (endMinute <= startMinute || (request.returnToOrigin && (!request.origin || request.destination))) {
      throw new HarnessError('结束时间须晚于开始时间。返回起点时请提供起点并省略独立终点。', 'TRIP_INVALID_ITINERARY')
    }
    const signal = AbortSignal.any([this.lifetime.signal, execution.signal])
    signal.throwIfAborted()
    const result: DayItineraryResult = {
      source: 'AMAP', city: request.city, theme: request.theme, mode: request.mode,
      startMinute, endMinute, defaultStart: !request.startTime, defaultEnd: !request.endTime,
      status: 'incomplete', visits: [], route: null, timeline: [], finishMinute: null, overByMinutes: null, message: null,
    }
    const pending = this.build(request, result, { ...execution, signal,
      deferContext: context => execution.deferContext?.(context), concludeTurn: () => execution.concludeTurn?.(),
    })
    this.pending.add(pending)
    try { return await pending } finally { this.pending.delete(pending) }
  }

  private async resolveEndpoint(ref: EndpointReference | undefined): Promise<{ reference: EndpointReference; placeId: string } | undefined> {
    if (!ref) return
    if (ref.kind === 'poi') return { reference: ref, placeId: ref.placeId }
    const saved = await this.ctx.savedPlaces.get(ref.alias)
    if (!saved || (ref.expectedId !== undefined && saved.id !== ref.expectedId)) {
      throw new HarnessError('找不到选中的收藏地点，请重新选择起点或终点。', 'TRIP_ITINERARY_ENDPOINT_MISSING')
    }
    return { reference: { ...ref, expectedId: saved.id }, placeId: saved.placeId }
  }

  private async build(query: DayItineraryQuery, result: DayItineraryResult, execution: QueryExecution): Promise<DayItineraryResult> {
    const { signal } = execution
    const origin = await this.resolveEndpoint(query.origin)
    signal.throwIfAborted()
    const destination = query.returnToOrigin ? origin : await this.resolveEndpoint(query.destination)
    const excluded = new Set([origin?.placeId, destination?.placeId])
    const seen = new Set<string>()
    const theme = themes[query.theme]
    for (const keywords of theme.keywords) {
      signal.throwIfAborted()
      try {
        const search = await this.ctx.travelData.searchPlaces({ keywords, city: query.city }, execution)
        signal.throwIfAborted()
        for (const place of search.places) {
          const matched = theme.match.exec(place.name)?.[0]
          const identity = place.name.normalize('NFKC').trim() + '\0' + (place.address ?? '').normalize('NFKC').trim()
          if (!matched || ancillary.test(place.name) || excluded.has(place.id) || seen.has(identity)
            || (place.city && cityKey(place.city) !== cityKey(query.city))) continue
          result.visits.push({ placeId: place.id, name: place.name, address: place.address,
            reason: '名称匹配' + matched, stayMinutes: query.stayMinutes ?? theme.stay })
          excluded.add(place.id)
          seen.add(identity)
          if (result.visits.length === 2) break
        }
      } catch (error) {
        signal.throwIfAborted()
        return { ...result, message: queryMessage(error, '地点搜索未完成，可以稍后重新规划。') }
      }
      if (result.visits.length === 2) break
    }
    if (result.visits.length < 2) return { ...result, status: 'insufficient-places',
      message: '已找到 ' + result.visits.length + ' 个符合条件的地点。可放宽主题或换一个城市。' }

    const stops: EndpointReference[] = result.visits.map(place => ({ kind: 'poi', placeId: place.placeId }))
    if (origin) stops.unshift(origin.reference)
    if (destination) stops.push(destination.reference)
    try {
      const route = stops.length === 2
        ? await this.ctx.routePlanner.plan({ origin: stops[0], destination: stops[1], mode: query.mode }, execution)
        : await this.ctx.routePlanner.planMultiStop({ stops, mode: query.mode, order: 'optimized',
          pinStart: !!origin, pinEnd: !!destination }, execution)
      signal.throwIfAborted()
      const { timeline, finishMinute } = schedule(route, result.visits, result.startMinute)
      const overByMinutes = finishMinute === null ? null : Math.max(0, finishMinute - result.endMinute)
      const ordered = 'stops' in route ? route.stops : [route.origin, route.destination]
      const visits = ordered.flatMap(stop => result.visits.filter(visit => visit.placeId === stop.placeId))
      const routeMessage = 'stops' in route ? route.legs.find(leg => leg.message)?.message : null
      return { ...result, route, visits, timeline, finishMinute, overByMinutes,
        status: finishMinute === null ? 'incomplete' : overByMinutes ? 'over-window' : 'ready',
        message: finishMinute === null ? (routeMessage ? routeMessage + '后续时刻待定。' : '部分交通段暂无路线或耗时，后续时刻待定。') : null,
      }
    } catch (error) {
      signal.throwIfAborted()
      return { ...result, message: queryMessage(error, '交通路线未完成，已保留入选地点。') }
    }
  }
}
