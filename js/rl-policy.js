/*
 * Momentum Front — RL driving policy
 * --------------------------------------------------------------
 * A small neural network (MLP 22-32-24-2, tanh) that decides how a bot
 * DRIVES: steering and gear. Gunnery stays with the FCS-AI.
 * Weights are trained offline by Evolution Strategies in rl/train.js
 * against scripted bots, then written to js/rl-weights.js.
 *
 * The same feature function is used by the trainer and by the game,
 * so what the network sees in training is exactly what it sees in play.
 *
 * (c) 2026 Narisan Nakakes — MIT License
 */
(function (root) {
  'use strict';
  const LAYERS = [22, 32, 24, 2];
  const PROBES = [-1.05, -0.52, 0, 0.52, 1.05];   // ray angles (rad) rel. hull

  function paramCount() {
    let n = 0;
    for (let i = 0; i < LAYERS.length - 1; i++) n += LAYERS[i] * LAYERS[i + 1] + LAYERS[i + 1];
    return n;
  }

  function forward(w, x) {
    let a = x, off = 0;
    for (let l = 0; l < LAYERS.length - 1; l++) {
      const nin = LAYERS[l], nout = LAYERS[l + 1];
      const out = new Float32Array(nout);
      for (let j = 0; j < nout; j++) {
        let s = w[off + nin * nout + j];
        for (let i = 0; i < nin; i++) s += a[i] * w[off + j * nin + i];
        out[j] = Math.tanh(s);
      }
      off += nin * nout + nout;
      a = out;
    }
    return a;
  }

  const wrap = (d) => { while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  /**
   * @param s   self   {x,z,yaw,speed,hp,warn,id}
   * @param tg  target {x,z,yaw,turYaw,vx,vz} or null
   * @param zone {x,z,r}
   * @param probe (yawWorld, maxDist) -> free distance
   * @param t   time (s)
   */
  function features(s, tg, zone, probe, t) {
    const f = new Float32Array(LAYERS[0]);
    const c = Math.cos(s.yaw), sn = Math.sin(s.yaw);
    // world vector -> hull frame (forward, right=-x side as in the game)
    const toLocal = (dx, dz) => ({ fwd: dx * sn + dz * c, side: dx * c - dz * sn });
    let k = 0;
    if (tg) {
      const dx = tg.x - s.x, dz = tg.z - s.z, d = Math.hypot(dx, dz) || 1;
      const brg = wrap(Math.atan2(dx, dz) - s.yaw);
      f[k++] = Math.sin(brg); f[k++] = Math.cos(brg);
      f[k++] = clamp(d / 200, 0, 2);
      const lv = toLocal(tg.vx, tg.vz);
      f[k++] = clamp(lv.fwd / 15, -1.5, 1.5); f[k++] = clamp(lv.side / 15, -1.5, 1.5);
      const back = Math.atan2(-dx, -dz);                     // bearing target -> me
      f[k++] = Math.cos(wrap(tg.turYaw - back));             // its gun pointing at me?
      f[k++] = Math.cos(wrap(tg.yaw - back));                // its front facing me?
      f[k++] = Math.sin(wrap(tg.yaw - back));
      f[k++] = 1;
    } else { k += 8; f[k++] = 0; }
    const zx = zone.x - s.x, zz = zone.z - s.z, zd = Math.hypot(zx, zz);
    const zb = wrap(Math.atan2(zx, zz) - s.yaw);
    f[k++] = Math.sin(zb); f[k++] = Math.cos(zb);
    f[k++] = clamp((zd - zone.r) / 40, -2, 2);
    f[k++] = clamp(s.speed / 15, -1, 1);
    for (const a of PROBES) f[k++] = clamp(probe(s.yaw + a, 30) / 30, 0, 1);
    f[k++] = clamp(s.warn || 0, 0, 1);
    f[k++] = clamp(s.hp / 100, 0, 1);
    f[k++] = Math.sin(t * 1.3 + s.id * 1.7);
    f[k++] = Math.sin(t * 0.55 + s.id * 0.9);
    return f;
  }

  /** network output -> driving command */
  function act(w, feat) {
    const o = forward(w, feat);
    const steer = clamp(o[0] * 1.2, -1, 1);
    const g = o[1];
    const gear = g < -0.55 ? -1 : g < 0.0 ? 1 : g < 0.5 ? 2 : 3;
    return { steer, gear };
  }

  const api = { LAYERS, PROBES, paramCount, forward, features, act };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RLPolicy = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
