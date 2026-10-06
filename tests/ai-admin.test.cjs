const test = require('node:test');
const assert = require('node:assert/strict');
let createAiAdmin, seal, unseal, migrate, candidates, endpoint;
let routing;
test.before(async()=>{routing=await import('../cloudflare-worker/src/ai-routing.js')});
test.before(async () => ({ createAiAdmin, seal, unseal, migrate, candidates, endpoint } = await import('../cloudflare-worker/src/ai-admin.js')));
const env = { TOKEN_SECRET: 'encryption-secret', TELEGRAM_CHAT_ID: '-100123' };
test('Workers-compatible requests check keys and chat without forwarding keys on redirects', async () => {
  const f = fixture(); const c = await f.manager.ensure(env);
  const item = { u:c.urls[0], m:c.urls[0].models[0], k:c.urls[0].models[0].keys[0] };
  const original = global.fetch; let redirect = false; const seen = [];
  global.fetch = async (url, options) => {
    // Match the deployed edge runtime: redirect:error throws before any network I/O.
    if (!['manual','follow'].includes(options.redirect)) throw new TypeError('Invalid redirect value');
    assert.equal(options.redirect, 'manual'); seen.push(url);
    if (redirect) return new Response('', {status:302, headers:{Location:'https://foreign.test/steal'}});
    return Response.json({choices:[{message:{content:'ok'}}]});
  };
  try {
    assert.equal((await f.manager.inspect(env,item,true)).status, 'ok');
    assert.equal((await f.manager.proxy(env,{messages:[]})).status, 200);
    redirect = true;
    const checked = await f.manager.inspect(env,item);
    assert.equal(checked.status,'error'); assert.equal(checked.label,'HTTP 302');
    assert.notEqual((await f.manager.proxy(env,{messages:[]})).status,200);
    assert.ok(seen.every(url=>!url.startsWith('https://foreign.test')));
  } finally {global.fetch=original;}
});
const legacy = { active: 'm1', profiles: [{ alias: 'm1', baseURL: 'https://one.test/v1', model: 'm1', keys: ['key-one-111', 'key-two-222'] }, { alias: 'm2', baseURL: 'https://one.test/v1', model: 'm2', keys: ['key-three-333'] }, { alias: 'm3', baseURL: 'https://two.test/v1', model: 'm3', keys: ['key-four-444'] }] };
function fixture() {
  let value = null, rev = 0, nextMessage = 0;
  const telegram = [], waits = [];
  const panels = new Map();
  let admin = true, conflicts = 0;
  const deps = {
    panel: async (_, thread, next) => { if(next)panels.set(thread,next);return panels.get(thread); },
    legacy: async () => legacy,
    read: async () => ({ value: value && JSON.parse(JSON.stringify(value)), etag: String(rev) }),
    write: async (_, next, etag) => { if (conflicts > 0) { conflicts--; rev++; return false; } if (etag !== String(rev)) return false; value = next; rev++; return true; },
    telegram: async (_, method, body) => { telegram.push({ method, body }); if (method === 'getChatMember') return { status: admin ? 'administrator' : 'member' }; return { message_id: method === 'editMessageText' ? body.message_id : ++nextMessage }; },
  };
  let manager = createAiAdmin(deps);
  const ctx = { waitUntil: promise => waits.push(promise) };
  const tap = (data, user = 1, chatId = '-100123') => manager.handle(env, { callback_query: { id: 'cb', data: 'a2:' + data, from: { id: user }, message: { chat: { id: chatId }, message_thread_id: 7 } } }, ctx, 'https://gateway.test');
  const say = async (text, user = 1, reply = true) => { const c = await manager.config(env); return manager.handle(env, { message: { message_id: ++nextMessage, text, chat: { id: '-100123' }, from: { id: user }, message_thread_id: 7, ...(reply ? { reply_to_message: { message_id: c?.prompts?.[user]?.message } } : {}) } }, ctx, 'https://gateway.test'); };
  return { deps, telegram, waits, tap, say, get manager() { return manager; }, restart() { manager = createAiAdmin(deps); }, raw: () => value, setAdmin: b => { admin = b; }, conflict: n => { conflicts = n; } };
}
test('migration groups legacy URL/model/keys, encrypted at rest, CAS conflict preserves data', async () => {
  const f = fixture(); f.conflict(2);
  const c = await f.manager.ensure(env);
  assert.equal(c.urls.length, 2); assert.equal(c.urls[0].models.length, 2);
  assert.equal(c.urls[0].models[0].keys.length, 2);
  assert.equal(JSON.stringify(f.raw()).includes('key-one-111'), false);
  await assert.rejects(unseal(f.raw(), 'wrong-secret'));
  f.restart(); assert.deepEqual((await f.manager.config(env)).urls, c.urls);
  const large={history:'Vietnamese kế toán '.repeat(20000)};
  assert.deepEqual(await unseal(await seal(large,env.TOKEN_SECRET),env.TOKEN_SECRET),large);
});
test('classification, transient confirmation, normalization and Responses adapter preserve context/tools',async()=>{
  for(const [status,text,expected] of [[401,'','INVALID_KEY'],[403,'','AUTH_ERROR'],[401,'expired key','EXPIRED_KEY'],[402,'','QUOTA_EXCEEDED'],[429,'','RATE_LIMIT'],[404,'model not found','MODEL_NOT_FOUND'],[404,'No endpoints found for stealth/space-bunny-alpha','MODEL_NOT_FOUND'],[404,'','ENDPOINT_NOT_FOUND'],[415,'','PROTOCOL_MISMATCH'],[503,'','PROVIDER_ERROR']])assert.equal(routing.classify(status,text).errorClass,expected);
  const failure=routing.classify(0,'',{name:'TimeoutError'});
  const once=routing.healthResult({},failure);assert.equal(once.circuit,'SUSPECT');assert.equal(once.retryAt,0);
  const twice=routing.healthResult(once,failure);assert.equal(twice.circuit,'OPEN');assert.ok(twice.retryAt>Date.now());
  const healed=routing.healthResult(twice,{status:'ok'});assert.equal(healed.failureCount,0);assert.equal(healed.circuit,'CLOSED');
  assert.equal(endpoint({url:'https://one.test/v1',endpoints:{chat:'/v1/chat/completions'}},'chat'),'https://one.test/v1/chat/completions');
  const adapted=routing.responsesBody({model:'m',messages:[{role:'user',content:'Keep context'},{role:'assistant',content:null,tool_calls:[{id:'c',function:{name:'read',arguments:'{}'}}]},{role:'tool',tool_call_id:'c',content:'result'}],tools:[{type:'function',function:{name:'read',parameters:{type:'object'}}}]});
  assert.equal(adapted.input[0].content,'Keep context');assert.equal(adapted.input[2].call_id,'c');
  assert.equal(routing.responsesChat({output:[{type:'function_call',call_id:'c',name:'read',arguments:'{}'}]}).choices[0].message.tool_calls[0].id,'c');
});
function providerFixture(options={}) {
  const seen=[];
  const fetch=async(url,o)=>{
    assert.equal(o.redirect,'manual');
    if(url.endsWith('/models'))return Response.json({data:[{id:'m1'},{id:'m2'},{id:'m3'}]});
    const body=JSON.parse(o.body);seen.push({url,body,key:o.headers.Authorization});
    const error=options.error?.(url,body,o);if(error)return error;
    if(body.stream)return new Response('data: '+JSON.stringify({choices:[{delta:{content:'OK'}}]})+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
    return Response.json({model:body.model,choices:[{message:{role:'assistant',content:'OK',...(body.tool_choice?.function?{tool_calls:[{id:'probe',function:{name:'health_ping',arguments:'{}'}}]}:{})}}]});
  };return {fetch,seen};
}
test('deep check retries one network failure, checks model/chat/stream/tools and discovers correct endpoint',async()=>{
  const f=fixture(),c=await f.manager.ensure(env),x={u:c.urls[0],m:c.urls[0].models[0],k:c.urls[0].models[0].keys[0]};
  let transient=true;const p=providerFixture({error:(url)=>{if(transient){transient=false;throw Object.assign(Error('offline'),{name:'TypeError'});}if(!url.includes('/v1/'))return new Response('not found',{status:404});}}),original=global.fetch;
  x.u.url='https://one.test';global.fetch=p.fetch;
  try{const checked=await routing.deepCheck(x,endpoint);assert.equal(checked.status,'ok');assert.equal(checked.resolved.endpoint,'https://one.test/v1/chat/completions');assert.deepEqual(checked.capabilities,{chat:true,nativeStream:true,stream:true,tools:true});assert.ok(checked.steps.some(s=>s.errorClass==='NETWORK_ERROR'));}finally{global.fetch=original;}
});
test('router publishes verified config, failover revision, sticky context, cooldown and last known good rollback',async()=>{
  const f=fixture();await f.manager.ensure(env);const e={...env,AI_ROUTER_V3_ENABLED:'1'},original=global.fetch;
  let quota=false;const p=providerFixture({error:(_,body,o)=>quota&&o.headers.Authorization==='Bearer key-one-111'?new Response('quota',{status:402}):null});global.fetch=p.fetch;
  try{
    const body={messages:[{role:'user',content:'Previous context'},{role:'assistant',content:'Answer'},{role:'user',content:'Continue'}],stream:false};
    const first=await f.manager.proxy(e,body,'session');assert.equal(first.status,200);assert.equal(first.headers.get('X-AI-Revision'),'1');
    const initial=await f.manager.publicActive(e);assert.ok(initial.active);assert.equal(JSON.stringify(initial).includes('key-one-111'),false);
    quota=true;const next=await f.manager.proxy(e,body,'session');assert.equal(next.status,200);assert.equal(next.headers.get('X-AI-Revision'),'2');
    let c=await f.manager.config(env);assert.equal(c.lastKnownGood.id,initial.active.id);assert.equal(c.failoverHistory.at(-1).errorClass,'QUOTA_EXCEEDED');
    assert.deepEqual(p.seen.at(-1).body.messages,body.messages);
    assert.equal(c.urls[0].models[0].keys[0].route.circuit,'OPEN');
    // Recover the former config after cooldown, then fail the new one: verified rollback.
    const r=await f.deps.read(env);c.urls[0].models[0].keys[0].health.retryAt=0;c.urls[0].models[0].keys[0].route.retryAt=0;await f.deps.write(env,await seal(c,env.TOKEN_SECRET),r.etag);
    quota=false;global.fetch=providerFixture({error:(_,body,o)=>o.headers.Authorization==='Bearer key-two-222'?new Response('quota',{status:402}):null}).fetch;
    assert.equal((await f.manager.proxy(e,body,'session')).status,200);
    c=await f.manager.config(env);assert.equal(c.currentConfig.id,initial.active.id);assert.equal(c.activeRevision,3);
  }finally{global.fetch=original;}
});
test('bulk models dedupe and secret copy goes only to authenticated admin private chat',async()=>{
  const f=fixture(),c=await f.manager.ensure(env),u=c.urls[0],k=u.models[0].keys[0];
  await f.tap('bulk:'+u.id);await f.say('m2\nm4\nm4\nm5');
  const next=await f.manager.config(env);assert.equal(next.urls[0].models.length,4);assert.ok(next.urls[0].models.find(m=>m.name==='m4').keys.length);
  // Drain the job under a mock provider to keep the test offline.
  const original=global.fetch;global.fetch=providerFixture().fetch;try{await Promise.all(f.waits)}finally{global.fetch=original;}
  await f.tap('copyconfig:'+k.id);const copied=f.telegram.filter(x=>x.method==='sendMessage'&&String(x.body.chat_id)==='1');assert.equal(copied.length,1);assert.ok(copied[0].body.text.includes(k.secret));
  assert.equal(f.telegram.some(x=>x.method==='sendMessage'&&String(x.body.chat_id)===env.TELEGRAM_CHAT_ID&&x.body.text.includes(k.secret)),false);
  f.setAdmin(false);await f.tap('copykey:'+k.id,2);assert.equal(f.telegram.some(x=>x.body.chat_id===2),false);
});
test('invalid key/model never publish; model errors leave credentials intact and an alternative works',async()=>{
  const f=fixture(),e={...env,AI_ROUTER_V3_ENABLED:'1'};await f.manager.ensure(env);const original=global.fetch;
  global.fetch=providerFixture({error:(_,body,o)=>o.headers.Authorization==='Bearer key-one-111'?new Response('invalid_api_key',{status:401}):body.model==='m1'?new Response('No endpoints found for m1',{status:404}):null}).fetch;
  try{assert.equal((await f.manager.proxy(e,{messages:[{role:'user',content:'Hi'}]})).status,200);const c=await f.manager.config(env);assert.equal(c.urls[0].models[0].keys[0].route.lastError,'INVALID_KEY');assert.equal(c.urls[0].models[0].keys[1].route.lastError,'MODEL_NOT_FOUND');assert.equal(c.urls[0].models[0].keys[1].enabled,true);assert.equal((await f.manager.publicActive(e)).active.model,'m2');assert.equal(c.activeRevision,1);}finally{global.fetch=original;}
});
test('persistent discovery lease prevents a second isolate from repeating tests or publishing a revision',async()=>{
  const f=fixture(),e={...env,AI_ROUTER_V3_ENABLED:'1'},c=await f.manager.ensure(env),r=await f.deps.read(env);c.urls=c.urls.slice(0,1);c.urls[0].models=c.urls[0].models.slice(0,1);c.urls[0].models[0].keys=c.urls[0].models[0].keys.slice(0,1);
  c.urls[0].models[0].keys[0].route={fingerprint:endpoint(c.urls[0],'chat')+'|m1',status:'error',circuit:'OPEN',retryAt:0,capabilities:{chat:false}};
  await f.deps.write(env,await seal(c,env.TOKEN_SECRET),r.etag);
  let enter,release;const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r),p=providerFixture(),original=global.fetch;let blocked=false;
  global.fetch=async(url,o)=>{if(o.method==='POST'&&!blocked){blocked=true;enter();await gate;}return p.fetch(url,o)};
  try{const first=f.manager.proxy(e,{messages:[]},'one');await entered;const second=createAiAdmin(f.deps);const busy=await second.proxy(e,{messages:[]},'two');assert.equal((await busy.json()).error.code,'HEALTH_CHECK_IN_PROGRESS');release();assert.equal((await first).status,200);assert.equal((await second.proxy(e,{messages:[]},'two')).status,200);assert.equal((await f.manager.publicActive(e)).revision,1);}finally{release();global.fetch=original;}
});
test('healthy sticky conversations on different models do not oscillate the global active revision',async()=>{
  const f=fixture(),e={...env,AI_ROUTER_V3_ENABLED:'1'};await f.manager.ensure(env);const original=global.fetch;global.fetch=providerFixture().fetch;
  try{
    assert.equal((await f.manager.proxy(e,{messages:[]},'one')).status,200);
    let c=await f.manager.config(env);const x={u:c.urls[0],m:c.urls[0].models[1],k:c.urls[0].models[1].keys[0]};
    await f.manager.recordRoute(env,x,await routing.deepCheck(x,endpoint),false);
    c=await f.manager.config(env);const r=await f.deps.read(env);c.sticky.two={id:routing.configurationId(x),at:Date.now()};await f.deps.write(env,await seal(c,env.TOKEN_SECRET),r.etag);
    assert.equal((await f.manager.proxy(e,{messages:[]},'two')).headers.get('X-AI-Model'),'m2');
    assert.equal((await f.manager.proxy(e,{messages:[]},'one')).headers.get('X-AI-Model'),'m1');
    assert.equal((await f.manager.publicActive(e)).revision,1);
  }finally{global.fetch=original;}
});
test('Responses-only provider resolves and adapts tool output to the existing EXE SSE contract',async()=>{
  const f=fixture(),c=await f.manager.ensure(env),x={u:c.urls[0],m:c.urls[0].models[0],k:c.urls[0].models[0].keys[0]},original=global.fetch;let actual;
  global.fetch=async(url,o)=>{assert.equal(o.redirect,'manual');if(!url.endsWith('/responses'))return new Response('unknown route',{status:404});actual=JSON.parse(o.body);return Response.json({id:'response',model:'m1',output:[{type:'message',content:[{type:'output_text',text:'OK'}]},{type:'function_call',call_id:'call',name:'read',arguments:'{}'}]});};
  try{const result=await routing.resolveCall(x,{stream:true,messages:[{role:'user',content:'Context'},{role:'tool',tool_call_id:'old',content:'Prior result'}]},endpoint);assert.equal(result.resolved.protocol,'responses');const sse=await result.response.text();assert.match(sse,/"tool_calls"/);assert.match(sse,/\[DONE\]/);assert.equal(actual.input[1].output,'Prior result');}finally{global.fetch=original;}
});
test('Telegram question starts typing before model I/O and stops after returning an answer',async()=>{
  const f=fixture();await f.manager.ensure(env);const original=global.fetch;
  global.fetch=async(url,o)=>{assert.ok(f.telegram.some(x=>x.method==='sendChatAction'));return providerFixture().fetch(url,o);};
  try{await f.tap('chat');await f.say('Giải thích thuế GTGT');await Promise.all(f.waits);assert.ok(f.telegram.some(x=>x.method==='sendMessage'&&x.body.text==='OK'));const c=await f.manager.config(env);assert.equal(c.telegramHistory['telegram:7:1'].at(-1).content,'OK');}finally{global.fetch=original;}
});
test('buttons add/edit/delete URL model key, confirmations, actor binding and restart prompts', async () => {
  const f = fixture(); await f.manager.ensure(env);
  await f.tap('newurl'); await f.say('Dự phòng'); f.restart(); await f.say('https://three.test/v1');
  let c = await f.manager.config(env); const u = c.urls[2]; assert.equal(u.name, 'Dự phòng');
  await f.tap('newmodel:' + u.id); await f.say('new/model');
  c = await f.manager.config(env); const m = c.urls[2].models[0];
  await f.tap('newkey:' + m.id); await f.say('Key chính'); await f.say('new-secret-999');
  c = await f.manager.config(env); const k = c.urls[2].models[0].keys[0]; assert.equal(k.secret, 'new-secret-999');
  assert.ok(f.telegram.some(x => x.method === 'deleteMessage'));
  assert.equal(JSON.stringify(f.telegram.filter(x => x.method === 'sendMessage')).includes('new-secret-999'), false);
  await f.tap('edit:secret:' + k.id); await f.say('another-secret-888', 2);
  assert.equal((await f.manager.config(env)).urls[2].models[0].keys[0].secret, 'new-secret-999');
  await f.say('replacement-777');
  assert.equal((await f.manager.config(env)).urls[2].models[0].keys[0].secret, 'replacement-777');
  await f.tap('edit:model:' + m.id); await f.say('edited/model');
  await f.tap('edit:url:' + u.id); await f.say('https://changed.test/v1');
  c = await f.manager.config(env); assert.equal(c.urls[2].url, 'https://changed.test/v1'); assert.equal(c.urls[2].models[0].name, 'edited/model');
  await f.tap('delete:' + k.id); assert.equal((await f.manager.config(env)).urls[2].models[0].keys.length, 1);
  await f.tap('confirm:' + k.id, 2); assert.equal((await f.manager.config(env)).urls[2].models[0].keys.length, 1);
  await f.tap('confirm:' + k.id); assert.equal((await f.manager.config(env)).urls[2].models[0].keys.length, 0);
  await f.tap('delete:' + m.id); await f.tap('confirm:' + m.id);
  await f.tap('delete:' + u.id); await f.tap('confirm:' + u.id);
  assert.equal((await f.manager.config(env)).urls.length, 2);
});
test('non-admin and foreign chat cannot manage; tree buttons <=64 bytes, old buttons redirect', async () => {
  const f = fixture(); f.setAdmin(false); await f.tap('newurl'); assert.equal(f.raw(), null);
  f.setAdmin(true); await f.tap('newurl', 1, '-100999'); assert.equal(f.raw(), null);
  await f.tap('view:root');
  for (const call of f.telegram) for (const row of call.body.reply_markup?.inline_keyboard || []) for (const b of row) assert.ok(Buffer.byteLength(b.callback_data) <= 64);
  const sent = f.telegram.filter(x => x.method === 'sendMessage'); assert.ok(sent.at(-1).body.text.includes('2 URL · 3 model · 4 key'));
});
test('priority, enabled and cooldown survive restart; choosing model puts it first', async () => {
  const f = fixture(); const c = await f.manager.ensure(env), m2 = c.urls[0].models[1];
  await f.tap('active:' + m2.id); f.restart();
  assert.equal(candidates(await f.manager.config(env))[0].m.id, m2.id);
  await f.tap('toggle:' + m2.id);
  assert.equal(candidates(await f.manager.config(env)).some(x => x.m.id === m2.id), false);
});
test('proxy exhausts key then model then URL; quota health persists, secrets never returned', async () => {
  const f = fixture(); await f.manager.ensure(env); const seen = [], original = global.fetch;
  global.fetch = async (url, options) => { seen.push({ url, model: JSON.parse(options.body).model, key: options.headers.Authorization }); return url.startsWith('https://two') ? new Response('success') : new Response('quota key-one-111', { status: 402 }); };
  try {
    assert.equal(await (await f.manager.proxy(env, { messages: [] })).text(), 'success');
    assert.deepEqual(seen.map(x => x.model), ['m1', 'm1', 'm2', 'm3']);
    f.restart(); assert.deepEqual(candidates(await f.manager.config(env)).map(x => x.m.name), ['m3']);
  } finally { global.fetch = original; }
});
test('429 for one model still tries shared key at next model; 404 skips model, network skips URL', async () => {
  const f = fixture(); const c = migrate({ active: 'm1', profiles: [{ alias:'m1',baseURL:'https://one.test/v1',model:'m1',keys:['shared-key-111'] },{ alias:'m2',baseURL:'https://one.test/v1',model:'m2',keys:['shared-key-111'] }] });
  await f.deps.write(env, await seal(c, env.TOKEN_SECRET), '0'); const original = global.fetch, seen = [];
  global.fetch = async (url, options) => { const model = JSON.parse(options.body).model; seen.push(model); return model === 'm1' ? new Response('model rate limit', {status:429}) : new Response('ok'); };
  try { assert.equal(await (await f.manager.proxy(env, {messages:[]})).text(), 'ok'); assert.deepEqual(seen,['m1','m2']); } finally {global.fetch = original;}
});
test('check-all resumes across batches and restart; checks every key, rejects forged continuation', async () => {
  const f = fixture(); await f.manager.ensure(env); const original = global.fetch, checked = [];
  global.fetch = async (url, options) => {
    if (url.endsWith('/internal/ai/check')) { f.restart(); return f.manager.internal(env, new Request(url, options), { waitUntil: p => f.waits.push(p) }); }
    checked.push(options.headers.Authorization); return Response.json({ data: [{ id: 'model' }] });
  };
  try {
    const bad = await f.manager.internal(env,new Request('https://gateway.test/internal/ai/check',{method:'POST',body:JSON.stringify({jobId:'fake',token:'fake'})}),{waitUntil(){throw Error('must not run');}});
    assert.equal(bad.status,403);
    await f.tap('check:all');
    for(let i=0;i<f.waits.length;i++)await f.waits[i];
    assert.equal(checked.length,4); assert.equal(new Set(checked).size,4);
    const c=await f.manager.config(env); assert.equal(Object.values(c.jobs)[0].status,'complete');
    assert.ok(c.urls.every(u=>u.models.every(m=>m.keys.every(k=>k.health.status==='unknown'))));
    assert.ok(f.telegram.some(x=>x.method==='editMessageText' && x.body.text.includes('Đã check 4 key')));
    assert.equal(f.telegram.filter(x=>x.method==='sendMessage').length,1,'one shared panel even after batch restart');
  } finally {global.fetch=original;}
});

test('paid model test needs exact one-use confirmation; expiry/balance checks are truthful', async () => {
  const f=fixture(); const c=await f.manager.ensure(env), key=c.urls[0].models[0].keys[0]; const original=global.fetch; let requests=0;
  global.fetch=async()=>{requests++;return Response.json({choices:[{message:{content:'ok'}}]});};
  try {
    await f.tap('testgo:'+key.id); assert.equal(requests,0);
    await f.tap('test:'+key.id); assert.equal(requests,0);
    await f.tap('testgo:'+key.id); assert.equal(requests,1);
    await f.tap('testgo:'+key.id); assert.equal(requests,1);
    const item={u:{url:'https://openrouter.ai/api/v1'},m:{name:'test'},k:{secret:'some-key-111'}};
    global.fetch=async()=>Response.json({data:{expires_at:'2000-01-01T00:00:00Z',limit_remaining:10}});
    assert.equal((await f.manager.inspect(env,item)).status,'auth');
    global.fetch=async()=>Response.json({data:{limit_remaining:0,is_free_tier:false}});
    assert.equal((await f.manager.inspect(env,item)).status,'quota');
    global.fetch=async()=>Response.json({data:{limit_remaining:null}});
    assert.match((await f.manager.inspect(env,item)).label,/chưa xác minh số dư/);
  } finally {global.fetch=original;}
});

test('invalid model skips remaining keys; network failure skips URL and records temporary cooldown',async()=>{
  const f=fixture();await f.manager.ensure(env);const original=global.fetch,seen=[];
  global.fetch=async(url,options)=>{const model=JSON.parse(options.body).model;seen.push(model);if(model==='m1')return new Response('model not found',{status:404});if(model==='m2')throw Error('offline');return new Response('ok');};
  try {assert.equal(await(await f.manager.proxy(env,{messages:[]})).text(),'ok');assert.deepEqual(seen,['m1','m2','m3']);const c=await f.manager.config(env);assert.ok(c.urls[0].retryAt>Date.now());assert.ok(c.urls[0].models[0].retryAt>Date.now());}finally{global.fetch=original;}
});

test('navigation reuses one persisted panel; key status/help use popup with no new chat messages', async()=>{
  const f=fixture();const c=await f.manager.ensure(env),u=c.urls[0],m=u.models[0],k=m.keys[0];
  await f.tap('view:root');await f.tap('view:'+u.id);f.restart();await f.tap('view:'+m.id);await f.tap('view:'+k.id);await f.tap('tree');
  assert.equal(f.telegram.filter(x=>x.method==='sendMessage').length,1);
  assert.equal(f.telegram.filter(x=>x.method==='editMessageText').length,4);
  const before=f.telegram.filter(x=>['sendMessage','editMessageText'].includes(x.method)).length;
  await f.tap('info:'+k.id);await f.tap('help');
  assert.equal(f.telegram.filter(x=>['sendMessage','editMessageText'].includes(x.method)).length,before);
  const popups=f.telegram.filter(x=>x.method==='answerCallbackQuery'&&x.body.show_alert);
  assert.equal(popups.length,2);assert.ok(popups.every(x=>x.body.text.length<=200));
  assert.equal(JSON.stringify(popups).includes(k.secret),false);
});

test('endpoint editor persists custom chat/models/key paths, rejects foreign host, drives real proxy route',async()=>{
  const f=fixture();const c=await f.manager.ensure(env),u=c.urls[0];
  await f.tap('endpoints:'+u.id);
  await f.tap('edit:ep_chat:'+u.id);await f.say('/custom/chat');
  let stored=(await f.manager.config(env)).urls[0];assert.equal(endpoint(stored,'chat'),'https://one.test/v1/custom/chat');
  await f.tap('edit:ep_models:'+u.id);await f.say('https://one.test/catalog');
  await f.tap('edit:ep_key:'+u.id);await f.say('/verify');
  stored=(await f.manager.config(env)).urls[0];assert.equal(endpoint(stored,'models'),'https://one.test/catalog');assert.equal(endpoint(stored,'key'),'https://one.test/v1/verify');
  await f.tap('edit:ep_chat:'+u.id);await f.say('https://foreign.test/chat');
  assert.equal((await f.manager.config(env)).urls[0].endpoints.chat,'/custom/chat');
  const original=global.fetch;let called;
  global.fetch=async(url)=>{called=url;return new Response('ok');};
  try {assert.equal(await(await f.manager.proxy(env,{messages:[]})).text(),'ok');assert.equal(called,'https://one.test/v1/custom/chat');}finally{global.fetch=original;}
  assert.equal(endpoint({url:'https://openrouter.ai/api/v1/chat/completions'},'chat'),'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(endpoint({url:'https://openrouter.ai/api/v1/chat/completions'},'key'),'https://openrouter.ai/api/v1/key');
});

// ── Bảng điều khiển theo URL: 1 URL là 1 bảng, thêm/xoá model và API ngay tại chỗ ──
test('bảng URL hiện danh sách model và API, mọi nút đều trong hạn 64 byte', async () => {
  const f = fixture(); const c = await f.manager.ensure(env); const u = c.urls[0];
  // Tên model/API nằm ở NHÃN NÚT; nội dung tin chỉ có phần đầu và số đếm.
  const boardOf = () => f.telegram.filter(x => (x.method === 'sendMessage' || x.method === 'editMessageText') && String(x.body.text || '').includes('MODEL ·')).at(-1);
  const labelsOf = call => (call.body.reply_markup?.inline_keyboard || []).flat().map(b => b.text);
  await f.tap('view:' + u.id);
  const call = boardOf(), text = call.body.text, labels = labelsOf(call);
  assert.ok(text.includes('MODEL · 2'), 'phải hiện số model: ' + text.slice(0, 120));
  assert.ok(text.includes('API · 3'), 'phải hiện số API đã gom theo giá trị key (key-one, key-two, key-three)');
  assert.ok(labels.some(t => t.includes('m1')) && labels.some(t => t.includes('m2')), 'mỗi model phải có một dòng: ' + labels.join(' | '));
  assert.ok(labels.some(t => t.includes('Test URL · 2 model × 3 API')), 'phải có nút test cả URL');
  assert.ok(labels.filter(t => t === '🗑').length >= 2, 'mỗi model phải có nút xoá nhanh');
  for (const call of f.telegram) for (const row of call.body.reply_markup?.inline_keyboard || []) for (const b of row) assert.ok(Buffer.byteLength(b.callback_data) <= 64, b.callback_data);
});

test('thêm API cho URL thì áp cho MỌI model, không lộ key ra ngoài', async () => {
  const f = fixture(); const c = await f.manager.ensure(env); const u = c.urls[0];
  await f.tap('addapi:' + u.id); await f.say('shared-api-key-9999');
  const next = await f.manager.config(env);
  assert.equal(next.urls[0].models.length, 2);
  for (const m of next.urls[0].models) assert.ok(m.keys.some(k => k.secret === 'shared-api-key-9999'), m.name + ' phải nhận API dùng chung');
  assert.equal(next.urls[1].models[0].keys.some(k => k.secret === 'shared-api-key-9999'), false, 'không được rò sang URL khác');
  const sent = f.telegram.filter(x => x.method === 'sendMessage');
  assert.equal(JSON.stringify(sent).includes('shared-api-key-9999'), false, 'không được gửi key vào chat');
  // Bảng URL giờ gom API dùng chung thành MỘT dòng: 3 API cũ + 1 API mới = 4.
  const board = f.telegram.filter(x => (x.method === 'sendMessage' || x.method === 'editMessageText') && String(x.body.text || '').includes('MODEL ·')).at(-1);
  const labels = (board.body.reply_markup?.inline_keyboard || []).flat().map(b => b.text);
  assert.ok(board.body.text.includes('API · 4'), 'phải gom API dùng chung: ' + board.body.text.slice(0, 200));
  assert.ok(labels.some(t => t.includes('dùng cho 2 model')), 'API mới phải ghi rõ dùng cho 2 model: ' + labels.join(' | '));
});

test('xoá nhanh một model ngay trên bảng URL, phải xác nhận mới xoá', async () => {
  const f = fixture(); const c = await f.manager.ensure(env); const m = c.urls[0].models[1];
  await f.tap('rmmodel:' + m.id);
  assert.equal((await f.manager.config(env)).urls[0].models.length, 2, 'chưa xác nhận thì không được xoá');
  await f.tap('dormmodel:' + m.id);
  const next = await f.manager.config(env);
  assert.equal(next.urls[0].models.length, 1);
  assert.equal(next.urls[0].models.some(x => x.id === m.id), false);
  assert.equal(next.urls[0].models[0].name, 'm1', 'model còn lại phải nguyên vẹn');
});

test('xoá một API thì xoá khỏi MỌI model của URL', async () => {
  const f = fixture(); await f.manager.ensure(env);
  let c = await f.manager.config(env);
  await f.tap('addapi:' + c.urls[0].id); await f.say('shared-api-key-9999');
  c = await f.manager.config(env);
  const target = c.urls[0].models[0].keys.find(k => k.secret === 'shared-api-key-9999');
  assert.ok(target, 'API dùng chung phải tồn tại');
  await f.tap('rmapi:' + target.id);
  await f.tap('dormapi:' + target.id);
  c = await f.manager.config(env);
  for (const m of c.urls[0].models) assert.equal(m.keys.some(k => k.secret === 'shared-api-key-9999'), false, m.name + ' vẫn còn API đã xoá');
  assert.equal(c.urls[0].models[0].keys.length, 2, 'các API khác phải giữ nguyên');
});

test('thêm lại đúng API cũ thì bị từ chối, không tạo bản trùng', async () => {
  const f = fixture(); const c = await f.manager.ensure(env); const u = c.urls[0];
  await f.tap('addapi:' + u.id); await f.say('shared-api-key-9999');
  await f.tap('addapi:' + u.id); await f.say('shared-api-key-9999');
  const next = await f.manager.config(env);
  assert.equal(next.urls[0].models[0].keys.filter(k => k.secret === 'shared-api-key-9999').length, 1);
});

test('API key sai định dạng bị từ chối, không ghi vào kho', async () => {
  const f = fixture(); const c = await f.manager.ensure(env); const u = c.urls[0];
  const before = JSON.stringify((await f.manager.config(env)).urls[0]);
  await f.tap('addapi:' + u.id); await f.say('key co dau cach');
  assert.equal(JSON.stringify((await f.manager.config(env)).urls[0]), before, 'kho phải nguyên vẹn');
});
