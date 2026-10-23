/*
 * Momentum Front — Fire-Control System (FCS) AI
 * --------------------------------------------------------------
 * Pure math, no rendering. Used by the game for:
 *   1. Ballistics     : 3-D shell flight with gravity, quadratic air drag and wind.
 *   2. MotionTracker  : Kalman filter that estimates a moving tank's position,
 *                       velocity, turn rate and the uncertainty of all three.
 *   3. solveFiring    : iterative intercept solver -> turret yaw, gun elevation,
 *                       time of flight and aim point (lead) for a moving target.
 *   4. hitProbability : Monte-Carlo estimate of P(hit) from tracker covariance
 *                       and gun dispersion.
 *   5. Armor          : line-of-sight armour thickness, penetration fall-off,
 *                       ricochet.
 *
 * Coordinates: x/z = ground plane, y = up. Units: metres, seconds, radians.
 * Works in the browser (window.FCS) and in Node (module.exports) for tests.
 *
 * (c) 2026 Narisan Nakakes — MIT License
 */
(function (root) {
  'use strict';

  const G = 9.81;

  /* ------------------------------------------------------------------ */
  /* Ammunition                                                          */
  /* ------------------------------------------------------------------ */
  const AMMO = {
    AP: {
      id: 'AP', name: 'APFSDS', muzzle: 165, drag: 0.00035, damage: 34,
      pen0: 150, penLossPer100m: 6, splash: 1.6, splashDmg: 6, reload: 2.6,
      color: 0xffe08a,
    },
    HE: {
      id: 'HE', name: 'HE-FRAG', muzzle: 98, drag: 0.0009, damage: 22,
      pen0: 45, penLossPer100m: 0, splash: 7.5, splashDmg: 26, reload: 3.4,
      color: 0xff7a3a,
    },
  };

  /* ------------------------------------------------------------------ */
  /* Ballistics                                                          */
  /* ------------------------------------------------------------------ */
  function stepShell(s, ammo, wind, dt) {
    // air-relative velocity -> quadratic drag
    const rx = s.vx - wind.x, ry = s.vy, rz = s.vz - wind.z;
    const sp = Math.hypot(rx, ry, rz);
    const k = ammo.drag * sp;
    const ax = -k * rx, ay = -G - k * ry, az = -k * rz;
    // semi-implicit Euler (stable enough at 1/120 s)
    s.vx += ax * dt; s.vy += ay * dt; s.vz += az * dt;
    s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
    s.t += dt;
    return s;
  }

  function muzzleVelocity(yaw, pitch, speed, carrier) {
    // yaw: 0 = +z, positive = towards +x
    const c = Math.cos(pitch);
    return {
      x: Math.sin(yaw) * c * speed + (carrier ? carrier.x : 0),
      y: Math.sin(pitch) * speed,
      z: Math.cos(yaw) * c * speed + (carrier ? carrier.z : 0),
    };
  }

  /**
   * Fly a shell until it reaches downrange distance D along bearing `yaw`
   * (direct-fire geometry). Returns height and cross-range at that plane.
   */
  function flyToRange(p0, yaw, pitch, ammo, wind, D, carrier, dt, refYaw) {
    dt = dt || 1 / 120;
    const v = muzzleVelocity(yaw, pitch, ammo.muzzle, carrier);
    const s = { x: p0.x, y: p0.y, z: p0.z, vx: v.x, vy: v.y, vz: v.z, t: 0 };
    const ry = refYaw === undefined ? yaw : refYaw; // measuring frame
    const fx = Math.sin(ry), fz = Math.cos(ry);
    let prevDown = 0, prev = null;
    for (let i = 0; i < 2400; i++) {
      prev = { x: s.x, y: s.y, z: s.z, t: s.t };
      stepShell(s, ammo, wind, dt);
      const dx = s.x - p0.x, dz = s.z - p0.z;
      const down = dx * fx + dz * fz;
      if (down >= D) {
        const f = (D - prevDown) / Math.max(1e-6, down - prevDown);
        const x = prev.x + (s.x - prev.x) * f;
        const y = prev.y + (s.y - prev.y) * f;
        const z = prev.z + (s.z - prev.z) * f;
        const t = prev.t + (s.t - prev.t) * f;
        const cross = (x - p0.x) * fz - (z - p0.z) * fx; // + = right of bearing
        return { ok: true, x, y, z, t, cross };
      }
      prevDown = down;
      if (s.y < p0.y - 400 || s.vy < -400) break;
    }
    return { ok: false };
  }

  /** Full trajectory (for the HUD arc / impact preview). */
  function trajectory(p0, yaw, pitch, ammo, wind, heightAt, carrier, maxT) {
    const v = muzzleVelocity(yaw, pitch, ammo.muzzle, carrier);
    const s = { x: p0.x, y: p0.y, z: p0.z, vx: v.x, vy: v.y, vz: v.z, t: 0 };
    const pts = [{ x: s.x, y: s.y, z: s.z }];
    const dt = 1 / 60;
    maxT = maxT || 6;
    while (s.t < maxT) {
      stepShell(s, ammo, wind, dt);
      if ((pts.length & 1) === 0) pts.push({ x: s.x, y: s.y, z: s.z });
      if (heightAt && s.y <= heightAt(s.x, s.z)) {
        pts.push({ x: s.x, y: heightAt(s.x, s.z), z: s.z });
        return { pts, impact: pts[pts.length - 1], t: s.t };
      }
    }
    return { pts, impact: null, t: s.t };
  }

  /* ------------------------------------------------------------------ */
  /* Motion tracker (Kalman filter, per-axis constant-velocity model     */
  /* + turn-rate estimator for curved paths)                             */
  /* ------------------------------------------------------------------ */
  /** Quadratic least-squares fit p(t)=p0+v*t+0.5*a*t^2 around time t0. */
  function quadFit(h, t0) {
    const n = h.length;
    if (n < 12 || h[n - 1].t - h[0].t < 0.6) return null;
    // normal equations for [1, t, t^2/2]
    let S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], bx = [0, 0, 0], bz = [0, 0, 0];
    for (const p of h) {
      const t = p.t - t0, r = [1, t, 0.5 * t * t];
      for (let i = 0; i < 3; i++) {
        bx[i] += r[i] * p.x; bz[i] += r[i] * p.z;
        for (let j = 0; j < 3; j++) S[i][j] += r[i] * r[j];
      }
    }
    const solve3 = (A, b) => {
      const M = A.map((row, i) => row.concat([b[i]]));
      for (let c = 0; c < 3; c++) {
        let piv = c;
        for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
        [M[c], M[piv]] = [M[piv], M[c]];
        if (Math.abs(M[c][c]) < 1e-12) return null;
        for (let r = 0; r < 3; r++) if (r !== c) {
          const f = M[r][c] / M[c][c];
          for (let k = c; k < 4; k++) M[r][k] -= f * M[c][k];
        }
      }
      return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
    };
    const X = solve3(S, bx), Z = solve3(S, bz);
    if (!X || !Z) return null;
    return { vx: X[1], vz: Z[1], ax: X[2], az: Z[2] };
  }

  class MotionTracker {
    constructor(opts) {
      opts = opts || {};
      this.accelSigma = opts.accelSigma || 3.0;   // m/s^2 manoeuvre noise
      this.reset();
    }
    reset() {
      this.init = false;
      this.t = 0;
      this.ax = null; this.az = null;
      this.omega = 0; this.omegaVar = 0.05;
            this.coast = 0;            // seconds without a measurement
      this.innovation = 0;       // smoothed measurement residual (m)
      this.manoeuvre = 1.0;      // estimated unpredictable accel (m/s^2)
      this.hist = [];
    }
    _axisInit(p) { return { x: p, v: 0, P: [[4, 0], [0, 100]] }; }
    _axisPredict(a, dt) {
      const q = this.accelSigma * this.accelSigma;
      a.x += a.v * dt;
      const P = a.P;
      const p00 = P[0][0] + dt * (P[1][0] + P[0][1]) + dt * dt * P[1][1] + q * dt ** 4 / 4;
      const p01 = P[0][1] + dt * P[1][1] + q * dt ** 3 / 2;
      const p11 = P[1][1] + q * dt * dt;
      a.P = [[p00, p01], [p01, p11]];
    }
    _axisUpdate(a, z, R) {
      const P = a.P;
      const S = P[0][0] + R;
      const k0 = P[0][0] / S, k1 = P[1][0] / S;
      const y = z - a.x;
      a.x += k0 * y; a.v += k1 * y;
      a.P = [
        [(1 - k0) * P[0][0], (1 - k0) * P[0][1]],
        [P[1][0] - k1 * P[0][0], P[1][1] - k1 * P[0][1]],
      ];
      return y;
    }
    /** @param meas {x,z} or null (no line of sight / smoke) */
    update(dt, meas, sigma) {
      if (!this.init) {
        if (!meas) return;
        this.ax = this._axisInit(meas.x);
        this.az = this._axisInit(meas.z);
        this.init = true;
        return;
      }
      this._axisPredict(this.ax, dt);
      this._axisPredict(this.az, dt);
      // rotate velocity by estimated turn rate (coordinated-turn prior)
      if (Math.abs(this.omega) > 1e-3) {
        const a = this.omega * dt, c = Math.cos(a), s = Math.sin(a);
        const vx = this.ax.v, vz = this.az.v;
        this.ax.v = vx * c + vz * s;
        this.az.v = -vx * s + vz * c;
      }
      this.t += dt;
      if (!meas) {
        this.coast += dt;
        this.omegaVar = Math.min(1, this.omegaVar + 0.05 * dt);
        return;
      }
      this.coast = 0;
      const R = sigma * sigma;
      const ix = this._axisUpdate(this.ax, meas.x, R);
      const iz = this._axisUpdate(this.az, meas.z, R);
      this.innovation = this.innovation * 0.9 + 0.1 * Math.hypot(ix, iz);

      // Turn-rate & manoeuvre: least-squares quadratic fit of raw
      // measurements over the last ~1.2 s  ->  velocity v and acceleration a.
      // omega = (v x a) / |v|^2  (coordinated turn), tangential accel = a.v/|v|
      this.hist.push({ t: this.t, x: meas.x, z: meas.z });
      while (this.hist.length > 3 && this.t - this.hist[0].t > 1.2) this.hist.shift();
      const fit = quadFit(this.hist, this.t);
      if (fit) {
        const sp = Math.hypot(fit.vx, fit.vz);
        if (sp > 1.5) {
          const w = (fit.vx * fit.az - fit.vz * fit.ax) / (sp * sp) * -1;
          const at = (fit.ax * fit.vx + fit.az * fit.vz) / sp;
          const alpha = 0.06;
          const err = w - this.omega;
          this.omega += alpha * err;
          this.omegaVar = this.omegaVar * (1 - alpha) + alpha * err * err;
          this.manoeuvre = this.manoeuvre * 0.92 + 0.08 * (Math.abs(at) + Math.sqrt(this.omegaVar) * sp);
        } else {
          this.omega *= 0.9;
        }
      }
    }
    get ready() { return this.init; }
    get pos() { return { x: this.ax.x, z: this.az.x }; }
    get vel() { return { x: this.ax.v, z: this.az.v }; }
    get speed() { return Math.hypot(this.ax.v, this.az.v); }
    get heading() { return Math.atan2(this.ax.v, this.az.v); }

    /** Predicted ground position T seconds ahead (curved if turning). */
    predict(T) {
      let x = this.ax.x, z = this.az.x, vx = this.ax.v, vz = this.az.v;
      const w = this.omega;
      const n = Math.max(1, Math.ceil(T / 0.05));
      const dt = T / n;
      for (let i = 0; i < n; i++) {
        x += vx * dt; z += vz * dt;
        if (Math.abs(w) > 1e-3) {
          const a = w * dt, c = Math.cos(a), s = Math.sin(a);
          const nvx = vx * c + vz * s;
          vz = -vx * s + vz * c; vx = nvx;
        }
      }
      return { x, z };
    }
    /** 1-sigma position uncertainty (m) per axis at T seconds ahead. */
    sigmaAt(T) {
      // prediction spread uses the *observed* manoeuvring level: a tank that
      // jinks and changes speed is genuinely harder to predict.
      const a = Math.max(0.7, Math.min(6, this.manoeuvre));
      const q = a * a;
      const f = (P) => P[0][0] + 2 * T * P[0][1] + T * T * P[1][1] + q * T ** 4 / 4;
      // uncertainty from turn-rate error: lateral offset ~ 0.5 * v * dw * T^2
      const turn = 0.5 * this.speed * Math.sqrt(this.omegaVar) * T * T;
      return {
        x: Math.sqrt(Math.max(0, f(this.ax.P)) + turn * turn * 0.5),
        z: Math.sqrt(Math.max(0, f(this.az.P)) + turn * turn * 0.5),
      };
    }
    /** Path preview points for the HUD. */
    path(T, n) {
      const out = [];
      for (let i = 1; i <= n; i++) out.push(this.predict((T * i) / n));
      return out;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Firing solution                                                     */
  /* ------------------------------------------------------------------ */
  /**
   * @param shooter {muzzle:{x,y,z}, vel:{x,z}} muzzle position & carrier velocity
   * @param target  MotionTracker (or object with predict(T))
   * @param opts    {ammo, wind, targetHeight, pitchMin, pitchMax, heightAt}
   * @returns {ok, yaw, pitch, tof, aim:{x,y,z}, range, lead}
   */
  function solveFiring(shooter, target, opts) {
    const ammo = opts.ammo, wind = opts.wind || { x: 0, z: 0 };
    const pMin = opts.pitchMin !== undefined ? opts.pitchMin : -0.14;
    const pMax = opts.pitchMax !== undefined ? opts.pitchMax : 0.36;
    const th = opts.targetHeight !== undefined ? opts.targetHeight : 1.2;
    const m = shooter.muzzle;
    const carrier = shooter.vel || { x: 0, z: 0 };
    let T = 0;
    let aim = null, yaw = 0, pitch = 0, last = null;

    for (let outer = 0; outer < 5; outer++) {
      const p = target.predict(T);
      const gy = (opts.heightAt ? opts.heightAt(p.x, p.z) : 0) + th;
      aim = { x: p.x, y: gy, z: p.z };
      const dx = aim.x - m.x, dz = aim.z - m.z;
      const D = Math.hypot(dx, dz);
      if (D < 3) return { ok: false, reason: 'too-close' };
      yaw = Math.atan2(dx, dz);
      // first guess: vacuum flat-fire
      const tof0 = D / ammo.muzzle;
      pitch = Math.atan2(aim.y - m.y + 0.5 * G * tof0 * tof0, D);
      let yawAdj = 0;
      let p0 = pitch, e0 = null;
      for (let it = 0; it < 10; it++) {
        const yw = yaw + yawAdj;
        const r = flyToRange(m, yw, pitch, ammo, wind, D, carrier, 1 / 120, yaw);
        if (!r.ok) { pitch = Math.min(pMax, pitch + 0.05); continue; }
        const e = r.y - aim.y;
        // cross-range: aim the opposite way of drift
        yawAdj -= r.cross / D;
        last = r;
        if (Math.abs(e) < 0.05 && Math.abs(r.cross) < 0.05) break;
        let np;
        if (e0 === null || Math.abs(e - e0) < 1e-6) np = pitch - e / D;
        else np = pitch - (e * (pitch - p0)) / (e - e0);
        p0 = pitch; e0 = e;
        pitch = Math.max(pMin - 0.2, Math.min(pMax + 0.2, np));
      }
      yaw += yawAdj;
      if (!last) return { ok: false, reason: 'no-trajectory' };
      if (Math.abs(last.t - T) < 0.01) { T = last.t; break; }
      T = last.t;
    }
    const inLimits = pitch >= pMin && pitch <= pMax;
    const now = target.predict(0);
    const bearingNow = Math.atan2(now.x - m.x, now.z - m.z);
    let lead = yaw - bearingNow;
    while (lead > Math.PI) lead -= 2 * Math.PI;
    while (lead < -Math.PI) lead += 2 * Math.PI;
    return {
      ok: inLimits,
      reason: inLimits ? null : 'elevation-limit',
      yaw, pitch, tof: T, aim,
      range: Math.hypot(aim.x - m.x, aim.z - m.z),
      lead,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Hit probability                                                     */
  /* ------------------------------------------------------------------ */
  function gaussian(rng) {
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /**
   * Monte-Carlo P(hit). Combines target-position uncertainty at time of
   * flight with gun dispersion and the error between current gun lay and
   * the ideal solution.
   */
  function hitProbability(sol, tracker, opts) {
    if (!sol || !sol.aim) return 0;
    const n = opts.samples || 64;
    const rng = opts.rng || Math.random;
    const disp = opts.dispersion || 0.0016;     // rad, 1-sigma
    const radius = opts.hitRadius || 2.3;      // effective target radius (m)
    const layErr = opts.layError || { yaw: 0, pitch: 0 };
    const sig = tracker.sigmaAt ? tracker.sigmaAt(sol.tof) : { x: 0.5, z: 0.5 };
    const R = sol.range;
    // convert lay error to metres at target
    const fx = Math.sin(sol.yaw), fz = Math.cos(sol.yaw);
    const latLay = layErr.yaw * R;
    // pitch error -> range error grows when trajectory is flat
    const slope = Math.max(0.03, Math.tan(Math.abs(sol.pitch)) + (G * sol.tof) / opts.muzzle);
    const rngLay = (layErr.pitch * R) / slope;
    let hits = 0;
    for (let i = 0; i < n; i++) {
      const tx = gaussian(rng) * sig.x, tz = gaussian(rng) * sig.z;
      const lat = latLay + gaussian(rng) * disp * R;
      const lng = rngLay + (gaussian(rng) * disp * R) / slope;
      const ix = fz * lat + fx * lng, iz = -fx * lat + fz * lng;
      // tanks are taller than the solve plane — allow some range slack
      const ex = ix - tx, ez = iz - tz;
      const dl = ex * fz - ez * fx;           // lateral
      const dr = ex * fx + ez * fz;           // longitudinal
      if ((dl / radius) ** 2 + (dr / (radius * 1.6)) ** 2 < 1) hits++;
    }
    return hits / n;
  }

  /* ------------------------------------------------------------------ */
  /* Armour                                                              */
  /* ------------------------------------------------------------------ */
  const ARMOR = { front: 120, side: 70, rear: 40, turret: 140, top: 25 };

  /**
   * @param tankYaw   hull yaw of the target
   * @param shellDir  {x,y,z} normalised shell velocity
   * @param zone      'hull' | 'turret'
   * @param turretYaw world yaw of turret (if zone==='turret')
   * @param slope     armour slope from vertical (rad)
   */
  function resolveArmor(tankYaw, shellDir, zone, turretYaw, slope, ammo, range) {
    const yaw = zone === 'turret' ? turretYaw : tankYaw;
    // shell coming FROM direction -shellDir; local angle vs facing
    const hx = Math.sin(yaw), hz = Math.cos(yaw);
    const inX = -shellDir.x, inZ = -shellDir.z;
    const hLen = Math.hypot(inX, inZ) || 1;
    const cosF = (inX * hx + inZ * hz) / hLen;   // 1 = frontal
    let face, base;
    if (zone === 'turret') { face = 'turret'; base = ARMOR.turret * (0.55 + 0.45 * Math.max(0, cosF)); }
    else if (cosF > 0.64) { face = 'front'; base = ARMOR.front; }
    else if (cosF < -0.64) { face = 'rear'; base = ARMOR.rear; }
    else { face = 'side'; base = ARMOR.side; }
    // impact angle to plate normal (horizontal component + vertical slope)
    let horiz;
    if (face === 'front' || face === 'turret') horiz = Math.acos(Math.min(1, Math.abs(cosF)));
    else if (face === 'rear') horiz = Math.acos(Math.min(1, Math.abs(cosF)));
    else horiz = Math.acos(Math.min(1, Math.sqrt(Math.max(0, 1 - cosF * cosF))));
    const vert = (slope || 0) + Math.asin(Math.max(-1, Math.min(1, -shellDir.y)));
    const cosImpact = Math.cos(horiz) * Math.cos(vert * 0.6);
    const angle = Math.acos(Math.max(0, Math.min(1, cosImpact)));
    const eff = base / Math.max(0.12, cosImpact);
    const pen = ammo.pen0 - ammo.penLossPer100m * (range / 100);
    const ricochet = ammo.id === 'AP' && angle > 1.22; // > 70 deg
    const penetrated = !ricochet && pen >= eff;
    let damage;
    if (ricochet) damage = 2;
    else if (penetrated) damage = ammo.damage * (1 + Math.min(0.5, (pen - eff) / 200));
    else damage = ammo.damage * 0.18;
    return { face, effective: eff, pen, angle, ricochet, penetrated, damage };
  }

  const api = {
    G, AMMO, ARMOR,
    stepShell, muzzleVelocity, flyToRange, trajectory,
    MotionTracker, solveFiring, hitProbability, resolveArmor,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FCS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
