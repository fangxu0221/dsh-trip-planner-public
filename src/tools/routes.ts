/** 角色三：路线工具消费方，声明输入、结构化输出和纯文字展示，业务调用交给路线服务。 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { routeModes, type PlanRouteResult, type RouteEndpoint, type RouteSegment } from '../contracts/routes.ts'
import type {} from '../services/route-planner.ts'
import { transitCue } from '../presentation/transit.ts'

export const name = 'trip-route-tools'
export const inject = ['tools', 'routePlanner']

const nullableText = { oneOf: [{ type: 'string' }, { type: 'null' }], required: true } as const
const nullableNumber = { oneOf: [{ type: 'number' }, { type: 'null' }], required: true } as const
const endpointInput = { oneOf: [
  { type: 'object', additionalProperties: false, properties: {
    kind: { type: 'string', const: 'saved', required: true }, alias: { type: 'string', required: true },
  } },
  { type: 'object', additionalProperties: false, properties: {
    kind: { type: 'string', const: 'poi', required: true }, placeId: { type: 'string', required: true },
  } },
], required: true } as const

const endpointOutput = { type: 'object', additionalProperties: false, required: true, properties: {
  placeId: { type: 'string', required: true }, alias: nullableText, name: { type: 'string', required: true },
  address: nullableText, city: nullableText, detailsFetchedAt: { type: 'string', required: true },
  coordinates: { type: 'object', additionalProperties: false, required: true, properties: {
    longitude: { type: 'number', required: true }, latitude: { type: 'number', required: true },
  } },
} } as const

/** 与 DTO 对齐的完整输出；未知数值明确为 null，供后续 UI 或比较功能直接使用。 */
export const routeOutputSchema = { type: 'object', additionalProperties: false, properties: {
  origin: endpointOutput, destination: endpointOutput, mode: { type: 'string', enum: routeModes, required: true },
  source: { type: 'string', const: 'AMAP', required: true }, fetchedAt: { type: 'string', required: true },
  status: { type: 'string', enum: ['found', 'no-route'], required: true },
  sourceCount: { type: 'integer', required: true }, returned: { type: 'integer', required: true }, truncated: { type: 'boolean', required: true },
  warnings: { type: 'array', required: true, items: { type: 'string' } },
  routes: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
    index: { type: 'integer', required: true }, distanceMeters: nullableNumber, durationSeconds: nullableNumber, costCny: nullableNumber,
    costKind: { required: true, oneOf: [{ type: 'string', enum: ['fare', 'tolls'] }, { type: 'null' }] },
    segments: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
      kind: { type: 'string', enum: ['walking', 'bicycling', 'driving', 'public-transport', 'railway', 'unknown'], required: true },
      instruction: nullableText, entrance: nullableText, exit: nullableText, distanceMeters: nullableNumber, durationSeconds: nullableNumber,
      walkingSteps: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
        instruction: nullableText, distanceMeters: nullableNumber, durationSeconds: nullableNumber,
      } } },
      transportOptions: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        lineName: nullableText, vehicleType: nullableText, departureStop: nullableText, arrivalStop: nullableText,
        distanceMeters: nullableNumber, durationSeconds: nullableNumber,
        serviceName: { type: 'string' }, direction: { type: 'string' }, stopsToArrival: { type: 'integer' },
      } } },
    } } },
  } } },
} } as const

const labels = { walking: '步行', bicycling: '骑行', driving: '驾车', transit: '公共交通' } as const
function distance(value: number | null): string { return value === null ? '距离未知' : value < 1000 ? value + ' 米' : (value / 1000).toFixed(2) + ' 公里' }
function duration(value: number | null): string { return value === null ? '耗时未知' : '预计 ' + Math.ceil(value / 60) + ' 分钟' }
function endpoint(value: RouteEndpoint): string {
  return (value.alias ? '“' + value.alias + '” ' : '') + value.name + '｜地区：' + (value.city ?? '来源未提供')
    + '｜经度：' + value.coordinates.longitude + '，纬度：' + value.coordinates.latitude + '｜地点详情时间：' + value.detailsFetchedAt
}
function segment(value: RouteSegment): string {
  if (value.transportOptions.length) {
    const options = value.transportOptions.map(option => {
      const cue = transitCue(value, option)
      return cue.boarding + '乘坐 ' + cue.line + (cue.direction ? '（' + cue.direction + '）' : '')
        + (cue.arrival ? '，' + cue.stops + '到' + cue.arrival + '下车' : '')
        + (cue.exit ? '，从' + cue.exit + '出站' : '')
    })
    return (options.length > 1 ? '本段任选其一：' : '') + options.join(' 或 ')
  }
  const kind = value.kind === 'public-transport' ? '公共交通' : value.kind === 'railway' ? '铁路' : value.kind === 'unknown' ? '其他路段' : labels[value.kind]
  return kind + '：' + (value.instruction ?? '来源未提供详细指引') + '（' + distance(value.distanceMeters) + '，' + duration(value.durationSeconds) + '）'
}

/** render 只读取返回结果，绝不在展示阶段再次查询地图或保存收藏。 */
export function renderRoute(value: PlanRouteResult): string {
  const lines = [labels[value.mode] + '路线｜来源：高德 AMAP｜查询时间：' + value.fetchedAt,
    '起点：' + endpoint(value.origin), '终点：' + endpoint(value.destination)]
  if (value.status === 'no-route') lines.push('本次查询成功，但来源没有返回可用路线。')
  for (const route of value.routes) {
    const fee = route.costCny === null ? '费用：来源未提供' : route.costKind === 'tolls'
      ? '道路收费：¥' + route.costCny + '（不包含油费、停车费等其他成本）' : '来源票价：¥' + route.costCny
    lines.push('方案 ' + route.index + '：' + distance(route.distanceMeters) + '｜' + duration(route.durationSeconds) + '｜' + fee)
    lines.push(...route.segments.slice(0, 30).map((item, index) => '  ' + (index + 1) + '. ' + segment(item)))
    if (route.segments.length > 30) lines.push('  文字仅展示前 30 段，完整分段保留在结构化结果中。')
  }
  lines.push(...value.warnings.map(warning => '提示：' + warning))
  return lines.join('\n')
}

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'trip_plan_route',
    description: '规划已选定的两点之间一种交通方式的路线。起终点使用收藏别名或真实高德 POI ID，地点不明确时先搜索并让用户选择。支持步行、骑行、驾车、公交/地铁。按乘车顺序说明线路、方向、站数、下车站和出口，只采用工具返回的字段。',
    parameters: { origin: endpointInput, destination: endpointInput,
      mode: { type: 'string', enum: routeModes, required: true, description: 'walking 步行，bicycling 骑行，driving 驾车，transit 公共交通。' } },
    output: { schema: routeOutputSchema, render: (_args, value) => [{ type: 'text', text: renderRoute(value) }] },
    execute: (args, execution) => ctx.routePlanner.plan(args, execution),
  }))
}
