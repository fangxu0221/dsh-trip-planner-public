/** JSONL 场景声明和运行前校验；规则值只使用数据，不能执行脚本。 */
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { fixtures } from '../fixtures/amap.ts'

const pattern = z.string().min(1).refine(str => { try { new RegExp(str, 'iu'); return true } catch { return false } }, '无效正则')
const rule = z.strictObject({
  turn: z.number().int().positive(),
  tool: z.string().regex(/^trip_[a-z_]+$/u),
  args: z.record(z.string(), z.unknown()).optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  max: z.number().int().positive().optional(),
  code: z.string().optional(),
  draftFrom: z.number().int().positive().optional(),
  selection: z.union([z.array(z.union([z.number().int().positive(), z.string().min(1)])).min(2).max(3), z.literal('delegate'), z.literal('resume')]).optional(),
  expectedSource: z.enum(['business', 'agent']).default('business'),
})
const deny = z.strictObject({ turn: z.number().int().positive().optional(), tools: z.array(z.string()).min(1) })
const mapRule = z.strictObject({ turn: z.number().int().positive().optional(), name: z.enum(['search', 'detail', 'region', 'walking', 'bicycling', 'driving', 'transit', 'route']),
  min: z.number().int().nonnegative().optional(), max: z.number().int().nonnegative().optional(), outcome: z.enum(['aborted', 'returned', 'fixture_error_response']).optional() })
const replyRule = z.strictObject({ turn: z.number().int().positive(), any: z.array(pattern).nonempty(), label: z.string() })
export const scenarioSchema = z.strictObject({
  id: z.string().regex(/^AGENT-\d{3}$/u),
  category: z.enum(['A', 'B', 'C', 'D', 'E', 'F']),
  description: z.string().min(1),
  turns: z.array(z.string().min(1)).nonempty(),
  fixture: z.custom<keyof typeof fixtures>(value => typeof value === 'string' && Object.hasOwn(fixtures, value)),
  expected: z.strictObject({
    calls: z.array(rule),
    map: z.array(mapRule).optional(),
    replies: z.array(replyRule).optional(),
    manual: z.array(z.string()).nonempty(),
    budget: z.object({ turn: z.number().int().positive(), kind: z.enum(['search', 'route']) }).optional(),
    cacheHits: z.number().int().nonnegative().optional(),
    ground: z.array(z.enum(['time', 'transit', 'availability', 'distance-order', 'district'])).optional(),
  }),
  forbidden: z.strictObject({
    tools: z.array(deny).optional(),
    changedDraftFrom: z.number().int().positive().optional(),
    duplicateMap: z.boolean().default(true),
  }),
  tags: z.array(z.string().min(1)).nonempty(),
}).superRefine((s, ctx) => {
  const refs = [...s.expected.calls, ...s.expected.map ?? [], ...s.expected.replies ?? [], ...s.forbidden.tools ?? [],
    ...s.expected.budget ? [s.expected.budget] : []]
  if (refs.some(r => r.turn !== undefined && r.turn > s.turns.length)
      || s.expected.calls.some(r => (r.draftFrom !== undefined && r.draftFrom >= r.turn)
        || (r.selection !== undefined && r.draftFrom === undefined)
        || (r.draftFrom !== undefined && !s.expected.calls.some(c => c.turn === r.draftFrom && c.tool === 'trip_recommend_day_itinerary_places')))
      || (s.forbidden.changedDraftFrom ?? 0) >= s.turns.length
      || s.expected.map?.some(r => r.min !== undefined && r.max !== undefined && r.min > r.max)) {
    ctx.addIssue({ code: 'custom', message: '轮号、草稿引用或计数区间无效' })
  }
})
export type Scenario = z.infer<typeof scenarioSchema>

export function loadScenarios(): Scenario[] {
  const ids = new Set<string>()
  return readFileSync(new URL('../scenarios/agent_v1.jsonl', import.meta.url), 'utf8').replace(/^\uFEFF/u, '')
    .split(/\r?\n/u).filter(line => line.trim()).map((line, index) => {
      try {
        const scenario = scenarioSchema.parse(JSON.parse(line))
        if (ids.has(scenario.id)) throw new Error('场景 ID 重复')
        ids.add(scenario.id)
        return scenario
      } catch (err) { throw new Error('agent_v1.jsonl 第 ' + (index + 1) + ' 条无效', { cause: err }) }
    })
}
