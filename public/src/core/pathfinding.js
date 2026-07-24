// Tile-grid A* with a binary heap, plus string-pulling to smooth the result.
//
// Two passability domains share one grid: land units walk on non-water tiles
// that carry no static obstruction, ships travel only on water. Buildings,
// trees, mines and cliffs write into `blocked`.

const SQRT2 = Math.SQRT2;

class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  clear() { this.a.length = 0; }
  push(node) {
    const a = this.a;
    a.push(node);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l].f < a[m].f) m = l;
        if (r < a.length && a[r].f < a[m].f) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

export class PathGrid {
  constructor(w, h) {
    this.w = w; this.h = h;
    this.blocked = new Uint8Array(w * h);   // static obstruction (buildings, trees, rocks)
    this.water = new Uint8Array(w * h);     // 1 = water tile
    this.elevation = new Uint8Array(w * h); // used for the elevation combat bonus
    // A* scratch buffers, reused between searches
    this._g = new Float32Array(w * h);
    this._came = new Int32Array(w * h);
    this._stamp = new Int32Array(w * h);
    this._gen = 0;
    this._heap = new MinHeap();
  }

  inBounds(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h; }
  index(x, y) { return y * this.w + x; }

  isPassable(x, y, domain) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return false;
    const i = y * this.w + x;
    if (this.blocked[i]) return false;
    return domain === 'water' ? this.water[i] === 1 : this.water[i] === 0;
  }

  setBlocked(x0, y0, size, value) {
    for (let y = y0; y < y0 + size; y++) {
      for (let x = x0; x < x0 + size; x++) {
        if (this.inBounds(x, y)) this.blocked[y * this.w + x] = value ? 1 : 0;
      }
    }
  }

  /**
   * @param goal { x, y, radius } - path succeeds on reaching within `radius`
   *        tiles of (x,y), which is how units approach buildings/resources.
   * @returns array of {x,y} tile-centre waypoints, or null
   */
  findPath(sx, sy, goal, domain = 'land', maxNodes = 9000) {
    const w = this.w, h = this.h;
    const startX = Math.max(0, Math.min(w - 1, Math.round(sx)));
    const startY = Math.max(0, Math.min(h - 1, Math.round(sy)));
    const gx = Math.max(0, Math.min(w - 1, Math.round(goal.x)));
    const gy = Math.max(0, Math.min(h - 1, Math.round(goal.y)));
    const goalR = goal.radius ?? 0;

    if (startX === gx && startY === gy) return [];

    const gen = ++this._gen;
    const g = this._g, came = this._came, stamp = this._stamp;
    const heap = this._heap;
    heap.clear();

    const startI = startY * w + startX;
    g[startI] = 0;
    came[startI] = -1;
    stamp[startI] = gen;
    heap.push({ i: startI, x: startX, y: startY, f: 0 });

    let expanded = 0;
    let best = null, bestH = Infinity;

    const heur = (x, y) => {
      const dx = Math.abs(x - gx), dy = Math.abs(y - gy);
      return (dx + dy) + (SQRT2 - 2) * Math.min(dx, dy);
    };

    while (heap.size) {
      const cur = heap.pop();
      if (stamp[cur.i] !== gen || cur.f - g[cur.i] < -1e-6) { /* stale */ }
      const hx = Math.abs(cur.x - gx), hy = Math.abs(cur.y - gy);
      const dist = Math.max(hx, hy);
      if (dist <= goalR) return this._reconstruct(came, cur.i);
      if (dist < bestH) { bestH = dist; best = cur.i; }

      if (++expanded > maxNodes) break;

      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = cur.x + dx, ny = cur.y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = ny * w + nx;
          const passable = !this.blocked[ni] &&
            (domain === 'water' ? this.water[ni] === 1 : this.water[ni] === 0);
          if (!passable) continue;
          // no cutting diagonal corners between two blocked tiles
          if (dx && dy) {
            if (!this.isPassable(cur.x + dx, cur.y, domain) ||
                !this.isPassable(cur.x, cur.y + dy, domain)) continue;
          }
          const step = dx && dy ? SQRT2 : 1;
          const ng = g[cur.i] + step;
          if (stamp[ni] === gen && ng >= g[ni]) continue;
          stamp[ni] = gen;
          g[ni] = ng;
          came[ni] = cur.i;
          heap.push({ i: ni, x: nx, y: ny, f: ng + heur(nx, ny) * 1.02 });
        }
      }
    }

    // No exact route - walk as close as we managed to get.
    if (best !== null && best !== startI) return this._reconstruct(came, best);
    return null;
  }

  _reconstruct(came, endIdx) {
    const w = this.w;
    const pts = [];
    let i = endIdx;
    while (i !== -1) {
      pts.push({ x: (i % w) + 0.5, y: ((i / w) | 0) + 0.5 });
      i = came[i];
    }
    pts.reverse();
    pts.shift(); // drop the tile we are standing on
    return this._smooth(pts);
  }

  /** String-pulling: drop waypoints we can walk past in a straight line. */
  _smooth(pts) {
    if (pts.length < 3) return pts;
    const out = [pts[0]];
    let anchor = 0;
    for (let i = 2; i < pts.length; i++) {
      if (!this._lineClear(pts[anchor], pts[i])) {
        out.push(pts[i - 1]);
        anchor = i - 1;
      }
    }
    out.push(pts[pts.length - 1]);
    return out;
  }

  _lineClear(a, b) {
    const steps = Math.ceil(Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) * 2);
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      const x = (a.x + (b.x - a.x) * t) | 0;
      const y = (a.y + (b.y - a.y) * t) | 0;
      if (!this.inBounds(x, y) || this.blocked[y * this.w + x]) return false;
    }
    return true;
  }

  /** Finds the closest passable tile to (x,y), spiralling outwards. */
  nearestOpen(x, y, domain = 'land', maxR = 12) {
    const cx = Math.round(x), cy = Math.round(y);
    if (this.isPassable(cx, cy, domain)) return { x: cx + 0.5, y: cy + 0.5 };
    for (let r = 1; r <= maxR; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (this.isPassable(cx + dx, cy + dy, domain)) {
            return { x: cx + dx + 0.5, y: cy + dy + 0.5 };
          }
        }
      }
    }
    return null;
  }
}
