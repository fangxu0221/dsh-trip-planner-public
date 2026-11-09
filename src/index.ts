/** 插件入口：组合具体服务提供方和工具消费方，供 cordis.yml 加载。 */
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.ts'
import AmapTravelData from './providers/amap.ts'
import * as dataTools from './tools/data.ts'
import * as savedPlaces from './providers/saved-places.ts'
import * as savedRoutes from './providers/saved-routes.ts'
import * as savedPlaceTools from './tools/saved-places.ts'
import RoutePlanner from './providers/route-planner.ts'
import * as routeTools from './tools/routes.ts'
import * as routePolicy from './prompts/route-policy.ts'
import * as queryCache from './providers/query-cache.ts'

export { Config } from './config.ts'
export const name = 'trip-planner'
export const inject = ['tools', 'storageDomain', 'systemPrompt']

/** 复用宿主的 JSON 领域服务，先恢复收藏，再挂载消费方；父插件负责递归释放。 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  await ctx.plugin(routePolicy)
  await ctx.plugin(queryCache, config)
  await ctx.plugin(AmapTravelData, config)
  await ctx.plugin(dataTools)
  await ctx.plugin(savedPlaces, config)
  await ctx.plugin(savedRoutes)
  await ctx.plugin(savedPlaceTools)
  await ctx.plugin(RoutePlanner, config)
  await ctx.plugin(routeTools)
}
