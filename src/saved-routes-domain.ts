/** 常用路线使用独立领域，既有收藏记录按原结构恢复。 */
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { savedRouteSchema } from './contracts/saved-routes.ts'

export const savedRoutesDomain = defineDomain({
  name: 'trip_saved_routes', version: 1, layout: 'single',
  tables: { routes: domainTable(savedRouteSchema) },
})
