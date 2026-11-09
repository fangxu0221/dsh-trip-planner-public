/** JSON 缓存与进行中请求合并；一次等待者取消不终止其他等待者。 */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import type { Config } from '../config.ts'
import { cacheRequestSchema, queryCacheEntrySchema, type CacheRequest, type CachedPlacesQuery, type CachedPlacesView, type QueryCacheStats } from '../contracts/query-cache.ts'
import type { Place } from '../contracts/travel.ts'
import { queryCacheDomain } from '../query-cache-domain.ts'
import QueryCacheService, { type CachedQuery, type LoadedQuery } from '../services/query-cache.ts'

export const name = 'trip-query-cache'
export const inject = ['storageDomain']
const keyOf = (request: CacheRequest) => createHash('sha256').update(JSON.stringify(request.kind === 'search'
  ? ['search', request.keywords, request.city, request.limit] : ['details', request.placeId])).digest('hex')
const text = (value: string) => value.normalize('NFKC').trim().toLowerCase()

interface Flight { controller: AbortController; promise: Promise<CachedQuery>; waiters: number }

export class PersistentQueryCache extends QueryCacheService {
  private readonly domain: Domain<typeof queryCacheDomain>
  private readonly config: Config
  private readonly clock: () => number
  private queue = Promise.resolve()
  private readonly lifetime = new AbortController()
  private readonly flights = new Map<string, Flight>()
  private readonly tasks = new Set<Promise<CachedQuery>>()
  private readonly committed = new Map<string, number>()
  private ticket = 0
  private generation = 0
  private readonly counters = { cacheHits: 0, joinedRequests: 0, searchCalls: 0, detailCalls: 0, routeCalls: 0, writeFailures: 0 }

  constructor(ctx: Context, domain: Domain<typeof queryCacheDomain>, config: Config, clock: () => number = () => Date.now()) {
    super(ctx)
    this.domain = domain
    this.config = config
    this.clock = clock
    for (const [id, entry] of domain.table('entries').entries()) {
      if (id !== entry.id || id !== keyOf(entry.request)) throw new HarnessError('地点缓存编号不一致，请保留缓存文件供排查。', 'TRIP_INVALID_STORED_DATA')
    }
  }

  override async obtain(request: CacheRequest, partition: string, signal: AbortSignal, refresh: boolean,
    load: (signal: AbortSignal) => Promise<LoadedQuery>): Promise<CachedQuery> {
    signal.throwIfAborted()
    this.lifetime.signal.throwIfAborted()
    const id = keyOf(cacheRequestSchema.parse(request))
    const entry = this.domain.table('entries').get(id)
    if (this.config.cacheEnabled && !refresh && entry && entry.expiresAt > this.clock()) {
      this.counters.cacheHits++
      return { response: structuredClone(entry.response), fetchedAt: entry.fetchedAt, contexts: [], concludesTurn: false,
        ticket: 0, generation: this.generation, hit: true }
    }
    const flightKey = JSON.stringify([this.generation, partition, id, refresh])
    let flight = this.config.cacheEnabled ? this.flights.get(flightKey) : undefined
    if (flight?.controller.signal.aborted) flight = undefined
    if (flight) this.counters.joinedRequests++
    else {
      const controller = new AbortController()
      const ticket = ++this.ticket
      const generation = this.generation
      flight = { controller, waiters: 0, promise: undefined! }
      const owned = flight
      owned.promise = Promise.resolve().then(() => load(AbortSignal.any([controller.signal, this.lifetime.signal])))
        .then(value => ({ ...value, ticket, generation, hit: false }))
        .finally(() => { this.tasks.delete(owned.promise); if (this.flights.get(flightKey) === owned) this.flights.delete(flightKey) })
      this.tasks.add(owned.promise)
      // 取消的等待者可先返回，后台任务仍由缓存服务持有并在卸载时排空。
      void owned.promise.catch(() => {})
      this.flights.set(flightKey, owned)
    }
    const shared = flight
    shared.waiters++
    return new Promise<CachedQuery>((resolve, reject) => {
      let settled = false
      const finish = (ok: boolean, value: unknown) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', aborted)
        if (--shared.waiters === 0) shared.controller.abort()
        if (!ok) reject(value)
        else {
          try { resolve(structuredClone(value as CachedQuery)) }
          catch (error) { reject(error) }
        }
      }
      const aborted = () => finish(false, signal.reason)
      signal.addEventListener('abort', aborted, { once: true })
      if (signal.aborted) aborted()
      shared.promise.then(value => finish(true, value), error => finish(false, error))
    })
  }

  override async store(request: CacheRequest, loaded: CachedQuery, response: unknown, places: Place[], signal: AbortSignal): Promise<void> {
    if (!this.config.cacheEnabled || loaded.hit || loaded.contexts.length || loaded.concludesTurn) return
    // 缓存只收 JSON；含凭据字段或带密钥的 URL 不落盘，也不打印远端内容。
    const serialized = JSON.stringify(response)
    if (!serialized || serialized.length > 65536 || /[?&](?:key|token|secret)=|(?:\\?")(?:authorization|api[_-]?key|access[_-]?token)(?:\\?")\s*:/iu.test(serialized)) return
    const id = keyOf(request)
    try {
      await this.mutate(signal, async () => {
        if (loaded.generation !== this.generation || (this.committed.get(id) ?? 0) > loaded.ticket) return
        const ttl = request.kind === 'search' ? this.config.searchCacheTtlSeconds : this.config.detailsCacheTtlSeconds
        const entry = queryCacheEntrySchema.parse({ id, request, response, places, fetchedAt: loaded.fetchedAt,
          expiresAt: Date.parse(loaded.fetchedAt) + ttl * 1000, usedAt: this.clock() })
        await this.domain.table('entries').put(id, entry)
        this.committed.set(id, loaded.ticket)
        await this.prune()
      })
    } catch {
      if (!signal.aborted && !this.lifetime.signal.aborted) this.counters.writeFailures++
      // 已成功取得的地图数据仍返回给调用方，缓存故障不伪装成地图失败。
    }
  }

  override async listCachedPlaces(query: CachedPlacesQuery, signal: AbortSignal): Promise<CachedPlacesView> {
    const parsed = z.object({ keywords: z.string().max(100).optional(), city: z.string().max(50).optional() }).strict().safeParse(query)
    if (!parsed.success) throw new HarnessError('缓存筛选条件不合法。', 'TRIP_INVALID_QUERY')
    return this.mutate(signal, async () => {
      await this.prune()
      if (!this.config.cacheEnabled) return { places: [] }
      const keyword = text(query.keywords ?? '')
      const city = text(query.city ?? '').replace(/市$/u, '')
      const candidates = new Map<string, { place: Place; fetchedAt: string; details: boolean; cities: Set<string> }>()
      for (const [, entry] of this.domain.table('entries').entries()) {
        for (const place of entry.places) {
          const previous = candidates.get(place.id)
          const cities = previous?.cities ?? new Set<string>()
          const scopeCity = place.city ?? (entry.request.kind === 'search' ? entry.request.city : '')
          if (scopeCity) cities.add(text(scopeCity).replace(/市$/u, ''))
          const details = entry.request.kind === 'details'
          if (!previous || (details && !previous.details) || (details === previous.details && entry.fetchedAt > previous.fetchedAt)) {
            candidates.set(place.id, { place, fetchedAt: entry.fetchedAt, details, cities })
          }
        }
      }
      const usage = this.domain.table('usage')
      return { places: [...candidates.values()]
        .filter(item => (!city || item.cities.has(city)) && (!keyword || text(item.place.name + ' ' + (item.place.address ?? '')).includes(keyword)))
        .sort((a, b) => (usage.get(b.place.id)?.usedAt ?? Date.parse(b.fetchedAt))
          - (usage.get(a.place.id)?.usedAt ?? Date.parse(a.fetchedAt)) || a.place.name.localeCompare(b.place.name, 'zh-CN'))
        .slice(0, 8).map(({ place, fetchedAt }) => ({ placeId: place.id, name: place.name, address: place.address, city: place.city, fetchedAt })) }
    })
  }

  override async touchPlace(placeId: string, signal: AbortSignal): Promise<void> {
    if (typeof placeId !== 'string' || !placeId.trim() || placeId.length > 100) throw new HarnessError('地点编号不合法。', 'TRIP_INVALID_QUERY')
    await this.mutate(signal, async () => {
      const exists = [...this.domain.table('entries').entries()].some(([, entry]) => entry.expiresAt > this.clock()
        && entry.places.some(place => place.id === placeId))
      if (exists) await this.domain.table('usage').put(placeId, { placeId, usedAt: this.clock() })
    })
  }

  override async clear(signal: AbortSignal): Promise<void> {
    await this.mutate(signal, async () => {
      this.generation++
      this.committed.clear()
      for (const table of [this.domain.table('entries'), this.domain.table('usage')]) {
        for (const [id] of table.entries()) await table.delete(id)
      }
    })
  }

  override stats(): QueryCacheStats {
    return { ...this.counters, entries: [...this.domain.table('entries').entries()].filter(([, entry]) => entry.expiresAt > this.clock()).length }
  }

  override recordCall(kind: 'search' | 'details' | 'route'): void {
    if (kind === 'search') this.counters.searchCalls++
    else if (kind === 'details') this.counters.detailCalls++
    else this.counters.routeCalls++
  }

  async stop(): Promise<void> {
    this.lifetime.abort()
    await Promise.allSettled([...this.tasks])
    await this.queue
  }

  /** 启动和使用时惰性清理，不因过期而后台请求地图。 */
  private async prune(): Promise<void> {
    const entries = this.domain.table('entries')
    const ordered = [...entries.entries()].sort((a, b) => b[1].usedAt - a[1].usedAt)
    let retained = 0
    for (const [id, entry] of ordered) {
      if (entry.expiresAt <= this.clock() || retained >= this.config.cacheMaxEntries) await entries.delete(id)
      else retained++
    }
    const validIds = new Set([...entries.entries()].flatMap(([, entry]) => entry.places.map(place => place.id)))
    for (const id of this.committed.keys()) if (!entries.get(id)) this.committed.delete(id)
    for (const [id] of this.domain.table('usage').entries()) if (!validIds.has(id)) await this.domain.table('usage').delete(id)
  }

  private mutate<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    const request = this.queue.then(async () => { signal.throwIfAborted(); this.lifetime.signal.throwIfAborted(); return run() })
    this.queue = request.then(() => {}, () => {})
    return request
  }
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const opened = ctx.storageDomain.open(queryCacheDomain)
  let service: PersistentQueryCache | undefined
  let stopping = false
  ctx.effect(() => async () => { stopping = true; await service?.stop(); await opened.then(domain => domain.close(), () => {}) })
  const domain = await opened
  if (stopping) return
  service = new PersistentQueryCache(ctx, domain, config)
  await service.listCachedPlaces({}, new AbortController().signal)
}
