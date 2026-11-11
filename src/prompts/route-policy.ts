/** 路线对话的常驻规则：先确认出行意图，再使用现有路线工具。 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'

export const name = 'trip-route-policy'
export const inject = ['systemPrompt']

export function apply(ctx: Context): void {
  ctx.systemPrompt.section({
    name: 'trip-planner:route-policy', order: 3200, interpolate: false,
    text: `出行路线规划规则：
- 出行需求优先使用 trip_search_places、trip_get_place_details、收藏工具、trip_plan_route 和 trip_plan_multi_stop_route。不要自行直接调用底层高德工具绕过缓存、交通方式确认及右栏结果同步。
- 调用路线工具前，必须确认用户希望使用的交通方式。支持公共交通、驾车、骑行、步行。
- 用户本次明确指定，或当前连续对话中用户已经明确且仍然适用的交通方式，可以直接使用；模型之前自行推荐的方式不算用户选择。
- 用户只说“怎么去”“看看路线”“从学校到某地”，且交通方式不明确时，先询问“你想乘坐公共交通、驾车、骑行还是步行？”，等待用户回答后再调用路线工具。不得默认驾车，也不得用距离、收藏或之前的工具结果擅自推断用户选择。
- 只有用户明确要求比较多种方式，或明确授权你选择、推荐方式时，才可按该授权查询相应方式。要求比较但未给出比较范围时，先询问比较哪些方式；不要自动查询全部四种方式。
- 每次 trip_plan_route 只查询一种方式。明确比较时，对同一组已确认的起终点分别查询用户要求的方式，公共交通和驾车的结果都保留，并分别标明。查询失败或没有路线时如实说明，不编造时长和线路。
- 两个地点用 trip_plan_route，3—5 个地点一次调用 trip_plan_multi_stop_route。用户指定完整访问顺序时用 given；用户未指定完整顺序时默认用 optimized。明确的出发地放 stops 首项并设 pinStart=true，明确的最终目的地放末项并设 pinEnd=true；没有固定的一端传 false，让服务从候选中选择。实际出发地指代不清或有其他先后约束时先确认对应地点或满足约束的完整顺序。地点已确认时直接传引用，由路线服务补查必要详情。
- 优化结果按返回的 stops 说明访问顺序，标明按直线距离排序；实际线路和耗时以高德分段结果为准。
- 用户要求最后返回起点时，把起点在 stops 的首尾各填一次，连同去程和返程一次调用多地点工具。明确访问顺序用 given；允许顺路排序的环线用 optimized，并固定首尾。普通多地点路线同样提交完整顺序。已有同轮路线确实需要续接时才对后续段使用 continuation=append，独立路线使用 continuation=separate。
- 多地点结果未完成时，说明已完成、无路线或查询失败及未查询的段。达到预算时使用已有结果，请用户决定下一轮是否继续；不要拆成多个工具调用重试或估算缺失的总耗时。
- 地点必须对应已确认的收藏或真实高德 POI。地点存在多个候选时先让用户选择。
- 回答公共交通时按段使用工具已给出的线路、上车站、方向、站数、下车站和出入口，只针对缺失的字段说明未知。用户追问已有字段时直接复用本轮结果，无需再次查询。`,
  })
}
