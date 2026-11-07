/** 常用路线业务服务约定，供 Host 接口调用。 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { SavedRoute, SavedRouteEndpoints, SaveRouteInput } from '../contracts/saved-routes.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { savedRoutes: SavedRoutesService }
  interface Events { 'trip/saved-routes-changed'(): void }
}

export default abstract class SavedRoutesService extends Service {
  constructor(ctx: Context) { super(ctx, 'savedRoutes') }
  abstract list(): Promise<SavedRoute[]>
  abstract save(input: SaveRouteInput, signal: AbortSignal): Promise<SavedRoute>
  abstract rename(id: string, name: string, signal: AbortSignal): Promise<SavedRoute>
  abstract updateEndpoints(id: string, endpoints: SavedRouteEndpoints, signal: AbortSignal): Promise<SavedRoute>
  abstract remove(id: string, signal: AbortSignal): Promise<SavedRoute>
}
