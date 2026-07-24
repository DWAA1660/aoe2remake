// Procedural low-poly geometry. Everything is built from coloured boxes and
// prisms merged into a single BufferGeometry per kind, which gives the chunky
// "voxel diorama" look and keeps draw calls low when instanced.

const PALETTE = {
  skin: 0xd9a066, cloth: 0xbfbfbf, dark: 0x4a4a55, wood: 0x8a5a2b, wood2: 0x6b4522,
  steel: 0xc0c8d0, steelDark: 0x8a929c, gold: 0xd4af37, leaf: 0x3f7a3f, leaf2: 0x2f5f2f,
  leafDry: 0x6f7a3a, stone: 0x9a9a95, stoneDark: 0x6f6f6c, roofRed: 0x8c3b2f,
  roofBlue: 0x39506e, straw: 0xc9a54a, dirt: 0x6b5638, white: 0xe8e8e8,
  black: 0x232329, fur: 0xb99a72, furDark: 0x6a4f36, red: 0xa33028, water: 0x2d6a8f,
};

/** Accumulates boxes/prisms then bakes them into one geometry. */
class MeshBuilder {
  constructor() { this.pos = []; this.norm = []; this.col = []; }

  box(w, h, d, x, y, z, color, tint = 1) {
    const hx = w / 2, hy = h / 2, hz = d / 2;
    const v = [
      [-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz],   // front
      [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz], [hx, -hy, -hz], // back
    ];
    const faces = [
      [0, 1, 2, 0, 2, 3, [0, 0, 1]],
      [4, 5, 6, 4, 6, 7, [0, 0, -1]],
      [3, 2, 6, 3, 6, 5, [0, 1, 0]],
      [4, 7, 1, 4, 1, 0, [0, -1, 0]],
      [7, 6, 2, 7, 2, 1, [1, 0, 0]],
      [4, 0, 3, 4, 3, 5, [-1, 0, 0]],
    ];
    const c = new Float32Array(3);
    for (const f of faces) {
      const n = f[6];
      // fake ambient occlusion: shade by face normal so flat colours still read
      const shade = 0.72 + 0.28 * (n[1] * 0.8 + 0.2) + (n[0] ? 0.06 : 0) - (n[2] < 0 ? 0.08 : 0);
      this._color(c, color, tint * Math.max(0.45, shade));
      for (let i = 0; i < 6; i++) {
        const p = v[f[i]];
        this.pos.push(p[0] + x, p[1] + y, p[2] + z);
        this.norm.push(n[0], n[1], n[2]);
        this.col.push(c[0], c[1], c[2]);
      }
    }
    return this;
  }

  /** Four-sided pyramid, used for roofs and tree canopies. */
  pyramid(w, h, d, x, y, z, color, tint = 1) {
    const hx = w / 2, hz = d / 2;
    const base = [[-hx, 0, hz], [hx, 0, hz], [hx, 0, -hz], [-hx, 0, -hz]];
    const apex = [0, h, 0];
    const c = new Float32Array(3);
    for (let i = 0; i < 4; i++) {
      const a = base[i], b = base[(i + 1) % 4];
      const nx = (a[0] + b[0]) / 2, nz = (a[2] + b[2]) / 2;
      const len = Math.hypot(nx, h * 0.5, nz) || 1;
      const n = [nx / len, (h * 0.5) / len, nz / len];
      this._color(c, color, tint * (0.72 + 0.28 * n[1] + (n[0] > 0 ? 0.05 : -0.03)));
      for (const p of [a, b, apex]) {
        this.pos.push(p[0] + x, p[1] + y, p[2] + z);
        this.norm.push(n[0], n[1], n[2]);
        this.col.push(c[0], c[1], c[2]);
      }
    }
    // underside
    this._color(c, color, tint * 0.45);
    for (const idx of [0, 2, 1, 0, 3, 2]) {
      const p = base[idx];
      this.pos.push(p[0] + x, p[1] + y, p[2] + z);
      this.norm.push(0, -1, 0);
      this.col.push(c[0], c[1], c[2]);
    }
    return this;
  }

  /** Triangular prism roof (gabled). */
  gable(w, h, d, x, y, z, color, tint = 1) {
    const hx = w / 2, hz = d / 2;
    const c = new Float32Array(3);
    const tri = [[-hx, 0, 0], [hx, 0, 0], [0, h, 0]];
    // two sloped faces
    for (const sgn of [1, -1]) {
      const n = [sgn * 0.7, 0.7, 0];
      this._color(c, color, tint * (sgn > 0 ? 1 : 0.82));
      const a = [sgn * hx, 0, hz], b = [sgn * hx, 0, -hz], ap1 = [0, h, hz], ap2 = [0, h, -hz];
      const quad = sgn > 0 ? [a, b, ap2, a, ap2, ap1] : [b, a, ap1, b, ap1, ap2];
      for (const p of quad) {
        this.pos.push(p[0] + x, p[1] + y, p[2] + z);
        this.norm.push(n[0], n[1], n[2]);
        this.col.push(c[0], c[1], c[2]);
      }
    }
    // end caps
    for (const zz of [hz, -hz]) {
      const n = [0, 0, zz > 0 ? 1 : -1];
      this._color(c, color, tint * (zz > 0 ? 0.95 : 0.72));
      const order = zz > 0 ? [0, 1, 2] : [1, 0, 2];
      for (const i of order) {
        const p = tri[i];
        this.pos.push(p[0] + x, p[1] + y, p[2] + zz + z);
        this.norm.push(n[0], n[1], n[2]);
        this.col.push(c[0], c[1], c[2]);
      }
    }
    return this;
  }

  _color(out, hex, mul) {
    out[0] = Math.min(1, ((hex >> 16) & 255) / 255 * mul);
    out[1] = Math.min(1, ((hex >> 8) & 255) / 255 * mul);
    out[2] = Math.min(1, (hex & 255) / 255 * mul);
  }

  build(THREE) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.norm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere();
    return g;
  }
}

// Player colour is injected as a special sentinel so instanced meshes can tint
// only the "team" boxes. We bake it as pure magenta and swap in the shader.
const TEAM = 0xff00ff;

/* ------------------------------------------------------------------ *
 *  Units
 * ------------------------------------------------------------------ */

function bipedBase(m, teamColor = TEAM) {
  m.box(0.30, 0.34, 0.20, 0, 0.42, 0, teamColor);      // torso (team coloured)
  m.box(0.10, 0.24, 0.10, -0.11, 0.16, 0, PALETTE.dark);
  m.box(0.10, 0.24, 0.10, 0.11, 0.16, 0, PALETTE.dark);
  m.box(0.20, 0.18, 0.18, 0, 0.68, 0, PALETTE.skin);   // head
  return m;
}

const UNIT_BUILDERS = {
  villager(m) {
    bipedBase(m);
    m.box(0.22, 0.06, 0.22, 0, 0.76, 0, PALETTE.straw);       // hat
    m.box(0.05, 0.30, 0.05, 0.18, 0.45, 0.06, PALETTE.wood);  // tool handle
    m.box(0.10, 0.08, 0.04, 0.18, 0.60, 0.06, PALETTE.steel);
  },
  infantry(m) {
    bipedBase(m);
    m.box(0.24, 0.10, 0.22, 0, 0.76, 0, PALETTE.steel);       // helmet
    m.box(0.05, 0.34, 0.05, 0.19, 0.52, 0.02, PALETTE.wood2); // sword hilt
    m.box(0.06, 0.30, 0.03, 0.19, 0.78, 0.02, PALETTE.steel);
    m.box(0.04, 0.26, 0.20, -0.20, 0.46, 0, PALETTE.steelDark); // shield
  },
  spearman(m) {
    bipedBase(m);
    m.box(0.22, 0.08, 0.20, 0, 0.75, 0, PALETTE.wood2);
    m.box(0.045, 0.95, 0.045, 0.19, 0.62, 0.04, PALETTE.wood); // pike shaft
    m.box(0.06, 0.16, 0.05, 0.19, 1.15, 0.04, PALETTE.steel);  // spear head
  },
  archer(m) {
    bipedBase(m);
    m.box(0.20, 0.08, 0.18, 0, 0.75, 0, PALETTE.leafDry);
    m.box(0.04, 0.52, 0.05, 0.20, 0.52, 0, PALETTE.wood);      // bow
    m.box(0.04, 0.10, 0.14, -0.16, 0.54, -0.08, PALETTE.wood2); // quiver
  },
  skirmisher(m) {
    bipedBase(m);
    m.box(0.20, 0.08, 0.18, 0, 0.75, 0, PALETTE.wood2);
    m.box(0.04, 0.62, 0.04, 0.20, 0.60, 0, PALETTE.wood);      // javelin
    m.box(0.05, 0.10, 0.04, 0.20, 0.94, 0, PALETTE.steel);
    m.box(0.05, 0.24, 0.20, -0.19, 0.46, 0, PALETTE.wood2);
  },
  gunner(m) {
    bipedBase(m);
    m.box(0.24, 0.10, 0.22, 0, 0.76, 0, PALETTE.steelDark);
    m.box(0.05, 0.06, 0.46, 0.16, 0.50, 0.14, PALETTE.black);  // barrel
  },
  monk(m) {
    m.box(0.34, 0.56, 0.26, 0, 0.30, 0, PALETTE.white);        // robe
    m.box(0.20, 0.18, 0.18, 0, 0.68, 0, PALETTE.skin);
    m.box(0.24, 0.08, 0.22, 0, 0.78, 0, PALETTE.cloth);
    m.box(0.05, 0.10, 0.05, 0.16, 0.52, 0, PALETTE.gold);      // scroll
  },
  cavalry(m) {
    // horse
    m.box(0.30, 0.28, 0.66, 0, 0.44, 0, PALETTE.furDark);
    m.box(0.09, 0.32, 0.09, -0.10, 0.16, 0.22, PALETTE.furDark);
    m.box(0.09, 0.32, 0.09, 0.10, 0.16, 0.22, PALETTE.furDark);
    m.box(0.09, 0.32, 0.09, -0.10, 0.16, -0.22, PALETTE.furDark);
    m.box(0.09, 0.32, 0.09, 0.10, 0.16, -0.22, PALETTE.furDark);
    m.box(0.18, 0.20, 0.22, 0, 0.62, 0.34, PALETTE.furDark);   // head
    m.box(0.06, 0.06, 0.22, 0, 0.52, -0.40, PALETTE.fur);      // tail
    // rider
    m.box(0.26, 0.28, 0.20, 0, 0.76, -0.02, TEAM);
    m.box(0.18, 0.16, 0.16, 0, 0.98, -0.02, PALETTE.steel);
    m.box(0.05, 0.60, 0.05, 0.18, 0.86, 0.10, PALETTE.wood);   // lance
    m.box(0.05, 0.14, 0.05, 0.18, 1.18, 0.10, PALETTE.steel);
  },
  cavalryArcher(m) {
    UNIT_BUILDERS.cavalry(m);
    m.box(0.04, 0.44, 0.05, -0.20, 0.86, 0.04, PALETTE.wood);
  },
  camel(m) {
    m.box(0.28, 0.30, 0.62, 0, 0.52, 0, PALETTE.straw);
    m.box(0.24, 0.16, 0.24, 0, 0.72, -0.02, PALETTE.straw);    // hump
    m.box(0.08, 0.42, 0.08, -0.10, 0.21, 0.20, PALETTE.straw);
    m.box(0.08, 0.42, 0.08, 0.10, 0.21, 0.20, PALETTE.straw);
    m.box(0.08, 0.42, 0.08, -0.10, 0.21, -0.20, PALETTE.straw);
    m.box(0.08, 0.42, 0.08, 0.10, 0.21, -0.20, PALETTE.straw);
    m.box(0.12, 0.30, 0.12, 0, 0.80, 0.30, PALETTE.straw);     // neck
    m.box(0.14, 0.14, 0.20, 0, 0.96, 0.36, PALETTE.straw);
    m.box(0.24, 0.26, 0.20, 0, 0.94, -0.06, TEAM);             // rider
    m.box(0.16, 0.14, 0.14, 0, 1.14, -0.06, PALETTE.cloth);
    m.box(0.05, 0.56, 0.05, 0.17, 1.02, 0.06, PALETTE.wood);
  },
  elephant(m) {
    m.box(0.60, 0.52, 1.00, 0, 0.62, 0, PALETTE.stoneDark);
    m.box(0.16, 0.40, 0.16, -0.20, 0.20, 0.32, PALETTE.stoneDark);
    m.box(0.16, 0.40, 0.16, 0.20, 0.20, 0.32, PALETTE.stoneDark);
    m.box(0.16, 0.40, 0.16, -0.20, 0.20, -0.32, PALETTE.stoneDark);
    m.box(0.16, 0.40, 0.16, 0.20, 0.20, -0.32, PALETTE.stoneDark);
    m.box(0.34, 0.32, 0.28, 0, 0.78, 0.58, PALETTE.stoneDark); // head
    m.box(0.12, 0.34, 0.12, 0, 0.58, 0.70, PALETTE.stoneDark); // trunk
    m.box(0.05, 0.05, 0.22, -0.15, 0.66, 0.70, PALETTE.white); // tusks
    m.box(0.05, 0.05, 0.22, 0.15, 0.66, 0.70, PALETTE.white);
    m.box(0.46, 0.26, 0.46, 0, 1.02, -0.10, TEAM);             // howdah
    m.box(0.18, 0.24, 0.16, 0, 1.28, -0.10, PALETTE.skin);
  },
  ram(m) {
    m.box(0.70, 0.16, 1.10, 0, 0.30, 0, PALETTE.wood2);
    m.box(0.16, 0.16, 1.30, 0, 0.56, 0, PALETTE.wood);
    m.box(0.22, 0.22, 0.22, 0, 0.56, 0.72, PALETTE.steelDark);
    m.box(0.66, 0.30, 0.70, 0, 0.80, -0.10, PALETTE.wood2);
    m.box(0.12, 0.12, 0.12, -0.34, 0.16, 0.40, PALETTE.black);
    m.box(0.12, 0.12, 0.12, 0.34, 0.16, 0.40, PALETTE.black);
    m.box(0.12, 0.12, 0.12, -0.34, 0.16, -0.40, PALETTE.black);
    m.box(0.12, 0.12, 0.12, 0.34, 0.16, -0.40, PALETTE.black);
  },
  mangonel(m) {
    m.box(0.60, 0.14, 0.80, 0, 0.26, 0, PALETTE.wood2);
    m.box(0.10, 0.44, 0.10, -0.22, 0.50, -0.10, PALETTE.wood);
    m.box(0.10, 0.44, 0.10, 0.22, 0.50, -0.10, PALETTE.wood);
    m.box(0.10, 0.10, 0.80, 0, 0.62, 0.14, PALETTE.wood);      // throwing arm
    m.box(0.22, 0.16, 0.22, 0, 0.74, 0.48, PALETTE.stone);     // bucket
    m.box(0.14, 0.14, 0.14, -0.30, 0.14, 0.28, PALETTE.black);
    m.box(0.14, 0.14, 0.14, 0.30, 0.14, 0.28, PALETTE.black);
    m.box(0.14, 0.14, 0.14, -0.30, 0.14, -0.28, PALETTE.black);
    m.box(0.14, 0.14, 0.14, 0.30, 0.14, -0.28, PALETTE.black);
  },
  scorpion(m) {
    m.box(0.46, 0.12, 0.66, 0, 0.24, 0, PALETTE.wood2);
    m.box(0.70, 0.08, 0.08, 0, 0.44, 0.16, PALETTE.wood);      // bow arms
    m.box(0.08, 0.08, 0.60, 0, 0.44, -0.04, PALETTE.wood);
    m.box(0.05, 0.05, 0.40, 0, 0.50, 0.34, PALETTE.steelDark); // bolt
    m.box(0.12, 0.12, 0.12, -0.24, 0.12, 0.22, PALETTE.black);
    m.box(0.12, 0.12, 0.12, 0.24, 0.12, 0.22, PALETTE.black);
    m.box(0.12, 0.12, 0.12, -0.24, 0.12, -0.22, PALETTE.black);
    m.box(0.12, 0.12, 0.12, 0.24, 0.12, -0.22, PALETTE.black);
  },
  cannon(m) {
    m.box(0.56, 0.14, 0.76, 0, 0.24, 0, PALETTE.wood2);
    m.box(0.24, 0.24, 0.86, 0, 0.50, 0.10, PALETTE.black);     // barrel
    m.box(0.30, 0.30, 0.16, 0, 0.50, -0.26, PALETTE.steelDark);
    m.box(0.16, 0.16, 0.16, -0.28, 0.14, 0.24, PALETTE.black);
    m.box(0.16, 0.16, 0.16, 0.28, 0.14, 0.24, PALETTE.black);
    m.box(0.16, 0.16, 0.16, -0.28, 0.14, -0.24, PALETTE.black);
    m.box(0.16, 0.16, 0.16, 0.28, 0.14, -0.24, PALETTE.black);
  },
  trebuchet(m) {
    m.box(0.64, 0.16, 0.90, 0, 0.24, 0, PALETTE.wood2);
    m.box(0.12, 1.00, 0.12, -0.26, 0.80, 0, PALETTE.wood);
    m.box(0.12, 1.00, 0.12, 0.26, 0.80, 0, PALETTE.wood);
    m.box(0.10, 0.10, 1.40, 0, 1.22, 0.12, PALETTE.wood);      // arm
    m.box(0.26, 0.28, 0.26, 0, 1.10, -0.52, PALETTE.stoneDark); // counterweight
  },
  wagon(m) {
    m.box(0.62, 0.36, 0.86, 0, 0.42, 0, PALETTE.wood2);
    m.box(0.66, 0.18, 0.30, 0, 0.68, -0.02, TEAM);
    m.box(0.16, 0.16, 0.16, -0.32, 0.16, 0.30, PALETTE.black);
    m.box(0.16, 0.16, 0.16, 0.32, 0.16, 0.30, PALETTE.black);
    m.box(0.16, 0.16, 0.16, -0.32, 0.16, -0.30, PALETTE.black);
    m.box(0.16, 0.16, 0.16, 0.32, 0.16, -0.30, PALETTE.black);
  },
  ship(m) {
    m.box(0.56, 0.24, 1.30, 0, 0.20, 0, PALETTE.wood2);
    m.box(0.44, 0.16, 1.10, 0, 0.36, 0, PALETTE.wood);
    m.box(0.08, 0.90, 0.08, 0, 0.86, 0.06, PALETTE.wood);      // mast
    m.box(0.04, 0.62, 0.52, 0.01, 0.92, 0.06, TEAM);           // sail
  },
  fishingBoat(m) {
    m.box(0.44, 0.20, 0.90, 0, 0.18, 0, PALETTE.wood2);
    m.box(0.06, 0.52, 0.06, 0, 0.50, 0, PALETTE.wood);
    m.box(0.03, 0.34, 0.30, 0.01, 0.56, 0, PALETTE.white);
  },
  sheep(m) {
    m.box(0.34, 0.26, 0.46, 0, 0.30, 0, PALETTE.white);
    m.box(0.06, 0.16, 0.06, -0.10, 0.10, 0.14, PALETTE.dark);
    m.box(0.06, 0.16, 0.06, 0.10, 0.10, 0.14, PALETTE.dark);
    m.box(0.06, 0.16, 0.06, -0.10, 0.10, -0.14, PALETTE.dark);
    m.box(0.06, 0.16, 0.06, 0.10, 0.10, -0.14, PALETTE.dark);
    m.box(0.18, 0.16, 0.16, 0, 0.38, 0.28, PALETTE.dark);
  },
  deer(m) {
    m.box(0.26, 0.26, 0.56, 0, 0.44, 0, PALETTE.fur);
    m.box(0.06, 0.34, 0.06, -0.09, 0.18, 0.18, PALETTE.furDark);
    m.box(0.06, 0.34, 0.06, 0.09, 0.18, 0.18, PALETTE.furDark);
    m.box(0.06, 0.34, 0.06, -0.09, 0.18, -0.18, PALETTE.furDark);
    m.box(0.06, 0.34, 0.06, 0.09, 0.18, -0.18, PALETTE.furDark);
    m.box(0.16, 0.16, 0.20, 0, 0.66, 0.30, PALETTE.fur);
    m.box(0.04, 0.20, 0.04, -0.06, 0.82, 0.30, PALETTE.wood2);
    m.box(0.04, 0.20, 0.04, 0.06, 0.82, 0.30, PALETTE.wood2);
  },
  boar(m) {
    m.box(0.40, 0.34, 0.66, 0, 0.34, 0, PALETTE.furDark);
    m.box(0.08, 0.20, 0.08, -0.13, 0.12, 0.20, PALETTE.black);
    m.box(0.08, 0.20, 0.08, 0.13, 0.12, 0.20, PALETTE.black);
    m.box(0.08, 0.20, 0.08, -0.13, 0.12, -0.20, PALETTE.black);
    m.box(0.08, 0.20, 0.08, 0.13, 0.12, -0.20, PALETTE.black);
    m.box(0.26, 0.22, 0.26, 0, 0.42, 0.40, PALETTE.black);
    m.box(0.04, 0.04, 0.12, -0.10, 0.36, 0.54, PALETTE.white);
    m.box(0.04, 0.04, 0.12, 0.10, 0.36, 0.54, PALETTE.white);
  },
  wolf(m) {
    m.box(0.24, 0.22, 0.54, 0, 0.32, 0, PALETTE.stoneDark);
    m.box(0.06, 0.24, 0.06, -0.08, 0.14, 0.16, PALETTE.stoneDark);
    m.box(0.06, 0.24, 0.06, 0.08, 0.14, 0.16, PALETTE.stoneDark);
    m.box(0.06, 0.24, 0.06, -0.08, 0.14, -0.16, PALETTE.stoneDark);
    m.box(0.06, 0.24, 0.06, 0.08, 0.14, -0.16, PALETTE.stoneDark);
    m.box(0.16, 0.14, 0.22, 0, 0.44, 0.30, PALETTE.stoneDark);
    m.box(0.05, 0.05, 0.20, 0, 0.40, -0.34, PALETTE.stoneDark);
  },
};

/* ------------------------------------------------------------------ *
 *  Buildings - each built to fit its tile footprint
 * ------------------------------------------------------------------ */

const BUILDING_BUILDERS = {
  townCenter(m, s) {
    m.box(s * 0.85, 0.30, s * 0.85, 0, 0.15, 0, PALETTE.stone);
    m.box(s * 0.62, 0.90, s * 0.62, 0, 0.75, 0, PALETTE.cloth);
    m.gable(s * 0.72, 0.55, s * 0.72, 0, 1.20, 0, PALETTE.roofRed);
    for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      m.box(0.26, 1.30, 0.26, dx * s * 0.36, 0.65, dz * s * 0.36, PALETTE.wood2);
      m.pyramid(0.36, 0.36, 0.36, dx * s * 0.36, 1.30, dz * s * 0.36, TEAM);
    }
    m.box(0.10, 0.60, 0.10, 0, 1.75, 0, PALETTE.wood);
    m.box(0.02, 0.28, 0.36, 0.02, 1.95, 0.18, TEAM);
  },
  house(m, s) {
    m.box(s * 0.72, 0.62, s * 0.62, 0, 0.31, 0, PALETTE.cloth);
    m.gable(s * 0.80, 0.46, s * 0.70, 0, 0.62, 0, PALETTE.straw);
    m.box(0.22, 0.34, 0.06, 0, 0.17, s * 0.32, PALETTE.wood2);
    m.box(0.14, 0.34, 0.14, s * 0.24, 0.95, -s * 0.16, PALETTE.stoneDark);
  },
  mill(m, s) {
    m.box(s * 0.66, 0.60, s * 0.66, 0, 0.30, 0, PALETTE.wood2);
    m.pyramid(s * 0.78, 0.50, s * 0.78, 0, 0.60, 0, PALETTE.straw);
    m.box(0.08, 0.90, 0.08, s * 0.30, 0.75, s * 0.30, PALETTE.wood);
    m.box(0.70, 0.06, 0.10, s * 0.30, 1.05, s * 0.30, PALETTE.wood);
    m.box(0.10, 0.06, 0.70, s * 0.30, 1.05, s * 0.30, PALETTE.wood);
  },
  lumberCamp(m, s) {
    m.box(s * 0.70, 0.34, s * 0.56, 0, 0.17, 0, PALETTE.wood2);
    m.box(s * 0.24, 0.44, s * 0.24, -s * 0.22, 0.50, 0, PALETTE.wood);
    m.gable(s * 0.76, 0.30, s * 0.62, 0, 0.36, 0, PALETTE.wood);
    for (let i = 0; i < 3; i++) m.box(0.18, 0.18, 0.60, s * 0.24, 0.12 + i * 0.19, 0, PALETTE.wood2);
  },
  miningCamp(m, s) {
    m.box(s * 0.68, 0.30, s * 0.60, 0, 0.15, 0, PALETTE.stoneDark);
    m.gable(s * 0.74, 0.34, s * 0.66, 0, 0.32, 0, PALETTE.wood2);
    m.box(0.20, 0.20, 0.20, -s * 0.24, 0.42, s * 0.20, PALETTE.gold);
    m.box(0.18, 0.18, 0.18, s * 0.20, 0.40, -s * 0.18, PALETTE.stone);
  },
  farm(m, s) {
    m.box(s * 0.94, 0.06, s * 0.94, 0, 0.03, 0, PALETTE.dirt);
    for (let i = -2; i <= 2; i++) {
      m.box(s * 0.88, 0.10, 0.16, 0, 0.10, i * s * 0.18, PALETTE.leafDry);
    }
    for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      m.box(0.08, 0.24, 0.08, dx * s * 0.46, 0.12, dz * s * 0.46, PALETTE.wood2);
    }
  },
  barracks(m, s) {
    m.box(s * 0.78, 0.80, s * 0.66, 0, 0.40, 0, PALETTE.wood2);
    m.gable(s * 0.86, 0.42, s * 0.74, 0, 0.80, 0, PALETTE.roofRed);
    m.box(0.30, 0.50, 0.08, 0, 0.25, s * 0.34, PALETTE.black);
    m.box(0.08, 0.70, 0.08, -s * 0.34, 0.90, s * 0.30, PALETTE.wood);
    m.box(0.02, 0.28, 0.30, -s * 0.33, 1.10, s * 0.42, TEAM);
    m.box(0.06, 0.44, 0.06, s * 0.26, 1.00, -s * 0.20, PALETTE.steel);
  },
  archeryRange(m, s) {
    m.box(s * 0.78, 0.62, s * 0.66, 0, 0.31, 0, PALETTE.cloth);
    m.gable(s * 0.86, 0.40, s * 0.74, 0, 0.62, 0, PALETTE.wood2);
    for (let i = -1; i <= 1; i++) {
      m.box(0.06, 0.50, 0.06, i * s * 0.22, 0.30, s * 0.36, PALETTE.wood);  // targets
      m.box(0.22, 0.22, 0.05, i * s * 0.22, 0.60, s * 0.37, PALETTE.white);
      m.box(0.10, 0.10, 0.05, i * s * 0.22, 0.60, s * 0.39, PALETTE.red);
    }
    m.box(0.02, 0.26, 0.28, s * 0.36, 1.00, 0, TEAM);
  },
  stable(m, s) {
    m.box(s * 0.80, 0.66, s * 0.70, 0, 0.33, 0, PALETTE.wood2);
    m.gable(s * 0.88, 0.44, s * 0.78, 0, 0.66, 0, PALETTE.straw);
    m.box(0.34, 0.44, 0.06, -s * 0.20, 0.22, s * 0.36, PALETTE.black);
    m.box(0.34, 0.44, 0.06, s * 0.20, 0.22, s * 0.36, PALETTE.black);
    for (let i = -1; i <= 1; i++) m.box(0.06, 0.34, 0.06, i * s * 0.30, 0.17, -s * 0.44, PALETTE.wood);
    m.box(0.02, 0.26, 0.28, 0, 1.10, 0, TEAM);
  },
  blacksmith(m, s) {
    m.box(s * 0.74, 0.70, s * 0.66, 0, 0.35, 0, PALETTE.stoneDark);
    m.gable(s * 0.82, 0.36, s * 0.72, 0, 0.70, 0, PALETTE.stone);
    m.box(0.26, 0.60, 0.26, s * 0.28, 1.00, -s * 0.24, PALETTE.stoneDark);  // chimney
    m.box(0.20, 0.16, 0.20, s * 0.28, 1.34, -s * 0.24, 0xff6a2a);           // fire glow
    m.box(0.28, 0.28, 0.28, -s * 0.26, 0.16, s * 0.28, PALETTE.steelDark);  // anvil
  },
  market(m, s) {
    m.box(s * 0.86, 0.22, s * 0.86, 0, 0.11, 0, PALETTE.dirt);
    for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      m.box(0.08, 0.70, 0.08, dx * s * 0.34, 0.45, dz * s * 0.34, PALETTE.wood);
    }
    m.box(s * 0.82, 0.10, s * 0.82, 0, 0.84, 0, TEAM);
    m.box(0.34, 0.30, 0.34, -s * 0.20, 0.30, 0, PALETTE.wood2);
    m.box(0.26, 0.24, 0.26, s * 0.22, 0.26, s * 0.16, PALETTE.straw);
  },
  monastery(m, s) {
    m.box(s * 0.66, 0.90, s * 0.66, 0, 0.45, 0, PALETTE.white);
    m.pyramid(s * 0.76, 0.60, s * 0.76, 0, 0.90, 0, PALETTE.roofBlue);
    m.box(0.26, 0.90, 0.26, 0, 1.40, 0, PALETTE.white);
    m.pyramid(0.36, 0.34, 0.36, 0, 1.85, 0, PALETTE.gold);
    m.box(0.06, 0.34, 0.06, 0, 2.16, 0, PALETTE.gold);
    m.box(0.22, 0.06, 0.06, 0, 2.06, 0, PALETTE.gold);
  },
  university(m, s) {
    m.box(s * 0.72, 0.86, s * 0.72, 0, 0.43, 0, PALETTE.cloth);
    m.pyramid(s * 0.84, 0.44, s * 0.84, 0, 0.86, 0, PALETTE.roofBlue);
    for (let i = -1; i <= 1; i += 2) {
      m.box(0.16, 1.05, 0.16, i * s * 0.28, 0.52, s * 0.30, PALETTE.white);
    }
    m.box(0.28, 0.20, 0.20, 0, 1.20, 0, TEAM);
  },
  siegeWorkshop(m, s) {
    m.box(s * 0.80, 0.56, s * 0.70, 0, 0.28, 0, PALETTE.wood2);
    m.gable(s * 0.88, 0.40, s * 0.78, 0, 0.56, 0, PALETTE.wood);
    m.box(0.60, 0.10, 0.10, -s * 0.16, 0.95, s * 0.10, PALETTE.wood);
    m.box(0.24, 0.24, 0.24, -s * 0.34, 0.16, s * 0.34, PALETTE.stone);
    m.box(0.14, 0.14, 0.14, s * 0.32, 0.10, s * 0.30, PALETTE.black);
    m.box(0.14, 0.14, 0.14, s * 0.32, 0.10, -s * 0.30, PALETTE.black);
  },
  castle(m, s) {
    m.box(s * 0.80, 1.40, s * 0.80, 0, 0.70, 0, PALETTE.stone);
    m.box(s * 0.86, 0.18, s * 0.86, 0, 1.48, 0, PALETTE.stoneDark);
    for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      m.box(0.50, 2.10, 0.50, dx * s * 0.40, 1.05, dz * s * 0.40, PALETTE.stone);
      m.box(0.60, 0.16, 0.60, dx * s * 0.40, 2.18, dz * s * 0.40, PALETTE.stoneDark);
      m.pyramid(0.56, 0.50, 0.56, dx * s * 0.40, 2.26, dz * s * 0.40, TEAM);
    }
    m.box(0.44, 0.70, 0.10, 0, 0.35, s * 0.41, PALETTE.wood2);   // gate
    m.box(0.10, 0.50, 0.10, 0, 1.80, 0, PALETTE.wood);
    m.box(0.02, 0.26, 0.34, 0.02, 1.95, 0.17, TEAM);
  },
  outpost(m, s) {
    m.box(0.18, 0.90, 0.18, -0.18, 0.45, -0.18, PALETTE.wood);
    m.box(0.18, 0.90, 0.18, 0.18, 0.45, 0.18, PALETTE.wood);
    m.box(0.56, 0.16, 0.56, 0, 0.96, 0, PALETTE.wood2);
    m.pyramid(0.60, 0.34, 0.60, 0, 1.04, 0, TEAM);
  },
  watchTower(m, s) {
    m.box(0.62, 1.30, 0.62, 0, 0.65, 0, PALETTE.stone);
    m.box(0.78, 0.16, 0.78, 0, 1.38, 0, PALETTE.stoneDark);
    m.pyramid(0.80, 0.46, 0.80, 0, 1.46, 0, PALETTE.roofRed);
    m.box(0.10, 0.30, 0.10, 0, 1.85, 0, PALETTE.wood);
    m.box(0.02, 0.20, 0.24, 0.02, 1.95, 0.12, TEAM);
  },
  guardTower(m, s) {
    BUILDING_BUILDERS.watchTower(m, s);
    m.box(0.86, 0.14, 0.86, 0, 1.54, 0, PALETTE.stoneDark);
  },
  keep(m, s) {
    m.box(0.70, 1.80, 0.70, 0, 0.90, 0, PALETTE.stone);
    m.box(0.92, 0.20, 0.92, 0, 1.90, 0, PALETTE.stoneDark);
    for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      m.box(0.18, 0.24, 0.18, dx * 0.34, 2.10, dz * 0.34, PALETTE.stone);
    }
    m.pyramid(0.70, 0.44, 0.70, 0, 2.00, 0, TEAM);
  },
  bombardTower(m, s) {
    m.box(0.72, 1.40, 0.72, 0, 0.70, 0, PALETTE.stoneDark);
    m.box(0.90, 0.18, 0.90, 0, 1.48, 0, PALETTE.stone);
    m.box(0.22, 0.22, 0.70, 0.10, 1.66, 0.24, PALETTE.black);
    m.pyramid(0.50, 0.30, 0.50, -0.16, 1.58, -0.16, TEAM);
  },
  palisadeWall(m, s) {
    for (let i = -1; i <= 1; i++) {
      m.box(0.24, 0.80, 0.24, i * 0.30, 0.40, 0, PALETTE.wood);
      m.pyramid(0.26, 0.16, 0.26, i * 0.30, 0.80, 0, PALETTE.wood2);
    }
    m.box(0.94, 0.10, 0.10, 0, 0.56, 0, PALETTE.wood2);
  },
  stoneWall(m, s) {
    m.box(0.98, 0.90, 0.70, 0, 0.45, 0, PALETTE.stone);
    m.box(0.98, 0.12, 0.80, 0, 0.94, 0, PALETTE.stoneDark);
  },
  fortifiedWall(m, s) {
    m.box(0.98, 1.20, 0.80, 0, 0.60, 0, PALETTE.stone);
    m.box(0.98, 0.14, 0.92, 0, 1.24, 0, PALETTE.stoneDark);
    for (let i = -1; i <= 1; i++) m.box(0.22, 0.22, 0.22, i * 0.32, 1.40, 0, PALETTE.stone);
  },
  gate(m, s) {
    m.box(0.24, 1.40, 0.86, -0.36, 0.70, 0, PALETTE.stone);
    m.box(0.24, 1.40, 0.86, 0.36, 0.70, 0, PALETTE.stone);
    m.box(0.98, 0.24, 0.86, 0, 1.50, 0, PALETTE.stoneDark);
    m.box(0.50, 1.10, 0.14, 0, 0.55, 0, PALETTE.wood2);
  },
  dock(m, s) {
    m.box(s * 0.90, 0.14, s * 0.50, 0, 0.07, s * 0.22, PALETTE.wood2);
    m.box(s * 0.56, 0.60, s * 0.44, -s * 0.16, 0.30, -s * 0.24, PALETTE.wood);
    m.gable(s * 0.64, 0.36, s * 0.52, -s * 0.16, 0.60, -s * 0.24, PALETTE.straw);
    m.box(0.12, 0.60, 0.12, s * 0.34, 0.30, s * 0.32, PALETTE.wood);
    m.box(0.02, 0.24, 0.26, s * 0.34, 0.66, s * 0.32, TEAM);
  },
  wonder(m, s) {
    m.box(s * 0.80, 0.30, s * 0.80, 0, 0.15, 0, PALETTE.stoneDark);
    m.box(s * 0.62, 1.60, s * 0.62, 0, 1.10, 0, PALETTE.white);
    for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      m.box(0.24, 2.20, 0.24, dx * s * 0.34, 1.10, dz * s * 0.34, PALETTE.white);
      m.pyramid(0.34, 0.50, 0.34, dx * s * 0.34, 2.20, dz * s * 0.34, PALETTE.gold);
    }
    m.pyramid(s * 0.72, 1.00, s * 0.72, 0, 1.90, 0, TEAM);
    m.box(0.14, 0.60, 0.14, 0, 2.90, 0, PALETTE.gold);
    m.pyramid(0.30, 0.36, 0.30, 0, 3.44, 0, PALETTE.gold);
  },
  donjon(m, s) {
    m.box(s * 0.62, 1.60, s * 0.62, 0, 0.80, 0, PALETTE.stone);
    m.box(s * 0.74, 0.16, s * 0.74, 0, 1.68, 0, PALETTE.stoneDark);
    m.pyramid(s * 0.72, 0.50, s * 0.72, 0, 1.76, 0, TEAM);
  },
  krepost(m, s) {
    BUILDING_BUILDERS.castle(m, s * 0.8);
  },
  feitoria(m, s) {
    m.box(s * 0.70, 0.90, s * 0.70, 0, 0.45, 0, PALETTE.cloth);
    m.gable(s * 0.80, 0.50, s * 0.76, 0, 0.90, 0, PALETTE.roofRed);
    m.box(0.30, 0.30, 0.30, -s * 0.28, 0.20, s * 0.30, PALETTE.gold);
    m.box(0.26, 0.26, 0.26, s * 0.26, 0.18, s * 0.28, PALETTE.wood2);
  },
  caravanserai(m, s) {
    m.box(s * 0.80, 0.70, s * 0.80, 0, 0.35, 0, PALETTE.straw);
    m.pyramid(s * 0.86, 0.44, s * 0.86, 0, 0.70, 0, PALETTE.roofBlue);
    m.box(0.20, 0.60, 0.20, -s * 0.32, 0.90, -s * 0.32, PALETTE.white);
    m.box(0.20, 0.60, 0.20, s * 0.32, 0.90, s * 0.32, PALETTE.white);
  },
};

/* ------------------------------------------------------------------ *
 *  Resources & doodads
 * ------------------------------------------------------------------ */

const RESOURCE_BUILDERS = {
  tree(m) {
    m.box(0.16, 0.55, 0.16, 0, 0.27, 0, PALETTE.wood2);
    m.pyramid(0.80, 0.62, 0.80, 0, 0.50, 0, PALETTE.leaf);
    m.pyramid(0.62, 0.52, 0.62, 0, 0.86, 0, PALETTE.leaf2);
    m.pyramid(0.42, 0.42, 0.42, 0, 1.18, 0, PALETTE.leaf);
  },
  treeDry(m) {
    m.box(0.16, 0.60, 0.16, 0, 0.30, 0, PALETTE.wood2);
    m.pyramid(0.72, 0.55, 0.72, 0, 0.55, 0, PALETTE.leafDry);
    m.pyramid(0.50, 0.45, 0.50, 0, 0.88, 0, PALETTE.leaf2);
  },
  gold(m) {
    m.box(0.62, 0.26, 0.62, 0, 0.13, 0, PALETTE.stoneDark);
    m.box(0.40, 0.24, 0.40, 0.06, 0.34, -0.04, PALETTE.stone);
    m.box(0.20, 0.18, 0.20, -0.14, 0.30, 0.14, PALETTE.gold);
    m.box(0.14, 0.14, 0.14, 0.16, 0.50, 0.06, PALETTE.gold);
  },
  stone(m) {
    m.box(0.66, 0.28, 0.66, 0, 0.14, 0, PALETTE.stoneDark);
    m.box(0.44, 0.30, 0.44, -0.04, 0.38, 0.02, PALETTE.stone);
    m.box(0.26, 0.22, 0.26, 0.16, 0.56, -0.08, PALETTE.stone);
  },
  berries(m) {
    m.box(0.46, 0.34, 0.46, 0, 0.17, 0, PALETTE.leaf2);
    m.box(0.34, 0.20, 0.34, 0, 0.42, 0, PALETTE.leaf);
    for (const [dx, dz] of [[-0.14, 0.10], [0.12, -0.08], [0.02, 0.16], [-0.10, -0.14]]) {
      m.box(0.09, 0.09, 0.09, dx, 0.48, dz, 0xb03050);
    }
  },
  fish(m) {
    m.box(0.34, 0.10, 0.16, 0, 0.05, 0, 0x4a7fa8);
    m.box(0.12, 0.14, 0.06, -0.20, 0.06, 0, 0x3a6a90);
  },
  relic(m) {
    m.box(0.26, 0.34, 0.20, 0, 0.17, 0, PALETTE.gold);
    m.box(0.34, 0.08, 0.26, 0, 0.38, 0, PALETTE.gold);
    m.box(0.06, 0.22, 0.06, 0, 0.52, 0, PALETTE.white);
    m.box(0.18, 0.06, 0.06, 0, 0.48, 0, PALETTE.white);
  },
  carcass(m) {
    m.box(0.42, 0.14, 0.30, 0, 0.07, 0, PALETTE.furDark);
    m.box(0.16, 0.10, 0.16, 0.22, 0.06, 0, PALETTE.fur);
  },
  farmPlot(m) {
    m.box(0.9, 0.05, 0.9, 0, 0.02, 0, PALETTE.dirt);
  },
};

/* ------------------------------------------------------------------ *
 *  Public API
 * ------------------------------------------------------------------ */

export const TEAM_COLOR_SENTINEL = TEAM;

export function buildAllGeometries(THREE) {
  const out = { units: {}, buildings: {}, resources: {} };
  for (const k in UNIT_BUILDERS) {
    const m = new MeshBuilder();
    UNIT_BUILDERS[k](m);
    out.units[k] = m.build(THREE);
  }
  for (const k in BUILDING_BUILDERS) {
    const m = new MeshBuilder();
    // build against a unit footprint; the renderer scales to the real tile size
    BUILDING_BUILDERS[k](m, 1);
    out.buildings[k] = m.build(THREE);
  }
  for (const k in RESOURCE_BUILDERS) {
    const m = new MeshBuilder();
    RESOURCE_BUILDERS[k](m);
    out.resources[k] = m.build(THREE);
  }
  return out;
}

/** Maps a unit id to the mesh that should represent it. */
export function unitMeshKey(def) {
  const id = def.id;
  if (def.cat === 'villager') return 'villager';
  if (def.cat === 'animal') return id === 'sheep' ? 'sheep' : id === 'deer' ? 'deer' : id === 'boar' ? 'boar' : 'wolf';
  if (def.cat === 'trade') return 'wagon';
  if (def.cat === 'monk') return 'monk';
  if (def.cat === 'naval') return id === 'fishingShip' ? 'fishingBoat' : 'ship';
  if (def.classes.includes('elephant')) return 'elephant';
  if (def.classes.includes('camel')) return 'camel';
  if (id === 'trebuchet') return 'trebuchet';
  if (id.includes('Ram') || id === 'siegeTower') return 'ram';
  if (id.includes('angonel') || id.includes('nager')) return 'mangonel';
  if (id.includes('corpion')) return 'scorpion';
  if (id === 'bombardCannon' || id === 'organGun' || id === 'eliteOrganGun') return 'cannon';
  if (id === 'warWagon' || id === 'eliteWarWagon' || id === 'hussiteWagon' ||
      id === 'eliteHussiteWagon' || id === 'ratha' || id === 'eliteRatha') return 'wagon';
  if (def.classes.includes('gunpowder')) return 'gunner';
  if (def.classes.includes('cavalryArcher')) return 'cavalryArcher';
  if (def.cat === 'cavalry') return 'cavalry';
  if (def.cat === 'archer') {
    if (id.includes('kirmisher') || id === 'gbeto' || id === 'eliteGbeto' ||
        id === 'throwingAxeman' || id === 'eliteThrowingAxeman') return 'skirmisher';
    return 'archer';
  }
  if (def.classes.includes('spearman')) return 'spearman';
  return 'infantry';
}

export function buildingMeshKey(type) {
  return BUILDING_BUILDERS[type] ? type : 'house';
}
