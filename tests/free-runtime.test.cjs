'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createRuntime, freeModels, publicMessages } = require('../src/ai/free-runtime');
const model = id => ({ id, isFree: true, pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['text'] }, supported_parameters: ['tools'] });
const dir = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-free-')); t.after(() => fs.rmSync(d, { force: true, recursive: true })); return d; };
const ok = () => Response.json({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] });
test('only explicit free text models, never name/unknown price/audio zero-price', () => {
 assert.deepEqual(freeModels({ data: [model('yes'), {...model('missing'), pricing:{}}, {...model('paid-free'), isFree:false}, {...model('audio'), architecture:{output_modalities:['audio']}}] }).map(m=>m.id), ['yes']);
});
test('no auth, no binary, persisted catalog across restart, model fallback bounded', async t => {
 let catalogs=0, turns=0; const d=dir(t), fetchImpl=async (url, init)=>{if(url.endsWith('/models')){catalogs++;return Response.json({data:[model('first'),model('next')]});} turns++; assert.equal(init.headers.Authorization,undefined); assert.equal(init.redirect,'error'); return turns===1?new Response('',{status:503}):ok();};
 const a=createRuntime(d,{fetchImpl}); assert.equal(a.status().requiresDownload,false);
 assert.equal((await a.chat({basic:true,messages:[{role:'user',content:'q'}]})).final,'OK');
 const b=createRuntime(d,{fetchImpl}); await b.chat({basic:true,messages:[{role:'user',content:'q'}]}); assert.equal(catalogs,1); assert.equal(turns,3); a.close();b.close();
});
test('IP quota never retries other models; Retry-After survives restart', async t => {
 let turns=0; const d=dir(t), fetchImpl=async url=>url.endsWith('/models')?Response.json({data:[model('one'),model('two')]}):(turns++,new Response('',{status:429,headers:{'Retry-After':'120'}}));
 const r=createRuntime(d,{fetchImpl}); const input={basic:true,messages:[{role:'user',content:'q'}]}; await assert.rejects(r.chat(input),/giới hạn/); assert.equal(turns,1); await assert.rejects(createRuntime(d,{fetchImpl}).chat(input),/theo IP/); assert.equal(turns,1);
});
test('permission/auth refusal does not rotate or fall back to paid',async t=>{
 let n=0;const r=createRuntime(dir(t),{fetchImpl:async url=>url.endsWith('/models')?Response.json({data:[model('a'),model('b')]}):(n++,new Response('',{status:403}))});await assert.rejects(r.chat({basic:true,messages:[]}),/từ chối/);assert.equal(n,1);
});
test('cancellation stops requests and no success is synthesized',async t=>{
 const c=new AbortController();c.abort();const r=createRuntime(dir(t),{fetchImpl:async()=>{throw Error('must not call')}});await assert.rejects(r.chat({messages:[],signal:c.signal}));
});
test('public context withholds raw tool rows, company and attachment values',()=>{
 const out=publicMessages([{role:'tool',tool_call_id:'x',content:JSON.stringify({ok:true,data:{datasetId:'d',rows:[{name:'PRIVATE',amount:100}],count:1},meta:{tool:'file.read_excel',companyId:'0012345678'}})},{role:'system',content:'Context ứng dụng: '+JSON.stringify({companyId:'0012345678',currentUser:{password:'PRIVATE'},attachments:[{id:'id',filename:'PRIVATE.xlsx'}]})}]); assert.doesNotMatch(JSON.stringify(out),/PRIVATE|0012345678|amount/);assert.match(JSON.stringify(out),/datasetId/);assert.equal(out[0].tool_call_id,'x');
});
