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
 * The loaded-file bar: a GBA window holding the save slot. The tag plate is the
 * trainer card's BADGES label, the field is the card's white face, and the two
 * buttons use the tab strip's own states -- khaki for the page you are on
 * (here, the primary action), teal for the ones you can go to.
 */
export function TopBar({ saveName, onPickSave, onDownload }) {
  return html`
<div class="slotbar">
  <span class="slot-tag">SAVE</span>
  <span class="slot-name" title=${saveName}>${saveName}</span>
  <span class="slot-actions">
    <button class="gbabtn" onClick=${onPickSave}>LOAD ANOTHER</button>
    <button class="gbabtn gbabtn-primary" onClick=${onDownload}>DOWNLOAD JSON</button>
  </span>
</div>`;
}

/**
 * The second plate of the same window, for a save that is not live state --
 * currently a flash .sav. Same frame and palette as the slot bar so the two
 * read as one stacked unit. The wording is the parser's own FLASH_CAVEAT,
 * carried on state.source, so the two can never drift apart.
 */
export function SaveNote({ source }) {
  if (!source || source.live !== false) return null;
  const slot = source.slot
    ? `slot ${source.slot}${source.saveCounter != null ? ` · save #${source.saveCounter}` : ""}`
    : null;
  return html`
<div class="slotbar slotbar-note">
  <span class="slot-tag">FLASH SAVE</span>
  <span class="slot-field">
    ${slot ? html`<b>${slot}</b>` : null}
    <span>${source.caveat}</span>
  </span>
</div>`;
}
