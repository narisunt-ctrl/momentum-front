/*
 * Momentum Front — game runtime (Three.js r128)
 * Original implementation by Narisan Nakakes, 2026. MIT License.
 * Gameplay inspired by the Unity "Tanks!" tutorial (local multiplayer tank duel),
 * rebuilt from scratch with new rules: always-moving tanks, real ballistics,
 * armour angles, and an AI fire-control computer (see js/fcs.js).
 */
(function () {
  'use strict';
  const T3 = THREE;
  const F = window.FCS;

  /* ================================================================ */
  /* Utilities                                                         */
  /* ================================================================ */
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const angDiff = (a, b) => { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
  const rnd = (a, b) => a + Math.random() * (b - a);
  const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  function seeded(seed) { let s = seed >>> 0 || 1; return () => ((s = Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9 >>> 0) / 4294967296); }
  const DEG = 180 / Math.PI;

  const HALF = 175;                       // map half-size (m)
  const GEARS = { '-1': -6.2, '1': 6.8, '2': 10.8, '3': 14.8 };
  const GEAR_ORDER = [-1, 1, 2, 3];
  const TRAVERSE = 0.78, ELEV = 0.22, PITCH_MIN = -0.14, PITCH_MAX = 0.36;
  const MAX_HP = 100;
  const COLORS = [0x4f8cff, 0xff5a4f, 0x47d18c, 0xffc23d, 0xb26bff, 0x35d6e0, 0xff8bd0, 0xd7dde5];
  const TEAM_COLORS = [0x4f8cff, 0xff5a4f];

  /* ================================================================ */
  /* Settings / DOM                                                    */
  /* ================================================================ */
  const $ = (id) => document.getElementById(id);
  const settings = {
    humans: 1, bots: 3, mode: 'ffa', fcs: 'auto', diff: 'normal', rounds: 3,
    inputs: ['kb1', 'kb2', 'gp0', 'gp1'], seed: 0,
  };

  /* ================================================================ */
  /* Audio (synthesised, no assets)                                    */
  /* ================================================================ */
  const Audio = {
    ctx: null, master: null, engine: null, engineGain: null,
    init() {
      if (this.ctx) return;
      try {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.master = this.ctx.createGain(); this.master.gain.value = 0.55; this.master.connect(this.ctx.destination);
        const o = this.ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 40;
        const f = this.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 220;
        this.engineGain = this.ctx.createGain(); this.engineGain.gain.value = 0;
        o.connect(f); f.connect(this.engineGain); this.engineGain.connect(this.master); o.start();
        this.engine = o;
        const len = this.ctx.sampleRate * 1.5; const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const d = buf.getChannelData(0); for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        this.noise = buf;
      } catch (e) { this.ctx = null; }
    },
    burst(vol, freq, dur, q) {
      if (!this.ctx || vol < 0.01) return;
      const t = this.ctx.currentTime;
      const s = this.ctx.createBufferSource(); s.buffer = this.noise;
      const f = this.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.setValueAtTime(freq, t); f.frequency.exponentialRampToValueAtTime(60, t + dur); f.Q.value = q || 0.7;
      const g = this.ctx.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      s.connect(f); f.connect(g); g.connect(this.master); s.start(t); s.stop(t + dur + 0.05);
    },
    tone(vol, f0, f1, dur, type) {
      if (!this.ctx || vol < 0.01) return;
      const t = this.ctx.currentTime;
      const o = this.ctx.createOscillator(); o.type = type || 'sine';
      o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur);
      const g = this.ctx.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g); g.connect(this.master); o.start(t); o.stop(t + dur + 0.05);
    },
    vol(pos) { // distance attenuation to nearest human
      let d = 1e9;
      for (const t of game.tanks) if (t.human && !t.remote && t.alive) d = Math.min(d, Math.hypot(t.x - pos.x, t.z - pos.z));
      if (d === 1e9) d = 60;
      return clamp(1 - d / 320, 0, 1) ** 1.6;
    },
    shot(pos) { const v = this.vol(pos); this.burst(0.9 * v, 1800, 0.7); this.tone(0.4 * v, 120, 40, 0.35, 'triangle'); },
    boom(pos, big) { const v = this.vol(pos); this.burst((big ? 1.2 : 0.7) * v, big ? 900 : 1400, big ? 1.4 : 0.8); },
    ping(pos) { const v = this.vol(pos); this.tone(0.35 * v, 2400, 900, 0.25, 'square'); },
    clang(pos) { const v = this.vol(pos); this.tone(0.45 * v, 520, 180, 0.3, 'square'); this.burst(0.4 * v, 3000, 0.2); },
    beep(f) { this.tone(0.12, f, f, 0.08, 'square'); },
  };

  /* ================================================================ */
  /* Input                                                             */
  /* ================================================================ */
  const keys = new Set(), pressed = new Set();
  window.addEventListener('keydown', (e) => {
    if (!keys.has(e.code)) pressed.add(e.code);
    keys.add(e.code);
    if (game.state !== 'menu' && ['Space', 'ArrowUp', 'ArrowDown', 'Tab', 'Enter', 'ShiftLeft', 'ShiftRight', 'Slash', 'Quote'].includes(e.code)) e.preventDefault();
    if (e.code === 'Escape' && game.state !== 'menu') togglePause();
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener('blur', () => keys.clear());

  const mouse = { dx: 0, dy: 0, left: false, right: false, leftPressed: false, rightPressed: false, wheel: 0, locked: false };
  document.addEventListener('mousemove', (e) => { if (mouse.locked) { mouse.dx += e.movementX; mouse.dy += e.movementY; } });
  document.addEventListener('mousedown', (e) => {
    if (!mouse.locked) return;
    if (e.button === 0) { mouse.left = true; mouse.leftPressed = true; }
    if (e.button === 2) { mouse.right = true; mouse.rightPressed = true; }
  });
  document.addEventListener('mouseup', (e) => { if (e.button === 0) mouse.left = false; if (e.button === 2) mouse.right = false; });
  document.addEventListener('wheel', (e) => { if (mouse.locked) mouse.wheel += Math.sign(e.deltaY); }, { passive: true });
  document.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('pointerlockchange', () => { mouse.locked = document.pointerLockElement === renderer.domElement; });

  const KB = {
    kb1: { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD', tl: 'KeyQ', tr: 'KeyE', eu: 'KeyR', ed: 'KeyF', fire: 'Space', lock: 'ShiftLeft', next: 'KeyC', ammo: 'KeyX', smoke: 'KeyV', sight: 'KeyZ' },
    kb2: { up: 'KeyI', down: 'KeyK', left: 'KeyJ', right: 'KeyL', tl: 'KeyU', tr: 'KeyO', eu: 'KeyY', ed: 'KeyH', fire: 'Enter', lock: 'ShiftRight', next: 'KeyP', ammo: 'Period', smoke: 'Slash', sight: 'Semicolon' },
  };
  const padPrev = {};
  function readController(tank) {
    const c = { gearUp: false, gearDown: false, steer: 0, trav: 0, elev: 0, fire: false, lock: false, next: false, ammo: false, smoke: false, sight: false, mouse: false };
    const src = tank.input;
    if (src && src.startsWith('net:')) return game.net && game.net.remoteCtl ? game.net.remoteCtl(src.slice(4)) : c;
    if (src === 'kb1' || src === 'kb2') {
      const m = KB[src];
      c.gearUp = pressed.has(m.up); c.gearDown = pressed.has(m.down);
      c.steer = (keys.has(m.right) ? 1 : 0) - (keys.has(m.left) ? 1 : 0);
      c.trav = (keys.has(m.tr) ? 1 : 0) - (keys.has(m.tl) ? 1 : 0);
      c.elev = (keys.has(m.eu) ? 1 : 0) - (keys.has(m.ed) ? 1 : 0);
      c.fire = pressed.has(m.fire); c.lock = keys.has(m.lock); c.next = pressed.has(m.next);
      c.ammo = pressed.has(m.ammo); c.smoke = pressed.has(m.smoke); c.sight = pressed.has(m.sight);
      if (src === 'kb1' && mouse.locked) {
        c.mouse = true; c.mdx = mouse.dx; c.mdy = mouse.dy;
        c.fire = c.fire || mouse.leftPressed; c.lock = c.lock || mouse.right;
        if (mouse.wheel) c.ammo = true;
      }
    } else if (src && src.startsWith('gp')) {
      const idx = +src.slice(2);
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      const gp = pads[idx];
      if (gp) {
        const ax = (i) => { const v = gp.axes[i] || 0; return Math.abs(v) < 0.15 ? 0 : v; };
        const b = (i) => !!(gp.buttons[i] && gp.buttons[i].pressed);
        const prev = padPrev[idx] || {};
        const edge = (name, v) => { const r = v && !prev[name]; prev[name] = v; return r; };
        const y = ax(1);
        c.gearUp = edge('gu', y < -0.6 || b(12)); c.gearDown = edge('gd', y > 0.6 || b(13));
        c.steer = ax(0) || ((b(15) ? 1 : 0) - (b(14) ? 1 : 0));
        c.trav = ax(2); c.elev = -ax(3);
        c.fire = edge('fire', b(7) || b(0)); c.lock = b(6);
        c.next = edge('next', b(5)); c.ammo = edge('ammo', b(2)); c.smoke = edge('smoke', b(1)); c.sight = edge('sight', b(3));
        padPrev[idx] = prev;
      }
    }
    return c;
  }

  /* ================================================================ */
  /* Renderer & scene                                                  */
  /* ================================================================ */
  const renderer = new T3.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = T3.PCFSoftShadowMap;
  renderer.domElement.id = 'gl';
  document.body.appendChild(renderer.domElement);
  renderer.domElement.addEventListener('click', () => {
    if (game.state === 'play' || game.state === 'countdown') {
      const p1 = game.tanks.find((t) => t.human && t.input === 'kb1');
      if (p1 && renderer.domElement.requestPointerLock) renderer.domElement.requestPointerLock();
    }
  });

  const hud = $('hud'), hctx = hud.getContext('2d');
  function resize() {
    renderer.setSize(window.innerWidth, window.innerHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    hud.width = window.innerWidth * dpr; hud.height = window.innerHeight * dpr;
    hud.style.width = window.innerWidth + 'px'; hud.style.height = window.innerHeight + 'px';
    hctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', resize);

  const scene = new T3.Scene();
  scene.background = new T3.Color(0x9fb3c2);
  scene.fog = new T3.Fog(0x9fb3c2, 160, 520);
  const hemi = new T3.HemisphereLight(0xdbe8ff, 0x51462f, 0.75); scene.add(hemi);
  const sun = new T3.DirectionalLight(0xfff0d6, 1.0);
  sun.position.set(-120, 200, 80); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera; sc.left = -HALF; sc.right = HALF; sc.top = HALF; sc.bottom = -HALF; sc.near = 10; sc.far = 520;
  sun.shadow.bias = -0.0008;
  scene.add(sun);

  /* ---------------- Terrain ---------------- */
  let heightSeed = { a: 0, b: 0, c: 0 };
  function heightAt(x, z) {
    const s = heightSeed;
    let h = 5.2 * Math.sin(x * 0.017 + s.a) * Math.cos(z * 0.0145 + s.b)
      + 2.6 * Math.sin(x * 0.047 + s.c) * Math.sin(z * 0.041 + s.a * 0.7)
      + 1.1 * Math.sin((x + z) * 0.09 + s.b);
    // embankments near the edge
    const e = Math.max(Math.abs(x), Math.abs(z));
    if (e > HALF - 20) h += ((e - (HALF - 20)) / 20) ** 2 * 10;
    return h;
  }
  let terrainMesh = null;
  function buildTerrain() {
    if (terrainMesh) { scene.remove(terrainMesh); terrainMesh.geometry.dispose(); }
    const size = HALF * 2 + 60, seg = 150;
    const g = new T3.PlaneGeometry(size, size, seg, seg);
    g.rotateX(-Math.PI / 2);
    const pos = g.attributes.position;
    const col = new Float32Array(pos.count * 3);
    const cA = new T3.Color(0x5d7340), cB = new T3.Color(0x8a7a52), cC = new T3.Color(0x4a5a34), tmp = new T3.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const h = heightAt(x, z);
      pos.setY(i, h);
      const n = (Math.sin(x * 0.31) * Math.cos(z * 0.27) + 1) * 0.5;
      tmp.copy(cA).lerp(cB, clamp((h + 4) / 14, 0, 1) * 0.8).lerp(cC, n * 0.35);
      col[i * 3] = tmp.r; col[i * 3 + 1] = tmp.g; col[i * 3 + 2] = tmp.b;
    }
    g.setAttribute('color', new T3.BufferAttribute(col, 3));
    g.computeVertexNormals();
    terrainMesh = new T3.Mesh(g, new T3.MeshLambertMaterial({ vertexColors: true }));
    terrainMesh.receiveShadow = true;
    scene.add(terrainMesh);
  }

  /* ---------------- Particles ---------------- */
  class Particles {
    constructor(max, additive) {
      this.max = max; this.n = 0;
      this.p = new Float32Array(max * 3); this.c = new Float32Array(max * 4); this.s = new Float32Array(max);
      this.data = [];
      const g = new T3.BufferGeometry();
      this.pa = new T3.BufferAttribute(this.p, 3); this.pa.setUsage(T3.DynamicDrawUsage);
      this.ca = new T3.BufferAttribute(this.c, 4); this.ca.setUsage(T3.DynamicDrawUsage);
      this.sa = new T3.BufferAttribute(this.s, 1); this.sa.setUsage(T3.DynamicDrawUsage);
      g.setAttribute('position', this.pa); g.setAttribute('pcolor', this.ca); g.setAttribute('size', this.sa);
      this.mat = new T3.ShaderMaterial({
        uniforms: { scale: { value: 600 } },
        vertexShader: 'attribute float size; attribute vec4 pcolor; varying vec4 vC; uniform float scale; void main(){ vC=pcolor; vec4 mv=modelViewMatrix*vec4(position,1.0); gl_PointSize=size*scale/max(0.5,-mv.z); gl_Position=projectionMatrix*mv; }',
        fragmentShader: 'varying vec4 vC; void main(){ vec2 d=gl_PointCoord-0.5; float r=length(d); if(r>0.5) discard; float a=vC.a*smoothstep(0.5,0.05,r); gl_FragColor=vec4(vC.rgb,a); }',
        transparent: true, depthWrite: false,
        blending: additive ? T3.AdditiveBlending : T3.NormalBlending,
      });
      this.points = new T3.Points(g, this.mat); this.points.frustumCulled = false;
      g.setDrawRange(0, 0);
      scene.add(this.points);
    }
    emit(o) {
      if (this.data.length >= this.max) this.data.shift();
      this.data.push({
        x: o.x, y: o.y, z: o.z, vx: o.vx || 0, vy: o.vy || 0, vz: o.vz || 0,
        life: 0, max: o.life || 1, s0: o.s0 || 1, s1: o.s1 === undefined ? o.s0 || 1 : o.s1,
        c0: o.c0, c1: o.c1 || o.c0, a0: o.a0 === undefined ? 1 : o.a0, a1: o.a1 === undefined ? 0 : o.a1,
        drag: o.drag || 0, grav: o.grav || 0,
      });
    }
    update(dt) {
      const d = this.data; let w = 0;
      for (let i = 0; i < d.length; i++) {
        const q = d[i]; q.life += dt;
        if (q.life >= q.max) continue;
        const k = Math.max(0, 1 - q.drag * dt);
        q.vx *= k; q.vy = q.vy * k - q.grav * dt; q.vz *= k;
        q.x += q.vx * dt; q.y += q.vy * dt; q.z += q.vz * dt;
        d[w++] = q;
      }
      d.length = w;
      for (let i = 0; i < w; i++) {
        const q = d[i], t = q.life / q.max;
        this.p[i * 3] = q.x; this.p[i * 3 + 1] = q.y; this.p[i * 3 + 2] = q.z;
        this.c[i * 4] = lerp(q.c0[0], q.c1[0], t); this.c[i * 4 + 1] = lerp(q.c0[1], q.c1[1], t); this.c[i * 4 + 2] = lerp(q.c0[2], q.c1[2], t);
        this.c[i * 4 + 3] = lerp(q.a0, q.a1, t);
        this.s[i] = lerp(q.s0, q.s1, t);
      }
      this.points.geometry.setDrawRange(0, w);
      this.pa.needsUpdate = this.ca.needsUpdate = this.sa.needsUpdate = true;
    }
    clear() { this.data.length = 0; this.points.geometry.setDrawRange(0, 0); }
  }
  const fxAdd = new Particles(4000, true);
  const fxSmoke = new Particles(3500, false);
  fxSmoke.points.renderOrder = 1; fxAdd.points.renderOrder = 2;

  const FX = {
    explosion(x, y, z, size) {
      for (let i = 0; i < 26 * size; i++) fxAdd.emit({ x, y: y + 0.5, z, vx: rnd(-1, 1) * 9 * size, vy: rnd(1, 9) * size, vz: rnd(-1, 1) * 9 * size, life: rnd(0.25, 0.6), s0: rnd(2, 4) * size, s1: 0.5, c0: [1, 0.85, 0.4], c1: [1, 0.25, 0.05], drag: 3 });
      for (let i = 0; i < 18 * size; i++) fxSmoke.emit({ x: x + rnd(-1, 1), y: y + 0.6, z: z + rnd(-1, 1), vx: rnd(-1, 1) * 4 * size, vy: rnd(1.5, 5) * size, vz: rnd(-1, 1) * 4 * size, life: rnd(1.6, 3.4), s0: 2.5 * size, s1: 7 * size, c0: [0.25, 0.22, 0.2], c1: [0.55, 0.53, 0.5], a0: 0.75, a1: 0, drag: 1.2 });
      for (let i = 0; i < 14 * size; i++) fxSmoke.emit({ x, y: y + 0.3, z, vx: rnd(-1, 1) * 11, vy: rnd(4, 14), vz: rnd(-1, 1) * 11, life: rnd(0.8, 1.4), s0: 0.6, s1: 0.4, c0: [0.32, 0.27, 0.2], a0: 1, a1: 0.6, grav: 22 });
    },
    muzzle(x, y, z, dx, dz) {
      for (let i = 0; i < 14; i++) fxAdd.emit({ x, y, z, vx: dx * rnd(8, 30) + rnd(-3, 3), vy: rnd(-1, 3), vz: dz * rnd(8, 30) + rnd(-3, 3), life: rnd(0.08, 0.2), s0: rnd(1.5, 3), s1: 0.3, c0: [1, 0.9, 0.5], c1: [1, 0.4, 0.1], drag: 6 });
      for (let i = 0; i < 12; i++) fxSmoke.emit({ x, y, z, vx: dx * rnd(3, 12) + rnd(-2, 2), vy: rnd(0.5, 2), vz: dz * rnd(3, 12) + rnd(-2, 2), life: rnd(1, 2), s0: 1.5, s1: 5, c0: [0.7, 0.68, 0.64], a0: 0.5, a1: 0, drag: 2.2 });
    },
    sparks(x, y, z) {
      for (let i = 0; i < 18; i++) fxAdd.emit({ x, y, z, vx: rnd(-12, 12), vy: rnd(2, 10), vz: rnd(-12, 12), life: rnd(0.2, 0.5), s0: 0.6, s1: 0.1, c0: [1, 0.95, 0.7], c1: [1, 0.5, 0.1], grav: 18 });
    },
    dust(x, y, z, amount) {
      fxSmoke.emit({ x: x + rnd(-1, 1), y: y + 0.4, z: z + rnd(-1, 1), vx: rnd(-0.6, 0.6), vy: rnd(0.3, 1.2), vz: rnd(-0.6, 0.6), life: rnd(0.8, 1.6), s0: 1.2, s1: 3.2 * amount, c0: [0.55, 0.48, 0.36], a0: 0.35 * amount, a1: 0, drag: 0.8 });
    },
    trail(x, y, z, c) {
      fxAdd.emit({ x, y, z, life: 0.22, s0: 0.55, s1: 0.1, c0: c, c1: [1, 0.3, 0.05], a0: 0.9, a1: 0 });
    },
    smokeScreen(x, z) {
      for (let i = 0; i < 60; i++) {
        const a = Math.random() * Math.PI * 2, r = Math.random() * 9;
        const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
        fxSmoke.emit({ x: px, y: heightAt(px, pz) + rnd(0.5, 5), z: pz, vx: Math.cos(a) * rnd(0.5, 3), vy: rnd(0.1, 0.6), vz: Math.sin(a) * rnd(0.5, 3), life: rnd(10, 14), s0: 5, s1: 13, c0: [0.86, 0.87, 0.88], c1: [0.7, 0.72, 0.74], a0: 0.85, a1: 0, drag: 0.6 });
      }
    },
    fire(x, y, z) {
      fxAdd.emit({ x: x + rnd(-1, 1), y: y + rnd(0.5, 1.5), z: z + rnd(-1, 1), vy: rnd(1, 3), life: rnd(0.3, 0.7), s0: rnd(1, 2), s1: 0.2, c0: [1, 0.6, 0.15], c1: [0.8, 0.1, 0] });
      if (Math.random() < 0.5) fxSmoke.emit({ x, y: y + 2, z, vx: rnd(-0.5, 0.5), vy: rnd(2, 4), vz: rnd(-0.5, 0.5), life: rnd(2, 4), s0: 2, s1: 8, c0: [0.12, 0.11, 0.1], c1: [0.35, 0.34, 0.33], a0: 0.6, a1: 0, drag: 0.4 });
    },
  };

  /* ---------------- Network event capture ----------------
   * On an online host, visual/audio one-shots are recorded and replayed
   * on clients. FXraw is the unrecorded version for per-frame visuals. */
  const NET_EV = [];
  const FXraw = Object.assign({}, FX);
  for (const k of ['explosion', 'muzzle', 'sparks', 'smokeScreen']) {
    FX[k] = (...a) => { if (game.net && game.net.role === 'host' && game.net.started) NET_EV.push(['fx', k, a.map((v) => Math.round(v * 100) / 100)]); return FXraw[k](...a); };
  }
  const AudioRaw = {};
  for (const k of ['shot', 'boom', 'ping', 'clang']) {
    AudioRaw[k] = Audio[k].bind(Audio);
    Audio[k] = (pos, big) => { if (game.net && game.net.role === 'host' && game.net.started) NET_EV.push(['au', k, [Math.round(pos.x), Math.round(pos.z), big ? 1 : 0]]); return AudioRaw[k](pos, big); };
  }

  /* ---------------- Materials ---------------- */
  const MAT = {
    dark: new T3.MeshLambertMaterial({ color: 0x26282b }),
    metal: new T3.MeshLambertMaterial({ color: 0x4b4f55 }),
    wreck: new T3.MeshLambertMaterial({ color: 0x1e1c1a }),
  };

  /* ================================================================ */
  /* World objects                                                     */
  /* ================================================================ */
  const world = { obstacles: [], trees: null, smokes: [], crates: [], wrecks: [], zone: null, decor: [] };

  function clearWorld() {
    for (const o of world.obstacles) scene.remove(o.mesh);
    for (const c of world.crates) scene.remove(c.mesh);
    for (const d of world.decor) scene.remove(d);
    if (world.trees) scene.remove(world.trees);
    world.obstacles = []; world.crates = []; world.smokes = []; world.wrecks = []; world.decor = [];
    fxAdd.clear(); fxSmoke.clear();
  }

  function buildWorld(seed) {
    clearWorld();
    const r = seeded(seed);
    heightSeed = { a: r() * 6, b: r() * 6, c: r() * 6 };
    buildTerrain();
    const bMats = [0x9a8f7c, 0x8c7d6a, 0xa59c8a, 0x7a7266].map((c) => new T3.MeshLambertMaterial({ color: c }));
    let tries = 0;
    while (world.obstacles.length < 26 && tries++ < 400) {
      const x = (r() * 2 - 1) * (HALF - 30), z = (r() * 2 - 1) * (HALF - 30);
      if (Math.hypot(x, z) > 118 && Math.hypot(x, z) < 160) continue; // keep spawn ring clear
      const w = 7 + r() * 12, d = 7 + r() * 12, h = 5 + r() * 8;
      if (world.obstacles.some((o) => Math.abs(o.x - x) < (o.w + w) / 2 + 10 && Math.abs(o.z - z) < (o.d + d) / 2 + 10)) continue;
      const gy = Math.min(heightAt(x - w / 2, z - d / 2), heightAt(x + w / 2, z + d / 2), heightAt(x, z)) - 1;
      const mat = bMats[(r() * bMats.length) | 0].clone();
      const mesh = new T3.Mesh(new T3.BoxGeometry(w, h + 1, d), mat);
      mesh.position.set(x, gy + (h + 1) / 2, z); mesh.castShadow = mesh.receiveShadow = true;
      // windows strip
      const strip = new T3.Mesh(new T3.BoxGeometry(w + 0.1, 0.8, d + 0.1), MAT.dark);
      strip.position.y = (h + 1) * 0.15; mesh.add(strip);
      scene.add(mesh);
      world.obstacles.push({ x, z, w, d, h, base: gy, top: gy + h + 1, mesh, hp: 100, alive: true, mat });
    }
    // trees (decor; soft cover — they don't block the FCS)
    const nT = 140;
    const tg = new T3.ConeGeometry(1.6, 6, 6); tg.translate(0, 3.5, 0);
    const trees = new T3.InstancedMesh(tg, new T3.MeshLambertMaterial({ color: 0x3d5a2e }), nT);
    const m4 = new T3.Matrix4(), q = new T3.Quaternion(), s = new T3.Vector3(), p = new T3.Vector3();
    let n = 0;
    for (let i = 0; i < nT * 3 && n < nT; i++) {
      const x = (r() * 2 - 1) * (HALF - 8), z = (r() * 2 - 1) * (HALF - 8);
      if (world.obstacles.some((o) => Math.abs(o.x - x) < o.w / 2 + 3 && Math.abs(o.z - z) < o.d / 2 + 3)) continue;
      if (Math.hypot(x, z) > 125 && Math.hypot(x, z) < 155) continue;
      const k = 0.7 + r() * 0.8;
      p.set(x, heightAt(x, z) - 0.3, z); s.set(k, k * (0.9 + r() * 0.5), k);
      m4.compose(p, q, s); trees.setMatrixAt(n++, m4);
    }
    trees.count = n; trees.castShadow = true;
    scene.add(trees); world.trees = trees;
    // safe zone wall
    const zg = new T3.CylinderGeometry(1, 1, 60, 96, 1, true);
    const zm = new T3.MeshBasicMaterial({ color: 0xff3b2f, transparent: true, opacity: 0.16, side: T3.DoubleSide, depthWrite: false });
    const zone = new T3.Mesh(zg, zm); zone.position.y = 10; zone.renderOrder = 3;
    scene.add(zone); world.decor.push(zone);
    world.zone = { mesh: zone, x: 0, z: 0, r: 210, tx: 0, tz: 0 };
  }

  /* ---------------- Line of sight ---------------- */
  function segBox(ax, ay, az, bx, by, bz, o) {
    // slab test against obstacle AABB
    let t0 = 0, t1 = 1;
    const d = [bx - ax, by - ay, bz - az], a = [ax, ay, az];
    const mn = [o.x - o.w / 2, o.base, o.z - o.d / 2], mx = [o.x + o.w / 2, o.alive ? o.top : o.base + 2.2, o.z + o.d / 2];
    for (let i = 0; i < 3; i++) {
      if (Math.abs(d[i]) < 1e-9) { if (a[i] < mn[i] || a[i] > mx[i]) return false; continue; }
      let u0 = (mn[i] - a[i]) / d[i], u1 = (mx[i] - a[i]) / d[i];
      if (u0 > u1) { const t = u0; u0 = u1; u1 = t; }
      t0 = Math.max(t0, u0); t1 = Math.min(t1, u1);
      if (t0 > t1) return false;
    }
    return true;
  }
  function lineOfSight(a, b, ignoreSmoke) {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const L = Math.hypot(dx, dz);
    const n = Math.ceil(L / 5);
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const x = a.x + dx * t, y = a.y + dy * t, z = a.z + dz * t;
      if (heightAt(x, z) > y) return false;
    }
    for (const o of world.obstacles) if (segBox(a.x, a.y, a.z, b.x, b.y, b.z, o)) return false;
    if (!ignoreSmoke) {
      for (const s of world.smokes) {
        // distance from cloud centre to segment (horizontal)
        const t = clamp(((s.x - a.x) * dx + (s.z - a.z) * dz) / (L * L || 1), 0, 1);
        const px = a.x + dx * t, pz = a.z + dz * t;
        if (Math.hypot(px - s.x, pz - s.z) < s.r) return false;
      }
    }
    return true;
  }

  /* ================================================================ */
  /* Tank                                                              */
  /* ================================================================ */
  function buildTankMesh(color) {
    const root = new T3.Group();
    const hullG = new T3.Group(); root.add(hullG);
    const body = new T3.MeshLambertMaterial({ color });
    const bodyDark = new T3.MeshLambertMaterial({ color: new T3.Color(color).multiplyScalar(0.62) });
    const add = (parent, geo, mat, x, y, z, cast) => { const m = new T3.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = cast !== false; m.receiveShadow = true; parent.add(m); return m; };
    add(hullG, new T3.BoxGeometry(2.6, 0.9, 6.0), bodyDark, 0, 0.95, 0);
    add(hullG, new T3.BoxGeometry(3.3, 0.55, 5.4), body, 0, 1.62, -0.1);
    const glacis = add(hullG, new T3.BoxGeometry(3.2, 0.5, 1.6), body, 0, 1.35, 2.75); glacis.rotation.x = 0.55;
    const rearPlate = add(hullG, new T3.BoxGeometry(3.1, 0.5, 0.9), bodyDark, 0, 1.4, -3.0); rearPlate.rotation.x = -0.35;
    for (const sx of [-1, 1]) {
      add(hullG, new T3.BoxGeometry(0.85, 1.05, 6.6), MAT.dark, sx * 1.55, 0.62, 0);
      for (let i = 0; i < 6; i++) { const w = add(hullG, new T3.CylinderGeometry(0.42, 0.42, 0.9, 10), MAT.metal, sx * 1.6, 0.48, -2.5 + i * 1.0, false); w.rotation.z = Math.PI / 2; }
      add(hullG, new T3.BoxGeometry(0.7, 0.12, 6.4), bodyDark, sx * 1.55, 1.25, 0);
    }
    // turret (stabilised, attached to root so it does not tilt with hull)
    const turret = new T3.Group(); turret.position.set(0, 2.15, -0.25); root.add(turret);
    add(turret, new T3.BoxGeometry(2.5, 0.85, 3.0), body, 0, 0.35, -0.1);
    const front = add(turret, new T3.CylinderGeometry(1.25, 1.25, 0.85, 14, 1, false, -Math.PI / 2, Math.PI), body, 0, 0.35, 1.4); front.rotation.y = 0;
    add(turret, new T3.BoxGeometry(2.0, 0.6, 1.0), bodyDark, 0, 0.4, -1.9);
    add(turret, new T3.CylinderGeometry(0.42, 0.45, 0.35, 10), bodyDark, 0.6, 0.92, -0.4);
    const barrelPivot = new T3.Group(); barrelPivot.position.set(0, 0.38, 1.5); turret.add(barrelPivot);
    const mantlet = add(barrelPivot, new T3.BoxGeometry(0.9, 0.6, 0.6), bodyDark, 0, 0, 0.1);
    const barrel = new T3.Group(); barrelPivot.add(barrel);
    const tube = add(barrel, new T3.CylinderGeometry(0.15, 0.19, 4.4, 10), MAT.metal, 0, 0, 2.5); tube.rotation.x = Math.PI / 2;
    const brake = add(barrel, new T3.CylinderGeometry(0.26, 0.26, 0.5, 10), MAT.dark, 0, 0, 4.6); brake.rotation.x = Math.PI / 2;
    void mantlet;
    return { root, hullG, turret, barrelPivot, barrel, body, bodyDark };
  }

  let tankUid = 0;
  class Tank {
    constructor(opt) {
      this.id = tankUid++;
      this.name = opt.name; this.team = opt.team; this.color = opt.color;
      this.human = !!opt.human; this.input = opt.input || null; this.slot = opt.slot;
      this.skill = opt.skill || 0.6;
      this.mesh = buildTankMesh(opt.color);
      scene.add(this.mesh.root);
      this.wins = 0;
      this.stats = { shots: 0, hits: 0, dmg: 0, kills: 0 };
      this.trackers = new Map();
    }
    spawn(x, z, yaw) {
      this.x = x; this.z = z; this.y = heightAt(x, z);
      this.yaw = yaw; this.speed = 0; this.gear = 2;
      this.kx = 0; this.kz = 0;
      this.turYaw = yaw; this.pitch = 0.02; this.cmdYaw = yaw; this.cmdPitch = 0.02;
      this.hp = MAX_HP; this.alive = true;
      this.reload = 1.5; this.ammo = 'AP'; this.smoke = 2;
      this.trackDmg = 0; this.turretDmg = 0; this.radar = 0;
      this.target = null; this.lockLost = 0;
      this.sol = null; this.pk = 0; this.solTimer = 0; this.pkTimer = 0; this.masked = false;
      this.warn = 0; this.sight = false; this.recoil = 0; this.shake = 0; this.hitFlash = 0;
      this.impact = null; this.impTimer = 0;
      this.trackers.clear();
      this.bot = { t: 0, jinkT: 0, jink: 0, jinkDir: 1, orbit: Math.random() < 0.5 ? -1 : 1, aimErrYaw: 0, aimErrPitch: 0, errT: 0, acquire: 0, stuck: 0, reverseT: 0, desired: yaw, lastShot: 0 };
      this.mesh.root.visible = true;
      this.mesh.body.color.setHex(this.color);
      this.mesh.turret.position.set(0, 2.15, -0.25); this.mesh.turret.rotation.set(0, 0, 0);
      if (this.mesh.turret.parent !== this.mesh.root) this.mesh.root.add(this.mesh.turret);
      this.mesh.root.traverse((o) => { if (o.material === MAT.wreck && o.userData.orig) o.material = o.userData.orig; });
      this.fly = null;
      this.lastHitBy = null;
    }
    get fwd() { return { x: Math.sin(this.yaw), z: Math.cos(this.yaw) }; }
    get vel() { return { x: Math.sin(this.yaw) * this.speed + this.kx, z: Math.cos(this.yaw) * this.speed + this.kz }; }
    pivot() { return { x: this.x, y: this.y + 2.55, z: this.z }; }
    muzzle() {
      const p = this.pivot(), c = Math.cos(this.pitch);
      return { x: p.x + Math.sin(this.turYaw) * c * 4.8, y: p.y + Math.sin(this.pitch) * 4.8, z: p.z + Math.cos(this.turYaw) * c * 4.8 };
    }
    center() { return { x: this.x, y: this.y + 1.6, z: this.z }; }
  }

  /* ================================================================ */
  /* Game state                                                        */
  /* ================================================================ */
  const game = {
    state: 'menu', tanks: [], shells: [], time: 0, roundTime: 0, round: 0, countdown: 0,
    wind: { x: 0, z: 0 }, windT: { x: 0, z: 0 }, feed: [], paused: false, msg: '', msgT: 0, crateT: 0, artyT: 0, winner: null,
    views: [],
  };
  window.__game = game; // debug/testing hook

  function makeTanks(noRemote) {
    for (const t of game.tanks) { scene.remove(t.mesh.root); scene.remove(t.mesh.turret); }
    game.tanks = []; tankUid = 0;
    const remote = noRemote ? [] : (game.net && game.net.role === 'host' ? game.net.players() : []);
    const L = settings.humans, H = L + remote.length, B = settings.bots;
    const skill = { easy: 0.35, normal: 0.62, hard: 0.85, ace: 1.0 }[settings.diff] || 0.62;
    const total = H + B;
    for (let i = 0; i < total; i++) {
      const human = i < H;
      let team;
      if (settings.mode === 'ffa') team = i;
      else if (settings.mode === 'coop') team = human ? 0 : 1;
      else team = i % 2;
      const color = settings.mode === 'ffa' ? COLORS[i % COLORS.length] : TEAM_COLORS[team];
      const rp = human && i >= L ? remote[i - L] : null;
      const callsign = ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA', 'ECHO', 'FOXTROT', 'GOLF', 'HOTEL'][i - H] || String(i);
      const driver = human ? null : settings.botDriver === 'rl' ? 'rl' : settings.botDriver === 'mix' ? ((i - H) % 2 ? 'script' : 'rl') : 'script';
      const useRL = driver === 'rl' && window.RLPolicy && window.RLWeights;
      const name = rp ? rp.name : human ? `P${i + 1}` : `${useRL ? 'NN' : 'BOT'}-${callsign}`;
      const t = new Tank({ name, team, color, human, input: rp ? 'net:' + rp.id : human ? settings.inputs[i] : null, slot: human ? i : -1, skill: human ? 0 : skill * rnd(0.85, 1.1) });
      t.remote = !!rp; t.connId = rp ? rp.id : null; t.driver = useRL ? 'rl' : 'script';
      game.tanks.push(t);
    }
  }

  function startRound() {
    game.round++;
    settings.seed = (Math.random() * 1e9) | 0;
    buildWorld(settings.seed);
    for (const s of game.shells) scene.remove(s.mesh);
    game.shells = [];
    const n = game.tanks.length;
    const off = Math.random() * Math.PI * 2;
    // order spawn so teams are interleaved/spread
    const order = game.tanks.slice().sort((a, b) => a.team - b.team || a.id - b.id);
    order.forEach((t, i) => {
      let a;
      if (settings.mode === 'ffa') a = off + (i / n) * Math.PI * 2;
      else { const tm = t.team, idx = order.filter((u) => u.team === tm).indexOf(t), cnt = order.filter((u) => u.team === tm).length; a = off + tm * Math.PI + (idx - (cnt - 1) / 2) * 0.32; }
      const x = Math.sin(a) * 140, z = Math.cos(a) * 140;
      t.spawn(x, z, Math.atan2(-x, -z));
    });
    const wa = Math.random() * Math.PI * 2, ws = rnd(1, 7.5);
    game.windT = { x: Math.sin(wa) * ws, z: Math.cos(wa) * ws }; game.wind = { ...game.windT };
    game.roundTime = 0; game.crateT = 12; game.artyT = 0; game.feed = [];
    game.countdown = 3.2; game.state = 'countdown'; game.winner = null;
    setupViews();
  }

  function setupViews() {
    const humans = game.net && game.net.role === 'client' ? game.tanks.filter((t) => t.id === game.net.you) : game.tanks.filter((t) => t.human && !t.remote);
    const W = window.innerWidth, Hh = window.innerHeight;
    const n = Math.max(1, humans.length);
    let rects;
    if (n === 1) rects = [[0, 0, 1, 1]];
    else if (n === 2) rects = W >= Hh ? [[0, 0, 0.5, 1], [0.5, 0, 0.5, 1]] : [[0, 0, 1, 0.5], [0, 0.5, 1, 0.5]];
    else rects = [[0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]];
    game.views = [];
    for (let i = 0; i < n; i++) {
      const cam = new T3.PerspectiveCamera(60, 1, 0.5, 900);
      game.views.push({ rect: rects[i], cam, tank: humans[i] || null, follow: null, camPos: null, fov: 60 });
    }
    renderer.shadowMap.enabled = n <= 2;
  }

  function aliveTeams() { const s = new Set(); for (const t of game.tanks) if (t.alive) s.add(t.team); return s; }
  function enemiesOf(t) { return game.tanks.filter((u) => u.alive && u.team !== t.team); }
  function feed(text, color) { game.feed.unshift({ text, color: color || '#fff', t: 6 }); if (game.feed.length > 6) game.feed.pop(); }
  function message(text, t, tank) { if (tank) { tank.msg = text; tank.msgT = t || 2.5; } else { game.msg = text; game.msgT = t || 2.5; } }

  /* ================================================================ */
  /* Sensors & FCS                                                     */
  /* ================================================================ */
  let sensorAcc = 0;
  function updateSensors(dt) {
    sensorAcc += dt;
    if (sensorAcc < 1 / 20) return;
    const sdt = sensorAcc; sensorAcc = 0;
    for (const t of game.tanks) {
      if (!t.alive) continue;
      const eye = { x: t.x, y: t.y + 3.1, z: t.z };
      for (const u of game.tanks) {
        if (u === t || !u.alive) { t.trackers.delete(u.id); continue; }
        let trk = t.trackers.get(u.id);
        if (!trk) { trk = new F.MotionTracker({ accelSigma: 3 }); trk.seen = false; t.trackers.set(u.id, trk); }
        const d = Math.hypot(u.x - t.x, u.z - t.z);
        const c = u.center();
        let vis = d < 330 && (t.radar > 0 || lineOfSight(eye, { x: c.x, y: c.y + 0.6, z: c.z }, false) || lineOfSight(eye, { x: c.x, y: c.y + 1.3, z: c.z }, false));
        if (u.team === t.team) vis = true; // friendly datalink
        if (vis) {
          const sig = 0.22 + d * 0.0024;
          trk.update(sdt, { x: u.x + gauss() * sig, z: u.z + gauss() * sig }, sig);
          trk.seen = true; trk.lastSeen = game.time;
        } else {
          trk.update(sdt, null, 1);
          if (trk.coast > 6) { trk.reset(); trk.seen = false; }
        }
      }
    }
  }
  function trackerOf(t, u) { const k = t.trackers.get(u.id); return k && k.ready ? k : null; }
  function visibleNow(t, u) { const k = t.trackers.get(u.id); return k && k.ready && k.coast < 0.15; }

  function fcsSolve(t) {
    if (!t.target || !t.target.alive) { t.sol = null; t.pk = 0; return; }
    const trk = trackerOf(t, t.target);
    if (!trk) { t.sol = null; t.pk = 0; return; }
    const ammo = F.AMMO[t.ammo];
    // muzzle estimate for the solved yaw (iterate once)
    const p = t.pivot();
    const est = trk.predict(0);
    const yaw0 = Math.atan2(est.x - p.x, est.z - p.z);
    const muzzle = { x: p.x + Math.sin(yaw0) * 4.8, y: p.y + 0.15, z: p.z + Math.cos(yaw0) * 4.8 };
    const sol = F.solveFiring({ muzzle, vel: t.vel }, trk, { ammo, wind: game.wind, targetHeight: 1.45, pitchMin: PITCH_MIN, pitchMax: PITCH_MAX, heightAt });
    t.sol = sol.aim ? sol : null;
  }
  function fcsPk(t) {
    if (!t.sol || !t.target) { t.pk = 0; return; }
    const trk = trackerOf(t, t.target); if (!trk) { t.pk = 0; return; }
    const ammo = F.AMMO[t.ammo];
    const disp = 0.0014 + 0.0011 * Math.abs(t.speed) / 14.8 + (t.turretDmg > 0 ? 0.001 : 0);
    const pk = F.hitProbability(t.sol, trk, { muzzle: ammo.muzzle, dispersion: disp, samples: 48, layError: { yaw: angDiff(t.turYaw, t.sol.yaw), pitch: t.pitch - t.sol.pitch } });
    const visible = visibleNow(t, t.target);
    t.pk = lerp(t.pk, (t.sol.ok ? pk : 0) * (visible ? 1 : 0.35) * (t.masked ? 0.1 : 1), 0.45);
    t.pkRaw = pk;
  }
  function pickTarget(t, cycle) {
    const cands = enemiesOf(t).filter((u) => { const k = trackerOf(t, u); return k && k.seen && k.coast < 2; });
    if (!cands.length) { t.target = null; return; }
    if (cycle && t.target) {
      cands.sort((a, b) => angDiff(Math.atan2(a.x - t.x, a.z - t.z), t.turYaw) - angDiff(Math.atan2(b.x - t.x, b.z - t.z), t.turYaw));
      const i = cands.indexOf(t.target);
      t.target = cands[(i + 1) % cands.length];
    } else {
      let best = null, bs = 1e9;
      for (const u of cands) {
        const d = Math.hypot(u.x - t.x, u.z - t.z);
        const a = Math.abs(angDiff(Math.atan2(u.x - t.x, u.z - t.z), t.turYaw));
        const s = a * 140 + d * 0.4;
        if (s < bs) { bs = s; best = u; }
      }
      t.target = best;
    }
    t.lockLost = 0;
    if (t.human && !t.remote) Audio.beep(1200);
  }

  /* ================================================================ */
  /* Shooting                                                          */
  /* ================================================================ */
  const shellGeo = new T3.CylinderGeometry(0.09, 0.09, 1.4, 6); shellGeo.rotateX(Math.PI / 2);
  function fire(t) {
    const ammo = F.AMMO[t.ammo];
    if (t.reload > 0 || !t.alive) return false;
    const disp = 0.0014 + 0.0011 * Math.abs(t.speed) / 14.8 + (t.turretDmg > 0 ? 0.001 : 0);
    const yaw = t.turYaw + gauss() * disp, pitch = t.pitch + gauss() * disp;
    const m = t.muzzle();
    const v = F.muzzleVelocity(yaw, pitch, ammo.muzzle, t.vel);
    const mesh = new T3.Mesh(shellGeo, new T3.MeshBasicMaterial({ color: ammo.color }));
    mesh.position.set(m.x, m.y, m.z); scene.add(mesh);
    game.shells.push({ x: m.x, y: m.y, z: m.z, vx: v.x, vy: v.y, vz: v.z, t: 0, ammo, owner: t, mesh, target: t.target });
    t.reload = ammo.reload * (t.turretDmg > 0 ? 1.25 : 1);
    t.recoil = 1; t.stats.shots++;
    t.kx -= Math.sin(yaw) * 1.2; t.kz -= Math.cos(yaw) * 1.2;
    FX.muzzle(m.x, m.y, m.z, Math.sin(yaw), Math.cos(yaw));
    Audio.shot(m);
    if (t.human) t.shake = Math.max(t.shake, 0.35);
    return true;
  }

  function damageTank(u, dmg, src, info) {
    if (!u.alive) return;
    u.hp -= dmg; u.hitFlash = 1;
    if (src && src !== u && src.team !== u.team) { src.stats.dmg += dmg; u.lastHitBy = src; }
    if (u.human) u.shake = Math.max(u.shake, 0.6);
    if (u.hp <= 0) killTank(u, src, info);
  }
  function killTank(u, src, info) {
    u.alive = false; u.hp = 0;
    const killer = src || u.lastHitBy;
    if (killer && killer !== u && killer.team !== u.team) killer.stats.kills++;
    const how = info && info.how ? ` [${info.how}]` : '';
    feed(killer && killer !== u ? `${killer.name} ✖ ${u.name}${how}` : `${u.name} destroyed${how}`, '#' + new T3.Color(killer ? killer.color : 0xffffff).getHexString());
    killVisual(u);
    Audio.boom(u, true);
    if (u.human) message('รถถังของคุณถูกทำลาย / DESTROYED', 2.5, u);
  }
  function killVisual(u) {
    FXraw.explosion(u.x, u.y + 1.5, u.z, 1.8);
    // turret pop
    const tw = new T3.Vector3(); u.mesh.turret.getWorldPosition(tw);
    u.mesh.root.remove(u.mesh.turret); scene.add(u.mesh.turret);
    u.mesh.turret.position.copy(tw); u.mesh.turret.rotation.y = u.turYaw;
    u.fly = { vx: rnd(-3, 3), vy: rnd(9, 14), vz: rnd(-3, 3), wx: rnd(-3, 3), wz: rnd(-3, 3) };
    const blacken = (o) => { if (o.isMesh) { o.userData.orig = o.userData.orig || o.material; o.material = MAT.wreck; } };
    u.mesh.root.traverse(blacken); u.mesh.turret.traverse(blacken);
    world.wrecks.push({ x: u.x, z: u.z, tank: u, fire: 14 });
  }

  function explode(s, x, y, z, direct) {
    const a = s.ammo;
    FX.explosion(x, y, z, a.id === 'HE' ? 1.15 : 0.55);
    Audio.boom({ x, z }, a.id === 'HE');
    for (const u of game.tanks) {
      if (!u.alive || u === direct) continue;
      const d = Math.hypot(u.x - x, u.y + 1.2 - y, u.z - z);
      if (d < a.splash + 2) {
        const f = 1 - clamp((d - 1.5) / a.splash, 0, 1);
        const dmg = a.splashDmg * f;
        if (dmg > 0.5) {
          damageTank(u, dmg, s.owner, { how: 'HE' });
          const k = 3.5 * f / Math.max(1, d);
          u.kx += (u.x - x) * k; u.kz += (u.z - z) * k;
          if (a.id === 'HE' && f > 0.45 && Math.random() < 0.5) u.trackDmg = Math.max(u.trackDmg, 5);
        }
      }
    }
    for (const o of world.obstacles) {
      if (!o.alive) continue;
      const dx = Math.max(Math.abs(x - o.x) - o.w / 2, 0), dz = Math.max(Math.abs(z - o.z) - o.d / 2, 0);
      if (Math.hypot(dx, dz) < (a.id === 'HE' ? 4 : 0.6)) damageBuilding(o, a.id === 'HE' ? 34 : 14);
    }
  }
  function damageBuilding(o, dmg) {
    o.hp -= dmg;
    o.mat.color.multiplyScalar(0.92);
    if (o.hp <= 0 && o.alive) {
      o.alive = false;
      const h = 2.2;
      o.mesh.scale.y = h / (o.h + 1); o.mesh.position.y = o.base + h / 2;
      o.mat.color.setHex(0x5b554c);
      for (let i = 0; i < 12; i++) FX.explosion(o.x + rnd(-o.w / 2, o.w / 2), o.base + rnd(1, o.h), o.z + rnd(-o.d / 2, o.d / 2), 0.5);
      Audio.boom(o, true);
    }
  }

  function updateShells(dt) {
    const sub = 4, h = dt / sub;
    for (let i = game.shells.length - 1; i >= 0; i--) {
      const s = game.shells[i];
      let dead = false;
      for (let k = 0; k < sub && !dead; k++) {
        F.stepShell(s, s.ammo, game.wind, h);
        // tanks
        for (const u of game.tanks) {
          if (!u.alive || (u === s.owner && s.t < 0.15)) continue;
          const dx = s.x - u.x, dz = s.z - u.z;
          if (dx * dx + dz * dz > 30) continue;
          const c = Math.cos(-u.yaw), sn = Math.sin(-u.yaw);
          const lx = dx * c + dz * sn, lz = -dx * sn + dz * c;
          const ly = s.y - u.y;
          // turret check (world-stabilised turret, approx cylinder)
          const tdx = s.x - (u.x - Math.sin(u.turYaw) * 0.25), tdz = s.z - (u.z - Math.cos(u.turYaw) * 0.25);
          const inTurret = ly > 2.05 && ly < 3.05 && tdx * tdx + tdz * tdz < 1.6 * 1.6;
          const inHull = Math.abs(lx) < 1.75 && Math.abs(lz) < 3.3 && ly > 0.25 && ly < 2.1;
          if (inTurret || inHull) {
            const sp = Math.hypot(s.vx, s.vy, s.vz) || 1;
            const dir = { x: s.vx / sp, y: s.vy / sp, z: s.vz / sp };
            const range = Math.hypot(s.x - s.owner.x, s.z - s.owner.z);
            const res = F.resolveArmor(u.yaw, dir, inTurret ? 'turret' : 'hull', u.turYaw, inTurret ? 0.2 : 0.45, s.ammo, range);
            if (u.team !== s.owner.team || u === s.owner) s.owner.stats.hits++;
            if (res.ricochet) {
              FX.sparks(s.x, s.y, s.z); Audio.ping(s);
              damageTank(u, res.damage, s.owner, { how: 'ricochet' });
              if (s.owner.human) message('RICOCHET — กระสุนแฉลบ!', 1.2, s.owner);
              // deflect
              const nx = Math.sin(u.yaw), nz = Math.cos(u.yaw);
              const dot = s.vx * nx + s.vz * nz;
              s.vx -= 1.6 * dot * nx; s.vz -= 1.6 * dot * nz; s.vy = Math.abs(s.vy) + 6;
              s.vx *= 0.5; s.vy *= 0.5; s.vz *= 0.5; s.ricochet = true;
              s.x += s.vx * 0.05; s.z += s.vz * 0.05; s.y += 0.4;
              s.owner = u; // no further friendly credit
              continue;
            }
            const how = res.penetrated ? `${res.face.toUpperCase()} PEN` : `${res.face.toUpperCase()} no-pen`;
            if (res.penetrated) {
              FX.sparks(s.x, s.y, s.z);
              if (s.ammo.id === 'AP' && Math.random() < 0.35) { if (inTurret) u.turretDmg = 8; else u.trackDmg = Math.max(u.trackDmg, 6); }
            } else { FX.sparks(s.x, s.y, s.z); Audio.clang(s); }
            if (s.owner.human) message(res.penetrated ? `HIT ${res.face.toUpperCase()} — เจาะเกราะ! (${res.effective | 0}mm < ${res.pen | 0}mm)` : `NO PEN ${res.face.toUpperCase()} — ไม่ทะลุ (${res.effective | 0}mm > ${res.pen | 0}mm)`, 1.6, s.owner);
            damageTank(u, res.damage, s.owner, { how });
            u.kx += dir.x * 1.6; u.kz += dir.z * 1.6;
            explode(s, s.x, s.y, s.z, u);
            dead = true; break;
          }
        }
        if (dead) break;
        // buildings
        for (const o of world.obstacles) {
          const top = o.alive ? o.top : o.base + 2.2;
          if (Math.abs(s.x - o.x) < o.w / 2 && Math.abs(s.z - o.z) < o.d / 2 && s.y < top && s.y > o.base) {
            explode(s, s.x, s.y, s.z, null); damageBuilding(o, s.ammo.id === 'HE' ? 30 : 16); dead = true; break;
          }
        }
        if (dead) break;
        const gh = heightAt(s.x, s.z);
        if (s.y <= gh) {
          explode(s, s.x, gh, s.z, null);
          for (let q = 0; q < 6; q++) FX.dust(s.x, gh, s.z, 2.2);
          dead = true;
        } else if (s.t > 7 || Math.abs(s.x) > HALF + 80 || Math.abs(s.z) > HALF + 80) dead = true;
      }
      if (dead) { scene.remove(s.mesh); s.mesh.material.dispose(); game.shells.splice(i, 1); continue; }
      s.mesh.position.set(s.x, s.y, s.z);
      s.mesh.lookAt(s.x + s.vx, s.y + s.vy, s.z + s.vz);
      FX.trail(s.x, s.y, s.z, s.ammo.id === 'HE' ? [1, 0.55, 0.25] : [1, 0.9, 0.6]);
    }
  }

  /* ================================================================ */
  /* Tank physics                                                      */
  /* ================================================================ */
  function driveTank(t, ctl, dt) {
    if (ctl.gearUp) { const i = GEAR_ORDER.indexOf(t.gear); t.gear = GEAR_ORDER[Math.min(GEAR_ORDER.length - 1, i + 1)]; }
    if (ctl.gearDown) { const i = GEAR_ORDER.indexOf(t.gear); t.gear = GEAR_ORDER[Math.max(0, i - 1)]; }
    const f = t.fwd;
    const grade = (heightAt(t.x + f.x * 2.5, t.z + f.z * 2.5) - heightAt(t.x - f.x * 2.5, t.z - f.z * 2.5)) / 5;
    let target = GEARS[t.gear] * (t.trackDmg > 0 ? 0.5 : 1);
    target *= clamp(1 - Math.sign(target) * grade * 1.9, 0.45, 1.25);
    if (game.state !== 'play') target *= 0.0001 + (game.state === 'countdown' ? 0 : 1);
    const acc = target > t.speed ? 3.2 : 6.5;
    t.speed += clamp(target - t.speed, -acc * dt, acc * dt);
    // tracked steering: slower at high speed
    const turnRate = 0.95 * (1 - 0.38 * Math.abs(t.speed) / 14.8) * (t.trackDmg > 0 ? 0.55 : 1);
    const steer = clamp(ctl.steer, -1, 1);
    t.yaw -= steer * turnRate * dt * (t.speed < -0.5 ? -1 : 1);
    if (Math.abs(steer) > 0.3) t.speed *= 1 - 0.12 * dt; // scrubbing loses speed
    // knockback decay
    t.kx *= Math.max(0, 1 - 3 * dt); t.kz *= Math.max(0, 1 - 3 * dt);
    const v = t.vel;
    let nx = t.x + v.x * dt, nz = t.z + v.z * dt;
    // bounds
    const lim = HALF - 4;
    if (Math.abs(nx) > lim) { nx = Math.sign(nx) * lim; t.speed *= 0.6; }
    if (Math.abs(nz) > lim) { nz = Math.sign(nz) * lim; t.speed *= 0.6; }
    // buildings
    const R = 3.1;
    for (const o of world.obstacles) {
      if (!o.alive) continue;
      const cx = clamp(nx, o.x - o.w / 2, o.x + o.w / 2), cz = clamp(nz, o.z - o.d / 2, o.z + o.d / 2);
      const dx = nx - cx, dz = nz - cz, d = Math.hypot(dx, dz);
      if (d < R) {
        if (d < 1e-4) { nx = t.x; nz = t.z; continue; }
        nx = cx + (dx / d) * R; nz = cz + (dz / d) * R;
        if (Math.abs(t.speed) > 9) damageBuilding(o, 4 * dt * 10);
        t.speed *= 1 - 2.2 * dt;
      }
    }
    // wrecks & tanks
    for (const w of world.wrecks) {
      const dx = nx - w.x, dz = nz - w.z, d = Math.hypot(dx, dz);
      if (d < 4.6 && d > 1e-4) { nx = w.x + dx / d * 4.6; nz = w.z + dz / d * 4.6; t.speed *= 1 - 2 * dt; }
    }
    for (const u of game.tanks) {
      if (u === t || !u.alive) continue;
      const dx = nx - u.x, dz = nz - u.z, d = Math.hypot(dx, dz);
      if (d < 4.8 && d > 1e-4) {
        const push = (4.8 - d) / 2;
        nx += dx / d * push; nz += dz / d * push;
        u.x -= dx / d * push; u.z -= dz / d * push;
        const rel = Math.hypot(t.vel.x - u.vel.x, t.vel.z - u.vel.z);
        if (rel > 9 && game.state === 'play') { damageTank(u, rel * 0.35 * dt * 8, t, { how: 'RAM' }); damageTank(t, rel * 0.2 * dt * 8, u, { how: 'RAM' }); FX.sparks((t.x + u.x) / 2, t.y + 1, (t.z + u.z) / 2); }
      }
    }
    t.x = nx; t.z = nz; t.y = heightAt(t.x, t.z);
  }

  function aimTank(t, ctl, dt) {
    const rate = TRAVERSE * (t.turretDmg > 0 ? 0.35 : 1);
    const fine = t.sight ? 0.35 : 1;
    if (ctl.mouse) {
      t.cmdYaw -= (ctl.mdx || 0) * 0.0022 * (t.sight ? 0.35 : 1);
      t.cmdPitch = clamp(t.cmdPitch - (ctl.mdy || 0) * 0.0016 * (t.sight ? 0.35 : 1), PITCH_MIN, PITCH_MAX);
    }
    if (ctl.trav) t.cmdYaw = t.turYaw - ctl.trav * rate * fine * 1.2 * 0.25 - ctl.trav * rate * fine * dt;
    if (ctl.elev) t.cmdPitch = clamp(t.pitch + ctl.elev * ELEV * fine * dt + ctl.elev * 0.01, PITCH_MIN, PITCH_MAX);
    const autoLay = ctl.lock && settings.fcs === 'auto' && t.sol && t.target;
    if (autoLay) { t.cmdYaw = t.sol.yaw; t.cmdPitch = clamp(t.sol.pitch, PITCH_MIN, PITCH_MAX); }
    // slew toward command at mechanical rates
    const ey = angDiff(t.cmdYaw, t.turYaw);
    t.turYaw += clamp(ey, -rate * dt, rate * dt);
    const ep = t.cmdPitch - t.pitch;
    t.pitch += clamp(ep, -ELEV * dt, ELEV * dt);
    t.autoLay = autoLay;
  }

  /* ================================================================ */
  /* Bots                                                              */
  /* ================================================================ */
  function probe(x, z, yaw, dist) {
    for (let d = 4; d <= dist; d += 4) {
      const px = x + Math.sin(yaw) * d, pz = z + Math.cos(yaw) * d;
      if (Math.abs(px) > HALF - 10 || Math.abs(pz) > HALF - 10) return d;
      for (const o of world.obstacles) if (o.alive && Math.abs(px - o.x) < o.w / 2 + 3.5 && Math.abs(pz - o.z) < o.d / 2 + 3.5) return d;
      for (const w of world.wrecks) if (Math.hypot(px - w.x, pz - w.z) < 5) return d;
    }
    return dist + 1;
  }
  function botThink(t, dt) {
    const b = t.bot;
    const ctl = { gearUp: false, gearDown: false, steer: 0, trav: 0, elev: 0, fire: false, lock: false };
    b.t -= dt; b.jinkT -= dt; b.errT -= dt;
    // target selection
    if (b.t <= 0) {
      b.t = 0.35;
      const cands = enemiesOf(t).filter((u) => { const k = trackerOf(t, u); return k && k.coast < 3; });
      let best = null, bs = 1e9;
      for (const u of cands) {
        const d = Math.hypot(u.x - t.x, u.z - t.z);
        const vis = visibleNow(t, u) ? 0 : 120;
        const weak = u.hp * 0.6;
        const s = d + vis + weak + (u === t.target ? -40 : 0);
        if (s < bs) { bs = s; best = u; }
      }
      if (best !== t.target) { t.target = best; b.acquire = lerp(1.2, 0.25, t.skill); }
    }
    // movement goal
    const z = world.zone;
    const dz = Math.hypot(t.x - z.x, t.z - z.z);
    let desired;
    if (dz > z.r - 18) desired = Math.atan2(z.x - t.x, z.z - t.z);
    else if (t.target) {
      const tg = t.target;
      const d = Math.hypot(tg.x - t.x, tg.z - t.z);
      const brg = Math.atan2(tg.x - t.x, tg.z - t.z);
      const pref = 95 + 70 * t.skill;
      let off = 90 * Math.PI / 180;
      if (d > pref + 35) off = 35 * Math.PI / 180; else if (d < pref - 35) off = 125 * Math.PI / 180;
      desired = brg + off * b.orbit;
      // seek crates when hurt
      if (t.hp < 60 && world.crates.length) {
        const c = world.crates.filter((c) => c.landed).sort((a, b2) => Math.hypot(a.x - t.x, a.z - t.z) - Math.hypot(b2.x - t.x, b2.z - t.z))[0];
        if (c && Math.hypot(c.x - t.x, c.z - t.z) < 90) desired = Math.atan2(c.x - t.x, c.z - t.z);
      }
    } else {
      desired = Math.atan2(z.x - t.x + Math.sin(game.time * 0.2 + t.id) * 60, z.z - t.z + Math.cos(game.time * 0.17 + t.id) * 60);
    }
    // jinking — more aggressive when locked on
    if (b.jinkT <= 0) {
      b.jinkT = rnd(1.2, 3.5) * (t.warn > 0 ? 0.45 : 1);
      b.jink = rnd(0.15, 0.6) * (t.warn > 0 ? 1.4 : 1) * (Math.random() < 0.5 ? -1 : 1);
      if (Math.random() < 0.12) b.orbit *= -1;
    }
    desired += b.jink * t.skill;
    // obstacle avoidance
    const ahead = probe(t.x, t.z, desired, 22);
    if (ahead < 22) {
      const l = probe(t.x, t.z, desired + 0.7, 22), r = probe(t.x, t.z, desired - 0.7, 22);
      desired += l >= r ? 0.9 : -0.9;
    }
    b.desired = desired;
    const err = angDiff(desired, t.yaw);
    ctl.steer = clamp(-err * 2.2, -1, 1);
    if (b.reverseT > 0) { ctl.steer = -ctl.steer; }
    // gears
    let wantGear = Math.abs(err) > 1.1 ? 1 : Math.abs(err) > 0.5 ? 2 : 3;
    if (t.warn > 0) wantGear = Math.max(wantGear, 2);
    // stuck detection
    if (Math.abs(t.speed) < 1.2 && t.gear > 0) b.stuck += dt; else b.stuck = Math.max(0, b.stuck - dt);
    if (b.stuck > 1.2) { b.reverseT = 1.6; b.stuck = 0; }
    if (b.reverseT > 0) { b.reverseT -= dt; wantGear = -1; }
    if (t.driver === 'rl' && window.RLPolicy && window.RLWeights) {
      // neural driving policy (trained offline with Evolution Strategies, see rl/)
      let tgo = null;
      if (t.target) { const k = trackerOf(t, t.target); if (k) { const p = k.predict(0), v = k.vel; tgo = { x: p.x, z: p.z, vx: v.x, vz: v.z, yaw: t.target.yaw, turYaw: t.target.turYaw }; } }
      const feat = RLPolicy.features({ x: t.x, z: t.z, yaw: t.yaw, speed: t.speed, hp: t.hp, warn: t.warn, id: t.id }, tgo, world.zone, (yaw, d) => probe(t.x, t.z, yaw, d), game.roundTime);
      const cmd = RLPolicy.act(window.RLWeights, feat);
      ctl.steer = cmd.steer; wantGear = cmd.gear;
    }
    if (wantGear > t.gear) ctl.gearUp = true; else if (wantGear < t.gear) ctl.gearDown = true;
    // gunnery
    if (t.target && t.sol) {
      if (b.errT <= 0) {
        b.errT = rnd(0.6, 1.4);
        const e = (1 - t.skill) * 0.03 + 0.0015;
        b.aimErrYaw = gauss() * e; b.aimErrPitch = gauss() * e * 0.3;
      }
      b.acquire -= dt;
      if (b.acquire <= 0) {
        t.cmdYaw = t.sol.yaw + b.aimErrYaw;
        t.cmdPitch = clamp(t.sol.pitch + b.aimErrPitch, PITCH_MIN, PITCH_MAX);
      } else {
        const tg = t.target; t.cmdYaw = Math.atan2(tg.x - t.x, tg.z - t.z);
      }
      const thr = lerp(0.3, 0.17, t.skill);
      b.lastShot += dt;
      if (t.reload <= 0 && b.acquire <= 0 && visibleNow(t, t.target) && !t.masked && (t.pk >= thr || (b.lastShot > 4.5 && t.pk > 0.06))) { ctl.fire = true; b.lastShot = 0; }
      // ammo choice: frontal armour at range -> HE
      const tg = t.target;
      const aspect = Math.cos(angDiff(Math.atan2(t.x - tg.x, t.z - tg.z), tg.yaw));
      const want = aspect > 0.7 && t.sol.range > 150 ? 'HE' : (t.sol.range < 60 && tg.hp < 30 ? 'HE' : 'AP');
      if (want !== t.ammo && t.reload > 1) t.ammo = want;
    } else {
      t.cmdYaw = t.yaw; t.cmdPitch = 0.02;
    }
    if (t.warn > 0 && t.hp < 55 && t.smoke > 0 && Math.random() < dt * 0.8) ctl.smoke = true;
    return ctl;
  }

  /* ================================================================ */
  /* Crates & zone                                                     */
  /* ================================================================ */
  const CRATE_TYPES = [
    { id: 'repair', label: 'REPAIR +35', color: 0x47d18c },
    { id: 'smoke', label: 'SMOKE +2', color: 0xd7dde5 },
    { id: 'radar', label: 'RADAR UPLINK', color: 0x35d6e0 },
  ];
  let crateUid = 0;
  function crateMesh(type) {
    const g = new T3.Group();
    const box = new T3.Mesh(new T3.BoxGeometry(1.8, 1.4, 1.8), new T3.MeshLambertMaterial({ color: type.color, emissive: type.color, emissiveIntensity: 0.25 }));
    box.castShadow = true; g.add(box);
    const chute = new T3.Mesh(new T3.SphereGeometry(3, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), new T3.MeshLambertMaterial({ color: 0xeeeeee, side: T3.DoubleSide }));
    chute.position.y = 6; g.add(chute);
    scene.add(g);
    return { g, chute };
  }
  function spawnCrate() {
    const z = world.zone;
    for (let i = 0; i < 20; i++) {
      const a = Math.random() * Math.PI * 2, r = Math.random() * z.r * 0.7;
      const x = z.x + Math.sin(a) * r, zz = z.z + Math.cos(a) * r;
      if (Math.abs(x) > HALF - 15 || Math.abs(zz) > HALF - 15) continue;
      if (world.obstacles.some((o) => o.alive && Math.abs(o.x - x) < o.w / 2 + 3 && Math.abs(o.z - zz) < o.d / 2 + 3)) continue;
      const ti = (Math.random() * CRATE_TYPES.length) | 0, type = CRATE_TYPES[ti];
      const { g, chute } = crateMesh(type);
      const y = heightAt(x, zz) + 70;
      g.position.set(x, y, zz);
      world.crates.push({ id: ++crateUid, ti, x, z: zz, y, type, mesh: g, chute, landed: false });
      feed(`SUPPLY DROP — ${type.label}`, '#9fe8c0');
      return;
    }
  }
  function updateCrates(dt) {
    for (let i = world.crates.length - 1; i >= 0; i--) {
      const c = world.crates[i];
      const gy = heightAt(c.x, c.z) + 0.7;
      if (!c.landed) { c.y -= 7 * dt; c.x += game.wind.x * 0.3 * dt; c.z += game.wind.z * 0.3 * dt; if (c.y <= gy) { c.y = gy; c.landed = true; c.mesh.remove(c.chute); } }
      c.mesh.position.set(c.x, c.y, c.z); c.mesh.rotation.y += dt * 0.6;
      if (!c.landed) continue;
      for (const t of game.tanks) {
        if (!t.alive || Math.hypot(t.x - c.x, t.z - c.z) > 5) continue;
        if (c.type.id === 'repair') { t.hp = Math.min(MAX_HP, t.hp + 35); t.trackDmg = 0; t.turretDmg = 0; }
        if (c.type.id === 'smoke') t.smoke += 2;
        if (c.type.id === 'radar') t.radar = 15;
        if (t.human) { message(`รับ ${c.type.label}`, 1.6, t); if (!t.remote) Audio.beep(900); }
        scene.remove(c.mesh); world.crates.splice(i, 1); break;
      }
    }
  }
  function updateZone(dt) {
    const z = world.zone;
    const T = game.roundTime;
    const target = T < 25 ? 215 : Math.max(32, 215 - (T - 25) * 1.35);
    z.r = lerp(z.r, target, 1 - Math.exp(-dt * 0.8));
    if (Math.random() < dt * 0.08) { z.tx = rnd(-45, 45); z.tz = rnd(-45, 45); }
    const k = 1 - Math.exp(-dt * 0.05);
    z.x = lerp(z.x, z.tx * clamp((215 - z.r) / 150, 0, 1), k); z.z = lerp(z.z, z.tz * clamp((215 - z.r) / 150, 0, 1), k);
    z.mesh.scale.set(z.r, 1, z.r); z.mesh.position.set(z.x, 10, z.z);
    // artillery outside the zone
    game.artyT -= dt;
    if (game.artyT <= 0 && z.r < 205) {
      game.artyT = rnd(0.08, 0.25);
      const a = Math.random() * Math.PI * 2, r = z.r + rnd(4, 120);
      const x = z.x + Math.sin(a) * r, zz = z.z + Math.cos(a) * r;
      if (Math.abs(x) < HALF && Math.abs(zz) < HALF) {
        const gy = heightAt(x, zz);
        FX.explosion(x, gy, zz, 0.9);
        let near = false;
        for (const t of game.tanks) if (t.alive && Math.hypot(t.x - x, t.z - zz) < 50) near = true;
        if (near) Audio.boom({ x, z: zz }, false);
        for (const t of game.tanks) {
          if (!t.alive) continue;
          const d = Math.hypot(t.x - x, t.z - zz);
          if (d < 9) damageTank(t, 14 * (1 - d / 9), null, { how: 'ARTILLERY' });
        }
      }
    }
    for (const t of game.tanks) {
      if (!t.alive) continue;
      const out = Math.hypot(t.x - z.x, t.z - z.z) > z.r;
      t.outside = out;
      if (out) damageTank(t, 4.5 * dt, null, { how: 'ARTILLERY' });
    }
  }

  /* ================================================================ */
  /* Update loop                                                       */
  /* ================================================================ */
  function updateTankVisual(t, dt) {
    if (!t.alive) {
      if (t.fly) {
        const tr = t.mesh.turret;
        t.fly.vy -= 9.81 * dt;
        tr.position.x += t.fly.vx * dt; tr.position.y += t.fly.vy * dt; tr.position.z += t.fly.vz * dt;
        tr.rotation.x += t.fly.wx * dt; tr.rotation.z += t.fly.wz * dt;
        const gy = heightAt(tr.position.x, tr.position.z) + 0.4;
        if (tr.position.y < gy) { tr.position.y = gy; t.fly.vy *= -0.3; t.fly.vx *= 0.5; t.fly.vz *= 0.5; t.fly.wx *= 0.4; t.fly.wz *= 0.4; if (Math.abs(t.fly.vy) < 1) t.fly = null; }
      }
      return;
    }
    const m = t.mesh;
    m.root.position.set(t.x, t.y, t.z);
    m.root.rotation.y = t.yaw;
    const f = t.fwd, rx = Math.cos(t.yaw), rz = -Math.sin(t.yaw);
    const pitchH = Math.atan2(heightAt(t.x + f.x * 3, t.z + f.z * 3) - heightAt(t.x - f.x * 3, t.z - f.z * 3), 6);
    const rollH = Math.atan2(heightAt(t.x + rx * 1.7, t.z + rz * 1.7) - heightAt(t.x - rx * 1.7, t.z - rz * 1.7), 3.4);
    m.hullG.rotation.x = lerp(m.hullG.rotation.x, -pitchH + t.recoil * 0.04, 0.3);
    m.hullG.rotation.z = lerp(m.hullG.rotation.z, rollH, 0.3);
    m.turret.rotation.y = t.turYaw - t.yaw;
    m.barrelPivot.rotation.x = -t.pitch;
    m.barrel.position.z = -t.recoil * 0.7;
    if (t.hitFlash > 0) m.body.emissive && m.body.emissive.setRGB(t.hitFlash * 0.6, t.hitFlash * 0.15, 0);
    else if (m.body.emissive) m.body.emissive.setRGB(0, 0, 0);
    if (t.trackDmg > 0 && Math.random() < 0.3) FXraw.sparks(t.x, t.y + 0.5, t.z);
    if (Math.abs(t.speed) > 3 && Math.random() < 0.35 * dt * 60 * 0.4) {
      const b = { x: t.x - f.x * 3.2, z: t.z - f.z * 3.2 };
      FXraw.dust(b.x, heightAt(b.x, b.z), b.z, clamp(Math.abs(t.speed) / 12, 0.4, 1.2));
    }
  }

  function updateTank(t, dt) {
    if (!t.alive) { updateTankVisual(t, dt); return; }
    const ctl = t.human ? readController(t) : botThink(t, dt);
    if (game.state === 'countdown') { ctl.fire = false; }
    t.reload = Math.max(0, t.reload - dt);
    t.trackDmg = Math.max(0, t.trackDmg - dt); t.turretDmg = Math.max(0, t.turretDmg - dt);
    t.radar = Math.max(0, t.radar - dt);
    t.msgT = Math.max(0, (t.msgT || 0) - dt);
    t.recoil = Math.max(0, t.recoil - dt * 3); t.shake = Math.max(0, t.shake - dt * 1.6); t.hitFlash = Math.max(0, t.hitFlash - dt * 3);
    if (t.human) {
      if (ctl.sight) t.sight = !t.sight;
      if (ctl.ammo) { t.ammo = t.ammo === 'AP' ? 'HE' : 'AP'; t.reload = Math.max(t.reload, 1.2); if (!t.remote) Audio.beep(600); }
      if (ctl.next) pickTarget(t, true);
      if (ctl.lock && (!t.target || !t.target.alive) && settings.fcs !== 'off') pickTarget(t, false);
    }
    if (ctl.smoke && t.smoke > 0) {
      t.smoke--;
      const px = t.x + Math.sin(t.turYaw) * 10, pz = t.z + Math.cos(t.turYaw) * 10;
      FX.smokeScreen(px, pz); world.smokes.push({ x: px, z: pz, r: 10, life: 13 });
      Audio.burst(0.3 * Audio.vol(t), 600, 0.6);
    }
    // target maintenance
    if (t.target) {
      const k = trackerOf(t, t.target);
      if (!t.target.alive || !k) t.target = null;
      else if (k.coast > 4) { t.target = null; if (t.human && !t.remote) Audio.beep(300); }
    }
    t.solTimer -= dt; t.pkTimer -= dt;
    if (t.solTimer <= 0 && (settings.fcs !== 'off' || !t.human)) { t.solTimer = 0.1; fcsSolve(t); }
    if (settings.fcs === 'off' && t.human) t.sol = null;
    if (t.pkTimer <= 0) {
      t.pkTimer = 0.2; fcsPk(t);
      // masking check: does the solved trajectory clear terrain / buildings?
      if (t.sol) {
        const m = t.muzzle();
        const tr = F.trajectory(m, t.sol.yaw, t.sol.pitch, F.AMMO[t.ammo], game.wind, heightAt, t.vel, t.sol.tof + 0.5);
        t.masked = !!(tr.impact && Math.hypot(tr.impact.x - t.sol.aim.x, tr.impact.z - t.sol.aim.z) > 12 && tr.t < t.sol.tof - 0.1);
        if (!t.masked && t.target) t.masked = !lineOfSight({ x: m.x, y: m.y, z: m.z }, { x: t.sol.aim.x, y: t.sol.aim.y, z: t.sol.aim.z }, true);
      }
    }
    driveTank(t, ctl, dt);
    aimTank(t, ctl, dt);
    if (ctl.fire && game.state === 'play') fire(t);
    // own impact preview (for HUD)
    t.impTimer -= dt;
    if (t.human && !t.remote && t.impTimer <= 0) {
      t.impTimer = 0.08;
      t.impact = F.trajectory(t.muzzle(), t.turYaw, t.pitch, F.AMMO[t.ammo], game.wind, heightAt, t.vel, 5);
    }
    updateTankVisual(t, dt);
  }

  function updateThreats() {
    for (const t of game.tanks) t.warn = 0;
    for (const t of game.tanks) {
      if (!t.alive || !t.target || !t.sol) continue;
      if (t.pk > 0.3) t.target.warn = Math.max(t.target.warn, t.pk);
    }
  }

  function step(dt) {
    game.time += dt;
    // wind drifts
    if (Math.random() < dt * 0.1) { const a = Math.atan2(game.windT.x, game.windT.z) + rnd(-0.6, 0.6), s = clamp(Math.hypot(game.windT.x, game.windT.z) + rnd(-1.5, 1.5), 0.5, 8); game.windT = { x: Math.sin(a) * s, z: Math.cos(a) * s }; }
    game.wind.x = lerp(game.wind.x, game.windT.x, dt * 0.3); game.wind.z = lerp(game.wind.z, game.windT.z, dt * 0.3);
    if (game.state === 'countdown') {
      const before = Math.ceil(game.countdown);
      game.countdown -= dt;
      if (Math.ceil(game.countdown) !== before && game.countdown > 0) Audio.beep(700);
      if (game.countdown <= 0) { game.state = 'play'; Audio.beep(1400); message('GO! — รถถังห้ามหยุด เคลื่อนที่ตลอดเวลา', 2); }
    }
    if (game.state === 'play') {
      game.roundTime += dt;
      game.crateT -= dt;
      if (game.crateT <= 0) { game.crateT = rnd(18, 28); spawnCrate(); }
      updateZone(dt);
    }
    updateSensors(dt);
    updateThreats();
    for (const t of game.tanks) updateTank(t, dt);
    updateShells(dt);
    updateCrates(dt);
    for (let i = world.smokes.length - 1; i >= 0; i--) { const s = world.smokes[i]; s.life -= dt; s.r = 10 + (13 - s.life) * 0.25; if (s.life <= 0) world.smokes.splice(i, 1); }
    for (const w of world.wrecks) { if (w.fire > 0) { w.fire -= dt; if (Math.random() < 0.6) FX.fire(w.x, heightAt(w.x, w.z) + 1.5, w.z); } }
    fxAdd.update(dt); fxSmoke.update(dt);
    for (const f of game.feed) f.t -= dt;
    game.feed = game.feed.filter((f) => f.t > 0);
    game.msgT -= dt;
    // round end
    if (game.state === 'play') {
      const teams = aliveTeams();
      const timeUp = game.roundTime > 240;
      if (teams.size <= 1 || timeUp) {
        let winTeam = teams.size === 1 ? [...teams][0] : null;
        if (timeUp && teams.size > 1) {
          const hp = {}; for (const t of game.tanks) if (t.alive) hp[t.team] = (hp[t.team] || 0) + t.hp;
          winTeam = +Object.keys(hp).sort((a, b) => hp[b] - hp[a])[0];
        }
        endRound(winTeam);
      }
    } else if (game.state === 'roundEnd') {
      game.endT -= dt;
      if (game.endT <= 0) {
        const champ = game.tanks.find((t) => t.wins >= settings.rounds);
        if (champ) showMatchEnd(); else startRound();
      }
    }
    // engine audio
    if (Audio.ctx) {
      const hs = game.tanks.filter((t) => t.human && t.alive);
      const sp = hs.length ? hs.reduce((a, t) => a + Math.abs(t.speed), 0) / hs.length : 0;
      Audio.engine.frequency.value = 34 + sp * 3.2;
      Audio.engineGain.gain.value = game.state === 'play' || game.state === 'countdown' ? (hs.length ? 0.06 + sp * 0.006 : 0) : 0;
    }
    if (game.net && game.net.role === 'host' && game.net.started) game.net.tick(dt);
    pressed.clear(); mouse.dx = mouse.dy = 0; mouse.leftPressed = mouse.rightPressed = false; mouse.wheel = 0;
  }

  function teamName(team) {
    if (settings.mode === 'ffa') { const t = game.tanks.find((u) => u.team === team); return t ? t.name : '?'; }
    if (settings.mode === 'coop') return team === 0 ? 'PLAYERS' : 'BOTS';
    return team === 0 ? 'BLUE TEAM' : 'RED TEAM';
  }
  function endRound(winTeam) {
    game.state = 'roundEnd'; game.endT = 4.5;
    if (winTeam !== null && winTeam !== undefined) for (const t of game.tanks) if (t.team === winTeam) t.wins++;
    game.winner = winTeam;
    message(winTeam === null || winTeam === undefined ? 'DRAW — เสมอ' : `${teamName(winTeam)} ชนะรอบที่ ${game.round}!`, 4.5);
  }

  /* ================================================================ */
  /* Rendering                                                         */
  /* ================================================================ */
  function updateCamera(v, dt) {
    let t = v.tank;
    if (!t || !t.alive) {
      // spectate: follow killer or any alive tank
      if (!v.follow || !v.follow.alive) v.follow = (t && t.lastHitBy && t.lastHitBy.alive) ? t.lastHitBy : game.tanks.find((u) => u.alive) || t;
      t = v.follow;
    }
    const cam = v.cam;
    if (!t) return;
    const yaw = t.turYaw, p = t.pitch;
    let pos, look, fov;
    const sight = v.tank === t && t.sight && t.alive;
    if (sight) {
      const pv = t.pivot();
      pos = new T3.Vector3(pv.x + Math.sin(yaw) * 1.6, pv.y + 0.85, pv.z + Math.cos(yaw) * 1.6);
      look = new T3.Vector3(pos.x + Math.sin(yaw) * Math.cos(p) * 100, pos.y + Math.sin(p) * 100, pos.z + Math.cos(yaw) * Math.cos(p) * 100);
      fov = 16;
    } else {
      const back = 15.5, up = 6.8;
      pos = new T3.Vector3(t.x - Math.sin(yaw) * back, t.y + up, t.z - Math.cos(yaw) * back);
      const gh = heightAt(pos.x, pos.z) + 2.2; if (pos.y < gh) pos.y = gh;
      look = new T3.Vector3(t.x + Math.sin(yaw) * 32, t.y + 2.5 + Math.tan(p) * 32, t.z + Math.cos(yaw) * 32);
      fov = 62;
    }
    if (!v.camPos || sight !== v.wasSight) { v.camPos = pos.clone(); v.look = look.clone(); }
    const k = sight ? 1 : 1 - Math.exp(-dt * 9);
    v.camPos.lerp(pos, k); v.look.lerp(look, sight ? 1 : 1 - Math.exp(-dt * 12));
    v.wasSight = sight;
    cam.position.copy(v.camPos);
    const sh = (v.tank && v.tank.shake) || 0;
    if (sh > 0) cam.position.add(new T3.Vector3(rnd(-1, 1), rnd(-1, 1), rnd(-1, 1)).multiplyScalar(sh * 0.5));
    cam.lookAt(v.look);
    v.fov = lerp(v.fov, fov, sight ? 1 : 0.2);
    cam.fov = v.fov; cam.updateProjectionMatrix();
    v.viewTank = t;
  }

  function render(dt) {
    const W = window.innerWidth, H = window.innerHeight;
    renderer.setScissorTest(true);
    hctx.clearRect(0, 0, W, H);
    const pr = renderer.getPixelRatio();
    for (const v of game.views) {
      const [rx, ry, rw, rh] = v.rect;
      const x = Math.floor(rx * W), y = Math.floor(ry * H), w = Math.floor(rw * W), h = Math.floor(rh * H);
      updateCamera(v, dt);
      v.cam.aspect = w / h; v.cam.updateProjectionMatrix();
      const scale = (h * pr) / (2 * Math.tan((v.cam.fov * Math.PI / 180) / 2));
      fxAdd.mat.uniforms.scale.value = scale; fxSmoke.mat.uniforms.scale.value = scale;
      renderer.setViewport(x, H - y - h, w, h); renderer.setScissor(x, H - y - h, w, h);
      renderer.render(scene, v.cam);
      drawHUD(v, x, y, w, h);
    }
    renderer.setScissorTest(false);
    drawGlobalHUD(W, H);
  }

  /* ================================================================ */
  /* HUD                                                               */
  /* ================================================================ */
  const _v = new T3.Vector3();
  function project(v, p, vx, vy, vw, vh) {
    _v.set(p.x, p.y, p.z).project(v.cam);
    if (_v.z > 1 || _v.z < -1) return null;
    return { x: vx + (_v.x * 0.5 + 0.5) * vw, y: vy + (-_v.y * 0.5 + 0.5) * vh, off: Math.abs(_v.x) > 1 || Math.abs(_v.y) > 1 };
  }
  function txt(s, x, y, size, color, align, weight) {
    hctx.font = `${weight || 600} ${size}px "Chakra Petch", "IBM Plex Sans Thai", system-ui, sans-serif`;
    hctx.textAlign = align || 'left'; hctx.fillStyle = color || '#fff';
    hctx.fillText(s, x, y);
  }
  function panel(x, y, w, h, a) { hctx.fillStyle = `rgba(8,12,18,${a || 0.55})`; hctx.fillRect(x, y, w, h); }

  function drawHUD(v, vx, vy, vw, vh) {
    const me = v.tank; const t = v.viewTank;
    if (!t) return;
    hctx.save();
    hctx.beginPath(); hctx.rect(vx, vy, vw, vh); hctx.clip();
    const sc = clamp(Math.min(vw / 900, vh / 600), 0.62, 1.15);
    const S = (n) => n * sc;
    // tank labels / health bars over other tanks
    for (const u of game.tanks) {
      if (!u.alive || u === t) continue;
      const friend = me && u.team === me.team;
      const seen = me ? (friend || visibleNow(me, u) || me.radar > 0) : true;
      if (!seen) continue;
      const p = project(v, { x: u.x, y: u.y + 4.6, z: u.z }, vx, vy, vw, vh);
      if (!p || p.off) continue;
      const d = Math.hypot(u.x - t.x, u.z - t.z);
      const bw = S(46);
      hctx.fillStyle = 'rgba(0,0,0,0.5)'; hctx.fillRect(p.x - bw / 2, p.y, bw, S(5));
      hctx.fillStyle = friend ? '#6fd3ff' : u.hp > 50 ? '#7be08f' : u.hp > 25 ? '#ffc23d' : '#ff5a4f';
      hctx.fillRect(p.x - bw / 2, p.y, bw * u.hp / MAX_HP, S(5));
      txt(`${u.name}  ${d | 0}m`, p.x, p.y - S(4), S(11), friend ? '#9fe3ff' : '#fff', 'center');
    }
    if (me && me.alive) {
      const ammo = F.AMMO[me.ammo];
      // FCS: target box, predicted path, lead reticle
      if (me.target && me.sol && settings.fcs !== 'off') {
        const tg = me.target, trk = trackerOf(me, tg);
        const tb = project(v, { x: tg.x, y: tg.y + 1.6, z: tg.z }, vx, vy, vw, vh);
        const vis = visibleNow(me, tg);
        hctx.lineWidth = 2;
        if (tb && !tb.off) {
          const s = S(clamp(900 / Math.max(20, Math.hypot(tg.x - me.x, tg.z - me.z)), 14, 60));
          hctx.strokeStyle = vis ? '#ff5a4f' : 'rgba(255,90,79,0.5)';
          hctx.setLineDash(vis ? [] : [5, 5]);
          const c = s * 0.35;
          for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
            hctx.beginPath(); hctx.moveTo(tb.x + sx * s, tb.y + sy * s - sy * c); hctx.lineTo(tb.x + sx * s, tb.y + sy * s); hctx.lineTo(tb.x + sx * s - sx * c, tb.y + sy * s); hctx.stroke();
          }
          hctx.setLineDash([]);
          txt(vis ? 'TRACK' : 'COAST (memory)', tb.x, tb.y - s - S(6), S(10), '#ff8a80', 'center');
        }
        if (trk) {
          const pts = trk.path(me.sol.tof * 1.25, 10);
          hctx.fillStyle = '#ffd166';
          for (const q of pts) { const pp = project(v, { x: q.x, y: heightAt(q.x, q.z) + 1.4, z: q.z }, vx, vy, vw, vh); if (pp && !pp.off) { hctx.beginPath(); hctx.arc(pp.x, pp.y, S(2.4), 0, 7); hctx.fill(); } }
        }
        const la = project(v, me.sol.aim, vx, vy, vw, vh);
        if (la && !la.off) {
          const onSol = Math.abs(angDiff(me.turYaw, me.sol.yaw)) < 0.004 && Math.abs(me.pitch - me.sol.pitch) < 0.0025;
          hctx.strokeStyle = onSol ? '#47ff8c' : '#ffd166'; hctx.lineWidth = 2;
          const r = S(9);
          hctx.beginPath(); hctx.moveTo(la.x, la.y - r); hctx.lineTo(la.x + r, la.y); hctx.lineTo(la.x, la.y + r); hctx.lineTo(la.x - r, la.y); hctx.closePath(); hctx.stroke();
          txt('LEAD', la.x + r + 3, la.y + 4, S(10), onSol ? '#47ff8c' : '#ffd166');
        }
      }
      // own impact point & crosshair
      if (me.impact && me.impact.impact) {
        const ip = project(v, me.impact.impact, vx, vy, vw, vh);
        if (ip && !ip.off) {
          hctx.strokeStyle = me.reload > 0 ? 'rgba(255,255,255,0.45)' : '#fff'; hctx.lineWidth = 2;
          hctx.beginPath(); hctx.arc(ip.x, ip.y, S(7), 0, 7); hctx.stroke();
          hctx.beginPath(); hctx.moveTo(ip.x - S(14), ip.y); hctx.lineTo(ip.x - S(9), ip.y); hctx.moveTo(ip.x + S(9), ip.y); hctx.lineTo(ip.x + S(14), ip.y); hctx.stroke();
          if (me.reload > 0) { hctx.strokeStyle = '#ffd166'; hctx.beginPath(); hctx.arc(ip.x, ip.y, S(11), -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - me.reload / ammo.reload)); hctx.stroke(); }
        }
        // trajectory arc (third person only)
        if (!me.sight) {
          hctx.strokeStyle = 'rgba(255,255,255,0.22)'; hctx.lineWidth = 1.5; hctx.beginPath();
          let started = false;
          for (let i = 0; i < me.impact.pts.length; i += 2) {
            const pp = project(v, me.impact.pts[i], vx, vy, vw, vh);
            if (!pp) { started = false; continue; }
            if (!started) { hctx.moveTo(pp.x, pp.y); started = true; } else hctx.lineTo(pp.x, pp.y);
          }
          hctx.stroke();
        }
      }
      if (me.sight) drawGunSight(vx, vy, vw, vh, S, me);

      // --- bottom-left: vehicle status ---
      const bx = vx + S(14), by = vy + vh - S(120);
      panel(bx, by, S(230), S(106));
      txt(me.name, bx + S(10), by + S(20), S(15), '#' + new T3.Color(me.color).getHexString(), 'left', 800);
      txt(`ชนะ ${me.wins}/${settings.rounds}`, bx + S(220), by + S(20), S(12), '#cfd8e3', 'right');
      hctx.fillStyle = 'rgba(255,255,255,0.12)'; hctx.fillRect(bx + S(10), by + S(30), S(210), S(10));
      hctx.fillStyle = me.hp > 50 ? '#47d18c' : me.hp > 25 ? '#ffc23d' : '#ff5a4f'; hctx.fillRect(bx + S(10), by + S(30), S(210) * me.hp / MAX_HP, S(10));
      const gearTxt = me.gear < 0 ? 'R' : String(me.gear);
      txt(`เกียร์ ${gearTxt}`, bx + S(10), by + S(60), S(13), '#fff');
      txt(`${(Math.abs(me.speed) * 3.6) | 0} km/h`, bx + S(90), by + S(60), S(13), '#fff');
      txt(`ควัน ${me.smoke}`, bx + S(220), by + S(60), S(13), '#d7dde5', 'right');
      txt(`${ammo.name}`, bx + S(10), by + S(82), S(13), me.ammo === 'AP' ? '#ffe08a' : '#ff9a5a', 'left', 700);
      txt(me.reload > 0 ? `RELOAD ${me.reload.toFixed(1)}s` : 'READY', bx + S(120), by + S(82), S(13), me.reload > 0 ? '#ffd166' : '#47ff8c', 'left', 700);
      const flags = [];
      if (me.trackDmg > 0) flags.push('TRACK DMG');
      if (me.turretDmg > 0) flags.push('TURRET DMG');
      if (me.radar > 0) flags.push(`RADAR ${me.radar | 0}s`);
      if (me.outside) flags.push('⚠ นอกเขตปลอดภัย');
      if (flags.length) txt(flags.join(' · '), bx + S(10), by + S(100), S(11), '#ff8a80');

      // --- bottom-right: FCS AI panel ---
      if (settings.fcs !== 'off') drawFCSPanel(vx, vy, vw, vh, S, me);

      // threat warning
      if (me.warn > 0) {
        const a = 0.5 + 0.5 * Math.sin(game.time * 14);
        txt(`⚠ LOCK WARNING — ศัตรูล็อกเป้าคุณ (Pk ${(me.warn * 100) | 0}%) — หักหลบ / เปลี่ยนความเร็ว!`, vx + vw / 2, vy + S(70), S(14), `rgba(255,90,79,${0.6 + 0.4 * a})`, 'center', 800);
      }
      // wind
      drawWind(vx + vw / 2, vy + S(game.views.length > 1 ? 22 : 46), S, me);
    } else if (me) {
      txt('ถูกทำลาย — กำลังติดตาม ' + (t ? t.name : ''), vx + vw / 2, vy + vh / 2, S(20), '#ff8a80', 'center', 800);
    }
    drawMinimap(vx + vw - S(150), vy + S(12), S(138), me || t, S);
    if (me && me.msgT > 0) txt(me.msg, vx + vw / 2, vy + vh * 0.36, S(16), '#fff', 'center', 800);
    if (game.msgT > 0 && game.state !== 'roundEnd') txt(game.msg, vx + vw / 2, vy + vh * 0.3, S(17), '#ffd166', 'center', 800);
    if (game.state === 'countdown') txt(String(Math.ceil(game.countdown)), vx + vw / 2, vy + vh / 2, S(80), '#ffd166', 'center', 900);
    hctx.restore();
  }

  function drawGunSight(vx, vy, vw, vh, S, me) {
    const cx = vx + vw / 2, cy = vy + vh / 2;
    hctx.fillStyle = 'rgba(0,0,0,0.55)';
    const r = Math.min(vw, vh) * 0.46;
    hctx.beginPath(); hctx.rect(vx, vy, vw, vh); hctx.arc(cx, cy, r, 0, Math.PI * 2, true); hctx.fill();
    hctx.strokeStyle = 'rgba(160,255,190,0.9)'; hctx.lineWidth = 1.5;
    hctx.beginPath(); hctx.moveTo(cx - r, cy); hctx.lineTo(cx - S(16), cy); hctx.moveTo(cx + S(16), cy); hctx.lineTo(cx + r, cy); hctx.moveTo(cx, cy + S(16)); hctx.lineTo(cx, cy + r); hctx.stroke();
    // mil ticks (1 tick = 2 mrad); fov 16 deg
    const pxPerRad = vh / (2 * Math.tan(8 * Math.PI / 180));
    for (let i = 1; i <= 10; i++) {
      const o = i * 0.002 * pxPerRad;
      const len = i % 5 === 0 ? S(9) : S(5);
      hctx.beginPath(); hctx.moveTo(cx + o, cy - len); hctx.lineTo(cx + o, cy + len); hctx.moveTo(cx - o, cy - len); hctx.lineTo(cx - o, cy + len); hctx.stroke();
      hctx.beginPath(); hctx.moveTo(cx - len, cy + o); hctx.lineTo(cx + len, cy + o); hctx.stroke();
    }
    hctx.beginPath(); hctx.moveTo(cx, cy - S(6)); hctx.lineTo(cx - S(8), cy + S(8)); hctx.moveTo(cx, cy - S(6)); hctx.lineTo(cx + S(8), cy + S(8)); hctx.stroke();
    txt(`ELEV ${(me.pitch * DEG).toFixed(2)}°`, cx - r * 0.7, cy + r * 0.75, S(13), '#a0ffbe');
    txt(`AZ ${(((-me.turYaw * DEG) % 360 + 360) % 360).toFixed(1)}°`, cx + r * 0.7, cy + r * 0.75, S(13), '#a0ffbe', 'right');
  }

  function drawFCSPanel(vx, vy, vw, vh, S, me) {
    const w = S(268), h = S(178), x = vx + vw - w - S(14), y = vy + vh - h - S(14);
    panel(x, y, w, h);
    txt('FCS-AI', x + S(10), y + S(19), S(12), '#7fd6ff', 'left', 800);
    txt(settings.fcs === 'auto' ? (me.autoLay ? 'AUTO-LAY ●' : 'AUTO (กดค้าง LOCK)') : 'ADVISOR', x + w - S(10), y + S(19), S(11), me.autoLay ? '#47ff8c' : '#9fb3c8', 'right', 700);
    const tg = me.target, trk = tg ? trackerOf(me, tg) : null, sol = me.sol;
    if (!tg || !trk || !sol) {
      txt('ไม่มีเป้า — กด LOCK เพื่อเลือกเป้า', x + S(10), y + S(50), S(12), '#cfd8e3');
      txt('NEXT = สลับเป้า · ยิงขณะเคลื่อนที่ = กระจายมากขึ้น', x + S(10), y + S(72), S(11), '#8fa3b8');
      return;
    }
    const rows = [
      ['เป้า', `${tg.name}  ${sol.range | 0} m`],
      ['ความเร็ว/ทิศ', `${(trk.speed * 3.6) | 0} km/h  ${(((-trk.heading * DEG) % 360 + 360) % 360) | 0}°`],
      ['อัตราเลี้ยว', `${(trk.omega * DEG).toFixed(1)} °/s  ${Math.abs(trk.omega) > 0.05 ? '(curve)' : ''}`],
      ['มุมยิงที่ต้องการ', `${(sol.pitch * DEG).toFixed(2)}°  (ปืน ${(me.pitch * DEG).toFixed(2)}°)`],
      ['Lead / ToF', `${(sol.lead * DEG).toFixed(2)}°  /  ${sol.tof.toFixed(2)} s`],
      ['ความคาดเดาได้', `${trk.manoeuvre < 1.3 ? 'สูง (ง่าย)' : trk.manoeuvre < 2.4 ? 'กลาง' : 'ต่ำ (หลบดี)'}`],
    ];
    rows.forEach((r, i) => { txt(r[0], x + S(10), y + S(40 + i * 18), S(11), '#8fa3b8'); txt(r[1], x + w - S(10), y + S(40 + i * 18), S(11.5), '#e8eef5', 'right', 700); });
    const py = y + h - S(26);
    txt('Pk', x + S(10), py + S(12), S(13), '#fff', 'left', 800);
    hctx.fillStyle = 'rgba(255,255,255,0.12)'; hctx.fillRect(x + S(36), py + 2, w - S(96), S(12));
    const pk = me.pk;
    hctx.fillStyle = pk > 0.55 ? '#47ff8c' : pk > 0.3 ? '#ffd166' : '#ff7a6b'; hctx.fillRect(x + S(36), py + 2, (w - S(96)) * pk, S(12));
    txt(me.masked ? 'MASKED' : !sol.ok ? 'OUT ELEV' : `${(pk * 100) | 0}%`, x + w - S(10), py + S(12), S(12), me.masked || !sol.ok ? '#ff7a6b' : '#fff', 'right', 800);
  }

  function drawWind(cx, cy, S, me) {
    panel(cx - S(70), cy - S(16), S(140), S(30), 0.45);
    const w = game.wind, sp = Math.hypot(w.x, w.z);
    // wind direction relative to camera (turret) yaw
    const rel = Math.atan2(w.x, w.z) - me.turYaw;
    const ax = cx - S(40), ay = cy - S(1);
    hctx.save(); hctx.translate(ax, ay); hctx.rotate(-rel + Math.PI);
    hctx.strokeStyle = '#9fe3ff'; hctx.lineWidth = 2; hctx.beginPath(); hctx.moveTo(0, -S(9)); hctx.lineTo(0, S(9)); hctx.moveTo(-S(5), S(3)); hctx.lineTo(0, S(9)); hctx.lineTo(S(5), S(3)); hctx.stroke();
    hctx.restore();
    txt(`ลม ${sp.toFixed(1)} m/s`, cx - S(22), cy + S(4), S(12), '#cfe9ff');
  }

  function drawMinimap(x, y, size, me, S) {
    panel(x, y, size, size, 0.5);
    const k = size / (HALF * 2);
    const mx = (wx) => x + (wx + HALF) * k, my = (wz) => y + (HALF - wz) * k;
    // note: x grows to the screen-left when looking +z, so mirror x for a north-up map
    const mxx = (wx) => x + (HALF - wx) * k;
    void mx;
    hctx.fillStyle = 'rgba(200,190,170,0.6)';
    for (const o of world.obstacles) { hctx.fillStyle = o.alive ? 'rgba(210,200,180,0.75)' : 'rgba(120,110,100,0.5)'; hctx.fillRect(mxx(o.x + o.w / 2), my(o.z + o.d / 2), o.w * k, o.d * k); }
    const z = world.zone;
    if (z) { hctx.strokeStyle = '#ff5a4f'; hctx.lineWidth = 1.5; hctx.beginPath(); hctx.arc(mxx(z.x), my(z.z), z.r * k, 0, 7); hctx.stroke(); }
    for (const s of world.smokes) { hctx.fillStyle = 'rgba(230,230,230,0.45)'; hctx.beginPath(); hctx.arc(mxx(s.x), my(s.z), s.r * k, 0, 7); hctx.fill(); }
    for (const c of world.crates) { hctx.fillStyle = '#' + new T3.Color(c.type.color).getHexString(); hctx.fillRect(mxx(c.x) - 2.5, my(c.z) - 2.5, 5, 5); }
    for (const u of game.tanks) {
      if (!u.alive) continue;
      const own = me && u === me;
      const friend = me && u.team === me.team;
      if (me && !own && !friend && !(me.trackers.get(u.id) && me.trackers.get(u.id).ready && me.trackers.get(u.id).coast < 1.5) && me.radar <= 0) continue;
      const px = mxx(u.x), py = my(u.z);
      hctx.save(); hctx.translate(px, py); hctx.rotate(-u.yaw);
      hctx.fillStyle = own ? '#ffffff' : '#' + new T3.Color(u.color).getHexString();
      hctx.beginPath(); hctx.moveTo(0, -5); hctx.lineTo(3.5, 4); hctx.lineTo(-3.5, 4); hctx.closePath(); hctx.fill();
      hctx.restore();
      if (own) { hctx.strokeStyle = 'rgba(255,255,255,0.6)'; hctx.beginPath(); hctx.moveTo(px, py); hctx.lineTo(px - Math.sin(u.turYaw) * 14, py - Math.cos(u.turYaw) * 14); hctx.stroke(); }
    }
    void S;
  }

  function drawGlobalHUD(W, H) {
    // dividers
    if (game.views.length > 1) {
      hctx.fillStyle = '#0b0f14';
      for (const v of game.views) { const [rx, ry, rw, rh] = v.rect; if (rx > 0) hctx.fillRect(rx * W - 1.5, ry * H, 3, rh * H); if (ry > 0) hctx.fillRect(rx * W, ry * H - 1.5, rw * W, 3); }
    }
    // top centre: round & time
    const t = Math.max(0, 240 - game.roundTime);
    hctx.fillStyle = 'rgba(8,12,18,0.55)'; hctx.fillRect(W / 2 - 110, 0, 220, 26);
    txt(`ROUND ${game.round} · ${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')} · ${game.tanks.filter((u) => u.alive).length} alive`, W / 2, 18, 13, '#e8eef5', 'center', 700);
    // kill feed
    game.feed.forEach((f, i) => { hctx.globalAlpha = clamp(f.t, 0, 1); hctx.fillStyle = 'rgba(8,12,18,0.55)'; hctx.fillRect(W / 2 - 160, 30 + i * 22, 320, 20); txt(f.text, W / 2, 45 + i * 22, 12, f.color, 'center', 700); hctx.globalAlpha = 1; });
    if (game.state === 'roundEnd') {
      hctx.fillStyle = 'rgba(5,8,12,0.6)'; hctx.fillRect(0, H / 2 - 90, W, 180);
      txt(game.msg, W / 2, H / 2 - 30, 34, '#ffd166', 'center', 900);
      const score = game.tanks.slice().sort((a, b) => b.wins - a.wins || b.stats.kills - a.stats.kills).map((u) => `${u.name} ${u.wins}★ ${u.stats.kills}K`).join('    ');
      txt(score, W / 2, H / 2 + 20, 15, '#e8eef5', 'center', 600);
      txt(`ต้องชนะ ${settings.rounds} รอบ`, W / 2, H / 2 + 52, 13, '#9fb3c8', 'center', 600);
    }
    if (game.paused) {
      hctx.fillStyle = 'rgba(5,8,12,0.7)'; hctx.fillRect(0, 0, W, H);
      txt('PAUSED — หยุดชั่วคราว', W / 2, H / 2 - 10, 34, '#fff', 'center', 900);
      txt('Esc = เล่นต่อ · M = กลับเมนู', W / 2, H / 2 + 26, 15, '#cfd8e3', 'center', 600);
    }
  }

  /* ================================================================ */
  /* Menu / flow                                                       */
  /* ================================================================ */
  function readMenu() {
    settings.humans = +$('humans').value;
    settings.bots = +$('bots').value;
    settings.mode = $('mode').value;
    settings.fcs = $('fcs').value;
    settings.diff = $('diff').value;
    settings.rounds = +$('rounds').value;
    for (let i = 0; i < 4; i++) settings.inputs[i] = $('in' + i).value;
    settings.botDriver = $('driver').value;
    const remote = game.net && game.net.role === 'host' ? game.net.players().length : 0;
    if (settings.humans + remote + settings.bots < 2) settings.bots = 2 - settings.humans - remote;
  }
  function refreshMenu() {
    const h = +$('humans').value;
    for (let i = 0; i < 4; i++) $('slot' + i).style.display = i < h ? '' : 'none';
    const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
    $('padinfo').textContent = pads.length ? `ตรวจพบจอย ${pads.length} ตัว: ${pads.map((p) => p.id.slice(0, 28)).join(', ')}` : 'ยังไม่พบจอย — กดปุ่มบนจอยเพื่อเชื่อมต่อ (รองรับ Xbox/PS/Standard)';
  }
  function startMatch() {
    readMenu();
    Audio.init(); if (Audio.ctx && Audio.ctx.state === 'suspended') Audio.ctx.resume();
    for (const t of game.tanks) t.wins = 0;
    makeTanks();
    game.round = 0;
    $('menu').classList.add('hidden'); $('end').classList.add('hidden');
    startRound();
    if (game.net && game.net.role === 'host') { game.net.started = true; game.net.sendRoster(); }
  }
  function showMatchEnd() {
    game.state = 'matchEnd';
    if (document.exitPointerLock) document.exitPointerLock();
    const rows = game.tanks.slice().sort((a, b) => b.wins - a.wins || b.stats.kills - a.stats.kills || b.stats.dmg - a.stats.dmg);
    const champ = rows[0];
    $('endTitle').textContent = `${settings.mode === 'ffa' ? champ.name : teamName(champ.team)} ชนะการแข่งขัน!`;
    $('endTable').innerHTML = '<tr><th>รถถัง</th><th>ชนะ</th><th>Kill</th><th>ดาเมจ</th><th>ยิง</th><th>ถูกเป้า</th><th>แม่นยำ</th></tr>' +
      rows.map((u) => `<tr><td style="color:#${new T3.Color(u.color).getHexString()}">${u.name}${u.human ? ' 🎮' : ''}</td><td>${u.wins}</td><td>${u.stats.kills}</td><td>${u.stats.dmg | 0}</td><td>${u.stats.shots}</td><td>${u.stats.hits}</td><td>${u.stats.shots ? ((u.stats.hits / u.stats.shots) * 100) | 0 : 0}%</td></tr>`).join('');
    $('again').classList.toggle('hidden', !!(game.net && game.net.role === 'client'));
    $('end').classList.remove('hidden');
  }
  function togglePause() {
    if (game.state === 'matchEnd' || (game.net && game.net.started)) return;
    game.paused = !game.paused;
    if (game.paused && document.exitPointerLock) document.exitPointerLock();
  }
  function toMenu(fromNet) {
    if (game.net && game.net.role === 'client' && !fromNet) netLeave();
    if (game.net && game.net.role === 'host') { game.net.started = false; game.net.broadcast({ type: 'back' }); game.net.lobby(); }
    for (const t of game.tanks) t.remote = false;
    game.paused = false; game.state = 'menu';
    $('end').classList.add('hidden'); $('menu').classList.remove('hidden');
    if (document.exitPointerLock) document.exitPointerLock();
    demo();
  }
  window.addEventListener('keydown', (e) => { if (game.paused && e.code === 'KeyM') toMenu(); });

  // attract mode behind the menu: bots only
  function demo() {
    const saved = { ...settings, inputs: settings.inputs.slice() };
    settings.humans = 0; settings.bots = 5; settings.mode = 'ffa'; settings.diff = 'hard';
    makeTanks(true); game.round = 0; startRound(); game.state = 'play'; game.countdown = 0;
    Object.assign(settings, saved, { humans: saved.humans, bots: saved.bots });
    game.demo = true;
  }

  $('start').addEventListener('click', () => { game.demo = false; startMatch(); });
  $('again').addEventListener('click', () => { game.demo = false; startMatch(); });
  $('menuBtn').addEventListener('click', toMenu);
  $('humans').addEventListener('change', refreshMenu);
  window.addEventListener('gamepadconnected', refreshMenu);
  window.addEventListener('gamepaddisconnected', refreshMenu);


  /* ================================================================ */
  /* Online multiplayer (host-authoritative)                           */
  /*  - The host runs the whole simulation, bots included.             */
  /*  - Clients send their controller state ~30x/s.                    */
  /*  - The host sends a snapshot 20x/s: tanks, shells, zone, crates,  */
  /*    buildings, feed, one-shot FX/audio events, plus each client's  */
  /*    private FCS data for its HUD.                                  */
  /*  - Clients interpolate and render; the world itself is rebuilt    */
  /*    from the round seed, so terrain/buildings are identical.       */
  /* ================================================================ */
  const r2 = (v) => Math.round(v * 100) / 100, r3 = (v) => Math.round(v * 1000) / 1000;
  const CTL_COUNTS = ['gu', 'gd', 'fire', 'next', 'ammo', 'smoke', 'sight'];
  const CTL_MAP = { gu: 'gearUp', gd: 'gearDown', fire: 'fire', next: 'next', ammo: 'ammo', smoke: 'smoke', sight: 'sight' };
  function netStatus(html) { $('netStatus').innerHTML = html; }
  function esc(x) { return String(x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function myName() { const v = ($('netName').value || '').trim().slice(0, 12); return v || 'Player'; }

  function netHost() {
    if (game.net) return;
    const tr = MFTransport.pick();
    const code = Array.from({ length: 5 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[(Math.random() * 32) | 0]).join('');
    const net = { role: 'host', code, started: false, conns: new Map(), inputs: {}, acc: 0, hostName: myName() };
    game.net = net;
    net.players = () => [...net.conns.values()].filter((c) => c.ready).map((c) => ({ id: c.id, name: c.name }));
    net.broadcast = (m) => { for (const c of net.conns.values()) if (c.ready) c.send(m); };
    net.lobby = () => {
      const names = [net.hostName + ' (host)'].concat(net.players().map((p) => p.name));
      net.broadcast({ type: 'lobby', names, code });
      $('netPlayers').textContent = `ในห้อง ${names.length} คน: ${names.join(', ')}`;
      $('start').textContent = net.players().length ? `เริ่มสงครามออนไลน์ · ${names.length} คน` : 'เริ่มสงคราม · DEPLOY';
    };
    net.remoteCtl = (id) => {
      const c = { gearUp: false, gearDown: false, steer: 0, trav: 0, elev: 0, fire: false, lock: false, next: false, ammo: false, smoke: false, sight: false, mouse: false, mdx: 0, mdy: 0 };
      const st = net.inputs[id]; if (!st) return c;
      for (const k of CTL_COUNTS) { c[CTL_MAP[k]] = st[k] > 0; st[k] = 0; }
      c.steer = st.steer || 0; c.trav = st.trav || 0; c.elev = st.elev || 0; c.lock = !!st.lock; c.mouse = !!st.mouse;
      c.mdx = st.mdx || 0; c.mdy = st.mdy || 0; st.mdx = st.mdy = 0;
      return c;
    };
    net.sendRoster = () => {
      const tanks = game.tanks.map((t) => ({ id: t.id, name: t.name, team: t.team, color: t.color, human: t.human }));
      for (const c of net.conns.values()) {
        if (!c.ready) continue;
        const me = game.tanks.find((t) => t.connId === c.id);
        c.send({ type: 'roster', you: me ? me.id : -1, tanks, set: { mode: settings.mode, rounds: settings.rounds, fcs: settings.fcs } });
      }
    };
    net.tick = (dt) => {
      net.acc += dt;
      if (net.acc < 0.05) return;
      net.acc = 0;
      const base = snapshot();
      for (const c of net.conns.values()) {
        if (!c.ready) continue;
        const me = game.tanks.find((t) => t.connId === c.id && t.remote);
        base.me = privateOf(me); base.you = me ? me.id : -1;
        c.send(base);
      }
      NET_EV.length = 0;
    };
    net.handle = tr.host(code, (conn) => {
      net.conns.set(conn.id, conn);
      conn.onData((m) => {
        if (!m || typeof m !== 'object') return;
        if (m.type === 'hello') {
          if (net.players().length >= 7) { conn.send({ type: 'full' }); return; }
          conn.name = String(m.name || 'Player').slice(0, 12).replace(/[<>]/g, ''); conn.ready = true;
          net.inputs[conn.id] = { steer: 0, trav: 0, elev: 0, lock: false, mouse: false, mdx: 0, mdy: 0, gu: 0, gd: 0, fire: 0, next: 0, ammo: 0, smoke: 0, sight: 0 };
          net.lobby();
          if (net.started) conn.send({ type: 'busy' });
        } else if (m.type === 'in' && m.c) {
          const st = net.inputs[conn.id]; if (!st) return;
          for (const k of CTL_COUNTS) st[k] += +m.c[k] || 0;
          st.steer = clamp(+m.c.steer || 0, -1, 1); st.trav = clamp(+m.c.trav || 0, -1, 1); st.elev = clamp(+m.c.elev || 0, -1, 1);
          st.lock = !!m.c.lock; st.mouse = !!m.c.mouse;
          st.mdx += clamp(+m.c.mdx || 0, -2000, 2000); st.mdy += clamp(+m.c.mdy || 0, -2000, 2000);
        }
      });
      conn.onClose(() => {
        if (!net.conns.has(conn.id)) return;
        net.conns.delete(conn.id); delete net.inputs[conn.id];
        const t = game.tanks.find((u) => u.connId === conn.id);
        if (t) { t.human = false; t.remote = false; t.input = null; t.connId = null; t.name += ' (AI)'; feed(`${t.name} หลุดการเชื่อมต่อ — AI ขับแทน`, '#ffd166'); }
        net.lobby();
      });
    }, () => {
      const link = location.origin + location.pathname + '?join=' + code + (location.search.includes('net=local') ? '&net=local' : '');
      netStatus(`ห้อง <b class="code">${code}</b> พร้อมแล้ว · ส่งรหัสหรือลิงก์ให้เพื่อน<br><span class="link" id="netLink">${esc(link)}</span> <button class="mini" id="copyLink">คัดลอก</button>`);
      $('copyLink').onclick = () => { const done = () => { $('copyLink').textContent = 'คัดลอกแล้ว'; }; try { navigator.clipboard.writeText(link).then(done, () => selectText($('netLink'))); } catch (e) { selectText($('netLink')); } };
      net.lobby();
    }, (err) => { if (game.net !== net) return; netLeave(); netStatus(`สร้างห้อง/การเชื่อมต่อมีปัญหา (${esc(err)}) — ตรวจอินเทอร์เน็ตแล้วลองใหม่`); });
    netStatus('กำลังสร้างห้อง…');
    $('hostBtn').disabled = true; $('joinBtn').disabled = true;
  }
  function selectText(el) { const r = document.createRange(); r.selectNodeContents(el); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); }

  function snapshot() {
    const z = world.zone;
    return {
      type: 'snap', st: game.state, cd: r2(game.countdown), rt: r2(game.roundTime), rd: game.round, seed: settings.seed, endT: r2(game.endT || 0),
      set: { mode: settings.mode, rounds: settings.rounds, fcs: settings.fcs },
      wind: [r2(game.wind.x), r2(game.wind.z)], zone: [r2(z.x), r2(z.z), r2(z.r)],
      tk: game.tanks.map((t) => [t.id, r2(t.x), r2(t.z), r3(t.yaw), r2(t.speed), r3(t.turYaw), r3(t.pitch), Math.round(t.hp), t.alive ? 1 : 0, t.gear, r2(t.recoil), t.trackDmg > 0 ? 1 : 0, r2(t.hitFlash), t.wins, t.stats.kills, Math.round(t.stats.dmg), t.stats.shots, t.stats.hits, t.name]),
      sh: game.shells.map((q) => [r2(q.x), r2(q.y), r2(q.z), r2(q.vx), r2(q.vy), r2(q.vz), q.ammo.id === 'HE' ? 1 : 0]),
      ob: world.obstacles.map((o) => (o.alive ? Math.max(1, Math.round(o.hp)) : 0)),
      cr: world.crates.map((c) => [c.id, c.ti, r2(c.x), r2(c.y), r2(c.z), c.landed ? 1 : 0]),
      fd: game.feed.map((f) => [f.text, f.color, r2(f.t)]),
      msg: game.msgT > 0 ? [game.msg, r2(game.msgT)] : null,
      ev: NET_EV.slice(),
    };
  }
  function privateOf(t) {
    if (!t) return null;
    const p = {
      rl: r2(t.reload), am: t.ammo, sm: t.smoke, ra: r2(t.radar), wa: r2(t.warn), out: t.outside ? 1 : 0, al: t.autoLay ? 1 : 0,
      td: t.turretDmg > 0 ? 1 : 0, msg: t.msgT > 0 ? [t.msg, r2(t.msgT)] : null, shk: r2(t.shake), tg: t.target ? t.target.id : -1,
      pk: r2(t.pk), mk: t.masked ? 1 : 0, vis: {}, sol: null, trk: null,
    };
    if (t.sol) p.sol = { yaw: r3(t.sol.yaw), pitch: r3(t.sol.pitch), tof: r2(t.sol.tof), aim: [r2(t.sol.aim.x), r2(t.sol.aim.y), r2(t.sol.aim.z)], range: r2(t.sol.range), lead: r3(t.sol.lead), ok: t.sol.ok ? 1 : 0 };
    for (const [id, k] of t.trackers) if (k.ready) p.vis[id] = r2(k.coast);
    if (t.target && t.sol) {
      const k = trackerOf(t, t.target);
      if (k) p.trk = { sp: r2(k.speed), hd: r3(k.heading), om: r3(k.omega), mn: r2(k.manoeuvre), path: k.path(t.sol.tof * 1.25, 10).map((q) => [r2(q.x), r2(q.z)]) };
    }
    return p;
  }

  /* ---------------- client side ---------------- */
  function netJoin(code) {
    if (game.net) return;
    code = String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
    if (code.length !== 5) { netStatus('ใส่รหัสห้อง 5 ตัวอักษรจากโฮสต์'); return; }
    const tr = MFTransport.pick();
    const net = { role: 'client', code, started: false, you: -1, acc: 0, seed: null, inp: null, shells: [], snapAt: 0, ended: false };
    game.net = net;
    netStatus(`กำลังเชื่อมต่อห้อง <b class="code">${code}</b>…`);
    $('hostBtn').disabled = true; $('joinBtn').disabled = true;
    net.handle = tr.join(code, (conn) => {
      net.conn = conn;
      conn.send({ type: 'hello', name: myName() });
      netStatus(`เชื่อมต่อห้อง <b class="code">${code}</b> แล้ว · รอโฮสต์กดเริ่ม`);
      $('start').classList.add('hidden');
      conn.onData(onNetMsg);
      conn.onClose(() => {
        if (!game.net || game.net !== net) return;
        netLeave(); toMenu(true);
        netStatus('การเชื่อมต่อกับโฮสต์หลุด — เข้าร่วมใหม่ได้');
      });
    }, (err) => {
      netLeave();
      netStatus(err === 'peer-unavailable' ? `ไม่พบห้อง ${esc(code)} — ตรวจรหัสอีกครั้ง หรือให้โฮสต์เปิดห้องค้างไว้` : `เชื่อมต่อไม่สำเร็จ (${esc(err)})`);
    });
  }
  function netLeave() {
    const net = game.net; if (!net) return;
    try { net.handle && net.handle.close(); } catch (e) { /* ignore */ }
    game.net = null;
    $('hostBtn').disabled = false; $('joinBtn').disabled = false;
    $('start').classList.remove('hidden'); $('start').textContent = 'เริ่มสงคราม · DEPLOY';
    $('netPlayers').textContent = '';
  }

  function onNetMsg(m) {
    const net = game.net; if (!net || !m) return;
    if (m.type === 'lobby') { $('netPlayers').textContent = `ในห้อง ${m.names.length} คน: ${m.names.join(', ')}`; return; }
    if (m.type === 'full') { netLeave(); netStatus('ห้องเต็มแล้ว (8 คน)'); return; }
    if (m.type === 'busy') { netStatus(`เชื่อมต่อห้อง <b class="code">${net.code}</b> แล้ว · โฮสต์กำลังเล่นอยู่ จะได้เข้ารอบการแข่งขันถัดไป`); return; }
    if (m.type === 'back') { net.started = false; toMenu(true); netStatus(`อยู่ในห้อง <b class="code">${net.code}</b> · รอโฮสต์เริ่มการแข่งขันใหม่`); $('start').classList.add('hidden'); return; }
    if (m.type === 'roster') {
      for (const t of game.tanks) { scene.remove(t.mesh.root); scene.remove(t.mesh.turret); }
      game.tanks = [];
      for (const r of m.tanks) {
        const t = new Tank({ name: r.name, team: r.team, color: r.color, human: r.human, input: r.id === m.you ? settings.inputs[0] : null, slot: -1 });
        t.id = r.id; t.remote = r.id !== m.you;
        t.spawn(0, 0, 0);
        game.tanks.push(t);
      }
      Object.assign(settings, m.set);
      net.you = m.you; net.seed = null; net.started = true; net.ended = false;
      game.demo = false; game.paused = false; game.round = 0;
      $('menu').classList.add('hidden'); $('end').classList.add('hidden');
      Audio.init(); if (Audio.ctx && Audio.ctx.state === 'suspended') Audio.ctx.resume();
      return;
    }
    if (m.type === 'snap' && net.started) applySnap(m);
  }

  const shellPool = [];
  function applySnap(m) {
    const net = game.net;
    const byId = new Map(game.tanks.map((t) => [t.id, t]));
    if (m.seed !== net.seed || m.rd !== game.round) {
      net.seed = m.seed; game.round = m.rd; settings.seed = m.seed;
      buildWorld(m.seed);
      for (const row of m.tk) { const t = byId.get(row[0]); if (t) { t.spawn(row[1], row[2], row[3]); t.net = null; } }
      setupViews();
    }
    Object.assign(settings, m.set);
    game.countdown = m.cd; game.roundTime = m.rt; game.endT = m.endT;
    game.wind = { x: m.wind[0], z: m.wind[1] };
    const z = world.zone; z.x = m.zone[0]; z.z = m.zone[1]; z.r = m.zone[2];
    for (const row of m.tk) {
      const t = byId.get(row[0]); if (!t) continue;
      t.net = { x: row[1], z: row[2], yaw: row[3], turYaw: row[5], pitch: row[6] };
      t.speed = row[4]; t.hp = row[7]; t.gear = row[9]; t.recoil = Math.max(t.recoil, row[10]); t.trackDmg = row[11] ? 1 : 0; t.hitFlash = Math.max(t.hitFlash, row[12]);
      t.wins = row[13]; t.stats.kills = row[14]; t.stats.dmg = row[15]; t.stats.shots = row[16]; t.stats.hits = row[17]; t.name = row[18];
      if (t.alive && !row[8]) { t.x = row[1]; t.z = row[2]; t.y = heightAt(t.x, t.z); t.turYaw = row[5]; t.alive = false; t.hp = 0; killVisual(t); }
    }
    net.shells = m.sh; net.snapAt = performance.now();
    m.ob.forEach((hp, i) => { const o = world.obstacles[i]; if (!o) return; if (hp === 0 && o.alive) damageBuilding(o, 1e6); else if (o.alive && hp < o.hp - 5) { o.hp = hp; o.mat.color.multiplyScalar(0.94); } });
    const seen = new Set();
    for (const [id, ti, x, y, zz, landed] of m.cr) {
      seen.add(id);
      let c = world.crates.find((q) => q.id === id);
      if (!c) { const mm = crateMesh(CRATE_TYPES[ti]); c = { id, ti, type: CRATE_TYPES[ti], mesh: mm.g, chute: mm.chute, landed: false }; world.crates.push(c); }
      c.x = x; c.y = y; c.z = zz;
      if (landed && !c.landed) { c.landed = true; c.mesh.remove(c.chute); }
      c.mesh.position.set(x, y, zz);
    }
    for (let i = world.crates.length - 1; i >= 0; i--) if (!seen.has(world.crates[i].id)) { scene.remove(world.crates[i].mesh); world.crates.splice(i, 1); }
    game.feed = m.fd.map(([text, color, t]) => ({ text, color, t }));
    if (m.msg) { game.msg = m.msg[0]; game.msgT = m.msg[1]; } else game.msgT = 0;
    for (const e of m.ev) {
      if (e[0] === 'fx' && FXraw[e[1]]) FXraw[e[1]](...e[2]);
      else if (e[0] === 'au' && AudioRaw[e[1]]) AudioRaw[e[1]]({ x: e[2][0], z: e[2][1] }, !!e[2][2]);
    }
    const me = byId.get(net.you), p = m.me;
    if (me && p) {
      me.reload = p.rl; me.ammo = p.am; me.smoke = p.sm; me.radar = p.ra; me.warn = p.wa; me.outside = !!p.out; me.autoLay = !!p.al;
      me.turretDmg = p.td; me.shake = Math.max(me.shake, p.shk); me.pk = p.pk; me.masked = !!p.mk;
      if (p.msg) { me.msg = p.msg[0]; me.msgT = p.msg[1]; }
      me.target = p.tg >= 0 ? byId.get(p.tg) || null : null;
      me.sol = p.sol ? { yaw: p.sol.yaw, pitch: p.sol.pitch, tof: p.sol.tof, aim: { x: p.sol.aim[0], y: p.sol.aim[1], z: p.sol.aim[2] }, range: p.sol.range, lead: p.sol.lead, ok: !!p.sol.ok } : null;
      me.trackers.clear();
      for (const id in p.vis) {
        const k = { ready: true, seen: true, coast: p.vis[id], speed: 0, heading: 0, omega: 0, manoeuvre: 1, pathPts: [] };
        if (p.trk && +id === p.tg) { k.speed = p.trk.sp; k.heading = p.trk.hd; k.omega = p.trk.om; k.manoeuvre = p.trk.mn; k.pathPts = p.trk.path.map(([x, zq]) => ({ x, z: zq })); }
        k.path = () => k.pathPts;
        me.trackers.set(+id, k);
      }
    }
    game.state = m.st;
    if (m.st === 'matchEnd' && !net.ended) { net.ended = true; showMatchEnd(); }
    if (m.st !== 'matchEnd') net.ended = false;
  }

  function clientStep(dt) {
    const net = game.net;
    game.time += dt;
    const me = game.tanks.find((t) => t.id === net.you);
    // controller -> host
    if (me) {
      me.input = settings.inputs[0];
      const c = readController(me);
      const a = net.inp || (net.inp = { gu: 0, gd: 0, fire: 0, next: 0, ammo: 0, smoke: 0, sight: 0, mdx: 0, mdy: 0 });
      for (const k of CTL_COUNTS) a[k] += c[CTL_MAP[k]] ? 1 : 0;
      a.steer = c.steer; a.trav = c.trav; a.elev = c.elev; a.lock = c.lock; a.mouse = c.mouse;
      a.mdx += c.mdx || 0; a.mdy += c.mdy || 0;
      if (c.sight) me.sight = !me.sight;
      net.acc += dt;
      if (net.acc >= 1 / 30 && net.conn) { net.acc = 0; net.conn.send({ type: 'in', c: a }); net.inp = null; }
    }
    // interpolate tanks
    const k = 1 - Math.exp(-dt * 14);
    for (const t of game.tanks) {
      if (t.net && t.alive) {
        t.x = lerp(t.x, t.net.x, k); t.z = lerp(t.z, t.net.z, k); t.y = heightAt(t.x, t.z);
        t.yaw += angDiff(t.net.yaw, t.yaw) * k; t.turYaw += angDiff(t.net.turYaw, t.turYaw) * k; t.pitch = lerp(t.pitch, t.net.pitch, k);
      }
      t.recoil = Math.max(0, t.recoil - dt * 3); t.hitFlash = Math.max(0, t.hitFlash - dt * 3); t.shake = Math.max(0, t.shake - dt * 1.6);
      t.msgT = Math.max(0, (t.msgT || 0) - dt);
      updateTankVisual(t, dt);
    }
    if (me && me.alive) {
      me.impTimer = (me.impTimer || 0) - dt;
      if (me.impTimer <= 0) { me.impTimer = 0.08; me.impact = F.trajectory(me.muzzle(), me.turYaw, me.pitch, F.AMMO[me.ammo], game.wind, heightAt, me.vel, 5); }
    }
    // shells: extrapolate from last snapshot
    const age = (performance.now() - net.snapAt) / 1000;
    const sh = net.shells || [];
    for (let i = 0; i < Math.max(sh.length, shellPool.length); i++) {
      if (i >= sh.length) { shellPool[i].visible = false; continue; }
      if (!shellPool[i]) { shellPool[i] = new T3.Mesh(shellGeo, new T3.MeshBasicMaterial({ color: 0xffe08a })); scene.add(shellPool[i]); }
      const q = sh[i], mesh = shellPool[i];
      const x = q[0] + q[3] * age, y = q[1] + q[4] * age - 4.9 * age * age, zz = q[2] + q[5] * age;
      mesh.visible = true; mesh.material.color.setHex(q[6] ? F.AMMO.HE.color : F.AMMO.AP.color);
      mesh.position.set(x, y, zz); mesh.lookAt(x + q[3], y + q[4], zz + q[5]);
      FXraw.trail(x, y, zz, q[6] ? [1, 0.55, 0.25] : [1, 0.9, 0.6]);
    }
    const zn = world.zone; zn.mesh.scale.set(zn.r, 1, zn.r); zn.mesh.position.set(zn.x, 10, zn.z);
    for (const w of world.wrecks) { if (w.fire > 0) { w.fire -= dt; if (Math.random() < 0.6) FXraw.fire(w.x, heightAt(w.x, w.z) + 1.5, w.z); } }
    for (const c of world.crates) c.mesh.rotation.y += dt * 0.6;
    fxAdd.update(dt); fxSmoke.update(dt);
    for (const f of game.feed) f.t -= dt;
    game.msgT -= dt;
    if (Audio.ctx && me) { Audio.engine.frequency.value = 34 + Math.abs(me.speed) * 3.2; Audio.engineGain.gain.value = me.alive && (game.state === 'play' || game.state === 'countdown') ? 0.06 + Math.abs(me.speed) * 0.006 : 0; }
    pressed.clear(); mouse.dx = mouse.dy = 0; mouse.leftPressed = mouse.rightPressed = false; mouse.wheel = 0;
  }

  $('hostBtn').addEventListener('click', netHost);
  $('joinBtn').addEventListener('click', () => netJoin($('joinCode').value));
  (function autoJoin() {
    const q = new URLSearchParams(location.search);
    const code = q.get('join');
    if (code) { $('joinCode').value = code.toUpperCase().slice(0, 5); netStatus('ใส่ชื่อของคุณแล้วกด “เข้าร่วม”'); }
    if ((!MFTransport.PeerTransport.available() || window.self !== window.top) && !q.get('net')) $('onlineNote').textContent = 'โหมดออนไลน์ต้องเปิดจาก GitHub Pages (หน้านี้บล็อกการเชื่อมต่อ peer-to-peer)';
  })();

  /* ================================================================ */
  /* Main loop                                                         */
  /* ================================================================ */
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (!game.paused) {
      if (game.demo && game.state === 'roundEnd') game.endT = Math.min(game.endT, 3);
      if (game.demo && game.state === 'matchEnd') demo();
      if (game.net && game.net.role === 'client' && game.net.started) clientStep(dt); else step(dt);
      if (game.demo) { for (const t of game.tanks) t.wins = 0; }
    }
    render(dt);
    requestAnimationFrame(frame);
  }
  resize();
  refreshMenu();
  demo();
  requestAnimationFrame(frame);

  // expose for automated tests
  window.__MF = { settings, startMatch, game, heightAt, step, netHost, netJoin };
})();
