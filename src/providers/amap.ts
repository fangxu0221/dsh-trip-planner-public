/** 角色二：高德提供方。实现输入规则、默认配置、超时和服务资源释放。 */
import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { AmapMcpAdapter } from '../adapters/amap-mcp.ts'
import type { Config } from '../config.ts'
import type { PlaceDetailsResult, PlacesSearchResult, ResolvedSearchPlacesQuery, SearchPlacesQuery } from '../contracts/travel.ts'
import { routeModes, type ResolvedRouteQuery, type RouteDataResult } from '../contracts/routes.ts'
import TravelDataService, { type QueryExecution } from '../services/travel-data.ts'

/** 挂载后提供 ctx.travelData；适配器只负责外部调用，业务输入规则集中在本类。 */
export default class AmapTravelData extends TravelDataService {
  static inject = ['tools', 'queryCache', 'placeQueryPolicy']
  private readonly settings: Config
  private readonly adapter: AmapMcpAdapter
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.settings = config
    this.adapter = new AmapMcpAdapter(ctx)
    ctx.effect(() => {
      if (config.showLifecycleLogs) console.log('[出行数据] 服务已加载')
      return async () => {
        this.lifetime.abort(new Error('出行数据服务已卸载'))
        await Promise.allSettled([...this.pending])
        if (config.showLifecycleLogs) console.log('[出行数据] 服务已卸载，进行中的查询已结束')
      }
    })
  }

  private resolveQuery(query: SearchPlacesQuery): ResolvedSearchPlacesQuery {
    const keywords = typeof query.keywords === 'string' ? query.keywords.trim() : ''
    const city = typeof query.city === 'string' ? query.city.trim() : query.city === undefined ? this.settings.defaultCity.trim() : ''
    const limit = query.limit ?? this.settings.maxResults
    if (!keywords || keywords.length > 100) throw new HarnessError('关键词不能为空，且最多 100 个字符。', 'TRIP_INVALID_QUERY')
    if (!city || city.length > 50) throw new HarnessError('城市不能为空，且最多 50 个字符。', 'TRIP_INVALID_QUERY')
    if (!Number.isInteger(limit) || limit < 1 || limit > this.settings.maxResults) {
      throw new HarnessError('返回数量必须是 1—' + this.settings.maxResults + ' 之间的整数。', 'TRIP_INVALID_QUERY')
    }
    return { keywords, city, limit }
  }

  override async searchPlaces(query: SearchPlacesQuery, execution: QueryExecution): Promise<PlacesSearchResult> {
    if (query.refresh !== undefined && typeof query.refresh !== 'boolean') throw new HarnessError('刷新选项不合法。', 'TRIP_INVALID_QUERY')
    const resolved = this.resolveQuery(query)
    return this.query(execution, signal => this.adapter.searchPlaces(resolved, execution, signal, query.refresh))
  }

  /** 详情与搜索共用超时、取消和卸载机制，不另建 MCP 连接。 */
  override async getPlaceDetails(placeId: string, execution: QueryExecution, options?: { refresh?: boolean }): Promise<PlaceDetailsResult> {
    if (options?.refresh !== undefined && typeof options.refresh !== 'boolean') throw new HarnessError('刷新选项不合法。', 'TRIP_INVALID_QUERY')
    const id = typeof placeId === 'string' ? placeId.trim() : ''
    if (!id || id.length > 100) throw new HarnessError('地点 ID 不能为空，且最多 100 个字符。', 'TRIP_INVALID_QUERY')
    return this.query(execution, signal => this.adapter.getPlaceDetails(id, execution, signal, options?.refresh))
  }

  /** 数据服务也校验直接调用，避免其他消费方绕过路线服务后传入非法坐标。 */
  override async planRoute(query: ResolvedRouteQuery, execution: QueryExecution): Promise<RouteDataResult> {
    if (!routeModes.includes(query.mode)) throw new HarnessError('不支持该交通方式。', 'TRIP_INVALID_ROUTE_QUERY')
    for (const endpoint of [query.origin, query.destination]) {
      const coordinate = endpoint?.coordinates
      if (!coordinate || !Number.isFinite(coordinate.longitude) || !Number.isFinite(coordinate.latitude)
        || Math.abs(coordinate.longitude) > 180 || Math.abs(coordinate.latitude) > 90) {
        throw new HarnessError('路线端点坐标不合法。', 'TRIP_INVALID_ROUTE_QUERY')
      }
      if (query.mode === 'transit' && !endpoint.city?.trim()) throw new HarnessError('公交规划需要起终点城市。', 'TRIP_ROUTE_CITY_MISSING')
    }
    return this.query(execution, signal => this.adapter.planRoute(query, execution, signal))
  }

  private async query<T>(execution: QueryExecution, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const signal = AbortSignal.any([execution.signal, this.lifetime.signal, AbortSignal.timeout(this.settings.queryTimeoutMs)])
    signal.throwIfAborted()
    const request = run(signal)
    this.pending.add(request)
    try { return await request } finally { this.pending.delete(request) }
  }
}
