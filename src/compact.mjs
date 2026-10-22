// Render compact gameplay views only. Recording and storage belong to the game site.
const arrow = {RIGHT:'→',LEFT:'←',UP:'↑',DOWN:'↓'};
const one = p => p ? `#${p.uid}${p.golden?'金':''}${p.name}${p.tier ? `(${p.tier}阶)` : ''}` +
  (p.row === undefined ? '' : `@${p.row},${p.col}${arrow[p.dir]||''}`) +
  (p.owner ? ` 属#${p.owner}` : '') + (p.count ? `×${p.count}` : '') +
  (p.itemType ? `/${p.itemType}` : '') +
  (p.items.length ? ` 装[${p.items.map(i=>`#${i.uid}${i.name}`).join('、')}]` : '') : '空';
const short = value => typeof value === 'string' ? value : JSON.stringify(value);

export function render(reply, previous=null, force=false) {
  const v=reply.view;
  if (!v) return JSON.stringify(reply);
  const full=force || !previous || previous.round!==v.round || previous.phase!==v.phase;
  const lines=[`局${reply.runId} 本地快照rev=${v.revision} 第${v.round}轮 ${v.phase} `+
    `血${v.me.hp} 钱${v.me.funds} ${v.me.level}本(升${v.me.upgradePrice}) `+
    `场${v.me.deployed}/${v.me.cap} 手牌空${v.me.handEmpty.length} `+
    `刷新${v.me.refreshPrice}${v.me.freeRefreshes ? `(免${v.me.freeRefreshes}次)` : ''}`];
  for (const r of reply.executed || []) lines.push(`${r.accepted?'✓':'✗'} ${r.action.type} ${r.reason||''}`+
    (r.accepted ? '' : ` ${short(r.result)}`));
  const sections={
    board:['场上',v.board.map(one).join('；')||'空'],
    hand:['手牌',v.hand.map((p,i)=>p?`${i}:${one(p)}`:null).filter(Boolean).join('；')||'空'],
    temp:['暂存',v.temp.map(one).join('；')],
    shop:['商店',v.shop.map((p,i)=>p?`${i}:${p.name} ${p.price}钱${p.sold?'[售出]':''}${p.frozen?'[冻]':''}`:`${i}:空`).join('；')],
    reward:['奖励',v.reward ? short(v.reward) : '无'],
    choices:['选择',v.choices ? short(v.choices) : '无'],
    draft:['策略',v.draft ? v.draft.map(x=>`${x.id}:${x.name}`).join('；') : '无'],
    map:['落点',`${v.map.field} `+['melee','ranged'].map(k=>`${k}:`+v.map.cells.filter(c=>c.kind===k).map(c=>`${c.row},${c.col}`).join(' ')).join('；')],
    bonds:['盟约',v.bonds.map(b=>`${b.bondId}:${b.count}人/${b.layers}层${b.active?'[激活]':''}`).join('；')],
    effects:['效果',v.effects.map(e=>`${e.name||e.id}:${e.desc||''}`).join('；')],
    preview:['下轮敌人',v.preview.map(e=>`${e.enemyKey}×${e.count}${e.fly?'飞':''}${e.elite?'精英':''}${e.boss?'首领':''}`).join('；')],
    tokenTiles:['召唤物空位',Object.entries(v.tokenTiles).map(([uid,cells])=>`#${uid}:`+cells.map(c=>`${c.row},${c.col}`).join(' ')).join('；')],
  };
  for (const [key,[title,value]] of Object.entries(sections)) {
    if (!full && JSON.stringify(v[key])===JSON.stringify(previous[key])) continue;
    if (full && ['reward','choices','draft'].includes(key) && value==='无') continue;
    if (!value) continue;
    lines.push(`${title}: ${value}`);
  }
  if (v.setup) lines.push(`开局: ${short(v.setup)}`);
  if (reply.notice) lines.push(`站点/客户端状态: ${reply.notice}`);
  if (v.paused) lines.push('游戏站已暂停：调用一次 ark_view 会等待恢复及下一决策；不要反复轮询。');
  if (v.me.handEmpty.length===0) lines.push('手牌已满：先装备/出售/处理库存才能购买或领取需空位的奖励。');
  if (v.terminal) lines.push(`结算: ${short(v.outcome)}`);
  lines.push(`可调用: ${v.available.join(', ')}。动作有目标约束，仍可能被引擎拒绝。`);
  return lines.join('\n');
}
