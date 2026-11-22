// Plays Ladder in headless Chrome on iPhone screen sizes (SE through Pro Max) with touch input.
// Run: node test/ui.mjs        Screenshots land in test/screenshots/ for a look.
// Needs Google Chrome (set CHROME=/path/to/chrome to override).
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = join(ROOT, 'test', 'screenshots');
mkdirSync(SHOTS, { recursive: true });
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const P = createRequire(import.meta.url)(join(ROOT, 'js', 'puzzle.js'));

const DEVICES = [
  { name: 'iPhone SE', width: 375, height: 667, dpr: 2, safeTop: 20, safeBottom: 0, chromeH: 115 },
  { name: 'iPhone 13 mini', width: 375, height: 812, dpr: 3, safeTop: 50, safeBottom: 34, chromeH: 0 },
  { name: 'iPhone 15', width: 393, height: 852, dpr: 3, safeTop: 59, safeBottom: 34, chromeH: 0 },
  { name: 'iPhone 15 Pro Max', width: 430, height: 932, dpr: 3, safeTop: 59, safeBottom: 34, chromeH: 0 },
];
// Safari's toolbars take height in the browser (chromeH); the SE is the tightest case,
// so it's tested with them. The others are tested as home-screen apps with safe areas.

// ---------- Static server ----------
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = join(ROOT, p);
  if (!f.startsWith(ROOT) || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

// ---------- Chrome over the DevTools protocol ----------
const port = 9500 + Math.floor(Math.random() * 400);
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'ladder-ui-'))}`, '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let tabs;
for (let i = 0; i < 50 && !tabs; i++) { try { tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { await sleep(200); } }
const ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let msgId = 0; const pending = {}; const errors = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending[d.id]) { pending[d.id](d); delete pending[d.id]; }
  if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
  if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push(d.params.args.map((a) => a.value ?? a.description).join(' '));
};
const send = (method, params = {}) => new Promise((r) => { pending[++msgId] = r; ws.send(JSON.stringify({ id: msgId, method, params })); });
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(`eval failed: ${expr}\n${r.result.exceptionDetails.exception?.description}`);
  return r.result?.result?.value;
};
await send('Runtime.enable');
await send('Page.enable');
await send('DOMStorage.enable');

// ---------- Helpers ----------
let failures = 0, checks = 0;
function check(ok, msg) { checks++; if (!ok) { failures++; console.log(`    ✖ ${msg}`); } }
async function tap(selector) {
  const box = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (!box) throw new Error(`no element ${selector}`);
  const pt = [{ x: box.x, y: box.y, radiusX: 4, radiusY: 4, force: 1, id: 1 }];
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt });
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(60);
}
const text = (sel) => evaluate(`(document.querySelector(${JSON.stringify(sel)}) || {}).textContent || ''`);
const visible = (sel) => evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; const r = e.getBoundingClientRect(); return !e.closest('[hidden]') && r.width > 0 && r.height > 0; })()`);
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(r.result.data, 'base64'));
}
// Wipe saved progress. Done from a blank page, because the game saves on pagehide.
async function wipe() {
  await send('Page.navigate', { url: 'about:blank' });
  await sleep(400);
  const origin = BASE.replace(/\/$/, '');
  for (let i = 0; i < 5; i++) {
    await send('Storage.clearDataForOrigin', { origin, storageTypes: 'local_storage' });
    await sleep(100);
    const items = await send('DOMStorage.getDOMStorageItems', { storageId: { securityOrigin: origin, isLocalStorage: true } });
    if (!items.result || !items.result.entries || items.result.entries.length === 0) return;
  }
  throw new Error('could not clear saved progress');
}
async function load(url, { fresh = false } = {}) {
  if (fresh) await wipe();
  await send('Page.navigate', { url: BASE + url });
  await sleep(700);
}
const currentWord = () => evaluate(`[...document.querySelectorAll('#ladder .current .tile')].map((t) => t.textContent).join('').toLowerCase()`);
async function step(from, to) {
  const i = [...from].findIndex((c, k) => c !== to[k]);
  await tap(`#ladder .current .tile[data-i="${i}"]`);
  await tap(`.key[data-key="${to[i]}"]`);
  await sleep(80);
}

// Layout checks: everything fits, nothing scrolls sideways, touch targets are big enough.
async function checkLayout(dev, label) {
  await sleep(200); // let key-press animations finish
  const m = await evaluate(`(() => {
    const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, w: b.width, h: b.height }; };
    const keys = [...document.querySelectorAll('#keyboard .key')].map((k) => k.getBoundingClientRect());
    return {
      vw: innerWidth, vh: innerHeight, sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight,
      kb: r('#keyboard'), target: r('#target-row'), ladder: r('#ladder'), tile: r('#ladder .current .tile'), topbar: r('.topbar'),
      minKeyW: Math.min(...keys.map((k) => k.width)), minKeyH: Math.min(...keys.map((k) => k.height)),
      keysOut: keys.filter((k) => k.right > innerWidth + 0.5 || k.left < -0.5 || k.bottom > innerHeight + 0.5).length,
    };
  })()`);
  check(m.sw <= m.vw, `${label}: page scrolls sideways (${m.sw} > ${m.vw})`);
  check(m.sh <= m.vh + 1, `${label}: page taller than screen (${m.sh} > ${m.vh})`);
  check(m.kb && m.kb.bottom <= m.vh + 0.5, `${label}: keyboard runs off the bottom`);
  check(m.keysOut === 0, `${label}: ${m.keysOut} keys off screen`);
  check(m.minKeyW >= 28, `${label}: keys too narrow (${m.minKeyW.toFixed(1)}px)`);
  check(m.minKeyH >= 44, `${label}: keys too short (${m.minKeyH.toFixed(1)}px)`);
  check(m.target && m.target.bottom <= m.kb.top + 1 && m.target.top >= m.topbar.bottom, `${label}: target row hidden`);
  check(m.tile && m.tile.w >= 36, `${label}: letter tiles too small (${m.tile && m.tile.w}px)`);
  check(m.ladder && m.ladder.h >= 2 * (m.tile ? m.tile.h : 40), `${label}: ladder area too short (${m.ladder && m.ladder.h}px)`);
  return m;
}

// ---------- Run ----------
const DAY = '2026-12-05';
const puzzles = P.dailyPuzzles(DAY);
console.log(`Day ${DAY}: ` + P.LEVEL_ORDER.map((lv) => `${lv} ${puzzles[lv].start}→${puzzles[lv].target} par ${puzzles[lv].par}`).join(', '));

for (const dev of DEVICES) {
  console.log(`\n${dev.name} (${dev.width}×${dev.height}, ${DEVICES.indexOf(dev) % 2 ? 'dark' : 'light'} mode)`);
  const h = dev.height - dev.chromeH;
  await send('Emulation.setDeviceMetricsOverride', { width: dev.width, height: h, deviceScaleFactor: dev.dpr, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
  // Safe areas: Chrome doesn't emulate env(), so pad the same way with a style override.
  const safeCSS = `:root{} .app{padding-top:${dev.safeTop}px !important;} .keyboard,.below{padding-bottom:${Math.max(8, dev.safeBottom)}px !important;}`;
  const slug = dev.name.replace(/\W+/g, '-').toLowerCase();
  // Alternate light and dark mode so both get checked.
  const scheme = DEVICES.indexOf(dev) % 2 ? 'dark' : 'light';
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
  errors.length = 0;

  // First visit: splash, then the tutorial.
  await load(`?date=${DAY}`, { fresh: true });
  await evaluate(`document.head.insertAdjacentHTML('beforeend', '<style>${safeCSS}</style>')`);
  check(await visible('#splash'), 'splash shows');
  check((await text('.level-btn[data-level="easy"] .level-meta')).includes('4 letters'), 'splash shows level info');
  await shot(`${slug}-1-splash`);
  await tap('.level-btn[data-level="easy"]');
  await sleep(300);
  check(await visible('#tutorial-modal'), 'tutorial opens on first visit');

  // Play the tutorial through: tap the glowing tile, then the glowing key, four times.
  for (let k = 0; k < 4; k++) {
    await tap('#tut-ladder .tile.glow');
    await tap('#tut-keys .key.glow');
  }
  await sleep(200);
  check(await visible('#tut-done'), 'tutorial finishes in four steps');
  await shot(`${slug}-2-tutorial-done`);
  await tap('#tut-done');
  await sleep(200);
  check(!(await visible('#tutorial-modal')), 'tutorial closes');

  // Easy: the layout, then a real solve with a mistake, an undo and a hint along the way.
  const ez = puzzles.easy;
  await evaluate(`document.head.insertAdjacentHTML('beforeend', '<style>${safeCSS}</style>')`);
  await sleep(100);
  await checkLayout(dev, 'easy start');
  await shot(`${slug}-3-easy-start`);
  check((await currentWord()) === ez.start, `current word is ${ez.start}`);

  // Pressing a key with nothing selected explains what to do.
  await tap('.key[data-key="q"]');
  check((await text('#toast')).includes('Tap a letter'), 'key with nothing selected shows a tip');

  // An invalid word is rejected with a message.
  await tap('#ladder .current .tile[data-i="0"]');
  check(await evaluate(`document.querySelector('#ladder .current .tile[data-i="0"]').classList.contains('selected')`), 'tapping a tile selects it');
  const bad = 'q' + ez.start.slice(1);
  const badIsWord = P.isWord(bad);
  await tap('.key[data-key="q"]');
  if (!badIsWord) check((await text('#toast')).includes('isn’t in the word list'), 'invalid word is rejected');
  await sleep(700);
  await shot(`${slug}-4-invalid`);

  // A valid detour, then take it back.
  const D4 = P.dict(4);
  const detour = Array.from(D4.neighbors(D4.id.get(ez.start))).map((i) => D4.words[i]).find((w) => w !== ez.solution[1]);
  await tap('#ladder .current .tile.selected').catch(() => {}); // deselect
  await step(ez.start, detour);
  check((await currentWord()) === detour, `detour to ${detour} accepted`);
  check((await text('#steps')).startsWith('1'), 'step count is 1');
  await tap('.key[data-key="undo"]');
  check((await currentWord()) === ez.start, 'undo goes back');
  check((await text('#steps')).startsWith('0'), 'step count back to 0');

  // Hint needs two taps.
  await tap('.key[data-key="hint"]');
  check((await currentWord()) === ez.start, 'first hint tap only arms it');
  await tap('.key[data-key="hint"]');
  check((await currentWord()) === ez.solution[1], `hint adds ${ez.solution[1]}`);
  check((await text('#steps')).includes('+1'), 'hint penalty shows');

  // Finish the ladder.
  for (let k = 1; k < ez.solution.length - 1; k++) await step(ez.solution[k], ez.solution[k + 1]);
  await sleep(300);
  await shot(`${slug}-5-easy-solved`);
  await sleep(ez.par * 90 + 1200);
  check(await visible('#stats-modal'), 'results open after solving');
  check((await text('#r-par')) === 'Par +1', `score is Par +1 (got ${await text('#r-par')})`);
  check((await text('#r-squares')).length > 0, 'share squares show');
  check((await text('#r-path')).includes(ez.target.toUpperCase()), 'results show the ladder');
  await shot(`${slug}-6-results`);
  check(await visible('#r-next'), 'results offer the next level');
  await tap('#r-next');
  await sleep(300);

  // Medium: a few moves, then give up.
  const md = puzzles.medium;
  check((await currentWord()) === md.start, `medium starts at ${md.start}`);
  await checkLayout(dev, 'medium');
  await step(md.solution[0], md.solution[1]);
  await tap('#giveup-btn');
  await sleep(200);
  check(await visible('#giveup-modal'), 'give up asks first');
  await tap('#giveup-confirm');
  await sleep(md.par * 90 + 1700);
  check(await visible('#stats-modal'), 'results open after giving up');
  check((await text('#r-par')) === 'Gave up', 'gave up shows');
  check((await text('#r-path')).includes(md.solution.map((w) => w.toUpperCase()).join(' → ')), 'a shortest route is shown');
  await tap('#stats-modal .modal-close');
  await sleep(200);
  await shot(`${slug}-7-gaveup`);

  // Hard: the longest ladder, played to par with the keyboard, to check long ladders fit.
  await tap('.level-tab[data-level="hard"]');
  await sleep(200);
  const hd = puzzles.hard;
  for (let k = 0; k < hd.solution.length - 2; k++) await step(hd.solution[k], hd.solution[k + 1]);
  await checkLayout(dev, 'hard, long ladder');
  check(await evaluate(`(() => { const c = document.querySelector('#ladder .current').getBoundingClientRect(), l = document.querySelector('#ladder').getBoundingClientRect(); return c.top >= l.top - 1 && c.bottom <= l.bottom + 1; })()`), 'current word stays in view on a long ladder');
  await shot(`${slug}-8-hard-long`);
  await step(hd.solution.at(-2), hd.solution.at(-1));
  await sleep(hd.par * 90 + 1300);
  check((await text('#r-par')) === 'Par', 'hard solved at par');

  // The share text has every level in the expected format.
  const share = await evaluate(`(async () => {
    let got = null;
    navigator.share = async (d) => { got = d.text; };
    document.getElementById('share-btn').click();
    await new Promise((r) => setTimeout(r, 50));
    return got;
  })()`);
  const lines = (share || '').split('\n');
  check(/^Ladder #\d+ 🪜$/.test(lines[0]), `share header (${lines[0]})`);
  check(/^Easy · Par \+1 🟩🟩🟨🟨 💡1$|^Easy · Par \+1 🟩🟩🟩🟨 💡1$|^Easy · Par \+1 🟩🟨🟨🟨 💡1$/.test(lines[1]), `share easy line (${lines[1]})`);
  check(lines[2] === 'Medium · gave up 🏳️', `share medium line (${lines[2]})`);
  check(lines[3] === 'Hard · Par 🟩🟩🟩🟩', `share hard line (${lines[3]})`);
  check(lines[4] === 'ladder.mfrucht33.workers.dev', `share url (${lines[4]})`);

  // Progress survives a reload, and today's stats are recorded.
  await load(`?date=${DAY}&play=hard`);
  check(await visible('#stats-modal'), 'finished level reopens its results after reload');
  check(errors.length === 0, `no console errors (${errors.join(' | ')})`);
}

// Stats only count real days, so check a real-today solve updates the streak.
console.log('\nStreak on a real day');
await load('', { fresh: true });
await evaluate(`localStorage.setItem('ladder:v1:flags', JSON.stringify({ seenHelp: true }))`);
await load('?play=easy');
const real = P.dailyPuzzles(P.dateKey(new Date())).easy;
for (let k = 0; k < real.solution.length - 1; k++) await step(real.solution[k], real.solution[k + 1]);
await sleep(real.par * 90 + 1300);
check((await text('#s-streak')) === '1', `streak is 1 after a solve (got ${await text('#s-streak')})`);
check((await text('#s-played')) === '1', 'played is 1');

console.log(`\n${checks - failures}/${checks} checks passed. Screenshots in test/screenshots/`);
ws.close(); chrome.kill(); server.close();
process.exit(failures ? 1 : 0);
