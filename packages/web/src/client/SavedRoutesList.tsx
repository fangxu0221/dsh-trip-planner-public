/** 常用路线列表解析当前收藏名称，并提供重算、改名、删除和修复入口。 */
import { useState, type FormEvent } from 'react'
import type { RenameSavedRouteRequest, RouteMode, SavedRouteEndpoint, SavedRouteOption } from '../types.ts'
import { savedSelection, type Selection } from './PlacePicker.tsx'
import type { TripClientState } from './model.ts'

export const modes = { walking: '步行', bicycling: '骑行', driving: '驾车', transit: '公共交通' } satisfies Record<RouteMode, string>
type RouteState = Pick<TripClientState, 'savedRoutes' | 'favorites' | 'routeWrite'>
type Edit = { kind: 'rename' | 'remove'; route: SavedRouteOption }

export function savedRouteSelection(endpoint: SavedRouteEndpoint, favorites: TripClientState['favorites']): Selection | undefined {
  if (endpoint.kind === 'poi') return { reference: { kind: 'poi', placeId: endpoint.placeId }, name: endpoint.label, address: null }
  const place = favorites.view?.places.find(place => place.id === endpoint.savedPlaceId)
  return place && savedSelection(place)
}

type Props = RouteState & {
  onConnectSavedRoutes: () => Promise<void>
  onRenameSavedRoute: (request: RenameSavedRouteRequest) => Promise<boolean>
  onRemoveSavedRoute: (id: string) => Promise<boolean>
  onOpenRoute: (route: SavedRouteOption, repair: boolean) => void
}

export function SavedRoutesList({ favorites, savedRoutes, routeWrite, ...actions }: Props) {
  const [edit, setEdit] = useState<Edit | null>(null)
  const routes = savedRoutes.view?.routes ?? []
  const canEdit = savedRoutes.status === 'live' && routeWrite.status !== 'pending'
  return <div className="trip-planner-options">
    {savedRoutes.status !== 'live' && <p role="status">
      {savedRoutes.status === 'failed' ? '常用路线同步失败。' : '正在同步常用路线…'}
    </p>}
    {savedRoutes.status === 'failed' && <button type="button" onClick={() => void actions.onConnectSavedRoutes()}>重新连接常用路线</button>}
    {savedRoutes.view && routes.length === 0 && <p>暂无常用路线。查到路线后可以保存。</p>}
    <ul>{routes.map(route => {
      const origin = savedRouteSelection(route.origin, favorites)
      const destination = savedRouteSelection(route.destination, favorites)
      const needsFavorites = route.origin.kind === 'saved' || route.destination.kind === 'saved'
      const canResolve = !needsFavorites || favorites.status === 'live'
      const missing = canResolve && (!origin || !destination)
      return <li key={route.id} className="trip-planner-option-row trip-planner-saved-route">
        <div className="trip-planner-entry-title">
          <strong>{route.name} · {modes[route.mode]}</strong>
          <small>{origin?.name ?? route.origin.label} → {destination?.name ?? route.destination.label}</small>
          {missing && <small className="trip-planner-error">{!origin && !destination ? '起点和终点' : !origin ? '起点' : '终点'}需重选</small>}
          {!canResolve && <small>等待地点收藏同步</small>}
        </div>
        <button type="button" disabled={savedRoutes.status !== 'live' || !canResolve}
          aria-label={(missing ? '重新选点 ' : '重新规划 ') + route.name}
          onClick={() => actions.onOpenRoute(route, missing)}>{missing ? '重新选点' : '重新规划'}</button>
        <button type="button" disabled={!canEdit} aria-label={'改名路线 ' + route.name}
          onClick={() => setEdit({ kind: 'rename', route })}>改名</button>
        <button type="button" disabled={!canEdit} aria-label={'删除路线 ' + route.name}
          onClick={() => setEdit({ kind: 'remove', route })}>删除</button>
      </li>
    })}</ul>
    {edit?.kind === 'rename' && <RouteNameForm key={edit.route.id} title={'改名路线「' + edit.route.name + '」'}
      initialName={edit.route.name} canSubmit={canEdit} pending={routeWrite.status === 'pending'}
      onSave={name => actions.onRenameSavedRoute({ id: edit.route.id, name })}
      onClose={() => setEdit(current => current === edit ? null : current)} />}
    {edit?.kind === 'remove' && <div className="trip-planner-edit">
      <h4>删除常用路线「{edit.route.name}」？</h4>
      <div className="trip-planner-edit-actions">
        <button type="button" disabled={!canEdit} onClick={async () => {
          if (await actions.onRemoveSavedRoute(edit.route.id)) setEdit(current => current === edit ? null : current)
        }}>确认删除路线</button>
        <button type="button" disabled={routeWrite.status === 'pending'} onClick={() => setEdit(null)}>返回</button>
      </div>
    </div>}
  </div>
}

export function RouteNameForm({ title, initialName, canSubmit, pending, onSave, onClose }: {
  title: string; initialName?: string; canSubmit: boolean; pending: boolean;
  onSave: (name: string) => Promise<boolean>; onClose: () => void
}) {
  const [name, setName] = useState(initialName ?? '')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (canSubmit && name.trim() && await onSave(name)) onClose()
  }
  return <form className="trip-planner-edit" onSubmit={submit}>
    <h4>{title}</h4>
    <label>路线名称<input required maxLength={50} value={name} onChange={event => setName(event.target.value)} /></label>
    <div className="trip-planner-edit-actions">
      <button type="submit" disabled={!canSubmit || !name.trim()}>{pending ? '提交中…' : '保存路线名称'}</button>
      <button type="button" disabled={pending} onClick={onClose}>返回</button>
    </div>
  </form>
}
