// Check the reusable core boundary, including the exact archive consumed by hosts.
import {readFile,readdir,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url));
const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
if(pkg.name!=='@arkstrongholdrl/ark-play-core'||pkg.dependencies['@modelcontextprotocol/sdk'])throw new Error('Core must be host-independent');
for(const folder of ['src','tools'])for(const name of await readdir(join(root,folder))) {
  if(name.endsWith('.mjs'))execFileSync(process.execPath,['--check',join(root,folder,name)]);
}
const api=await import(pathToFileURL(join(root,'src/tools.mjs')));
if(typeof api.createTools!=='function'||!api.z)throw new Error('Invalid shared API');
const runtime=api.createTools();
if(runtime.tools.length!==5)throw new Error('Expected five shared tools');
await runtime.close();
if(process.argv.includes('--pack')) {
  const destination=join(root,'results/npm');await mkdir(destination,{recursive:true});
  const [report]=JSON.parse(execFileSync('npm',['pack','--ignore-scripts','--json','--pack-destination',destination],{cwd:root,encoding:'utf8'}));
  const archive=join(destination,report.filename);
  const names=execFileSync('tar',['-tzf',archive],{encoding:'utf8'}).trim().split('\n');
  for(const name of ['src/tools.mjs','src/rpc.mjs','src/site-worker.mjs','src/site-loader.mjs','tools/package.mjs','tools/configure.mjs','PROVENANCE.md','LICENSE'])if(!names.includes('package/'+name))throw new Error('Archive omitted '+name);
  if(names.some(name=>/\/(node_modules|dist|public|results)\//.test(name)||name.endsWith('/src/mcp.mjs')))throw new Error('Host-only or generated files in core');
  const scratch=await mkdtemp(join(tmpdir(),'ark-core-audit-'));
  try {
    execFileSync('tar',['-xzf',archive,'-C',scratch]);
    const extracted=JSON.parse(await readFile(join(scratch,'package/package.json'),'utf8'));
    if(extracted.name!==pkg.name||extracted.version!==pkg.version)throw new Error('Wrong archive identity');
  } finally {await rm(scratch,{recursive:true,force:true});}
  console.log('Audited '+report.filename);
}
console.log('Core API, syntax and package boundaries valid.');
