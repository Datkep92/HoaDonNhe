const test=require('node:test');
const assert=require('node:assert/strict');
const {callAI}=require('../src/ai/openrouter-client');
let routing,admin;
test.before(async()=>{routing=await import('../cloudflare-worker/src/ai-routing.js');admin=await import('../cloudflare-worker/src/ai-admin.js');});
const env={TOKEN_SECRET:'offline-encryption-only',TELEGRAM_CHAT_ID:'-123',AI_ROUTER_V3_ENABLED:'1'};
test('basic chat keeps persisted route across ownership changes and isolate restart without optional probes',async()=>{
  const f=store(1);await f.manager.ensure(env);let calls=0;
  const p=chatProvider(b=>{calls++;assert.equal(b.stream,false);assert.equal(b.tools,undefined);assert.equal(b.messages.at(-1).content,'Actual question');return true;});
  const original=p.fetch;p.fetch=async(url,o)=>{assert.equal(o.method,'POST','no models/auth probe');return original(url,o);};
  await withProvider(p,async()=>{
    const body={messages:[{role:'user',content:'Actual question'}],stream:false};
    assert.equal((await f.manager.proxy(env,body,'shared-room')).status,200);assert.equal(calls,1);
    const before=await f.manager.config(env);assert.ok(before.sticky['shared-room']);assert.ok(before.urls[0].models[0].keys[0].route.resolved);
    const {createSupportFlow}=await import('../cloudflare-worker/src/support-flow.js');let control=null,rev=0;
    const flow=createSupportFlow({read:async()=>({value:control,etag:String(rev)}),write:async(_,path,v,etag)=>{if(etag!==String(rev))return false;control=v;rev++;return true;},post:async()=>{},send:async()=>{}});
    await flow.owner(env,'shared-room','admin','owner');await flow.owner(env,'shared-room','auto','owner');
    routing.resetResolvedEndpoints();f.restart();
    assert.equal((await f.manager.proxy(env,body,'shared-room')).status,200);assert.equal(calls,2);
    const after=await f.manager.config(env);assert.equal(after.activeRevision,before.activeRevision);assert.equal(Object.values(after.jobs||{}).filter(j=>j.kind==='routing').length,0);
  });
});
test('basic continuation probes only chat and persists proof',async()=>{
  const f=store(1);await f.manager.ensure(env);const p=chatProvider(b=>{assert.equal(b.stream,false);assert.equal(b.tools,undefined);return true;});
  const original=p.fetch;p.fetch=async(url,o)=>{assert.equal(o.method,'POST');return original(url,o);};
  await withProvider(p,async()=>{const id=await f.manager.enqueueRouting(env,{chat:true,stream:false,tools:false,vision:false,structured:false});await f.manager.runRouting(env,id);assert.equal((await f.manager.publicJob(env,id)).status,'ready');assert.equal(p.seen.length,1);});
});
function store(count=12) {
  let value=null,revision=0;const telegram=[],waits=[];
  const deps={legacy:async()=>({active:'m0',profiles:Array.from({length:count},(_,i)=>({alias:'m'+i,baseURL:'https://provider.test/v1',model:'model-'+i,keys:['offline-key-'+i]}))}),read:async()=>({value,etag:String(revision)}),write:async(_,v,etag)=>{if(etag!==String(revision))return false;value=v;revision++;return true;},telegram:async(_,method,body)=>{telegram.push({method,body});return method==='getChatMember'?{status:'administrator'}:{message_id:12};}};
  let manager=admin.createAiAdmin(deps);
  const ctx={waitUntil:p=>waits.push(p)};
  return {deps,telegram,waits,ctx,get manager(){return manager;},restart(){manager=admin.createAiAdmin(deps);},async change(fn){const r=await deps.read();const c=await admin.unseal(r.value,env.TOKEN_SECRET);fn(c);assert.ok(await deps.write(null,await admin.seal(c,env.TOKEN_SECRET),r.etag));},async drain(){while(waits.length)await waits.shift();}};
}
function chatProvider(accept=()=>true) {
  const seen=[];
  return {seen,fetch:async(url,o={})=>{
    if(url.includes('/internal/'))return new Response('',{status:503});
    if(o.method==='GET')return new Response('not found',{status:404});
    const b=JSON.parse(o.body);seen.push({url,body:b,headers:o.headers});
    const failure=accept(b,o,url);if(failure!==true)return failure;
    if(!url.endsWith('/chat/completions'))return new Response('endpoint missing',{status:404});
    const forced=b.tool_choice?.function;
    const message={role:'assistant',content:forced?null:'READY',...(forced?{tool_calls:[{id:'probe',type:'function',function:{name:'health_ping',arguments:'{}'}}]}:{})};
    return b.stream?new Response('data: '+JSON.stringify({choices:[{delta:message,finish_reason:forced?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}}):Response.json({choices:[{message}]});
  }};
}
async function withProvider(p,fn){const original=global.fetch;global.fetch=p.fetch;try{return await fn();}finally{global.fetch=original;}}
function sse(values){return new Response(values.map(v=>'data: '+JSON.stringify(v)+'\n\n').join(''),{headers:{'Content-Type':'text/event-stream'}});}
test('four wire formats auto resolve; native auth, image/tool history and streaming normalize for the EXE',async()=>{
  for(const protocol of ['chat','responses','anthropic','gemini']) {
    const seen=[],x={u:{url:'https://mixed.test'},m:{name:'vendor-model'},k:{secret:'offline-secret',route:{}}};
    const p={fetch:async(url,o)=>{
      const b=JSON.parse(o.body);seen.push({url,b,headers:o.headers});
      if(protocol==='anthropic'&&!o.headers['x-api-key']||protocol==='gemini'&&!o.headers['x-goog-api-key'])return new Response('missing expected authentication header',{status:401});
      const correct=protocol==='chat'?url.endsWith('/v1/chat/completions'):protocol==='responses'?url.endsWith('/v1/responses'):protocol==='anthropic'?url.endsWith('/v1/messages'):url.includes('/v1beta/models/vendor-model:');
      if(!correct)return new Response('endpoint missing',{status:404});
      if(protocol==='chat')return b.stream?sse([{choices:[{delta:{content:'OK'},finish_reason:'stop'}]}]):Response.json({choices:[{message:{content:'OK'}}]});
      if(protocol==='responses')return Response.json({output:[{type:'message',content:[{type:'output_text',text:'OK'}]}]});
      if(protocol==='anthropic'){
        assert.equal(o.headers['x-api-key'],x.k.secret);assert.equal(o.headers.Authorization,undefined);assert.equal(o.headers['anthropic-version'],'2023-06-01');
        return b.stream?sse([{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'OK'}},{type:'message_delta',delta:{stop_reason:'end_turn'}},{type:'message_stop'}]):Response.json({content:[{type:'text',text:'OK'}],stop_reason:'end_turn'});
      }
      assert.equal(o.headers['x-goog-api-key'],x.k.secret);assert.ok(!url.includes(x.k.secret));
      const result={candidates:[{content:{parts:[{text:'OK'}]},finishReason:'STOP'}]};return url.includes('streamGenerateContent')?sse([result]):Response.json(result);
    }};
    await withProvider(p,async()=>{
      const result=await routing.resolveCall(x,{messages:[{role:'user',content:'test'}]},admin.endpoint);assert.equal(result.resolved.protocol,protocol);assert.equal(result.data.choices[0].message.content,'OK');
      x.k.route.resolved=result.resolved;const streamed=await routing.resolveCall(x,{messages:[{role:'user',content:'test'}],stream:true},admin.endpoint);assert.ok(streamed.response,protocol+' '+JSON.stringify(streamed.error));assert.match(await streamed.response.text(),/OK/);
      assert.match(await (await routing.resolveCall(x,{messages:[{role:'user',content:'test'}],stream:true},admin.endpoint)).response.text(),protocol==='chat'?/finish_reason.*stop/:/\[DONE\]/);
      const history=[{role:'system',content:'Keep scope'},{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,AAAA'}}]},{role:'assistant',content:null,tool_calls:[{id:'call-1',function:{name:'read',arguments:'{}'}}]},{role:'tool',tool_call_id:'call-1',content:'prior result'}];
      if(['anthropic','gemini'].includes(protocol)){const n=await import('../cloudflare-worker/src/ai-native.js');const adapted=n.nativeBody({messages:history,model:x.m.name},protocol);assert.match(JSON.stringify(adapted),/prior result/);assert.match(JSON.stringify(adapted),/AAAA/);assert.match(JSON.stringify(adapted),/read/);}
    });
  }
});
test('native tool SSE deltas retain arguments and Gemini signatures through a real client parser',async()=>{
  const n=await import('../cloudflare-worker/src/ai-native.js');
  for(const protocol of ['anthropic','gemini']) {
    const native=protocol==='anthropic'?sse([{type:'content_block_start',index:0,content_block:{type:'tool_use',id:'c',name:'read',input:{}}},{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:'{"x":1}'}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'tool_use'}},{type:'message_stop'}]):sse([{candidates:[{content:{parts:[{functionCall:{name:'read',args:{x:1}},thoughtSignature:'signature-1'}]},finishReason:'STOP'}]}]);
    const response=n.nativeStream(native,protocol);
    const parsed=await callAI({config:{apiKey:'offline',endpoint:'https://gateway.test'},messages:[],tools:[],fetchImpl:async()=>response});
    assert.equal(parsed.calls[0].function.name,'read');assert.equal(parsed.calls[0].function.arguments,'{"x":1}');
    if(protocol==='gemini')assert.equal(parsed.message.providerParts[0].thoughtSignature,'signature-1');
  }
});
test('verified URL endpoint is reused across models; warm mapping does one provider call instead of repeating discovery',async()=>{
  routing.resetResolvedEndpoints();const p=chatProvider(),x={u:{url:'https://warm.test'},m:{name:'model-first'},k:{secret:'offline-key',route:{}}};
  await withProvider(p,async()=>{
    // Only /v1/chat/completions is implemented at this provider.
    const original=p.fetch;p.fetch=async(url,o)=>url.endsWith('/v1/chat/completions')?original(url,o):new Response('endpoint missing',{status:404});
    // withProvider holds the original function, so install the specialized fixture explicitly.
    global.fetch=p.fetch;
    const first=await routing.resolveCall(x,{messages:[{role:'user',content:'test'}]},admin.endpoint);assert.ok(first.response);
    let requests=0;const wrapped=p.fetch;global.fetch=async(...args)=>{requests++;return wrapped(...args);};
    const second=await routing.resolveCall({...x,m:{name:'model-second'}},{messages:[{role:'user',content:'test'}]},admin.endpoint);
    assert.ok(second.response);assert.equal(requests,1);assert.equal(second.resolved.model,'model-second');
  });routing.resetResolvedEndpoints();
});
test('durable continuation visits >8 configs / >3 discoveries, survives restart; EXE waits and retries automatically',async()=>{
  const f=store(14);await f.manager.ensure(env);let ticks=0;
  const p=chatProvider(b=>b.model==='model-13'?true:new Response('model quota exceeded',{status:402}));
  await withProvider(p,async()=>{
    const history=[{role:'user',content:'Earlier question'},{role:'assistant',content:'Earlier answer'},{role:'user',content:'Continue'}];
    const fetchImpl=async(url,o)=>o.method==='GET'?Response.json({ok:true,value:await f.manager.publicJob(env,url.split('/').at(-1))}):f.manager.proxy(env,JSON.parse(o.body),'conversation');
    const result=await callAI({config:{apiKey:'session-only',endpoint:'https://gateway.test/v1/ai/chat/completions',viaGateway:true},messages:history,tools:[],fetchImpl,waitImpl:async()=>{ticks++;assert.ok(ticks<30);f.restart();await f.manager.scheduled(env,f.ctx,'');}});
    assert.equal(result.final,'READY');assert.ok(ticks>3);assert.deepEqual(p.seen.at(-1).body.messages.slice(0,history.length),history);
    assert.ok(p.seen.at(-1).body.messages.slice(history.length).every(m=>m.role==='system'&&m.content.startsWith('Dùng JSON protocol.')));
    const c=await f.manager.config(env);assert.equal((await f.manager.publicActive(env)).active.model,'model-13');assert.equal(c.activeRevision,1);assert.equal(c.urls[0].models.length,14);
    assert.ok(Object.values(c.jobs).some(j=>j.kind==='routing'&&j.cursor>=13));
    assert.ok(!JSON.stringify(await f.manager.publicActive(env)).includes('offline-key'));
  });
});
test('scoped quota does not kill a shared key at another model; key -> model -> URL failover works',async()=>{
  const f=store(3);await f.manager.ensure(env);
  await f.change(c=>{c.urls[0].models[1].keys[0].secret=c.urls[0].models[0].keys[0].secret;const last=c.urls[0].models.pop();c.urls.push({id:'other-url',url:'https://other.test/v1',name:'other',enabled:true,models:[last]});});
  let allFirst=false;const p=chatProvider((b,o,url)=>b.model==='model-0'||allFirst&&url.includes('provider.test')?new Response('per-model quota exceeded',{status:402}):true);
  await withProvider(p,async()=>{
    assert.equal((await f.manager.proxy(env,{messages:[],stream:true},'one')).status,200);assert.equal((await f.manager.publicActive(env)).active.model,'model-1');
    allFirst=true;assert.equal((await f.manager.proxy(env,{messages:[],stream:true},'one')).status,200);assert.equal((await f.manager.publicActive(env)).active.model,'model-2');
  });
});
test('all quota exhausted is truthful; cron recovers without input after retry time, no periodic checks of healthy configs',async()=>{
  const f=store(2);await f.manager.ensure(env);let good=false;let now=Date.now();const originalNow=Date.now;Date.now=()=>now;
  const p=chatProvider(()=>good?true:new Response('quota exhausted',{status:402,headers:{'Retry-After':'60'}}));
  try{await withProvider(p,async()=>{
    const r=await f.manager.proxy(env,{messages:[],stream:true},'one');const pending=await r.json();assert.ok(pending.jobId);
    for(let i=0;i<3;i++)await f.manager.runRouting(env,pending.jobId);
    assert.equal((await f.manager.publicJob(env,pending.jobId)).status,'exhausted');
    good=true;now+=61000;f.restart();for(let i=0;i<4;i++)await f.manager.scheduled(env,f.ctx,'');
    assert.equal((await f.manager.proxy(env,{messages:[],stream:true},'one')).status,200);
    const calls=p.seen.length;await f.manager.scheduled(env,f.ctx,'');assert.equal(p.seen.length,calls);
  });}finally{Date.now=originalNow;}
});
test('100 clients in independent isolates do not duplicate discovery or global revision',async()=>{
  const f=store(1);await f.manager.ensure(env);const p=chatProvider();let entered,release;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);let first=true;
  const original=p.fetch;p.fetch=async(url,o)=>{if(o.method==='POST'&&first){first=false;entered();await gate;}return original(url,o);};
  await withProvider(p,async()=>{
    const primary=f.manager.proxy(env,{messages:[],stream:true},'first');await started;
    const responses=await Promise.all(Array.from({length:100},(_,i)=>admin.createAiAdmin(f.deps).proxy(env,{messages:[],stream:true},'c'+i)));
    assert.ok(responses.every(r=>r.status===503));assert.equal(p.seen.length,0);
    release();assert.equal((await primary).status,200);assert.equal((await f.manager.publicActive(env)).revision,1);
    assert.equal(Object.values((await f.manager.config(env)).jobs).filter(j=>j.kind==='routing').length,1);
  });
});
test('Telegram 3-line input automatically tests and publishes; masked panel and status survive restart',async()=>{
  const f=store(0);await f.manager.ensure(env);const p=chatProvider();
  const message={chat:{id:'-123'},message_thread_id:7};
  await withProvider(p,async()=>{
    await f.manager.handle(env,{callback_query:{id:'cb',data:'a2:configure',from:{id:1},message}},f.ctx,'https://gateway.test');
    const c=await f.manager.config(env);
    await f.manager.handle(env,{message:{...message,message_id:18,from:{id:1},text:'https://provider.test/v1\nmodel-0\noffline-key-0',reply_to_message:{message_id:c.prompts[1].message}}},f.ctx,'https://gateway.test');
    await f.drain();f.restart();assert.equal((await f.manager.publicActive(env)).active.model,'model-0');
    assert.ok(f.telegram.some(t=>t.method==='deleteMessage'&&t.body.message_id===18));
    assert.ok(!f.telegram.filter(t=>['sendMessage','editMessageText'].includes(t.method)).some(t=>t.body.text.includes('offline-key-0')));
  });
});
test('empty/invalid SSE, wrong protocol, missing tool capability never become ready; cancellation and partial stream do not retry',async()=>{
  const f=store(1);await f.manager.ensure(env);const c=await f.manager.config(env);const x={u:c.urls[0],m:c.urls[0].models[0],k:c.urls[0].models[0].keys[0]};
  await withProvider({fetch:async()=>Response.json({choices:[{message:{content:''}}]})},async()=>{const checked=await routing.deepCheck(x,admin.endpoint);assert.notEqual(checked.status,'ok');});
  await withProvider({fetch:async()=>sse([{error:{code:500,message:'failed'}}])},async()=>{assert.ok((await routing.providerCall(x,{stream:true},{protocol:'chat',endpoint:'https://provider.test/v1/chat/completions'})).error);});
  let sent=0;await assert.rejects(callAI({config:{apiKey:'offline',endpoint:'https://gateway.test',viaGateway:true},messages:[],tools:[],fetchImpl:async()=>{sent++;return sse([{choices:[{delta:{content:'partial'}}]}]);}}),/ngắt/);assert.equal(sent,1);
  const controller=new AbortController();const pending=callAI({config:{apiKey:'offline',endpoint:'https://gateway.test/v1/ai/chat/completions',viaGateway:true},messages:[],tools:[],signal:controller.signal,fetchImpl:async()=>Response.json({error:{code:'AI_ROUTING_PENDING'}},{status:503})});controller.abort();await assert.rejects(pending,/abort/i);
});
test('expired lease resumes at the same cursor after isolate restart; temporary network failure remains recoverable',async()=>{
  const f=store(1);await f.manager.ensure(env);let now=Date.now();const originalNow=Date.now;Date.now=()=>now;
  const jobId=await f.manager.enqueueRouting(env,{chat:true,stream:true});
  await f.change(c=>{c.jobs[jobId].leaseUntil=now+35000;c.jobs[jobId].lease='dead-isolate';});
  let offline=true;const p=chatProvider();const original=p.fetch;p.fetch=async(...args)=>{if(offline)throw new TypeError('offline');return original(...args);};
  try{await withProvider(p,async()=>{
    f.restart();await f.manager.runRouting(env,jobId);assert.equal((await f.manager.publicJob(env,jobId)).processed,0);
    now+=36000;await f.manager.runRouting(env,jobId);assert.equal((await f.manager.publicJob(env,jobId)).status,'waiting');
    offline=false;now+=31000;await f.manager.scheduled(env,f.ctx);assert.equal((await f.manager.publicJob(env,jobId)).status,'ready');
  });}finally{Date.now=originalNow;}
});
test('missing native tools stays explicitly false while basic chat remains usable; unknown protocol/model never disable keys',async()=>{
  const f=store(1);await f.manager.ensure(env);
  const p=chatProvider();const original=p.fetch;p.fetch=async(url,o)=>{const b=o.body&&JSON.parse(o.body);if(b?.tool_choice?.function)return Response.json({choices:[{message:{content:'cannot call tools'}}]});return original(url,o);};
  await withProvider(p,async()=>{
    const r=await f.manager.proxy(env,{messages:[],tools:[{type:'function',function:{name:'read',parameters:{type:'object'}}}],stream:true});assert.equal(r.status,200);await r.text();
    const key=(await f.manager.config(env)).urls[0].models[0].keys[0];assert.equal(key.route.capabilities.tools,false);assert.equal(key.enabled,true);
    assert.equal((await f.manager.publicActive(env)).active.capabilities.tools,false);
  });
  const c=await f.manager.config(env),x={u:c.urls[0],m:c.urls[0].models[0],k:{...c.urls[0].models[0].keys[0],route:{}}};
  await withProvider({fetch:async()=>new Response('unknown route',{status:404})},async()=>assert.equal((await routing.deepCheck(x,admin.endpoint)).errorClass,'PROTOCOL_UNSUPPORTED'));
  await withProvider({fetch:async()=>new Response('model not found',{status:404})},async()=>assert.equal((await routing.deepCheck(x,admin.endpoint)).errorClass,'MODEL_NOT_FOUND'));
});
test('job API rejects unauthenticated clients; recovery scheduler is exposed without changing chat contract',async()=>{
  const worker=(await import('../cloudflare-worker/src/index.js')).default;
  const response=await worker.fetch(new Request('https://gateway.test/v1/ai/jobs/0123456789abcdef'),env,{waitUntil(){}});
  assert.equal(response.status,400);assert.equal((await response.json()).ok,false);assert.equal(typeof worker.scheduled,'function');
});
test('all expired credentials exhaust accurately; adding one valid key on Telegram restores AUTO without mapping',async()=>{
  const f=store(2);await f.manager.ensure(env);const p=chatProvider((b,o)=>o.headers.Authorization==='Bearer offline-new-valid'?true:new Response('expired key',{status:401}));
  await withProvider(p,async()=>{
    const result=await f.manager.proxy(env,{messages:[],stream:true});const pending=await result.json();for(let i=0;i<3;i++)await f.manager.runRouting(env,pending.jobId);
    assert.equal((await f.manager.publicJob(env,pending.jobId)).status,'exhausted');assert.equal((await f.manager.publicJob(env,pending.jobId)).errors.EXPIRED_KEY,2);
    const message={chat:{id:'-123'},message_thread_id:7};await f.manager.handle(env,{callback_query:{id:'cb',data:'a2:configure',from:{id:1},message}},f.ctx,'https://gateway.test');
    const c=await f.manager.config(env);await f.manager.handle(env,{message:{...message,message_id:19,from:{id:1},text:'https://provider.test/v1\nmodel-0\noffline-new-valid',reply_to_message:{message_id:c.prompts[1].message}}},f.ctx,'https://gateway.test');
    await f.drain();assert.equal((await f.manager.proxy(env,{messages:[],stream:true})).status,200);
    assert.equal((await f.manager.config(env)).urls[0].models[0].keys.length,2);
  });
});
test('obsolete ready job never masks a pending failover job or creates 100 duplicate jobs',async()=>{
  const f=store(1);await f.manager.ensure(env);const required={chat:true,stream:true};
  const old=await f.manager.enqueueRouting(env,required);
  await f.change(c=>{c.jobs[old].status='ready';c.jobs[old].readyId='old.failed.configuration';});
  const ids=await Promise.all(Array.from({length:100},()=>admin.createAiAdmin(f.deps).enqueueRouting(env,required)));
  assert.equal(new Set(ids).size,1);assert.notEqual(ids[0],old);assert.equal(Object.values((await f.manager.config(env)).jobs).length,2);
});
test('late stream failure preserves partial response, records health and changes next request after confirmation; user cancellation is not provider failure',async()=>{
  const f=store(2);await f.manager.ensure(env);let broken=false;const p=chatProvider();const original=p.fetch;
  p.fetch=async(url,o)=>{const b=o.body&&JSON.parse(o.body);if(b?.model==='model-0'&&b.stream&&broken)return sse([{choices:[{delta:{content:'partial'}}]}]);return original(url,o);};
  await withProvider(p,async()=>{
    await (await f.manager.proxy(env,{messages:[],stream:true},'one')).text();broken=true;
    for(let i=0;i<2;i++){const response=await f.manager.proxy(env,{messages:[],stream:true},'one');const reader=response.body.getReader();assert.match(new TextDecoder().decode((await reader.read()).value),/partial/);await assert.rejects(reader.read(),/interrupted/);}
    assert.equal((await f.manager.config(env)).urls[0].models[0].keys[0].route.circuit,'OPEN');
    await (await f.manager.proxy(env,{messages:[],stream:true},'one')).text();assert.equal((await f.manager.publicActive(env)).active.model,'model-1');
    const before=(await f.manager.config(env)).urls[0].models[1].keys[0].route.failures;
    const response=await f.manager.proxy(env,{messages:[],stream:true},'one');await response.body.cancel();assert.equal((await f.manager.config(env)).urls[0].models[1].keys[0].route.failures,before);
  });
});
