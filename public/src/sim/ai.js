// Computer opponent.
//
// Every decision here is a function of the priority network in ai-brain.js
// rather than of a hard-coded rule. The AI reads sixty-odd normalised facts
// about the game - who is attacking, how much of the map it holds, how big its
// economy and army are, what is floating in the bank, what its allies need -
// and the network turns those into eighteen priorities: boom, military,
// defence, aggression, raiding, tech, expansion, trade, siege, monks,
// countering, castle placement, scouting, and a weight for each of the four
// resources. The managers below are the hands; the network is the judgement.
//
// Allied AIs additionally share a TeamBrain (ai-team.js), which owns the
// decisions that only make sense at team scope: who the team attacks and when,
// who plays economy and who plays army, who gets bailed out with a tribute, and
// which Market a Trade Cart should run to.

import { TECHS, upgradeTechFor } from '../data/techs.js';
import { AGES } from './player.js';
import { PriorityState, readFeatures, unitValue, villagerTarget } from './ai-brain.js';
import { TeamBrain } from './ai-team.js';

/**
 * Villager count at which the AI is willing to age up - and, identically, the
 * count at which it starts banking food instead of making more villagers.
 * These two must use the same number: if the saving gate trips before the
 * age-up gate, the AI stops producing villagers while still refusing to age,
 * and sits in the Dark Age forever.
 *
 * A share of the population limit, but banded. A build order is a build order:
 * a human clicks up to Feudal at roughly the same town size whether the limit is
 * 75 or 500, because what decides it is how long the age costs take to pay for,
 * not how big the game will eventually get. Pure shares would have a 1000-pop
 * game grinding out eighty villagers before leaving the Dark Age, and a 50-pop
 * game aging up on four.
 */
const AGE_GATE_SHARE = { dark: 0.08, feudal: 0.13, castle: 0.21, imperial: Infinity };
const AGE_GATE_BAND = { dark: [10, 22], feudal: [18, 34], castle: [30, 55] };
const ageGate = (age, popMax) => {
  const share = AGE_GATE_SHARE[age] ?? 0;
  if (!Number.isFinite(share)) return Infinity;
  const band = AGE_GATE_BAND[age] || [0, Infinity];
  const want = Math.round(popMax * share);
  // Never past the economy we are actually building toward, or the AI would
  // refuse to age up at a count it has no intention of reaching.
  return Math.min(villagerTarget(popMax, age),
    Math.max(band[0], Math.min(band[1], want)));
};

/**
 * How many villagers can usefully share one resource node. Trees hold 100 wood
 * and are one tile each, so stacking villagers on one just makes them queue;
 * mines and bushes are worth crowding.
 */
/** The four, in a fixed order, for the many places that loop over them. */
const RESOURCES = ['food', 'wood', 'gold', 'stone'];

/**
 * Banked amount of *every* resource at which the AI is no longer economy
 * limited. Past this the bank cannot be spent fast enough for more villagers to
 * mean anything, and the population they occupy is worth more as army.
 */
const GLUT = 5000;

const NODE_CAP = { tree: 1, berries: 4, gold: 5, stone: 4, carcass: 4 };
const nodeCap = (e) => (e.kind === 'unit' ? 4 : NODE_CAP[e.type] ?? 3);

/**
 * What beats what, as ordered preferences. The first entry the civ can build
 * wins, so a civ without Pikemen answers Knights with Camels instead.
 */
const COUNTERS = {
  cavalry:       [['halberdier', 'pikeman', 'spearman'], ['heavyCamelRider', 'camelRider', 'kamayuk']],
  camel:         [['halberdier', 'pikeman', 'spearman'], ['champion', 'twoHandedSwordsman', 'longSwordsman']],
  elephant:      [['halberdier', 'pikeman', 'spearman'], ['monk'], ['arbalester', 'crossbowman']],
  archer:        [['eliteSkirmisher', 'skirmisher'], ['paladin', 'cavalier', 'knight', 'eliteEagleWarrior', 'eagleWarrior']],
  cavalryArcher: [['eliteSkirmisher', 'skirmisher'], ['paladin', 'cavalier', 'knight', 'heavyCamelRider', 'camelRider']],
  infantry:      [['arbalester', 'crossbowman', 'archer'], ['paladin', 'cavalier', 'knight']],
  siege:         [['hussar', 'lightCavalry', 'scoutCavalry'], ['paladin', 'cavalier', 'knight', 'eliteEagleWarrior', 'eagleWarrior']],
  monk:          [['hussar', 'lightCavalry', 'scoutCavalry'], ['archer', 'crossbowman', 'arbalester']],
};

/** Which threat classes a unit we own actually answers. Inverted from COUNTERS
 *  once at load, so `counterCoverage` can be measured rather than guessed. */
const ANSWERS = (() => {
  const m = new Map();
  for (const cls in COUNTERS) {
    COUNTERS[cls].forEach((tier, i) => {
      for (const id of tier) {
        if (!m.has(id)) m.set(id, []);
        // A primary answer counts for more than a secondary one.
        m.get(id).push({ cls, weight: i === 0 ? 1 : 0.55 });
      }
    });
  }
  return m;
})();

const TECH_PRIORITY = [
  'loom', 'doubleBitAxe', 'horseCollar', 'wheelbarrow', 'goldMining',
  'forging', 'scaleMailArmor', 'fletching', 'scaleBardingArmor', 'bloodlines',
  'bowSaw', 'heavyPlow', 'handCart', 'goldShaftMining', 'husbandry',
  'ironCasting', 'chainMailArmor', 'bodkinArrow', 'chainBardingArmor',
  'thumbRing', 'ballistics', 'masonry', 'squires', 'supplies',
  'twoManSaw', 'cropRotation', 'blastFurnace', 'plateMailArmor', 'bracer',
  'plateBardingArmor', 'siegeEngineers', 'chemistry', 'conscription', 'architecture',
];

/** Every economy upgrade, used to measure how far behind the eco tech is. */
const ECO_TECHS = ['loom', 'wheelbarrow', 'handCart', 'horseCollar', 'heavyPlow',
  'cropRotation', 'doubleBitAxe', 'bowSaw', 'twoManSaw', 'goldMining',
  'goldShaftMining', 'stoneMining', 'stoneShaftMining'];

/** Market work, bought in this order once the AI decides to trade. */
const TRADE_TECHS = ['caravan', 'coinage', 'banking', 'guilds', 'cartography'];

/** Defensive techs worth having once the AI is turtling rather than pushing. */
const DEFENCE_TECHS = ['murderHoles', 'arrowslits', 'fortifiedWall', 'heatedShot',
  'guardTower', 'keep', 'masonry', 'architecture', 'hoardings'];

/**
 * Economy techs that only pay for themselves once enough villagers exist to
 * benefit: a flat one-off cost buying a small percentage per villager, so
 * buying them early spends food that would have been villagers.
 *
 * The thresholds are shares of the population limit - the standard advice of
 * "Wheelbarrow around 40 villagers" is really "when the economy is a fifth of a
 * standard game's population", and at a 600-pop limit that arrives far earlier
 * in the build than 40 villagers would suggest.
 */
const ECO_TECH_GATE = {
  wheelbarrow: (ai) => ai.mine.villagers.length >= ai.share(0.2, 12) ||
    ai.count('farm') >= ai.share(0.085, 6),
  handCart: (ai) => ai.mine.villagers.length >= ai.share(0.3, 18),
};

export class AI {
  constructor(game, playerIndex, difficulty = 'moderate') {
    this.game = game;
    this.index = playerIndex;
    this.p = game.players[playerIndex];
    this.difficulty = difficulty;
    this.t = 0;
    this.attackTimer = 60;
    // The attack wave, as a share of the population limit rather than a unit
    // count. Eighteen units is a committing attack at a 200 limit and a rounding
    // error at 1000. Hard commits earlier, easy waits for an overwhelming force.
    this.waveShare = difficulty === 'hard' ? 0.07 : difficulty === 'easy' ? 0.12 : 0.09;
    this.enemyMemory = new Map();   // enemy unit id -> { cls, t, hot } for what we have seen
    this.attacking = false;
    this.homeX = 0; this.homeY = 0;

    // The priority network, and its smoothing state. Easy opponents think with
    // a blunter, slower brain: the same policy, damped so it reacts late and
    // commits weakly, which is a far more natural difficulty knob than giving
    // the hard AI free resources.
    this.smoothing = difficulty === 'hard' ? 0.4 : difficulty === 'easy' ? 0.12 : 0.25;
    this.brain = new PriorityState(this.smoothing);

    this.team = TeamBrain.forTeam(game, this.p.team);
    this.team.join(this);

    this.armyValue = 0;
    this.recentDamage = 0;
    this.income = { food: 0, wood: 0, gold: 0, stone: 0, total: 0 };
    this.squads = { raids: [] };
  }

  update(dt) {
    if (this.p.defeated || this.game.over) return;
    this.t += dt;
    if (this.t < 1.0) return;
    this.t = 0;

    this.cacheState();
    if (!this.tc) return;
    this.team.sync();

    this.planReserve();
    // The age-up is bought the moment it is affordable, before anything else
    // can spend the food. It sits behind a reserve all the way up to this
    // point precisely so that it can be afforded here.
    this.manageAge();
    this.manageEmergencyDefence();
    this.manageConstruction();
    this.manageHousing();
    // Military production runs before villager production, and the ordering is
    // load-bearing in both directions. Town Centers have a near-unbounded
    // appetite for food, so running them first takes the last 50 every pass and
    // nothing that costs food is ever trained. Swapping the two was measured:
    // armies fell to between zero and eight units and the AI lost nine duels
    // out of ten. The army's share is bounded by its composition and queue
    // depths, so letting it choose first splits the food instead of starving
    // either side.
    this.manageArmy();
    this.manageVillagers();
    this.manageDropSites();
    this.manageEconomyBuildings();
    this.manageMilitaryBuildings();
    this.manageCastles();
    this.manageTowers();
    this.manageTrade();
    this.manageScouting();
    this.manageResearch();
    this.manageDefense();
    this.manageMarket();
    this.spendSurplus();
    // A second sweep, after everything that can leave a villager with nothing
    // to do. manageDefense is the one that matters: when a raid ends it empties
    // the Town Center, and those villagers come out *after* the first sweep has
    // already run. With defence garrisoning and releasing every time an enemy
    // scout wanders past, a rolling group of five to seven villagers - a fifth
    // of the town - was permanently one pass behind being given a job.
    this.assignIdle();
  }

  /** Shorthand for a priority. */
  pri(name) { return this.brain.get(name); }

  /* ================================================================
   *  State
   * ================================================================ */

  cacheState() {
    const g = this.game;
    this.mine = { units: [], buildings: [], idle: [], villagers: [], army: [], traders: [], byType: {} };
    this.enemyUnits = [];
    this.nodes = { food: [], wood: [], gold: [], stone: [] };
    this.nodeLoad = new Map();
    this.dropSites = [];
    this.pendingSpots = [];
    const gaia = [];
    for (const e of g.entities) {
      if (!e.alive) continue;
      if (e.owner === this.index) {
        if (e.kind === 'unit') {
          this.mine.units.push(e);
          this.mine.byType[e.type] = (this.mine.byType[e.type] || 0) + 1;
          if (e.def.cat === 'villager') {
            this.mine.villagers.push(e);
            // A garrisoned villager reads as idle - that is how the sim models
            // being inside a building - but every command issued to one is
            // dropped on the floor. Counting them as idle means the AI hands
            // them a job every pass, believes it has been taken, and never
            // notices they have not moved for twenty minutes.
            if (e.task.type === 'idle' && !e.garrisonedIn) this.mine.idle.push(e);
            const t = e.task;
            if ((t.type === 'gather' || t.type === 'build') && t.targetId) {
              this.nodeLoad.set(t.targetId, (this.nodeLoad.get(t.targetId) || 0) + 1);
            }
          } else if (e.def.cat === 'trade') {
            this.mine.traders.push(e);
          } else if (e.def.cat !== 'animal') {
            this.mine.army.push(e);
          }
        } else if (e.kind === 'building') {
          this.mine.buildings.push(e);
          this.mine.byType[e.type] = (this.mine.byType[e.type] || 0) + 1;
          if (e.complete && e.def.dropSite) this.dropSites.push(e);
        }
      } else if (e.kind === 'unit' && e.owner >= 0 && g.isEnemy(this.index, e.owner)) {
        // Only what we can actually see. Reading the whole enemy army through
        // the fog let the AI counter units it had never met, which is both
        // unfair and means scouting does nothing.
        if (g.revealAll || this.p.canSee(e.x | 0, e.y | 0)) this.enemyUnits.push(e);
      } else if (e.owner < 0) {
        gaia.push(e);
      }
    }
    this.tc = this.mine.buildings.find((b) => b.type === 'townCenter' && b.complete) ||
      this.mine.buildings.find((b) => b.type === 'townCenter');
    if (this.tc) { this.homeX = this.tc.x; this.homeY = this.tc.y; }

    this.rememberEnemies();
    this.assessThreat();
    this.rememberDanger();

    // Where the enemy lives, as far as we have seen. Buildings stay known once
    // explored, which is how a real player remembers a town they scouted.
    this.rivalTowns = [];
    let nearestRival = null, nearestRivalD = Infinity;
    for (const e of g.entities) {
      if (!e.alive || e.kind !== 'building' || !g.isEnemy(this.index, e.owner)) continue;
      if (!g.revealAll && !this.p.hasExplored(e.x | 0, e.y | 0)) continue;
      this.rivalTowns.push(e);
      const d = Math.hypot(e.x - this.homeX, e.y - this.homeY);
      // A Town Center is the anchor of a base; anything else is only a fallback
      // for the direction their territory lies in.
      const weighted = e.type === 'townCenter' ? d - 30 : d;
      if (weighted < nearestRivalD) { nearestRivalD = weighted; nearestRival = e; }
    }
    this.enemyBase = nearestRival;

    // Gatherable nodes within reach of the base, tagged with how far they are
    // from the nearest drop-off. That distance drives both which node an idle
    // villager picks and where the next Lumber/Mining Camp goes.
    const reach = 40 + this.mine.villagers.length * 0.35;
    for (const e of gaia) {
      let res = null;
      if (e.kind === 'resource' && e.amount > 0 && e.type !== 'relic' && e.type !== 'fish') res = e.resType;
      else if (e.kind === 'unit' && e.def.huntable && !e.def.hostile) res = 'food';
      if (!res || !this.nodes[res]) continue;
      const d = Math.hypot(e.x - this.homeX, e.y - this.homeY);
      if (d > reach) continue;
      e._aiHome = d;
      e._aiDrop = this.dropDist(e.x, e.y, res);
      e._aiRival = this.rivalDist(e.x, e.y);
      e._aiDanger = this.dangerAt(e.x, e.y);
      e._aiHardDanger = this.hardDangerAt(e.x, e.y);
      this.nodes[res].push(e);
    }

    // Everything the network reads that is not already a plain count.
    this.measureIncome();
    this.trackStocks();
    this.measureMap();
    this.measureArmyGaps();
    this.measureTradeRoute();
    this.think();
  }

  /** One forward pass of the priority network. */
  think() {
    const features = readFeatures(this);
    // The very first pass has no history to smooth against, and a half-way
    // default would mean the AI spends its opening seconds with every priority
    // at 0.5 - including "attack" and "trade". Snap to the real reading once.
    if (!this.primed) {
      this.brain.smoothing = 1;
      this.brain.update(features);
      this.brain.smoothing = this.smoothing;
      this.primed = true;
    } else {
      this.brain.update(features);
    }
  }

  /**
   * Gather rate, estimated from who is working what.
   *
   * Measuring it from the stockpile does not work: the bank is being spent at
   * the same time it is filled, so the delta says nothing about income. Counting
   * the workers does, and it is the number the AI actually needs - "how fast can
   * I pay for the next thing" rather than "how much did I keep".
   */
  measureIncome() {
    const per = { food: 0, wood: 0, gold: 0, stone: 0 };
    for (const v of this.mine.villagers) {
      const t = v.task;
      const res = (t.type === 'gather' || t.type === 'deliver') ? t.resType : null;
      if (!res || per[res] === undefined) continue;
      // Roughly a third of a resource a second, before the walk. Gather
      // upgrades are civ- and tech-dependent and the modifier set already
      // knows them.
      per[res] += 21 * (this.p.mods.gather[res] || 1);
    }
    // Trade income is gold that arrives without a miner, which is the entire
    // point of it once the mines run dry.
    per.gold += this.mine.traders.length * 34 * this.p.mods.tradeRate;
    per.total = per.food + per.wood + per.gold + per.stone;
    this.income = per;
  }

  /**
   * A slow average of what is in the bank, and how lopsided it is.
   *
   * The instantaneous stockpile is a poor guide to what the economy is short
   * of: it swings by hundreds every time a Town Center takes 50 food or a
   * Castle takes 650 stone. What matters is which resource is *persistently*
   * the low one, and that only shows up over tens of seconds. This is the
   * measurement the rebalancing in `resourceDemand` runs on.
   */
  trackStocks() {
    const r = this.p.res;
    if (!this.stockAvg) {
      this.stockAvg = { food: r.food, wood: r.wood, gold: r.gold, stone: r.stone };
    } else {
      // Roughly a twenty-second memory at one pass a second.
      for (const k of RESOURCES) this.stockAvg[k] += (r[k] - this.stockAvg[k]) * 0.06;
    }
    let lo = Infinity, hi = 0;
    for (const k of RESOURCES) {
      lo = Math.min(lo, this.stockAvg[k]);
      hi = Math.max(hi, this.stockAvg[k]);
    }
    /** 0 when every pile is level, approaching 1 when one dwarfs another. */
    this.stockImbalance = hi > 0 ? 1 - lo / hi : 0;
    /** Are we so far past needing resources that population is the constraint? */
    this.glut = Math.min(r.food, r.wood, r.gold, r.stone);
  }

  /**
   * Map-scale readings: how much we have seen, how much of what is standing on
   * the map is ours, and whether our army is anywhere near their half.
   */
  measureMap() {
    const g = this.game;
    // Sampling every fourth tile in each direction is a sixteenth of the work
    // and the answer is a fraction to two decimal places either way.
    if (g.time >= (this.nextExploreScan || 0)) {
      this.nextExploreScan = g.time + 8;
      const n = g.size;
      let seen = 0, total = 0;
      for (let y = 0; y < n; y += 4) {
        for (let x = 0; x < n; x += 4) {
          total++;
          if (this.p.fog[y * n + x] > 0) seen++;
        }
      }
      this.exploredFraction = total ? seen / total : 0;
    }

    let ours = 0, theirs = 0;
    for (const b of this.mine.buildings) if (b.complete) ours++;
    for (const b of this.rivalTowns) theirs++;
    // Allies' territory is the team's territory, and a team that holds the map
    // should be playing like it whichever member is asking.
    for (const m of this.team.members) {
      if (m === this || !m.mine) continue;
      ours += m.mine.buildings.length * 0.6;
    }
    // Having seen none of their buildings is ignorance, not dominance. Reading
    // it as "we own the whole map" had every AI open its first minute convinced
    // it was winning, which drove aggression and forward Castles to maximum
    // before anybody had met anyone.
    //
    // Having seen two of their buildings is barely better, so the reading is
    // pulled back toward even in proportion to how little of the map we have
    // actually looked at. Without that the AI counted its own twenty buildings
    // against the three it had scouted, concluded it was dominating, and spent
    // the game throwing half-sized waves at an opponent its own size.
    const raw = theirs > 0 ? ours / (ours + theirs) : 0.5;
    const confidence = Math.min(1, (this.exploredFraction || 0) / 0.4);
    this.mapControl = 0.5 + (raw - 0.5) * confidence;

    let forward = 0;
    if (this.enemyBase) {
      for (const u of this.mine.army) {
        const dHome = Math.hypot(u.x - this.homeX, u.y - this.homeY);
        const dThem = Math.hypot(u.x - this.enemyBase.x, u.y - this.enemyBase.y);
        if (dThem < dHome) forward++;
      }
    }
    this.forwardPresence = this.mine.army.length ? forward / this.mine.army.length : 0;
  }

  /**
   * How well the army we have answers the army they have, and how far behind
   * our unit upgrades are. Both feed the network directly: "we do not counter
   * what they field" is a different problem from "we simply have fewer units",
   * and they want different responses.
   */
  measureArmyGaps() {
    const shares = this.threatProfile.shares;
    let armyPop = 0;
    const answerPop = {};
    for (const u of this.mine.army) {
      const pop = u.def.pop || 1;
      armyPop += pop;
      for (const a of ANSWERS.get(u.type) || []) {
        answerPop[a.cls] = (answerPop[a.cls] || 0) + pop * a.weight;
      }
    }
    let coverage = 0, weighed = 0;
    for (const cls in shares) {
      const share = shares[cls];
      if (share < 0.08) continue;
      weighed += share;
      // We want roughly as much of the answer as they have of the threat.
      const want = share * Math.max(1, armyPop);
      coverage += share * Math.min(1, (answerPop[cls] || 0) / Math.max(1, want));
    }
    // Nothing seen means nothing to be uncovered against - a blank slate reads
    // as fully covered so the AI opens generically rather than in a panic.
    this.counterCoverage = weighed > 0 ? coverage / weighed : 1;

    const upgrades = this.unitUpgradeTechs().filter((id) =>
      TECHS[id] && this.p.isTechAvailable(id));
    this.upgradeLag = upgrades.length / (upgrades.length + 2);

    const done = ECO_TECHS.filter((id) => this.p.researched.has(id)).length;
    const possible = ECO_TECHS.filter((id) =>
      this.p.researched.has(id) || this.p.isTechAvailable(id)).length;
    this.ecoTechProgress = possible ? done / possible : 0;
  }

  /**
   * Scores trade: the route carts would actually run on, and - separately - what
   * a route would be worth if we built the Market for it.
   *
   * The two have to be separate or the AI can never start trading at all. The
   * network decides whether trade is worth investing in, and it decided by
   * reading the quality of the existing route; but the route only exists once a
   * second Market has been built, and that Market is only built because the
   * network wants trade. Games ran the full hour with a hundred villagers, no
   * gold left in the ground, and not one Trade Cart.
   *
   * So the feature the network reads is the *potential*: what the best route
   * available to us would be worth, counting an ally's Market that already
   * exists and, failing that, the second Market we could put at the far end of
   * our own territory.
   */
  measureTradeRoute() {
    this.tradeRoute = null;
    const g = this.game;
    const home = this.building('market');
    const score = (dist, ally, risk) => ({
      quality: Math.min(1, dist / 60) * (ally ? 1 : 0.8),
      safety: 1 / (1 + risk),
    });

    if (home) {
      const best = this.team.bestMarketFor(this, home);
      if (best) {
        this.tradeRoute = {
          market: best.market, home, dist: best.dist, ally: best.ally,
          ...score(best.dist, best.ally, best.risk),
        };
      }
    }
    if (this.tradeRoute) { this.tradePotential = this.tradeRoute; return; }

    // No route yet. An ally's Market is the best thing we could be running to,
    // and it is already standing - so the potential is real, not speculative.
    let best = null;
    for (const m of this.team.members) {
      // An ally that has not taken its own first pass yet has no cached state
      // to read. Team members come up in whatever order the host constructed
      // them, so this is the normal case on the opening tick, not an edge one.
      if (m === this || m.p.defeated || !m.mine) continue;
      const theirs = m.building('market');
      if (!theirs) continue;
      const dist = Math.hypot(theirs.x - this.homeX, theirs.y - this.homeY);
      const risk = this.routeDanger({ x: this.homeX, y: this.homeY }, theirs);
      const s = score(dist, true, risk);
      if (!best || s.quality * s.safety > best.quality * best.safety) best = s;
    }
    if (best) { this.tradePotential = best; return; }

    // No ally with a Market means no trade route, and that is the whole answer.
    // Trading between two of our own Markets was possible and is now not: it
    // manufactures gold from walking distance alone, with no partner who could
    // be cut off, which makes a solo AI's late game unlosable in the one way it
    // should not be.
    this.tradePotential = null;
  }

  /** Average danger along a straight line between two points. */
  routeDanger(a, b) {
    let sum = 0;
    const steps = 6;
    for (let i = 1; i <= steps; i++) {
      const t = i / (steps + 1);
      sum += this.hardDangerAt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
    }
    return sum / steps;
  }

  /** Distance to the nearest enemy town we know about, or Infinity. */
  rivalDist(x, y) {
    let best = Infinity;
    for (const t of this.rivalTowns) {
      const d = Math.hypot(t.x - x, t.y - y);
      if (d < best) best = d;
    }
    return best;
  }

  /**
   * Remembers where our own things have recently been hurt.
   *
   * A spot is dangerous for a while after the raiders leave - the raid that just
   * killed four villagers will very likely come back the same way.
   */
  rememberDanger() {
    const now = this.game.time;
    if (!this.dangerSpots) this.dangerSpots = [];
    this.dangerSpots = this.dangerSpots.filter((s) => s.until > now);
    let hurt = 0;
    for (const e of this.mine.units) {
      // `lastDamaged` starts at zero on a fresh unit, so an explicit "has ever
      // been hit" check is needed or the whole town reads as wounded at t=0.
      if (!e.lastDamaged || now - e.lastDamaged > 3) continue;
      hurt++;
      const near = this.dangerSpots.find((s) => Math.hypot(s.x - e.x, s.y - e.y) < 6);
      if (near) { near.until = now + AI.DANGER_SECONDS; continue; }
      if (this.dangerSpots.length < 24) {
        this.dangerSpots.push({ x: e.x, y: e.y, until: now + AI.DANGER_SECONDS });
      }
    }
    for (const b of this.mine.buildings) {
      if (b.lastDamaged && now - b.lastDamaged < 3) hurt += 2;
    }
    this.recentDamage = hurt;
  }

  /**
   * Danger a villager will actually refuse to work in: standing under an enemy
   * Town Center, Castle or tower, or in among their army.
   *
   * Ground we hold is discounted heavily. A raid on our own town would
   * otherwise mark the whole base and have villagers refuse to work their own
   * resources. Near home we keep working; defence and garrisoning handle it.
   */
  hardDangerAt(x, y) {
    let fromForts = 0;
    for (const b of this.rivalTowns) {
      const range = b.def.range || 0;
      if (!range) continue;                       // a House is not a threat
      const dist = Math.hypot(b.x - x, b.y - y);
      if (dist < range + 5) fromForts += 12;      // inside their fire
      else if (dist < range + 14) fromForts += 5; // close enough to be caught
    }
    let soldiers = 0;
    for (const u of this.enemyUnits) {
      if (u.def.cat === 'villager' || u.def.cat === 'trade') continue;
      if (Math.hypot(u.x - x, u.y - y) < 14) soldiers++;
    }
    let fromArmy = soldiers >= 4 ? 12 : soldiers * 2;   // a lone scout is not an army

    let fromMemory = 0;
    for (const s of this.dangerSpots || []) {
      if (Math.hypot(s.x - x, s.y - y) < 10) fromMemory += 5;
    }

    if (Math.hypot(x - this.homeX, y - this.homeY) < 18) {
      fromArmy *= 0.35;
      fromMemory *= 0.35;
    }
    return fromForts + fromArmy + fromMemory;
  }

  /** Alias kept for the places that only rank rather than refuse. */
  dangerAt(x, y) { return this.hardDangerAt(x, y); }

  /**
   * Sets aside resources for the one expensive thing the AI most wants next.
   *
   * Income is spent the instant it arrives - a Farm here, a House there - so a
   * 275-wood Town Center is never affordable no matter how much wood the AI
   * earns in total. The reserve is what lets a big purchase happen at all.
   */
  planReserve() {
    this.reserve = null;
    this.savingForAge = false;
    const a = this.p.ageIndex;

    // Being attacked outranks even the age. A Castle is the difference between
    // losing the town and holding it.
    //
    // But only for as long as the plan is actually working. "We are being
    // raided" renews itself every time a raid lands, so under sustained
    // pressure this reserve never expires - and because it pre-empts the age
    // fund, an AI that could not scrape together 650 stone spent twelve minutes
    // failing to build a Castle while never once saving for the Imperial Age.
    // Being an age behind is what actually loses the game. After a few minutes
    // of not affording it, the age gets its turn back and the Castle goes up
    // through the ordinary path whenever the stone does arrive.
    let panic = null;
    if (this.wantEmergencyCastle) {
      if (!this.castleTryStart) this.castleTryStart = this.game.time;
      panic = this.p.mods.building('castle').cost;
      if (this.game.time - this.castleTryStart < AI.EMERGENCY_CASTLE_PATIENCE) {
        this.reserve = panic;
        return;
      }
    } else {
      this.castleTryStart = 0;
    }

    const nextAge = AGES[a + 1];
    const techId = nextAge ? nextAge + 'Age' : null;
    if (techId && TECHS[techId] && this.p.isTechAvailable(techId) &&
        this.mine.villagers.length >= this.ageGate()) {
      const cost = { ...this.p.mods.techCost(TECHS[techId]) };
      // Past the patience window the two goals share the reserve rather than
      // one cancelling the other. They cost different things - a Castle is
      // stone, an age is food and gold - so there was never a real conflict;
      // dropping the Castle outright just meant a besieged AI took thirteen
      // minutes to put one up when a peaceful one managed it in seven.
      if (panic) for (const k in panic) cost[k] = Math.max(cost[k] || 0, panic[k] || 0);
      this.reserve = cost;
      this.savingForAge = true;
      return;
    }
    if (panic) { this.reserve = panic; return; }

    if (a >= 2 && this.count('townCenter') < this.townCenterTarget() &&
        !this.underConstruction('townCenter')) {
      this.reserve = this.p.mods.building('townCenter').cost;
      return;
    }

    // Nothing urgent: bank toward the Castle we want anyway, so the stone is
    // there when the unique unit becomes worth having rather than three minutes
    // after we decided we wanted it.
    if (this.wantsAnotherCastle() && this.pri('defCastle') > 0.5) {
      this.reserve = this.p.mods.building('castle').cost;
    }
  }

  /**
   * The food villager production is not allowed to touch, as a rising ramp from
   * the moment the AI started saving for an age. See manageVillagers for why
   * this has to be a function of time rather than of the bank.
   */
  ageSaveFloor() {
    if (!this.savingForAge || !this.reserve || !this.reserve.food) {
      this.ageSaveStart = 0;
      return 0;
    }
    const ramp = Math.min(1, this.ageSaveElapsed() / AI.AGE_SAVE_RAMP);
    return this.reserve.food * ramp;
  }

  /** How long we have been banking for the current age. */
  ageSaveElapsed() {
    if (!this.savingForAge || !this.reserve) return 0;
    if (!this.ageSaveStart) this.ageSaveStart = this.game.time;
    return this.game.time - this.ageSaveStart;
  }

  /** Seconds over which the age fund becomes fully protected from the boom. */
  static AGE_SAVE_RAMP = 150;
  /** How long the main Town Center keeps booming regardless of the age fund. */
  static AGE_SAVE_GRACE = 300;
  /** How long a panic Castle may hold the whole economy hostage before the age
   *  takes priority back. */
  static EMERGENCY_CASTLE_PATIENCE = 240;

  /** The villager count this age wants before advancing. */
  ageGate() { return ageGate(this.p.age, this.p.popMax); }

  /**
   * How this game's population limit compares to the standard 200 the AI's
   * building counts were tuned against. Used for the numbers that are about
   * throughput rather than population - production buildings, Town Centers -
   * where a big limit needs proportionally more of them or the economy outruns
   * everything that could possibly spend it.
   */
  get popScale() { return Math.max(0.5, this.p.popMax / 200); }

  /** The base attack wave for this difficulty and population limit. */
  get armySize() { return Math.max(6, Math.round(this.share(this.waveShare))); }

  /**
   * A count expressed as a share of this game's population limit.
   *
   * Every "how many of these do I want" number in the AI goes through here. The
   * limit is a setting running from 50 to 1000, and a constant tuned at 200 is
   * wrong at both ends: it strangles a small game and leaves a large one with a
   * third of the map unworked and half its population unused.
   */
  share(fraction, min = 0) { return Math.max(min, this.p.popMax * fraction); }

  /** How many Town Centers the AI is working toward, from the expand priority. */
  townCenterTarget() {
    const a = this.p.ageIndex;
    if (a < 2) return 1;
    const want = this.pri('expand');
    // Two is the floor once the Castle Age arrives - a one-TC Imperial economy
    // simply cannot produce villagers fast enough to matter - and a high
    // expansion priority takes it to six.
    return Math.max(2, Math.round((2 + want * (a >= 3 ? 4 : 2)) * this.popScale));
  }

  /** Do we still want to put up another Castle? Drives stone demand. */
  wantsAnotherCastle() {
    const a = this.p.ageIndex;
    if (a < 2 || !this.p.isBuildingAvailable('castle')) return false;
    const want = Math.max(this.pri('defCastle'), this.pri('forwardCastle'));
    const cap = (a >= 3 ? 4 : 2) * this.popScale;
    return this.count('castle') < Math.max(1, Math.round(cap * (0.4 + want)));
  }

  /** canAfford, but honouring whatever planReserve is saving up for. */
  canSpend(cost, ignoreReserve) {
    if (!this.p.canAfford(cost)) return false;
    if (ignoreReserve || !this.reserve) return true;
    for (const k in cost) {
      // Costs carry explicit zeros for every resource, and comparing those
      // zeros against the reserve made the reserve block everything.
      if (!cost[k]) continue;
      if ((this.p.res[k] || 0) - (this.reserve[k] || 0) < cost[k]) return false;
    }
    return true;
  }

  /**
   * What kind of threat a unit represents, which is what decides the counter.
   * Deliberately finer than the unit's category: a Cavalry Archer is cavalry
   * and an archer at once, and the thing that beats it is a Skirmisher.
   */
  static threatClass(def) {
    const c = def.classes;
    if (c.includes('siege')) return 'siege';
    if (def.converts) return 'monk';
    if (c.includes('archer')) return c.includes('cavalry') ? 'cavalryArcher' : 'archer';
    if (c.includes('elephant')) return 'elephant';
    if (c.includes('camel')) return 'camel';
    if (c.includes('cavalry')) return 'cavalry';
    if (c.includes('infantry')) return 'infantry';
    return null;
  }

  /**
   * Remembers enemy units we have laid eyes on, for a while after they leave.
   *
   * Each memory also records whether that unit was last seen *attacking us*.
   * Something shooting at our villagers right now is worth several of the same
   * unit standing in their base: the composition should chase what is actually
   * hurting us first.
   */
  rememberEnemies() {
    if (!this.enemyMemory) this.enemyMemory = new Map();
    const now = this.game.time;
    for (const e of this.enemyUnits) {
      const cls = AI.threatClass(e.def);
      if (!cls) continue;
      const hot = Math.hypot(e.x - this.homeX, e.y - this.homeY) < AI.THREAT_RADIUS;
      const prev = this.enemyMemory.get(e.id);
      this.enemyMemory.set(e.id, {
        cls, t: now, value: unitValue(e.def),
        // "Was attacking us" decays more slowly than sight does, so pulling
        // back over the hill does not immediately make them harmless.
        hotUntil: hot ? now + 90 : (prev ? prev.hotUntil : 0),
      });
    }
    for (const [id, m] of this.enemyMemory) {
      const u = this.game.get(id);
      if (!u || !u.alive || now - m.t > AI.MEMORY_SECONDS) this.enemyMemory.delete(id);
    }
  }

  /**
   * The enemy army as the AI understands it: how many of each threat class,
   * what it is worth, and how much of it has been in our town.
   *
   * Allied sightings are folded in - allies already share vision, so an ally
   * who has been fighting Knights all game is telling us something we can see
   * anyway and would otherwise ignore.
   */
  buildThreatProfile() {
    const now = this.game.time;
    const counts = {}, hot = {};
    let total = 0, value = 0, hotTotal = 0;
    for (const m of this.enemyMemory.values()) {
      // An attacker counts three times over. It is the same unit either way, but
      // the one killing our villagers is the one the army has to answer.
      const w = now < m.hotUntil ? 3 : 1;
      counts[m.cls] = (counts[m.cls] || 0) + w;
      total += w;
      value += m.value;
      if (now < m.hotUntil) { hot[m.cls] = (hot[m.cls] || 0) + 1; hotTotal++; }
    }
    const shares = {};
    for (const cls in counts) shares[cls] = counts[cls] / Math.max(1, total);
    return { counts, shares, total, value, hot, hotTotal };
  }

  /**
   * Are enemy soldiers near our town? Used to decide whether to drop everything
   * and put up a Castle.
   */
  assessThreat() {
    let near = 0, closest = Infinity, tx = 0, ty = 0, owner = null;
    for (const e of this.enemyUnits) {
      if (e.def.cat === 'villager' || e.def.cat === 'trade') continue;
      const d = Math.hypot(e.x - this.homeX, e.y - this.homeY);
      if (d > AI.THREAT_RADIUS) continue;
      near++;
      if (d < closest) { closest = d; tx = e.x; ty = e.y; owner = e.owner; }
    }
    const now = this.game.time;
    this.threatCount = near;
    if (near) { this.lastThreatAt = { x: tx, y: ty }; this.threatOwner = owner; }
    this.threatAt = this.lastThreatAt || null;

    // A raid deep in the town counts even if it is only a couple of riders - but
    // a single unit does not. Enemy scouts wander past every base in the early
    // game, and treating one as an attack put the AI on a war footing over and
    // over, which delayed every age-up by minutes.
    const raided = near >= 3 || (near >= 2 && closest < 20);
    if (raided) this.threatUntil = now + 120;
    this.underThreat = now < (this.threatUntil || 0);

    // "We have decided we need a Castle" latches for much longer, and this is
    // the one that drives the stone: 650 stone takes several minutes to mine.
    if (raided) this.castleUrgentUntil = now + 480;
    this.wantEmergencyCastle = this.p.ageIndex >= 2 &&
      now < (this.castleUrgentUntil || 0) &&
      !this.has('castle') && !this.underConstruction('castle') &&
      this.p.isBuildingAvailable('castle');

    this.threatProfile = this.buildThreatProfile();
  }

  /** Distance from a point to our nearest completed drop-off for a resource. */
  dropDist(x, y, res) {
    let best = Infinity;
    for (const b of this.dropSites) {
      if (!b.def.dropSite.includes(res)) continue;
      const d = Math.hypot(b.x - x, b.y - y);
      if (d < best) best = d;
    }
    return best;
  }

  count(type) { return this.mine.byType[type] || 0; }

  has(bType) {
    return this.mine.buildings.some((b) => b.type === bType && b.complete);
  }
  building(bType) {
    return this.mine.buildings.find((b) => b.type === bType && b.complete);
  }
  buildingsOf(bType) {
    return this.mine.buildings.filter((b) => b.type === bType && b.complete);
  }
  underConstruction(bType) {
    return this.mine.buildings.some((b) => b.type === bType && !b.complete);
  }

  /* ================================================================
   *  Economy
   * ================================================================ */

  /**
   * Makes sure every foundation actually has someone building it.
   *
   * A builder can be pulled off a foundation at any time - reassigned, drafted
   * onto another site, killed - and nothing put anyone back. The abandoned
   * foundation then counted as "housing already on the way" forever.
   */
  manageConstruction() {
    const g = this.game;
    for (const b of this.mine.buildings) {
      if (b.complete) continue;
      if (g.buildClaims.get(b.id)) continue;
      const crew = (b.type === 'castle' || b.type === 'townCenter' || b.type === 'wonder') ? 4 : 2;
      const builders = this.pickBuilders(b.x, b.y, crew);
      if (builders.length) g.commandBuildAt(builders, b);
    }
  }

  manageHousing() {
    if (this.p.mods.flags.has('noHouses')) return;
    if (this.p.effectivePopCap >= this.p.popMax) return;
    const headroom = this.p.effectivePopCap - this.p.pop;
    const queued = this.mine.buildings.filter((b) => b.type === 'house' && !b.complete).length;
    // Headroom has to cover everything that can pop at once, so it scales with
    // how fast we are actually spending population rather than with the size of
    // the base. Trade Carts count: a late-game trade fleet is twenty population
    // that appears over a couple of minutes.
    const producers = this.mine.buildings.filter((b) => b.complete && b.def.trains?.length).length;
    const want = Math.min(this.share(0.15), 8 + producers * 2 +
      Math.floor(this.mine.villagers.length / 10) + Math.round(this.pri('trade') * 6));
    if (headroom + queued * 5 >= want) return;
    // Houses are 5 population each, so a big limit needs them laid several at a
    // time or the population cap - not the economy - decides how big the game
    // gets. At 200 this is the same three per pass it always was.
    const batch = Math.min(Math.max(3, Math.round(this.share(0.015))),
      Math.ceil((want - headroom - queued * 5) / 5));
    for (let i = 0; i < batch; i++) if (!this.tryBuild('house')) break;
  }

  /**
   * How many villagers we are working toward.
   *
   * The age's share of the population limit is the ceiling; the boom priority
   * decides how much of it we actually chase. An AI that is winning on map
   * control and floating resources should be building the full economy the
   * limit allows; one that is being run over should stop at whatever it has and
   * spend the food on soldiers instead.
   */
  get villagerTarget() {
    const ceiling = villagerTarget(this.p.popMax, this.p.age);
    const boom = this.pri('boom');
    // The boom priority trims at the margin; it does not halve the plan. An AI
    // that is not actively dying should be making villagers, and scaling the
    // whole target by the priority meant a mid-game dip in `boom` - which any
    // skirmish causes - capped the economy at two thirds of what the map could
    // feed, for the rest of the game.
    // The band is deliberately narrow. Measured head-to-head, an AI that lets
    // pressure cut its villager target ends a fifty-minute game with half the
    // economy of one that simply keeps building them - and loses, even while
    // out-killing its opponent, because everything else it bought with that
    // food had to be bought again after each fight. Villagers compound; nothing
    // else in the game does.
    const floor = Math.min(ceiling, this.ageGate() + 4);
    let target = Math.max(floor, Math.round(ceiling * Math.min(1, 0.8 + boom * 0.3)));

    // Drowning in everything: stop building the economy and build the army
    // instead.
    //
    // Past a few thousand of all four resources the bank is no longer what
    // limits the AI - population is. Another villager adds income it already
    // cannot spend, while occupying a population slot that could hold a
    // Paladin. Cutting the target here is what converts a won economy into the
    // army that actually finishes the game, and it is exactly what a human does
    // when the resource bar stops mattering.
    if (this.glut > GLUT) {
      const over = Math.min(1, (this.glut - GLUT) / GLUT);
      target = Math.round(target * (1 - 0.15 - 0.35 * over));
      // Still enough of an economy to replace losses and hold the ages.
      target = Math.max(this.ageGate(), Math.round(ceiling * 0.35), target);
    }
    return target;
  }

  manageVillagers() {
    const target = this.villagerTarget;
    if (this.mine.villagers.length < target) {
      const tcs = this.buildingsOf('townCenter');
      const cost = this.p.mods.unit('villager').cost;
      // Villager production and the age fund compete for the same food, and
      // both extremes are disasters. Letting a Town Center ignore the reserve
      // outright means the bank never fills - one Town Center eats 50 food
      // about as fast as a Feudal economy earns it, and benchmark games sat in
      // Feudal at minute 25 with a full villager count and no age. Honouring
      // the reserve outright stops production dead the moment the age gate is
      // reached, and the AI spent six minutes of the Dark Age at exactly 17
      // villagers.
      //
      // Conceding a *fraction of the bank* does not work either, and fails in a
      // way worth remembering: "keep producing until the fund is two thirds
      // full" never stops, because production is precisely what keeps the fund
      // from filling. The gate has to move on its own.
      //
      // So it is a ramp against the clock: from the moment saving starts, a
      // rising floor of food is off limits, and villagers are bought out of
      // whatever sits above it.
      //
      // And the first Town Center is exempt for the first few minutes of that
      // save. Applying the floor to every Town Center at once is a disaster in
      // the Castle Age, where the fund is the Imperial Age's 1000 food: the
      // floor rises past anything the bank ever holds and villager production
      // stops permanently. Games ended at 55 villagers with four idle Town
      // Centers. One Town Center booming is what the extra ones are funding.
      const floor = this.ageSaveFloor();
      const exempt = this.ageSaveElapsed() < AI.AGE_SAVE_GRACE;
      const depth = 2 + Math.round(this.pri('boom') * 2);
      for (let i = 0; i < tcs.length; i++) {
        const free = i === 0 && exempt;
        if (!free && this.p.res.food - (cost.food || 0) < floor) break;
        if (!this.canSpend(cost, true)) break;
        const queued = tcs[i].queue.filter((q) => q.kind === 'unit').length;
        if (queued < depth) this.game.queueUnit(tcs[i], 'villager');
      }
    }
    this.cullSurplusVillagers(target);
    this.assignIdle();
  }

  /**
   * At the population cap with a bank we cannot spend, villagers past the
   * target are worth less than the army units their population could hold.
   *
   * Deleting your own villagers looks drastic and is a normal late-game move:
   * at 200 of 200 with twenty thousand resources banked, thirty villagers are
   * thirty Paladins that are not on the field. Only ever a couple at a time,
   * only when every pile is enormous, and only when the population cap is
   * genuinely the thing in the way - so a raid that kills villagers cannot
   * cascade into the AI finishing them off.
   */
  cullSurplusVillagers(target) {
    if (this.glut <= GLUT) return;
    if (this.p.pop < this.p.effectivePopCap - 2) return;
    if (this.p.effectivePopCap < this.p.popMax - this.share(0.025, 5)) return;
    const surplus = this.mine.villagers.length - target;
    if (surplus <= 0) return;
    // Take them off whatever we have most of, and never mid-carry or garrisoned.
    const worst = RESOURCES.reduce((a, b) => (this.stockAvg[a] >= this.stockAvg[b] ? a : b));
    const pool = this.mine.villagers
      .filter((v) => !v.garrisonedIn && !(v.carrying && v.carrying.amount > 0))
      .sort((a, b) => (b.task.resType === worst ? 1 : 0) - (a.task.resType === worst ? 1 : 0));
    for (let i = 0; i < Math.min(2, surplus, pool.length); i++) this.game.kill(pool[i], null);
  }

  /**
   * Puts every idle villager back to work. This is the "no idle villagers"
   * rule: it runs every pass regardless of whether we are still producing, and
   * it falls through every resource before giving up.
   */
  assignIdle() {
    const split = this.resourceDemand();
    const working = { food: 0, wood: 0, gold: 0, stone: 0 };
    for (const v of this.mine.villagers) {
      const t = v.task;
      let r = null;
      if (t.type === 'gather' || t.type === 'deliver') r = t.resType;
      if (r && working[r] !== undefined) working[r]++;
    }
    const total = Math.max(1, this.mine.villagers.length);
    const deficit = (r) => split[r] - working[r] / total;

    // Re-derived rather than using the list cached at the top of the pass: this
    // runs twice per update, and the second call exists precisely to catch the
    // villagers that went idle after the first one.
    for (const v of this.mine.villagers) {
      if (v.task.type !== 'idle' || v.garrisonedIn) continue;
      const order = ['food', 'wood', 'gold', 'stone'].sort((a, b) => deficit(b) - deficit(a));
      for (const want of order) {
        if (this.assignGather(v, want)) { working[want]++; break; }
      }
    }

    // Rebalance. Villagers otherwise keep the job they were first given for the
    // whole game, so the economy drifts and never corrects.
    if (this.mine.villagers.length < 8) return;
    const over = ['food', 'wood', 'gold', 'stone'].sort((a, b) => deficit(a) - deficit(b))[0];
    const under = ['food', 'wood', 'gold', 'stone'].sort((a, b) => deficit(b) - deficit(a))[0];
    if (over === under || deficit(under) - deficit(over) < 0.18) return;
    // One villager per pass, normally. Re-tasking costs a walk, so a twitchy
    // rebalance burns more gathering time than the misallocation it corrects -
    // and a fast one actively breaks things: a crew sent to a distant woodline
    // was being pulled straight back off it, several at a time, before the AI
    // could notice the long haul and plant the Lumber Camp that fixes it.
    //
    // The exception is the emergency Castle, which is a discrete deadline
    // rather than a preference: 650 stone at one villager per second takes
    // three minutes just to assign the crew, and the Castle is needed sooner
    // than that.
    // One a pass normally. More when the bank is genuinely lopsided, because
    // then the misallocation is not drift - it is a crew standing on the wrong
    // resource while another runs dry, and correcting that one villager a
    // second takes minutes.
    const budget = (this.wantEmergencyCastle && under === 'stone') ? 4
      : (this.stockImbalance || 0) > 0.6 ? 3 : 1;
    let moved = 0;
    for (const v of this.mine.villagers) {
      if (moved >= budget) break;
      if (v.task.type !== 'gather' || v.task.resType !== over) continue;
      if (v.carrying && v.carrying.amount > 0) continue;   // let it finish the trip
      if (this.assignGather(v, under)) moved++;
    }
    this.recallTrespassers();
  }

  /**
   * Pulls back villagers who have wandered onto the enemy's side of the map.
   *
   * The AI picks where a villager starts, but not where it ends up: when a tree
   * or a mine runs out the simulation re-tasks the villager to the nearest node
   * of the same kind by itself, with no idea whose half of the map that is. Over
   * an hour a woodcutting crew walks node by node clean across the map, and the
   * first thing the AI hears about it is the villagers dying. One per pass is
   * enough - this is a drift, not a stampede.
   */
  recallTrespassers() {
    if (!this.rivalTowns.length) return;
    let moved = 0;
    for (const v of this.mine.villagers) {
      const t = v.task;
      if (t.type !== 'gather' || !t.targetId) continue;
      if (v.carrying && v.carrying.amount > 0) continue;
      const node = this.game.get(t.targetId);
      if (!node || this.game._isFarm(node)) continue;
      const home = Math.hypot(node.x - this.homeX, node.y - this.homeY);
      const rival = this.rivalDist(node.x, node.y);
      // Well over the line, not merely past the midpoint - a node a little way
      // into contested ground is worth keeping if we got there first.
      if (rival > home * 0.9) continue;
      if (this.assignGather(v, t.resType) && ++moved >= 2) return;
    }
  }

  /**
   * The gather split.
   *
   * The four resource weights come straight out of the priority network, which
   * is what makes them able to depend on things a per-age table never could -
   * the enemy's composition, whether we are trading, how much of the map's gold
   * is left, what our allies are short of. Three hard overrides sit on top,
   * because they are discrete goals rather than preferences: an emergency
   * Castle, an age-up we are banking for, and the physical impossibility of
   * mining a resource that is not on the map.
   */
  resourceDemand() {
    const split = this.brain.resourceSplit();

    // Under attack with no Castle yet, stone is the only resource that matters
    // until there is 650 of it. A Castle bought two minutes sooner is worth more
    // than anything the other three could buy in that time.
    // Enough miners to get the Castle up, not the whole economy. Driving the
    // town onto stone at six times the normal share bought the Castle and lost
    // the game: food and gold collapsed with it, so the AI met the attack with
    // a Castle and eight soldiers. Stone mines hold a handful of villagers each
    // anyway, so a bigger multiplier mostly produces overflow with nowhere to
    // work.
    if (this.wantEmergencyCastle && this.p.res.stone < 700) {
      split.stone *= 3.5;
      for (const k of ['food', 'wood', 'gold']) split[k] *= 0.85;
    }

    // Nothing in the Dark Age costs gold or stone - not one building, not one
    // unit, not the Feudal Age itself - so a villager on either is a villager
    // not walking us toward the next age. This is a fact about the game rather
    // than a preference, which is why it is an override and not a weight.
    // Traced games mined 490 gold before minute eleven while food sat at ten,
    // and reached the Feudal Age at minute twenty.
    if (this.p.ageIndex === 0) {
      split.gold *= 0.15;
      split.stone *= 0.1;
    }

    // A Castle we have decided we want is a 650-stone lump, and a lump that
    // size never arrives out of a 10% share - the trickle is spent on Town
    // Centers and towers long before it reaches the total. Games ran the full
    // hour in the Castle Age with no Castle at all, and therefore never fielded
    // a single unique unit. Once the pile is big enough the boost switches off
    // by itself, so this does not turn into a stone economy.
    if (!this.wantEmergencyCastle && this.wantsAnotherCastle() && this.p.res.stone < 800) {
      split.stone *= 2.4;
    }

    // Whatever the age costs is what we need next, so bias toward it rather
    // than banking the wrong three resources beside a full one.
    if (this.savingForAge && this.reserve) {
      for (const k in this.reserve) {
        if (this.reserve[k] > 0 && this.p.res[k] < this.reserve[k]) split[k] *= 1.8;
      }
    }

    // Persistently short of one thing while drowning in another: move effort
    // off the pile and onto the shortage.
    //
    // The network's float weights already lean this way, but they saturate -
    // past about 700 banked they can barely tell 900 from 4000 - so a long-run
    // imbalance never actually got corrected, and an AI that was always the
    // low one on food stayed that way for the whole game while its wood climbed
    // into five figures. This compares the *averages*, so it answers "we are
    // always short of food" rather than "a Town Center just took 50".
    //
    // Deliberately a comparison between the extremes rather than a threshold on
    // each. An earlier attempt boosted whatever was individually low and became
    // an equalising attractor: it held all four piles level, never accumulated
    // the 1000-food lump the Imperial Age costs, and cost the AI half its
    // economy. Moving from the biggest pile to the smallest cannot do that,
    // because it stops as soon as they are comparable.
    if (this.stockAvg) {
      const usable = RESOURCES.filter((k) => split[k] > 0.03);
      const low = usable.reduce((a, b) => (this.stockAvg[a] <= this.stockAvg[b] ? a : b), usable[0]);
      const high = usable.reduce((a, b) => (this.stockAvg[a] >= this.stockAvg[b] ? a : b), usable[0]);
      // Never rob a pile the age is being saved out of.
      const banking = this.savingForAge && this.reserve &&
        (this.reserve[high] || 0) > this.p.res[high];
      if (low && high && low !== high && !banking &&
          this.stockAvg[low] < this.stockAvg[high] * 0.5) {
        const gap = 1 - this.stockAvg[low] / Math.max(1, this.stockAvg[high]);
        split[low] *= 1 + gap * 1.5;
        split[high] *= 1 - gap * 0.5;
      }
    }

    // Nothing on the map to gather means nothing to assign, however much the
    // network wants it: stone mines run out, and asking for 25% stone once the
    // last one is gone just parks villagers. Food is exempt - farms are always
    // available and are the reason the food economy never truly dries up.
    for (const k of ['wood', 'gold', 'stone']) {
      const left = this.nodes[k].reduce((t, n) => t + (n.amount || 0), 0);
      if (left < 150) split[k] *= 0.15;
      else if (left < 600) split[k] *= 0.6;
    }

    let sum = 0;
    for (const k in split) { split[k] = Math.max(0.02, split[k]); sum += split[k]; }
    for (const k in split) split[k] /= sum;
    return split;
  }

  /** How far a node may sit from its drop-off before it stops being worth working. */
  static MAX_HAUL = 14;
  /** How long the AI keeps countering a unit after last seeing one. */
  static MEMORY_SECONDS = 180;
  /** How close enemy soldiers have to get before the base counts as threatened. */
  static THREAT_RADIUS = 32;
  /** Haul length, in tiles, at which a crew has earned a closer drop-off. */
  static REHOME_DISTANCE = 7;
  /** Tiles a new drop-off must cut off the walk to be worth its wood. Without
   *  a threshold the AI pays 100 wood to turn a fifteen-tile haul into a
   *  fourteen-tile one, and then does it again. */
  static REHOME_GAIN = 3;
  /** How close a resource has to be for a drop-off to still be doing a job. */
  static CAMP_SERVICE_RANGE = 10;
  /** How long a place stays marked dangerous after something of ours is hurt there. */
  static DANGER_SECONDS = 150;
  /** Danger score at which a villager refuses to work a spot at all. */
  static DANGER_REFUSE = 10;

  assignGather(v, res) {
    const g = this.game;
    const pick = (limit, allowUnsafe) => {
      let best = null, bestD = Infinity;
      for (const e of this.nodes[res]) {
        if (!e.alive) continue;
        if ((this.nodeLoad.get(e.id) || 0) >= nodeCap(e)) continue;
        const danger = e._aiDanger || 0;
        if (!allowUnsafe && (e._aiHardDanger || 0) >= AI.DANGER_REFUSE) continue;
        const drop = e._aiDrop === Infinity ? e._aiHome : e._aiDrop;
        if (drop > limit) continue;
        // Walk out once, haul back on every trip - so the haul dominates.
        let d = Math.hypot(e.x - v.x, e.y - v.y) * 0.5 + drop * 3 + e._aiHome * 0.7;
        // Stay on our own side. A node closer to an enemy town than to ours is
        // contested ground: both players send villagers and each leaves its own
        // half of the map untouched.
        // The penalty had to grow with the AI's reach. It now plants Town
        // Centers, camps and Markets much further out, so "near one of our
        // buildings" stopped being a good proxy for "on our side of the map"
        // and both players started meeting in the middle.
        if (e._aiRival !== undefined && e._aiRival < e._aiHome) {
          d += (e._aiHome - e._aiRival) * 5 + 25;
        }
        d += danger * 3;
        if (d < bestD) { bestD = d; best = e; }
      }
      return best;
    };
    const take = (node) => {
      this.nodeLoad.set(node.id, (this.nodeLoad.get(node.id) || 0) + 1);
      g.commandGather([v], node);
      return true;
    };

    const near = pick(AI.MAX_HAUL, false);
    if (near) return take(near);

    if (res === 'food') {
      // Nothing close by: farm instead of trekking across the map.
      const freeFarm = g._findFreeFarm(v);
      if (freeFarm) { g.commandGather([v], freeFarm); return true; }
      const pending = g._nearestUnbuiltFarm(v, null);
      if (pending) { g.commandBuildAt([v], pending); return true; }

      // Farms honour the reserve. Letting them jump it when food is low looks
      // obviously right and is not: Farms are the single largest wood sink in
      // the game, an AI that is short of food is short of it constantly, and
      // the exemption simply redirected the entire wood income into plots.
      // Benchmarks that had been finishing in the Imperial Age collapsed to
      // seven villagers and no army at all.
      if (this.canSpend(this.p.mods.building('farm').cost)) {
        // A farm is a fixed position a villager stands on for minutes, so where
        // it goes matters more than for any other job: prefer safe drop-offs,
        // and refuse to lay plots inside an enemy Castle's range.
        const sites = this.mine.buildings
          .filter((b) => b.complete && b.def.dropSite?.includes('food'))
          .map((b) => ({ b, danger: this.dangerAt(b.x, b.y),
            hard: this.hardDangerAt(b.x, b.y), d: g._distTo(v, b) }))
          .sort((a, b) => (a.danger - b.danger) || (a.d - b.d));
        for (const { b: site, hard } of sites) {
          if (hard >= AI.DANGER_REFUSE) continue;
          const spot = g._nearestFarmSpot(site, this.index, this.pendingSpots,
            (x, y) => this.hardDangerAt(x, y) >= AI.DANGER_REFUSE);
          if (!spot) continue;
          this.pendingSpots.push(spot);
          g.commandBuild([v], 'farm', spot.x, spot.y);
          return true;
        }
        // Every existing drop-off is boxed in. A new Mill on open ground opens a
        // fresh farm block, which is the only way to grow food from here.
        if (!this.underConstruction('mill') && this.buildMill()) return true;
      }
    }
    const far = pick(Infinity, false);
    if (!far) { const risky = pick(Infinity, true); if (risky) return take(risky); }
    if (far) return take(far);

    // Nothing in the cached lists at all - they only cover a radius around the
    // base, and by the late game the forests inside it are gone. Sweep the whole
    // map rather than leave villagers standing idle.
    let best = null, bestD = Infinity;
    for (const e of g.entities) {
      if (!e.alive) continue;
      let ok = false;
      if (e.kind === 'resource' && e.amount > 0 && e.type !== 'relic' && e.type !== 'fish') {
        ok = e.resType === res;
      } else if (e.kind === 'unit' && e.owner < 0 && e.def.huntable && !e.def.hostile) {
        ok = res === 'food';
      }
      if (!ok) continue;
      const over = (this.nodeLoad.get(e.id) || 0) >= nodeCap(e);
      let d = Math.hypot(e.x - v.x, e.y - v.y) + (over ? 200 : 0);
      // The same "stay on our own side" rule the local search uses. This sweep
      // only runs when everything near home is gone, which is exactly when the
      // AI is most tempted to walk into the enemy's woodline - and without the
      // penalty here it did, because this path ranks on raw distance alone.
      const rival = this.rivalDist(e.x, e.y);
      const home = Math.hypot(e.x - this.homeX, e.y - this.homeY);
      if (rival < home) d += (home - rival) * 5 + 25;
      if (d < bestD) { bestD = d; best = e; }
    }
    return best ? take(best) : false;
  }

  /**
   * Buying and selling at the Market.
   *
   * This is the cheap, instant half of trade - a fixed 100 at a time at a bad
   * rate. It exists to unblock a build, not to run an economy: what actually
   * pays the late game is Trade Carts, below.
   */
  manageMarket() {
    if (!this.has('market')) return;
    const g = this.game;
    const r = this.p.res;
    const want = this.brain.resourceSplit();
    const price = Math.round(100 * (1 + this.p.mods.marketFee));

    /** Turn a pile the plan is not asking for into gold. Gold is never sold -
     *  selling is how you *get* gold. */
    const sellSurplus = (except) => {
      const pile = ['stone', 'wood', 'food']
        .filter((k) => k !== except && r[k] > 400 && want[k] < 0.2)
        .sort((a, b) => r[b] - r[a])[0];
      return pile ? g.marketTrade(this.index, pile, 'sell') : false;
    };

    // What is actually blocking us, worst shortfall first - measured against
    // what the plan wants rather than against a flat number, so "200 stone" is
    // a crisis for an AI that needs a Castle and irrelevant for one that does
    // not.
    const blocked = ['food', 'wood', 'stone', 'gold']
      .filter((k) => r[k] < 220 && want[k] > 0.12)
      .sort((a, b) => r[a] / want[a] - r[b] / want[b]);

    for (const need of blocked) {
      if (need !== 'gold') {
        // How much gold this is worth spending depends on how starved we are.
        // A flat "only if we hold 700 gold" left allied AIs at 33 wood with 600
        // gold and 670 stone banked: they could not afford a Farm, a Trade Cart
        // or a House, and simply stopped - a whole economy halted over a
        // resource they were drowning in, two clicks from the Market they owned.
        const floor = r[need] < 120 ? price + 120 : price + 500;
        if (r.gold >= floor) { g.marketTrade(this.index, need, 'buy'); return; }
      }
      if (sellSurplus(need)) return;
    }

    // Short of whatever we are currently saving for: same trade, but measured
    // against the reserve rather than against zero.
    //
    // This is what finally gets Castles built. Stone is the one resource a map
    // genuinely runs out of near a town, so by the Imperial Age the AI can want
    // a Castle, allocate a fifth of its villagers to stone, and still sit at
    // 300 for the rest of the game because there is nothing left to mine. It
    // was doing that while holding eleven thousand resources and two Markets.
    // Buying the last 350 stone is the obvious move and it could not see it,
    // because the rule only looked at ages.
    if (this.reserve) {
      for (const need of ['stone', 'food', 'gold', 'wood']) {
        const owed = this.reserve[need] || 0;
        if (!owed || r[need] >= owed) continue;
        if (need !== 'gold' && r.gold >= price + 100) {
          g.marketTrade(this.index, need, 'buy');
          return;
        }
        if (sellSurplus(need)) return;
      }
    }

    // Deliberately *not* here: buying the 650 stone for a Castle the mines can
    // no longer supply. It looks like the obvious use for a late-game gold pile
    // and it is not - at a 30% market fee it costs most of the 800 gold the
    // Imperial Age needs, and measured across every seed it traded "reaches
    // Imperial with a hundred villagers and a real army" for "one Castle and no
    // Imperial Age at all". A Castle the map cannot pay for is a Castle worth
    // going without.

    // Nothing is blocked: dump a genuinely excessive pile back into gold, which
    // is the one resource that always has something to spend it on.
    for (const res of ['stone', 'wood', 'food']) {
      if (r[res] > 1500 && want[res] < 0.2) { g.marketTrade(this.index, res, 'sell'); return; }
    }
  }

  /* ================================================================
   *  Trade
   * ================================================================ */

  /**
   * The late-game economy: Markets and Trade Carts.
   *
   * Gold is the only resource on the map that genuinely runs out, and every
   * unit worth fielding in the Imperial Age costs it. An AI with no trade hits a
   * wall the moment its mines are empty - it can still farm and cut wood forever,
   * so it keeps making villagers, but it cannot buy a single Paladin and the
   * game just stops being a game. Trade Carts turn wood and walking distance
   * into gold indefinitely, which is what lets a long game stay a long game.
   *
   * The trade priority already knows about gold scarcity, the age, how safe the
   * route is, whether there is an ally to trade with, and whether the town is
   * currently on fire. This just spends against it.
   */
  manageTrade() {
    const g = this.game;
    const want = this.pri('trade');
    if (this.p.ageIndex < 1) return;

    // A Market at all. It is worth 175 wood long before any Trade Cart is, and
    // not because of trade: it is the only way to turn a resource the current
    // age cannot spend into one it is blocked on. A Feudal AI with 600 idle
    // gold and no Market cannot buy its way out of anything.
    const r = this.p.res;
    if (!this.has('market') && !this.underConstruction('market')) {
      const stuck = (r.gold > 450 || r.stone > 500) && (r.wood < 200 || r.food < 200);
      if (r.wood > 240 || stuck || want > 0.45) this.tryBuild('market');
      return;
    }

    // No second Market for its own sake. Carts run to an ally's town, so the one
    // Market we have is both ends of our side of the route; a second is only
    // ever wanted as a place to buy and sell, which the first already is.
    const markets = this.buildingsOf('market');

    if (!this.tradeRoute) return;

    // How big a trade fleet to run. Carts cost population, so this competes with
    // the army and has to stay a minority of it - but a fleet too small to
    // matter is 100 wood each thrown away.
    const room = this.p.effectivePopCap - this.p.pop;
    const ceiling = Math.round(this.share(0.15));
    const target = Math.round(ceiling * Math.max(0, want - 0.3) / 0.7);
    const have = this.mine.traders.length +
      this.mine.buildings.reduce((n, b) =>
        n + b.queue.filter((q) => q.kind === 'unit' && q.id === 'tradeCart').length, 0);

    if (have < target && room > 4 && this.p.isUnitAvailable('tradeCart')) {
      const cost = this.p.mods.unit('tradeCart').cost;
      // Bootstrapping the fleet once the mines are already dry. A Trade Cart
      // costs 50 gold, so an AI that has run its gold to zero cannot buy the
      // one thing that would fix that - it has to sell something first. This is
      // the case where paying the market fee is unambiguously right: the cart
      // earns it back in a couple of trips and then keeps paying for the rest
      // of the game. Without it the AI reaches the Imperial Age, watches its
      // last mine run out, and simply stops.
      if (this.p.res.gold < (cost.gold || 0) + 60 && this.income.gold < 30) {
        for (const res of ['food', 'wood', 'stone']) {
          if (this.p.res[res] > 500 && g.marketTrade(this.index, res, 'sell')) break;
        }
      }
      // Carts are bought out of spare wood only. They cost 100 each, which is
      // most of a Town Center every three carts, and letting them jump the
      // reserve meant an AI in the Castle Age spent its expansion wood on a
      // trade fleet and finished the game on one Town Center.
      for (const m of markets) {
        if (m.queue.length >= 3) continue;
        if (!this.canSpend(cost)) break;
        if (!g.queueUnit(m, 'tradeCart')) break;
        break;                                  // one per pass; the fleet builds up
      }
    }

    // Route every cart that is not already running, and re-route the ones whose
    // destination has been razed - a cart with a dead market stands still
    // forever, which is 100 wood and a population slot doing nothing.
    const dest = this.tradeRoute.market;
    for (const cart of this.mine.traders) {
      const t = cart.task;
      if (t.type === 'trade') {
        const m = g.get(t.marketId), home = g.get(t.homeId);
        if (m && m.alive && home && home.alive) continue;
      }
      g.commandTrade([cart], dest);
    }
  }

  /**
   * Puts our second Market as far from the first as our territory reaches.
   *
   * "As far as possible" is not the same as "at the map edge": the route has to
   * be defensible, so this walks outward away from the enemy rather than toward
   * them, and refuses ground that is already under fire.
   */
  buildDistantMarket(first) {
    if (!first) return false;
    const g = this.game;
    // Candidates all round the compass, ranked by how far they actually end up
    // from the existing Market once the map edge has had its say.
    //
    // Pushing in one chosen direction does not work. A town near the north edge
    // pointed "away from the middle" straight off the map, the clamp pulled the
    // site back to nine tiles from home, and nine tiles is below the distance a
    // Trade Cart needs to be worth building at all - so the AI built three
    // Markets in a huddle and never ran a single cart between them.
    const away = this.enemyBase || { x: g.size / 2, y: g.size / 2 };
    let best = null, bestScore = 0;
    for (let i = 0; i < 24; i++) {
      const a = i * (Math.PI * 2 / 24);
      for (const reach of [42, 34, 26]) {
        const tx = Math.max(6, Math.min(g.size - 8, first.x + Math.cos(a) * reach));
        const ty = Math.max(6, Math.min(g.size - 8, first.y + Math.sin(a) * reach));
        const dist = Math.hypot(tx - first.x, ty - first.y);
        // Below this the round trip earns less than the cart cost to build.
        if (dist < 20) continue;
        if (this.hardDangerAt(tx, ty) >= AI.DANGER_REFUSE) continue;
        // Long, and pointing away from whoever might come and burn it down.
        const safety = Math.hypot(tx - away.x, ty - away.y);
        const score = dist + safety * 0.4;
        if (score > bestScore) { bestScore = score; best = { x: tx, y: ty }; }
      }
    }
    if (!best) return false;
    return this.tryBuildAt('market', best.x, best.y, 0, 8);
  }

  /* ================================================================
   *  Drop sites and economy buildings
   * ================================================================ */

  /**
   * Puts a camp on top of villagers who are walking too far to drop off.
   *
   * This reacts to the workers rather than to the map: a crew that started
   * beside a Lumber Camp and ended up hauling fifteen tiles keeps hauling
   * fifteen tiles forever otherwise.
   * @returns true if it laid one
   */
  rehomeDistantGatherers(cap) {
    const pairs = [['wood', 'lumberCamp'], ['gold', 'miningCamp'], ['stone', 'miningCamp'], ['food', 'mill']];
    for (const [res, bId] of pairs) {
      if (this.underConstruction(bId)) continue;
      // This used to have no ceiling at all, and that is most of why the AI
      // grew clumps of camps: it fires whenever a crew's walk is long, and a
      // badly sited camp does not shorten the walk, so it fired again next pass,
      // and again. Capped like every other drop-off decision.
      if (this.activeDropSites(bId) >= cap[bId]) continue;
      if (!this.p.isBuildingAvailable(bId)) continue;
      if (!this.canSpend(this.p.mods.building(bId).cost, true)) continue;

      const far = [];
      for (const v of this.mine.villagers) {
        const t = v.task;
        if ((t.type !== 'gather' && t.type !== 'deliver') || t.resType !== res) continue;
        // Farmers are beside their Mill by construction; counting them would
        // drag the average down.
        const node = this.game.get(t.type === 'deliver' ? t.returnTo : t.targetId);
        if (!node || this.game._isFarm(node)) continue;
        const haul = this.dropDist(node.x, node.y, res);
        if ((node._aiHardDanger || 0) >= AI.DANGER_REFUSE) continue;
        if (haul > AI.REHOME_DISTANCE && haul !== Infinity) far.push({ v, node, haul });
      }
      // One villager on a long walk is not worth 100 wood; a crew is.
      if (far.length < 3) continue;

      const nodes = far.map((f) => f.node);
      const spot = this.findDropSpot(bId, nodes);
      if (!spot) continue;
      // And it has to actually shorten the walk. Without this the AI happily
      // pays 100 wood to move a fifteen-tile haul to a fourteen-tile one, then
      // notices the haul is still long and does it again.
      const before = far.reduce((t, f) => t + f.haul, 0) / far.length;
      if (spot.cost > before - AI.REHOME_GAIN) continue;
      if (this.commitBuild(bId, spot)) return true;
    }
    return false;
  }

  /**
   * How many drop-offs of each kind the economy can usefully staff.
   *
   * Without a ceiling the AI plants one at every berry patch and forest edge on
   * the map and spends its whole wood income on buildings it has nobody to work
   * from.
   */
  dropSiteCaps() {
    const v = this.mine.villagers.length;
    const per = (f) => Math.max(1, this.share(f));
    return {
      lumberCamp: 2 + Math.floor(v / per(0.075)),
      miningCamp: 2 + Math.floor(v / per(0.125)),
      mill: 1 + Math.floor(v / per(0.15)),
    };
  }

  /**
   * Drop-offs of a kind that still have something to drop off *into* them.
   *
   * A Lumber Camp whose forest has been cut down is a dead building. It is
   * still standing, so it still counted against the camp ceiling, so the AI
   * refused to put a new one next to the trees its villagers had moved on to -
   * and the crew kept walking further every minute as the woodline receded.
   * The whole point of the ceiling is to stop the AI paying for camps it cannot
   * staff, and a camp with no resource left is exactly that.
   */
  activeDropSites(bId) {
    return this.mine.buildings.filter((b) => {
      if (b.type !== bId) return false;
      if (!b.complete) return true;                 // under construction, assume good
      const kinds = b.def.dropSite || [];
      for (const res of kinds) {
        const pool = this.nodes[res];
        if (!pool) continue;
        for (const n of pool) {
          if (n.alive && Math.hypot(n.x - b.x, n.y - b.y) < AI.CAMP_SERVICE_RANGE) return true;
        }
        // Farms are not in `nodes`, so a Mill beside a farm block still counts.
        if (res === 'food' && this.mine.buildings.some((f) =>
          f.type === 'farm' && Math.hypot(f.x - b.x, f.y - b.y) < AI.CAMP_SERVICE_RANGE)) return true;
      }
      return false;
    }).length;
  }

  manageDropSites() {
    const cap = this.dropSiteCaps();
    if (this.rehomeDistantGatherers(cap)) return;
    const pairs = [['wood', 'lumberCamp'], ['gold', 'miningCamp'], ['stone', 'miningCamp'], ['food', 'mill']];
    for (const [res, bId] of pairs) {
      if (this.underConstruction(bId)) continue;
      if (this.activeDropSites(bId) >= cap[bId]) continue;
      if (!this.p.isBuildingAvailable(bId)) continue;
      // Drop-off buildings outrank the reserve: shortening every round trip pays
      // for the Town Center faster than saving for it does.
      if (!this.canSpend(this.p.mods.building(bId).cost, true)) continue;

      // Every node worth serving: far enough from an existing drop-off to be
      // costing us real walking, on our side of the map, and safe.
      const candidates = this.nodes[res].filter((n) =>
        n._aiDrop >= AI.REHOME_DISTANCE &&
        !(n._aiRival !== undefined && n._aiRival < n._aiHome) &&
        (n._aiHardDanger || 0) < AI.DANGER_REFUSE &&
        !(res === 'food' && n.kind === 'resource' && n.type !== 'berries'));
      if (candidates.length < 3) continue;

      // Pick the densest un-served patch, then site the camp in the middle of
      // that patch rather than on the one node that happened to score highest.
      // Scoring a single node and then dropping the building somewhere in a ring
      // around it is what produced camps sitting next to a woodline instead of
      // in it.
      // Nearer patches first. Weighting distance from home only lightly meant
      // the AI skipped a nine-tree stand sixteen tiles away to put its camp in a
      // bigger forest forty tiles out - more wood in total, but every trip from
      // it is twice as long, and the near stand then never got worked at all.
      // The walk is the cost that repeats; the size of the forest is not.
      const rank = (n) => n._aiDrop - n._aiHome * 1.2;
      const shortlist = candidates.sort((a, b) => rank(b) - rank(a)).slice(0, 12);
      let best = null, bestScore = -Infinity;
      for (const n of shortlist) {
        const patch = candidates.filter((m) =>
          Math.abs(m.x - n.x) < 6 && Math.abs(m.y - n.y) < 6);
        const score = patch.length * 3 + rank(n);
        if (score > bestScore) { bestScore = score; best = patch; }
      }
      if (!best) continue;
      const spot = this.findDropSpot(bId, best);
      if (!spot) continue;
      // The patch has to end up genuinely closer to this camp than to whatever
      // already serves it, or we are paying 100 wood for nothing.
      const before = best.reduce((t, n) => t + n._aiDrop, 0) / best.length;
      if (spot.cost > before - AI.REHOME_GAIN) continue;
      if (this.commitBuild(bId, spot)) return;
    }
  }

  manageEconomyBuildings() {
    const a = this.p.ageIndex;
    const v = this.mine.villagers.length;
    // One Mill supports roughly a block of eight farms, so mills scale with the
    // number of villagers that will end up farming.
    if (a >= 1 && this.count('mill') < Math.min(this.share(0.04, 3), 1 + Math.floor(v / Math.max(1, this.share(0.07)))) &&
      !this.underConstruction('mill')) this.buildMill();

    // More Town Centers is the single biggest boom lever, and how many we want
    // is an expansion decision rather than a fixed per-age number.
    const tcWant = this.townCenterTarget();
    const tcCost = this.p.mods.building('townCenter').cost;
    if (a >= 2 && this.count('townCenter') < tcWant && !this.underConstruction('townCenter') &&
      this.p.canAfford(tcCost)) {
      // Put the new one on unworked resources rather than beside the old one,
      // and away from ground the enemy is holding.
      const spread = this.nodes.wood.concat(this.nodes.gold)
        .filter((n) => n._aiDrop > 12 && (n._aiHardDanger || 0) < AI.DANGER_REFUSE &&
          !(n._aiRival !== undefined && n._aiRival < n._aiHome))
        .sort((x, y) => y._aiDrop - x._aiDrop)[0];
      if (spread) this.tryBuildAt('townCenter', spread.x, spread.y, 3, 7);
      else this.tryBuild('townCenter');
    }
  }

  manageAge() {
    const nextAge = AGES[this.p.ageIndex + 1];
    if (!nextAge) return;
    const techId = nextAge + 'Age';
    if (this.p.researching.has(techId) || this.p.researched.has(techId)) return;
    const tc = this.buildingsOf('townCenter').find((b) => b.queue.every((q) => q.kind === 'unit'));
    if (!tc) return;
    if (!this.p.isTechAvailable(techId)) return;
    const cost = this.p.mods.techCost(TECHS[techId]);
    if (!this.p.canAfford(cost)) return;
    if (this.mine.villagers.length < this.ageGate()) return;
    this.game.queueTech(tc, techId);
  }

  /* ================================================================
   *  Military buildings, castles and towers
   * ================================================================ */

  manageMilitaryBuildings() {
    const a = this.p.ageIndex;
    const mil = this.pri('military');
    if (a >= 0 && !this.has('barracks') && !this.underConstruction('barracks') &&
      this.mine.villagers.length >= this.share(0.06, 8)) this.tryBuild('barracks');
    if (a >= 1) {
      // Blacksmith first in Feudal: every upgrade in it applies to the whole
      // army for the rest of the game, so it is the cheapest army we can buy.
      if (!this.has('blacksmith') && !this.underConstruction('blacksmith')) this.tryBuild('blacksmith');
      const wantRange = !this.p.disabledUnits.has('archer');
      const wantStable = !this.p.disabledBuildings.has('stable');
      const v = this.mine.villagers.length;
      // Add production when the production we already have is the bottleneck -
      // every queue full while resources pile up - rather than guessing from a
      // wood total. Capacity it cannot feed is still waste, so the count stays
      // capped, and the military priority scales the cap.
      const busy = this.mine.buildings.filter((b) =>
        b.complete && b.def.trains.length && b.type !== 'townCenter' && b.queue.length >= 3);
      const producers = this.mine.buildings.filter((b) =>
        b.complete && b.def.trains.length && b.type !== 'townCenter' && b.type !== 'monastery');
      const saturated = producers.length > 0 && busy.length >= producers.length;
      // A second Barracks is worth more than a comfortable wood float when the
      // army is the thing standing between us and losing. Games where the AI
      // was being ground down sat on exactly three production buildings for
      // forty minutes because the wood never reached the flat threshold.
      const spare = this.p.res.wood > 350 || (saturated && this.p.res.wood > 175) ||
        (mil > 0.7 && this.p.res.wood > 220);
      const ceiling = Math.round((a >= 3 ? 5 : a >= 2 ? 3 : 2) * (0.5 + mil) * this.popScale);
      const each = !spare ? 1 : Math.max(1, Math.min(ceiling, 1 + Math.floor(v / Math.max(1, this.share(0.11)))));
      if (this.count('barracks') < each && !this.underConstruction('barracks')) this.tryBuild('barracks');
      if (wantRange && this.count('archeryRange') < each && !this.underConstruction('archeryRange'))
        this.tryBuild('archeryRange');
      if (wantStable && this.count('stable') < each && !this.underConstruction('stable'))
        this.tryBuild('stable');
    }
    if (a >= 2) {
      // Siege and the Monastery follow their own priorities rather than being
      // built because the age arrived: an AI with no reason to want Monks
      // should not be paying 175 wood for the building that makes them.
      if (this.pri('siege') > 0.35 && !this.has('siegeWorkshop') &&
        !this.underConstruction('siegeWorkshop')) this.tryBuild('siegeWorkshop');
      if (!this.has('university') && !this.underConstruction('university') &&
        this.pri('tech') > 0.4) this.tryBuild('university');
      if (this.pri('monk') > 0.4 && !this.has('monastery') &&
        !this.underConstruction('monastery')) this.tryBuild('monastery');
    }
  }

  /**
   * Castles, sited on purpose rather than dropped wherever the placement search
   * happened to land.
   *
   * There are two completely different reasons to build one and they want
   * opposite positions. A defensive Castle goes where it covers the most of our
   * own economy, so its arrows are actually shooting at raiders. An aggressive
   * Castle goes inside the enemy's reach - close enough that its fire and its
   * unique units are a permanent problem for them - and it is only ever worth
   * building when we are already winning the field, because a forward Castle
   * with no army around it is 650 stone donated to the opponent.
   */
  manageCastles() {
    if (this.p.ageIndex < 2) return;
    if (!this.p.isBuildingAvailable('castle')) return;
    if (this.underConstruction('castle')) return;
    if (!this.wantsAnotherCastle()) return;
    const cost = this.p.mods.building('castle').cost;
    if (!this.p.canAfford(cost)) return;

    const forward = this.pri('forwardCastle');
    const defend = this.pri('defCastle');

    // The first Castle is always a defensive one. Planting the opening Castle in
    // their base leaves our own town naked, and the unique units it makes have
    // to walk home to defend anything.
    if (forward > 0.55 && forward > defend && this.count('castle') >= 1) {
      const spot = this.findForwardCastleSpot();
      if (spot && this.tryBuildAt('castle', spot.x, spot.y, 0, 8)) return;
    }
    // A chosen spot is a preference, not a requirement. A Castle is 4x4 and the
    // best position for one is usually in the middle of a finished town, so the
    // placement search fails often - and with no fallback the AI simply never
    // built one, which also meant it never trained a single unique unit.
    const spot = this.findDefensiveCastleSpot();
    if (spot && this.tryBuildAt('castle', spot.x, spot.y, 0, 8)) return;
    this.tryBuild('castle');
  }

  /**
   * Where a Castle covers the most of what we care about.
   *
   * Scores candidate positions by the value inside the Castle's own range: our
   * villagers, our drop-offs and Town Centers, and the resource nodes we are
   * still working. Ground that has been raided recently scores extra - that is
   * where the attacks actually come, and it is the difference between a Castle
   * that shoots raiders and a Castle that watches them from across the town.
   */
  findDefensiveCastleSpot() {
    const range = (this.p.mods.building('castle').range || 8) + 2;
    const candidates = [];
    // Our own key buildings, and the direction the last attack came from.
    for (const b of this.mine.buildings) {
      if (!b.complete) continue;
      if (b.type === 'townCenter' || b.def.dropSite) candidates.push({ x: b.x, y: b.y });
    }
    if (this.threatAt) {
      const dx = this.threatAt.x - this.homeX, dy = this.threatAt.y - this.homeY;
      const d = Math.hypot(dx, dy) || 1;
      candidates.push({ x: this.homeX + (dx / d) * 8, y: this.homeY + (dy / d) * 8 });
    }
    for (const s of this.dangerSpots || []) candidates.push({ x: s.x, y: s.y });
    if (!candidates.length) return null;

    let best = null, bestScore = -Infinity;
    for (const c of candidates) {
      let score = 0;
      for (const v of this.mine.villagers) {
        if (Math.hypot(v.x - c.x, v.y - c.y) < range) score += 1;
      }
      for (const b of this.mine.buildings) {
        if (!b.complete) continue;
        const d = Math.hypot(b.x - c.x, b.y - c.y);
        if (d > range) continue;
        score += b.type === 'townCenter' ? 8 : b.def.dropSite ? 4 : 0.5;
        // Two Castles covering the same square metre is a wasted 650 stone.
        if (b.type === 'castle' && d < range * 1.6) score -= 40;
      }
      for (const s of this.dangerSpots || []) {
        if (Math.hypot(s.x - c.x, s.y - c.y) < range) score += 6;
      }
      // Still has to be our town, not a lone outpost.
      const home = Math.hypot(c.x - this.homeX, c.y - this.homeY);
      if (home > 40) continue;
      score -= home * 0.15;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return best;
  }

  /**
   * A Castle planted in the enemy's half.
   *
   * Sited just outside whatever they already have shooting at it, and only on
   * ground our army is actually standing on - the builders have to survive the
   * two hundred seconds it takes to raise, and nothing but our own soldiers is
   * going to make that happen.
   */
  findForwardCastleSpot() {
    if (!this.enemyBase) return null;
    const g = this.game;
    const range = this.p.mods.building('castle').range || 8;
    // Somewhere our army is, that is also close to something of theirs.
    let cx = 0, cy = 0, n = 0;
    for (const u of this.mine.army) {
      const d = Math.hypot(u.x - this.enemyBase.x, u.y - this.enemyBase.y);
      if (d > 40) continue;
      cx += u.x; cy += u.y; n++;
    }
    // No presence out there means no forward Castle. Building one anyway is how
    // an AI donates 650 stone and four villagers.
    if (n < 8) return null;
    cx /= n; cy /= n;

    // Pull it in toward their base, but not so far that it starts inside their
    // existing Castle or Town Center fire before it has any hit points.
    const dx = this.enemyBase.x - cx, dy = this.enemyBase.y - cy;
    const d = Math.hypot(dx, dy) || 1;
    for (const step of [0.55, 0.35, 0.15, 0]) {
      const tx = cx + (dx / d) * (d * step);
      const ty = cy + (dy / d) * (d * step);
      if (tx < 4 || ty < 4 || tx > g.size - 5 || ty > g.size - 5) continue;
      // Their own defences: sitting inside one is not aggression, it is a gift.
      let covered = false;
      for (const b of this.rivalTowns) {
        if (!(b.def.range > 0)) continue;
        if (Math.hypot(b.x - tx, b.y - ty) < b.def.range + 3) { covered = true; break; }
      }
      if (covered) continue;
      // And it has to actually reach something worth shooting.
      const reaches = this.rivalTowns.some((b) => Math.hypot(b.x - tx, b.y - ty) < range + 6);
      if (!reaches && step > 0) continue;
      return { x: tx, y: ty };
    }
    return null;
  }

  /**
   * Towers. Cheap, immediate, and the only stone defence available before the
   * Castle Age - so they are what the fortify priority actually buys most of.
   */
  manageTowers() {
    const a = this.p.ageIndex;
    if (a < 1) return;
    const fortify = this.pri('fortify');
    const have = this.count('watchTower') + this.count('guardTower') + this.count('keep');
    // Towers are a supplement to an army, never a substitute for one. A high
    // fortify priority used to buy up to seven of them, which is a Castle's
    // worth of stone spent on buildings that cannot chase anybody - and the
    // economy that paid for it fielded eight soldiers.
    const want = Math.round(fortify * (1 + a * 1.5) * this.popScale);
    if (have >= want) return;
    if (this.underConstruction('watchTower')) return;
    // Never out of the stone something bigger is saving for.
    if (!this.canSpend(this.p.mods.building('watchTower').cost)) return;
    if (this.p.res.stone < 200) return;

    // Facing whoever hit us last, if anyone has; otherwise over the economy that
    // is furthest from the Town Center, which is the part nothing else covers.
    if (this.threatAt) {
      const dx = this.threatAt.x - this.homeX, dy = this.threatAt.y - this.homeY;
      const d = Math.hypot(dx, dy) || 1;
      if (this.tryBuildAt('watchTower', this.homeX + (dx / d) * 9, this.homeY + (dy / d) * 9, 1, 5)) return;
    }
    const outpost = this.mine.buildings
      .filter((b) => b.complete && (b.def.dropSite || b.type === 'townCenter'))
      .sort((x, y) => Math.hypot(y.x - this.homeX, y.y - this.homeY) -
        Math.hypot(x.x - this.homeX, x.y - this.homeY))[0];
    if (outpost) this.tryBuildAt('watchTower', outpost.x, outpost.y, 2, 6);
    else this.tryBuildAt('watchTower', this.homeX, this.homeY, 5, 9);
  }

  /**
   * Enemy soldiers in the town: put up a Castle, now, between them and us.
   *
   * This runs ahead of every other spend and ignores the normal reserve. A
   * Castle is 650 stone and takes real time to build, so reacting to a raid at
   * the usual leisurely pace means it finishes after the town is already gone.
   * Towers are the stopgap while the stone accumulates.
   */
  manageEmergencyDefence() {
    if (!this.underThreat && !this.wantEmergencyCastle) return;
    if (this.p.ageIndex < 2) return;
    const at = this.threatAt || { x: this.homeX, y: this.homeY };
    const dx = at.x - this.homeX, dy = at.y - this.homeY;
    const d = Math.hypot(dx, dy) || 1;
    const bx = this.homeX + (dx / d) * 7, by = this.homeY + (dy / d) * 7;

    if (this.wantEmergencyCastle) {
      const cost = this.p.mods.building('castle').cost;
      if (this.p.canAfford(cost)) {
        if (this.tryBuildAt('castle', bx, by, 2, 8) || this.tryBuild('castle')) return;
      } else {
        // Cannot afford it yet - a Tower buys the time to get there.
        if (this.p.res.stone > 150 && !this.underConstruction('watchTower')) {
          this.tryBuildAt('watchTower', bx, by, 1, 5);
        }
        return;
      }
    }
    // Already have one: thicken the wall facing them.
    if (this.p.res.stone > 400 && !this.underConstruction('watchTower') &&
        this.count('watchTower') + this.count('guardTower') + this.count('keep') < 6) {
      this.tryBuildAt('watchTower', bx, by, 1, 6);
    }
  }

  /**
   * Nothing should sit in the bank. Resources in the stockpile do no work, so
   * once we are clearly floating we convert the excess into permanent capacity.
   */
  spendSurplus() {
    const r = this.p.res, a = this.p.ageIndex;
    if (a >= 1 && r.wood > 700) {
      const pick = ['archeryRange', 'stable', 'barracks'][this.mine.buildings.length % 3];
      if (!this.underConstruction(pick)) this.tryBuild(pick);
    }
    if (a >= 2 && r.wood > 500 && r.stone > 400 && !this.underConstruction('townCenter')) {
      this.tryBuild('townCenter');
    }
    if (a >= 2 && r.stone > 900 && !this.underConstruction('castle')) this.tryBuild('castle');
  }

  /* ================================================================
   *  Army
   * ================================================================ */

  /**
   * The army we want, as target shares of the whole rather than a list.
   *
   * The counter half and the backbone half are blended by the `counter`
   * priority: an AI that has been hit by something specific chases the answer to
   * it, and one that has seen nothing in particular builds a rounded army. Siege
   * and Monk shares are their own priorities for the same reason - a plain list
   * with round-robin queueing gave "some siege once available" a third of the
   * army and the AI fielded piles of Battering Rams.
   *
   * @returns array of { id, share } summing to roughly 1
   */
  desiredComposition() {
    // Our own sightings, plus everything the team has seen. Allies share vision
    // already, so this is information we could have read off the map anyway -
    // and a team where only one member builds Pikemen loses the other half free.
    const own = this.threatProfile || this.buildThreatProfile();
    const shares = {};
    const teamShares = this.team.enemyShares || {};
    const teamWeight = this.team.members.length > 1 ? 0.35 : 0;
    for (const cls in own.shares) shares[cls] = own.shares[cls] * (1 - teamWeight);
    for (const cls in teamShares) shares[cls] = (shares[cls] || 0) + teamShares[cls] * teamWeight;

    const a = this.p.ageIndex;
    const pick = (...ids) => ids.find((id) => id && this.p.isUnitAvailable(id)) || null;
    const wants = [];
    const add = (share, ...ids) => {
      if (share <= 0) return;
      const id = pick(...ids);
      if (!id) return;
      const existing = wants.find((w) => w.id === id);
      if (existing) existing.share += share;      // two threats wanting the same answer
      else wants.push({ id, share });
    };

    const counter = this.pri('counter');
    // How hard to chase counters versus building a rounded army. High when what
    // they field is not answered by what we field; low when we are comfortable.
    const counterGain = 0.5 + counter * 1.5;
    const backboneGain = 1.3 - counter * 0.6;

    if (own.total === 0 && !Object.keys(teamShares).length) {
      // Nothing met yet: a generic opening, and the scout that will find them.
      add(0.5, 'archer', 'spearman', 'militia');
      add(0.5, 'scoutCavalry', 'eagleScout', 'spearman');
    } else {
      for (const cls in shares) {
        const share = shares[cls];
        if (share < 0.12) continue;               // a stray scout is not a strategy
        const answers = COUNTERS[cls];
        if (!answers) continue;
        add(share * 0.7 * counterGain, ...answers[0]);
        if (answers[1]) add(share * 0.3 * counterGain, ...answers[1]);
      }
    }

    // A backbone that is always wanted, so the army is never purely reactive -
    // and split one entry per production building. Merging infantry and cavalry
    // into a single "best available" entry meant that whenever a Stable existed
    // the Barracks had nothing it could train and stood idle all game.
    add(0.22 * backboneGain, 'paladin', 'cavalier', 'knight', 'camelRider', 'steppeLancer', 'battleElephant');
    add(0.18 * backboneGain, 'champion', 'twoHandedSwordsman', 'longSwordsman', 'manAtArms', 'militia',
      'eliteEagleWarrior', 'eagleWarrior', 'eagleScout');
    add(0.2 * backboneGain, 'arbalester', 'crossbowman', 'archer', 'eliteSkirmisher', 'skirmisher');
    // The unique unit is the best thing most civs can field, and every Castle is
    // another one producing it - so the share grows with how many we have.
    if (a >= 2 && this.has('castle')) {
      add((0.34 + 0.14 * Math.min(3, this.count('castle') - 1)) * backboneGain,
        this.p.civ.uuElite, this.p.civ.uu);
    }

    // Siege is support: enough to break a wall or a Town Center, never the army
    // itself. Its share is a priority, so an AI that has to crack a walled base
    // builds rams and one fighting in the open field does not.
    if (a >= 2) {
      const siege = this.pri('siege');
      add(0.16 * siege, 'siegeRam', 'cappedRam', 'batteringRam');
      add(0.14 * siege, 'onager', 'mangonel');
    }
    // Monks convert what we cannot kill and pick up relics, both of which are
    // worth real army share only when there is slack to spend.
    if (a >= 2 && this.has('monastery')) add(0.1 * this.pri('monk'), 'monk');

    const sum = wants.reduce((t, w) => t + w.share, 0) || 1;
    for (const w of wants) w.share /= sum;
    return wants;
  }

  manageArmy() {
    const g = this.game;
    const comp = this.desiredComposition();
    if (!comp.length) return;
    // Keep the Dark Age to a token defensive force - real openings do not mass
    // Militia - and otherwise let the army grow until the population cap.
    const armyCap = this.p.ageIndex === 0 ? 4 : Infinity;
    const holdProduction = this.mine.army.length >= armyCap;

    // Units are bought out of whatever sits above the reserve, so the army keeps
    // growing through an age-up save instead of freezing. Below a minimum
    // defensive force the reserve is ignored outright: banking 800 food behind
    // an army of three loses the town long before the bank is ever spent.
    //
    // How big that minimum is now comes from the military priority rather than a
    // fixed table, so it answers the actual situation: a quiet map wants a token
    // guard, an enemy massing across the river wants a real one.
    const mil = this.pri('military');
    const byAge = this.share([0.02, 0.04, 0.07, 0.09][this.p.ageIndex], 3);
    const minArmy = Math.round(byAge * (0.5 + mil));
    // The bypass stops once the age bank is over half full. Without that stop it
    // is permanent whenever the army is being ground down in a war - the AI is
    // always "below its minimum", always ignores the reserve, and never advances
    // an age again.
    const ageProgress = (this.savingForAge && this.reserve && this.reserve.food)
      ? this.p.res.food / this.reserve.food : 0;
    // And it stops once the save has simply been going on too long. An AI that
    // is being attacked is permanently below its minimum army, so the bypass
    // never expires on its own: traced games spent forty-five minutes in the
    // Feudal Age, replacing losses out of the age fund one soldier at a time,
    // against an opponent in the Imperial Age. Being an age behind loses far
    // more slowly and far more certainly than being four soldiers short.
    const stalled = this.ageSaveElapsed() > AI.AGE_SAVE_GRACE;
    const belowMinimum = this.mine.army.length < minArmy && ageProgress < 0.6 && !stalled;
    const affordableNow = (id) => this.canSpend(this.p.mods.unit(id).cost, belowMinimum);

    const producers = holdProduction ? [] : this.mine.buildings.filter((b) =>
      b.complete && b.def.trains.length && b.type !== 'townCenter' && b.type !== 'dock' && b.type !== 'market');

    // What we already have, so each building can be handed whichever wanted unit
    // the army is furthest short of rather than the next one in a list.
    const have = {};
    for (const u of this.mine.army) have[u.type] = (have[u.type] || 0) + 1;
    for (const b of this.mine.buildings) {
      for (const q of b.queue) if (q.kind === 'unit') have[q.id] = (have[q.id] || 0) + 1;
    }
    const armyTotal = Math.max(1, this.mine.army.length);
    const deficit = (id) => {
      const want = comp.find((w) => w.id === id);
      return want ? want.share - (have[id] || 0) / armyTotal : -1;
    };

    // Queue depth follows the military priority and the float together: a
    // shallow queue means the building idles between passes and the bank keeps
    // growing, and near the population cap the aim is to be at the cap when we
    // attack.
    const r = this.p.res;
    const rich = r.food > 700 && r.gold > 500;
    const deep = Math.max(2, Math.round((rich ? 7 : 3) * (0.6 + mil * 0.8)));
    for (const b of producers) {
      if (b.queue.length >= deep) continue;
      const options = comp
        .filter((w) => g.canTrainAt(b, w.id))
        .filter((w) => affordableNow(w.id))
        // A building that is already over its share of the army produces
        // nothing. Without this a Siege Workshop can only ever train siege, so
        // it kept queueing rams no matter how many we had.
        .filter((w) => deficit(w.id) > -0.03)
        .sort((x, y) => deficit(y.id) - deficit(x.id));
      for (const w of options) {
        if (g.queueUnit(b, w.id)) { have[w.id] = (have[w.id] || 0) + 1; break; }
      }
    }

    this.manageWaves();
    this.manageRaid();

    // monks pick up relics
    const monks = this.mine.army.filter((u) => u.def.converts && u.task.type === 'idle');
    for (const m of monks) {
      const relic = g.entityGrid.nearest(m.x, m.y, 40, (e) => e.kind === 'resource' && e.type === 'relic');
      if (relic) g.commandRelic([m], relic);
    }
  }

  /**
   * Attack waves.
   *
   * The commitment threshold is the aggression priority rather than a fixed
   * count, so the AI attacks when it is actually ahead instead of when it hits
   * eighteen units - which is the difference between a push and a donation. In a
   * team the decision belongs to the TeamBrain: allies attack the same player at
   * the same time, staging together first, because two armies arriving five
   * minutes apart lose to a defender who beats each of them in turn.
   */
  manageWaves() {
    const g = this.game;
    this.attackTimer -= 1;
    const aggression = this.pri('aggression');
    // The raid squad is not part of the main wave; it has its own job.
    const raiders = this.raiderIds();
    const ready = this.mine.army.filter((u) =>
      u.def.cat !== 'monk' && !raiders.has(u.id));

    // Wave size shrinks as the AI gets more confident and grows when it is not,
    // but only within a band. Scaling it by the full range of the priority let
    // a confident AI commit with fourteen units against an opponent fielding
    // the same, lose them, rebuild, and do it again - it out-killed the
    // opponent and still lost every game, because feeding an army in halves is
    // the most expensive way to fight. The floor here is roughly the old fixed
    // wave; confidence buys a smaller discount than it used to.
    const waveSize = Math.max(this.share(0.04, 6), Math.round(
      (this.armySize + this.p.ageIndex * this.share(0.03, 2)) * (1.45 - aggression * 0.75)));
    // At the population limit the army cannot grow, so sitting on it is pure
    // waste - every second banked is a second it is not trading.
    const popFull = this.p.pop >= this.p.effectivePopCap - this.share(0.03, 4);
    const teamPush = this.team.pushIntent > 0.7 && this.team.members.length > 1;

    if (!this.attacking) {
      const rump = this.share(0.04, 5);
      const enough = ready.length >= waveSize || (popFull && ready.length >= rump) ||
        (teamPush && ready.length >= rump);
      if (enough && this.attackTimer <= 0 && (aggression > 0.35 || popFull || teamPush)) {
        // A team push stages short of their town so the allied armies arrive
        // together; a solo attack goes straight in.
        const rally = teamPush ? this.team.rally : null;
        const target = this.pickAttackTarget(ready);
        if (rally) {
          this.attacking = true;
          g.commandAttackMove(ready, rally.x, rally.y);
          this.attackTimer = 45;
        } else if (target) {
          this.attacking = true;
          g.commandAttackMove(ready, target.x, target.y);
          this.attackTimer = 60;
        }
      }
      return;
    }

    // Committed. Break off if the wave has been ground down, unless there is
    // nothing left to go home to build with.
    if (ready.length < waveSize * 0.35 && !popFull && !teamPush) {
      this.attacking = false;
      g.commandMove(ready, this.homeX + 3, this.homeY + 3);
      this.attackTimer = 45;
      return;
    }
    // Reinforce: anything idle at home joins the fight instead of standing in
    // the base while the wave it belongs to fights short-handed.
    const idleFighters = ready.filter((u) => u.task.type === 'idle');
    if (!idleFighters.length) return;
    const target = this.pickAttackTarget(ready);
    if (target) g.commandAttackMove(idleFighters, target.x, target.y);
    else if (idleFighters.length > ready.length * 0.6) this.attacking = false;
  }

  /**
   * A small squad of fast units sent at their economy rather than their army.
   *
   * Raiding is the cheapest damage in the game: five Hussars in a woodline cost
   * an opponent more than they cost us, and they pull defenders off the front.
   * It needs its own squad because the main army must not be diverted - an
   * attack that turns into a raid halfway through achieves neither.
   */
  /** Every unit currently out on a raid, as a set of ids. */
  raiderIds() {
    const ids = new Set();
    for (const party of this.squads.raids) for (const id of party.ids) ids.add(id);
    return ids;
  }

  /**
   * Raiding parties - plural.
   *
   * One squad walking to one place is not a raid, it is a small attack that the
   * defender meets in one spot. Several small groups hitting farms, woodcutters
   * and mining camps in different corners at the same time cannot be answered
   * at all: whichever one the defender chases, the other two keep killing
   * villagers, and the whole army has to come home to deal with it.
   *
   * The parties are deliberately small and fast. A raid works because it arrives
   * before the defence does.
   */
  manageRaid() {
    const g = this.game;
    // Prune the dead, and disband anything too small to survive the trip.
    for (const party of this.squads.raids) {
      party.ids = party.ids.filter((id) => {
        const u = g.get(id);
        return u && u.alive && u.owner === this.index;
      });
    }
    this.squads.raids = this.squads.raids.filter((p) => p.ids.length >= 2);

    const want = this.pri('raid');
    const partySize = Math.max(3, Math.round(this.share(0.025, 3)));
    // Never at the cost of home defence, and never before there is a real army:
    // peeling five units off an army of eight is just losing five units.
    const spare = this.mine.army.length - this.share(0.07, 8);
    const wantParties = (want > 0.5 && !this.underThreat && spare > 0)
      ? Math.min(3, Math.floor(spare / partySize)) : 0;

    if (this.squads.raids.length > wantParties) {
      // Standing down: they rejoin the main army by simply being released.
      this.squads.raids.length = wantParties;
    }
    if (!wantParties) return;

    // Fill out the roster. Fast melee only - Halberdiers walking across the map
    // are a slow gift.
    if (this.squads.raids.length < wantParties) {
      const taken = this.raiderIds();
      const pool = this.mine.army
        .filter((u) => !taken.has(u.id) && u.def.speed >= 1.15 &&
          u.def.cat !== 'siege' && u.def.cat !== 'monk')
        .sort((a, b) => b.def.speed - a.def.speed);
      while (this.squads.raids.length < wantParties && pool.length >= partySize) {
        this.squads.raids.push({ ids: pool.splice(0, partySize).map((u) => u.id), targetId: 0 });
      }
    }
    if (!this.squads.raids.length) return;

    // One target each, all different, so the parties genuinely spread out.
    const claimed = [];
    for (const party of this.squads.raids) {
      const squad = party.ids.map((id) => g.get(id)).filter(Boolean);
      if (!squad.length) continue;
      const held = g.get(party.targetId);
      // Keep going while the target lives and the party still has work to do -
      // re-issuing an order every second means they never actually arrive.
      if (held && held.alive && squad.some((u) => u.task.type !== 'idle')) {
        claimed.push(held);
        continue;
      }
      const target = this.pickRaidTarget(squad, claimed);
      if (!target) continue;
      claimed.push(target);
      party.targetId = target.id;
      g.commandAttackMove(squad, target.x, target.y);
    }
  }

  /**
   * Where one raiding party goes: undefended economy, away from their army and
   * away from wherever the other parties are already headed.
   */
  pickRaidTarget(squad, claimed) {
    const g = this.game;
    const from = this.armyCentre(squad);
    const candidates = [];

    // Villagers and trade carts in the open are the point of the exercise.
    for (const u of this.enemyUnits) {
      if (u.def.cat !== 'villager' && u.def.cat !== 'trade') continue;
      candidates.push(u);
    }
    // Failing that, the buildings that stand where villagers work: farms, camps,
    // mills, markets. Their Town Center is not a raid target - it shoots back.
    for (const b of this.rivalTowns) {
      if (b.type === 'farm' || b.type === 'market' || b.def.dropSite) candidates.push(b);
    }
    if (!candidates.length) return null;

    let best = null, bestScore = -Infinity;
    for (const e of candidates) {
      // Anything their soldiers are standing on is not a raid, it is a battle.
      let guarded = 0;
      for (const s of this.enemyUnits) {
        if (s.def.cat === 'villager' || s.def.cat === 'trade') continue;
        if (Math.hypot(s.x - e.x, s.y - e.y) < 12) guarded++;
      }
      let score = 25 - guarded * 8 - this.enemyCoverAt(e.x, e.y) * 12;
      score -= Math.hypot(e.x - from.x, e.y - from.y) * 0.12;
      // Spread: give way to whatever another party has already claimed.
      for (const c of claimed) {
        const d = Math.hypot(c.x - e.x, c.y - e.y);
        if (d < 25) score -= (25 - d) * 1.2;
      }
      // A little noise so successive raids do not all grind the same corner.
      score += g.rng.range(0, 6);
      if (score > bestScore) { bestScore = score; best = e; }
    }
    return best;
  }

  /**
   * Sends the opening scout out to find the enemy.
   *
   * An AI that never looks never learns anything, so it opens generically and is
   * still building the wrong units when the first attack lands. How much
   * unit-time this is worth is the scout priority: high while the map is dark
   * and we are safe, near zero once we know where they live.
   */
  manageScouting() {
    if (this.pri('scout') < 0.3) return;
    const scout = this.mine.army.find((u) =>
      u.task.type === 'idle' && u.def.cat === 'cavalry' && !u.def.range &&
      !this.raiderIds().has(u.id));
    if (!scout) return;

    const g = this.game;
    // The golden angle spreads successive picks around the map instead of
    // sweeping one edge, so the enemy is found in far fewer trips.
    for (let i = 0; i < 32; i++) {
      this.scoutStep = (this.scoutStep || 0) + 1;
      const a = this.scoutStep * 2.39996;
      const r = 16 + (this.scoutStep % 6) * 11;
      const x = Math.max(2, Math.min(g.size - 3, this.homeX + Math.cos(a) * r));
      const y = Math.max(2, Math.min(g.size - 3, this.homeY + Math.sin(a) * r));
      if (this.p.hasExplored(x | 0, y | 0)) continue;
      if (!g.grid.isPassable(x | 0, y | 0, 'land')) continue;
      g.commandMove([scout], x, y, false);
      return;
    }
  }

  /**
   * Where to send the next wave. Prefers what actually costs the enemy the game
   * - their villagers and the buildings that make more of them - over whatever
   * happens to be nearest, which was usually an outlying House.
   *
   * In a team the target is filtered to the player the team has agreed to focus,
   * so two allies do not spend the game attacking opposite corners of the map.
   */
  /**
   * How heavily enemy fire covers a point, ignoring one building.
   *
   * A Castle is worth three towers here because that is roughly what walking
   * under one costs. `except` exists so a defence does not count its own fire
   * against itself - we have to stand in front of it to kill it.
   */
  enemyCoverAt(x, y, except) {
    let cover = 0;
    for (const b of this.rivalTowns) {
      if (b === except) continue;
      const range = b.def.range || 0;
      if (!range) continue;
      if (Math.hypot(b.x - x, b.y - y) <= range + 1.5) {
        cover += b.type === 'castle' ? 3 : b.type === 'townCenter' ? 1 : 2;
      }
    }
    return cover;
  }

  /** Where the committed army actually is, which is what it attacks outward from. */
  armyCentre(units) {
    const pool = units && units.length ? units : this.mine.army;
    if (!pool.length) return { x: this.homeX, y: this.homeY };
    let x = 0, y = 0;
    for (const u of pool) { x += u.x; y += u.y; }
    return { x: x / pool.length, y: y / pool.length };
  }

  /**
   * What the wave should hit next.
   *
   * Measured from where the army is standing, not from our own town, and it
   * works inward rather than diving for the Town Center.
   *
   * The old rule gave the enemy Town Center a flat 45-point head start and
   * measured everything from home, so a wave would march past two Castles to
   * reach the middle of the base and feed itself into them one unit at a time.
   * Now anything sitting under enemy fire is penalised by how much fire covers
   * it, and a defence that is *currently shooting our army* is the most
   * attractive target on the map - kill what is killing you, then the next
   * thing in, and the Town Center becomes reachable once its cover is gone.
   */
  pickAttackTarget(units) {
    const g = this.game;
    const focus = this.team.members.length > 1 && this.team.focus
      ? this.team.focus.player.index : null;
    const relevant = (owner) => focus === null || owner === focus;
    const at = this.armyCentre(units);

    // A cluster of enemy villagers in the open is the best thing an army finds.
    let vills = null, villScore = Infinity;
    for (const u of this.enemyUnits) {
      if (u.def.cat !== 'villager') continue;
      if (!relevant(u.owner)) continue;
      const d = Math.hypot(u.x - at.x, u.y - at.y) + this.enemyCoverAt(u.x, u.y) * 30;
      if (d < villScore) { villScore = d; vills = u; }
    }

    let best = null, bestScore = Infinity;
    for (const e of g.entities) {
      if (!e.alive || !g.isEnemy(this.index, e.owner)) continue;
      if (e.kind !== 'building') continue;
      if (!relevant(e.owner)) continue;
      const d = Math.hypot(e.x - at.x, e.y - at.y);
      let score = d;
      // Everything standing under their guns costs extra to go and hit.
      score += this.enemyCoverAt(e.x, e.y, e) * 30;

      const range = e.def.range || 0;
      if (range > 0) {
        // A defence. If it can already reach our army it is the thing doing the
        // damage, and nothing else is worth attacking while it stands.
        const shootingUs = d <= range + 5;
        score -= shootingUs ? 70 : 25;
      } else if (e.def.cat === 'military') score -= 15;   // production, not defence
      else if (e.def.dropSite || e.type === 'farm') score -= 10;
      else if (e.type === 'house') score += 25;           // never worth a wave

      if (score < bestScore) { bestScore = score; best = e; }
    }
    // Villagers win unless a real target is much closer to the army than they are.
    if (vills && (!best || villScore < bestScore + 20)) return vills;
    if (best) return best;
    // Nothing of the focused player is visible - fall back to the team's agreed
    // town, then to anything at all.
    const agreed = this.team.focusTarget();
    if (agreed) return agreed;
    for (const u of this.enemyUnits) return u;
    return null;
  }

  /**
   * Home defence, plus answering an ally's call.
   *
   * The defence priority decides how much of the army comes home: an AI that is
   * winning everywhere else leaves a token guard and keeps pushing, one that is
   * being dismantled recalls everything.
   */
  manageDefense() {
    const g = this.game;
    // Soldiers only. Counting enemy villagers here was quietly catastrophic:
    // one enemy villager wandering past - a forward builder, a lost gatherer -
    // kept the town permanently "under attack", so the release branch below
    // never ran and fifteen of our own villagers sat garrisoned in the Town
    // Center for the rest of the game. Garrisoned units silently ignore every
    // command, so the AI kept re-tasking them and believing it had.
    const threats = this.enemyUnits.filter((e) =>
      e.def.cat !== 'villager' && e.def.cat !== 'trade' &&
      Math.hypot(e.x - this.homeX, e.y - this.homeY) < 22);

    if (!threats.length) {
      // Let the villagers back out once the raid is over. Nothing else does
      // this, so before now every raid permanently retired up to eight villagers
      // into the Town Center for the rest of the game.
      for (const b of this.mine.buildings) {
        if (!b.complete || !b.garrison.length) continue;
        const hasVills = b.garrison.some((id) => {
          const u = g.get(id);
          return u && u.def.cat === 'villager';
        });
        if (hasVills) g.ungarrisonAll(b);
      }
      this.supportAlly();
      return;
    }

    // Who comes home. When the priority is high everything does; when it is low
    // only what is already nearby, so a winning push is not called off by two
    // scouts poking the town.
    const defend = this.pri('defense');
    const radius = 26 + defend * 90;
    const defenders = this.mine.army.filter((u) =>
      !this.attacking || Math.hypot(u.x - this.homeX, u.y - this.homeY) < radius);
    // Shoot the thing that is hurting us most, not merely the first one in the
    // list: siege flattening a Town Center outranks a scout in the woodline.
    const priority = threats.slice().sort((a, b) =>
      this.threatWeight(b) - this.threatWeight(a))[0];
    if (defenders.length) g.commandAttack(defenders, priority);

    // Villagers under fire garrison the Town Center.
    const scared = this.mine.villagers.filter((v) =>
      Math.hypot(v.x - priority.x, v.y - priority.y) < 7);
    if (scared.length && this.tc && this.tc.garrison.length < this.tc.def.garrison) {
      g.commandGarrison(scared.slice(0, 8), this.tc);
    }
  }

  /** How badly a particular attacker needs killing first. */
  threatWeight(u) {
    const c = u.def.cat;
    if (c === 'siege') return 5;                  // it is knocking the town down
    if (u.def.converts) return 4;                 // it is stealing the army
    if (u.def.range) return 2.5;                  // it outranges the villagers
    if (c === 'villager') return 0.5;             // a forward builder, not a threat
    return 2;
  }

  /**
   * Sends part of the army to an ally who is being attacked.
   *
   * Only the nearest healthy ally answers - three allies all abandoning their
   * own towns for one raid loses three towns instead of none - and only a share
   * of the army goes, so answering a call does not uncover us.
   */
  supportAlly() {
    if (this.team.members.length < 2) return;
    const spot = this.team.helpRequestFor(this);
    if (!spot) return;
    const g = this.game;
    const raiders = this.raiderIds();
    const available = this.mine.army.filter((u) =>
      !raiders.has(u.id) && u.def.cat !== 'monk' && u.def.cat !== 'siege');
    if (available.length < this.share(0.03, 5)) return;
    const send = available
      .sort((a, b) => Math.hypot(a.x - spot.x, a.y - spot.y) - Math.hypot(b.x - spot.x, b.y - spot.y))
      .slice(0, Math.max(4, Math.round(available.length * 0.5)));
    // Only re-issue when they are not already on their way; otherwise the order
    // is reset every pass and they never arrive.
    if (send.every((u) => u.task.type !== 'idle')) return;
    g.commandAttackMove(send, spot.x, spot.y);
  }

  /* ================================================================
   *  Research
   * ================================================================ */

  manageResearch() {
    // Research several per pass. One-at-a-time meant a Blacksmith, University
    // and Mill could each be free and only one of them would ever be used.
    let started = 0;
    // Genuinely out of room to grow - at the game's population limit, not merely
    // short of Houses. Treating a temporary housing block as "nothing else to
    // spend on" pulled Hand Cart forward to 51 villagers.
    const popCapped = this.p.pop >= this.p.effectivePopCap - this.share(0.015, 3) &&
      this.p.effectivePopCap >= this.p.popMax - this.share(0.025, 5);
    const tech = this.pri('tech');
    // How many things to start at once follows the tech priority, so an AI
    // floating resources at the cap sweeps everything and one scraping by for
    // its next age does not spend the food on Bodkin Arrow.
    const limit = popCapped ? 99 : Math.max(1, Math.round((this.p.ageIndex >= 2 ? 4 : 2) * (0.4 + tech)));
    // The food buffer protects villager production, but it has to shrink once
    // the economy is big - at 90 villagers, 150 food is a couple of seconds.
    const buffer = popCapped ? 0
      : this.mine.villagers.length >= villagerTarget(this.p.popMax, this.p.age) * 0.6 ? 40 : 150;

    const tryList = (ids, budget, ignoreReserve) => {
      let used = 0;
      for (const id of ids) {
        if (started >= limit || used >= budget) return;
        if (!TECHS[id] || !this.p.isTechAvailable(id)) continue;
        // Some economy techs are worth buying only once the economy is big
        // enough to earn the cost back.
        if (!popCapped && ECO_TECH_GATE[id] && !ECO_TECH_GATE[id](this)) continue;
        const cost = this.p.mods.techCost(TECHS[id]);
        if (!this.canSpend(cost, ignoreReserve)) continue;
        if (cost.food > 0 && this.p.res.food < cost.food + buffer) continue;
        // Queue behind units, but never behind another tech - two techs in one
        // building just serialise. Requiring a completely empty queue quietly
        // excluded everything researched at the Town Center.
        const b = this.buildingsOf(TECHS[id].building)
          .filter((x) => !x.queue.some((q) => q.kind === 'tech'))
          .sort((x, y) => x.queue.length - y.queue.length)[0];
        if (b && this.game.queueTech(b, id)) { started++; used++; }
      }
    };

    // An economy tech whose moment has arrived is bought now, ahead of
    // everything and out of the reserve if need be. They are one-off purchases
    // with a right time, and left in the general queue behind a food reserve
    // they slipped to 135 villagers - long past the point of paying for
    // themselves.
    const due = Object.keys(ECO_TECH_GATE).filter((id) => ECO_TECH_GATE[id](this));
    tryList(due, due.length, true);

    // Trade techs only once the AI has actually decided to trade - Caravan is
    // 200 food and 200 gold that does nothing at all without carts on the road,
    // and Coinage onward is what makes a team's tributes affordable.
    if (this.pri('trade') > 0.45 && this.has('market')) tryList(TRADE_TECHS, 2, false);
    // Likewise the stone-defence line: worth real resources when turtling,
    // worth nothing when the plan is to be in their base.
    if (this.pri('fortify') > 0.55) tryList(DEFENCE_TECHS, 2, false);

    // Unit-line upgrades get a guaranteed share of every pass. They used to be
    // tried only after all thirty-odd generic techs, which was survivable when
    // reaching Imperial handed you Champions and Paladins outright; now that a
    // line has to be walked up one tier at a time, an AI that never gets round
    // to it fights the whole game with Militia. They may dip into the age
    // reserve - each is bought exactly once, so unlike unit production this
    // cannot run away.
    // ...but not out of the last stretch of an age fund. Feudal unit upgrades
    // cost a hundred food each, which is an eighth of the Castle Age, and an AI
    // that never advances loses to one that does however well upgraded its
    // Militia are. Only the closing stretch is protected, because blocking them
    // for the whole save costs most of the upgrade line.
    const fundFull = this.savingForAge && this.reserve && this.reserve.food
      ? this.p.res.food / this.reserve.food : 0;
    tryList(this.unitUpgradeTechs(), popCapped ? limit : Math.max(1, Math.ceil(limit / 2)),
      !this.savingForAge || fundFull < 0.7);
    tryList(TECH_PRIORITY, limit, popCapped);
    // Everything else the civ has - unique techs, university and monastery work.
    // Only worth sweeping when the army cannot grow any further, which is
    // exactly when the bank would otherwise just sit there.
    if (popCapped) tryList(this.remainingTechs(), limit, true);
  }

  /**
   * Every remaining researchable tech, cheapest first. Used only at the
   * population cap, where the priority list has usually been exhausted.
   */
  remainingTechs() {
    const out = [];
    for (const id in TECHS) {
      const t = TECHS[id];
      if (t.hidden) continue;
      if (t.effects.some((e) => e.k === 'age')) continue;   // manageAge owns those
      if (!this.p.isTechAvailable(id)) continue;
      if (!this.buildingsOf(t.building).length) continue;
      out.push(id);
    }
    const total = (id) => {
      const c = this.p.mods.techCost(TECHS[id]);
      return c.food + c.wood + c.gold + c.stone;
    };
    return out.sort((a, b) => total(a) - total(b));
  }

  /**
   * The upgrade techs that matter to this AI: the next step up for everything it
   * fields or intends to field, plus its Elite unique unit. Derived from the
   * units rather than hard-coded, so a civ that leans on Camels or Elephants
   * researches those instead of a fixed Militia-first list.
   */
  unitUpgradeTechs() {
    const ids = new Set();
    const walk = (unitId) => {
      let cur = unitId;
      for (let i = 0; i < 4 && cur; i++) {
        const next = this.p.mods.unit(cur)?.upgradeTo;
        if (!next) break;
        const tech = upgradeTechFor(next);
        if (tech) ids.add(tech);
        cur = next;
      }
    };
    for (const u of this.mine.army) walk(u.type);
    for (const w of this.desiredComposition()) walk(w.id);
    if (this.has('castle')) ids.add('elite_' + this.p.civId);
    return [...ids];
  }

  /* ================================================================
   *  Placement
   * ================================================================ */

  tryBuild(bId) {
    // The search radius has to grow with the town. A fixed 14 tiles is full long
    // before a 70-building Imperial base is finished, and once nothing fits,
    // Houses stop going up and the population cap - not the economy - decides
    // how big the army gets.
    const reach = Math.min(34, 14 + this.mine.buildings.length * 0.25);
    return this.tryBuildAt(bId, this.homeX, this.homeY, 3, reach);
  }

  tryBuildAt(bId, cx, cy, minR, maxR) {
    const g = this.game;
    if (!this.p.isBuildingAvailable(bId)) return false;
    const def = this.p.mods.building(bId);
    // The reserve never blocks the thing it is saving for, nor a House when we
    // are about to hit the population cap - pop-blocking the economy to save for
    // a Town Center would defeat the point of the Town Center.
    const urgent = bId === 'townCenter' ||
      (bId === 'castle' && (this.underThreat || this.wantEmergencyCastle)) ||
      (bId === 'house' && this.p.effectivePopCap - this.p.pop < 4);
    if (!this.canSpend(def.cost, urgent)) return false;
    const spot = this.findSpot(bId, cx, cy, minR, maxR);
    return this.commitBuild(bId, spot);
  }

  /** Lays a foundation on an already-chosen spot and staffs it. */
  commitBuild(bId, spot) {
    if (!spot) return false;
    const crew = (bId === 'castle' || bId === 'townCenter') ? 4 : 2;
    const builders = this.pickBuilders(spot.x, spot.y, crew);
    if (!builders.length) return false;
    return !!this.game.commandBuild(builders, bId, spot.x, spot.y);
  }

  /**
   * Another Mill, but only once the ones we already have are being farmed.
   *
   * Siting a Mill on "where a block of plots would fit" was tried and measured
   * worse than the ordinary placement: villagers lay their farms beside
   * whichever food drop-off is nearest to *them*, so a carefully sited Mill out
   * on open ground simply never gets used - 37% of them finished the game with
   * no farm at all against 13% before, and the farm count fell with it.
   *
   * What actually causes the clutter is building the next Mill before the last
   * one has any farms. They pile up around the town at 100 wood each, serving
   * nothing. So the gate is saturation, not position.
   */
  buildMill() {
    const mills = this.buildingsOf('mill');
    if (mills.length) {
      const farms = this.mine.buildings.filter((b) => b.type === 'farm');
      let served = 0;
      for (const m of mills) {
        if (farms.some((f) => Math.hypot(f.x - m.x, f.y - m.y) < 9)) served++;
      }
      if (served < mills.length * 0.75) return false;
    }
    return this.tryBuild('mill');
  }

  /**
   * The best tile for a drop-off serving a particular set of resource nodes.
   *
   * Deliberately an exhaustive local scan rather than the random ring sampling
   * `findSpot` does. A Lumber Camp's entire job is to be close to the trees, and
   * a random tile "somewhere within four of the middle of the woodline" is not
   * that: it lands on the far side as often as the near one, the crew keeps
   * walking, and next pass the AI decides it needs *another* camp. That loop is
   * what produced clumps of six Mining Camps in a row, none of them on the mine.
   *
   * @param nodes the nodes this drop-off is meant to serve
   * @param radius how far from their centre to look
   * @returns {{x,y,cost}|null} cost is the mean carry distance it would give
   */
  findDropSpot(bId, nodes, radius = 7) {
    const g = this.game;
    const def = this.p.mods.building(bId);
    const size = def.size;
    if (!nodes.length) return null;
    // A sample is enough to site a building and keeps this cheap when a woodline
    // is three hundred trees.
    const sample = nodes.length > 24 ? nodes.filter((_, i) => i % Math.ceil(nodes.length / 24) === 0) : nodes;

    let cx = 0, cy = 0;
    for (const n of sample) { cx += n.x; cy += n.y; }
    cx /= sample.length; cy /= sample.length;

    let best = null, bestCost = Infinity;
    const r = Math.ceil(radius);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        const tx = Math.round(cx + dx - size / 2);
        const ty = Math.round(cy + dy - size / 2);
        if (!g.canPlaceBuilding(bId, this.index, tx, ty)) continue;
        if (!this.hasRoom(tx, ty, size)) continue;
        // Villagers walk to the building, not to its corner.
        const bx = tx + size / 2, by = ty + size / 2;
        let cost = 0;
        for (const n of sample) cost += Math.hypot(n.x - bx, n.y - by);
        cost /= sample.length;
        if (cost < bestCost) { bestCost = cost; best = { x: tx, y: ty, cost }; }
      }
    }
    return best;
  }

  findSpot(bId, cx, cy, minR, maxR) {
    const g = this.game;
    const def = this.p.mods.building(bId);
    const size = def.size;
    for (let attempt = 0; attempt < 90; attempt++) {
      const a = g.rng.range(0, Math.PI * 2);
      const r = g.rng.range(minR, maxR);
      const tx = Math.round(cx + Math.cos(a) * r - size / 2);
      const ty = Math.round(cy + Math.sin(a) * r - size / 2);
      if (g.canPlaceBuilding(bId, this.index, tx, ty)) {
        // leave a walkable gap so the base does not seal itself in
        if (this.hasRoom(tx, ty, size)) return { x: tx, y: ty };
      }
    }
    return null;
  }

  hasRoom(tx, ty, size) {
    const g = this.game;
    let open = 0;
    for (let x = tx - 1; x <= tx + size; x++) {
      for (let y = ty - 1; y <= ty + size; y++) {
        if (x >= tx && x < tx + size && y >= ty && y < ty + size) continue;
        if (g.grid.isPassable(x, y, 'land')) open++;
      }
    }
    return open >= (size + 2) * 2;
  }

  pickBuilders(tx, ty, n) {
    const pool = this.mine.villagers.filter((v) =>
      v.task.type === 'idle' || v.task.type === 'gather' || v.task.type === 'deliver');
    // Idle villagers are free labour; pulling a gatherer off a node costs the
    // walk back as well as the build time, so only do it if nobody is spare.
    const cost = (v) => Math.hypot(v.x - tx, v.y - ty) + (v.task.type === 'idle' ? 0 : 25);
    pool.sort((a, b) => cost(a) - cost(b));
    const picked = pool.slice(0, n);
    // Don't strip the economy bare for a house.
    return picked.length && this.mine.villagers.length < 6 ? picked.slice(0, 1) : picked;
  }
}
