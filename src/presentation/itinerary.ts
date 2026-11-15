/** 对话和右栏共用单日行程的主题名与时刻格式。 */
import type { DayItineraryResult, ItineraryConstraints, ItineraryRejection, ItineraryScreening, ItineraryTheme } from '../contracts/day-itinerary.ts'

export const themeLabels = { culture: '文化展馆', park: '公园休闲', landmark: '城市地标' } satisfies Record<ItineraryTheme, string>

export const itineraryRejectionLabels = {
  duplicate: '候选重复', outsideRegion: '不在指定地区', unverified: '必要信息未能核验',
  excluded: '命中排除条件', themeMismatch: '不符合主题',
} satisfies Record<ItineraryRejection, string>

export function itineraryScreeningSummary(screening: ItineraryScreening): string {
  const reasons = Object.keys(itineraryRejectionLabels) as ItineraryRejection[]
  return reasons.filter(reason => screening[reason] > 0)
    .map(reason => screening[reason] + ' 个候选' + (reason === 'duplicate' ? '重复'
      : reason === 'unverified' ? '的必要信息未能核验' : itineraryRejectionLabels[reason]) + '。').join('')
}

export function itineraryThemeLabel(theme: string): string {
  return Object.hasOwn(themeLabels, theme) ? themeLabels[theme as ItineraryTheme] : theme
}

export function itineraryConstraintLabels(constraints?: ItineraryConstraints): string[] {
  if (!constraints) return []
  const { includeDistricts, excludeDistricts, excludeKeywords, preferredArea } = constraints
  return [
    includeDistricts.length && '游览区县 ' + includeDistricts.join('、'),
    excludeDistricts.length && '避开区县 ' + excludeDistricts.join('、'),
    excludeKeywords.length && '排除地点 ' + excludeKeywords.join('、'),
    preferredArea && '优先地区 ' + preferredArea,
  ].filter((label): label is string => typeof label === 'string' && label.length > 0)
}

export function itineraryTime(minute: number | null): string {
  if (minute === null) return '待定'
  const day = Math.floor(minute / 1440)
  const hours = String(Math.floor(minute / 60) % 24).padStart(2, '0')
  const minutes = String(minute % 60).padStart(2, '0')
  return (day === 0 ? '' : day === 1 ? '次日 ' : '+' + day + ' 天 ') + hours + ':' + minutes
}

export function itineraryLeg(route: DayItineraryResult['route'], index: number) {
  if (!route) return null
  return 'stops' in route ? route.legs[index]?.route ?? null : route.routes[0] ?? null
}
