const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{EventEmitter}=require('node:events');
async function fixture(){
  const {createSupportFlow}=await import('../cloudflare-worker/src/support-flow.js');
  const values=new Map(),revs=new Map(),sent=[];let serial=0;
  const deps={read:async(_,p)=>({value:values.get(p),etag:String(revs.get(p)||0)}),write:async(_,p,v,e)=>{if(e!==String(revs.get(p)||0))return false;values.set(p,structuredClone(v));revs.set(p,(revs.get(p)||0)+1);return true;},post:async(_,p,v,method)=>{const id='msg'+(++serial);values.set(method==='PUT'?p:p+'/'+id,structuredClone(v));return {name:id};},send:async(_,room,text)=>sent.push({room,text})};
  return {flow:createSupportFlow(deps),deps,values,sent};
}
test('one support room hands license questions to admin, persists ownership across restart and releases with stop',async()=>{
  const f=await fixture(),room='ROOM_WIN_OFFLINE123',env={};
  // Hỏi về bản quyền KHÔNG còn bị tự động đẩy sang admin: app hiện lựa chọn cho người dùng,
  // nên Gateway phải để AI trả lời cho tới khi người dùng chọn "đợi admin" (wantsAdmin).
  const offered=await f.flow.begin(env,room,'Tôi muốn kích hoạt bản quyền');
  assert.equal(offered.aiAllowed,true,'chưa chọn đợi admin thì AI vẫn trả lời');assert.equal(offered.control.mode,'auto');
  const first=await f.flow.begin(env,room,'Tôi muốn kích hoạt bản quyền',{wantsAdmin:true});
  assert.equal(first.aiAllowed,false);assert.match(first.reply,/Admin sẽ liên hệ/);assert.equal(first.control.mode,'waiting');assert.equal(f.sent.length,1);
  assert.equal([...f.values.values()].some(v=>v&&v.wantsAdmin),false,'cờ wantsAdmin không được lưu vào tin nhắn');
  await f.flow.owner(env,room,'admin','admin1');
  const {createSupportFlow}=await import('../cloudflare-worker/src/support-flow.js');const restarted=createSupportFlow(f.deps);
  assert.equal((await restarted.begin(env,room,'cảm ơn')).aiAllowed,false);
  await restarted.owner(env,room,'auto','admin1');
  assert.equal((await restarted.begin(env,room,'phân tích hóa đơn')).aiAllowed,true);
  // Sau /stop, khách nhắn lại phải gặp AI chứ không phải admin.
  const after=await restarted.begin(env,room,'xem hóa đơn tháng 9');
  assert.equal(after.aiAllowed,true);assert.equal(after.control.mode,'auto');assert.equal(after.reply,null);
});
test('admin priority wins a reply race; old AI completion is rejected after takeover AND after stop',async()=>{
  const f=await fixture(),r='room',turn=await f.flow.begin({},r,'đọc dữ liệu');
  await f.flow.owner({},r,'admin','owner');
  assert.equal((await f.flow.complete({},r,turn.id,turn.control.revision,'late')).accepted,false);
  await f.flow.owner({},r,'auto','owner');
  assert.equal((await f.flow.complete({},r,turn.id,turn.control.revision,'stale')).accepted,false);
  const newTurn=await f.flow.begin({},r,'tiếp tục');
  assert.equal((await f.flow.complete({},r,newTurn.id,newTurn.control.revision,'new')).accepted,true);
  assert.equal((await f.flow.complete({},r,newTurn.id,newTurn.control.revision,'new')).accepted,true);
  assert.equal([...f.values.keys()].filter(p=>p.endsWith('/ai_'+newTurn.id)).length,1);
});
test('AI chat and AI completion never send Telegram; only the selected human handoff and subsequent human turns send',async()=>{
  const f=await fixture(),turn=await f.flow.begin({},'r','Phân tích thuế doanh nghiệp');
  assert.equal(turn.aiAllowed,true);await f.flow.complete({},'r',turn.id,turn.control.revision,'Đã phân tích.');assert.equal(f.sent.length,0);
  const license=await f.flow.begin({},'r','Hỏi về license nhưng tiếp tục với AI');assert.equal(license.aiAllowed,true);assert.equal(f.sent.length,0);
  await f.flow.begin({},'r','Liên hệ admin',{wantsAdmin:true});assert.equal(f.sent.length,1);
  await f.flow.begin({},'r','Tôi đang chờ');assert.equal(f.sent.length,2);
  await f.flow.owner({},'r','auto','admin');await f.flow.begin({},'r','Phân tích tiếp');assert.equal(f.sent.length,2);
});
test('admin replying during Telegram delivery prevents AI starting; ordinary tax analysis stays AI',async()=>{
  const f=await fixture();f.deps.send=async()=>{};
  const {createSupportFlow,needsAdmin}=await import('../cloudflare-worker/src/support-flow.js');let flow;
  flow=createSupportFlow({...f.deps,send:async()=>flow.owner({},'r','admin','owner')});
  assert.equal((await flow.begin({},'r','phân tích thuế',{wantsAdmin:true})).aiAllowed,false);
  assert.equal(needsAdmin('phân tích thuế doanh nghiệp'),false);
  assert.equal(needsAdmin('gặp người thật để gia hạn license'),true);
});
function response(){const res=new EventEmitter();res.headersSent=false;res.output='';res.writeHead=()=>{res.headersSent=true;};res.write=s=>{res.output+=s;};res.end=s=>{res.output+=s||'';};return res;}
test('unified EXE ignores obsolete MANUAL model and calls gateway; human support works with expired license',async t=>{
  const {createAiService}=require('../src/ai-service');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'support-ai-'));
  fs.writeFileSync(path.join(dir,'ai-providers.json'),JSON.stringify({active:'agent',providers:[{id:'agent',label:'CNTaxTools',type:'openai',baseURL:'https://obsolete.test/v1',model:'gone-model',routingMode:'manual'}]}));
  let allowed=true,calls=0,expired=false;const supportFlow={beginUnified:async()=>({id:'turn1',aiAllowed:allowed,reply:'Admin sẽ liên hệ lại.',control:{mode:allowed?'auto':'waiting',revision:0}}),aiAllowed:async()=>{},completeUnified:async()=>({accepted:true})};
  const service=createAiService({dataDir:dir,secrets:{read:()=>({token:'private-old-key'})},app:{context:()=>({currentUser:{selectedMst:'0123456789'}})},checkLicense:async()=>({status:expired?'Expired':'Active'}),supportFlow,agentGateway:()=>({baseURL:'https://gateway.test/v1/ai/chat/completions',token:'session-fixture'}),fetchImpl:async(url,init)=>{calls++;assert.match(url,/gateway\.test/);assert.equal(init.headers.Authorization,'Bearer session-fixture');return Response.json({choices:[{message:{role:'assistant',content:'Đã phân tích.'}}]});}});t.after(()=>{service.close();fs.rmSync(dir,{recursive:true,force:true});});
  const run=async text=>{const req=new EventEmitter();req.method='POST';const res=response();await service.handle(req,res,new URL('http://localhost/api/ai/stream'),async()=>({id:'agent',unified:true,text,companyId:'0123456789'}),()=>{});return res.output;};
  assert.match(await run('phân tích'),/Đã phân tích/);assert.equal(calls,1);
  allowed=false;expired=true;assert.match(await run('xin key bản quyền'),/Admin sẽ liên hệ/);assert.equal(calls,1);
});
test('license unusable while AI is allowed hands off to admin with a real message and asks for admin explicitly',async t=>{
  const {createAiService}=require('../src/ai-service');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'support-ai-'));
  fs.writeFileSync(path.join(dir,'ai-providers.json'),JSON.stringify({active:'agent',providers:[{id:'agent',label:'CNTaxTools',type:'openai',baseURL:'https://gateway.test/v1',model:'m',routingMode:'auto'}]}));
  const notice='Đã chuyển yêu cầu tới admin. Admin sẽ liên hệ lại với bạn.';
  const seen=[];let calls=0;
  const supportFlow={beginUnified:async(text,companyId,names,wantsAdmin)=>{seen.push(wantsAdmin===true);return {id:'t1',aiAllowed:true,reply:wantsAdmin===true?notice:null,control:{mode:wantsAdmin===true?'waiting':'auto',revision:1}};},aiAllowed:async()=>{},completeUnified:async()=>({accepted:true})};
  const service=createAiService({dataDir:dir,secrets:{read:()=>({token:'k'})},app:{context:()=>({currentUser:{selectedMst:'0123456789'}})},checkLicense:async()=>{throw new Error('locked');},supportFlow,agentGateway:()=>({baseURL:'https://gateway.test/v1/ai/chat/completions',token:'s'}),fetchImpl:async()=>{calls++;return Response.json({choices:[{message:{role:'assistant',content:'x'}}]});}});
  t.after(()=>{service.close();fs.rmSync(dir,{recursive:true,force:true});});
  const req=new EventEmitter();req.method='POST';const res=response();
  await service.handle(req,res,new URL('http://localhost/api/ai/stream'),async()=>({id:'agent',unified:true,text:'xin key',companyId:'0123456789'}),()=>{});
  assert.equal(calls,0,'bản quyền hỏng thì không được gọi AI');
  assert.match(res.output,/Admin sẽ liên hệ/);
  assert.match(res.output,/"handoff":true/);
  assert.doesNotMatch(res.output,/"delta":null/,'không được trả thông báo rỗng');
  assert.equal(seen.at(-1),true,'nhánh bản quyền phải nêu wantsAdmin rõ ràng');
});
