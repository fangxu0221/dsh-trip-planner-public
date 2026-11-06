/** 只在选择端点时展开搜索或收藏，关闭后释放弹窗和输入草稿。 */
import { useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import type { EndpointReference, SavedPlaceOption, SavedPlaceTarget } from '../types.ts'
import type { TripClientState, TripQueries } from './model.ts'
import type { TripPanelInjected } from './TripPanel.tsx'

export interface Selection { reference: EndpointReference; name: string; address: string | null }
type Actions = Pick<TripPanelInjected, 'onConnectFavorites' | 'onSavePlace' | 'onRenameSavedPlace' | 'onRemoveSavedPlace'>
type Props = Actions & Pick<TripClientState, 'favorites' | 'write'> & {
  title: string
  search: ReturnType<TripQueries['state']['getSnapshot']>['search']
  queries: TripQueries
  onClose: () => void
  onSelect: (selection: Selection) => void
}
type FavoriteEdit = { kind: 'save'; placeId: string; name: string }
  | { kind: 'rename' | 'remove'; target: SavedPlaceTarget }

const statusLabels = { connecting: '正在连接收藏…', live: '收藏已同步', reconnecting: '连接中断，正在恢复…', failed: '收藏同步失败' }

export function savedSelection(place: SavedPlaceOption): Selection {
  return { reference: { kind: 'saved', alias: place.alias, expectedId: place.id },
    name: place.alias + ' · ' + place.name, address: place.address }
}

export function PlacePicker({ title, search, favorites, write, queries, onClose, onSelect, ...actions }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const [view, setView] = useState<'search' | 'favorites'>('search')
  const [keywords, setKeywords] = useState('')
  const [city, setCity] = useState('')
  const [edit, setEdit] = useState<FavoriteEdit | null>(null)
  const [alias, setAlias] = useState('')
  const places = favorites.view?.places ?? []
  const favoriteIds = new Set(places.map(place => place.placeId))
  const canEdit = favorites.status === 'live' && write.status !== 'pending'

  useLayoutEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => element?.close()
  }, [])

  function openEdit(next: FavoriteEdit) {
    setEdit(next)
    setAlias(next.kind === 'rename' ? next.target.alias : '')
  }

  async function submitEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!edit || !canEdit) return
    const nextAlias = alias.trim()
    if (edit.kind !== 'remove' && !nextAlias) return
    const success = edit.kind === 'save' ? await actions.onSavePlace({ placeId: edit.placeId, alias: nextAlias })
      : edit.kind === 'rename' ? await actions.onRenameSavedPlace({ target: edit.target, newAlias: nextAlias })
        : await actions.onRemoveSavedPlace(edit.target)
    if (success) setEdit(current => current === edit ? null : current)
  }

  function searchPlaces(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (keywords.trim()) void queries.search({ keywords: keywords.trim(), city: city.trim() || undefined })
  }

  return <dialog ref={dialog} className="trip-planner-picker trip-planner-card" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose() }}>
    <div className="trip-planner-subheading">
      <h2 id={titleId}>{title}</h2>
      <button type="button" onClick={onClose}>关闭</button>
    </div>
    <div className="trip-planner-picker-tabs" role="group" aria-label="选点来源">
      <button type="button" aria-pressed={view === 'search'} onClick={() => { setView('search'); setEdit(null) }}>搜索地点</button>
      <button type="button" aria-pressed={view === 'favorites'} onClick={() => { setView('favorites'); setEdit(null) }}>我的收藏</button>
    </div>
    {view === 'search' ? <>
      <form className="trip-planner-search" onSubmit={searchPlaces}>
        <label>地点关键词<input autoFocus required maxLength={100} value={keywords} placeholder="输入地点名称"
          onChange={event => { setKeywords(event.target.value); queries.reset('search') }} /></label>
        <label>城市<input maxLength={50} value={city} placeholder="默认城市"
          onChange={event => { setCity(event.target.value); queries.reset('search') }} /></label>
        <button type="submit" disabled={!keywords.trim() || search.status === 'loading'}>
          {search.status === 'loading' ? '搜索中…' : '搜索'}
        </button>
      </form>
      {search.status === 'error' && <p role="alert" className="trip-planner-error">{search.message}</p>}
      {search.status === 'success' && <div className="trip-planner-options">
        <h3>{search.value.query.city} · 搜索结果</h3>
        {search.value.places.length === 0 ? <p role="status">没有找到地点，可以更换关键词或城市。</p> :
          <ul>{search.value.places.map(place => <li key={place.id} className="trip-planner-option-row">
            <button type="button" onClick={() => onSelect({ reference: { kind: 'poi', placeId: place.id }, name: place.name, address: place.address })}>
              <strong>{place.name}</strong><small>{[place.city, place.address].filter(Boolean).join(' · ') || '来源未提供地址'}</small>
            </button>
            {favoriteIds.has(place.id) ? <small>已收藏</small> : <button type="button" disabled={!canEdit}
              aria-label={'收藏 ' + place.name} onClick={() => openEdit({ kind: 'save', placeId: place.id, name: place.name })}>收藏</button>}
          </li>)}</ul>}
        {search.value.warnings.map((warning, index) => <p className="trip-planner-muted" key={index}>{warning}</p>)}
      </div>}
    </> : <div className="trip-planner-options">
      <div className="trip-planner-subheading">
        <h3>已有收藏</h3>
        {favorites.status === 'failed' && <button type="button" onClick={() => void actions.onConnectFavorites()}>重新连接</button>}
      </div>
      <p role="status" className="trip-planner-muted">{statusLabels[favorites.status]}</p>
      {favorites.view && (places.length === 0 ? <p>暂无收藏，可以搜索地点。</p> :
        <ul>{places.map(place => <li key={place.id} className="trip-planner-option-row">
          <button type="button" onClick={() => onSelect(savedSelection(place))}>
            <strong>{place.alias}</strong><small>{[place.name, place.city, place.address].filter(Boolean).join(' · ')}</small>
          </button>
          <button type="button" disabled={!canEdit} aria-label={'改名 ' + place.alias}
            onClick={() => openEdit({ kind: 'rename', target: { id: place.id, alias: place.alias } })}>改名</button>
          <button type="button" disabled={!canEdit} aria-label={'取消收藏 ' + place.alias}
            onClick={() => openEdit({ kind: 'remove', target: { id: place.id, alias: place.alias } })}>取消收藏</button>
        </li>)}</ul>)}
    </div>}
    {edit && <form className="trip-planner-edit" onSubmit={submitEdit}>
      <h4>{edit.kind === 'save' ? '收藏 ' + edit.name : edit.kind === 'rename' ? '改名 ' + edit.target.alias : '取消收藏「' + edit.target.alias + '」？'}</h4>
      {edit.kind !== 'remove' && <label>收藏别名
        <input required maxLength={50} value={alias} onChange={event => setAlias(event.target.value)} />
      </label>}
      <div className="trip-planner-edit-actions">
        <button type="submit" disabled={!canEdit || (edit.kind !== 'remove' && !alias.trim())}>
          {write.status === 'pending' ? '提交中…' : edit.kind === 'remove' ? '确认取消收藏' : '保存收藏别名'}
        </button>
        <button type="button" disabled={write.status === 'pending'} onClick={() => setEdit(null)}>返回</button>
      </div>
    </form>}
    {write.status === 'error' && <p role="alert" className="trip-planner-error">{write.message}</p>}
    {write.status === 'success' && <p role="status">{write.message}</p>}
  </dialog>
}
