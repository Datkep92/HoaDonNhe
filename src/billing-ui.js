'use strict';
(() => {
  let state, quote, active=false, lastInteraction=Date.now(), lastBeat=Date.now();
  const api=async(action,body)=>{const r=await fetch('/api/billing/'+action,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});const j=await r.json();if(!j.ok)throw Error(j.error);return j.value;};
  const host=document.createElement('section');host.hidden=true;host.id='billing-panel';
  host.innerHTML='<h3>Chọn gói sử dụng</h3><p>Các thiết bị dùng chung danh sách MST; dữ liệu vẫn lưu riêng trên mỗi máy.</p><div class="settings-form"><label>Số MST<input id="billing-mst" type="number" min="1" max="50" value="10"></label><label>Số thiết bị<input id="billing-devices" type="number" min="1" max="10" value="1"></label><label>Kỳ thanh toán<select id="billing-term"><option value="month">Tháng</option><option value="quarter">Quý · giảm 5%</option><option value="year">Năm · trả 10 tháng</option></select></label></div><label><input id="billing-upgrade" type="checkbox"> Nâng gói hiện tại, giữ ngày hết hạn</label><p id="billing-price" aria-live="polite"></p><button id="billing-quote" type="button">Xem báo giá</button> <button id="billing-order" type="button" disabled>Gửi yêu cầu mua gói</button><p id="billing-message" role="status"></p><div id="billing-orders"></div>';
  document.getElementById('settings-license')?.append(host);
  const q=id=>document.getElementById(id), money=n=>Number(n).toLocaleString('vi-VN')+'đ';
  const invalidate=()=>{quote=null;q('billing-order').disabled=true;q('billing-price').textContent='Bấm Xem báo giá để lấy giá hiện tại.';};
  ['billing-mst','billing-devices','billing-term','billing-upgrade'].forEach(id=>q(id).addEventListener('change',invalidate));
  q('billing-quote').onclick=async()=>{
    invalidate();q('billing-quote').disabled=true;
    try{const result=await api('quote',{mst:Number(q('billing-mst').value),devices:Number(q('billing-devices').value),term:q('billing-term').value,upgrade:q('billing-upgrade').checked});quote=result;const v=result.quote;q('billing-price').textContent=v.planId+' · tối đa '+v.maxMst+' MST · '+v.devices+' thiết bị · Tổng '+money(v.total)+(v.upgrade?' (phí nâng cấp)': ' · giảm '+money(v.discount));q('billing-order').disabled=false;}
    catch(e){q('billing-message').textContent=e.message;}finally{q('billing-quote').disabled=false;}
  };
  q('billing-order').onclick=async()=>{
    if(!quote)return;q('billing-order').disabled=true;
    try{const v=await api('order',{quoteId:quote.quoteId});q('billing-message').textContent='Đã gửi '+v.id+'. Admin sẽ xác nhận thanh toán trước khi cấp quyền.';quote=null;await orders();}
    catch(e){q('billing-message').textContent=e.message;}
  };
  async function orders(){try{const items=await api('orders',{});q('billing-orders').replaceChildren();for(const o of items){const p=document.createElement('p');p.textContent=o.id+' · '+o.quote.planId+' · '+money(o.quote.total)+' · '+({pending:'Chờ xác nhận',approved:'Đã cấp',cancelled:'Đã hủy',rejected:'Từ chối'}[o.status]||o.status);if(o.status==='pending'){const b=document.createElement('button');b.textContent='Hủy yêu cầu';b.onclick=async()=>{try{await api('cancel',{orderId:o.id});await orders();}catch(e){q('billing-message').textContent=e.message;}};p.append(b);}q('billing-orders').append(p);}}catch(e){q('billing-message').textContent=e.message;}}
  async function refresh(){try{state=await api('status');host.hidden=!state.commercial;active=state.commercial;if(active&&q('settings-dialog').open)await orders();}catch{}}
  ['pointerdown','keydown'].forEach(type=>window.addEventListener(type,()=>{lastInteraction=Date.now();},{passive:true}));
  setInterval(()=>{const now=Date.now(), seconds=Math.min(60,Math.floor((now-lastBeat)/1000));lastBeat=now;if(document.visibilityState==='visible'&&document.hasFocus()&&now-lastInteraction<60000){const feature=window.HD_DATA_VIEW?.current||q('view-title')?.textContent||'app';api('activity',{feature,seconds}).catch(()=>{});}},30000);
  q('settings-dialog')?.addEventListener('toggle',()=>{if(q('settings-dialog').open)void refresh();});
  void refresh();setInterval(refresh,60000);
})();
