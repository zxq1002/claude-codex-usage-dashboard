'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const path=require('path');
const os=require('os');
const {spawn}=require('child_process');
const {fanout,runCommand}=require('../lib/fanout');
const ownPath=path.resolve(__dirname,'../statusline-usage.js');
const fanoutPath=path.resolve(__dirname,'../statusline-both.js');
const quote=s=>"'"+s.replace(/'/g,"'\\''")+"'";
const input=JSON.stringify({model:{display_name:'Test'},rate_limits:{five_hour:{used_percentage:42,resets_at:1792497600},seven_day:{used_percentage:65}}})+'\n';
function fixture(t,body='process.stdout.write("HUD");') {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dashboard fanout '));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const script=path.join(dir,'hud.js'),seen=path.join(dir,'input.txt'),count=path.join(dir,'count.txt');
 fs.writeFileSync(script,'const fs=require("fs");let input="";process.stdin.setEncoding("utf8");process.stdin.on("data",s=>input+=s);process.stdin.on("end",()=>{fs.writeFileSync('+JSON.stringify(seen)+',input);fs.appendFileSync('+JSON.stringify(count)+',"1");'+body+'});');
 return {dir,seen,count,script,input,ownPath,extraCommand:quote(process.execPath)+' '+quote(script),env:{...process.env,CLAUDE_USAGE_CACHE:path.join(dir,'cache.json'),DASHBOARD_FANOUT_DEPTH:''}};
}
test('HUD ANSI, Unicode, indentation and all multiline whitespace preserved; identical stdin and one invocation',async t=>{
 const output=' \u001b[32m◉ Opus\u001b[0m\n  Agent: 工作\nTodo: ✓\n\n';
 const f=fixture(t,'process.stdout.write('+JSON.stringify(output)+');');
 assert.equal(await fanout(f),output);
 assert.equal(fs.readFileSync(f.seen,'utf8'),input);assert.equal(fs.readFileSync(f.count,'utf8'),'1');
 const cache=JSON.parse(fs.readFileSync(f.env.CLAUDE_USAGE_CACHE));assert.deepEqual(cache.rate_limits,JSON.parse(input).rate_limits);
 assert.equal(fs.statSync(f.env.CLAUDE_USAGE_CACHE).mode&0o777,0o600);
});
for(const [name,body] of [['empty','process.stdout.write(" \\n");'],['nonzero','process.stdout.write("broken HUD");process.exitCode=1;'],['signal','process.kill(process.pid,"SIGTERM");'],['stderr','process.stderr.write("diagnostic");'],['output limit','process.stdout.write("x".repeat(300000));'],['timeout','setInterval(()=>{},1000);']]) {
 test('HUD '+name+' falls back to Dashboard',async t=>{const f=fixture(t,body);assert.match(await fanout({...f,timeout:500}),/^Test  5h used 42%/);});
}
test('HUD failure plus missing Dashboard executable gives simple fallback',async t=>{
 const f=fixture(t,'process.exitCode=1;');assert.equal(await fanout({...f,ownPath:path.join(f.dir,'missing.js')}),'Claude');
});
test('Dashboard write failure cannot hide successful HUD',async t=>{
 const f=fixture(t);fs.mkdirSync(f.env.CLAUDE_USAGE_CACHE);assert.equal(await fanout(f),'HUD');
});
test('Dashboard process failure cannot hide successful HUD',async t=>{
 const f=fixture(t);assert.equal(await fanout({...f,ownPath:path.join(f.dir,'missing.js')}),'HUD');
});
test('invalid extra command type and direct wrappers are refused without executing them',async t=>{
 const f=fixture(t);
 for(const extraCommand of [{},'node "'+fanoutPath+'"','node statusline-usage.js','bash statusline-bridge.sh']) assert.match(await fanout({...f,extraCommand}),/^Test/);
 assert.equal(fs.existsSync(f.count),false);
});
test('indirect unknown bridge cannot recursively fan out',async t=>{
 const f=fixture(t,'const p=require("child_process").spawnSync(process.execPath,['+JSON.stringify(fanoutPath)+'],{input,encoding:"utf8"});process.stdout.write(p.stdout);');
 assert.equal(await fanout(f),'Claude');assert.equal(fs.readFileSync(f.count,'utf8'),'1');
});
test('unlaunchable command reports failure, not partial output',async()=>{
 assert.deepEqual(await runCommand('/nonexistent-dashboard-test-executable',[],'',{timeout:200}),{ok:false,stdout:''});
});
test('timeout kills shell descendants and returns within a bounded total duration',async t=>{
 const f=fixture(t);const pidFile=path.join(f.dir,'child.pid');
 const code='const fs=require("fs");fs.writeFileSync('+JSON.stringify(pidFile)+',String(process.pid));setInterval(()=>{},1000);';
 const parent='require("child_process").spawn(process.execPath,["-e",'+JSON.stringify(code)+'],{stdio:"inherit"});setInterval(()=>{},1000);';
 const start=Date.now();
 const result=await runCommand(quote(process.execPath)+' -e '+quote(parent),[],'',{shell:true,timeout:400});
 assert.equal(result.ok,false);assert(Date.now()-start<1800);
 assert(fs.existsSync(pidFile),'descendant started');const pid=Number(fs.readFileSync(pidFile));
 let gone=false;
 for(let i=0;i<30;i++){try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH'){gone=true;break;}}await new Promise(r=>setTimeout(r,20));}
 if(!gone){try{process.kill(pid,'SIGKILL');}catch{}}
 assert(gone,'shell descendant should have exited');
});
test('parallel statusline invocations never expose truncated JSON or leave temporary files',async t=>{
 const f=fixture(t);const jobs=[];let reads=0;
 const reader=setInterval(()=>{if(fs.existsSync(f.env.CLAUDE_USAGE_CACHE)){JSON.parse(fs.readFileSync(f.env.CLAUDE_USAGE_CACHE,'utf8'));reads++;}},1);
 try{
  for(let i=0;i<24;i++)jobs.push(new Promise((resolve,reject)=>{
   const child=spawn(process.execPath,[ownPath],{env:f.env,stdio:['pipe','ignore','pipe']});let errors='';child.stderr.on('data',s=>errors+=s);child.on('error',reject);child.on('close',code=>code===0?resolve():reject(Error(errors)));child.stdin.end(input);
  }));
  await Promise.all(jobs);
 }finally{clearInterval(reader);}
 assert(reads>0);assert.equal(JSON.parse(fs.readFileSync(f.env.CLAUDE_USAGE_CACHE)).rate_limits.five_hour.used_percentage,42);
 assert.deepEqual(fs.readdirSync(f.dir).filter(n=>n.endsWith('.tmp')),[]);
});
test('invalid or missing quota does not overwrite previous cache',async t=>{
 const f=fixture(t);fs.writeFileSync(f.env.CLAUDE_USAGE_CACHE,'preserve');
 for(const value of ['broken','{}','{"rate_limits":{}}']){
  const result=await runCommand(process.execPath,[ownPath],value,{env:f.env});assert(result.ok);
  assert.equal(fs.readFileSync(f.env.CLAUDE_USAGE_CACHE,'utf8'),'preserve');
 }
});
