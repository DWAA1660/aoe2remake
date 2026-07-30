// Team-level coordination for allied AIs.
//
// Two allied AIs that only ever look at their own base play like two strangers
// who happen to share a colour: they attack at different times and get killed
// one at a time, they both boom while the third player runs them over, and one
// of them sits on 3000 unspent stone while the other cannot afford a Castle.
//
// A TeamBrain is a shared blackboard per team. Members write what they can see
// and what they intend; the brain decides the things that only make sense at
// team scope - who the team is attacking, when the push actually goes in, who
// plays economy and who plays army, who is being bailed out - and members read
// that back as ordinary priorities.
//
// It grants no information nobody has: allies already share fog of war in
// game.js, so pooling sightings is exactly what the players can already see.

import { unitValue } from './ai-brain.js';

/** How often the team re-thinks, in game seconds. */
const THINK_INTERVAL = 2;
/** Once a push is called it stays called for this long, so it is not cancelled
 *  the moment one member's army dips below the threshold mid-fight. */
const PUSH_COMMIT = 75;
/** A member who has been hit inside this window counts as needing help. */
const HELP_WINDOW = 30;

export class TeamBrain {
  /** One brain per team per game, created on first use. */
  static forTeam(game, team) {
    if (!game.teamBrains) game.teamBrains = new Map();
    let brain = game.teamBrains.get(team);
    if (!brain) { brain = new TeamBrain(game, team); game.teamBrains.set(team, brain); }
    return brain;
  }

  constructor(game, team) {
    this.game = game;
    this.team = team;
    this.members = [];
    this.nextThink = 0;

    this.pushIntent = 0;        // 0..1 team-wide agreement to commit
    this.pushUntil = 0;         // a called push stays called until here
    this.focus = null;          // the enemy player everyone is hitting
    this.rally = null;          // where the combined army gathers first
    this.roles = new Map();     // ai index -> role
    this.helpAt = new Map();    // ai index -> {x,y} an ally needs covering
    this.enemyShares = {};      // pooled threat classes, as shares
    this.enemyValue = 0;        // pooled resource value of everything seen
  }

  join(ai) {
    if (!this.members.includes(ai)) this.members.push(ai);
  }

  /** Called by every member each pass; the work happens on a slower clock. */
  sync() {
    if (this.game.time < this.nextThink) return;
    this.nextThink = this.game.time + THINK_INTERVAL;
    this.members = this.members.filter((m) => !m.p.defeated);
    if (!this.members.length) return;
    this.poolIntel();
    this.assignRoles();
    this.decidePush();
    this.routeHelp();
    this.balanceResources();
  }

  /* ---------------- intel ---------------- */

  /**
   * Merges what every member has seen into one picture of the enemy.
   *
   * An ally who has been fighting Knights all game knows something the ally on
   * the other side of the map does not, and a team where only one member builds
   * Pikemen loses its other half for free.
   */
  poolIntel() {
    const counts = {};
    let total = 0, value = 0;
    for (const m of this.members) {
      const prof = m.threatProfile;
      if (!prof) continue;
      value += prof.value;
      for (const cls in prof.counts) {
        counts[cls] = (counts[cls] || 0) + prof.counts[cls];
        total += prof.counts[cls];
      }
    }
    const shares = {};
    for (const cls in counts) shares[cls] = counts[cls] / Math.max(1, total);
    this.enemyShares = shares;
    this.enemyCounts = counts;
    this.enemyTotal = total;
    // Value is pooled across members, but the same enemy army is often visible
    // to two allies at once, so halve the double counting rather than telling
    // everyone the enemy is twice its real size.
    this.enemyValue = this.members.length > 1 ? value / Math.sqrt(this.members.length) : value;
  }

  /* ---------------- roles ---------------- */

  /**
   * Splits the team into jobs.
   *
   * Whoever lives nearest the enemy is the one who has to hold the line, and
   * whoever lives furthest away is the one who can safely take the extra Town
   * Center - so those two should not be playing the same game. Anyone actually
   * being attacked drops everything and defends regardless of position.
   */
  assignRoles() {
    this.roles.clear();
    if (this.members.length === 1) {
      this.roles.set(this.members[0].index, 'solo');
      return;
    }
    const scored = this.members.map((m) => ({
      m,
      // Low = exposed. Distance to the nearest enemy town we know of, with the
      // member's own army discounted: a strong member is a better vanguard than
      // a weak one at the same distance.
      exposure: (m.enemyBase
        ? Math.hypot(m.enemyBase.x - m.homeX, m.enemyBase.y - m.homeY) : this.game.size)
        - (m.armyValue || 0) * 0.4,
      eco: m.mine ? m.mine.villagers.length : 0,
    })).sort((a, b) => a.exposure - b.exposure);

    for (let i = 0; i < scored.length; i++) {
      const { m } = scored[i];
      if (m.underThreat) { this.roles.set(m.index, 'defender'); continue; }
      // The most exposed member fights; the least exposed one pays for it.
      if (i === 0) this.roles.set(m.index, 'vanguard');
      else if (i === scored.length - 1) this.roles.set(m.index, 'quartermaster');
      else this.roles.set(m.index, 'balanced');
    }
  }

  roleOf(ai) { return this.roles.get(ai.index) || 'solo'; }

  /* ---------------- the push ---------------- */

  /**
   * Decides whether the team attacks, and who it attacks.
   *
   * Everybody hits the same player. Splitting an allied army across two enemies
   * means fighting both of them at even odds; concentrating means fighting one
   * of them at two-to-one and then the other at whatever is left, which is
   * strictly better.
   */
  decidePush() {
    const g = this.game;

    // The weakest enemy still standing, by what the team can actually see of
    // them: buildings we have explored plus the army value they have shown us.
    let best = null, bestScore = Infinity;
    for (const pl of g.players) {
      if (pl.defeated || !g.isEnemy(this.members[0].index, pl.index)) continue;
      let buildings = 0, tc = null;
      for (const e of g.entities) {
        if (!e.alive || e.kind !== 'building' || e.owner !== pl.index) continue;
        const seen = g.revealAll || this.members.some((m) => m.p.hasExplored(e.x | 0, e.y | 0));
        if (!seen) continue;
        buildings++;
        if (e.type === 'townCenter' && !tc) tc = e;
      }
      if (!buildings) continue;
      // Nearest to the team, weakest, and preferably one already hurting us -
      // finishing a wounded player removes a whole economy from the game. With
      // no Town Center scouted the distance is unknown rather than zero; guess
      // half the map so an unscouted player is not mistaken for a neighbour.
      const dist = tc
        ? Math.min(...this.members.map((m) => Math.hypot(tc.x - m.homeX, tc.y - m.homeY)))
        : g.size * 0.5;
      const hurting = this.members.some((m) => m.threatOwner === pl.index) ? -40 : 0;
      const score = buildings * 1.5 + dist * 0.6 + hurting;
      if (score < bestScore) { bestScore = score; best = { player: pl, tc }; }
    }
    this.focus = best;

    // Combined readiness. A push needs the team's armies, not one member's.
    let ourValue = 0, ready = 0;
    for (const m of this.members) {
      ourValue += m.armyValue || 0;
      ready += (m.mine ? m.mine.army.length : 0);
    }
    this.teamArmyValue = ourValue;

    const wants = this.members.reduce((t, m) => t + (m.brain ? m.brain.get('aggression') : 0), 0) /
      this.members.length;
    // Enough to win the fight, and enough of the team wanting it. Attacking into
    // a bigger army with a team is the same mistake as doing it alone, only
    // twice as expensive.
    const odds = ourValue / Math.max(4, ourValue + this.enemyValue);
    const strong = ready >= 12 * this.members.length && odds > 0.5;
    const desperate = this.members.every((m) => m.p.pop >= m.p.effectivePopCap - 6);

    if (this.game.time < this.pushUntil) {
      this.pushIntent = Math.max(0.75, wants);
    } else if (best && (strong || desperate) && wants > 0.5) {
      this.pushUntil = this.game.time + PUSH_COMMIT;
      this.pushIntent = 1;
      // Stage short of their town so the armies arrive together rather than
      // trickling in one member at a time.
      if (best.tc) {
        const hx = this.members.reduce((t, m) => t + m.homeX, 0) / this.members.length;
        const hy = this.members.reduce((t, m) => t + m.homeY, 0) / this.members.length;
        const dx = best.tc.x - hx, dy = best.tc.y - hy;
        const d = Math.hypot(dx, dy) || 1;
        this.rally = { x: best.tc.x - (dx / d) * 18, y: best.tc.y - (dy / d) * 18 };
      }
    } else {
      this.pushIntent = wants * (odds > 0.45 ? 0.8 : 0.3);
      this.rally = null;
    }
  }

  /** The team's agreed target, for members that have nothing better nearby. */
  focusTarget() {
    if (!this.focus) return null;
    return this.focus.tc || null;
  }

  /* ---------------- mutual defence ---------------- */

  /** Remembers where each member is being hit so the others can come over. */
  routeHelp() {
    const now = this.game.time;
    for (const m of this.members) {
      if (m.underThreat && m.threatAt) {
        this.helpAt.set(m.index, { x: m.threatAt.x, y: m.threatAt.y, t: now, who: m.index });
      }
    }
    for (const [k, v] of this.helpAt) if (now - v.t > HELP_WINDOW) this.helpAt.delete(k);
  }

  /**
   * Where this member should send help, or null.
   *
   * Only the nearest healthy ally goes. Three allies all abandoning their own
   * towns to answer one raid is how a team loses three towns instead of none.
   */
  helpRequestFor(ai) {
    let best = null, bestD = Infinity;
    for (const [idx, spot] of this.helpAt) {
      if (idx === ai.index) continue;
      if (ai.underThreat) continue;                 // our own town comes first
      const d = Math.hypot(spot.x - ai.homeX, spot.y - ai.homeY);
      if (d > 90) continue;
      // Whoever is closest owns the rescue.
      const closest = this.members.every((m) =>
        m === ai || m.index === idx || m.underThreat ||
        Math.hypot(spot.x - m.homeX, spot.y - m.homeY) >= d);
      if (!closest) continue;
      if (d < bestD) { bestD = d; best = spot; }
    }
    return best;
  }

  allyUnderAttack(ai) {
    return this.members.some((m) => m !== ai && m.underThreat);
  }
  allyArmyValue(ai) {
    return this.members.reduce((t, m) => t + (m === ai ? 0 : m.armyValue || 0), 0);
  }
  allyVillagers(ai) {
    return this.members.reduce((t, m) =>
      t + (m === ai || !m.mine ? 0 : m.mine.villagers.length), 0);
  }

  /* ---------------- shared economy ---------------- */

  /**
   * Moves resources from whoever is drowning in one to whoever is blocked on it.
   *
   * The classic team-game failure is one ally banking 2000 stone they will never
   * spend while the other cannot afford the Castle that would save both of them.
   * A tribute costs the sender the market fee, so this only fires on a genuine
   * gap - not to shave fifty food off a rounding error.
   */
  balanceResources() {
    if (this.members.length < 2) return;
    const now = this.game.time;
    if (now < (this.nextTribute || 0)) return;

    for (const res of ['food', 'wood', 'gold', 'stone']) {
      let rich = null, poor = null;
      for (const m of this.members) {
        const have = m.p.res[res];
        // "Needs it" means blocked, not merely low: an ally who is not trying to
        // spend this resource is not helped by being given more of it.
        const needs = have < 250 && (m.brain ? m.brain.get(res + 'Weight') > 0.4 : true);
        if (have > 900 && (!rich || have > rich.p.res[res])) rich = m;
        if (needs && (!poor || have < poor.p.res[res])) poor = m;
      }
      if (rich && poor && rich !== poor) {
        const sent = this.game.tribute(rich.index, poor.index, res, 300);
        if (sent) { this.nextTribute = now + 20; return; }
      }
    }
  }

  /* ---------------- trade ---------------- */

  /**
   * The best Market for this member's Trade Carts to run to.
   *
   * Gold per trip scales with the distance between the two Markets, so an
   * ally's Market across the map is worth several times a second Market of our
   * own next door - which is the whole reason team games trade and solo games
   * mostly do not. The route still has to be survivable: a long line through
   * the enemy's half is a gift of Trade Carts.
   */
  bestMarketFor(ai, home) {
    const g = this.game;
    let best = null, bestScore = 0;
    for (const m of this.members) {
      // An ally's Market only. Running carts between two of our own is trading
      // with ourselves - it produces gold out of nothing but walking distance,
      // which is not what trade is meant to be, and a solo player should not
      // have a renewable gold income nobody can cut. No allies means no trade.
      if (m === ai || m.p.defeated) continue;
      for (const b of g.entities) {
        if (!b.alive || b.kind !== 'building' || b.type !== 'market' || !b.complete) continue;
        if (b.owner !== m.index) continue;
        const dist = Math.hypot(b.x - home.x, b.y - home.y);
        if (dist < 12) continue;                 // too short to pay for the cart
        const risk = ai.routeDanger(home, b);
        const score = Math.min(dist, 90) / (1 + risk);
        if (score > bestScore) { bestScore = score; best = { market: b, dist, risk, ally: true }; }
      }
    }
    return best;
  }
}
