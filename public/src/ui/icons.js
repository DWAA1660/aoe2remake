// Procedural 32x32 pixel-art icons, cached as data URLs. Keeping the icons in
// code (rather than downloaded sprites) means the whole UI stays offline-safe
// and matches the chunky palette of the 3D scene.

const cache = new Map();
const S = 32;

const C = {
  bg: '#2b2b33', bgLight: '#3a3a45', edge: '#15151a',
  steel: '#c8d0da', steelD: '#7e8794', wood: '#8a5a2b', woodD: '#5e3d1d',
  gold: '#e0bc3c', goldD: '#a3861f', stone: '#a8a8a2', stoneD: '#6e6e69',
  food: '#d1483c', leaf: '#4f9a45', leafD: '#31682d', skin: '#d9a066',
  cloth: '#dcdcdc', red: '#b03a2e', blue: '#3b6ee0', roof: '#8c3b2f',
  straw: '#c9a54a', white: '#f0f0f0', black: '#1b1b20', purple: '#9b45c9',
  cyan: '#2ec6c6', orange: '#e07a25',
};

function make(draw, bg) {
  const cv = document.createElement('canvas');
  cv.width = S; cv.height = S;
  const g = cv.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.fillStyle = bg || C.bg;
  g.fillRect(0, 0, S, S);
  g.fillStyle = C.bgLight;
  g.fillRect(0, 0, S, 2);
  g.fillStyle = C.edge;
  g.fillRect(0, S - 2, S, 2);
  const p = (x, y, w, h, color) => { g.fillStyle = color; g.fillRect(x, y, w, h); };
  draw(p, g);
  return cv.toDataURL();
}

/* ---- unit / building glyph painters ---- */

const GLYPHS = {
  sword: (p) => { p(15, 4, 3, 17, C.steel); p(11, 20, 11, 3, C.woodD); p(16, 23, 2, 5, C.wood); },
  twoSword: (p) => { p(11, 5, 3, 16, C.steel); p(19, 5, 3, 16, C.steel); p(8, 20, 17, 3, C.woodD); },
  spear: (p) => { p(15, 2, 3, 26, C.wood); p(13, 2, 7, 7, C.steel); p(12, 16, 9, 2, C.woodD); },
  pike: (p) => { p(15, 1, 3, 28, C.wood); p(13, 1, 7, 9, C.steel); p(11, 12, 11, 2, C.steelD); },
  bow: (p) => {
    p(9, 5, 3, 22, C.wood); p(12, 3, 4, 3, C.wood); p(12, 26, 4, 3, C.wood);
    p(14, 5, 1, 22, C.cloth); p(13, 14, 16, 2, C.steelD); p(26, 12, 4, 6, C.steel);
  },
  crossbow: (p) => {
    p(6, 14, 22, 3, C.wood); p(12, 8, 3, 16, C.woodD); p(24, 12, 5, 7, C.steel);
  },
  javelin: (p) => { p(6, 22, 22, 3, C.wood); p(24, 19, 6, 6, C.steel); p(10, 8, 3, 14, C.woodD); },
  gun: (p) => { p(5, 15, 22, 4, C.black); p(4, 18, 9, 5, C.woodD); p(25, 13, 4, 4, C.orange); },
  horse: (p) => {
    p(7, 14, 16, 8, C.woodD); p(19, 8, 7, 8, C.woodD); p(24, 9, 4, 3, C.woodD);
    p(8, 22, 4, 7, C.black); p(18, 22, 4, 7, C.black); p(4, 12, 4, 9, C.wood);
  },
  camel: (p) => {
    p(7, 15, 16, 7, C.straw); p(11, 10, 8, 6, C.straw); p(19, 9, 5, 8, C.straw);
    p(21, 6, 5, 5, C.straw); p(8, 22, 3, 7, C.straw); p(19, 22, 3, 7, C.straw);
  },
  elephant: (p) => {
    p(5, 12, 20, 12, C.stoneD); p(22, 14, 6, 8, C.stoneD); p(25, 20, 3, 8, C.stoneD);
    p(7, 24, 4, 5, C.stone); p(18, 24, 4, 5, C.stone); p(10, 6, 10, 6, C.red);
  },
  ram: (p) => {
    p(4, 12, 24, 5, C.wood); p(3, 11, 4, 7, C.steelD); p(6, 18, 20, 6, C.woodD);
    p(7, 25, 4, 4, C.black); p(21, 25, 4, 4, C.black);
  },
  catapult: (p) => {
    p(5, 20, 22, 4, C.woodD); p(9, 8, 3, 14, C.wood); p(20, 8, 3, 14, C.wood);
    p(11, 6, 14, 3, C.wood); p(22, 3, 6, 6, C.stone);
    p(7, 24, 5, 5, C.black); p(20, 24, 5, 5, C.black);
  },
  ballista: (p) => {
    p(6, 18, 20, 4, C.woodD); p(4, 10, 24, 3, C.wood); p(14, 6, 4, 14, C.woodD);
    p(15, 2, 3, 8, C.steel); p(8, 22, 4, 5, C.black); p(20, 22, 4, 5, C.black);
  },
  cannon: (p) => {
    p(4, 18, 22, 5, C.woodD); p(6, 11, 20, 7, C.black); p(26, 12, 4, 5, C.steelD);
    p(7, 23, 5, 6, C.black); p(19, 23, 5, 6, C.black);
  },
  trebuchet: (p) => {
    p(6, 24, 20, 4, C.woodD); p(9, 8, 3, 17, C.wood); p(20, 8, 3, 17, C.wood);
    p(4, 6, 24, 3, C.wood); p(3, 3, 7, 7, C.stone);
  },
  monk: (p) => {
    p(11, 10, 10, 18, C.white); p(13, 4, 6, 6, C.skin); p(11, 3, 10, 3, C.cloth);
    p(15, 12, 2, 10, C.gold); p(12, 15, 8, 2, C.gold);
  },
  villager: (p) => {
    p(12, 11, 8, 12, C.cloth); p(13, 4, 6, 6, C.skin); p(10, 2, 12, 3, C.straw);
    p(21, 8, 3, 16, C.wood); p(20, 6, 6, 4, C.steel);
    p(12, 23, 3, 6, C.woodD); p(17, 23, 3, 6, C.woodD);
  },
  ship: (p) => {
    p(4, 20, 24, 6, C.woodD); p(15, 6, 3, 14, C.wood); p(18, 7, 9, 11, C.cloth);
    p(6, 18, 20, 3, C.wood);
  },
  cart: (p) => {
    p(6, 12, 20, 9, C.woodD); p(8, 8, 16, 5, C.straw);
    p(8, 21, 6, 6, C.black); p(18, 21, 6, 6, C.black);
  },
  eagle: (p) => {
    p(12, 11, 8, 13, C.leafD); p(13, 4, 6, 6, C.skin); p(9, 2, 14, 4, C.gold);
    p(21, 10, 3, 14, C.wood); p(20, 7, 6, 4, C.steel);
  },
  // buildings
  townCenter: (p) => {
    p(5, 14, 22, 14, C.cloth); p(3, 8, 26, 6, C.roof); p(8, 4, 4, 10, C.wood);
    p(20, 4, 4, 10, C.wood); p(13, 19, 6, 9, C.woodD);
  },
  house: (p) => { p(6, 15, 20, 13, C.cloth); p(4, 8, 24, 8, C.straw); p(13, 20, 6, 8, C.woodD); },
  mill: (p) => {
    p(8, 14, 16, 14, C.woodD); p(6, 7, 20, 8, C.straw);
    p(3, 4, 4, 16, C.wood); p(1, 10, 12, 3, C.wood);
  },
  lumber: (p) => {
    p(5, 16, 22, 12, C.woodD); p(4, 10, 24, 6, C.wood);
    p(8, 19, 16, 3, C.wood); p(8, 23, 16, 3, C.wood);
  },
  mine: (p) => {
    p(4, 18, 24, 10, C.stoneD); p(6, 10, 20, 8, C.stone);
    p(12, 4, 8, 7, C.gold); p(9, 21, 5, 5, C.gold);
  },
  farm: (p) => {
    p(3, 8, 26, 20, C.woodD);
    for (let i = 0; i < 4; i++) p(5, 11 + i * 5, 22, 3, C.leaf);
  },
  barracks: (p) => {
    p(5, 14, 22, 14, C.woodD); p(3, 7, 26, 8, C.roof);
    p(13, 19, 6, 9, C.black); p(22, 4, 3, 12, C.steel);
  },
  range: (p) => {
    p(5, 15, 22, 13, C.cloth); p(3, 8, 26, 8, C.woodD);
    p(9, 18, 6, 6, C.white); p(11, 20, 2, 2, C.red);
    p(19, 18, 6, 6, C.white); p(21, 20, 2, 2, C.red);
  },
  stable: (p) => {
    p(5, 14, 22, 14, C.woodD); p(3, 7, 26, 8, C.straw);
    p(8, 19, 6, 9, C.black); p(19, 19, 6, 9, C.black);
  },
  blacksmith: (p) => {
    p(5, 14, 22, 14, C.stoneD); p(3, 8, 26, 7, C.stone);
    p(21, 2, 6, 8, C.stoneD); p(22, 1, 4, 3, C.orange);
    p(8, 19, 9, 7, C.steelD);
  },
  market: (p) => {
    p(4, 10, 24, 5, C.red); p(6, 15, 4, 13, C.wood); p(22, 15, 4, 13, C.wood);
    p(11, 19, 10, 9, C.straw); p(13, 21, 6, 4, C.gold);
  },
  monastery: (p) => {
    p(7, 14, 18, 14, C.white); p(5, 8, 22, 7, C.blue);
    p(14, 1, 4, 8, C.gold); p(11, 3, 10, 3, C.gold);
  },
  university: (p) => {
    p(5, 13, 22, 15, C.cloth); p(3, 6, 26, 8, C.blue);
    p(8, 16, 4, 12, C.white); p(15, 16, 4, 12, C.white); p(22, 16, 4, 12, C.white);
  },
  siege: (p) => {
    p(4, 15, 24, 13, C.woodD); p(3, 8, 26, 8, C.wood);
    p(8, 19, 6, 6, C.stone); p(19, 20, 6, 5, C.steelD);
  },
  castle: (p) => {
    p(6, 12, 20, 16, C.stone); p(2, 6, 6, 22, C.stone); p(24, 6, 6, 22, C.stone);
    p(2, 3, 6, 4, C.blue); p(24, 3, 6, 4, C.blue);
    p(12, 18, 8, 10, C.woodD);
  },
  tower: (p) => {
    p(10, 8, 12, 20, C.stone); p(8, 5, 16, 4, C.stoneD);
    p(9, 1, 14, 5, C.roof); p(13, 12, 6, 5, C.black);
  },
  bombardTower: (p) => {
    p(10, 8, 12, 20, C.stoneD); p(8, 5, 16, 4, C.stone);
    p(16, 2, 12, 5, C.black);
  },
  wall: (p) => {
    p(2, 12, 28, 16, C.stone);
    for (let i = 0; i < 4; i++) p(3 + i * 7, 7, 5, 6, C.stone);
    p(2, 17, 28, 2, C.stoneD);
  },
  palisade: (p) => {
    for (let i = 0; i < 5; i++) { p(3 + i * 6, 8, 4, 20, C.wood); p(3 + i * 6, 6, 4, 3, C.woodD); }
    p(2, 15, 28, 3, C.woodD);
  },
  gate: (p) => {
    p(2, 6, 7, 22, C.stone); p(23, 6, 7, 22, C.stone);
    p(2, 2, 28, 5, C.stoneD); p(10, 10, 12, 18, C.woodD);
  },
  outpost: (p) => {
    p(9, 16, 4, 12, C.wood); p(19, 16, 4, 12, C.wood);
    p(6, 11, 20, 5, C.woodD); p(8, 5, 16, 6, C.blue);
  },
  dock: (p) => {
    p(2, 20, 28, 4, C.woodD); p(4, 24, 3, 5, C.wood); p(25, 24, 3, 5, C.wood);
    p(8, 8, 12, 12, C.straw); p(21, 10, 3, 10, C.wood); p(24, 11, 5, 7, C.cloth);
  },
  wonder: (p) => {
    p(6, 12, 20, 16, C.white); p(4, 26, 24, 3, C.stoneD);
    p(8, 4, 16, 9, C.gold); p(14, 1, 4, 4, C.gold);
  },
  // technologies
  gear: (p) => {
    p(11, 11, 10, 10, C.steel);
    p(14, 5, 4, 6, C.steelD); p(14, 21, 4, 6, C.steelD);
    p(5, 14, 6, 4, C.steelD); p(21, 14, 6, 4, C.steelD);
    p(14, 14, 4, 4, C.bg);
  },
  armor: (p) => {
    p(9, 6, 14, 12, C.steel); p(11, 18, 10, 8, C.steelD); p(13, 9, 6, 6, C.steelD);
  },
  shield: (p) => { p(8, 5, 16, 14, C.blue); p(11, 19, 10, 7, C.blue); p(14, 8, 4, 12, C.gold); },
  arrowUp: (p) => { p(14, 8, 4, 18, C.gold); p(10, 4, 12, 5, C.gold); p(7, 9, 4, 4, C.goldD); p(21, 9, 4, 4, C.goldD); },
  age: (p) => {
    p(14, 3, 4, 26, C.gold); p(4, 14, 24, 4, C.gold);
    p(9, 8, 4, 4, C.goldD); p(19, 8, 4, 4, C.goldD);
    p(9, 20, 4, 4, C.goldD); p(19, 20, 4, 4, C.goldD);
  },
  anvil: (p) => { p(6, 10, 20, 6, C.steelD); p(11, 16, 10, 6, C.steel); p(7, 22, 18, 5, C.steelD); },
  scroll: (p) => { p(7, 6, 18, 20, C.cloth); p(7, 4, 18, 4, C.straw); p(7, 24, 18, 4, C.straw); p(11, 12, 10, 2, C.woodD); p(11, 17, 10, 2, C.woodD); },
  wheel: (p) => { p(10, 10, 12, 12, C.wood); p(14, 4, 4, 24, C.woodD); p(4, 14, 24, 4, C.woodD); },
  // resources
  food: (p) => { p(9, 8, 14, 16, C.food); p(13, 4, 4, 6, C.leafD); p(15, 5, 8, 4, C.leaf); },
  wood: (p) => { p(4, 12, 24, 7, C.wood); p(4, 19, 24, 7, C.woodD); p(8, 6, 6, 6, C.leaf); p(18, 6, 6, 6, C.leafD); },
  goldRes: (p) => { p(6, 16, 20, 10, C.gold); p(10, 8, 12, 8, C.goldD); p(12, 10, 5, 4, C.gold); },
  stoneRes: (p) => { p(5, 15, 22, 11, C.stone); p(10, 7, 12, 8, C.stoneD); },
  pop: (p) => { p(8, 12, 6, 12, C.cloth); p(9, 5, 4, 6, C.skin); p(18, 12, 6, 12, C.cloth); p(19, 5, 4, 6, C.skin); },
  // commands
  stop: (p) => { p(8, 8, 16, 16, C.red); },
  attack: (p) => { p(15, 3, 3, 20, C.steel); p(10, 21, 13, 3, C.woodD); p(4, 4, 8, 3, C.red); p(4, 4, 3, 8, C.red); },
  move: (p) => { p(14, 4, 4, 24, C.leaf); p(9, 9, 5, 5, C.leaf); p(18, 9, 5, 5, C.leaf); },
  garrison: (p) => { p(6, 14, 20, 14, C.stone); p(4, 8, 24, 6, C.roof); p(14, 3, 4, 10, C.leaf); p(11, 8, 10, 4, C.leaf); },
  ungarrison: (p) => { p(6, 14, 20, 14, C.stone); p(4, 8, 24, 6, C.roof); p(14, 1, 4, 10, C.gold); p(11, 1, 10, 4, C.gold); },
  del: (p) => { p(6, 6, 20, 4, C.red); p(6, 22, 20, 4, C.red); p(6, 6, 4, 20, C.red); p(22, 6, 4, 20, C.red); },
  build: (p) => { p(6, 16, 20, 4, C.wood); p(20, 6, 6, 12, C.steelD); p(8, 20, 16, 8, C.stone); },
  repair: (p) => { p(6, 18, 18, 4, C.steelD); p(20, 8, 6, 14, C.wood); p(4, 4, 8, 8, C.steel); },
  flag: (p) => { p(10, 3, 3, 26, C.woodD); p(13, 4, 14, 10, C.red); },
  stance: (p) => { p(6, 6, 8, 20, C.blue); p(18, 6, 8, 20, C.red); },
  heal: (p) => { p(13, 6, 6, 20, C.white); p(6, 13, 20, 6, C.white); },
  convert: (p) => { p(14, 4, 4, 24, C.gold); p(8, 10, 16, 4, C.gold); p(6, 20, 6, 6, C.cyan); p(20, 20, 6, 6, C.purple); },
  relic: (p) => { p(10, 8, 12, 16, C.gold); p(7, 6, 18, 4, C.goldD); p(14, 11, 4, 10, C.white); p(11, 14, 10, 3, C.white); },
  trade: (p) => { p(6, 12, 20, 8, C.woodD); p(8, 8, 16, 4, C.straw); p(8, 20, 5, 5, C.black); p(19, 20, 5, 5, C.black); p(4, 4, 6, 6, C.gold); },
  tech: (p) => { p(11, 11, 10, 10, C.cyan); p(14, 4, 4, 7, C.cyan); p(14, 21, 4, 7, C.cyan); p(4, 14, 7, 4, C.cyan); p(21, 14, 7, 4, C.cyan); },
  question: (p) => { p(11, 5, 10, 4, C.cloth); p(18, 8, 4, 6, C.cloth); p(14, 13, 5, 5, C.cloth); p(14, 21, 5, 5, C.cloth); },
};

export function icon(name) {
  if (cache.has(name)) return cache.get(name);
  const g = GLYPHS[name] || GLYPHS.question;
  const url = make(g);
  cache.set(name, url);
  return url;
}

/* ---- mapping game entities to glyph names ---- */

export function unitIcon(def) {
  const id = def.id;
  if (def.cat === 'villager') return 'villager';
  if (def.cat === 'monk') return 'monk';
  if (def.cat === 'trade') return 'cart';
  if (def.cat === 'naval') return 'ship';
  if (id === 'trebuchet') return 'trebuchet';
  if (id.includes('Ram') || id === 'siegeTower') return 'ram';
  if (id.includes('angonel') || id.includes('nager')) return 'catapult';
  if (id.includes('corpion') || id.includes('allista')) return 'ballista';
  if (id === 'bombardCannon' || id.includes('rganGun')) return 'cannon';
  if (def.classes.includes('gunpowder')) return 'gun';
  if (def.classes.includes('elephant')) return 'elephant';
  if (def.classes.includes('camel')) return 'camel';
  if (def.classes.includes('cavalryArcher')) return 'bow';
  if (def.cat === 'cavalry') return 'horse';
  if (def.classes.includes('eagleWarrior')) return 'eagle';
  if (def.cat === 'archer') {
    if (id.includes('kirmisher') || id.includes('beto') || id.includes('hrowingAxeman')) return 'javelin';
    if (id.includes('rossbow') || id.includes('rbalest')) return 'crossbow';
    return 'bow';
  }
  if (def.classes.includes('spearman')) return 'pike';
  if (id === 'champion' || id === 'twoHandedSwordsman') return 'twoSword';
  return 'sword';
}

export function buildingIcon(id) {
  const map = {
    townCenter: 'townCenter', house: 'house', mill: 'mill', lumberCamp: 'lumber',
    miningCamp: 'mine', farm: 'farm', dock: 'dock', barracks: 'barracks',
    archeryRange: 'range', stable: 'stable', blacksmith: 'blacksmith', market: 'market',
    monastery: 'monastery', university: 'university', siegeWorkshop: 'siege', castle: 'castle',
    watchTower: 'tower', guardTower: 'tower', keep: 'tower', bombardTower: 'bombardTower',
    outpost: 'outpost', palisadeWall: 'palisade', stoneWall: 'wall', fortifiedWall: 'wall',
    gate: 'gate', wonder: 'wonder', donjon: 'tower', krepost: 'castle',
    feitoria: 'market', caravanserai: 'market',
  };
  return map[id] || 'house';
}

export function techIcon(tech) {
  const id = tech.id;
  if (id.endsWith('Age')) return 'age';
  if (id.startsWith('up') || id.startsWith('elite_')) return 'arrowUp';
  if (id.includes('Armor') || id.includes('Barding') || id.includes('Mail')) return 'armor';
  if (id === 'forging' || id === 'ironCasting' || id === 'blastFurnace') return 'anvil';
  if (id === 'fletching' || id === 'bodkinArrow' || id === 'bracer') return 'arrowUp';
  if (tech.building === 'monastery') return 'scroll';
  if (tech.building === 'market') return 'trade';
  if (tech.building === 'townCenter' || tech.building === 'mill' ||
      tech.building === 'lumberCamp' || tech.building === 'miningCamp') return 'wheel';
  if (tech.building === 'university') return 'tech';
  return 'gear';
}

export function resIcon(res) {
  return { food: 'food', wood: 'wood', gold: 'goldRes', stone: 'stoneRes' }[res] || 'food';
}
