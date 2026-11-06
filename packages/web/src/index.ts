/** Host 插件入口：在现有三个出行服务和 Typert 就绪后挂载面板接口。 */
import type { Context } from '@deepseek-ai/cordis'
import { TripPlannerController } from './controller.ts'

export { TripPlannerController } from './controller.ts'
export const name = 'dsh-trip-planner-web'
export const inject = TripPlannerController.inject

export function apply(ctx: Context): void {
  ctx.plugin(TripPlannerController)
}
