'use strict';
/**
 * 《璀璨宝石：宝可梦》游戏引擎（纯逻辑，Node 通用）
 * 规则依据：Pokemon Splendor English Rulebook v1.1
 * - 6 种球：red 精灵球 / blue 超级球 / black 高级球 / pink 治愈球 / yellow 先机球 / purple 大师球(万能)
 * - 行动：拿3个不同色 / 拿2个同色(供给≥4) / 保留1张+1大师球(手牌上限3) / 捕捉1张宝可梦
 * - 稀有/传说卡必须支付至少 1 个大师球；两者 bonusCount=2
 * - 进化：回合结束、弃球检查之后，每回合至多 1 次，只看已捕捉卡折扣，不消耗
 * - 10 球上限（回合结束时）；18 分触发本轮结束；平局比进化数→场上宝可梦数
 */
const fs = require('fs');
const path = require('path');

const COLORS = ['red', 'blue', 'black', 'pink', 'yellow'];
const ALL_COLORS = ['red', 'blue', 'black', 'pink', 'yellow', 'purple'];
const COLOR_NAMES = { red: '精灵球', blue: '超级球', black: '高级球', pink: '治愈球', yellow: '先机球', purple: '大师球' };
const TIER_NAMES = { stage1: '一阶', stage2: '二阶', stage3: '三阶', rare: '稀有', legend: '传说' };
const WIN_VP = 18;
const TOKEN_LIMIT = 10;
const RESERVE_LIMIT = 3;
const TABLE_ROWS = { stage1: 4, stage2: 4, stage3: 4, rare: 1, legend: 1 };

const CARDS = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'cards.json'), 'utf-8'));
const CARD_BY_ID = Object.fromEntries(CARDS.map(c => [c.id, c]));
const CARDS_BY_TIER = {};
for (const c of CARDS) (CARDS_BY_TIER[c.tier] = CARDS_BY_TIER[c.tier] || []).push(c);

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function zeroTokens() {
  const t = {};
  for (const c of ALL_COLORS) t[c] = 0;
  return t;
}

/**
 * 创建一局新游戏。playerNames: [{name, isBot}] 2-4 人
 * order: 可选的行动顺序（seat 索引数组，长度需等于人数）；缺省按座位 0..n-1
 */
function createGame(seats, order) {
  const n = seats.length;
  if (n < 2 || n > 4) throw new Error('玩家数必须为 2-4 人');
  const ord = (Array.isArray(order) && order.length === n && new Set(order).size === n)
    ? order.slice() : seats.map((_, i) => i);
  const removePerColor = n === 2 ? 3 : n === 3 ? 2 : 0;
  const supply = zeroTokens();
  for (const c of COLORS) supply[c] = 7 - removePerColor;
  supply.purple = 5;

  const decks = {};
  for (const tier of Object.keys(TABLE_ROWS)) decks[tier] = shuffle(CARDS_BY_TIER[tier].map(c => c.id));

  const table = {};
  for (const tier of Object.keys(TABLE_ROWS)) {
    table[tier] = [];
    for (let i = 0; i < TABLE_ROWS[tier] && decks[tier].length; i++) table[tier].push(decks[tier].shift());
  }

  const players = seats.map((s, i) => ({
    seat: i,
    name: s.name,
    isBot: !!s.isBot,
    faction: s.faction || null,   // 阵营：ash | brock | rocket | misty
    tokens: zeroTokens(),
    reserved: [],       // cardIds（仅自己可见）
    played: [],         // cardIds（已捕捉，明置）
    under: [],          // cardIds（进化后退下的卡，暗置）
    vp: 0,
    bonuses: zeroTokens(),
    evolvedCount: 0,
  }));

  return {
    supply, decks, table, players,
    turn: ord[0],               // 当前行动玩家 seat
    starter: ord[0],            // 起始玩家 seat
    order: ord,                 // 行动顺序（seat 索引数组）
    endPending: false,          // 有人达到 18 分，本轮结束后终局
    phase: 'playing',           // playing | ended
    awaiting: null,             // {type:'discard',count} | {type:'evolve',options}
    evolveDoneThisTurn: false,     // 本回合的进化机会是否已用完（每回合最多进化 1 次）
    winner: null,
    log: [{
      t: Date.now(),
      msg: `🎲 换位完成，行动顺序：${ord.map(i => seats[i].name).join(' → ')}。${seats[ord[0]].name} 先手，率先达到 18 胜点的训练家将获得胜利！`,
    }],
    turnSeq: 0,
  };
}

function addLog(g, msg) {
  g.log.push({ t: Date.now(), msg });
  if (g.log.length > 120) g.log.splice(0, g.log.length - 120);
}

function tokenCount(p) { return ALL_COLORS.reduce((s, c) => s + p.tokens[c], 0); }

/** 折扣总数（稀有/传说卡按 2 计） */
function bonusesOf(p) {
  const b = zeroTokens();
  for (const id of p.played) {
    const c = CARD_BY_ID[id];
    b[c.bonus] += c.bonusCount;
  }
  return b;
}

function recalcPlayer(p) {
  p.bonuses = bonusesOf(p);
  p.vp = p.played.reduce((s, id) => s + CARD_BY_ID[id].vp, 0);
}

function refill(g, tier) {
  while (g.table[tier].length < TABLE_ROWS[tier] && g.decks[tier].length) {
    g.table[tier].push(g.decks[tier].shift());
  }
}

function removeCard(g, tier, cardId) {
  const idx = g.table[tier].indexOf(cardId);
  if (idx >= 0) { g.table[tier].splice(idx, 1); refill(g, tier); return true; }
  return false;
}

/** 供客户端的合法动作描述（用于 UI 提示） */
function canTakeTokens(g, p, pick) {
  // pick: {red:..,..} 意向
  const keys = Object.keys(pick).filter(c => pick[c] > 0);
  if (keys.some(c => c === 'purple' || pick[c] < 0)) return false;
  const total = keys.reduce((s, c) => s + pick[c], 0);
  if (total > 3) return false;
  if (keys.length === 1 && total === 2) {
    return g.supply[keys[0]] >= 4;
  }
  // 全部不同色，1~3 个
  if (keys.length !== total) return false;
  if (keys.some(c => g.supply[c] < pick[c])) return false;
  const colorsAvail = COLORS.filter(c => g.supply[c] > 0).length;
  if (total === 3) return colorsAvail >= 3;
  return colorsAvail < 3; // 只有供给不足 3 色时才允许拿 2 或 1 个
}

/** 计算捕捉某卡的自动支付方案（最少大师球占用），可行返回支付 map，否则 null */
function solvePayment(p, card, preferMaster = false) {
  const bonus = p.bonuses;
  const pay = zeroTokens();
  let purpleNeed = card.cost.purple || 0;
  let purpleSub = 0;
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
  const purpleTotal = purpleNeed + purpleSub;
  if (purpleTotal > p.tokens.purple) return null;
  pay.purple = purpleTotal;
  return pay;
}

function canCatch(g, p, card) { return !!solvePayment(p, card, false); }

/** 捕捉来源：table 某行 或 自己 reserved */
function findCatchable(g, p, cardId) {
  for (const tier of Object.keys(g.table)) {
    if (g.table[tier].includes(cardId)) return { where: 'table', tier };
  }
  if (p.reserved.includes(cardId)) return { where: 'reserved' };
  return null;
}

/** 供玩家选择的进化项 */
function evolutionOptions(g, p) {
  const opts = [];
  for (const id of p.played) {
    const card = CARD_BY_ID[id];
    if (!card.evolvesTo || !card.evoCost) continue;
    // 找场上或自己保留区中的下一阶卡（按名字匹配）
    // 保留区已有同名目标时只提供保留区那份，避免同一 targetId 出现两个来源
    const hasReservedTarget = p.reserved.some(rid => CARD_BY_ID[rid].name === card.evolvesTo);
    for (const tier of Object.keys(g.table)) {
      for (const tid of g.table[tier]) {
        const t = CARD_BY_ID[tid];
        if (hasReservedTarget && t.name === card.evolvesTo) continue;
        if (t.name === card.evolvesTo && meetsEvo(p, card, t)) {
          opts.push({ fromId: id, targetId: tid, source: 'table', tier });
        }
      }
    }
    for (const rid of p.reserved) {
      const t = CARD_BY_ID[rid];
      if (t.name === card.evolvesTo && meetsEvo(p, card, t)) {
        opts.push({ fromId: id, targetId: rid, source: 'reserved' });
      }
    }
  }
  return opts;
}

function meetsEvo(p, fromCard, target) {
  const b = p.bonuses;
  const ec = fromCard.evoCost;
  return (b[ec.color] || 0) >= ec.count;
}

/** 应用一个动作。返回 {ok, error?}。动作:
 *  {type:'take', tokens:{...}}
 *  {type:'reserve', tier, cardId?}  cardId 省略=从牌堆顶暗抽
 *  {type:'catch', cardId, pay:{...}, preferMaster?}  pay 可省略（服务端自动求解）
 *  {type:'discardToken', color}   （弃球阶段）
 *  {type:'evolve', fromId, targetId} / {type:'skipEvolve'}
 */
function applyAction(g, seat, action) {
  const p = g.players[seat];
  if (g.phase !== 'playing') return { ok: false, error: '游戏已结束' };
  if (g.awaiting) {
    if (g.awaiting.type === 'discard') {
      if (action.type !== 'discardToken') return { ok: false, error: '请先归还多余的球' };
      const c = action.color;
      if (!ALL_COLORS.includes(c) || p.tokens[c] <= 0) return { ok: false, error: '没有该颜色的球' };
      p.tokens[c]--; g.supply[c]++;
      const cnt = tokenCount(p);
      addLog(g, `${p.name} 归还了 1 个${COLOR_NAMES[c]}（${cnt}/10）`);
      if (cnt <= TOKEN_LIMIT) afterTurnCleanup(g, seat);
      return { ok: true };
    }
    if (g.awaiting.type === 'evolve') {
      if (action.type === 'skipEvolve') {
        addLog(g, `${p.name} 选择不进化`);
        g.evolveDoneThisTurn = true; // 本回合进化机会已用完，不再重复询问
        afterTurnCleanup(g, seat);
        return { ok: true };
      }
      if (action.type !== 'evolve') return { ok: false, error: '请选择进化或跳过' };
      const opt = g.awaiting.options.find(o => o.fromId === action.fromId && o.targetId === action.targetId);
      if (!opt) return { ok: false, error: '无效的进化选择' };
      doEvolve(g, p, opt);
      afterTurnCleanup(g, seat);
      return { ok: true };
    }
    return { ok: false, error: '存在待处理的结算' };
  }
  if (seat !== g.turn) return { ok: false, error: '还没到你的回合' };

  switch (action.type) {
    case 'take': {
      const pick = action.tokens || {};
      if (!canTakeTokens(g, p, pick)) return { ok: false, error: '拿球方式不合法（3个不同色 / 2个同色且供给≥4 / 供给不足时少拿；不能拿大师球）' };
      for (const c of Object.keys(pick)) { if (pick[c] > 0) { g.supply[c] -= pick[c]; p.tokens[c] += pick[c]; } }
      const desc = Object.keys(pick).filter(c => pick[c] > 0).map(c => `${pick[c]}个${COLOR_NAMES[c]}`).join('、');
      addLog(g, `${p.name} 拿取了 ${desc}`);
      return endTurn(g, seat);
    }
    case 'reserve': {
      const tier = action.tier;
      if (!['stage1', 'stage2', 'stage3'].includes(tier)) return { ok: false, error: '只能保留普通等级的宝可梦卡（不能保留稀有/传说）' };
      if (p.reserved.length >= RESERVE_LIMIT) return { ok: false, error: '保留区已满（最多 3 张）' };
      let cardId;
      if (action.cardId) {
        if (!g.table[tier].includes(action.cardId)) return { ok: false, error: '该卡不在场上' };
        cardId = action.cardId;
        g.table[tier].splice(g.table[tier].indexOf(cardId), 1);
        refill(g, tier);
      } else {
        if (!g.decks[tier].length) return { ok: false, error: '该牌堆已空' };
        cardId = g.decks[tier].shift();
      }
      p.reserved.push(cardId);
      let extra = '';
      if (g.supply.purple > 0) { g.supply.purple--; p.tokens.purple++; extra = '，并获得 1 个大师球'; }
      else extra = '（供给中已无大师球）';
      addLog(g, `${p.name} 保留了一张${TIER_NAMES[tier]}宝可梦${extra}`);
      return endTurn(g, seat);
    }
    case 'catch': {
      const loc = findCatchable(g, p, action.cardId);
      if (!loc) return { ok: false, error: '该卡不在场上也不在你的保留区' };
      const card = CARD_BY_ID[action.cardId];
      const pay = action.pay || solvePayment(p, card, !!action.preferMaster);
      if (!pay) return { ok: false, error: '球不够，无法捕捉这只宝可梦' };
      // 精确校验：每色 direct 支付不得超过该色净需求，不足部分由大师球补足，
      // 大师球总数 = 各色缺口 + 卡面大师球要求（不多付、不浪费）
      let purpleNeeded = card.cost.purple || 0;
      for (const c of COLORS) {
        const need = Math.max(0, (card.cost[c] || 0) - (p.bonuses[c] || 0));
        const direct = pay[c] || 0;
        if (direct < 0 || direct > need) return { ok: false, error: '支付数量不合法' };
        if (direct > p.tokens[c]) return { ok: false, error: '支付超过了你拥有的球' };
        purpleNeeded += need - direct;
      }
      if ((pay.purple || 0) !== purpleNeeded) return { ok: false, error: '大师球支付数量不正确' };
      if (pay.purple > p.tokens.purple) return { ok: false, error: '大师球不够' };
      // 扣除支付
      for (const c of ALL_COLORS) { p.tokens[c] -= (pay[c] || 0); g.supply[c] += (pay[c] || 0); }
      // 卡片归属
      if (loc.where === 'table') {
        g.table[loc.tier].splice(g.table[loc.tier].indexOf(card.id), 1);
        refill(g, loc.tier);
      } else {
        p.reserved.splice(p.reserved.indexOf(card.id), 1);
      }
      p.played.push(card.id);
      recalcPlayer(p);
      addLog(g, `${p.name} 捕捉了 ${card.name}（+${card.vp} 胜点）`);
      // 检查 18 分
      if (p.vp >= WIN_VP && !g.endPending) {
        g.endPending = true;
        addLog(g, `⚡ ${p.name} 达到 ${p.vp} 胜点！本轮结束后游戏终了（每人再行动相同次数）`);
      }
      return endTurn(g, seat);
    }
    default:
      return { ok: false, error: '未知动作' };
  }
}

function endTurn(g, seat) {
  const p = g.players[seat];
  const cnt = tokenCount(p);
  if (cnt > TOKEN_LIMIT) {
    g.awaiting = { type: 'discard', count: cnt - TOKEN_LIMIT };
    addLog(g, `${p.name} 超过了 10 球上限，需归还 ${cnt - TOKEN_LIMIT} 个球`);
    return { ok: true };
  }
  const opts = g.evolveDoneThisTurn ? [] : evolutionOptions(g, p);
  if (opts.length) {
    g.awaiting = { type: 'evolve', options: opts };
    return { ok: true };
  }
  nextTurn(g);
  return { ok: true };
}

function afterTurnCleanup(g, seat) {
  const p = g.players[seat];
  if (tokenCount(p) > TOKEN_LIMIT) {
    g.awaiting = { type: 'discard', count: tokenCount(p) - TOKEN_LIMIT };
    return;
  }
  // 每回合最多进化 1 次：本回合已进化则直接结束回合
  const opts = g.evolveDoneThisTurn ? [] : evolutionOptions(g, p);
  if (opts.length) {
    g.awaiting = { type: 'evolve', options: opts };
    return;
  }
  nextTurn(g);
}

function doEvolve(g, p, opt) {
  const from = CARD_BY_ID[opt.fromId];
  const target = CARD_BY_ID[opt.targetId];
  // 移除来源
  p.played.splice(p.played.indexOf(opt.fromId), 1);
  p.under.push(opt.fromId);
  p.evolvedCount++;
  // 目标：场上或保留区 → 打出
  if (opt.source === 'table') {
    const tier = Object.keys(g.table).find(t => g.table[t].includes(opt.targetId));
    g.table[tier].splice(g.table[tier].indexOf(opt.targetId), 1);
    refill(g, tier);
  } else {
    p.reserved.splice(p.reserved.indexOf(opt.targetId), 1);
  }
  p.played.push(opt.targetId);
  g.evolveDoneThisTurn = true;   // 本回合已进化，禁止再次进化
  recalcPlayer(p);
  addLog(g, `🌟 ${p.name} 将 ${from.name} 进化为 ${target.name}（+${target.vp - from.vp} 胜点）`);
  if (p.vp >= WIN_VP && !g.endPending) {
    g.endPending = true;
    addLog(g, `⚡ ${p.name} 达到 ${p.vp} 胜点！本轮结束后游戏终了`);
  }
}

/** 按行动顺序取下一个座位 */
function nextSeatOf(g, seat) {
  const ord = g.order || g.players.map((_, i) => i);
  const i = ord.indexOf(seat);
  return ord[(i + 1) % ord.length];
}

function nextTurn(g) {
  // 终局判断：endPending 且即将轮到 starter（即所有人都行动了相同次数）
  const nextSeat = nextSeatOf(g, g.turn);
  if (g.endPending && nextSeat === g.starter) {
    finishGame(g);
    return;
  }
  g.turn = nextSeat;
  g.awaiting = null;
  g.evolveDoneThisTurn = false;  // 新回合重置进化次数
  g.turnSeq++;
}

function finishGame(g) {
  g.phase = 'ended';
  let best = g.players.slice().sort((a, b) =>
    b.vp - a.vp || b.evolvedCount - a.evolvedCount || (b.played.length + b.under.length) - (a.played.length + a.under.length)
  );
  // 平局共享判定
  const top = best[0];
  const tied = g.players.filter(x => x.vp === top.vp && x.evolvedCount === top.evolvedCount &&
    (x.played.length + x.under.length) === (top.played.length + top.under.length));
  g.winner = { seats: tied.map(x => x.seat), names: tied.map(x => x.name) };
  addLog(g, `🏁 游戏结束！胜者：${g.winner.names.join('、')}（${top.vp} 胜点）`);
}

/** 脱敏视图：seat=-1 观战；其余只看自己的保留牌 */
function sanitize(g, seat, roomInfo) {
  const view = {
    phase: g.phase,
    supply: g.supply,
    deckCounts: Object.fromEntries(Object.keys(g.decks).map(t => [t, g.decks[t].length])),
    table: g.table,
    turn: g.turn,
    starter: g.starter,
    order: g.order || g.players.map((_, i) => i),
    turnNo: (g.order || []).indexOf(g.turn) + 1,
    endPending: g.endPending,
    awaiting: null,
    players: g.players.map(p => ({
      seat: p.seat, name: p.name, isBot: p.isBot, faction: p.faction || null,
      tokens: p.tokens, vp: p.vp,
      bonuses: p.bonuses,
      played: p.played,
      under: p.under,
      underCount: p.under.length,
      evolvedCount: p.evolvedCount,
      reservedCount: p.reserved.length,
      reserved: p.seat === seat ? p.reserved : undefined,
    })),
    winner: g.winner,
    log: g.log.slice(-40),
    turnSeq: g.turnSeq,
  };
  if (g.awaiting && g.awaiting.type === 'evolve') {
    const opts = g.awaiting.options;
    view.awaiting = (g.turn === seat)
      ? { type: 'evolve', options: opts.map(o => ({ fromId: o.fromId, targetId: o.targetId, source: o.source })) }
      : { type: 'evolve', waiting: g.players[g.turn].name };
  } else if (g.awaiting && g.awaiting.type === 'discard') {
    view.awaiting = (g.turn === seat)
      ? { type: 'discard', count: g.awaiting.count }
      : { type: 'discard', waiting: g.players[g.turn].name };
  }
  return Object.assign({}, roomInfo || {}, view);
}

module.exports = {
  COLORS, ALL_COLORS, COLOR_NAMES, TIER_NAMES, WIN_VP, TOKEN_LIMIT, RESERVE_LIMIT,
  CARDS, CARD_BY_ID,
  createGame, applyAction, sanitize, solvePayment, evolutionOptions, tokenCount,
  canTakeTokens, addLog, forceEnd: finishGame,
};
