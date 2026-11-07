/** 校验常用路线，在写入队列内持久化，提交后通知订阅方。 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { savedRouteEndpointsSchema, savedRouteNameSchema, savedRouteSchema, saveRouteSchema,
  type SavedRoute, type SavedRouteEndpoint, type SavedRouteEndpoints, type SaveRouteInput } from '../contracts/saved-routes.ts'
import { savedRoutesDomain } from '../saved-routes-domain.ts'
import SavedRoutesService from '../services/saved-routes.ts'
import type {} from '../services/saved-places.ts'

export const name = 'trip-saved-routes'
export const inject = ['storageDomain', 'savedPlaces']

function parse<S extends z.ZodType>(schema: S, input: unknown, message: string): z.output<S> {
  const result = schema.safeParse(input)
  if (!result.success) throw new HarnessError(message, 'TRIP_INVALID_SAVED_ROUTE')
  return result.data
}

class PersistentSavedRoutes extends SavedRoutesService {
  private readonly routes: KvTable<string, SavedRoute>
  private queue = Promise.resolve()
  private stopping = false

  constructor(ctx: Context, domain: Domain<typeof savedRoutesDomain>) {
    const routes = domain.table('routes')
    const names = new Set<string>()
    for (const [id, route] of routes.entries()) {
      const key = route.name.toLowerCase()
      if (id !== route.id || names.has(key)) {
        throw new HarnessError('常用路线文件存在重复名称或编号不一致，请保留文件供排查。', 'TRIP_INVALID_STORED_DATA')
      }
      names.add(key)
    }
    super(ctx)
    this.routes = routes
  }

  override async list(): Promise<SavedRoute[]> {
    return [...this.routes.entries()].map(([, route]) => structuredClone(route))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name))
  }

  override async save(input: SaveRouteInput, signal: AbortSignal): Promise<SavedRoute> {
    const { name, mode, origin, destination } = parse(saveRouteSchema, input, '请填写有效路线名称、起终点和交通方式。')
    return this.mutate(signal, async () => {
      this.assertNameAvailable(name)
      const endpoints = await this.resolveEndpoints({ origin, destination })
      signal.throwIfAborted()
      return this.store({ id: randomUUID(), name, mode, ...endpoints, updatedAt: new Date().toISOString() })
    })
  }

  override async rename(id: string, name: string, signal: AbortSignal): Promise<SavedRoute> {
    const nextName = parse(savedRouteNameSchema, name, '路线名称应为 1 到 50 个字符。')
    return this.mutate(signal, async () => {
      const route = this.get(id)
      this.assertNameAvailable(nextName, route.id)
      if (route.name === nextName) return structuredClone(route)
      return this.store({ ...route, name: nextName, updatedAt: new Date().toISOString() })
    })
  }

  override async updateEndpoints(id: string, input: SavedRouteEndpoints, signal: AbortSignal): Promise<SavedRoute> {
    const endpoints = parse(savedRouteEndpointsSchema, input, '请选择有效的起点和终点。')
    return this.mutate(signal, async () => {
      const route = this.get(id)
      const next = await this.resolveEndpoints(endpoints)
      signal.throwIfAborted()
      return this.store({ ...route, ...next, updatedAt: new Date().toISOString() })
    })
  }

  override async remove(id: string, signal: AbortSignal): Promise<SavedRoute> {
    return this.mutate(signal, async () => {
      const route = this.get(id)
      await this.routes.delete(route.id)
      this.ctx.emit('trip/saved-routes-changed')
      return structuredClone(route)
    })
  }

  async stop(): Promise<void> {
    this.stopping = true
    await this.queue
  }

  private get(id: string): SavedRoute {
    const route = this.routes.get(parse(z.uuid(), id, '常用路线编号无效。'))
    if (!route) throw new HarnessError('这条常用路线已删除，请刷新列表后再试。', 'TRIP_SAVED_ROUTE_NOT_FOUND')
    return route
  }

  private assertNameAvailable(name: string, ownId?: string): void {
    const key = name.toLowerCase()
    if ([...this.routes.entries()].some(([id, route]) => id !== ownId && route.name.toLowerCase() === key)) {
      throw new HarnessError('常用路线名称已被使用，请换一个名称。', 'TRIP_SAVED_ROUTE_NAME_CONFLICT')
    }
  }

  /** 收藏按本地 ID 解析，名称快照仅用于展示已失效的记录。 */
  private async resolveEndpoints({ origin, destination }: SavedRouteEndpoints): Promise<SavedRouteEndpoints> {
    const places = origin.kind === 'saved' || destination.kind === 'saved' ? await this.ctx.savedPlaces.list() : []
    function resolve(endpoint: SavedRouteEndpoint) {
      if (endpoint.kind === 'poi') return { endpoint, placeId: endpoint.placeId }
      const place = places.find(place => place.id === endpoint.savedPlaceId)
      if (!place) throw new HarnessError('选中的收藏已取消，请重新选点。', 'TRIP_SAVED_ROUTE_ENDPOINT_MISSING')
      return { endpoint: { ...endpoint, label: place.alias + ' · ' + place.name }, placeId: place.placeId }
    }
    const from = resolve(origin)
    const to = resolve(destination)
    if (from.placeId === to.placeId) throw new HarnessError('起点和终点不能是同一个地点。', 'TRIP_INVALID_SAVED_ROUTE')
    return { origin: from.endpoint, destination: to.endpoint }
  }

  private async store(route: SavedRoute): Promise<SavedRoute> {
    const record = savedRouteSchema.parse(route)
    await this.routes.put(record.id, record)
    this.ctx.emit('trip/saved-routes-changed')
    return structuredClone(record)
  }

  private mutate<T>(signal: AbortSignal, job: () => Promise<T>): Promise<T> {
    const request = this.queue.then(() => {
      signal.throwIfAborted()
      if (this.stopping) throw new HarnessError('常用路线服务已关闭。', 'TRIP_STORAGE_CLOSED')
      return job()
    })
    this.queue = request.then(() => {}, () => {})
    return request
  }
}

export async function apply(ctx: Context): Promise<void> {
  const opened = ctx.storageDomain.open(savedRoutesDomain)
  let service: PersistentSavedRoutes | undefined
  let stopping = false
  ctx.effect(() => async () => {
    stopping = true
    await service?.stop()
    await opened.then(domain => domain.close(), () => {})
  })
  const domain = await opened
  if (stopping) return
  try { service = new PersistentSavedRoutes(ctx, domain) }
  catch (error) { await domain.close(); throw error }
}
