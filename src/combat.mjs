// Read completed native simulations only. No BattleSpec, RNG, future waves or frame history cross this boundary.
const positive = n => Number.isFinite(n) && n > 0 ? n : 0;
const measures = ['damage','taken','healing'];
const empty = () => ({damage:0,taken:0,healing:0});
const add = (to,from) => {for(const k of measures)to[k]+=positive(from[k]);};
const shares = (row,total) => Object.fromEntries(measures.map(k=>[k,total[k]>0?row[k]/total[k]:0]));
const order = (a,b) => b.damage-a.damage||b.taken-a.taken||b.healing-a.healing||a.key.localeCompare(b.key);
function ownerOf(unit) {
  const seen=new Set();
  while(unit?.kind==='token'&&unit.ownerUnit&&!seen.has(unit)){seen.add(unit);unit=unit.ownerUnit;}
  return unit;
}
export function readCombat(battle) {
  const rows=new Map();
  for(const player of battle.players||[])for(const unit of player.units||[]) {
    if(unit.side!=='ally')continue;
    const owner=ownerOf(unit);
    const playerId=owner?.ownerId??unit.ownerId;
    if(playerId==null)continue;
    const key=JSON.stringify([playerId,owner.uid!=null?['uid',owner.uid]:['unowned',owner.kind,owner.defId??owner.id]]);
    if(!rows.has(key))rows.set(key,{key,playerId,uid:owner.uid??null,id:owner.defId??null,
      name:String(owner.name||owner.defId||'未命名单位').slice(0,120),kind:owner.kind,...empty(),kills:0,attacks:0});
    const row=rows.get(key),stats=unit.stats||{};
    row.damage+=positive(stats.dmg);row.taken+=positive(stats.taken);row.healing+=positive(stats.heal);
    row.kills+=positive(stats.kills);row.attacks+=positive(stats.attacks);
  }
  return {playerIds:(battle.players||[]).map(p=>p.playerId),seconds:positive(battle.time),rows:[...rows.values()].sort(order)};
}
export class CombatHistory {
  constructor(limit=64,rowLimit=256){this.limit=limit;this.rowLimit=rowLimit;this.records=new Map();this.evicted=0;}
  clear(){this.records.clear();this.evicted=0;}
  record(entry,reason='local_finished') {
    const old=this.records.get(entry.id);
    // Duplicate start/end frames never add a second copy of a battle.
    const observed=entry.battle?readCombat(entry.battle):{playerIds:[],seconds:0,rows:[]};
    const complete=!!entry.battle?.finished&&reason!=='takeover'&&!entry.reconstructed&&!entry.interrupted&&!entry.battle.errorCount;
    const record={battleId:entry.id,fieldId:entry.fieldId,round:entry.round,kind:entry.kind,
      seconds:observed.seconds,complete,reason,available:!!entry.battle,reconstructed:!!entry.reconstructed,interrupted:!!entry.interrupted,playerIds:observed.playerIds,
      errors:positive(entry.battle?.errorCount),rows:observed.rows};
    if(old&&old.seconds>record.seconds){record.rows=old.rows;record.seconds=old.seconds;record.playerIds=old.playerIds;}
    this.records.delete(entry.id);this.records.set(entry.id,record);
    while(this.records.size>this.limit){this.records.delete(this.records.keys().next().value);this.evicted++;}
  }
  read({scope='last',throughRound=0,playerId}) {
    const all=[...this.records.values()].filter(r=>r.round<=throughRound);
    const selected=scope==='last'?all.filter(r=>r.round===throughRound):all;
    const records=selected.filter(r=>r.available);
    const players=new Map();
    for(const record of records)for(const id of record.playerIds)if(!players.has(id))players.set(id,{playerId:id,isSelf:id===playerId,...empty(),seconds:0,units:new Map()});
    for(const record of records)for(const unit of record.rows) {
      if(!players.has(unit.playerId))players.set(unit.playerId,{playerId:unit.playerId,isSelf:unit.playerId===playerId,...empty(),seconds:0,units:new Map()});
      const player=players.get(unit.playerId);add(player,unit);
      if(!player.units.has(unit.key))player.units.set(unit.key,{...unit,...empty(),kills:0,attacks:0});
      const row=player.units.get(unit.key);Object.assign(row,{name:unit.name,id:unit.id});add(row,unit);row.kills+=unit.kills;row.attacks+=unit.attacks;
    }
    for(const player of players.values())player.seconds=records.filter(r=>r.playerIds.includes(player.playerId)).reduce((n,r)=>n+r.seconds,0);
    const totals=empty();for(const p of players.values())add(totals,p);
    const visible=[...players.values()].map(p=>{
      const units=[...p.units.values()].sort(order);
      return {...p,shares:shares(p,totals),dps:p.seconds>0?p.damage/p.seconds:0,hps:p.seconds>0?p.healing/p.seconds:0,
        units:units.slice(0,this.rowLimit).map(({key,playerId,...u})=>({...u,shares:shares(u,p)})),
        omittedUnits:Math.max(0,units.length-this.rowLimit)};
    });
    const missingRounds=Array.from({length:Math.min(throughRound,100)},(_,i)=>i+1).filter(n=>!all.some(r=>r.round===n));
    const complete=selected.length>0&&selected.every(r=>r.complete)&&(scope!=='match'||(this.evicted===0&&!missingRounds.length));
    return {schema:'ark-play-combat/v1',status:records.length?'available':'unavailable',scope,round:scope==='last'?throughRound:null,
      throughRound,source:'local-native-simulation',coverage:'own locally simulated fields; paired allies included when present',
      complete,...(scope==='match'?{missingRounds}:{}),historyEvicted:this.evicted,battles:selected.map(({rows,...r})=>r),totals,players:visible,
      shareBasis:'player shares / observed field totals; unit shares / that player totals; zero denominator => 0',
      accounting:'effective enemy HP damage and actual healing from native unit counters; taken includes native self/friendly HP loss; summons credited to their owning operator',
      ...(!selected.length?{reason:'no_observed_battle_for_completed_round'}:{})};
  }
}
