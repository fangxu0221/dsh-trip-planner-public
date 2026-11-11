/** 对话路线按方式切换；新方式到达不抢走当前视图，各方式保留独立折叠状态。 */
import { useId, type ReactNode } from 'react'
import type { ChatRouteView, RouteMode, RouteResult } from '../types.ts'
import { modes } from './SavedRoutesList.tsx'
import { formatDuration } from './route-view.ts'
import { TripGlyph } from './TripGlyph.tsx'
import { RouteResults } from './RouteResults.tsx'
import { MultiStopRouteResults } from './MultiStopRouteResults.tsx'

function timeLabel(result: RouteResult): string {
  if ('stops' in result) return result.status === 'incomplete' ? '路线未完成' : formatDuration(result.totalDurationSeconds)
  if (result.status === 'no-route') return '暂无路线'
  const known = result.routes.map(route => route.durationSeconds).filter((value): value is number => value !== null)
  return known.length && known.length === result.routes.length ? formatDuration(Math.min(...known)) : '耗时未知'
}

export function ChatRouteResults({ view, active, onSelect, onClear, children }: {
  view: ChatRouteView; active: RouteMode; onSelect: (mode: RouteMode) => void; onClear: () => void; children?: ReactNode
}) {
  const id = useId()
  return <section aria-label="对话路线结果" className="trip-planner-chat-results" data-route-group={view.groupId}>
    <div role="tablist" aria-label="对话路线交通方式" className="trip-planner-chat-modes">
      {view.results.map(({ result }) => {
        return <button key={result.mode} type="button" role="tab" data-mode={result.mode}
          id={id + '-tab-' + result.mode} aria-controls={id + '-panel-' + result.mode}
          aria-selected={active === result.mode} tabIndex={active === result.mode ? 0 : -1}
          onClick={() => onSelect(result.mode)} onKeyDown={event => {
            const index = view.results.findIndex(item => item.result.mode === result.mode)
            const target = event.key === 'ArrowRight' ? (index + 1) % view.results.length
              : event.key === 'ArrowLeft' ? (index + view.results.length - 1) % view.results.length
              : event.key === 'Home' ? 0 : event.key === 'End' ? view.results.length - 1 : undefined
            if (target === undefined) return
            event.preventDefault()
            const mode = view.results[target]!.result.mode
            onSelect(mode)
            event.currentTarget.parentElement?.querySelector<HTMLButtonElement>('[data-mode="' + mode + '"]')?.focus()
          }}>
          <TripGlyph name={result.mode} /><span>{modes[result.mode]}</span><small>{timeLabel(result)}</small>
        </button>
      })}
    </div>
    {view.results.map(item => <div key={item.result.mode} role="tabpanel"
      id={id + '-panel-' + item.result.mode} aria-labelledby={id + '-tab-' + item.result.mode}
      hidden={active !== item.result.mode} tabIndex={0}>
      {'stops' in item.result ? <MultiStopRouteResults key={item.revision} result={item.result} onClear={onClear}>
        {active === item.result.mode && children}
      </MultiStopRouteResults>
        : <RouteResults key={item.revision} result={item.result} onClear={onClear} />}
    </div>)}
  </section>
}
