# Age of Antiquity

A retro, low-poly remake of **Age of Empires II: Definitive Edition** — a real-time
strategy game with villager economies, four ages, military production buildings,
technology research, 45 civilizations, and AoE2's typed-armour counter system
reproduced faithfully.

The art style is a deliberate 3D/2D hybrid: everything is real flat-shaded 3D
geometry viewed through an isometric orthographic camera, but the scene renders
into a half-resolution buffer and is upscaled with nearest-neighbour filtering
and colour quantisation, so it reads as chunky pixel art that rotates in 3D.

## Running it

```bash
npm start          # then open http://localhost:8080
```

Three.js is downloaded from a CDN at page load. To play offline, vendor it first:

```bash
npm run fetch-assets   # downloads three.js into public/vendor/
npm start              # the game prefers the local copy automatically
```

No build step, no dependencies — plain ES modules served by a zero-dependency
Node static server.

## Controls

| Input | Action |
|---|---|
| Left click / drag | Select unit, or box-select |
| Right click | Contextual order — move, attack, gather, build, repair, garrison |
| Shift + click | Add to selection · Double-click selects all of that type on screen |
| Ctrl+1..9 / 1..9 | Set / recall control group (tap twice to centre) |
| Arrow keys, screen edge, middle-drag | Pan · Wheel zoom · **Q**/**E** rotate 45° |
| **H** | Cycle Town Centers · **.** next idle villager · **,** next idle soldier |
| **A** | Attack-move · **S** stop · **G** garrison · **Delete** delete |
| **B** / **V** | Economic / military build menu · **Esc** cancel |
| **F1** help · **F3** tech tree · **F10** menu | |

## The counter system

This is the part worth getting right, so it is modelled exactly as AoE2 does it.
There is no damage multiplier anywhere. Every attack is a **set of typed damage
components**, and every unit carries **armour values for each class it belongs to**:

```
damage = Σ over classes c present in the target's armour of  max(0, attack[c] − armour[c])
damage = max(damage, 1)
```

A Halberdier's attack is `{ melee: 6, cavalry: 26, elephant: 28, camel: 12 }`.
A Knight's armour is `{ melee: 2, pierce: 2, cavalry: 0 }` — it *is* a cavalry unit,
so the cavalry component lands: `(6−2) + (26−0) = 30`. Another Halberdier has no
`cavalry` entry at all, so that same attack deals only `6`. A Champion, with just
`{ melee: 13 }`, hits the Knight for `11`.

That single rule produces the whole rock-paper-scissors web:

- **Spearman → Pikeman → Halberdier** carry +15/+22/+26 vs the Cavalry class — the hardest counter in the game.
- **Skirmishers** have +4 vs Archer and 4 pierce armour, so they beat archers and lose to anything melee.
- **Archers** carry +3 vs the Spearman class, which is why pikes cannot simply mass against everything.
- **Camels** counter cavalry (+18) but fold to infantry. **Cavalry** runs down archers, monks and siege.
- **Eagle Warriors** hunt monks and siege; the militia line hard-counters Eagles.
- **Mangonels** do blast damage with friendly fire. **Rams and Trebuchets** carry enormous Building/Stone-Defence components and are near-harmless to units.
- Byzantine **Cataphracts** carry 16 *Infantry* armour specifically to blank anti-infantry bonuses.
- Attacking downhill deals +25%; uphill deals −25%.

Hovering any unit in the UI shows its full component breakdown, its armour classes,
and a plain-language counter hint.

## What's implemented

**Economy** — food/wood/gold/stone, villagers with carry capacity and drop sites,
farms, berries, sheep/deer/boar hunting with carcasses, fishing, relics, trade
carts, market buying and selling with a civ-dependent fee.

**Buildings** — Town Center, House, Mill, Lumber/Mining Camp, Farm, Dock, Market,
Barracks, Archery Range, Stable, Blacksmith, Siege Workshop, Monastery,
University, Castle, Watch/Guard/Keep/Bombard Tower, Outpost, palisade and stone
walls, Gate, Wonder, plus civ-unique Donjon, Krepost, Feitoria and Caravanserai.

**Units** — the full militia, spearman, eagle, archer, skirmisher, cavalry-archer,
scout, knight, camel, elephant and steppe-lancer lines; rams, mangonels,
scorpions, bombard cannons, trebuchets, petards and siege towers; monks and
missionaries with conversion and healing; the full naval roster; and **45 unique
units with their Elite upgrades**.

**Technology** — four ages with building prerequisites, the complete Blacksmith
attack/armour trees, economy upgrades, Ballistics, Chemistry, Siege Engineers,
Masonry/Architecture, the Monastery and Market trees, every unit-line upgrade,
and two unique technologies per civilization.

**Civilizations** — all 45, each with implemented bonuses, a team bonus, two
unique techs, and a genuine tech-tree with units and technologies disabled.

**Simulation** — 20 Hz fixed-step, A* pathfinding with string-pulling and a
per-tick search budget, local collision avoidance, fog of war with explored
shroud, garrisoning with arrow bonuses, projectile flight with Ballistics
leading, blast and trample damage, and monk conversion.

**AI** — build-order driven economy, resource re-balancing by age, banks food for
age-ups, and picks its army composition by *reading the enemy's* composition and
selecting the units that counter it.

## Verifying it

```bash
npm test                # 25 game-minutes, AI vs AI, no renderer
npm run test:render     # boots the real page in headless Chrome
```

`npm test` runs the counter-system assertions and data-integrity checks, then
simulates a full game headlessly (~300x real time) and reports each player's
economy, army composition, buildings and research.

`npm run test:render` is the one that catches graphics bugs. It launches the
actual page in Chrome (SwiftShader WebGL), starts a game, drives a scout across
the map to force the fog through all three of its states, orders villagers onto
a tree and a berry bush, and then reports:

* console and WebGL errors,
* framebuffer colour statistics (how much of the view is green / blue / black),
* instanced-mesh occupancy, proving geometry is actually submitted,
* mean on-screen brightness **grouped by each tile's true fog state**, so
  visible / explored / unexplored can be shown to be visually distinct,
* whether villagers adopted their working poses and whether a felled tree
  actually played its topple animation,

and writes screenshots to `shots/`. It found a backwards triangle winding that
made the entire terrain back-face culled — invisible, but with perfectly valid
geometry, so nothing but a real render could have caught it.

Requires the `puppeteer` dev dependency (`npm i`), which downloads a headless
Chrome on first use.

## Layout

```
public/src/data/     armor · units · buildings · techs · civs      (pure data)
public/src/core/     rng · spatial grid · A* pathfinding
public/src/sim/      game loop · entities · combat · economy · AI · map gen
public/src/render/   procedural low-poly meshes · pixelated renderer
public/src/ui/       HUD · command card · input · overlay · pixel icons
scripts/             asset downloader · headless test harness
```

## Notes on fidelity

Stats come from the AoE2:DE unit tables (unitstatistics.com, aoedb.net, the Age
of Empires wiki). Where public sources disagreed on a decimal, the value closest
to in-game feel was used. A handful of civ bonuses that would need bespoke engine
support (Flemish Revolution, Folwark, Mule Carts) are present as data and flags
but not fully simulated; everything else resolves through the shared declarative
effect system, which means civ bonuses, team bonuses and technologies all use the
same code path and are trivial to retune.

This is a fan tribute for learning and play. Age of Empires is a trademark of
Microsoft; no Microsoft assets are used — all art is generated procedurally in
code.
