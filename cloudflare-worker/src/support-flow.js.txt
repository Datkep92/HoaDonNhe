// Shared support ownership. Only an authenticated Telegram admin can release a room.
export function needsAdmin(text) {
  return /(?:admin|quản trị|nhân viên|hỗ trợ viên|người thật|bản quyền|license|licence|kích hoạt|gia hạn|\bkey\b|khóa ứng dụng)/iu.test(String(text));
}
export function createSupportFlow({ read, write, post, send }) {
  const base = room => '/chats/' + encodeURIComponent(room);
  const notice = 'Đã chuyển yêu cầu tới admin. Admin sẽ liên hệ lại với bạn.';
  async function change(env, room, fn) {
    for (let i=0;i<16;i++) {
      const old=await read(env,base(room)+'/control');
      const next=fn(old.value||{mode:'auto',revision:0});
      if(await write(env,base(room)+'/control',next,old.etag))return next;
    }
    throw Error('Không cập nhật được phiên hỗ trợ. Hãy thử lại.');
  }
  async function state(env,room) { return {mode:'auto',revision:0,...((await read(env,base(room)+'/control')).value||{})}; }
  async function owner(env,room,mode,actor) {
    if((await state(env,room)).mode===mode)return state(env,room);
    const value=await change(env,room,c=>({...c,mode,revision:(c.revision||0)+1,updatedAt:Date.now(),actor}));
    await post(env,base(room)+'/messages',{sender:'system',text:mode==='auto'?'Admin đã kết thúc hỗ trợ. AI tiếp tục hoạt động.':'Admin đang hỗ trợ bạn. AI đã tạm dừng.',controlMode:mode,controlRevision:value.revision,timestamp:Date.now(),source:'telegram'});
    return value;
  }
  async function begin(env,room,text,extra={}) {
    if(!text||text.length>16000)throw Error('Tin nhắn không hợp lệ.');
    // APP quyết định có cần người thật hay không (người dùng tự chọn "Đợi admin/support"),
    // Gateway chỉ ghi nhận. Trước đây Gateway tự đoán bằng từ khoá nên khách hỏi một câu
    // về bản quyền là bị đẩy sang admin mà không được hỏi ý — và phải /stop thủ công mới về.
    let control=await state(env,room);
    if(extra.wantsAdmin===true)control=await change(env,room,c=>({...c,mode:c.mode==='admin'?'admin':'waiting',revision:(c.revision||0)+1,updatedAt:Date.now()}));
    const message={sender:'user',text,timestamp:Date.now(),source:'desktop',unified:true,deliveryStatus:'pending_telegram',...extra};
    delete message.wantsAdmin;
    const saved=await post(env,base(room)+'/messages',message);
    // Ordinary AI chat stays in the EXE/Firebase room. Only human support goes to Telegram.
    let forwarded=control.mode!=='auto';
    if(forwarded)await send(env,room,text+(extra.attachments?.length?'\n📎 '+extra.attachments.join(', '):''));
    // Admin may have replied during Telegram delivery; never rely on the earlier snapshot.
    control=await state(env,room);
    if(control.mode!=='auto'&&!forwarded)await send(env,room,text+(extra.attachments?.length?'\n📎 '+extra.attachments.join(', '):''));
    if(control.mode==='waiting')await post(env,base(room)+'/messages',{sender:'assistant',text:notice,timestamp:Date.now(),source:'handoff',controlMode:'waiting',controlRevision:control.revision,unified:true});
    return {id:saved.name,...message,control,aiAllowed:control.mode==='auto',reply:control.mode==='waiting'?notice:control.mode==='admin'?'Admin đang hỗ trợ bạn.':null};
  }
  async function complete(env,room,id,revision,text) {
    const control=await state(env,room);
    if(control.mode!=='auto'||control.revision!==revision)return {accepted:false,control};
    // Deterministic message key makes completion idempotent across a lost response/retry.
    if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id))throw Error('Invalid support turn.');
    await post(env,base(room)+'/messages/ai_'+id,{sender:'assistant',text:String(text).slice(0,32000),timestamp:Date.now(),source:'ai',unified:true,controlRevision:revision},'PUT');
    const after=await state(env,room);
    if(after.mode!=='auto'||after.revision!==revision){await post(env,base(room)+'/messages/ai_'+id,null,'DELETE');return {accepted:false,control:after};}
    return {accepted:true,control};
  }
  return {state,owner,begin,complete};
}
