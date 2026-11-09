/** 只读地点详情消费方：让 Agent 复用现有服务和缓存，不复制地图请求逻辑。 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '../services/travel-data.ts'
import { placeOutputSchema } from './data.ts'

export const name = 'trip-place-detail-tools'
export const inject = ['tools', 'travelData']

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'trip_get_place_details',
    description: '按已确认的真实高德 POI ID 读取一个地点的基本详情，复用插件缓存。仅返回名称、地址、城市、坐标和原查询时间，不提供营业时间、评分、票价或地铁指引。泛问游玩推荐时通常无需调用；不要为凑齐列表逐个补查。收藏和路线工具已经会按需查询详情，不需要提前批量调用本工具。',
    parameters: {
      placeId: { type: 'string', required: true, description: '先前搜索、收藏或用户选定的真实 POI ID，不填写地名或自行编造。' },
      refresh: { type: 'boolean', description: '仅在用户明确要求刷新该地点基本信息时使用 true，跳过已有详情缓存。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        source: { type: 'string', const: 'AMAP', required: true },
        fetchedAt: { type: 'string', required: true }, place: { ...placeOutputSchema, required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: [
        '高德地点基本信息 · ' + value.place.name,
        'ID：' + value.place.id,
        '地址：' + (value.place.address ?? '来源未提供'),
        '城市：' + (value.place.city ?? '来源未提供'),
        value.place.coordinates ? '经度：' + value.place.coordinates.longitude + '，纬度：' + value.place.coordinates.latitude : '坐标：来源未提供',
        '原查询时间：' + value.fetchedAt,
      ].join('\n') }],
    },
    execute: (args, execution) => ctx.travelData.getPlaceDetails(args.placeId, execution, { refresh: args.refresh }),
  }))
}
