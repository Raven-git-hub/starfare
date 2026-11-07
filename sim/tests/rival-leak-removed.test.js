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
//
// ⤳ 02-11-26 (roadmap 2.6, droid engine slice 1 — the Tier-3 reband): digests pinned below were RE-PINNED again. The
// slice gave the droid's two parts their ruled sub-tier (drive_module → 3-2, droid_components → 3-2;
// docs/phase-1-tuning.md §Droids), which moves their seeded price rows (prices, price history, the quote ring, the
// snapshot's price fields and tier3Contract) in every state and view. With those two goods' keys deleted, every digest
// this file computes is the one 4bf6cbb computed, line for line (checked over all of them at the re-pin); scripted
// runs keep that proof standing in tests/rebanded-goods-delta.test.js. Read "byte-identical to main" or "the pre-slice
// engine" below as: apart from the re-banded goods' price rows.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

const { hashState, canonicalStringify } = require('../serialize.js');
const { buildSnapshot } = require('../snapshot.js');
// ⤳ 07-11-26: the droid batch-buy slice's one snapshot delta, stripped so the goldens below keep their old pins.
const { withoutDroidBatchQuote } = require('./droid-batch-quote-strip.js');
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
const godsEye = (s) => sha(JSON.stringify(withoutDeepScanLanes(withoutInstallationQuotes(withoutControlMap(withoutDroidBatchQuote(buildSnapshot(s)))))));
const viewOf = (s, guildId) => withoutDeepScanLanes(withoutInstallationQuotes(withoutControlMap(withoutDroidBatchQuote(buildSnapshot(s, guildId)))));
const guildOf = (s, id) => s.guilds.find((g) => g.id === id);

// Recorded on main at 41fe84c — BEFORE the cleanup — by copying tests/rival-leak-script.js into a checkout of
// that commit and hashing each step: the state (hashState), the state with `withoutRivalFacts` applied, the
// god's-eye lens, and each guild's view with `withoutRivalGround` applied (JSON.stringify(buildSnapshot)).
const ON_MAIN = {
  founded: {
    state: 'da04ae04b6a8320e3abef64fb2e54df38024b0140814072a56866629d30afc8c',
    strippedState: 'da04ae04b6a8320e3abef64fb2e54df38024b0140814072a56866629d30afc8c',
    godsEye: 'b20f584c39a20396bc02fb3264455910a4cd24085ecd4d6242d7a80245156fab',
    strippedView: {
      [A]: '450ec241cdbfa7d5921b0d042189e61ab62125b29891e73c095c9e3e7bc856c3',
      [B]: 'b34dc5ff4d94430c2bb5959b66f652449ea4bd1900607efa0c3f8b2b18be0eae',
    },
  },
  licensed: {
    state: 'ed3b38028b9375c14eb78000a352c6a73503ca34f5cfd267c69c2464aba5e523',
    strippedState: '65e94a4665ea321c1b60e24958282f0d7c8988bea94236b1a4338002306d1fed',
    godsEye: '7b380db33ba6974fd471b5764faf2d29456a5ee3bbd703c45ae229297373796c',
    strippedView: {
      [A]: '0b75590c4ca91f200a11b6f017793792ca871ddb374f60915893d1d1af33cefb',
      [B]: '98f8126b24cba76c6904005a820c5ce00dc1986b84c7fe80c856b9247553b13b',
    },
  },
  closed: {
    state: '55c1dddab2097e5ac8c7b030737dbbfcd0558584edfe5ff03005e83a044b4443',
    strippedState: 'd5a831d8760d56fa1aacbe11a3a1da58b4c76e2ab0366cf371ce2f9f7e4af80e',
    godsEye: '9e4ff071ea8d34be5d314374c3b57df19ba6274844b060ad454417a03745d9fe',
    strippedView: {
      [A]: 'ba8181f87f479cdf96d2902620ffdd2a5a597dc281cd07c093991308129bad4d',
      [B]: '69346a07491679b33d9f922651407e0169a34a34c764ffbdf3e39e3dab7fadd3',
    },
  },
};
const SOLO_ON_MAIN = {
  state: '5594ca3356c23d7fc53c100c18e3d70784fcce360f47561d042384892341f97d',
  godsEye: 'f4737bfbcf8c9a2657877e9bc5039a5803d6b15c2ab8ab111064fecc8b6ea02a',
  view: '46390e70553bffaa030869371d8a10b5d1e57a85eef2a64777475bd7641962eb',
};

// The full per-guild views after the cleanup, recorded 08-10-26. Each shows the rival's home at full L2.
// ⤳ 09-10-26: now the views with `known`'s slots stripped (the full views are WITH_SLOTS, below).
const VIEWS_AFTER = {
  founded: {
    [A]: 'fd5a6f2a56c3077e993603d7e7ff0bf101d0cea04420923d2026be6a1551f19a',
    [B]: '366f9c2a2db703a61e5f4b242a5fdd5a56478512f73dd09cae39af3e37eca943',
  },
  licensed: {
    [A]: '4bc3c874ff47a7ebe590cfcb2287fc3afcd65d4e3e4fb8f169dd96377c51bd5e',
    [B]: 'eb99c723513cf77a74ed54537d2303d99af64a8d006d0ad590cdd255171f0d69',
  },
  closed: {
    [A]: '7a1a5ef253664205e24c39d29891013b270a0c858af3f262764d0c0bbf88d576',
    [B]: 'f9957f00e08b878b175bab62887ba08a1c7e6364b88dee79a23270a99f8b6bdf',
  },
};

// After the settlement-surface slice, recorded 09-10-26: the full states and per-guild views of the same steps.
const WITH_SLOTS = {
  founded: {
    state: '17bd81c6b49fe866b6dc5a0ef537bdc18cfe97f3434228a565e771b74d2b9907',
    [A]: '90c22f1284cb80229d466650ee887f13e6f7bcd06400ac50e3396f72f7bcdd5d',
    [B]: 'c609f3da53136fc361fa8291754f8bc465148172baed5f29734095a496aa6038',
  },
  licensed: {
    state: '83a16e83eade0ee2999fd74b8c518de14c52f2b6288a8f1790e0d222ac12fe33',
    [A]: 'a524eb9a45976cb8f4963cd3f032010681bbd42c80aeb38df6f3ebcb4adf03d0',
    [B]: 'db6455c7547bbbbbe7efbaddd44dd510a709aef2bcae3ca3109a031ab9770eb6',
  },
  closed: {
    state: '83e67fd7b22a5eb4a004439632264d74072e87cde55a669714548135c0b712bf',
    [A]: '3806582115fab26e9fdc9e1de316ca9846b2c92b5bf7065ab3c996c1f92c4473',
    [B]: 'a448b35c71e502c112825497e7e7c9a2b5c3e6d5f8ad9d3096c6c1f506602079',
  },
};
const SOLO_WITH_SLOTS = {
  state: 'aefc81a07b46dcc324feab31e491ab2804a903860720501dfdeb991dc7f04552',
  view: '5b0f1f075b1ae353376afd3c8350d9cc72ac9f16bf638b1187721a8c06c8d8ef',
};

// After the L0-board slice: the per-guild views of the same steps, with no `geography.systems`. Recorded on
// main at 348e0fc — BEFORE the slice — by deleting `geography.systems` from each view above (WITH_SLOTS,
// SOLO_WITH_SLOTS) and hashing the rest; the slim view must hash to exactly that. The states did not move.
const SLIM = {
  founded: {
    [A]: 'f2658bf6a9ee94a63072de5f653dd206849454f10a30e6cea62678f3175c1984',
    [B]: '2850d3478f17cb0c433a876a8b6d9e6f21dcb260e847b5694879b0c29c274e51',
  },
  licensed: {
    [A]: '27240ebcbabed36eb6d4a77232381604496a97280f9fcdbf9b66aec1ba8bbca7',
    [B]: '2f1bb82bf401a2aa936cf0b43bacabd49826126726c7087de248956fc3d0ee2b',
  },
  closed: {
    [A]: '6e64d180856789e09b850310b84ac39e412a70a40ad822d33e83e02625178efc',
    [B]: '4fb2ab699fe07f14f02aa4f128ce86e2b79ddb32b039a54f1f23b1fb2bd19541',
  },
};
const SOLO_SLIM = { view: 'f7b2873ba45b1dde1f7fca8d31ba1a50eb948bc0cc4aa6f46f3e8a01ca87b148' };

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
