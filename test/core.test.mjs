import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createTools} from '../src/tools.mjs';
import {packageClient} from '../tools/package.mjs';

test('configured room, per-call override and solo routes use native lobby intents',async()=>{
  const r=createTools({configFile:'/tmp/nonexistent-ark-core-test-config',roomCode:'ZZ99'});
  const sent=[];
  r.client.connect=async()=>{};r.client.settle=async()=>{};r.client.view=async()=>({status:'lobby'});
  r.client.request=async message=>{sent.push(message);};
  const start=r.tools.find(t=>t.name==='ark_start');
  try {
    await start.execute(start.schema.parse({roomCode:'ab12'}));
    assert.deepEqual(sent,[{t:'room.join',code:'AB12'},{t:'room.ready',ready:true}]);
    sent.length=0;await start.execute(start.schema.parse({}));assert.equal(sent[0].code,'ZZ99');
    sent.length=0;await start.execute(start.schema.parse({roomCode:''}));
    assert.deepEqual(sent,[{t:'room.create',mode:'solo',difficulty:'ABYSS'},{t:'room.start'}]);
    assert.equal(start.schema.safeParse({roomCode:'!'}).success,false);
    sent.length=0;r.client.request=async message=>{sent.push(message);if(message.t==='room.join')r.client.room={version:'act1autochess'};};
    await assert.rejects(start.execute(start.schema.parse({roomCode:'AB12'})),/Historical-version rooms/);
    assert.deepEqual(sent,[{t:'room.join',code:'AB12'}],'unsupported historical rooms are never readied');
    r.client.room=null;
    sent.length=0;r.client.request=async message=>{sent.push(message);throw new Error('ROOM_NOT_FOUND');};
    await assert.rejects(start.execute(start.schema.parse({roomCode:'AB12'})),/ROOM_NOT_FOUND/);
    assert.deepEqual(sent,[{t:'room.join',code:'AB12'}]);
  }finally{await r.close();}
});

test('ZIP packaging tolerates absent optional PUBLISH and retains host/core source and public art',async()=>{
  const scratch=await mkdtemp(join(tmpdir(),'ark-core-package-test-'));
  const core=join(scratch,'core'),host=join(scratch,'host'),output=join(scratch,'out');
  async function file(root,name,content){const path=join(root,name);await mkdir(join(path,'..'),{recursive:true});await writeFile(path,content);}
  try {
    await file(core,'package.json',JSON.stringify({name:'@arkstrongholdrl/ark-play-core',version:'1.0.0'}));
    await file(core,'tools/configure.mjs','// configure');await file(core,'src/tools.mjs','// shared');
    await file(core,'PROVENANCE.md','source attribution');await file(core,'LICENSE','GPL');
    await file(host,'package.json',JSON.stringify({name:'dsh-ark-stronghold',version:'1.0.0'}));
    for(const name of ['README.md','LICENSE','configure.mjs','client.mjs','site-url.mjs','site-loader.mjs','public/art.png','dist/public/art.png','dist/index.mjs'])await file(host,name,'fixture '+name);
    const result=await packageClient({kind:'dsh',root:host,sharedRoot:core,output});
    const archive=join(output,result.filename);
    const names=execFileSync('unzip',['-Z1',archive],{encoding:'utf8'}).split('\n');
    for(const name of ['public/art.png','corresponding-source/dsh-plugin/public/art.png','corresponding-source/dsh-plugin/client.mjs','corresponding-source/ark-play-core/PROVENANCE.md'])assert.ok(names.includes('dsh-ark-stronghold/'+name),name);
    assert.equal((await readFile(archive)).length,result.bytes);
    await assert.rejects(packageClient({kind:'dsh',root:host,sharedRoot:core,output}),/Archive already exists/);
  }finally{await rm(scratch,{recursive:true,force:true});}
});
