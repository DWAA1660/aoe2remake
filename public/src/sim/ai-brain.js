// The AI's priority network.
//
// The old AI made every decision with an independent hard-coded rule: "build a
// Castle if raided", "make villagers until 130", "attack at 18 units". Those
// rules never see each other, so the AI could not express anything that depends
// on two facts at once - it would keep booming while losing, or turtle while
// three ages ahead, because no single rule knew both halves.
//
// This is a small feed-forward network instead. Roughly sixty normalised
// readings of the game state go in; eighteen priorities in 0..1 come out, and
// everything in ai.js is a function of those priorities rather than of raw
// counters. In between sits one hidden layer of *named* concepts - "we are
// safe", "the economy is starving", "we have the military edge" - so the
// weights stay readable and tunable by hand rather than being an opaque matrix.
//
// The weights are authored, not trained: there is no dataset of won games to
// learn from, and a hand-weighted net that can be reasoned about is worth more
// here than a learned one that cannot. The structure is a real forward pass
// though - two logistic layers, plus skip connections straight from the inputs
// to the outputs for the relationships that need no intermediate concept.
//
// Both layers are logistic rather than tanh on purpose. A tanh concept reads
// *negative* when it is absent, which silently inverts every negative weight
// hanging off it: "aggression falls when we are at a military deficit" became
// "not being at a deficit actively makes us aggressive", and the AI opened
// every game at maximum aggression having never laid eyes on an opponent. An
// absent concept has to read as zero, not as minus one.

/* ================================================================
 *  Layer names
 * ================================================================ */

/**
 * Everything the network can see, in a fixed order. Every entry is normalised
 * to roughly 0..1 (a few are allowed to run to ~1.5 when they are ratios that
 * can legitimately blow past parity) so one reading cannot dominate purely
 * because it is measured in a bigger unit.
 *
 * Anything counted in population - villagers, army, spare housing, trade carts -
 * is normalised against the game's population limit rather than a constant.
 * That limit is a setting and runs from 50 to 1000, so a fixed saturation point
 * would tell the network "this economy is enormous" at one setting and "this
 * economy has barely started" at another for the same well-played game.
 */
export const FEATURES = [
  /* --- where we are in the game --- */
  'age',                // 0..1 across Dark -> Imperial
  'gameProgress',       // elapsed time, saturating around an hour
  /* --- economy --- */
  'villRatio',          // villagers as a fraction of the age's target
  'villCount',          // villagers, against a share of the population limit
  'popFill',            // pop / current housing cap
  'popHeadroom',        // spare population, against a share of the limit
  'popMaxFill',         // pop / the game's hard limit
  'idleVillagers',      // fraction of the town standing around
  'tcCount',            // Town Centers, saturating at 6
  'farmCount',          // farms, against a share of the population limit
  'floatFood', 'floatWood', 'floatGold', 'floatStone',
  'floatTotal',         // everything banked, saturating around 4000
  'incomeFood', 'incomeWood', 'incomeGold', 'incomeStone',
  'incomeTotal',        // per-minute gather rate, saturating around 2500
  'goldScarcity',       // how little minable gold is left near home
  'stoneScarcity',
  'woodScarcity',
  'foodScarcity',       // bank is low *and* income is low
  'producerIdle',       // fraction of military buildings with an empty queue
  'ecoTechProgress',    // economy upgrades bought, out of the ones available
  /* --- our army --- */
  'armyPop',            // army population, against a share of the limit
  'armyShare',          // army pop / total pop
  'armyValue',          // resource value of the standing army
  'siegeShare',         // how much of our army is siege
  'upgradeLag',         // unit upgrades we could have bought and have not
  'castleCount',
  'towerCount',
  /* --- what we know about theirs --- */
  'enemyValue',         // resource value of everything we have seen of theirs
  'strengthRatio',      // ours / (ours + theirs); 0.5 is parity
  'enemyCavalry', 'enemyArcher', 'enemyInfantry', 'enemySiege', 'enemyMonk',
  'enemyRanged',        // archers of any kind, mounted or not
  'counterCoverage',    // how well what we field already answers what they field
  /* --- pressure --- */
  'threatCount',        // enemy soldiers inside our town
  'threatProximity',    // how deep into the town the nearest one is
  'threatPersistence',  // the latched "we are under attack" state
  'recentDamage',       // our things hurt in the last few seconds
  'buildingsLost',      // buildings lost so far, saturating at 8
  /* --- the map --- */
  'explored',           // fraction of the map we have ever seen
  'mapControl',         // our share of the buildings standing on the map
  'enemyKnown',         // do we know where they live at all
  'enemyDistance',      // how far their nearest known town is
  'forwardPresence',    // our soldiers closer to their town than to ours
  'relicShare',         // relics we hold, out of what we have seen
  /* --- the team --- */
  'teamSize',           // allies still alive, saturating at 3
  'allyUnderAttack',
  'allyStrength',       // our allies' combined army, saturating at 60 pop
  'allyEconomy',        // our allies' combined villagers, as a share of the limit
  'teamAggression',     // the team-level agreement to push, set by TeamBrain
  /* --- trade --- */
  'marketCount',
  'tradeCarts',         // carts on the road, against a share of the limit
  'tradePartner',       // quality of the best trade route available
  'tradeSafety',        // how safe that route is
];

/**
 * The hidden layer. These are not arbitrary - each one is a judgement a human
 * player makes out loud ("I'm safe", "I'm behind on army") and the outputs are
 * written in terms of them, which is what keeps the weight tables legible.
 */
export const CONCEPTS = [
  'safety',           // nobody is hurting us right now
  'emergency',        // they are in the town and we are losing things
  'ecoHealth',        // the economy is large and working
  'ecoStarved',       // income cannot pay for what we want to do
  'militaryEdge',     // our army beats what we have seen of theirs
  'militaryDeficit',  // theirs beats ours
  'lateGame',         // Imperial, big pop, long clock
  'resourceGlut',     // banked resources doing nothing
  'goldCrisis',       // gold income is drying up
  'mapDominance',     // we own more of the map than they do
  'teamNeed',         // an ally needs help
  'expansionRoom',    // there is unclaimed economy worth taking
  'techWindow',       // a good moment to spend on upgrades
  'siegeNeed',        // there are buildings in our way
  'tradeWindow',      // trade would pay better than mining
  'counterGap',       // what they field is not answered by what we field
];

/**
 * The priorities everything in ai.js reads. All 0..1.
 *
 * The four resource weights are outputs like any other: what the economy should
 * be gathering is a decision that depends on threat, army composition, trade and
 * the float all at once, which is exactly the kind of thing a flat table of
 * per-age splits could never express.
 */
export const PRIORITIES = [
  'boom',          // villager production, extra Town Centers
  'military',      // how hard to push unit production
  'defense',       // home defence: garrison, towers over the town
  'fortify',       // stone defences generally - towers, walls, keeps
  'defCastle',     // a Castle covering our own economy
  'forwardCastle', // a Castle planted inside their reach
  'aggression',    // willingness to commit the army to an attack
  'raid',          // peel fast units off to hunt their villagers
  'tech',          // research intensity
  'expand',        // new Town Centers and camps away from home
  'trade',         // Markets and Trade Carts
  'siege',         // siege share of the army
  'monk',          // Monastery, Monks, relics
  'counter',       // bias composition toward counters vs. a generic backbone
  'scout',         // spend unit-time on map information
  'foodWeight', 'woodWeight', 'goldWeight', 'stoneWeight',
];

/* ================================================================
 *  Weights
 * ================================================================ */

/**
 * Input -> concept. Read each block as a sentence: "safety is high when nothing
 * is near the town, and lower the deeper into it they are".
 *
 * Anything not listed is zero, which is the point of the sparse notation - a
 * dense 62x16 matrix would be unreadable and most of it would be noise.
 */
const IN_TO_CONCEPT = {
  safety: {
    threatCount: -1.6, threatProximity: -1.3, threatPersistence: -1.1,
    recentDamage: -0.8, buildingsLost: -0.5,
    castleCount: 0.7, towerCount: 0.4, armyShare: 0.5, strengthRatio: 0.6,
    _bias: 0.9,
  },
  emergency: {
    threatCount: 1.7, threatProximity: 1.5, threatPersistence: 0.9,
    buildingsLost: 0.9, recentDamage: 0.7,
    castleCount: -0.8, towerCount: -0.4, strengthRatio: -0.9,
    _bias: -1.5,
  },
  ecoHealth: {
    villRatio: 1.2, villCount: 0.9, incomeTotal: 1.0, tcCount: 0.6,
    farmCount: 0.4, ecoTechProgress: 0.4,
    idleVillagers: -1.0, foodScarcity: -0.5,
    _bias: -0.6,
  },
  ecoStarved: {
    foodScarcity: 1.2, woodScarcity: 0.9, goldScarcity: 0.7,
    idleVillagers: 0.8, incomeTotal: -1.3, villRatio: -0.8,
    _bias: -0.5,
  },
  militaryEdge: {
    strengthRatio: 2.0, armyPop: 0.7, upgradeLag: -0.6,
    forwardPresence: 0.4, allyStrength: 0.5,
    _bias: -1.6,
  },
  militaryDeficit: {
    strengthRatio: -2.0, enemyValue: 0.8, armyPop: -0.6, upgradeLag: 0.5,
    threatCount: 0.5,
    _bias: 0.1,
  },
  lateGame: {
    age: 1.4, gameProgress: 1.1, popMaxFill: 0.9, villCount: 0.5,
    _bias: -1.6,
  },
  resourceGlut: {
    floatTotal: 1.6, floatFood: 0.5, floatWood: 0.5, floatGold: 0.5,
    popMaxFill: 0.5, producerIdle: 0.6,
    incomeTotal: -0.2,
    _bias: -1.2,
  },
  goldCrisis: {
    goldScarcity: 1.8, incomeGold: -1.1, floatGold: -0.9, age: 0.5,
    _bias: -1.6,
  },
  mapDominance: {
    mapControl: 1.7, explored: 0.5, forwardPresence: 0.6, strengthRatio: 0.5,
    buildingsLost: -0.4,
    _bias: -1.3,
  },
  teamNeed: {
    allyUnderAttack: 1.6, teamSize: 0.3, allyStrength: -0.7, allyEconomy: -0.3,
    _bias: -0.9,
  },
  expansionRoom: {
    explored: 0.6, mapControl: 0.5, safetyProxy: 0, villRatio: 0.7,
    floatWood: 0.8, tcCount: -0.9, threatCount: -0.8, goldScarcity: 0.4,
    _bias: -0.5,
  },
  techWindow: {
    floatTotal: 1.0, villRatio: 0.8, popMaxFill: 0.9, age: 0.6,
    upgradeLag: 0.7, ecoTechProgress: -0.4, threatCount: -0.5,
    _bias: -1.1,
  },
  siegeNeed: {
    enemyKnown: 0.7, castleCount: 0, age: 0.6, forwardPresence: 0.5,
    mapControl: -0.4, enemyValue: 0.3,
    _bias: -1.4,
  },
  tradeWindow: {
    goldScarcity: 1.4, age: 0.9, marketCount: 0.6, teamSize: 0.7,
    floatWood: 0.6, tradePartner: 0.9, tradeSafety: 0.5, villCount: 0.5,
    threatCount: -0.6,
    _bias: -2.4,
  },
  counterGap: {
    counterCoverage: -1.9, enemyValue: 0.7, threatPersistence: 0.6,
    enemySiege: 0.3,
    _bias: 0.2,
  },
};

/**
 * Concept -> priority. This is where the actual strategy lives.
 */
const CONCEPT_TO_PRIORITY = {
  boom: {
    safety: 1.1, ecoHealth: 0.3, expansionRoom: 0.5, militaryEdge: 0.4,
    emergency: -1.6, militaryDeficit: -0.8, lateGame: -0.9, ecoStarved: 0.4,
    _bias: 0.2,
  },
  military: {
    militaryDeficit: 1.5, emergency: 1.2, counterGap: 0.7, lateGame: 0.8,
    resourceGlut: 0.7, teamNeed: 0.9,
    safety: -0.7, ecoStarved: -0.5,
    _bias: -1.8,
  },
  defense: {
    emergency: 1.9, militaryDeficit: 0.9, teamNeed: 0.4,
    safety: -1.5, militaryEdge: -0.5,
    _bias: -0.7,
  },
  fortify: {
    emergency: 1.3, militaryDeficit: 0.9, resourceGlut: 0.6, lateGame: 0.4,
    mapDominance: -0.4, safety: -0.9,
    _bias: -0.7,
  },
  defCastle: {
    emergency: 1.7, militaryDeficit: 1.0, ecoHealth: 0.4, lateGame: 0.5,
    safety: -1.1, mapDominance: -0.3,
    _bias: -0.8,
  },
  forwardCastle: {
    militaryEdge: 1.6, mapDominance: 1.2, resourceGlut: 0.8, lateGame: 0.6,
    emergency: -1.8, militaryDeficit: -1.4, ecoStarved: -0.6,
    _bias: -2.4,
  },
  aggression: {
    militaryEdge: 1.8, mapDominance: 0.7, resourceGlut: 0.5, lateGame: 0.5,
    teamNeed: 0.4,
    militaryDeficit: -1.5, emergency: -1.2, ecoStarved: -0.3,
    _bias: -1.6,
  },
  raid: {
    militaryEdge: 0.9, mapDominance: 0.6, safety: 0.4, lateGame: 0.3,
    emergency: -1.4, militaryDeficit: -0.5,
    _bias: -1.8,
  },
  tech: {
    techWindow: 1.7, resourceGlut: 1.0, lateGame: 0.7, ecoHealth: 0.5,
    ecoStarved: -0.9, emergency: -0.7,
    _bias: -0.9,
  },
  expand: {
    expansionRoom: 1.6, safety: 0.8, ecoHealth: 0.6, resourceGlut: 0.6,
    emergency: -1.7, militaryDeficit: -0.6, lateGame: -0.3,
    _bias: -0.6,
  },
  trade: {
    tradeWindow: 2.0, goldCrisis: 1.3, lateGame: 0.9, safety: 0.3,
    resourceGlut: 0.4,
    emergency: -1.3, militaryDeficit: -0.4,
    _bias: -2.4,
  },
  siege: {
    siegeNeed: 1.5, lateGame: 0.6, militaryEdge: 0.5, mapDominance: 0.4,
    emergency: -0.8,
    _bias: -1.6,
  },
  monk: {
    lateGame: 0.8, safety: 0.6, resourceGlut: 0.5, counterGap: 0.4,
    emergency: -0.9, ecoStarved: -0.5,
    _bias: -1.6,
  },
  counter: {
    counterGap: 1.9, militaryDeficit: 0.8, emergency: 0.7,
    militaryEdge: -0.5,
    _bias: -0.2,
  },
  scout: {
    safety: 0.7, ecoHealth: 0.3,
    mapDominance: -0.6, emergency: -1.1, lateGame: -0.4,
    _bias: 0.6,
  },
  foodWeight: {
    ecoHealth: 0.3, militaryDeficit: 0.4, lateGame: 0.2,
    _bias: 0.55,
  },
  woodWeight: {
    expansionRoom: 0.7, tradeWindow: 0.5, ecoHealth: 0.2, lateGame: 0.3,
    _bias: 0.0,
  },
  goldWeight: {
    militaryDeficit: 0.5, lateGame: 0.5, counterGap: 0.3,
    goldCrisis: -0.6,          // no point mining gold that is not there
    _bias: -1.0,
  },
  stoneWeight: {
    emergency: 1.4, siegeNeed: 0.2, mapDominance: 0.3,
    safety: -0.5, lateGame: -0.2,
    _bias: -1.4,
  },
};

/**
 * Skip connections: input straight to priority, for the relationships that are
 * direct enough that routing them through a concept would only blur them. A
 * Castle's stone cost has to be wanted when there is no stone, not when some
 * abstraction says "emergency".
 */
const IN_TO_PRIORITY = {
  boom: { villRatio: -1.4, popMaxFill: -0.8, idleVillagers: -0.5, tcCount: -0.2, age: 0.3 },
  military: { armyShare: -1.1, popHeadroom: 0.4, producerIdle: 0.5, age: 0.4,
    threatCount: 0.6, enemyValue: 0.4, teamAggression: 0.5, allyUnderAttack: 0.6 },
  defense: { threatProximity: 0.9, threatCount: 0.8, recentDamage: 0.5 },
  fortify: { floatStone: 0.7, castleCount: -0.3, towerCount: -0.7, age: 0.3 },
  defCastle: { floatStone: 1.0, castleCount: -1.3, age: 0.5, villCount: 0.3 },
  forwardCastle: { floatStone: 1.1, enemyKnown: 0.9, enemyDistance: -0.5,
    castleCount: 0.4, age: 0.6, armyPop: 0.5 },
  aggression: { armyPop: 0.9, popMaxFill: 0.8, teamAggression: 1.0, enemyKnown: 0.7,
    threatCount: -0.3, age: 0.3 },
  raid: { armyPop: 0.5, enemyKnown: 1.2, enemyDistance: -0.3, siegeShare: -0.3 },
  tech: { floatTotal: 0.8, upgradeLag: 0.9, popMaxFill: 0.7, villRatio: 0.4 },
  expand: { floatWood: 0.9, tcCount: -1.2, villRatio: 0.5, goldScarcity: 0.3 },
  trade: { goldScarcity: 1.2, marketCount: 0.5, tradeCarts: -4.0, floatWood: 0.6,
    teamSize: 0.6, age: 0.7, tradePartner: 0.8, tradeSafety: 0.4 },
  siege: { enemyKnown: 0.5, siegeShare: -1.4, age: 0.5, mapControl: -0.3 },
  monk: { relicShare: -0.6, age: 0.5, enemyValue: 0.2 },
  counter: { counterCoverage: -1.2, threatCount: 0.5 },
  scout: { explored: -1.6, enemyKnown: -1.0, age: -0.2 },
  // The age is the strongest single statement about which resources a plan
  // needs. A Dark Age wants food and wood and has literally nothing to spend
  // gold or stone on; an Imperial army is mostly gold. Without this the
  // network split the opening economy four ways and spent the Dark Age mining
  // gold it could not use, reaching Feudal four minutes late.
  // `foodScarcity` and not a plain "is the bank low" reading. A low stockpile
  // on its own is the normal state of a working economy - food arrives and is
  // immediately spent on villagers - and weighting it pulls the gather split
  // toward whichever resource was spent most recently. Measured, that turned
  // into an equalising attractor: the AI held all four resources near five
  // hundred, never accumulated the 1000-food lump the Imperial Age costs, and
  // finished 45 minutes with 57 villagers instead of 101. `foodScarcity` is
  // the honest signal, because it requires the *income* to be near zero too -
  // that is an economy that has stalled rather than one that is spending.
  foodWeight: { floatFood: -1.5, incomeFood: -0.5, villRatio: -0.6, armyShare: 0.4,
    age: -0.7, foodScarcity: 1.0 },
  woodWeight: { floatWood: -1.5, incomeWood: -0.5, woodScarcity: 0.2, farmCount: 0.3,
    age: -0.1 },
  goldWeight: { floatGold: -1.5, incomeGold: -0.4, goldScarcity: -2.2, armyShare: 0.5,
    age: 1.4 },
  stoneWeight: { floatStone: -1.4, stoneScarcity: -0.9, castleCount: -0.4, age: 1.0 },
};

/* ================================================================
 *  Compilation and the forward pass
 * ================================================================ */

const idx = (list) => { const m = new Map(); list.forEach((n, i) => m.set(n, i)); return m; };
const F_IDX = idx(FEATURES);
const C_IDX = idx(CONCEPTS);
const P_IDX = idx(PRIORITIES);

/** Turns the sparse `{ to: { from: w } }` tables into dense Float32 matrices. */
function compile(table, rows, rowIdx, colIdx, label) {
  const cols = colIdx.size;
  const w = new Float32Array(rows.length * cols);
  const b = new Float32Array(rows.length);
  for (const to in table) {
    const r = rowIdx.get(to);
    if (r === undefined) throw new Error(`${label}: unknown output "${to}"`);
    for (const from in table[to]) {
      if (from === '_bias') { b[r] = table[to]._bias; continue; }
      const c = colIdx.get(from);
      // A weight naming an input that does not exist is a typo that would
      // otherwise silently do nothing for the rest of the project's life.
      if (c === undefined) throw new Error(`${label}: unknown input "${from}" for "${to}"`);
      w[r * cols + c] = table[to][from];
    }
  }
  return { w, b, cols };
}

// `expansionRoom` references a placeholder that is deliberately weighted zero;
// drop it before compiling so the unknown-input check stays strict.
delete IN_TO_CONCEPT.expansionRoom.safetyProxy;

const L1 = compile(IN_TO_CONCEPT, CONCEPTS, C_IDX, F_IDX, 'concept layer');
const L2 = compile(CONCEPT_TO_PRIORITY, PRIORITIES, P_IDX, C_IDX, 'priority layer');
const SKIP = compile(IN_TO_PRIORITY, PRIORITIES, P_IDX, F_IDX, 'skip layer');

function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

/**
 * One forward pass.
 *
 * @param {Object} features named readings; anything missing counts as zero
 * @returns {{priorities: Object, concepts: Object, vector: Float32Array}}
 */
export function evaluate(features) {
  const x = new Float32Array(FEATURES.length);
  for (let i = 0; i < FEATURES.length; i++) {
    const v = features[FEATURES[i]];
    // NaN propagates through a whole network and turns every priority into
    // garbage several frames after whatever produced it; clamp at the door.
    x[i] = Number.isFinite(v) ? v : 0;
  }

  const h = new Float32Array(CONCEPTS.length);
  for (let c = 0; c < CONCEPTS.length; c++) {
    let s = L1.b[c];
    const off = c * L1.cols;
    for (let f = 0; f < L1.cols; f++) s += L1.w[off + f] * x[f];
    h[c] = sigmoid(s);
  }

  const out = new Float32Array(PRIORITIES.length);
  for (let p = 0; p < PRIORITIES.length; p++) {
    let s = L2.b[p];
    const o2 = p * L2.cols;
    for (let c = 0; c < L2.cols; c++) s += L2.w[o2 + c] * h[c];
    const o3 = p * SKIP.cols;
    for (let f = 0; f < SKIP.cols; f++) s += SKIP.w[o3 + f] * x[f];
    out[p] = sigmoid(s);
  }

  const priorities = {};
  PRIORITIES.forEach((n, i) => { priorities[n] = out[i]; });
  const concepts = {};
  CONCEPTS.forEach((n, i) => { concepts[n] = h[i]; });
  return { priorities, concepts, vector: out };
}

/* ================================================================
 *  Reading the game state
 * ================================================================ */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Compresses an open-ended count into 0..1, half-way at `half`. */
const sat = (v, half) => (v <= 0 ? 0 : v / (v + half));
/** Linear ramp, clamped. */
const ramp = (v, max) => clamp01(v / max);

/** Rough resource worth of a unit, used to compare two armies. */
export function unitValue(def) {
  if (!def || !def.cost) return 0;
  const c = def.cost;
  // Gold is the scarce one, so a gold-heavy unit is worth more than its raw
  // total suggests - which is exactly why Paladins beat the same cost in Spearmen.
  return ((c.food || 0) + (c.wood || 0) + (c.gold || 0) * 1.6 + (c.stone || 0)) / 100;
}

/**
 * How much of the population limit the economy should be, by age.
 *
 * Shares rather than counts, because the population limit is a game setting and
 * can be anything from 50 to 1000. A fixed "130 villagers in the Imperial Age"
 * is two economies' worth at a 75-pop limit and an eighth of one at 1000 - the
 * AI would either strangle itself or stop building villagers a third of the way
 * to the cap and leave the rest of the map unworked.
 *
 * The numbers are the tuned 200-pop values divided by 200, so a standard game
 * plays exactly as before and every other limit gets the same shape of economy.
 */
export const VILL_SHARE = { dark: 0.12, feudal: 0.25, castle: 0.45, imperial: 0.65 };

/** The villager count the AI is working toward, for a limit and an age. */
export function villagerTarget(popMax, age) {
  // A floor, because a share of a very small limit rounds down to an economy
  // that cannot build anything at all.
  return Math.max(6, Math.round(popMax * (VILL_SHARE[age] ?? VILL_SHARE.imperial)));
}

/**
 * Turns the AI's cached view of the world into the network's input vector.
 *
 * Everything here reads state that `AI.cacheState` has already collected, so
 * this costs a few dozen arithmetic operations per pass rather than another
 * sweep over every entity.
 */
export function readFeatures(ai) {
  const p = ai.p;
  const g = ai.game;
  const f = {};

  /* --- clock and age --- */
  f.age = p.ageIndex / 3;
  f.gameProgress = sat(g.time, 2400);

  /* --- economy --- */
  // Everything counted in units or villagers is normalised against the
  // population limit, not against a constant. The saturation points are the
  // tuned 200-pop numbers written as shares of it, so a standard game reads
  // exactly as before and a 1000-pop game does not report a full-sized economy
  // as "barely started".
  const cap = Math.max(1, p.popMax);
  const vills = ai.mine.villagers.length;
  f.villRatio = ramp(vills / villagerTarget(cap, p.age), 1.2);
  f.villCount = sat(vills, cap * 0.35);
  f.popFill = clamp01(p.pop / Math.max(1, p.effectivePopCap));
  f.popHeadroom = ramp(p.effectivePopCap - p.pop, cap * 0.1);
  f.popMaxFill = clamp01(p.pop / cap);
  f.idleVillagers = clamp01(ai.mine.idle.length / Math.max(1, vills));
  f.tcCount = sat(ai.count('townCenter'), 3);
  f.farmCount = sat(ai.count('farm'), cap * 0.075);

  const r = p.res;
  f.floatFood = sat(r.food, 700);
  f.floatWood = sat(r.wood, 700);
  f.floatGold = sat(r.gold, 600);
  f.floatStone = sat(r.stone, 500);
  f.floatTotal = sat(r.food + r.wood + r.gold + r.stone, 2200);

  const inc = ai.income || { food: 0, wood: 0, gold: 0, stone: 0, total: 0 };
  f.incomeFood = sat(inc.food, 400);
  f.incomeWood = sat(inc.wood, 350);
  f.incomeGold = sat(inc.gold, 250);
  f.incomeStone = sat(inc.stone, 150);
  f.incomeTotal = sat(inc.total, 1100);

  // Scarcity is about the map, not the bank: what is still standing within
  // reach of the town. This is what tells the AI to start trading before the
  // gold runs out rather than after.
  const left = (res) => ai.nodes[res].reduce((t, n) => t + (n.amount || 0), 0);
  f.goldScarcity = 1 - sat(left('gold'), 1200);
  f.stoneScarcity = 1 - sat(left('stone'), 900);
  f.woodScarcity = 1 - sat(left('wood'), 4000);
  f.foodScarcity = clamp01((1 - sat(r.food, 350)) * (1 - sat(inc.food, 250)));

  const producers = ai.mine.buildings.filter((b) =>
    b.complete && b.def.trains?.length && b.type !== 'townCenter');
  f.producerIdle = producers.length
    ? producers.filter((b) => b.queue.length === 0).length / producers.length : 0;
  f.ecoTechProgress = ai.ecoTechProgress ?? 0;

  /* --- our army --- */
  let armyPop = 0, armyValue = 0, siegePop = 0;
  for (const u of ai.mine.army) {
    const pop = u.def.pop || 1;
    armyPop += pop;
    armyValue += unitValue(u.def);
    if (u.def.cat === 'siege') siegePop += pop;
  }
  ai.armyValue = armyValue;
  f.armyPop = sat(armyPop, cap * 0.175);
  f.armyShare = clamp01(armyPop / Math.max(1, p.pop));
  f.armyValue = sat(armyValue, 40);
  f.siegeShare = clamp01(siegePop / Math.max(1, armyPop));
  f.upgradeLag = ai.upgradeLag ?? 0;
  f.castleCount = sat(ai.count('castle'), 2);
  f.towerCount = sat(ai.count('watchTower') + ai.count('guardTower') + ai.count('keep'), 3);

  /* --- theirs --- */
  const threat = ai.threatProfile || { total: 0, value: 0, shares: {} };
  f.enemyValue = sat(threat.value, 40);
  f.strengthRatio = threat.value + armyValue > 0
    ? clamp01(armyValue / (armyValue + threat.value)) : 0.5;
  const s = threat.shares;
  f.enemyCavalry = s.cavalry || 0;
  f.enemyArcher = s.archer || 0;
  f.enemyInfantry = s.infantry || 0;
  f.enemySiege = s.siege || 0;
  f.enemyMonk = s.monk || 0;
  f.enemyRanged = (s.archer || 0) + (s.cavalryArcher || 0);
  f.counterCoverage = ai.counterCoverage ?? 1;

  /* --- pressure --- */
  f.threatCount = sat(ai.threatCount || 0, 5);
  f.threatProximity = ai.threatAt && ai.threatCount
    ? clamp01(1 - Math.hypot(ai.threatAt.x - ai.homeX, ai.threatAt.y - ai.homeY) / 32) : 0;
  f.threatPersistence = ai.underThreat ? 1 : 0;
  f.recentDamage = sat(ai.recentDamage || 0, 4);
  f.buildingsLost = sat(p.stats.buildingsLost || 0, 4);

  /* --- map --- */
  f.explored = ai.exploredFraction ?? 0;
  f.mapControl = ai.mapControl ?? 0.5;
  f.enemyKnown = ai.rivalTowns.length ? 1 : 0;
  const ed = ai.enemyBase
    ? Math.hypot(ai.enemyBase.x - ai.homeX, ai.enemyBase.y - ai.homeY) : g.size;
  f.enemyDistance = clamp01(ed / g.size);
  f.forwardPresence = ai.forwardPresence ?? 0;
  f.relicShare = sat(p.relics, 2);

  /* --- team --- */
  const team = ai.team;
  f.teamSize = team ? sat(team.members.length - 1, 2) : 0;
  f.allyUnderAttack = team && team.allyUnderAttack(ai) ? 1 : 0;
  f.allyStrength = team ? sat(team.allyArmyValue(ai), 30) : 0;
  f.allyEconomy = team ? sat(team.allyVillagers(ai), cap * 0.3) : 0;
  f.teamAggression = team ? clamp01(team.pushIntent) : 0;

  /* --- trade --- */
  f.marketCount = sat(ai.count('market'), 1.5);
  f.tradeCarts = sat(ai.mine.byType.tradeCart || 0, cap * 0.06);
  // Potential, not the live route: see AI.measureTradeRoute for why reading the
  // live route makes trade unreachable.
  const route = ai.tradePotential || ai.tradeRoute;
  f.tradePartner = route ? clamp01(route.quality) : 0;
  f.tradeSafety = route ? clamp01(route.safety) : 0;

  return f;
}

/**
 * A rolling average of the priorities.
 *
 * The raw network output moves the instant any input does, and several
 * priorities gate expensive, slow commitments - a Castle, a second Town Center,
 * a batch of Trade Carts. Letting those flip on and off between passes means the
 * AI starts things it abandons. Smoothing gives the priorities momentum:
 * pressure has to persist for a few seconds before the plan actually changes.
 */
export class PriorityState {
  constructor(smoothing = 0.25) {
    this.smoothing = smoothing;
    this.values = {};
    for (const n of PRIORITIES) this.values[n] = 0.5;
    this.concepts = {};
    this.features = {};
  }

  update(features) {
    const { priorities, concepts } = evaluate(features);
    const k = this.smoothing;
    for (const n of PRIORITIES) {
      this.values[n] += (priorities[n] - this.values[n]) * k;
    }
    this.concepts = concepts;
    this.features = features;
    this.raw = priorities;
    return this.values;
  }

  get(name) { return this.values[name] ?? 0; }

  /** The four resource priorities, renormalised into a gather split. */
  resourceSplit() {
    const out = {
      food: this.values.foodWeight, wood: this.values.woodWeight,
      gold: this.values.goldWeight, stone: this.values.stoneWeight,
    };
    let sum = 0;
    for (const k in out) { out[k] = Math.max(0.02, out[k]); sum += out[k]; }
    for (const k in out) out[k] /= sum;
    return out;
  }

  /** Compact dump for the benchmark and for debugging a game that went wrong. */
  describe() {
    return PRIORITIES.map((n) => `${n}=${this.values[n].toFixed(2)}`).join(' ');
  }
}
