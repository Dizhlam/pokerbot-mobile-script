// PokerBot add-on core 2026.10.20.2255
(function () {
'use strict';
const VERSION = "2026.10.20.2255";
const HOME = "https://dizhlam.github.io/pokerbot-mobile-script/";
const READER = (
// Reads the Kobra Poker table state from the DOM / React props.
// Evaluated in the page; returns a plain JSON object (or null if no table is open).
() => {
  const fiberKey = (el) => Object.keys(el).find((k) => k.startsWith('__reactFiber'));

  // Card values ("hQ", "dT", ...) live in React props of the card component.
  const cardValue = (el) => {
    const fk = fiberKey(el);
    let f = fk && el[fk];
    for (let i = 0; i < 4 && f; i++) {
      const v = f.memoizedProps && f.memoizedProps.value;
      if (typeof v === 'string' && /^[shdc][2-9TJQKA]$/.test(v)) return v;
      f = f.return;
    }
    return null;
  };

  // "5K" -> 5000, "1.2M" -> 1200000, "45,000" -> 45000
  const num = (txt) => {
    if (!txt) return 0;
    const m = String(txt).replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*([KkMm])?/);
    if (!m) return 0;
    let n = parseFloat(m[1]);
    if (m[2]) n *= /k/i.test(m[2]) ? 1e3 : 1e6;
    return Math.round(n);
  };

  const table = document.querySelector('.r-game-area');
  if (!table) return null;

  const center = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };

  const stakesTxt = (document.querySelector('.table-name') || {}).innerText || '';
  const sm = stakesTxt.replace(/,/g, '').match(/Stakes:\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
  const sb = sm ? parseFloat(sm[1]) : 0;
  const bb = sm ? parseFloat(sm[2]) : 0;

  const potTxt = (document.querySelector('.bank-container-content') || {}).innerText || '';
  const pot = num(potTxt.replace(/Pot:/i, ''));

  const board = [...document.querySelectorAll('.r-table-cards .r-card')].map(cardValue).filter(Boolean);

  // Seats
  const seatEls = [...document.querySelectorAll('.r-seats .r-seat')];
  const dealerEl = document.querySelector('.r-dealer-layer .dealer-button');
  const dealerC = dealerEl && dealerEl.getBoundingClientRect().width ? center(dealerEl) : null;

  const players = [];
  let dealerSeat = null, bestD = Infinity;
  for (const s of seatEls) {
    const p = s.querySelector('.r-player');
    if (!p) continue;
    const sm2 = s.className.match(/\bs-(\d+)\b/);
    const seat = sm2 ? +sm2[1] : -1;
    const name = (s.querySelector('.player-name') || {}).innerText || '';
    const stack = num((s.querySelector('.player-cash') || {}).innerText);
    const betEl = document.querySelector(`.r-player-bet.s-${seat} .value`);
    const bet = betEl ? num(betEl.innerText) : 0;
    const cardEls = [...s.querySelectorAll('.r-player-cards .r-card')];
    const hero = s.classList.contains('client-seat');
    const cards = hero ? cardEls.map(cardValue).filter(Boolean) : [];
    const inHand = cardEls.length > 0;
    const actionEl = s.querySelector('.player-action');
    // action badge, e.g. <div class="player-action pa-raise">Raise</div> (text, or the pa-* class)
    const lastAction = actionEl
      ? (actionEl.innerText.trim() || ((actionEl.className.match(/\bpa-([a-z-]+)/) || [])[1] || '')) : '';
    const sittingOut = p.classList.contains('player-obscured') && !inHand;
    const c = center(s.querySelector('.r-player-avatar') || s);
    if (dealerC) {
      const d = Math.hypot(c.x - dealerC.x, c.y - dealerC.y);
      if (d < bestD) { bestD = d; dealerSeat = seat; }
    }
    players.push({ seat, name, stack, bet, inHand, hero, cards, lastAction, sittingOut,
                   acting: p.classList.contains('active'), x: Math.round(c.x), y: Math.round(c.y) });
  }

  // Hero cards fallback: table indicator classes ("dJ", "sJ")
  const heroP = players.find((p) => p.hero);
  if (heroP && heroP.cards.length < 2) {
    const ind = [...document.querySelectorAll('.TableIndicator.active .TableIndicator__card')]
      .map((e) => (e.className.match(/\b([shdc][2-9TJQKA])\b/) || [])[1]).filter(Boolean);
    if (ind.length === 2) heroP.cards = ind;
  }

  // Available actions (only present when it's our turn)
  const actions = [];
  for (const it of document.querySelectorAll('.PlayerActionsContainer__actions_grid .GridComponent__item')) {
    const btn = it.querySelector('.SimpleButton');
    if (!btn || btn.classList.contains('disable') || btn.classList.contains('SimpleButton_disabled')) continue;
    const kindM = it.className.match(/\bpa-([a-z_-]+)/);
    const text = it.innerText.replace(/\s+/g, ' ').trim();
    let kind = kindM ? kindM[1] : text.toLowerCase();
    if (/all.?in/i.test(text)) kind = 'allin';
    if (kind === 'time') continue;
    actions.push({ kind, text, amount: num(text) });
  }

  const input = document.querySelector('.raise-input');
  const handId = ((document.body.innerText.match(/#(\d{6,})/) || [])[1]) || '';

  return {
    sb, bb, pot, board, players, dealerSeat, actions, handId,
    tableName: stakesTxt.split('\n')[0].trim(),
    heroHand: (document.querySelector('.high-hand') || {}).innerText || '',
    raiseInput: input ? num(input.value) : null,
  };
}
);
const ACTOR = (
// Executes a decision on the Kobra Poker table: {action: fold|check|call|raise|allin, amount}.
// Returns {ok, did} or {ok:false, error}. Shared by the desktop worker and the Android agent.
async (d) => {
  const num = (txt) => { if (!txt) return 0; const m = String(txt).replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*([KkMm])?/);
    if (!m) return 0; let n = parseFloat(m[1]); if (m[2]) n *= /k/i.test(m[2]) ? 1e3 : 1e6; return Math.round(n); };
  const money = (x) => x >= 1e6 ? +(x / 1e6).toFixed(2) + 'M' : x >= 1e3 ? +(x / 1e3).toFixed(1) + 'K' : String(x);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const items = () => [...document.querySelectorAll('.PlayerActionsContainer__actions_grid .GridComponent__item')]
    .map((it) => {
      const btn = it.querySelector('.SimpleButton');
      const text = it.innerText.replace(/\s+/g, ' ').trim();
      let kind = (it.className.match(/\bpa-([a-z_-]+)/) || [0, ''])[1];
      if (/all.?in/i.test(text)) kind = 'allin';
      return { kind, text, amount: num(text), btn,
               enabled: btn && !btn.classList.contains('disable') && !btn.classList.contains('SimpleButton_disabled') };
    }).filter((a) => a.enabled && a.kind !== 'time');
  const find = (acts, ...kinds) => { for (const k of kinds) { const a = acts.find((x) => x.kind === k || x.kind.startsWith(k)); if (a) return a; } return null; };

  const acts = items();
  if (!acts.some((a) => a.kind === 'fold' || a.kind === 'check')) return { ok: false, error: 'not our turn' };

  const seat = document.querySelector('.r-seat.client-seat');
  const stack = num((seat && seat.querySelector('.player-cash') || {}).innerText);
  const sm = seat && seat.className.match(/\bs-(\d+)\b/);
  const betEl = sm && document.querySelector(`.r-player-bet.s-${sm[1]} .value`);
  const maxTo = stack + (betEl ? num(betEl.innerText) : 0);

  const check = find(acts, 'check'), call = find(acts, 'call'), fold = find(acts, 'fold');
  const allin = find(acts, 'allin'), raise = find(acts, 'raise', 'bet');

  const setRaise = async (amount, kind) => {
    const inp = document.querySelector('.raise-input');
    if (inp) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      inp.focus(); setter.call(inp, String(Math.round(amount)));
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(300);
    }
    const now = find(items(), kind);
    return now ? now : null;
  };

  let action = d.action;
  if (action === 'fold' && check) action = 'check';
  if (action === 'check' && !check) action = 'fold';
  if (action === 'raise' && !raise) action = allin && !call ? 'allin' : 'call';
  if (action === 'call' && !call) action = allin ? 'allin' : (check ? 'check' : 'fold');

  if (action === 'allin') {
    if (allin) { allin.btn.click(); return { ok: true, did: 'ALL-IN' }; }
    if (raise) {
      const b = await setRaise(maxTo, raise.kind);
      if (!b) return { ok: false, error: 'raise button vanished' };
      b.btn.click(); return { ok: true, did: `ALL-IN ${money(b.amount)}` };
    }
    action = call ? 'call' : 'check';
  }
  if (action === 'raise') {
    const stakes = ((document.querySelector('.table-name') || {}).innerText || '').match(/Stakes:\s*([\d,.]+)/);
    const step = (stakes && num(stakes[1])) || 1;   // round to the small blind
    let amt = Math.max(raise.amount, Math.round((d.amount || 0) / step) * step);
    if (amt >= 0.9 * maxTo) amt = maxTo;
    let b = raise;
    if (amt !== raise.amount) b = await setRaise(amt, raise.kind);
    if (!b) return { ok: false, error: 'raise button vanished' };
    b.btn.click();
    const note = Math.abs(b.amount - amt) > amt * 0.02 ? ` (wanted ${money(amt)})` : '';
    return { ok: true, did: `${raise.kind.toUpperCase()} ${money(b.amount)}${note}` };
  }
  if (action === 'call') { call.btn.click(); return { ok: true, did: `CALL ${money(call.amount)}` }; }
  if (action === 'check') { check.btn.click(); return { ok: true, did: 'CHECK' }; }
  if (fold) { fold.btn.click(); return { ok: true, did: 'FOLD' }; }
  return { ok: false, error: 'no matching button' };
}
);
const JOIN = (
// Kobra Poker lobby & seating steps, run one at a time by the bot:  join({step, ...args})
//   list               -> lobby rows [{name, stakes, seats, players, max, minBuy, maxBuy}]
//   open {name}        -> search the lobby, select that table and press Play  ('opened' | 'not-found')
//   seats              -> on a table: {onTable, seated, free, players, max}
//   sit {dryRun}       -> press a free seat; returns what the buy-in dialog shows (dryRun: does not confirm)
//   buyin {mode, bb, bigBlind} -> set the buy-in amount (min | max | bb x big blind) and confirm
//   close              -> close an open dialog (cancel)
async (a) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const num = (t) => { const m = String(t || '').replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*([KkMm])?/);
    if (!m) return 0; let n = parseFloat(m[1]); if (m[2]) n *= /k/i.test(m[2]) ? 1e3 : 1e6; return Math.round(n); };
  const press = (el) => {
    const r = el.getBoundingClientRect(), o = { bubbles: true, cancelable: true, view: window,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    el.dispatchEvent(new PointerEvent('pointerdown', o)); el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new PointerEvent('pointerup', o)); el.dispatchEvent(new MouseEvent('mouseup', o));
    el.dispatchEvent(new MouseEvent('click', o));
  };
  const buttonWithText = (re, root = document) => [...root.querySelectorAll('.SimpleButton, button, .button')]
    .filter(vis).find((b) => re.test((b.innerText || '').trim()));
  const setInput = (el, v) => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    el.focus(); set.call(el, String(v)); el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true })); };
  const rows = () => [...document.querySelectorAll('.Table__body_row')].filter(vis).map((row) => {
    const cell = (c) => (row.querySelector(`.tct-${c}`) || {}).innerText || '';
    const [players, max] = cell('num-players').split('/').map((x) => parseInt(x, 10) || 0);
    const [minBuy, maxBuy] = cell('buy-in').split('/').map(num);
    return { row, name: cell('name').trim(), stakes: cell('stakes').trim(), players, max: max || num(cell('type')), minBuy, maxBuy };
  });
  const dialog = () => [...document.querySelectorAll('.Popup, .Dialog, [class*=Dialog], [class*=BuyIn], [class*=buy-in]')]
    .filter(vis).filter((d) => !d.closest('#pb-panel')).sort((x, y) => (y.innerText || '').length - (x.innerText || '').length)
    .find((d) => /buy|chips|amount|seat|sit/i.test(d.innerText || '')) || null;
  const outline = (d) => d ? {
    text: (d.innerText || '').replace(/\s+/g, ' ').slice(0, 400),
    buttons: [...d.querySelectorAll('.SimpleButton, button, .button')].filter(vis).map((b) => (b.innerText || '').trim()).filter(Boolean),
    inputs: [...d.querySelectorAll('input')].filter(vis).map((i) => `${i.type}:${i.className.split(' ').slice(0, 3).join('.')}`),
    sliders: [...d.querySelectorAll('[role=slider], .slider')].filter(vis).length,
  } : null;

  // Kobra marks "your" seat position even before you sit – you are seated only if a player is in it
  const seated = () => !!document.querySelector('.r-seat.client-seat .r-player');
  const tableReady = () => document.querySelectorAll('.r-seats .r-seat').length > 0
    && !!document.querySelector('.r-seats .free-seat, .r-seats .r-player');

  if (a.step === 'list') {
    // the lobby search box filters the list – clear it so every table shows
    const search = [...document.querySelectorAll('input.input_filter')].find(vis);
    if (search && search.value) { setInput(search, ''); await sleep(900); }
    return rows().map(({ row, ...r }) => r);
  }

  if (a.step === 'open') {
    const want = String(a.name || '').trim().toLowerCase();
    const search = [...document.querySelectorAll('input.input_filter')].find(vis);
    if (search) { setInput(search, a.name); await sleep(900); }
    const all = rows();
    const hit = all.find((r) => r.name.toLowerCase() === want) || all.find((r) => r.name.toLowerCase().includes(want));
    if (!hit) { if (search) setInput(search, ''); return 'not-found'; }
    press(hit.row); await sleep(700);
    const play = buttonWithText(/^play$/i);
    if (!play) return 'no-play-button';
    press(play);
    for (let i = 0; i < 30; i++) { await sleep(500); if (tableReady()) return 'opened'; }
    return 'clicked-play';
  }

  if (a.step === 'seats') {
    for (let i = 0; i < 20 && !tableReady(); i++) await sleep(500);
    const seatEls = [...document.querySelectorAll('.r-seats .r-seat')];
    const free = seatEls.filter((s) => { const b = s.querySelector('.free-seat'); return b && vis(b) && !b.classList.contains('disable'); });
    const taken = seatEls.filter((s) => s.querySelector('.r-player'));
    const m = location.href.match(/tableId=(\d+)/);
    return { onTable: seatEls.length > 0, seated: seated(), free: free.length, players: taken.length,
             max: seatEls.length, tableId: m ? m[1] : '' };
  }

  if (a.step === 'sit') {
    for (let i = 0; i < 20 && !tableReady(); i++) await sleep(500);
    const seat = [...document.querySelectorAll('.r-seats .r-seat .free-seat')].find((b) => vis(b) && !b.classList.contains('disable'));
    if (!seat) return { ok: false, reason: 'no free seat' };
    press(seat);
    for (let i = 0; i < 12; i++) { await sleep(400); const d = dialog(); if (d) return { ok: true, dialog: outline(d) }; }
    return { ok: true, dialog: null, seated: seated() };
  }

  if (a.step === 'buyin') {
    const d = dialog();
    if (!d) return { ok: false, reason: 'no buy-in dialog' };
    const input = [...d.querySelectorAll('input')].find(vis);
    const tx = (d.innerText || '').replace(/,/g, '');
    const nums = (tx.match(/\d+(?:\.\d+)?\s*[KkMm]?/g) || []).map(num).filter((n) => n > 0);
    let amount = null;
    // the dialog's own limits: "Min 10,000" / "Max 43,173" (max = what this account can afford)
    const minB = buttonWithText(/^min\b/i, d), maxB = buttonWithText(/^max\b/i, d);
    const lo = minB ? num(minB.innerText) : 0, hi = maxB ? num(maxB.innerText) : 0;
    if (a.mode === 'bb' && a.bb && a.bigBlind) {
      amount = Math.round(a.bb * a.bigBlind);
      if (hi && amount > hi) amount = hi;      // can't afford that many big blinds: take what we have
      if (lo && amount < lo) amount = lo;
    }
    if (hi && lo && hi < lo) return { ok: false, reason: `not enough chips for this table (minimum buy-in ${lo})` };
    if (input && amount) { setInput(input, amount); await sleep(300); }
    else if (a.mode === 'max') { const b = buttonWithText(/^max/i, d); if (b) { press(b); await sleep(300); } }
    else if (a.mode === 'min') { const b = buttonWithText(/^min/i, d); if (b) { press(b); await sleep(300); } }
    const ok = buttonWithText(/^(buy[\s-]?in|sit|sit down|ok|confirm|join|play|take seat)$/i, d)
            || buttonWithText(/buy|sit|confirm|ok/i, d);
    if (!ok) return { ok: false, reason: 'no confirm button', dialog: outline(d) };
    press(ok);
    for (let i = 0; i < 16; i++) { await sleep(500); if (seated()) return { ok: true, seated: true, amount }; }
    return { ok: true, seated: false, dialog: outline(dialog()) };
  }

  if (a.step === 'close') {
    const d = dialog();
    const c = (d && (buttonWithText(/^(cancel|close|no)$/i, d) || d.querySelector('[class*=close]'))) || null;
    if (c) { press(c); return 'closed'; }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return 'escape';
  }
  return 'unknown step';
}
);
const LEAVE = (
// Leaves the Kobra Poker table: presses "Leave Game" (the table's exit button), then confirms
// "Are you sure you want to leave the table?". Returns 'left', 'clicked' or 'no-button'.
async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const clickables = () => [...document.querySelectorAll('button, [role=button], .button, .SimpleButton, .panel.button, a')].filter(visible);
  const byText = (re) => clickables().find((b) => re.test((b.innerText || b.title || b.getAttribute('aria-label') || '').trim()));
  // Kobra marks "your" seat position even when you are not sitting – seated = a player in it
  const seated = () => !!document.querySelector('.r-seat.client-seat .r-player');

  // 1) "Leave Game": a labelled button, else the exit icon in the table header, else via the table menu
  let btn = byText(/^leave game$/i) || [...document.querySelectorAll('.TableHeaderContainer__exit_button')].find(visible);
  if (!btn) {
    const menu = [...document.querySelectorAll('.TableHeaderContainer__menu_button')].find(visible);
    if (menu) { menu.click(); await sleep(600); btn = byText(/^leave game$/i) || byText(/^leave table$/i); }
  }
  if (!btn) return 'no-button';
  btn.click();

  // 2) confirmation dialog
  for (let i = 0; i < 10; i++) {
    await sleep(400);
    const dialog = [...document.querySelectorAll('div')].filter(visible)
      .find((d) => /leave the table/i.test(d.innerText || '') && d.querySelectorAll('button, .button, .SimpleButton').length >= 1
                  && (d.innerText || '').length < 400);
    if (dialog) {
      const ok = [...dialog.querySelectorAll('button, [role=button], .button, .SimpleButton')].filter(visible)
        .find((b) => /^(ok|yes|leave|leave table|leave game|confirm|exit)$/i.test((b.innerText || '').trim()));
      if (ok) { ok.click(); await sleep(1200); break; }
    }
    if (!seated()) break;
  }
  await sleep(500);
  return seated() ? 'clicked' : 'left';
}
);
// PokerBot engine for the browser add-on: a JavaScript port of strategy.py, opponents.py and brain.py.
// Same decisions, same plain-language explanations. Runs completely inside the player's browser.
const PB = (() => {
  const RANKS = '23456789TJQKA';
  const SUIT_SYM = { s: '♠', h: '♥', d: '♦', c: '♣' };
  const FULL_DECK = [];
  for (const r of RANKS) for (const s of 'shdc') FULL_DECK.push(r + s);
  const RI = (r) => RANKS.indexOf(r);

  // ------------------------------------------------------------ helpers
  const siteToCard = (v) => v[1] + v[0];                       // Kobra 'hQ' -> 'Qh'
  const pretty = (cards) => cards.map((c) => c[0].replace('T', '10') + SUIT_SYM[c[1]]).join('');
  const trimNum = (s) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);
  function money(x) {
    if (x >= 1e6) return trimNum((x / 1e6).toFixed(2)) + 'M';
    if (x >= 1000) return trimNum((x / 1000).toFixed(1)) + 'K';
    return String(Math.trunc(x));
  }
  const pct = (x) => Math.round(x * 100) + '%';

  function chen(c1, c2) {
    const pts = { A: 10, K: 8, Q: 7, J: 6, T: 5 };
    const [r1, r2] = [c1[0], c2[0]].sort((a, b) => RI(b) - RI(a));
    const hi = r1 in pts ? pts[r1] : parseInt(r1, 10) / 2;
    if (r1 === r2) return Math.max(5, hi * 2);
    let score = hi;
    if (c1[1] === c2[1]) score += 2;
    const gap = RI(r1) - RI(r2) - 1;
    score -= ({ 0: 0, 1: 1, 2: 2, 3: 4 })[gap] ?? 5;
    if (gap <= 1 && RI(r1) < RI('Q')) score += 1;
    return Math.ceil(score);
  }

  function handLabel(c1, c2) {
    const [r1, r2] = [c1[0], c2[0]].sort((a, b) => RI(b) - RI(a));
    if (r1 === r2) return r1 + r2;
    return r1 + r2 + (c1[1] === c2[1] ? 's' : 'o');
  }

  const RANK_NAME = { A: 'Ace', K: 'King', Q: 'Queen', J: 'Jack', T: 'Ten', 9: 'Nine', 8: 'Eight',
                      7: 'Seven', 6: 'Six', 5: 'Five', 4: 'Four', 3: 'Three', 2: 'Two' };
  const RANK_PLURAL = {};
  for (const [r, n] of Object.entries(RANK_NAME)) RANK_PLURAL[r] = n + (n === 'Six' ? 'es' : 's');

  function handName(label) {
    if (label.length === 2) return `Pair of ${RANK_PLURAL[label[0]]}`;
    return `${RANK_NAME[label[0]]}-${RANK_NAME[label[1]]} ${label[2] === 's' ? 'suited' : 'offsuit'}`;
  }

  // ------------------------------------------------------------ hand evaluator
  // Cards as integers rank*4+suit. score() of 5..7 cards: bigger = better.
  const CATS = ['High Card', 'Pair', 'Two Pair', 'Three of a Kind', 'Straight', 'Flush', 'Full House',
                'Four of a Kind', 'Straight Flush'];
  const toInt = (c) => RI(c[0]) * 4 + 'shdc'.indexOf(c[1]);
  const pack = (cat, ks) => {
    let v = cat;
    for (let i = 0; i < 5; i++) v = v * 16 + (ks[i] ?? 0);
    return v;
  };
  function straightHigh(mask) {
    const ext = (mask << 1) | ((mask >> 12) & 1);   // bit 0 = ace as one
    for (let top = 13; top >= 4; top--) if (((ext >> (top - 4)) & 31) === 31) return top - 1;
    return -1;
  }
  function score(cs) {
    const rc = new Array(13).fill(0), sc = [0, 0, 0, 0], sm = [0, 0, 0, 0];
    let mask = 0;
    for (const c of cs) { const r = c >> 2, s = c & 3; rc[r]++; sc[s]++; sm[s] |= 1 << r; mask |= 1 << r; }
    let fs = -1;
    for (let s = 0; s < 4; s++) if (sc[s] >= 5) fs = s;
    if (fs >= 0) { const h = straightHigh(sm[fs]); if (h >= 0) return pack(8, [h]); }
    let quad = -1; const trips = [], pairs = [], singles = [];
    for (let r = 12; r >= 0; r--) {
      if (rc[r] === 4) quad = r; else if (rc[r] === 3) trips.push(r);
      else if (rc[r] === 2) pairs.push(r); else if (rc[r] === 1) singles.push(r);
    }
    if (quad >= 0) {
      let k = -1; for (let r = 12; r >= 0; r--) if (r !== quad && rc[r]) { k = r; break; }
      return pack(7, [quad, k]);
    }
    if (trips.length && (trips.length > 1 || pairs.length)) {
      return pack(6, [trips[0], Math.max(trips[1] ?? -1, pairs[0] ?? -1)]);
    }
    if (fs >= 0) {
      const ks = []; for (let r = 12; r >= 0 && ks.length < 5; r--) if (sm[fs] & (1 << r)) ks.push(r);
      return pack(5, ks);
    }
    const st = straightHigh(mask);
    if (st >= 0) return pack(4, [st]);
    if (trips.length) return pack(3, [trips[0], ...singles.slice(0, 2)]);
    if (pairs.length >= 2) {
      const k = Math.max(pairs[2] ?? -1, singles[0] ?? -1);
      return pack(2, [pairs[0], pairs[1], k]);
    }
    if (pairs.length) return pack(1, [pairs[0], ...singles.slice(0, 3)]);
    return pack(0, singles.slice(0, 5));
  }
  const category = (sc) => Math.floor(sc / 16 ** 5);

  function combos5(arr) {
    const out = [], n = arr.length;
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let c = b + 1; c < n; c++)
      for (let d = c + 1; d < n; d++) for (let e = d + 1; e < n; e++) out.push([arr[a], arr[b], arr[c], arr[d], arr[e]]);
    return out;
  }

  // Best 5-card hand in plain words: {category, text, cards (best five, most important first)}
  function describe(hole, board) {
    const allc = hole.concat(board);
    if (allc.length < 5) return null;
    let best = null, bestScore = -1;
    for (const combo of combos5(allc)) {
      const s = score(combo.map(toInt));
      if (s > bestScore) { bestScore = s; best = combo.slice(); }
    }
    const cat = CATS[category(bestScore)];
    const counts = {};
    for (const c of best) counts[c[0]] = (counts[c[0]] || 0) + 1;
    best.sort((x, y) => (counts[y[0]] - counts[x[0]]) || (RI(y[0]) - RI(x[0])));
    let ranks = best.map((c) => c[0]);
    const isWheel = new Set(ranks).size === 5 && [...'A2345'].every((r) => ranks.includes(r));
    if ((cat === 'Straight' || cat === 'Straight Flush') && isWheel) {
      best.sort((x, y) => (y[0] === 'A' ? -1 : RI(y[0])) - (x[0] === 'A' ? -1 : RI(x[0])));
      ranks = best.map((c) => c[0]);
    }
    const groups = [...new Set(ranks)];
    const hi = ranks[0], P = RANK_PLURAL, N = RANK_NAME;
    let text;
    if (cat === 'Straight Flush') {
      text = hi === 'A' && !isWheel ? 'Royal Flush' : `Straight Flush, ${N[ranks[4]]} to ${N[hi]}`;
    } else if (cat === 'Four of a Kind') text = `Four of a Kind, ${P[hi]}`;
    else if (cat === 'Full House') text = `Full House, ${P[groups[0]]} full of ${P[groups[1]]}`;
    else if (cat === 'Flush') text = `Flush, ${N[hi]} high`;
    else if (cat === 'Straight') text = `Straight, ${N[ranks[4]]} to ${N[hi]}`;
    else if (cat === 'Three of a Kind') text = `Three of a Kind, ${P[hi]}`;
    else if (cat === 'Two Pair') text = `Two Pair, ${P[groups[0]]} and ${P[groups[1]]}`;
    else if (cat === 'Pair') text = `Pair of ${P[hi]}`;
    else text = `High Card, ${N[hi]}`;
    return { category: text === 'Royal Flush' ? 'Royal Flush' : cat, text, cards: best };
  }

  // Flush / straight draws (only meaningful before the river)
  function draws(hole, board) {
    const out = [], cards = hole.concat(board);
    for (const s of 'shdc') {
      const n = cards.filter((c) => c[1] === s).length;
      if (n === 4 && hole.some((c) => c[1] === s)) out.push('flush draw');
    }
    const vals = new Set(cards.map((c) => RI(c[0]) + 2));
    if (vals.has(14)) vals.add(1);
    const holeVals = new Set(hole.map((c) => RI(c[0]) + 2));
    if (hole.some((c) => c[0] === 'A')) holeVals.add(1);
    for (let lo = 1; lo <= 10; lo++) {
      const window = [lo, lo + 1, lo + 2, lo + 3, lo + 4];
      const have = window.filter((v) => vals.has(v));
      if (have.length === 4 && have.some((v) => holeVals.has(v))) {
        const missing = window.find((v) => !vals.has(v));
        out.push((missing === lo || missing === lo + 4) && lo !== 1 && lo !== 10 ? 'open-ended straight draw' : 'gutshot');
        break;
      }
    }
    return out;
  }

  // Plain-words description used in explanations, e.g. 'Top pair of Kings'
  function madeHand(hole, board) {
    if (board.length < 3) return '';
    const d = describe(hole, board);
    if (d.category !== 'Pair') return d.text;
    const b = board.map((c) => RI(c[0])).sort((x, y) => y - x);
    const ph = hole.find((h) => b.includes(RI(h[0])));
    const pairRank = ph ? RI(ph[0]) : null;
    if (hole[0][0] === hole[1][0]) {
      const pr = RI(hole[0][0]);
      return pr > b[0] ? `Overpair, ${RANK_PLURAL[hole[0][0]]}` : `Pocket ${RANK_PLURAL[hole[0][0]]} (below the board)`;
    }
    if (pairRank === null) return `Pair of ${RANK_PLURAL[d.cards[0][0]]} on the board`;
    const rank = RANK_PLURAL[RANKS[pairRank]];
    if (pairRank === b[0]) return `Top pair of ${rank}`;
    return `${pairRank === b[1] ? 'Middle' : 'Bottom'} pair of ${rank}`;
  }

  // Monte Carlo win probability vs nOpp hands. The first opponent (the bettor) gets hands with
  // Chen >= minChen, the others Chen >= restMinChen (null = any two cards).
  const CHEN = [];
  for (let a = 0; a < 52; a++) {
    CHEN.push(new Array(52));
    for (let b = 0; b < 52; b++) if (a !== b) CHEN[a][b] = chen(FULL_DECK[a], FULL_DECK[b]);
  }
  const DECK_INT = FULL_DECK.map(toInt);     // FULL_DECK index -> evaluator int
  function equity(hole, board, nOpp, iters = 1500, minChen = null, restMinChen = null) {
    if (nOpp <= 0) return 1.0;
    const dead = new Set(hole.concat(board));
    const deck = [];
    FULL_DECK.forEach((c, i) => { if (!dead.has(c)) deck.push(i); });
    const holeI = hole.map(toInt), boardI = board.map(toInt);
    const need = nOpp * 2 + 5 - board.length;
    let wins = 0, done = 0, tries = 0;
    const full = new Array(7), opp = new Array(7);
    while (done < iters && tries < iters * 6) {
      tries++;
      for (let i = 0; i < need; i++) {                // partial Fisher-Yates
        const j = i + Math.floor(Math.random() * (deck.length - i));
        const t = deck[i]; deck[i] = deck[j]; deck[j] = t;
      }
      let ok = true;
      for (let k = 0; k < nOpp; k++) {
        const nd = k === 0 ? minChen : restMinChen;
        if (nd !== null && CHEN[deck[2 * k]][deck[2 * k + 1]] < nd) { ok = false; break; }
      }
      if (!ok) continue;
      const nb = boardI.length;
      for (let i = 0; i < nb; i++) full[i] = boardI[i];
      for (let i = 0; i < 5 - nb; i++) full[nb + i] = DECK_INT[deck[nOpp * 2 + i]];
      full[5] = holeI[0]; full[6] = holeI[1];
      const mine = score(full);
      for (let i = 0; i < 5; i++) opp[i] = full[i];
      let bestOpp = -1;
      for (let k = 0; k < nOpp; k++) {
        opp[5] = DECK_INT[deck[2 * k]]; opp[6] = DECK_INT[deck[2 * k + 1]];
        const s = score(opp);
        if (s > bestOpp) bestOpp = s;
      }
      if (mine > bestOpp) wins += 1; else if (mine === bestOpp) wins += 0.5;
      done++;
    }
    return wins / Math.max(done, 1);
  }

  // ------------------------------------------------------------ positions
  const POS_NAMES = {
    2: ['BTN/SB', 'BB'],
    3: ['BTN', 'SB', 'BB'],
    4: ['CO', 'BTN', 'SB', 'BB'],
    5: ['HJ', 'CO', 'BTN', 'SB', 'BB'],
    6: ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
    7: ['UTG', 'MP', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
    8: ['UTG', 'UTG+1', 'MP', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
    9: ['UTG', 'UTG+1', 'MP', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
  };
  function heroPosition(st) {
    const dealt = st.players.filter((p) => p.stack > 0 || p.inHand || p.hero).sort((a, b) => a.seat - b.seat);
    const n = dealt.length, d = st.dealerSeat;
    if (d === null || d === undefined || n < 2) return '?';
    const after = dealt.filter((p) => p.seat > d).concat(dealt.filter((p) => p.seat <= d));
    if (n === 2) return after[after.length - 1].hero ? 'BTN/SB' : 'BB';
    const i = after.findIndex((p) => p.hero);
    const names = POS_NAMES[n] || POS_NAMES[9];
    const rotated = names.slice(-2).concat(names.slice(0, -2));
    return rotated[i];
  }

  // ------------------------------------------------------------ styles
  const STYLES = {
    careful: { push_bb: 7, push_need: [10, 9, 12], open_shift: 1, call_frac: 0.10, setmine_frac: 0.05,
               fourbet_need: 16, margin: 0.10, stack_risk: 0.25, value_eq: [0.72, 0.58], allin_eq: 0.85,
               commit_eq: 0.70, semi_bluff: 0.25, cbet: 0.40 },
    normal: { push_bb: 12, push_need: [8, 7, 10], open_shift: 0, call_frac: 0.15, setmine_frac: 0.07,
              fourbet_need: 14, margin: 0.08, stack_risk: 0.10, value_eq: [0.70, 0.55], allin_eq: 0.80,
              commit_eq: 0.60, semi_bluff: 0.5, cbet: 0.6 },
    aggressive: { push_bb: 15, push_need: [7, 6, 9], open_shift: -1, call_frac: 0.20, setmine_frac: 0.08,
                  fourbet_need: 12, margin: 0.05, stack_risk: 0.0, value_eq: [0.65, 0.50], allin_eq: 0.75,
                  commit_eq: 0.55, semi_bluff: 0.65, cbet: 0.75 },
  };

  const D = (action, amount = 0, reason = '') => ({ action, amount: Math.trunc(amount), reason });

  // ------------------------------------------------------------ strategy
  class Strategy {
    constructor(style = 'careful', rand = Math.random) {
      this.style = STYLES[style] ? style : 'careful';
      this.p = STYLES[this.style];
      this.aggressorHand = null;
      this.rand = rand;
    }

    decide(st) {
      const hero = st.players.find((p) => p.hero);
      const hole = hero.cards.map(siteToCard);
      const board = st.board.map(siteToCard);
      const acts = {};
      for (const a of st.actions) acts[a.kind] = a;
      const bb = st.bb || 1;
      const maxBet = Math.max(0, ...st.players.map((p) => p.bet));
      let callAmt = acts.call ? acts.call.amount : Math.max(0, maxBet - hero.bet);
      if (acts.check) callAmt = 0;
      const opps = st.players.filter((p) => p.inHand && !p.hero);
      const pos = heroPosition(st);
      const c = { hero, hole, board, acts, bb, maxBet, toCall: callAmt, stack: hero.stack, opps, pot: st.pot, pos,
                  prof: st.opp || {} };
      const head = `[${pos}] ${pretty(hole)}` + (board.length ? ` | board ${pretty(board)}` : '');
      const d = board.length ? this.postflop(st, c) : this.preflop(st, c);
      d.reason = `${head} → ${d.reason}`;
      return d;
    }

    static read(c, player) {
      const p = player ? c.prof[player.name] : null;
      return p && p.type !== 'unknown' ? p : null;
    }

    static note(p) {
      return `${p.name} is a ${p.type} (plays ${p.vpip_pct}% of hands, raises ${p.pfr_pct}%, ` +
             `aggression ${p.af}, ${p.hands} hands seen)`;
    }

    aggressor(c) {
      let best = null;
      for (const p of c.opps) if (!best || p.bet > best.bet) best = p;
      return best;
    }

    preflop(st, c) {
      const { hole, bb, stack, toCall, pos } = c;
      const sc = chen(hole[0], hole[1]);
      const lab = handLabel(hole[0], hole[1]);
      const effBB = (stack + c.hero.bet) / bb;
      const raised = c.maxBet > bb;
      const raiseBB = c.maxBet / bb;
      const limpers = Math.max(0, st.players.filter((p) => p.bet === bb).length - 1);
      let info = `${handName(lab)}, strength ${sc}/20`;
      const late = ['CO', 'BTN', 'BTN/SB'].includes(pos);
      const nPlayers = c.opps.length + 1;
      const P = this.p;
      info += `, ${effBB.toFixed(0)}BB stack`;

      if (effBB <= P.push_bb) {
        const [early, lateb, vsRaise] = P.push_need;
        const need = raised ? vsRaise : (late || pos === 'SB' || pos === 'BB' ? lateb : early);
        if (sc >= need) return D('allin', 0, `${info}; short stack → shove, hand is strong enough (≥${need})`);
        if (toCall === 0) return D('check', 0, `${info}; short stack, free check`);
        return D('fold', 0, `${info}; short stack, protect chips – shove needs ≥${need}`);
      }

      if (!raised) {
        let openNeed = ({ UTG: 10, 'UTG+1': 10, MP: 9, LJ: 9, HJ: 8, CO: 8, BTN: 6, 'BTN/SB': 5, SB: 7, BB: 9 })[pos] ?? 9;
        openNeed += P.open_shift;
        if (nPlayers <= 4) openNeed -= 1;
        if (effBB < 20) openNeed += 1;
        const size = Math.trunc(bb * (2.5 + limpers));
        if (sc >= openNeed) {
          this.aggressorHand = st.handId;
          const what = limpers ? 'isolate the limper(s)' : 'open-raise';
          return D('raise', size, `${info} ≥ ${openNeed} needed in ${pos} → ${what} to ${money(size)}`);
        }
        if (toCall === 0) return D('check', 0, `${info}; not worth raising, check for free`);
        if (pos === 'SB' && limpers === 0 && sc >= 6) return D('call', 0, `${info}; cheap to complete the small blind`);
        if (limpers && sc >= 7 && toCall <= bb) return D('call', 0, `${info}; limped pot, call to see a cheap flop`);
        return D('fold', 0, `${info} < ${openNeed} needed to open from ${pos}`);
      }

      const threeBetPot = raiseBB >= 7;
      const pair = hole[0][0] === hole[1][0];
      const frac = toCall / Math.max(stack, 1);
      let adj = 0, why = '';
      const rp = Strategy.read(c, this.aggressor(c));
      if (rp && rp.pfr_pct >= 25) { adj = -2; why = ` [${Strategy.note(rp)} – raises light, so I defend wider]`; }
      else if (rp && rp.pfr_pct <= 8) { adj = 2; why = ` [${Strategy.note(rp)} – only raises strong hands, so I tighten up]`; }
      if (threeBetPot) {
        if (sc >= P.fourbet_need + adj || (this.style !== 'careful' && (lab === 'AKs' || lab === 'AKo'))) {
          return D(effBB < 40 ? 'allin' : 'raise', c.maxBet * 2.3,
                   `${info}; facing a re-raise (${raiseBB.toFixed(0)}BB) – premium hand → 4-bet${why}`);
        }
        if (sc >= 11 + adj && frac <= 2 * P.call_frac) {
          return D('call', 0, `${info}; strong hand, call the re-raise (${pct(frac)} of stack)${why}`);
        }
        return D('fold', 0, `${info}; too weak to continue vs a re-raise to ${raiseBB.toFixed(0)}BB${why}`);
      }
      if (sc >= 12 + adj || lab === 'AKs' || lab === 'AKo') {
        const size = Math.trunc(c.maxBet * (late ? 3 : 3.5));
        this.aggressorHand = st.handId;
        return D('raise', size, `${info}; premium vs a ${raiseBB.toFixed(1)}BB raise → 3-bet to ${money(size)}${why}`);
      }
      if (sc >= 9 + adj && frac <= P.call_frac) {
        return D('call', 0, `${info}; good hand, call ${money(toCall)} (${pct(frac)} of stack)${why}`);
      }
      if (pair && frac <= P.setmine_frac) return D('call', 0, `${info}; small pair, cheap call to hit a set (implied odds)`);
      if (pos === 'BB' && sc >= 7 && toCall <= 2 * bb) return D('call', 0, `${info}; defend big blind, getting a good price`);
      if (toCall === 0) return D('check', 0, `${info}; check`);
      return D('fold', 0, `${info}; not strong enough vs a ${raiseBB.toFixed(1)}BB raise${why}`);
    }

    postflop(st, c) {
      const { hole, board, pot, toCall, stack } = c;
      const nOpp = Math.max(1, c.opps.length);
      const street = { 3: 'flop', 4: 'turn', 5: 'river' }[board.length];
      let base = st.raisedPre ? 4 : null;
      let minChen = toCall > 0 ? 6 : base;
      const P = this.p;
      const reads = [];
      let marginAdj = 0;
      const bettor = toCall > 0 ? this.aggressor(c) : null;
      const bp = Strategy.read(c, bettor);
      if (bp && bp.af >= 2.5 && bp.vpip_pct >= 35) {
        minChen = 3; marginAdj = -0.03;
        reads.push(`${Strategy.note(bp)} – bets light, likely bluffing more often`);
      } else if (bp && (bp.af <= 1.0 || bp.vpip_pct <= 18)) {
        minChen = 8; marginAdj = 0.06;
        reads.push(`${Strategy.note(bp)} – rarely bets without a strong hand`);
      }
      const known = c.opps.filter((p) => p !== bettor).map((p) => Strategy.read(c, p)).filter(Boolean);
      if (known.length) {
        const v = known.reduce((s, p) => s + p.vpip_pct, 0) / known.length;
        const rest = v < 20 ? 7 : v < 35 ? 5 : null;
        if (rest && (base === null || rest > base)) base = rest;
      }
      const eq = equity(hole, board, nOpp, 1200, minChen, base);
      const made = madeHand(hole, board);
      const drw = street !== 'river' ? draws(hole, board) : [];
      const desc = made + (drw.length ? ' + ' + drw.join(', ') : '');
      const info = `${desc}; win chance ${pct(eq)} vs ${nOpp} opponent${nOpp > 1 ? 's' : ''}`;
      const aggressor = this.aggressorHand === st.handId;
      let [bigEq, medEq] = P.value_eq;

      if (toCall === 0) {
        const f = c.opps.map((o) => Strategy.read(c, o)).filter((p) => p && p.ftb_pct !== null && p.ftb_pct !== undefined)
          .map((p) => p.ftb_pct);
        const ftb = f.length ? f.reduce((a, b) => a + b, 0) / f.length : null;
        let bluffMult = 1.0, why = '';
        if (ftb !== null && ftb >= 55) { bluffMult = 1.6; why = ` [these opponents fold to bets ${ftb.toFixed(0)}% of the time]`; }
        else if (ftb !== null && ftb <= 30) {
          bluffMult = 0; medEq -= 0.04;
          why = ` [these opponents only fold ${ftb.toFixed(0)}% – no bluffs, bet thinner for value]`;
        }
        if (eq >= bigEq) {
          const size = Math.min(Math.trunc(pot * 0.66), stack);
          return D('raise', size, `${info} → value bet ${money(size)} (⅔ pot)${why}`);
        }
        if (eq >= medEq) {
          const size = Math.min(Math.trunc(pot * 0.5), stack);
          return D('raise', size, `${info} → bet ${money(size)} (½ pot) for value/protection${why}`);
        }
        if (drw.length && this.rand() < Math.min(0.9, P.semi_bluff * bluffMult) && pot * 0.5 <= stack / 3) {
          const size = Math.trunc(pot * 0.5);
          return D('raise', size, `${info} → semi-bluff ${money(size)}, draw can improve${why}`);
        }
        if (aggressor && street === 'flop' && nOpp <= 2 && this.rand() < Math.min(0.9, P.cbet * bluffMult)
            && pot * 0.33 <= stack / 3) {
          const size = Math.trunc(pot * 0.33);
          return D('raise', size, `${info} → continuation bet ${money(size)} (⅓ pot), I raised preflop${why}`);
        }
        return D('check', 0, `${info} → check, not strong enough to bet${why}`);
      }

      const potOdds = toCall / (pot + toCall);
      const betRatio = toCall / Math.max(pot - toCall, 1);
      const risk = Math.min(toCall / Math.max(stack, 1), 1.0);
      const need = Math.max(potOdds, potOdds + P.margin * Math.min(betRatio, 1.5) + P.stack_risk * risk + marginAdj);
      let oddsTxt = `call ${money(toCall)} into ${money(pot)} (${pct(risk)} of my ${money(stack)}) ` +
                    `needs ${pct(potOdds)} (+safety → ${pct(need)})`;
      if (reads.length) oddsTxt += ' [' + reads.join('; ') + ']';
      if (eq >= P.allin_eq && (c.acts.raise || c.acts.allin)) {
        const size = Math.trunc(c.maxBet * 3);
        if (size >= 0.5 * stack) return D('allin', 0, `${info}; ${oddsTxt} → very strong, shove`);
        return D('raise', size, `${info}; ${oddsTxt} → very strong, raise to ${money(size)}`);
      }
      if (eq >= need) {
        if (toCall >= 0.5 * stack) {
          if (eq >= P.commit_eq) return D('allin', 0, `${info}; ${oddsTxt} → committed, all-in`);
          return D('fold', 0, `${info}; ${oddsTxt} → would risk half my stack without a strong enough hand, fold`);
        }
        return D('call', 0, `${info}; ${oddsTxt} → call, equity beats the price`);
      }
      if (drw.length && street === 'flop' && eq >= potOdds && risk <= 0.2) {
        return D('call', 0, `${info}; ${oddsTxt} → call with the draw (implied odds)`);
      }
      return D('fold', 0, `${info}; ${oddsTxt} → fold, not enough equity`);
    }
  }

  // ------------------------------------------------------------ opponent learning
  const MIN_HANDS = 12;
  const COUNTERS = ['hands', 'vpip', 'pfr', 'bets', 'calls', 'checks', 'folds', 'faced', 'folded_to_bet'];

  function classify(text) {
    const t = (text || '').toLowerCase();
    if (!t || /blind|post|ante|straddle|sit|wait/.test(t)) return null;
    if (/all.?in/.test(t)) return 'allin';
    for (const [word, kind] of [['fold', 'fold'], ['check', 'check'], ['raise', 'raise'], ['bet', 'bet'], ['call', 'call']]) {
      if (t.includes(word)) return kind;
    }
    return null;
  }

  function playerType(p) {
    if (p.hands < MIN_HANDS) return 'unknown';
    const v = p.vpip_pct, af = p.af;
    if (v >= 45 && af >= 2) return 'maniac';
    if (v >= 40 && af < 1.2) return 'calling station';
    if (v <= 20 && af >= 1.5) return 'tight-aggressive';
    if (v <= 20) return 'rock';
    if (af >= 1.5) return 'loose-aggressive';
    return 'loose-passive';
  }

  const TYPE_HINT = {
    maniac: 'bets and raises with almost anything – call down lighter, let them bluff',
    'calling station': 'calls too much and rarely folds – value bet, never bluff',
    'tight-aggressive': 'solid player – respect raises',
    rock: 'only plays strong hands – fold to their bets unless strong, steal their blinds',
    'loose-aggressive': 'plays many hands aggressively – widen calling range a little',
    'loose-passive': 'plays many hands but rarely raises – bet for value',
    unknown: 'not enough hands yet',
  };

  function profile(name, row) {
    const p = { name, last_seen: row.last_seen || 0 };
    for (const k of COUNTERS) p[k] = row[k] || 0;
    const h = Math.max(p.hands, 1);
    p.vpip_pct = Math.round(p.vpip / h * 100);
    p.pfr_pct = Math.round(p.pfr / h * 100);
    p.af = p.calls ? Math.round(p.bets / p.calls * 100) / 100 : p.bets;
    p.ftb_pct = p.faced >= 5 ? Math.round(p.folded_to_bet / p.faced * 100) : null;
    p.type = playerType(p);
    p.hint = TYPE_HINT[p.type];
    return p;
  }

  // Player profiles kept in the browser (localStorage). `store` = {load() -> obj, save(obj)}.
  class OpponentDB {
    constructor(store, maxPlayers = 1500) {
      this.store = store;
      this.max = maxPlayers;
      this.rows = store.load() || {};
    }
    add(name, c) {
      const r = this.rows[name] || (this.rows[name] = {});
      for (const k of COUNTERS) r[k] = (r[k] || 0) + (c[k] || 0);
      r.last_seen = Date.now() / 1000;
      const names = Object.keys(this.rows);
      if (names.length > this.max) {
        names.sort((a, b) => (this.rows[a].last_seen || 0) - (this.rows[b].last_seen || 0));
        for (const n of names.slice(0, names.length - this.max)) delete this.rows[n];
      }
      this.store.save(this.rows);
    }
    getMany(names) {
      const out = {};
      for (const n of names) if (n && this.rows[n]) out[n] = profile(n, this.rows[n]);
      return out;
    }
    all(limit = 200) {
      return Object.keys(this.rows).map((n) => profile(n, this.rows[n]))
        .sort((a, b) => b.hands - a.hands).slice(0, limit);
    }
    reset() { this.rows = {}; this.store.save(this.rows); }
  }

  class OpponentTracker {
    constructor(db) {
      this.db = db;
      this.exclude = new Set();
      this.hand = null;
      this.street = null;
      this.pl = {};
      this.prevBets = {};
    }
    commit() {
      for (const [name, s] of Object.entries(this.pl)) {
        if (!s.dealt || this.exclude.has(name)) continue;
        this.db.add(name, { ...s.c, hands: 1, vpip: s.vpip ? 1 : 0, pfr: s.pfr ? 1 : 0 });
      }
    }
    addPlayer(p) {
      if (p.hero || !p.name) return null;
      const c = {}; for (const k of COUNTERS) c[k] = 0;
      const s = { dealt: p.inHand, in: p.inHand, act: p.lastAction || '', bet: p.bet, vpip: false, pfr: false, c };
      this.pl[p.name] = s;
      return s;
    }
    observe(st) {
      if (!st || !st.handId) return;
      const hero = st.players.find((p) => p.hero);
      if (hero) this.exclude.add(hero.name);
      const street = st.board.length;
      const bb = st.bb || 0;
      if (st.handId !== this.hand) {
        if (this.hand !== null) this.commit();
        this.hand = st.handId; this.street = street; this.pl = {};
        this.prevBets = {};
        for (const p of st.players) { this.prevBets[p.name] = p.bet; this.addPlayer(p); }
        return;
      }
      if (street !== this.street) {
        this.street = street;
        for (const n of Object.keys(this.prevBets)) this.prevBets[n] = 0;
        for (const s of Object.values(this.pl)) s.bet = 0;
      }
      const prevMaxAll = Math.max(0, ...Object.values(this.prevBets));
      const holding = st.players.filter((p) => p.inHand).length;
      for (const p of st.players) {
        if (p.hero || !p.name) continue;
        const s = this.pl[p.name] || this.addPlayer(p);
        if (p.inHand) s.dealt = true;
        const text = p.lastAction || '';
        let kind = null;
        const blindPost = street === 0 && bb && p.bet <= bb && prevMaxAll < bb;
        if (text !== s.act && classify(text)) kind = classify(text);
        else if (p.bet > s.bet && !blindPost) kind = p.bet > prevMaxAll ? 'raise' : 'call';
        else if (s.in && !p.inHand && holding >= 2) kind = 'fold';
        if (kind) {
          const others = Object.entries(this.prevBets).filter(([n]) => n !== p.name).map(([, b]) => b);
          const facing = Math.max(0, ...others) > s.bet;
          const c = s.c;
          if (kind === 'bet' || kind === 'raise' || kind === 'allin') c.bets++;
          else if (kind === 'call') c.calls++;
          else if (kind === 'check') c.checks++;
          else if (kind === 'fold') c.folds++;
          if (facing && kind !== 'check') { c.faced++; if (kind === 'fold') c.folded_to_bet++; }
          if (street === 0 && ['call', 'bet', 'raise', 'allin'].includes(kind)) s.vpip = true;
          if (street === 0 && ['bet', 'raise', 'allin'].includes(kind)) s.pfr = true;
        }
        s.act = text; s.bet = p.bet; s.in = p.inHand;
      }
      this.prevBets = {};
      for (const p of st.players) this.prevBets[p.name] = p.bet;
    }
  }

  // ------------------------------------------------------------ hand results & goals
  const STREETS = { 0: 'preflop', 3: 'flop', 4: 'turn', 5: 'river' };
  const isOurTurn = (st) => !!st && (st.actions || []).some((a) => a.kind === 'fold' || a.kind === 'check');
  const heroOf = (st) => (st ? st.players.find((p) => p.hero) || null : null);

  class HandTracker {
    constructor() { this.cur = null; }
    observe(st, table) {
      const hero = heroOf(st);
      const hid = st ? st.handId : '';
      if (!hero || !hid) return null;
      const chips = hero.stack + hero.bet;
      let done = null;
      if (!this.cur || hid !== this.cur.handId) {
        const c = this.cur;
        if (c && c.dealt) {
          const delta = chips - c.start;
          if (delta <= c.maxPot + c.bb) {
            done = { hand_id: c.handId, table: c.table, ts: Date.now() / 1000, cards: c.cards, board: c.board,
                     result: delta, bb: c.bb, bot: c.bot, position: c.position, street: STREETS[c.streetN] || '?',
                     label: c.label, made: '', made_cards: '' };
            if (c.seenBoard.length >= 3) {
              const d = describe(c.hole.map(siteToCard), c.seenBoard.map(siteToCard));
              if (d) { done.made = d.text; done.made_cards = pretty(d.cards); }
            }
          }
        }
        this.cur = { handId: hid, table, start: chips, dealt: false, cards: '', board: '', boardN: 0, maxPot: 0,
                     bb: st.bb || 0, bot: false, position: '', streetN: 0, label: '', hole: [], seenBoard: [] };
      }
      const c = this.cur;
      if (hero.cards.length === 2) {
        if (!c.dealt) {
          c.position = heroPosition(st);
          c.label = handLabel(...hero.cards.map(siteToCard));
        }
        c.dealt = true;
        c.cards = pretty(hero.cards.map(siteToCard));
        c.streetN = st.board.length;
        c.hole = hero.cards.slice(); c.seenBoard = st.board.slice();
      }
      if (st.board.length >= c.boardN) { c.boardN = st.board.length; c.board = pretty(st.board.map(siteToCard)); }
      c.maxPot = Math.max(c.maxPot, st.pot || 0);
      return done;
    }
    markBot() { if (this.cur) this.cur.bot = true; }
  }

  // 'Leave the table once my chips reach N x what I started with' / stop-loss
  class LeaveGoal {
    constructor(mult = 0, stopLoss = 0) { this.mult = +mult || 0; this.stopLoss = +stopLoss || 0; this.reset(); }
    reset() { this.start = null; this.table = null; this.leaving = false; this.reason = ''; this.chips = null; }
    get target() { return this.start && this.mult ? Math.trunc(this.start * this.mult) : null; }
    update(st, table, running) {
      const hero = heroOf(st);
      if (!running || !(this.mult || this.stopLoss) || !hero) return null;
      if (table !== this.table) { this.reset(); this.table = table; }
      const chips = hero.stack + hero.bet;
      this.chips = chips;
      if (!this.start) {
        if (chips > 0 && (!hero.cards.length || !st.board.length)) this.start = chips;
        return null;
      }
      if (!this.leaving && this.mult && this.target && chips >= this.target) { this.leaving = true; this.reason = 'goal'; }
      if (!this.leaving && this.stopLoss && chips <= this.start * (1 - this.stopLoss)) { this.leaving = true; this.reason = 'stop-loss'; }
      if (this.leaving && !hero.cards.length) return 'leave';
      return null;
    }
  }

  class BotBrain {
    constructor(style, oppDB) {
      this.strategy = new Strategy(style);
      this.tracker = new HandTracker();
      this.lastSig = null;
      this.raisedPre = {};
      this.oppDB = oppDB || null;
      this.oppTracker = oppDB ? new OpponentTracker(oppDB) : null;
      this.goal = new LeaveGoal();
      this.exitReason = '';
    }
    setStyle(style) {
      if (style !== this.strategy.style) {
        const agg = this.strategy.aggressorHand;
        this.strategy = new Strategy(style);
        this.strategy.aggressorHand = agg;
      }
    }
    observe(st, table) {
      if (!st) return null;
      if (!st.board.length && Math.max(0, ...st.players.map((p) => p.bet)) > st.bb) {
        this.raisedPre[st.handId] = true;
        const keys = Object.keys(this.raisedPre);
        if (keys.length > 50) delete this.raisedPre[keys[0]];
      }
      if (this.oppTracker) { try { this.oppTracker.observe(st); } catch (e) { /* learning never breaks playing */ } }
      return this.tracker.observe(st, table);
    }
    needsDecision(st) {
      const hero = heroOf(st);
      if (!isOurTurn(st) || !hero || hero.cards.length < 2) return false;
      const sig = JSON.stringify([st.handId, st.board, st.pot, st.actions.map((a) => a.text)]);
      if (sig === this.lastSig) return false;
      this.lastSig = sig;
      return true;
    }
    decide(st) {
      if (this.exitReason) return D('fold', 0, `${this.exitReason} – folding/checking so I can leave after this hand`);
      if (this.goal.leaving) {
        const g = this.goal;
        const what = g.reason === 'stop-loss' ? 'Stop-loss hit' : 'Target reached';
        return D('fold', 0, `${what}: ${money(g.start)} → ${money(g.chips)} (${(g.chips / g.start).toFixed(1)}×) ` +
                            '– folding/checking so I can leave the table');
      }
      let opp = {};
      if (this.oppDB) { try { opp = this.oppDB.getMany(st.players.filter((p) => !p.hero).map((p) => p.name)); } catch (e) { opp = {}; } }
      return this.strategy.decide({ ...st, raisedPre: !!this.raisedPre[st.handId], opp });
    }
    acted(did, st) {
      this.tracker.markBot();
      const word = did ? did.split(' ')[0].toUpperCase() : '';
      const kind = { FOLD: 'fold', CHECK: 'check', CALL: 'call', RAISE: 'raise', BET: 'raise', 'ALL-IN': 'allin' }[word] || word.toLowerCase();
      const c = this.tracker.cur || {};
      return { ts: Date.now() / 1000, hand_id: st.handId || '', street: STREETS[st.board.length] || '?',
               position: c.position || heroPosition(st), action: kind };
    }
    failed() { this.lastSig = null; }
  }

  return { RANKS, SUIT_SYM, siteToCard, pretty, money, chen, handLabel, handName, score, category, CATS, toInt,
           describe, draws, madeHand, equity, heroPosition, STYLES, Strategy, classify, playerType, profile,
           OpponentDB, OpponentTracker, HandTracker, LeaveGoal, BotBrain, isOurTurn, heroOf, STREETS, TYPE_HINT };
})();

// PokerBot add-on runtime: runs inside the Kobra Poker page (phone or computer browser).
// Plays with the engine in engine.js, sits down by itself, keeps stats and learns opponents.
// Everything stays in this browser (localStorage) – it talks to no server of any kind.
// The build (build_addon.py) puts engine.js, the page scripts (reader/actor/join/leave.js) and
// VERSION / HOME in front of this file.
(() => {
  'use strict';
  if (window.__pbmLoaded) return;
  window.__pbmLoaded = VERSION;

  const PHONE = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const LOBBY = '/play/d/' + (PHONE ? '?designType=desktop' : '');
  const tableUrl = (id) => `/play/d/?tableId=${id}` + (PHONE ? '&designType=desktop' : '');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const now = () => Date.now() / 1000;
  const money = PB.money;

  // ------------------------------------------------------------ storage (this browser only)
  const LS = {
    get(k, d) { try { const v = localStorage.getItem('pbm_' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('pbm_' + k, JSON.stringify(v)); } catch (e) { /* storage full / blocked */ } },
  };
  const DEFAULTS = {
    style: 'careful', tables: [], autojoin: true, buyin: '100bb', leaveMult: 0, stopLoss: 0, leaveWhenFull: false,
    minDelay: 1, maxDelay: 3, wake: true, desktop: true, width: 1280, autoUpdate: true, learn: true, open: true,
  };
  const cfg = Object.assign({}, DEFAULTS, LS.get('settings', {}));
  const saveCfg = () => LS.set('settings', cfg);
  const S = Object.assign({ running: false, mission: false, phase: 'idle', tableName: '', cooldown: {},
                            goal: null, exitReason: '', session: { start: now(), net: 0, hands: 0 } },
                          LS.get('state', {}));
  const saveState = () => {
    const g = brain.goal;
    S.goal = g.start ? { table: g.table, start: g.start, leaving: g.leaving, reason: g.reason } : null;
    S.exitReason = brain.exitReason;
    LS.set('state', S);
  };
  let hands = LS.get('hands', []);
  const acts = LS.get('acts', { fold: 0, check: 0, call: 0, raise: 0, allin: 0 });
  let logLines = LS.get('log', []);

  const oppDB = new PB.OpponentDB({ load: () => LS.get('opp', {}), save: (v) => LS.set('opp', v) });
  const brain = new PB.BotBrain(cfg.style, cfg.learn ? oppDB : null);
  brain.goal.mult = +cfg.leaveMult || 0;
  brain.goal.stopLoss = +cfg.stopLoss || 0;
  if (S.goal) Object.assign(brain.goal, S.goal);     // survive page reloads mid-session
  brain.exitReason = S.exitReason || '';

  function log(tag, text) {
    const d = new Date();
    logLines.push({ t: d.toTimeString().slice(0, 8), a: tag, r: text });
    if (logLines.length > 300) logLines = logLines.slice(-300);
    LS.set('log', logLines);
    ui.dirty = true;
  }

  // ------------------------------------------------------------ one tab at a time
  const TAB = Math.random().toString(36).slice(2);
  function haveLock() {
    const l = LS.get('lock', null), t = Date.now();
    if (!l || l.id === TAB || t - l.ts > 8000) { LS.set('lock', { id: TAB, ts: t }); return true; }
    return false;
  }
  addEventListener('pagehide', () => { const l = LS.get('lock', null); if (l && l.id === TAB) LS.set('lock', null); saveState(); });

  // ------------------------------------------------------------ page helpers
  const tableId = (url) => ((url || '').match(/tableId=(\d+)/) || [])[1] || '';
  const join = (step, args = {}) => JOIN({ step, ...args });
  function go(url) { saveState(); location.href = url; }
  const isLoggedIn = () => !document.querySelector('input[type=password]')
    && !!document.querySelector('.Table__body_row, .r-seats, [class*=MiniUserInfo__balance], [class*=Cashier]');
  const onCooldown = (k) => (S.cooldown[String(k).toLowerCase()] || 0) > now();
  function setCooldown(k, sec = 300) {
    if (!k) return;
    S.cooldown[String(k).toLowerCase()] = now() + sec;
    for (const [key, t] of Object.entries(S.cooldown)) if (t < now()) delete S.cooldown[key];
  }

  // ------------------------------------------------------------ screen wake lock
  let wakeLock = null;
  async function updateWake() {
    const want = cfg.wake && (S.running || S.mission) && document.visibilityState === 'visible';
    try {
      if (want && !wakeLock && navigator.wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } else if (!want && wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch (e) { wakeLock = null; }
  }
  document.addEventListener('visibilitychange', () => { updateWake(); ui.dirty = true; });

  // ------------------------------------------------------------ control
  function setRunning(on, why) {
    if (on === S.running) { if (why) log(on ? 'START' : 'STOP', why); return; }
    S.running = on;
    brain.failed();
    if (on) brain.goal.reset();          // the "leave at 2×" target counts from this start
    log(on ? 'START' : 'STOP', why || (on ? 'bot is now playing' : 'bot is now paused'));
    saveState(); updateWake();
  }
  function startMission() {
    S.mission = true; S.nextTry = 0; brain.exitReason = '';
    S.session = { start: now(), net: 0, hands: 0 };
    const tables = cfg.tables.filter((t) => String(t).trim());
    if (cfg.autojoin && tables.length) log('PLAY', `joining one of: ${tables.join(', ')}`);
    else log('PLAY', 'sit down at a table and I start playing' + (tables.length ? '' : ' (add tables to sit down by myself)'));
    saveState(); updateWake();
  }
  function stopAll() {
    S.mission = false; S.phase = 'idle';
    setRunning(false, 'stopped');
    saveState(); updateWake();
  }
  function requestLeave() {
    if (seatedNow) { brain.exitReason = 'leave requested'; S.mission = false; log('LEAVE', 'leaving the table after this hand'); }
    else log('LEAVE', 'not sitting at a table');
    saveState();
  }

  // ------------------------------------------------------------ main loop
  let seatedNow = false, lastSeatCheck = 0, blankSince = 0, lastWaitLog = 0, noRowsSince = 0, lastSt = null, lastDecision = null;
  let busy = false, otherTab = false;

  // the lobby's table list, read without touching the page (for "Pick from Kobra's table list")
  let lastLobbyRead = 0;
  function readLobby() {
    if (now() - lastLobbyRead < 20) return;
    const rows = [...document.querySelectorAll('.Table__body_row')].map((row) => {
      const cell = (c) => ((row.querySelector(`.tct-${c}`) || {}).innerText || '').trim();
      const [players, max] = cell('num-players').split('/').map((x) => parseInt(x, 10) || 0);
      return { name: cell('name'), stakes: cell('stakes'), players, max };
    }).filter((r) => r.name);
    if (!rows.length) return;
    lastLobbyRead = now();
    const old = LS.get('lobby', null);
    if (rows.length && (!old || rows.length >= old.rows.length || now() - old.ts > 600)) LS.set('lobby', { ts: now(), rows });
  }

  async function tick() {
    if (!haveLock()) { otherTab = true; ui.dirty = true; return; }
    otherTab = false;
    readLobby();
    const st = READER();
    lastSt = st;
    const table = tableId(location.href);
    const done = brain.observe(st, table);
    if (done) recordHand(done);
    const hero = PB.heroOf(st);
    seatedNow = !!hero;
    const g = brain.goal, wasLeaving = g.leaving, oldStart = g.start;
    const leaveNow = g.update(st, table, S.running) === 'leave';
    if (g.start !== oldStart) saveState();
    if (g.leaving && !wasLeaving) {
      if (g.reason === 'stop-loss') {
        log('STOP-LOSS', `chips ${money(g.chips)} fell below ${money(g.start * (1 - g.stopLoss))} – leaving after this hand`);
      } else {
        log('TARGET', `chips ${money(g.chips)} reached ${g.mult}× the starting ${money(g.start)} – leaving as soon as I'm out of the hand`);
      }
      saveState();
    }
    if (leaveNow) { await leaveTable(true); return; }
    if (hero && brain.exitReason && !hero.cards.length) { await leaveTable(false); return; }
    if (S.mission && await missionStep(st, hero)) return;
    if (!S.running || !brain.needsDecision(st)) return;
    const d = brain.decide(st);
    const lo = Math.max(0.3, +cfg.minDelay || 1), hi = Math.max(lo, +cfg.maxDelay || 3);
    await sleep((lo + Math.random() * (hi - lo)) * 1000);
    if (!S.running) return;
    if (!PB.isOurTurn(READER())) return;             // turn passed (timeout / you clicked)
    const res = await ACTOR({ action: d.action, amount: d.amount });
    if (res && res.ok) {
      const rec = brain.acted(res.did, st);
      acts[rec.action] = (acts[rec.action] || 0) + 1;
      LS.set('acts', acts);
      lastDecision = { did: res.did, reason: d.reason };
      log(res.did, d.reason);
    } else {
      brain.failed();
      if (res && res.error !== 'not our turn') log('ERROR', `${res.error}; ${d.reason}`);
    }
  }

  function recordHand(h) {
    hands.push(h);
    if (hands.length > 3000) hands = hands.slice(-3000);
    LS.set('hands', hands);
    S.session.net += h.result; S.session.hands += 1;
    const r = h.result;
    log(r > 0 ? 'WON' : r < 0 ? 'LOST' : 'EVEN', `hand #${h.hand_id} ${h.cards} ${h.board} → ${signed(r)}`
        + (h.made ? ` (${h.made})` : ''));
    saveState();
  }

  // ------------------------------------------------------------ "Play": find a table and sit down
  async function missionStep(st, hero) {
    const t = now();
    if (hero) {
      if (S.phase !== 'playing') {
        S.phase = 'playing';
        if (!S.running) setRunning(true, `seated${S.tableName ? ' at ' + S.tableName : ''} – playing`);
      }
      if (cfg.leaveWhenFull && !brain.exitReason && t - lastSeatCheck > 6) {
        lastSeatCheck = t;
        const seats = await join('seats');
        if (seats.max && seats.free === 0) {
          brain.exitReason = 'table is full';
          log('TABLE FULL', `all ${seats.max} seats are taken – leaving after this hand` + (cfg.autojoin ? ' and joining another table' : ''));
          saveState();
        }
      }
      return false;
    }
    if (t < (S.nextTry || 0)) return true;
    S.nextTry = t + 4;
    if (!isLoggedIn()) {
      const blank = !document.querySelector('input[type=password], .Table__body_row, .r-seats .r-seat, .TabButton');
      if (blank) {
        blankSince = blankSince || t;
        if (t - blankSince > 25) { blankSince = 0; log('JOIN', 'page did not load – going back to the lobby'); go(LOBBY); }
        return true;
      }
      blankSince = 0;
      if (S.phase !== 'log in') {
        S.phase = 'log in';
        log('LOGIN', 'please log in to Kobra (tick "Remember password") – I carry on by myself');
      }
      return true;
    }
    blankSince = 0;
    const tables = cfg.tables.map((x) => String(x).trim()).filter(Boolean);
    if (!(cfg.autojoin && tables.length)) {
      S.phase = 'waiting – sit down at a table';
      if (!S.running) setRunning(true, 'logged in – sit down at a table and I start playing');
      return true;
    }
    const seats = await join('seats');
    const here = seats.tableId || '';
    if (seats.onTable) {
      const name = (st && st.tableName) || S.tableName;
      if (seats.free > 0 && !onCooldown(here) && !onCooldown(name)) {
        S.phase = 'sitting down';
        await sitDown(st, here);
        return true;
      }
      setCooldown(here, 120);
      S.phase = 'finding a table';
      go(LOBBY);
      return true;
    }
    S.phase = 'finding a table';
    const rows = await join('list');
    if (!rows || !rows.length) {
      noRowsSince = noRowsSince || t;
      if (t - noRowsSince > 20) { noRowsSince = 0; go(LOBBY); }
      return true;
    }
    noRowsSince = 0;
    LS.set('lobby', { ts: t, rows });
    for (const entry of tables) {
      const tid = entry.match(/^(?:.*tableId=)?(\d{4,})$/);
      if (tid && !onCooldown(tid[1])) {
        S.tableName = entry;
        S.nextTry = t + 3;
        go(tableUrl(tid[1]));
        return true;
      }
      const want = entry.toLowerCase();
      const row = rows.find((r) => r.name.toLowerCase() === want) || rows.find((r) => r.name.toLowerCase().includes(want));
      if (row && row.players < (row.max || 99) && !onCooldown(row.name)) {
        const res = await join('open', { name: row.name });
        log('JOIN', `opening ${row.name} (${row.stakes}, ${row.players}/${row.max} players)` + (res === 'opened' ? '' : ` – ${res}`));
        S.tableName = row.name;
        if (res !== 'opened') setCooldown(row.name, 120);
        S.nextTry = now() + 2;
        saveState();
        return true;
      }
    }
    if (t - lastWaitLog > 120) { lastWaitLog = t; log('WAITING', 'no free seat at my tables right now – checking again every 30 s'); }
    S.phase = 'waiting for a free seat';
    S.nextTry = t + 30;
    return true;
  }

  async function sitDown(st, tableKey) {
    const bb = (st && st.bb) || 0;
    const mode = cfg.buyin || 'min';
    const sit = await join('sit');
    if (!sit.ok) { log('JOIN', `could not take a seat: ${sit.reason}`); setCooldown(tableKey, 120); return; }
    if (sit.seated) return;
    let args = { mode: 'min' };
    if (mode === 'max') args = { mode: 'max' };
    else if (/bb$/.test(mode) && bb) args = { mode: 'bb', bb: parseInt(mode, 10), bigBlind: bb };
    const res = await join('buyin', args);
    if (res.seated) {
      brain.goal.reset();
      log('SAT DOWN', `took a seat at ${S.tableName || 'the table'} (buy-in: ${mode.replace('bb', ' big blinds')})`);
    } else {
      log('JOIN', `buy-in did not go through (${res.reason || 'no seat yet'}) – trying another table`);
      await join('close');
      setCooldown(tableKey, 300); setCooldown(S.tableName, 300);
    }
    saveState();
  }

  async function leaveTable(goal) {
    const g = brain.goal, reason = brain.exitReason;
    const summary = g.start && g.chips ? `started with ${money(g.start)}, now ${money(g.chips)} (${(g.chips / g.start).toFixed(2)}×)` : '';
    let res = 'no-button';
    for (let i = 0; i < 3; i++) {
      try { res = await LEAVE(); } catch (e) { res = String(e.message || e); }
      if (res === 'left') break;
      await sleep(1500);
    }
    const why = goal ? (g.reason === 'stop-loss' ? 'stop-loss hit' : 'goal reached') : (reason || 'leaving');
    if (res === 'left') log('LEFT TABLE', `pressed Leave Game – ${why}` + (summary ? `: ${summary}` : ''));
    else log('ERROR', `tried to leave the table (${res}) – please press Leave Game yourself` + (summary ? `; ${summary}` : ''));
    const here = tableId(location.href);
    g.reset();
    brain.exitReason = '';
    if (goal || !S.mission || reason === 'leave requested') {
      S.mission = false; S.phase = 'idle';
      setRunning(false, goal ? `stopped – ${why}` : 'left the table');
    } else {
      setCooldown(here, 300); setCooldown(S.tableName, 300);
      setRunning(false, 'looking for another table');
      S.phase = 'finding a table';
      S.nextTry = now() + 3;
      saveState();
      if (here) go(LOBBY);
    }
    saveState(); updateWake();
  }

  // ------------------------------------------------------------ ticker (keeps running in background tabs)
  function startTicker(fn, ms) {
    try {
      const w = new Worker(URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${ms})`], { type: 'text/javascript' })));
      w.onmessage = fn;
      return;
    } catch (e) { /* no workers: plain timer */ }
    setInterval(fn, ms);
  }
  async function step() {
    if (busy) return;
    busy = true;
    try { await tick(); } catch (e) { log('ERROR', String(e && e.message || e)); brain.failed(); }
    finally { busy = false; }
  }

  // ------------------------------------------------------------ panel
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const cardChips = (txt) => esc(txt).replace(/(10|[2-9JQKA])([♠♥♦♣])/g,
    (m, r, s) => `<span class="cd ${s === '♥' || s === '♦' ? 'red' : ''}">${r}${s}</span>`);
  const signed = (x) => (x > 0 ? '+' : x < 0 ? '−' : '') + money(Math.abs(x));
  const STYLE_TXT = { careful: 'Careful (tight, protects chips)', normal: 'Normal', aggressive: 'Aggressive' };
  const BUYIN_TXT = { min: 'Minimum', '20bb': '20 big blinds', '50bb': '50 big blinds', '100bb': '100 big blinds',
                      '200bb': '200 big blinds', max: 'Maximum' };

  const CSS = `
  :host{all:initial}
  *{box-sizing:border-box}
  .wrap{position:fixed;left:8px;bottom:8px;z-index:2147483647;font:14px/1.4 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#f3e9d2;
    transform-origin:left bottom}
  .fab{width:54px;height:54px;border-radius:50%;border:2px solid #d4af37;background:#5a0f12;color:#d4af37;font-size:26px;
    display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.6);position:relative}
  .fab .dot{position:absolute;right:2px;top:2px;width:13px;height:13px;border-radius:50%;border:2px solid #2a0507}
  .panel{width:350px;background:#3d0a0d;border:2px solid #d4af37;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.7);
    display:flex;flex-direction:column;overflow:hidden}
  .head{display:flex;align-items:center;gap:8px;padding:8px 10px;background:#2a0507;border-bottom:1px solid #d4af3766}
  .head b{color:#d4af37;font-size:15px}
  .head .ph{flex:1;font-size:12px;opacity:.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .x{background:none;border:0;color:#d4af37;font-size:20px;cursor:pointer;padding:0 4px}
  .dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:#777}
  .dot.on{background:#3ecf5a}.dot.busy{background:#f2b632}.dot.off{background:#888}
  .tabs{display:flex;background:#2a0507}
  .tabs button{flex:1;background:none;border:0;border-bottom:2px solid transparent;color:#e8d9b5;padding:7px 2px;font-size:13px;cursor:pointer}
  .tabs button.act{border-color:#d4af37;color:#d4af37;font-weight:600}
  .body{padding:10px;overflow-y:auto}
  .row{display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap;align-items:center}
  .btn{flex:1;border:1px solid #d4af37;border-radius:9px;padding:10px 6px;font-size:15px;font-weight:600;cursor:pointer;color:#fff;background:#6b1418}
  .btn.go{background:#1f7a3a}.btn.stop{background:#8a1c1c}.btn.sm{flex:0 0 auto;padding:5px 9px;font-size:12px;font-weight:500}
  .btn:disabled{opacity:.45}
  .card{background:#2a0507;border:1px solid #d4af3755;border-radius:10px;padding:8px 10px;margin-bottom:8px}
  .kv{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;font-size:13px}
  .kv span:nth-child(odd){opacity:.7}
  .bar{height:8px;background:#5a0f12;border-radius:5px;overflow:hidden;margin-top:6px}
  .bar i{display:block;height:100%;background:#d4af37}
  .muted{opacity:.7;font-size:12px}
  .pos{color:#5fdc7a}.neg{color:#ff7272}
  .cd{display:inline-block;background:#fff;color:#111;border:1px solid #d4af37;border-radius:4px;padding:0 3px;margin:0 1px;font-weight:700;font-size:12px}
  .cd.red{color:#c4161c}
  .chip{display:inline-flex;align-items:center;gap:4px;background:#5a0f12;border:1px solid #d4af37;border-radius:14px;padding:3px 9px;margin:2px;font-size:13px}
  .chip button{background:none;border:0;color:#ffb3b3;cursor:pointer;font-size:14px;padding:0}
  input,select{background:#1d0304;color:#f3e9d2;border:1px solid #d4af3788;border-radius:7px;padding:7px;font-size:14px;width:100%}
  input[type=checkbox]{width:20px;height:20px;accent-color:#d4af37}
  label.ck{display:flex;gap:8px;align-items:center;margin:6px 0}
  .field{margin-bottom:9px}.field>div:first-child{font-size:12px;opacity:.8;margin-bottom:3px}
  table{width:100%;border-collapse:collapse;font-size:12px}
  td,th{padding:4px 3px;border-bottom:1px solid #d4af3733;text-align:left;vertical-align:top}
  th{color:#d4af37;font-weight:600}
  .kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:8px}
  .kpis div{background:#2a0507;border:1px solid #d4af3755;border-radius:8px;padding:5px;text-align:center}
  .kpis b{display:block;font-size:15px}.kpis span{font-size:11px;opacity:.7}
  .log div{padding:4px 0;border-bottom:1px solid #d4af3722;font-size:12px}
  .log b{color:#d4af37}
  .pick{max-height:180px;overflow-y:auto;border:1px solid #d4af3744;border-radius:8px;margin-top:4px}
  .pick div{padding:6px 8px;border-bottom:1px solid #d4af3722;cursor:pointer;font-size:13px}
  .pick div:hover{background:#5a0f12}
  .pager{display:flex;justify-content:space-between;align-items:center;margin-top:6px;font-size:12px}
  .warn{background:#6b4a00;border:1px solid #f2b632;border-radius:8px;padding:6px 8px;font-size:12px;margin-bottom:8px}`;

  const ui = {
    tab: 'play', dirty: true, host: null, root: null, page: { stats: 0, players: 0 }, range: 'session', showPick: false,

    build() {
      if (this.host || !document.body) return;
      this.host = document.createElement('div');
      this.host.id = 'pb-panel';
      document.body.appendChild(this.host);
      this.root = this.host.attachShadow({ mode: 'open' });
      this.root.innerHTML = `<style>${CSS}</style><div class="wrap"></div>`;
      this.wrap = this.root.querySelector('.wrap');
      this.wrap.addEventListener('click', (e) => this.click(e));
      this.wrap.addEventListener('change', (e) => this.change(e));
      this.wrap.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'addt') this.addTable(); e.stopPropagation(); });
      const fit = () => this.fit();
      addEventListener('resize', fit);
      if (window.visualViewport) visualViewport.addEventListener('resize', fit);
      this.render(true);
    },

    // phones show the full desktop table zoomed out – scale the panel back up so it stays readable
    fit() {
      if (!this.wrap) return;
      let f = 1;
      if (PHONE) {
        const vv = window.visualViewport;
        f = vv && vv.scale ? 1 / vv.scale : innerWidth / (screen.width || innerWidth);
        f = Math.max(1, Math.min(4, f));
      }
      this.wrap.style.transform = f === 1 ? '' : `scale(${f})`;
      const p = this.root.querySelector('.panel .body');
      if (p) p.style.maxHeight = Math.round((innerHeight / f) * 0.62) + 'px';
    },

    status() {
      if (otherTab) return ['off', 'running in another tab'];
      if (S.running && seatedNow) return ['on', 'playing' + (S.tableName ? ' – ' + S.tableName : '')];
      if (S.mission) return ['busy', S.phase];
      if (S.running) return ['busy', 'on – waiting for a seat'];
      return ['off', 'stopped'];
    },

    render(force) {
      if (!this.wrap) return;
      const focused = this.root.activeElement && /INPUT|SELECT/.test(this.root.activeElement.tagName);
      if (focused && !force) return;
      const [cls, txt] = this.status();
      if (!cfg.open) {
        this.wrap.innerHTML = `<div class="fab" data-a="open" title="PokerBot">♠<span class="dot ${cls}"></span></div>`;
        this.fit();
        return;
      }
      const tabs = [['play', 'Play'], ['settings', 'Settings'], ['stats', 'Stats'], ['players', 'Players'], ['log', 'Log']];
      const scroll = this.root.querySelector('.body') ? this.root.querySelector('.body').scrollTop : 0;
      this.wrap.innerHTML = `<div class="panel">
        <div class="head"><span class="dot ${cls}"></span><b>♠ PokerBot</b><span class="ph">${esc(txt)}</span>
          <button class="x" data-a="close" title="Minimize">–</button></div>
        <div class="tabs">${tabs.map(([k, n]) => `<button data-tab="${k}" class="${this.tab === k ? 'act' : ''}">${n}</button>`).join('')}</div>
        <div class="body">${this[this.tab]()}</div></div>`;
      const b = this.root.querySelector('.body');
      if (b) b.scrollTop = scroll;
      this.fit();
    },

    play() {
      const g = brain.goal, st = lastSt, hero = PB.heroOf(st);
      let goal = '';
      if (g.start && (g.mult || g.stopLoss)) {
        const prog = g.mult ? Math.max(0, Math.min(1, ((g.chips || g.start) - g.start) / (g.target - g.start || 1))) : 0;
        goal = `<div class="muted" style="margin-top:6px">Started ${money(g.start)}${g.mult ? ` · leave at ${money(g.target)} (${g.mult}×)` : ''}${g.stopLoss ? ` · stop-loss below ${money(g.start * (1 - g.stopLoss))}` : ''}</div>`
             + (g.mult ? `<div class="bar"><i style="width:${Math.round(prog * 100)}%"></i></div>` : '');
      }
      const tables = cfg.tables;
      const lobby = LS.get('lobby', null);
      const pick = this.showPick ? `<div class="pick">${lobby && lobby.rows.length
        ? lobby.rows.map((r) => `<div data-pick="${esc(r.name)}">${esc(r.name)} <span class="muted">· ${esc(r.stakes)} · ${r.players}/${r.max}</span></div>`).join('')
        : '<div class="muted">Open the Kobra lobby once (or press Play) – then the table list shows here.</div>'}</div>` : '';
      const help = !tables.length ? `<div class="warn">How to start: 1) log in to Kobra (tick “Remember password”) · 2) add your tables below · 3) press ▶ Play.<br>Or just sit down at any table and press ▶ Play.</div>` : '';
      const other = otherTab ? '<div class="warn">PokerBot is active in another Kobra tab or window. Close that one to use it here.</div>' : '';
      return `${other}${help}
        <div class="row">
          <button class="btn go" data-a="play" ${S.mission ? 'disabled' : ''}>▶ Play</button>
          <button class="btn stop" data-a="stop" ${!S.mission && !S.running ? 'disabled' : ''}>■ Stop</button>
          <button class="btn" data-a="leave" ${seatedNow ? '' : 'disabled'}>Leave</button>
        </div>
        <div class="card"><div class="kv">
          <span>Status</span><span>${esc(this.status()[1])}</span>
          <span>Table</span><span>${esc((st && st.tableName) || '–')}</span>
          <span>Chips</span><span>${hero ? money(hero.stack + hero.bet) : '–'}</span>
          <span>This session</span><span class="${S.session.net > 0 ? 'pos' : S.session.net < 0 ? 'neg' : ''}">${signed(S.session.net)} · ${S.session.hands} hands</span>
          <span>Style</span><span>${esc(STYLE_TXT[cfg.style])}</span>
        </div>${goal}</div>
        ${lastDecision ? `<div class="card"><b style="color:#d4af37">${esc(lastDecision.did)}</b><div class="muted" style="opacity:.9">${cardChips(lastDecision.reason)}</div></div>` : ''}
        <div class="card"><div style="display:flex;align-items:center;justify-content:space-between"><b style="color:#d4af37">My tables</b>
          <label class="ck" style="margin:0"><input type="checkbox" data-k="autojoin" ${cfg.autojoin ? 'checked' : ''}> sit down by myself</label></div>
          <div class="muted">In this order: the first one with a free seat.</div>
          <div>${tables.map((t, i) => `<span class="chip">${esc(t)}<button data-del="${i}" title="Remove">×</button></span>`).join('') || '<span class="muted">none yet</span>'}</div>
          <div class="row" style="margin-top:6px"><input id="addt" placeholder="Table name or table ID" style="flex:1;width:auto">
            <button class="btn sm" data-a="add">Add</button></div>
          <button class="btn sm" data-a="pick">${this.showPick ? 'Hide table list' : 'Pick from Kobra’s table list'}</button>${pick}
        </div>
        <div class="muted">${PHONE ? 'Keep this tab open and the screen on – phones pause hidden tabs.' : 'F8 starts/stops playing at the current table.'}</div>`;
    },

    settings() {
      const sel = (k, opts) => `<select data-k="${k}">${opts.map(([v, n]) => `<option value="${v}" ${String(cfg[k]) === String(v) ? 'selected' : ''}>${n}</option>`).join('')}</select>`;
      const ck = (k, txt) => `<label class="ck"><input type="checkbox" data-k="${k}" ${cfg[k] ? 'checked' : ''}> ${txt}</label>`;
      return `
        <div class="field"><div>Play style</div>${sel('style', Object.entries(STYLE_TXT))}</div>
        <div class="field"><div>Buy-in when sitting down</div>${sel('buyin', Object.entries(BUYIN_TXT))}</div>
        <div class="field"><div>Leave the table and stop when my chips reach</div>${sel('leaveMult', [[0, 'Never'], [1.5, '1.5× (up 50%)'], [2, '2× (double)'], [3, '3× (triple)']])}</div>
        <div class="field"><div>Stop-loss: leave after losing</div>${sel('stopLoss', [[0, 'Off'], [0.25, '25% of my starting chips'], [0.5, '50%'], [0.75, '75%']])}</div>
        ${ck('leaveWhenFull', 'If every seat is taken, leave after the hand (and join my next table)')}
        <div class="field"><div>Thinking time (seconds, random between)</div>
          <div class="row" style="flex-wrap:nowrap"><input type="number" min="0.3" max="10" step="0.5" data-k="minDelay" value="${cfg.minDelay}">
          <span>to</span><input type="number" min="0.5" max="15" step="0.5" data-k="maxDelay" value="${cfg.maxDelay}"></div></div>
        ${ck('learn', 'Learn how opponents play and adapt')}
        ${ck('wake', 'Keep the screen on while the bot plays')}
        ${PHONE ? ck('desktop', 'Use Kobra’s full table on this phone (needed for the bot)') +
          `<div class="field"><div>Table size on the phone (page width)</div>${sel('width', [[1024, 'Large (1024)'], [1280, 'Normal (1280)'], [1440, 'Small (1440)']])}</div>` : ''}
        ${ck('autoUpdate', 'Update myself automatically')}
        <div class="row" style="margin-top:10px"><button class="btn sm" data-a="resetStats">Clear my stats</button>
          <button class="btn sm" data-a="resetOpp">Forget learned players</button></div>
        <div class="muted" style="margin-top:8px">Version ${esc(VERSION)} · <a href="${esc(HOME)}" target="_blank" style="color:#d4af37">add-on page</a><br>
          Everything stays in this browser. PokerBot never sends your data anywhere and never sees your password.</div>`;
    },

    rangeHands() {
      const t = now();
      if (this.range === 'session') return hands.filter((h) => h.ts >= S.session.start);
      if (this.range === 'today') { const d = new Date(); d.setHours(0, 0, 0, 0); return hands.filter((h) => h.ts >= d / 1000); }
      if (this.range === '7d') return hands.filter((h) => h.ts >= t - 7 * 86400);
      return hands;
    },

    stats() {
      const hs = this.rangeHands();
      const net = hs.reduce((s, h) => s + h.result, 0);
      const won = hs.filter((h) => h.result > 0).length, lost = hs.filter((h) => h.result < 0).length;
      const bbNet = hs.reduce((s, h) => s + (h.bb ? h.result / h.bb : 0), 0);
      const bb100 = hs.length ? (bbNet / hs.length) * 100 : 0;
      const best = hs.reduce((m, h) => Math.max(m, h.result), 0), worst = hs.reduce((m, h) => Math.min(m, h.result), 0);
      const pos = {};
      for (const h of hs) { const p = h.position || '?'; (pos[p] = pos[p] || { n: 0, net: 0 }); pos[p].n++; pos[p].net += h.result; }
      const made = {};
      for (const h of hs) if (h.made) { const k = h.made.split(',')[0]; (made[k] = made[k] || { n: 0, net: 0 }); made[k].n++; made[k].net += h.result; }
      const per = 12, pages = Math.max(1, Math.ceil(hs.length / per));
      const pg = Math.min(this.page.stats, pages - 1);
      const list = hs.slice().reverse().slice(pg * per, pg * per + per);
      const totalActs = Object.values(acts).reduce((a, b) => a + b, 0) || 1;
      const ranges = [['session', 'Session'], ['today', 'Today'], ['7d', '7 days'], ['all', 'All']];
      return `<div class="row">${ranges.map(([k, n]) => `<button class="btn sm" data-range="${k}" style="${this.range === k ? 'background:#d4af37;color:#2a0507' : ''}">${n}</button>`).join('')}</div>
        <div class="kpis">
          <div><b>${hs.length}</b><span>hands</span></div>
          <div><b class="${net > 0 ? 'pos' : net < 0 ? 'neg' : ''}">${signed(net)}</b><span>chips won</span></div>
          <div><b>${bb100.toFixed(1)}</b><span>BB / 100 hands</span></div>
          <div><b class="pos">${won}</b><span>hands won</span></div>
          <div><b class="neg">${lost}</b><span>hands lost</span></div>
          <div><b>${hs.length ? Math.round(won / hs.length * 100) : 0}%</b><span>win rate</span></div>
          <div><b class="pos">${signed(best)}</b><span>biggest win</span></div>
          <div><b class="neg">${signed(worst)}</b><span>biggest loss</span></div>
          <div><b>${Math.round(((acts.raise || 0) + (acts.allin || 0)) / totalActs * 100)}%</b><span>bets/raises</span></div>
        </div>
        ${Object.keys(made).length ? `<div class="card"><b style="color:#d4af37">Hands made</b><table>${Object.entries(made).sort((a, b) => b[1].n - a[1].n)
          .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v.n}×</td><td class="${v.net > 0 ? 'pos' : v.net < 0 ? 'neg' : ''}">${signed(v.net)}</td></tr>`).join('')}</table></div>` : ''}
        ${Object.keys(pos).length ? `<div class="card"><b style="color:#d4af37">By seat position</b><table>${Object.entries(pos).sort((a, b) => b[1].net - a[1].net)
          .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v.n} hands</td><td class="${v.net > 0 ? 'pos' : v.net < 0 ? 'neg' : ''}">${signed(v.net)}</td></tr>`).join('')}</table></div>` : ''}
        <table><tr><th>Cards</th><th>Board / hand</th><th>Result</th></tr>
        ${list.map((h) => `<tr><td>${cardChips(h.cards)}<div class="muted">${esc(h.position || '')}${h.bot ? '' : ' · you'}</div></td>
          <td>${cardChips(h.board || '')}<div class="muted">${esc(h.made || h.street)}</div></td>
          <td class="${h.result > 0 ? 'pos' : h.result < 0 ? 'neg' : ''}">${signed(h.result)}<div class="muted">${new Date(h.ts * 1000).toTimeString().slice(0, 5)}</div></td></tr>`).join('')
          || '<tr><td colspan="3" class="muted">No hands yet.</td></tr>'}</table>
        <div class="pager"><button class="btn sm" data-pg="stats:-1" ${pg ? '' : 'disabled'}>‹ Newer</button>
          <span>page ${pg + 1} of ${pages}</span><button class="btn sm" data-pg="stats:1" ${pg < pages - 1 ? '' : 'disabled'}>Older ›</button></div>`;
    },

    players() {
      const all = oppDB.all(1500);
      const per = 15, pages = Math.max(1, Math.ceil(all.length / per));
      const pg = Math.min(this.page.players, pages - 1);
      return `<div class="muted" style="margin-bottom:6px">${all.length} players seen. After 12 hands a player gets a read and the bot adapts to it.</div>
        <table><tr><th>Player</th><th>Hands</th><th>Plays</th><th>Raises</th><th>Type</th></tr>
        ${all.slice(pg * per, pg * per + per).map((p) => `<tr title="${esc(p.hint)}"><td>${esc(p.name)}</td><td>${p.hands}</td><td>${p.vpip_pct}%</td><td>${p.pfr_pct}%</td>
          <td>${esc(p.type)}<div class="muted">${p.type === 'unknown' ? '' : esc(p.hint)}</div></td></tr>`).join('')
          || '<tr><td colspan="5" class="muted">Nobody yet – the bot learns while it sits at a table.</td></tr>'}</table>
        <div class="pager"><button class="btn sm" data-pg="players:-1" ${pg ? '' : 'disabled'}>‹</button>
          <span>page ${pg + 1} of ${pages}</span><button class="btn sm" data-pg="players:1" ${pg < pages - 1 ? '' : 'disabled'}>›</button></div>`;
    },

    log() {
      return `<div class="log">${logLines.slice(-150).reverse().map((l) => `<div><span class="muted">${esc(l.t)}</span> <b>${esc(l.a)}</b> ${cardChips(l.r)}</div>`).join('')
        || '<div class="muted">Nothing yet.</div>'}</div>`;
    },

    addTable() {
      const inp = this.root.getElementById ? this.root.getElementById('addt') : this.root.querySelector('#addt');
      const v = (inp && inp.value || '').trim();
      if (v && !cfg.tables.some((t) => t.toLowerCase() === v.toLowerCase())) { cfg.tables.push(v); saveCfg(); }
      this.render(true);
    },

    click(e) {
      const el = e.target.closest('[data-a],[data-tab],[data-del],[data-pick],[data-pg],[data-range]');
      if (!el) return;
      e.stopPropagation();
      const a = el.dataset.a;
      if (el.dataset.tab) this.tab = el.dataset.tab;
      else if (el.dataset.del !== undefined) { cfg.tables.splice(+el.dataset.del, 1); saveCfg(); }
      else if (el.dataset.pick) { if (!cfg.tables.includes(el.dataset.pick)) { cfg.tables.push(el.dataset.pick); saveCfg(); } }
      else if (el.dataset.range) { this.range = el.dataset.range; this.page.stats = 0; }
      else if (el.dataset.pg) { const [k, d] = el.dataset.pg.split(':'); this.page[k] = Math.max(0, this.page[k] + +d); }
      else if (a === 'open' || a === 'close') { cfg.open = a === 'open'; saveCfg(); }
      else if (a === 'play') startMission();
      else if (a === 'stop') stopAll();
      else if (a === 'leave') requestLeave();
      else if (a === 'add') return this.addTable();
      else if (a === 'pick') this.showPick = !this.showPick;
      else if (a === 'resetStats') { if (confirm('Clear all recorded hands and stats in this browser?')) { hands = []; LS.set('hands', hands); for (const k in acts) acts[k] = 0; LS.set('acts', acts); S.session = { start: now(), net: 0, hands: 0 }; saveState(); } }
      else if (a === 'resetOpp') { if (confirm('Forget everything the bot learned about other players?')) oppDB.reset(); }
      this.render(true);
    },

    change(e) {
      const k = e.target.dataset.k;
      if (!k) return;
      const t = e.target;
      let v = t.type === 'checkbox' ? t.checked : t.value;
      if (['leaveMult', 'stopLoss', 'minDelay', 'maxDelay', 'width'].includes(k)) v = parseFloat(v) || 0;
      cfg[k] = v;
      saveCfg();
      if (k === 'style') brain.setStyle(v);
      if (k === 'leaveMult') brain.goal.mult = v;
      if (k === 'stopLoss') brain.goal.stopLoss = v;
      if (k === 'learn') { brain.oppDB = v ? oppDB : null; brain.oppTracker = v ? new PB.OpponentTracker(oppDB) : null; }
      if (k === 'wake') updateWake();
      if (k === 'width' || k === 'desktop') setTimeout(() => location.reload(), 300);
      log('SETTINGS', `${k} → ${typeof v === 'boolean' ? (v ? 'on' : 'off') : v}`);
      this.render(true);
    },
  };

  // ------------------------------------------------------------ start
  addEventListener('keydown', (e) => {
    if (e.key === 'F8') { e.preventDefault(); e.stopPropagation(); setRunning(!S.running); ui.dirty = true; }
  }, true);
  window.pokerbot = { start: () => setRunning(true), stop: stopAll, play: startMission, leave: requestLeave, state: S, brain, version: VERSION };

  function boot() {
    ui.build();
    if (S.mission || S.running) log('RESUME', S.mission ? 'carrying on with Play' : 'still playing');
    updateWake();
    startTicker(step, 700);
    setInterval(() => { if (!ui.host || !ui.host.isConnected) { ui.host = null; ui.build(); } ui.render(); }, 1000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

})();
