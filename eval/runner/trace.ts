/** Trace 只保留对话文本、工具结构化事实和有限的模型元信息。 */
import type { FakeCall } from '../fixtures/amap.ts'
import type { QueryCacheStats } from '../../src/contracts/query-cache.ts'
export interface ToolCall {
  seq: number
  turn: number
  atMs: number
  doneSeq?: number
  durationMs?: number
  id: string
  name: string
  args: unknown
  rawArgs?: string
  value?: unknown
  code?: string
  error?: string
  internal?: true
}
export interface Turn {
  user: string
  reply: string
  assistant: { seq: number; atMs: number; text: string; step: number }[]
  end?: string
  error?: string
  status?: number
  durationMs?: number
  cache?: QueryCacheStats
}
export interface ModelCall {
  seq: number
  turn: number
  atMs: number
  durationMs?: number
  completed?: boolean
  error?: string
  status?: number
}
export interface Trace {
  source: 'real_agent' | 'offline_fixture'
  id: string
  attempt: number
  fixture: string
  sessionId?: string
  turns: Turn[]
  tools: ToolCall[]
  fake: FakeCall[]
  model: ModelCall[]
  limits: { timeoutMs: number; maxModelCalls: number; maxToolCalls: number; maxTokens: number }
  durationMs: number
  interrupted?: 'timeout' | 'model_limit' | 'tool_limit' | 'cancelled' | 'harness_error'
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
export function array(value: unknown): unknown[] { return Array.isArray(value) ? value : [] }
export function errorIdentity(error: unknown): { error: string; status?: number } {
  // 不持久化底层模型异常原文、请求 ID、完整 prompt 或 HTTP 头。
  const e = error !== null && typeof error === 'object' ? error as { code?: unknown; status?: unknown; name?: unknown } : {}
  const code = e.code ?? e.name
  return { error: typeof code === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(code) ? code : 'UNKNOWN',
    ...typeof e.status === 'number' && e.status >= 100 && e.status <= 599 ? { status: e.status } : {} }
}
export function sanitize(trace: Trace, key: string): Trace {
  const clean = (value: unknown): unknown => {
    if (typeof value === 'string') return (key ? value.split(key).join('[REDACTED]') : value)
      .replace(/([?&](?:key|token|secret|api_key)=)[^&\s"'<>]+/giu, '$1[REDACTED]')
      .replace(/\b(?:Bearer\s+[\w.-]+|sk-[\w-]{12,})\b/giu, '[REDACTED]')
    if (Array.isArray(value)) return value.map(clean)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
      .map(([k, v]) => [k, /^(?:authorization|api[_-]?key|access[_-]?token|x-api-key|secret)$/iu.test(k) ? '[REDACTED]' : clean(v)]))
    return value
  }
  return clean(trace) as Trace
}
