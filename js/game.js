/* Ladder game UI. Depends on window.Puzzle (puzzle.js) and window.LADDER_CONFIG (config.js). */
(function () {
  'use strict';

  const P = window.Puzzle;
  const CFG = window.LADDER_CONFIG;
  const { LEVELS, LEVEL_ORDER } = P;

  const HINT_PENALTY = CFG.hintPenalty ?? 1; // each hint adds this many steps to your score
  const RISE_STEP_MS = 90;                    // win animation: delay between rungs
  const STORE_PROGRESS = 'ladder:v1:progress';
  const STORE_STATS = 'ladder:v1:stats';
  const STORE_FLAGS = 'ladder:v1:flags';
  const STORE_PUZZLES = 'ladder:v1:puzzles';

  const $ = (id) => document.getElementById(id);
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = window.navigator.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches;
  if (isStandalone) document.documentElement.classList.add('standalone');

  // ---------- Storage (iOS private mode or blocked storage can throw) ----------
  const store = {
    get(k, fallback) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
  };
  const flags = () => store.get(STORE_FLAGS, {});
  const setFlag = (k, v) => store.set(STORE_FLAGS, { ...flags(), [k]: v });

  // ---------- Which day? ----------
  const params = new URLSearchParams(location.search);
  const override = params.get('date'); // ?date=2026-11-28 previews another day (testing only)
  let today = new Date();
  if (override && /^\d{4}-\d{2}-\d{2}$/.test(override)) {
    const [y, m, d] = override.split('-').map(Number);
    today = new Date(y, m - 1, d);
  }
  const dayKey = P.dateKey(today);
  const number = P.puzzleNumber(today, CFG.launchDate);
  const isRealToday = !override || override === P.dateKey(new Date());

  // Today's puzzles. Generating usually takes a few milliseconds (rarely a second on an old
  // phone), so it waits until the splash has painted, and the result is cached for the day.
  let puzzles = null;
  function getPuzzles() {
    if (puzzles) return puzzles;
    const cached = store.get(STORE_PUZZLES, null);
    if (cached && cached.key === dayKey && cached.version === P.VERSION) puzzles = cached.puzzles;
    else {
      puzzles = P.dailyPuzzles(dayKey);
      store.set(STORE_PUZZLES, { key: dayKey, version: P.VERSION, puzzles });
    }
    return puzzles;
  }
  const getPuzzle = (level) => getPuzzles()[level];

  // ---------- Progress for today's three puzzles ----------
  let progress = store.get(STORE_PROGRESS, null);
  if (!progress || progress.date !== dayKey) progress = { date: dayKey, levels: {} };
  function levelState(level) {
    if (!progress.levels[level]) {
      progress.levels[level] = {
        ladder: [getPuzzle(level).start], // every word so far, start first
        hinted: [],                       // words that came from hints
        moves: 0, hints: 0, elapsed: 0, solved: false, gaveUp: false,
      };
    }
    return progress.levels[level];
  }
  const isDone = (st) => st && (st.solved || st.gaveUp);
  const stepsOf = (st) => st.ladder.length - 1;

  // The level on screen.
  let game = null; // { level, puzzle, st }
  let sel = null;  // selected letter position in the current word
  let typed = '';  // desktop: a whole word being typed

  function save() {
    // Bank the running clock into the saved state without stopping it.
    if (game && runStart !== null) { game.st.elapsed = liveElapsed(); runStart = performance.now(); }
    store.set(STORE_PROGRESS, progress);
  }

  // ---------- Clock (one running clock: the visible level's) ----------
  let runStart = null;
  function liveElapsed() { return game.st.elapsed + (runStart !== null ? performance.now() - runStart : 0); }
  function elapsedMs() { return game ? liveElapsed() : 0; }
  function startClock() { if (game && runStart === null && !isDone(game.st)) runStart = performance.now(); }
  function pauseClock() { if (game && runStart !== null) { game.st.elapsed = liveElapsed(); runStart = null; } }
  const fmtTime = (ms) => {
    const s = Math.floor(ms / 1000);
    const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
    return hh ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`;
  };
  setInterval(() => { if (runStart !== null) $('time').textContent = fmtTime(elapsedMs()); }, 250);

  // The clock starts with your first move and only runs while you can see the puzzle.
  const canRun = () => game && game.st.moves > 0 && !isDone(game.st) && !$('app').hidden && !anyModalOpen();

  // iOS freezes background tabs and may keep one open for days. Pause when hidden,
  // and if the date rolled over while we were away, load the new puzzles.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { pauseClock(); save(); return; }
    if (!override && P.dateKey(new Date()) !== dayKey) { location.reload(); return; }
    if (canRun()) startClock();
  });
  window.addEventListener('pagehide', () => { pauseClock(); save(); });
  // Back-forward cache: a restored page may be from yesterday.
  window.addEventListener('pageshow', (e) => {
    if (e.persisted && !override && P.dateKey(new Date()) !== dayKey) location.reload();
  });

  // ---------- Haptics ----------
  // Android: Vibration API. iOS Safari 18+: toggling a hidden <input switch> fires the system haptic.
  let hapticLabel = null;
  if (isIOS) {
    hapticLabel = document.createElement('label');
    hapticLabel.setAttribute('aria-hidden', 'true');
    hapticLabel.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('switch', '');
    input.tabIndex = -1;
    hapticLabel.appendChild(input);
    document.body.appendChild(hapticLabel);
  }
  function haptic(pattern) {
    if (navigator.vibrate) { try { navigator.vibrate(pattern); } catch { /* ignore */ } }
    else if (hapticLabel) hapticLabel.click();
  }

  // ---------- Rendering the ladder ----------
  const ladderEl = $('ladder');
  const targetEl = $('target-row');
  const up = (w) => w.toUpperCase();

  function tileHTML(ch, cls, attrs = '') {
    return `<span class="tile ${cls}" ${attrs}>${ch ? up(ch) : ''}</span>`;
  }

  /** One rung: a row of letter tiles with a step number on the left. */
  function rungHTML(word, { prev, target, label, cls = '', current = false, hint = false, style = '' }) {
    let tiles = '';
    for (let i = 0; i < word.length; i++) {
      const c = [];
      if (prev && prev[i] !== word[i]) c.push('changed');
      if (target && word[i] === target[i]) c.push('match');
      if (current) {
        if (sel === i) c.push('selected');
        const pos = `${i + 1} of ${word.length}`;
        tiles += `<button type="button" class="tile ${c.join(' ')}" data-i="${i}" aria-label="${up(word[i])}, letter ${pos}${sel === i ? ', selected' : ''}" aria-pressed="${sel === i}">${up(word[i])}</button>`;
      } else tiles += tileHTML(word[i], c.join(' '));
    }
    return `<div class="rung-row ${cls}" style="${style}"><span class="rung-label">${label}</span><div class="tiles">${tiles}</div><span class="rung-mark">${hint ? '💡' : ''}</span></div>`;
  }

  function render(opts = {}) {
    if (!game) return;
    const { puzzle, st } = game;
    const { ladder } = st;
    const done = isDone(st);
    const cur = ladder[ladder.length - 1];
    const L = puzzle.len;
    ladderEl.style.setProperty('--len', L);
    targetEl.style.setProperty('--len', L);

    // When solved, the last word is the target, which is shown in the target row instead.
    const shown = st.solved || (st.gaveUp && cur === puzzle.target) ? ladder.slice(0, -1) : ladder;
    const hinted = new Set(st.hinted);
    let html = '';
    shown.forEach((w, i) => {
      const isCur = !done && i === shown.length - 1;
      let cls = i === 0 ? 'start' : '';
      if (isCur) cls += ' current';
      if (isCur && typed) {
        // Desktop typing: show what's been typed so far over the current word.
        let tiles = '';
        for (let k = 0; k < L; k++) tiles += tileHTML(typed[k] || '', typed[k] ? 'typed' : 'empty');
        html += `<div class="rung-row ${cls} typing"><span class="rung-label">${i || 'Start'}</span><div class="tiles">${tiles}</div><span class="rung-mark"></span></div>`;
        return;
      }
      const style = opts.rise ? `--delay:${i * RISE_STEP_MS}ms` : '';
      html += rungHTML(w, {
        prev: i ? shown[i - 1] : null, target: puzzle.target, label: i || 'Start',
        cls: cls + (opts.rise ? ' rise' : ''), current: isCur, hint: i > 0 && hinted.has(w), style,
      });
    });
    // Empty rungs for the steps par still allows, so you can see how far there is to go.
    if (!done) {
      const left = puzzle.par - (ladder.length - 1) - 1;
      for (let k = 0; k < left; k++) html += `<div class="rung-row empty" aria-hidden="true"><span class="rung-label"></span><div class="tiles">${'<span class="tile"></span>'.repeat(L)}</div><span class="rung-mark"></span></div>`;
    }
    ladderEl.innerHTML = html;

    const reached = st.solved || (st.gaveUp && cur === puzzle.target);
    targetEl.className = `rung-row target-row${reached ? ' reached' : ''}${st.gaveUp ? ' gaveup' : ''}${opts.rise && reached ? ' rise' : ''}`;
    if (opts.rise) targetEl.style.setProperty('--delay', `${shown.length * RISE_STEP_MS}ms`);
    const lastShown = shown[shown.length - 1];
    let ttiles = '';
    for (let i = 0; i < L; i++) {
      const c = ['target'];
      if (reached && lastShown && lastShown[i] !== puzzle.target[i]) c.push('changed');
      ttiles += tileHTML(puzzle.target[i], c.join(' '));
    }
    targetEl.innerHTML = `<span class="rung-label">${reached ? ladder.length - 1 : 'Goal'}</span><div class="tiles">${ttiles}</div><span class="rung-mark">${reached && hinted.has(puzzle.target) ? '💡' : ''}</span>`;
    targetEl.setAttribute('aria-label', `Target word ${up(puzzle.target)}`);

    // HUD
    const pen = (st.hints || 0) * HINT_PENALTY;
    $('steps').innerHTML = pen ? `${stepsOf(st)}<small class="hud-pen">+${pen}</small>` : String(stepsOf(st));
    $('par').textContent = puzzle.par;
    $('time').textContent = fmtTime(elapsedMs());
    $('giveup-btn').hidden = done;
    renderKeyboard();
    hintLine();

    // Keep the newest rung in view.
    requestAnimationFrame(() => {
      const row = ladderEl.querySelector('.current') || ladderEl.lastElementChild;
      if (row) row.scrollIntoView({ block: 'nearest', behavior: opts.smooth ? 'smooth' : 'auto' });
    });
  }

  function hintLine() {
    const { st, puzzle } = game;
    let text;
    if (st.solved) text = 'You reached the top!';
    else if (st.gaveUp) text = 'Here’s a shortest route';
    else if (typed) text = 'Type the whole word, then press Enter';
    else if (sel !== null) text = `Now pick a new letter for ${up(game.st.ladder.at(-1)[sel])}`;
    else if (st.ladder.length === 1) text = `Tap a letter in ${up(puzzle.start)}, then a new letter`;
    else text = 'Tap a letter, then a new letter';
    $('hint-line').textContent = text;
  }

  // ---------- Keyboard ----------
  const ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
  const kb = $('keyboard');
  const UNDO_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7H4V2M4.5 7A8 8 0 1 1 4 13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const BULB_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1.1 2V16h5v-.2c.1-.8.5-1.5 1.1-2A6 6 0 0 0 12 3z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  kb.innerHTML = ROWS.map((row, r) => {
    let keys = row.split('').map((ch) => `<button type="button" class="key" data-key="${ch}" aria-label="${up(ch)}">${up(ch)}</button>`).join('');
    if (r === 2) {
      keys = `<button type="button" class="key key-wide" data-key="undo" aria-label="Take back a step">${UNDO_SVG}<span>Back</span></button>` + keys +
        `<button type="button" class="key key-wide key-hint" data-key="hint" aria-label="Hint: fill in the next word, plus ${HINT_PENALTY} step">${BULB_SVG}<span>Hint</span></button>`;
    }
    return `<div class="kb-row">${keys}</div>`;
  }).join('');

  function renderKeyboard() {
    const done = isDone(game.st);
    $('keyboard').hidden = done;
    $('below').hidden = !done;
    if (done) loadAd('ad-footer', CFG.adsense.slots.footer);
    const cur = game.st.ladder.at(-1);
    kb.querySelectorAll('.key[data-key]').forEach((k) => {
      const ch = k.dataset.key;
      if (ch.length === 1) k.classList.toggle('same', sel !== null && cur[sel] === ch);
    });
    kb.querySelector('[data-key="undo"]').disabled = game.st.ladder.length <= 1 && !typed;
    const hk = kb.querySelector('[data-key="hint"]');
    if (!hintArmed) { hk.classList.remove('armed'); hk.querySelector('span').textContent = 'Hint'; }
  }

  // Keys react on pointerdown for speed (like Wordle); a click from a keyboard or
  // screen reader still works because we ignore the click that follows a pointerdown.
  let lastPointerKey = 0;
  kb.addEventListener('pointerdown', (e) => {
    const k = e.target.closest('.key');
    if (!k || k.disabled || e.button > 0) return;
    e.preventDefault();
    lastPointerKey = Date.now();
    k.classList.add('down');
    setTimeout(() => k.classList.remove('down'), 120);
    onKey(k.dataset.key);
  });
  kb.addEventListener('click', (e) => {
    const k = e.target.closest('.key');
    if (!k || Date.now() - lastPointerKey < 600) return;
    onKey(k.dataset.key);
  });
  kb.addEventListener('contextmenu', (e) => e.preventDefault());

  function onKey(key) {
    if (!game || isDone(game.st) || anyModalOpen()) return;
    if (key === 'undo') { if (typed) { typed = typed.slice(0, -1); render(); } else undo(); return; }
    if (key === 'hint') { pressHint(); return; }
    pressLetter(key);
  }

  // ---------- Moves ----------
  const currentRow = () => ladderEl.querySelector('.current');
  function shake(row = currentRow()) {
    if (!row) return;
    row.classList.remove('shake'); void row.offsetWidth; row.classList.add('shake');
  }
  function flashTile(i, letter) {
    const t = currentRow() && currentRow().querySelector(`[data-i="${i}"]`);
    if (!t) return;
    t.textContent = up(letter);
    t.classList.add('bad');
    setTimeout(() => { t.classList.remove('bad'); t.textContent = up(game.st.ladder.at(-1)[i]); }, 650);
  }

  ladderEl.addEventListener('click', (e) => {
    const t = e.target.closest('.current .tile[data-i]');
    if (!t || !game || isDone(game.st)) return;
    typed = '';
    const i = Number(t.dataset.i);
    sel = sel === i ? null : i;
    haptic(6);
    render();
  });

  function pressLetter(ch) {
    const st = game.st;
    const cur = st.ladder.at(-1);
    if (sel === null) {
      // Nothing selected: nudge them toward the two-tap flow.
      toast('Tap a letter in your word first');
      const row = currentRow();
      if (row) { row.classList.remove('pulse'); void row.offsetWidth; row.classList.add('pulse'); }
      haptic([10, 30, 10]);
      return;
    }
    if (cur[sel] === ch) { toast(`That’s already ${up(ch)}. Pick a different letter`); shake(); return; }
    const next = cur.slice(0, sel) + ch + cur.slice(sel + 1);
    if (!P.isWord(next)) {
      flashTile(sel, ch);
      shake();
      haptic([30, 40, 30]);
      toast(`${up(next)} isn’t in the word list`);
      return;
    }
    commit(next);
  }

  function commit(word, { hint = false } = {}) {
    const st = game.st;
    startClock();
    const seen = st.ladder.indexOf(word);
    if (seen >= 0) {
      // Back to a word you've already used: cut out the loop.
      st.ladder.length = seen + 1;
      st.hinted = st.hinted.filter((w) => st.ladder.includes(w));
      toast(`Back to ${up(word)}`);
    } else {
      st.ladder.push(word);
      if (hint) st.hinted.push(word);
    }
    st.moves++;
    sel = null; typed = '';
    if (st.moves === 1) renderTabs();
    haptic(8);
    if (word === game.puzzle.target) { win(); return; }
    save();
    render({ smooth: true });
    const row = currentRow();
    if (row) row.classList.add('pop');
  }

  function undo() {
    const st = game.st;
    if (st.ladder.length <= 1) return;
    const gone = st.ladder.pop();
    st.hinted = st.hinted.filter((w) => w !== gone);
    sel = null;
    haptic(6);
    save();
    render();
  }

  // ---------- Hints ----------
  // The hint key asks for a second tap, so a stray tap next to M doesn't cost a step.
  let hintArmed = false, hintTimer = null;
  function pressHint() {
    const hk = kb.querySelector('[data-key="hint"]');
    if (!hintArmed) {
      hintArmed = true;
      hk.classList.add('armed');
      hk.querySelector('span').textContent = `+${HINT_PENALTY}?`;
      clearTimeout(hintTimer);
      hintTimer = setTimeout(() => { hintArmed = false; renderKeyboard(); }, 2500);
      haptic(6);
      return;
    }
    hintArmed = false;
    clearTimeout(hintTimer);
    useHint();
  }

  // Adds the next word on a shortest route from where you are now.
  // To offer "watch an ad for a hint" later, show the ad first and call this when it's done
  // (for example, after the first free hint: if (game.st.hints >= 1) showRewardedAd(useHint)).
  function useHint() {
    const { st, puzzle } = game;
    if (isDone(st)) return;
    const next = P.nextStep(st.ladder.at(-1), puzzle.target, puzzle.solution);
    if (!next) return;
    st.hints = (st.hints || 0) + 1;
    toast(`Hint: ${up(next)} · +${HINT_PENALTY} step`);
    commit(next, { hint: true });
  }

  // ---------- Desktop typing ----------
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape') {
      const open = document.querySelectorAll('.modal:not([hidden])');
      if (open.length) { open.forEach(closeModal); return; }
      if (game && (sel !== null || typed)) { sel = null; typed = ''; render(); }
      return;
    }
    if (!game || $('app').hidden || anyModalOpen() || isDone(game.st)) return;
    const L = game.puzzle.len;
    const k = e.key.toLowerCase();
    if (/^[a-z]$/.test(k)) {
      e.preventDefault();
      if (sel !== null && !typed) { pressLetter(k); return; }
      if (typed.length < L) { typed += k; sel = null; render(); }
      return;
    }
    if (/^[1-9]$/.test(k) && Number(k) <= L && !typed) { sel = Number(k) - 1; render(); return; }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (typed) return;
      e.preventDefault();
      const d = e.key === 'ArrowLeft' ? -1 : 1;
      sel = sel === null ? (d > 0 ? 0 : L - 1) : (sel + d + L) % L;
      render();
      return;
    }
    if (e.key === 'Backspace') {
      e.preventDefault();
      if (typed) { typed = typed.slice(0, -1); render(); } else undo();
      return;
    }
    if (e.key === 'Enter' && typed) { e.preventDefault(); submitTyped(); }
  });

  function submitTyped() {
    const L = game.puzzle.len;
    const cur = game.st.ladder.at(-1);
    if (typed.length < L) { shake(ladderEl.querySelector('.typing')); toast(`Type all ${L} letters`); return; }
    const diff = P.hamming(cur, typed);
    const word = typed;
    let msg = null;
    if (diff === 0) msg = 'That’s the same word';
    else if (diff > 1) msg = `Change just one letter of ${up(cur)}`;
    else if (!P.isWord(word)) msg = `${up(word)} isn’t in the word list`;
    if (msg) { toast(msg); shake(ladderEl.querySelector('.typing')); haptic([30, 40, 30]); return; }
    typed = '';
    commit(word);
  }

  // ---------- Mounting a level ----------
  function mountLevel(level) {
    pauseClock();
    if (game) save();
    const puzzle = getPuzzle(level);
    const st = levelState(level);
    game = { level, puzzle, st };
    sel = null; typed = ''; hintArmed = false;
    $('puzzle-label').textContent = `#${number} · ${LEVELS[level].label}`;
    setFlag('lastLevel', level);
    renderTabs();
    render();
    updateActions();
    if (canRun()) startClock();
  }

  // ---------- Finishing: win or give up ----------
  function win() {
    pauseClock();
    game.st.solved = true;
    save();
    recordResult(game.level, game.st);
    renderTabs();
    updateActions();
    render({ rise: true });
    haptic([20, 60, 20, 60, 40]);
    const level = game.level;
    setTimeout(() => { if (game.level === level) openResults(); }, game.st.ladder.length * RISE_STEP_MS + 900);
  }

  function giveUp() {
    const { puzzle, st } = game;
    pauseClock();
    st.ladder = puzzle.solution.slice();
    st.hinted = [];
    st.gaveUp = true;
    sel = null; typed = '';
    save();
    recordResult(game.level, st);
    renderTabs();
    updateActions();
    render({ rise: true });
    const level = game.level;
    setTimeout(() => { if (game.level === level) openResults(); }, st.ladder.length * RISE_STEP_MS + 1300);
  }

  function updateActions() {
    const done = isDone(game.st);
    const next = nextLevel();
    $('next-level').hidden = !done || !next;
    if (next) $('next-level').textContent = `Play ${LEVELS[next].label}`;
  }

  // The next unfinished level after the current one (wrapping), if any.
  function nextLevel() {
    const i = LEVEL_ORDER.indexOf(game.level);
    for (let k = 1; k < LEVEL_ORDER.length; k++) {
      const lv = LEVEL_ORDER[(i + k) % LEVEL_ORDER.length];
      if (!isDone(progress.levels[lv])) return lv;
    }
    return null;
  }

  // ---------- Scoring ----------
  // Grades are by percent over par, so +2 on a par-7 Hard ladder scores close to +1 on a
  // par-4 Easy one. Pars are small, so the bands are wider than Pipeflow's.
  //   Par: 🟩🟩🟩🟩   up to 20%: 🟩🟩🟩🟨   up to 40%: 🟩🟩🟨🟨
  //   up to 70%: 🟩🟨🟨🟨   up to 100%: 🟨🟨🟨🟨   more: 🟨🟨🟨🟧
  const TIER_LIMITS = [0, 0.20, 0.40, 0.70, 1.00];
  function tier(delta, par) {
    if (delta <= 0) return 0;
    const pct = delta / Math.max(1, par);
    const i = TIER_LIMITS.findIndex((lim) => pct <= lim);
    return i === -1 ? 5 : i;
  }
  const SQUARES = ['🟩🟩🟩🟩', '🟩🟩🟩🟨', '🟩🟩🟨🟨', '🟩🟨🟨🟨', '🟨🟨🟨🟨', '🟨🟨🟨🟧'];
  const VERDICTS = ['Perfect climb', 'Great climb', 'Nice climb', 'Made it up', 'The long way round', 'You got there'];
  const squares = (delta, par) => SQUARES[tier(delta, par)];
  const verdict = (delta, par) => VERDICTS[tier(delta, par)];
  const parText = (delta) => (delta <= 0 ? 'Par' : `Par +${delta}`);
  // Score vs par: steps plus the hint penalty. Works on live state and saved results.
  const deltaOf = (r, par) => r.steps + (r.hints || 0) * HINT_PENALTY - (par !== undefined ? par : r.par);
  const liveDelta = (st, par) => deltaOf({ steps: stepsOf(st), hints: st.hints }, par);
  const hintText = (n) => (n ? ` · ${n} hint${n > 1 ? 's' : ''}` : '');

  function shareText() {
    const lines = [`${CFG.name} #${number} 🪜`];
    for (const lv of LEVEL_ORDER) {
      const st = progress.levels[lv];
      if (!isDone(st)) continue;
      const label = LEVELS[lv].label;
      const par = getPuzzle(lv).par;
      if (st.gaveUp) lines.push(`${label} · gave up 🏳️`);
      else {
        const delta = liveDelta(st, par);
        lines.push(`${label} · ${parText(delta)} ${squares(delta, par)}${st.hints ? ` 💡${st.hints}` : ''}`);
      }
    }
    lines.push(CFG.siteUrl);
    return lines.join('\n');
  }

  // ---------- Stats ----------
  // history: { 'YYYY-MM-DD': { easy: { steps, hints, par, timeMs } | { gaveUp: true, timeMs }, ... } }
  function recordResult(level, st) {
    if (!isRealToday) return;
    const stats = store.get(STORE_STATS, { history: {} });
    const day = (stats.history[dayKey] ||= {});
    if (day[level]) return;
    day[level] = st.gaveUp
      ? { gaveUp: true, timeMs: Math.round(st.elapsed) }
      : { steps: stepsOf(st), hints: st.hints || 0, par: getPuzzle(level).par, timeMs: Math.round(st.elapsed) };
    store.set(STORE_STATS, stats);
  }

  function computeStats() {
    const { history } = store.get(STORE_STATS, { history: {} });
    const entries = [];
    for (const [date, levels] of Object.entries(history)) {
      for (const [level, r] of Object.entries(levels)) entries.push({ date, level, ...r });
    }
    const solved = entries.filter((e) => !e.gaveUp);
    // A streak day is any day you solved at least one of the three puzzles.
    const solvedDay = (d) => { const lv = history[P.dateKey(d)]; return !!lv && Object.values(lv).some((r) => !r.gaveUp); };
    const day = new Date(); day.setHours(12, 0, 0, 0);
    if (!solvedDay(day)) day.setDate(day.getDate() - 1);
    let streak = 0;
    while (solvedDay(day)) { streak++; day.setDate(day.getDate() - 1); }

    let max = 0, run = 0, prev = null;
    for (const k of Object.keys(history).sort()) {
      const [y, m, d] = k.split('-').map(Number);
      const t = new Date(y, m - 1, d, 12);
      if (!solvedDay(t)) { run = 0; prev = null; continue; }
      run = prev && Math.round((t - prev) / 86400000) === 1 ? run + 1 : 1;
      max = Math.max(max, run);
      prev = t;
    }
    // Rows count steps over par (hints included): Par, +1, +2, +3, +4 or more.
    const rowOf = (e) => Math.min(4, Math.max(0, deltaOf(e)));
    const rows = solved.map(rowOf);
    const buckets = ['Par', '+1', '+2', '+3', '+4 or more']
      .map((label, i) => ({ label, row: i, count: rows.filter((r) => r === i).length }));
    buckets.push({ label: 'Gave up', gaveUp: true, count: entries.length - solved.length });
    return {
      played: entries.length,
      solvePct: entries.length ? Math.round((100 * solved.length) / entries.length) : 0,
      streak, max, buckets, history, rowOf,
    };
  }

  function renderStats() {
    const s = computeStats();
    $('s-played').textContent = s.played;
    $('s-pct').textContent = s.solvePct;
    $('s-streak').textContent = s.streak;
    $('s-max').textContent = s.max;
    const most = Math.max(1, ...s.buckets.map((b) => b.count));
    const mine = s.history[dayKey] && game ? s.history[dayKey][game.level] : null;
    $('s-dist').innerHTML = s.buckets.map((b) => {
      let isToday = false;
      if (mine) isToday = b.gaveUp ? !!mine.gaveUp : !mine.gaveUp && s.rowOf(mine) === b.row;
      return `<div class="dist-row"><span>${b.label}</span><span class="dist-bar${isToday ? ' today' : ''}" style="width:${Math.max(8, (b.count / most) * 100)}%">${b.count}</span></div>`;
    }).join('');
  }

  // ---------- Level tabs and splash buttons ----------
  function statusOf(level) {
    const st = progress.levels[level];
    if (!st) return '';
    if (st.solved) return 'solved';
    if (st.gaveUp) return 'gaveup';
    return st.moves > 0 ? 'started' : '';
  }
  const STATUS_TEXT = { solved: 'Solved', gaveup: 'Gave up', started: 'In progress', '': '' };

  function renderTabs() {
    document.querySelectorAll('.level-tab').forEach((b) => {
      const lv = b.dataset.level;
      b.setAttribute('aria-selected', String(!!game && game.level === lv));
      b.dataset.status = statusOf(lv);
      b.title = STATUS_TEXT[statusOf(lv)] || LEVELS[lv].label;
    });
    document.querySelectorAll('.level-btn').forEach((b) => {
      const lv = b.dataset.level;
      const status = statusOf(lv);
      b.dataset.status = status;
      const p = getPuzzle(lv);
      b.querySelector('.level-meta').textContent = STATUS_TEXT[status] || `${p.len} letters · par ${p.par}`;
    });
  }

  document.querySelectorAll('.level-tab').forEach((b) => b.addEventListener('click', () => {
    if (game && game.level === b.dataset.level) return;
    mountLevel(b.dataset.level);
  }));

  // ---------- Modals ----------
  const anyModalOpen = () => [...document.querySelectorAll('.modal')].some((m) => !m.hidden);
  let lastFocus = null;
  function openModal(id) {
    lastFocus = document.activeElement;
    pauseClock();
    $(id).hidden = false;
    const focusTarget = $(id).querySelector('[data-autofocus]') || $(id).querySelector('.modal-close');
    if (focusTarget) focusTarget.focus({ preventScroll: true });
  }
  function closeModal(m) {
    m.hidden = true;
    if (!anyModalOpen()) {
      if (canRun()) startClock();
      if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
    }
  }
  document.querySelectorAll('.modal').forEach((m) => {
    m.addEventListener('click', (e) => {
      if (e.target === m || e.target.closest('.modal-close') || e.target.closest('[data-close]')) closeModal(m);
    });
  });

  function openResults() {
    const { st, puzzle, level } = game;
    $('result-block').hidden = false;
    $('result-kicker').textContent = `${CFG.name} #${number} · ${LEVELS[level].label}`;
    $('r-time').textContent = fmtTime(st.elapsed);
    const stepsLine = (n) => `${n} step${n === 1 ? '' : 's'}${hintText(st.hints)} · par ${puzzle.par}`;
    if (st.gaveUp) {
      $('result-title').textContent = 'Here’s a shortest route';
      $('r-par').textContent = 'Gave up';
      $('r-steps').textContent = `par ${puzzle.par}`;
      $('r-squares').textContent = '';
    } else {
      const delta = liveDelta(st, puzzle.par);
      $('result-title').textContent = verdict(delta, puzzle.par);
      $('r-par').textContent = parText(delta);
      $('r-steps').textContent = stepsLine(stepsOf(st));
      $('r-squares').textContent = squares(delta, puzzle.par);
    }
    // Your route (or the shortest one), and a shortest route if yours was longer.
    const route = st.ladder.map(up).join(' → ');
    let pathHTML = `<p><strong>${st.gaveUp ? 'Shortest route' : 'Your ladder'}:</strong> ${route}</p>`;
    if (!st.gaveUp && stepsOf(st) > puzzle.par) pathHTML += `<p><strong>A par route:</strong> ${puzzle.solution.map(up).join(' → ')}</p>`;
    $('r-path').innerHTML = pathHTML;
    const next = nextLevel();
    $('r-next').hidden = !next;
    if (next) {
      $('r-next').textContent = `Play ${LEVELS[next].label} →`;
      $('r-next').dataset.level = next;
    }
    // On iPhone in Safari, suggest Add to Home Screen once they've finished a puzzle.
    $('a2hs').hidden = !(isIOS && !isStandalone && !flags().a2hsDismissed);
    renderStats();
    openModal('stats-modal');
    loadAd('ad-results', CFG.adsense.slots.results);
  }
  $('r-next').addEventListener('click', () => {
    closeModal($('stats-modal'));
    mountLevel($('r-next').dataset.level);
  });
  $('a2hs-close').addEventListener('click', () => { setFlag('a2hsDismissed', true); $('a2hs').hidden = true; });

  $('help-btn').addEventListener('click', () => openModal('help-modal'));
  $('splash-help').addEventListener('click', () => openModal('help-modal'));
  $('stats-btn').addEventListener('click', () => {
    if (game && isDone(game.st)) { openResults(); return; }
    $('result-block').hidden = true;
    renderStats();
    openModal('stats-modal');
  });
  $('show-results').addEventListener('click', openResults);
  $('next-level').addEventListener('click', () => { const nx = nextLevel(); if (nx) mountLevel(nx); });

  // Give up asks first, so a stray tap can't throw the puzzle away.
  $('giveup-btn').addEventListener('click', () => openModal('giveup-modal'));
  $('giveup-confirm').addEventListener('click', () => {
    closeModal($('giveup-modal'));
    giveUp();
  });

  // ---------- Share ----------
  $('share-btn').addEventListener('click', async () => {
    const text = shareText();
    // The iOS share sheet goes straight to Messages, which is where daily-game results get shared.
    if (navigator.share && (isIOS || navigator.maxTouchPoints > 0)) {
      try { await navigator.share({ text }); return; } catch (err) { if (err && err.name === 'AbortError') return; }
    }
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied results to clipboard');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
      toast('Copied results to clipboard');
    }
  });

  let toastTimer;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
  }

  // ---------- Countdown to the next puzzles ----------
  setInterval(() => {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const ms = next - now;
    $('countdown').textContent = fmtTime(ms).padStart(8, '0');
    if (ms < 1000 && !override) setTimeout(() => location.reload(), 1500);
  }, 1000);

  // ---------- Ads ----------
  let adsLoaded = false;
  function loadAd(containerId, slot) {
    const client = CFG.adsense && CFG.adsense.client;
    if (!client || !slot) return;
    const box = $(containerId);
    if (box.dataset.filled) return;
    if (!adsLoaded) {
      const s = document.createElement('script');
      s.async = true;
      s.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(client)}`;
      s.crossOrigin = 'anonymous';
      document.head.appendChild(s);
      adsLoaded = true;
    }
    box.innerHTML = `<ins class="adsbygoogle" style="display:block;width:100%" data-ad-client="${client}" data-ad-slot="${slot}" data-ad-format="auto" data-full-width-responsive="true"></ins>`;
    box.hidden = false;
    box.dataset.filled = '1';
    (window.adsbygoogle = window.adsbygoogle || []).push({});
  }

  // ---------- Tutorial: COLD → CORD → WORD → WARD → WARM ----------
  // Each step: tap the glowing letter, then the glowing key.
  const TUT = { start: 'cold', target: 'warm', steps: [[2, 'r'], [0, 'w'], [1, 'a'], [3, 'm']] };
  let tut = null;

  function openTutorial() {
    tut = { ladder: [TUT.start], step: 0, picked: null, done: false };
    $('tut-keys').innerHTML = ['w', 'a', 'r', 'm', 'e'].map((ch) => `<button type="button" class="key" data-key="${ch}">${up(ch)}</button>`).join('');
    $('tut-done').hidden = true;
    tutRender();
    openModal('tutorial-modal');
  }

  function tutRender() {
    const cur = tut.ladder.at(-1);
    const [pos, letter] = TUT.steps[tut.step] || [];
    let html = '';
    tut.ladder.forEach((w, i) => {
      const isCur = !tut.done && i === tut.ladder.length - 1;
      let tiles = '';
      for (let k = 0; k < 4; k++) {
        const c = [];
        if (i && tut.ladder[i - 1][k] !== w[k]) c.push('changed');
        if (w[k] === TUT.target[k]) c.push('match');
        if (isCur && tut.picked === k) c.push('selected');
        if (isCur && tut.picked === null && k === pos) c.push('glow');
        tiles += isCur ? `<button type="button" class="tile ${c.join(' ')}" data-i="${k}">${up(w[k])}</button>` : tileHTML(w[k], c.join(' '));
      }
      html += `<div class="rung-row${i === 0 ? ' start' : ''}${isCur ? ' current' : ''}"><span class="rung-label">${i || 'Start'}</span><div class="tiles">${tiles}</div><span class="rung-mark"></span></div>`;
    });
    if (!tut.done) {
      let t = '';
      for (let k = 0; k < 4; k++) t += tileHTML(TUT.target[k], 'target');
      html += `<div class="rung-row target-row"><span class="rung-label">Goal</span><div class="tiles">${t}</div><span class="rung-mark"></span></div>`;
    }
    $('tut-ladder').innerHTML = html;
    $('tut-ladder').style.setProperty('--len', 4);
    $('tut-keys').querySelectorAll('.key').forEach((k) => k.classList.toggle('glow', !tut.done && tut.picked !== null && k.dataset.key === letter));
    $('tut-keys').hidden = tut.done;

    let text;
    if (tut.done) text = '<strong>You made it in 4 steps, which is par.</strong> Every puzzle has a par: the fewest steps it can be done in. Stuck? <strong>Hint</strong> fills in the next word.';
    else if (tut.picked === null && tut.step === 0) text = 'Change <strong>one letter at a time</strong>, and every step must be a real word. Tap the glowing <strong>L</strong>.';
    else if (tut.picked === null) text = `<strong>${up(cur)}</strong> is a word. Green letters already match <strong>WARM</strong>. Now tap the glowing <strong>${up(cur[pos])}</strong>.`;
    else text = `Now tap <strong>${up(letter)}</strong> to make <strong>${up(cur.slice(0, pos) + letter + cur.slice(pos + 1))}</strong>.`;
    $('tut-text').innerHTML = text;
  }

  $('tut-ladder').addEventListener('click', (e) => {
    const t = e.target.closest('.current .tile[data-i]');
    if (!t || !tut || tut.done) return;
    const [pos] = TUT.steps[tut.step];
    if (Number(t.dataset.i) !== pos) { t.classList.remove('nudge'); void t.offsetWidth; t.classList.add('nudge'); return; }
    tut.picked = pos;
    haptic(6);
    tutRender();
  });
  $('tut-keys').addEventListener('click', (e) => {
    const k = e.target.closest('.key');
    if (!k || !tut || tut.done) return;
    const [pos, letter] = TUT.steps[tut.step];
    if (tut.picked === null || k.dataset.key !== letter) { k.classList.remove('nudge'); void k.offsetWidth; k.classList.add('nudge'); return; }
    const cur = tut.ladder.at(-1);
    tut.ladder.push(cur.slice(0, pos) + letter + cur.slice(pos + 1));
    tut.picked = null;
    tut.step++;
    haptic(8);
    if (tut.step === TUT.steps.length) {
      tut.done = true;
      haptic([20, 60, 20]);
      $('tut-done').hidden = false;
      tutRender();
      $('tut-ladder').querySelectorAll('.rung-row').forEach((r, i) => { r.style.setProperty('--delay', `${i * RISE_STEP_MS}ms`); r.classList.add('rise'); });
      $('tut-done').focus({ preventScroll: true });
      return;
    }
    tutRender();
  });
  $('tut-open').addEventListener('click', () => { closeModal($('help-modal')); openTutorial(); });

  // ---------- Splash / start ----------
  $('splash-date').textContent = today.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  $('splash-number').textContent = `No. ${number}`;

  function startLevel(level) {
    $('splash').hidden = true;
    $('app').hidden = false;
    mountLevel(level);
    if (isDone(game.st)) { openResults(); return; }
    if (!flags().seenHelp) { setFlag('seenHelp', true); openTutorial(); }
  }
  document.querySelectorAll('.level-btn').forEach((b) => b.addEventListener('click', () => startLevel(b.dataset.level)));

  // Block Safari pinch-zoom on the game.
  ['gesturestart', 'gesturechange'].forEach((ev) => document.addEventListener(ev, (e) => e.preventDefault()));

  // ?play=hard skips the splash (handy for testing)
  if (params.has('play')) startLevel(LEVELS[params.get('play')] ? params.get('play') : 'easy');
  else requestAnimationFrame(() => setTimeout(renderTabs, 0)); // fill in level info after the splash paints
})();
