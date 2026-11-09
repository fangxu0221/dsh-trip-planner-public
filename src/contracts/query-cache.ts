/** 地点缓存约定：有效期不随读取延长，选择时间只用于候选排序。 */
import { z } from 'zod'

const placeSchema = z.object({
  id: z.string().min(1), name: z.string().min(1), address: z.string().nullable(), city: z.string().nullable(),
  coordinates: z.object({ longitude: z.number().min(-180).max(180), latitude: z.number().min(-90).max(90) }).strict().nullable(),
}).strict()

export const cacheRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('search'), keywords: z.string().min(1).max(100), city: z.string().min(1).max(50), limit: z.number().int().min(1).max(10) }).strict(),
  z.object({ kind: z.literal('details'), placeId: z.string().min(1).max(100) }).strict(),
])
export type CacheRequest = z.infer<typeof cacheRequestSchema>

/** 保存通过校验的 MCP 规范值，以便缓存命中仍经过原工具的输出校验和后置策略。 */
export const queryCacheEntrySchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/), request: cacheRequestSchema,
  response: z.json(), places: z.array(placeSchema).max(10),
  fetchedAt: z.iso.datetime(), expiresAt: z.number().int().nonnegative(), usedAt: z.number().int().nonnegative(),
}).strict()
export type QueryCacheEntry = z.infer<typeof queryCacheEntrySchema>

export const cacheUsageSchema = z.object({ placeId: z.string().min(1).max(100), usedAt: z.number().int().nonnegative() }).strict()
export interface CachedPlacesQuery { keywords?: string; city?: string }
export interface CachedPlaceOption { placeId: string; name: string; address: string | null; city: string | null; fetchedAt: string }
export interface CachedPlacesView { places: CachedPlaceOption[] }
export interface QueryCacheStats {
  entries: number; cacheHits: number; joinedRequests: number; searchCalls: number; detailCalls: number; routeCalls: number; writeFailures: number
}
