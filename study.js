/* Study mode for the 98% Library.
   Records participant codes, reading times, glossary taps, quiz answers, ratings and the timed reading tests,
   and sends them to a Google Sheet (see STUDY-SETUP.md). It does nothing unless config.js sets studyMode: true. */
window.LibraryStudy = function (api) {
  'use strict';
  const { $, esc, store, CFG } = api;
  const VERSION = '2.1';
  const PAUSE_MS = Math.max(10, +CFG.pauseSeconds || 60) * 1000;
  const POINTS = ['pre', 'mid', 'post'];
  const POINT_NAME = { pre: 'Pre-test', mid: 'Mid-test', post: 'Post-test' };
  const FORMS = (window.READING_TESTS && window.READING_TESTS.forms) || [];
  // Column order of the Google Sheet and the CSV download. Any other field goes into "details" as JSON.
  const COLUMNS = ['event_id', 'ts', 'pid', 'session_id', 'event', 'reading_id', 'story_id', 'level', 'genre', 'word_count', 'tokens', 'attempt',
    'test_point', 'test_form', 'q_index', 'choice', 'correct', 'rt_ms', 'page_ms', 'duration_ms', 'active_ms', 'hidden_ms', 'pauses', 'pause_ms',
    'longest_pause_ms', 'wpm', 'active_wpm', 'scroll_max', 'gloss_taps', 'gloss_words', 'score', 'n_questions', 'difficulty', 'enjoyment',
    'word', 'band', 'glossed', 'stage', 'reason', 'device', 'screen', 'tz', 'app_version', 'details'];

  const tnow = () => performance.now();
  const uid = () => (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
    : 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  const norm = c => String(c || '').trim().toUpperCase().replace(/\s+/g, '');
  const codes = (CFG.validCodes || []).map(norm).filter(Boolean);
  const codeOk = c => !!norm(c) && (!codes.length || codes.includes(norm(c)));
  const el = html => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  const rate = (words, ms) => ms > 0 ? Math.round(10 * words / (ms / 60000)) / 10 : null;
  const pct = x => Math.round(100 * x);
  const fmtDur = ms => { const s = Math.round(ms / 1000), m = Math.floor(s / 60); return m ? `${m} min ${s % 60} s` : `${s} s`; };
  const mmss = ms => { const s = Math.floor(ms / 1000); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };

  const sessionId = uid();
  let pid = store.get('pid', null);
  if (pid && !codeOk(pid)) pid = null;

  /* ---------- Logger: an outbox in localStorage, sent in batches; nothing is lost while offline ---------- */
  let outbox = CFG.logUrl ? store.get('outbox', []) : [];
  const saveOutbox = () => store.set('outbox', outbox);
  const payload = events => JSON.stringify({ key: CFG.logKey || '', events });
  function log(event, fields) {
    const ev = Object.assign({ event_id: uid(), ts: new Date().toISOString(), pid, session_id: sessionId, event }, fields, { app_version: VERSION });
    if (CFG.logUrl) { outbox.push(ev); saveOutbox(); scheduleFlush(); }
    if (pid) { const mine = store.get('log:' + pid, []); mine.push(ev); store.set('log:' + pid, mine); }
    updateBadge();
    return ev;
  }
  let sending = false, flushTimer = 0, lastError = '';
  // Events leave the outbox only when the sheet replies {ok: true}. If this browser cannot read the reply at all
  // (no CORS), it falls back to sending blind, where a completed request counts as delivered.
  let replyReadable = null, unreadable = 0;
  function scheduleFlush(ms = 1500) { if (!CFG.logUrl) return; clearTimeout(flushTimer); flushTimer = setTimeout(flush, ms); }
  async function send(batch) {
    // text/plain keeps this a "simple" request, so Google Apps Script accepts it without a CORS preflight.
    const opts = { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: payload(batch) };
    if (replyReadable !== false) {
      try {
        const res = await fetch(CFG.logUrl, opts);
        replyReadable = true;
        const j = await res.json().catch(() => null);
        if (j && j.ok) { lastError = ''; return true; }
        lastError = (j && j.error) || `the sheet replied with status ${res.status}`;
        return false;
      } catch (e) {
        if (navigator.onLine === false) { lastError = 'offline'; return false; }
        if (replyReadable !== null || ++unreadable < 2) { lastError = 'could not reach the sheet'; return false; }
        replyReadable = false; // two unreadable replies and never a readable one: send blind from now on
      }
    }
    try { await fetch(CFG.logUrl, Object.assign(opts, { mode: 'no-cors' })); lastError = ''; return true; }
    catch (e) { lastError = 'could not reach the sheet'; return false; }
  }
  async function flush() {
    if (sending || !outbox.length) return;
    sending = true;
    const batch = outbox.slice(0, 40);
    const ok = await send(batch);
    if (ok) { const sent = new Set(batch.map(e => e.event_id)); outbox = outbox.filter(e => !sent.has(e.event_id)); saveOutbox(); }
    sending = false; updateBadge();
    if (outbox.length) scheduleFlush(ok ? 200 : 20000);
  }
  // On leaving the page a beacon carries what is still waiting. The sheet ignores an event_id it has already stored.
  function beacon() {
    if (!CFG.logUrl || !outbox.length || !navigator.sendBeacon) return;
    try { navigator.sendBeacon(CFG.logUrl, new Blob([payload(outbox.slice(0, 40))], { type: 'text/plain;charset=utf-8' })); } catch (e) { /* ignore */ }
  }
  window.addEventListener('online', () => scheduleFlush(200));
  setInterval(() => { if (outbox.length && !sending) flush(); }, 30000);

  /* ---------- Clocks: reading time, time with the page hidden, and pauses with no activity ---------- */
  const clocks = new Set();
  let lastAct = tnow();
  const noteGap = t => { const gap = t - lastAct; if (gap >= PAUSE_MS) clocks.forEach(c => c.gap(gap, t)); };
  const activity = () => { if (document.hidden) return; const t = tnow(); noteGap(t); lastAct = t; };
  ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll'].forEach(n => window.addEventListener(n, activity, { passive: true, capture: true }));
  document.addEventListener('visibilitychange', () => {
    const t = tnow();
    if (document.hidden) { noteGap(t); clocks.forEach(c => c.hide(t)); beacon(); }
    else { lastAct = t; clocks.forEach(c => c.show(t)); scheduleFlush(500); }
  });
  function Clock() {
    const t0 = tnow();
    let hiddenMs = 0, hiddenAt = document.hidden ? t0 : null, pauses = 0, pauseMs = 0, longest = 0, end = null;
    const c = {
      gap(g, t) { const len = Math.min(g, t - t0); if (len < PAUSE_MS) return; pauses++; pauseMs += len; longest = Math.max(longest, len); },
      hide(t) { if (hiddenAt === null) hiddenAt = t; },
      show(t) { if (hiddenAt !== null) { hiddenMs += t - hiddenAt; hiddenAt = null; } },
      elapsed() { return (end === null ? tnow() : end) - t0; },
      read() {
        const d = c.elapsed(), h = hiddenMs + (hiddenAt !== null ? (end === null ? tnow() : end) - hiddenAt : 0);
        return { duration_ms: Math.round(d), active_ms: Math.round(d - h), hidden_ms: Math.round(h), pauses, pause_ms: Math.round(pauseMs), longest_pause_ms: Math.round(longest) };
      },
      stop() { const t = tnow(); c.show(t); end = t; clocks.delete(c); return c.read(); },
      cancel() { clocks.delete(c); }
    };
    clocks.add(c);
    return c;
  }
  const chip = el('<div class="s-timer" aria-hidden="true" hidden></div>');
  document.body.append(chip);
  let chipClock = null, chipTick = 0;
  const tick = () => { if (chipClock) chip.textContent = mmss(chipClock.elapsed()); };
  function showChip(clock) { if (!CFG.showTimer) return; chipClock = clock; chip.hidden = false; tick(); clearInterval(chipTick); chipTick = setInterval(tick, 1000); }
  function hideChip() { chipClock = null; chip.hidden = true; clearInterval(chipTick); }

  /* ---------- Page furniture: sign-in, badge, banner, test card ---------- */
  document.body.classList.add('study-mode');
  const main = $('main');
  if (!CFG.logUrl) main.prepend(el('<p class="s-banner" role="status">Study mode is on, but config.js has no logUrl, so records are kept only in this browser. See STUDY-SETUP.md.</p>'));
  const testOpen = POINTS.includes(CFG.currentTestPoint) && FORMS.length > 0;
  if (testOpen) $('.tabs').append(el('<a href="#test" data-tab="test">Reading test</a>'));

  const overlay = el(`<div class="s-overlay" id="s-signin" role="dialog" aria-modal="true" aria-labelledby="s-signin-h" hidden>
    <form class="s-dialog" novalidate>
      <span class="eyebrow">The 98% Library · reading study</span>
      <h2 id="s-signin-h">Enter your participant code</h2>
      <p>Your teacher gave you a code. While you use the library, it records which stories you open, your reading time, the words you tap, your answers and your ratings. It does not record your name.</p>
      <label for="s-code">Participant code</label>
      <input id="s-code" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="24">
      <p class="s-err" id="s-code-err" role="alert"></p>
      <button class="btn primary big" type="submit">Start</button>
    </form></div>`);
  document.body.append(overlay);
  overlay.querySelector('form').addEventListener('submit', e => {
    e.preventDefault();
    const code = norm($('#s-code').value);
    const err = $('#s-code-err');
    if (!code) { err.textContent = 'Please type your code.'; return; }
    if (!codeOk(code)) { err.textContent = 'That code is not on the list. Check it with your teacher.'; return; }
    err.textContent = '';
    signIn(code);
  });
  function deviceFields(reason) {
    let tz = ''; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { /* ignore */ }
    return { reason, device: navigator.userAgent, screen: `${screen.width}x${screen.height} viewport ${innerWidth}x${innerHeight} dpr ${devicePixelRatio || 1}`, tz };
  }
  function signIn(code) {
    pid = code; store.set('pid', pid);
    overlay.hidden = true; document.body.classList.remove('s-locked');
    log('session_start', deviceFields('sign_in'));
    refresh(); api.reroute();
  }
  function signOut() {
    if (busy() && !confirm('You are in the middle of a reading. Sign out anyway?')) return;
    leaving(null, 'sign_out');
    log('sign_out', {});
    flush();
    pid = null; store.set('pid', null);
    closeMenu(); refresh();
    location.hash = 'library';
    lockForSignIn();
  }
  function lockForSignIn() {
    overlay.hidden = false; document.body.classList.add('s-locked');
    $('#s-code').value = ''; setTimeout(() => $('#s-code').focus(), 50);
  }

  const badge = el(`<div class="s-badge"><button class="s-who" type="button" aria-expanded="false" aria-controls="s-menu"></button><div class="s-menu" id="s-menu" hidden></div></div>`);
  $('.masthead .wrap').append(badge);
  const who = badge.querySelector('.s-who'), menu = badge.querySelector('.s-menu');
  const doneMap = () => pid ? store.get('done:' + pid, {}) : {};
  const testsDone = () => pid ? store.get('tests:' + pid, {}) : {};
  function stats() {
    const d = doneMap(); let stories = 0, words = 0;
    for (const id in d) { const p = api.prepared.get(id); stories++; if (p) words += p.s.word_count * d[id].n; }
    return { stories, words };
  }
  function syncLine() {
    if (!CFG.logUrl) return 'Records are kept in this browser only.';
    if (!outbox.length) return 'All records sent.';
    const n = `${outbox.length} record${outbox.length === 1 ? '' : 's'} waiting to send.`;
    if (navigator.onLine === false) return n + ' They will be sent when you are back online.';
    return lastError && lastError !== 'offline' ? `${n} Last try: ${lastError}. Trying again.` : n;
  }
  function updateBadge() {
    badge.hidden = !pid;
    if (!pid) return;
    const st = stats();
    who.innerHTML = `<span class="s-dot${outbox.length ? ' wait' : ''}" aria-hidden="true"></span>${esc(pid)} <span class="num">· ${st.stories} read</span>`;
    who.setAttribute('aria-label', `Participant ${pid}, ${st.stories} stories read. Open menu`);
    if (!menu.hidden) renderMenu();
  }
  function renderMenu() {
    const st = stats();
    menu.innerHTML = `<p><b>Participant ${esc(pid)}</b></p>
      <p>${st.stories} ${st.stories === 1 ? 'story' : 'stories'} read · <span class="num">${st.words.toLocaleString('en')}</span> words</p>
      <p class="hint">${esc(syncLine())}</p>
      <div class="row"><button class="btn" type="button" data-act="csv">Download my data</button><button class="btn" type="button" data-act="out">Sign out</button></div>`;
  }
  function closeMenu() { menu.hidden = true; who.setAttribute('aria-expanded', 'false'); }
  who.addEventListener('click', e => { e.stopPropagation(); if (menu.hidden) { renderMenu(); menu.hidden = false; who.setAttribute('aria-expanded', 'true'); } else closeMenu(); });
  menu.addEventListener('click', e => {
    e.stopPropagation();
    const b = e.target.closest('[data-act]'); if (!b) return;
    if (b.dataset.act === 'csv') downloadCsv();
    if (b.dataset.act === 'out') signOut();
  });
  document.addEventListener('click', () => { if (!menu.hidden) closeMenu(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !menu.hidden) closeMenu(); });

  function downloadCsv() {
    const rows = store.get('log:' + pid, []);
    const cell = v => {
      if (v === undefined || v === null || v === '') return '';
      const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const extra = r => { const o = {}; for (const k in r) if (!COLUMNS.includes(k)) o[k] = r[k]; return Object.keys(o).length ? o : ''; };
    const lines = [COLUMNS.join(',')].concat(rows.map(r => COLUMNS.map(c => cell(c === 'details' ? extra(r) : r[c])).join(',')));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    a.download = `98-library-${pid}.csv`;
    document.body.append(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  const home = el('<div class="s-home" id="s-home" hidden></div>');
  $('#view-library .intro').after(home);
  function renderHome() {
    let h = '';
    if (pid && testOpen) {
      const point = CFG.currentTestPoint, rec = testsDone()[point];
      h = rec && rec.done
        ? `<p class="s-note">✓ ${POINT_NAME[point]} finished. Thank you.</p>`
        : `<div class="s-test-card"><div><span class="eyebrow">Reading test · ${POINT_NAME[point]}</span><h2>Please do the reading test first</h2><p>One short text and 8 questions. It takes about 10 minutes.</p></div><a class="btn primary big" href="#test">Go to the test</a></div>`;
    }
    home.innerHTML = h; home.hidden = !h;
  }
  function refresh() { updateBadge(); renderHome(); api.refreshLibrary(); }
  const cardMark = id => { const d = doneMap()[id]; return d ? `<span class="readmark">✓ Read${d.n > 1 ? ' ×' + d.n : ''}</span>` : ''; };

  /* ---------- Reading a story: Start → read → I've finished → questions → ratings ---------- */
  const storyEl = $('#r-story'), wcEl = $('#r-wc'), illEl = $('#r-ill');
  const startBox = el('<div class="s-start" id="s-start" hidden></div>');
  const flowBox = el('<div class="s-flow" id="s-flow" hidden></div>');
  storyEl.before(startBox); wcEl.after(flowBox);
  let R = null;
  const storyFields = p => ({ story_id: p.s.id, level: p.s.level, genre: p.s.genre, word_count: p.s.word_count, tokens: p.r6.total });
  const base = () => Object.assign({ reading_id: R.id, attempt: R.attempt }, storyFields(R.p));
  const depth = node => { const r = node.getBoundingClientRect(); return r.height ? Math.max(0, Math.min(1, (innerHeight - r.top) / r.height)) : 0; };
  const scrollToEl = node => window.scrollTo({ top: Math.max(0, node.getBoundingClientRect().top + scrollY - 96) });

  function openStory(p) {
    if (R && R.clock) R.clock.cancel();
    R = null; hideChip();
    flowBox.hidden = true; flowBox.innerHTML = '';
    if (!pid) { storyEl.hidden = true; wcEl.hidden = true; startBox.hidden = true; return; }
    const prev = doneMap()[p.s.id];
    R = { p, id: uid(), stage: 'opened', tOpen: tnow(), attempt: (prev ? prev.n : 0) + 1, taps: 0, words: new Map(), scrollMax: 0, answers: [] };
    storyEl.hidden = true; wcEl.hidden = true;
    startBox.hidden = false;
    const n = p.s.quiz.length;
    startBox.innerHTML = `<div class="s-card">
      <span class="eyebrow">Before you read</span>
      <h2>Read at your normal speed</h2>
      <ul>
        <li>This story has <b class="num">${p.s.word_count.toLocaleString('en')}</b> words.</li>
        ${p.s.gloss.length ? '<li>Words with a dotted line are explained: tap one to see what it means.</li>' : ''}
        <li>When you reach the end, press <b>I’ve finished reading</b>. Then answer ${n} questions${CFG.hideTextDuringQuiz ? ' without looking back at the story' : ''}, and tell us what you thought of it.</li>
      </ul>
      ${prev ? `<p class="hint">You have read this story before. Reading it again is fine.</p>` : ''}
      <div class="row"><button class="btn primary big" type="button" data-act="start">Start reading</button><span class="hint">Your reading time is recorded for the study.</span></div>
    </div>`;
    log('story_open', base());
  }
  startBox.addEventListener('click', e => { if (e.target.closest('[data-act="start"]') && R && R.stage === 'opened') startReading(); });

  function startReading() {
    R.stage = 'reading'; R.clock = Clock(); R.tStart = tnow();
    startBox.hidden = true; storyEl.hidden = false; wcEl.hidden = false; flowBox.hidden = false;
    flowBox.innerHTML = `<div class="s-finish"><p>Have you reached the end of the story?</p><button class="btn primary big" type="button" data-act="finish">I’ve finished reading</button></div>`;
    log('reading_start', base());
    showChip(R.clock);
    scrollToEl(storyEl);
    R.scrollMax = depth(storyEl);
  }
  window.addEventListener('scroll', () => {
    if (R && R.stage === 'reading') R.scrollMax = Math.max(R.scrollMax, depth(storyEl));
    if (T && T.stage === 'reading') { const t = $('#t-text'); if (t) T.scrollMax = Math.max(T.scrollMax, depth(t)); }
  }, { passive: true });

  function finishReading() {
    R.scrollMax = Math.max(R.scrollMax, depth(storyEl));
    R.t = R.clock.stop(); hideChip();
    R.rate = { wpm: rate(R.p.s.word_count, R.t.duration_ms), active_wpm: rate(R.p.s.word_count, R.t.active_ms) };
    R.stage = 'quiz';
    log('reading_finish', Object.assign(base(), R.t, R.rate, { scroll_max: pct(R.scrollMax), gloss_taps: R.taps, gloss_words: R.words.size }));
    if (CFG.hideTextDuringQuiz) { storyEl.hidden = true; wcEl.hidden = true; illEl.hidden = true; }
    const qs = R.p.s.quiz.map((q, qi) => `<fieldset data-q="${qi}"><legend>${qi + 1}. ${esc(q.q)}</legend>
      ${q.options.map((o, oi) => `<button type="button" class="opt" data-o="${oi}"><span class="mark" aria-hidden="true"></span><span>${esc(o)}</span></button>`).join('')}
      <p class="feedback" aria-live="polite"></p></fieldset>`).join('');
    flowBox.innerHTML = `<section class="s-quiz"><h2 tabindex="-1">Check your understanding</h2>
      <p class="hint">${CFG.hideTextDuringQuiz ? 'Answer from memory. ' : ''}Choose one answer for each question. You cannot change an answer once you choose it.</p>
      <div class="quiz">${qs}</div></section>
      <section class="s-rate" hidden>${ratingHtml()}</section>`;
    R.quizT0 = tnow();
    scrollToEl(flowBox);
    flowBox.querySelector('h2').focus({ preventScroll: true });
  }
  const SCALES = {
    difficulty: ['How difficult was this story?', ['Very easy', 'Easy', 'OK', 'Difficult', 'Very difficult']],
    enjoyment: ['How much did you enjoy it?', ['Not at all', 'A little', 'OK', 'Quite a lot', 'Very much']]
  };
  function ratingHtml() {
    return `<h2>What did you think?</h2>` + Object.entries(SCALES).map(([k, [q, labels]]) => `<div class="s-scale" data-scale="${k}" role="group" aria-label="${esc(q)}">
      <p class="lbl">${esc(q)}</p><div class="s-five">${labels.map((l, i) => `<button type="button" data-v="${i + 1}" aria-pressed="false"><b class="num">${i + 1}</b><span>${esc(l)}</span></button>`).join('')}</div></div>`).join('') +
      `<div class="row"><button class="btn primary big" type="button" data-act="submit" disabled>Submit</button><span class="hint" id="s-rate-hint">Choose one number for each question.</span></div>`;
  }
  flowBox.addEventListener('click', e => {
    if (!R) return;
    const act = e.target.closest('[data-act]');
    if (act && act.dataset.act === 'finish' && R.stage === 'reading') return finishReading();
    if (act && act.dataset.act === 'submit' && R.stage === 'rating') return submitReading();
    if (act && act.dataset.act === 'reshow') { storyEl.hidden = false; wcEl.hidden = false; illEl.hidden = !R.p.s.svg; act.remove(); return; }
    const opt = e.target.closest('.opt');
    if (opt && R.stage === 'quiz') return answer(opt);
    const v = e.target.closest('.s-five button');
    if (v && R.stage === 'rating') {
      const sc = v.closest('[data-scale]');
      sc.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b === v));
      R[sc.dataset.scale] = +v.dataset.v;
      const ready = R.difficulty && R.enjoyment;
      flowBox.querySelector('[data-act="submit"]').disabled = !ready;
      $('#s-rate-hint').textContent = ready ? '' : 'Choose one number for each question.';
    }
  });
  function answer(btn) {
    const fs = btn.closest('fieldset'); if (fs.dataset.done) return;
    const qi = +fs.dataset.q, o = +btn.dataset.o, q = R.p.s.quiz[qi], ok = o === q.answer;
    fs.dataset.done = '1';
    fs.querySelectorAll('.opt').forEach((x, i) => {
      x.disabled = true;
      if (CFG.showReadingFeedback) {
        if (i === q.answer) { x.classList.add('right'); x.querySelector('.mark').textContent = '✓'; }
        else if (i === o) { x.classList.add('wrong'); x.querySelector('.mark').textContent = '✕'; }
      } else if (i === o) { x.classList.add('chosen'); x.querySelector('.mark').textContent = '●'; }
    });
    if (CFG.showReadingFeedback) fs.querySelector('.feedback').textContent = ok ? 'Correct.' : `Not quite. The answer is: ${q.options[q.answer]}`;
    const rt = tnow() - R.quizT0;
    R.answers[qi] = { o, ok, rt };
    log('quiz_answer', Object.assign(base(), { q_index: qi + 1, choice: o + 1, correct: ok ? 1 : 0, rt_ms: Math.round(rt) }));
    if (R.answers.filter(Boolean).length === R.p.s.quiz.length) {
      R.stage = 'rating';
      const rs = flowBox.querySelector('.s-rate'); rs.hidden = false;
      setTimeout(() => rs.scrollIntoView({ behavior: 'smooth', block: 'start' }), CFG.showReadingFeedback ? 700 : 150);
    }
  }
  function submitReading() {
    R.stage = 'done';
    const n = R.p.s.quiz.length, score = R.answers.filter(a => a && a.ok).length;
    log('reading_complete', Object.assign(base(), R.t, R.rate, {
      page_ms: Math.round(tnow() - R.tOpen), scroll_max: pct(R.scrollMax), gloss_taps: R.taps, gloss_words: R.words.size,
      score, n_questions: n, difficulty: R.difficulty, enjoyment: R.enjoyment,
      quiz_ms: Math.round(Math.max(...R.answers.map(a => a.rt))), answers: R.answers.map(a => a.o + 1).join(''),
      looked_up: [...R.words.keys()].join(' ')
    }));
    const d = doneMap(), prev = d[R.p.s.id];
    d[R.p.s.id] = { n: (prev ? prev.n : 0) + 1, ts: Date.now(), wpm: R.rate.wpm, score };
    store.set('done:' + pid, d);
    scheduleFlush(100);
    refresh();
    const fb = CFG.showReadingFeedback
      ? `<p>You read <b class="num">${R.p.s.word_count.toLocaleString('en')}</b> words in <b>${fmtDur(R.t.duration_ms)}</b>, about <b class="num">${Math.round(R.rate.wpm)}</b> words a minute. You answered <b class="num">${score} of ${n}</b> questions correctly.</p>`
      : '<p>Your answers have been saved.</p>';
    flowBox.innerHTML = `<div class="s-done"><span class="eyebrow">Saved</span><h2 tabindex="-1">Well done!</h2>${fb}
      <div class="row"><a class="btn primary big" href="#library">Choose another story</a>${CFG.hideTextDuringQuiz ? '<button class="btn" type="button" data-act="reshow">Show the story again</button>' : ''}</div></div>`;
    scrollToEl(flowBox);
    flowBox.querySelector('h2').focus({ preventScroll: true });
  }
  function glossTap(tok, g) {
    if (!R || R.stage !== 'reading') return;
    const key = tok.head || tok.w;
    R.taps++; R.words.set(key, (R.words.get(key) || 0) + 1);
    log('gloss_tap', Object.assign(base(), {
      word: tok.w, head: tok.head || '', band: typeof tok.band === 'number' ? 'K' + tok.band : tok.band, glossed: g ? 1 : 0,
      rt_ms: Math.round(tnow() - R.tStart), tap_n: R.words.get(key)
    }));
  }

  /* ---------- Timed reading test: plain text, no glosses, 8 questions without the text ---------- */
  const testSec = el('<section data-view="test" id="view-test" hidden></section>');
  main.append(testSec);
  let T = null;
  const hash = s => { let h = 0; for (const ch of s) h = (h * 31 + ch.codePointAt(0)) >>> 0; return h; };
  // Each code meets the three forms in a different order across pre, mid and post, so every form is used at every test point.
  const formFor = (code, point) => FORMS[(hash(norm(code)) + POINTS.indexOf(point)) % FORMS.length];
  const tf = () => ({ reading_id: T.id, test_point: T.point, test_form: T.form.id, word_count: T.form.words, tokens: T.form.tokens, attempt: T.attempt });
  const message = (h, p) => `<div class="intro"><span class="eyebrow">Reading test</span><h1>${h}</h1><p>${p}</p></div><p><a class="btn" href="#library">Back to the library</a></p>`;

  function openTest() {
    document.title = 'Reading test · The 98% Library';
    if (!pid) { testSec.innerHTML = ''; return; }
    if (T && T.stage !== 'done' && T.stage !== 'intro') return;
    if (!testOpen) { testSec.innerHTML = message('There is no reading test open now', 'Your teacher will tell you when it is time for the next test.'); return; }
    const point = CFG.currentTestPoint, rec = testsDone()[point] || {};
    if (rec.done) { testSec.innerHTML = message(`You have finished the ${POINT_NAME[point].toLowerCase()}`, 'Thank you. Your answers were saved.'); return; }
    T = { point, form: formFor(pid, point), stage: 'intro', attempt: (rec.starts || 0) + 1, id: uid(), scrollMax: 0 };
    testSec.innerHTML = `<div class="intro"><span class="eyebrow">Reading test · ${POINT_NAME[point]}</span><h1>Timed reading test</h1></div>
      <div class="s-card s-instr">
        <ul>
          <li>You will read one short text (about <span class="num">${Math.round(T.form.words / 10) * 10}</span> words) and then answer ${T.form.questions.length} questions.</li>
          <li>Read at your normal speed, the way you usually read to understand. Do not rush, and do not skim. Read the text once.</li>
          <li>The clock starts when you press <b>Start</b> and stops when you press <b>I’ve finished reading</b>.</li>
          <li>You will not see the text while you answer. There is no glossary in this test. Please do not use a dictionary.</li>
        </ul>
        ${rec.starts ? '<p class="s-warnline">You started this test before. Only start again if your teacher tells you to.</p>' : ''}
        <div class="row"><button class="btn primary big" type="button" data-act="t-start">Start</button></div>
      </div>`;
  }
  function startTest() {
    const all = testsDone(), rec = all[T.point] || {};
    rec.starts = (rec.starts || 0) + 1; all[T.point] = rec; store.set('tests:' + pid, all);
    T.stage = 'reading'; T.clock = Clock();
    log('test_start', tf());
    testSec.innerHTML = `<div class="s-test-read"><span class="eyebrow">Reading test · ${POINT_NAME[T.point]}</span><h1>${esc(T.form.title)}</h1>
      <article class="story" id="t-text">${T.form.paragraphs.map(p => `<p>${esc(api.smart(p))}</p>`).join('')}</article>
      <div class="s-finish"><p>Have you reached the end of the text?</p><button class="btn primary big" type="button" data-act="t-finish">I’ve finished reading</button></div></div>`;
    showChip(T.clock);
    window.scrollTo(0, 0);
    T.scrollMax = depth($('#t-text'));
  }
  function finishTest() {
    T.scrollMax = Math.max(T.scrollMax, depth($('#t-text')));
    T.t = T.clock.stop(); hideChip();
    T.rate = { wpm: rate(T.form.words, T.t.duration_ms), active_wpm: rate(T.form.words, T.t.active_ms) };
    T.stage = 'questions';
    log('test_finish', Object.assign(tf(), T.t, T.rate, { scroll_max: pct(T.scrollMax) }));
    T.ans = T.form.questions.map(() => null); T.qT0 = tnow();
    testSec.innerHTML = `<div class="s-test-q"><span class="eyebrow">Reading test · ${POINT_NAME[T.point]}</span><h1 tabindex="-1">Questions</h1>
      <p class="hint">Choose the best answer for each question. You can change an answer until you press Submit.</p>
      <div class="quiz">${T.form.questions.map((q, qi) => `<fieldset data-q="${qi}"><legend>${qi + 1}. ${esc(q.q)}</legend>
        ${q.options.map((o, oi) => `<button type="button" class="opt" data-o="${oi}" aria-pressed="false"><span class="mark" aria-hidden="true"></span><span>${esc(o)}</span></button>`).join('')}</fieldset>`).join('')}</div>
      <div class="row"><button class="btn primary big" type="button" data-act="t-submit" disabled>Submit answers</button><span class="hint" id="t-left"></span></div></div>`;
    updateLeft();
    window.scrollTo(0, 0);
    testSec.querySelector('h1').focus({ preventScroll: true });
  }
  function updateLeft() {
    const left = T.ans.filter(a => !a).length;
    testSec.querySelector('[data-act="t-submit"]').disabled = left > 0;
    $('#t-left').textContent = left ? `${left} question${left === 1 ? '' : 's'} left` : '';
  }
  function submitTest() {
    const qs = T.form.questions;
    let score = 0;
    qs.forEach((q, qi) => {
      const a = T.ans[qi], ok = a.o === q.answer; if (ok) score++;
      log('test_answer', Object.assign(tf(), { q_index: qi + 1, choice: a.o + 1, correct: ok ? 1 : 0, rt_ms: Math.round(a.rt), changes: a.changes }));
    });
    const qms = tnow() - T.qT0;
    log('test_complete', Object.assign(tf(), T.t, T.rate, { scroll_max: pct(T.scrollMax), score, n_questions: qs.length, questions_ms: Math.round(qms), answers: T.ans.map(a => a.o + 1).join('') }));
    const all = testsDone(); all[T.point] = Object.assign(all[T.point] || {}, { done: true, form: T.form.id, ts: Date.now(), wpm: T.rate.wpm, score });
    store.set('tests:' + pid, all);
    T.stage = 'done';
    scheduleFlush(100); refresh();
    const res = CFG.showTestResults ? `<p>You read about <b class="num">${Math.round(T.rate.wpm)}</b> words a minute and answered <b class="num">${score} of ${qs.length}</b> questions correctly.</p>` : '';
    testSec.innerHTML = `<div class="intro"><span class="eyebrow">Reading test · ${POINT_NAME[T.point]}</span><h1 tabindex="-1">Thank you</h1><p>Your answers have been saved.</p>${res}</div>
      <p><a class="btn primary big" href="#library">Go to the library</a></p>`;
    window.scrollTo(0, 0);
  }
  testSec.addEventListener('click', e => {
    if (!T) return;
    const act = e.target.closest('[data-act]');
    if (act && act.dataset.act === 't-start' && T.stage === 'intro') return startTest();
    if (act && act.dataset.act === 't-finish' && T.stage === 'reading') return finishTest();
    if (act && act.dataset.act === 't-submit' && T.stage === 'questions') return submitTest();
    const opt = e.target.closest('.opt');
    if (opt && T.stage === 'questions') {
      const fs = opt.closest('fieldset'), qi = +fs.dataset.q, o = +opt.dataset.o, prev = T.ans[qi];
      fs.querySelectorAll('.opt').forEach(x => { const on = x === opt; x.setAttribute('aria-pressed', on); x.classList.toggle('chosen', on); x.querySelector('.mark').textContent = on ? '●' : ''; });
      T.ans[qi] = { o, rt: tnow() - T.qT0, changes: prev ? prev.changes + (prev.o === o ? 0 : 1) : 0 };
      updateLeft();
    }
  });

  /* ---------- Leaving part-way: logged so unfinished readings can be told apart from finished ones ---------- */
  const busy = () => (R && ['reading', 'quiz', 'rating'].includes(R.stage)) || (T && ['reading', 'questions'].includes(T.stage));
  function leaving(h, reason = 'navigate') {
    if (R && (h === null || h !== R.p.s.id)) {
      if (R.stage !== 'done') {
        const f = Object.assign(base(), { stage: R.stage, reason, page_ms: Math.round(tnow() - R.tOpen), gloss_taps: R.taps, gloss_words: R.words.size, n_answered: R.answers.filter(Boolean).length });
        if (R.stage === 'reading') Object.assign(f, R.clock.read()); else if (R.t) Object.assign(f, R.t);
        log('story_leave', f);
      }
      if (reason !== 'pagehide') { if (R.clock) R.clock.cancel(); R = null; hideChip(); }
    }
    if (T && (h === null || h !== 'test')) {
      if (T.stage === 'reading' || T.stage === 'questions') log('test_leave', Object.assign(tf(), T.stage === 'reading' ? T.clock.read() : T.t, { stage: T.stage, reason }));
      if (reason !== 'pagehide') { if (T.clock) T.clock.cancel(); T = null; hideChip(); }
    }
  }
  // Ask before a link takes a student out of a reading or test they have started.
  document.addEventListener('click', e => {
    const a = e.target.closest('a[href^="#"]');
    if (!a || !busy() || a.getAttribute('href') === location.hash) return;
    if (!confirm('Leave now? This reading is not finished, and you would need to start it again.')) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  window.addEventListener('pagehide', () => { if (busy() || (R && R.stage === 'opened')) leaving(null, 'pagehide'); beacon(); });
  window.addEventListener('pageshow', e => { if (e.persisted && pid) log('page_return', {}); });

  /* ---------- Start ---------- */
  if (pid) { log('session_start', deviceFields('resume')); scheduleFlush(800); }
  else lockForSignIn();
  updateBadge(); renderHome();

  return { openStory, glossTap, leaving, openTest, cardMark, views: ['library', 'genres', 'test'] };
};
