// Computer opponent: a build-order driven economy plus a counter-aware army
// composition. It reads the same public command API the human UI uses.

import { TECHS, upgradeTechFor } from '../data/techs.js';
import { AGES } from './player.js';

const VILL_TARGET = { dark: 24, feudal: 50, castle: 90, imperial: 130 };
const RES_SPLIT = {
  dark: { food: 0.55, wood: 0.35, gold: 0.10, stone: 0.0 },
  feudal: { food: 0.42, wood: 0.34, gold: 0.18, stone: 0.06 },
  castle: { food: 0.36, wood: 0.30, gold: 0.24, stone: 0.10 },
  imperial: { food: 0.34, wood: 0.26, gold: 0.30, stone: 0.10 },
};

/**
 * Villager count at which the AI is willing to age up - and, identically, the
 * count at which it starts banking food instead of making more villagers.
 * These two must use the same number: if the saving gate trips before the
 * age-up gate, the AI stops producing villagers while still refusing to age,
 * and sits in the Dark Age forever.
 *
 * This is deliberately NOT a fraction of VILL_TARGET any more. The targets now
 * run to 130 villagers, and gating Imperial on 70% of 90 would mean the AI
 * spends the whole Castle Age refusing to advance while it grinds out
 * villagers. The age-up gate is a flat, much smaller number: get to the next
 * age quickly, keep making villagers the whole way there.
 */
const AGE_GATE = { dark: 17, feudal: 30, castle: 48, imperial: Infinity };
const ageGate = (age) => Math.min(VILL_TARGET[age], AGE_GATE[age] ?? 0);

/**
 * How many villagers can usefully share one resource node. Trees hold 100 wood
 * and are one tile each, so stacking villagers on one just makes them queue;
 * mines and bushes are worth crowding. Without this the "nearest node" rule
 * piles the whole economy onto whatever happens to be closest to the Town
 * Center and the rest of the map goes untouched.
 */
const NODE_CAP = { tree: 1, berries: 4, gold: 5, stone: 4, carcass: 4 };
const nodeCap = (e) => (e.kind === 'unit' ? 4 : NODE_CAP[e.type] ?? 3);

/**
 * What beats what, as ordered preferences. The first entry the civ can build
 * wins, so a civ without Pikemen answers Knights with Camels instead.
 * `weight` is how much of the army one unit of that threat is worth countering.
 */
const COUNTERS = {
  cavalry:       [['halberdier', 'pikeman', 'spearman'], ['heavyCamelRider', 'camelRider', 'kamayuk']],
  camel:         [['halberdier', 'pikeman', 'spearman'], ['champion', 'twoHandedSwordsman', 'longSwordsman']],
  elephant:      [['halberdier', 'pikeman', 'spearman'], ['monk'], ['arbalester', 'crossbowman']],
  // Skirmishers eat anything that shoots arrows, mounted or not; cavalry is how
  // you close the gap on a Cavalry Archer that will not stand still.
  archer:        [['eliteSkirmisher', 'skirmisher'], ['paladin', 'cavalier', 'knight', 'eliteEagleWarrior', 'eagleWarrior']],
  cavalryArcher: [['eliteSkirmisher', 'skirmisher'], ['paladin', 'cavalier', 'knight', 'heavyCamelRider', 'camelRider']],
  infantry:      [['arbalester', 'crossbowman', 'archer'], ['paladin', 'cavalier', 'knight']],
  siege:         [['hussar', 'lightCavalry', 'scoutCavalry'], ['paladin', 'cavalier', 'knight', 'eliteEagleWarrior', 'eagleWarrior']],
  monk:          [['hussar', 'lightCavalry', 'scoutCavalry'], ['archer', 'crossbowman', 'arbalester']],
};

const TECH_PRIORITY = [
  'loom', 'doubleBitAxe', 'horseCollar', 'wheelbarrow', 'goldMining',
  'forging', 'scaleMailArmor', 'fletching', 'scaleBardingArmor', 'bloodlines',
  'bowSaw', 'heavyPlow', 'handCart', 'goldShaftMining', 'husbandry',
  'ironCasting', 'chainMailArmor', 'bodkinArrow', 'chainBardingArmor',
  'thumbRing', 'ballistics', 'masonry', 'squires', 'supplies',
  'twoManSaw', 'cropRotation', 'blastFurnace', 'plateMailArmor', 'bracer',
  'plateBardingArmor', 'siegeEngineers', 'chemistry', 'conscription', 'architecture',
];

export class AI {
  constructor(game, playerIndex, difficulty = 'moderate') {
    this.game = game;
    this.index = playerIndex;
    this.p = game.players[playerIndex];
    this.difficulty = difficulty;
    this.t = 0;
    this.attackTimer = 60;
    this.armySize = difficulty === 'hard' ? 14 : difficulty === 'easy' ? 24 : 18;
    this.enemyMemory = new Map();   // enemy unit id -> { cls, t } for what we have seen
    this.lastBuild = 0;
    this.attacking = false;
    this.targetIdx = null;
    this.homeX = 0; this.homeY = 0;
  }

  update(dt) {
    if (this.p.defeated || this.game.over) return;
    this.t += dt;
    if (this.t < 1.0) return;
    this.t = 0;

    this.cacheState();
    if (!this.tc) return;

    this.planReserve();
    this.manageEmergencyDefence();
    this.manageConstruction();
    this.manageHousing();
    this.manageVillagers();
    this.manageDropSites();
    this.manageEconomyBuildings();
    this.manageAge();
    this.manageMilitaryBuildings();
    this.manageArmy();
    this.manageScouting();
    this.manageResearch();
    this.manageDefense();
    this.manageMarket();
    this.spendSurplus();
  }

  /* ---------------- state ---------------- */

  cacheState() {
    const g = this.game;
    this.mine = { units: [], buildings: [], idle: [], villagers: [], army: [], byType: {} };
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
            if (e.task.type === 'idle') this.mine.idle.push(e);
            // Count who is already committed to each node so the next idle
            // villager is sent somewhere that is not already full.
            const t = e.task;
            if ((t.type === 'gather' || t.type === 'build') && t.targetId) {
              this.nodeLoad.set(t.targetId, (this.nodeLoad.get(t.targetId) || 0) + 1);
            }
          } else if (e.def.cat !== 'trade' && e.def.cat !== 'animal') {
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
      this.nodes[res].push(e);
    }
  }

  /**
   * Sets aside resources for the one expensive thing the AI most wants next.
   *
   * Income is spent the instant it arrives - a Farm here, a House there - so a
   * 275-wood Town Center is never affordable no matter how much wood the AI
   * earns in total. One game reached 85 villagers and 78 minutes still on its
   * starting Town Center, with wood pinned around 100 the entire time. The
   * reserve is what lets a big purchase actually happen.
   */
  planReserve() {
    this.reserve = null;
    this.savingForAge = false;
    const a = this.p.ageIndex;

    // Being attacked outranks even the age. A Castle is the difference between
    // losing the town and holding it, so the stone for one is set aside before
    // anything else can spend it.
    if (this.wantEmergencyCastle) {
      this.reserve = this.p.mods.building('castle').cost;
      return;
    }

    // The next age outranks everything else the AI could buy, so it is banked
    // for first. Crucially this is a *reserve*, not a freeze: the old code
    // stopped all military production until the bank was full, and because the
    // threshold sat just above where the economy hovered, one game spent 25
    // minutes "saving" with an army of zero.
    const nextAge = AGES[a + 1];
    const techId = nextAge ? nextAge + 'Age' : null;
    if (techId && TECHS[techId] && this.p.isTechAvailable(techId) &&
        this.mine.villagers.length >= ageGate(this.p.age)) {
      this.reserve = this.p.mods.techCost(TECHS[techId]);
      this.savingForAge = true;
      return;
    }

    const tcWant = a >= 3 ? 6 : a >= 2 ? 4 : 1;
    if (a >= 2 && this.count('townCenter') < tcWant && !this.underConstruction('townCenter')) {
      this.reserve = this.p.mods.building('townCenter').cost;
    }
  }

  /** canAfford, but honouring whatever planReserve is saving up for. */
  canSpend(cost, ignoreReserve) {
    if (!this.p.canAfford(cost)) return false;
    if (ignoreReserve || !this.reserve) return true;
    for (const k in cost) {
      // Costs carry explicit zeros for every resource, and comparing those
      // zeros against the reserve made the reserve block *everything*: while
      // banking 800 food the AI could not buy a 25-wood House, so it sat
      // population-capped at 56/60 with 13000 resources in the bank.
      if (!cost[k]) continue;
      if ((this.p.res[k] || 0) - (this.reserve[k] || 0) < cost[k]) return false;
    }
    return true;
  }

  /**
   * What kind of threat a unit represents, which is what decides the counter.
   * Deliberately finer than the unit's category: a Cavalry Archer is cavalry
   * and an archer at once, and the thing that beats it is a Skirmisher, not a
   * Pikeman.
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
   * Remembers enemy units we have actually laid eyes on, for a while after they
   * leave sight. Without a memory the AI would forget the Knights it just
   * fought the instant they walked back into the fog and stop building
   * Pikemen; with an unbounded memory it would counter an army the enemy
   * stopped making twenty minutes ago.
   */
  rememberEnemies() {
    if (!this.enemyMemory) this.enemyMemory = new Map();
    const now = this.game.time;
    for (const e of this.enemyUnits) {
      const cls = AI.threatClass(e.def);
      if (cls) this.enemyMemory.set(e.id, { cls, t: now });
    }
    // Anything killed or long out of sight stops shaping our build.
    for (const [id, m] of this.enemyMemory) {
      const u = this.game.get(id);
      if (!u || !u.alive || now - m.t > AI.MEMORY_SECONDS) this.enemyMemory.delete(id);
    }
  }

  /**
   * Are enemy soldiers near our town? Used to decide whether to drop everything
   * and put up a Castle, and it counts only what we can see - which for our own
   * base is everything, since our buildings and villagers give line of sight.
   */
  assessThreat() {
    let near = 0, closest = Infinity, tx = 0, ty = 0;
    for (const e of this.enemyUnits) {
      if (e.def.cat === 'villager' || e.def.cat === 'trade') continue;
      const d = Math.hypot(e.x - this.homeX, e.y - this.homeY);
      if (d > AI.THREAT_RADIUS) continue;
      near++;
      if (d < closest) { closest = d; tx = e.x; ty = e.y; }
    }
    const now = this.game.time;
    this.threatCount = near;
    if (near) this.lastThreatAt = { x: tx, y: ty };
    this.threatAt = this.lastThreatAt || null;

    // A raid deep in the town counts even if it is only a couple of riders -
    // but a single unit does not. Enemy scouts wander past every base in the
    // early game, and treating one as an attack put the AI on a war footing
    // over and over, which delayed every age-up by minutes.
    const raided = near >= 3 || (near >= 2 && closest < 20);
    // "They are here right now" latches briefly - an attack that pulls back for
    // half a minute is still an attack.
    if (raided) this.threatUntil = now + 120;
    this.underThreat = now < (this.threatUntil || 0);

    // "We have decided we need a Castle" latches for much longer, and this is
    // the one that drives the stone. 650 stone takes several minutes to mine;
    // with both states sharing a two-minute timer the AI kept starting to save
    // for a Castle, forgetting, and reverting - so it never built one at all.
    if (raided) this.castleUrgentUntil = now + 480;
    this.wantEmergencyCastle = this.p.ageIndex >= 2 &&
      now < (this.castleUrgentUntil || 0) &&
      !this.has('castle') && !this.underConstruction('castle') &&
      this.p.isBuildingAvailable('castle');
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

  /* ---------------- economy ---------------- */

  /**
   * Makes sure every foundation actually has someone building it.
   *
   * A builder can be pulled off a foundation at any time - reassigned to
   * gather, drafted onto another site, killed - and nothing put anyone back.
   * The abandoned foundation then counted as "housing already on the way"
   * forever, so manageHousing never ordered another one: one game sat at 10/10
   * population for forty minutes with two orphaned House foundations and 3900
   * resources in the bank.
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
    // Housing scales with how fast we are actually spending pop - one house per
    // producing building in flight - rather than with the size of the base.
    // Tying it to total buildings instead had the AI holding 30 spare pop in
    // the late game, which is 6 Houses' worth of wood it needed for Town
    // Centers it could then never afford.
    // Headroom has to cover everything that can pop at once. At 130 villagers
    // plus an army the AI needs roughly forty Houses, and a cap of 20 spare pop
    // meant the population limit - not the economy - decided how big the army
    // got: games were finishing at 118/135 rather than anywhere near 200.
    const producers = this.mine.buildings.filter((b) => b.complete && b.def.trains?.length).length;
    const want = Math.min(30, 8 + producers * 2 + Math.floor(this.mine.villagers.length / 10));
    if (headroom + queued * 5 >= want) return;
    // Lay several at once when we are badly behind - one per pass is too slow.
    const batch = Math.min(3, Math.ceil((want - headroom - queued * 5) / 5));
    for (let i = 0; i < batch; i++) if (!this.tryBuild('house')) break;
  }

  /**
   * How many villagers we are working toward. Capped so the economy cannot eat
   * the population the army needs - at a 200 limit that is 130 villagers and 70
   * pop of army, which is roughly how a real Imperial boom is shaped.
   */
  get villagerTarget() {
    return Math.min(VILL_TARGET[this.p.age], Math.round(this.p.popMax * 0.65));
  }

  manageVillagers() {
    const target = this.villagerTarget;
    if (this.mine.villagers.length < target) {
      // Villager production never stops outright. Banking for an age used to
      // halt it completely, and because the AI sits at the age gate for minutes
      // that is exactly what pinned it around 50 villagers for a whole game.
      // The first Town Center ignores the reserve so the economy always grows;
      // the rest spend only what is left above it, so the bank still fills.
      const tcs = this.buildingsOf('townCenter');
      const cost = this.p.mods.unit('villager').cost;
      for (let i = 0; i < tcs.length; i++) {
        if (i > 0 && !this.canSpend(cost)) break;
        const depth = tcs[i].queue.filter((q) => q.kind === 'unit').length;
        if (depth < 3) this.game.queueUnit(tcs[i], 'villager');
      }
    }
    this.assignIdle();
  }

  /**
   * Puts every idle villager back to work. This is the "no idle villagers"
   * rule: it runs every pass regardless of whether we are still producing, and
   * it falls through every resource before giving up, so a villager whose bush
   * ran dry never just stands there.
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

    for (const v of this.mine.idle) {
      // The idle list was captured at the top of the pass, and construction and
      // housing have run since - they pick idle villagers first. Re-checking
      // stops this from immediately pulling them back off the foundation they
      // were just sent to, which had them ping-ponging between build and gather
      // every single second.
      if (v.task.type !== 'idle') continue;
      // Rank the four resources by how far behind the target split they are and
      // try them in that order, so a villager only ends up idle if literally
      // nothing on the map is gatherable.
      const order = ['food', 'wood', 'gold', 'stone'].sort((a, b) => deficit(b) - deficit(a));
      for (const want of order) {
        if (this.assignGather(v, want)) { working[want]++; break; }
      }
    }

    // Rebalance. Villagers otherwise keep the job they were first given for the
    // whole game, so the economy drifts and never corrects: one game banked
    // 4500 gold with eleven miners on it while the wood ran out and no second
    // Town Center could ever be afforded.
    if (this.mine.villagers.length < 8) return;
    const over = ['food', 'wood', 'gold', 'stone'].sort((a, b) => deficit(a) - deficit(b))[0];
    const under = ['food', 'wood', 'gold', 'stone'].sort((a, b) => deficit(b) - deficit(a))[0];
    // Move at most one villager per pass, and only on a clear imbalance:
    // re-tasking costs a walk, so a twitchy rebalance burns more gathering time
    // than the misallocation it is correcting.
    if (over === under || deficit(under) - deficit(over) < 0.18) return;
    let moved = 0;
    for (const v of this.mine.villagers) {
      if (moved >= 1) break;
      if (v.task.type !== 'gather' || v.task.resType !== over) continue;
      if (v.carrying && v.carrying.amount > 0) continue;   // let it finish the trip
      if (this.assignGather(v, under)) moved++;
    }
  }

  /**
   * The target resource split for this age, bent by what is actually in the
   * bank. A stockpile is only useful until it is big enough to spend; past
   * that, every villager left on it is a villager not gathering the thing that
   * is currently blocking us.
   */
  resourceDemand() {
    const base = RES_SPLIT[this.p.age];
    // Under attack with no Castle yet, stone is the only resource that matters
    // until there is 650 of it - a Castle bought two minutes sooner is worth
    // more than anything the other three could buy.
    const rushStone = this.wantEmergencyCastle && this.p.res.stone < 700;
    const split = {};
    let sum = 0;
    for (const k of ['food', 'wood', 'gold', 'stone']) {
      const amt = this.p.res[k];
      let f = 1;
      // Enough miners to get the Castle up, not the whole economy. Stone mines
      // hold only a handful of villagers each, so driving 70% of the town onto
      // stone leaves the overflow with nowhere to work at all.
      if (rushStone) f = k === 'stone' ? 3.5 : 0.8;
      else if (amt > 1800) f = 0.2;
      else if (amt > 900) f = 0.5;
      else if (amt < 150) f = 1.8;
      // Stone is only ever wanted in bulk for Town Centers and Castles.
      const v = Math.max(0.02, (base[k] || 0.02) * f);
      split[k] = v; sum += v;
    }
    for (const k in split) split[k] /= sum;
    return split;
  }

  /**
   * How far a node may sit from its drop-off before it stops being worth
   * working. A villager carries 10 at a time, so a node 40 tiles from the
   * nearest drop-off spends over 90% of its life walking. Sending food
   * gatherers to distant deer instead of farming beside the Mill is the single
   * most expensive mistake this AI can make - it looks busy and earns nothing.
   */
  static MAX_HAUL = 14;

  /** How long the AI keeps countering a unit after last seeing one. */
  static MEMORY_SECONDS = 180;
  /** How close enemy soldiers have to get before the base counts as threatened. */
  static THREAT_RADIUS = 32;

  assignGather(v, res) {
    const g = this.game;
    const pick = (limit) => {
      let best = null, bestD = Infinity;
      for (const e of this.nodes[res]) {
        if (!e.alive) continue;
        if ((this.nodeLoad.get(e.id) || 0) >= nodeCap(e)) continue;
        const drop = e._aiDrop === Infinity ? e._aiHome : e._aiDrop;
        if (drop > limit) continue;
        // Walk out once, haul back on every trip - so the haul dominates.
        const d = Math.hypot(e.x - v.x, e.y - v.y) * 0.5 + drop * 3;
        if (d < bestD) { bestD = d; best = e; }
      }
      return best;
    };
    const take = (node) => {
      this.nodeLoad.set(node.id, (this.nodeLoad.get(node.id) || 0) + 1);
      g.commandGather([v], node);
      return true;
    };

    const near = pick(AI.MAX_HAUL);
    if (near) return take(near);

    if (res === 'food') {
      // Nothing close by: farm instead of trekking across the map. A plot
      // beside the Mill out-earns distant hunt several times over.
      const freeFarm = g._findFreeFarm(v);
      if (freeFarm) { g.commandGather([v], freeFarm); return true; }
      // Join a plot that has already been paid for before buying another one.
      const pending = g._nearestUnbuiltFarm(v, null);
      if (pending) { g.commandBuildAt([v], pending); return true; }

      if (this.canSpend(this.p.mods.building('farm').cost)) {
        // Try every food drop-off, nearest first - not just the closest one.
        // Only trying the nearest meant that once the ground around one Mill
        // filled up, the AI decided farming was impossible: one game sat in
        // Feudal for half an hour with 52 villagers, one farm, and 4900 wood it
        // could not turn into food.
        const sites = this.mine.buildings
          .filter((b) => b.complete && b.def.dropSite?.includes('food'))
          .sort((a, b) => g._distTo(v, a) - g._distTo(v, b));
        for (const site of sites) {
          // `pendingSpots` matters because the entity grid only rebuilds once a
          // tick: without it every villager in this pass is handed the same plot.
          const spot = g._nearestFarmSpot(site, this.index, this.pendingSpots);
          if (!spot) continue;
          this.pendingSpots.push(spot);
          g.commandBuild([v], 'farm', spot.x, spot.y);
          return true;
        }
        // Every existing drop-off is boxed in. A new Mill out on open ground
        // opens a fresh farm block, which is the only way to grow food from here.
        if (!this.underConstruction('mill') && this.tryBuild('mill')) return true;
      }
    }
    // Last resort: a far node still beats standing still, and manageDropSites
    // will follow up with a camp on it next pass.
    const far = pick(Infinity);
    if (far) return take(far);

    // Nothing in the cached lists at all - they only cover a radius around the
    // base, and by the late game the forests inside it are gone. Sweep the
    // whole map rather than leave villagers standing idle: a 60-tile walk to a
    // tree is what unblocks the wood that pays for the next farm and the next
    // Town Center. This only runs when the local search has already failed.
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
      // The crowding cap is an efficiency preference, not a rule. By this point
      // the alternative is standing still, and a crowded mine still pays.
      const d = Math.hypot(e.x - v.x, e.y - v.y) + (over ? 200 : 0);
      if (d < bestD) { bestD = d; best = e; }
    }
    return best ? take(best) : false;
  }

  /**
   * Trades at the Market. Late-game economies end up with thousands of banked
   * gold and no wood - at which point they cannot build another Farm, let alone
   * another Town Center, and the whole boom stops on a resource they are
   * drowning in. Selling the surplus is exactly what a human does here.
   */
  manageMarket() {
    if (!this.has('market')) return;
    const r = this.p.res;
    // Buy the resource we are starved of, using gold we have no use for.
    for (const res of ['wood', 'food', 'stone']) {
      if (r[res] < 200 && r.gold > 700) this.game.marketTrade(this.index, res, 'buy');
    }
    // And dump a genuinely excessive stone pile back into gold.
    if (r.stone > 1000 && this.count('castle') >= 1) this.game.marketTrade(this.index, 'stone', 'sell');
  }

  /**
   * Plants drop-off buildings on top of the resources themselves, as early as
   * the wood allows. The old rule only reacted once villagers were already
   * walking 9+ tiles - by then the round trip has been wasting gather time for
   * minutes. This one looks at the map instead of at the symptom, and puts the
   * camp where the biggest un-serviced cluster is.
   */
  manageDropSites() {
    const v = this.mine.villagers.length;
    // Camp counts are capped: without a ceiling the AI plants one at every
    // berry patch and forest edge on the map and spends its whole wood income
    // on drop-offs it has nobody to staff.
    const cap = { lumberCamp: 2 + Math.floor(v / 15), miningCamp: 2 + Math.floor(v / 25), mill: 1 + Math.floor(v / 30) };
    const pairs = [['wood', 'lumberCamp'], ['gold', 'miningCamp'], ['stone', 'miningCamp'], ['food', 'mill']];
    for (const [res, bId] of pairs) {
      if (this.underConstruction(bId)) continue;
      if (this.count(bId) >= cap[bId]) continue;
      if (!this.p.isBuildingAvailable(bId)) continue;
      // Drop-off buildings outrank the reserve: shortening every round trip
      // pays for the Town Center faster than saving for it does.
      if (!this.canSpend(this.p.mods.building(bId).cost, true)) continue;
      // Best cluster: lots of nodes, currently far from any drop-off, not miles
      // from home. Mills only make sense for berries and hunt, not farms.
      // Shortlist on the cheap score first. Counting the cluster around every
      // node is O(n^2) and there can be hundreds of trees in range, so only the
      // handful of genuinely under-served nodes get the expensive treatment.
      const shortlist = this.nodes[res]
        .filter((n) => n._aiDrop >= 7 &&
          !(res === 'food' && n.kind === 'resource' && n.type !== 'berries'))
        .sort((a, b) => (b._aiDrop - b._aiHome * 0.6) - (a._aiDrop - a._aiHome * 0.6))
        .slice(0, 12);
      let best = null, bestScore = 0;
      for (const n of shortlist) {
        let cluster = 0;
        for (const m of this.nodes[res]) {
          if (Math.abs(m.x - n.x) < 5 && Math.abs(m.y - n.y) < 5) cluster++;
        }
        const score = cluster * 3 + n._aiDrop - n._aiHome * 0.6;
        if (score > bestScore) { bestScore = score; best = n; }
      }
      if (best && this.tryBuildAt(bId, best.x, best.y, 2, 4)) return;
    }
  }

  manageEconomyBuildings() {
    const a = this.p.ageIndex;
    const v = this.mine.villagers.length;
    // Mills scale with the farm block: farmers walking across the whole base to
    // drop 10 food is a huge silent economy leak. (Mills sited on berries are
    // handled by manageDropSites; these are the ones the farms grow around.)
    // One Mill supports roughly a block of eight farms, so mills have to scale
    // with the number of villagers that will end up farming - not sit at two or
    // three while the food economy needs twenty plots.
    if (a >= 1 && this.count('mill') < Math.min(8, 1 + Math.floor(v / 14)) &&
      !this.underConstruction('mill')) this.tryBuild('mill');
    if (a >= 1 && !this.has('market') && !this.underConstruction('market') &&
      this.p.res.wood > 300) this.tryBuild('market');
    // More Town Centers is the single biggest boom lever - four TCs produce
    // villagers four times as fast, which is the only way to reach 130. This
    // sits ahead of every other wood spend on purpose: gated behind a healthy
    // wood float it never fired at all, because Farms, Houses and military
    // buildings drank the wood down to nothing first and the AI spent an hour
    // on a single Town Center.
    const tcWant = a >= 3 ? 6 : a >= 2 ? 4 : 1;
    const tcCost = this.p.mods.building('townCenter').cost;
    if (a >= 2 && this.count('townCenter') < tcWant && !this.underConstruction('townCenter') &&
      this.p.canAfford(tcCost)) {
      // Put the new one on unworked resources rather than beside the old one.
      const spread = this.nodes.wood.concat(this.nodes.gold)
        .filter((n) => n._aiDrop > 12)
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
    if (this.mine.villagers.length < ageGate(this.p.age)) return;
    this.game.queueTech(tc, techId);
  }

  manageMilitaryBuildings() {
    const a = this.p.ageIndex;
    if (a >= 0 && !this.has('barracks') && !this.underConstruction('barracks') &&
      this.mine.villagers.length >= 12) this.tryBuild('barracks');
    if (a >= 1) {
      // Blacksmith first in Feudal: every upgrade in it applies to the whole
      // army for the rest of the game, so it is the cheapest army we can buy.
      if (!this.has('blacksmith') && !this.underConstruction('blacksmith')) this.tryBuild('blacksmith');
      const wantRange = !this.p.disabledUnits.has('archer');
      const wantStable = !this.p.disabledBuildings.has('stable');
      // Production capacity scales with the economy that has to spend through
      // it. A 130-villager Imperial income outruns three buildings several
      // times over, and unspent resources win nothing - so this is tied to
      // villager count rather than a flat per-age number.
      const v = this.mine.villagers.length;
      // Add production when the production we already have is the bottleneck -
      // every queue full while resources pile up - rather than guessing from a
      // wood total. A flat "wood > 350" gate meant an AI that spent its wood on
      // farms and Town Centers never built a second Barracks, and went into the
      // Imperial Age converting a 60-villager economy through three buildings
      // while its opponent had ten. Capacity it cannot feed is still waste, so
      // the count stays capped.
      const busy = this.mine.buildings.filter((b) =>
        b.complete && b.def.trains.length && b.type !== 'townCenter' && b.queue.length >= 3);
      const producers = this.mine.buildings.filter((b) =>
        b.complete && b.def.trains.length && b.type !== 'townCenter' && b.type !== 'monastery');
      const saturated = producers.length > 0 && busy.length >= producers.length;
      const spare = this.p.res.wood > 350 || (saturated && this.p.res.wood > 175);
      const each = !spare ? 1 : Math.max(1, Math.min(a >= 3 ? 5 : a >= 2 ? 3 : 2, 1 + Math.floor(v / 22)));
      if (this.count('barracks') < each && !this.underConstruction('barracks')) this.tryBuild('barracks');
      if (wantRange && this.count('archeryRange') < each && !this.underConstruction('archeryRange'))
        this.tryBuild('archeryRange');
      if (wantStable && this.count('stable') < each && !this.underConstruction('stable'))
        this.tryBuild('stable');
    }
    if (a >= 2) {
      if (!this.has('siegeWorkshop') && !this.underConstruction('siegeWorkshop')) this.tryBuild('siegeWorkshop');
      if (!this.has('university') && !this.underConstruction('university')) this.tryBuild('university');
      if (!this.has('monastery') && !this.underConstruction('monastery')) this.tryBuild('monastery');
      const castleWant = a >= 3 ? 3 : 1;
      if (this.count('castle') < castleWant && this.p.res.stone >= 650 && !this.underConstruction('castle'))
        this.tryBuild('castle');
    }
    if (a >= 1 && this.count('watchTower') + this.count('guardTower') + this.count('keep') < 2 + a &&
      this.p.res.stone > 300 && !this.underConstruction('watchTower')) {
      this.tryBuildAt('watchTower', this.homeX, this.homeY, 5, 9);
    }
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
    const g = this.game;
    const at = this.threatAt || { x: this.homeX, y: this.homeY };
    // Put it between the town centre and where they are coming from.
    const dx = at.x - this.homeX, dy = at.y - this.homeY;
    const d = Math.hypot(dx, dy) || 1;
    const bx = this.homeX + (dx / d) * 7, by = this.homeY + (dy / d) * 7;

    if (this.wantEmergencyCastle) {
      const cost = this.p.mods.building('castle').cost;
      if (this.p.canAfford(cost)) {
        // Four builders and a spot facing the attack, rather than wherever the
        // random placement search happened to land.
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
    void g;
  }

  /**
   * Nothing should sit in the bank. Resources in the stockpile do no work, so
   * once we are clearly floating we convert the excess into permanent capacity
   * - more production, more Town Centers, more defence.
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

  /* ---------------- army ---------------- */

  /**
   * The army we want, as target shares of the whole rather than a list.
   *
   * A plain list plus round-robin queueing gave every entry equal weight, so
   * "some siege once available" quietly became a third of the army - the AI
   * fielded piles of Battering Rams that lose to anything with legs. Shares
   * make the intent explicit and keep siege to a support role.
   *
   * @returns array of { id, share } summing to roughly 1
   */
  desiredComposition() {
    // Built from what we have actually scouted or fought, not from the whole
    // enemy army. Until the two sides meet, this is empty and the AI falls
    // through to its generic opening below.
    const seen = {};
    let total = 0;
    for (const m of (this.enemyMemory || new Map()).values()) {
      seen[m.cls] = (seen[m.cls] || 0) + 1;
      total++;
    }

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

    if (total === 0) {
      // Nothing met yet: a generic opening, and the scout that will find them.
      add(0.5, 'archer', 'spearman', 'militia');
      add(0.5, 'scoutCavalry', 'eagleScout', 'spearman');
    } else {
      // Counter what we have seen, in proportion to how much of it there is.
      // The primary answer gets most of the weight, the secondary the rest.
      for (const cls in seen) {
        const share = seen[cls] / total;
        if (share < 0.12) continue;               // a stray scout is not a strategy
        const answers = COUNTERS[cls];
        if (!answers) continue;
        add(share * 0.7, ...answers[0]);
        if (answers[1]) add(share * 0.3, ...answers[1]);
      }
    }

    // A backbone that is always wanted, so the army is never purely reactive -
    // and split one entry per production building. Merging infantry and cavalry
    // into a single "best available" entry meant that whenever a Stable existed
    // the Barracks had nothing in the composition it could train, and stood
    // idle for the whole game.
    add(0.22, 'paladin', 'cavalier', 'knight', 'camelRider', 'steppeLancer', 'battleElephant');
    add(0.18, 'champion', 'twoHandedSwordsman', 'longSwordsman', 'manAtArms', 'militia',
      'eliteEagleWarrior', 'eagleWarrior', 'eagleScout');
    add(0.2, 'arbalester', 'crossbowman', 'archer', 'eliteSkirmisher', 'skirmisher');
    if (a >= 2 && this.has('castle')) add(0.2, this.p.civ.uuElite, this.p.civ.uu);

    // Siege is support: enough to break a wall or a Town Center, never the army
    // itself. Rams also only earn their keep once there is something to knock
    // down, so they stay off the list until we are actually attacking.
    if (a >= 2) {
      add(0.08, 'siegeRam', 'cappedRam', 'batteringRam');
      add(0.07, 'onager', 'mangonel');
    }

    const sum = wants.reduce((t, w) => t + w.share, 0) || 1;
    for (const w of wants) w.share /= sum;
    return wants;
  }

  manageArmy() {
    const g = this.game;
    const comp = this.desiredComposition();
    if (!comp.length) return;
    // Keep the Dark Age to a token defensive force - real AoE2 openings do not
    // mass Militia - and otherwise let the army grow until the population cap.
    const armyCap = this.p.ageIndex === 0 ? 4 : Infinity;
    const holdProduction = this.mine.army.length >= armyCap;

    // Units are bought out of whatever sits above the reserve, so the army
    // keeps growing through an age-up save instead of freezing. Below a minimum
    // defensive force the reserve is ignored outright: banking 800 food behind
    // an army of three loses the town long before the bank is ever spent, and
    // that is exactly how one AI went into Castle Age with 52 villagers and
    // three soldiers against an opponent fielding fifteen.
    // How big that minimum is depends on whether anything is actually
    // threatening us. A token guard is enough while the map is quiet - holding
    // twenty soldiers against nobody just delays the age-up, which cost every
    // benchmark seed its run to Imperial - but once an enemy army has been seen
    // the guaranteed force has to be a real one.
    // "Pressured" has to mean a threat to us, not merely having laid eyes on
    // the enemy: scouting six units across the map is normal and should not put
    // the economy on a war footing for the rest of the game.
    const pressured = this.underThreat || this.enemyMemory.size >= 12;
    const byAge = pressured ? [6, 12, 22, 22] : [3, 5, 10, 12];
    const minArmy = byAge[this.p.ageIndex];
    // The bypass stops once the age bank is over half full. Without that stop
    // it is permanent whenever the army is being ground down in a war - the AI
    // is always "below its minimum", always ignores the reserve, and never
    // advances an age again. Every benchmark seed stalled in the Castle Age.
    const ageProgress = (this.savingForAge && this.reserve && this.reserve.food)
      ? this.p.res.food / this.reserve.food : 0;
    const belowMinimum = this.mine.army.length < minArmy && ageProgress < 0.6;
    const affordableNow = (id) =>
      this.canSpend(this.p.mods.unit(id).cost, belowMinimum);

    const producers = holdProduction ? [] : this.mine.buildings.filter((b) =>
      b.complete && b.def.trains.length && b.type !== 'townCenter' && b.type !== 'dock' && b.type !== 'market');

    // What we already have, so each building can be handed whichever wanted
    // unit the army is furthest short of rather than the next one in a list.
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

    // Queue deeper when we are floating resources: a shallow queue means the
    // building idles between AI passes and the bank keeps growing. Deeper still
    // near the population cap, where the aim is to be at the cap when we attack.
    const r = this.p.res;
    const rich = r.food > 700 && r.gold > 500;
    const deep = rich ? 7 : 3;
    for (const b of producers) {
      if (b.queue.length >= deep) continue;
      const options = comp
        .filter((w) => b.def.trains.includes(w.id) ||
          (b.type === 'castle' && (w.id === this.p.civ.uu || w.id === this.p.civ.uuElite)))
        .filter((w) => affordableNow(w.id))
        // A building that is already over its share of the army produces
        // nothing. Without this a Siege Workshop can only ever train siege, so
        // it kept queueing rams no matter how many we had - one game ended up
        // 62% siege. The small tolerance keeps a balanced army growing rather
        // than deadlocking with every share exactly met and nobody producing.
        .filter((w) => deficit(w.id) > -0.03)
        .sort((x, y) => deficit(y.id) - deficit(x.id));
      for (const w of options) {
        if (g.queueUnit(b, w.id)) { have[w.id] = (have[w.id] || 0) + 1; break; }
      }
    }

    // attack waves - bigger armies as the ages go on, matching the bigger economy
    this.attackTimer -= 1;
    const waveSize = this.armySize + this.p.ageIndex * 6;
    const ready = this.mine.army.filter((u) => u.def.cat !== 'monk');
    // At the population limit the army cannot grow, so sitting on it is pure
    // waste - every second spent banked is a second it is not trading. Attack
    // regardless of the usual wave size once we are near the cap.
    const popFull = this.p.pop >= this.p.effectivePopCap - 6;
    if (!this.attacking && (ready.length >= waveSize || (popFull && ready.length >= 8)) &&
        this.attackTimer <= 0) {
      const target = this.pickAttackTarget();
      if (target) {
        this.attacking = true;
        g.commandAttackMove(ready, target.x, target.y);
        this.attackTimer = 60;
      }
    } else if (this.attacking) {
      if (ready.length < waveSize * 0.35 && !popFull) {
        this.attacking = false;
        g.commandMove(ready, this.homeX + 3, this.homeY + 3);
        this.attackTimer = 45;
      } else {
        // Reinforce: anything idle at home joins the fight instead of standing
        // in the base while the wave it belongs to fights short-handed.
        const idleFighters = ready.filter((u) => u.task.type === 'idle');
        if (idleFighters.length) {
          const target = this.pickAttackTarget();
          if (target) g.commandAttackMove(idleFighters, target.x, target.y);
          else if (idleFighters.length > ready.length * 0.6) this.attacking = false;
        }
      }
    }

    // monks pick up relics
    const monks = this.mine.army.filter((u) => u.def.converts && u.task.type === 'idle');
    for (const m of monks) {
      const relic = this.game.entityGrid.nearest(m.x, m.y, 40, (e) => e.kind === 'resource' && e.type === 'relic');
      if (relic) this.game.commandRelic([m], relic);
    }
  }

  /**
   * Sends the opening scout out to find the enemy.
   *
   * This is the other half of only countering what you can see: an AI that
   * never looks never learns anything, so it opens generically and is still
   * building the wrong units when the first attack lands. The scout walks a
   * spread of unexplored points until it has met the enemy army.
   */
  manageScouting() {
    // Once we have a picture of what they field, the scout is just cavalry.
    if (this.enemyMemory.size >= 3 && this.p.ageIndex >= 2) return;
    const scout = this.mine.army.find((u) =>
      u.task.type === 'idle' && u.def.cat === 'cavalry' && !u.def.range);
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
   * Where to send the next wave. Prefers what actually costs the enemy the
   * game - their villagers and the buildings that make more of them - over
   * whatever happens to be nearest, which was usually an outlying House.
   */
  pickAttackTarget() {
    const g = this.game;
    // A cluster of enemy villagers is the best thing an army can find.
    let vills = null, villScore = Infinity;
    for (const u of this.enemyUnits) {
      if (u.def.cat !== 'villager') continue;
      const d = Math.hypot(u.x - this.homeX, u.y - this.homeY);
      if (d < villScore) { villScore = d; vills = u; }
    }

    let best = null, bestScore = Infinity;
    for (const e of g.entities) {
      if (!e.alive || !g.isEnemy(this.index, e.owner)) continue;
      if (e.kind !== 'building') continue;
      let score = Math.hypot(e.x - this.homeX, e.y - this.homeY);
      if (e.type === 'townCenter') score -= 45;
      else if (e.def.cat === 'military') score -= 20;
      else if (e.def.dropSite || e.type === 'farm') score -= 12;   // their economy
      else if (e.type === 'house') score += 25;                    // never worth a wave
      if (score < bestScore) { bestScore = score; best = e; }
    }
    // Villagers win unless a real target is much closer to us than they are.
    if (vills && (!best || villScore < bestScore + 20)) return vills;
    if (best) return best;
    for (const u of this.enemyUnits) return u;
    return null;
  }

  manageDefense() {
    const g = this.game;
    // anything attacking near our base pulls the home guard
    const threats = this.enemyUnits.filter((e) =>
      Math.hypot(e.x - this.homeX, e.y - this.homeY) < 22);
    if (!threats.length) {
      // Let the villagers back out once the raid is over. Nothing else does
      // this, so before now every raid permanently retired up to eight
      // villagers into the Town Center for the rest of the game.
      for (const b of this.mine.buildings) {
        if (!b.complete || !b.garrison.length) continue;
        const hasVills = b.garrison.some((id) => {
          const u = g.get(id);
          return u && u.def.cat === 'villager';
        });
        if (hasVills) g.ungarrisonAll(b);
      }
      return;
    }
    const defenders = this.mine.army.filter((u) =>
      !this.attacking || Math.hypot(u.x - this.homeX, u.y - this.homeY) < 26);
    if (defenders.length) g.commandAttack(defenders, threats[0]);
    // villagers under fire garrison the Town Center
    const t = threats[0];
    const scared = this.mine.villagers.filter((v) => Math.hypot(v.x - t.x, v.y - t.y) < 7);
    if (scared.length && this.tc && this.tc.garrison.length < this.tc.def.garrison) {
      g.commandGarrison(scared.slice(0, 8), this.tc);
    }
  }

  /* ---------------- research ---------------- */

  manageResearch() {
    // Research several per pass. One-at-a-time meant a Blacksmith, University
    // and Mill could each be free and only one of them would ever be used,
    // which is how upgrades fell a whole age behind the army they applied to.
    let started = 0;
    const limit = this.p.ageIndex >= 2 ? 4 : 2;
    // The food buffer protects villager production, but it has to shrink once
    // the economy is big - at 90 villagers, 150 food is a couple of seconds.
    const buffer = this.mine.villagers.length >= VILL_TARGET[this.p.age] * 0.6 ? 40 : 150;

    const tryList = (ids, budget, ignoreReserve) => {
      let used = 0;
      for (const id of ids) {
        if (started >= limit || used >= budget) return;
        if (!TECHS[id] || !this.p.isTechAvailable(id)) continue;
        const cost = this.p.mods.techCost(TECHS[id]);
        // Research spends only what is above the age/Town Center reserve, so it
        // can never drain the bank as fast as the villagers fill it.
        if (!this.canSpend(cost, ignoreReserve)) continue;
        if (cost.food > 0 && this.p.res.food < cost.food + buffer) continue;
        const b = this.buildingsOf(TECHS[id].building).find((x) => x.queue.length === 0);
        if (b && this.game.queueTech(b, id)) { started++; used++; }
      }
    };

    // Unit-line upgrades get a guaranteed share of every pass. They used to be
    // tried only after all thirty-odd generic techs, which was survivable when
    // reaching Imperial handed you Champions and Paladins outright. Now that a
    // line has to be walked up one tier at a time, an AI that never gets round
    // to it fights the whole game with Militia.
    // Unit upgrades may dip into the age reserve. Each one is bought exactly
    // once, so unlike unit production this cannot run away - and an army with
    // no upgrades is worth far less than reaching the next age two minutes
    // sooner. Left behind the reserve, a whole 60-minute game researched one.
    tryList(this.unitUpgradeTechs(), Math.max(1, Math.ceil(limit / 2)), true);
    tryList(TECH_PRIORITY, limit);
  }

  /**
   * The upgrade techs that matter to this AI: the next step up for everything
   * it fields or intends to field, plus its Elite unique unit. Derived from the
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

  /* ---------------- placement ---------------- */

  tryBuild(bId) {
    // The search radius has to grow with the town. A fixed 14 tiles is full
    // long before a 70-building Imperial base is finished, and once nothing
    // fits, Houses stop going up and the population cap - not the economy -
    // decides how big the army gets.
    const reach = Math.min(34, 14 + this.mine.buildings.length * 0.25);
    return this.tryBuildAt(bId, this.homeX, this.homeY, 3, reach);
  }

  tryBuildAt(bId, cx, cy, minR, maxR) {
    const g = this.game;
    if (!this.p.isBuildingAvailable(bId)) return false;
    const def = this.p.mods.building(bId);
    // The reserve never blocks the thing it is saving for, nor a House when we
    // are about to hit the population cap - pop-blocking the economy to save
    // for a Town Center would defeat the point of the Town Center. When the
    // town is under attack the Castle is what the reserve exists for, so it
    // must not be blocked by its own reserve either.
    const urgent = bId === 'townCenter' ||
      (bId === 'castle' && (this.underThreat || this.wantEmergencyCastle)) ||
      (bId === 'house' && this.p.effectivePopCap - this.p.pop < 4);
    if (!this.canSpend(def.cost, urgent)) return false;
    const spot = this.findSpot(bId, cx, cy, minR, maxR);
    if (!spot) return false;
    const builders = this.pickBuilders(spot.x, spot.y, bId === 'castle' || bId === 'townCenter' ? 4 : 2);
    if (!builders.length) return false;
    return !!g.commandBuild(builders, bId, spot.x, spot.y);
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
