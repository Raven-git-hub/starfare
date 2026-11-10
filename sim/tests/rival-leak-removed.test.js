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
const { buildSnapshot: buildSnapshotWithDeepMaintenance } = require('../snapshot.js');
// Maintenance slice 4 added two derived snapshot keys (vehicle `craftMaintenance.earlyMaintenanceAllowed`, the owner's
// Outpost `maintenance`). Every lens in this file is read with exactly those keys taken out, so each pin below is
// still the one recorded before that slice — the proof they are its only delta (tests/deep-maintenance-strip.js).
const { withoutDeepMaintenanceReadout } = require('./deep-maintenance-strip.js');
const buildSnapshot = (...args) => withoutDeepMaintenanceReadout(buildSnapshotWithDeepMaintenance(...args));
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
// RE-PINNED 10-11-26 (maintenance slice 2): main's (fbafbab) bytes for this script with every asset's maintenanceCondition deleted hash to exactly this — the field's removal is the only change.
// RE-PINNED 10-11-26 (maintenance slice 3): this script flies a craft, which now wears in flight. main's (bb1a9c5) bytes and these, each with every vehicle maintenanceCondition and the slice's added craftMaintenance / maintenanceCovered keys removed, hash identically — wear is the only change.
const ON_MAIN = {
  founded: {
    state: '801034143340e86024112907f6cdc564cb62bb4c80dbf3ea0997405725313b1b',
    strippedState: '801034143340e86024112907f6cdc564cb62bb4c80dbf3ea0997405725313b1b',
    godsEye: '72110db1e1e7e3f314dd0facc25c99d18549eb0a2d07daedf7ce20f35c661490',
    strippedView: {
      [A]: '500af5f3da7b6f24753651273ff307b5d7853fdee4cb25a041f8c24072617137',
      [B]: '745c3cfe694878ece1e7acaedf75fd74814f29eacdf4c7c1cfc8121e1e0ce9ab',
    },
  },
  licensed: {
    state: '09101b2fed9ba81bed401dc63fedab56a85ceeb5b98ca0bc40d754f7f9f37ae9',
    strippedState: '36b022e8ca6b35d7e60dc47409e721039c7e586b9913cbb80351b1dab31ed2c7',
    godsEye: '302f2c230c92021eea81f736264de127e24b99a15fef627f08e01bbf27799385',
    strippedView: {
      [A]: 'b8b355476c1b3ddcb7d199ed2fb9bbeaf1d686e1add90253416a973d096fb356',
      [B]: 'ea58724896d21e43cb02a50bc81363548a1bcacaa7c99ba8965ccb8f0c5f3659',
    },
  },
  closed: {
    state: '4f9cd1f2e4e6c6c502d66d7d2d85961f37a5decd080dbfbc3f5be07e5a324825',
    strippedState: '0eaa0ec3f85d163ce088c0972cf18a8483ae732f72653fffd26eeefe5027093f',
    godsEye: '9d2c977a1f6ba5cd18afb9c0549c0cddf7e07f9ed05b233bafe659df42dab601',
    strippedView: {
      [A]: 'd690dfa1879b84cda023939e7791c0f106a8fd94e95b37c20614150a8ad0bda1',
      [B]: '855e47f581beaeceb59d01e1f0606335b2b818bd56364debf65953b2cdf74f22',
    },
  },
};
// RE-PINNED 10-11-26 (maintenance slice 2): main's (fbafbab) bytes for this script with every asset's maintenanceCondition deleted hash to exactly this — the field's removal is the only change.
// RE-PINNED 10-11-26 (maintenance slice 3): this script flies a craft, which now wears in flight. main's (bb1a9c5) bytes and these, each with every vehicle maintenanceCondition and the slice's added craftMaintenance / maintenanceCovered keys removed, hash identically — wear is the only change.
const SOLO_ON_MAIN = {
  state: '14c1d81dbc60b84c7faa38cd22329f8db680745999f89a24ce9107c91c986d71',
  godsEye: '7d1c8b87fd80400ac053dc58cb188564a248f1aaf6437e24ceda4a1c2f1b66f8',
  view: '8ec906ab8e7e31b8c739797dcc50c00639e784a8e1f072c511d3a7e094d7350d',
};

// The full per-guild views after the cleanup, recorded 08-10-26. Each shows the rival's home at full L2.
// ⤳ 09-10-26: now the views with `known`'s slots stripped (the full views are WITH_SLOTS, below).
// RE-PINNED 10-11-26 (maintenance slice 2): main's (fbafbab) bytes for this script with every asset's maintenanceCondition deleted hash to exactly this — the field's removal is the only change.
// RE-PINNED 10-11-26 (maintenance slice 3): this script flies a craft, which now wears in flight. main's (bb1a9c5) bytes and these, each with every vehicle maintenanceCondition and the slice's added craftMaintenance / maintenanceCovered keys removed, hash identically — wear is the only change.
const VIEWS_AFTER = {
  founded: {
    [A]: '361a096f7481c2db4b11f7f60d341a1d8b3892b3b769bda71f2aa6d20b734b61',
    [B]: 'bb8f44a1d09560c84464d97ed2abe8b234af4bb42842cd97c0c616588eb49bc3',
  },
  licensed: {
    [A]: '07bdc3b1de1e964d40aff7b4693f1f8a65e9a69659ca0eaf00450078ed1f0d68',
    [B]: '52299bb42a4910adf33a36f47da5087ae16d2aa82dc75c5600c3f66b3268c27f',
  },
  closed: {
    [A]: '2f6b787749f20e4b3c2c031333c2fb31a08ff9669279379fde75b20216d080cc',
    [B]: 'e714957817dd93200edacbd4d7daf24467aa8066d10c04d644bde1635667dcbb',
  },
};

// After the settlement-surface slice, recorded 09-10-26: the full states and per-guild views of the same steps.
// RE-PINNED 10-11-26 (maintenance slice 2): main's (fbafbab) bytes for this script with every asset's maintenanceCondition deleted hash to exactly this — the field's removal is the only change.
// RE-PINNED 10-11-26 (maintenance slice 3): this script flies a craft, which now wears in flight. main's (bb1a9c5) bytes and these, each with every vehicle maintenanceCondition and the slice's added craftMaintenance / maintenanceCovered keys removed, hash identically — wear is the only change.
const WITH_SLOTS = {
  founded: {
    state: 'd49df18eb6c2e7c7f85bd179d5053457d0ad5b97f2a17c99ddbea1419e9f3de8',
    [A]: '62d6b5fc5fdeed55530d1e31cf0df4e0aaba2fef955b809053ab7aefa71fa174',
    [B]: '614a3be89b2c42f5dac22885fe7c8f02e02f3c4308db169b786991c2d70ecbfc',
  },
  licensed: {
    state: '5610106e1a36f363f17d8d0b10d97e61772e3e1ef506318560a1748cee4c08f7',
    [A]: '2bac5bc05a4485b39e82c8dc54b22f6e214f1839b027f14b740432f7c4cae5b5',
    [B]: 'addeb8581f1731d588b299c163b740250c013e6867c713de38a3dcc7550012d6',
  },
  closed: {
    state: '0a9bc688d77686403f0fa37331cf1e7bff5b18d24b5404e860841440953eb7ab',
    [A]: '422903e2d8286781596dcad7af41993d0bb240d7f95965a550fb1f1aa2a97fde',
    [B]: 'f19843492ecb873df019a364c05b3e00ef751e881ee943ccbe9e771018af339c',
  },
};
// RE-PINNED 10-11-26 (maintenance slice 2): main's (fbafbab) bytes for this script with every asset's maintenanceCondition deleted hash to exactly this — the field's removal is the only change.
// RE-PINNED 10-11-26 (maintenance slice 3): this script flies a craft, which now wears in flight. main's (bb1a9c5) bytes and these, each with every vehicle maintenanceCondition and the slice's added craftMaintenance / maintenanceCovered keys removed, hash identically — wear is the only change.
const SOLO_WITH_SLOTS = {
  state: '49c6a794f7df6a47c6e29c9ee674abe7485f42a68400be8c33edf10b3e1fbe95',
  view: 'c149a2789a148e21ad8ef8bb42b4efde6183087adcaf4bdd11948ce6d9ccbc9d',
};

// After the L0-board slice: the per-guild views of the same steps, with no `geography.systems`. Recorded on
// main at 348e0fc — BEFORE the slice — by deleting `geography.systems` from each view above (WITH_SLOTS,
// SOLO_WITH_SLOTS) and hashing the rest; the slim view must hash to exactly that. The states did not move.
// RE-PINNED 10-11-26 (maintenance slice 2): main's (fbafbab) bytes for this script with every asset's maintenanceCondition deleted hash to exactly this — the field's removal is the only change.
// RE-PINNED 10-11-26 (maintenance slice 3): this script flies a craft, which now wears in flight. main's (bb1a9c5) bytes and these, each with every vehicle maintenanceCondition and the slice's added craftMaintenance / maintenanceCovered keys removed, hash identically — wear is the only change.
const SLIM = {
  founded: {
    [A]: '5507cc47cd049543074e31f8b6115588389e0116be0bd394094039dbfcd1c844',
    [B]: '9d0683ab5c8119180298f09c9cc4fa21684e8b903b3e6764f96508693abfd42c',
  },
  licensed: {
    [A]: 'ae537b61d4f1507b2616a02fc0a4676d71af4ab82e9657e68f4a4e405f46162b',
    [B]: 'e4f003f1e590fd01d61ddb4006a6e13abadbf571a64dc875fd0d2c7ae7946840',
  },
  closed: {
    [A]: '46aa48b508e00c7960ba93d0167d7322fc4887310093f612c1f680a7711c866b',
    [B]: 'fddddd5b1cbf38d0b975f744d8be518bfe852f5b9fe6bbce3515706df9883c02',
  },
};
// RE-PINNED 10-11-26 (maintenance slice 2): main's (fbafbab) bytes for this script with every asset's maintenanceCondition deleted hash to exactly this — the field's removal is the only change.
// RE-PINNED 10-11-26 (maintenance slice 3): this script flies a craft, which now wears in flight. main's (bb1a9c5) bytes and these, each with every vehicle maintenanceCondition and the slice's added craftMaintenance / maintenanceCovered keys removed, hash identically — wear is the only change.
const SOLO_SLIM = { view: '1fed0d640616a8570f555923eef255b28d38822830152e74d2c536e084820063' };

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
