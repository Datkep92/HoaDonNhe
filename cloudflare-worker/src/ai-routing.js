// Provider-neutral routing helpers. No provider secrets are included in diagnostics.
import { nativeBody, nativeChat, nativeStream } from './ai-native.js';
export function classify(status = 0, detail = '', error) {
  const text = String(detail).toLowerCase();
  let errorClass = 'UNKNOWN_ERROR', cooldown = 30000;
  if (error) errorClass = /abort|timeout/i.test(error.name || '') ? 'TIMEOUT' : 'NETWORK_ERROR';
  else if (/expired.*key|key.*expired/.test(text)) { errorClass = 'EXPIRED_KEY'; cooldown = 86400000; }
  else if (status === 401 || /invalid[_ ](?:api[_ ])?key/.test(text)) { errorClass = 'INVALID_KEY'; cooldown = 86400000; }
  else if (/free tier can only be used from within opencode|freetiererror/.test(text)) { errorClass = 'FREE_TIER_LOCKED'; cooldown = 21600000; }
  else if (status === 403) { errorClass = 'AUTH_ERROR'; cooldown = 300000; }
  else if (status === 402 || /insufficient|quota|credit|balance/.test(text)) { errorClass = 'QUOTA_EXCEEDED'; cooldown = 900000; }
  else if (status === 429) { errorClass = 'RATE_LIMIT'; cooldown = 60000; }
  else if (/model.*(?:not found|unavailable|invalid|disabled)|invalid.*model|not a valid model|invalid_model|no endpoints found for/.test(text)) { errorClass = 'MODEL_NOT_FOUND'; cooldown = 300000; }
  else if (/support.*(?:tool|vision|image)|capability/.test(text)) { errorClass = 'CAPABILITY_MISMATCH'; cooldown = 300000; }
  else if (status === 404 || [301,302,307,308].includes(status)) { errorClass = 'ENDPOINT_NOT_FOUND'; cooldown = 300000; }
  else if (status === 415 || /protocol|invalid response|json|html|missing.*(?:messages|contents|input)|(?:messages|contents|input).*required/.test(text)) { errorClass = 'PROTOCOL_MISMATCH'; cooldown = 300000; }
  else if (status >= 500) errorClass = 'PROVIDER_ERROR';
  const labels = {AUTH_ERROR:'không có quyền',INVALID_KEY:'key không hợp lệ',EXPIRED_KEY:'key hết hạn',QUOTA_EXCEEDED:'hết quota',RATE_LIMIT:'giới hạn tốc độ',MODEL_NOT_FOUND:'model không tồn tại',ENDPOINT_NOT_FOUND:'endpoint không đúng',PROTOCOL_MISMATCH:'giao thức không tương thích',PROVIDER_ERROR:'nhà cung cấp lỗi',NETWORK_ERROR:'lỗi mạng',TIMEOUT:'quá thời gian chờ',CAPABILITY_MISMATCH:'thiếu khả năng yêu cầu',FREE_TIER_LOCKED:'model miễn phí bị OpenCode khoá (chỉ chạy trong app OpenCode)',UNKNOWN_ERROR:'lỗi chưa xác định'};
  return {errorClass,label:labels[errorClass],retryAt:Date.now()+cooldown,status:['AUTH_ERROR','INVALID_KEY','EXPIRED_KEY'].includes(errorClass)?'auth':['QUOTA_EXCEEDED','RATE_LIMIT'].includes(errorClass)?'quota':'error'};
}
export function configurationId(x) { return [x.u.id,x.m.id,x.k.id].join('.'); }
export function requiredCapabilities(body) {
  return {chat:true, stream:body.stream===true, tools:!!body.tools?.length, vision:(body.messages||[]).some(m=>Array.isArray(m.content)&&m.content.some(p=>p.type==='image_url')), structured:body.response_format?.type==='json_schema'};
}
// `tools` KHÔNG phải điều kiện chặn. Model yếu/miễn phí thường không vượt được bài kiểm tra tool
// tổng hợp (phải gọi đúng hàm health_ping với tham số rỗng) nhưng vẫn CHAT TỐT, và app đã có sẵn
// JSON protocol để gọi tool. Coi tools là điều kiện cứng khiến app không bao giờ lấy được cấu hình
// dù quota/hạn còn nguyên — trong khi Telegram (không đòi tool) vẫn chạy. Chỉ chặn theo khả năng
// làm ĐỔI ĐỊNH DẠNG đường truyền: stream, vision, structured.
export function compatible(route, required) { if(route?.status&&route.status!=='ok')return true;return !Object.entries(required).some(([k,v])=>v&&k!=='tools'&&route?.capabilities?.[k]===false); }
export function healthResult(previous = {}, result) {
  const now=Date.now(), ok=result.status==='ok';
  const events=result.failureEvents||1;
  const failureCount=ok?0:(previous.failureCount||0)+events;
  const transient=['NETWORK_ERROR','TIMEOUT','PROVIDER_ERROR','UNKNOWN_ERROR'].includes(result.errorClass);
  const successes=(previous.successes||0)+(ok?1:0), failures=(previous.failures||0)+(ok?0:events);
  const latencyPenalty=Math.min(10,Math.max(0,((result.latency||previous.latency||0)-2000)/1000));
  return {...previous,...result,successes,failures,failureCount,healthScore:ok?Math.min(100,Math.round(70+30*successes/(successes+failures)-latencyPenalty)):Math.max(0,(previous.healthScore??70)-20),lastSuccess:ok?now:previous.lastSuccess||0,lastFailure:ok?previous.lastFailure||0:now,lastError:ok?'':result.errorClass||'UNKNOWN_ERROR',checkedAt:now,retryAt:ok?0:transient&&failureCount<2?0:result.retryAt,circuit:ok?'CLOSED':transient&&failureCount<2?'SUSPECT':'OPEN'};
}
export function protocolOptions(u, endpoint) {
  const base=u.url.replace(/\/(?:chat\/completions|responses|messages|models|key)\/?$/,'').replace(/\/$/,'');
  const chat=endpoint(u,'chat');
  const options=[{protocol:chat.endsWith('/responses')?'responses':'chat',endpoint:chat}];
  // An explicit endpoint is authoritative; do not probe paths the admin did not request.
  if (!u.endpoints?.chat) {
    const versioned=/\/v1(?:beta)?$/.test(base);
    if(!versioned)options.push({protocol:'chat',endpoint:base+'/v1/chat/completions'});
    options.push({protocol:'responses',endpoint:base+'/responses'});
    if(!versioned)options.push({protocol:'responses',endpoint:base+'/v1/responses'});
    options.push({protocol:'anthropic',endpoint:base+'/messages'});
    if(!versioned)options.push({protocol:'anthropic',endpoint:base+'/v1/messages'});
    options.push({protocol:'gemini',endpoint:base+(/\/v1(?:beta)?$/.test(base)?'':'/v1beta')+'/models/'});
    // Bổ sung các giao thức phổ biến khác. Nhiều cấu hình chạy tốt ở ứng dụng khác nhưng bị báo
    // "giao thức chưa hỗ trợ" chỉ vì máy chủ chưa thử đúng đường dẫn/định dạng của họ. Các đầu dò
    // này chỉ chạy khi những cái trước đó thất bại, nên không làm chậm trường hợp bình thường.
    options.push({protocol:'chat',endpoint:base+'/openai/chat/completions'});      // Gemini kiểu OpenAI, cổng tự dựng
    if(!versioned)options.push({protocol:'chat',endpoint:base+'/v1/openai/chat/completions'});
    options.push({protocol:'chat',endpoint:base+'/models/chat/completions'});      // Azure AI Foundry
    options.push({protocol:'ollama',endpoint:base+'/api/chat'});                   // Ollama gốc
    options.push({protocol:'cohere',endpoint:base.replace(/\/(?:v1|v2)$/,'')+'/v2/chat'}); // Cohere v2
    options.push({protocol:'azure',endpoint:base+'/openai/deployments/{model}/chat/completions?api-version=2024-06-01'});
    options.push({protocol:'azure',endpoint:base+'/openai/deployments/{model}/chat/completions?api-version=2024-02-01'});
  }
  // OpenCode Zen/Go: cùng máy chủ nhưng đường dẫn thật nằm dưới /zen. Nếu quản trị viên chỉ khai
  // tên miền (hoặc thiếu /zen/v1) thì mọi đường dẫn khác đều 404 và bị báo nhầm là "giao thức chưa
  // hỗ trợ", dù đây là OpenAI-compatible bình thường. Đặt đường dẫn đúng lên ĐẦU để dùng ngay.
  if(/opencode\.ai/i.test(u.url)){
    const origin=new URL(u.url).origin;
    options.unshift({protocol:'chat',endpoint:origin+'/zen/v1/chat/completions'});
    options.push({protocol:'opencode-go',endpoint:origin+'/zen/go/v1/chat/completions'});
  }
  if(/anthropic\.com|\/messages$/.test(u.url))options.sort((a,b)=>Number(b.protocol==='anthropic')-Number(a.protocol==='anthropic'));
  if(/generativelanguage\.googleapis\.com|\/v1beta$/.test(u.url))options.sort((a,b)=>Number(b.protocol==='gemini')-Number(a.protocol==='gemini'));
  if(/cohere\.(?:com|ai)/.test(u.url))options.sort((a,b)=>Number(b.protocol==='cohere')-Number(a.protocol==='cohere'));
  if(/ollama|:11434/.test(u.url))options.sort((a,b)=>Number(b.protocol==='ollama')-Number(a.protocol==='ollama'));
  if(/openai\.azure\.com|cognitiveservices\.azure\.com|\.azure\.com/.test(u.url))options.sort((a,b)=>Number(b.protocol==='azure')-Number(a.protocol==='azure'));
  // Với Google, đường kiểu OpenAI thường dễ dùng hơn và trả đúng định dạng chat.
  if(/generativelanguage\.googleapis\.com/.test(u.url))options.sort((a,b)=>Number(b.endpoint.includes('/openai/'))-Number(a.endpoint.includes('/openai/')));
  return options.filter((x,i,a)=>a.findIndex(y=>y.endpoint===x.endpoint)===i);
}
// Chuẩn hoá phản hồi của các giao thức khác về dạng chat chung của OpenAI.
export function ollamaChat(data) {
  const message=data?.message;if(!message)throw Error('invalid response protocol');
  const tool_calls=Array.isArray(message.tool_calls)&&message.tool_calls.length?message.tool_calls.map((t,index)=>({id:t.id||'call_'+index,type:'function',function:{name:t.function?.name,arguments:typeof t.function?.arguments==='string'?t.function.arguments:JSON.stringify(t.function?.arguments||{})}})):undefined;
  return {id:data.id||'',model:data.model,choices:[{index:0,message:{role:'assistant',content:typeof message.content==='string'?message.content:'',...(tool_calls?{tool_calls}:{})},finish_reason:data.done_reason||(tool_calls?'tool_calls':'stop')}],usage:{prompt_tokens:data.prompt_eval_count||0,completion_tokens:data.eval_count||0}};
}
export function cohereChat(data) {
  const message=data?.message;if(!message)throw Error('invalid response protocol');
  const content=Array.isArray(message.content)?message.content.filter(part=>part?.type==='text').map(part=>part.text||'').join(''):String(message.content||'');
  const tool_calls=Array.isArray(message.tool_calls)&&message.tool_calls.length?message.tool_calls.map((t,index)=>({id:t.id||'call_'+index,type:'function',function:{name:t.function?.name,arguments:typeof t.function?.arguments==='string'?t.function.arguments:JSON.stringify(t.function?.arguments||{})}})):undefined;
  return {id:data.id||'',model:data.model,choices:[{index:0,message:{role:'assistant',content,...(tool_calls?{tool_calls}:{})},finish_reason:data.finish_reason||(tool_calls?'tool_calls':'stop')}],usage:data.usage};
}
export function responsesBody(body) {
  const input=[];
  for(const m of body.messages||[]) {
    if(m.role==='tool') {input.push({type:'function_call_output',call_id:m.tool_call_id,output:String(m.content)});continue;}
    if(m.content!=null)input.push({role:m.role,content:Array.isArray(m.content)?m.content.map(p=>p.type==='image_url'?{type:'input_image',image_url:p.image_url?.url}: {type:m.role==='assistant'?'output_text':'input_text',text:p.text||''}):String(m.content)});
    for(const t of m.tool_calls||[])input.push({type:'function_call',call_id:t.id,name:t.function.name,arguments:t.function.arguments});
  }
  return {model:body.model,input,stream:false,max_output_tokens:body.max_tokens||body.max_completion_tokens||256,...(body.tools?{tools:body.tools.map(t=>({type:'function',...t.function}))}:{}),...(body.tool_choice?{tool_choice:typeof body.tool_choice==='object'?{type:'function',name:body.tool_choice.function.name}:body.tool_choice}:{}),...(body.response_format?{text:{format:body.response_format.type==='json_schema'?{type:'json_schema',...body.response_format.json_schema}:body.response_format}}:{})};
}
export function responsesChat(data) {
  if(!Array.isArray(data.output))throw Error('invalid response protocol');
  const content=data.output.filter(x=>x.type==='message').flatMap(x=>x.content||[]).filter(x=>x.type==='output_text').map(x=>x.text).join('');
  const tool_calls=data.output.filter(x=>x.type==='function_call').map(x=>({id:x.call_id||x.id,type:'function',function:{name:x.name,arguments:x.arguments}}));
  return {id:data.id,model:data.model,choices:[{index:0,message:{role:'assistant',content,...(tool_calls.length?{tool_calls}:{})},finish_reason:tool_calls.length?'tool_calls':'stop'}],usage:data.usage};
}
export async function providerCall(x, body, option, timeout=15000) {
  const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),timeout), started=Date.now();
  try {
    const native=['anthropic','gemini'].includes(option.protocol),headers={'Content-Type':'application/json'};
    if(option.protocol==='anthropic')Object.assign(headers,{'x-api-key':x.k.secret,'anthropic-version':'2023-06-01'});
    else if(option.protocol==='gemini')headers['x-goog-api-key']=x.k.secret;
    // Azure dùng header `api-key`, không dùng Bearer; một số cổng Google nhận key qua query.
    else if(option.protocol==='azure')headers['api-key']=x.k.secret;
    // OpenCode Go yêu cầu mã phiên để định tuyến; thiếu là bị trả 400 MissingSessionID.
    else if(option.protocol==='opencode-go'){headers.Authorization='Bearer '+x.k.secret;headers['x-opencode-session']=String(body.metadata?.conversation_id||x.sessionId||x.k.id||'cntaxtools');}
    else headers.Authorization='Bearer '+x.k.secret;
    const cleanMessages=(body.messages||[]).map(({providerParts,...message})=>message);
    const requestBody=native?nativeBody({...body,model:x.m.name},option.protocol)
      :option.protocol==='responses'?responsesBody({...body,model:x.m.name})
      :option.protocol==='ollama'?{model:x.m.name,messages:cleanMessages,stream:false,options:{num_predict:body.max_tokens||body.max_completion_tokens||256},...(body.tools?{tools:body.tools}:{})}
      :option.protocol==='cohere'?{model:x.m.name,messages:cleanMessages,...(body.tools?{tools:body.tools}:{})}
      :option.protocol==='azure'?{messages:cleanMessages,max_tokens:body.max_tokens,...(body.tools?{tools:body.tools,tool_choice:body.tool_choice}:{}),...(body.response_format?{response_format:body.response_format}:{}),...(body.temperature!=null?{temperature:body.temperature}:{})}
      :{...body,model:x.m.name,messages:cleanMessages};
    const address=option.protocol==='gemini'?option.endpoint+encodeURIComponent(x.m.name.replace(/^models\//,''))+':'+(body.stream?'streamGenerateContent?alt=sse':'generateContent')
      :option.protocol==='azure'?option.endpoint.replace('{model}',encodeURIComponent(x.m.name.replace(/^deployments\//,'')))
      :option.endpoint;
    let response=await fetch(address,{method:'POST',redirect:'manual',signal:controller.signal,headers,body:JSON.stringify(requestBody)});
    if(!response.ok) {
      const detail=await response.text(),error=classify(response.status,detail);
      // Giữ nguyên văn phản hồi của nhà cung cấp (đã cắt ngắn) để bảng quản trị nói được CHÍNH XÁC
      // vì sao hỏng, thay vì chỉ hiện nhóm lỗi chung chung. Việc che key do phía gọi làm.
      error.detail=String(detail||'').replace(/\s+/g,' ').slice(0,240);
      error.confirmedCredential=/invalid[_ ](?:api[_ ])?key|expired.*key|key.*expired/i.test(detail);
      const retry=response.headers.get('Retry-After');if(retry){const at=/^\d+(?:\.\d+)?$/.test(retry)?Date.now()+Number(retry)*1000:Date.parse(retry);if(Number.isFinite(at))error.retryAt=Math.max(Date.now()+1000,at);}
      error.failureScope=['INVALID_KEY','EXPIRED_KEY'].includes(error.errorClass)?'credential':error.errorClass==='QUOTA_EXCEEDED'&&/account|balance|credit|api.?key|billing/.test(detail.toLowerCase())?'credential':'configuration';
      return {error,http:response.status,latency:Date.now()-started};
    }
    if(native&&body.stream) {
      if(!/text\/event-stream/i.test(response.headers.get('Content-Type')||''))return {error:classify(415,'invalid response stream protocol'),http:415};
      response=nativeStream(response,option.protocol);
    }
    // Các giao thức trả JSON một lần. Kể cả khi bên gọi xin truyền dần, ta vẫn đọc JSON rồi tự
    // bọc thành một khung SSE bên dưới — nhờ vậy app không phải biết nhà cung cấp dùng giao thức gì.
    const jsonOnly=['responses','ollama','cohere','azure','opencode-go'].includes(option.protocol);
    if(jsonOnly||!body.stream) {
      let data;try{data=await response.json()}catch{return {error:classify(415,'invalid response json'),http:415};}
      if(option.protocol==='responses') {try{data=responsesChat(data)}catch{return {error:classify(415,'invalid response protocol'),http:415};}}
      if(native) {try{data=nativeChat(data,option.protocol)}catch{return {error:classify(415,'invalid response protocol'),http:415};}}
      if(option.protocol==='ollama') {try{data=ollamaChat(data)}catch{return {error:classify(415,'invalid response protocol'),http:415};}}
      if(option.protocol==='cohere') {try{data=cohereChat(data)}catch{return {error:classify(415,'invalid response protocol'),http:415};}}
      if(data.error||!data.choices?.[0]?.message)return {error:classify(data.error?.code||415,data.error?.message||'invalid response protocol'),http:415};
      const message=data.choices[0].message;
      if(!String(message.content||'').trim()&&!message.tool_calls?.length)return {error:classify(502,'empty completion'),http:502};
      if(body.response_format?.type?.startsWith('json')&&!jsonOnly)try{JSON.parse(data.choices[0].message.content)}catch{return {error:classify(415,'invalid response json format'),http:415};}
      if(body.stream) {
        const message=data.choices[0].message;
        if(message.tool_calls)message.tool_calls=message.tool_calls.map((t,index)=>({...t,index}));
        data={...data,choices:[{index:0,delta:message,finish_reason:data.choices[0].finish_reason}]};
        return {response:new Response('data: '+JSON.stringify(data)+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}}),latency:Date.now()-started};
      }
      return {response:Response.json(data),latency:Date.now()-started,data};
    }
    if(!/text\/event-stream/i.test(response.headers.get('Content-Type')||'')) {await response.body?.cancel();return {error:classify(415,'invalid response stream protocol'),http:415};}
    // Inspect the first data frame before forwarding any bytes. A 200 SSE error is not healthy.
    const reader=response.body.getReader(),chunks=[],decoder=new TextDecoder();let prefix='';
    while(prefix.length<8192) {
      const part=await reader.read();if(part.done)break;chunks.push(part.value);prefix+=decoder.decode(part.value,{stream:true});
      for(const frame of prefix.matchAll(/(?:^|\n)data:\s*(\{[^\n]*\})\r?\n/g)) {
        let data;try{data=JSON.parse(frame[1])}catch{continue;}
        if(data.error){await reader.cancel();return {error:classify(Number(data.error.code)||500,data.error.message||''),http:Number(data.error.code)||502};}
        if(data.choices?.some(c=>typeof c.delta?.content==='string'&&c.delta.content.trim()||c.delta?.tool_calls?.some(t=>t.function?.name))) {
          let finished=false,cancelled=false,pending='';const monitorDecoder=new TextDecoder();
          const monitor=bytes=>{pending+=monitorDecoder.decode(bytes,{stream:true});let end;while((end=pending.indexOf('\n'))>=0){const line=pending.slice(0,end).trim();pending=pending.slice(end+1);if(!line.startsWith('data:'))continue;const payload=line.slice(5).trim();if(payload==='[DONE]'){finished=true;continue;}if(!payload)continue;const value=JSON.parse(payload);if(value.error)throw Object.assign(Error('provider stream error'),{providerStatus:Number(value.error.code)||500,providerError:value.error.message||''});if(value.choices?.some(c=>c.finish_reason))finished=true;}if(pending.length>1048576)throw Error('provider frame too large');};
          const body=new ReadableStream({async pull(controller){try{const part=chunks.length?{value:chunks.shift(),done:false}:await reader.read();if(part.done){if(!finished&&!cancelled)throw Error('provider stream interrupted');if(!cancelled)await x.onStreamComplete?.();controller.close();}else{monitor(part.value);controller.enqueue(part.value);}}catch(e){if(!cancelled)try{await x.onStreamFailure?.(e.providerStatus?classify(e.providerStatus,e.providerError):classify(502,'provider stream interrupted'));}catch{/* Persistence cannot hide stream failure. */}controller.error(e);await reader.cancel().catch(()=>{});}},cancel(reason){cancelled=true;return reader.cancel(reason);}});
          return {response:new Response(body,{headers:response.headers}),latency:Date.now()-started};
        }
      }
    }
    await reader.cancel();return {error:classify(415,'invalid response stream protocol'),http:415};
  }catch(e){return {error:/capability:/i.test(e.message)?classify(400,'capability mismatch'):classify(0,'',e),http:e.name==='AbortError'?504:502,latency:Date.now()-started};}
  finally{clearTimeout(timer);}
}
// Bộ nhớ đường dẫn đã dò được, khoá theo URL chứ KHÔNG theo model: giao thức và đường dẫn là
// thuộc tính của máy chủ, không phải của model. Nhờ vậy 7 model cùng một URL chỉ dò MỘT lần thay
// vì 7 lần — và nếu URL sai thì cũng chỉ tốn một lượt dò thay vì bảy (đúng ca OpenCode vừa rồi).
const RESOLVED_ENDPOINTS=new Map();
const RESOLVED_TTL=10*60*1000;
function cachedOption(url){const hit=RESOLVED_ENDPOINTS.get(url);if(!hit)return null;if(Date.now()-hit.at>RESOLVED_TTL){RESOLVED_ENDPOINTS.delete(url);return null;}return hit.option;}
function rememberOption(url,option){RESOLVED_ENDPOINTS.set(url,{option,at:Date.now()});}
function forgetOption(url){RESOLVED_ENDPOINTS.delete(url);}
export function resetResolvedEndpoints(){RESOLVED_ENDPOINTS.clear();}
export async function resolveCall(x,body,endpoint,timeout=15000,retried=false) {
  const deadline=Date.now()+timeout;
  const cached=x.k.route?.resolved;
  const usable=cached&&cached.baseUrl===x.u.url&&cached.model===x.m.name&&cached.chatEndpoint===endpoint(x.u,'chat')?cached:null;
  const discovered=usable||cachedOption(x.u.url);
  const options=discovered?[discovered]:protocolOptions(x.u,endpoint);
  // Model hints only affect discovery order; successful wire validation is authoritative.
  if(!discovered&&/^(claude-|gemini-)/.test(x.m.name)){const hint=x.m.name.startsWith('claude-')?'anthropic':'gemini';options.sort((a,b)=>Number(b.protocol===hint)-Number(a.protocol===hint));}
  let last;
  for(const option of options) {
    if(Date.now()>=deadline)return {error:classify(0,'',{name:'TimeoutError'}),http:504};
    last=await providerCall(x,body,option,Math.max(1,deadline-Date.now()));
    if(last.response){rememberOption(x.u.url,option);return {...last,resolved:{...option,baseUrl:x.u.url,model:x.m.name,chatEndpoint:endpoint(x.u,'chat')}};}
    // Thử tiếp khi lỗi còn có thể do chọn SAI GIAO THỨC (404/405/415/lỗi chưa rõ). Dừng lại khi
    // lỗi thuộc về key/quota/model hoặc lỗi tạm thời — thử giao thức khác cũng vô ích.
    const keepProbing=['ENDPOINT_NOT_FOUND','PROTOCOL_MISMATCH','UNKNOWN_ERROR'].includes(last.error.errorClass)||(!discovered&&!last.error.confirmedCredential&&['INVALID_KEY','AUTH_ERROR'].includes(last.error.errorClass));
    if(!keepProbing)break;
  }
  // Đường dẫn đã nhớ bị hỏng (đổi máy chủ, đổi giao thức): quên đi rồi dò lại MỘT lần.
  if(!retried&&discovered&&Date.now()<deadline&&(['ENDPOINT_NOT_FOUND','PROTOCOL_MISMATCH'].includes(last?.error?.errorClass)||!last?.error?.confirmedCredential&&['INVALID_KEY','AUTH_ERROR'].includes(last?.error?.errorClass))){
    forgetOption(x.u.url);
    const cleared=usable?{...x,k:{...x.k,route:{...x.k.route,resolved:null}}}:x;
    return resolveCall(cleared,body,endpoint,Math.max(1,deadline-Date.now()),true);
  }
  if(last?.error?.errorClass==='ENDPOINT_NOT_FOUND'||last?.error?.errorClass==='PROTOCOL_MISMATCH')last.error={...last.error,errorClass:'PROTOCOL_UNSUPPORTED',label:'giao thức chưa hỗ trợ'};
  return last;
}
// A basic chat proof needs one real request, without optional API/capability probes.
export async function chatCheck(x,endpoint) {
  const result=await resolveCall(x,{messages:[{role:'user',content:'Reply OK.'}],max_tokens:64,stream:false},endpoint,8000);
  if(!result.response)return {...result.error,latency:result.latency};
  return {status:'ok',label:'chat đã xác minh',retryAt:0,capabilities:{...x.k.route?.capabilities,chat:true},resolved:result.resolved,protocol:result.resolved.protocol,latency:result.latency,confirmed:true};
}
export async function deepCheck(x,endpoint,{tools=true,vision=false,structured=false}={}) {
  const steps=[],capabilities={chat:false},deadline=Date.now()+24000;
  const timeout=()=>Math.max(1,Math.min(8000,deadline-Date.now()));
  const headers={Authorization:'Bearer '+x.k.secret};
  const get=async(kind)=>{try{const r=await fetch(endpoint(x.u,kind),{headers,redirect:'manual',signal:AbortSignal.timeout(timeout())});const data=await r.json().catch(()=>null);return {http:r.status,data};}catch(e){return {error:classify(0,'',e)}}};
  if(new URL(x.u.url).hostname==='openrouter.ai') {
    const key=await get('key');steps.push({name:'authentication',http:key.http,errorClass:key.error?.errorClass});
    if([401,403,402].includes(key.http))return {...classify(key.http),failureScope:'credential',steps,capabilities};
    if(key.data?.data?.expires_at&&Date.parse(key.data.data.expires_at)<=Date.now())return {...classify(401,'expired key'),steps,capabilities};
  }
  const models=await get('models'),list=models.data?.data;
  steps.push({name:'base-url',pass:!!models.http});
  steps.push({name:'models',http:models.http,modelListed:Array.isArray(list)?list.some(m=>m.id===x.m.name):null});
  const metadata=Array.isArray(list)?list.find(m=>m.id===x.m.name):null;
  if(metadata?.architecture?.input_modalities)capabilities.vision=metadata.architecture.input_modalities.includes('image');
  if(Array.isArray(metadata?.supported_parameters)) {
    capabilities.reasoning=metadata.supported_parameters.some(p=>p==='reasoning'||p==='reasoning_effort');
    capabilities.structured=metadata.supported_parameters.includes('response_format');
  }
  const body={messages:[{role:'user',content:'Reply OK.'}],max_tokens:128,stream:false};
  let result,failures=0;
  for(let n=0;n<3&&Date.now()<deadline;n++) {
    result=await resolveCall(x,body,endpoint,timeout());steps.push({name:'chat',http:result.response?200:result.http,errorClass:result.error?.errorClass});
    if(result.response)break;
    failures++;
    if(!['TIMEOUT','NETWORK_ERROR','PROVIDER_ERROR'].includes(result.error.errorClass)||failures>=2)break;
  }
  if(!result?.response)return {...(result?.error||classify(0,'',{name:'TimeoutError'})),failureEvents:failures||1,steps,capabilities,latency:result?.latency};
  steps.push({name:'response-format',pass:!!result.data?.choices?.[0]?.message});
  capabilities.chat=true;capabilities.nativeStream=!['responses','ollama','cohere','azure','opencode-go'].includes(result.resolved.protocol);
  if(Date.now()<deadline) {
    const streamed=await providerCall(x,{...body,stream:true},result.resolved,timeout());
    capabilities.stream=!!streamed.response;
    if(streamed.response){
      const reader=streamed.response.body.getReader(),decoder=new TextDecoder();let text='',timer;
      try {
        const probe=(async()=>{while(text.length<65536){const r=await reader.read();if(r.done)return /\[DONE\]|"finish_reason"\s*:\s*"(?:stop|tool_calls|length)"/.test(text);text+=decoder.decode(r.value);}return false;})().catch(()=>false);
        capabilities.stream=await Promise.race([probe,new Promise(resolve=>{timer=setTimeout(()=>{reader.cancel().catch(()=>{});resolve(false)},timeout());})]);
      }finally{clearTimeout(timer);await reader.cancel().catch(()=>{});}
    }
    steps.push({name:'stream',pass:capabilities.stream,errorClass:streamed.error?.errorClass});
  }
  if(tools&&Date.now()<deadline) {
    const tool=await providerCall(x,{...body,max_tokens:64,tools:[{type:'function',function:{name:'health_ping',description:'Connectivity check',parameters:{type:'object',properties:{},additionalProperties:false}}}],tool_choice:{type:'function',function:{name:'health_ping'}}},result.resolved,timeout());
    if(!tool.error||tool.error.errorClass==='CAPABILITY_MISMATCH')capabilities.tools=!!tool.data?.choices?.[0]?.message?.tool_calls?.some(t=>{if(t.function?.name!=='health_ping')return false;try{const args=JSON.parse(t.function.arguments);return args&&typeof args==='object'&&!Array.isArray(args)&&Object.keys(args).length===0;}catch{return false;}});
    steps.push({name:'tools',pass:capabilities.tools,errorClass:tool.error?.errorClass});
  }
  if(vision&&Date.now()<deadline){const probe=await providerCall(x,{...body,messages:[{role:'user',content:[{type:'text',text:'Reply OK.'},{type:'image_url',image_url:{url:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1cAAAAASUVORK5CYII='}}]}]},result.resolved,timeout());capabilities.vision=!!probe.response;steps.push({name:'vision',pass:capabilities.vision,errorClass:probe.error?.errorClass});}
  if(structured&&Date.now()<deadline){const probe=await providerCall(x,{...body,messages:[{role:'user',content:'Return JSON with ok true.'}],response_format:{type:'json_schema',json_schema:{name:'health',strict:true,schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false}}}},result.resolved,timeout());capabilities.structured=!!probe.response&&JSON.parse(probe.data.choices[0].message.content).ok===true;steps.push({name:'structured',pass:capabilities.structured,errorClass:probe.error?.errorClass});}
  return {status:'ok',label:'chat đã xác minh',retryAt:0,steps,capabilities,resolved:result.resolved,protocol:result.resolved.protocol,latency:result.latency,confirmed:true};
}
