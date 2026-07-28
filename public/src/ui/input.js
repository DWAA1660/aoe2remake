// Mouse + keyboard: selection, contextual orders, building placement, hotkeys,
// control groups and camera control.

import { BUILD_MENU } from '../data/buildings.js';

const EDGE = 18;          // screen-edge pan margin in px
const PAN_SPEED = 24;     // tiles per second at zoom 22

export class Input {
  constructor(ctx) {
    this.ctx = ctx;
    this.game = ctx.game;
    this.renderer = ctx.renderer;
    this.playerIndex = ctx.playerIndex;
    this.player = this.game.players[this.playerIndex];

    this.selection = [];
    this.controlGroups = new Map();
    this.cursorMode = null;
    this.placement = null;
    this.dragStart = null;
    this.dragNow = null;
    this.mouse = { x: 0, y: 0, inWindow: true };
    this.keys = new Set();
    this.idleVillagerIdx = 0;
    this.idleMilitaryIdx = 0;
    this.lastClickTime = 0;
    this.lastClickEntity = null;

    this.boxEl = document.getElementById('selbox');
    this.canvas = ctx.canvas;
    this._bind();
  }

  get hud() { return this.ctx.hud; }

  /**
   * True while watching an AI-vs-AI match. Selection, the camera and the
   * minimap all stay live - the point is to inspect what the AI is doing - but
   * every path that issues an order is blocked, so the viewer cannot quietly
   * play for the side they are watching.
   */
  get spectator() { return !!this.ctx.spectator; }

  _bind() {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('mousedown', (e) => this._onMouseDown(e));
    window.addEventListener('mouseup', (e) => this._onMouseUp(e));
    window.addEventListener('mousemove', (e) => this._onMouseMove(e));
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.renderer.setZoom(this.renderer.zoom * (e.deltaY > 0 ? 1.12 : 0.89));
    }, { passive: false });
    window.addEventListener('keydown', (e) => this._onKeyDown(e));
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      // pressing/releasing Shift toggles the preview without moving the mouse
      if (e.code.startsWith('Shift')) { this._previewKey = null; this.updateFarmPreview(); this._updatePlacement(); }
    });
    window.addEventListener('blur', () => {
      this.keys.clear();
      this._previewKey = null;
      this.updateFarmPreview();
    });
    document.addEventListener('mouseleave', () => { this.mouse.inWindow = false; });
    document.addEventListener('mouseenter', () => { this.mouse.inWindow = true; });
  }

  /* ================================================================
   *  Mouse
   * ================================================================ */

  _onMouseDown(e) {
    if (this.hud?.modalOpen) return;
    const pt = { x: e.clientX, y: e.clientY };
    if (e.button === 0) {
      if (this.placement) { this._placeBuilding(e.shiftKey); return; }
      if (this.cursorMode) { this._applyCursorMode(pt, e.shiftKey); return; }
      if (e.shiftKey && this._tryMassFarm(pt)) return;
      this.dragStart = pt;
      this.dragNow = pt;
    } else if (e.button === 2) {
      if (this.placement) { this.cancelPlacement(); return; }
      if (this.cursorMode) { this.cursorMode = null; document.body.style.cursor = ''; return; }
      this._rightClick(pt, e.shiftKey);
    } else if (e.button === 1) {
      this.middlePan = pt;
    }
  }

  _onMouseMove(e) {
    this.mouse.x = e.clientX;
    this.mouse.y = e.clientY;
    this.mouse.inWindow = true;
    if (this.dragStart) {
      this.dragNow = { x: e.clientX, y: e.clientY };
      this._updateBox();
    }
    if (this.middlePan) {
      const dx = e.clientX - this.middlePan.x;
      const dy = e.clientY - this.middlePan.y;
      this.middlePan = { x: e.clientX, y: e.clientY };
      const k = this.renderer.zoom / 400;
      this.renderer.panBy(-dx * k, -dy * k);
    }
    if (this.placement) this._updatePlacement();
    this.updateFarmPreview();
  }

  _onMouseUp(e) {
    if (e.button === 1) { this.middlePan = null; return; }
    if (e.button !== 0 || !this.dragStart) return;
    const a = this.dragStart, b = this.dragNow || this.dragStart;
    this.dragStart = null;
    this.boxEl.style.display = 'none';
    const w = Math.abs(a.x - b.x), h = Math.abs(a.y - b.y);
    if (w < 5 && h < 5) this._singleClick(a, e.shiftKey, e.detail >= 2 || this._isDoubleClick());
    else this._boxSelect(a, b, e.shiftKey);
  }

  _isDoubleClick() {
    const now = performance.now();
    const dbl = now - this.lastClickTime < 320;
    this.lastClickTime = now;
    return dbl;
  }

  _updateBox() {
    const a = this.dragStart, b = this.dragNow;
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    const w = Math.abs(a.x - b.x), h = Math.abs(a.y - b.y);
    if (w < 4 && h < 4) { this.boxEl.style.display = 'none'; return; }
    this.boxEl.style.display = 'block';
    this.boxEl.style.left = x + 'px';
    this.boxEl.style.top = y + 'px';
    this.boxEl.style.width = w + 'px';
    this.boxEl.style.height = h + 'px';
  }

  /* ---------------- picking ---------------- */

  /** Screen-space pick: projects visible entities and takes the nearest. */
  pickAt(sx, sy, maxDist = 34) {
    const g = this.game;
    let best = null, bestD = maxDist * maxDist, bestPri = -1;
    for (const e of g.entities) {
      if (!e.alive || e.kind === 'projectile' || e.garrisonedIn) continue;
      const visible = g.revealAll ||
        (e.kind === 'building' || e.kind === 'resource'
          ? this.player.hasExplored(e.x | 0, e.y | 0)
          : this.player.canSee(e.x | 0, e.y | 0));
      if (!visible) continue;
      const h = this.renderer.heightAt(e.x, e.y) + (e.kind === 'building' ? e.size * 0.35 : 0.4);
      const p = this.renderer.worldToScreen(e.x, h, e.y);
      if (p.z > 1 || p.z < -1) continue;
      const dx = p.x - sx, dy = p.y - sy;
      const d = dx * dx + dy * dy;
      const pri = e.kind === 'unit' ? 3 : e.kind === 'building' ? 2 : 1;
      const radiusPx = e.kind === 'building' ? e.size * 16 : 22;
      if (d > radiusPx * radiusPx) continue;
      if (pri > bestPri || (pri === bestPri && d < bestD)) {
        best = e; bestD = d; bestPri = pri;
      }
    }
    return best;
  }

  /**
   * Buildings-only pick. The general picker ranks units above buildings, so
   * clicking a Mill with villagers milling around it returns a villager - no
   * good when the whole point is to target the building.
   */
  _pickBuilding(sx, sy) {
    let best = null, bestD = Infinity;
    for (const e of this.game.entities) {
      if (!e.alive || e.kind !== 'building') continue;
      if (!this.game.revealAll && !this.player.hasExplored(e.x | 0, e.y | 0)) continue;
      const h = this.renderer.heightAt(e.x, e.y) + e.size * 0.35;
      const p = this.renderer.worldToScreen(e.x, h, e.y);
      if (p.z > 1) continue;
      const dx = p.x - sx, dy = p.y - sy;
      const d = dx * dx + dy * dy;
      const r = Math.max(26, e.size * 20);
      if (d > r * r || d >= bestD) continue;
      bestD = d; best = e;
    }
    return best;
  }

  /**
   * Shift + click a food drop-off building with villagers selected: lay one
   * farm per villager around it. Bound to BOTH mouse buttons, because "shift
   * click the Mill" is equally natural with either and having it work on only
   * one reads as the feature being broken.
   * @returns true if it handled the click
   */
  /**
   * Live preview of a shift-click farm layout while hovering a food drop-site.
   * Planning scans a wide area per villager, so it is throttled and only redone
   * when something that affects the answer actually changed.
   */
  updateFarmPreview() {
    const r = this.renderer;
    const shift = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    if (!shift || this.placement || this.hud?.modalOpen) {
      if (r.farmPreview) { r.farmPreview = null; this._previewKey = null; }
      return;
    }
    const vills = this.selection.filter((e) =>
      e.alive && e.owner === this.playerIndex && e.kind === 'unit' && e.def.cat === 'villager');
    const b = vills.length ? this._pickBuilding(this.mouse.x, this.mouse.y) : null;
    const ok = b && b.owner === this.playerIndex && b.complete &&
      b.def.dropSite && b.def.dropSite.includes('food');
    if (!ok) {
      if (r.farmPreview) { r.farmPreview = null; this._previewKey = null; }
      return;
    }

    const key = `${b.id}:${vills.length}:${Math.floor(this.player.res.wood / 60)}`;
    const now = performance.now();
    if (key === this._previewKey && now - (this._previewAt || 0) < 400) return;
    this._previewKey = key;
    this._previewAt = now;

    const plan = this.game.planFarmsAround(vills, b);
    r.farmPreview = plan.map((p) => p.kind === 'new'
      ? { tx: p.x, ty: p.y, size: p.size, reuse: false }
      : { tx: p.farm.tx, ty: p.farm.ty, size: p.farm.size, reuse: true });
  }

  _tryMassFarm(pt) {
    if (this.spectator) return false;
    const vills = this.selection.filter((e) =>
      e.owner === this.playerIndex && e.kind === 'unit' && e.def.cat === 'villager');
    if (!vills.length) return false;
    const b = this._pickBuilding(pt.x, pt.y);
    if (!b || b.owner !== this.playerIndex || !b.complete) return false;
    if (!b.def.dropSite || !b.def.dropSite.includes('food')) return false;

    const n = this.game.commandFarmAround(vills, b, false);
    this.player.notify(n
      ? `${n} villager${n > 1 ? 's' : ''} sent to farm around the ${b.def.name}`
      : 'No room or not enough wood for farms here');
    this._feedback(b.x, b.y, 'food', false);
    return true;
  }

  _singleClick(pt, additive, isDouble) {
    const hit = this.pickAt(pt.x, pt.y);
    if (!hit) { if (!additive) this.setSelection([]); return; }
    if (isDouble && hit.kind === 'unit' && hit.owner === this.playerIndex) {
      // select every visible unit of the same type
      const same = [];
      for (const e of this.game.entities) {
        if (e.alive && e.kind === 'unit' && e.owner === this.playerIndex && e.type === hit.type) {
          const p = this.renderer.worldToScreen(e.x, 0, e.y);
          if (p.x > 0 && p.x < this.renderer.viewW && p.y > 0 && p.y < this.renderer.viewH) same.push(e);
        }
      }
      this.setSelection(same);
      return;
    }
    if (additive) {
      if (this.selection.includes(hit)) this.setSelection(this.selection.filter((e) => e !== hit));
      else this.setSelection([...this.selection, hit]);
    } else {
      this.setSelection([hit]);
    }
  }

  _boxSelect(a, b, additive) {
    const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
    const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
    const found = [];
    for (const e of this.game.entities) {
      if (!e.alive || e.kind !== 'unit' || e.garrisonedIn) continue;
      if (e.owner !== this.playerIndex) continue;
      if (!this.game.revealAll && !this.player.canSee(e.x | 0, e.y | 0)) continue;
      const p = this.renderer.worldToScreen(e.x, this.renderer.heightAt(e.x, e.y) + 0.4, e.y);
      if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) found.push(e);
    }
    // Box select takes everything the player owns inside it, soldiers and
    // villagers alike; shift-drag adds to the existing selection.
    this.setSelection(additive ? dedupe([...this.selection, ...found]) : found);
  }

  setSelection(list) {
    for (const e of this.selection) e.selected = false;
    this.selection = list.filter((e) => e && e.alive);
    for (const e of this.selection) e.selected = true;
    if (this.hud) this.hud.cardMode = 'default';
  }

  /* ---------------- orders ---------------- */

  /**
   * Smart right click. Resolves the target into the single most obvious action,
   * in the priority order of the classic RTS contract: continue construction ->
   * repair -> garrison -> gather -> attack -> move. Holding shift appends the
   * resulting order to each unit's queue instead of replacing it.
   */
  _rightClick(pt, shift) {
    if (this.spectator) return;
    const mine = this.selection.filter((e) => e.owner === this.playerIndex);
    if (!mine.length) return;
    const units = mine.filter((e) => e.kind === 'unit');
    const buildings = mine.filter((e) => e.kind === 'building');
    const hit = this.pickAt(pt.x, pt.y);
    const world = this.renderer.screenToWorld(pt.x, pt.y);
    const q = !!shift;

    // Shift + click a Mill / Town Center / Dock with villagers selected lays a
    // farm for each. Checked before normal target resolution so a villager
    // standing in front of the building cannot swallow the click.
    if (q && this._tryMassFarm(pt)) return;

    // right-clicking with a building selected sets its rally point
    if (buildings.length && !units.length) {
      for (const b of buildings) b.rally = hit && hit.kind === 'resource' ? { x: hit.x, y: hit.y } : world;
      this.player.notify('Rally point set');
      return;
    }
    if (!units.length) return;

    if (hit) {
      if (hit.kind === 'resource') {
        if (hit.type === 'relic') {
          this.game.commandRelic(units, hit, q);
          this._feedback(hit.x, hit.y, 'relic', q);
          return;
        }
        const gatherers = units.filter((u) => u.def.cat === 'villager');
        if (gatherers.length) this.game.commandGather(gatherers, hit, q);
        const rest = units.filter((u) => u.def.cat !== 'villager');
        if (rest.length && world) this.game.commandMove(rest, world.x, world.y, q);
        this._feedback(hit.x, hit.y, hit.resType || 'gather', q);
        return;
      }
      if (this.game.isEnemy(this.playerIndex, hit.owner) || hit.owner < 0) {
        // hunting: villagers gather from huntable gaia animals
        const vills = units.filter((u) => u.def.cat === 'villager');
        if (hit.owner < 0 && hit.kind === 'unit' && hit.def.huntable && vills.length) {
          this.game.commandGather(vills, hit, q);
          const rest = units.filter((u) => u.def.cat !== 'villager');
          if (rest.length) this.game.commandAttack(rest, hit, q);
          this._feedback(hit.x, hit.y, 'food', q);
          return;
        }
        this.game.commandAttack(units, hit, q);
        this._feedback(hit.x, hit.y, 'attack', q);
        return;
      }
      if (hit.kind === 'building' && hit.owner === this.playerIndex) {
        const vills = units.filter((u) => u.def.cat === 'villager');
        const others = units.filter((u) => u.def.cat !== 'villager');

        void vills;
        let kind = 'move';
        if (!hit.complete && vills.length) { this.game.commandBuildAt(vills, hit, q); kind = 'build'; }
        else if (vills.length && hit.hp < hit.maxHp) { this.game.commandRepair(vills, hit, q); kind = 'repair'; }
        else if (vills.length && hit.def.farmFood) {
          this.game.commandGather(vills, { ...hit, kind: 'resource', resType: 'food', id: hit.id }, q);
          kind = 'food';
        } else if (vills.length && hit.def.garrison) { this.game.commandGarrison(vills, hit, q); kind = 'garrison'; }
        else if (vills.length && world) this.game.commandMove(vills, world.x, world.y, q);
        if (others.length) {
          if (hit.def.garrison) { this.game.commandGarrison(others, hit, q); kind = 'garrison'; }
          else if (world) this.game.commandMove(others, world.x, world.y, q);
        }
        this._feedback(hit.x, hit.y, kind, q);
        return;
      }
      if (hit.kind === 'unit' && this.game.isAlly(this.playerIndex, hit.owner) && hit.owner !== this.playerIndex) {
        const monks = units.filter((u) => u.def.converts);
        if (monks.length) { this.game.commandHeal(monks, hit, q); this._feedback(hit.x, hit.y, 'heal', q); return; }
      }
      if (hit.kind === 'unit' && hit.owner === this.playerIndex && hit.def.garrison) {
        this.game.commandGarrison(units.filter((u) => u !== hit), hit, q);
        this._feedback(hit.x, hit.y, 'garrison', q);
        return;
      }
    }
    if (world) {
      this.game.commandMove(units, world.x, world.y, q);
      this._feedback(world.x, world.y, 'move', q);
    }
  }

  _feedback(x, y, kind, queued) {
    this.ctx.effects?.pushMarker(x, y, kind, queued);
  }

  setCursorMode(mode) {
    this.cursorMode = mode;
    document.body.style.cursor = 'crosshair';
  }

  _applyCursorMode(pt, shift) {
    if (this.spectator) { this.cursorMode = null; document.body.style.cursor = ''; return; }
    const mode = this.cursorMode;
    this.cursorMode = null;
    document.body.style.cursor = '';
    const units = this.selection.filter((e) => e.owner === this.playerIndex && e.kind === 'unit');
    const buildings = this.selection.filter((e) => e.owner === this.playerIndex && e.kind === 'building');
    const world = this.renderer.screenToWorld(pt.x, pt.y);
    const hit = this.pickAt(pt.x, pt.y);
    const q = !!shift;
    switch (mode) {
      case 'move':
        if (world) { this.game.commandMove(units, world.x, world.y, q); this._feedback(world.x, world.y, 'move', q); }
        break;
      case 'attackMove':
        if (hit && this.game.isEnemy(this.playerIndex, hit.owner)) {
          this.game.commandAttack(units, hit, q);
          this._feedback(hit.x, hit.y, 'attack', q);
        } else if (world) {
          this.game.commandAttackMove(units, world.x, world.y, q);
          this._feedback(world.x, world.y, 'attack', q);
        }
        break;
      case 'patrol':
        if (world) { this.game.commandPatrol(units, world.x, world.y, q); this._feedback(world.x, world.y, 'patrol', q); }
        break;
      case 'garrison':
        if (hit && hit.owner === this.playerIndex) {
          this.game.commandGarrison(units, hit, q);
          this._feedback(hit.x, hit.y, 'garrison', q);
        }
        break;
      case 'repair':
        if (hit && hit.kind === 'building') {
          this.game.commandRepair(units, hit, q);
          this._feedback(hit.x, hit.y, 'repair', q);
        }
        break;
      case 'heal': if (hit) this.game.commandHeal(units, hit, q); break;
      case 'relic': if (hit && hit.type === 'relic') this.game.commandRelic(units, hit, q); break;
      case 'trade': if (hit && hit.type === 'market') this.game.commandTrade(units, hit, q); break;
      case 'rally': if (world) for (const b of buildings) b.rally = world; break;
      default: break;
    }
  }

  /* ---------------- building placement ---------------- */

  startPlacement(bId) {
    if (this.spectator) return;
    if (!this.player.isBuildingAvailable(bId)) return;
    this.placement = { id: bId, tx: 0, ty: 0, size: this.player.mods.building(bId).size, valid: false };
    this._updatePlacement();
  }

  cancelPlacement() {
    this.placement = null;
    this.renderer.placement = null;
    this._pendingFarmSpots = null;
  }

  shiftHeld() { return this.keys.has('ShiftLeft') || this.keys.has('ShiftRight'); }

  _updatePlacement() {
    if (!this.placement) return;
    const w = this.renderer.screenToWorld(this.mouse.x, this.mouse.y);
    if (!w) return;
    const size = this.placement.size;
    let tx = Math.round(w.x - size / 2);
    let ty = Math.round(w.y - size / 2);

    // Farm + Shift while hovering a food drop-off building: snap to the closest
    // free plot AROUND that building. Without this the ghost sits on the Mill
    // itself, which is never a legal spot, so the click silently does nothing.
    this.placement.snappedTo = null;
    if (this.placement.id === 'farm' && this.shiftHeld()) {
      const b = this._pickBuilding(this.mouse.x, this.mouse.y);
      if (b && b.owner === this.playerIndex && b.complete &&
          b.def.dropSite && b.def.dropSite.includes('food')) {
        const spot = this.game._nearestFarmSpot(b, this.playerIndex, this._pendingFarmSpots || []);
        if (spot) { tx = spot.x; ty = spot.y; this.placement.snappedTo = b.id; }
      }
    }

    this.placement.tx = tx;
    this.placement.ty = ty;
    this.placement.valid = this.game.canPlaceBuilding(this.placement.id, this.playerIndex, tx, ty) &&
      this.player.canAfford(this.player.mods.building(this.placement.id).cost);
    this.renderer.placement = this.placement;
  }

  _placeBuilding(keepPlacing) {
    if (this.spectator) return;
    const p = this.placement;
    if (!p || !p.valid) return;
    const villagers = this.selection.filter((e) =>
      e.owner === this.playerIndex && e.kind === 'unit' && e.def.cat === 'villager');

    let builders;
    if (p.id === 'farm' && keepPlacing && villagers.length > 1) {
      // One villager per plot, so each shift-click queues another farm with its
      // own worker instead of sending the whole group at a single plot.
      // Villagers already sent to build are skipped, which rotates through them.
      const free = villagers.filter((v) => v.task.type !== 'build');
      const pool = free.length ? free : villagers;
      pool.sort((a, b) => Math.hypot(a.x - p.tx, a.y - p.ty) - Math.hypot(b.x - p.tx, b.y - p.ty));
      builders = [pool[0]];
    } else {
      builders = villagers.length ? villagers : this._nearestIdleVillagers(p.tx, p.ty, 2);
    }
    if (!builders.length) { this.player.notify('Select a villager first'); return; }

    const placed = this.game.commandBuild(builders, p.id, p.tx, p.ty, false);
    this._feedback(p.tx + p.size / 2, p.ty + p.size / 2, 'build', keepPlacing);

    if (placed && keepPlacing) {
      // The entity grid only rebuilds once per tick, so canPlaceBuilding cannot
      // see this foundation yet. Remember it so rapid clicks do not stack plots.
      if (!this._pendingFarmSpots) this._pendingFarmSpots = [];
      this._pendingFarmSpots.push({ x: p.tx, y: p.ty, s: p.size });
      if (this._pendingFarmSpots.length > 24) this._pendingFarmSpots.shift();
    }
    if (!keepPlacing) this.cancelPlacement();
    else this._updatePlacement();
  }

  _nearestIdleVillagers(tx, ty, n) {
    const list = this.game.entities.filter((e) =>
      e.alive && e.kind === 'unit' && e.owner === this.playerIndex && e.def.cat === 'villager');
    list.sort((a, b) => Math.hypot(a.x - tx, a.y - ty) - Math.hypot(b.x - tx, b.y - ty));
    return list.slice(0, n);
  }

  /* ================================================================
   *  Keyboard
   * ================================================================ */

  _onKeyDown(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
    this.keys.add(e.code);
    if (e.code.startsWith('Shift')) { this._previewKey = null; this.updateFarmPreview(); this._updatePlacement(); }
    const mine = this.selection.filter((x) => x.owner === this.playerIndex);
    const units = mine.filter((x) => x.kind === 'unit');

    if (this.spectator && this._spectatorKey(e)) return;

    // control groups
    if (e.code.startsWith('Digit')) {
      const n = e.code.slice(5);
      if (n >= '1' && n <= '9') {
        if (e.ctrlKey) { this.controlGroups.set(n, [...mine]); this.player.notify('Control group ' + n + ' set'); }
        else {
          const grp = (this.controlGroups.get(n) || []).filter((x) => x.alive);
          if (grp.length) {
            this.setSelection(grp);
            if (this._lastGroupKey === n && performance.now() - (this._lastGroupTime || 0) < 400) {
              this.renderer.centerOn(grp[0].x, grp[0].y);
            }
            this._lastGroupKey = n;
            this._lastGroupTime = performance.now();
          }
        }
        e.preventDefault();
        return;
      }
    }

    switch (e.code) {
      case 'Escape':
        if (this.hud?.modalOpen) this.hud.hideModal();
        else if (this.placement) this.cancelPlacement();
        else if (this.cursorMode) { this.cursorMode = null; document.body.style.cursor = ''; }
        else if (units.some((u) => u.orders && u.orders.length)) {
          // keep what they are doing, drop everything queued behind it
          this.game.clearQueue(units);
          this.player.notify('Queued orders cleared');
        } else if (this.hud) { this.hud.cardMode = 'default'; this.hud._cardKey = ''; }
        break;
      case 'KeyA': if (units.length) this.setCursorMode('attackMove'); break;
      case 'KeyP': if (units.length) this.setCursorMode('patrol'); break;
      case 'KeyS': if (units.length) this.game.commandStop(units); break;
      case 'KeyG': if (units.length) this.setCursorMode('garrison'); break;
      case 'KeyB': if (this.hud) { this.hud.cardMode = 'buildEco'; this.hud._cardKey = ''; } break;
      case 'KeyV': if (this.hud) { this.hud.cardMode = 'buildMil'; this.hud._cardKey = ''; } break;
      case 'KeyH':
        // Hold Position: stop where you are and never chase
        if (units.length) {
          this.game.commandStop(units);
          for (const u of units) u.stance = 'standGround';
          this.player.notify('Holding position');
        } else this._selectTownCenter();
        break;
      case 'KeyT': this._selectTownCenter(); break;
      case 'KeyQ': this.renderer.rotate(-1); break;
      case 'KeyE': this.renderer.rotate(1); break;
      case 'Period': this._cycleIdle('villager'); break;
      case 'Comma': this._cycleIdle('military'); break;
      case 'Delete': for (const u of mine) this.game.kill(u, null); this.setSelection([]); break;
      case 'F3': e.preventDefault(); this.hud?.toggleTechTree(); break;
      case 'F1': e.preventDefault(); this.hud?.toggleHelp(); break;
      case 'F10': e.preventDefault(); this.hud?.toggleMenu(); break;
      case 'Space': {
        e.preventDefault();
        if (this.selection.length) this.renderer.centerOn(this.selection[0].x, this.selection[0].y);
        break;
      }
      default: break;
    }

    // quick build hotkeys while a build page is open
    if (this.hud && (this.hud.cardMode === 'buildEco' || this.hud.cardMode === 'buildMil')) {
      const quick = { KeyH: 'house', KeyM: 'mill', KeyL: 'lumberCamp', KeyC: 'miningCamp',
        KeyF: 'farm', KeyR: 'barracks', KeyT: 'watchTower' };
      const id = quick[e.code];
      if (id && (BUILD_MENU[this.player.age] || []).includes(id)) this.startPlacement(id);
    }
  }

  /**
   * Spectator-only keys, handled before the normal bindings so the ones that
   * would issue orders (S to stop, H to hold, Delete to kill) never run.
   * @returns true if the key was consumed
   */
  _spectatorKey(e) {
    const ctx = this.ctx;
    switch (e.code) {
      case 'Tab':
        e.preventDefault();
        ctx.setViewPlayer?.((this.playerIndex + 1) % this.game.players.length);
        return true;
      case 'Space':
        e.preventDefault();
        ctx.timeScale = ctx.timeScale === 0 ? (ctx.lastScale || 1) : 0;
        if (ctx.timeScale !== 0) ctx.lastScale = ctx.timeScale;
        return true;
      case 'Equal': case 'NumpadAdd':
        e.preventDefault();
        ctx.timeScale = Math.min(8, (ctx.timeScale || 1) * 2);
        ctx.lastScale = ctx.timeScale;
        return true;
      case 'Minus': case 'NumpadSubtract':
        e.preventDefault();
        ctx.timeScale = Math.max(0.5, (ctx.timeScale || 1) / 2);
        ctx.lastScale = ctx.timeScale;
        return true;
      case 'KeyH':
        // Normally Hold Position; with nothing to command, keep its other job.
        this._selectTownCenter();
        return true;
      // These all end in a command, so they are simply dropped while watching.
      case 'KeyA': case 'KeyP': case 'KeyS': case 'KeyG': case 'Delete':
        return true;
      default:
        return false;
    }
  }

  _selectTownCenter() {
    const tcs = this.game.entities.filter((e) =>
      e.alive && e.kind === 'building' && e.owner === this.playerIndex && e.type === 'townCenter');
    if (!tcs.length) return;
    this._tcIdx = ((this._tcIdx ?? -1) + 1) % tcs.length;
    const tc = tcs[this._tcIdx];
    this.setSelection([tc]);
    this.renderer.centerOn(tc.x, tc.y);
  }

  /** Selects every idle unit of a kind, so one order can put them all to work. */
  selectAllIdle(kind) {
    const list = this.game.entities.filter((e) => {
      if (!e.alive || e.kind !== 'unit' || e.owner !== this.playerIndex) return false;
      if (e.task.type !== 'idle' || e.garrisonedIn) return false;
      if (e.orders && e.orders.length) return false;
      return kind === 'villager' ? e.def.cat === 'villager'
        : (e.def.cat !== 'villager' && e.def.cat !== 'trade');
    });
    if (!list.length) { this.player.notify(`No idle ${kind}s`); return; }
    this.setSelection(list);
    this.renderer.centerOn(list[0].x, list[0].y);
    this.player.notify(`Selected ${list.length} idle ${kind}${list.length > 1 ? 's' : ''}`);
  }

  _cycleIdle(kind) {
    const list = this.game.entities.filter((e) => {
      if (!e.alive || e.kind !== 'unit' || e.owner !== this.playerIndex) return false;
      if (e.task.type !== 'idle' || e.garrisonedIn) return false;
      return kind === 'villager' ? e.def.cat === 'villager' : (e.def.cat !== 'villager' && e.def.cat !== 'trade');
    });
    if (!list.length) { this.player.notify(`No idle ${kind}`); return; }
    const idxKey = kind === 'villager' ? 'idleVillagerIdx' : 'idleMilitaryIdx';
    this[idxKey] = this[idxKey] % list.length;
    const u = list[this[idxKey]++];
    this.setSelection([u]);
    this.renderer.centerOn(u.x, u.y);
  }

  /* ---------------- per-frame camera ---------------- */

  updateCamera(dt) {
    if (this.hud?.modalOpen) return;
    let dx = 0, dy = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) dy -= 1;
    if (this.keys.has('KeyS') && !this.selection.length) dy += 1;
    if (this.keys.has('ArrowDown')) dy += 1;
    if (this.keys.has('KeyA') && !this.selection.length) dx -= 1;
    if (this.keys.has('ArrowLeft')) dx -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) dx += 1;

    if (this.mouse.inWindow && !this.middlePan) {
      if (this.mouse.x < EDGE) dx -= 1;
      if (this.mouse.x > window.innerWidth - EDGE) dx += 1;
      if (this.mouse.y < EDGE) dy -= 1;
      if (this.mouse.y > window.innerHeight - EDGE) dy += 1;
    }
    if (dx || dy) {
      const k = PAN_SPEED * dt * (this.renderer.zoom / 22);
      this.renderer.panBy(dx * k, dy * k);
    }
    // prune dead entities from the selection
    if (this.selection.some((e) => !e.alive)) {
      this.selection = this.selection.filter((e) => e.alive);
    }
  }
}

function dedupe(a) { return [...new Set(a)]; }
