'use strict';
// Portable rules shared by Node, Apps Script and the gateway.
function BillingCore() {
  const defaults = [
    { id: 'MST10', maxMst: 10, price: 50000 }, { id: 'MST20', maxMst: 20, price: 90000 },
    { id: 'MST30', maxMst: 30, price: 120000 }, { id: 'MST50', maxMst: 50, price: 150000 },
  ];
  function integer(value, min, max) {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error('Số lượng không hợp lệ.');
    return n;
  }
  function quote(input, plans = defaults) {
    const mst = integer(input.mst, 1, 50), devices = integer(input.devices, 1, 10);
    const term = String(input.term || 'month');
    if (!['month', 'quarter', 'year'].includes(term)) throw new Error('Kỳ thanh toán không hợp lệ.');
    const plan = plans.slice().sort((a,b) => a.maxMst-b.maxMst).find(p => p.maxMst >= mst);
    if (!plan || !Number.isFinite(Number(plan.price)) || Number(plan.price) < 0) throw new Error('Chưa có báo giá phù hợp.');
    const months = { month: 1, quarter: 3, year: 12 }[term];
    const monthly = Number(plan.price) * (1 + (devices - 1) * .5);
    const original = Math.round(monthly * months);
    const total = Math.round(monthly * ({ month: 1, quarter: 2.85, year: 10 }[term]));
    return { planId: plan.id, maxMst: plan.maxMst, requestedMst: mst, devices, term, months, monthly, original, discount: original-total, total, currency: 'VND' };
  }
  function addMonths(instant, months) {
    const vn = new Date(Number(new Date(instant)) + 7*3600000);
    if (!Number.isFinite(vn.getTime())) throw new Error('Ngày không hợp lệ.');
    const day = vn.getUTCDate(); vn.setUTCDate(1); vn.setUTCMonth(vn.getUTCMonth()+months);
    const last = new Date(Date.UTC(vn.getUTCFullYear(),vn.getUTCMonth()+1,0)).getUTCDate();
    vn.setUTCDate(Math.min(day,last));
    return new Date(vn.getTime()-7*3600000).toISOString();
  }
  function upgrade(current, next, time) {
    const start = Number(new Date(current.periodStart)), end = Number(new Date(current.expiryAt));
    if (!(end > time && end > start) || current.term !== next.term) throw new Error('Chỉ nâng cùng kỳ khi key còn hạn.');
    if (next.maxMst < current.maxMst || next.devices < current.devices) throw new Error('Hạ gói áp dụng khi gia hạn.');
    return Math.max(0,Math.round((next.total-current.periodPrice)*(end-time)/(end-start)));
  }
  const day = time => new Date(time+7*3600000).toISOString().slice(0,10);
  const month = time => day(time).slice(0,7);
  return { defaults, quote, upgrade, addMonths, day, month, integer };
}
module.exports = { BillingCore, ...BillingCore() };
