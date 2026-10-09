'use strict';

// slot-strip.js — the settlement-surface slice's STRIP-AND-PROVE helpers (roadmap 2.5, the settlement-surface
// engine slice — ruling 12 slice 1; docs/exploration-model.md §4 ruling 10, §7).
//
// The slice added ONE thing, in two places: a `slots` map beside `nodes` —
//   1. in every entry of every guild's exploration RECORD (state), and
//   2. in every planet entry of the per-guild view's `geography.known`.
// Every golden pinned before the slice is still asserted, through these strips: take the slots back out and
// the old bytes must come back exactly. That is the proof the slots are the slice's ONLY delta. The full new
// bytes are pinned beside each old one, so later drift is caught too.
//
// Each strip also COUNTS the slot facts it removed, so a test can assert the strip had something to take —
// a strip that removed nothing would prove nothing.

// withoutRecordSlots(state) -> { state, count }: a COPY of `state` with the `slots` key deleted from every
// guild's exploration-record entry, and how many slot facts those maps held. Nothing else is touched.
function withoutRecordSlots(state) {
  const out = structuredClone(state);
  let count = 0;
  for (const g of out.guilds || []) {
    for (const entry of Object.values(g.exploration || {})) {
      count += Object.keys(entry.slots).length;
      delete entry.slots;
    }
  }
  return { state: out, count };
}

// withoutKnownSlots(view) -> { view, count }: a COPY of a per-guild view with the `slots` key deleted from
// every `geography.known` planet entry, and how many slots those maps held. A copy keeps its keys' order, so
// the remaining entry is `{ archetype, nodes }` exactly as the view used to serialize it.
function withoutKnownSlots(view) {
  const out = structuredClone(view);
  let count = 0;
  for (const planets of Object.values(out.geography.known)) {
    for (const entry of Object.values(planets)) {
      count += Object.keys(entry.slots).length;
      delete entry.slots;
    }
  }
  return { view: out, count };
}

// The two strips, as plain functions for a test that only wants the bytes.
const stripRecordSlots = (state) => withoutRecordSlots(state).state;
const stripKnownSlots = (view) => withoutKnownSlots(view).view;

module.exports = { withoutRecordSlots, withoutKnownSlots, stripRecordSlots, stripKnownSlots };
