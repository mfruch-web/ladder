// Builds js/words.js from the sources in tools/sources/ and the hand-made lists in tools/lists/.
// Run: sh tools/fetch-sources.sh && node tools/build-words.js
//
// Three tiers per word length:
//   core   - everyday base words; the only words used as a puzzle's start or target
//   common - everyday words (core included); every word on the par path comes from here
//   extra  - everything else that's accepted as a guess
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(__dirname, 'sources');
const LISTS = path.join(__dirname, 'lists');
const LENGTHS = [4, 5];

// Tuning
const COMMON_MAX_TIER = 35;   // SCOWL size tier
const COMMON_MIN_FREQ = 300;  // occurrences in the subtitle corpus
const CORE_MIN_FREQ = 1500;   // starts and targets must be more common still

const read = (f) => fs.readFileSync(f, 'latin1').split(/\r?\n/);
const readList = (name) => new Set(
  fs.readFileSync(path.join(LISTS, name), 'utf8')
    .split('\n').map((l) => l.replace(/#.*/, '')).join(' ')
    .split(/\s+/).filter(Boolean).map((w) => w.toLowerCase()),
);

const enable = new Set(read(path.join(SRC, 'enable1.txt')).filter((w) => /^[a-z]+$/.test(w)));

// SCOWL tier for each word (smallest tier it appears in).
const tier = new Map();
const scowlDir = path.join(SRC, 'scowl', 'final');
for (const t of [10, 20, 35, 40, 50, 55, 60, 70, 80, 95]) {
  for (const p of ['english-words', 'american-words']) {
    const f = path.join(scowlDir, `${p}.${t}`);
    if (!fs.existsSync(f)) continue;
    for (const w of read(f)) if (/^[a-z]+$/.test(w) && !tier.has(w)) tier.set(w, t);
  }
}

const freq = new Map();
for (const line of read(path.join(SRC, 'en_50k.txt'))) {
  const [w, c] = line.split(' ');
  if (w) freq.set(w, Number(c));
}

const blockAll = readList('block-all.txt');
const allowGuess = readList('allow-guess.txt');
for (const w of read(path.join(SRC, 'ldnoobw.txt'))) {
  const x = w.trim().toLowerCase();
  if (/^[a-z]+$/.test(x) && !allowGuess.has(x)) blockAll.add(x);
}
const blockPuzzle = readList('block-puzzle.txt');
const commonRemove = readList('common-remove.txt');
const commonAdd = readList('common-add.txt');
const coreRemove = readList('core-remove.txt');

// Anything containing these is blocked outright, so variants can't slip past the lists.
const BLOCK_SUBSTRINGS = ['fuck', 'shit', 'cunt', 'twat', 'nigg', 'fagg', 'jizz', 'wank', 'slut', 'whore', 'porn', 'dildo'];
const blocked = (w) => blockAll.has(w) || BLOCK_SUBSTRINGS.some((s) => w.includes(s));

// Inflected forms (plurals, past tenses) can sit on a path but never start or end a puzzle.
const NOT_INFLECTED = new Set(['shed', 'news', 'lens', 'odds', 'chaos', 'species', 'bias', 'gas', 'bus', 'plus', 'yes', 'this', 'thus', 'its', 'his', 'hers', 'ours', 'yours', 'less', 'bless', 'dress', 'press', 'cross', 'glass', 'grass', 'class', 'brass', 'chess', 'guess', 'bliss', 'swiss', 'gloss', 'floss', 'moss', 'boss', 'loss', 'toss', 'mess', 'kiss', 'miss', 'fuss', 'hiss', 'mass', 'pass', 'lass', 'bass', 'sass', 'seed', 'feed', 'need', 'weed', 'heed', 'reed', 'deed', 'breed', 'bleed', 'greed', 'speed', 'steed', 'tweed', 'bred', 'sled', 'fled', 'bled', 'sped', 'shred', 'naked', 'wicked', 'sacred', 'rugged', 'jagged', 'ragged', 'red', 'bed', 'wed']);
function inflected(w) {
  if (NOT_INFLECTED.has(w)) return false;
  const known = (b) => b.length >= 3 && enable.has(b) && !blocked(b);
  if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) {
    if (known(w.slice(0, -1))) return true;
    if (w.endsWith('es') && known(w.slice(0, -2))) return true;
    if (w.endsWith('ies') && known(w.slice(0, -3) + 'y')) return true;
  }
  if (w.endsWith('ed')) {
    if (known(w.slice(0, -1)) || known(w.slice(0, -2))) return true;
    if (w.endsWith('ied') && known(w.slice(0, -3) + 'y')) return true;
    if (w.length >= 5 && w[w.length - 3] === w[w.length - 4] && known(w.slice(0, -3))) return true;
  }
  return false;
}

const out = {};
const report = [];
for (const L of LENGTHS) {
  const accepted = new Set();
  for (const w of enable) if (w.length === L) accepted.add(w);
  for (const [w, t] of tier) if (w.length === L && t <= 60) accepted.add(w);
  for (const w of [...accepted]) if (blocked(w)) accepted.delete(w);

  const common = new Set();
  for (const w of accepted) {
    const t = tier.get(w) ?? 99, f = freq.get(w) ?? 0;
    if (!enable.has(w)) continue; // must be in both sources
    if (t <= COMMON_MAX_TIER && (f >= COMMON_MIN_FREQ || (t <= 20 && f >= 50))) common.add(w);
  }
  for (const w of commonAdd) if (w.length === L && accepted.has(w)) common.add(w);
  for (const w of [...common]) if (commonRemove.has(w) || blockPuzzle.has(w)) common.delete(w);

  const core = new Set([...common].filter((w) =>
    (freq.get(w) ?? 0) >= CORE_MIN_FREQ && (tier.get(w) ?? 99) <= COMMON_MAX_TIER &&
    !inflected(w) && !coreRemove.has(w)));

  const sorted = (s) => [...s].sort();
  out[L] = {
    core: sorted(core).join(''),
    common: sorted([...common].filter((w) => !core.has(w))).join(''),
    extra: sorted([...accepted].filter((w) => !common.has(w))).join(''),
  };
  report.push(`${L} letters: ${accepted.size} accepted, ${common.size} common (${core.size} core)`);

  // Review files (not shipped): every common word, so a human can read them all.
  fs.mkdirSync(path.join(__dirname, 'review'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'review', `common-${L}.txt`),
    sorted(common).map((w) => `${core.has(w) ? '*' : ' '} ${w}`).join('\n') + '\n');
}

const header = `// Generated by tools/build-words.js. Do not edit by hand.
// Sources: ENABLE2K (public domain) and SCOWL 2020.12.07 (c) Kevin Atkinson, used under its
// permissive license (see README). Each string is fixed-length words run together.
`;
fs.writeFileSync(path.join(ROOT, 'js', 'words.js'),
  `${header}(function (root) {\n  const WORDS = ${JSON.stringify(out, null, 1)};\n` +
  `  if (typeof module !== 'undefined' && module.exports) module.exports = WORDS;\n` +
  `  else root.LADDER_WORDS = WORDS;\n})(typeof window !== 'undefined' ? window : globalThis);\n`);
console.log(report.join('\n'));
console.log(`wrote js/words.js (${(fs.statSync(path.join(ROOT, 'js', 'words.js')).size / 1024).toFixed(0)} KB)`);
