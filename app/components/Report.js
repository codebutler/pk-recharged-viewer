// The report itself: trainer card + map header, the tab strip, and the panes.
// It is one component (rather than a run of siblings inlined into the app
// root) so that swapping the landing screen for the report swaps a single
// child -- Preact diffs that cleanly, where an inlined array of a dozen
// conditional siblings does not.
import { html } from "../html.js";
import { useState } from "preact/hooks";
import { TrainerCard } from "./TrainerCard.js";
import { MapPanel } from "./MapPanel.js";
import { TabBar, Pane, initialTab } from "./Tabs.js";
import { PartyPane, BagPane, DexPane, StoragePane, StatsPane, MorePane } from "./panes.js";

export function Report({ view, artwork, artBusy }) {
  const [tab, setTab] = useState(() => initialTab(view.tabs));
  return html`
<div class="report">
  <div class="tc-top">
    <${TrainerCard} trainer=${view.trainer} artwork=${artwork} />
    <${MapPanel} view=${view} artwork=${artwork} loading=${artBusy} />
  </div>
  <${TabBar} tabs=${view.tabs} active=${tab} onSelect=${setTab} />
  <${Pane} id="party" active=${tab}><${PartyPane} party=${view.party} /><//>
  <${Pane} id="bag" active=${tab}><${BagPane} bag=${view.bag} /><//>
  <${Pane} id="pokedex" active=${tab}><${DexPane} dex=${view.dex} /><//>
  <${Pane} id="storage" active=${tab}><${StoragePane} boxes=${view.boxes} /><//>
  <${Pane} id="stats" active=${tab}><${StatsPane} gameStats=${view.gameStats} /><//>
  <${Pane} id="more" active=${tab}><${MorePane} view=${view} /><//>
</div>`;
}
