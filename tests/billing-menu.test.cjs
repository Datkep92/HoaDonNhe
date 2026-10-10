'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../cloudflare-worker/src/index.js'),'utf8');
function context(){const calls=[],stored=new Map();let msg=100;const c={
 crypto,customerNotice_:()=>'',supportFlow:{owner:async(...args)=>calls.push({method:'owner',args})},
 isOnlineAt:()=>true,onlineReport_:async()=> 'ONLINE',phoneReport_:async()=> 'PHONE',
 telegram:async(env,method,payload)=>{calls.push({method,payload});return method==='getChatMember'?{status:'administrator'}:method==='sendMessage'?{message_id:++msg}:true;},
 firebase:async(env,path,method,body)=>{if(method==='PUT'){stored.set(path,body);return body;}if(method==='DELETE'){stored.delete(path);return null;}return stored.get(path)||(path.startsWith('/telegramTopics/')?{chatRoomId:'ROOM_TEST'}:null);},
 gas:async(env,payload)=>{calls.push({method:'gas',payload});return {reply:'OK',found:true,keyName:'KEY-A'};},
 cacheLicense_:async()=>{},licensePath:()=>'/license',
};vm.createContext(c);vm.runInContext(source.slice(source.indexOf('function billingMenu_()')),c);return {c,calls,stored};}
test('create key wizard validates each stage and confirms exact parameters',()=>{
 const {c}=context();
 const stages=['billing:wizard:newplan','billing:wizard:newplan:MST20','billing:wizard:newplan:MST20:90','billing:wizard:newplan:MST20:90:3'];
 for(const data of stages){const result=c.billingWizard_(data);assert.ok(result.text);assert.equal(result.command,undefined);for(const row of result.markup.inline_keyboard)for(const b of row)assert.ok(Buffer.byteLength(b.callback_data)<=64);}
 assert.equal(c.billingWizard_('billing:wizard:newplan:MST20:90:3:confirm').command,'/newplan MST20 90 3');
 for(const data of ['billing:wizard:lock','billing:wizard:newplan:MST99','billing:wizard:newplan:MST10:0','billing:wizard:newplan:MST10:30:999','billing:wizard:newplan:MST10:30:1:bogus'])assert.throws(()=>c.billingWizard_(data));
});
function query(data){return {id:'callback',from:{id:1},data,message:{message_id:50,message_thread_id:20,chat:{id:'-100'}}};}
const env={TELEGRAM_CHAT_ID:'-100'};
test('command registration is restricted to admin group and hides advanced and broken aliases',async()=>{
 const {c}=context(),sent=[],registered=new Map();
 c.telegram=async(env,method,payload)=>{
  if(method==='getMyCommands')return registered.get(payload.language_code)||[{command:'ai',description:'AI cũ'},{command:'extend',description:'Gia hạn'}];
  if(method==='setMyCommands')registered.set(payload.language_code,payload.commands);
  sent.push(payload);return true;
 };
 await c.billingRegisterCommands_(env);assert.equal(sent.length,6);
 for(const p of sent){assert.ok(['default','all_group_chats','chat_administrators'].includes(p.scope.type));if(p.scope.type==='chat_administrators')assert.equal(p.scope.chat_id,'-100');for(const key of ['ai','menu','billing','check','checkdulieu'])assert.ok(p.commands.some(x=>x.command===key));for(const key of ['extend','new','ai_add','usage','commerce'])assert.ok(!p.commands.some(x=>x.command===key));}
});
test('maintenance initializes only once and refuses publishing commerce',async()=>{
 const {c}=context();let stored=null,sets=0,gasCalls=0;
 const registered=new Map();
 c.firebase=async(env,path,method,body)=>{if(method==='PUT'){stored=body;return body;}return stored;};
 c.gas=async()=>{gasCalls++;return {commercial:false,revision:'test',tables:['UsageDaily']};};
 c.telegram=async(env,method,p)=>{if(method==='getMyCommands')return registered.get(p.language_code)||[];if(method==='setMyCommands'){sets++;registered.set(p.language_code,p.commands);}return true;};
 c.console={log:()=>{}};
 await c.billingMaintenance_(env);await c.billingMaintenance_(env);
 assert.equal(gasCalls,1);assert.equal(sets,6);assert.equal(stored.complete,true);
 stored=null;c.gas=async()=>({commercial:true});await assert.rejects(c.billingMaintenance_(env),/chưa ẩn/);
});
test('commerce button requires confirmation before touching backend',async()=>{
 const {c,calls}=context();await c.billingCallback_(env,query('billing:commerce:on'));
 assert.equal(calls.some(x=>x.method==='gas'),false);
 assert.match(calls.find(x=>x.method==='sendMessage').payload.text,/TOÀN BỘ/);
 await c.billingCallback_(env,query('billing:commerce:on:confirm'));
 assert.equal(calls.some(x=>x.method==='gas'&&x.payload.text==='/commerce on'),false);
 assert.match(calls.filter(x=>x.method==='sendMessage').at(-1).payload.text,/XÁC NHẬN/);
});
test('data button uses checkdulieu while old check button retains check',async()=>{
 const {c,calls}=context();await c.billingCallback_(env,query('billing:usage'));
 assert.equal(calls.find(x=>x.method==='gas').payload.text,'/checkdulieu');
 calls.length=0;await c.billingCallback_(env,query('billing:check'));
 assert.equal(calls.find(x=>x.method==='gas').payload.text,'/check');
});
test('grant confirmation uses expiring actor/topic state and stable receipt; rejects foreign group and non-admin',async()=>{
 const {c,calls,stored}=context();await c.billingCallback_(env,query('billing:wizard:newplan:MST10:30:2:confirm'));
 assert.equal(calls.some(x=>x.method==='gas'&&x.payload.text.startsWith('/newplan')),false);
 const state=stored.get('/adminMenuSessions/1/20');
 await c.billingCallback_(env,query('billing:admin:confirm:'+state.token));
 const sent=calls.find(x=>x.method==='gas'&&x.payload.text.startsWith('/newplan')).payload;assert.equal(sent.text,'/newplan MST10 30 2');assert.match(sent.requestId,/MENU-/);assert.equal(sent.expectedKey,'KEY-A');
 await assert.rejects(c.billingCallback_(env,query('billing:admin:confirm:'+state.token)),/hết hạn/);
 calls.length=0;await assert.rejects(c.billingCallback_(env,{...query('billing:commerce:on:confirm'),message:{chat:{id:'other'}}}));assert.equal(calls.length,0);
 c.telegram=async()=>({status:'member'});await assert.rejects(c.billingCallback_(env,query('billing:commerce:on:confirm')));assert.equal(calls.length,0);
});
test('menu provides all categories; mutation requires review; confirmation is bound to room, actor and expiry',async()=>{
 const {c,calls,stored}=context();
 for(const page of ['root','key','device','support','system','unlinked'])for(const row of c.adminMenuMarkup_(page).inline_keyboard)for(const b of row)assert.ok(Buffer.byteLength(b.callback_data)<=64);
 await c.billingCallback_(env,query('billing:admin:prepare:lock'));
 let state=stored.get('/adminMenuSessions/1/20');assert.equal(state.command,'/lock');
 assert.equal(calls.some(x=>x.method==='gas'&&x.payload.text==='/lock'),false);
 await assert.rejects(c.billingCallback_(env,{...query('billing:admin:confirm:'+state.token),from:{id:2}}),/hết hạn/);
 stored.set('/telegramTopics/20',{chatRoomId:'OTHER'});
 await assert.rejects(c.billingCallback_(env,query('billing:admin:confirm:'+state.token)),/hết hạn/);
 stored.set('/telegramTopics/20',{chatRoomId:'ROOM_TEST'});state.expires=1;
 await assert.rejects(c.billingCallback_(env,query('billing:admin:confirm:'+state.token)),/hết hạn/);
});
test('force-reply input validates values and ignores unrelated support messages',async()=>{
 const {c,calls,stored}=context(),map={chatRoomId:'ROOM_TEST'};
 await c.billingCallback_(env,query('billing:admin:prompt:extend'));
 const state=stored.get('/adminMenuSessions/1/20'),message={from:{id:1},message_thread_id:20,text:'45',reply_to_message:{message_id:state.messageId}};
 assert.equal(await c.adminMenuMessage_(env,{...message,reply_to_message:{message_id:999}},map),false);
 await c.adminMenuMessage_(env,{...message,text:'-1'},map);
 assert.equal(stored.get('/adminMenuSessions/1/20').kind,'prompt');
 await c.adminMenuMessage_(env,message,map);
 const review=stored.get('/adminMenuSessions/1/20');assert.equal(review.command,'/extend 45');
 await c.billingCallback_(env,query('billing:admin:confirm:'+review.token));
 assert.ok(calls.some(x=>x.method==='gas'&&x.payload.text==='/extend 45'));
});
test('custom wizard values remain bounded and order buttons select only orders in current session',async()=>{
 const {c,calls,stored}=context();assert.equal(c.billingWizard_('billing:wizard:newplan:MST20:45:4:confirm').command,'/newplan MST20 45 4');
 await c.billingCallback_(env,query('billing:admin:custom:newplan:MST20'));
 const state=stored.get('/adminMenuSessions/1/20');
 await c.adminMenuMessage_(env,{from:{id:1},message_thread_id:20,text:'45',reply_to_message:{message_id:state.messageId}},{chatRoomId:'ROOM_TEST'});
 assert.match(calls.filter(x=>x.method==='sendMessage').at(-1).payload.text,/45 ngày/);
 c.gas=async(env,payload)=>({reply:'ORDER',keyName:'KEY-A',menuOrders:[{id:'ORDER-1',planId:'MST10',total:50000}]});
 await c.billingCallback_(env,query('billing:admin:orders'));
 const orders=stored.get('/adminMenuSessions/1/20');
 await c.billingCallback_(env,query('billing:admin:order:'+orders.token+':0:approve'));
 assert.equal(stored.get('/adminMenuSessions/1/20').command,'/approve ORDER-1 paid');
 await assert.rejects(c.billingCallback_(env,query('billing:admin:order:'+orders.token+':1:approve')));
});
test('unlinked topic can open menu and cancel; support handoff does not change license',async()=>{
 const {c,calls,stored}=context();
 await c.adminMenuMessage_(env,{from:{id:1},message_thread_id:20,text:'/menu'},null);
 assert.match(calls.filter(x=>x.method==='sendMessage').at(-1).payload.text,/Chưa gắn/);
 await c.billingCallback_(env,query('billing:admin:prepare:takeover'));
 const s=stored.get('/adminMenuSessions/1/20');await c.billingCallback_(env,query('billing:admin:confirm:'+s.token));
 assert.equal(calls.find(x=>x.method==='owner').args[2],'admin');
 assert.equal(calls.some(x=>x.method==='gas'&&x.payload.text==='/takeover'),false);
});
