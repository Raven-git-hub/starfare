'use strict';

// control-map-strip.js — the STRIP-AND-PROVE helper of the Prefecture / claims slice, engine PR 2 (roadmap 2.5;
// docs/territory-model.md §2, the seniority control map). The same discipline as deep-scan-lane-strip.js and
// rebanded-goods-strip.js.
//
// The PR changed no serialized byte. What it DID change is derived on read: every snapshot — the god's-eye lens
// and every per-guild view alike, since the map is public — gained ONE top-level key, `controlMap`, the
// seniority-resolved control of every held hex (sim/claims.js `resolveControl`). Nothing else moved.
//
// So every snapshot golden pinned before the PR is still asserted against its old hash through this strip: take
// the key back out and the old bytes must come back exactly. That is the proof the map is the PR's ONLY snapshot
// delta. The map itself is pinned in tests/control-map.test.js.
//
// The strip REFUSES to be vacuous, two ways: a snapshot with no `controlMap` key has nothing to strip (it would
// prove nothing), and a snapshot whose `claims` hold a system but whose map is EMPTY is a map that quietly lost
// its rows — a held system always controls at least its own centre. Either throws.

// withoutControlMap(snap) -> a COPY of a snapshot (or a per-guild view) with the top-level `controlMap` deleted.
// Nothing else is touched, and a copy keeps the remaining keys in their order, so a JSON byte comparison with a
// pre-PR golden stays meaningful.
function withoutControlMap(snap) {
  if (!snap || !Array.isArray(snap.controlMap)) {
    throw new Error('control-map-strip: the snapshot carries no controlMap — nothing to strip, so it would prove nothing');
  }
  const holdsASystem = (snap.claims || []).some((c) => c.landmarkKind === 'system');
  if (holdsASystem && snap.controlMap.length === 0) {
    throw new Error('control-map-strip: a system is held, yet the controlMap is empty — a held system always controls its own centre');
  }
  const out = structuredClone(snap);
  delete out.controlMap;
  return out;
}

module.exports = { withoutControlMap };
