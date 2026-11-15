/** 真实工具流水线 + 官方临时 JSON 后端；远端模拟只存在于测试中。 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineTool, type ToolExecution, type ToolExecutionResult, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'
import * as Native from '@deepseek-ai/dsh-tool-executor-native'
import { AMAP_DETAILS_TOOL, AMAP_REGION_TOOL, AMAP_ROUTE_TOOLS, AMAP_SEARCH_TOOL } from '../../src/adapters/amap-mcp.ts'
import { normalizeRoutePayload } from '../../src/adapters/amap-routes.ts'
import type { Config } from '../../src/config.ts'
import type { DayItineraryResult, ItineraryRecommendation } from '../../src/contracts/day-itinerary.ts'
import { routeModes, type PlanMultiStopRouteResult, type PlanRouteResult, type RouteMode } from '../../src/contracts/routes.ts'
import { savedPlaceSchema, tripPlannerDomain, type SavedPlace } from '../../src/domain.ts'
import * as trip from '../../src/index.ts'
import { routeFixtures } from './data/routes.ts'
import { transitPresentationFixture } from './data/route-presentation.ts'
import { mountStorage } from './storage-helper.ts'

const fetchedAt = '2026-11-04T00:00:00.000Z'
const refs = { origin: { kind: 'saved', alias: '家' }, destination: { kind: 'saved', alias: '公司' } }
function saved(placeId: string, alias: string, longitude: number): SavedPlace {
  return savedPlaceSchema.parse({ id: crypto.randomUUID(), placeId, alias, source: 'AMAP', name: '测试地点' + placeId,
    address: '测试地址', city: '广州市', coordinates: { longitude, latitude: 23 }, fetchedAt, createdAt: fetchedAt, updatedAt: fetchedAt })
}
function raw(data: unknown) { return { content: [{ type: 'text', text: JSON.stringify(data) }] } }
type RouteArgs = { origin: string; destination: string; city?: string; cityd?: string }

async function mount(options: {
  records?: SavedPlace[]; config?: Partial<Config>; registerRoutes?: boolean
  detail?: (id: string, execution: ToolRunContext) => Promise<unknown>
  region?: (location: string) => unknown
  search?: (keywords: string) => unknown
  route?: (mode: RouteMode, args: RouteArgs, execution: ToolRunContext) => Promise<unknown>
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'trip-route-test-'))
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    await ctx.plugin(Native)
    await mountStorage(ctx, root)
    const domain = await ctx.storageDomain.open(tripPlannerDomain)
    for (const record of options.records ?? [saved('poi1', '家', 113), saved('poi2', '公司', 113.1)]) await domain.table('favorites').put(record.id, record)
    await domain.close()
    const calls: { name: string; args: unknown }[] = []
    if (options.search) ctx.tools.register(defineTool({
      name: AMAP_SEARCH_TOOL, description: '测试主题搜索',
      parameters: { keywords: { type: 'string', required: true }, city: { type: 'string', required: true },
        citylimit: { type: 'boolean', required: true } },
      output: { schema: { type: 'json' }, render: () => [{ type: 'text', text: '测试主题搜索' }] },
      async execute(args) {
        calls.push({ name: AMAP_SEARCH_TOOL, args })
        return raw(options.search?.(args.keywords))
      },
    }))
    ctx.tools.register(defineTool({
      name: AMAP_DETAILS_TOOL, description: '测试详情', parameters: { id: { type: 'string', required: true } },
      output: { schema: { type: 'json' }, render: () => [{ type: 'text', text: '测试详情' }] },
      async execute(args, execution) {
        calls.push({ name: AMAP_DETAILS_TOOL, args })
        return raw(options.detail ? await options.detail(args.id, execution) : { id: args.id, name: '测试地点' + args.id,
          address: '新详情地址', city: '广州市', location: args.id === 'poi1' ? '113,23' : '113.1,23' })
      },
    }))
    if (options.region) ctx.tools.register(defineTool({
      name: AMAP_REGION_TOOL, description: '测试行政区核验',
      parameters: { location: { type: 'string', required: true } },
      output: { schema: { type: 'json' }, render: () => [{ type: 'text', text: '测试行政区核验' }] },
      async execute(args) {
        calls.push({ name: AMAP_REGION_TOOL, args })
        return raw(options.region?.(args.location))
      },
    }))
    if (options.registerRoutes !== false) for (const mode of routeModes) ctx.tools.register(defineTool({
      name: AMAP_ROUTE_TOOLS[mode], description: '测试路线',
      parameters: { origin: { type: 'string', required: true }, destination: { type: 'string', required: true },
        ...mode === 'transit' ? { city: { type: 'string', required: true } as const, cityd: { type: 'string', required: true } as const } : {} },
      output: { schema: { type: 'json' }, render: () => [{ type: 'text', text: '测试路线' }] },
      async execute(args, execution) {
        calls.push({ name: AMAP_ROUTE_TOOLS[mode], args })
        return raw(options.route ? await options.route(mode, args, execution) : routeFixtures[mode])
      },
    }))
    const fiber = ctx.plugin(trip, trip.Config({ showLifecycleLogs: false, cacheEnabled: false, ...options.config }))
    await fiber
    assert.ok(ctx.get('routePlanner'))
    const close = async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
    return { ctx, fiber, root, calls, close }
  } catch (error) { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); throw error }
}

async function run(ctx: Context, args: Record<string, unknown>, signal = new AbortController().signal,
  name = 'trip_plan_route'): Promise<ToolExecutionResult> {
  const batch = await ctx.tools.execute({ calls: [{ type: 'tool-call', id: ToolCallId('route-test-' + crypto.randomUUID()), name, arguments: JSON.stringify(args) }], signal })
  assert.ok(batch.results[0])
  return batch.results[0].result
}

const museumA = { id: 'museum-a', name: '测试历史博物馆', address: '测试甲路', city: '广州市', location: '113.04,23' }
const museumB = { id: 'museum-b', name: '测试艺术博物馆', address: '测试乙路', city: '广州市', location: '113.08,23' }
const museumDetail = async (id: string) => [museumA, museumB].find(place => place.id === id)
const dayQuery = { city: '广州', theme: 'culture', mode: 'walking' }
const runDay = (ctx: Context, args: Record<string, unknown> = dayQuery) => run(ctx, args, undefined, 'trip_plan_day_itinerary')
function itinerary(result: ToolExecutionResult): DayItineraryResult {
  assert.ok(!result.isError, JSON.stringify(result))
  return result.value as unknown as DayItineraryResult
}

type Agent = NonNullable<ToolExecution['agent']>
const itineraryAgent = (id: string) => ({ id, session: { id } }) as unknown as Agent
const itineraryStep = (ctx: Context, agent: Agent, turn: number) => ctx.waterfall('agent/pre-step', {
  agent, turn, step: 1, messages: [], signal: new AbortController().signal, modelSelection: { provider: 'offline', model: 'fixture' },
}, () => Promise.resolve({ kind: 'reject' as const }))

async function agentItinerary(ctx: Context, agent: Agent, args: Record<string, unknown>, name = 'trip_plan_day_itinerary') {
  const pipeline = new ToolExecutionPipeline(ctx)
  const prepared = await pipeline.prepare({
    callId: ToolCallId(crypto.randomUUID()), name, arguments: args, agent, signal: new AbortController().signal,
  })
  return pipeline.complete(prepared.exec, prepared.kind === 'dispatch' ? await pipeline.dispatch(prepared.exec) : prepared)
}

async function recommend(ctx: Context, agent: Agent, args: Record<string, unknown>): Promise<ItineraryRecommendation> {
  const output = await agentItinerary(ctx, agent, args, 'trip_recommend_day_itinerary_places')
  assert.ok(!output.isError, JSON.stringify(output))
  return output.value as unknown as ItineraryRecommendation
}

const visitsFixture = [museumA, museumB, { ...museumB, id: 'museum-c', name: '测试铁路博物馆', address: '测试丙路', location: '113.12,23' }]
const cultureRecommendation = { city: '广州', theme: 'culture' }

test('历史名迹先给候选，排除泛博物馆，确认前零详情和路线调用，编号只属于当前会话', async t => {
  const historic = [
    { ...museumA, city: '西安市', name: '测试古城墙' },
    { ...museumB, city: '西安市', name: '测试历史遗址' },
    { ...visitsFixture[2], city: '西安市', name: '测试鼓楼' },
  ]
  const fixture = await mount({ records: [], search: keywords => ({ pois: keywords === '城墙'
    ? [{ ...museumA, id: 'unrelated', city: '西安市', name: '情绪博物馆', type: '科教文化服务;博物馆' }, historic[0]]
    : [historic[0], historic[1], historic[2]] }),
    detail: async id => historic.find(place => place.id === id),
  })
  t.after(fixture.close)
  const owner = itineraryAgent('historical')
  const args = { city: '西安', theme: '历史名迹', themeKeywords: ['城墙', '遗址'] }
  const premature = await agentItinerary(fixture.ctx, owner, { ...args, mode: 'walking' })
  assert.equal(premature.error?.info?.code, 'TRIP_ITINERARY_SELECTION_REQUIRED')
  assert.equal(fixture.calls.length, 0)
  const choices = await recommend(fixture.ctx, owner, args)
  assert.deepEqual(choices.candidates.map(place => [place.number, place.name]), [
    [1, '测试古城墙'], [2, '测试历史遗址'], [3, '测试鼓楼'],
  ])
  for (const [agent, selectedNumbers] of [[itineraryAgent('another'), [1, 2]], [owner, [2, 2]], [owner, [2, 4]]] as const) {
    const result = await agentItinerary(fixture.ctx, agent, { draftId: choices.draftId, selectedNumbers, mode: 'walking' })
    assert.equal(result.isError, true)
  }
  assert.deepEqual(fixture.calls.map(call => call.name), [AMAP_SEARCH_TOOL, AMAP_SEARCH_TOOL])
  const value = itinerary(await agentItinerary(fixture.ctx, owner, { draftId: choices.draftId, selectedNumbers: [2, 3], mode: 'walking' }))
  assert.equal(value.status, 'ready')
  assert.deepEqual(value.visits.map(visit => visit.placeId), [historic[1].id, historic[2].id])
  assert.deepEqual(fixture.calls.slice(2).map(call => call.args), [
    { id: historic[1].id }, { id: historic[2].id }, { origin: '113.08,23', destination: '113.12,23' },
  ])
})

test('触达详情预算时保留原选择和已查详情，继续只补未核验区县并规划', async t => {
  const fixture = await mount({ config: { agentMaxDetailCallsPerTurn: 3 }, search: () => ({ pois: visitsFixture }),
    detail: async id => visitsFixture.find(place => place.id === id),
    region: () => ({ city: '广州市', district: '天河区' }),
  })
  t.after(fixture.close)
  const owner = itineraryAgent('detail-resume')
  await itineraryStep(fixture.ctx, owner, 1)
  const choices = await recommend(fixture.ctx, owner, { ...cultureRecommendation, includeDistricts: ['天河区'] })
  assert.ok(choices.candidates.every(place => place.pendingDistrict))
  await itineraryStep(fixture.ctx, owner, 2)
  const selected = { draftId: choices.draftId, selectedNumbers: [1, 2], mode: 'walking' }
  const limited = itinerary(await agentItinerary(fixture.ctx, owner, selected))
  assert.equal(limited.route, null)
  assert.deepEqual(limited.progress, { draftId: choices.draftId, stage: 'verification', reason: 'budget',
    verifiedNumbers: [1], pendingNumbers: [2], rejectedNumbers: [], completedLegs: 0, pendingLegs: 1 })
  const beforeRetry = fixture.calls.length
  assert.equal(itinerary(await agentItinerary(fixture.ctx, owner, { draftId: choices.draftId })).progress?.reason, 'budget')
  assert.equal(fixture.calls.length, beforeRetry)
  await itineraryStep(fixture.ctx, owner, 3)
  const complete = itinerary(await agentItinerary(fixture.ctx, owner, { draftId: choices.draftId }))
  assert.equal(complete.status, 'ready')
  assert.deepEqual(fixture.calls.slice(beforeRetry).map(call => call.name), [AMAP_REGION_TOOL, AMAP_ROUTE_TOOLS.walking])
})

test('禁止区县的候选被替换时保留其他选择和核验结果', async t => {
  const fixture = await mount({ search: () => ({ pois: visitsFixture }),
    detail: async id => visitsFixture.find(place => place.id === id),
    region: location => ({ city: '广州市', district: location === museumB.location ? '荔湾区' : '天河区' }),
  })
  t.after(fixture.close)
  const owner = itineraryAgent('replace-visit')
  const choices = await recommend(fixture.ctx, owner, { ...cultureRecommendation, excludeDistricts: ['荔湾区'] })
  const action = { draftId: choices.draftId, mode: 'walking' }
  const partial = itinerary(await agentItinerary(fixture.ctx, owner, { ...action, selectedNumbers: [1, 2] }))
  assert.deepEqual(partial.progress?.verifiedNumbers, [1])
  assert.deepEqual(partial.progress?.rejectedNumbers, [2])
  assert.equal(partial.route, null)
  const alreadyCalled = fixture.calls.length
  const complete = itinerary(await agentItinerary(fixture.ctx, owner, { ...action, selectedNumbers: [1, 3], stayMinutes: 45 }))
  assert.equal(complete.status, 'ready')
  assert.deepEqual(complete.visits.map(visit => visit.stayMinutes), [45, 45])
  assert.deepEqual(fixture.calls.slice(alreadyCalled).map(call => call.name),
    [AMAP_DETAILS_TOOL, AMAP_REGION_TOOL, AMAP_ROUTE_TOOLS.walking])
})

test('路线预算中断后只续查剩余路段，无缓存时也不重查已成功路段', async t => {
  const fixture = await mount({ config: { agentMaxRouteCallsPerTurn: 1 }, search: () => ({ pois: visitsFixture }),
    detail: async id => visitsFixture.find(place => place.id === id),
  })
  t.after(fixture.close)
  const owner = itineraryAgent('route-resume')
  await itineraryStep(fixture.ctx, owner, 1)
  const choices = await recommend(fixture.ctx, owner, cultureRecommendation)
  await itineraryStep(fixture.ctx, owner, 2)
  const limited = itinerary(await agentItinerary(fixture.ctx, owner, { draftId: choices.draftId, selectedNumbers: [1, 2, 3], mode: 'walking' }))
  assert.equal(limited.progress?.reason, 'budget')
  assert.deepEqual([limited.progress?.completedLegs, limited.progress?.pendingLegs], [1, 1])
  const called = fixture.calls.length
  await itineraryStep(fixture.ctx, owner, 3)
  const complete = itinerary(await agentItinerary(fixture.ctx, owner, { draftId: choices.draftId }))
  assert.equal(complete.status, 'ready')
  assert.ok(limited.route && 'stops' in limited.route && complete.route && 'stops' in complete.route)
  assert.deepEqual(complete.route.legs[0], limited.route.legs[0])
  assert.deepEqual(fixture.calls.slice(called).map(call => call.name), [AMAP_ROUTE_TOOLS.walking])
  assert.deepEqual(itinerary(await agentItinerary(fixture.ctx, owner, { draftId: choices.draftId })), complete)
  assert.equal(fixture.calls.length, called + 1)
})

test('单日行程自动去重和排除附属点，只查询两个入选地点并生成时间表', async () => {
  const fixture = await mount({ detail: museumDetail, search: () => ({ pois: [
    { ...museumA, id: 'parking', name: '测试历史博物馆停车场' }, museumA,
    { ...museumB, id: 'outside', city: '佛山市' }, { ...museumA, id: 'same-label' }, museumB,
  ] }) })
  try {
    const output = await runDay(fixture.ctx)
    const value = itinerary(output)
    assert.deepEqual(value.visits.map(visit => visit.placeId), ['museum-a', 'museum-b'])
    assert.deepEqual(fixture.calls.map(call => call.name), [
      AMAP_SEARCH_TOOL, AMAP_DETAILS_TOOL, AMAP_DETAILS_TOOL, AMAP_ROUTE_TOOLS.walking,
    ])
    assert.equal(value.status, 'ready')
    assert.equal(value.defaultStart, true)
    assert.equal(value.defaultEnd, true)
    assert.deepEqual(value.timeline.map(item => [item.kind, item.startMinute, item.endMinute]), [
      ['visit', 600, 690], ['travel', 690, 706], ['visit', 706, 796],
    ])
    assert.match(JSON.stringify(output.content), /预计结束 13:16/)
  } finally { await fixture.close() }
})

test('单日行程保留返程、用户停留时长和结束限制，超时给出差值', async () => {
  const fixture = await mount({ detail: museumDetail, search: () => ({ pois: [museumA, museumB] }) })
  try {
    const value = itinerary(await runDay(fixture.ctx, { ...dayQuery, mode: 'transit',
      origin: refs.origin, returnToOrigin: true, startTime: '10:00', endTime: '11:45', stayMinutes: 30,
    }))
    assert.equal(value.status, 'over-window')
    assert.equal(value.finishMinute, 750)
    assert.equal(value.overByMinutes, 45)
    assert.deepEqual(value.timeline.map(item => item.kind), ['travel', 'visit', 'travel', 'visit', 'travel'])
    assert.ok(value.route && 'stops' in value.route)
    assert.equal(value.route.stops[0].placeId, value.route.stops.at(-1)?.placeId)
    assert.equal(fixture.calls.filter(call => call.name === AMAP_ROUTE_TOOLS.transit).length, 3)
  } finally { await fixture.close() }
})

test('自然语言主题按高德类型核验，过滤行政区与排除词，路线复用已查详情', async () => {
  const first = { ...museumA, name: '测试科普中心', district: '天河区', type: '展览馆;铁路博物馆' }
  const second = { ...museumB, name: '测试工业遗产馆' }
  const fixture = await mount({
    search: () => ({ pois: [
      { ...first, id: 'excluded-mall', name: '工业遗产商场' },
      { ...first, id: 'other-district', district: '荔湾区' }, first, second,
    ] }),
    detail: async id => [first, second].find(place => place.id === id),
    region: () => ({ country: '中国', province: '广东省', city: '广州市', district: '越秀区' }),
  })
  try {
    const output = await runDay(fixture.ctx, { ...dayQuery, theme: '工业遗产与铁路展馆',
      themeKeywords: ['工业遗产', '铁路博物馆'], includeDistricts: ['天河区', '越秀区'],
      excludeDistricts: ['荔湾区'], excludeKeywords: ['商场'] })
    const value = itinerary(output)
    assert.equal(value.status, 'ready')
    assert.deepEqual(value.visits.map(visit => [visit.placeId, visit.district, visit.reason]), [
      [first.id, '天河区', '类型匹配铁路博物馆'], [second.id, '越秀区', '名称匹配工业遗产'],
    ])
    assert.match(JSON.stringify(output.content), /游览区县 天河区、越秀区/)
    assert.deepEqual(fixture.calls.map(call => call.name), [
      AMAP_SEARCH_TOOL, AMAP_DETAILS_TOOL, AMAP_DETAILS_TOOL, AMAP_REGION_TOOL, AMAP_ROUTE_TOOLS.walking,
    ])
  } finally { await fixture.close() }
})

test('严格排除区县时拒绝同名异地与归属未知的候选，候选不足不查路线', async () => {
  const fixture = await mount({
    search: () => ({ pois: [
      { ...museumA, city: '佛山市', district: '天河区' }, museumB,
      { ...museumA, id: 'outside', city: '广州市', district: '荔湾区' },
    ] }),
    detail: museumDetail,
    region: () => ({ province: '广东省', city: '广州市', district: '' }),
  })
  try {
    const conflict = await runDay(fixture.ctx, { ...dayQuery, includeDistricts: ['天河区'], excludeDistricts: ['天河区'] })
    assert.equal(conflict.isError, true)
    assert.equal(fixture.calls.length, 0)
    const value = itinerary(await runDay(fixture.ctx, { ...dayQuery, excludeDistricts: ['荔湾区'] }))
    assert.equal(value.status, 'insufficient-places')
    assert.equal(value.route, null)
    assert.match(value.message ?? '', /2 个候选不在指定地区.*1 个候选的必要信息未能核验/u)
    assert.deepEqual(fixture.calls.map(call => call.name), [
      AMAP_SEARCH_TOOL, AMAP_DETAILS_TOOL, AMAP_REGION_TOOL, AMAP_SEARCH_TOOL,
    ])
  } finally { await fixture.close() }
})

test('行政区核验最多四次实际请求，缓存命中和补搜不重复消耗额度', async () => {
  const places = Array.from({ length: 5 }, (_, index) => ({ ...museumA, id: 'test-' + index, location: (113 + index / 100) + ',23' }))
  const fixture = await mount({ config: { cacheEnabled: true },
    search: () => ({ pois: places }), detail: async id => places.find(place => place.id === id),
    region: () => ({ city: '广州市', district: null }),
  })
  try {
    for (let index = 0; index < 2; index++) {
      fixture.calls.length = 0
      const value = itinerary(await runDay(fixture.ctx, { ...dayQuery, includeDistricts: ['天河区'] }))
      assert.equal(value.status, 'insufficient-places')
      assert.equal(value.route, null)
      assert.equal(fixture.calls.filter(call => [AMAP_REGION_TOOL, AMAP_DETAILS_TOOL].includes(call.name)).length, 4)
      assert.equal(fixture.calls.filter(call => call.name === AMAP_SEARCH_TOOL).length, index === 0 ? 2 : 0)
    }
  } finally { await fixture.close() }
})

test('商圈偏好优先排序，保留其他符合主题的地点作补充', async () => {
  const preferred = { ...museumB, business_area: '珠江新城' }
  const fixture = await mount({ search: () => ({ pois: [museumA, preferred] }),
    detail: async id => [museumA, preferred].find(place => place.id === id),
  })
  try {
    const value = itinerary(await runDay(fixture.ctx, { ...dayQuery, preferredArea: '珠江新城' }))
    assert.equal(value.status, 'ready')
    assert.deepEqual(value.visits.map(visit => visit.placeId), [museumB.id, museumA.id])
  } finally { await fixture.close() }
})

test('候选不足最多补搜一次，非法时间在搜索前拒绝', async () => {
  const fixture = await mount({ search: keywords => ({ pois: keywords === '博物馆' ? [museumA] : [
    { ...museumA, id: 'entrance', name: '测试美术馆-北门' }, museumA,
  ] }) })
  try {
    assert.equal((await runDay(fixture.ctx, { ...dayQuery, startTime: '20:00' })).isError, true)
    assert.equal(fixture.calls.length, 0)
    const value = itinerary(await runDay(fixture.ctx))
    assert.equal(value.status, 'insufficient-places')
    assert.equal(value.visits.length, 1)
    assert.deepEqual(fixture.calls.map(call => call.name), [AMAP_SEARCH_TOOL, AMAP_SEARCH_TOOL])
    assert.equal(value.route, null)
  } finally { await fixture.close() }
})

test('缺少交通耗时时保留已知前缀，后续时间待定', async () => {
  const fixture = await mount({ detail: museumDetail, search: () => ({ pois: [museumA, museumB] }),
    route: async () => ({ route: { paths: [{ distance: '1200', steps: [] }] } }),
  })
  try {
    const value = itinerary(await runDay(fixture.ctx))
    assert.equal(value.status, 'incomplete')
    assert.equal(value.finishMinute, null)
    assert.deepEqual(value.timeline.map(item => [item.startMinute, item.endMinute]), [[600, 690], [690, null], [null, null]])
  } finally { await fixture.close() }
})
function success(result: ToolExecutionResult): PlanRouteResult {
  assert.ok(!result.isError, JSON.stringify(result))
  return result.value as unknown as PlanRouteResult
}

test('四种方式使用真实收藏坐标，公交传城市，输出通过 schema，整个流程不修改收藏', async () => {
  const fixture = await mount()
  try {
    const before = await readFile(join(fixture.root, 'trip_planner.json'), 'utf8')
    for (const mode of routeModes) {
      const output = await run(fixture.ctx, { ...refs, mode })
      const result = success(output)
      assert.equal(result.mode, mode)
      assert.equal(result.status, 'found')
      assert.equal(result.origin.alias, '家')
      assert.equal(result.origin.detailsFetchedAt, fetchedAt)
      assert.deepEqual(fixture.calls.at(-1), { name: AMAP_ROUTE_TOOLS[mode], args: {
        origin: '113,23', destination: '113.1,23', ...mode === 'transit' ? { city: '广州市', cityd: '广州市' } : {},
      } })
      assert.ok(output.content.some(block => block.type === 'text' && /广州市.*经度：113.*纬度：23/u.test(block.text)))
      if (mode === 'driving') assert.ok(output.content.some(block => block.type === 'text' && /道路收费：¥0/u.test(block.text)))
    }
    assert.equal(fixture.calls.length, 4)
    assert.equal(await readFile(join(fixture.root, 'trip_planner.json'), 'utf8'), before)
  } finally { await fixture.close() }
})

test('混用收藏与 POI，缺坐标时补查；最多两次详情再一次路线，不回写收藏', async () => {
  const first = saved('poi1', '家', 113)
  first.coordinates = null
  const fixture = await mount({ records: [first] })
  try {
    const before = await readFile(join(fixture.root, 'trip_planner.json'), 'utf8')
    const result = success(await run(fixture.ctx, { origin: refs.origin, destination: { kind: 'poi', placeId: 'poi2' }, mode: 'walking' }))
    assert.equal(result.origin.alias, '家')
    assert.equal(result.origin.address, '新详情地址')
    assert.equal(result.destination.alias, null)
    assert.deepEqual(fixture.calls.map(call => call.name), [AMAP_DETAILS_TOOL, AMAP_DETAILS_TOOL, AMAP_ROUTE_TOOLS.walking])
    assert.equal(await readFile(join(fixture.root, 'trip_planner.json'), 'utf8'), before)
  } finally { await fixture.close() }
})

test('非法引用、未知别名、相同 POI 在联网前拒绝，不接受模型直接填坐标', async () => {
  const fixture = await mount()
  try {
    for (const args of [
      { ...refs, mode: 'fly' }, { ...refs, mode: 'walking', origin: { kind: 'saved', alias: ' ' } },
      { ...refs, mode: 'walking', origin: { kind: 'poi', placeId: 'poi1', coordinates: '113,23' } },
      { ...refs, mode: 'walking', destination: { kind: 'saved', alias: '不存在' } },
      { ...refs, mode: 'walking', destination: { kind: 'poi', placeId: 'poi1' } },
    ]) assert.equal((await run(fixture.ctx, args)).isError, true)
    assert.equal(fixture.calls.length, 0)
  } finally { await fixture.close() }
})

test('公交缺城市时补查，仍未知就失败，不把 defaultCity 当作来源城市', async () => {
  const first = saved('poi1', '家', 113)
  first.city = null
  const fixture = await mount({ records: [first, saved('poi2', '公司', 113.1)], config: { defaultCity: '北京' },
    detail: async id => ({ id, name: '测试地点', location: '113,23' }) })
  try {
    const result = await run(fixture.ctx, { ...refs, mode: 'transit' })
    assert.ok(result.isError)
    assert.equal(result.error.info?.code, 'TRIP_ROUTE_CITY_MISSING')
    assert.deepEqual(fixture.calls.map(call => call.name), [AMAP_DETAILS_TOOL])
    assert.equal((await fixture.ctx.savedPlaces.get('家'))?.city, null)
  } finally { await fixture.close() }
})

test('详情缺坐标或不同 POI 解析为同一坐标时，不发路线请求', async () => {
  for (const withCoordinate of [false, true]) {
    const fixture = await mount({ records: [], detail: async id => ({ id, name: '地点', city: '广州市', ...withCoordinate ? { location: '113,23' } : {} }) })
    try {
      assert.equal((await run(fixture.ctx, { origin: { kind: 'poi', placeId: 'poi1' }, destination: { kind: 'poi', placeId: 'poi2' }, mode: 'walking' })).isError, true)
      assert.ok(fixture.calls.every(call => call.name === AMAP_DETAILS_TOOL))
    } finally { await fixture.close() }
  }
})

test('公交站数有途中站依据，步行摘要保留转弯、通道和原始步骤', () => {
  const lines = [
    { name: 'APM线(广州塔--林和西)', departure_stop: { name: '广州塔' }, arrival_stop: { name: '黄埔大道' },
      via_stops: ['海心沙', '大剧院', '花城大道'].map(name => ({ name })) },
    { name: '未知方向线路', departure_stop: '广州塔', arrival_stop: '黄埔大道',
      via_num: '8', via_stops: [{ name: '海心沙' }] },
  ]
  const result = normalizeRoutePayload({ transits: [{ segments: [
    { walking: { distance: '140', steps: [{ instruction: '步行1米到达目的地' }, { instruction: '步行1米' },
      { instruction: '向左转进入地下通道' }, { instruction: '向左转进入地下通道。' }, { instruction: '步行139米到达广州塔' }] },
      bus: { buslines: lines }, exit: { name: 'A口' } },
  ] }] }, 'transit', fetchedAt)
  const [walk, ride] = result.routes[0]!.segments
  assert.equal(walk?.instruction, '向左转进入地下通道，步行139米到达广州塔。')
  assert.equal(walk?.walkingSteps?.length, 5)
  assert.equal(walk?.distanceMeters, 140)
  assert.equal(ride?.transportOptions[0]?.serviceName, 'APM线')
  assert.equal(ride?.transportOptions[0]?.direction, '林和西')
  assert.equal(ride?.transportOptions[0]?.stopsToArrival, 4)
  assert.equal(ride?.transportOptions[1]?.direction, undefined)
  assert.equal(ride?.transportOptions[1]?.stopsToArrival, undefined)
})

test('公交分段保留可选线路，不能把顶层步行距离当公交总距离，也不累加备选线路', () => {
  const result = normalizeRoutePayload(routeFixtures.transit, 'transit', fetchedAt)
  const route = result.routes[0]!
  assert.equal(route.distanceMeters, null)
  assert.equal(route.durationSeconds, 1800)
  assert.equal(route.costCny, 2)
  assert.deepEqual(route.segments.map(segment => segment.kind), ['walking', 'public-transport', 'walking'])
  assert.equal(route.segments[1]!.transportOptions.length, 2)
  assert.equal(route.segments[1]!.durationSeconds, null)
  assert.equal(route.segments[1]!.transportOptions[0]!.departureStop, '甲站')
  assert.equal(route.segments[1]!.entrance, 'A口')
  assert.equal(route.segments[1]!.exit, 'B口')
})

test('完整的路线不带通用提示，缺失距离或耗时时仍有数据说明', () => {
  const at = '2026-11-06T00:00:00.000Z'
  assert.deepEqual(normalizeRoutePayload(routeFixtures.walking, 'walking', at).warnings, [])
  assert.ok(normalizeRoutePayload(routeFixtures.transit, 'transit', at).warnings.some(text => text.includes('缺少总距离')))
})

test('数值转换保留零，缺值为 null；顶层骑行、三条方案限制和无路线状态明确', () => {
  const result = normalizeRoutePayload({ distance: 0, duration: '0', steps: [] }, 'bicycling', fetchedAt)
  assert.equal(result.routes[0]!.distanceMeters, 0)
  assert.equal(result.routes[0]!.durationSeconds, 0)
  assert.equal(result.routes[0]!.costCny, null)
  const many = normalizeRoutePayload({ paths: Array.from({ length: 4 }, () => ({ distance: '10', duration: '20', steps: [] })) }, 'walking', fetchedAt)
  assert.equal(many.sourceCount, 4)
  assert.equal(many.returned, 3)
  assert.equal(many.truncated, true)
  assert.equal(normalizeRoutePayload({ transits: [] }, 'transit', fetchedAt).status, 'no-route')
})

test('无路线是成功状态；业务错误、未知形状、非法单位和非 JSON 不伪装成空路线', async () => {
  let response: unknown = { route: { paths: [] } }
  const fixture = await mount({ route: async () => response })
  try {
    assert.equal(success(await run(fixture.ctx, { ...refs, mode: 'walking' })).status, 'no-route')
    for (const invalid of [{ status: '0', route: { paths: [] } }, { unexpected: [] }, { paths: [{}] },
      { paths: [{ distance: '-1', duration: '10' }] }, { paths: [{ distance: '1km', duration: '10' }] },
      { paths: [{ distance: 1, duration: false }] }, { errcode: 10000, data: { paths: [] } }]) {
      response = invalid
      assert.equal((await run(fixture.ctx, { ...refs, mode: 'walking' })).isError, true)
    }
  } finally { await fixture.close() }
})

test('缺少路线工具明确报错；嵌套路线保留权限守卫和 root/parent 关联', async () => {
  const missing = await mount({ registerRoutes: false })
  try {
    const result = await run(missing.ctx, { ...refs, mode: 'walking' })
    assert.ok(result.isError)
    assert.equal(result.error.info?.code, 'TRIP_MCP_NOT_READY')
  } finally { await missing.close() }
  const fixture = await mount()
  let outer: ToolExecution | undefined
  fixture.ctx.tools.guard(execution => {
    if (execution.name === 'trip_plan_route') outer = execution
    if (execution.name === AMAP_ROUTE_TOOLS.walking) {
      assert.ok(outer)
      assert.equal(execution.parent, outer.token)
      assert.equal(execution.rootCallId, outer.rootCallId)
      return '测试策略禁止路线查询'
    }
    return undefined
  })
  try {
    assert.equal((await run(fixture.ctx, { ...refs, mode: 'walking' })).isError, true)
    assert.equal(fixture.calls.length, 0)
  } finally { await fixture.close() }
})

test('调用方取消和父插件卸载均中止路线，卸载注销工具与服务', async () => {
  for (const action of ['cancel', 'unload']) {
    const started = Promise.withResolvers<void>()
    const controller = new AbortController()
    const fixture = await mount({ route: async (_mode, _args, execution) => new Promise((_resolve, reject) => {
      execution.signal.addEventListener('abort', () => reject(execution.signal.reason), { once: true }); started.resolve()
    }) })
    try {
      const request = run(fixture.ctx, { ...refs, mode: 'walking' }, controller.signal)
      await started.promise
      if (action === 'cancel') controller.abort(new Error('用户取消')); else await fixture.fiber.dispose()
      assert.equal((await request).isError, true)
      if (action === 'unload') {
        assert.equal(fixture.ctx.tools.get('trip_plan_route'), undefined)
        assert.equal(fixture.ctx.get('routePlanner'), undefined)
      }
    } finally { await fixture.close() }
  }
})

test('总时限包含详情补查，超时后不会继续调用路线', async () => {
  const fixture = await mount({ records: [], config: { routeTimeoutMs: 1000 }, detail: async (_id, execution) => new Promise((_resolve, reject) => {
    execution.signal.addEventListener('abort', () => reject(execution.signal.reason), { once: true })
  }) })
  try {
    assert.equal((await run(fixture.ctx, { origin: { kind: 'poi', placeId: 'poi1' }, destination: { kind: 'poi', placeId: 'poi2' }, mode: 'walking' })).isError, true)
    assert.deepEqual(fixture.calls.map(call => call.name), [AMAP_DETAILS_TOOL])
  } finally { await fixture.close() }
})

const via = { kind: 'poi', placeId: 'middle' }
const multiStops = [refs.origin, via, { kind: 'poi', placeId: 'poi1' }, via, refs.destination]
const runMulti = (ctx: Context, stops: unknown[], signal?: AbortSignal) =>
  run(ctx, { stops, mode: 'walking' }, signal, 'trip_plan_multi_stop_route')

test('一次规划有序环线，首尾保留同一收藏 ID 并查询三段', async () => {
  const fixture = await mount({ detail: async id => ({ id, name: id, location: '113.2,23' }) })
  try {
    const output = await runMulti(fixture.ctx, [refs.origin, via, refs.destination, refs.origin])
    assert.ok(!output.isError, JSON.stringify(output))
    const value = output.value as unknown as PlanMultiStopRouteResult
    assert.deepEqual(value.stops.map(stop => stop.placeId), ['poi1', 'middle', 'poi2', 'poi1'])
    assert.ok(value.stops[0].savedPlaceId)
    assert.equal(value.stops[3].savedPlaceId, value.stops[0].savedPlaceId)
    assert.equal(value.stops[1].savedPlaceId, undefined)
    assert.deepEqual(value.legs.map(leg => leg.status), ['found', 'found', 'found'])
    assert.equal(fixture.calls.filter(call => call.name === AMAP_ROUTE_TOOLS.walking).length, 3)
  } finally { await fixture.close() }
})

test('多地点按有序端点逐段查询，复用途经点详情及收藏快照，并汇总所选方案', async () => {
  const fixture = await mount({ detail: async id => ({ id, name: id, location: '113.2,23' }) })
  try {
    const output = await runMulti(fixture.ctx, multiStops)
    assert.ok(!output.isError, JSON.stringify(output))
    const value = output.value as unknown as PlanMultiStopRouteResult
    assert.deepEqual(value.stops.map(stop => stop.placeId), ['poi1', 'middle', 'poi1', 'middle', 'poi2'])
    assert.deepEqual(value.stops.map(stop => stop.alias), ['家', null, null, null, '公司'])
    assert.deepEqual(fixture.calls, [
      { name: AMAP_DETAILS_TOOL, args: { id: 'middle' } },
      ...[['113,23', '113.2,23'], ['113.2,23', '113,23'], ['113,23', '113.2,23'], ['113.2,23', '113.1,23']].map(([origin, destination]) =>
        ({ name: AMAP_ROUTE_TOOLS.walking, args: { origin, destination } })),
    ])
    assert.equal(value.status, 'complete')
    assert.equal(value.order, 'given')
    assert.deepEqual(value.legs.map(leg => [leg.from, leg.to, leg.route?.index]), [[0, 1, 1], [1, 2, 1], [2, 3, 1], [3, 4, 1]])
    assert.equal(value.totalDurationSeconds, 3840)
    assert.equal(value.totalDistanceMeters, 4800)
  } finally { await fixture.close() }
})

test('自动顺路固定首尾，只查排序后的相邻段，Agent 文字保留乘车字段', async () => {
  const fixture = await mount({
    detail: async id => ({ id, name: id, city: '广州市', location: id === 'middle' ? '113.04,23' : '113.08,23' }),
    route: async () => transitPresentationFixture,
  })
  try {
    const stops = [refs.origin, { kind: 'poi', placeId: 'station' }, via, refs.destination]
    const query = { stops, mode: 'transit', order: 'optimized', pinStart: true, pinEnd: true }
    assert.equal((await run(fixture.ctx, { ...query, pinEnd: undefined }, undefined, 'trip_plan_multi_stop_route')).isError, true)
    assert.equal(fixture.calls.length, 0)
    const output = await run(fixture.ctx, query, undefined, 'trip_plan_multi_stop_route')
    assert.ok(!output.isError, JSON.stringify(output))
    const value = output.value as unknown as PlanMultiStopRouteResult
    assert.equal(value.order, 'optimized')
    assert.deepEqual(value.stops.map(stop => stop.placeId), ['poi1', 'middle', 'station', 'poi2'])
    assert.deepEqual(fixture.calls.map(call => call.name), [
      AMAP_DETAILS_TOOL, AMAP_DETAILS_TOOL, ...Array(3).fill(AMAP_ROUTE_TOOLS.transit),
    ])
    assert.deepEqual(fixture.calls.slice(2).map(call => call.args), [
      { origin: '113,23', destination: '113.04,23', city: '广州市', cityd: '广州市' },
      { origin: '113.04,23', destination: '113.08,23', city: '广州市', cityd: '广州市' },
      { origin: '113.08,23', destination: '113.1,23', city: '广州市', cityd: '广州市' },
    ])
    const text = output.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    assert.match(text, /按直线距离排序/)
    assert.match(text, /在坑口站乘坐 1号线（第一末站方向），乘坐 1 站，到测试换乘站下车/u)
    assert.match(text, /在测试换乘站乘坐 11号线（第二末站方向），乘坐 1 站，到天河公园站下车，从A口出站/u)
  } finally { await fixture.close() }
})

test('多地点第二段无路线或上游失败时保留第一段，余段停止，且全程总计未知', async () => {
  for (const status of ['no-route', 'query-failed']) {
    let count = 0
    const fixture = await mount({
      detail: async id => ({ id, name: id, location: '113.2,23' }),
      route: async () => {
        if (++count !== 2) return routeFixtures.walking
        if (status === 'query-failed') throw new Error('不得传播上游内部正文')
        return { route: { paths: [] } }
      },
    })
    try {
      const output = await runMulti(fixture.ctx, multiStops)
      assert.ok(!output.isError, JSON.stringify(output))
      const value = output.value as unknown as PlanMultiStopRouteResult
      assert.equal(count, 2)
      assert.equal(value.status, 'incomplete')
      assert.deepEqual(value.legs.map(leg => leg.status), ['found', status, 'not-queried', 'not-queried'])
      assert.equal(value.legs[0].route?.durationSeconds, 960)
      assert.equal(value.totalDurationSeconds, null)
      assert.equal(value.totalDistanceMeters, null)
      assert.doesNotMatch(JSON.stringify(output), /不得传播上游内部正文/)
    } finally { await fixture.close() }
  }
})

test('无效多地点在查路线前拒绝，取消后停止剩余分段', async () => {
  const started = Promise.withResolvers<void>()
  const controller = new AbortController()
  const fixture = await mount({
    detail: async id => ({ id, name: id, location: '113.2,23' }),
    route: async (_mode, _args, execution) => new Promise((_resolve, reject) => {
      execution.signal.addEventListener('abort', () => reject(execution.signal.reason), { once: true })
      started.resolve()
    }),
  })
  try {
    for (const stops of [[refs.origin, refs.destination], [...multiStops, refs.origin],
      [refs.origin, { kind: 'poi', placeId: 'poi1' }, refs.destination],
      [via, refs.destination, { kind: 'saved', alias: '找不到' }]]) {
      assert.equal((await runMulti(fixture.ctx, stops)).isError, true)
    }
    assert.equal(fixture.calls.length, 0)
    const pending = runMulti(fixture.ctx, multiStops, controller.signal)
    await started.promise
    controller.abort()
    assert.equal((await pending).isError, true)
    assert.deepEqual(fixture.calls.map(call => call.name), [AMAP_DETAILS_TOOL, AMAP_ROUTE_TOOLS.walking])
  } finally { await fixture.close() }
})
