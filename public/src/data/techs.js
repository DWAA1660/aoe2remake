// Technology database.
//
// Every tech is a cost + a list of effects. Effects are declarative so that
// civilisation bonuses, team bonuses and unique techs can all reuse the same
// resolver (see sim/modifiers.js).
//
//  sel   : { ids:[...] } | { classes:[...] } | { cats:[...] } | { all:true }
//  stat  : hp | atk.<class> | armor.<class> | range | speed | los | reload |
//          accuracy | workRate | carry | buildRate | convertRange
//  add / mult : applied as  value = (value + add) * mult

const DB = {};
function T(id, def) {
  DB[id] = {
    id,
    cost: { food: 0, wood: 0, gold: 0, stone: 0, ...(def.cost || {}) },
    time: def.time ?? 40,
    age: def.age || 'dark',
    building: def.building || 'blacksmith',
    name: def.name,
    desc: def.desc || '',
    effects: def.effects || [],
    requires: def.requires || [],
    hidden: !!def.hidden,
  };
  return DB[id];
}

const MELEE_UNITS = { cats: ['infantry', 'cavalry'] };
const INFANTRY = { cats: ['infantry'] };
const CAVALRY = { cats: ['cavalry'] };
const ARCHERS = { cats: ['archer'] };
const ALL_MILITARY = { cats: ['infantry', 'cavalry', 'archer', 'siege', 'monk'] };

/* ---------------- Ages ---------------- */

T('feudalAge', {
  name: 'Feudal Age', building: 'townCenter', age: 'dark',
  cost: { food: 500 }, time: 130,
  desc: 'Advance to the Feudal Age. Requires 2 Dark Age buildings.',
  effects: [{ k: 'age', to: 'feudal' }],
});
T('castleAge', {
  name: 'Castle Age', building: 'townCenter', age: 'feudal',
  cost: { food: 800, gold: 200 }, time: 160,
  desc: 'Advance to the Castle Age. Requires 2 Feudal Age buildings.',
  effects: [{ k: 'age', to: 'castle' }], requires: ['feudalAge'],
});
T('imperialAge', {
  name: 'Imperial Age', building: 'townCenter', age: 'castle',
  cost: { food: 1000, gold: 800 }, time: 190,
  desc: 'Advance to the Imperial Age. Requires 2 Castle Age buildings.',
  effects: [{ k: 'age', to: 'imperial' }], requires: ['castleAge'],
});

/* ---------------- Town Center / economy ---------------- */

T('loom', {
  name: 'Loom', building: 'townCenter', age: 'dark', cost: { gold: 50 }, time: 25,
  desc: 'Villagers +15 HP, +1 melee armor, +2 pierce armor.',
  effects: [
    { k: 'unitStat', sel: { ids: ['villager'] }, stat: 'hp', add: 15 },
    { k: 'unitStat', sel: { ids: ['villager'] }, stat: 'armor.melee', add: 1 },
    { k: 'unitStat', sel: { ids: ['villager'] }, stat: 'armor.pierce', add: 2 },
  ],
});
T('wheelbarrow', {
  name: 'Wheelbarrow', building: 'townCenter', age: 'feudal',
  cost: { food: 175, wood: 50 }, time: 75,
  desc: 'Villagers +10% speed, +25% carry capacity.',
  effects: [
    { k: 'unitStat', sel: { ids: ['villager'] }, stat: 'speed', mult: 1.1 },
    { k: 'carry', mult: 1.25 },
  ],
});
T('handCart', {
  name: 'Hand Cart', building: 'townCenter', age: 'castle',
  cost: { food: 300, wood: 200 }, time: 55, requires: ['wheelbarrow'],
  desc: 'Villagers +10% speed, +50% carry capacity.',
  effects: [
    { k: 'unitStat', sel: { ids: ['villager'] }, stat: 'speed', mult: 1.1 },
    { k: 'carry', mult: 1.5 },
  ],
});
T('townWatch', {
  name: 'Town Watch', building: 'townCenter', age: 'feudal', cost: { food: 75 }, time: 25,
  desc: 'Buildings +4 line of sight.',
  effects: [{ k: 'buildingStat', sel: { all: true }, stat: 'los', add: 4 }],
});
T('townPatrol', {
  name: 'Town Patrol', building: 'townCenter', age: 'castle', cost: { food: 300 }, time: 40,
  requires: ['townWatch'], desc: 'Buildings +4 line of sight.',
  effects: [{ k: 'buildingStat', sel: { all: true }, stat: 'los', add: 4 }],
});

T('horseCollar', {
  name: 'Horse Collar', building: 'mill', age: 'feudal', cost: { food: 75, wood: 75 }, time: 20,
  desc: 'Farms +75 food.', effects: [{ k: 'farmFood', add: 75 }],
});
T('heavyPlow', {
  name: 'Heavy Plow', building: 'mill', age: 'castle', cost: { food: 125, wood: 125 }, time: 40,
  requires: ['horseCollar'], desc: 'Farms +125 food, villagers +1 food carry.',
  effects: [{ k: 'farmFood', add: 125 }, { k: 'carry', add: 1 }],
});
T('cropRotation', {
  name: 'Crop Rotation', building: 'mill', age: 'imperial', cost: { food: 250, wood: 250 }, time: 70,
  requires: ['heavyPlow'], desc: 'Farms +175 food.', effects: [{ k: 'farmFood', add: 175 }],
});

T('doubleBitAxe', {
  name: 'Double-Bit Axe', building: 'lumberCamp', age: 'feudal', cost: { food: 100, wood: 50 }, time: 25,
  desc: 'Woodcutters work 20% faster.', effects: [{ k: 'gather', res: 'wood', mult: 1.2 }],
});
T('bowSaw', {
  name: 'Bow Saw', building: 'lumberCamp', age: 'castle', cost: { food: 150, wood: 100 }, time: 50,
  requires: ['doubleBitAxe'], desc: 'Woodcutters work 20% faster.',
  effects: [{ k: 'gather', res: 'wood', mult: 1.2 }],
});
T('twoManSaw', {
  name: 'Two-Man Saw', building: 'lumberCamp', age: 'imperial', cost: { food: 300, wood: 200 }, time: 100,
  requires: ['bowSaw'], desc: 'Woodcutters work 10% faster.',
  effects: [{ k: 'gather', res: 'wood', mult: 1.1 }],
});

T('goldMining', {
  name: 'Gold Mining', building: 'miningCamp', age: 'feudal', cost: { food: 100, wood: 75 }, time: 30,
  desc: 'Gold miners work 15% faster.', effects: [{ k: 'gather', res: 'gold', mult: 1.15 }],
});
T('goldShaftMining', {
  name: 'Gold Shaft Mining', building: 'miningCamp', age: 'castle', cost: { food: 200, wood: 150 }, time: 75,
  requires: ['goldMining'], desc: 'Gold miners work 15% faster.',
  effects: [{ k: 'gather', res: 'gold', mult: 1.15 }],
});
T('stoneMining', {
  name: 'Stone Mining', building: 'miningCamp', age: 'feudal', cost: { food: 100, wood: 75 }, time: 30,
  desc: 'Stone miners work 15% faster.', effects: [{ k: 'gather', res: 'stone', mult: 1.15 }],
});
T('stoneShaftMining', {
  name: 'Stone Shaft Mining', building: 'miningCamp', age: 'castle', cost: { food: 200, wood: 150 }, time: 75,
  requires: ['stoneMining'], desc: 'Stone miners work 15% faster.',
  effects: [{ k: 'gather', res: 'stone', mult: 1.15 }],
});

/* ---------------- Market ---------------- */

T('cartography', {
  name: 'Cartography', building: 'market', age: 'feudal', cost: { food: 100, gold: 100 }, time: 60,
  desc: 'Share line of sight with allies.', effects: [{ k: 'flag', name: 'cartography' }],
});
T('caravan', {
  name: 'Caravan', building: 'market', age: 'castle', cost: { food: 200, gold: 200 }, time: 40,
  desc: 'Trade units move 50% faster.',
  effects: [{ k: 'unitStat', sel: { cats: ['trade'] }, stat: 'speed', mult: 1.5 }],
});
T('coinage', {
  name: 'Coinage', building: 'market', age: 'castle', cost: { food: 150, gold: 50 }, time: 70,
  desc: 'Market fee reduced to 20%.', effects: [{ k: 'marketFee', set: 0.2 }],
});
T('banking', {
  name: 'Banking', building: 'market', age: 'imperial', cost: { food: 300, gold: 200 }, time: 70,
  requires: ['coinage'], desc: 'Market fee reduced to 15%.', effects: [{ k: 'marketFee', set: 0.15 }],
});
T('guilds', {
  name: 'Guilds', building: 'market', age: 'imperial', cost: { food: 300, gold: 200 }, time: 50,
  requires: ['banking'], desc: 'Market fee reduced to 5%.', effects: [{ k: 'marketFee', set: 0.05 }],
});

/* ---------------- Blacksmith: melee attack ---------------- */

T('forging', {
  name: 'Forging', age: 'feudal', cost: { food: 150 }, time: 50,
  desc: 'Infantry and cavalry +1 melee attack.',
  effects: [{ k: 'unitStat', sel: MELEE_UNITS, stat: 'atk.melee', add: 1 }],
});
T('ironCasting', {
  name: 'Iron Casting', age: 'castle', cost: { food: 220, gold: 120 }, time: 75, requires: ['forging'],
  desc: 'Infantry and cavalry +1 melee attack.',
  effects: [{ k: 'unitStat', sel: MELEE_UNITS, stat: 'atk.melee', add: 1 }],
});
T('blastFurnace', {
  name: 'Blast Furnace', age: 'imperial', cost: { food: 275, gold: 225 }, time: 100, requires: ['ironCasting'],
  desc: 'Infantry and cavalry +2 melee attack.',
  effects: [{ k: 'unitStat', sel: MELEE_UNITS, stat: 'atk.melee', add: 2 }],
});

/* ---------------- Blacksmith: infantry armor ---------------- */

T('scaleMailArmor', {
  name: 'Scale Mail Armor', age: 'feudal', cost: { food: 100 }, time: 40,
  desc: 'Infantry +1 melee armor, +1 pierce armor.',
  effects: [
    { k: 'unitStat', sel: INFANTRY, stat: 'armor.melee', add: 1 },
    { k: 'unitStat', sel: INFANTRY, stat: 'armor.pierce', add: 1 },
  ],
});
T('chainMailArmor', {
  name: 'Chain Mail Armor', age: 'castle', cost: { food: 200, gold: 100 }, time: 55, requires: ['scaleMailArmor'],
  desc: 'Infantry +1 melee armor, +1 pierce armor.',
  effects: [
    { k: 'unitStat', sel: INFANTRY, stat: 'armor.melee', add: 1 },
    { k: 'unitStat', sel: INFANTRY, stat: 'armor.pierce', add: 1 },
  ],
});
T('plateMailArmor', {
  name: 'Plate Mail Armor', age: 'imperial', cost: { food: 300, gold: 150 }, time: 70, requires: ['chainMailArmor'],
  desc: 'Infantry +1 melee armor, +2 pierce armor.',
  effects: [
    { k: 'unitStat', sel: INFANTRY, stat: 'armor.melee', add: 1 },
    { k: 'unitStat', sel: INFANTRY, stat: 'armor.pierce', add: 2 },
  ],
});

/* ---------------- Blacksmith: cavalry armor ---------------- */

T('scaleBardingArmor', {
  name: 'Scale Barding Armor', age: 'feudal', cost: { food: 150 }, time: 45,
  desc: 'Cavalry +1 melee armor, +1 pierce armor.',
  effects: [
    { k: 'unitStat', sel: CAVALRY, stat: 'armor.melee', add: 1 },
    { k: 'unitStat', sel: CAVALRY, stat: 'armor.pierce', add: 1 },
  ],
});
T('chainBardingArmor', {
  name: 'Chain Barding Armor', age: 'castle', cost: { food: 250, gold: 150 }, time: 60, requires: ['scaleBardingArmor'],
  desc: 'Cavalry +1 melee armor, +1 pierce armor.',
  effects: [
    { k: 'unitStat', sel: CAVALRY, stat: 'armor.melee', add: 1 },
    { k: 'unitStat', sel: CAVALRY, stat: 'armor.pierce', add: 1 },
  ],
});
T('plateBardingArmor', {
  name: 'Plate Barding Armor', age: 'imperial', cost: { food: 350, gold: 200 }, time: 75, requires: ['chainBardingArmor'],
  desc: 'Cavalry +1 melee armor, +2 pierce armor.',
  effects: [
    { k: 'unitStat', sel: CAVALRY, stat: 'armor.melee', add: 1 },
    { k: 'unitStat', sel: CAVALRY, stat: 'armor.pierce', add: 2 },
  ],
});

/* ---------------- Blacksmith: archer attack + armor ---------------- */

T('fletching', {
  name: 'Fletching', age: 'feudal', cost: { food: 100, gold: 50 }, time: 30,
  desc: 'Archers, towers and Town Centers +1 attack, +1 range.',
  effects: [
    { k: 'unitStat', sel: ARCHERS, stat: 'atk.pierce', add: 1 },
    { k: 'unitStat', sel: ARCHERS, stat: 'range', add: 1 },
    { k: 'buildingStat', sel: { cats: ['defense'], ids: ['townCenter', 'castle'] }, stat: 'atk.pierce', add: 1 },
    { k: 'buildingStat', sel: { cats: ['defense'], ids: ['townCenter', 'castle'] }, stat: 'range', add: 1 },
  ],
});
T('bodkinArrow', {
  name: 'Bodkin Arrow', age: 'castle', cost: { food: 200, gold: 100 }, time: 35, requires: ['fletching'],
  desc: 'Archers, towers and Town Centers +1 attack, +1 range.',
  effects: [
    { k: 'unitStat', sel: ARCHERS, stat: 'atk.pierce', add: 1 },
    { k: 'unitStat', sel: ARCHERS, stat: 'range', add: 1 },
    { k: 'buildingStat', sel: { cats: ['defense'], ids: ['townCenter', 'castle'] }, stat: 'atk.pierce', add: 1 },
    { k: 'buildingStat', sel: { cats: ['defense'], ids: ['townCenter', 'castle'] }, stat: 'range', add: 1 },
  ],
});
T('bracer', {
  name: 'Bracer', age: 'imperial', cost: { food: 300, gold: 200 }, time: 40, requires: ['bodkinArrow'],
  desc: 'Archers, towers and Town Centers +1 attack, +1 range.',
  effects: [
    { k: 'unitStat', sel: ARCHERS, stat: 'atk.pierce', add: 1 },
    { k: 'unitStat', sel: ARCHERS, stat: 'range', add: 1 },
    { k: 'buildingStat', sel: { cats: ['defense'], ids: ['townCenter', 'castle'] }, stat: 'atk.pierce', add: 1 },
    { k: 'buildingStat', sel: { cats: ['defense'], ids: ['townCenter', 'castle'] }, stat: 'range', add: 1 },
  ],
});

T('paddedArcherArmor', {
  name: 'Padded Archer Armor', age: 'feudal', cost: { food: 100 }, time: 40,
  desc: 'Archers +1 melee armor, +1 pierce armor.',
  effects: [
    { k: 'unitStat', sel: ARCHERS, stat: 'armor.melee', add: 1 },
    { k: 'unitStat', sel: ARCHERS, stat: 'armor.pierce', add: 1 },
  ],
});
T('leatherArcherArmor', {
  name: 'Leather Archer Armor', age: 'castle', cost: { food: 150, gold: 150 }, time: 55, requires: ['paddedArcherArmor'],
  desc: 'Archers +1 melee armor, +1 pierce armor.',
  effects: [
    { k: 'unitStat', sel: ARCHERS, stat: 'armor.melee', add: 1 },
    { k: 'unitStat', sel: ARCHERS, stat: 'armor.pierce', add: 1 },
  ],
});
T('ringArcherArmor', {
  name: 'Ring Archer Armor', age: 'imperial', cost: { food: 250, gold: 250 }, time: 70, requires: ['leatherArcherArmor'],
  desc: 'Archers +1 melee armor, +2 pierce armor.',
  effects: [
    { k: 'unitStat', sel: ARCHERS, stat: 'armor.melee', add: 1 },
    { k: 'unitStat', sel: ARCHERS, stat: 'armor.pierce', add: 2 },
  ],
});

/* ---------------- Barracks ---------------- */

T('supplies', {
  name: 'Supplies', building: 'barracks', age: 'feudal', cost: { food: 75, gold: 75 }, time: 35,
  desc: 'Militia-line units cost -15 food.',
  effects: [{ k: 'cost', sel: { ids: ['militia', 'manAtArms', 'longSwordsman', 'twoHandedSwordsman', 'champion'] }, res: 'food', add: -15 }],
});
T('squires', {
  name: 'Squires', building: 'barracks', age: 'castle', cost: { food: 100 }, time: 40,
  desc: 'Infantry move 10% faster.',
  effects: [{ k: 'unitStat', sel: INFANTRY, stat: 'speed', mult: 1.1 }],
});
T('arson', {
  name: 'Arson', building: 'barracks', age: 'castle', cost: { food: 150, gold: 50 }, time: 25,
  desc: 'Infantry +2 attack against buildings.',
  effects: [{ k: 'unitStat', sel: INFANTRY, stat: 'atk.building', add: 2 }],
});
T('tracking', {
  name: 'Tracking', building: 'barracks', age: 'feudal', cost: { food: 50 }, time: 35,
  desc: 'Infantry +2 line of sight.',
  effects: [{ k: 'unitStat', sel: INFANTRY, stat: 'los', add: 2 }],
});

/* ---------------- Archery Range ---------------- */

T('thumbRing', {
  name: 'Thumb Ring', building: 'archeryRange', age: 'castle', cost: { food: 300, wood: 250 }, time: 45,
  desc: 'Archers fire 18% faster and never miss.',
  effects: [
    { k: 'unitStat', sel: ARCHERS, stat: 'reload', mult: 0.85 },
    { k: 'unitStat', sel: ARCHERS, stat: 'accuracy', set: 1.0 },
  ],
});
T('parthianTactics', {
  name: 'Parthian Tactics', building: 'archeryRange', age: 'imperial', cost: { food: 200, gold: 250 }, time: 65,
  desc: 'Cavalry Archers +1 melee armor, +2 pierce armor, +4 attack vs Spearmen.',
  effects: [
    { k: 'unitStat', sel: { classes: ['cavalryArcher'] }, stat: 'armor.melee', add: 1 },
    { k: 'unitStat', sel: { classes: ['cavalryArcher'] }, stat: 'armor.pierce', add: 2 },
    { k: 'unitStat', sel: { classes: ['cavalryArcher'] }, stat: 'atk.spearman', add: 4 },
  ],
});

/* ---------------- Stable ---------------- */

T('bloodlines', {
  name: 'Bloodlines', building: 'stable', age: 'feudal', cost: { food: 150, gold: 100 }, time: 50,
  desc: 'Cavalry +20 HP.',
  effects: [{ k: 'unitStat', sel: CAVALRY, stat: 'hp', add: 20 }],
});
T('husbandry', {
  name: 'Husbandry', building: 'stable', age: 'castle', cost: { food: 150 }, time: 40,
  desc: 'Cavalry move 10% faster.',
  effects: [{ k: 'unitStat', sel: CAVALRY, stat: 'speed', mult: 1.1 }],
});

/* ---------------- University ---------------- */

T('masonry', {
  name: 'Masonry', building: 'university', age: 'castle', cost: { food: 175, wood: 150 }, time: 50,
  desc: 'Buildings +10% HP, +1 melee armor, +1 pierce armor.',
  effects: [
    { k: 'buildingStat', sel: { all: true }, stat: 'hp', mult: 1.1 },
    { k: 'buildingStat', sel: { all: true }, stat: 'armor.melee', add: 1 },
    { k: 'buildingStat', sel: { all: true }, stat: 'armor.pierce', add: 1 },
  ],
});
T('architecture', {
  name: 'Architecture', building: 'university', age: 'imperial', cost: { food: 300, wood: 200 }, time: 70,
  requires: ['masonry'], desc: 'Buildings +10% HP, +1 melee armor, +3 pierce armor.',
  effects: [
    { k: 'buildingStat', sel: { all: true }, stat: 'hp', mult: 1.1 },
    { k: 'buildingStat', sel: { all: true }, stat: 'armor.melee', add: 1 },
    { k: 'buildingStat', sel: { all: true }, stat: 'armor.pierce', add: 3 },
  ],
});
T('fortifiedWall', {
  name: 'Fortified Wall', building: 'university', age: 'castle', cost: { food: 200, wood: 100 }, time: 50,
  desc: 'Upgrades Stone Walls to Fortified Walls.',
  effects: [{ k: 'buildingUpgrade', from: 'stoneWall', to: 'fortifiedWall' }],
});
T('ballistics', {
  name: 'Ballistics', building: 'university', age: 'castle', cost: { food: 300, wood: 175 }, time: 60,
  desc: 'Projectiles lead their target — ranged units hit moving targets.',
  effects: [{ k: 'flag', name: 'ballistics' }],
});
T('guardTower', {
  name: 'Guard Tower', building: 'university', age: 'castle', cost: { food: 100, wood: 250 }, time: 30,
  desc: 'Upgrades Watch Towers to Guard Towers.',
  effects: [{ k: 'buildingUpgrade', from: 'watchTower', to: 'guardTower' }],
});
T('keep', {
  name: 'Keep', building: 'university', age: 'imperial', cost: { food: 500, wood: 350 }, time: 75,
  requires: ['guardTower'], desc: 'Upgrades Guard Towers to Keeps.',
  effects: [{ k: 'buildingUpgrade', from: 'guardTower', to: 'keep' }],
});
T('bombardTower', {
  name: 'Bombard Tower', building: 'university', age: 'imperial', cost: { food: 800, stone: 400 }, time: 70,
  requires: ['chemistry'], desc: 'Enables Bombard Towers.',
  effects: [{ k: 'unlockBuilding', id: 'bombardTower' }],
});
T('heatedShot', {
  name: 'Heated Shot', building: 'university', age: 'castle', cost: { food: 350, gold: 100 }, time: 30,
  desc: 'Towers, Town Centers and Castles +125% attack vs ships.',
  effects: [{ k: 'buildingStat', sel: { cats: ['defense'], ids: ['townCenter', 'castle'] }, stat: 'atk.ship', add: 6 }],
});
T('murderHoles', {
  name: 'Murder Holes', building: 'university', age: 'castle', cost: { food: 200, stone: 200 }, time: 60,
  desc: 'Removes the minimum range of Towers, Castles and Town Centers.',
  effects: [{ k: 'flag', name: 'murderHoles' }],
});
T('arrowslits', {
  name: 'Arrowslits', building: 'university', age: 'castle', cost: { food: 250, wood: 250 }, time: 30,
  desc: 'Towers and Donjons +2 attack.',
  effects: [{ k: 'buildingStat', sel: { cats: ['defense'] }, stat: 'atk.pierce', add: 2 }],
});
T('treadmillCrane', {
  name: 'Treadmill Crane', building: 'university', age: 'castle', cost: { food: 300, wood: 200 }, time: 50,
  desc: 'Villagers build 20% faster.',
  effects: [{ k: 'buildRate', mult: 1.2 }],
});
T('chemistry', {
  name: 'Chemistry', building: 'university', age: 'imperial', cost: { food: 300, gold: 200 }, time: 100,
  desc: 'All missile units +1 attack. Enables gunpowder units.',
  effects: [
    { k: 'unitStat', sel: { cats: ['archer'] }, stat: 'atk.pierce', add: 1 },
    { k: 'buildingStat', sel: { cats: ['defense'], ids: ['townCenter', 'castle'] }, stat: 'atk.pierce', add: 1 },
    { k: 'flag', name: 'chemistry' },
  ],
});
T('siegeEngineers', {
  name: 'Siege Engineers', building: 'university', age: 'imperial', cost: { food: 500, wood: 600 }, time: 45,
  desc: 'Siege weapons +1 range and +20% damage vs buildings.',
  effects: [
    { k: 'unitStat', sel: { cats: ['siege'] }, stat: 'range', add: 1 },
    { k: 'unitStat', sel: { cats: ['siege'] }, stat: 'atk.building', mult: 1.2 },
    { k: 'unitStat', sel: { cats: ['siege'] }, stat: 'atk.stoneDefense', mult: 1.2 },
  ],
});

/* ---------------- Monastery ---------------- */

T('redemption', {
  name: 'Redemption', building: 'monastery', age: 'castle', cost: { gold: 475 }, time: 50,
  desc: 'Monks can convert buildings and siege weapons.',
  effects: [{ k: 'flag', name: 'redemption' }],
});
T('atonement', {
  name: 'Atonement', building: 'monastery', age: 'castle', cost: { gold: 325 }, time: 40,
  desc: 'Monks can convert other Monks.', effects: [{ k: 'flag', name: 'atonement' }],
});
T('herbalMedicine', {
  name: 'Herbal Medicine', building: 'monastery', age: 'castle', cost: { food: 350 }, time: 35,
  desc: 'Garrisoned units heal 4x faster.', effects: [{ k: 'flag', name: 'herbalMedicine' }],
});
T('heresy', {
  name: 'Heresy', building: 'monastery', age: 'castle', cost: { gold: 1000 }, time: 60,
  desc: 'Converted units die instead of changing sides.', effects: [{ k: 'flag', name: 'heresy' }],
});
T('sanctity', {
  name: 'Sanctity', building: 'monastery', age: 'castle', cost: { gold: 120 }, time: 60,
  desc: 'Monks +50% HP.',
  effects: [{ k: 'unitStat', sel: { cats: ['monk'] }, stat: 'hp', mult: 1.5 }],
});
T('fervor', {
  name: 'Fervor', building: 'monastery', age: 'castle', cost: { gold: 140 }, time: 50,
  desc: 'Monks move 15% faster.',
  effects: [{ k: 'unitStat', sel: { cats: ['monk'] }, stat: 'speed', mult: 1.15 }],
});
T('faith', {
  name: 'Faith', building: 'monastery', age: 'imperial', cost: { food: 750, gold: 1000 }, time: 60,
  desc: 'Units are much harder to convert.', effects: [{ k: 'flag', name: 'faith' }],
});
T('illumination', {
  name: 'Illumination', building: 'monastery', age: 'imperial', cost: { food: 300, gold: 120 }, time: 65,
  desc: 'Monks regain faith 50% faster.', effects: [{ k: 'monkRecharge', mult: 0.5 }],
});
T('blockPrinting', {
  name: 'Block Printing', building: 'monastery', age: 'castle', cost: { gold: 200 }, time: 55,
  desc: 'Monks +3 conversion range.',
  effects: [{ k: 'unitStat', sel: { cats: ['monk'] }, stat: 'range', add: 3 }],
});
T('theocracy', {
  name: 'Theocracy', building: 'monastery', age: 'imperial', cost: { food: 400, gold: 800 }, time: 75,
  desc: 'Only one Monk of a group loses faith when converting.',
  effects: [{ k: 'flag', name: 'theocracy' }],
});

/* ---------------- Castle ---------------- */

T('hoardings', {
  name: 'Hoardings', building: 'castle', age: 'imperial', cost: { food: 400, wood: 400 }, time: 75,
  desc: 'Castles +21% HP.',
  effects: [{ k: 'buildingStat', sel: { ids: ['castle'] }, stat: 'hp', mult: 1.21 }],
});
T('sappers', {
  name: 'Sappers', building: 'castle', age: 'imperial', cost: { food: 400, gold: 200 }, time: 10,
  desc: 'Villagers +15 attack vs buildings.',
  effects: [{ k: 'unitStat', sel: { ids: ['villager'] }, stat: 'atk.building', add: 15 }],
});
T('conscription', {
  name: 'Conscription', building: 'castle', age: 'imperial', cost: { food: 150, gold: 150 }, time: 60,
  desc: 'Military units train 33% faster.', effects: [{ k: 'trainSpeed', mult: 0.75 }],
});
T('spies', {
  name: 'Spies', building: 'castle', age: 'imperial', cost: { gold: 200 }, time: 40,
  desc: 'Reveals the whole map.', effects: [{ k: 'flag', name: 'spies' }],
});

/* ---------------- Dock ---------------- */

T('gillnets', {
  name: 'Gillnets', building: 'dock', age: 'castle', cost: { food: 150, wood: 200 }, time: 40,
  desc: 'Fishing Ships work 25% faster.', effects: [{ k: 'gather', res: 'fish', mult: 1.25 }],
});
T('careening', {
  name: 'Careening', building: 'dock', age: 'castle', cost: { food: 250, gold: 150 }, time: 50,
  desc: 'Ships +1 pierce armor.',
  effects: [{ k: 'unitStat', sel: { cats: ['naval'] }, stat: 'armor.pierce', add: 1 }],
});
T('dryDock', {
  name: 'Dry Dock', building: 'dock', age: 'imperial', cost: { food: 600, wood: 400 }, time: 60,
  requires: ['careening'], desc: 'Ships move 15% faster.',
  effects: [{ k: 'unitStat', sel: { cats: ['naval'] }, stat: 'speed', mult: 1.15 }],
});
T('shipwright', {
  name: 'Shipwright', building: 'dock', age: 'imperial', cost: { food: 1000, wood: 300 }, time: 60,
  desc: 'Ships cost -20% wood.',
  effects: [{ k: 'cost', sel: { cats: ['naval'] }, res: 'wood', mult: 0.8 }],
});

/* ------------------------------------------------------------------ *
 *  Unit line upgrades
 * ------------------------------------------------------------------ */

function UPG(id, name, from, to, age, cost, time, building) {
  T(id, {
    name, building, age, cost, time,
    desc: `Upgrades ${from} to ${to}.`,
    effects: [{ k: 'unitUpgrade', from, to }],
  });
}

UPG('upManAtArms', 'Man-at-Arms', 'militia', 'manAtArms', 'feudal', { food: 100, gold: 40 }, 40, 'barracks');
UPG('upLongSwordsman', 'Long Swordsman', 'manAtArms', 'longSwordsman', 'castle', { food: 200, gold: 65 }, 45, 'barracks');
UPG('upTwoHandedSwordsman', 'Two-Handed Swordsman', 'longSwordsman', 'twoHandedSwordsman', 'imperial', { food: 300, gold: 100 }, 45, 'barracks');
UPG('upChampion', 'Champion', 'twoHandedSwordsman', 'champion', 'imperial', { food: 750, gold: 350 }, 100, 'barracks');
UPG('upPikeman', 'Pikeman', 'spearman', 'pikeman', 'castle', { food: 215, gold: 90 }, 45, 'barracks');
UPG('upHalberdier', 'Halberdier', 'pikeman', 'halberdier', 'imperial', { food: 300, gold: 600 }, 50, 'barracks');
UPG('upEagleWarrior', 'Eagle Warrior', 'eagleScout', 'eagleWarrior', 'castle', { food: 200, gold: 200 }, 65, 'barracks');
UPG('upEliteEagleWarrior', 'Elite Eagle Warrior', 'eagleWarrior', 'eliteEagleWarrior', 'imperial', { food: 800, gold: 500 }, 60, 'barracks');

UPG('upCrossbowman', 'Crossbowman', 'archer', 'crossbowman', 'castle', { food: 125, gold: 75 }, 35, 'archeryRange');
UPG('upArbalester', 'Arbalester', 'crossbowman', 'arbalester', 'imperial', { food: 350, gold: 300 }, 50, 'archeryRange');
UPG('upEliteSkirmisher', 'Elite Skirmisher', 'skirmisher', 'eliteSkirmisher', 'castle', { food: 230, gold: 100 }, 50, 'archeryRange');
UPG('upHeavyCavalryArcher', 'Heavy Cavalry Archer', 'cavalryArcher', 'heavyCavalryArcher', 'imperial', { food: 900, gold: 500 }, 50, 'archeryRange');

UPG('upLightCavalry', 'Light Cavalry', 'scoutCavalry', 'lightCavalry', 'castle', { food: 150, gold: 50 }, 45, 'stable');
UPG('upHussar', 'Hussar', 'lightCavalry', 'hussar', 'imperial', { food: 500, gold: 600 }, 50, 'stable');
UPG('upCavalier', 'Cavalier', 'knight', 'cavalier', 'imperial', { food: 300, gold: 300 }, 100, 'stable');
UPG('upPaladin', 'Paladin', 'cavalier', 'paladin', 'imperial', { food: 1300, gold: 750 }, 170, 'stable');
UPG('upHeavyCamelRider', 'Heavy Camel Rider', 'camelRider', 'heavyCamelRider', 'imperial', { food: 325, gold: 360 }, 125, 'stable');
UPG('upEliteBattleElephant', 'Elite Battle Elephant', 'battleElephant', 'eliteBattleElephant', 'imperial', { food: 1000, gold: 800 }, 120, 'stable');
UPG('upEliteSteppeLancer', 'Elite Steppe Lancer', 'steppeLancer', 'eliteSteppeLancer', 'imperial', { food: 800, gold: 600 }, 60, 'stable');

UPG('upCappedRam', 'Capped Ram', 'batteringRam', 'cappedRam', 'imperial', { food: 300, wood: 200 }, 50, 'siegeWorkshop');
UPG('upSiegeRam', 'Siege Ram', 'cappedRam', 'siegeRam', 'imperial', { food: 1000, wood: 800 }, 75, 'siegeWorkshop');
UPG('upOnager', 'Onager', 'mangonel', 'onager', 'imperial', { food: 800, wood: 500 }, 75, 'siegeWorkshop');
UPG('upSiegeOnager', 'Siege Onager', 'onager', 'siegeOnager', 'imperial', { food: 1450, wood: 1000 }, 150, 'siegeWorkshop');
UPG('upHeavyScorpion', 'Heavy Scorpion', 'scorpion', 'heavyScorpion', 'imperial', { food: 1000, wood: 1100 }, 50, 'siegeWorkshop');

// Elite unique-unit upgrades are generated per civ in data/civs.js.

export const TECHS = DB;
export function getTech(id) {
  const t = DB[id];
  if (!t) throw new Error('Unknown tech: ' + id);
  return t;
}
export function addTech(id, def) { return T(id, def); }
export const TECH_IDS = Object.keys(DB);
