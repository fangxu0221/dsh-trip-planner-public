/** 按会话、轮次及地点顺序转交路线，保留同一组中的不同交通方式。 */
import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import type { ToolExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import type { ChatRouteItem, ChatRouteView, RouteResult } from './types.ts'

type LiveSession = NonNullable<ToolExecution['agent']>['session']
interface RequestOrder { order: number; turn: symbol }
interface Candidate extends RequestOrder { result: RouteResult; signal: AbortSignal }
interface RouteGroup { turn: symbol; order: number; stops: string[]; view: ChatRouteView }
const empty: ChatRouteView = { revision: 0, groupId: '', results: [] }

export class SessionRoutes {
  private readonly latest = new Map<LiveSession, RouteGroup>()
  private readonly turns = new Map<LiveSession, { number: number; key: symbol }>()
  private readonly listeners = new Map<string, Set<() => void>>()
  private readonly pending = new Map<ToolExecutionToken, RequestOrder>()
  private readonly staged = new Map<ToolExecutionToken, { session: LiveSession; candidates: Candidate[] }>()
  private readonly lifetime = new AbortController()
  private readonly epoch = randomUUID()
  private order = 0
  private revision = 0

  constructor(private readonly ctx: Context) {
    // 模型步骤开始前捕获真正的 turn；同轮后续步骤仍然归入同组。
    ctx.on('agent/pre-step', ({ agent, turn }, next) => {
      const session = agent.session
      if (this.turns.get(session)?.number !== turn) this.turns.set(session, { number: turn, key: Symbol() })
      return next()
    }, { global: true })
    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') this.turns.delete(agent.session)
    }, { global: true })
    ctx.on('tools/pre-execute', (execution, next) => {
      if ((execution.name === 'trip_plan_route' || execution.name === 'trip_plan_multi_stop_route') && execution.agent) {
        this.pending.set(execution.token, { order: ++this.order,
          // 步骤外的程序调用独立成组，避免把没有轮次依据的查询合并。
          turn: this.turns.get(execution.agent.session)?.key ?? Symbol() })
      }
      return next()
    }, { global: true })
    ctx.on('tools/result', (execution, outcome) => {
      const request = this.pending.get(execution.token)
      this.pending.delete(execution.token)
      const staged = this.staged.get(execution.token)
      this.staged.delete(execution.token)
      const session = execution.agent?.session
      if ((!request && !staged) || outcome.isError || execution.signal.aborted
        || !session || ctx.sessions.get(session.id) !== session) return
      const candidates = staged?.session === session ? [...staged.candidates] : []
      const value = outcome.value
      if (request && value && typeof value === 'object' && !Array.isArray(value) && value.source === 'AMAP'
        && ['walking', 'bicycling', 'driving', 'transit'].includes(String(value.mode))
        && (execution.name === 'trip_plan_route'
          ? (value.status === 'found' || value.status === 'no-route') && Array.isArray(value.routes) && value.origin && value.destination
          : (value.status === 'complete' || value.status === 'incomplete') && Array.isArray(value.stops)
            && value.stops.length >= 3 && Array.isArray(value.legs))) {
        candidates.push({ ...request, result: value as unknown as RouteResult, signal: execution.signal })
      }
      if (!candidates.length) return
      if (execution.parent !== undefined) {
        // 嵌套工具的所有方式都等外层成功后发布，外层失败时整批丢弃。
        const parent = this.staged.get(execution.parent)
        this.staged.set(execution.parent, { session,
          candidates: [...(parent?.session === session ? parent.candidates : []), ...candidates] })
        return
      }
      let changed = false
      for (const candidate of candidates.sort((a, b) => a.order - b.order)) {
        if (!candidate.signal.aborted) changed = this.commit(session, candidate) || changed
      }
      if (changed) this.notify(session.id)
    }, { global: true })
    ctx.on('session/disposed', session => {
      this.turns.delete(session)
      if (this.latest.delete(session)) this.notify(session.id)
    }, { global: true })
    ctx.effect(() => () => {
      this.lifetime.abort()
      this.pending.clear()
      this.staged.clear()
      this.turns.clear()
      this.latest.clear()
      this.listeners.clear()
    })
  }

  /** 异方式允许晚到补齐，同方式只接受较新请求；旧组不能覆盖新组。 */
  private commit(session: LiveSession, candidate: Candidate): boolean {
    const current = this.latest.get(session)
    const { result, order, turn } = candidate
    const stops = ('stops' in result ? result.stops : [result.origin, result.destination]).map(stop => stop.placeId)
    const sameGroup = current?.turn === turn && current.stops.length === stops.length
      && current.stops.every((stop, index) => stop === stops[index])
    let results: ChatRouteItem[]
    if (sameGroup) {
      const previous = current!.view.results.find(item => item.result.mode === result.mode)
      if (previous && previous.revision >= order) return false
      results = current!.view.results.filter(item => item.result.mode !== result.mode)
    } else {
      if (current && current.order >= order) return false
      results = []
    }
    results.push({ revision: order, result })
    results.sort((a, b) => a.revision - b.revision)
    this.latest.set(session, { turn, stops, order: Math.max(order, sameGroup ? current!.order : 0),
      view: { revision: ++this.revision, groupId: sameGroup ? current!.view.groupId : this.epoch + ':' + order, results } })
    return true
  }

  /** 首帧发送当前值；请求取消、断线或插件卸载时释放监听。 */
  async *follow(sessionId: string, signal: AbortSignal): AsyncIterable<ChatRouteView> {
    const active = AbortSignal.any([signal, this.lifetime.signal])
    if (active.aborted) return
    const listeners = this.listeners.get(sessionId) ?? new Set()
    this.listeners.set(sessionId, listeners)
    let wake = Promise.withResolvers<void>()
    const notify = () => wake.resolve()
    listeners.add(notify)
    active.addEventListener('abort', notify, { once: true })
    let previous: ChatRouteView | undefined
    try {
      while (!active.aborted) {
        const session = this.ctx.sessions.get(sessionId as LiveSession['id'])
        const view = (session && this.latest.get(session)?.view) || empty
        if (view !== previous) {
          previous = view
          yield view
        } else {
          await wake.promise
          wake = Promise.withResolvers<void>()
        }
      }
    } finally {
      active.removeEventListener('abort', notify)
      listeners.delete(notify)
      if (!listeners.size && this.listeners.get(sessionId) === listeners) this.listeners.delete(sessionId)
    }
  }

  private notify(sessionId: string): void {
    for (const wake of this.listeners.get(sessionId) ?? []) wake()
  }
}
