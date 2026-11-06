/** Typert 传输类型在 Web 包内声明；Controller 与现有服务之间由 TypeScript 检查结构兼容性。 */
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'trip-planner/query-failed': { reason: string }
  }
}

export interface SearchPlacesQuery { keywords: string; city?: string }

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
