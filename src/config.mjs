// Shared site/room settings. Credentials remain private to the native client.
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
export const DEFAULT_SITE_URL='https://ark.minyako.top';
export function defaultPlayerName(client) {
  return {'dsh-plugin':'蓝色大肥鱼','codex-mcp':'笨蛋大肥龙'}[client]||'Ark Agent';
}
export function normalizePlayerName(value,fallback='Ark Agent') {
  const name=String(value??'').trim();
  if(name.length>12)throw new Error('玩家名最多 12 个字符');
  return name||fallback;
}
export function normalizeSiteUrl(value) {
  const input=String(value??'').trim();
  if(!input)return '';
  let url;try{url=new URL(input);}catch{throw new Error('请输入完整的游戏站网址，例如 '+DEFAULT_SITE_URL);}
  if(url.username||url.password||url.search||url.hash||!['/','/ws','/ws/'].includes(url.pathname))throw new Error('游戏站地址只支持站点根路径或 /ws，不能包含账号、查询参数或片段');
  const protocol={https:'wss:',http:'ws:',wss:'wss:',ws:'ws:'}[url.protocol.slice(0,-1)];
  if(!protocol)throw new Error('游戏站地址需要 https:// 或 wss://');
  if(protocol==='ws:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new Error('远程游戏站必须使用 HTTPS / WSS；HTTP / WS 仅限本机回环地址');
  return protocol+'//'+url.host+'/ws';
}
export function normalizeRoomCode(value) {
  const code=String(value??'').trim().toUpperCase();
  if(code&&!/^[A-Z0-9]{4}$/.test(code))throw new Error('房间号须为四位字母或数字');
  return code;
}
export function configPath(config={},env=process.env) {
  return config.configFile||env.ARK_AGENT_CONFIG_FILE||join(homedir(),'.config/ark-play/client.json');
}
export function readConfig(file) {
  if(!existsSync(file))return {};
  const value=JSON.parse(readFileSync(file,'utf8'));
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Client configuration must be an object');
  return value;
}
export function resolveConfig(config={},environment=process.env) {
  const defaults=readConfig(configPath(config,environment));
  const env=Object.fromEntries(Object.entries({url:environment.ARK_AGENT_URL,roomCode:environment.ARK_AGENT_ROOM_CODE,name:environment.ARK_AGENT_NAME,
    tokenFile:environment.ARK_AGENT_TOKEN_FILE,headersFile:environment.ARK_AGENT_HEADERS_FILE,
    sessionFile:environment.ARK_AGENT_SESSION_FILE}).filter(([,value])=>value!==undefined));
  const resolved={...defaults,...env,...config};
  resolved.url=normalizeSiteUrl(resolved.url||DEFAULT_SITE_URL);
  resolved.roomCode=normalizeRoomCode(resolved.roomCode);
  resolved.name=normalizePlayerName(resolved.name,defaultPlayerName(resolved.client));
  return resolved;
}
