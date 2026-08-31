'use strict';

// Tripwires for the ECONOMY RECORDER + the four-guild mean-line scenario
// (tools/run_economy.js, tools/scenarios/economy_meanline.js). These live in sim/tests/ so
// they run in the one suite, but the code under test is PLAYER TOOLING in tools/ — no
// engine file is touched by this slice.
//
// They assert OBSERVABLE PROPERTIES of the run rather than brittle exact numbers, with one
// deliberate exception: the tick the rationing crossing lands on IS pinned, because a
// scenario whose crossing quietly drifted to tick 4 or off the end of the run would still
// satisfy every "at least one of each" assertion while showing nothing.
//
//   - two runs of one scenario are BYTE-IDENTICAL (invariant 9);
//   - BOTH REGIMES really execute — un-rationed cycles and rationed ones. This is the
//     load-bearing one: without it the scenario could pass everything else while never
//     exercising `rationGrants`'s clip at all;
//   - a rationed cycle is CONSERVATIVE — the pool covers what left it, nobody is paid more
//     than they were due, and the galaxy's total is genuinely short;
//   - the EMPTY-GUILD GUARD holds on every tick for a guild that holds nothing;
//   - the recorder is a READER — it imports only `advance` and `buildSnapshot` from sim/,
//     and the licence recorder it sits beside is undisturbed.
//
// A run that COMPLETES is itself an integration proof: `advance()` asserts every invariant
// on every tick, so forty-four ticks of influx, issuance and rationing without a throw is
// invariant 1 (fuel conservation) holding across all of it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runEconomy } = require('../../tools/run_economy.js');
const { runScenario } = require('../../tools/run_scenario.js');
const { buildScenario, FIXTURES, GUILDS } = require('../../tools/scenarios/economy_meanline.js');
const { buildScenario: buildSupplyRelief } = require('../../tools/scenarios/supply_relief.js');
const { SNAPSHOT_SCHEMA } = require('../snapshot.js');

// --- small readers over a trace ------------------------------------------------
const cycles = (trace) => trace.filter((l) => l.reserve.sigmaDesired > 0);
const guildIn = (line, id) => line.guilds.find((g) => g.id === id);
const EMPTY_GUILD = GUILDS.find((g) => g.mines === 0 && g.systems === 0).id;

// One run, shared by the read-only assertions below. Determinism is proven separately, so
// reusing one trace here is safe and keeps the suite quick.
const RUN = runEconomy(buildScenario());

// ── DETERMINISM ───────────────────────────────────────────────────────────────

test('two runs of the mean-line scenario are byte-identical (invariant 9)', () => {
  const a = runEconomy(buildScenario());
  const b = runEconomy(buildScenario());
  assert.equal(a.jsonl, b.jsonl, 'the JSONL traces must be byte-for-byte identical');
  assert.equal(a.trace.length, FIXTURES.ticks);
  assert.equal(a.lastTick, FIXTURES.ticks);
});

test('the bots are driven in SORTED id order, so the run does not depend on how the spec was typed', () => {
  // The bots' actions are concatenated into ONE intake list and applied first-valid-wins,
  // so the order they are collected in is a real input to the run. `Object.keys` returns
  // insertion order, which means two specs listing the same bots in a different order would
  // otherwise be two different runs. Sorting makes the run a function of the spec's CONTENT.
  const base = buildScenario();
  const reversed = {
    ...base,
    bots: Object.fromEntries(Object.keys(base.bots).reverse().map((k) => [k, base.bots[k]])),
  };
  assert.notDeepEqual(Object.keys(base.bots), Object.keys(reversed.bots), 'the two specs really are typed differently');
  assert.equal(runEconomy(base).jsonl, runEconomy(reversed).jsonl,
    'yet they are the same run, byte for byte');
});

test('the scheduled expansion lands OFF a cycle boundary, so no column is stale', () => {
  // `advance` runs intake before the tick's steps, so an action landing ON a boundary is
  // already in force when issuance reads the state — while the recorder's PRE snapshot was
  // taken before it. Keeping the one scheduled action off a boundary means the trace's `gp`
  // column and the grant beside it can never disagree. Pinned so the fixture cannot drift.
  assert.notEqual(FIXTURES.expansionTick % FIXTURES.windowN, 0,
    'the expansion tick must not be a cycle boundary');
  const line = RUN.trace.find((l) => l.tick === FIXTURES.expansionTick);
  assert.equal(line.reserve.sigmaDesired, 0, 'and that tick really does move no fuel');
  assert.ok((line.worldEvents || []).length === 1, 'while really carrying the expansion');
});

// ── BOTH REGIMES — the load-bearing one ────────────────────────────────────────

test('the run really executes BOTH regimes: un-rationed cycles AND rationed ones', () => {
  const paid = RUN.trace.filter((l) => l.reserve.sigmaDesired > 0 && !l.reserve.rationing);
  const clipped = RUN.trace.filter((l) => l.reserve.rationing);

  assert.ok(paid.length >= 1, 'at least one cycle must be paid in full');
  assert.ok(clipped.length >= 1, 'and at least one must ration — otherwise the clip is never exercised');
  // Not a token one of each: the arc needs a readable stretch on both sides.
  assert.ok(paid.length >= 3, `${paid.length} un-rationed cycles — enough to read the pool bleeding down`);
  assert.ok(clipped.length >= 3, `${clipped.length} rationed cycles — enough to read the tail`);
});

test('the crossing happens ONCE, mid-run, and never reverses', () => {
  // Pinned deliberately. A scenario whose crossing drifted to the first cycle, or off the
  // end of the run, would still satisfy "at least one of each" while showing nothing — so
  // the SHAPE of the arc is asserted, not just its ingredients.
  const cs = cycles(RUN.trace);
  const flags = cs.map((l) => l.reserve.rationing);
  const firstRationed = flags.indexOf(true);

  assert.ok(firstRationed > 0, 'the run opens un-rationed');
  assert.ok(firstRationed < flags.length - 1, 'and the crossing is not the very last cycle');
  // Once the pool is empty and the influx is below the draw, nothing refills it: the
  // remaining cycles must all ration. (This is the 5b motivation — no controller pulls
  // draw back under supply, so the crunch is permanent.)
  assert.ok(flags.slice(firstRationed).every(Boolean),
    'rationing never reverses on its own — there is no price controller to correct it');
  assert.ok(flags.slice(0, firstRationed).every((f) => f === false));
});

test('the pool BLEEDS while un-rationed, then sits at zero once it cannot cover the draw', () => {
  const cs = cycles(RUN.trace);
  const unrationed = cs.filter((l) => !l.reserve.rationing);
  for (let i = 1; i < unrationed.length; i += 1) {
    assert.ok(unrationed[i].reserve.level < unrationed[i - 1].reserve.level,
      `cycle at tick ${unrationed[i].tick}: the pool must be falling — the draw outruns the influx`);
  }
  for (const l of cs.filter((x) => x.reserve.rationing)) {
    assert.equal(l.reserve.level, 0, `tick ${l.tick}: a rationed cycle empties the pool to exactly 0`);
  }
});

// ── THE RATIONED SPLIT IS CONSERVATIVE ─────────────────────────────────────────

test('on every rationed cycle the split is conservative and nobody is over-paid', () => {
  const clipped = RUN.trace.filter((l) => l.reserve.rationing);
  assert.ok(clipped.length > 0, 'vacuous unless the run really rationed');

  for (const line of clipped) {
    const r = line.reserve;
    assert.ok(r.sigmaGranted < r.sigmaDesired, `tick ${line.tick}: a rationed cycle is genuinely short`);
    assert.ok(r.level >= 0, `tick ${line.tick}: the pool never goes negative`);
    for (const g of line.guilds) {
      assert.ok(g.granted <= g.desired, `tick ${line.tick} ${g.id}: granted must never exceed what was due`);
      assert.ok(g.granted >= 0 && Number.isInteger(g.granted), `tick ${line.tick} ${g.id}: whole, non-negative fuel`);
      // A guild that asked for nothing is never handed a remainder unit.
      if (g.desired === 0) assert.equal(g.granted, 0, `${g.id} was due nothing and must receive nothing`);
      // The per-guild flag agrees with the arithmetic beside it.
      assert.equal(g.rationed, g.granted < g.desired, `tick ${line.tick} ${g.id}: the rationed flag matches its own numbers`);
    }
  }
});

test('a fully-paid cycle pays everyone exactly what they were due', () => {
  const paid = RUN.trace.filter((l) => l.reserve.sigmaDesired > 0 && !l.reserve.rationing);
  for (const line of paid) {
    assert.equal(line.reserve.sigmaGranted, line.reserve.sigmaDesired);
    for (const g of line.guilds) {
      assert.equal(g.granted, g.desired, `tick ${line.tick} ${g.id}: paid in full`);
      assert.equal(g.rationed, false);
    }
  }
});

test('a guild\'s hoard rises by exactly what it was granted, cycle after cycle', () => {
  // The transfer, seen from the receiving end and across the whole run — a check the
  // recorder can make that a unit test cannot, because it needs a real multi-cycle history.
  for (const spec of GUILDS.filter((g) => g.mines > 0)) {
    let hoard = 0;
    for (const line of RUN.trace) {
      const g = guildIn(line, spec.id);
      hoard += g.granted;
      assert.equal(g.hoard, hoard, `tick ${line.tick} ${spec.id}: the hoard is the running sum of its grants`);
    }
    assert.ok(hoard > 0, `${spec.id} really did accumulate fuel over the run`);
  }
});

// ── THE MODIFIER SPREAD — the reason this harness is multi-guild ───────────────

test('the four guilds really do span the modifier range', () => {
  // Without a spread there is nothing for a mean line to be the mean OF, and the single-
  // guild recorder would have done. The spread is asserted as an ordering, not as exact
  // values, so re-shaping the fixtures does not force a test rewrite.
  const first = cycles(RUN.trace)[0];
  const dense = guildIn(first, 'forge-guild');
  const par = guildIn(first, 'meridian-guild');
  const sprawl = guildIn(first, 'reach-guild');

  assert.ok(dense.modifier > 1, `the dense guild sits above its line (${dense.modifier})`);
  assert.ok(Math.abs(par.modifier - 1) < 0.05, `the par guild sits on it (${par.modifier})`);
  assert.ok(sprawl.modifier < 1, `the sprawling guild sits below it (${sprawl.modifier})`);
  // DENSITY BEATS SPRAWL, as one comparison: same Points, different footprint, and the
  // dense guild draws more for it.
  assert.equal(dense.gp, par.gp, 'the dense and par guilds are deliberately the SAME size');
  assert.ok(dense.desired > par.desired, 'yet the dense one draws more, purely on standing');
  // `gap` is the recorder's own presentation column; it must agree with the two figures
  // it is derived from.
  for (const g of first.guilds) assert.equal(g.gap, g.rp - g.expected);
});

test('EXPANSION IS LEAN: the sprawling guild\'s draw FALLS when it gains a venture', () => {
  // The world driver's one perturbation, and the sharpest thing in the trace: Points rise
  // the moment the venture exists while the reputation to pay for them does not, so the
  // modifier falls further than the base rises and the guild draws LESS than before.
  const cs = cycles(RUN.trace);
  const before = cs.find((l) => l.tick < FIXTURES.expansionTick);
  const after = cs.find((l) => l.tick > FIXTURES.expansionTick && !l.reserve.rationing);
  assert.ok(before && after, 'the run must span the expansion with un-rationed cycles either side');

  const a = guildIn(before, 'reach-guild');
  const b = guildIn(after, 'reach-guild');
  assert.ok(b.gp > a.gp, 'the expansion really did raise its Points');
  assert.equal(b.rp, a.rp, 'and earned it no reputation at all');
  assert.ok(b.modifier < a.modifier, 'so its standing fell…');
  assert.ok(b.desired < a.desired, '…and its draw fell with it, despite holding more');
});

// ── THE EMPTY-GUILD GUARD ──────────────────────────────────────────────────────

test('the empty-guild guard holds on EVERY tick for a guild that holds nothing', () => {
  // §3's open question #7. A guild with GP 0 has `expectedRP` 0, so `gap / expected` would
  // divide by zero; the ruled answer is a flat 1.0. This asserts it across the whole run —
  // including every rationed cycle, where the zero-ask branch of `rationGrants` must skip
  // it rather than hand it a remainder unit.
  let seen = 0;
  for (const line of RUN.trace) {
    const g = guildIn(line, EMPTY_GUILD);
    assert.ok(g, `tick ${line.tick}: the empty guild is present in the trace`);
    assert.equal(g.gp, 0, `tick ${line.tick}: it holds nothing`);
    assert.equal(g.expected, 0, `tick ${line.tick}: so nothing is expected of it`);
    assert.equal(g.modifier, 1, `tick ${line.tick}: and the guard returns exactly 1.0`);
    assert.ok(Number.isFinite(g.modifier), 'never NaN, never Infinity');
    assert.equal(g.desired, 0, `tick ${line.tick}: it is due nothing`);
    assert.equal(g.granted, 0, `tick ${line.tick}: and takes nothing`);
    assert.equal(g.hoard, 0, `tick ${line.tick}: so its hoard never moves`);
    seen += 1;
  }
  assert.equal(seen, FIXTURES.ticks, 'checked on every tick, not just one');
  // …and the run did not throw, which is the other half of the guard's job.
  assert.equal(RUN.trace.length, FIXTURES.ticks);
});

// ── READER DISCIPLINE / NO ENGINE DISTURBANCE ──────────────────────────────────

test('the recorder is a READER: it imports only advance + buildSnapshot from sim/', () => {
  // design.md §18 — the reader computes no game number. Enforced on the source rather than
  // by inspection: reaching into issuance.js or meanline.js to re-derive a grant or a
  // modifier is exactly the drift this rule exists to prevent, and it would be invisible
  // in the trace (the numbers would look right until the day they did not).
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'tools', 'run_economy.js'), 'utf8');
  const simImports = [...src.matchAll(/require\('\.\.\/sim\/([^']+)'\)/g)].map((m) => m[1]);
  // The require list is the exact statement of the rule: reaching into issuance.js or
  // meanline.js would show up here and nowhere else. (A looser scan of the whole source for
  // those filenames was tried and dropped — it fires on the file's own header comment
  // explaining that it does not import them, which is a false positive with no upside.)
  assert.deepEqual(simImports.sort(), ['run.js', 'snapshot.js'],
    'the recorder may reach into sim/ for the engine spine and nothing else');
  // It must not name the engine's own constants either, which is how a re-derivation
  // usually starts — and unlike a module name, there is no honest reason for one of these
  // to appear anywhere in a reader, comment or code.
  for (const forbidden of ['BASE_GRANT_PER_GP', 'DEUTERIUM_INFLUX_PER_CYCLE', 'MEANLINE_K', 'ISSUANCE_']) {
    assert.ok(!src.includes(forbidden), `the recorder must not name ${forbidden}`);
  }
});

test('the licence recorder beside it is UNDISTURBED — its trace is unchanged', () => {
  // This slice adds a sibling; it must not have touched `run_scenario.js`, its bot, its
  // world driver or its scenario. Two runs of the supply-relief scenario still agree with
  // each other, and its own determinism golden still holds in its own test file — here we
  // pin that the licence recorder still runs and still produces its own shape.
  const a = runScenario(buildSupplyRelief());
  const b = runScenario(buildSupplyRelief());
  assert.equal(a.jsonl, b.jsonl, 'the licence recorder is still deterministic');
  assert.ok(a.trace[0].windows !== undefined, 'and still traces its own subject (windows), not this one');
  assert.equal(a.trace[0].reserve, undefined, 'the two recorders do not share a line schema');
});

test('the recorder reads the UNCHANGED snapshot schema (this is a tools-only slice)', () => {
  // The economy recorder needed no new snapshot field: everything it traces was already
  // published by slice 5a. If this ever has to move, the slice that moves it is an engine
  // slice, not this one.
  assert.equal(SNAPSHOT_SCHEMA, 7);
});

// ── THE TRACE IS A USABLE ARTEFACT ─────────────────────────────────────────────

test('the JSONL is one well-formed line per tick, carrying the documented shape', () => {
  const parsed = RUN.jsonl.trimEnd().split('\n').map((l) => JSON.parse(l));
  assert.equal(parsed.length, FIXTURES.ticks);
  parsed.forEach((line, i) => {
    assert.equal(line.tick, i + 1, 'ticks are contiguous and 1-based');
    assert.deepEqual(Object.keys(line.reserve).sort(),
      ['level', 'rationing', 'sigmaDesired', 'sigmaGranted']);
    assert.equal(line.guilds.length, GUILDS.length, 'one row per guild, every tick');
    assert.deepEqual(line.guilds.map((g) => g.id), [...line.guilds.map((g) => g.id)].sort(),
      'in a stable order (by id), so two runs line up column for column');
    for (const g of line.guilds) {
      assert.deepEqual(Object.keys(g).sort(),
        ['desired', 'expected', 'gap', 'gp', 'granted', 'hoard', 'id', 'modifier', 'rationed', 'rp']);
    }
  });
});
