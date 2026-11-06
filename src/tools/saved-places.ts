/** 角色三：五个收藏工具。负责模型输入、结构化输出和展示，业务逻辑只调用服务。 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SavedPlace } from '../services/saved-places.ts'

export const name = 'trip-saved-place-tools'
export const inject = ['tools', 'savedPlaces']

const nullableText = { oneOf: [{ type: 'string' }, { type: 'null' }] } as const

/** 工具输出沿用统一收藏结构，便于后续界面或路线规划直接读取。 */
export const savedPlaceOutputSchema = {
  type: 'object', additionalProperties: false, properties: {
    id: { type: 'string', required: true }, alias: { type: 'string', required: true },
    source: { type: 'string', const: 'AMAP', required: true }, placeId: { type: 'string', required: true },
    name: { type: 'string', required: true }, address: { ...nullableText, required: true }, city: { ...nullableText, required: true },
    coordinates: { required: true, oneOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, properties: {
      longitude: { type: 'number', required: true }, latitude: { type: 'number', required: true },
    } }] },
    fetchedAt: { type: 'string', required: true }, createdAt: { type: 'string', required: true }, updatedAt: { type: 'string', required: true },
  },
} as const
const nullablePlace = { oneOf: [savedPlaceOutputSchema, { type: 'null' }], required: true } as const
const aliasParameter = { type: 'string', required: true, description: '收藏的别名，例如家、学校、公司。' } as const

/** 纯展示函数不访问地图、不读写存储；经纬度和地区始终一起呈现。 */
function describe(place: SavedPlace): string {
  return '“' + place.alias + '” → ' + place.name + '｜地区：' + (place.city ?? '来源未提供')
    + '｜地址：' + (place.address ?? '来源未提供')
    + (place.coordinates ? '｜经度：' + place.coordinates.longitude + '，纬度：' + place.coordinates.latitude : '｜坐标：来源未提供')
    + '｜来源：高德 AMAP｜地点 ID：' + place.placeId + '｜收藏 ID：' + place.id
    + '｜详情查询时间：' + place.fetchedAt
}

/** 注册归本子插件所有；父插件卸载时自动注销，持久化数据不受影响。 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'trip_save_place',
    description: '把用户已选定的高德地点 ID 收藏为一个别名。应先搜索并让用户选定具体地点，不能猜测地点 ID。新收藏会查询高德详情；重复收藏返回已有记录，不隐式改名；别名冲突会报错。',
    parameters: { placeId: { type: 'string', required: true, description: '搜索得到、用户已选定的高德地点 ID。' }, alias: aliasParameter },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        created: { type: 'boolean', required: true }, place: { ...savedPlaceOutputSchema, required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: (value.created ? '已收藏：' : '该地点已收藏，保留原别名；需要改名请调用改名工具：') + describe(value.place) }],
    },
    execute: (args, execution) => ctx.savedPlaces.save(args, execution),
  }))

  ctx.tools.register(defineTool({
    name: 'trip_list_saved_places', description: '查看所有本地收藏及别名，不查询高德；返回保存时的详情快照。', parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        returned: { type: 'integer', required: true }, places: { type: 'array', required: true, items: savedPlaceOutputSchema },
      } },
      render: (_args, value) => [{ type: 'text', text: value.returned ? '共 ' + value.returned + ' 个收藏：\n' + value.places.map(describe).join('\n') : '还没有收藏地点。' }],
    },
    async execute() { const places = await ctx.savedPlaces.list(); return { returned: places.length, places } },
  }))

  ctx.tools.register(defineTool({
    name: 'trip_get_saved_place', description: '通过别名精确查找本地收藏，例如“家在哪里”。不联网、不更新详情，找不到时返回 found:false。',
    parameters: { alias: aliasParameter },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { found: { type: 'boolean', required: true }, place: nullablePlace } },
      render: (_args, value) => [{ type: 'text', text: value.place ? describe(value.place) : '没有找到该别名对应的收藏。' }],
    },
    async execute(args) { const place = await ctx.savedPlaces.get(args.alias); return { found: place !== null, place } },
  }))

  ctx.tools.register(defineTool({
    name: 'trip_rename_saved_place', description: '将已有收藏的别名改为新别名，保留原地点、ID 和详情快照。不会覆盖已被其他地点使用的别名。',
    parameters: { alias: aliasParameter, newAlias: { type: 'string', required: true, description: '新的收藏别名。' } },
    output: { schema: savedPlaceOutputSchema, render: (_args, value) => [{ type: 'text', text: '已更新别名：' + describe(value) }] },
    execute: args => ctx.savedPlaces.rename(args.alias, args.newAlias),
  }))

  ctx.tools.register(defineTool({
    name: 'trip_remove_saved_place', description: '按别名取消收藏，只删除对应的本地记录，不影响高德地点。重复取消返回 removed:false。',
    parameters: { alias: aliasParameter },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { removed: { type: 'boolean', required: true }, place: nullablePlace } },
      render: (_args, value) => [{ type: 'text', text: value.place ? '已取消收藏：' + describe(value.place) : '该别名没有对应收藏，无需删除。' }],
    },
    execute: args => ctx.savedPlaces.remove(args.alias),
  }))
}
