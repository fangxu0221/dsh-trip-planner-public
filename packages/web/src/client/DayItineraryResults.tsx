/** 单日行程用时间表串起游览和交通，交通详情沿用普通路线的组件。 */
import type { DayItineraryResult } from '../types.ts'
import { itineraryLeg, itineraryTime, themeLabels } from '../../../../src/presentation/itinerary.ts'
import { LineSequence, RouteSteps } from './RouteResults.tsx'
import { modes } from './SavedRoutesList.tsx'
import { TripGlyph } from './TripGlyph.tsx'
import { routeAlternatives } from './route-view.ts'

export function DayItineraryResults({ result, onClear }: { result: DayItineraryResult; onClear: () => void }) {
  return <section className="trip-planner-itinerary trip-planner-routes" aria-label="单日行程">
    <div className="trip-planner-results-bar">
      <h2>{result.city} · {themeLabels[result.theme]}</h2>
      <button type="button" onClick={onClear}>清空行程</button>
    </div>
    <p className="trip-planner-itinerary-window">
      {itineraryTime(result.startMinute)}{result.defaultStart && '（默认）'}–{itineraryTime(result.endMinute)}{result.defaultEnd && '（默认）'}
      <span className="trip-planner-mode" data-mode={result.mode}><TripGlyph name={result.mode} />{modes[result.mode]}</span>
    </p>
    {result.finishMinute !== null && <p className="trip-planner-muted">预计结束 {itineraryTime(result.finishMinute)}</p>}
    {result.overByMinutes ? <p role="status" className="trip-planner-error">超出结束时间 {result.overByMinutes} 分钟</p> : null}
    {result.message && <p role="status">{result.message}</p>}
    {result.timeline.length > 0 ? <ol className="trip-planner-timeline">
      {result.timeline.map((item, index) => {
        const leg = item.legIndex === null ? null : itineraryLeg(result.route, item.legIndex)
        const visit = result.visits.find(visit => visit.placeId === item.placeId)
        const time = itineraryTime(item.startMinute) + '–' + itineraryTime(item.endMinute)
        const label = <><small>{time}</small><strong>{item.title}</strong></>
        if (leg) {
          const [details] = routeAlternatives({ mode: result.mode, routes: [leg] })
          return <li key={index} data-kind="travel"><details>
            <summary>{label}<LineSequence summary={details.summary} /></summary>
            <RouteSteps steps={details.steps} />
          </details></li>
        }
        return <li key={index} data-kind={item.kind}>
          {label}
          {visit && <small>{visit.stayMinutes} 分钟 · {visit.reason}{visit.address && ' · ' + visit.address}</small>}
        </li>
      })}
    </ol> : result.visits.length > 0 && <ul className="trip-planner-timeline">
      {result.visits.map(visit => <li key={visit.placeId} data-kind="visit">
        <strong>{visit.name}</strong><small>{visit.reason}{visit.address && ' · ' + visit.address}</small>
      </li>)}
    </ul>}
    {result.visits.length > 0 && <p className="trip-planner-muted">营业时间、预约和门票待确认。</p>}
  </section>
}
