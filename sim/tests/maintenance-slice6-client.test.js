'use strict';

// maintenance-slice6-client.test.js — roadmap 2.6 (maintenance), slice 6 of 6: the DEEP MAINTENANCE BUTTON (Dispatch
// popup + Maintenance-tab row), the Outpost MAINTENANCE HANGAR, the ROUTE-BUILDER LIMIT for a craft at 0%, OPERATIONS'
// craft cards in deep maintenance, and ONE DISPLAY RULE for craft condition (docs/maintenance.md §7.1–§7.5). Client only.
//
// As the other *-client tests do, this runs the page's OWN code, cut out of client/game.html, in a node:vm sandbox on a
// stub DOM, against REAL per-guild snapshots built by the engine (maintenance-tab-fixtures.js), and — for the actions and
// the quote — the real engine (validateAction / applyAction / quoteDispatch). What it proves, in the slice's proof order:
//   1. THE FORMATTER: the five ruled cases, every condition the engine can publish, and every surface that reads it.
//   2. THE BUTTON: enabled below 20% at a held system; disabled at 20%, away from a point, at a full Outpost; a press
//      posts exactly startDeepMaintenance { guildId, vehicleId }, which the engine accepts; a refusal shows its reason.
//   3. THE HANGAR: five bays with occupants and ready times, the queue in order, and the empty states.
//   4. THE ROUTE BUILDER: a 0% craft's route stops at its first maintenance point, from the quote's code alone; a craft
//      above 0% is unchanged (and asks no quote).
//   5. OPERATIONS: a card for a craft in a bay and one queued.
//   6. TRIPWIRES: the two engine values the page mirrors.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { buildSnapshot } = require('../snapshot.js');
const { validateAction, applyAction, quoteDispatch } = require('../actions.js');
const { CRAFT_WEAR_SCALE } = require('../craft-maintenance.js');
const { EARLY_DEEP_MAINTENANCE_BELOW_PERCENT, ZERO_CONDITION_STOP_CODE } = require('../deep-maintenance.js');
const { getSystem } = require('../seed.js');
const F = require('./maintenance-tab-fixtures.js');

const ROOT = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'client', 'game.html'), 'utf8');

// ---- the page's own code, cut out of game.html ------------------------------------------------------------------

function cut(src, re, what) {
  const m = src.match(re);
  assert.ok(m, `${what} is present in game.html`);
  return m;
}
// Every inline <script> block, and the one that holds `marker` (exactly one must).
const SCRIPTS = [...html.matchAll(/<script(?: id="[^"]*")?>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
function scriptWith(marker) {
  const hits = SCRIPTS.filter((src) => src.includes(marker));
  assert.equal(hits.length, 1, `exactly one script holds ${marker}`);
  return hits[0];
}
const sharedSrc = cut(html, /<script id="craft-maintenance-shared">([\s\S]*?)<\/script>/, 'the shared craft-maintenance helpers')[1];
const kitKindsSrc = cut(html, /<script id="kit-kinds">([\s\S]*?)<\/script>/, 'the kit-kinds script')[1];
const opsSrc = cut(html, /<script id="operations-tab-wire">([\s\S]*?)<\/script>/, 'the Operations script')[1];
const maintSrc = cut(html, /<script id="maintenance-tab-wire">([\s\S]*?)<\/script>/, 'the Maintenance tab script')[1];
const dispatchSrc = scriptWith('function openDispatch(vehicle)');
const managerSrc = scriptWith('function openManager(id)');
const mapSrc = scriptWith('function startPlanning(vehicle, waypoints, routeName, loop, kit)');
const fmtEtaSrc = cut(html, /\n {2}function fmtETA\(ticks\) \{\n[\s\S]*?\n {2}\}\n/, 'the map\'s fmtETA')[0];
const bridgesSrc = `(function(){\n${fmtEtaSrc}window.__fmtETA = fmtETA;\n})();\n`;
// One planner function by name, as the page has it (a multi-line `function name(...) { … }` at the map's indent).
const fn = (name) => cut(mapSrc, new RegExp(`\\n {2}function ${name}\\([^)]*\\) ?\\{[\\s\\S]*?\\n {2}\\}\\n`), name)[0];
const oneLiner = (name) => cut(mapSrc, new RegExp(`\\n {2}function ${name}\\(\\) \\{[^\\n]*\\n`), name)[0];

// ---- real engine output ------------------------------------------------------------------------------------------

const B = F.buttons();
const HG = F.hangar();
const viewOf = (s, guildId = 'g1') => JSON.parse(JSON.stringify(buildSnapshot(s, guildId)));
const meOf = (snap, guildId = 'g1') => snap.guilds.find((g) => g.id === guildId);
const rowOf = (snap, id) => meOf(snap).vehicles.find((v) => v.id === id);
const clone = (x) => JSON.parse(JSON.stringify(x));
const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const textOf = (h) => unescape(h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
const sysName = (id) => (getSystem(id) ? getSystem(id).name : id);
const outpostName = (id) => `${id} (name)`;   // the stub resolver, so a drawn Outpost name is recognisable
// An independent copy of the time formatter's rule (1 tick = 1 minute), to state expected times without the page.
function eta(t) {
  const d = Math.floor(t / 1440); const h = Math.floor((t % 1440) / 60); const m = t % 60;
  const p = (n) => (n < 10 ? '0' : '') + n;
  return d > 0 ? `${d}d ${p(h)}h` : (h > 0 ? `${h}h ${p(m)}m` : `${m}m`);
}
// The real engine as the action endpoint: validate, apply if valid, answer as POST /action does.
function engineSend(state) {
  const box = { applied: state };
  box.send = (action) => {
    const { valid, reason } = validateAction(box.applied, action);
    if (valid) box.applied = applyAction(box.applied, action);
    return { accepted: valid, reason: valid ? null : reason };
  };
  return box;
}
const flush = () => new Promise((r) => setImmediate(r));

// ---- a stub DOM ----------------------------------------------------------------------------------------------------

function stubNode(id) {
  const classes = new Set();
  let inner = '';
  return {
    id, textContent: '', value: '', disabled: false, style: {}, hidden: false, listeners: {}, children: [],
    get innerHTML() { return inner; },
    set innerHTML(v) { inner = v; this.children = []; },
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c), toggle() {} },
    addEventListener(type, f) { this.listeners[type] = f; },
    appendChild(c) { this.children.push(c); return c; },
    querySelectorAll: () => [],
    querySelector: () => null,
    getAttribute: () => null,
    setAttribute() {},
  };
}
function stubDocument(nodes) {
  return {
    getElementById: (id) => nodes[id] || (nodes[id] = stubNode(id)),
    createElement: (tag) => stubNode(tag),
    addEventListener() {},
    querySelectorAll: () => [],
    querySelector: (sel) => stubNode(sel),   // e.g. the Outpost screen's right hero, whose class it toggles
    activeElement: null,
  };
}
function baseWindow(getSnap, send, sent, guildId = 'g1') {
  return {
    __player: () => ({ guildId }),
    __snapshot: getSnap,
    __systemName: sysName,
    __outpostName: outpostName,
    __landmarkNameAt: () => null,
    __sendAction: (a) => { const wire = clone(a); sent.push(wire); return Promise.resolve(send ? send(wire) : { accepted: true }); },
  };
}

// ---- 1. the formatter ----------------------------------------------------------------------------------------------

function shared() {
  const sandbox = { window: { __player: () => ({ guildId: 'g1' }) } };
  vm.createContext(sandbox);
  vm.runInContext(sharedSrc, sandbox);
  return sandbox.window;
}

test('formatter: the ruled cases — 0 is "0%", just above it "<1%", and every other condition rounds DOWN', () => {
  const f = shared().__fmtCondition;
  assert.equal(f(0), '0%');
  assert.equal(f(0.004), '<1%');
  assert.equal(f(0.196), '19%');
  assert.equal(f(0.5), '50%');
  assert.equal(f(1), '100%');
  // The float trap: 0.29 * 100 is 28.999999999999996 in JavaScript; the craft is at 29%, and reads so.
  assert.equal(f(0.29), '29%');
  assert.equal(f(undefined), '—', 'a figure the snapshot did not publish is not made up');
});

test('formatter: every condition the engine can publish (units / CRAFT_WEAR_SCALE) reads the whole percent at or below it', () => {
  const f = shared().__fmtCondition;
  for (let u = 0; u <= CRAFT_WEAR_SCALE; u += 1) {
    // The expectation in integers only: floor(u × 100 ÷ scale), exactly.
    const pct = (u * 100 - ((u * 100) % CRAFT_WEAR_SCALE)) / CRAFT_WEAR_SCALE;
    const want = u === 0 ? '0%' : (pct === 0 ? '<1%' : `${pct}%`);
    const got = f(u / CRAFT_WEAR_SCALE);
    if (got !== want) assert.fail(`unit ${u} of ${CRAFT_WEAR_SCALE}: drew ${got}, want ${want}`);
  }
});

test('formatter: every place a craft\'s condition is drawn uses it, and no place rounds it on its own', () => {
  const uses = html.match(/window\.__fmtCondition\(v\.maintenanceCondition\)/g) || [];
  // The Maintenance tab row, the Dispatch popup's head, the Operations card, and the Operations card's redraw signature.
  assert.equal(uses.length, 4, 'four reads, one formatter');
  assert.ok(maintSrc.includes('var pct = window.__fmtCondition(v.maintenanceCondition);'), 'the Maintenance tab row');
  assert.ok(dispatchSrc.includes("$('dpMaint').textContent = window.__fmtCondition(v.maintenanceCondition);"), 'the Dispatch popup');
  assert.ok(opsSrc.includes('var maint = window.__fmtCondition(v.maintenanceCondition);'), 'the Operations craft card');
  assert.equal(/maintenanceCondition[^\n]*\* *100|Math\.round\([^\n]*maintenanceCondition/.test(html), false, 'nothing else turns a craft condition into a percent');
  // The Outpost screen draws no craft condition (its Hangar shows who is in each bay and when it is ready).
  assert.equal(managerSrc.includes('maintenanceCondition'), false);
});

// ---- the pages ------------------------------------------------------------------------------------------------------

// tabPage(snapshot, send) — the Maintenance tab on a stub DOM, opened.
function tabPage(snapshot, send) {
  let current = snapshot;
  const nodes = {}; const sent = [];
  const sandbox = { document: stubDocument(nodes), window: baseWindow(() => current, send, sent), Promise };
  let refreshes = 0;
  sandbox.window.__refreshNow = () => { refreshes += 1; return Promise.resolve(); };
  vm.createContext(sandbox);
  vm.runInContext(bridgesSrc + sharedSrc + maintSrc, sandbox);
  sandbox.window.__maintOpen();
  const fleet = () => nodes['mt-fleet'].innerHTML;
  return {
    sent, refreshes: () => refreshes,
    poll(next) { current = next; sandbox.window.__maintRefresh(); },
    fleet,
    // The row's last cell — the Deep maintenance column.
    deepCell(id) {
      const row = cut(fleet(), new RegExp(`<tr data-craft="${id}">([\\s\\S]*?)</tr>`), `the row for ${id}`)[1];
      return [...row.matchAll(/<td>([\s\S]*?)<\/td>/g)].pop()[1];
    },
    // A click on the row's button, through the panel's own click listener.
    async press(id, disabled) {
      const btn = { disabled, getAttribute: () => id };
      nodes['tp-maint'].listeners.click({ target: { closest: (sel) => (sel === '[data-mt-deep]' ? btn : null) } });
      await flush();
    },
  };
}

// popupPage(snapshot, send) — the Dispatch popup on a stub DOM. open(id) opens it for that craft.
function popupPage(snapshot, send) {
  let current = snapshot;
  const nodes = {}; const sent = [];
  const sandbox = { document: stubDocument(nodes), window: baseWindow(() => current, send, sent), Promise };
  sandbox.window.__abandonPlanning = () => {};
  sandbox.window.__refreshNow = () => Promise.resolve();
  vm.createContext(sandbox);
  vm.runInContext(bridgesSrc + sharedSrc + dispatchSrc, sandbox);
  return {
    sent, nodes,
    setSnapshot(next) { current = next; },
    open(id) { sandbox.window.__openDispatch(rowOf(current, id)); },
    button: () => cut(nodes.dpActions.innerHTML, /<button class="dp-btn" id="dpMaintBtn"[^>]*>[^<]*<\/button>/, 'the Deep maintenance button')[0],
    async press() { await nodes.dpMaintBtn.listeners.click(); },
  };
}

// ---- 2. the Deep maintenance button ----------------------------------------------------------------------------------

const SNAP = viewOf(B.s);
const CASES = [
  ['below 20% at a held system', B.low, true],
  ['at exactly 20%', B.at20, false],
  ['away from any maintenance point', B.away, false],
  ['at an Outpost whose bays are full', B.full, false],
];

test('button: the Dispatch popup and a tab row each enable it only when the snapshot says the engine would accept it', () => {
  for (const [what, id, allowed] of CASES) {
    assert.equal(rowOf(SNAP, id).craftMaintenance.earlyMaintenanceAllowed, allowed, `premise: ${what}`);
    // The engine agrees with its own flag.
    assert.equal(validateAction(B.s, { type: 'startDeepMaintenance', guildId: 'g1', vehicleId: id }).valid, allowed, `the engine, ${what}`);

    const pop = popupPage(SNAP); pop.open(id);
    assert.ok(pop.button().includes('>Deep maintenance</button>'), 'the popup\'s button is Deep maintenance');
    assert.equal(/ disabled[ >]/.test(pop.button()), !allowed, `the popup, ${what}`);
    const why = pop.nodes.dpSection.innerHTML.includes('Only below 20%, idle, at a system you hold or your own Outpost with a free bay');
    assert.equal(why, !allowed, `the popup shows a reason exactly when disabled, ${what}`);

    const tab = tabPage(SNAP);
    const cell = tab.deepCell(id);
    assert.match(cell, />Deep maintenance<\/button>/);
    assert.equal(/ disabled[ >]/.test(cell), !allowed, `the tab row, ${what}`);
    assert.equal(cell.includes('Only below 20%'), !allowed, `the tab row shows a reason exactly when disabled, ${what}`);
  }
  // A craft already in deep maintenance, or queued for a bay, says so instead.
  assert.ok(tabPage(SNAP).deepCell(B.bays[0]).includes('Already in deep maintenance'));
  assert.ok(tabPage(SNAP).deepCell(B.queued).includes('Already queued for a maintenance bay'));
});

test('button: pressing it in the popup posts exactly startDeepMaintenance { guildId, vehicleId }; the real engine accepts it', async () => {
  const box = engineSend(B.s);
  const pop = popupPage(SNAP, box.send);
  pop.open(B.low);
  await pop.press();
  assert.deepEqual(pop.sent, [{ type: 'startDeepMaintenance', guildId: 'g1', vehicleId: B.low }]);
  assert.equal(box.applied.guilds.find((g) => g.id === 'g1').vehicles.find((v) => v.id === B.low).status, 'maintenance', 'the real engine accepted it');
});

test('button: an accepted press redraws the popup from the NEW snapshot only — the button then reads "Already in deep maintenance"', async () => {
  const box = engineSend(B.s);
  let current = SNAP;
  const nodes = {}; const sent = [];
  const sandbox = { document: stubDocument(nodes), window: baseWindow(() => current, box.send, sent), Promise };
  sandbox.window.__abandonPlanning = () => {};
  sandbox.window.__refreshNow = () => { current = viewOf(box.applied); return Promise.resolve(); };
  vm.createContext(sandbox);
  vm.runInContext(bridgesSrc + sharedSrc + dispatchSrc, sandbox);
  sandbox.window.__openDispatch(rowOf(SNAP, B.low));
  await nodes.dpMaintBtn.listeners.click();
  assert.match(nodes.dpActions.innerHTML, /id="dpMaintBtn" type="button" disabled title="Already in deep maintenance"/);
  assert.ok(nodes.dpSection.innerHTML.includes('Deep maintenance: Already in deep maintenance'));
});

test('button: a refusal shows the engine\'s own reason in place — popup and tab row', async () => {
  // The player presses on a snapshot that still says "allowed", but the engine has moved on: the craft is already in.
  const box = engineSend(B.s);
  box.send({ type: 'startDeepMaintenance', guildId: 'g1', vehicleId: B.low });
  const { reason } = validateAction(box.applied, { type: 'startDeepMaintenance', guildId: 'g1', vehicleId: B.low });
  assert.match(reason, /already in deep maintenance/, 'premise: the engine refuses');

  const pop = popupPage(SNAP, box.send); pop.open(B.low);
  await pop.press();
  assert.ok(unescape(pop.nodes.dpSection.innerHTML).includes(`Refused: ${reason}`), 'the popup shows the engine\'s reason');

  const tab = tabPage(SNAP, box.send);
  await tab.press(B.low, false);
  assert.deepEqual(tab.sent, [{ type: 'startDeepMaintenance', guildId: 'g1', vehicleId: B.low }]);
  assert.ok(unescape(tab.deepCell(B.low)).includes(`Refused: ${reason}`), 'the row shows the engine\'s reason');
  // …until the tick moves on (the tab's rule for every refusal).
  const next = clone(SNAP); next.tick += 1;
  tab.poll(next);
  assert.equal(tab.deepCell(B.low).includes('Refused:'), false);
});

test('button: a tab-row press posts exactly startDeepMaintenance { guildId, vehicleId }, the engine accepts it, and the row changes only with the next snapshot', async () => {
  const box = engineSend(B.s);
  const tab = tabPage(SNAP, box.send);
  await tab.press(B.low, false);
  assert.deepEqual(tab.sent, [{ type: 'startDeepMaintenance', guildId: 'g1', vehicleId: B.low }]);
  assert.equal(tab.refreshes(), 1, 'the shell is asked for the next snapshot');
  assert.ok(!/ disabled[ >]/.test(tab.deepCell(B.low)), 'still the old snapshot, so still the old button');
  tab.poll(viewOf(box.applied));
  assert.ok(tab.deepCell(B.low).includes('Already in deep maintenance'), 'the next snapshot shows it in');
  // A press on a disabled button sends nothing.
  await tab.press(B.at20, true);
  assert.equal(tab.sent.length, 1);
});

// ---- 3. the Hangar ----------------------------------------------------------------------------------------------------

// managerPage(snapshot, guildId) — the Outpost screen on a stub DOM, opened on the fixture's Outpost.
function managerPage(snapshot, guildId = 'g1') {
  const nodes = {}; const sent = [];
  const sandbox = { document: stubDocument(nodes), window: baseWindow(() => snapshot, null, sent, guildId), Promise };
  vm.createContext(sandbox);
  vm.runInContext(bridgesSrc + sharedSrc + managerSrc, sandbox);
  sandbox.window.__openOutpostManager(F.OUTPOST);
  return nodes;
}
// Each Hangar line as [label, value] — a bay's quieter "ready in …" line joined to its value with " — ".
const hangarLines = (nodes) => [...nodes.omHangar.innerHTML.matchAll(/<div class="hg-row[^"]*"><span class="k">([^<]*)<\/span><span class="v">([^<]*)(?:<span class="t">([^<]*)<\/span>)?<\/span><\/div>/g)]
  .map((m) => [unescape(m[1]), unescape(m[2]) + (m[3] ? ` — ${unescape(m[3])}` : '')]);
const craftLabel = (id) => { const p = id.split('_'); return `${p[2].replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\b\w/g, (c) => c.toUpperCase())} · #${p[3]}`; };

test('hangar: five bays, each with its craft and "ready in …" from the published eta; then the queue in the published order', () => {
  const snap = viewOf(HG.s);
  const mt = snap.outposts.find((o) => o.id === F.OUTPOST).maintenance;
  assert.equal(mt.bays, 5, 'premise'); assert.equal(mt.inBays.length, 5, 'premise'); assert.equal(mt.queue.length, 3, 'premise');
  assert.notEqual(mt.inBays[0].eta, mt.inBays[4].eta, 'premise: two classes, two ready times');
  const nodes = managerPage(snap);
  assert.ok(nodes.omHangar.innerHTML.includes('<div class="sqhead">Maintenance Hangar</div>'));
  assert.deepEqual(hangarLines(nodes), [
    ...mt.inBays.map((b, i) => [`Bay ${i + 1}`, `${craftLabel(b.vehicleId)} — ready in ${eta(b.eta)}`]),
    ['Next', craftLabel(mt.queue[0].vehicleId)],
    ['Queue 02', craftLabel(mt.queue[1].vehicleId)],
    ['Queue 03', craftLabel(mt.queue[2].vehicleId)],
  ]);
});

test('hangar: every figure is the readout\'s — change one published field and only its line moves', () => {
  const snap = viewOf(HG.s);
  const base = hangarLines(managerPage(snap));
  const next = clone(snap);
  const mt = next.outposts.find((o) => o.id === F.OUTPOST).maintenance;
  mt.inBays[2].eta = 61;
  mt.queue.reverse();
  const after = hangarLines(managerPage(next));
  assert.deepEqual(after[2], ['Bay 3', `${craftLabel(mt.inBays[2].vehicleId)} — ready in 1h 01m`]);
  assert.deepEqual(after.slice(5).map((l) => l[1]), mt.queue.map((q) => craftLabel(q.vehicleId)), 'drawn in the order published');
  assert.deepEqual([...after.slice(0, 2), ...after.slice(3, 5)], [...base.slice(0, 2), ...base.slice(3, 5)], 'the other bays are untouched');
});

test('hangar: the empty states — five empty bays and "No craft waiting"; and a rival\'s Outpost, which publishes no readout', () => {
  const nodes = managerPage(viewOf(HG.empty));
  assert.deepEqual(hangarLines(nodes), [1, 2, 3, 4, 5].map((n) => [`Bay ${n}`, 'empty']));
  assert.ok(nodes.omHangar.innerHTML.includes('No craft waiting for a bay.'));
  // Seen by g2, the Outpost row carries no `maintenance` (fog: owner only) — the box says so and invents no bays.
  const rivalView = viewOf(HG.s, 'g2');
  assert.equal(rivalView.outposts.find((o) => o.id === F.OUTPOST).maintenance, undefined, 'premise: fogged');
  const rival = managerPage(rivalView, 'g2');
  assert.deepEqual(hangarLines(rival), []);
  assert.ok(unescape(rival.omHangar.innerHTML).includes('Only the owner sees this Outpost\'s bays.'));
});

// ---- 4. the route builder ----------------------------------------------------------------------------------------------

// planner(state, vehicleId) — the map's route builder: its list, its chip, its Finalise gate and the slice's 0% block, cut
// from the page, on a stub DOM. Everything the 0% rule does not touch is stubbed to "nothing to flag". The quote is the
// REAL engine's (quoteDispatch on `state`), answered asynchronously as POST /vehicle/quote is; `asked` counts the asks.
function planner(state, vehicleId) {
  const view = viewOf(state);
  const vehicle = rowOf(view, vehicleId);
  const nodes = {};
  const asked = [];
  const hint = { text: '' };
  const sandbox = {
    document: stubDocument(nodes),
    window: {
      __fetchQuote: (v, wps) => {
        const anchors = wps.map((w) => w.anchor);
        asked.push(anchors);
        return Promise.resolve(clone(quoteDispatch(state, { guildId: 'g1', vehicleId: v.id, waypoints: anchors })));
      },
    },
    PLAN: { vehicle, origin: vehicle.location, waypoints: [], candidate: null, candidateArmed: false, candidateAction: null,
      routeName: '', loop: false, deploy: null, unload: false, fromInventory: false, deployQuote: null, zeroQuotes: {} },
    // The rest of the planner, as "nothing to flag" — the 0% stop is the only thing under test here.
    deadLegAt: () => false, anyDeadLeg: () => false, brokenAt: () => false, brokenReason: () => '', idleAtBerth: () => false,
    hereNote: () => '', canRepeat: () => false, loopClosed: () => false, actionSummary: () => '', candidateIsDeadLeg: () => false,
    routeActionAllowed: () => false, requestDeployQuote() {}, IDLE_AT_BERTH_CUE: '', LOOP_CLOSED_NOTE: '', LOOP_RETURN_NOTE: '',
    anchorLabel: (a) => (a.landmarkKind === 'system' ? sysName(a.landmarkId) : `(${a.q}, ${a.r})`),
    showPlanChip: (chip, h, text) => { hint.text = text; },
  };
  vm.createContext(sandbox);
  vm.runInContext(bridgesSrc + sharedSrc, sandbox);
  vm.runInContext(['zeroQuote', 'routeZeroStop', 'candidateZeroQuote', 'canFinalise', 'isKitPlan', 'refreshPlanState',
    'renderPlanList', 'escapeHtml', 'renderPlanChip', 'confirmCandidate', 'clearCandidate'].map(fn).join('') + oneLiner('atZero'), sandbox);
  const P = sandbox.PLAN;
  return {
    asked,
    P,
    // Propose a hex (as a map click does), and let any quote it asks for come back.
    async propose(anchor) { P.candidate = anchor; P.candidateArmed = true; sandbox.renderPlanChip(); await flush(); },
    chip() {
      const btns = nodes.planChipButtons.children.map((b) => ({ text: b.textContent, disabled: b.disabled }));
      return { confirm: btns.find((b) => b.text === 'Confirm'), hint: hint.text };
    },
    confirm() { sandbox.confirmCandidate(); },
    async route(anchors) { P.waypoints = anchors.map((a) => ({ anchor: a })); sandbox.refreshPlanState(); await flush(); },
    rows: () => nodes.planRows.children.slice(1).map((r) => textOf(r.innerHTML)),
    finaliseEnabled: () => !nodes.planFinalise.disabled,
  };
}
const HOME = F.AT_H;
const DEEP = F.D;

test('route builder: a 0% craft is offered no stop after its first maintenance point — read from the quote\'s code, never worked out', async () => {
  // Premise, from the engine itself: a 0% craft's route through HOME (held) before its end is refused with the code.
  const refused = quoteDispatch(B.s, { guildId: 'g1', vehicleId: B.zero, waypoints: [HOME, DEEP] });
  assert.deepEqual([refused.ok, refused.code, refused.waypointIndex], [false, ZERO_CONDITION_STOP_CODE, 0]);

  const p = planner(B.s, B.zero);
  // A first stop is always the route's end, so nothing is asked and it is placed.
  await p.propose(HOME);
  assert.equal(p.asked.length, 0);
  assert.equal(p.chip().confirm.disabled, false);
  p.confirm();
  assert.equal(p.P.waypoints.length, 1);
  // The next hex: the quote for HOME → it names stop 1 as the end, so the chip refuses it, in plain words.
  await p.propose(DEEP);
  assert.deepEqual(p.asked, [[HOME, DEEP]], 'the builder asked the engine about the route plus the hex');
  assert.equal(p.chip().confirm.disabled, true, 'no stop is offered past the maintenance point');
  assert.equal(p.chip().hint, `This craft is at 0%, so it goes into deep maintenance at stop 1 (${sysName(F.H)}) — the route must end there.`);
  p.confirm();
  assert.equal(p.P.waypoints.length, 1, 'and none can be placed');
  assert.equal(p.finaliseEnabled(), true, 'the route HOME alone is fine — it ends at its point');
});

test('route builder: a 0% craft may still place a stop the engine accepts — a route that ENDS at its maintenance point', async () => {
  assert.equal(quoteDispatch(B.s, { guildId: 'g1', vehicleId: B.zero, waypoints: [DEEP, HOME] }).ok, true, 'premise');
  const p = planner(B.s, B.zero);
  await p.propose(DEEP); p.confirm();
  await p.propose(HOME);
  assert.deepEqual(p.asked, [[DEEP, HOME]], 'asked about the route plus the hex');
  assert.equal(p.chip().confirm.disabled, false, 'the quote is ok, so the stop is offered');
  assert.equal(p.chip().hint, '');
  p.confirm();
  assert.equal(p.P.waypoints.length, 2);
  await flush();
  assert.equal(p.finaliseEnabled(), true);
});

test('route builder: a 0% craft\'s route that already passes the point (e.g. loaded) flags the stop and refuses to commit', async () => {
  const p = planner(B.s, B.zero);
  await p.route([HOME, DEEP]);
  const rows = p.rows();
  assert.ok(rows[0].includes('at 0% the craft goes into deep maintenance here — end the route here'), rows[0]);
  assert.ok(rows[1].includes('past the maintenance stop — remove this stop'), rows[1]);
  assert.equal(p.finaliseEnabled(), false, 'Finalise is held');
  // Ending AT the point is allowed — the engine quotes it, and nothing is flagged.
  const ok = planner(B.s, B.zero);
  await ok.route([DEEP, HOME]);
  assert.equal(quoteDispatch(B.s, { guildId: 'g1', vehicleId: B.zero, waypoints: [DEEP, HOME] }).ok, true, 'premise');
  assert.equal(ok.rows().some((r) => r.includes('maintenance')), false);
  assert.equal(ok.finaliseEnabled(), true);
});

test('route builder: a craft above 0% is unchanged — no quote asked, nothing flagged, the same route commits', async () => {
  assert.equal(quoteDispatch(B.s, { guildId: 'g1', vehicleId: B.above, waypoints: [HOME, DEEP] }).ok, true, 'premise');
  const p = planner(B.s, B.above);
  await p.propose(HOME); p.confirm();
  await p.propose(DEEP);
  assert.equal(p.chip().confirm.disabled, false);
  assert.equal(p.chip().hint, '');
  p.confirm();
  assert.equal(p.P.waypoints.length, 2);
  assert.equal(p.rows().some((r) => r.includes('maintenance')), false);
  assert.equal(p.finaliseEnabled(), true);
  assert.equal(p.asked.length, 0, 'the builder asks nothing for a craft above 0%');
});

test('route builder: the Dispatch popup\'s Finalise view words the same refusal plainly and holds Dispatch', async () => {
  const nodes = {}; const sent = [];
  const snap = viewOf(B.s);
  const sandbox = {
    document: stubDocument(nodes),
    window: baseWindow(() => snap, null, sent),
    Promise,
    // The page's own fetchQuote posts to /vehicle/quote; here the real engine answers it.
    fetch: (url, opts) => Promise.resolve({ json: () => Promise.resolve(clone(quoteDispatch(B.s, JSON.parse(opts.body)))) }),
  };
  sandbox.window.__abandonPlanning = () => {};
  sandbox.window.__anchorLabel = (a) => (a.landmarkKind === 'system' ? sysName(a.landmarkId) : `(${a.q}, ${a.r})`);
  sandbox.window.__routeChecks = {
    idleAtBerth: () => false, loopClosed: () => false, hereNote: () => '', brokenAt: () => false, brokenReason: () => '',
    isKitAction: () => false, skipsFirstLeg: () => false, anyBroken: () => false, canRepeat: () => false, anyDeadLeg: () => false,
  };
  vm.createContext(sandbox);
  vm.runInContext(bridgesSrc + sharedSrc + dispatchSrc, sandbox);
  await sandbox.window.__dispatchFinalise(rowOf(snap, B.zero), [{ anchor: HOME }, { anchor: DEEP }]);
  const section = unescape(nodes.dpSection.innerHTML);
  assert.ok(section.includes('This craft is at 0%, so it goes into deep maintenance at stop 1'), 'the plain words');
  assert.equal(section.includes('docs/maintenance.md'), false, 'not the engine\'s raw sentence');
  assert.ok(section.includes('At 0% the craft goes into deep maintenance here — end the route here'));
  assert.ok(section.includes('Past the maintenance stop — remove this stop'));
  assert.equal(nodes.dpDispatchBtn.disabled, true, 'Dispatch is held');
});

// ---- 5. Operations ------------------------------------------------------------------------------------------------------

function opsHub(snapshot) {
  const nodes = {}; const sent = [];
  const sandbox = { document: stubDocument(nodes), window: baseWindow(() => snapshot, null, sent), Promise };
  vm.createContext(sandbox);
  vm.runInContext(bridgesSrc + sharedSrc + kitKindsSrc + opsSrc, sandbox);
  sandbox.window.__opsOpen();
  return nodes['ops-tp-list'].innerHTML;
}
// The card for one craft: from its data-tp-key to the next card or group.
const cardOf = (hub, id) => cut(hub, new RegExp(`data-tp-key="tp:${id}">([\\s\\S]*?)(?=<div class="ops-tp-craft[ "]|<div class="ops-tp-sys"|$)`), `the card for ${id}`)[1];

test('operations: a craft in a bay reads "In deep maintenance at <point> — ready in …"; a queued one its position; both at the Outpost', () => {
  const snap = viewOf(HG.s);
  const hub = opsHub(snap);
  const where = outpostName(F.OUTPOST);
  for (const id of HG.inBays) {
    const dm = rowOf(snap, id).craftMaintenance.deepMaintenance;
    assert.ok(textOf(cardOf(hub, id)).includes(`Deep maintenance In deep maintenance at ${where} — ready in ${eta(dm.readyTick - snap.tick)}`), id);
    assert.equal(cardOf(hub, id).includes('data-tp-dock'), false, 'no Dock while the hold is locked');
  }
  HG.queued.forEach((id, i) => {
    assert.ok(textOf(cardOf(hub, id)).includes(`Queued for a bay at ${where} (position ${i + 1})`), id);
  });
  // They group under the Outpost (its published point), not the bare hex they stand on, and the header counts them.
  assert.ok(hub.includes(`<span class="nm">${where}</span>`));
  assert.ok(hub.includes('<span class="ct">0 idle · 8 in maintenance</span>'));
  assert.equal(hub.includes('DEEP SPACE'), false);
});

test('operations: the card\'s condition and ready time trace to the snapshot — change one and only its text moves', () => {
  const snap = viewOf(HG.s);
  const id = HG.inBays[0];
  const before = textOf(cardOf(opsHub(snap), id));
  const next = clone(snap);
  rowOf(next, id).maintenanceCondition = 0.004;
  rowOf(next, id).craftMaintenance.deepMaintenance.readyTick = next.tick + 90;
  const after = textOf(cardOf(opsHub(next), id));
  assert.ok(before.includes('Maintenance 0%'));
  assert.equal(after, before
    .replace('Maintenance 0%', 'Maintenance <1%')
    .replace(/ready in [^H]*Hold/, 'ready in 1h 30m Hold'), 'only the condition and the ready time moved');
});

// ---- the condition, as drawn on each surface ------------------------------------------------------------------------

test('condition: each surface draws the same craft\'s condition through the one rule — 19.6% reads 19%, 0.4% reads <1%', () => {
  for (const [c, want] of [[0.196, '19%'], [0.004, '<1%'], [0, '0%'], [1, '100%']]) {
    const snap = clone(SNAP);
    rowOf(snap, B.low).maintenanceCondition = c;
    const cells = [...tabPage(snap).fleet().match(new RegExp(`<tr data-craft="${B.low}">([\\s\\S]*?)</tr>`))[1].matchAll(/<td>([\s\S]*?)<\/td>/g)];
    assert.equal(unescape(cells[2][1]), want, `the Maintenance tab at ${c}`);
    const pop = popupPage(snap); pop.open(B.low);
    assert.equal(pop.nodes.dpMaint.textContent, want, `the Dispatch popup at ${c}`);
    assert.ok(textOf(cardOf(opsHub(snap), B.low)).includes(`Maintenance ${want}`), `the Operations card at ${c}`);
  }
});

// ---- 6. tripwires -----------------------------------------------------------------------------------------------------

test('tripwire: the page\'s mirrored code and threshold are the engine\'s', () => {
  assert.ok(sharedSrc.includes(`var ZERO_STOP_CODE = '${ZERO_CONDITION_STOP_CODE}';`), 'the 0% stop code');
  assert.ok(sharedSrc.includes(`'Only below ${EARLY_DEEP_MAINTENANCE_BELOW_PERCENT}%, idle,`), 'the early threshold in the disabled reason');
});
