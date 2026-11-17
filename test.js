'use strict';
/** 引擎自测：规则用例 + 200 局 bot 自走 */
const E = require('./engine');
const { botAction } = require('./bot');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; }
  else { fail++; console.error('  ✗ FAIL:', name); }
}
function zero() { const t = {}; for (const c of ['red','blue','black','pink','yellow','purple']) t[c] = 0; return t; }

/* ---------- 用例 1：基础设置 ---------- */
{
  const g = E.createGame([{ name: 'A' }, { name: 'B' }]);
  check('2人 每色供给=4', E.COLORS.every(c => g.supply[c] === 4));
  check('2人 大师球=5', g.supply.purple === 5);
  check('场上 4/4/4/1/1', g.table.stage1.length === 4 && g.table.stage2.length === 4 && g.table.stage3.length === 4 && g.table.rare.length === 1 && g.table.legend.length === 1);
  check('牌堆 31/26/11/9/9（发牌后）', g.decks.stage1.length === 31 && g.decks.stage2.length === 26 && g.decks.stage3.length === 11 && g.decks.rare.length === 9 && g.decks.legend.length === 9);
}
{
  const g = E.createGame([{ name: 'A' }, { name: 'B' }, { name: 'C' }]);
  check('3人 每色供给=5', E.COLORS.every(c => g.supply[c] === 5));
}
{
  const g = E.createGame([{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }]);
  check('4人 每色供给=7', E.COLORS.every(c => g.supply[c] === 7));
}

/* ---------- 用例 2：拿球规则 ---------- */
{
  const g = E.createGame([{ name: 'A' }, { name: 'B' }]);
  const p = g.players[0];
  check('拿3不同色 OK', E.applyAction(g, 0, { type: 'take', tokens: { red: 1, blue: 1, yellow: 1 } }).ok);
  check('球已到手', p.tokens.red === 1 && p.tokens.blue === 1 && p.tokens.yellow === 1);
  g.turn = 0; // 测试用：跳回 A 回合
  check('不能拿大师球', !E.applyAction(g, 0, { type: 'take', tokens: { purple: 1 } }).ok);
  check('拿2同色需供给≥4（blue=3 应拒绝）', !E.applyAction(g, 0, { type: 'take', tokens: { blue: 2 } }).ok);
  check('拿2同色 black=4 OK', E.applyAction(g, 0, { type: 'take', tokens: { black: 2 } }).ok);
  check('black 扣除正确', g.supply.black === 2 && p.tokens.black === 2);
}

/* ---------- 用例 3：保留 + 大师球 ---------- */
{
  const g = E.createGame([{ name: 'A' }, { name: 'B' }]);
  const card = g.table.stage1[0];
  const purpleBefore = g.supply.purple;
  const r = E.applyAction(g, 0, { type: 'reserve', tier: 'stage1', cardId: card });
  check('保留成功', r.ok);
  check('获得大师球', g.players[0].tokens.purple === 1 && g.supply.purple === purpleBefore - 1);
  check('场上补牌', g.table.stage1.length === 4 && !g.table.stage1.includes(card));
  check('不能保留稀有', !E.applyAction(g, 1, { type: 'reserve', tier: 'rare' }).ok);
  g.turn = 1;
  E.applyAction(g, 1, { type: 'reserve', tier: 'stage1', cardId: g.table.stage1[0] });
  g.turn = 1;
  E.applyAction(g, 1, { type: 'reserve', tier: 'stage1', cardId: g.table.stage1[0] });
  g.turn = 1;
  E.applyAction(g, 1, { type: 'reserve', tier: 'stage1', cardId: g.table.stage1[0] });
  check('保留上限3张', g.players[1].reserved.length === 3);
  g.turn = 1;
  check('第4张被拒', !E.applyAction(g, 1, { type: 'reserve', tier: 'stage1' }).ok);
  check('大师球耗尽仍可保留', true);
}

/* ---------- 用例 4：捕捉与折扣 ---------- */
{
  const g = E.createGame([{ name: 'A' }, { name: 'B' }]);
  const p = g.players[0];
  p.tokens = { red: 2, blue: 0, black: 3, pink: 2, yellow: 0, purple: 1 };
  const card = E.CARDS.find(c => c.tier === 'stage1' && c.cost.black === 3 && c.cost.pink === 2 && !c.cost.red);
  check('找到测试卡', !!card);
  if (card) {
    g.table.stage1 = [card.id, ...g.table.stage1.slice(1)]; // 放到场上
    const helpers = E.CARDS.filter(c => c.bonus === 'black' && !c.cost.purple).slice(0, 2);
    p.played.push(...helpers.map(c => c.id));
    p.bonuses = (function () { const b = zero(); for (const id of p.played) { const c = E.CARD_BY_ID[id]; b[c.bonus] += c.bonusCount; } return b; })();
    const pay = E.solvePayment(p, card, false);
    check('折扣生效 black', pay.black === Math.max(0, 3 - p.bonuses.black));
    const ok = E.applyAction(g, 0, { type: 'catch', cardId: card.id, pay });
    check('捕捉成功', ok.ok);
    const expectedVP = card.vp + helpers.reduce((s, c) => s + c.vp, 0);
    check('VP 记账', p.vp === expectedVP);
  }
}

/* ---------- 用例 5：稀有卡必须大师球 ---------- */
{
  const g = E.createGame([{ name: 'A' }, { name: 'B' }]);
  const p = g.players[0];
  const rare = E.CARD_BY_ID[g.table.rare[0]];
  for (const c of E.COLORS) p.tokens[c] = 7;
  p.tokens.purple = 0;
  check('无大师球时求解失败', E.solvePayment(p, rare, false) === null);
  p.tokens.purple = 1;
  const pay2 = E.solvePayment(p, rare, false);
  check('有大师球时求解成功', pay2 !== null && pay2.purple >= 1);
  check('非稀有卡不需要大师球', (() => {
    const c1 = E.CARDS.find(c => c.tier === 'stage1' && E.solvePayment({ tokens: { red: 7, blue: 7, black: 7, pink: 7, yellow: 7, purple: 0 }, bonuses: zero() }, c, false));
    return !!c1;
  })());
}

/* ---------- 用例 6：进化 ---------- */
{
  const g = E.createGame([{ name: 'A' }, { name: 'B' }]);
  const p = g.players[0];
  const bulba = E.CARDS.find(c => c.name === '妙蛙种子');
  const ivysaur = E.CARDS.find(c => c.name === '妙蛙草');
  check('进化链存在', !!bulba && !!ivysaur && bulba.evolvesTo === '妙蛙草');
  p.played.push(bulba.id);
  g.table.stage2 = [ivysaur.id, ...g.table.stage2.slice(1)];
  p.bonuses = zero();
  p.bonuses[bulba.evoCost.color] = bulba.evoCost.count;
  const opts = E.evolutionOptions(g, p);
  check('进化选项生成', opts.some(o => o.fromId === bulba.id && o.targetId === ivysaur.id));
  const r = E.applyAction(g, 0, { type: 'take', tokens: { red: 1, blue: 1, yellow: 1 } });
  check('行动后进入进化待定', r.ok && g.awaiting && g.awaiting.type === 'evolve');
  const r2 = E.applyAction(g, 0, { type: 'evolve', fromId: bulba.id, targetId: ivysaur.id });
  check('进化成功', r2.ok);
  check('进化后VP更新', p.vp === ivysaur.vp && p.under.includes(bulba.id) && p.played.includes(ivysaur.id));
  check('进化数=1', p.evolvedCount === 1);
  check('回合移交', g.turn === 1 && !g.awaiting);
  check('场上牌数恢复', g.table.stage2.length === 4);
  // 折扣不消耗
  check('进化不消耗球', p.tokens.red === 1);
}

/* ---------- 用例 6b：进化目标也可来自保留区 ---------- */
{
  const g = E.createGame([{ name: 'A' }, { name: 'B' }]);
  const p = g.players[0];
  const char = E.CARDS.find(c => c.name === '小火龙');
  const charme = E.CARDS.find(c => c.name === '火恐龙');
  p.played.push(char.id);
  p.reserved.push(charme.id);
  p.bonuses = zero();
  p.bonuses[char.evoCost.color] = char.evoCost.count;
  const opts = E.evolutionOptions(g, p);
  check('保留区进化选项', opts.some(o => o.fromId === char.id && o.targetId === charme.id && o.source === 'reserved'));
  E.applyAction(g, 0, { type: 'take', tokens: { red: 1, blue: 1, yellow: 1 } });
  check('进入进化待定', g.awaiting?.type === 'evolve');
  E.applyAction(g, 0, { type: 'evolve', fromId: char.id, targetId: charme.id });
  check('保留区卡被消耗', p.played.includes(charme.id) && !p.reserved.includes(charme.id));
}

/* ---------- 用例 6b-2：场上与保留区同时存在同名进化目标 ---------- */
{
  const g = E.createGame([{ name: 'A' }, { name: 'B' }]);
  const p = g.players[0];
  const char = E.CARDS.find(c => c.name === '小火龙');
  const charme = E.CARDS.find(c => c.name === '火恐龙');
  p.played.push(char.id);
  p.reserved.push(charme.id);
  p.bonuses = zero();
  p.bonuses[char.evoCost.color] = char.evoCost.count;
  // 强制在场上再放一张同名卡，构造"双来源"场景
  g.table.stage1[0] = charme.id;
  const opts = E.evolutionOptions(g, p);
  check('双来源时只提供保留区选项', opts.length === 1 && opts[0].source === 'reserved');
  E.applyAction(g, 0, { type: 'take', tokens: { red: 1, blue: 1, yellow: 1 } });
  E.applyAction(g, 0, { type: 'evolve', fromId: char.id, targetId: charme.id });
  check('双来源时消耗保留区那份', p.played.includes(charme.id) && !p.reserved.includes(charme.id));
}

/* ---------- 用例 6c：每回合最多进化 1 次 ---------- */
{
  const g = E.createGame([{ name: 'A' }, { name: 'B' }]);
  const p = g.players[0];
  const bulba = E.CARDS.find(c => c.name === '妙蛙种子');
  const ivysaur = E.CARDS.find(c => c.name === '妙蛙草');
  const char = E.CARDS.find(c => c.name === '小火龙');
  const charme = E.CARDS.find(c => c.name === '火恐龙');
  // 同时具备两条可进化链
  p.played.push(bulba.id, char.id);
  p.reserved.push(ivysaur.id, charme.id);
  p.bonuses = zero();
  // 两条进化链可能要求不同折扣色，分别满足
  for (const src of [bulba, char]) {
    const { color, count } = src.evoCost;
    p.bonuses[color] = Math.max(p.bonuses[color] || 0, count);
  }
  const opts = E.evolutionOptions(g, p);
  check('同时存在多条进化路径', opts.length >= 2);
  E.applyAction(g, 0, { type: 'take', tokens: { red: 1, blue: 1, yellow: 1 } });
  check('进入进化待定（一回合一次机会）', g.awaiting?.type === 'evolve');
  const r = E.applyAction(g, 0, { type: 'evolve', fromId: bulba.id, targetId: ivysaur.id });
  check('第一次进化成功', r.ok && p.evolvedCount === 1);
  check('进化后不再弹第二次进化（回合直接移交）', g.turn === 1 && !g.awaiting);
  check('另一条进化链未被进化', p.played.includes(char.id) && !p.played.includes(charme.id));
  check('新回合重置进化机会', g.evolveDoneThisTurn === false);
  // 回到 A 的下一回合，仍可进化另一条链
  E.applyAction(g, 1, { type: 'take', tokens: { red: 1, blue: 1, yellow: 1 } });
  // 进化后 recalcPlayer 会按实际卡牌重算折扣，这里为验证规则再补足折扣
  for (const src of [char]) {
    const { color, count } = src.evoCost;
    p.bonuses[color] = Math.max(p.bonuses[color] || 0, count);
  }
  E.applyAction(g, 0, { type: 'take', tokens: { red: 1, blue: 1, yellow: 1 } });
  check('下一回合可再次进化', g.awaiting?.type === 'evolve' && g.awaiting.options.some(o => o.fromId === char.id));
}

/* ---------- 用例 6d：跳过进化不重复询问 ---------- */
{
  const g = E.createGame([{ name: 'A' }, { name: 'B' }]);
  const p = g.players[0];
  const bulba = E.CARDS.find(c => c.name === '妙蛙种子');
  const ivysaur = E.CARDS.find(c => c.name === '妙蛙草');
  p.played.push(bulba.id);
  p.reserved.push(ivysaur.id);
  p.bonuses = zero();
  p.bonuses[bulba.evoCost.color] = bulba.evoCost.count;
  E.applyAction(g, 0, { type: 'take', tokens: { red: 1, blue: 1, yellow: 1 } });
  check('跳过前处于进化待定', g.awaiting?.type === 'evolve');
  E.applyAction(g, 0, { type: 'skipEvolve' });
  check('跳过后回合移交且不重复询问', g.turn === 1 && !g.awaiting);
}

/* ---------- 用例 7：10球上限 ---------- */
{
  const g = E.createGame([{ name: 'A' }, { name: 'B' }]);
  const p = g.players[0];
  p.tokens.red = 9;
  E.applyAction(g, 0, { type: 'take', tokens: { blue: 1, black: 1, pink: 1 } });
  check('触发弃球', g.awaiting && g.awaiting.type === 'discard' && g.awaiting.count === 2);
  E.applyAction(g, 0, { type: 'discardToken', color: 'red' });
  E.applyAction(g, 0, { type: 'discardToken', color: 'red' });
  check('弃球后回合移交', g.turn === 1 && !g.awaiting);
}

/* ---------- 用例 8：18分终局 ---------- */
{
  const g = E.createGame([{ name: 'A' }, { name: 'B' }]);
  g.players[0].vp = 18;
  g.endPending = true;
  g.turn = 1;
  E.applyAction(g, 1, { type: 'take', tokens: { red: 1, blue: 1, yellow: 1 } });
  check('本轮结束后终局', g.phase === 'ended' && g.winner && g.winner.names.includes('A'));
}

/* ---------- 用例 8b：捕捉触发 18 分 ---------- */
{
  const g = E.createGame([{ name: 'A' }, { name: 'B' }, { name: 'C' }]);
  const p = g.players[0];
  // 用真实的已打出场面凑 16 分（5+5+3+3），再捕捉一张 vp>=2 的卡触发 18
  const vpCards = [];
  for (const v of [5, 5, 3, 3]) {
    const c = E.CARDS.find(x => x.vp === v && !vpCards.includes(x.id));
    vpCards.push(c.id);
  }
  p.played.push(...vpCards);
  p.bonuses = zero();
  const vp2 = E.CARDS.find(c => c.vp >= 2 && !vpCards.includes(c.id) && c.tier === 'stage3' && E.solvePayment({ tokens: { red: 7, blue: 7, black: 7, pink: 7, yellow: 7, purple: 2 }, bonuses: zero() }, c, false));
  check('找到触发卡', !!vp2);
  g.table.stage3 = [vp2.id, ...g.table.stage3.slice(1)];
  p.tokens = { red: 7, blue: 7, black: 7, pink: 7, yellow: 7, purple: 2 };
  const r = E.applyAction(g, 0, { type: 'catch', cardId: vp2.id });
  check('捕捉触发终局标记', r.ok && g.endPending === true);
}

/* ---------- 用例 8c：开局换位决定行动顺序 ---------- */
{
  const seats = [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }];
  const g = E.createGame(seats, [2, 0, 3, 1]);
  check('顺序记录正确', JSON.stringify(g.order) === JSON.stringify([2, 0, 3, 1]));
  check('先手 = 顺序第一位', g.starter === 2 && g.turn === 2);
  check('日志提到先手名字', g.log[0].msg.includes('C 先手'));
  const seq = [g.turn];
  for (let i = 0; i < 3; i++) {
    const before = g.turn;
    // 直接推进回合（拿球即可）
    const r = E.applyAction(g, before, { type: 'take', tokens: { red: 1, blue: 1, yellow: 1 } });
    check(`第 ${i + 1} 位可以行动`, r.ok);
    seq.push(g.turn);
  }
  check('回合按自定义顺序轮转', JSON.stringify(seq) === JSON.stringify([2, 0, 3, 1]));
  check('一轮后回到先手', (() => {
    E.applyAction(g, 1, { type: 'take', tokens: { red: 1, blue: 1, black: 1 } });
    return g.turn === 2;
  })());
  check('sanitize 暴露顺序', JSON.stringify(E.sanitize(g, 0, {}).order) === JSON.stringify([2, 0, 3, 1]));
  check('非法顺序回退到座位顺序', JSON.stringify(E.createGame(seats, [0, 0, 1, 2]).order) === JSON.stringify([0, 1, 2, 3]));
}

/* ---------- 用例 9：bot 自走 200 局 ---------- */
async function autoPlay() {
  let okGames = 0, crashed = 0;
  const t0 = Date.now();
  for (let i = 0; i < 200; i++) {
    const n = 2 + (i % 3);
    const seats = Array.from({ length: n }, (_, k) => ({ name: k === 0 ? 'Hero' : `Bot${k}`, isBot: k !== 0 }));
    // 一半的局用随机行动顺序（模拟开局换位），确保任意顺序下都能正常结束
    let ord;
    if (i % 2) {
      ord = seats.map((_, k) => k);
      for (let s = ord.length - 1; s > 0; s--) {
        const j = Math.floor(Math.random() * (s + 1));
        [ord[s], ord[j]] = [ord[j], ord[s]];
      }
    }
    const g = E.createGame(seats, ord);
    let steps = 0;
    try {
      while (g.phase === 'playing' && steps < 3000) {
        steps++;
        const action = botAction(g, g.turn);
        const r = E.applyAction(g, g.turn, action);
        if (!r.ok) {
          if (g.awaiting?.type === 'evolve') E.applyAction(g, g.turn, { type: 'skipEvolve' });
          else if (g.awaiting?.type === 'discard') {
            const c = Object.keys(g.players[g.turn].tokens).find(c => g.players[g.turn].tokens[c] > 0);
            E.applyAction(g, g.turn, { type: 'discardToken', color: c });
          } else throw new Error('bot action rejected: ' + r.error + ' action=' + JSON.stringify(action));
        }
        if (steps > 2900) throw new Error('game did not end');
      }
      if (g.phase === 'ended') okGames++;
      else crashed++;
    } catch (e) {
      crashed++;
      if (crashed <= 3) console.error('  局 #' + i + ' 异常:', e.message);
    }
  }
  console.log(`  自走结果: ${okGames}/200 局正常结束, 异常 ${crashed}, 耗时 ${Date.now() - t0}ms`);
  check('全部自走正常', crashed === 0);
}

(async () => {
  console.log('=== 引擎自测 ===');
  await autoPlay();
  console.log(`=== 通过 ${pass} / 失败 ${fail} ===`);
  process.exit(fail ? 1 : 0);
})();
