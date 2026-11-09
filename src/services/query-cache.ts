/** 统一缓存服务约定；权限检查仍由调用方的原工具流水线负责。 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { QueryExecution } from './travel-data.ts'
import type { CacheRequest, CachedPlacesQuery, CachedPlacesView, QueryCacheStats } from '../contracts/query-cache.ts'
import type { Place } from '../contracts/travel.ts'

export interface LoadedQuery {
  response: unknown
  fetchedAt: string
  contexts: Parameters<NonNullable<QueryExecution['deferContext']>>[0][]
  concludesTurn: boolean
}
export interface CachedQuery extends LoadedQuery { ticket: number; generation: number; hit: boolean }

declare module '@deepseek-ai/cordis' { interface Context { queryCache: QueryCacheService } }

export default abstract class QueryCacheService extends Service {
  constructor(ctx: Context) { super(ctx, 'queryCache') }
  abstract obtain(request: CacheRequest, partition: string, signal: AbortSignal, refresh: boolean,
    load: (signal: AbortSignal) => Promise<LoadedQuery>): Promise<CachedQuery>
  abstract store(request: CacheRequest, loaded: CachedQuery, response: unknown, places: Place[], signal: AbortSignal): Promise<void>
  abstract listCachedPlaces(query: CachedPlacesQuery, signal: AbortSignal): Promise<CachedPlacesView>
  abstract touchPlace(placeId: string, signal: AbortSignal): Promise<void>
  abstract clear(signal: AbortSignal): Promise<void>
  abstract stats(): QueryCacheStats
  abstract recordCall(kind: 'search' | 'details' | 'route'): void
}
