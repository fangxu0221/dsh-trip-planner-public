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

/** 把现有字段转成一句乘车指引，缺失字段留空。 */
export function formatTransitOption(segment: RouteSegment, option: TransitOption): string {
  const cue = transitCue(segment, option)
  return cue.boarding + '乘坐 ' + cue.line + (cue.direction ? '（' + cue.direction + '）' : '')
    + (cue.stopCount === undefined ? '' : '，乘坐 ' + cue.stopCount + ' 站')
    + (cue.arrival ? '，到' + cue.arrival + '下车' : '')
    + (cue.exit ? '，从' + cue.exit + '出站' : '')
}
