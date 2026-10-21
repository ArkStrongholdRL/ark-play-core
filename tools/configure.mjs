#!/usr/bin/env node
// Explicit user-invoked setup. Does not connect, install a plugin or print credentials.
import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {homedir} from 'node:os';
const args=process.argv.slice(2);
const option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
if(args.includes('--help')) {
  console.log('node configure.mjs --url wss://game-host/ws [--headers-file private.json] [--token-file site-bearer-token] [--session-file native-session-token] [--out client.json]');
} else {
  const url=option('--url'),file=option('--token-file');
  if(!url)throw new Error('--url is required');
  const u=new URL(url);
  if(u.username||u.password||u.search||u.hash||u.pathname!=='/ws'||
    (u.protocol!=='wss:'&&!(u.protocol==='ws:'&&['127.0.0.1','[::1]','localhost'].includes(u.hostname))))throw new Error('Use WSS, or loopback WS, at the game site endpoint');
  const tokenFile=file?resolve(file):undefined;
  if(tokenFile&&!existsSync(tokenFile))throw new Error('Token file does not exist');
  const extra={};
  for(const [key,flag] of [['headersFile','--headers-file'],['sessionFile','--session-file']]) {
    const value=option(flag);if(value){extra[key]=resolve(value);if(!existsSync(extra[key]))throw new Error(flag+' does not exist');}
  }
  const target=resolve(option('--out')||join(homedir(),'.config/ark-play/client.json'));
  mkdirSync(dirname(target),{recursive:true,mode:0o700});
  writeFileSync(target,JSON.stringify({url,...(tokenFile?{tokenFile}:{}),...extra},null,2)+'\n',{mode:0o600,flag:'wx'});
  console.log('Created '+target+'; no credentials printed. Existing configuration is never overwritten.');
}
