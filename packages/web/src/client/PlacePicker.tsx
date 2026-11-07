/** 复用地点搜索弹窗，支持选择端点和独立添加收藏。 */
import { useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import type { EndpointReference, SavedPlaceOption } from '../types.ts'
import type { TripClientState, TripQueries } from './model.ts'
import { SavedPlaceEditForm, SavedPlaceFeedback, SavedPlacesList, type SavedPlaceActions } from './SavedPlacesList.tsx'
import { TripGlyph } from './TripGlyph.tsx'

export interface Selection { reference: EndpointReference; name: string; address: string | null }
type Props = SavedPlaceActions & Pick<TripClientState, 'favorites' | 'write'> & {
  title: string
  purpose: 'origin' | 'destination' | 'add-favorite'
  search: ReturnType<TripQueries['state']['getSnapshot']>['search']
  queries: TripQueries
  onClose: () => void
  onSelect?: (selection: Selection) => void
}

export function savedSelection(place: SavedPlaceOption): Selection {
  return { reference: { kind: 'saved', alias: place.alias, expectedId: place.id },
    name: place.alias + ' · ' + place.name, address: place.address }
}

export function PlacePicker({ title, purpose, search, favorites, write, queries, onClose, onSelect, ...actions }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const [view, setView] = useState<'search' | 'favorites'>('search')
  const [keywords, setKeywords] = useState('')
  const [city, setCity] = useState('')
  const [edit, setEdit] = useState<{ kind: 'save'; placeId: string; name: string } | null>(null)
  const places = favorites.view?.places ?? []
  const favoriteIds = new Set(places.map(place => place.placeId))
  const canEdit = favorites.status === 'live' && write.status !== 'pending'

  useLayoutEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => element?.close()
  }, [])

  function searchPlaces(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (keywords.trim()) void queries.search({ keywords: keywords.trim(), city: city.trim() || undefined })
  }

  return <dialog ref={dialog} className="trip-planner-picker trip-planner-card" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose() }}>
    <div className="trip-planner-picker-header">
      <span className="trip-planner-picker-icon" data-purpose={purpose}><TripGlyph name={purpose === 'add-favorite' ? 'favorites' : purpose} /></span>
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
        <div className="trip-planner-search-primary">
          <label className="trip-planner-keyword">
            <TripGlyph name="search" />
            <input aria-label="地点关键词" autoFocus required maxLength={100} value={keywords} placeholder="输入地名、地铁站或地址"
              onChange={event => { setKeywords(event.target.value); setEdit(null); queries.reset('search') }} />
          </label>
          <button type="submit" disabled={!keywords.trim() || search.status === 'loading'}>
            {search.status === 'loading' ? '搜索中…' : '搜索'}
          </button>
        </div>
        <details className="trip-planner-city">
          <summary>城市 · {city.trim() || '使用默认城市'}</summary>
          <label>城市<input maxLength={50} value={city} placeholder="例如广州"
            onChange={event => { setCity(event.target.value); setEdit(null); queries.reset('search') }} /></label>
        </details>
      </form>
      {search.status === 'idle' && <p className="trip-planner-picker-hint"><TripGlyph name="search" />输入关键词后搜索地点。</p>}
      {search.status === 'loading' && <p role="status" className="trip-planner-picker-hint">正在查找地点…</p>}
      {search.status === 'error' && <p role="alert" className="trip-planner-error">{search.message}</p>}
      {search.status === 'success' && <div className="trip-planner-options trip-planner-search-results">
        <h3>{search.value.query.city} · {search.value.places.length} 个结果</h3>
        {search.value.places.length === 0 ? <p role="status">没有找到地点，可以更换关键词或城市。</p> :
          <ul>{search.value.places.map(place => {
            const details = <><strong>{place.name}</strong><small>{[place.city, place.address].filter(Boolean).join(' · ') || '来源未提供地址'}</small></>
            return <li key={place.id} className="trip-planner-option-row">
              {onSelect ? <button className="trip-planner-search-result" type="button"
                onClick={() => onSelect({ reference: { kind: 'poi', placeId: place.id }, name: place.name, address: place.address })}>
                <TripGlyph name="destination" /><span className="trip-planner-entry-title">{details}</span>
              </button> : <div className="trip-planner-search-result"><TripGlyph name="destination" />
                <span className="trip-planner-entry-title">{details}</span></div>}
              {favoriteIds.has(place.id) ? <small>已收藏</small> : <button type="button" disabled={!canEdit}
                className="trip-planner-search-bookmark" aria-label={'收藏 ' + place.name} title={'收藏 ' + place.name}
                onClick={() => setEdit({ kind: 'save', placeId: place.id, name: place.name })}><TripGlyph name="favorites" /></button>}
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
