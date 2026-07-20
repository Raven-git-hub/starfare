'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { canonicalStringify, hashState } = require('../serialize.js');

test('key order does not change the hash', () => {
  const a = { credits: 100, fuelHoard: 5, id: 'g1' };
  const b = { id: 'g1', fuelHoard: 5, credits: 100 }; // same content, different order
  assert.equal(hashState(a), hashState(b));
});

test('nested key order does not change the hash', () => {
  const a = { guild: { credits: 1, hoard: 2 }, reserve: { level: 30 } };
  const b = { reserve: { level: 30 }, guild: { hoard: 2, credits: 1 } };
  assert.equal(hashState(a), hashState(b));
});

test('changing any value changes the hash', () => {
  const a = { credits: 100 };
  const b = { credits: 101 };
  assert.notEqual(hashState(a), hashState(b));
});

test('array order IS significant (it is real game state)', () => {
  const a = { queue: [1, 2, 3] };
  const b = { queue: [3, 2, 1] };
  assert.notEqual(hashState(a), hashState(b));
});

test('Maps hash independent of insertion order', () => {
  const a = { m: new Map([['b', 2], ['a', 1]]) };
  const b = { m: new Map([['a', 1], ['b', 2]]) };
  assert.equal(hashState(a), hashState(b));
});

test('canonicalStringify is stable and sorted', () => {
  assert.equal(canonicalStringify({ b: 1, a: 2 }), '{"a":2,"b":1}');
});
