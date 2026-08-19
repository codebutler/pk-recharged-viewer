// The six tab panes: party, bag, pokedex, storage, stats, more.
// One-to-one with the pane markup in research/tools/templates/report.html.j2.
import { Fragment } from "preact";
import { html } from "../html.js";
import { Sprite, Bar, TypeChip, Panel, SimpleStates } from "./common.js";

function MonCard({ m }) {
  return html`
<div class="mon">
  <div class="mon-head">
    <${Sprite} uri=${m.sprite} cls="spr big" label=${m.species} />
    <div>
      <div class="mon-name">${m.name}${m.shiny ? html`<span class="shiny" title="shiny">★</span>` : null}</div>
      <div class="mon-sub">${m.species} · Lv${m.level} ${m.ailment ? html`<span class="ail">${m.ailment}</span>` : null}</div>
      <div class="types">${m.types.map((t) => html`<${TypeChip} t=${t} />`)}</div>
    </div>
  </div>
  <div class="hp"><i class="explabel">HP</i>
    <${Bar} pct=${m.hpPct} color=${m.hpColor} />
    <span class="hpnum">${m.hp}/${m.maxHp}</span></div>
  ${m.expPct !== null ? html`
  <div class="hp exp"><i class="explabel">EXP</i>
    <${Bar} pct=${m.expPct} color="#40a8f8" />
    <span class="expnum">${m.expToNext} to Lv${m.level + 1}</span></div>`
  : m.maxed ? html`
  <div class="hp exp"><i class="explabel">EXP</i>
    <${Bar} pct=${100} color="#40a8f8" />
    <span class="expnum">MAX Lv</span></div>` : null}
  <ul class="moves">${m.moves.map((mv) => html`
    <li><span>${mv.name}${mv.type ? html`<${TypeChip} t=${mv.type} cls="type mtype" />` : null}</span>
        <span class="pp">PP ${mv.pp}</span></li>`)}
  </ul>
  ${m.held ? html`<div class="held">holds ${m.held}</div>` : null}
</div>`;
}

export const PartyPane = ({ party }) => html`
<${Panel} title="Party">
  <${SimpleStates} sec=${party} />
  ${party.mons ? html`<div class="party">${party.mons.map((m) => html`<${MonCard} m=${m} />`)}</div>` : null}
<//>`;

export const BagPane = ({ bag }) => html`
<${Panel} title="Bag">
  <${SimpleStates} sec=${bag} />
  ${bag.pockets ? html`
  <div class="pockets">${bag.pockets.map((p) => html`
    <div class="pocket"><h3>${p.label}</h3>
      ${p.slots.length ? html`
      <ul class="items">${p.slots.map((it) => html`
        <li>${it.sprite
              ? html`<img class="ispr" src=${it.sprite} alt="" />`
              : html`<span class="ispr ph">?</span>`}
          <span class="iname">${it.name}</span><span class="qty">×${it.qty}</span></li>`)}
      </ul>` : html`<p class="pocket-empty">empty</p>`}
    </div>`)}
  </div>` : null}
  ${bag.registered ? html`<p class="note">SELECT registered: ${bag.registered}</p>` : null}
  ${bag.warning ? html`<p class="warn">${bag.warning}</p>` : null}
<//>`;

export const DexPane = ({ dex }) => html`
<${Panel} title="Pokedex">
  ${dex.error ? html`<p class="empty">${dex.error}</p>` : html`
  <div class="dexcount">
    <div><b>${dex.seenCount}</b><i>SEEN</i></div>
    <div><b>${dex.ownedCount}</b><i>OWNED</i></div>
  </div>
  ${dex.empty ? html`<p class="empty">${dex.empty}</p>` : html`
  <p class="note">color = owned · silhouette = seen only</p>
  <div class="grid dexgrid">${dex.cells.map((c) => html`
    <span class="cell"><${Sprite} uri=${c.sprite} cls=${c.owned ? "spr sm" : "spr sm seen"} label=${c.label} /></span>`)}
  </div>`}`}
<//>`;

export const StoragePane = ({ boxes }) => html`
<${Panel} title="Pokemon Storage">
  <${SimpleStates} sec=${boxes} />
  ${boxes.shown ? html`
  <p class="note">${boxes.total} Pokemon stored · current box: ${boxes.current}${
    boxes.nEmpty ? ` · ${boxes.nEmpty} empty boxes not shown` : ""}</p>
  <div class="boxes">${boxes.shown.map((box) => html`
    <div class="box"><h3>${box.name}</h3><div class="grid">
      ${box.cells.map((cell) => html`<span class="cell">${
        cell ? html`<${Sprite} uri=${cell.sprite} cls="spr sm" label=${cell.label} />` : null}</span>`)}
    </div></div>`)}
  </div>` : null}
<//>`;

export const StatsPane = ({ gameStats }) => html`
<${Panel} title="Game Stats">
  <${SimpleStates} sec=${gameStats} />
  ${gameStats.rows ? html`<table class="stats"><tbody>
    ${gameStats.rows.map(([k, v]) => html`<tr><td>${k}</td><td>${v}</td></tr>`)}
  </tbody></table>` : null}
<//>`;

// MORE holds two sections under one tab, so its panels sit as siblings
// directly in the pane (as they did in the Jinja template) -- hence Fragment.
export const MorePane = ({ view }) => html`
<${Fragment}>
  ${view.rival ? html`<${Panel} title="Rival"><p class="big">${view.rival}</p><//>` : null}
  ${view.challenge ? html`
  <${Panel} title="Challenge">
    <${SimpleStates} sec=${view.challenge} />
    ${view.challenge.cap ? html`<p class="big">LEVEL CAP <b>${view.challenge.cap}</b> (mode ${view.challenge.mode})</p>` : null}
  <//>` : null}
  <${Panel} title="Mail">
    <${SimpleStates} sec=${view.mail} />
    ${view.mail.entries ? html`<ul>${view.mail.entries.map((e) => html`
      <li>slot ${e.slot} (${e.kind}): item #${e.itemId} from ${e.sender}</li>`)}</ul>` : null}
  <//>
<//>`;
