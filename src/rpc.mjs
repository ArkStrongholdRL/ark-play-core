// Native game-site /ws adapter. No private gameplay RPC or recording endpoints.
import {readFileSync} from 'node:fs';
import {resolveConfig} from './config.mjs';
import WebSocket from 'ws';
import {SiteRuntime} from './site.mjs';
import {canAct,projectNative} from './native-view.mjs';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const PUBLIC_KEYS=['phase','round','lastRound','modeId','difficulty','stageId','setupRevision','factions','disabledBonds',
  'bannedChess','bossId','bossRound','hiddenRound','bossPairs','spRound','combatMode','paused','players','draft','sp'];
export class GameClient {
  constructor(config={}) {
    this.config=resolveConfig(config);config=this.config;
    this.url=config.url||null;this.name=config.name;
    if(this.url) {
      const u=new URL(this.url);
      if(u.username||u.password||u.search||u.hash||u.pathname!=='/ws')throw new Error('Use the game site /ws URL without credentials/query/hash');
      if(u.protocol!=='wss:'&&!(u.protocol==='ws:'&&['127.0.0.1','[::1]','localhost'].includes(u.hostname)))throw new Error('Remote game connections require WSS');
      this.origin=u.origin.replace(/^ws/,'http');
    }
    this.headers=config.headersFile?JSON.parse(readFileSync(config.headersFile,'utf8')):{};
    if(!this.headers||Array.isArray(this.headers)||Object.values(this.headers).some(v=>typeof v!=='string'))throw new Error('Site headers must be a string map');
    const bearer=config.token||(config.tokenFile?readFileSync(config.tokenFile,'utf8').trim():process.env.ARK_AGENT_TOKEN);
    if(bearer)this.headers.Authorization='Bearer '+bearer;
    this.sessionToken=config.sessionFile?readFileSync(config.sessionFile,'utf8').trim():null;
    this.pending=new Map();this.rid=0;this.revision=0;this.ws=null;this.connecting=null;this.site=null;
    this.pub=null;this.own=null;this.room=null;this.result=null;this.lastPush=0;this.uncertain=false;
    this.sendTail=Promise.resolve();this.nextSend=0;this.combatQueue=[];this.authorities=new Set();
    this.stateWaiters=new Set();this.stateVersion=0;this.roomClosed=null;
  }
  wake() {this.stateVersion++;for(const notify of [...this.stateWaiters])notify();}
  fail(message) {this.siteError=String(message);this.wake();}
  changed(signal,since=this.stateVersion,timeout) {
    signal?.throwIfAborted();
    return new Promise((resolve,reject)=>{
      let timer;
      const cleanup=()=>{clearTimeout(timer);this.stateWaiters.delete(notify);signal?.removeEventListener('abort',abort);};
      const notify=()=>{cleanup();resolve();};
      const abort=()=>{cleanup();reject(signal.reason);};
      this.stateWaiters.add(notify);signal?.addEventListener('abort',abort,{once:true});
      if(timeout!==undefined)timer=setTimeout(notify,timeout);
      if(signal?.aborted)abort();else if(since!==this.stateVersion)notify();
    });
  }
  update(key,value) {
    if(JSON.stringify(this[key])!==JSON.stringify(value)){this[key]=value;this.revision++;}
    this.lastPush=Date.now();
    this.wake();
  }
  receive(m) {
    if(m.t==='welcome') {
      if(m.version!==1){this.siteError='Unsupported server protocol';this.ws.close();return;}
      if(this.sessionToken&&!m.resumed){this.sessionLost=true;this.pub=null;this.own=null;this.room=null;this.result=null;}
      this.sessionToken=m.token;this.myId=m.playerId;this.welcome=m;
    }else if(m.t==='room.state'){this.roomClosed=null;this.update('room',m);}
    else if(m.t==='room.closed'){this.roomClosed=String(m.reason||'closed').slice(0,80);this.update('room',null);}
    else if(m.t==='m.public') {
      this.update('pub',Object.fromEntries(PUBLIC_KEYS.filter(k=>k in m).map(k=>[k,m[k]])));
      this.site?.send('pause',{on:!!m.paused});
    }else if(m.t==='m.private')this.update('own',m);
    else if(m.t==='m.result')this.update('result',Object.fromEntries(['victory','roundsPassed','hiddenReached','hiddenCleared','reason','teamLp','players'].map(k=>[k,m[k]])));
    else if(['b.start','b.pool','b.end'].includes(m.t)) {
      if(m.t==='b.start'&&m.authoritative&&!m.done)this.authorities.add(m.battleId);
      if(m.t==='b.end')this.authorities.delete(m.battleId);
      const job={op:m.t.slice(2)==='start'?'start':m.t.slice(2)==='pool'?'pool':'end',message:m};
      if(this.site?.ready)this.site.send(job.op,{message:m});
      else {if(this.combatQueue.length>=16)this.combatQueue.shift();this.combatQueue.push(job);}
    }else if(m.t==='b.rehearsal') {
      // Ask the existing server fallback to handle bot rehearsals; do not choose layouts.
      this.request({t:'b.rehearsalResult',taskId:m.taskId,error:true}).catch(()=>{});
    }
    const p=this.pending.get(m.rid);
    if(p&&['welcome','ok','error','pong'].includes(m.t)) {
      this.pending.delete(m.rid);clearTimeout(p.timer);
      if(m.t==='error')p.reject(Object.assign(new Error(m.code||m.error||'Server rejected request'),{code:m.code||m.error,detail:m.detail}));
      else p.resolve(m);
    }
  }
  async connect(loadRuntime=true) {
    if(!this.url)throw new Error('Configure the game site WSS /ws URL');
    if(this.ws?.readyState===WebSocket.OPEN&&this.welcome&&(!loadRuntime||this.site?.ready))return;
    if(this.connecting)return this.connecting;
    this.connecting=(async()=>{
      const ws=new WebSocket(this.url,{headers:this.headers,maxPayload:8*1024*1024,handshakeTimeout:10_000});
      this.ws=ws;this.welcome=null;
      ws.on('error',()=>{});
      ws.on('message',bytes=>{try{this.receive(JSON.parse(bytes.toString()));}catch{this.fail('Unsupported server message');ws.close();}});
      ws.on('close',code=>{
        if(this.ws===ws){this.ws=null;this.welcome=null;}
        if(code===4001)this.replaced=true;
        for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('Connection lost; use ark_view before another action'));}
        if(this.pending.size)this.uncertain=true;this.pending.clear();this.authorities.clear();
        this.wake();
      });
      await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
      await this.request({t:'hello',name:this.name,version:1,noReplace:true,controller:{kind:'llm',client:this.config.client==='dsh-plugin'?'dsh-plugin':'codex-mcp'},...(this.sessionToken?{token:this.sessionToken}:{})});
      if(!this.welcome)throw new Error(this.siteError||'No compatible welcome');
      await this.quiet();
      if(this.sessionLost)throw new Error('Site session expired; use ark_finish to acknowledge before starting a new game');
      if(!loadRuntime)return;
      const cs=this.room?.content?.cs||this.welcome.content?.vanilla;
      if(!this.site||this.site.index?.cs!==cs) {
        if(this.site)await this.site.close();this.siteError=null;
        const site=new SiteRuntime(this.origin,this.headers,m=>this.report(m),e=>this.fail(e));this.site=site;
        try{await site.load(cs);}catch(e){await site.close();this.site=null;ws.close();this.ws=null;this.welcome=null;throw e;}
        for(const q of this.combatQueue.splice(0))site.send(q.op,{message:q.message});
        site.send('pause',{on:!!this.pub?.paused});
      }
    })();
    try{await this.connecting;}finally{this.connecting=null;}
  }
  request(message) {
    const ws=this.ws,rid=++this.rid;
    const sent=this.sendTail.catch(()=>{}).then(async()=>{
      await pause(Math.max(0,this.nextSend-Date.now()));this.nextSend=Date.now()+40;
      if(!ws||ws!==this.ws||ws.readyState!==WebSocket.OPEN)throw new Error('Game connection unavailable');
      return await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{this.pending.delete(rid);this.uncertain=true;reject(new Error('Native request timed out; use ark_view and do not blindly retry'));},15_000);
        this.pending.set(rid,{resolve,reject,timer});
        ws.send(JSON.stringify({...message,rid}),error=>{if(error){this.pending.delete(rid);clearTimeout(timer);this.uncertain=true;reject(error);}});
      });
    });
    this.sendTail=sent;return sent;
  }
  report(message) {
    if(!this.authorities.has(message.battleId)||!this.ws||this.pub?.paused)return;
    this.request(message).catch(e=>this.fail('Site did not accept combat report: '+e.message));
  }
  // A native ack is not a state frame: coalesce the public/private push burst.
  async quiet(signal) {
    const start=Date.now(),end=start+500;
    for(;;) {
      signal?.throwIfAborted();
      const version=this.stateVersion,now=Date.now();
      const remaining=Math.min(end-now,Math.max(start,this.lastPush)+60-now);
      if(remaining<=0)return;
      await this.changed(signal,version,remaining);
    }
  }
  async view() {
    await this.quiet();
    if(!this.pub||!this.own)return {status:'lobby',roomCode:this.room?.code||null,protocol:this.site?.ready?.protocol,application:this.site?.ready?.app};
    const snapshot=structuredClone({pub:this.pub,own:this.own,result:this.result,room:this.room||{code:'ended'},revision:this.revision});
    const map=await this.site.request('map',{pub:snapshot.pub,own:snapshot.own,myId:this.myId});
    return {...projectNative({...snapshot,myId:this.myId,runtime:this.site,map}),...(this.siteError?{notice:this.siteError}:{})};
  }
  async settle(signal,readyRound,waitForStart=false) {
    await this.quiet(signal);
    for(;;) {
      signal?.throwIfAborted();
      if(this.result)return;
      if(this.roomClosed)throw new Error('Room closed: '+this.roomClosed+'; waiting stopped. Do not poll or automatically rejoin');
      if(this.siteError)throw new Error(this.siteError+'; recover with ark_view, do not repeat accepted actions');
      if(!this.ws||this.ws.readyState!==WebSocket.OPEN)throw new Error('Connection lost during settlement; recover with ark_view, do not repeat accepted actions');
      // A ready acknowledgement may precede its state push. Never return the
      // old prep snapshot as if it were a new opportunity to buy or ready.
      const oldPrep=readyRound!==undefined&&this.pub?.round===readyRound&&
        this.pub?.phase==='PREP'&&!this.own?.personalChoice;
      // A lobby, another player's turn, a paused site and combat are all waits,
      // not model decisions. Keep this one call pending until a WS push matters.
      if((!waitForStart&&!this.room&&!this.pub)||(!oldPrep&&canAct(this.pub,this.own,this.myId,this.result)))return;
      await this.changed(signal);
      await this.quiet(signal);
    }
  }
  normalize(action) {
    const {type,...args}=action;
    const message={t:type==='confirm'?'g.infoReady':'g.'+type,...args};
    if(type==='confirm')message.setupRevision=this.pub.setupRevision;
    if(type==='ready')message.ready??=true;
    if(type==='choice'&&this.own.personalChoice)message.choiceId=this.own.personalChoice.id;
    return message;
  }
  async call(payload,signal) {
    signal?.throwIfAborted();if(this.inCall)throw new Error('One gameplay call at a time');this.inCall=true;
    try {
      if(this.replaced&&payload.op==='finish') {
        this.replaced=false;this.sessionToken=null;this.pub=null;this.own=null;this.room=null;this.result=null;
        await this.close();return {status:'replaced-session-detached'};
      }
      if(this.replaced)throw new Error('Site session replaced; automatic reconnect is disabled. Use ark_finish to detach locally');
      if(this.sessionLost&&payload.op==='finish'){this.sessionLost=false;this.sessionToken=null;await this.close();return {status:'expired-session-acknowledged'};}
      await this.connect(payload.op!=='finish');
      if(this.uncertain&&!['view','finish'].includes(payload.op))throw new Error('Use ark_view to resync the uncertain action outcome');
      if(payload.op==='finish') {
        if(this.room)await this.request({t:'room.leave'});
        this.authorities.clear();await this.close();return {status:'left',storage:'managed-by-game-site'};
      }
      if(this.room?.content?.vanilla===false)throw new Error('Gameplay plugin content sets are not supported by this client version');
      if(payload.op==='view'){await this.settle(signal);const result=await this.view();this.uncertain=false;return result;}
      if(payload.op==='start') {
        if(this.room?.inMatch)throw new Error('A site game is already running; use ark_view or explicitly finish');
        this.result=null;this.pub=null;this.own=null;this.roomClosed=null;this.combatQueue=[];this.authorities.clear();this.revision++;
        const code=String(payload.roomCode||'').trim().toUpperCase();
        if(code) {
          if(!/^[A-Z0-9]{4}$/.test(code))throw new Error('Expected a four-character room code');
          await this.request({t:'room.join',code});
          if(this.room?.content?.vanilla===false)throw new Error('Gameplay plugin content sets are not supported by this client version');
          await this.request({t:'room.ready',ready:true});
        } else {
          await this.request({t:'room.create',mode:'solo',difficulty:payload.difficulty||'ABYSS'});
          await this.request({t:'room.start'});
        }
        await this.settle(signal,undefined,true);return await this.view();
      }
      if(payload.op==='lookup') {
        const {kind,id,text='',limit=3}=payload.query,table=this.site.raw[kind];
        if(!table)throw new Error('Unsupported public table');
        const entries=Object.entries(table).filter(([key,entry])=>id?key===id:JSON.stringify(entry).toLowerCase().includes(text.toLowerCase())).slice(0,limit).map(([key,entry])=>{
          const fields=['id','name','tier','position','profession','bonds','desc','description','trait','talents','skill','skills','module',
            'stats','rangeGrid','garrisonIds','tokens','ownerRange','placeable','itemType','abilities'];
          return {id:key,...Object.fromEntries(fields.filter(k=>k in entry).map(k=>[k,entry[k]]))};
        });return {result:{kind,entries}};
      }
      if(payload.op!=='act')throw new Error('Unsupported gameplay operation');
      await this.quiet();
      if(payload.revision!==this.revision)return {...await this.view(),error:'STALE_CLIENT_SNAPSHOT',executed:[]};
      if(!Array.isArray(payload.steps)||payload.steps.length<1||payload.steps.length>8)throw new Error('Expected1..8 explicit steps');
      for(const step of payload.steps) {
        const invalid=await this.site.request('validate',{message:this.normalize(step.action)});
        if(invalid)throw new Error('Unsupported native intent; batch not sent: '+invalid);
      }
      if(payload.revision!==this.revision)return {...await this.view(),error:'STALE_CLIENT_SNAPSHOT',executed:[]};
      const executed=[];let readyRound;
      for(const step of payload.steps) {
        signal?.throwIfAborted();
        if(!canAct(this.pub,this.own,this.myId,this.result))break;
        const phase=this.pub.phase,round=this.pub.round,message=this.normalize(step.action);
        const invalid=await this.site.request('validate',{message});if(invalid)throw new Error('Unsupported native intent: '+invalid);
        try {
          await this.request(message);executed.push({action:step.action,reason:step.reason,accepted:true});
          if(step.action.type==='ready')readyRound=round;
        }catch(e) {
          if(!e.code)throw e;
          executed.push({action:step.action,reason:step.reason,accepted:false,result:{error:e.code,detail:e.detail}});break;
        }
        await this.quiet();
        if(readyRound!==undefined||this.pub.phase!==phase||this.pub.round!==round||this.result||!canAct(this.pub,this.own,this.myId,this.result))break;
      }
      await this.settle(signal,readyRound);
      return {...await this.view(),executed,...(!executed.length?{notice:'当前没有可提交的玩家决策；本批未执行，请依据新局面重新选择。'}:{})};
    }catch(e){if(signal?.aborted)this.uncertain=true;throw e;}
    finally{this.inCall=false;}
  }
  async close() {
    const ws=this.ws;this.ws=null;this.welcome=null;
    this.wake();
    if(ws){ws.close();const timer=setTimeout(()=>ws.terminate(),1000);timer.unref();}
    this.authorities.clear();this.combatQueue=[];
    const site=this.site;this.site=null;if(site){site.onFailure=()=>{};await site.close();}
  }
}
