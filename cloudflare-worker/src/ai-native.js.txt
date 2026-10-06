// Native provider adapters. Keys remain in headers, never in URLs or diagnostics.
function image(url, protocol) {
  const match = /^data:([^;]+);base64,(.+)$/.exec(url || '');
  if (match) return protocol === 'anthropic'
    ? { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } }
    : { inlineData: { mimeType: match[1], data: match[2] } };
  if (protocol === 'anthropic' && /^https:\/\//.test(url || '')) return { type: 'image', source: { type: 'url', url } };
  throw Error('capability: native image requires a data URL');
}
function content(value, protocol) {
  return (Array.isArray(value) ? value : [{ type: 'text', text: String(value ?? '') }]).map(p => p.type === 'image_url'
    ? image(p.image_url?.url, protocol) : protocol === 'anthropic' ? { type: 'text', text: p.text || '' } : { text: p.text || '' });
}
export function nativeBody(body, protocol) {
  const systems = (body.messages || []).filter(m => ['system','developer'].includes(m.role)).map(m => typeof m.content === 'string' ? m.content : (m.content || []).map(p=>p.text||'').join('\n')).join('\n');
  const messages = (body.messages || []).filter(m => !['system','developer'].includes(m.role));
  if (protocol === 'anthropic') {
    const rows=[];
    for (const m of messages) {
      const role=m.role==='assistant'?'assistant':'user';
      const parts=m.role==='tool'?[{type:'tool_result',tool_use_id:m.tool_call_id,content:String(m.content)}]:content(m.content,protocol).filter(p=>p.type!=='text'||p.text);
      for(const t of m.tool_calls||[])parts.push({type:'tool_use',id:t.id,name:t.function.name,input:JSON.parse(t.function.arguments||'{}')});
      if (!parts.length) continue;
      if(rows.at(-1)?.role===role)rows.at(-1).content.push(...parts);else rows.push({role,content:parts});
    }
    const out={model:body.model,messages:rows,max_tokens:body.max_tokens||body.max_completion_tokens||4096,stream:!!body.stream};
    if(systems)out.system=systems;
    if(body.tools?.length)out.tools=body.tools.map(t=>({name:t.function.name,description:t.function.description||'',input_schema:t.function.parameters}));
    if(body.tool_choice)out.tool_choice=typeof body.tool_choice==='object'?{type:'tool',name:body.tool_choice.function.name}:{type:body.tool_choice==='required'?'any':body.tool_choice==='none'?'none':'auto'};
    if(body.response_format?.type==='json_schema')out.output_config={format:{type:'json_schema',schema:body.response_format.json_schema.schema}};
    return out;
  }
  const names=new Map();const rows=[];
  for(const m of messages) {
    const originalCall=names.get(m.tool_call_id);
    const parts=m.role==='tool'?[{functionResponse:{name:originalCall?.name||m.name||'tool',...(originalCall?.id?{id:originalCall.id}:{}),response:{result:String(m.content)}}}]:content(m.content,protocol).filter(p=>!Object.hasOwn(p,'text')||p.text);
    for(const [i,t] of (m.tool_calls||[]).entries()) {const original=m.providerParts?.filter(p=>p.functionCall)[i]?.functionCall;names.set(t.id,{name:t.function.name,id:m.providerParts?original?.id:t.id});parts.push({functionCall:{name:t.function.name,args:JSON.parse(t.function.arguments||'{}'),id:t.id}});}
    if(m.providerParts)parts.splice(0,parts.length,...m.providerParts);
    if(parts.length){const role=m.role==='assistant'?'model':'user';if(rows.at(-1)?.role===role)rows.at(-1).parts.push(...parts);else rows.push({role,parts});}
  }
  const out={contents:rows,generationConfig:{maxOutputTokens:body.max_tokens||body.max_completion_tokens||4096}};
  if(systems)out.systemInstruction={parts:[{text:systems}]};
  if(body.tools?.length)out.tools=[{functionDeclarations:body.tools.map(t=>({name:t.function.name,description:t.function.description||'',parametersJsonSchema:t.function.parameters}))}];
  if(body.tool_choice)out.toolConfig={functionCallingConfig:{mode:typeof body.tool_choice==='object'||body.tool_choice==='required'?'ANY':body.tool_choice==='none'?'NONE':'AUTO',...(typeof body.tool_choice==='object'?{allowedFunctionNames:[body.tool_choice.function.name]}:{})}};
  if(body.response_format)Object.assign(out.generationConfig,{responseMimeType:'application/json',...(body.response_format.json_schema?{responseJsonSchema:body.response_format.json_schema.schema}:{})});
  return out;
}
export function nativeChat(data, protocol) {
  const parts=protocol==='anthropic'?data.content:data.candidates?.[0]?.content?.parts;
  if(!Array.isArray(parts))throw Error('invalid response protocol');
  const text=parts.filter(p=>protocol==='anthropic'?p.type==='text':typeof p.text==='string'&&!p.thought).map(p=>p.text).join('');
  const calls=parts.filter(p=>protocol==='anthropic'?p.type==='tool_use':p.functionCall).map((p,i)=>{
    const f=p.functionCall||p;return {id:f.id||'native-'+i,type:'function',function:{name:f.name,arguments:JSON.stringify(f.args||f.input||{})}};
  });
  return {id:data.id,model:data.model||data.modelVersion,choices:[{index:0,message:{role:'assistant',content:text,...(calls.length?{tool_calls:calls}:{}),...(protocol==='gemini'?{providerParts:parts}:{})},finish_reason:protocol==='anthropic'&&data.stop_reason==='max_tokens'||data.candidates?.[0]?.finishReason==='MAX_TOKENS'?'length':calls.length?'tool_calls':'stop'}],usage:data.usage||data.usageMetadata};
}
// Incremental SSE → canonical OpenAI chunks, preserving completion boundaries.
export function nativeStream(response, protocol) {
  const reader=response.body.getReader(),decoder=new TextDecoder(),encoder=new TextEncoder();
  let pending='',ended=false,tool=false;const indices=new Map(),emptyArguments=new Set();
  return new Response(new ReadableStream({async start(controller) {
    const emit=(delta,finish=null)=>controller.enqueue(encoder.encode('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:finish}]})+'\n\n'));
    const frame=raw=>{
      const lines=raw.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trim());if(!lines.length)return;
      const data=JSON.parse(lines.join('\n'));if(data.error)throw Object.assign(Error('provider stream error'),{providerStatus:Number(data.error.code)||500,providerError:data.error.type||data.error.message||''});
      if(protocol==='anthropic') {
        if(data.type==='content_block_start'&&data.content_block?.type==='tool_use') {tool=true;const i=indices.size;indices.set(data.index,i);if(!Object.keys(data.content_block.input||{}).length)emptyArguments.add(data.index);emit({tool_calls:[{index:i,id:data.content_block.id,type:'function',function:{name:data.content_block.name,arguments:Object.keys(data.content_block.input||{}).length?JSON.stringify(data.content_block.input):''}}]});}
        if(data.type==='content_block_start'&&data.content_block?.type==='text'&&data.content_block.text)emit({content:data.content_block.text});
        if(data.type==='content_block_delta') {
          if(data.delta?.type==='text_delta')emit({content:data.delta.text});
          if(data.delta?.type==='input_json_delta'){emptyArguments.delete(data.index);emit({tool_calls:[{index:indices.get(data.index),function:{arguments:data.delta.partial_json}}]});}
        }
        if(data.type==='content_block_stop'&&emptyArguments.delete(data.index))emit({tool_calls:[{index:indices.get(data.index),function:{arguments:'{}'}}]});
        if(data.type==='message_delta'&&data.delta?.stop_reason)emit({},data.delta.stop_reason==='max_tokens'?'length':tool?'tool_calls':'stop');
        if(data.type==='message_stop')ended=true;
      } else {
        const c=data.candidates?.[0];for(const p of c?.content?.parts||[]) {
          emit({providerParts:[p]});
          if(typeof p.text==='string'&&!p.thought)emit({content:p.text});
          if(p.functionCall){tool=true;const f=p.functionCall;emit({tool_calls:[{index:indices.size,id:f.id||'gemini-'+indices.size,type:'function',function:{name:f.name,arguments:JSON.stringify(f.args||{})}}]});indices.set(indices.size,indices.size);}
        }
        if(c?.finishReason){emit({},c.finishReason==='MAX_TOKENS'?'length':tool?'tool_calls':'stop');ended=true;}
      }
    };
    try {
      while(true){const part=await reader.read();pending+=part.done?decoder.decode():decoder.decode(part.value,{stream:true});let match;while((match=/\r?\n\r?\n/.exec(pending))){const raw=pending.slice(0,match.index);pending=pending.slice(match.index+match[0].length);frame(raw);}if(pending.length>1048576)throw Error('provider frame too large');if(part.done)break;}
      if(pending.trim())frame(pending);if(!ended)throw Error('provider stream interrupted');
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));controller.close();
    }catch(e){controller.error(e);}finally{await reader.cancel().catch(()=>{});}
  },cancel(reason){return reader.cancel(reason);}}),{headers:{'Content-Type':'text/event-stream'}});
}
