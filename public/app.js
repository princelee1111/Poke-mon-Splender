'use strict';
/* =========================================================
 * 璀璨宝石：宝可梦 · 前端逻辑
 * ========================================================= */
const COLORS = ['red', 'blue', 'black', 'pink', 'yellow'];
const ALL_COLORS = [...COLORS, 'purple'];
const COLOR_NAMES = { red: '精灵球', blue: '超级球', black: '高级球', pink: '治愈球', yellow: '先机球', purple: '大师球' };
const TIER_NAMES = { stage1: '一阶', stage2: '二阶', stage3: '三阶', rare: '稀有', legend: '传说' };
const AVATARS = ['⚡', '🔥', '💧', '🌿', '🔮', '🪨'];

/* ---------------- 阵营 ---------------- */
const FACTION_META = {
  ash:    { name: '小智与皮卡丘', short: '小智',   poke: '皮卡丘', emoji: '⚡' },
  brock:  { name: '小刚与大岩蛇', short: '小刚',   poke: '大岩蛇', emoji: '🪨' },
  rocket: { name: '火箭队与喵喵', short: '火箭队', poke: '喵喵',   emoji: '😼' },
  misty:  { name: '小霞与可达鸭', short: '小霞',   poke: '可达鸭', emoji: '🦆' },
};
const FACTIONS = Object.keys(FACTION_META);
let selectedFaction = localStorage.getItem('ps_faction');
if (!FACTIONS.includes(selectedFaction)) selectedFaction = 'ash';

function buildFactionPicker() {
  const grid = $('#faction-grid');
  grid.innerHTML = '';
  for (const f of FACTIONS) {
    const m = FACTION_META[f];
    const div = document.createElement('div');
    div.className = 'faction-card' + (f === selectedFaction ? ' selected' : '');
    div.innerHTML = `
      <div class="faction-img" style="background-image:url('assets/bg/${f}-preview.webp?v=20261030g')">
        <span class="faction-emoji">${m.emoji}</span>
      </div>
      <div class="faction-name">${m.name}</div>`;
    div.onclick = () => {
      selectedFaction = f;
      localStorage.setItem('ps_faction', f);
      grid.querySelectorAll('.faction-card').forEach(c => c.classList.remove('selected'));
      div.classList.add('selected');
      // 首页即时预览所选阵营背景
      applyBackground(f);
    };
    grid.appendChild(div);
  }
}

/** 按阵营切换页面背景（无参数则恢复默认主题） */
function applyBackground(faction) {
  document.body.classList.remove('fbg-ash', 'fbg-brock', 'fbg-rocket', 'fbg-misty');
  if (FACTIONS.includes(faction)) document.body.classList.add('fbg-' + faction);
}

function myFaction() {
  // 对局中取自己的玩家阵营；大厅中取座位阵营
  if (state && state.players) {
    const p = state.players.find(x => x.seat === me?.seat);
    if (p && p.faction) return p.faction;
  }
  const s = roomInfo && roomInfo.seats && roomInfo.seats[me?.seat];
  return (s && s.faction) || null;
}

let CARDS = {};
let state = null;          // 当前脱敏游戏状态
let roomInfo = null;       // {code, phase, hostSeat, seats}
let me = null;             // {code, token, seat, name}
let es = null;             // EventSource
let selTokens = {};        // 拿球选择
let catchCtx = null;       // {cardId, preferMaster}
let lastTurnSeq = -1;

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];

/* ---------------- 工具 ---------------- */
function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._tm);
  t._tm = setTimeout(() => t.classList.add('hidden'), ms);
}

function ballHTML(color, size = 24, extra = '') {
  const pb = `--pb: var(--c-${color}); --size: ${size}px`;
  return `<span class="pokeball ${extra}" style="${pb}"></span>`;
}

function costChipsHTML(cost, bonus) {
  let html = '';
  for (const c of ALL_COLORS) {
    const n = cost[c] || 0;
    if (!n) continue;
    let label = `${n}`;
    if (bonus && bonus[c] > 0) label += `<span style="opacity:.65">-${Math.min(bonus[c], n)}</span>`;
    html += `<span class="chip" style="background:var(--c-${c})">${label}</span>`;
  }
  return html;
}

function bonusChipsHTML(bonuses, mini) {
  let html = '';
  for (const c of ALL_COLORS) {
    if (!bonuses[c]) continue;
    html += `<span class="bonus-chip" title="${COLOR_NAMES[c]}×${bonuses[c]}">${ballHTML(c, mini ? 20 : 22)}<span class="n">${bonuses[c]}</span></span>`;
  }
  return html || '<span class="mini-label">暂无折扣</span>';
}

/* ---------------- 支付求解（与服务端一致） ---------------- */
function solvePayment(p, card, preferMaster = false) {
  const bonus = p.bonuses;
  const pay = {}; ALL_COLORS.forEach(c => pay[c] = 0);
  let purpleNeed = card.cost.purple || 0, purpleSub = 0;
  for (const c of COLORS) {
    let need = Math.max(0, (card.cost[c] || 0) - (bonus[c] || 0));
    if (preferMaster) {
      const useM = Math.min(need, p.tokens.purple - purpleSub);
      purpleSub += useM; need -= useM;
    }
    const useT = Math.min(need, p.tokens[c]);
    pay[c] = useT; need -= useT;
    if (need > 0) {
      const useM2 = Math.min(need, p.tokens.purple - purpleSub);
      purpleSub += useM2; need -= useM2;
      if (need > 0) return null;
    }
  }
  pay.purple = purpleNeed + purpleSub;
  if (pay.purple > p.tokens.purple) return null;
  return pay;
}

/* ---------------- 屏幕切换 ---------------- */
function showScreen(id) {
  $$('.screen').forEach(s => s.classList.add('hidden'));
  $(id).classList.remove('hidden');
}

/* ---------------- SSE ---------------- */
function connect() {
  if (es) es.close();
  es = new EventSource(`/api/stream?code=${me.code}&token=${me.token}`);
  // 3 秒内没收到任何状态 → 房间已失效，回到首页
  clearTimeout(connect._guard);
  connect._guard = setTimeout(() => {
    if (!state && roomInfo === null) {
      localStorage.removeItem('ps_me');
      if (es) es.close();
      me = null;
      showScreen('#screen-home');
      showHomeError('房间已失效，请创建或加入新房间');
    }
  }, 3000);
  es.onmessage = ev => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'ping') return;
    if (msg.type === 'state') {
      clearTimeout(connect._guard);
      roomInfo = { code: msg.code, phase: msg.phase, hostSeat: msg.hostSeat, orderMode: msg.orderMode || 'random', seats: msg.seats };
      state = msg.game;
      if (state && state.phase !== 'ended') winnerDismissed = false;
      applyBackground(myFaction() || selectedFaction);
      if (msg.phase === 'lobby') { showScreen('#screen-room'); renderRoom(); }
      else { showScreen('#screen-game'); renderGame(); maybeIntroOrder(); }
    }
  };
  es.onerror = () => { /* EventSource 自动重连 */ };
}

/* ---------------- 首页 ---------------- */
async function api(path, body) {
  const r = await fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || '请求失败');
  return data;
}

function saveMe() { localStorage.setItem('ps_me', JSON.stringify(me)); }
function loadMe() { try { return JSON.parse(localStorage.getItem('ps_me')); } catch { return null; } }

$('#btn-create').onclick = async () => {
  const name = $('#inp-name').value.trim();
  if (!name) return showHomeError('请先输入昵称');
  try {
    const d = await api('/api/room/create', { name, faction: selectedFaction });
    me = { code: d.code, token: d.token, seat: d.seat, name };
    saveMe(); connect();
  } catch (e) { showHomeError(e.message); }
};

$('#btn-join').onclick = async () => {
  const name = $('#inp-name').value.trim();
  const code = $('#inp-code').value.trim().toUpperCase();
  if (!name) return showHomeError('请先输入昵称');
  if (code.length !== 4) return showHomeError('请输入 4 位房间号');
  try {
    const d = await api('/api/room/join', { name, code, token: loadMe()?.token, faction: selectedFaction });
    me = { code: d.code, token: d.token, seat: d.seat, name };
    saveMe(); connect();
  } catch (e) { showHomeError(e.message); }
};

function showHomeError(msg) {
  const el = $('#home-error');
  el.textContent = msg; el.classList.remove('hidden');
}

/* ---------------- 房间 ---------------- */
function renderRoom() {
  $('#room-code').textContent = roomInfo.code;
  const host = roomInfo.hostSeat;
  const amHost = me.seat === host;
  const seatList = $('#seat-list');
  seatList.innerHTML = '';
  for (let i = 0; i < 4; i++) {
    const s = roomInfo.seats[i];
    const div = document.createElement('div');
    div.className = 'seat-item';
    if (s) {
      const fm = FACTION_META[s.faction];
      div.innerHTML = `
        <div class="avatar">${s.isBot ? '🤖' : (fm ? fm.emoji : AVATARS[i] || '🎯')}</div>
        <div class="sname">${escapeHTML(s.name)}</div>
        <div class="stag">
          ${fm ? `<span class="tag-faction tf-${s.faction}">${fm.name}</span>` : ''}
          ${i === host ? '<span class="tag-host">👑 房主</span>' : ''}
          ${s.isBot ? '<span>Bot</span>' : ''}
          ${!s.isBot && !s.connected ? '<span class="tag-off">已断线</span>' : ''}
          ${amHost && i !== host ? `<button class="btn btn-ghost small" data-kick="${i}">移除</button>` : ''}
        </div>`;
    } else {
      div.innerHTML = `<div class="avatar" style="opacity:.4">＋</div><div class="sname muted">空位（等待玩家或添加 Bot）</div>`;
    }
    seatList.appendChild(div);
  }
  seatList.querySelectorAll('[data-kick]').forEach(b => b.onclick = async () => {
    try { await api('/api/room/kick', { code: me.code, token: me.token, seat: +b.dataset.kick }); } catch (e) { toast(e.message); }
  });
  $('#btn-addbot').classList.toggle('hidden', !amHost);
  $('#btn-start').classList.toggle('hidden', !amHost);
  $('#btn-start').disabled = roomInfo.seats.length < 2;
  $('#room-hint').textContent = amHost
    ? (roomInfo.seats.length < 2 ? '至少 2 名玩家才能开始（可添加 Bot）' : '准备好了就点击开始！')
    : '等待房主开始游戏…';
  // 位次弹窗打开时，跟随座位变化同步列表
  if ($('#modal-order') && !$('#modal-order').classList.contains('hidden')) {
    syncOrderDraft();
    renderOrderModal();
  }
}

$('#btn-addbot').onclick = async () => {
  try { await api('/api/room/addBot', { code: me.code, token: me.token }); } catch (e) { toast(e.message); }
};
$('#btn-start').onclick = () => openOrderModal('start');

/* ---------------- 决定先后手（房主可指定或随机） ---------------- */
let orderMode = 'random';      // random | manual
let orderDraft = [];           // seat 索引数组，按位次从上到下
let orderCtx = 'start';        // start | again

function openOrderModal(ctx) {
  orderCtx = ctx;
  orderMode = 'random';
  orderDraft = (roomInfo.seats || []).map((_, i) => i);
  renderOrderModal();
  $('#modal-order').classList.remove('hidden');
}

function syncOrderDraft() {
  const n = (roomInfo.seats || []).length;
  const keep = orderDraft.filter(s => s < n);
  for (let i = 0; i < n; i++) if (!keep.includes(i)) keep.push(i);
  orderDraft = keep;
}

function renderOrderModal() {
  const list = $('#order-list');
  list.dataset.draft = orderDraft.join(',');
  $$('#modal-order .order-mode').forEach(b => b.classList.toggle('active', b.dataset.mode === orderMode));
  if (orderMode === 'random') {
    list.innerHTML = '<div class="order-hint">🎲 点击开始后系统随机打乱座位，并播放换位动画揭晓先手。</div>';
  } else {
    list.innerHTML = `<div class="order-hint">✋ 按列表从上到下为第 1 位 → 第 ${orderDraft.length} 位，用 ▲▼ 调整；第 1 位先手。</div>` +
      orderDraft.map((seat, i) => {
        const s = (roomInfo.seats || [])[seat] || {};
        return `<div class="order-row">
          <span class="order-num${i === 0 ? ' first' : ''}">第 ${i + 1} 位</span>
          <span class="order-name">${escapeHTML(s.name || '-')}${seat === me.seat ? '<i>（你）</i>' : ''}${s.isBot ? '<span class="order-bot">BOT</span>' : ''}</span>
          <span class="order-move">
            <button data-up="${i}" ${i === 0 ? 'disabled' : ''} title="上移">▲</button>
            <button data-down="${i}" ${i === orderDraft.length - 1 ? 'disabled' : ''} title="下移">▼</button>
          </span>
        </div>`;
      }).join('');
    list.querySelectorAll('[data-up]').forEach(b => b.onclick = () => moveOrderSeat(+b.dataset.up, -1));
    list.querySelectorAll('[data-down]').forEach(b => b.onclick = () => moveOrderSeat(+b.dataset.down, 1));
  }
  const btn = $('#btn-order-start');
  btn.textContent = orderCtx === 'again' ? '🔁 开始新一局' : '▶ 开始对战';
  btn.disabled = (roomInfo.seats || []).length < 2;
}

function moveOrderSeat(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= orderDraft.length) return;
  [orderDraft[i], orderDraft[j]] = [orderDraft[j], orderDraft[i]];
  renderOrderModal();
}

$$('#modal-order .order-mode').forEach(b => {
  b.onclick = () => { orderMode = b.dataset.mode; renderOrderModal(); };
});
$('#btn-order-cancel').onclick = () => $('#modal-order').classList.add('hidden');
$('#modal-order').onclick = e => { if (e.target.id === 'modal-order') $('#modal-order').classList.add('hidden'); };
$('#btn-order-start').onclick = async () => {
  const btn = $('#btn-order-start');
  btn.disabled = true;
  try {
    const payload = { code: me.code, token: me.token };
    if (orderMode === 'manual') payload.order = orderDraft.slice();
    await api(orderCtx === 'again' ? '/api/game/again' : '/api/game/start', payload);
    $('#modal-order').classList.add('hidden');
    if (orderCtx === 'again') { winnerDismissed = false; $('#overlay-winner').classList.add('hidden'); }
  } catch (e) {
    toast(e.message || '开始对战失败');
    btn.disabled = false;
  }
};
$('#btn-copy').onclick = () => {
  const txt = `来和我玩《璀璨宝石：宝可梦》！房间号：${roomInfo.code}`;
  navigator.clipboard?.writeText(txt).then(() => toast('邀请已复制！'), () => toast('复制失败，请手动记录房间号'));
};
$('#btn-leave').onclick = async () => {
  await api('/api/room/leave', { code: me.code, token: me.token }).catch(() => {});
  localStorage.removeItem('ps_me');
  if (es) es.close();
  me = null; state = null;
  applyBackground(selectedFaction);   // 回到首页预览所选阵营背景
  showScreen('#screen-home');
};

/* ---------------- 牌桌渲染 ---------------- */
function myPlayer() { return state?.players.find(p => p.seat === me.seat); }
function isMyTurn() { return state && state.phase === 'playing' && state.turn === me.seat && !state.awaiting; }

function renderGame() {
  $('#gh-code').textContent = roomInfo.code;
  renderHeader();
  updateHeaderButtons();
  renderTiers();
  renderSupply();
  renderPlayers();
  renderLog();
  renderModals();
}

function renderHeader() {
  const el = $('#gh-turn');
  if (state.phase === 'ended') {
    el.textContent = '🏁 游戏结束';
    el.className = '';
    return;
  }
  if (state.awaiting) {
    if (state.awaiting.waiting) {
      el.textContent = `${state.awaiting.waiting} 正在结算${state.awaiting.type === 'evolve' ? '进化' : '归还球'}…`;
      el.className = 'wait';
    } else {
      el.textContent = state.awaiting.type === 'evolve' ? '🌟 你的进化回合结束结算' : '⚠️ 请归还多余的球';
      el.className = 'mine';
    }
    return;
  }
  const cur = state.players[state.turn];
  if (state.turn === me.seat) { el.textContent = '🎯 轮到你了！'; el.className = 'mine'; }
  else { el.textContent = `等待 ${cur.name} 行动…`; el.className = 'wait'; }
}

function updateHeaderButtons() {
  // 结束对战：仅房主、对局进行中可见
  $('#btn-endgame').classList.toggle('hidden',
    !(roomInfo && roomInfo.hostSeat === me.seat && state && state.phase === 'playing'));
}

$('#btn-endgame').onclick = async () => {
  if (!confirm('确定结束对战吗？将按当前积分立即结算。')) return;
  try { await api('/api/game/end', { code: me.code, token: me.token }); }
  catch (e) { toast(e.message, 3000); }
};

$('#btn-quit').onclick = async () => {
  const inGame = state && state.phase === 'playing';
  if (!confirm(inGame ? '确定退出房间吗？对战中退出后，你的宝可梦将由 Bot 接管。' : '确定退出房间吗？')) return;
  await api('/api/room/leave', { code: me.code, token: me.token }).catch(() => {});
  localStorage.removeItem('ps_me');
  if (es) es.close();
  me = null; state = null;
  applyBackground(selectedFaction);
  showScreen('#screen-home');
};

/* 宝可梦堆叠溢出时：滚轮纵向滚动转为横向滑动 */
$('#screen-game').addEventListener('wheel', e => {
  const t = e.target.closest('.pm-stacks');
  if (t && t.scrollWidth > t.clientWidth) {
    e.preventDefault();
    t.scrollLeft += e.deltaY + e.deltaX;
  }
}, { passive: false });

const STAGE_TIERS = ['stage3', 'stage2', 'stage1'];

function deckEl(tier) {
  const cnt = state.deckCounts[tier];
  const canRes = isMyTurn() && STAGE_TIERS.includes(tier) &&
    myPlayer().reserved.length < 3 && cnt > 0;
  const deck = document.createElement('div');
  deck.className = `deck deck-${tier} ${cnt === 0 ? 'empty' : ''} ${canRes ? 'clickable' : ''}`;
  deck.innerHTML = `<span>${TIER_NAMES[tier]}</span>${cnt > 0 ? `<span class="count">${cnt}</span>` : ''}`;
  if (canRes) deck.onclick = ev => openDeckMenu(ev, tier);
  return deck;
}

function cardSlot(tier, id, afford) {
  const slot = document.createElement('div');
  slot.className = 'slot';
  if (id) {
    const el = cardEl(CARDS[id], { extra: afford[id] ? 'catchable' : '' });
    el.onclick = ev => openCardMenu(ev, id, 'table', tier);
    slot.appendChild(el);
  } else {
    slot.innerHTML = '<div class="slot-placeholder">已摸完</div>';
  }
  return slot;
}

/* 四行：第一行「稀有牌堆·稀有宝可梦·传说牌堆·传说宝可梦」，其余三行为 三阶/二阶/一阶 */
function renderTiers() {
  const wrap = $('#tiers');
  const p = myPlayer();
  const afford = {};
  if (isMyTurn()) {
    for (const tier of Object.keys(state.table)) {
      for (const id of state.table[tier]) {
        afford[id] = !!solvePayment(p, CARDS[id], false);
      }
    }
  }
  wrap.innerHTML = '';

  // 第一行：与下方各列严格对齐（最后一个占位与第 4 列卡位同宽）
  const top = document.createElement('div');
  top.className = 'tier-row top-row';
  for (const tier of ['rare', 'legend']) {
    top.appendChild(deckEl(tier));
    top.appendChild(cardSlot(tier, state.table[tier][0], afford));
  }
  const spacer = document.createElement('div');
  spacer.className = 'slot-spacer';
  top.appendChild(spacer);
  wrap.appendChild(top);

  // 下方三行：牌堆 + 4 张翻开的卡
  for (const tier of STAGE_TIERS) {
    const row = document.createElement('div');
    row.className = 'tier-row';
    row.appendChild(deckEl(tier));
    const ids = state.table[tier] || [];
    for (let i = 0; i < 4; i++) row.appendChild(cardSlot(tier, ids[i], afford));
    wrap.appendChild(row);
  }
}

function cardEl(card, opts = {}) {
  const div = document.createElement('div');
  div.className = 'pcard' + (opts.extra ? ' ' + opts.extra : '');
  div.dataset.cardId = card.id;
  const bonusTxt = `${COLOR_NAMES[card.bonus]}×${card.bonusCount}`;
  const evo = card.evolvesTo ? `<div>🌟 进化→ <b>${card.evolvesTo}</b>（需 ${card.evoCost.color} 折扣×${card.evoCost.count}）</div>` : '';
  div.innerHTML = `
    <img src="${card.img}" alt="${card.name}" loading="lazy" draggable="false">
    ${card.vp > 0 ? `<span class="vp-badge">${card.vp}</span>` : ''}
    ${card.evolvesTo ? '<span class="evo-badge">可进化</span>' : ''}
    <div class="info-tip">
      <b>${card.name}</b>（${TIER_NAMES[card.tier]}）
      <div>费用：${costChipsHTML(card.cost)} ${card.cost.purple ? ballHTML('purple', 11) + '×' + card.cost.purple : ''}</div>
      <div>折扣：${ballHTML(card.bonus, 11)}<b>×${card.bonusCount}</b></div>
      ${evo}
    </div>`;
  return div;
}

function renderSupply() {
  const box = $('#supply-tokens');
  box.innerHTML = '';
  for (const c of ALL_COLORS) {
    const n = state.supply[c];
    const g = document.createElement('div');
    g.className = 'supply-group' + (n === 0 ? ' out' : '');
    const picked = selTokens[c] || 0;
    if (c === 'purple') {
      g.innerHTML = `<span class="pokeball" style="--pb: var(--c-purple); --size:46px; ${n === 0 ? 'opacity:.3' : ''}"></span>
        <span class="supply-num" title="大师球（万能球）">大师球 ×${n}</span>`;
    } else {
      const clickable = isMyTurn() && n > 0;
      g.innerHTML = `<span class="pokeball ball ${picked ? 'picked' : ''} ${!clickable ? 'dim' : ''}" data-color="${c}"
          style="--pb: var(--c-${c}); --size:46px" title="${COLOR_NAMES[c]}${n > 0 ? '（剩余 ' + n + '）' : '（已拿完）'}"></span>
        <span class="supply-num">${n > 0 ? '×' + n : '无'}</span>
        ${picked ? `<span class="pick-badge">已选 ${picked}</span>` : ''}`;
    }
    box.appendChild(g);
  }
  box.querySelectorAll('.ball').forEach(b => {
    b.onclick = () => pickToken(b.dataset.color);
  });
  // 确认/取消按钮
  const valid = takeSelectionValid();
  const hasSel = Object.values(selTokens).some(v => v > 0);
  $('#btn-take-confirm').classList.toggle('hidden', !(isMyTurn() && hasSel));
  $('#btn-take-cancel').classList.toggle('hidden', !(isMyTurn() && hasSel));
  $('#btn-take-confirm').disabled = !valid;
  $('#btn-take-confirm').textContent = valid ? takeConfirmLabel() : '选择无效';
}

function pickToken(color) {
  if (!isMyTurn() || color === 'purple') return;
  const cur = selTokens[color] || 0;
  if (cur === 0) {
    const distinct = Object.keys(selTokens).filter(c => selTokens[c] > 0);
    if (distinct.length >= 3) return;
    if (distinct.length >= 1 && Object.values(selTokens).some(v => v === 2)) return;
    selTokens[color] = 1;
  } else if (cur === 1) {
    const distinct = Object.keys(selTokens).filter(c => selTokens[c] > 0);
    if (distinct.length === 1 && state.supply[color] >= 4) selTokens[color] = 2;
    else if (distinct.length >= 2) return;
    else selTokens[color] = 2; // 同色第二次（服务端会校验供给）
  } else {
    selTokens[color] = 0;
    if (!selTokens[color]) delete selTokens[color];
  }
  renderSupply();
}

function takeSelectionValid() {
  const entries = Object.entries(selTokens).filter(([, v]) => v > 0);
  if (!entries.length) return false;
  const total = entries.reduce((s, [, v]) => s + v, 0);
  if (total > 3) return false;
  if (entries.length === 1 && total === 2) return state.supply[entries[0][0]] >= 4;
  if (entries.length !== total) return false;
  if (entries.some(([c]) => state.supply[c] < 1)) return false;
  const colorsAvail = COLORS.filter(c => state.supply[c] > 0).length;
  if (total === 3) return colorsAvail >= 3;
  return colorsAvail < 3;
}

function takeConfirmLabel() {
  const entries = Object.entries(selTokens).filter(([, v]) => v > 0);
  if (entries.length === 1 && entries[0][1] === 2) return `拿 2 个${COLOR_NAMES[entries[0][0]]}`;
  return `拿 ${entries.reduce((s, [, v]) => s + v, 0)} 个不同色的球`;
}

$('#btn-take-confirm').onclick = async () => {
  const tokens = {}; for (const [c, v] of Object.entries(selTokens)) if (v > 0) tokens[c] = v;
  await doAction({ type: 'take', tokens });
  selTokens = {};
};
$('#btn-take-cancel').onclick = () => { selTokens = {}; renderSupply(); };

async function doAction(action) {
  try {
    await api('/api/action', { code: me.code, token: me.token, action });
    // 只关闭 UI 局部弹窗（卡牌菜单/捕捉确认）；结算类弹窗（弃球/进化）由
    // renderModals 依据最新状态同步开关——否则归还多个球时弹窗会被误关，
    // 导致无法继续归还（ awaitng 仍在，其它操作全部被拒）。
    $('#modal-card-menu').classList.add('hidden');
    $('#modal-catch').classList.add('hidden');
    if (state) renderModals();
  } catch (e) { toast(e.message, 3000); }
}

/* --- 卡牌菜单 --- */
function openCardMenu(ev, cardId, where, tier) {
  const card = CARDS[cardId];
  const p = myPlayer();
  const myTurn = isMyTurn();
  const canCatch = myTurn && !!solvePayment(p, card, false);
  const canReserve = myTurn && where === 'table' && ['stage1', 'stage2', 'stage3'].includes(tier) && p.reserved.length < 3;
  const box = $('#card-menu-box');
  box.innerHTML = `<div style="padding:4px 8px;font-weight:900">${card.name}</div>`;
  if (canCatch) {
    const b = document.createElement('button');
    b.className = 'btn btn-primary small'; b.textContent = '🎓 捕捉';
    b.onclick = () => { closeAllModals(); openCatchModal(cardId, where); };
    box.appendChild(b);
  }
  if (canReserve) {
    const b = document.createElement('button');
    b.className = 'btn btn-secondary small'; b.textContent = '✋ 保留';
    b.onclick = () => { closeAllModals(); doAction({ type: 'reserve', tier, cardId }); };
    box.appendChild(b);
  }
  const detail = document.createElement('button');
  detail.className = 'btn btn-ghost small'; detail.textContent = 'ℹ 详情';
  detail.onclick = () => { closeAllModals(); openCatchModal(cardId, where, true); };
  box.appendChild(detail);
  if (!canCatch && !canReserve) {
    // 仅查看详情
    closeAllModals(); openCatchModal(cardId, where, true);
    return;
  }
  $('#modal-card-menu').classList.remove('hidden');
  // 定位
  const mw = box.offsetWidth, mh = box.offsetHeight;
  let x = ev.clientX - mw / 2, y = ev.clientY - mh - 14;
  x = Math.max(10, Math.min(window.innerWidth - mw - 10, x));
  if (y < 10) y = ev.clientY + 16;
  box.style.left = x + 'px'; box.style.top = y + 'px';
}

function openDeckMenu(ev, tier) {
  const box = $('#card-menu-box');
  box.innerHTML = `<div style="padding:4px 8px;font-weight:900">${TIER_NAMES[tier]}牌堆</div>`;
  const b = document.createElement('button');
  b.className = 'btn btn-secondary small';
  b.textContent = '✋ 暗抽保留 1 张';
  b.onclick = () => { closeAllModals(); doAction({ type: 'reserve', tier }); };
  box.appendChild(b);
  $('#modal-card-menu').classList.remove('hidden');
  const mw = box.offsetWidth, mh = box.offsetHeight;
  let x = ev.clientX - mw / 2, y = ev.clientY - mh - 14;
  x = Math.max(10, Math.min(window.innerWidth - mw - 10, x));
  if (y < 10) y = ev.clientY + 16;
  box.style.left = x + 'px'; box.style.top = y + 'px';
}

/* --- 捕捉弹窗 --- */
function openCatchModal(cardId, where, viewOnly = false) {
  const card = CARDS[cardId];
  const p = myPlayer();
  catchCtx = { cardId, where, preferMaster: false, viewOnly };
  $('#catch-title').textContent = viewOnly ? '宝可梦详情' : '捕捉宝可梦';
  const pay = p ? solvePayment(p, card, false) : null;
  const bonus = p ? p.bonuses : { red: 0, blue: 0, black: 0, pink: 0, yellow: 0, purple: 0 };
  let info = `<div class="catch-info">
    <div class="cname">${card.name} <span class="muted" style="font-size:12px">${TIER_NAMES[card.tier]}</span></div>
    <div>🏆 胜点：<b>${card.vp}</b> ｜ 折扣：${ballHTML(card.bonus, 13)} <b>×${card.bonusCount}</b></div>
    <div>卡面费用：${costChipsHTML(card.cost)} ${card.cost.purple ? '（含大师球×' + card.cost.purple + '）' : ''}</div>`;
  if (card.evolvesTo) {
    info += `<div>🌟 可进化为 <b>${card.evolvesTo}</b>，需${COLOR_NAMES[card.evoCost.color]}折扣 ×${card.evoCost.count}</div>`;
  }
  if (!viewOnly) {
    // 支付明细
    const rows = [];
    for (const c of ALL_COLORS) {
      const need = card.cost[c] || 0;
      const b = Math.min(bonus[c] || 0, need);
      const direct = pay ? pay[c] : 0;
      if (!need && !b && !direct) continue;
      rows.push(`<div class="pay-row"><span class="pay-label">${COLOR_NAMES[c]}</span>
        需 ${need} － 折扣 ${b} = 支付 <b>${direct}</b> ${ballHTML(c, 14)}</div>`);
    }
    info += `<div style="margin-top:8px;border-top:1px solid var(--line);padding-top:8px">${rows.join('')}</div>`;
    if (!pay) info += `<div class="pay-note">⚠️ 你的球不足以捕捉这只宝可梦</div>`;
    const purpleNeeded = card.cost.purple || 0;
    if (pay && (pay.purple > purpleNeeded || p.tokens.purple > 0)) {
      info += `<label class="toggle-row"><input type="checkbox" id="chk-master"> 优先使用大师球代替普通球（省着点用普通球）</label>`;
    }
  }
  info += '</div>';
  $('#catch-body').innerHTML = `<div class="catch-img"><img src="${card.img}" alt="${card.name}"></div>${info}`;
  $('#btn-catch-confirm').classList.toggle('hidden', viewOnly || !pay);
  if (pay && pay.purple > 0 || (pay && p.tokens.purple > 0)) {
    const chk = $('#chk-master');
    if (chk) chk.onchange = e => {
      const pay2 = solvePayment(p, card, e.target.checked);
      // 更新明细：简单方式——重开弹窗
      catchCtx.preferMaster = e.target.checked;
      openCatchModalRefresh(cardId, where, viewOnly, e.target.checked);
    };
  }
  $('#modal-catch').classList.remove('hidden');
}

function openCatchModalRefresh(cardId, where, viewOnly, preferMaster) {
  const card = CARDS[cardId];
  const p = myPlayer();
  catchCtx = { cardId, where, preferMaster, viewOnly };
  const pay = solvePayment(p, card, preferMaster);
  const bonus = p.bonuses;
  let info = `<div class="catch-info">
    <div class="cname">${card.name}</div>`;
  const rows = [];
  for (const c of ALL_COLORS) {
    const need = card.cost[c] || 0;
    const b = Math.min(bonus[c] || 0, need);
    const direct = pay ? pay[c] : 0;
    if (!need && !b && !direct) continue;
    rows.push(`<div class="pay-row"><span class="pay-label">${COLOR_NAMES[c]}</span>
      需 ${need} － 折扣 ${b} = 支付 <b>${direct}</b> ${ballHTML(c, 14)}</div>`);
  }
  info += `<div style="margin-top:8px">${rows.join('')}</div></div>`;
  $('#catch-body').innerHTML = `<div class="catch-img"><img src="${card.img}"></div>${info}`;
  const chk = `<label class="toggle-row" style="margin:12px 4px 0"><input type="checkbox" id="chk-master" ${preferMaster ? 'checked' : ''}> 优先使用大师球代替普通球</label>`;
  $('#catch-body').insertAdjacentHTML('beforeend', chk);
  $('#chk-master').onchange = e => openCatchModalRefresh(cardId, where, viewOnly, e.target.checked);
  $('#btn-catch-confirm').classList.toggle('hidden', !pay);
}

$('#btn-catch-confirm').onclick = () => {
  if (!catchCtx) return;
  const card = CARDS[catchCtx.cardId];
  const p = myPlayer();
  const pay = solvePayment(p, card, catchCtx.preferMaster);
  if (!pay) return toast('球不够啦！');
  doAction({ type: 'catch', cardId: catchCtx.cardId, pay });
};

$('#btn-catch-cancel').onclick = () => { closeAllModals(); };

/* --- 保留区点击捕捉 --- */
/* --- 玩家面板：按折扣色堆叠展示已捕捉的宝可梦 --- */
function buildStacks(p) {
  const stacks = new Map(); // color -> {cards:[], under:[]}
  for (const id of p.played || []) {
    const c = CARDS[id];
    if (!c) continue;
    if (!stacks.has(c.bonus)) stacks.set(c.bonus, { cards: [], under: [] });
    stacks.get(c.bonus).cards.push(c);
  }
  for (const id of p.under || []) {
    const c = CARDS[id];
    if (!c) continue;
    if (!stacks.has(c.bonus)) stacks.set(c.bonus, { cards: [], under: [] });
    stacks.get(c.bonus).under.push(c);
  }
  for (const s of stacks.values()) s.cards.sort((a, b) => a.vp - b.vp); // 胜点最高的在最上层
  return stacks;
}

function stacksHTML(p, CW = 38, ballSize = 14) {
  const stacks = buildStacks(p);
  if (!stacks.size) return '<div class="pm-stacks"><span class="mini-label">尚未捕捉宝可梦</span></div>';
  let html = '<div class="pm-stacks">';
  for (const [color, s] of stacks) {
    const n = s.cards.length;
    const vpSum = s.cards.reduce((t, c) => t + c.vp, 0);
    const evoN = s.under.length;
    // 上下覆盖，每层露出上半部分（约 42%）
    const CH = Math.round(CW * 747 / 560);
    const step = Math.round(CH * 0.36);
    const H = CH + (n - 1) * step;
    const layers = s.cards.map((c, i) =>
      `<img class="pm-card" src="${c.img}" style="bottom:${i * step}px" title="${escapeHTML(c.name)}（+${c.vp} 胜点）">`).join('');
    const tip = [
      ...s.cards.map(c => `${c.name} +${c.vp}胜点`),
      ...s.under.map(c => `${c.name}（已进化退场）`),
    ].join('；');
    html += `<div class="pm-stack" title="${escapeHTML(tip)}">
      <div class="pm-cards" style="height:${H}px; width:${CW}px">${layers}
        <span class="pm-vp" title="该色宝可梦总胜点">${vpSum}</span>
        ${n > 1 ? `<span class="pm-cnt">×${n}</span>` : ''}
        ${evoN ? `<span class="pm-evo" title="已进化 ${evoN} 次">🌟${evoN}</span>` : ''}
        <span class="pm-ball" title="替代${COLOR_NAMES[color]}×${p.bonuses[color] || 0}">${ballHTML(color, ballSize)}<i>${p.bonuses[color] || 0}</i></span>
      </div>
    </div>`;
  }
  return html + '</div>';
}

/* --- 大展示窗口：查看某玩家的全部捕获/保留卡牌 + 总分 --- */
function openPlayerModal(seatIdx) {
  const p = state.players.find(x => x.seat === seatIdx) || state.players[seatIdx];
  if (!p) return;
  const seatMeta = roomInfo.seats[seatIdx] || {};
  const tokTotal = ALL_COLORS.reduce((s, c) => s + (p.tokens[c] || 0), 0);
  $('#pm-title').innerHTML = `${seatMeta.isBot ? '🤖' : (FACTION_META[p.faction]?.emoji || AVATARS[seatIdx] || '🎯')} ${escapeHTML(p.name)}${p.seat === me.seat ? ' <span class="ptag">(你)</span>' : ''}`;

  // 捕获的宝可梦（按折扣色分组，大图展示；进化的原卡标注）
  const stacks = buildStacks(p);
  let capturedHTML = '';
  if (stacks.size) {
    capturedHTML = [...stacks.entries()].map(([color, s]) => {
      const cardItem = (c, evolved) => `
        <div class="pm-lg-item${evolved ? ' evolved' : ''}">
          <img src="${c.img}" alt="${escapeHTML(c.name)}">
          <div class="pm-lg-cap"><b>${escapeHTML(c.name)}</b><span>+${c.vp} 胜点${evolved ? ' · 已进化' : ''}</span></div>
        </div>`;
      const items = s.cards.map(c => cardItem(c, false)).join('') + s.under.map(c => cardItem(c, true)).join('');
      return `<div class="pm-lg-group">
        <div class="pm-lg-ghead">${ballHTML(color, 18)}<span>${COLOR_NAMES[color]}折扣 ×${p.bonuses[color] || 0}</span><span class="pm-lg-gvp">+${s.cards.reduce((t, c) => t + c.vp, 0)} 分</span></div>
        <div class="pm-lg-grid">${items}</div>
      </div>`;
    }).join('');
  } else {
    capturedHTML = '<div class="pm-lg-empty">尚未捕捉宝可梦</div>';
  }

  // 保留区：自己看真图（可捕捉），别人只显示背面
  let reservedHTML = '';
  if (p.reserved && p.reserved.length) {
    reservedHTML = `<div class="pm-lg-group"><div class="pm-lg-ghead">🂠 保留区<span class="pm-lg-gvp">${p.reserved.length} 张</span></div>
      <div class="pm-lg-grid">` + p.reserved.map(id => {
        const c = CARDS[id];
        const canCatch = p.seat === me.seat;
        return `<div class="pm-lg-item res">
          <img src="${c.img}" alt="${escapeHTML(c.name)}">
          <div class="pm-lg-cap"><b>${escapeHTML(c.name)}</b><span>+${c.vp} 胜点 · 保留中</span></div>
          ${canCatch ? `<button class="btn pm-lg-catch" data-catch="${id}">🎯 捕捉</button>` : ''}
        </div>`;
      }).join('') + `</div></div>`;
  } else if (p.reservedCount) {
    reservedHTML = `<div class="pm-lg-group"><div class="pm-lg-ghead">🂠 保留区<span class="pm-lg-gvp">${p.reservedCount} 张</span></div>
      <div class="pm-lg-grid">${Array(p.reservedCount).fill('<div class="pm-lg-back">🂠</div>').join('')}</div>
      <div class="mini-label" style="margin-top:6px">其他玩家的保留卡为背面，无法查看</div></div>`;
  } else {
    reservedHTML = '<div class="pm-lg-group"><div class="pm-lg-ghead">🂠 保留区</div><div class="pm-lg-empty">保留区为空</div></div>';
  }

  $('#pm-body').innerHTML = `
    <div class="pm-lg-score">
      <div class="pm-lg-score-main"><span class="mini-label">当前总分数</span><b>${p.vp}</b><span class="u">分</span></div>
      <div class="pm-lg-score-sub">
        <span>🐾 宝可梦 ${p.played.length + (p.under ? p.under.length : 0)} 只</span>
        <span>🌟 进化 ${p.evolvedCount || 0} 次</span>
        <span>⚪ 精灵球 ${tokTotal}/10</span>
      </div>
    </div>
    <div class="pm-lg-sec">捕获的宝可梦</div>
    ${capturedHTML}
    ${reservedHTML}`;
  $('#btn-player-close').textContent = '关闭';
  const modal = $('#modal-player');
  modal.classList.remove('hidden');
  modal.onclick = e => { if (e.target.id === 'modal-player') closeAllModals(); };
  modal.querySelectorAll('[data-catch]').forEach(b => {
    b.onclick = () => { closeAllModals(); openCatchModal(b.dataset.catch, 'reserved'); };
  });
}

function buildPlayerPanel(p, idx) {
  const seatMeta = roomInfo.seats[idx] || {};
  const meta = FACTION_META[p.faction];
  const div = document.createElement('div');
  div.className = 'ppanel'
    + (p.seat === me.seat ? ' me' : '')
    + (state.phase === 'playing' && state.turn === p.seat ? ' active' : '');
  // 玩家卡面背景 = 其阵营的训练家剧照
  if (meta) div.style.setProperty('--pbg', `url('assets/bg/${p.faction}.webp?v=20261030g')`);

  const tokHTML = ALL_COLORS.filter(c => p.tokens[c] > 0)
    .map(c => `<span class="tok-count">${ballHTML(c, 18)}${p.tokens[c]}</span>`).join('') || '<span class="mini-label">无球</span>';
  const tokTotal = ALL_COLORS.reduce((s, c) => s + (p.tokens[c] || 0), 0);
  const tokLimit = `<span class="tok-limit ${tokTotal >= 10 ? 'over' : tokTotal >= 8 ? 'warn' : ''}">${tokTotal}/10</span>`;

  let resHTML = '';
  if (p.reserved) {
    resHTML = `<div class="reserved-cards">` + p.reserved.map(id => {
      const c = CARDS[id];
      return `<div class="pcard mine-res" data-res="${id}" style="width:30px"><img src="${c.img}"></div>`;
    }).join('') + `</div>`;
    if (!p.reserved.length) resHTML = `<div class="reserved-cards"><span class="mini-label">保留区为空</span></div>`;
  } else {
    resHTML = `<div class="reserved-cards" data-res-view="1">${p.reservedCount ? Array(p.reservedCount).fill('<div class="reserved-back">🂠</div>').join('') : '<span class="mini-label">保留区为空</span>'}</div>`;
  }

  div.innerHTML = `
    <div class="phead">
      <div class="pav">${seatMeta.isBot ? '🤖' : (meta?.emoji || AVATARS[idx] || '🎯')}</div>
      <div class="pname">${escapeHTML(p.name)}${p.seat === me.seat ? '<span class="ptag"> (你)</span>' : ''}</div>
      ${state.phase === 'playing'
        ? (p.seat === state.starter
          ? '<span class="ptag crown">👑先手</span>'
          : `<span class="ptag porder">第${turnOrder().indexOf(p.seat) + 1}位</span>`)
        : ''}
      <div class="pvp">${p.vp} 分</div>
    </div>
    ${stacksHTML(p, 36, 13)}
    <div class="pfoot">
      <div class="own-row">${tokHTML}${tokLimit}</div>
      ${resHTML}
    </div>`;
  // 点击宝可梦堆叠 / 保留卡 → 大展示窗口
  div.querySelectorAll('.pm-stack').forEach(el => {
    el.onclick = ev => { ev.stopPropagation(); openPlayerModal(p.seat); };
  });
  div.querySelectorAll('[data-res]').forEach(el => {
    el.onclick = ev => { ev.stopPropagation(); openPlayerModal(p.seat); };
  });
  div.querySelectorAll('[data-res-view]').forEach(el => {
    el.onclick = () => openPlayerModal(p.seat);
  });
  return div;
}

function renderPlayers() {
  // 右侧竖排：按行动顺序排列（自己之后的那位紧挨在自己上方），自己在最下方
  const box = $('#players-panel');
  box.innerHTML = '';
  if (!state.players || !state.players.length) {
    box.innerHTML = '<div class="mini-label" style="padding:8px">暂无玩家</div>';
    return;
  }
  const list = panelOrder().map(seat => state.players.find(p => p.seat === seat)).filter(Boolean);
  list.forEach(p => box.appendChild(buildPlayerPanel(p, p.seat)));
}

/** 行动顺序（seat 数组，长度 = 人数）；缺省按座位顺序 */
function turnOrder() {
  const n = state.players.length;
  const ord = state.order;
  if (Array.isArray(ord) && ord.length === n && ord.every(s => s >= 0 && s < n)) return ord;
  return state.players.map((_, i) => i);
}

/** 右侧面板从上到下的顺序：按位次升序循环排列，自己垫底
 *  例：自己是 1 号位（4 人局）→ 从上到下为 2、3、4、自己 */
function panelOrder() {
  const ord = turnOrder();
  const n = ord.length;
  const my = ord.indexOf(me.seat);
  const list = [];
  for (let k = 1; k < n; k++) list.push(ord[(my + k) % n]);   // 下一位 → … 升序循环
  list.push(ord[my]);                                        // 自己始终最下方
  return list;
}

/* ---------------- 开局换位：决定先后手 ---------------- */
let introKey = null;
let introTimers = [];

function clearIntroTimers() { introTimers.forEach(clearTimeout); introTimers = []; }
function introLater(fn, ms) { introTimers.push(setTimeout(fn, ms)); }

/** 新开局（turnSeq === 0）时播放一次换位动画 */
function maybeIntroOrder() {
  if (!state || state.phase !== 'playing' || state.turnSeq !== 0) return;
  const key = `${roomInfo.code}:${(state.log && state.log[0] && state.log[0].t) || 0}:${state.starter}`;
  if (key === introKey) return;
  introKey = key;
  setTimeout(() => { if (state && state.turnSeq === 0 && state.phase === 'playing') playIntroOrder(); }, 80);
}

function playIntroOrder() {
  const n = state.players.length;
  const ord = turnOrder().slice();
  const overlay = $('#intro-order');
  const stage = $('#io-stage');
  const sub = $('#io-sub');
  const foot = $('#io-foot');
  if (!overlay || !stage || n < 2) return;
  clearIntroTimers();

  const manual = state.orderMode === 'manual';   // 房主指定位次：不洗牌，直接排位揭晓
  const w = n >= 4 ? 96 : 112;
  const h = 128;
  const stepW = w + 14;
  stage.style.width = (n * stepW - 14) + 'px';
  stage.style.height = h + 'px';
  stage.innerHTML = '';

  let cur = state.players.map((_, i) => i);   // 换位前：按座位顺序站好
  const cards = new Map();
  cur.forEach((seat, i) => {
    const p = state.players[seat];
    const meta = FACTION_META[p.faction];
    const el = document.createElement('div');
    el.className = 'io-card' + (seat === me.seat ? ' me' : '');
    el.style.width = w + 'px';
    el.style.height = h + 'px';
    el.style.transform = `translateX(${i * stepW}px)`;
    if (meta) el.style.backgroundImage = `url('assets/bg/${p.faction}.webp?v=20261030g')`;
    el.innerHTML = `
      <span class="io-seat">${i + 1}</span>
      <span class="io-crown">👑</span>
      <span class="io-av">${meta?.emoji || AVATARS[seat] || '🎯'}</span>
      <span class="io-name">${escapeHTML(p.name)}${seat === me.seat ? '（你）' : ''}</span>`;
    cards.set(seat, el);
    stage.appendChild(el);
  });

  const place = () => {
    cur.forEach((seat, i) => {
      const el = cards.get(seat);
      el.style.transform = `translateX(${i * stepW}px)`;
      el.querySelector('.io-seat').textContent = i + 1;
    });
  };

  overlay.classList.remove('hidden', 'out');
  sub.textContent = manual ? '房主已指定本局位次' : '训练家们正在换位…';
  foot.textContent = '点击任意处跳过';

  let skipped = false;
  const close = () => {
    clearIntroTimers();
    overlay.classList.add('out');
    introLater(() => overlay.classList.add('hidden'), 340);
  };
  const settle = () => {
    cur = ord.slice();
    place();
    introLater(() => {
      const firstCard = cards.get(ord[0]);
      if (firstCard) firstCard.classList.add('first');
      const first = state.players[ord[0]];
      sub.innerHTML = `先手是 <span class="hi">${escapeHTML(first.name)}</span>！`;
      foot.textContent = '准备开始对战…';
    }, 340);
    introLater(close, skipped ? 900 : 1500);
  };
  overlay.onclick = () => { if (!skipped) { skipped = true; clearIntroTimers(); settle(); } };

  const rounds = n >= 4 ? 6 : 5;
  let k = 0;
  const tick = () => {
    if (k >= rounds) { settle(); return; }
    let a = Math.floor(Math.random() * n), b = Math.floor(Math.random() * n);
    while (b === a) b = Math.floor(Math.random() * n);
    [cur[a], cur[b]] = [cur[b], cur[a]];
    place();
    k++;
    introLater(tick, 260);
  };
  if (manual) introLater(settle, 620);
  else introLater(tick, 280);
}

function renderLog() {
  const seq = state.log.length;
  const last = state.log[seq - 1];
  $('#log-latest').textContent = last ? last.msg : '对战开始';
  $('#log-widget').classList.toggle('open', logOpen);
  $('#game-main').classList.toggle('log-open', logOpen);
  $('#log-body').classList.toggle('hidden', !logOpen);
  $('#log-toggle').textContent = logOpen ? '▴ 收起' : '▾ 展开';
  if (logOpen) {
    const list = $('#log-list');
    list.innerHTML = state.log.map((l, i) =>
      `<div class="${i === seq - 1 ? 'new' : ''}">${escapeHTML(l.msg)}</div>`).join('');
    list.scrollTop = list.scrollHeight;
  }
}

let logOpen = false;
$('#log-bar').onclick = () => { logOpen = !logOpen; renderLog(); };

/* --- 进化 / 弃球 / 胜利 弹窗 --- */
function renderModals() {
  const aw = state.awaiting;
  // 进化
  const evolveModal = $('#modal-evolve');
  const discardModal = $('#modal-discard');
  const winOverlay = $('#overlay-winner');
  if (state.phase === 'ended') {
    evolveModal.classList.add('hidden');
    discardModal.classList.add('hidden');
    showWinner();
    return;
  }
  winOverlay.classList.add('hidden');
  if (aw && aw.type === 'evolve') {
    if (aw.options) {
      const box = $('#evolve-options');
      box.innerHTML = '';
      aw.options.forEach(o => {
        const from = CARDS[o.fromId], to = CARDS[o.targetId];
        const div = document.createElement('div');
        div.className = 'evo-opt';
        div.innerHTML = `
          <img src="${from.img}" title="${from.name}">
          <span class="evo-arrow">➜</span>
          <img src="${to.img}" title="${to.name}">
          <div class="evo-desc"><b>${from.name}</b> → <b>${to.name}</b><br>
          🏆 胜点 ${from.vp} → <b>${to.vp}</b>（需${COLOR_NAMES[from.evoCost.color]}折扣×${from.evoCost.count}，已满足）<br>
          <span class="muted">来源：${o.source === 'table' ? '场上' : '你的保留区'}</span></div>`;
        div.onclick = () => doAction({ type: 'evolve', fromId: o.fromId, targetId: o.targetId });
        box.appendChild(div);
      });
      evolveModal.classList.remove('hidden');
    } else {
      evolveModal.classList.add('hidden');
    }
  } else {
    evolveModal.classList.add('hidden');
  }
  // 弃球
  if (aw && aw.type === 'discard') {
    if (aw.count !== undefined) {
      $('#discard-count').textContent = aw.count;
      const p = myPlayer();
      const box = $('#discard-tokens');
      box.innerHTML = '';
      for (const c of ALL_COLORS) {
        for (let i = 0; i < p.tokens[c]; i++) {
          const b = document.createElement('span');
          b.className = 'pokeball ball';
          b.style.cssText = `--pb: var(--c-${c}); --size: 30px`;
          b.title = COLOR_NAMES[c];
          b.onclick = () => doAction({ type: 'discardToken', color: c });
          box.appendChild(b);
        }
      }
      discardModal.classList.remove('hidden');
    } else {
      discardModal.classList.add('hidden');
    }
  } else {
    discardModal.classList.add('hidden');
  }
}

function showWinner() {
  const w = state.winner;
  if (!w) return;
  $('#winner-text').textContent = `🏆 ${w.names.join('、')} 获胜！`;
  const rank = state.players.slice().sort((a, b) => b.vp - a.vp || b.evolvedCount - a.evolvedCount ||
    (b.played.length + b.underCount) - (a.played.length + a.underCount));
  $('#winner-detail').textContent = '平局判定：胜点 → 进化数 → 宝可梦数';
  $('#final-board').innerHTML = rank.map(p => `
    <div class="frow ${w.names.includes(p.name) ? 'win' : ''}">
      <span>${escapeHTML(p.name)}${p.seat === me.seat ? '（你）' : ''}</span>
      <span><b>${p.vp}</b> 分 · 进化 ${p.evolvedCount} · 宝可梦 ${p.played.length + p.underCount}</span>
    </div>`).join('');
  // 按钮状态：再来一局仅房主可用；查看牌桌可随时关闭弹窗
  const amHost = roomInfo && roomInfo.hostSeat === me.seat;
  $('#btn-again').classList.toggle('hidden', !amHost);
  $('#btn-again').disabled = false;
  $('#overlay-winner').classList.toggle('hidden', winnerDismissed);
}

let winnerDismissed = false;

async function rematch() {
  if (!roomInfo) return;
  // 由房主决定：随机换位 或 沿用手动位次
  openOrderModal('again');
}

$('#btn-again').onclick = rematch;
$('#btn-view-table').onclick = () => { winnerDismissed = true; $('#overlay-winner').classList.add('hidden'); };

function closeAllModals() {
  $$('.modal').forEach(m => m.classList.add('hidden'));
}

/* 点击遮罩关闭卡牌菜单 */
$('#modal-card-menu').onclick = e => { if (e.target.id === 'modal-card-menu') closeAllModals(); };
$('#modal-catch').onclick = e => { if (e.target.id === 'modal-catch') closeAllModals(); };

function escapeHTML(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- 启动 ---------------- */
async function init() {
  const data = await fetch('/data/cards.json?v=20261030d').then(r => r.json());
  CARDS = Object.fromEntries(data.map(c => [c.id, c]));
  buildFactionPicker();
  applyBackground(selectedFaction);   // 首页默认预览所选阵营背景
  const saved = loadMe();
  if (saved && saved.code && saved.token) {
    me = saved;
    connect();
  } else {
    showScreen('#screen-home');
  }
}
init();
