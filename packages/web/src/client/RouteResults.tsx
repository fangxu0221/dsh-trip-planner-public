/** 先显示方案摘要，再按需展示乘车分段和步行指引。 */
import { Fragment, useId, useState, type ReactNode } from 'react'
import type { PlanRouteResult, RouteSegment } from '../types.ts'
import { transitCue } from '../../../../src/presentation/transit.ts'
import { TripGlyph } from './TripGlyph.tsx'
import { formatDuration, formatTransfers, modeLabels, routeAlternatives, transitMode, type DisplayMode, type DisplayStep, type SummaryLeg } from './route-view.ts'

export function distance(meters: number): string {
  return meters < 1000 ? `${meters} 米` : `${Number((meters / 1000).toFixed(2))} 公里`
}

function metrics({ distanceMeters, durationSeconds }: Pick<RouteSegment, 'distanceMeters' | 'durationSeconds'>): string {
  return [distanceMeters === null ? '' : distance(distanceMeters),
    durationSeconds === null ? '' : formatDuration(durationSeconds)].filter(Boolean).join(' · ')
}

function ModeBadge({ mode }: { mode: DisplayMode }) {
  return <span className="trip-planner-mode" data-mode={mode}><TripGlyph name={mode} />{modeLabels[mode]}</span>
}

function WalkingDetails({ segment }: { segment: RouteSegment }) {
  const summary = metrics(segment)
  const label = <><ModeBadge mode="walking" />{summary && <small>{summary}</small>}</>
  if (!segment.instruction && !segment.walkingSteps?.length) return <div className="trip-planner-step-heading">{label}</div>
  return <details className="trip-planner-walking">
    <summary className="trip-planner-step-heading">{label}<span className="trip-planner-chevron" aria-hidden="true" /></summary>
    <div className="trip-planner-walking-body">
      {segment.instruction && <p>{segment.instruction}</p>}
      {!!segment.walkingSteps?.length && <details className="trip-planner-raw-walk">
        <summary>查看原始步行步骤</summary>
        <ol>{segment.walkingSteps.map((step, stepIndex) => <li key={stepIndex}>
          {step.instruction ?? (step.distanceMeters === null ? '指引未提供' : distance(step.distanceMeters))}
        </li>)}</ol>
      </details>}
    </div>
  </details>
}

function StepDetails({ segment, mode, transferAt }: DisplayStep) {
  if (mode === 'walking') return <WalkingDetails segment={segment} />
  const summary = metrics(segment)
  return <>
    <div className="trip-planner-step-heading">
      {!segment.transportOptions.length && <ModeBadge mode={mode} />}
      {transferAt && <strong className="trip-planner-route-mark">{transferAt} · 站内换乘</strong>}
      {!segment.transportOptions.length && summary && <small>{summary}</small>}
    </div>
    {segment.instruction && <p>{segment.instruction}</p>}
    {segment.transportOptions.length > 1 && <p className="trip-planner-muted">本段可选线路，任选其一。</p>}
    {segment.transportOptions.length > 0 && <ul aria-label="本段可选线路">
      {segment.transportOptions.map((option, index) => {
        const cue = transitCue(segment, option)
        const rideMode = mode === 'railway' ? mode : transitMode(option)
        const rideTime = option.durationSeconds === null ? undefined : '约 ' + formatDuration(option.durationSeconds)
        return <li key={index} className="trip-planner-ride" data-ride-mode={rideMode}>
          <div className="trip-planner-ride-header">
            <ModeBadge mode={rideMode} /><strong>{cue.line}</strong>
            {cue.direction && <strong className="trip-planner-route-mark">{cue.direction}</strong>}
          </div>
          <div className="trip-planner-station-path">
            <div className="trip-planner-station">
              <small><TripGlyph name="origin" />上车站</small>
              <strong>{cue.departure ?? '站名未提供'}</strong>
              {cue.entrance && <small><strong>{cue.entrance}</strong> 进站</small>}
            </div>
            <div className="trip-planner-ride-connection">
              <span className="trip-planner-ride-arrow" aria-hidden="true" />
              {cue.stopCount !== undefined && <small>{cue.stopCount} 站</small>}
              {rideTime && <small>{rideTime}</small>}
            </div>
            <div className="trip-planner-station">
              <small><TripGlyph name="destination" />下车站</small>
              <strong>{cue.arrival ?? '站名未提供'}</strong>
              {cue.exit && <small><strong>{cue.exit}</strong> 出站</small>}
            </div>
          </div>
        </li>
      })}
    </ul>}
  </>
}

/** 两点方案和多地点分段使用同样的线路与步骤展示。 */
export function LineSequence({ summary }: { summary: SummaryLeg[] }) {
  return <span className="trip-planner-line-sequence" aria-label="乘坐线路">
    {summary.map((leg, index) => <Fragment key={index}>
      {index > 0 && <span className="trip-planner-line-arrow" aria-hidden="true">→</span>}
      <span className="trip-planner-line-leg" role="group" aria-label={leg.options.length > 1 ? '本段任选其一' : undefined}>
        {leg.options.map((line, optionIndex) => <Fragment key={optionIndex}>
          {optionIndex > 0 && <span className="trip-planner-line-or" aria-hidden="true">/</span>}
          <span className="trip-planner-line-name" data-mode={line.mode}
            aria-label={line.label === modeLabels[line.mode] ? line.label : modeLabels[line.mode] + ' ' + line.label}>
            <TripGlyph name={line.mode} />{line.label}
          </span>
        </Fragment>)}
      </span>
    </Fragment>)}
  </span>
}

export function RouteSteps({ steps }: { steps: DisplayStep[] }) {
  return steps.length === 0 ? <p className="trip-planner-muted">来源未提供分段指引。</p>
    : <ol className="trip-planner-steps">{steps.map((step, index) => <li key={index}><StepDetails {...step} /></li>)}</ol>
}

export function RouteResults({ result, onClear, children }: {
  result: PlanRouteResult; onClear: () => void; children?: ReactNode
}) {
  const group = useId()
  const [collapsed, setCollapsed] = useState(false)
  const [removed, setRemoved] = useState<number[]>([])
  const routes = routeAlternatives(result).filter(route => !removed.includes(route.index))
  return <div className="trip-planner-routes">
    <div className="trip-planner-results-bar">
      <button type="button" aria-expanded={!collapsed} aria-controls={group + '-results'} onClick={() => setCollapsed(!collapsed)}>
        <strong>路线结果 · {routes.length} 个方案</strong><span>{collapsed ? '展开' : '收起'}</span>
      </button>
      <button type="button" onClick={onClear}>清空规划</button>
    </div>
    <div id={group + '-results'} hidden={collapsed}>
      <p className="trip-planner-route-title">{result.origin.name} → {result.destination.name}</p>
      {result.status === 'no-route' && <p role="status">高德地图未返回可用路线。</p>}
      {removed.length > 0 && <div className="trip-planner-removed">
        <span role="status">已移除 {removed.length} 个方案</span>
        <button type="button" onClick={() => setRemoved(current => current.slice(0, -1))}>撤销移除</button>
      </div>}
      {routes.map(route => <details className="trip-planner-alternative" name={group} key={route.index}>
        <summary className="trip-planner-alternative-summary">
          <span className="trip-planner-alternative-heading">
            <strong>方案 {route.index}</strong>
            <strong className="trip-planner-duration">{route.durationSeconds === null ? '' : '预计 '}{formatDuration(route.durationSeconds)}</strong>
            <span className="trip-planner-chevron" aria-hidden="true" />
          </span>
          <LineSequence summary={route.summary} />
          {(result.mode === 'transit' || route.fastest) && <span className="trip-planner-summary-meta">
            {result.mode === 'transit' && <small className="trip-planner-transfer-count">{formatTransfers(route.transfers)}</small>}
            {route.fastest && <small className="trip-planner-fastest">用时最短</small>}
          </span>}
        </summary>
        <div className="trip-planner-alternative-body">
          <button type="button" className="trip-planner-remove-option" aria-label={'移除方案 ' + route.index}
            onClick={() => setRemoved(current => [...current, route.index])}>移除此方案</button>
          {route.distanceMeters !== null && <p className="trip-planner-muted">全程 {distance(route.distanceMeters)}</p>}
          <RouteSteps steps={route.steps} />
        </div>
      </details>)}
      {!!result.warnings.length && <details className="trip-planner-raw-walk">
        <summary>路线数据说明</summary>
        <ul>{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
      </details>}
      {children}
    </div>
  </div>
}
