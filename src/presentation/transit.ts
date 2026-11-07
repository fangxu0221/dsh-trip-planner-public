/** 网页和聊天共用的乘车指引，站名和出入口来自同一条路线响应。 */
import type { RouteSegment, TransitOption } from '../contracts/routes.ts'

export function transitCue(segment: RouteSegment, option: TransitOption) {
  const entrance = option.departureStop && segment.transportOptions.every(line => line.departureStop === option.departureStop)
    ? segment.entrance : null
  const exit = option.arrivalStop && segment.transportOptions.every(line => line.arrivalStop === option.arrivalStop)
    ? segment.exit : null
  return {
    boarding: option.departureStop ? '在' + option.departureStop + (entrance ? '（' + entrance + '进站）' : '') : '',
    departure: option.departureStop,
    entrance,
    line: option.serviceName ?? option.lineName ?? option.vehicleType ?? '线路未提供',
    direction: option.direction && option.direction + '方向',
    stops: option.stopsToArrival === undefined ? '' : '乘坐 ' + option.stopsToArrival + ' 站，',
    stopCount: option.stopsToArrival,
    arrival: option.arrivalStop,
    exit,
  }
}
