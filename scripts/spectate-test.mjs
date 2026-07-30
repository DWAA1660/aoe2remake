// Headless check of Spectate mode: boots the real page, sets up a four-way 2v2
// on a land-only map, and verifies the viewer is a spectator - every side is
// played by an AI, nothing the viewer does can issue an order, and the observer
// controls (switch side, pause, fast-forward) actually do what they say.
//
//   node scripts/spectate-test.mjs

import puppeteer from 'puppeteer';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 8124;

const problems = [];
const check = (ok, label, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail !== undefined ? '   ' + detail : ''}`);
  if (!ok) problems.push(label);
};

function startServer() {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    p.stdout.on('data', (d) => { if (String(d).includes('http://')) resolve(p); });
    p.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
    setTimeout(() => resolve(p), 2500);
    p.on('error', reject);
  });
}

async function main() {
  const server = await startServer();
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader', '--enable-webgl', '--window-size=1400,900'],
  });
  const errors = [];

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`);
    });
    page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));

    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle2', timeout: 60000 });

    console.log('\n== menu ==');
    await page.waitForSelector('#mModeWatch', { timeout: 20000 });
    await page.click('#mModeWatch');
    const menu = await page.evaluate(() => ({
      civPickersShown: !document.querySelector('.watchonly').classList.contains('hidden'),
      yourCivHidden: document.querySelector('.playonly').classList.contains('hidden'),
      startLabel: document.querySelector('#mStart').textContent,
      pairPanels: document.querySelectorAll('.civpair > div').length,
    }));
    check(menu.civPickersShown, 'civ pickers appear', '');
    check(menu.yourCivHidden, '"your civilization" hidden', '');
    check(menu.startLabel === 'Watch Match', 'start button relabelled', menu.startLabel);
    check(menu.pairPanels === 2, 'both civs described', menu.pairPanels + ' panels');

    console.log('\n== four AIs on teams ==');
    await page.select('#mAiCount', '4');
    const four = await page.evaluate(() => ({
      slots: [...document.querySelectorAll('.ai-slot')].filter((n) => !n.classList.contains('hidden')).length,
      panels: document.querySelectorAll('.civpair > div').length,
      teamOpts: [...document.querySelector('#mTeams').options]
        .filter((o) => !o.disabled).map((o) => o.value),
    }));
    check(four.slots === 4, 'four civ pickers appear', four.slots);
    check(four.panels === 4, 'four civs described', four.panels + ' panels');
    check(four.teamOpts.includes('2v2'), '2v2 becomes selectable', four.teamOpts.join('/'));

    await page.select('#mTeams', '2v2');
    const allied = await page.evaluate(() =>
      document.querySelector('#civInfo').textContent.includes('with'));
    check(allied, 'the panel says who is allied with whom');

    // A layout that cannot fit the player count must not be selectable.
    await page.select('#mAiCount', '3');
    const three = await page.evaluate(() => ({
      teamValue: document.querySelector('#mTeams').value,
      twoVtwoDisabled: [...document.querySelector('#mTeams').options]
        .find((o) => o.value === '2v2').disabled,
      slots: [...document.querySelectorAll('.ai-slot')].filter((n) => !n.classList.contains('hidden')).length,
    }));
    check(three.twoVtwoDisabled, '2v2 is disabled at three players');
    check(three.teamValue !== '2v2', 'and the selection falls back', three.teamValue);
    check(three.slots === 3, 'three civ pickers', three.slots);

    // Back to a 4-way, 2v2, on a land-only map with four named civs.
    await page.select('#mAiCount', '4');
    await page.select('#mTeams', '2v2');
    await page.select('#mMapType', 'land');
    await page.select('#mCivA', 'britons');
    await page.select('#mCivB', 'mongols');
    await page.select('#mCivC', 'teutons');
    await page.select('#mCivD', 'aztecs');
    await page.select('#mSize', '120');
    await page.click('#mStart');

    await page.waitForFunction('window.__game && window.__ctx', { timeout: 60000 });
    await page.mouse.move(700, 450);
    console.log('\n== match start ==');

    const boot = await page.evaluate(() => {
      const g = window.__game, c = window.__ctx;
      let water = 0;
      for (let i = 0; i < g.grid.water.length; i++) if (g.grid.water[i]) water++;
      return {
        spectator: !!c.spectator,
        players: g.players.map((p) => `${p.name}:${p.civId}`),
        teams: g.players.map((p) => p.team),
        humans: g.players.filter((p) => p.isHuman).length,
        revealAll: !!g.revealAll,
        cards: document.querySelectorAll('.speccard').length,
        water,
        starts: g.map.starts.length,
        allied01: g.isAlly(0, 1),
        enemy02: g.isEnemy(0, 2),
        allied23: g.isAlly(2, 3),
      };
    });
    check(boot.spectator, 'ctx is in spectator mode');
    check(boot.players.length === 4, 'four players', boot.players.join(', '));
    check(boot.players[0].endsWith('britons') && boot.players[3].endsWith('aztecs'),
      'chosen civs were used', boot.players.join(', '));
    check(boot.humans === 0, 'nobody is human', boot.humans + ' human players');
    check(boot.revealAll, 'whole map revealed');
    check(boot.cards === 4, 'a score card per player', boot.cards);
    check(boot.starts === 4, 'four starting positions', boot.starts);
    check(boot.allied01 && boot.allied23 && boot.enemy02,
      '2v2 teams are wired up', JSON.stringify(boot.teams));
    check(boot.water === 0, 'land-only map has no water at all', boot.water + ' water tiles');

    // Let both AIs actually play for a while at speed. SwiftShader renders at a
    // handful of frames per second, and the loop caps each frame's real delta at
    // 0.1s, so fast-forward buys much less here than on a real GPU - hence the
    // long wall-clock wait for a few game-minutes.
    await page.evaluate(() => { window.__ctx.timeScale = 8; });
    await new Promise((r) => setTimeout(r, 50000));

    console.log('\n== all four AIs are playing ==');
    const play = await page.evaluate(() => {
      const g = window.__game;
      const per = g.players.map((p, i) => {
        let vill = 0, bld = 0, idle = 0;
        for (const e of g.entities) {
          if (!e.alive || e.owner !== i) continue;
          if (e.kind === 'building') { bld++; continue; }
          if (e.kind === 'unit' && e.def.cat === 'villager') {
            vill++;
            if (e.task.type === 'idle') idle++;
          }
        }
        return { vill, bld, idle, gathered: Math.round(p.stats.resourcesGathered) };
      });
      return { time: g.time, per };
    });
    console.log('  game clock', play.time.toFixed(0) + 's');
    for (let i = 0; i < play.per.length; i++) {
      const s = play.per[i];
      console.log(`  player ${i}: ${s.vill} villagers, ${s.bld} buildings, ` +
        `${s.gathered} gathered, ${s.idle} idle`);
    }
    check(play.per.every((s) => s.gathered > 200), 'all four are gathering');
    check(play.per.every((s) => s.vill > 3), 'all four are growing');
    check(play.per.every((s) => s.bld > 1), 'all four are building');

    console.log('\n== spectator controls ==');
    // pause
    await page.evaluate(() => { window.__ctx.timeScale = 0; });
    await new Promise((r) => setTimeout(r, 700));
    const t0 = await page.evaluate(() => window.__game.time);
    await new Promise((r) => setTimeout(r, 900));
    const t1 = await page.evaluate(() => window.__game.time);
    check(t1 === t0, 'pause actually stops the clock', `${t0.toFixed(1)} -> ${t1.toFixed(1)}`);

    // resume via the on-screen button, then fast-forward
    await page.click('.specctl .topbtn');
    await new Promise((r) => setTimeout(r, 800));
    const t2 = await page.evaluate(() => window.__game.time);
    check(t2 > t1, 'resume button restarts the clock', `${t1.toFixed(1)} -> ${t2.toFixed(1)}`);

    const rate = await page.evaluate(async () => {
      const g = window.__game, c = window.__ctx;
      const measure = (scale) => new Promise((res) => {
        c.timeScale = scale;
        const a = g.time;
        setTimeout(() => res(g.time - a), 1500);
      });
      const slow = await measure(1);
      const fast = await measure(8);
      return { slow, fast };
    });
    check(rate.fast > rate.slow * 2, 'fast-forward really is faster',
      `1x advanced ${rate.slow.toFixed(1)}s, 8x advanced ${rate.fast.toFixed(1)}s`);

    // switching sides
    const swap = await page.evaluate(() => {
      const c = window.__ctx;
      const before = c.playerIndex;
      c.setViewPlayer((before + 1) % c.game.players.length);
      return {
        before,
        after: c.playerIndex,
        hud: c.hud.playerIndex,
        input: c.input.playerIndex,
        hudPlayer: c.hud.player.name,
      };
    });
    check(swap.after !== swap.before, 'Tab switches the observed player',
      `${swap.before} -> ${swap.after}`);
    check(swap.hud === swap.after && swap.input === swap.after,
      'HUD and input follow the switch', `hud=${swap.hud} input=${swap.input} (${swap.hudPlayer})`);

    console.log('\n== the viewer cannot play ==');
    const cmd = await page.evaluate(() => {
      const g = window.__game, c = window.__ctx;
      const i = c.playerIndex;
      const vills = g.entities.filter((e) => e.alive && e.owner === i &&
        e.kind === 'unit' && e.def.cat === 'villager');
      c.input.setSelection(vills.slice(0, 4));
      const selected = c.input.selection.length;
      const before = c.input.selection.map((u) => JSON.stringify(u.task));

      // every route a player would use to give an order
      c.input._rightClick({ x: 700, y: 450 }, false);
      c.input._tryMassFarm({ x: 700, y: 450 });
      c.input.setCursorMode?.('attackMove');
      c.input._applyCursorMode({ x: 700, y: 450 }, false);
      c.input.startPlacement('house');
      const placementOpened = !!c.input.placement;
      c.input._placeBuilding(false);

      const after = c.input.selection.map((u) => JSON.stringify(u.task));
      return {
        selected,
        placementOpened,
        ordersIssued: c.input.selection.filter((u) => u.orders && u.orders.length).length,
        tasksChanged: before.filter((t, k) => t !== after[k]).length,
        cardButtons: document.querySelectorAll('.card button').length,
      };
    });
    check(cmd.selected > 0, 'a spectator can still select and inspect units', cmd.selected + ' selected');
    check(!cmd.placementOpened, 'build placement refuses to open');
    check(cmd.ordersIssued === 0, 'no orders were queued', cmd.ordersIssued);
    check(cmd.tasksChanged === 0, 'no villager was pulled off its job', cmd.tasksChanged + ' changed');
    check(cmd.cardButtons === 0, 'the command card is empty', cmd.cardButtons + ' buttons');

    console.log('\n== console errors ==');
    const real = errors.filter((e) => !/favicon|Download the React/i.test(e));
    console.log(real.length ? real.slice(0, 8).map((e) => '  ' + e).join('\n') : '  none');
    check(real.length === 0, 'no console errors');
  } finally {
    await browser.close();
    server.kill();
  }

  console.log('');
  if (problems.length) {
    console.log('PROBLEMS:');
    for (const p of problems) console.log('  x ' + p);
    process.exitCode = 1;
  } else {
    console.log('OK: spectate mode works end to end.');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
