// Compare the trained NN driver with the scripted driver on unseen arenas.
'use strict';
const { Arena, fitness } = require('./env.js');
const W = require('../js/rl-weights.js');
const N = +(process.argv[2] || 64);
function run(useNN, seed) {
  const a = new Arena(seed);
  if (!useNN) a.tanks[0].driver = 'script';
  while (a.time < a.opts.duration && a.tanks[0].alive && a.tanks.filter((t) => t.alive).length > 1) a.step(W);
  a.tanks[0].driver = 'rl';
  const s = a.tanks[0].stats;
  return { f: fitness(a), alive: a.tanks[0].alive, win: a.tanks[0].alive && a.tanks.filter((t) => t.alive).length === 1, dealt: s.dmgDealt, taken: s.dmgTaken, surv: s.survived, out: s.outside };
}
const agg = (rs) => { const m = (k) => rs.reduce((a, r) => a + +r[k], 0) / rs.length; return { fitness: m('f').toFixed(1), survive: (m('alive') * 100).toFixed(0) + '%', win: (m('win') * 100).toFixed(0) + '%', dmgDealt: m('dealt').toFixed(1), dmgTaken: m('taken').toFixed(1), survivedS: m('surv').toFixed(1), outsideS: m('out').toFixed(2) }; };
const seeds = Array.from({ length: N }, (_, i) => 20000 + i);
const nn = seeds.map((s) => run(true, s)), sc = seeds.map((s) => run(false, s));
console.log(`1 tank vs 2 scripted bots, ${N} unseen arenas`);
console.table({ 'NN (RL)': agg(nn), scripted: agg(sc) });
