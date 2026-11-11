/** Host 接口层：把原有业务服务暴露给面板，统一转换可展示的请求错误。 */
import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '../../../src/services/travel-data.ts'
import type {} from '../../../src/services/saved-places.ts'
import type {} from '../../../src/services/route-planner.ts'
import type {} from '../../../src/services/saved-routes.ts'
import type {} from '../../../src/services/query-cache.ts'
import { SessionRoutes } from './session-routes.ts'
import type {
  PlacesSearchResult, PlanRouteQuery, PlanRouteResult, RenameSavedPlaceRequest, SavedPlaceOption, SavedPlacesView,
  PlanMultiStopRouteQuery, PlanMultiStopRouteResult,
  SavedPlaceTarget, SavedPlaceWriteResult, SavePlaceRequest, SearchPlacesQuery,
  RenameSavedRouteRequest, SavedRoutesView, SavedRouteWriteResult, SaveRouteRequest, UpdateSavedRouteEndpointsRequest,
  ChatRouteRequest, ChatRouteView,
  CachedPlacesQuery, CachedPlacesView, CachePlaceRequest, QueryCacheStats,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { tripPlannerWeb: TripPlannerController }
}

type ChangedEvent = 'trip/saved-places-changed' | 'trip/saved-routes-changed'

export class TripPlannerController extends TypertRemoteService {
  static inject = ['typert', 'travelData', 'savedPlaces', 'routePlanner', 'savedRoutes', 'sessions', 'queryCache']
  private readonly chatRoutes: SessionRoutes
  private readonly revision: Record<ChangedEvent, number> = {
    'trip/saved-places-changed': 0, 'trip/saved-routes-changed': 0,
  }
  private readonly lifetime = new AbortController()

  constructor(ctx: Context) {
    super(ctx, 'tripPlannerWeb', { namespace: 'tripPlanner' })
    this.chatRoutes = new SessionRoutes(ctx)
    ctx.on('trip/saved-places-changed', () => { this.revision['trip/saved-places-changed']++ })
    ctx.on('trip/saved-routes-changed', () => { this.revision['trip/saved-routes-changed']++ })
    ctx.effect(() => () => this.lifetime.abort())
  }

  @Remote('searchPlaces')
  async searchPlaces(query: SearchPlacesQuery, signal: AbortSignal): Promise<PlacesSearchResult> {
    return this.query(signal, () => this.ctx.travelData.searchPlaces(query, { signal }))
  }

  @Remote('listCachedPlaces')
  async listCachedPlaces(query: CachedPlacesQuery, signal: AbortSignal): Promise<CachedPlacesView> {
    return this.query(signal, () => this.ctx.queryCache.listCachedPlaces(query, signal))
  }

  @Remote('touchCachedPlace')
  async touchCachedPlace(request: CachePlaceRequest, signal: AbortSignal): Promise<{ updated: boolean }> {
    return this.query(signal, async () => { await this.ctx.queryCache.touchPlace(request.placeId, signal); return { updated: true } })
  }

  @Remote('cacheStats')
  async cacheStats(signal: AbortSignal): Promise<QueryCacheStats> {
    return this.query(signal, async () => this.ctx.queryCache.stats())
  }

  @Remote('clearPlaceCache')
  async clearPlaceCache(signal: AbortSignal): Promise<QueryCacheStats> {
    return this.query(signal, async () => { await this.ctx.queryCache.clear(signal); return this.ctx.queryCache.stats() })
  }

  @Remote('listSavedPlaces')
  async listSavedPlaces(signal: AbortSignal): Promise<SavedPlaceOption[]> {
    return this.query(signal, async () => {
      const places = await this.ctx.savedPlaces.list()
      return places.map(({ id, placeId, alias, name, address, city }) => ({ id, placeId, alias, name, address, city }))
    })
  }

  @Remote('savePlace')
  async savePlace(request: SavePlaceRequest, signal: AbortSignal): Promise<SavedPlaceWriteResult> {
    return this.query(signal, async () => {
      const { created, place } = await this.ctx.savedPlaces.save(request, { signal })
      return { changed: created, alias: place.alias }
    })
  }

  @Remote('renameSavedPlace')
  async renameSavedPlace(request: RenameSavedPlaceRequest, signal: AbortSignal): Promise<SavedPlaceWriteResult> {
    return this.query(signal, async () => {
      const { target, newAlias } = request
      const place = await this.ctx.savedPlaces.rename(target.alias, newAlias, { expectedId: target.id, signal })
      return { changed: place.alias !== target.alias, alias: place.alias }
    })
  }

  @Remote('removeSavedPlace')
  async removeSavedPlace(target: SavedPlaceTarget, signal: AbortSignal): Promise<SavedPlaceWriteResult> {
    return this.query(signal, async () => {
      const { removed } = await this.ctx.savedPlaces.remove(target.alias, { expectedId: target.id, signal })
      return { changed: removed, alias: target.alias }
    })
  }

  @Remote({ mode: 'stream' })
  async *followSavedPlaces(signal: AbortSignal): AsyncIterable<SavedPlacesView> {
    yield* this.follow('trip/saved-places-changed', signal, async (revision, active) =>
      ({ revision, places: await this.listSavedPlaces(active) }))
  }

  @Remote({ mode: 'stream' })
  async *followSavedRoutes(signal: AbortSignal): AsyncIterable<SavedRoutesView> {
    yield* this.follow('trip/saved-routes-changed', signal, async (revision, active) =>
      ({ revision, routes: await this.query(active, () => this.ctx.savedRoutes.list()) }))
  }

  @Remote('saveSavedRoute')
  async saveSavedRoute(request: SaveRouteRequest, signal: AbortSignal): Promise<SavedRouteWriteResult> {
    return this.query(signal, async () => ({ name: (await this.ctx.savedRoutes.save(request, signal)).name }))
  }

  @Remote('renameSavedRoute')
  async renameSavedRoute(request: RenameSavedRouteRequest, signal: AbortSignal): Promise<SavedRouteWriteResult> {
    return this.query(signal, async () => ({ name: (await this.ctx.savedRoutes.rename(request.id, request.name, signal)).name }))
  }

  @Remote('updateSavedRouteEndpoints')
  async updateSavedRouteEndpoints(request: UpdateSavedRouteEndpointsRequest, signal: AbortSignal): Promise<SavedRouteWriteResult> {
    return this.query(signal, async () => ({
      name: (await this.ctx.savedRoutes.updateEndpoints(request.id, request.endpoints, signal)).name,
    }))
  }

  @Remote('removeSavedRoute')
  async removeSavedRoute(id: string, signal: AbortSignal): Promise<SavedRouteWriteResult> {
    return this.query(signal, async () => ({ name: (await this.ctx.savedRoutes.remove(id, signal)).name }))
  }

  /** 先监听再读列表。连续写入可以合并，但每帧的版本和数据必须对应。 */
  private async *follow<T>(event: ChangedEvent, signal: AbortSignal,
    read: (revision: number, signal: AbortSignal) => Promise<T>): AsyncIterable<T> {
    const combined = AbortSignal.any([signal, this.lifetime.signal])
    let sentRevision = -1
    let wake: (() => void) | undefined
    const notify = () => wake?.()
    const off = this.ctx.on(event, notify)
    combined.addEventListener('abort', notify, { once: true })
    try {
      while (!combined.aborted) {
        if (sentRevision === this.revision[event]) await new Promise<void>(resolve => { wake = resolve })
        wake = undefined
        if (combined.aborted) return
        const revision = this.revision[event]
        const view = await read(revision, combined)
        if (revision !== this.revision[event]) continue
        sentRevision = revision
        yield view
      }
    } catch (error) {
      if (!combined.aborted) throw error
    } finally {
      off()
      combined.removeEventListener('abort', notify)
    }
  }

  @Remote('planRoute')
  async planRoute(query: PlanRouteQuery, signal: AbortSignal): Promise<PlanRouteResult> {
    return this.query(signal, () => this.ctx.routePlanner.plan(query, { signal }))
  }

  @Remote('planMultiStopRoute')
  async planMultiStopRoute(query: PlanMultiStopRouteQuery, signal: AbortSignal): Promise<PlanMultiStopRouteResult> {
    return this.query(signal, () => this.ctx.routePlanner.planMultiStop(query, { signal }))
  }

  // 让 Harness 网关在调用前按 sessionId 校验会话访问权限。
  @Remote({ mode: 'stream', resources: { session: request => request.sessionId as Parameters<Context['sessions']['get']>[0] } })
  followChatRoute(request: ChatRouteRequest, signal: AbortSignal): AsyncIterable<ChatRouteView> {
    return this.chatRoutes.follow(request.sessionId, signal)
  }

  private async query<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    signal.throwIfAborted()
    try {
      const value = await run()
      signal.throwIfAborted()
      return value
    } catch (error) {
      signal.throwIfAborted()
      // 业务错误已有稳定编号；上游原始错误只留在 Host 边界内。
      if (error instanceof HarnessError && error.code.startsWith('TRIP_')) {
        const message = error.code === 'TRIP_UPSTREAM_ERROR' ? '高德地图查询失败，请稍后重试。' : error.message
        throw new RemoteError('trip-planner/query-failed', message, { reason: error.code })
      }
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new RemoteError('trip-planner/query-failed', '查询超时，请重试。', { reason: 'timeout' })
      }
      throw error
    }
  }
}
