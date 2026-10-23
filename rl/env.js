/*
 * Headless training arena for the RL driving policy.
 * Mirrors the game's rules (js/game.js): terrain, buildings, always-moving
 * tank dynamics, FCS gunnery, ballistics, armour and the shrinking zone,
 * without any rendering. Gunnery for every tank is the scripted FCS gunner;
 * only the DRIVING of "rl" tanks comes from the neural policy.
 */
'use strict';
const F = require('../js/fcs.js');
const P = require('../js/rl-policy.js');

const HALF = 175;
const GEARS = { '-1': -6.2, '1': 6.8, '2': 10.8, '3': 14.8 };
const GEAR_ORDER = [-1, 1, 2, 3];
const TRAVERSE = 0.78, ELEV = 0.22, PITCH_MIN = -0.14, PITCH_MAX = 0.36;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const angDiff = (a, b) => { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
function seeded(seed) { let s = seed >>> 0 || 1; return () => ((s = Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9 >>> 0) / 4294967296); }

class Arena {
  constructor(seed, opts) {
    this.opts = Object.assign({ nScript: 2, nRL: 1, duration: 75, dt: 1 / 20, botSkill: 0.62 }, opts || {});
    this.rng = seeded(seed * 7919 + 13);
    const r = seeded(seed);
    this.hs = { a: r() * 6, b: r() * 6, c: r() * 6 };
    this.obstacles = [];
    let tries = 0;
    while (this.obstacles.length < 26 && tries++ < 400) {
      const x = (r() * 2 - 1) * (HALF - 30), z = (r() * 2 - 1) * (HALF - 30);
      if (Math.hypot(x, z) > 118 && Math.hypot(x, z) < 160) continue;
      const w = 7 + r() * 12, d = 7 + r() * 12, h = 5 + r() * 8;
      if (this.obstacles.some((o) => Math.abs(o.x - x) < (o.w + w) / 2 + 10 && Math.abs(o.z - z) < (o.d + d) / 2 + 10)) continue;
      const gy = Math.min(this.heightAt(x - w / 2, z - d / 2), this.heightAt(x + w / 2, z + d / 2), this.heightAt(x, z)) - 1;
      r(); // material pick in the game
      this.obstacles.push({ x, z, w, d, h, base: gy, top: gy + h + 1, hp: 100, alive: true });
    }
    this.time = 0;
    this.zone = { x: 0, z: 0, r: 215, tx: 0, tz: 0 };
    this.wind = { x: (this.rng() - 0.5) * 10, z: (this.rng() - 0.5) * 10 };
    this.shells = [];
    this.tanks = [];
    const n = this.opts.nScript + this.opts.nRL;
    const off = this.rng() * Math.PI * 2;
    for (let i = 0; i < n; i++) {
      const a = off + (i / n) * Math.PI * 2;
      const x = Math.sin(a) * 140, z = Math.cos(a) * 140;
      const t = {
        id: i, team: i, driver: i < this.opts.nRL ? 'rl' : 'script',
        x, z, y: this.heightAt(x, z), yaw: Math.atan2(-x, -z), speed: 0, gear: 2, kx: 0, kz: 0,
        turYaw: Math.atan2(-x, -z), pitch: 0.02, cmdYaw: 0, cmdPitch: 0.02,
        hp: 100, alive: true, reload: 1.5, ammo: 'AP', trackDmg: 0, turretDmg: 0,
        trackers: new Map(), target: null, sol: null, pk: 0, warn: 0, masked: false,
        skill: this.opts.botSkill * (0.9 + this.rng() * 0.2),
        bot: { t: 0, jinkT: 0, jink: 0, orbit: this.rng() < 0.5 ? -1 : 1, errT: 0, aimErrYaw: 0, aimErrPitch: 0, acquire: 0, stuck: 0, reverseT: 0, lastShot: 0 },
        stats: { dmgDealt: 0, dmgTaken: 0, outside: 0, bump: 0, kills: 0, survived: 0 },
      };
      this.tanks.push(t);
    }
    this.stepN = 0;
  }
  heightAt(x, z) {
    const s = this.hs;
    let h = 5.2 * Math.sin(x * 0.017 + s.a) * Math.cos(z * 0.0145 + s.b)
      + 2.6 * Math.sin(x * 0.047 + s.c) * Math.sin(z * 0.041 + s.a * 0.7)
      + 1.1 * Math.sin((x + z) * 0.09 + s.b);
    const e = Math.max(Math.abs(x), Math.abs(z));
    if (e > HALF - 20) h += ((e - (HALF - 20)) / 20) ** 2 * 10;
    return h;
  }
  gauss() { let u = 0, v = 0; while (!u) u = this.rng(); while (!v) v = this.rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

  segBox(a, b, o) {
    let t0 = 0, t1 = 1;
    const d = [b.x - a.x, b.y - a.y, b.z - a.z], p = [a.x, a.y, a.z];
    const mn = [o.x - o.w / 2, o.base, o.z - o.d / 2], mx = [o.x + o.w / 2, o.alive ? o.top : o.base + 2.2, o.z + o.d / 2];
    for (let i = 0; i < 3; i++) {
      if (Math.abs(d[i]) < 1e-9) { if (p[i] < mn[i] || p[i] > mx[i]) return false; continue; }
      let u0 = (mn[i] - p[i]) / d[i], u1 = (mx[i] - p[i]) / d[i];
      if (u0 > u1) { const t = u0; u0 = u1; u1 = t; }
      t0 = Math.max(t0, u0); t1 = Math.min(t1, u1);
      if (t0 > t1) return false;
    }
    return true;
  }
  los(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, L = Math.hypot(dx, dz), n = Math.ceil(L / 6);
    for (let i = 1; i < n; i++) { const t = i / n; if (this.heightAt(a.x + dx * t, a.z + dz * t) > a.y + dy * t) return false; }
    for (const o of this.obstacles) if (this.segBox(a, b, o)) return false;
    return true;
  }
  probe(x, z, yaw, dist) {
    for (let d = 4; d <= dist; d += 4) {
      const px = x + Math.sin(yaw) * d, pz = z + Math.cos(yaw) * d;
      if (Math.abs(px) > HALF - 10 || Math.abs(pz) > HALF - 10) return d;
      for (const o of this.obstacles) if (o.alive && Math.abs(px - o.x) < o.w / 2 + 3.5 && Math.abs(pz - o.z) < o.d / 2 + 3.5) return d;
    }
    return dist + 1;
  }
  vel(t) { return { x: Math.sin(t.yaw) * t.speed + t.kx, z: Math.cos(t.yaw) * t.speed + t.kz }; }
  trk(t, u) { const k = t.trackers.get(u.id); return k && k.ready ? k : null; }

  damage(u, dmg, src) {
    if (!u.alive) return;
    u.hp -= dmg; u.stats.dmgTaken += dmg;
    if (src && src !== u) src.stats.dmgDealt += dmg;
    if (u.hp <= 0) { u.alive = false; if (src && src !== u) src.stats.kills++; }
  }

  sensors(dt) {
    for (const t of this.tanks) {
      if (!t.alive) continue;
      const eye = { x: t.x, y: t.y + 3.1, z: t.z };
      for (const u of this.tanks) {
        if (u === t || !u.alive) { t.trackers.delete(u.id); continue; }
        let k = t.trackers.get(u.id);
        if (!k) { k = new F.MotionTracker({ accelSigma: 3 }); t.trackers.set(u.id, k); }
        const d = Math.hypot(u.x - t.x, u.z - t.z);
        const vis = d < 330 && (this.los(eye, { x: u.x, y: u.y + 2.2, z: u.z }) || this.los(eye, { x: u.x, y: u.y + 2.9, z: u.z }));
        if (vis) { const sg = 0.22 + d * 0.0024; k.update(dt, { x: u.x + this.gauss() * sg, z: u.z + this.gauss() * sg }, sg); }
        else { k.update(dt, null, 1); if (k.coast > 6) k.reset(); }
      }
    }
  }

  gunnery(t, dt, doSolve, doPk) {
    const b = t.bot;
    b.t -= dt; b.errT -= dt;
    if (b.t <= 0) {
      b.t = 0.35;
      let best = null, bs = 1e9;
      for (const u of this.tanks) {
        if (!u.alive || u === t) continue;
        const k = this.trk(t, u); if (!k || k.coast >= 3) continue;
        const s = Math.hypot(u.x - t.x, u.z - t.z) + (k.coast < 0.15 ? 0 : 120) + u.hp * 0.6 + (u === t.target ? -40 : 0);
        if (s < bs) { bs = s; best = u; }
      }
      if (best !== t.target) { t.target = best; b.acquire = lerp(1.2, 0.25, t.skill); }
    }
    if (t.target && (!t.target.alive || !this.trk(t, t.target))) t.target = null;
    if (doSolve) {
      t.sol = null;
      if (t.target) {
        const k = this.trk(t, t.target);
        const p = { x: t.x, y: t.y + 2.55, z: t.z }, est = k.predict(0);
        const y0 = Math.atan2(est.x - p.x, est.z - p.z);
        const sol = F.solveFiring({ muzzle: { x: p.x + Math.sin(y0) * 4.8, y: p.y + 0.15, z: p.z + Math.cos(y0) * 4.8 }, vel: this.vel(t) }, k,
          { ammo: F.AMMO[t.ammo], wind: this.wind, targetHeight: 1.45, pitchMin: PITCH_MIN, pitchMax: PITCH_MAX, heightAt: (x, z) => this.heightAt(x, z) });
        t.sol = sol.aim ? sol : null;
      }
    }
    if (doPk && t.sol && t.target) {
      const k = this.trk(t, t.target);
      const disp = 0.0014 + 0.0011 * Math.abs(t.speed) / 14.8;
      const pk = F.hitProbability(t.sol, k, { muzzle: F.AMMO[t.ammo].muzzle, dispersion: disp, samples: 24, rng: () => this.rng(), layError: { yaw: angDiff(t.turYaw, t.sol.yaw), pitch: t.pitch - t.sol.pitch } });
      const vis = k.coast < 0.15;
      t.pk = lerp(t.pk, (t.sol.ok ? pk : 0) * (vis ? 1 : 0.35), 0.45);
    } else if (!t.sol) t.pk = 0;
    let fire = false;
    if (t.target && t.sol) {
      if (b.errT <= 0) { b.errT = 0.6 + this.rng() * 0.8; const e = (1 - t.skill) * 0.03 + 0.0015; b.aimErrYaw = this.gauss() * e; b.aimErrPitch = this.gauss() * e * 0.3; }
      b.acquire -= dt;
      if (b.acquire <= 0) { t.cmdYaw = t.sol.yaw + b.aimErrYaw; t.cmdPitch = clamp(t.sol.pitch + b.aimErrPitch, PITCH_MIN, PITCH_MAX); }
      else t.cmdYaw = Math.atan2(t.target.x - t.x, t.target.z - t.z);
      const thr = lerp(0.3, 0.17, t.skill);
      b.lastShot += dt;
      const vis = this.trk(t, t.target).coast < 0.15;
      if (t.reload <= 0 && b.acquire <= 0 && vis && (t.pk >= thr || (b.lastShot > 4.5 && t.pk > 0.06))) { fire = true; b.lastShot = 0; }
      const tg = t.target;
      const aspect = Math.cos(angDiff(Math.atan2(t.x - tg.x, t.z - tg.z), tg.yaw));
      const want = aspect > 0.7 && t.sol.range > 150 ? 'HE' : (t.sol.range < 60 && tg.hp < 30 ? 'HE' : 'AP');
      if (want !== t.ammo && t.reload > 1) t.ammo = want;
    } else { t.cmdYaw = t.yaw; t.cmdPitch = 0.02; }
    // slew
    const rate = TRAVERSE;
    t.turYaw += clamp(angDiff(t.cmdYaw, t.turYaw), -rate * dt, rate * dt);
    t.pitch += clamp(t.cmdPitch - t.pitch, -ELEV * dt, ELEV * dt);
    if (fire) this.fire(t);
  }

  scriptedDrive(t, dt) {
    const b = t.bot, z = this.zone;
    b.jinkT -= dt;
    const dzn = Math.hypot(t.x - z.x, t.z - z.z);
    let desired;
    if (dzn > z.r - 18) desired = Math.atan2(z.x - t.x, z.z - t.z);
    else if (t.target) {
      const tg = t.target, d = Math.hypot(tg.x - t.x, tg.z - t.z), brg = Math.atan2(tg.x - t.x, tg.z - t.z);
      const pref = 95 + 70 * t.skill;
      let off = Math.PI / 2;
      if (d > pref + 35) off = 35 * Math.PI / 180; else if (d < pref - 35) off = 125 * Math.PI / 180;
      desired = brg + off * b.orbit;
    } else desired = Math.atan2(z.x - t.x + Math.sin(this.time * 0.2 + t.id) * 60, z.z - t.z + Math.cos(this.time * 0.17 + t.id) * 60);
    if (b.jinkT <= 0) {
      b.jinkT = (1.2 + this.rng() * 2.3) * (t.warn > 0 ? 0.45 : 1);
      b.jink = (0.15 + this.rng() * 0.45) * (t.warn > 0 ? 1.4 : 1) * (this.rng() < 0.5 ? -1 : 1);
      if (this.rng() < 0.12) b.orbit *= -1;
    }
    desired += b.jink * t.skill;
    if (this.probe(t.x, t.z, desired, 22) < 22) {
      const l = this.probe(t.x, t.z, desired + 0.7, 22), r = this.probe(t.x, t.z, desired - 0.7, 22);
      desired += l >= r ? 0.9 : -0.9;
    }
    const err = angDiff(desired, t.yaw);
    let steer = clamp(-err * 2.2, -1, 1);
    let gear = Math.abs(err) > 1.1 ? 1 : Math.abs(err) > 0.5 ? 2 : 3;
    if (t.warn > 0) gear = Math.max(gear, 2);
    if (Math.abs(t.speed) < 1.2 && t.gear > 0) b.stuck += dt; else b.stuck = Math.max(0, b.stuck - dt);
    if (b.stuck > 1.2) { b.reverseT = 1.6; b.stuck = 0; }
    if (b.reverseT > 0) { b.reverseT -= dt; gear = -1; steer = -steer; }
    return { steer, gear };
  }

  rlObs(t) {
    let tg = null;
    if (t.target) {
      const k = this.trk(t, t.target);
      if (k) { const p = k.predict(0), v = k.vel; tg = { x: p.x, z: p.z, vx: v.x, vz: v.z, yaw: t.target.yaw, turYaw: t.target.turYaw }; }
    }
    return P.features({ x: t.x, z: t.z, yaw: t.yaw, speed: t.speed, hp: t.hp, warn: t.warn, id: t.id }, tg, this.zone, (yaw, d) => this.probe(t.x, t.z, yaw, d), this.time);
  }

  drive(t, cmd, dt) {
    // gear changes one step at a time, like a player pressing up/down
    const i = GEAR_ORDER.indexOf(t.gear), j = GEAR_ORDER.indexOf(cmd.gear);
    if (j > i) t.gear = GEAR_ORDER[i + 1]; else if (j < i) t.gear = GEAR_ORDER[i - 1];
    const fx = Math.sin(t.yaw), fz = Math.cos(t.yaw);
    const grade = (this.heightAt(t.x + fx * 2.5, t.z + fz * 2.5) - this.heightAt(t.x - fx * 2.5, t.z - fz * 2.5)) / 5;
    let target = GEARS[t.gear] * (t.trackDmg > 0 ? 0.5 : 1);
    target *= clamp(1 - Math.sign(target) * grade * 1.9, 0.45, 1.25);
    const acc = target > t.speed ? 3.2 : 6.5;
    t.speed += clamp(target - t.speed, -acc * dt, acc * dt);
    const turnRate = 0.95 * (1 - 0.38 * Math.abs(t.speed) / 14.8) * (t.trackDmg > 0 ? 0.55 : 1);
    const steer = clamp(cmd.steer, -1, 1);
    t.yaw -= steer * turnRate * dt * (t.speed < -0.5 ? -1 : 1);
    if (Math.abs(steer) > 0.3) t.speed *= 1 - 0.12 * dt;
    t.kx *= Math.max(0, 1 - 3 * dt); t.kz *= Math.max(0, 1 - 3 * dt);
    const v = this.vel(t);
    let nx = t.x + v.x * dt, nz = t.z + v.z * dt;
    const lim = HALF - 4;
    if (Math.abs(nx) > lim) { nx = Math.sign(nx) * lim; t.speed *= 0.6; t.stats.bump += dt; }
    if (Math.abs(nz) > lim) { nz = Math.sign(nz) * lim; t.speed *= 0.6; t.stats.bump += dt; }
    for (const o of this.obstacles) {
      if (!o.alive) continue;
      const cx = clamp(nx, o.x - o.w / 2, o.x + o.w / 2), cz = clamp(nz, o.z - o.d / 2, o.z + o.d / 2);
      const dx = nx - cx, dz = nz - cz, d = Math.hypot(dx, dz);
      if (d < 3.1) { if (d < 1e-4) { nx = t.x; nz = t.z; continue; } nx = cx + dx / d * 3.1; nz = cz + dz / d * 3.1; t.speed *= 1 - 2.2 * dt; t.stats.bump += dt; }
    }
    for (const u of this.tanks) {
      if (u === t || !u.alive) continue;
      const dx = nx - u.x, dz = nz - u.z, d = Math.hypot(dx, dz);
      if (d < 4.8 && d > 1e-4) { const p = (4.8 - d) / 2; nx += dx / d * p; nz += dz / d * p; u.x -= dx / d * p; u.z -= dz / d * p; }
    }
    t.x = nx; t.z = nz; t.y = this.heightAt(nx, nz);
  }

  fire(t) {
    if (t.reload > 0) return;
    const a = F.AMMO[t.ammo];
    const disp = 0.0014 + 0.0011 * Math.abs(t.speed) / 14.8;
    const yaw = t.turYaw + this.gauss() * disp, pitch = t.pitch + this.gauss() * disp;
    const c = Math.cos(t.pitch);
    const m = { x: t.x + Math.sin(t.turYaw) * c * 4.8, y: t.y + 2.55 + Math.sin(t.pitch) * 4.8, z: t.z + Math.cos(t.turYaw) * c * 4.8 };
    const v = F.muzzleVelocity(yaw, pitch, a.muzzle, this.vel(t));
    this.shells.push({ x: m.x, y: m.y, z: m.z, vx: v.x, vy: v.y, vz: v.z, t: 0, ammo: a, owner: t });
    t.reload = a.reload;
  }

  explode(s, x, y, z, direct) {
    const a = s.ammo;
    for (const u of this.tanks) {
      if (!u.alive || u === direct) continue;
      const d = Math.hypot(u.x - x, u.y + 1.2 - y, u.z - z);
      if (d < a.splash + 2) {
        const f = 1 - clamp((d - 1.5) / a.splash, 0, 1), dmg = a.splashDmg * f;
        if (dmg > 0.5) { this.damage(u, dmg, s.owner); if (a.id === 'HE' && f > 0.45 && this.rng() < 0.5) u.trackDmg = Math.max(u.trackDmg, 5); }
      }
    }
  }

  shellsStep(dt) {
    const sub = 3, h = dt / sub;
    for (let i = this.shells.length - 1; i >= 0; i--) {
      const s = this.shells[i]; let dead = false;
      for (let k = 0; k < sub && !dead; k++) {
        F.stepShell(s, s.ammo, this.wind, h);
        for (const u of this.tanks) {
          if (!u.alive || (u === s.owner && s.t < 0.15)) continue;
          const dx = s.x - u.x, dz = s.z - u.z; if (dx * dx + dz * dz > 30) continue;
          const c = Math.cos(-u.yaw), sn = Math.sin(-u.yaw), lx = dx * c + dz * sn, lz = -dx * sn + dz * c, ly = s.y - u.y;
          const tdx = s.x - (u.x - Math.sin(u.turYaw) * 0.25), tdz = s.z - (u.z - Math.cos(u.turYaw) * 0.25);
          const inT = ly > 2.05 && ly < 3.05 && tdx * tdx + tdz * tdz < 2.56;
          const inH = Math.abs(lx) < 1.75 && Math.abs(lz) < 3.3 && ly > 0.25 && ly < 2.1;
          if (inT || inH) {
            const sp = Math.hypot(s.vx, s.vy, s.vz) || 1;
            const res = F.resolveArmor(u.yaw, { x: s.vx / sp, y: s.vy / sp, z: s.vz / sp }, inT ? 'turret' : 'hull', u.turYaw, inT ? 0.2 : 0.45, s.ammo, Math.hypot(s.x - s.owner.x, s.z - s.owner.z));
            this.damage(u, res.damage, s.owner);
            if (res.ricochet) { dead = true; break; }
            if (res.penetrated && s.ammo.id === 'AP' && this.rng() < 0.35) u.trackDmg = Math.max(u.trackDmg, 6);
            this.explode(s, s.x, s.y, s.z, u); dead = true; break;
          }
        }
        if (dead) break;
        for (const o of this.obstacles) {
          if (Math.abs(s.x - o.x) < o.w / 2 && Math.abs(s.z - o.z) < o.d / 2 && s.y < (o.alive ? o.top : o.base + 2.2) && s.y > o.base) {
            this.explode(s, s.x, s.y, s.z, null);
            o.hp -= s.ammo.id === 'HE' ? 30 : 16; if (o.hp <= 0) o.alive = false;
            dead = true; break;
          }
        }
        if (dead) break;
        const gh = this.heightAt(s.x, s.z);
        if (s.y <= gh) { this.explode(s, s.x, gh, s.z, null); dead = true; }
        else if (s.t > 7) dead = true;
      }
      if (dead) this.shells.splice(i, 1);
    }
  }

  zoneStep(dt) {
    const z = this.zone, T = this.time;
    // compressed schedule: the circle starts closing at 10 s
    const target = T < 10 ? 215 : Math.max(32, 215 - (T - 10) * 2.8);
    z.r = lerp(z.r, target, 1 - Math.exp(-dt * 0.8));
    if (this.rng() < dt * 0.08) { z.tx = (this.rng() - 0.5) * 90; z.tz = (this.rng() - 0.5) * 90; }
    const k = 1 - Math.exp(-dt * 0.05), f = clamp((215 - z.r) / 150, 0, 1);
    z.x = lerp(z.x, z.tx * f, k); z.z = lerp(z.z, z.tz * f, k);
    for (const t of this.tanks) {
      if (!t.alive) continue;
      if (Math.hypot(t.x - z.x, t.z - z.z) > z.r) { this.damage(t, 4.5 * dt, null); t.stats.outside += dt; if (this.rng() < dt * 0.6) this.damage(t, 7, null); }
    }
  }

  /** @param policy weights (Float32Array) used for every rl tank */
  step(policy) {
    const dt = this.opts.dt;
    this.time += dt; this.stepN++;
    this.sensors(dt);
    for (const t of this.tanks) t.warn = 0;
    for (const t of this.tanks) if (t.alive && t.target && t.sol && t.pk > 0.3) t.target.warn = Math.max(t.target.warn, t.pk);
    const doSolve = this.stepN % 2 === 0, doPk = this.stepN % 4 === 0;
    for (const t of this.tanks) {
      if (!t.alive) continue;
      t.reload = Math.max(0, t.reload - dt); t.trackDmg = Math.max(0, t.trackDmg - dt);
      this.gunnery(t, dt, doSolve, doPk);
      const cmd = t.driver === 'rl' ? P.act(policy, this.rlObs(t)) : this.scriptedDrive(t, dt);
      this.drive(t, cmd, dt);
      t.stats.survived += dt;
    }
    this.shellsStep(dt);
    this.zoneStep(dt);
  }

  done() {
    const alive = this.tanks.filter((t) => t.alive);
    return this.time >= this.opts.duration || alive.length <= 1 || !this.tanks.some((t) => t.driver === 'rl' && t.alive);
  }

  run(policy) {
    while (!this.done()) this.step(policy);
    return this;
  }
}

/** Fitness of the rl tank(s) for one episode. */
function fitness(arena) {
  let f = 0;
  for (const t of arena.tanks) {
    if (t.driver !== 'rl') continue;
    const s = t.stats;
    f += s.dmgDealt * 1.0 - s.dmgTaken * 1.4 + s.kills * 30 - s.outside * 3 - s.bump * 2 + s.survived * 0.4;
    if (t.alive) f += 40;
    if (t.alive && arena.tanks.filter((u) => u.alive).length === 1) f += 60; // last tank standing
  }
  return f;
}

module.exports = { Arena, fitness, seeded };
