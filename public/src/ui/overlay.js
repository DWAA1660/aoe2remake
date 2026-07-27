// 2D overlay drawn on top of the pixelated 3D view: health bars, construction
// progress, carried resources and click markers. Kept at full resolution so
// text and bars stay legible.

import { PLAYER_COLORS } from '../render/renderer.js';

export class Overlay {
  constructor(ctx) {
    this.ctx = ctx;
    this.game = ctx.game;
    this.renderer = ctx.renderer;
    this.canvas = document.getElementById('overlay');
    this.g = this.canvas.getContext('2d');
    this.markers = [];
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
  }

  pushMarker(x, y, kind = 'move', queued = false) {
    this.markers.push({ x, y, kind, queued, t: 0 });
    if (this.markers.length > 32) this.markers.shift();
  }

  // kept for older call sites
  pushMoveMarker(x, y) { this.pushMarker(x, y, 'move', false); }

  draw(dt, selection, viewPlayer) {
    const g = this.g;
    const r = this.renderer;
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const selSet = new Set(selection);

    for (const e of this.game.entities) {
      if (!e.alive || e.kind === 'projectile' || e.garrisonedIn) continue;
      if (e.kind === 'resource') continue;
      const visible = this.game.revealAll ||
        (e.kind === 'building' ? viewPlayer.hasExplored(e.x | 0, e.y | 0) : viewPlayer.canSee(e.x | 0, e.y | 0));
      if (!visible) continue;

      const damaged = e.hp < e.maxHp - 0.5;
      const selected = selSet.has(e);
      const constructing = e.kind === 'building' && !e.complete;
      if (!damaged && !selected && !constructing) continue;

      const top = e.kind === 'building'
        ? r.heightAt(e.x, e.y) + e.size * 0.9 + 0.6
        : r.heightAt(e.x, e.y) + (e.def.radius > 0.4 ? 1.7 : 1.25);
      const p = r.worldToScreen(e.x, top, e.y);
      if (p.z > 1 || p.x < -60 || p.y < -30 || p.x > this.canvas.width + 60 || p.y > this.canvas.height + 30) continue;

      const w = e.kind === 'building' ? Math.max(26, e.size * 12) : 22;
      const h = 4;
      const x = Math.round(p.x - w / 2), y = Math.round(p.y);

      g.fillStyle = 'rgba(0,0,0,0.75)';
      g.fillRect(x - 1, y - 1, w + 2, h + 2);

      const frac = Math.max(0, Math.min(1, e.hp / e.maxHp));
      if (constructing) {
        const pr = e.buildProgress / e.def.time;
        g.fillStyle = '#3a3a44';
        g.fillRect(x, y, w, h);
        g.fillStyle = '#6fb0e0';
        g.fillRect(x, y, w * pr, h);
      } else {
        g.fillStyle = '#3a1a1a';
        g.fillRect(x, y, w, h);
        g.fillStyle = frac > 0.6 ? '#4ad04a' : frac > 0.3 ? '#e0c02a' : '#e04a3a';
        g.fillRect(x, y, w * frac, h);
      }
      // owner colour tab
      if (e.owner >= 0) {
        g.fillStyle = '#' + PLAYER_COLORS[e.owner % PLAYER_COLORS.length].toString(16).padStart(6, '0');
        g.fillRect(x - 4, y - 1, 3, h + 2);
      }

      // garrison count
      if (e.kind === 'building' && e.garrison?.length) {
        g.fillStyle = '#ffffff';
        g.font = '10px monospace';
        g.fillText(String(e.garrison.length), x + w + 4, y + h);
      }
      // carried resource pip
      if (e.kind === 'unit' && e.carrying && e.carrying.amount > 0.5) {
        const cc = { food: '#d1483c', wood: '#8a5a2b', gold: '#e0bc3c', stone: '#a8a8a2' }[e.carrying.res];
        g.fillStyle = cc || '#fff';
        g.fillRect(x + w + 3, y, 4, 4);
      }
    }

    this._drawOrderQueues(selection);

    // click markers - a brief expanding ring in the colour of the command
    for (let i = this.markers.length - 1; i >= 0; i--) {
      const m = this.markers[i];
      m.t += dt;
      const life = 0.6;
      if (m.t > life) { this.markers.splice(i, 1); continue; }
      const p = r.worldToScreen(m.x, r.heightAt(m.x, m.y) + 0.1, m.y);
      if (p.z > 1) continue;
      const k = 1 - m.t / life;
      const [cr, cg, cb] = KIND_RGB[m.kind] || KIND_RGB.move;
      g.strokeStyle = `rgba(${cr},${cg},${cb},${k})`;
      g.lineWidth = m.queued ? 1.5 : 2.5;
      g.beginPath();
      g.arc(p.x, p.y, 4 + (1 - k) * 14, 0, Math.PI * 2);
      g.stroke();
    }
  }

  /* ---------------- shift-queue visualisation ---------------- */

  _orderPoint(o) {
    if (o.x !== undefined && o.y !== undefined) return { x: o.x, y: o.y };
    const t = this.game.byId.get(o.targetId);
    return t && t.alive ? { x: t.x, y: t.y } : null;
  }

  _taskPoint(task) {
    if (!task) return null;
    if (task.type === 'idle') return null;
    if (task.x !== undefined && task.y !== undefined) return { x: task.x, y: task.y };
    if (task.bx !== undefined) return { x: task.bx, y: task.by };
    if (task.targetId) {
      const t = this.game.byId.get(task.targetId);
      if (t && t.alive) return { x: t.x, y: t.y };
    }
    return null;
  }

  /**
   * Draws the pending order chain for the selected units: a thin line from the
   * unit through each waypoint, with numbered, colour-coded markers so the
   * player can read a long shift-queue at a glance.
   */
  _drawOrderQueues(selection) {
    const g = this.g;
    const r = this.renderer;
    let drawn = 0;
    for (const u of selection) {
      if (drawn >= 12) break;
      if (!u.alive || u.kind !== 'unit') continue;
      const orders = u.orders || [];
      const first = this._taskPoint(u.task);
      if (!orders.length && !first) continue;
      drawn++;

      const pts = [];
      if (first) pts.push({ p: first, kind: taskKind(u.task) });
      for (const o of orders) {
        const p = this._orderPoint(o);
        if (p) pts.push({ p, kind: o.type });
      }
      if (!pts.length) continue;

      // connecting line, starting at the unit itself
      const screen = [r.worldToScreen(u.x, r.heightAt(u.x, u.y) + 0.3, u.y)];
      for (const s of pts) screen.push(r.worldToScreen(s.p.x, r.heightAt(s.p.x, s.p.y) + 0.15, s.p.y));

      g.save();
      g.setLineDash([4, 4]);
      g.strokeStyle = 'rgba(230,230,200,0.42)';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(screen[0].x, screen[0].y);
      for (let i = 1; i < screen.length; i++) g.lineTo(screen[i].x, screen[i].y);
      g.stroke();
      g.restore();

      // numbered waypoint markers (the live task is 0 and drawn unnumbered)
      for (let i = 0; i < pts.length; i++) {
        const s = screen[i + 1];
        if (!s || s.z > 1) continue;
        const [cr, cg, cb] = KIND_RGB[pts[i].kind] || KIND_RGB.move;
        const rad = i === 0 ? 6 : 7;
        g.fillStyle = `rgba(${cr},${cg},${cb},0.85)`;
        g.strokeStyle = 'rgba(0,0,0,0.75)';
        g.lineWidth = 1.5;
        g.beginPath();
        g.arc(s.x, s.y, rad, 0, Math.PI * 2);
        g.fill();
        g.stroke();
        if (i > 0) {
          g.fillStyle = '#101014';
          g.font = 'bold 9px monospace';
          g.textAlign = 'center';
          g.textBaseline = 'middle';
          g.fillText(String(i), s.x, s.y + 0.5);
          g.textAlign = 'left';
          g.textBaseline = 'alphabetic';
        }
      }
    }
  }
}

// Command colours, shared by the click markers and the queue waypoints.
const KIND_RGB = {
  move: [120, 255, 120],
  attackMove: [255, 150, 90],
  attack: [255, 90, 80],
  patrol: [190, 130, 255],
  gather: [230, 210, 120],
  food: [225, 105, 90],
  wood: [190, 135, 70],
  gold: [230, 195, 70],
  stone: [190, 190, 180],
  build: [110, 180, 240],
  repair: [255, 180, 90],
  garrison: [120, 220, 220],
  heal: [240, 240, 240],
  relic: [255, 255, 200],
  trade: [230, 200, 120],
};

function taskKind(task) {
  if (!task) return 'move';
  if (task.type === 'gather' || task.type === 'deliver') return task.resType || 'gather';
  if (task.type === 'convert') return 'attack';
  return task.type;
}
