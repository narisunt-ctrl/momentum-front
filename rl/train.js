/*
 * Train the RL driving policy.
 *   Stage 1  Behaviour cloning: imitate the scripted driver (warm start).
 *   Stage 2  Evolution Strategies (OpenAI-ES, antithetic sampling, rank
 *            shaping, Adam) on episode fitness from rl/env.js, using two
 *            worker threads and common random seeds per generation.
 * Output: js/rl-weights.js  (+ rl/checkpoint.json, rl/training-log.csv)
 *
 *   node rl/train.js [generations=60]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const { Arena, fitness } = require('./env.js');
const P = require('../js/rl-policy.js');

const EPISODES = 4;          // seeds per evaluation
const SIGMA = 0.04;
const LR = 0.02;
const PAIRS = 24;            // population = 48

function evaluate(w, seeds, skill) {
  let s = 0;
  for (const seed of seeds) { const a = new Arena(seed, { botSkill: skill }); a.run(w); s += fitness(a); }
  return s / seeds.length;
}

if (!isMainThread) {
  parentPort.on('message', (job) => {
    const w = Float32Array.from(job.w);
    const out = [];
    for (const it of job.items) {
      const v = new Float32Array(w.length);
      for (let i = 0; i < w.length; i++) v[i] = w[i] + it.sign * SIGMA * job.eps[it.k][i];
      out.push({ idx: it.idx, f: evaluate(v, job.seeds, job.skill) });
    }
    parentPort.postMessage(out);
  });
  return;
}

/* ---------------- Stage 1: behaviour cloning ---------------- */
function collectDemos(nEp) {
  const X = [], Y = [];
  for (let e = 0; e < nEp; e++) {
    const a = new Arena(5000 + e);
    const me = a.tanks[0]; me.driver = 'script';
    // run the scripted driver, record observation -> action
    while (a.time < a.opts.duration && me.alive && a.tanks.filter((t) => t.alive).length > 1) {
      const obs = a.rlObs(me);
      const b = JSON.stringify(me.bot); // scriptedDrive mutates jink timers; replay it for the label
      const cmd = a.scriptedDrive(me, a.opts.dt);
      Object.assign(me.bot, JSON.parse(b));
      X.push(obs);
      Y.push([cmd.steer / 1.2, { '-1': -0.8, '1': -0.28, '2': 0.25, '3': 0.8 }[cmd.gear]]);
      a.step(null);
    }
  }
  return { X, Y };
}
function bc(w, X, Y, epochs) {
  const L = P.LAYERS;
  const lr = 0.01;
  const idx = [...X.keys()];
  for (let ep = 0; ep < epochs; ep++) {
    for (let i = idx.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [idx[i], idx[j]] = [idx[j], idx[i]]; }
    let loss = 0;
    for (const n of idx) {
      // forward with cache
      const acts = [X[n]]; let off = 0; const offs = [];
      for (let l = 0; l < L.length - 1; l++) {
        const nin = L[l], nout = L[l + 1], a = acts[l], o = new Float32Array(nout);
        offs.push(off);
        for (let j = 0; j < nout; j++) { let s = w[off + nin * nout + j]; for (let i = 0; i < nin; i++) s += a[i] * w[off + j * nin + i]; o[j] = Math.tanh(s); }
        off += nin * nout + nout; acts.push(o);
      }
      const out = acts[acts.length - 1];
      let delta = new Float32Array(out.length);
      for (let j = 0; j < out.length; j++) { const e = out[j] - Y[n][j]; loss += e * e; delta[j] = e * (1 - out[j] * out[j]); }
      for (let l = L.length - 2; l >= 0; l--) {
        const nin = L[l], nout = L[l + 1], a = acts[l], o0 = offs[l];
        const prev = new Float32Array(nin);
        for (let j = 0; j < nout; j++) {
          const d = delta[j];
          for (let i = 0; i < nin; i++) { prev[i] += d * w[o0 + j * nin + i]; w[o0 + j * nin + i] -= lr * d * a[i]; }
          w[o0 + nin * nout + j] -= lr * d;
        }
        if (l > 0) for (let i = 0; i < nin; i++) prev[i] *= 1 - a[i] * a[i];
        delta = prev;
      }
    }
    console.log(`  BC epoch ${ep + 1}/${epochs}  mse=${(loss / idx.length).toFixed(4)}`);
  }
}

/* ---------------- Stage 2: ES ---------------- */
function gaussVec(n) { const v = new Float32Array(n); for (let i = 0; i < n; i += 2) { let u = 0; while (!u) u = Math.random(); const r = Math.sqrt(-2 * Math.log(u)), t = 2 * Math.PI * Math.random(); v[i] = r * Math.cos(t); if (i + 1 < n) v[i + 1] = r * Math.sin(t); } return v; }

async function main() {
  const GENS = +(process.argv[2] || 60);
  const N = P.paramCount();
  const ckpt = path.join(__dirname, 'checkpoint.json');
  let w;
  if (fs.existsSync(ckpt) && process.argv.includes('--resume')) {
    w = Float32Array.from(JSON.parse(fs.readFileSync(ckpt, 'utf8')).w);
    console.log('resumed from checkpoint');
  } else {
    w = new Float32Array(N).map(() => (Math.random() - 0.5) * 0.3);
    console.log('Stage 1: behaviour cloning from scripted driver');
    const { X, Y } = collectDemos(30);
    console.log(`  ${X.length} samples`);
    bc(w, X, Y, 20);
  }
  const holdout = Array.from({ length: 16 }, (_, i) => 9001 + i);
  const baseline = (() => { // scripted driver in the same seat on holdout seeds
    let s = 0;
    for (const seed of holdout) { const a = new Arena(seed); a.tanks[0].driver = 'script'; while (a.time < a.opts.duration && a.tanks[0].alive && a.tanks.filter((t) => t.alive).length > 1) a.step(null); a.tanks[0].driver = 'rl'; s += fitness(a); }
    return s / holdout.length;
  })();
  console.log(`scripted-driver baseline (holdout) = ${baseline.toFixed(1)}`);
  console.log(`start policy (holdout) = ${evaluate(w, holdout, 0.62).toFixed(1)}`);

  const workers = [0, 1].map(() => new Worker(__filename));
  const m = new Float32Array(N), v = new Float32Array(N);
  const b1 = 0.9, b2 = 0.999;
  let best = { f: -1e9, w: Float32Array.from(w) };
  const log = ['gen,mean_pop,holdout,baseline'];
  for (let g = 1; g <= GENS; g++) {
    const seeds = Array.from({ length: EPISODES }, () => (Math.random() * 1e9) | 0);
    const skill = 0.55 + Math.min(0.35, g / GENS * 0.35);          // curriculum: opponents get better
    const eps = Array.from({ length: PAIRS }, () => gaussVec(N));
    const items = [];
    for (let k = 0; k < PAIRS; k++) { items.push({ idx: 2 * k, k, sign: 1 }); items.push({ idx: 2 * k + 1, k, sign: -1 }); }
    const half = Math.ceil(items.length / 2);
    const parts = [items.slice(0, half), items.slice(half)];
    const res = (await Promise.all(workers.map((wk, i) => new Promise((ok) => { wk.once('message', ok); wk.postMessage({ w: Array.from(w), eps, items: parts[i], seeds, skill }); })))).flat();
    const f = new Float64Array(items.length); for (const r of res) f[r.idx] = r.f;
    // centred rank shaping
    const order = [...f.keys()].sort((a, b) => f[a] - f[b]);
    const rank = new Float64Array(f.length); order.forEach((i, r) => { rank[i] = r / (f.length - 1) - 0.5; });
    const grad = new Float32Array(N);
    for (let k = 0; k < PAIRS; k++) { const s = rank[2 * k] - rank[2 * k + 1]; const e = eps[k]; for (let i = 0; i < N; i++) grad[i] += s * e[i]; }
    for (let i = 0; i < N; i++) {
      const gi = -grad[i] / (PAIRS * 2 * SIGMA) + 0.005 * w[i];   // ascent + weight decay
      m[i] = b1 * m[i] + (1 - b1) * gi; v[i] = b2 * v[i] + (1 - b2) * gi * gi;
      w[i] -= LR * (m[i] / (1 - b1 ** g)) / (Math.sqrt(v[i] / (1 - b2 ** g)) + 1e-8);
    }
    const meanPop = f.reduce((a, b) => a + b, 0) / f.length;
    let hold = '';
    if (g % 5 === 0 || g === GENS) {
      const h = evaluate(w, holdout, 0.62);
      hold = h.toFixed(1);
      if (h > best.f) { best = { f: h, w: Float32Array.from(w), g }; }
      fs.writeFileSync(ckpt, JSON.stringify({ gen: g, holdout: h, w: Array.from(w) }));
    }
    log.push(`${g},${meanPop.toFixed(2)},${hold},${baseline.toFixed(2)}`);
    console.log(`gen ${g}/${GENS}  pop-mean ${meanPop.toFixed(1)}  skill ${skill.toFixed(2)}${hold ? '  holdout ' + hold : ''}`);
  }
  workers.forEach((wk) => wk.terminate());
  fs.writeFileSync(path.join(__dirname, 'training-log.csv'), log.join('\n') + '\n');
  const out = `/* Auto-generated by rl/train.js — ES-trained driving policy.
 * Holdout fitness ${best.f.toFixed(1)} (gen ${best.g}) vs scripted driver ${baseline.toFixed(1)}.
 * Layers ${P.LAYERS.join('-')}, ${N} parameters. */
(function (root) { const W = [${Array.from(best.w).map((x) => +x.toFixed(4)).join(',')}];
  if (typeof module !== 'undefined' && module.exports) module.exports = W; else root.RLWeights = W; })(typeof globalThis !== 'undefined' ? globalThis : this);
`;
  fs.writeFileSync(path.join(__dirname, '..', 'js', 'rl-weights.js'), out);
  console.log(`saved js/rl-weights.js  best holdout ${best.f.toFixed(1)} (gen ${best.g}) vs scripted ${baseline.toFixed(1)}`);
}
main();
