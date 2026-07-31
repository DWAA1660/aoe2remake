// Entity factories. Everything in the world is a flat object with a `kind`
// discriminator so the tick loop can iterate one array.

let NEXT_ID = 1;
export function resetIds() { NEXT_ID = 1; }

/**
 * Gather rates, in resources per second.
 *
 * These are Age of Empires II: Definitive Edition's published per-resource
 * gathering rates: berries 0.31, sheep 0.33, boar and deer ~0.41, shore fish
 * ~0.43, farms ~0.356, wood 0.39, gold 0.38, stone 0.36.
 *
 * One caveat worth writing down, because it is easy to "fix" wrongly. DE quotes
 * these as *effective* rates - measured beside a drop site, walking included -
 * while this simulation walks the villager itself and so applies them as work
 * rates. That means a villager here is somewhat slower than its DE counterpart,
 * by however long the walk takes. Correcting it properly needs DE's raw work
 * rates for every task, which are in the game's data files rather than in any
 * source I could reach; substituting a raw rate for one resource and leaving
 * effective rates on the others is worse than either, because the resources
 * stop being comparable to each other. Farms were briefly set to the Farm's own
 * 0.4/s production cap on that mistake and it cost a tenth of the economy.
 *
 * Sheep and hunted game are separate rates in DE and were sharing one here: a
 * shepherd works at 0.33 and a hunter on deer or boar at ~0.41. See
 * `makeCarcass`, which is also what makes the "shepherds work faster" civ bonus
 * reach anything at all.
 */
export const RESOURCE_INFO = {
  tree: { res: 'wood', amount: 100, blocks: true, gatherRate: 0.39, label: 'Tree' },
  gold: { res: 'gold', amount: 800, blocks: true, gatherRate: 0.38, label: 'Gold Mine' },
  stone: { res: 'stone', amount: 350, blocks: true, gatherRate: 0.36, label: 'Stone Mine' },
  berries: { res: 'food', amount: 125, blocks: false, gatherRate: 0.31, label: 'Berry Bush', sub: 'berries' },
  fish: { res: 'food', amount: 225, blocks: false, gatherRate: 0.43, label: 'Fish', water: true, sub: 'fish' },
  relic: { res: 'gold', amount: 0, blocks: false, gatherRate: 0, label: 'Relic' },
  farm: { res: 'food', amount: 175, blocks: false, gatherRate: 0.37, label: 'Farm', sub: 'farm' },
  carcass: { res: 'food', amount: 0, blocks: false, gatherRate: 0.41, label: 'Carcass', sub: 'hunt' },
};

/** Shepherding is its own, slower job than hunting. */
export const SHEEP_GATHER_RATE = 0.33;

export function makeUnit(def, owner, x, y) {
  return {
    id: NEXT_ID++,
    kind: 'unit',
    type: def.id,
    def,
    owner,
    x, y,
    vx: 0, vy: 0,
    facing: 0,
    hp: def.hp,
    maxHp: def.hp,
    radius: def.radius,
    speed: def.speed,
    task: { type: 'idle' },
    orders: [],              // shift-queued follow-up orders, executed in turn
    path: null,
    pathIdx: 0,
    repathCd: 0,
    attackCd: 0,
    carrying: null,          // { res, sub, amount }
    gatherTargetId: 0,
    garrisonedIn: 0,
    charge: 0,
    volleyLeft: 0,
    convertProgress: 0,
    convertedBy: 0,
    faith: 100,
    stuck: 0,
    selected: false,
    stance: 'aggressive',    // aggressive | defensive | standGround | noAttack
    alive: true,
    anim: 0,
    lastDamaged: 0,
  };
}

export function makeBuilding(def, owner, tx, ty, complete = false) {
  const size = def.size;
  return {
    id: NEXT_ID++,
    kind: 'building',
    type: def.id,
    def,
    owner,
    tx, ty, size,
    x: tx + size / 2,
    y: ty + size / 2,
    radius: size / 2,
    hp: complete ? def.hp : Math.max(1, Math.round(def.hp * 0.05)),
    maxHp: def.hp,
    complete,
    buildProgress: complete ? def.time : 0,
    buildersThisTick: 0,
    queue: [],               // { kind:'unit'|'tech', id, timeLeft, total, cost }
    rally: null,
    garrison: [],
    attackCd: 0,
    farmFood: def.farmFood || 0,
    farmMax: def.farmFood || 0,
    farmer: 0,               // a farm is worked by exactly one villager
    relics: 0,
    selected: false,
    alive: true,
    smokeT: 0,
  };
}

/**
 * The food pile a hunted animal leaves behind, carrying the rate and the job
 * name of the animal it came from. A carcass is one resource type in the world
 * but two different jobs to work: herding a sheep is slower than butchering a
 * boar, and only the sheep answers to a shepherding bonus.
 */
export function makeCarcass(unitType, x, y, amount) {
  const c = makeResource('carcass', x, y, amount);
  if (unitType === 'sheep') {
    c.sub = 'sheep';
    c.gatherRate = SHEEP_GATHER_RATE;
  }
  c.variant = unitType === 'boar' ? 2 : unitType === 'deer' ? 1 : 0;
  return c;
}

export function makeResource(type, x, y, amount, tx, ty) {
  const info = RESOURCE_INFO[type];
  return {
    id: NEXT_ID++,
    kind: 'resource',
    type,
    resType: info.res,
    sub: info.sub || info.res,
    owner: -1,
    x, y,
    tx: tx ?? Math.floor(x),
    ty: ty ?? Math.floor(y),
    radius: 0.45,
    amount: amount ?? info.amount,
    maxAmount: amount ?? info.amount,
    gatherers: 0,
    alive: true,
    variant: 0,
  };
}

export function makeProjectile(from, target, attack, opts = {}) {
  return {
    id: NEXT_ID++,
    kind: 'projectile',
    owner: from.owner,
    sourceId: from.id,
    targetId: target ? target.id : 0,
    x: from.x, y: from.y, z: opts.z ?? 0.8,
    tx: opts.tx ?? target.x,
    ty: opts.ty ?? target.y,
    startX: from.x, startY: from.y,
    t: 0,
    duration: opts.duration ?? 0.4,
    attack,
    blast: opts.blast || 0,
    miss: !!opts.miss,
    arc: opts.arc ?? 0.35,
    pierceLine: !!opts.pierceLine,
    style: opts.style || 'arrow',
    alive: true,
  };
}
