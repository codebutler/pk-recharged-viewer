// The GBA summary-screen tab strip. Selection lives in the URL hash, as it did
// in the Python page, so a tab survives a reload and can be linked to.
import { html } from "../html.js";
import { useEffect } from "preact/hooks";

export function TabBar({ tabs, active, onSelect }) {
  // Keep the hash in step with the selection (replaceState: tab switches are
  // not history entries).
  useEffect(() => {
    if (active && location.hash.slice(1) !== active) {
      history.replaceState(null, "", `#${active}`);
    }
  }, [active]);

  useEffect(() => {
    const onHash = () => {
      const id = location.hash.slice(1);
      if (tabs.some((t) => t.id === id)) onSelect(id);
    };
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, [tabs, onSelect]);

  const onKeyDown = (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const i = tabs.findIndex((t) => t.id === active);
    const j = (i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length;
    onSelect(tabs[j].id);
    document.getElementById(`tab-${tabs[j].id}`)?.focus();
    e.preventDefault();
  };

  return html`
<div id="tabbar" role="tablist" aria-label="Sections" onKeyDown=${onKeyDown}>
  ${tabs.map((t) => html`
  <button role="tab" id=${`tab-${t.id}`} aria-controls=${`pane-${t.id}`}
          aria-selected=${String(t.id === active)} tabIndex=${t.id === active ? 0 : -1}
          class=${t.empty ? "tab-empty" : ""}
          onClick=${() => onSelect(t.id)}>${t.label}</button>`)}
</div>`;
}

export const Pane = ({ id, active, children }) => html`
<div class="pane" id=${`pane-${id}`} role="tabpanel" aria-labelledby=${`tab-${id}`}
     hidden=${id !== active}>${children}</div>`;

/** The tab named by the URL hash, if it is one of ours; else the first tab. */
export function initialTab(tabs) {
  const id = location.hash.slice(1);
  return tabs.some((t) => t.id === id) ? id : tabs[0].id;
}
