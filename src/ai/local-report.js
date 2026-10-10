'use strict';
const normalize = v => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/\s+/g, ' ').trim();
function summaryReport(data, args, context, request) {
  const selected = data.sourceMst || context.readCompanyId || context.currentUser?.selectedMst;
  const company = data.company || context.accounts?.find(a => a.mst === selected)?.label || '';
  const aliases = context.accounts?.find(a => a.mst === selected)?.aliases || [];
  const asked = normalize(request).match(/\bcua\s+(.+?)(?=[.,;!?]|$)/)?.[1]?.trim();
  if (asked && !['toi', 'cong ty dang chon', 'doanh nghiep dang chon'].includes(asked) && normalize(selected) !== asked && !aliases.some(a => normalize(a) === asked) && (!company || !normalize(company).includes(asked))) {
    return 'Nguồn đọc: ' + (company || 'MST/mã hồ sơ ' + selected) + '. Chưa xác minh đây là công ty bạn vừa nêu. Bạn cho biết MST/tên chính xác hoặc file kế toán local cần dùng nhé; tôi chưa trả số liệu để tránh báo cáo nhầm.';
  }
  const number = key => Number.isFinite(data[key]) ? data[key].toLocaleString('vi-VN') : 'Chưa có dữ liệu';
  return ['Báo cáo hóa đơn từ kho local: ' + (aliases.length && (!company || company === selected) ? aliases.at(-1) + ' (tên bạn xác nhận; MST/mã: ' + selected + ')' : company || 'MST/mã hồ sơ ' + selected),
    'Kỳ: ' + (args.from || 'theo bộ lọc hiện tại') + (args.to ? ' đến ' + args.to : ''),
    'Tổng hóa đơn: ' + number('invoices') + '; còn hiệu lực: ' + number('active') + '; không còn hiệu lực: ' + number('inactive') + '.',
    'Bán ra: ' + number('sell') + ' hóa đơn; tổng thanh toán còn hiệu lực: ' + number('amountSell') + ' đồng; thuế: ' + number('taxSell') + ' đồng.',
    'Mua vào: ' + number('buy') + ' hóa đơn; tổng thanh toán còn hiệu lực: ' + number('amountBuy') + ' đồng; thuế: ' + number('taxBuy') + ' đồng.',
    'Số tiền dùng nguyên logic tổng hợp của kho, không bao gồm hóa đơn đã bị thay thế/điều chỉnh/hủy. Đây là số liệu hóa đơn đã lưu, chưa đủ để kết luận lợi nhuận hoặc dữ liệu đã đầy đủ trên cổng thuế.',
    'Báo cáo được dựng tại máy; số liệu này không gửi lên model miễn phí.'].join('\n\n');
}
module.exports = { summaryReport };
