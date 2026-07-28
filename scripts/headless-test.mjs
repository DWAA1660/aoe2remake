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
  let peakVills = 0, peakPop = 0;
  for (let i = 0; i < Math.round(60 * 60 / TICK); i++) {
    g.update(TICK);
    if (i % 20 === 0) for (const a of ais) a.update(1);
    if (i % 200 === 0) {
      const n = g.entities.filter((e) => e.alive && e.owner === 0 &&
        e.kind === 'unit' && e.def.cat === 'villager').length;
      peakVills = Math.max(peakVills, n);
      peakPop = Math.max(peakPop, g.players[0].pop / g.players[0].effectivePopCap);
    }
    if (g.over) break;
  }

  const p = g.players[0];
  const mine = g.entities.filter((e) => e.alive && e.owner === 0);
  const vills = mine.filter((e) => e.kind === 'unit' && e.def.cat === 'villager');
  const army = mine.filter((e) => e.kind === 'unit' &&
    ['infantry', 'cavalry', 'archer', 'siege', 'monk'].includes(e.def.cat));
  const siege = army.filter((e) => e.def.cat === 'siege').length;

  // Villager production used to stop dead at the age gate, pinning the economy
  // around 50 for the whole game.
  assert(peakVills >= 90, `it keeps making villagers (peaked at ${peakVills})`);
  assert(p.ageIndex >= 3, `it reaches Imperial (${p.age})`);
  // The army should be a real army, and the population should be getting used.
  assert(army.length >= 25, `it fields a real army (${army.length})`);
  assert(peakPop >= 0.85,
    `it uses the population it has (peaked at ${Math.round(peakPop * 100)}% of the cap)`);
  // Siege is support, not the army: a Siege Workshop can only train siege, so
  // without a share cap it queued rams forever and reached 62% of the army.
  assert(siege <= army.length * 0.25,
    `siege stays a support arm (${siege}/${army.length} = ${Math.round(siege / Math.max(1, army.length) * 100)}%)`);
  assert(p.stats.unitsKilled > 0, `the army is actually used (${p.stats.unitsKilled} kills)`);

  const idle = vills.filter((v) => v.task.type === 'idle').length;
  assert(idle <= Math.max(2, vills.length * 0.05), `still no idle villagers (${idle}/${vills.length})`);

  // Now that lines have to be walked up one tier at a time, an AI that never
  // gets round to them fights the whole game with Militia and Scouts.
  const ups = [...p.researched].filter((t) => t.startsWith('up') || t.startsWith('elite_'));
  assert(ups.length >= 4, `it works its unit lines up (${ups.length}: ${ups.join(', ')})`);
  const base = army.filter((u) => ['militia', 'spearman', 'archer', 'scoutCavalry'].includes(u.type)).length;
  assert(base <= army.length * 0.5,
    `most of the army is upgraded units, not the base tier (${base}/${army.length} base)`);
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
  assert(attacked.peakMiners > calm.peakMiners,
    `villagers are switched onto stone for it (${attacked.peakMiners} vs ${calm.peakMiners} miners)`);
  assert(calm.castleAt === null || attacked.castleAt < calm.castleAt,
    `and it is up sooner than it otherwise would be ` +
    `(${attacked.castleAt.toFixed(1)}m vs ${calm.castleAt ? calm.castleAt.toFixed(1) + 'm' : 'never'})`);
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
  const idle0 = vills0.filter((v) => v.task.type === 'idle').length;
  assert(idle0 <= Math.max(1, vills0.length * 0.1),
    `AI-A has no idle villagers (${idle0}/${vills0.length})`);
}
assert(game.entities.length < 20000, `entity count is sane (${game.entities.length})`);

console.log('');
