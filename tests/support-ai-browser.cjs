// Packaged EXE + real browser, with an offline Gateway/Telegram/Firebase substitute.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {spawn}=require('node:child_process'),CDP=require('chrome-remote-interface');
const root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(root,'release','support-ai-browser-'));
let gateway,server,chrome,client;const listeners=new Set(),values=new Map(),revs=new Map(),sent=[];let serial=0,calls=0,failed=false;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){const end=Date.now()+25000;while(Date.now()<end){const x=await fn().catch(()=>null);if(x)return x;await wait(100);}throw Error('Timeout: '+label);}
async function evaluate(expression){const r=await client.Runtime.evaluate({expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;}
const click=id=>evaluate('document.getElementById('+JSON.stringify(id)+').click()');
function messages(){return [...values.entries()].filter(([p])=>p.includes('/messages/')).map(([p,v])=>({id:p.split('/').at(-1),...v})).sort((a,b)=>a.timestamp-b.timestamp);}
function broadcast(){const data=Object.fromEntries(messages().map(m=>[m.id,m]));for(const r of listeners)r.write('event: put\ndata: '+JSON.stringify({path:'/',data})+'\n\n');}
(async()=>{
  const {createSupportFlow}=await import('../cloudflare-worker/src/support-flow.js');
  const flow=createSupportFlow({read:async(_,p)=>({value:values.get(p),etag:String(revs.get(p)||0)}),write:async(_,p,v,e)=>{if(e!==String(revs.get(p)||0))return false;values.set(p,v);revs.set(p,(revs.get(p)||0)+1);return true;},post:async(_,p,v,method)=>{const id='msg'+(++serial);if(method==='DELETE')values.delete(p);else values.set(method==='PUT'?p:p+'/'+id,v);broadcast();return {name:id};},send:async(_,room,text)=>sent.push(text)});
  let room='ROOM_WIN_BROWSER123';
  gateway=http.createServer((req,res)=>{
    if(req.url.startsWith('/v1/chats/stream')){res.writeHead(200,{'Content-Type':'text/event-stream'});listeners.add(res);broadcast();req.on('close',()=>listeners.delete(res));return;}
    let raw='';req.on('data',b=>raw+=b);req.on('end',async()=>{try{
      const b=raw?JSON.parse(raw):{},send=v=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,value:v}));};
      if(b.chatRoomId)room=b.chatRoomId;
      if(req.url==='/v1/chats/status')return send({messages:messages(),control:await flow.state({},room)});
      if(req.url==='/v1/chats/control')return send(await flow.state({},room));
      if(req.url==='/v1/chats/messages')return send(await flow.begin({},room,b.text,{companyId:b.companyId,wantsAdmin:b.wantsAdmin===true}));
      if(req.url==='/v1/chats/ai-reply')return send(await flow.complete({},room,b.turnId,b.revision,b.text));
      if(req.url==='/v1/ai/config')return send({revision:2,active:{model:'working-fixture'}});
      if(req.url.startsWith('/v1/ai/jobs/'))return send({jobId:'fixturejob',status:'ready'});
      if(req.url==='/v1/ai/chat/completions'){
        calls++;
        if(!failed){failed=true;res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{code:'AI_ROUTING_PENDING'},jobId:'fixturejob',status:'running'}));return;}
        res.writeHead(200,{'Content-Type':'text/event-stream','X-AI-Revision':'2','X-AI-Model':'working-fixture'});
        res.end('data: '+JSON.stringify({choices:[{delta:{content:'AI đã tự chuyển cấu hình và trả lời.'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');return;
      }
      return send({status:'Active',expiryAt:'2099-12-31',trial:false,sessionToken:'offline-session',licenseCacheHit:true});
    }catch(e){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:false,error:e.message}));}});
  });await new Promise(r=>gateway.listen(0,'127.0.0.1',r));
  const data=path.join(temp,'data');fs.mkdirSync(data,{recursive:true});fs.writeFileSync(path.join(data,'support-gateway.json'),JSON.stringify({url:'http://127.0.0.1:'+gateway.address().port}));
  const support=new(require('../src/support').SupportStore)(data);support.saveLicense({status:'Active',expiryAt:'2099-12-31',sessionToken:'offline-session'});support.save();room=support.data.device.chatRoomId;
  fs.writeFileSync(path.join(data,'accounts.json'),JSON.stringify({accounts:[{mst:'0123456789',label:'Công ty thử nghiệm',lastUsedAt:1}],selected:'0123456789',output:path.join(temp,'invoices')}));
  fs.writeFileSync(path.join(data,'ai-providers.json'),JSON.stringify({active:'agent',providers:[{id:'agent',label:'CNTaxTools',type:'openai',baseURL:'https://obsolete.test/v1',model:'gone-model',routingMode:'manual'}]}));
  const exe=process.argv[3];server=spawn(exe?path.resolve(exe):process.execPath,exe?['--test-server']:['src/server.js','--test-server'],{cwd:root,env:{...process.env,HOADON_TEST_DATA:data,HOADON_NO_UPDATE_CHECK:'1'},windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='';server.stdout.on('data',b=>output+=b);server.stderr.on('data',b=>output+=b);
  const config=await until(async()=>{const l=output.split(/\r?\n/).find(l=>l.startsWith('{"testUrl"'));return l&&JSON.parse(l);},'server');
  chrome=spawn(require('../src/browser').browserPath(),['--headless=new','--remote-debugging-port=0','--no-first-run','--user-data-dir='+path.join(temp,'chrome'),'about:blank'],{windowsHide:true,stdio:'ignore'});
  const port=await until(async()=>Number(fs.readFileSync(path.join(temp,'chrome','DevToolsActivePort'),'utf8').split('\n')[0]),'browser');
  const target=await CDP.New({port,url:'about:blank'});client=await CDP({port,target});await client.Page.enable();await client.Runtime.enable();
  const errors=[];client.Runtime.exceptionThrown(e=>errors.push(e.exceptionDetails.exception?.description||e.exceptionDetails.text));
  await client.Emulation.setDeviceMetricsOverride({width:1440,height:900,deviceScaleFactor:1,mobile:false});await client.Page.navigate({url:config.testUrl});
  await until(()=>evaluate('!!document.getElementById("support-toggle").onclick'),'widget');await click('support-toggle');
  await until(()=>evaluate('!document.getElementById("ai-form").hidden'),'shared composer');
  assert.equal(await evaluate('document.getElementById("support-form").hidden'),true);
  const sendText=text=>evaluate('document.getElementById("ai-input").value='+JSON.stringify(text)+';document.getElementById("ai-send").click()');
  await sendText('Phân tích doanh nghiệp');await until(()=>evaluate('document.getElementById("ai-thread").textContent.includes("AI đã tự chuyển")&&document.getElementById("ai-stop").hidden'),'automatic retry');assert.equal(calls,2);assert.equal(sent.length,0);
  await sendText('Xin key kích hoạt bản quyền');await until(()=>evaluate('!![...document.querySelectorAll(".ai-approval button")].find(b=>b.textContent.includes("admin"))'),'choose human support');
  await evaluate('[...document.querySelectorAll(".ai-approval button")].find(b=>b.textContent.includes("admin")).click()');
  await until(()=>evaluate('document.getElementById("ai-thread").textContent.includes("Admin sẽ liên hệ lại")&&document.getElementById("ai-stop").hidden'),'license handoff');assert.equal(calls,2);assert.ok(sent.includes('Xin key kích hoạt bản quyền'));
  await flow.owner({},room,'admin','fixture-admin');values.set('/chats/'+room+'/messages/admin1',{sender:'admin',text:'Admin đang kiểm tra và cấp bản quyền cho bạn.',timestamp:Date.now()});broadcast();
  await until(()=>evaluate('document.getElementById("ai-thread").textContent.includes("Admin đang kiểm tra")'),'admin visible');
  await sendText('Tôi đang chờ');await until(()=>evaluate('document.getElementById("ai-stop").hidden'),'human turn');assert.equal(calls,2);assert.ok(sent.includes('Tôi đang chờ'));
  await flow.owner({},room,'auto','fixture-admin');await until(()=>evaluate('document.getElementById("ai-mode-label").textContent.includes("AI đang hoạt động")'),'stop resumes AI');
  await sendText('Phân tích tiếp');await until(()=>evaluate('document.getElementById("ai-stop").hidden'),'resumed answer');assert.equal(calls,3);
  await click('support-close');await click('support-toggle');await wait(500);
  assert.equal(await evaluate('(()=>{const e=document.getElementById("ai-thread");return e.scrollHeight-e.scrollTop-e.clientHeight<3})()'),true,'opens at newest message');
  assert.deepEqual(errors,[]);
  const screenshots=process.argv[2];if(screenshots){fs.mkdirSync(screenshots,{recursive:true});fs.writeFileSync(path.join(screenshots,'support-shared-desktop.png'),Buffer.from((await client.Page.captureScreenshot()).data,'base64'));}
  await client.Emulation.setDeviceMetricsOverride({width:390,height:844,deviceScaleFactor:1,mobile:false});
  assert.equal(await evaluate('(()=>{const r=document.getElementById("support-panel").getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})()'),true);
  if(screenshots)fs.writeFileSync(path.join(screenshots,'support-shared-mobile.png'),Buffer.from((await client.Page.captureScreenshot()).data,'base64'));
  console.log('PASS: packaged common composer; obsolete MANUAL bypassed by AUTO; durable retry; license handoff; admin SSE; no AI while admin; stop resumes; desktop/mobile geometry; no JS exceptions');
})().catch(async e=>{console.error(e.stack);if(client)console.error(await evaluate('JSON.stringify({error:document.getElementById("ai-error").textContent,thread:document.getElementById("ai-thread").textContent})').catch(()=>''));process.exitCode=1;}).finally(async()=>{
  if(client){await client.Browser.close().catch(()=>{});await client.close().catch(()=>{});}if(chrome?.exitCode===null)chrome.kill();if(server?.exitCode===null)server.kill();for(const r of listeners)r.end();if(gateway)await new Promise(r=>gateway.close(r));await wait(700);try{fs.rmSync(temp,{recursive:true,force:true});}catch{}
});
