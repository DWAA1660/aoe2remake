// Per-player state: resources, population, age, researched techs, fog of war.

import { ModifierSet } from './modifiers.js';
import { getCiv } from '../data/civs.js';
import { TECHS, upgradeTechFor } from '../data/techs.js';
import { BUILDINGS } from '../data/buildings.js';

export const AGES = ['dark', 'feudal', 'castle', 'imperial'];
export const AGE_NAMES = { dark: 'Dark Age', feudal: 'Feudal Age', castle: 'Castle Age', imperial: 'Imperial Age' };

export class Player {
  constructor(index, opts) {
    this.index = index;
    this.name = opts.name || `Player ${index + 1}`;
    this.civId = opts.civ;
    this.civ = getCiv(opts.civ);
    this.color = opts.color || this.civ.color;
    this.team = opts.team ?? index;
    this.isHuman = !!opts.isHuman;
    this.defeated = false;

    this.res = { food: 200, wood: 200, gold: 100, stone: 200 };
    this.pop = 0;
    this.popCap = 5;
    this.popMax = opts.popMax ?? 200;

    this.age = 'dark';
    this.ageIndex = 0;
    this.mods = new ModifierSet();
    this.researched = new Set();
    this.researching = new Set();
    this.relics = 0;

    this.stats = { villagersLost: 0, unitsKilled: 0, unitsLost: 0, resourcesGathered: 0, buildingsLost: 0 };

    // Fog of war: 0 = unexplored, 1 = explored (shroud), 2 = visible
    this.fog = null;
    this.visCount = null;

    this.disabledUnits = new Set(this.civ.disabled.units);
    this.disabledTechs = new Set(this.civ.disabled.techs);
    this.disabledBuildings = new Set(this.civ.disabled.buildings);

    // Civ bonuses + team bonus are permanent effects
    for (const b of this.civ.bonuses) this.mods.add(b.effects);
    if (this.civ.team) this.mods.add(this.civ.team.effects);
    for (const r in this.mods.startResources) this.res[r] += this.mods.startResources[r];

    // Exhausted farms are re-sown automatically while wood allows, so farmers
    // are not left idle. Toggleable from a selected Farm's command card.
    this.autoReseed = true;

    this.notifications = [];
  }

  initFog(size) {
    this.fog = new Uint8Array(size * size);
    this.visCount = new Uint16Array(size * size);
    this.mapSize = size;
  }

  canSee(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= this.mapSize || ty >= this.mapSize) return false;
    return this.fog[ty * this.mapSize + tx] === 2;
  }
  hasExplored(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= this.mapSize || ty >= this.mapSize) return false;
    return this.fog[ty * this.mapSize + tx] > 0;
  }

  /* ---------------- resources ---------------- */

  canAfford(cost) {
    return (this.res.food >= (cost.food || 0) && this.res.wood >= (cost.wood || 0) &&
      this.res.gold >= (cost.gold || 0) && this.res.stone >= (cost.stone || 0));
  }
  spend(cost) {
    this.res.food -= cost.food || 0;
    this.res.wood -= cost.wood || 0;
    this.res.gold -= cost.gold || 0;
    this.res.stone -= cost.stone || 0;
  }
  refund(cost, ratio = 1) {
    this.res.food += (cost.food || 0) * ratio;
    this.res.wood += (cost.wood || 0) * ratio;
    this.res.gold += (cost.gold || 0) * ratio;
    this.res.stone += (cost.stone || 0) * ratio;
  }
  give(res, amount) {
    this.res[res] += amount;
    this.stats.resourcesGathered += amount;
  }

  get effectivePopCap() {
    // "Need no Houses" has to mean "already at the population limit". While
    // Houses were the only source of population it instead meant Huns were
    // pinned at their starting cap of 10 for the whole game - they could never
    // reach 11 pop, let alone boom.
    if (this.mods.flags.has('noHouses')) return this.popMax;
    return Math.min(this.popMax, this.popCap + this.mods.popCapAdd);
  }

  /* ---------------- tech / age ---------------- */

  hasTech(id) { return this.researched.has(id); }

  isUnitAvailable(unitId) {
    if (this.disabledUnits.has(unitId)) return false;
    const u = this.mods.unit(unitId);
    // A unit that only exists as the result of an upgrade cannot be trained
    // until that upgrade is researched. Reaching the Imperial Age used to make
    // Champions, Paladins and Hussars trainable outright, so the whole
    // upgrade line was decoration - you simply trained the best one.
    const via = upgradeTechFor(unitId);
    if (via && !this.researched.has(via)) return false;
    if (u.unique) {
      // only this civ's own unique unit line is trainable
      return unitId === this.civ.uu || unitId === this.civ.uuElite;
    }
    if (AGES.indexOf(u.age) > this.ageIndex) return false;
    // a unit that has been upgraded away is no longer trainable
    if (this.mods.unitUpgrades.has(unitId)) return false;
    if (u.classes.includes('gunpowder') && !this.mods.flags.has('chemistry')) return false;
    return true;
  }

  isBuildingAvailable(bId) {
    if (this.disabledBuildings.has(bId)) return false;
    const b = BUILDINGS[bId];
    if (!b) return false;
    if (b.unique && b.unique !== this.civId) return false;
    if (bId === 'bombardTower' && !this.mods.unlockedBuildings.has('bombardTower')) return false;
    const ageOverride = this.mods.buildingAgeOverride.get(bId);
    const reqAge = ageOverride || b.age;
    if (AGES.indexOf(reqAge) > this.ageIndex) return false;
    if (this.mods.buildingUpgrades.has(bId)) return false;
    if (bId === 'house' && this.mods.flags.has('noHouses')) return false;
    return true;
  }

  isTechAvailable(techId) {
    if (this.researched.has(techId) || this.researching.has(techId)) return false;
    if (this.disabledTechs.has(techId)) return false;
    const t = TECHS[techId];
    if (!t) return false;
    const reqAge = this.mods.techAgeOverride.get(techId) || t.age;
    if (AGES.indexOf(reqAge) > this.ageIndex) return false;
    for (const r of t.requires) if (!this.researched.has(r)) return false;
    // unique techs belong to their civ's castle
    if (this.civ.ut1 && techId === this.civ.ut1.id) return true;
    if (this.civ.ut2 && techId === this.civ.ut2.id) return true;
    if (techId.startsWith('elite_')) return techId === 'elite_' + this.civId;
    for (const civTechPrefix of ['elite_']) {
      if (techId.startsWith(civTechPrefix)) return false;
    }
    if (isForeignUniqueTech(techId, this.civId)) return false;
    // unit upgrade techs require the base unit to be available to this civ
    const upg = t.effects.find((e) => e.k === 'unitUpgrade');
    if (upg && (this.disabledUnits.has(upg.to) || this.disabledUnits.has(upg.from))) return false;
    return true;
  }

  completeTech(techId) {
    const t = TECHS[techId];
    this.researched.add(techId);
    this.researching.delete(techId);
    this.mods.add(t.effects);
    for (const e of t.effects) {
      if (e.k === 'age') this.advanceAge(e.to);
    }
    this.notify(`${t.name} researched`);
  }

  advanceAge(age) {
    this.age = age;
    this.ageIndex = AGES.indexOf(age);
    this.notify(`Advanced to the ${AGE_NAMES[age]}`);
    if (this.mods.flags.has('ageBonusResources')) { this.res.food += 100; this.res.gold += 100; }
    if (this.mods.flags.has('ageWood')) this.res.wood += 50;
  }

  notify(text) {
    this.notifications.push({ text, t: 0 });
    if (this.notifications.length > 6) this.notifications.shift();
  }
}

// Every civ's two unique techs are registered globally; make sure a civ can only
// research its own.
let FOREIGN_UT = null;
function isForeignUniqueTech(techId, civId) {
  if (!FOREIGN_UT) {
    FOREIGN_UT = new Map();
    // lazily built from the civ table
    const { CIVILIZATIONS } = globalThis.__CIVS__ || {};
    if (CIVILIZATIONS) {
      for (const id in CIVILIZATIONS) {
        const c = CIVILIZATIONS[id];
        if (c.ut1) FOREIGN_UT.set(c.ut1.id, id);
        if (c.ut2) FOREIGN_UT.set(c.ut2.id, id);
      }
    }
  }
  const owner = FOREIGN_UT.get(techId);
  return owner !== undefined && owner !== civId;
}

// Registered by game.js at boot so the helper above can see the table without a
// circular import.
export function registerCivTable(table) {
  globalThis.__CIVS__ = { CIVILIZATIONS: table };
  FOREIGN_UT = null;
}
