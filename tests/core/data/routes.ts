/** 共享 Fake MCP 注册：保留原参数结构、工具流水线和高德文本包裹格式。 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { AMAP_DETAILS_TOOL, AMAP_REGION_TOOL, AMAP_ROUTE_TOOLS, AMAP_SEARCH_TOOL } from '../../../src/adapters/amap-mcp.ts'
import { routeModes, type RouteMode } from '../../../src/contracts/routes.ts'

export type FakeRouteArgs = { origin: string; destination: string; city?: string; cityd?: string }

function raw(data: unknown) { return { content: [{ type: 'text', text: JSON.stringify(data) }] } }

export function registerFakeAmap(ctx: Context, handlers: {
  search?: (args: { keywords: string; city: string; citylimit: boolean }, execution: ToolRunContext) => unknown
  detail: (args: { id: string }, execution: ToolRunContext) => unknown
  region?: (args: { location: string }, execution: ToolRunContext) => unknown
  route?: (mode: RouteMode, args: FakeRouteArgs, execution: ToolRunContext) => unknown
  registerRoutes?: boolean
}): void {
  const output = { schema: { type: 'json' }, render: () => [{ type: 'text' as const, text: 'Fake Fixture' }] } as const
  if (handlers.search) ctx.tools.register(defineTool({
    name: AMAP_SEARCH_TOOL, description: '测试主题搜索',
    parameters: { keywords: { type: 'string', required: true }, city: { type: 'string', required: true },
      citylimit: { type: 'boolean', required: true } },
    output, async execute(args, execution) { return raw(await handlers.search?.(args, execution)) },
  }))
  ctx.tools.register(defineTool({
    name: AMAP_DETAILS_TOOL, description: '测试详情',
    parameters: { id: { type: 'string', required: true } },
    output, async execute(args, execution) { return raw(await handlers.detail(args, execution)) },
  }))
  if (handlers.region) ctx.tools.register(defineTool({
    name: AMAP_REGION_TOOL, description: '测试行政区核验',
    parameters: { location: { type: 'string', required: true } },
    output, async execute(args, execution) { return raw(await handlers.region?.(args, execution)) },
  }))
  if (handlers.registerRoutes !== false) for (const mode of routeModes) ctx.tools.register(defineTool({
    name: AMAP_ROUTE_TOOLS[mode], description: '测试路线',
    parameters: { origin: { type: 'string', required: true }, destination: { type: 'string', required: true },
      ...mode === 'transit' ? { city: { type: 'string', required: true } as const, cityd: { type: 'string', required: true } as const } : {} },
    output, async execute(args, execution) {
      return raw(handlers.route ? await handlers.route(mode, args, execution) : routeFixtures[mode])
    },
  }))
}
/** 仅供离线测试的路线样本，不参与生产查询。字段结构参考高德文档，数值不代表真实导航。 */
export const routeFixtures = {
  walking: { route: { paths: [{ distance: '1200', duration: '960', steps: [{ instruction: '沿测试路步行', distance: '1200', duration: '960' }] }] } },
  bicycling: { data: { paths: [{ distance: 1400, duration: 420, steps: [{ instruction: '沿测试路骑行', distance: 1400, duration: 420 }] }] } },
  driving: { route: { paths: [{ distance: '2000', duration: '600', tolls: '0', steps: [{ instruction: '沿测试路行驶', distance: '2000', duration: '600' }] }] } },
  transit: { route: { distance: '99999', transits: [{ duration: '1800', cost: '2', walking_distance: '200', segments: [
    { walking: { distance: '100', duration: '80', steps: [{ instruction: '步行至甲站', distance: '100', duration: '80' }] },
      bus: { buslines: [
        { name: '测试地铁一号线', type: '地铁线路', departure_stop: { name: '甲站' }, arrival_stop: { name: '乙站' }, distance: '3000', duration: '900' },
        { name: '测试公交 8 路', type: '普通公交', departure_stop: { name: '甲站' }, arrival_stop: { name: '乙站' }, distance: '3500', duration: '1000' },
      ] }, entrance: { name: 'A口' }, exit: { name: 'B口' }, railway: { name: '', trip: '' } },
    { walking: { distance: '100', duration: '80', steps: [{ instruction: '步行至终点' }] }, bus: { buslines: [] }, railway: { name: '', trip: '' } },
  ] }] } },
} as const
