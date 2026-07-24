// Headless simulation harness. Runs full AI-vs-AI games with no renderer so the
// economy, combat and tech systems can be verified from the command line.
//
//   node scripts/headless-test.mjs [minutes] [seed]

import { Game, TICK } from '../public/src/sim/game.js';
import { AI } from '../public/src/sim/ai.js';
import { CIV_IDS, CIVILIZATIONS } from '../public/src/data/civs.js';
import { UNITS } from '../public/src/data/units.js';
import { computeDamage } from '../public/src/data/armor.js';

const minutes = parseFloat(process.argv[2] || '10');
const seed = parseInt(process.argv[3] || '12345', 10);

/* ---------------- counter-system unit tests ---------------- */

function assert(cond, msg) {
  if (!cond) { console.error('  ✗ ' + msg); process.exitCode = 1; return false; }
  console.log('  ✓ ' + msg);
  return true;
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

  const halbVsCata = computeDamage(halb.atk, cata.armor);
  assert(halbVsCata < halbVsKnight,
    `Cataphract's infantry armour blunts Halberdier bonus (${halbVsCata} vs ${halbVsKnight} on a Knight)`);

  const ramVsHouse = computeDamage(UNITS.siegeRam.atk, { melee: 0, pierce: 7, building: 0 });
  assert(ramVsHouse > 190, `Siege Ram devastates buildings (${ramVsHouse})`);

  const knightVsHalb = computeDamage(knight.atk, halb.armor);
  assert(knightVsHalb === 10, `Knight has no bonus vs Halberdier (${knightVsHalb})`);
}

/* ---------------- data integrity ---------------- */

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
if (minutes >= 8) {
  assert(p0.ageIndex >= 1, `AI-A advanced past the Dark Age (${p0.age})`);
  const army0 = game.entities.filter((e) => e.alive && e.owner === 0 && e.kind === 'unit' &&
    ['infantry', 'cavalry', 'archer', 'siege'].includes(e.def.cat));
  assert(army0.length >= 1, `AI-A produced military units (${army0.length})`);
}
assert(game.entities.length < 20000, `entity count is sane (${game.entities.length})`);

console.log('');
