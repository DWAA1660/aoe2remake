// Entity factories. Everything in the world is a flat object with a `kind`
// discriminator so the tick loop can iterate one array.

let NEXT_ID = 1;
export function resetIds() { NEXT_ID = 1; }

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
    relics: 0,
    selected: false,
    alive: true,
    smokeT: 0,
  };
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
