import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {hostFs} from '../lib/extract-asar.js';
import {backupAll,revertAll,applyPatchesAllHosts,hostErrorFor,ALL_PATCHES} from '../lib/core.js';

test('real backup descriptors close before atomic rename, rollback restores original bytes',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'purge backup 中文 '));
 const oldHome=process.env.DSH_HOME;process.env.DSH_HOME=path.join(root,'home');
 try {
  const file=path.join(root,'dsh-settings/lib/index.js');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'original vendor code');
  const fd=hostFs.openSync(path.join(root,'descriptor'),'wx');hostFs.closeSync(fd);assert.throws(()=>fs.fstatSync(fd),/EBADF/);
  const backup=await backupAll(root);assert.deepEqual(backup.errors,[]);assert.equal(fs.readFileSync(file+'.dshpurge.bak','utf8'),'original vendor code');
  fs.writeFileSync(file,'patched vendor code');const revert=await revertAll(root);assert.deepEqual(revert.errors,[]);assert.equal(fs.readFileSync(file,'utf8'),'original vendor code');
 }finally{if(oldHome===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=oldHome;fs.rmSync(root,{recursive:true,force:true});}
});

test('read-only Linux host backup fails before patch writes and points to user installation', {skip:process.platform!=='linux'||process.getuid?.()===0}, async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'purge readonly '));
 const keys=['DSH_HOME','DSH_BASE','DSH_SURFACE','DSH_PROFILE'];
 const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
 const base=path.join(root,'host'),dir=path.join(base,'dsh-agent-instructions/lib'),file=path.join(dir,'index.js');
 fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(file,'vendor source');fs.chmodSync(dir,0o555);
 Object.assign(process.env,{DSH_HOME:path.join(root,'home'),DSH_BASE:base,DSH_SURFACE:'web',DSH_PROFILE:'web'});
 try{
  await assert.rejects(applyPatchesAllHosts(),error=>/Host backup failed/.test(error.message)&&/patch writes cancelled/.test(error.message)&&/~\/.local\/bin\/dsh web/.test(error.message));
  assert.equal(fs.readFileSync(file,'utf8'),'vendor source');
  assert(!fs.existsSync(file+'.dshpurge.bak'));
 }finally{
  for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}
  fs.chmodSync(dir,0o755);fs.rmSync(root,{recursive:true,force:true});
 }
});

// 一个无关宿主（例如 mise/npm 全局的 @deepseek-ai/dsh）带着旧 settings shim 时，
// #42 的 SETTINGS_LEGACY_API 守卫会主动抛错。整段裸 await 会让整个「应用」500，
// 真正的目标宿主一个字都写不进去。这里钉住逐宿主隔离：坏宿主进 hostErrors，好宿主照写。
const MULTI_HOST_KEYS=['DSH_HOME','DSH_BASE','DSH_SURFACE','DSH_PROFILE'];
function withMultiHostEnv(root,bases,run){
 const previous=Object.fromEntries(MULTI_HOST_KEYS.map(key=>[key,process.env[key]]));
 Object.assign(process.env,{DSH_HOME:path.join(root,'home'),DSH_BASE:bases[0],DSH_SURFACE:'web',DSH_PROFILE:'web'});
 return Promise.resolve().then(run).finally(()=>{
  for(const key of MULTI_HOST_KEYS){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}
 });
}
function makeHost(root,name,settingsSource){
 const base=path.join(root,name);
 fs.mkdirSync(path.join(base,'dsh-agent-instructions','lib'),{recursive:true});
 fs.writeFileSync(path.join(base,'dsh-agent-instructions','lib','index.js'),'vendor source');
 if(settingsSource){
  fs.mkdirSync(path.join(base,'dsh-settings','lib'),{recursive:true});
  fs.writeFileSync(path.join(base,'dsh-settings','lib','index.js'),settingsSource);
 }
 return base;
}
// 现代宿主（有 describe/replace）却残留 legacy shim：无法逆向，只能停下来诊断。
const UNKNOWN_LEGACY_SETTINGS='var SettingsForms = class extends Service {\n\tdescribe(options) { return options; }\n\tasync replace(ns, section, expectedRevision) { return section; }\n\tthis.legacyRegistrations = new Map();\n\tthis.ensureLegacyDocument();\n};\n';

test('one host with an unknown settings shim no longer aborts the other host apply',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'purge multi host '));
 const broken=makeHost(root,'broken',UNKNOWN_LEGACY_SETTINGS);
 const healthy=makeHost(root,'healthy','');
 try{
  await withMultiHostEnv(root,[healthy],async()=>{
   const multi=await applyPatchesAllHosts(ALL_PATCHES,{hosts:[broken,healthy]});
   assert.deepEqual(multi.hosts.map(host=>host.aiBase),[healthy]);
   assert.equal(multi.hostErrors.length,1);
   assert.equal(multi.hostErrors[0].aiBase,broken);
   assert.match(multi.hostErrors[0].error,/SETTINGS_LEGACY_API/);
   // 好宿主照常写入，不被坏宿主的异常拖住
   assert(multi.report.some(row=>row.patch_id===1));
   assert.equal(hostErrorFor(multi.hostErrors,broken)?.error.includes('SETTINGS_LEGACY_API'),true);
   assert.equal(hostErrorFor(multi.hostErrors,healthy),null);
  });
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('apply still hard-fails when the only host keeps the unknown settings shim',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'purge single broken host '));
 const broken=makeHost(root,'broken',UNKNOWN_LEGACY_SETTINGS);
 try{
  await withMultiHostEnv(root,[broken],async()=>{
   await assert.rejects(
    applyPatchesAllHosts(ALL_PATCHES,{hosts:[broken]}),
    error=>/SETTINGS_LEGACY_API/.test(error.message)&&Array.isArray(error.hostErrors)&&error.hostErrors.length===1
   );
  });
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('hostErrorFor matches host paths with trailing slash and mixed separators',()=>{
 const rows=[{aiBase:'/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh/node_modules/@deepseek-ai',error:'boom'}];
 assert.equal(hostErrorFor(rows,'/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh/node_modules/@deepseek-ai/')?.error,'boom');
 assert.equal(hostErrorFor(rows,'/Users/deepdream/.local/share/mise/node_modules/@deepseek-ai'),null);
 assert.equal(hostErrorFor([],'/anything'),null);
 assert.equal(hostErrorFor(undefined,'/anything'),null);
});
