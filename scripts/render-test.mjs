// Headless render test. Boots the real page in Chrome (SwiftShader WebGL),
// starts a game, then reports console/WebGL errors, samples the framebuffer and
// writes screenshots so the rendering can actually be verified.
//
//   node scripts/render-test.mjs [outDir]

import puppeteer from 'puppeteer';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT = process.argv[2] || path.join(ROOT, 'shots');
const PORT = 8123;

fs.mkdirSync(OUT, { recursive: true });

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

const log = [];
const problemsExtra = [];
const errors = [];

async function main() {
  const server = await startServer();
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--window-size=1400,900',
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });

    page.on('console', (m) => {
      const t = m.type();
      const txt = m.text();
      log.push(`[${t}] ${txt}`);
      if (t === 'error' || t === 'warning') errors.push(`[${t}] ${txt}`);
    });
    page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
    page.on('requestfailed', (r) => errors.push('[requestfailed] ' + r.url()));

    console.log('\n== loading page ==');
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle2', timeout: 60000 });

    // report WebGL capability up front
    const glInfo = await page.evaluate(() => {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      if (!gl) return { ok: false };
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        ok: true,
        version: gl.getParameter(gl.VERSION),
        renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'n/a',
      };
    });
    console.log('  WebGL:', glInfo.ok ? `${glInfo.version} / ${glInfo.renderer}` : 'UNAVAILABLE');
    if (!glInfo.ok) throw new Error('WebGL unavailable in this browser');

    console.log('== starting game ==');
    await page.waitForSelector('#mStart', { timeout: 20000 });
    // medium map, dark age, so the fog state is meaningful
    await page.select('#mSize', '120');
    await page.click('#mStart');

    await page.waitForFunction('window.__game && window.__ctx', { timeout: 60000 });
    console.log('  game booted');

    // Park the cursor in the middle of the viewport. Puppeteer leaves it at
    // (0,0), which sits inside the edge-scroll margin and pans the camera off
    // the map for the whole test.
    await page.mouse.move(700, 450);

    // Send the scout on a loop away from the town and back. Without this
    // nothing ever leaves the Town Center's line of sight, so no tile can
    // transition visible -> explored and the shroud state is never exercised.
    await page.evaluate(() => {
      const g = window.__game;
      const s = g.map.starts[0];
      const scout = g.entities.find((e) => e.alive && e.owner === 0 &&
        e.kind === 'unit' && e.def.cat === 'cavalry');
      if (scout) {
        g.commandMove([scout], Math.min(g.size - 4, s.x + 26), s.y, false);
        g.issueCommands([scout], () => ({ type: 'move', x: s.x, y: s.y }), true);
      }
    });
    await new Promise((r) => setTimeout(r, 14000));
    await page.evaluate(() => {
      const c = window.__ctx;
      c.renderer.centerOn(c.game.map.starts[0].x, c.game.map.starts[0].y);
    });
    await new Promise((r) => setTimeout(r, 600));

    /* ---------------- framebuffer analysis ---------------- */
    const stats = await page.evaluate(() => {
      const ctx = window.__ctx;
      const r = ctx.renderer;
      // force a render so the drawing buffer is populated right now
      r.render(ctx.game.players[0], ctx.input.selection);
      const gl = r.renderer.getContext();
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);

      let rSum = 0, gSum = 0, bSum = 0, n = 0;
      let greenish = 0, bluish = 0, dark = 0, bright = 0;
      const hist = new Map();
      // sample a grid of pixels, skipping the HUD bands
      for (let y = Math.floor(h * 0.25); y < Math.floor(h * 0.82); y += 3) {
        for (let x = 0; x < w; x += 3) {
          const i = (y * w + x) * 4;
          const R = px[i], G = px[i + 1], B = px[i + 2];
          rSum += R; gSum += G; bSum += B; n++;
          const lum = (R * 0.299 + G * 0.587 + B * 0.114);
          if (lum < 26) dark++;
          if (lum > 90) bright++;
          if (G > R + 8 && G > B + 8) greenish++;
          if (B > R + 10 && B > G + 6) bluish++;
          const key = `${R >> 4},${G >> 4},${B >> 4}`;
          hist.set(key, (hist.get(key) || 0) + 1);
        }
      }
      const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
        .map(([k, v]) => {
          const [rr, gg, bb] = k.split(',').map(Number);
          return { rgb: [rr * 16, gg * 16, bb * 16], pct: +(100 * v / n).toFixed(1) };
        });

      // named entity counts, to confirm the sim is populated
      const g = ctx.game;
      let units = 0, buildings = 0, resources = 0;
      for (const e of g.entities) {
        if (!e.alive) continue;
        if (e.kind === 'unit') units++;
        else if (e.kind === 'building') buildings++;
        else if (e.kind === 'resource') resources++;
      }

      // instanced pool occupancy - proves meshes are actually being submitted
      const pools = [];
      for (const [k, p] of r._pools) if (p.mesh.count > 0) pools.push(`${k}=${p.mesh.count}`);

      // fog texture state
      const fd = r.fogData;
      let vis = 0, expl = 0, unex = 0;
      for (let i = 0; i < fd.length; i++) {
        if (fd[i] > 200) vis++; else if (fd[i] > 40) expl++; else unex++;
      }

      return {
        avg: [Math.round(rSum / n), Math.round(gSum / n), Math.round(bSum / n)],
        greenPct: +(100 * greenish / n).toFixed(1),
        bluePct: +(100 * bluish / n).toFixed(1),
        darkPct: +(100 * dark / n).toFixed(1),
        brightPct: +(100 * bright / n).toFixed(1),
        top,
        units, buildings, resources,
        pools: pools.slice(0, 14),
        terrainVisible: r.terrain ? r.terrain.visible : null,
        fogTiles: { visible: vis, explored: expl, unexplored: unex },
      };
    });

    console.log('\n== framebuffer ==');
    console.log('  average RGB      ', stats.avg.join(', '));
    console.log('  greenish px      ', stats.greenPct + '%');
    console.log('  bluish px        ', stats.bluePct + '%');
    console.log('  very dark px     ', stats.darkPct + '%');
    console.log('  bright px        ', stats.brightPct + '%');
    console.log('  dominant colours ', stats.top.map((t) => `rgb(${t.rgb.join(',')}) ${t.pct}%`).join('  '));
    console.log('\n== scene ==');
    console.log('  entities         ', `${stats.units} units, ${stats.buildings} buildings, ${stats.resources} resources`);
    console.log('  instanced pools  ', stats.pools.join(' ') || '(NONE - nothing drawn!)');
    console.log('  fog tiles        ', `visible ${stats.fogTiles.visible}, explored ${stats.fogTiles.explored}, unexplored ${stats.fogTiles.unexplored}`);

    await page.screenshot({ path: path.join(OUT, '01-fogged.png') });

    /* ---- measure how distinguishable the three fog states actually are ---- */
    const fogBands = await page.evaluate(() => {
      const c = window.__ctx;
      const r = c.renderer, g = c.game, pl = g.players[0];
      r.render(pl, c.input.selection);
      const gl = r.renderer.getContext();
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);

      const acc = { 2: [0, 0], 1: [0, 0], 0: [0, 0] };  // state -> [lumSum, count]
      for (let sy = Math.floor(h * 0.3); sy < Math.floor(h * 0.78); sy += 4) {
        for (let sx = 0; sx < w; sx += 4) {
          // readPixels is bottom-up; convert to top-down CSS pixels
          const cssX = sx / (w / window.innerWidth);
          const cssY = (h - sy) / (h / window.innerHeight);
          const world = r.screenToWorld(cssX, cssY);
          if (!world) continue;
          const tx = world.x | 0, ty = world.y | 0;
          if (tx < 0 || ty < 0 || tx >= g.size || ty >= g.size) continue;
          const state = pl.fog[ty * g.size + tx];
          const i = (sy * w + sx) * 4;
          const lum = px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;
          acc[state][0] += lum;
          acc[state][1]++;
        }
      }
      const mean = (s) => (acc[s][1] ? +(acc[s][0] / acc[s][1]).toFixed(1) : null);
      const vis = mean(2), expl = mean(1), unex = mean(0);
      const vals = [vis, expl, unex].filter((v) => v !== null);
      return {
        visible: vis, explored: expl, unexplored: unex,
        counts: { visible: acc[2][1], explored: acc[1][1], unexplored: acc[0][1] },
        spread: vals.length > 1 ? +(Math.max(...vals) - Math.min(...vals)).toFixed(1) : 0,
      };
    });

    console.log('\n== fog of war (mean on-screen brightness per state) ==');
    console.log(`  visible    ${fogBands.visible}   (${fogBands.counts.visible} samples)`);
    console.log(`  explored   ${fogBands.explored}   (${fogBands.counts.explored} samples)`);
    console.log(`  unexplored ${fogBands.unexplored}   (${fogBands.counts.unexplored} samples)`);
    console.log(`  spread     ${fogBands.spread}  ${fogBands.spread >= 25 ? '(clearly distinct)' : '(TOO SIMILAR)'}`);

    // reveal the map to compare fogged vs unfogged rendering
    await page.evaluate(() => { window.__game.revealAll = true; });
    await new Promise((r) => setTimeout(r, 1200));
    await page.screenshot({ path: path.join(OUT, '02-revealed.png') });

    const revealed = await page.evaluate(() => {
      const ctx = window.__ctx;
      const r = ctx.renderer;
      r.render(ctx.game.players[0], ctx.input.selection);
      const gl = r.renderer.getContext();
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let rS = 0, gS = 0, bS = 0, n = 0, green = 0;
      for (let y = Math.floor(h * 0.25); y < Math.floor(h * 0.82); y += 3) {
        for (let x = 0; x < w; x += 3) {
          const i = (y * w + x) * 4;
          rS += px[i]; gS += px[i + 1]; bS += px[i + 2]; n++;
          if (px[i + 1] > px[i] + 8 && px[i + 1] > px[i + 2] + 8) green++;
        }
      }
      return { avg: [Math.round(rS / n), Math.round(gS / n), Math.round(bS / n)], greenPct: +(100 * green / n).toFixed(1) };
    });
    console.log('\n== with map revealed ==');
    console.log('  average RGB      ', revealed.avg.join(', '));
    console.log('  greenish px      ', revealed.greenPct + '%');

    /* ---- gathering behaviour, working poses and tree felling ---- */
    const gather = await page.evaluate(async () => {
      const c = window.__ctx, g = window.__game;
      const vills = g.entities.filter((e) => e.alive && e.owner === 0 &&
        e.kind === 'unit' && e.def.cat === 'villager');
      const tree = g.entities.find((e) => e.alive && e.kind === 'resource' && e.type === 'tree');
      const berry = g.entities.find((e) => e.alive && e.kind === 'resource' && e.type === 'berries');
      if (!tree || !berry || vills.length < 2) return { error: 'missing test subjects' };

      const treeBefore = tree.amount, berryBefore = berry.amount;
      g.commandGather([vills[0]], tree, false);
      g.commandGather([vills[1]], berry, false);
      // leave just enough wood that the tree is felled while we watch
      tree.amount = 3;
      const treeId = tree.id;

      // poll until the tree is exhausted, then catch it mid-topple
      let felled = false, tiltSeen = 0, waited = 0;
      while (waited < 30000) {
        await new Promise((r) => setTimeout(r, 250));
        waited += 250;
        if (!tree.alive) {
          felled = true;
          const fx = g.effects.find((e) => e.type === 'treeFall');
          if (fx) tiltSeen = fx.t;
          break;
        }
      }
      // hold a moment so the fall is visibly in progress for the screenshot
      await new Promise((r) => setTimeout(r, 350));
      const liveFall = g.effects.find((e) => e.type === 'treeFall');

      const meshes = await import('/src/render/meshes.js');
      const poses = {};
      for (const v of g.entities) {
        if (!v.alive || v.owner !== 0 || v.kind !== 'unit' || v.def.cat !== 'villager') continue;
        const k = meshes.unitMeshKeyFor(v);
        poses[k] = (poses[k] || 0) + 1;
      }
      // confirm the toppling tree is actually submitted as geometry
      c.renderer.render(g.players[0], c.input.selection);
      const treePool = c.renderer._pools.get('res:tree') || c.renderer._pools.get('res:treeDry');
      return {
        treeBefore, felled, treeId, tiltSeen: +tiltSeen.toFixed(2),
        fallStillAnimating: !!liveFall,
        fallProgress: liveFall ? +(liveFall.t).toFixed(2) : null,
        treePoolDrawn: treePool ? treePool.mesh.count : 0,
        berryBefore, berryNow: berry.amount,
        gathered: Math.round(g.players[0].stats.resourcesGathered),
        wood: Math.round(g.players[0].res.wood),
        poses,
        poolKeys: [...c.renderer._pools.keys()].filter((k) => k.startsWith('unit:villager')),
      };
    });

    console.log('\n== gathering ==');
    if (gather.error) {
      console.log('  ' + gather.error);
    } else {
      console.log(`  berries        ${gather.berryBefore} -> ${gather.berryNow.toFixed(1)} (depleting live)`);
      console.log(`  resources in   ${gather.gathered} gathered, wood stock ${gather.wood}`);
      console.log(`  tree felled    ${gather.felled}`);
      console.log(`  fall animating ${gather.fallStillAnimating} (t=${gather.fallProgress})`);
      console.log(`  tree instances drawn ${gather.treePoolDrawn}`);
      console.log(`  villager poses ${JSON.stringify(gather.poses)}`);
      console.log(`  villager pools ${gather.poolKeys.join(', ') || '(none)'}`);
      if (!gather.felled) problemsExtra.push('tree never finished being chopped');
      else if (!gather.fallStillAnimating) problemsExtra.push('tree felled but no topple animation was active');
    }
    await page.screenshot({ path: path.join(OUT, '03-gathering.png') });

    /* ---- farming: food actually arrives, one villager per plot, stands on it ---- */
    const farming = await page.evaluate(async () => {
      const g = window.__game;
      const pl = g.players[0];
      const s = g.map.starts[0];
      pl.res.wood = 5000; pl.res.food = 0;

      // drop three plots near the town
      const farms = [];
      for (let i = 0; i < 3 && farms.length < 3; i++) {
        for (let tries = 0; tries < 60 && farms.length <= i; tries++) {
          const tx = Math.round(s.x + 5 + (i * 4) + (tries % 5));
          const ty = Math.round(s.y - 6 + Math.floor(tries / 5));
          if (g.canPlaceBuilding('farm', 0, tx, ty)) {
            const b = g.placeBuilding('farm', 0, tx, ty, true);
            b.farmFood = 175; b.farmMax = 175;
            farms.push(b);
          }
        }
      }
      if (farms.length < 2) return { error: 'could not place farms' };

      const vills = g.entities.filter((e) => e.alive && e.owner === 0 &&
        e.kind === 'unit' && e.def.cat === 'villager');
      // send EVERY villager at ONE plot - they should spread out, not stack
      g.commandGather(vills, farms[0], false);
      const foodBefore = pl.res.food;
      const farmFoodBefore = farms.map((f) => f.farmFood);

      // Poll for a completed carry cycle rather than guessing a duration:
      // walking distance varies by map seed, so a fixed sleep is flaky.
      let waitedF = 0;
      while (waitedF < 60000 && pl.res.food - foodBefore <= 0) {
        await new Promise((r) => setTimeout(r, 500));
        waitedF += 500;
      }

      const assigned = farms.map((f) => vills.filter((v) =>
        (v.task.type === 'gather' && v.task.targetId === f.id) ||
        (v.task.type === 'deliver' && v.task.returnTo === f.id)).length);
      const standingOn = vills.filter((v) => {
        const t = v.task.type === 'gather' ? g.byId.get(v.task.targetId) : null;
        if (!t || !t.def || !t.def.farmFood) return false;
        return Math.hypot(t.x - v.x, t.y - v.y) <= 0.6;
      }).length;
      const carryingNaN = vills.some((v) => v.carrying && Number.isNaN(v.carrying.amount));

      return {
        farms: farms.length,
        villagers: vills.length,
        farmFoodBefore,
        farmFoodNow: farms.map((f) => +f.farmFood.toFixed(1)),
        drained: farms.map((f, i) => +(farmFoodBefore[i] - f.farmFood).toFixed(1)),
        foodGained: +(pl.res.food - foodBefore).toFixed(1),
        assigned,
        maxPerFarm: Math.max(...assigned),
        standingOn,
        carryingNaN,
      };
    });

    console.log('\n== farming ==');
    if (farming.error) console.log('  ' + farming.error);
    else {
      console.log(`  plots ${farming.farms}, villagers sent ${farming.villagers} (all at ONE plot)`);
      console.log(`  villagers per plot   ${JSON.stringify(farming.assigned)}  (max ${farming.maxPerFarm})`);
      console.log(`  food drawn per plot  ${JSON.stringify(farming.drained)}`);
      console.log(`  food delivered       ${farming.foodGained}`);
      console.log(`  standing on the plot ${farming.standingOn}`);
      console.log(`  NaN carry amounts    ${farming.carryingNaN}`);
      if (farming.carryingNaN) problemsExtra.push('villager carry amount went NaN while farming');
      if (!farming.drained.some((d) => d > 0.5)) problemsExtra.push('no food was drawn from any farm');
      if (farming.foodGained <= 0) problemsExtra.push('farming delivered no food to the stockpile');
      if (farming.maxPerFarm > 1) problemsExtra.push(`${farming.maxPerFarm} villagers on one farm (should be 1)`);
      if (farming.standingOn === 0) problemsExtra.push('no villager is standing on its farm plot');
    }

    /* ---- production spreads across selected buildings by soonest slot ---- */
    const spread = await page.evaluate(() => {
      const g = window.__game, pl = g.players[0];
      pl.res.food = 9000; pl.res.wood = 9000; pl.res.gold = 9000;
      pl.popCap = 200;
      const s = g.map.starts[0];
      const stables = [];
      for (let i = 0; i < 3; i++) {
        for (let r = 5; r < 14 && stables.length <= i; r++) {
          for (let a = 0; a < 24 && stables.length <= i; a++) {
            const tx = Math.round(s.x + Math.cos(a) * r), ty = Math.round(s.y + Math.sin(a) * r);
            if (g.canPlaceBuilding('stable', 0, tx, ty)) stables.push(g.placeBuilding('stable', 0, tx, ty, true));
          }
        }
      }
      if (stables.length < 3) return { error: `only placed ${stables.length} stables` };

      // make the first one genuinely busy (a tech may not be available yet,
      // which silently left it idle and made this test prove nothing)
      for (let i = 0; i < 3; i++) g.queueUnit(stables[0], 'scoutCavalry');
      const busyWait = +g.queueWaitTime(stables[0]).toFixed(0);

      const beforeCounts = stables.map((b) => b.queue.length);
      const one = g.queueUnitSpread(stables, 'scoutCavalry', 1);
      const firstWentTo = stables.findIndex((b, i) => b.queue.length > beforeCounts[i]);
      const batch = g.queueUnitSpread(stables, 'scoutCavalry', 5);

      return {
        busyWait, firstWentTo,
        singleQueued: one.queued,
        batchQueued: batch.queued,
        perBuilding: stables.map((b) => b.queue.length),
        busyHasTech: stables[0].queue.some((q) => q.kind === 'tech'),
      };
    });
    console.log('\n== production spread across buildings ==');
    if (spread.error) console.log('  ' + spread.error);
    else {
      console.log(`  stable[0] busy researching (${spread.busyWait}s of work queued)`);
      console.log(`  single click went to stable[${spread.firstWentTo}]  ${spread.firstWentTo !== 0 ? 'OK - skipped the busy one' : 'went to the BUSY one'}`);
      console.log(`  shift-click queued   ${spread.batchQueued} (of 5 requested)`);
      console.log(`  units per stable     ${JSON.stringify(spread.perBuilding)}`);
      if (spread.firstWentTo === 0) problemsExtra.push('single unit went to the building busy with a tech');
      if (spread.batchQueued !== 5) problemsExtra.push(`shift-click queued ${spread.batchQueued}, expected 5`);
      const spreadCount = spread.perBuilding.filter((n) => n > 0).length;
      if (spreadCount < 2) problemsExtra.push('batch did not spread across buildings');
    }

    /* ---- selecting every idle villager at once ---- */
    const idleSel = await page.evaluate(() => {
      const c = window.__ctx, g = window.__game;
      const vills = g.entities.filter((e) => e.alive && e.owner === 0 &&
        e.kind === 'unit' && e.def.cat === 'villager');
      for (const v of vills) { g.commandStop([v]); }
      const idleCount = vills.filter((v) => v.task.type === 'idle').length;
      c.input.selectAllIdle('villager');
      return { idleCount, selected: c.input.selection.length };
    });
    console.log('\n== shift-click idle counter ==');
    console.log(`  idle villagers ${idleSel.idleCount}, selected ${idleSel.selected}`);
    if (idleSel.selected !== idleSel.idleCount) {
      problemsExtra.push(`selectAllIdle picked ${idleSel.selected} of ${idleSel.idleCount}`);
    }

    /* ---- shift-click a Mill: one farm per villager, packed around it ---- */
    const mass = await page.evaluate(async () => {
      const g = window.__game, pl = g.players[0];
      const s = g.map.starts[0];
      pl.res.wood = 5000;

      // a Mill to cluster around
      let mill = null;
      for (let r = 4; r < 10 && !mill; r++) {
        for (let a = 0; a < 20 && !mill; a++) {
          const tx = Math.round(s.x + Math.cos(a) * r), ty = Math.round(s.y + Math.sin(a) * r);
          if (g.canPlaceBuilding('mill', 0, tx, ty)) mill = g.placeBuilding('mill', 0, tx, ty, true);
        }
      }
      if (!mill) return { error: 'could not place a Mill' };

      // six villagers standing by
      const vills = [];
      for (let i = 0; i < 6; i++) {
        vills.push(g.spawnUnit('villager', 0, s.x + (i % 3) - 1, s.y + Math.floor(i / 3) - 1));
      }
      const woodBefore = pl.res.wood;
      // only measure plots THIS command creates; earlier test phases left farms
      // elsewhere on the map that would skew the distance check
      const before = new Set(g.entities.filter((e) => g._isFarm(e)).map((e) => e.id));
      const assigned = g.commandFarmAround(vills, mill, false);

      const farms = g.entities.filter((e) => e.alive && g._isFarm(e) && e.owner === 0 && !before.has(e.id));
      const targets = vills.map((v) => v.task.type === 'build' ? v.task.targetId
        : v.task.type === 'gather' ? v.task.targetId : 0);
      const distinct = new Set(targets.filter(Boolean)).size;

      // do any two plots overlap?
      let overlaps = 0;
      for (let i = 0; i < farms.length; i++) {
        for (let j = i + 1; j < farms.length; j++) {
          const a = farms[i], b = farms[j];
          if (a.tx < b.tx + b.size && a.tx + a.size > b.tx &&
              a.ty < b.ty + b.size && a.ty + a.size > b.ty) overlaps++;
        }
      }
      const dists = farms.map((f) => +Math.hypot(f.x - mill.x, f.y - mill.y).toFixed(1));
      return {
        assigned, farms: farms.length, distinct,
        overlaps,
        woodSpent: woodBefore - pl.res.wood,
        maxDist: Math.max(...dists), minDist: Math.min(...dists),
        tasks: vills.map((v) => v.task.type),
      };
    });
    console.log('\n== shift-click Mill: mass farms ==');
    if (mass.error) console.log('  ' + mass.error);
    else {
      console.log(`  villagers assigned   ${mass.assigned} of 6`);
      console.log(`  farms now present    ${mass.farms}  (wood spent ${mass.woodSpent})`);
      console.log(`  distinct plot per villager ${mass.distinct}`);
      console.log(`  overlapping plots    ${mass.overlaps}`);
      console.log(`  distance from Mill   ${mass.minDist} .. ${mass.maxDist} tiles`);
      console.log(`  villager tasks       ${JSON.stringify(mass.tasks)}`);
      if (mass.assigned < 6) problemsExtra.push(`only ${mass.assigned}/6 villagers were given a farm`);
      if (mass.distinct < mass.assigned) problemsExtra.push('villagers share a plot instead of one each');
      if (mass.overlaps > 0) problemsExtra.push(`${mass.overlaps} farm plots overlap each other`);
      if (mass.maxDist > 12) problemsExtra.push(`a farm was placed ${mass.maxDist} tiles from the Mill`);
    }

    /* ---- shift+click on a Mill through the real input path ---- */
    const clickFarm = await page.evaluate(() => {
      const c = window.__ctx, g = window.__game, pl = g.players[0];
      pl.res.wood = 5000;
      const s = g.map.starts[0];
      let mill = g.entities.find((e) => e.alive && e.type === 'mill' && e.owner === 0);
      for (let r = 4; r < 10 && !mill; r++) {
        for (let a = 0; a < 20 && !mill; a++) {
          const tx = Math.round(s.x + Math.cos(a) * r), ty = Math.round(s.y + Math.sin(a) * r);
          if (g.canPlaceBuilding('mill', 0, tx, ty)) mill = g.placeBuilding('mill', 0, tx, ty, true);
        }
      }
      if (!mill) return { error: 'no mill' };

      // put villagers ON the mill so the unit-first picker would grab one
      const vills = [];
      for (let i = 0; i < 4; i++) vills.push(g.spawnUnit('villager', 0, mill.x, mill.y));
      c.renderer.centerOn(mill.x, mill.y);
      c.renderer.render(pl, []);
      c.input.setSelection(vills);

      const scr = c.renderer.worldToScreen(mill.x, c.renderer.heightAt(mill.x, mill.y), mill.y);
      const before = g.entities.filter((e) => g._isFarm(e) && e.alive).length;

      // what does the generic picker return at that point?
      const generic = c.input.pickAt(scr.x, scr.y);
      const building = c.input._pickBuilding(scr.x, scr.y);

      const handledLeft = c.input._tryMassFarm({ x: scr.x, y: scr.y });
      const after = g.entities.filter((e) => g._isFarm(e) && e.alive).length;

      return {
        genericPick: generic ? generic.kind + ':' + (generic.type || '') : 'none',
        buildingPick: building ? building.type : 'none',
        handledLeft,
        farmsCreated: after - before,
        tasks: vills.map((v) => v.task.type),
      };
    });
    /* ---- several villagers on ONE farm: extras must go make their own ---- */
    const shareFarm = await page.evaluate(async () => {
      const g = window.__game, pl = g.players[0];
      pl.res.wood = 5000; pl.res.food = 5000;
      const mill = g.entities.find((e) => e.alive && e.type === 'mill' && e.owner === 0);
      if (!mill) return { error: 'no mill' };

      // one plot, four villagers all told to build it
      let spot = g._nearestFarmSpot(mill, 0, []);
      if (!spot) return { error: 'no room' };
      pl.spend(pl.mods.building('farm').cost);
      const farm = g.placeBuilding('farm', 0, spot.x, spot.y, false);

      const vills = [];
      for (let i = 0; i < 4; i++) vills.push(g.spawnUnit('villager', 0, mill.x, mill.y));
      g.commandBuildAt(vills, farm, false);

      // wait for it to finish and the follow-up work to be handed out
      let waited = 0;
      while (waited < 40000 && !farm.complete) {
        await new Promise((r) => setTimeout(r, 250)); waited += 250;
      }
      await new Promise((r) => setTimeout(r, 3000));

      const tasks = vills.map((v) => v.task.type);
      const idle = tasks.filter((t) => t === 'idle').length;
      const farming = vills.filter((v) => {
        const t = v.task.type === 'gather' ? g.byId.get(v.task.targetId) : null;
        return t && g._isFarm(t);
      }).length;
      const buildingFarms = vills.filter((v) => {
        const t = v.task.type === 'build' ? g.byId.get(v.task.targetId) : null;
        return t && g._isFarm(t);
      }).length;
      const plots = g.entities.filter((e) => e.alive && g._isFarm(e) && e.owner === 0).length;
      return { completed: farm.complete, tasks, idle, farming, buildingFarms, plots };
    });
    console.log('\n== several villagers, one farm ==');
    if (shareFarm.error) console.log('  ' + shareFarm.error);
    else {
      console.log(`  farm completed       ${shareFarm.completed}`);
      console.log(`  villager tasks       ${JSON.stringify(shareFarm.tasks)}`);
      console.log(`  now farming          ${shareFarm.farming}`);
      console.log(`  now building a farm  ${shareFarm.buildingFarms}`);
      console.log(`  left idle            ${shareFarm.idle}`);
      if (shareFarm.completed && shareFarm.idle > 0) {
        problemsExtra.push(`${shareFarm.idle} villagers left idle after sharing a farm`);
      }
      if (shareFarm.completed && shareFarm.farming < 1) {
        problemsExtra.push('nobody started farming the completed plot');
      }
    }

    /* ---- Farm build-mode + shift-click the Mill = queue plots one per click ---- */
    const snap = await page.evaluate(() => {
      const c = window.__ctx, g = window.__game, pl = g.players[0];
      pl.res.wood = 5000;
      const mill = g.entities.find((e) => e.alive && e.type === 'mill' && e.owner === 0);
      if (!mill) return { error: 'no mill' };
      const vills = [];
      for (let i = 0; i < 4; i++) vills.push(g.spawnUnit('villager', 0, mill.x + 1, mill.y + 1));
      c.input.setSelection(vills);
      c.renderer.centerOn(mill.x, mill.y);
      c.renderer.render(pl, []);
      const scr = c.renderer.worldToScreen(mill.x, c.renderer.heightAt(mill.x, mill.y), mill.y);
      c.input.mouse.x = scr.x; c.input.mouse.y = scr.y;

      // pick Farm from the build menu, then hover the Mill WITHOUT shift
      c.input.startPlacement('farm');
      c.input._updatePlacement();
      const withoutShift = { tx: c.input.placement.tx, ty: c.input.placement.ty,
        valid: c.input.placement.valid, snapped: !!c.input.placement.snappedTo };

      // now hold shift - the ghost should jump off the Mill to a legal plot
      c.input.keys.add('ShiftLeft');
      c.input._updatePlacement();
      const withShift = { tx: c.input.placement.tx, ty: c.input.placement.ty,
        valid: c.input.placement.valid, snapped: !!c.input.placement.snappedTo };

      // click repeatedly with shift held: each should add one more farm
      const before = g.entities.filter((e) => e.alive && g._isFarm(e)).length;
      const spots = [];
      for (let i = 0; i < 5; i++) {
        c.input._placeBuilding(true);
        if (c.input.placement) spots.push(`${c.input.placement.tx},${c.input.placement.ty}`);
      }
      const after = g.entities.filter((e) => e.alive && g._isFarm(e)).length;
      const builders = vills.filter((v) => v.task.type === 'build').length;
      const distinctTargets = new Set(vills.map((v) => v.task.targetId)).size;
      const stillPlacing = !!c.input.placement;
      c.input.cancelPlacement();
      c.input.keys.delete('ShiftLeft');
      return { withoutShift, withShift, created: after - before, builders,
        distinctTargets, stillPlacing, spots };
    });
    console.log('\n== Farm build-mode + shift over the Mill ==');
    if (snap.error) console.log('  ' + snap.error);
    else {
      console.log(`  ghost without shift  ${snap.withoutShift.tx},${snap.withoutShift.ty} valid=${snap.withoutShift.valid} snapped=${snap.withoutShift.snapped}`);
      console.log(`  ghost with shift     ${snap.withShift.tx},${snap.withShift.ty} valid=${snap.withShift.valid} snapped=${snap.withShift.snapped}`);
      console.log(`  farms from 5 clicks  ${snap.created}`);
      console.log(`  villagers building   ${snap.builders} on ${snap.distinctTargets} distinct plots`);
      console.log(`  still in place mode  ${snap.stillPlacing}`);
      if (!snap.withShift.snapped) problemsExtra.push('shift did not snap the farm ghost to the Mill');
      if (!snap.withShift.valid) problemsExtra.push('snapped farm position was not valid');
      if (snap.created < 5) problemsExtra.push(`5 shift-clicks produced only ${snap.created} farms`);
      if (!snap.stillPlacing) problemsExtra.push('placement mode ended, cannot keep clicking');
    }

    /* ---- the hover preview must match what the click actually builds ---- */
    const preview = await page.evaluate(() => {
      const c = window.__ctx, g = window.__game, pl = g.players[0];
      pl.res.wood = 5000;
      const mill = g.entities.find((e) => e.alive && e.type === 'mill' && e.owner === 0);
      if (!mill) return { error: 'no mill' };
      const vills = [];
      for (let i = 0; i < 5; i++) vills.push(g.spawnUnit('villager', 0, mill.x + 1, mill.y + 1));
      c.input.setSelection(vills);
      c.renderer.centerOn(mill.x, mill.y);
      c.renderer.render(pl, []);

      const scr = c.renderer.worldToScreen(mill.x, c.renderer.heightAt(mill.x, mill.y), mill.y);
      c.input.mouse.x = scr.x; c.input.mouse.y = scr.y;
      c.input.keys.add('ShiftLeft');
      c.input._previewKey = null;
      c.input.updateFarmPreview();
      const shown = (c.renderer.farmPreview || []).map((p) => `${p.tx},${p.ty}${p.reuse ? 'R' : ''}`);
      // pads are created during a draw, so render once before counting them
      c.renderer.render(pl, c.input.selection);
      const padsVisible = (c.renderer._previewPads || []).filter((p) => p.visible).length;

      // now actually do it and compare
      const beforeIds = new Set(g.entities.filter((e) => g._isFarm(e)).map((e) => e.id));
      c.input._tryMassFarm({ x: scr.x, y: scr.y });
      const built = g.entities.filter((e) => e.alive && g._isFarm(e) && !beforeIds.has(e.id))
        .map((e) => `${e.tx},${e.ty}`);
      const reused = shown.filter((s) => s.endsWith('R')).length;

      c.input.keys.delete('ShiftLeft');
      c.input._previewKey = null;
      c.input.updateFarmPreview();
      const clearedOnRelease = c.renderer.farmPreview === null;

      const newShown = shown.filter((s) => !s.endsWith('R'));
      const match = newShown.length === built.length &&
        newShown.every((s) => built.includes(s));
      return { shown, built, reused, match, padsVisible, clearedOnRelease };
    });
    console.log('\n== farm placement preview ==');
    if (preview.error) console.log('  ' + preview.error);
    else {
      console.log(`  preview showed   ${preview.shown.join(' ')} (${preview.reused} reused)`);
      console.log(`  click built at   ${preview.built.join(' ')}`);
      console.log(`  preview matched  ${preview.match}`);
      console.log(`  pads rendered    ${preview.padsVisible}`);
      console.log(`  cleared on shift release ${preview.clearedOnRelease}`);
      if (!preview.shown.length) problemsExtra.push('no farm preview was produced on hover');
      if (!preview.match) problemsExtra.push('preview did not match what the click built');
      if (!preview.padsVisible) problemsExtra.push('preview pads were not rendered');
      if (!preview.clearedOnRelease) problemsExtra.push('preview not cleared when shift released');
    }

    console.log('\n== shift+click Mill (real input path) ==');
    if (clickFarm.error) console.log('  ' + clickFarm.error);
    else {
      console.log(`  generic picker returns   ${clickFarm.genericPick}`);
      console.log(`  building picker returns  ${clickFarm.buildingPick}`);
      console.log(`  click handled            ${clickFarm.handledLeft}`);
      console.log(`  farms created            ${clickFarm.farmsCreated}`);
      console.log(`  villager tasks           ${JSON.stringify(clickFarm.tasks)}`);
      // What matters is that every villager got a farm job. Some will reuse an
      // existing idle plot rather than paying for a new one, so counting newly
      // built farms alone under-reports success.
      const working = clickFarm.tasks.filter((t) => t === 'build' || t === 'gather').length;
      console.log(`  villagers given a plot   ${working} of 4`);
      if (!clickFarm.handledLeft) problemsExtra.push('shift+click on a Mill was not handled');
      if (working < 4) problemsExtra.push(`shift+click put ${working}/4 villagers on farms`);
    }

    /* ---- exhausted farms re-sow themselves while wood allows ---- */
    const reseed = await page.evaluate(async () => {
      const g = window.__game, pl = g.players[0];
      const farm = g.entities.find((e) => e.alive && g._isFarm(e) && e.owner === 0 && e.complete);
      if (!farm) return { error: 'no farm to test' };
      const cost = pl.mods.building('farm').cost.wood;

      // 1) plenty of wood: should re-sow in place and keep its worker
      pl.res.wood = 1000;
      pl.autoReseed = true;
      const workerBefore = g._farmWorker(farm) ? g._farmWorker(farm).id : 0;
      farm.farmFood = 0;   // actually empty, so the depletion branch fires
      const woodBefore = pl.res.wood;
      await new Promise((r) => setTimeout(r, 2500));
      const survived = farm.alive;
      const refilled = +farm.farmFood.toFixed(1);
      const woodSpent = +(woodBefore - pl.res.wood).toFixed(0);
      const workerAfter = farm.alive && g._farmWorker(farm) ? g._farmWorker(farm).id : 0;

      // 2) no wood: the plot must be allowed to expire
      pl.res.wood = 0;
      farm.farmFood = 0;   // actually empty, so the depletion branch fires
      await new Promise((r) => setTimeout(r, 2500));
      const diedWithoutWood = !farm.alive;

      // 3) toggle off: even with wood, the plot expires
      let respectsToggle = null;
      const farm2 = g.entities.find((e) => e.alive && g._isFarm(e) && e.owner === 0 && e.complete);
      if (farm2) {
        pl.res.wood = 1000;
        pl.autoReseed = false;
        farm2.farmFood = 0;   // actually empty, so the depletion branch fires
        await new Promise((r) => setTimeout(r, 2500));
        respectsToggle = !farm2.alive;
        pl.autoReseed = true;
      }
      return { cost, survived, refilled, woodSpent, workerBefore, workerAfter,
        keptWorker: workerBefore !== 0 && workerBefore === workerAfter,
        diedWithoutWood, respectsToggle };
    });
    console.log('\n== farm auto-reseed ==');
    if (reseed.error) console.log('  ' + reseed.error);
    else {
      console.log(`  re-sown in place       ${reseed.survived} (food back to ${reseed.refilled})`);
      console.log(`  wood charged           ${reseed.woodSpent} (farm costs ${reseed.cost})`);
      console.log(`  farmer kept working    ${reseed.keptWorker} (${reseed.workerBefore} -> ${reseed.workerAfter})`);
      console.log(`  expires with no wood   ${reseed.diedWithoutWood}`);
      console.log(`  respects the toggle    ${reseed.respectsToggle}`);
      if (!reseed.survived) problemsExtra.push('farm was not reseeded despite ample wood');
      if (reseed.woodSpent !== reseed.cost) problemsExtra.push(`reseed charged ${reseed.woodSpent} wood, expected ${reseed.cost}`);
      if (!reseed.diedWithoutWood) problemsExtra.push('farm survived with no wood to pay for reseeding');
      if (reseed.respectsToggle === false) problemsExtra.push('auto-reseed toggle was ignored');
    }

    /* ---- gatherers must stand tight against their resource ---- */
    const hug = await page.evaluate(async () => {
      const g = window.__game;
      const vills = g.entities.filter((e) => e.alive && e.owner === 0 &&
        e.kind === 'unit' && e.def.cat === 'villager');
      const nodes = { tree: null, gold: null, berries: null };
      for (const e of g.entities) {
        if (!e.alive || e.kind !== 'resource') continue;
        if (nodes[e.type] === null) nodes[e.type] = e;
      }
      const picked = Object.entries(nodes).filter(([, n]) => n);
      picked.forEach(([, n], i) => { if (vills[i]) g.commandGather([vills[i]], n, false); });

      await new Promise((r) => setTimeout(r, 20000));

      const out = [];
      for (const v of vills) {
        if (v.task.type !== 'gather') continue;
        // only sample villagers that have ARRIVED; one still walking is
        // metres away and says nothing about the standing distance
        if (v.moving) continue;
        const n = g.byId.get(v.task.targetId);
        if (!n || n.kind !== 'resource') continue;
        const centre = Math.hypot(n.x - v.x, n.y - v.y);
        out.push({
          type: n.type,
          centreDist: +centre.toFixed(2),
          gap: +(centre - (n.radius || 0) - v.radius).toFixed(2),
          blocked: !!(g.grid.blocked[n.ty * g.size + n.tx]),
        });
      }
      return out;
    });
    console.log('\n== gatherer standing distance ==');
    if (!hug.length) console.log('  nobody was gathering at sample time');
    for (const h of hug) {
      console.log(`  ${h.type.padEnd(8)} centre-to-centre ${h.centreDist}  edge gap ${h.gap}` +
        `${h.blocked ? '  (tile blocked - must stand on a neighbour)' : ''}`);
    }
    const worst = hug.reduce((a, h) => Math.max(a, h.centreDist), 0);
    if (worst > 1.25) problemsExtra.push(`a gatherer stands ${worst} tiles from its resource centre`);

    /* ---- selecting every entity kind must not throw ---- */
    const selectAll = await page.evaluate(() => {
      const c = window.__ctx, g = window.__game;
      const kinds = new Map();
      for (const e of g.entities) {
        if (!e.alive) continue;
        const k = e.kind === 'resource' ? 'resource:' + e.type
          : e.kind === 'building' ? 'building' : 'unit:' + e.def.cat;
        if (!kinds.has(k)) kinds.set(k, e);
      }
      const failures = [];
      for (const [k, e] of kinds) {
        try {
          c.input.setSelection([e]);
          c.hud.lastSelKey = '';       // force a real re-render
          c.hud.update(c.input.selection);
        } catch (err) {
          failures.push(`${k}: ${err.message}`);
        }
      }
      c.input.setSelection([]);
      return { tried: [...kinds.keys()], failures };
    });
    console.log('\n== selecting each entity kind ==');
    console.log('  tried    ' + selectAll.tried.join(', '));
    console.log('  failures ' + (selectAll.failures.length ? selectAll.failures.join(' | ') : 'none'));
    for (const f of selectAll.failures) problemsExtra.push('selection crash - ' + f);

    /* ---- villagers auto-work after finishing a drop site ---- */
    const autoWork = await page.evaluate(async () => {
      const g = window.__game, pl = g.players[0];
      pl.res.wood = 5000; pl.res.food = 5000; pl.res.stone = 5000;
      const out = {};

      const build = async (type, near) => {
        const vills = g.entities.filter((e) => e.alive && e.owner === 0 &&
          e.kind === 'unit' && e.def.cat === 'villager');
        if (!vills.length) return null;
        const v = vills[0];
        g.commandStop([v]);
        let placed = null;
        for (let r = 2; r < 9 && !placed; r++) {
          for (let a = 0; a < 16 && !placed; a++) {
            const tx = Math.round(near.x + Math.cos(a) * r);
            const ty = Math.round(near.y + Math.sin(a) * r);
            if (g.canPlaceBuilding(type, 0, tx, ty)) {
              placed = g.commandBuild([v], type, tx, ty, false);
            }
          }
        }
        if (!placed) return null;
        placed.buildProgress = placed.def.time - 0.4;   // nearly done
        for (let i = 0; i < 200 && !placed.alive === false; i++) {
          await new Promise((r) => setTimeout(r, 100));
          if (placed.complete) break;
        }
        await new Promise((r) => setTimeout(r, 400));
        return { task: v.task.type, res: v.task.resType || null, done: placed.complete };
      };

      const tree = g.entities.find((e) => e.alive && e.kind === 'resource' && e.type === 'tree');
      if (tree) out.lumberCamp = await build('lumberCamp', tree);
      const bush = g.entities.find((e) => e.alive && e.kind === 'resource' && e.type === 'berries');
      if (bush) out.mill = await build('mill', bush);
      out.farm = await build('farm', g.map.starts[0]);
      return out;
    });
    console.log('\n== auto-work after building ==');
    for (const [k, v] of Object.entries(autoWork)) {
      if (!v) { console.log(`  ${k.padEnd(11)} could not be placed`); continue; }
      // retaliating against a wolf is legitimate, not a failure to auto-assign
      const ok = v.task === 'gather' || v.task === 'attack';
      console.log(`  ${k.padEnd(11)} builder now: ${v.task}${v.res ? ' (' + v.res + ')' : ''} ${ok ? 'OK' : 'NOT GATHERING'}`);
      if (v.done && !ok) problemsExtra.push(`${k} builder did not auto-start gathering (task=${v.task})`);
    }

    /* ---- minimap viewport box must match what is actually on screen ---- */
    const mm = await page.evaluate(() => {
      const c = window.__ctx, g = window.__game, r = c.renderer;
      const corners = c.hud.viewportCorners();
      if (!corners) return { error: 'no viewport corners' };

      const inside = (p, poly) => {
        let hit = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
          const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
          if ((yi > p.y) !== (yj > p.y) &&
              p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) hit = !hit;
        }
        return hit;
      };

      const top = c.hud.topBar.offsetHeight;
      const bottom = c.hud.bottom.offsetHeight;
      let onScreen = 0, boxed = 0;
      const misses = [];
      for (const e of g.entities) {
        if (!e.alive || e.kind === 'projectile') continue;
        const s = r.worldToScreen(e.x, r.heightAt(e.x, e.y), e.y);
        // is it inside the band the player can actually see?
        if (s.z > 1 || s.x < 0 || s.x > r.viewW) continue;
        if (s.y < top + 4 || s.y > r.viewH - bottom - 4) continue;
        onScreen++;
        if (inside({ x: e.x, y: e.y }, corners)) boxed++;
        else if (misses.length < 3) misses.push({ x: +e.x.toFixed(1), y: +e.y.toFixed(1) });
      }

      // where is the centre of the visible band, vs the box centre?
      const bandMid = r.screenToWorld(r.viewW / 2, (top + (r.viewH - bottom)) / 2);
      const cx = corners.reduce((a, p) => a + p.x, 0) / 4;
      const cy = corners.reduce((a, p) => a + p.y, 0) / 4;
      return {
        onScreen, boxed, misses,
        pctBoxed: onScreen ? +(100 * boxed / onScreen).toFixed(1) : 100,
        boxCentre: [+cx.toFixed(1), +cy.toFixed(1)],
        bandCentre: [+bandMid.x.toFixed(1), +bandMid.y.toFixed(1)],
        drift: +Math.hypot(cx - bandMid.x, cy - bandMid.y).toFixed(2),
      };
    });

    console.log('\n== minimap viewport box ==');
    if (mm.error) console.log('  ' + mm.error);
    else {
      console.log(`  entities visible on screen   ${mm.onScreen}`);
      console.log(`  of those, inside the box     ${mm.boxed} (${mm.pctBoxed}%)`);
      console.log(`  box centre  ${mm.boxCentre.join(', ')}`);
      console.log(`  view centre ${mm.bandCentre.join(', ')}   drift ${mm.drift} tiles`);
      if (mm.misses.length) console.log('  first misses ', JSON.stringify(mm.misses));
      if (mm.pctBoxed < 99) problemsExtra.push(`minimap box misses ${(100 - mm.pctBoxed).toFixed(1)}% of on-screen entities`);
      if (mm.drift > 1.5) problemsExtra.push(`minimap box centre drifts ${mm.drift} tiles from the view centre`);
    }

    console.log('\n== console errors ==');
    if (!errors.length) console.log('  none');
    else for (const e of [...new Set(errors)].slice(0, 25)) console.log('  ' + e);

    fs.writeFileSync(path.join(OUT, 'console.log'), log.join('\n'));
    console.log(`\nscreenshots -> ${OUT}\n`);

    /* ---------------- verdict ---------------- */
    const problems = [...problemsExtra];
    // Terrain health is judged with the map revealed; under fog most of the
    // screen is legitimately black, so darkness there proves nothing.
    if (revealed.greenPct < 15) {
      problems.push(`revealed map is only ${revealed.greenPct}% greenish - terrain not rendering properly`);
    }
    if (revealed.avg[2] > revealed.avg[1]) problems.push('revealed map is more blue than green');
    if (stats.bluePct > 45) problems.push(`${stats.bluePct}% of the fogged view is blue`);
    if (!stats.pools.length) problems.push('no instanced meshes were drawn');
    if (stats.fogTiles.visible === 0) problems.push('fog texture reports zero visible tiles');
    if (stats.fogTiles.explored === 0) problems.push('nothing became explored-but-not-visible - shroud state unreachable');
    if (fogBands && fogBands.spread < 25) {
      problems.push(`fog states are not visually distinct (brightness spread ${fogBands.spread})`);
    }
    if (problems.length) {
      console.log('PROBLEMS:');
      for (const p of problems) console.log('  x ' + p);
      process.exitCode = 1;
    } else {
      console.log('OK: terrain, meshes and fog all appear to be rendering.');
    }
  } finally {
    await browser.close();
    server.kill();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
