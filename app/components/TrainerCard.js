// The in-game trainer card: sky-blue bands, white face, badge strip.
// Badge art comes from the ROM when one is loaded; otherwise the PokeAPI badge
// renders copied into public/ by tools/prepare-assets.js stand in.
import { html } from "../html.js";
import { assetUrl } from "../viewmodel.js";

const badgeArt = (b, romBadges) => romBadges?.[b.n - 1] || assetUrl(`sprites/badges/${b.n}.png`);

export function TrainerCard({ trainer, artwork }) {
  if (trainer.error) {
    return html`<section class="panel tcard"><h2>Trainer Card</h2>
      <p class="empty">${trainer.error}</p></section>`;
  }
  // Only the male trainer's full-body art was extracted from the ROM capture;
  // with a ROM loaded the overworld sprite stands in for anyone else.
  const pic = trainer.gender === "male" ? assetUrl("trainer-pic-male.png") : null;
  const ow = artwork?.playerSprite || null;
  return html`
<section class="panel tcard">
  <div class="tc-band"><h2>TRAINER CARD</h2><span class="tc-idno">${trainer.idno}</span></div>
  <div class="tc-white">
    <div class="tc-fields">
      <div class="tc-frow"><i></i><span>Name: <b class="tc-namev">${trainer.name}</b></span></div>
      ${trainer.fields.map(([label, value]) => html`
      <div class="tc-frow"><i></i><span>${label}</span><b>${value}</b></div>`)}
    </div>
    ${pic
      ? html`<img class="tc-pic" src=${pic} alt="trainer" />`
      : ow
      ? html`<img class="tc-pic tc-pic-ow" src=${ow} alt="player overworld sprite"
                  title="overworld sprite (full-body art unavailable)" />`
      : null}
  </div>
  <div class="tc-badgeband"><span class="tc-badgelabel">BADGES</span>
    <span class="tc-badges">${trainer.badges.map((b) => {
      const art = badgeArt(b, artwork?.badges);
      return b.lit && art
        ? html`<img class="badge" src=${art} alt=${`${b.name} Badge`} title=${`${b.name} Badge`} />`
        : html`<span class="badge-slot" title=${`${b.name} Badge (not earned)`}></span>`;
    })}</span>
  </div>
</section>`;
}
