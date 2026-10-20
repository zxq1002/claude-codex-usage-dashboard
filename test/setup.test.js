'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const path=require('path');
const os=require('os');
const {spawnSync}=require('child_process');
const {createPlan,applyPlan,restore,configRoot}=require('../setup-statusline');
const {atomicWriteJson}=require('../lib/private-json');
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"dashboard setup ' "));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const root=path.join(dir,'claude'),projectDir=path.join(dir,'project');fs.mkdirSync(root);fs.mkdirSync(projectDir);
 const settingsPath=path.join(root,'settings.json'),configPath=path.join(projectDir,'config.json');
 const statusLine={type:'command',command:'node /original/HUD.js --label "Test Project"',padding:7};
 atomicWriteJson(settingsPath,{statusLine,env:{keep:'yes'}});atomicWriteJson(configPath,{other:'retain'});
 return {root,projectDir,settingsPath,configPath,statusLine,fanout:true,env:{}};
}
const read=p=>JSON.parse(fs.readFileSync(p));
test('plan does not write; install preserves full original HUD command, padding and other settings; repeat is stable',t=>{
 const f=fixture(t);const before=fs.readFileSync(f.settingsPath);const plan=createPlan(f);
 assert.deepEqual(fs.readFileSync(f.settingsPath),before);assert.equal(fs.existsSync(path.join(f.root,'dashboard-backups')),false);
 assert.equal(plan.nextConfig.extraStatuslineCommand,f.statusLine.command);
 const backup=applyPlan(plan);assert(backup);assert.equal(read(f.settingsPath).statusLine.padding,7);assert.equal(read(f.settingsPath).env.keep,'yes');
 assert.equal(read(f.configPath).other,'retain');assert.equal(read(f.configPath).extraStatuslineCommand,f.statusLine.command);
 const first=fs.readFileSync(f.settingsPath);assert.equal(applyPlan(createPlan(f)),null);assert.deepEqual(fs.readFileSync(f.settingsPath),first);
 const s=read(f.settingsPath);s.env.added='later';atomicWriteJson(f.settingsPath,s);const c=read(f.configPath);c.newFlag=true;atomicWriteJson(f.configPath,c);
 restore(backup);assert.deepEqual(read(f.settingsPath).statusLine,f.statusLine);assert.equal(read(f.settingsPath).env.added,'later');assert.equal(read(f.configPath).newFlag,true);assert.equal(read(f.configPath).extraStatuslineCommand,undefined);
});
test('CLI plan-only and config directory override never alter real settings',t=>{
 const f=fixture(t);const before=fs.readFileSync(f.settingsPath);
 const result=spawnSync(process.execPath,[path.resolve(__dirname,'../setup-statusline.js'),'--fanout','--plan-only'],{env:{...process.env,CLAUDE_CONFIG_DIR:f.root,EXTRA_STATUSLINE_COMMAND:''},encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/no files written/);assert.deepEqual(fs.readFileSync(f.settingsPath),before);
 assert.equal(configRoot({CLAUDE_CONFIG_DIR:f.root}),f.root);
});
test('unknown bridge and direct wrapper recursion are rejected',t=>{
 const f=fixture(t);
 for(const command of ['bash statusline-bridge.sh','node statusline-both.js','node statusline-usage.js']){
  atomicWriteJson(f.settingsPath,{statusLine:{type:'command',command}});assert.throws(()=>createPlan(f),/wrapper|recursive/);
 }
});
test('backup failure aborts before any settings/config write',t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.root,'dashboard-backups'),'not a directory');
 const before=fs.readFileSync(f.settingsPath),config=fs.readFileSync(f.configPath);
 assert.throws(()=>applyPlan(createPlan(f)));assert.deepEqual(fs.readFileSync(f.settingsPath),before);assert.deepEqual(fs.readFileSync(f.configPath),config);
});
test('changed configuration between plan and apply is refused',t=>{
 const f=fixture(t),plan=createPlan(f);const s=read(f.settingsPath);s.added=true;atomicWriteJson(f.settingsPath,s);
 assert.throws(()=>applyPlan(plan),/changed/);assert.equal(read(f.settingsPath).added,true);
});
test('restore refuses managed fields changed after installation',t=>{
 const f=fixture(t),backup=applyPlan(createPlan(f));const s=read(f.settingsPath);s.statusLine.command='new custom command';atomicWriteJson(f.settingsPath,s);
 assert.throws(()=>restore(backup),/changed/);assert.equal(read(f.settingsPath).statusLine.command,'new custom command');
});
test('invalid JSON is not silently overwritten',t=>{
 const f=fixture(t);fs.writeFileSync(f.settingsPath,'broken');assert.throws(()=>createPlan(f));assert.equal(fs.readFileSync(f.settingsPath,'utf8'),'broken');
});
test('failed settings replacement rolls back the config side of installation',t=>{
 const f=fixture(t),plan=createPlan(f),rename=fs.renameSync;
 fs.renameSync=(from,to)=>{if(to===f.settingsPath)throw Error('simulated settings failure');return rename(from,to);};
 try{assert.throws(()=>applyPlan(plan),/simulated/);}finally{fs.renameSync=rename;}
 assert.deepEqual(read(f.configPath),{other:'retain'});assert.deepEqual(read(f.settingsPath).statusLine,f.statusLine);
});
test('private atomic writer fails cleanly in a read-only directory',t=>{
 const f=fixture(t);const p=path.join(f.projectDir,'private.json');atomicWriteJson(p,{keep:true});fs.chmodSync(f.projectDir,0o500);
 try{assert.throws(()=>atomicWriteJson(p,{keep:false}));assert.deepEqual(read(p),{keep:true});}finally{fs.chmodSync(f.projectDir,0o700);}
});
test('failed settings restore reinstates installed config instead of leaving a partial rollback',t=>{
 const f=fixture(t),backup=applyPlan(createPlan(f)),installed=read(f.configPath),rename=fs.renameSync;
 fs.renameSync=(from,to)=>{if(to===f.settingsPath)throw Error('restore settings failure');return rename(from,to);};
 try{assert.throws(()=>restore(backup),/restore settings failure/);}finally{fs.renameSync=rename;}
 assert.deepEqual(read(f.configPath),installed);assert.notDeepEqual(read(f.settingsPath).statusLine,f.statusLine);
});
test('install with no prior config restores absence, preserving later unrelated settings',t=>{
 const f=fixture(t);fs.unlinkSync(f.configPath);const backup=applyPlan(createPlan(f));restore(backup);assert.equal(fs.existsSync(f.configPath),false);
});
