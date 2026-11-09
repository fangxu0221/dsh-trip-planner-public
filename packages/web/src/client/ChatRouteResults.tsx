/** 对话路线按方式切换；新方式到达不抢走当前视图，各方式保留独立折叠状态。 */
import { useId, useState } from 'react'
import type { ChatRouteView } from '../types.ts'
import { modes } from './SavedRoutesList.tsx'
import { formatDuration } from './route-view.ts'
import { TripGlyph } from './TripGlyph.tsx'
import { RouteResults } from './RouteResults.tsx'

export function ChatRouteResults({ view, onClear }: { view: ChatRouteView; onClear: () => void }) {
  const id = useId()
  const [selected, setSelected] = useState(view.results[0]?.result.mode)
  const active = view.results.find(item => item.result.mode === selected)?.result.mode ?? view.results[0]?.result.mode
  return <section aria-label="对话路线结果" className="trip-planner-chat-results" data-route-group={view.groupId}>
    <div role="tablist" aria-label="对话路线交通方式" className="trip-planner-chat-modes">
      {view.results.map(({ result }) => {
        const known = result.routes.map(route => route.durationSeconds).filter((value): value is number => value !== null)
        const time = result.status === 'no-route' ? '暂无路线'
          : known.length && known.length === result.routes.length ? formatDuration(Math.min(...known)) : '耗时未知'
        return <button key={result.mode} type="button" role="tab" data-mode={result.mode}
          id={id + '-tab-' + result.mode} aria-controls={id + '-panel-' + result.mode}
          aria-selected={active === result.mode} tabIndex={active === result.mode ? 0 : -1}
          onClick={() => setSelected(result.mode)} onKeyDown={event => {
            const index = view.results.findIndex(item => item.result.mode === result.mode)
            const target = event.key === 'ArrowRight' ? (index + 1) % view.results.length
              : event.key === 'ArrowLeft' ? (index + view.results.length - 1) % view.results.length
              : event.key === 'Home' ? 0 : event.key === 'End' ? view.results.length - 1 : undefined
            if (target === undefined) return
            event.preventDefault()
            const mode = view.results[target]!.result.mode
            setSelected(mode)
            event.currentTarget.parentElement?.querySelector<HTMLButtonElement>('[data-mode="' + mode + '"]')?.focus()
          }}>
          <TripGlyph name={result.mode} /><span>{modes[result.mode]}</span><small>{time}</small>
        </button>
      })}
    </div>
    {view.results.map(item => <div key={item.result.mode} role="tabpanel"
      id={id + '-panel-' + item.result.mode} aria-labelledby={id + '-tab-' + item.result.mode}
      hidden={active !== item.result.mode} tabIndex={0}>
      <RouteResults key={item.revision} result={item.result} onClear={onClear} />
    </div>)}
  </section>
}
