/** 面板样式限定在插件容器内，并使用 Harness 的主题变量。 */
export const styles = `
.trip-planner-panel, .trip-planner-panel * { box-sizing: border-box; }
.trip-planner-panel {
  --trip-text: var(--dsw-alias-label-primary, #1e2938);
  --trip-muted: var(--dsw-alias-label-secondary, #566579);
  --trip-border: var(--dsw-alias-border-l4, #d9e0e9);
  --trip-hover: var(--dsw-alias-interactive-bg-hover, #edf3fa);
  --trip-accent: var(--dsw-alias-link, #315dbe);
  container-type: inline-size;
  height: 100%; overflow: auto; color: var(--trip-text);
  padding: 16px clamp(12px, 3vw, 22px) 24px;
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
.trip-planner-endpoints { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.trip-planner-endpoints button, .trip-planner-options li button { display: grid; gap: 3px; width: 100%; text-align: start; overflow-wrap: anywhere; }
.trip-planner-picker { width: min(520px, calc(100vw - 28px)); max-height: calc(100dvh - 36px); overflow: auto; color: var(--trip-text); background: var(--dsw-alias-bg-base, Canvas); }
.trip-planner-picker::backdrop { background: rgb(0 0 0 / .32); }
.trip-planner-picker .trip-planner-subheading h2 { margin: 0; }
.trip-planner-picker-tabs { display: flex; gap: 8px; margin-top: 12px; }
.trip-planner-picker-tabs button[aria-pressed=true] { border-color: var(--trip-accent); color: var(--trip-accent); background: var(--trip-hover); }
.trip-planner-endpoints button span, .trip-planner-card small { color: var(--trip-muted); }
.trip-planner-search, .trip-planner-route-form { display: grid; gap: 8px; align-items: end; margin: 12px 0; }
.trip-planner-search { grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) auto; }
.trip-planner-route-form { grid-template-columns: minmax(0, 1fr) auto; }
.trip-planner-subheading { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.trip-planner-subheading button { font-size: 12px; padding: 4px 8px; }
.trip-planner-options { border-top: 1px solid var(--trip-border); margin-top: 14px; padding-top: 12px; }
.trip-planner-options ul { list-style: none; display: grid; gap: 6px; margin: 8px 0 0; padding: 0; }
.trip-planner-option-row { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.trip-planner-options .trip-planner-option-row > :first-child { flex: 1 1 12rem; min-width: 0; }
.trip-planner-options .trip-planner-option-row > :not(:first-child) { width: auto; flex: 0 0 auto; }
.trip-planner-edit { display: grid; gap: 8px; margin-top: 12px; padding: 12px; border: 1px solid var(--trip-border); border-radius: 8px; }
.trip-planner-edit h4 { margin: 0; }
.trip-planner-edit-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.trip-planner-error { color: var(--dsw-alias-state-error-primary, #ad2828); overflow-wrap: anywhere; }
.trip-planner-route-title { font-weight: 650; overflow-wrap: anywhere; }
.trip-planner-alternative { border: 1px solid var(--trip-border); border-radius: 10px; padding: 12px; margin-bottom: 10px; }
.trip-planner-alternative p { margin: 4px 0; overflow-wrap: anywhere; }
.trip-planner-alternative ol, .trip-planner-alternative ul { padding-inline-start: 22px; }
.trip-planner-alternative ol > li + li { margin-top: 8px; }
.trip-planner-alternative ul[aria-label="本段可选线路"] { list-style: none; padding: 0; }
.trip-planner-ride { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; padding: 8px; margin-top: 6px; border: 1px solid var(--trip-border); border-radius: 8px; }
.trip-planner-route-mark { background: var(--trip-hover); color: var(--trip-accent); padding: 1px 4px; border-radius: 4px; }
.trip-planner-raw-walk { margin: 4px 0; font-size: 12px; color: var(--trip-muted); }
@container (max-width: 295px) {
  .trip-planner-endpoints, .trip-planner-route-form { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 460px) {
  .trip-planner-search { grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); }
  .trip-planner-search button { grid-column: 1 / -1; }
}
`
