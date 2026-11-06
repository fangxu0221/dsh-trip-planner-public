/** 收藏的数据领域：只声明结构和校验，JSON 的读写交给 Harness 官方后端。 */
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

/** 本地 ID 与高德 POI ID 分开；别名改变不会改变任一 ID。 */
export const savedPlaceSchema = z.object({
  id: z.uuid(),
  alias: z.string().min(1).max(50),
  source: z.literal('AMAP'),
  placeId: z.string().min(1).max(100),
  name: z.string().min(1),
  address: z.string().nullable(),
  city: z.string().nullable(),
  coordinates: z.object({ longitude: z.number().min(-180).max(180), latitude: z.number().min(-90).max(90) }).strict().nullable(),
  fetchedAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).strict()

export type SavedPlace = z.infer<typeof savedPlaceSchema>

/** single 布局：在宿主已配置的 JSON 根目录生成 trip_planner.json。 */
export const tripPlannerDomain = defineDomain({
  name: 'trip_planner', version: 1, layout: 'single',
  tables: { favorites: domainTable(savedPlaceSchema) },
})
