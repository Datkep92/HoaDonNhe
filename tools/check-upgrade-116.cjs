'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function run() {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cntax-upgrade-116-')),target=path.join(dir,'CN-Tax-Tools.exe'),next=path.resolve('release/CN-Tax-Tools-v1.1.7.exe');
 fs.copyFileSync(path.resolve('artifacts/upgrade-1.1.6/CN-Tax-Tools-v1.1.6.exe'),target);
 const data=path.join(dir,'du_lieu');fs.mkdirSync(data);const marker=path.join(data,'preserve.txt');fs.writeFileSync(marker,'synthetic-data-preserved');
 const env={...process.env,PATH:path.join(process.env.SystemRoot,'System32')+';'+process.env.SystemRoot,HOADON_TEST_DATA:data,HOADON_NO_UPDATE_CHECK:'1'};
 async function start(file){const p=spawn(file,['--test-server','--test-persistent-port'],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';p.stdout.on('data',v=>output+=v);p.stderr.on('data',v=>output+=v);p.on('error',e=>output+=e.message);for(let i=0;i<200;i++){if(output.includes('testUrl'))return p;if(p.exitCode!==null)break;await wait(100);}p.kill();throw Error('Startup failed: '+output.slice(-200));}
 const old=await start(target);const oldPid=old.pid;
 const helper=spawn(next,['--apply-update','--target',target,'--next',next,'--pid',String(oldPid),'--no-launch'],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let logs='';helper.stdout.on('data',v=>logs+=v);helper.stderr.on('data',v=>logs+=v);
 await wait(300);old.kill();
 const exit=await new Promise((resolve,reject)=>{helper.on('error',reject);helper.on('exit',resolve);});assert.equal(exit,0,logs);assert.equal(hash(target),hash(next));assert.equal(fs.readFileSync(marker,'utf8'),'synthetic-data-preserved');
 const updated=await start(target);updated.kill();console.log(JSON.stringify({ok:true,from:'1.1.6',to:'1.1.7',actualHelper:true,exeHashVerified:true,dataPreserved:true,nodeNotInPath:true,dir}));
}
run().catch(e=>{console.error(e.message);process.exitCode=1;});
