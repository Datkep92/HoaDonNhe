'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function harness(){
 const sheets=new Map(),props={GATEWAY_SHARED_SECRET:'test-secret'};let uuid=0;
 function sheet(name,values=[]){const s={getName:()=>name,getLastRow:()=>values.length,getDataRange:()=>({getValues:()=>values.map(r=>r.slice())}),appendRow:r=>values.push(r.slice()),getRange:(r,c,nr=1,nc=1)=>({setValue:v=>{while(values.length<r)values.push([]);values[r-1][c-1]=v;},setValues:block=>{assert.equal(block.length,nr,'Sheets row count');block.forEach((row,i)=>{assert.equal(row.length,nc,'Sheets column count');while(values.length<r+i)values.push([]);row.forEach((v,j)=>values[r+i-1][c+j-1]=v);});}}),values};sheets.set(name,s);return s;}
 const header=['Hardware ID','Machine ID','Hardware ID V2','Chat Room ID','License Key','Status','Expiry Date','First Install Time','Last Seen Time'];
 const hw='HW2-'+'A'.repeat(32),machine='DEV_'+'B'.repeat(16),room='ROOM_WIN_TEST0001',installationId='11111111-2222-4333-8444-555555555555';
 sheet('Devices',[header,[installationId,machine,hw,room,'','Expired','',new Date('2020-01-01'),'']]);
 sheet('Licenses',[['License Key','Status','Expiry Date','Hardware ID','Chat Room ID','Activated At','Max Devices']]);
 sheet('Bindings',[['License Key','Hardware ID','Chat Room ID','Activated At']]);
 sheet('Settings',[['Key','Value']]);
 const ss={getId:()=> '1AAgGBqZG4SVbTmgd9zvNpfjDwS07lSVxwyw_IIYoJVQ',getSheetByName:n=>sheets.get(n)||null,insertSheet:n=>sheet(n)};
 const context=vm.createContext({Date,JSON,Math,Number,String,Array,Object,Set,Map,console,LockService:{getScriptLock:()=>({waitLock(){},releaseLock(){}})},PropertiesService:{getScriptProperties:()=>({getProperty:k=>props[k]||'',setProperty:(k,v)=>props[k]=v})},SpreadsheetApp:{getActive:()=>ss},Utilities:{getUuid:()=>String(++uuid).padStart(32,'0'),formatDate:d=>new Date(d).toISOString().slice(0,10)}});
 vm.runInContext(fs.readFileSync('src/code.gs.txt','utf8'),context);
 const input={hardwareIdV2:hw,machineId:machine,installationId,chatRoomId:room};
 const action=(name,body={})=>context.billingAction_({...input,billingAction:name,...body});
 const admin=text=>context.billingAdmin_({chatRoomId:room,text,actor:'admin-test'});
 return {context,action,admin,props,sheets,input};
}
test('Telegram confirmation cannot create a second key when pressed again',()=>{
 const h=harness(),input={chatRoomId:h.input.chatRoomId,text:'/newplan MST10 30 2',actor:'admin-test',requestId:'TG-20-50-test'};
 const first=h.context.billingAdmin_(input);assert.ok(first.keyName);
 const count=h.sheets.get('Licenses').values.length;
 assert.throws(()=>h.context.billingAdmin_(input),/đã được xử lý/);
 assert.equal(h.sheets.get('Licenses').values.length,count);
});
test('usage snapshots are idempotent and display readable counts without modifying old records',()=>{
 const h=harness(),day='2026-10-10';
 const snapshot={[day+':bank_import:ok']:2,[day+':/api/download:ok']:3,[day+':/api/mst/lookup/captcha:ok']:8,[day+':/api/mst/lookup/search:ok']:4,[day+':/api/download:error']:1,[day+':overview:ok']:90};
 const body={snapshot,mst:['0315058003','0315058003','4500673829'],reportId:h.input.installationId};
 assert.equal(h.action('usage',body).mstCount,2);h.action('usage',body);
 const table=h.sheets.get('UsageDaily'),head=table.values[0],row=table.values[1];
 assert.equal(table.values.length,2);assert.equal(row[head.indexOf('Số MST')],2);
 assert.equal(row[head.indexOf('Thời gian sử dụng (giây)')],90);
 assert.equal(row[head.indexOf('Nhập sao kê thành công')],2);
 assert.equal(row[head.indexOf('Yêu cầu tải hóa đơn')],3);
 assert.equal(row[head.indexOf('Yêu cầu tra cứu MST')],4);
 assert.equal(h.sheets.get('UsageFeatures').values.length,7);
 assert.match(h.admin('/usage').reply,/MST đang quản lý: 2/);
 assert.throws(()=>h.action('usage',{snapshot:{[day+':overview:ok']:-1}}),/Bộ đếm/);
 assert.equal(h.sheets.get('Devices').values.length,2);
 assert.throws(()=>h.action('usage',{...body,reportId:'another-installation'}),/Bản cài/);
 assert.throws(()=>h.context.billingAction_({...h.input,hardwareIdV2:'HW2-'+ 'F'.repeat(32),billingAction:'usage',...body}),/Phần cứng/);
 const oldInput={...h.input};delete oldInput.hardwareIdV2;
 h.context.billingAction_({...oldInput,billingAction:'usage',...body});
 assert.equal(h.sheets.get('UsageDaily').values.length,2);
});
test('checkdulieu reports month and lifetime, deduplicates installations and leaves check untouched',()=>{
 const h=harness(),month=h.context.BillingCore().month(Date.now()),day=month+'-01',old='2020-01-01';
 const snapshot={
  [day+':/api/download:ok']:3,[old+':/api/download:ok']:7,
  [day+':/api/download:error']:99,[day+':bank_import:ok']:2,
  [day+':/api/mst/lookup/search:ok']:4,[day+':/api/tokhai/download:ok']:5,
  [day+':/api/invoice-replacement/export:ok']:1,[day+':overview:ok']:3600,
  [old+':overview:ok']:1800,
 };
 h.action('usage',{snapshot,mst:['0315058003','4500673829'],reportId:h.input.installationId});
 const table=h.sheets.get('UsageDaily');
 table.appendRow([h.input.machineId+':'+h.input.installationId,JSON.stringify({machine:h.input.machineId,installationId:h.input.installationId,updatedAt:1,mst:['removed'],counters:snapshot})]);
 table.appendRow(['broken','not JSON']);table.appendRow(['null','null']);
 table.appendRow(['other',JSON.stringify({machine:'another-hardware',updatedAt:Date.now(),mst:['unrelated'],counters:snapshot})]);
 const before=JSON.stringify(['Devices','Licenses','Bindings'].map(n=>h.sheets.get(n).values));
 const reply=h.admin('/checkdulieu@TestBot').reply;
 assert.match(reply,/MST đang quản lý: 2/);assert.match(reply,/Bản cài đã báo cáo: 1/);
 assert.match(reply,/Tải hóa đơn \(lượt yêu cầu\): 3 \/ 10/);
 assert.match(reply,/Nhập sao kê thành công: 2 \/ 2/);
 assert.match(reply,/Tra cứu MST \(lượt yêu cầu\): 4 \/ 4/);
 assert.match(reply,/Tải tờ khai \(lượt yêu cầu\): 5 \/ 5/);
 assert.match(reply,/Xuất MISA thành công: 1 \/ 1/);
 assert.match(reply,/Thời gian tương tác: 1 giờ 0 phút \/ 1 giờ 30 phút/);
 assert.match(reply,/Tổng quan/);assert.doesNotMatch(reply,/removed|unrelated/);
 assert.ok(reply.length<4096);assert.equal(h.admin('/check'),null);
 assert.equal(JSON.stringify(['Devices','Licenses','Bindings'].map(n=>h.sheets.get(n).values)),before);
 assert.equal(h.admin('/usage').reply,reply);
});
test('checkdulieu distinguishes missing reports and stale reports from zero usage',()=>{
 const h=harness();assert.match(h.admin('/checkdulieu').reply,/Chưa có báo cáo không có nghĩa/);
 assert.equal(h.sheets.has('UsageDaily'),false);
 h.action('usage',{snapshot:{},mst:[],reportId:h.input.installationId});
 const row=h.sheets.get('UsageDaily').values[1],value=JSON.parse(row[1]);
 value.updatedAt=Date.now()-3600000;row[1]=JSON.stringify(value);
 assert.match(h.admin('/checkdulieu').reply,/Báo cáo đã quá 30 phút/);
 assert.match(h.admin('/checkdulieu').reply,/MST đang quản lý: 0/);
});
test('setup verifies the CRM sheet and retains free mode and existing devices',()=>{
 const h=harness();assert.throws(()=>h.context.billingSetup_({expectedSheetId:'wrong'}),/không khớp/);
 const out=h.context.billingSetup_({expectedSheetId:'1AAgGBqZG4SVbTmgd9zvNpfjDwS07lSVxwyw_IIYoJVQ'});
 assert.equal(out.commercial,false);assert.ok(out.tables.includes('UsageFeatures'));
 assert.equal(h.sheets.get('Devices').values.length,2);assert.equal(h.sheets.get('Plans').values.length,5);
});
test('legacy admin mutations return fresh status and stable receipt prevents double extension',()=>{
 const h=harness(),run=(text,requestId)=>h.context.adminCommand_({chatRoomId:h.input.chatRoomId,text,actor:'admin-test',requestId});
 assert.equal(run('/lock','lock1').status,'Locked');
 run('/new thang 1','new1');
 assert.equal(run('/unlock','unlock1').status,'Active');
 const first=run('/extend 45','extend1'),second=run('/extend 45','extend1');
 assert.equal(new Date(first.expiryAt).getTime(),new Date(second.expiryAt).getTime());
 assert.ok(new Date(first.expiryAt).getTime()>Date.now()+70*86400000);
 assert.equal(run('/reset','reset1').status,'Expired');
 assert.equal(h.sheets.get('Devices').values[1][5],'Unactivated');
 const device=h.sheets.get('Devices').values[1];assert.equal(device[0],h.input.installationId);assert.equal(device[2],h.input.hardwareIdV2);
 assert.throws(()=>h.context.adminCommand_({chatRoomId:h.input.chatRoomId,text:'/lock',expectedKey:'WRONG'}),/Key đã thay đổi/);
});
test('billing confirmations reject changed key and orders expose pending entries only',()=>{
 const h=harness();assert.throws(()=>h.context.billingAdmin_({chatRoomId:h.input.chatRoomId,text:'/newplan MST10 30 1',expectedKey:'STALE',requestId:'req'}),/Key đã thay đổi/);
 assert.equal(h.sheets.get('Licenses').values.length,1);
 const out=h.admin('/orders');assert.equal(out.menuOrders.length,0);
});
test('release confirmation rejects a draft changed after preview without publishing',()=>{
 const h=harness();h.admin('/release 1.2.0 Nội dung mới');
 const preview=h.admin('/release_preview');assert.equal(preview.menuRelease.version,'1.2.0');
 assert.throws(()=>h.context.billingAdmin_({chatRoomId:h.input.chatRoomId,text:'/release publish',expectedDraftAt:preview.menuRelease.at-1,requestId:'release1'}),/Bản nháp đã thay đổi/);
 assert.equal(h.context.billingJson_('Releases','current').value,null);
 const out=h.context.billingAdmin_({chatRoomId:h.input.chatRoomId,text:'/release publish',expectedDraftAt:preview.menuRelease.at,requestId:'release2'});
 assert.match(out.reply,/Đã công bố v1.2.0/);
 assert.throws(()=>h.context.billingAdmin_({chatRoomId:h.input.chatRoomId,text:'/release publish',requestId:'release2'}),/đã được xử lý/);
});
test('unpublished default is free; admin toggles and quote/order approval are idempotent',()=>{
 const h=harness();assert.equal(h.action('config').config.commercial,false);
 h.admin('/commerce on');h.props.BILLING_CONFIG=JSON.stringify({commercial:true,revision:1,launchAt:'2020-01-01'});
 const q=h.action('quote',{mst:10,devices:2,term:'year'});assert.equal(q.quote.total,750000);
 const o=h.action('order',{quoteId:q.quoteId});assert.equal(h.action('order',{quoteId:q.quoteId}).id,o.id);
 assert.throws(()=>h.admin('/approve '+o.id),/paid/);
 const approved=h.admin('/approve '+o.id+' paid');assert.match(approved.reply,/Key:/);
 assert.match(h.admin('/approve '+o.id+' paid').reply,/đã được xử lý/);
 assert.equal(h.action('orders').length,1);
});
test('monthly bank quota counts only commits, releases failed requests, and deduplicates retries',()=>{
 const h=harness();h.props.BILLING_CONFIG=JSON.stringify({commercial:true,revision:1,launchAt:'2020-01-01'});
 const reserve=n=>h.action('quota_reserve',{kind:'bank',fingerprint:String(n).repeat(64)});
 const first=reserve(1);h.action('quota_release',{ticket:first.ticket});
 const a=reserve(2);assert.match(a.ticket,/bank:\d{4}-\d{2}:/);h.action('quota_commit',{ticket:a.ticket});
 const b=reserve(3);h.action('quota_commit',{ticket:b.ticket});
 assert.throws(()=>reserve(4),/hết lượt/);
 assert.equal(reserve(2).ticket,a.ticket);
 h.action('quota_release',{ticket:a.ticket});assert.throws(()=>reserve(4),/hết lượt/);
});
test('MISA allows one successful export per month; a second fingerprint is rejected',()=>{
 const h=harness();h.props.BILLING_CONFIG=JSON.stringify({commercial:true,revision:1,launchAt:'2020-01-01'});
 const a=h.action('quota_reserve',{kind:'replacement',fingerprint:'a'.repeat(64)});h.action('quota_commit',{ticket:a.ticket});
 assert.throws(()=>h.action('quota_reserve',{kind:'replacement',fingerprint:'b'.repeat(64)}),/hết lượt/);
});
test('basic MST is explicit; background cannot spend changes; only three replacements',()=>{
 const h=harness();h.props.BILLING_CONFIG=JSON.stringify({commercial:true,revision:1,launchAt:'2020-01-01'});
 h.action('mst_use',{mst:'0315058003'});assert.throws(()=>h.action('mst_use',{mst:'0100109106'}),/Chọn MST/);
 for(const mst of ['0100109106','0100773180','0300588569'])h.action('mst_select',{mst});
 assert.throws(()=>h.action('mst_select',{mst:'0315058003'}),/3 lần/);
});
test('hardware lookup preserves old installation and room; ambiguous fingerprints reject',()=>{
 const h=harness(),data=h.context.rows_(h.sheets.get('Devices'));
 assert.equal(h.context.findDevice_(data,{...h.input,installationId:'99999999-8888-4777-8666-555555555555'}).index,0);
 h.sheets.get('Devices').appendRow(h.sheets.get('Devices').values[1]);
 assert.throws(()=>h.context.findDevice_(h.context.rows_(h.sheets.get('Devices')),h.input),/trùng/);
});
