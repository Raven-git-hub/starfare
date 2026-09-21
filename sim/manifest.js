'use strict';

// manifest.js — THE ONE manifest resolver (design.md §4 "Resolving a manifest"). A manifest is an
// ordered list of lines that fills and empties a craft's hold against a store; resolving it moves
// goods between the two. A line is either `{ dir: 'load' | 'unload', good, qty }` for a fixed AMOUNT
// (a positive integer) or `{ dir, good, max: true }` (no `qty`) for MAX — as much as the source holds
// and the destination can take (§4). This file is that move, and NOTHING ELSE spells it — the
// instant-at-a-SYSTEM path (sim/actions.js `transferCargo`) and the at-completion-in-a-SLOT path
// (sim/tick.js the Outpost dock step) both call in here, so a system transfer and an Outpost transfer
// can never drift.
//
// The fixed order is ALL UNLOADS FIRST, THEN ALL LOADS (§4). Unloads-before-loads is deliberate:
// dropping cargo frees the hold space the loads then use, so an incomplete unload (a full Outpost —
// the rare case in good play) CASCADES into a smaller load with no special case. Every line moves
// `min(qty, source holds, destination's remaining space)` against the LIVE running totals — a MAX
// line drops the `qty` term (moves `min(source holds, destination's remaining space)`) — so it is
// PARTIAL-SAFE by construction: a full hold, a full Outpost (its hard cap), or a good running out each
// simply clamp the line, and a line that can move nothing moves nothing.
//
// The two stores are abstracted so one function serves both:
//   hold      — the craft's `cargo` map (good→int), MUTATED IN PLACE, capped by `capacity` in the
//               `Σ qty × volumeOf` cargo-space unit. Kept omit-when-empty (a key hitting 0 is
//               deleted), so a craft emptied by an unload is byte-identical to one that never loaded.
//   store     — the destination the hold moves against: `{ get(good), add(good, delta), freeSpace() }`.
//               `get`/`add` read and write the store's holding of a good. `freeSpace()` is the store's
//               remaining CARGO SPACE for an unload — `Infinity` for a soft-capped SYSTEM pool (an
//               unload is bounded only by the hold), `capacity − used` for a hard-capped OUTPOST
//               stockpile (the partial-unload case). A LOAD reads `store.get` and pulls with `store.add`.
//
// Goods are integers throughout (§15.2); `volumeOf` is a positive integer, so every per-unit floor is
// exact. Every good in a resolved manifest is a real stockpile good (the transfer gate proves it), so
// `volumeOf` never throws here.

const { volumeOf } = require('./fuel.js');

// usedSpace(map) -> the cargo space `Σ qty × volumeOf(good)` a good→int map (a hold OR an Outpost
// stockpile) occupies. The one home of that sum, shared by the resolver's live hold-space check and
// by callers sizing a store's free room; replaces sim/actions.js's former local `holdUsedSpace`.
function usedSpace(map) {
  return Object.entries(map || {}).reduce((sum, [good, qty]) => sum + (qty * volumeOf(good)), 0);
}

// A manifest line carries EITHER a fixed amount (`qty`, a positive integer) OR `max: true` (no `qty`)
// — never both, never neither (design.md §4). These two helpers are the ONE spelling of that shape,
// shared by the transfer gate (sim/actions.js), the dock-integrity invariant (sim/invariants.js), the
// resolver below, and the queue/snapshot copy — so nothing can disagree on what a max line is.

// manifestAmountError(l) -> a short reason string for a malformed amount/max part, or null when the
// part is well-formed. `l.dir` / `l.good` are checked by the caller; this judges ONLY qty-vs-max.
function manifestAmountError(l) {
  const hasQty = l.qty !== undefined;
  const hasMax = l.max !== undefined;
  if (hasQty && hasMax) return 'a manifest line has qty AND max — give exactly one (§4)';
  if (!hasQty && !hasMax) return 'a manifest line needs a positive-integer qty OR max: true (§4)';
  if (hasMax && l.max !== true) return `manifest line max must be the boolean true, got ${JSON.stringify(l.max)}`;
  if (hasQty && (typeof l.qty !== 'number' || !Number.isInteger(l.qty) || l.qty <= 0)) {
    return `manifest line qty must be a positive integer (§15.2), got ${JSON.stringify(l.qty)}`;
  }
  return null;
}

// copyManifestLine(l) -> a FRESH copy of a (well-formed) line in its canonical shape: an AMOUNT line
// is `{ dir, good, qty }`, a MAX line is `{ dir, good, max: true }` — NEVER a `qty: undefined`, so a
// reader can always tell the two apart. The one place the two-shape copy is spelled, shared by the
// outpost-queue deep-copy (sim/actions.js) and the snapshot's queue/slots mapping (sim/snapshot.js).
function copyManifestLine(l) {
  return l.max
    ? { dir: l.dir, good: l.good, max: true }
    : { dir: l.dir, good: l.good, qty: l.qty };
}

// resolveManifest(hold, capacity, store, manifest) -> mutates `hold` and `store` in place per the
// manifest; returns nothing (the caller reads the mutated hold/store back). `capacity` is the hold's
// cargo-space cap. See the header for the store contract and the ordering guarantees.
function resolveManifest(hold, capacity, store, manifest) {
  // move `n` units of `good`: LOADING pulls store→hold (+hold, −store); UNLOADING pushes hold→store
  // (−hold, +store). `n` is always ≥ 0 here (a clamped move) and 0 moves nothing (partial-safe).
  const move = (good, n, loading) => {
    if (n <= 0) return;
    hold[good] = (hold[good] || 0) + (loading ? n : -n);
    if (hold[good] === 0) delete hold[good];
    store.add(good, loading ? -n : n);
  };

  // The line's `qty` cap, or Infinity for a MAX line (§4 — a max line carries no cap). Expressed as
  // Infinity so the `qty` term simply drops OUT of the min clamps below with no special branch: the
  // same clamp against the LIVE running totals then greedily takes whatever room/stock the phase has
  // left, which is exactly the design's "consumes whatever its phase has left, order-decided" rule.
  const qtyCap = (line) => (line.max ? Infinity : line.qty);

  // ALL UNLOADS FIRST — clamped by what the hold holds AND the store's LIVE remaining space
  // (`floor(freeSpace / volumeOf)`). A soft-capped system pool reports `Infinity`, so the clamp is
  // just what the hold holds; a hard-capped Outpost PARTIALS the unload when it is full. `freeSpace`
  // is re-read per line, so two unloads into a filling Outpost clamp deterministically in listed order.
  for (const line of manifest) {
    if (line.dir !== 'unload') continue;
    const room = store.freeSpace();
    const byRoom = room === Infinity ? Infinity : Math.floor(room / volumeOf(line.good));
    move(line.good, Math.min(qtyCap(line), hold[line.good] || 0, byRoom), false);
  }
  // THEN ALL LOADS — each clamped by the store's holding AND the hold's LIVE remaining space
  // (`capacity − usedSpace(hold)`, recomputed per line so an incomplete unload correctly shrinks it).
  // A good the store lacks, or a hold with no room, simply loads 0 — the rest of the manifest still
  // resolves.
  for (const line of manifest) {
    if (line.dir !== 'load') continue;
    const free = capacity - usedSpace(hold);
    const bySpace = Math.floor(free / volumeOf(line.good));
    move(line.good, Math.min(qtyCap(line), store.get(line.good), bySpace), true);
  }
}

module.exports = { resolveManifest, usedSpace, manifestAmountError, copyManifestLine };
