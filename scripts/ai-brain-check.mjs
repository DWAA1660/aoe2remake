// Calibration harness for the AI priority network.
//
// The network is hand-weighted, so the only way to know whether the weights say
// what they were meant to say is to feed it game states with an obvious right
// answer and check what comes out. Each scenario below is a situation any
// player would describe in one sentence - "it is minute two and I have met
// nobody", "they are in my town and I am losing" - together with the priorities
// that situation demands.
//
// This catches the class of bug that is otherwise invisible: a sign error deep
// in the concept layer produces a perfectly plausible-looking number, and the
// only symptom is an AI that attacks at minute one for the rest of the project's
// life.
//
//   node scripts/ai-brain-check.mjs [-v]

import { evaluate, FEATURES, CONCEPTS, PRIORITIES } from '../public/src/sim/ai-brain.js';

const verbose = process.argv.includes('-v');

/** A state where nothing in particular is happening, as the baseline to edit. */
const NEUTRAL = {
  age: 0, gameProgress: 0.05,
  villRatio: 0.3, villCount: 0.1, popFill: 0.6, popHeadroom: 0.5, popMaxFill: 0.05,
  idleVillagers: 0, tcCount: 0.25, farmCount: 0,
  floatFood: 0.15, floatWood: 0.15, floatGold: 0.1, floatStone: 0.25, floatTotal: 0.15,
  incomeFood: 0.25, incomeWood: 0.2, incomeGold: 0.15, incomeStone: 0.05, incomeTotal: 0.2,
  goldScarcity: 0.1, stoneScarcity: 0.1, woodScarcity: 0.05, foodScarcity: 0.1,
  producerIdle: 0, ecoTechProgress: 0.1,
  armyPop: 0.03, armyShare: 0.05, armyValue: 0.02, siegeShare: 0, upgradeLag: 0.2,
  castleCount: 0, towerCount: 0,
  enemyValue: 0, strengthRatio: 0.5,
  enemyCavalry: 0, enemyArcher: 0, enemyInfantry: 0, enemySiege: 0, enemyMonk: 0,
  enemyRanged: 0, counterCoverage: 1,
  threatCount: 0, threatProximity: 0, threatPersistence: 0, recentDamage: 0, buildingsLost: 0,
  explored: 0.15, mapControl: 0.5, enemyKnown: 0, enemyDistance: 0.5, forwardPresence: 0,
  relicShare: 0,
  teamSize: 0, allyUnderAttack: 0, allyStrength: 0, allyEconomy: 0, teamAggression: 0,
  marketCount: 0, tradeCarts: 0, tradePartner: 0, tradeSafety: 0,
};

const state = (over) => ({ ...NEUTRAL, ...over });

/**
 * `expect` entries are `[priority, min, max]`. Ranges are deliberately wide -
 * this is checking that the network says the right *kind* of thing, not pinning
 * it to three decimal places that any future tuning would break.
 */
const SCENARIOS = [
  {
    name: 'opening: minute two, nobody scouted',
    features: state({}),
    expect: [
      ['boom', 0.6, 1], ['scout', 0.5, 1],
      ['military', 0, 0.4], ['aggression', 0, 0.3], ['raid', 0, 0.25],
      ['trade', 0, 0.2], ['forwardCastle', 0, 0.15], ['defense', 0, 0.25],
    ],
  },
  {
    name: 'feudal rush: archers in the town, no answer to them',
    features: state({
      age: 0.33, villRatio: 0.6, explored: 0.4, enemyKnown: 1, mapControl: 0.45,
      threatCount: 0.7, threatProximity: 0.85, threatPersistence: 1, recentDamage: 0.7,
      enemyArcher: 0.8, enemyRanged: 0.8, counterCoverage: 0.15,
      strengthRatio: 0.25, enemyValue: 0.35, armyPop: 0.15, armyShare: 0.15,
    }),
    expect: [
      ['defense', 0.6, 1], ['military', 0.6, 1], ['counter', 0.6, 1],
      ['boom', 0, 0.35], ['aggression', 0, 0.3], ['forwardCastle', 0, 0.1],
      ['fortify', 0.4, 1],
    ],
  },
  {
    name: 'castle age: safe, booming, resources piling up',
    features: state({
      age: 0.66, gameProgress: 0.35, villRatio: 0.85, villCount: 0.5,
      floatFood: 0.6, floatWood: 0.6, floatGold: 0.5, floatTotal: 0.6,
      incomeFood: 0.6, incomeWood: 0.55, incomeGold: 0.4, incomeTotal: 0.6,
      tcCount: 0.4, farmCount: 0.6, ecoTechProgress: 0.5, upgradeLag: 0.6,
      armyPop: 0.35, armyShare: 0.25, strengthRatio: 0.55, enemyValue: 0.25,
      enemyKnown: 1, explored: 0.6, mapControl: 0.55, castleCount: 0.3,
    }),
    expect: [
      ['tech', 0.5, 1], ['boom', 0.4, 1], ['expand', 0.4, 1],
      ['military', 0.25, 0.8], ['defense', 0, 0.35],
    ],
  },
  {
    name: 'imperial: population capped, the gold has run out',
    features: state({
      age: 1, gameProgress: 0.9, villRatio: 1, villCount: 0.85,
      popFill: 0.98, popMaxFill: 0.95, popHeadroom: 0.05,
      floatFood: 0.75, floatWood: 0.8, floatGold: 0.08, floatStone: 0.5, floatTotal: 0.7,
      incomeFood: 0.7, incomeWood: 0.7, incomeGold: 0.08, incomeTotal: 0.65,
      goldScarcity: 0.92, tcCount: 0.6, farmCount: 0.9, ecoTechProgress: 0.85,
      armyPop: 0.6, armyShare: 0.35, strengthRatio: 0.55, enemyValue: 0.4,
      enemyKnown: 1, explored: 0.8, mapControl: 0.6, castleCount: 0.5,
      marketCount: 0.4, tradePartner: 0.8, tradeSafety: 0.8, teamSize: 0.4,
    }),
    expect: [
      ['trade', 0.6, 1], ['tech', 0.5, 1],
      ['goldWeight', 0, 0.3],           // no point mining gold that is gone
      ['boom', 0, 0.5],
    ],
  },
  {
    // Saturation, checked as a comparison rather than an absolute: a big fleet
    // does not make trade worthless, it makes *more* trade worth less. The hard
    // ceiling on fleet size lives in ai.js; what matters here is only that the
    // priority moves the right way when carts are already on the road.
    name: 'a fleet already on the road wants trade less than an empty road',
    features: state({
      age: 1, gameProgress: 0.9, villRatio: 1, villCount: 0.85, popMaxFill: 0.95,
      goldScarcity: 0.92, incomeGold: 0.5, floatGold: 0.4, floatWood: 0.7,
      marketCount: 0.4, tradePartner: 0.8, tradeSafety: 0.8, tradeCarts: 0.85,
      enemyKnown: 1, mapControl: 0.6, strengthRatio: 0.55,
    }),
    lowerThan: { key: 'trade', without: { tradeCarts: 0 }, byAtLeast: 0.2 },
    expect: [],
  },
  {
    // The failure this was written for: the AI banked gold it had nothing to
    // spend on while its food sat at twenty and every Town Center stood idle,
    // because the float features saturate too softly to tell "low" from "empty".
    name: 'starving on food while drowning in gold',
    features: state({
      age: 0.66, gameProgress: 0.5, villRatio: 0.6, villCount: 0.45, tcCount: 0.4,
      floatFood: 0.03, floatWood: 0.1, floatGold: 0.66, floatStone: 0.6, floatTotal: 0.4,
      incomeFood: 0.4, incomeWood: 0.35, incomeGold: 0.4, incomeTotal: 0.5,
      foodScarcity: 0.5, armyPop: 0.3, strengthRatio: 0.5, enemyKnown: 1,
      explored: 0.55, mapControl: 0.5, castleCount: 0.3,
    }),
    // Relative, because what matters is the ordering of the four weights, not
    // any one of their absolute values.
    expectOrder: ['foodWeight', 'goldWeight'],
    expect: [['foodWeight', 0.5, 1], ['goldWeight', 0, 0.45]],
  },
  {
    name: 'winning: bigger army, their half of the map, stone banked',
    features: state({
      age: 1, gameProgress: 0.6, villRatio: 0.95, villCount: 0.75, popMaxFill: 0.9,
      floatStone: 0.75, floatTotal: 0.6, floatGold: 0.5,
      armyPop: 0.8, armyShare: 0.4, armyValue: 0.8, strengthRatio: 0.85,
      enemyValue: 0.2, enemyKnown: 1, enemyDistance: 0.35, mapControl: 0.8,
      forwardPresence: 0.6, explored: 0.85, castleCount: 0.4, incomeTotal: 0.7,
    }),
    expect: [
      ['aggression', 0.6, 1], ['forwardCastle', 0.5, 1], ['raid', 0.5, 1],
      ['defense', 0, 0.3], ['defCastle', 0, 0.5],
    ],
  },
  {
    name: 'losing: town overrun, buildings falling, no Castle',
    features: state({
      age: 0.66, gameProgress: 0.5, villRatio: 0.6, villCount: 0.4,
      threatCount: 1, threatProximity: 0.95, threatPersistence: 1,
      recentDamage: 1, buildingsLost: 0.8,
      enemyValue: 0.8, strengthRatio: 0.15, armyPop: 0.2, armyShare: 0.2,
      enemyCavalry: 0.7, counterCoverage: 0.2, enemyKnown: 1,
      mapControl: 0.3, explored: 0.5, floatStone: 0.35, castleCount: 0,
    }),
    expect: [
      ['defense', 0.7, 1], ['defCastle', 0.5, 1], ['military', 0.6, 1],
      ['stoneWeight', 0.4, 1], ['counter', 0.6, 1],
      ['aggression', 0, 0.2], ['forwardCastle', 0, 0.1], ['boom', 0, 0.25],
      ['trade', 0, 0.3], ['raid', 0, 0.2],
    ],
  },
  {
    name: 'team: the ally is being attacked and we are not',
    features: state({
      age: 0.66, gameProgress: 0.45, villRatio: 0.8, villCount: 0.5,
      teamSize: 0.5, allyUnderAttack: 1, allyStrength: 0.25, allyEconomy: 0.5,
      armyPop: 0.5, armyShare: 0.3, strengthRatio: 0.5, enemyValue: 0.4,
      enemyKnown: 1, mapControl: 0.5, explored: 0.6, floatTotal: 0.5,
    }),
    expect: [['military', 0.4, 1], ['boom', 0, 0.7]],
  },
  {
    name: 'team: the push has been called',
    features: state({
      age: 1, gameProgress: 0.6, villRatio: 0.95, villCount: 0.75, popMaxFill: 0.85,
      teamSize: 0.5, teamAggression: 0.95, allyStrength: 0.7, allyEconomy: 0.6,
      armyPop: 0.7, armyShare: 0.4, armyValue: 0.7, strengthRatio: 0.6,
      enemyValue: 0.45, enemyKnown: 1, mapControl: 0.6, explored: 0.8,
    }),
    expect: [['aggression', 0.6, 1], ['military', 0.4, 1]],
  },
  {
    name: 'a Castle already stands over a quiet town',
    features: state({
      age: 0.66, gameProgress: 0.4, villRatio: 0.85, villCount: 0.5,
      castleCount: 0.65, towerCount: 0.5, floatStone: 0.3,
      armyPop: 0.4, strengthRatio: 0.6, enemyKnown: 1, mapControl: 0.6, explored: 0.6,
    }),
    expect: [['defCastle', 0, 0.45], ['stoneWeight', 0, 0.45], ['fortify', 0, 0.45]],
  },
];

let failures = 0;
for (const sc of SCENARIOS) {
  const { priorities, concepts } = evaluate(sc.features);
  console.log(`\n${sc.name}`);
  if (verbose) {
    console.log('  concepts  ' + CONCEPTS.map((n) => `${n}=${concepts[n].toFixed(2)}`).join(' '));
    console.log('  all       ' + PRIORITIES.map((n) => `${n}=${priorities[n].toFixed(2)}`).join(' '));
  }
  for (const [name, min, max] of sc.expect) {
    const v = priorities[name];
    const ok = v >= min && v <= max;
    if (!ok) failures++;
    console.log(`  ${ok ? '✓' : '✗'} ${name.padEnd(14)} ${v.toFixed(2)}  want ${min}..${max}`);
  }
  if (sc.expectOrder) {
    const [hi, lo] = sc.expectOrder;
    const ok = priorities[hi] > priorities[lo];
    if (!ok) failures++;
    console.log(`  ${ok ? '✓' : '✗'} ${hi} (${priorities[hi].toFixed(2)}) outranks ` +
      `${lo} (${priorities[lo].toFixed(2)})`);
  }
  if (sc.lowerThan) {
    const { key, without, byAtLeast } = sc.lowerThan;
    const other = evaluate({ ...sc.features, ...without }).priorities[key];
    const drop = other - priorities[key];
    const ok = drop >= byAtLeast;
    if (!ok) failures++;
    console.log(`  ${ok ? '✓' : '✗'} ${key.padEnd(14)} ${priorities[key].toFixed(2)} vs ` +
      `${other.toFixed(2)} without  want a drop of ${byAtLeast}+, got ${drop.toFixed(2)}`);
  }
}

// Every feature must be reachable, or it is dead weight nobody will ever notice.
const touched = new Set();
for (const sc of SCENARIOS) for (const k in sc.features) if (sc.features[k] !== 0) touched.add(k);
const untouched = FEATURES.filter((f) => !touched.has(f));
if (untouched.length) console.log(`\nnote: never exercised by a scenario: ${untouched.join(', ')}`);

console.log(`\n${failures ? `${failures} expectation(s) missed` : 'all scenarios behave'}`);
process.exitCode = failures ? 1 : 0;
