// The in-game HUD: resource bar, minimap, selection panel, command card,
// notifications and the tech tree. Plain DOM so text stays crisp over the
// deliberately low-resolution 3D scene.

import { icon, unitIcon, buildingIcon, techIcon, resIcon } from './icons.js';
import { TECHS } from '../data/techs.js';
import { BUILD_MENU, BUILDINGS } from '../data/buildings.js';
import { AGE_NAMES } from '../sim/player.js';
import { PLAYER_COLORS } from '../render/renderer.js';
import { ARMOR_CLASSES } from '../data/armor.js';
import { UNITS } from '../data/units.js';
import { CIVILIZATIONS } from '../data/civs.js';
import { RESOURCE_INFO } from '../sim/entity.js';

const RESOURCE_ICONS = {
  tree: 'wood', gold: 'goldRes', stone: 'stoneRes', berries: 'food',
  fish: 'food', carcass: 'food', relic: 'relic', farm: 'farm',
};

const ECO_BUILDINGS = ['house', 'mill', 'lumberCamp', 'miningCamp', 'farm', 'dock', 'market',
  'townCenter', 'monastery', 'university', 'wonder', 'feitoria', 'caravanserai'];
const MIL_BUILDINGS = ['barracks', 'archeryRange', 'stable', 'blacksmith', 'siegeWorkshop', 'castle',
  'outpost', 'watchTower', 'bombardTower', 'palisadeWall', 'stoneWall', 'gate', 'donjon', 'krepost'];

export class HUD {
  constructor(ctx) {
    this.ctx = ctx;
    this.game = ctx.game;
    this.playerIndex = ctx.playerIndex;
    this.player = ctx.game.players[ctx.playerIndex];
    this.cardMode = 'default';
    this.tooltipEl = null;
    this.lastSelKey = '';
    this.build();
  }

  /* ================================================================ */

  build() {
    const root = document.getElementById('hud');
    root.innerHTML = '';

    /* ---- top resource bar ---- */
    this.topBar = el('div', 'topbar');
    this.resEls = {};
    this.workerEls = {};
    for (const r of ['food', 'wood', 'gold', 'stone']) {
      const box = el('div', 'resbox');
      box.appendChild(imgIcon(resIcon(r), 20));
      const v = el('span', 'resval'); v.textContent = '0';
      box.appendChild(v);
      // villagers currently assigned to this resource, as AoE2:DE shows
      const w = el('span', 'resworkers'); w.textContent = '';
      box.appendChild(w);
      this.resEls[r] = v;
      this.workerEls[r] = w;
      this.topBar.appendChild(box);
      this.tip(box, () => `<b>${cap(r)}</b><br>Stockpiled ${cap(r)}.` +
        `<br><span class="dim">Small number = villagers gathering it.</span>`);
    }

    // idle villager counter - click to jump to the next one
    this.idleBox = el('div', 'resbox idlebox');
    this.idleBox.appendChild(imgIcon('villager', 20));
    this.idleEl = el('span', 'resval'); this.idleEl.textContent = '0';
    this.idleBox.appendChild(this.idleEl);
    this.idleBox.onclick = (ev) => {
      if (ev.shiftKey) this.ctx.input.selectAllIdle('villager');
      else this.ctx.input._cycleIdle('villager');
    };
    this.topBar.appendChild(this.idleBox);
    this.tip(this.idleBox, 'Idle villagers.<br><b>Click</b> select the next one <b>[.]</b>' +
      '<br><b>Shift + click</b> select <i>every</i> idle villager, ready to be given a job');
    const popBox = el('div', 'resbox');
    popBox.appendChild(imgIcon('pop', 20));
    this.popEl = el('span', 'resval'); this.popEl.textContent = '0/0';
    popBox.appendChild(this.popEl);
    this.topBar.appendChild(popBox);
    this.tip(popBox, () => 'Population / housing limit. Build Houses to raise it.');

    this.ageEl = el('div', 'agebox');
    this.topBar.appendChild(this.ageEl);

    const spacer = el('div', 'spacer');
    this.topBar.appendChild(spacer);

    this.civEl = el('div', 'civbox');
    this.topBar.appendChild(this.civEl);

    this.timeEl = el('div', 'timebox');
    this.topBar.appendChild(this.timeEl);

    const btnTech = el('button', 'topbtn', 'Tech Tree');
    btnTech.onclick = () => this.toggleTechTree();
    this.topBar.appendChild(btnTech);

    const btnHelp = el('button', 'topbtn', 'Help');
    btnHelp.onclick = () => this.toggleHelp();
    this.topBar.appendChild(btnHelp);

    const btnMenu = el('button', 'topbtn', 'Menu');
    btnMenu.onclick = () => this.toggleMenu();
    this.topBar.appendChild(btnMenu);

    root.appendChild(this.topBar);

    /* ---- notifications ---- */
    this.notifyEl = el('div', 'notifications');
    root.appendChild(this.notifyEl);

    /* ---- bottom panel ---- */
    this.bottom = el('div', 'bottom');

    // minimap
    const mmWrap = el('div', 'minimap-wrap');
    this.minimap = document.createElement('canvas');
    this.minimap.width = 220; this.minimap.height = 220;
    this.minimap.className = 'minimap';
    mmWrap.appendChild(this.minimap);
    this.bottom.appendChild(mmWrap);

    // selection panel
    this.selPanel = el('div', 'selpanel');
    this.bottom.appendChild(this.selPanel);

    // command card
    this.card = el('div', 'card');
    this.bottom.appendChild(this.card);

    root.appendChild(this.bottom);

    /* ---- modals ---- */
    this.modal = el('div', 'modal hidden');
    root.appendChild(this.modal);

    /* ---- tooltip ---- */
    this.tooltipEl = el('div', 'tooltip hidden');
    root.appendChild(this.tooltipEl);

    this.minimap.addEventListener('mousedown', (e) => this._minimapClick(e));
    this.minimap.addEventListener('mousemove', (e) => { if (e.buttons & 1) this._minimapClick(e); });

    // tell the renderer how much of the canvas the HUD hides
    const applyInsets = () => this.ctx.renderer.setViewportInsets(
      this.topBar.offsetHeight, this.bottom.offsetHeight);
    applyInsets();
    window.addEventListener('resize', applyInsets);

    this.mmCtx = this.minimap.getContext('2d');
    this.mmTerrain = document.createElement('canvas');
    this.mmTerrain.width = this.game.size;
    this.mmTerrain.height = this.game.size;
    this._paintMinimapTerrain();
  }

  tip(node, fn) {
    node.addEventListener('mouseenter', () => {
      this.tooltipEl.innerHTML = typeof fn === 'function' ? fn() : fn;
      this.tooltipEl.classList.remove('hidden');
    });
    node.addEventListener('mousemove', (e) => {
      const t = this.tooltipEl;
      const w = t.offsetWidth, h = t.offsetHeight;
      t.style.left = Math.min(window.innerWidth - w - 8, e.clientX + 14) + 'px';
      t.style.top = Math.max(4, e.clientY - h - 14) + 'px';
    });
    node.addEventListener('mouseleave', () => this.tooltipEl.classList.add('hidden'));
  }

  /* ================================================================
   *  Per-frame update
   * ================================================================ */

  update(selection) {
    const p = this.player;
    for (const r of ['food', 'wood', 'gold', 'stone']) {
      this.resEls[r].textContent = Math.floor(p.res[r]);
    }
    this.popEl.textContent = `${Math.floor(p.pop)}/${p.effectivePopCap}`;
    this.popEl.style.color = p.pop >= p.effectivePopCap ? '#ff8080' : '';
    this.ageEl.textContent = AGE_NAMES[p.age];
    this.civEl.textContent = `${p.civ.name} — ${p.name}`;
    this.civEl.style.color = '#' + PLAYER_COLORS[this.playerIndex % PLAYER_COLORS.length].toString(16).padStart(6, '0');
    const t = Math.floor(this.game.time);
    this.timeEl.textContent = `${String((t / 60) | 0).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;

    this._frame = (this._frame || 0) + 1;
    if (this._frame % 10 === 0) this._updateWorkerCounts();

    this._updateNotifications();
    this._updateSelection(selection);
    this._updateCard(selection);
    this._drawMinimap();
    if (this.specBar && this._frame % 10 === 0) this._updateSpectatorBar();
  }

  /* ================================================================
   *  Spectator
   * ================================================================ */

  buildSpectatorBar() {
    const root = document.getElementById('hud');
    this.specBar = el('div', 'specbar');

    const controls = el('div', 'specctl');
    this.specPause = el('button', 'topbtn', 'Pause');
    this.specPause.onclick = () => {
      const c = this.ctx;
      c.timeScale = c.timeScale === 0 ? (c.lastScale || 1) : 0;
      if (c.timeScale !== 0) c.lastScale = c.timeScale;
    };
    controls.appendChild(this.specPause);
    for (const s of [1, 2, 4, 8]) {
      const b = el('button', 'topbtn spd', s + '×');
      b.onclick = () => { this.ctx.timeScale = s; this.ctx.lastScale = s; };
      b.dataset.speed = String(s);
      controls.appendChild(b);
    }
    this.specSpeedBtns = [...controls.querySelectorAll('.spd')];
    this.specBar.appendChild(controls);

    // one card per player: click it to watch that economy
    this.specCards = this.game.players.map((p, i) => {
      const card = el('div', 'speccard');
      card.style.borderColor = '#' +
        PLAYER_COLORS[i % PLAYER_COLORS.length].toString(16).padStart(6, '0');
      card.onclick = () => this.ctx.setViewPlayer?.(i);
      card.innerHTML = `<div class="specname">${p.name} — ${p.civ.name}</div><div class="specstats"></div>`;
      this.specBar.appendChild(card);
      return card;
    });

    root.appendChild(this.specBar);
    this._updateSpectatorBar();
  }

  _updateSpectatorBar() {
    // Counting entities every frame is wasted work for a panel that only needs
    // to feel live, so this runs on the same 10-frame cadence as the worker
    // counts and walks the entity list once for all players.
    const stats = this.game.players.map(() => ({ vill: 0, army: 0, bld: 0, idle: 0 }));
    for (const e of this.game.entities) {
      if (!e.alive) continue;
      const s = stats[e.owner];
      if (!s) continue;
      if (e.kind === 'building') { if (e.complete) s.bld++; continue; }
      if (e.kind !== 'unit') continue;
      if (e.def.cat === 'villager') {
        s.vill++;
        if (e.task.type === 'idle') s.idle++;
      } else if (['infantry', 'cavalry', 'archer', 'siege', 'monk'].includes(e.def.cat)) s.army++;
    }

    for (let i = 0; i < this.specCards.length; i++) {
      const p = this.game.players[i], s = stats[i];
      const watching = i === this.playerIndex;
      this.specCards[i].classList.toggle('watching', watching);
      this.specCards[i].classList.toggle('dead', p.defeated);
      this.specCards[i].querySelector('.specstats').innerHTML =
        `<span>${AGE_NAMES[p.age]}</span>` +
        `<span>${s.vill} vill${s.idle ? ` <b class="warn">(${s.idle} idle)</b>` : ''}</span>` +
        `<span>${s.army} army</span>` +
        `<span>${s.bld} bldg</span>` +
        `<span class="dim">${Math.round(p.stats.resourcesGathered)} gathered</span>`;
    }

    const c = this.ctx;
    this.specPause.textContent = c.timeScale === 0 ? 'Resume' : 'Pause';
    for (const b of this.specSpeedBtns) {
      b.classList.toggle('on', c.timeScale === Number(b.dataset.speed));
    }
  }

  /** Villagers per resource + idle count, for the AoE2-style top bar. */
  _updateWorkerCounts() {
    const counts = { food: 0, wood: 0, gold: 0, stone: 0 };
    let idle = 0;
    for (const e of this.game.entities) {
      if (!e.alive || e.kind !== 'unit' || e.owner !== this.playerIndex) continue;
      if (e.def.cat !== 'villager' || e.garrisonedIn) continue;
      const t = e.task;
      if (t.type === 'idle') { idle++; continue; }
      if ((t.type === 'gather' || t.type === 'deliver') && counts[t.resType] !== undefined) {
        counts[t.resType]++;
      }
    }
    for (const r in counts) this.workerEls[r].textContent = counts[r] ? String(counts[r]) : '';
    this.idleEl.textContent = String(idle);
    this.idleBox.classList.toggle('has-idle', idle > 0);
  }

  _updateNotifications() {
    const list = this.player.notifications;
    const html = list.slice(-4).map((n) => `<div class="note" style="opacity:${Math.max(0.15, 1 - n.t / 8).toFixed(2)}">${n.text}</div>`).join('');
    if (html !== this._lastNotes) { this.notifyEl.innerHTML = html; this._lastNotes = html; }
  }

  /* ---------------- selection panel ---------------- */

  _updateSelection(sel) {
    // Cache key must include everything the panel displays. Resources have no
    // `hp`, so keying on it alone produced NaN and the panel never refreshed —
    // a selected tree or gold pile showed a frozen amount while it was mined.
    const key = sel.map((e) => [
      e.id,
      Math.round(e.hp ?? -1),
      Math.round(e.amount ?? -1),
      Math.round(e.farmFood ?? -1),
      Math.round(e.carrying?.amount ?? -1),
      e.gatherers ?? -1,
      e.queue ? e.queue.length : -1,
      e.orders ? e.orders.length : -1,
      e.task ? e.task.type : '',
    ].join(':')).join(',');
    if (key === this.lastSelKey) return;
    this.lastSelKey = key;
    this.selPanel.innerHTML = '';
    if (!sel.length) {
      this.selPanel.innerHTML = '<div class="sel-empty">Select units or buildings.<br><span class="dim">' +
        'Left-drag to box-select · Right-click to command · H = Town Center · . = idle villager</span></div>';
      return;
    }

    if (sel.length === 1) {
      this._renderSingle(sel[0]);
    } else {
      const grid = el('div', 'sel-grid');
      const counts = new Map();
      for (const e of sel) {
        const k = e.type;
        if (!counts.has(k)) counts.set(k, []);
        counts.get(k).push(e);
      }
      for (const [type, ents] of counts) {
        for (const e of ents.slice(0, 12)) {
          const b = el('div', 'sel-chip');
          b.appendChild(imgIcon(e.kind === 'building' ? buildingIcon(type) : unitIcon(e.def), 30));
          const hp = el('div', 'chip-hp');
          const bar = el('div', 'chip-hp-fill');
          bar.style.width = Math.max(0, (e.hp / e.maxHp) * 100) + '%';
          bar.style.background = e.hp / e.maxHp > 0.6 ? '#4ad04a' : e.hp / e.maxHp > 0.3 ? '#e0c02a' : '#e04a3a';
          hp.appendChild(bar);
          b.appendChild(hp);
          b.onclick = (ev) => {
            ev.stopPropagation();
            this.ctx.input.setSelection([e]);
          };
          this.tip(b, () => this._unitTooltip(e.def));
          grid.appendChild(b);
        }
        if (ents.length > 12) {
          const more = el('div', 'sel-chip more', `+${ents.length - 12}`);
          grid.appendChild(more);
        }
      }
      this.selPanel.appendChild(grid);
      const summary = el('div', 'sel-summary',
        [...counts].map(([t, a]) => `${a.length}× ${a[0].def.name}`).join(', '));
      this.selPanel.appendChild(summary);
    }
  }

  _renderSingle(e) {
    // Resource nodes are not units or buildings and carry no `def`; they need
    // their own panel rather than falling through the unit path, which reads
    // def.id / def.name / def.atk and throws.
    if (e.kind === 'resource') return this._renderResource(e);

    const wrap = el('div', 'sel-single');
    const port = el('div', 'portrait');
    port.appendChild(imgIcon(e.kind === 'building' ? buildingIcon(e.type) : unitIcon(e.def), 56));
    wrap.appendChild(port);

    const info = el('div', 'sel-info');
    info.appendChild(el('div', 'sel-name', e.def.name));
    const owner = this.game.players[e.owner];
    if (owner) info.appendChild(el('div', 'sel-owner', owner.name + ' · ' + owner.civ.name));

    const hpRow = el('div', 'sel-hp');
    const bar = el('div', 'hpbar');
    const fill = el('div', 'hpfill');
    fill.style.width = Math.max(0, (e.hp / e.maxHp) * 100) + '%';
    bar.appendChild(fill);
    hpRow.appendChild(bar);
    hpRow.appendChild(el('span', 'hptext', `${Math.ceil(e.hp)} / ${e.maxHp}`));
    info.appendChild(hpRow);

    // stat line
    const d = e.def;
    const stats = [];
    const atkParts = Object.entries(d.atk || {}).filter(([, v]) => v > 0);
    const base = atkParts.find(([k]) => k === 'melee' || k === 'pierce');
    if (base) stats.push(`⚔ ${base[1]} ${base[0]}`);
    stats.push(`🛡 ${d.armor.melee}/${d.armor.pierce}`);
    if (d.range) stats.push(`◎ ${d.range}`);
    if (d.speed && e.kind === 'unit') stats.push(`» ${d.speed.toFixed(2)}`);
    if (d.los) stats.push(`👁 ${d.los}`);
    info.appendChild(el('div', 'sel-stats', stats.join('   ')));

    // bonus damage - the whole point of the counter system, so show it plainly
    const bonuses = atkParts.filter(([k]) => k !== 'melee' && k !== 'pierce');
    if (bonuses.length) {
      info.appendChild(el('div', 'sel-bonus',
        'Bonus: ' + bonuses.map(([k, v]) => `+${v} vs ${ARMOR_CLASSES[k] || k}`).join(', ')));
    }
    const classes = (d.classes || []).map((c) => ARMOR_CLASSES[c] || c).join(', ');
    if (classes) info.appendChild(el('div', 'sel-classes', 'Armor classes: ' + classes));

    // Villager inventory: always shown, so you can see how full a gatherer is
    // and what it is hauling without waiting for it to reach a drop site.
    if (e.kind === 'unit' && (e.def.cat === 'villager' || e.def.cat === 'naval')) {
      const capAmt = this.game.carryCapacity(this.game.players[e.owner] || this.player);
      const carried = e.carrying ? e.carrying.amount : 0;
      const res = carried > 0.01 ? e.carrying.res : null;
      const row = el('div', 'sel-carry-row');
      row.appendChild(imgIcon(res ? resIcon(res) : 'villager', 16));
      const label = el('span', 'carrytext',
        res ? `${Math.floor(carried)} / ${capAmt} ${cap(res)}` : `Empty (holds ${capAmt})`);
      row.appendChild(label);
      const bar = el('div', 'carrybar');
      const fill = el('div', 'carryfill');
      fill.style.width = Math.min(100, (carried / capAmt) * 100) + '%';
      fill.style.background = res
        ? { food: '#e0695a', wood: '#b98040', gold: '#e0bc3c', stone: '#b8b8b0' }[res]
        : '#666';
      bar.appendChild(fill);
      row.appendChild(bar);
      info.appendChild(row);
    } else if (e.kind === 'unit' && e.carrying && e.carrying.amount > 0.5) {
      info.appendChild(el('div', 'sel-carry',
        `Carrying ${Math.floor(e.carrying.amount)} ${e.carrying.res}`));
    }
    if (e.kind === 'unit' && e.orders && e.orders.length) {
      info.appendChild(el('div', 'sel-task', `${e.orders.length} queued order${e.orders.length > 1 ? 's' : ''}`));
    }
    if (e.kind === 'unit' && e.task && e.task.type !== 'idle') {
      info.appendChild(el('div', 'sel-task', 'Task: ' + e.task.type));
    }
    if (e.kind === 'building' && !e.complete) {
      info.appendChild(el('div', 'sel-task',
        `Under construction ${Math.floor((e.buildProgress / e.def.time) * 100)}%`));
    }
    if (e.kind === 'building' && e.garrison?.length) {
      info.appendChild(el('div', 'sel-task', `Garrison ${e.garrison.length}/${e.def.garrison}`));
    }
    if (e.kind === 'building' && e.def.farmFood) {
      info.appendChild(el('div', 'sel-task', `Food remaining ${Math.floor(e.farmFood)}`));
    }
    // Live resource readout: how much is left, and who is working it.
    if (e.kind === 'resource') {
      info.appendChild(this._resourceBar(e.resType, e.amount, e.maxAmount));
      const workers = this._gatherersOn(e.id);
      info.appendChild(el('div', 'sel-task',
        workers ? `${workers} gatherer${workers > 1 ? 's' : ''} working this` : 'Nobody gathering'));
    }
    // Huntable animals carry their food yield; a killed one leaves a carcass
    // that depletes as it is butchered.
    if (e.kind === 'unit' && e.def.huntable) {
      info.appendChild(this._resourceBar('food', e.def.food || 0, e.def.food || 1));
      const workers = this._gatherersOn(e.id);
      info.appendChild(el('div', 'sel-task',
        workers ? `${workers} hunting this` : 'Not being hunted'));
    }
    if (e.kind === 'building' && e.def.farmFood) {
      info.appendChild(this._resourceBar('food', e.farmFood, e.farmMax || e.def.farmFood));
      const workers = this._gatherersOn(e.id);
      info.appendChild(el('div', 'sel-task',
        workers ? `${workers} farming this` : 'Nobody farming this plot'));
      if (e.owner === this.playerIndex) {
        const cost = this.player.mods.building('farm').cost.wood;
        info.appendChild(el('div', 'sel-classes', this.player.autoReseed
          ? `Auto-reseed ON — costs ${cost} wood when exhausted`
          : 'Auto-reseed OFF — plot will be lost when exhausted'));
      }
    }
    wrap.appendChild(info);

    // production queue
    if (e.kind === 'building' && e.queue?.length) {
      const q = el('div', 'queue');
      e.queue.forEach((item, i) => {
        const b = el('div', 'qitem');
        const ic = item.kind === 'unit'
          ? unitIcon(this.player.mods.unit(item.id))
          : techIcon(TECHS[item.id]);
        b.appendChild(imgIcon(ic, 26));
        if (i === 0) {
          const prog = el('div', 'qprog');
          const pf = el('div', 'qprogfill');
          pf.style.width = `${(1 - item.timeLeft / item.total) * 100}%`;
          prog.appendChild(pf);
          b.appendChild(prog);
        }
        if (item.blocked === 'pop') b.classList.add('blocked');
        b.onclick = () => this.game.cancelQueueItem(e, i);
        this.tip(b, `${item.name}<br><span class="dim">Click to cancel</span>`);
        q.appendChild(b);
      });
      wrap.appendChild(q);
    }
    this.selPanel.appendChild(wrap);
  }

  /** Selection panel for a resource node (tree, mine, bush, relic, carcass). */
  _renderResource(e) {
    const wrap = el('div', 'sel-single');
    const port = el('div', 'portrait');
    port.appendChild(imgIcon(RESOURCE_ICONS[e.type] || resIcon(e.resType), 56));
    wrap.appendChild(port);

    const info = el('div', 'sel-info');
    info.appendChild(el('div', 'sel-name', RESOURCE_INFO[e.type]?.label || cap(e.type)));
    info.appendChild(el('div', 'sel-owner', 'Natural resource'));

    if (e.type === 'relic') {
      info.appendChild(el('div', 'sel-stats', 'Carry to a Monastery for a steady gold income.'));
    } else {
      info.appendChild(this._resourceBar(e.resType, e.amount, e.maxAmount));
      const workers = this._gatherersOn(e.id);
      info.appendChild(el('div', 'sel-task',
        workers ? `${workers} gatherer${workers > 1 ? 's' : ''} working this` : 'Nobody gathering'));
      const pct = e.maxAmount ? Math.round((e.amount / e.maxAmount) * 100) : 0;
      info.appendChild(el('div', 'sel-classes', `${pct}% remaining`));
    }
    wrap.appendChild(info);
    this.selPanel.appendChild(wrap);
  }

  /** A labelled depletion bar, e.g. "168 / 200 Wood remaining". */
  _resourceBar(res, amount, max) {
    const row = el('div', 'sel-carry-row');
    row.appendChild(imgIcon(resIcon(res), 16));
    row.appendChild(el('span', 'carrytext',
      `${Math.ceil(amount)} / ${Math.round(max)} ${cap(res)}`));
    const bar = el('div', 'carrybar');
    const fill = el('div', 'carryfill');
    fill.style.width = Math.max(0, Math.min(100, (amount / (max || 1)) * 100)) + '%';
    fill.style.background = { food: '#e0695a', wood: '#b98040', gold: '#e0bc3c', stone: '#b8b8b0' }[res] || '#888';
    bar.appendChild(fill);
    row.appendChild(bar);
    return row;
  }

  /** How many of the player's villagers are currently working a given target. */
  _gatherersOn(id) {
    let n = 0;
    for (const e of this.game.entities) {
      if (!e.alive || e.kind !== 'unit' || e.owner !== this.playerIndex) continue;
      const t = e.task;
      if ((t.type === 'gather' && t.targetId === id) ||
          (t.type === 'deliver' && t.returnTo === id)) n++;
    }
    return n;
  }

  /* ---------------- command card ---------------- */

  _updateCard(sel) {
    const key = this.cardMode + '|' + sel.map((e) => e.id).join(',') + '|' +
      this.player.age + '|' + Math.floor(this.player.res.food / 25) + '|' +
      Math.floor(this.player.res.wood / 25) + '|' + Math.floor(this.player.res.gold / 25) +
      '|' + Math.floor(this.player.res.stone / 25) + '|' + this.player.researched.size;
    if (key === this._cardKey) return;
    this._cardKey = key;
    this.card.innerHTML = '';

    // A spectator inspects; they do not command. Every button on this card
    // trains, researches or places something, so the whole card goes away
    // rather than showing controls that quietly do nothing.
    if (this.ctx.spectator) return;

    const mine = sel.filter((e) => e.owner === this.playerIndex);
    if (!mine.length) return;

    const buttons = [];
    const villagers = mine.filter((e) => e.kind === 'unit' && e.def.cat === 'villager');
    const units = mine.filter((e) => e.kind === 'unit');
    const buildings = mine.filter((e) => e.kind === 'building');

    if (this.cardMode === 'buildEco' || this.cardMode === 'buildMil') {
      const allowed = new Set(BUILD_MENU[this.player.age] || []);
      const list = (this.cardMode === 'buildEco' ? ECO_BUILDINGS : MIL_BUILDINGS)
        .filter((b) => allowed.has(b) || (BUILDINGS[b]?.unique === this.player.civId));
      for (const bId of list) {
        if (!this.player.isBuildingAvailable(bId)) continue;
        const def = this.player.mods.building(bId);
        buttons.push(this._btn(buildingIcon(bId), def.name, () => {
          this.ctx.input.startPlacement(bId);
        }, () => this._buildingTooltip(def), !this.player.canAfford(def.cost)));
      }
      buttons.push(this._btn('stop', 'Back', () => { this.cardMode = 'default'; this._cardKey = ''; }));
      this._renderButtons(buttons);
      return;
    }

    if (villagers.length) {
      buttons.push(this._btn('house', 'Economic Buildings', () => { this.cardMode = 'buildEco'; this._cardKey = ''; },
        'Economy buildings — houses, farms, drop sites, markets. <b>[B]</b>'));
      buttons.push(this._btn('barracks', 'Military Buildings', () => { this.cardMode = 'buildMil'; this._cardKey = ''; },
        'Military buildings, defences and walls. <b>[V]</b>'));
      buttons.push(this._btn('repair', 'Repair', () => this.ctx.input.setCursorMode('repair'),
        'Repair a damaged building or siege weapon.'));
    }

    if (units.length) {
      buttons.push(this._btn('move', 'Move', () => this.ctx.input.setCursorMode('move'), 'Move here.'));
      buttons.push(this._btn('attack', 'Attack Move', () => this.ctx.input.setCursorMode('attackMove'),
        'Advance to a point, engaging anything on the way. <b>[A]</b>'));
      buttons.push(this._btn('move', 'Patrol', () => this.ctx.input.setCursorMode('patrol'),
        'Walk back and forth between here and the clicked point, attacking enemies met on the way. <b>[P]</b>'));
      buttons.push(this._btn('stance', 'Hold Position', () => {
        this.game.commandStop(units);
        for (const u of units) u.stance = 'standGround';
      }, 'Stop and never chase — only strike enemies that come into range. <b>[H]</b>'));
      buttons.push(this._btn('stop', 'Stop', () => this.game.commandStop(units),
        'Cancel the current action and clear the whole order queue. <b>[S]</b>'));
      buttons.push(this._btn('garrison', 'Garrison', () => this.ctx.input.setCursorMode('garrison'),
        'Garrison inside a building or siege unit. <b>[G]</b>'));
      const monks = units.filter((u) => u.def.converts);
      if (monks.length) {
        buttons.push(this._btn('heal', 'Heal', () => this.ctx.input.setCursorMode('heal'), 'Heal a friendly unit.'));
        buttons.push(this._btn('relic', 'Collect Relic', () => this.ctx.input.setCursorMode('relic'),
          'Pick up a Relic and carry it to a Monastery for a steady gold income.'));
      }
      const traders = units.filter((u) => u.def.cat === 'trade');
      if (traders.length) {
        buttons.push(this._btn('trade', 'Trade', () => this.ctx.input.setCursorMode('trade'),
          'Trade with an allied or enemy Market for gold.'));
      }
      // stances
      const stances = [['aggressive', 'Aggressive'], ['defensive', 'Defensive'],
        ['standGround', 'Stand Ground'], ['noAttack', 'No Attack']];
      for (const [id, label] of stances) {
        buttons.push(this._btn('stance', label, () => { for (const u of units) u.stance = id; },
          `Set stance: <b>${label}</b>.<br>Aggressive chases, Defensive holds nearby, Stand Ground never moves, No Attack never fights.`));
      }
      buttons.push(this._btn('del', 'Delete', () => { for (const u of units) this.game.kill(u, null); },
        'Delete the selected units. <b>[Delete]</b>'));
    }

    if (buildings.length) {
      const b = buildings[0];
      const same = buildings.filter((x) => x.type === b.type);
      if (b.complete) {
        const trains = [...b.def.trains];
        if (b.type === 'castle' || b.type === 'krepost' || b.type === 'donjon') {
          const civ = this.player.civ;
          if (b.type === 'castle') trains.unshift(civ.uuElite && this.player.mods.unitUpgrades.get(civ.uu) ? civ.uuElite : civ.uu);
        }
        for (const ex of this.player.mods.extraTrainers) {
          if (ex.building === b.type) trains.push(ex.unit);
        }
        // Every selected building that can make this unit shares the batch, so
        // a control group of Stables/Ranges fills up in parallel.
        for (const uId of dedupe(trains)) {
          if (!this.player.isUnitAvailable(uId)) continue;
          const def = this.player.mods.unit(uId);
          const able = buildings.filter((x) => this.game.canTrainAt(x, uId));
          const pool = able.length ? able : same;
          buttons.push(this._btn(unitIcon(def), def.name, (ev) => {
            const n = ev && ev.shiftKey ? 5 : 1;
            const r = this.game.queueUnitSpread(pool, uId, n);
            if (r.queued > 1) {
              this.player.notify(`Queued ${r.queued} ${def.name} across ${r.spread.length} building${r.spread.length > 1 ? 's' : ''}`);
            }
            this._cardKey = '';
          }, () => this._unitTooltip(def, true) +
             (pool.length > 1
               ? `<div class="thint">${pool.length} buildings selected — orders go to whichever can start soonest.</div>`
               : '') +
             `<div class="dim">Shift-click to queue 5.</div>`,
          !this.player.canAfford(def.cost)));
        }
        for (const tId of b.def.researches) {
          if (!this.player.isTechAvailable(tId)) continue;
          const t = TECHS[tId];
          const cost = this.player.mods.techCost(t);
          buttons.push(this._btn(techIcon(t), t.name, () => {
            for (const bb of same) { if (this.game.queueTech(bb, tId)) break; }
          }, () => this._techTooltip(t, cost), !this.player.canAfford(cost)));
        }
        // civ unique techs at the castle
        if (b.type === 'castle') {
          for (const ut of [this.player.civ.ut1, this.player.civ.ut2]) {
            if (!ut || !this.player.isTechAvailable(ut.id)) continue;
            const t = TECHS[ut.id];
            const cost = this.player.mods.techCost(t);
            buttons.push(this._btn('shield', t.name, () => {
              for (const bb of same) { if (this.game.queueTech(bb, ut.id)) break; }
            }, () => this._techTooltip(t, cost, true), !this.player.canAfford(cost)));
          }
          const eliteId = 'elite_' + this.player.civId;
          if (this.player.isTechAvailable(eliteId)) {
            const t = TECHS[eliteId];
            const cost = this.player.mods.techCost(t);
            buttons.push(this._btn('arrowUp', t.name, () => {
              for (const bb of same) { if (this.game.queueTech(bb, eliteId)) break; }
            }, () => this._techTooltip(t, cost), !this.player.canAfford(cost)));
          }
        }
        if (b.def.upgradeTo && this.player.isBuildingAvailable(b.def.upgradeTo)) { /* handled via university techs */ }
        if (b.garrison?.length) {
          buttons.push(this._btn('ungarrison', 'Ungarrison', () => {
            for (const bb of same) this.game.ungarrisonAll(bb);
          }, 'Turn out all garrisoned units.'));
        }
        if (b.def.farmFood) {
          const on = this.player.autoReseed;
          const woodCost = this.player.mods.building('farm').cost.wood;
          buttons.push(this._btn('farm', `Reseed: ${on ? 'On' : 'Off'}`, () => {
            this.player.autoReseed = !this.player.autoReseed;
            this.player.notify(`Farm auto-reseed ${this.player.autoReseed ? 'enabled' : 'disabled'}`);
            this._cardKey = '';
          }, `<b>Automatic farm reseeding: ${on ? 'ON' : 'OFF'}</b><br>` +
             `When a Farm is exhausted it is re-sown in place for ${woodCost} wood, ` +
             `so the farmer never stops working. Turn off to let spent plots expire.`));
        }
        buttons.push(this._btn('flag', 'Set Rally Point', () => this.ctx.input.setCursorMode('rally'),
          'New units gather here. Point it at a resource to auto-assign villagers.'));
        if (b.type === 'market') {
          for (const r of ['food', 'wood', 'stone']) {
            buttons.push(this._btn(resIcon(r), `Buy ${cap(r)}`, () => this.game.marketTrade(this.playerIndex, r, 'buy'),
              `Buy 100 ${r} for ${Math.round(100 * (1 + this.player.mods.marketFee))} gold.`));
            buttons.push(this._btn(resIcon(r), `Sell ${cap(r)}`, () => this.game.marketTrade(this.playerIndex, r, 'sell'),
              `Sell 100 ${r} for ${Math.round(100 * (1 - this.player.mods.marketFee))} gold.`));
          }
        }
      }
      buttons.push(this._btn('del', 'Delete', () => { for (const x of buildings) this.game.kill(x, null); },
        'Demolish the selected buildings.'));
    }

    this._renderButtons(buttons);
  }

  _renderButtons(buttons) {
    const grid = el('div', 'cardgrid');
    for (const b of buttons) grid.appendChild(b);
    this.card.appendChild(grid);
  }

  _btn(iconName, label, onClick, tooltip, disabled) {
    const b = el('button', 'cardbtn' + (disabled ? ' disabled' : ''));
    b.appendChild(imgIcon(iconName, 34));
    b.appendChild(el('span', 'cardlabel', label));
    b.onclick = (e) => { e.stopPropagation(); onClick(e); };
    if (tooltip) this.tip(b, tooltip);
    return b;
  }

  /* ---------------- tooltips ---------------- */

  _costLine(cost) {
    const parts = [];
    for (const r of ['food', 'wood', 'gold', 'stone']) {
      if (cost[r]) parts.push(`<span class="c-${r}">${Math.round(cost[r])} ${r}</span>`);
    }
    return parts.join(' · ') || 'free';
  }

  _unitTooltip(def, withCost) {
    const atk = Object.entries(def.atk || {}).filter(([, v]) => v > 0);
    const base = atk.filter(([k]) => k === 'melee' || k === 'pierce');
    const bonus = atk.filter(([k]) => k !== 'melee' && k !== 'pierce');
    let s = `<b>${def.name}</b><br>`;
    if (withCost) s += `<span class="dim">${this._costLine(def.cost)} · ${def.time}s</span><br>`;
    s += `<table class="ttab">`;
    s += `<tr><td>Hit points</td><td>${def.hp}</td></tr>`;
    if (base.length) s += `<tr><td>Attack</td><td>${base.map(([k, v]) => `${v} ${k}`).join(', ')}</td></tr>`;
    s += `<tr><td>Armor</td><td>${def.armor.melee} melee / ${def.armor.pierce} pierce</td></tr>`;
    if (def.range) s += `<tr><td>Range</td><td>${def.range}${def.minRange ? ` (min ${def.minRange})` : ''}</td></tr>`;
    s += `<tr><td>Speed</td><td>${def.speed.toFixed(2)}</td></tr>`;
    s += `<tr><td>Rate of fire</td><td>${def.reload.toFixed(2)}s</td></tr>`;
    if (def.blast) s += `<tr><td>Blast radius</td><td>${def.blast}</td></tr>`;
    s += `</table>`;
    if (bonus.length) {
      s += `<div class="tbonus"><b>Attack bonus</b><br>` +
        bonus.map(([k, v]) => `+${v} vs ${ARMOR_CLASSES[k] || k}`).join('<br>') + `</div>`;
    }
    if (def.classes?.length) {
      s += `<div class="dim">Belongs to: ${def.classes.map((c) => ARMOR_CLASSES[c] || c).join(', ')}</div>`;
    }
    const counters = COUNTER_HINTS[def.id] || counterHintFor(def);
    if (counters) s += `<div class="thint">${counters}</div>`;
    return s;
  }

  _buildingTooltip(def) {
    let s = `<b>${def.name}</b><br><span class="dim">${this._costLine(def.cost)} · ${def.time}s build time</span>`;
    s += `<table class="ttab"><tr><td>Hit points</td><td>${def.hp}</td></tr>`;
    s += `<tr><td>Armor</td><td>${def.armor.melee} / ${def.armor.pierce}</td></tr>`;
    if (def.atk) s += `<tr><td>Attack</td><td>${def.atk.pierce || def.atk.melee} (range ${def.range})</td></tr>`;
    if (def.pop) s += `<tr><td>Population</td><td>+${def.pop}</td></tr>`;
    if (def.garrison) s += `<tr><td>Garrison</td><td>${def.garrison}</td></tr>`;
    s += `</table>`;
    if (def.trains?.length) s += `<div class="dim">Trains military units.</div>`;
    if (def.dropSite) s += `<div class="dim">Drop site: ${def.dropSite.join(', ')}</div>`;
    return s;
  }

  _techTooltip(t, cost, unique) {
    return `<b>${t.name}</b>${unique ? ' <span class="uniq">Unique Technology</span>' : ''}<br>` +
      `<span class="dim">${this._costLine(cost)} · ${t.time}s</span><br>${t.desc}`;
  }

  /* ---------------- minimap ---------------- */

  _paintMinimapTerrain() {
    const g = this.game, s = g.size;
    const c = this.mmTerrain.getContext('2d');
    const img = c.createImageData(s, s);
    const colors = {
      0: [95, 143, 67], 1: [81, 127, 58], 2: [138, 116, 73],
      3: [196, 178, 122], 4: [36, 80, 110], 5: [58, 119, 148],
    };
    for (let i = 0; i < s * s; i++) {
      const col = colors[g.tiles[i]] || colors[0];
      img.data[i * 4] = col[0];
      img.data[i * 4 + 1] = col[1];
      img.data[i * 4 + 2] = col[2];
      img.data[i * 4 + 3] = 255;
    }
    c.putImageData(img, 0, 0);
  }

  _drawMinimap() {
    const g = this.game, s = g.size;
    const ctx = this.mmCtx;
    const W = this.minimap.width, H = this.minimap.height;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(this.mmTerrain, 0, 0, W, H);

    const k = W / s;
    // fog
    if (!g.revealAll) {
      const p = this.player;
      ctx.save();
      for (let y = 0; y < s; y += 1) {
        for (let x = 0; x < s; x += 1) {
          const f = p.fog[y * s + x];
          if (f === 2) continue;
          ctx.fillStyle = f === 1 ? 'rgba(0,0,0,0.42)' : 'rgba(0,0,0,0.9)';
          ctx.fillRect(x * k, y * k, k + 0.6, k + 0.6);
        }
      }
      ctx.restore();
    }

    // entities
    for (const e of g.entities) {
      if (!e.alive) continue;
      if (e.kind === 'projectile') continue;
      const vis = g.revealAll || (e.kind === 'building'
        ? this.player.hasExplored(e.x | 0, e.y | 0)
        : this.player.canSee(e.x | 0, e.y | 0));
      if (!vis) continue;
      let color = null, size = 2;
      if (e.kind === 'resource') {
        if (e.type === 'tree') { color = '#2f5f2f'; size = 1.5; }
        else if (e.type === 'gold') color = '#e0bc3c';
        else if (e.type === 'stone') color = '#c8c8c2';
        else if (e.type === 'berries') color = '#b03050';
        else if (e.type === 'relic') { color = '#ffffff'; size = 3; }
        else color = '#d1483c';
      } else if (e.owner < 0) {
        color = '#b0a080';
      } else {
        color = '#' + PLAYER_COLORS[e.owner % PLAYER_COLORS.length].toString(16).padStart(6, '0');
        size = e.kind === 'building' ? Math.max(3, e.size * k) : 2.6;
      }
      ctx.fillStyle = color;
      ctx.fillRect(e.x * k - size / 2, e.y * k - size / 2, size, size);
    }

    // Camera box. The canvas is full-window, but the part of it the player can
    // actually see is only the band between the top bar and the bottom panel.
    // Projecting the full canvas rect includes ground hidden behind the HUD -
    // and because the projection is isometric, the hidden bottom strip is the
    // nearest ground, so the box ends up noticeably forward of the real view.
    const corners = this.viewportCorners();
    if (corners) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(corners[0].x * k, corners[0].y * k);
      for (let i = 1; i < 4; i++) ctx.lineTo(corners[i].x * k, corners[i].y * k);
      ctx.closePath();
      ctx.stroke();
    }
  }

  /** World-space corners of the ground the player can actually see. */
  viewportCorners() {
    const r = this.ctx.renderer;
    const top = this.topBar ? this.topBar.offsetHeight : 0;
    const bottom = this.bottom ? this.bottom.offsetHeight : 0;
    const w = r.viewW, h = r.viewH;
    const y0 = top, y1 = Math.max(top + 1, h - bottom);
    const pts = [[0, y0], [w, y0], [w, y1], [0, y1]]
      .map(([sx, sy]) => r.screenToWorld(sx, sy));
    return pts.every(Boolean) ? pts : null;
  }

  _minimapClick(e) {
    const rect = this.minimap.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * this.game.size;
    const y = ((e.clientY - rect.top) / rect.height) * this.game.size;
    if (e.button === 2) return;
    this.ctx.renderer.centerOn(x, y);
  }

  /* ---------------- modals ---------------- */

  toggleMenu() {
    if (!this.modal.classList.contains('hidden') && this.modalKind === 'menu') { this.hideModal(); return; }
    this.modalKind = 'menu';
    const p = this.player;
    this.modal.innerHTML = `
      <div class="modal-box">
        <h2>Game Menu</h2>
        <div class="stats">
          <div>Villagers lost: ${p.stats.villagersLost}</div>
          <div>Units killed: ${p.stats.unitsKilled}</div>
          <div>Units lost: ${p.stats.unitsLost}</div>
          <div>Resources gathered: ${Math.floor(p.stats.resourcesGathered)}</div>
          <div>Relics held: ${p.relics}</div>
        </div>
        <div class="row">
          <label>Game speed</label>
          <input type="range" min="0.5" max="4" step="0.1" value="${this.game.speed}" id="speedSlider">
          <span id="speedVal">${this.game.speed.toFixed(1)}x</span>
        </div>
        <div class="row">
          <label>Pixelation</label>
          <input type="range" min="0.2" max="1" step="0.05" value="${this.ctx.renderer.pixelScale}" id="pixSlider">
          <span id="pixVal">${this.ctx.renderer.pixelScale.toFixed(2)}</span>
        </div>
        <div class="btnrow">
          <button id="mClose">Resume</button>
          <button id="mReveal">Toggle Map Reveal</button>
          <button id="mResign">Resign</button>
          <button id="mNew">New Game</button>
        </div>
      </div>`;
    this.modal.classList.remove('hidden');
    const q = (id) => this.modal.querySelector('#' + id);
    q('mClose').onclick = () => this.hideModal();
    q('mReveal').onclick = () => { this.game.revealAll = !this.game.revealAll; };
    q('mResign').onclick = () => { this.player.defeated = true; this.game.over = true; this.game.winner = null; this.hideModal(); };
    q('mNew').onclick = () => location.reload();
    q('speedSlider').oninput = (ev) => {
      this.game.speed = parseFloat(ev.target.value);
      q('speedVal').textContent = this.game.speed.toFixed(1) + 'x';
    };
    q('pixSlider').oninput = (ev) => {
      this.ctx.renderer.setPixelScale(parseFloat(ev.target.value));
      q('pixVal').textContent = parseFloat(ev.target.value).toFixed(2);
    };
  }

  toggleHelp() {
    if (!this.modal.classList.contains('hidden') && this.modalKind === 'help') { this.hideModal(); return; }
    this.modalKind = 'help';
    this.modal.innerHTML = `
      <div class="modal-box wide">
        <h2>How to Play</h2>
        <div class="cols">
          <div>
            <h3>Controls</h3>
            <ul class="keys">
              <li><b>Left click / drag</b> select unit, or box-select everything you own</li>
              <li><b>Right click</b> smart order — move, attack, gather, build, repair, garrison</li>
              <li><b>Shift + right click</b> <i>queue</i> an order instead of replacing</li>
              <li><b>Shift + click a Mill / Town Center</b> with villagers selected —
                builds one Farm per villager, packed around that building</li>
              <li><b>Shift + click</b> add/remove from selection · <b>Double click</b> all of type on screen</li>
              <li><b>Ctrl+1..9</b> make control group · <b>1..9</b> recall · <b>tap twice</b> centre</li>
              <li><b>Arrows / edge / middle-drag</b> pan · <b>wheel</b> zoom · <b>Q / E</b> rotate</li>
              <li><b>T</b> Town Center · <b>.</b> next idle villager · <b>,</b> next idle military</li>
              <li><b>A</b> attack-move · <b>P</b> patrol · <b>H</b> hold position · <b>S</b> stop</li>
              <li><b>G</b> garrison · <b>Delete</b> delete · <b>Esc</b> clear queued orders</li>
              <li><b>B</b> economic build menu · <b>V</b> military build menu</li>
              <li><b>F1</b> help · <b>F3</b> tech tree · <b>F10</b> menu</li>
            </ul>
            <h3>Order queues</h3>
            <p>Hold <b>Shift</b> and right-click repeatedly to chain any mix of orders —
            walk here, chop that tree, mine that gold, repair that wall, attack that
            unit. The chain is drawn as numbered waypoints joined by a dotted line.
            A right-click <i>without</i> Shift replaces the whole queue immediately;
            <b>Esc</b> drops the queue but lets the current action finish; <b>S</b>
            cancels everything.</p>
          </div>
          <div>
            <h3>The counter system</h3>
            <p>Damage is <i>typed</i>. Every attack is a set of damage components and every unit
            has matching armour values:</p>
            <pre>damage = Σ max(0, attack[class] − armor[class])</pre>
            <ul class="keys">
              <li><b>Spearmen / Pikemen / Halberdiers</b> carry a huge <i>cavalry</i> component
                (+15 / +22 / +26) so they shred Knights, Camels and Elephants.</li>
              <li><b>Skirmishers</b> deal bonus damage vs the <i>archer</i> class and have
                high pierce armour — they beat Archers but lose to everything melee.</li>
              <li><b>Archers</b> deal bonus damage vs the <i>spearman</i> class, which is why
                pikes cannot simply mass against everything.</li>
              <li><b>Cavalry</b> runs down Archers, Skirmishers, Monks and siege.</li>
              <li><b>Camels</b> counter cavalry but are weak to infantry.</li>
              <li><b>Eagle Warriors</b> hunt Monks and siege; swordsmen hard-counter Eagles.</li>
              <li><b>Mangonels</b> hit an area — deadly to clumped archers, awful vs single knights.</li>
              <li><b>Rams and Trebuchets</b> exist only to break buildings.</li>
              <li>Attacking from higher ground deals +25% damage; uphill deals −25%.</li>
            </ul>
          </div>
        </div>
        <div class="btnrow"><button id="hClose">Close</button></div>
      </div>`;
    this.modal.classList.remove('hidden');
    this.modal.querySelector('#hClose').onclick = () => this.hideModal();
  }

  toggleTechTree() {
    if (!this.modal.classList.contains('hidden') && this.modalKind === 'tree') { this.hideModal(); return; }
    this.modalKind = 'tree';
    const p = this.player;
    const ages = ['dark', 'feudal', 'castle', 'imperial'];
    let html = `<div class="modal-box wide"><h2>${p.civ.name} Tech Tree</h2>
      <div class="civdesc"><b>Focus:</b> ${p.civ.focus} &nbsp; <b>Unique unit:</b> ${p.mods.unit(p.civ.uu).name}
      <ul>${p.civ.bonuses.map((b) => `<li>${b.desc}</li>`).join('')}
      <li><i>Team bonus:</i> ${p.civ.team ? p.civ.team.desc : '—'}</li>
      ${p.civ.ut1 ? `<li><i>Castle UT:</i> ${p.civ.ut1.name} — ${p.civ.ut1.desc}</li>` : ''}
      ${p.civ.ut2 ? `<li><i>Imperial UT:</i> ${p.civ.ut2.name} — ${p.civ.ut2.desc}</li>` : ''}
      </ul></div><div class="treegrid">`;
    for (const age of ages) {
      html += `<div class="treecol"><h3>${AGE_NAMES[age]}</h3>`;
      const list = Object.values(UNITS).filter((u) => u.age === age && u.cat !== 'animal' &&
        (!u.unique || u.id === p.civ.uu || u.id === p.civ.uuElite));
      for (const u of list) {
        const off = p.disabledUnits.has(u.id);
        html += `<div class="treeitem unit ${off ? 'off' : ''}">${u.name}</div>`;
      }
      const techs = Object.values(TECHS).filter((t) => t.age === age && !t.hidden &&
        !p.disabledTechs.has(t.id) && !t.id.startsWith('elite_') &&
        !isOtherCivUT(t.id, p.civId));
      for (const t of techs) {
        const done = p.researched.has(t.id);
        html += `<div class="treeitem tech ${done ? 'done' : ''}" title="${t.desc}">${t.name}</div>`;
      }
      html += `</div>`;
    }
    html += `</div><div class="btnrow"><button id="tClose">Close</button></div></div>`;
    this.modal.innerHTML = html;
    this.modal.classList.remove('hidden');
    this.modal.querySelector('#tClose').onclick = () => this.hideModal();
  }

  showGameOver(won, text) {
    this.modalKind = 'over';
    this.modal.innerHTML = `<div class="modal-box">
      <h2 class="${won ? 'victory' : 'defeat'}">${won ? 'Victory!' : 'Defeat'}</h2>
      <p>${text}</p>
      <div class="btnrow"><button id="oNew">New Game</button><button id="oWatch">Keep Watching</button></div>
    </div>`;
    this.modal.classList.remove('hidden');
    this.modal.querySelector('#oNew').onclick = () => location.reload();
    this.modal.querySelector('#oWatch').onclick = () => this.hideModal();
  }

  hideModal() { this.modal.classList.add('hidden'); this.modalKind = null; }
  get modalOpen() { return !this.modal.classList.contains('hidden'); }
}

/* ---------------- helpers ---------------- */

let _otherUT = null;
function isOtherCivUT(techId, civId) {
  if (!_otherUT) {
    _otherUT = new Map();
    for (const id in CIVILIZATIONS) {
      const c = CIVILIZATIONS[id];
      if (c.ut1) _otherUT.set(c.ut1.id, id);
      if (c.ut2) _otherUT.set(c.ut2.id, id);
    }
  }
  const owner = _otherUT.get(techId);
  return owner !== undefined && owner !== civId;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function imgIcon(name, size) {
  const i = document.createElement('img');
  i.src = icon(name);
  i.width = size; i.height = size;
  i.className = 'pix';
  return i;
}

function cap(s) { return s[0].toUpperCase() + s.slice(1); }
function dedupe(a) { return [...new Set(a)]; }

function counterHintFor(def) {
  if (def.classes?.includes('spearman')) return 'Strong vs cavalry · Weak vs archers and swordsmen';
  if (def.id?.includes('kirmisher')) return 'Strong vs archers · Weak vs everything melee';
  if (def.classes?.includes('camel')) return 'Strong vs cavalry · Weak vs infantry';
  if (def.classes?.includes('eagleWarrior')) return 'Strong vs monks and siege · Weak vs swordsmen';
  if (def.cat === 'archer') return 'Strong vs infantry · Weak vs skirmishers and cavalry';
  if (def.cat === 'cavalry') return 'Strong vs archers and siege · Weak vs spearmen and camels';
  if (def.cat === 'siege') return 'Strong vs buildings and clumps · Weak vs fast melee';
  if (def.cat === 'infantry') return 'Cheap and durable · Weak vs archers and cavalry';
  return null;
}

const COUNTER_HINTS = {
  halberdier: 'Deals 26 bonus damage to the Cavalry armour class — the hardest counter in the game.',
  eliteSkirmisher: 'High pierce armour plus bonus damage vs Archers. Cheap trash unit, no gold cost.',
  monk: 'Converts enemy units to your side and heals allies. Extremely fragile — screen it.',
  mangonel: 'Blast damage with friendly fire. Devastating against massed archers.',
  trebuchet: 'Siege only. Must be unpacked; out-ranges every defensive building.',
  huskarl: '6 pierce armour and +6 vs Archers — walks through arrow fire.',
  cataphract: '12 armour against the Infantry class, which blanks Halberdier bonus damage.',
};
