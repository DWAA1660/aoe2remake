// Unit database, modelled on Age of Empires II: Definitive Edition.
//
// Stats sourced from the DE unit tables (unitstatistics.com / aoedb.net / the
// Age of Empires wiki). Where public sources disagreed on a decimal the value
// closest to in-game feel was used - everything here is data, so it is trivial
// to retune.
//
// atk    : typed damage components, see data/armor.js
// armor  : typed armor values
// classes: which armor classes this unit *belongs* to (what it takes bonus damage as)

const DEFAULTS = {
  cat: 'infantry',
  from: 'barracks',
  age: 'dark',
  cost: {},
  time: 20,
  hp: 40,
  atk: { melee: 4 },
  armor: { melee: 0, pierce: 0 },
  range: 0,
  minRange: 0,
  reload: 2.0,
  speed: 1.0,
  los: 4,
  pop: 1,
  classes: ['infantry'],
  domain: 'land',
  accuracy: 1.0,
  projectileSpeed: 7,
  blast: 0,
  radius: 0.28,
  garrison: 0,
  upgradeTo: null,
  unique: false,
};

const DB = {};
function U(id, def) {
  const u = { id, ...DEFAULTS, ...def };
  u.cost = { food: 0, wood: 0, gold: 0, stone: 0, ...(def.cost || {}) };
  u.armor = { melee: 0, pierce: 0, ...(def.armor || {}) };
  u.bonus = def.bonus || {};
  // fold bonus components into the attack table
  u.atk = { ...(def.atk || DEFAULTS.atk), ...u.bonus };
  DB[id] = u;
  return u;
}

/* ------------------------------------------------------------------ *
 *  ECONOMY
 * ------------------------------------------------------------------ */

U('villager', {
  name: 'Villager', cat: 'villager', from: 'townCenter', age: 'dark',
  cost: { food: 50 }, time: 25, hp: 25,
  atk: { melee: 3 }, bonus: { building: 3, stoneDefense: 3 },
  armor: { melee: 0, pierce: 0 }, speed: 0.8, los: 4, reload: 2.0,
  classes: ['villager'], radius: 0.22,
});

U('tradeCart', {
  name: 'Trade Cart', cat: 'trade', from: 'market', age: 'feudal',
  cost: { wood: 100, gold: 50 }, time: 51, hp: 70,
  atk: {}, armor: { melee: 0, pierce: 0 }, speed: 1.0, los: 5,
  classes: ['villager'], radius: 0.3,
});

/* ------------------------------------------------------------------ *
 *  BARRACKS - Militia line (raw melee damage, hard-counters Eagles)
 * ------------------------------------------------------------------ */

U('militia', {
  name: 'Militia', from: 'barracks', age: 'dark',
  cost: { food: 60, gold: 20 }, time: 21, hp: 40,
  atk: { melee: 4 }, armor: { melee: 0, pierce: 1 }, speed: 0.9, los: 4,
  classes: ['infantry'], upgradeTo: 'manAtArms',
});
U('manAtArms', {
  name: 'Man-at-Arms', from: 'barracks', age: 'feudal',
  cost: { food: 60, gold: 20 }, time: 21, hp: 45,
  atk: { melee: 6 }, bonus: { eagleWarrior: 2, standardBuilding: 0 },
  armor: { melee: 0, pierce: 1 }, speed: 0.9, classes: ['infantry'], upgradeTo: 'longSwordsman',
});
U('longSwordsman', {
  name: 'Long Swordsman', from: 'barracks', age: 'castle',
  cost: { food: 60, gold: 20 }, time: 21, hp: 60,
  atk: { melee: 9 }, bonus: { eagleWarrior: 6 },
  armor: { melee: 0, pierce: 1 }, speed: 0.9, classes: ['infantry'], upgradeTo: 'twoHandedSwordsman',
});
U('twoHandedSwordsman', {
  name: 'Two-Handed Swordsman', from: 'barracks', age: 'imperial',
  cost: { food: 60, gold: 20 }, time: 21, hp: 60,
  atk: { melee: 12 }, bonus: { eagleWarrior: 8 },
  armor: { melee: 1, pierce: 1 }, speed: 0.9, classes: ['infantry'], upgradeTo: 'champion',
});
U('champion', {
  name: 'Champion', from: 'barracks', age: 'imperial',
  cost: { food: 60, gold: 20 }, time: 21, hp: 70,
  atk: { melee: 13 }, bonus: { eagleWarrior: 10 },
  armor: { melee: 1, pierce: 1 }, speed: 0.9, classes: ['infantry'],
});

/* ------------------------------------------------------------------ *
 *  BARRACKS - Spearman line (THE anti-cavalry counter)
 * ------------------------------------------------------------------ */

U('spearman', {
  name: 'Spearman', from: 'barracks', age: 'feudal',
  cost: { food: 35, wood: 25 }, time: 22, hp: 45,
  atk: { melee: 3 }, bonus: { cavalry: 15, elephant: 15, camel: 10, ship: 1 },
  armor: { melee: 0, pierce: 0 }, speed: 1.0, reload: 3.0,
  classes: ['infantry', 'spearman'], upgradeTo: 'pikeman',
});
U('pikeman', {
  name: 'Pikeman', from: 'barracks', age: 'castle',
  cost: { food: 35, wood: 25 }, time: 22, hp: 55,
  atk: { melee: 4 }, bonus: { cavalry: 22, elephant: 25, camel: 11, ship: 1 },
  armor: { melee: 0, pierce: 0 }, speed: 1.0, reload: 3.0,
  classes: ['infantry', 'spearman'], upgradeTo: 'halberdier',
});
U('halberdier', {
  name: 'Halberdier', from: 'barracks', age: 'imperial',
  cost: { food: 35, wood: 25 }, time: 22, hp: 60,
  atk: { melee: 6 }, bonus: { cavalry: 26, elephant: 28, camel: 12, ship: 1 },
  armor: { melee: 0, pierce: 0 }, speed: 1.0, reload: 3.0,
  classes: ['infantry', 'spearman'],
});

/* ------------------------------------------------------------------ *
 *  BARRACKS - Eagle line (fast raider, hunts monks + siege, dies to swords)
 * ------------------------------------------------------------------ */

U('eagleScout', {
  name: 'Eagle Scout', from: 'barracks', age: 'dark',
  cost: { food: 20, gold: 50 }, time: 35, hp: 50,
  atk: { melee: 4 }, bonus: { monk: 8, siege: 3, cavalry: 1, camel: 3, ship: 2 },
  armor: { melee: 0, pierce: 2 }, speed: 1.1, los: 6,
  classes: ['infantry', 'eagleWarrior'], upgradeTo: 'eagleWarrior',
});
U('eagleWarrior', {
  name: 'Eagle Warrior', from: 'barracks', age: 'castle',
  cost: { food: 20, gold: 50 }, time: 35, hp: 55,
  atk: { melee: 7 }, bonus: { monk: 8, siege: 4, cavalry: 2, camel: 5, ship: 3 },
  armor: { melee: 0, pierce: 3 }, speed: 1.1, los: 6,
  classes: ['infantry', 'eagleWarrior'], upgradeTo: 'eliteEagleWarrior',
});
U('eliteEagleWarrior', {
  name: 'Elite Eagle Warrior', from: 'barracks', age: 'imperial',
  cost: { food: 20, gold: 50 }, time: 35, hp: 60,
  atk: { melee: 9 }, bonus: { monk: 8, siege: 5, cavalry: 3, camel: 5, ship: 4 },
  armor: { melee: 0, pierce: 4 }, speed: 1.3, los: 6,
  classes: ['infantry', 'eagleWarrior'],
});

/* ------------------------------------------------------------------ *
 *  ARCHERY RANGE
 * ------------------------------------------------------------------ */

U('archer', {
  name: 'Archer', cat: 'archer', from: 'archeryRange', age: 'feudal',
  cost: { wood: 25, gold: 45 }, time: 35, hp: 30,
  atk: { pierce: 4 }, bonus: { spearman: 3 },
  armor: { melee: 0, pierce: 0 }, range: 4, reload: 2.03, speed: 0.96, los: 6,
  classes: ['archer'], upgradeTo: 'crossbowman', accuracy: 0.8,
});
U('crossbowman', {
  name: 'Crossbowman', cat: 'archer', from: 'archeryRange', age: 'castle',
  cost: { wood: 25, gold: 45 }, time: 27, hp: 35,
  atk: { pierce: 5 }, bonus: { spearman: 3 },
  armor: { melee: 0, pierce: 0 }, range: 5, reload: 2.03, speed: 0.96, los: 7,
  classes: ['archer'], upgradeTo: 'arbalester', accuracy: 0.85,
});
U('arbalester', {
  name: 'Arbalester', cat: 'archer', from: 'archeryRange', age: 'imperial',
  cost: { wood: 25, gold: 45 }, time: 27, hp: 40,
  atk: { pierce: 6 }, bonus: { spearman: 3 },
  armor: { melee: 0, pierce: 0 }, range: 5, reload: 2.03, speed: 0.96, los: 7,
  classes: ['archer'], accuracy: 0.85,
});

U('skirmisher', {
  name: 'Skirmisher', cat: 'archer', from: 'archeryRange', age: 'feudal',
  cost: { food: 25, wood: 35 }, time: 22, hp: 30,
  atk: { pierce: 2 }, bonus: { archer: 3, spearman: 3 },
  armor: { melee: 0, pierce: 3 }, range: 4, minRange: 1, reload: 3.0, speed: 0.96, los: 6,
  classes: ['archer'], upgradeTo: 'eliteSkirmisher', accuracy: 0.9,
});
U('eliteSkirmisher', {
  name: 'Elite Skirmisher', cat: 'archer', from: 'archeryRange', age: 'castle',
  cost: { food: 25, wood: 35 }, time: 22, hp: 35,
  atk: { pierce: 3 }, bonus: { archer: 4, spearman: 4, cavalryArcher: 2 },
  armor: { melee: 0, pierce: 4 }, range: 5, minRange: 1, reload: 3.0, speed: 0.96, los: 7,
  classes: ['archer'], accuracy: 0.9,
});

U('cavalryArcher', {
  name: 'Cavalry Archer', cat: 'archer', from: 'archeryRange', age: 'castle',
  cost: { wood: 40, gold: 60 }, time: 34, hp: 50,
  atk: { pierce: 6 }, bonus: { spearman: 3 },
  armor: { melee: 0, pierce: 0 }, range: 4, reload: 2.0, speed: 1.4, los: 5,
  classes: ['archer', 'cavalryArcher', 'cavalry'], upgradeTo: 'heavyCavalryArcher', accuracy: 0.5,
});
U('heavyCavalryArcher', {
  name: 'Heavy Cavalry Archer', cat: 'archer', from: 'archeryRange', age: 'imperial',
  cost: { wood: 40, gold: 60 }, time: 34, hp: 60,
  atk: { pierce: 7 }, bonus: { spearman: 4 },
  armor: { melee: 1, pierce: 0 }, range: 4, reload: 2.0, speed: 1.4, los: 6,
  classes: ['archer', 'cavalryArcher', 'cavalry'], accuracy: 0.5,
});

U('handCannoneer', {
  name: 'Hand Cannoneer', cat: 'archer', from: 'archeryRange', age: 'imperial',
  cost: { food: 45, gold: 50 }, time: 34, hp: 35,
  atk: { pierce: 17 }, bonus: { infantry: 10 },
  armor: { melee: 1, pierce: 0 }, range: 7, minRange: 0, reload: 3.45, speed: 0.96, los: 9,
  classes: ['archer', 'gunpowder'], accuracy: 0.65, projectileSpeed: 12,
});

/* ------------------------------------------------------------------ *
 *  STABLE
 * ------------------------------------------------------------------ */

U('scoutCavalry', {
  name: 'Scout Cavalry', cat: 'cavalry', from: 'stable', age: 'dark',
  cost: { food: 80 }, time: 30, hp: 45,
  atk: { melee: 3 }, bonus: { monk: 6 },
  armor: { melee: 0, pierce: 2 }, speed: 1.55, los: 4, reload: 2.0,
  classes: ['cavalry'], upgradeTo: 'lightCavalry', radius: 0.34,
});
U('lightCavalry', {
  name: 'Light Cavalry', cat: 'cavalry', from: 'stable', age: 'castle',
  cost: { food: 80 }, time: 30, hp: 60,
  atk: { melee: 7 }, bonus: { monk: 12 },
  armor: { melee: 0, pierce: 2 }, speed: 1.5, los: 8, reload: 2.0,
  classes: ['cavalry'], upgradeTo: 'hussar', radius: 0.34,
});
U('hussar', {
  name: 'Hussar', cat: 'cavalry', from: 'stable', age: 'imperial',
  cost: { food: 80 }, time: 30, hp: 75,
  atk: { melee: 7 }, bonus: { monk: 12 },
  armor: { melee: 0, pierce: 2 }, speed: 1.5, los: 10, reload: 2.0,
  classes: ['cavalry'], radius: 0.34,
});

U('knight', {
  name: 'Knight', cat: 'cavalry', from: 'stable', age: 'castle',
  cost: { food: 60, gold: 75 }, time: 30, hp: 100,
  atk: { melee: 10 }, armor: { melee: 2, pierce: 2 }, speed: 1.35, los: 4, reload: 1.8,
  classes: ['cavalry'], upgradeTo: 'cavalier', radius: 0.34,
});
U('cavalier', {
  name: 'Cavalier', cat: 'cavalry', from: 'stable', age: 'imperial',
  cost: { food: 60, gold: 75 }, time: 30, hp: 120,
  atk: { melee: 12 }, armor: { melee: 2, pierce: 2 }, speed: 1.35, los: 4, reload: 1.8,
  classes: ['cavalry'], upgradeTo: 'paladin', radius: 0.34,
});
U('paladin', {
  name: 'Paladin', cat: 'cavalry', from: 'stable', age: 'imperial',
  cost: { food: 60, gold: 75 }, time: 30, hp: 160,
  atk: { melee: 14 }, armor: { melee: 2, pierce: 3 }, speed: 1.35, los: 5, reload: 1.9,
  classes: ['cavalry'], radius: 0.34,
});

U('camelRider', {
  name: 'Camel Rider', cat: 'cavalry', from: 'stable', age: 'castle',
  cost: { food: 55, gold: 60 }, time: 22, hp: 100,
  atk: { melee: 6 }, bonus: { cavalry: 9, camel: 5, ship: 9 },
  armor: { melee: 0, pierce: 0 }, speed: 1.45, los: 4, reload: 2.0,
  classes: ['cavalry', 'camel'], upgradeTo: 'heavyCamelRider', radius: 0.34,
});
U('heavyCamelRider', {
  name: 'Heavy Camel Rider', cat: 'cavalry', from: 'stable', age: 'imperial',
  cost: { food: 55, gold: 60 }, time: 22, hp: 120,
  atk: { melee: 7 }, bonus: { cavalry: 18, camel: 6, ship: 9 },
  armor: { melee: 0, pierce: 0 }, speed: 1.45, los: 4, reload: 2.0,
  classes: ['cavalry', 'camel'], radius: 0.34,
});

U('battleElephant', {
  name: 'Battle Elephant', cat: 'cavalry', from: 'stable', age: 'castle',
  cost: { food: 120, gold: 70 }, time: 28, hp: 250,
  atk: { melee: 12 }, bonus: { building: 7 },
  armor: { melee: 1, pierce: 2 }, speed: 0.85, los: 4, reload: 2.0, blast: 0.5,
  classes: ['cavalry', 'elephant'], upgradeTo: 'eliteBattleElephant', radius: 0.45,
});
U('eliteBattleElephant', {
  name: 'Elite Battle Elephant', cat: 'cavalry', from: 'stable', age: 'imperial',
  cost: { food: 120, gold: 70 }, time: 24, hp: 300,
  atk: { melee: 14 }, bonus: { building: 7 },
  armor: { melee: 1, pierce: 3 }, speed: 0.85, los: 5, reload: 2.0, blast: 0.5,
  classes: ['cavalry', 'elephant'], radius: 0.45,
});

U('steppeLancer', {
  name: 'Steppe Lancer', cat: 'cavalry', from: 'stable', age: 'castle',
  cost: { food: 70, gold: 45 }, time: 24, hp: 60,
  atk: { melee: 9 }, armor: { melee: 0, pierce: 1, spearman: 0 }, speed: 1.45, los: 5,
  range: 1, reload: 2.0, classes: ['cavalry'], upgradeTo: 'eliteSteppeLancer', radius: 0.34,
});
U('eliteSteppeLancer', {
  name: 'Elite Steppe Lancer', cat: 'cavalry', from: 'stable', age: 'imperial',
  cost: { food: 70, gold: 45 }, time: 20, hp: 80,
  atk: { melee: 11 }, armor: { melee: 0, pierce: 1 }, speed: 1.45, los: 5,
  range: 1, reload: 2.0, classes: ['cavalry'], radius: 0.34,
});

/* ------------------------------------------------------------------ *
 *  SIEGE WORKSHOP
 * ------------------------------------------------------------------ */

U('batteringRam', {
  name: 'Battering Ram', cat: 'siege', from: 'siegeWorkshop', age: 'castle',
  cost: { wood: 160, gold: 75 }, time: 36, hp: 175,
  atk: { melee: 2 }, bonus: { building: 125, stoneDefense: 125, siege: 40, wall: 125 },
  armor: { melee: -3, pierce: 180 }, speed: 0.5, los: 3, reload: 5.0,
  classes: ['siege', 'ram'], upgradeTo: 'cappedRam', garrison: 4, radius: 0.45, pop: 1,
});
U('cappedRam', {
  name: 'Capped Ram', cat: 'siege', from: 'siegeWorkshop', age: 'imperial',
  cost: { wood: 160, gold: 75 }, time: 36, hp: 200,
  atk: { melee: 3 }, bonus: { building: 150, stoneDefense: 150, siege: 50, wall: 150 },
  armor: { melee: -3, pierce: 190 }, speed: 0.5, los: 3, reload: 5.0,
  classes: ['siege', 'ram'], upgradeTo: 'siegeRam', garrison: 4, radius: 0.45,
});
U('siegeRam', {
  name: 'Siege Ram', cat: 'siege', from: 'siegeWorkshop', age: 'imperial',
  cost: { wood: 160, gold: 75 }, time: 36, hp: 270,
  atk: { melee: 4 }, bonus: { building: 200, stoneDefense: 200, siege: 60, wall: 200 },
  armor: { melee: -3, pierce: 195 }, speed: 0.6, los: 3, reload: 5.0,
  classes: ['siege', 'ram'], garrison: 4, radius: 0.45,
});

U('mangonel', {
  name: 'Mangonel', cat: 'siege', from: 'siegeWorkshop', age: 'castle',
  cost: { wood: 160, gold: 135 }, time: 46, hp: 50,
  atk: { pierce: 40 }, bonus: { building: 35, stoneDefense: 35 },
  armor: { melee: 0, pierce: 6 }, range: 7, minRange: 2, reload: 6.0, speed: 0.6, los: 9,
  classes: ['siege'], upgradeTo: 'onager', blast: 1.0, projectileSpeed: 6, radius: 0.4,
});
U('onager', {
  name: 'Onager', cat: 'siege', from: 'siegeWorkshop', age: 'imperial',
  cost: { wood: 160, gold: 135 }, time: 46, hp: 60,
  atk: { pierce: 50 }, bonus: { building: 40, stoneDefense: 40 },
  armor: { melee: 0, pierce: 7 }, range: 8, minRange: 2, reload: 6.0, speed: 0.6, los: 10,
  classes: ['siege'], upgradeTo: 'siegeOnager', blast: 1.25, projectileSpeed: 6, radius: 0.4,
});
U('siegeOnager', {
  name: 'Siege Onager', cat: 'siege', from: 'siegeWorkshop', age: 'imperial',
  cost: { wood: 160, gold: 135 }, time: 46, hp: 70,
  atk: { pierce: 75 }, bonus: { building: 45, stoneDefense: 45 },
  armor: { melee: 0, pierce: 8 }, range: 8, minRange: 2, reload: 6.0, speed: 0.6, los: 10,
  classes: ['siege'], blast: 1.5, projectileSpeed: 6, radius: 0.4,
});

U('scorpion', {
  name: 'Scorpion', cat: 'siege', from: 'siegeWorkshop', age: 'castle',
  cost: { wood: 75, gold: 75 }, time: 30, hp: 40,
  atk: { pierce: 12 }, bonus: { elephant: 6, ship: 6, building: 2 },
  armor: { melee: 0, pierce: 6 }, range: 7, minRange: 1, reload: 3.6, speed: 0.65, los: 9,
  classes: ['siege'], upgradeTo: 'heavyScorpion', pierceLine: true, projectileSpeed: 8, radius: 0.4,
});
U('heavyScorpion', {
  name: 'Heavy Scorpion', cat: 'siege', from: 'siegeWorkshop', age: 'imperial',
  cost: { wood: 75, gold: 75 }, time: 30, hp: 50,
  atk: { pierce: 16 }, bonus: { elephant: 6, ship: 6, building: 3 },
  armor: { melee: 0, pierce: 7 }, range: 7, minRange: 1, reload: 3.6, speed: 0.65, los: 9,
  classes: ['siege'], pierceLine: true, projectileSpeed: 8, radius: 0.4,
});

U('bombardCannon', {
  name: 'Bombard Cannon', cat: 'siege', from: 'siegeWorkshop', age: 'imperial',
  cost: { wood: 225, gold: 225 }, time: 56, hp: 80,
  atk: { pierce: 40 }, bonus: { building: 40, stoneDefense: 200, siege: 40, ship: 40 },
  armor: { melee: 2, pierce: 5 }, range: 12, minRange: 3, reload: 6.5, speed: 0.7, los: 14,
  classes: ['siege', 'gunpowder'], blast: 0.5, projectileSpeed: 9, radius: 0.42,
});

U('siegeTower', {
  name: 'Siege Tower', cat: 'siege', from: 'siegeWorkshop', age: 'castle',
  cost: { wood: 200, gold: 160 }, time: 36, hp: 220,
  atk: {}, armor: { melee: -2, pierce: 100 }, speed: 0.8, los: 6,
  classes: ['siege'], garrison: 20, radius: 0.5,
});

/* ------------------------------------------------------------------ *
 *  CASTLE
 * ------------------------------------------------------------------ */

U('trebuchet', {
  name: 'Trebuchet', cat: 'siege', from: 'castle', age: 'imperial',
  cost: { wood: 200, gold: 200 }, time: 50, hp: 150,
  atk: { pierce: 200 }, bonus: { building: 250, stoneDefense: 250, wall: 250 },
  armor: { melee: 1, pierce: 150 }, range: 16, minRange: 5, reload: 10, speed: 0.8, los: 18,
  classes: ['siege'], blast: 0.5, projectileSpeed: 5, radius: 0.45, packable: true, pop: 1,
});
U('petard', {
  name: 'Petard', cat: 'siege', from: 'castle', age: 'castle',
  cost: { food: 65, gold: 20 }, time: 25, hp: 50,
  atk: { melee: 25 }, bonus: { building: 900, stoneDefense: 900, wall: 900, siege: 25 },
  armor: { melee: 0, pierce: 2 }, speed: 0.8, los: 4, reload: 1,
  classes: ['infantry'], suicide: true, blast: 1.0, radius: 0.28,
});

/* ------------------------------------------------------------------ *
 *  MONASTERY
 * ------------------------------------------------------------------ */

U('monk', {
  name: 'Monk', cat: 'monk', from: 'monastery', age: 'castle',
  cost: { gold: 100 }, time: 51, hp: 30,
  atk: {}, armor: { melee: 0, pierce: 0 }, range: 9, reload: 62, speed: 0.7, los: 11,
  classes: ['monk'], converts: true, healRate: 12, radius: 0.26,
});
U('missionary', {
  name: 'Missionary', cat: 'monk', from: 'monastery', age: 'castle',
  cost: { gold: 100 }, time: 51, hp: 45,
  atk: {}, armor: { melee: 0, pierce: 0 }, range: 7, reload: 62, speed: 1.1, los: 9,
  classes: ['monk', 'cavalry'], converts: true, healRate: 12, radius: 0.3,
});

/* ------------------------------------------------------------------ *
 *  DOCK
 * ------------------------------------------------------------------ */

U('fishingShip', {
  name: 'Fishing Ship', cat: 'naval', from: 'dock', age: 'dark', domain: 'water',
  cost: { wood: 75 }, time: 40, hp: 60, atk: {},
  armor: { melee: 0, pierce: 4 }, speed: 1.0, los: 5, classes: ['ship'], radius: 0.4,
});
U('transportShip', {
  name: 'Transport Ship', cat: 'naval', from: 'dock', age: 'feudal', domain: 'water',
  cost: { wood: 125 }, time: 46, hp: 150, atk: {},
  armor: { melee: 4, pierce: 8 }, speed: 1.45, los: 5, classes: ['ship'], garrison: 10, radius: 0.45,
});
U('tradeCog', {
  name: 'Trade Cog', cat: 'naval', from: 'dock', age: 'feudal', domain: 'water',
  cost: { wood: 100, gold: 50 }, time: 36, hp: 80, atk: {},
  armor: { melee: 0, pierce: 6 }, speed: 1.32, los: 6, classes: ['ship'], radius: 0.42,
});
U('galley', {
  name: 'Galley', cat: 'naval', from: 'dock', age: 'feudal', domain: 'water',
  cost: { wood: 90, gold: 30 }, time: 60, hp: 120,
  atk: { pierce: 6 }, bonus: { building: 6, ship: 0 },
  armor: { melee: 0, pierce: 6 }, range: 5, reload: 3.0, speed: 1.43, los: 7,
  classes: ['ship'], upgradeTo: 'warGalley', radius: 0.42,
});
U('warGalley', {
  name: 'War Galley', cat: 'naval', from: 'dock', age: 'castle', domain: 'water',
  cost: { wood: 90, gold: 30 }, time: 36, hp: 135,
  atk: { pierce: 7 }, bonus: { building: 7 },
  armor: { melee: 0, pierce: 6 }, range: 6, reload: 3.0, speed: 1.43, los: 8,
  classes: ['ship'], upgradeTo: 'galleon', radius: 0.42,
});
U('galleon', {
  name: 'Galleon', cat: 'naval', from: 'dock', age: 'imperial', domain: 'water',
  cost: { wood: 90, gold: 30 }, time: 36, hp: 165,
  atk: { pierce: 8 }, bonus: { building: 8 },
  armor: { melee: 0, pierce: 8 }, range: 7, reload: 3.0, speed: 1.43, los: 9,
  classes: ['ship'], radius: 0.42,
});
U('fireShip', {
  name: 'Fire Ship', cat: 'naval', from: 'dock', age: 'castle', domain: 'water',
  cost: { wood: 75, gold: 45 }, time: 36, hp: 120,
  atk: { pierce: 2 }, bonus: { ship: 3 },
  armor: { melee: 0, pierce: 6 }, range: 2.5, reload: 0.25, speed: 1.35, los: 5,
  classes: ['ship'], radius: 0.42,
});
U('demolitionShip', {
  name: 'Demolition Ship', cat: 'naval', from: 'dock', age: 'castle', domain: 'water',
  cost: { wood: 70, gold: 50 }, time: 31, hp: 60,
  atk: { melee: 110 }, bonus: { building: 220, ship: 0 },
  armor: { melee: 0, pierce: 3 }, speed: 1.6, los: 6, suicide: true, blast: 1.5,
  classes: ['ship'], radius: 0.4,
});
U('cannonGalleon', {
  name: 'Cannon Galleon', cat: 'naval', from: 'dock', age: 'imperial', domain: 'water',
  cost: { wood: 200, gold: 150 }, time: 46, hp: 120,
  atk: { pierce: 35 }, bonus: { building: 200, stoneDefense: 200 },
  armor: { melee: 0, pierce: 6 }, range: 13, minRange: 3, reload: 10, speed: 1.1, los: 15,
  classes: ['ship', 'gunpowder'], blast: 0.5, projectileSpeed: 7, radius: 0.42,
});

/* ------------------------------------------------------------------ *
 *  UNIQUE UNITS  (Castle-trained, one line per civilization)
 * ------------------------------------------------------------------ */

function UU(id, def) {
  return U(id, { ...def, from: 'castle', unique: true, cat: def.cat || 'infantry' });
}

// Aztecs
UU('jaguarWarrior', {
  name: 'Jaguar Warrior', age: 'castle', cost: { food: 60, gold: 30 }, time: 12, hp: 50,
  atk: { melee: 10 }, bonus: { infantry: 10 }, armor: { melee: 1, pierce: 1 }, speed: 1.0,
  classes: ['infantry', 'uniqueUnit'], upgradeTo: 'eliteJaguarWarrior',
});
UU('eliteJaguarWarrior', {
  name: 'Elite Jaguar Warrior', age: 'imperial', cost: { food: 60, gold: 30 }, time: 12, hp: 75,
  atk: { melee: 12 }, bonus: { infantry: 11 }, armor: { melee: 2, pierce: 1 }, speed: 1.0,
  classes: ['infantry', 'uniqueUnit'],
});

// Berbers
UU('camelArcher', {
  name: 'Camel Archer', cat: 'archer', age: 'castle', cost: { wood: 50, gold: 60 }, time: 21, hp: 55,
  atk: { pierce: 7 }, bonus: { archer: 6 }, armor: { melee: 0, pierce: 1 }, range: 4,
  reload: 2.0, speed: 1.4, los: 5, classes: ['archer', 'cavalryArcher', 'cavalry', 'camel', 'uniqueUnit'],
  upgradeTo: 'eliteCamelArcher', accuracy: 0.85, radius: 0.34,
});
UU('eliteCamelArcher', {
  name: 'Elite Camel Archer', cat: 'archer', age: 'imperial', cost: { wood: 50, gold: 60 }, time: 21, hp: 60,
  atk: { pierce: 8 }, bonus: { archer: 6 }, armor: { melee: 1, pierce: 1 }, range: 4,
  reload: 2.0, speed: 1.4, los: 6, classes: ['archer', 'cavalryArcher', 'cavalry', 'camel', 'uniqueUnit'],
  accuracy: 0.9, radius: 0.34,
});

// Britons
UU('longbowman', {
  name: 'Longbowman', cat: 'archer', age: 'castle', cost: { wood: 35, gold: 40 }, time: 18, hp: 35,
  atk: { pierce: 6 }, bonus: { spearman: 2 }, armor: { melee: 0, pierce: 0 }, range: 6,
  reload: 2.0, speed: 0.96, los: 9, classes: ['archer', 'uniqueUnit'], upgradeTo: 'eliteLongbowman', accuracy: 0.8,
});
UU('eliteLongbowman', {
  name: 'Elite Longbowman', cat: 'archer', age: 'imperial', cost: { wood: 35, gold: 40 }, time: 18, hp: 40,
  atk: { pierce: 7 }, bonus: { spearman: 3 }, armor: { melee: 0, pierce: 1 }, range: 8,
  reload: 2.0, speed: 0.96, los: 11, classes: ['archer', 'uniqueUnit'], accuracy: 0.85,
});

// Bulgarians
UU('konnik', {
  name: 'Konnik', cat: 'cavalry', age: 'castle', cost: { food: 60, gold: 70 }, time: 19, hp: 110,
  atk: { melee: 12 }, bonus: { building: 5 }, armor: { melee: 1, pierce: 2 }, speed: 1.35,
  classes: ['cavalry', 'uniqueUnit'], upgradeTo: 'eliteKonnik', dismount: true, radius: 0.34,
});
UU('eliteKonnik', {
  name: 'Elite Konnik', cat: 'cavalry', age: 'imperial', cost: { food: 60, gold: 70 }, time: 19, hp: 120,
  atk: { melee: 14 }, bonus: { building: 6 }, armor: { melee: 2, pierce: 2 }, speed: 1.35,
  classes: ['cavalry', 'uniqueUnit'], dismount: true, radius: 0.34,
});

// Burgundians
UU('coustillier', {
  name: 'Coustillier', cat: 'cavalry', age: 'castle', cost: { food: 55, gold: 55 }, time: 14, hp: 110,
  atk: { melee: 11 }, armor: { melee: 2, pierce: 1 }, speed: 1.35,
  classes: ['cavalry', 'uniqueUnit'], upgradeTo: 'eliteCoustillier', charge: 25, radius: 0.34,
});
UU('eliteCoustillier', {
  name: 'Elite Coustillier', cat: 'cavalry', age: 'imperial', cost: { food: 55, gold: 55 }, time: 14, hp: 145,
  atk: { melee: 13 }, armor: { melee: 2, pierce: 2 }, speed: 1.35,
  classes: ['cavalry', 'uniqueUnit'], charge: 35, radius: 0.34,
});

// Burmese
UU('arambai', {
  name: 'Arambai', cat: 'archer', age: 'castle', cost: { wood: 80, gold: 60 }, time: 21, hp: 60,
  atk: { pierce: 17 }, armor: { melee: 0, pierce: 1 }, range: 5, reload: 2.0, speed: 1.4,
  classes: ['archer', 'cavalryArcher', 'cavalry', 'uniqueUnit'], upgradeTo: 'eliteArambai',
  accuracy: 0.33, radius: 0.34,
});
UU('eliteArambai', {
  name: 'Elite Arambai', cat: 'archer', age: 'imperial', cost: { wood: 80, gold: 60 }, time: 21, hp: 65,
  atk: { pierce: 19 }, armor: { melee: 0, pierce: 2 }, range: 5, reload: 2.0, speed: 1.4,
  classes: ['archer', 'cavalryArcher', 'cavalry', 'uniqueUnit'], accuracy: 0.4, radius: 0.34,
});

// Byzantines - note the huge INFANTRY armor: it blanks Halberdier bonus damage.
UU('cataphract', {
  name: 'Cataphract', cat: 'cavalry', age: 'castle', cost: { food: 70, gold: 75 }, time: 20, hp: 110,
  atk: { melee: 9 }, bonus: { infantry: 9 }, armor: { melee: 2, pierce: 1, infantry: 12 },
  speed: 1.35, classes: ['cavalry', 'uniqueUnit'], upgradeTo: 'eliteCataphract', trample: 5, radius: 0.34,
});
UU('eliteCataphract', {
  name: 'Elite Cataphract', cat: 'cavalry', age: 'imperial', cost: { food: 70, gold: 75 }, time: 20, hp: 150,
  atk: { melee: 12 }, bonus: { infantry: 12 }, armor: { melee: 2, pierce: 1, infantry: 16 },
  speed: 1.35, classes: ['cavalry', 'uniqueUnit'], trample: 9, radius: 0.34,
});

// Celts
UU('woadRaider', {
  name: 'Woad Raider', age: 'castle', cost: { food: 65, gold: 25 }, time: 10, hp: 65,
  atk: { melee: 8 }, bonus: { building: 2 }, armor: { melee: 0, pierce: 1 }, speed: 1.2,
  classes: ['infantry', 'uniqueUnit'], upgradeTo: 'eliteWoadRaider',
});
UU('eliteWoadRaider', {
  name: 'Elite Woad Raider', age: 'imperial', cost: { food: 65, gold: 25 }, time: 10, hp: 80,
  atk: { melee: 13 }, bonus: { building: 2 }, armor: { melee: 0, pierce: 1 }, speed: 1.2,
  classes: ['infantry', 'uniqueUnit'],
});

// Chinese
UU('chuKoNu', {
  name: 'Chu Ko Nu', cat: 'archer', age: 'castle', cost: { wood: 40, gold: 35 }, time: 19, hp: 45,
  atk: { pierce: 8 }, bonus: { spearman: 2 }, armor: { melee: 0, pierce: 0 }, range: 4,
  reload: 3.0, speed: 0.96, los: 6, classes: ['archer', 'uniqueUnit'], upgradeTo: 'eliteChuKoNu',
  volley: 3, accuracy: 0.85,
});
UU('eliteChuKoNu', {
  name: 'Elite Chu Ko Nu', cat: 'archer', age: 'imperial', cost: { wood: 40, gold: 35 }, time: 13, hp: 50,
  atk: { pierce: 8 }, bonus: { spearman: 3 }, armor: { melee: 0, pierce: 0 }, range: 4,
  reload: 3.0, speed: 0.96, los: 6, classes: ['archer', 'uniqueUnit'], volley: 5, accuracy: 0.85,
});

// Cumans
UU('kipchak', {
  name: 'Kipchak', cat: 'archer', age: 'castle', cost: { food: 60, gold: 35 }, time: 12, hp: 45,
  atk: { pierce: 4 }, bonus: { spearman: 2 }, armor: { melee: 0, pierce: 0 }, range: 4,
  reload: 2.2, speed: 1.4, los: 5, classes: ['archer', 'cavalryArcher', 'cavalry', 'uniqueUnit'],
  upgradeTo: 'eliteKipchak', volley: 2, accuracy: 0.55, radius: 0.34,
});
UU('eliteKipchak', {
  name: 'Elite Kipchak', cat: 'archer', age: 'imperial', cost: { food: 60, gold: 35 }, time: 12, hp: 60,
  atk: { pierce: 5 }, bonus: { spearman: 2 }, armor: { melee: 0, pierce: 1 }, range: 4,
  reload: 2.2, speed: 1.4, los: 6, classes: ['archer', 'cavalryArcher', 'cavalry', 'uniqueUnit'],
  volley: 3, accuracy: 0.6, radius: 0.34,
});

// Ethiopians
UU('shotelWarrior', {
  name: 'Shotel Warrior', age: 'castle', cost: { food: 50, gold: 35 }, time: 8, hp: 40,
  atk: { melee: 16 }, armor: { melee: 0, pierce: 0 }, speed: 1.2,
  classes: ['infantry', 'uniqueUnit'], upgradeTo: 'eliteShotelWarrior',
});
UU('eliteShotelWarrior', {
  name: 'Elite Shotel Warrior', age: 'imperial', cost: { food: 50, gold: 35 }, time: 8, hp: 50,
  atk: { melee: 18 }, armor: { melee: 1, pierce: 0 }, speed: 1.2,
  classes: ['infantry', 'uniqueUnit'],
});

// Franks
UU('throwingAxeman', {
  name: 'Throwing Axeman', cat: 'archer', age: 'castle', cost: { food: 55, gold: 25 }, time: 17, hp: 50,
  atk: { melee: 7 }, bonus: { infantry: 2 }, armor: { melee: 0, pierce: 1 }, range: 3,
  reload: 2.0, speed: 1.0, los: 5, classes: ['infantry', 'uniqueUnit'], upgradeTo: 'eliteThrowingAxeman',
  accuracy: 1.0,
});
UU('eliteThrowingAxeman', {
  name: 'Elite Throwing Axeman', cat: 'archer', age: 'imperial', cost: { food: 55, gold: 25 }, time: 17, hp: 60,
  atk: { melee: 8 }, bonus: { infantry: 3 }, armor: { melee: 1, pierce: 1 }, range: 4,
  reload: 2.0, speed: 1.0, los: 6, classes: ['infantry', 'uniqueUnit'], accuracy: 1.0,
});

// Goths - the archer-proof infantry
UU('huskarl', {
  name: 'Huskarl', age: 'castle', cost: { food: 52, gold: 26 }, time: 16, hp: 60,
  atk: { melee: 10 }, bonus: { archer: 6, building: 2 }, armor: { melee: 0, pierce: 6 }, speed: 1.05,
  classes: ['infantry', 'uniqueUnit'], upgradeTo: 'eliteHuskarl',
});
UU('eliteHuskarl', {
  name: 'Elite Huskarl', age: 'imperial', cost: { food: 52, gold: 26 }, time: 16, hp: 70,
  atk: { melee: 12 }, bonus: { archer: 8, building: 3 }, armor: { melee: 0, pierce: 8 }, speed: 1.05,
  classes: ['infantry', 'uniqueUnit'],
});

// Huns
UU('tarkan', {
  name: 'Tarkan', cat: 'cavalry', age: 'castle', cost: { food: 60, gold: 60 }, time: 14, hp: 100,
  atk: { melee: 8 }, bonus: { building: 8, stoneDefense: 8, wall: 8 }, armor: { melee: 1, pierce: 3 },
  speed: 1.35, classes: ['cavalry', 'uniqueUnit'], upgradeTo: 'eliteTarkan', radius: 0.34,
});
UU('eliteTarkan', {
  name: 'Elite Tarkan', cat: 'cavalry', age: 'imperial', cost: { food: 60, gold: 60 }, time: 14, hp: 150,
  atk: { melee: 11 }, bonus: { building: 12, stoneDefense: 12, wall: 12 }, armor: { melee: 1, pierce: 4 },
  speed: 1.35, classes: ['cavalry', 'uniqueUnit'], radius: 0.34,
});

// Incas
UU('kamayuk', {
  name: 'Kamayuk', age: 'castle', cost: { food: 60, gold: 30 }, time: 10, hp: 60,
  atk: { melee: 7 }, bonus: { cavalry: 8, elephant: 8, camel: 8 }, armor: { melee: 0, pierce: 0 },
  range: 1, speed: 1.0, classes: ['infantry', 'spearman', 'uniqueUnit'], upgradeTo: 'eliteKamayuk',
});
UU('eliteKamayuk', {
  name: 'Elite Kamayuk', age: 'imperial', cost: { food: 60, gold: 30 }, time: 10, hp: 80,
  atk: { melee: 8 }, bonus: { cavalry: 11, elephant: 11, camel: 11 }, armor: { melee: 1, pierce: 0 },
  range: 1, speed: 1.0, classes: ['infantry', 'spearman', 'uniqueUnit'],
});

// Hindustanis
UU('ghulam', {
  name: 'Ghulam', age: 'castle', cost: { food: 50, gold: 30 }, time: 10, hp: 55,
  atk: { melee: 10 }, bonus: { archer: 6 }, armor: { melee: 0, pierce: 1 }, speed: 1.05,
  classes: ['infantry', 'uniqueUnit'], upgradeTo: 'eliteGhulam', pierceLine: true,
});
UU('eliteGhulam', {
  name: 'Elite Ghulam', age: 'imperial', cost: { food: 50, gold: 30 }, time: 10, hp: 70,
  atk: { melee: 12 }, bonus: { archer: 8 }, armor: { melee: 1, pierce: 1 }, speed: 1.05,
  classes: ['infantry', 'uniqueUnit'], pierceLine: true,
});
U('imperialCamelRider', {
  name: 'Imperial Camel Rider', cat: 'cavalry', from: 'stable', age: 'imperial',
  cost: { food: 55, gold: 60 }, time: 20, hp: 140,
  atk: { melee: 9 }, bonus: { cavalry: 20, camel: 6, ship: 9 },
  armor: { melee: 0, pierce: 0 }, speed: 1.45, los: 5, reload: 2.0,
  classes: ['cavalry', 'camel'], radius: 0.34,
});

// Italians
UU('genoeseCrossbowman', {
  name: 'Genoese Crossbowman', cat: 'archer', age: 'castle', cost: { food: 45, gold: 45 }, time: 22, hp: 45,
  atk: { pierce: 6 }, bonus: { cavalry: 7, camel: 7, elephant: 7 }, armor: { melee: 0, pierce: 0 },
  range: 4, reload: 3.0, speed: 0.96, los: 7, classes: ['archer', 'uniqueUnit'],
  upgradeTo: 'eliteGenoeseCrossbowman', accuracy: 1.0,
});
UU('eliteGenoeseCrossbowman', {
  name: 'Elite Genoese Crossbowman', cat: 'archer', age: 'imperial', cost: { food: 45, gold: 45 }, time: 22, hp: 50,
  atk: { pierce: 6 }, bonus: { cavalry: 10, camel: 10, elephant: 10 }, armor: { melee: 0, pierce: 0 },
  range: 4, reload: 3.0, speed: 0.96, los: 7, classes: ['archer', 'uniqueUnit'], accuracy: 1.0,
});

// Japanese
UU('samurai', {
  name: 'Samurai', age: 'castle', cost: { food: 60, gold: 30 }, time: 9, hp: 60,
  atk: { melee: 8 }, bonus: { uniqueUnit: 10, building: 2 }, armor: { melee: 1, pierce: 1 }, speed: 1.0,
  classes: ['infantry', 'uniqueUnit'], upgradeTo: 'eliteSamurai', reload: 1.9,
});
UU('eliteSamurai', {
  name: 'Elite Samurai', age: 'imperial', cost: { food: 60, gold: 30 }, time: 9, hp: 80,
  atk: { melee: 12 }, bonus: { uniqueUnit: 12, building: 2 }, armor: { melee: 1, pierce: 1 }, speed: 1.0,
  classes: ['infantry', 'uniqueUnit'], reload: 1.9,
});

// Khmer
UU('ballistaElephant', {
  name: 'Ballista Elephant', cat: 'archer', age: 'castle', cost: { food: 100, gold: 80 }, time: 25, hp: 250,
  atk: { pierce: 8 }, bonus: { building: 2 }, armor: { melee: 0, pierce: 2 }, range: 5,
  reload: 2.5, speed: 0.85, los: 7, classes: ['cavalry', 'elephant', 'siege', 'uniqueUnit'],
  upgradeTo: 'eliteBallistaElephant', pierceLine: true, radius: 0.45,
});
UU('eliteBallistaElephant', {
  name: 'Elite Ballista Elephant', cat: 'archer', age: 'imperial', cost: { food: 100, gold: 80 }, time: 25, hp: 290,
  atk: { pierce: 11 }, bonus: { building: 3 }, armor: { melee: 0, pierce: 3 }, range: 5,
  reload: 2.5, speed: 0.85, los: 7, classes: ['cavalry', 'elephant', 'siege', 'uniqueUnit'],
  pierceLine: true, radius: 0.45,
});

// Koreans
UU('warWagon', {
  name: 'War Wagon', cat: 'archer', age: 'castle', cost: { wood: 120, gold: 60 }, time: 25, hp: 150,
  atk: { pierce: 9 }, bonus: { building: 3 }, armor: { melee: 0, pierce: 3 }, range: 5,
  reload: 2.5, speed: 1.2, los: 7, classes: ['archer', 'cavalryArcher', 'cavalry', 'uniqueUnit'],
  upgradeTo: 'eliteWarWagon', accuracy: 0.8, radius: 0.4,
});
UU('eliteWarWagon', {
  name: 'Elite War Wagon', cat: 'archer', age: 'imperial', cost: { wood: 120, gold: 60 }, time: 25, hp: 200,
  atk: { pierce: 9 }, bonus: { building: 4 }, armor: { melee: 0, pierce: 4 }, range: 6,
  reload: 2.5, speed: 1.2, los: 8, classes: ['archer', 'cavalryArcher', 'cavalry', 'uniqueUnit'],
  accuracy: 0.85, radius: 0.4,
});

// Lithuanians
UU('leitis', {
  name: 'Leitis', cat: 'cavalry', age: 'castle', cost: { food: 70, gold: 50 }, time: 18, hp: 100,
  atk: { melee: 13 }, armor: { melee: 1, pierce: 1 }, speed: 1.35,
  classes: ['cavalry', 'uniqueUnit'], upgradeTo: 'eliteLeitis', ignoreArmor: true, radius: 0.34,
});
UU('eliteLeitis', {
  name: 'Elite Leitis', cat: 'cavalry', age: 'imperial', cost: { food: 70, gold: 50 }, time: 18, hp: 130,
  atk: { melee: 15 }, armor: { melee: 2, pierce: 1 }, speed: 1.35,
  classes: ['cavalry', 'uniqueUnit'], ignoreArmor: true, radius: 0.34,
});

// Magyars
UU('magyarHuszar', {
  name: 'Magyar Huszar', cat: 'cavalry', age: 'castle', cost: { food: 80, gold: 10 }, time: 16, hp: 70,
  atk: { melee: 9 }, bonus: { siege: 6 }, armor: { melee: 0, pierce: 2 }, speed: 1.5,
  classes: ['cavalry', 'uniqueUnit'], upgradeTo: 'eliteMagyarHuszar', radius: 0.34,
});
UU('eliteMagyarHuszar', {
  name: 'Elite Magyar Huszar', cat: 'cavalry', age: 'imperial', cost: { food: 80, gold: 10 }, time: 16, hp: 85,
  atk: { melee: 10 }, bonus: { siege: 12 }, armor: { melee: 0, pierce: 2 }, speed: 1.5,
  classes: ['cavalry', 'uniqueUnit'], radius: 0.34,
});

// Malay
UU('karambitWarrior', {
  name: 'Karambit Warrior', age: 'castle', cost: { food: 30, gold: 15 }, time: 6, hp: 30,
  atk: { melee: 7 }, bonus: { eagleWarrior: 2 }, armor: { melee: 0, pierce: 1 }, speed: 1.05,
  classes: ['infantry', 'uniqueUnit'], upgradeTo: 'eliteKarambitWarrior', pop: 0.5, radius: 0.22,
});
UU('eliteKarambitWarrior', {
  name: 'Elite Karambit Warrior', age: 'imperial', cost: { food: 30, gold: 15 }, time: 6, hp: 40,
  atk: { melee: 9 }, bonus: { eagleWarrior: 4 }, armor: { melee: 1, pierce: 2 }, speed: 1.05,
  classes: ['infantry', 'uniqueUnit'], pop: 0.5, radius: 0.22,
});

// Malians
UU('gbeto', {
  name: 'Gbeto', cat: 'archer', age: 'castle', cost: { food: 50, gold: 40 }, time: 17, hp: 45,
  atk: { melee: 10 }, armor: { melee: 0, pierce: 0 }, range: 5, reload: 2.0, speed: 1.15, los: 7,
  classes: ['infantry', 'uniqueUnit'], upgradeTo: 'eliteGbeto', accuracy: 1.0,
});
UU('eliteGbeto', {
  name: 'Elite Gbeto', cat: 'archer', age: 'imperial', cost: { food: 50, gold: 40 }, time: 17, hp: 50,
  atk: { melee: 13 }, armor: { melee: 0, pierce: 1 }, range: 6, reload: 2.0, speed: 1.15, los: 8,
  classes: ['infantry', 'uniqueUnit'], accuracy: 1.0,
});

// Mayans
UU('plumedArcher', {
  name: 'Plumed Archer', cat: 'archer', age: 'castle', cost: { wood: 50, gold: 50 }, time: 16, hp: 50,
  atk: { pierce: 5 }, bonus: { infantry: 2, spearman: 3 }, armor: { melee: 0, pierce: 1 }, range: 5,
  reload: 2.0, speed: 1.2, los: 7, classes: ['archer', 'uniqueUnit'], upgradeTo: 'elitePlumedArcher',
  accuracy: 0.9,
});
UU('elitePlumedArcher', {
  name: 'Elite Plumed Archer', cat: 'archer', age: 'imperial', cost: { wood: 50, gold: 50 }, time: 16, hp: 65,
  atk: { pierce: 5 }, bonus: { infantry: 3, spearman: 4 }, armor: { melee: 0, pierce: 2 }, range: 5,
  reload: 2.0, speed: 1.2, los: 7, classes: ['archer', 'uniqueUnit'], accuracy: 0.95,
});

// Mongols
UU('mangudai', {
  name: 'Mangudai', cat: 'archer', age: 'castle', cost: { wood: 55, gold: 65 }, time: 26, hp: 60,
  atk: { pierce: 6 }, bonus: { siege: 3, spearman: 3 }, armor: { melee: 0, pierce: 0 }, range: 4,
  reload: 2.1, speed: 1.4, los: 6, classes: ['archer', 'cavalryArcher', 'cavalry', 'uniqueUnit'],
  upgradeTo: 'eliteMangudai', accuracy: 0.65, radius: 0.34,
});
UU('eliteMangudai', {
  name: 'Elite Mangudai', cat: 'archer', age: 'imperial', cost: { wood: 55, gold: 65 }, time: 26, hp: 60,
  atk: { pierce: 8 }, bonus: { siege: 5, spearman: 3 }, armor: { melee: 1, pierce: 0 }, range: 4,
  reload: 2.1, speed: 1.4, los: 6, classes: ['archer', 'cavalryArcher', 'cavalry', 'uniqueUnit'],
  accuracy: 0.7, radius: 0.34,
});

// Persians
UU('warElephant', {
  name: 'War Elephant', cat: 'cavalry', age: 'castle', cost: { food: 200, gold: 75 }, time: 31, hp: 450,
  atk: { melee: 15 }, bonus: { building: 7, stoneDefense: 7, wall: 7 }, armor: { melee: 1, pierce: 2 },
  speed: 0.6, classes: ['cavalry', 'elephant', 'uniqueUnit'], upgradeTo: 'eliteWarElephant',
  trample: 5, radius: 0.5,
});
UU('eliteWarElephant', {
  name: 'Elite War Elephant', cat: 'cavalry', age: 'imperial', cost: { food: 200, gold: 75 }, time: 31, hp: 600,
  atk: { melee: 20 }, bonus: { building: 10, stoneDefense: 10, wall: 10 }, armor: { melee: 2, pierce: 3 },
  speed: 0.6, classes: ['cavalry', 'elephant', 'uniqueUnit'], trample: 8, radius: 0.5,
});

// Poles
UU('obuch', {
  name: 'Obuch', age: 'castle', cost: { food: 55, gold: 20 }, time: 13, hp: 65,
  atk: { melee: 8 }, armor: { melee: 1, pierce: 1 }, speed: 0.95,
  classes: ['infantry', 'uniqueUnit'], upgradeTo: 'eliteObuch', shredArmor: 1,
});
UU('eliteObuch', {
  name: 'Elite Obuch', age: 'imperial', cost: { food: 55, gold: 20 }, time: 13, hp: 80,
  atk: { melee: 10 }, armor: { melee: 2, pierce: 2 }, speed: 0.95,
  classes: ['infantry', 'uniqueUnit'], shredArmor: 1,
});

// Portuguese
UU('organGun', {
  name: 'Organ Gun', cat: 'siege', age: 'castle', cost: { wood: 80, gold: 60 }, time: 21, hp: 60,
  atk: { pierce: 16 }, bonus: { building: 2 }, armor: { melee: 2, pierce: 4 }, range: 7,
  reload: 3.45, speed: 0.85, los: 9, classes: ['siege', 'gunpowder', 'uniqueUnit'],
  upgradeTo: 'eliteOrganGun', volley: 5, accuracy: 0.5, projectileSpeed: 12, radius: 0.4,
});
UU('eliteOrganGun', {
  name: 'Elite Organ Gun', cat: 'siege', age: 'imperial', cost: { wood: 80, gold: 60 }, time: 21, hp: 70,
  atk: { pierce: 20 }, bonus: { building: 4 }, armor: { melee: 2, pierce: 6 }, range: 7,
  reload: 3.45, speed: 0.85, los: 9, classes: ['siege', 'gunpowder', 'uniqueUnit'],
  volley: 6, accuracy: 0.55, projectileSpeed: 12, radius: 0.4,
});

// Saracens
UU('mameluke', {
  name: 'Mameluke', cat: 'cavalry', age: 'castle', cost: { food: 55, gold: 85 }, time: 23, hp: 65,
  atk: { melee: 7 }, bonus: { cavalry: 9, camel: 12 }, armor: { melee: 0, pierce: 0 }, range: 3,
  reload: 2.0, speed: 1.4, los: 5, classes: ['cavalry', 'camel', 'uniqueUnit'],
  upgradeTo: 'eliteMameluke', accuracy: 1.0, radius: 0.34,
});
UU('eliteMameluke', {
  name: 'Elite Mameluke', cat: 'cavalry', age: 'imperial', cost: { food: 55, gold: 85 }, time: 23, hp: 80,
  atk: { melee: 10 }, bonus: { cavalry: 12, camel: 14 }, armor: { melee: 1, pierce: 0 }, range: 3,
  reload: 2.0, speed: 1.4, los: 5, classes: ['cavalry', 'camel', 'uniqueUnit'], accuracy: 1.0, radius: 0.34,
});

// Sicilians
UU('serjeant', {
  name: 'Serjeant', age: 'castle', cost: { food: 60, gold: 35 }, time: 13, hp: 70,
  atk: { melee: 9 }, armor: { melee: 4, pierce: 4 }, speed: 0.9,
  classes: ['infantry', 'uniqueUnit'], upgradeTo: 'eliteSerjeant', canBuildDonjon: true,
});
UU('eliteSerjeant', {
  name: 'Elite Serjeant', age: 'imperial', cost: { food: 60, gold: 35 }, time: 13, hp: 85,
  atk: { melee: 11 }, armor: { melee: 6, pierce: 5 }, speed: 0.9,
  classes: ['infantry', 'uniqueUnit'], canBuildDonjon: true,
});

// Slavs
UU('boyar', {
  name: 'Boyar', cat: 'cavalry', age: 'castle', cost: { food: 50, gold: 80 }, time: 20, hp: 100,
  atk: { melee: 12 }, armor: { melee: 4, pierce: 1 }, speed: 1.35,
  classes: ['cavalry', 'uniqueUnit'], upgradeTo: 'eliteBoyar', radius: 0.34,
});
UU('eliteBoyar', {
  name: 'Elite Boyar', cat: 'cavalry', age: 'imperial', cost: { food: 50, gold: 80 }, time: 20, hp: 130,
  atk: { melee: 14 }, armor: { melee: 6, pierce: 2 }, speed: 1.35,
  classes: ['cavalry', 'uniqueUnit'], radius: 0.34,
});

// Spanish
UU('conquistador', {
  name: 'Conquistador', cat: 'archer', age: 'castle', cost: { food: 60, gold: 70 }, time: 24, hp: 55,
  atk: { pierce: 16 }, bonus: { infantry: 12 }, armor: { melee: 2, pierce: 2 }, range: 6,
  reload: 2.9, speed: 1.3, los: 8, classes: ['cavalry', 'archer', 'gunpowder', 'uniqueUnit'],
  upgradeTo: 'eliteConquistador', accuracy: 0.65, projectileSpeed: 12, radius: 0.34,
});
UU('eliteConquistador', {
  name: 'Elite Conquistador', cat: 'archer', age: 'imperial', cost: { food: 60, gold: 70 }, time: 24, hp: 70,
  atk: { pierce: 18 }, bonus: { infantry: 12 }, armor: { melee: 2, pierce: 2 }, range: 6,
  reload: 2.9, speed: 1.3, los: 8, classes: ['cavalry', 'archer', 'gunpowder', 'uniqueUnit'],
  accuracy: 0.7, projectileSpeed: 12, radius: 0.34,
});

// Tatars
UU('keshik', {
  name: 'Keshik', cat: 'cavalry', age: 'castle', cost: { food: 50, gold: 60 }, time: 14, hp: 110,
  atk: { melee: 11 }, armor: { melee: 0, pierce: 2 }, speed: 1.4,
  classes: ['cavalry', 'uniqueUnit'], upgradeTo: 'eliteKeshik', goldOnHit: 0.5, radius: 0.34,
});
UU('eliteKeshik', {
  name: 'Elite Keshik', cat: 'cavalry', age: 'imperial', cost: { food: 50, gold: 60 }, time: 14, hp: 140,
  atk: { melee: 13 }, armor: { melee: 1, pierce: 2 }, speed: 1.4,
  classes: ['cavalry', 'uniqueUnit'], goldOnHit: 0.75, radius: 0.34,
});

// Teutons
UU('teutonicKnight', {
  name: 'Teutonic Knight', age: 'castle', cost: { food: 85, gold: 40 }, time: 12, hp: 80,
  atk: { melee: 12 }, bonus: { eagleWarrior: 4 }, armor: { melee: 5, pierce: 1 }, speed: 0.8,
  classes: ['infantry', 'uniqueUnit'], upgradeTo: 'eliteTeutonicKnight',
});
UU('eliteTeutonicKnight', {
  name: 'Elite Teutonic Knight', age: 'imperial', cost: { food: 85, gold: 40 }, time: 12, hp: 100,
  atk: { melee: 17 }, bonus: { eagleWarrior: 6 }, armor: { melee: 10, pierce: 2 }, speed: 0.8,
  classes: ['infantry', 'uniqueUnit'],
});

// Turks
UU('janissary', {
  name: 'Janissary', cat: 'archer', age: 'castle', cost: { food: 60, gold: 55 }, time: 17, hp: 44,
  atk: { pierce: 17 }, bonus: { building: 2 }, armor: { melee: 1, pierce: 0 }, range: 8,
  reload: 3.45, speed: 0.96, los: 10, classes: ['archer', 'gunpowder', 'uniqueUnit'],
  upgradeTo: 'eliteJanissary', accuracy: 0.65, projectileSpeed: 12,
});
UU('eliteJanissary', {
  name: 'Elite Janissary', cat: 'archer', age: 'imperial', cost: { food: 60, gold: 55 }, time: 17, hp: 50,
  atk: { pierce: 22 }, bonus: { building: 3 }, armor: { melee: 2, pierce: 0 }, range: 8,
  reload: 3.45, speed: 0.96, los: 10, classes: ['archer', 'gunpowder', 'uniqueUnit'],
  accuracy: 0.75, projectileSpeed: 12,
});

// Vietnamese
UU('rattanArcher', {
  name: 'Rattan Archer', cat: 'archer', age: 'castle', cost: { wood: 50, gold: 45 }, time: 16, hp: 40,
  atk: { pierce: 7 }, bonus: { spearman: 2 }, armor: { melee: 0, pierce: 6 }, range: 5,
  reload: 2.0, speed: 1.0, los: 7, classes: ['archer', 'uniqueUnit'], upgradeTo: 'eliteRattanArcher',
  accuracy: 0.85,
});
UU('eliteRattanArcher', {
  name: 'Elite Rattan Archer', cat: 'archer', age: 'imperial', cost: { wood: 50, gold: 45 }, time: 16, hp: 45,
  atk: { pierce: 8 }, bonus: { spearman: 3 }, armor: { melee: 0, pierce: 8 }, range: 5,
  reload: 2.0, speed: 1.0, los: 7, classes: ['archer', 'uniqueUnit'], accuracy: 0.9,
});

// Vikings
UU('berserk', {
  name: 'Berserk', age: 'castle', cost: { food: 65, gold: 25 }, time: 14, hp: 54,
  atk: { melee: 9 }, bonus: { building: 2 }, armor: { melee: 0, pierce: 1 }, speed: 1.05,
  classes: ['infantry', 'uniqueUnit'], upgradeTo: 'eliteBerserk', regen: 0.4,
});
UU('eliteBerserk', {
  name: 'Elite Berserk', age: 'imperial', cost: { food: 65, gold: 25 }, time: 14, hp: 62,
  atk: { melee: 14 }, bonus: { building: 3 }, armor: { melee: 2, pierce: 1 }, speed: 1.05,
  classes: ['infantry', 'uniqueUnit'], regen: 0.75,
});

// Bohemians
UU('hussiteWagon', {
  name: 'Hussite Wagon', cat: 'siege', age: 'castle', cost: { wood: 110, gold: 70 }, time: 21, hp: 200,
  atk: { pierce: 8 }, bonus: { building: 2 }, armor: { melee: 3, pierce: 8 }, range: 4,
  reload: 2.5, speed: 0.8, los: 7, classes: ['siege', 'gunpowder', 'uniqueUnit'],
  upgradeTo: 'eliteHussiteWagon', volley: 3, accuracy: 0.6, radius: 0.42,
});
UU('eliteHussiteWagon', {
  name: 'Elite Hussite Wagon', cat: 'siege', age: 'imperial', cost: { wood: 110, gold: 70 }, time: 21, hp: 250,
  atk: { pierce: 10 }, bonus: { building: 3 }, armor: { melee: 4, pierce: 10 }, range: 4,
  reload: 2.5, speed: 0.8, los: 7, classes: ['siege', 'gunpowder', 'uniqueUnit'],
  volley: 4, accuracy: 0.65, radius: 0.42,
});

// Dravidians
UU('urumiSwordsman', {
  name: 'Urumi Swordsman', age: 'castle', cost: { food: 60, gold: 40 }, time: 12, hp: 55,
  atk: { melee: 7 }, armor: { melee: 0, pierce: 1 }, speed: 0.95,
  classes: ['infantry', 'uniqueUnit'], upgradeTo: 'eliteUrumiSwordsman', charge: 15, blast: 0.4,
});
UU('eliteUrumiSwordsman', {
  name: 'Elite Urumi Swordsman', age: 'imperial', cost: { food: 60, gold: 40 }, time: 12, hp: 65,
  atk: { melee: 9 }, armor: { melee: 1, pierce: 1 }, speed: 0.95,
  classes: ['infantry', 'uniqueUnit'], charge: 20, blast: 0.4,
});

// Bengalis
UU('ratha', {
  name: 'Ratha', cat: 'archer', age: 'castle', cost: { wood: 70, gold: 50 }, time: 20, hp: 115,
  atk: { pierce: 7 }, armor: { melee: 0, pierce: 1 }, range: 5, reload: 2.0, speed: 1.2, los: 7,
  classes: ['cavalry', 'archer', 'cavalryArcher', 'uniqueUnit'], upgradeTo: 'eliteRatha',
  accuracy: 0.8, radius: 0.4,
});
UU('eliteRatha', {
  name: 'Elite Ratha', cat: 'archer', age: 'imperial', cost: { wood: 70, gold: 50 }, time: 20, hp: 130,
  atk: { pierce: 8 }, armor: { melee: 1, pierce: 2 }, range: 5, reload: 2.0, speed: 1.2, los: 8,
  classes: ['cavalry', 'archer', 'cavalryArcher', 'uniqueUnit'], accuracy: 0.85, radius: 0.4,
});

// Gurjaras
UU('shrivamshaRider', {
  name: 'Shrivamsha Rider', cat: 'cavalry', age: 'castle', cost: { food: 70, gold: 30 }, time: 16, hp: 80,
  atk: { melee: 8 }, armor: { melee: 0, pierce: 0 }, speed: 1.55,
  classes: ['cavalry', 'uniqueUnit'], upgradeTo: 'eliteShrivamshaRider', dodges: 2, radius: 0.34,
});
UU('eliteShrivamshaRider', {
  name: 'Elite Shrivamsha Rider', cat: 'cavalry', age: 'imperial', cost: { food: 70, gold: 30 }, time: 16, hp: 110,
  atk: { melee: 10 }, armor: { melee: 1, pierce: 0 }, speed: 1.55,
  classes: ['cavalry', 'uniqueUnit'], dodges: 3, radius: 0.34,
});

// Armenians
UU('compositeBowman', {
  name: 'Composite Bowman', cat: 'archer', age: 'castle', cost: { wood: 35, gold: 40 }, time: 16, hp: 45,
  atk: { pierce: 7 }, bonus: { spearman: 2 }, armor: { melee: 0, pierce: 0 }, range: 5,
  reload: 2.0, speed: 0.96, los: 7, classes: ['archer', 'uniqueUnit'], upgradeTo: 'eliteCompositeBowman',
  accuracy: 1.0, ignorePierceArmor: 1,
});
UU('eliteCompositeBowman', {
  name: 'Elite Composite Bowman', cat: 'archer', age: 'imperial', cost: { wood: 35, gold: 40 }, time: 16, hp: 55,
  atk: { pierce: 8 }, bonus: { spearman: 3 }, armor: { melee: 0, pierce: 1 }, range: 5,
  reload: 2.0, speed: 0.96, los: 7, classes: ['archer', 'uniqueUnit'], accuracy: 1.0, ignorePierceArmor: 2,
});

// Georgians
UU('monaspa', {
  name: 'Monaspa', cat: 'cavalry', age: 'castle', cost: { food: 70, gold: 40 }, time: 17, hp: 105,
  atk: { melee: 10 }, armor: { melee: 1, pierce: 2 }, speed: 1.35,
  classes: ['cavalry', 'uniqueUnit'], upgradeTo: 'eliteMonaspa', pack: true, radius: 0.34,
});
UU('eliteMonaspa', {
  name: 'Elite Monaspa', cat: 'cavalry', age: 'imperial', cost: { food: 70, gold: 40 }, time: 17, hp: 125,
  atk: { melee: 12 }, armor: { melee: 2, pierce: 2 }, speed: 1.35,
  classes: ['cavalry', 'uniqueUnit'], pack: true, radius: 0.34,
});

// Romans
UU('legionary', {
  name: 'Legionary', age: 'castle', cost: { food: 50, gold: 30 }, time: 12, hp: 75,
  atk: { melee: 11 }, bonus: { eagleWarrior: 4 }, armor: { melee: 2, pierce: 1 }, speed: 0.9,
  classes: ['infantry', 'uniqueUnit'], upgradeTo: 'eliteLegionary',
});
UU('eliteLegionary', {
  name: 'Elite Legionary', age: 'imperial', cost: { food: 50, gold: 30 }, time: 12, hp: 90,
  atk: { melee: 13 }, bonus: { eagleWarrior: 6 }, armor: { melee: 3, pierce: 1 }, speed: 0.9,
  classes: ['infantry', 'uniqueUnit'],
});

// Condottiero (Italian team unit, anti-gunpowder)
U('condottiero', {
  name: 'Condottiero', from: 'barracks', age: 'imperial',
  cost: { food: 50, gold: 35 }, time: 18, hp: 80,
  atk: { melee: 9 }, bonus: { gunpowder: 10 }, armor: { melee: 1, pierce: 0 }, speed: 1.2,
  classes: ['infantry', 'condottiero'],
});

/* ------------------------------------------------------------------ *
 *  GAIA / wildlife (huntable + aggressive)
 * ------------------------------------------------------------------ */

U('sheep', {
  name: 'Sheep', cat: 'animal', from: null, hp: 7, atk: {}, speed: 0.7, los: 2,
  classes: ['villager'], radius: 0.24, food: 100, huntable: true, tame: true,
});
U('deer', {
  name: 'Deer', cat: 'animal', from: null, hp: 4, atk: {}, speed: 1.4, los: 5,
  classes: ['villager'], radius: 0.26, food: 140, huntable: true, skittish: true,
});
U('boar', {
  name: 'Wild Boar', cat: 'animal', from: null, hp: 75, atk: { melee: 7 }, speed: 1.1, los: 6,
  classes: ['villager'], radius: 0.3, food: 340, huntable: true, aggressive: true, reload: 2.0,
});
U('wolf', {
  name: 'Wolf', cat: 'animal', from: null, hp: 25, atk: { melee: 3 }, speed: 1.3, los: 6,
  classes: ['villager'], radius: 0.24, aggressive: true, reload: 2.0, hostile: true,
});

export const UNITS = DB;
export function getUnit(id) {
  const u = DB[id];
  if (!u) throw new Error('Unknown unit: ' + id);
  return u;
}
export const UNIT_IDS = Object.keys(DB);
