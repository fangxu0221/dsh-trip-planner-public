/** 业务数据类型：描述地点搜索的输入和统一输出，不包含高德协议调用代码。 */

/** 模型或其他消费方提交的搜索条件；省略项由服务提供方填默认值。 */
export interface SearchPlacesQuery {
  keywords: string
  city?: string
  limit?: number
  refresh?: boolean
}

/** 已完成校验、去除首尾空白并填好默认值的条件。 */
export interface ResolvedSearchPlacesQuery {
  keywords: string
  city: string
  limit: number
}

/** 经度在前、纬度在后；只采用来源实际返回的坐标。 */
export interface Coordinates {
  longitude: number
  latitude: number
}

/** 行政区划取自高德结构化字段，缺失时保留未知。 */
export interface PlaceRegion {
  city: string | null
  district: string | null
}

/** 缺失的地址、城市或坐标使用 null，不从搜索条件或模型推测补齐。 */
export interface Place {
  id: string
  name: string
  address: string | null
  city: string | null
  coordinates: Coordinates | null
  district?: string
  category?: string
  businessArea?: string
}

/** sourceCount 是本次上游返回数，truncated 只表示本地数量限制，不代表完整搜索覆盖率。 */
export interface PlacesSearchResult {
  source: 'AMAP'
  fetchedAt: string
  query: ResolvedSearchPlacesQuery
  sourceCount: number
  returned: number
  truncated: boolean
  places: Place[]
  warnings: string[]
}

export interface ItineraryPlacesSearchResult extends PlacesSearchResult {
  duplicateIds?: number
}
/** 高德地点快照；经行程核验的搜索结果也可供内部路线解析使用。 */
export interface PlaceDetailsResult {
  source: 'AMAP'
  fetchedAt: string
  place: Place
  via?: 'search'
}
