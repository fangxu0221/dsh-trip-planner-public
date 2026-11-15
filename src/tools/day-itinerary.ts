/** 对话单日行程入口，按确定的时间表输出，不在展示阶段发起查询。 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { DayItineraryResult } from '../contracts/day-itinerary.ts'
import { routeModes } from '../contracts/routes.ts'
import { itineraryConstraintLabels, itineraryLeg, itineraryThemeLabel, itineraryTime } from '../presentation/itinerary.ts'
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
const outputSchema = { type: 'object', additionalProperties: false, properties: {
  source: routeOutputSchema.properties.source,
  city: text, theme: text, mode: routeOutputSchema.properties.mode,
  constraints: { type: 'object', additionalProperties: false, properties: {
    includeDistricts: { ...labels, required: true }, excludeDistricts: { ...labels, required: true },
    excludeKeywords: { ...labels, required: true }, preferredArea: nullableText,
  } },
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
} } as const

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
  lines.push('营业时间、预约和门票待确认。')
  return lines.join('\n')
}

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'trip_plan_day_itinerary',
    description: '按用户的自然语言主题和地区限制自动选两个游览点，查询交通并生成单日时间表。适用于一日游或单日行程。',
    parameters: {
      city: { ...text, description: '用户指定的游览城市。' },
      theme: { ...text, description: '用户的自然语言主题，最多 80 字；也支持预设 culture、park、landmark。' },
      themeKeywords: { ...labels, description: '自定义主题提供 1–2 个简短具体的 POI 搜索词，可匹配地点名称或高德分类。省略则使用主题原文或预设搜索词。' },
      includeDistricts: { ...labels, description: '游览点必须在所列行政区县之一。最多三个，使用完整名称，例如天河区。' },
      excludeDistricts: { ...labels, description: '禁止游览点位于这些行政区县。最多三个，使用完整名称。' },
      excludeKeywords: { ...labels, description: '最多五个应排除的地点名称或类型词，例如商场。' },
      preferredArea: { type: 'string', description: '用户明确表示优先的单个商圈或区县。它只影响候选排序。' },
      mode: { type: 'string', enum: routeModes, required: true, description: '用户确认的交通方式。' },
      startTime: { type: 'string', description: '当地时间 HH:mm，省略默认 10:00。' },
      endTime: { type: 'string', description: '当天结束时间 HH:mm，省略默认 18:00。' },
      stayMinutes: { type: 'integer', description: '用户指定的每站停留分钟数，15 到 240。' },
      origin: { ...endpointInput, description: '可选出发地点，使用已确认的收藏或 POI。' },
      destination: { ...endpointInput, description: '可选最终目的地，使用已确认的收藏或 POI。' },
      returnToOrigin: { type: 'boolean', description: '要求返程时设为 true，同时提供 origin，并省略 destination。' },
    },
    output: { schema: outputSchema, render: (_args, value) => [{ type: 'text', text: render(value) }] },
    execute: (args, execution) => ctx.itineraryPlanner.plan(args, execution),
  }))
}
