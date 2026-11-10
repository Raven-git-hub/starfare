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
const { buildSnapshot } = require('../snapshot.js');
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
const RECORDED_ON_79807DB = {
  'outpostDeploy.manualDeploy': {
    state: '0e0ec661e53c3d98db0414899dffbdb4f46e130b55ecaaa589b9348f6ecb71ad',
    godsEye: 'a386fc5c6324d73bfa74574b6aba64f03215b96658a90f80bf0960b9ae8fa25a',
    ownView: 'a835026c5bd7a38a1465120933058909c285e179368b7375275d96a3c422342b',
  },
  'outpostDeploy.arrivalDeploy': {
    state: 'f5228944f745fbda31d90c14d42cd096d30ff514b41075b47057d1f5d1b76510',
    godsEye: '89842e82fcedf669a6057860e512809e375b141ce889716acc2d5a287a68e49e',
    ownView: '5eed634b45734bc0350064c12f21bff100abbecd5745bd5ba7e2d1a644ad8141',
  },
  'outpostDeploy.arrivalRetreat': {
    state: '8bcdcb8e6f49912304a899e28ccf492c5b02362213ccd4cd375e5dabb0acd64c',
    godsEye: '190290343a3e22fd394fdf0d4fe05f76ce3075bcfba1e8da0f99b06b69c43d4d',
    ownView: '092bb11ec2ef30876fa90592e7e33da4ef6d7c292e68fa56d6861c99b0b57b0e',
  },
  'outpostDeploy.reasons': 'a3972de8f1528acdf1a311e4351524e166918afd66c7862c396e2e6769e6188a',
  'kitFerry.unloadOnArrival': {
    state: '23024dde12de9bd0585924bb851a3e07119eb620f06fcb27876804373a49a3bc',
    godsEye: '494bd7a9b6f13090700ccdfa4ea597511da52e4567810ce5dec70e487ea2cbfd',
    ownView: '07d7f7837ef00fd4a8e570a525e5ad0a8d4c1ed6529eca2704db0bf32d32af12',
  },
  'kitFerry.standaloneUnload': {
    state: 'b4037354ef1433fee1e330785b091706240de8ed85e0fc2fae4404c0ef2bd17d',
    godsEye: '19f39c6caee72bb9ec9570ed794b101ee473a2077f069e974b4a53e1ca29c5ec',
    ownView: '7b679130e42a2927e8c142ed2e29b5c58bd42a01e69a7d3c3c9f7f56f866ea48',
  },
  'kitFerry.factoryOnSlot': {
    state: '5c9cf5989ee2b6fb13acb87fdbbd743e097d594af3b3d27a707de63a4da1fce2',
    godsEye: '47559b3768c9e8181a0a1a54d0f95cf85b2440ee3c1f9335482f9700b15b9751',
    ownView: 'ed7d4f75aa8d5f6bf5b8948eebf7bedb5e66ea201278bed0cdd3cf2d30c16ec7',
  },
  'kitFerry.reasons': 'ec7876192fdb623d0b087eb1cb4c2cddb591c63f8b69be551d66af6a32d6da3e',
};

// Recorded on 4bf6cbb — the same shape, with ONLY drive_module and droid_components stripped. (4bf6cbb already had the
// control map, so no control-map strip is needed against it.)
// RE-PINNED 10-11-26 (maintenance slice 2): main's (fbafbab) bytes for this script with every asset's maintenanceCondition deleted hash to exactly this — the field's removal is the only change.
const RECORDED_ON_4BF6CBB = {
  'outpostDeploy.manualDeploy': {
    state: '9fc5e6c47783d779f7b0774df18e6c83a6b00eb852eff4da8b4eabc8f44c64bc',
    godsEye: '9d47aff72383b62f4ec1eb54fadfbf39a042cc01f4379418c8e5361e3bc5e240',
    ownView: '8668f4bc0bdf3514440fd81798c567349a4e0a90be501f7a3178a6471f795161',
  },
  'outpostDeploy.arrivalDeploy': {
    state: 'f7927e9d6cf8112308e343bd2ff80034da8ae329fec23571fc637e82bd96c990',
    godsEye: '9e851ab4f72a916ac4b5b32b58228ab77e460f2bb64ea96f9cc2663e123059b8',
    ownView: 'f08395b6b6df3d4eb45424338902b9eea1bc84e6fed773a41eaadd592fa0dd3a',
  },
  'outpostDeploy.arrivalRetreat': {
    state: 'fb006023deb2d58c96f06fd887918cc7b20793f231928e5c77ebe1b193092869',
    godsEye: '821c3e5384356d3a587d1c3bbccaadf315f36acf0b561978463732fab61a80e2',
    ownView: 'f12f616bc060c9df70b99d208b1052e4c04aadd812931c7d0d7575394b06ee4a',
  },
  'outpostDeploy.reasons': 'a3972de8f1528acdf1a311e4351524e166918afd66c7862c396e2e6769e6188a',
  'kitFerry.unloadOnArrival': {
    state: '52a5138660f26f064401481102f94b5a982eac160195466044464af786df6b5c',
    godsEye: '90b9cebae59d9d0d84b468e998026cf1ef21ae4132e282da169cc6874c2008e0',
    ownView: '94d58578707428464ea1d50e490e315630ee805a61a62c55fa07af60da0a96dd',
  },
  'kitFerry.standaloneUnload': {
    state: '9961596b2bbabb0c44494dae60d9c3b603d2c362900f02589435cd983d27ffd5',
    godsEye: '7afb8423960b1dd5761ca09e93f8ad8c2f6abc3182de0ff64c49662b92977332',
    ownView: '8d0a7820b3b178681935318ca204c720e163163750cc7f538ceb35332dd91de5',
  },
  'kitFerry.factoryOnSlot': {
    state: '830d7b916ece97076bd25d549e9840a2006bd147bacdf86f7499c6929ee9b36f',
    godsEye: '399020acbbd67043df80b1e5895ae7b764df8889ac200e21e55d4b75797fc07e',
    ownView: '53737bc469d18371a9184e9ae4e74de710c28dfcc60927d83729deac65b9b320',
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
