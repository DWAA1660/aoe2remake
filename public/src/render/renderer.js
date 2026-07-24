// Retro renderer: low-poly flat-shaded 3D drawn through an isometric
// orthographic camera, rendered into a low-resolution buffer and upscaled with
// nearest-neighbour filtering. That gives the "3D model, 2D pixel art" hybrid.

import { buildAllGeometries, unitMeshKey, buildingMeshKey, TEAM_COLOR_SENTINEL } from './meshes.js';
import { TERRAIN } from '../sim/map.js';
import { RESOURCE_INFO } from '../sim/entity.js';

export const PLAYER_COLORS = [
  0x3b6ee0, 0xd13a2e, 0x37a34a, 0xe0c02a,
  0x2ec6c6, 0x9b45c9, 0xb0b0b0, 0xe07a25,
];

const TERRAIN_COLORS = {
  [TERRAIN.GRASS]: [0x5f8f43, 0x6b9a4c],
  [TERRAIN.GRASS2]: [0x517f3a, 0x5c8a42],
  [TERRAIN.DIRT]: [0x8a7449, 0x957e52],
  [TERRAIN.SAND]: [0xc4b27a, 0xcdbb84],
  [TERRAIN.WATER]: [0x24506e, 0x27587a],
  [TERRAIN.SHALLOW]: [0x3a7794, 0x40819e],
};

const TILE_H = 0.55;   // world height of one elevation step

export class Renderer {
  constructor(THREE, canvas, game) {
    this.THREE = THREE;
    this.game = game;
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(1);
    this.renderer.setClearColor(0x1a1a22, 1);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x141820);
    this.scene.fog = new THREE.Fog(0x141820, 60, 130);

    this.pixelScale = 0.5;
    this._setupCamera();
    this._setupLights();

    this.geoms = buildAllGeometries(THREE);
    this._teamGeomCache = new Map();
    this._pools = new Map();

    this._buildTerrain();
    this._buildWater();
    this._setupPost();
    this._setupOverlays();

    this.hoverTile = { x: 0, y: 0 };
    this.placement = null;   // { id, valid, tx, ty, size }
    this.resize();
  }

  /* ---------------- camera ---------------- */

  _setupCamera() {
    const THREE = this.THREE;
    this.camera = new THREE.OrthographicCamera(-20, 20, 12, -12, 0.1, 400);
    this.yaw = Math.PI / 4;
    this.pitch = 0.62;
    this.zoom = 22;               // half-width of the view in tiles
    this.center = { x: this.game.size / 2, y: this.game.size / 2 };
    this._applyCamera();
  }

  _applyCamera() {
    const d = 160;
    const cx = this.center.x, cz = this.center.y;
    const cy = 0;
    const dirX = Math.cos(this.yaw) * Math.cos(this.pitch);
    const dirY = Math.sin(this.pitch);
    const dirZ = Math.sin(this.yaw) * Math.cos(this.pitch);
    this.camera.position.set(cx + dirX * d, cy + dirY * d, cz + dirZ * d);
    this.camera.lookAt(cx, cy, cz);
    this.camera.updateMatrixWorld();
  }

  setZoom(z) {
    this.zoom = Math.max(9, Math.min(60, z));
    this.resize();
  }

  panBy(dx, dy) {
    // pan in screen space, converted to world XZ
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    this.center.x += dx * -s + dy * -c;
    this.center.y += dx * c + dy * -s;
    const m = this.game.size;
    this.center.x = Math.max(0, Math.min(m, this.center.x));
    this.center.y = Math.max(0, Math.min(m, this.center.y));
    this._applyCamera();
  }

  centerOn(x, y) {
    this.center.x = x; this.center.y = y;
    this._applyCamera();
  }

  rotate(dir) {
    this.yaw += dir * Math.PI / 4;
    this._applyCamera();
  }

  _setupLights() {
    const THREE = this.THREE;
    const sun = new THREE.DirectionalLight(0xfff2d0, 1.15);
    sun.position.set(0.6, 1.0, 0.35);
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0x8fa8d0, 0.45);
    fill.position.set(-0.5, 0.4, -0.7);
    this.scene.add(fill);
    this.scene.add(new THREE.AmbientLight(0x50607a, 0.9));
  }

  /* ---------------- terrain ---------------- */

  _cornerHeight(x, y) {
    const g = this.game, s = g.size;
    let h = 0, n = 0;
    for (const [dx, dy] of [[-1, -1], [0, -1], [-1, 0], [0, 0]]) {
      const tx = x + dx, ty = y + dy;
      if (tx < 0 || ty < 0 || tx >= s || ty >= s) continue;
      const i = ty * s + tx;
      let e = g.grid.elevation[i] * TILE_H;
      if (g.tiles[i] === TERRAIN.WATER) e = -0.45;
      else if (g.tiles[i] === TERRAIN.SHALLOW) e = -0.12;
      h += e; n++;
    }
    return n ? h / n : 0;
  }

  _buildTerrain() {
    const THREE = this.THREE;
    const g = this.game, s = g.size;
    const pos = new Float32Array(s * s * 6 * 3);
    const col = new Float32Array(s * s * 6 * 3);
    const nrm = new Float32Array(s * s * 6 * 3);

    const heights = new Float32Array((s + 1) * (s + 1));
    for (let y = 0; y <= s; y++)
      for (let x = 0; x <= s; x++) heights[y * (s + 1) + x] = this._cornerHeight(x, y);

    let p = 0;
    const cA = new THREE.Color(), tmp = new THREE.Vector3();
    for (let ty = 0; ty < s; ty++) {
      for (let tx = 0; tx < s; tx++) {
        const i = ty * s + tx;
        const variants = TERRAIN_COLORS[g.tiles[i]] || TERRAIN_COLORS[TERRAIN.GRASS];
        cA.setHex(variants[(tx + ty) & 1]);
        // slight per-tile jitter keeps big fields from banding
        const j = 0.94 + ((tx * 7 + ty * 13) % 5) * 0.025;
        const h00 = heights[ty * (s + 1) + tx];
        const h10 = heights[ty * (s + 1) + tx + 1];
        const h01 = heights[(ty + 1) * (s + 1) + tx];
        const h11 = heights[(ty + 1) * (s + 1) + tx + 1];
        const quad = [
          [tx, h00, ty], [tx + 1, h10, ty], [tx + 1, h11, ty + 1],
          [tx, h00, ty], [tx + 1, h11, ty + 1], [tx, h01, ty + 1],
        ];
        // face normal from the first triangle
        const ax = quad[1][0] - quad[0][0], ay = quad[1][1] - quad[0][1], az = quad[1][2] - quad[0][2];
        const bx = quad[2][0] - quad[0][0], by = quad[2][1] - quad[0][1], bz = quad[2][2] - quad[0][2];
        tmp.set(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx).normalize();
        for (const v of quad) {
          pos[p] = v[0]; pos[p + 1] = v[1]; pos[p + 2] = v[2];
          nrm[p] = tmp.x; nrm[p + 1] = tmp.y; nrm[p + 2] = tmp.z;
          col[p] = cA.r * j; col[p + 1] = cA.g * j; col[p + 2] = cA.b * j;
          p += 3;
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));

    // Fog of war lives in a small data texture sampled by world position.
    this.fogData = new Uint8Array(s * s);
    this.fogData.fill(0);
    this.fogTex = new THREE.DataTexture(this.fogData, s, s, THREE.RedFormat, THREE.UnsignedByteType);
    this.fogTex.needsUpdate = true;
    this.fogTex.minFilter = THREE.LinearFilter;
    this.fogTex.magFilter = THREE.LinearFilter;

    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.fogTex = { value: this.fogTex };
      shader.uniforms.mapSize = { value: s };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vTerrainXZ;')
        .replace('#include <begin_vertex>',
          '#include <begin_vertex>\nvTerrainXZ = (modelMatrix * vec4(position,1.0)).xz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>',
          '#include <common>\nuniform sampler2D fogTex;\nuniform float mapSize;\nvarying vec2 vTerrainXZ;')
        .replace('#include <dithering_fragment>',
          `#include <dithering_fragment>
           float fw = texture2D(fogTex, vTerrainXZ / mapSize).r;
           gl_FragColor.rgb *= mix(0.06, 1.0, fw);`);
    };
    this.terrain = new THREE.Mesh(geo, mat);
    this.terrain.frustumCulled = false;
    this.scene.add(this.terrain);
  }

  _buildWater() {
    const THREE = this.THREE;
    const s = this.game.size;
    const geo = new THREE.PlaneGeometry(s, s, 1, 1);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshLambertMaterial({
      color: 0x2c6188, transparent: true, opacity: 0.72, depthWrite: false,
    });
    this.water = new THREE.Mesh(geo, mat);
    this.water.position.set(s / 2, -0.14, s / 2);
    this.water.renderOrder = -1;
    this.scene.add(this.water);
  }

  updateFogTexture(player) {
    const s = this.game.size;
    const src = player.fog;
    const dst = this.fogData;
    for (let i = 0; i < dst.length; i++) {
      const v = src[i];
      dst[i] = v === 2 ? 255 : v === 1 ? 110 : 0;
    }
    this.fogTex.needsUpdate = true;
  }

  /* ---------------- instanced pools ---------------- */

  _teamGeometry(baseGeo, colorHex) {
    const key = baseGeo.uuid + '|' + colorHex;
    let g = this._teamGeomCache.get(key);
    if (g) return g;
    const THREE = this.THREE;
    g = baseGeo.clone();
    const col = g.getAttribute('color');
    const c = new THREE.Color(colorHex);
    const sr = ((TEAM_COLOR_SENTINEL >> 16) & 255) / 255;
    const sb = (TEAM_COLOR_SENTINEL & 255) / 255;
    for (let i = 0; i < col.count; i++) {
      const r = col.getX(i), gg = col.getY(i), b = col.getZ(i);
      // the sentinel is baked as magenta shaded by the face term: r ~= b, g ~= 0
      if (gg < 0.06 && r > 0.2 && b > 0.2 && Math.abs(r - b) < 0.12) {
        const shade = r / sr;
        col.setXYZ(i, c.r * shade, c.g * shade, c.b * shade);
        void sb;
      }
    }
    col.needsUpdate = true;
    this._teamGeomCache.set(key, g);
    return g;
  }

  _pool(key, baseGeo, colorHex) {
    let pool = this._pools.get(key);
    if (!pool) {
      const THREE = this.THREE;
      const geo = colorHex === null ? baseGeo : this._teamGeometry(baseGeo, colorHex);
      const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
      const mesh = new THREE.InstancedMesh(geo, mat, 64);
      mesh.frustumCulled = false;
      mesh.count = 0;
      this.scene.add(mesh);
      pool = { mesh, capacity: 64, used: 0 };
      this._pools.set(key, pool);
    }
    pool.used = 0;
    return pool;
  }

  _grow(pool) {
    const THREE = this.THREE;
    const old = pool.mesh;
    const cap = pool.capacity * 2;
    const mesh = new THREE.InstancedMesh(old.geometry, old.material, cap);
    mesh.frustumCulled = false;
    mesh.count = 0;
    this.scene.remove(old);
    old.dispose();
    this.scene.add(mesh);
    pool.mesh = mesh;
    pool.capacity = cap;
  }

  _addInstance(pool, x, y, z, rotY, scale, tint) {
    if (pool.used >= pool.capacity) this._grow(pool);
    const m = this._m4;
    const s = scale ?? 1;
    const c = Math.cos(rotY), sn = Math.sin(rotY);
    m.set(
      c * s, 0, sn * s, x,
      0, s, 0, y,
      -sn * s, 0, c * s, z,
      0, 0, 0, 1,
    );
    pool.mesh.setMatrixAt(pool.used, m);
    pool.used++;
    void tint;
  }

  /* ---------------- post-processing ---------------- */

  _setupPost() {
    const THREE = this.THREE;
    this.rt = new THREE.WebGLRenderTarget(320, 200, {
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat, depthBuffer: true,
    });
    this.postScene = new THREE.Scene();
    this.postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        tex: { value: this.rt.texture },
        levels: { value: 22.0 },
        vignette: { value: 0.22 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: `
        varying vec2 vUv;
        uniform sampler2D tex;
        uniform float levels;
        uniform float vignette;
        void main(){
          vec3 c = texture2D(tex, vUv).rgb;
          // gentle colour quantisation for the retro palette feel
          c = floor(c * levels + 0.5) / levels;
          float d = distance(vUv, vec2(0.5));
          c *= 1.0 - vignette * d * d * 2.0;
          gl_FragColor = vec4(c, 1.0);
        }
      `,
      depthTest: false, depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    quad.frustumCulled = false;
    this.postScene.add(quad);
    this.postMat = mat;
  }

  _setupOverlays() {
    const THREE = this.THREE;
    this._m4 = new THREE.Matrix4();
    this._v3 = new THREE.Vector3();
    this._ray = new THREE.Raycaster();
    this._plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    // selection ring geometry (flat annulus)
    const ring = new THREE.RingGeometry(0.42, 0.52, 16);
    ring.rotateX(-Math.PI / 2);
    this.ringGeo = ring;
    this.ringMatAlly = new THREE.MeshBasicMaterial({ color: 0x7cff7c, transparent: true, opacity: 0.95 });
    this.ringMatEnemy = new THREE.MeshBasicMaterial({ color: 0xff6b5c, transparent: true, opacity: 0.95 });

    // build ghost
    this.ghost = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: 0x7cff7c, transparent: true, opacity: 0.35, depthWrite: false }),
    );
    this.ghost.visible = false;
    this.scene.add(this.ghost);

    // projectiles
    this.projGeo = new THREE.BoxGeometry(0.09, 0.09, 0.34);
    this.projMat = new THREE.MeshBasicMaterial({ color: 0xf0e6c0 });
    this.projPool = new THREE.InstancedMesh(this.projGeo, this.projMat, 256);
    this.projPool.frustumCulled = false;
    this.projPool.count = 0;
    this.scene.add(this.projPool);

    // effect sprites (hits, explosions)
    this.fxGeo = new THREE.BoxGeometry(0.3, 0.3, 0.3);
    this.fxMat = new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.9 });
    this.fxPool = new THREE.InstancedMesh(this.fxGeo, this.fxMat, 256);
    this.fxPool.frustumCulled = false;
    this.fxPool.count = 0;
    this.scene.add(this.fxPool);
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    const aspect = w / h;
    this.camera.left = -this.zoom * aspect;
    this.camera.right = this.zoom * aspect;
    this.camera.top = this.zoom;
    this.camera.bottom = -this.zoom;
    this.camera.updateProjectionMatrix();
    const rw = Math.max(160, Math.round(w * this.pixelScale));
    const rh = Math.max(120, Math.round(h * this.pixelScale));
    this.rt.setSize(rw, rh);
    this.viewW = w; this.viewH = h;
  }

  setPixelScale(v) { this.pixelScale = v; this.resize(); }

  /* ---------------- picking ---------------- */

  screenToWorld(sx, sy) {
    const THREE = this.THREE;
    const ndc = new THREE.Vector2((sx / this.viewW) * 2 - 1, -(sy / this.viewH) * 2 + 1);
    this._ray.setFromCamera(ndc, this.camera);
    const hits = this._ray.intersectObject(this.terrain, false);
    if (hits.length) return { x: hits[0].point.x, y: hits[0].point.z };
    const out = new THREE.Vector3();
    if (this._ray.ray.intersectPlane(this._plane, out)) return { x: out.x, y: out.z };
    return null;
  }

  worldToScreen(x, yHeight, z) {
    const v = this._v3.set(x, yHeight, z).project(this.camera);
    return { x: (v.x * 0.5 + 0.5) * this.viewW, y: (-v.y * 0.5 + 0.5) * this.viewH, z: v.z };
  }

  heightAt(x, y) {
    const g = this.game, s = g.size;
    const tx = Math.max(0, Math.min(s - 1, x | 0));
    const ty = Math.max(0, Math.min(s - 1, y | 0));
    const i = ty * s + tx;
    if (g.tiles[i] === TERRAIN.WATER) return -0.35;
    if (g.tiles[i] === TERRAIN.SHALLOW) return -0.08;
    return g.grid.elevation[i] * TILE_H;
  }

  /* ---------------- frame ---------------- */

  render(viewPlayer, selection) {
    const THREE = this.THREE;
    const g = this.game;
    const reveal = g.revealAll;

    // reset pools
    for (const pool of this._pools.values()) pool.used = 0;
    const usedKeys = new Set();

    // --- resources ---
    for (const e of g.entities) {
      if (!e.alive) continue;
      if (e.kind === 'resource') {
        if (!reveal && !viewPlayer.hasExplored(e.x | 0, e.y | 0)) continue;
        let key = e.type;
        if (e.type === 'tree') key = e.variant === 3 ? 'treeDry' : 'tree';
        const geo = this.geoms.resources[key] || this.geoms.resources.tree;
        const pool = this._pool('res:' + key, geo, null);
        usedKeys.add('res:' + key);
        const h = this.heightAt(e.x, e.y);
        const rot = ((e.id * 47) % 8) * (Math.PI / 4);
        const depleted = e.maxAmount > 0 ? 0.7 + 0.3 * (e.amount / e.maxAmount) : 1;
        this._addInstance(pool, e.x, h, e.y, rot, e.type === 'tree' ? 1 : depleted);
      }
    }

    // --- buildings ---
    for (const e of g.entities) {
      if (!e.alive || e.kind !== 'building') continue;
      if (!reveal && !viewPlayer.hasExplored(e.x | 0, e.y | 0)) continue;
      const key = buildingMeshKey(e.type);
      const color = PLAYER_COLORS[e.owner % PLAYER_COLORS.length];
      const poolKey = `bld:${key}:${e.owner}`;
      const pool = this._pool(poolKey, this.geoms.buildings[key], color);
      usedKeys.add(poolKey);
      const h = this.heightAt(e.x, e.y);
      const scale = e.size;
      // under-construction buildings rise out of the ground
      const grow = e.complete ? 1 : 0.15 + 0.85 * (e.buildProgress / e.def.time);
      this._addInstance(pool, e.x, h, e.y, 0, scale * (e.def.wall || e.def.gate ? 1 : 1) * grow);
    }

    // --- units ---
    for (const e of g.entities) {
      if (!e.alive || e.kind !== 'unit' || e.garrisonedIn) continue;
      if (!reveal && !viewPlayer.canSee(e.x | 0, e.y | 0)) continue;
      const key = unitMeshKey(e.def);
      const owner = e.owner < 0 ? 6 : e.owner;
      const color = e.owner < 0 ? 0x9a8f7a : PLAYER_COLORS[owner % PLAYER_COLORS.length];
      const poolKey = `unit:${key}:${e.owner}`;
      const pool = this._pool(poolKey, this.geoms.units[key], color);
      usedKeys.add(poolKey);
      const h = this.heightAt(e.x, e.y);
      // walk bob
      const bob = e.moving ? Math.abs(Math.sin(e.anim * 9)) * 0.06 : 0;
      const scale = e.def.radius > 0.42 ? 1.25 : e.def.radius > 0.32 ? 1.08 : 1.0;
      this._addInstance(pool, e.x, h + bob, e.y, -e.facing + Math.PI / 2, scale);
    }

    for (const [key, pool] of this._pools) {
      pool.mesh.count = pool.used;
      pool.mesh.instanceMatrix.needsUpdate = true;
      if (!usedKeys.has(key)) pool.mesh.count = 0;
    }

    // --- projectiles ---
    let pc = 0;
    for (const p of g.projectiles) {
      if (pc >= 256) break;
      if (!reveal && !viewPlayer.canSee(p.x | 0, p.y | 0)) continue;
      const h = this.heightAt(p.x, p.y) + p.z;
      const ang = Math.atan2(p.ty - p.startY, p.tx - p.startX);
      this._m4.makeRotationY(-ang + Math.PI / 2);
      this._m4.setPosition(p.x, h, p.y);
      this.projPool.setMatrixAt(pc++, this._m4);
    }
    this.projPool.count = pc;
    this.projPool.instanceMatrix.needsUpdate = true;

    // --- effects ---
    let fc = 0;
    for (const fx of g.effects) {
      if (fc >= 256) break;
      if (!reveal && !viewPlayer.canSee(fx.x | 0, fx.y | 0)) continue;
      const life = fx.type === 'explosion' ? 0.5 : 0.28;
      if (fx.t > life) continue;
      const k = fx.t / life;
      const s = fx.type === 'explosion' ? (0.6 + k * (fx.r || 1) * 2.2) : (1 - k) * 0.8;
      if (s <= 0.01) continue;
      const h = this.heightAt(fx.x, fx.y) + 0.5 + k * 0.5;
      this._m4.makeScale(s, s, s);
      this._m4.setPosition(fx.x, h, fx.y);
      this.fxPool.setMatrixAt(fc++, this._m4);
    }
    this.fxPool.count = fc;
    this.fxPool.instanceMatrix.needsUpdate = true;

    // --- selection rings ---
    this._updateRings(selection);

    // --- build ghost ---
    if (this.placement) {
      const p = this.placement;
      this.ghost.visible = true;
      this.ghost.scale.set(p.size, 0.25, p.size);
      this.ghost.position.set(p.tx + p.size / 2, this.heightAt(p.tx, p.ty) + 0.15, p.ty + p.size / 2);
      this.ghost.material.color.setHex(p.valid ? 0x7cff7c : 0xff5555);
    } else {
      this.ghost.visible = false;
    }

    // --- draw: scene into the low-res buffer, then upscale ---
    this.renderer.setRenderTarget(this.rt);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.postScene, this.postCamera);
    void THREE;
  }

  _updateRings(selection) {
    const THREE = this.THREE;
    if (!this.ringPool) {
      this.ringPool = new THREE.InstancedMesh(this.ringGeo, this.ringMatAlly, 256);
      this.ringPool.frustumCulled = false;
      this.ringPool.count = 0;
      this.ringPool.renderOrder = 2;
      this.scene.add(this.ringPool);
    }
    let n = 0;
    for (const e of selection) {
      if (!e.alive || n >= 256) continue;
      const h = this.heightAt(e.x, e.y) + 0.06;
      const r = e.kind === 'building' ? e.size * 0.9 : Math.max(0.7, e.radius * 2.4);
      this._m4.makeScale(r, 1, r);
      this._m4.setPosition(e.x, h, e.y);
      this.ringPool.setMatrixAt(n++, this._m4);
    }
    this.ringPool.count = n;
    this.ringPool.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.renderer.dispose();
  }
}

export { RESOURCE_INFO };
