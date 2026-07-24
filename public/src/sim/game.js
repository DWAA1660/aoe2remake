// The simulation. Fixed-step, deterministic given a seed and the same commands.

import { RNG } from '../core/rng.js';
import { SpatialGrid } from '../core/grid.js';
import { generateMap, TERRAIN } from './map.js';
import { Player, AGES, registerCivTable } from './player.js';
import { makeUnit, makeBuilding, makeResource, makeProjectile, resetIds, RESOURCE_INFO } from './entity.js';
import { resolveDamage, areaDamage } from './combat.js';
import { UNITS } from '../data/units.js';
import { BUILDINGS } from '../data/buildings.js';
import { TECHS } from '../data/techs.js';
import { CIVILIZATIONS } from '../data/civs.js';

registerCivTable(CIVILIZATIONS);

export const TICK = 1 / 20;          // 20 Hz simulation
const PATH_BUDGET = 14;              // A* searches allowed per tick
const FOG_INTERVAL = 4;              // ticks between fog recomputes
const CARRY_BASE = 10;

export class Game {
  constructor(config) {
    this.config = config;
    this.rng = new RNG(config.seed ^ 0x5f3759df);
    this.time = 0;
    this.tickCount = 0;
    this.speed = config.speed ?? 1.7;
    this.revealAll = !!config.revealAll;
    this.over = false;
    this.winner = null;

    resetIds();

    const map = generateMap({
      size: config.mapSize ?? 120,
      seed: config.seed ?? 1,
      players: config.players.length,
      waterAmount: config.waterAmount ?? 0.5,
    });
    this.map = map;
    this.size = map.size;
    this.grid = map.grid;
    this.tiles = map.tiles;

    this.entities = [];
    this.byId = new Map();
    this.entityGrid = new SpatialGrid(this.size, this.size, 4);
    this.projectiles = [];
    this.effects = [];              // transient visual events consumed by the renderer
    this.pathQueue = [];

    this.players = config.players.map((p, i) => {
      const pl = new Player(i, p);
      pl.initFog(this.size);
      return pl;
    });

    this._spawnMapResources();
    this._spawnStartingTowns();
    this._recomputeFog();
  }

  /* ================================================================
   *  Setup
   * ================================================================ */

  _spawnMapResources() {
    for (const r of this.map.resources) {
      if (r.type === 'sheep' || r.type === 'deer' || r.type === 'boar' || r.type === 'wolf') {
        const def = UNITS[r.type === 'sheep' ? 'sheep' : r.type];
        const u = makeUnit(def, -1, r.x, r.y);
        u.wanderT = this.rng.range(0, 5);
        u.homeX = r.x; u.homeY = r.y;
        this.addEntity(u);
      } else if (r.type === 'relic') {
        const e = makeResource('relic', r.x, r.y, 0, r.tx, r.ty);
        this.addEntity(e);
      } else {
        const amt = Math.round((r.amount ?? RESOURCE_INFO[r.type].amount));
        const e = makeResource(r.type, r.x, r.y, amt, r.tx, r.ty);
        e.variant = (this.rng.next() * 4) | 0;
        this.addEntity(e);
      }
    }
  }

  _spawnStartingTowns() {
    this.players.forEach((pl, i) => {
      const s = this.map.starts[i];
      const tcDef = pl.mods.building('townCenter');
      const tx = s.x - 2, ty = s.y - 2;
      const tc = this.placeBuilding('townCenter', i, tx, ty, true);
      if (tc) tc.rally = { x: s.x + 3, y: s.y + 3 };

      let villagers = 3;
      for (const su of pl.mods.startUnits) if (su.id === 'villager') villagers += su.n;
      for (let v = 0; v < villagers; v++) {
        const a = (v / villagers) * Math.PI * 2;
        this.spawnUnit('villager', i, s.x + Math.cos(a) * 3.2, s.y + Math.sin(a) * 3.2);
      }
      this.spawnUnit('scoutCavalry', i, s.x + 4, s.y - 4);
      // resolve Chinese-style resource offsets that were negative
      for (const r in pl.res) pl.res[r] = Math.max(0, pl.res[r]);
      void tcDef;
    });
  }

  /* ================================================================
   *  Entity plumbing
   * ================================================================ */

  addEntity(e) {
    this.entities.push(e);
    this.byId.set(e.id, e);
    if (e.kind === 'unit' && e.owner >= 0) {
      this.players[e.owner].pop += e.def.pop;
    }
    if (e.kind === 'building' && e.owner >= 0 && e.complete) this._applyBuildingPop(e, +1);
    return e;
  }

  _applyBuildingPop(b, sign) {
    const pl = this.players[b.owner];
    if (!pl) return;
    const pop = b.def.pop || 0;
    if (pop) pl.popCap = Math.max(0, pl.popCap + sign * pop);
  }

  get(id) { const e = this.byId.get(id); return e && e.alive ? e : null; }

  spawnUnit(unitId, owner, x, y) {
    const pl = this.players[owner];
    const def = pl ? pl.mods.unit(unitId) : UNITS[unitId];
    const open = this.grid.nearestOpen(x, y, def.domain, 8) || { x, y };
    const u = makeUnit(def, owner, open.x, open.y);
    if (def.dodges) u.dodgeCharges = def.dodges;
    this.addEntity(u);
    return u;
  }

  canPlaceBuilding(bId, owner, tx, ty) {
    const pl = this.players[owner];
    const def = pl.mods.building(bId);
    const size = def.size;
    if (tx < 0 || ty < 0 || tx + size > this.size || ty + size > this.size) return false;
    const wantsWater = !!def.water;
    let waterAdjacent = false;
    for (let y = ty; y < ty + size; y++) {
      for (let x = tx; x < tx + size; x++) {
        const i = y * this.size + x;
        if (this.grid.blocked[i]) return false;
        if (this.grid.water[i]) return false;
        if (!pl.hasExplored(x, y) && !this.revealAll) return false;
      }
    }
    if (wantsWater) {
      for (let y = ty - 1; y <= ty + size && !waterAdjacent; y++) {
        for (let x = tx - 1; x <= tx + size; x++) {
          if (x < 0 || y < 0 || x >= this.size || y >= this.size) continue;
          if (this.grid.water[y * this.size + x]) { waterAdjacent = true; break; }
        }
      }
      if (!waterAdjacent) return false;
    }
    // no overlapping other entities
    let clear = true;
    this.entityGrid.forEachNear(tx + size / 2, ty + size / 2, size + 1, (e) => {
      if (!clear || !e.alive) return;
      if (e.kind === 'building') {
        if (tx < e.tx + e.size && tx + size > e.tx && ty < e.ty + e.size && ty + size > e.ty) clear = false;
      } else if (e.kind === 'resource' && RESOURCE_INFO[e.type]?.blocks) {
        if (e.tx >= tx && e.tx < tx + size && e.ty >= ty && e.ty < ty + size) clear = false;
      }
    });
    return clear;
  }

  placeBuilding(bId, owner, tx, ty, complete = false) {
    const pl = this.players[owner];
    const def = pl.mods.building(bId);
    const b = makeBuilding(def, owner, tx, ty, complete);
    if (!def.gate && !def.farmFood) this.grid.setBlocked(tx, ty, def.size, true);
    if (def.wall) this.grid.setBlocked(tx, ty, def.size, true);
    this.addEntity(b);
    if (complete) b.hp = def.hp;
    return b;
  }

  kill(e, killer) {
    if (!e.alive) return;
    e.alive = false;
    if (e.kind === 'unit') {
      const pl = this.players[e.owner];
      if (pl) {
        pl.pop -= e.def.pop;
        pl.stats.unitsLost++;
        if (e.type === 'villager') pl.stats.villagersLost++;
      }
      if (killer && this.players[killer.owner]) this.players[killer.owner].stats.unitsKilled++;
      // huntable animals leave a food carcass
      if (e.def.huntable) {
        const c = makeResource('carcass', e.x, e.y, e.def.food || 100);
        c.variant = e.type === 'boar' ? 2 : e.type === 'deer' ? 1 : 0;
        this.addEntity(c);
      }
      // ungarrison anything it was carrying
      this.effects.push({ type: 'death', x: e.x, y: e.y, t: 0, unit: e.type });
    } else if (e.kind === 'building') {
      const pl = this.players[e.owner];
      if (pl) {
        if (e.complete) this._applyBuildingPop(e, -1);
        pl.stats.buildingsLost++;
      }
      if (!e.def.gate && !e.def.farmFood) this.grid.setBlocked(e.tx, e.ty, e.size, false);
      for (const g of e.garrison) {
        // garrisoned units die with the building except in Town Centers/Castles
        if (e.type === 'townCenter' || e.type === 'castle') this._ungarrisonOne(e, g);
      }
      e.garrison.length = 0;
      this.effects.push({ type: 'collapse', x: e.x, y: e.y, size: e.size, t: 0 });
      // returning relics
      if (e.relics && pl) pl.relics -= e.relics;
    } else if (e.kind === 'resource') {
      if (RESOURCE_INFO[e.type]?.blocks) this.grid.blocked[e.ty * this.size + e.tx] = 0;
    }
  }

  isAlly(a, b) {
    if (a === b) return true;
    if (a < 0 || b < 0) return false;
    return this.players[a].team === this.players[b].team;
  }
  isEnemy(a, b) {
    if (a < 0 || b < 0) return false;
    return !this.isAlly(a, b);
  }

  elevationAt(x, y) {
    const tx = x | 0, ty = y | 0;
    if (tx < 0 || ty < 0 || tx >= this.size || ty >= this.size) return 0;
    return this.grid.elevation[ty * this.size + tx];
  }

  /* ================================================================
   *  Main tick
   * ================================================================ */

  update(dt) {
    if (this.over) return;
    const d = dt * this.speed;
    this.time += d;
    this.tickCount++;

    this._rebuildGrid();
    if (this.tickCount % FOG_INTERVAL === 0) this._recomputeFog();

    this._servicePathQueue();

    for (const p of this.players) {
      for (const n of p.notifications) n.t += d;
      while (p.notifications.length && p.notifications[0].t > 8) p.notifications.shift();
    }

    for (let i = 0; i < this.entities.length; i++) {
      const e = this.entities[i];
      if (!e.alive) continue;
      if (e.kind === 'unit') this._updateUnit(e, d);
      else if (e.kind === 'building') this._updateBuilding(e, d);
    }

    this._updateProjectiles(d);
    this._updateEffects(d);
    this._cleanup();
    this._checkVictory();
  }

  _rebuildGrid() {
    this.entityGrid.clear();
    for (const e of this.entities) {
      if (e.alive && e.kind !== 'projectile') this.entityGrid.insert(e);
    }
  }

  _cleanup() {
    if (this.tickCount % 10 !== 0) return;
    let w = 0;
    for (let i = 0; i < this.entities.length; i++) {
      const e = this.entities[i];
      if (e.alive) this.entities[w++] = e;
      else this.byId.delete(e.id);
    }
    this.entities.length = w;
  }

  /* ---------------- fog of war ---------------- */

  _recomputeFog() {
    const size = this.size;
    for (const pl of this.players) {
      if (this.revealAll || pl.mods.flags.has('spies')) {
        pl.fog.fill(2);
        continue;
      }
      const fog = pl.fog;
      for (let i = 0; i < fog.length; i++) if (fog[i] === 2) fog[i] = 1;
    }
    if (this.revealAll) return;

    for (const e of this.entities) {
      if (!e.alive || e.owner < 0) continue;
      if (e.kind === 'projectile') continue;
      const los = e.kind === 'building' ? (e.def.los || 4) : (e.def.los || 4);
      const teams = this.players.filter((p) => this.isAlly(p.index, e.owner));
      const cx = e.x | 0, cy = e.y | 0;
      const r = Math.ceil(los);
      const r2 = los * los;
      for (let dy = -r; dy <= r; dy++) {
        const y = cy + dy;
        if (y < 0 || y >= size) continue;
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy > r2) continue;
          const x = cx + dx;
          if (x < 0 || x >= size) continue;
          const idx = y * size + x;
          for (const p of teams) p.fog[idx] = 2;
        }
      }
    }
  }

  /* ---------------- pathfinding queue ---------------- */

  requestPath(unit, goal) {
    unit.pendingGoal = goal;
    if (!unit.inPathQueue) {
      unit.inPathQueue = true;
      this.pathQueue.push(unit.id);
    }
  }

  _servicePathQueue() {
    let n = 0;
    while (this.pathQueue.length && n < PATH_BUDGET) {
      const id = this.pathQueue.shift();
      const u = this.get(id);
      if (!u) continue;
      u.inPathQueue = false;
      const goal = u.pendingGoal;
      u.pendingGoal = null;
      if (!goal) continue;
      const path = this.grid.findPath(u.x, u.y, goal, u.def.domain);
      u.path = path && path.length ? path : null;
      u.pathIdx = 0;
      if (!u.path) {
        // fall back to a straight-line nudge so units never freeze outright
        u.path = [{ x: goal.x, y: goal.y }];
        u.pathIdx = 0;
        u.pathFailed = true;
      } else {
        u.pathFailed = false;
      }
      n++;
    }
  }

  /* ================================================================
   *  Units
   * ================================================================ */

  _updateUnit(u, dt) {
    if (u.garrisonedIn) return;
    u.anim += dt;
    if (u.attackCd > 0) u.attackCd -= dt;
    if (u.repathCd > 0) u.repathCd -= dt;
    if (u.def.regen) u.hp = Math.min(u.maxHp, u.hp + u.def.regen * dt);
    if (u.def.charge !== undefined) u.charge = Math.min(1, u.charge + dt / 12);
    if (u.def.converts) {
      const rate = this.players[u.owner]?.mods.monkRechargeMult ?? 1;
      u.faith = Math.min(100, u.faith + (100 / (62 * rate)) * dt);
    }
    if (this.players[u.owner]?.mods.flags.has('regenNearBase')) {
      if (u.task.type === 'idle' && this.tickCount % 20 === 0) {
        const near = this.entityGrid.nearest(u.x, u.y, 8, (e) => e.kind === 'building' && e.owner === u.owner &&
          (e.type === 'townCenter' || e.type === 'castle' || e.type === 'monastery'));
        if (near) u.hp = Math.min(u.maxHp, u.hp + 0.5);
      }
    }

    if (u.owner < 0) { this._updateAnimal(u, dt); return; }

    switch (u.task.type) {
      case 'idle': this._taskIdle(u, dt); break;
      case 'move': this._taskMove(u, dt); break;
      case 'attackMove': this._taskAttackMove(u, dt); break;
      case 'attack': this._taskAttack(u, dt); break;
      case 'gather': this._taskGather(u, dt); break;
      case 'deliver': this._taskDeliver(u, dt); break;
      case 'build': this._taskBuild(u, dt); break;
      case 'repair': this._taskRepair(u, dt); break;
      case 'garrison': this._taskGarrison(u, dt); break;
      case 'convert': this._taskConvert(u, dt); break;
      case 'heal': this._taskHeal(u, dt); break;
      case 'trade': this._taskTrade(u, dt); break;
      case 'relic': this._taskRelic(u, dt); break;
      default: u.task = { type: 'idle' };
    }
  }

  _updateAnimal(u, dt) {
    // Gaia wildlife: boars and wolves fight back, everything else wanders.
    if (u.task.type === 'attack') { this._taskAttack(u, dt); return; }
    if (u.task.type === 'move') { this._taskMove(u, dt); return; }
    if (u.def.hostile) {
      const prey = this.entityGrid.nearest(u.x, u.y, u.def.los, (e) =>
        e.kind === 'unit' && e.owner >= 0 && e.def.cat === 'villager');
      if (prey) { u.task = { type: 'attack', targetId: prey.id }; return; }
    }
    u.wanderT = (u.wanderT || 0) - dt;
    if (u.wanderT <= 0) {
      u.wanderT = this.rng.range(4, 10);
      if (u.def.tame) return;   // sheep sit still until owned
      const a = this.rng.range(0, Math.PI * 2);
      const d = this.rng.range(2, 6);
      const gx = Math.max(1, Math.min(this.size - 2, (u.homeX ?? u.x) + Math.cos(a) * d));
      const gy = Math.max(1, Math.min(this.size - 2, (u.homeY ?? u.y) + Math.sin(a) * d));
      this.requestPath(u, { x: gx, y: gy, radius: 1 });
      u.task = { type: 'move', x: gx, y: gy };
    }
  }

  /* ---------------- movement ---------------- */

  _stepMove(u, dt, arriveRadius = 0.25) {
    if (!u.path || u.pathIdx >= u.path.length) return true;
    const wp = u.path[u.pathIdx];
    let dx = wp.x - u.x, dy = wp.y - u.y;
    let dist = Math.hypot(dx, dy);
    if (dist < arriveRadius) {
      u.pathIdx++;
      if (u.pathIdx >= u.path.length) { u.path = null; return true; }
      return false;
    }
    const spd = u.def.speed;
    // steer + local separation so groups do not stack into one point
    let sx = dx / dist, sy = dy / dist;
    let px = 0, py = 0;
    this.entityGrid.forEachNear(u.x, u.y, 1.4, (o) => {
      if (o === u || !o.alive || o.kind !== 'unit' || o.garrisonedIn) return;
      const ox = u.x - o.x, oy = u.y - o.y;
      const d2 = ox * ox + oy * oy;
      const minD = (u.radius + o.radius) * 1.05;
      if (d2 > minD * minD || d2 < 1e-6) return;
      const d = Math.sqrt(d2);
      const push = (minD - d) / minD;
      px += (ox / d) * push;
      py += (oy / d) * push;
    });
    sx += px * 1.6; sy += py * 1.6;
    const len = Math.hypot(sx, sy) || 1;
    sx /= len; sy /= len;

    const nx = u.x + sx * spd * dt;
    const ny = u.y + sy * spd * dt;
    const domain = u.def.domain;
    if (this.grid.isPassable(nx | 0, ny | 0, domain)) {
      u.x = nx; u.y = ny; u.stuck = 0;
    } else if (this.grid.isPassable(nx | 0, u.y | 0, domain)) {
      u.x = nx; u.stuck += dt;
    } else if (this.grid.isPassable(u.x | 0, ny | 0, domain)) {
      u.y = ny; u.stuck += dt;
    } else {
      u.stuck += dt;
    }
    u.facing = Math.atan2(sy, sx);
    u.moving = true;

    if (u.stuck > 0.8 && u.repathCd <= 0) {
      u.stuck = 0;
      u.repathCd = 1.0;
      const last = u.path[u.path.length - 1];
      this.requestPath(u, { x: last.x, y: last.y, radius: 1 });
    }
    return false;
  }

  _distTo(u, target) {
    if (target.kind === 'building') {
      const hx = Math.max(target.tx - u.x, 0, u.x - (target.tx + target.size));
      const hy = Math.max(target.ty - u.y, 0, u.y - (target.ty + target.size));
      return Math.hypot(hx, hy);
    }
    return Math.hypot(target.x - u.x, target.y - u.y) - (target.radius || 0) - u.radius;
  }

  _inRange(u, target, extra = 0) {
    const r = (u.def.range || 0) + extra + 0.35;
    return this._distTo(u, target) <= r;
  }

  _approach(u, target, range, dt) {
    const d = this._distTo(u, target);
    if (d <= range) { u.path = null; u.moving = false; return true; }
    if ((!u.path || u.pathIdx >= u.path.length) && u.repathCd <= 0) {
      u.repathCd = 0.5 + this.rng.next() * 0.4;
      const goalR = target.kind === 'building' ? Math.ceil(target.size / 2 + range) : Math.max(1, Math.floor(range));
      this.requestPath(u, { x: target.x, y: target.y, radius: goalR });
    }
    this._stepMove(u, dt);
    return false;
  }

  /* ---------------- tasks ---------------- */

  _taskIdle(u, dt) {
    u.moving = false;
    if (u.stance === 'noAttack' || !u.def.atk || !Object.keys(u.def.atk).length) return;
    if (u.def.cat === 'villager') return;
    if (this.tickCount % 6 !== u.id % 6) return;
    const range = Math.max(u.def.los, (u.def.range || 0) + 2);
    const target = this._findTarget(u, range);
    if (target) u.task = { type: 'attack', targetId: target.id, auto: true, homeX: u.x, homeY: u.y };
  }

  _findTarget(u, range) {
    let best = null, bestScore = -Infinity;
    this.entityGrid.forEachNear(u.x, u.y, range, (e) => {
      if (!e.alive || !this.isEnemy(u.owner, e.owner)) return;
      if (e.kind === 'resource' || e.kind === 'projectile') return;
      if (e.garrisonedIn) return;
      const d = this._distTo(u, e);
      if (d > range) return;
      // prefer units over buildings, and closer over far
      let score = -d;
      if (e.kind === 'building') score -= 12;
      if (e.kind === 'unit' && e.def.cat === 'villager') score += 2;
      if (e.kind === 'unit' && e.def.cat === 'siege') score += 3;
      if (score > bestScore) { bestScore = score; best = e; }
    });
    return best;
  }

  _taskMove(u, dt) {
    if (!u.path) {
      const dx = u.task.x - u.x, dy = u.task.y - u.y;
      if (Math.hypot(dx, dy) < 0.6) { u.task = { type: 'idle' }; u.moving = false; return; }
      if (u.repathCd <= 0) { u.repathCd = 0.6; this.requestPath(u, { x: u.task.x, y: u.task.y, radius: 0 }); }
      return;
    }
    if (this._stepMove(u, dt)) { u.task = { type: 'idle' }; u.moving = false; }
  }

  _taskAttackMove(u, dt) {
    const t = this._findTarget(u, u.def.los);
    if (t) {
      u.task = { type: 'attack', targetId: t.id, auto: true, resume: { x: u.task.x, y: u.task.y } };
      return;
    }
    if (!u.path) {
      const dx = u.task.x - u.x, dy = u.task.y - u.y;
      if (Math.hypot(dx, dy) < 0.8) { u.task = { type: 'idle' }; return; }
      if (u.repathCd <= 0) { u.repathCd = 0.6; this.requestPath(u, { x: u.task.x, y: u.task.y, radius: 0 }); }
      return;
    }
    if (this._stepMove(u, dt)) u.task = { type: 'idle' };
  }

  _taskAttack(u, dt) {
    const target = this.get(u.task.targetId);
    if (!target || !target.alive || target.garrisonedIn) {
      if (u.task.resume) { u.task = { type: 'attackMove', x: u.task.resume.x, y: u.task.resume.y }; return; }
      u.task = { type: 'idle' };
      return;
    }
    // gaia animals being hunted: villagers use the gather task instead
    const range = u.def.range || 0;
    const minR = u.def.minRange || 0;
    const noMin = this.players[u.owner]?.mods.flags.has('noMinRange');

    if (u.stance === 'standGround' && u.task.auto) {
      if (this._distTo(u, target) > range + 0.4) { u.task = { type: 'idle' }; return; }
    }

    if (!this._inRange(u, target)) {
      // chase, but auto-acquired targets do not chase forever
      if (u.task.auto && u.task.homeX !== undefined) {
        const away = Math.hypot(u.x - u.task.homeX, u.y - u.task.homeY);
        if (away > u.def.los + 6) {
          u.task = { type: 'move', x: u.task.homeX, y: u.task.homeY };
          return;
        }
      }
      this._approach(u, target, Math.max(range - 0.2, 0.15), dt);
      return;
    }

    u.moving = false;
    u.path = null;
    u.facing = Math.atan2(target.y - u.y, target.x - u.x);

    if (!noMin && minR > 0 && this._distTo(u, target) < minR) {
      // back off to reach minimum range
      const ang = Math.atan2(u.y - target.y, u.x - target.x);
      const gx = target.x + Math.cos(ang) * (minR + 1);
      const gy = target.y + Math.sin(ang) * (minR + 1);
      if (u.repathCd <= 0) { u.repathCd = 0.8; this.requestPath(u, { x: gx, y: gy, radius: 1 }); }
      this._stepMove(u, dt);
      return;
    }

    if (u.attackCd > 0) return;
    u.attackCd = u.def.reload;
    this._performAttack(u, target);
  }

  _performAttack(u, target) {
    const pl = this.players[u.owner];
    let attack = { ...u.def.atk };

    // Coustillier / Urumi charge attack
    if (u.def.charge && u.charge >= 1) {
      attack.melee = (attack.melee || 0) + u.def.charge;
      u.charge = 0;
    }

    if (u.def.suicide) {
      areaDamage(this, u, target.x, target.y, u.def.blast || 1, attack, true);
      this.effects.push({ type: 'explosion', x: target.x, y: target.y, r: u.def.blast || 1, t: 0 });
      this.kill(u, null);
      return;
    }

    if (u.def.range > 1) {
      const shots = u.def.volley || 1;
      for (let i = 0; i < shots; i++) {
        const acc = pl?.mods.flags.has('ballistics') ? Math.min(1, u.def.accuracy + 0.25) : u.def.accuracy;
        const miss = this.rng.next() > acc;
        let tx = target.x, ty = target.y;
        if (pl?.mods.flags.has('ballistics') && target.kind === 'unit' && target.moving) {
          const flight = this._distTo(u, target) / (u.def.projectileSpeed || 7);
          tx += Math.cos(target.facing) * target.def.speed * flight;
          ty += Math.sin(target.facing) * target.def.speed * flight;
        }
        if (miss) { tx += this.rng.range(-1.2, 1.2); ty += this.rng.range(-1.2, 1.2); }
        if (shots > 1) { tx += this.rng.range(-0.4, 0.4); ty += this.rng.range(-0.4, 0.4); }
        const dist = Math.hypot(tx - u.x, ty - u.y);
        const p = makeProjectile(u, target, attack, {
          tx, ty, miss,
          duration: Math.max(0.12, dist / (u.def.projectileSpeed || 7)),
          blast: u.def.blast || 0,
          pierceLine: !!u.def.pierceLine,
          style: u.def.classes.includes('gunpowder') ? 'shot' : (u.def.blast ? 'boulder' : 'arrow'),
        });
        this.projectiles.push(p);
      }
      this.effects.push({ type: 'shoot', x: u.x, y: u.y, t: 0 });
    } else {
      resolveDamage(this, u, target, attack);
      if (u.def.trample || u.def.blast) {
        areaDamage(this, u, target.x, target.y, u.def.blast || 0.5,
          { melee: u.def.trample || Math.round((attack.melee || 0) * 0.5) }, false);
      }
      this.effects.push({ type: 'melee', x: (u.x + target.x) / 2, y: (u.y + target.y) / 2, t: 0 });
    }
  }

  /* ---------------- gathering ---------------- */

  _taskGather(u, dt) {
    const res = this.get(u.task.targetId);
    if (!res || !res.alive || (res.kind === 'resource' && res.amount <= 0)) {
      const next = this._findSameResourceNearby(u, u.task.resType);
      if (next) { u.task = { type: 'gather', targetId: next.id, resType: u.task.resType }; return; }
      if (u.carrying && u.carrying.amount > 0) { u.task = { type: 'deliver' }; return; }
      u.task = { type: 'idle' };
      return;
    }

    // hunting an animal: kill it first, then gather the carcass
    if (res.kind === 'unit') {
      if (!this._inRange(u, res, 0.2)) { this._approach(u, res, 0.4, dt); return; }
      u.moving = false;
      if (u.attackCd > 0) return;
      u.attackCd = u.def.reload;
      resolveDamage(this, u, res, u.def.atk);
      this.effects.push({ type: 'melee', x: res.x, y: res.y, t: 0 });
      return;
    }

    const reach = res.type === 'farm' ? 1.4 : 0.9;
    if (this._distTo(u, res) > reach) { this._approach(u, res, reach - 0.2, dt); return; }
    u.moving = false; u.path = null;
    u.facing = Math.atan2(res.y - u.y, res.x - u.x);

    const pl = this.players[u.owner];
    const info = RESOURCE_INFO[res.type];
    const sub = res.sub || info.res;
    const rate = info.gatherRate * (pl.mods.gather[sub] ?? 1) * (pl.mods.gather[info.res] ?? 1);
    const cap = Math.round((CARRY_BASE + pl.mods.carryAdd) * pl.mods.carryMult);

    if (!u.carrying || u.carrying.res !== info.res) u.carrying = { res: info.res, sub, amount: 0 };
    const take = Math.min(rate * dt, res.amount, cap - u.carrying.amount);
    u.carrying.amount += take;
    res.amount -= take;
    u.gathering = true;

    if (res.amount <= 0) {
      res.alive = false;
      if (info.blocks) this.grid.blocked[res.ty * this.size + res.tx] = 0;
    }
    if (u.carrying.amount >= cap - 1e-6) {
      // Khmer farmers deposit instantly
      if (res.type === 'farm' && pl.mods.flags.has('instantFarmDrop')) {
        pl.give('food', u.carrying.amount);
        u.carrying.amount = 0;
      } else {
        u.task = { type: 'deliver', returnTo: res.id, resType: u.task.resType };
      }
    }
  }

  _findSameResourceNearby(u, resType) {
    return this.entityGrid.nearest(u.x, u.y, 14, (e) =>
      e.kind === 'resource' && e.alive && e.amount > 0 && e.resType === resType && e.type !== 'relic');
  }

  _taskDeliver(u, dt) {
    if (!u.carrying || u.carrying.amount <= 0) { u.task = { type: 'idle' }; return; }
    let site = this.get(u.task.siteId);
    if (!site || !site.alive || !site.complete) {
      site = this._findDropSite(u, u.carrying.res);
      if (!site) { u.task = { type: 'idle' }; return; }
      u.task = { ...u.task, siteId: site.id };
    }
    if (this._distTo(u, site) > 0.6) { this._approach(u, site, 0.5, dt); return; }
    u.moving = false;
    const pl = this.players[u.owner];
    pl.give(u.carrying.res, u.carrying.amount);
    // Poles: stone mining also yields gold; Burgundian farms yield gold
    if (u.carrying.res === 'stone' && pl.mods.flags.has('stoneGold')) pl.give('gold', u.carrying.amount * 0.35);
    if (u.carrying.sub === 'farm' && pl.mods.flags.has('farmGold')) pl.give('gold', u.carrying.amount * 0.25);
    u.carrying.amount = 0;
    const back = this.get(u.task.returnTo);
    if (back && back.alive && back.amount > 0) {
      u.task = { type: 'gather', targetId: back.id, resType: u.task.resType };
    } else {
      const next = this._findSameResourceNearby(u, u.task.resType);
      u.task = next ? { type: 'gather', targetId: next.id, resType: u.task.resType } : { type: 'idle' };
    }
  }

  _findDropSite(u, res) {
    let best = null, bestD = Infinity;
    for (const e of this.entities) {
      if (!e.alive || e.kind !== 'building' || e.owner !== u.owner || !e.complete) continue;
      if (!e.def.dropSite || !e.def.dropSite.includes(res)) continue;
      const d = this._distTo(u, e);
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  /* ---------------- building & repair ---------------- */

  _taskBuild(u, dt) {
    const b = this.get(u.task.targetId);
    if (!b || !b.alive || b.complete) {
      // chain to the next foundation nearby, matching AoE2 villager behaviour
      const next = this.entityGrid.nearest(u.x, u.y, 8, (e) =>
        e.kind === 'building' && e.owner === u.owner && !e.complete);
      u.task = next ? { type: 'build', targetId: next.id } : { type: 'idle' };
      return;
    }
    if (this._distTo(u, b) > 0.7) { this._approach(u, b, 0.6, dt); return; }
    u.moving = false; u.path = null;
    b.buildersThisTick++;
    u.building = true;
  }

  _taskRepair(u, dt) {
    const b = this.get(u.task.targetId);
    if (!b || !b.alive || b.hp >= b.maxHp) { u.task = { type: 'idle' }; return; }
    if (this._distTo(u, b) > 0.7) { this._approach(u, b, 0.6, dt); return; }
    u.moving = false;
    const pl = this.players[u.owner];
    const rate = (b.maxHp / (b.def.time * 2)) * dt;
    // repair costs half the build cost, pro-rata
    const frac = rate / b.maxHp;
    const cost = {
      food: (b.def.cost.food || 0) * frac * 0.5, wood: (b.def.cost.wood || 0) * frac * 0.5,
      gold: (b.def.cost.gold || 0) * frac * 0.5, stone: (b.def.cost.stone || 0) * frac * 0.5,
    };
    if (!pl.canAfford(cost)) return;
    pl.spend(cost);
    b.hp = Math.min(b.maxHp, b.hp + rate);
    u.repairing = true;
  }

  /* ---------------- garrison / monks / trade ---------------- */

  _taskGarrison(u, dt) {
    const b = this.get(u.task.targetId);
    if (!b || !b.alive || !b.complete) { u.task = { type: 'idle' }; return; }
    const cap = b.def.garrison || 0;
    if (b.garrison.length >= cap) { u.task = { type: 'idle' }; return; }
    if (this._distTo(u, b) > 0.6) { this._approach(u, b, 0.5, dt); return; }
    u.garrisonedIn = b.id;
    u.moving = false;
    u.task = { type: 'idle' };
    b.garrison.push(u.id);
    const pl = this.players[u.owner];
    if (u.carrying && u.carrying.amount > 0 && b.def.dropSite?.includes(u.carrying.res)) {
      pl.give(u.carrying.res, u.carrying.amount);
      u.carrying.amount = 0;
    }
  }

  _ungarrisonOne(b, unitId) {
    const u = this.get(unitId);
    if (!u) return;
    u.garrisonedIn = 0;
    const a = this.rng.range(0, Math.PI * 2);
    const spot = this.grid.nearestOpen(b.x + Math.cos(a) * (b.size / 2 + 0.8),
      b.y + Math.sin(a) * (b.size / 2 + 0.8), u.def.domain, 6);
    if (spot) { u.x = spot.x; u.y = spot.y; }
    u.task = { type: 'idle' };
  }

  ungarrisonAll(b) {
    for (const id of [...b.garrison]) this._ungarrisonOne(b, id);
    b.garrison.length = 0;
  }

  _taskConvert(u, dt) {
    const t = this.get(u.task.targetId);
    const pl = this.players[u.owner];
    if (!t || !t.alive || !this.isEnemy(u.owner, t.owner)) { u.task = { type: 'idle' }; u.convertProgress = 0; return; }
    const canBuilding = pl.mods.flags.has('redemption');
    if (t.kind === 'building' && !canBuilding) { u.task = { type: 'idle' }; return; }
    if (t.def.converts && !pl.mods.flags.has('atonement')) { u.task = { type: 'idle' }; return; }
    if (u.faith < 100) { u.task = { type: 'idle' }; return; }
    if (!this._inRange(u, t)) { this._approach(u, t, u.def.range - 0.5, dt); u.convertProgress = 0; return; }
    u.moving = false;
    const defPl = this.players[t.owner];
    let rate = dt;
    if (defPl?.mods.flags.has('faith')) rate *= 0.5;
    if (defPl?.mods.flags.has('heresy')) rate *= 1;
    if (t.def.classes?.includes('elephant') && defPl?.mods.flags.has('elephantFaith')) rate *= 0.6;
    u.convertProgress += rate / (u.def.reload / 15);
    this.effects.push({ type: 'convert', x: t.x, y: t.y, t: 0 });
    if (u.convertProgress >= 4 && this.rng.next() < 0.09) {
      u.convertProgress = 0;
      u.faith = 0;
      if (defPl?.mods.flags.has('heresy')) { this.kill(t, u); }
      else this.convertEntity(t, u.owner);
      u.task = { type: 'idle' };
    }
  }

  convertEntity(t, newOwner) {
    const oldPl = this.players[t.owner];
    const newPl = this.players[newOwner];
    if (t.kind === 'unit') {
      if (oldPl) oldPl.pop -= t.def.pop;
      t.owner = newOwner;
      t.def = newPl.mods.unit(t.type);
      newPl.pop += t.def.pop;
      t.task = { type: 'idle' };
      t.path = null;
    } else if (t.kind === 'building') {
      if (oldPl && t.complete) this._applyBuildingPop(t, -1);
      t.owner = newOwner;
      t.def = newPl.mods.building(t.type);
      if (t.complete) this._applyBuildingPop(t, +1);
      t.queue.length = 0;
    }
    this.effects.push({ type: 'converted', x: t.x, y: t.y, t: 0 });
  }

  _taskHeal(u, dt) {
    const t = this.get(u.task.targetId);
    if (!t || !t.alive || t.hp >= t.maxHp || !this.isAlly(u.owner, t.owner)) { u.task = { type: 'idle' }; return; }
    const range = (u.def.healRange || u.def.range) * (this.players[u.owner].mods.unit('monk').healRange ? 1 : 1);
    if (this._distTo(u, t) > range) { this._approach(u, t, range - 0.5, dt); return; }
    u.moving = false;
    t.hp = Math.min(t.maxHp, t.hp + (u.def.healRate || 12) * dt / 4);
    this.effects.push({ type: 'heal', x: t.x, y: t.y, t: 0 });
  }

  _taskTrade(u, dt) {
    const market = this.get(u.task.marketId);
    const home = this.get(u.task.homeId);
    if (!market || !market.alive || !home || !home.alive) { u.task = { type: 'idle' }; return; }
    const dest = u.task.outbound ? market : home;
    if (this._distTo(u, dest) > 0.8) { this._approach(u, dest, 0.7, dt); return; }
    if (!u.task.outbound) {
      const pl = this.players[u.owner];
      const dist = Math.hypot(market.x - home.x, market.y - home.y);
      const gold = Math.max(3, dist * 0.35) * pl.mods.tradeRate;
      pl.give('gold', gold);
      if (pl.mods.flags.has('tradeFood')) pl.give('food', gold * 0.1);
    }
    u.task = { ...u.task, outbound: !u.task.outbound };
    u.path = null;
  }

  _taskRelic(u, dt) {
    const relic = this.get(u.task.targetId);
    if (u.carryingRelic) {
      const mon = this.get(u.task.monasteryId) || this.entityGrid.nearest(u.x, u.y, 60,
        (e) => e.kind === 'building' && e.owner === u.owner && e.type === 'monastery' && e.complete);
      if (!mon) { u.task = { type: 'idle' }; return; }
      if (this._distTo(u, mon) > 0.7) { this._approach(u, mon, 0.6, dt); return; }
      u.carryingRelic = false;
      mon.relics = (mon.relics || 0) + 1;
      this.players[u.owner].relics++;
      u.task = { type: 'idle' };
      return;
    }
    if (!relic || !relic.alive) { u.task = { type: 'idle' }; return; }
    if (this._distTo(u, relic) > 0.7) { this._approach(u, relic, 0.6, dt); return; }
    relic.alive = false;
    u.carryingRelic = true;
    const mon = this.entityGrid.nearest(u.x, u.y, 60,
      (e) => e.kind === 'building' && e.owner === u.owner && e.type === 'monastery' && e.complete);
    u.task = { type: 'relic', monasteryId: mon ? mon.id : 0 };
  }

  /* ================================================================
   *  Buildings
   * ================================================================ */

  _updateBuilding(b, dt) {
    const pl = this.players[b.owner];
    if (!pl) return;

    if (!b.complete) {
      if (b.buildersThisTick > 0) {
        const n = b.buildersThisTick;
        const effective = Math.pow(n, 0.75) * pl.mods.buildRateMult;
        b.buildProgress += effective * dt;
        b.hp = Math.min(b.maxHp, b.maxHp * (0.05 + 0.95 * (b.buildProgress / b.def.time)));
        if (b.buildProgress >= b.def.time) {
          b.complete = true;
          b.hp = b.maxHp;
          b.buildProgress = b.def.time;
          this._applyBuildingPop(b, +1);
          pl.notify(`${b.def.name} completed`);
          if (b.def.farmFood) { b.farmFood = b.def.farmFood + pl.mods.farmFoodAdd; b.farmMax = b.farmFood; }
          this.effects.push({ type: 'built', x: b.x, y: b.y, t: 0 });
        }
      }
      b.buildersThisTick = 0;
      return;
    }
    b.buildersThisTick = 0;

    // farms behave as a finite food source that villagers work
    if (b.def.farmFood) {
      if (b.farmFood <= 0) { this.kill(b, null); }
      return;
    }

    // Feitoria-style passive generation
    if (b.def.generates) {
      for (const r in b.def.generates) pl.give(r, b.def.generates[r] * dt);
    }

    // relic gold
    if (b.type === 'monastery' && b.relics > 0) {
      pl.give('gold', 0.5 * b.relics * dt * pl.mods.relicRate);
      if (pl.mods.flags.has('relicFood')) pl.give('food', 0.5 * b.relics * dt);
    }

    // heal garrisoned units
    if (b.garrison.length) {
      const fast = pl.mods.flags.has('herbalMedicine') ? 4 : 1;
      for (const id of b.garrison) {
        const u = this.get(id);
        if (u && u.hp < u.maxHp) u.hp = Math.min(u.maxHp, u.hp + 3 * fast * dt);
      }
    }

    this._updateProduction(b, pl, dt);
    this._updateBuildingAttack(b, pl, dt);
  }

  _updateProduction(b, pl, dt) {
    if (!b.queue.length) return;
    const item = b.queue[0];
    if (item.kind === 'unit') {
      if (pl.pop + item.pop > pl.effectivePopCap) { item.blocked = 'pop'; return; }
      item.blocked = null;
      item.timeLeft -= dt / pl.mods.trainSpeedMult;
      if (item.timeLeft <= 0) {
        b.queue.shift();
        const spawnAt = this._spawnPoint(b);
        const u = this.spawnUnit(item.id, b.owner, spawnAt.x, spawnAt.y);
        if (b.rally) {
          const rt = this._entityAt(b.rally.x, b.rally.y);
          if (rt && rt.kind === 'resource') this.commandGather([u], rt);
          else this.commandMove([u], b.rally.x, b.rally.y);
        }
        if (pl.mods.flags.has('scutage')) pl.give('gold', 15);
      }
    } else {
      item.timeLeft -= dt / pl.mods.researchSpeedMult /
        (TECHS[item.id].effects.some((e) => e.k === 'age') ? pl.mods.ageSpeedMult : 1);
      if (item.timeLeft <= 0) {
        b.queue.shift();
        this.completeResearch(pl, item.id);
      }
    }
  }

  completeResearch(pl, techId) {
    const before = new Set(pl.mods.unitUpgrades.entries());
    pl.completeTech(techId);
    void before;
    const t = TECHS[techId];
    for (const e of t.effects) {
      if (e.k === 'unitUpgrade') this._upgradeUnits(pl, e.from, e.to);
      if (e.k === 'buildingUpgrade') this._upgradeBuildings(pl, e.from, e.to);
    }
    // any stat change invalidates live entities' cached defs
    this.refreshDefs(pl.index);
    // free techs granted by this tech
    for (const freeId of pl.mods.freeTechs) {
      if (!pl.researched.has(freeId) && TECHS[freeId]) {
        pl.researched.add(freeId);
        pl.mods.add(TECHS[freeId].effects);
        for (const e of TECHS[freeId].effects) {
          if (e.k === 'unitUpgrade') this._upgradeUnits(pl, e.from, e.to);
        }
      }
    }
    this.refreshDefs(pl.index);
  }

  _upgradeUnits(pl, from, to) {
    for (const e of this.entities) {
      if (e.alive && e.kind === 'unit' && e.owner === pl.index && e.type === from) {
        const ratio = e.hp / e.maxHp;
        e.type = to;
        e.def = pl.mods.unit(to);
        e.maxHp = e.def.hp;
        e.hp = Math.max(1, e.maxHp * ratio);
        e.radius = e.def.radius;
      }
    }
  }

  _upgradeBuildings(pl, from, to) {
    for (const e of this.entities) {
      if (e.alive && e.kind === 'building' && e.owner === pl.index && e.type === from) {
        const ratio = e.hp / e.maxHp;
        e.type = to;
        e.def = pl.mods.building(to);
        e.maxHp = e.def.hp;
        e.hp = Math.max(1, e.maxHp * ratio);
      }
    }
  }

  /** Re-resolves cached stat tables after a tech changes them. */
  refreshDefs(playerIndex) {
    const pl = this.players[playerIndex];
    for (const e of this.entities) {
      if (!e.alive || e.owner !== playerIndex) continue;
      if (e.kind === 'unit') {
        const ratio = e.hp / e.maxHp;
        e.def = pl.mods.unit(e.type);
        e.maxHp = e.def.hp;
        e.hp = Math.min(e.maxHp, Math.max(1, e.maxHp * ratio));
      } else if (e.kind === 'building') {
        const ratio = e.hp / e.maxHp;
        e.def = pl.mods.building(e.type);
        e.maxHp = e.def.hp;
        e.hp = Math.min(e.maxHp, Math.max(1, e.maxHp * ratio));
      }
    }
  }

  _spawnPoint(b) {
    const a = this.rng.range(0, Math.PI * 2);
    const r = b.size / 2 + 0.9;
    return { x: b.x + Math.cos(a) * r, y: b.y + Math.sin(a) * r };
  }

  _entityAt(x, y) {
    return this.entityGrid.nearest(x, y, 1.2, (e) => e.alive && e.kind !== 'projectile');
  }

  _updateBuildingAttack(b, pl, dt) {
    if (!b.def.atk) return;
    if (b.attackCd > 0) { b.attackCd -= dt; return; }
    const arrows = (b.def.baseArrows || 0) +
      Math.min(b.garrison.length, b.def.garrison) * (b.def.arrowsPerGarrison || 0);
    if (arrows <= 0) return;

    const range = b.def.range;
    const targets = [];
    this.entityGrid.forEachNear(b.x, b.y, range + 2, (e) => {
      if (!e.alive || !this.isEnemy(b.owner, e.owner)) return;
      if (e.kind === 'resource' || e.kind === 'projectile' || e.garrisonedIn) return;
      const d = Math.hypot(e.x - b.x, e.y - b.y);
      if (d > range) return;
      const minR = b.def.minRange || 0;
      if (minR > 0 && d < minR && !pl.mods.flags.has('murderHoles')) return;
      targets.push(e);
    });
    if (!targets.length) return;
    targets.sort((a, c) => (a.kind === 'unit' ? 0 : 1) - (c.kind === 'unit' ? 0 : 1));

    b.attackCd = b.def.reload;
    for (let i = 0; i < arrows; i++) {
      const t = targets[i % targets.length];
      const dist = Math.hypot(t.x - b.x, t.y - b.y);
      this.projectiles.push(makeProjectile(b, t, b.def.atk, {
        tx: t.x + this.rng.range(-0.25, 0.25),
        ty: t.y + this.rng.range(-0.25, 0.25),
        duration: Math.max(0.15, dist / 9),
        blast: b.def.blast || 0,
        z: 2.2,
        style: b.def.blast ? 'boulder' : 'arrow',
      }));
    }
    this.effects.push({ type: 'shoot', x: b.x, y: b.y, t: 0 });
  }

  /* ================================================================
   *  Projectiles & effects
   * ================================================================ */

  _updateProjectiles(dt) {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.t += dt;
      const k = Math.min(1, p.t / p.duration);
      p.x = p.startX + (p.tx - p.startX) * k;
      p.y = p.startY + (p.ty - p.startY) * k;
      p.z = 0.8 + Math.sin(k * Math.PI) * p.arc * Math.hypot(p.tx - p.startX, p.ty - p.startY) * 0.35;
      if (k < 1) continue;

      this.projectiles.splice(i, 1);
      const src = this.get(p.sourceId);
      if (p.blast > 0) {
        areaDamage(this, src, p.tx, p.ty, p.blast, p.attack, true);
        this.effects.push({ type: 'explosion', x: p.tx, y: p.ty, r: p.blast, t: 0 });
        continue;
      }
      if (p.miss) { this.effects.push({ type: 'impact', x: p.tx, y: p.ty, t: 0 }); continue; }
      if (p.pierceLine) {
        // scorpion bolts damage everything along the flight line
        const hits = new Set();
        const steps = 8;
        for (let s = 1; s <= steps; s++) {
          const lx = p.startX + (p.tx - p.startX) * (s / steps);
          const ly = p.startY + (p.ty - p.startY) * (s / steps);
          this.entityGrid.forEachNear(lx, ly, 0.6, (e) => {
            if (!e.alive || hits.has(e.id) || e.kind === 'resource') return;
            if (!src || !this.isEnemy(src.owner, e.owner)) return;
            hits.add(e.id);
            resolveDamage(this, src, e, p.attack);
          });
        }
        this.effects.push({ type: 'impact', x: p.tx, y: p.ty, t: 0 });
        continue;
      }
      const target = this.get(p.targetId);
      if (target && target.alive && !target.garrisonedIn) {
        resolveDamage(this, src, target, p.attack);
      }
      this.effects.push({ type: 'impact', x: p.tx, y: p.ty, t: 0 });
    }
  }

  _updateEffects(dt) {
    for (let i = this.effects.length - 1; i >= 0; i--) {
      this.effects[i].t += dt;
      if (this.effects[i].t > 1.2) this.effects.splice(i, 1);
    }
    if (this.effects.length > 400) this.effects.splice(0, this.effects.length - 400);
  }

  /* ================================================================
   *  Victory
   * ================================================================ */

  _checkVictory() {
    if (this.tickCount % 40 !== 0) return;
    for (const pl of this.players) {
      if (pl.defeated) continue;
      let hasBuilding = false, hasVillager = false;
      for (const e of this.entities) {
        if (!e.alive || e.owner !== pl.index) continue;
        if (e.kind === 'building') { hasBuilding = true; }
        if (e.kind === 'unit' && (e.def.cat === 'villager' || e.def.cat === 'infantry' ||
          e.def.cat === 'cavalry' || e.def.cat === 'archer')) hasVillager = true;
        if (hasBuilding && hasVillager) break;
      }
      if (!hasBuilding && !hasVillager) {
        pl.defeated = true;
        pl.notify(`${pl.name} has been defeated`);
      }
    }
    // wonder countdown
    for (const e of this.entities) {
      if (e.alive && e.kind === 'building' && e.type === 'wonder' && e.complete) {
        e.wonderTimer = (e.wonderTimer || 0) + TICK * 40 * this.speed;
        if (e.wonderTimer > 300) { this.over = true; this.winner = e.owner; return; }
      }
    }
    const alive = this.players.filter((p) => !p.defeated);
    const teams = new Set(alive.map((p) => p.team));
    if (teams.size <= 1 && this.players.length > 1) {
      this.over = true;
      this.winner = alive.length ? alive[0].index : null;
    }
  }

  /* ================================================================
   *  Commands (issued by UI + AI)
   * ================================================================ */

  commandMove(units, x, y) {
    for (const u of units) {
      if (!u.alive || u.garrisonedIn) continue;
      u.task = { type: 'move', x, y };
      u.repathCd = 0;
      this.requestPath(u, { x, y, radius: 0 });
    }
  }

  commandAttackMove(units, x, y) {
    for (const u of units) {
      if (!u.alive || u.garrisonedIn) continue;
      u.task = { type: 'attackMove', x, y };
      u.repathCd = 0;
      this.requestPath(u, { x, y, radius: 0 });
    }
  }

  commandAttack(units, target) {
    for (const u of units) {
      if (!u.alive || u.garrisonedIn) continue;
      if (u.def.converts && this.isEnemy(u.owner, target.owner)) {
        u.task = { type: 'convert', targetId: target.id };
      } else if (u.def.cat === 'villager' && target.kind === 'building' && this.isAlly(u.owner, target.owner)) {
        u.task = target.complete ? { type: 'repair', targetId: target.id } : { type: 'build', targetId: target.id };
      } else {
        u.task = { type: 'attack', targetId: target.id };
      }
      u.repathCd = 0;
    }
  }

  commandGather(units, res) {
    for (const u of units) {
      if (!u.alive || u.def.cat !== 'villager' && u.def.cat !== 'naval') continue;
      if (res.kind === 'resource' && res.type === 'relic') continue;
      const resType = res.kind === 'unit' ? 'food' : res.resType;
      u.task = { type: 'gather', targetId: res.id, resType };
      u.repathCd = 0;
    }
  }

  commandBuild(units, bId, tx, ty) {
    if (!units.length) return null;
    const owner = units[0].owner;
    const pl = this.players[owner];
    const def = pl.mods.building(bId);
    if (!pl.canAfford(def.cost)) { pl.notify('Not enough resources'); return null; }
    if (!this.canPlaceBuilding(bId, owner, tx, ty)) { pl.notify('Cannot build there'); return null; }
    pl.spend(def.cost);
    const b = this.placeBuilding(bId, owner, tx, ty, false);
    for (const u of units) {
      if (u.def.cat !== 'villager') continue;
      u.task = { type: 'build', targetId: b.id };
      u.repathCd = 0;
    }
    return b;
  }

  commandGarrison(units, building) {
    for (const u of units) {
      if (!u.alive || u.garrisonedIn) continue;
      u.task = { type: 'garrison', targetId: building.id };
      u.repathCd = 0;
    }
  }

  commandRelic(units, relic) {
    for (const u of units) {
      if (u.def.converts) { u.task = { type: 'relic', targetId: relic.id }; u.repathCd = 0; }
    }
  }

  commandHeal(units, target) {
    for (const u of units) {
      if (u.def.converts) { u.task = { type: 'heal', targetId: target.id }; u.repathCd = 0; }
    }
  }

  commandTrade(units, market) {
    for (const u of units) {
      if (u.def.cat !== 'trade') continue;
      const home = this.entityGrid.nearest(u.x, u.y, 80, (e) =>
        e.kind === 'building' && e.owner === u.owner && e.type === 'market' && e.complete);
      if (!home) continue;
      u.task = { type: 'trade', marketId: market.id, homeId: home.id, outbound: true };
    }
  }

  commandStop(units) {
    for (const u of units) { u.task = { type: 'idle' }; u.path = null; u.moving = false; }
  }

  queueUnit(building, unitId) {
    const pl = this.players[building.owner];
    if (!building.complete) return false;
    if (!pl.isUnitAvailable(unitId)) return false;
    const def = pl.mods.unit(unitId);
    if (!pl.canAfford(def.cost)) { pl.notify('Not enough resources'); return false; }
    if (building.queue.length >= 15) return false;
    pl.spend(def.cost);
    building.queue.push({
      kind: 'unit', id: unitId, timeLeft: def.time, total: def.time,
      cost: def.cost, pop: def.pop, name: def.name,
    });
    return true;
  }

  queueTech(building, techId) {
    const pl = this.players[building.owner];
    if (!building.complete) return false;
    if (!pl.isTechAvailable(techId)) return false;
    const t = TECHS[techId];
    const cost = pl.mods.techCost(t);
    if (!pl.canAfford(cost)) { pl.notify('Not enough resources'); return false; }
    // age-up requires two buildings of the previous age
    if (t.effects.some((e) => e.k === 'age') && !pl.mods.flags.has('noAgePrereq')) {
      const need = 2;
      let count = 0;
      for (const e of this.entities) {
        if (e.alive && e.kind === 'building' && e.owner === pl.index && e.complete &&
          e.def.age === pl.age && e.type !== 'house' && e.type !== 'farm' &&
          e.type !== 'palisadeWall' && e.type !== 'stoneWall' && e.type !== 'outpost') count++;
      }
      if (count < need) { pl.notify(`Requires ${need} ${pl.age === 'dark' ? 'Dark' : ''} Age buildings`); return false; }
    }
    pl.spend(cost);
    pl.researching.add(techId);
    building.queue.push({ kind: 'tech', id: techId, timeLeft: t.time, total: t.time, cost, name: t.name });
    return true;
  }

  cancelQueueItem(building, index) {
    const item = building.queue[index];
    if (!item) return;
    const pl = this.players[building.owner];
    pl.refund(item.cost);
    if (item.kind === 'tech') pl.researching.delete(item.id);
    building.queue.splice(index, 1);
  }

  /** Market buying/selling, 100 resource units at a time. */
  marketTrade(playerIndex, res, action) {
    const pl = this.players[playerIndex];
    const fee = pl.mods.marketFee;
    if (action === 'buy') {
      const price = Math.round(100 * (1 + fee));
      if (pl.res.gold < price) return false;
      pl.res.gold -= price;
      pl.res[res] += 100;
    } else {
      if (pl.res[res] < 100) return false;
      pl.res[res] -= 100;
      pl.res.gold += Math.round(100 * (1 - fee));
    }
    return true;
  }
}

export { TERRAIN, AGES, UNITS, BUILDINGS, TECHS };
