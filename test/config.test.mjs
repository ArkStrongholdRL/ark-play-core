import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolveConfig,normalizeSiteUrl,normalizeRoomCode,normalizePlayerName} from '../src/config.mjs';
import {createTools} from '../src/tools.mjs';
const cli=fileURLToPath(new URL('../tools/configure.mjs',import.meta.url));

test('default site and file/environment/host settings resolve in order',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'ark-settings-')),file=join(folder,'client.json');
 try {
  assert.equal(resolveConfig({configFile:file},{}).url,'wss://ark.minyako.top/ws');
  assert.equal(resolveConfig({configFile:file},{}).name,'Ark Agent');
  await writeFile(file,JSON.stringify({url:'https://file.example',roomCode:'ab12',name:'Doctor'}));
  assert.equal(resolveConfig({configFile:file},{}).roomCode,'AB12');
  const env={ARK_AGENT_URL:'https://env.example',ARK_AGENT_ROOM_CODE:'cd34'};
  assert.equal(resolveConfig({configFile:file},env).url,'wss://env.example/ws');
  assert.equal(resolveConfig({configFile:file},env).roomCode,'CD34');
  const host=resolveConfig({configFile:file,url:'https://host.example',roomCode:''},env);
  assert.equal(host.url,'wss://host.example/ws');assert.equal(host.roomCode,'');assert.equal(host.name,'Doctor');
  assert.equal(resolveConfig({configFile:file},{ARK_AGENT_NAME:'  小刻  '}).name,'小刻');
  assert.equal(resolveConfig({configFile:file,name:'Codex'},{ARK_AGENT_NAME:'小刻'}).name,'Codex');
  assert.equal(normalizePlayerName('  '),'Ark Agent');
  assert.throws(()=>normalizePlayerName('1234567890123'),/12/);
  for(const invalid of ['http://remote.example','https://name:pass@host.example','https://host.example?secret=1','https://host.example/path'])assert.throws(()=>normalizeSiteUrl(invalid));
  assert.equal(normalizeSiteUrl('http://localhost:4000'),'ws://localhost:4000/ws');
  assert.equal(normalizeRoomCode(' ab12 '),'AB12');assert.throws(()=>normalizeRoomCode('ABC'));
  await writeFile(file,'[]');assert.throws(()=>resolveConfig({configFile:file},{}),/object/);
 }finally{await rm(folder,{recursive:true,force:true});}
});

test('ark_start uses saved room default while empty per-call room selects solo',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'ark-settings-')),file=join(folder,'client.json');
 let runtime;
 try {
  await writeFile(file,JSON.stringify({url:'https://file.example',roomCode:'ab12'}));
  runtime=createTools({configFile:file});const sent=[];
  runtime.client.connect=async()=>{};runtime.client.settle=async()=>{};
  runtime.client.view=async()=>({status:'lobby'});runtime.client.request=async m=>sent.push(m);
  const start=runtime.tools.find(t=>t.name==='ark_start');
  await start.execute(start.schema.parse({}));assert.equal(sent[0].code,'AB12');
  sent.length=0;await start.execute(start.schema.parse({roomCode:''}));assert.equal(sent[0].t,'room.create');
 }finally{await runtime?.close();await rm(folder,{recursive:true,force:true});}
});

test('CLI saves normalized settings, refuses overwrite, and explicitly updates without losing credentials',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'ark-cli-')),file=join(folder,'client.json');
 try {
  execFileSync(process.execPath,[cli,'--out',file,'--room-code','ab12']);
  assert.deepEqual(JSON.parse(await readFile(file,'utf8')),{url:'wss://ark.minyako.top/ws',roomCode:'AB12'});
  if(process.platform!=='win32')assert.equal((await stat(file)).mode&0o777,0o600);
  assert.notEqual(spawnSync(process.execPath,[cli,'--out',file]).status,0);
  await writeFile(file,JSON.stringify({url:'https://keep.example',roomCode:'AB12',token:'private-test-token',name:'Doctor'}));
  const output=execFileSync(process.execPath,[cli,'--out',file,'--room-code','','--update'],{encoding:'utf8'});
  const saved=JSON.parse(await readFile(file,'utf8'));
  assert.equal(saved.token,'private-test-token');assert.equal(saved.name,'Doctor');assert.equal(saved.url,'wss://keep.example/ws');assert.equal(saved.roomCode,'');
  assert.ok(!output.includes(saved.token));
  execFileSync(process.execPath,[cli,'--out',file,'--update','--name','  小刻  ']);
  const renamed=JSON.parse(await readFile(file,'utf8'));
  assert.equal(renamed.name,'小刻');assert.equal(renamed.token,saved.token);assert.equal(renamed.url,saved.url);assert.equal(renamed.roomCode,saved.roomCode);
  const client=createTools({configFile:file});
  try {assert.equal(client.client.name,'小刻');}finally{await client.close();}
  const before=await readFile(file,'utf8');
  assert.notEqual(spawnSync(process.execPath,[cli,'--out',file,'--update','--name','1234567890123']).status,0);
  assert.equal(await readFile(file,'utf8'),before);
  assert.notEqual(spawnSync(process.execPath,[cli,'--out',file,'--update','--room-code','bad!']).status,0);
  assert.equal(await readFile(file,'utf8'),before);
  assert.notEqual(spawnSync(process.execPath,[cli,'--out']).status,0);
  execFileSync(process.execPath,[cli,'--out',file,'--update','--name','']);
  assert.equal(JSON.parse(await readFile(file,'utf8')).name,'Ark Agent');
 }finally{await rm(folder,{recursive:true,force:true});}
});
