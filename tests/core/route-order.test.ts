/** 验证自动顺路的端点约束和稳定排序，测试坐标仅用于计算。 */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { RouteEndpoint } from '../../src/contracts/routes.ts'
import { optimizeRouteOrder } from '../../src/services/route-order.ts'

const stop = (name: string, longitude: number): RouteEndpoint => ({
  placeId: name, alias: null, name, address: null, city: null,
  coordinates: { latitude: 0, longitude }, detailsFetchedAt: '',
})
const [a, b, c, d] = [stop('A', 0), stop('B', 1), stop('C', 2), stop('D', 3)]

test('顺路排序支持开放一端或两端，等长路线优先保留输入次序', () => {
  const names = (stops: RouteEndpoint[], pinStart: boolean, pinEnd: boolean) =>
    optimizeRouteOrder(stops, { pinStart, pinEnd })?.map(point => point.name)
  assert.deepEqual(names([a, d, b, c], true, false), ['A', 'B', 'C', 'D'])
  assert.deepEqual(names([b, a, c, d], false, true), ['A', 'B', 'C', 'D'])
  assert.deepEqual(names([b, d, a, c], false, false), ['D', 'C', 'B', 'A'])
  assert.deepEqual(names([d, c, b, a], false, false), ['D', 'C', 'B', 'A'])
  assert.deepEqual(names([a, c, b, a], true, true), ['A', 'C', 'B', 'A'])
  assert.equal(names([a, stop('A2', 0), stop('A3', 0)], true, false), undefined)
})
