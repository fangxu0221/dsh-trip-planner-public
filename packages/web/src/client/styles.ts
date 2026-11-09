/** 面板样式限定在插件容器内，并使用 Harness 的主题变量。 */
export const styles = `
.trip-planner-panel, .trip-planner-panel * { box-sizing: border-box; }
.trip-planner-panel {
  --trip-text: var(--dsw-alias-label-primary, #1e2938);
  --trip-muted: var(--dsw-alias-label-secondary, #566579);
  --trip-border: var(--dsw-alias-border-l4, #d9e0e9);
  --trip-hover: var(--dsw-alias-interactive-bg-hover, #edf3fa);
  --trip-accent: var(--dsw-alias-link, #315dbe);
  --trip-surface: var(--dsw-alias-bg-base, Canvas);
  container-type: inline-size;
  display: flex; flex-direction: column; height: 100%; min-height: 0; overflow: hidden; color: var(--trip-text);
}
.trip-planner-content {
  flex: 1 1 0; min-height: 0; overflow: auto; overscroll-behavior: contain;
  padding: 16px clamp(12px, 3vw, 22px) 16px;
}
.trip-planner-dock {
  flex: 0 1 auto; min-height: 0; max-height: min(55%, 360px); display: flex; flex-direction: column;
  gap: 8px; padding: 8px 12px 10px; border-top: 1px solid var(--trip-border); background: var(--trip-surface);
}
.trip-planner-dock-content { order: -1; min-height: 0; overflow: auto; overscroll-behavior: contain; }
.trip-planner-dock-buttons { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; flex: none; }
.trip-planner-dock-toggle {
  display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 4px 6px;
  min-width: 0; padding: 7px 6px; border-radius: 9px; cursor: pointer; font: inherit; font-size: 13px;
  color: var(--trip-text); border: 1px solid color-mix(in srgb, var(--trip-tint) 36%, var(--trip-surface));
  background: color-mix(in srgb, var(--trip-tint) 15%, var(--trip-surface));
}
.trip-planner-dock-toggle[data-shortcut="favorites"] { --trip-tint: #c88719; }
.trip-planner-dock-toggle[data-shortcut="routes"] { --trip-tint: #7761d8; }
.trip-planner-dock-toggle .trip-planner-glyph { color: color-mix(in srgb, var(--trip-tint) 65%, var(--trip-text)); }
.trip-planner-dock-toggle:is(:hover, [aria-expanded=true]) { background: color-mix(in srgb, var(--trip-tint) 26%, var(--trip-surface)); }
.trip-planner-dock-toggle small { min-width: 1.6em; padding: 0 4px; border-radius: 20px; background: var(--trip-surface); }
.trip-planner-dock-toggle:focus-visible, .trip-planner-routes summary:focus-visible {
  outline: 2px solid var(--trip-accent); outline-offset: 2px;
}
.trip-planner-heading { margin-bottom: 12px; }
.trip-planner-heading h1 { margin: 4px 0 8px; font-size: 22px; font-weight: 700; }
.trip-planner-heading p, .trip-planner-muted { margin: 4px 0; color: var(--trip-muted); }
.trip-planner-heading p:first-child { color: var(--trip-accent); font-size: 13px; font-weight: 650; }
.trip-planner-card { min-width: 0; padding: 12px; border: 1px solid var(--trip-border); border-radius: 12px; font-size: 14px; }
.trip-planner-card h2 { font-size: 17px; font-weight: 650; margin: 0 0 14px; }
.trip-planner-card h3 { font-size: 14px; font-weight: 650; margin: 0; }
.trip-planner-card label { display: grid; gap: 5px; min-width: 0; }
.trip-planner-card input, .trip-planner-card select, .trip-planner-card button {
  font: inherit; color: inherit; border: 1px solid var(--trip-border); border-radius: 8px; padding: 8px 10px;
}
.trip-planner-card input, .trip-planner-card select { min-width: 0; width: 100%; background: var(--dsw-alias-button-elevated-fill, transparent); }
.trip-planner-card button { background: transparent; cursor: pointer; }
.trip-planner-card button:hover:not(:disabled) { background: var(--trip-hover); }
.trip-planner-card button:disabled { opacity: .55; cursor: default; }
.trip-planner-card :is(input, select, button):focus-visible { outline: 2px solid var(--trip-accent); outline-offset: 2px; }
.trip-planner-card button[type=submit] { color: var(--trip-accent); border-color: var(--trip-accent); white-space: nowrap; font-weight: 650; }
.trip-planner-controls { min-width: 0; font-size: 14px; }
.trip-planner-endpoints { position: relative; border-radius: 14px; background: var(--trip-hover); }
.trip-planner-endpoints::before {
  content: ''; position: absolute; z-index: 0; inset-block: 25% 25%; inset-inline-start: 24px;
  width: 1px; background: color-mix(in srgb, var(--trip-muted) 35%, var(--trip-hover));
}
.trip-planner-endpoints button {
  position: relative; display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; align-items: center;
  gap: 10px; width: 100%; min-width: 0; padding: 9px 11px; color: inherit; font: inherit;
  text-align: start; border: 0; border-radius: 10px; background: transparent; cursor: pointer;
}
.trip-planner-endpoints button:hover { background: color-mix(in srgb, var(--trip-accent) 7%, transparent); }
.trip-planner-endpoints button:focus-visible, .trip-planner-controls button:focus-visible, .trip-planner-route-source button:focus-visible {
  outline: 2px solid var(--trip-accent); outline-offset: 2px;
}
.trip-planner-endpoint-marker {
  display: grid; place-items: center; width: 28px; height: 28px; border-radius: 50%;
  --trip-pin: #168477;
  color: color-mix(in srgb, var(--trip-pin) 70%, var(--trip-text));
  background: color-mix(in srgb, var(--trip-pin) 15%, var(--trip-surface));
}
.trip-planner-endpoints [data-endpoint="destination"] .trip-planner-endpoint-marker { --trip-pin: #c06e2a; }
.trip-planner-endpoint-text { display: grid; gap: 2px; overflow-wrap: anywhere; }
.trip-planner-endpoint-text small, .trip-planner-endpoint-next { color: var(--trip-muted); }
.trip-planner-endpoint-next { font-size: 20px; }
.trip-planner-options li button { display: grid; gap: 3px; width: 100%; text-align: start; overflow-wrap: anywhere; }
.trip-planner-picker {
  width: min(520px, calc(100vw - 28px)); max-height: calc(100dvh - 36px); overflow: auto;
  padding: clamp(12px, 3vw, 20px); border-radius: 18px; color: var(--trip-text); background: var(--trip-surface);
  box-shadow: 0 16px 48px rgb(0 0 0 / .16);
}
.trip-planner-picker::backdrop { background: rgb(0 0 0 / .32); }
.trip-planner-picker-header { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 10px; }
.trip-planner-picker-header h2, .trip-planner-picker-header p { margin: 0; }
.trip-planner-picker-header p { color: var(--trip-muted); font-size: 12px; margin-top: 3px; }
.trip-planner-picker-icon {
  --trip-picker-tint: #168477;
  display: grid; place-items: center; width: 36px; height: 36px; border-radius: 11px;
  color: color-mix(in srgb, var(--trip-picker-tint) 68%, var(--trip-text));
  background: color-mix(in srgb, var(--trip-picker-tint) 17%, var(--trip-surface));
}
.trip-planner-picker-icon[data-purpose="destination"] { --trip-picker-tint: #c06e2a; }
.trip-planner-picker-icon[data-purpose="add-favorite"] { --trip-picker-tint: #c88719; }
.trip-planner-picker .trip-planner-picker-close { border: 0; border-radius: 50%; padding: 7px; color: var(--trip-muted); }
.trip-planner-picker-tabs {
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 3px; padding: 3px;
  margin-top: 14px; border-radius: 11px; background: var(--trip-hover);
}
.trip-planner-picker-tabs button { display: flex; align-items: center; justify-content: center; gap: 5px; min-width: 0; border: 0; }
.trip-planner-picker-tabs button[aria-pressed=true] { color: var(--trip-accent); font-weight: 650; background: var(--trip-surface); }
.trip-planner-card small { color: var(--trip-muted); }
.trip-planner-search, .trip-planner-route-form { display: grid; gap: 8px; align-items: end; margin: 12px 0; }
.trip-planner-search-primary { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; }
.trip-planner-picker label.trip-planner-keyword {
  display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; padding-inline: 9px 0;
  gap: 0; border-radius: 9px; background: var(--trip-hover); color: var(--trip-muted);
}
.trip-planner-picker .trip-planner-keyword input { border: 0; background: transparent; color: var(--trip-text); }
.trip-planner-picker .trip-planner-keyword:focus-within { outline: 2px solid var(--trip-accent); outline-offset: 1px; }
.trip-planner-picker .trip-planner-keyword input:focus-visible { outline: none; }
.trip-planner-picker .trip-planner-search button[type=submit] { border: 0; background: var(--trip-accent); color: var(--trip-surface); }
.trip-planner-city { font-size: 12px; color: var(--trip-muted); }
.trip-planner-city summary { cursor: pointer; width: fit-content; padding: 3px; }
.trip-planner-city label { margin-top: 6px; max-width: 220px; }
.trip-planner-picker-hint { display: flex; align-items: center; gap: 6px; color: var(--trip-muted); font-size: 13px; margin-block: 14px 4px; }
.trip-planner-search-results .trip-planner-option-row { flex-wrap: nowrap; border-bottom: 1px solid var(--trip-border); padding-block: 3px; }
.trip-planner-search-results .trip-planner-option-row .trip-planner-search-result {
  display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 8px; align-items: start;
  padding: 7px 5px; border: 0; text-align: start;
}
.trip-planner-search-result > .trip-planner-glyph { color: var(--trip-accent); margin-top: 2px; }
.trip-planner-search-results .trip-planner-option-row .trip-planner-search-bookmark { padding: 7px; border: 0; color: var(--trip-accent); }
.trip-planner-mode-picker { min-width: 0; margin: 0; border: 0; padding: 0; }
.trip-planner-mode-picker legend { margin-bottom: 5px; padding: 0; color: var(--trip-muted); font-size: 12px; }
.trip-planner-mode-choices { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; }
.trip-planner-mode-choices label { position: relative; min-width: 0; }
.trip-planner-mode-choices input {
  position: absolute; inset: 0; margin: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer;
}
.trip-planner-mode-choices .trip-planner-mode {
  justify-content: center; width: 100%; min-height: 34px; border-radius: 9px;
  background: transparent; border: 1px solid transparent;
}
.trip-planner-mode-choices input:hover + span { background: var(--trip-hover); }
.trip-planner-mode-choices input:checked + span {
  border-color: color-mix(in srgb, var(--trip-mode) 35%, var(--trip-surface));
  background: color-mix(in srgb, var(--trip-mode) 15%, var(--trip-surface)); font-weight: 700;
}
.trip-planner-mode-choices input:focus-visible + span { outline: 2px solid var(--trip-accent); outline-offset: 2px; }
.trip-planner-mode-choices input:disabled { cursor: default; }
.trip-planner-mode-choices input:disabled + span { opacity: .66; }
.trip-planner-plan-button {
  justify-self: stretch; min-height: 34px; padding: 7px 12px; border: 0; border-radius: 9px; cursor: pointer;
  color: var(--trip-surface); background: var(--trip-accent); font: inherit; font-weight: 650;
}
.trip-planner-plan-button:disabled { opacity: .48; cursor: default; }
.trip-planner-controls .trip-planner-edit-actions button, .trip-planner-route-source button {
  border: 0; padding: 5px 8px; border-radius: 7px; font: inherit; color: var(--trip-accent);
  background: var(--trip-hover); cursor: pointer;
}
.trip-planner-route-source { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 12px; font-size: 13px; }
.trip-planner-route-source strong {
  display: inline-flex; gap: 5px; align-items: center; padding: 4px 8px; border-radius: 7px;
  color: var(--trip-accent); background: var(--trip-hover);
}
.trip-planner-subheading { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.trip-planner-subheading button { font-size: 12px; padding: 4px 8px; }
.trip-planner-options { border-top: 1px solid var(--trip-border); margin-top: 14px; padding-top: 12px; }
.trip-planner-options ul { list-style: none; display: grid; gap: 6px; margin: 8px 0 0; padding: 0; }
.trip-planner-option-row { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.trip-planner-options .trip-planner-option-row > :first-child { flex: 1 1 12rem; min-width: 0; }
.trip-planner-options .trip-planner-option-row > :not(:first-child) { width: auto; flex: 0 0 auto; }
.trip-planner-save-route { margin-top: 8px; padding: 0; border: 0; }
.trip-planner-entry-title { display: grid; gap: 3px; overflow-wrap: anywhere; }
.trip-planner-options .trip-planner-saved-route > :first-child { flex-basis: 100%; }
.trip-planner-edit { display: grid; gap: 8px; margin-top: 12px; padding: 12px; border: 1px solid var(--trip-border); border-radius: 8px; }
.trip-planner-edit h4 { margin: 0; }
.trip-planner-edit-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.trip-planner-error { color: var(--dsw-alias-state-error-primary, #ad2828); overflow-wrap: anywhere; }
.trip-planner-route-title { font-weight: 650; overflow-wrap: anywhere; }
.trip-planner-chat-modes { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.trip-planner-chat-modes [role="tab"] {
  --trip-choice: #765ed2;
  display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap;
  border: 0; border-radius: 10px; padding: 9px 11px; font: inherit; font-size: 13px;
  color: var(--trip-text); background: var(--trip-hover); cursor: pointer;
}
.trip-planner-chat-modes [data-mode="walking"] { --trip-choice: #168477; }
.trip-planner-chat-modes [data-mode="bicycling"] { --trip-choice: #ad770d; }
.trip-planner-chat-modes [data-mode="driving"] { --trip-choice: #ba5367; }
.trip-planner-chat-modes [aria-selected="true"] { background: color-mix(in srgb, var(--trip-choice) 16%, var(--trip-surface)); box-shadow: inset 0 -2px var(--trip-choice); }
.trip-planner-chat-modes .trip-planner-glyph { color: var(--trip-choice); }
.trip-planner-chat-modes small { color: var(--trip-muted); }
.trip-planner-chat-modes [role="tab"]:focus-visible { outline: 2px solid var(--trip-choice); outline-offset: 2px; }
.trip-planner-routes { margin-top: 12px; font-size: 14px; }
.trip-planner-results-bar, .trip-planner-query-feedback, .trip-planner-removed {
  display: flex; gap: 8px; flex-wrap: wrap; align-items: center; justify-content: space-between;
}
.trip-planner-results-bar { position: sticky; top: 0; z-index: 1; padding-block: 4px; background: var(--trip-surface); }
.trip-planner-results-bar button, .trip-planner-query-feedback button, .trip-planner-removed button, .trip-planner-remove-option {
  display: inline-flex; gap: 6px; align-items: center; border: 0; border-radius: 7px; padding: 4px 7px;
  font: inherit; font-size: 12px; color: var(--trip-accent); background: var(--trip-hover); cursor: pointer;
}
.trip-planner-results-bar button:first-child { color: var(--trip-text); }
.trip-planner-results-bar button span { color: var(--trip-muted); }
.trip-planner-results-bar button:focus-visible, .trip-planner-removed button:focus-visible, .trip-planner-remove-option:focus-visible {
  outline: 2px solid var(--trip-accent); outline-offset: 2px;
}
.trip-planner-removed { margin-bottom: 8px; color: var(--trip-muted); font-size: 12px; }
.trip-planner-remove-option { margin-block: 1px 3px; }
.trip-planner-alternative { border: 1px solid transparent; border-radius: 10px; margin-bottom: 8px; }
.trip-planner-alternative-summary, .trip-planner-walking > summary { list-style: none; cursor: pointer; }
.trip-planner-alternative-summary::-webkit-details-marker, .trip-planner-walking > summary::-webkit-details-marker { display: none; }
.trip-planner-alternative-summary {
  display: grid; gap: 7px; padding: 9px 11px; border-radius: 9px;
  background: color-mix(in srgb, var(--trip-hover) 55%, var(--trip-surface));
}
.trip-planner-alternative-summary:hover, .trip-planner-alternative[open] > summary { background: var(--trip-hover); }
.trip-planner-alternative[open] > summary { border-bottom: 1px solid var(--trip-border); border-radius: 9px 9px 0 0; }
.trip-planner-alternative-heading { display: flex; align-items: center; gap: 8px; }
.trip-planner-duration { margin-inline-start: auto; text-align: end; font-variant-numeric: tabular-nums; }
.trip-planner-chevron {
  display: inline-block; width: 7px; height: 7px; margin-inline: 2px; flex: none;
  border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor; transform: translateY(-2px) rotate(45deg);
}
.trip-planner-routes details[open] > summary .trip-planner-chevron { transform: translateY(2px) rotate(225deg); }
.trip-planner-mode-sequence, .trip-planner-step-heading { display: flex; align-items: center; gap: 5px 7px; flex-wrap: wrap; }
.trip-planner-mode {
  --trip-mode: #6b7280;
  display: inline-flex; gap: 4px; align-items: center; padding: 2px 6px; border-radius: 6px;
  background: color-mix(in srgb, var(--trip-mode) 14%, var(--trip-surface));
  color: var(--trip-text); font-size: 12px;
}
.trip-planner-mode[data-mode="walking"] { --trip-mode: #168477; }
.trip-planner-mode[data-mode="metro"] { --trip-mode: #765ed2; }
.trip-planner-mode[data-mode="transit"] { --trip-mode: #765ed2; }
.trip-planner-mode[data-mode="bus"] { --trip-mode: #2574c0; }
.trip-planner-mode[data-mode="bicycling"] { --trip-mode: #ad770d; }
.trip-planner-mode[data-mode="driving"] { --trip-mode: #ba5367; }
.trip-planner-mode[data-mode="railway"] { --trip-mode: #3857a6; }
.trip-planner-glyph { display: block; flex: none; }
.trip-planner-mode .trip-planner-glyph { color: color-mix(in srgb, var(--trip-mode) 64%, var(--trip-text)); }
.trip-planner-fastest { padding: 1px 5px; border-radius: 6px; background: var(--trip-hover); color: var(--trip-accent); }
.trip-planner-transfer-count { color: var(--trip-muted); }
.trip-planner-alternative-body { padding: 8px 11px 11px; }
.trip-planner-alternative p { margin: 4px 0; overflow-wrap: anywhere; }
.trip-planner-alternative ol, .trip-planner-alternative ul { padding-inline-start: 22px; }
.trip-planner-alternative .trip-planner-steps { display: grid; gap: 8px; margin-block: 8px 0; padding-inline-start: 20px; }
.trip-planner-steps > li { min-width: 0; }
.trip-planner-steps small { color: var(--trip-muted); }
.trip-planner-walking > summary { width: fit-content; max-width: 100%; border-radius: 6px; padding: 2px 4px 2px 0; }
.trip-planner-walking > summary:hover { background: var(--trip-hover); }
.trip-planner-walking-body { padding-inline-start: 8px; border-inline-start: 1px solid var(--trip-border); margin-top: 4px; }
.trip-planner-alternative ul[aria-label="本段可选线路"] { list-style: none; padding: 0; }
.trip-planner-ride {
  --trip-ride: #6b7280;
  min-width: 0; padding: 8px; margin-top: 6px; border-radius: 8px;
  background: color-mix(in srgb, var(--trip-ride) 8%, var(--trip-surface));
}
.trip-planner-ride[data-ride-mode="metro"] { --trip-ride: #765ed2; }
.trip-planner-ride[data-ride-mode="bus"] { --trip-ride: #2574c0; }
.trip-planner-ride[data-ride-mode="railway"] { --trip-ride: #3857a6; }
.trip-planner-ride-header { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 7px; overflow-wrap: anywhere; }
.trip-planner-station-path {
  display: grid; grid-template-columns: minmax(0, 1fr) minmax(42px, .8fr) minmax(0, 1fr); gap: 6px;
  margin-top: 8px; align-items: start;
}
.trip-planner-station, .trip-planner-ride-connection { display: grid; gap: 2px; min-width: 0; overflow-wrap: anywhere; }
.trip-planner-station small { display: flex; flex-wrap: wrap; gap: 2px 4px; align-items: center; }
.trip-planner-station small .trip-planner-glyph { color: color-mix(in srgb, var(--trip-ride) 70%, var(--trip-text)); }
.trip-planner-station:last-child { justify-items: end; text-align: end; }
.trip-planner-ride-connection { text-align: center; }
.trip-planner-ride-arrow {
  position: relative; margin: 8px 2px 5px; border-top: 2px solid var(--trip-ride);
}
.trip-planner-ride-arrow::after {
  content: ''; position: absolute; right: 0; top: -4px; width: 6px; height: 6px;
  border-top: 2px solid var(--trip-ride); border-right: 2px solid var(--trip-ride); transform: rotate(45deg);
}
.trip-planner-route-mark { background: var(--trip-hover); color: var(--trip-accent); padding: 1px 4px; border-radius: 4px; }
.trip-planner-raw-walk { margin: 4px 0; font-size: 12px; color: var(--trip-muted); }
.trip-planner-raw-walk summary { cursor: pointer; }
@container (max-width: 365px) {
  .trip-planner-mode-choices { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
`
