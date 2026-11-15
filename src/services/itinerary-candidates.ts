/** 行程地点的实体去重与候选排序。距离只辅助判断，名称不同的地点保留各自的身份。 */
import type { Place, PlaceDetailsResult } from '../contracts/travel.ts'
import { distanceMeters } from './route-order.ts'

const normalize = (value?: string | null) => (value ?? '').normalize('NFKC').replace(/\s+/gu, '').toLowerCase()
const city = (place: Place) => normalize(place.city).replace(/市$/u, '')
const category = (place: Place) => normalize(place.category).split(';').filter(Boolean).at(-1) ?? ''
const conflict = (a: string, b: string) => Boolean(a && b && a !== b)

export function sameItineraryPlace(a: Place, b: Place): boolean {
  if (a.id === b.id) return true
  const name = normalize(a.name)
  const aCategory = category(a)
  const bCategory = category(b)
  if (!name || name !== normalize(b.name) || conflict(city(a), city(b))
    || conflict(normalize(a.district), normalize(b.district)) || conflict(aCategory, bCategory)) return false
  const address = normalize(a.address)
  const otherAddress = normalize(b.address)
  if (conflict(address, otherAddress)) return false
  const near = a.coordinates && b.coordinates ? distanceMeters(a.coordinates, b.coordinates) <= 30 : undefined
  if (near === false) return false
  const specificAddress = address && ![normalize(a.city), city(a), normalize(a.district)].includes(address)
  if (specificAddress && address === otherAddress) return true
  return near === true && Boolean(aCategory && aCategory === bCategory)
}

/** 整条替换保留同一 POI 的来源边界，避免把不同 ID 的字段拼成一个地点。 */
export function preferPlaceSnapshot(next: Place, current: Place): boolean {
  const score = (place: Place) => Number(!!place.coordinates) * 4 + Number(!!place.city) * 2
    + Number(!!place.district) * 2 + Number(!!place.category) + Number(!!place.address) + Number(!!place.businessArea)
  return score(next) > score(current)
}

export interface ItineraryCandidateGroup {
  entries: PlaceDetailsResult[]
  snapshot: PlaceDetailsResult
}

/** 两批搜索沿用同一组。跨 ID 合并须与组内已有证据一致，避免经缺字段记录桥接冲突。 */
export function addItineraryCandidate(groups: ItineraryCandidateGroup[], snapshot: PlaceDetailsResult,
  rank: (place: Place) => number): boolean {
  const group = groups.find(group => group.entries.some(entry => entry.place.id === snapshot.place.id))
    ?? groups.find(group => group.entries.every(entry => sameItineraryPlace(entry.place, snapshot.place)))
  if (!group) {
    groups.push({ entries: [snapshot], snapshot })
    return true
  }
  group.entries.push(snapshot)
  const prior = group.snapshot.place
  const priority = rank(snapshot.place) - rank(prior)
  if (priority > 0 || (priority === 0 && preferPlaceSnapshot(snapshot.place, prior))) group.snapshot = snapshot
  return false
}

/** 同一优先层内照顾类别、场馆多样性，排序本身不会触发补查。 */
export function diverseItineraryPlaces<T>(items: readonly T[], place: (item: T) => Place,
  priority: (item: T) => number, limit: number): T[] {
  const remaining = [...items]
  const chosen: T[] = []
  const categories = new Set<string>()
  const venues = new Set<string>()
  const venue = (point: Place) => normalize(point.name).replace(/\([^()]+\)$/u, '')
  const score = (item: T) => {
    const point = place(item)
    return priority(item) * 4 + Number(!venues.has(venue(point))) * 2
      + Number(!!category(point) && !categories.has(category(point)))
  }
  while (remaining.length && chosen.length < limit) {
    let best = 0
    for (let index = 1; index < remaining.length; index++) {
      if (score(remaining[index]) > score(remaining[best])) best = index
    }
    const [next] = remaining.splice(best, 1)
    chosen.push(next)
    venues.add(venue(place(next)))
    categories.add(category(place(next)))
  }
  return chosen
}
