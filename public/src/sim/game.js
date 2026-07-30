// The simulation. Fixed-step, deterministic given a seed and the same commands.

import { RNG } from '../core/rng.js';
import { SpatialGrid } from '../core/grid.js';
import { generateMap, TERRAIN } from './map.js';
import { Player, AGES, registerCivTable } from './player.js';
import { makeUnit, makeBuilding, makeResource, makeProjectile, resetIds, RESOURCE_INFO } from './entity.js';
import { resolveDamage, areaDamage } from './combat.js';
import { computeDamage } from '../data/armor.js';
import { UNITS } from '../data/units.js';
import { BUILDINGS } from '../data/buildings.js';
import { TECHS } from '../data/techs.js';
import { CIVILIZATIONS } from '../data/civs.js';

registerCivTable(CIVILIZATIONS);

export const TICK = 1 / 20;          // 20 Hz simulation
// A* searches allowed per tick. Too low and units spend many ticks waiting for
// a route, during which they can only steer blindly toward the goal.
const PATH_BUDGET = 48;
// Ceiling on the adaptive budget, so one very busy tick cannot stall the frame.
const PATH_BUDGET_MAX = 240;
// Long walks re-plan periodically so units route around things that appeared
// after they set off (new buildings, felled trees, other players' walls).
const REPLAN_INTERVAL = 2.5;
const FOG_INTERVAL = 4;              // ticks between fog recomputes
const CARRY_BASE = 10;
/** How far a cry for help carries to idle soldiers. */
const DISTRESS_RADIUS = 26;
/** How long after being hit something still counts as under attack. */
const DISTRESS_SECONDS = 4;

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
      mapType: config.mapType ?? 'mixed',
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
    this.gatherClaims = new Map();   // node id -> gatherers committed to it
    this._dmgCache = new WeakMap();  // attacker def -> target def -> damage
    this.buildClaims = new Map();    // foundation id -> villagers on their way

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

  /** How much a player's villagers can carry before they must drop off. */
  carryCapacity(pl) {
    return Math.round((CARRY_BASE + pl.mods.carryAdd) * pl.mods.carryMult);
  }

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
      // Anything still in the queue is refunded, and a half-researched tech has
      // to stop counting as in progress. Leaving it in `researching` marks it
      // unavailable for the rest of the game: one AI lost the Town Center that
      // held Hand Cart and then showed it as "researching" for thirty-four
      // minutes, unable to queue it anywhere else.
      if (pl) {
        for (const item of e.queue) {
          pl.refund(item.cost);
          if (item.kind === 'tech') pl.researching.delete(item.id);
        }
      }
      e.queue.length = 0;
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
    // Rebuilt in the same sweep: how many gatherers are committed to each node.
    // Without it, every villager whose tree runs out picks the same "nearest"
    // replacement, they strip it in seconds, and the whole group walks off to
    // the next one together - which is where most of the walking time goes.
    this.gatherClaims.clear();
    this.buildClaims.clear();
    for (const e of this.entities) {
      if (!e.alive || e.kind === 'projectile') continue;
      this.entityGrid.insert(e);
      if (e.kind !== 'unit' || !e.task) continue;
      if (e.task.type === 'gather' || e.task.type === 'deliver') {
        const id = e.task.type === 'deliver' ? e.task.returnTo : e.task.targetId;
        if (id) this.gatherClaims.set(id, (this.gatherClaims.get(id) || 0) + 1);
      } else if (e.task.type === 'build' && e.task.targetId) {
        this.buildClaims.set(e.task.targetId, (this.buildClaims.get(e.task.targetId) || 0) + 1);
      }
    }
  }

  /** Gatherers already committed to a node, excluding `self`. */
  claimsOn(node, self) {
    let n = this.gatherClaims.get(node.id) || 0;
    if (self && (self.task.targetId === node.id || self.task.returnTo === node.id)) n--;
    return Math.max(0, n);
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
    // The budget has to grow with the size of the game. A flat 48 searches per
    // tick was fine for 60 units; with several booming economies running 130
    // villagers each the queue backs up and villagers stand still for seconds
    // after being given a job. Drain the whole queue when we can, with a hard
    // ceiling so a pathological frame still cannot run away.
    const budget = Math.max(PATH_BUDGET, Math.min(PATH_BUDGET_MAX, this.pathQueue.length));
    while (this.pathQueue.length && n < budget) {
      const id = this.pathQueue.shift();
      const u = this.get(id);
      if (!u) continue;
      u.inPathQueue = false;
      const goal = u.pendingGoal;
      u.pendingGoal = null;
      if (!goal) continue;
      const path = this.grid.findPath(u.x, u.y, goal, u.def.domain);
      u.pathIdx = 0;
      if (path === null) {
        // No route at all. Walking straight at the goal was the old behaviour
        // and it is what made units grind into cliffs and shorelines: they take
        // the direct line, jam against the obstacle and creep along it. Instead
        // aim for the nearest tile we CAN stand on near the goal, and if even
        // that fails, stop rather than shuffle into the scenery.
        const near = this.grid.nearestOpen(goal.x, goal.y, u.def.domain, 10);
        if (near) {
          const retry = this.grid.findPath(u.x, u.y, { x: near.x, y: near.y, radius: 1 }, u.def.domain);
          u.path = retry && retry.length ? retry : null;
        } else {
          u.path = null;
        }
        u.pathFailed = true;
        // Give up only after repeated failures. A single failed search is often
        // transient - a unit momentarily boxed in by others - and cancelling the
        // task outright would drop villagers off their job for no good reason.
        u.pathFails = (u.pathFails || 0) + 1;
        if (!u.path && u.pathFails >= 4) {
          u.pathFails = 0;
          u.task = { type: 'idle' };
          u.moving = false;
        }
      } else if (path.length === 0) {
        // Empty path means "already standing within the goal radius". That is
        // success, not failure - clearing the path lets the task's own arrival
        // check take over instead of re-pathing forever.
        u.path = null;
        u.pathFailed = false;
      } else {
        u.path = path;
        u.pathFailed = false;
        u.pathFails = 0;
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
    if (this.tickCount % 20 === u.id % 20) this._unstrand(u, dt);
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

    // Single hand-off point for the shift queue: any task that finishes drops
    // the unit to idle, and idle immediately pulls the next queued order. That
    // keeps every task implementation unaware of queueing.
    if (u.task.type === 'idle' && u.orders && u.orders.length) {
      this._startOrder(u, u.orders.shift());
    }

    this._retaliate(u);

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
      case 'patrol': this._taskPatrol(u, dt); break;
      default: u.task = { type: 'idle' };
    }
  }

  /**
   * Last-resort rescue for a unit standing somewhere it should not be - inside
   * water, or under a building that went up on top of it. Normal movement
   * refuses to enter impassable tiles, so a unit that somehow starts on one can
   * be wedged permanently. This slides it toward the nearest tile it belongs
   * on, ignoring the usual passability gate, which is the only way out.
   */
  _unstrand(u, dt) {
    if (this.grid.isPassable(u.x | 0, u.y | 0, u.def.domain)) return;
    const open = this.grid.nearestOpen(u.x, u.y, u.def.domain, 12);
    if (!open) return;
    const dx = open.x - u.x, dy = open.y - u.y;
    const d = Math.hypot(dx, dy) || 1;
    const step = Math.min(u.def.speed * dt * 20, d);   // this runs once every 20 ticks
    u.x += (dx / d) * step;
    u.y += (dy / d) * step;
    u.path = null;
    u.repathCd = 0;
  }

  _updateAnimal(u, dt) {
    // Gaia wildlife: boars and wolves fight back, everything else wanders.
    if (u.task.type === 'attack') { this._taskAttack(u, dt); return; }
    // Prey being hunted stops roaming. Deer wander 2-6 tiles every few seconds,
    // which for a slower villager is a chase that never ends - a dozen hunters
    // would jog after the herd for the whole game and bring back no food at
    // all. Once a hunter has committed to an animal, it stands.
    if (u.def.huntable && this.gatherClaims.get(u.id)) {
      u.moving = false;
      if (u.task.type === 'move') u.task = { type: 'idle' };
      return;
    }
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
    if (!u.path || u.pathIdx >= u.path.length) {
      if (u.repathCd <= 0) {
        u.repathCd = 0.4 + this.rng.next() * 0.3;
        this.requestPath(u, this._approachGoal(u, target, range));
      }
      // Close the last fraction of a tile by steering straight in - A* can only
      // land us on the neighbouring tile. Crucially this is ONLY for the final
      // gap: using it at range makes a unit beeline into water or cliffs and
      // scrape along them while it waits for a real path.
      if (d < 2.5) {
        // If the straight line is blocked (a building went up between us and
        // the target) grinding against it is pointless - drop the cooldown so a
        // real route is searched on the very next tick instead of every 0.5s.
        if (!this._stepToward(u, target.x, target.y, dt)) u.repathCd = 0;
      }
      return false;
    }
    this._stepMove(u, dt);
    return false;
  }

  /**
   * Direct, non-pathfinding step toward a point (used to close the last gap).
   * @returns false if the way is blocked and the unit could not move at all.
   */
  _stepToward(u, tx, ty, dt) {
    const dx = tx - u.x, dy = ty - u.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-4) return true;
    const sx = dx / dist, sy = dy / dist;
    const step = Math.min(u.def.speed * dt, dist);
    const nx = u.x + sx * step, ny = u.y + sy * step;
    const domain = u.def.domain;
    let moved = true;
    if (this.grid.isPassable(nx | 0, ny | 0, domain)) { u.x = nx; u.y = ny; }
    else if (this.grid.isPassable(nx | 0, u.y | 0, domain)) u.x = nx;
    else if (this.grid.isPassable(u.x | 0, ny | 0, domain)) u.y = ny;
    else moved = false;
    u.facing = Math.atan2(sy, sx);
    u.moving = true;
    return moved;
  }

  /**
   * Where a unit should path to in order to end up within `range` of a target.
   * For buildings that is the footprint tile nearest the unit (the tile itself
   * is blocked, so the goal radius lets A* stop on the free tile beside it) -
   * pathing to the centre of a 4x4 Town Center would otherwise stop several
   * tiles short of the arrival check.
   */
  /**
   * Best free tile to work a blocked resource from. Cardinal neighbours are
   * strongly preferred: standing orthogonally puts the villager 1.0 tiles from
   * the centre (and the hug step then closes it to ~0.5), whereas a diagonal
   * bottoms out at 1.41 and looks detached.
   */
  _bestAdjacentTile(u, res) {
    let best = null, bestScore = Infinity;
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    for (const [dx, dy] of dirs) {
      const tx = res.tx + dx, ty = res.ty + dy;
      if (!this.grid.isPassable(tx, ty, u.def.domain)) continue;
      const px = tx + 0.5, py = ty + 0.5;
      const diagonal = dx !== 0 && dy !== 0;
      const score = Math.hypot(px - u.x, py - u.y) + (diagonal ? 1.5 : 0);
      if (score < bestScore) { bestScore = score; best = { x: px, y: py }; }
    }
    return best;
  }

  _approachGoal(u, target, range) {
    if (target.kind === 'resource') {
      if (RESOURCE_INFO[target.type]?.blocks) {
        const spot = this._bestAdjacentTile(u, target);
        if (spot) return { x: spot.x, y: spot.y, radius: 0 };
      }
      // Berries and carcasses are walkable, so the gatherer stands ON them.
      // Asking A* for "within 1 tile" instead let it report success while the
      // villager was still 1.4 tiles out and separated from the bush by a
      // Mill - it would then try to close the gap by walking straight into the
      // wall, and gather nothing for the rest of the game.
      return { x: target.x, y: target.y, radius: 0 };
    }
    if (target.kind === 'building') {
      // Tile indices, so the unit's world position is floored, not rounded -
      // and the result is nudged to the tile centre to match every other goal.
      const gx = Math.max(target.tx, Math.min(target.tx + target.size - 1, Math.floor(u.x)));
      const gy = Math.max(target.ty, Math.min(target.ty + target.size - 1, Math.floor(u.y)));
      return { x: gx + 0.5, y: gy + 0.5, radius: 1 };
    }
    return { x: target.x, y: target.y, radius: Math.max(1, Math.round(range + (target.radius || 0))) };
  }

  /* ---------------- tasks ---------------- */

  _taskIdle(u, dt) {
    u.moving = false;
    if (u.stance === 'noAttack' || !u.def.atk || !Object.keys(u.def.atk).length) return;
    if (u.def.cat === 'villager') return;
    if (this.tickCount % 6 !== u.id % 6) return;
    const range = Math.max(u.def.los, (u.def.range || 0) + 2);
    const target = this._findTarget(u, range);
    if (target) {
      u.task = { type: 'attack', targetId: target.id, auto: true, homeX: u.x, homeY: u.y };
      return;
    }
    // Nothing in sight, but something of ours nearby may be dying just outside
    // it. Standing in the town while villagers are cut down forty tiles away is
    // the single most frustrating thing an idle army does.
    if (u.stance !== 'aggressive') return;
    const cry = this._distressCall(u);
    if (cry) u.task = { type: 'attackMove', x: cry.x, y: cry.y };
  }

  /**
   * The nearest of our own things that has been hit in the last few seconds.
   *
   * This is the distress signal: anything of ours taking damage broadcasts its
   * position simply by recording when it was hurt, and idle soldiers on the
   * aggressive stance walk toward it. It costs nothing to maintain - the timer
   * is already there for other reasons - and it is what turns a garrison of
   * idle units into a reaction force.
   */
  _distressCall(u) {
    const now = this.time;
    let best = null, bestD = Infinity;
    this.entityGrid.forEachNear(u.x, u.y, DISTRESS_RADIUS, (e) => {
      if (!e.alive || e.owner !== u.owner || e === u) return;
      if (!e.lastDamaged || now - e.lastDamaged > DISTRESS_SECONDS) return;
      // Buildings can look after themselves for a moment; people cannot.
      const weight = e.kind === 'unit' ? 1 : 1.6;
      const d = Math.hypot(e.x - u.x, e.y - u.y) * weight;
      if (d < bestD) { bestD = d; best = e; }
    });
    return best;
  }

  /**
   * A unit being shot at while doing something else should turn and fight.
   *
   * Without this a soldier walking to a rally point dies without ever raising
   * its weapon, because `move` has no target acquisition of its own - it just
   * walks, takes hits, and keeps walking. The interrupted task is remembered
   * and resumed once the attacker is dealt with, so an order is delayed rather
   * than thrown away.
   */
  _retaliate(u) {
    if (u.garrisonedIn || u.stance === 'noAttack') return;
    if (!u.def.atk || !Object.keys(u.def.atk).length) return;
    if (!u.lastDamaged || this.time - u.lastDamaged > 1.5) return;
    const t = u.task.type;
    // These already fight, or must not be broken off.
    if (t === 'attack' || t === 'attackMove' || t === 'patrol' ||
        t === 'convert' || t === 'garrison') return;

    const attacker = this.get(u.lastAttacker);
    if (!attacker || !attacker.alive || attacker.garrisonedIn) return;
    if (!this.isEnemy(u.owner, attacker.owner)) return;

    const reach = Math.max(u.def.los, (u.def.range || 0) + 2);
    const dist = this._distTo(u, attacker);
    if (dist > reach) return;
    // Stand Ground swings at whatever comes to it but never walks off its spot.
    if (u.stance === 'standGround' && dist > (u.def.range || 1) + 0.5) return;
    // A villager is not a soldier. It will defend itself against another
    // villager - a forward builder, someone stealing a boar - but throwing
    // peasants at cavalry only loses the peasants faster, and the player's own
    // orders are usually the better plan.
    if (u.def.cat === 'villager' &&
        attacker.def.cat !== 'villager' && attacker.def.cat !== 'trade') return;

    u.task = { type: 'attack', targetId: attacker.id, auto: true, resumeTask: u.task };
    u.path = null;
    u.pathIdx = 0;
    u.repathCd = 0;
  }

  /**
   * Damage `u` would deal to `e`, memoised per pair of unit definitions.
   * Target selection asks this for every candidate in line of sight every few
   * ticks, and the answer only depends on the two definitions, so it is worth
   * caching. Definitions are replaced (not mutated) when a tech upgrades them,
   * so a stale entry cannot outlive its inputs.
   */
  _dmgAgainst(u, e) {
    let byTarget = this._dmgCache.get(u.def);
    if (!byTarget) { byTarget = new WeakMap(); this._dmgCache.set(u.def, byTarget); }
    let d = byTarget.get(e.def);
    if (d === undefined) {
      d = computeDamage(u.def.atk || {}, e.def.armor || {});
      byTarget.set(e.def, d);
    }
    return d;
  }

  /**
   * Picks what a unit should shoot at.
   *
   * The old rule was "nearest thing, units before buildings", which meant
   * Battering Rams stopped to punch villagers for 2 damage while the Town
   * Center stood there, and Knights traded with Halberdiers instead of running
   * down the economy behind them. Scoring starts from the damage we would
   * actually deal - which is the counter system already expressed in numbers -
   * and then adds the role preferences a player would apply by hand.
   */
  _findTarget(u, range) {
    let best = null, bestScore = -Infinity;
    const raider = u.def.cat === 'cavalry';
    this.entityGrid.forEachNear(u.x, u.y, range, (e) => {
      if (!e.alive || !this.isEnemy(u.owner, e.owner)) return;
      if (e.kind === 'resource' || e.kind === 'projectile') return;
      if (e.garrisonedIn) return;
      const d = this._distTo(u, e);
      if (d > range) return;

      // Halberdier vs Knight is already 30 here and vs Champion 6; a Ram is 200+
      // on a building and 2 on a villager. Capped so a Ram's huge building
      // number cannot swamp every other consideration.
      let score = Math.min(this._dmgAgainst(u, e), 50) - d * 2;

      if (e.kind === 'building') {
        // Anything that cannot meaningfully dent a building should walk past it.
        if (this._dmgAgainst(u, e) < 12) score -= 60;
        else if (e.def.cat === 'military' || e.type === 'townCenter') score += 12;
      } else {
        if (e.def.cat === 'siege') score += 14;      // fragile, and lethal if ignored
        if (e.def.converts) score += 12;             // monks steal our units
        // Raiders go through the economy; a battle line stays on the battle.
        // Siege actively avoids villagers: it is slow, expensive and the only
        // thing that can break the enemy army, so spending its reload on a
        // peasant while the archer line shoots back is the worst trade it has.
        if (e.def.cat === 'villager') {
          score += raider ? 22 : u.def.cat === 'siege' ? -8 : 3;
        }
        // Melee should close on shooters rather than trade with the front rank.
        if ((e.def.range || 0) > 2 && !(u.def.range > 2)) score += 6;
      }
      if (score > bestScore) { bestScore = score; best = e; }
    });
    return best;
  }

  _taskMove(u, dt) {
    if (!u.path) {
      const dx = u.task.x - u.x, dy = u.task.y - u.y;
      if (Math.hypot(dx, dy) < 0.6) { u.task = { type: 'idle' }; u.moving = false; return; }
      if (u.repathCd <= 0) {
        u.repathCd = 0.6;
        // A destination that can never be stood on (a tile under a building,
        // say) would otherwise be re-pathed forever. Count the attempts and
        // settle for "as close as we can get" - the unit then goes idle and
        // becomes available for real work again.
        u.moveTries = (u.moveTries || 0) + 1;
        if (u.moveTries > 5) {
          u.moveTries = 0;
          u.task = { type: 'idle' };
          u.moving = false;
          return;
        }
        this.requestPath(u, { x: u.task.x, y: u.task.y, radius: 0 });
      }
      return;
    }
    u.moveTries = 0;
    // Re-plan mid-journey: the world changes while a unit is walking, and a
    // route computed 20 seconds ago may now run through a wall.
    u.replanT = (u.replanT || 0) + dt;
    if (u.replanT > REPLAN_INTERVAL && u.path.length - u.pathIdx > 3) {
      u.replanT = 0;
      this.requestPath(u, { x: u.task.x, y: u.task.y, radius: 0 });
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

  /** Walks back and forth between two points, engaging anything on the way. */
  _taskPatrol(u, dt) {
    const t = this._findTarget(u, u.def.los);
    if (t) {
      u.task = { type: 'attack', targetId: t.id, auto: true, resumePatrol: { ...u.task } };
      return;
    }
    const tx = u.task.leg === 1 ? u.task.bx : u.task.ax;
    const ty = u.task.leg === 1 ? u.task.by : u.task.ay;
    if (!u.path) {
      if (Math.hypot(tx - u.x, ty - u.y) < 1.0) {
        u.task = { ...u.task, leg: u.task.leg === 1 ? 0 : 1 };
        u.repathCd = 0;
        return;
      }
      if (u.repathCd <= 0) { u.repathCd = 0.6; this.requestPath(u, { x: tx, y: ty, radius: 0 }); }
      return;
    }
    if (this._stepMove(u, dt)) {
      u.task = { ...u.task, leg: u.task.leg === 1 ? 0 : 1 };
      u.repathCd = 0;
    }
  }

  _taskAttack(u, dt) {
    const target = this.get(u.task.targetId);
    if (!target || !target.alive || target.garrisonedIn) {
      if (u.task.resume) { u.task = { type: 'attackMove', x: u.task.resume.x, y: u.task.resume.y }; return; }
      if (u.task.resumePatrol) { u.task = u.task.resumePatrol; return; }
      // Back to whatever it was doing before it was interrupted - the order was
      // postponed by the fight, not cancelled by it.
      if (u.task.resumeTask) {
        u.task = u.task.resumeTask;
        u.path = null;
        u.pathIdx = 0;
        u.repathCd = 0;
        return;
      }
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

  /** True for a Farm, which is a building that behaves like a food resource. */
  _isFarm(e) {
    return !!(e && e.kind === 'building' && e.def.farmFood);
  }

  /** Remaining amount, whether the target is a resource node or a Farm. */
  _amountOf(res) {
    return this._isFarm(res) ? res.farmFood : res.amount;
  }

  _drawFrom(res, amt) {
    if (this._isFarm(res)) res.farmFood -= amt;
    else res.amount -= amt;
  }

  /**
   * Re-sows an exhausted Farm in place, charging the normal Farm cost. Returns
   * false if the player has it switched off or cannot afford the wood, in which
   * case the caller lets the plot expire.
   */
  _tryReseedFarm(b) {
    const pl = this.players[b.owner];
    if (!pl || !pl.autoReseed) return false;
    const def = pl.mods.building('farm');
    if (!pl.canAfford(def.cost)) {
      if (!b.reseedWarned) {
        b.reseedWarned = true;
        pl.notify('Not enough wood to reseed a Farm');
      }
      return false;
    }
    pl.spend(def.cost);
    b.farmFood = def.farmFood + pl.mods.farmFoodAdd;
    b.farmMax = b.farmFood;
    b.hp = b.maxHp;
    b.reseedWarned = false;
    this.effects.push({ type: 'built', x: b.x, y: b.y, t: 0 });
    return true;
  }

  /** The villager currently working a farm, or null if the plot is free. */
  _farmWorker(farm) {
    const cur = this.get(farm.farmer);
    if (cur && cur.task && cur.task.type === 'gather' && cur.task.targetId === farm.id) return cur;
    if (cur && cur.task && cur.task.type === 'deliver' && cur.task.returnTo === farm.id) return cur;
    return null;
  }

  /**
   * Nearest completed farm of this player with food left and nobody on it.
   * `exclude` may be a single id or a Set, so a caller handing out several
   * plots at once can skip the ones it has already promised.
   */
  _findFreeFarm(u, exclude) {
    const skip = exclude instanceof Set
      ? (id) => exclude.has(id)
      : (id) => id === exclude;
    let best = null, bestD = Infinity;
    for (const e of this.entities) {
      if (!e.alive || !this._isFarm(e) || e.owner !== u.owner) continue;
      if (!e.complete || e.farmFood <= 0 || skip(e.id)) continue;
      if (this._farmWorker(e)) continue;
      const d = this._distTo(u, e);
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  _taskGather(u, dt) {
    const res = this.get(u.task.targetId);
    // Try to re-sow before deciding the plot is spent. Whichever ran first this
    // tick - the farmer or the building update - the farmer keeps its job.
    if (res && this._isFarm(res) && res.farmFood <= 0) this._tryReseedFarm(res);
    if (!res || !res.alive ||
        (res.kind === 'resource' && res.amount <= 0) ||
        (this._isFarm(res) && res.farmFood <= 0)) {
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

    const isFarm = this._isFarm(res);

    if (isFarm) {
      // One villager per plot, as in AoE2. If someone else already has this
      // farm, quietly move to a free one rather than crowding it.
      const worker = this._farmWorker(res);
      if (worker && worker !== u) {
        // Someone beat us to this plot - take another free one, or lay a new
        // one nearby, rather than standing around doing nothing.
        if (!this._assignFarmWork(u, null, new Set([res.id]))) u.task = { type: 'idle' };
        return;
      }
      res.farmer = u.id;

      // Farms are walkable, so the farmer stands in the middle of the plot
      // rather than hovering at its edge.
      const d = Math.hypot(res.x - u.x, res.y - u.y);
      if (d > 0.5) {
        if (!u.path || u.pathIdx >= u.path.length) {
          if (u.repathCd <= 0) {
            u.repathCd = 0.5;
            this.requestPath(u, { x: res.x, y: res.y, radius: 0 });
          }
          this._stepToward(u, res.x, res.y, dt);
        } else {
          this._stepMove(u, dt);
        }
        return;
      }
      u.moving = false;
      u.path = null;
    } else {
      // Trees, gold and stone occupy (and block) their tile, so a gatherer can
      // only ever stand on a neighbouring one. In dense forest the only free
      // neighbour may be diagonal, which is 1.41 tiles centre-to-centre - the
      // gate has to tolerate that or a villager boxed in by trees would never
      // start working. Non-blocking nodes (bushes, carcasses) allow a tighter gate.
      const blocks = !!RESOURCE_INFO[res.type]?.blocks;
      const reach = blocks ? 0.8 : 0.5;
      const d = this._distTo(u, res);
      if (d > reach) { this._approach(u, res, reach * 0.5, dt); return; }

      u.path = null;
      u.facing = Math.atan2(res.y - u.y, res.x - u.x);
      // Having arrived, keep easing in so the villager ends up pressed right
      // against the resource rather than stopping at the edge of the gate.
      // Movement stops on its own at the blocked tile boundary.
      if (d > 0.15) this._stepToward(u, res.x, res.y, dt * 0.6);
      u.moving = false;
    }

    const pl = this.players[u.owner];
    const info = isFarm ? RESOURCE_INFO.farm : RESOURCE_INFO[res.type];
    const sub = res.sub || info.sub || info.res;
    const rate = info.gatherRate * (pl.mods.gather[sub] ?? 1) * (pl.mods.gather[info.res] ?? 1);
    const cap = this.carryCapacity(pl);

    if (!u.carrying || u.carrying.res !== info.res) u.carrying = { res: info.res, sub, amount: 0 };
    // A Farm keeps its remaining food in `farmFood`, not `amount`; reading
    // `amount` off a building yields undefined and makes this whole sum NaN, so
    // the villager gathers forever and never fills up.
    const remaining = this._amountOf(res);
    const take = Math.min(rate * dt, remaining, cap - u.carrying.amount);
    u.carrying.amount += take;
    this._drawFrom(res, take);
    u.gathering = true;

    // Re-sow the moment the plot runs dry, rather than waiting for the building
    // update later in the tick. Entities are processed in array order, so a
    // farmer that ran first would see farmFood <= 0, abandon the farm, and only
    // then would it be reseeded - leaving the villager standing idle beside a
    // perfectly good plot.
    if (isFarm && res.farmFood <= 0) this._tryReseedFarm(res);

    if (!isFarm && res.amount <= 0) {
      res.alive = false;
      if (info.blocks) this.grid.blocked[res.ty * this.size + res.tx] = 0;
      if (res.type === 'tree') {
        // the renderer replays this as a tree toppling over
        this.effects.push({
          type: 'treeFall', x: res.x, y: res.y, t: 0,
          variant: res.variant, angle: this.rng.range(0, Math.PI * 2),
        });
      }
    }
    if (u.carrying.amount >= cap - 1e-6) {
      // Khmer farmers deposit instantly
      if (isFarm && pl.mods.flags.has('instantFarmDrop')) {
        pl.give('food', u.carrying.amount);
        u.carrying.amount = 0;
      } else {
        u.task = { type: 'deliver', returnTo: res.id, resType: u.task.resType };
      }
    }
  }

  /**
   * The node a villager should move to once the one it was on runs out.
   * Scored on the whole round trip - walk out plus the carry back to the
   * drop-off - rather than raw proximity, because the nearest tree on the far
   * side of the base is a worse job than a slightly further one next to the
   * Lumber Camp. Falls back to a wider sweep so a villager only ever goes idle
   * when there is genuinely nothing left of that resource in reach.
   */
  _findSameResourceNearby(u, resType) {
    const site = this._nearestDropSite(u, resType);
    let best = null, bestScore = Infinity;
    const sweep = (radius) => {
      this.entityGrid.forEachNear(u.x, u.y, radius, (e) => {
        if (e.kind !== 'resource' || !e.alive || e.amount <= 0) return;
        if (e.resType !== resType || e.type === 'relic') return;
        // Land villagers cannot reach fish; targeting one strands them on the shore.
        if (e.type === 'fish' && u.def.domain !== 'water') return;
        const d = this._distTo(u, e);
        if (d > radius) return;
        const haul = site ? Math.hypot(e.x - site.x, e.y - site.y) : 0;
        // The haul is paid on every one of the ~10 trips it takes to empty a
        // node, the walk out only once, so the haul is worth far more than
        // proximity. Crowding is penalised hard: trees hold 100 wood and are a
        // single tile, so a second villager on one is almost pure waste.
        const crowd = this.claimsOn(e, u);
        const cap = RESOURCE_INFO[e.type]?.blocks && e.type === 'tree' ? 1 : 4;
        const score = d + haul * 4 + (crowd >= cap ? 60 : crowd * 12);
        if (score < bestScore) { bestScore = score; best = e; }
      });
    };
    sweep(14);
    if (!best) sweep(32);
    if (best) return best;
    // farms are buildings, so they never show up in the resource sweep above
    if (resType === 'food') return this._findFreeFarm(u);
    return null;
  }

  _taskDeliver(u, dt) {
    if (!u.carrying || u.carrying.amount <= 0) { u.task = { type: 'idle' }; return; }
    let site = this.get(u.task.siteId);
    if (!site || !site.alive || !site.complete) {
      site = this._findDropSite(u, u.carrying.res);
      if (!site) { u.task = { type: 'idle' }; return; }
      u.task = { ...u.task, siteId: site.id };
    }
    if (this._distTo(u, site) > 1.25) { this._approach(u, site, 1.0, dt); return; }
    u.moving = false;
    const pl = this.players[u.owner];
    pl.give(u.carrying.res, u.carrying.amount);
    // Poles: stone mining also yields gold; Burgundian farms yield gold
    if (u.carrying.res === 'stone' && pl.mods.flags.has('stoneGold')) pl.give('gold', u.carrying.amount * 0.35);
    if (u.carrying.sub === 'farm' && pl.mods.flags.has('farmGold')) pl.give('gold', u.carrying.amount * 0.25);
    u.carrying.amount = 0;
    // A shift-queued follow-up takes priority over looping back to the resource,
    // so "gather here, then go mine gold" behaves the way the player expects.
    if (u.orders && u.orders.length) { u.task = { type: 'idle' }; return; }
    // Go back to whatever we were working. `_amountOf` is used rather than
    // `.amount` so Farms (buildings, which keep their food in `farmFood`) are
    // handled too - reading `.amount` off a farm gives undefined, so the farmer
    // would wander off to another food source after its very first delivery.
    const back = this.get(u.task.returnTo);
    if (back && back.alive && this._amountOf(back) > 0 &&
        (!this._isFarm(back) || !this._farmWorker(back) || this._farmWorker(back) === u)) {
      u.task = { type: 'gather', targetId: back.id, resType: u.task.resType };
      return;
    }
    const next = this._findSameResourceNearby(u, u.task.resType);
    u.task = next ? { type: 'gather', targetId: next.id, resType: u.task.resType } : { type: 'idle' };
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
      if (u.orders && u.orders.length) { u.task = { type: 'idle' }; return; }
      // chain to the next foundation nearby, matching AoE2 villager behaviour
      const next = this.entityGrid.nearest(u.x, u.y, 8, (e) =>
        e.kind === 'building' && e.owner === u.owner && !e.complete);
      u.task = next ? { type: 'build', targetId: next.id } : { type: 'idle' };
      return;
    }
    if (this._distTo(u, b) > 1.3) { this._approach(u, b, 1.0, dt); return; }
    u.moving = false; u.path = null;
    b.buildersThisTick++;
    u.building = true;
  }

  _taskRepair(u, dt) {
    const b = this.get(u.task.targetId);
    if (!b || !b.alive || b.hp >= b.maxHp) { u.task = { type: 'idle' }; return; }
    if (this._distTo(u, b) > 1.3) { this._approach(u, b, 1.0, dt); return; }
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
    if (this._distTo(u, b) > 1.25) { this._approach(u, b, 1.0, dt); return; }
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
    if (this._distTo(u, dest) > 1.3) { this._approach(u, dest, 1.0, dt); return; }
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
      if (this._distTo(u, mon) > 1.3) { this._approach(u, mon, 1.0, dt); return; }
      u.carryingRelic = false;
      mon.relics = (mon.relics || 0) + 1;
      this.players[u.owner].relics++;
      u.task = { type: 'idle' };
      return;
    }
    if (!relic || !relic.alive) { u.task = { type: 'idle' }; return; }
    if (this._distTo(u, relic) > 1.1) { this._approach(u, relic, 0.8, dt); return; }
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
          this._onBuildingComplete(b);
        }
      }
      b.buildersThisTick = 0;
      return;
    }
    b.buildersThisTick = 0;

    // Farms behave as a finite food source that villagers work. When exhausted
    // they are re-sown if the player can pay for it, otherwise the plot is lost.
    if (b.def.farmFood) {
      if (b.farmFood <= 0 && !this._tryReseedFarm(b)) this.kill(b, null);
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

  /**
   * The moment a building finishes, put its builders to work on whatever that
   * building was for: a Lumber Camp means trees, a Mill means food, a Mining
   * Camp means gold, and a Farm means that farm. Saves the constant
   * re-tasking of villagers that just dropped a drop-site next to a resource.
   */
  _onBuildingComplete(b) {
    // `claimed` is shared across the builders so the second villager cannot be
    // handed the same plot as the first: b.farmer is only set once a villager
    // actually starts gathering, which is too late for this loop.
    const claimed = new Set();
    for (const u of this.entities) {
      if (!u.alive || u.kind !== 'unit' || u.owner !== b.owner) continue;
      if (u.def.cat !== 'villager') continue;
      if (u.task.type !== 'build' || u.task.targetId !== b.id) continue;
      if (u.orders && u.orders.length) continue;   // an explicit queue wins
      this._assignWorkFor(u, b, claimed);
    }
  }

  /** Nearest unfinished farm of this player that nobody is currently building. */
  _nearestUnbuiltFarm(u, claimed) {
    const skip = claimed instanceof Set ? claimed : null;
    let best = null, bestD = Infinity;
    for (const e of this.entities) {
      if (!e.alive || !this._isFarm(e) || e.complete || e.owner !== u.owner) continue;
      if (skip && skip.has(e.id)) continue;
      let busy = this.buildClaims.get(e.id) || 0;
      if (u.task.type === 'build' && u.task.targetId === e.id) busy--;
      if (busy > 0) continue;
      const d = this._distTo(u, e);
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  /** Nearest completed building of this player that accepts a resource. */
  _nearestDropSite(u, res) {
    let best = null, bestD = Infinity;
    for (const e of this.entities) {
      if (!e.alive || e.kind !== 'building' || e.owner !== u.owner || !e.complete) continue;
      if (!e.def.dropSite || !e.def.dropSite.includes(res)) continue;
      const d = this._distTo(u, e);
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  /**
   * Puts a villager to work farming: an idle plot if one exists, otherwise a
   * brand new plot laid beside the nearest food drop-off. This is what stops
   * spare builders from going idle - if several villagers build one farm, only
   * one can work it, so the others go and make their own.
   */
  _assignFarmWork(u, near, claimed) {
    const pl = this.players[u.owner];
    if (!pl) return false;
    const free = this._findFreeFarm(u, claimed);
    if (free) {
      if (claimed instanceof Set) claimed.add(free.id);
      u.task = { type: 'gather', targetId: free.id, resType: 'food' };
      u.repathCd = 0;
      return true;
    }
    // Join a plot somebody already paid for before laying another. Without
    // this, every villager that finishes a farm starts a fresh one, and since
    // finishing that one frees another villager the cycle runs away: one game
    // ended up with 30 plots and 8 farmers, with all the wood gone into them.
    const pending = this._nearestUnbuiltFarm(u, claimed);
    if (pending) {
      if (claimed instanceof Set) claimed.add(pending.id);
      u.task = { type: 'build', targetId: pending.id };
      u.repathCd = 0;
      return true;
    }
    const site = near || this._nearestDropSite(u, 'food');
    if (!site) return false;
    const def = pl.mods.building('farm');
    if (!pl.canAfford(def.cost)) return false;
    const spot = this._nearestFarmSpot(site, u.owner, []);
    if (!spot) return false;
    pl.spend(def.cost);
    const b = this.placeBuilding('farm', u.owner, spot.x, spot.y, false);
    u.task = { type: 'build', targetId: b.id };
    u.repathCd = 0;
    return true;
  }

  /** Picks the natural follow-up job for a villager that just built `b`. */
  _assignWorkFor(u, b, claimed) {
    if (this._isFarm(b)) {
      // The first builder keeps the plot it just finished; everyone else goes
      // and finds - or lays - a plot of their own instead of standing idle.
      if (!this._farmWorker(b) && !(claimed && claimed.has(b.id))) {
        if (claimed) claimed.add(b.id);
        u.task = { type: 'gather', targetId: b.id, resType: 'food' };
        return true;
      }
      return this._assignFarmWork(u, this._nearestDropSite(u, 'food') || b, claimed);
    }
    const wants = {
      lumberCamp: ['wood'],
      mill: ['food'],
      miningCamp: ['gold', 'stone'],
      dock: ['food'],
    }[b.type];
    if (!wants) return false;

    for (const res of wants) {
      // generous radius: a drop site is often planted at the edge of a patch,
      // and going idle beside a fresh Lumber Camp is the worst possible outcome
      const node = this._nearestWorkable(b.x, b.y, u, res, 32);
      if (node) {
        u.task = { type: 'gather', targetId: node.id, resType: res };
        u.repathCd = 0;
        return true;
      }
    }
    return false;
  }

  /**
   * Nearest thing a villager can gather for `res`, searched around a point
   * (normally the drop site, so they work the pile beside the camp). Covers
   * resource nodes, huntable wildlife and free farms.
   */
  _nearestWorkable(x, y, u, res, radius) {
    let best = null, bestD = Infinity;
    const consider = (e, d) => { if (d < bestD) { bestD = d; best = e; } };
    for (const e of this.entities) {
      if (!e.alive) continue;
      let ok = false;
      if (e.kind === 'resource' && e.amount > 0 && e.type !== 'relic') {
        ok = e.resType === res && !(RESOURCE_INFO[e.type]?.water && u.def.domain !== 'water');
      } else if (res === 'food' && e.kind === 'unit' && e.owner < 0 &&
                 e.def.huntable && !e.def.hostile) {
        ok = true;
      } else if (res === 'food' && this._isFarm(e) && e.owner === u.owner &&
                 e.complete && e.farmFood > 0 && !this._farmWorker(e)) {
        ok = true;
      }
      if (!ok) continue;
      const d = Math.hypot(e.x - x, e.y - y);
      if (d <= radius) consider(e, d);
    }
    return best;
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
    this.grantFreeTechs(pl);
    this.refreshDefs(pl.index);
  }

  /**
   * Hands a player the technologies their civilisation gets for nothing - the
   * Bulgarian Militia line, the Magyar Light Cavalry and Hussar, free Farm or
   * Lumber Camp upgrades, and so on.
   *
   * Two rules matter here. They only arrive once the tech is genuinely
   * available: previously the whole set was granted the moment *any* research
   * finished, so Bulgarians who researched Loom in the Dark Age instantly held
   * Champion and their Militia turned into Champions on the spot. And they are
   * granted in dependency order, looping until nothing more unlocks, because
   * Long Swordsman only becomes available once Man-at-Arms has landed.
   */
  grantFreeTechs(pl) {
    for (let pass = 0; pass < 8; pass++) {
      let granted = 0;
      for (const freeId of pl.mods.freeTechs) {
        if (pl.researched.has(freeId) || !TECHS[freeId]) continue;
        if (!pl.isTechAvailable(freeId)) continue;   // wrong age, or line not reached
        pl.researched.add(freeId);
        pl.mods.add(TECHS[freeId].effects);
        for (const e of TECHS[freeId].effects) {
          if (e.k === 'unitUpgrade') this._upgradeUnits(pl, e.from, e.to);
          if (e.k === 'buildingUpgrade') this._upgradeBuildings(pl, e.from, e.to);
        }
        pl.notify(`${TECHS[freeId].name} (free)`);
        granted++;
      }
      if (!granted) break;
    }
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

  /**
   * Central command entry point. `queue` (shift held) appends to the unit's
   * order list instead of replacing it; without it the queue is cleared and the
   * order starts immediately, which is the classic RTS contract.
   */
  issueCommands(units, makeOrder, queue) {
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (!u || !u.alive || u.garrisonedIn) continue;
      const order = makeOrder(u, i);
      if (!order) continue;
      if (!u.orders) u.orders = [];
      if (queue) u.orders.push(order);
      else { u.orders.length = 0; this._startOrder(u, order); }
    }
  }

  /** Turns a queued order back into a live task. */
  _startOrder(u, o) {
    u.repathCd = 0;
    // A fresh order is not responsible for the last one's failures.
    u.moveTries = 0;
    // Drop the route the previous order left behind - but only for the orders
    // that do not immediately ask for a new one.
    //
    // `move`, `attackMove` and `patrol` call `requestPath` below, which replaces
    // the route anyway; clearing it first only makes `_taskMove` see a missing
    // path, request a *second* one, and burn a retry doing it. Five of those and
    // it gives up and goes idle, which is how this turned into villagers
    // standing around.
    //
    // Every other order just swapped the task and let the old path stand.
    // `_approach` reuses a path until it runs out of waypoints, so a unit
    // re-targeted onto something new first walked all the way to wherever the
    // *old* target had been and only then noticed. That is the bug this exists
    // to fix, and it hit villagers re-tasked onto a different resource exactly
    // as hard as soldiers given a new target mid-fight.
    //
    // And only when it is genuinely heading elsewhere. Re-tasking a villager
    // onto the next tree in the same woodline must not throw away a route it
    // has nearly finished walking - the AI re-tasks constantly, and clearing
    // every time floods the path queue and leaves villagers standing about
    // waiting for a search that the old path had already done.
    if (o.type !== 'move' && o.type !== 'attackMove' && o.type !== 'patrol') {
      const t = o.targetId !== undefined ? this.get(o.targetId) : null;
      const end = u.path && u.path.length ? u.path[u.path.length - 1] : null;
      if (!t || !end || Math.hypot(end.x - t.x, end.y - t.y) > 3) {
        u.path = null;
        u.pathIdx = 0;
      }
    }
    switch (o.type) {
      case 'move':
        u.task = { type: 'move', x: o.x, y: o.y };
        this.requestPath(u, { x: o.x, y: o.y, radius: 0 });
        break;
      case 'attackMove':
        u.task = { type: 'attackMove', x: o.x, y: o.y };
        this.requestPath(u, { x: o.x, y: o.y, radius: 0 });
        break;
      case 'patrol':
        u.task = { type: 'patrol', ax: u.x, ay: u.y, bx: o.x, by: o.y, leg: 1 };
        this.requestPath(u, { x: o.x, y: o.y, radius: 0 });
        break;
      case 'attack': {
        const t = this.get(o.targetId);
        if (!t) { u.task = { type: 'idle' }; break; }
        if (u.def.converts && this.isEnemy(u.owner, t.owner)) u.task = { type: 'convert', targetId: t.id };
        else u.task = { type: 'attack', targetId: t.id };
        break;
      }
      case 'gather': u.task = { type: 'gather', targetId: o.targetId, resType: o.resType }; break;
      case 'build': u.task = { type: 'build', targetId: o.targetId }; break;
      case 'repair': u.task = { type: 'repair', targetId: o.targetId }; break;
      case 'garrison': u.task = { type: 'garrison', targetId: o.targetId }; break;
      case 'heal': u.task = { type: 'heal', targetId: o.targetId }; break;
      case 'relic': u.task = { type: 'relic', targetId: o.targetId }; break;
      case 'trade': u.task = { type: 'trade', marketId: o.targetId, homeId: o.homeId, outbound: true }; break;
      default: u.task = { type: 'idle' }; break;
    }
  }

  /**
   * Spreads a group's destination over a loose grid so units do not all
   * converge on one tile and shove each other. Slots are handed out nearest
   * first, which roughly preserves the group's existing arrangement.
   */
  _formationSlots(units, x, y) {
    const n = units.length;
    if (n <= 1) {
      // A single unit still has to be given a tile it can actually stand on.
      // Skipping the clamp here is what stranded every villager produced from a
      // Town Center whose rally point sat on the building's own footprint: the
      // arrival check needs to get within 0.6 of a tile A* will never reach, so
      // the villager re-pathed every 0.6s for the rest of the game.
      const open = units.length ? this.grid.nearestOpen(x, y, units[0].def.domain, 4) : null;
      return [open || { x, y }];
    }
    const spacing = 0.95;
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const slots = [];
    for (let i = 0; i < n; i++) {
      const r = Math.floor(i / cols), c = i % cols;
      const ox = (c - (cols - 1) / 2) * spacing;
      const oy = (r - (rows - 1) / 2) * spacing;
      const open = this.grid.nearestOpen(x + ox, y + oy, units[0].def.domain, 4);
      slots.push(open || { x: x + ox, y: y + oy });
    }
    // greedy nearest assignment so the formation does not cross over itself
    const out = new Array(n);
    const taken = new Array(n).fill(false);
    const order = units.map((u, i) => i)
      .sort((a, b) => Math.hypot(units[a].x - x, units[a].y - y) - Math.hypot(units[b].x - x, units[b].y - y));
    for (const ui of order) {
      let best = -1, bestD = Infinity;
      for (let s = 0; s < n; s++) {
        if (taken[s]) continue;
        const d = Math.hypot(slots[s].x - units[ui].x, slots[s].y - units[ui].y);
        if (d < bestD) { bestD = d; best = s; }
      }
      taken[best] = true;
      out[ui] = slots[best];
    }
    return out;
  }

  commandMove(units, x, y, queue) {
    const slots = this._formationSlots(units, x, y);
    this.issueCommands(units, (u, i) => ({ type: 'move', x: slots[i].x, y: slots[i].y }), queue);
  }

  commandAttackMove(units, x, y, queue) {
    const slots = this._formationSlots(units, x, y);
    this.issueCommands(units, (u, i) => ({ type: 'attackMove', x: slots[i].x, y: slots[i].y }), queue);
  }

  commandPatrol(units, x, y, queue) {
    this.issueCommands(units, () => ({ type: 'patrol', x, y }), queue);
  }

  commandAttack(units, target, queue) {
    this.issueCommands(units, (u) => {
      if (u.def.cat === 'villager' && target.kind === 'building' && this.isAlly(u.owner, target.owner)) {
        return { type: target.complete ? 'repair' : 'build', targetId: target.id };
      }
      return { type: 'attack', targetId: target.id };
    }, queue);
  }

  commandGather(units, res, queue) {
    const resType = res.kind === 'unit' ? 'food' : res.resType;
    const target = this.get(res.id) || res;

    // A Farm holds a single villager. Send the nearest one to the plot that was
    // clicked and fan the rest out over other free plots, instead of piling
    // everybody onto one farm where all but one would immediately bounce off.
    if (this._isFarm(target)) {
      const elig = units.filter((u) => u && u.alive && u.def.cat === 'villager' && !u.garrisonedIn);
      if (!elig.length) return;
      elig.sort((a, b) => this._distTo(a, target) - this._distTo(b, target));
      const taken = new Set([target.id]);
      this.issueCommands([elig[0]], () => ({ type: 'gather', targetId: target.id, resType: 'food' }), queue);
      for (let i = 1; i < elig.length; i++) {
        const free = this._findFreeFarm(elig[i], taken);
        if (!free) continue;
        taken.add(free.id);
        this.issueCommands([elig[i]], () => ({ type: 'gather', targetId: free.id, resType: 'food' }), queue);
      }
      return;
    }

    this.issueCommands(units, (u) => {
      if (u.def.cat !== 'villager' && u.def.cat !== 'naval') return null;
      if (res.kind === 'resource' && res.type === 'relic') return null;
      return { type: 'gather', targetId: res.id, resType };
    }, queue);
  }

  commandBuild(units, bId, tx, ty, queue) {
    if (!units.length) return null;
    const owner = units[0].owner;
    const pl = this.players[owner];
    const def = pl.mods.building(bId);
    if (!pl.canAfford(def.cost)) { pl.notify('Not enough resources'); return null; }
    if (!this.canPlaceBuilding(bId, owner, tx, ty)) { pl.notify('Cannot build there'); return null; }
    pl.spend(def.cost);
    const b = this.placeBuilding(bId, owner, tx, ty, false);
    this.issueCommands(units, (u) =>
      u.def.cat === 'villager' ? { type: 'build', targetId: b.id } : null, queue);
    return b;
  }

  /** Nearest free, completed farm to a building, ignoring already-claimed ids. */
  _findFreeFarmNear(building, owner, claimed, radius) {
    let best = null, bestD = Infinity;
    for (const e of this.entities) {
      if (!e.alive || !this._isFarm(e) || e.owner !== owner) continue;
      if (!e.complete || e.farmFood <= 0 || claimed.has(e.id)) continue;
      if (this._farmWorker(e)) continue;
      const d = Math.hypot(e.x - building.x, e.y - building.y);
      if (d <= radius && d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  /**
   * Closest placeable farm footprint to a building.
   * `taken` holds footprints reserved earlier in the same command: the entity
   * spatial grid is only rebuilt once per tick, so canPlaceBuilding cannot see
   * farms placed moments ago and every plot would land on the same tile.
   */
  /**
   * @param reject optional (x, y) => boolean to veto a spot. The AI uses it to
   *        keep plots out of an enemy Castle's range and off ground where its
   *        villagers have recently been killed; the human UI passes nothing.
   */
  _nearestFarmSpot(building, owner, taken, reject) {
    const size = this.players[owner].mods.building('farm').size;
    const cx = building.x, cy = building.y;
    const R = 11;
    let best = null, bestD = Infinity;
    for (let ty = Math.round(cy - R); ty <= Math.round(cy + R); ty++) {
      for (let tx = Math.round(cx - R); tx <= Math.round(cx + R); tx++) {
        const d = Math.hypot(tx + size / 2 - cx, ty + size / 2 - cy);
        if (d >= bestD) continue;
        if (taken.some((r) => tx < r.x + r.s && tx + size > r.x &&
                              ty < r.y + r.s && ty + size > r.y)) continue;
        if (!this.canPlaceBuilding('farm', owner, tx, ty)) continue;
        if (reject && reject(tx + size / 2, ty + size / 2)) continue;
        bestD = d; best = { x: tx, y: ty, s: size };
      }
    }
    return best;
  }

  /**
   * Lays out farms around a food drop-off building and puts one villager on
   * each: the bulk "make my farms" action. Reuses any idle plots already there
   * before spending wood on new ones.
   * @returns number of villagers given work
   */
  /**
   * Works out exactly what commandFarmAround would do, WITHOUT placing anything
   * or spending resources. The UI runs this on hover to preview the plots, and
   * the command itself executes the same plan - so what you see is precisely
   * what you get, rather than two implementations that can drift apart.
   * @returns array of { villager, kind:'new'|'reuse', ... }
   */
  planFarmsAround(units, building) {
    const owner = building.owner;
    const pl = this.players[owner];
    const plan = [];
    if (!pl) return plan;
    const villagers = units.filter((u) =>
      u && u.alive && u.owner === owner && u.def.cat === 'villager' && !u.garrisonedIn);
    if (!villagers.length) return plan;

    // work outward from the building so the nearest villagers take the nearest plots
    villagers.sort((a, b) => this._distTo(a, building) - this._distTo(b, building));

    const def = pl.mods.building('farm');
    const claimed = new Set();
    const taken = [];
    let woodLeft = pl.res.wood;          // simulated spend; farms cost wood only

    for (const u of villagers) {
      const free = this._findFreeFarmNear(building, owner, claimed, 12);
      if (free) {
        claimed.add(free.id);
        plan.push({ villager: u, kind: 'reuse', farm: free });
        continue;
      }
      if (woodLeft < (def.cost.wood || 0)) { plan.blockedBy = 'wood'; break; }
      const spot = this._nearestFarmSpot(building, owner, taken);
      if (!spot) { plan.blockedBy = 'room'; break; }
      taken.push(spot);
      woodLeft -= def.cost.wood || 0;
      plan.push({ villager: u, kind: 'new', x: spot.x, y: spot.y, size: spot.s });
    }
    return plan;
  }

  commandFarmAround(units, building, queue) {
    const pl = this.players[building.owner];
    if (!pl) return 0;
    const plan = this.planFarmsAround(units, building);
    const def = pl.mods.building('farm');
    let assigned = 0;

    for (const step of plan) {
      if (step.kind === 'reuse') {
        this.issueCommands([step.villager],
          () => ({ type: 'gather', targetId: step.farm.id, resType: 'food' }), queue);
      } else {
        if (!pl.canAfford(def.cost)) break;
        pl.spend(def.cost);
        const b = this.placeBuilding('farm', building.owner, step.x, step.y, false);
        this.issueCommands([step.villager], () => ({ type: 'build', targetId: b.id }), queue);
      }
      assigned++;
    }
    if (plan.blockedBy === 'wood') pl.notify('Not enough wood for more Farms');
    else if (plan.blockedBy === 'room') pl.notify('No room for more Farms here');
    return assigned;
  }

  /** Send villagers to help finish an existing foundation. */
  commandBuildAt(units, building, queue) {
    this.issueCommands(units, (u) =>
      u.def.cat === 'villager' ? { type: 'build', targetId: building.id } : null, queue);
  }

  commandGarrison(units, building, queue) {
    this.issueCommands(units, () => ({ type: 'garrison', targetId: building.id }), queue);
  }

  commandRepair(units, building, queue) {
    this.issueCommands(units, (u) =>
      u.def.cat === 'villager' ? { type: 'repair', targetId: building.id } : null, queue);
  }

  commandRelic(units, relic, queue) {
    this.issueCommands(units, (u) =>
      u.def.converts ? { type: 'relic', targetId: relic.id } : null, queue);
  }

  commandHeal(units, target, queue) {
    this.issueCommands(units, (u) =>
      u.def.converts ? { type: 'heal', targetId: target.id } : null, queue);
  }

  commandTrade(units, market, queue) {
    this.issueCommands(units, (u) => {
      if (u.def.cat !== 'trade') return null;
      const home = this.entityGrid.nearest(u.x, u.y, 80, (e) =>
        e.kind === 'building' && e.owner === u.owner && e.type === 'market' && e.complete);
      if (!home) return null;
      return { type: 'trade', targetId: market.id, homeId: home.id };
    }, queue);
  }

  /** Stop: cancels the current task AND the whole queued order list. */
  commandStop(units) {
    for (const u of units) {
      u.task = { type: 'idle' };
      if (u.orders) u.orders.length = 0;
      u.path = null;
      u.moving = false;
    }
  }

  /** Escape: keeps the current action, drops everything queued behind it. */
  clearQueue(units) {
    for (const u of units) if (u.orders) u.orders.length = 0;
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

  /** Seconds of work already queued at a building before a new item would start. */
  queueWaitTime(b) {
    let t = 0;
    for (const item of b.queue) t += Math.max(0, item.timeLeft);
    return t;
  }

  /** Can this building train this unit (including a Castle's own unique unit)? */
  canTrainAt(b, unitId) {
    if (!b.complete) return false;
    if (b.def.trains.includes(unitId)) return true;
    const pl = this.players[b.owner];
    if (!pl) return false;
    if ((b.type === 'castle' || b.type === 'krepost' || b.type === 'donjon') &&
        (unitId === pl.civ.uu || unitId === pl.civ.uuElite)) return true;
    return pl.mods.extraTrainers.some((x) => x.building === b.type && x.unit === unitId);
  }

  /**
   * Queues `count` of a unit across several buildings, each time picking the one
   * that would start it soonest. A Stable part-way through a technology is
   * skipped in favour of an idle one, so a batch finishes as early as possible
   * instead of piling onto whichever building happened to be first.
   * @returns {{queued:number, spread:number[]}} how many, and where
   */
  queueUnitSpread(buildings, unitId, count = 1) {
    const eligible = buildings.filter((b) => b.alive && this.canTrainAt(b, unitId));
    if (!eligible.length) return { queued: 0, spread: [] };
    // local wait estimate so repeated picks in one batch account for each other
    const wait = new Map(eligible.map((b) => [b.id, this.queueWaitTime(b)]));
    const spread = new Map();
    const def = this.players[eligible[0].owner].mods.unit(unitId);
    let queued = 0;

    for (let i = 0; i < count; i++) {
      let best = null, bestW = Infinity;
      for (const b of eligible) {
        const w = wait.get(b.id);
        if (w < bestW) { bestW = w; best = b; }
      }
      if (!best || !this.queueUnit(best, unitId)) break;
      wait.set(best.id, bestW + def.time);
      spread.set(best.id, (spread.get(best.id) || 0) + 1);
      queued++;
    }
    return { queued, spread: [...spread.values()] };
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

  /**
   * Sends resources to an ally, minus the market fee.
   *
   * Both sides need a Market, which is what stops this from being a free
   * resource teleport in the Dark Age. The fee is the sender's - Coinage and
   * Banking are worth buying partly because they make you a better ally.
   * @returns the amount actually delivered, or 0
   */
  tribute(fromIndex, toIndex, res, amount) {
    const from = this.players[fromIndex];
    const to = this.players[toIndex];
    if (!from || !to || from === to || to.defeated) return 0;
    if (!this.isAlly(fromIndex, toIndex)) return 0;
    const amt = Math.min(amount, from.res[res] || 0);
    if (amt < 100) return 0;                    // 100 at a time, like the Market
    const hasMarket = (pl) => this.entities.some((e) =>
      e.alive && e.kind === 'building' && e.owner === pl.index && e.type === 'market' && e.complete);
    if (!hasMarket(from) || !hasMarket(to)) return 0;
    const sent = Math.round(amt * (1 - from.mods.marketFee));
    from.res[res] -= amt;
    to.give(res, sent);
    to.notify(`${from.name} sent ${sent} ${res}`);
    return sent;
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
