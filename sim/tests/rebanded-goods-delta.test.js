'use strict';

// rebanded-goods-delta.test.js — the NO-OP PROOF of the Tier-3 RE-BANDS. Each re-band gives modules that had no
// sub-tier their ruled one (docs/phase-1-tuning.md "Tier-3 sub-tiers"), and each may move ONLY those goods' bytes:
//   - 16-10-26, the Prefecture / claims slice (roadmap 2.5; docs/territory-model.md §4, "AS-BUILT — engine PR 1"):
//     claim_beacon → 3-2, habitation_module → 3-3. That slice also touched paths every galaxy runs — the unload rule,
//     the arrival unload, the occupancy question every establish asks, the deploy rule — so for a galaxy that plants
//     no Prefecture, the only bytes allowed to move were those two goods' price rows.
//   - 02-11-26, droid engine slice 1 (roadmap 2.6; docs/droids.md §11, docs/phase-1-tuning.md §Droids):
//     drive_module → 3-2, droid_components → 3-2, and nothing else — so only those two goods' rows may move.
//
// The tripwires:
//   1. SINCE 79807db (before either re-band): two scripted runs — the Outpost deploy path (tests/outpost-deploy-script.js:
//      manual deploy, on-arrival deploy, on-arrival retreat, and every refusal) and the kit ferry + slot path
//      (tests/kit-ferry-script.js: an unload refused at an unheld system, an unload route home, a standalone unload, a
//      factory on a slot and the second establish refused) — hash, with ALL FOUR re-banded goods stripped
//      (tests/rebanded-goods-strip.js), to the digests RECORDED ON 79807db, for the state, the god's-eye lens and the
//      guild's own view. Their refusal texts match 79807db's exactly, unstripped.
//   2. SINCE 4bf6cbb (the commit before the droid re-band): the same two runs, with ONLY drive_module and
//      droid_components stripped, hash to the digests RECORDED ON 4bf6cbb — the droid re-band moved those two goods'
//      bytes and not one other.
//   3. EACH STRIP IS THE WHOLE DELTA, AND NOT VACUOUS: unstripped, the state DOES differ, and each strip refuses an
//      object missing any good it names.
//   4. THE RE-BANDS THEMSELVES: the four goods sit at their ruled bases in a fresh galaxy, and a galaxy STORED before
//      the droid re-band halts on its next tick (the fresh-galaxy requirement).
//
// HOW THE DIGESTS WERE RECORDED: both scripts and the strip use only APIs 79807db already had, so they were copied
// into a checkout of each old commit and run there; this branch gives the same digests.
//   - The 79807db pins were RE-RECORDED 02-11-26 with all four goods stripped. Until then the strip took only the
//     Prefecture pair, and the pins held drive_module and droid_components at their old band — which the droid
//     re-band moved. The re-recording method was checked first: on 79807db, stripping the Prefecture pair alone gives
//     back the old pins exactly. The refusal-text digests did not change.
//   - The 4bf6cbb pins were recorded 02-11-26 on a checkout of 4bf6cbb.
// At each re-pin the strip was also run over every digest the suite computes, on both commits, and they matched line
// for line (the 02-11-26 count is in docs/phase-1-tuning.md §Droids, AS-BUILT). Those golden-bearing files carry a
// note saying so; this file keeps a sample of that proof standing.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { hashState } = require('../serialize.js');
const { buildSnapshot: buildSnapshotWithDeepMaintenance } = require('../snapshot.js');
// Maintenance slice 4 added two derived snapshot keys (vehicle `craftMaintenance.earlyMaintenanceAllowed`, the owner's
// Outpost `maintenance`). Every lens in this file is read with exactly those keys taken out, so each pin below is
// still the one recorded before that slice — the proof they are its only delta (tests/deep-maintenance-strip.js).
const { withoutDeepMaintenanceReadout } = require('./deep-maintenance-strip.js');
const buildSnapshot = (...args) => withoutDeepMaintenanceReadout(buildSnapshotWithDeepMaintenance(...args));
// ⤳ 07-11-26: the droid batch-buy slice's one snapshot delta, stripped so the goldens below keep their old pins.
const { withoutDroidBatchQuote } = require('./droid-batch-quote-strip.js');
const { createZeroState } = require('../scenarios/zero-state.js');
const { advance } = require('../run.js');
const { checkInvariants } = require('../invariants.js');
const { withoutRebandedGoods, withoutDroidRebandGoods } = require('./rebanded-goods-strip.js');
const { withoutControlMap } = require('./control-map-strip.js');
const { outpostDeployScript } = require('./outpost-deploy-script.js');
const { kitFerryScript } = require('./kit-ferry-script.js');

// Recorded on 79807db — the state, god's-eye and own-view digests of each scripted step, ALL FOUR re-banded goods
// stripped; and the digest of each script's refusal texts, unstripped. (Re-recorded 02-11-26 — see the header.)
// RE-PINNED 10-11-26 (maintenance slice 2): main's (fbafbab) bytes for this script with every asset's maintenanceCondition deleted hash to exactly this — the field's removal is the only change.
// RE-PINNED 10-11-26 (maintenance slice 3): this script flies a craft, which now wears in flight. main's (bb1a9c5) bytes and these, each with every vehicle maintenanceCondition and the slice's added craftMaintenance / maintenanceCovered keys removed, hash identically — wear is the only change.
const RECORDED_ON_79807DB = {
  'outpostDeploy.manualDeploy': {
    state: 'a55c3c86d42d14c3cb360244a8484d6fd8375e8a370b650a108e2ad7e9d85050',
    godsEye: 'fec07eab387ca256577ef8cde95dbd84bbc8c1941236a8d5108acbe39856f42c',
    ownView: '9103ad80dad4ebfd78b9afa1b661911ffe20a047096de74411cca69af07bcce1',
  },
  'outpostDeploy.arrivalDeploy': {
    state: '5114fa24b6ffe0ad312bc5b261a38bd1fadfaf09676067ed3f98e7f7c360ac14',
    godsEye: 'c131d35cc07a9559253050f3aadf5bead1b476c72bafb042c6a5d07f43785344',
    ownView: 'c7106ede7adc8f9eb48ac2cfb7f41f34592b3bda1399861c7eb3b9a64c39151e',
  },
  'outpostDeploy.arrivalRetreat': {
    state: 'cc73b04e15d18d67e441df7d0b5855d96ca12dc12fae92b8b956ae3b2e96c1cc',
    godsEye: 'ce79592ca2b0d3922bdb3ace0aa7fd475012a91306abc577295c124ca6352dd6',
    ownView: 'df391fda8999b4ce331729ec6e2130ba87eb17a3a691028759802806c83e117a',
  },
  'outpostDeploy.reasons': 'a3972de8f1528acdf1a311e4351524e166918afd66c7862c396e2e6769e6188a',
  'kitFerry.unloadOnArrival': {
    state: 'e19e23fc5fbd812290974ab4297f67f6fcfe648468f9c9f1dc73df5eddb370f4',
    godsEye: 'da675cfd909b9798ca86ad858e41d2f28f583b8ee65b8dcd144bec948565df86',
    ownView: '03ce6b8d86db49be9cf9dfdc180c13bfa54abe38695a4e259ffd69fded6edb0b',
  },
  'kitFerry.standaloneUnload': {
    state: 'eec94a45c8132a75995dc808c7d68a16f7880b07d918a7d83b0cec28a0a77495',
    godsEye: '3a8c7a04a2e24f75de855639431c47d5b751b2c1b0b7c3f90048ac2a72558531',
    ownView: 'bb92099a8d840d45a996ceed7d0d56f92b80dec2776d37f43716bfccedc07e51',
  },
  'kitFerry.factoryOnSlot': {
    state: '747ca29d61ccb16388ac5f21800a6f38878126a6ef78c7aad44f753ef6fe92b1',
    godsEye: '70ae0c6a94b0598aa2834ef5b9d132bc7a3096b39993b18b0b06b2588ee1645b',
    ownView: '60efc4e84ba0db380d3e19df448c0fe4ebaab706476d94f0aeccbdd67d65e36c',
  },
  'kitFerry.reasons': 'ec7876192fdb623d0b087eb1cb4c2cddb591c63f8b69be551d66af6a32d6da3e',
};

// Recorded on 4bf6cbb — the same shape, with ONLY drive_module and droid_components stripped. (4bf6cbb already had the
// control map, so no control-map strip is needed against it.)
// RE-PINNED 10-11-26 (maintenance slice 2): main's (fbafbab) bytes for this script with every asset's maintenanceCondition deleted hash to exactly this — the field's removal is the only change.
// RE-PINNED 10-11-26 (maintenance slice 3): this script flies a craft, which now wears in flight. main's (bb1a9c5) bytes and these, each with every vehicle maintenanceCondition and the slice's added craftMaintenance / maintenanceCovered keys removed, hash identically — wear is the only change.
const RECORDED_ON_4BF6CBB = {
  'outpostDeploy.manualDeploy': {
    state: '635673c3077795daebf00c75ce82ec525d4661efb47ad4ebed6386e4df725a80',
    godsEye: '9daece521171ad93a1e9cb0163b76ff91481e8cb2a607db5c8b5de2bfdca6ace',
    ownView: '51980133b226d71e5ab332308cbbe9ff784817128476627121bcfeec920a2ba2',
  },
  'outpostDeploy.arrivalDeploy': {
    state: '0875ab1e649ecf6f3e511169b5a955752e0449f17c98eb89ad49b4d1d0f2aa63',
    godsEye: 'f12e87cf36e3dc3247858d60d359aeae89566f4726566ac2943d357cb882ff54',
    ownView: '11ffaba306170c2b9ac9eb9a2ded8faf0647e44a7f5430cfa72dd28d1a962be3',
  },
  'outpostDeploy.arrivalRetreat': {
    state: '0c1333e11818a4a770a5b42e644d4b6a511efc2a186422b0dbc746a9f47a7847',
    godsEye: 'd05434c7e8d6642b2edb759a2e3c0ce86285749190d3ede91a39d141b58e9747',
    ownView: '3f206a56c3ee4a6342b24c0db695f42bf345803e8d74ffe0d532a3e0e3585519',
  },
  'outpostDeploy.reasons': 'a3972de8f1528acdf1a311e4351524e166918afd66c7862c396e2e6769e6188a',
  'kitFerry.unloadOnArrival': {
    state: 'f572bf89c43ed287a61833fadff4c228160ccc993cec7208ab326b7f9d9ba670',
    godsEye: 'b2e16bedcabe438e4f1a1f4bcd366facf7cbc5bbdbd1224be10018a8af8b9be2',
    ownView: '82a3984133f7743d42ebbd2d861d289c2ca42379bacd5f847337c0ce2795ab76',
  },
  'kitFerry.standaloneUnload': {
    state: '267cdd3e80f3a9efbf23b3ee56821761d6ae2b3f232f019a9b7dfa3894c355d2',
    godsEye: '3551b1aa7188fb793fba4bcec575278320f9ee50666983634068dcc171abee1e',
    ownView: '6c976a21dfc8d192b7d0e38fb7b32068e9c209e18772903a598a0be94a860769',
  },
  'kitFerry.factoryOnSlot': {
    state: '42bc4b9987beecc963d7ec2f89c9ff310168310ffa7569290cf6e69803d5801f',
    godsEye: 'baf2d225ee9d20cfa189f036c47814297e1d2f778ea343f9525c4c976f20b839',
    ownView: '54aed4c94699ae47cdcf8750fecc2bec81ddb9b3f4663c28748652f5b87607bb',
  },
  'kitFerry.reasons': 'ec7876192fdb623d0b087eb1cb4c2cddb591c63f8b69be551d66af6a32d6da3e',
};

// The kit-ferry factory-on-slot state's digest on 4bf6cbb, UNSTRIPPED — so the non-vacuity check below compares the
// whole state with the whole state, not a stripped hash with an unstripped one.
const FACTORY_ON_SLOT_UNSTRIPPED_ON_4BF6CBB = 'b3e68ef537ddd97e7fb2f31d2e46bf95c510450ebab0ca32f627318d6c1fd7a4';

// digestsOf(name, run, strip, stripSnapshot) -> the same shape as the RECORDED_ON_* tables, for one script's run on
// this branch. `strip` takes the re-banded goods out of a state; `stripSnapshot` out of a snapshot or view.
function digestsOf(name, run, strip, stripSnapshot) {
  const out = {};
  for (const [step, s] of Object.entries(run.steps)) {
    out[`${name}.${step}`] = {
      state: hashState(strip(s)),
      godsEye: hashState(stripSnapshot(withoutDroidBatchQuote(buildSnapshot(s)))),
      ownView: hashState(stripSnapshot(withoutDroidBatchQuote(buildSnapshot(s, s.guilds[0].id)))),
    };
  }
  out[`${name}.reasons`] = hashState(run.reasons);
  return out;
}

// Against 79807db: all four goods out, and — ⤳ 16-10-26 (the Prefecture / claims slice, engine PR 2) — the control
// map too (tests/control-map-strip.js): every snapshot and view gained the public `controlMap` after 79807db and
// nothing else moved, so the pins still stand.
const since79807db = (name, run) => digestsOf(name, run, withoutRebandedGoods,
  (snap) => withoutRebandedGoods(withoutControlMap(snap)));
// Against 4bf6cbb: the droid pair out, and nothing else.
const since4bf6cbb = (name, run) => digestsOf(name, run, withoutDroidRebandGoods, withoutDroidRebandGoods);

// --- 1. since 79807db: the pre-Prefecture paths, byte for byte ------------------------------------------------------

test('the Outpost deploy path is 79807db\'s bytes, the four re-banded goods aside — state, god\'s-eye, own view and every refusal', () => {
  const got = since79807db('outpostDeploy', outpostDeployScript());
  for (const key of Object.keys(got)) {
    assert.deepEqual(got[key], RECORDED_ON_79807DB[key], `${key} moved`);
  }
});

test('the kit ferry and slot paths are 79807db\'s bytes, the four re-banded goods aside — unload refused away, unload on arrival, unload by hand, a factory on a slot', () => {
  const run = kitFerryScript();
  const got = since79807db('kitFerry', run);
  for (const key of Object.keys(got)) {
    assert.deepEqual(got[key], RECORDED_ON_79807DB[key], `${key} moved`);
  }
  // The refusals the digest covers, spelled out so a reader sees what the script asked.
  assert.match(run.reasons.unloadAtUnheld.reason, /does not hold system .* — a kit unloads only into a system its guild holds/);
  assert.match(run.reasons.unloadRouteToUnheld.reason, /^the unload at waypoint 0 would fail now — /);
  assert.match(run.reasons.secondOnSlot.reason, /is already occupied by venture/);
});

// --- 2. since 4bf6cbb: the droid re-band moved only drive_module and droid_components ------------------------------

test('the droid re-band moved ONLY drive_module and droid_components: the Outpost deploy path is 4bf6cbb\'s bytes with those two stripped', () => {
  const got = since4bf6cbb('outpostDeploy', outpostDeployScript());
  for (const key of Object.keys(got)) {
    assert.deepEqual(got[key], RECORDED_ON_4BF6CBB[key], `${key} moved`);
  }
});

test('the droid re-band moved ONLY drive_module and droid_components: the kit ferry and slot paths are 4bf6cbb\'s bytes with those two stripped', () => {
  const got = since4bf6cbb('kitFerry', kitFerryScript());
  for (const key of Object.keys(got)) {
    assert.deepEqual(got[key], RECORDED_ON_4BF6CBB[key], `${key} moved`);
  }
});

// --- 3. each strip is the whole delta, and not vacuous --------------------------------------------------------------

test('unstripped, the state DOES differ from 79807db and from 4bf6cbb — the strips are what make it match, so they are not no-ops', () => {
  const s = kitFerryScript().steps.factoryOnSlot;
  assert.notEqual(hashState(s), RECORDED_ON_79807DB['kitFerry.factoryOnSlot'].state, 'the four goods\' price rows really moved');
  assert.notEqual(hashState(s), FACTORY_ON_SLOT_UNSTRIPPED_ON_4BF6CBB, 'the droid pair\'s price rows really moved since 4bf6cbb');
  for (const good of ['claim_beacon', 'habitation_module', 'drive_module', 'droid_components']) {
    assert.ok(s.prices[good] !== undefined, `the state carries ${good}'s price`);
  }
  // A strip that finds nothing — or misses any good it names — refuses, naming what it missed.
  assert.throws(() => withoutRebandedGoods({ tick: 0, prices: { titanium: 1 } }), /would prove nothing/);
  assert.throws(() => withoutDroidRebandGoods({ tick: 0, prices: { titanium: 1 } }), /no drive_module \/ droid_components key/);
  assert.throws(() => withoutDroidRebandGoods({ prices: { drive_module: 1 } }), /no droid_components key/);
  assert.throws(() => withoutRebandedGoods({ prices: { drive_module: 1, droid_components: 1 } }), /no claim_beacon \/ habitation_module key/);
});

// --- 4. the re-bands themselves -------------------------------------------------------------------------------------

test('a fresh galaxy seeds claim_beacon at the 3-2 base (1,000) and habitation_module at the 3-3 base (10,000)', () => {
  const s = createZeroState();
  assert.equal(s.prices.claim_beacon.posted, 1000);
  assert.equal(s.prices.habitation_module.posted, 10000);
});

test('a fresh galaxy seeds drive_module and droid_components at the 3-2 base (1,000) — they were on 100 until 02-11-26', () => {
  const s = createZeroState();
  for (const good of ['drive_module', 'droid_components']) {
    assert.deepEqual(s.prices[good], { posted: 1000, pending: [1000, 1000] }, `${good}'s price row`);
    assert.deepEqual(s.priceRing[good], [1000], `${good}'s quote-lock ring`);
  }
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('FRESH GALAXY REQUIRED: a galaxy stored before the droid re-band halts on its next tick — its old rows sit below the 3-2 floor', () => {
  // Stored price rows are NOT migrated. A galaxy created on 4bf6cbb stored these two goods on the old unclassified
  // band, posted 100 with a pipeline of 100s (recorded on 4bf6cbb). The 3-2 floor is 200, so the very next step the
  // engine takes trips the price invariant and HALTS, naming the tick, the good and its value — rather than quietly
  // running a market below its own floor. That is why this change needs a fresh galaxy.
  const stored = JSON.parse(JSON.stringify(createZeroState()));
  for (const good of ['drive_module', 'droid_components']) {
    stored.prices[good] = { posted: 100, pending: [100, 100] };
    stored.priceRing[good] = [100];
  }
  assert.throws(() => advance(stored), (err) =>
    /Invariant violation at tick 1/.test(err.message)
    && /"where": "prices\.drive_module\.posted"/.test(err.message)
    && /"where": "prices\.droid_components\.posted"/.test(err.message)
    && /"value": 100,\s+"floor": 200,\s+"ceiling": 100000/.test(err.message));
  // A fresh galaxy, by contrast, takes the same step cleanly.
  assert.equal(advance(createZeroState()).state.tick, 1);
});
