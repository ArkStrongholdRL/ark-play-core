#!/usr/bin/env node
// Explicit setup only. No game connections, plugin installation or credential output.
import {existsSync,mkdirSync,writeFileSync,renameSync,rmSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DEFAULT_SITE_URL,normalizeSiteUrl,normalizeRoomCode,configPath,readConfig} from '../src/config.mjs';
const args=process.argv.slice(2);
const flags=new Set(['--url','--room-code','--headers-file','--token-file','--session-file','--out']);
const options={};let update=false;
if(args.includes('--help')) {
  console.log('node configure.mjs [--url https://ark.minyako.top] [--room-code AB12] [--update] [--headers-file private.json] [--token-file site-bearer-token] [--session-file native-session-token] [--out client.json]');
  console.log('No --url: use the saved site when updating, otherwise '+DEFAULT_SITE_URL+'. Empty --room-code opens solo games. --update preserves other saved fields.');
} else {
  for(let i=0;i<args.length;i++) {
    if(args[i]==='--update'){update=true;continue;}
    if(!flags.has(args[i]))throw new Error('Unknown configuration option: '+args[i]);
    const flag=args[i],value=args[++i];
    if(value===undefined||value.startsWith('--'))throw new Error('Missing value for '+flag);
    options[flag]=value;
  }
  const target=resolve(options['--out']||configPath());
  const previous=update?readConfig(target):{};
  const url=normalizeSiteUrl(options['--url']??previous.url??DEFAULT_SITE_URL);
  const roomCode=normalizeRoomCode(options['--room-code']??previous.roomCode);
  const extra={};
  for(const [key,flag] of [['headersFile','--headers-file'],['tokenFile','--token-file'],['sessionFile','--session-file']]) {
    if(options[flag]!==undefined) {
      const path=resolve(options[flag]);if(!existsSync(path))throw new Error(flag+' does not exist');extra[key]=path;
    }
  }
  const content=JSON.stringify({...previous,url,roomCode,...extra},null,2)+'\n';
  mkdirSync(dirname(target),{recursive:true,mode:0o700});
  if(update) {
    const temporary=target+'.'+randomUUID()+'.tmp';
    try {writeFileSync(temporary,content,{mode:0o600,flag:'wx'});renameSync(temporary,target);}
    finally {rmSync(temporary,{force:true});}
  } else writeFileSync(target,content,{mode:0o600,flag:'wx'});
  console.log((update?'Updated ':'Created ')+target+'; no credentials printed. Settings apply to the next MCP session.');
}
