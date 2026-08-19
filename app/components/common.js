// Small shared pieces: the sprite/placeholder, the stat bar, the type chip and
// the panel frame. These are the Jinja macros at the top of
// research/tools/templates/report.html.j2, one to one.
import { html } from "../html.js";

export const Sprite = ({ uri, cls, label }) =>
  uri
    ? html`<img class=${cls} src=${uri} alt=${label} title=${label} />`
    : html`<span class="${cls} ph" title=${label}>?</span>`;

export const Bar = ({ pct, color }) => html`
  <span class="bar"><span class="fill" style=${`width:${pct}%;background:${color}`}></span></span>`;

export const TypeChip = ({ t, cls = "type" }) => html`
  <span class=${cls}
        style=${`background:${t.color};border-top-color:${t.light};border-bottom-color:${t.dark}`}
  >${t.name.toUpperCase()}</span>`;

export const Panel = ({ title, children }) => html`
  <section class="panel"><h2>${title}</h2>${children}</section>`;

/** A section that may carry an error or an empty message renders honestly. */
export const SimpleStates = ({ sec }) =>
  sec?.error ? html`<p class="empty">${sec.error}</p>`
  : sec?.empty ? html`<p class="empty">${sec.empty}</p>`
  : null;
