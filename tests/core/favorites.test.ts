/** 收藏验收：真实 JSON 文件、真实工具流水线，远端只在测试中替换为受控详情响应。 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool, type ToolExecutionResult, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { AMAP_DETAILS_TOOL } from '../../src/adapters/amap-mcp.ts'
import { tripPlannerDomain, type SavedPlace } from '../../src/domain.ts'
import * as trip from '../../src/index.ts'
import { mountStorage } from './storage-helper.ts'

type Raw = { content: { type: 'text'; text: string }[] }
const raw = (data: unknown): Raw => ({ content: [{ type: 'text', text: JSON.stringify(data) }] })

async function mount(root: string, handler?: (id: string, execution: ToolRunContext) => Promise<Raw>, external = true) {
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeExecutor)
    await mountStorage(ctx, root)
    const calls: string[] = []
    if (external) ctx.tools.register(defineTool({
      name: AMAP_DETAILS_TOOL, description: '测试用高德详情', parameters: { id: { type: 'string', required: true } },
      output: { schema: { type: 'json' }, render: () => [{ type: 'text', text: '测试详情' }] },
      async execute(args, execution) {
        calls.push(args.id)
        return handler ? handler(args.id, execution) : raw({ id: args.id, name: '测试公园 ' + args.id,
          address: '公园路 1 号', city: '广州市', location: '113.324521,23.106428' })
      },
    }))
    const fiber = ctx.plugin(trip, trip.Config({ showLifecycleLogs: false, cacheEnabled: false }))
    await fiber
    assert.ok(ctx.get('savedPlaces'), '恢复成功后才提供收藏服务')
    return { ctx, fiber, calls }
  } catch (error) { await ctx.fiber.dispose(); throw error }
}

async function execute(ctx: Context, name: string, args: Record<string, unknown> = {}, signal = new AbortController().signal): Promise<ToolExecutionResult> {
  const batch = await ctx.tools.execute({ calls: [{ type: 'tool-call', id: ToolCallId('favorite-' + crypto.randomUUID()), name, arguments: JSON.stringify(args) }], signal })
  assert.ok(batch.results[0])
  return batch.results[0].result
}

function success(result: ToolExecutionResult): Record<string, unknown> {
  assert.ok(!result.isError, JSON.stringify(result))
  return result.value as unknown as Record<string, unknown>
}

/** 每个测试自有临时目录，失败也清理；不访问用户真实收藏。 */
async function directory(): Promise<string> { return mkdtemp(join(tmpdir(), 'trip-favorites-case-')) }

test('收藏变更只通知成功写入，拒绝旧页面操作复用的别名', async () => {
  const root = await directory()
  const { ctx } = await mount(root)
  let changes = 0
  ctx.on('trip/saved-places-changed', () => { changes++ })
  const signal = new AbortController().signal
  try {
    const original = await ctx.savedPlaces.save({ placeId: 'poi1', alias: '学校' }, { signal })
    await ctx.savedPlaces.save({ placeId: 'poi1', alias: '另一名称' }, { signal })
    await ctx.savedPlaces.rename('学校', '学校')
    assert.equal(changes, 1)

    const file = join(root, 'trip_planner.json')
    const backup = file + '.test-backup'
    await rename(file, backup)
    await mkdir(file)
    try {
      await assert.rejects(ctx.savedPlaces.rename('学校', '无法写入'))
      assert.equal(changes, 1)
      assert.equal((await ctx.savedPlaces.get('学校'))?.id, original.place.id)
    } finally {
      await rmdir(file)
      await rename(backup, file)
    }

    const edit = { expectedId: original.place.id, signal }
    await ctx.savedPlaces.remove('学校', edit)
    const replacement = await ctx.savedPlaces.save({ placeId: 'poi2', alias: '学校' }, { signal })
    await assert.rejects(ctx.savedPlaces.rename('学校', '旧页改名', edit), { code: 'TRIP_SAVED_PLACE_CHANGED' })
    await assert.rejects(ctx.savedPlaces.remove('学校', edit), { code: 'TRIP_SAVED_PLACE_CHANGED' })
    assert.equal((await ctx.savedPlaces.get('学校'))?.id, replacement.place.id)
    assert.equal(changes, 3)
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('五个工具完成收藏→卸载重开→查看→改名→删除→重开，坐标和地区一起展示', async () => {
  const root = await directory()
  let current: Awaited<ReturnType<typeof mount>> | undefined
  try {
    current = await mount(root)
    const result = await execute(current.ctx, 'trip_save_place', { placeId: 'poi1', alias: ' 学校 ' })
    const saved = success(result)
    assert.equal(saved.created, true)
    const place = saved.place as SavedPlace
    assert.equal(place.alias, '学校')
    assert.ok(result.content.some(item => item.type === 'text' && /广州市.*经度：113.324521.*纬度：23.106428/u.test(item.text)))
    const disk = JSON.parse(await readFile(join(root, 'trip_planner.json'), 'utf8'))
    assert.ok(JSON.stringify(disk).includes(place.id))
    await current.ctx.fiber.dispose()
    current = await mount(root, undefined, false)
    const found = success(await execute(current.ctx, 'trip_get_saved_place', { alias: '学校' }))
    assert.equal((found.place as SavedPlace).id, place.id)
    assert.equal(success(await execute(current.ctx, 'trip_list_saved_places')).returned, 1)
    const renamed = success(await execute(current.ctx, 'trip_rename_saved_place', { alias: '学校', newAlias: '大学' }))
    assert.equal(renamed.id, place.id)
    assert.equal(renamed.createdAt, place.createdAt)
    assert.equal(renamed.fetchedAt, place.fetchedAt)
    assert.equal(success(await execute(current.ctx, 'trip_get_saved_place', { alias: '学校' })).found, false)
    assert.equal(success(await execute(current.ctx, 'trip_remove_saved_place', { alias: '大学' })).removed, true)
    assert.equal(success(await execute(current.ctx, 'trip_remove_saved_place', { alias: '大学' })).removed, false)
    await current.ctx.fiber.dispose()
    current = await mount(root, undefined, false)
    assert.equal(success(await execute(current.ctx, 'trip_list_saved_places')).returned, 0)
    assert.equal(current.calls.length, 0)
  } finally { await current?.ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})

test('重复收藏不重复写入、不隐式改名、不再次请求；别名规范化冲突不覆盖', async () => {
  const root = await directory()
  const { ctx, calls } = await mount(root)
  try {
    const saved = await ctx.savedPlaces.save({ placeId: 'poi1', alias: 'Ｃａｆｅ' }, { signal: new AbortController().signal })
    const bytes = await readFile(join(root, 'trip_planner.json'), 'utf8')
    const again = await ctx.savedPlaces.save({ placeId: 'poi1', alias: '另一个别名' }, { signal: new AbortController().signal })
    assert.equal(again.created, false)
    assert.deepEqual(again.place, saved.place)
    assert.equal(await readFile(join(root, 'trip_planner.json'), 'utf8'), bytes)
    const collision = await execute(ctx, 'trip_save_place', { placeId: 'poi2', alias: ' cafe ' })
    assert.ok(collision.isError)
    assert.equal(collision.error.info?.code, 'TRIP_ALIAS_CONFLICT')
    assert.deepEqual(calls, ['poi1'])
    assert.equal((await ctx.savedPlaces.get('CAFE'))?.id, saved.place.id)
    const copy = await ctx.savedPlaces.get('cafe')
    if (copy?.coordinates) copy.coordinates.latitude = 1
    assert.equal((await ctx.savedPlaces.get('cafe'))?.coordinates?.latitude, 23.106428)
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})

test('并发收藏只允许一个别名归属；并发保存同地点仅请求一次；冲突后队列继续工作', async () => {
  const root = await directory()
  const { ctx, calls } = await mount(root)
  const execution = { signal: new AbortController().signal }
  try {
    const outcomes = await Promise.allSettled([
      ctx.savedPlaces.save({ placeId: 'poi1', alias: '家' }, execution),
      ctx.savedPlaces.save({ placeId: 'poi2', alias: '家' }, execution),
    ])
    assert.deepEqual(outcomes.map(value => value.status), ['fulfilled', 'rejected'])
    const same = await Promise.all([
      ctx.savedPlaces.save({ placeId: 'poi2', alias: '公司' }, execution),
      ctx.savedPlaces.save({ placeId: 'poi2', alias: '办公室' }, execution),
    ])
    assert.equal(same[0].created, true)
    assert.equal(same[1].created, false)
    assert.equal(same[0].place.id, same[1].place.id)
    assert.deepEqual(calls, ['poi1', 'poi2'])
    await assert.rejects(ctx.savedPlaces.rename('公司', '家'), /已被其他地点使用/u)
    assert.equal((await ctx.savedPlaces.list()).length, 2)
    assert.equal((await ctx.savedPlaces.rename('公司', '办公地点')).alias, '办公地点')
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})

test('空别名、非法类型、空 ID 不调用外部工具；详情错误/错 ID/非法坐标不保存', async () => {
  const root = await directory()
  let response: unknown = { status: '0' }
  const { ctx, calls } = await mount(root, async () => raw(response))
  try {
    for (const args of [{ alias: ' ', placeId: 'id' }, { alias: 12, placeId: 'id' }, { alias: '家', placeId: '' }, { alias: 'a'.repeat(51), placeId: 'id' }]) {
      assert.equal((await execute(ctx, 'trip_save_place', args)).isError, true)
    }
    assert.equal(calls.length, 0)
    for (const invalid of [{ status: '0' }, { id: 'wrong', name: '错误地点' }, { id: 'poi1', name: '公园', location: '181,23' }, { pois: [] }]) {
      response = invalid
      assert.equal((await execute(ctx, 'trip_save_place', { alias: '家', placeId: 'poi1' })).isError, true)
      assert.equal((await ctx.savedPlaces.list()).length, 0)
    }
    response = { id: 'poi1', name: '来源缺少可选字段' }
    const saved = success(await execute(ctx, 'trip_save_place', { alias: '家', placeId: 'poi1' })).place as SavedPlace
    assert.equal(saved.coordinates, null)
    assert.equal(saved.city, null)
    assert.equal(saved.address, null)
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})

test('嵌套详情受权限守卫约束，不越权保存、不绕过 root/parent 关联', async () => {
  const root = await directory()
  const { ctx, calls } = await mount(root)
  let outer: { token: unknown; rootCallId: unknown } | undefined
  ctx.tools.guard(execution => {
    if (execution.name === 'trip_save_place') outer = execution
    if (execution.name === AMAP_DETAILS_TOOL) {
      assert.ok(outer)
      assert.equal(execution.parent, outer.token)
      assert.equal(execution.rootCallId, outer.rootCallId)
      return '测试策略不允许查询详情'
    }
    return undefined
  })
  try {
    assert.equal((await execute(ctx, 'trip_save_place', { placeId: 'poi1', alias: '家' })).isError, true)
    assert.equal(calls.length, 0)
    assert.equal((await ctx.savedPlaces.list()).length, 0)
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})

test('卸载会中止详情；卸载后工具和服务注销，重开仍为空', async () => {
  const root = await directory()
  const started = Promise.withResolvers<void>()
  const { ctx, fiber } = await mount(root, async (_id, execution) => new Promise((_resolve, reject) => {
    execution.signal.addEventListener('abort', () => reject(execution.signal.reason), { once: true })
    started.resolve()
  }))
  try {
    const pending = execute(ctx, 'trip_save_place', { placeId: 'poi1', alias: '家' })
    await started.promise
    await fiber.dispose()
    assert.equal((await pending).isError, true)
    assert.equal(ctx.tools.get('trip_save_place'), undefined)
    assert.equal(ctx.get('savedPlaces'), undefined)
    const domain = await ctx.storageDomain.open(tripPlannerDomain)
    assert.equal(domain.table('favorites').size, 0)
    await domain.close()
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})

test('损坏 JSON 导致领域打开失败，不会被清空重写', async () => {
  const root = await directory()
  const ctx = new Context()
  const corrupt = '{ broken json'
  try {
    await writeFile(join(root, 'trip_planner.json'), corrupt)
    await mountStorage(ctx, root)
    await assert.rejects(ctx.storageDomain.open(tripPlannerDomain))
    assert.equal(await readFile(join(root, 'trip_planner.json'), 'utf8'), corrupt)
    assert.equal(ctx.get('savedPlaces'), undefined)
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})

test('调用方取消会传到详情请求；取消后不保存，服务仍可继续使用', async () => {
  const root = await directory()
  const started = Promise.withResolvers<void>()
  const controller = new AbortController()
  const { ctx } = await mount(root, async (_id, execution) => new Promise((_resolve, reject) => {
    execution.signal.addEventListener('abort', () => reject(execution.signal.reason), { once: true })
    started.resolve()
  }))
  try {
    const pending = execute(ctx, 'trip_save_place', { placeId: 'poi1', alias: '家' }, controller.signal)
    await started.promise
    controller.abort(new Error('用户取消'))
    assert.equal((await pending).isError, true)
    assert.equal((await ctx.savedPlaces.list()).length, 0)
    assert.equal((await ctx.savedPlaces.remove('家')).removed, false)
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})

test('历史记录 schema 不合法时拒绝读取，保留原文件供排查', async () => {
  const root = await directory()
  let first: Awaited<ReturnType<typeof mount>> | undefined
  const second = new Context()
  try {
    first = await mount(root)
    await first.ctx.savedPlaces.save({ placeId: 'poi1', alias: '家' }, { signal: new AbortController().signal })
    await first.ctx.fiber.dispose()
    const path = join(root, 'trip_planner.json')
    const saved = JSON.parse(await readFile(path, 'utf8')) as { tables: { favorites: Record<string, { coordinates: unknown }> } }
    const item = Object.values(saved.tables.favorites)[0]
    assert.ok(item)
    item.coordinates = { longitude: 190, latitude: 23 }
    const invalid = JSON.stringify(saved)
    await writeFile(path, invalid)
    await mountStorage(second, root)
    await assert.rejects(second.storageDomain.open(tripPlannerDomain), /invalid|validation|schema/i)
    assert.equal(await readFile(path, 'utf8'), invalid)
  } finally { await first?.ctx.fiber.dispose(); await second.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})
