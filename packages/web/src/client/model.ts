/** 收藏与常用路线跨会话共享，搜索与路线查询按右栏标签页隔离。 */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { RemoteStreamCarrierError, type ClientRemote, type RemoteStream } from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '../../lib/typert.remote-client.js'
import type { RemoteResult, RemoteStreamHandle } from '@deepseek-ai/dsh-typert-protocol'
import type {
  PlacesSearchResult, PlanRouteQuery, PlanRouteResult, RenameSavedPlaceRequest, SavedPlacesView,
  SavedPlaceTarget, SavedPlaceWriteResult, SavePlaceRequest, SearchPlacesQuery,
  RenameSavedRouteRequest, SavedRoutesView, SavedRouteWriteResult, SaveRouteRequest, UpdateSavedRouteEndpointsRequest, ChatRouteView,
  CachedPlacesQuery, CachedPlacesView, QueryCacheStats,
} from '../types.ts'

type QueryState<T> = { status: 'idle' | 'loading' } | { status: 'success'; value: T } | { status: 'error'; message: string }
type QueryResult<T> = { ok: true; value: T } | { ok: false; error: { message: string } }
interface TripResults { search: PlacesSearchResult; route: PlanRouteResult; cached: CachedPlacesView; cacheStats: QueryCacheStats }
interface CollectionState<T> {
  status: 'connecting' | 'live' | 'reconnecting' | 'failed'
  view: T | null
}
interface CollectionViews { favorites: SavedPlacesView; savedRoutes: SavedRoutesView }
type Collection = keyof CollectionViews
type WriteState = { status: 'idle' | 'pending' } | { status: 'success' | 'error'; message: string }
type TripQueryState = { [Key in keyof TripResults]: QueryState<TripResults[Key]> }
export type TripClientState = { [K in Collection]: CollectionState<CollectionViews[K]> } & {
  write: WriteState
  routeWrite: WriteState
  chatRoute: { sessionId: string; view: ChatRouteView } | null
}
type TripApi = ClientRemote['tripPlanner']

export function chatRouteVersion(view: ChatRouteView): string {
  return view.results.length ? view.groupId + ':' + view.revision : ''
}

export class TripClientModel {
  readonly state = createSnapshotStore<TripClientState>({
    favorites: { status: 'connecting', view: null }, write: { status: 'idle' },
    savedRoutes: { status: 'connecting', view: null }, routeWrite: { status: 'idle' },
    chatRoute: null,
  })
  private readonly api: TripApi
  private readonly createStream: ClientRemote['$stream']
  private readonly lifetime = new AbortController()
  private readonly streams: Partial<Record<Collection, Pick<RemoteStream<unknown>, 'dispose'>>> = {}
  private readonly subscription = { favorites: 0, savedRoutes: 0 }
  private disposed = false
  private chatSessionId?: string
  private chatStream?: RemoteStream<ChatRouteView>
  private readonly revealedChatRoutes = new Map<string, string>()
  private readonly dismissedChatRoutes = new Map<string, string>()

  constructor(api: TripApi, createStream: ClientRemote['$stream']) {
    this.api = api
    this.createStream = createStream
  }

  connectFavorites(): Promise<void> {
    return this.connect('favorites', signal => this.api.followSavedPlaces(signal), '地点收藏')
  }

  connectSavedRoutes(): Promise<void> {
    return this.connect('savedRoutes', signal => this.api.followSavedRoutes(signal), '常用路线')
  }

  /** 只跟随前台会话。会话切换时即刻丢弃旧帧，重连重复帧不会再打开右栏。 */
  followChatRoute(sessionId: string | undefined, reveal: () => void): void {
    if (this.disposed || this.chatSessionId === sessionId) return
    this.chatSessionId = sessionId
    void this.chatStream?.dispose().catch(() => {})
    this.chatStream = undefined
    this.state.update(state => { state.chatRoute = null })
    if (!sessionId) return
    const stream = this.createStream<ChatRouteView>({
      name: '对话路线',
      open: signal => this.api.followChatRoute({ sessionId }, signal),
      ended: accepted => accepted ? new RemoteStreamCarrierError('对话路线订阅已断开') : new Error('未收到对话路线首帧'),
    })
    this.chatStream = stream
    void this.readChatRoute(sessionId, stream, reveal)
  }

  /** 清空整组对话路线，同组晚到方式和重连快照也保持隐藏。 */
  dismissChatRoute(sessionId: string): void {
    const current = this.state.getSnapshot().chatRoute
    if (!current || current.sessionId !== sessionId) return
    this.dismissedChatRoutes.set(sessionId, current.view.groupId)
    this.state.update(state => { state.chatRoute = null })
  }

  private async readChatRoute(sessionId: string, stream: RemoteStream<ChatRouteView>, reveal: () => void): Promise<void> {
    try {
      for await (const frame of stream) {
        if (this.chatStream !== stream || this.disposed) return
        frame.accept()
        const view = frame.value
        const version = chatRouteVersion(view)
        if (version && this.dismissedChatRoutes.get(sessionId) === view.groupId) continue
        this.state.update(state => { state.chatRoute = view.results.length ? { sessionId, view } : null })
        if (!version) continue
        if (this.revealedChatRoutes.get(sessionId) === view.groupId) continue
        this.revealedChatRoutes.set(sessionId, view.groupId)
        reveal()
      }
    } catch {
      // 路线订阅失效时保留最后的有效结果，手动查询仍可使用。
    }
  }

  /** 两条订阅独立排序。重连保留最后一份列表，收到新连接首帧后再替换。 */
  private async connect<K extends Collection>(key: K,
    open: (signal: AbortSignal) => RemoteStreamHandle<CollectionViews[K], never>, label: string): Promise<void> {
    if (this.disposed) return
    const subscription = ++this.subscription[key]
    this.state.update(state => { state[key].status = 'connecting' })
    try {
      await this.streams[key]?.dispose()
      if (subscription !== this.subscription[key]) return
      const stream = this.createStream<CollectionViews[K]>({
        name: label,
        open,
        ended: accepted => accepted ? new RemoteStreamCarrierError(label + '订阅已断开') : new Error('未收到' + label + '首帧'),
        carrierFailed: () => {
          if (subscription === this.subscription[key]) this.state.update(state => { state[key].status = 'reconnecting' })
        },
      })
      this.streams[key] = stream
      let generation = -1
      let revision = -1
      for await (const item of stream) {
        if (subscription !== this.subscription[key]) return
        if (generation !== item.generation || item.value.revision > revision) {
          generation = item.generation
          revision = item.value.revision
          this.state.update(state => {
            state[key].status = 'live'
            state[key].view = item.value
          })
        }
        item.accept()
      }
    } catch {
      if (subscription === this.subscription[key]) this.state.update(state => { state[key].status = 'failed' })
    }
  }

  savePlace(request: SavePlaceRequest): Promise<boolean> {
    return this.write<SavedPlaceWriteResult>('favorites', signal => this.api.savePlace(request, signal),
      result => result.changed ? '已收藏「' + result.alias + '」。' : '这个地点已收藏为「' + result.alias + '」。')
  }

  renameSavedPlace(request: RenameSavedPlaceRequest): Promise<boolean> {
    return this.write<SavedPlaceWriteResult>('favorites', signal => this.api.renameSavedPlace(request, signal),
      result => result.changed ? '已改名为「' + result.alias + '」。' : '收藏名称保持为「' + result.alias + '」。')
  }

  removeSavedPlace(target: SavedPlaceTarget): Promise<boolean> {
    return this.write<SavedPlaceWriteResult>('favorites', signal => this.api.removeSavedPlace(target, signal),
      result => '已取消收藏「' + result.alias + '」。')
  }

  saveSavedRoute(request: SaveRouteRequest): Promise<boolean> {
    return this.write<SavedRouteWriteResult>('savedRoutes', signal => this.api.saveSavedRoute(request, signal),
      result => '已保存常用路线「' + result.name + '」。')
  }

  renameSavedRoute(request: RenameSavedRouteRequest): Promise<boolean> {
    return this.write<SavedRouteWriteResult>('savedRoutes', signal => this.api.renameSavedRoute(request, signal),
      result => '路线已命名为「' + result.name + '」。')
  }

  updateSavedRouteEndpoints(request: UpdateSavedRouteEndpointsRequest): Promise<boolean> {
    return this.write<SavedRouteWriteResult>('savedRoutes', signal => this.api.updateSavedRouteEndpoints(request, signal),
      result => '已更新「' + result.name + '」的起终点。')
  }

  removeSavedRoute(id: string): Promise<boolean> {
    return this.write<SavedRouteWriteResult>('savedRoutes', signal => this.api.removeSavedRoute(id, signal),
      result => '已删除常用路线「' + result.name + '」。')
  }

  dispose(): void {
    this.disposed = true
    this.lifetime.abort()
    void this.chatStream?.dispose().catch(() => {})
    this.revealedChatRoutes.clear()
    this.dismissedChatRoutes.clear()
    for (const key of ['favorites', 'savedRoutes'] as const) {
      this.subscription[key]++
      void this.streams[key]?.dispose()
    }
  }

  /** 写请求只更新反馈，列表完全由订阅提供。 */
  private async write<T>(collection: Collection, invoke: (signal: AbortSignal) => Promise<RemoteResult<T>>,
    message: (result: T) => string): Promise<boolean> {
    const key = collection === 'favorites' ? 'write' : 'routeWrite'
    const snapshot = this.state.getSnapshot()
    if (this.disposed || snapshot[key].status === 'pending' || snapshot[collection].status !== 'live') return false
    this.state.update(state => { state[key] = { status: 'pending' } })
    try {
      const result = await invoke(this.lifetime.signal)
      if (this.disposed) return false
      if (result.ok) {
        this.state.update(state => { state[key] = { status: 'success', message: message(result.value) } })
        return true
      }
      if (result.error.code === 'trip-planner/query-failed') {
        this.state.update(state => { state[key] = { status: 'error', message: result.error.message } })
        return false
      }
    } catch {
      // 连接错误可能发生在提交之后，先用新快照确认结果。
    }
    if (!this.disposed) {
      this.state.update(state => {
        state[key] = { status: 'error', message: '保存结果暂未确认。同步后，请核对列表再决定是否重试。' }
      })
      void (collection === 'favorites' ? this.connectFavorites() : this.connectSavedRoutes())
    }
    return false
  }
}

export class TripQueries {
  readonly state = createSnapshotStore<TripQueryState>({ search: { status: 'idle' }, route: { status: 'idle' }, cached: { status: 'idle' }, cacheStats: { status: 'idle' } })
  private readonly pending: Partial<Record<keyof TripResults, AbortController>> = {}
  private readonly api: Pick<TripApi, 'searchPlaces' | 'planRoute' | 'listCachedPlaces' | 'touchCachedPlace' | 'cacheStats' | 'clearPlaceCache'>
  private clearingCache = false

  constructor(api: TripQueries['api']) { this.api = api }

  search(query: SearchPlacesQuery): Promise<void> {
    return this.run('search', signal => this.api.searchPlaces(query, signal))
  }

  plan(query: PlanRouteQuery): Promise<void> {
    return this.run('route', signal => this.api.planRoute(query, signal))
  }

  cachedPlaces(query: CachedPlacesQuery): Promise<void> {
    return this.run('cached', signal => this.api.listCachedPlaces(query, signal))
  }

  cacheStats(): Promise<void> {
    return this.clearingCache ? Promise.resolve() : this.run('cacheStats', signal => this.api.cacheStats(signal))
  }

  async clearPlaceCache(): Promise<void> {
    if (this.clearingCache) return
    this.clearingCache = true
    this.reset('cached')
    try { await this.run('cacheStats', signal => this.api.clearPlaceCache(signal)) }
    finally { this.clearingCache = false }
  }

  async touchCachedPlace(placeId: string): Promise<void> {
    try { await this.api.touchCachedPlace({ placeId }, AbortSignal.timeout(5000)) }
    catch { /* 最近选择排序是辅助信息，不阻塞用户选点。 */ }
  }

  reset(key: keyof TripResults): void {
    this.pending[key]?.abort()
    delete this.pending[key]
    if (this.state.getSnapshot()[key].status !== 'idle') this.update(key, { status: 'idle' })
  }

  private update<K extends keyof TripResults>(key: K, next: QueryState<TripResults[K]>): void {
    this.state.update(state => { state[key] = next as TripQueryState[K] })
  }

  private async run<K extends keyof TripResults>(key: K, invoke: (signal: AbortSignal) => Promise<QueryResult<TripResults[K]>>): Promise<void> {
    this.pending[key]?.abort()
    const request = new AbortController()
    this.pending[key] = request
    this.update(key, { status: 'loading' })
    try {
      const result = await invoke(request.signal)
      // 即便传输层已经返回迟到结果，取消的请求也不能再更新状态。
      if (request.signal.aborted) return
      this.update(key, result.ok ? { status: 'success', value: result.value } : { status: 'error', message: result.error.message })
    } catch {
      if (!request.signal.aborted) this.update(key, { status: 'error', message: '查询失败，请检查连接后重试。' })
    } finally {
      if (this.pending[key] === request) delete this.pending[key]
    }
  }
}
