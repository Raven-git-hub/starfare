'use strict';

// dark-array-script.js — the galaxies losing ground client slice 3's tests share: real Deep Scan Arrays going DARK
// (exploration-model.md §5, "AS-BUILT — the array goes dark"; design.md §19 #67) — so the snapshot's new `dark` field
// and its display are tested on rows the engine really wrote. Four of them:
//   evicted()     — eviction-reach-script.js's galaxy, then g1 abandons TARGET on the same tick. Of g1's arrays,
//                   `dark` (it was scanning; its job is voided) and `idleDark` (it was idle) touch nothing g1 still
//                   holds; `lit` touches HOME's control too and keeps its scan; g2's `rival` is untouched.
//   outpostGalaxy() / outpostGone()
//                 — g1 holding HOME only, with an Outpost two hexes outside HOME's disk and two arrays beside it:
//                   `alone` on the far side, IDLE (it touches the Outpost and nothing else), and `homeSide` between
//                   it and HOME, scanning (it touches HOME's control too). Then the operator removes the Outpost:
//                   `alone` goes dark WHILE IDLE — there is no job to void, so no notice is written and its row is
//                   not stamped — and nothing else the client keys its redraws on moves.
//   rewoken()     — evicted(), then g1 plants a second Prefecture in TARGET: its control is back, so both dark arrays
//                   are attached again. Nothing was stored, so nothing is cleared.
// It uses ONLY what `main` had at 1c28fe4 (the fixtures, the manual deploy, queueScan, the operator levers), so the
// byte-identity pins can be re-hashed on `main` by requiring this file there.

const { getClaimRadius, isHexInBounds, seedLandmarkAtHex } = require('../seed.js');
const {
  createAbandonPrefectureAction, createSpawnOutpostAction, createRemoveOutpostAction,
} = require('../actions.js');
const P = require('./prefecture-fixtures.js');
const R = require('./eviction-reach-script.js');

const { accept, HOME, HOME_HEX, TARGET, SLOT_A1 } = P;

const abandon = () => createAbandonPrefectureAction({ guildId: 'g1', prefectureId: 'prefecture_g1_01' });

// evicted() -> { before, s, arrays, outpost }: the reach galaxy (`before`) and the same tick after g1 abandons TARGET.
function evicted() {
  const g = R.reachGalaxy();
  return { before: g.s, s: accept(g.s, abandon()), arrays: g.arrays, outpost: g.outpost };
}

// outpostGalaxy() -> { s, alone, homeSide, outpost }: the galaxy described above, before the Outpost goes. The geometry
// is eviction-reach.test.js's own outpostGalaxy(), with `alone` left idle.
function outpostGalaxy() {
  const ring = getClaimRadius(HOME.id);
  const at = (d, n) => ({ q: HOME_HEX.q + n * d.q, r: HOME_HEX.r + n * d.r });
  const bare = (h) => isHexInBounds(h.q, h.r) && !seedLandmarkAtHex(h.q, h.r);
  const d = [{ q: 1, r: 0 }, { q: 1, r: -1 }, { q: 0, r: -1 }, { q: -1, r: 0 }, { q: -1, r: 1 }, { q: 0, r: 1 }]
    .find((x) => [ring + 1, ring + 2, ring + 3].every((n) => bare(at(x, n))));
  if (!d) throw new Error('dark-array script: no direction from HOME with three bare hexes outside its disk on this seed');
  let s = P.kitGalaxy({ fuelHoard: 5_000 });
  s = accept(s, createSpawnOutpostAction({ guildId: 'g1', anchorSystemId: HOME.id, coords: at(d, ring + 2) }));
  let alone; let homeSide;
  ({ s, id: alone } = R.deployArray(s, 'g1', HOME.id, at(d, ring + 3)));
  ({ s, id: homeSide } = R.deployArray(s, 'g1', HOME.id, at(d, ring + 1)));
  s = accept(s, R.scanL1('g1', homeSide, R.SCAN_TARGETS[1]));
  return { s, alone, homeSide, outpost: s.outposts[0].id };
}

// outpostGone() -> outpostGalaxy(), plus `before` and the same tick after the operator removes the Outpost.
function outpostGone() {
  const g = outpostGalaxy();
  return { ...g, before: g.s, s: accept(g.s, createRemoveOutpostAction({ guildId: 'g1', outpostId: g.outpost })) };
}

// rewoken() -> evicted(), then g1 re-plants TARGET with a fresh Prefecture kit, on the same tick.
function rewoken() {
  const e = evicted();
  let { s } = e;
  let kitId;
  ({ s, kitId } = P.grantPrefectureKit(s, 'g1', TARGET));
  return { ...e, s: accept(s, P.plant('g1', kitId, SLOT_A1)) };
}

module.exports = { abandon, evicted, outpostGalaxy, outpostGone, rewoken };
