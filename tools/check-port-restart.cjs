'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const exe=process.argv[2]?path.resolve(process.argv[2]):process.execPath;
async function main(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cntax-port-restart-'));let previous;
 for(let i=0;i<2;i++) {
  const args=process.argv[2]?[]:[path.resolve('src/server.js')];
  const p=spawn(exe,[...args,'--test-server','--test-persistent-port'],{windowsHide:true,env:{...process.env,HOADON_TEST_DATA:dir,HOADON_NO_UPDATE_CHECK:'1'},stdio:['ignore','pipe','pipe']});let output='';p.stdout.on('data',v=>output+=v);p.stderr.on('data',v=>output+=v);
  try {
   let match;for(let n=0;n<200;n++){match=output.match(/\{"testUrl":"([^"]+)"/);if(match)break;await new Promise(r=>setTimeout(r,100));}if(!match)throw Error('Server did not start: '+output.slice(-400));
   const url=new URL(match[1]);if(previous)assert.equal(url.port,previous.port);assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'local-server.json'),'utf8')).port,Number(url.port));
   const request=cookie=>new Promise((resolve,reject)=>{const req=http.get({hostname:'127.0.0.1',port:url.port,path:'/api/ping',headers:{Cookie:'hd_session='+cookie}},r=>{r.resume();r.on('end',()=>resolve(r.statusCode));});req.on('error',reject);});
   assert.equal(await request(url.searchParams.get('launch')),200);
   if(previous)assert.notEqual(await request(previous.searchParams.get('launch')),200);
   console.log(JSON.stringify({run:i+1,pid:p.pid,port:Number(url.port),samePort:previous?url.port===previous.port:null,authenticated:true}));previous=url;
  }finally{if(p.exitCode===null){const exited=new Promise(resolve=>p.once('exit',resolve));p.kill();await exited;}}
 }
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
