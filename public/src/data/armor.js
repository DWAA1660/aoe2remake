// Age of Empires II armor-class system.
//
// AoE2 does NOT use a "bonus damage" multiplier. Every attack is a *set* of typed
// damage components, and every unit has a *set* of typed armor values. Damage is:
//
//     total = SUM over attack components c of  max(0, attack[c] - armor[c])
//     total = max(total, 1)          // a hit always does at least 1
//
// "melee" and "pierce" are just two more armor classes. A Halberdier's attack is
// { melee: 6, cavalry: 26 }; a Knight's armor is { melee: 2, pierce: 3, cavalry: 0 }.
// So the Halberdier deals (6-2) + (26-0) = 30. A Champion attacking that same
// Knight only has { melee: 13 } so it deals 11. That single rule produces the
// whole rock-paper-scissors counter system.
//
// Because bonus classes normally have 0 armor, bonus damage lands in full - but a
// few units carry positive armor in a bonus class specifically to blunt their
// counter (Byzantine Cataphract has +12 infantry armor, Steppe Lancers have
// spearman armor, etc.).

export const ARMOR_CLASSES = {
  melee: 'Melee',
  pierce: 'Pierce',
  infantry: 'Infantry',
  cavalry: 'Cavalry',
  archer: 'Archer',
  spearman: 'Spearman',
  cavalryArcher: 'Cavalry Archer',
  camel: 'Camel',
  eagleWarrior: 'Eagle Warrior',
  elephant: 'War Elephant',
  siege: 'Siege Weapon',
  ram: 'Ram',
  monk: 'Monk',
  ship: 'Ship',
  building: 'Standard Building',
  stoneDefense: 'Stone Defence',
  wall: 'Wall and Gate',
  gunpowder: 'Gunpowder Unit',
  uniqueUnit: 'Unique Unit',
  villager: 'Villager',
  condottiero: 'Condottiero',
};

/**
 * Core AoE2 damage calculation.
 * @param {Object} attack  e.g. { melee: 6, cavalry: 26 }
 * @param {Object} armor   e.g. { melee: 2, pierce: 3 }
 * @returns {number} damage dealt (minimum 1)
 */
export function computeDamage(attack, armor) {
  let total = 0;
  for (const cls in attack) {
    const a = attack[cls];
    if (!a) continue;
    const def = armor[cls] || 0;
    const d = a - def;
    if (d > 0) total += d;
  }
  return Math.max(1, total);
}

/**
 * Builds a human-readable breakdown, used by the in-game unit inspector so the
 * player can actually see *why* pikemen shred knights.
 */
export function explainDamage(attack, armor) {
  const parts = [];
  let total = 0;
  for (const cls in attack) {
    const a = attack[cls];
    if (!a) continue;
    const def = armor[cls] || 0;
    const d = Math.max(0, a - def);
    total += d;
    parts.push({ cls, attack: a, armor: def, dealt: d });
  }
  return { parts, total: Math.max(1, total) };
}
