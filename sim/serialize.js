'use strict';

// serialize.js — canonical serialization + hashing.
//
// WHY this exists: invariant 9 (deterministic tick order) is verified by running
// the tick loop twice from the same starting state and checking the results are
// byte-identical. That check only means something if the *same logical state*
// always produces the *same bytes* — regardless of the order in which fields
// happened to be written. Plain JSON.stringify does NOT guarantee that: object
// key order follows insertion order, so two logically-identical states can
// stringify differently. canonicalize() removes that freedom by sorting keys.
//
// It is deliberately dumb: it does not know or care about game rules. Enforcing
// integers, non-negativity, conservation — that is invariants.js's job, not this.

const { createHash } = require('node:crypto');

// Return a structurally-equivalent value whose object keys are sorted, so key
// insertion order can never change the serialization.
//
// - Primitives pass through untouched.
// - Arrays keep their order: array order IS meaningful game state (a shipment
//   queue, a fixed guild roster). If the tick loop ever reorders an array
//   non-deterministically, that is a real bug and the determinism test SHOULD
//   catch it — so we do not paper over it by sorting arrays here.
// - Objects are rebuilt with sorted keys.
// - Maps are supported defensively (state uses plain objects today) and encoded
//   as a tagged, sorted-key object so their iteration order can't leak in.
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;

  if (value instanceof Map) {
    const out = {};
    for (const key of [...value.keys()].sort()) out[key] = canonicalize(value.get(key));
    return { __map__: out };
  }

  if (value instanceof Set) {
    // No Sets in state today; fail loudly rather than guess an ordering.
    throw new Error('serialize: Set is not supported in canonical state');
  }

  if (Array.isArray(value)) return value.map(canonicalize);

  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
  return out;
}

function canonicalStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function hashState(value) {
  return createHash('sha256').update(canonicalStringify(value)).digest('hex');
}

module.exports = { canonicalize, canonicalStringify, hashState };
