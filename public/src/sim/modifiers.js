// Resolves the declarative effect lists from data/techs.js + data/civs.js into
// concrete per-player stat tables.
//
// A player accumulates effects (civ bonuses at game start, techs as they finish).
// Any change bumps `version`, which invalidates the memoised stat cache. Stats
// are computed as  (base + sum(add)) * product(mult)  with `set` overriding.

import { UNITS } from '../data/units.js';
import { BUILDINGS } from '../data/buildings.js';

const STAT_ALIASES = { 'atk.building': 'atk.building', 'atk.standardBuilding': 'atk.building' };

function matches(sel, def) {
  if (!sel) return false;
  if (sel.all) return true;
  if (sel.ids && sel.ids.includes(def.id)) return true;
  if (sel.cats && sel.cats.includes(def.cat)) return true;
  if (sel.classes && def.classes && def.classes.some((c) => sel.classes.includes(c))) return true;
  return false;
}

function deepClone(o) {
  const out = {};
  for (const k in o) {
    const v = o[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...v } : v;
  }
  return out;
}

function getPath(obj, path) {
  const i = path.indexOf('.');
  if (i < 0) return obj[path];
  const head = path.slice(0, i), tail = path.slice(i + 1);
  return obj[head] ? obj[head][tail] : undefined;
}
function setPath(obj, path, value) {
  const i = path.indexOf('.');
  if (i < 0) { obj[path] = value; return; }
  const head = path.slice(0, i), tail = path.slice(i + 1);
  if (!obj[head]) obj[head] = {};
  obj[head][tail] = value;
}

export class ModifierSet {
  constructor() {
    this.effects = [];
    this.version = 0;
    this._unitCache = new Map();
    this._buildingCache = new Map();

    this.flags = new Set();
    this.gather = { food: 1, wood: 1, gold: 1, stone: 1, farm: 1, sheep: 1, berries: 1, hunt: 1, fish: 1 };
    this.carryAdd = 0;
    this.carryMult = 1;
    /**
     * Carry bonuses that stack against the *base* rather than against each
     * other, which is how Wheelbarrow and Hand Cart work in the original.
     * Multiplying them gave +87.5% where the game gives +77%, so a fully
     * upgraded economy hauled about six percent more per trip than it should.
     */
    this.carryPct = 0;
    this.farmFoodAdd = 0;
    this.buildRateMult = 1;
    this.trainSpeedMult = 1;
    this.researchSpeedMult = 1;
    this.ageSpeedMult = 1;
    this.popCapAdd = 0;
    this.marketFee = 0.3;
    this.relicRate = 1;
    this.tradeRate = 1;
    this.resourceAmountMult = 1;
    this.monkRechargeMult = 1;

    this.unitUpgrades = new Map();      // from -> to (militia -> manAtArms)
    this.buildingUpgrades = new Map();
    this.freeTechs = new Set();
    this.unlockedBuildings = new Set();
    this.techAgeOverride = new Map();
    this.buildingAgeOverride = new Map();
    this.extraTrainers = [];            // { unit, building }
    this.startResources = { food: 0, wood: 0, gold: 0, stone: 0 };
    this.startUnits = [];
  }

  add(effects) {
    if (!effects) return;
    for (const e of effects) this._apply(e);
    this.version++;
    this._unitCache.clear();
    this._buildingCache.clear();
  }

  _apply(e) {
    switch (e.k) {
      case 'unitStat':
      case 'buildingStat':
      case 'cost':
      case 'costBuilding':
        this.effects.push(e);
        break;
      case 'flag': this.flags.add(e.name); break;
      case 'gather':
        this.gather[e.res] = (this.gather[e.res] ?? 1) * (e.mult ?? 1);
        if (e.res === 'wood' || e.res === 'gold' || e.res === 'stone') {
          // no-op: handled per resource
        }
        break;
      case 'carry':
        if (e.add) this.carryAdd += e.add;
        if (e.mult) this.carryMult *= e.mult;
        if (e.pct) this.carryPct += e.pct;
        break;
      case 'farmFood': this.farmFoodAdd += e.add || 0; break;
      case 'buildRate': this.buildRateMult *= e.mult ?? 1; break;
      case 'trainSpeed': this.trainSpeedMult *= e.mult ?? 1; break;
      case 'researchSpeed': this.researchSpeedMult *= e.mult ?? 1; break;
      case 'ageSpeed': this.ageSpeedMult *= e.mult ?? 1; break;
      case 'popCap': this.popCapAdd += e.add || 0; break;
      case 'marketFee': this.marketFee = e.set ?? this.marketFee; break;
      case 'relicRate': this.relicRate *= e.mult ?? 1; break;
      case 'tradeRate': this.tradeRate *= e.mult ?? 1; break;
      case 'resourceAmount': this.resourceAmountMult *= e.mult ?? 1; break;
      case 'monkRecharge': this.monkRechargeMult *= e.mult ?? 1; break;
      case 'unitUpgrade': this.unitUpgrades.set(e.from, e.to); break;
      case 'buildingUpgrade': this.buildingUpgrades.set(e.from, e.to); break;
      case 'freeTech': for (const id of e.ids) this.freeTechs.add(id); break;
      case 'unlockBuilding': this.unlockedBuildings.add(e.id); break;
      case 'techAge': this.techAgeOverride.set(e.id, e.age); break;
      case 'buildingAge': this.buildingAgeOverride.set(e.id, e.age); break;
      case 'trainAt': this.extraTrainers.push({ unit: e.unit, building: e.building }); break;
      case 'startResource': this.startResources[e.res] += e.add || 0; break;
      case 'startUnits': this.startUnits.push({ id: e.id, n: e.add || 1 }); break;
      case 'costTech': this.effects.push(e); break;
      case 'age': break; // handled by the player's age-up logic
      default: this.effects.push(e); break;
    }
  }

  /* ---------------- resolved stat tables ---------------- */

  unit(id) {
    let cached = this._unitCache.get(id);
    if (cached) return cached;
    const base = UNITS[id];
    if (!base) throw new Error('unknown unit ' + id);
    const out = deepClone(base);
    this._applyStats(out, 'unitStat', base);
    out.cost = this._applyCost(base, out.cost, 'cost');
    this._unitCache.set(id, out);
    return out;
  }

  building(id) {
    let cached = this._buildingCache.get(id);
    if (cached) return cached;
    const base = BUILDINGS[id];
    if (!base) throw new Error('unknown building ' + id);
    const out = deepClone(base);
    this._applyStats(out, 'buildingStat', base);
    out.cost = this._applyCost(base, out.cost, 'costBuilding');
    this._buildingCache.set(id, out);
    return out;
  }

  _applyStats(out, kind, base) {
    const adds = new Map();
    const mults = new Map();
    const sets = new Map();
    for (const e of this.effects) {
      if (e.k !== kind) continue;
      if (!matches(e.sel, base)) continue;
      const stat = STAT_ALIASES[e.stat] || e.stat;
      if (e.set !== undefined) sets.set(stat, e.set);
      if (e.add !== undefined) adds.set(stat, (adds.get(stat) || 0) + e.add);
      if (e.mult !== undefined) mults.set(stat, (mults.get(stat) || 1) * e.mult);
    }
    const keys = new Set([...adds.keys(), ...mults.keys(), ...sets.keys()]);
    for (const stat of keys) {
      if (sets.has(stat)) { setPath(out, stat, sets.get(stat)); continue; }
      let v = getPath(out, stat);
      if (v === undefined) v = 0;
      v = (v + (adds.get(stat) || 0)) * (mults.get(stat) || 1);
      // integer stats stay integral so the UI reads cleanly
      if (stat.startsWith('atk.') || stat.startsWith('armor.') || stat === 'hp' ||
          stat === 'range' || stat === 'los' || stat === 'garrison' ||
          stat === 'baseArrows' || stat === 'pop' || stat === 'volley') {
        v = Math.round(v);
      }
      setPath(out, stat, v);
    }
  }

  _applyCost(base, cost, kind) {
    const out = { ...cost };
    for (const e of this.effects) {
      if (e.k !== kind) continue;
      if (!matches(e.sel, base)) continue;
      const resList = e.res === 'all' ? ['food', 'wood', 'gold', 'stone'] : [e.res];
      for (const r of resList) {
        if (!out[r]) continue;
        if (e.mult !== undefined) out[r] = Math.round(out[r] * e.mult);
        if (e.add !== undefined) out[r] = Math.max(0, out[r] + e.add);
      }
    }
    return out;
  }

  techCost(tech) {
    const out = { ...tech.cost };
    for (const e of this.effects) {
      if (e.k !== 'costTech') continue;
      if (!e.all && !(e.ids && e.ids.includes(tech.id))) continue;
      const resList = e.res === 'all' ? ['food', 'wood', 'gold', 'stone'] : [e.res];
      for (const r of resList) {
        if (!out[r]) continue;
        if (e.mult !== undefined) out[r] = Math.round(out[r] * e.mult);
        if (e.add !== undefined) out[r] = Math.max(0, out[r] + e.add);
      }
    }
    if (this.freeTechs.has(tech.id)) return { food: 0, wood: 0, gold: 0, stone: 0 };
    if (this.flags.has('freeBlacksmithGold') && tech.building === 'blacksmith') out.gold = 0;
    if (this.flags.has('cheapBlacksmith') && tech.building === 'blacksmith') out.food = Math.round(out.food * 0.5);
    if (this.flags.has('freeMonasteryTechs') && tech.building === 'monastery') {
      return { food: 0, wood: 0, gold: 0, stone: 0 };
    }
    return out;
  }
}
