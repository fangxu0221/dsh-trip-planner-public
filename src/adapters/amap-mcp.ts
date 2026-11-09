/** 高德适配器：调用已注册的 MCP 能力并解析结果，不建立第二套 MCP 连接。 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { HarnessError, ToolCallId } from '@deepseek-ai/dsh-llm'
import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'
import type { Coordinates, Place, PlaceDetailsResult, PlacesSearchResult, ResolvedSearchPlacesQuery } from '../contracts/travel.ts'
import type { QueryExecution } from '../services/travel-data.ts'
import type { ResolvedRouteQuery, RouteDataResult, RouteMode } from '../contracts/routes.ts'
import { normalizeRoutePayload } from './amap-routes.ts'
import type { CacheRequest } from '../contracts/query-cache.ts'
import type { CachedQuery } from '../services/query-cache.ts'
import type {} from '../services/query-cache.ts'

interface CachePlan { request: CacheRequest; refresh: boolean; validate: (value: unknown, at: string) => Place[] }

/** 固定为已验证的只读搜索工具，不允许模型指定任意内部工具名。 */
export const AMAP_SEARCH_TOOL = 'mcp__amap__maps_text_search'
export const AMAP_DETAILS_TOOL = 'mcp__amap__maps_search_detail'
/** 只允许固定四种只读路线能力，不接受模型提供内部工具名。 */
export const AMAP_ROUTE_TOOLS: Record<RouteMode, string> = {
  walking: 'mcp__amap__maps_direction_walking', bicycling: 'mcp__amap__maps_direction_bicycling',
  driving: 'mcp__amap__maps_direction_driving', transit: 'mcp__amap__maps_direction_transit_integrated',
}

function formatError(): never {
  throw new HarnessError('高德响应格式异常，无法作为地点结果使用。', 'TRIP_UPSTREAM_FORMAT')
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return formatError()
  return value as Record<string, unknown>
}

function optionalText(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') return formatError()
  return value.trim() || null
}

function coordinates(value: unknown): Coordinates | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') return formatError()
  const parts = value.split(',')
  const [longitude, latitude] = parts.map(Number)
  if (parts.length !== 2 || parts.some(part => !part.trim()) || !Number.isFinite(longitude)
    || !Number.isFinite(latitude) || Math.abs(longitude) > 180 || Math.abs(latitude) > 90) return formatError()
  return { longitude, latitude }
}

/** 业务失败不能变成空列表；错误内容不直接拼接远端原文，避免泄露凭据。 */
function payload(value: unknown): Record<string, unknown> {
  const canonical = record(value)
  let data = canonical.structuredContent
  if (data === undefined && Array.isArray(canonical.content)) {
    for (const block of canonical.content) {
      const item = record(block)
      if (item.type !== 'text' || typeof item.text !== 'string') continue
      try { data = JSON.parse(item.text); break } catch { /* 继续寻找 JSON 文本块。 */ }
    }
  }
  const result = record(data)
  if (canonical.isError === true || result.status === '0' || result.status === 0 || result.success === false || result.error) {
    throw new HarnessError('高德返回业务错误，请检查 Key、服务权限和配额。', 'TRIP_UPSTREAM_ERROR')
  }
  return result
}

/**
 * 把规范 MCP 返回值转换为本项目数据；搜索缺坐标时使用 null，并保留数量限制说明。
 * @param value Harness 工具执行成功后的规范值。
 * @param query 本次已校验的条件。
 * @param fetchedAt 查询完成时间，不冒充来源数据发布时间。
 * @returns 可供工具、后续收藏功能和界面共用的地点结果。
 */
export function normalizeSearchResult(value: unknown, query: ResolvedSearchPlacesQuery, fetchedAt: string): PlacesSearchResult {
  const result = payload(value)
  if (!Array.isArray(result.pois)) return formatError()
  const places = new Map<string, Place>()
  for (const value of result.pois) {
    const item = record(value)
    if (typeof item.id !== 'string' || !item.id.trim() || typeof item.name !== 'string' || !item.name.trim()) return formatError()
    const place: Place = { id: item.id.trim(), name: item.name.trim(), address: optionalText(item.address),
      city: optionalText(item.cityname ?? item.city), coordinates: coordinates(item.location) }
    if (!places.has(place.id)) places.set(place.id, place)
  }
  const selected = [...places.values()].slice(0, query.limit)
  const truncated = places.size > query.limit
  const warnings = ['结果仅覆盖高德本次搜索返回的候选地点，不代表该城市全部相关地点。']
  if (selected.some(place => place.coordinates === null)) warnings.push('部分地点未返回坐标，需要查询地点详情后再用于路线规划。')
  if (truncated) warnings.push('受本次数量限制，仅展示前 ' + query.limit + ' 个不同地点。')
  if (places.size < result.pois.length) warnings.push('已按高德地点 ID 合并重复结果。')
  return { source: 'AMAP', fetchedAt, query: { ...query }, sourceCount: result.pois.length,
    returned: selected.length, truncated, places: selected, warnings }
}

/** 详情必须与请求 ID 一致；未知的响应形状直接失败，不能拿错地点来收藏。 */
export function normalizePlaceDetails(value: unknown, placeId: string, fetchedAt: string): PlaceDetailsResult {
  const result = payload(value)
  const candidates = Array.isArray(result.pois) ? result.pois : typeof result.id === 'string' ? [result] : []
  if (candidates.length !== 1) return formatError()
  const item = record(candidates[0])
  if (item.id !== placeId || typeof item.name !== 'string' || !item.name.trim()) return formatError()
  return { source: 'AMAP', fetchedAt, place: {
    id: placeId, name: item.name.trim(), address: optionalText(item.address),
    city: optionalText(item.cityname ?? item.city), coordinates: coordinates(item.location),
  } }
}

/** 内部能力仍经过共享的校验、权限守卫、取消和后置处理流水线。 */
export class AmapMcpAdapter {
  private readonly tools: Context['tools']
  private readonly ctx: Context
  private readonly identities = new WeakMap<object, number>()
  private identity = 0

  constructor(ctx: Context) {
    this.ctx = ctx
    this.tools = ctx.tools
  }

  /**
   * 派生一次只读查询，保留外层工具的作用域、已准入工具集和关联关系。
   * @param query 已填好默认值的搜索条件。
   * @param execution 原始调用上下文，保留回调所属对象。
   * @param signal 提供方融合取消、卸载和超时后的信号。
   * @returns 高德搜索的业务结果。
   */
  async searchPlaces(query: ResolvedSearchPlacesQuery, execution: QueryExecution, signal: AbortSignal, refresh = false): Promise<PlacesSearchResult> {
    const { value, fetchedAt } = await this.invoke(AMAP_SEARCH_TOOL, { keywords: query.keywords, city: query.city, citylimit: true }, execution, signal,
      { request: { kind: 'search', ...query }, refresh, validate: (value, at) => normalizeSearchResult(value, query, at).places })
    return normalizeSearchResult(value, query, fetchedAt)
  }

  /** 固定调用官方只读详情工具，保留与搜索相同的权限和嵌套上下文。 */
  async getPlaceDetails(placeId: string, execution: QueryExecution, signal: AbortSignal, refresh = false): Promise<PlaceDetailsResult> {
    const { value, fetchedAt } = await this.invoke(AMAP_DETAILS_TOOL, { id: placeId }, execution, signal,
      { request: { kind: 'details', placeId }, refresh, validate: (value, at) => [normalizePlaceDetails(value, placeId, at).place] })
    return normalizePlaceDetails(value, placeId, fetchedAt)
  }

  /** 同一调用只选择一种路线方式，公交城市取端点真实字段。 */
  async planRoute(query: ResolvedRouteQuery, execution: QueryExecution, signal: AbortSignal): Promise<RouteDataResult> {
    const location = (point: ResolvedRouteQuery['origin']) => point.coordinates.longitude + ',' + point.coordinates.latitude
    const args: Record<string, unknown> = { origin: location(query.origin), destination: location(query.destination) }
    if (query.mode === 'transit') { args.city = query.origin.city; args.cityd = query.destination.city }
    const { value, fetchedAt } = await this.invoke(AMAP_ROUTE_TOOLS[query.mode], args, execution, signal)
    return normalizeRoutePayload(payload(value), query.mode, fetchedAt)
  }

  private objectId(value: object | undefined): number {
    if (!value) return 0
    let id = this.identities.get(value)
    if (id === undefined) { id = ++this.identity; this.identities.set(value, id) }
    return id
  }

  private async invoke(name: string, args: Record<string, unknown>, execution: QueryExecution, signal: AbortSignal,
    plan?: CachePlan): Promise<{ value: unknown; fetchedAt: string }> {
    signal.throwIfAborted()
    // 宿主允许可选 MCP 插件加载失败后继续启动，所以业务工具必须明确识别未就绪状态。
    // 使用当前调用方的视图检查，不切换到全局作用域或忽略权限限制。
    if (!this.tools.get(name, execution.agent)) {
      throw new HarnessError('高德地图连接尚未就绪，当前会话无法使用地点查询。请检查 cordis.yml 中的高德 URL、Key 和启动日志。', 'TRIP_MCP_NOT_READY')
    }
    const cache = this.ctx.queryCache
    let loaded: CachedQuery | undefined
    let fetchedAt = new Date().toISOString()
    // 每个请求仍独立执行原能力的准入、参数校验、前后策略和结果通知。
    // 只替换实际只读工具体；作用域自定义的同名工具不进入全局缓存。
    const pipeline = new ToolExecutionPipeline(this.ctx, { get: (toolName, scope, toolSet) => {
      const original = this.tools.executable(toolName, scope, toolSet)
      if (!original || toolName !== name) return original
      return { ...original, execute: async (parameters, inner) => {
        const call = async (active: AbortSignal) => {
          active.throwIfAborted()
          const contexts: CachedQuery['contexts'] = []
          let concludesTurn = false
          cache?.recordCall(plan?.request.kind ?? 'route')
          const response = await original.execute(parameters, { ...inner, signal: active,
            deferContext: context => { contexts.push(context) }, concludeTurn() { concludesTurn = true } })
          const at = new Date().toISOString()
          plan?.validate(response, at)
          return { response, fetchedAt: at, contexts, concludesTurn }
        }
        if (plan && cache && original === this.tools.get(name)) {
          const partition = [this.objectId(inner.agent), this.objectId(inner.toolSet), this.objectId(original)].join(':')
          loaded = await cache.obtain(plan.request, partition, inner.signal, plan.refresh, call)
          fetchedAt = loaded.fetchedAt
          for (const context of loaded.contexts) inner.deferContext(context)
          if (loaded.concludesTurn) inner.concludeTurn()
          return loaded.response
        }
        const direct = await call(inner.signal)
        fetchedAt = direct.fetchedAt
        for (const context of direct.contexts) inner.deferContext(context)
        if (direct.concludesTurn) inner.concludeTurn()
        return direct.response
      } }
    } })
    const callId = ToolCallId('trip-amap-' + randomUUID())
    // 这里是组合工具的内部调用，不重新当作一个模型根调用去选择 Native/PTC 呈现方式。
    const prepared = await pipeline.prepare({ callId, name, arguments: args, signal,
      ...execution.agent === undefined ? {} : { agent: execution.agent },
      ...execution.toolSet === undefined ? {} : { toolSet: execution.toolSet },
      ...execution.token === undefined ? {} : { parent: execution.token },
      ...execution.rootCallId === undefined ? {} : { rootCallId: execution.rootCallId },
    })
    const outcome = prepared.kind === 'dispatch' ? await pipeline.dispatch(prepared.exec) : prepared
    const result = await pipeline.complete(prepared.exec, outcome)
    for (const context of result.additionalContexts ?? []) execution.deferContext?.(context)
    signal.throwIfAborted()
    if (result.isError) {
      const message = result.error.message.replace(/[a-f0-9]{32}/gi, '[REDACTED]')
        .replace(/([?&](?:key|token|secret)=)[^&\s"'<>]+/gi, '$1[REDACTED]')
      throw new HarnessError('高德查询调用失败：' + message, 'TRIP_UPSTREAM_ERROR')
    }
    if (result.concludesTurn) execution.concludeTurn?.()
    if (plan && loaded && !result.additionalContexts?.length && !result.concludesTurn) {
      const places = plan.validate(result.value, fetchedAt)
      await cache.store(plan.request, loaded, result.value, places, signal)
    }
    signal.throwIfAborted()
    return { value: result.value, fetchedAt }
  }
}
