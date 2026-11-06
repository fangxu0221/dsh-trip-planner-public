/** 角色二：持久化收藏提供方。业务检查在这里完成，文件一致性交给领域和 JSON 后端。 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { Config } from '../config.ts'
import { savedPlaceSchema, tripPlannerDomain, type SavedPlace } from '../domain.ts'
import SavedPlacesService, { type SavedPlaceEdit, type SavePlaceInput, type SavePlaceResult } from '../services/saved-places.ts'
import type { QueryExecution } from '../services/travel-data.ts'

export const name = 'trip-saved-places'
export const inject = ['storageDomain', 'travelData']

/** 统一全半角、空白和拉丁字母大小写，“ 家 ”与“家”会命中同一别名。 */
function aliasText(value: string): string {
  const text = typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/gu, ' ') : ''
  if (!text || text.length > 50) throw new HarnessError('别名不能为空，且最多 50 个字符。', 'TRIP_INVALID_ALIAS')
  return text
}

function aliasKey(value: string): string { return aliasText(value).toLowerCase() }

/** 返回深拷贝，外部修改坐标等嵌套对象也不会改变领域里的数据。 */
function copy(place: SavedPlace): SavedPlace { return structuredClone(place) }

export class PersistentSavedPlaces extends SavedPlacesService {
  private readonly favorites: KvTable<string, SavedPlace>
  private readonly lifetime = new AbortController()
  private queue: Promise<void> = Promise.resolve()
  private accepting = true

  constructor(ctx: Context, domain: Domain<typeof tripPlannerDomain>) {
    const favorites = domain.table('favorites')
    // schema 检查单条记录，下面补上跨记录的业务唯一性检查；非法历史文件不覆盖、不清空。
    const aliases = new Set<string>()
    const places = new Set<string>()
    for (const [key, place] of favorites.entries()) {
      const alias = aliasKey(place.alias)
      if (key !== place.id || aliases.has(alias) || places.has(place.placeId)) {
        throw new HarnessError('收藏文件存在重复别名、重复地点或不一致的编号，请保留原文件并检查数据。', 'TRIP_INVALID_STORED_DATA')
      }
      aliases.add(alias)
      places.add(place.placeId)
    }
    // 校验完成后才注册服务，避免调用方取得一份只初始化了一半的提供方。
    super(ctx)
    this.favorites = favorites
  }

  /** lookup→检查→详情→写入在同一队列执行，防止并发请求绕过唯一性检查。 */
  override async save(input: SavePlaceInput, execution: QueryExecution): Promise<SavePlaceResult> {
    const alias = aliasText(input.alias)
    const placeId = typeof input.placeId === 'string' ? input.placeId.trim() : ''
    if (!placeId || placeId.length > 100) throw new HarnessError('地点 ID 不能为空，且最多 100 个字符。', 'TRIP_INVALID_QUERY')
    const signal = AbortSignal.any([execution.signal, this.lifetime.signal])
    return this.mutate(async () => {
      signal.throwIfAborted()
      // 同一个来源地点只收藏一次；不同别名不会触发隐式改名或再次请求地图。
      const existing = [...this.favorites.entries()].find(([, value]) => value.placeId === placeId)?.[1]
      if (existing) return { created: false, place: copy(existing) }
      this.assertAliasAvailable(alias)
      const details = await this.ctx.travelData.getPlaceDetails(placeId, { ...execution, signal,
        // 回调转发到原对象，保留调用上下文方法的接收者。
        deferContext: context => execution.deferContext?.(context), concludeTurn: () => execution.concludeTurn?.(),
      })
      signal.throwIfAborted()
      this.assertOpen()
      const now = new Date().toISOString()
      // 写前校验与恢复时使用同一 schema；不得只依赖 TypeScript 类型。
      const place = savedPlaceSchema.parse({ id: randomUUID(), alias, source: details.source, placeId,
        name: details.place.name, address: details.place.address, city: details.place.city,
        coordinates: details.place.coordinates, fetchedAt: details.fetchedAt, createdAt: now, updatedAt: now })
      await this.favorites.put(place.id, place)
      this.ctx.emit('trip/saved-places-changed')
      return { created: true, place: copy(place) }
    })
  }

  /** 先等待本服务已接收的写操作结束，再返回本地快照，不访问远端。 */
  override async list(): Promise<SavedPlace[]> {
    await this.queue
    this.assertOpen()
    return [...this.favorites.entries()].map(([, place]) => copy(place))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  }

  override async get(alias: string): Promise<SavedPlace | null> {
    const key = aliasKey(alias)
    await this.queue
    this.assertOpen()
    const place = this.find(key)
    return place ? copy(place) : null
  }

  /** 改名只修改 alias、updatedAt，保留本地 ID、地点 ID 和原始详情快照。 */
  override async rename(alias: string, newAlias: string, edit?: SavedPlaceEdit): Promise<SavedPlace> {
    const key = aliasKey(alias)
    const text = aliasText(newAlias)
    return this.mutate(async () => {
      const current = this.editTarget(key, alias, edit)
      if (!current) throw new HarnessError('找不到该别名对应的收藏。', 'TRIP_SAVED_PLACE_NOT_FOUND')
      this.assertAliasAvailable(text, current.id)
      if (current.alias === text) return copy(current)
      const next = savedPlaceSchema.parse({ ...current, alias: text, updatedAt: new Date().toISOString() })
      await this.favorites.put(current.id, next)
      this.ctx.emit('trip/saved-places-changed')
      return copy(next)
    })
  }

  /** 重复取消收藏返回 removed:false，允许调用方安全重试，不删除其他地点。 */
  override async remove(alias: string, edit?: SavedPlaceEdit): Promise<{ removed: boolean; place: SavedPlace | null }> {
    const key = aliasKey(alias)
    return this.mutate(async () => {
      const current = this.editTarget(key, alias, edit)
      if (!current) return { removed: false, place: null }
      await this.favorites.delete(current.id)
      this.ctx.emit('trip/saved-places-changed')
      return { removed: true, place: copy(current) }
    })
  }

  /** 停止接收新操作、中止尚未完成的详情请求、等待已开始的写入；不删除文件。 */
  async stop(): Promise<void> {
    this.accepting = false
    this.lifetime.abort(new Error('收藏服务已卸载'))
    await this.queue
  }

  private find(key: string): SavedPlace | undefined {
    return [...this.favorites.entries()].find(([, value]) => aliasKey(value.alias) === key)?.[1]
  }

  /** 在写入队列内校验页面选中的记录，防止旧别名被另一条收藏重新使用。 */
  private editTarget(key: string, alias: string, edit?: SavedPlaceEdit): SavedPlace | undefined {
    edit?.signal.throwIfAborted()
    const current = this.find(key)
    if (edit && (current?.id !== edit.expectedId || current.alias !== alias)) {
      throw new HarnessError('收藏已变更，请从列表重新选择。', 'TRIP_SAVED_PLACE_CHANGED')
    }
    return current
  }

  private assertAliasAvailable(alias: string, ownId?: string): void {
    const existing = this.find(aliasKey(alias))
    if (existing && existing.id !== ownId) throw new HarnessError('别名“' + alias + '”已被其他地点使用，请换一个名称。', 'TRIP_ALIAS_CONFLICT')
  }

  private assertOpen(): void {
    if (!this.accepting) throw new HarnessError('收藏服务已关闭，请重新加载插件。', 'TRIP_STORAGE_CLOSED')
  }

  private mutate<T>(job: () => Promise<T>): Promise<T> {
    this.assertOpen()
    const request = this.queue.then(() => { this.assertOpen(); return job() })
    // 一次失败不能使队列永久失败；原请求仍把错误交给调用方。
    this.queue = request.then(() => {}, () => {})
    return request
  }
}

/** 领域打开成功后才注册服务；卸载等待业务队列，再关闭领域句柄。 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const opened = ctx.storageDomain.open(tripPlannerDomain)
  let service: PersistentSavedPlaces | undefined
  let stopping = false
  ctx.effect(() => async () => {
    stopping = true
    await service?.stop()
    await opened.then(domain => domain.close(), () => {})
    if (config.showLifecycleLogs) console.log('[地点收藏] 服务已卸载，本地 JSON 收藏保留')
  })
  const domain = await opened
  // 卸载可能发生在磁盘加载期间；此时由上面的清理函数关闭领域，不再注册服务。
  if (stopping) return
  try { service = new PersistentSavedPlaces(ctx, domain) }
  catch (error) { await domain.close(); throw error }
  if (config.showLifecycleLogs) console.log('[地点收藏] 已恢复 ' + (await service.list()).length + ' 个收藏')
}
