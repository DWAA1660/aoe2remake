// AI economy benchmark.
//
// A single seeded 10-minute game says almost nothing about whether the AI
// booms: any change to the AI shifts how much RNG it consumes, so two runs of
// the same seed diverge completely and every comparison looks like noise. This
// runs several seeds for a long enough game to see the boom, and prints the
// medians - which is the only signal worth tuning against.
//
// `--solo` runs one AI alone on the map. Two AIs on one map is the right test
// of the whole player, but it is a terrible instrument for tuning the economy:
// whichever side happens to win annihilates the other, so a one-line change to
// a gather weight swings the reported villager count from 130 to 3 and every
// measurement looks like a catastrophe or a triumph. Solo removes the opponent
// and measures only what the boom is capable of.
//
// `--pop=N` sets the population limit, which the AI's economy is written as
// proportions of - so this is the switch for checking that a 1000-pop game
// actually fills its limit rather than stopping at a 200-pop economy.
//
//   node scripts/ai-bench.mjs [minutes] [games] [--solo] [--pop=N]

import { Game, TICK } from '../public/src/sim/game.js';
import { AI } from '../public/src/sim/ai.js';
import { CIVILIZATIONS } from '../public/src/data/civs.js';

const minutes = parseFloat(process.argv[2] || '30');
const games = parseInt(process.argv[3] || '5', 10);
const solo = process.argv.includes('--solo');
const popArg = process.argv.find((a) => a.startsWith('--pop='));
const popMax = popArg ? parseInt(popArg.slice(6), 10) : 200;
const CIV_IDS = Object.keys(CIVILIZATIONS);

const AGES = ['dark', 'feudal', 'castle', 'imperial'];

function runGame(seed) {
  const game = new Game({
    seed,
    mapSize: 120,
    speed: 1.0,
    players: solo
      ? [{ civ: CIV_IDS[seed % CIV_IDS.length], name: 'AI-A', team: 0, popMax }]
      : [
        { civ: CIV_IDS[seed % CIV_IDS.length], name: 'AI-A', team: 0, popMax },
        { civ: CIV_IDS[(seed * 7 + 3) % CIV_IDS.length], name: 'AI-B', team: 1, popMax },
      ],
  });
  const ais = game.players.map((_, i) => new AI(game, i, 'moderate'));
  const ticks = Math.round((minutes * 60) / TICK);

  // Idle time is sampled rather than measured at the end: a snapshot of the
  // final tick can catch a lull and report zero while the AI actually left
  // villagers standing around for minutes.
  let villTotal = 0;
  const time = { idle: 0, working: 0, walking: 0, hauling: 0, building: 0, other: 0 };
  const ageAt = [];

  for (let i = 0; i < ticks; i++) {
    game.update(TICK);
    while (ageAt.length <= game.players[0].ageIndex) ageAt.push(game.time / 60);
    if (i % 20 === 0) { for (const ai of ais) ai.update(1); }
    if (i % 40 === 0 && game.time > 120) {
      for (const e of game.entities) {
        if (!e.alive || e.owner !== 0 || e.kind !== 'unit') continue;
        if (e.def.cat !== 'villager') continue;
        villTotal++;
        const t = e.task.type;
        // `moving` separates "standing on the node actually gathering" from
        // "still walking to it" - both report task 'gather', and conflating
        // them hides the entire cost of a badly placed drop-off.
        if (t === 'idle') time.idle++;
        else if (t === 'gather') { if (e.moving) time.walking++; else time.working++; }
        else if (t === 'deliver') time.hauling++;
        else if (t === 'build') time.building++;
        else time.other++;
      }
    }
    if (game.over) break;
  }

  const p = game.players[0];
  const mine = game.entities.filter((e) => e.alive && e.owner === 0);
  const vills = mine.filter((e) => e.kind === 'unit' && e.def.cat === 'villager').length;
  const carts = mine.filter((e) => e.kind === 'unit' && e.def.cat === 'trade').length;
  const bld = (t) => mine.filter((e) => e.kind === 'building' && e.type === t).length;
  const armyUnits = mine.filter((e) => e.kind === 'unit' &&
    ['infantry', 'cavalry', 'archer', 'siege', 'monk'].includes(e.def.cat));
  const army = armyUnits.length;
  const siege = armyUnits.filter((e) => e.def.cat === 'siege').length;
  return {
    seed,
    age: p.ageIndex,
    vills,
    carts,
    markets: bld('market'),
    tcs: bld('townCenter'),
    castles: bld('castle'),
    towers: bld('watchTower') + bld('guardTower') + bld('keep'),
    army,
    buildings: mine.filter((e) => e.kind === 'building').length,
    siegePct: army ? (siege / army) * 100 : 0,
    pop: Math.round(p.pop),
    popCap: p.effectivePopCap,
    gathered: Math.round(p.stats.resourcesGathered),
    techs: p.researched.size,
    float: Math.round(p.res.food + p.res.wood + p.res.gold + p.res.stone),
    idlePct: (time.idle / Math.max(1, villTotal)) * 100,
    workPct: (time.working / Math.max(1, villTotal)) * 100,
    walkPct: (time.walking / Math.max(1, villTotal)) * 100,
    haulPct: (time.hauling / Math.max(1, villTotal)) * 100,
    buildPct: (time.building / Math.max(1, villTotal)) * 100,
    otherPct: (time.other / Math.max(1, villTotal)) * 100,
    ageAt: ageAt.slice(1).map((m) => m.toFixed(0)).join('/') || '-',
  };
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

console.log(`AI bench: ${games} games x ${minutes} min\n`);
const head = 'seed    age        vill  army sge%   pop  bldg  gathered  techs  float | tc mkt crt cst twr | idle  work  walk  haul  bld   oth  ageAt';
console.log(head);
console.log('-'.repeat(head.length));

const line = (label, r) =>
  `${label.padEnd(7)} ${AGES[r.age].padEnd(10)} ` +
  `${String(r.vills).padStart(4)}  ${String(r.army).padStart(4)} ${r.siegePct.toFixed(0).padStart(3)}%  ` +
  `${String(r.pop).padStart(3)}/${String(r.popCap).padEnd(3)} ${String(r.buildings).padStart(4)}  ${String(r.gathered).padStart(8)}  ` +
  `${String(r.techs).padStart(5)}  ${String(r.float).padStart(5)} | ` +
  `${String(r.tcs).padStart(2)} ${String(r.markets).padStart(3)} ${String(r.carts).padStart(3)} ` +
  `${String(r.castles).padStart(3)} ${String(r.towers).padStart(3)} | ` +
  [r.idlePct, r.workPct, r.walkPct, r.haulPct, r.buildPct, r.otherPct]
    .map((v) => v.toFixed(0).padStart(4)).join('  ') + '  ' + (r.ageAt ?? '');

const rows = [];
const t0 = Date.now();
for (let i = 0; i < games; i++) {
  const r = runGame(1000 + i * 777);
  rows.push(r);
  console.log(line(String(r.seed), r));
}
console.log('-'.repeat(head.length));
const med = (k) => median(rows.map((r) => r[k]));
console.log(line('median', {
  age: med('age'), vills: med('vills'), army: med('army'), buildings: med('buildings'),
  gathered: med('gathered'), techs: med('techs'), float: med('float'),
  siegePct: med('siegePct'), pop: med('pop'), popCap: med('popCap'),
  carts: med('carts'), markets: med('markets'), tcs: med('tcs'),
  castles: med('castles'), towers: med('towers'),
  idlePct: med('idlePct'), workPct: med('workPct'), walkPct: med('walkPct'),
  haulPct: med('haulPct'), buildPct: med('buildPct'), otherPct: med('otherPct'),
}));
console.log(`\n${((Date.now() - t0) / 1000).toFixed(1)}s real time`);
