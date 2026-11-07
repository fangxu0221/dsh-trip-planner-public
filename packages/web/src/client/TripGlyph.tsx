/** 出行面板的线性小图标，和可读文字搭配。 */
import type { DisplayMode } from './route-view.ts'

const shapes = {
  walking: 'M13 5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM6 12l3-4 3-1 2 4 4 1M9 21l2-6 1-8m-1 8 5 6',
  bicycling: 'M9 17a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0Zm13 0a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0ZM5.5 17l5-9 4 9h-9m13 0-4-11h3M8 8h4',
  driving: 'M4 16v-4l2-5h12l2 5v4H4Zm0-4h16M5 16v3m14-3v3M7 14h1m8 0h1',
  metro: 'M8 3h8a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Zm-3 8h14M8 18l-2 3m10-3 2 3M8 15h1m6 0h1',
  bus: 'M5 16H3V7a2 2 0 0 1 2-2h12l4 4v7h-2m-4 0H9M3 11h18m-8-6v6m-5-6v6M9 16a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm10 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z',
  railway: 'M8 3h8a3 3 0 0 1 3 3v9l-3 3H8l-3-3V6a3 3 0 0 1 3-3Zm-3 8h14M8 18l-2 3m10-3 2 3M9 20h6M8 15h1m6 0h1',
  transit: 'M5 17V6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v11H5Zm0-6h14M7 17l-1 3m11-3 1 3M8 14h1m6 0h1',
  mixed: 'M5 7h14m-4-4 4 4-4 4m4 6H5m4-4-4 4 4 4',
  unknown: 'M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0Zm-5-3-2 4-4 2 2-4 4-2Z',
  favorites: 'M7 4h10a1 1 0 0 1 1 1v15l-6-4-6 4V5a1 1 0 0 1 1-1Z',
  origin: 'M19 12a7 7 0 1 1-14 0 7 7 0 0 1 14 0Zm-5 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z',
  destination: 'M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 0 1 14 0Zm-5 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z',
  search: 'M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0Zm-1.5 4.5L20 20',
  close: 'M6 6l12 12M18 6 6 18',
  routes: 'M7 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm14-12a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM7 18h10a3 3 0 0 0 0-6H7a3 3 0 0 1 0-6h10',
} satisfies Record<DisplayMode | 'favorites' | 'routes' | 'origin' | 'destination' | 'search' | 'close', string>

export function TripGlyph({ name }: { name: keyof typeof shapes }) {
  return <svg aria-hidden="true" className="trip-planner-glyph" width="16" height="16" viewBox="0 0 24 24"
    fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
    <path d={shapes[name]} />
  </svg>
}
