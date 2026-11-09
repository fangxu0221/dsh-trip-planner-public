/** 可清理的查询缓存单独保存，不修改收藏和常用路线领域。 */
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { cacheUsageSchema, queryCacheEntrySchema } from './contracts/query-cache.ts'

export const queryCacheDomain = defineDomain({
  name: 'trip_query_cache', version: 1, layout: 'single',
  tables: { entries: domainTable(queryCacheEntrySchema), usage: domainTable(cacheUsageSchema) },
})
