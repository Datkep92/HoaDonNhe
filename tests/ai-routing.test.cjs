'use strict';
// Lớp giao thức của Gateway: nhiều cấu hình chạy tốt ở ứng dụng khác nhưng bị báo "giao thức chưa
// hỗ trợ" vì máy chủ chưa thử đúng đường dẫn/định dạng của họ. Các test này khoá lại hành vi đó.
const test=require('node:test'),assert=require('node:assert/strict');
const path=require('node:path');
const ROUTING=path.join(__dirname,'..','cloudflare-worker','src','ai-routing.js');
const ADMIN=path.join(__dirname,'..','cloudflare-worker','src','ai-admin.js');
let R,endpoint;
test.before(async()=>{R=await import('file://'+ROUTING.replace(/\\/g,'/'));endpoint=(await import('file://'+ADMIN.replace(/\\/g,'/'))).endpoint;});
test.beforeEach(()=>R.resetResolvedEndpoints());

// Ghi lại yêu cầu rồi trả phản hồi theo kịch bản, thay cho fetch thật.
function stubFetch(handler){
  const calls=[];
  const original=globalThis.fetch;
  globalThis.fetch=async(url,init)=>{calls.push({url:String(url),init,body:init?.body?JSON.parse(init.body):null});return handler(String(url),calls.length);};
  return {calls,restore:()=>{globalThis.fetch=original;}};
}

test('protocolOptions thử thêm giao thức của các nhà cung cấp phổ biến và không lặp đường dẫn',()=>{
  const seen={};
  for(const url of ['https://api.openai.com/v1','https://generativelanguage.googleapis.com/v1beta','https://api.cohere.com','https://myres.openai.azure.com','https://my-ollama.example.com']){
    const options=R.protocolOptions({url},endpoint);
    assert.equal(new Set(options.map(o=>o.endpoint)).size,options.length,'đường dẫn không được trùng: '+url);
    for(const o of options)assert.ok(o.endpoint.startsWith('https://'),'phải là HTTPS: '+o.endpoint);
    seen[url]=options;
  }
  // Đúng giao thức của nhà cung cấp phải được thử TRƯỚC, để không tốn thời gian dò.
  assert.equal(seen['https://myres.openai.azure.com'][0].protocol,'azure');
  assert.match(seen['https://myres.openai.azure.com'][0].endpoint,/\/openai\/deployments\/\{model\}\/chat\/completions\?api-version=/);
  assert.equal(seen['https://my-ollama.example.com'][0].protocol,'ollama');
  assert.match(seen['https://my-ollama.example.com'][0].endpoint,/\/api\/chat$/);
  assert.equal(seen['https://api.cohere.com'][0].protocol,'cohere');
  assert.match(seen['https://api.cohere.com'][0].endpoint,/\/v2\/chat$/);
  // Gemini kiểu OpenAI phải đứng trước, và không được lặp /v1beta.
  assert.match(seen['https://generativelanguage.googleapis.com/v1beta'][0].endpoint,/^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/openai\/chat\/completions$/);
});

test('endpoint tường minh của quản trị viên vẫn là nguồn duy nhất, không dò thêm',()=>{
  const options=R.protocolOptions({url:'https://api.openai.com/v1/chat/completions',endpoints:{chat:'/chat/completions'}},endpoint);
  assert.equal(options.length,1,'khai endpoint rồi thì không được tự đoán thêm');
});

test('ollamaChat chuẩn hoá phản hồi Ollama, kể cả khi model gọi tool',()=>{
  const plain=R.ollamaChat({model:'llama3',message:{role:'assistant',content:'Chào'},done_reason:'stop'});
  assert.equal(plain.choices[0].message.content,'Chào');
  assert.equal(plain.choices[0].finish_reason,'stop');
  const tool=R.ollamaChat({message:{role:'assistant',content:'',tool_calls:[{function:{name:'health_ping',arguments:{}}}]}});
  assert.equal(tool.choices[0].message.tool_calls[0].function.name,'health_ping');
  assert.equal(tool.choices[0].message.tool_calls[0].function.arguments,'{}','tham số phải thành chuỗi JSON');
  assert.equal(tool.choices[0].finish_reason,'tool_calls');
  assert.throws(()=>R.ollamaChat({}),/invalid response protocol/);
});

test('cohereChat gộp các phần text và đọc được tool call',()=>{
  const plain=R.cohereChat({model:'command-r',message:{content:[{type:'text',text:'Chào '},{type:'text',text:'bạn'}]}});
  assert.equal(plain.choices[0].message.content,'Chào bạn');
  const tool=R.cohereChat({message:{content:[],tool_calls:[{id:'t1',function:{name:'health_ping',arguments:'{}'}}]}});
  assert.equal(tool.choices[0].message.tool_calls[0].id,'t1');
  assert.equal(tool.choices[0].finish_reason,'tool_calls');
  assert.throws(()=>R.cohereChat({}),/invalid response protocol/);
});

test('providerCall gọi Ollama đúng đường dẫn và định dạng, rồi trả về dạng chat chung',async()=>{
  const stub=stubFetch(()=>Response.json({model:'llama3',message:{role:'assistant',content:'OK'},done:true}));
  try{
    const result=await R.providerCall({u:{url:'https://ollama.test'},m:{name:'llama3'},k:{secret:'sk-x'}},{messages:[{role:'user',content:'Chào'}],max_tokens:32},{protocol:'ollama',endpoint:'https://ollama.test/api/chat'},5000);
    assert.equal(stub.calls.length,1);
    assert.equal(stub.calls[0].url,'https://ollama.test/api/chat');
    assert.equal(stub.calls[0].body.stream,false,'Ollama gốc phải gọi không truyền dần');
    assert.equal(stub.calls[0].body.options.num_predict,32);
    const data=await result.response.json();
    assert.equal(data.choices[0].message.content,'OK');
  }finally{stub.restore();}
});

test('providerCall dùng header api-key và thay {model} cho Azure',async()=>{
  const stub=stubFetch(()=>Response.json({choices:[{message:{role:'assistant',content:'OK'},finish_reason:'stop'}]}));
  try{
    const result=await R.providerCall({u:{url:'https://res.openai.azure.com'},m:{name:'gpt-4o'},k:{secret:'azure-key'}},{messages:[{role:'user',content:'Chào'}]},{protocol:'azure',endpoint:'https://res.openai.azure.com/openai/deployments/{model}/chat/completions?api-version=2024-06-01'},5000);
    assert.equal(stub.calls[0].url,'https://res.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-06-01');
    assert.equal(stub.calls[0].init.headers['api-key'],'azure-key');
    assert.equal(stub.calls[0].init.headers.Authorization,undefined,'Azure không dùng Bearer');
    assert.equal(stub.calls[0].body.model,undefined,'Azure lấy model từ đường dẫn');
    assert.ok(result.response);
  }finally{stub.restore();}
});

test('giao thức trả JSON một lần vẫn phục vụ được khi bên gọi xin truyền dần',async()=>{
  const stub=stubFetch(()=>Response.json({message:{role:'assistant',content:'OK'}}));
  try{
    const result=await R.providerCall({u:{url:'https://ollama.test'},m:{name:'llama3'},k:{secret:'sk-x'}},{messages:[{role:'user',content:'Chào'}],stream:true},{protocol:'ollama',endpoint:'https://ollama.test/api/chat'},5000);
    assert.match(result.response.headers.get('Content-Type'),/text\/event-stream/,'phải tự bọc thành SSE cho app');
    const text=await result.response.text();
    assert.match(text,/data: /);
    assert.match(text,/\[DONE\]/);
  }finally{stub.restore();}
});

test('resolveCall thử tiếp giao thức khác khi gặp 404 thay vì bỏ cuộc',async()=>{
  const stub=stubFetch(url=>url.endsWith('/api/chat')?Response.json({message:{role:'assistant',content:'OK'}}):new Response('not found',{status:404}));
  try{
    const result=await R.resolveCall({u:{url:'https://mixed.test'},m:{name:'m1'},k:{secret:'sk-x'}},{messages:[{role:'user',content:'Chào'}]},endpoint,8000);
    assert.ok(result.response,'phải tìm ra giao thức đúng');
    assert.equal(result.resolved.protocol,'ollama');
    assert.ok(stub.calls.length>=2,'phải thử nhiều giao thức');
  }finally{stub.restore();}
});

// OpenCode Zen dùng OpenAI-compatible nhưng đường dẫn thật nằm dưới /zen. Khai thiếu /zen (hoặc chỉ
// khai tên miền) làm mọi đường dẫn khác 404 và bị báo nhầm "giao thức chưa hỗ trợ".
test('OpenCode Zen: đường dẫn /zen/v1/chat/completions được thử TRƯỚC dù URL khai thiếu',()=>{
  for(const url of ['https://opencode.ai','https://opencode.ai/zen','https://opencode.ai/zen/v1','https://opencode.ai/zen/go/v1']){
    const options=R.protocolOptions({url},endpoint);
    assert.equal(options[0].endpoint,'https://opencode.ai/zen/v1/chat/completions','phải thử đường dẫn đúng trước: '+url);
    assert.equal(options[0].protocol,'chat');
    assert.equal(new Set(options.map(o=>o.endpoint)).size,options.length,'không được trùng đường dẫn: '+url);
  }
});

test('OpenCode Go gửi kèm mã phiên, nếu không sẽ bị 400 MissingSessionID',async()=>{
  const stub=stubFetch(()=>Response.json({choices:[{message:{role:'assistant',content:'OK'},finish_reason:'stop'}]}));
  try{
    const result=await R.providerCall({u:{url:'https://opencode.ai/zen/go/v1'},m:{name:'space-bunny-free'},k:{secret:'oc_sk_x',id:'k1'}},{messages:[{role:'user',content:'Chào'}],metadata:{conversation_id:'conv-42'}},{protocol:'opencode-go',endpoint:'https://opencode.ai/zen/go/v1/chat/completions'},5000);
    assert.equal(stub.calls[0].init.headers['x-opencode-session'],'conv-42');
    assert.equal(stub.calls[0].init.headers.Authorization,'Bearer oc_sk_x');
    assert.equal(stub.calls[0].body.model,'space-bunny-free');
    assert.ok(result.response);
  }finally{stub.restore();}
});

test('OpenCode Go trả JSON một lần vẫn phục vụ được khi app xin truyền dần',async()=>{
  const stub=stubFetch(()=>Response.json({choices:[{message:{role:'assistant',content:'OK'},finish_reason:'stop'}]}));
  try{
    const result=await R.providerCall({u:{url:'https://opencode.ai/zen/go/v1'},m:{name:'m'},k:{secret:'s',id:'k1'}},{messages:[{role:'user',content:'Chào'}],stream:true},{protocol:'opencode-go',endpoint:'https://opencode.ai/zen/go/v1/chat/completions'},5000);
    assert.match(result.response.headers.get('Content-Type'),/text\/event-stream/);
  }finally{stub.restore();}
});

// 7 model cùng một URL (như ca OpenCode) không được dò đường dẫn 7 lần.
test('nhiều model cùng một URL chỉ dò đường dẫn MỘT lần',async()=>{
  const stub=stubFetch(url=>url.endsWith('/api/chat')?Response.json({message:{role:'assistant',content:'OK'}}):new Response('not found',{status:404}));
  try{
    const first=await R.resolveCall({u:{url:'https://share.test'},m:{name:'m1'},k:{secret:'s'}},{messages:[{role:'user',content:'x'}]},endpoint,8000);
    assert.ok(first.response);
    const afterFirst=stub.calls.length;
    const second=await R.resolveCall({u:{url:'https://share.test'},m:{name:'m2'},k:{secret:'s'}},{messages:[{role:'user',content:'x'}]},endpoint,8000);
    assert.ok(second.response);
    assert.equal(second.resolved.protocol,'ollama');
    assert.equal(stub.calls.length,afterFirst+1,'model thứ hai phải dùng lại đường dẫn đã dò, chỉ gọi đúng 1 lần');
  }finally{stub.restore();}
});

test('đường dẫn đã nhớ mà hỏng thì bị quên và dò lại, không kẹt vĩnh viễn',async()=>{
  let chatOk=true;
  const stub=stubFetch(url=>{
    if(url.endsWith('/api/chat'))return chatOk?Response.json({message:{role:'assistant',content:'OK'}}):new Response('gone',{status:404});
    return new Response('not found',{status:404});
  });
  try{
    assert.ok((await R.resolveCall({u:{url:'https://stale.test'},m:{name:'m1'},k:{secret:'s'}},{messages:[{role:'user',content:'x'}]},endpoint,8000)).response);
    chatOk=false;
    const before=stub.calls.length;
    const second=await R.resolveCall({u:{url:'https://stale.test'},m:{name:'m2'},k:{secret:'s'}},{messages:[{role:'user',content:'x'}]},endpoint,8000);
    assert.equal(second.error.errorClass,'PROTOCOL_UNSUPPORTED','phải báo rõ chứ không treo');
    assert.ok(stub.calls.length-before>2,'phải dò lại toàn bộ chứ không chỉ thử lại đường dẫn cũ');
  }finally{stub.restore();}
});

// OpenCode khoá model miễn phí để chỉ chạy trong app của họ. Phải báo ĐÚNG lý do này để quản trị
// viên biết là không sửa được bằng cấu hình, thay vì báo lấp lửng "không có quyền".
test('model miễn phí bị OpenCode khoá được nhận diện và báo rõ, không lẫn với lỗi key',()=>{
  const locked=R.classify(403,JSON.stringify({type:'error',error:{type:'FreeTierError',message:"OpenCode's free tier can only be used from within OpenCode"}}));
  assert.equal(locked.errorClass,'FREE_TIER_LOCKED');
  assert.match(locked.label,/OpenCode/);
  assert.ok(locked.retryAt-Date.now()>3600000,'phải cho nghỉ dài, không thử lại liên tục');
  // Lỗi key thật vẫn phải ra AUTH_ERROR, không bị nhận nhầm.
  assert.equal(R.classify(403,'forbidden').errorClass,'AUTH_ERROR');
  assert.equal(R.classify(401,'invalid api key').errorClass,'INVALID_KEY');
  assert.equal(R.classify(400,'Upstream request failed: Model is unavailable.').errorClass,'MODEL_NOT_FOUND');
});

test('502/504 từ nhà cung cấp vẫn là lỗi tạm thời, không bị coi là hỏng vĩnh viễn',()=>{
  assert.equal(R.classify(502,'bad gateway').errorClass,'PROVIDER_ERROR');
  assert.equal(R.classify(504,'').errorClass,'PROVIDER_ERROR');
  assert.equal(R.classify(0,'',{name:'TimeoutError'}).errorClass,'TIMEOUT');
});

// Model yếu/miễn phí thường không vượt bài kiểm tra tool tổng hợp nhưng vẫn CHAT TỐT. Coi `tools`
// là điều kiện chặn khiến app không bao giờ lấy được cấu hình dù quota/hạn còn nguyên — trong khi
// Telegram (không đòi tool) vẫn chạy. Đây là lỗi logic đã từng làm EXE kẹt ở "đang tìm cấu hình".
test('tools là điều kiện MỀM: model không vượt bài kiểm tra tool vẫn được dùng để chat',()=>{
  const route={status:'ok',capabilities:{chat:true,stream:false,tools:false,vision:false}};
  assert.equal(R.compatible(route,{chat:true,tools:true}),true,'thiếu tools KHÔNG được chặn');
  assert.equal(R.compatible(route,{chat:true,stream:true}),false,'stream=false vẫn phải chặn khi client đòi truyền dần');
  assert.equal(R.compatible(route,{chat:true,vision:true}),false,'vision=false vẫn phải chặn khi client gửi ảnh');
  assert.equal(R.compatible({status:'ok',capabilities:{chat:false}},{chat:true}),false,'chat=false thì phải chặn');
  assert.equal(R.compatible({status:'ok',capabilities:{chat:true}},{chat:true,tools:true}),true);
  assert.equal(R.compatible({status:'error'},{chat:true}),true,'chưa xác minh thì vẫn cho thử');
});
