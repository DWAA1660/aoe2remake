// Retro renderer: low-poly flat-shaded 3D drawn through an isometric
// orthographic camera, rendered into a low-resolution buffer and upscaled with
// nearest-neighbour filtering. That gives the "3D model, 2D pixel art" hybrid.

import { buildAllGeometries, unitMeshKeyFor, buildingMeshKey, TEAM_COLOR_SENTINEL } from './meshes.js';
import { TERRAIN } from '../sim/map.js';
import { RESOURCE_INFO } from '../sim/entity.js';

export const PLAYER_COLORS = [
  0x3b6ee0, 0xd13a2e, 0x37a34a, 0xe0c02a,
  0x2ec6c6, 0x9b45c9, 0xb0b0b0, 0xe07a25,
];

// Age of Empires II "Arabia" ground palette: yellow-leaning grass, sun-bleached
// dirt paths and warm sand, rather than the cool forest green of a temperate map.
const TERRAIN_COLORS = {
  [TERRAIN.GRASS]: [0x86a247, 0x91ad51],
  [TERRAIN.GRASS2]: [0x9aad55, 0xa4b75f],
  [TERRAIN.DIRT]: [0xb59a63, 0xc0a56e],
  [TERRAIN.SAND]: [0xd8c48a, 0xe1ce95],
  [TERRAIN.WATER]: [0x2f6f96, 0x347aa3],
  [TERRAIN.SHALLOW]: [0x59a2b8, 0x63aec3],
};

const TILE_H = 0.55;   // world height of one elevation step

// How far back the orthographic camera sits. Anything distance-based (near/far
// planes, any scene fog) must be expressed relative to this, or it will apply to
// the whole world at once.
const CAMERA_DIST = 160;

// Seconds for a chopped tree to topple. Must stay under the effect lifetime in
// Game._updateEffects, or the tree pops out mid-fall.
const TREE_FALL_TIME = 1.05;

export class Renderer {
  constructor(THREE, canvas, game) {
    this.THREE = THREE;
    this.game = game;
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(1);
    this.renderer.setClearColor(0x1a1a22, 1);

    this.scene = new THREE.Scene();
    // Neutral near-black void beyond the map edge; a navy background reads as a
    // blue wash once it shows through around the coastline.
    this.scene.background = new THREE.Color(0x0c0c0e);
    // No distance fog: the orthographic camera is parked CAMERA_DIST units back,
    // so any fog range smaller than that silently paints the entire world in the
    // background colour. Fog-of-war darkening is done per-tile in the terrain
    // shader instead (see _buildTerrain).

    // 1.0 = render at full resolution (crisp). Lower values downsample and
    // nearest-upscale for the chunky retro look; the Menu has a slider.
    this.pixelScale = 1.0;
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
    // Orthographic: the pull-back distance does not change apparent size, it
    // only has to clear the tallest geometry. Near/far bracket it generously.
    this.camera = new THREE.OrthographicCamera(-20, 20, 12, -12, 1, CAMERA_DIST * 2.5);
    this.yaw = Math.PI / 4;
    this.pitch = 0.62;
    this.zoom = 15;               // half-height of the view in tiles
    this.center = { x: this.game.size / 2, y: this.game.size / 2 };
    this._applyCamera();
  }

  _applyCamera() {
    const d = CAMERA_DIST;
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
    this.zoom = Math.max(7, Math.min(45, z));
    this.resize();
  }

  /**
   * Pan by a screen-space delta (+dx = view moves right, +dy = view moves down),
   * converted into world XZ.
   *
   * Derivation, so this does not get sign-flipped again. The camera looks from
   * `center + dir * d` back at `center`, with dir = (cos y * cos p, sin p,
   * sin y * cos p) and world up (0,1,0). Its forward is -dir, so:
   *
   *   right  = normalise(cross(forward, up)) = ( sin y, 0, -cos y)
   *   up     = cross(right, forward), projected to the ground and normalised
   *          = (-cos y, 0, -sin y)   ->  screen-down is (cos y, 0, sin y)
   *
   * Moving the view right therefore advances `center` along `right`, and moving
   * it down advances along screen-down. (`center.y` holds the world Z axis.)
   */
  panBy(dx, dy) {
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    this.center.x += dx * s + dy * c;
    this.center.y += dx * -c + dy * s;
    const m = this.game.size;
    this.center.x = Math.max(0, Math.min(m, this.center.x));
    this.center.y = Math.max(0, Math.min(m, this.center.y));
    this._applyCamera();
  }

  /**
   * The HUD covers the top and bottom of the canvas, so the middle of the
   * *visible* 3D band is not the middle of the canvas. Telling the renderer how
   * much is covered lets centreing put things where the player can actually see
   * them, and lets the minimap draw a viewport box that matches.
   */
  setViewportInsets(top, bottom) {
    this.insetTop = top || 0;
    this.insetBottom = bottom || 0;
  }

  /** World-space offset from the canvas centre to the visible-band centre. */
  viewCenterOffset() {
    const top = this.insetTop || 0, bottom = this.insetBottom || 0;
    if (!top && !bottom) return { x: 0, y: 0 };
    const a = this.screenToWorld(this.viewW / 2, this.viewH / 2);
    const b = this.screenToWorld(this.viewW / 2, (top + (this.viewH - bottom)) / 2);
    if (!a || !b) return { x: 0, y: 0 };
    return { x: b.x - a.x, y: b.y - a.y };
  }

  /** Centres the view on a world point, accounting for the HUD insets. */
  centerOn(x, y) {
    const off = this.viewCenterOffset();
    this.center.x = x - off.x;
    this.center.y = y - off.y;
    this._applyCamera();
  }

  rotate(dir) {
    this.yaw += dir * Math.PI / 4;
    this._applyCamera();
  }

  _setupLights() {
    const THREE = this.THREE;
    // three.js r155+ dropped legacy lighting: a Lambert surface reflects
    // albedo * intensity / PI, where the old model effectively multiplied
    // intensity by PI. Every intensity here is therefore ~PI x what it would
    // have been, otherwise the whole scene renders at a third brightness.
    const PI = Math.PI;

    // Age of Empires reads as a warm, high-noon Mediterranean scene: a strong
    // golden key light and very little cool light. An overly blue sky/fill is
    // what makes a scene look like overcast dusk, so both are kept weak and
    // close to neutral here.
    const sun = new THREE.DirectionalLight(0xfff0cf, 1.45 * PI);
    sun.position.set(0.55, 1.0, 0.4);
    this.scene.add(sun);

    // barely-tinted bounce so shadowed faces stay readable without going blue
    const fill = new THREE.DirectionalLight(0xd8dcea, 0.22 * PI);
    fill.position.set(-0.5, 0.35, -0.7);
    this.scene.add(fill);

    // near-white sky over a warm earth bounce
    this.scene.add(new THREE.HemisphereLight(0xf2eede, 0x9c8347, 0.4 * PI));
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
        // Counter-clockwise seen from above, so the face normal comes out as
        // +Y. Winding these the other way makes every ground triangle
        // back-facing to an overhead camera: three culls the lot and the entire
        // map renders as empty space with only the water plane showing through.
        const quad = [
          [tx, h00, ty], [tx + 1, h11, ty + 1], [tx + 1, h10, ty],
          [tx, h00, ty], [tx, h01, ty + 1], [tx + 1, h11, ty + 1],
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
    // One byte per texel, so rows are not padded to a 4-byte boundary. Without
    // this a map whose width is not a multiple of 4 (e.g. the 150-tile Large
    // map) reads its fog rows progressively skewed.
    this.fogTex.unpackAlignment = 1;

    // Terrain uses a completely stock material. An earlier version patched the
    // fog-of-war lookup into this shader via onBeforeCompile; if that injection
    // fails to compile, three drops the material and the ENTIRE ground vanishes,
    // leaving only the water plane visible. Fog is therefore drawn as a separate
    // overlay below, so a shader problem can only ever cost the fog, never the
    // terrain itself.
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    this.terrain = new THREE.Mesh(geo, mat);
    this.terrain.frustumCulled = false;
    this.scene.add(this.terrain);

    // Fog overlay: the same geometry, lifted a hair, painted black with alpha
    // taken from the fog texture. Self-contained shader, no chunk injection.
    const fogMat = new THREE.ShaderMaterial({
      uniforms: {
        fogTex: { value: this.fogTex },
        mapSize: { value: s },
      },
      vertexShader: `
        varying vec2 vXZ;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vXZ = wp.xz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: `
        uniform sampler2D fogTex;
        uniform float mapSize;
        varying vec2 vXZ;
        void main() {
          float f = texture2D(fogTex, vXZ / mapSize).r;
          gl_FragColor = vec4(0.02, 0.02, 0.05, (1.0 - f) * 0.94);
        }
      `,
      transparent: true,
      depthWrite: false,
    });
    this.fogOverlay = new THREE.Mesh(geo, fogMat);
    this.fogOverlay.position.y = 0.02;
    this.fogOverlay.frustumCulled = false;
    this.fogOverlay.renderOrder = 3;
    this.scene.add(this.fogOverlay);
  }

  _buildWater() {
    const THREE = this.THREE;
    const s = this.game.size;
    const geo = new THREE.PlaneGeometry(s, s, 1, 1);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshLambertMaterial({
      color: 0x3a7fa8, transparent: true, opacity: 0.62, depthWrite: false,
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
    // 255 = fully lit, 0 = never seen. The middle value is the "shroud": ground
    // you have explored but cannot currently see. It has to sit far enough below
    // fully-visible to be obvious at a glance, while staying light enough that
    // remembered buildings and terrain are still readable.
    for (let i = 0; i < dst.length; i++) {
      const v = src[i];
      dst[i] = v === 2 ? 255 : v === 1 ? 100 : 0;
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
    // NOTE: deliberately does NOT reset pool.used. This is called once per
    // entity, so resetting here would zero the write cursor on every entity and
    // only the last one of each kind would ever be drawn. The per-frame reset
    // lives at the top of render().
    return pool;
  }

  _grow(pool) {
    const THREE = this.THREE;
    const old = pool.mesh;
    const cap = pool.capacity * 2;
    const mesh = new THREE.InstancedMesh(old.geometry, old.material, cap);
    mesh.frustumCulled = false;
    mesh.count = 0;
    // Carry over the instances already written this frame; growing happens
    // mid-loop, so dropping them would make the first N entities of a kind
    // flicker out on exactly the frame the pool expands.
    mesh.instanceMatrix.array.set(old.instanceMatrix.array.subarray(0, pool.used * 16));
    this.scene.remove(old);
    old.dispose();
    this.scene.add(mesh);
    pool.mesh = mesh;
    pool.capacity = cap;
  }

  /** `scaleY` may differ from `scale` so a building can grow upward out of the
   *  ground while keeping its true footprint visible. */
  _addInstance(pool, x, y, z, rotY, scale, scaleY) {
    if (pool.used >= pool.capacity) this._grow(pool);
    const m = this._m4;
    const s = scale ?? 1;
    const sy = scaleY ?? s;
    const c = Math.cos(rotY), sn = Math.sin(rotY);
    m.set(
      c * s, 0, sn * s, x,
      0, sy, 0, y,
      -sn * s, 0, c * s, z,
      0, 0, 0, 1,
    );
    pool.mesh.setMatrixAt(pool.used, m);
    pool.used++;
  }

  /**
   * Instance with a tilt as well as a heading. The geometry's origin sits at its
   * base, so tilting rotates it about the foot — which is exactly how a tree
   * should topple.
   */
  _addTiltedInstance(pool, x, y, z, rotY, tilt, scale) {
    if (pool.used >= pool.capacity) this._grow(pool);
    this._euler.set(tilt, rotY, 0, 'YXZ');
    this._quat.setFromEuler(this._euler);
    this._posV.set(x, y, z);
    this._scaleV.set(scale, scale, scale);
    this._m4.compose(this._posV, this._quat, this._scaleV);
    pool.mesh.setMatrixAt(pool.used, this._m4);
    pool.used++;
  }

  /* ---------------- post-processing ---------------- */

  _setupPost() {
    const THREE = this.THREE;
    this.rt = new THREE.WebGLRenderTarget(320, 200, {
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat, depthBuffer: true,
      samples: 4,   // MSAA on the offscreen buffer; smooths the low-poly edges
    });
    // The scene renders into this buffer, then a raw ShaderMaterial blits it to
    // the canvas. A raw shader does NOT get three's automatic linear -> sRGB
    // output conversion, so the buffer must already hold sRGB. Without this the
    // whole game is displayed in linear space and looks like permanent night.
    this.rt.texture.colorSpace = THREE.SRGBColorSpace;
    this.postScene = new THREE.Scene();
    this.postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        tex: { value: this.rt.texture },
        levels: { value: 64.0 },   // lower this for heavier colour banding
        vignette: { value: 0.08 },
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
    this._ndc = new THREE.Vector2();
    this._hit = new THREE.Vector3();
    this._euler = new THREE.Euler();
    this._quat = new THREE.Quaternion();
    this._posV = new THREE.Vector3();
    this._scaleV = new THREE.Vector3();

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

  /**
   * Screen pixel -> world tile, via the ground plane rather than a raycast
   * against the terrain mesh. The terrain is ~29k triangles and this runs
   * several times per frame (cursor + minimap viewport box), so intersecting
   * the flat plane is the difference between smooth and stuttering. Elevation
   * only spans half a tile, so the error is well under a tile.
   */
  screenToWorld(sx, sy) {
    this._ndc.set((sx / this.viewW) * 2 - 1, -(sy / this.viewH) * 2 + 1);
    this._ray.setFromCamera(this._ndc, this.camera);
    if (this._ray.ray.intersectPlane(this._plane, this._hit)) {
      return { x: this._hit.x, y: this._hit.z };
    }
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

    // --- felled trees: replay the topple where the tree used to stand ---
    for (const fx of g.effects) {
      if (fx.type !== 'treeFall') continue;
      if (!reveal && !viewPlayer.hasExplored(fx.x | 0, fx.y | 0)) continue;
      const k = Math.min(1, fx.t / TREE_FALL_TIME);
      // accelerate into the fall, then settle flat
      const tilt = Math.min(1, k * k * 1.08) * (Math.PI / 2);
      const geoKey = fx.variant === 3 ? 'treeDry' : 'tree';
      const poolKey = 'res:' + geoKey;
      const pool = this._pool(poolKey, this.geoms.resources[geoKey], null);
      usedKeys.add(poolKey);
      this._addTiltedInstance(pool, fx.x, this.heightAt(fx.x, fx.y), fx.y,
        fx.angle || 0, tilt, 1 - k * 0.12);
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

      if (e.complete) {
        this._addInstance(pool, e.x, h, e.y, 0, scale);

        // Flag your own farms that nobody is working, so an idle plot is
        // obvious without hunting for it.
        if (e.owner === viewPlayer.index && e.def.farmFood && e.farmFood > 0 &&
            !g._farmWorker(e)) {
          const mKey = 'misc:idleMarker';
          const mPool = this._pool(mKey, this.geoms.misc.idleMarker, null);
          usedKeys.add(mKey);
          const bob = Math.sin(g.time * 2.5 + e.id) * 0.12;
          this._addInstance(mPool, e.x, h + e.size * 0.5 + 0.9 + bob, e.y, g.time * 1.5, 1.1);
        }
      } else {
        // A construction site lays a visible foundation at the building's true
        // footprint, then the structure grows upward out of it. Scaling only Y
        // (rather than uniformly) means the plot stays the right size on the
        // ground from the moment it is placed, so you can always see where it is.
        const fKey = 'misc:foundation';
        const fPool = this._pool(fKey, this.geoms.misc.foundation, null);
        usedKeys.add(fKey);
        this._addInstance(fPool, e.x, h, e.y, 0, scale);

        const sKey = 'misc:scaffold';
        const sPool = this._pool(sKey, this.geoms.misc.scaffold, null);
        usedKeys.add(sKey);
        this._addInstance(sPool, e.x, h + 0.1, e.y, 0, scale, scale * 0.55);

        const grow = Math.max(0.04, e.buildProgress / e.def.time);
        this._addInstance(pool, e.x, h + 0.12, e.y, 0, scale, scale * grow);
      }
    }

    // --- units ---
    for (const e of g.entities) {
      if (!e.alive || e.kind !== 'unit' || e.garrisonedIn) continue;
      if (!reveal && !viewPlayer.canSee(e.x | 0, e.y | 0)) continue;
      const key = unitMeshKeyFor(e);
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
      if (fx.type === 'treeFall') continue;   // drawn as real geometry above
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

    this._updateFarmPreview();

    // --- draw: scene into the low-res buffer, then upscale ---
    this.renderer.setRenderTarget(this.rt);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.postScene, this.postCamera);
    void THREE;
  }

  /**
   * Translucent pads showing where a shift-click would drop farms.
   * `farmPreview` is a list of { tx, ty, size, reuse } set by the input layer.
   * Green = a new plot will be built, blue = an existing idle plot reused.
   */
  _updateFarmPreview() {
    const THREE = this.THREE;
    const list = this.farmPreview;
    if (!this._previewPads) this._previewPads = [];
    const need = list ? list.length : 0;

    while (this._previewPads.length < need) {
      const pad = new THREE.Mesh(
        new THREE.BoxGeometry(1, 0.22, 1),
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.42, depthWrite: false }),
      );
      pad.renderOrder = 4;
      this.scene.add(pad);
      this._previewPads.push(pad);
    }
    for (let i = 0; i < this._previewPads.length; i++) {
      const pad = this._previewPads[i];
      if (i >= need) { pad.visible = false; continue; }
      const p = list[i];
      pad.visible = true;
      pad.scale.set(p.size, 0.22, p.size);
      pad.position.set(p.tx + p.size / 2, this.heightAt(p.tx, p.ty) + 0.14, p.ty + p.size / 2);
      pad.material.color.setHex(p.reuse ? 0x54b8ff : 0x7cff7c);
    }
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
