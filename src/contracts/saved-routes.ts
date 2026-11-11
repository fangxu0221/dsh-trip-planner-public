/** 常用路线保存的是查询条件；端点名称只用于界面展示。 */
import { z } from 'zod'
import { routeModes } from './routes.ts'
import { maxMultiStopPlaces } from './route-limits.ts'

export const savedRouteNameSchema = z.string().transform(name => name.normalize('NFKC').trim().replace(/\s+/gu, ' '))
  .pipe(z.string().min(1).max(50))

const label = z.string().trim().min(1)
const endpoint = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('saved'), savedPlaceId: z.uuid(), label }).strict(),
  z.object({ kind: z.literal('poi'), placeId: z.string().trim().min(1).max(100), label }).strict(),
])
export const savedRouteEndpointsSchema = z.object({
  origin: endpoint, waypoints: z.array(endpoint).max(maxMultiStopPlaces - 2).optional(), destination: endpoint,
}).strict()
export const saveRouteSchema = savedRouteEndpointsSchema.extend({ name: savedRouteNameSchema, mode: z.enum(routeModes) })
export const savedRouteSchema = saveRouteSchema.extend({
  id: z.uuid(),
  updatedAt: z.iso.datetime(),
})

export type SavedRouteEndpoint = z.infer<typeof endpoint>
export type SavedRouteEndpoints = z.infer<typeof savedRouteEndpointsSchema>
export type SaveRouteInput = z.infer<typeof saveRouteSchema>
export type SavedRoute = z.infer<typeof savedRouteSchema>
