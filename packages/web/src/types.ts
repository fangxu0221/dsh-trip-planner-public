/** Typert 传输类型在 Web 包内声明；Controller 与现有服务之间由 TypeScript 检查结构兼容性。 */
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'trip-planner/query-failed': { reason: string }
  }
}

export interface SearchPlacesQuery { keywords: string; city?: string; refresh?: boolean }
export interface CachedPlacesQuery { keywords?: string; city?: string }
export interface CachedPlaceOption { placeId: string; name: string; address: string | null; city: string | null; fetchedAt: string }
export interface CachedPlacesView { places: CachedPlaceOption[] }
export interface CachePlaceRequest { placeId: string }
export interface QueryCacheStats {
  entries: number; cacheHits: number; joinedRequests: number; searchCalls: number; detailCalls: number; routeCalls: number; writeFailures: number
}

interface Coordinates { longitude: number; latitude: number }

interface Place {
  id: string
  name: string
  address: string | null
  city: string | null
  coordinates: Coordinates | null
}

export interface PlacesSearchResult {
  source: 'AMAP'
  fetchedAt: string
  query: { keywords: string; city: string; limit: number }
  sourceCount: number
  returned: number
  truncated: boolean
  places: Place[]
  warnings: string[]
}

export interface SavedPlaceOption {
  id: string
  placeId: string
  alias: string
  name: string
  address: string | null
  city: string | null
}

export interface SavedPlacesView { revision: number; places: SavedPlaceOption[] }
export interface SavePlaceRequest { placeId: string; alias: string }
export interface SavedPlaceTarget { id: string; alias: string }
export interface RenameSavedPlaceRequest { target: SavedPlaceTarget; newAlias: string }
export interface SavedPlaceWriteResult { changed: boolean; alias: string }

export type RouteMode = 'walking' | 'bicycling' | 'driving' | 'transit'
export type EndpointReference = { kind: 'saved'; alias: string; expectedId?: string } | { kind: 'poi'; placeId: string }
export interface PlanRouteQuery { origin: EndpointReference; destination: EndpointReference; mode: RouteMode }

interface RouteEndpoint {
  placeId: string
  alias: string | null
  name: string
  address: string | null
  city: string | null
  coordinates: Coordinates
  detailsFetchedAt: string
}

interface TransitOption {
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

interface WalkingStep { instruction: string | null; distanceMeters: number | null; durationSeconds: number | null }

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

interface RouteAlternative {
  index: number
  distanceMeters: number | null
  durationSeconds: number | null
  costCny: number | null
  costKind: 'fare' | 'tolls' | null
  segments: RouteSegment[]
}

export interface PlanRouteResult {
  origin: RouteEndpoint
  destination: RouteEndpoint
  mode: RouteMode
  source: 'AMAP'
  fetchedAt: string
  status: 'found' | 'no-route'
  sourceCount: number
  returned: number
  truncated: boolean
  routes: RouteAlternative[]
  warnings: string[]
}

export type RouteOrder = 'given' | 'optimized'
export interface PlanMultiStopRouteQuery {
  stops: EndpointReference[]
  mode: RouteMode
  order?: RouteOrder
  pinStart?: boolean
  pinEnd?: boolean
}
export interface PlanMultiStopRouteResult {
  source: 'AMAP'
  stops: RouteEndpoint[]
  mode: RouteMode
  order: RouteOrder
  status: 'complete' | 'incomplete'
  legs: {
    from: number
    to: number
    status: 'found' | 'no-route' | 'query-failed' | 'not-queried'
    route: RouteAlternative | null
    fetchedAt: string | null
    warnings: string[]
    message: string | null
  }[]
  totalDurationSeconds: number | null
  totalDistanceMeters: number | null
}
export type RouteResult = PlanRouteResult | PlanMultiStopRouteResult

export interface ChatRouteRequest { sessionId: string }
/** 同一轮、同一有序地点列表的交通方式结果。条目版本按发起顺序递增。 */
export interface ChatRouteItem { revision: number; result: RouteResult }
export interface ChatRouteView {
  revision: number
  groupId: string
  results: ChatRouteItem[]
}

export type SavedRouteEndpoint = { kind: 'saved'; savedPlaceId: string; label: string }
  | { kind: 'poi'; placeId: string; label: string }
export interface SavedRouteEndpoints { origin: SavedRouteEndpoint; destination: SavedRouteEndpoint }
export interface SaveRouteRequest extends SavedRouteEndpoints { name: string; mode: RouteMode }
export interface SavedRouteOption extends SaveRouteRequest { id: string; updatedAt: string }
export interface SavedRoutesView { revision: number; routes: SavedRouteOption[] }
export interface RenameSavedRouteRequest { id: string; name: string }
export interface UpdateSavedRouteEndpointsRequest { id: string; endpoints: SavedRouteEndpoints }
export interface SavedRouteWriteResult { name: string }
