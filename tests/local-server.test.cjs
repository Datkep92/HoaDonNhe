'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {startLocalServer,readPort}=require('../src/local-server');
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'cntax-port-test-'));
const close=server=>new Promise(resolve=>server.close(resolve));
const server=()=>http.createServer((req,res)=>res.end('OK'));
test('losing startup cannot replace the winning instance persisted port',async()=>{
 const dir=temp(),a=server(),b=server(),f=path.join(dir,'local-server.json');
 try {const first=await startLocalServer(a,{dataDir:dir});await startLocalServer(b,{dataDir:dir,persistOnBind:false});assert.equal(readPort(f),first.port);}finally{if(a.listening)await close(a);if(b.listening)await close(b);}
});
test('normal restart with same data directory keeps the port',async()=>{
 const dir=temp(),first=server(),second=server();
 try {const a=await startLocalServer(first,{dataDir:dir});await close(first);const b=await startLocalServer(second,{dataDir:dir});assert.equal(a.port,b.port);assert.equal(readPort(path.join(dir,'local-server.json')),a.port);}
 finally {if(first.listening)await close(first);if(second.listening)await close(second);}
});
test('reuse a running instance without listening or changing the saved port',async()=>{
 const dir=temp(),s=server();fs.writeFileSync(path.join(dir,'local-server.json'),'{"port":12345}');
 const result=await startLocalServer(s,{dataDir:dir,reuseExisting:async()=>true});assert.equal(result.reused,true);assert.equal(s.listening,false);assert.equal(readPort(path.join(dir,'local-server.json')),12345);
});
test('occupied saved port chooses another port and leaves the existing service alive',async()=>{
 const dir=temp(),blocker=server(),s=server(),logs=[];
 try {const occupied=await startLocalServer(blocker,{testMode:true});fs.writeFileSync(path.join(dir,'local-server.json'),JSON.stringify({port:occupied.port}));const result=await startLocalServer(s,{dataDir:dir,log:message=>logs.push(message)});assert.notEqual(result.port,occupied.port);assert.equal(blocker.listening,true);assert.equal(logs.length,1);assert.equal(readPort(path.join(dir,'local-server.json')),result.port);}
 finally {if(blocker.listening)await close(blocker);if(s.listening)await close(s);}
});
test('test servers ignore persisted ports and do not change configuration',async()=>{
 const dir=temp(),s=server(),f=path.join(dir,'local-server.json');fs.writeFileSync(f,'{"port":12345}');
 try {await startLocalServer(s,{dataDir:dir,testMode:true});assert.equal(fs.readFileSync(f,'utf8'),'{"port":12345}');}finally {if(s.listening)await close(s);}
});
test('invalid saved configuration is recovered; reuse errors never create a second server',async()=>{
 const dir=temp(),s=server();fs.writeFileSync(path.join(dir,'local-server.json'),'{broken');
 try {const result=await startLocalServer(s,{dataDir:dir});assert.ok(result.port>0);}finally {if(s.listening)await close(s);}
 const next=server();await assert.rejects(startLocalServer(next,{dataDir:dir,reuseExisting:async()=>{throw Error('busy');}}),/busy/);assert.equal(next.listening,false);
});
test('locked EXE port refuses fallback and preserves occupied port configuration',async()=>{
 const dir=temp(),blocker=server(),next=server();
 try {const a=await startLocalServer(blocker,{dataDir:dir,lockPort:true});await assert.rejects(startLocalServer(next,{dataDir:dir,lockPort:true}),e=>e.code==='APP_PORT_LOCKED');assert.equal(next.listening,false);assert.equal(blocker.listening,true);assert.equal(readPort(path.join(dir,'local-server.json')),a.port);}
 finally {if(blocker.listening)await close(blocker);if(next.listening)await close(next);fs.rmSync(dir,{recursive:true,force:true});}
});
test('locked port persists across restart, never writes a second port',async()=>{
 const dir=temp(),a=server(),b=server();
 try {const first=await startLocalServer(a,{dataDir:dir,lockPort:true});await close(a);const second=await startLocalServer(b,{dataDir:dir,lockPort:true});assert.equal(second.port,first.port);assert.equal(fs.existsSync(path.join(dir,'local-server-startup.lock')),false);}
 finally {if(a.listening)await close(a);if(b.listening)await close(b);fs.rmSync(dir,{recursive:true,force:true});}
});
test('concurrent locked launches reuse owner and create only one listening server',async()=>{
 const dir=temp(),a=server(),b=server();let owned=false;
 try {const options={dataDir:dir,lockPort:true,reuseExisting:async()=>owned,onBound:async()=>{await new Promise(r=>setTimeout(r,30));owned=true;}};const results=await Promise.all([startLocalServer(a,options),startLocalServer(b,options)]);assert.equal(results.filter(r=>r.reused).length,1);assert.equal(Number(a.listening)+Number(b.listening),1);}
 finally {if(a.listening)await close(a);if(b.listening)await close(b);fs.rmSync(dir,{recursive:true,force:true});}
});
test('locked malformed configuration is not silently reassigned',async()=>{
 const dir=temp(),s=server();fs.writeFileSync(path.join(dir,'local-server.json'),'{broken');
 try {await assert.rejects(startLocalServer(s,{dataDir:dir,lockPort:true}),e=>e.code==='APP_PORT_CONFIG_INVALID');assert.equal(s.listening,false);assert.equal(fs.readFileSync(path.join(dir,'local-server.json'),'utf8'),'{broken');}
 finally {fs.rmSync(dir,{recursive:true,force:true});}
});
