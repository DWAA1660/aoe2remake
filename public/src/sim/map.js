// Random map generation - an Arabia-style open land map with forest clumps,
// scattered gold/stone, a lake or two, and a symmetric resource layout around
// each player's starting Town Center.

import { RNG } from '../core/rng.js';
import { PathGrid } from '../core/pathfinding.js';

export const TERRAIN = { GRASS: 0, GRASS2: 1, DIRT: 2, SAND: 3, WATER: 4, SHALLOW: 5 };

/**
 * Richer than the AoE2 standards (100 / 800 / 350 / 125).
 *
 * Depth per tile, rather than more tiles. Trees, gold and stone all *block*
 * the tile they sit on, so scattering more of them crowds the ground units
 * have to walk and build on: measured over twelve games, raising the counts
 * cost the AI 5-20% of its gathering rate, while raising the amounts cost
 * nothing at all. More animals hurt too - the AI over-commits villagers to a
 * finite food source and puts off building farms.
 */
const TREE_WOOD = 175;
const GOLD_PER_TILE = 1300;
const STONE_PER_TILE = 600;
const BERRY_FOOD = 200;

function valueNoise(rng, w, h, scale) {
  const cw = Math.ceil(w / scale) + 2, ch = Math.ceil(h / scale) + 2;
  const pts = new Float32Array(cw * ch);
  for (let i = 0; i < pts.length; i++) pts[i] = rng.next();
  const out = new Float32Array(w * h);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (t) => t * t * (3 - 2 * t);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const fx = x / scale, fy = y / scale;
      const ix = fx | 0, iy = fy | 0;
      const tx = smooth(fx - ix), ty = smooth(fy - iy);
      const a = pts[iy * cw + ix], b = pts[iy * cw + ix + 1];
      const c = pts[(iy + 1) * cw + ix], d = pts[(iy + 1) * cw + ix + 1];
      out[y * w + x] = lerp(lerp(a, b, tx), lerp(c, d, tx), ty);
    }
  }
  return out;
}

/**
 * @param opts.mapType 'mixed' - lakes and rivers among the land (the default),
 *        or 'land' - an entirely dry map with no water at all, so nothing can
 *        be cut off by a shoreline and every tile is walkable.
 */
export function generateMap(opts) {
  const { size = 120, seed = 1, players = 2, waterAmount = 0.5, mapType = 'mixed' } = opts;
  const rng = new RNG(seed);
  const grid = new PathGrid(size, size);
  const tiles = new Uint8Array(size * size);
  const resources = [];
  const dry = mapType === 'land';

  /* ---- terrain ---- */
  const moisture = valueNoise(rng, size, size, 14);
  const detail = valueNoise(rng, size, size, 5);
  const height = valueNoise(rng, size, size, 22);

  const waterCut = 0.20 + 0.10 * (1 - waterAmount);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      // keep map edges land so nothing spawns unreachable in a corner
      const edge = Math.min(x, y, size - 1 - x, size - 1 - y);
      const m = moisture[i] * 0.75 + detail[i] * 0.25;
      let t;
      if (dry) {
        // Dry map: the same noise still paints the ground, it just never
        // becomes water. What would have been lake reads as lush grass.
        if (m < waterCut + 0.035) t = TERRAIN.GRASS2;
        else if (detail[i] > 0.72) t = TERRAIN.DIRT;
        else if (detail[i] < 0.30) t = TERRAIN.GRASS2;
        else t = TERRAIN.GRASS;
      } else if (m < waterCut && edge > 6) { t = TERRAIN.WATER; grid.water[i] = 1; }
      else if (m < waterCut + 0.035 && edge > 6) { t = TERRAIN.SHALLOW; }
      else if (detail[i] > 0.72) t = TERRAIN.DIRT;
      else if (detail[i] < 0.30) t = TERRAIN.GRASS2;
      else t = TERRAIN.GRASS;
      tiles[i] = t;
      grid.elevation[i] = height[i] > 0.62 ? 1 : 0;
    }
  }

  /* ---- player start positions, evenly spread on a circle ---- */
  const starts = [];
  const cx = size / 2, cy = size / 2;
  const radius = size * 0.33;
  const angle0 = rng.range(0, Math.PI * 2);
  for (let p = 0; p < players; p++) {
    const a = angle0 + (p / players) * Math.PI * 2;
    let sx = Math.round(cx + Math.cos(a) * radius);
    let sy = Math.round(cy + Math.sin(a) * radius);
    sx = Math.max(10, Math.min(size - 12, sx));
    sy = Math.max(10, Math.min(size - 12, sy));
    // flatten the base out of any water
    for (let y = sy - 8; y <= sy + 8; y++) {
      for (let x = sx - 8; x <= sx + 8; x++) {
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const i = y * size + x;
        if (tiles[i] === TERRAIN.WATER || tiles[i] === TERRAIN.SHALLOW) {
          tiles[i] = TERRAIN.GRASS;
          grid.water[i] = 0;
        }
      }
    }
    starts.push({ x: sx, y: sy });
  }

  const occupied = new Uint8Array(size * size);
  const claim = (x, y, r) => {
    for (let j = -r; j <= r; j++)
      for (let i = -r; i <= r; i++) {
        const nx = x + i, ny = y + j;
        if (nx >= 0 && ny >= 0 && nx < size && ny < size) occupied[ny * size + nx] = 1;
      }
  };
  const free = (x, y, r = 0) => {
    for (let j = -r; j <= r; j++)
      for (let i = -r; i <= r; i++) {
        const nx = x + i, ny = y + j;
        if (nx < 1 || ny < 1 || nx >= size - 1 || ny >= size - 1) return false;
        const k = ny * size + nx;
        if (occupied[k] || grid.water[k]) return false;
      }
    return true;
  };

  // reserve the town-centre footprint + a build ring
  for (const s of starts) claim(s.x, s.y, 4);

  const addRes = (type, x, y, amount) => {
    resources.push({ type, x: x + 0.5, y: y + 0.5, tx: x, ty: y, amount: Math.round(amount) });
    occupied[y * size + x] = 1;
    if (type === 'tree' || type === 'gold' || type === 'stone') {
      grid.blocked[y * size + x] = 1;
    }
  };

  /* ---- per-player starting resources (mirrors the standard AoE2 layout) ---- */
  for (const s of starts) {
    // 4 sheep next to the TC
    for (let i = 0; i < 4; i++) {
      const a = rng.range(0, Math.PI * 2), d = rng.range(3.5, 5.5);
      resources.push({ type: 'sheep', x: s.x + Math.cos(a) * d, y: s.y + Math.sin(a) * d });
    }
    // 2 boar, further out
    for (let i = 0; i < 2; i++) {
      const a = rng.range(0, Math.PI * 2), d = rng.range(11, 15);
      resources.push({ type: 'boar', x: s.x + Math.cos(a) * d, y: s.y + Math.sin(a) * d });
    }
    // 4 deer
    for (let i = 0; i < 4; i++) {
      const a = rng.range(0, Math.PI * 2), d = rng.range(14, 20);
      resources.push({ type: 'deer', x: s.x + Math.cos(a) * d, y: s.y + Math.sin(a) * d });
    }
    // berry patch (6 bushes)
    const ba = rng.range(0, Math.PI * 2), bd = rng.range(7, 9);
    const bx = Math.round(s.x + Math.cos(ba) * bd), by = Math.round(s.y + Math.sin(ba) * bd);
    for (let i = 0; i < 6; i++) {
      const x = bx + (i % 3) - 1, y = by + ((i / 3) | 0);
      if (free(x, y)) addRes('berries', x, y, BERRY_FOOD);
    }
    // 2 gold clusters of 5, 1 stone cluster of 4
    for (let c = 0; c < 2; c++) {
      const ga = rng.range(0, Math.PI * 2), gd = rng.range(9, 13);
      const gx = Math.round(s.x + Math.cos(ga) * gd), gy = Math.round(s.y + Math.sin(ga) * gd);
      for (let i = 0; i < 5; i++) {
        const x = gx + (i % 3), y = gy + ((i / 3) | 0);
        if (free(x, y)) addRes('gold', x, y, GOLD_PER_TILE);
      }
    }
    const sa = rng.range(0, Math.PI * 2), sd = rng.range(9, 13);
    const stx = Math.round(s.x + Math.cos(sa) * sd), sty = Math.round(s.y + Math.sin(sa) * sd);
    for (let i = 0; i < 4; i++) {
      const x = stx + (i % 2), y = sty + ((i / 2) | 0);
      if (free(x, y)) addRes('stone', x, y, STONE_PER_TILE);
    }
    // two starting forests
    for (let c = 0; c < 2; c++) {
      const fa = rng.range(0, Math.PI * 2), fd = rng.range(9, 14);
      plantForest(Math.round(s.x + Math.cos(fa) * fd), Math.round(s.y + Math.sin(fa) * fd), 5);
    }
  }

  function plantForest(fx, fy, r) {
    for (let y = fy - r; y <= fy + r; y++) {
      for (let x = fx - r; x <= fx + r; x++) {
        const dx = x - fx, dy = y - fy;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > r) continue;
        if (rng.next() > 1 - d / (r + 1.5)) continue;
        if (!free(x, y)) continue;
        addRes('tree', x, y, TREE_WOOD);
      }
    }
  }

  /* ---- scattered map-wide resources ---- */
  // Gold and stone are placed first. There are only a couple of dozen piles of
  // each and they need open ground, so letting hundreds of forest clumps go
  // first simply crowds them off the map - raising the forest count alone cut
  // gold from 59 tiles to 49. Forests then fill whatever is left.
  // Scaled by area, not by width. Forests already scale with size squared, so
  // tying the mines to `size` alone left a large map proportionally starved of
  // gold and stone - four times the ground for twice the mines.
  // (At the 120 baseline these give exactly the old counts: 15 and 10.)
  const goldPiles = Math.round((size * size) / 960);
  for (let i = 0; i < goldPiles; i++) {
    const x = rng.int(6, size - 8), y = rng.int(6, size - 8);
    if (!free(x, y, 2)) continue;
    for (let k = 0; k < rng.int(3, 6); k++) {
      const px = x + (k % 3), py = y + ((k / 3) | 0);
      if (free(px, py)) addRes('gold', px, py, GOLD_PER_TILE);
    }
  }
  const stonePiles = Math.round((size * size) / 1440);
  for (let i = 0; i < stonePiles; i++) {
    const x = rng.int(6, size - 8), y = rng.int(6, size - 8);
    if (!free(x, y, 2)) continue;
    for (let k = 0; k < rng.int(2, 4); k++) {
      const px = x + (k % 2), py = y + ((k / 2) | 0);
      if (free(px, py)) addRes('stone', px, py, STONE_PER_TILE);
    }
  }
  // Woodlines are many and small on purpose: a few big solid blocks of trees
  // seal a map into pockets, whereas many small ones give neighbouring players
  // somewhere separate to chop.
  const forests = Math.round((size * size) / 520);
  for (let i = 0; i < forests; i++) {
    const x = rng.int(6, size - 7), y = rng.int(6, size - 7);
    if (free(x, y, 2)) plantForest(x, y, rng.int(3, 7));
  }
  // wandering wildlife
  for (let i = 0; i < Math.round(size / 12); i++) {
    const x = rng.int(6, size - 7), y = rng.int(6, size - 7);
    if (free(x, y)) resources.push({ type: 'wolf', x: x + 0.5, y: y + 0.5 });
  }
  // fish in deep water
  for (let i = 0; i < size; i++) {
    const x = rng.int(2, size - 3), y = rng.int(2, size - 3);
    const k = y * size + x;
    if (grid.water[k] && !occupied[k]) {
      resources.push({ type: 'fish', x: x + 0.5, y: y + 0.5, tx: x, ty: y, amount: 225 });
      occupied[k] = 1;
    }
  }
  // relics (monastery gold)
  for (let i = 0; i < Math.max(3, players * 2); i++) {
    for (let tries = 0; tries < 60; tries++) {
      const x = rng.int(8, size - 9), y = rng.int(8, size - 9);
      if (free(x, y, 1)) { resources.push({ type: 'relic', x: x + 0.5, y: y + 0.5 }); occupied[y * size + x] = 1; break; }
    }
  }

  return { size, grid, tiles, resources, starts, seed };
}
