/** 角色一：路线规划服务约定。消费方不需要知道收藏如何保存、地图工具如何调用。 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { PlanMultiStopRouteQuery, PlanMultiStopRouteResult, PlanRouteQuery, PlanRouteResult } from '../contracts/routes.ts'
import type { QueryExecution } from './travel-data.ts'
import type { PlaceDetailsResult } from '../contracts/travel.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { routePlanner: RoutePlannerService }
}

export default abstract class RoutePlannerService extends Service {
  constructor(ctx: Context) { super(ctx, 'routePlanner') }
  /** 详情与已完成路段供行程服务在同一草稿内续查，工具入参仍使用地点引用。 */
  abstract plan(query: PlanRouteQuery, execution: QueryExecution, details?: Map<string, PlaceDetailsResult>): Promise<PlanRouteResult>
  abstract planMultiStop(query: PlanMultiStopRouteQuery, execution: QueryExecution, details?: Map<string, PlaceDetailsResult>,
    previous?: PlanMultiStopRouteResult): Promise<PlanMultiStopRouteResult>
}
