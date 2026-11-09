/** 把原始路线整理成摘要和显示步骤，不改变来源分段或耗时。 */
import type { PlanRouteResult, RouteSegment } from '../types.ts'

type TransitOption = RouteSegment['transportOptions'][number]
export type DisplayMode = Exclude<RouteSegment['kind'], 'public-transport'> | 'metro' | 'bus' | 'transit' | 'mixed'
export const modeLabels = { walking: '步行', bicycling: '骑行', driving: '驾车', metro: '地铁',
  bus: '公交', transit: '公共交通', mixed: '公共交通备选', railway: '铁路', unknown: '行程' } satisfies Record<DisplayMode, string>

export function formatDuration(seconds: number | null): string {
  if (seconds === null) return '耗时未知'
  const minutes = Math.ceil(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (!hours) return minutes + ' 分钟'
  return hours + ' 小时' + (rest ? ' ' + rest + ' 分钟' : '')
}

export function transitMode(option: TransitOption): DisplayMode {
  const type = option.vehicleType?.trim() ?? ''
  if (/^(?:地铁(?:线路)?|轨道交通(?:线路)?|metro|subway)$/iu.test(type)) return 'metro'
  if (/公交|巴士|\bbus\b/iu.test(type)) return 'bus'
  const line = lineIdentity(option)
  // 广佛线属于城市轨道交通，允许类型缺失或模糊时按明确线路名识别。
  if (line && (/^(?:地铁|APM\s*线)/iu.test(line) || line === '广佛线')) return 'metro'
  if (line && /^(?:公交|巴士)|^\d+[a-z]?路$/iu.test(line)) return 'bus'
  return 'transit'
}

function lineIdentity(option: TransitOption): string | undefined {
  return (option.serviceName ?? option.lineName)?.normalize('NFKC').replace(/\([^()]+--[^()]+\)$/u, '').trim().toLowerCase() || undefined
}

function segmentMode(segment: RouteSegment): DisplayMode {
  if (segment.kind !== 'public-transport') return segment.kind
  const modes = [...new Set(segment.transportOptions.map(transitMode))]
  if (modes.length === 1) return modes[0]
  return modes.includes('bus') && modes.includes('metro') ? 'mixed' : 'transit'
}

function sharedStop(options: TransitOption[], key: 'arrivalStop' | 'departureStop'): string | undefined {
  const value = options[0]?.[key]?.normalize('NFKC').trim()
  return value && options.every(option => option[key]?.normalize('NFKC').trim() === value) ? value : undefined
}

function transferStation(before: RouteSegment | undefined, after: RouteSegment | undefined): string | undefined {
  if (!before || !after || segmentMode(before) !== 'metro' || segmentMode(after) !== 'metro') return
  if (before.exit || after.entrance) return
  const previousLines = before.transportOptions.map(option => option.serviceName ?? option.lineName)
  if (previousLines.includes(null) || after.transportOptions.some(option => {
    const line = option.serviceName ?? option.lineName
    return !line || previousLines.includes(line)
  })) return
  const station = sharedStop(before.transportOptions, 'arrivalStop')
  if (station && station === sharedStop(after.transportOptions, 'departureStop')) return station
}

function walkingText(segment: RouteSegment): string {
  return [segment.instruction, ...(segment.walkingSteps ?? []).map(step => step.instruction)]
    .filter(Boolean).join(' ')
}

function isEmptyWalk(segment: RouteSegment, text = walkingText(segment)): boolean {
  return segment.distanceMeters === 0 && segment.durationSeconds === 0
    && (!text || /^(?:步行\s*0\s*米(?:到达目的地)?[。 ]*)+$/u.test(text))
}

function isStationWalk(segment: RouteSegment): boolean {
  const text = walkingText(segment)
  if (/站外|出站|出入口|出(?:口|闸)|进站|进(?:口|闸)|过街|过马路|横过|人行横道|斑马线|路口|公交站/u.test(text)
    || /沿[^，。；]*(?:路|街|大道)(?:向|直行|步行|前行|[，。；]|$)/u.test(text)) return false
  // 同名站是必要条件之一；额外要求站内指引，或来源明确给出无步行量的占位段。
  if (/站内|换乘通道|换乘站台/u.test(text)) return true
  return isEmptyWalk(segment, text)
}

export interface DisplayStep { segment: RouteSegment; mode: DisplayMode; transferAt?: string }

interface TransferRange { min: number; max: number }

/** 逐段保留每条备选线路可达到的最小和最大次数，确保前后使用同一个中间备选项。 */
function transferRange(segments: RouteSegment[]): TransferRange | null {
  let previous: { option: TransitOption; range: TransferRange }[] = []
  let walked = false
  for (const segment of segments) {
    if (segment.kind === 'walking') {
      if (!isEmptyWalk(segment)) walked = true
      continue
    }
    if (!segment.transportOptions.length) return null
    if (!previous.length) {
      previous = segment.transportOptions.map(option => ({ option, range: { min: 0, max: 0 } }))
    } else {
      const next = []
      for (const option of segment.transportOptions) {
        const range = { min: Infinity, max: 0 }
        for (const entry of previous) {
          const change = transferCost(entry.option, option, walked)
          if (change === null) return null
          range.min = Math.min(range.min, entry.range.min + change)
          range.max = Math.max(range.max, entry.range.max + change)
        }
        next.push({ option, range })
      }
      previous = next
    }
    walked = false
  }
  return previous.length ? { min: Math.min(...previous.map(entry => entry.range.min)),
    max: Math.max(...previous.map(entry => entry.range.max)) } : segments.length ? { min: 0, max: 0 } : null
}

function transferCost(before: TransitOption, after: TransitOption, walked: boolean): 0 | 1 | null {
  const fromLine = lineIdentity(before)
  const toLine = lineIdentity(after)
  const fromMode = transitMode(before)
  const toMode = transitMode(after)
  if ((fromMode === 'bus' && toMode === 'metro') || (fromMode === 'metro' && toMode === 'bus')) return 1
  if (fromLine && toLine && fromLine !== toLine) return 1
  if (walked || (before.direction && after.direction && before.direction !== after.direction)) return 1
  if (!fromLine || !toLine || !before.arrivalStop || before.arrivalStop !== after.departureStop) return null
  // 相同线路、站点衔接，且方向证据一致时才视为连续乘坐。
  if (before.direction && before.direction === after.direction) return 0
  if (before.lineName && before.lineName === after.lineName && /--/u.test(before.lineName)) return 0
  return null
}

export function formatTransfers(range: TransferRange | null): string {
  if (!range) return '换乘次数未知'
  if (!range.max) return '无需换乘'
  return range.min === range.max ? '换乘 ' + range.max + ' 次' : '换乘 ' + range.min + '–' + range.max + ' 次'
}

export interface SummaryLine { mode: DisplayMode; label: string }
export interface SummaryLeg { options: SummaryLine[] }

/** 只清理明确的站点范围后缀和重复方式前缀，保留支线等线路身份。 */
function summaryLine(option: TransitOption, railway: boolean): SummaryLine {
  const mode = railway ? 'railway' : transitMode(option)
  const name = (option.serviceName?.trim() || option.lineName?.trim() || '').normalize('NFKC')
    .replace(/\([^()]+--[^()]+\)$/u, '').trim()
  const label = mode === 'metro' ? name.replace(/^地铁\s*/u, '')
    : mode === 'bus' ? name.replace(/^公交\s*/u, '') : name
  return { mode, label: label || modeLabels[mode] }
}

/** 摘要隐藏公共交通步行衔接，详情及耗时仍读取原始分段。每一项是一段乘坐，项内是备选。 */
function routeSummary(segments: RouteSegment[], fallback: DisplayMode): SummaryLeg[] {
  const hasRide = segments.some(segment => segment.transportOptions.length
    || segment.kind === 'public-transport' || segment.kind === 'railway')
  const summary: SummaryLeg[] = []
  let previous: RouteSegment | undefined
  let walked = false
  for (const segment of segments) {
    if (fallback === 'transit' && hasRide && segment.kind === 'walking') {
      if (!isEmptyWalk(segment)) walked = true
      continue
    }
    const mode = segmentMode(segment)
    const options = segment.transportOptions.length
      ? segment.transportOptions.map(option => summaryLine(option, segment.kind === 'railway'))
      : [{ mode, label: modeLabels[mode] }]
    const unique = options.filter((option, index) => options.findIndex(other =>
      other.mode === option.mode && other.label === option.label) === index)
    // 仅有站点与方向依据的连续同线乘坐才合并；步行后重新上车仍显示两次。
    const continuousRide = previous?.transportOptions.length === 1 && segment.transportOptions.length === 1
      && transferCost(previous.transportOptions[0], segment.transportOptions[0], walked) === 0
    const continuousMode = previous && !previous.transportOptions.length && !segment.transportOptions.length
      && segmentMode(previous) === mode
    if (!continuousRide && !continuousMode) summary.push({ options: unique })
    previous = segment
    walked = false
  }
  return summary.length ? summary : [{ options: [{ mode: fallback, label: modeLabels[fallback] }] }]
}

export function routeAlternatives(result: PlanRouteResult) {
  const fallback: DisplayMode = result.mode === 'transit' ? 'transit' : result.mode
  const durations = result.routes.map(route => route.durationSeconds)
  const shortest = durations.length > 1 && durations.every(value => value !== null) ? Math.min(...durations) : null
  return result.routes.map(route => {
    const steps: DisplayStep[] = []
    for (let index = 0; index < route.segments.length; index++) {
      const segment = route.segments[index]
      const before = route.segments[index - 1]
      const next = route.segments[index + 1]
      if (segment.kind === 'walking' && isStationWalk(segment)) {
        const station = transferStation(before, next)
        if (station) {
          steps.push({ segment: next, mode: 'metro', transferAt: station })
          index++
          continue
        }
      }
      steps.push({ segment, mode: segmentMode(segment), transferAt: transferStation(before, segment) })
    }
    const modes = steps.map(step => step.mode).filter((mode, index, modes) => mode !== modes[index - 1])
    return {
      ...route, steps, modes: modes.length ? modes : [fallback], summary: routeSummary(route.segments, fallback),
      transfers: result.mode === 'transit' ? transferRange(route.segments) : null,
      fastest: shortest !== null && route.durationSeconds === shortest && durations.some(value => value !== shortest),
    }
  })
}
