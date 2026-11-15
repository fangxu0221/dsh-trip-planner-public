/** 使用有限的主题搜索、已选地点的路线及建议停留时间生成单日行程。 */
import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { dayItineraryQuerySchema, type DayItineraryQuery, type DayItineraryResult, type ItineraryConstraints, type ItineraryItem, type ItineraryVisit } from '../contracts/day-itinerary.ts'
import type { EndpointReference } from '../contracts/routes.ts'
import type { Place, PlaceDetailsResult } from '../contracts/travel.ts'
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
  return matchText(city).replace(/市$/u, '')
}

const matchText = (value: string) => value.normalize('NFKC').trim().toLowerCase()

function textEvidence(place: Place, match: (value: string) => string | undefined): string | undefined {
  const name = match(place.name)
  if (name) return '名称匹配' + name
  const category = place.category && match(place.category)
  return category ? '类型匹配' + category : undefined
}

function preferred(place: Place, area: string | null): boolean {
  return area !== null && [place.businessArea, place.district].some(value => value && matchText(value) === matchText(area))
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
    const constraints: ItineraryConstraints = {
      includeDistricts: [...new Set(request.includeDistricts)], excludeDistricts: [...new Set(request.excludeDistricts)],
      excludeKeywords: [...new Set(request.excludeKeywords)], preferredArea: request.preferredArea ?? null,
    }
    if (constraints.includeDistricts.some(district => constraints.excludeDistricts.includes(district))) {
      throw new HarnessError('同一个区县不能同时指定为游览范围和排除范围，请确认。', 'TRIP_INVALID_ITINERARY')
    }
    const signal = AbortSignal.any([this.lifetime.signal, execution.signal])
    signal.throwIfAborted()
    const result: DayItineraryResult = {
      source: 'AMAP', city: request.city, theme: request.theme, mode: request.mode,
      ...(constraints.includeDistricts.length || constraints.excludeDistricts.length || constraints.excludeKeywords.length
        || constraints.preferredArea ? { constraints } : {}),
      startMinute, endMinute, defaultStart: !request.startTime, defaultEnd: !request.endTime,
      status: 'incomplete', visits: [], route: null, timeline: [], finishMinute: null, overByMinutes: null, message: null,
    }
    const pending = this.build(request, constraints, result, { ...execution, signal,
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

  private async build(query: DayItineraryQuery, constraints: ItineraryConstraints, result: DayItineraryResult,
    execution: QueryExecution): Promise<DayItineraryResult> {
    const { signal } = execution
    const origin = await this.resolveEndpoint(query.origin)
    signal.throwIfAborted()
    const destination = query.returnToOrigin ? origin : await this.resolveEndpoint(query.destination)
    const excluded = new Set([origin?.placeId, destination?.placeId])
    const seen = new Set<string>()
    const verified = new Map<string, PlaceDetailsResult>()
    const candidates: { place: Place; visit: ItineraryVisit }[] = []
    const theme = Object.hasOwn(themes, query.theme) ? themes[query.theme as keyof typeof themes] : undefined
    const terms = [...new Set(query.themeKeywords ?? theme?.keywords ?? [query.theme])]
    const matches = (value: string) => terms.find(term => matchText(value).includes(matchText(term)))
      ?? theme?.match.exec(value)?.[0]
    const { includeDistricts, excludeDistricts, excludeKeywords, preferredArea } = constraints
    const strictRegion = includeDistricts.length > 0 || excludeDistricts.length > 0
    const wrongCity = (city: string | null) => city !== null && cityKey(city) !== cityKey(query.city)
    const wrongDistrict = (district?: string) => {
      if (!district) return false
      const name = district.normalize('NFKC')
      return excludeDistricts.includes(name) || (includeDistricts.length > 0 && !includeDistricts.includes(name))
    }
    const rejectPlace = (place: Place) => ancillary.test(place.name)
      || excludeKeywords.some(term => [place.name, place.category ?? ''].some(value => matchText(value).includes(matchText(term))))
    const keywords = includeDistricts.length === 1 ? [includeDistricts[0] + ' ' + terms[0], terms[1] ?? terms[0]] : terms
    let outside = 0
    let unverified = 0
    let budgetMessage: string | null = null
    let lookupLimited = false
    let lookups = 0
    const lookupExecution = { ...execution, beforePlaceLookup: () => {
      if (lookups >= 4) throw new HarnessError('已达到本次行程的地点核验上限。', 'TRIP_ITINERARY_LOOKUP_BUDGET')
      execution.beforePlaceLookup?.()
      lookups++
    } }
    const enough = () => preferredArea
      ? candidates.filter(candidate => preferred(candidate.place, preferredArea)).length >= 2
      : candidates.length >= 2
    const shortlist = () => [...candidates].sort((a, b) =>
      Number(preferred(b.place, preferredArea)) - Number(preferred(a.place, preferredArea))).slice(0, 2).map(candidate => candidate.visit)
    for (const keyword of keywords) {
      signal.throwIfAborted()
      let places: Place[]
      try {
        const search = await this.ctx.travelData.searchPlaces({ keywords: keyword, city: query.city }, execution)
        places = search.places
        signal.throwIfAborted()
      } catch (error) {
        signal.throwIfAborted()
        if (!preferredArea || candidates.length < 2) {
          return { ...result, visits: shortlist(), message: queryMessage(error, '地点搜索未完成，可以稍后重新规划。') }
        }
        queryMessage(error, '地点搜索未完成。')
        break
      }
      // 优先核验已有主题依据的候选，把详情额度留给更相关的地点。
      const ordered = [...places].sort((a, b) => Number(!!textEvidence(b, matches)) - Number(!!textEvidence(a, matches)))
      for (let place of ordered) {
        signal.throwIfAborted()
        if (excluded.has(place.id) || rejectPlace(place)) continue
        excluded.add(place.id)
        if (wrongCity(place.city) || wrongDistrict(place.district)) { outside++; continue }
        const reason = textEvidence(place, matches)
        if (!reason && (place.category || (theme && !query.themeKeywords))) continue
        let details: PlaceDetailsResult | undefined
        try {
          if (strictRegion || !reason || (excludeKeywords.length && !place.category) || (preferredArea && !preferred(place, preferredArea))) {
            details = await this.ctx.travelData.getPlaceDetails(place.id, lookupExecution)
            const resolved = details.place
            place = { ...place, ...resolved, city: resolved.city ?? place.city, address: resolved.address ?? place.address }
            if (rejectPlace(place) || !textEvidence(place, matches)) continue
            if (wrongCity(place.city) || wrongDistrict(place.district)) { outside++; continue }
            if (strictRegion && (!place.district || !place.city) && resolved.coordinates) {
              const region = await this.ctx.travelData.getPlaceRegion(resolved.coordinates, lookupExecution)
              place = { ...place, city: region.city ?? place.city, district: region.district ?? place.district }
            }
          }
        } catch (error) {
          signal.throwIfAborted()
          if (error instanceof HarnessError && error.code === 'TRIP_AGENT_QUERY_BUDGET') {
            budgetMessage = error.message
            break
          }
          if (error instanceof HarnessError && error.code === 'TRIP_ITINERARY_LOOKUP_BUDGET') lookupLimited = true
          queryMessage(error, '地点信息未能核验。')
          if (strictRegion || !reason || excludeKeywords.length) { unverified++; continue }
        }
        if (wrongCity(place.city) || wrongDistrict(place.district)) { outside++; continue }
        if (strictRegion && (!place.city || !place.district || !place.coordinates)) { unverified++; continue }
        const matched = textEvidence(place, matches)
        if (!matched) continue
        const identity = matchText(place.name) + '\0' + matchText(place.address ?? '') + '\0' + (place.district ?? '')
        if (seen.has(identity)) continue
        seen.add(identity)
        if (details?.place.coordinates) verified.set(place.id, { ...details, place })
        candidates.push({ place, visit: { placeId: place.id, name: place.name, address: place.address, reason: matched,
          stayMinutes: query.stayMinutes ?? theme?.stay ?? 60, ...(place.district && { district: place.district }) } })
        if (enough()) break
      }
      if (enough() || budgetMessage) break
    }
    result.visits = shortlist()
    if (result.visits.length < 2) {
      const notes = [
        outside > 0 && outside + ' 个候选不在指定地区。',
        unverified > 0 && unverified + ' 个候选的必要信息未能核验。',
        lookupLimited && '已达到本次行程的地点核验上限。',
        budgetMessage,
      ].filter(Boolean).join('')
      return { ...result, status: 'insufficient-places',
        message: '已确认 ' + result.visits.length + ' 个符合条件的地点。' + notes + '可以调整主题或地区后再规划。' }
    }

    const stops: EndpointReference[] = result.visits.map(place => ({ kind: 'poi', placeId: place.placeId }))
    if (origin) stops.unshift(origin.reference)
    if (destination) stops.push(destination.reference)
    try {
      const route = stops.length === 2
        ? await this.ctx.routePlanner.plan({ origin: stops[0], destination: stops[1], mode: query.mode }, execution, verified)
        : await this.ctx.routePlanner.planMultiStop({ stops, mode: query.mode, order: 'optimized',
          pinStart: !!origin, pinEnd: !!destination }, execution, verified)
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
