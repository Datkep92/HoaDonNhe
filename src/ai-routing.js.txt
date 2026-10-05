// Provider-neutral routing helpers. No provider secrets are included in diagnostics.
export function classify(status = 0, detail = '', error) {
  const text = String(detail).toLowerCase();
  let errorClass = 'UNKNOWN_ERROR', cooldown = 30000;
  if (error) errorClass = /abort|timeout/i.test(error.name || '') ? 'TIMEOUT' : 'NETWORK_ERROR';
  else if (/expired.*key|key.*expired/.test(text)) { errorClass = 'EXPIRED_KEY'; cooldown = 86400000; }
  else if (status === 401 || /invalid[_ ](?:api[_ ])?key/.test(text)) { errorClass = 'INVALID_KEY'; cooldown = 86400000; }
  else if (status === 403) { errorClass = 'AUTH_ERROR'; cooldown = 300000; }
  else if (status === 402 || /insufficient|quota|credit|balance/.test(text)) { errorClass = 'QUOTA_EXCEEDED'; cooldown = 900000; }
  else if (status === 429) { errorClass = 'RATE_LIMIT'; cooldown = 60000; }
  else if (/model.*(?:not found|unavailable|invalid|disabled)|invalid.*model|not a valid model|invalid_model|no endpoints found for/.test(text)) { errorClass = 'MODEL_NOT_FOUND'; cooldown = 300000; }
  else if (/support.*(?:tool|vision|image)|capability/.test(text)) { errorClass = 'CAPABILITY_MISMATCH'; cooldown = 300000; }
  else if (status === 404 || [301,302,307,308].includes(status)) { errorClass = 'ENDPOINT_NOT_FOUND'; cooldown = 300000; }
  else if (status === 415 || /protocol|invalid response|json|html/.test(text)) { errorClass = 'PROTOCOL_MISMATCH'; cooldown = 300000; }
  else if (status >= 500) errorClass = 'PROVIDER_ERROR';
  const labels = {AUTH_ERROR:'không có quyền',INVALID_KEY:'key không hợp lệ',EXPIRED_KEY:'key hết hạn',QUOTA_EXCEEDED:'hết quota',RATE_LIMIT:'giới hạn tốc độ',MODEL_NOT_FOUND:'model không tồn tại',ENDPOINT_NOT_FOUND:'endpoint không đúng',PROTOCOL_MISMATCH:'giao thức không tương thích',PROVIDER_ERROR:'nhà cung cấp lỗi',NETWORK_ERROR:'lỗi mạng',TIMEOUT:'quá thời gian chờ',CAPABILITY_MISMATCH:'thiếu khả năng yêu cầu',UNKNOWN_ERROR:'lỗi chưa xác định'};
  return {errorClass,label:labels[errorClass],retryAt:Date.now()+cooldown,status:['AUTH_ERROR','INVALID_KEY','EXPIRED_KEY'].includes(errorClass)?'auth':['QUOTA_EXCEEDED','RATE_LIMIT'].includes(errorClass)?'quota':'error'};
}
export function configurationId(x) { return [x.u.id,x.m.id,x.k.id].join('.'); }
export function requiredCapabilities(body) {
  return {chat:true, stream:body.stream===true, tools:!!body.tools?.length, vision:(body.messages||[]).some(m=>Array.isArray(m.content)&&m.content.some(p=>p.type==='image_url')), structured:body.response_format?.type==='json_schema'};
}
export function compatible(route, required) { if(route?.status&&route.status!=='ok')return true;return !Object.entries(required).some(([k,v])=>v&&route?.capabilities?.[k]===false); }
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
  const base=u.url.replace(/\/(?:chat\/completions|responses|models|key)\/?$/,'').replace(/\/$/,'');
  const chat=endpoint(u,'chat');
  const options=[{protocol:chat.endsWith('/responses')?'responses':'chat',endpoint:chat}];
  // An explicit endpoint is authoritative; do not probe paths the admin did not request.
  if (!u.endpoints?.chat) {
    if(!/\/v1$/.test(base))options.push({protocol:'chat',endpoint:base+'/v1/chat/completions'});
    options.push({protocol:'responses',endpoint:base+'/responses'});
    if(!/\/v1$/.test(base))options.push({protocol:'responses',endpoint:base+'/v1/responses'});
  }
  return options.filter((x,i,a)=>a.findIndex(y=>y.endpoint===x.endpoint)===i);
}
export function responsesBody(body) {
  const input=[];
  for(const m of body.messages||[]) {
    if(m.role==='tool') {input.push({type:'function_call_output',call_id:m.tool_call_id,output:String(m.content)});continue;}
    if(m.content!=null)input.push({role:m.role,content:Array.isArray(m.content)?m.content.map(p=>p.type==='image_url'?{type:'input_image',image_url:p.image_url?.url}: {type:m.role==='assistant'?'output_text':'input_text',text:p.text||''}):String(m.content)});
    for(const t of m.tool_calls||[])input.push({type:'function_call',call_id:t.id,name:t.function.name,arguments:t.function.arguments});
  }
  return {model:body.model,input,stream:false,max_output_tokens:body.max_tokens||body.max_completion_tokens||256,...(body.tools?{tools:body.tools.map(t=>({type:'function',...t.function}))}:{}),...(body.tool_choice?{tool_choice:typeof body.tool_choice==='object'?{type:'function',name:body.tool_choice.function.name}:body.tool_choice}:{}),...(body.response_format?{text:{format:body.response_format}}:{})};
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
    const response=await fetch(option.endpoint,{method:'POST',redirect:'manual',signal:controller.signal,headers:{'Content-Type':'application/json',Authorization:'Bearer '+x.k.secret},body:JSON.stringify(option.protocol==='responses'?responsesBody({...body,model:x.m.name}):{...body,model:x.m.name})});
    if(!response.ok) return {error:classify(response.status,await response.text()),http:response.status,latency:Date.now()-started};
    if(option.protocol==='responses'||!body.stream) {
      let data;try{data=await response.json()}catch{return {error:classify(415,'invalid response json'),http:415};}
      if(option.protocol==='responses') {try{data=responsesChat(data)}catch{return {error:classify(415,'invalid response protocol'),http:415};}}
      if(data.error||!data.choices?.[0]?.message)return {error:classify(data.error?.code||415,data.error?.message||'invalid response protocol'),http:415};
      const message=data.choices[0].message;
      if(!String(message.content||'').trim()&&!message.tool_calls?.length)return {error:classify(502,'empty completion'),http:502};
      if(body.response_format?.type?.startsWith('json'))try{JSON.parse(data.choices[0].message.content)}catch{return {error:classify(415,'invalid response json format'),http:415};}
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
      const frame=prefix.match(/(?:^|\n)data:\s*(\{[^\n]*\})\r?\n/);
      if(frame) {
        let data;try{data=JSON.parse(frame[1])}catch{continue;}
        if(data.error){await reader.cancel();return {error:classify(Number(data.error.code)||500,data.error.message||''),http:Number(data.error.code)||502};}
        if(Array.isArray(data.choices)) {
          const body=new ReadableStream({async pull(controller){if(chunks.length){controller.enqueue(chunks.shift());return;}try{const part=await reader.read();if(part.done)controller.close();else controller.enqueue(part.value);}catch(e){controller.error(e);}},cancel:reason=>reader.cancel(reason)});
          return {response:new Response(body,{headers:response.headers}),latency:Date.now()-started};
        }
      }
    }
    await reader.cancel();return {error:classify(415,'invalid response stream protocol'),http:415};
  }catch(e){return {error:classify(0,'',e),http:e.name==='AbortError'?504:502,latency:Date.now()-started};}
  finally{clearTimeout(timer);}
}
export async function resolveCall(x,body,endpoint,timeout=15000) {
  const deadline=Date.now()+timeout;
  const cached=x.k.route?.resolved;
  const options=cached&&cached.baseUrl===x.u.url&&cached.model===x.m.name&&cached.chatEndpoint===endpoint(x.u,'chat')?[cached]:protocolOptions(x.u,endpoint);
  let last;
  for(const option of options) {
    if(Date.now()>=deadline)return {error:classify(0,'',{name:'TimeoutError'}),http:504};
    last=await providerCall(x,body,option,Math.max(1,deadline-Date.now()));
    if(last.response)return {...last,resolved:{...option,baseUrl:x.u.url,model:x.m.name,chatEndpoint:endpoint(x.u,'chat')}};
    if(!['ENDPOINT_NOT_FOUND','PROTOCOL_MISMATCH'].includes(last.error.errorClass))break;
  }
  // If a cached endpoint disappeared, invalidate it once and discover again.
  if(cached&&Date.now()<deadline&&['ENDPOINT_NOT_FOUND','PROTOCOL_MISMATCH'].includes(last.error.errorClass))return resolveCall({...x,k:{...x.k,route:{...x.k.route,resolved:null}}},body,endpoint,Math.max(1,deadline-Date.now()));
  return last;
}
export async function deepCheck(x,endpoint,{tools=true}={}) {
  const steps=[],capabilities={chat:false},deadline=Date.now()+24000;
  const timeout=()=>Math.max(1,Math.min(8000,deadline-Date.now()));
  const headers={Authorization:'Bearer '+x.k.secret};
  const get=async(kind)=>{try{const r=await fetch(endpoint(x.u,kind),{headers,redirect:'manual',signal:AbortSignal.timeout(timeout())});const data=await r.json().catch(()=>null);return {http:r.status,data};}catch(e){return {error:classify(0,'',e)}}};
  if(new URL(x.u.url).hostname==='openrouter.ai') {
    const key=await get('key');steps.push({name:'authentication',http:key.http,errorClass:key.error?.errorClass});
    if([401,403,402].includes(key.http))return {...classify(key.http),steps,capabilities};
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
  capabilities.chat=true;capabilities.nativeStream=result.resolved.protocol==='chat';
  if(Date.now()<deadline) {
    const streamed=await providerCall(x,{...body,stream:true},result.resolved,timeout());
    capabilities.stream=!!streamed.response;
    if(streamed.response){
      const reader=streamed.response.body.getReader(),decoder=new TextDecoder();let text='',timer;
      try {
        const probe=(async()=>{while(text.length<8192){const r=await reader.read();if(r.done)break;text+=decoder.decode(r.value);if(/data:\s*\{[^\n]*"choices"/.test(text))return true;}return false;})();
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
  return {status:'ok',label:'chat đã xác minh',retryAt:0,steps,capabilities,resolved:result.resolved,protocol:result.resolved.protocol,latency:result.latency,confirmed:true};
}
