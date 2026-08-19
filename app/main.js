// main.js -- app root. Holds the two inputs (the prepared view data and the
// save the user drops) and hands derived view data to the components.
//
// Nothing here reaches the network beyond the app's own public/, and no file
// the user drops ever leaves the tab.
import { render } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { html } from "./html.js";
import { buildView, loadViewData } from "./viewmodel.js";
import { buildAssetArtwork, downloadJson, parseSaveFiles } from "./io.js";
import { DropZone, SaveNote, TopBar } from "./components/DropZone.js";
import { Report } from "./components/Report.js";

function App() {
  const [data, setData] = useState(null);        // prepared PokeAPI view data
  const [dataError, setDataError] = useState(null);
  const [save, setSave] = useState(null);        // {state, name}
  const [artwork, setArtwork] = useState(null);  // map + badges, from public/
  const [artBusy, setArtBusy] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const savePicker = useRef(null);

  useEffect(() => {
    loadViewData().then(setData, (e) =>
      setDataError(`Could not load public/data/gamedata-view.json (${e.message}). ` +
                   "Run: bun run tools/prepare-assets.js"));
  }, []);

  // --- file intake ---------------------------------------------------------
  const takeFiles = useCallback(async (files) => {
    const list = [...files];
    if (!list.length) return;
    {
      setBusy(true);
      try {
        const state = await parseSaveFiles(list);
        setSave({ state, name: list.map((f) => f.name).join(" + ") });
      } catch (e) {
        // Keep whatever was already loaded: a mis-drop should not throw away a
        // good report, and the error names the file it could not read.
        setError(e.message);
      } finally {
        setBusy(false);
      }
    }
  }, []);

  // Whole-window drag and drop, so there is no small target to aim at.
  useEffect(() => {
    const stop = (e) => { e.preventDefault(); };
    const onOver = (e) => { stop(e); setOver(true); };
    const onLeave = (e) => { stop(e); if (!e.relatedTarget) setOver(false); };
    const onDrop = (e) => { stop(e); setOver(false); takeFiles(e.dataTransfer.files); };
    addEventListener("dragover", onOver);
    addEventListener("dragleave", onLeave);
    addEventListener("drop", onDrop);
    return () => {
      removeEventListener("dragover", onOver);
      removeEventListener("dragleave", onLeave);
      removeEventListener("drop", onDrop);
    };
  }, [takeFiles]);

  // --- artwork: map + badges + overworld sprites, all from public/ ---------
  useEffect(() => {
    if (!save?.state?.inGame) { setArtwork(null); return; }
    let live = true;
    setArtBusy(true);
    const work = buildAssetArtwork(save.state);
    work
      .then((a) => { if (live) setArtwork(a); })
      .catch((e) => { if (live) setArtwork({ map: { error: e.message }, badges: [] }); })
      .finally(() => { if (live) setArtBusy(false); });
    return () => { live = false; };
  }, [save]);

  const view = useMemo(
    () => (save && data ? buildView(save.state, data) : null),
    [save, data]);

  useEffect(() => {
    if (view?.title) document.title = view.title;
  }, [view]);

  const pickSave = () => savePicker.current?.click();
  const onInput = (e) => { takeFiles(e.target.files); e.target.value = ""; };

  const pickers = html`
<div hidden>
  <input type="file" multiple ref=${savePicker} onChange=${onInput} />
</div>`;

  return html`
<h1>POKEMON RECHARGED YELLOW<small>SAVE ANALYZER</small></h1>
<main>
  ${pickers}
  ${dataError ? html`<div class="errbox"><b>Assets missing</b>${dataError}</div>` : null}
  ${error ? html`<div class="errbox"><b>Could not read that file</b>${error}</div>` : null}
  ${busy ? html`<p class="loading">Parsing…</p>` : null}
  ${!save
    ? html`<${DropZone} over=${over} onPickSave=${pickSave} />`
    : html`
  <${TopBar} saveName=${save.name} onPickSave=${pickSave}
             onDownload=${() => downloadJson(save.state, `${view?.playerName || "state"}.json`)} />`}
  ${view?.source ? html`<${SaveNote} source=${view.source} />` : null}
  ${view && !view.inGame
    ? html`<section class="panel"><h2>No save loaded</h2><p class="empty">${view.error}</p></section>`
    : null}
  ${view?.inGame ? html`
  <${Report} view=${view} artwork=${artwork} artBusy=${artBusy} />` : null}
</main>`;
}

// The tab strip is always live here (unlike the Python page, which had to
// enable it progressively), so the class that hides redundant pane titles is
// simply on from the start.
document.body.classList.add("tabs-on");
render(html`<${App} />`, document.getElementById("root"));
