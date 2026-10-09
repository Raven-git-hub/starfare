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

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

const { hashState, canonicalStringify } = require('../serialize.js');
const { buildSnapshot } = require('../snapshot.js');
const { checkInvariants } = require('../invariants.js');
const { getSite } = require('../seed.js');
const { reveal, isOnPublicRegister } = require('../exploration.js');
const {
  rivalLeakScript, soloScript, withoutRivalFacts, withoutRivalGround, A, B, B_PLANET, B_MINE,
} = require('./rival-leak-script.js');
const { stripRecordSlots, stripKnownSlots, withoutRecordSlots, withoutKnownSlots } = require('./slot-strip.js');

const sha = (text) => createHash('sha256').update(text).digest('hex');
const godsEye = (s) => sha(JSON.stringify(buildSnapshot(s)));
const viewOf = (s, guildId) => buildSnapshot(s, guildId);
const guildOf = (s, id) => s.guilds.find((g) => g.id === id);

// Recorded on main at 41fe84c — BEFORE the cleanup — by copying tests/rival-leak-script.js into a checkout of
// that commit and hashing each step: the state (hashState), the state with `withoutRivalFacts` applied, the
// god's-eye lens, and each guild's view with `withoutRivalGround` applied (JSON.stringify(buildSnapshot)).
const ON_MAIN = {
  founded: {
    state: '4e572f7161957d583aa2d9b2cc68531cb21e02cfd9b3c4fe2796ff5fa867ea0f',
    strippedState: '4e572f7161957d583aa2d9b2cc68531cb21e02cfd9b3c4fe2796ff5fa867ea0f',
    godsEye: '37a3bb70d1302b26dc84be8abee371a9186e1890285837423bc61a3fa114cacb',
    strippedView: {
      [A]: 'd1f535787dc737b9fab59edea5782572911a450f74ba4bb29201e55cae692e6b',
      [B]: '19d230e47a215efde776b5fc01645255179c9f662adc7b97c18e1dcff65d55cd',
    },
  },
  licensed: {
    state: '6d26ddbff123c72f9af14a2a51c117020dbb96049454d114eabad896b3a83047',
    strippedState: '0d6997b96b2a23604565d8f193ab73676206a264cab694e06465dbf92aea94df',
    godsEye: '13c710db9a97139e8cb4bc39a105446182f2c03e5cff1be5deb6ebd4586c16b5',
    strippedView: {
      [A]: 'f5ae44a0a499c8f0a39293ea95e5dbfc1874476582d396cd93fdaebdb8edc7d4',
      [B]: '4954ea8afacbacd4280975d37ca252e99353a8799fde8a05c080df11e0f82f7c',
    },
  },
  closed: {
    state: '1d6d0932dc2fb56760c53582d78cbbb80dc681a23c3ab11bfa61e81078914adb',
    strippedState: 'b49d13b37ad4358b12f6a1c85c391912ebc370fd4e424b3aa02627de7becfcc9',
    godsEye: '524adabb4e0c864932db484f39f700e38071d1b04dfbdd9bbf5facc8d95e8262',
    strippedView: {
      [A]: 'b68a00d46410a746bba60f5d7be42c34b3fa529264159798585a4c231e18c69c',
      [B]: 'ffe785c16db02683e0fe008fd8b1871345e6f5787f773899594c18b39cf71d09',
    },
  },
};
const SOLO_ON_MAIN = {
  state: 'd1db12533d22a4a44d943417fce6c6c5594c15ba26011ca837113c973ffa6628',
  godsEye: '0a254a27ea93bc5cb288c893fde01683991e6ea3f58d1db1f2310816c8efde45',
  view: '90263f25aeab8f245739b1af0bb79fa04a5b223c23d3f18f4857f08592c6fd9a',
};

// The full per-guild views after the cleanup, recorded 08-10-26. Each shows the rival's home at full L2.
// ⤳ 09-10-26: now the views with `known`'s slots stripped (the full views are WITH_SLOTS, below).
const VIEWS_AFTER = {
  founded: {
    [A]: 'e5a46a34c5ec407777319bb61c8b4199f325703d755784c4bbf99966b49ef357',
    [B]: 'a64c68f242603329cf0e32e535a45e36ac6c9de58b002fb180cd2bb250d0e9c0',
  },
  licensed: {
    [A]: '955ac16aff20f430763d678748ae8af34ccc6de8797e5c71f8032aef5265f5a5',
    [B]: 'c4c7a3ec96b74c48c5202e179de27c887b7259b828bd56706dfa2ec0200b3357',
  },
  closed: {
    [A]: 'e251b2dc3d1934de631ddfe79244b2dc9f55273d54bcc6bf7638a88dcd4f8f5b',
    [B]: 'c746bc737d9bf188a6ecbe878d1950e00cfbfb0651f78d068b54dec120486e6e',
  },
};

// After the settlement-surface slice, recorded 09-10-26: the full states and per-guild views of the same steps.
const WITH_SLOTS = {
  founded: {
    state: '3ae89a673a486d3aee5c03a5db1c69fd9bf3bd2b3d405a2d412ee3db0f09723f',
    [A]: '6b8db105242b9c21d9342e771ef9ece611b2ef4654d7cdf6505ea461c4f05977',
    [B]: 'af6b8da9a84e5bc56ee66ffc018af60e76cc810d57f36e26bc2500f832cf37c3',
  },
  licensed: {
    state: '938ea6d56d4d1399477a36e6f61928e0fc2b43d3c17c308ef3140f69a75ec9b4',
    [A]: '25b8017c1ff537ded356a28c68da5eba1bfc624eb552f422191f801f01c437dc',
    [B]: '6f77ee1d54199e98da3b366516fd67ec5ca7d29e9ffa4261935b3dcd5c1a0c52',
  },
  closed: {
    state: '6b4544ba0e4f7bb748665f46f76ef28a1c4b23aef60feabdb0447cf39aba48e2',
    [A]: '1ab98c78530f5e4dfb4bccac42c6d6d3e7af96f079bd36f17c200cc1adcbe6c3',
    [B]: '9ad15005f6ac40b22189a77274a77d8c90733a215958dda7fae871bbde4ced58',
  },
};
const SOLO_WITH_SLOTS = {
  state: '7333c71d21df5978325f771363febd5d3c192571766d5399cc0ad215f751a8a4',
  view: '11b09de4885497a9807eddbfbf39058dded47b724682adf09dbe423b87670ddb',
};

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
  assert.equal(hashState(stripRecordSlots(solo)), SOLO_ON_MAIN.state, 'no rival, so the removed step never wrote anything');
  assert.equal(godsEye(solo), SOLO_ON_MAIN.godsEye);
  assert.equal(sha(JSON.stringify(stripKnownSlots(viewOf(solo, A)))), SOLO_ON_MAIN.view,
    'the only controlled system is the home, which the founding record already holds in full');
  // The full bytes after the settlement-surface slice, and the slots really there (so the strips prove something).
  assert.equal(hashState(solo), SOLO_WITH_SLOTS.state);
  assert.equal(sha(JSON.stringify(viewOf(solo, A))), SOLO_WITH_SLOTS.view);
  assert.ok(withoutRecordSlots(solo).count > 0 && withoutKnownSlots(viewOf(solo, A)).count > 0);
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
      const noSlots = stripKnownSlots(view); // the settlement-surface slice's only delta, stripped
      assert.equal(sha(JSON.stringify(withoutRivalGround(noSlots))), pins.strippedView[guildId],
        `${guildId}'s view moved OUTSIDE rival-held ground at "${name}"`);
      assert.equal(sha(JSON.stringify(noSlots)), VIEWS_AFTER[name][guildId], `${guildId}'s view moved outside its slots at "${name}"`);
      assert.equal(sha(JSON.stringify(view)), WITH_SLOTS[name][guildId], `${guildId}'s full view moved at "${name}"`);
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
