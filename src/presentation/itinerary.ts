/** 对话和右栏共用单日行程的主题名与时刻格式。 */
import type { DayItineraryResult, ItineraryTheme } from '../contracts/day-itinerary.ts'

export const themeLabels = { culture: '文化展馆', park: '公园休闲', landmark: '城市地标' } satisfies Record<ItineraryTheme, string>

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
