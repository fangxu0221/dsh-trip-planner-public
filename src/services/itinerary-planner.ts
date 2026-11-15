/** 单日行程服务约定，供对话工具调用。 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { DayItineraryQuery, DayItineraryResult, ItineraryRecommendation, ItineraryRecommendationQuery, ItinerarySelection } from '../contracts/day-itinerary.ts'
import type { QueryExecution } from './travel-data.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { itineraryPlanner: ItineraryPlannerService }
}

export default abstract class ItineraryPlannerService extends Service {
  constructor(ctx: Context) { super(ctx, 'itineraryPlanner') }
  abstract plan(query: DayItineraryQuery, execution: QueryExecution): Promise<DayItineraryResult>
  abstract recommend(query: ItineraryRecommendationQuery, execution: QueryExecution): Promise<ItineraryRecommendation>
  abstract planSelection(query: ItinerarySelection, execution: QueryExecution): Promise<DayItineraryResult>
}
