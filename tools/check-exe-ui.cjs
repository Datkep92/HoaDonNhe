'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),{spawn}=require('node:child_process');
async function main(){
 const exe=path.resolve(process.argv[2]),temp=fs.mkdtempSync(path.join(os.tmpdir(),'cntax-ui-check-'));
 const child=spawn(exe,['--test-server'],{windowsHide:true,env:{...process.env,HOADON_TEST_DATA:temp,HOADON_NO_UPDATE_CHECK:'1'},stdio:['ignore','pipe','pipe']});
 let output='',ended=false,client,chrome;child.stdout.on('data',v=>output+=v);child.stderr.on('data',v=>output+=v);child.on('exit',()=>ended=true);child.on('error',e=>output+=e.message);
 try {
  let match;for(let i=0;i<200;i++){match=output.match(/\{"testUrl":"([^"]+)"/);if(match||ended)break;await new Promise(r=>setTimeout(r,100));}
  if(!match)throw Error('Không khởi động được: '+output.slice(-600));
  const url=new URL(match[1]);
  const request=name=>new Promise((resolve,reject)=>{const req=http.get({hostname:'127.0.0.1',port:url.port,path:'/'+name,headers:{Cookie:'hd_session='+url.searchParams.get('launch')}},res=>{let body='';res.on('data',v=>body+=v);res.on('end',()=>resolve({name,status:res.statusCode,bytes:Buffer.byteLength(body),body}));});req.setTimeout(10000,()=>req.destroy(Error('timeout')));req.on('error',reject);});
  const page=await request(''),files=[...new Set([...page.body.matchAll(/<script[^>]*src=["']([^"']+)["']/g)].map(m=>m[1]).filter(x=>!/^https?:/.test(x)).concat('icon.png'))];
  const results=await Promise.all(files.map(request)),errors=[],networkFailures=[];let periodReady,chatUi;
  fs.writeFileSync(path.resolve('artifacts/packed-update-ui.js'),(await request('update-ui.js')).body);
  if(process.argv.includes('--browser')) {
   const profile=path.join(temp,'chrome'),CDP=require('chrome-remote-interface');
   chrome=spawn(require('../src/browser').browserPath(),['--headless=new','--no-first-run','--no-default-browser-check','--disable-extensions','--disable-gpu','--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
   const portFile=path.join(profile,'DevToolsActivePort');for(let i=0;i<200&&!fs.existsSync(portFile);i++)await new Promise(r=>setTimeout(r,100));
   client=await CDP({port:Number(fs.readFileSync(portFile,'utf8').split('\n')[0])});await client.Page.enable();await client.Runtime.enable();await client.Network.enable();
   client.Runtime.exceptionThrown(e=>errors.push(e.exceptionDetails.exception?.description||e.exceptionDetails.text));client.Network.loadingFailed(e=>{if(!e.canceled)networkFailures.push(e.errorText);});
   await client.Page.navigate({url:match[1]});await new Promise(r=>setTimeout(r,6000));
   periodReady=(await client.Runtime.evaluate({expression:"typeof Period !== 'undefined' && typeof Period.rangeFor === 'function'",returnByValue:true})).result.value;
   if(process.argv.includes('--chat')) {
    await client.Runtime.evaluate({expression:"document.getElementById('support-toggle').click()"});await new Promise(r=>setTimeout(r,2000));
    chatUi=(await client.Runtime.evaluate({expression:"JSON.stringify({buttons:[...document.querySelectorAll('#chat-modes button')].filter(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden').map(e=>e.textContent.trim()),technicalControlsVisible:[...document.querySelectorAll('#ai-edit,#ai-new,#ai-permissions,#ai-retry,#ai-runtime,#ai-capabilities')].some(e=>e.getClientRects().length),label:document.getElementById('ai-mode-label').textContent})",returnByValue:true})).result.value;
    chatUi=JSON.parse(chatUi);if(chatUi.buttons.length!==2||!chatUi.buttons.includes('Chatbot')||chatUi.technicalControlsVisible)errors.push('Chat UI failed: '+JSON.stringify(chatUi));
    fs.writeFileSync(path.resolve('artifacts/workspace-ai-chat.png'),Buffer.from((await client.Page.captureScreenshot()).data,'base64'));
   }
   if(process.argv.includes('--update')) {
    await client.Runtime.evaluate({expression:`(() => {const original=window.fetch;window.__updateCalls=0;window.__fixtureUpdate={updateAvailable:true,current:'1.1.7',latest:'9.0.0',notes:'AI hỗ trợ kế toán\\nTrạng thái hóa đơn',canSelfUpdate:true,mandatory:true,stage:'available'};window.fetch=async(url,options)=>{if(String(url)==='/api/update/start'){window.__updateCalls++;return new Response(JSON.stringify({ok:true,value:{ok:true,started:true}}),{headers:{'Content-Type':'application/json'}});}const result=await original(url,options);if(String(url)==='/api/state'){const data=await result.clone().json();data.value.update=window.__fixtureUpdate;return new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});}return result;};window.dispatchEvent(new CustomEvent('hd:state',{detail:{update:window.__fixtureUpdate}}));})()`});
    await new Promise(r=>setTimeout(r,2000));
    await client.Runtime.evaluate({expression:"window.dispatchEvent(new CustomEvent('hd:state',{detail:{update:window.__fixtureUpdate}}))"});
    fs.writeFileSync(path.resolve('artifacts/mandatory-update-notice.png'),Buffer.from((await client.Page.captureScreenshot()).data,'base64'));
    await client.Runtime.evaluate({expression:"(()=>{const d=document.getElementById('update-dialog'),c=d.close;d.close=function(){window.__closeTrace=new Error().stack;return c.apply(d,arguments)};d.addEventListener('cancel',e=>{window.__cancelPrevented=e.defaultPrevented;});})()"});
    const immediate=(await client.Runtime.evaluate({expression:"JSON.stringify({open:document.getElementById('update-dialog').open,title:document.getElementById('update-title').textContent,loaded:[...document.scripts].filter(s=>s.src.includes('update-ui')).length})",returnByValue:true})).result.value;
    await client.Input.dispatchKeyEvent({type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    const before=(await client.Runtime.evaluate({expression:"JSON.stringify({open:document.getElementById('update-dialog').open,calls:window.__updateCalls,cancelPrevented:window.__cancelPrevented,trace:window.__closeTrace,buttons:[...document.querySelectorAll('#update-dialog button')].map(b=>b.textContent.trim())})",returnByValue:true})).result.value;
    const pre=JSON.parse(before);if(!pre.open||pre.calls!==0||pre.buttons.join(',')!=='Cập nhật')errors.push('Mandatory notice/Escape failed: '+before+' immediate='+immediate);
    await client.Runtime.evaluate({expression:"document.getElementById('update-now').click();document.getElementById('update-now').click()"});await new Promise(r=>setTimeout(r,200));
    if((await client.Runtime.evaluate({expression:'window.__updateCalls',returnByValue:true})).result.value!==1)errors.push('Update button duplicate');
    await client.Runtime.evaluate({expression:"window.__fixtureUpdate.stage='available';window.dispatchEvent(new CustomEvent('hd:state',{detail:{update:window.__fixtureUpdate}}))"});
    await client.Input.dispatchMouseEvent({type:'mousePressed',x:1,y:1,button:'left',clickCount:1});await client.Input.dispatchMouseEvent({type:'mouseReleased',x:1,y:1,button:'left',clickCount:1});await new Promise(r=>setTimeout(r,200));
    if((await client.Runtime.evaluate({expression:'window.__updateCalls',returnByValue:true})).result.value!==2)errors.push('Backdrop did not start update');
    await client.Runtime.evaluate({expression:"window.__fixtureUpdate.stage='waiting';window.dispatchEvent(new CustomEvent('hd:state',{detail:{update:window.__fixtureUpdate}}))"});
    if((await client.Runtime.evaluate({expression:"document.getElementById('update-dialog').matches(':modal')",returnByValue:true})).result.value)errors.push('Waiting blocks saving existing work');
    fs.writeFileSync(path.resolve('artifacts/mandatory-update-browser.png'),Buffer.from((await client.Page.captureScreenshot()).data,'base64'));
   }
  }else await new Promise(r=>setTimeout(r,2000));
  const repeat=await request('period.js');const ok=!ended&&results.every(r=>r.status===200&&r.bytes>0)&&repeat.status===200&&errors.length===0&&networkFailures.length===0&&periodReady!==false;
  console.log(JSON.stringify({exe,ok,exited:ended,periodReady,chatUi,errors,networkFailures,results:results.map(({body,...r})=>r)}));if(!ok)process.exitCode=1;
 }finally{if(client){try{await client.Browser.close();}catch{}await client.close();}if(chrome&&!chrome.killed)chrome.kill();if(!ended)child.kill();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
