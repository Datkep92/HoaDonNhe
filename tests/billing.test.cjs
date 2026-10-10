'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const rules=require('../src/billing-core'),{BillingStore}=require('../src/billing-store'),{derive}=require('../src/hardware-id');
test('price boundaries, devices, discounts and invalid input',()=>{
 for(const [mst,plan] of [[1,'MST10'],[10,'MST10'],[11,'MST20'],[20,'MST20'],[21,'MST30'],[30,'MST30'],[31,'MST50'],[50,'MST50']])assert.equal(rules.quote({mst,devices:1}).planId,plan);
 assert.equal(rules.quote({mst:10,devices:2,term:'quarter'}).total,213750);
 assert.equal(rules.quote({mst:10,devices:2,term:'year'}).total,750000);
 for(const x of [{mst:51,devices:1},{mst:10,devices:0},{mst:10,devices:1,term:'x'},{mst:1.5,devices:1}])assert.throws(()=>rules.quote(x));
});
test('calendar month clamp in Vietnam and upgrade proportional fee',()=>{
 assert.equal(rules.addMonths('2024-01-31T12:00:00Z',1),'2024-02-29T12:00:00.000Z');
 assert.equal(rules.addMonths('2024-02-29T12:00:00Z',12),'2025-02-28T12:00:00.000Z');
 const start=Date.UTC(2026,0,1),end=start+30*86400000;
 assert.equal(rules.upgrade({periodStart:new Date(start),expiryAt:new Date(end),term:'month',maxMst:10,devices:1,periodPrice:50000},rules.quote({mst:20,devices:1}),start+15*86400000),20000);
});
test('hardware fingerprint excludes OS name/version and rejects placeholders',()=>{
 assert.deepEqual(derive({uuid:'abc',board:'def',bios:'1'}),derive({uuid:'ABC',board:'DEF',bios:'2'}));
 assert.equal(derive({uuid:'00000000-0000-0000-0000-000000000000',board:'To be filled by O.E.M.'}).id,'');
 assert.match(derive({uuid:'abc'}).id,/^HW2-[A-F0-9]{32}$/);
});
test('default is unpublished free, persisted config and same export receipt',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'billing-'));let calls=[];
 const support={data:{device:{installationId:'i'}},publicLicense:()=>({status:'Expired',keyName:'',billing:{}}),publicDevice:()=>({}),gateway:async(p,x)=>{calls.push(x.action);return {ticket:'t'};}};
 const b=new BillingStore(dir,support);assert.equal(b.status().freeAccess,true);await b.limited('bank','one',async()=>({ok:true}));assert.equal(calls.length,0);
 b.configure({commercial:true,revision:2});await b.limited('bank','one',async()=>({ok:true}));assert.deepEqual(calls,['quota_reserve','quota_commit']);
 calls=[];await new BillingStore(dir,support).limited('bank','one',async()=>({ok:true}));assert.equal(calls.length,0);
 b.configure({commercial:false,revision:1});assert.equal(b.status().commercial,true);fs.rmSync(dir,{recursive:true,force:true});
});
test('failed operation releases reservation without spending a receipt',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'billing-'));let calls=[];
 const support={data:{device:{}},publicLicense:()=>({status:'Expired'}),publicDevice:()=>({}),gateway:async(p,x)=>{calls.push(x.action);return {ticket:'t'};}};
 const b=new BillingStore(dir,support);b.configure({commercial:true,revision:1});await assert.rejects(b.limited('replacement','x',async()=>{throw Error('export failure');}));assert.deepEqual(calls,['quota_reserve','quota_release']);assert.equal(Object.keys(b.data.exports).length,0);fs.rmSync(dir,{recursive:true,force:true});
});
test('lost commit response cannot report a saved import as failed; receipt survives restart',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'billing-'));let fails=true;
 const support={data:{device:{installationId:'i'}},publicLicense:()=>({status:'Expired'}),publicDevice:()=>({}),gateway:async(p,x)=>{if(x.action==='quota_commit'&&fails)throw Error('network');return {ticket:'receipt'};}};
 const b=new BillingStore(dir,support);b.configure({commercial:true,revision:1});
 assert.equal((await b.limited('bank','one',async()=>({saved:true}))).saved,true);
 const restored=new BillingStore(dir,support);assert.equal(Object.keys(restored.data.receipts).length,1);fails=false;await restored.flush([]);assert.equal(Object.keys(restored.data.receipts).length,0);fs.rmSync(dir,{recursive:true,force:true});
});
test('unpublished access ignores expiry but admin lock remains; published expired key gets basic access',async()=>{
 const {SupportStore}=require('../src/support');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'billing-license-'));
 const support=new SupportStore(dir,{useDefaultGateway:false});
 support.data.billing={commercial:false,revision:1};support.data.license={status:'Expired',keyName:'OLD',expiryAt:'2020-01-01'};
 assert.equal((await support.enforceLicense()).status,'Active');
 support.data.license.status='Locked';await assert.rejects(support.enforceLicense(),/khóa/);
 support.data.billing={commercial:true,revision:2};support.data.license.status='Expired';
 assert.equal((await support.enforceLicense()).basic,true);fs.rmSync(dir,{recursive:true,force:true});
});
