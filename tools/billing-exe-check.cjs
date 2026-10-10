'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),{spawn}=require('node:child_process'),assert=require('node:assert/strict');
async function main(){
 const version=require('../src/version').version,exe=process.argv[2]||path.resolve('release',`CN-Tax-Tools-v${version}.exe`),temp=fs.mkdtempSync(path.join(os.tmpdir(),'cntax-exe-billing-'));
 const child=spawn(exe,['--test-server'],{windowsHide:true,env:{...process.env,HOADON_TEST_DATA:temp,HOADON_NO_UPDATE_CHECK:'1'},stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',v=>output+=v);child.stderr.on('data',v=>output+=v);
 try {
  let m;for(let i=0;i<200;i++){m=output.match(/\{"testUrl":"([^"]+)"/);if(m)break;await new Promise(r=>setTimeout(r,100));}if(!m)throw Error('EXE did not start: '+output.slice(-500));
  const url=new URL(m[1]);const request=(pathname,body)=>new Promise((resolve,reject)=>{const r=http.request({hostname:'127.0.0.1',port:url.port,path:pathname,method:body?'POST':'GET',headers:{Cookie:'hd_session='+url.searchParams.get('launch'),'Content-Type':'application/json'}},res=>{let text='';res.on('data',v=>text+=v);res.on('end',()=>resolve({status:res.statusCode,text}));});r.on('error',reject);r.end(body?JSON.stringify(body):undefined);});
  const status=JSON.parse((await request('/api/billing/status')).text);assert.equal(status.value.commercial,false);assert.equal(status.value.freeAccess,true);
  const quote=await request('/api/billing/quote',{mst:10,devices:1,term:'month'});assert.equal(quote.status,400);
  const ui=await request('/billing-ui.js');assert.equal(ui.status,200);assert.match(ui.text,/billing-panel/);
  console.log(JSON.stringify({ok:true,packed:true,commercial:status.value.commercial,freeAccess:status.value.freeAccess,purchaseBlocked:quote.status===400,billingUi:true}));
 }finally{child.kill();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
