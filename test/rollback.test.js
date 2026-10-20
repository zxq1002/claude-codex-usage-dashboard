'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const os=require('os');
const path=require('path');
const {spawnSync}=require('child_process');
const {createHash}=require('crypto');
const script=path.resolve(__dirname,'../scripts/rollback-local.py');
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dashboard-rollback-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const backup=path.join(dir,'backup'),project=path.join(dir,'project');fs.mkdirSync(backup);fs.mkdirSync(project);
 const hud=path.join(dir,'hud-config.json'),local=path.join(project,'config.json'),snapshot=path.join(dir,'snapshot.json');
 fs.writeFileSync(hud,JSON.stringify({display:{showTools:true,externalUsageWritePath:snapshot},later:'keep'}));fs.writeFileSync(local,JSON.stringify({claudeHudUsagePath:snapshot,other:'keep'}));
 fs.writeFileSync(path.join(backup,'p0-state.json'),JSON.stringify({hudConfig:hud,localConfig:local,snapshotPath:snapshot,localConfigExisted:false,hudMode:384,localMode:384,project}));
 return {dir,backup,project,hud,local,snapshot};
}
const run=(f,args=[])=>spawnSync('python3',[script,f.backup,...args],{encoding:'utf8'});
test('P0 rollback removes only managed fields, preserves later edits, and is repeatable',t=>{
 const f=fixture(t);let r=run(f);assert.equal(r.status,0,r.stderr);
 assert.deepEqual(JSON.parse(fs.readFileSync(f.hud)),{display:{showTools:true},later:'keep'});assert.deepEqual(JSON.parse(fs.readFileSync(f.local)),{other:'keep'});
 assert.equal(run(f).status,0);
});
test('P0 rollback refuses changed export path before modifying any file',t=>{
 const f=fixture(t);fs.writeFileSync(f.local,JSON.stringify({claudeHudUsagePath:'/some/new/path.json'}));const before=fs.readFileSync(f.hud);
 assert.notEqual(run(f).status,0);assert.deepEqual(fs.readFileSync(f.hud),before);
});
test('full rollback restores baseline Kindle files and removes only unchanged introduced files',t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.project,'server.js'),'new adapter + Kindle');fs.writeFileSync(path.join(f.project,'new.js'),'new helper');fs.writeFileSync(path.join(f.backup,'server.js'),'baseline Kindle layout');
 const inventory=[['server.js','server.js'],['new.js',null]].map(([p,before])=>({path:p,before,mode:420,sha256:createHash('sha256').update(fs.readFileSync(path.join(f.project,p))).digest('hex')}));
 fs.writeFileSync(path.join(f.backup,'project-inventory.json'),JSON.stringify(inventory));const r=run(f,['--all']);assert.equal(r.status,0,r.stderr);
 assert.equal(fs.readFileSync(path.join(f.project,'server.js'),'utf8'),'baseline Kindle layout');assert.equal(fs.existsSync(path.join(f.project,'new.js')),false);
});
test('full rollback refuses later source edits and leaves P0 settings untouched',t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.project,'new.js'),'later edits');fs.writeFileSync(path.join(f.backup,'project-inventory.json'),JSON.stringify([{path:'new.js',before:null,sha256:'old'}]));const before=fs.readFileSync(f.hud);
 assert.notEqual(run(f,['--all']).status,0);assert.deepEqual(fs.readFileSync(f.hud),before);
});
