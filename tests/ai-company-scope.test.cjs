'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createSessionStore } = require('../src/ai/session-store');
const { createAiService } = require('../src/ai-service');
const { summaryReport } = require('../src/ai/local-report');
const dir = (t, close = () => {}) => { const d=fs.mkdtempSync(path.join(os.tmpdir(),'ai-scope-')); t.after(()=>{close();fs.rmSync(d,{recursive:true,force:true});}); return d; };
test('scope follows application format: personal 12 digits, branch and internal code isolated',t=>{
 let store;store=createSessionStore(dir(t,()=>store?.close()));
 for(const code of ['058079001853','0123456789','0123456789-001','KH-KIM-HUONG']) {
   const s=store.resolve('agent',code);store.append(s,{role:'user',content:code});assert.equal(store.history(s,10).length,1);assert.equal(store.history(s,10)[0].content,code);
 }
 for(const code of ['../outside','CON','a/b',null])assert.throws(()=>store.resolve('agent',code));
});
test('service accepts selected 12-digit scope before any provider network call',async t=>{
 let service;service=createAiService({dataDir:dir(t,()=>service?.close()),secrets:{read:()=>({}),write(){},clear(){}},app:{context:()=>({currentUser:{selectedMst:'058079001853'}})},checkLicense:async()=>({status:'Active'}),fetchImpl:async()=>{throw Error('Network must not run');}});
 let out;await service.handle({method:'GET'},{},new URL('http://local/api/ai/history?id=agent'),()=>{},(_,status,value)=>out={status,value});assert.equal(out.status,200);assert.deepEqual(out.value.value,[]);
});
test('report uses exact local amounts, recognizes accent-free company and refuses different company',()=>{
 const data={company:'Hộ kinh doanh Kim Hường',invoices:3,active:2,inactive:1,sell:2,buy:1,amountSell:1234567,amountBuy:200000,taxSell:100000,taxBuy:10000};
 const context={currentUser:{selectedMst:'058079001853'}};
 const report=summaryReport(data,{from:'2026-10-01',to:'2026-10-31'},context,'dữ liệu kinh doanh tháng 10 của kim huong. báo cáo cho tôi');assert.match(report,/1\.234\.567/);assert.match(report,/2026-10-31/);assert.match(report,/không gửi lên model/);
 const wrong=summaryReport(data,{},context,'báo cáo của Công ty khác.');assert.match(wrong,/Chưa xác minh/);assert.doesNotMatch(wrong,/1\.234\.567/);
 assert.match(summaryReport({}, {},context,'báo cáo'),/Chưa có dữ liệu/);
});
