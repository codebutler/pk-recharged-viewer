// The map box beside the trainer card: a fixed 3:2 GBA-screen rectangle
// holding the terrain crop around the player, with in-game-style popups for
// the location name and the clock. Click toggles the full map (unless the map
// is already small enough that the crop shows all of it).
//
// The terrain comes from the extracted map PNGs in public/; this slot only
// falls back to a message when a location has no extracted map, or when the
// assets are not deployed alongside the page.
import { html } from "../html.js";
import { useState } from "preact/hooks";
import { clock12 } from "../viewmodel.js";

export function MapPanel({ view, artwork, loading }) {
  const [showFull, setShowFull] = useState(false);
  const map = artwork?.map;

  if (loading) {
    return html`<div class="mapslot"><div class="romhint"><b>Rendering the map…</b></div></div>`;
  }
  if (!map || map.error) {
    const loc = view.location;
    return html`
<div class="mapslot">
  <div class="romhint">
    <b>Map unavailable</b>
    <span>${map ? map.error : "no map for this location"}</span>
    <span>${loc?.mapName ? `${loc.mapName} (${loc.x}, ${loc.y})` : ""}</span>
  </div>
</div>`;
  }

  const loc = view.location || {};
  const name = map.name || loc.mapName || `map (${loc.mapGroup}, ${loc.mapNum})`;
  const coords = map.coords || `(${loc.x}, ${loc.y})`;
  const time = map.clock12 || clock12(view.clock);
  const toggleable = !map.small;
  const title = `${name} at ${coords}${map.phase ? `, ${map.phase}` : ""}` +
    (toggleable ? " -- click to toggle full map" : "");
  const cls = ["maparea", toggleable ? "toggleable" : "", showFull ? "showfull" : ""]
    .filter(Boolean).join(" ");
  return html`
<div class="mapslot">
  <div class=${cls} id="maptoggle" title=${title}
       onClick=${() => toggleable && setShowFull((v) => !v)}>
    <img class="mapimg crop" src=${map.cropUrl || map.crop}
         alt=${`terrain around the player at ${name} ${coords}`} />
    ${toggleable && (map.fullUrl || map.full)
      ? html`<img class="mapimg full" src=${map.fullUrl || map.full} alt=${`full map of ${name}`} />`
      : null}
    <span class="map-popup town">${name}</span>
    ${time ? html`<span class="map-popup clock">${time}</span>` : null}
  </div>
</div>`;
}
