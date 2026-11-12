/** 用真实工具策略流水线和隔离 JSON 验证缓存，所有地图数据均来自测试注册工具。 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import * as Native from '@deepseek-ai/dsh-tool-executor-native'
import { AMAP_DETAILS_TOOL, AMAP_SEARCH_TOOL } from '../../src/adapters/amap-mcp.ts'
import * as trip from '../../src/index.ts'
import type { Config } from '../../src/config.ts'
import type { CacheRequest } from '../../src/contracts/query-cache.ts'
import { PersistentQueryCache } from '../../src/providers/query-cache.ts'
import { queryCacheDomain } from '../../src/query-cache-domain.ts'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { QueryExecution } from '../../src/services/travel-data.ts'
import { mountStorage } from './storage-helper.ts'

const place = (id: string, name = '测试地点' + id) => ({ id, name, city: '广州市', address: '测试路 ' + id, location: '113,23' })
const raw = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })

async function mount(options: { root?: string; config?: Partial<Config>;
  handler?: (kind: 'search' | 'details', args: Record<string, unknown>, execution: ToolRunContext) => Promise<ReturnType<typeof raw>> } = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(Native)
  const root = await mountStorage(ctx, options.root)
  const calls = { search: 0, details: 0 }
  for (const kind of ['search', 'details'] as const) ctx.tools.register(defineTool({
    name: kind === 'search' ? AMAP_SEARCH_TOOL : AMAP_DETAILS_TOOL, description: '缓存离线测试',
    parameters: kind === 'search' ? { keywords: { type: 'string', required: true }, city: { type: 'string', required: true }, citylimit: { type: 'boolean', required: true } }
      : { id: { type: 'string', required: true } },
    output: { schema: { type: 'json' }, render: () => [{ type: 'text', text: '测试地图结果' }] },
    async execute(args, execution) {
      calls[kind]++
      return options.handler ? options.handler(kind, args as Record<string, unknown>, execution)
        : raw(kind === 'search' ? { pois: [place('p1'), place('p2')] } : place(String(args.id)))
    },
  }))
  const fiber = ctx.plugin(trip, trip.Config({ showLifecycleLogs: false, ...options.config }))
  await fiber
  return { ctx, root, calls, fiber }
}

const execution = () => ({ signal: new AbortController().signal })

test('搜索和详情按规范条件复用，强制刷新和不同城市/数量独立，时间不冒充刚查询', async () => {
  const { ctx, calls } = await mount()
  try {
    const first = await ctx.travelData.searchPlaces({ keywords: ' 公园 ', limit: 1 }, execution())
    const second = await ctx.travelData.searchPlaces({ keywords: '公园', limit: 1 }, execution())
    assert.deepEqual(second, first)
    second.places[0].name = '调用方修改'
    assert.notEqual((await ctx.travelData.searchPlaces({ keywords: '公园', limit: 1 }, execution())).places[0].name, '调用方修改')
    assert.equal(calls.search, 1)
    await ctx.travelData.searchPlaces({ keywords: '公园', limit: 2 }, execution())
    await ctx.travelData.searchPlaces({ keywords: '公园', limit: 1, city: '佛山' }, execution())
    await ctx.travelData.searchPlaces({ keywords: '公园', limit: 1, refresh: true }, execution())
    assert.equal(calls.search, 4)
    const details = await ctx.travelData.getPlaceDetails('p1', execution())
    assert.deepEqual(await ctx.travelData.getPlaceDetails('p1', execution()), details)
    assert.equal(calls.details, 1)
    await ctx.travelData.getPlaceDetails('p1', execution(), { refresh: true })
    assert.equal(calls.details, 2)
    assert.ok(ctx.queryCache.stats().cacheHits >= 3)
  } finally { await ctx.fiber.dispose() }
})

test('重启相同 JSON 目录后仍能复用，并能本地筛选、去重、更新选择顺序', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trip-cache-restart-'))
  try {
    const first = await mount({ root })
    await first.ctx.travelData.searchPlaces({ keywords: '公园' }, execution())
    await first.ctx.travelData.getPlaceDetails('p1', execution())
    await first.ctx.fiber.dispose()
    const second = await mount({ root })
    try {
      await second.ctx.travelData.searchPlaces({ keywords: '公园' }, execution())
      await second.ctx.travelData.getPlaceDetails('p1', execution())
      assert.deepEqual(second.calls, { search: 0, details: 0 })
      const view = await second.ctx.queryCache.listCachedPlaces({ keywords: '测试路', city: '广州' }, execution().signal)
      assert.equal(view.places.length, 2)
      assert.equal(new Set(view.places.map(place => place.placeId)).size, 2)
      assert.equal((await second.ctx.queryCache.listCachedPlaces({ city: '佛山' }, execution().signal)).places.length, 0)
      await second.ctx.queryCache.touchPlace('p2', execution().signal)
      assert.equal((await second.ctx.queryCache.listCachedPlaces({}, execution().signal)).places[0].placeId, 'p2')
    } finally { await second.ctx.fiber.dispose() }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('已缓存结果仍经过前置守卫和后置策略，错误或非法响应不写入缓存', async () => {
  let failure = false
  const { ctx, calls } = await mount({ handler: async kind => raw(failure ? { status: '0' } : kind === 'search' ? { pois: [place('p1')] } : place('p1')) })
  try {
    await ctx.travelData.searchPlaces({ keywords: '公园' }, execution())
    const off = ctx.tools.guard(call => call.name === AMAP_SEARCH_TOOL ? '禁止使用缓存绕过地图权限' : undefined)
    await assert.rejects(ctx.travelData.searchPlaces({ keywords: '公园' }, execution()), /禁止使用缓存/)
    assert.equal(calls.search, 1)
    off()
    const post = ctx.on('tools/post-execute', (call, result, next) => {
      if (call.name === AMAP_SEARCH_TOOL) return Promise.resolve({ kind: 'block' as const,
        feedback: [{ type: 'text' as const, text: '后置策略拒绝' }] })
      return next()
    }, { global: true })
    await assert.rejects(ctx.travelData.searchPlaces({ keywords: '公园' }, execution()), /后置策略拒绝/)
    post()
    await ctx.queryCache.clear(execution().signal)
    failure = true
    for (let i = 0; i < 2; i++) await assert.rejects(ctx.travelData.searchPlaces({ keywords: '公园' }, execution()))
    assert.equal(calls.search, 3)
    assert.equal(ctx.queryCache.stats().entries, 0)
  } finally { await ctx.fiber.dispose() }
})

test('并发相同请求只查询一次，取消一个等待者不取消其他等待者', async () => {
  const start = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let underlying: AbortSignal | undefined
  const { ctx, calls } = await mount({ handler: async (_kind, _args, run) => {
    underlying = run.signal
    start.resolve()
    await release.promise
    run.signal.throwIfAborted()
    return raw({ pois: [place('p1')] })
  } })
  try {
    const cancelled = new AbortController()
    const a = ctx.travelData.searchPlaces({ keywords: '公园' }, { signal: cancelled.signal })
    const rejected = assert.rejects(a)
    await start.promise
    const b = ctx.travelData.searchPlaces({ keywords: '公园' }, execution())
    // 等第二条调用确实进入共用任务，避免仅测试到缓存命中。
    for (let i = 0; i < 50 && ctx.queryCache.stats().joinedRequests === 0; i++) await new Promise(resolve => setTimeout(resolve, 1))
    assert.equal(ctx.queryCache.stats().joinedRequests, 1)
    cancelled.abort()
    await rejected
    assert.equal(underlying?.aborted, false)
    release.resolve()
    assert.equal((await b).returned, 1)
    assert.equal(calls.search, 1)
  } finally { release.resolve(); await ctx.fiber.dispose() }
})

test('全部等待者取消或服务卸载会中止实际请求', async () => {
  const started = Promise.withResolvers<void>()
  let aborted = 0
  const { ctx, fiber } = await mount({ handler: async (_kind, _args, run) => {
    started.resolve()
    return new Promise((_resolve, reject) => run.signal.addEventListener('abort', () => { aborted++; reject(run.signal.reason) }, { once: true }))
  } })
  const cancel = new AbortController()
  const request = ctx.travelData.searchPlaces({ keywords: '公园' }, { signal: cancel.signal })
  const settled = assert.rejects(request)
  await started.promise
  cancel.abort()
  await settled
  assert.equal(aborted, 1)
  const another = ctx.travelData.searchPlaces({ keywords: '另一地点' }, execution())
  const stopped = assert.rejects(another)
  for (let i = 0; i < 20 && ctx.queryCache.stats().searchCalls < 2; i++) await new Promise(resolve => setTimeout(resolve, 1))
  await fiber.dispose()
  await stopped
  assert.equal(aborted, 2)
  await ctx.fiber.dispose()
})

test('过期、容量、清空及进行中的旧写入由独立缓存服务处理，不延长有效期', async () => {
  const ctx = new Context()
  await mountStorage(ctx)
  const domain = await ctx.storageDomain.open(queryCacheDomain)
  let now = Date.parse('2026-11-09T00:00:00Z')
  const config = trip.Config({ showLifecycleLogs: false, searchCacheTtlSeconds: 10, cacheMaxEntries: 1 })
  const cache = new PersistentQueryCache(ctx, domain, config, () => now)
  const request: CacheRequest = { kind: 'search', keywords: '地点', city: '广州', limit: 1 }
  const cachedPlace = { id: 'p1', name: '测试地点', address: '测试路', city: '广州市', coordinates: null }
  let loads = 0
  const load = async () => ({ response: { ok: true }, fetchedAt: new Date(now).toISOString(), contexts: [], concludesTurn: false })
  try {
    const first = await cache.obtain(request, 'public', execution().signal, false, async () => { loads++; return load() })
    await cache.store(request, first, first.response, [cachedPlace], execution().signal)
    now += 9000
    await cache.touchPlace('p1', execution().signal)
    assert.equal((await cache.obtain(request, 'public', execution().signal, false, load)).hit, true)
    now += 1001
    assert.equal((await cache.listCachedPlaces({}, execution().signal)).places.length, 0)
    assert.equal(cache.stats().entries, 0)
    const expired = await cache.obtain(request, 'public', execution().signal, false, async () => { loads++; return load() })
    await cache.store(request, expired, expired.response, [cachedPlace], execution().signal)
    const other: CacheRequest = { ...request, keywords: '另一地点' }
    now++
    const next = await cache.obtain(other, 'public', execution().signal, false, load)
    await cache.store(other, next, next.response, [{ ...cachedPlace, id: 'p2' }], execution().signal)
    assert.equal(cache.stats().entries, 1)
    assert.equal((await cache.listCachedPlaces({}, execution().signal)).places[0].placeId, 'p2')
    const late = await cache.obtain(request, 'public', execution().signal, true, load)
    await cache.clear(execution().signal)
    await cache.store(request, late, late.response, [cachedPlace], execution().signal)
    assert.equal(cache.stats().entries, 0)
    assert.equal(loads, 2)
  } finally { await cache.stop(); await domain.close(); await ctx.fiber.dispose() }
})

test('不同权限分区的进行中任务不合并', async () => {
  const { ctx } = await mount()
  try {
    const gate = Promise.withResolvers<void>()
    const request: CacheRequest = { kind: 'details', placeId: 'p1' }
    let calls = 0
    const load = async () => { calls++; await gate.promise; return { response: {}, fetchedAt: new Date().toISOString(), contexts: [], concludesTurn: false } }
    const a = ctx.queryCache.obtain(request, 'scope-a', execution().signal, false, load)
    const b = ctx.queryCache.obtain(request, 'scope-b', execution().signal, false, load)
    await Promise.resolve()
    gate.resolve()
    await Promise.all([a, b])
    assert.equal(calls, 2)
  } finally { await ctx.fiber.dispose() }
})

test('同名局部工具既不读取也不污染公共缓存', async () => {
  const { ctx, calls } = await mount()
  const agent = { id: 'cache-private-agent' } as NonNullable<QueryExecution['agent']>
  let scope: ReturnType<typeof createScope> | undefined
  try {
    const global = await ctx.travelData.searchPlaces({ keywords: '地点' }, execution())
    await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) }, { inject: ['tools', 'systemPrompt'] }))
    scope!.ctx.tools.register(defineTool({
      name: AMAP_SEARCH_TOOL, description: '局部地图测试',
      parameters: { keywords: { type: 'string', required: true }, city: { type: 'string', required: true }, citylimit: { type: 'boolean', required: true } },
      output: { schema: { type: 'json' }, render: () => [{ type: 'text', text: '局部结果' }] },
      async execute() { return raw({ pois: [place('private', '局部地点')] }) },
    }))
    const privateResult = await ctx.travelData.searchPlaces({ keywords: '地点' }, { ...execution(), agent })
    assert.equal(privateResult.places[0].name, '局部地点')
    assert.deepEqual(await ctx.travelData.searchPlaces({ keywords: '地点' }, execution()), global)
    assert.equal(calls.search, 1)
    assert.equal((await ctx.queryCache.listCachedPlaces({ keywords: '局部' }, execution().signal)).places.length, 0)
  } finally { await scope?.dispose(); await ctx.fiber.dispose() }
})

test('普通请求晚于强制刷新完成时不能覆盖新缓存，缓存写入失败不影响已查数据', async () => {
  const ctx = new Context()
  await mountStorage(ctx)
  const domain = await ctx.storageDomain.open(queryCacheDomain)
  const cache = new PersistentQueryCache(ctx, domain, trip.Config({ showLifecycleLogs: false }))
  const request: CacheRequest = { kind: 'details', placeId: 'p1' }
  const place = { id: 'p1', name: '测试地点', address: null, city: null, coordinates: null }
  const delayed = Promise.withResolvers<void>()
  const value = (version: number) => ({ response: { version }, fetchedAt: new Date().toISOString(), contexts: [], concludesTurn: false })
  try {
    const older = cache.obtain(request, 'same', execution().signal, false, async () => { await delayed.promise; return value(1) })
    const newer = await cache.obtain(request, 'same', execution().signal, true, async () => value(2))
    await cache.store(request, newer, newer.response, [place], execution().signal)
    delayed.resolve()
    const late = await older
    await cache.store(request, late, late.response, [place], execution().signal)
    assert.deepEqual((await cache.obtain(request, 'same', execution().signal, false, async () => value(3))).response, { version: 2 })
    const table = domain.table('entries')
    const put = table.put
    table.put = async () => { throw new Error('模拟磁盘写入失败') }
    try {
      const refreshed = await cache.obtain(request, 'same', execution().signal, true, async () => value(4))
      await cache.store(request, refreshed, refreshed.response, [place], execution().signal)
      assert.equal(cache.stats().writeFailures, 1)
    } finally { table.put = put }
  } finally { delayed.resolve(); await cache.stop(); await domain.close(); await ctx.fiber.dispose() }
})

test('缓存文件损坏时保留原文件并拒绝加载，不清空用户资料', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trip-cache-corrupt-'))
  try {
    const first = await mount({ root })
    await first.ctx.travelData.searchPlaces({ keywords: '地点' }, execution())
    await first.ctx.fiber.dispose()
    const path = join(root, 'trip_query_cache.json')
    const corrupt = '{ invalid cache JSON'
    await writeFile(path, corrupt)
    const ctx = new Context()
    try {
      await mountStorage(ctx, root)
      await assert.rejects(ctx.storageDomain.open(queryCacheDomain))
      assert.equal(await readFile(path, 'utf8'), corrupt)
    } finally { await ctx.fiber.dispose() }
  } finally { await rm(root, { recursive: true, force: true }) }
})
