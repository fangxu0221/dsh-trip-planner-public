/** 按 Harness 会话转交已经提交的 Agent 路线结果，右栏可以晚于工具打开。 */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import type { ChatRouteView, PlanRouteResult } from './types.ts'

type LiveSession = NonNullable<ToolExecution['agent']>['session']
const empty: ChatRouteView = { revision: 0, result: null }

export class SessionRoutes {
  private readonly latest = new Map<LiveSession, ChatRouteView>()
  private readonly listeners = new Map<string, Set<() => void>>()
  private readonly pending = new Map<ToolExecutionToken, number>()
  private readonly staged = new Map<ToolExecutionToken, { session: LiveSession; view: ChatRouteView }>()
  private readonly lifetime = new AbortController()
  private revision = 0

  constructor(private readonly ctx: Context) {
    ctx.on('tools/pre-execute', (execution, next) => {
      if (execution.name === 'trip_plan_route' && execution.agent) {
        this.pending.set(execution.token, ++this.revision)
      }
      return next()
    }, { global: true })
    ctx.on('tools/result', (execution, outcome) => {
      const revision = this.pending.get(execution.token)
      this.pending.delete(execution.token)
      const staged = this.staged.get(execution.token)
      this.staged.delete(execution.token)
      const session = execution.agent?.session
      if ((revision === undefined && !staged) || outcome.isError || execution.signal.aborted
        || !session || ctx.sessions.get(session.id) !== session) return
      let view = staged?.session === session ? staged.view : undefined
      if (revision !== undefined && (!view || view.revision < revision)) {
        // 只接收路线工具自己的成功结构，Remote 再按协议校验整帧。
        const value = outcome.value
        if (value && typeof value === 'object' && !Array.isArray(value) && value.source === 'AMAP'
          && (value.status === 'found' || value.status === 'no-route') && Array.isArray(value.routes)) {
          view = { revision, result: value as unknown as PlanRouteResult }
        }
      }
      if (!view || (this.latest.get(session)?.revision ?? 0) >= view.revision) return
      if (execution.parent !== undefined) {
        // PTC 内部调用等外层工具确认成功才显示，外层报错或取消时丢弃。
        if ((this.staged.get(execution.parent)?.view.revision ?? 0) < view.revision) {
          this.staged.set(execution.parent, { session, view })
        }
        return
      }
      this.latest.set(session, view)
      this.notify(session.id)
    }, { global: true })
    ctx.on('session/disposed', session => {
      if (this.latest.delete(session)) this.notify(session.id)
    }, { global: true })
    ctx.effect(() => () => {
      this.lifetime.abort()
      this.pending.clear()
      this.staged.clear()
      this.latest.clear()
      this.listeners.clear()
    })
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
        const view = (session && this.latest.get(session)) || empty
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
