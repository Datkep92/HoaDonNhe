'use strict';
// ---------------------------------------------------------------------------
// XUẤT FILE "MẪU BÁN HÀNG" CHO MISA AMIS (tab Hỗ trợ kế toán).
//
// Vì sao test kỹ: người dùng đang NHẬP LẠI hoá đơn bán hàng vào hệ thống kế toán — file này
// được up thẳng lên MISA, sai một cột là sai sổ. Nên test khoá cứng:
//   · 41 tiêu đề PHẢI khớp từng chữ với file mẫu (đọc từ chính file mẫu, không chép tay);
//   · 8 hàng đầu (hướng dẫn + ô gộp + tiêu đề) PHẢI giữ nguyên;
//   · số liệu PHẢI lấy từ hoá đơn, đúng dòng/đúng cột;
//   · chỉ hoá đơn BÁN RA còn hiệu lực;
//   · thiếu ô bắt buộc ⇒ KHÔNG xuất file.
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const XLSX = require('../resources/xlsx.cjs');
const JSZip = require('jszip');
const { openDatabase, closeDatabase } = require('../src/data/sqlite');
const { insertInvoice } = require('../src/data/repository');
const misa = require('../src/data/misa-export');
const productMaster = require('../src/data/product-master');

const MST = '0312345678';
const BUYER = '0100000001';

function withDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoadon-misa-'));
  const db = openDatabase(path.join(dir, 'data.db'));
  try { return fn(db, dir); } finally { closeDatabase(db); fs.rmSync(dir, { recursive: true, force: true }); }
}

// Bản bất đồng bộ cho các đường GHI FILE (nén zip là việc bất đồng bộ).
async function withDbAsync(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoadon-misa-'));
  const db = openDatabase(path.join(dir, 'data.db'));
  try { return await fn(db, dir); } finally { closeDatabase(db); fs.rmSync(dir, { recursive: true, force: true }); }
}

// Hoá đơn BÁN RA mẫu: mstBan = MST (mình bán), mstMua = khách.
const sale = (over = {}) => ({
  direction: 'SELL', mstBan: MST, mstMua: BUYER,
  tenBan: 'CÔNG TY MÌNH', tenMua: 'Công ty TNHH Vân Long',
  ngayLap: '2026-09-21', khmsHd: '1', khhHd: 'C26MTH', soHd: '00000221',
  loaiHoaDon: 'Hóa đơn giá trị gia tăng', tongTien: 22000000, fileXml: 'C:/x/khong-co.xml',
  items: [{ stt: 1, maHang: 'PROSPAN', tenHang: 'Thuốc ho PROSPAN', donVi: 'Chai', soLuong: 2, donGia: 2000000, chietKhau: 0, thanhTien: 4000000, thueSuat: '10%', tienThue: 400000 }],
  ...over,
});

const setColumns = (db, soHd, patch) => {
  const sets = Object.keys(patch).map(key => `${key} = ?`).join(', ');
  db.prepare(`UPDATE invoices SET ${sets} WHERE so_hd = ?`).run(...Object.values(patch), soHd);
};

// Đọc lại file đã xuất thành mảng 2 chiều để kiểm từng ô.
const readBack = buffer => {
  const book = XLSX.read(buffer, { type: 'buffer' });
  return { book, rows: XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { header: 1, blankrows: true, defval: null, raw: true }) };
};

// ------------------------------------------------------------------ CẤU TRÚC

test('41 tiêu đề PHẢI khớp TỪNG CHỮ với file mẫu MISA (không chép tay)', () => {
  const tpl = misa.template();
  assert.equal(tpl.templateHeaders.length, 41, 'file mẫu phải có đúng 41 cột');
  assert.deepEqual(misa.HEADERS, tpl.templateHeaders, 'thứ tự/tên cột lệch so với file mẫu ⇒ MISA nhập sai cột');
  assert.equal(tpl.name, 'Ban hang', 'tên sheet phải đúng như mẫu');
});

test('file xuất giữ NGUYÊN 8 hàng đầu của mẫu (hướng dẫn + ô gộp nhóm + tiêu đề)', () => {
  withDb(db => {
    insertInvoice(db, sale());
    const { buffer } = misa.buildWorkbook(db, { mst: MST, from: '', to: '' });
    const { rows } = readBack(buffer);
    const tpl = misa.template();
    for (let index = 0; index < 8; index += 1) {
      assert.deepEqual(rows[index], tpl.headerRows[index], `hàng ${index + 1} phải giống file mẫu`);
    }
    // Ô gộp 3 khối nhóm vẫn còn (Y7:AI7 · AJ7:AM7 · AN7:AO7).
    const sheet = XLSX.read(buffer, { type: 'buffer' }).Sheets['Ban hang'];
    assert.equal((sheet['!merges'] || []).length, 3, 'phải giữ 3 ô gộp tiêu đề nhóm');
  });
});

test('MỘT DÒNG = MỘT DÒNG HÀNG; cột chứng từ lặp lại; số chứng từ chỉ MỘT cho mỗi hoá đơn', () => {
  withDb(db => {
    insertInvoice(db, sale({
      items: [
        { stt: 1, maHang: 'A1', tenHang: 'Hàng A', donVi: 'Chai', soLuong: 2, donGia: 1000, chietKhau: 0, thanhTien: 2000, thueSuat: '10%', tienThue: 200 },
        { stt: 2, maHang: 'B2', tenHang: 'Hàng B', donVi: 'Hộp', soLuong: 3, donGia: 2000, chietKhau: 0, thanhTien: 6000, thueSuat: '10%', tienThue: 600 },
      ],
    }));
    const { rows } = readBack(misa.buildWorkbook(db, { mst: MST }).buffer);
    assert.equal(rows.length, 10, '8 hàng tiêu đề + 2 dòng hàng');
    // Cột chứng từ giống nhau ở cả 2 dòng…
    assert.equal(rows[8][misa.C.soChungTu], rows[9][misa.C.soChungTu]);
    assert.equal(rows[8][misa.C.soHD], rows[9][misa.C.soHD]);
    // …còn phần hàng hoá thì khác nhau.
    assert.equal(rows[8][misa.C.maHang], 'A1');
    assert.equal(rows[9][misa.C.maHang], 'B2');
    assert.equal(rows[8][misa.C.soLuong], 2);
    assert.equal(rows[9][misa.C.soLuong], 3);
  });
});

// ------------------------------------------------------------------ SỐ CHỨNG TỪ

test('Số chứng từ = PT0001 tăng dần THEO SỐ HOÁ ĐƠN, một số cho mỗi hoá đơn', () => {
  withDb(db => {
    insertInvoice(db, sale({ soHd: '00000300' }));
    insertInvoice(db, sale({ soHd: '00000100' }));
    insertInvoice(db, sale({ soHd: '00000200' }));
    const result = misa.prepare(db, {});
    assert.deepEqual([...new Set(result.rows.map(row => row[misa.C.soChungTu]))], ['PT0001', 'PT0002', 'PT0003']);
    // Thứ tự dòng đi theo số hoá đơn tăng dần.
    assert.deepEqual(result.rows.map(row => row[misa.C.soHD]), ['00000100', '00000200', '00000300']);
  });
});

test('bộ đếm số chứng từ LƯU LẠI: xuất lượt sau tiếp tục, KHÔNG quay về PT0001', () => {
  withDb(db => {
    insertInvoice(db, sale({ soHd: '00000001' }));
    misa.buildWorkbook(db, { mst: MST });
    assert.equal(misa.counterValue(db), 1, 'sau lượt xuất, bộ đếm phải là 1');
    insertInvoice(db, sale({ soHd: '00000002' }));
    const second = misa.prepare(db, {});
    assert.equal(second.rows[0][misa.C.soChungTu], 'PT0002', 'lượt sau phải tiếp tục từ PT0002');
  });
});

test('tiền tố và số bắt đầu đổi được (ví dụ BH0005)', () => {
  withDb(db => {
    insertInvoice(db, sale());
    const result = misa.prepare(db, { prefix: 'BH', startNo: 5 });
    assert.equal(result.rows[0][misa.C.soChungTu], 'BH0005');
  });
});

// ------------------------------------------------------------------ MÃ KHÁCH HÀNG

test('Mã khách hàng ỔN ĐỊNH theo TÊN: cùng khách = cùng mã, khách mới = mã kế tiếp', () => {
  withDb(db => {
    insertInvoice(db, sale({ soHd: '00000001', tenMua: 'Công ty A' }));
    insertInvoice(db, sale({ soHd: '00000002', tenMua: 'Công ty B' }));
    insertInvoice(db, sale({ soHd: '00000003', tenMua: 'công  ty  a' })); // cùng khách A, khác hoa/thường + khoảng trắng
    const result = misa.prepare(db, {});
    const codes = result.rows.map(row => row[misa.C.maKhach]);
    assert.deepEqual(codes, ['KH0001', 'KH0002', 'KH0001'], 'cùng tên khách phải ra CÙNG mã (nếu không MISA tạo trùng khách)');
    assert.equal(new Set(codes).size, 2);
  });
});

test('mã khách phân biệt DẤU tiếng Việt — KHÔNG gộp hai khách khác tên thành một', () => {
  // Cố ý giữ dấu khi tạo khoá: gộp nhầm hai khách khác nhau sẽ làm SAI công nợ, còn tách nhầm
  // (trùng khách) chỉ phiền chứ không sai số. Nên chọn hướng an toàn hơn cho kế toán.
  withDb(db => {
    insertInvoice(db, sale({ soHd: '00000001', tenMua: 'Công ty An' }));
    insertInvoice(db, sale({ soHd: '00000002', tenMua: 'Công ty Ánh' }));
    const codes = misa.prepare(db, {}).rows.map(row => row[misa.C.maKhach]);
    assert.equal(new Set(codes).size, 2, 'hai tên khác dấu phải là hai mã khác nhau');
  });
});

test('mã khách đã cấp được DÙNG LẠI ở lượt xuất sau (không cấp mã mới)', () => {
  withDb(db => {
    insertInvoice(db, sale({ tenMua: 'Công ty A' }));
    misa.buildWorkbook(db, { mst: MST });
    insertInvoice(db, sale({ soHd: '00009999', tenMua: 'Công ty A' }));
    const later = misa.prepare(db, {});
    assert.ok(later.rows.every(row => row[misa.C.maKhach] === 'KH0001'));
  });
});

// ------------------------------------------------------------------ PHẠM VI DỮ LIỆU

test('CHỈ hoá đơn BÁN RA — hoá đơn mua vào không được lọt vào file', () => {
  withDb(db => {
    insertInvoice(db, sale({ soHd: '00000001' }));
    insertInvoice(db, sale({ direction: 'BUY', mstBan: BUYER, mstMua: MST, tenMua: 'Mình', soHd: '00000002' }));
    const result = misa.prepare(db, {});
    assert.equal(result.stats.invoices, 1);
    assert.deepEqual(result.rows.map(row => row[misa.C.soHD]), ['00000001']);
  });
});

test('hoá đơn KHÔNG CÒN HIỆU LỰC (tthai 4/5/6) bị loại — không nhập lại hoá đơn đã thay thế/huỷ', () => {
  withDb(db => {
    insertInvoice(db, sale({ soHd: '00000001' }));
    insertInvoice(db, sale({ soHd: '00000002' }));
    insertInvoice(db, sale({ soHd: '00000003' }));
    setColumns(db, '00000002', { tthai: '4' }); // đã bị thay thế
    setColumns(db, '00000003', { tthai: '6' }); // đã bị huỷ
    const result = misa.prepare(db, {});
    assert.deepEqual(result.rows.map(row => row[misa.C.soHD]), ['00000001']);
  });
});

test('lọc theo khoảng ngày', () => {
  withDb(db => {
    insertInvoice(db, sale({ soHd: '00000001', ngayLap: '2026-08-31' }));
    insertInvoice(db, sale({ soHd: '00000002', ngayLap: '2026-09-10' }));
    insertInvoice(db, sale({ soHd: '00000003', ngayLap: '2026-10-01' }));
    assert.deepEqual(misa.prepare(db, { from: '2026-09-01', to: '2026-09-30' }).rows.map(r => r[misa.C.soHD]), ['00000002']);
  });
});

// ------------------------------------------------------------------ SỐ LIỆU TỪ HOÁ ĐƠN

test('số liệu LẤY TỪ HOÁ ĐƠN: mã hàng, tên hàng, ĐVT, số lượng, đơn giá, thành tiền', () => {
  withDb(db => {
    insertInvoice(db, sale());
    const row = misa.prepare(db, {}).rows[0];
    assert.equal(row[misa.C.maHang], 'PROSPAN');
    assert.equal(row[misa.C.tenHang], 'Thuốc ho PROSPAN');
    assert.equal(row[misa.C.dvt], 'Chai');
    assert.equal(row[misa.C.soLuong], 2);
    assert.equal(row[misa.C.donGia], 2000000);
    assert.equal(row[misa.C.thanhTien], 4000000);
    assert.equal(row[misa.C.ngayHoaDon], '21/09/2026', 'ngày phải là chuỗi dd/mm/yyyy như mẫu');
    assert.equal(row[misa.C.tenKhach], 'Công ty TNHH Vân Long');
    assert.equal(row[misa.C.maSoThue], BUYER);
  });
});

test('Thành tiền ghi SỐ, KHÔNG ghi công thức (mẫu dùng =AE*AD, MISA đọc công thức trống sẽ ra rỗng)', () => {
  withDb(db => {
    insertInvoice(db, sale());
    const { rows } = readBack(misa.buildWorkbook(db, { mst: MST }).buffer);
    assert.equal(typeof rows[8][misa.C.thanhTien], 'number');
    assert.equal(rows[8][misa.C.thanhTien], 4000000);
  });
});

test('Số hoá đơn GIỮ NGUYÊN số 0 đầu sau khi ghi ra file (cột text của MISA)', () => {
  withDb(db => {
    insertInvoice(db, sale({ soHd: '00000221' }));
    const { rows } = readBack(misa.buildWorkbook(db, { mst: MST }).buffer);
    assert.equal(rows[8][misa.C.soHD], '00000221');
  });
});

test('Phương thức thanh toán lấy TỪ HOÁ ĐƠN, luôn thuộc danh sách hợp lệ của mẫu', () => {
  withDb(db => {
    insertInvoice(db, sale({ soHd: '00000001' }));
    insertInvoice(db, sale({ soHd: '00000002' }));
    insertInvoice(db, sale({ soHd: '00000003' }));
    setColumns(db, '00000001', { payment_method: 'CASH' });
    setColumns(db, '00000002', { payment_method: 'TRANSFER' });
    setColumns(db, '00000003', { payment_method: 'UNKNOWN' });
    const labels = misa.prepare(db, {}).rows.map(row => row[misa.C.phuongThuc]);
    assert.deepEqual(labels, ['Thu tiền ngay - Tiền mặt', 'Thu tiền ngay - Chuyển khoản', 'Chưa thu tiền']);
    for (const label of labels) assert.ok(misa.ALLOWED.phuongThuc.includes(label), 'phải thuộc danh sách chọn của mẫu');
  });
});

test('giảm 20% thuế GTGT suy từ thuế suất: 8% ⇒ Có, 10% ⇒ Không', () => {
  assert.equal(misa.reducedVat('8%'), true);
  assert.equal(misa.reducedVat('10%'), false);
  assert.equal(misa.reducedVat(''), false);
  assert.equal(misa.reducedVat('0%'), false);
});

test('hàng khuyến mại: đơn giá 0 mà thành tiền > 0 ⇒ Có', () => {
  assert.equal(misa.isPromotion(0, 5000), true);
  assert.equal(misa.isPromotion(1000, 5000), false);
  assert.equal(misa.isPromotion(0, 0), false);
});

// ------------------------------------------------------------------ CHẶN XUẤT KHI SAI

test('THIẾU ô bắt buộc (Mã hàng) ở chế độ CHẶN ⇒ KHÔNG xuất file, lỗi nói rõ CÁCH SỬA', () => {
  withDb(db => {
    insertInvoice(db, sale({ items: [{ stt: 1, maHang: '', tenHang: 'Hàng không mã', donVi: 'Chai', soLuong: 1, donGia: 1000, chietKhau: 0, thanhTien: 1000, thueSuat: '10%', tienThue: 100 }] }));
    const result = misa.prepare(db, { missingCode: 'block' });
    const loi = result.errors.find(text => text.includes('Mã hàng'));
    assert.ok(loi, 'phải báo thiếu Mã hàng (*)');
    assert.ok(loi.includes('00000221') && loi.includes('C26MTH'), 'lỗi phải nêu SỐ HĐ + KÝ HIỆU để tìm ra hoá đơn');
    assert.ok(loi.includes('Dùng tên hàng làm mã'), 'lỗi phải nói CÁCH SỬA');
    assert.throws(() => misa.buildWorkbook(db, { mst: MST, missingCode: 'block' }), /chưa đúng/i, 'có lỗi thì KHÔNG được xuất file');
  });
});

// ---- MÃ HÀNG: 3 TẦNG (dữ liệu thật cho thấy ~10% dòng hoá đơn KHÔNG ghi mã hàng) ----

test('hoá đơn KHÔNG ghi mã hàng ⇒ mặc định DÙNG TÊN HÀNG LÀM MÃ, không chặn xuất', () => {
  withDb(db => {
    insertInvoice(db, sale({
      tenMua: 'Khách lẻ', mstMua: null,
      items: [{ stt: 1, maHang: '', tenHang: 'Nước sơn', donVi: 'Chai', soLuong: 30, donGia: 30000, chietKhau: 0, thanhTien: 900000, thueSuat: '10%', tienThue: 90000 }],
    }));
    const result = misa.prepare(db, {});
    assert.equal(result.errors.length, 0, 'không được chặn xuất');
    assert.equal(result.rows[0][misa.C.maHang], 'Nước sơn', 'lấy tên hàng làm mã');
    assert.equal(result.stats.codeFallback, 1);
    assert.ok(result.warnings.some(t => t.includes('DÙNG TÊN HÀNG LÀM MÃ')), 'phải cảnh báo rõ đã tự điền mã');
  });
});

test('hoá đơn thiếu mã nhưng TÊN có trong danh mục ⇒ lấy ĐÚNG MÃ của danh mục', () => {
  withDb(db => {
    const sheet = XLSX.utils.aoa_to_sheet([['Mã', 'Tên'], ['NUOCSON', 'Nước sơn']]);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, 'S1');
    productMaster.importWorkbook(db, { buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) });
    insertInvoice(db, sale({ items: [{ stt: 1, maHang: '', tenHang: 'Nước sơn', donVi: 'Chai', soLuong: 1, donGia: 1000, chietKhau: 0, thanhTien: 1000, thueSuat: '10%', tienThue: 100 }] }));
    const result = misa.prepare(db, {});
    assert.equal(result.rows[0][misa.C.maHang], 'NUOCSON', 'phải lấy mã từ danh mục theo tên');
    assert.equal(result.stats.codeFromName, 1);
    assert.equal(result.stats.codeFallback, 0, 'không dùng tên làm mã khi danh mục đã có mã tương ứng');
  });
});

test('tên hàng TRÙNG nhiều mã trong danh mục ⇒ KHÔNG tra theo tên (đoán bừa là gắn sai hàng vào sổ)', () => {
  withDb(db => {
    const sheet = XLSX.utils.aoa_to_sheet([['Mã', 'Tên'], ['A1', 'Nước sơn'], ['B2', 'Nước sơn']]);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, 'S1');
    productMaster.importWorkbook(db, { buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) });
    insertInvoice(db, sale({ items: [{ stt: 1, maHang: '', tenHang: 'Nước sơn', donVi: 'Chai', soLuong: 1, donGia: 1000, chietKhau: 0, thanhTien: 1000, thueSuat: '10%', tienThue: 100 }] }));
    const result = misa.prepare(db, {});
    assert.equal(result.rows[0][misa.C.maHang], 'Nước sơn', 'tên trùng ⇒ dùng tên làm mã chứ KHÔNG chọn bừa A1 hay B2');
    assert.equal(result.stats.codeFromName, 0);
  });
});

test('thiếu CẢ mã hàng lẫn tên hàng ⇒ vẫn là LỖI CHẶN, kể cả ở chế độ mặc định', () => {
  withDb(db => {
    insertInvoice(db, sale({ items: [{ stt: 1, maHang: '', tenHang: '', donVi: '', soLuong: 1, donGia: 1000, chietKhau: 0, thanhTien: 1000, thueSuat: '10%', tienThue: 100 }] }));
    const result = misa.prepare(db, {});
    assert.ok(result.errors.some(t => t.includes('thiếu CẢ Mã hàng lẫn Tên hàng')), 'phải chặn vì không còn gì định danh hàng hoá');
  });
});

// ---- DÒNG GHI CHÚ (dữ liệu thật: hoá đơn có dòng KHÔNG phải mặt hàng) ----
// Ví dụ thật: "Đã giảm 44.267 đồng tương ứng 20% mức tỷ lệ % để tính thuế GTGT theo Nghị quyết
// số 174/2024/QH15" · "(Xuất thành 3 giỏ quà )" · "Điều chỉnh thông tin hóa đơn ...".

const noteLine = {
  stt: 2, maHang: '', tenHang: '(Xuất thành 3 giỏ quà )', donVi: null,
  soLuong: null, donGia: null, chietKhau: 0, thanhTien: null, thueSuat: '', tienThue: null,
};
const realLine = { stt: 1, maHang: 'A1', tenHang: 'Hàng thật', donVi: 'Cái', soLuong: 1, donGia: 1000, chietKhau: 0, thanhTien: 1000, thueSuat: '10%', tienThue: 100 };

test('DÒNG GHI CHÚ (không số lượng/đơn giá/thành tiền) ⇒ KHÔNG chặn xuất, đánh dấu đúng cột của MISA', () => {
  withDb(db => {
    insertInvoice(db, sale({ items: [realLine, noteLine] }));
    const result = misa.prepare(db, {});
    assert.equal(result.errors.length, 0, 'một câu ghi chú KHÔNG được chặn cả file');
    assert.equal(result.stats.noteLines, 1);
    const note = result.rows.find(row => String(row[misa.C.tenHang]).includes('giỏ quà'));
    assert.ok(note, 'phải có dòng ghi chú trong kết quả');
    assert.equal(note[misa.C.laGhiChu], 'Có', 'phải bật cột "Là dòng ghi chú"');
    assert.equal(note[misa.C.soLuong], null, 'dòng ghi chú để TRỐNG số lượng');
    assert.equal(note[misa.C.donGia], null);
    assert.equal(note[misa.C.thanhTien], null);
    assert.equal(note[misa.C.khuyenMai], 'Không', 'dòng ghi chú không phải hàng khuyến mại');
    assert.ok(result.warnings.some(t => t.includes('DÒNG GHI CHÚ')), 'phải cảnh báo rõ số dòng ghi chú');
  });
});

test('dòng CÓ số lượng nhưng THIẾU đơn giá ⇒ vẫn là LỖI (dữ liệu không nhất quán, không phải ghi chú)', () => {
  withDb(db => {
    insertInvoice(db, sale({ items: [{ stt: 1, maHang: 'A1', tenHang: 'Hàng lỗi', donVi: 'Cái', soLuong: 5, donGia: null, chietKhau: 0, thanhTien: 5000, thueSuat: '10%', tienThue: 500 }] }));
    const result = misa.prepare(db, {});
    assert.ok(result.errors.some(t => t.includes('Đơn giá không đọc được')), 'thiếu đơn giá vẫn phải là lỗi chặn');
  });
});

test('nội dung dòng ghi chú KHÔNG bị tính là "mã hàng lạ" trong danh mục', () => {
  withDb(db => {
    const sheet = XLSX.utils.aoa_to_sheet([['Mã', 'Tên'], ['A1', 'Hàng thật']]);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, 'S1');
    productMaster.importWorkbook(db, { buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) });
    insertInvoice(db, sale({ items: [realLine, noteLine] }));
    const out = misa.prepare(db, {});
    assert.equal(out.stats.unmatched, 0, 'câu ghi chú không được coi là mã hàng lạ');
  });
});

test('mọi giá trị ghi ra ở 8 cột có danh sách chọn đều THUỘC danh sách hợp lệ của mẫu', () => {
  withDb(db => {
    insertInvoice(db, sale());
    const row = misa.prepare(db, {}).rows[0];
    assert.ok(misa.ALLOWED.hinhThuc.includes(row[misa.C.hinhThuc]));
    assert.ok(misa.ALLOWED.coKhong.includes(row[misa.C.kiemPhieu]));
    assert.ok(misa.ALLOWED.coKhong.includes(row[misa.C.lapKemHD]));
    assert.ok(misa.ALLOWED.coKhong.includes(row[misa.C.mayTinhTien]));
    assert.ok(misa.ALLOWED.daLap.includes(row[misa.C.daLapHD]));
    assert.ok(misa.ALLOWED.coKhongThuong.includes(row[misa.C.laGhiChu]), 'cột "Là dòng ghi chú" của mẫu dùng "không" viết thường');
    assert.ok(['Có', 'Không'].includes(row[misa.C.khuyenMai]));
    assert.ok(['Có', 'Không'].includes(row[misa.C.giam20]));
  });
});

test('chi tiết giá vốn (AJ→AM) và Nhóm ngành nghề để TRỐNG theo yêu cầu', () => {
  withDb(db => {
    insertInvoice(db, sale());
    const row = misa.prepare(db, {}).rows[0];
    assert.equal(row[misa.C.nhomNganh], null);
    assert.equal(row[misa.C.maKho], null);
    assert.equal(row[misa.C.donGiaVon], null);
    assert.equal(row[misa.C.tienVon], null);
    assert.equal(row[misa.C.khongCapNhat], null);
    assert.equal(row[misa.C.diaChi], null, 'không cần địa chỉ');
  });
});

// ------------------------------------------------------------------ DANH MỤC HÀNG HOÁ

test('nhập danh mục từ file Excel kiểu Danhsach (tiêu đề ở hàng 3) và tra cứu mã', () => {
  withDb(db => {
    const sheet = XLSX.utils.aoa_to_sheet([
      ['DANH MỤC HÀNG HOÁ'], [],
      ['STT', 'Mã', 'Kho ngầm định', 'Tên', 'Đơn vị tính chính', 'Đơn giá mua gần nhất'],
      [1, 'PROSPAN', 'Kho mặc định', 'Thuốc ho PROSPAN', 'Chai', 1500000],
      [2, 'AMBI SAP 180G', 'Kho mặc định', 'Sữa tắm AMBI', 'Hộp', 45823],
      [3, 'AMBI SAP 180G', 'Kho mặc định', 'Mã trùng — phải bị bỏ qua', 'Hộp', 1],
    ]);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, 'Sheet1');
    const value = productMaster.importWorkbook(db, { buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) });
    assert.equal(value.imported, 2, 'hai mã hợp lệ, mã trùng bị bỏ');
    assert.equal(value.skipped, 1);
    assert.equal(productMaster.summary(db).count, 2);
    assert.ok(productMaster.lookupMap(db).has('PROSPAN'));
  });
});

test('mã hàng KHÔNG có trong danh mục ⇒ CHỈ cảnh báo, vẫn xuất được (người dùng quyết định)', () => {
  withDb(db => {
    const sheet = XLSX.utils.aoa_to_sheet([['Mã', 'Tên'], ['KHAC', 'Mặt hàng khác']]);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, 'S1');
    productMaster.importWorkbook(db, { buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) });
    insertInvoice(db, sale());
    const result = misa.prepare(db, {});
    assert.equal(result.errors.length, 0, 'mã lạ KHÔNG phải lỗi chặn xuất');
    assert.ok(result.warnings.some(text => text.includes('KHÔNG có trong danh mục')), 'phải cảnh báo mã không khớp');
    assert.equal(result.stats.unmatched, 1);
  });
});

test('khớp mã hàng bỏ qua khác biệt HOA/thường và khoảng trắng THỪA (gộp nhiều dấu cách)', () => {
  // Cố ý KHÔNG xoá hết khoảng trắng: trong danh mục thật, "AMBI SAP 180G" và "AMBI SAP180G" là
  // HAI mặt hàng khác nhau — xoá trắng khoảng trắng sẽ gộp chúng làm một và che mất cảnh báo.
  const sheet = XLSX.utils.aoa_to_sheet([['Mã', 'Tên'], ['AMBI SAP 180G', 'Sữa tắm AMBI']]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'S1');
  withDb(db => {
    productMaster.importWorkbook(db, { buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) });
    const catalog = productMaster.lookupMap(db);
    assert.ok(catalog.has(productMaster.normalize('  ambi   sap 180g  ')), 'hoa/thường + khoảng trắng thừa phải khớp');
    assert.ok(!catalog.has(productMaster.normalize('AMBI SAP180G')), 'mã KHÁC (thiếu dấu cách) thì KHÔNG được coi là khớp');
  });
});

test('chưa nhập danh mục ⇒ cảnh báo rõ, không chặn xuất', () => {
  withDb(db => {
    insertInvoice(db, sale());
    const result = misa.prepare(db, {});
    assert.ok(result.warnings.some(text => text.includes('Chưa nhập danh mục')));
    assert.equal(result.errors.length, 0);
  });
});

// ------------------------------------------------------------------ TÊN FILE

test('tên file nêu rõ MST và khoảng ngày', () => {
  assert.equal(misa.fileName('0312345678', '2026-09-01', '2026-09-30'), 'Mau_ban_hang_0312345678_20260901-20260930.xls');
});

// ---- GHÉP CỘT TRONG MISA: khối dataValidation của mẫu PHẢI có trong file xuất ----
// MISA báo "Không thể tiếp tục nhập dữ liệu nếu các cột bắt buộc chưa được ghép với cột tương ứng
// trên tệp Excel" khi file THIẾU các luật dataValidation — mỗi luật ghi sqref (cột) + prompt
// (trường, ví dụ sqref="R8" → "Nhập Mã số thuế khách hàng"). SheetJS không ghi được khối này,
// nên app phải TIÊM nguyên khối của mẫu vào file .xlsx lúc xuất.

test('tài nguyên ghép cột của mẫu có ĐỦ 52 luật và nêu TÊN TRƯỜNG', () => {
  const block = misa.decor();
  assert.ok(block.dataValidations.length > 10000, 'khối dataValidations phải nạp được từ tài nguyên mẫu');
  assert.equal((block.dataValidations.match(/<dataValidation /g) || []).length, 52,
    'mẫu MISA có đúng 52 luật — thiếu là MISA không ghép được cột');
  assert.ok(block.dataValidations.includes('promptTitle="AMIS ACCOUNTING"'), 'luật phải mang tiêu đề AMIS ACCOUNTING');
  assert.ok(/prompt="Nhập Mã số thuế khách hàng[^"]*"[^>]*sqref="R8"/.test(block.dataValidations),
    'luật cột R phải nêu tên trường — đây chính là thứ MISA đọc để ghép cột');
});

test('file .xlsx xuất ra PHẢI chứa khối ghép cột của mẫu (đúng lỗi MISA đã báo)', async () => {
  await withDbAsync(async db => {
    insertInvoice(db, sale());
    const { buffer, fileName } = await misa.buildXlsx(db, { mst: MST });
    assert.ok(fileName.endsWith('.xlsx'), 'đuôi file phải là .xlsx');
    const zip = await JSZip.loadAsync(buffer);
    const xml = await zip.file('xl/worksheets/sheet1.xml').async('string');
    assert.equal((xml.match(/<dataValidation /g) || []).length, 52, 'file xuất phải mang đủ 52 luật ghép cột');
    assert.ok(xml.includes('promptTitle="AMIS ACCOUNTING"'), 'luật phải còn tiêu đề AMIS');
    assert.ok(xml.includes('Nhập Mã số thuế khách hàng'), 'luật phải còn TÊN TRƯỜNG để MISA ghép cột');
    // Thứ tự phần tử trong XML bảng tính là BẮT BUỘC — sai là file hỏng với Excel/MISA.
    assert.ok(xml.indexOf('<cols>') < xml.indexOf('<sheetData>'), '<cols> phải đứng trước <sheetData>');
    const dv = xml.indexOf('<dataValidations');
    const merge = xml.indexOf('</mergeCells>');
    if (merge >= 0) assert.ok(merge < dv, '<mergeCells> phải đứng trước <dataValidations>');
    // Nội dung vẫn đúng: 8 hàng đầu giống mẫu + dữ liệu từ hàng 9.
    const rows = XLSX.utils.sheet_to_json(XLSX.read(buffer, { type: 'buffer' }).Sheets['Ban hang'],
      { header: 1, blankrows: true, defval: null, raw: true });
    assert.deepEqual(rows.slice(0, 8), misa.template().headerRows, '8 hàng đầu phải giống file mẫu');
    assert.equal(rows[8][misa.C.maHang], 'PROSPAN');
  });
});

test('.xls KHÔNG mang được khối ghép cột — vì vậy mặc định phải là .xlsx', () => {
  withDb(db => {
    insertInvoice(db, sale());
    const { buffer } = misa.buildWorkbook(db, { mst: MST });
    assert.ok(!buffer.includes(Buffer.from('promptTitle="AMIS ACCOUNTING"', 'utf8')),
      '.xls là BIFF8 nên SheetJS không ghi được dataValidation ⇒ dùng .xls sẽ bị MISA từ chối ghép cột');
  });
});
