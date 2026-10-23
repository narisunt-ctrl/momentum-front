// Node test: fire simulated shells at moving targets using the FCS and measure miss distance.
const F = require('../js/fcs.js');
let fails = 0;
const check = (name, cond, info) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (info ? '  ' + info : '')); if (!cond) fails++; };

function targetMotion(kind) {
  // returns f(t) -> {x,z}
  if (kind === 'static') return () => ({ x: 40, z: 180 });
  if (kind === 'straight') return (t) => ({ x: -60 + 11 * t, z: 200 });
  if (kind === 'circle') { const R = 45, w = 0.24; return (t) => ({ x: 20 + R * Math.sin(w * t), z: 190 + R * Math.cos(w * t) }); }
}
function engage(kind, ammo, wind) {
  const truth = targetMotion(kind);
  const trk = new F.MotionTracker();
  const dt = 1 / 30; let t = 0;
  let seed = 7; const rng = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const noise = () => (rng() - 0.5) * 0.8;
  for (; t < 4; t += dt) { const p = truth(t); trk.update(dt, { x: p.x + noise(), z: p.z + noise() }, 0.4); }
  const shooter = { muzzle: { x: 0, y: 2.2, z: 0 }, vel: { x: 0, z: 0 } };
  const sol = F.solveFiring(shooter, trk, { ammo, wind, targetHeight: 1.2 });
  // fly real shell, find closest approach to true target (at y≈1.2)
  const v = F.muzzleVelocity(sol.yaw, sol.pitch, ammo.muzzle);
  const s = { x: 0, y: 2.2, z: 0, vx: v.x, vy: v.y, vz: v.z, t: 0 };
  let best = 1e9;
  for (let i = 0; i < 1200; i++) {
    F.stepShell(s, ammo, wind, 1 / 240);
    const p = truth(t + s.t);
    const d = Math.hypot(s.x - p.x, s.y - 1.2, s.z - p.z);
    best = Math.min(best, d);
  }
  const pk = F.hitProbability(sol, trk, { muzzle: ammo.muzzle, samples: 400 });
  return { sol, miss: best, pk };
}
for (const kind of ['static', 'straight', 'circle'])
  for (const am of ['AP', 'HE'])
    for (const wind of [{ x: 0, z: 0 }, { x: 6, z: -3 }]) {
      const r = engage(kind, F.AMMO[am], wind);
      check(`${kind}/${am}/wind=${wind.x}`, r.sol.ok && r.miss < 2.0,
        `miss=${r.miss.toFixed(2)}m pitch=${(r.sol.pitch * 57.3).toFixed(2)}° lead=${(r.sol.lead * 57.3).toFixed(2)}° tof=${r.sol.tof.toFixed(2)}s Pk=${(r.pk * 100).toFixed(0)}%`);
    }

// armour
const ap = F.AMMO.AP;
const front = F.resolveArmor(0, { x: 0, y: 0, z: -1 }, 'hull', 0, 0, ap, 100);
const side = F.resolveArmor(0, { x: -1, y: 0, z: 0 }, 'hull', 0, 0, ap, 100);
const glance = F.resolveArmor(0, { x: -0.95, y: 0, z: -0.31 }, 'hull', 0, 0, ap, 100);
check('frontal face', front.face === 'front', JSON.stringify({ eff: front.effective | 0, pen: front.pen }));
check('side penetrates', side.face === 'side' && side.penetrated, `eff=${side.effective | 0}`);
check('rear thinner than front', F.resolveArmor(0, { x: 0, y: 0, z: 1 }, 'hull', 0, 0, ap, 100).effective < front.effective);
check('glancing front shot ricochets', F.resolveArmor(0, { x: -0.35, y: 0, z: -0.94 }, 'hull', 0, 0, ap, 100).effective > front.effective, '');
console.log('glance:', glance.face, glance.angle * 57.3 | 0, glance.ricochet);
process.exit(fails ? 1 : 0);
