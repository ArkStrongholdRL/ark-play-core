// Execute the site's actual deterministic simulation in an isolated worker.
// Battle specs/RNG never leave this worker for model observations.
import {register} from 'node:module';
import {parentPort,workerData} from 'node:worker_threads';
const {origin,headers,index,raw}=workerData;
const hashes={...index.simFiles};
const traits=Object.values(raw.garrisons||{}).filter(g=>g.operatorTrait).map(g=>g.operatorTrait.runtime);
if(traits.length) {
  if(traits.some(h=>!/^[a-f0-9]{64}$/.test(h)||h!==traits[0]))throw new Error('Upstream trait runtime pins differ');
  hashes['js/battle/operatorTraits.js']=traits[0];
}
register(new URL('./site-loader.mjs',import.meta.url),{parentURL:import.meta.url,data:{origin,headers,hashes}});
const [identity,protocol,constants,simdata,spec,support,bounds,placement,camera]=await Promise.all([
  'shared/plugins/identity.js','shared/protocol.js','shared/constants.js','sim/simdata.js','sim/spec.js',
  'sim/content/support/index.js','shared/plugins/officialBounds.js','js/ui/gameLogic/placement.js','js/ui/gameLogic/camera.js',
].map(path=>import(origin+'/'+path)));
if(identity.simHashOf(index.simFiles)!==index.sim||identity.contentHashOf({app:index.app,sim:index.sim,
  data:Object.fromEntries(Object.entries(index.data).map(([k,v])=>[k,v.sha256])),plugins:index.plugins,settings:index.settings})!==index.cs)throw new Error('Upstream content identity mismatch');
if(constants.PROTOCOL_VERSION!==1||!['0.3.0','0.3.1'].includes(constants.APP_VERSION)||constants.APP_VERSION!==index.app)throw new Error('Unsupported upstream protocol/application version');
function freeze(value) {if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.freeze(value);for(const v of Object.values(value))freeze(v);}return value;}
freeze(raw);simdata.setSimData(raw);support.setGameData(null);bounds.rememberOfficialBounds(raw);
if(traits.length)await (await import(origin+'/js/battle/operatorTraits.js')).installOperatorTraits(raw,origin+'/sim/');
const ds=new simdata.DataSource(raw,null),battles=new Map();let paused=false;
const post=(type,payload={})=>parentPort.postMessage({type,...payload});
function report(entry,final=false,resend=false) {
  if(!entry.authoritative||entry.ended)return;
  post('report',{battleId:entry.id,message:{t:'b.progress',battleId:entry.id,...spec.battleProgress(entry.battle)}});
  if(final&&(!entry.reported||resend)) {
    entry.reported=true;
    let result=spec.compactResult(entry.battle.result());
    if(spec.fitResult)result=spec.fitResult(result,{bossLike:['boss','hidden'].includes(entry.kind),battleId:entry.id});
    post('report',{battleId:entry.id,message:{t:'b.result',battleId:entry.id,cs:index.cs,result}});
  }
}
function pump(entry) {
  if(entry.ended||!entry.authoritative||paused)return;
  const b=entry.battle,boss=['boss','hidden'].includes(entry.kind);
  // Normal solo fields may finish computationally early, using the actual engine.
  // Shared boss credits use the site's wall clock; never accelerate their reports.
  const target=boss?Math.max(0,entry.elapsed+(Date.now()-entry.started)/1000*entry.speed):Infinity;
  let count=0;
  while(!b.finished&&count++<120&&b.time<target)b.step();
  b.drainEvents();
  if(b.finished){report(entry,true);return;}
  if(Date.now()-entry.lastReport>=(boss?250:1000)){entry.lastReport=Date.now();report(entry);}
  entry.timer=setTimeout(()=>pump(entry),boss?16:0);
}
parentPort.on('message',async q=>{
  try {
    if(q.op==='validate')return post('reply',{id:q.id,result:protocol.validateC2S(q.message)||null});
    if(q.op==='map') {
      const field=camera.deployFieldOf(q.pub,q.myId),stage=raw.stages[q.pub.stageId];
      if(!stage)throw new Error('Unknown public stage');
      const overrides=placement.stageOverrides(q.own,id=>raw.effects[id]);
      const cells=[...placement.deployMap(stage,{...overrides,field})].map(([key,kind])=>{const [row,col]=key.split(',').map(Number);return {row,col,kind};});
      return post('reply',{id:q.id,result:{field,cells}});
    }
    if(q.op==='pause') {
      const next=!!q.on;
      if(next!==paused) {
        if(next)for(const e of battles.values()){e.elapsed+=(Date.now()-e.started)/1000*e.speed;clearTimeout(e.timer);}
        paused=next;
        if(!paused)for(const e of battles.values()){e.started=Date.now();pump(e);}
      }
      return;
    }
    if(q.op==='pool') {
      for(const e of battles.values())if(e.battle.sharedBoss?.sync)e.battle.sharedBoss.sync(q.message.hp,q.message.acked?.[e.fieldId]||0);
      return;
    }
    if(q.op==='end') {
      const e=battles.get(q.message.battleId);if(e){e.ended=true;clearTimeout(e.timer);battles.delete(e.id);}return;
    }
    if(q.op==='start') {
      const m=q.message;
      if(!m.authoritative||m.watch||m.done)return;
      if(m.spec?.cs!==index.cs)throw new Error('Battle content differs from loaded site content');
      const old=battles.get(m.battleId);
      if(old){if(old.reported)report(old,true,true);return;}
      for(const e of battles.values()){e.ended=true;clearTimeout(e.timer);}battles.clear();
      const battle=spec.createBattleFromSpec(m.spec,ds,{recordEvents:false,logger:{warn(){},error(){},info(){}}});
      spec.attachLpMeter(battle);
      const e={id:m.battleId,fieldId:m.fieldId,kind:m.kind,battle,authoritative:true,ended:false,reported:false,
        started:Date.now(),elapsed:m.elapsed||0,speed:m.speed||2,lastReport:Date.now()};
      battles.set(e.id,e);pump(e);return;
    }
  }catch(error) {
    if(q.id)post('reply',{id:q.id,error:String(error.message)});
    else post('failure',{error:String(error.message)});
  }
});
post('ready',{app:index.app,protocol:constants.PROTOCOL_VERSION,content:index.cs,capabilities:Object.keys(protocol.C2S)});
