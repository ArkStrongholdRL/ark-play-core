// Site-owned public content and isolated upstream-client execution; memory only.
import {createHash} from 'node:crypto';
import {Worker} from 'node:worker_threads';
const FILES=['chess','enemies','tokens','stages','waves','bonds','items','garrisons','bands','effects','backups','bosses'];
export async function readSite(url,headers,maxBytes=16*1024*1024) {
  const response=await fetch(url,{headers,redirect:'error',signal:AbortSignal.timeout(30_000)});
  if(!response.ok)throw new Error('Site content HTTP '+response.status+' at '+new URL(url).pathname);
  const parts=[];let length=0;
  for await(const chunk of response.body){length+=chunk.length;if(length>maxBytes)throw new Error('Site content size bound exceeded');parts.push(chunk);}
  return Buffer.concat(parts);
}
export class SiteRuntime {
  constructor(origin,headers,onReport,onFailure) {this.origin=origin;this.headers=headers;this.onReport=onReport;this.onFailure=onFailure;this.pending=new Map();this.counter=0;}
  async load(cs) {
    if(!/^[a-f0-9]{64}$/.test(cs))throw new Error('Site did not publish a supported content identity');
    const index=JSON.parse(await readSite(this.origin+'/cs/'+cs.slice(0,16)+'/index.json',this.headers,1024*1024));
    if(index.cs!==cs||index.v!==1||index.vanilla!==true||!index.simFiles||!index.data||index.plugins?.length)throw new Error('Only the site vanilla content protocol v1 is supported');
    const raw=Object.fromEntries(await Promise.all(FILES.map(async key=>{
      const ref=index.data[key];if(!ref)throw new Error('Site data missing: '+key);
      const url=new URL(ref.url,this.origin);
      if(url.origin!==this.origin||!/^\/data\/[a-z]+\.json$/.test(url.pathname))throw new Error('Unsupported site data URL');
      const bytes=await readSite(url,this.headers);
      if(bytes.length!==ref.bytes||createHash('sha256').update(bytes).digest('hex')!==ref.sha256)throw new Error('Site data hash/size mismatch: '+key);
      return [key,JSON.parse(bytes)];
    })));
    this.raw=raw;this.index=index;
    const worker=new Worker(new URL('./site-worker.mjs',import.meta.url),{workerData:{origin:this.origin,headers:this.headers,index,raw}});this.worker=worker;
    this.ready=await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(new Error('Upstream client loading timed out')),60_000);
      worker.on('error',e=>{clearTimeout(timeout);reject(e);this.fail(e.message);});
      worker.on('exit',code=>{if(code!==0){clearTimeout(timeout);reject(new Error('Upstream worker exited'));this.fail('Upstream worker exited');}});
      worker.on('message',m=>{
        if(m.type==='ready'){clearTimeout(timeout);resolve(m);}
        else if(m.type==='report')this.onReport(m.message);
        else if(m.type==='failure')this.fail(m.error);
        else if(m.type==='reply') {const p=this.pending.get(m.id);if(p){this.pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(m.error)):p.resolve(m.result);}}
      });
    });
    return this;
  }
  fail(error) {this.onFailure(String(error));for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error(String(error)));}this.pending.clear();}
  send(op,payload={}) {this.worker?.postMessage({op,...payload});}
  request(op,payload={}) {
    if(!this.worker)throw new Error('Site runtime unavailable');
    const id=++this.counter;
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('Site runtime timed out'));},10_000);this.pending.set(id,{resolve,reject,timer});this.worker.postMessage({op,id,...payload});});
  }
  async close() {const w=this.worker;this.worker=null;this.fail('Site runtime closed');if(w)await w.terminate();}
}
