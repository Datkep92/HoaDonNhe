'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process'),assert=require('node:assert/strict');
const CDP=require('chrome-remote-interface'),{browserPath}=require('../src/browser');
async function main(){
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'cntax-billing-ui-'));let client,chrome,child,output='';
 const commercial=process.argv.includes('--commercial');
 if(commercial){const dataDir=path.join(temp,'data'),s=new (require('../src/support').SupportStore)(dataDir,{useDefaultGateway:false});s.data.billing={commercial:true,revision:1,launchAt:new Date().toISOString()};s.save();new (require('../src/billing-store').BillingStore)(dataDir,s).configure(s.data.billing);}
 try {
  child=spawn(process.execPath,['src/server.js','--test-server'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,HOADON_TEST_DATA:path.join(temp,'data'),HOADON_NO_UPDATE_CHECK:'1'},windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',v=>output+=v);child.stderr.on('data',v=>output+=v);
  let match;for(let i=0;i<200;i++){match=output.match(/\{"testUrl":"([^"]+)"/);if(match)break;await new Promise(r=>setTimeout(r,100));}if(!match)throw Error('Test server failed: '+output.slice(-500));
  const url=match[1],profile=path.join(temp,'chrome');
  chrome=spawn(browserPath(),['--headless=new','--no-first-run','--no-default-browser-check','--disable-extensions','--disable-gpu','--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
  const portFile=path.join(profile,'DevToolsActivePort');for(let i=0;i<200&&!fs.existsSync(portFile);i++)await new Promise(r=>setTimeout(r,100));
  const port=Number(fs.readFileSync(portFile,'utf8').split('\n')[0]);client=await CDP({port});
  await client.Page.enable();await client.Runtime.enable();await client.Emulation.setDeviceMetricsOverride({width:1366,height:900,deviceScaleFactor:1,mobile:false});
  const errors=[];client.Runtime.exceptionThrown(e=>errors.push(e.exceptionDetails.text));
  await client.Page.navigate({url});await new Promise(r=>setTimeout(r,3000));
  await client.Runtime.evaluate({expression:"document.getElementById('settings-open').click()"});await new Promise(r=>setTimeout(r,1000));
  const response=await client.Runtime.evaluate({expression:`JSON.stringify({open:document.getElementById('settings-dialog').open,hidden:document.getElementById('billing-panel').hidden,startup:document.getElementById('settings-tab-startup').hidden,keyForm:document.getElementById('settings-license-form').hidden,expired:document.getElementById('license-expired').hidden})`,returnByValue:true});
  const state=JSON.parse(response.result.value);assert.equal(state.open,true);assert.equal(state.hidden,!commercial);assert.equal(state.startup,true);assert.equal(state.keyForm,!commercial);assert.equal(state.expired,true);assert.deepEqual(errors,[]);
  const shot=await client.Page.captureScreenshot({format:'png'});const screen=commercial?'artifacts/billing-commercial-ui.png':'artifacts/billing-free-ui.png';fs.writeFileSync(screen,Buffer.from(shot.data,'base64'));
  const api=await client.Runtime.evaluate({expression:"fetch('/api/billing/status').then(r=>r.json()).then(j=>JSON.stringify(j.value))",awaitPromise:true,returnByValue:true});assert.equal(JSON.parse(api.result.value).freeAccess,true);
  console.log(JSON.stringify({ok:true,state,errors,screen}));
 } finally {if(client){try{await client.Browser.close();}catch{}await client.close();}if(chrome&&!chrome.killed)chrome.kill();if(child)child.kill();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
