// Damage resolution. All of the counter system lives here plus data/armor.js.

import { computeDamage, explainDamage } from '../data/armor.js';

/** Effective armor table for an entity, including civ/tech modifiers. */
export function armorOf(ent) {
  return ent.def.armor;
}

/** Effective attack table for an entity (already modifier-resolved in def). */
export function attackOf(ent) {
  return ent.def.atk || {};
}

/**
 * Applies one hit. Handles the Sicilian bonus-damage resistance, Leitis-style
 * armour-ignoring attacks, and elevation.
 */
export function resolveDamage(game, attacker, target, attackTable, opts = {}) {
  if (!target || !target.alive) return 0;
  const atkPlayer = game.players[attacker?.owner];
  const defPlayer = game.players[target.owner];

  let attack = attackTable;
  let armor = target.def.armor;

  // Leitis / Wootz Steel: melee component ignores armour entirely
  const ignoresArmor = attacker?.def?.ignoreArmor ||
    (atkPlayer && atkPlayer.mods.flags.has('wootzSteel') &&
      (attacker.def.cat === 'infantry' || attacker.def.cat === 'cavalry'));
  if (ignoresArmor) armor = ZERO_ARMOR;

  // Sicilians: land military units take 33% less bonus damage
  if (defPlayer && defPlayer.mods.flags.has('bonusResist') && target.kind === 'unit') {
    attack = { ...attack };
    for (const cls in attack) {
      if (cls !== 'melee' && cls !== 'pierce') attack[cls] = Math.round(attack[cls] * 0.67);
    }
  }

  // Armenian Composite Bowman style partial pierce-armour ignore
  if (attacker?.def?.ignorePierceArmor && armor.pierce) {
    armor = { ...armor, pierce: Math.max(0, armor.pierce - attacker.def.ignorePierceArmor) };
  }

  let dmg = computeDamage(attack, armor);

  // Tatars: +25% attacking downhill
  if (atkPlayer && atkPlayer.mods.flags.has('elevationBonus') && attacker) {
    if (game.elevationAt(attacker.x, attacker.y) > game.elevationAt(target.x, target.y)) {
      dmg = Math.round(dmg * 1.25);
    }
  } else if (attacker && game.elevationAt(attacker.x, attacker.y) > game.elevationAt(target.x, target.y)) {
    dmg = Math.round(dmg * 1.25);   // standard AoE2 elevation bonus
  } else if (attacker && game.elevationAt(attacker.x, attacker.y) < game.elevationAt(target.x, target.y)) {
    dmg = Math.round(dmg * 0.75);
  }

  // Georgians: buildings on a hill take less damage
  if (defPlayer && defPlayer.mods.flags.has('hillDefense') && target.kind === 'building' &&
      game.elevationAt(target.x, target.y) > 0) {
    dmg = Math.round(dmg * 0.85);
  }

  if (opts.scale) dmg = Math.max(1, Math.round(dmg * opts.scale));

  applyDamage(game, target, dmg, attacker);
  return dmg;
}

const ZERO_ARMOR = { melee: 0, pierce: 0 };

export function applyDamage(game, target, dmg, attacker) {
  if (!target.alive) return;
  // Shrivamsha Rider dodges ranged shots
  if (target.def?.dodges && attacker && attacker.def?.range > 1 && target.dodgeCharges > 0) {
    target.dodgeCharges--;
    return;
  }
  target.hp -= dmg;
  target.lastDamaged = game.time;
  if (attacker && attacker.kind === 'unit') {
    // Poles Obuch shreds armour on hit
    if (attacker.def.shredArmor && target.kind === 'unit') {
      target.def = { ...target.def, armor: { ...target.def.armor } };
      target.def.armor.melee = Math.max(-3, target.def.armor.melee - attacker.def.shredArmor);
      target.def.armor.pierce = Math.max(-3, target.def.armor.pierce - attacker.def.shredArmor);
    }
    // Tatar Keshik generates gold on hit
    if (attacker.def.goldOnHit) {
      const p = game.players[attacker.owner];
      if (p) p.give('gold', attacker.def.goldOnHit * 0.5);
    }
  }
  if (target.hp <= 0) game.kill(target, attacker);
}

/** Blast/trample damage around a point. */
export function areaDamage(game, attacker, cx, cy, radius, attackTable, friendlyFire = true) {
  const hit = [];
  game.entityGrid.forEachNear(cx, cy, radius + 1, (e) => {
    if (!e.alive || e.kind === 'projectile') return;
    if (e.kind === 'resource') return;
    if (!friendlyFire && attacker && game.isAlly(attacker.owner, e.owner)) return;
    const dx = e.x - cx, dy = e.y - cy;
    const d = Math.sqrt(dx * dx + dy * dy) - (e.radius || 0);
    if (d > radius) return;
    hit.push({ e, d });
  });
  for (const { e, d } of hit) {
    const falloff = d <= radius * 0.5 ? 1 : 0.5;
    resolveDamage(game, attacker, e, attackTable, { scale: falloff });
  }
  return hit.length;
}

export { explainDamage };
