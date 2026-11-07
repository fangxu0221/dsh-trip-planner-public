/** 收藏列表和编辑表单共用后端快照，供独立入口及选点弹窗使用。 */
import { useState, type FormEvent } from 'react'
import type { RenameSavedPlaceRequest, SavedPlaceOption, SavedPlaceTarget, SavePlaceRequest } from '../types.ts'
import type { TripClientState } from './model.ts'

export interface SavedPlaceActions {
  onConnectFavorites: () => Promise<void>
  onSavePlace: (request: SavePlaceRequest) => Promise<boolean>
  onRenameSavedPlace: (request: RenameSavedPlaceRequest) => Promise<boolean>
  onRemoveSavedPlace: (target: SavedPlaceTarget) => Promise<boolean>
}

type ListProps = SavedPlaceActions & Pick<TripClientState, 'favorites' | 'write'> & {
  onSelect?: (place: SavedPlaceOption) => void
}
type FavoriteEdit = { kind: 'save'; placeId: string; name: string }
  | { kind: 'rename' | 'remove'; target: SavedPlaceTarget }

const statusLabels = { connecting: '正在连接收藏…', live: '收藏已同步', reconnecting: '连接中断，正在恢复…', failed: '收藏同步失败' }

export function SavedPlacesList({ favorites, write, onSelect, ...actions }: ListProps) {
  const [edit, setEdit] = useState<Exclude<FavoriteEdit, { kind: 'save' }> | null>(null)
  const places = favorites.view?.places ?? []
  const canEdit = favorites.status === 'live' && write.status !== 'pending'
  return <div className="trip-planner-options">
    <div className="trip-planner-subheading">
      <h3>已有收藏</h3>
      {favorites.status === 'failed' && <button type="button" onClick={() => void actions.onConnectFavorites()}>重新连接</button>}
    </div>
    <p role="status" className="trip-planner-muted">{statusLabels[favorites.status]}</p>
    {favorites.view && (places.length === 0 ? <p>暂无收藏，可以搜索地点。</p> :
      <ul>{places.map(place => {
        const target = { id: place.id, alias: place.alias }
        const title = <><strong>{place.alias}</strong><small>{[place.name, place.city, place.address].filter(Boolean).join(' · ')}</small></>
        return <li key={place.id} className="trip-planner-option-row">
          {onSelect ? <button type="button" onClick={() => onSelect(place)}>{title}</button>
            : <div className="trip-planner-entry-title">{title}</div>}
          <button type="button" disabled={!canEdit} aria-label={'改名 ' + place.alias}
            onClick={() => setEdit({ kind: 'rename', target })}>改名</button>
          <button type="button" disabled={!canEdit} aria-label={'取消收藏 ' + place.alias}
            onClick={() => setEdit({ kind: 'remove', target })}>取消收藏</button>
        </li>
      })}</ul>)}
    {edit && <SavedPlaceEditForm key={edit.kind + edit.target.id} edit={edit} write={write} canEdit={canEdit}
      onClose={() => setEdit(current => current === edit ? null : current)} {...actions} />}
    <SavedPlaceFeedback write={write} />
  </div>
}

export function SavedPlaceEditForm({ edit, write, canEdit, onClose, ...actions }: SavedPlaceActions & {
  edit: FavoriteEdit; write: TripClientState['write']; canEdit: boolean; onClose: () => void
}) {
  const [alias, setAlias] = useState(edit.kind === 'rename' ? edit.target.alias : '')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const nextAlias = alias.trim()
    if (!canEdit || (edit.kind !== 'remove' && !nextAlias)) return
    const success = edit.kind === 'save' ? await actions.onSavePlace({ placeId: edit.placeId, alias: nextAlias })
      : edit.kind === 'rename' ? await actions.onRenameSavedPlace({ target: edit.target, newAlias: nextAlias })
        : await actions.onRemoveSavedPlace(edit.target)
    if (success) onClose()
  }
  return <form className="trip-planner-edit" onSubmit={submit}>
    <h4>{edit.kind === 'save' ? '收藏 ' + edit.name : edit.kind === 'rename' ? '改名 ' + edit.target.alias : '取消收藏「' + edit.target.alias + '」？'}</h4>
    {edit.kind !== 'remove' && <label>收藏别名
      <input required maxLength={50} value={alias} onChange={event => setAlias(event.target.value)} />
    </label>}
    <div className="trip-planner-edit-actions">
      <button type="submit" disabled={!canEdit || (edit.kind !== 'remove' && !alias.trim())}>
        {write.status === 'pending' ? '提交中…' : edit.kind === 'remove' ? '确认取消收藏' : '保存收藏别名'}
      </button>
      <button type="button" disabled={write.status === 'pending'} onClick={onClose}>返回</button>
    </div>
  </form>
}

export function SavedPlaceFeedback({ write }: Pick<TripClientState, 'write'>) {
  if (write.status === 'error') return <p role="alert" className="trip-planner-error">{write.message}</p>
  if (write.status === 'success') return <p role="status">{write.message}</p>
  return null
}
