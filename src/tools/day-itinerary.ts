/** 对话单日行程入口，按确定的时间表输出，不在展示阶段发起查询。 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { dayItineraryQuerySchema, itineraryRejectionReasons, itinerarySelectionSchema, type DayItineraryResult, type ItineraryRecommendation } from '../contracts/day-itinerary.ts'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { routeModes } from '../contracts/routes.ts'
import { itineraryConstraintLabels, itineraryLeg, itineraryScreeningSummary, itineraryThemeLabel, itineraryTime } from '../presentation/itinerary.ts'
import { formatTransitOption } from '../presentation/transit.ts'
import type {} from '../services/itinerary-planner.ts'
import { multiStopRouteOutputSchema } from './multi-stop-routes.ts'
import { endpointInput, routeOutputSchema } from './routes.ts'

export const name = 'trip-day-itinerary-tool'
export const inject = ['tools', 'itineraryPlanner']

const text = { type: 'string', required: true } as const
const integer = { type: 'integer', required: true } as const
const flag = { type: 'boolean', required: true } as const
const nullableText = { oneOf: [{ type: 'string' }, { type: 'null' }], required: true } as const
const nullableInteger = { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true } as const
const labels = { type: 'array', items: { type: 'string' } } as const
const numbers = { type: 'array', items: { type: 'integer' } } as const
const screeningSchema = { type: 'object', additionalProperties: false, properties: {
  duplicate: integer, outsideRegion: integer, unverified: integer, excluded: integer,
  themeMismatch: integer, sourceCounts: { ...numbers, required: true },
} } as const
const constraintSchema = { type: 'object', additionalProperties: false, properties: {
  includeDistricts: { ...labels, required: true }, excludeDistricts: { ...labels, required: true },
  excludeKeywords: { ...labels, required: true }, preferredArea: nullableText,
} } as const
const recommendationParameters = {
  city: { ...text, description: '用户指定的游览城市。' },
  theme: { ...text, description: '用户的自然语言主题，最多 80 字；也支持预设 culture、park、landmark。' },
  themeKeywords: { ...labels, description: '1–2 个保留主题限定的 POI 词，例如历史名迹用城墙、遗址或古建筑。' },
  includeDistricts: { ...labels, description: '游览点必须在所列行政区县之一，最多三个，使用完整名称。' },
  excludeDistricts: { ...labels, description: '禁止游览点位于这些行政区县，最多三个，使用完整名称。' },
  excludeKeywords: { ...labels, description: '最多五个应排除的地点名称或类型词，例如商场。' },
  preferredArea: { type: 'string', description: '用户明确表示优先的单个商圈或区县，只影响候选排序。' },
} as const
const recommendationOutput = { type: 'object', additionalProperties: false, properties: {
  city: text, theme: text, constraints: { ...constraintSchema, required: true },
  draftId: nullableText, message: nullableText,
  screening: screeningSchema,
  status: { type: 'string', enum: ['ready', 'few-candidates', 'budget', 'search-failed'], required: true },
  candidates: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
    number: integer, name: text, address: nullableText, category: nullableText, district: nullableText, pendingDistrict: flag, reason: text,
  } } },
} } as const

const outputSchema = { type: 'object', additionalProperties: false, properties: {
  source: routeOutputSchema.properties.source,
  city: text, theme: text, mode: routeOutputSchema.properties.mode,
  constraints: constraintSchema,
  status: { type: 'string', enum: ['ready', 'over-window', 'incomplete', 'insufficient-places'], required: true },
  startMinute: integer, endMinute: integer, defaultStart: flag, defaultEnd: flag,
  visits: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
    placeId: text, name: text, address: nullableText, reason: text, stayMinutes: integer, district: { type: 'string' },
  } } },
  route: { oneOf: [routeOutputSchema, multiStopRouteOutputSchema, { type: 'null' }], required: true },
  timeline: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
    kind: { type: 'string', enum: ['visit', 'travel'], required: true }, title: text, placeId: { type: 'string' },
    startMinute: nullableInteger, endMinute: nullableInteger, legIndex: nullableInteger,
  } } },
  finishMinute: nullableInteger, overByMinutes: nullableInteger, message: nullableText,
  screening: screeningSchema,
  progress: { type: 'object', additionalProperties: false, properties: {
    draftId: text, stage: { type: 'string', enum: ['verification', 'routing'], required: true },
    reason: { type: 'string', enum: ['budget', 'selection-needs-review', 'query-failed', 'no-route', 'unknown-duration'], required: true },
    verifiedNumbers: { ...numbers, required: true }, pendingNumbers: { ...numbers, required: true },
    rejectedNumbers: { ...numbers, required: true }, completedLegs: integer, pendingLegs: integer,
    rejections: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
      number: integer, reason: { type: 'string', enum: itineraryRejectionReasons, required: true },
    } } },
  } },
} } as const

function renderRecommendation(result: ItineraryRecommendation): string {
  return [
    result.city + ' · ' + itineraryThemeLabel(result.theme) + '游览候选',
    ...itineraryConstraintLabels(result.constraints),
    ...result.candidates.map(candidate => candidate.number + '. ' + [
      candidate.name, candidate.address, candidate.category, candidate.district,
      candidate.pendingDistrict && '区县待核验', candidate.reason,
    ].filter(Boolean).join('｜')),
    result.draftId && '清单引用 draftId=' + result.draftId,
    result.message,
    result.screening && itineraryScreeningSummary(result.screening),
    result.candidates.length >= 2 && '请用户任选两个或三个不同编号，确认交通方式后再查路线。',
  ].filter(Boolean).join('\n')
}

function render(result: DayItineraryResult): string {
  const lines = [result.city + ' · ' + itineraryThemeLabel(result.theme) + '单日行程',
    ...itineraryConstraintLabels(result.constraints),
    '计划时间 ' + itineraryTime(result.startMinute) + (result.defaultStart ? '（默认）' : '')
      + '–' + itineraryTime(result.endMinute) + (result.defaultEnd ? '（默认）' : ''),
    ...result.visits.map(visit => [visit.name, visit.district, visit.reason, '停留 ' + visit.stayMinutes + ' 分钟'].filter(Boolean).join('｜')),
  ]
  for (const item of result.timeline) {
    lines.push(itineraryTime(item.startMinute) + '–' + itineraryTime(item.endMinute) + ' ' + item.title)
    if (item.legIndex === null) continue
    for (const segment of itineraryLeg(result.route, item.legIndex)?.segments ?? []) {
      if (!segment.transportOptions.length) continue
      lines.push('  ' + segment.transportOptions.map(option => formatTransitOption(segment, option)).join(' 或 '))
    }
  }
  if (result.finishMinute !== null) lines.push('预计结束 ' + itineraryTime(result.finishMinute))
  if (result.overByMinutes) lines.push('超出结束时间 ' + result.overByMinutes + ' 分钟')
  if (result.message) lines.push(result.message)
  if (result.progress) {
    const progress = result.progress
    lines.push('已确认编号 ' + (progress.verifiedNumbers.join('、') || '无') + '，已完成 ' + progress.completedLegs + ' 段路线。')
    if (progress.pendingNumbers.length) lines.push('待核验编号 ' + progress.pendingNumbers.join('、'))
    if (progress.rejectedNumbers.length) lines.push('请替换编号 ' + progress.rejectedNumbers.join('、'))
    if (progress.reason === 'budget') lines.push('等待用户说继续，续查时只传 draftId=' + progress.draftId)
  }
  lines.push('营业时间、预约和门票待确认。')
  return lines.join('\n')
}

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'trip_recommend_day_itinerary_places',
    description: '按主题和地区搜索一日行程候选。给用户展示候选编号、简短入选依据与待核验信息，等待用户确认选择。',
    parameters: recommendationParameters,
    output: { schema: recommendationOutput, render: (_args, value) => [{ type: 'text', text: renderRecommendation(value) }] },
    execute: (args, execution) => ctx.itineraryPlanner.recommend(args, execution),
  }))
  ctx.tools.register(defineTool({
    name: 'trip_plan_day_itinerary',
    description: '为用户确认的两到三个候选编号查询交通并生成单日时间表。使用推荐返回的 draftId。续查时只传 draftId。只有用户明确要求代选时才用 autoSelect=true 和主题条件。',
    parameters: {
      ...recommendationParameters,
      city: { type: 'string', description: recommendationParameters.city.description },
      theme: { type: 'string', description: recommendationParameters.theme.description },
      draftId: { type: 'string', description: '推荐返回的清单引用。使用清单时不用重复提交城市、主题或地区条件。' },
      selectedNumbers: { ...numbers, description: '用户确认的两个或三个候选编号。续查省略。' },
      autoSelect: { type: 'boolean', description: '只有用户明确要求代选才传 true。' },
      mode: { type: 'string', enum: routeModes, description: '用户确认的交通方式，首次确认或代选时必填。续查省略。' },
      startTime: { type: 'string', description: '当地时间 HH:mm，省略默认 10:00。' },
      endTime: { type: 'string', description: '当天结束时间 HH:mm，省略默认 18:00。' },
      stayMinutes: { type: 'integer', description: '用户指定的每站停留分钟数，15 到 240。' },
      origin: { ...endpointInput, description: '可选出发地点，使用已确认的收藏或 POI。' },
      destination: { ...endpointInput, description: '可选最终目的地，使用已确认的收藏或 POI。' },
      returnToOrigin: { type: 'boolean', description: '要求返程时设为 true，同时提供 origin，并省略 destination。' },
    },
    output: { schema: outputSchema, render: (_args, value) => [{ type: 'text', text: render(value) }] },
    execute: (args, execution) => {
      if (args.draftId !== undefined) {
        const input = itinerarySelectionSchema.safeParse(args)
        if (input.success) return ctx.itineraryPlanner.planSelection(input.data, execution)
      } else {
        const input = dayItineraryQuerySchema.safeParse(args)
        if (input.success) return ctx.itineraryPlanner.plan(input.data, execution)
      }
      throw new HarnessError('请按候选确认、续查或明确代选的参数调用。', 'TRIP_INVALID_ITINERARY')
    },
  }))
}
