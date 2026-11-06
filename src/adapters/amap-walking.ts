/** 整理步行指引，保留原始步骤、有效动作和来源的分段总量。 */
import type { RouteSegment, WalkingStep } from '../contracts/routes.ts'

function summarize(steps: WalkingStep[]): string | null {
  const instructions = steps.flatMap(({ instruction }) => {
    const text = instruction?.trim().replace(/[。；;，,]+$/u, '')
    return text ? [text] : []
  })
  const unique = instructions.filter((text, index) => text !== instructions[index - 1])
  const useful = unique.filter((text, index) => {
    // 只省略没有道路、转弯、设施或实际站名的占位指令。
    if (/^步行\s*(?:0|1)\s*米(?:到达目的地)?$/u.test(text)) return false
    return index === unique.length - 1 || !/^步行\s*\d+(?:\.\d+)?\s*米到达目的地$/u.test(text)
  })
  const summary = useful.length ? useful : unique
  return summary.length ? summary.join('，') + '。' : null
}

export function walkingLeg(source: Pick<RouteSegment, 'distanceMeters' | 'durationSeconds'>, steps: WalkingStep[]): RouteSegment {
  return {
    kind: 'walking', instruction: summarize(steps), walkingSteps: steps, entrance: null, exit: null,
    distanceMeters: source.distanceMeters, durationSeconds: source.durationSeconds, transportOptions: [],
  }
}
