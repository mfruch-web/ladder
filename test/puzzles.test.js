// Generates a full year of puzzles at every level and checks them.
// Run: node test/puzzles.test.js   (or: node --test test/)
'use strict';
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../js/puzzle.js');

const DAYS = 365;
const START = new Date(2026, 10, 21);
const lists = path.join(__dirname, '..', 'tools', 'lists');
const readList = (f) => new Set(fs.readFileSync(f, 'utf8').split('\n').map((l) => l.replace(/#.*/, '')).join(' ').split(/\s+/).filter(Boolean));

const blockAll = readList(path.join(lists, 'block-all.txt'));
const blockPuzzle = readList(path.join(lists, 'block-puzzle.txt'));
const ldnoobwFile = path.join(__dirname, '..', 'tools', 'sources', 'ldnoobw.txt');
// Single-word entries only (the list also has phrases), the same way build-words.js reads it.
const ldnoobw = new Set(fs.existsSync(ldnoobwFile) ? fs.readFileSync(ldnoobwFile, 'utf8').split('\n').map((w) => w.trim().toLowerCase()).filter((w) => /^[a-z]+$/.test(w)) : []);
const allowGuess = readList(path.join(lists, 'allow-guess.txt'));
const offensive = (w) => blockAll.has(w) || blockPuzzle.has(w) || ldnoobw.has(w);

// Generate everything once, timing each day. The word graphs are built first (about 100 ms,
// once per page load) so the timings are for puzzle generation itself.
P.dict(4); P.dict(5);
const days = [];
const times = [];
const t0 = performance.now();
for (let i = 0; i < DAYS; i++) {
  const d = new Date(START); d.setDate(d.getDate() + i);
  const key = P.dateKey(d);
  const a = performance.now();
  const puzzles = P.dailyPuzzles(key);
  times.push(performance.now() - a);
  days.push({ key, puzzles });
}
const totalMs = performance.now() - t0;

test('generation is fast', () => {
  const sorted = times.slice().sort((a, b) => a - b);
  const avg = totalMs / DAYS, p99 = sorted[Math.floor(DAYS * 0.99)], worst = sorted[DAYS - 1];
  console.log(`  ${DAYS} days in ${totalMs.toFixed(0)} ms (avg ${avg.toFixed(1)} ms/day, 99th pct ${p99.toFixed(0)} ms, worst ${worst.toFixed(0)} ms)`);
  assert.ok(avg < 40, `average ${avg.toFixed(1)} ms per day`);
  assert.ok(p99 < 200, `99th percentile ${p99.toFixed(0)} ms`);
  // A rare last-resort day builds a few earlier days too. The game caches each day's puzzles,
  // so this is paid at most once per day per device.
  assert.ok(worst < 1000, `worst day ${worst.toFixed(0)} ms`);
});

test('generation is deterministic (fresh process, any order)', () => {
  const { execFileSync } = require('child_process');
  const keys = [days[300].key, days[5].key, days[180].key, days[0].key];
  const out = execFileSync(process.execPath, ['-e',
    `const P=require(${JSON.stringify(path.join(__dirname, '..', 'js', 'puzzle.js'))});` +
    `console.log(JSON.stringify(${JSON.stringify(keys)}.map((k)=>P.dailyPuzzles(k))))`]);
  const fresh = JSON.parse(out);
  keys.forEach((k, i) => assert.deepEqual(fresh[i], JSON.parse(JSON.stringify(days.find((d) => d.key === k).puzzles)), k));
});

test('par is within each level\'s range and is the true shortest path', () => {
  for (const { key, puzzles } of days) {
    for (const lv of P.LEVEL_ORDER) {
      const p = puzzles[lv];
      // A few days a year fall back to a range one wider (see widePar in puzzle.js).
      const cfg = P.LEVELS[lv];
      const [lo, hi] = (p.stage >= 2 && cfg.widePar ? cfg.widePar : cfg.par)[p.len];
      assert.ok(p.par >= lo && p.par <= hi, `${key} ${lv} par ${p.par}`);
      assert.equal(P.distance(p.start, p.target), p.par, `${key} ${lv} par is the BFS distance`);
      assert.ok(P.LEVELS[lv].len.includes(p.len), `${key} ${lv} length ${p.len}`);
    }
  }
});

test('the par path is valid and every word on it is common', () => {
  for (const { key, puzzles } of days) {
    for (const lv of P.LEVEL_ORDER) {
      const p = puzzles[lv];
      const s = p.solution;
      assert.equal(s.length, p.par + 1, `${key} ${lv} solution length`);
      assert.equal(s[0], p.start); assert.equal(s[s.length - 1], p.target);
      for (let i = 0; i < s.length; i++) {
        assert.ok(P.isCommonWord(s[i]), `${key} ${lv}: ${s[i]} is common`);
        if (i) assert.ok(P.isOneApart(s[i - 1], s[i]), `${key} ${lv}: ${s[i - 1]}→${s[i]}`);
      }
      // A hint taken from the start follows an all-common shortest path too.
      const hinted = P.pathFrom(p.start, p.target);
      assert.equal(hinted.length, p.par + 1, `${key} ${lv} hint path length`);
      for (const w of hinted) assert.ok(P.isCommonWord(w), `${key} ${lv} hint word ${w} is common`);
    }
  }
});

test('no offensive words appear in any puzzle', () => {
  for (const { key, puzzles } of days) {
    for (const lv of P.LEVEL_ORDER) {
      for (const w of puzzles[lv].solution) assert.ok(!offensive(w), `${key} ${lv}: ${w}`);
    }
  }
});

test('blocked words are not accepted as guesses', () => {
  for (const w of [...blockAll, ...ldnoobw]) {
    if ((w.length === 4 || w.length === 5) && !allowGuess.has(w)) assert.ok(!P.isWord(w), `${w} should be blocked`);
  }
  for (const w of blockPuzzle) if (w.length === 4 || w.length === 5) assert.ok(!P.isCommonWord(w), `${w} should not be common`);
});

test('start and target are not trivially similar', () => {
  const sorted = (w) => w.split('').sort().join('');
  for (const { key, puzzles } of days) {
    for (const lv of P.LEVEL_ORDER) {
      const { start, target, len, par } = puzzles[lv];
      assert.notEqual(start, target);
      assert.ok(P.hamming(start, target) >= len - 1, `${key} ${lv}: ${start}/${target} share too many letters`);
      assert.notEqual(sorted(start), sorted(target), `${key} ${lv}: anagrams`);
      if (lv === 'easy' && puzzles[lv].stage < 2) assert.equal(P.hamming(start, target), par, `${key} easy should be a direct ladder`);
    }
  }
});

test('easy has several routes; levels never share words on a day', () => {
  for (const { key, puzzles } of days) {
    assert.ok(puzzles.easy.paths >= 3, `${key} easy paths ${puzzles.easy.paths}`);
    const ends = P.LEVEL_ORDER.flatMap((lv) => [puzzles[lv].start, puzzles[lv].target]);
    assert.equal(new Set(ends).size, ends.length, `${key} levels share a start/target`);
  }
});

test('puzzles don\'t repeat', () => {
  // Days that use the slot rotation (stages 0-3) can never repeat a pair within the year.
  // Last-resort days (stage 4+, a few per level per year) use spare targets and relaxed
  // slots, which leaves a tiny chance of a repeat; allow at most one a year.
  const LAST_RESORT = 4;
  let lastResortRepeats = 0;
  for (const lv of P.LEVEL_ORDER) {
    const pairs = new Map();
    const lastSeen = new Map();
    let soonest = Infinity;
    days.forEach(({ key, puzzles }, i) => {
      const { start, target, stage } = puzzles[lv];
      const pair = `${start}-${target}`;
      if (pairs.has(pair)) {
        const first = pairs.get(pair);
        const both = stage >= LAST_RESORT && first.stage >= LAST_RESORT;
        console.log(`  ${lv} repeats ${pair}: ${first.key} and ${key}${both ? ' (both last-resort days)' : ''}`);
        assert.ok(both, `${lv} repeats ${pair} on a normal day`);
        lastResortRepeats++;
      }
      pairs.set(pair, { key, stage });
      for (const w of [start, target]) {
        if (lastSeen.has(w)) soonest = Math.min(soonest, i - lastSeen.get(w));
        lastSeen.set(w, i);
      }
    });
    console.log(`  ${lv}: a start/target word comes back after ${soonest === Infinity ? 'never' : soonest + ' days'} at the soonest`);
    assert.ok(soonest >= 7, `${lv} reuses a word after ${soonest} days`);
  }
  assert.ok(lastResortRepeats <= 1, `${lastResortRepeats} repeats on last-resort days`);
});

test('summary', () => {
  for (const lv of P.LEVEL_ORDER) {
    const pars = {}, lens = {};
    let fallback = 0;
    for (const { puzzles } of days) {
      const p = puzzles[lv];
      pars[p.par] = (pars[p.par] || 0) + 1; lens[p.len] = (lens[p.len] || 0) + 1;
      if (p.stage >= 2) fallback++;
    }
    console.log(`  ${lv.padEnd(6)} par ${JSON.stringify(pars)} letters ${JSON.stringify(lens)} fallback days ${fallback}`);
  }
  const stages = {};
  for (const { puzzles } of days) for (const lv of P.LEVEL_ORDER) { const k = `${lv} stage ${puzzles[lv].stage}`; stages[k] = (stages[k] || 0) + 1; }
  console.log('  ' + JSON.stringify(stages));
  console.log('  samples:');
  for (const { key, puzzles } of days.slice(0, 7)) {
    console.log(`  ${key}  ` + P.LEVEL_ORDER.map((lv) => puzzles[lv].solution.join('→').toUpperCase()).join('   '));
  }
});
