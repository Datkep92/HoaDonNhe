'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { randomUUID } = require('node:crypto');
const { runAgent } = require('../src/ai/agent');
const { createExecutionStore } = require('../src/ai/execution-store');
const { createWorkflow } = require('../src/ai/workflow');
const { publicMessages } = require('../src/ai/free-runtime');
const { createRegistry } = require('../src/ai/tool-registry');
const { createDatasetStore } = require('../src/ai/dataset-store');
const { validate } = require('../src/ai/tool-router');
function fixture(t, transport) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-agent-'));
  t.after(() => fs.rmSync(dataDir, {recursive:true,force:true}));
  return { dataDir, app:{context:()=>({currentUser:{selectedMst:'0123456789'},accounts:[],app:{today:'2026-10-10'}})}, history:[], text:'Kiểm tra dữ liệu theo từng bước', files:{}, emit(){}, signal:new AbortController().signal, checkLicense:async()=>({status:'active'}), config:{endpoint:'https://example.test/v1/chat/completions',chatTransport:transport} };
}
function call(n, name='source__find', args={query:'nguồn '+n}) { return {calls:[{id:'c'+n,type:'function',function:{name,arguments:JSON.stringify(args)}}],message:{content:null}}; }
test('agent continues beyond 12 turns and finalizes after verified reads', async t => {
  let n=0; const f=fixture(t,async()=>++n<=20?call(n):{final:'Đã kiểm tra đủ 20 nguồn.'});
  assert.match(await runAgent(f),/20 nguồn/); assert.equal(n,21);
});
test('64-turn slice survives restart and resumes next step without rereading', async t => {
  let n=0; const f=fixture(t,async()=>call(++n));
  let store=createExecutionStore(f.dataDir), record=store.begin(randomUUID(),'session',{text:f.text});
  await assert.rejects(runAgent({...f,execution:{store,record}}),e=>e.code==='AGENT_CONTINUATION_REQUIRED');
  assert.equal(n,64); assert.equal(record.checkpoint.step,64);
  store=createExecutionStore(f.dataDir); record=store.load(record.id);
  f.config.chatTransport=async ({messages})=>{ assert.equal(messages.filter(m=>m.role==='tool').length,64); return {final:'Đã khôi phục và kiểm tra kết quả.'}; };
  assert.match(await runAgent({...f,execution:{store,record}}),/khôi phục/); assert.equal(n,64);
});
test('summary does not terminate reasoning; model can request second period and clarify missing costs', async t => {
  let n=0, reads=0; const f=fixture(t,async ({messages})=>{
    n++; if(n<3) return call(n,'invoice__summary',{from:n===1?'2026-10-01':'2026-09-01',to:n===1?'2026-10-31':'2026-09-30'});
    const wire=JSON.stringify(publicMessages(messages)); assert.match(wire,/localEvidence/); assert.match(wire,/9876543/); assert.doesNotMatch(wire,/Công ty kiểm thử|0123456789/);
    return {final:'Đã kiểm tra hai kỳ. [[local:E1]]\n[[local:E2]]\nBạn có bảng chi phí để tính lợi nhuận không?'};
  });
  f.config.publicFree=true; f.app.summary=()=>({amountSell:9876543,amountBuy:++reads,company:'Công ty kiểm thử'});
  const answer=await runAgent(f); assert.equal(reads,2); assert.match(answer,/9\.876\.543/); assert.match(answer,/bảng chi phí/); assert.doesNotMatch(answer,/\[\[local:/);
});
test('local evidence persists, forged references do not become verified values',()=>{
  const w=createWorkflow(); w.observe(call(1),{ok:true,data:{},meta:{tool:'data.report'}},'Số đã kiểm tra: 42');
  const r=createWorkflow(JSON.parse(JSON.stringify(w.snapshot()))).render('[[local:E1]] [[local:E99]]');
  assert.match(r,/42/); assert.match(r,/chưa được xác minh/);
});
test('dataset profile inspects all rows without uploading values or altering original',t=>{
  const f=fixture(t), datasets=createDatasetStore(), rows=[{Tien:'1.000',Ten:'A'},{Tien:'',Ten:'B'},{Tien:200,Ten:null}];
  const id=datasets.put(rows,'0123456789').datasetId;
  const registry=createRegistry({...f,datasets}); const profile=registry.find(x=>x.name==='data.profile').handler({datasetId:id});
  assert.equal(profile.rowCount,3); assert.equal(profile.profile[0].numeric,2); assert.equal(profile.profile[0].empty,1);
  const wire=JSON.stringify(publicMessages([{role:'tool',content:JSON.stringify({ok:true,data:profile,meta:{tool:'data.profile'}})}]));
  assert.match(wire,/numeric/); assert.doesNotMatch(wire,/1\.000/); assert.deepEqual(datasets.get(id,'0123456789'),rows);
});
test('multi-source array validation checks every item and bounds',()=>{
  const schema={type:'array',items:{type:'string'},minItems:1,maxItems:2};
  validate(['a','b'],schema); assert.throws(()=>validate(['a',2],schema)); assert.throws(()=>validate([],schema)); assert.throws(()=>validate(['a','b','c'],schema));
});
