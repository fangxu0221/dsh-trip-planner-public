/** 验证路线摘要只按来源分类，并仅合并有依据的同站步行衔接。 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeRoutePayload } from '../../src/adapters/amap-routes.ts'
import { formatDuration, formatTransfers, routeAlternatives, transitMode } from '../../packages/web/src/client/route-view.ts'
import { transitPresentationFixture } from './data/route-presentation.ts'
import { routeFixtures } from './data/routes.ts'

function result(payload: Record<string, unknown> = transitPresentationFixture) {
  const at = '2026-11-06T00:00:00.000Z'
  const origin = { placeId: 'from', name: '坑口', alias: null, address: null, city: null,
    coordinates: { longitude: 113, latitude: 23 }, detailsFetchedAt: at }
  return { ...normalizeRoutePayload(payload, 'transit', at), mode: 'transit' as const, origin,
    destination: { ...origin, placeId: 'to', name: '天河公园' } }
}

test('耗时以分钟或小时加分钟展示，保留未知值', () => {
  assert.deepEqual([null, 0, 61, 3600, 4080].map(formatDuration),
    ['耗时未知', '0 分钟', '2 分钟', '1 小时', '1 小时 8 分钟'])
})

test('同站地铁换乘合并站内步行，保留进出站步行、总耗时和来源数据', () => {
  const source = result()
  const original = structuredClone(source)
  const [inner, outdoor] = routeAlternatives(source)
  assert.deepEqual(inner.modes, ['walking', 'metro', 'walking'])
  assert.deepEqual(inner.steps.map(step => step.mode), ['walking', 'metro', 'metro', 'walking'])
  assert.equal(inner.steps[2].transferAt, '测试换乘站')
  assert.equal(inner.durationSeconds, 4080)
  assert.equal(formatTransfers(inner.transfers), '换乘 1 次')
  assert.equal(inner.fastest, true)
  assert.deepEqual(outdoor.modes, ['metro', 'walking', 'metro'])
  assert.equal(outdoor.steps[2].transferAt, undefined)
  assert.deepEqual(source, original)
})

test('同名站缺少站内依据、出现站外指引、站名不一致或备选站不一致时保留步行', () => {
  const cases = [
    (source: ReturnType<typeof result>) => {
      const step = source.routes[0].segments[2]
      step.instruction = '步行80米'
      step.walkingSteps = [{ instruction: '步行80米', distanceMeters: 80, durationSeconds: 120 }]
    },
    (source: ReturnType<typeof result>) => {
      source.routes[0].segments[2].walkingSteps!.push({ instruction: '出站过街', distanceMeters: null, durationSeconds: null })
    },
    (source: ReturnType<typeof result>) => {
      source.routes[0].segments[3].transportOptions[0].departureStop = '另一站'
    },
    (source: ReturnType<typeof result>) => {
      const options = source.routes[0].segments[3].transportOptions
      options.push({ ...options[0], departureStop: '另一站' })
    },
  ]
  for (const change of cases) {
    const source = result()
    change(source)
    const [route] = routeAlternatives(source)
    assert.deepEqual(route.modes, ['walking', 'metro', 'walking', 'metro', 'walking'])
    assert.equal(route.steps.some(step => step.transferAt), false)
  }
})

test('公交和地铁是备选时保留两条线路，缺失耗时的列表不标最快', () => {
  const [mixed] = routeAlternatives(result(routeFixtures.transit))
  assert.equal(mixed.steps[1].mode, 'mixed')
  assert.deepEqual(mixed.steps[1].segment.transportOptions.map(transitMode), ['metro', 'bus'])
  const source = result()
  source.routes[1].durationSeconds = null
  assert.ok(routeAlternatives(source).every(route => !route.fastest))
})

test('普通公交和广佛线分开标记，公交转地铁算一次换乘', () => {
  const route = routeAlternatives(result())[2]
  assert.deepEqual(route.modes, ['bus', 'metro'])
  assert.equal(formatTransfers(route.transfers), '换乘 1 次')
})

test('换乘范围沿每条备选计算，同线同方向连续乘坐不重复计数', () => {
  const line = (name: string, from: string, to: string) => ({ name: name + '(始发--末站)', type: '地铁线路',
    departure_stop: { name: from }, arrival_stop: { name: to } })
  const leg = (...buslines: ReturnType<typeof line>[]) => ({ bus: { buslines } })
  const first = leg(line('甲线', '第一站', '第二站'))
  const second = leg(line('甲线', '第二站', '第三站'), line('乙线', '第二站', '第三站'))
  const third = leg(line('乙线', '第三站', '第四站'))
  const plans = routeAlternatives(result({ transits: [
    { segments: [first, second] }, { segments: [first, second, third] },
    { segments: [first, leg(line('甲线', '第二站', '第三站'))] },
  ] }))
  assert.equal(formatTransfers(plans[0].transfers), '换乘 0–1 次')
  assert.equal(formatTransfers(plans[1].transfers), '换乘 1 次')
  assert.equal(formatTransfers(plans[2].transfers), '无需换乘')
  const source = result({ transits: [{ segments: [first, leg(line('甲线', '第二站', '第三站'))] }] })
  source.routes[0].segments[1].transportOptions[0].lineName = null
  source.routes[0].segments[1].transportOptions[0].serviceName = undefined
  assert.equal(formatTransfers(routeAlternatives(source)[0].transfers), '换乘次数未知')
})

test('公共交通摘要显示具体线路并省去步行，保留原始详情和时长', () => {
  const source = result()
  const original = structuredClone(source)
  const [metro, , bus] = routeAlternatives(source)
  assert.deepEqual(metro.summary.map(leg => leg.options), [
    [{ mode: 'metro', label: '1号线' }], [{ mode: 'metro', label: '11号线' }],
  ])
  assert.deepEqual(bus.summary.map(leg => leg.options.map(line => line.label)), [['18路', '20路'], ['广佛线']])
  assert.ok(metro.steps.some(step => step.mode === 'walking'))
  assert.equal(metro.durationSeconds, 4080)
  assert.deepEqual(source, original)
})

test('同段公交和地铁备选放在同一摘要项，缺失线路名才回退到交通方式', () => {
  const source = result(routeFixtures.transit)
  const [route] = routeAlternatives(source)
  assert.equal(route.summary.length, 1)
  assert.deepEqual(route.summary[0].options.map(line => line.mode), ['metro', 'bus'])
  const options = source.routes[0].segments.find(segment => segment.transportOptions.length)!.transportOptions
  options[0].serviceName = undefined
  options[0].lineName = null
  options[1].serviceName = ' '
  options[1].lineName = null
  assert.deepEqual(routeAlternatives(source)[0].summary[0].options, [
    { mode: 'metro', label: '地铁' }, { mode: 'bus', label: '公交' },
  ])
})

test('摘要保留支线名称，连续同线有依据才合并，换向或重新上车仍分开显示', () => {
  const line = (from: string, to: string) => ({ bus: { buslines: [{ name: '地铁３号线(起始--终点)', type: '地铁线路',
    departure_stop: { name: from }, arrival_stop: { name: to } }] } })
  const source = result({ transits: [{ segments: [line('甲', '乙'), line('乙', '丙')] }] })
  assert.deepEqual(routeAlternatives(source)[0].summary, [{ options: [{ mode: 'metro', label: '3号线' }] }])
  const after = source.routes[0].segments[1].transportOptions[0]
  after.direction = '相反方向'
  assert.equal(routeAlternatives(source)[0].summary.length, 2)
  after.direction = source.routes[0].segments[0].transportOptions[0].direction
  source.routes[0].segments.splice(1, 0, { ...result().routes[0].segments[0], instruction: '出站过街' })
  assert.equal(routeAlternatives(source)[0].summary.length, 2)
  after.serviceName = '地铁3号线(支线)'
  assert.equal(routeAlternatives(source)[0].summary[1].options[0].label, '3号线(支线)')
})

test('纯步行和非公共交通仍显示方式，缺少分段时保留可读回退', () => {
  const source = result()
  source.routes = [{ ...source.routes[0], segments: [source.routes[0].segments[0]] }]
  assert.deepEqual(routeAlternatives(source)[0].summary, [{ options: [{ mode: 'walking', label: '步行' }] }])
  source.routes[0].segments = []
  assert.deepEqual(routeAlternatives(source)[0].summary, [{ options: [{ mode: 'transit', label: '公共交通' }] }])
  const driving = { ...source, mode: 'driving' as const,
    ...normalizeRoutePayload(routeFixtures.driving, 'driving', source.fetchedAt) }
  assert.deepEqual(routeAlternatives(driving)[0].summary, [{ options: [{ mode: 'driving', label: '驾车' }] }])
})
