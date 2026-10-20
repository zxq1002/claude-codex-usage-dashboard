'use strict';
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const os=require('os');
const path=require('path');
const {spawnSync}=require('child_process');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dashboard-http-'));
const cache=path.join(dir,'cache.json'),hud=path.join(dir,'hud.json'),codexDir=path.join(dir,'sessions');
Object.assign(process.env,{CLAUDE_USAGE_CACHE:cache,CLAUDE_HUD_USAGE_PATH:hud,CODEX_SESSIONS_DIR:codexDir});
const {server}=require('../server');
let base;
function writeSources(){
 const now=Date.now();
 fs.writeFileSync(cache,JSON.stringify({fetchedAt:now-60000,rate_limits:{five_hour:{used_percentage:99},seven_day:{used_percentage:99}}}));
 fs.writeFileSync(hud,JSON.stringify({updated_at:new Date(now-3000).toISOString(),five_hour:{used_percentage:85,resets_at:new Date(now+3600000).toISOString()},seven_day:{used_percentage:0,resets_at:null}}));
}
before(async()=>{
 writeSources();const d=new Date();const day=path.join(codexDir,String(d.getFullYear()),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0'));fs.mkdirSync(day,{recursive:true});
 fs.writeFileSync(path.join(day,'rollout-test.jsonl'),JSON.stringify({timestamp:d.toISOString(),payload:{type:'token_count',rate_limits:{primary:{used_percent:10,resets_at:Math.floor(Date.now()/1000)+1000},secondary:{used_percent:20}}}})+'\n');
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});base='http://127.0.0.1:'+server.address().port;
});
after(async()=>{await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});});
test('real API reads HUD data and preserves Codex values',async()=>{
 const r=await fetch(base+'/api/usage');assert.equal(r.status,200);const data=await r.json();assert.equal(data.claude.five.used,85);assert.equal(data.claude.seven.used,0);assert.equal(data.codex.five.used,10);assert.equal(data.codex.seven.used,20);
});
for(const [route,five,seven] of [['/k',15,100],['/u',85,0],['/kobo?mode=remaining',15,100],['/eink?mode=used',85,0]])test('server-rendered '+route+' converts quota correctly without JavaScript',async()=>{
 const r=await fetch(base+route);assert.equal(r.status,200);const html=await r.text();
 const nums=[...html.matchAll(/<td class="num">([^<]+)<\/td>/g)].map(m=>m[1]);assert.deepEqual(nums.slice(0,2),[five+'%',seven+'%']);assert.match(html,/<tr class="alert">/);assert.match(html,/updated/);assert(!html.includes('<script'));
});
test('missing or malformed HUD falls back, all missing shows placeholders, files remain unchanged',async()=>{
 fs.writeFileSync(hud,'broken');let data=await (await fetch(base+'/api/usage')).json();assert.equal(data.claude.five.used,99);assert.equal(fs.readFileSync(hud,'utf8'),'broken');
 fs.unlinkSync(cache);data=await (await fetch(base+'/api/usage')).json();assert.equal(data.claude.five,null);
 assert.match(await (await fetch(base+'/k')).text(),/<td class="num">--<\/td>/);writeSources();
});
test('local config persists P0 across restarts; explicit env override and empty disable take precedence',()=>{
 const copy=path.join(dir,'project');fs.mkdirSync(path.join(copy,'lib'),{recursive:true});
 fs.copyFileSync(path.resolve(__dirname,'../server.js'),path.join(copy,'server.js'));fs.copyFileSync(path.resolve(__dirname,'../lib/claude-usage.js'),path.join(copy,'lib/claude-usage.js'));
 fs.writeFileSync(path.join(copy,'config.json'),JSON.stringify({claudeHudUsagePath:hud}));
 const env={...process.env};delete env.CLAUDE_HUD_USAGE_PATH;
 const run=extra=>{const r=spawnSync(process.execPath,['-e','console.log(JSON.stringify(require("./server").readClaudeUsage()))'],{cwd:copy,env:{...env,...extra},encoding:'utf8'});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
 assert.equal(run({}).five.used,85);assert.equal(run({CLAUDE_HUD_USAGE_PATH:''}).five.used,99);assert.equal(run({CLAUDE_HUD_USAGE_PATH:path.join(dir,'missing.json')}).five.used,99);
 fs.writeFileSync(path.join(copy,'config.json'),'broken');assert.equal(run({}).five.used,99);
});
