/** 配置模块：Schema 在插件加载时校验、填默认值，interface 用于 TypeScript 检查。 */
import Schema from '@deepseek-ai/schemastery'

export interface Config {
  /** 工具省略城市时使用；不会把它当作每个地点的来源城市。 */
  defaultCity: string
  /** 默认返回数量，同时也是用户能申请的数量上限。 */
  maxResults: number
  /** 本插件一次查询的超时，单位毫秒。 */
  queryTimeoutMs: number
  /** 整次路线规划的总时限，包含最多两次详情补查和一次路线调用。 */
  routeTimeoutMs: number
  /** 是否打印服务加载、卸载日志。 */
  showLifecycleLogs: boolean
  /** 搜索和详情缓存可关闭；过期不会触发后台刷新。 */
  cacheEnabled: boolean
  searchCacheTtlSeconds: number
  detailsCacheTtlSeconds: number
  cacheMaxEntries: number
  /** Agent 必须经本插件入口使用固定高德能力；不影响界面的正常内部查询。 */
  requireTripToolsForAgent: boolean
  /** 每个 Agent 轮次的实际高德请求预算，缓存命中不扣次数。 */
  agentQueryBudgetEnabled: boolean
  agentMaxSearchCallsPerTurn: number
  agentMaxDetailCallsPerTurn: number
  agentMaxRouteCallsPerTurn: number
}

export const Config = Schema.object({
  defaultCity: Schema.string().pattern(/\S/).default('广州'),
  maxResults: Schema.number().step(1).min(1).max(10).default(5),
  queryTimeoutMs: Schema.number().step(1).min(1000).max(30000).default(20000),
  routeTimeoutMs: Schema.number().step(1).min(1000).max(120000).default(60000),
  showLifecycleLogs: Schema.boolean().default(true),
  cacheEnabled: Schema.boolean().default(true),
  searchCacheTtlSeconds: Schema.number().step(1).min(1).max(86400).default(1800),
  detailsCacheTtlSeconds: Schema.number().step(1).min(1).max(2592000).default(604800),
  cacheMaxEntries: Schema.number().step(1).min(1).max(1000).default(200),
  requireTripToolsForAgent: Schema.boolean().default(true),
  agentQueryBudgetEnabled: Schema.boolean().default(true),
  agentMaxSearchCallsPerTurn: Schema.number().step(1).min(1).max(20).default(3),
  agentMaxDetailCallsPerTurn: Schema.number().step(1).min(1).max(20).default(6),
  agentMaxRouteCallsPerTurn: Schema.number().step(1).min(1).max(20).default(6),
})
