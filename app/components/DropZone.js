// The landing screen and the header strip: what you can drop, what is loaded,
// and the buttons that do the same job as dropping (a file picker is the
// fallback for browsers/devices where dragging is awkward).
import { html } from "../html.js";

export function DropZone({ over, onPickSave }) {
  return html`
<section class=${`dropzone${over ? " over" : ""}`}>
  <h2>DROP A SAVE</h2>
  <p>Drag a Recharged Yellow savestate or .sav anywhere on this page to read it.</p>
  <p class="hint">Everything happens in this tab. No file is uploaded anywhere.</p>
  <div>
    <button class="gbabtn" onClick=${onPickSave}>CHOOSE SAVE FILE</button>
  </div>
  <p class="dz-formats">
    Accepts mGBA savestates (.st0/.st9/.ss1…, PNG-container or raw), a flash
    .sav, a raw dump's iwram.bin + ewram.bin pair (drop both together), or a
    parse_ram.py output .json.
  </p>
</section>`;
}

/**
 * The strip under the header for a save that is not live state -- currently a
 * flash .sav. The wording is the parser's own FLASH_CAVEAT, carried on
 * state.source, so the two can never drift apart.
 */
export function SaveNote({ source }) {
  if (!source || source.live !== false) return null;
  const slot = source.slot
    ? `slot ${source.slot}${source.saveCounter != null ? ` · save #${source.saveCounter}` : ""}`
    : null;
  return html`
<p class="savnote">
  ${slot ? html`<b>${slot}</b>` : null}
  <span>${source.caveat}</span>
</p>`;
}

export function TopBar({ saveName, onPickSave, onDownload }) {
  return html`
<div class="topbar">
  ${saveName ? html`<span class="filechip">save <b>${saveName}</b></span>` : null}
  <button class="gbabtn" onClick=${onPickSave}>NEW SAVE</button>
  <button class="gbabtn" onClick=${onDownload}>DOWNLOAD JSON</button>
</div>`;
}
