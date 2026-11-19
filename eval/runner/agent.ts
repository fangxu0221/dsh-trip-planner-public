/** 使用宿主 AgentLoop 和真实 DeepSeek Messages 适配器；只在测试上下文注册地图 Fixture。 */
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { assertUsableApiKey, createUserMessage, LlmError, type PreparedAdapterCall } from '@deepseek-ai/dsh-llm'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as Native from '@deepseek-ai/dsh-tool-executor-native'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { DeepSeekAdapter, PUBLIC_BASE_URL, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { mountStorage } from '../../tests/core/storage-helper.ts'
import * as trip from '../../src/index.ts'
import { fixtures, mountFake, seedFavorites } from '../fixtures/amap.ts'
import type { Scenario } from './scenarios.ts'
import { errorIdentity, sanitize, type ModelCall, type ToolCall, type Trace, type Turn } from './trace.ts'

export const provider = 'deepseek-eval'
export const defaultModel = 'deepseek-flash'
export interface ModelConfig {
  model: string
  temperature?: number
  maxTokens: number
  timeoutMs: number
  maxModelCalls: number
  maxToolCalls: number
}

export function modelConnection(options: ModelConfig) {
  const key = assertUsableApiKey(process.env.DEEPSEEK_API_KEY ?? '', 'eval-agent', 'DEEPSEEK_API_KEY')
  const url = new URL(process.env.DEEPSEEK_BASE_URL || PUBLIC_BASE_URL)
  if (url.protocol !== 'https:') throw new Error('评测服务端地址必须使用 HTTPS')
  const connection = resolveAdapterOptions({
    baseURL: url.href, thinking: 'disabled', maxTokens: options.maxTokens,
    streamIdleTimeoutMs: Math.min(options.timeoutMs, 45_000), retryPolicy: { mode: 'normal', maxRetries: 0 },
  })
  return { connection, key }
}

/** 宿主暂未提供 temperature 的 AgentOptions；在官方适配器准备好的传输边界设置该采样值。 */
class EvalAdapter extends DeepSeekAdapter {
  private readonly temperature?: number
  constructor(dependencies: ConstructorParameters<typeof DeepSeekAdapter>[0], temperature?: number) { super(dependencies); this.temperature = temperature }
  override async prepareCall(providerId: string, model: string, signal?: AbortSignal) {
    const prepared = await super.prepareCall(providerId, model, signal)
    return { ...prepared, stream: (options: Parameters<PreparedAdapterCall['stream']>[0]) => prepared.stream(
      this.temperature === undefined ? options : { ...options, temperature: this.temperature },
    ) }
  }
}

function parseArgs(data: string): unknown {
  try { return JSON.parse(data) } catch { return null }
}

export async function runAgent(scenario: Scenario, attempt: number, options: ModelConfig,
  auth: ReturnType<typeof modelConnection>, signal: AbortSignal): Promise<Trace> {
  const start = performance.now()
  const { timeoutMs, maxModelCalls, maxToolCalls, maxTokens } = options
  const trace: Trace = { source: 'real_agent', id: scenario.id, fixture: scenario.fixture, attempt,
    turns: [], tools: [], fake: [], model: [], durationMs: 0, limits: { timeoutMs, maxModelCalls, maxToolCalls, maxTokens } }
  const ctx = new Context()
  let seq = 0
  let turn = 0
  let roots = 0
  let cancel = () => {}
  const clock = () => Math.round(performance.now() - start)
  const interrupt = (reason: NonNullable<Trace['interrupted']>) => {
    trace.interrupted ??= reason
    cancel()
  }
  const abort = () => interrupt('cancelled')
  const timer = setTimeout(() => interrupt('timeout'), timeoutMs)
  signal.addEventListener('abort', abort, { once: true })

  try {
    if (signal.aborted) { abort(); return trace }
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    await ctx.plugin(Native)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
    await mountStorage(ctx)
    await seedFavorites(ctx)
    mountFake(ctx, scenario.fixture, (name, args) => {
      const event = { seq: ++seq, turn, atMs: clock(), name, args }
      trace.fake.push(event); return event
    })
    await ctx.plugin(trip, trip.Config({ showLifecycleLogs: false, ...fixtures[scenario.fixture] }))
    ctx.llm.registerAdapter([provider], new EvalAdapter({
      options: () => auth.connection,
      resolveAuth: async () => ({ headers: { 'x-api-key': auth.key } }),
      resolveUserId: () => brandString<AnonymousUserId>('trip-eval-local'),
      prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
    }, options.temperature))
    const agent = await ctx.agentLoop.create(SessionId('trip-eval-' + crypto.randomUUID()), {
      provider, model: options.model, maxTokens,
    })
    trace.sessionId = agent.session.id
    cancel = () => agent.cancel({ kind: 'user' })

    const calls = new Map<string, ToolCall>()
    const upsert = (id: string, name: string, args: unknown, internal?: true): ToolCall => {
      let call = calls.get(id)
      if (call) return call
      call = { id, name, args, turn, seq: ++seq, atMs: clock(), ...(internal && { internal }) }
      trace.tools.push(call)
      calls.set(id, call)
      return call
    }

    ctx.on('session/event', (session, event) => {
      if (session !== agent.session) return
      const step = trace.turns[turn - 1]
      if (!step) return
      if (event.type === 'tool/call') {
        const { callId, name, arguments: args } = event.data
        upsert(callId, name, parseArgs(args)).rawArgs = args
        if (++roots > maxToolCalls) interrupt('tool_limit')
      } else if (event.type === 'tool/result') {
        const { message, error } = event.data
        const call = calls.get(message.toolCallId)
        if (call && error && !call.code) { call.code = error.code; call.error = error.reason }
      } else if (event.type === 'assistant/message') {
        const text = event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
        if (text) step.assistant.push({ seq: ++seq, atMs: clock(), step: event.data.step, text })
        // 最后一条有正文的消息是最终回复；中途的工具前说明仍保留在 assistant 数组。
        if (!event.data.message.content.some(block => block.type === 'tool-call')) step.reply = text
      } else if (event.type === 'turn/end') {
        const reason = event.data.reason
        step.end = reason.kind
        if (reason.kind === 'error') Object.assign(step, errorIdentity(reason.error))
      }
    })

    ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec.agent !== agent) return next()
      const internal = exec.name.startsWith('mcp__amap__') && !calls.has(exec.callId)
      upsert(exec.callId, exec.name, exec.arguments, internal ? true : undefined)
      if (!internal && roots > maxToolCalls) {
        interrupt('tool_limit')
        return { kind: 'deny', reason: 'Eval: scenario tool-call limit' }
      }
      return next()
    })
    ctx.on('tools/result', (exec, result) => {
      if (exec.agent !== agent) return
      const call = upsert(exec.callId, exec.name, exec.arguments, exec.name.startsWith('mcp__amap__') && !calls.has(exec.callId) ? true : undefined)
      call.doneSeq = ++seq; call.durationMs = clock() - call.atMs
      if (result.isError) { call.code = result.error.info?.code ?? 'TOOL_ERROR'; call.error = result.error.message }
      else call.value = result.value
    })
    ctx.on('llm/stream', async function* (request, next) {
      if (request.sessionId !== agent.session.id) { yield* next(); return }
      if (trace.model.length >= maxModelCalls) {
        trace.interrupted ??= 'model_limit'
        throw new LlmError('Eval: scenario model-call limit', 'EVAL_MODEL_LIMIT')
      }
      const call: ModelCall = { seq: ++seq, turn, atMs: clock() }
      trace.model.push(call)
      try {
        for await (const chunk of next()) {
          if (chunk.type === 'finish') {
            if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')
              Object.assign(call, errorIdentity(chunk.reason.failure))
            else call.completed = true
          }
          yield chunk
        }
        if (!call.completed && !call.error) call.error = 'INCOMPLETE_STREAM'
      } catch (error) { Object.assign(call, errorIdentity(error)); throw error }
      finally { call.durationMs = clock() - call.atMs }
    })

    for (const user of scenario.turns) {
      if (trace.interrupted) break
      const entry: Turn = { user, reply: '', assistant: [] }
      trace.turns.push(entry)
      turn++
      const t = clock()
      const previous = ctx.queryCache.stats()
      agent.followup(createUserMessage({ content: [{ type: 'text', text: user }], source: { kind: 'user' } }))
      await agent.whenIdle()
      entry.durationMs = clock() - t
      const after = ctx.queryCache.stats()
      entry.cache = { ...after, cacheHits: after.cacheHits - previous.cacheHits,
        joinedRequests: after.joinedRequests - previous.joinedRequests,
        searchCalls: after.searchCalls - previous.searchCalls, detailCalls: after.detailCalls - previous.detailCalls,
        routeCalls: after.routeCalls - previous.routeCalls, writeFailures: after.writeFailures - previous.writeFailures }
      if (trace.model.some(m => m.error) || entry.end !== 'completed') break
    }
  } catch (error) {
    trace.interrupted ??= 'harness_error'
    process.stderr.write('Harness: ' + errorIdentity(error).error + '\n')
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
    try { await ctx.fiber.dispose() }
    catch { trace.interrupted ??= 'harness_error' }
    trace.durationMs = clock()
  }
  return sanitize(trace, auth.key)
}
