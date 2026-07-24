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
    for (const r of ['food', 'wood', 'gold', 'stone']) {
      const box = el('div', 'resbox');
      box.appendChild(imgIcon(resIcon(r), 20));
      const v = el('span', 'resval'); v.textContent = '0';
      box.appendChild(v);
      this.resEls[r] = v;
      this.topBar.appendChild(box);
      this.tip(box, () => `<b>${cap(r)}</b><br>Stockpiled ${cap(r)}.`);
    }
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

    this._updateNotifications();
    this._updateSelection(selection);
    this._updateCard(selection);
    this._drawMinimap();
  }

  _updateNotifications() {
    const list = this.player.notifications;
    const html = list.slice(-4).map((n) => `<div class="note" style="opacity:${Math.max(0.15, 1 - n.t / 8).toFixed(2)}">${n.text}</div>`).join('');
    if (html !== this._lastNotes) { this.notifyEl.innerHTML = html; this._lastNotes = html; }
  }

  /* ---------------- selection panel ---------------- */

  _updateSelection(sel) {
    const key = sel.map((e) => e.id + ':' + Math.round(e.hp) + ':' + (e.queue ? e.queue.length : 0) +
      ':' + (e.task ? e.task.type : '')).join(',');
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

    if (e.kind === 'unit' && e.carrying && e.carrying.amount > 0.5) {
      info.appendChild(el('div', 'sel-carry',
        `Carrying ${Math.floor(e.carrying.amount)} ${e.carrying.res}`));
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
    if (e.kind === 'resource') {
      info.appendChild(el('div', 'sel-task', `${Math.floor(e.amount)} ${e.resType} remaining`));
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

  /* ---------------- command card ---------------- */

  _updateCard(sel) {
    const key = this.cardMode + '|' + sel.map((e) => e.id).join(',') + '|' +
      this.player.age + '|' + Math.floor(this.player.res.food / 25) + '|' +
      Math.floor(this.player.res.wood / 25) + '|' + Math.floor(this.player.res.gold / 25) +
      '|' + Math.floor(this.player.res.stone / 25) + '|' + this.player.researched.size;
    if (key === this._cardKey) return;
    this._cardKey = key;
    this.card.innerHTML = '';

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
      buttons.push(this._btn('stop', 'Stop', () => this.game.commandStop(units), 'Cancel all orders. <b>[S]</b>'));
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
        for (const uId of dedupe(trains)) {
          if (!this.player.isUnitAvailable(uId)) continue;
          const def = this.player.mods.unit(uId);
          buttons.push(this._btn(unitIcon(def), def.name, () => {
            for (const bb of same) { if (this.game.queueUnit(bb, uId)) break; }
          }, () => this._unitTooltip(def, true), !this.player.canAfford(def.cost)));
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
    b.onclick = (e) => { e.stopPropagation(); onClick(); };
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

    // camera box
    const r = this.ctx.renderer;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    const corners = [[0, 0], [r.viewW, 0], [r.viewW, r.viewH], [0, r.viewH]]
      .map(([sx, sy]) => r.screenToWorld(sx, sy))
      .filter(Boolean);
    if (corners.length === 4) {
      ctx.beginPath();
      ctx.moveTo(corners[0].x * k, corners[0].y * k);
      for (let i = 1; i < 4; i++) ctx.lineTo(corners[i].x * k, corners[i].y * k);
      ctx.closePath();
      ctx.stroke();
    }
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
              <li><b>Left click / drag</b> select unit or box-select</li>
              <li><b>Right click</b> contextual order (move, attack, gather, build, garrison)</li>
              <li><b>Shift + click</b> add to selection · <b>Double click</b> select all of type on screen</li>
              <li><b>Ctrl+1..9</b> make control group · <b>1..9</b> recall</li>
              <li><b>WASD / arrows / edge</b> pan · <b>wheel</b> zoom · <b>Q / E</b> rotate</li>
              <li><b>H</b> Town Center · <b>.</b> next idle villager · <b>,</b> next idle military</li>
              <li><b>A</b> attack-move · <b>S</b> stop · <b>G</b> garrison · <b>Delete</b> delete</li>
              <li><b>B</b> economic build menu · <b>V</b> military build menu · <b>Esc</b> cancel</li>
              <li><b>F3</b> tech tree · <b>F10</b> menu</li>
            </ul>
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
