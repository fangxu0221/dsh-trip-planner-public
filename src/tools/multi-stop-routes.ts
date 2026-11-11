/** 调用多地点服务，向 Agent 返回最终顺序和可用的分段乘车指引。 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { maxMultiStopPlaces } from '../contracts/route-limits.ts'
import { routeModes, routeOrders, type PlanMultiStopRouteResult } from '../contracts/routes.ts'
import { formatTransitOption } from '../presentation/transit.ts'
import { continuationInput, duration, endpointInput, endpointOutput, routeOutputSchema } from './routes.ts'

export const name = 'trip-multi-stop-route-tools'
export const inject = ['tools', 'routePlanner']

const nullableNumber = { oneOf: [{ type: 'number' }, { type: 'null' }], required: true } as const
const nullableText = { oneOf: [{ type: 'string' }, { type: 'null' }], required: true } as const
const outputSchema = { type: 'object', additionalProperties: false, properties: {
  source: routeOutputSchema.properties.source,
  stops: { type: 'array', required: true, items: endpointOutput },
  mode: routeOutputSchema.properties.mode,
  order: { type: 'string', enum: routeOrders, required: true },
  status: { type: 'string', enum: ['complete', 'incomplete'], required: true },
  totalDurationSeconds: nullableNumber, totalDistanceMeters: nullableNumber,
  legs: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
    from: { type: 'integer', required: true }, to: { type: 'integer', required: true },
    status: { type: 'string', enum: ['found', 'no-route', 'query-failed', 'not-queried'], required: true },
    route: { oneOf: [routeOutputSchema.properties.routes.items, { type: 'null' }], required: true },
    fetchedAt: nullableText, message: nullableText, warnings: routeOutputSchema.properties.warnings,
  } } },
} } as const

function render(result: PlanMultiStopRouteResult): string {
  const stops = result.stops.map(stop => stop.alias ?? stop.name)
  const summary = result.status === 'complete' ? '全程' + duration(result.totalDurationSeconds) : '路线未完成，暂无全程耗时'
  const ordering = result.order === 'optimized' ? '｜按直线距离排序' : ''
  const lines = [stops.join(' → '), '高德地图｜' + summary + ordering]
  for (const leg of result.legs) {
    const label = stops[leg.from] + ' → ' + stops[leg.to]
    if (leg.route) {
      lines.push(label + '｜' + duration(leg.route.durationSeconds))
      for (const segment of leg.route.segments) {
        if (!segment.transportOptions.length) continue
        const options = segment.transportOptions.map(option => formatTransitOption(segment, option))
        lines.push('  - ' + (options.length > 1 ? '任选其一：' : '') + options.join(' 或 '))
      }
    } else {
      lines.push(label + '｜' + (leg.message ?? (leg.status === 'no-route' ? '高德未返回路线' : '未查询')))
    }
  }
  return lines.join('\n')
}

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'trip_plan_multi_stop_route',
    description: '规划 3—' + maxMultiStopPlaces + ' 个已选地点。用户指定完整顺序时用 given，否则用 optimized 按直线距离顺路排序。全程使用一种已确认的交通方式。只查询最终顺序的相邻段，返回各段首个方案、已有乘车指引和预计耗时。两个地点使用 trip_plan_route。',
    parameters: {
      stops: { type: 'array', required: true, items: endpointInput, description: '提供收藏别名或真实高德 POI ID。given 按访问顺序填写。optimized 时固定起点放首项，固定终点放末项，其余为待排序地点。' },
      mode: { type: 'string', enum: routeModes, required: true, description: '全程交通方式。缺少明确选择时先询问用户。' },
      order: { type: 'string', enum: routeOrders, description: 'given 沿用输入顺序，省略时兼容旧调用。用户未指定完整顺序时用 optimized，并明确传入 pinStart 和 pinEnd。' },
      pinStart: { type: 'boolean', description: '仅 optimized 使用。true 固定 stops 第一项为起点，false 由排序选择起点。' },
      pinEnd: { type: 'boolean', description: '仅 optimized 使用。true 固定 stops 最后一项为终点，false 由排序选择终点。' },
      continuation: continuationInput,
    },
    output: { schema: outputSchema, render: (_args, value) => [{ type: 'text', text: render(value) }] },
    execute: ({ continuation: _continuation, ...query }, execution) => ctx.routePlanner.planMultiStop(query, execution),
  }))
}
