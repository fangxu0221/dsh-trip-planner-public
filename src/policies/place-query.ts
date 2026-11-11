/** 执行层约束：仅放行适配器登记的 Agent 内部调用，按真实轮次限制实际请求。 */
import { Service, type Context } from '@deepseek-ai/cordis'
import { HarnessError, type ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { Config } from '../config.ts'
import { AMAP_DETAILS_TOOL, AMAP_ROUTE_TOOLS, AMAP_SEARCH_TOOL } from '../adapters/amap-mcp.ts'

type Agent = NonNullable<ToolExecution['agent']>
type QueryKind = 'search' | 'details' | 'route'
interface TurnBudget { turn: number; calls: Record<QueryKind, number> }
declare module '@deepseek-ai/cordis' { interface Context { placeQueryPolicy: PlaceQueryPolicy } }

export default class PlaceQueryPolicy extends Service {
  static inject = ['tools']
  private readonly config: Config
  private readonly internal = new Map<ToolCallId, Agent | undefined>()
  private readonly turns = new Map<Agent['session'], TurnBudget>()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'placeQueryPolicy')
    this.config = config
    const routeNames = new Set(Object.values(AMAP_ROUTE_TOOLS))
    ctx.tools.guard(execution => {
      if (!config.requireTripToolsForAgent || !execution.agent || this.internal.get(execution.callId) === execution.agent) return
      const tool = execution.name === AMAP_SEARCH_TOOL ? 'trip_search_places'
        : execution.name === AMAP_DETAILS_TOOL ? 'trip_get_place_details'
          : routeNames.has(execution.name) ? 'trip_plan_route（两点）或 trip_plan_multi_stop_route（多地点）' : undefined
      if (tool) return '请使用 ' + tool + '，由插件复用缓存并控制调用预算；不要直接调用底层高德能力。'
    })
    ctx.on('agent/pre-step', ({ agent, turn }, next) => {
      if (this.turns.get(agent.session)?.turn !== turn) this.turns.set(agent.session, { turn, calls: { search: 0, details: 0, route: 0 } })
      return next()
    }, { global: true })
    ctx.on('agent/status', ({ agent, status }) => { if (status === 'idle') this.turns.delete(agent.session) }, { global: true })
    ctx.on('session/disposed', session => { this.turns.delete(session) }, { global: true })
    ctx.effect(() => () => { this.internal.clear(); this.turns.clear() })
  }

  /** 仅由本地适配器为私有随机 callId 登记授权，不依赖模型可伪造的参数或名称前缀。 */
  async authorize<T>(callId: ToolCallId, agent: Agent | undefined, run: () => Promise<T>): Promise<T> {
    this.internal.set(callId, agent)
    try { return await run() } finally { this.internal.delete(callId) }
  }

  /** 只在真正执行高德工具体前扣次数；失败的外部尝试也占预算。 */
  consume(agent: Agent | undefined, kind: QueryKind): void {
    if (!this.config.agentQueryBudgetEnabled || !agent) return
    const budget = this.turns.get(agent.session)
    // 没有 Agent 轮次的界面/程序调用沿用原有服务的校验和超时。
    if (!budget) return
    const limit = kind === 'search' ? this.config.agentMaxSearchCallsPerTurn
      : kind === 'details' ? this.config.agentMaxDetailCallsPerTurn : this.config.agentMaxRouteCallsPerTurn
    if (budget.calls[kind] >= limit) throw new HarnessError('本轮' + ({ search: '地点搜索', details: '地点详情', route: '路线查询' }[kind])
      + '的实际高德调用已达到 ' + limit + ' 次上限。请使用已有结果回复，不要换关键词、工具或子任务继续重试。', 'TRIP_AGENT_QUERY_BUDGET')
    budget.calls[kind]++
  }
}
