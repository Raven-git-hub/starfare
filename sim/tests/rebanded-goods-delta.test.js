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
const { createZeroState } = require('../scenarios/zero-state.js');
const { advance } = require('../run.js');
const { checkInvariants } = require('../invariants.js');
const { withoutRebandedGoods, withoutDroidRebandGoods } = require('./rebanded-goods-strip.js');
const { withoutControlMap } = require('./control-map-strip.js');
const { outpostDeployScript } = require('./outpost-deploy-script.js');
const { kitFerryScript } = require('./kit-ferry-script.js');

// Recorded on 79807db — the state, god's-eye and own-view digests of each scripted step, ALL FOUR re-banded goods
// stripped; and the digest of each script's refusal texts, unstripped. (Re-recorded 02-11-26 — see the header.)
const RECORDED_ON_79807DB = {
  'outpostDeploy.manualDeploy': {
    state: 'bde62c668b5ca69678095d699705236b00b27acee6076221856b73fa983c467d',
    godsEye: '16c0b942164d8412cefd5e49448f6d41cf75406f3aee5e06b4c36743c6b2e4d0',
    ownView: 'c6b0a936f5c8cf6ec9ab3658a80b7e6c2a3e1eccda7fe23f131dfc2cd67849d1',
  },
  'outpostDeploy.arrivalDeploy': {
    state: 'b0faf28b06a6e7e7f4de4ed79d917dcddd249391c3ff6b435ce959a91c433077',
    godsEye: '26877ccfe870fdd79a6cfd038669d20a935d720f506d5c5505132fa8c5d8ca4d',
    ownView: '5e2fddc9c0d544d493adfe4b70f8183dd75580ace75fd24c53ea08203fea83a4',
  },
  'outpostDeploy.arrivalRetreat': {
    state: 'ac9578a9e8a602cc4763890290484e4abb3568c3defc1d13b8ba35bffd285d1e',
    godsEye: '84342ae3ccf5f48c5b7400587f4abead9947f81e7f7fa860d2b4039b4a17a062',
    ownView: 'cb17ae416cc98afe0ec86069ed6de37272221ddb66f69a259a225d8759b26bc5',
  },
  'outpostDeploy.reasons': 'a3972de8f1528acdf1a311e4351524e166918afd66c7862c396e2e6769e6188a',
  'kitFerry.unloadOnArrival': {
    state: '6d84fc3f735d08e65a9724d3c6d2f6efa116cae9c853d507a2ad4b25f07d1ad4',
    godsEye: '22566b6608d5bac42e809d2570a6e5a97f61d5d61de33521dbda7655bea88e64',
    ownView: '62a49b0383fa3f3ff598e77443611ad867e5ae4d0e0b23ee0d51f454f266dd52',
  },
  'kitFerry.standaloneUnload': {
    state: '9c57369db0afd6acc00f2a52f9339f96cdc3c0d604b07368f837fcc6649c6000',
    godsEye: 'ab6fcc0eac2123fc7fe9983306916abf9a409564bea1556d65237b4335f0b0d2',
    ownView: '7f356aa11e9eff8af6d26a8f06d339658c1c5cbb5ca4e4a8d5af33643af1f3c8',
  },
  'kitFerry.factoryOnSlot': {
    state: '5ddff71429ef65af359f062a61c2c0fe09222fc24913c3850329625603f090a4',
    godsEye: '05369c8c99aef8ab1718c6095bb5b20232114762a33c75cf3c2ecebb18c7e093',
    ownView: 'a2a5586616a56cc2e9cd5132347a2bcf34e70eb3cead8ab4800a1a72ee1f3da8',
  },
  'kitFerry.reasons': 'ec7876192fdb623d0b087eb1cb4c2cddb591c63f8b69be551d66af6a32d6da3e',
};

// Recorded on 4bf6cbb — the same shape, with ONLY drive_module and droid_components stripped. (4bf6cbb already had the
// control map, so no control-map strip is needed against it.)
const RECORDED_ON_4BF6CBB = {
  'outpostDeploy.manualDeploy': {
    state: 'cd74e4d073474522bdf8427083b94abd8bd4d80d980fdfd8a959a6cb72c6f989',
    godsEye: 'e1d796ebbbf1f18741cdf68078b20d1ba0e0c902ee1cbbd5b3bc51ed98633293',
    ownView: '418ce091d10c01147c468d18cb889e665b64cecd24a969dce51baeefe8184958',
  },
  'outpostDeploy.arrivalDeploy': {
    state: '4601a59b9b6338da60ff87d571ff17fe5ca582a3675ce41bd77801f393f12368',
    godsEye: '5bd1fb45103bf624bdb80e9702318465daba4356e423cc8ab5347c717e257aba',
    ownView: 'b9a72fd8668af3ac1d745a903a9e4dda859c9e7ad0ad5ef0dea53923bf07ada2',
  },
  'outpostDeploy.arrivalRetreat': {
    state: 'e8fc7ce294d083b23e421c9dd4dc683272dbde5054d6218b318f7d7d3d49bc8c',
    godsEye: '3147d0bdbc6d1dcf63d22eb5a384a3dbde2f2aead8f6630640a6bcc779b7083c',
    ownView: 'f46e3674a913c7e9fc33971afb2a98a37d20af6fbe53eb7a2d7c3016a96ed822',
  },
  'outpostDeploy.reasons': 'a3972de8f1528acdf1a311e4351524e166918afd66c7862c396e2e6769e6188a',
  'kitFerry.unloadOnArrival': {
    state: '0c9972461b21dad2e036571430ea35ad95efdf75acd0ac06fd8d492a73f0fff3',
    godsEye: '81848f9f862ff838e280c16c00fb1f0c5111121a5d70ced6139354f2b2a6addb',
    ownView: '800cc0fe6dcbde0e37a004d9f17fb6b96a2c253bf4bc57b0685f4a60e1dfa5fe',
  },
  'kitFerry.standaloneUnload': {
    state: '7dab64b4db6303e2b4209ee5dd9729870394743143c3ac3efbe5c00c61b767d9',
    godsEye: '78c0309b44d127993a1e906145cf311895e5a970b14df226c3f3c61350f54d73',
    ownView: '005ada7a53b94b45496f5a194cc119ac3f38bc74a5ca3480c860bfeeba1006b4',
  },
  'kitFerry.factoryOnSlot': {
    state: '3d2e8d9ec3f9cbe5d27201e3ae0046d2b841f895540514962ebf293b937909b2',
    godsEye: 'c615cbc1ab41e126aada3ae195f8b9b8bc66bbe46feb9f7701c28d40d007ceb8',
    ownView: '399df3e948bb0eb1c2d0aefc078c71c2edc149d287bb8cc62bb6a5b1645675ec',
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
      godsEye: hashState(stripSnapshot(buildSnapshot(s))),
      ownView: hashState(stripSnapshot(buildSnapshot(s, s.guilds[0].id))),
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
