/** 路线响应解析：只转换高德实际字段，不估算缺失费用，也不把可选线路误拼成换乘。 */
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { RouteAlternative, RouteDataResult, RouteMode, RouteSegment, TransitOption } from '../contracts/routes.ts'
import { walkingLeg } from './amap-walking.ts'

export const MAX_ROUTE_RESULTS = 3

function invalid(): never { throw new HarnessError('高德路线响应格式异常，不能作为可用路线展示。', 'TRIP_UPSTREAM_FORMAT') }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  return value as Record<string, unknown>
}
function absent(value: unknown): boolean { return value === undefined || value === null || value === '' || Array.isArray(value) && value.length === 0 }
/** 高德可能以 {name:'', trip:''} 表示没有铁路，不把空占位当成真实路段。零值仍有效。 */
function hasContent(value: unknown): boolean {
  if (absent(value)) return false
  if (typeof value === 'string') return !!value.trim()
  if (Array.isArray(value)) return value.some(hasContent)
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).some(hasContent)
  return true
}
function optionalObject(value: unknown): Record<string, unknown> | null {
  if (absent(value)) return null
  const item = object(value)
  return hasContent(item) ? item : null
}
function text(value: unknown): string | null {
  if (absent(value)) return null
  if (typeof value !== 'string') return invalid()
  return value.trim() || null
}
function amount(value: unknown): number | null {
  if (absent(value)) return null
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value.trim()))) return invalid()
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) return invalid()
  return number
}
function list(value: unknown, required = false): unknown[] {
  if (value === undefined || value === null || value === '') { if (required) return invalid(); return [] }
  if (!Array.isArray(value)) return invalid()
  return value
}
function station(value: unknown): string | null {
  if (typeof value === 'string') return text(value)
  const entry = optionalObject(value)
  return entry ? text(entry.name) : null
}

/** 基础行走/驾驶步骤；没有 instruction 时保留 null，不由模型编造道路指引。 */
function steps(value: unknown, kind: 'walking' | 'bicycling' | 'driving'): RouteSegment[] {
  return list(value).map(raw => {
    const step = object(raw)
    return { kind, instruction: text(step.instruction), entrance: null, exit: null, distanceMeters: amount(step.distance),
      durationSeconds: amount(step.duration), transportOptions: [] }
  })
}

function viaCount(line: Record<string, unknown>, from: string, to: string): number | undefined {
  const reported = line.via_num
  const count = typeof reported === 'number' ? reported : typeof reported === 'string' && /^\d+$/u.test(reported) ? Number(reported) : undefined
  const validCount = count !== undefined && Number.isSafeInteger(count) && count >= 0 ? count : undefined
  if (!Array.isArray(line.via_stops)) return validCount
  // 高德的途经站是上下车站之间的站点。过滤无效资料，字段冲突时省略站数。
  const names = line.via_stops.map(value => {
    if (value && typeof value === 'object' && 'name' in value && typeof value.name === 'string') return value.name.trim()
    return typeof value === 'string' ? value.trim() : ''
  })
  if (names.some(name => !name || name === from || name === to)) return undefined
  return validCount === undefined || names.length === validCount ? names.length : undefined
}

function transitOption(value: unknown, busLine = false): TransitOption {
  const line = object(value)
  const lineName = text(line.name)
  const departureStop = station(line.departure_stop)
  const arrivalStop = station(line.arrival_stop)
  const option: TransitOption = { lineName, vehicleType: text(line.type), departureStop, arrivalStop,
    distanceMeters: amount(line.distance), durationSeconds: amount(line.duration) }
  if (!busLine || !departureStop || !arrivalStop || departureStop === arrivalStop) return option
  // 仅解析高德线路名中明确的“首站--末站”，避开环线与相反方向。
  const terminals = lineName?.match(/^(.+?)[（(]([^()（）]+?)\s*--\s*([^()（）]+)[)）]$/u)
  if (terminals) {
    const [, service, first, last] = terminals.map(part => part.trim())
    if (first && last && first !== last && departureStop !== last && arrivalStop !== first) {
      option.serviceName = service
      option.direction = last
    }
  }
  const via = viaCount(line, departureStop, arrivalStop)
  if (via !== undefined && via < Number.MAX_SAFE_INTEGER) option.stopsToArrival = via + 1
  return option
}

/** 按来源分段顺序：步行衔接→公共交通。buslines 中多条线是该段的备选，不逐条累加。 */
function transitSegments(value: unknown, warnings: Set<string>): RouteSegment[] {
  const result: RouteSegment[] = []
  for (const raw of list(value)) {
    const segment = object(raw)
    if (!hasContent(segment)) continue
    const walking = optionalObject(segment.walking)
    if (walking) {
      const walkingSteps = steps(walking.steps, 'walking').map(({ instruction, distanceMeters, durationSeconds }) =>
        ({ instruction, distanceMeters, durationSeconds }))
      result.push(walkingLeg({ distanceMeters: amount(walking.distance), durationSeconds: amount(walking.duration) }, walkingSteps))
    }
    const bus = optionalObject(segment.bus)
    if (bus) {
      const options = list(bus.buslines, true).map(value => transitOption(value, true))
      if (options.length) result.push({ kind: 'public-transport', instruction: null,
        entrance: station(segment.entrance), exit: station(segment.exit),
        distanceMeters: options.length === 1 ? options[0]!.distanceMeters : null,
        durationSeconds: options.length === 1 ? options[0]!.durationSeconds : null, transportOptions: options })
    }
    const railway = optionalObject(segment.railway)
    if (railway) {
      const option = transitOption(railway)
      result.push({ kind: 'railway', instruction: null, entrance: station(segment.entrance), exit: station(segment.exit), distanceMeters: amount(railway.distance),
        durationSeconds: amount(railway.time ?? railway.duration), transportOptions: [option] })
    }
    if (optionalObject(segment.taxi)) {
      warnings.add('来源方案包含出租车路段，本版只保留其存在提示，未解析该段详细指引。')
      result.push({ kind: 'unknown', instruction: '来源包含出租车路段，详细指引未解析。', entrance: null, exit: null, distanceMeters: null, durationSeconds: null, transportOptions: [] })
    }
    if (!walking && !bus && !railway && Object.keys(segment).some(key => !['entrance', 'exit', 'taxi'].includes(key))) {
      warnings.add('部分公共交通分段未提供本版可解析的步行或线路字段，请结合地图核实。')
      result.push({ kind: 'unknown', instruction: '该分段未提供可解析的路线指引。', entrance: null, exit: null, distanceMeters: null, durationSeconds: null, transportOptions: [] })
    }
  }
  return result
}

/** 接受已解码并通过业务状态检查的 MCP JSON，兼容明确的 route/data/顶层路径封装。 */
export function normalizeRoutePayload(payload: Record<string, unknown>, mode: RouteMode, fetchedAt: string): RouteDataResult {
  if (payload.errcode !== undefined && payload.errcode !== 0 && payload.errcode !== '0') {
    throw new HarnessError('高德路线查询返回业务错误，请检查服务权限或查询条件。', 'TRIP_UPSTREAM_ERROR')
  }
  const body = object(payload.route ?? payload.data ?? payload)
  const warnings = new Set<string>(['距离和耗时为来源的规划估计，不保证实际到达时间；方案顺序沿用来源，不代表全局最优。'])
  let candidates: unknown[]
  if (mode === 'transit') candidates = list(body.transits, true)
  else if (body.paths !== undefined) candidates = list(body.paths, true)
  else if (mode === 'bicycling' && ('distance' in body || 'duration' in body) && Array.isArray(body.steps)) candidates = [body]
  else return invalid()
  // 检查全部候选，即使只展示前三条也不把坏数据伪装成正常来源计数。
  const all: RouteAlternative[] = candidates.map((raw, index) => {
    const path = object(raw)
    if (!['distance', 'duration', mode === 'transit' ? 'segments' : 'steps'].some(key => key in path)) return invalid()
    const cost = mode === 'transit' ? amount(path.cost) : mode === 'driving' ? amount(path.tolls) : null
    const distanceMeters = amount(path.distance)
    const durationSeconds = amount(path.duration)
    let segments = mode === 'transit' ? transitSegments(path.segments, warnings) : steps(path.steps, mode)
    if (mode === 'walking' && segments.length) {
      const walkingSteps = segments.map(({ instruction, distanceMeters, durationSeconds }) => ({ instruction, distanceMeters, durationSeconds }))
      segments = [walkingLeg({ distanceMeters, durationSeconds }, walkingSteps)]
    }
    if (!segments.length) warnings.add('部分方案没有返回详细路线步骤，请结合地图核实。')
    return { index: index + 1, distanceMeters, durationSeconds,
      costCny: cost, costKind: cost === null ? null : mode === 'driving' ? 'tolls' : 'fare', segments }
  })
  if (all.some(path => path.distanceMeters === null || path.durationSeconds === null)) warnings.add('部分方案缺少总距离或预计耗时，未用其他字段推算补齐。')
  const routes = all.slice(0, MAX_ROUTE_RESULTS)
  const truncated = all.length > routes.length
  if (truncated) warnings.add('来源共返回 ' + all.length + ' 个方案，本次仅展示前 ' + MAX_ROUTE_RESULTS + ' 个。')
  if (!routes.length) warnings.add('本次查询成功，但来源没有返回该交通方式的可用路线。')
  return { source: 'AMAP', fetchedAt, status: routes.length ? 'found' : 'no-route',
    sourceCount: all.length, returned: routes.length, truncated, routes, warnings: [...warnings] }
}
