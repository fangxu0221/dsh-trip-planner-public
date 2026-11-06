/** 角色一：路线规划服务约定。消费方不需要知道收藏如何保存、地图工具如何调用。 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { PlanRouteQuery, PlanRouteResult } from '../contracts/routes.ts'
import type { QueryExecution } from './travel-data.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { routePlanner: RoutePlannerService }
}

export default abstract class RoutePlannerService extends Service {
  constructor(ctx: Context) { super(ctx, 'routePlanner') }
  abstract plan(query: PlanRouteQuery, execution: QueryExecution): Promise<PlanRouteResult>
}
