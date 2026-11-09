/** 路线对话的常驻规则：先确认出行意图，再使用现有路线工具。 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'

export const name = 'trip-route-policy'
export const inject = ['systemPrompt']

export function apply(ctx: Context): void {
  ctx.systemPrompt.section({
    name: 'trip-planner:route-policy', order: 3200, interpolate: false,
    text: `出行路线规划规则：
- 出行需求优先使用 trip_search_places、收藏工具和 trip_plan_route。不要自行直接调用底层高德路线工具绕过交通方式确认及右栏结果同步。
- 调用 trip_plan_route 前，必须确认用户希望使用的交通方式。支持公共交通、驾车、骑行、步行。
- 用户本次明确指定，或当前连续对话中用户已经明确且仍然适用的交通方式，可以直接使用；模型之前自行推荐的方式不算用户选择。
- 用户只说“怎么去”“看看路线”“从学校到某地”，且交通方式不明确时，先询问“你想乘坐公共交通、驾车、骑行还是步行？”，等待用户回答后再调用路线工具。不得默认驾车，也不得用距离、收藏或之前的工具结果擅自推断用户选择。
- 只有用户明确要求比较多种方式，或明确授权你选择、推荐方式时，才可按该授权查询相应方式。要求比较但未给出比较范围时，先询问比较哪些方式；不要自动查询全部四种方式。
- 每次 trip_plan_route 只查询一种方式。明确比较时，对同一组已确认的起终点分别查询用户要求的方式，公共交通和驾车的结果都保留，并分别标明。查询失败或没有路线时如实说明，不编造时长和线路。
- 起终点必须对应已确认的收藏或真实高德 POI。地点存在多个候选时先让用户选择。只根据工具结果说明线路、方向、站数和出入口。`,
  })
}
