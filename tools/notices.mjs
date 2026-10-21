import {readdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
export async function writeNotices(nodeModules,target) {
  const notices=[];
  async function visit(folder) {
    for(const entry of await readdir(folder,{withFileTypes:true})) {
      if(!entry.isDirectory()||entry.isSymbolicLink())continue;
      const dir=join(folder,entry.name);
      if(entry.name.startsWith('@')){await visit(dir);continue;}
      const files=await readdir(dir,{withFileTypes:true});
      if(files.some(f=>f.name==='package.json')) {
        const pkg=JSON.parse(await readFile(join(dir,'package.json'),'utf8'));
        for(const f of files.filter(f=>f.isFile()&&/^(LICENSE|LICENCE|COPYING|NOTICE)(\.|$)/i.test(f.name)))notices.push(pkg.name+'@'+pkg.version+' ('+(pkg.license||'see notice')+')\n'+await readFile(join(dir,f.name),'utf8'));
      }
      if(files.some(f=>f.name==='node_modules'&&f.isDirectory()))await visit(join(dir,'node_modules'));
    }
  }
  await visit(nodeModules);await writeFile(target,notices.join('\n\n----------------\n\n').replace(/\r\n/g,'\n').replace(/[ \t]+$/gm,''));
}
