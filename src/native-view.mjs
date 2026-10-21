// Project only native player-visible frames; never inspect a BattleSpec or worker battle.
export const VIEW='ark-play-native-compact/v1';
export function canAct(pub,own,myId,result) {
  if(!pub||!own||result||!own.alive||pub.paused)return false;
  if(own.personalChoice)return true;
  if(pub.phase==='INFO_CHECK')return !pub.players.find(p=>p.playerId===myId)?.ready;
  if(pub.phase==='BAND_DRAFT')return pub.draft?.turn===myId&&!pub.draft.picks[myId];
  if(pub.phase==='SP_DRAFT')return pub.sp?.turn===myId&&pub.sp.picks[myId]==null;
  return pub.phase==='PREP'&&!own.ready;
}
export function projectNative({pub,own,myId,result,revision,room,runtime,map}) {
  const tables=runtime.raw;
  const label=id=>tables.chess[id]?.name||tables.tokens[id]?.name||tables.items[id]?.name||id;
  const piece=p=>p&&({uid:p.uid,id:p.id,name:label(p.id),kind:p.kind,tier:p.tier,golden:p.golden,
    ...(p.row===undefined?{}:{row:p.row,col:p.col,dir:p.dir}),...(p.ownerUid?{owner:p.ownerUid}:{}),
    ...(p.count>1?{count:p.count}:{}),items:(p.items||[]).map(i=>({uid:i.uid,id:i.id,name:label(i.id)}))});
  const offer=(p,index)=>p&&({index,id:p.id,name:label(p.id),kind:p.kind,price:p.price,sold:p.sold,frozen:p.frozen});
  const available=[],add=(...names)=>available.push(...names);
  if(canAct(pub,own,myId,result)) {
    if(own.personalChoice||pub.phase==='SP_DRAFT')add('choice');
    else if(pub.phase==='INFO_CHECK')add('confirm');
    else if(pub.phase==='BAND_DRAFT')add('band');
    else if(pub.phase==='PREP')add('buy','refresh','freeze','levelUp','sell','destroy','equip','art','move','ready');
  }
  const picked=Object.values(pub.draft?.picks||{});
  return {runId:room.code,view:{schema:VIEW,protocol:runtime.ready.protocol,application:runtime.ready.app,
    content:runtime.index.cs,revision,revisionScope:'client-snapshot',phase:pub.phase,round:pub.round,
    terminal:!!result,paused:!!pub.paused,canAct:canAct(pub,own,myId,result),
    me:{hp:own.lp,alive:own.alive,funds:own.funds,level:own.shop.level,upgradePrice:own.shop.upgradePrice,
      refreshPrice:own.shop.refreshPrice,freeRefreshes:own.shop.freeRefreshes,cap:own.deployCap,deployed:own.deployCount,
      handEmpty:own.hand.flatMap((p,i)=>p?[]:[i]),ready:own.ready,canReady:own.canReady},
    board:own.board.map(piece),hand:own.hand.map(piece),temp:own.temp.map(piece),shop:own.shop.slots.map(offer),
    reward:own.shop.rewardOffer,choices:own.personalChoice||(pub.phase==='SP_DRAFT'?pub.sp:null),available,
    draft:pub.phase==='BAND_DRAFT'?Object.entries(tables.bands).filter(([id,b])=>!picked.includes(id)&&(!b.modeTypeList||b.modeTypeList.includes('SINGLE'))).map(([id,b])=>({id,name:b.name||id})):null,
    setup:pub.phase==='INFO_CHECK'?{stage:pub.stageId,boss:pub.bossId,factions:pub.factions,
      disabledBonds:pub.disabledBonds,bannedChess:pub.bannedChess,setupRevision:pub.setupRevision}:null,
    map,bonds:own.bonds.filter(b=>b.count||b.layers),effects:own.effects,
    preview:own.nextEnemies.map(e=>Object.fromEntries(['enemyKey','count','fly','elite','boss'].filter(k=>k in e).map(k=>[k,e[k]]))),
    stats:own.stats,tokenTiles:{},
    outcome:result?{team:Object.fromEntries(['victory','roundsPassed','hiddenReached','hiddenCleared','reason','teamLp'].map(k=>[k,result[k]])),
      learner:(result.players||[]).filter(p=>p.playerId===myId).map(p=>Object.fromEntries(['alive','victory','roundsPassed','eliminatedRound','lp','stats'].map(k=>[k,p[k]])))[0]||null}:null}};
}
