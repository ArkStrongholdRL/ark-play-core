import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readCombat,CombatHistory} from '../src/combat.mjs';
import {createTools} from '../src/tools.mjs';
const unit=(uid,stats={},extra={})=>({uid,id:uid,ownerId:'me',side:'ally',kind:'op',defId:'op',name:'同名',stats,...extra});
const battle=(units,extra={})=>({players:[{playerId:'me',units}],time:10,finished:true,errorCount:0,...extra});
const entry=(id,round,b,extra={})=>({id,round,fieldId:'field',kind:'normal',battle:b,...extra});

test('native counters preserve dead operators, nested summon credit, player/UID identity and zero denominators',()=>{
  const a=unit(1,{dmg:100,taken:30,heal:0,kills:2},{alive:false});
  const token=unit(8,{dmg:20,taken:10,heal:12},{kind:'token',ownerUnit:a});
  const child=unit(9,{dmg:5},{kind:'token',ownerUnit:token});
  const b=unit(2,{taken:60,heal:48});
  const peer=unit(1,{dmg:125},{ownerId:'peer'});
  const raw=battle([a,token,child,b,unit(99,{dmg:999},{side:'enemy'})],{players:[{playerId:'me',units:[a,token,child,b]},{playerId:'peer',units:[peer]},{playerId:'empty',units:[]}]});
  const before=structuredClone(raw),h=new CombatHistory();h.record(entry('n1',1,raw));
  const r=h.read({throughRound:1,playerId:'me'}),self=r.players.find(p=>p.isSelf);
  assert.deepEqual(raw,before,'reading never changes simulation state');
  assert.deepEqual(r.totals,{damage:250,taken:100,healing:60});
  assert.deepEqual(self.shares,{damage:0.5,taken:1,healing:1});
  assert.equal(self.units.length,2);assert.equal(self.units[0].damage,125);assert.equal(self.units[0].taken,40);
  assert.equal(self.units[0].healing,12);assert.equal(self.units[0].shares.healing,0.2);assert.equal(self.dps,12.5);
  assert.deepEqual(r.players.find(p=>p.playerId==='peer').shares,{damage:0.5,taken:0,healing:0});
  assert.deepEqual(r.players.find(p=>p.playerId==='empty').shares,{damage:0,taken:0,healing:0});
  assert.equal(r.complete,true);assert.equal(readCombat(raw).rows.length,3);
});

test('last combines normal and unite, deduplicates battle IDs and never leaks a later round or stale fallback',()=>{
  const h=new CombatHistory();
  h.record(entry('normal',1,battle([unit(1,{dmg:10})])));h.record(entry('normal',1,battle([unit(1,{dmg:10})])),'complete');
  h.record(entry('unite',1,battle([unit(1,{dmg:20})],{time:5}),{kind:'unite'}));
  h.record(entry('next',2,battle([unit(1,{dmg:999})])));
  const r=h.read({throughRound:1});assert.equal(r.totals.damage,30);assert.equal(r.battles.length,2);assert.equal(r.players[0].seconds,15);assert.equal(r.players[0].dps,2);
  assert.equal(h.read({throughRound:3}).status,'unavailable');
  assert.equal(h.read({scope:'match',throughRound:2}).totals.damage,1029);
});

test('takeover, reconstructed and interrupted simulations are partial; missing data is unavailable',()=>{
  for(const extra of [{reconstructed:true},{interrupted:true},{}]) {
    const h=new CombatHistory();h.record(entry('partial',1,battle([unit(1,{dmg:3})]),extra),Object.keys(extra).length?'local_finished':'takeover');
    assert.equal(h.read({throughRound:1}).complete,false);
  }
  const h=new CombatHistory();h.record(entry('missing',1,null),'not_locally_simulated');
  const r=h.read({throughRound:1});assert.equal(r.status,'unavailable');assert.equal(r.complete,false);assert.deepEqual(r.players,[]);assert.equal(r.battles[0].available,false);
  h.record(entry('observed',2,battle([])));assert.equal(h.read({scope:'match',throughRound:2}).complete,false);
});

test('history eviction and output truncation retain exact totals and reset removes prior match',()=>{
  const h=new CombatHistory(2,1);
  for(let round=1;round<=3;round++)h.record(entry('b'+round,round,battle([unit(1,{dmg:10}),unit(2,{dmg:5})])));
  const r=h.read({scope:'match',throughRound:3});assert.equal(r.historyEvicted,1);assert.equal(r.complete,false);assert.deepEqual(r.missingRounds,[1]);
  assert.equal(r.totals.damage,30);assert.equal(r.players[0].units.length,1);assert.equal(r.players[0].omittedUnits,1);assert.equal(r.players[0].units[0].shares.damage,2/3);
  h.clear();assert.equal(h.read({throughRound:3}).status,'unavailable');assert.equal(h.evicted,0);
});

test('combat tool reads only locally after settlement, does not connect, mutate revision, or recover uncertain actions',async()=>{
  const runtime=createTools({configFile:'/tmp/nonexistent-ark-combat-config'}),c=runtime.client;
  c.connect=async()=>{throw new Error('must not connect');};
  const tool=runtime.tools.find(t=>t.name==='ark_combat');const run=async()=>JSON.parse((await tool.execute(tool.schema.parse({}))).text);
  try {
    assert.equal((await run()).reason,'no_local_match_runtime');
    const queries=[];c.site={ready:{},request:async(op,q)=>{queries.push([op,q]);return {status:'available'};},close:async()=>{}};
    c.pub={phase:'PREP',round:1};assert.equal((await run()).reason,'no_completed_round');
    for(const phase of ['COMBAT','UNITE','FINAL_ASSAULT','HIDDEN_CORE','SETTLE']){c.pub={phase,round:2};assert.equal((await run()).status,'pending');}
    c.pub={phase:'PREP',round:2,paused:true};assert.equal((await run()).doNotPoll,true);assert.equal(queries.length,0);
    c.pub.paused=false;c.uncertain=true;const revision=c.revision;await run();
    assert.deepEqual(queries.pop(),['combat',{query:{scope:'last',throughRound:1}}]);assert.equal(c.revision,revision);assert.equal(c.uncertain,true);
    c.result={victory:false};c.pub={phase:'COMBAT',round:2};await run();assert.equal(queries.pop()[1].query.throughRound,2);
    assert.equal(tool.schema.safeParse({scope:'live'}).success,false);
  }finally{await runtime.close();}
});
