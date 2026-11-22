/*
 * Ladder puzzle engine: word graph, shortest paths, seeded daily puzzles, and hints.
 * Pure logic with no DOM access, so it runs in the browser and in Node (for tests).
 *
 * Words are nodes; two words are linked when they differ in exactly one letter.
 * There are two graphs over the same words:
 *   accepted - every valid guess. Par is the shortest path here, so nobody can beat it.
 *   common   - everyday words only. A puzzle is only used if a common-only path
 *              is as short as par, so the intended solution never needs an obscure word.
 */
(function (root) {
  'use strict';

  const WORDS = root.LADDER_WORDS || (typeof require === 'function' ? require('./words.js') : null);

  // ---------- Seeded RNG (same as Pipeflow) ----------
  function hashString(str) {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  }

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------- Dictionaries ----------
  const split = (s, L) => { const out = []; for (let i = 0; i < s.length; i += L) out.push(s.slice(i, i + L)); return out; };
  const dicts = {};

  /** Word graph for one word length, built once and cached. */
  function dict(L) {
    if (dicts[L]) return dicts[L];
    const src = WORDS[L];
    const core = split(src.core, L), common = split(src.common, L), extra = split(src.extra, L);
    const words = core.concat(common, extra);
    const n = words.length;
    const id = new Map(words.map((w, i) => [w, i]));
    const isCore = new Uint8Array(n), isCommon = new Uint8Array(n);
    for (let i = 0; i < core.length + common.length; i++) { isCommon[i] = 1; if (i < core.length) isCore[i] = 1; }

    // One bucket per "word with a blank": c_ld holds cold, cord, cold... Neighbours share a bucket.
    const bucketOf = new Map();
    const buckets = [];
    const wordBuckets = new Int32Array(n * L);
    for (let i = 0; i < n; i++) {
      const w = words[i];
      for (let p = 0; p < L; p++) {
        const key = w.slice(0, p) + '_' + w.slice(p + 1);
        let b = bucketOf.get(key);
        if (b === undefined) { b = buckets.length; bucketOf.set(key, b); buckets.push([]); }
        buckets[b].push(i);
        wordBuckets[i * L + p] = b;
      }
    }
    // Flatten to a compact adjacency table (CSR) so searches don't allocate.
    const off = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) {
      let deg = 0;
      for (let p = 0; p < L; p++) deg += buckets[wordBuckets[i * L + p]].length - 1;
      off[i + 1] = off[i] + deg;
    }
    const adj = new Int32Array(off[n]);
    for (let i = 0, k = 0; i < n; i++) {
      for (let p = 0; p < L; p++) for (const j of buckets[wordBuckets[i * L + p]]) if (j !== i) adj[k++] = j;
    }
    const neighbors = (i) => adj.subarray(off[i], off[i + 1]);
    const coreIds = []; for (let i = 0; i < core.length; i++) coreIds.push(i);
    dicts[L] = { L, words, id, n, isCore, isCommon, neighbors, adj, off, coreIds };
    return dicts[L];
  }

  /** Breadth-first distances from `src`. With commonOnly, the search stays on common words. */
  function bfs(D, src, commonOnly) {
    const dist = new Int16Array(D.n).fill(-1);
    const queue = new Int32Array(D.n);
    let head = 0, tail = 0;
    dist[src] = 0; queue[tail++] = src;
    while (head < tail) {
      const u = queue[head++];
      for (let k = D.off[u], e = D.off[u + 1]; k < e; k++) {
        const v = D.adj[k];
        if (dist[v] >= 0 || (commonOnly && !D.isCommon[v])) continue;
        dist[v] = dist[u] + 1;
        queue[tail++] = v;
      }
    }
    dist.order = queue.subarray(0, tail); // visit order, nearest first
    return dist;
  }

  /** Number of shortest common-only paths from the BFS source to each word (capped). */
  function countPaths(D, distC) {
    const order = distC.order;
    const ways = new Float64Array(D.n);
    for (const v of order) {
      if (distC[v] === 0) { ways[v] = 1; continue; }
      let s = 0;
      for (const u of D.neighbors(v)) if (distC[u] === distC[v] - 1) s += ways[u];
      ways[v] = Math.min(s, 1e6);
    }
    return ways;
  }

  const hamming = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++; return d; };
  const sortedLetters = (w) => w.split('').sort().join('');
  const isOneApart = (a, b) => a.length === b.length && hamming(a, b) === 1;

  // ---------- Levels ----------
  // len: word lengths (Medium is 5 letters on about a third of days).
  // par: allowed range per word length. Five-letter ladders are harder per step, so
  //   Medium allows par 4 on five-letter days.
  // widePar: a slightly wider range, used only on the rare day nothing else fits.
  // minPaths: distinct shortest everyday-word routes, so Easy leaves room for error.
  // direct: every step fixes one more letter (start and target differ in exactly `par` places).
  const LEVELS = {
    easy:   { id: 'easy',   label: 'Easy',   len: [4],    par: { 4: [3, 4] }, minPaths: 3, direct: true },
    medium: { id: 'medium', label: 'Medium', len: [4, 5], fiveChance: 0.35, par: { 4: [5, 5], 5: [4, 5] }, widePar: { 4: [4, 6], 5: [4, 6] }, minPaths: 1 },
    hard:   { id: 'hard',   label: 'Hard',   len: [5],    par: { 5: [6, 7] }, widePar: { 5: [6, 8] }, minPaths: 1 },
  };
  const LEVEL_ORDER = ['easy', 'medium', 'hard'];

  // Bump when a change alters which puzzles get generated (the game caches each day's).
  const VERSION = 1;

  // Puzzles count days from this fixed date (not the launch date), so moving the
  // launch date never changes which puzzle falls on which day.
  const EPOCH = Date.UTC(2026, 0, 1);
  const dayIndex = (key) => { const [y, m, d] = key.split('-').map(Number); return Math.round((Date.UTC(y, m - 1, d) - EPOCH) / 86400000); };

  // No repeats, with no server and no history:
  // - Core words are split (by a fixed hash) per level: a third are start words, a twelfth
  //   reserve starts, a twelfth spare targets (last resort only), and the rest targets.
  //   So a target is never a recent start.
  // - Each start (and reserve) word qualifies on one day of every START_CYCLE days, and each
  //   target on one day of every TARGET_CYCLE days, so neither comes back sooner.
  // - The cycles share no factor, so a given start and target only line up on days exactly
  //   ERA (371) days apart: the same puzzle can't come back within a year.
  // - On those recurring days we also work out what the same day chose in earlier eras and
  //   pick something else when there's another good option, so repeats stay rare after that.
  // - On the rare day no normal option works (a few per level per year), we fall back to
  //   spare targets, which follow the same cycles but are never used on a normal day.
  // tests/puzzles.test.js checks all of this over a full year.
  const START_CYCLE = 53;
  const TARGET_CYCLE = 7;
  const ERA = START_CYCLE * TARGET_CYCLE;
  const mod = (a, m) => ((a % m) + m) % m;
  const roleOf = (level, w) => { const r = hashString(`ladder:pool:${level}:${w}`) % 12; return r < 4 ? 'start' : r === 4 ? 'reserve' : r === 5 ? 'spare' : 'target'; };
  const slotOf = (level, w, cycle) => hashString(`ladder:slot:${level}:${w}`) % cycle;
  const pools = {};
  function poolsFor(level, L) {
    const k = `${level}:${L}`;
    if (pools[k]) return pools[k];
    const D = dict(L);
    const starts = Array.from({ length: START_CYCLE }, () => []);
    const reserve = Array.from({ length: START_CYCLE }, () => []);
    const targetSlot = new Int8Array(D.n).fill(-1); // -1: not a target
    const spareSlot = new Int8Array(D.n).fill(-1);  // -1: not a spare target
    for (const i of D.coreIds) {
      const w = D.words[i], role = roleOf(level, w);
      if (role === 'start') starts[slotOf(level, w, START_CYCLE)].push(i);
      else if (role === 'reserve') reserve[slotOf(level, w, START_CYCLE)].push(i);
      else if (role === 'spare') spareSlot[i] = slotOf(level, w, TARGET_CYCLE);
      else targetSlot[i] = slotOf(level, w, TARGET_CYCLE);
    }
    return (pools[k] = { starts, reserve, targetSlot, spareSlot });
  }

  /** Shortest common-word path from a to b, preferring core words; [] if none. */
  function commonPath(D, a, b) {
    const dist = bfs(D, b, true);
    if (dist[a] < 0) return [];
    const path = [a];
    let cur = a;
    while (cur !== b) {
      const next = Array.from(D.neighbors(cur)).filter((v) => dist[v] === dist[cur] - 1);
      next.sort((x, y) => D.isCore[y] - D.isCore[x] || D.words[x].localeCompare(D.words[y]));
      cur = next[0];
      path.push(cur);
    }
    return path;
  }

  /**
   * Builds a level's puzzle for a date key. Deterministic: the same inputs always give
   * the same puzzle, so every player gets an identical daily puzzle with no server.
   * `avoid` is a set of words already used today by another level. `previous` is a set of
   * "start-target" pairs this day chose in earlier eras.
   */
  function buildPuzzle(key, level, avoid, previous) {
    const cfg = LEVELS[level];
    const rng = mulberry32(hashString(`ladder:${key}:${level}`));
    const L = cfg.len.length > 1 ? (rng() < cfg.fiveChance ? 5 : 4) : cfg.len[0];
    const D = dict(L);
    const day = dayIndex(key);
    const pool = poolsFor(level, L);

    // Stages, tried in order until one gives a puzzle: today's starts, then today's reserve
    // starts, then both again with looser rules (Easy may differ in fewer places than par;
    // Medium and Hard may go one past their par range). The last stage is a safety net.
    const todays = pool.starts[mod(day, START_CYCLE)];
    // For the very last stage: other days' starts, furthest from their own day first.
    const farStarts = [];
    for (let k = 0; k <= START_CYCLE >> 1; k++) {
      const far = START_CYCLE >> 1;
      for (const o of k ? [far - k + 1, -(far - k + 1)] : [far + 1]) farStarts.push(...pool.starts[mod(day + o, START_CYCLE)]);
    }
    const reserveToday = pool.reserve[mod(day, START_CYCLE)];
    const STAGES = [
      { starts: todays },
      { starts: reserveToday },
      { starts: todays, loose: true },
      { starts: reserveToday, loose: true },
      // Last resort: spare targets, which no earlier stage uses, so these pairs can't come
      // round again on a normal day. They still follow the slot cycles, so nothing repeats
      // soon (`near` also allows the slots half a cycle away, 3+ days apart). The final stage
      // drops the slots and is a safety net.
      { starts: todays.concat(reserveToday), loose: true, spare: true },
      { starts: todays.concat(reserveToday), loose: true, spare: true, near: true },
      { starts: todays.concat(reserveToday), loose: true, spare: true, anySlot: true },
      { starts: farStarts, cap: 60, loose: true, spare: true, anySlot: true, ordered: true },
    ];
    // Stages that relax the target slots can pair a start with a target it met on an earlier
    // pass of the start cycle, so they skip those days' pairs (a few cached generations).
    let cyclePairs = null;
    const pastPairs = () => (cyclePairs ||= pairsEveryCycle(day, level));
    const cache = new Map(); // start -> searches, reused across stages
    const tryStart = (s, st, avoidPrevious) => {
      if (avoid && avoid.has(D.words[s])) return null;
      let c = cache.get(s);
      if (!c) {
        const distA = bfs(D, s, false), distC = bfs(D, s, true);
        cache.set(s, (c = { distA, distC, ways: countPaths(D, distC) }));
      }
      const { distA, distC, ways } = c;
      const [lo, hi] = (st.loose && cfg.widePar ? cfg.widePar : cfg.par)[L];
      const slot = mod(day, TARGET_CYCLE);
      let cands = [];
      for (const t of D.coreIds) {
        const p = distA[t];
        if (t === s || p < lo || p > hi || distC[t] !== p) continue; // par path must be all common
        const tSlot = st.spare ? pool.spareSlot[t] : pool.targetSlot[t];
        if (tSlot < 0) continue;
        if (!st.anySlot && tSlot !== slot && !(st.near && Math.abs(tSlot - slot) >= 3 && Math.abs(tSlot - slot) <= 4)) continue;
        const w = D.words[t];
        if (avoid && avoid.has(w)) continue;
        if ((st.near || st.anySlot) && pastPairs().has(`${D.words[s]}-${w}`)) continue;
        const h = hamming(D.words[s], w);
        if (h < L - 1) continue;                                      // too similar
        if (sortedLetters(w) === sortedLetters(D.words[s])) continue; // anagrams
        if (cfg.direct && !st.loose && h !== p) continue;
        if (ways[t] < cfg.minPaths) continue;
        cands.push(t);
      }
      if (!cands.length) return null;
      // First pass of each stage skips what this day chose one era back.
      if (avoidPrevious) cands = cands.filter((t) => !previous.has(`${D.words[s]}-${D.words[t]}`));
      if (!cands.length) return null;
      // Without slots, prefer targets whose slot is furthest from today, so they're furthest
      // from their next regular day.
      if (st.anySlot) {
        const dist = (t) => { const d = Math.abs(pool.spareSlot[t] - slot); return Math.min(d, TARGET_CYCLE - d); };
        const best = Math.max(...cands.map(dist));
        cands = cands.filter((t) => dist(t) === best);
      }
      // When par can vary (Easy 3-4), pick the par first so both come up often.
      let choices = cands;
      if (lo !== hi) {
        const want = lo + Math.floor(rng() * (hi - lo + 1));
        const atWant = cands.filter((t) => distA[t] === want);
        if (atWant.length) choices = atWant;
      }
      const t = choices[(rng() * choices.length) | 0];
      return { s, t, par: distA[t], paths: ways[t] };
    };

    const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = (rng() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
    // Try the slot-based stages while skipping pairs used in earlier eras; then allow those
    // pairs again; the slot-free stages only as a last resort.
    const slotted = STAGES.filter((st) => !st.spare).length;
    const passes = [];
    if (previous) for (let i = 0; i < slotted; i++) passes.push([i, true]);
    for (let i = 0; i < slotted; i++) passes.push([i, false]);
    for (let i = slotted; i < STAGES.length; i++) passes.push([i, !!previous], [i, false]);
    const orders = STAGES.map((st) => (st.ordered ? st.starts.slice() : shuffle(st.starts.slice())).slice(0, st.cap || Infinity));
    let found = null, stage = -1;
    for (const [i, avoidPrevious] of passes) {
      for (const s of orders[i]) { found = tryStart(s, STAGES[i], avoidPrevious); if (found) break; }
      if (found) { stage = i; break; }
    }
    if (!found) throw new Error(`No ${level} puzzle found for ${key}`);

    const solution = commonPath(D, found.s, found.t).map((i) => D.words[i]);
    return {
      key, level, label: cfg.label, len: L,
      start: D.words[found.s], target: D.words[found.t],
      par: found.par, paths: found.paths, solution, stage,
    };
  }

  const keyOfDay = (n) => new Date(EPOCH + n * 86400000).toISOString().slice(0, 10);

  /**
   * All three of a day's puzzles. Levels never share a start or target word.
   * Builds the same day in earlier eras first, to avoid their pairs. Memoized.
   */
  const memo = new Map();
  function dailyPuzzles(key) { return dailyWithHistory(key).puzzles; }
  function dailyWithHistory(key) {
    if (memo.has(key)) return memo.get(key);
    const day = dayIndex(key);
    const history = {};
    for (const lv of LEVEL_ORDER) history[lv] = new Set();
    if (day - ERA >= 0) {
      const prev = dailyWithHistory(keyOfDay(day - ERA));
      for (const lv of LEVEL_ORDER) {
        for (const pr of prev.history[lv]) history[lv].add(pr);
        history[lv].add(`${prev.puzzles[lv].start}-${prev.puzzles[lv].target}`);
      }
    }
    const used = new Set();
    const puzzles = {};
    for (const lv of LEVEL_ORDER) {
      const p = buildPuzzle(key, lv, used, history[lv].size ? history[lv] : null);
      used.add(p.start); used.add(p.target);
      puzzles[lv] = p;
    }
    const out = { puzzles, history };
    memo.set(key, out);
    return out;
  }

  /** Pairs a level used on each earlier pass of the start cycle within the past year. */
  function pairsEveryCycle(day, level) {
    const pairs = new Set();
    for (let k = START_CYCLE; k < 366 && day - k >= 0; k += START_CYCLE) {
      const p = dailyPuzzles(keyOfDay(day - k))[level];
      pairs.add(`${p.start}-${p.target}`);
    }
    return pairs;
  }

  // ---------- Play helpers ----------
  const isWord = (w) => { const D = dict(w.length); return !!D && D.id.has(w); };
  const isCommonWord = (w) => { const D = dict(w.length); const i = D.id.get(w); return i !== undefined && !!D.isCommon[i]; };

  /** Fewest steps from word to target over every valid word (Infinity if unreachable). */
  function distance(word, target) {
    const D = dict(word.length);
    const d = bfs(D, D.id.get(target), false)[D.id.get(word)];
    return d < 0 ? Infinity : d;
  }

  /**
   * The next word on a shortest path from `word` to `target`. Prefers a word that keeps
   * you on an all-everyday-words route, then any everyday word, then anything.
   * Pass the intended solution to stay on it when you're already on it.
   */
  function nextStep(word, target, solution) {
    if (word === target) return null;
    if (solution) {
      const i = solution.indexOf(word);
      if (i >= 0 && i < solution.length - 1) return solution[i + 1];
    }
    const D = dict(word.length);
    const t = D.id.get(target), w = D.id.get(word);
    const distA = bfs(D, t, false), distC = bfs(D, t, true);
    if (distA[w] < 0) return null;
    const next = Array.from(D.neighbors(w)).filter((v) => distA[v] === distA[w] - 1);
    const score = (v) => (D.isCommon[v] && distC[v] === distA[v] ? 4 : 0) + (D.isCommon[v] ? 2 : 0) + D.isCore[v];
    next.sort((a, b) => score(b) - score(a) || D.words[a].localeCompare(D.words[b]));
    return D.words[next[0]];
  }

  /** A full shortest path from word to target, built from nextStep. */
  function pathFrom(word, target, solution) {
    const out = [word];
    let cur = word;
    while (cur !== target && out.length < 40) { cur = nextStep(cur, target, solution); if (!cur) break; out.push(cur); }
    return out;
  }

  /** Local-date key like "2026-11-21". */
  function dateKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function puzzleNumber(date, launchKey) {
    const [ly, lm, ld] = launchKey.split('-').map(Number);
    const launch = new Date(ly, lm - 1, ld);
    const today = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    return Math.round((today - launch) / 86400000) + 1;
  }

  const api = {
    hashString, mulberry32, dict, bfs, countPaths, hamming, isOneApart, isWord, isCommonWord,
    distance, nextStep, pathFrom, buildPuzzle, dailyPuzzles, dateKey, puzzleNumber, dayIndex,
    LEVELS, LEVEL_ORDER, VERSION,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Puzzle = api;
})(typeof window !== 'undefined' ? window : globalThis);
