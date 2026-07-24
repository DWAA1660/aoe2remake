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

      <div class="menu-grid">
        <label>Your civilization
          <select id="mCiv">${civOptions}</select>
        </label>
        <label>Opponents
          <select id="mOpp">
            <option value="1" selected>1</option>
            <option value="2">2</option>
            <option value="3">3</option>
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
            <option value="96">Small</option>
            <option value="120" selected>Medium</option>
            <option value="150">Large</option>
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
            <option value="75">75</option>
            <option value="125">125</option>
            <option value="200" selected>200</option>
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
      <p class="hint">Left-drag to select · Right-click to command · F1 for the full guide</p>
    </div>`;

  const civSel = menu.querySelector('#mCiv');
  const info = menu.querySelector('#civInfo');
  const renderInfo = () => {
    const c = CIVILIZATIONS[civSel.value];
    info.innerHTML = `
      <h3>${c.name} <span class="dim">— ${c.focus} civilization</span></h3>
      <ul>${c.bonuses.map((b) => `<li>${b.desc}</li>`).join('')}</ul>
      <div class="civline"><b>Unique unit:</b> ${niceName(c.uu)}</div>
      ${c.ut1 ? `<div class="civline"><b>Castle tech:</b> ${c.ut1.name} — ${c.ut1.desc}</div>` : ''}
      ${c.ut2 ? `<div class="civline"><b>Imperial tech:</b> ${c.ut2.name} — ${c.ut2.desc}</div>` : ''}
      ${c.team ? `<div class="civline"><b>Team bonus:</b> ${c.team.desc}</div>` : ''}`;
  };
  civSel.onchange = renderInfo;
  renderInfo();

  menu.querySelector('#mRandom').onclick = () => {
    civSel.value = CIV_IDS[Math.floor(Math.random() * CIV_IDS.length)];
    renderInfo();
  };
  menu.querySelector('#mStart').onclick = () => {
    const opts = {
      civ: civSel.value,
      opponents: parseInt(menu.querySelector('#mOpp').value, 10),
      difficulty: menu.querySelector('#mDiff').value,
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
  const civPool = CIV_IDS.filter((c) => c !== opts.civ);
  const players = [{ civ: opts.civ, name: 'You', isHuman: true, team: 0, popMax: opts.popMax }];
  for (let i = 0; i < opts.opponents; i++) {
    players.push({
      civ: civPool[Math.floor(Math.random() * civPool.length)],
      name: `AI ${i + 1}`,
      team: i + 1,
      popMax: opts.popMax,
    });
  }

  const game = new Game({
    seed: opts.seed,
    mapSize: opts.size,
    players,
    speed: 1.7,
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

  const ctx = { game, playerIndex: 0, renderer, canvas };
  const audio = new Audio();
  ctx.audio = audio;
  const input = new Input(ctx);
  ctx.input = input;
  const hud = new HUD(ctx);
  ctx.hud = hud;
  const overlay = new Overlay(ctx);
  ctx.effects = overlay;

  const ais = [];
  for (let i = 1; i < game.players.length; i++) ais.push(new AI(game, i, opts.difficulty));

  // start the camera on the player's town
  const start = game.map.starts[0];
  renderer.centerOn(start.x, start.y);
  input.setSelection(game.entities.filter((e) =>
    e.alive && e.owner === 0 && e.kind === 'building' && e.type === 'townCenter').slice(0, 1));

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
  const viewPlayer = game.players[0];

  function frame(now) {
    const dtReal = Math.min(0.1, (now - last) / 1000);
    last = now;
    acc += dtReal;

    let ticks = 0;
    while (acc >= TICK && ticks < 6) {
      game.update(TICK);
      acc -= TICK;
      ticks++;
    }
    for (const ai of ais) ai.update(dtReal);

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
      const won = game.winner === 0;
      if (won) audio.victory(); else audio.defeat();
      hud.showGameOver(won, won
        ? 'Your enemies have been vanquished. The age is yours.'
        : 'Your civilization has fallen.');
    }
    if (viewPlayer.defeated && !announced) {
      announced = true;
      audio.defeat();
      hud.showGameOver(false, 'Your civilization has fallen.');
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
