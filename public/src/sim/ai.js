// Computer opponent: a build-order driven economy plus a counter-aware army
// composition. It reads the same public command API the human UI uses.

import { TECHS } from '../data/techs.js';
import { AGES } from './player.js';

const VILL_TARGET = { dark: 20, feudal: 34, castle: 55, imperial: 75 };
const RES_SPLIT = {
  dark: { food: 0.55, wood: 0.35, gold: 0.10, stone: 0.0 },
  feudal: { food: 0.40, wood: 0.32, gold: 0.20, stone: 0.08 },
  castle: { food: 0.34, wood: 0.28, gold: 0.28, stone: 0.10 },
  imperial: { food: 0.32, wood: 0.26, gold: 0.32, stone: 0.10 },
};

/**
 * Villager count at which the AI is willing to age up â€” and, identically, the
 * count at which it starts banking food instead of making more villagers.
 * These two must use the same number: if the saving gate trips before the
 * age-up gate, the AI stops producing villagers while still refusing to age,
 * and sits in the Dark Age forever.
 */
const ageGate = (age) => Math.round(VILL_TARGET[age] * 0.7);

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

    this.manageHousing();
    this.manageVillagers();
    this.manageEconomyBuildings();
    this.manageAge();
    this.manageMilitaryBuildings();
    this.manageArmy();
    this.manageResearch();
    this.manageDefense();
  }

  /* ---------------- state ---------------- */

  cacheState() {
    const g = this.game;
    this.mine = { units: [], buildings: [], idle: [], villagers: [], army: [], byType: {} };
    this.enemyUnits = [];
    for (const e of g.entities) {
      if (!e.alive) continue;
      if (e.owner === this.index) {
        if (e.kind === 'unit') {
          this.mine.units.push(e);
          this.mine.byType[e.type] = (this.mine.byType[e.type] || 0) + 1;
          if (e.def.cat === 'villager') {
            this.mine.villagers.push(e);
            if (e.task.type === 'idle') this.mine.idle.push(e);
          } else if (e.def.cat !== 'trade' && e.def.cat !== 'animal') {
            this.mine.army.push(e);
          }
        } else if (e.kind === 'building') {
          this.mine.buildings.push(e);
          this.mine.byType[e.type] = (this.mine.byType[e.type] || 0) + 1;
        }
      } else if (e.kind === 'unit' && e.owner >= 0 && g.isEnemy(this.index, e.owner)) {
        this.enemyUnits.push(e);
      }
    }
    this.tc = this.mine.buildings.find((b) => b.type === 'townCenter' && b.complete) ||
      this.mine.buildings.find((b) => b.type === 'townCenter');
    if (this.tc) { this.homeX = this.tc.x; this.homeY = this.tc.y; }
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

  manageHousing() {
    if (this.p.mods.flags.has('noHouses')) return;
    const headroom = this.p.effectivePopCap - this.p.pop;
    const queued = this.mine.buildings.filter((b) => b.type === 'house' && !b.complete).length;
    if (headroom + queued * 5 < 6 && this.p.effectivePopCap < this.p.popMax) {
      this.tryBuild('house');
    }
  }

  manageVillagers() {
    // Keep the Town Centers producing villagers - but stop once we are close to
    // the age-up so the food actually banks instead of turning into more
    // villagers forever.
    const target = VILL_TARGET[this.p.age];
    const nextAge = AGES[this.p.ageIndex + 1];
    const ageTechId = nextAge ? nextAge + 'Age' : null;
    let saving = false;
    if (ageTechId && TECHS[ageTechId] && !this.p.researched.has(ageTechId) &&
        !this.p.researching.has(ageTechId) &&
        this.mine.villagers.length >= ageGate(this.p.age)) {
      const ageCost = this.p.mods.techCost(TECHS[ageTechId]);
      saving = this.p.res.food < ageCost.food + 60;
      // Only choke military production once the bank is genuinely close, so the
      // AI is not defenceless for the whole age while it saves.
      this.ageProgress = ageCost.food ? this.p.res.food / ageCost.food : 1;
    } else {
      this.ageProgress = 0;
    }
    this.savingForAge = saving;
    if (this.mine.villagers.length < target && !saving) {
      for (const tc of this.buildingsOf('townCenter')) {
        if (tc.queue.length < 2) this.game.queueUnit(tc, 'villager');
      }
    }
    // put idle villagers to work according to the age's resource split
    if (!this.mine.idle.length) return;
    const split = RES_SPLIT[this.p.age];
    const working = { food: 0, wood: 0, gold: 0, stone: 0 };
    for (const v of this.mine.villagers) {
      const t = v.task;
      let r = null;
      if (t.type === 'gather' || t.type === 'deliver') r = t.resType;
      if (r && working[r] !== undefined) working[r]++;
    }
    const total = Math.max(1, this.mine.villagers.length);
    for (const v of this.mine.idle) {
      let want = 'food', worst = -Infinity;
      for (const r of ['food', 'wood', 'gold', 'stone']) {
        const deficit = split[r] - working[r] / total;
        if (deficit > worst) { worst = deficit; want = r; }
      }
      if (this.assignGather(v, want)) working[want]++;
    }
  }

  assignGather(v, res) {
    const g = this.game;
    // farms count as food once berries/sheep run dry
    let best = null, bestD = Infinity;
    for (const e of g.entities) {
      if (!e.alive) continue;
      let ok = false;
      if (e.kind === 'resource' && e.amount > 0 && e.type !== 'relic') {
        ok = e.resType === res && (e.type !== 'fish');
      } else if (e.kind === 'unit' && e.owner < 0 && e.def.huntable && res === 'food') {
        ok = !e.def.hostile;
      }
      if (!ok) continue;
      const d = Math.hypot(e.x - this.homeX, e.y - this.homeY);
      if (d > 34) continue;
      const dd = d + Math.hypot(e.x - v.x, e.y - v.y) * 0.3;
      if (dd < bestD) { bestD = dd; best = e; }
    }
    if (best) { g.commandGather([v], best); return true; }
    if (res === 'food') {
      // Prefer an existing plot nobody is working - farms take one villager each.
      const freeFarm = g._findFreeFarm(v);
      if (freeFarm) { g.commandGather([v], freeFarm); return true; }
      // otherwise lay a new one next to the Mill or Town Center
      const mill = this.building('mill') || this.tc;
      if (mill && this.p.canAfford(this.p.mods.building('farm').cost)) {
        const spot = this.findSpot('farm', mill.x, mill.y, 3, 10);
        if (spot) { g.commandBuild([v], 'farm', spot.x, spot.y); return true; }
      }
    }
    return false;
  }

  manageEconomyBuildings() {
    const g = this.game;
    // a lumber camp near a forest we are cutting
    const woodVills = this.mine.villagers.filter((v) => v.task.resType === 'wood');
    if (woodVills.length > 3 && !this.underConstruction('lumberCamp')) {
      const far = woodVills.find((v) => {
        const site = g._findDropSite(v, 'wood');
        return !site || Math.hypot(site.x - v.x, site.y - v.y) > 9;
      });
      if (far) this.tryBuildAt('lumberCamp', far.x, far.y, 1, 5);
    }
    const goldVills = this.mine.villagers.filter((v) => v.task.resType === 'gold' || v.task.resType === 'stone');
    if (goldVills.length > 2 && !this.underConstruction('miningCamp')) {
      const far = goldVills.find((v) => {
        const site = g._findDropSite(v, 'gold');
        return !site || Math.hypot(site.x - v.x, site.y - v.y) > 9;
      });
      if (far) this.tryBuildAt('miningCamp', far.x, far.y, 1, 5);
    }
    if (this.p.ageIndex >= 1 && !this.has('mill') && !this.underConstruction('mill')) this.tryBuild('mill');
    if (this.p.ageIndex >= 1 && !this.has('market') && !this.underConstruction('market') &&
      this.p.res.wood > 400) this.tryBuild('market');
    if (this.p.ageIndex >= 2 && this.count('townCenter') < 3 && this.p.res.wood > 500 &&
      this.p.res.stone > 200 && !this.underConstruction('townCenter')) this.tryBuild('townCenter');
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
      if (!this.has('blacksmith') && !this.underConstruction('blacksmith')) this.tryBuild('blacksmith');
      const wantRange = !this.p.disabledUnits.has('archer');
      const wantStable = !this.p.disabledBuildings.has('stable');
      if (wantRange && this.count('archeryRange') < (a >= 2 ? 2 : 1) && !this.underConstruction('archeryRange'))
        this.tryBuild('archeryRange');
      if (wantStable && this.count('stable') < (a >= 2 ? 2 : 1) && !this.underConstruction('stable'))
        this.tryBuild('stable');
    }
    if (a >= 2) {
      if (!this.has('siegeWorkshop') && !this.underConstruction('siegeWorkshop')) this.tryBuild('siegeWorkshop');
      if (!this.has('university') && !this.underConstruction('university')) this.tryBuild('university');
      if (!this.has('monastery') && !this.underConstruction('monastery')) this.tryBuild('monastery');
      if (this.count('castle') < 1 && this.p.res.stone >= 650 && !this.underConstruction('castle'))
        this.tryBuild('castle');
    }
    if (a >= 1 && this.count('watchTower') + this.count('guardTower') + this.count('keep') < 2 &&
      this.p.res.stone > 300 && !this.underConstruction('watchTower')) {
      this.tryBuildAt('watchTower', this.homeX, this.homeY, 5, 9);
    }
  }

  /* ---------------- army ---------------- */

  /** Reads the enemy composition and picks the units that counter it. */
  desiredComposition() {
    let cav = 0, arch = 0, inf = 0, siege = 0, total = 0;
    for (const e of this.enemyUnits) {
      const c = e.def.classes;
      if (c.includes('cavalry') && !c.includes('archer')) cav++;
      else if (c.includes('archer')) arch++;
      else if (c.includes('infantry')) inf++;
      if (c.includes('siege')) siege++;
      total++;
    }
    const wants = [];
    const uu = this.p.civ.uu;
    const eliteUU = this.p.civ.uuElite;
    const pick = (id) => this.p.isUnitAvailable(id) ? id : null;

    if (total === 0) {
      // no scouting information yet - go with a generic mix
      wants.push(pick('archer') || pick('spearman') || pick('militia'));
      wants.push(pick('scoutCavalry') || pick('eagleScout') || pick('spearman'));
    } else {
      const cavShare = cav / total, archShare = arch / total, infShare = inf / total;
      if (cavShare > 0.3) {
        // pikes hard-counter cavalry; camels are the mounted answer
        wants.push(pick('halberdier') || pick('pikeman') || pick('spearman'));
        wants.push(pick('heavyCamelRider') || pick('camelRider') || pick('kamayuk'));
      }
      if (archShare > 0.3) {
        // skirmishers eat archers; cavalry closes on them
        wants.push(pick('eliteSkirmisher') || pick('skirmisher'));
        wants.push(pick('paladin') || pick('cavalier') || pick('knight') ||
          pick('eliteEagleWarrior') || pick('eagleWarrior') || pick('eagleScout'));
      }
      if (infShare > 0.35) {
        wants.push(pick('arbalester') || pick('crossbowman') || pick('archer'));
        wants.push(pick('onager') || pick('mangonel'));
      }
      if (siege > 2) {
        wants.push(pick('hussar') || pick('lightCavalry') || pick('scoutCavalry') ||
          pick('eliteEagleWarrior') || pick('eagleWarrior'));
      }
    }
    // always mix in the civ's unique unit and some siege once available
    if (this.p.ageIndex >= 2 && this.has('castle')) wants.push(pick(eliteUU) || pick(uu));
    if (this.p.ageIndex >= 2) wants.push(pick('batteringRam') || pick('mangonel'));
    // fall back to whatever the civ has
    wants.push(pick('champion') || pick('twoHandedSwordsman') || pick('longSwordsman') ||
      pick('manAtArms') || pick('militia'));
    return wants.filter(Boolean);
  }

  manageArmy() {
    const g = this.game;
    const comp = this.desiredComposition();
    if (!comp.length) return;
    // Do not burn the age-up food on units, and keep the Dark Age to a token
    // defensive force - real AoE2 openings do not mass Militia.
    const armyCap = this.p.ageIndex === 0 ? 4 : Infinity;
    const holdProduction = (this.savingForAge && this.ageProgress > 0.5) ||
      this.mine.army.length >= armyCap;

    const producers = holdProduction ? [] : this.mine.buildings.filter((b) =>
      b.complete && b.def.trains.length && b.type !== 'townCenter' && b.type !== 'dock' && b.type !== 'market');
    let ci = 0;
    for (const b of producers) {
      if (b.queue.length >= 3) continue;
      // find a wanted unit this building can actually train
      for (let k = 0; k < comp.length; k++) {
        const id = comp[(ci + k) % comp.length];
        const trains = b.def.trains.includes(id) ||
          (b.type === 'castle' && (id === this.p.civ.uu || id === this.p.civ.uuElite));
        if (!trains) continue;
        if (g.queueUnit(b, id)) { ci++; break; }
      }
    }

    // attack waves
    this.attackTimer -= 1;
    const ready = this.mine.army.filter((u) => u.def.cat !== 'monk');
    if (!this.attacking && ready.length >= this.armySize && this.attackTimer <= 0) {
      const target = this.pickAttackTarget();
      if (target) {
        this.attacking = true;
        g.commandAttackMove(ready, target.x, target.y);
        this.attackTimer = 90;
      }
    } else if (this.attacking) {
      if (ready.length < this.armySize * 0.35) {
        this.attacking = false;
        g.commandMove(ready, this.homeX + 3, this.homeY + 3);
        this.attackTimer = 60;
      } else {
        const idleFighters = ready.filter((u) => u.task.type === 'idle');
        if (idleFighters.length > ready.length * 0.6) {
          const target = this.pickAttackTarget();
          if (target) g.commandAttackMove(idleFighters, target.x, target.y);
          else this.attacking = false;
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

  pickAttackTarget() {
    const g = this.game;
    let best = null, bestScore = Infinity;
    for (const e of g.entities) {
      if (!e.alive || !g.isEnemy(this.index, e.owner)) continue;
      if (e.kind !== 'building') continue;
      const d = Math.hypot(e.x - this.homeX, e.y - this.homeY);
      let score = d;
      if (e.type === 'townCenter') score -= 40;
      if (e.def.cat === 'military') score -= 15;
      if (score < bestScore) { bestScore = score; best = e; }
    }
    if (best) return best;
    for (const u of this.enemyUnits) return u;
    return null;
  }

  manageDefense() {
    const g = this.game;
    // anything attacking near our base pulls the home guard
    const threats = this.enemyUnits.filter((e) =>
      Math.hypot(e.x - this.homeX, e.y - this.homeY) < 22);
    if (!threats.length) return;
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
    for (const id of TECH_PRIORITY) {
      if (!this.p.isTechAvailable(id)) continue;
      const t = TECHS[id];
      const cost = this.p.mods.techCost(t);
      if (!this.p.canAfford(cost)) continue;
      // keep a food buffer so research never starves villager production,
      // but never block techs that cost no food at all (Loom, Bloodlines...)
      if (cost.food > 0 && this.p.res.food < cost.food + 150) continue;
      const b = this.buildingsOf(t.building).find((x) => x.queue.length === 0);
      if (b && this.game.queueTech(b, id)) return;
    }
    // unit line upgrades
    const upgrades = ['upManAtArms', 'upPikeman', 'upCrossbowman', 'upEliteSkirmisher', 'upLightCavalry',
      'upLongSwordsman', 'upCavalier', 'upArbalester', 'upHalberdier', 'upTwoHandedSwordsman',
      'upChampion', 'upPaladin', 'upHussar', 'upHeavyCamelRider', 'upEliteEagleWarrior',
      'upHeavyCavalryArcher', 'upCappedRam', 'upOnager', 'elite_' + this.p.civId];
    for (const id of upgrades) {
      if (!TECHS[id] || !this.p.isTechAvailable(id)) continue;
      const cost = this.p.mods.techCost(TECHS[id]);
      if (!this.p.canAfford(cost)) continue;
      const b = this.buildingsOf(TECHS[id].building).find((x) => x.queue.length === 0);
      if (b && this.game.queueTech(b, id)) return;
    }
  }

  /* ---------------- placement ---------------- */

  tryBuild(bId) {
    return this.tryBuildAt(bId, this.homeX, this.homeY, 3, 14);
  }

  tryBuildAt(bId, cx, cy, minR, maxR) {
    const g = this.game;
    if (!this.p.isBuildingAvailable(bId)) return false;
    const def = this.p.mods.building(bId);
    if (!this.p.canAfford(def.cost)) return false;
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
    pool.sort((a, b) => Math.hypot(a.x - tx, a.y - ty) - Math.hypot(b.x - tx, b.y - ty));
    return pool.slice(0, n);
  }
}
