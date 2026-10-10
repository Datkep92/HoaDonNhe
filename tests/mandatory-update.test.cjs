'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { Updater, REPO } = require('../src/updater');
const { allowsDuringUpdate } = require('../src/update-policy');
const assets = ['CN-Tax-Tools-v9.0.0.exe', 'CN-Tax-Tools-v9.0.0.exe.sha256'].map(name => ({name, browser_download_url:`https://github.com/${REPO}/releases/download/v9.0.0/${name}`}));
test('mandatory notice survives restart/offline, check does not download, confirmation is version bound', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mandatory-update-'));
  let downloads = 0;
  const options = {version:'1.1.7', mandatory:true, noticeFile:path.join(dir,'notice.json'), execPath:path.join(dir,'app.exe'), canWrite:()=>true, download:async()=>{downloads++; throw Error('offline');}};
  try {
    const u = new Updater({...options, checkUpdate:async()=>({ok:true,current:'1.1.7',latest:'9.0.0',updateAvailable:true,assets,notes:'Có gì mới'})});
    await u.check(true); assert.equal(downloads,0);
    assert.equal((await u.start()).ok,false); assert.equal(downloads,0);
    assert.equal(u.cancel().updateAvailable,true);
    const restored = new Updater({...options,checkUpdate:async()=>{throw Error('offline');}});
    assert.equal(restored.status().notes,'Có gì mới');
    await restored.check(true); assert.equal(restored.status().updateAvailable,true);
    assert.equal((await restored.start(null,'9.0.0')).ok,false);
    assert.equal(restored.status().stage,'error'); assert.equal(downloads,1);
    assert.equal(restored.cancel().updateAvailable,true);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('update gate blocks new jobs but permits reads, saving replacement work and stopping jobs', () => {
  for (const p of ['/api/download','/api/ai/chat','/api/invoice-replacement/upload','/api/account/auto-login']) assert.equal(allowsDuringUpdate('POST',p),false,p);
  for (const p of ['/api/update/start','/api/pause','/api/invoice-replacement/export','/api/invoice-replacement/stop']) assert.equal(allowsDuringUpdate('POST',p),true,p);
  assert.equal(allowsDuringUpdate('GET','/api/state'),true);
  assert.equal(allowsDuringUpdate('POST','/api/account/save'),false);
  assert.equal(allowsDuringUpdate('POST','/api/account/save',{forms:['mst-form']}),true);
});
function ui() {
  const els = new Map(), events = new Map(), calls = [];
  function el(id) {if(!els.has(id)){const listeners={}, classes=new Set();els.set(id,{hidden:false,open:false,textContent:'',listeners, classList:{contains:x=>classes.has(x),toggle:(x,on)=>on?classes.add(x):classes.delete(x)},addEventListener:(n,f)=>listeners[n]=f,showModal(){this.open=true;this.modal=true;},show(){this.open=true;this.modal=false;},close(){this.open=false;},removeAttribute(){},getBoundingClientRect:()=>({left:10,right:100,top:10,bottom:100})});}return els.get(id);}
  const state={update:{updateAvailable:true,current:'1.1.7',latest:'9.0.0',notes:'## Có gì mới\n- **AI hỗ trợ kế toán**\n<script>unsafe()</script>',canSelfUpdate:true,stage:'available'}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/update-ui.js'),'utf8'),{document:{getElementById:el},window:{HD_LAST_STATE:state,addEventListener:(n,f)=>events.set(n,f)},fetch:async(url,opts)=>{if(url==='/api/update/start')calls.push({url,opts});return{ok:true,json:async()=>({ok:true,value:{ok:true,started:true}})};}});
  return {el,calls,state,events};
}
test('UI waits for user, button starts once, Escape cannot dismiss', async () => {
  const u=ui();assert.equal(u.calls.length,0);assert.equal(u.el('update-dialog').open,true);
  assert.equal(u.el('update-release-notes').textContent,'Có gì mới\n- AI hỗ trợ kế toán\n<script>unsafe()</script>');
  let prevented=false;u.el('update-dialog').listeners.cancel({preventDefault:()=>prevented=true});assert.equal(prevented,true);
  await Promise.all([u.el('update-now').onclick(),u.el('update-now').onclick()]);
  await u.el('update-now').onclick();assert.equal(u.calls.length,1);assert.equal(JSON.parse(u.calls[0].opts.body).version,'9.0.0');
});
test('backdrop starts update once; waiting exposes existing work without a dismiss action', async () => {
  const u=ui(), d=u.el('update-dialog');
  d.listeners.click({target:d,clientX:20,clientY:20});assert.equal(u.calls.length,0);
  d.listeners.click({target:d,clientX:0,clientY:0});
  await new Promise(r=>setImmediate(r));assert.equal(u.calls.length,1);
  u.state.update.stage='waiting';u.events.get('hd:state')({detail:u.state});assert.equal(d.modal,false);assert.equal(d.open,true);
  const html=fs.readFileSync(path.join(__dirname,'../src/index.html'),'utf8');assert.ok(!html.includes('id="update-close"'));assert.ok(!html.includes('id="update-later"'));
});
