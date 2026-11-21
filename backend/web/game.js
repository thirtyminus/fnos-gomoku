(() => {
  'use strict';

  const N = 15;
  const EMPTY = 0, BLACK = 1, WHITE = 2;
  const HUMAN = BLACK, AI = WHITE;
  const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];
  const WINDOW_SCORE = [0, 1, 20, 400, 8000, 1000000];

  const API = '/app/gomoku/api';
  const GAME_KEY = 'gomoku.game.v1';
  const STATS_KEY = 'gomoku.stats.v1';
  const LEVEL_KEY = 'gomoku.level.v1';

  const canvas = document.getElementById('board');
  const ctx = canvas.getContext('2d');
  const statusEl = document.getElementById('status');
  const winsEl = document.getElementById('wins');
  const lossesEl = document.getElementById('losses');
  const rankList = document.getElementById('rank-list');
  const overlay = document.getElementById('overlay');
  const resultTitle = document.getElementById('result-title');
  const resultDesc = document.getElementById('result-desc');
  const undoBtn = document.getElementById('undo');
  const restartBtn = document.getElementById('restart');
  const againBtn = document.getElementById('again');
  const closeBtn = document.getElementById('close');
  const levelBtns = Array.from(document.querySelectorAll('[data-level]'));

  let board = new Int8Array(N * N);
  let history = [];            // 落子顺序，元素为 y * N + x
  let turn = HUMAN;
  let finished = false;
  let winLine = null;
  let thinking = false;
  let level = localStorage.getItem(LEVEL_KEY) || 'normal';
  let wins = 0;
  let losses = 0;
  let hover = -1;              // 预览落点，元素为 y * N + x
  let pressing = false;

  const view = { size: 0, cell: 0, pad: 0 };
  const stage = document.querySelector('.stage');
  const boardWrap = canvas.parentElement;

  // ---------- 渲染 ----------

  const px = (i) => view.pad + i * view.cell;

  // 正方形棋盘同时受宽度和可用高度约束，避免窗口偏矮时被截断。
  function layout() {
    const vw = stage.clientWidth || 480;
    const visualH = window.visualViewport && window.visualViewport.height;
    const vh = visualH || document.documentElement.clientHeight || 720;
    const top = boardWrap.offsetTop;
    const appPad = parseFloat(getComputedStyle(document.querySelector('.app')).paddingBottom) || 20;
    const reserved = statusEl.offsetHeight + 12 + appPad + 8;
    const size = Math.max(180, Math.floor(Math.min(vw, vh - top - reserved)));

    if (size === view.size) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.style.width = size + 'px';
    canvas.style.height = size + 'px';
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    view.size = size;
    view.cell = size / N;
    view.pad = view.cell / 2;
    draw();
  }

  function draw() {
    const s = view.size;
    if (!s) return;

    ctx.clearRect(0, 0, s, s);
    ctx.fillStyle = '#d8a95f';
    ctx.fillRect(0, 0, s, s);

    const first = px(0), last = px(N - 1);
    ctx.strokeStyle = 'rgba(72, 44, 12, 0.5)';
    ctx.lineWidth = Math.max(1, s / 700);
    ctx.beginPath();
    for (let i = 0; i < N; i++) {
      const p = px(i);
      ctx.moveTo(first, p);
      ctx.lineTo(last, p);
      ctx.moveTo(p, first);
      ctx.lineTo(p, last);
    }
    ctx.stroke();

    ctx.fillStyle = 'rgba(52, 30, 6, 0.85)';
    for (const [x, y] of [[3, 3], [11, 3], [3, 11], [11, 11], [7, 7]]) {
      ctx.beginPath();
      ctx.arc(px(x), px(y), Math.max(1.5, view.cell * 0.07), 0, Math.PI * 2);
      ctx.fill();
    }

    if (winLine) {
      const a = winLine[0];
      const b = winLine[winLine.length - 1];
      ctx.strokeStyle = 'rgba(232, 70, 58, 0.5)';
      ctx.lineWidth = view.cell * 0.5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(px(a[0]), px(a[1]));
      ctx.lineTo(px(b[0]), px(b[1]));
      ctx.stroke();
      ctx.lineCap = 'butt';
    }

    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const v = board[y * N + x];
        if (v) drawStone(x, y, v);
      }
    }

    const lastMove = history.length ? history[history.length - 1] : -1;
    if (lastMove >= 0 && !winLine) {
      const x = lastMove % N;
      const y = (lastMove / N) | 0;
      ctx.beginPath();
      ctx.arc(px(x), px(y), Math.max(2, view.cell * 0.09), 0, Math.PI * 2);
      ctx.fillStyle = '#ff5a44';
      ctx.fill();
    }

    if (hover >= 0 && !board[hover] && canPlay()) drawPreview(hover);
  }

  // 半透明棋子 + 高亮圆环，提示将要落子的位置
  function drawPreview(idx) {
    const x = idx % N;
    const y = (idx / N) | 0;
    const cx = px(x), cy = px(y), r = view.cell * 0.43;

    ctx.save();
    ctx.globalAlpha = 0.45;
    drawStone(x, y, turn);
    ctx.restore();

    ctx.beginPath();
    ctx.arc(cx, cy, r + Math.max(2, view.cell * 0.08), 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(20, 190, 105, 0.95)';
    ctx.lineWidth = Math.max(2, view.cell * 0.07);
    ctx.stroke();
  }

  function drawStone(x, y, player) {
    const cx = px(x), cy = px(y), r = view.cell * 0.43;
    const g = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.1, cx, cy, r * 1.05);
    if (player === BLACK) {
      g.addColorStop(0, '#5c626c');
      g.addColorStop(1, '#0f1115');
    } else {
      g.addColorStop(0, '#ffffff');
      g.addColorStop(1, '#c9ced6');
    }
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = player === BLACK ? 'rgba(0, 0, 0, 0.45)' : 'rgba(0, 0, 0, 0.16)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // ---------- 规则 ----------

  const inBoard = (x, y) => x >= 0 && y >= 0 && x < N && y < N;

  function findWin(x, y, player) {
    for (const [dx, dy] of DIRS) {
      const cells = [[x, y]];
      for (const sign of [1, -1]) {
        let cx = x + dx * sign;
        let cy = y + dy * sign;
        while (inBoard(cx, cy) && board[cy * N + cx] === player) {
          cells.push([cx, cy]);
          cx += dx * sign;
          cy += dy * sign;
        }
      }
      if (cells.length >= 5) return cells;
    }
    return null;
  }

  function wouldWin(i, player) {
    const x = i % N;
    const y = (i / N) | 0;
    if (board[i]) return false;
    board[i] = player;
    const line = findWin(x, y, player);
    board[i] = EMPTY;
    return !!line;
  }

  function place(x, y, player) {
    const i = y * N + x;
    board[i] = player;
    history.push(i);
    saveGame();

    const line = findWin(x, y, player);
    if (line) {
      winLine = line;
      finished = true;
      draw();
      finish(player === HUMAN ? 'win' : 'loss');
      return;
    }
    if (history.length === N * N) {
      finished = true;
      draw();
      finish('draw');
      return;
    }

    turn = player === HUMAN ? AI : HUMAN;
    draw();
    if (turn === HUMAN) {
      statusEl.textContent = '轮到你了';
      statusEl.className = 'status';
    }
    syncControls();

    if (turn === AI) scheduleAI();
  }

  function finish(result) {
    syncControls();
    if (result === 'win') {
      wins++;
      statusEl.textContent = '你赢了';
      statusEl.className = 'status win';
      resultTitle.textContent = '你赢了';
    } else if (result === 'loss') {
      losses++;
      statusEl.textContent = '你输了';
      statusEl.className = 'status lose';
      resultTitle.textContent = '你输了';
    } else {
      statusEl.textContent = '平局';
      statusEl.className = 'status';
      resultTitle.textContent = '平局';
    }
    resultDesc.textContent = `本局共 ${history.length} 手 · 难度 ${levelName(level)}`;
    renderScore();
    saveStats();
    saveGame();
    postResult(result);
    overlay.hidden = false;
  }

  // ---------- AI ----------

  function candidates() {
    const marks = new Uint8Array(N * N);
    let stones = 0;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        if (!board[y * N + x]) continue;
        stones++;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const nx = x + dx, ny = y + dy;
            if (inBoard(nx, ny) && !board[ny * N + nx]) marks[ny * N + nx] = 1;
          }
        }
      }
    }
    if (!stones) return [7 * N + 7];
    const out = [];
    for (let i = 0; i < marks.length; i++) if (marks[i]) out.push(i);
    return out;
  }

  // 以 (x, y) 放下 player 后的形状分：按四个方向扫 5 格窗口，天然支持跳子棋形。
  function scoreMove(x, y, player) {
    const idx = y * N + x;
    const prev = board[idx];
    board[idx] = player;
    let total = 0;
    for (const [dx, dy] of DIRS) {
      for (let start = -4; start <= 0; start++) {
        let mine = 0;
        let blocked = false;
        for (let k = 0; k < 5; k++) {
          const nx = x + (start + k) * dx;
          const ny = y + (start + k) * dy;
          if (!inBoard(nx, ny)) { blocked = true; break; }
          const v = board[ny * N + nx];
          if (v === EMPTY) continue;
          if (v === player) mine++;
          else { blocked = true; break; }
        }
        if (!blocked) total += WINDOW_SCORE[mine];
      }
    }
    board[idx] = prev;
    return total;
  }

  function pickMove() {
    const cands = candidates();
    for (const i of cands) if (wouldWin(i, AI)) return i;
    for (const i of cands) if (wouldWin(i, HUMAN)) return i;

    const defenseWeight = level === 'easy' ? 0.55 : 0.9;
    const scored = cands.map((i) => {
      const x = i % N;
      const y = (i / N) | 0;
      const attack = scoreMove(x, y, AI);
      const defend = scoreMove(x, y, HUMAN);
      const center = 6 - Math.max(Math.abs(x - 7), Math.abs(y - 7));
      return { i, attack, defend, score: attack + defend * defenseWeight + center * 3 };
    }).sort((a, b) => b.score - a.score);

    if (level === 'easy') {
      const pool = scored.slice(0, Math.min(4, scored.length));
      return pool[Math.floor(Math.random() * pool.length)].i;
    }

    if (level === 'normal') {
      const best = scored[0].score;
      const pool = scored.filter((e) => e.score >= best * 0.97).slice(0, 3);
      return pool[Math.floor(Math.random() * pool.length)].i;
    }

    // 困难：先看自己这一手，再算对手的最佳回应，取净收益最大。
    let bestMove = scored[0].i;
    let bestValue = -Infinity;
    for (const cand of scored.slice(0, 10)) {
      board[cand.i] = AI;
      let reply = 0;
      for (const j of cands) {
        if (board[j]) continue;
        const x = j % N;
        const y = (j / N) | 0;
        const v = scoreMove(x, y, HUMAN) + scoreMove(x, y, AI) * 0.6;
        if (v > reply) reply = v;
      }
      board[cand.i] = EMPTY;
      const value = cand.attack + cand.defend * 0.9 - reply * 0.85;
      if (value > bestValue) {
        bestValue = value;
        bestMove = cand.i;
      }
    }
    return bestMove;
  }

  function scheduleAI() {
    if (finished) return;
    thinking = true;
    statusEl.textContent = '电脑思考中…';
    statusEl.className = 'status';
    syncControls();
    setTimeout(() => {
      if (finished) { thinking = false; return; }
      const move = pickMove();
      thinking = false;
      place(move % N, (move / N) | 0, AI);
    }, 220);
  }

  // ---------- 交互 ----------

  function canPlay() {
    return !finished && !thinking && turn === HUMAN;
  }

  // 把指针位置换算成最近的交叉点；落在棋盘外返回 -1
  function cellAt(event) {
    const rect = canvas.getBoundingClientRect();
    const x = Math.round((event.clientX - rect.left - view.pad) / view.cell);
    const y = Math.round((event.clientY - rect.top - view.pad) / view.cell);
    return inBoard(x, y) ? y * N + x : -1;
  }

  function setHover(idx) {
    const next = idx >= 0 && !board[idx] ? idx : -1;
    if (next === hover) return;
    hover = next;
    draw();
  }

  canvas.addEventListener('pointerdown', (event) => {
    if (!canPlay()) return;
    pressing = true;
    if (canvas.setPointerCapture) canvas.setPointerCapture(event.pointerId);
    setHover(cellAt(event));
  });

  // 按住后可以拖动修正落点；鼠标悬停也直接给预览
  canvas.addEventListener('pointermove', (event) => {
    if (!pressing && event.pointerType !== 'mouse') return;
    if (!canPlay()) { setHover(-1); return; }
    setHover(cellAt(event));
  });

  canvas.addEventListener('pointerup', (event) => {
    if (!pressing) return;
    pressing = false;
    const idx = cellAt(event);
    setHover(-1);
    if (idx < 0 || board[idx] || !canPlay()) return;
    place(idx % N, (idx / N) | 0, HUMAN);
  });

  canvas.addEventListener('pointercancel', () => {
    pressing = false;
    setHover(-1);
  });

  canvas.addEventListener('pointerleave', (event) => {
    if (event.pointerType === 'mouse' && !pressing) setHover(-1);
  });

  undoBtn.addEventListener('click', () => {
    if (finished || thinking || turn !== HUMAN || !history.length) return;
    const plies = history.length % 2 === 0 ? 2 : 1;
    for (let k = 0; k < plies && history.length; k++) {
      board[history.pop()] = EMPTY;
    }
    turn = HUMAN;
    winLine = null;
    hover = -1;
    statusEl.textContent = '轮到你了';
    statusEl.className = 'status';
    draw();
    saveGame();
    syncControls();
  });

  function newGame() {
    board = new Int8Array(N * N);
    history = [];
    turn = HUMAN;
    finished = false;
    winLine = null;
    thinking = false;
    overlay.hidden = true;
    hover = -1;
    pressing = false;
    statusEl.textContent = '点击交叉点落子';
    statusEl.className = 'status';
    draw();
    saveGame();
    syncControls();
  }

  restartBtn.addEventListener('click', newGame);
  againBtn.addEventListener('click', newGame);
  closeBtn.addEventListener('click', () => { overlay.hidden = true; });

  levelBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      level = btn.dataset.level;
      localStorage.setItem(LEVEL_KEY, level);
      renderLevel();
    });
  });

  function renderLevel() {
    levelBtns.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.level === level);
    });
  }

  function syncControls() {
    undoBtn.disabled = finished || thinking || turn !== HUMAN || !history.length;
    canvas.classList.toggle('locked', finished || thinking || turn !== HUMAN);
  }

  function renderScore() {
    winsEl.textContent = String(wins);
    lossesEl.textContent = String(losses);
  }

  const levelName = (v) => ({ easy: '简单', normal: '普通', hard: '困难' }[v] || '普通');

  // ---------- 存档 ----------

  function saveGame() {
    try {
      localStorage.setItem(GAME_KEY, JSON.stringify({
        board: Array.from(board),
        history,
        turn,
        finished,
        level,
      }));
    } catch (err) { /* 隐私模式下忽略 */ }
  }

  function loadGame() {
    try {
      const raw = localStorage.getItem(GAME_KEY);
      if (!raw) return false;
      const saved = JSON.parse(raw);
      if (!Array.isArray(saved.board) || saved.board.length !== N * N) return false;
      board = Int8Array.from(saved.board);
      history = Array.isArray(saved.history) ? saved.history : [];
      turn = saved.turn === AI ? AI : HUMAN;
      finished = !!saved.finished;
      return true;
    } catch (err) {
      return false;
    }
  }

  function saveStats() {
    try {
      localStorage.setItem(STATS_KEY, JSON.stringify({ wins, losses }));
    } catch (err) { /* 忽略 */ }
  }

  function loadStats() {
    try {
      const saved = JSON.parse(localStorage.getItem(STATS_KEY) || '{}');
      wins = saved.wins || 0;
      losses = saved.losses || 0;
    } catch (err) { /* 忽略 */ }
  }

  // ---------- 后端 ----------

  async function api(path, options) {
    const res = await fetch(API + path, options);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  async function refreshMe() {
    try {
      const data = await api('/me');
      wins = data.wins || 0;
      losses = data.losses || 0;
      renderScore();
      saveStats();
    } catch (err) { /* 后端不可用时保留本地战绩 */ }
  }

  async function postResult(result) {
    try {
      const data = await api('/result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ result }),
      });
      wins = data.wins || 0;
      losses = data.losses || 0;
      renderScore();
      saveStats();
      refreshRank();
    } catch (err) { /* 忽略，战绩已存在本地 */ }
  }

  async function refreshRank() {
    try {
      const data = await api('/leaderboard');
      const top = data.top || [];
      if (!top.length) {
        rankList.innerHTML = '<li class="rank-empty">还没有人下过棋</li>';
        return;
      }
      rankList.innerHTML = top.map((row, i) => {
        const who = String(row.user);
        const safe = who.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
        return `<li><span class="who">${i + 1}. ${safe}</span><span class="val">${row.wins} 胜</span></li>`;
      }).join('');
    } catch (err) { /* 忽略 */ }
  }

  // ---------- 启动 ----------

  function init() {
    loadStats();
    renderScore();
    renderLevel();

    const restored = loadGame();
    layout();

    if (restored && finished) {
      statusEl.textContent = '上一局已结束，点「重开」再来';
    } else if (restored && turn === AI) {
      statusEl.textContent = '电脑思考中…';
      scheduleAI();
    } else if (restored && history.length) {
      statusEl.textContent = '轮到你了';
    }
    syncControls();

    refreshMe();
    refreshRank();

    window.addEventListener('resize', layout);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', layout);
    }
    if (window.ResizeObserver) {
      new ResizeObserver(() => layout()).observe(document.body);
    }
  }

  init();
})();
