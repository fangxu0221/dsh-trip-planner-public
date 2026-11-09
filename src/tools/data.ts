/** 角色三：工具消费方。声明模型输入、结构化输出和文字展示，只通过服务调用业务能力。 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '../services/travel-data.ts'
import type { Config } from '../config.ts'

export const name = 'trip-query-tools'
export const inject = ['tools', 'travelData']

const nullableText = { oneOf: [{ type: 'string' }, { type: 'null' }] } as const

/** 搜索和只读详情共用同一个地点输出结构，不扩充尚未支持的营业时间等字段。 */
export const placeOutputSchema = { type: 'object', additionalProperties: false, properties: {
  id: { type: 'string', required: true }, name: { type: 'string', required: true },
  address: { ...nullableText, required: true }, city: { ...nullableText, required: true },
  coordinates: { required: true, oneOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, properties: {
    longitude: { type: 'number', required: true }, latitude: { type: 'number', required: true },
  } }] },
} } as const

/** 与业务 DTO 对应的运行时输出声明；缺失值明确保留为 null。 */
export const searchOutputSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    source: { type: 'string', const: 'AMAP', required: true },
    fetchedAt: { type: 'string', required: true },
    query: { type: 'object', additionalProperties: false, required: true, properties: {
      keywords: { type: 'string', required: true }, city: { type: 'string', required: true }, limit: { type: 'integer', required: true },
    } },
    sourceCount: { type: 'integer', required: true }, returned: { type: 'integer', required: true },
    truncated: { type: 'boolean', required: true },
    places: { type: 'array', required: true, items: placeOutputSchema },
    warnings: { type: 'array', required: true, items: { type: 'string' } },
  },
} as const

/** 注册的工具归当前子插件所有，卸载时由框架自动注销。 */
export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'trip_search_places',
    description: '在指定城市搜索地点候选，返回真实 ID、名称、地址和来源。省略城市使用默认城市。每次最多返回 ' + config.maxResults
      + ' 个，limit 可省略。泛问游玩推荐时先搜索一次，候选不合适才有目的地补充一次；已有足够候选就回复，不批量查详情、营业时间或路线。确需查询选定地点的基本信息时使用 trip_get_place_details，收藏和规划路线会自行按需补查详情。',
    parameters: {
      keywords: { type: 'string', required: true, description: '地点名称或游玩关键词，例如广州塔、公园。' },
      city: { type: 'string', description: '限定搜索城市，例如广州。' },
      limit: { type: 'integer', enum: Array.from({ length: config.maxResults }, (_, index) => index + 1),
        description: '可省略，默认 ' + config.maxResults + ' 个；只能填写 1 到 ' + config.maxResults + ' 的整数。' },
      refresh: { type: 'boolean', description: '用户明确要求重新查询时设为 true，跳过已有地点搜索缓存。' },
    },
    output: {
      schema: searchOutputSchema,
      // 展示只读取本次结果，不在 render 中再次查询或保存数据。
      render: (_args, value) => [{ type: 'text', text: [
        '高德地图 · ' + value.query.city + ' · “' + value.query.keywords + '”：返回 ' + value.returned + ' 个地点。',
        ...value.places.map(place => '- ' + place.name + '｜ID：' + place.id + '｜地址：' + (place.address ?? '来源未提供')
          + (place.coordinates ? '｜经度：' + place.coordinates.longitude + '，纬度：' + place.coordinates.latitude : '｜坐标：待查详情')),
        ...value.warnings.map(warning => '提示：' + warning),
        '查询时间：' + value.fetchedAt,
      ].join('\n') }],
    },
    execute: (args, execution) => ctx.travelData.searchPlaces(args, execution),
  }))
}
