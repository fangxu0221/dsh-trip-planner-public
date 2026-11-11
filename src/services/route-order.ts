/** 在地点数量上限内枚举顺序，比较相邻地点的球面直线距离之和。 */
import type { RouteEndpoint } from '../contracts/routes.ts'
import type { Coordinates } from '../contracts/travel.ts'

export interface PinnedStops { pinStart: boolean; pinEnd: boolean }

function meters(from: Coordinates, to: Coordinates): number {
  if (from.longitude === to.longitude && from.latitude === to.latitude) return Infinity
  const radians = Math.PI / 180
  const a = Math.sin((to.latitude - from.latitude) * radians / 2) ** 2
    + Math.cos(from.latitude * radians) * Math.cos(to.latitude * radians)
      * Math.sin((to.longitude - from.longitude) * radians / 2) ** 2
  return 2 * 6_371_000 * Math.asin(Math.sqrt(Math.min(1, a)))
}

export function optimizeRouteOrder(stops: RouteEndpoint[], { pinStart, pinEnd }: PinnedStops): RouteEndpoint[] | undefined {
  const distances = stops.map(from => stops.map(to => meters(from.coordinates, to.coordinates)))
  const last = stops.length - 1
  const remaining = stops.map((_, index) => index)
    .filter(index => !(pinStart && index === 0) && !(pinEnd && index === last))
  let best: number[] | undefined
  let shortest = Infinity

  function visit(path: number[], candidates: number[], distance: number): void {
    const previous = path.at(-1)
    if (!candidates.length) {
      const total = pinEnd && previous !== undefined ? distance + distances[previous][last] : distance
      // 以原始次序枚举，微米内的浮点差不改变等长路线的选择。
      if (total + 1e-6 < shortest) {
        shortest = total
        best = pinEnd ? [...path, last] : path
      }
      return
    }
    for (const next of candidates) {
      const length = previous === undefined ? distance : distance + distances[previous][next]
      if (length < shortest) visit([...path, next], candidates.filter(index => index !== next), length)
    }
  }

  visit(pinStart ? [0] : [], remaining, 0)
  return best?.map(index => stops[index])
}
