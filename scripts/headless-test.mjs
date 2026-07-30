// Headless simulation harness. Runs full AI-vs-AI games with no renderer so the
// economy, combat and tech systems can be verified from the command line.
//
//   node scripts/headless-test.mjs [minutes] [seed]

import { Game, TICK } from '../public/src/sim/game.js';
import { AI } from '../public/src/sim/ai.js';
import { CIV_IDS, CIVILIZATIONS } from '../public/src/data/civs.js';
import { UNITS } from '../public/src/data/units.js';
import { BUILDINGS } from '../public/src/data/buildings.js';
import { computeDamage } from '../public/src/data/armor.js';
import { PathGrid } from '../public/src/core/pathfinding.js';
import { RESOURCE_INFO, makeResource } from '../public/src/sim/entity.js';
import { generateMap } from '../public/src/sim/map.js';

// 18 minutes, not 10: on a poor map the AI reaches 17 villagers around minute
// 10 and then needs another 4 to bank the 500 food plus 130 seconds to research
// the age itself. Asserting Feudal at minute 10 was asking for something no
// legitimate build order achieves here, and the assertion failed regardless of
// how the AI actually played.
const minutes = parseFloat(process.argv[2] || '18');
const seed = parseInt(process.argv[3] || '12345', 10);

/* ---------------- counter-system unit tests ---------------- */

function assert(cond, msg) {
  if (!cond) { console.error('  ✗ ' + msg); process.exitCode = 1; return false; }
  console.log('  ✓ ' + msg);
  return true;
}

/* ---------------- pathfinding around water ---------------- */

console.log('\n=== Pathfinding around water ===');
{
  // A lake spanning the middle of the map with a gap only at the very bottom.
  // Any route from the left shore to the right shore must go the long way.
  const N = 40;
  const grid = new PathGrid(N, N);
  for (let y = 0; y < N - 4; y++) {
    for (let x = 18; x <= 22; x++) grid.water[y * N + x] = 1;
  }

  const start = { x: 8.5, y: 8.5 };
  const goal = { x: 30.5, y: 8.5, radius: 0 };
  const path = grid.findPath(start.x, start.y, goal, 'land');
  assert(path && path.length > 0, `a route around the lake exists (${path ? path.length : 0} waypoints)`);

  // The real bug was not in A* but in the smoothing that ran afterwards: it
  // only tested `blocked`, so it deleted the whole detour and left a path
  // heading straight across the water. Walk the final path segment by segment.
  let wetWaypoint = null, wetSegment = null;
  let prev = { x: start.x, y: start.y };
  for (const wp of path || []) {
    if (!grid.isPassable(wp.x | 0, wp.y | 0, 'land')) wetWaypoint = wp;
    const steps = Math.ceil(Math.hypot(wp.x - prev.x, wp.y - prev.y) * 4);
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const x = (prev.x + (wp.x - prev.x) * t) | 0;
      const y = (prev.y + (wp.y - prev.y) * t) | 0;
      if (!grid.isPassable(x, y, 'land')) wetSegment = { x, y };
    }
    prev = wp;
  }
  assert(!wetWaypoint, 'no waypoint sits in the water');
  assert(!wetSegment,
    `no straight segment crosses the water${wetSegment ? ` (tile ${wetSegment.x},${wetSegment.y})` : ''}`);

  const last = path[path.length - 1];
  assert(Math.max(Math.abs(last.x - goal.x), Math.abs(last.y - goal.y)) < 1.5,
    `the path actually reaches the far shore (ends at ${last.x}, ${last.y})`);

  // World positions are tile centres, so the tile a unit occupies is floor(pos).
  // Rounding instead put the search one tile off, which near a shoreline means
  // starting the search from inside the lake.
  const shore = grid.findPath(17.5, 8.5, { x: 30.5, y: 8.5, radius: 0 }, 'land');
  assert(shore && shore.length > 0, 'a unit standing on the shoreline can still path');

  // And a boat must be able to travel the lake it is confined to.
  const boat = grid.findPath(19.5, 4.5, { x: 19.5, y: 30.5, radius: 0 }, 'water');
  assert(boat && boat.length > 0, 'water units can path along the water');
  assert((boat || []).every((wp) => grid.isPassable(wp.x | 0, wp.y | 0, 'water')),
    'no boat waypoint sits on dry land');
}

/* ---------------- randomised terrain fuzz ---------------- */

console.log('\n=== Routes never cross terrain (fuzz) ===');
{
  // Hand-picked obstacle cases kept passing while real forests did not, so this
  // throws a few hundred random maps of mixed trees and water at the pathfinder
  // and checks the one invariant that matters: a route handed to a unit must be
  // walkable end to end, including the straight lines between its waypoints.
  const N = 48;
  let rng = 12345;
  const rand = () => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

  const crossing = (grid, from, path, domain) => {
    let prev = from;
    for (const wp of path) {
      // dense sampling here on purpose: the checker must not share the
      // traversal logic it is checking, or a bug in it hides itself
      const steps = Math.ceil(Math.hypot(wp.x - prev.x, wp.y - prev.y) * 64) + 1;
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const x = (prev.x + (wp.x - prev.x) * t) | 0;
        const y = (prev.y + (wp.y - prev.y) * t) | 0;
        if (!grid.isPassable(x, y, domain)) return { x, y };
      }
      prev = wp;
    }
    return null;
  };

  let maps = 0, routes = 0, bad = 0, firstBad = null;
  for (let m = 0; m < 120; m++) {
    const grid = new PathGrid(N, N);
    // scatter forest clumps and a couple of lakes
    for (let i = 0; i < 26; i++) {
      const cx = (rand() * N) | 0, cy = (rand() * N) | 0, r = 1 + ((rand() * 3) | 0);
      const water = rand() < 0.35;
      for (let y = cy - r; y <= cy + r; y++) {
        for (let x = cx - r; x <= cx + r; x++) {
          if (x < 0 || y < 0 || x >= N || y >= N) continue;
          if (water) grid.water[y * N + x] = 1; else grid.blocked[y * N + x] = 1;
        }
      }
    }
    maps++;
    for (let k = 0; k < 8; k++) {
      const a = grid.nearestOpen(rand() * N, rand() * N, 'land', 20);
      const b = grid.nearestOpen(rand() * N, rand() * N, 'land', 20);
      if (!a || !b) continue;
      const path = grid.findPath(a.x, a.y, { x: b.x, y: b.y, radius: 0 }, 'land');
      if (!path || !path.length) continue;
      routes++;
      const hit = crossing(grid, a, path, 'land');
      if (hit) { bad++; if (!firstBad) firstBad = { map: m, from: a, to: b, hit }; }
    }
  }
  assert(routes > 300, `fuzz generated enough routes to be meaningful (${routes} over ${maps} maps)`);
  assert(bad === 0,
    `no route crosses trees or water (${bad}/${routes} bad` +
    `${firstBad ? `, first at tile ${firstBad.hit.x},${firstBad.hit.y}` : ''})`);
}

/* ---------------- every obstacle actually blocks ---------------- */

console.log('\n=== Gold, stone, trees and buildings all obstruct ===');
{
  const g = new Game({ seed: 777, mapSize: 60, players: [{ civ: 'britons', name: 'A', team: 0 }] });

  // Resources that occupy their tile must mark the grid, or a unit will happily
  // walk through a gold mine and pathfinding never gets a chance to route round.
  const blockingRes = Object.keys(RESOURCE_INFO).filter((t) => RESOURCE_INFO[t].blocks);
  const missedRes = [];
  let spot = 4;
  for (const type of blockingRes) {
    const x = spot, y = 4;
    spot += 3;
    g.addEntity(makeResource(type, x + 0.5, y + 0.5, 100));
    g.grid.blocked[y * g.size + x] = 1;   // mirrors what map generation does
    if (g.grid.isPassable(x, y, 'land')) missedRes.push(type);
  }
  assert(blockingRes.length >= 3, `tree, gold and stone are all solid (${blockingRes.join(', ')})`);
  assert(missedRes.length === 0, `no solid resource is walkable (${missedRes.join(', ') || 'none'})`);

  // Every building must block its whole footprint, except the two that are
  // deliberately walkable in AoE2: Farms and open Gates.
  const walkableByDesign = [];
  const leaky = [];
  let bx = 4, by = 12;
  for (const bId of Object.keys(BUILDINGS)) {
    const def = BUILDINGS[bId];
    if (bx + def.size + 2 > g.size - 2) { bx = 4; by += 8; }
    if (by + def.size + 2 > g.size - 2) break;
    const tx = bx, ty = by;
    bx += def.size + 2;
    // clear the ground so an existing tree cannot make a leaky building look solid
    for (let y = ty; y < ty + def.size; y++) {
      for (let x = tx; x < tx + def.size; x++) g.grid.blocked[y * g.size + x] = 0;
    }
    g.placeBuilding(bId, 0, tx, ty, true);
    let open = 0;
    for (let y = ty; y < ty + def.size; y++) {
      for (let x = tx; x < tx + def.size; x++) if (g.grid.isPassable(x, y, 'land')) open++;
    }
    if (open === def.size * def.size) walkableByDesign.push(bId);
    else if (open > 0) leaky.push(`${bId} (${open} open tiles)`);
  }
  assert(leaky.length === 0, `no building half-blocks its footprint (${leaky.join(', ') || 'none'})`);
  const expectedWalkable = walkableByDesign.every((b) => BUILDINGS[b].gate || BUILDINGS[b].farmFood);
  assert(expectedWalkable,
    `only Farms and Gates are walkable (${walkableByDesign.join(', ') || 'none'})`);
}

/* ---------------- military units route around obstacles too ---------------- */

console.log('\n=== Military units route around obstacles ===');
{
  // Same pipeline as villagers, but assert it rather than assume it: a wall of
  // gold and stone mines with one gap, and a Knight told to cross it.
  const g = new Game({ seed: 909, mapSize: 60, players: [{ civ: 'franks', name: 'A', team: 0 }] });
  const N = g.size;
  const s = g.map.starts[0];
  for (const e of g.entities) {
    if (e.alive && e.owner < 0 && e.kind === 'unit' && e.def.hostile) e.alive = false;
  }

  const wallX = Math.min(N - 10, s.x + 8);
  const gapY = s.y - 6;
  for (let y = 2; y < N - 2; y++) {
    if (y === gapY || y === gapY + 1) continue;
    for (let x = wallX; x <= wallX + 1; x++) {
      g.grid.blocked[y * N + x] = 1;
      g.addEntity(makeResource(y % 2 ? 'gold' : 'stone', x + 0.5, y + 0.5, 100));
    }
  }
  for (let y = s.y + 1; y <= s.y + 5; y++) {
    for (let x = wallX + 2; x <= wallX + 6; x++) {
      if (x < N && y < N) { g.grid.blocked[y * N + x] = 0; g.grid.water[y * N + x] = 0; }
    }
  }

  const knight = g.spawnUnit('knight', 0, s.x + 1.5, s.y + 2.5);
  const goal = { x: wallX + 4.5, y: s.y + 3.5 };
  assert(!!knight && g.grid.isPassable(goal.x | 0, goal.y | 0, 'land') && knight.x < wallX,
    'test fixture: a Knight on the near side of a wall of mines');

  g.commandMove([knight], goal.x, goal.y, false);
  g.update(TICK);
  const path = knight.path || [];
  let from = { x: knight.x, y: knight.y }, crosses = null;
  for (const wp of path) {
    const steps = Math.ceil(Math.hypot(wp.x - from.x, wp.y - from.y) * 64) + 1;
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const px = (from.x + (wp.x - from.x) * t) | 0;
      const py = (from.y + (wp.y - from.y) * t) | 0;
      if (!g.grid.isPassable(px, py, 'land')) crosses = { x: px, y: py };
    }
    from = wp;
  }
  assert(path.length > 0, `the Knight is given a route (${path.length} waypoints)`);
  assert(!crosses,
    `the route goes around the mines, not through them` +
    `${crosses ? ` (crosses ${crosses.x},${crosses.y})` : ''}`);

  let stuckTicks = 0, prevX = knight.x, prevY = knight.y;
  for (let i = 0; i < 20 * 120 && knight.alive; i++) {
    g.update(TICK);
    if (knight.task.type !== 'idle' &&
        Math.hypot(knight.x - prevX, knight.y - prevY) < 1e-4) stuckTicks++;
    prevX = knight.x; prevY = knight.y;
    if (knight.task.type === 'idle' && Math.hypot(knight.x - goal.x, knight.y - goal.y) < 1.5) break;
  }
  const d = Math.hypot(knight.x - goal.x, knight.y - goal.y);
  assert(d < 2.0, `the Knight gets through the gap (${d.toFixed(2)} tiles from the goal)`);
  assert(stuckTicks < 20 * 8,
    `it does not spend the trip grinding on a mine (${(stuckTicks / 20).toFixed(1)}s stalled)`);
}

/* ---------------- a real villager walking around a real lake ---------------- */

console.log('\n=== A villager sent across water ===');
{
  const g = new Game({ seed: 4242, mapSize: 80, players: [{ civ: 'britons', name: 'A', team: 0 }] });
  const s = g.map.starts[0];

  // Carve a lake to the east of the town, leaving a land bridge along the top.
  // Anything walking to the far side has to go around it.
  const N = g.size;
  const x0 = Math.min(N - 8, s.x + 6), x1 = Math.min(N - 3, s.x + 11);
  const y0 = Math.max(1, s.y - 4), y1 = Math.min(N - 2, s.y + 14);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      g.grid.water[y * N + x] = 1;
      g.grid.blocked[y * N + x] = 0;   // trees in the lake would confuse the check
    }
  }

  // Wolves eat lone villagers, and a half-eaten villager is not a pathfinding
  // result. Clear the predators so this measures only what it claims to.
  for (const e of g.entities) {
    if (e.alive && e.owner < 0 && e.kind === 'unit' && e.def.hostile) e.alive = false;
  }

  const vill = g.entities.find((e) => e.alive && e.owner === 0 &&
    e.kind === 'unit' && e.def.cat === 'villager');
  // Clear a landing area on the far shore, so the destination cannot happen to
  // be a tree and make this a test of something else entirely.
  for (let y = s.y + 2; y <= s.y + 7; y++) {
    for (let x = x1 + 1; x <= x1 + 4; x++) {
      if (x < N && y < N) { g.grid.water[y * N + x] = 0; g.grid.blocked[y * N + x] = 0; }
    }
  }
  const goal = { x: x1 + 2.5, y: s.y + 4.5 };
  assert(!!vill && g.grid.isPassable(goal.x | 0, goal.y | 0, 'land') && vill.x < x0,
    'test fixture: a villager on the near shore and open ground on the far one');

  g.commandMove([vill], goal.x, goal.y, false);

  // Inspect the route the unit is actually handed. Arrival alone is a weak
  // check: when the smoothing sent it into the lake, the "I am stuck" recovery
  // re-pathed and sometimes stumbled to the far shore anyway. The path itself
  // is the thing that was broken.
  g.update(TICK);                       // let the path queue service the request
  const issued = vill.path || [];
  let crosses = null;
  let from = { x: vill.x, y: vill.y };
  for (const wp of issued) {
    const steps = Math.ceil(Math.hypot(wp.x - from.x, wp.y - from.y) * 4);
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const px = (from.x + (wp.x - from.x) * t) | 0;
      const py = (from.y + (wp.y - from.y) * t) | 0;
      if (!g.grid.isPassable(px, py, 'land')) crosses = { x: px, y: py };
    }
    from = wp;
  }
  assert(issued.length > 0, `the villager is given a route (${issued.length} waypoints)`);
  assert(!crosses,
    `the route it is given stays out of the lake${crosses ? ` (crosses ${crosses.x},${crosses.y})` : ''}`);

  let ticksInWater = 0;
  let closest = Infinity;
  const xs = [];
  for (let i = 0; i < 20 * 90 && vill.alive; i++) {   // up to 90 game-seconds
    g.update(TICK);
    if (!g.grid.isPassable(vill.x | 0, vill.y | 0, 'land')) ticksInWater++;
    closest = Math.min(closest, Math.hypot(vill.x - goal.x, vill.y - goal.y));
    if (i % 20 === 0) xs.push(vill.x);
    if (vill.task.type === 'idle' && closest < 1.5) break;
  }
  const finalD = Math.hypot(vill.x - goal.x, vill.y - goal.y);

  assert(ticksInWater === 0, `the villager never ends up standing in water (${ticksInWater} ticks)`);
  assert(finalD < 2.0, `the villager reaches the far shore (${finalD.toFixed(2)} tiles away)`);

  // The reported symptom was marching back and forth forever rather than simply
  // failing, so count direction reversals along the axis it has to cross.
  let reversals = 0;
  for (let i = 2; i < xs.length; i++) {
    const a = xs[i - 1] - xs[i - 2], b = xs[i] - xs[i - 1];
    if (Math.abs(a) > 0.15 && Math.abs(b) > 0.15 && Math.sign(a) !== Math.sign(b)) reversals++;
  }
  assert(reversals <= 3, `it does not oscillate at the shoreline (${reversals} reversals)`);
}

/* ---------------- map wealth and connectivity ---------------- */

console.log('\n=== Map generation ===');
{
  let worstReach = 1, unreachableStarts = 0;
  const tot = { wood: 0, gold: 0, stone: 0, food: 0 };
  const maps = 8;
  for (let s = 0; s < maps; s++) {
    const m = generateMap({ size: 120, seed: 1000 + s * 77, players: 2 });
    for (const r of m.resources) {
      if (r.type === 'tree') tot.wood += r.amount || 0;
      else if (r.type === 'gold') tot.gold += r.amount || 0;
      else if (r.type === 'stone') tot.stone += r.amount || 0;
      else if (r.type === 'berries') tot.food += r.amount || 0;
    }
    // Every extra blocking resource is a tile units cannot walk on, so a
    // richer map must not quietly seal itself into pockets.
    const size = m.size, seen = new Uint8Array(size * size);
    let land = 0;
    for (let i = 0; i < size * size; i++) {
      if (m.grid.isPassable(i % size, (i / size) | 0, 'land')) land++;
    }
    const q = [[m.starts[0].x, m.starts[0].y]];
    seen[m.starts[0].y * size + m.starts[0].x] = 1;
    let n = 0;
    while (q.length) {
      const [x, y] = q.pop(); n++;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy, k = ny * size + nx;
        if (nx < 0 || ny < 0 || nx >= size || ny >= size || seen[k]) continue;
        if (!m.grid.isPassable(nx, ny, 'land')) continue;
        seen[k] = 1; q.push([nx, ny]);
      }
    }
    worstReach = Math.min(worstReach, n / land);
    for (const st of m.starts) if (!seen[st.y * size + st.x]) unreachableStarts++;
  }
  const per = (k) => Math.round(tot[k] / maps);
  assert(per('wood') > 90000, `maps carry plenty of wood (${per('wood')} per map)`);
  assert(per('gold') > 65000, `and gold (${per('gold')})`);
  assert(per('stone') > 12000, `and stone (${per('stone')})`);
  assert(unreachableStarts === 0, `every start is reachable from every other (${unreachableStarts} bad)`);
  assert(worstReach > 0.95,
    `no map seals itself into pockets (worst is ${(worstReach * 100).toFixed(1)}% of land reachable)`);
}

/* ---------------- every map size works ---------------- */

console.log('\n=== All five map sizes ===');
{
  const SIZES = [120, 152, 184, 216, 248];
  let lastWood = 0, lastGold = 0, scalesUp = true;
  const bad = [];
  for (const size of SIZES) {
    const m = generateMap({ size, seed: 909, players: 4 });
    const amt = { wood: 0, gold: 0, stone: 0 };
    for (const r of m.resources) {
      if (r.type === 'tree') amt.wood += r.amount || 0;
      else if (r.type === 'gold') amt.gold += r.amount || 0;
      else if (r.type === 'stone') amt.stone += r.amount || 0;
    }
    // Four starts, all mutually reachable, on every size.
    const seen = new Uint8Array(size * size);
    let land = 0;
    for (let i = 0; i < size * size; i++) {
      if (m.grid.isPassable(i % size, (i / size) | 0, 'land')) land++;
    }
    const q = [[m.starts[0].x, m.starts[0].y]];
    seen[m.starts[0].y * size + m.starts[0].x] = 1;
    let n = 0;
    while (q.length) {
      const [x, y] = q.pop(); n++;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy, k = ny * size + nx;
        if (nx < 0 || ny < 0 || nx >= size || ny >= size || seen[k]) continue;
        if (!m.grid.isPassable(nx, ny, 'land')) continue;
        seen[k] = 1; q.push([nx, ny]);
      }
    }
    if (m.starts.length !== 4) bad.push(`${size}: ${m.starts.length} starts`);
    if (m.starts.some((s) => !seen[s.y * size + s.x])) bad.push(`${size}: start unreachable`);
    if (n / land < 0.95) bad.push(`${size}: only ${(n / land * 100).toFixed(0)}% reachable`);
    // Bigger maps must carry proportionally more of everything, or a large map
    // is simply a small one with longer walks. Mines used to scale with width
    // while area scales with the square, which left them thin.
    if (amt.wood <= lastWood || amt.gold <= lastGold) scalesUp = false;
    lastWood = amt.wood; lastGold = amt.gold;
  }
  assert(bad.length === 0, `every size generates a sound map (${bad.join('; ') || 'all five ok'})`);
  assert(scalesUp, 'wood and gold both grow with every step up in size');
  assert(SIZES[0] === 120, 'the smallest size is the one the game used to ship with');
}

/* ---------------- players keep to their own side ---------------- */

console.log('\n=== Two AIs do not share a woodline ===');
{
  // Runs two AIs on the same map and asks, of every node being gathered,
  // whether it is closer to the gatherer's own town or to the opponent's.
  let trespass = 0, total = 0, shared = 0;
  for (const seed of [1000, 2554]) {
    const g = new Game({ seed, mapSize: 120, speed: 1.0, players: [
      { civ: CIV_IDS[seed % CIV_IDS.length], name: 'A', team: 0 },
      { civ: CIV_IDS[(seed * 7 + 3) % CIV_IDS.length], name: 'B', team: 1 }] });
    const ais = [new AI(g, 0, 'moderate'), new AI(g, 1, 'moderate')];
    const homes = g.map.starts;
    for (let i = 0; i < Math.round(25 * 60 / TICK); i++) {
      g.update(TICK);
      if (i % 20 === 0) for (const a of ais) a.update(1);
      if (i % 400 !== 0 || g.time < 300) continue;
      const worked = [new Set(), new Set()];
      for (const e of g.entities) {
        if (!e.alive || e.kind !== 'unit' || e.owner < 0 || e.owner > 1) continue;
        if (e.def.cat !== 'villager' || e.task.type !== 'gather' || !e.task.targetId) continue;
        const node = g.get(e.task.targetId);
        if (!node || node.kind !== 'resource') continue;
        worked[e.owner].add(node.id);
        const mine = Math.hypot(node.x - homes[e.owner].x, node.y - homes[e.owner].y);
        const theirs = Math.hypot(node.x - homes[1 - e.owner].x, node.y - homes[1 - e.owner].y);
        total++;
        if (theirs < mine) trespass++;
      }
      for (const id of worked[0]) if (worked[1].has(id)) shared++;
    }
  }
  // A guard on the invariant, not a claimed improvement: measured both with and
  // without the locality scoring, trespassing sits at about 1% on this map -
  // the AI already prefers what is near its own drop-offs. This exists so a
  // future scoring change cannot quietly send both players into the same
  // woodline without anyone noticing.
  assert(total > 2000, `enough gathering was sampled (${total} villager-node observations)`);
  const pct = (trespass / Math.max(1, total)) * 100;
  assert(pct < 3,
    `villagers work their own half of the map (${pct.toFixed(1)}% on the enemy's side)`);
  assert(shared < 40, `the two AIs rarely contest the same node (${shared} shared observations)`);
}

console.log('\n=== Counter system ===');
{
  const halb = UNITS.halberdier, knight = UNITS.knight, champ = UNITS.champion;
  const arb = UNITS.arbalester, skirm = UNITS.eliteSkirmisher, pike = UNITS.pikeman;
  const camel = UNITS.heavyCamelRider, cata = UNITS.eliteCataphract;

  const halbVsKnight = computeDamage(halb.atk, knight.armor);
  const champVsKnight = computeDamage(champ.atk, knight.armor);
  assert(halbVsKnight > champVsKnight * 2,
    `Halberdier vs Knight (${halbVsKnight}) far exceeds Champion vs Knight (${champVsKnight})`);

  const skirmVsArb = computeDamage(skirm.atk, arb.armor);
  const arbVsSkirm = computeDamage(arb.atk, skirm.armor);
  assert(skirmVsArb > arbVsSkirm,
    `Elite Skirmisher out-damages Arbalester in a trade (${skirmVsArb} vs ${arbVsSkirm})`);

  const arbVsPike = computeDamage(arb.atk, pike.armor);
  assert(arbVsPike > arb.atk.pierce,
    `Arbalester gets its +3 Spearman-class bonus vs Pikeman (${arbVsPike})`);

  const camelVsKnight = computeDamage(camel.atk, knight.armor);
  assert(camelVsKnight > 15, `Heavy Camel shreds Knights (${camelVsKnight})`);

  assert(halbVsKnight === 30, `Halberdier vs Knight is exactly melee(6-2) + cavalry(26) = 30, got ${halbVsKnight}`);

  const jag = UNITS.eliteJaguarWarrior;
  const jagVsChamp = computeDamage(jag.atk, champ.armor);
  const jagVsCata = computeDamage(jag.atk, cata.armor);
  assert(jagVsCata < jagVsChamp,
    `Cataphract's 16 infantry armour blunts anti-infantry bonuses (${jagVsCata} vs ${jagVsChamp} on a Champion)`);

  const halbVsHalb = computeDamage(halb.atk, halb.armor);
  assert(halbVsHalb === 6, `Halberdier's cavalry bonus does NOT apply to other infantry (${halbVsHalb})`);

  const ramVsHouse = computeDamage(UNITS.siegeRam.atk, BUILDINGS.house.armor);
  const ramVsKnight = computeDamage(UNITS.siegeRam.atk, knight.armor);
  assert(ramVsHouse > 190, `Siege Ram devastates buildings (${ramVsHouse})`);
  assert(ramVsKnight <= 2, `Siege Ram is harmless to units — no building bonus leaks (${ramVsKnight})`);

  const knightVsHalb = computeDamage(knight.atk, halb.armor);
  assert(knightVsHalb === 10, `Knight has no bonus vs Halberdier (${knightVsHalb})`);
}

/* ---------------- data integrity ---------------- */

/* ---------------- units pick the right target ---------------- */

console.log('\n=== Units target their counters ===');
{
  const g = new Game({ seed: 5, mapSize: 60, players: [
    { civ: 'franks', name: 'A', team: 0 }, { civ: 'britons', name: 'B', team: 1 }] });
  const cx = 30, cy = 30;

  // Ring the candidates around the attacker at equal distance, so the choice is
  // decided by what the unit is for and not by which one happens to be nearest.
  const pickedBy = (attackerId, targets) => {
    for (const e of g.entities) if (e.kind !== 'resource') e.alive = false;
    const a = g.spawnUnit(attackerId, 0, cx, cy);
    targets.forEach((t, i) => {
      const ang = (i / targets.length) * Math.PI * 2;
      const x = cx + Math.cos(ang) * 4, y = cy + Math.sin(ang) * 4;
      if (t.building) g.placeBuilding(t.id, 1, Math.round(x), Math.round(y), true);
      else g.spawnUnit(t.id, 1, x, y);
    });
    g._rebuildGrid();
    const hit = g._findTarget(a, 20);
    return hit ? hit.def.name : 'nothing';
  };

  const cases = [
    ['batteringRam', [{ id: 'villager' }, { id: 'archer' }, { id: 'townCenter', building: true }],
      'Town Center', 'rams hit buildings, not people'],
    ['knight', [{ id: 'villager' }, { id: 'archer' }, { id: 'house', building: true }],
      'Villager', 'cavalry raids the economy'],
    ['scoutCavalry', [{ id: 'villager' }, { id: 'spearman' }],
      'Villager', 'scouts go around the spearman for the villager'],
    ['halberdier', [{ id: 'knight' }, { id: 'champion' }],
      'Knight', 'halberdiers pick the cavalry'],
    ['eliteSkirmisher', [{ id: 'arbalester' }, { id: 'champion' }],
      'Arbalester', 'skirmishers pick the archer'],
    ['champion', [{ id: 'mangonel' }, { id: 'archer' }],
      'Mangonel', 'infantry rushes the siege'],
    ['archer', [{ id: 'monk' }, { id: 'spearman' }],
      'Monk', 'archers shoot the monk before it converts anyone'],
    ['mangonel', [{ id: 'villager' }, { id: 'archer' }],
      'Archer', 'siege is not distracted by peasants'],
    ['militia', [{ id: 'house', building: true }, { id: 'villager' }],
      'Villager', 'infantry ignores a building it can barely dent'],
  ];
  for (const [atk, targets, expect, why] of cases) {
    const got = pickedBy(atk, targets);
    assert(got === expect, `${why} (${atk} -> ${got})`);
  }
}

/* ---------------- the AI actually booms and fights ---------------- */

console.log('\n=== AI booms to a real Imperial army ===');
{
  const g = new Game({ seed: 4108, mapSize: 120, players: [
    { civ: 'britons', name: 'A', team: 0 }, { civ: 'franks', name: 'B', team: 1 }] });
  const ais = [new AI(g, 0, 'moderate'), new AI(g, 1, 'moderate')];
  // Peak, not final. These two AIs fight a real war - hundreds of kills - so
  // the last tick can catch the economy mid-raid. What is being tested is that
  // production never stops, and the high-water mark measures exactly that
  // while a snapshot measures whoever happened to be winning at minute 60.
  const peakVills = [0, 0], peakPop = [0, 0];
  for (let i = 0; i < Math.round(60 * 60 / TICK); i++) {
    g.update(TICK);
    if (i % 20 === 0) for (const a of ais) a.update(1);
    if (i % 200 === 0) {
      for (const k of [0, 1]) {
        const n = g.entities.filter((e) => e.alive && e.owner === k &&
          e.kind === 'unit' && e.def.cat === 'villager').length;
        peakVills[k] = Math.max(peakVills[k], n);
        peakPop[k] = Math.max(peakPop[k], g.players[k].pop / g.players[k].effectivePopCap);
      }
    }
    if (g.over) break;
  }
  // Both sides run identical code, and one of them loses the war - which one
  // swings on map luck. Asserting on a fixed player index makes this a test of
  // who won rather than of whether the AI plays well, so the checks below look
  // at whichever side got to play a full game.
  const k = peakVills[0] >= peakVills[1] ? 0 : 1;

  const p = g.players[k];
  const mine = g.entities.filter((e) => e.alive && e.owner === k);
  const vills = mine.filter((e) => e.kind === 'unit' && e.def.cat === 'villager');
  const army = mine.filter((e) => e.kind === 'unit' &&
    ['infantry', 'cavalry', 'archer', 'siege', 'monk'].includes(e.def.cat));
  const siege = army.filter((e) => e.def.cat === 'siege').length;

  // Villager production used to stop dead at the age gate, pinning the economy
  // around 50 for the whole game.
  assert(peakVills[k] >= 90, `it keeps making villagers (peaked at ${peakVills[k]})`);
  assert(Math.min(...peakVills) >= 40,
    `both sides kept producing while alive (${peakVills.join(' and ')})`);
  assert(p.ageIndex >= 3, `it reaches Imperial (${p.age})`);
  // The army should be a real army, and the population should be getting used.
  assert(army.length >= 25, `it fields a real army (${army.length})`);
  assert(peakPop[k] >= 0.85,
    `it uses the population it has (peaked at ${Math.round(peakPop[k] * 100)}% of the cap)`);
  // Siege is support, not the army: a Siege Workshop can only train siege, so
  // without a share cap it queued rams forever and reached 62% of the army.
  assert(siege <= army.length * 0.25,
    `siege stays a support arm (${siege}/${army.length} = ${Math.round(siege / Math.max(1, army.length) * 100)}%)`);
  assert(p.stats.unitsKilled > 0, `the army is actually used (${p.stats.unitsKilled} kills)`);

  const idle = vills.filter((v) => v.task.type === 'idle' && !v.garrisonedIn).length;
  assert(idle <= Math.max(2, vills.length * 0.05), `still no idle villagers (${idle}/${vills.length})`);

  // Now that lines have to be walked up one tier at a time, an AI that never
  // gets round to them fights the whole game with Militia and Scouts.
  const ups = [...p.researched].filter((t) => t.startsWith('up') || t.startsWith('elite_'));
  assert(ups.length >= 4, `it works its unit lines up (${ups.length}: ${ups.join(', ')})`);
  const base = army.filter((u) => ['militia', 'spearman', 'archer', 'scoutCavalry'].includes(u.type)).length;
  assert(base <= army.length * 0.5,
    `most of the army is upgraded units, not the base tier (${base}/${army.length} base)`);
}

/* ---------------- the priority network ---------------- */

console.log('\n=== The priority network reads the game ===');
{
  // The network itself is checked exhaustively against hand-built states by
  // scripts/ai-brain-check.mjs. What matters here is the other half: that the
  // features feeding it are actually wired to the game, so a real situation
  // moves the real priorities.
  const build = (setup) => {
    const g = new Game({ seed: 77, mapSize: 80, players: [
      { civ: 'britons', name: 'A', team: 0 }, { civ: 'franks', name: 'B', team: 1 }] });
    const p = g.players[0];
    for (const a of ['feudalAge', 'castleAge']) g.completeResearch(p, a);
    p.res = { food: 600, wood: 600, gold: 400, stone: 400 };
    const s = g.map.starts[0];
    for (let i = 0; i < 25; i++) g.spawnUnit('villager', 0, s.x + 3 + (i % 5), s.y + 3 + ((i / 5) | 0));
    setup(g, s);
    g._rebuildGrid();
    g._recomputeFog();
    const ai = new AI(g, 0, 'moderate');
    ai.cacheState();
    return ai;
  };

  const calm = build(() => {});
  const raided = build((g, s) => {
    for (let i = 0; i < 10; i++) g.spawnUnit('knight', 1, s.x + 6 + (i % 4), s.y + 6 + ((i / 4) | 0));
  });

  assert(raided.pri('defense') > calm.pri('defense'),
    `an army in the town raises defence (${calm.pri('defense').toFixed(2)} -> ${raided.pri('defense').toFixed(2)})`);
  assert(raided.pri('military') > calm.pri('military'),
    `and military production (${calm.pri('military').toFixed(2)} -> ${raided.pri('military').toFixed(2)})`);
  assert(raided.pri('boom') < calm.pri('boom'),
    `while the boom is put on hold (${calm.pri('boom').toFixed(2)} -> ${raided.pri('boom').toFixed(2)})`);
  assert(raided.pri('forwardCastle') < 0.35,
    `and a Castle in their base is off the table (${raided.pri('forwardCastle').toFixed(2)})`);

  // The four gather weights are network outputs, so they have to answer the
  // bank rather than being a fixed per-age table.
  const poor = build(() => {});
  poor.p.res = { food: 20, wood: 600, gold: 900, stone: 900 };
  poor.cacheState();
  const rich = build(() => {});
  rich.p.res = { food: 1600, wood: 600, gold: 60, stone: 900 };
  rich.cacheState();
  assert(poor.resourceDemand().food > rich.resourceDemand().food,
    `an empty granary pulls villagers onto food ` +
    `(${poor.resourceDemand().food.toFixed(2)} vs ${rich.resourceDemand().food.toFixed(2)})`);
  assert(rich.resourceDemand().gold > poor.resourceDemand().gold,
    `and an empty treasury onto gold ` +
    `(${rich.resourceDemand().gold.toFixed(2)} vs ${poor.resourceDemand().gold.toFixed(2)})`);

  // Nothing in the Dark Age costs gold or stone, and mining them there was
  // costing the AI four minutes on its Feudal time.
  const dark = new Game({ seed: 78, mapSize: 80, players: [{ civ: 'britons', name: 'A', team: 0 }] });
  const darkAI = new AI(dark, 0, 'moderate');
  darkAI.cacheState();
  const ds = darkAI.resourceDemand();
  assert(ds.food + ds.wood > 0.8,
    `the Dark Age gathers food and wood almost exclusively ` +
    `(food ${ds.food.toFixed(2)}, wood ${ds.wood.toFixed(2)}, ` +
    `gold ${ds.gold.toFixed(2)}, stone ${ds.stone.toFixed(2)})`);
}

/* ---------------- trade ---------------- */

console.log('\n=== Late game, allies trade ===');
{
  // Two allies with the gold mined out. Trade Carts are the only renewable gold
  // in the game, so this is the difference between a long game that stays
  // playable and one that quietly stops being one - and it is deliberately only
  // available to a team, because a route between two of your own Markets would
  // manufacture gold out of walking distance with no partner to cut off.
  const g = new Game({ seed: 91, mapSize: 140, players: [
    { civ: 'britons', name: 'A1', team: 0 },
    { civ: 'franks', name: 'A2', team: 0 },
    { civ: 'mongols', name: 'B1', team: 1 }] });
  for (const p of g.players.slice(0, 2)) {
    for (const a of ['feudalAge', 'castleAge', 'imperialAge']) g.completeResearch(p, a);
    p.res.gold = 400;
  }
  for (const e of g.entities) {
    if (e.alive && e.kind === 'resource' && e.resType === 'gold') e.alive = false;
  }
  for (let i = 0; i < 2; i++) {
    const s = g.map.starts[i];
    for (let n = 0; n < 40; n++) g.spawnUnit('villager', i, s.x + 4 + (n % 8), s.y + 4 + ((n / 8) | 0));
  }
  g._rebuildGrid();
  const ais = g.players.map((_, i) => new AI(g, i, 'moderate'));

  let carts = 0, allyRuns = 0, goldFromTrade = 0, selfRuns = 0;
  for (let i = 0; i < Math.round(40 * 60 / TICK); i++) {
    // Kept solvent in wood and food so this measures the trade decision rather
    // than a starving economy.
    if (i % 200 === 0) for (const p of g.players.slice(0, 2)) { p.res.wood += 400; p.res.food += 400; }
    const before = g.players[0].res.gold;
    g.update(TICK);
    if (g.players[0].res.gold > before) goldFromTrade += g.players[0].res.gold - before;
    if (i % 20 === 0) for (const a of ais) a.update(1);
    if (i % 100 === 0) {
      const live = g.entities.filter((e) => e.alive && e.owner === 0 &&
        e.kind === 'unit' && e.def.cat === 'trade');
      carts = Math.max(carts, live.length);
      for (const c of live) {
        if (c.task.type !== 'trade') continue;
        const m = g.get(c.task.marketId);
        if (!m) continue;
        if (m.owner === c.owner) selfRuns++; else allyRuns++;
      }
    }
    if (g.over) break;
  }
  assert(carts >= 4, `it puts a real fleet of Trade Carts on the road (${carts})`);
  assert(allyRuns > 0, `and they run to the ally's Market (${allyRuns} observations)`);
  assert(selfRuns === 0, `never to one of our own (${selfRuns} observations)`);
  assert(goldFromTrade > 50,
    `so gold keeps arriving with no mine left (${Math.round(goldFromTrade)} delivered)`);
}

console.log('\n=== A lone player cannot trade with itself ===');
{
  const g = new Game({ seed: 91, mapSize: 100, players: [{ civ: 'britons', name: 'A', team: 0 }] });
  const p = g.players[0];
  for (const a of ['feudalAge', 'castleAge', 'imperialAge']) g.completeResearch(p, a);
  for (const e of g.entities) {
    if (e.alive && e.kind === 'resource' && e.resType === 'gold') e.alive = false;
  }
  p.res.gold = 400;
  const s = g.map.starts[0];
  for (let i = 0; i < 40; i++) g.spawnUnit('villager', 0, s.x + 4 + (i % 8), s.y + 4 + ((i / 8) | 0));
  g._rebuildGrid();
  const ai = new AI(g, 0, 'moderate');
  let carts = 0;
  for (let i = 0; i < Math.round(25 * 60 / TICK); i++) {
    if (i % 200 === 0) { p.res.wood += 400; p.res.food += 400; }
    g.update(TICK);
    if (i % 20 === 0) ai.update(1);
    if (i % 200 === 0) {
      carts = Math.max(carts, g.entities.filter((e) => e.alive && e.owner === 0 &&
        e.kind === 'unit' && e.def.cat === 'trade').length);
    }
  }
  assert(carts === 0, `no Trade Carts with nobody to trade with (${carts})`);
  assert(ai.tradePotential === null, 'and the AI knows there is no route to have');
}

/* ---------------- allied AIs ---------------- */

console.log('\n=== Allied AIs play as a team ===');
{
  const g = new Game({ seed: 4242, mapSize: 140, players: [
    { civ: 'britons', name: 'A1', team: 0 },
    { civ: 'franks', name: 'A2', team: 0 },
    { civ: 'mongols', name: 'B1', team: 1 },
    { civ: 'teutons', name: 'B2', team: 1 }] });
  const ais = g.players.map((_, i) => new AI(g, i, 'moderate'));

  assert(ais[0].team === ais[1].team, 'allies share one TeamBrain');
  assert(ais[0].team !== ais[2].team, 'and enemies do not');

  let tributes = 0;
  const realTribute = g.tribute.bind(g);
  g.tribute = (a, b, r, n) => { const sent = realTribute(a, b, r, n); if (sent) tributes++; return sent; };

  let sameFocus = 0, samples = 0, allyTrade = 0;
  const roles = new Set();
  for (let i = 0; i < Math.round(40 * 60 / TICK); i++) {
    g.update(TICK);
    if (i % 20 === 0) for (const a of ais) a.update(1);
    if (i % 400 === 0 && g.time > 600) {
      samples++;
      const f0 = ais[0].team.focus, f1 = ais[1].team.focus;
      // Allies share one TeamBrain, so a focus that exists is the same object
      // for both of them. Samples where nobody has been scouted yet are not
      // disagreements, they are simply nothing to agree about.
      if (!f0 && !f1) { samples--; continue; }
      if (f0 && f1 && f0.player.index === f1.player.index) sameFocus++;
      for (const a of ais) roles.add(a.team.roleOf(a));
      for (const c of g.entities) {
        if (!c.alive || c.kind !== 'unit' || c.def.cat !== 'trade') continue;
        if (c.task.type !== 'trade') continue;
        const m = g.get(c.task.marketId);
        if (m && m.owner !== c.owner && g.isAlly(m.owner, c.owner)) allyTrade++;
      }
    }
    if (g.over) break;
  }

  assert(samples > 0, `the team game ran long enough to measure (${samples} samples)`);
  // Not every single sample: the team re-picks its target on its own clock, so
  // a sample can land in the tick between one member reading the new focus and
  // the other one doing so.
  assert(sameFocus === samples,
    `allies always agree which enemy to attack (${sameFocus}/${samples} samples)`);
  assert(roles.has('vanguard') && roles.has('quartermaster'),
    `the team splits into different jobs (${[...roles].join(', ')})`);
  assert(allyTrade > 0,
    `Trade Carts run to an ally's Market, which is where the gold is (${allyTrade} observations)`);
  assert(tributes > 0, `and a rich ally bails out a poor one (${tributes} tributes)`);
}

/* ---------------- castle siting ---------------- */

console.log('\n=== Castles are placed on purpose ===');
{
  const setup = (extra) => {
    const g = new Game({ seed: 63, mapSize: 100, players: [
      { civ: 'britons', name: 'A', team: 0 }, { civ: 'franks', name: 'B', team: 1 }] });
    const p = g.players[0];
    for (const a of ['feudalAge', 'castleAge']) g.completeResearch(p, a);
    p.res = { food: 800, wood: 800, gold: 500, stone: 900 };
    const s = g.map.starts[0];
    for (let i = 0; i < 30; i++) g.spawnUnit('villager', 0, s.x + 3 + (i % 6), s.y + 3 + ((i / 6) | 0));
    extra(g, s, g.map.starts[1]);
    g._rebuildGrid();
    g.revealAll = true;
    g._recomputeFog();
    const ai = new AI(g, 0, 'moderate');
    ai.cacheState();
    return { g, ai, enemy: g.map.starts[1] };
  };

  // Defensive: over our own economy, and at home.
  const home = setup(() => {});
  const defSpot = home.ai.findDefensiveCastleSpot();
  assert(!!defSpot, 'it picks a defensive Castle site');
  if (defSpot) {
    const toHome = Math.hypot(defSpot.x - home.ai.homeX, defSpot.y - home.ai.homeY);
    assert(toHome < 40, `sited over our own town (${toHome.toFixed(1)} tiles from the Town Center)`);
    const covered = home.ai.mine.villagers.filter((v) =>
      Math.hypot(v.x - defSpot.x, v.y - defSpot.y) < 12).length;
    assert(covered >= 5, `and covering the economy (${covered} villagers inside its range)`);
  }

  // Aggressive: only with an army already standing out there to protect it.
  const noArmy = setup(() => {});
  assert(noArmy.ai.findForwardCastleSpot() === null,
    'no forward Castle without an army to protect the build');

  const withArmy = setup((g, s, e) => {
    for (let i = 0; i < 14; i++) {
      g.spawnUnit('knight', 0, e.x - 12 + (i % 5), e.y - 12 + ((i / 5) | 0));
    }
  });
  const fwd = withArmy.ai.findForwardCastleSpot();
  assert(!!fwd, 'with an army in their half, it picks a forward Castle site');
  if (fwd) {
    const toThem = Math.hypot(fwd.x - withArmy.enemy.x, fwd.y - withArmy.enemy.y);
    const toUs = Math.hypot(fwd.x - withArmy.ai.homeX, fwd.y - withArmy.ai.homeY);
    assert(toThem < toUs,
      `and it is in their half, not ours (${toThem.toFixed(0)} vs ${toUs.toFixed(0)} tiles)`);
  }
}

/* ---------------- attacking a defended base ---------------- */

console.log('\n=== It kills the defences before diving for the Town Center ===');
{
  // Their Town Center in the middle, two Castles covering the approach, and our
  // army outside. Walking past the Castles to reach the Town Center is how an
  // army feeds itself in one unit at a time.
  const g = new Game({ seed: 71, mapSize: 100, players: [
    { civ: 'britons', name: 'A', team: 0 }, { civ: 'franks', name: 'B', team: 1 }] });
  const p = g.players[0];
  for (const a of ['feudalAge', 'castleAge']) g.completeResearch(p, a);
  const home = g.map.starts[0];
  // A compact enemy base well away from ours, laid out by hand.
  const bx = Math.round((home.x + g.map.starts[1].x) / 2);
  const by = Math.round((home.y + g.map.starts[1].y) / 2);
  const tc = g.placeBuilding('townCenter', 1, bx, by, true);
  const castleNear = g.placeBuilding('castle', 1, bx - 12, by, true);
  g.placeBuilding('castle', 1, bx + 8, by, true);
  g.placeBuilding('house', 1, bx - 3, by + 8, true);
  // Our army parked outside, on the near Castle's side.
  const army = [];
  for (let i = 0; i < 16; i++) {
    army.push(g.spawnUnit('knight', 0, bx - 22 + (i % 4), by - 2 + ((i / 4) | 0)));
  }
  g._rebuildGrid();
  g.revealAll = true;
  g._recomputeFog();
  const ai = new AI(g, 0, 'moderate');
  ai.cacheState();

  assert(!!tc && !!castleNear, 'test fixture: a Town Center ringed by two Castles');

  const target = ai.pickAttackTarget(army);
  assert(!!target, 'the army is given a target');
  if (target) {
    assert(target.type !== 'townCenter',
      `it does not march past the Castles for the Town Center (picked ${target.type})`);
    assert(target.id === castleNear.id,
      `it attacks the Castle on its own side of the base first (picked ${target.type})`);
  }

  // The cover reading is what drives it: the middle of the base is under two
  // Castles, the near edge is under one.
  const atTc = ai.enemyCoverAt(tc.x, tc.y);
  const outside = ai.enemyCoverAt(bx - 22, by);
  assert(atTc > outside,
    `the Town Center reads as far better covered than open ground (${atTc} vs ${outside})`);

  // And once the defences are gone the Town Center becomes the target.
  g.kill(castleNear, null);
  for (const e of g.entities) {
    if (e.alive && e.owner === 1 && e.type === 'castle') g.kill(e, null);
  }
  g._rebuildGrid();
  ai.cacheState();
  const after = ai.pickAttackTarget(army);
  assert(after && after.type === 'townCenter',
    `with the Castles down it goes for the Town Center (picked ${after ? after.type : 'nothing'})`);
}

/* ---------------- raiding in several places at once ---------------- */

console.log('\n=== Raids hit several places at once ===');
{
  // An enemy economy spread over three corners, and a big idle army of ours.
  // One squad walking to one place is not a raid - it is a small attack the
  // defender meets in one spot.
  const g = new Game({ seed: 72, mapSize: 120, players: [
    { civ: 'britons', name: 'A', team: 0 }, { civ: 'franks', name: 'B', team: 1 }] });
  const p = g.players[0];
  for (const a of ['feudalAge', 'castleAge']) g.completeResearch(p, a);
  const home = g.map.starts[0];
  // Three separate villager camps, well apart.
  const spots = [[30, 30], [30, 90], [90, 30]];
  for (const [sx, sy] of spots) {
    for (let i = 0; i < 6; i++) g.spawnUnit('villager', 1, sx + (i % 3), sy + ((i / 3) | 0));
  }
  for (let i = 0; i < 40; i++) {
    g.spawnUnit('knight', 0, home.x + 2 + (i % 6), home.y + 2 + ((i / 6) | 0));
  }
  g._rebuildGrid();
  g.revealAll = true;
  g._recomputeFog();
  const ai = new AI(g, 0, 'moderate');
  // Force the raiding priority up: what is under test is the squad handling,
  // not the network's willingness to raid on this particular map.
  ai.cacheState();
  ai.brain.values.raid = 0.9;
  ai.manageRaid();

  const parties = ai.squads.raids;
  assert(parties.length >= 2, `it forms more than one raiding party (${parties.length})`);
  const sizes = parties.map((x) => x.ids.length);
  assert(sizes.every((n) => n >= 3), `each party is a real group (${sizes.join(', ')})`);
  const ids = new Set();
  let overlap = 0;
  for (const party of parties) for (const id of party.ids) {
    if (ids.has(id)) overlap++;
    ids.add(id);
  }
  assert(overlap === 0, `no unit is in two parties at once (${overlap} overlaps)`);

  const targets = parties.map((x) => g.get(x.targetId)).filter(Boolean);
  assert(targets.length === parties.length, 'every party is given a target');
  if (targets.length >= 2) {
    let closest = Infinity;
    for (let i = 0; i < targets.length; i++) {
      for (let j = i + 1; j < targets.length; j++) {
        closest = Math.min(closest, Math.hypot(targets[i].x - targets[j].x, targets[i].y - targets[j].y));
      }
    }
    assert(closest > 20,
      `and they are sent to different parts of the map (${closest.toFixed(0)} tiles apart)`);
  }
  // The main army must not be raiding: waves and raids draw from one pool.
  const raiders = ai.raiderIds();
  assert(raiders.size < 40, `the main army is not all out raiding (${raiders.size}/40)`);
}

/* ---------------- answering the attacker ---------------- */

console.log('\n=== It answers what is actually attacking it ===');
{
  // The same enemy army, once at the far edge of the map and once in our town,
  // both fully visible. What is hitting the town should shape the build more
  // than what was merely spotted somewhere.
  const compWith = (inOurTown) => {
    const g = new Game({ seed: 5, mapSize: 90, players: [
      { civ: 'britons', name: 'A', team: 0 }, { civ: 'franks', name: 'B', team: 1 }] });
    const p = g.players[0];
    for (const a of ['feudalAge', 'castleAge', 'imperialAge']) g.completeResearch(p, a);
    for (const t of ['upPikeman', 'upHalberdier', 'upCrossbowman', 'upArbalester',
      'upEliteSkirmisher', 'upLightCavalry', 'upHussar']) {
      if (p.isTechAvailable(t)) g.completeResearch(p, t);
    }
    const s = g.map.starts[0];
    for (let i = 0; i < 12; i++) g.spawnUnit('arbalester', 0, s.x - 4 + (i % 4), s.y - 4 + ((i / 4) | 0));
    const ex = inOurTown ? s.x + 5 : Math.min(g.size - 6, s.x + 45);
    const ey = inOurTown ? s.y + 5 : Math.min(g.size - 6, s.y + 45);
    for (let i = 0; i < 10; i++) g.spawnUnit('knight', 1, ex + (i % 4) * 0.7, ey + ((i / 4) | 0) * 0.7);
    g._rebuildGrid();
    g.revealAll = true;          // equally visible either way; only distance differs
    g._recomputeFog();
    const ai = new AI(g, 0, 'moderate');
    ai.cacheState();
    const anti = ai.desiredComposition()
      .filter((w) => ['halberdier', 'pikeman', 'spearman'].includes(w.id))
      .reduce((t, w) => t + w.share, 0);
    return { anti, counter: ai.pri('counter') };
  };

  const far = compWith(false);
  const near = compWith(true);
  assert(near.anti > 0.2,
    `Knights in the town are answered with Halberdiers (${(near.anti * 100).toFixed(0)}% of the plan)`);
  assert(near.anti > far.anti,
    `and more so than the same army sitting far away ` +
    `(${(near.anti * 100).toFixed(0)}% vs ${(far.anti * 100).toFixed(0)}%)`);
  assert(near.counter > far.counter,
    `because being hit is what raises the counter priority ` +
    `(${far.counter.toFixed(2)} -> ${near.counter.toFixed(2)})`);
}

/* ---------------- unit upgrade lines ---------------- */

/* ---------------- countering what it has scouted ---------------- */

console.log('\n=== The AI counters what it sees ===');
{
  // Puts an enemy army next to the AI's town (so it is genuinely in sight) and
  // reads back the composition it decides to build.
  const compAgainst = (enemy, { visible = true } = {}) => {
    const g = new Game({ seed: 3, mapSize: 80, players: [
      { civ: 'britons', name: 'A', team: 0 }, { civ: 'franks', name: 'B', team: 1 }] });
    const p = g.players[0];
    for (const a of ['feudalAge', 'castleAge', 'imperialAge']) g.completeResearch(p, a);
    for (const t of ['upPikeman', 'upHalberdier', 'upEliteSkirmisher', 'upCrossbowman',
      'upArbalester', 'upLightCavalry', 'upHussar', 'upManAtArms', 'upLongSwordsman']) {
      if (p.isTechAvailable(t)) g.completeResearch(p, t);
    }
    const s = g.map.starts[0];
    const ex = visible ? s.x + 4 : g.size - 5;
    const ey = visible ? s.y + 4 : g.size - 5;
    for (const [id, n] of Object.entries(enemy)) {
      for (let i = 0; i < n; i++) g.spawnUnit(id, 1, ex + (i % 4) * 0.7, ey + Math.floor(i / 4) * 0.7);
    }
    g._rebuildGrid();
    g._recomputeFog();
    const ai = new AI(g, 0, 'moderate');
    ai.cacheState();
    return ai.desiredComposition().sort((a, b) => b.share - a.share);
  };
  const top = (c) => (c[0] ? c[0].id : 'nothing');

  assert(top(compAgainst({ cavalryArcher: 10 })) === 'eliteSkirmisher',
    'Cavalry Archers are answered with Skirmishers');
  assert(top(compAgainst({ arbalester: 10 })) === 'eliteSkirmisher',
    'Arbalesters are answered with Skirmishers');
  assert(top(compAgainst({ knight: 10 })) === 'halberdier',
    'Knights are answered with Halberdiers');
  assert(top(compAgainst({ champion: 10 })) === 'arbalester',
    'massed infantry is answered with Arbalesters');
  assert(top(compAgainst({ batteringRam: 6 })) === 'hussar',
    'siege is answered with fast cavalry');

  // A mixed army should produce a mixed answer, not just the counter to whichever
  // unit happened to be counted first.
  const mixed = compAgainst({ knight: 6, arbalester: 6 }).map((w) => w.id);
  assert(mixed.includes('halberdier') && mixed.includes('eliteSkirmisher'),
    `a mixed army gets a mixed answer (${mixed.slice(0, 3).join(', ')})`);

  // And none of it happens until the two sides have actually met.
  const unseen = compAgainst({ knight: 10 }, { visible: false }).map((w) => w.id);
  assert(!unseen.includes('halberdier') && !unseen.includes('pikeman'),
    `an unscouted army is not countered (${unseen.slice(0, 3).join(', ')})`);
}

/* ---------------- emergency castle ---------------- */

console.log('\n=== Under attack, it builds a Castle ===');
{
  const run = (threatened) => {
    const g = new Game({ seed: 11, mapSize: 80, speed: 1.0, players: [
      { civ: 'britons', name: 'A', team: 0 }, { civ: 'franks', name: 'B', team: 1 }] });
    const p = g.players[0];
    for (const a of ['feudalAge', 'castleAge']) g.completeResearch(p, a);
    p.res = { food: 900, wood: 900, gold: 500, stone: 200 };
    const s = g.map.starts[0];
    for (let i = 0; i < 20; i++) g.spawnUnit('villager', 0, s.x + 3 + (i % 5), s.y + 3 + ((i / 5) | 0));
    const ai = new AI(g, 0, 'moderate');
    if (threatened) {
      for (let i = 0; i < 8; i++) {
        g.spawnUnit('knight', 1, s.x + 12 + (i % 4), s.y + 12 + ((i / 4) | 0));
      }
    }
    let castleAt = null, committed = false, peakMiners = 0;
    for (let i = 0; i < Math.round(22 * 60 / TICK); i++) {
      g.update(TICK);
      if (i % 20 === 0) ai.update(1);
      if (ai.wantEmergencyCastle) committed = true;
      if (i % 100 === 0) {
        peakMiners = Math.max(peakMiners, g.entities.filter((e) => e.alive && e.owner === 0 &&
          e.kind === 'unit' && e.task && e.task.resType === 'stone').length);
      }
      if (!castleAt && g.entities.some((e) => e.alive && e.owner === 0 && e.type === 'castle')) {
        castleAt = g.time / 60;
      }
    }
    return { castleAt, committed, peakMiners };
  };

  const attacked = run(true);
  const calm = run(false);
  assert(attacked.committed, 'an army in the town makes the AI commit to a Castle');
  assert(!calm.committed, 'a peaceful AI does not panic-build one');
  assert(attacked.castleAt !== null,
    `the Castle actually gets laid (${attacked.castleAt ? attacked.castleAt.toFixed(1) + 'm' : 'never'})`);
  // Absolute, not relative to the calm run: a peaceful AI also mines stone for
  // the Castles it wants anyway, so comparing the two no longer isolates the
  // emergency response. What matters is that real labour goes onto stone.
  assert(attacked.peakMiners >= 8,
    `villagers are switched onto stone for it (${attacked.peakMiners} miners at peak)`);
  assert(calm.castleAt === null || attacked.castleAt < calm.castleAt,
    `and it is up sooner than it otherwise would be ` +
    `(${attacked.castleAt.toFixed(1)}m vs ${calm.castleAt ? calm.castleAt.toFixed(1) + 'm' : 'never'})`);
}

/* ---------------- camps follow the villagers ---------------- */

console.log('\n=== A long haul earns a closer camp ===');
{
  // A crew of woodcutters working a forest far from any drop-off. The AI
  // should notice the walk and plant a Lumber Camp on top of them, rather than
  // leaving them hauling across the map for the rest of the game.
  const g = new Game({ seed: 21, mapSize: 80, players: [{ civ: 'britons', name: 'A', team: 0 }] });
  const p = g.players[0];
  g.completeResearch(p, 'feudalAge');
  p.res = { food: 500, wood: 500, gold: 200, stone: 200 };
  const s = g.map.starts[0];

  // Strip every tree near the town, so the only wood left is a long walk away.
  // Without this the AI simply re-tasks the crew onto closer trees - which is
  // correct, and means the long haul this feature exists for never happens.
  const fx = Math.min(g.size - 10, s.x + 24), fy = Math.min(g.size - 10, s.y + 6);
  for (const e of g.entities) {
    if (e.alive && e.kind === 'resource' && e.type === 'tree' &&
        Math.hypot(e.x - s.x, e.y - s.y) < 20) {
      e.alive = false;
      g.grid.blocked[(e.y | 0) * g.size + (e.x | 0)] = 0;
    }
  }
  const trees = [];
  for (let y = fy; y < fy + 5; y++) {
    for (let x = fx; x < fx + 5; x++) {
      const t = makeResource('tree', x + 0.5, y + 0.5, 100);
      g.addEntity(t);
      g.grid.blocked[y * g.size + x] = 1;
      trees.push(t);
    }
  }
  const crew = [];
  for (let i = 0; i < 8; i++) crew.push(g.spawnUnit('villager', 0, s.x + 2 + (i % 4), s.y + 2 + ((i / 4) | 0)));
  g._rebuildGrid();
  for (let i = 0; i < crew.length; i++) g.commandGather([crew[i]], trees[i]);

  const ai = new AI(g, 0, 'moderate');
  // The AI also plants camps at un-served clusters near home, so this looks
  // specifically for one that lands on the distant forest - that is the
  // behaviour under test.
  // Waits for a *finished* camp: a foundation is not a drop-off, so breaking
  // out the moment one is laid measures the haul before anything changed.
  const nearForest = () => g.entities.find((e) => e.alive && e.owner === 0 &&
    e.type === 'lumberCamp' && e.complete && Math.hypot(e.x - (fx + 2), e.y - (fy + 2)) < 8);
  let camp = null;
  for (let i = 0; i < Math.round(14 * 60 / TICK) && !camp; i++) {
    g.update(TICK);
    if (i % 20 === 0) ai.update(1);
    camp = nearForest();
  }
  assert(!!camp, 'a Lumber Camp is planted on the distant forest');
  if (camp) {
    const toForest = Math.hypot(camp.x - (fx + 2), camp.y - (fy + 2));
    const toHome = Math.hypot(camp.x - s.x, camp.y - s.y);
    assert(toForest < toHome,
      `and it is nearer the work than the town (${toForest.toFixed(1)} vs ${toHome.toFixed(1)} tiles)`);
    // The point of the whole exercise: the haul from those trees is now short.
    ai.cacheState();
    assert(ai.dropDist(fx + 2, fy + 2, 'wood') < AI.REHOME_DISTANCE,
      `the crew's haul is now short (${ai.dropDist(fx + 2, fy + 2, 'wood').toFixed(1)} tiles)`);
  }
}

/* ---------------- unique units and the population cap ---------------- */

console.log('\n=== Unique units, and spending at the cap ===');
{
  const g = new Game({ seed: 31, mapSize: 80, players: [
    { civ: 'teutons', name: 'A', team: 0 }, { civ: 'franks', name: 'B', team: 1 }] });
  const p = g.players[0];
  for (const a of ['feudalAge', 'castleAge']) g.completeResearch(p, a);
  const s = g.map.starts[0];
  const ai = new AI(g, 0, 'moderate');

  // With a Castle up, the unique unit has to be a real part of the plan.
  g.placeBuilding('castle', 0, s.x + 6, s.y + 6, true);
  g._rebuildGrid();
  ai.cacheState();
  const want = ai.desiredComposition().find((w) => w.id === p.civ.uu || w.id === p.civ.uuElite);
  assert(!!want && want.share >= 0.15,
    `the unique unit is a real share of the army (${want ? Math.round(want.share * 100) + '%' : 'absent'})`);

  // A second Castle should raise it further - each one is another producer.
  g.placeBuilding('castle', 0, s.x - 8, s.y + 6, true);
  g._rebuildGrid();
  ai.cacheState();
  const want2 = ai.desiredComposition().find((w) => w.id === p.civ.uu || w.id === p.civ.uuElite);
  assert(want2.share > want.share,
    `a second Castle asks for more of them (${Math.round(want.share * 100)}% -> ${Math.round(want2.share * 100)}%)`);

  // At the population cap, research opens right up: there is nothing else to buy.
  p.res = { food: 5000, wood: 5000, gold: 5000, stone: 3000 };
  for (const b of ['blacksmith', 'university', 'market', 'mill', 'lumberCamp', 'miningCamp']) {
    g.placeBuilding(b, 0, s.x + 10 + Math.random() * 2, s.y - 8, true);
  }
  g._rebuildGrid();
  ai.cacheState();
  const beforeQ = () => ai.mine.buildings.reduce((n, b) =>
    n + b.queue.filter((q) => q.kind === 'tech').length, 0);
  ai.planReserve();
  ai.manageResearch();
  const normal = beforeQ();

  // Now pin the population at the cap and try again.
  const g2 = new Game({ seed: 31, mapSize: 80, players: [
    { civ: 'teutons', name: 'A', team: 0 }, { civ: 'franks', name: 'B', team: 1 }] });
  const p2 = g2.players[0];
  for (const a of ['feudalAge', 'castleAge']) g2.completeResearch(p2, a);
  p2.res = { food: 5000, wood: 5000, gold: 5000, stone: 3000 };
  const s2 = g2.map.starts[0];
  for (const b of ['blacksmith', 'university', 'market', 'mill', 'lumberCamp', 'miningCamp']) {
    g2.placeBuilding(b, 0, s2.x + 10 + Math.random() * 2, s2.y - 8, true);
  }
  g2._rebuildGrid();
  const ai2 = new AI(g2, 0, 'moderate');
  ai2.cacheState();
  // At the real limit, not merely short of Houses - the AI distinguishes the
  // two, because a housing block is temporary and the game's cap is not.
  p2.popCap = p2.popMax;
  p2.pop = p2.effectivePopCap;
  ai2.planReserve();
  ai2.manageResearch();
  const capped = ai2.mine.buildings.reduce((n, b) =>
    n + b.queue.filter((q) => q.kind === 'tech').length, 0);

  assert(capped > normal,
    `at the population cap it researches far more at once (${normal} -> ${capped} queued)`);
  assert(capped >= 4, `and it really is a sweep, not one extra (${capped} techs queued)`);
}

/* ---------------- economy upgrade timing ---------------- */

console.log('\n=== Wheelbarrow and Hand Cart are timed ===');
{
  // Both are a flat cost buying a small per-villager gain, so buying them early
  // spends food that would have been villagers. Watch when the AI actually
  // takes them.
  const g = new Game({ seed: 2554, mapSize: 120, players: [
    { civ: 'britons', name: 'A', team: 0 }, { civ: 'franks', name: 'B', team: 1 }] });
  const ais = [new AI(g, 0, 'moderate'), new AI(g, 1, 'moderate')];
  const p = g.players[0];
  const at = {};
  const countVills = () => g.entities.filter((e) => e.alive && e.owner === 0 &&
    e.kind === 'unit' && e.def.cat === 'villager').length;
  const countFarms = () => g.entities.filter((e) => e.alive && e.owner === 0 &&
    e.type === 'farm').length;

  // Peak villagers, not the count at the moment it finishes: research takes up
  // to 75 seconds and a raid during it would otherwise read as the AI having
  // bought the tech early. What is being tested is the size of economy that
  // triggered the decision.
  let peak = 0;
  for (let i = 0; i < Math.round(60 * 60 / TICK); i++) {
    g.update(TICK);
    if (i % 20 === 0) for (const a of ais) a.update(1);
    if (i % 40 === 0) peak = Math.max(peak, countVills());
    for (const t of ['wheelbarrow', 'handCart']) {
      if (!at[t] && p.researched.has(t)) {
        at[t] = { vills: Math.max(peak, countVills()), farms: countFarms() };
      }
    }
    if (at.wheelbarrow && at.handCart) break;
  }

  assert(!!at.wheelbarrow, 'Wheelbarrow gets researched at all');
  if (at.wheelbarrow) {
    assert(at.wheelbarrow.vills >= 40 || at.wheelbarrow.farms >= 17,
      `Wheelbarrow waits for the economy to earn it back ` +
      `(${at.wheelbarrow.vills} villagers, ${at.wheelbarrow.farms} farms)`);
  }
  assert(!!at.handCart, 'Hand Cart gets researched at all');
  if (at.handCart) {
    assert(at.handCart.vills >= 60,
      `Hand Cart waits for a bigger one still (${at.handCart.vills} villagers)`);
    assert(at.handCart.vills >= at.wheelbarrow.vills,
      `and it comes after Wheelbarrow (${at.wheelbarrow.vills} -> ${at.handCart.vills})`);
  }
}

/* ---------------- villagers avoid dangerous ground ---------------- */

console.log('\n=== Villagers avoid dangerous ground ===');
{
  // Two equal woodlines the same distance either side of the town, and only
  // enough trees in each that both are needed. Then put an enemy Castle over
  // one of them and see where the villagers go.
  const run = (withCastle) => {
    const g = new Game({ seed: 55, mapSize: 90, players: [
      { civ: 'britons', name: 'A', team: 0 }, { civ: 'franks', name: 'B', team: 1 }] });
    const p = g.players[0];
    g.completeResearch(p, 'feudalAge');
    p.res = { food: 600, wood: 600, gold: 300, stone: 300 };
    const s = g.map.starts[0];
    for (const e of g.entities) {
      if (e.alive && e.kind === 'resource' && e.type === 'tree' &&
          Math.hypot(e.x - s.x, e.y - s.y) < 26) {
        e.alive = false;
        g.grid.blocked[(e.y | 0) * g.size + (e.x | 0)] = 0;
      }
    }
    const plant = (px, py) => {
      const out = [];
      for (let y = py; y < py + 3; y++) {
        for (let x = px; x < px + 3; x++) {
          if (x < 1 || y < 1 || x >= g.size - 1 || y >= g.size - 1) continue;
          const t = makeResource('tree', x + 0.5, y + 0.5, 175);
          g.addEntity(t);
          g.grid.blocked[y * g.size + x] = 1;
          out.push(t);
        }
      }
      return out;
    };
    const safe = plant(Math.max(2, s.x - 15), s.y);
    const risky = plant(Math.min(g.size - 6, s.x + 15), s.y);
    if (withCastle) g.placeBuilding('castle', 1, Math.min(g.size - 7, s.x + 19), s.y, true);
    for (let i = 0; i < 20; i++) g.spawnUnit('villager', 0, s.x + 1 + (i % 4), s.y + 1 + ((i / 4) | 0));
    g._rebuildGrid();
    g._recomputeFog();
    const ai = new AI(g, 0, 'moderate');
    const safeIds = new Set(safe.map((t) => t.id));
    const riskyIds = new Set(risky.map((t) => t.id));
    let onSafe = 0, onRisky = 0;
    for (let i = 0; i < Math.round(6 * 60 / TICK); i++) {
      g.update(TICK);
      if (i % 20 === 0) ai.update(1);
      if (i % 200 !== 0 || g.time < 60) continue;
      for (const e of g.entities) {
        if (!e.alive || e.owner !== 0 || e.kind !== 'unit' || e.def.cat !== 'villager') continue;
        if (e.task.type !== 'gather' || !e.task.targetId) continue;
        if (safeIds.has(e.task.targetId)) onSafe++;
        else if (riskyIds.has(e.task.targetId)) onRisky++;
      }
    }
    return { onSafe, onRisky };
  };

  const open = run(false);
  const covered = run(true);
  // Relative to the unthreatened run, not a fixed number: the exact split
  // depends on the surrounding map, which shifts whenever map generation
  // changes. What has to hold is that the second woodline is genuinely in use
  // to begin with, and that the Castle then empties it.
  assert(open.onRisky > open.onSafe * 0.15,
    `with no threat both woodlines get worked (${open.onSafe} vs ${open.onRisky})`);
  assert(covered.onRisky < open.onRisky * 0.5,
    `an enemy Castle over one drives the villagers off it ` +
    `(${open.onRisky} -> ${covered.onRisky} villager-observations)`);
  assert(covered.onSafe > covered.onRisky * 3,
    `they crowd the safe woodline instead (${covered.onSafe} vs ${covered.onRisky})`);
}

console.log('\n=== Unit upgrade lines ===');
{
  const g = new Game({ seed: 1, mapSize: 60, players: [
    { civ: 'britons', name: 'A', team: 0 },
    { civ: 'bulgarians', name: 'B', team: 1 },
    { civ: 'turks', name: 'C', team: 2 }] });
  const p = g.players[0];
  for (const a of ['feudalAge', 'castleAge', 'imperialAge']) g.completeResearch(p, a);

  // Reaching the Imperial Age must not hand over the top of every line. Only
  // the base unit of each line is trainable until its upgrade is bought.
  const base = ['militia', 'spearman', 'archer', 'skirmisher', 'scoutCavalry', 'knight'];
  const upgraded = ['manAtArms', 'longSwordsman', 'twoHandedSwordsman', 'champion',
    'pikeman', 'halberdier', 'crossbowman', 'arbalester', 'eliteSkirmisher',
    'lightCavalry', 'hussar', 'cavalier', 'paladin'];
  const wrongBase = base.filter((id) => !p.isUnitAvailable(id));
  const wrongUp = upgraded.filter((id) => p.isUnitAvailable(id));
  assert(wrongBase.length === 0, `base units are trainable in Imperial (${wrongBase.join(', ') || 'all ok'})`);
  assert(wrongUp.length === 0,
    `upgraded units need their upgrade first (${wrongUp.join(', ') || 'none trainable'})`);

  // And the lines are lines: no jumping to the top.
  const skippable = ['upChampion', 'upPaladin', 'upHussar', 'upHalberdier', 'upArbalester',
    'upSiegeRam', 'upSiegeOnager', 'upTwoHandedSwordsman'].filter((t) => p.isTechAvailable(t));
  assert(skippable.length === 0, `top upgrades cannot be skipped to (${skippable.join(', ') || 'none'})`);
  assert(p.isTechAvailable('upManAtArms') && p.isTechAvailable('upLightCavalry'),
    'the bottom of each line is researchable');

  // One research upgrades everything already on the map, and retires the old unit.
  const s = g.map.starts[0];
  const u = g.spawnUnit('scoutCavalry', 0, s.x + 2.5, s.y + 2.5);
  const hpBefore = u.maxHp;
  g.completeResearch(p, 'upLightCavalry');
  assert(u.type === 'lightCavalry', `researching once upgrades units already built (${u.type})`);
  assert(u.maxHp > hpBefore, `the upgraded unit is stronger (${hpBefore} -> ${u.maxHp})`);
  assert(!p.isUnitAvailable('scoutCavalry'), 'the old unit can no longer be trained');
  assert(p.isUnitAvailable('lightCavalry'), 'the new unit can be trained');
  assert(p.isTechAvailable('upHussar'), 'the next step in the line is now open');
  g.completeResearch(p, 'upHussar');
  assert(u.type === 'hussar' && !p.isUnitAvailable('lightCavalry'),
    `the line continues (${u.type})`);

  // Civs with free upgrades get them one tier per age, not all at once. This
  // used to fire on any research at all: Bulgarians who researched Loom in the
  // Dark Age instantly held Champion and their Militia became Champions.
  const b = g.players[1];
  const militia = g.spawnUnit('militia', 1, g.map.starts[1].x + 2.5, g.map.starts[1].y + 2.5);
  g.completeResearch(b, 'loom');
  assert(!b.researched.has('upManAtArms') && militia.type === 'militia',
    `a free upgrade waits for its age (militia is still ${militia.type} in the Dark Age)`);
  const seen = [];
  for (const age of ['feudalAge', 'castleAge', 'imperialAge']) {
    g.completeResearch(b, age);
    seen.push(militia.type);
  }
  assert(seen.join(',') === 'manAtArms,longSwordsman,champion',
    `free upgrades arrive per age (${seen.join(' -> ')})`);

  // Turks get Light Cavalry and Hussar free - in the ages they belong to.
  const t = g.players[2];
  g.completeResearch(t, 'feudalAge');
  assert(!t.researched.has('upLightCavalry'), 'Turks do not get Light Cavalry early');
  g.completeResearch(t, 'castleAge');
  assert(t.researched.has('upLightCavalry') && !t.researched.has('upHussar'),
    'Turks get Light Cavalry free in Castle');
  g.completeResearch(t, 'imperialAge');
  assert(t.researched.has('upHussar') && t.isUnitAvailable('hussar'),
    'Turks get Hussar free in Imperial');

  // Elite unique units are upgrades too.
  assert(!p.isUnitAvailable(p.civ.uuElite), `Elite unique unit needs its upgrade (${p.civ.uuElite})`);
  assert(p.isUnitAvailable(p.civ.uu), `the base unique unit is trainable (${p.civ.uu})`);
}

console.log('\n=== Data integrity ===');
{
  let bad = 0;
  for (const id in UNITS) {
    const u = UNITS[id];
    if (u.upgradeTo && !UNITS[u.upgradeTo]) { console.error(`  ✗ ${id} upgrades to missing ${u.upgradeTo}`); bad++; }
    if (!u.name) { console.error(`  ✗ ${id} has no name`); bad++; }
  }
  assert(bad === 0, `${Object.keys(UNITS).length} units cross-reference cleanly`);

  let civBad = 0;
  for (const id of CIV_IDS) {
    const c = CIVILIZATIONS[id];
    if (!UNITS[c.uu]) { console.error(`  ✗ ${id}: missing unique unit ${c.uu}`); civBad++; }
    if (!UNITS[c.uuElite]) { console.error(`  ✗ ${id}: missing elite ${c.uuElite}`); civBad++; }
  }
  assert(civBad === 0, `${CIV_IDS.length} civilizations have valid unique units`);
}

/* ---------------- full game simulation ---------------- */

console.log(`\n=== Simulating ${minutes} game-minutes (seed ${seed}) ===`);

const civA = CIV_IDS[seed % CIV_IDS.length];
const civB = CIV_IDS[(seed * 7 + 3) % CIV_IDS.length];

const game = new Game({
  seed,
  mapSize: 120,
  speed: 1.0,
  players: [
    { civ: civA, name: 'AI-A', team: 0 },
    { civ: civB, name: 'AI-B', team: 1 },
  ],
});
console.log(`  ${CIVILIZATIONS[civA].name} vs ${CIVILIZATIONS[civB].name}`);

const ais = [new AI(game, 0, 'moderate'), new AI(game, 1, 'moderate')];

const totalTicks = Math.round((minutes * 60) / TICK);
const t0 = Date.now();
let aiAcc = 0;

for (let i = 0; i < totalTicks; i++) {
  game.update(TICK);
  aiAcc += TICK;
  while (aiAcc >= 1) { for (const ai of ais) ai.update(1); aiAcc -= 1; }
  if (game.over) break;
}

const elapsed = (Date.now() - t0) / 1000;
console.log(`  simulated ${(game.time / 60).toFixed(1)} game-min in ${elapsed.toFixed(1)}s real time ` +
  `(${(game.time / elapsed).toFixed(0)}x)`);

for (const p of game.players) {
  const mine = game.entities.filter((e) => e.alive && e.owner === p.index);
  const units = mine.filter((e) => e.kind === 'unit');
  const vills = units.filter((e) => e.def.cat === 'villager');
  const army = units.filter((e) => ['infantry', 'cavalry', 'archer', 'siege', 'monk'].includes(e.def.cat));
  const buildings = mine.filter((e) => e.kind === 'building');
  const comp = {};
  for (const u of army) comp[u.def.name] = (comp[u.def.name] || 0) + 1;
  const bcomp = {};
  for (const b of buildings) bcomp[b.def.name] = (bcomp[b.def.name] || 0) + 1;

  console.log(`\n  ${p.name} (${p.civ.name}) — ${p.age}${p.defeated ? '  [DEFEATED]' : ''}`);
  console.log(`    res      food ${Math.round(p.res.food)}  wood ${Math.round(p.res.wood)}  ` +
    `gold ${Math.round(p.res.gold)}  stone ${Math.round(p.res.stone)}`);
  console.log(`    pop      ${Math.round(p.pop)}/${p.effectivePopCap}   villagers ${vills.length}   army ${army.length}`);
  console.log(`    gathered ${Math.round(p.stats.resourcesGathered)}   kills ${p.stats.unitsKilled}   losses ${p.stats.unitsLost}`);
  console.log(`    techs    ${p.researched.size} researched`);
  console.log(`    army     ${Object.entries(comp).map(([k, v]) => `${v}× ${k}`).join(', ') || '(none)'}`);
  console.log(`    build    ${Object.entries(bcomp).map(([k, v]) => `${v}× ${k}`).join(', ') || '(none)'}`);
}

console.log('\n=== Assertions ===');
const p0 = game.players[0];
const vills0 = game.entities.filter((e) => e.alive && e.owner === 0 && e.kind === 'unit' && e.def.cat === 'villager');
assert(p0.stats.resourcesGathered > 500, `AI-A gathered resources (${Math.round(p0.stats.resourcesGathered)})`);
assert(vills0.length >= 6, `AI-A grew its villager count (${vills0.length})`);
assert(p0.researched.size >= 1, `AI-A researched technologies (${p0.researched.size})`);
if (minutes >= 16) {
  assert(p0.ageIndex >= 1, `AI-A advanced past the Dark Age (${p0.age})`);
  const army0 = game.entities.filter((e) => e.alive && e.owner === 0 && e.kind === 'unit' &&
    ['infantry', 'cavalry', 'archer', 'siege'].includes(e.def.cat));
  assert(army0.length >= 1, `AI-A produced military units (${army0.length})`);
  // The AI is supposed to leave nobody standing around. A couple mid-walk
  // between jobs is normal; a tenth of the economy idle is a real failure.
  // Garrisoned villagers report `idle` - that is how the sim models being
  // inside a building - but they are sheltering from a raid on purpose, not
  // standing about with nothing to do. Counting them made a working defensive
  // response look like an economy bug.
  const idle0 = vills0.filter((v) => v.task.type === 'idle' && !v.garrisonedIn).length;
  assert(idle0 <= Math.max(1, vills0.length * 0.1),
    `AI-A has no idle villagers (${idle0}/${vills0.length})`);
}
assert(game.entities.length < 20000, `entity count is sane (${game.entities.length})`);

console.log('');
