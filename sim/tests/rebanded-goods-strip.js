'use strict';

// rebanded-goods-strip.js — the Prefecture / claims slice's STRIP-AND-PROVE helper (roadmap 2.5; the same
// discipline as deep-scan-lane-strip.js).
//
// The slice changed exactly one thing every existing state and snapshot carries: it RE-BANDED two Tier-3
// modules, `claim_beacon` (→ sub-tier 3-2) and `habitation_module` (→ 3-3), because the Prefecture bill is the
// first to use them (docs/phase-1-tuning.md, RULED 16-10-26). Their seeded price rows moved — the posted price,
// the price history, the quote ring, and the snapshot's price fields — and, being newly TIMED, they joined the
// snapshot's `tier3Contract`. Nothing else may move for a galaxy that plants no Prefecture.
//
// `withoutRebandedGoods(x)` takes those two goods back out — every object key named for either, at any depth —
// so the rest of the bytes can be compared with what 79807db (the commit before the slice) produced. It keeps
// every other key in its order, so a JSON byte comparison stays meaningful too.
//
// It REFUSES to be vacuous: a state or snapshot that carries no key for either good has nothing to strip, and a
// strip that took nothing away would prove nothing — so it throws.

const REBANDED_GOODS = Object.freeze(['claim_beacon', 'habitation_module']);

function withoutRebandedGoods(value) {
  let removed = 0;
  const strip = (v) => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(strip);
    const out = {};
    for (const k of Object.keys(v)) {
      if (REBANDED_GOODS.includes(k)) { removed += 1; continue; }
      out[k] = strip(v[k]);
    }
    return out;
  };
  const out = strip(value);
  if (removed === 0) {
    throw new Error('rebanded-goods-strip: no claim_beacon / habitation_module key to strip — the strip would prove nothing');
  }
  return out;
}

module.exports = { withoutRebandedGoods, REBANDED_GOODS };
