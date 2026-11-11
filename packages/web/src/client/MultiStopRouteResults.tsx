/** 多地点路线默认显示总计和各段摘要，用户可分别打开各段详情。 */
import { useId, useState } from 'react'
import type { PlanMultiStopRouteResult } from '../types.ts'
import { distance, LineSequence, RouteSteps } from './RouteResults.tsx'
import { formatDuration, routeAlternatives } from './route-view.ts'

export function MultiStopRouteResults({ result, onClear }: { result: PlanMultiStopRouteResult; onClear: () => void }) {
  const id = useId()
  const [collapsed, setCollapsed] = useState(false)
  const names = result.stops.map(stop => stop.alias ?? stop.name)
  return <section className="trip-planner-routes" aria-label="多地点路线结果">
    <div className="trip-planner-results-bar">
      <button type="button" aria-expanded={!collapsed} aria-controls={id} onClick={() => setCollapsed(!collapsed)}>
        <strong>多地点路线 · {result.legs.length} 段</strong><span>{collapsed ? '展开' : '收起'}</span>
      </button>
      <button type="button" onClick={onClear}>清空规划</button>
    </div>
    <div id={id} hidden={collapsed}>
      <p className="trip-planner-route-title">{names.join(' → ')}</p>
      {result.order === 'optimized' && <p className="trip-planner-muted">按直线距离排序</p>}
      {result.status === 'complete' ? <p className="trip-planner-muted">
        {result.totalDurationSeconds === null ? '全程耗时未知' : '全程预计 ' + formatDuration(result.totalDurationSeconds)}
        {' · '}{result.totalDistanceMeters === null ? '全程距离未知' : distance(result.totalDistanceMeters)}
      </p> : <p role="status">路线未完成 · 已查到 {result.legs.filter(leg => leg.status === 'found').length} 段</p>}
      {result.legs.map(leg => {
        const label = names[leg.from] + ' → ' + names[leg.to]
        if (!leg.route) return <div className="trip-planner-leg-status" key={leg.from}>
          <strong>{label}</strong>
          <small>{leg.message ?? (leg.status === 'no-route' ? '高德未返回路线' : '未查询')}</small>
        </div>
        const [route] = routeAlternatives({ mode: result.mode, routes: [leg.route] })
        return <details className="trip-planner-alternative" key={leg.from}>
          <summary className="trip-planner-alternative-summary">
            <span className="trip-planner-alternative-heading">
              <strong>{label}</strong>
              <strong className="trip-planner-duration">{formatDuration(route.durationSeconds)}</strong>
              <span className="trip-planner-chevron" aria-hidden="true" />
            </span>
            <LineSequence summary={route.summary} />
          </summary>
          <div className="trip-planner-alternative-body">
            {route.distanceMeters !== null && <p className="trip-planner-muted">本段 {distance(route.distanceMeters)}</p>}
            <RouteSteps steps={route.steps} />
            {!!leg.warnings.length && <details className="trip-planner-raw-walk">
              <summary>路线数据说明</summary>
              <ul>{leg.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
            </details>}
          </div>
        </details>
      })}
    </div>
  </section>
}
