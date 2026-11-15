/** 使用有限的主题搜索、已选地点的路线及建议停留时间生成单日行程。 */
import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'
import {
  dayItineraryQuerySchema, itineraryRecommendationSchema, itinerarySelectionSchema,
  type DayItineraryQuery, type DayItineraryResult, type ItineraryConstraints, type ItineraryItem, type ItineraryProgress,
  type ItineraryRecommendation, type ItineraryRecommendationQuery, type ItineraryRejection, type ItineraryScreening,
  type ItinerarySelection, type ItineraryVisit,
} from '../contracts/day-itinerary.ts'
import type { EndpointReference, PlanMultiStopRouteResult } from '../contracts/routes.ts'
import type { Place, PlaceDetailsResult } from '../contracts/travel.ts'
import ItineraryPlannerService from '../services/itinerary-planner.ts'
import type {} from '../services/route-planner.ts'
import type {} from '../services/saved-places.ts'
import type { QueryExecution } from '../services/travel-data.ts'
import { addItineraryCandidate, diverseItineraryPlaces, sameItineraryPlace, type ItineraryCandidateGroup } from '../services/itinerary-candidates.ts'
import { itineraryRejectionLabels, itineraryScreeningSummary } from '../presentation/itinerary.ts'

const themes = {
  culture: { keywords: ['博物馆', '美术馆'], match: /博物馆|美术馆|纪念馆|展览馆|文化馆/u, stay: 90 },
  park: { keywords: ['公园', '植物园'], match: /公园|植物园|湿地|绿道/u, stay: 60 },
  landmark: { keywords: ['地标景点', '历史街区'], match: /塔$|地标|景区|古城|古镇|广场|老街|街区|步行街/u, stay: 60 },
} as const
const ancillary = /停车|售票|出入口|地铁站|公交站|服务中心|管理处|卫生间|咖啡|酒店|分店|(?:入口|出口|[东西南北正后侧]门)[）)]?$/u
const historicTheme = /历史(?:名迹|名胜|古迹|遗迹|遗址)|古迹|文物古建|名胜古迹/u
const historicEvidence = /古迹|遗址|遗迹|城墙|古城|古建筑|古塔|城楼|陵墓|帝陵|兵马俑|文物保护|(?:大|小)雁塔|钟鼓楼|钟楼|鼓楼/u
const budgetCode = 'TRIP_AGENT_QUERY_BUDGET'
const draftLifetimeMs = 30 * 60 * 1000

type LiveSession = NonNullable<QueryExecution['agent']>['session']
type RouteOptions = Omit<ItinerarySelection, 'draftId' | 'selectedNumbers'>
interface Candidate { snapshot: PlaceDetailsResult; reason: string }
interface DraftPlan {
  numbers: number[]
  query: DayItineraryQuery
  options: RouteOptions
  details: Map<string, PlaceDetailsResult>
  visits: Map<number, ItineraryVisit>
  rejected: Map<number, ItineraryRejection>
  result?: DayItineraryResult
}
interface Draft {
  id: string
  query: ItineraryRecommendationQuery
  constraints: ItineraryConstraints
  candidates: Candidate[]
  expiresAt: number
  plan?: DraftPlan
}
interface SessionDraft { busy: boolean; controller: AbortController; draft?: Draft }

function minutes(time: string): number {
  const [hour, minute] = time.split(':').map(Number)
  return hour * 60 + minute
}

function cityKey(city: string): string {
  return matchText(city).replace(/市$/u, '')
}

const matchText = (value: string) => value.normalize('NFKC').trim().toLowerCase()

function textEvidence(place: Place, match: (value: string) => string | undefined): string | undefined {
  const name = match(place.name)
  if (name) return '名称匹配' + name
  const category = place.category && match(place.category)
  return category ? '类型匹配' + category : undefined
}

function preferred(place: Place, area: string | null): boolean {
  return area !== null && [place.businessArea, place.district].some(value => value && matchText(value) === matchText(area))
}

function itineraryConstraints(request: ItineraryRecommendationQuery): ItineraryConstraints {
  const constraints: ItineraryConstraints = {
    includeDistricts: [...new Set(request.includeDistricts)], excludeDistricts: [...new Set(request.excludeDistricts)],
    excludeKeywords: [...new Set(request.excludeKeywords)], preferredArea: request.preferredArea ?? null,
  }
  if (constraints.includeDistricts.some(district => constraints.excludeDistricts.includes(district))) {
    throw new HarnessError('同一个区县不能同时指定为游览范围和排除范围，请确认。', 'TRIP_INVALID_ITINERARY')
  }
  return constraints
}

function criteria(query: ItineraryRecommendationQuery, constraints: ItineraryConstraints) {
  const { includeDistricts, excludeDistricts, excludeKeywords } = constraints
  const theme = Object.hasOwn(themes, query.theme) ? themes[query.theme as keyof typeof themes] : undefined
  const terms = [...new Set(query.themeKeywords ?? theme?.keywords ?? [query.theme])]
  const historical = historicTheme.test(query.theme)
  const historicalTerms = terms.filter(term => historicEvidence.test(term))
  const searchTerms = historical && !historicalTerms.length ? ['历史遗址', '古建筑'] : historical ? historicalTerms : terms
  const area = includeDistricts.length === 1 ? includeDistricts[0]
    : !includeDistricts.length && !excludeDistricts.length ? constraints.preferredArea : null
  // 区名和商圈只辅助搜索召回，实际归属仍核验来源字段。
  const keywords = area
    ? [area + ' ' + searchTerms[0], searchTerms[1] ?? searchTerms[0]]
    : searchTerms
  return {
    theme, keywords,
    strictRegion: includeDistricts.length > 0 || excludeDistricts.length > 0,
    transit: 'mode' in query && query.mode === 'transit',
    evidence(place: Place) {
      if (historical) return textEvidence(place, value => historicEvidence.exec(value)?.[0])
      return textEvidence(place, value => terms.find(term => matchText(value).includes(matchText(term))) ?? theme?.match.exec(value)?.[0])
    },
    wrongCity(city: string | null) { return city !== null && cityKey(city) !== cityKey(query.city) },
    wrongDistrict(district?: string) {
      if (!district) return false
      const name = district.normalize('NFKC')
      return excludeDistricts.includes(name) || (includeDistricts.length > 0 && !includeDistricts.includes(name))
    },
    rejectPlace(place: Place) {
      return ancillary.test(place.name)
        || excludeKeywords.some(term => [place.name, place.category ?? ''].some(value => matchText(value).includes(matchText(term))))
    },
  }
}

function initialResult(request: DayItineraryQuery, constraints: ItineraryConstraints): DayItineraryResult {
  const startMinute = minutes(request.startTime ?? '10:00')
  const endMinute = minutes(request.endTime ?? '18:00')
  if (endMinute <= startMinute || (request.returnToOrigin && (!request.origin || request.destination))) {
    throw new HarnessError('结束时间须晚于开始时间。返回起点时请提供起点并省略独立终点。', 'TRIP_INVALID_ITINERARY')
  }
  return {
    source: 'AMAP', city: request.city, theme: request.theme, mode: request.mode,
    ...(constraints.includeDistricts.length || constraints.excludeDistricts.length || constraints.excludeKeywords.length
      || constraints.preferredArea ? { constraints } : {}),
    startMinute, endMinute, defaultStart: !request.startTime, defaultEnd: !request.endTime,
    status: 'incomplete', visits: [], route: null, timeline: [], finishMinute: null, overByMinutes: null, message: null,
  }
}

const isBudget = (error: unknown) => error instanceof HarnessError && error.code === budgetCode
const emptyScreening = (): ItineraryScreening => ({
  duplicate: 0, outsideRegion: 0, excluded: 0, themeMismatch: 0, unverified: 0, sourceCounts: [],
})

type CandidateCriteria = ReturnType<typeof criteria>
function knownRejection(place: Place, rules: CandidateCriteria): ItineraryRejection | undefined {
  if (rules.wrongCity(place.city) || rules.wrongDistrict(place.district)) return 'outsideRegion'
  if (rules.rejectPlace(place)) return 'excluded'
  if (place.category && !rules.evidence(place)) return 'themeMismatch'
}

function requiresDetails(place: Place, rules: CandidateCriteria, exclusions: string[]): boolean {
  return !place.coordinates || !rules.evidence(place) || (exclusions.length > 0 && !place.category)
}

function requiresRegion(place: Place, rules: CandidateCriteria): boolean {
  return (rules.strictRegion && (!place.district || !place.city)) || (rules.transit && !place.city)
}

function toVisit(candidate: Candidate, stayMinutes: number): ItineraryVisit {
  const { id, name, address, district } = candidate.snapshot.place
  return { placeId: id, name, address, reason: candidate.reason, stayMinutes, ...(district && { district }) }
}

function queryMessage(error: unknown, fallback: string): string {
  if (error instanceof HarnessError) {
    if (error.code === 'TRIP_AGENT_QUERY_BUDGET') return error.message
    if (error.code.startsWith('TRIP_')) return fallback
  }
  if (error instanceof Error && error.name === 'TimeoutError') return fallback
  throw error
}

function schedule(route: NonNullable<DayItineraryResult['route']>, visits: ItineraryVisit[], start: number) {
  const stops = 'stops' in route ? route.stops : [route.origin, route.destination]
  const legs = 'stops' in route ? route.legs.map(leg => leg.route?.durationSeconds ?? null)
    : [route.status === 'found' ? route.routes[0]?.durationSeconds ?? null : null]
  const timeline: ItineraryItem[] = []
  let cursor: number | null = start
  function add(kind: ItineraryItem['kind'], title: string, duration: number | null, legIndex: number | null, placeId?: string) {
    const endMinute: number | null = cursor === null || duration === null ? null : cursor + duration
    timeline.push({ kind, title, startMinute: cursor, endMinute, legIndex, ...(placeId ? { placeId } : {}) })
    cursor = endMinute
  }
  stops.forEach((stop, index) => {
    const label = stop.alias ?? stop.name
    if (index > 0) {
      const seconds = legs[index - 1]
      const previous = stops[index - 1]
      add('travel', (previous.alias ?? previous.name) + ' → ' + label, seconds == null ? null : Math.ceil(seconds / 60), index - 1)
    }
    const visit = visits.find(point => point.placeId === stop.placeId)
    if (visit) add('visit', '游览' + label, visit.stayMinutes, null, visit.placeId)
  })
  return { timeline, finishMinute: timeline.at(-1)?.endMinute ?? null }
}

export default class ItineraryPlanner extends ItineraryPlannerService {
  static inject = ['travelData', 'routePlanner', 'savedPlaces']
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly sessions = new WeakMap<LiveSession, SessionDraft>()

  constructor(ctx: Context) {
    super(ctx)
    ctx.on('session/disposed', session => {
      this.sessions.get(session)?.controller.abort()
      this.sessions.delete(session)
    }, { global: true })
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('行程规划服务已卸载'))
      await Promise.allSettled(this.pending)
    })
  }

  override async plan(query: DayItineraryQuery, execution: QueryExecution): Promise<DayItineraryResult> {
    const parsed = dayItineraryQuerySchema.safeParse(query)
    if (!parsed.success) throw new HarnessError('请提供城市、支持的主题和交通方式，时间使用 HH:mm。', 'TRIP_INVALID_ITINERARY')
    const request = parsed.data
    if (execution.agent && request.autoSelect !== true) {
      throw new HarnessError('请先调用 trip_recommend_day_itinerary_places，等用户选定地点后再规划。', 'TRIP_ITINERARY_SELECTION_REQUIRED')
    }
    const constraints = itineraryConstraints(request)
    const result = initialResult(request, constraints)
    return this.run(execution, active => this.build(request, constraints, result, active))
  }

  private async run<T>(execution: QueryExecution, execute: (active: QueryExecution) => Promise<T>): Promise<T> {
    const signal = AbortSignal.any([this.lifetime.signal, execution.signal])
    signal.throwIfAborted()
    const pending = execute({ ...execution, signal,
      deferContext: context => execution.deferContext?.(context), concludeTurn: () => execution.concludeTurn?.(),
    })
    this.pending.add(pending)
    try { return await pending } finally { this.pending.delete(pending) }
  }

  /** 候选和确认进度只属于当前 Harness 会话，同一会话串行操作草稿。 */
  private async withDraft<T>(execution: QueryExecution, run: (state: SessionDraft, active: QueryExecution) => Promise<T>): Promise<T> {
    const session = execution.agent?.session
    if (!session) throw new HarnessError('候选选择需要在 Harness 对话中进行。', 'TRIP_ITINERARY_SESSION_REQUIRED')
    let state = this.sessions.get(session)
    if (!state) {
      state = { busy: false, controller: new AbortController() }
      this.sessions.set(session, state)
    }
    if (state.busy) throw new HarnessError('同一会话的行程操作仍在进行，请等待当前操作结束。', 'TRIP_ITINERARY_BUSY')
    state.busy = true
    try {
      const signal = AbortSignal.any([state.controller.signal, execution.signal])
      return await this.run({ ...execution, signal }, active => run(state, active))
    } finally { state.busy = false }
  }

  override async recommend(query: ItineraryRecommendationQuery, execution: QueryExecution): Promise<ItineraryRecommendation> {
    const parsed = itineraryRecommendationSchema.safeParse(query)
    if (!parsed.success) throw new HarnessError('请提供城市、主题及有效的地区约束。', 'TRIP_INVALID_ITINERARY')
    const request = parsed.data
    const constraints = itineraryConstraints(request)
    const rules = criteria(request, constraints)
    const { keywords, evidence, strictRegion } = rules
    const preferredArea = constraints.preferredArea
    return this.withDraft(execution, async (state, active) => {
      const groups: ItineraryCandidateGroup[] = []
      const screening = emptyScreening()
      const skipped = new Set<string>()
      const priority = (place: Place) => Number(preferred(place, preferredArea))
      const representative = (place: Place) => Number(!requiresDetails(place, rules, constraints.excludeKeywords)
        && !requiresRegion(place, rules)) * 2 + priority(place)
      let interrupted: 'budget' | 'search-failed' | undefined
      let message: string | null = null
      for (const keyword of keywords) {
        try {
          const search = await this.ctx.travelData.searchItineraryPlaces({ keywords: keyword, city: request.city }, active)
          active.signal.throwIfAborted()
          screening.sourceCounts.push(search.sourceCount)
          screening.duplicate += search.duplicateIds ?? 0
          for (const place of search.places) {
            const rejection = knownRejection(place, rules) ?? (!evidence(place) ? 'themeMismatch' : undefined)
            if (rejection) {
              if (!skipped.has(place.id)) screening[rejection]++
              skipped.add(place.id)
            }
            else if (!addItineraryCandidate(groups, { place, fetchedAt: search.fetchedAt, source: search.source, via: 'search' }, representative)) {
              screening.duplicate++
            }
          }
          if (groups.length >= 3 && (!preferredArea || groups.some(({ snapshot }) => preferred(snapshot.place, preferredArea)))) break
        } catch (error) {
          active.signal.throwIfAborted()
          interrupted = isBudget(error) ? 'budget' : 'search-failed'
          message = queryMessage(error, '本次地点搜索未完成，已保留查到的候选。')
          break
        }
      }
      const candidates = diverseItineraryPlaces(groups, group => group.snapshot.place, group => priority(group.snapshot.place), 5)
        .map(({ snapshot }) => ({ snapshot, reason: evidence(snapshot.place)! }))
      const draftId = candidates.length ? randomUUID() : null
      state.draft = draftId ? { id: draftId, query: request, constraints, candidates, expiresAt: Date.now() + draftLifetimeMs } : undefined
      return {
        city: request.city, theme: request.theme, constraints: structuredClone(constraints), draftId,
        candidates: candidates.map(({ snapshot: { place }, reason }, index) => ({
          number: index + 1, name: place.name, address: place.address, category: place.category ?? null,
          district: place.district ?? null, pendingDistrict: strictRegion && (!place.district || !place.city), reason,
        })),
        status: interrupted ?? (candidates.length >= 3 ? 'ready' : 'few-candidates'),
        message: message ?? (candidates.length < 2 ? '符合主题的候选不足两个，可以调整主题或地区后重新推荐。' : null),
        screening,
      }
    })
  }

  override async planSelection(query: ItinerarySelection, execution: QueryExecution): Promise<DayItineraryResult> {
    const parsed = itinerarySelectionSchema.safeParse(query)
    if (!parsed.success) throw new HarnessError('请使用候选清单编号，并选定两个或三个地点。', 'TRIP_INVALID_ITINERARY')
    const { draftId, selectedNumbers, ...options } = parsed.data
    return this.withDraft(execution, async (state, active) => {
      const draft = state.draft
      if (!draft || draft.id !== draftId || draft.expiresAt <= Date.now()) {
        throw new HarnessError('当前对话没有这份有效的候选清单，请重新推荐。', 'TRIP_ITINERARY_DRAFT_MISSING')
      }
      if (!selectedNumbers && (!draft.plan || Object.keys(options).length)) {
        throw new HarnessError('请先确认候选编号和交通方式。续查时只需传原候选清单编号。', 'TRIP_INVALID_ITINERARY')
      }
      let plan = draft.plan
      if (selectedNumbers) {
        if (new Set(selectedNumbers).size !== selectedNumbers.length || selectedNumbers.some(number => number > draft.candidates.length)) {
          throw new HarnessError('请选择清单中不同的候选编号。', 'TRIP_INVALID_ITINERARY')
        }
        const mergedOptions = { ...plan?.options, ...options }
        const input = dayItineraryQuerySchema.safeParse({ ...draft.query, ...mergedOptions })
        if (!input.success) throw new HarnessError('请确认交通方式和有效的行程时间。', 'TRIP_INVALID_ITINERARY')
        initialResult(input.data, draft.constraints)
        if (!plan || JSON.stringify(plan.numbers) !== JSON.stringify(selectedNumbers)
          || JSON.stringify(plan.query) !== JSON.stringify(input.data)) {
          const reusable = plan?.query.mode === input.data.mode ? plan : undefined
          plan = { numbers: selectedNumbers, query: input.data, options: mergedOptions, details: plan?.details ?? new Map(),
            visits: reusable?.visits ?? new Map(), rejected: reusable?.rejected ?? new Map() }
          draft.plan = plan
        }
      }
      if (!plan) throw new HarnessError('请先选择地点。', 'TRIP_INVALID_ITINERARY')
      draft.expiresAt = Date.now() + draftLifetimeMs
      if (plan.result?.status === 'ready' || plan.result?.status === 'over-window') return structuredClone(plan.result)
      const result = await this.buildSelection(draft, plan, active)
      active.signal.throwIfAborted()
      plan.result = structuredClone(result)
      return result
    })
  }

  /** 只根据可信快照的缺失字段补查，遇到已知不合格或重复时提前停止。 */
  private async verifyCandidate(snapshot: PlaceDetailsResult, rules: CandidateCriteria, exclusions: string[],
    details: Map<string, PlaceDetailsResult>, accepted: readonly Place[],
    execution: QueryExecution): Promise<Candidate | ItineraryRejection> {
    let current = details.get(snapshot.place.id) ?? snapshot
    let place = current.place
    const rejection = () => knownRejection(place, rules)
      ?? (accepted.some(point => sameItineraryPlace(point, place)) ? 'duplicate' : undefined)
    const before = rejection()
    if (before) return before
    if (current.via === 'search' && requiresDetails(place, rules, exclusions)) {
      const found = await this.ctx.travelData.getPlaceDetails(place.id, execution)
      execution.signal.throwIfAborted()
      const resolved = found.place
      const moved = place.coordinates && resolved.coordinates
        && (place.coordinates.longitude !== resolved.coordinates.longitude || place.coordinates.latitude !== resolved.coordinates.latitude)
      place = { ...place, ...resolved, address: resolved.address ?? place.address,
        coordinates: resolved.coordinates ?? place.coordinates,
        city: resolved.city ?? (moved ? null : place.city),
        district: resolved.district ?? (moved ? undefined : place.district) }
      current = { ...found, place }
      details.set(place.id, current)
    }
    const afterDetails = rejection()
    if (afterDetails) return afterDetails
    const reason = rules.evidence(place)
    if (!reason) return 'themeMismatch'
    if (!place.coordinates) return 'unverified'
    if (requiresRegion(place, rules)) {
      const region = await this.ctx.travelData.getPlaceRegion(place.coordinates, execution)
      execution.signal.throwIfAborted()
      place = { ...place, city: region.city ?? place.city, district: region.district ?? place.district }
      current = { ...current, place }
      details.set(place.id, current)
    }
    const checked = rejection()
    if (checked) return checked
    if (requiresRegion(place, rules)) return 'unverified'
    current = { ...current, place }
    details.set(place.id, current)
    return { snapshot: current, reason }
  }

  private async buildSelection(draft: Draft, plan: DraftPlan, execution: QueryExecution): Promise<DayItineraryResult> {
    const { query, numbers, details, visits, rejected } = plan
    const { signal } = execution
    const origin = await this.resolveEndpoint(query.origin)
    const destination = query.returnToOrigin ? origin : await this.resolveEndpoint(query.destination)
    const result = initialResult(query, draft.constraints)
    if (numbers.some(number => [origin?.placeId, destination?.placeId].includes(draft.candidates[number - 1].snapshot.place.id))) {
      throw new HarnessError('有游览点和指定起终点重复，请调整选择。', 'TRIP_INVALID_ITINERARY')
    }
    const rules = criteria(query, draft.constraints)
    const stayMinutes = query.stayMinutes ?? rules.theme?.stay ?? 60
    const acceptedPlaces: Place[] = []
    const acceptedNumbers = new Set<number>()
    const rejections = new Map<number, ItineraryRejection>()
    const accepted = () => numbers.flatMap(number => {
      const visit = visits.get(number)
      return visit && acceptedNumbers.has(number) ? [{ ...visit, stayMinutes }] : []
    })
    const progress = (stage: ItineraryProgress['stage'], reason: ItineraryProgress['reason'],
      completedLegs = 0, pendingLegs = numbers.length - 1 + Number(!!origin) + Number(!!destination) - completedLegs): ItineraryProgress => ({
      draftId: draft.id, stage, reason, completedLegs, pendingLegs,
      verifiedNumbers: numbers.filter(number => acceptedNumbers.has(number)),
      pendingNumbers: numbers.filter(number => !acceptedNumbers.has(number) && !rejections.has(number)),
      rejectedNumbers: numbers.filter(number => rejections.has(number)),
      ...(rejections.size && { rejections: [...rejections].map(([number, reason]) => ({ number, reason })) }),
    })
    // 换选时先放入已核验的原选择；重复结论只用于本次组合，不永久禁用编号。
    const ordered = [...numbers].sort((a, b) => Number(visits.has(b)) - Number(visits.has(a)))
    for (const number of ordered) {
      signal.throwIfAborted()
      const previousRejection = rejected.get(number)
      if (previousRejection) {
        rejections.set(number, previousRejection)
        continue
      }
      const candidate = draft.candidates[number - 1]
      try {
        const verified = await this.verifyCandidate(candidate.snapshot, rules, draft.constraints.excludeKeywords, details, acceptedPlaces, execution)
        if (typeof verified === 'string') {
          rejections.set(number, verified)
          if (verified !== 'duplicate') rejected.set(number, verified)
          continue
        }
        acceptedPlaces.push(verified.snapshot.place)
        acceptedNumbers.add(number)
        visits.set(number, toVisit(verified, stayMinutes))
      } catch (error) {
        signal.throwIfAborted()
        return { ...result, visits: accepted(), progress: progress('verification', isBudget(error) ? 'budget' : 'query-failed'),
          message: queryMessage(error, '部分所选地点暂时无法核验，已保留进度。') }
      }
    }
    result.visits = accepted()
    if (rejections.size) {
      return { ...result, status: 'insufficient-places', progress: progress('verification', 'selection-needs-review'),
        message: '已确认 ' + result.visits.length + ' 个地点。'
          + [...rejections].map(([number, reason]) => '编号 ' + number + ' ' + itineraryRejectionLabels[reason] + '。').join('')
          + '请替换这些编号，其他选择已保留。' }
    }
    const previous = plan.result?.route
    try {
      const routed = await this.routeForVisits(query, result, origin?.reference, destination?.reference, execution, details,
        previous && 'stops' in previous ? previous : undefined)
      if (routed.status !== 'incomplete' || !routed.route) return routed
      const legs = 'stops' in routed.route ? routed.route.legs : []
      const completed = legs.length ? legs.filter(leg => leg.status === 'found').length : Number(routed.route.status === 'found')
      const reason = legs.some(leg => leg.failureCode === 'budget') ? 'budget'
        : legs.some(leg => leg.status === 'query-failed') ? 'query-failed'
          : (routed.route.status === 'no-route' || legs.some(leg => leg.status === 'no-route')) ? 'no-route' : 'unknown-duration'
      return { ...routed, progress: progress('routing', reason, completed) }
    } catch (error) {
      signal.throwIfAborted()
      return { ...result, visits: accepted(), route: previous ?? null,
        progress: progress('routing', isBudget(error) ? 'budget' : 'query-failed',
          previous && 'stops' in previous ? previous.legs.filter(leg => leg.status === 'found').length : 0),
        message: queryMessage(error, '交通路线未完成，已保留所选地点。') }
    }
  }

  private async resolveEndpoint(ref: EndpointReference | undefined): Promise<{ reference: EndpointReference; placeId: string } | undefined> {
    if (!ref) return
    if (ref.kind === 'poi') return { reference: ref, placeId: ref.placeId }
    const saved = await this.ctx.savedPlaces.get(ref.alias)
    if (!saved || (ref.expectedId !== undefined && saved.id !== ref.expectedId)) {
      throw new HarnessError('找不到选中的收藏地点，请重新选择起点或终点。', 'TRIP_ITINERARY_ENDPOINT_MISSING')
    }
    return { reference: { ...ref, expectedId: saved.id }, placeId: saved.placeId }
  }

  private async build(query: DayItineraryQuery, constraints: ItineraryConstraints, result: DayItineraryResult,
    execution: QueryExecution): Promise<DayItineraryResult> {
    const { signal } = execution
    const origin = await this.resolveEndpoint(query.origin)
    signal.throwIfAborted()
    const destination = query.returnToOrigin ? origin : await this.resolveEndpoint(query.destination)
    const excluded = new Set([origin?.placeId, destination?.placeId])
    const groups: ItineraryCandidateGroup[] = []
    const checked = new Set<ItineraryCandidateGroup>()
    const skipped = new Set<string>()
    const details = new Map<string, PlaceDetailsResult>()
    const candidates: Candidate[] = []
    const rules = criteria(query, constraints)
    const { theme, keywords, evidence } = rules
    const { excludeKeywords, preferredArea } = constraints
    const screening = emptyScreening()
    result.screening = screening
    const readyWithoutLookup = (place: Place) => !requiresDetails(place, rules, excludeKeywords) && !requiresRegion(place, rules)
    const priority = (place: Place) => Number(readyWithoutLookup(place)) * 4
      + Number(!!evidence(place)) * 2 + Number(preferred(place, preferredArea))
    let budgetMessage: string | null = null
    let lookupLimited = false
    let lookups = 0
    const lookupExecution = { ...execution, beforePlaceLookup: () => {
      if (lookups >= 4) throw new HarnessError('已达到本次行程的地点核验上限。', 'TRIP_ITINERARY_LOOKUP_BUDGET')
      execution.beforePlaceLookup?.()
      lookups++
    } }
    const enough = () => candidates.length >= 2 && (!preferredArea
      || candidates.filter(candidate => preferred(candidate.snapshot.place, preferredArea)).length >= 2)
    const shortlist = () => diverseItineraryPlaces(candidates, candidate => candidate.snapshot.place,
      candidate => Number(preferred(candidate.snapshot.place, preferredArea)), 2)
      .map(candidate => toVisit(candidate, query.stayMinutes ?? theme?.stay ?? 60))
    for (const keyword of keywords) {
      signal.throwIfAborted()
      try {
        const search = await this.ctx.travelData.searchItineraryPlaces({ keywords: keyword, city: query.city }, execution)
        signal.throwIfAborted()
        screening.sourceCounts.push(search.sourceCount)
        screening.duplicate += search.duplicateIds ?? 0
        for (const place of search.places) {
          const rejection = excluded.has(place.id) ? 'excluded' : knownRejection(place, rules)
            ?? (theme && !query.themeKeywords && !evidence(place) ? 'themeMismatch' : undefined)
          if (rejection) {
            if (!skipped.has(place.id)) screening[rejection]++
            skipped.add(place.id)
          }
          else if (!addItineraryCandidate(groups, { place, fetchedAt: search.fetchedAt, source: search.source, via: 'search' }, priority)) {
            screening.duplicate++
          }
        }
      } catch (error) {
        signal.throwIfAborted()
        if (candidates.length < 2) {
          return { ...result, visits: shortlist(), message: queryMessage(error, '地点搜索未完成，可以稍后重新规划。') }
        }
        queryMessage(error, '地点搜索未完成。')
        break
      }
      // 本批已去重，先使用字段齐全的候选，余下详情预算只用于凑齐合格游览点。
      const pending = groups.filter(group => !checked.has(group))
      const ordered = diverseItineraryPlaces(pending, group => group.snapshot.place, group => priority(group.snapshot.place), pending.length)
      for (const group of ordered) {
        signal.throwIfAborted()
        if (candidates.length >= 2 && !readyWithoutLookup(group.snapshot.place)) continue
        checked.add(group)
        try {
          const verified = await this.verifyCandidate(group.snapshot, rules, excludeKeywords, details,
            candidates.map(candidate => candidate.snapshot.place), lookupExecution)
          if (typeof verified === 'string') screening[verified]++
          else candidates.push(verified)
        } catch (error) {
          signal.throwIfAborted()
          screening.unverified++
          if (isBudget(error)) {
            budgetMessage = queryMessage(error, '当前轮次的核验额度已用完。')
            break
          }
          if (error instanceof HarnessError && error.code === 'TRIP_ITINERARY_LOOKUP_BUDGET') lookupLimited = true
          queryMessage(error, '地点信息未能核验。')
        }
      }
      if (enough() || budgetMessage) break
    }
    result.visits = shortlist()
    if (result.visits.length < 2) {
      const notes = [
        itineraryScreeningSummary(screening),
        lookupLimited && '已达到本次行程的地点核验上限。',
        budgetMessage,
      ].filter(Boolean).join('')
      return { ...result, status: 'insufficient-places',
        message: '已确认 ' + result.visits.length + ' 个符合条件的地点。' + notes + '可以调整主题或地区后再规划。' }
    }

    try {
      return await this.routeForVisits(query, result, origin?.reference, destination?.reference, execution, details)
    } catch (error) {
      signal.throwIfAborted()
      return { ...result, message: queryMessage(error, '交通路线未完成，已保留入选地点。') }
    }
  }

  private async routeForVisits(query: DayItineraryQuery, result: DayItineraryResult, origin: EndpointReference | undefined,
    destination: EndpointReference | undefined, execution: QueryExecution, details: Map<string, PlaceDetailsResult>,
    previous?: PlanMultiStopRouteResult): Promise<DayItineraryResult> {
    const stops: EndpointReference[] = result.visits.map(place => ({ kind: 'poi', placeId: place.placeId }))
    if (origin) stops.unshift(origin)
    if (destination) stops.push(destination)
    const route = stops.length === 2
      ? await this.ctx.routePlanner.plan({ origin: stops[0], destination: stops[1], mode: query.mode }, execution, details)
      : await this.ctx.routePlanner.planMultiStop({ stops, mode: query.mode, order: 'optimized',
        pinStart: !!origin, pinEnd: !!destination }, execution, details, previous)
    execution.signal.throwIfAborted()
    const { timeline, finishMinute } = schedule(route, result.visits, result.startMinute)
    const overByMinutes = finishMinute === null ? null : Math.max(0, finishMinute - result.endMinute)
    const ordered = 'stops' in route ? route.stops : [route.origin, route.destination]
    const visits = ordered.flatMap(stop => result.visits.filter(visit => visit.placeId === stop.placeId))
    const routeMessage = 'stops' in route ? route.legs.find(leg => leg.message)?.message : null
    return { ...result, route, visits, timeline, finishMinute, overByMinutes,
      status: finishMinute === null ? 'incomplete' : overByMinutes ? 'over-window' : 'ready',
      message: finishMinute === null ? (routeMessage ? routeMessage + '后续时刻待定。' : '部分交通段暂无路线或耗时，后续时刻待定。') : null,
    }
  }
}
