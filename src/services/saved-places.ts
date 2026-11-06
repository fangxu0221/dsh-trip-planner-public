/** 角色一：收藏服务的约定。工具依赖此接口，不依赖 JSON 后端或具体提供方。 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { SavedPlace } from '../domain.ts'
import type { QueryExecution } from './travel-data.ts'

export type { SavedPlace } from '../domain.ts'
export interface SavePlaceInput { placeId: string; alias: string }
export interface SavePlaceResult { created: boolean; place: SavedPlace }
export interface SavedPlaceEdit { expectedId: string; signal: AbortSignal }

declare module '@deepseek-ai/cordis' {
  interface Context { savedPlaces: SavedPlacesService }
  interface Events {
    'trip/saved-places-changed': () => void
  }
}

/** 查询以别名精确匹配；不存在时返回 null，绝不自动创建收藏。 */
export default abstract class SavedPlacesService extends Service {
  constructor(ctx: Context) { super(ctx, 'savedPlaces') }
  abstract save(input: SavePlaceInput, execution: QueryExecution): Promise<SavePlaceResult>
  abstract list(): Promise<SavedPlace[]>
  abstract get(alias: string): Promise<SavedPlace | null>
  abstract rename(alias: string, newAlias: string, edit?: SavedPlaceEdit): Promise<SavedPlace>
  abstract remove(alias: string, edit?: SavedPlaceEdit): Promise<{ removed: boolean; place: SavedPlace | null }>
}
