/** 路线数据约定：输入引用具体地点，输出统一单位，并保留公共交通的分段和可选线路。 */
import { z } from 'zod'
import { maxMultiStopPlaces } from './route-limits.ts'
import type { Coordinates } from './travel.ts'

export const routeModes = ['walking', 'bicycling', 'driving', 'transit'] as const
export type RouteMode = typeof routeModes[number]

/** 只接受收藏别名或已选中的 POI；严格拒绝模型额外填写坐标等字段。 */
export const endpointReferenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('saved'), alias: z.string().trim().min(1).max(50), expectedId: z.uuid().optional() }).strict(),
  z.object({ kind: z.literal('poi'), placeId: z.string().trim().min(1).max(100) }).strict(),
])
export const planRouteQuerySchema = z.object({
  origin: endpointReferenceSchema, destination: endpointReferenceSchema, mode: z.enum(routeModes),
}).strict()
export type EndpointReference = z.infer<typeof endpointReferenceSchema>
export type PlanRouteQuery = z.infer<typeof planRouteQuerySchema>

export const routeOrders = ['given', 'optimized'] as const
export type RouteOrder = typeof routeOrders[number]

export const planMultiStopRouteQuerySchema = z.object({
  stops: z.array(endpointReferenceSchema).min(3).max(maxMultiStopPlaces), mode: z.enum(routeModes),
  order: z.enum(routeOrders).optional(), pinStart: z.boolean().optional(), pinEnd: z.boolean().optional(),
}).strict().refine(query => query.order === 'optimized'
  ? query.pinStart !== undefined && query.pinEnd !== undefined
  : query.pinStart === undefined && query.pinEnd === undefined)
export type PlanMultiStopRouteQuery = z.infer<typeof planMultiStopRouteQuerySchema>

/** 已解析的端点，坐标必需；城市在非公交查询中允许未知。时间表示地点详情快照时间。 */
export interface RouteEndpoint {
  placeId: string
  savedPlaceId?: string
  alias: string | null
  name: string
  address: string | null
  city: string | null
  coordinates: Coordinates
  detailsFetchedAt: string
}

/** 同一个公共交通路段中的可选线路，不是需要依次乘坐的多次换乘。 */
export interface TransitOption {
  lineName: string | null
  serviceName?: string
  direction?: string
  stopsToArrival?: number
  vehicleType: string | null
  departureStop: string | null
  arrivalStop: string | null
  distanceMeters: number | null
  durationSeconds: number | null
}

export interface WalkingStep { instruction: string | null; distanceMeters: number | null; durationSeconds: number | null }

export interface RouteSegment {
  kind: 'walking' | 'bicycling' | 'driving' | 'public-transport' | 'railway' | 'unknown'
  instruction: string | null
  walkingSteps?: WalkingStep[]
  entrance: string | null
  exit: string | null
  distanceMeters: number | null
  durationSeconds: number | null
  transportOptions: TransitOption[]
}

export interface RouteAlternative {
  index: number
  distanceMeters: number | null
  durationSeconds: number | null
  costCny: number | null
  /** 驾车 tolls 只指来源返回的道路收费，不冒充油费、停车费等总成本。 */
  costKind: 'fare' | 'tolls' | null
  segments: RouteSegment[]
}

export interface ResolvedRouteQuery { origin: RouteEndpoint; destination: RouteEndpoint; mode: RouteMode }
export interface RouteDataResult {
  source: 'AMAP'
  fetchedAt: string
  status: 'found' | 'no-route'
  sourceCount: number
  returned: number
  truncated: boolean
  routes: RouteAlternative[]
  warnings: string[]
}
export interface PlanRouteResult extends RouteDataResult, ResolvedRouteQuery {}

/** 下标从零开始，引用 stops 中相邻的两个地点。 */
export interface MultiStopLeg {
  from: number
  to: number
  status: 'found' | 'no-route' | 'query-failed' | 'not-queried'
  route: RouteAlternative | null
  fetchedAt: string | null
  warnings: string[]
  message: string | null
}

export interface PlanMultiStopRouteResult {
  source: 'AMAP'
  stops: RouteEndpoint[]
  mode: RouteMode
  order: RouteOrder
  status: 'complete' | 'incomplete'
  legs: MultiStopLeg[]
  totalDurationSeconds: number | null
  totalDistanceMeters: number | null
}
