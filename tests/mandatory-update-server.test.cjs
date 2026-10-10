'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),{spawn}=require('node:child_process');
test('real server restores mandatory update, blocks new work, permits draft completion and retains requirement after failure',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cntax-required-api-'));
 const assets=['CN-Tax-Tools-v9.0.0.exe','CN-Tax-Tools-v9.0.0.exe.sha256'].map(name=>({name,browser_download_url:`https://github.com/Datkep92/HoaDonNhe/releases/download/v9.0.0/${name}`}));
 fs.writeFileSync(path.join(dir,'update-notice.json'),JSON.stringify({latest:'9.0.0',assets,notes:'test'}));
 const p=spawn(process.execPath,[path.resolve('src/server.js'),'--test-server'],{windowsHide:true,env:{...process.env,HOADON_TEST_DATA:dir,HOADON_NO_UPDATE_CHECK:'1',HOADON_FORCE_UPDATE_CHECK:'1'},stdio:['ignore','pipe','pipe']});let output='';p.stdout.on('data',v=>output+=v);p.stderr.on('data',v=>output+=v);
 try {
  let m;for(let i=0;i<200;i++){m=output.match(/\{"testUrl":"([^"]+)"/);if(m)break;await new Promise(r=>setTimeout(r,100));}assert.ok(m,output.slice(-300));
  const base=new URL(m[1]),headers={'Content-Type':'application/json',Cookie:'hd_session='+base.searchParams.get('launch')};
  const request=(method,route,body)=>new Promise((resolve,reject)=>{const req=http.request(new URL(route,base),{method,headers},res=>{let text='';res.on('data',v=>text+=v);res.on('end',()=>resolve({status:res.statusCode,text}));});req.on('error',reject);req.setTimeout(10000,()=>req.destroy(Error('timeout')));req.end(body===undefined?undefined:JSON.stringify(body));});
  const post=(route,body={})=>request('POST',route,body);
  const state=async()=>JSON.parse((await request('GET','/api/state')).text).value;
  assert.equal((await state()).update.updateAvailable,true);
  assert.equal((await post('/api/ai/chat',{message:'hello'})).status,423);
  assert.equal((await post('/api/account/save',{})).status,423);
  assert.equal((await post('/api/update/cancel')).status,423);
  assert.equal((await post('/api/update/start')).status,409);
  assert.equal((await post('/api/update/work',{id:'draft',dirty:true,forms:['mst-form']})).status,200);
  assert.notEqual((await post('/api/account/save',{})).status,423,'pre-existing draft may reach existing validation');
  // Source runs cannot replace the machine's Node runtime; its protected folder
  // is a legitimate failed-start case and must retain the mandatory gate.
  if(!(await state()).update.canSelfUpdate)assert.equal((await post('/api/update/start',{version:'9.0.0'})).status,409);
  assert.equal((await post('/api/ai/chat',{message:'hello'})).status,423);
  assert.equal((await state()).update.updateAvailable,true);
 }finally {p.kill();await new Promise(r=>{if(p.exitCode!==null)r();else p.once('exit',r);});fs.rmSync(dir,{recursive:true,force:true,maxRetries:8,retryDelay:150});}
});
