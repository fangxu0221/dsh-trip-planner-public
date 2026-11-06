/** 角色三：工具消费方。声明模型输入、结构化输出和文字展示，只通过服务调用业务能力。 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '../services/travel-data.ts'

export const name = 'trip-query-tools'
export const inject = ['tools', 'travelData']

const nullableText = { oneOf: [{ type: 'string' }, { type: 'null' }] } as const

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
    places: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
      id: { type: 'string', required: true }, name: { type: 'string', required: true },
      address: { ...nullableText, required: true }, city: { ...nullableText, required: true },
      coordinates: { required: true, oneOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, properties: {
        longitude: { type: 'number', required: true }, latitude: { type: 'number', required: true },
      } }] },
    } } },
    warnings: { type: 'array', required: true, items: { type: 'string' } },
  },
} as const

/** 注册的工具归当前子插件所有，卸载时由框架自动注销。 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'trip_search_places',
    description: '在指定城市搜索出行候选地点，返回真实地点 ID、名称、地址和来源。省略城市使用插件默认城市；需要经纬度时还应查询地点详情。',
    parameters: {
      keywords: { type: 'string', required: true, description: '地点名称或游玩关键词，例如广州塔、公园。' },
      city: { type: 'string', description: '限定搜索城市，例如广州。' },
      limit: { type: 'integer', description: '返回数量，不能超过插件 maxResults 配置。' },
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
