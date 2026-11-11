/** 会话右栏主体，端点和路线随当前标签页保留。 */
import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent } from 'react'
import type { HostObservable, InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { maxMultiStopPlaces } from '../../../../src/contracts/route-limits.ts'
import type {
  RenameSavedRouteRequest, RouteMode, RouteOrder, RouteResult, SavedPlaceOption, SavedRouteEndpoint, SavedRouteOption,
  SaveRouteRequest, UpdateSavedRouteEndpointsRequest,
} from '../types.ts'
import { type TripClientState, type TripQueries } from './model.ts'
import { ChatRouteResults } from './ChatRouteResults.tsx'
import { PlacePicker, savedSelection, type Selection } from './PlacePicker.tsx'
import { RouteResults } from './RouteResults.tsx'
import { MultiStopRouteResults } from './MultiStopRouteResults.tsx'
import { SavedPlacesList, type SavedPlaceActions } from './SavedPlacesList.tsx'
import { modes, RouteNameForm, savedRouteSelection, SavedRoutesList } from './SavedRoutesList.tsx'
import { TripGlyph } from './TripGlyph.tsx'

export interface TripPanelInjected extends SavedPlaceActions {
  hooks: { trip: HostObservable<TripClientState> }
  createQueries: () => TripQueries
  onConnectSavedRoutes: () => Promise<void>
  onSaveSavedRoute: (request: SaveRouteRequest) => Promise<boolean>
  onRenameSavedRoute: (request: RenameSavedRouteRequest) => Promise<boolean>
  onUpdateSavedRouteEndpoints: (request: UpdateSavedRouteEndpointsRequest) => Promise<boolean>
  onRemoveSavedRoute: (id: string) => Promise<boolean>
  onDismissChatRoute: (sessionId: string) => void
}

type Props = PropsRuntime<'sidebar.right.pane.tab'> & InjectFace<TripPanelInjected>
type Endpoint = 'origin' | 'destination'
interface Waypoint { id: number; selection?: Selection }

const endpointLabels = { origin: '起点', destination: '终点' } as const

function StopContent({ endpoint, label, name, address, index }: {
  endpoint: Endpoint | 'waypoint'; label: string; name: string; address?: string | null; index?: number
}) {
  return <>
    <span className="trip-planner-endpoint-marker" aria-hidden="true">
      {endpoint === 'waypoint' ? index : <TripGlyph name={endpoint} />}
    </span>
    <span className="trip-planner-endpoint-text">
      <small>{label}</small>
      <strong>{name}</strong>
      {address && <small>{address}</small>}
    </span>
  </>
}

function StopButton({ endpoint, label, selection, onClick, index }: {
  endpoint: Endpoint | 'waypoint'; label: string; selection?: Selection; onClick: () => void; index?: number
}) {
  return <button type="button" data-endpoint={endpoint} aria-haspopup="dialog" onClick={onClick}>
    <StopContent endpoint={endpoint} label={label} name={selection?.name ?? '点击选择'} address={selection?.address} index={index} />
    <span className="trip-planner-endpoint-next" aria-hidden="true">›</span>
  </button>
}

function ChatRouteStops({ result }: { result: RouteResult }) {
  const stops = 'stops' in result ? result.stops : [result.origin, result.destination]
  return <section className="trip-planner-controls" aria-label="对话路线地点与交通方式">
    <div className="trip-planner-endpoints">
      {stops.map((stop, index) => {
        const endpoint = index === 0 ? 'origin' : index === stops.length - 1 ? 'destination' : 'waypoint'
        const label = endpoint === 'waypoint' ? '途经点 ' + index : endpointLabels[endpoint]
        return <div key={index} data-endpoint={endpoint} className="trip-planner-chat-stop">
          <StopContent endpoint={endpoint} label={label} name={stop.alias ? stop.alias + ' · ' + stop.name : stop.name}
            address={stop.address} index={index} />
        </div>
      })}
    </div>
    <span className="trip-planner-mode trip-planner-chat-stop-mode" data-mode={result.mode}>
      <TripGlyph name={result.mode} />{modes[result.mode]}
    </span>
  </section>
}

function currentSelection(selection: Selection | undefined, places: SavedPlaceOption[]): Selection | undefined {
  if (selection?.reference.kind !== 'saved') return selection
  const id = selection.reference.expectedId
  const place = places.find(place => place.id === id)
  return place && savedSelection(place)
}

function routeEndpoint(selection: Selection | undefined): SavedRouteEndpoint | undefined {
  if (!selection) return
  const { reference, name: label } = selection
  if (reference.kind === 'poi') return { kind: 'poi', placeId: reference.placeId, label }
  if (reference.expectedId) return { kind: 'saved', savedPlaceId: reference.expectedId, label }
}

export function TripPanel({ sessionId, useTrip, useTabInfo, createQueries, ...actions }: Props) {
  const { tab } = useTabInfo()
  const shortcutsId = useId()
  const { favorites, write, savedRoutes, routeWrite, chatRoute } = useTrip(state => state)
  const [queries] = useState(createQueries)
  const { search, route, cached, cacheStats } = useSyncExternalStore(queries.state.subscribe, queries.state.getSnapshot)
  const [picker, setPicker] = useState<Endpoint | 'add-favorite' | number | null>(null)
  const [expanded, setExpanded] = useState<'favorites' | 'routes' | null>(null)
  const [repairId, setRepairId] = useState<string | null>(null)
  const [showSave, setShowSave] = useState(false)
  const [endpoints, setEndpoints] = useState<Partial<Record<Endpoint, Selection>>>({})
  const [waypoints, setWaypoints] = useState<Waypoint[]>([])
  const nextWaypointId = useRef(0)
  const [mode, setMode] = useState<RouteMode | ''>('')
  const [order, setOrder] = useState<RouteOrder>('given')
  const [endpointNotice, setEndpointNotice] = useState('')
  const [resultSource, setResultSource] = useState<'manual' | 'chat'>('manual')
  const [chatSelection, setChatSelection] = useState<{ groupId: string; mode: RouteMode }>()
  const seenChatVersion = useRef('')
  const conversation = chatRoute && chatRoute.sessionId === sessionId ? chatRoute.view : undefined
  const chatVersion = conversation?.groupId ?? ''
  const activeChat = (chatSelection?.groupId === chatVersion
    ? conversation?.results.find(item => item.result.mode === chatSelection.mode)?.result : undefined)
    ?? conversation?.results[0]?.result
  const showChat = !!activeChat && resultSource === 'chat'
  const places = favorites.view?.places ?? []
  const origin = currentSelection(endpoints.origin, places)
  const destination = currentSelection(endpoints.destination, places)
  const via = waypoints.map(point => currentSelection(point.selection, places))
  const stops = [origin, ...via, destination].filter((selection): selection is Selection => !!selection)
  const missingOrigin = !!endpoints.origin && !origin
  const missingDestination = !!endpoints.destination && !destination
  const missingWaypoint = waypoints.some((point, index) => point.selection && !via[index])
  const missingEndpoint = missingOrigin || missingDestination || missingWaypoint
  const usesSaved = stops.some(selection => selection.reference.kind === 'saved')
  const canPlan = stops.length === waypoints.length + 2 && !!mode && (!usesSaved || favorites.status === 'live')
  const routes = savedRoutes.view?.routes ?? []
  const repair = repairId && routes.find(item => item.id === repairId)
  const canEditRoutes = savedRoutes.status === 'live' && routeWrite.status !== 'pending'
  const favoriteActions: SavedPlaceActions = {
    onConnectFavorites: actions.onConnectFavorites, onSavePlace: actions.onSavePlace,
    onRenameSavedPlace: actions.onRenameSavedPlace, onRemoveSavedPlace: actions.onRemoveSavedPlace,
  }

  useEffect(() => {
    if (!chatVersion || seenChatVersion.current === chatVersion) return
    seenChatVersion.current = chatVersion
    // 收到对话结果时保留表单、正在编辑的草稿和手动查询的视图。
    if (route.status !== 'loading' && !picker && !repairId && !showSave && !expanded) setResultSource('chat')
  }, [chatVersion, route.status, picker, repairId, showSave, expanded])

  useEffect(() => {
    if (!missingEndpoint) return
    setEndpoints(current => ({
      origin: missingOrigin ? undefined : current.origin,
      destination: missingDestination ? undefined : current.destination,
    }))
    if (missingWaypoint) setWaypoints(current => current.map(point => ({ ...point, selection: currentSelection(point.selection, places) })))
    setEndpointNotice('已选收藏已被取消，请重新选择地点。')
    setShowSave(false)
    queries.reset('route')
  }, [missingEndpoint, missingOrigin, missingDestination, missingWaypoint, places, queries])

  useEffect(() => {
    if (!tab.visible) {
      setPicker(null)
      queries.reset('search')
      queries.cancelRoute()
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
    queries.reset('cached')
    queries.reset('cacheStats')
  }

  function select(selection: Selection) {
    if (picker === null || picker === 'add-favorite') return
    if (typeof picker === 'number') {
      setWaypoints(current => current.map(point => point.id === picker ? { ...point, selection } : point))
    } else {
      setEndpoints(current => ({ ...current, [picker]: selection }))
    }
    setEndpointNotice('')
    setShowSave(false)
    queries.reset('route')
    closePicker()
  }

  function editWaypoints(update: (current: Waypoint[]) => Waypoint[]) {
    setWaypoints(update)
    setEndpointNotice('')
    setShowSave(false)
    queries.reset('route')
  }

  function addWaypoint() {
    if (waypoints.length >= maxMultiStopPlaces - 2) return
    const id = ++nextWaypointId.current
    editWaypoints(current => [...current, { id }])
    setPicker(id)
  }

  function moveWaypoint(index: number, direction: -1 | 1) {
    editWaypoints(current => {
      const next = current.slice()
      const target = index + direction
      if (target < 0 || target >= next.length) return current
      const point = next[index]
      next[index] = next[target]
      next[target] = point
      return next
    })
  }

  function plan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!repairId && canPlan && origin && destination && mode) {
      setResultSource('manual')
      setShowSave(false)
      if (waypoints.length) {
        const references = stops.map(stop => stop.reference)
        void queries.planMultiStop(order === 'optimized' ? { stops: references, mode, order, pinStart: true, pinEnd: true }
          : { stops: references, mode })
      } else void queries.plan({ origin: origin.reference, destination: destination.reference, mode })
    }
  }

  function clearRoute() {
    queries.reset('route')
    actions.onDismissChatRoute(sessionId)
    setResultSource('manual')
    setShowSave(false)
  }

  function openRoute(savedRoute: SavedRouteOption, needsRepair: boolean) {
    const origin = savedRouteSelection(savedRoute.origin, favorites)
    const destination = savedRouteSelection(savedRoute.destination, favorites)
    setEndpoints({ origin, destination })
    setWaypoints([])
    setOrder('given')
    setMode(savedRoute.mode)
    setShowSave(false)
    setResultSource('manual')
    setExpanded(null)
    if (needsRepair || !origin || !destination) {
      queries.reset('route')
      setRepairId(savedRoute.id)
      setEndpointNotice('请选择缺失的端点，再更新这条路线。')
      return
    }
    setRepairId(null)
    setEndpointNotice('')
    void queries.plan({ origin: origin.reference, destination: destination.reference, mode: savedRoute.mode })
  }

  async function updateRoute() {
    const start = routeEndpoint(origin)
    const end = routeEndpoint(destination)
    if (!repair || !canPlan || !canEditRoutes || !start || !end) return
    if (await actions.onUpdateSavedRouteEndpoints({ id: repair.id, endpoints: { origin: start, destination: end } })) {
      setRepairId(current => current === repair.id ? null : current)
      setExpanded('routes')
    }
  }

  return <section className="trip-planner-panel" aria-label="出行规划面板">
    <div className="trip-planner-content">
      <header className="trip-planner-heading">
        <p>高德地图</p>
        <h1>出行规划</h1>
      </header>
      {activeChat && <div className="trip-planner-route-source">
        {showChat ? <>
          <strong><TripGlyph name="routes" />来自对话</strong>
          <button type="button" onClick={() => setResultSource('manual')}>返回手动规划</button>
        </> : <button type="button" onClick={() => setResultSource('chat')}>查看对话路线</button>}
      </div>}
      {showChat && activeChat ? <ChatRouteStops result={activeChat} /> : <section className="trip-planner-controls" aria-label="路线设置">
        <div className="trip-planner-endpoints" role="group" aria-label="起点、途经点和终点">
          <StopButton endpoint="origin" label="起点" selection={origin} onClick={() => setPicker('origin')} />
          {waypoints.map(({ id }, index) => <div className="trip-planner-waypoint" key={id}>
            <StopButton endpoint="waypoint" index={index + 1} label={'途经点 ' + (index + 1)} selection={via[index]} onClick={() => setPicker(id)} />
            <div className="trip-planner-waypoint-actions">
              <button type="button" aria-label={'上移途经点 ' + (index + 1)} title="上移" disabled={index === 0} onClick={() => moveWaypoint(index, -1)}>↑</button>
              <button type="button" aria-label={'下移途经点 ' + (index + 1)} title="下移" disabled={index === waypoints.length - 1} onClick={() => moveWaypoint(index, 1)}>↓</button>
              <button type="button" aria-label={'删除途经点 ' + (index + 1)} title="删除" onClick={() => editWaypoints(current => current.filter(point => point.id !== id))}>×</button>
            </div>
          </div>)}
          {!repairId && waypoints.length < maxMultiStopPlaces - 2 &&
            <button type="button" className="trip-planner-add-waypoint" aria-haspopup="dialog" onClick={addWaypoint}>＋ 添加途经点</button>}
          <StopButton endpoint="destination" label="终点" selection={destination} onClick={() => setPicker('destination')} />
        </div>
        <form className="trip-planner-route-form" onSubmit={plan}>
          <fieldset disabled={!!repairId} className="trip-planner-mode-picker">
            <legend>交通方式</legend>
            <div className="trip-planner-mode-choices">
              {(Object.keys(modes) as RouteMode[]).map(value => <label key={value}>
                  <input type="radio" name={shortcutsId + '-mode'} value={value} checked={mode === value} onChange={() => {
                    setMode(value)
                    setShowSave(false)
                    queries.reset('route')
                  }} />
                  <span className="trip-planner-mode" data-mode={value}><TripGlyph name={value} />{modes[value]}</span>
                </label>)}
            </div>
          </fieldset>
          {!!waypoints.length && <label className="trip-planner-route-order">
            <span>地点顺序</span>
            <select value={order} onChange={event => {
              setOrder(event.currentTarget.value === 'optimized' ? 'optimized' : 'given')
              queries.reset('route')
            }}>
              <option value="given">按当前顺序</option>
              <option value="optimized">自动顺路</option>
            </select>
          </label>}
          {!repairId && <button className="trip-planner-plan-button" type="submit" disabled={!canPlan || route.status === 'loading'}>
            {route.status === 'loading' ? '规划中…' : '规划路线'}
          </button>}
        </form>
        {repairId && <div className="trip-planner-edit-actions">
          {repair ? <button type="button" disabled={!canPlan || !canEditRoutes} onClick={() => void updateRoute()}>更新这条路线</button>
            : <p role="status">待修复的路线已删除。</p>}
          <button type="button" disabled={routeWrite.status === 'pending'} onClick={() => {
            setRepairId(null)
            setEndpointNotice('')
          }}>退出修复</button>
        </div>}
        {endpointNotice && <p role="status">{endpointNotice}</p>}
        {route.status === 'idle' && !endpointNotice && <p className="trip-planner-muted">
          {waypoints.length ? '选好全部地点和交通方式后查询。' : '选好起终点和交通方式后查询。'}
        </p>}
        {!missingEndpoint && (route.status === 'loading' || route.status === 'error') && <div className="trip-planner-query-feedback">
          {route.status === 'loading' && <p role="status">正在查询路线…</p>}
          {route.status === 'error' && <p role="alert" className="trip-planner-error">{route.message}</p>}
          <button type="button" onClick={clearRoute}>清空规划</button>
        </div>}
      </section>}
      {expanded !== 'routes' && <RouteWriteFeedback routeWrite={routeWrite} />}
      {conversation && activeChat && <div hidden={!showChat}>
        <ChatRouteResults key={'chat-' + chatVersion} view={conversation} active={activeChat.mode}
          onSelect={mode => setChatSelection({ groupId: chatVersion, mode })} onClear={clearRoute} />
      </div>}
      {!missingEndpoint && route.status === 'success' && <div hidden={showChat}>
        {'stops' in route.value ? <MultiStopRouteResults result={route.value} onClear={clearRoute} />
          : <RouteResults key={route.value.fetchedAt} result={route.value} onClear={clearRoute}>
          {route.value.status === 'found' && <div className="trip-planner-card trip-planner-save-route">
            {showSave ? <RouteNameForm title="保存为常用路线" canSubmit={canPlan && canEditRoutes}
              pending={routeWrite.status === 'pending'} onSave={name => {
                const start = routeEndpoint(origin)
                const end = routeEndpoint(destination)
                return start && end && mode ? actions.onSaveSavedRoute({ name, origin: start, destination: end, mode }) : Promise.resolve(false)
              }} onClose={() => setShowSave(false)} />
              : <button type="button" disabled={!canPlan || !canEditRoutes} onClick={() => setShowSave(true)}>保存为常用路线</button>}
          </div>}
        </RouteResults>}
      </div>}
    </div>
    <footer className="trip-planner-dock">
      <div className="trip-planner-dock-buttons" role="group" aria-label="出行快捷入口">
        <button className="trip-planner-dock-toggle" data-shortcut="favorites" type="button"
          aria-expanded={expanded === 'favorites'} aria-controls={shortcutsId + '-favorites'}
          onClick={() => setExpanded(current => current === 'favorites' ? null : 'favorites')}>
          <TripGlyph name="favorites" /><strong>地点收藏</strong><small>{favorites.view ? places.length : '…'}</small>
        </button>
        <button className="trip-planner-dock-toggle" data-shortcut="routes" type="button"
          aria-expanded={expanded === 'routes'} aria-controls={shortcutsId + '-routes'}
          onClick={() => setExpanded(current => current === 'routes' ? null : 'routes')}>
          <TripGlyph name="routes" /><strong>常用路线</strong><small>{savedRoutes.view ? routes.length : '…'}</small>
        </button>
      </div>
      <section id={shortcutsId + '-favorites'} className="trip-planner-card trip-planner-dock-content"
        aria-label="地点收藏" hidden={expanded !== 'favorites'}>
        {expanded === 'favorites' && <>
          <button type="button" aria-haspopup="dialog" onClick={() => setPicker('add-favorite')}>添加地点</button>
          <SavedPlacesList favorites={favorites} write={write} {...favoriteActions} />
        </>}
      </section>
      <section id={shortcutsId + '-routes'} className="trip-planner-card trip-planner-dock-content"
        aria-label="常用路线" hidden={expanded !== 'routes'}>
        {expanded === 'routes' && <>
          <SavedRoutesList favorites={favorites} savedRoutes={savedRoutes} routeWrite={routeWrite}
            onOpenRoute={openRoute} onConnectSavedRoutes={actions.onConnectSavedRoutes}
            onRenameSavedRoute={actions.onRenameSavedRoute} onRemoveSavedRoute={actions.onRemoveSavedRoute} />
          <RouteWriteFeedback routeWrite={routeWrite} />
        </>}
      </section>
    </footer>
    {picker !== null && tab.visible && <PlacePicker key={picker}
      title={typeof picker === 'number' ? '选择途经点 ' + (waypoints.findIndex(point => point.id === picker) + 1)
        : picker === 'add-favorite' ? '添加地点收藏' : '选择' + endpointLabels[picker]}
      purpose={typeof picker === 'number' ? 'waypoint' : picker}
      search={search} cached={cached} cacheStats={cacheStats} favorites={favorites} write={write} queries={queries}
      onClose={closePicker} onSelect={picker === 'add-favorite' ? undefined : select} {...favoriteActions} />}
  </section>
}

function RouteWriteFeedback({ routeWrite }: Pick<TripClientState, 'routeWrite'>) {
  if (routeWrite.status === 'error') return <p role="alert" className="trip-planner-error">{routeWrite.message}</p>
  if (routeWrite.status === 'success') return <p role="status">{routeWrite.message}</p>
  return null
}
