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

  pushMoveMarker(x, y) {
    this.markers.push({ x, y, t: 0 });
    if (this.markers.length > 24) this.markers.shift();
  }

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

    // click markers
    for (let i = this.markers.length - 1; i >= 0; i--) {
      const m = this.markers[i];
      m.t += dt;
      if (m.t > 0.6) { this.markers.splice(i, 1); continue; }
      const p = r.worldToScreen(m.x, r.heightAt(m.x, m.y) + 0.1, m.y);
      if (p.z > 1) continue;
      const k = 1 - m.t / 0.6;
      g.strokeStyle = `rgba(120,255,120,${k})`;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(p.x, p.y, 4 + (1 - k) * 14, 0, Math.PI * 2);
      g.stroke();
    }
  }
}
