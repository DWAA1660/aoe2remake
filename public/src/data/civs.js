// Civilizations. Bonuses use the same declarative effect language as techs, so
// anything expressible as a tech is expressible as a civ bonus.
//
// Effects that would need bespoke engine support (e.g. "Sicilian units take 33%
// less bonus damage") are given a `flag` the simulation checks directly.

import { addTech } from './techs.js';

const CIVS = {};

function C(id, def) {
  const civ = {
    id,
    name: def.name,
    focus: def.focus,
    uu: def.uu,
    uuElite: def.uuElite,
    eliteUpgrade: def.eliteUpgrade || { cost: { food: 900, gold: 750 }, time: 60 },
    bonuses: def.bonuses || [],
    team: def.team,
    ut1: def.ut1,
    ut2: def.ut2,
    disabled: { units: [], techs: [], buildings: [], ...(def.disabled || {}) },
    extraBuildings: def.extraBuildings || [],
    color: def.color || '#c8a45c',
  };

  // Register the Elite unique-unit upgrade + the two unique techs as real techs.
  if (def.uu && def.uuElite) {
    addTech('elite_' + id, {
      name: 'Elite ' + shortName(def.uu),
      building: 'castle', age: 'imperial',
      cost: civ.eliteUpgrade.cost, time: civ.eliteUpgrade.time,
      desc: `Upgrades ${shortName(def.uu)} to Elite ${shortName(def.uu)}.`,
      effects: [{ k: 'unitUpgrade', from: def.uu, to: def.uuElite }],
    });
  }
  for (const [slot, age] of [['ut1', 'castle'], ['ut2', 'imperial']]) {
    const ut = def[slot];
    if (!ut) continue;
    addTech(ut.id, {
      name: ut.name, building: 'castle', age,
      cost: ut.cost, time: ut.time || 40, desc: ut.desc, effects: ut.effects || [],
    });
  }
  CIVS[id] = civ;
  return civ;
}

function shortName(uuId) {
  return uuId.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()).trim();
}

// selector shorthands
const INF = { cats: ['infantry'] };
const CAV = { cats: ['cavalry'] };
const ARC = { cats: ['archer'] };
const SIE = { cats: ['siege'] };
const MONK = { cats: ['monk'] };
const VILL = { ids: ['villager'] };

/* ================================================================== */

C('aztecs', {
  name: 'Aztecs', focus: 'Infantry and Monk', color: '#7fbf5f',
  uu: 'jaguarWarrior', uuElite: 'eliteJaguarWarrior',
  eliteUpgrade: { cost: { food: 1000, gold: 800 }, time: 45 },
  bonuses: [
    { desc: 'Villagers carry +3 resources.', effects: [{ k: 'carry', add: 3 }] },
    { desc: 'Military units created 11% faster.', effects: [{ k: 'trainSpeed', mult: 0.9 }] },
    { desc: 'Monks +5 HP for each Monastery technology.', effects: [{ k: 'flag', name: 'aztecMonks' }] },
    { desc: 'Start with +50 gold.', effects: [{ k: 'startResource', res: 'gold', add: 50 }] },
  ],
  team: { desc: 'Relics generate +33% gold.', effects: [{ k: 'relicRate', mult: 1.33 }] },
  ut1: { id: 'atlatl', name: 'Atlatl', cost: { food: 400, wood: 400 }, time: 40,
    desc: 'Skirmishers +1 attack, +1 range.',
    effects: [
      { k: 'unitStat', sel: { ids: ['skirmisher', 'eliteSkirmisher'] }, stat: 'atk.pierce', add: 1 },
      { k: 'unitStat', sel: { ids: ['skirmisher', 'eliteSkirmisher'] }, stat: 'range', add: 1 },
    ] },
  ut2: { id: 'garlandWars', name: 'Garland Wars', cost: { food: 900, gold: 450 }, time: 60,
    desc: 'Infantry +4 attack.', effects: [{ k: 'unitStat', sel: INF, stat: 'atk.melee', add: 4 }] },
  disabled: { units: ['knight', 'cavalier', 'paladin', 'scoutCavalry', 'lightCavalry', 'hussar',
    'camelRider', 'heavyCamelRider', 'battleElephant', 'eliteBattleElephant', 'steppeLancer', 'eliteSteppeLancer',
    'handCannoneer', 'bombardCannon', 'cavalryArcher', 'heavyCavalryArcher'],
    buildings: ['stable', 'bombardTower'] },
});

C('berbers', {
  name: 'Berbers', focus: 'Naval and Cavalry', color: '#c9a227',
  uu: 'camelArcher', uuElite: 'eliteCamelArcher',
  bonuses: [
    { desc: 'Villagers move 10% faster.', effects: [{ k: 'unitStat', sel: VILL, stat: 'speed', mult: 1.1 }] },
    { desc: 'Stable units cost -15% in Castle Age, -20% in Imperial.',
      effects: [{ k: 'cost', sel: CAV, res: 'all', mult: 0.85 }] },
    { desc: 'Ships move 10% faster.', effects: [{ k: 'unitStat', sel: { cats: ['naval'] }, stat: 'speed', mult: 1.1 }] },
  ],
  team: { desc: 'Genitours available at the Archery Range.', effects: [] },
  ut1: { id: 'kasbah', name: 'Kasbah', cost: { food: 250, gold: 300 }, time: 40,
    desc: 'Castles work 25% faster.', effects: [{ k: 'trainSpeed', mult: 0.8 }] },
  ut2: { id: 'maghrebiCamels', name: 'Maghrebi Camels', cost: { food: 700, gold: 300 }, time: 40,
    desc: 'Camel units regenerate 15 HP per minute.',
    effects: [{ k: 'unitStat', sel: { classes: ['camel'] }, stat: 'regen', add: 0.25 }] },
  disabled: { units: ['paladin', 'arbalester'], techs: ['siegeOnager'] },
});

C('britons', {
  name: 'Britons', focus: 'Foot Archer', color: '#d24b4b',
  uu: 'longbowman', uuElite: 'eliteLongbowman',
  eliteUpgrade: { cost: { food: 900, gold: 500 }, time: 60 },
  bonuses: [
    { desc: 'Town Centers cost -50% wood from the Castle Age.',
      effects: [{ k: 'costBuilding', sel: { ids: ['townCenter'] }, res: 'wood', mult: 0.5 }] },
    { desc: 'Foot archers (except Skirmishers) +1 range in Castle Age, +2 in Imperial.',
      effects: [{ k: 'unitStat', sel: { ids: ['archer', 'crossbowman', 'arbalester', 'longbowman', 'eliteLongbowman'] }, stat: 'range', add: 1 }] },
    { desc: 'Shepherds work 25% faster.', effects: [{ k: 'gather', res: 'sheep', mult: 1.25 }] },
  ],
  team: { desc: 'Archery Ranges work 20% faster.', effects: [{ k: 'trainSpeed', mult: 0.8 }] },
  ut1: { id: 'yeomen', name: 'Yeomen', cost: { wood: 750, gold: 450 }, time: 60,
    desc: 'Foot archers +1 range; towers +2 attack.',
    effects: [
      { k: 'unitStat', sel: ARC, stat: 'range', add: 1 },
      { k: 'buildingStat', sel: { cats: ['defense'] }, stat: 'atk.pierce', add: 2 },
    ] },
  ut2: { id: 'warwolf', name: 'Warwolf', cost: { food: 800, gold: 400 }, time: 60,
    desc: 'Trebuchets do blast damage and never miss.',
    effects: [{ k: 'unitStat', sel: { ids: ['trebuchet'] }, stat: 'blast', add: 0.5 }] },
  disabled: { units: ['camelRider', 'heavyCamelRider', 'handCannoneer', 'siegeOnager', 'bombardCannon'] },
});

C('bulgarians', {
  name: 'Bulgarians', focus: 'Infantry and Cavalry', color: '#8f9fb5',
  uu: 'konnik', uuElite: 'eliteKonnik',
  bonuses: [
    { desc: 'Militia-line upgrades are free.', effects: [{ k: 'freeTech', ids: ['upManAtArms', 'upLongSwordsman', 'upTwoHandedSwordsman', 'upChampion'] }] },
    { desc: 'Blacksmiths and Siege Workshops cost -50% stone and wood.',
      effects: [{ k: 'costBuilding', sel: { ids: ['blacksmith', 'siegeWorkshop'] }, res: 'wood', mult: 0.5 }] },
    { desc: 'Town Centers +50% HP.', effects: [{ k: 'buildingStat', sel: { ids: ['townCenter'] }, stat: 'hp', mult: 1.5 }] },
  ],
  team: { desc: 'Blacksmiths work 80% faster.', effects: [{ k: 'researchSpeed', mult: 0.55 }] },
  ut1: { id: 'stirrups', name: 'Stirrups', cost: { food: 400, gold: 300 }, time: 40,
    desc: 'Cavalry attack 33% faster.', effects: [{ k: 'unitStat', sel: CAV, stat: 'reload', mult: 0.75 }] },
  ut2: { id: 'bagains', name: 'Bagains', cost: { food: 1200, gold: 500 }, time: 40,
    desc: 'Militia-line +5 melee armor.', effects: [{ k: 'unitStat', sel: INF, stat: 'armor.melee', add: 5 }] },
  extraBuildings: ['krepost'],
  disabled: { units: ['arbalester', 'heavyCamelRider', 'paladin', 'bombardCannon'] },
});

C('burgundians', {
  name: 'Burgundians', focus: 'Cavalry and Gunpowder', color: '#8e5ec4',
  uu: 'coustillier', uuElite: 'eliteCoustillier',
  bonuses: [
    { desc: 'Economic upgrades available one age earlier and cost -40% food.',
      effects: [{ k: 'costTech', ids: ['wheelbarrow', 'handCart', 'horseCollar', 'heavyPlow', 'cropRotation'], res: 'food', mult: 0.6 }] },
    { desc: 'Cavalier upgrade available in the Castle Age.', effects: [{ k: 'techAge', id: 'upCavalier', age: 'castle' }] },
    { desc: 'Gunpowder units +25% attack.',
      effects: [{ k: 'unitStat', sel: { classes: ['gunpowder'] }, stat: 'atk.pierce', mult: 1.25 }] },
  ],
  team: { desc: 'Relics generate both gold and food.', effects: [{ k: 'flag', name: 'relicFood' }] },
  ut1: { id: 'burgundianVineyards', name: 'Burgundian Vineyards', cost: { food: 400, gold: 300 }, time: 40,
    desc: 'Farmers generate gold as well as food.', effects: [{ k: 'flag', name: 'farmGold' }] },
  ut2: { id: 'flemishRevolution', name: 'Flemish Revolution', cost: { food: 800, gold: 450 }, time: 10,
    desc: 'Turns all Villagers into Flemish Militia.', effects: [{ k: 'flag', name: 'flemishRevolution' }] },
  disabled: { units: ['heavyCamelRider', 'siegeOnager', 'eliteSkirmisher'] },
});

C('burmese', {
  name: 'Burmese', focus: 'Monk and Elephant', color: '#c46b2b',
  uu: 'arambai', uuElite: 'eliteArambai',
  bonuses: [
    { desc: 'Monastery technologies are free.', effects: [{ k: 'flag', name: 'freeMonasteryTechs' }] },
    { desc: 'Infantry +1 attack per age (from Feudal).', effects: [{ k: 'unitStat', sel: INF, stat: 'atk.melee', add: 1 }] },
    { desc: 'Lumber Camp technologies are free.',
      effects: [{ k: 'freeTech', ids: ['doubleBitAxe', 'bowSaw', 'twoManSaw'] }] },
  ],
  team: { desc: 'Relics visible on the map from the start.', effects: [{ k: 'flag', name: 'revealRelics' }] },
  ut1: { id: 'howdah', name: 'Howdah', cost: { food: 300, wood: 250 }, time: 40,
    desc: 'Battle Elephants +1/+1 armor.',
    effects: [
      { k: 'unitStat', sel: { classes: ['elephant'] }, stat: 'armor.melee', add: 1 },
      { k: 'unitStat', sel: { classes: ['elephant'] }, stat: 'armor.pierce', add: 1 },
    ] },
  ut2: { id: 'manipurCavalry', name: 'Manipur Cavalry', cost: { food: 650, gold: 400 }, time: 40,
    desc: 'Cavalry and Arambai +6 attack vs buildings.',
    effects: [{ k: 'unitStat', sel: CAV, stat: 'atk.building', add: 6 }] },
  disabled: { units: ['arbalester', 'hussar', 'paladin', 'bombardCannon', 'eliteSkirmisher'] },
});

C('byzantines', {
  name: 'Byzantines', focus: 'Defensive', color: '#c8a45c',
  uu: 'cataphract', uuElite: 'eliteCataphract',
  eliteUpgrade: { cost: { food: 1600, gold: 800 }, time: 60 },
  bonuses: [
    { desc: 'Buildings +10% HP in Dark, +20% Feudal, +30% Castle, +40% Imperial.',
      effects: [{ k: 'buildingStat', sel: { all: true }, stat: 'hp', mult: 1.1 }] },
    { desc: 'Camel Riders, Skirmishers, Pikemen and Halberdiers cost -25%.',
      effects: [{ k: 'cost', sel: { ids: ['camelRider', 'heavyCamelRider', 'skirmisher', 'eliteSkirmisher', 'spearman', 'pikeman', 'halberdier'] }, res: 'all', mult: 0.75 }] },
    { desc: 'Fire Ships +25% attack.',
      effects: [{ k: 'unitStat', sel: { ids: ['fireShip'] }, stat: 'atk.pierce', mult: 1.25 }] },
    { desc: 'Imperial Age costs -33% gold.', effects: [{ k: 'costTech', ids: ['imperialAge'], res: 'gold', mult: 0.67 }] },
  ],
  team: { desc: 'Monks heal 50% faster.', effects: [{ k: 'unitStat', sel: MONK, stat: 'healRate', mult: 1.5 }] },
  ut1: { id: 'greekFire', name: 'Greek Fire', cost: { food: 250, gold: 300 }, time: 40,
    desc: 'Fire Ships +1 range.', effects: [{ k: 'unitStat', sel: { ids: ['fireShip'] }, stat: 'range', add: 1 }] },
  ut2: { id: 'logistica', name: 'Logistica', cost: { food: 800, gold: 600 }, time: 60,
    desc: 'Cataphracts cause trample damage and +6 vs infantry.',
    effects: [{ k: 'unitStat', sel: { ids: ['cataphract', 'eliteCataphract'] }, stat: 'atk.infantry', add: 6 }] },
  disabled: { units: ['siegeOnager', 'heavyCavalryArcher'] },
});

C('celts', {
  name: 'Celts', focus: 'Infantry and Siege', color: '#5fa85f',
  uu: 'woadRaider', uuElite: 'eliteWoadRaider',
  eliteUpgrade: { cost: { food: 1200, gold: 600 }, time: 50 },
  bonuses: [
    { desc: 'Infantry move 15% faster.', effects: [{ k: 'unitStat', sel: INF, stat: 'speed', mult: 1.15 }] },
    { desc: 'Lumberjacks work 15% faster.', effects: [{ k: 'gather', res: 'wood', mult: 1.15 }] },
    { desc: 'Siege weapons fire 25% faster.', effects: [{ k: 'unitStat', sel: SIE, stat: 'reload', mult: 0.8 }] },
    { desc: 'Enemy herdables can always be converted.', effects: [{ k: 'flag', name: 'stealSheep' }] },
  ],
  team: { desc: 'Siege Workshops work 20% faster.', effects: [{ k: 'trainSpeed', mult: 0.8 }] },
  ut1: { id: 'stronghold', name: 'Stronghold', cost: { food: 200, gold: 300 }, time: 40,
    desc: 'Castles and towers fire 25% faster.',
    effects: [{ k: 'buildingStat', sel: { cats: ['defense'], ids: ['castle'] }, stat: 'reload', mult: 0.8 }] },
  ut2: { id: 'furorCeltica', name: 'Furor Celtica', cost: { food: 750, gold: 450 }, time: 50,
    desc: 'Siege Workshop units +40% HP.', effects: [{ k: 'unitStat', sel: SIE, stat: 'hp', mult: 1.4 }] },
  disabled: { units: ['paladin', 'camelRider', 'heavyCamelRider', 'handCannoneer', 'bombardCannon', 'arbalester'] },
});

C('chinese', {
  name: 'Chinese', focus: 'Archer', color: '#d4b038',
  uu: 'chuKoNu', uuElite: 'eliteChuKoNu',
  eliteUpgrade: { cost: { food: 760, gold: 760 }, time: 50 },
  bonuses: [
    { desc: 'Start with 3 extra Villagers but -200 food and -50 wood.',
      effects: [{ k: 'startUnits', id: 'villager', add: 3 },
        { k: 'startResource', res: 'food', add: -200 },
        { k: 'startResource', res: 'wood', add: -50 }] },
    { desc: 'Town Centers support +5 population and cost -50% stone.',
      effects: [{ k: 'buildingStat', sel: { ids: ['townCenter'] }, stat: 'pop', add: 5 }] },
    { desc: 'Technologies cost -10% in Feudal, -15% Castle, -20% Imperial.',
      effects: [{ k: 'costTech', all: true, res: 'all', mult: 0.85 }] },
    { desc: 'Demolition Ships +50% HP.', effects: [{ k: 'unitStat', sel: { ids: ['demolitionShip'] }, stat: 'hp', mult: 1.5 }] },
  ],
  team: { desc: 'Farms +45 food.', effects: [{ k: 'farmFood', add: 45 }] },
  ut1: { id: 'greatWall', name: 'Great Wall', cost: { food: 400, wood: 600 }, time: 40,
    desc: 'Walls and towers +30% HP.',
    effects: [{ k: 'buildingStat', sel: { cats: ['defense'] }, stat: 'hp', mult: 1.3 }] },
  ut2: { id: 'rocketry', name: 'Rocketry', cost: { wood: 750, gold: 750 }, time: 60,
    desc: 'Chu Ko Nu +2 attack, Scorpions +4 attack.',
    effects: [
      { k: 'unitStat', sel: { ids: ['chuKoNu', 'eliteChuKoNu'] }, stat: 'atk.pierce', add: 2 },
      { k: 'unitStat', sel: { ids: ['scorpion', 'heavyScorpion'] }, stat: 'atk.pierce', add: 4 },
    ] },
  disabled: { units: ['paladin', 'siegeRam'] },
});

C('cumans', {
  name: 'Cumans', focus: 'Cavalry', color: '#a8b84a',
  uu: 'kipchak', uuElite: 'eliteKipchak',
  bonuses: [
    { desc: 'Can build a second Town Center in the Feudal Age.', effects: [{ k: 'flag', name: 'feudalTC' }] },
    { desc: 'Cavalry move 5% faster in Feudal, 10% Castle, 15% Imperial.',
      effects: [{ k: 'unitStat', sel: CAV, stat: 'speed', mult: 1.1 }] },
    { desc: 'Siege Workshop available in the Feudal Age.', effects: [{ k: 'buildingAge', id: 'siegeWorkshop', age: 'feudal' }] },
  ],
  team: { desc: 'Palisade Walls +50% HP.', effects: [{ k: 'buildingStat', sel: { ids: ['palisadeWall'] }, stat: 'hp', mult: 1.5 }] },
  ut1: { id: 'steppeHusbandry', name: 'Steppe Husbandry', cost: { food: 400, wood: 250 }, time: 40,
    desc: 'Scouts, Steppe Lancers and Cavalry Archers train 100% faster.',
    effects: [{ k: 'trainSpeed', mult: 0.5 }] },
  ut2: { id: 'cumanMercenaries', name: 'Cuman Mercenaries', cost: { food: 650, gold: 400 }, time: 40,
    desc: 'Team members can train 10 free Elite Kipchaks at a Castle.', effects: [] },
  disabled: { units: ['arbalester', 'champion', 'bombardCannon', 'heavyCamelRider'] },
});

C('ethiopians', {
  name: 'Ethiopians', focus: 'Archer and Siege', color: '#3f8f6f',
  uu: 'shotelWarrior', uuElite: 'eliteShotelWarrior',
  bonuses: [
    { desc: 'Archers fire 18% faster.', effects: [{ k: 'unitStat', sel: ARC, stat: 'reload', mult: 0.82 }] },
    { desc: 'Receive +100 food and +100 gold when advancing an age.',
      effects: [{ k: 'flag', name: 'ageBonusResources' }] },
    { desc: 'Towers and Outposts have +3 line of sight.',
      effects: [{ k: 'buildingStat', sel: { cats: ['defense'] }, stat: 'los', add: 3 }] },
  ],
  team: { desc: 'Team members start with an extra Villager.', effects: [{ k: 'startUnits', id: 'villager', add: 1 }] },
  ut1: { id: 'royalHeirs', name: 'Royal Heirs', cost: { food: 300, gold: 100 }, time: 40,
    desc: 'Shotel Warriors train much faster.', effects: [{ k: 'trainSpeed', mult: 0.5 }] },
  ut2: { id: 'torsionEngines', name: 'Torsion Engines', cost: { food: 1000, wood: 600 }, time: 60,
    desc: 'Siege weapon blast radius increased.',
    effects: [{ k: 'unitStat', sel: SIE, stat: 'blast', add: 0.4 }] },
  disabled: { units: ['paladin', 'heavyCamelRider', 'handCannoneer'] },
});

C('franks', {
  name: 'Franks', focus: 'Cavalry', color: '#3f6fc4',
  uu: 'throwingAxeman', uuElite: 'eliteThrowingAxeman',
  eliteUpgrade: { cost: { food: 1000, gold: 750 }, time: 60 },
  bonuses: [
    { desc: 'Cavalry +20% HP starting in the Feudal Age.',
      effects: [{ k: 'unitStat', sel: CAV, stat: 'hp', mult: 1.2 }] },
    { desc: 'Farm upgrades are free.',
      effects: [{ k: 'freeTech', ids: ['horseCollar', 'heavyPlow', 'cropRotation'] }] },
    { desc: 'Castles cost -25%.',
      effects: [{ k: 'costBuilding', sel: { ids: ['castle'] }, res: 'stone', mult: 0.75 }] },
    { desc: 'Foragers work 25% faster.', effects: [{ k: 'gather', res: 'berries', mult: 1.25 }] },
  ],
  team: { desc: 'Knights have +2 line of sight.', effects: [{ k: 'unitStat', sel: CAV, stat: 'los', add: 2 }] },
  ut1: { id: 'chivalry', name: 'Chivalry', cost: { food: 300, gold: 300 }, time: 40,
    desc: 'Stables work 40% faster.', effects: [{ k: 'trainSpeed', mult: 0.6 }] },
  ut2: { id: 'beardedAxe', name: 'Bearded Axe', cost: { food: 400, gold: 300 }, time: 40,
    desc: 'Throwing Axemen +1 range.',
    effects: [{ k: 'unitStat', sel: { ids: ['throwingAxeman', 'eliteThrowingAxeman'] }, stat: 'range', add: 1 }] },
  disabled: { units: ['arbalester', 'heavyCamelRider', 'bombardCannon'], techs: ['bracer', 'ringArcherArmor'] },
});

C('goths', {
  name: 'Goths', focus: 'Infantry', color: '#8b5a2b',
  uu: 'huskarl', uuElite: 'eliteHuskarl',
  eliteUpgrade: { cost: { food: 1200, gold: 550 }, time: 50 },
  bonuses: [
    { desc: 'Infantry cost -35%.', effects: [{ k: 'cost', sel: INF, res: 'all', mult: 0.65 }] },
    { desc: 'Infantry +1 attack against buildings.', effects: [{ k: 'unitStat', sel: INF, stat: 'atk.building', add: 1 }] },
    { desc: 'Villagers +5 attack against Wild Boar; hunters carry +15.',
      effects: [{ k: 'gather', res: 'hunt', mult: 1.25 }] },
    { desc: '+10 population cap in the Imperial Age.', effects: [{ k: 'popCap', add: 10 }] },
  ],
  team: { desc: 'Barracks work 20% faster.', effects: [{ k: 'trainSpeed', mult: 0.8 }] },
  ut1: { id: 'anarchy', name: 'Anarchy', cost: { food: 450, gold: 250 }, time: 40,
    desc: 'Huskarls can be created at Barracks.', effects: [{ k: 'trainAt', unit: 'huskarl', building: 'barracks' }] },
  ut2: { id: 'perfusion', name: 'Perfusion', cost: { food: 400, gold: 600 }, time: 40,
    desc: 'Barracks units train 100% faster.', effects: [{ k: 'trainSpeed', mult: 0.5 }] },
  disabled: { units: ['paladin', 'bombardCannon', 'heavyCamelRider'], buildings: ['stoneWall', 'fortifiedWall', 'keep', 'bombardTower'] },
});

C('huns', {
  name: 'Huns', focus: 'Cavalry', color: '#9b3f3f',
  uu: 'tarkan', uuElite: 'eliteTarkan',
  bonuses: [
    { desc: 'Start with -100 wood but need no Houses.', effects: [{ k: 'flag', name: 'noHouses' }, { k: 'startResource', res: 'wood', add: -100 }] },
    { desc: 'Cavalry Archers cost -10% in Castle Age, -20% Imperial.',
      effects: [{ k: 'cost', sel: { classes: ['cavalryArcher'] }, res: 'all', mult: 0.85 }] },
    { desc: 'Trebuchets are 30% more accurate.', effects: [{ k: 'unitStat', sel: { ids: ['trebuchet'] }, stat: 'accuracy', add: 0.3 }] },
  ],
  team: { desc: 'Stables work 20% faster.', effects: [{ k: 'trainSpeed', mult: 0.8 }] },
  ut1: { id: 'marauders', name: 'Marauders', cost: { food: 300, gold: 200 }, time: 40,
    desc: 'Tarkans can be created at Stables.', effects: [{ k: 'trainAt', unit: 'tarkan', building: 'stable' }] },
  ut2: { id: 'atheism', name: 'Atheism', cost: { food: 500, gold: 500 }, time: 60,
    desc: 'Relic and Wonder victory take +100 years; enemy Relic gold -50%.', effects: [] },
  disabled: { units: ['champion', 'siegeOnager'], techs: ['plateMailArmor'] },
});

C('incas', {
  name: 'Incas', focus: 'Infantry', color: '#d4a017',
  uu: 'kamayuk', uuElite: 'eliteKamayuk',
  eliteUpgrade: { cost: { food: 1000, gold: 800 }, time: 50 },
  bonuses: [
    { desc: 'Start with a free Llama; Houses support 10 population.',
      effects: [{ k: 'buildingStat', sel: { ids: ['house'] }, stat: 'pop', add: 5 }] },
    { desc: 'Villagers benefit from Blacksmith armour upgrades.', effects: [{ k: 'flag', name: 'armoredVillagers' }] },
    { desc: 'Buildings cost -15% stone.', effects: [{ k: 'costBuilding', sel: { all: true }, res: 'stone', mult: 0.85 }] },
  ],
  team: { desc: 'Farms built 50% faster.', effects: [{ k: 'buildRate', mult: 1.5 }] },
  ut1: { id: 'andeanSling', name: 'Andean Sling', cost: { food: 400, wood: 250 }, time: 40,
    desc: 'Skirmishers and Slingers have no minimum range.', effects: [{ k: 'flag', name: 'noMinRange' }] },
  ut2: { id: 'fabricShields', name: 'Fabric Shields', cost: { food: 650, gold: 400 }, time: 40,
    desc: 'Kamayuks, Slingers and Eagles +1/+2 armour.',
    effects: [
      { k: 'unitStat', sel: { classes: ['eagleWarrior'] }, stat: 'armor.melee', add: 1 },
      { k: 'unitStat', sel: { classes: ['eagleWarrior'] }, stat: 'armor.pierce', add: 2 },
    ] },
  disabled: { units: ['knight', 'cavalier', 'paladin', 'scoutCavalry', 'lightCavalry', 'hussar',
    'camelRider', 'heavyCamelRider', 'cavalryArcher', 'heavyCavalryArcher', 'battleElephant', 'eliteBattleElephant'],
    buildings: ['stable'] },
});

C('hindustanis', {
  name: 'Hindustanis', focus: 'Camel and Gunpowder', color: '#c47ab5',
  uu: 'ghulam', uuElite: 'eliteGhulam',
  bonuses: [
    { desc: 'Villagers cost -10% in Feudal, -15% Castle, -20% Imperial.',
      effects: [{ k: 'cost', sel: VILL, res: 'food', mult: 0.85 }] },
    { desc: 'Camel and Light Cavalry units +1 attack vs buildings per age.',
      effects: [{ k: 'unitStat', sel: { classes: ['camel'] }, stat: 'atk.building', add: 2 }] },
    { desc: 'Gunpowder units +25% HP.',
      effects: [{ k: 'unitStat', sel: { classes: ['gunpowder'] }, stat: 'hp', mult: 1.25 }] },
  ],
  team: { desc: 'Camel units +2 line of sight.', effects: [{ k: 'unitStat', sel: { classes: ['camel'] }, stat: 'los', add: 2 }] },
  ut1: { id: 'grandTrunkRoad', name: 'Grand Trunk Road', cost: { food: 400, wood: 300 }, time: 40,
    desc: 'Trade units generate 10% more gold; villagers gather gold faster.',
    effects: [{ k: 'gather', res: 'gold', mult: 1.1 }] },
  ut2: { id: 'shatagni', name: 'Shatagni', cost: { food: 600, gold: 500 }, time: 40,
    desc: 'Hand Cannoneers +1 range.',
    effects: [{ k: 'unitStat', sel: { ids: ['handCannoneer'] }, stat: 'range', add: 1 }] },
  extraBuildings: ['caravanserai'],
  disabled: { units: ['knight', 'cavalier', 'paladin', 'arbalester', 'battleElephant'] },
});

C('italians', {
  name: 'Italians', focus: 'Archer and Naval', color: '#4ba86f',
  uu: 'genoeseCrossbowman', uuElite: 'eliteGenoeseCrossbowman',
  bonuses: [
    { desc: 'Advancing to the next age costs -15%.', effects: [{ k: 'costTech', ids: ['feudalAge', 'castleAge', 'imperialAge'], res: 'all', mult: 0.85 }] },
    { desc: 'Dock and University technologies cost -33%.',
      effects: [{ k: 'costTech', ids: ['gillnets', 'careening', 'dryDock', 'shipwright', 'masonry', 'architecture', 'ballistics', 'chemistry'], res: 'all', mult: 0.67 }] },
    { desc: 'Fishing Ships cost -15%.', effects: [{ k: 'cost', sel: { ids: ['fishingShip'] }, res: 'wood', mult: 0.85 }] },
    { desc: 'Gunpowder units cost -20%.', effects: [{ k: 'cost', sel: { classes: ['gunpowder'] }, res: 'all', mult: 0.8 }] },
  ],
  team: { desc: 'Condottieri available at Barracks in the Imperial Age.', effects: [] },
  ut1: { id: 'pavise', name: 'Pavise', cost: { food: 300, gold: 150 }, time: 40,
    desc: 'Foot archers and Condottieri +1/+1 armour.',
    effects: [
      { k: 'unitStat', sel: ARC, stat: 'armor.melee', add: 1 },
      { k: 'unitStat', sel: ARC, stat: 'armor.pierce', add: 1 },
    ] },
  ut2: { id: 'silkRoad', name: 'Silk Road', cost: { food: 600, gold: 450 }, time: 40,
    desc: 'Trade units cost -50%.', effects: [{ k: 'cost', sel: { cats: ['trade'] }, res: 'all', mult: 0.5 }] },
  disabled: { units: ['paladin', 'heavyCamelRider', 'siegeOnager'] },
});

C('japanese', {
  name: 'Japanese', focus: 'Infantry', color: '#d45f7a',
  uu: 'samurai', uuElite: 'eliteSamurai',
  eliteUpgrade: { cost: { food: 750, gold: 650 }, time: 50 },
  bonuses: [
    { desc: 'Fishing Ships +2x HP and work 5%/10%/15%/20% faster by age.',
      effects: [{ k: 'unitStat', sel: { ids: ['fishingShip'] }, stat: 'hp', mult: 2 }] },
    { desc: 'Mills, Lumber and Mining Camps cost -50%.',
      effects: [{ k: 'costBuilding', sel: { ids: ['mill', 'lumberCamp', 'miningCamp'] }, res: 'wood', mult: 0.5 }] },
    { desc: 'Infantry attack 25% faster from the Feudal Age.',
      effects: [{ k: 'unitStat', sel: INF, stat: 'reload', mult: 0.8 }] },
  ],
  team: { desc: 'Galleys +50% line of sight.', effects: [{ k: 'unitStat', sel: { cats: ['naval'] }, stat: 'los', mult: 1.5 }] },
  ut1: { id: 'yasama', name: 'Yasama', cost: { food: 300, wood: 100 }, time: 40,
    desc: 'Towers fire two extra arrows.',
    effects: [{ k: 'buildingStat', sel: { cats: ['defense'] }, stat: 'baseArrows', add: 2 }] },
  ut2: { id: 'kataparuto', name: 'Kataparuto', cost: { food: 750, gold: 400 }, time: 60,
    desc: 'Trebuchets fire and pack faster.',
    effects: [{ k: 'unitStat', sel: { ids: ['trebuchet'] }, stat: 'reload', mult: 0.7 }] },
  disabled: { units: ['paladin', 'heavyCamelRider', 'handCannoneer', 'siegeRam'] },
});

C('khmer', {
  name: 'Khmer', focus: 'Siege and Elephant', color: '#8fa832',
  uu: 'ballistaElephant', uuElite: 'eliteBallistaElephant',
  bonuses: [
    { desc: 'No buildings needed to advance an age; Villagers can garrison in Houses.',
      effects: [{ k: 'flag', name: 'noAgePrereq' }] },
    { desc: 'Farmers drop off food instantly.', effects: [{ k: 'flag', name: 'instantFarmDrop' }] },
    { desc: 'Battle Elephants move 10% faster.',
      effects: [{ k: 'unitStat', sel: { classes: ['elephant'] }, stat: 'speed', mult: 1.1 }] },
  ],
  team: { desc: 'Scorpions +1 range.', effects: [{ k: 'unitStat', sel: { ids: ['scorpion', 'heavyScorpion'] }, stat: 'range', add: 1 }] },
  ut1: { id: 'tuskSwords', name: 'Tusk Swords', cost: { food: 300, gold: 200 }, time: 40,
    desc: 'Battle Elephants +3 attack.',
    effects: [{ k: 'unitStat', sel: { classes: ['elephant'] }, stat: 'atk.melee', add: 3 }] },
  ut2: { id: 'doubleCrossbow', name: 'Double Crossbow', cost: { food: 500, gold: 300 }, time: 40,
    desc: 'Ballista Elephants and Scorpions fire two projectiles.',
    effects: [{ k: 'unitStat', sel: { ids: ['scorpion', 'heavyScorpion', 'ballistaElephant', 'eliteBallistaElephant'] }, stat: 'volley', add: 2 }] },
  disabled: { units: ['champion', 'heavyCamelRider', 'paladin'], techs: ['bracer'] },
});

C('koreans', {
  name: 'Koreans', focus: 'Tower and Naval', color: '#5f8fc4',
  uu: 'warWagon', uuElite: 'eliteWarWagon',
  eliteUpgrade: { cost: { food: 1500, gold: 700 }, time: 75 },
  bonuses: [
    { desc: 'Villagers +2 line of sight; stone miners work 20% faster.',
      effects: [{ k: 'gather', res: 'stone', mult: 1.2 }, { k: 'unitStat', sel: VILL, stat: 'los', add: 2 }] },
    { desc: 'Towers upgrade for free and have +1 range in Castle, +2 in Imperial.',
      effects: [{ k: 'buildingStat', sel: { cats: ['defense'] }, stat: 'range', add: 1 }] },
    { desc: 'Military units cost -20% wood.', effects: [{ k: 'cost', sel: { cats: ['siege', 'archer'] }, res: 'wood', mult: 0.8 }] },
  ],
  team: { desc: 'Mangonel-line minimum range reduced.', effects: [{ k: 'unitStat', sel: SIE, stat: 'minRange', add: -1 }] },
  ut1: { id: 'eupseong', name: 'Eupseong', cost: { food: 300, wood: 200 }, time: 40,
    desc: 'Towers +2 range.', effects: [{ k: 'buildingStat', sel: { cats: ['defense'] }, stat: 'range', add: 2 }] },
  ut2: { id: 'shinkichon', name: 'Shinkichon', cost: { wood: 800, gold: 500 }, time: 60,
    desc: 'Mangonel-line +1 range.',
    effects: [{ k: 'unitStat', sel: { ids: ['mangonel', 'onager', 'siegeOnager'] }, stat: 'range', add: 1 }] },
  disabled: { units: ['paladin', 'camelRider', 'heavyCamelRider', 'arbalester'] },
});

C('lithuanians', {
  name: 'Lithuanians', focus: 'Cavalry and Monk', color: '#7f5fc4',
  uu: 'leitis', uuElite: 'eliteLeitis',
  bonuses: [
    { desc: 'Start with +150 food.', effects: [{ k: 'startResource', res: 'food', add: 150 }] },
    { desc: 'Each garrisoned Relic gives Knights and Leitis +1 attack (max +4).',
      effects: [{ k: 'flag', name: 'relicAttack' }] },
    { desc: 'Monasteries work 20% faster.', effects: [{ k: 'researchSpeed', mult: 0.8 }] },
    { desc: 'Spearman-line moves 10% faster.',
      effects: [{ k: 'unitStat', sel: { classes: ['spearman'] }, stat: 'speed', mult: 1.1 }] },
  ],
  team: { desc: 'Monks +3 line of sight.', effects: [{ k: 'unitStat', sel: MONK, stat: 'los', add: 3 }] },
  ut1: { id: 'hillForts', name: 'Hill Forts', cost: { food: 400, wood: 300 }, time: 40,
    desc: 'Town Centers +3 range.', effects: [{ k: 'buildingStat', sel: { ids: ['townCenter'] }, stat: 'range', add: 3 }] },
  ut2: { id: 'towerShields', name: 'Tower Shields', cost: { food: 600, wood: 400 }, time: 40,
    desc: 'Spearman-line and Skirmishers +2 pierce armour.',
    effects: [{ k: 'unitStat', sel: { classes: ['spearman'] }, stat: 'armor.pierce', add: 2 }] },
  disabled: { units: ['siegeOnager', 'arbalester', 'heavyCamelRider'] },
});

C('magyars', {
  name: 'Magyars', focus: 'Cavalry', color: '#b58f3f',
  uu: 'magyarHuszar', uuElite: 'eliteMagyarHuszar',
  bonuses: [
    { desc: 'Villagers kill wolves with one strike.', effects: [{ k: 'unitStat', sel: VILL, stat: 'atk.melee', add: 0 }] },
    { desc: 'Scout Cavalry-line costs -15%.',
      effects: [{ k: 'cost', sel: { ids: ['scoutCavalry', 'lightCavalry', 'hussar'] }, res: 'food', mult: 0.85 }] },
    { desc: 'Forging, Iron Casting and Blast Furnace are free.',
      effects: [{ k: 'freeTech', ids: ['forging', 'ironCasting', 'blastFurnace'] }] },
  ],
  team: { desc: 'Foot archers +2 line of sight.', effects: [{ k: 'unitStat', sel: ARC, stat: 'los', add: 2 }] },
  ut1: { id: 'corvinianArmy', name: 'Corvinian Army', cost: { food: 300, gold: 200 }, time: 40,
    desc: 'Magyar Huszars cost no gold.',
    effects: [{ k: 'cost', sel: { ids: ['magyarHuszar', 'eliteMagyarHuszar'] }, res: 'gold', mult: 0 }] },
  ut2: { id: 'recurveBow', name: 'Recurve Bow', cost: { food: 600, gold: 400 }, time: 40,
    desc: 'Cavalry Archers +1 range, +1 attack.',
    effects: [
      { k: 'unitStat', sel: { classes: ['cavalryArcher'] }, stat: 'range', add: 1 },
      { k: 'unitStat', sel: { classes: ['cavalryArcher'] }, stat: 'atk.pierce', add: 1 },
    ] },
  disabled: { units: ['camelRider', 'heavyCamelRider', 'bombardCannon'] },
});

C('malay', {
  name: 'Malay', focus: 'Naval and Infantry', color: '#4fb5a8',
  uu: 'karambitWarrior', uuElite: 'eliteKarambitWarrior',
  bonuses: [
    { desc: 'Advance to the next age 66% faster.', effects: [{ k: 'ageSpeed', mult: 0.6 }] },
    { desc: 'Fish traps are cheaper and provide unlimited food.', effects: [{ k: 'flag', name: 'infiniteFishTrap' }] },
    { desc: 'Battle Elephants cost -30%.',
      effects: [{ k: 'cost', sel: { classes: ['elephant'] }, res: 'all', mult: 0.7 }] },
  ],
  team: { desc: 'Docks +100% line of sight.', effects: [{ k: 'buildingStat', sel: { ids: ['dock'] }, stat: 'los', mult: 2 }] },
  ut1: { id: 'thalassocracy', name: 'Thalassocracy', cost: { food: 300, wood: 200 }, time: 40,
    desc: 'Upgrades Docks to Harbors, which shoot arrows.',
    effects: [{ k: 'buildingStat', sel: { ids: ['dock'] }, stat: 'baseArrows', add: 3 }] },
  ut2: { id: 'forcedLevy', name: 'Forced Levy', cost: { food: 500, gold: 250 }, time: 40,
    desc: 'Militia-line costs gold replaced by food.',
    effects: [{ k: 'cost', sel: { ids: ['militia', 'manAtArms', 'longSwordsman', 'twoHandedSwordsman', 'champion'] }, res: 'gold', mult: 0 }] },
  disabled: { units: ['paladin', 'heavyCamelRider', 'siegeOnager', 'bombardCannon'], techs: ['plateMailArmor', 'bracer'] },
});

C('malians', {
  name: 'Malians', focus: 'Infantry', color: '#c98f2f',
  uu: 'gbeto', uuElite: 'eliteGbeto',
  bonuses: [
    { desc: 'Buildings cost -15% wood.', effects: [{ k: 'costBuilding', sel: { all: true }, res: 'wood', mult: 0.85 }] },
    { desc: 'Gold Mining is free.', effects: [{ k: 'freeTech', ids: ['goldMining'] }] },
    { desc: 'Barracks units +1 pierce armour per age from Feudal.',
      effects: [{ k: 'unitStat', sel: INF, stat: 'armor.pierce', add: 2 }] },
  ],
  team: { desc: 'University technologies research 80% faster.', effects: [{ k: 'researchSpeed', mult: 0.55 }] },
  ut1: { id: 'tigui', name: 'Tigui', cost: { food: 300, gold: 200 }, time: 40,
    desc: 'Town Centers fire arrows even when ungarrisoned.',
    effects: [{ k: 'buildingStat', sel: { ids: ['townCenter'] }, stat: 'baseArrows', add: 5 }] },
  ut2: { id: 'farimba', name: 'Farimba', cost: { food: 650, gold: 400 }, time: 40,
    desc: 'Stable units +5 attack.', effects: [{ k: 'unitStat', sel: CAV, stat: 'atk.melee', add: 5 }] },
  disabled: { units: ['arbalester', 'paladin', 'heavyCamelRider'], techs: ['plateBardingArmor'] },
});

C('mayans', {
  name: 'Mayans', focus: 'Archer', color: '#5fb58f',
  uu: 'plumedArcher', uuElite: 'elitePlumedArcher',
  eliteUpgrade: { cost: { food: 700, gold: 500 }, time: 60 },
  bonuses: [
    { desc: 'Start with +1 Villager but -50 food.',
      effects: [{ k: 'startUnits', id: 'villager', add: 1 }, { k: 'startResource', res: 'food', add: -50 }] },
    { desc: 'Resources last 15% longer.', effects: [{ k: 'resourceAmount', mult: 1.15 }] },
    { desc: 'Archery Range units cost -10% Feudal, -20% Castle, -30% Imperial.',
      effects: [{ k: 'cost', sel: ARC, res: 'all', mult: 0.8 }] },
  ],
  team: { desc: 'Walls cost -50%.', effects: [{ k: 'costBuilding', sel: { ids: ['palisadeWall', 'stoneWall', 'fortifiedWall'] }, res: 'all', mult: 0.5 }] },
  ut1: { id: 'hulChe', name: "Hul'che Javelineers", cost: { food: 300, wood: 300 }, time: 40,
    desc: 'Skirmishers throw a second projectile.',
    effects: [{ k: 'unitStat', sel: { ids: ['skirmisher', 'eliteSkirmisher'] }, stat: 'volley', add: 1 }] },
  ut2: { id: 'elDorado', name: 'El Dorado', cost: { food: 750, gold: 450 }, time: 60,
    desc: 'Eagle Warriors +40 HP.',
    effects: [{ k: 'unitStat', sel: { classes: ['eagleWarrior'] }, stat: 'hp', add: 40 }] },
  disabled: { units: ['knight', 'cavalier', 'paladin', 'scoutCavalry', 'lightCavalry', 'hussar',
    'camelRider', 'heavyCamelRider', 'cavalryArcher', 'heavyCavalryArcher', 'handCannoneer', 'bombardCannon'],
    buildings: ['stable'] },
});

C('mongols', {
  name: 'Mongols', focus: 'Cavalry Archer', color: '#a86f3f',
  uu: 'mangudai', uuElite: 'eliteMangudai',
  eliteUpgrade: { cost: { food: 1000, gold: 675 }, time: 50 },
  bonuses: [
    { desc: 'Cavalry Archers fire 25% faster.',
      effects: [{ k: 'unitStat', sel: { classes: ['cavalryArcher'] }, stat: 'reload', mult: 0.8 }] },
    { desc: 'Light Cavalry, Hussars and Steppe Lancers +30% HP.',
      effects: [{ k: 'unitStat', sel: { ids: ['scoutCavalry', 'lightCavalry', 'hussar', 'steppeLancer', 'eliteSteppeLancer'] }, stat: 'hp', mult: 1.3 }] },
    { desc: 'Hunters work 40% faster.', effects: [{ k: 'gather', res: 'hunt', mult: 1.4 }] },
  ],
  team: { desc: 'Scout Cavalry-line +2 line of sight.',
    effects: [{ k: 'unitStat', sel: { ids: ['scoutCavalry', 'lightCavalry', 'hussar'] }, stat: 'los', add: 2 }] },
  ut1: { id: 'nomads', name: 'Nomads', cost: { food: 200, wood: 150 }, time: 40,
    desc: 'Destroyed Houses keep their population support.', effects: [{ k: 'flag', name: 'nomadHouses' }] },
  ut2: { id: 'drill', name: 'Drill', cost: { food: 500, gold: 450 }, time: 40,
    desc: 'Siege Workshop units move 50% faster.',
    effects: [{ k: 'unitStat', sel: SIE, stat: 'speed', mult: 1.5 }] },
  disabled: { units: ['paladin', 'heavyCamelRider', 'battleElephant'], techs: ['plateMailArmor', 'ringArcherArmor'] },
});

C('persians', {
  name: 'Persians', focus: 'Cavalry and Naval', color: '#3fa8a8',
  uu: 'warElephant', uuElite: 'eliteWarElephant',
  eliteUpgrade: { cost: { food: 1600, gold: 1200 }, time: 75 },
  bonuses: [
    { desc: 'Start with +50 food and +50 wood.',
      effects: [{ k: 'startResource', res: 'food', add: 50 }, { k: 'startResource', res: 'wood', add: 50 }] },
    { desc: 'Town Centers and Docks have double HP and work 10%/15%/20% faster.',
      effects: [{ k: 'buildingStat', sel: { ids: ['townCenter', 'dock'] }, stat: 'hp', mult: 2 }] },
    { desc: 'Knight-line +2 attack vs Archers.',
      effects: [{ k: 'unitStat', sel: { ids: ['knight', 'cavalier', 'paladin'] }, stat: 'atk.archer', add: 2 }] },
  ],
  team: { desc: 'Knights +2 attack vs Archers.', effects: [] },
  ut1: { id: 'kamandaran', name: 'Kamandaran', cost: { food: 300, gold: 200 }, time: 40,
    desc: 'Archers cost wood instead of gold.',
    effects: [{ k: 'cost', sel: ARC, res: 'gold', mult: 0 }] },
  ut2: { id: 'mahouts', name: 'Mahouts', cost: { food: 300, gold: 300 }, time: 50,
    desc: 'War Elephants move 30% faster.',
    effects: [{ k: 'unitStat', sel: { ids: ['warElephant', 'eliteWarElephant'] }, stat: 'speed', mult: 1.3 }] },
  disabled: { units: ['eliteSkirmisher', 'arbalester'], techs: ['ringArcherArmor'] },
});

C('poles', {
  name: 'Poles', focus: 'Cavalry and Gunpowder', color: '#cf5f5f',
  uu: 'obuch', uuElite: 'eliteObuch',
  bonuses: [
    { desc: 'Stone miners generate gold in addition to stone.', effects: [{ k: 'flag', name: 'stoneGold' }] },
    { desc: 'Scout Cavalry-line costs -60% food, +25% gold.',
      effects: [{ k: 'cost', sel: { ids: ['scoutCavalry', 'lightCavalry', 'hussar'] }, res: 'food', mult: 0.4 }] },
    { desc: 'Folwark replaces the Mill and gathers from nearby farms.', effects: [{ k: 'flag', name: 'folwark' }] },
  ],
  team: { desc: 'Farms cost -25% wood.',
    effects: [{ k: 'costBuilding', sel: { ids: ['farm'] }, res: 'wood', mult: 0.75 }] },
  ut1: { id: 'szlachtaPrivileges', name: 'Szlachta Privileges', cost: { food: 400, gold: 300 }, time: 40,
    desc: 'Knight-line costs -60% gold.',
    effects: [{ k: 'cost', sel: { ids: ['knight', 'cavalier', 'paladin'] }, res: 'gold', mult: 0.4 }] },
  ut2: { id: 'lechiticLegacy', name: 'Lechitic Legacy', cost: { food: 700, gold: 400 }, time: 40,
    desc: 'Knight-line deals trample damage.',
    effects: [{ k: 'unitStat', sel: { ids: ['knight', 'cavalier', 'paladin'] }, stat: 'blast', add: 0.5 }] },
  disabled: { units: ['arbalester', 'heavyCamelRider', 'siegeOnager'] },
});

C('portuguese', {
  name: 'Portuguese', focus: 'Naval and Gunpowder', color: '#4f9fcf',
  uu: 'organGun', uuElite: 'eliteOrganGun',
  bonuses: [
    { desc: 'All units cost -20% gold.', effects: [{ k: 'cost', sel: { all: true }, res: 'gold', mult: 0.8 }] },
    { desc: 'Ships +10% HP.', effects: [{ k: 'unitStat', sel: { cats: ['naval'] }, stat: 'hp', mult: 1.1 }] },
    { desc: 'Technologies research 25% faster.', effects: [{ k: 'researchSpeed', mult: 0.75 }] },
  ],
  team: { desc: 'Reveal all allied line of sight.', effects: [{ k: 'flag', name: 'cartography' }] },
  ut1: { id: 'carrack', name: 'Carrack', cost: { food: 300, wood: 200 }, time: 40,
    desc: 'Ships +1/+1 armour.',
    effects: [
      { k: 'unitStat', sel: { cats: ['naval'] }, stat: 'armor.melee', add: 1 },
      { k: 'unitStat', sel: { cats: ['naval'] }, stat: 'armor.pierce', add: 1 },
    ] },
  ut2: { id: 'arquebus', name: 'Arquebus', cost: { food: 700, gold: 400 }, time: 40,
    desc: 'Gunpowder units fire with ballistics precision.', effects: [{ k: 'flag', name: 'ballistics' }] },
  extraBuildings: ['feitoria'],
  disabled: { units: ['paladin', 'heavyCamelRider', 'siegeRam'] },
});

C('saracens', {
  name: 'Saracens', focus: 'Naval and Camel', color: '#cfa83f',
  uu: 'mameluke', uuElite: 'eliteMameluke',
  eliteUpgrade: { cost: { food: 900, gold: 500 }, time: 50 },
  bonuses: [
    { desc: 'Market trade fee is only 5%.', effects: [{ k: 'marketFee', set: 0.05 }] },
    { desc: 'Transport Ships have double HP and carry capacity.',
      effects: [{ k: 'unitStat', sel: { ids: ['transportShip'] }, stat: 'hp', mult: 2 }] },
    { desc: 'Archers +3 attack vs buildings; Camels attack 20% faster.',
      effects: [
        { k: 'unitStat', sel: ARC, stat: 'atk.building', add: 3 },
        { k: 'unitStat', sel: { classes: ['camel'] }, stat: 'reload', mult: 0.8 },
      ] },
  ],
  team: { desc: 'Foot archers +3 attack vs buildings.', effects: [] },
  ut1: { id: 'madrasah', name: 'Madrasah', cost: { food: 200, gold: 100 }, time: 40,
    desc: 'Killed Monks return 33% of their cost.', effects: [{ k: 'flag', name: 'madrasah' }] },
  ut2: { id: 'zealotry', name: 'Zealotry', cost: { food: 750, gold: 800 }, time: 60,
    desc: 'Camel units +20 HP.',
    effects: [{ k: 'unitStat', sel: { classes: ['camel'] }, stat: 'hp', add: 20 }] },
  disabled: { units: ['paladin', 'siegeOnager'], techs: ['plateBardingArmor'] },
});

C('sicilians', {
  name: 'Sicilians', focus: 'Infantry and Castle', color: '#cf7f5f',
  uu: 'serjeant', uuElite: 'eliteSerjeant',
  bonuses: [
    { desc: 'Land military units take 33% less bonus damage.', effects: [{ k: 'flag', name: 'bonusResist' }] },
    { desc: 'Farm upgrades give +100% additional food.', effects: [{ k: 'farmFood', add: 100 }] },
    { desc: 'Castles and Town Centers built 100% faster.', effects: [{ k: 'buildRate', mult: 1.4 }] },
  ],
  team: { desc: 'Transport Ships +5 carry capacity.', effects: [] },
  ut1: { id: 'firstCrusade', name: 'First Crusade', cost: { food: 300, gold: 300 }, time: 40,
    desc: 'Each Town Center spawns 5 Serjeants once.', effects: [{ k: 'flag', name: 'firstCrusade' }] },
  ut2: { id: 'scutage', name: 'Scutage', cost: { food: 600, gold: 400 }, time: 40,
    desc: 'Team receives 15 gold for each military unit trained.', effects: [{ k: 'flag', name: 'scutage' }] },
  extraBuildings: ['donjon'],
  disabled: { units: ['heavyCamelRider', 'arbalester', 'siegeOnager'] },
});

C('slavs', {
  name: 'Slavs', focus: 'Infantry and Siege', color: '#9f7fbf',
  uu: 'boyar', uuElite: 'eliteBoyar',
  bonuses: [
    { desc: 'Farmers work 15% faster.', effects: [{ k: 'gather', res: 'farm', mult: 1.15 }] },
    { desc: 'Siege Workshop units cost -15%.', effects: [{ k: 'cost', sel: SIE, res: 'all', mult: 0.85 }] },
    { desc: 'Tracking is free.', effects: [{ k: 'freeTech', ids: ['tracking'] }] },
  ],
  team: { desc: 'Military buildings support +5 population.',
    effects: [{ k: 'buildingStat', sel: { cats: ['military'] }, stat: 'pop', add: 5 }] },
  ut1: { id: 'orthodoxy', name: 'Orthodoxy', cost: { food: 400, gold: 300 }, time: 40,
    desc: 'Monks +3/+3 armour.',
    effects: [
      { k: 'unitStat', sel: MONK, stat: 'armor.melee', add: 3 },
      { k: 'unitStat', sel: MONK, stat: 'armor.pierce', add: 3 },
    ] },
  ut2: { id: 'druzhina', name: 'Druzhina', cost: { food: 1000, gold: 800 }, time: 60,
    desc: 'Infantry deal 5 trample damage.',
    effects: [{ k: 'unitStat', sel: INF, stat: 'blast', add: 0.4 }] },
  disabled: { units: ['arbalester', 'heavyCamelRider', 'paladin', 'handCannoneer'], techs: ['bracer'] },
});

C('spanish', {
  name: 'Spanish', focus: 'Gunpowder', color: '#cf9f3f',
  uu: 'conquistador', uuElite: 'eliteConquistador',
  eliteUpgrade: { cost: { food: 1200, gold: 600 }, time: 50 },
  bonuses: [
    { desc: 'Builders work 30% faster.', effects: [{ k: 'buildRate', mult: 1.3 }] },
    { desc: 'Blacksmith upgrades cost no gold.', effects: [{ k: 'flag', name: 'freeBlacksmithGold' }] },
    { desc: 'Cannon Galleons and gunpowder units fire with ballistics precision.',
      effects: [{ k: 'unitStat', sel: { classes: ['gunpowder'] }, stat: 'accuracy', add: 0.25 }] },
  ],
  team: { desc: 'Trade units generate +25% gold.', effects: [{ k: 'tradeRate', mult: 1.25 }] },
  ut1: { id: 'inquisition', name: 'Inquisition', cost: { food: 400, gold: 300 }, time: 40,
    desc: 'Monks convert much faster.', effects: [{ k: 'unitStat', sel: MONK, stat: 'reload', mult: 0.7 }] },
  ut2: { id: 'supremacy', name: 'Supremacy', cost: { food: 400, gold: 250 }, time: 60,
    desc: 'Villagers are far better in combat.',
    effects: [
      { k: 'unitStat', sel: VILL, stat: 'atk.melee', add: 6 },
      { k: 'unitStat', sel: VILL, stat: 'hp', add: 40 },
      { k: 'unitStat', sel: VILL, stat: 'armor.melee', add: 2 },
      { k: 'unitStat', sel: VILL, stat: 'armor.pierce', add: 2 },
    ] },
  disabled: { units: ['crossbowman', 'arbalester', 'battleElephant', 'siegeOnager'] },
});

C('tatars', {
  name: 'Tatars', focus: 'Cavalry Archer', color: '#8fbf5f',
  uu: 'keshik', uuElite: 'eliteKeshik',
  bonuses: [
    { desc: 'Herdables contain +50% food.', effects: [{ k: 'gather', res: 'sheep', mult: 1.5 }] },
    { desc: 'Units deal +25% damage when attacking from higher ground.', effects: [{ k: 'flag', name: 'elevationBonus' }] },
    { desc: 'Free Parthian Tactics; Cavalry Archers +2 line of sight.',
      effects: [{ k: 'freeTech', ids: ['parthianTactics'] }] },
  ],
  team: { desc: 'Scouts and Steppe Lancers +2 line of sight.', effects: [] },
  ut1: { id: 'silkArmor', name: 'Silk Armor', cost: { food: 350, gold: 250 }, time: 40,
    desc: 'Scouts, Steppe Lancers and Cavalry Archers +1/+1 armour.',
    effects: [
      { k: 'unitStat', sel: { classes: ['cavalryArcher'] }, stat: 'armor.melee', add: 1 },
      { k: 'unitStat', sel: { classes: ['cavalryArcher'] }, stat: 'armor.pierce', add: 1 },
    ] },
  ut2: { id: 'timuridSiegecraft', name: 'Timurid Siegecraft', cost: { food: 700, gold: 500 }, time: 40,
    desc: 'Trebuchets +1 range; enables Flaming Camels.',
    effects: [{ k: 'unitStat', sel: { ids: ['trebuchet'] }, stat: 'range', add: 1 }] },
  disabled: { units: ['paladin', 'siegeRam', 'bombardCannon'] },
});

C('teutons', {
  name: 'Teutons', focus: 'Infantry', color: '#7f7f9f',
  uu: 'teutonicKnight', uuElite: 'eliteTeutonicKnight',
  eliteUpgrade: { cost: { food: 1200, gold: 600 }, time: 50 },
  bonuses: [
    { desc: 'Monks heal from twice the distance.',
      effects: [{ k: 'unitStat', sel: MONK, stat: 'healRange', mult: 2 }] },
    { desc: 'Towers garrison twice as many units.',
      effects: [{ k: 'buildingStat', sel: { cats: ['defense'] }, stat: 'garrison', mult: 2 }] },
    { desc: 'Murder Holes and Herbal Medicine are free.',
      effects: [{ k: 'freeTech', ids: ['murderHoles', 'herbalMedicine'] }] },
    { desc: 'Farms cost -40% wood.',
      effects: [{ k: 'costBuilding', sel: { ids: ['farm'] }, res: 'wood', mult: 0.6 }] },
    { desc: 'Town Centers +2 attack and +5 garrison.',
      effects: [{ k: 'buildingStat', sel: { ids: ['townCenter'] }, stat: 'atk.pierce', add: 2 }] },
  ],
  team: { desc: 'Units resist conversion.', effects: [{ k: 'flag', name: 'faith' }] },
  ut1: { id: 'ironclad', name: 'Ironclad', cost: { food: 400, gold: 350 }, time: 40,
    desc: 'Siege weapons +4 melee armour.',
    effects: [{ k: 'unitStat', sel: SIE, stat: 'armor.melee', add: 4 }] },
  ut2: { id: 'crenellations', name: 'Crenellations', cost: { food: 600, stone: 400 }, time: 60,
    desc: 'Castles +3 range; garrisoned infantry fire arrows.',
    effects: [{ k: 'buildingStat', sel: { ids: ['castle'] }, stat: 'range', add: 3 }] },
  disabled: { units: ['hussar', 'heavyCavalryArcher', 'arbalester'], techs: ['bracer'] },
});

C('turks', {
  name: 'Turks', focus: 'Gunpowder', color: '#5fcf9f',
  uu: 'janissary', uuElite: 'eliteJanissary',
  eliteUpgrade: { cost: { food: 750, gold: 850 }, time: 55 },
  bonuses: [
    { desc: 'Gunpowder units +25% HP; gunpowder technologies cost -50%.',
      effects: [{ k: 'unitStat', sel: { classes: ['gunpowder'] }, stat: 'hp', mult: 1.25 },
        { k: 'costTech', ids: ['chemistry', 'bombardTower'], res: 'all', mult: 0.5 }] },
    { desc: 'Gold miners work 20% faster.', effects: [{ k: 'gather', res: 'gold', mult: 1.2 }] },
    { desc: 'Chemistry is free; Light Cavalry and Hussar upgrades are free.',
      effects: [{ k: 'freeTech', ids: ['chemistry', 'upLightCavalry', 'upHussar'] }] },
  ],
  team: { desc: 'Gunpowder units train 20% faster.', effects: [{ k: 'trainSpeed', mult: 0.8 }] },
  ut1: { id: 'sipahi', name: 'Sipahi', cost: { food: 350, gold: 250 }, time: 40,
    desc: 'Cavalry Archers +20 HP.',
    effects: [{ k: 'unitStat', sel: { classes: ['cavalryArcher'] }, stat: 'hp', add: 20 }] },
  ut2: { id: 'artillery', name: 'Artillery', cost: { food: 500, gold: 450 }, time: 40,
    desc: 'Bombard Towers, Bombard Cannons and Cannon Galleons +2 range.',
    effects: [{ k: 'unitStat', sel: { classes: ['gunpowder'] }, stat: 'range', add: 2 }] },
  disabled: { units: ['pikeman', 'halberdier', 'arbalester', 'paladin', 'battleElephant'], techs: ['plateMailArmor'] },
});

C('vietnamese', {
  name: 'Vietnamese', focus: 'Archer', color: '#4fbf6f',
  uu: 'rattanArcher', uuElite: 'eliteRattanArcher',
  bonuses: [
    { desc: 'Enemy starting positions are revealed at game start.', effects: [{ k: 'flag', name: 'revealEnemy' }] },
    { desc: 'Archery Range units +20% HP.',
      effects: [{ k: 'unitStat', sel: ARC, stat: 'hp', mult: 1.2 }] },
    { desc: 'Free Conscription in the Imperial Age.', effects: [{ k: 'freeTech', ids: ['conscription'] }] },
  ],
  team: { desc: 'Imperial Skirmisher upgrade available.', effects: [] },
  ut1: { id: 'chatras', name: 'Chatras', cost: { food: 300, gold: 300 }, time: 40,
    desc: 'Battle Elephants +50 HP.',
    effects: [{ k: 'unitStat', sel: { classes: ['elephant'] }, stat: 'hp', add: 50 }] },
  ut2: { id: 'paperMoney', name: 'Paper Money', cost: { food: 500, wood: 500 }, time: 40,
    desc: 'Team members receive 500 gold.', effects: [{ k: 'flag', name: 'paperMoney' }] },
  disabled: { units: ['paladin', 'heavyCamelRider', 'siegeOnager', 'bombardCannon'] },
});

C('vikings', {
  name: 'Vikings', focus: 'Infantry and Naval', color: '#5f9fbf',
  uu: 'berserk', uuElite: 'eliteBerserk',
  eliteUpgrade: { cost: { food: 1000, gold: 800 }, time: 50 },
  bonuses: [
    { desc: 'Wheelbarrow and Hand Cart are free.', effects: [{ k: 'freeTech', ids: ['wheelbarrow', 'handCart'] }] },
    { desc: 'Warships cost -15% Feudal, -15% Castle, -20% Imperial.',
      effects: [{ k: 'cost', sel: { cats: ['naval'] }, res: 'wood', mult: 0.8 }] },
    { desc: 'Infantry +20% HP from the Feudal Age.',
      effects: [{ k: 'unitStat', sel: INF, stat: 'hp', mult: 1.2 }] },
  ],
  team: { desc: 'Docks cost -15%.', effects: [{ k: 'costBuilding', sel: { ids: ['dock'] }, res: 'wood', mult: 0.85 }] },
  ut1: { id: 'chieftains', name: 'Chieftains', cost: { food: 400, wood: 300 }, time: 40,
    desc: 'Infantry gain attack bonuses vs cavalry.',
    effects: [{ k: 'unitStat', sel: INF, stat: 'atk.cavalry', add: 5 }] },
  ut2: { id: 'berserkergang', name: 'Berserkergang', cost: { food: 850, gold: 400 }, time: 40,
    desc: 'Berserks regenerate faster.',
    effects: [{ k: 'unitStat', sel: { ids: ['berserk', 'eliteBerserk'] }, stat: 'regen', add: 0.6 }] },
  disabled: { units: ['paladin', 'camelRider', 'heavyCamelRider', 'battleElephant', 'handCannoneer', 'bombardCannon'],
    techs: ['bracer', 'plateBardingArmor'] },
});

C('bohemians', {
  name: 'Bohemians', focus: 'Gunpowder and Monk', color: '#bf5f9f',
  uu: 'hussiteWagon', uuElite: 'eliteHussiteWagon',
  bonuses: [
    { desc: 'Markets and Mining Camps cost -50% wood.',
      effects: [{ k: 'costBuilding', sel: { ids: ['market', 'miningCamp'] }, res: 'wood', mult: 0.5 }] },
    { desc: 'Blacksmiths and Universities work 80% faster.', effects: [{ k: 'researchSpeed', mult: 0.55 }] },
    { desc: 'Spearman-line and Skirmishers +25% HP.',
      effects: [{ k: 'unitStat', sel: { classes: ['spearman'] }, stat: 'hp', mult: 1.25 }] },
  ],
  team: { desc: 'Monks +5 HP for each Monastery technology.', effects: [] },
  ut1: { id: 'wagenburgTactics', name: 'Wagenburg Tactics', cost: { food: 300, gold: 200 }, time: 40,
    desc: 'Gunpowder units move 15% faster.',
    effects: [{ k: 'unitStat', sel: { classes: ['gunpowder'] }, stat: 'speed', mult: 1.15 }] },
  ut2: { id: 'hussiteReforms', name: 'Hussite Reforms', cost: { food: 500, gold: 300 }, time: 40,
    desc: 'Monks cost -50% and heal nearby units.',
    effects: [{ k: 'cost', sel: MONK, res: 'gold', mult: 0.5 }] },
  disabled: { units: ['paladin', 'heavyCamelRider', 'arbalester', 'siegeRam'] },
});

C('dravidians', {
  name: 'Dravidians', focus: 'Infantry and Naval', color: '#bf9f5f',
  uu: 'urumiSwordsman', uuElite: 'eliteUrumiSwordsman',
  bonuses: [
    { desc: 'Fishing Ships carry +15; receive +50 wood per age advance.',
      effects: [{ k: 'flag', name: 'ageWood' }] },
    { desc: 'Barracks and Archery Range units cost -25% gold.',
      effects: [{ k: 'cost', sel: { cats: ['infantry', 'archer'] }, res: 'gold', mult: 0.75 }] },
    { desc: 'Siege units fire 25% faster.', effects: [{ k: 'unitStat', sel: SIE, stat: 'reload', mult: 0.8 }] },
  ],
  team: { desc: 'Docks provide +5 population.',
    effects: [{ k: 'buildingStat', sel: { ids: ['dock'] }, stat: 'pop', add: 5 }] },
  ut1: { id: 'medicalCorps', name: 'Medical Corps', cost: { food: 300, gold: 200 }, time: 40,
    desc: 'Elephant units regenerate 20 HP per minute.',
    effects: [{ k: 'unitStat', sel: { classes: ['elephant'] }, stat: 'regen', add: 0.33 }] },
  ut2: { id: 'wootzSteel', name: 'Wootz Steel', cost: { food: 700, gold: 500 }, time: 40,
    desc: 'Infantry and cavalry attacks ignore armour.',
    effects: [{ k: 'flag', name: 'wootzSteel' }] },
  disabled: { units: ['knight', 'cavalier', 'paladin', 'camelRider', 'heavyCamelRider', 'cavalryArcher'] },
});

C('bengalis', {
  name: 'Bengalis', focus: 'Elephant and Naval', color: '#9fbf3f',
  uu: 'ratha', uuElite: 'eliteRatha',
  bonuses: [
    { desc: 'Elephant units take 25% less damage from Monks and resist conversion.',
      effects: [{ k: 'flag', name: 'elephantFaith' }] },
    { desc: 'Receive 2 Villagers each time an age is advanced.', effects: [{ k: 'flag', name: 'ageVillagers' }] },
    { desc: 'Trade units generate 10% food in addition to gold.', effects: [{ k: 'flag', name: 'tradeFood' }] },
  ],
  team: { desc: 'Docks +25% HP.', effects: [{ k: 'buildingStat', sel: { ids: ['dock'] }, stat: 'hp', mult: 1.25 }] },
  ut1: { id: 'paiks', name: 'Paiks', cost: { food: 300, gold: 200 }, time: 40,
    desc: 'Rathas and Elephants attack 25% faster.',
    effects: [{ k: 'unitStat', sel: { classes: ['elephant'] }, stat: 'reload', mult: 0.8 }] },
  ut2: { id: 'mahayana', name: 'Mahayana', cost: { food: 600, gold: 400 }, time: 40,
    desc: 'Villagers take 10% less population space.', effects: [{ k: 'popCap', add: 10 }] },
  disabled: { units: ['paladin', 'heavyCamelRider', 'siegeOnager', 'handCannoneer'] },
});

C('gurjaras', {
  name: 'Gurjaras', focus: 'Camel and Cavalry', color: '#df8f4f',
  uu: 'shrivamshaRider', uuElite: 'eliteShrivamshaRider',
  bonuses: [
    { desc: 'Herdables can be garrisoned in Mills; forage 15% faster.',
      effects: [{ k: 'gather', res: 'berries', mult: 1.15 }] },
    { desc: 'Camel and Elephant units +25% attack vs standard buildings.',
      effects: [{ k: 'unitStat', sel: { classes: ['camel'] }, stat: 'atk.building', add: 4 }] },
    { desc: 'Mills provide food; start with a Mill worth of food.',
      effects: [{ k: 'startResource', res: 'food', add: 100 }] },
  ],
  team: { desc: 'Camel units train 25% faster.', effects: [{ k: 'trainSpeed', mult: 0.8 }] },
  ut1: { id: 'kshatriyas', name: 'Kshatriyas', cost: { food: 400, gold: 250 }, time: 40,
    desc: 'Military units cost -25% food.',
    effects: [{ k: 'cost', sel: { cats: ['infantry', 'cavalry', 'archer'] }, res: 'food', mult: 0.75 }] },
  ut2: { id: 'frontierGuards', name: 'Frontier Guards', cost: { food: 700, gold: 400 }, time: 40,
    desc: 'Camel and Elephant units +4 melee armour.',
    effects: [{ k: 'unitStat', sel: { classes: ['camel', 'elephant'] }, stat: 'armor.melee', add: 4 }] },
  disabled: { units: ['arbalester', 'siegeOnager', 'bombardCannon'] },
});

C('armenians', {
  name: 'Armenians', focus: 'Infantry and Naval', color: '#cf5f4f',
  uu: 'compositeBowman', uuElite: 'eliteCompositeBowman',
  bonuses: [
    { desc: 'Barracks and Monastery technologies cost -50% food.',
      effects: [{ k: 'costTech', ids: ['supplies', 'squires', 'arson', 'sanctity', 'fervor', 'faith'], res: 'food', mult: 0.5 }] },
    { desc: 'Infantry attack 15% faster.', effects: [{ k: 'unitStat', sel: INF, stat: 'reload', mult: 0.85 }] },
    { desc: 'Warships +1 pierce armour.',
      effects: [{ k: 'unitStat', sel: { cats: ['naval'] }, stat: 'armor.pierce', add: 1 }] },
  ],
  team: { desc: 'Monasteries work 20% faster.', effects: [{ k: 'researchSpeed', mult: 0.8 }] },
  ut1: { id: 'cilicianFleet', name: 'Cilician Fleet', cost: { food: 300, wood: 200 }, time: 40,
    desc: 'Warships +2 line of sight and attack faster.',
    effects: [{ k: 'unitStat', sel: { cats: ['naval'] }, stat: 'reload', mult: 0.85 }] },
  ut2: { id: 'fereters', name: 'Fereters', cost: { food: 600, gold: 400 }, time: 40,
    desc: 'Infantry and Composite Bowmen +2/+2 armour.',
    effects: [
      { k: 'unitStat', sel: INF, stat: 'armor.melee', add: 2 },
      { k: 'unitStat', sel: INF, stat: 'armor.pierce', add: 2 },
    ] },
  disabled: { units: ['paladin', 'heavyCamelRider', 'siegeOnager'] },
});

C('georgians', {
  name: 'Georgians', focus: 'Cavalry and Defensive', color: '#7fbfcf',
  uu: 'monaspa', uuElite: 'eliteMonaspa',
  bonuses: [
    { desc: 'Buildings on elevation take 15% less damage.', effects: [{ k: 'flag', name: 'hillDefense' }] },
    { desc: 'Units heal when idle near a Town Center, Castle or Monastery.',
      effects: [{ k: 'flag', name: 'regenNearBase' }] },
    { desc: 'Mule Carts replace Lumber and Mining Camps.', effects: [{ k: 'flag', name: 'muleCart' }] },
  ],
  team: { desc: 'Fortified Walls and towers cost -20% stone.',
    effects: [{ k: 'costBuilding', sel: { cats: ['defense'] }, res: 'stone', mult: 0.8 }] },
  ut1: { id: 'svanTowers', name: 'Svan Towers', cost: { food: 300, stone: 200 }, time: 40,
    desc: 'Towers +2 attack.',
    effects: [{ k: 'buildingStat', sel: { cats: ['defense'] }, stat: 'atk.pierce', add: 2 }] },
  ut2: { id: 'aznauri', name: 'Aznauri Cavalry', cost: { food: 600, gold: 400 }, time: 40,
    desc: 'Cavalry take 20% less damage from all sources.',
    effects: [
      { k: 'unitStat', sel: CAV, stat: 'armor.melee', add: 2 },
      { k: 'unitStat', sel: CAV, stat: 'armor.pierce', add: 2 },
    ] },
  disabled: { units: ['arbalester', 'heavyCamelRider', 'siegeOnager'] },
});

C('romans', {
  name: 'Romans', focus: 'Infantry', color: '#bf3f3f',
  uu: 'legionary', uuElite: 'eliteLegionary',
  bonuses: [
    { desc: 'Infantry attack 15% faster from the Feudal Age.',
      effects: [{ k: 'unitStat', sel: INF, stat: 'reload', mult: 0.85 }] },
    { desc: 'Scorpions +1 attack and are more accurate.',
      effects: [{ k: 'unitStat', sel: { ids: ['scorpion', 'heavyScorpion'] }, stat: 'atk.pierce', add: 1 }] },
    { desc: 'Villagers gather from Buildings and repair 50% faster.', effects: [{ k: 'buildRate', mult: 1.5 }] },
    { desc: 'Blacksmith upgrades cost -50% food.', effects: [{ k: 'flag', name: 'cheapBlacksmith' }] },
  ],
  team: { desc: 'Buildings +10% HP.', effects: [{ k: 'buildingStat', sel: { all: true }, stat: 'hp', mult: 1.1 }] },
  ut1: { id: 'balliste', name: 'Ballistas', cost: { food: 300, wood: 200 }, time: 40,
    desc: 'Scorpions fire two projectiles.',
    effects: [{ k: 'unitStat', sel: { ids: ['scorpion', 'heavyScorpion'] }, stat: 'volley', add: 1 }] },
  ut2: { id: 'comitatenses', name: 'Comitatenses', cost: { food: 600, gold: 400 }, time: 40,
    desc: 'Barracks and Stable units train 25% faster.', effects: [{ k: 'trainSpeed', mult: 0.75 }] },
  disabled: { units: ['paladin', 'heavyCamelRider', 'siegeOnager', 'handCannoneer'] },
});

export const CIVILIZATIONS = CIVS;
export const CIV_IDS = Object.keys(CIVS).sort();
export function getCiv(id) {
  const c = CIVS[id];
  if (!c) throw new Error('Unknown civilization: ' + id);
  return c;
}
