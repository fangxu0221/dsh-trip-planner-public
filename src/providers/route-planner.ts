/** 角色二：组织地点解析与路线查询，复用收藏服务和出行数据服务，不直接读文件或请求 HTTP。 */
import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { Config } from '../config.ts'
import { maxMultiStopPlaces } from '../contracts/route-limits.ts'
import {
  planMultiStopRouteQuerySchema, planRouteQuerySchema, type EndpointReference, type MultiStopLeg,
  type PlanMultiStopRouteQuery, type PlanMultiStopRouteResult, type PlanRouteQuery, type PlanRouteResult,
  type RouteEndpoint, type RouteMode,
} from '../contracts/routes.ts'
import type { PlaceDetailsResult } from '../contracts/travel.ts'
import { optimizeRouteOrder, type PinnedStops } from '../services/route-order.ts'
import RoutePlannerService from '../services/route-planner.ts'
import type { SavedPlace } from '../services/saved-places.ts'
import type { QueryExecution } from '../services/travel-data.ts'

interface SelectedEndpoint { placeId: string; alias: string | null; saved?: SavedPlace }

function total(legs: MultiStopLeg[], field: 'durationSeconds' | 'distanceMeters'): number | null {
  let sum = 0
  for (const leg of legs) {
    const value = leg.route?.[field]
    if (value == null) return null
    sum += value
  }
  return sum
}

export default class RoutePlanner extends RoutePlannerService {
  static inject = ['savedPlaces', 'travelData']
  private readonly settings: Config
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.settings = config
    ctx.effect(() => {
      if (config.showLifecycleLogs) console.log('[路线规划] 服务已加载')
      return async () => {
        this.lifetime.abort(new Error('路线规划服务已卸载'))
        await Promise.allSettled([...this.pending])
        if (config.showLifecycleLogs) console.log('[路线规划] 服务已卸载，未完成的查询已取消')
      }
    })
  }

  override async plan(query: PlanRouteQuery, execution: QueryExecution): Promise<PlanRouteResult> {
    const parsed = planRouteQuerySchema.safeParse(query)
    if (!parsed.success) throw new HarnessError('路线参数不合法：起终点必须是收藏别名或地点 ID，且需指定支持的交通方式。', 'TRIP_INVALID_ROUTE_QUERY')
    const { mode } = parsed.data
    return this.run(execution, async active => {
      const [origin, destination] = await this.resolveStops([parsed.data.origin, parsed.data.destination], mode, active)
      const result = await this.ctx.travelData.planRoute({ origin, destination, mode }, active)
      active.signal.throwIfAborted()
      return { ...result, origin, destination, mode }
    })
  }

  override async planMultiStop(query: PlanMultiStopRouteQuery, execution: QueryExecution): Promise<PlanMultiStopRouteResult> {
    const parsed = planMultiStopRouteQuerySchema.safeParse(query)
    if (!parsed.success) throw new HarnessError('请提供 3—' + maxMultiStopPlaces + ' 个已选地点并指定交通方式。自动顺路时还需标明是否固定首尾地点。', 'TRIP_INVALID_ROUTE_QUERY')
    return this.run(execution, active => this.planLegs(parsed.data, active))
  }

  private async run<T>(execution: QueryExecution, execute: (active: QueryExecution) => Promise<T>): Promise<T> {
    // 总时限覆盖地点解析和路线查询；单次地图调用仍受 queryTimeoutMs 限制。
    const signal = AbortSignal.any([execution.signal, this.lifetime.signal, AbortSignal.timeout(this.settings.routeTimeoutMs)])
    signal.throwIfAborted()
    const request = execute({ ...execution, signal,
      deferContext: context => execution.deferContext?.(context), concludeTurn: () => execution.concludeTurn?.(),
    })
    this.pending.add(request)
    try { return await request } finally { this.pending.delete(request) }
  }

  private async select(reference: EndpointReference): Promise<SelectedEndpoint> {
    if (reference.kind === 'poi') return { placeId: reference.placeId, alias: null }
    const saved = await this.ctx.savedPlaces.get(reference.alias)
    if (reference.expectedId !== undefined && saved?.id !== reference.expectedId) {
      throw new HarnessError('路线端点的收藏已变更，请重新选择。', 'TRIP_SAVED_PLACE_CHANGED')
    }
    if (!saved) throw new HarnessError('找不到收藏“' + reference.alias + '”，请先查看收藏或搜索选定地点。', 'TRIP_SAVED_PLACE_NOT_FOUND')
    return { placeId: saved.placeId, alias: saved.alias, saved }
  }

  private async resolveStops(references: EndpointReference[], mode: RouteMode, execution: QueryExecution,
    pins?: PinnedStops): Promise<RouteEndpoint[]> {
    // 在详情补查前校验本地引用及重复地点。
    const { signal } = execution
    const selected: SelectedEndpoint[] = []
    const saved = new Map<string, SavedPlace>()
    for (const reference of references) {
      signal.throwIfAborted()
      const point = await this.select(reference)
      signal.throwIfAborted()
      if (pins) {
        const first = selected.findIndex(stop => stop.placeId === point.placeId)
        const returnsToStart = pins.pinStart && pins.pinEnd && first === 0 && selected.length === references.length - 1
        if (first !== -1 && !returnsToStart) {
          throw new HarnessError('自动顺路时请只选一次同一地点。如需重复经过，请指定访问顺序。', 'TRIP_SAME_ENDPOINT')
        }
      } else if (selected.at(-1)?.placeId === point.placeId) this.sameEndpoint(references.length, selected.length)
      selected.push(point)
      if (point.saved?.coordinates && (mode !== 'transit' || point.saved.city?.trim())) saved.set(point.placeId, point.saved)
    }
    const details = new Map<string, PlaceDetailsResult>()
    const stops: RouteEndpoint[] = []
    for (const point of selected) {
      signal.throwIfAborted()
      const cached = saved.get(point.placeId)
      let place: RouteEndpoint
      if (cached?.coordinates) {
        place = { placeId: point.placeId, alias: point.alias, name: cached.name, address: cached.address,
          city: cached.city, coordinates: { ...cached.coordinates }, detailsFetchedAt: cached.fetchedAt }
      } else {
        let result = details.get(point.placeId)
        if (!result) {
          try { result = await this.ctx.travelData.getPlaceDetails(point.placeId, execution) }
          catch (error) {
            if (references.length > 2 && error instanceof HarnessError && error.code === 'TRIP_AGENT_QUERY_BUDGET') {
              throw new HarnessError('已确认 ' + stops.length + ' 个地点，尚未开始查路线。' + error.message, error.code)
            }
            throw error
          }
          signal.throwIfAborted()
          details.set(point.placeId, result)
        }
        if (result.place.id !== point.placeId || !result.place.coordinates) {
          throw new HarnessError('地点详情没有有效坐标，无法规划路线，请重新搜索并选定地点。', 'TRIP_ROUTE_ENDPOINT_INCOMPLETE')
        }
        if (mode === 'transit' && !result.place.city?.trim()) {
          throw new HarnessError('公共交通规划缺少地点所属城市，无法使用默认城市代替，请重新选择信息完整的地点。', 'TRIP_ROUTE_CITY_MISSING')
        }
        place = { placeId: point.placeId, alias: point.alias, name: result.place.name, address: result.place.address,
          city: result.place.city, coordinates: { ...result.place.coordinates }, detailsFetchedAt: result.fetchedAt }
      }
      const previous = stops.at(-1)?.coordinates
      if (!pins && previous?.longitude === place.coordinates.longitude && previous.latitude === place.coordinates.latitude) {
        this.sameEndpoint(references.length, stops.length)
      }
      stops.push(point.saved ? { ...place, savedPlaceId: point.saved.id } : place)
    }
    return stops
  }

  private async planLegs(query: PlanMultiStopRouteQuery, execution: QueryExecution): Promise<PlanMultiStopRouteResult> {
    const { signal } = execution
    const { mode } = query
    const order = query.order ?? 'given'
    const pins = order === 'optimized' ? { pinStart: query.pinStart === true, pinEnd: query.pinEnd === true } : undefined
    const resolved = await this.resolveStops(query.stops, mode, execution, pins)
    signal.throwIfAborted()
    const stops = pins ? optimizeRouteOrder(resolved, pins) : resolved
    if (!stops) throw new HarnessError('有地点坐标重合，无法排出相邻地点坐标不同的顺路路线，请调整地点。', 'TRIP_SAME_ENDPOINT')
    const legs: MultiStopLeg[] = stops.slice(1).map((_, from) => ({
      from, to: from + 1, status: 'not-queried', route: null, fetchedAt: null, warnings: [], message: null,
    }))
    for (const leg of legs) {
      signal.throwIfAborted()
      try {
        const result = await this.ctx.travelData.planRoute({ origin: stops[leg.from], destination: stops[leg.to], mode }, execution)
        signal.throwIfAborted()
        leg.route = result.routes[0] ?? null
        leg.status = leg.route ? 'found' : 'no-route'
        leg.fetchedAt = result.fetchedAt
        leg.warnings = result.warnings
      } catch (error) {
        signal.throwIfAborted()
        if (error instanceof HarnessError && error.code === 'TRIP_AGENT_QUERY_BUDGET') leg.message = error.message
        else if (error instanceof HarnessError && error.code === 'TRIP_MCP_NOT_READY') leg.message = '高德地图连接尚未就绪。'
        else if (error instanceof HarnessError && ['TRIP_UPSTREAM_ERROR', 'TRIP_UPSTREAM_FORMAT'].includes(error.code)) {
          leg.message = '高德地图查询失败，请稍后重试。'
        } else if (error instanceof Error && error.name === 'TimeoutError') leg.message = '这一段查询超时。'
        else throw error
        leg.status = 'query-failed'
      }
      if (leg.status !== 'found') break
    }
    return { source: 'AMAP', stops, mode, order, legs,
      status: legs.every(leg => leg.status === 'found') ? 'complete' : 'incomplete',
      totalDurationSeconds: total(legs, 'durationSeconds'), totalDistanceMeters: total(legs, 'distanceMeters'),
    }
  }

  private sameEndpoint(count: number, index: number): never {
    const message = count === 2 ? '起点和终点相同，无需规划两点之间的路线。'
      : '第 ' + index + ' 和第 ' + (index + 1) + ' 个地点相同，请调整相邻地点。'
    throw new HarnessError(message, 'TRIP_SAME_ENDPOINT')
  }
}
