/** 角色一：服务约定。提供方实现方法，工具消费方通过 ctx.travelData 使用能力。 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { PlaceDetailsResult, PlacesSearchResult, SearchPlacesQuery } from '../contracts/travel.ts'
import type { ResolvedRouteQuery, RouteDataResult } from '../contracts/routes.ts'

/**
 * signal 是必填的取消信号；其他字段由已有工具调用传入，用于继承作用域和嵌套关系。
 * 后续后台消费方可只提供 signal，不需要构造假的 Agent。
 */
export type QueryExecution = Pick<ToolRunContext, 'signal'> & Partial<Pick<ToolRunContext,
  'agent' | 'toolSet' | 'token' | 'rootCallId' | 'deferContext' | 'concludeTurn'>>

declare module '@deepseek-ai/cordis' {
  interface Context {
    travelData: TravelDataService
  }
}

/** 抽象类只规定能力；实际挂载的是 providers/amap.ts 中的子类。 */
export default abstract class TravelDataService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'travelData')
  }

  /**
   * 查询候选地点，非法输入、查询失败或异常响应必须拒绝，不返回伪造的空结果。
   * @param query 关键词、可选城市和数量。
   * @param execution 调用方的取消、权限作用域和嵌套信息。
   * @returns 同一结构的地点列表、查询条件、来源和数量说明。
   */
  abstract searchPlaces(query: SearchPlacesQuery, execution: QueryExecution): Promise<PlacesSearchResult>

  /** 按已选择的真实 POI ID 获取详情，供收藏使用，不接受模型自行拼出的地点字段。 */
  abstract getPlaceDetails(placeId: string, execution: QueryExecution): Promise<PlaceDetailsResult>

  /** 查询已解析端点之间的一种交通方式；不负责收藏别名解析。 */
  abstract planRoute(query: ResolvedRouteQuery, execution: QueryExecution): Promise<RouteDataResult>
}
