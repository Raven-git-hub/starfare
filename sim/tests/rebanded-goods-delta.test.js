'use strict';

// rebanded-goods-delta.test.js — the Prefecture / claims slice's NO-OP PROOF (roadmap 2.5; docs/territory-model.md §4,
// "AS-BUILT — engine PR 1"). The slice touched paths every galaxy runs — the unload rule, the arrival unload, the
// occupancy question every establish asks, the deploy rule — and re-banded two Tier-3 modules. For a galaxy that
// plants no Prefecture, the only bytes allowed to move are those two goods' price rows.
//
// The tripwires:
//   1. THE PRE-SLICE PATHS, BYTE FOR BYTE: two scripted runs — the Outpost deploy path (tests/outpost-deploy-script.js:
//      manual deploy, on-arrival deploy, on-arrival retreat, and every refusal) and the kit ferry + slot path
//      (tests/kit-ferry-script.js: an unload refused at an unheld system, an unload route home, a standalone unload, a
//      factory on a slot and the second establish refused) — hash, with the two re-banded goods stripped
//      (tests/rebanded-goods-strip.js), to the digests RECORDED ON 79807db (the commit before the slice), for the state,
//      the god's-eye lens and the guild's own view. Their refusal texts match 79807db's exactly, unstripped.
//   2. THE STRIP IS THE WHOLE DELTA, AND NOT VACUOUS: unstripped, the state DOES differ (the two goods' prices did
//      move), and the strip refuses an object with nothing to take out.
//   3. THE RE-BAND ITSELF: the two goods sit at their ruled bases in a fresh galaxy — 1,000 and 10,000.
//
// HOW THE DIGESTS WERE RECORDED: both scripts and the strip use only APIs 79807db already had, so they were copied into
// a checkout of 79807db and run there; this branch gives the same digests. (At the re-pin, the same strip was also run
// over EVERY digest the sixteen golden-bearing test files compute — 41,958 of them — on both commits, and they matched
// line for line. Those files carry a note saying so; this file keeps a sample of that proof standing.)

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { hashState } = require('../serialize.js');
const { buildSnapshot } = require('../snapshot.js');
const { createZeroState } = require('../scenarios/zero-state.js');
const { withoutRebandedGoods } = require('./rebanded-goods-strip.js');
const { withoutControlMap } = require('./control-map-strip.js');
const { outpostDeployScript } = require('./outpost-deploy-script.js');
const { kitFerryScript } = require('./kit-ferry-script.js');

// Recorded on 79807db — the state, god's-eye and own-view digests of each scripted step, the two goods stripped; and the
// digest of each script's refusal texts, unstripped.
const RECORDED_ON_79807DB = {
  'outpostDeploy.manualDeploy': {
    state: 'af17a58dee61a833f95b1e8c22e93d4575125e4a94c9eed5e879496bbb476be3',
    godsEye: '66bb119e67026cf0552c6ad9f45daf6cb85d96eedadd6b26e2600007ffc860db',
    ownView: 'f4b70b358dd6253db1120a5466e9ad85b42b71a0fb9125345be6cf6531196389',
  },
  'outpostDeploy.arrivalDeploy': {
    state: '16c7ef6c7615ec55f25d2f68a8878335db73fbbd28a5511fd753b796209d8ea9',
    godsEye: '35ea6db8bdaaceef6e2b3e33b7610838f285c47f5cf6283509c1cfe6280a057c',
    ownView: 'df58cef1e22468b15c63dffe34a875ebc793d50fcb286b003535fd58c8678231',
  },
  'outpostDeploy.arrivalRetreat': {
    state: '4604d415f09ab96dedd22140ab6ade6010bdd62360e7715a46cf98d3b31518eb',
    godsEye: 'ad731deb6346030d2b57e4fe332cfaaccd1599f32413d2b171e0910b1b1a3f36',
    ownView: '9c2b5d0cd49d422b516434fc8ab8731b4ef25847db95eb2750d44a750d499702',
  },
  'outpostDeploy.reasons': 'a3972de8f1528acdf1a311e4351524e166918afd66c7862c396e2e6769e6188a',
  'kitFerry.unloadOnArrival': {
    state: '2266f8e5e3a5cc757959322b3f4b64d674e6cf2a18e2cd49b4a1f1023c722eb2',
    godsEye: 'ee0a9ecf38b1f59e3af530e010257a19115178bec39cbceb0cfb3053cb780db7',
    ownView: '3d3a54d81670ee10f562b89331140c3a8e649d5a9690ad261c35411fc5656720',
  },
  'kitFerry.standaloneUnload': {
    state: 'e2f7610fd44336b1510d1cbc5a7bbe26727afc38e9fcd0c8366b14dbc5fea95f',
    godsEye: 'a94b83cdc8b4d5de6dd749c6e7bedfea8f51d7bb00ff1ac09d3c9d94b3617156',
    ownView: 'c77e762ed02bc2b4df75f5fe427a99b8a63b3b06b17d55b0c6afd6512ed4ad8b',
  },
  'kitFerry.factoryOnSlot': {
    state: 'f085580b8bb4d08fdd6c25c21a6eca4345266b01693d96a395d8086a3051bbfe',
    godsEye: '9074c32f893c6b81ba9a5388e43ee094750e8bb6754f389425132604efbb69fa',
    ownView: 'dbc25fef8012962e978471dbcd188230507854566387467d0c7004b24fc39401',
  },
  'kitFerry.reasons': 'ec7876192fdb623d0b087eb1cb4c2cddb591c63f8b69be551d66af6a32d6da3e',
};

// digestsOf(name, run) -> the same shape as RECORDED_ON_79807DB, for one script's run on this branch.
function digestsOf(name, run) {
  const out = {};
  for (const [step, s] of Object.entries(run.steps)) {
    out[`${name}.${step}`] = {
      state: hashState(withoutRebandedGoods(s)),
      // ⤳ 16-10-26 (the Prefecture / claims slice, engine PR 2): and through the control-map strip (tests/control-map-strip.js)
      // — every snapshot and view gained the public `controlMap` and nothing else moved, so the pins still stand.
      godsEye: hashState(withoutRebandedGoods(withoutControlMap(buildSnapshot(s)))),
      ownView: hashState(withoutRebandedGoods(withoutControlMap(buildSnapshot(s, s.guilds[0].id)))),
    };
  }
  out[`${name}.reasons`] = hashState(run.reasons);
  return out;
}

// --- 1. the pre-slice paths, byte for byte ------------------------------------------------------------------------

test('the Outpost deploy path is 79807db\'s bytes, the two re-banded goods aside — state, god\'s-eye, own view and every refusal', () => {
  const got = digestsOf('outpostDeploy', outpostDeployScript());
  for (const key of Object.keys(got)) {
    assert.deepEqual(got[key], RECORDED_ON_79807DB[key], `${key} moved`);
  }
});

test('the kit ferry and slot paths are 79807db\'s bytes, the two re-banded goods aside — unload refused away, unload on arrival, unload by hand, a factory on a slot', () => {
  const run = kitFerryScript();
  const got = digestsOf('kitFerry', run);
  for (const key of Object.keys(got)) {
    assert.deepEqual(got[key], RECORDED_ON_79807DB[key], `${key} moved`);
  }
  // The refusals the digest covers, spelled out so a reader sees what the script asked.
  assert.match(run.reasons.unloadAtUnheld.reason, /does not hold system .* — a kit unloads only into a system its guild holds/);
  assert.match(run.reasons.unloadRouteToUnheld.reason, /^the unload at waypoint 0 would fail now — /);
  assert.match(run.reasons.secondOnSlot.reason, /is already occupied by venture/);
});

// --- 2. the strip is the whole delta, and not vacuous -------------------------------------------------------------

test('unstripped, the state DOES differ from 79807db — the strip is what makes it match, so it is not a no-op', () => {
  const s = kitFerryScript().steps.factoryOnSlot;
  assert.notEqual(hashState(s), RECORDED_ON_79807DB['kitFerry.factoryOnSlot'].state, 'the two goods\' price rows really moved');
  assert.ok(s.prices.claim_beacon !== undefined && s.prices.habitation_module !== undefined, 'the state carries both goods\' prices');
  assert.throws(() => withoutRebandedGoods({ tick: 0, prices: { titanium: 1 } }), /would prove nothing/);
});

// --- 3. the re-band itself ----------------------------------------------------------------------------------------

test('a fresh galaxy seeds claim_beacon at the 3-2 base (1,000) and habitation_module at the 3-3 base (10,000)', () => {
  const s = createZeroState();
  assert.equal(s.prices.claim_beacon.posted, 1000);
  assert.equal(s.prices.habitation_module.posted, 10000);
});
