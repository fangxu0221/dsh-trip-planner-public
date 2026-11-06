/** 会话右栏主体，端点和路线随当前标签页保留。 */
import { useEffect, useState, useSyncExternalStore, type FormEvent } from 'react'
import type { HostObservable, InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { RenameSavedPlaceRequest, RouteMode, SavedPlaceOption, SavedPlaceTarget, SavePlaceRequest } from '../types.ts'
import type { TripClientState, TripQueries } from './model.ts'
import { PlacePicker, savedSelection, type Selection } from './PlacePicker.tsx'
import { RouteResults } from './RouteResults.tsx'

export interface TripPanelInjected {
  hooks: { trip: HostObservable<TripClientState> }
  createQueries: () => TripQueries
  onConnectFavorites: () => Promise<void>
  onSavePlace: (request: SavePlaceRequest) => Promise<boolean>
  onRenameSavedPlace: (request: RenameSavedPlaceRequest) => Promise<boolean>
  onRemoveSavedPlace: (target: SavedPlaceTarget) => Promise<boolean>
}

type Props = PropsRuntime<'sidebar.right.pane.tab'> & InjectFace<TripPanelInjected>
type Endpoint = 'origin' | 'destination'

const endpointLabels = { origin: '起点', destination: '终点' } as const
const modes = { walking: '步行', bicycling: '骑行', driving: '驾车', transit: '公共交通' } satisfies Record<RouteMode, string>

function currentSelection(selection: Selection | undefined, places: SavedPlaceOption[]): Selection | undefined {
  if (selection?.reference.kind !== 'saved') return selection
  const id = selection.reference.expectedId
  const place = places.find(place => place.id === id)
  return place && savedSelection(place)
}

export function TripPanel({ useTrip, useTabInfo, createQueries, ...actions }: Props) {
  const { tab } = useTabInfo()
  const { favorites, write } = useTrip(state => state)
  const [queries] = useState(createQueries)
  const { search, route } = useSyncExternalStore(queries.state.subscribe, queries.state.getSnapshot)
  const [picker, setPicker] = useState<Endpoint | null>(null)
  const [endpoints, setEndpoints] = useState<Partial<Record<Endpoint, Selection>>>({})
  const [mode, setMode] = useState<RouteMode | ''>('')
  const [endpointNotice, setEndpointNotice] = useState('')
  const places = favorites.view?.places ?? []
  const origin = currentSelection(endpoints.origin, places)
  const destination = currentSelection(endpoints.destination, places)
  const selections = { origin, destination }
  const missingOrigin = !!endpoints.origin && !origin
  const missingDestination = !!endpoints.destination && !destination
  const missingEndpoint = missingOrigin || missingDestination
  const usesSaved = origin?.reference.kind === 'saved' || destination?.reference.kind === 'saved'
  const canPlan = !!origin && !!destination && !!mode && (!usesSaved || favorites.status === 'live')

  useEffect(() => {
    if (!missingEndpoint) return
    setEndpoints(current => ({
      origin: missingOrigin ? undefined : current.origin,
      destination: missingDestination ? undefined : current.destination,
    }))
    setEndpointNotice('已选收藏已被取消，请重新选择地点。')
    queries.reset('route')
  }, [missingEndpoint, missingOrigin, missingDestination, queries])

  useEffect(() => {
    if (!tab.visible) {
      setPicker(null)
      queries.reset('search')
    }
  }, [tab.visible, queries])

  useEffect(() => {
    const cancel = () => { queries.reset('search'); queries.reset('route') }
    tab.signal.addEventListener('abort', cancel, { once: true })
    return () => {
      tab.signal.removeEventListener('abort', cancel)
      cancel()
    }
  }, [queries, tab.signal])

  function closePicker() {
    setPicker(null)
    queries.reset('search')
  }

  function select(selection: Selection) {
    if (!picker) return
    setEndpoints(current => ({ ...current, [picker]: selection }))
    setEndpointNotice('')
    queries.reset('route')
    closePicker()
  }

  function plan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (canPlan && origin && destination && mode) {
      void queries.plan({ origin: origin.reference, destination: destination.reference, mode })
    }
  }

  return <section className="trip-planner-panel" aria-label="出行规划面板">
    <header className="trip-planner-heading">
      <p>高德地图</p>
      <h1>出行规划</h1>
    </header>
    <section className="trip-planner-card" aria-label="路线设置">
      <div className="trip-planner-endpoints" role="group" aria-label="起点和终点">
        {(['origin', 'destination'] as const).map(endpoint => {
          const selection = selections[endpoint]
          return <button key={endpoint} type="button" aria-haspopup="dialog" onClick={() => setPicker(endpoint)}>
            <span>{endpointLabels[endpoint]}</span>
            <strong>{selection?.name ?? '点击选择'}</strong>
            {selection?.address && <small>{selection.address}</small>}
          </button>
        })}
      </div>
      <form className="trip-planner-route-form" onSubmit={plan}>
        <label>交通方式<select value={mode} onChange={event => { setMode(event.target.value as RouteMode | ''); queries.reset('route') }}>
          <option value="">选择交通方式</option>
          {Object.entries(modes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <button type="submit" disabled={!canPlan || route.status === 'loading'}>
          {route.status === 'loading' ? '规划中…' : '规划路线'}
        </button>
      </form>
      {endpointNotice && <p role="status">{endpointNotice}</p>}
      {route.status === 'idle' && !endpointNotice && <p className="trip-planner-muted">选好起终点和交通方式后查询。</p>}
      {!missingEndpoint && route.status === 'loading' && <p role="status">正在查询路线…</p>}
      {!missingEndpoint && route.status === 'error' && <p role="alert" className="trip-planner-error">{route.message}</p>}
    </section>
    {!missingEndpoint && route.status === 'success' && <RouteResults result={route.value} />}
    {picker && tab.visible && <PlacePicker title={'选择' + endpointLabels[picker]}
      search={search} favorites={favorites} write={write} queries={queries}
      onClose={closePicker} onSelect={select}
      onConnectFavorites={actions.onConnectFavorites} onSavePlace={actions.onSavePlace}
      onRenameSavedPlace={actions.onRenameSavedPlace} onRemoveSavedPlace={actions.onRemoveSavedPlace} />}
  </section>
}
