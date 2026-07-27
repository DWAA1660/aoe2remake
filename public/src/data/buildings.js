// Building database (AoE2:DE costs / HP / footprints).
//
// size      : footprint in tiles (square)
// dropSite  : resources villagers can deposit here
// trains    : unit ids this building can produce
// researches: tech ids available here
// atk/range : defensive buildings shoot; garrisoned units add arrows

const DEFAULTS = {
  cat: 'economy',
  age: 'dark',
  cost: {},
  time: 30,
  hp: 1000,
  size: 2,
  armor: { melee: 0, pierce: 7 },
  classes: ['building'],
  atk: null,
  range: 0,
  minRange: 0,
  reload: 2.0,
  los: 6,
  garrison: 0,
  arrowsPerGarrison: 0,
  baseArrows: 0,
  dropSite: null,
  trains: [],
  researches: [],
  pop: 0,
  unique: null,
};

const DB = {};
function B(id, def) {
  const b = { id, ...DEFAULTS, ...def };
  b.cost = { food: 0, wood: 0, gold: 0, stone: 0, ...(def.cost || {}) };
  b.armor = { melee: 0, pierce: 7, ...(def.armor || {}) };
  if (def.bonus && b.atk) b.atk = { ...b.atk, ...def.bonus };
  // See units.js: an explicit (0) armor entry is what marks class membership.
  // Each building belongs to exactly one of building / stoneDefense / wall so
  // siege bonus components are never counted twice.
  for (const c of b.classes) if (b.armor[c] === undefined) b.armor[c] = 0;
  DB[id] = b;
  return b;
}

/* ---------------- Economy ---------------- */

B('townCenter', {
  name: 'Town Center', cat: 'economy', age: 'dark',
  cost: { wood: 275, stone: 100 }, time: 150, hp: 2400, size: 4,
  armor: { melee: 3, pierce: 5 }, classes: ['stoneDefense'],
  atk: { pierce: 5 }, range: 6, reload: 2.0, los: 12,
  garrison: 15, arrowsPerGarrison: 1, baseArrows: 0,
  dropSite: ['food', 'wood', 'gold', 'stone'], pop: 5,
  trains: ['villager'],
  researches: ['loom', 'feudalAge', 'castleAge', 'imperialAge', 'wheelbarrow', 'handCart', 'townWatch', 'townPatrol'],
});

B('house', {
  name: 'House', cat: 'economy', age: 'dark',
  cost: { wood: 25 }, time: 25, hp: 550, size: 2, pop: 5, los: 4,
});

B('mill', {
  name: 'Mill', cat: 'economy', age: 'dark',
  cost: { wood: 100 }, time: 35, hp: 1000, size: 2,
  dropSite: ['food'],
  researches: ['horseCollar', 'heavyPlow', 'cropRotation'],
});

B('lumberCamp', {
  name: 'Lumber Camp', cat: 'economy', age: 'dark',
  cost: { wood: 100 }, time: 35, hp: 600, size: 2,
  dropSite: ['wood'],
  researches: ['doubleBitAxe', 'bowSaw', 'twoManSaw'],
});

B('miningCamp', {
  name: 'Mining Camp', cat: 'economy', age: 'dark',
  cost: { wood: 100 }, time: 35, hp: 600, size: 2,
  dropSite: ['gold', 'stone'],
  researches: ['goldMining', 'stoneMining', 'goldShaftMining', 'stoneShaftMining'],
});

B('farm', {
  name: 'Farm', cat: 'economy', age: 'dark',
  cost: { wood: 60 }, time: 15, hp: 100, size: 3,
  armor: { melee: 0, pierce: 0 }, los: 1, farmFood: 175,
});

B('dock', {
  name: 'Dock', cat: 'economy', age: 'dark',
  cost: { wood: 150 }, time: 35, hp: 1800, size: 3, los: 9,
  dropSite: ['food', 'wood', 'gold', 'stone'], water: true,
  trains: ['fishingShip', 'transportShip', 'tradeCog', 'galley', 'warGalley', 'galleon',
    'fireShip', 'demolitionShip', 'cannonGalleon'],
  researches: ['gillnets', 'careening', 'dryDock', 'shipwright'],
});

B('market', {
  name: 'Market', cat: 'economy', age: 'feudal',
  cost: { wood: 175 }, time: 60, hp: 1800, size: 4, los: 6,
  trains: ['tradeCart'],
  researches: ['cartography', 'caravan', 'coinage', 'banking', 'guilds'],
});

/* ---------------- Military production ---------------- */

B('barracks', {
  name: 'Barracks', cat: 'military', age: 'dark',
  cost: { wood: 175 }, time: 50, hp: 1200, size: 3, los: 6,
  garrison: 10,
  trains: ['militia', 'manAtArms', 'longSwordsman', 'twoHandedSwordsman', 'champion',
    'spearman', 'pikeman', 'halberdier', 'eagleScout', 'eagleWarrior', 'eliteEagleWarrior', 'condottiero'],
  researches: ['supplies', 'squires', 'arson', 'tracking',
    'upManAtArms', 'upLongSwordsman', 'upTwoHandedSwordsman', 'upChampion',
    'upPikeman', 'upHalberdier', 'upEagleWarrior', 'upEliteEagleWarrior'],
});

B('archeryRange', {
  name: 'Archery Range', cat: 'military', age: 'feudal',
  cost: { wood: 175 }, time: 50, hp: 1200, size: 3, los: 6,
  garrison: 10,
  trains: ['archer', 'crossbowman', 'arbalester', 'skirmisher', 'eliteSkirmisher',
    'cavalryArcher', 'heavyCavalryArcher', 'handCannoneer'],
  researches: ['thumbRing', 'parthianTactics',
    'upCrossbowman', 'upArbalester', 'upEliteSkirmisher', 'upHeavyCavalryArcher'],
});

B('stable', {
  name: 'Stable', cat: 'military', age: 'feudal',
  cost: { wood: 175 }, time: 50, hp: 1500, size: 3, los: 6,
  garrison: 10,
  trains: ['scoutCavalry', 'lightCavalry', 'hussar', 'knight', 'cavalier', 'paladin',
    'camelRider', 'heavyCamelRider', 'imperialCamelRider', 'battleElephant', 'eliteBattleElephant',
    'steppeLancer', 'eliteSteppeLancer'],
  researches: ['bloodlines', 'husbandry',
    'upLightCavalry', 'upHussar', 'upCavalier', 'upPaladin', 'upHeavyCamelRider',
    'upEliteBattleElephant', 'upEliteSteppeLancer'],
});

B('siegeWorkshop', {
  name: 'Siege Workshop', cat: 'military', age: 'castle',
  cost: { wood: 200 }, time: 40, hp: 1500, size: 3, los: 6,
  trains: ['batteringRam', 'cappedRam', 'siegeRam', 'mangonel', 'onager', 'siegeOnager',
    'scorpion', 'heavyScorpion', 'bombardCannon', 'siegeTower'],
  researches: ['upCappedRam', 'upSiegeRam', 'upOnager', 'upSiegeOnager', 'upHeavyScorpion'],
});

B('blacksmith', {
  name: 'Blacksmith', cat: 'military', age: 'feudal',
  cost: { wood: 150 }, time: 40, hp: 2100, size: 3, los: 6,
  researches: ['forging', 'ironCasting', 'blastFurnace',
    'scaleMailArmor', 'chainMailArmor', 'plateMailArmor',
    'scaleBardingArmor', 'chainBardingArmor', 'plateBardingArmor',
    'fletching', 'bodkinArrow', 'bracer', 'paddedArcherArmor', 'leatherArcherArmor', 'ringArcherArmor'],
});

B('monastery', {
  name: 'Monastery', cat: 'military', age: 'castle',
  cost: { wood: 175 }, time: 40, hp: 2100, size: 3, los: 6,
  garrison: 10, healing: true,
  trains: ['monk', 'missionary'],
  researches: ['redemption', 'atonement', 'herbalMedicine', 'heresy', 'sanctity',
    'fervor', 'faith', 'illumination', 'blockPrinting', 'theocracy'],
});

B('university', {
  name: 'University', cat: 'military', age: 'castle',
  cost: { wood: 200 }, time: 60, hp: 2100, size: 3, los: 6,
  researches: ['masonry', 'fortifiedWall', 'ballistics', 'guardTower', 'heatedShot',
    'murderHoles', 'treadmillCrane', 'architecture', 'chemistry', 'siegeEngineers',
    'keep', 'bombardTower', 'arrowslits'],
});

B('castle', {
  name: 'Castle', cat: 'military', age: 'castle',
  cost: { stone: 650 }, time: 200, hp: 4800, size: 4,
  armor: { melee: 8, pierce: 11 }, classes: ['stoneDefense'],
  atk: { pierce: 11 }, bonus: { ship: 7 }, range: 8, reload: 2.0, los: 11,
  garrison: 20, arrowsPerGarrison: 1, baseArrows: 5,
  trains: ['trebuchet', 'petard'],   // + civ unique unit, injected at runtime
  researches: ['hoardings', 'sappers', 'conscription', 'spies'],
});

/* ---------------- Defences ---------------- */

B('outpost', {
  name: 'Outpost', cat: 'defense', age: 'dark',
  cost: { wood: 25, stone: 25 }, time: 15, hp: 500, size: 1, los: 12,
});

B('watchTower', {
  name: 'Watch Tower', cat: 'defense', age: 'feudal',
  cost: { wood: 50, stone: 125 }, time: 80, hp: 1020, size: 1,
  armor: { melee: 0, pierce: 7 }, classes: ['stoneDefense'],
  atk: { pierce: 5 }, bonus: { ship: 4 }, range: 8, reload: 2.0, los: 10,
  garrison: 5, arrowsPerGarrison: 1, baseArrows: 1, upgradeTo: 'guardTower',
});
B('guardTower', {
  name: 'Guard Tower', cat: 'defense', age: 'castle',
  cost: { wood: 50, stone: 125 }, time: 80, hp: 1500, size: 1,
  armor: { melee: 1, pierce: 7 }, classes: ['stoneDefense'],
  atk: { pierce: 7 }, bonus: { ship: 5 }, range: 8, reload: 2.0, los: 10,
  garrison: 5, arrowsPerGarrison: 1, baseArrows: 1, upgradeTo: 'keep',
});
B('keep', {
  name: 'Keep', cat: 'defense', age: 'imperial',
  cost: { wood: 50, stone: 125 }, time: 80, hp: 2250, size: 1,
  armor: { melee: 3, pierce: 8 }, classes: ['stoneDefense'],
  atk: { pierce: 11 }, bonus: { ship: 6 }, range: 8, reload: 2.0, los: 11,
  garrison: 5, arrowsPerGarrison: 1, baseArrows: 1,
});
B('bombardTower', {
  name: 'Bombard Tower', cat: 'defense', age: 'imperial',
  cost: { stone: 125, gold: 100 }, time: 80, hp: 2220, size: 1,
  armor: { melee: 3, pierce: 9 }, classes: ['stoneDefense'],
  atk: { pierce: 40 }, bonus: { ship: 40, building: 200 }, range: 8, minRange: 0,
  reload: 4.0, los: 12, blast: 0.5,
  garrison: 5, arrowsPerGarrison: 1, baseArrows: 1,
});

B('palisadeWall', {
  name: 'Palisade Wall', cat: 'defense', age: 'dark',
  cost: { wood: 2 }, time: 6, hp: 250, size: 1,
  armor: { melee: 2, pierce: 5 }, classes: ['wall'], los: 2, wall: true,
});
B('stoneWall', {
  name: 'Stone Wall', cat: 'defense', age: 'feudal',
  cost: { stone: 5 }, time: 8, hp: 1800, size: 1,
  armor: { melee: 8, pierce: 10 }, classes: ['wall'], los: 2, wall: true,
  upgradeTo: 'fortifiedWall',
});
B('fortifiedWall', {
  name: 'Fortified Wall', cat: 'defense', age: 'castle',
  cost: { stone: 5 }, time: 8, hp: 3000, size: 1,
  armor: { melee: 8, pierce: 12 }, classes: ['wall'], los: 2, wall: true,
});
B('gate', {
  name: 'Gate', cat: 'defense', age: 'feudal',
  cost: { stone: 30 }, time: 70, hp: 2750, size: 1,
  armor: { melee: 8, pierce: 10 }, classes: ['wall'], los: 6, gate: true,
});

/* ---------------- Wonder + civ-unique buildings ---------------- */

B('wonder', {
  name: 'Wonder', cat: 'special', age: 'imperial',
  cost: { wood: 1000, stone: 1000, gold: 1000 }, time: 3500, hp: 4800, size: 5,
  armor: { melee: 3, pierce: 7 }, los: 8, wonder: true,
});

B('donjon', {
  name: 'Donjon', cat: 'defense', age: 'dark', unique: 'sicilians',
  cost: { wood: 75, stone: 175 }, time: 83, hp: 1800, size: 2,
  armor: { melee: 2, pierce: 8 }, classes: ['stoneDefense'],
  atk: { pierce: 6 }, range: 8, reload: 2.0, los: 10,
  garrison: 10, arrowsPerGarrison: 1, baseArrows: 2,
  trains: ['serjeant', 'eliteSerjeant'],
});

B('krepost', {
  name: 'Krepost', cat: 'defense', age: 'castle', unique: 'bulgarians',
  cost: { stone: 300 }, time: 60, hp: 2500, size: 3,
  armor: { melee: 8, pierce: 11 }, classes: ['stoneDefense'],
  atk: { pierce: 7 }, range: 7, reload: 2.0, los: 9,
  garrison: 10, arrowsPerGarrison: 1, baseArrows: 3,
  trains: ['konnik', 'eliteKonnik'],
});

B('feitoria', {
  name: 'Feitoria', cat: 'economy', age: 'imperial', unique: 'portuguese',
  cost: { food: 250, gold: 250 }, time: 60, hp: 2000, size: 5, los: 5,
  generates: { food: 0.7, wood: 0.7, gold: 0.5, stone: 0.3 }, pop: 0,
});

B('caravanserai', {
  name: 'Caravanserai', cat: 'economy', age: 'castle', unique: 'hindustanis',
  cost: { wood: 200, stone: 200 }, time: 40, hp: 2100, size: 4, los: 8,
  healsTrade: true,
});

export const BUILDINGS = DB;
export function getBuilding(id) {
  const b = DB[id];
  if (!b) throw new Error('Unknown building: ' + id);
  return b;
}
export const BUILDING_IDS = Object.keys(DB);

// Build-menu grouping shown on the villager command card.
export const BUILD_MENU = {
  dark: ['house', 'mill', 'lumberCamp', 'miningCamp', 'farm', 'dock', 'barracks', 'outpost', 'palisadeWall'],
  feudal: ['house', 'mill', 'lumberCamp', 'miningCamp', 'farm', 'dock', 'barracks', 'archeryRange',
    'stable', 'blacksmith', 'market', 'watchTower', 'outpost', 'palisadeWall', 'stoneWall', 'gate'],
  castle: ['house', 'mill', 'lumberCamp', 'miningCamp', 'farm', 'dock', 'barracks', 'archeryRange',
    'stable', 'blacksmith', 'market', 'monastery', 'university', 'siegeWorkshop', 'castle',
    'watchTower', 'outpost', 'stoneWall', 'gate', 'townCenter'],
  imperial: ['house', 'mill', 'lumberCamp', 'miningCamp', 'farm', 'dock', 'barracks', 'archeryRange',
    'stable', 'blacksmith', 'market', 'monastery', 'university', 'siegeWorkshop', 'castle',
    'watchTower', 'bombardTower', 'outpost', 'stoneWall', 'gate', 'townCenter', 'wonder'],
};

