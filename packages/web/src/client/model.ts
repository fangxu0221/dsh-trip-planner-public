/** 收藏跨会话共享，搜索与路线查询按右栏标签页隔离。 */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { RemoteStreamCarrierError, type ClientRemote, type RemoteStream } from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '../../lib/typert.remote-client.js'
import type {
  PlacesSearchResult, PlanRouteQuery, PlanRouteResult, RenameSavedPlaceRequest, SavedPlacesView,
  SavedPlaceTarget, SavedPlaceWriteResult, SavePlaceRequest, SearchPlacesQuery,
} from '../types.ts'

type QueryState<T> = { status: 'idle' | 'loading' } | { status: 'success'; value: T } | { status: 'error'; message: string }
type QueryResult<T> = { ok: true; value: T } | { ok: false; error: { message: string } }
interface TripResults { search: PlacesSearchResult; route: PlanRouteResult }
interface FavoritesState {
  status: 'connecting' | 'live' | 'reconnecting' | 'failed'
  view: SavedPlacesView | null
}
type WriteState = { status: 'idle' | 'pending' } | { status: 'success' | 'error'; message: string }
type TripQueryState = { [Key in keyof TripResults]: QueryState<TripResults[Key]> }
export interface TripClientState {
  favorites: FavoritesState
  write: WriteState
}
type TripApi = ClientRemote['tripPlanner']
type WriteCall = (signal: AbortSignal) => ReturnType<TripApi['savePlace']>

export class TripClientModel {
  readonly state = createSnapshotStore<TripClientState>({
    favorites: { status: 'connecting', view: null }, write: { status: 'idle' },
  })
  private readonly api: TripApi
  private readonly createStream: ClientRemote['$stream']
  private readonly lifetime = new AbortController()
  private stream?: RemoteStream<SavedPlacesView>
  private subscription = 0
  private disposed = false

  constructor(api: TripApi, createStream: ClientRemote['$stream']) {
    this.api = api
    this.createStream = createStream
  }

  /** 重连保留最后一份收藏，收到新连接首帧后再替换。 */
  async connectFavorites(): Promise<void> {
    if (this.disposed) return
    const subscription = ++this.subscription
    this.state.update(state => { state.favorites.status = 'connecting' })
    try {
      await this.stream?.dispose()
      if (subscription !== this.subscription) return
      this.stream = this.createStream<SavedPlacesView>({
        name: 'trip planner saved places',
        open: signal => this.api.followSavedPlaces(signal),
        ended: accepted => accepted ? new RemoteStreamCarrierError('收藏订阅已断开') : new Error('未收到收藏首帧'),
        carrierFailed: () => {
          if (subscription === this.subscription) this.state.update(state => { state.favorites.status = 'reconnecting' })
        },
      })
      let generation = -1
      let revision = -1
      for await (const item of this.stream) {
        if (subscription !== this.subscription) return
        if (generation !== item.generation || item.value.revision > revision) {
          generation = item.generation
          revision = item.value.revision
          this.state.update(state => { state.favorites = { status: 'live', view: item.value } })
        }
        item.accept()
      }
    } catch {
      if (subscription === this.subscription) this.state.update(state => { state.favorites.status = 'failed' })
    }
  }

  savePlace(request: SavePlaceRequest): Promise<boolean> {
    return this.write(signal => this.api.savePlace(request, signal),
      result => result.changed ? '已收藏「' + result.alias + '」。' : '这个地点已收藏为「' + result.alias + '」。')
  }

  renameSavedPlace(request: RenameSavedPlaceRequest): Promise<boolean> {
    return this.write(signal => this.api.renameSavedPlace(request, signal),
      result => result.changed ? '已改名为「' + result.alias + '」。' : '收藏名称保持为「' + result.alias + '」。')
  }

  removeSavedPlace(target: SavedPlaceTarget): Promise<boolean> {
    return this.write(signal => this.api.removeSavedPlace(target, signal),
      result => '已取消收藏「' + result.alias + '」。')
  }

  dispose(): void {
    this.disposed = true
    this.subscription++
    this.lifetime.abort()
    void this.stream?.dispose()
  }

  /** 写请求只更新反馈，收藏列表完全由订阅提供。 */
  private async write(invoke: WriteCall, message: (result: SavedPlaceWriteResult) => string): Promise<boolean> {
    const snapshot = this.state.getSnapshot()
    if (this.disposed || snapshot.write.status === 'pending' || snapshot.favorites.status !== 'live') return false
    this.state.update(state => { state.write = { status: 'pending' } })
    try {
      const result = await invoke(this.lifetime.signal)
      if (this.disposed) return false
      if (result.ok) {
        this.state.update(state => { state.write = { status: 'success', message: message(result.value) } })
        return true
      }
      if (result.error.code === 'trip-planner/query-failed') {
        this.state.update(state => { state.write = { status: 'error', message: result.error.message } })
        return false
      }
    } catch {
      // 连接错误可能发生在提交之后，先用新快照确认结果。
    }
    if (!this.disposed) {
      this.state.update(state => {
        state.write = { status: 'error', message: '保存结果暂未确认。收藏同步后，请核对列表再决定是否重试。' }
      })
      void this.connectFavorites()
    }
    return false
  }
}

export class TripQueries {
  readonly state = createSnapshotStore<TripQueryState>({ search: { status: 'idle' }, route: { status: 'idle' } })
  private readonly pending: Partial<Record<keyof TripResults, AbortController>> = {}
  private readonly api: Pick<TripApi, 'searchPlaces' | 'planRoute'>

  constructor(api: Pick<TripApi, 'searchPlaces' | 'planRoute'>) { this.api = api }

  search(query: SearchPlacesQuery): Promise<void> {
    return this.run('search', signal => this.api.searchPlaces(query, signal))
  }

  plan(query: PlanRouteQuery): Promise<void> {
    return this.run('route', signal => this.api.planRoute(query, signal))
  }

  reset(key: 'search' | 'route'): void {
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
