/** 角色二：组织地点解析与路线查询，复用收藏服务和出行数据服务，不直接读文件或请求 HTTP。 */
import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { Config } from '../config.ts'
import { planRouteQuerySchema, type EndpointReference, type PlanRouteQuery, type PlanRouteResult, type RouteEndpoint } from '../contracts/routes.ts'
import type { PlaceDetailsResult } from '../contracts/travel.ts'
import RoutePlannerService from '../services/route-planner.ts'
import type { SavedPlace } from '../services/saved-places.ts'
import type { QueryExecution } from '../services/travel-data.ts'

interface SelectedEndpoint { placeId: string; alias: string | null; saved?: SavedPlace }

export default class RoutePlanner extends RoutePlannerService {
  static inject = ['savedPlaces', 'travelData']
  private readonly settings: Config
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<PlanRouteResult>>()

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
    // 总时限覆盖地点解析和路线查询；单次地图调用仍受 queryTimeoutMs 限制。
    const signal = AbortSignal.any([execution.signal, this.lifetime.signal, AbortSignal.timeout(this.settings.routeTimeoutMs)])
    signal.throwIfAborted()
    const request = this.resolveAndPlan(parsed.data, execution, signal)
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

  private async resolveAndPlan(query: PlanRouteQuery, execution: QueryExecution, signal: AbortSignal): Promise<PlanRouteResult> {
    // 先检查两个本地引用，避免终点别名无效时还去补查起点。
    const selectedOrigin = await this.select(query.origin)
    const selectedDestination = await this.select(query.destination)
    signal.throwIfAborted()
    if (selectedOrigin.placeId === selectedDestination.placeId) this.sameEndpoint()
    const childExecution: QueryExecution = { ...execution, signal,
      deferContext: context => execution.deferContext?.(context), concludeTurn: () => execution.concludeTurn?.(),
    }
    const details = new Map<string, Promise<PlaceDetailsResult>>()
    const resolve = async (selected: SelectedEndpoint): Promise<RouteEndpoint> => {
      signal.throwIfAborted()
      const cached = selected.saved
      if (cached?.coordinates && (query.mode !== 'transit' || cached.city?.trim())) {
        return { placeId: cached.placeId, alias: cached.alias, name: cached.name, address: cached.address,
          city: cached.city, coordinates: { ...cached.coordinates }, detailsFetchedAt: cached.fetchedAt }
      }
      // 缓存仅在本次调用中存在，不自动更新收藏，也不跨请求复用路线。
      let pending = details.get(selected.placeId)
      if (!pending) { pending = this.ctx.travelData.getPlaceDetails(selected.placeId, childExecution); details.set(selected.placeId, pending) }
      const result = await pending
      signal.throwIfAborted()
      if (result.place.id !== selected.placeId || !result.place.coordinates) {
        throw new HarnessError('地点详情没有有效坐标，无法规划路线，请重新搜索并选定地点。', 'TRIP_ROUTE_ENDPOINT_INCOMPLETE')
      }
      if (query.mode === 'transit' && !result.place.city?.trim()) {
        throw new HarnessError('公共交通规划缺少地点所属城市，无法使用默认城市代替，请重新选择信息完整的地点。', 'TRIP_ROUTE_CITY_MISSING')
      }
      return { placeId: selected.placeId, alias: selected.alias, name: result.place.name, address: result.place.address,
        city: result.place.city, coordinates: { ...result.place.coordinates }, detailsFetchedAt: result.fetchedAt }
    }
    const origin = await resolve(selectedOrigin)
    const destination = await resolve(selectedDestination)
    if (origin.coordinates.longitude === destination.coordinates.longitude && origin.coordinates.latitude === destination.coordinates.latitude) this.sameEndpoint()
    signal.throwIfAborted()
    const result = await this.ctx.travelData.planRoute({ origin, destination, mode: query.mode }, childExecution)
    signal.throwIfAborted()
    return { ...result, origin, destination, mode: query.mode }
  }

  private sameEndpoint(): never {
    throw new HarnessError('起点和终点相同，无需规划两点之间的路线。', 'TRIP_SAME_ENDPOINT')
  }
}
