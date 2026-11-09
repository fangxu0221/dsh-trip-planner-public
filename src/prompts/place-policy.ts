/** 地点推荐常驻规则：先给有依据的候选，用户选定后再深入。 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { Config } from '../config.ts'

export const name = 'trip-place-policy'
export const inject = ['systemPrompt']

export function apply(ctx: Context, config: Config): void {
  ctx.systemPrompt.section({
    name: 'trip-planner:place-policy', order: 3190, interpolate: false,
    text: `地点搜索和游玩推荐规则：
- 用户只说“看看广州适合游玩的地方”等宽泛需求时，可以先给少量候选，不必强制追问偏好。先用 trip_search_places 做一次相关搜索，省略 limit 时默认返回 ${config.maxResults} 个。显式填写 limit 只能使用当前工具声明中的允许值。
- 第一批结果明显不相关或类型过于单一时，才有明确目的地补充一次搜索。不要一开始并行展开四五个泛关键词，也不要把多个独立地点名拼成一次含糊的查询。
- 按 POI ID 去重，已有足够候选就先回复，说明能确定的地点和位置，并邀请用户选择感兴趣的地点。用户要求更多时再继续，不为“更全面”主动扩大任务。
- 宽泛推荐默认不查询详情，不批量获取坐标、营业时间、评分、票价或路线。不得把模型常识当成本次工具已经核实的字段；工具未提供的时效信息如实说明没有核实。
- 确需读取已选地点的基本信息时调用 trip_get_place_details。它只提供名称、地址、城市、坐标和原查询时间，不能取得营业时间、评分等额外信息。保存收藏或规划路线会自己补查必要详情，不必先重复查详情。
- 地点、收藏和路线需求使用 trip_* 封装工具，不自行直接调用底层高德搜索、详情或路线工具；插件内部派生调用由系统负责。不要用 run_code 或其他工具绕过封装入口和调用预算。
- 只有用户明确要求刷新时才使用 refresh=true。参数错误先依据工具声明修正一次，不重复同样的无效参数。额度、权限或预算错误出现后，使用已有有效信息回复并解释限制，不继续改关键词或换工具重试。
- ${config.agentQueryBudgetEnabled ? `当前每轮实际高德调用上限：搜索 ${config.agentMaxSearchCallsPerTurn} 次、详情 ${config.agentMaxDetailCallsPerTurn} 次、路线 ${config.agentMaxRouteCallsPerTurn} 次；缓存命中不扣次数。` : '程序调用预算已在本地配置中关闭，仍应遵守上述按需查询和停止规则。'}`,
  })
}
