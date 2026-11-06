/** Host 接口层：把原有业务服务暴露给面板，统一转换可展示的请求错误。 */
import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '../../../src/services/travel-data.ts'
import type {} from '../../../src/services/saved-places.ts'
import type {} from '../../../src/services/route-planner.ts'
import type {
  PlacesSearchResult, PlanRouteQuery, PlanRouteResult, RenameSavedPlaceRequest, SavedPlaceOption, SavedPlacesView,
  SavedPlaceTarget, SavedPlaceWriteResult, SavePlaceRequest, SearchPlacesQuery,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { tripPlannerWeb: TripPlannerController }
}

export class TripPlannerController extends TypertRemoteService {
  static inject = ['typert', 'travelData', 'savedPlaces', 'routePlanner']
  private revision = 0
  private readonly lifetime = new AbortController()

  constructor(ctx: Context) {
    super(ctx, 'tripPlannerWeb', { namespace: 'tripPlanner' })
    ctx.on('trip/saved-places-changed', () => { this.revision++ })
    ctx.effect(() => () => this.lifetime.abort())
  }

  @Remote('searchPlaces')
  async searchPlaces(query: SearchPlacesQuery, signal: AbortSignal): Promise<PlacesSearchResult> {
    return this.query(signal, () => this.ctx.travelData.searchPlaces(query, { signal }))
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

  /** 先监听再读列表。连续写入可以合并，但每帧的版本和收藏必须对应。 */
  @Remote({ mode: 'stream' })
  async *followSavedPlaces(signal: AbortSignal): AsyncIterable<SavedPlacesView> {
    const combined = AbortSignal.any([signal, this.lifetime.signal])
    let sentRevision = -1
    let wake: (() => void) | undefined
    const notify = () => wake?.()
    const off = this.ctx.on('trip/saved-places-changed', notify)
    combined.addEventListener('abort', notify, { once: true })
    try {
      while (!combined.aborted) {
        if (sentRevision === this.revision) await new Promise<void>(resolve => { wake = resolve })
        wake = undefined
        if (combined.aborted) return
        const revision = this.revision
        const places = await this.listSavedPlaces(combined)
        if (revision !== this.revision) continue
        sentRevision = revision
        yield { revision, places }
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
