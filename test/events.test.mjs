import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocketServer} from 'ws';
import {GameClient} from '../src/rpc.mjs';

const cs='a'.repeat(64);
async function until(check) {
  const deadline=Date.now()+2000;
  while(!check()) {assert.ok(Date.now()<deadline,'timed out waiting for test event');await delay(5);}
}
async function fixture() {
  const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');
  const received=[];let socket;
  const room={t:'room.state',code:'AB12',inMatch:false,content:{cs,vanilla:true}};
  server.on('connection',ws=>{
    socket=ws;ws.on('message',bytes=>{
      const m=JSON.parse(bytes);received.push(m);
      if(m.t==='hello')ws.send(JSON.stringify({t:'welcome',rid:m.rid,version:1,playerId:'me',token:'test-session',resumed:true,content:{vanilla:cs}}));
      else {
        if(m.t==='room.join')ws.send(JSON.stringify(room));
        ws.send(JSON.stringify({t:'ok',rid:m.rid}));
      }
    });
  });
  const client=new GameClient({url:'ws://127.0.0.1:'+server.address().port,configFile:'/tmp/nonexistent-ark-event-test-config'});
  // Only scheduling/protocol behavior is under test; do not load or simulate a game.
  client.site={ready:{},index:{cs},send(){},request:async()=>null,close:async()=>{}};
  client.view=async()=>({phase:client.pub?.phase,round:client.pub?.round,terminal:!!client.result});
  const push=message=>socket.send(JSON.stringify(message));
  const pub=(phase,extra={})=>push({t:'m.public',phase,round:0,players:[{playerId:'me',ready:false}],...extra});
  const own=(extra={})=>push({t:'m.private',alive:true,ready:false,...extra});
  return {client,received,push,pub,own,room,async close(){await client.close();for(const ws of server.clients)ws.terminate();await new Promise(resolve=>server.close(resolve));}};
}
function track(promise) {
  let settled=false;promise.then(()=>settled=true,()=>settled=true);
  return {promise,get settled(){return settled;}};
}

test('one start waits through the lobby and other player turns without querying the server',async()=>{
  const f=await fixture();const controller=new AbortController();
  const started=track(f.client.call({op:'start',roomCode:'AB12'},controller.signal));
  try {
    await until(()=>f.received.some(m=>m.t==='room.ready'));await delay(100);
    assert.equal(started.settled,false,'lobby must not return a polling opportunity');
    f.push({...f.room,inMatch:true});f.pub('INFO_CHECK',{players:[{playerId:'me',ready:true}]});f.own();await delay(100);
    assert.equal(started.settled,false,'wait for the humans to confirm');
    f.pub('BAND_DRAFT',{draft:{turn:'teammate',picks:{}}});await delay(100);
    assert.equal(started.settled,false,'another player turn must not wake the model');
    assert.deepEqual(f.received.map(m=>m.t),['hello','room.join','room.ready']);
    f.pub('BAND_DRAFT',{draft:{turn:'me',picks:{}}});
    assert.equal((await started.promise).phase,'BAND_DRAFT');assert.equal(f.client.stateWaiters.size,0);
  } finally {controller.abort();await started.promise.catch(()=>{});await f.close();}
});

test('ready waits for humans, combat and resume, stops the batch, and returns the next round once',async()=>{
  const f=await fixture();let action;
  try {
    await f.client.connect();f.push({...f.room,inMatch:true});f.pub('PREP');f.own();await f.client.quiet();
    action=track(f.client.call({op:'act',revision:f.client.revision,steps:[{action:{type:'ready'},reason:'完成布阵'},{action:{type:'refresh'},reason:'must not execute next round'}]}));
    await until(()=>f.received.some(m=>m.t==='g.ready'));f.own({ready:true});await delay(100);
    assert.equal(action.settled,false);
    f.pub('COMBAT');await delay(100);assert.equal(action.settled,false);
    f.pub('PREP',{round:1,paused:true});f.own();await delay(100);assert.equal(action.settled,false,'pause is an event wait');
    f.pub('PREP',{round:1,paused:false});
    const result=await action.promise;assert.equal(result.round,1);assert.equal(result.executed.length,1);
    assert.equal(f.received.some(m=>m.t==='g.refresh'),false);assert.equal(f.client.stateWaiters.size,0);
  } finally {await f.close();await action?.promise.catch(()=>{});}
});

test('view waits for site resume and terminal results, and room closure releases the call',async()=>{
  const f=await fixture();let pending;
  try {
    await f.client.connect();f.push({...f.room,inMatch:true});f.pub('PREP',{paused:true});f.own();await f.client.quiet();
    pending=track(f.client.call({op:'view'}));await delay(100);assert.equal(pending.settled,false);
    f.pub('PREP',{paused:false});assert.equal((await pending.promise).phase,'PREP');
    f.pub('COMBAT');await f.client.quiet();pending=track(f.client.call({op:'view'}));await delay(100);
    assert.equal(pending.settled,false);f.push({t:'m.result',victory:true,players:[]});
    assert.equal((await pending.promise).terminal,true);
    f.client.result=null;pending=track(f.client.call({op:'view'}));await delay(100);
    f.push({t:'room.closed',reason:'kicked'});await assert.rejects(pending.promise,/Room closed: kicked/);
    assert.equal(f.client.stateWaiters.size,0);
  } finally {await f.close();await pending?.promise.catch(()=>{});}
});

test('cancellation and disconnection clean listeners; a stale event version cannot lose a wakeup',async()=>{
  const f=await fixture();const controller=new AbortController();let pending;
  try {
    await f.client.connect();f.push(f.room);await f.client.quiet();
    pending=track(f.client.call({op:'view'},controller.signal));await until(()=>f.client.stateWaiters.size>0);
    controller.abort(new Error('user cancelled'));await assert.rejects(pending.promise,/user cancelled/);
    assert.equal(f.client.stateWaiters.size,0);assert.equal(f.client.uncertain,true);
    const version=f.client.stateVersion;f.client.wake();await f.client.changed(undefined,version);
    assert.equal(f.client.stateWaiters.size,0);
    pending=track(f.client.call({op:'view'}));await delay(100);assert.equal(pending.settled,false);
    for(const ws of f.client.ws?[f.client.ws]:[])ws.terminate();
    await assert.rejects(pending.promise,/Connection lost/);assert.equal(f.client.stateWaiters.size,0);
  } finally {controller.abort();await f.close();await pending?.promise.catch(()=>{});}
});
