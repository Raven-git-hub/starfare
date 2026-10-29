'use strict';

// losing-ground-ops-client.test.js — losing ground, client slice 2: the read-state (roadmap 2.5; docs/operations-hub.md
// §4 / §5, docs/territory-model.md §4, docs/transport-model.md §11.6, docs/event-log.md §2). The engine already
// publishes three consequences of a loss on the player's own rows, and the client hid or mis-worded each:
//   - a machine left STRANDED (`asset.stranded = { tick }`) listed in Operations → IDLE as an ordinary idle machine —
//     and IDLE's rebuild signature (id@systemId) did not move when the flag came or went, because an eviction and a
//     salvage load both keep the machine's id and system;
//   - a lane ended because its stop's system was lost (`laneEnded.reason: 'system-lost'`) printed the raw reason in the
//     IN TRANSIT strip — and, since that lane ends while the craft is still flying its leg, "stopped at Unknown";
//   - a venture an eviction closed (`venture_closed`, cause `evicted`) read "You closed this venture."
// Client only. As losing-ground-notice-client.test.js does, this runs the page's OWN code in a node:vm sandbox with a
// stub DOM, against REAL per-guild snapshots, each exactly as GET /snapshot?guild= sends it:
//   - inPlace() (below): an abandon of a system where g1 had only idle things, so the machine and the kit there are
//     stranded in place; then the salvage run's load, which clears the machine's flag in place;
//   - reach() (below): eviction-reach-script.js's galaxy, plus one lane whose Outpost stop is torn down (a real
//     `target-gone`), then abandoned on the same tick (real `system-lost` lanes, g1's and g2's);
//   - sweep-script.js: g1's evicted ventures' real `venture_closed` notices, and g2's inherited machines.
// The live panel in the browser is the Playwright harness's, outside the repo.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { buildSnapshot } = require('../snapshot.js');
const { getSystem } = require('../seed.js');
const {
  createAbandonPrefectureAction, createLoadAssetAction, createGrantKitAction, createSpawnVehicleAction,
  createDispatchRouteWithActionsAction, createRemoveOutpostAction,
} = require('../actions.js');
const { LIGHT_TRANSPORT } = require('../vehicles.js');
const P = require('./prefecture-fixtures.js');
const S = require('./sweep-script.js');
const R = require('./eviction-reach-script.js');
const seed = require('../../data/seed.json');

const ROOT = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'client', 'game.html'), 'utf8');

// This slice's words, verbatim from game.html. Draft copy, to be tuned (roadmap checklist).
const STRANDED_MARK = 'Stranded · awaiting salvage';
const SYSTEM_LOST_WHY = 'a stop\'s system was lost';
const EVICTED_BODY = 'This venture was closed because the system it stood in was lost.';
// main's words, unchanged.
const TARGET_GONE_WHY = 'a stop\'s store is gone';
const LOCKOUT = " Its node stays held under the Syndicate's lockout — no one may re-establish there until the term clears.";

// ---- the page's own code, cut out of game.html -----------------------------------------------------------

function cut(src, re, what) {
  const m = src.match(re);
  assert.ok(m, `${what} is present in game.html`);
  return m;
}
const kitKindsSrc = cut(html, /<script id="kit-kinds">([\s\S]*?)<\/script>/, 'the kit-kinds script')[1];
// ⤳ losing ground client slice 4: a stranded machine's IDLE row asks the deploy popup's carrier list
// (window.__carriersFor) whether to offer Salvage, so the hub runs beside that popup's script, as on the page.
const deployWireSrc = cut(html, /<script id="deploy-kit-wire">([\s\S]*?)<\/script>/, 'the deploy popup script')[1];
// The Operations hub's whole script, without its IIFE wrapper — so its own functions and its state `O` land at the
// sandbox's top level, to be called and read directly.
const opsSrc = cut(html, /<script id="operations-tab-wire">\n\(function\(\)\{\n([\s\S]*?)\n\}\)\(\);\n<\/script>/, 'the Operations script')[1];
const guildScript = html.slice(html.indexOf('<script id="guild-tab-wire">'));
const guildHelpersSrc = cut(guildScript, /\n {2}function el\(id\)\{[\s\S]*?(?=\n {2}function pad4\()/, 'the Guild Hall helpers (el … esc)')[0];
const prettyGoodSrc = cut(guildScript, /\n {2}function prettyGood\(g\)\{[^\n]*\n/, 'the Guild Hall prettyGood')[0];
const noticeSrc = cut(guildScript, /\n {2}\/\/ --- Notices \(docs\/event-log\.md §9[\s\S]*?(?=\n {2}function centreFor\()/, 'the notice code')[0];

// IDLE's rebuild signature as main had it (at d353816), and as this slice has it — the mutation test swaps one for
// the other, to show main's would never redraw.
const MAIN_SIG = "var sig = idle.map(function(a){ return a.id + '@' + a.systemId; }).sort().join('|');";
const NEW_SIG = 'var sig = idleSignature(idle);';

// ---- real engine output ------------------------------------------------------------------------------------

const { TARGET } = P;
const TARGET_NAME = getSystem(TARGET).name;
const TARGET_HEX = getSystem(TARGET).coords;

// inPlace() -> g1 holds HOME and TARGET (sweep-script.js's planted(): its heavy is berthed at TARGET, empty), with an
// idle miner at HOME, and an idle miner and an idle Outpost kit at TARGET — no venture there. Three states of it:
//   held     — nothing lost yet;
//   stranded — g1 abandons TARGET: the miner and the kit there gain `stranded` IN PLACE — the same id, the same
//              system, still idle — so main's signature (id@systemId) does not move;
//   loaded   — the heavy loads the stranded miner (the salvage run's load): its flag goes, again in place.
//   reclaimed — ⤳ losing ground client slice 4: from `stranded`, g1 re-plants TARGET instead. Its own stranded miner and
//              kit are recovered, their flags cleared in place (same id, same system, still idle). Since slice 4 a
//              loaded machine leaves IDLE (it is aboard), so this is the in-place clear left for main's signature to miss.
function inPlace() {
  let s = S.planted();
  let homeMiner; let miner;
  ({ s, id: homeMiner } = S.grantMachine(s, 'g1', 'miner', P.HOME.id));
  ({ s, id: miner } = S.grantMachine(s, 'g1', 'miner', TARGET));
  s = P.accept(s, createGrantKitAction({ guildId: 'g1', systemId: TARGET, kind: 'outpost' }));
  const kit = S.guildOf(s, 'g1').assets.find((a) => a.kind === 'outpost').id;
  const held = s;
  const stranded = P.accept(held, S.abandon());
  const loaded = P.accept(stranded, createLoadAssetAction({ guildId: 'g1', vehicleId: P.HEAVY, assetId: miner }));
  const { s: kitIn, kitId: flag } = P.grantPrefectureKit(stranded, 'g1', TARGET);
  const reclaimed = P.accept(kitIn, P.plant('g1', flag, P.SLOT_A1));
  return { held, stranded, loaded, reclaimed, homeMiner, miner, kit };
}
const IN_PLACE = inPlace();

// reach() -> eviction-reach-script.js's galaxy, plus one more g1 lane: a light craft from HOME docking at the Outpost
// inside TARGET's disk (by its hex, as an Outpost stop is anchored) and back. The operator removes that Outpost at
// once, so the craft flies out to a bare hex and its lane ends there — a real `target-gone`. Two states of it:
//   pre  — that ending, before anything is lost;
//   lost — g1 abandons TARGET on the same tick: every lane with a stop at TARGET ends `system-lost` — g1's `stop`
//          and g2's `rivalStop`, both still flying their leg — beside the target-gone one.
function reach() {
  let { s, craft, outpost } = R.reachGalaxy();
  s = P.accept(s, createSpawnVehicleAction({ guildId: 'g1', class: LIGHT_TRANSPORT, location: P.AT_HOME }));
  const gone = S.guildOf(s, 'g1').vehicles.slice(-1)[0].id;
  s = P.accept(s, createDispatchRouteWithActionsAction({ guildId: 'g1', vehicleId: gone, repeat: { mode: 'continuous' }, waypoints: [
    { anchor: R.OUTPOST_HEX, action: { type: 'dock', manifest: [{ dir: 'load', good: 'titanium', max: true }] } },
    { anchor: P.AT_HOME, action: { type: 'dock', manifest: [{ dir: 'unload', good: 'titanium', max: true }] } },
  ] }));
  s = P.accept(s, createRemoveOutpostAction({ guildId: 'g1', outpostId: outpost }));
  s = P.tickUntil(s, (st) => !S.guildOf(st, 'g1').vehicles.find((v) => v.id === gone).route);
  const pre = s;
  const lost = P.accept(pre, createAbandonPrefectureAction({ guildId: 'g1', prefectureId: S.PREFECTURE }));
  return { pre, lost, stop: craft.stop, rivalStop: craft.rivalStop, gone };
}
const REACH = reach();

// sweep-script.js's fallow() — g1 abandons a built-up TARGET — then g2 plants there and sweeps what was left.
const SWEPT = (() => {
  const f = S.fallow();
  let { s, rivalKit } = S.rivalReady(f.s);
  s = P.accept(s, S.rivalPlant(rivalKit));
  return { fallow: f.s, s };
})();

// The view exactly as the browser receives it.
const viewOf = (s, guildId) => JSON.parse(JSON.stringify(buildSnapshot(s, guildId)));
const meOf = (snap, guildId) => snap.guilds.find((g) => g.id === guildId);
const sha = (x) => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const num = (id) => String(id).split('_').slice(-1)[0];
const count = (s, sub) => s.split(sub).length - 1;
const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// ---- the Operations hub, on a stub DOM ---------------------------------------------------------------------

// The board's name for a hex, as the shell's __landmarkNameAt reads it: a system on it, else a seed waystation.
function landmarkNameAt(q, r) {
  const on = (x) => x.coords && x.coords.q === q && x.coords.r === r;
  const hit = seed.systems.find(on) || seed.outposts.find(on);
  return hit ? hit.name : null;
}
const OPS_HOSTS = ['ops-lane-notices', 'ops-transit-list', 'ops-deployed-list', 'ops-idle-list', 'ops-tp-list'];

// opsPage(snapshot, guildId, src) -> the Operations hub's code (or a mutated copy, `src`) running for the player
// `guildId`, on a stub DOM that counts each host's innerHTML writes. `open()` opens the hub on `snapshot`, `poll(next)`
// is the shell's next poll on a new snapshot, `html(id)` what a host shows now.
function opsPage(snapshot, guildId, src = opsSrc) {
  let current = snapshot;
  const nodes = {};
  const writes = {};
  const node = (id) => {
    if (!nodes[id]) {
      let inner = '';
      writes[id] = 0;
      nodes[id] = {
        id,
        get innerHTML() { return inner; },
        set innerHTML(v) { inner = v; writes[id] += 1; },
        querySelectorAll: () => [],
        addEventListener() {},
      };
    }
    return nodes[id];
  };
  const sandbox = {
    document: { getElementById: node, addEventListener() {} },
    window: {
      __player: () => ({ guildId }),
      __snapshot: () => current,
      __systemName: (id) => (getSystem(id) ? getSystem(id).name : id),
      __outpostName: (id) => id,
      __landmarkNameAt: landmarkNameAt,
    },
  };
  vm.runInNewContext(kitKindsSrc + src, sandbox);
  vm.runInNewContext(deployWireSrc, sandbox);
  return {
    page: sandbox,
    open: () => sandbox.window.__opsOpen(),
    poll: (next) => { current = next; sandbox.window.__opsRefresh(); },
    html: (id) => node(id).innerHTML,
    writes: (id) => writes[id] || 0,
    hub: () => Object.fromEntries(OPS_HOSTS.map((id) => [id, node(id).innerHTML])),
  };
}

// The notice popup, as losing-ground-notice-client.test.js drives it (its stub DOM, trimmed to what the body needs).
function noticePage(snapshot, guildId) {
  const nodes = {};
  const sandbox = {
    document: { getElementById: (id) => nodes[id] || (nodes[id] = {
      id, textContent: '', innerHTML: '', style: {}, hidden: false,
      classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    }) },
    window: {
      __player: () => ({ guildId }),
      __snapshot: () => snapshot,
      __sendAction: () => Promise.resolve({ accepted: true }),
      __refreshNow: () => Promise.resolve(),
    },
  };
  vm.runInNewContext(kitKindsSrc + guildHelpersSrc + prettyGoodSrc + noticeSrc, sandbox);
  const paragraphs = () => [...sandbox.document.getElementById('noticeBody').innerHTML.matchAll(/<p>([^<]*)<\/p>/g)].map((m) => unescape(m[1]));
  return { page: sandbox, paragraphs };
}

// ---- 1. IDLE: the stranded marker --------------------------------------------------------------------------

// One IDLE row as machineHtml draws it: main's row, byte for byte, for an ordinary machine (a kit's ends on its Deploy
// button); a stranded one adds the marker as its last line, under the id, the kind and any button.
const ordinaryRow = (id, kind) => `<div class="ops-idle-machine"><span class="mid">${id}</span><span class="mkind">${kind}</span></div>`;
const strandedRow = (id, kind, button = '') => `<div class="ops-idle-machine stranded"><span class="mid">${id}</span>`
  + `<span class="mkind">${kind}</span>${button}<span class="mstranded">${STRANDED_MARK}</span></div>`;
const deployButton = (id) => `<button class="ops-idle-deploy" type="button" data-kit-deploy="${id}">Deploy</button>`;
// ⤳ losing ground client slice 4: a stranded MACHINE's row carries Salvage — live when a heavy that could take it is
// in its system (g1's heavy is berthed at TARGET here), disabled when none is (salvage-client.test.js proves the gate).
const salvageButton = (id) => `<button class="ops-idle-deploy ops-idle-salvage" type="button" data-salvage="${id}">Salvage</button>`;
const salvageNoHeavy = '<button class="ops-idle-deploy ops-idle-salvage" type="button" disabled title="No empty, idle heavy transport is berthed in this system">Salvage</button>';
const HOME_NAME = getSystem(P.HOME.id).name;
// idleGroups(idleHtml) -> { systemName: the html of that system's IDLE group }.
function idleGroups(idleHtml) {
  return Object.fromEntries(idleHtml.split('<div class="ops-idle-sys"').slice(1)
    .map((g) => [g.match(/<span class="nm">([^<]*)<\/span>/)[1], g]));
}

test('IDLE: a machine or kit left stranded is marked awaiting salvage, in the system it was lost in; an ordinary one is not', () => {
  const { homeMiner, miner, kit } = IN_PLACE;
  const snap = viewOf(IN_PLACE.stranded, 'g1');
  const row = (id) => meOf(snap, 'g1').assets.find((a) => a.id === id);
  const flag = { tick: IN_PLACE.stranded.tick };
  assert.deepEqual([row(miner).stranded, row(kit).stranded], [flag, flag], 'premise: the eviction flagged both');
  assert.equal('stranded' in row(homeMiner), false, 'premise: the home miner is not flagged');
  assert.equal((snap.claims || []).some((c) => c.landmarkId === TARGET), false, 'premise: nobody holds TARGET now');
  const p = opsPage(snap, 'g1');
  p.open();
  const groups = idleGroups(p.html('ops-idle-list'));
  assert.deepEqual(Object.keys(groups).sort(), [HOME_NAME, TARGET_NAME].sort());
  // TARGET's group: both rows marked. The kit keeps its Deploy: a stranded kit loads as any kit does. (⤳ slice 4: the
  // miner now carries Salvage, live, as g1's heavy is berthed at TARGET.)
  assert.ok(groups[TARGET_NAME].includes(strandedRow(miner, 'miner', salvageButton(miner))), 'the stranded miner');
  assert.ok(groups[TARGET_NAME].includes(strandedRow(kit, 'Outpost kit', deployButton(kit))), 'the stranded kit');
  assert.equal(count(groups[TARGET_NAME], STRANDED_MARK), 2);
  // HOME's group: main's row, unmarked.
  assert.ok(groups[HOME_NAME].includes(ordinaryRow(homeMiner, 'miner')), 'the home miner, as main drew it');
  assert.equal(count(groups[HOME_NAME], STRANDED_MARK), 0);
});

test('IDLE reads the flag, never the ground: no flag means no marker in a fallow system; a flag marks a held one too', () => {
  const snap = viewOf(IN_PLACE.stranded, 'g1');
  const assets = meOf(snap, 'g1').assets;
  delete assets.find((a) => a.id === IN_PLACE.miner).stranded;            // in TARGET, which nobody holds
  assets.find((a) => a.id === IN_PLACE.homeMiner).stranded = { tick: 1 }; // at HOME, which g1 holds
  const p = opsPage(snap, 'g1');
  p.open();
  const groups = idleGroups(p.html('ops-idle-list'));
  assert.ok(groups[TARGET_NAME].includes(ordinaryRow(IN_PLACE.miner, 'miner')));
  // (⤳ slice 4: a flagged machine carries Salvage — disabled here, as no heavy is berthed at HOME.)
  assert.ok(groups[HOME_NAME].includes(strandedRow(IN_PLACE.homeMiner, 'miner', salvageNoHeavy)));
});

// ---- 2. IDLE: the rebuild signature ------------------------------------------------------------------------

test('IDLE redraws when a machine gains or loses the flag in place, which main\'s signature never saw', () => {
  const [held, stranded, loaded] = ['held', 'stranded', 'loaded'].map((k) => viewOf(IN_PLACE[k], 'g1'));
  // The bug's premise: an eviction and a salvage load each keep every idle row's id and system, so main's signature
  // (id@systemId) is one string across all three.
  const mainSig = (snap) => meOf(snap, 'g1').assets.filter((a) => a.deployedToVentureId == null)
    .map((a) => `${a.id}@${a.systemId}`).sort().join('|');
  assert.equal(mainSig(stranded), mainSig(held));
  assert.equal(mainSig(loaded), mainSig(stranded));
  const aboard = meOf(loaded, 'g1').assets.find((a) => a.id === IN_PLACE.miner);
  assert.deepEqual([aboard.systemId, 'stranded' in aboard, aboard.inTransitOnVehicleId], [TARGET, false, P.HEAVY],
    'premise: the load cleared the flag and kept the system');

  // This slice: one open hub, polled through all three. The markers come with the abandon, and the miner's goes
  // with the load (the kit's stays). A poll that changes nothing still writes nothing.
  const p = opsPage(held, 'g1');
  p.open();
  const marks = () => count(p.html('ops-idle-list'), STRANDED_MARK);
  assert.equal(marks(), 0);
  p.poll(stranded);
  assert.equal(marks(), 2, 'the miner and the kit, marked on the poll after the abandon');
  p.poll(loaded);
  assert.equal(marks(), 1, 'the miner\'s marker gone on the poll after the load; the kit still stranded');
  // (⤳ slice 4: the loaded miner is aboard the heavy, so it has left IDLE altogether, not stayed on as an unmarked row.)
  assert.equal(p.html('ops-idle-list').includes(IN_PLACE.miner), false);
  const writes = p.writes('ops-idle-list');
  p.poll(loaded);
  assert.equal(p.writes('ops-idle-list'), writes, 'the guard still guards: an unchanged poll rebuilds nothing');
  const sigs = [held, stranded, loaded].map((snap) => p.page.idleSignature(p.page.myIdle(meOf(snap, 'g1'))));
  assert.equal(new Set(sigs).size, 3, 'the signature carries the flag: three states, three strings');

  // main's signature put back: the same hub never redraws, so the flag never shows, and a stale marker never goes.
  assert.ok(opsSrc.includes(NEW_SIG), 'the signature line this test swaps is there');
  const mainSrc = opsSrc.replace(NEW_SIG, MAIN_SIG);
  const m = opsPage(held, 'g1', mainSrc);
  m.open();
  m.poll(stranded);
  assert.equal(count(m.html('ops-idle-list'), STRANDED_MARK), 0, 'main\'s signature: the abandon never reaches IDLE');
  // (⤳ slice 4: a load now moves any signature, as the miner leaves the list. The owner's re-plant clears both flags in
  // place, keeping every id and system, so it stands in for the load: this slice's signature sees it, main's does not.)
  const reclaimed = viewOf(IN_PLACE.reclaimed, 'g1');
  assert.equal(mainSig(reclaimed), mainSig(stranded), 'premise: the re-plant keeps every idle row\'s id and system');
  const r = opsPage(stranded, 'g1');
  r.open();
  r.poll(reclaimed);
  assert.equal(count(r.html('ops-idle-list'), STRANDED_MARK), 0, 'the markers gone on the poll after the re-plant');
  const n = opsPage(stranded, 'g1', mainSrc);
  n.open();
  n.poll(reclaimed);
  assert.equal(count(n.html('ops-idle-list'), STRANDED_MARK), 2, 'main\'s signature: the recovered machines keep stale markers');
});

test('IDLE after the sweep: the swept machines leave the former owner\'s list and land, unmarked, in the planter\'s', () => {
  const p = opsPage(viewOf(SWEPT.fallow, 'g1'), 'g1');
  p.open();
  assert.equal(count(idleGroups(p.html('ops-idle-list'))[TARGET_NAME], STRANDED_MARK), 4, 'premise: the abandon stranded g1\'s four');
  p.poll(viewOf(SWEPT.s, 'g1'));
  assert.equal(TARGET_NAME in idleGroups(p.html('ops-idle-list')), false, 'gone from g1\'s IDLE on the poll after the sweep');
  const g2 = opsPage(viewOf(SWEPT.s, 'g2'), 'g2');
  g2.open();
  const target = idleGroups(g2.html('ops-idle-list'))[TARGET_NAME];
  assert.equal(count(target, '<div class="ops-idle-machine'), 4, 'g2 lists the four it inherited');
  assert.equal(count(target, STRANDED_MARK), 0, 'as ordinary idle machines: the re-mint carries no flag');
});

// ---- 3. IN TRANSIT: the ended-lane strip -------------------------------------------------------------------

// One ended-lane notice, as renderLaneNotices draws it.
const laneNotice = (craftId, tick, where, why) => '<div class="ops-notice">'
  + `<span class="msg">Light #${num(craftId)}'s lane stopped at ${where} — ${why}.</span>`
  + `<button class="ops-notice-x" type="button" data-ended-x="${craftId}@${tick}" title="Dismiss">&#10005;</button>`
  + '</div>';
const craftIn = (snap, guildId, id) => meOf(snap, guildId).vehicles.find((v) => v.id === id);

test('IN TRANSIT: a system-lost lane reads in words, naming where its craft lands; a target-gone lane keeps main\'s words', () => {
  const g1 = viewOf(REACH.lost, 'g1');
  const stop = craftIn(g1, 'g1', REACH.stop);
  const gone = craftIn(g1, 'g1', REACH.gone);
  const tick = REACH.lost.tick;
  // Off the engine's own rows: the system-lost craft is still FLYING its leg, bound for TARGET's centre, so it has no
  // `location` (why main read "Unknown"); the target-gone craft is idle at the bare hex it reached.
  assert.deepEqual(stop.laneEnded, { reason: 'system-lost', tick });
  assert.deepEqual([stop.status, stop.location, stop.trip.legs.slice(-1)[0].to], ['inTransit', undefined, TARGET_HEX]);
  assert.deepEqual([gone.laneEnded.reason, gone.status], ['target-gone', 'idle']);
  const p = opsPage(g1, 'g1');
  p.open();
  assert.equal(p.html('ops-lane-notices'),
    laneNotice(REACH.stop, tick, TARGET_NAME, SYSTEM_LOST_WHY)
    + laneNotice(REACH.gone, gone.laneEnded.tick, `(${gone.location.q}, ${gone.location.r})`, TARGET_GONE_WHY));
  assert.doesNotMatch(p.html('ops-lane-notices'), /system-lost|Unknown|null|undefined/);

  // g2's lane only turned at TARGET. It ends there too, in the same words.
  const g2 = viewOf(REACH.lost, 'g2');
  assert.deepEqual(craftIn(g2, 'g2', REACH.rivalStop).laneEnded, { reason: 'system-lost', tick });
  const q = opsPage(g2, 'g2');
  q.open();
  assert.equal(q.html('ops-lane-notices'), laneNotice(REACH.rivalStop, tick, TARGET_NAME, SYSTEM_LOST_WHY));
});

test('IN TRANSIT: once the craft lands the words hold, and the strip is not redrawn', () => {
  const landed = P.tickUntil(REACH.lost, (st) => S.guildOf(st, 'g1').vehicles.find((v) => v.id === REACH.stop).status === 'idle');
  const after = viewOf(landed, 'g1');
  const stop = craftIn(after, 'g1', REACH.stop);
  assert.deepEqual([stop.location, stop.laneEnded.reason], [P.AT_TARGET, 'system-lost'], 'premise: idle at TARGET, still flagged');
  const fresh = opsPage(after, 'g1');
  fresh.open();
  assert.ok(fresh.html('ops-lane-notices').includes(`Light #${num(REACH.stop)}'s lane stopped at ${TARGET_NAME} — ${SYSTEM_LOST_WHY}.`));
  // A hub open since the loss, polled across the landing: the same endings, so the strip is left alone — and it
  // already reads what a fresh page drawn after the landing reads.
  const p = opsPage(viewOf(REACH.lost, 'g1'), 'g1');
  p.open();
  const writes = p.writes('ops-lane-notices');
  p.poll(after);
  assert.equal(p.writes('ops-lane-notices'), writes);
  assert.equal(p.html('ops-lane-notices'), fresh.html('ops-lane-notices'));
});

test('IN TRANSIT: a leg ending on a bare hex reads its hex, and redraws once landed; else main\'s fallbacks hold', () => {
  const g1 = viewOf(REACH.lost, 'g1');
  const stop = craftIn(g1, 'g1', REACH.stop);
  const bare = { q: R.CROSS_A.q, r: R.CROSS_A.r }; // no landmark names it
  stop.trip.legs.slice(-1)[0].to = { ...bare };
  const p = opsPage(g1, 'g1');
  p.open();
  assert.ok(p.html('ops-lane-notices').includes(`stopped at Deep Space (${bare.q}, ${bare.r}) — ${SYSTEM_LOST_WHY}.`), 'in flight, the IN TRANSIT row\'s words');
  // Landed there: an idle craft at a bare hex reads "(q, r)", as main read one. The words changed, so the strip redraws.
  const before = p.writes('ops-lane-notices');
  delete stop.trip;
  Object.assign(stop, { status: 'idle', location: { ...bare } });
  p.poll(g1);
  assert.equal(p.writes('ops-lane-notices'), before + 1);
  assert.ok(p.html('ops-lane-notices').includes(`stopped at (${bare.q}, ${bare.r}) — ${SYSTEM_LOST_WHY}.`));
  // Neither a trip nor a location, and a reason the client has no words for: main's fallbacks, unchanged.
  delete stop.location;
  stop.laneEnded = { reason: 'some-later-reason', tick: stop.laneEnded.tick + 1 };
  p.poll(g1);
  assert.ok(p.html('ops-lane-notices').includes('stopped at Unknown — some-later-reason.'));
  assert.doesNotMatch(p.html('ops-lane-notices'), /null|undefined/);
});

// ---- 4. MESSAGES: the evicted venture ----------------------------------------------------------------------

test('venture_closed, evicted: the closure says its system was lost, not that the player closed it; the lockout line still rides', () => {
  const snap = viewOf(SWEPT.s, 'g1');
  const closures = meOf(snap, 'g1').events.filter((e) => e.type === 'venture_closed');
  assert.deepEqual(closures.map((e) => e.payload.cause), ['evicted', 'evicted'], 'premise: the abandon closed the mine and the refinery, cause evicted');
  assert.equal(closures.filter((e) => e.payload.lockoutUntilTick != null).length, 1, 'premise: the licensed mine\'s node is locked out; the refinery holds none');
  const { page, paragraphs } = noticePage(snap, 'g1');
  for (const n of closures) {
    page.openNotice(n.id);
    assert.deepEqual(paragraphs(), [EVICTED_BODY + (n.payload.lockoutUntilTick != null ? LOCKOUT : '')]);
    assert.match(page.noticeRowTitle(n), /^Venture closed &mdash; <span class="who">.+ (Mine|Refinery)<\/span>$/, 'the row is the closure\'s, unchanged');
  }
});

// What main's noticeBody wrote for every other closure and lapse cause (event-log.md §2), pinned: the evicted branch
// takes nothing from them.
const BODIES_ON_MAIN = [
  ['venture_closed', 'teardown', false, 'You closed this venture.'],
  ['venture_closed', 'teardown', true, `You closed this venture.${LOCKOUT}`],
  ['venture_closed', 'operator', false, 'You closed this venture.'],
  ['venture_closed', 'forced', false, "This venture's standing fell to the Syndicate's floor, and they closed it."],
  ['venture_closed', 'forced', true, `This venture's standing fell to the Syndicate's floor, and they closed it.${LOCKOUT}`],
  ['licence_lapsed', 'rejected', false, 'You let this licence lapse. The venture reverts to unlicensed — you keep the mine, but it has forfeited its standing (RP). You can sign a fresh licence later on your own terms.'],
  ['licence_lapsed', 'timeout', false, "The Syndicate's renegotiation window closed without an answer, so the licence lapsed. The venture reverts to unlicensed — it keeps running, but has forfeited its standing (RP). You can sign a fresh licence later."],
];
test('venture_closed and licence_lapsed: every other cause reads exactly as main wrote it', () => {
  const { page } = noticePage({ guilds: [] }, 'g1');
  for (const [type, cause, locked, body] of BODIES_ON_MAIN) {
    const n = { type, payload: { cause, ...(locked ? { lockoutUntilTick: 9000 } : {}) } };
    assert.equal(page.noticeBody(n), body, `${type} / ${cause}${locked ? ' / lockout' : ''}`);
  }
});

// ---- 5. the rest of the hub, unchanged ---------------------------------------------------------------------

// Every Operations host, in every state above, as main's own Operations script rendered it at d353816 (before this
// slice), hashed and pinned. The host this slice changes in a state is named and left out of that state's hash (the
// readable tests above prove it); every other host must render byte for byte as on main. It touches nothing the slice
// added, so it passes on main's game.html too.
// ⤳ losing ground client slice 3: each view is taken with its Deep Scan Array rows' `dark` keys out — exactly main's
// view of the same galaxy (dark-array-snapshot.test.js) — because a dark array's DEPLOYED row is slice 3's own change
// (g1's two in "reach, lost"), proved in losing-ground-dark-client.test.js. The pins are unchanged.
const stripDark = (view) => {
  for (const row of view.deepScanArrays || []) delete row.dark;
  return view;
};
// ⤳ losing ground client slice 4: each view also has the asset ferry's two pointers taken out — a craft row's
// `carryingAssetId` and an asset row's `inTransitOnVehicleId`. Engine PR 2 published both, but main's client read
// neither, so it drew the same bytes with them or without. In "in place, loaded" the heavy carries the miner, and its
// IDLE TRANSPORTS card is slice 4's change there (salvage-client.test.js proves it); with the pointers out, slice 4's
// client draws main's card. The pins are unchanged.
const stripCarry = (view) => {
  for (const g of view.guilds || []) {
    for (const v of g.vehicles || []) delete v.carryingAssetId;
    for (const a of g.assets || []) delete a.inTransitOnVehicleId;
  }
  return view;
};
const AS_ON_MAIN = [
  { name: 'reach, before the loss (g1)', state: () => REACH.pre, guild: 'g1', changed: [],
    pin: 'd5ecb075c3bc34c77696919bf18fd9e33c2f3c86e1801b4a8ed9608e04da1c9b' },
  { name: 'reach, before the loss (g2)', state: () => REACH.pre, guild: 'g2', changed: [],
    pin: '19704479ecde91a085bc111f97af914cd10ef932b4c6c021cbd653452d405ddd' },
  { name: 'reach, lost (g1)', state: () => REACH.lost, guild: 'g1', changed: ['ops-lane-notices'],
    pin: 'f6055924fba86e56c5ee6a5e1f89d3b517299bf825b6cd7c3ea5b4c0a3748e0b' },
  { name: 'reach, lost (g2)', state: () => REACH.lost, guild: 'g2', changed: ['ops-lane-notices'],
    pin: 'c5d78942a99313d349420785bd0c3564c1e6fb749f44ce7fe95a13406cf45e31' },
  { name: 'in place, held (g1)', state: () => IN_PLACE.held, guild: 'g1', changed: [],
    pin: '241569ee28d2650e0a475ea63d6dc1edffd622ff2bd34eab842fa1832b6cc549' },
  { name: 'in place, stranded (g1)', state: () => IN_PLACE.stranded, guild: 'g1', changed: ['ops-idle-list'],
    pin: 'cc653ff8f7a7f31e77e370c76bdd894a0d8b82c744b3ea2db7a814aeb92622a2' },
  { name: 'in place, loaded (g1)', state: () => IN_PLACE.loaded, guild: 'g1', changed: ['ops-idle-list'],
    pin: '4994e4e0750ee75cf6dc4baf9b053045e27772ff9b68f3494b2b27f8f8e3a820' },
  { name: 'sweep, fallow (g1)', state: () => SWEPT.fallow, guild: 'g1', changed: ['ops-idle-list'],
    pin: 'cc653ff8f7a7f31e77e370c76bdd894a0d8b82c744b3ea2db7a814aeb92622a2' },
  { name: 'sweep, swept (g1)', state: () => SWEPT.s, guild: 'g1', changed: [],
    pin: '893100628de2b02f7ee3c908c594a73cf3acacbdc97b1373787c5cf30f5324f4' },
  { name: 'sweep, swept (g2)', state: () => SWEPT.s, guild: 'g2', changed: [],
    pin: 'e29d82d4f5c5d0336e46551bba82898cf74d5f759ce3e0a1a6084b59481715d7' },
];

test('the rest of the Operations hub renders exactly as main rendered it — every host this slice leaves alone, in every state', () => {
  for (const c of AS_ON_MAIN) {
    const p = opsPage(stripCarry(stripDark(viewOf(c.state(), c.guild))), c.guild);
    p.open();
    const hub = p.hub();
    for (const id of c.changed) delete hub[id];
    assert.equal(sha(hub), c.pin, `${c.name}: ${OPS_HOSTS.filter((id) => !c.changed.includes(id)).join(', ')} as on main`);
  }
});

// ---- 6. the wiring -----------------------------------------------------------------------------------------

test('wiring: the marker\'s styles are in the page, and the in-flight "where" reads the IN TRANSIT row\'s own destination', () => {
  assert.match(html, /#tp-ops \.ops-idle-machine\.stranded\{/);
  assert.match(html, /#tp-ops \.ops-idle-machine \.mstranded\{/);
  assert.match(opsSrc, /function endedWhere\(v\)\{ return v\.trip \? craftDestName\(v\.trip\) : tpCraftWhere\(v\); \}/);
});
