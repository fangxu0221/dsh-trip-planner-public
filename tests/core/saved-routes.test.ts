/** 使用真实 JSON 领域测试常用路线写入、恢复和收藏引用。 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rename, rm, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { SavedRouteEndpoint, SaveRouteInput } from '../../src/contracts/saved-routes.ts'
import type { SavedPlace } from '../../src/domain.ts'
import * as savedRoutes from '../../src/providers/saved-routes.ts'
import { mountStorage } from './storage-helper.ts'

const signal = new AbortController().signal
const poi = (placeId: string): SavedRouteEndpoint => ({ kind: 'poi', placeId, label: '地点 ' + placeId })
const input: SaveRouteInput = { name: '上学', origin: poi('origin'), destination: poi('destination'), mode: 'walking' }

async function mount(root: string, places: SavedPlace[] = []) {
  const ctx = new Context()
  try {
    await mountStorage(ctx, root)
    ctx.provide('savedPlaces', { list: async () => places })
    await ctx.plugin(savedRoutes)
    return ctx
  } catch (error) { await ctx.fiber.dispose(); throw error }
}

async function temporary(t: { after: (clean: () => Promise<void>) => void }): Promise<string> {
  const parent = await realpath(tmpdir())
  const root = await mkdtemp(join(parent, 'trip-saved-routes-'))
  t.after(async () => {
    if (dirname(await realpath(root)) === parent) await rm(root, { recursive: true, force: true })
  })
  return root
}

test('常用路线保存后重开 JSON 可恢复，改名、删改只影响对应 ID', async t => {
  const root = await temporary(t)
  let ctx = await mount(root)
  try {
    const saved = await ctx.savedRoutes.save(input, signal)
    await ctx.fiber.dispose()
    ctx = await mount(root)
    assert.deepEqual(await ctx.savedRoutes.list(), [saved])
    const renamed = await ctx.savedRoutes.rename(saved.id, '上课路线', signal)
    assert.equal(renamed.id, saved.id)
    assert.equal(renamed.name, '上课路线')
    const repaired = await ctx.savedRoutes.updateEndpoints(saved.id, { origin: poi('new-origin'), destination: saved.destination }, signal)
    assert.equal(repaired.name, renamed.name)
    assert.equal(repaired.mode, saved.mode)
    assert.deepEqual(repaired.origin, poi('new-origin'))
    await ctx.savedRoutes.remove(saved.id, signal)
    await ctx.fiber.dispose()
    ctx = await mount(root)
    assert.deepEqual(await ctx.savedRoutes.list(), [])
  } finally { await ctx.fiber.dispose() }
})

test('并发重名仅保存一条，写入失败或取消不推送变更', async t => {
  const root = await temporary(t)
  const ctx = await mount(root)
  try {
    let changes = 0
    ctx.on('trip/saved-routes-changed', () => { changes++ })
    const jobs = await Promise.allSettled([
      ctx.savedRoutes.save({ ...input, name: '通勤 Ａ' }, signal),
      ctx.savedRoutes.save({ ...input, name: ' 通勤 a ' }, signal),
    ])
    assert.equal(jobs.filter(job => job.status === 'fulfilled').length, 1)
    const failed = jobs.find(job => job.status === 'rejected')
    assert.equal(failed?.reason.code, 'TRIP_SAVED_ROUTE_NAME_CONFLICT')
    const [route] = await ctx.savedRoutes.list()
    assert.equal(route.name, '通勤 A')
    await assert.rejects(ctx.savedRoutes.rename(route.id, '已取消', AbortSignal.abort()), { name: 'AbortError' })
    const file = join(root, 'trip_saved_routes.json')
    await rename(file, file + '.backup')
    await mkdir(file)
    try {
      await assert.rejects(ctx.savedRoutes.rename(route.id, '写入失败', signal))
      assert.deepEqual(await ctx.savedRoutes.list(), [route])
    } finally {
      await rmdir(file)
      await rename(file + '.backup', file)
    }
    assert.equal(changes, 1)
    assert.equal((await ctx.savedRoutes.rename(route.id, '写入恢复', signal)).name, '写入恢复')
    assert.equal(changes, 2)
  } finally { await ctx.fiber.dispose() }
})

test('环线和开放多地点路线保留途经点顺序，兼容旧记录和旧端点更新', async t => {
  const root = await temporary(t)
  let ctx = await mount(root)
  try {
    const old = await ctx.savedRoutes.save(input, signal)
    const waypoints = [poi('park'), poi('temple')]
    const loop = await ctx.savedRoutes.save({ ...input, name: '环线', waypoints, destination: input.origin }, signal)
    const open = await ctx.savedRoutes.save({ ...input, name: '多地点', waypoints }, signal)
    await assert.rejects(ctx.savedRoutes.save({ ...input, name: '相邻重复', waypoints: [input.origin] }, signal),
      { code: 'TRIP_INVALID_SAVED_ROUTE' })
    await ctx.fiber.dispose()
    ctx = await mount(root)
    const restored = await ctx.savedRoutes.list()
    assert.deepEqual(restored.find(route => route.id === old.id), old)
    assert.deepEqual(restored.find(route => route.id === loop.id), loop)
    assert.deepEqual(restored.find(route => route.id === open.id), open)
    const update = await ctx.savedRoutes.updateEndpoints(loop.id, { origin: input.origin, destination: input.origin }, signal)
    assert.deepEqual(update.waypoints, waypoints)
  } finally { await ctx.fiber.dispose() }
})

test('收藏改名保留稳定引用，删除后同名收藏不能替代原端点', async t => {
  const place: SavedPlace = { id: randomUUID(), alias: '学校', source: 'AMAP', placeId: 'school', name: '测试学校',
    address: null, city: null, coordinates: null, fetchedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
  const places = [place]
  const ctx = await mount(await temporary(t), places)
  try {
    const saved = await ctx.savedRoutes.save({ ...input, origin: { kind: 'saved', savedPlaceId: place.id, label: '旧名称' } }, signal)
    assert.deepEqual(saved.origin, { kind: 'saved', savedPlaceId: place.id, label: '学校 · 测试学校' })
    places[0] = { ...place, alias: '新校区' }
    await assert.rejects(ctx.savedRoutes.updateEndpoints(saved.id, { origin: saved.origin, destination: poi('school') }, signal),
      { code: 'TRIP_INVALID_SAVED_ROUTE' })
    places[0] = { ...place, id: randomUUID(), placeId: 'replacement' }
    await assert.rejects(ctx.savedRoutes.updateEndpoints(saved.id, { origin: saved.origin, destination: saved.destination }, signal),
      { code: 'TRIP_SAVED_ROUTE_ENDPOINT_MISSING' })
    assert.deepEqual(await ctx.savedRoutes.list(), [saved])
  } finally { await ctx.fiber.dispose() }
})
