/** 地点推荐的工具与执行约束回归；模拟模型决策不等同真实模型行为评测。 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineTool, type ToolExecution, type ToolExecutionInput, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'
import * as Native from '@deepseek-ai/dsh-tool-executor-native'
import { AMAP_DETAILS_TOOL, AMAP_ROUTE_TOOLS, AMAP_SEARCH_TOOL } from '../../src/adapters/amap-mcp.ts'
import type { Config } from '../../src/config.ts'
import type { PlacesSearchResult, PlaceDetailsResult } from '../../src/contracts/travel.ts'
import * as trip from '../../src/index.ts'
import { mountStorage } from './storage-helper.ts'

type Agent = NonNullable<ToolExecution['agent']>
const agent = (id: string) => ({ id, session: { id } }) as unknown as Agent
const signal = () => new AbortController().signal
const raw = (data: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] })
const place = (id: string) => ({ id, name: '测试地点' + id, address: '测试路', city: '广州',
  location: (113 + Number(id.replace(/\D/gu, '') || 1) / 100) + ',23', rating: '仅测试原始额外字段', opentime: '仅测试原始额外字段' })

async function mount(config: Partial<Config> = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(Native)
  await mountStorage(ctx)
  const calls = { search: 0, details: 0, route: 0 }
  const text = { type: 'string', required: true } as const
  ctx.tools.register(defineTool({ name: AMAP_SEARCH_TOOL, description: '模拟搜索',
    parameters: { keywords: text, city: text, citylimit: { type: 'boolean', required: true } },
    output: { schema: { type: 'json' }, render: () => [{ type: 'text', text: '模拟搜索' }] },
    async execute() { calls.search++; return raw({ pois: Array.from({ length: 10 }, (_, i) => place('p' + (i + 1))) }) },
  }))
  ctx.tools.register(defineTool({ name: AMAP_DETAILS_TOOL, description: '模拟详情', parameters: { id: text },
    output: { schema: { type: 'json' }, render: () => [{ type: 'text', text: '模拟详情' }] },
    async execute(args) { calls.details++; return raw(place(args.id)) },
  }))
  ctx.tools.register(defineTool({ name: AMAP_ROUTE_TOOLS.walking, description: '模拟步行', parameters: { origin: text, destination: text },
    output: { schema: { type: 'json' }, render: () => [{ type: 'text', text: '模拟步行' }] },
    async execute() { calls.route++; return raw({ route: { paths: [{ distance: '1000', duration: '600', steps: [] }] } }) },
  }))
  const fiber = ctx.plugin(trip, trip.Config({ showLifecycleLogs: false, ...config }))
  await fiber
  return { ctx, calls, fiber }
}

async function invoke(ctx: Context, name: string, args: unknown, owner?: Agent,
  parent?: ToolExecutionInput['parent'], callId = ToolCallId(randomUUID())): Promise<ToolExecutionResult> {
  const pipeline = new ToolExecutionPipeline(ctx)
  const input: ToolExecutionInput = { callId, name, arguments: args, signal: signal(), agent: owner, parent }
  const prepared = await pipeline.prepare(input)
  return pipeline.complete(prepared.exec, prepared.kind === 'dispatch' ? await pipeline.dispatch(prepared.exec) : prepared)
}
const step = (ctx: Context, owner: Agent, turn: number) => ctx.waterfall('agent/pre-step', { agent: owner, turn,
  step: 1, messages: [], signal: signal(), modelSelection: { provider: 'offline', model: 'fixture' } },
  () => Promise.resolve({ kind: 'reject' as const }))

test('多地点共享详情及路线预算，额度不足时报告当前进度', async () => {
  const { ctx, calls } = await mount({ agentMaxDetailCallsPerTurn: 2, agentMaxRouteCallsPerTurn: 1 })
  const owner = agent('multi-budget')
  const stops = ['p1', 'p2', 'p3'].map(placeId => ({ kind: 'poi', placeId }))
  try {
    await step(ctx, owner, 1)
    const first = await invoke(ctx, 'trip_plan_multi_stop_route', { stops, mode: 'walking' }, owner)
    assert.equal(first.isError, true)
    assert.equal(first.error?.info?.code, 'TRIP_AGENT_QUERY_BUDGET')
    assert.match(JSON.stringify(first.content), /已确认 2 个地点/)
    assert.deepEqual(calls, { search: 0, details: 2, route: 0 })
    await step(ctx, owner, 2)
    const second = await invoke(ctx, 'trip_plan_multi_stop_route', { stops, mode: 'walking' }, owner)
    assert.ok(!second.isError, JSON.stringify(second))
    assert.match(JSON.stringify(second.content), /实际高德调用已达到 1 次上限/)
    assert.deepEqual(calls, { search: 0, details: 3, route: 1 })
  } finally { await ctx.fiber.dispose() }
})

test('搜索工具把当前数量上限暴露为枚举，省略使用默认，非法数量在请求前拒绝', async () => {
  for (const maxResults of [3, 8]) {
    const { ctx, calls } = await mount({ maxResults })
    try {
      const parameters = ctx.tools.get('trip_search_places')!.parameters as { properties: Record<string, unknown> }
      const limit = parameters.properties.limit as { enum: number[]; description: string }
      assert.deepEqual(limit.enum, Array.from({ length: maxResults }, (_, i) => i + 1))
      assert.match(limit.description, new RegExp('默认 ' + maxResults))
      for (const invalid of [0, maxResults + 1, 1.5, '5']) {
        assert.equal((await invoke(ctx, 'trip_search_places', { keywords: '景点', limit: invalid })).isError, true)
      }
      assert.equal(calls.search, 0)
      const response = await invoke(ctx, 'trip_search_places', { keywords: '景点' })
      assert.equal(response.isError, false)
      assert.equal((response.value as unknown as PlacesSearchResult).returned, maxResults)
    } finally { await ctx.fiber.dispose() }
  }
})

test('只读详情工具复用缓存，字段限于基本信息，刷新和卸载行为明确', async () => {
  const { ctx, calls, fiber } = await mount()
  try {
    const first = await invoke(ctx, 'trip_get_place_details', { placeId: 'p1' })
    assert.equal(first.isError, false)
    const value = first.value as unknown as PlaceDetailsResult
    assert.deepEqual(Object.keys(value.place).sort(), ['address', 'city', 'coordinates', 'id', 'name'])
    assert.ok(first.content.some(block => block.type === 'text' && block.text.includes('原查询时间')))
    const second = await invoke(ctx, 'trip_get_place_details', { placeId: 'p1' })
    assert.deepEqual(second.value, first.value)
    assert.equal(calls.details, 1)
    assert.equal((await invoke(ctx, 'trip_get_place_details', { placeId: 'p1', refresh: true })).isError, false)
    assert.equal(calls.details, 2)
    for (const args of [{}, { placeId: '' }, { placeId: 12 }]) assert.equal((await invoke(ctx, 'trip_get_place_details', args)).isError, true)
    assert.equal(calls.details, 2)
    await fiber.dispose()
    assert.equal(ctx.tools.get('trip_get_place_details'), undefined)
    // 原始地图工具仍在，只释放本插件拥有的工具、守卫与服务。
    assert.equal((await invoke(ctx, AMAP_DETAILS_TOOL, { id: 'p1' }, agent('after-dispose'))).isError, false)
  } finally { await ctx.fiber.dispose() }
})

test('Agent 直接调用底层能力及伪造父调用或名称前缀都不能绕过入口', async () => {
  const { ctx, calls } = await mount()
  const owner = agent('direct')
  try {
    await step(ctx, owner, 1)
    for (const parent of [undefined, Symbol('run_code') as ToolExecutionInput['parent']]) {
      for (const [name, args, target] of [
        [AMAP_SEARCH_TOOL, { keywords: '景点', city: '广州', citylimit: true }, 'trip_search_places'],
        [AMAP_DETAILS_TOOL, { id: 'p1' }, 'trip_get_place_details'],
        [AMAP_ROUTE_TOOLS.walking, { origin: '113,23', destination: '114,23' }, 'trip_plan_route'],
      ] as const) {
        const response = await invoke(ctx, name, args, owner, parent, ToolCallId('trip-amap-' + randomUUID()))
        assert.equal(response.isError, true)
        assert.ok(JSON.stringify(response.content).includes(target))
      }
    }
    assert.deepEqual(calls, { search: 0, details: 0, route: 0 })
    assert.equal((await invoke(ctx, 'trip_get_place_details', { placeId: 'p1' }, owner)).isError, false)
    assert.equal(calls.details, 1)
  } finally { await ctx.fiber.dispose() }
})

test('每轮搜索预算只计算实际请求，缓存仍可命中，新轮次和另一会话独立', async () => {
  const { ctx, calls } = await mount({ agentMaxSearchCallsPerTurn: 2 })
  const owner = agent('budget-a')
  try {
    await step(ctx, owner, 1)
    for (const keywords of ['景点', '景点', '公园']) {
      assert.equal((await invoke(ctx, 'trip_search_places', { keywords }, owner)).isError, false)
    }
    assert.equal(calls.search, 2)
    assert.equal((await invoke(ctx, 'trip_search_places', { keywords: '博物馆' }, owner)).isError, true)
    assert.equal(calls.search, 2)
    assert.equal((await invoke(ctx, 'trip_search_places', { keywords: '景点' }, owner)).isError, false, '预算耗尽后仍可复用缓存')
    await step(ctx, owner, 2)
    assert.equal((await invoke(ctx, 'trip_search_places', { keywords: '博物馆' }, owner)).isError, false)
    const other = agent('budget-b')
    await step(ctx, other, 1)
    assert.equal((await invoke(ctx, 'trip_search_places', { keywords: '另一会话' }, other)).isError, false)
    assert.equal(calls.search, 4)
  } finally { await ctx.fiber.dispose() }
})

test('详情和路线预算分别计数，内部补查复用详情缓存，界面调用不套用 Agent 轮次上限', async () => {
  const { ctx, calls } = await mount({ agentMaxDetailCallsPerTurn: 2, agentMaxRouteCallsPerTurn: 2 })
  const owner = agent('route-budget')
  const args = { origin: { kind: 'poi', placeId: 'p1' }, destination: { kind: 'poi', placeId: 'p2' }, mode: 'walking' }
  try {
    await step(ctx, owner, 1)
    for (const placeId of ['p1', 'p2']) assert.equal((await invoke(ctx, 'trip_get_place_details', { placeId }, owner)).isError, false)
    assert.equal((await invoke(ctx, 'trip_get_place_details', { placeId: 'p3' }, owner)).isError, true)
    for (let i = 0; i < 2; i++) assert.equal((await invoke(ctx, 'trip_plan_route', args, owner)).isError, false)
    assert.equal((await invoke(ctx, 'trip_plan_route', args, owner)).isError, true)
    assert.deepEqual(calls, { search: 0, details: 2, route: 2 })
    assert.equal((await invoke(ctx, 'trip_plan_route', args)).isError, false)
    assert.equal(calls.route, 3)
  } finally { await ctx.fiber.dispose() }
})

test('地点推荐提示词实际进入官方组装，写明默认不查详情与停止条件', async () => {
  const { ctx, fiber } = await mount({ maxResults: 3 })
  try {
    const sections = (await ctx.systemPrompt.assemble()).sections
    const policy = sections.find(section => section.name === 'trip-planner:place-policy')!
    assert.ok(policy)
    assert.match(policy.text, /默认返回 3 个/)
    assert.match(policy.text, /宽泛推荐默认不查询详情/)
    assert.match(policy.text, /已有足够候选就先回复/)
    assert.match(policy.text, /不要用 run_code/)
    await fiber.dispose()
    assert.equal((await ctx.systemPrompt.assemble()).sections.some(section => section.name === policy.name), false)
  } finally { await ctx.fiber.dispose() }
})

test('配置允许关闭入口约束及预算，原有权限守卫仍然生效', async () => {
  const { ctx, calls } = await mount({ requireTripToolsForAgent: false, agentQueryBudgetEnabled: false })
  const owner = agent('configured')
  try {
    await step(ctx, owner, 1)
    assert.equal((await invoke(ctx, AMAP_SEARCH_TOOL, { keywords: '直接查询', city: '广州', citylimit: true }, owner)).isError, false)
    for (const keywords of ['一', '二', '三']) assert.equal((await invoke(ctx, 'trip_search_places', { keywords }, owner)).isError, false)
    assert.equal(calls.search, 4)
    ctx.tools.guard(call => call.name === AMAP_SEARCH_TOOL ? '其他权限守卫仍拒绝' : undefined)
    assert.equal((await invoke(ctx, 'trip_search_places', { keywords: '四' }, owner)).isError, true)
    assert.equal(calls.search, 4)
  } finally { await ctx.fiber.dispose() }
})
