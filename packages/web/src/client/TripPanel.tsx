/** 会话右栏主体，端点和路线随当前标签页保留。 */
import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent } from 'react'
import type { HostObservable, InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {
  RenameSavedRouteRequest, RouteMode, SavedPlaceOption, SavedRouteEndpoint, SavedRouteOption,
  SaveRouteRequest, UpdateSavedRouteEndpointsRequest,
} from '../types.ts'
import { type TripClientState, type TripQueries } from './model.ts'
import { ChatRouteResults } from './ChatRouteResults.tsx'
import { PlacePicker, savedSelection, type Selection } from './PlacePicker.tsx'
import { RouteResults } from './RouteResults.tsx'
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

const endpointLabels = { origin: '起点', destination: '终点' } as const

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
  const { search, route } = useSyncExternalStore(queries.state.subscribe, queries.state.getSnapshot)
  const [picker, setPicker] = useState<Endpoint | 'add-favorite' | null>(null)
  const [expanded, setExpanded] = useState<'favorites' | 'routes' | null>(null)
  const [repairId, setRepairId] = useState<string | null>(null)
  const [showSave, setShowSave] = useState(false)
  const [endpoints, setEndpoints] = useState<Partial<Record<Endpoint, Selection>>>({})
  const [mode, setMode] = useState<RouteMode | ''>('')
  const [endpointNotice, setEndpointNotice] = useState('')
  const [resultSource, setResultSource] = useState<'manual' | 'chat'>('manual')
  const seenChatVersion = useRef('')
  const conversation = chatRoute && chatRoute.sessionId === sessionId ? chatRoute.view : undefined
  const hasChat = !!conversation?.results.length
  const chatVersion = hasChat ? conversation.groupId : ''
  const showChat = hasChat && resultSource === 'chat'
  const places = favorites.view?.places ?? []
  const origin = currentSelection(endpoints.origin, places)
  const destination = currentSelection(endpoints.destination, places)
  const selections = { origin, destination }
  const missingOrigin = !!endpoints.origin && !origin
  const missingDestination = !!endpoints.destination && !destination
  const missingEndpoint = missingOrigin || missingDestination
  const usesSaved = origin?.reference.kind === 'saved' || destination?.reference.kind === 'saved'
  const canPlan = !!origin && !!destination && !!mode && (!usesSaved || favorites.status === 'live')
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
    setEndpointNotice('已选收藏已被取消，请重新选择地点。')
    setShowSave(false)
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
    if (!picker || picker === 'add-favorite') return
    setEndpoints(current => ({ ...current, [picker]: selection }))
    setEndpointNotice('')
    setShowSave(false)
    queries.reset('route')
    closePicker()
  }

  function plan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!repairId && canPlan && origin && destination && mode) {
      setResultSource('manual')
      setShowSave(false)
      void queries.plan({ origin: origin.reference, destination: destination.reference, mode })
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
      <section className="trip-planner-controls" aria-label="路线设置">
        <div className="trip-planner-endpoints" role="group" aria-label="起点和终点">
          {(['origin', 'destination'] as const).map(endpoint => {
            const selection = selections[endpoint]
            return <button key={endpoint} type="button" data-endpoint={endpoint} aria-haspopup="dialog" onClick={() => setPicker(endpoint)}>
              <span className="trip-planner-endpoint-marker"><TripGlyph name={endpoint} /></span>
              <span className="trip-planner-endpoint-text">
                <small>{endpointLabels[endpoint]}</small>
                <strong>{selection?.name ?? '点击选择'}</strong>
                {selection?.address && <small>{selection.address}</small>}
              </span>
              <span className="trip-planner-endpoint-next" aria-hidden="true">›</span>
            </button>
          })}
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
        {route.status === 'idle' && !endpointNotice && !showChat && <p className="trip-planner-muted">选好起终点和交通方式后查询。</p>}
        {!missingEndpoint && (route.status === 'loading' || route.status === 'error') && <div className="trip-planner-query-feedback">
          {route.status === 'loading' && <p role="status">正在查询路线…</p>}
          {route.status === 'error' && <p role="alert" className="trip-planner-error">{route.message}</p>}
          {!showChat && <button type="button" onClick={clearRoute}>清空规划</button>}
        </div>}
      </section>
      {expanded !== 'routes' && <RouteWriteFeedback routeWrite={routeWrite} />}
      {hasChat && <div className="trip-planner-route-source">
        {showChat ? <strong><TripGlyph name="routes" />来自对话</strong>
          : <button type="button" onClick={() => setResultSource('chat')}>查看对话路线</button>}
        {showChat && !missingEndpoint && route.status === 'success' &&
          <button type="button" onClick={() => setResultSource('manual')}>查看手动路线</button>}
      </div>}
      {hasChat && <div hidden={!showChat}>
        <ChatRouteResults key={'chat-' + chatVersion} view={conversation} onClear={clearRoute} />
      </div>}
      {!missingEndpoint && route.status === 'success' && <div hidden={showChat}>
        <RouteResults key={route.value.fetchedAt} result={route.value} onClear={clearRoute}>
          {route.value.status === 'found' && <div className="trip-planner-card trip-planner-save-route">
            {showSave ? <RouteNameForm title="保存为常用路线" canSubmit={canPlan && canEditRoutes}
              pending={routeWrite.status === 'pending'} onSave={name => {
                const start = routeEndpoint(origin)
                const end = routeEndpoint(destination)
                return start && end && mode ? actions.onSaveSavedRoute({ name, origin: start, destination: end, mode }) : Promise.resolve(false)
              }} onClose={() => setShowSave(false)} />
              : <button type="button" disabled={!canPlan || !canEditRoutes} onClick={() => setShowSave(true)}>保存为常用路线</button>}
          </div>}
        </RouteResults>
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
    {picker && tab.visible && <PlacePicker key={picker} title={picker === 'add-favorite' ? '添加地点收藏' : '选择' + endpointLabels[picker]}
      purpose={picker}
      search={search} favorites={favorites} write={write} queries={queries}
      onClose={closePicker} onSelect={picker === 'add-favorite' ? undefined : select} {...favoriteActions} />}
  </section>
}

function RouteWriteFeedback({ routeWrite }: Pick<TripClientState, 'routeWrite'>) {
  if (routeWrite.status === 'error') return <p role="alert" className="trip-planner-error">{routeWrite.message}</p>
  if (routeWrite.status === 'success') return <p role="status">{routeWrite.message}</p>
  return null
}
