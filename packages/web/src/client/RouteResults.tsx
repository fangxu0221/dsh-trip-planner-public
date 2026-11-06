/** 路线展示：保留上游的缺失值，公交同一分段的线路以可选项显示。 */
import type { PlanRouteResult, RouteSegment } from '../types.ts'
import { transitCue } from '../../../../src/presentation/transit.ts'

const segmentLabels = { walking: '步行', bicycling: '骑行', driving: '驾车',
  'public-transport': '公交 / 地铁', railway: '铁路', unknown: '行程' } satisfies Record<RouteSegment['kind'], string>

function distance(meters: number | null): string {
  if (meters === null) return '距离未知'
  return meters < 1000 ? `${meters} 米` : `${Number((meters / 1000).toFixed(2))} 公里`
}

function duration(seconds: number | null): string {
  return seconds === null ? '耗时未知' : `预计 ${Math.ceil(seconds / 60)} 分钟`
}

export function RouteResults({ result }: { result: PlanRouteResult }) {
  return <div className="trip-planner-routes">
    <p className="trip-planner-route-title">{result.origin.name} → {result.destination.name}</p>
    {result.status === 'no-route' && <p role="status">高德地图未返回可用路线。</p>}
    {result.routes.map(route => <article className="trip-planner-alternative" key={route.index}>
      <h3>方案 {route.index}</h3>
      <p>{distance(route.distanceMeters)} · {duration(route.durationSeconds)}</p>
      {route.segments.length === 0 ? <p className="trip-planner-muted">来源未提供分段指引。</p> :
        <ol>{route.segments.map((segment, index) => <li key={index}>
          <strong>{segmentLabels[segment.kind]}</strong>
          {segment.instruction && <p>{segment.instruction}</p>}
          {!!segment.walkingSteps?.length && <details className="trip-planner-raw-walk">
            <summary>查看原始步行步骤</summary>
            <ol>{segment.walkingSteps.map((step, stepIndex) => <li key={stepIndex}>
              {step.instruction ?? distance(step.distanceMeters)}
            </li>)}</ol>
          </details>}
          {segment.transportOptions.length > 1 && <p className="trip-planner-muted">本段可选线路，任选其一。</p>}
          {segment.transportOptions.length > 0 && <ul aria-label="本段可选线路">
            {segment.transportOptions.map((option, optionIndex) => {
              const cue = transitCue(segment, option)
              return <li key={optionIndex} className="trip-planner-ride">
                <span>{cue.boarding}乘坐 <strong>{cue.line}</strong></span>
                {cue.direction && <strong className="trip-planner-route-mark">{cue.direction}</strong>}
                {cue.arrival && <span>{cue.stops}到 <strong className="trip-planner-route-mark">{cue.arrival}</strong> 下车</span>}
                {cue.exit && <span>从 <strong className="trip-planner-route-mark">{cue.exit}</strong> 出站</span>}
              </li>
            })}
          </ul>}
          {(segment.distanceMeters !== null || segment.durationSeconds !== null) &&
            <small>{distance(segment.distanceMeters)} · {duration(segment.durationSeconds)}</small>}
        </li>)}</ol>}
    </article>)}
    {result.warnings.map((warning, index) => <p className="trip-planner-muted" key={index}>{warning}</p>)}
  </div>
}
