/** Fake Fixture：仅注册本地工具并提供可重现的高德 MCP 响应。 */
import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { setTimeout as delay } from 'node:timers/promises'
import { registerFakeAmap, routeFixtures } from '../../tests/core/data/routes.ts'
import { AMAP_DETAILS_TOOL, AMAP_REGION_TOOL, AMAP_ROUTE_TOOLS, AMAP_SEARCH_TOOL } from '../../src/adapters/amap-mcp.ts'
import type { Config } from '../../src/config.ts'
import { savedPlaceSchema, tripPlannerDomain } from '../../src/domain.ts'

const city = '广州市'
const district = '天河区'
function poi(id: string, name: string, longitude: number, type: string, area: string | null = district) {
  return { id: 'fake-' + id, name, location: longitude + ',23.1', address: '模拟' + (area ?? '展示区') + id + '号',
    type, cityname: city, adname: area }
}

const landmarks = [
  poi('a', '模拟南门', 113.31, '风景名胜', '越秀区'),
  poi('b', '模拟展馆', 113.34, '展览馆'),
  poi('c', '模拟广场', 113.32, '广场'),
  poi('d', '模拟北门', 113.35, '风景名胜'),
]
export const aliases = ['南门', '展馆', '广场', '北门']
const parks = [
  poi('p1', '模拟云杉公园', 113.315, '公园'),
  poi('p2', '模拟白鹭公园', 113.325, '公园', '海珠区'),
  poi('p3', '模拟湖滨公园', 113.335, '公园'),
  poi('p4', '模拟湖滨公园', 113.36, '公园', '荔湾区'),
]
const culture = [
  poi('m1', '模拟铁路博物馆', 113.319, '博物馆;铁路博物馆'),
  poi('m2', '模拟机械博物馆', 113.329, '博物馆;工业遗产'),
  poi('m3', '模拟机车博物馆', 113.339, '博物馆;铁路博物馆'),
  poi('m4', '模拟锅炉博物馆', 113.349, '博物馆;工业遗产'),
  poi('m5', '模拟铁路商场', 113.352, '博物馆;铁路博物馆;商场'),
  poi('m6', '模拟旧厂博物馆', 113.355, '博物馆;工业遗产', '荔湾区'),
  poi('m7', '模拟通信博物馆', 113.357, '博物馆;铁路博物馆', '海珠区'),
]
const unknown = poi('unknown', '模拟工业遗产陈列馆', 113.361, '博物馆;工业遗产', null)
const all = [...landmarks, ...parks, ...culture, unknown]

export const fixtures = {
  normal: {},
  'search-timeout': { queryTimeoutMs: 1000 },
  'detail-error': {},
  'region-missing': {},
  'few-candidates': { agentMaxSearchCallsPerTurn: 3 },
  'no-route': {},
  'fractional-route': {},
  'route-budget': { agentMaxRouteCallsPerTurn: 1 },
  'search-budget': { agentMaxSearchCallsPerTurn: 1 },
  'replace-selection': {},
} satisfies Record<string, Partial<Config>>
export type Fixture = keyof typeof fixtures

/** 收藏使用已确认的别名，路线场景能直接测交通方式和端点，不强制增加搜索步骤。 */
export async function seedFavorites(ctx: Context) {
  const domain = await ctx.storageDomain.open(tripPlannerDomain)
  try {
    for (const [i, place] of landmarks.entries()) {
      const id = crypto.randomUUID()
      const fetchedAt = new Date().toISOString()
      const [longitude, latitude] = place.location.split(',').map(Number)
      const value = savedPlaceSchema.parse({ id, placeId: place.id, alias: aliases[i], name: place.name,
        address: place.address, city, coordinates: { longitude, latitude }, source: 'AMAP',
        fetchedAt, createdAt: fetchedAt, updatedAt: fetchedAt })
      await domain.table('favorites').put(id, value)
    }
  } finally { await domain.close() }
}

export interface FakeCall { seq: number; turn: number; atMs: number; durationMs?: number; name: string; args: unknown; outcome?: string }
export function mountFake(ctx: Context, fixture: Fixture, onCall: (name: string, args: unknown) => FakeCall) {
  function observe<T>(name: string, args: unknown, run: () => T): T {
    const call = onCall(name, args)
    const t = performance.now()
    const success = (value: unknown) => { call.outcome = (value as { status?: string }).status === '0' ? 'fixture_error_response' : 'returned' }
    const fail = (error: unknown) => { call.outcome = error instanceof Error && error.name === 'AbortError' ? 'aborted' : 'fixture_fault' }
    const end = () => { call.durationMs = Math.round(performance.now() - t) }
    try {
      const value = run()
      if (value instanceof Promise) return value.then(result => { success(result); return result }, error => { fail(error); throw error }).finally(end) as T
      success(value); end(); return value
    } catch (error) { fail(error); end(); throw error }
  }

  registerFakeAmap(ctx, {
    search: (args, { signal }) => observe(AMAP_SEARCH_TOOL, args, async () => {
      if (fixture === 'search-timeout') await delay(5000, undefined, { signal })
      if (!/^广州(?:市)?$/u.test(args.city)) return { pois: [] }
      const text = args.keywords.normalize('NFKC')
      if (fixture === 'search-budget') return { pois: [] }
      if (fixture === 'region-missing') return { pois: [culture[0], unknown] }
      if (fixture === 'few-candidates') return { pois: [culture[0], culture[5], culture[6]] }
      if (fixture === 'replace-selection') return { pois: [culture[0], culture[1], culture[2], unknown] }
      const pool = /湖滨/u.test(text) ? parks.filter(p => p.name.includes('湖滨'))
        : /铁路|工业|博物|文化|展馆|美术|纪念/u.test(text) ? [...culture, { ...culture[0] }, { ...culture[1], id: 'fake-dup-m2' }]
          : /公园|绿地|游玩|景点|风景|景区|休闲/u.test(text) ? parks
            : landmarks.filter(p => text.includes(p.name) || text.includes(p.name.slice(2)))
      return { pois: pool }
    }),
    detail: (args) => observe(AMAP_DETAILS_TOOL, args, () => {
      if (fixture === 'detail-error') return { status: '0', info: 'FAKE DETAIL ERROR' }
      return all.find(place => place.id === args.id) ?? { status: '0', info: 'FAKE POI NOT FOUND' }
    }),
    region: (args) => observe(AMAP_REGION_TOOL, args, () => ({
      regeocode: { addressComponent: { city, province: '广东省', district: all.find(place => place.location === args.location)?.adname ?? '' } },
    })),
    route: (mode, args) => observe(AMAP_ROUTE_TOOLS[mode], args, () => {
      if (![args.origin, args.destination].every(point => all.some(place => place.location === point)))
        throw new HarnessError('Fake Fixture：端点不在数据集中', 'EVAL_FIXTURE_COORDINATES')
      if (fixture === 'fractional-route' && args.origin === landmarks[1].location)
        return { status: '0', info: 'FAKE SECOND LEG FAILURE' }
      if (fixture === 'no-route') return mode === 'transit' ? { route: { transits: [] } } : { route: { paths: [] } }
      return routeFixtures[mode]
    }),
  })
}
