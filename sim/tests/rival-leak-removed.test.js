'use strict';

// rival-leak-removed.test.js — roadmap 2.5, the ruling-11 cleanup (docs/exploration-model.md §4 ruling 11,
// 08-10-26). The end-of-tick step `observePublicRegister` — which banked a RIVAL's licensed node into every
// other guild's exploration record — is REMOVED, and the per-guild view shows every CONTROLLED system at full
// L2, live. This file proves the removal moved exactly what it was meant to, byte for byte, against main at
// 41fe84c (just before it). The tripwires:
//
//   1. THE GOD'S-EYE LENS DID NOT MOVE, at any step. It never carried the record, so removing a record
//      writer cannot touch it.
//   2. ONE GUILD, NO RIVAL: state, god's-eye and the guild's own view are all byte-identical to main — the
//      removed step had nothing to observe, and the projection adds nothing the home record did not hold.
//   3. THE STATE moved by EXACTLY the leaked facts: main's state with every record fact in a rival-held
//      system stripped out IS the new state. Proved twice — against a hash main computed itself, and
//      in-tree, by replaying the removed step (copied below, test-only) to rebuild main's exact bytes.
//   4. THE VIEWS moved ONLY on rival-held ground: strip the rival's ground from both views and they match.
//      The full new views are pinned too, so any later drift is caught.
//   5. THE TRIPWIRE: across the whole script, every tick, no guild's record gains a single fact from a
//      rival's licensed venture — the leak cannot silently come back.
//
// ⤳ 09-10-26 (roadmap 2.5, the settlement-surface engine slice): every record entry now carries a `slots` map
// (founding fills the home's), and every `geography.known` entry carries `slots` too — so every STATE and VIEW
// below moved again, by exactly those maps. Each pin above the line "after the settlement-surface slice" is
// therefore asserted with the slots STRIPPED (tests/slot-strip.js): strip them and main's 41fe84c bytes, and
// the 08-10-26 views, come back exactly. The full new bytes are pinned in WITH_SLOTS. The god's-eye pins did
// not move (the lens carries no record and builds no geography).
//
// ⤳ 09-10-26 (roadmap 2.5, the L0-board engine slice — ruling 12 slice 2): every per-guild VIEW lost its
// `geography.systems` block (L0 moved to the board + `claims`), so every view moved again, by exactly that
// block. Each view pin above is therefore asserted on the view with the block PUT BACK (tests/systems-block.js
// — rebuilt from the board and the view's own claims alone): put it back and the 09-10-26 settlement-surface
// bytes, and through them every older pin, come back exactly. The new views are pinned in SLIM, recorded on
// main at 348e0fc by deleting `geography.systems` from each WITH_SLOTS view — so the slim view IS slice 1's
// view minus the block. No state pin and no god's-eye pin moved (the slice changes no state and the lens
// builds no geography).

// ⤳ 16-10-26 (roadmap 2.5, the Prefecture / claims slice): digests pinned below were RE-PINNED. The slice
// re-banded two Tier-3 modules the Prefecture bill uses (claim_beacon → 3-2, habitation_module → 3-3;
// docs/phase-1-tuning.md), which moves their seeded price rows (prices, price history, the quote ring, and the
// snapshot's price fields) in every state and view. With those two goods' keys deleted, every digest this file
// computes is the one 79807db computed, line for line (checked over all of them at the re-pin); scripted runs
// keep that proof standing in tests/rebanded-goods-delta.test.js. Where a test below says "byte-identical to
// main" or "the pre-slice engine", read: apart from those two goods' price rows.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

const { hashState, canonicalStringify } = require('../serialize.js');
const { buildSnapshot } = require('../snapshot.js');
const { withoutInstallationQuotes } = require('./installation-quote-strip.js');
const { withoutDeepScanLanes } = require('./deep-scan-lane-strip.js');
const { withoutControlMap } = require('./control-map-strip.js');
const { checkInvariants } = require('../invariants.js');
const { getSite } = require('../seed.js');
const { reveal, isOnPublicRegister } = require('../exploration.js');
const {
  rivalLeakScript, soloScript, withoutRivalFacts, withoutRivalGround, A, B, B_PLANET, B_MINE,
} = require('./rival-leak-script.js');
const { stripRecordSlots, stripKnownSlots, withoutRecordSlots, withoutKnownSlots } = require('./slot-strip.js');
const { withSystemsBlock } = require('./systems-block.js');

const sha = (text) => createHash('sha256').update(text).digest('hex');
// ⤳ 15-10-26: both through the installation-quote strip (tests/installation-quote-strip.js). The installation
// kit acquire slice added two public assetPurchaseQuote rows to every lens and view and nothing else, so every
// pin in this file stays the bytes it was, with exactly those two rows taken out.
// ⤳ 15-10-26 (slice 14b): and through the deepScan-lane strip (tests/deep-scan-lane-strip.js) — every guild row
// holding a system gained `deployRange.deepScan` and nothing else moved, so the pins still stand.
// ⤳ 16-10-26 (the Prefecture / claims slice, engine PR 2): and through the control-map strip (tests/control-map-strip.js)
// — every snapshot and view gained the public `controlMap` and nothing else moved, so the pins still stand.
const godsEye = (s) => sha(JSON.stringify(withoutDeepScanLanes(withoutInstallationQuotes(withoutControlMap(buildSnapshot(s))))));
const viewOf = (s, guildId) => withoutDeepScanLanes(withoutInstallationQuotes(withoutControlMap(buildSnapshot(s, guildId))));
const guildOf = (s, id) => s.guilds.find((g) => g.id === id);

// Recorded on main at 41fe84c — BEFORE the cleanup — by copying tests/rival-leak-script.js into a checkout of
// that commit and hashing each step: the state (hashState), the state with `withoutRivalFacts` applied, the
// god's-eye lens, and each guild's view with `withoutRivalGround` applied (JSON.stringify(buildSnapshot)).
const ON_MAIN = {
  founded: {
    state: 'a6a22d60f68a9bdf59273df6ac831327fbe0317c87474328c1131a4b69bd1168',
    strippedState: 'a6a22d60f68a9bdf59273df6ac831327fbe0317c87474328c1131a4b69bd1168',
    godsEye: 'b1bd00dafa58a4f6e71fc24a025930a8d846f6c5d7fe74906a72d6c088006659',
    strippedView: {
      [A]: '96f28fd9153c186220994f340fc152bd7107f2399b4f342bc2e14b512792871d',
      [B]: '3e9fc7db7f7b697ebf64e6129fde9302a184ca1720f256d6ea485c57ce62d80e',
    },
  },
  licensed: {
    state: 'f3420df7f7c2866daa9f46d1c2bec8c9354eaf88b9b46cf4124dff9fb04ce642',
    strippedState: '0d6777073976230aefa3971a41bdc657a9274d561ce5a3aaace28001114290b7',
    godsEye: '637bbe74d4278495797a8f3640503323e5b7c3a0e9deb10c02fa8375f409718d',
    strippedView: {
      [A]: 'da407aaddcc42aab5fa82ee6c98d5441ceea24f523686903c18c448b9f9b5515',
      [B]: '60d9825f772e8f7a3ebf24fcf5193a8591c98a36c03b376890704978c9024a3c',
    },
  },
  closed: {
    state: '7a38792fb2c8d0e6ac37dc6a08df1cf089a37e2292cb2d4679ac40685edd2718',
    strippedState: '20be450b3271e778167456e9b65dc904111a952e305ab70251097e4d3e98f794',
    godsEye: '637d7260d995ed57f272987d483d08c0f0a294749039fd42f6b212df43f0754b',
    strippedView: {
      [A]: '5b2ec2dbb410783a4c8c1ee2ff7e95b8c4a14b8c7a1298867788ff6bd5d4e11c',
      [B]: 'e1bddbe5d9ace326cc0fa0e0b28c7296f3e720c1808d5b7b554b2d13b63cd7e0',
    },
  },
};
const SOLO_ON_MAIN = {
  state: '024c792061ec079048cc4dfadb2c7d1204df207c7ea9d2d0bcc1dd73dd0f4a4f',
  godsEye: '6a9d145924522e29bf1a33f722b232997e468ee262671e9fee4a42ad70f25abe',
  view: '64072254112eb4aea21ed9305a9048231f7c5aa215ff6e0f1d0ca2edd129e0ce',
};

// The full per-guild views after the cleanup, recorded 08-10-26. Each shows the rival's home at full L2.
// ⤳ 09-10-26: now the views with `known`'s slots stripped (the full views are WITH_SLOTS, below).
const VIEWS_AFTER = {
  founded: {
    [A]: '6a09441a6f893d5c62a6b2d66086461ee0230d8c49a53f46346282fb88ee7c38',
    [B]: 'd92eaa4f5335402b58d7f6505e75fae440998dfcb88252751bef758fd69030a1',
  },
  licensed: {
    [A]: 'a5f6be5be2ae750a2da243da5e7ef61f6da1761b4d96e228e7c210d017bdecad',
    [B]: '8bba7fd8667afee2f723da84d7c3ed04f4220f9586bb793a7aff3a34cbd337c8',
  },
  closed: {
    [A]: 'b0f4e10c51fbadd3758dda6819fa0f2e1026eead249b0aac307bee9c451f19ca',
    [B]: 'f73275cb34feac833201e130f44aaa0ace794eb15c72ac70ef0c021b9b53a36c',
  },
};

// After the settlement-surface slice, recorded 09-10-26: the full states and per-guild views of the same steps.
const WITH_SLOTS = {
  founded: {
    state: '85e9d89951e45de79b5377bc608039eba69374335a605b91a474ad269b150496',
    [A]: '53f437946836efb9f5e6dd53b5f37be1178fb4fe8c2d45870a32b5558930aa79',
    [B]: '58ce4ce68266ee1872de1563c95000db8c89d77e3e1284b30c22b5b62fe5d407',
  },
  licensed: {
    state: '6187e12c938b267a703a11dac5f0775365bf08f1d23a77dd57d86141e617f36a',
    [A]: 'b434c15f8b69102770c1a2f81bf672f5530c4438be947bdd2cfc3d9655cd83bb',
    [B]: 'd0df1c77b81c54be8a3ed415fac612192d5af2be3510259e735402b6787489ae',
  },
  closed: {
    state: '462cfd2f59ab7c7e3078b295507ea4b8f333901b6cd81055640cabe4bc49ee5d',
    [A]: '407e43a7a276274cf2048faf08f4652d7e6564ca1cbee9ab89b65eba41ba3537',
    [B]: '789f9291dbbd9e1f5234b116149cf8338694e44a69fb5a2ba9aa7ff99ccfb804',
  },
};
const SOLO_WITH_SLOTS = {
  state: 'c4e0600b45aaba8bcb1113788b86507cced6cb8120f3d09da7d25b4006688404',
  view: '3a2e80e099e69c64a712a1f51cfc329408ca6c7c50763eb3273686cdd54e8737',
};

// After the L0-board slice: the per-guild views of the same steps, with no `geography.systems`. Recorded on
// main at 348e0fc — BEFORE the slice — by deleting `geography.systems` from each view above (WITH_SLOTS,
// SOLO_WITH_SLOTS) and hashing the rest; the slim view must hash to exactly that. The states did not move.
const SLIM = {
  founded: {
    [A]: 'fea29dd814b9e2192921b986b982b1fe9aa54e766f58cb0fae1d099dec7afc3b',
    [B]: '708d0c9fbbedfc491fb5fc6ffec952d44ba6e981d4cb86d70bcbce98009f6417',
  },
  licensed: {
    [A]: '047e798950e93cd8a71596e7ece2054591580b750ede6b7a2358ece6bf9ef387',
    [B]: '7594f5f0b103783abb1a81321f66bdf4ceca9c172311c02337116cca36599150',
  },
  closed: {
    [A]: 'e9deaa3744f6fa12ca830693053807c06054e55deafb6f51f4999bc74d9c4aad',
    [B]: '5628a00bab799c6168de8a3820709e4041ea20f1a2488d749e775279d737ff5a',
  },
};
const SOLO_SLIM = { view: '9778b70c9d96c88ed9129698ea496ba8356d2ff0b5a6f70ce2514e31cae28ef3' };

// legacyObservePublicRegister(state) — the REMOVED end-of-tick step, copied from main at 41fe84c
// (sim/exploration.js `publicRegisterFacts` + `observePublicRegister`) for ONE purpose: rebuilding main's bytes
// inside this test, so the proof needs no second checkout. It is not engine code; nothing in sim/ calls it.
// Every guild reads each RIVAL's licensed ventures off the register and reveals what each teaches.
function legacyObservePublicRegister(state) {
  const register = [];
  for (const owner of state.guilds) {
    for (const v of owner.ventures || []) {
      if (!isOnPublicRegister(v) || !v.siteId) continue;
      const site = getSite(v.siteId);
      if (!site) continue;
      register.push({ ownerGuildId: owner.id, fact: site.kind === 'resource' ? { nodeId: site.id } : { planetId: site.planetId } });
    }
  }
  for (const observer of state.guilds) {
    for (const { ownerGuildId, fact } of register) {
      if (ownerGuildId !== observer.id) reveal(observer, fact, state.tick);
    }
  }
}

// --- 1. the god's-eye lens did not move ----------------------------------------------------------------------

test('GOD\'S-EYE: byte-identical to main at every step — it never carried the record', () => {
  const steps = rivalLeakScript();
  for (const [name, pins] of Object.entries(ON_MAIN)) {
    assert.equal(godsEye(steps[name]), pins.godsEye, `the god's-eye lens moved at "${name}"`);
  }
  assert.equal(godsEye(soloScript().solo), SOLO_ON_MAIN.godsEye);
});

// --- 2. one guild, no rival: nothing moved ---------------------------------------------------------------------

test('ONE GUILD: state, god\'s-eye and the guild\'s own view are byte-identical to main', () => {
  const { solo } = soloScript();
  const view = viewOf(solo, A);
  const legacy = withSystemsBlock(view); // slice 1's view: the L0-board slice's one delta, put back
  assert.equal(hashState(stripRecordSlots(solo)), SOLO_ON_MAIN.state, 'no rival, so the removed step never wrote anything');
  assert.equal(godsEye(solo), SOLO_ON_MAIN.godsEye);
  assert.equal(sha(JSON.stringify(stripKnownSlots(legacy))), SOLO_ON_MAIN.view,
    'the only controlled system is the home, which the founding record already holds in full');
  // The full bytes after the settlement-surface slice, and the slots really there (so the strips prove something).
  assert.equal(hashState(solo), SOLO_WITH_SLOTS.state);
  assert.equal(sha(JSON.stringify(legacy)), SOLO_WITH_SLOTS.view);
  assert.ok(withoutRecordSlots(solo).count > 0 && withoutKnownSlots(view).count > 0);
  // The full bytes after the L0-board slice: slice 1's view with `geography.systems` deleted.
  assert.equal(sha(JSON.stringify(view)), SOLO_SLIM.view);
});

// --- 3. the state moved by exactly the leaked facts ------------------------------------------------------------

test('STATE: identical to main until a rival licensed venture is observed; after it, main MINUS the leak', () => {
  const steps = rivalLeakScript();
  // (Each state with its record slots stripped — the settlement-surface slice's only delta.)
  assert.equal(hashState(stripRecordSlots(steps.founded)), ON_MAIN.founded.state, 'founded: nothing licensed yet, so nothing moved');
  for (const name of ['licensed', 'closed']) {
    assert.notEqual(hashState(stripRecordSlots(steps[name])), ON_MAIN[name].state, `${name}: main's state held the leak, so this must differ`);
    assert.equal(hashState(stripRecordSlots(steps[name])), ON_MAIN[name].strippedState,
      `${name}: main's state with its rival-held record facts stripped IS the new state`);
  }
  for (const name of Object.keys(WITH_SLOTS)) {
    assert.equal(hashState(steps[name]), WITH_SLOTS[name].state, `${name}: the full state after the settlement-surface slice`);
    assert.ok(withoutRecordSlots(steps[name]).count > 0, `${name}: the foundings really recorded settlement slots`);
  }
});

test('STATE, in-tree: replaying the removed step rebuilds main exactly, and stripping the leak gives the new state', () => {
  const now = rivalLeakScript();
  const legacy = rivalLeakScript({ afterTick: legacyObservePublicRegister });
  for (const name of Object.keys(ON_MAIN)) {
    assert.equal(hashState(stripRecordSlots(legacy[name])), ON_MAIN[name].state, `${name}: the replay is main, byte for byte (slots stripped)`);
    assert.equal(hashState(withoutRivalFacts(legacy[name])), hashState(now[name]), `${name}: main minus the leak is now`);
  }
  // And the leak, named: the one rival planet and its licensed node, banked at the first tick's end.
  assert.deepEqual(guildOf(legacy.closed, A).exploration[B_PLANET], { tick: 1, nodes: { [B_MINE]: 1 }, slots: {} });
  assert.equal(B_PLANET in guildOf(now.closed, A).exploration, false);
});

// --- 4. the views moved only on rival-held ground -------------------------------------------------------------

test('VIEWS: strip the rival-held ground and every view is main\'s; the full views are pinned', () => {
  const steps = rivalLeakScript();
  for (const [name, pins] of Object.entries(ON_MAIN)) {
    for (const guildId of [A, B]) {
      const view = viewOf(steps[name], guildId);
      const legacy = withSystemsBlock(view); // the L0-board slice's only delta, put back
      const noSlots = stripKnownSlots(legacy); // the settlement-surface slice's only delta, stripped
      assert.equal(sha(JSON.stringify(withoutRivalGround(noSlots))), pins.strippedView[guildId],
        `${guildId}'s view moved OUTSIDE rival-held ground at "${name}"`);
      assert.equal(sha(JSON.stringify(noSlots)), VIEWS_AFTER[name][guildId], `${guildId}'s view moved outside its slots at "${name}"`);
      assert.equal(sha(JSON.stringify(legacy)), WITH_SLOTS[name][guildId], `${guildId}'s view moved outside geography.systems at "${name}"`);
      assert.equal(sha(JSON.stringify(view)), SLIM[name][guildId], `${guildId}'s full view moved at "${name}"`);
    }
  }
});

test('VIEWS: the one lockout difference is the record\'s — main showed A the lockout on B\'s banked node; now it does not', () => {
  // Spelled out because it is a consequence, not the aim: a node lockout shows on a node the viewer's RECORD
  // knows (ruling 3). The record no longer banks B's node, so the lockout B's closure left there is B's to see
  // only. Whether it should follow the live projection instead is open on the roadmap's decision checklist.
  const { closed } = rivalLeakScript();
  assert.deepEqual(buildSnapshot(closed).nodeLockouts.map((l) => l.siteId), [B_MINE], 'the lockout exists');
  assert.deepEqual(viewOf(closed, A).nodeLockouts, [], 'A no longer sees it');
  assert.deepEqual(viewOf(closed, B).nodeLockouts.map((l) => l.siteId), [B_MINE], 'B, on its own ground, does');
  const legacy = rivalLeakScript({ afterTick: legacyObservePublicRegister });
  assert.deepEqual(viewOf(legacy.closed, A).nodeLockouts.map((l) => l.siteId), [B_MINE], 'on main, A did');
});

// --- 5. the tripwire ------------------------------------------------------------------------------------------

test('TRIPWIRE: at every tick, no guild\'s record gains a single fact from a rival\'s licensed venture', () => {
  // The script's rival runs a licensed MINE (a node — the old leak's main case) and a licensed REFINERY (a
  // settlement slot — the old leak's planet-only case), so if any observation of the register came back,
  // either one would write into A's record at the next tick's end.
  const founded = rivalLeakScript().founded;
  const atFounding = Object.fromEntries(founded.guilds.map((g) => [g.id, canonicalStringify(g.exploration)]));
  let ticksChecked = 0;
  let licensedSeen = 0;
  rivalLeakScript({
    afterTick: (s) => {
      ticksChecked += 1;
      licensedSeen += guildOf(s, B).ventures.filter(isOnPublicRegister).length;
      for (const g of s.guilds) {
        assert.equal(canonicalStringify(g.exploration), atFounding[g.id],
          `tick ${s.tick}: ${g.id}'s record changed — only founding and its own scans may write it (ruling 11)`);
      }
      assert.deepEqual(checkInvariants(s, s.tick), [], `tick ${s.tick}`);
    },
  });
  assert.equal(ticksChecked, 5, 'every tick of the script was checked');
  assert.ok(licensedSeen > 0, 'the rival really had licensed ventures on the register — the check is not vacuous');
});
