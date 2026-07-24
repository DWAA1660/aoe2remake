// Uniform spatial hash used for "what is near X" queries. Rebuilt-in-place each
// tick rather than reallocated - the sim runs at 10 Hz with a few hundred
// entities so this stays cheap.
export class SpatialGrid {
  constructor(width, height, cellSize = 4) {
    this.cell = cellSize;
    this.cols = Math.ceil(width / cellSize);
    this.rows = Math.ceil(height / cellSize);
    this.buckets = new Array(this.cols * this.rows);
    for (let i = 0; i < this.buckets.length; i++) this.buckets[i] = [];
  }

  clear() {
    for (let i = 0; i < this.buckets.length; i++) this.buckets[i].length = 0;
  }

  idx(x, y) {
    const cx = Math.min(this.cols - 1, Math.max(0, (x / this.cell) | 0));
    const cy = Math.min(this.rows - 1, Math.max(0, (y / this.cell) | 0));
    return cy * this.cols + cx;
  }

  insert(e) {
    this.buckets[this.idx(e.x, e.y)].push(e);
  }

  /** Calls fn(entity) for every entity whose cell overlaps the radius. */
  forEachNear(x, y, radius, fn) {
    const c = this.cell;
    const x0 = Math.max(0, ((x - radius) / c) | 0);
    const x1 = Math.min(this.cols - 1, ((x + radius) / c) | 0);
    const y0 = Math.max(0, ((y - radius) / c) | 0);
    const y1 = Math.min(this.rows - 1, ((y + radius) / c) | 0);
    for (let cy = y0; cy <= y1; cy++) {
      const row = cy * this.cols;
      for (let cx = x0; cx <= x1; cx++) {
        const b = this.buckets[row + cx];
        for (let i = 0; i < b.length; i++) fn(b[i]);
      }
    }
  }

  queryNear(x, y, radius, filter) {
    const out = [];
    const r2 = radius * radius;
    this.forEachNear(x, y, radius, (e) => {
      const dx = e.x - x, dy = e.y - y;
      if (dx * dx + dy * dy <= r2 && (!filter || filter(e))) out.push(e);
    });
    return out;
  }

  nearest(x, y, radius, filter) {
    let best = null, bestD = Infinity;
    const r2 = radius * radius;
    this.forEachNear(x, y, radius, (e) => {
      const dx = e.x - x, dy = e.y - y;
      const d = dx * dx + dy * dy;
      if (d <= r2 && d < bestD && (!filter || filter(e))) { best = e; bestD = d; }
    });
    return best;
  }
}
