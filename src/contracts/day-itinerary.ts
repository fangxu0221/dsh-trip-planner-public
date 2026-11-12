/** 单日行程的输入约束和时间表。分钟值表示从当天零点起的时间。 */
import { z } from 'zod'
import { endpointReferenceSchema, routeModes, type PlanMultiStopRouteResult, type PlanRouteResult, type RouteMode } from './routes.ts'

export const itineraryThemes = ['culture', 'park', 'landmark'] as const
export type ItineraryTheme = typeof itineraryThemes[number]
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u)

export const dayItineraryQuerySchema = z.object({
  city: z.string().trim().min(1).max(50),
  theme: z.enum(itineraryThemes),
  mode: z.enum(routeModes),
  startTime: time.optional(),
  endTime: time.optional(),
  stayMinutes: z.number().int().min(15).max(240).optional(),
  origin: endpointReferenceSchema.optional(),
  destination: endpointReferenceSchema.optional(),
  returnToOrigin: z.boolean().optional(),
}).strict()
export type DayItineraryQuery = z.infer<typeof dayItineraryQuerySchema>

export interface ItineraryVisit {
  placeId: string
  name: string
  address: string | null
  reason: string
  stayMinutes: number
}

export interface ItineraryItem {
  kind: 'visit' | 'travel'
  title: string
  startMinute: number | null
  endMinute: number | null
  placeId?: string
  /** 交通项对应路线的相邻段，单段路线使用 0。 */
  legIndex: number | null
}

export interface DayItineraryResult {
  source: 'AMAP'
  city: string
  theme: ItineraryTheme
  mode: RouteMode
  status: 'ready' | 'over-window' | 'incomplete' | 'insufficient-places'
  startMinute: number
  endMinute: number
  defaultStart: boolean
  defaultEnd: boolean
  visits: ItineraryVisit[]
  route: PlanRouteResult | PlanMultiStopRouteResult | null
  timeline: ItineraryItem[]
  finishMinute: number | null
  overByMinutes: number | null
  message: string | null
}
