// Boot: load three.js (vendored copy if present, otherwise straight from the
// CDN), show the setup menu, then run the fixed-step game loop.

import { Game, TICK } from './sim/game.js';
import { AI } from './sim/ai.js';
import { Renderer, PLAYER_COLORS } from './render/renderer.js';
import { HUD } from './ui/hud.js';
import { Input } from './ui/input.js';
import { Overlay } from './ui/overlay.js';
import { Audio } from './audio/audio.js';
import { CIVILIZATIONS, CIV_IDS } from './data/civs.js';

const THREE_CDN = 'https://unpkg.com/three@0.169.0/build/three.module.js';
const THREE_LOCAL = '/vendor/three.module.js';

/**
 * Selectable population limits.
 *
 * Fine steps at the bottom, where 25 population is a real difference to how a
 * game plays, and coarse ones at the top, where it is not - the gap between 800
 * and 900 changes nothing about the shape of a match, and a list of forty
 * options is worse to use than a list of fifteen. Everything above the usual
 * 200 is there for long games: the AI's economy is written in proportions of
 * the limit, so it fills whatever it is given rather than stopping at a
 * hard-coded villager count.
 */
const POP_LIMITS = [50, 75, 100, 125, 150, 200, 250, 300, 400, 500, 600, 700, 800, 900, 1000];

async function loadThree(status) {
  // Prefer a vendored copy (npm run fetch-assets) so the game runs offline.
  try {
    const list = await fetch('/api/assets').then((r) => r.json());
    if (list.vendored && list.vendored.includes('three.module.js')) {
      status('Loading 3D engine (local copy)...');
      return await import(THREE_LOCAL);
    }
  } catch { /* server may not expose the endpoint - fall through to the CDN */ }
  status('Downloading 3D engine from the network...');
  try {
    return await import(/* @vite-ignore */ THREE_CDN);
  } catch (e) {
    status('Could not download three.js. Run "npm run fetch-assets" while online, then reload.');
    throw e;
  }
}

/* ================================================================
 *  Menu
 * ================================================================ */

function buildMenu(onStart) {
  const menu = document.getElementById('menu');
  const civOptions = CIV_IDS.map((id) =>
    `<option value="${id}">${CIVILIZATIONS[id].name}</option>`).join('');

  menu.innerHTML = `
    <div class="menu-box">
      <h1>AGE OF ANTIQUITY</h1>
      <p class="sub">A retro low-poly tribute to Age of Empires II: Definitive Edition</p>

      <div class="menu-modes">
        <button id="mModePlay" class="modebtn on">Play</button>
        <button id="mModeWatch" class="modebtn">Spectate</button>
      </div>

      <div class="menu-grid">
        <label class="playonly">Your civilization
          <select id="mCiv">${civOptions}</select>
        </label>
        <label class="playonly">Opponents
          <select id="mOpp">
            <option value="1" selected>1</option>
            <option value="2">2</option>
            <option value="3">3</option>
          </select>
        </label>
        <label class="watchonly hidden">Number of AIs
          <select id="mAiCount">
            <option value="2" selected>2</option>
            <option value="3">3</option>
            <option value="4">4</option>
          </select>
        </label>
        <label class="watchonly hidden">Teams
          <select id="mTeams">
            <option value="ffa" selected>Free-for-all</option>
            <option value="2v2">2 v 2</option>
            <option value="3v1">3 v 1</option>
            <option value="2v1">2 v 1</option>
          </select>
        </label>
        <label class="watchonly hidden ai-slot" data-slot="0">AI 1
          <select id="mCivA">${civOptions}</select>
        </label>
        <label class="watchonly hidden ai-slot" data-slot="1">AI 2
          <select id="mCivB">${civOptions}</select>
        </label>
        <label class="watchonly hidden ai-slot" data-slot="2">AI 3
          <select id="mCivC">${civOptions}</select>
        </label>
        <label class="watchonly hidden ai-slot" data-slot="3">AI 4
          <select id="mCivD">${civOptions}</select>
        </label>
        <label>Map type
          <select id="mMapType">
            <option value="mixed" selected>Mixed — land and water</option>
            <option value="land">Land only — no water</option>
          </select>
        </label>
        <label>Difficulty
          <select id="mDiff">
            <option value="easy">Standard</option>
            <option value="moderate" selected>Moderate</option>
            <option value="hard">Hard</option>
          </select>
        </label>
        <label>Map size
          <select id="mSize">
            <option value="120" selected>Small — 120×120</option>
            <option value="152">Medium — 152×152</option>
            <option value="184">Large — 184×184</option>
            <option value="216">Huge — 216×216</option>
            <option value="248">Giant — 248×248</option>
          </select>
        </label>
        <label>Starting age
          <select id="mAge">
            <option value="dark" selected>Dark Age</option>
            <option value="feudal">Feudal Age</option>
            <option value="castle">Castle Age</option>
            <option value="imperial">Post-Imperial</option>
          </select>
        </label>
        <label>Starting resources
          <select id="mRes">
            <option value="standard" selected>Standard</option>
            <option value="high">High</option>
            <option value="ultra">Ultra</option>
          </select>
        </label>
        <label>Population limit
          <select id="mPop">
            ${POP_LIMITS.map((n) =>
    `<option value="${n}"${n === 200 ? ' selected' : ''}>${n}</option>`).join('')}
          </select>
        </label>
        <label>Map seed
          <input id="mSeed" type="number" value="${Math.floor(Math.random() * 99999)}">
        </label>
      </div>

      <div id="civInfo" class="civinfo"></div>

      <div class="menu-actions">
        <button id="mStart">Start Game</button>
        <button id="mRandom">Random Civ</button>
      </div>
      <p class="hint" id="mHint">Left-drag to select · Right-click to command · F1 for the full guide</p>
    </div>`;

  const q = (id) => menu.querySelector('#' + id);
  const civSel = q('mCiv');
  const aiCivs = ['mCivA', 'mCivB', 'mCivC', 'mCivD'].map(q);
  // default the spectator civs to different ones so the first match is not a
  // mirror unless the viewer actually asks for one
  aiCivs.forEach((sel, i) => { sel.value = CIV_IDS[i % CIV_IDS.length]; });

  let spectate = false;
  const info = q('civInfo');
  const aiCount = () => parseInt(q('mAiCount').value, 10);

  /** Team index per AI, from the chosen layout. Equal indices are allies. */
  const teamsFor = (n, layout) => {
    if (layout === '2v2' && n === 4) return [0, 0, 1, 1];
    if (layout === '3v1' && n === 4) return [0, 0, 0, 1];
    if (layout === '2v1' && n === 3) return [0, 0, 1];
    return Array.from({ length: n }, (_, i) => i);   // free-for-all
  };

  const civBlock = (c, label) => `
      <h3>${label ? label + ': ' : ''}${c.name} <span class="dim">— ${c.focus} civilization</span></h3>
      <ul>${c.bonuses.map((b) => `<li>${b.desc}</li>`).join('')}</ul>
      <div class="civline"><b>Unique unit:</b> ${niceName(c.uu)}</div>
      ${c.ut1 ? `<div class="civline"><b>Castle tech:</b> ${c.ut1.name} — ${c.ut1.desc}</div>` : ''}
      ${c.ut2 ? `<div class="civline"><b>Imperial tech:</b> ${c.ut2.name} — ${c.ut2.desc}</div>` : ''}
      ${c.team ? `<div class="civline"><b>Team bonus:</b> ${c.team.desc}</div>` : ''}`;

  const PLAYER_NAMES = ['Blue', 'Red', 'Green', 'Yellow'];

  const renderInfo = () => {
    if (!spectate) { info.innerHTML = civBlock(CIVILIZATIONS[civSel.value]); return; }
    const n = aiCount();
    const teams = teamsFor(n, q('mTeams').value);
    // Allies share a team number, so say so rather than making the viewer
    // decode it from the colours once the match has started.
    const label = (i) => {
      const allies = teams.map((t, k) => (t === teams[i] && k !== i ? PLAYER_NAMES[k] : null))
        .filter(Boolean);
      return PLAYER_NAMES[i] + (allies.length ? ` (with ${allies.join(', ')})` : '');
    };
    info.innerHTML = `<div class="civpair civ${n}">` +
      aiCivs.slice(0, n)
        .map((sel, i) => `<div>${civBlock(CIVILIZATIONS[sel.value], label(i))}</div>`)
        .join('') + '</div>';
  };

  // Team layouts only make sense for certain player counts, so the ones that
  // do not fit are disabled rather than silently ignored.
  const syncTeamOptions = () => {
    const n = aiCount();
    const sel = q('mTeams');
    for (const opt of sel.options) {
      const ok = opt.value === 'ffa' ||
        (opt.value === '2v2' && n === 4) ||
        (opt.value === '3v1' && n === 4) ||
        (opt.value === '2v1' && n === 3);
      opt.disabled = !ok;
    }
    if (sel.selectedOptions[0]?.disabled) sel.value = 'ffa';
    for (const n2 of menu.querySelectorAll('.ai-slot')) {
      n2.classList.toggle('hidden', spectate ? Number(n2.dataset.slot) >= n : true);
    }
  };

  civSel.onchange = renderInfo;
  for (const sel of aiCivs) sel.onchange = renderInfo;
  q('mAiCount').onchange = () => { syncTeamOptions(); renderInfo(); };
  q('mTeams').onchange = renderInfo;

  const setMode = (watch) => {
    spectate = watch;
    q('mModePlay').classList.toggle('on', !watch);
    q('mModeWatch').classList.toggle('on', watch);
    for (const n of menu.querySelectorAll('.playonly')) n.classList.toggle('hidden', watch);
    for (const n of menu.querySelectorAll('.watchonly')) n.classList.toggle('hidden', !watch);
    q('mStart').textContent = watch ? 'Watch Match' : 'Start Game';
    q('mHint').textContent = watch
      ? 'You are a spectator — the AIs play themselves. Tab switches whose economy you are watching, ' +
        'Space pauses, and +/− changes the speed.'
      : 'Left-drag to select · Right-click to command · F1 for the full guide';
    syncTeamOptions();
    renderInfo();
  };
  q('mModePlay').onclick = () => setMode(false);
  q('mModeWatch').onclick = () => setMode(true);
  setMode(false);

  menu.querySelector('#mRandom').onclick = () => {
    const pick = () => CIV_IDS[Math.floor(Math.random() * CIV_IDS.length)];
    if (spectate) {
      const used = new Set();
      for (const sel of aiCivs.slice(0, aiCount())) {
        let v = pick();
        // distinct where possible, so a 4-way is four different civs
        for (let t = 0; t < 30 && used.has(v); t++) v = pick();
        used.add(v);
        sel.value = v;
      }
    } else {
      civSel.value = pick();
    }
    renderInfo();
  };
  menu.querySelector('#mStart').onclick = () => {
    const opts = {
      spectate,
      civ: civSel.value,
      civs: aiCivs.slice(0, aiCount()).map((s) => s.value),
      teams: teamsFor(aiCount(), q('mTeams').value),
      opponents: parseInt(menu.querySelector('#mOpp').value, 10),
      difficulty: menu.querySelector('#mDiff').value,
      mapType: menu.querySelector('#mMapType').value,
      size: parseInt(menu.querySelector('#mSize').value, 10),
      startAge: menu.querySelector('#mAge').value,
      startRes: menu.querySelector('#mRes').value,
      popMax: parseInt(menu.querySelector('#mPop').value, 10),
      seed: parseInt(menu.querySelector('#mSeed').value, 10) || 1,
    };
    menu.classList.add('hidden');
    onStart(opts);
  };
}

function fmtClock(t) {
  const s = Math.floor(t);
  return `${String((s / 60) | 0).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function niceName(id) {
  return id.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()).trim();
}

/* ================================================================
 *  Game bootstrap
 * ================================================================ */

const RES_PRESETS = {
  standard: { food: 200, wood: 200, gold: 100, stone: 200 },
  high: { food: 1000, wood: 1000, gold: 800, stone: 800 },
  ultra: { food: 20000, wood: 20000, gold: 20000, stone: 20000 },
};
const AGE_ORDER = ['dark', 'feudal', 'castle', 'imperial'];

async function startGame(THREE, opts, status) {
  status('Generating map...');
  const players = [];
  if (opts.spectate) {
    // Two to four AIs, nobody human. The viewer still "is" one of them for the
    // purposes of the HUD (whose resources are on the bar, whose units the
    // minimap highlights) and can switch with Tab.
    const names = ['Blue AI', 'Red AI', 'Green AI', 'Yellow AI'];
    const teams = opts.teams || opts.civs.map((_, i) => i);
    for (let i = 0; i < opts.civs.length; i++) {
      players.push({ civ: opts.civs[i], name: names[i], team: teams[i], popMax: opts.popMax });
    }
  } else {
    const civPool = CIV_IDS.filter((c) => c !== opts.civ);
    players.push({ civ: opts.civ, name: 'You', isHuman: true, team: 0, popMax: opts.popMax });
    for (let i = 0; i < opts.opponents; i++) {
      players.push({
        civ: civPool[Math.floor(Math.random() * civPool.length)],
        name: `AI ${i + 1}`,
        team: i + 1,
        popMax: opts.popMax,
      });
    }
  }

  const game = new Game({
    seed: opts.seed,
    mapSize: opts.size,
    players,
    speed: 1.7,
    mapType: opts.mapType,
    // A spectator has no side to be denied information, and watching black
    // fog-shrouded bases would defeat the point.
    revealAll: !!opts.spectate,
  });

  // apply starting-age / starting-resource options
  const preset = RES_PRESETS[opts.startRes];
  const targetAge = AGE_ORDER.indexOf(opts.startAge);
  for (const p of game.players) {
    for (const r in preset) p.res[r] = preset[r] + (p.mods.startResources[r] || 0);
    for (let a = 1; a <= targetAge; a++) {
      const techId = AGE_ORDER[a] + 'Age';
      game.completeResearch(p, techId);
    }
  }

  status('Building meshes...');
  const canvas = document.getElementById('game');
  const renderer = new Renderer(THREE, canvas, game);

  const ctx = { game, playerIndex: 0, renderer, canvas, spectator: !!opts.spectate, timeScale: 1 };
  const audio = new Audio();
  ctx.audio = audio;
  const input = new Input(ctx);
  ctx.input = input;
  const hud = new HUD(ctx);
  ctx.hud = hud;
  const overlay = new Overlay(ctx);
  ctx.effects = overlay;
  if (opts.spectate) {
    hud.buildSpectatorBar();
    renderer.setSpectator(true);
  }

  // Switching who we are watching has to move every consumer of playerIndex at
  // once - HUD, input and the fog the renderer draws - or the resource bar ends
  // up describing one player while the minimap highlights another.
  ctx.setViewPlayer = (i) => {
    if (i < 0 || i >= game.players.length || i === ctx.playerIndex) return;
    ctx.playerIndex = i;
    input.playerIndex = i;
    input.player = game.players[i];
    hud.playerIndex = i;
    hud.player = game.players[i];
    input.setSelection([]);
    hud.lastSelKey = '';
    const s = game.map.starts[i];
    if (s) renderer.centerOn(s.x, s.y);
  };

  const ais = [];
  const firstAI = opts.spectate ? 0 : 1;
  for (let i = firstAI; i < game.players.length; i++) ais.push(new AI(game, i, opts.difficulty));

  // start the camera on the player's town
  const start = game.map.starts[0];
  renderer.centerOn(start.x, start.y);
  if (!opts.spectate) {
    input.setSelection(game.entities.filter((e) =>
      e.alive && e.owner === 0 && e.kind === 'building' && e.type === 'townCenter').slice(0, 1));
  }

  window.addEventListener('resize', () => renderer.resize());
  const kickAudio = () => { audio.init(); audio.resume(); window.removeEventListener('pointerdown', kickAudio); };
  window.addEventListener('pointerdown', kickAudio);

  document.getElementById('loading').classList.add('hidden');
  document.getElementById('hud').classList.remove('hidden');

  /* ---- loop ---- */
  let last = performance.now();
  let acc = 0;
  let lastFogVersion = -1;
  let announced = false;

  function frame(now) {
    const dtReal = Math.min(0.1, (now - last) / 1000);
    last = now;
    const viewPlayer = game.players[ctx.playerIndex];
    // Fast-forward runs more fixed-size ticks per frame rather than making each
    // tick bigger: a 60-minute boom is not worth watching in real time, but
    // stretching the timestep would break movement and combat.
    const scale = ctx.timeScale;
    acc += dtReal * scale;
    const maxTicks = Math.max(1, Math.round(6 * Math.max(1, scale)));
    // At 16x a machine that cannot keep up would otherwise build a backlog it
    // can never drain, and the game would keep running fast long after the
    // speed was turned back down. Better to quietly drop the surplus and run at
    // whatever multiple the hardware actually manages.
    acc = Math.min(acc, TICK * maxTicks * 2);

    let ticks = 0;
    let simulated = 0;
    while (acc >= TICK && ticks < maxTicks) {
      game.update(TICK);
      acc -= TICK;
      ticks++;
      simulated += TICK;
    }
    if (scale === 0) acc = 0;
    for (const ai of ais) ai.update(simulated * game.speed);

    input.updateCamera(dtReal);

    if (game.tickCount !== lastFogVersion) {
      renderer.updateFogTexture(viewPlayer);
      lastFogVersion = game.tickCount;
    }

    renderer.render(viewPlayer, input.selection);
    overlay.draw(dtReal, input.selection, viewPlayer);
    hud.update(input.selection);
    audio.playEffects(game.effects);

    if (game.over && !announced) {
      announced = true;
      if (ctx.spectator) {
        const w = game.players[game.winner];
        audio.victory();
        hud.showGameOver(true, w
          ? `${w.name} (${w.civ.name}) wins after ${fmtClock(game.time)}.`
          : 'The match ended in a draw.');
      } else {
        const won = game.winner === 0;
        if (won) audio.victory(); else audio.defeat();
        hud.showGameOver(won, won
          ? 'Your enemies have been vanquished. The age is yours.'
          : 'Your civilization has fallen.');
      }
    }
    if (!ctx.spectator && viewPlayer.defeated && !announced) {
      announced = true;
      audio.defeat();
      hud.showGameOver(false, 'Your civilization has fallen.');
    }
    // A spectator whose side is wiped out should be moved to one still playing
    // rather than left staring at an empty corner of the map.
    if (ctx.spectator && viewPlayer.defeated && !game.over) {
      const alive = game.players.findIndex((p) => !p.defeated);
      if (alive >= 0) ctx.setViewPlayer(alive);
    }

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // expose for debugging from the console
  window.__game = game;
  window.__ctx = ctx;
}

/* ================================================================ */

function status(text) {
  const el = document.getElementById('loadtext');
  if (el) el.textContent = text;
}

async function main() {
  buildMenu(async (opts) => {
    document.getElementById('loading').classList.remove('hidden');
    try {
      const THREE = await loadThree(status);
      await startGame(THREE, opts, status);
    } catch (e) {
      console.error(e);
      status('Failed to start: ' + e.message);
    }
  });
  void PLAYER_COLORS;
}

main();
