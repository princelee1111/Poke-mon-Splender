'use strict';
/** 简单启发式 AI bot（供联机补位/单人测试） */
const E = require('./engine');

function deficit(p, card) {
  // 还缺多少球（考虑折扣），以及缺哪些色
  const need = {};
  let total = 0;
  for (const c of E.COLORS) {
    const n = Math.max(0, (card.cost[c] || 0) - (p.bonuses[c] || 0));
    need[c] = n; total += n;
  }
  return { need, total };
}

function cardValue(card) {
  let v = card.vp * 3;
  v += (card.bonusCount || 1) * 1.2;
  if (card.evolvesTo) v += 1.5;
  if (card.tier === 'legend' || card.tier === 'rare') v += 1;
  return v;
}

/** 返回 bot 动作；g 为完整游戏状态（服务端内部） */
function botAction(g, seat) {
  const p = g.players[seat];
  if (g.awaiting && g.awaiting.type === 'discard') {
    // 归还数量最多颜色的球
    let best = E.COLORS[0], max = -1;
    for (const c of [...E.COLORS, 'purple']) if (p.tokens[c] > max) { max = p.tokens[c]; best = c; }
    return { type: 'discardToken', color: best };
  }
  if (g.awaiting && g.awaiting.type === 'evolve') {
    // 选胜点增益最大的进化
    let best = null, bestGain = -1;
    for (const o of g.awaiting.options) {
      const gain = E.CARD_BY_ID[o.targetId].vp - E.CARD_BY_ID[o.fromId].vp;
      if (gain > bestGain) { bestGain = gain; best = o; }
    }
    if (best) return { type: 'evolve', fromId: best.fromId, targetId: best.targetId };
    return { type: 'skipEvolve' };
  }

  // 1) 能捕捉就挑价值最高的捕捉
  let catchBest = null, catchVal = -1, catchPay = null;
  const consider = [];
  for (const tier of Object.keys(g.table)) for (const id of g.table[tier]) consider.push(id);
  for (const id of p.reserved) consider.push(id);
  for (const id of consider) {
    const card = E.CARD_BY_ID[id];
    const pay = E.solvePayment(p, card, false);
    if (pay) {
      const v = cardValue(card) + (p.reserved.includes(id) ? 0.8 : 0); // 清保留区略优先
      if (v > catchVal) { catchVal = v; catchBest = id; catchPay = pay; }
    }
  }
  if (catchBest && catchVal >= 4.5) {
    return { type: 'catch', cardId: catchBest, pay: catchPay };
  }

  // 2) 高价值卡快到手时考虑保留（只能保留 stage1-3；稀有/传说不可保留）
  const targets = [];
  for (const tier of ['stage3', 'legend', 'rare']) for (const id of g.table[tier]) targets.push(id);
  targets.push(...p.reserved);
  let reservePick = null;
  for (const id of targets) {
    const card = E.CARD_BY_ID[id];
    if (card.tier === 'rare' || card.tier === 'legend') continue; // 不可保留
    const d = deficit(p, card);
    if (d.total <= 3 && d.total > 0 && cardValue(card) >= 5 && p.reserved.length < 3) {
      if (!reservePick || cardValue(card) > cardValue(E.CARD_BY_ID[reservePick])) reservePick = id;
    }
  }
  // 别人快拿到的三阶卡也抢
  if (!reservePick && p.reserved.length < 3) {
    outer:
    for (const id of g.table.stage3) {
      const card = E.CARD_BY_ID[id];
      for (const op of g.players) {
        if (op.seat === seat) continue;
        const d = deficit(op, card);
        if (d.total === 0 && E.solvePayment(op, card, false)) {
          reservePick = id; break outer;
        }
      }
    }
  }
  if (reservePick) {
    const tier = Object.keys(g.table).find(t => g.table[t].includes(reservePick));
    if (tier) return { type: 'reserve', tier, cardId: reservePick };
  }

  // 3) 捕捉低价值可捕卡（避免浪费行动）
  if (catchBest) return { type: 'catch', cardId: catchBest, pay: catchPay };

  // 3b) 已拿满 10 球又买不起：先保留一张最容易买到的卡换大师球，避免「拿起又归还」原地打转
  if (E.tokenCount(p) >= E.TOKEN_LIMIT) {
    if (p.reserved.length < 3) {
      let pick = null, pickScore = -1;
      for (const tier of ['stage3', 'stage2', 'stage1']) {
        let bestOfTier = null, bestScore = -1;
        for (const id of g.table[tier]) {
          const card = E.CARD_BY_ID[id];
          const d = deficit(p, card);
          const score = cardValue(card) / (1 + d.total);
          if (score > bestScore) { bestScore = score; bestOfTier = id; }
        }
        if (bestOfTier && bestScore > pickScore) { pickScore = bestScore; pick = { tier, id: bestOfTier }; }
      }
      if (pick) return { type: 'reserve', tier: pick.tier, cardId: pick.id };
    }
  }

  // 4) 拿球：朝价值最高的目标卡积累
  const want = {};
  for (const id of consider.concat(targets)) {
    const card = E.CARD_BY_ID[id];
    if (card.tier === 'rare' || card.tier === 'legend') {
      // 需要大师球，普通球缺口照算
    }
    const d = deficit(p, card);
    const w = cardValue(card) / Math.max(1, d.total);
    for (const c of E.COLORS) if (d.need[c] > 0) want[c] = (want[c] || 0) + w * d.need[c] / Math.max(1, d.total);
  }
  const order = Object.keys(want).sort((a, b) => want[b] - want[a]);
  const colorsAvail = E.COLORS.filter(c => g.supply[c] > 0).length;
  const pick = {};
  let taken = 0;
  // 优先拿最缺的颜色，再随机补足 3 种
  for (const c of order) {
    if (taken >= 3) break;
    if (!pick[c] && g.supply[c] > 0) { pick[c] = 1; taken++; }
  }
  for (const c of E.COLORS) {
    if (taken >= 3) break;
    if (!pick[c] && g.supply[c] > 0) { pick[c] = 1; taken++; }
  }
  if (taken === 3) return { type: 'take', tokens: pick };
  if (taken > 0 && taken === colorsAvail) return { type: 'take', tokens: pick };
  // 尝试拿 2 个同色（供给≥4）
  for (const c of order) {
    if (g.supply[c] >= 4) return { type: 'take', tokens: { [c]: 2 } };
  }
  for (const c of E.COLORS) {
    if (g.supply[c] >= 4) return { type: 'take', tokens: { [c]: 2 } };
  }
  if (taken >= 1) return { type: 'take', tokens: pick };
  // 实在没有：随便拿一个有的
  for (const c of E.COLORS) if (g.supply[c] > 0) return { type: 'take', tokens: { [c]: 1 } };
  // 仍不行：暗抽保留一张（几乎不会走到这里）
  for (const tier of ['stage1', 'stage2', 'stage3']) {
    if (p.reserved.length < 3 && g.decks[tier].length) return { type: 'reserve', tier };
  }
  return { type: 'skipEvolve' }; // 极端僵局兜底
}

function deficitTotal(p) {
  return p.tokens.red + p.tokens.blue + p.tokens.black + p.tokens.pink + p.tokens.yellow;
}

module.exports = { botAction };
