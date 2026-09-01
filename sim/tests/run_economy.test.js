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
//   - ⚠ THE FOUR-GUILD RUN CONVERGES — the pool stabilises and draw meets the influx. This
//     is what slice 5b-ii changed, and it is the load-bearing assertion now. It used to be
//     the opposite: "BOTH REGIMES really execute", because under 5a this galaxy bled its
//     pool to zero and rationed for ever, and the trace existed to make that watchable;
//   - THE CRISIS RUN still rations — a second scenario whose load exceeds what even the
//     price ceiling can throttle, so §4.1's crunch edge stays exercised rather than being
//     quietly retired along with the defect that used to reach it;
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
const {
  buildScenario, buildCrisisScenario, FIXTURES, GUILDS, CRISIS_GUILDS,
} = require('../../tools/scenarios/economy_meanline.js');
const { buildScenario: buildSupplyRelief } = require('../../tools/scenarios/supply_relief.js');
const { SNAPSHOT_SCHEMA } = require('../snapshot.js');

// --- small readers over a trace ------------------------------------------------
const cycles = (trace) => trace.filter((l) => l.reserve.sigmaDesired > 0);
const guildIn = (line, id) => line.guilds.find((g) => g.id === id);
const EMPTY_GUILD = GUILDS.find((g) => g.mines === 0 && g.systems === 0).id;

// One run, shared by the read-only assertions below. Determinism is proven separately, so
// reusing one trace here is safe and keeps the suite quick.
const RUN = runEconomy(buildScenario());
// …and the crisis run beside it (slice 5b-ii). The four-guild run above no longer rations —
// that is the win — so the crunch-edge assertions moved onto a galaxy that still does.
const CRISIS = runEconomy(buildCrisisScenario());

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

// ── THE CONTROLLER STABILISES THE GALAXY — the load-bearing one (slice 5b-ii) ──

test('THE HEADLINE: the four-guild run CONVERGES — the pool settles and draw meets the influx', () => {
  // ⚠ THIS TEST REPLACES "the run really executes BOTH regimes", which asserted that some
  // cycles were paid in full and some were rationed. That was correct under 5a and 5b-i:
  // Σdesired opened above the fixed influx, nothing pulled it back, so the pool bled to zero
  // and every cycle after the crossing was clipped. The whole purpose of 5b-ii is that this
  // no longer happens, so the assertion is INVERTED rather than deleted — and the rationing
  // it used to guarantee now has a scenario of its own, asserted further down.
  const cs = cycles(RUN.trace);
  assert.ok(cs.length >= 12, `${cs.length} cycles — enough to see a transient AND a settled tail`);

  // NOT ONE RATIONED CYCLE. The galaxy opens drawing ~987 against an influx of 800 and is
  // still paid in full throughout, because the price rises to meet the imbalance instead.
  assert.equal(cs.filter((l) => l.reserve.rationing).length, 0,
    'a throttleable galaxy never rations once the controller is live');

  // DRAW MET SUPPLY. The point of the loop, read off the trace's own Σdesired column.
  const opening = cs[0].reserve.sigmaDesired;
  const tail = cs.slice(-5);
  const influx = tail[0].reserve.level - cs[cs.length - 6].reserve.level + tail[0].reserve.sigmaGranted;
  for (const l of tail) {
    assert.ok(Math.abs(l.reserve.sigmaDesired - influx) < influx * 0.02,
      `tick ${l.tick}: settled draw ${l.reserve.sigmaDesired} is within 2% of the observed influx ${influx}`);
  }
  assert.ok(opening > influx * 1.15,
    `and it really did start well ABOVE supply (${opening} vs ${influx}) — there was an imbalance to correct`);

  // THE POOL SETTLED, positive and barely moving.
  const levels = tail.map((l) => l.reserve.level);
  assert.ok(Math.min(...levels) > 0, 'the pool is emphatically not zero');
  assert.ok(Math.max(...levels) - Math.min(...levels) < 30,
    `and has stopped moving (spread ${Math.max(...levels) - Math.min(...levels)} across five cycles)`);
});

test('the price is what does it: it rises to meet the shortfall, then settles', () => {
  // The mechanism behind the test above, made explicit — otherwise "the pool stabilised"
  // could be satisfied by a scenario that simply never had an imbalance.
  const cs = cycles(RUN.trace);
  const first = cs[0];
  const last = cs[cs.length - 1];

  assert.ok(first.reserve.price > last.reserve.price,
    'the price spikes when the pool is far below target, then eases as it refills');
  assert.ok(last.reserve.price > 1, 'and settles at a real, positive price');
  // The pool climbs toward the controller's own target, which the snapshot publishes.
  assert.ok(last.reserve.level > first.reserve.level, 'the pool recovers across the run');
  assert.ok(last.reserve.target > 0 && Number.isFinite(last.reserve.target));
  // The settled price is ABOVE the reference, because this galaxy still sits below target —
  // a converged galaxy is not necessarily a comfortable one.
  assert.ok(last.reserve.level < last.reserve.target,
    'it settles BELOW target, which is exactly why fuel stays dearer than the reference');
  // …and the tail is monotone: no ringing, which is the PRICE_SENSITIVITY 1.5 claim.
  const tail = cs.slice(-8);
  for (let i = 1; i < tail.length; i += 1) {
    assert.ok(tail[i].reserve.level >= tail[i - 1].reserve.level - 1,
      `tick ${tail[i].tick}: the settled pool must not ring`);
  }
});

test('the pool RISES back toward target instead of bleeding to zero', () => {
  // ⚠ REPLACES "the pool BLEEDS while un-rationed, then sits at zero once it cannot cover
  // the draw". Same column, opposite claim, and the inversion is the slice.
  const cs = cycles(RUN.trace);
  // One opening dip is expected and correct — the fixture seeds the pool below target — but
  // from the second cycle on it climbs, every cycle, and never returns to zero.
  for (let i = 2; i < cs.length; i += 1) {
    assert.ok(cs[i].reserve.level >= cs[i - 1].reserve.level,
      `tick ${cs[i].tick}: the pool must be climbing or holding, never bleeding`);
  }
  assert.ok(cs.every((l) => l.reserve.level > 0), 'and it never touches zero at all');
});

// ── THE CRUNCH EDGE SURVIVES — the crisis scenario (§4.1) ──────────────────────

test('THE CRISIS RUN still executes BOTH regimes: paid-in-full cycles AND rationed ones', () => {
  // The assertion the four-guild run used to carry, moved to the galaxy that still earns
  // it. Without this the suite could pass while `rationGrants`'s clip was never exercised
  // through a real multi-cycle run at all — which is precisely what would have happened if
  // the crisis scenario had not been added alongside the controller.
  const paid = CRISIS.trace.filter((l) => l.reserve.sigmaDesired > 0 && !l.reserve.rationing);
  const clipped = CRISIS.trace.filter((l) => l.reserve.rationing);

  assert.ok(paid.length >= 3, `${paid.length} un-rationed cycles — a readable opening`);
  assert.ok(clipped.length >= 3, `${clipped.length} rationed cycles — a readable tail`);
});

test('THE CRISIS: the price pins at the ceiling and demand still exceeds supply', () => {
  // What makes this galaxy a genuine crisis rather than a slow one: the controller has run
  // out of room. The price stops moving because it is clamped, and demand at that clamped
  // price is still above the influx, so no amount of further throttling could balance it.
  const cs = cycles(CRISIS.trace);
  const tail = cs.slice(-8);
  const ceiling = Math.max(...cs.map((l) => l.reserve.price));

  for (const l of tail) {
    assert.equal(l.reserve.price, ceiling, `tick ${l.tick}: pinned at the ceiling, nowhere left to go`);
    assert.ok(l.reserve.sigmaDesired > l.reserve.sigmaGranted,
      `tick ${l.tick}: and demand still outruns what the pool can cover`);
    assert.equal(l.reserve.level, 0, `tick ${l.tick}: so the pool sits at exactly zero`);
  }
  // It is the same guilds, just more of them — the claim the scenario is shaped to make.
  assert.ok(CRISIS_GUILDS.length > GUILDS.length);
  const shapes = new Set(CRISIS_GUILDS.map((g) => `${g.systems}/${g.mines}`));
  const baseShapes = new Set(GUILDS.map((g) => `${g.systems}/${g.mines}`));
  assert.deepEqual([...shapes].sort(), [...baseShapes].sort(),
    'every crisis guild is a copy of a four-guild-run guild — nothing about a guild changed');
});

test('the crisis crossing happens ONCE, mid-run, and does not reverse', () => {
  // The shape assertion the four-guild run used to carry. A scenario whose crossing drifted
  // to the first cycle, or off the end of the run, would still satisfy "at least one of
  // each" while showing nothing.
  const flags = cycles(CRISIS.trace).map((l) => l.reserve.rationing);
  const firstRationed = flags.indexOf(true);

  assert.ok(firstRationed > 0, 'the run opens un-rationed');
  assert.ok(firstRationed < flags.length - 1, 'and the crossing is not the very last cycle');
  assert.ok(flags.slice(firstRationed).every(Boolean),
    'once past what the ceiling can throttle, nothing brings this galaxy back on its own');
  assert.ok(flags.slice(0, firstRationed).every((f) => f === false));
});

// ── THE RATIONED SPLIT IS CONSERVATIVE ─────────────────────────────────────────

test('on every rationed cycle the split is conservative and nobody is over-paid', () => {
  // Reads the CRISIS trace since slice 5b-ii: the four-guild run no longer rations, so this
  // check moved to the only run that still reaches the clip. The assertions themselves are
  // untouched — the rationing rules did not change, only which galaxy can still reach them.
  const clipped = CRISIS.trace.filter((l) => l.reserve.rationing);
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

test('EXPANSION IS LEAN: the sprawling guild\'s SHARE of the galaxy\'s draw falls when it expands', () => {
  // The world driver's one perturbation, and the sharpest thing in the trace: Points rise
  // the moment the venture exists while the reputation to pay for them does not, so the
  // modifier falls further than the base rises and the guild ends up drawing LESS.
  //
  // ⚠ STATED AS A SHARE SINCE SLICE 5b-ii, and the change matters. This used to compare the
  // guild's raw `desired` before and after — which was a clean comparison while the price
  // was fixed, because `desired` was then a pure function of Points and reputation. With a
  // live price `desired` also carries whatever the controller happened to be doing that
  // cycle, so a raw before/after could pass or fail on the price transient rather than on
  // the expansion. The price scales EVERY guild's draw by the same factor, so the guild's
  // SHARE of Σdesired divides it straight back out — leaving exactly the claim intended.
  const cs = cycles(RUN.trace);
  const before = cs.find((l) => l.tick < FIXTURES.expansionTick);
  const after = cs.find((l) => l.tick > FIXTURES.expansionTick && !l.reserve.rationing);
  assert.ok(before && after, 'the run must span the expansion with un-rationed cycles either side');

  const a = guildIn(before, 'reach-guild');
  const b = guildIn(after, 'reach-guild');
  assert.ok(b.gp > a.gp, 'the expansion really did raise its Points');
  assert.equal(b.rp, a.rp, 'and earned it no reputation at all');
  assert.ok(b.modifier < a.modifier, 'so its standing fell…');

  const shareBefore = a.desired / before.reserve.sigmaDesired;
  const shareAfter = b.desired / after.reserve.sigmaDesired;
  assert.ok(shareAfter < shareBefore,
    `…and its share of the galaxy's fuel fell with it (${shareBefore.toFixed(4)} -> ${shareAfter.toFixed(4)}), despite holding more`);
  // The price really was different across the two cycles, which is why the share form is
  // the honest comparison rather than a stylistic preference.
  assert.notEqual(before.reserve.price, after.reserve.price);
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
  // The five controller coefficients join the list in slice 5b-ii, for the same reason and
  // with the same force: the recorder READS the price, the average and the target off the
  // snapshot, and re-deriving any of them from a constant is the drift this rule prevents.
  for (const forbidden of [
    'BASE_GRANT_PER_GP', 'DEUTERIUM_INFLUX_PER_CYCLE', 'MEANLINE_K', 'ISSUANCE_',
    'PRICE_SENSITIVITY', 'TARGET_CYCLES', 'DRAW_EMA_ALPHA', 'PRICE_FLOOR', 'PRICE_CEIL',
  ]) {
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

test('the snapshot schema is still 7 — the controller\'s fields are ADDITIVE', () => {
  // The recorder slice needed no new snapshot field at all; slice 5b-ii added three
  // (`fuelPrice` in 5b-i, then `avgDraw` and `targetReserve`) and still did not bump the
  // schema, because nothing existing changed shape. An older reader ignores the new keys.
  assert.equal(SNAPSHOT_SCHEMA, 7);
});

// ── THE TRACE IS A USABLE ARTEFACT ─────────────────────────────────────────────

test('the JSONL is one well-formed line per tick, carrying the documented shape', () => {
  const parsed = RUN.jsonl.trimEnd().split('\n').map((l) => JSON.parse(l));
  assert.equal(parsed.length, FIXTURES.ticks);
  parsed.forEach((line, i) => {
    assert.equal(line.tick, i + 1, 'ticks are contiguous and 1-based');
    // The reserve block gained the controller's own three readings in slice 5b-ii — the
    // price it posted, the demand average it steered by, and the target that average
    // implies. All three are READ from the snapshot; the recorder still derives nothing.
    assert.deepEqual(Object.keys(line.reserve).sort(),
      ['avgDraw', 'level', 'price', 'rationing', 'sigmaDesired', 'sigmaGranted', 'target']);
    assert.ok(line.reserve.price > 0 && Number.isFinite(line.reserve.price));
    assert.ok(line.reserve.avgDraw >= 0 && Number.isFinite(line.reserve.avgDraw));
    assert.ok(line.reserve.target >= 0 && Number.isFinite(line.reserve.target));
    assert.equal(line.guilds.length, GUILDS.length, 'one row per guild, every tick');
    assert.deepEqual(line.guilds.map((g) => g.id), [...line.guilds.map((g) => g.id)].sort(),
      'in a stable order (by id), so two runs line up column for column');
    for (const g of line.guilds) {
      assert.deepEqual(Object.keys(g).sort(),
        ['desired', 'expected', 'gap', 'gp', 'granted', 'hoard', 'id', 'modifier', 'rationed', 'rp']);
    }
  });
});
