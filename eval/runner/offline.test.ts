/** 离线参考轨迹和变异轨迹；脚本直接驱动工具流水线，只验证 Fixture/服务/评分/报告。 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { type ToolExecution } from '@deepseek-ai/dsh-tools'
import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'
import * as Native from '@deepseek-ai/dsh-tool-executor-native'
import { mountStorage } from '../../tests/core/storage-helper.ts'
import * as trip from '../../src/index.ts'
import { AMAP_SEARCH_TOOL } from '../../src/adapters/amap-mcp.ts'
import { fixtures, mountFake, seedFavorites } from '../fixtures/amap.ts'
import { loadScenarios } from './scenarios.ts'
import { score, type CaseResult } from './score.ts'
import { array, record, sanitize, type ToolCall, type Trace } from './trace.ts'
import { createRunDirectory, writeReport, writeTrace } from './report.ts'

const scenes = loadScenarios()
const search = 'trip_search_places'
const detail = 'trip_get_place_details'
const recommend = 'trip_recommend_day_itinerary_places'
const plan = 'trip_plan_day_itinerary'
const route = 'trip_plan_route'
const multi = 'trip_plan_multi_stop_route'
const culture = { city: '广州', theme: 'culture' }
const whitelist = { includeDistricts: ['天河区'] }
const theme = { city: '广州', theme: '工业遗产与铁路博物馆', themeKeywords: ['铁路博物馆', '工业遗产'] }
const mode = 'walking'
const saved = (alias: string) => ({ kind: 'saved', alias })
const endpoints = { origin: saved('南门'), destination: saved('展馆') }
const park = { city: '广州', keywords: '公园' }
type Script = (run: (name: string, args: unknown) => Promise<Record<string, unknown>>,
  prev: Record<string, unknown>[]) => Promise<string>
const step = (name: string, args: unknown, reply = '已查询，见本次工具返回的结果。'): Script => async run => { await run(name, args); return reply }
const select = (numbers: number[] | string[], recIndex = 0, reply = '行程已生成。'): Script => async (run, prev) => {
  const selectedNumbers = numbers.map(n => typeof n === 'number' ? n : array(prev[recIndex].candidates).map(record).find(c => c.name === n)?.number)
  await run(plan, { draftId: prev[recIndex].draftId, selectedNumbers, mode })
  return reply
}
const resume: Script = async (run, prev) => { await run(plan, { draftId: prev[0].draftId }); return '已继续并完成剩余路段。' }
const pickNotes = '1. 模拟铁路博物馆；请选择。'
const plans: [number, Script[]][] = [
  [1, [step(search, park, '模拟云杉公园在模拟天河区。')]],
  [2, [step(search, { city: '广州', keywords: '湖滨' })]],
  [3, [step(search, { city: '广州', keywords: '湖滨公园' }, '有两处同名公园，请选择。')]],
  [4, [step(search, { city: '广州', keywords: '游玩' })]],
  [5, [step(route, { ...endpoints, mode }, '路线预计16分钟。')]],
  [6, [async () => '想用哪种交通方式？', step(route, { ...endpoints, mode: 'bicycling' })]],
  [7, [step(route, { ...endpoints, mode: 'transit' }, '测试地铁1号线，甲站上车、乙站下车。')]],
  [8, [step(multi, { stops: ['南门', '展馆', '广场', '北门'].map(saved), mode })]],
  [9, [step(multi, { stops: ['南门', '展馆', '广场', '北门'].map(saved), mode: 'driving', order: 'optimized', pinStart: true, pinEnd: true })]],
  [10, [step(multi, { stops: ['南门', '展馆', '广场', '南门'].map(saved), mode })]],
  [11, [step(recommend, culture, pickNotes)]],
  [12, [step(recommend, { ...theme, ...whitelist, excludeKeywords: ['商场'] })]],
  [13, [step(recommend, { ...culture, excludeDistricts: ['荔湾区', '海珠区'] })]],
  [14, [step(recommend, { ...culture, ...whitelist }, '天河区候选不足。')]],
  [15, [step(recommend, culture), select([1, 3])]],
  [16, [step(recommend, culture), select([2, 3])]],
  [17, [step(recommend, { ...culture, ...whitelist }), select(['模拟铁路博物馆', '模拟工业遗产陈列馆'], 0, '区县未核验，请换一个编号。'),
    select(['模拟铁路博物馆', '模拟机械博物馆'])]],
  [18, [step(recommend, culture), select([1, 2, 3], 0, '本轮预算用完，等你说继续。'), resume]],
  [19, [step(recommend, culture), step(recommend, { city: '广州', theme: 'park', ...whitelist }), select([1, 2], 1)]],
  [20, [step(search, park, '地点查询超时。')]],
  [21, [step(detail, { placeId: 'fake-a' }, '详情查询失败。')]],
  [22, [step(recommend, { ...theme, ...whitelist }), select([1, 2], 0, '区县无法核验，请换一个编号。')]],
  [23, [step(route, { ...endpoints, mode }, '未查到可用路线。')]],
  [24, [step(multi, { stops: ['南门', '展馆', '广场', '北门'].map(saved), mode }, '第一段成功，第二段查询失败，后续未查询。')]],
  [25, [step(recommend, { ...culture, ...whitelist }, '本轮搜索预算已用完。')]],
  [26, [step(search, park, '模拟云杉公园，营业、门票与预约待确认。')]],
  [27, [step(multi, { stops: ['展馆', '广场', '北门'].map(saved), mode: 'bicycling', order: 'optimized', pinStart: false, pinEnd: false },
    '按直线距离排序。')]],
  [28, [step(route, { ...endpoints, mode: 'transit' }, '测试地铁一号线，甲站上车、乙站下车。')]],
  [29, [step(search, { ...park, limit: 2 }), step(search, { ...park, limit: 2 })]],
]

async function replay(id: number, scripts: Script[]): Promise<Trace> {
  const scenario = scenes[id - 1]
  const session = { id: crypto.randomUUID() }
  const trace: Trace = { id: scenario.id, fixture: scenario.fixture, attempt: 1, source: 'offline_fixture',
    tools: [], turns: [], fake: [], model: [], sessionId: session.id,
    limits: { timeoutMs: 15000, maxModelCalls: 0, maxTokens: 0, maxToolCalls: 18 }, durationMs: 0 }
  const start = performance.now()
  const time = () => Math.round(performance.now() - start)
  const agent = { session, id: session.id } as unknown as NonNullable<ToolExecution['agent']>
  let turn = 0
  let seq = 0
  const ctx = new Context()
  const prev: Record<string, unknown>[] = []
  const entries = new Map<string, ToolCall>()
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    await ctx.plugin(Native)
    await mountStorage(ctx)
    await seedFavorites(ctx)
    mountFake(ctx, scenario.fixture, (name, args) => {
      const call = { seq: ++seq, atMs: time(), turn, name, args }
      trace.fake.push(call); return call
    })
    await ctx.plugin(trip, trip.Config({ showLifecycleLogs: false, ...fixtures[scenario.fixture] }))
    ctx.on('tools/pre-execute', (exec, next) => {
      if (!entries.has(exec.callId)) {
        const call = { id: exec.callId, seq: ++seq, turn, name: exec.name, args: exec.arguments, atMs: time(), internal: true } as const
        entries.set(exec.callId, call); trace.tools.push(call)
      }
      return next()
    })
    ctx.on('tools/result', (exec, result) => {
      const call = entries.get(exec.callId)
      if (!call) return
      call.doneSeq = ++seq
      call.durationMs = time() - call.atMs
      if (result.isError) { call.code = result.error.info?.code ?? 'TOOL_ERROR'; call.error = result.error.message }
      else call.value = result.value
    })
    const pipeline = new ToolExecutionPipeline(ctx)
    const signal = new AbortController().signal
    for (const script of scripts) {
      const user = scenario.turns[turn] ?? '测试后续消息'
      turn++
      await ctx.waterfall('agent/pre-step', { agent, turn, step: 1, messages: [], signal, modelSelection: { provider: 'offline', model: 'none' } },
        () => Promise.resolve({ kind: 'reject' as const }))
      const counters = ctx.queryCache.stats()
      const t = time()
      const reply = await script(async (name, args) => {
        const id = ToolCallId('offline-' + crypto.randomUUID())
        const call = { seq: ++seq, atMs: time(), turn, id, name, args }
        entries.set(id, call); trace.tools.push(call)
        const pending = await pipeline.prepare({ callId: id, name, arguments: args, signal, agent })
        const res = await pipeline.complete(pending.exec, pending.kind === 'dispatch' ? await pipeline.dispatch(pending.exec) : pending)
        const result = res.isError ? { code: res.error.info?.code } : record(res.value)
        prev.push(result)
        return result
      }, prev)
      const after = ctx.queryCache.stats()
      trace.turns.push({ user, reply, assistant: [{ seq: ++seq, atMs: time(), step: 1, text: reply }], end: 'completed', durationMs: time() - t,
        cache: { ...after, cacheHits: after.cacheHits - counters.cacheHits, joinedRequests: after.joinedRequests - counters.joinedRequests } })
    }
  } finally { await ctx.fiber.dispose(); trace.durationMs = time() }
  return trace
}

test('全部场景通过 Schema，且每条都存在可得分的真实业务流水线参考轨迹', async t => {
  assert.equal(plans.length, scenes.length)
  assert.equal(new Set(scenes.map(s => s.category)).size, 6)
  assert.equal(scenes.filter(s => s.tags.includes('smoke')).length, 3)
  const reportDir = process.env.TRIP_EVAL_OFFLINE_REPORT === '1' ? await createRunDirectory() : undefined
  const results: CaseResult[] = []
  const startedAt = new Date().toISOString()
  const start = performance.now()
  for (const [id, scripts] of plans) await t.test(scenes[id - 1].description, async () => {
    const trace = await replay(id, scripts)
    const result = score(scenes[id - 1], trace)
    if (reportDir) await writeTrace(reportDir, trace)
    results.push(result)
    assert.equal(result.status, 'pass', JSON.stringify({ issues: result.issues,
      tools: trace.tools.filter(c => !c.internal).map(c => ({ code: c.code, args: c.args, value: c.value })) }))
  })
  if (reportDir) {
    await writeReport(reportDir, results, { scenarioIds: scenes.map(s => s.id), repeat: 1, model: null, startedAt,
      durationMs: Math.round(performance.now() - start), source: 'offline_fixture' })
    const json = JSON.parse(await readFile(reportDir + '/summary.json', 'utf8'))
    assert.equal(json.counts.modelCalls, 0)
    assert.equal(json.source, 'offline_fixture')
    t.diagnostic('离线报告：' + reportDir)
  }
})

test('续查改错草稿、重复请求和被守卫拒绝的地图直调均失败', async () => {
  const trace = await replay(18, plans.find(([id]) => id === 18)![1])
  const resumeCall = trace.tools.find(c => c.turn === 3 && c.name === plan)!
  resumeCall.args = { draftId: 'not-this-session' }
  const original = trace.fake.find(c => c.name.includes('walking'))!
  trace.fake.push({ ...original, turn: 3, seq: 200 })
  trace.tools.push({ name: AMAP_SEARCH_TOOL, args: {}, id: 'bypass', seq: 300, atMs: 0, turn: 2, code: 'TOOL_DENIED' })
  const result = score(scenes[17], trace)
  assert.equal(result.status, 'fail')
  assert.ok(result.issues.some(i => i.code === 'state_lost'))
  assert.ok(result.issues.some(i => i.code === 'duplicate_call'))
  assert.ok(result.issues.some(i => i.code === 'guard_bypass_attempt'))
  assert.equal(result.counts.budgetRejected, 1)
})

test('用真实时间规则拒绝到期草稿；到期后没有实际路线调用', async t => {
  const trace = await replay(15, [step(recommend, culture), async (run, prev) => {
    const original = Date.now()
    t.mock.method(Date, 'now', () => original + 31 * 60 * 1000)
    try {
      const result = await run(plan, { draftId: prev[0].draftId, mode, selectedNumbers: [1, 3] })
      assert.equal(result.code, 'TRIP_ITINERARY_DRAFT_MISSING')
    } finally { t.mock.restoreAll() }
    return '旧清单已失效。'
  }])
  assert.equal(trace.fake.filter(c => c.name.includes('direction')).length, 0)
})

test('基础设施失败不记成模型漏调；缺失的营业信息不判成事实已核验', async () => {
  const trace = await replay(26, plans.find(([id]) => id === 26)![1])
  trace.turns[0].reply = '模拟云杉公园免费开放，无需预约。'
  assert.ok(score(scenes[25], trace).issues.some(i => i.code === 'hallucinated_fact'))
  trace.source = 'real_agent'
  trace.tools = []
  trace.turns[0].end = 'error'
  trace.model = [{ atMs: 0, turn: 1, seq: 1, error: 'UNAUTHORIZED', status: 401 }]
  trace.turns[0].reply = ''
  const result = score(scenes[25], trace)
  assert.equal(result.status, 'error')
  assert.equal(result.issues.length, 1)
  assert.equal(result.issues[0].source, 'infrastructure')
})

test('Trace 屏蔽凭据字段、原始参数中的 API Key 和 URL 参数', async () => {
  const trace = await replay(5, plans[4][1])
  trace.turns[0].reply = '凭证 private-example-key https://invalid/?token=opaque'
  trace.tools[0].rawArgs = 'Bearer another-key'
  trace.tools[0].value = { authorization: 'hidden' }
  const output = JSON.stringify(sanitize(trace, 'private-example-key'))
  for (const str of ['private-example-key', 'opaque', 'another-key', 'hidden']) assert.ok(!output.includes(str))
})

test('只查到一段时不可声称得到全程耗时；公交只报告已知站点与线路', async () => {
  const partial = await replay(24, plans[23][1])
  partial.turns[0].reply = '第一段走通，第二段失败。全程16分钟。'
  assert.ok(score(scenes[23], partial).issues.some(i => i.code === 'hallucinated_fact'))
  const transit = await replay(28, plans[27][1])
  transit.turns[0].reply = '坐地铁一号线，从编造站上车，在乙站下车。'
  assert.ok(score(scenes[27], transit).issues.some(i => i.code === 'hallucinated_fact' && i.evidence.includes('编造站')))
  const unknown = await replay(22, plans[21][1])
  unknown.turns[1].reply = '两处都已核验为天河区。'
  assert.ok(score(scenes[21], unknown).issues.some(i => i.code === 'hallucinated_fact'))
})

test('缺一轮或因输出 Token 上限退出的场景不会误判成通过', async () => {
  const trace = await replay(15, plans[14][1])
  trace.turns.pop()
  assert.ok(score(scenes[14], trace).issues.some(i => i.code === 'incomplete_turn'))
  trace.turns[0].end = 'max-tokens'
  assert.ok(score(scenes[14], trace).issues.some(i => i.code === 'budget_exceeded'))
})
