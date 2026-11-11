/** 复用地点搜索弹窗，支持选择端点和独立添加收藏。 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import type { CachedPlaceOption, EndpointReference, SavedPlaceOption } from '../types.ts'
import type { TripClientState, TripQueries } from './model.ts'
import { SavedPlaceEditForm, SavedPlaceFeedback, SavedPlacesList, type SavedPlaceActions } from './SavedPlacesList.tsx'
import { TripGlyph } from './TripGlyph.tsx'

export interface Selection { reference: EndpointReference; name: string; address: string | null }
type Props = SavedPlaceActions & Pick<TripClientState, 'favorites' | 'write'> & {
  title: string
  purpose: 'origin' | 'destination' | 'waypoint' | 'add-favorite'
  search: ReturnType<TripQueries['state']['getSnapshot']>['search']
  cached: ReturnType<TripQueries['state']['getSnapshot']>['cached']
  cacheStats: ReturnType<TripQueries['state']['getSnapshot']>['cacheStats']
  queries: TripQueries
  onClose: () => void
  onSelect?: (selection: Selection) => void
}

export function savedSelection(place: SavedPlaceOption): Selection {
  return { reference: { kind: 'saved', alias: place.alias, expectedId: place.id },
    name: place.alias + ' · ' + place.name, address: place.address }
}

export function PlacePicker({ title, purpose, search, cached, cacheStats, favorites, write, queries, onClose, onSelect, ...actions }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const candidatesId = useId()
  const popover = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<'search' | 'favorites'>('search')
  const [keywords, setKeywords] = useState('')
  const [city, setCity] = useState('')
  const [showCached, setShowCached] = useState(false)
  const [activeCached, setActiveCached] = useState(-1)
  const [edit, setEdit] = useState<{ kind: 'save'; placeId: string; name: string } | null>(null)
  const places = favorites.view?.places ?? []
  const favoriteIds = new Set(places.map(place => place.placeId))
  const canEdit = favorites.status === 'live' && write.status !== 'pending'
  const candidates = cached.status === 'success' ? cached.value.places : []

  useLayoutEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => element?.close()
  }, [])

  useEffect(() => {
    if (!showCached || view !== 'search') return
    const timer = setTimeout(() => { void queries.cachedPlaces({ keywords: keywords.trim(), city: city.trim() || undefined }) }, 150)
    return () => { clearTimeout(timer); queries.reset('cached') }
  }, [showCached, view, keywords, city, queries])

  useEffect(() => {
    if (showCached) void queries.cacheStats()
  }, [showCached, queries])

  useEffect(() => {
    const outside = (event: MouseEvent) => {
      if (event.target instanceof Node && !popover.current?.contains(event.target)) setShowCached(false)
    }
    document.addEventListener('click', outside)
    return () => document.removeEventListener('click', outside)
  }, [])

  function chooseCached(place: CachedPlaceOption) {
    if (!onSelect && !canEdit) return
    setShowCached(false)
    setActiveCached(-1)
    void queries.touchCachedPlace(place.placeId)
    if (onSelect) onSelect({ reference: { kind: 'poi', placeId: place.placeId }, name: place.name, address: place.address })
    else setEdit({ kind: 'save', placeId: place.placeId, name: place.name })
  }

  function searchPlaces(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setShowCached(false)
    if (keywords.trim()) void queries.search({ keywords: keywords.trim(), city: city.trim() || undefined })
  }

  return <dialog ref={dialog} className="trip-planner-picker trip-planner-card" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose() }}>
    <div className="trip-planner-picker-header">
      <span className="trip-planner-picker-icon" data-purpose={purpose}><TripGlyph name={purpose === 'add-favorite' ? 'favorites'
        : purpose === 'waypoint' ? 'destination' : purpose} /></span>
      <div><h2 id={titleId}>{title}</h2><p>{onSelect ? '搜索地点或从收藏中选择' : '搜索地点并保存到收藏'}</p></div>
      <button className="trip-planner-picker-close" type="button" aria-label="关闭" onClick={onClose}><TripGlyph name="close" /></button>
    </div>
    {onSelect && <div className="trip-planner-picker-tabs" role="group" aria-label="选点来源">
      <button type="button" aria-pressed={view === 'search'} onClick={() => { setView('search'); setEdit(null) }}><TripGlyph name="search" />搜索地点</button>
      <button type="button" aria-pressed={view === 'favorites'} onClick={() => { setView('favorites'); setEdit(null) }}><TripGlyph name="favorites" />我的收藏</button>
    </div>}
    {onSelect && view === 'favorites' ?
      <SavedPlacesList favorites={favorites} write={write} onSelect={place => onSelect(savedSelection(place))} {...actions} /> : <>
      <form className="trip-planner-search" onSubmit={searchPlaces}>
        <div className="trip-planner-cache-popover" ref={popover}>
        <div className="trip-planner-search-primary">
          <label className="trip-planner-keyword">
            <TripGlyph name="search" />
            <input aria-label="地点关键词" autoFocus required maxLength={100} value={keywords} placeholder="输入地名、地铁站或地址"
              role="combobox" aria-autocomplete="list" aria-expanded={showCached} aria-controls={candidatesId}
              aria-activedescendant={showCached && activeCached >= 0 && candidates[activeCached] ? candidatesId + '-' + activeCached : undefined}
              onFocus={() => { setShowCached(true); setActiveCached(-1) }}
              onClick={() => setShowCached(true)}
              onKeyDown={event => {
                if (event.key === 'Tab') setShowCached(false)
                if (event.key === 'Escape' && showCached) { event.preventDefault(); event.stopPropagation(); setShowCached(false); return }
                if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && candidates.length) {
                  event.preventDefault(); setShowCached(true)
                  setActiveCached(current => event.key === 'ArrowDown' ? (current + 1) % candidates.length
                    : (current <= 0 ? candidates.length - 1 : current - 1))
                }
                if (event.key === 'Enter' && showCached && candidates[activeCached]) {
                  event.preventDefault(); chooseCached(candidates[activeCached])
                }
              }}
              onChange={event => { setKeywords(event.target.value); setEdit(null); setShowCached(true); setActiveCached(-1); queries.reset('cached'); queries.reset('search') }} />
          </label>
          <button type="submit" disabled={!keywords.trim() || search.status === 'loading'}>
            {search.status === 'loading' ? '搜索中…' : '搜索'}
          </button>
        </div>
        {showCached && <div className="trip-planner-cache-dropdown">
          <p>{keywords.trim() ? '匹配的缓存地点' : '最近缓存地点'}<small>本地筛选，不请求高德</small></p>
          <ul id={candidatesId} role="listbox" aria-label="缓存地点">
            {candidates.map((place, index) => <li key={place.placeId} role="presentation">
              <button type="button" role="option" tabIndex={-1} id={candidatesId + '-' + index} aria-selected={activeCached === index}
                aria-label={'缓存地点 ' + place.name + ' ' + (place.address ?? '')}
                disabled={!onSelect && !canEdit} onPointerDown={event => event.preventDefault()} onClick={() => chooseCached(place)}>
                <TripGlyph name="destination" /><span><strong>{place.name}</strong><small>{[place.city, place.address].filter(Boolean).join(' · ') || '来源未提供地址'}</small></span>
              </button>
            </li>)}
          </ul>
          {cached.status === 'loading' || cached.status === 'idle' ? <small role="status">正在读取本地缓存…</small>
            : cached.status === 'error' ? <small role="status">缓存暂不可用，仍可点击搜索。</small>
              : !candidates.length && <small role="status">暂无匹配缓存，可输入关键词并点击搜索。</small>}
        </div>}
        </div>
        <details className="trip-planner-city">
          <summary>城市 · {city.trim() || '使用默认城市'}</summary>
          <label>城市<input maxLength={50} value={city} placeholder="例如广州"
            onChange={event => { setCity(event.target.value); setEdit(null); setActiveCached(-1); queries.reset('cached'); queries.reset('search') }} /></label>
        </details>
      </form>
      <details className="trip-planner-cache-tools" onToggle={event => { if (event.currentTarget.open) void queries.cacheStats() }}>
        <summary>地点缓存</summary>
        {cacheStats.status === 'success' && <p>有效缓存 {cacheStats.value.entries} 条 · 本次复用 {cacheStats.value.cacheHits} 次 · 合并 {cacheStats.value.joinedRequests} 次<br />
          本插件高德工具请求 {cacheStats.value.searchCalls + cacheStats.value.detailCalls + cacheStats.value.routeCalls} 次
          {cacheStats.value.writeFailures > 0 && <><br />缓存保存失败 {cacheStats.value.writeFailures} 次</>}</p>}
        {cacheStats.status === 'error' && <p role="status">{cacheStats.message}</p>}
        <button type="button" disabled={cacheStats.status === 'loading'} onClick={() => { setShowCached(false); void queries.clearPlaceCache() }}>清空地点缓存</button>
        {keywords.trim() && <button type="button" disabled={search.status === 'loading'} onClick={() => {
          setShowCached(false); void queries.search({ keywords: keywords.trim(), city: city.trim() || undefined, refresh: true })
        }}>重新查询高德</button>}
      </details>
      {search.status === 'idle' && <p className="trip-planner-picker-hint"><TripGlyph name="search" />输入关键词后搜索地点。</p>}
      {search.status === 'loading' && <p role="status" className="trip-planner-picker-hint">正在查找地点…</p>}
      {search.status === 'error' && <p role="alert" className="trip-planner-error">{search.message}</p>}
      {search.status === 'success' && <div className="trip-planner-options trip-planner-search-results">
        <h3>{search.value.query.city} · {search.value.places.length} 个结果</h3>
        <small className="trip-planner-muted">原查询时间：{new Date(search.value.fetchedAt).toLocaleString()}</small>
        {search.value.places.length === 0 ? <p role="status">没有找到地点，可以更换关键词或城市。</p> :
          <ul>{search.value.places.map(place => {
            const details = <><strong>{place.name}</strong><small>{[place.city, place.address].filter(Boolean).join(' · ') || '来源未提供地址'}</small></>
            return <li key={place.id} className="trip-planner-option-row">
              {onSelect ? <button className="trip-planner-search-result" type="button"
                onClick={() => { void queries.touchCachedPlace(place.id); onSelect({ reference: { kind: 'poi', placeId: place.id }, name: place.name, address: place.address }) }}>
                <TripGlyph name="destination" /><span className="trip-planner-entry-title">{details}</span>
              </button> : <div className="trip-planner-search-result"><TripGlyph name="destination" />
                <span className="trip-planner-entry-title">{details}</span></div>}
              {favoriteIds.has(place.id) ? <small>已收藏</small> : <button type="button" disabled={!canEdit}
                className="trip-planner-search-bookmark" aria-label={'收藏 ' + place.name} title={'收藏 ' + place.name}
                onClick={() => { void queries.touchCachedPlace(place.id); setEdit({ kind: 'save', placeId: place.id, name: place.name }) }}><TripGlyph name="favorites" /></button>}
            </li>
          })}</ul>}
        {search.value.warnings.map((warning, index) => <p className="trip-planner-muted" key={index}>{warning}</p>)}
      </div>}
      {edit && <SavedPlaceEditForm key={edit.placeId} edit={edit} write={write} canEdit={canEdit}
        onClose={() => setEdit(current => current === edit ? null : current)} {...actions} />}
      <SavedPlaceFeedback write={write} />
      {!onSelect && favorites.status === 'failed' &&
        <button type="button" onClick={() => void actions.onConnectFavorites()}>重新连接收藏</button>}
    </>}
  </dialog>
}
