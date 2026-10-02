/**
 * Deploy as a Web App. Set Script Property GATEWAY_SHARED_SECRET to the
 * same high-entropy value used by the Gateway. Never place that secret in
 * the desktop application or a spreadsheet cell.
 *
 * Spreadsheet tabs:
 * Devices: Hardware ID | Chat Room ID | License Key | Status | Expiry Date | First Install Time | Last Seen Time
 * Licenses: License Key | Status | Expiry Date | Hardware ID | Chat Room ID | Activated At
 *
 * Optional columns / tabs (thêm vào là tự dùng, chưa thêm thì chạy như cũ):
 * Devices   + Phone | Name | Plan | Hardware Hash
 * Licenses  + Max Devices            -> số máy tối đa của một key (trống = 1 máy)
 * tab Bindings: License Key | Hardware ID | Chat Room ID | Activated At  -> bật key nhiều máy
 * tab Settings: Key | Value          -> dòng có Key = Notice để phát thông báo
 *
 * Trạng thái trả về cho app: Active | Trial | Expired | Locked | Unactivated | device_limit_exceeded
 * Dùng thử: TRIAL_DAYS ngày tính từ First Install Time do máy chủ ghi, máy khách không tự đặt lại được.
 *
 * Apps Script CHỈ quản lý thiết bị + bản quyền trên Google Sheet: không tạo Topic, không
 * gửi tin, không nhận webhook Telegram. Toàn bộ Telegram (Topic, webhook, định tuyến chat)
 * do Gateway đảm nhiệm — xem SUPPORT_SETUP.md §6. Ba định danh tách biệt:
 *   machineId         = mã máy ỔN ĐỊNH băm từ phần cứng (DEV_...), KHÔNG random.
 *                      Khách cài lại app / bật VPN / đổi tên máy thì vẫn y hệt.
 *                      Đây là khoá dòng MỚI trong sheet Devices.
 *   installationId    = khoá dòng CŨ (UUID ngẫu nhiên). App bản cũ vẫn gửi giá trị này,
 *                      app bản mới gửi machineId. Cả hai đều được chấp nhận.
 *   chatRoomId        = ROOM_WIN_... phòng chat của app, SUY RA TỪ machineId nên một máy
 *                      chỉ có đúng một phòng.
 *   telegramThreadId  = id Topic Telegram, chỉ tồn tại ở Firebase/Gateway.
 */
const DEVICE_SHEET = 'Devices';
const LICENSE_SHEET = 'Licenses';
const BINDING_SHEET = 'Bindings';
const SETTINGS_SHEET = 'Settings';
const TRIAL_DAYS = 30;

// Máy coi như đang online nếu lần ghi nhận diện gần nhất nằm trong cửa sổ này.
// App ghi presence lúc mở và mỗi ~4h khi chạy nền, nên 15 phút là đủ bắt được
// máy đang mở mà vẫn không tốn nhiều request. Worker có hằng trùng tên — sửa thì
// sửa cả hai để /online không lệch với Sheet.
const ONLINE_WINDOW_MS = 15 * 60 * 1000;

// Mã máy mới (DEV_ + 16 hex) HOẶC UUID cũ. Chấp nhận cả hai để app đang chạy
// ngoài hiện trường không bị từ chối trong lúc chuyển đổi.
const ID_PATTERN = /^(?:DEV_[A-F0-9]{12,32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const ROOM_PATTERN = /^ROOM_WIN_[A-Z0-9]{8,40}$/;

// Cột tự sinh nếu chưa có, để không phải tự thêm cột bằng tay trên Sheet.
const DEVICE_OPTIONAL_COLUMNS = ['Phone', 'Name', 'Plan', 'Hardware Hash', 'Machine ID', 'Telegram Topic ID', 'First Install Time', 'Last Seen Time', 'License Key', 'Chat Room ID'];


// Số slot của một key: tối đa bao nhiêu máy, và đã gán mấy máy.
// Nguồn: cột "Max Devices" ở tab Licenses (thiếu = 1); số máy đã gán đếm từ
// tab Bindings, không có tab thì lấy ô "Hardware ID" đã gán ngay trong dòng
// Licenses (cách ghi liên kết một máy kiểu cũ). Trả null khi không có key.
function slots_(key) {
  const clean = String(key || '').trim();
  // Không có key thì không có "số máy" để báo — trả null để nơi gọi bỏ qua,
  // chứ không trả {max:1} rồi hiện ra "0/1" làm khách tưởng còn 1 slot.
  if (!clean) return null;
  const sheet = licenseSheet_();
  const data = rows_(sheet);
  const index = find_(data.values, cell_(data.header, 'License Key'), clean);
  if (index < 0) return null;
  const row = data.values[index];
  const max = maxDevices_(row, data.header);
  const boundCol = cell_(data.header, 'Hardware ID');
  const bindings = boundDevices_(clean);
  const used = bindings
    ? bindings.values.filter(item => String(item[cell_(bindings.header, 'Hardware ID')] || '').trim()).length
    : (String(row[boundCol] || '').trim() ? 1 : 0);
  return { max: max, used: used };
}

// Chuẩn hoá số điện thoại về một dạng để so sánh: chỉ giữ chữ số, bỏ mã
// quốc gia 84 và số 0 ở đầu. Nhờ vậy "0987 654 321", "+84 987.654.321" và
// "987654321" đều ra cùng một khoá — khách gõ SĐT kiểu nào cũng tìm thấy.
// Rỗng thì trả '' để nơi gọi tự báo "không nhập số".
function phoneKey_(value) {
  let digits = String(value == null ? '' : value).replace(/\D+/g, '');
  if (digits.length > 10 && digits.indexOf('84') === 0) digits = digits.slice(2);
  while (digits.length > 9 && digits.charAt(0) === '0') digits = digits.slice(1);
  return digits;
}

// ==========================================
// TRA CỨU THEO SỐ ĐIỆN THOẠI (/check_SDT)
// ==========================================
// Admin gõ /check_0987654321 trong Telegram. Trả về TOÀN BỘ máy đăng ký với số
// điện thoại đó và TOÀN BỘ key đã cấp cho các máy ấy — vì /new mỗi lần tạo một
// key mới, một khách có thể đang giữ nhiều key cùng lúc (gia hạn bằng /new, mua
// thêm máy...). Chỉ nhìn "key hiện tại" sẽ bỏ sót key cũ còn hiệu lực.
// Liên kết key ↔ máy qua "Chat Room ID" vì phòng chat suy ra từ machineId nên
// một máy luôn có đúng một phòng, không đổi khi khách cài lại app.
// Chỉ gọi từ Worker (đã qua khoá gatewaySecret), không gọi từ app.
function findByPhone_(input) {
  const want = phoneKey_(input.phone);
  if (!want) return { found: false, query: String(input.phone || '').trim(), devices: [], licenses: [] };

  const now = Number(input.now || Date.now());
  const sheet = deviceSheet_();
  ensureColumns_(sheet, DEVICE_OPTIONAL_COLUMNS);
  const data = rows_(sheet);
  const header = data.header;
  const phoneCol = optional_(header, 'Phone');
  const hardwareCol = cell_(header, 'Hardware ID');
  const machineCol = optional_(header, 'Machine ID');
  const roomCol = optional_(header, 'Chat Room ID');
  const nameCol = optional_(header, 'Name');
  const planCol = optional_(header, 'Plan');
  const seenCol = optional_(header, 'Last Seen Time');
  const pick = (row, index) => (index < 0 ? '' : String(row[index] || '').trim());

  const devices = [];
  const rooms = {};          // ROOM_WIN_... -> true, để lọc key của các máy này
  const machineIds = {};     // DEV_... -> true
  for (const row of data.values) {
    if (phoneCol < 0) break;
    if (phoneKey_(row[phoneCol]) !== want) continue;
    const result = deviceResult_(row, header);
    const room = pick(row, roomCol);
    const machine = pick(row, machineCol);
    const hardware = pick(row, hardwareCol);
    if (room) rooms[room.toUpperCase()] = true;
    if (machine) machineIds[machine.toUpperCase()] = true;
    const lastSeen = seenCol >= 0 && row[seenCol] ? new Date(row[seenCol]).getTime() : 0;
    devices.push({
      chatRoomId: room,
      machineId: machine,
      hardwareId: hardware,
      name: pick(row, nameCol),
      phone: pick(row, phoneCol),
      plan: pick(row, planCol),
      status: result.status,
      keyName: result.keyName,
      expiryAt: result.expiryAt,
      lastSeen: Number.isFinite(lastSeen) ? lastSeen : 0,
      online: Number.isFinite(lastSeen) && lastSeen > 0 && (now - lastSeen) <= ONLINE_WINDOW_MS,
    });
  }

  // Key của các máy vừa tìm ra. Dòng Licenses khớp nếu Chat Room ID trùng, HOẶC
  // Hardware ID trùng một trong các mã máy (sheet cũ ghi mã theo kiểu cũ).
  const licenses = [];
  const licenseData = rows_(licenseSheet_());
  const lh = licenseData.header;
  const lKey = cell_(lh, 'License Key');
  const lStatus = optional_(lh, 'Status');
  const lExpiry = optional_(lh, 'Expiry Date');
  const lRoom = optional_(lh, 'Chat Room ID');
  const lHardware = optional_(lh, 'Hardware ID');
  const lActivated = optional_(lh, 'Activated At');
  const ids = Object.keys(machineIds);
  for (const row of licenseData.values) {
    const room = (lRoom >= 0 ? String(row[lRoom] || '').trim() : '').toUpperCase();
    const hardware = (lHardware >= 0 ? String(row[lHardware] || '').trim() : '').toUpperCase();
    if (!rooms[room] && !machineIds[hardware] && ids.indexOf(hardware) < 0) continue;
    const keyName = String(row[lKey] || '').trim();
    const slot = slots_(keyName);
    const rawStatus = (lStatus >= 0 ? String(row[lStatus] || '').trim() : '');
    const expiry = lExpiry >= 0 ? row[lExpiry] : '';
    const expiryAt = expiry ? new Date(expiry).getTime() : 0;
    // Trạng thái hiển thị phải giống hệt logic của /check, không thì admin thấy
    // "Active" cho một key đã hết hạn.
    const status = rawStatus.toLowerCase() === 'active' && Number.isFinite(expiryAt) && expiryAt < now ? 'Expired' : (rawStatus || 'Active');
    const bindings = boundDevices_(keyName);
    const boundDevices = [];
    if (bindings) {
      const bRoom = optional_(bindings.header, 'Chat Room ID');
      const bAt = optional_(bindings.header, 'Activated At');
      for (const item of bindings.values) {
        if (!String(item[cell_(bindings.header, 'Hardware ID')] || '').trim()) continue;
        boundDevices.push({
          hardwareId: String(item[cell_(bindings.header, 'Hardware ID')] || '').trim(),
          chatRoomId: bRoom >= 0 ? String(item[bRoom] || '').trim() : '',
          activatedAt: bAt >= 0 ? item[bAt] : '',
        });
      }
    }
    licenses.push({
      keyName: keyName,
      status: status,
      expiryAt: expiry || '',
      activatedAt: lActivated >= 0 ? row[lActivated] : '',
      chatRoomId: lRoom >= 0 ? String(row[lRoom] || '').trim() : '',
      maxDevices: slot ? slot.max : maxDevices_(row, lh),
      usedSlots: slot ? slot.used : 0,
      boundDevices: boundDevices,
    });
  }

  return {
    found: devices.length > 0 || licenses.length > 0,
    query: String(input.phone || '').trim(),
    phone: want,
    now: now,
    onlineWindowMs: ONLINE_WINDOW_MS,
    devices: devices,
    licenses: licenses,
  };
}

// ==========================================
// DANH SÁCH THIẾT BỊ (cho lệnh /online của admin)
// ==========================================
// lastSeen là mốc Gateway ghi vào Firebase lần gần nhất, đưa vào đây để admin
// biết máy nào đang chạy app. Trả về mỗi máy: phòng chat, mã máy, tên, SĐT,
// trạng thái, hạn, và lastSeen (0 nếu máy chưa từng mở app bản có phần này).
// Chỉ gọi từ Worker (đã qua khoá gatewaySecret), không gọi từ app.
function listDevices_(input) {
  const sheet = deviceSheet_();
  ensureColumns_(sheet, DEVICE_OPTIONAL_COLUMNS);
  const data = rows_(sheet);
  const header = data.header;
  const hardwareCol = cell_(header, 'Hardware ID');
  const machineCol = optional_(header, 'Machine ID');
  const roomCol = optional_(header, 'Chat Room ID');
  const phoneCol = optional_(header, 'Phone');
  const nameCol = optional_(header, 'Name');
  const planCol = optional_(header, 'Plan');
  const seenCol = optional_(header, 'Last Seen Time');
  const pick = (row, index) => (index < 0 ? '' : String(row[index] || '').trim());
  const now = Number(input.now || Date.now());
  const devices = [];
  for (const row of data.values) {
    const room = pick(row, roomCol);
    const hardware = pick(row, hardwareCol);
    if (!room && !hardware) continue;
    const result = deviceResult_(row, header);
    const lastSeen = seenCol >= 0 && row[seenCol] ? new Date(row[seenCol]).getTime() : 0;
    devices.push({
      chatRoomId: room,
      machineId: machineCol >= 0 ? pick(row, machineCol) : '',
      hardwareId: hardware,
      name: pick(row, nameCol),
      phone: pick(row, phoneCol),
      plan: pick(row, planCol),
      status: result.status,
      keyName: result.keyName,
      expiryAt: result.expiryAt,
      lastSeen: Number.isFinite(lastSeen) ? lastSeen : 0,
      online: Number.isFinite(lastSeen) && lastSeen > 0 && (now - lastSeen) <= ONLINE_WINDOW_MS,
    });
  }
  return { now: now, count: devices.length, onlineWindowMs: ONLINE_WINDOW_MS, devices: devices };
}

function doPost(e) {
  try {
    const input = JSON.parse(e.postData && e.postData.contents || '{}');

    // Mọi request đều phải có secret của Gateway
    const expectedSecret = PropertiesService.getScriptProperties().getProperty('GATEWAY_SHARED_SECRET');
    if (!expectedSecret || input.gatewaySecret !== expectedSecret) {
      throw new Error('Unauthorized gateway.');
    }

    // Sheet mới tạo chưa có tab nào -> tạo trước rồi mới xử lý. Đây cũng là bước
    // tự phục hồi: đã có đủ tab thì không động vào gì.
    ensureTabs_();

    const action = String(input.action || '');
    const chatRoomId = String(input.chatRoomId || '');
    const installId = String(input.installationId || '');

    // Lệnh quản trị do Gateway chuyển tiếp (lấy từ Topic Telegram) chỉ cần biết phòng chat;
    // Apps Script không tự nói chuyện với Telegram, Gateway lo phần gửi/nhận.
    if (action === 'admin_command') {
      if (!ROOM_PATTERN.test(chatRoomId)) throw new Error('Invalid device identity.');
      return reply_({ ok: true, value: adminCommand_(input) });
    }

    // list_devices là lệnh TOÀN CỤC của admin (xem /online): không gắn với máy
    // nào nên không được đòi mã máy, giống admin_command ở trên.
    if (action === 'list_devices') {
      return reply_({ ok: true, value: listDevices_(input) });
    }

    // find_by_phone cũng là lệnh toàn cục (/check_SDT trong Telegram): tìm theo
    // SĐT nên không gắn với mã máy nào.
    if (action === 'find_by_phone') {
      return reply_({ ok: true, value: findByPhone_(input) });
    }

    // App bản mới gửi machineId; app bản cũ chỉ gửi installationId (UUID).
    // Chỉ cần một trong hai là nhận diện được, nhưng phòng chat thì luôn bắt buộc.
    const machineId = String(input.machineId || '').trim();
    const identityOk = ID_PATTERN.test(installId) || ID_PATTERN.test(machineId);
    // machineId sai dạng thì từ chối hẳn, không cho "lọt qua bằng installationId":
    // nếu lọt, giá trị rác sẽ được ghi vào cột Machine ID và biến thành khoá tra
    // cứu không bao giờ trúng — dữ liệu bị bẩn mà rất khó phát hiện.
    const machineValid = !machineId || ID_PATTERN.test(machineId);
    if (!identityOk || !machineValid || !ROOM_PATTERN.test(chatRoomId)) {
      throw new Error('Invalid device identity.');
    }

    let result;
    if (action === 'register_device') {
      result = registerDevice_(input);
    } else if (action === 'verify_key') {
      result = verifyKey_(input);
    } else if (action === 'license_status') {
      result = licenseStatus_(input);
    } else if (action === 'get_notice') {
      result = notice_();
    } else {
      throw new Error('Unknown action.');
    }

    return reply_({ ok: true, value: result });
  } catch (error) {
    return reply_({ ok: false, error: error.message || 'Request failed.' });
  }
}

function reply_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

// ==========================================
// TRUY CẬP SHEET
// ==========================================
function rows_(sheet) {
  const values = sheet.getDataRange().getValues();
  const header = values.length ? values.shift() : [];
  return { header, values };
}

// Cột bắt buộc: thiếu là lỗi cấu hình, báo ngay để không ghi sai dữ liệu.
function cell_(header, name) {
  const index = header.indexOf(name);
  if (index < 0) throw new Error(`Missing column: ${name}`);
  return index;
}

// Cột mới thêm: chưa có thì trả -1 và tính năng đó tạm tắt.
function optional_(header, name) {
  return header.indexOf(name);
}

function find_(values, column, value) {
  if (column < 0) return -1;
  return values.findIndex(row => String(row[column]).trim() === String(value).trim());
}

// Tự thêm các cột còn thiếu vào hàng tiêu đề để không phải tự thêm cột bằng
// tay trên Google Sheet. Sheet hoàn toàn trống thì viết luôn hàng tiêu đề.
// Thiếu quyền ghi thì bỏ qua — các cột này đều tuỳ chọn nên Sheet cũ vẫn chạy
// được bằng đường cũ.
function ensureColumns_(sheet, names) {
  const values = sheet.getDataRange().getValues();
  if (!values.length) return [];
  const header = values[0].map(value => String(value || '').trim());
  const added = [];
  for (const name of names) {
    if (header.indexOf(name) >= 0) continue;
    header.push(name);
    added.push(name);
  }
  if (added.length) {
    try { sheet.getRange(1, 1, 1, header.length).setValues([header]); }
    catch (error) { return []; }
  }
  return added;
}

// TÌM DÒNG THIẾT BỊ — thứ tự ưu tiên, dừng ở lần khớp đầu tiên:
//   1. Machine ID   mã máy ổn định băm từ phần cứng (đường chuẩn)
//   2. Hardware ID  UUID cũ của app bản cũ
//
// KHÔNG CÒN khớp theo Hardware Hash. Hash cũ băm từ (tên máy | tài khoản |
// card mạng) nên không đổi theo bản cài — nó là khoá lỏng dùng chung cho mọi
// lần cài trên một máy, và ai biết hash đó cũng dùng được. Sự cố đã xảy ra:
// client gửi UUID lạ kèm hash của máy khác đã khớp đúng dòng thiết bị đó và
// nhận luôn license của người kia. Có Machine ID ổn định thì bỏ hẳn.
// Đánh đổi: khách dùng app bản cũ mà mất file cục bộ phải kích hoạt lại.
function findDevice_(data, input) {
  const header = data.header;
  const machineId = String(input.machineId || '').trim();
  const installId = String(input.installationId || '').trim();

  if (machineId) {
    const byMachine = find_(data.values, optional_(header, 'Machine ID'), machineId);
    if (byMachine >= 0) return { index: byMachine, via: 'machineId' };
  }
  const byInstall = find_(data.values, optional_(header, 'Hardware ID'), installId);
  if (byInstall >= 0) return { index: byInstall, via: 'installationId' };
  return { index: -1, via: '' };
}

function sheet_(name) {
  return SpreadsheetApp.getActive().getSheetByName(name);
}

function deviceSheet_() {
  return sheet_(DEVICE_SHEET) || (() => { throw new Error('Devices sheet is missing.'); })();
}

function licenseSheet_() {
  return sheet_(LICENSE_SHEET) || (() => { throw new Error('Licenses sheet is missing.'); })();
}

// Bảng Bindings là tuỳ chọn; không có thì dùng liên kết đơn ở cột Licenses!Hardware ID.
function bindingsSheet_() {
  return sheet_(BINDING_SHEET);
}

// ---------------------------------------------------------------------------
// TỰ TẠO CẤU TRÚC SHEET KHI THIẾU
//
// Lý do: dựng CRM mới (Google Sheet trống + script) thì không có tab nào. Nếu
// bắt người tạo tay 4 tab và 25 tiêu đề cột thì dễ sai tên, sai thứ tự — mà
// hỏng lúc đó rất khó hiểu vì lỗi chỉ hiện ra khi khách đăng ký.
//
// Hàm này CHỈ hành động khi thiếu: đã có tab thì không đụng gì, nên CRM đang
// chạy không bị ảnh hưởng. Nó cũng tự chữa được sau khi ai đó lỡ xoá nhầm tab.
//
// Danh sách cột phải KHỚP DEVICE_OPTIONAL_COLUMNS và các hằng số tab ở trên.
const SHEET_SPECS = [
  {
    name: DEVICE_SHEET,
    headers: ['Hardware ID', 'Machine ID', 'Chat Room ID', 'License Key', 'Status', 'Expiry Date',
      'First Install Time', 'Last Seen Time', 'Hardware Hash', 'Phone', 'Name', 'Plan', 'Telegram Topic ID']
  },
  {
    name: LICENSE_SHEET,
    headers: ['License Key', 'Status', 'Expiry Date', 'Hardware ID', 'Chat Room ID', 'Activated At', 'Max Devices']
  },
  {
    name: BINDING_SHEET,
    headers: ['License Key', 'Hardware ID', 'Chat Room ID', 'Activated At']
  },
  {
    name: SETTINGS_SHEET,
    headers: ['Key', 'Value', 'Updated At']
  },
];

function ensureTabs_() {
  const parent = SpreadsheetApp.getActive();
  if (!parent) {
    throw new Error('Script chưa gắn với Google Sheet nào. Trong Apps Script: File → Project settings → chọn Sheet, hoặc tạo script từ trong Google Sheet (Extensions → Apps Script).');
  }
  const report = [];
  for (const spec of SHEET_SPECS) {
    let sheet = parent.getSheetByName(spec.name);
    const existed = !!sheet;
    if (!sheet) sheet = parent.insertSheet(spec.name);
    const added = ensureColumns_(sheet, spec.headers);
    report.push({ tab: spec.name, existed, columnsAdded: added.length });
  }
  // Sheet mới tạo có sẵn một tab "Sheet1" / "Trang tính 1" không dùng đến. Dọn
  // cho gọn, nhưng CHỈ khi: đúng một tab thừa, tab đó rỗng, và tên đúng là tên
  // mặc định. Không đoán mò — xoá nhầm là mất dữ liệu thật.
  try {
    const all = parent.getSheets();
    const extras = all.filter(s => SHEET_SPECS.every(spec => spec.name !== s.getName()));
    const DEFAULT_NAMES = /^(Sheet1|Trang tính 1|Trang tính1|工作表 1|Sheet01)$/;
    if (extras.length === 1 && all.length > 1 && extras[0].getLastRow() === 0 && DEFAULT_NAMES.test(extras[0].getName())) {
      parent.deleteSheet(extras[0]);
    }
  } catch (error) {
    // Không xoá được tab rác không sao — chỉ là cosmetic.
  }
  // Trả về tóm tắt để `clasp run ensureTabs_` in ra được, và để chẩn đoán
  // khi cấu trúc Sheet lệch. doPost không dùng giá trị này.
  return report;
}

function appendMapped_(sheet, values) {
  const header = rows_(sheet).header;
  if (!header.length) throw new Error(`Sheet ${sheet.getName()} is missing a header row.`);
  const row = new Array(header.length).fill('');
  for (const name of Object.keys(values)) {
    const index = header.indexOf(name);
    if (index >= 0) row[index] = values[name];
  }
  sheet.appendRow(row);
  return row;
}

// ==========================================
// TRẠNG THÁI BẢN QUYỀN
// ==========================================
function trialEnd_(firstInstall) {
  if (!firstInstall) return null;
  const start = new Date(firstInstall);
  if (isNaN(start.getTime())) return null;
  const end = new Date(start.getTime());
  end.setDate(end.getDate() + TRIAL_DAYS);
  return end;
}

// Status chỉ được lưu thô trên Sheet (Unactivated/Active/Locked) rồi dịch sang
// trạng thái mà app hiểu. Hạn dùng thử luôn tính lại từ First Install Time, nên
// khách cài lại máy vẫn không reset được 3 ngày dùng thử.
function deviceResult_(row, header) {
  const statusCol = cell_(header, 'Status');
  const expiryCol = cell_(header, 'Expiry Date');
  const hardwareCol = cell_(header, 'Hardware ID');
  const keyCol = optional_(header, 'License Key');
  const roomCol = optional_(header, 'Chat Room ID');
  const hashCol = optional_(header, 'Hardware Hash');
  const firstCol = optional_(header, 'First Install Time');
  const rawStatus = String(row[statusCol] || '').trim();
  const lower = rawStatus.toLowerCase();
  const expiry = row[expiryCol] || '';
  const result = {
    status: rawStatus || 'Unactivated',
    expiryAt: expiry,
    trial: false,
    hardwareId: String(row[hardwareCol] || ''),
    machineId: optional_(header, 'Machine ID') >= 0 ? String(row[optional_(header, 'Machine ID')] || '') : '',
    keyName: keyCol >= 0 ? String(row[keyCol] || '') : '',
    chatRoomId: roomCol >= 0 ? String(row[roomCol] || '') : '',
    hardwareHash: hashCol >= 0 ? String(row[hashCol] || '') : ''
  };

  if (lower === 'unactivated' || lower === 'invalid' || lower === '') {
    const trialEnd = trialEnd_(firstCol >= 0 ? row[firstCol] : null);
    result.trial = true;
    result.expiryAt = trialEnd || '';
    result.status = trialEnd && trialEnd.getTime() < Date.now() ? 'Expired' : 'Trial';
  } else if (lower === 'active' && expiry && new Date(expiry).getTime() < Date.now()) {
    result.status = 'Expired';
  }
  return result;
}

// ==========================================
// ĐĂNG KÝ THIẾT BỊ (Bước 2)
// ==========================================
function registerDevice_(input) {
  const sheet = deviceSheet_();
  ensureColumns_(sheet, DEVICE_OPTIONAL_COLUMNS);
  const data = rows_(sheet);
  const header = data.header;
  const hardwareCol = cell_(header, 'Hardware ID');
  const machineCol = optional_(header, 'Machine ID');
  const installId = String(input.installationId || '');
  const machineId = String(input.machineId || '').trim();
  const roomId = String(input.chatRoomId || '');
  const phone = String(input.phone || '').trim();
  const name = String(input.name || '').trim();
  const plan = String(input.plan || '').trim();
  const hash = String(input.hardwareHash || '').trim();

  const match = findDevice_(data, input);
  let found = match.index;

  // Khớp được mà cột Machine ID còn trống (khách lên từ bản cũ): ghi mã máy ổn
  // định vào đó. Từ lần sau, kể cả khi khách cài lại app và mất hết dữ liệu cục bộ,
  // bước 1 của findDevice_() vẫn ra đúng dòng này — không mất key, không reset thử.
  if (found >= 0 && machineId && machineCol >= 0) {
    const current = String(data.values[found][machineCol] || '').trim();
    if (current !== machineId) {
      sheet.getRange(found + 2, machineCol + 1).setValue(machineId);
      data.values[found][machineCol] = machineId;
    }
  }

  // KHÔNG ghi lại cột Hardware ID khi đã khớp dòng. Khớp theo Machine ID nghĩa
  // là cùng một máy: giữ nguyên UUID cũ trong cột đó, vì Machine ID mới là
  // định danh thật. Ghi đè chỉ tạo nhiễu và từng làm hỏng liên kết bản quyền.

  if (found < 0) {
    // Máy mới kết nối lần đầu: tạo record, dùng thử bắt đầu tính từ First Install Time.
    // chatRoomId giữ đúng giá trị EXE gửi lên; Telegram không đi qua Apps Script.
    const row = appendMapped_(sheet, {
      'Hardware ID': installId,
      'Machine ID': machineId,
      'Chat Room ID': roomId,
      'License Key': '',
      'Status': 'Unactivated',
      'Expiry Date': '',
      'First Install Time': new Date(),
      'Last Seen Time': new Date(),
      'Phone': phone,
      'Name': name,
      'Plan': plan,
      'Hardware Hash': hash
    });

    return { ...deviceResult_(row, header), registered: true, trialDays: TRIAL_DAYS };
  }

  // Máy đã có: cập nhật lần cuối, dấu vân tay phần cứng và thông tin liên hệ.
  // Không tự đổi Chat Room ID — phòng chat chỉ đổi khi có reset thiết bị rõ ràng.
  const rowNumber = found + 2;
  const row = data.values[found];
  const update = (name, value) => {
    const index = optional_(header, name);
    if (index < 0 || value === undefined) return false;
    const before = String(row[index] === undefined || row[index] === null ? '' : row[index]).trim();
    sheet.getRange(rowNumber, index + 1).setValue(value);
    row[index] = value;
    return before !== String(value === null ? '' : value).trim();
  };

  update('Last Seen Time', new Date());
  if (machineId) update('Machine ID', machineId);
  if (hash) update('Hardware Hash', hash);
  if (phone) update('Phone', phone);
  if (name) update('Name', name);
  if (plan) update('Plan', plan);

  return { ...deviceResult_(row, header), registered: false };
}

// rebindDevice_() đã bị GỠ. Nó tồn tại để "chuyển chủ liên kết" khi khớp dòng
// bằng Hardware Hash; nay đã bỏ đường khớp đó (xem findDevice_). Giữ lại hàm
// không dùng chỉ để tránh tái phát: nó từng ném ReferenceError vì dùng biến
// `roomId` không tồn tại trong phạm vi, làm register_device chết âm thầm.

// ==========================================
// KÍCH HOẠT KEY (Bước 5, hỗ trợ giới hạn số máy)
// ==========================================
function maxDevices_(license, header) {
  const index = optional_(header, 'Max Devices');
  const value = index >= 0 ? parseInt(license[index], 10) : NaN;
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function boundDevices_(key) {
  const sheet = bindingsSheet_();
  if (!sheet) return null;
  const data = rows_(sheet);
  const keyCol = cell_(data.header, 'License Key');
  return { header: data.header, values: data.values.filter(row => String(row[keyCol] || '').trim() === String(key).trim()) };
}

function verifyKey_(input) {
  const key = String(input.key || input.licenseKey || '').trim();
  if (!key) throw new Error('License key is required.');

  const licenses = licenseSheet_();
  const data = rows_(licenses);
  const keyCol = cell_(data.header, 'License Key');
  const statusCol = cell_(data.header, 'Status');
  const expiryCol = cell_(data.header, 'Expiry Date');
  const boundCol = cell_(data.header, 'Hardware ID');
  const found = find_(data.values, keyCol, key);
  if (found < 0) throw new Error('License key does not exist.');

  const license = data.values[found];
  const status = String(license[statusCol] || '').toLowerCase();
  const expiry = license[expiryCol] ? new Date(license[expiryCol]) : null;
  if (status !== 'active') throw new Error('License is not active.');
  if (expiry && expiry.getTime() < Date.now()) throw new Error('License has expired.');

  // Kiểm tra thiết bị trước khi ghi bất cứ thứ gì, tránh buộc key vào máy chưa đăng ký.
  const devices = deviceSheet_();
  ensureColumns_(devices, DEVICE_OPTIONAL_COLUMNS);
  const deviceData = rows_(devices);
  const deviceStatusCol = cell_(deviceData.header, 'Status');
  const deviceRow = findDevice_(deviceData, input).index;
  if (deviceRow < 0) throw new Error('Device must be registered before activation.');

  const device = deviceData.values[deviceRow];
  if (String(device[deviceStatusCol] || '').toLowerCase() === 'locked') {
    throw new Error('Device is locked.');
  }

  const bindings = boundDevices_(key);
  const boundList = bindings ? bindings.values : [];
  const boundHardwareCol = bindings ? cell_(bindings.header, 'Hardware ID') : -1;
  const legacyBound = String(license[boundCol] || '').trim();
  const alreadyHere = boundList.some(row => String(row[boundHardwareCol] || '').trim() === input.installationId) || legacyBound === input.installationId;
  if (!alreadyHere) {
    const limit = maxDevices_(license, data.header);
    const used = boundList.length || (legacyBound ? 1 : 0);
    if (used >= limit) {
      // Bước 5: báo cho app biết key đã hết slot máy.
      return { status: 'device_limit_exceeded', expiryAt: license[expiryCol] || '', keyName: key, limit: limit };
    }
    if (bindings) {
      appendMapped_(bindingsSheet_(), {
        'License Key': key,
        'Hardware ID': input.installationId,
        'Chat Room ID': input.chatRoomId,
        'Activated At': new Date()
      });
    }
  }

  licenses.getRange(found + 2, boundCol + 1).setValue(legacyBound || input.installationId);
  // Phòng chat đã ghi một lần thì giữ nguyên, không đổi theo lần kích hoạt sau.
  const licenseRoomCol = cell_(data.header, 'Chat Room ID');
  if (!String(license[licenseRoomCol] || '').trim()) {
    licenses.getRange(found + 2, licenseRoomCol + 1).setValue(input.chatRoomId);
  }
  licenses.getRange(found + 2, cell_(data.header, 'Activated At') + 1).setValue(new Date());

  devices.getRange(deviceRow + 2, cell_(deviceData.header, 'License Key') + 1).setValue(key);
  devices.getRange(deviceRow + 2, deviceStatusCol + 1).setValue('Active');
  devices.getRange(deviceRow + 2, cell_(deviceData.header, 'Expiry Date') + 1).setValue(license[expiryCol] || '');

  const machineCol = optional_(deviceData.header, 'Machine ID');
  const deviceMachineId = machineCol >= 0 ? String(device[machineCol] || '').trim() : '';
  return {
    status: 'Active',
    expiryAt: license[expiryCol] || '',
    keyName: key,
    hardwareId: input.installationId,
    machineId: deviceMachineId || String(input.machineId || '').trim(),
    chatRoomId: input.chatRoomId
  };
}

function licenseStatus_(input) {
  const sheet = deviceSheet_();
  ensureColumns_(sheet, DEVICE_OPTIONAL_COLUMNS);
  const data = rows_(sheet);
  const found = findDevice_(data, input).index;
  if (found < 0) return { status: 'Unactivated' };
  return deviceResult_(data.values[found], data.header);
}

function notice_() {
  const sheet = sheet_(SETTINGS_SHEET);
  if (!sheet) return null;
  const data = rows_(sheet);
  const keyCol = optional_(data.header, 'Key');
  const valueCol = optional_(data.header, 'Value');
  if (keyCol < 0 || valueCol < 0) return null;
  const row = data.values.find(item => String(item[keyCol] || '').trim().toLowerCase() === 'notice');
  const text = row ? String(row[valueCol] || '').trim() : '';
  if (!text) return null;
  const updatedCol = optional_(data.header, 'Updated At');
  return { text: text, updatedAt: updatedCol >= 0 && row[updatedCol] ? new Date(row[updatedCol]).getTime() : Date.now() };
}

// Ghi hạn/trạng thái trở lại dòng Licenses để hai sheet không lệch nhau.
function syncLicense_(deviceRow, deviceHeader, patch) {
  const keyCol = optional_(deviceHeader, 'License Key');
  const key = keyCol >= 0 ? String(deviceRow[keyCol] || '').trim() : '';
  if (!key) return;
  const licenses = licenseSheet_();
  const data = rows_(licenses);
  const index = find_(data.values, cell_(data.header, 'License Key'), key);
  if (index < 0) return;
  if (patch.expiry !== undefined) licenses.getRange(index + 2, cell_(data.header, 'Expiry Date') + 1).setValue(patch.expiry);
  if (patch.status !== undefined) licenses.getRange(index + 2, cell_(data.header, 'Status') + 1).setValue(patch.status);
  if (patch.hardwareId !== undefined) licenses.getRange(index + 2, cell_(data.header, 'Hardware ID') + 1).setValue(patch.hardwareId);
}

// /reset: gỡ liên kết máy để khách kích hoạt sang máy khác — phải gỡ cả Licenses/Bindings.
function releaseBinding_(key, hardwareId) {
  const bindings = bindingsSheet_();
  if (bindings && key) {
    const data = rows_(bindings);
    const keyCol = cell_(data.header, 'License Key');
    const hardwareCol = cell_(data.header, 'Hardware ID');
    for (let index = data.values.length - 1; index >= 0; index--) {
      const sameKey = String(data.values[index][keyCol] || '').trim() === key;
      // Chỉ gỡ đúng liên kết của máy này, không đụng tới các máy khác dùng chung key.
      const sameDevice = String(data.values[index][hardwareCol] || '').trim() === hardwareId;
      if (sameKey && sameDevice) bindings.deleteRow(index + 2);
    }
  }
  if (!key || !hardwareId) return;
  const licenses = licenseSheet_();
  const data = rows_(licenses);
  const hardwareCol = cell_(data.header, 'Hardware ID');
  const index = find_(data.values, hardwareCol, hardwareId);
  if (index >= 0 && String(data.values[index][cell_(data.header, 'License Key')] || '').trim() === key) {
    licenses.getRange(index + 2, hardwareCol + 1).setValue('');
  }
}

// ==========================================
// LỆNH QUẢN TRỊ QUA GATEWAY (Hướng 1)
// ==========================================
// Gateway nhận lệnh trong Topic Telegram rồi gọi action admin_command; Apps Script chỉ
// đọc/ghi Google Sheet và trả về nội dung trả lời, Gateway gửi nội dung đó lại vào Topic.
// Định vị thiết bị bằng Chat Room ID của Topic (không dùng chung cột với id Topic).
// Trả lời ở dạng chữ thường, không Markdown, để tên/SĐT khách nhập không làm hỏng tin nhắn.
const ADMIN_HELP = [
  '📋 LỆNH QUẢN TRỊ',
  '/check — xem thông tin bản quyền của máy trong Topic này',
  '/new [thang|nam] [số_máy] — cấp key mới (mặc định 30 ngày, 1 máy)',
  '/extend [số_ngày] — gia hạn thêm (cập nhật cả Devices và Licenses)',
  '/reset — gỡ liên kết máy để khách kích hoạt sang máy khác',
  '/lock | /unlock — khóa / mở khóa thiết bị'
].join('\n');

function adminDate_(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (isNaN(date.getTime())) return '';
  return Utilities.formatDate(date, 'GMT+7', 'dd/MM/yyyy');
}

function adminCommand_(input) {
  const text = String(input.text || input.command || '').trim();
  const room = String(input.chatRoomId || '').trim();
  const sheet = deviceSheet_();
  const data = rows_(sheet);
  const header = data.header;
  const roomCol = cell_(header, 'Chat Room ID');
  const hardwareCol = cell_(header, 'Hardware ID');
  const index = find_(data.values, roomCol, room);

  if (index < 0) {
    return {
      found: false,
      reply: '⚠️ Không tìm thấy thiết bị liên kết với Topic này.\nKiểm tra cột Chat Room ID trong tab Devices có đúng "' + room + '" hay không.'
    };
  }

  const row = data.values[index];
  const rowNumber = index + 2;
  const parts = text.split(/\s+/).filter(Boolean);
  // Bỏ hậu tố @BotName mà Telegram thêm vào lệnh trong group.
  const command = (parts[0] || '/check').toLowerCase().replace(/@[\w_]+$/, '');
  const installationId = String(row[hardwareCol] || '');
  // Kèm luôn trạng thái hiện tại: Gateway nhận lệnh từ Telegram rồi cập nhật bản
  // ghi nhớ phía Firebase để app hỏi nhẹ (/v1/ping) thấy ngay /lock, /unlock,
  // /reset mà không phải đụng vào Apps Script. Không có hai trường này thì
  // lệnh quản trị chỉ đổi được Sheet mà app không nhận ra.
  const snapshot = deviceResult_(row, header);
  const result = { found: true, installationId, chatRoomId: room, status: snapshot.status, expiryAt: snapshot.expiryAt, trial: snapshot.trial };

  // /check — thông tin bản quyền
  if (command === '/check' || command === '/info') {
    const info = deviceResult_(row, header);
    const phoneCol = optional_(header, 'Phone');
    const nameCol = optional_(header, 'Name');
    const planCol = optional_(header, 'Plan');
    const customer = nameCol >= 0 ? String(row[nameCol] || '').trim() : '';
    const phone = phoneCol >= 0 ? String(row[phoneCol] || '').trim() : '';
    const plan = planCol >= 0 ? String(row[planCol] || '').trim() : '';
    const lines = [
      '📊 THÔNG TIN BẢN QUYỀN',
      '🆔 Máy: ' + installationId,
      '💬 Phòng chat: ' + room,
      '🔑 Key: ' + (info.keyName || 'Chưa có'),
      '⏳ Hạn: ' + (adminDate_(info.expiryAt) || 'Không có') + (info.trial ? ' (dùng thử ' + TRIAL_DAYS + ' ngày)' : ''),
      '⚡ Trạng thái: ' + info.status
    ];
    if (customer || phone) lines.push('👤 Khách: ' + (customer || '—') + ' · 📞 ' + (phone || '—'));
    if (plan) lines.push('📦 Gói: ' + plan);
    // Số máy: chỉ hiện khi máy này đã gắn key — máy đang dùng thử thì chưa có key
    // nên "số máy" không có ý nghĩa, hiện ra chỉ gây nhiễu.
    const slot = slots_(info.keyName);
    if (slot) lines.push('💻 Số máy: ' + slot.used + '/' + slot.max + (slot.max > 1 ? ' (còn ' + Math.max(0, slot.max - slot.used) + ' slot)' : ''));
    return { ...result, maxDevices: slot ? slot.max : 0, usedSlots: slot ? slot.used : 0, reply: lines.join('\n') };
  }

  // /new [thang|nam] [số_máy]
  if (command === '/new') {
    const days = (parts[1] || 'thang').toLowerCase() === 'nam' ? 365 : 30;
    const slots = parseInt(parts[2], 10);
    const maxDevices = Number.isFinite(slots) && slots > 0 ? slots : 1;
    const newKey = 'KEY-' + Utilities.getUuid().replace(/-/g, '').substring(0, 8).toUpperCase();
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + days);

    appendMapped_(licenseSheet_(), {
      'License Key': newKey,
      'Status': 'Active',
      'Expiry Date': expiry,
      'Hardware ID': '',
      'Chat Room ID': room,
      'Activated At': new Date(),
      'Max Devices': maxDevices > 1 ? maxDevices : ''
    });
    sheet.getRange(rowNumber, cell_(header, 'License Key') + 1).setValue(newKey);
    sheet.getRange(rowNumber, cell_(header, 'Status') + 1).setValue('Active');
    sheet.getRange(rowNumber, cell_(header, 'Expiry Date') + 1).setValue(expiry);

    return { ...result, keyName: newKey, maxDevices: maxDevices, usedSlots: 0, reply: ['🎉 CẤP KEY THÀNH CÔNG!', '🔑 Key: ' + newKey, '⏳ Hạn: ' + adminDate_(expiry), '💻 Số máy: 0/' + maxDevices + ' slot' + (maxDevices > 1 ? ' (chưa gán máy nào)' : '')].join('\n') };
  }

  // /extend [số_ngày]
  if (command === '/extend') {
    const days = parseInt(parts[1], 10) || 30;
    const expiryCol = cell_(header, 'Expiry Date');
    const current = row[expiryCol];
    const base = current && new Date(current) > new Date() ? new Date(current) : new Date();
    base.setDate(base.getDate() + days);
    sheet.getRange(rowNumber, expiryCol + 1).setValue(base);
    sheet.getRange(rowNumber, cell_(header, 'Status') + 1).setValue('Active');
    syncLicense_(row, header, { expiry: base, status: 'Active' });
    return { ...result, reply: '⏳ Đã gia hạn thêm ' + days + ' ngày.\n📅 Hạn mới: ' + adminDate_(base) };
  }

  // /reset — gỡ liên kết máy
  if (command === '/reset') {
    const keyCol = optional_(header, 'License Key');
    const key = keyCol >= 0 ? String(row[keyCol] || '').trim() : '';
    // KHÔNG xoá Hardware ID / Machine ID.
    // Trước đây lệnh này xoá Hardware ID — mà đó chính là khoá để tìm dòng máy,
    // nên khách bấm kích hoạt lại sẽ báo "Device must be registered" và phải tắt
    // app rồi mở lại mới được, dù bot đã báo "khách có thể kích hoạt lại".
    // /reset chỉ cần trả lại suất máy của key và tắt bản quyền trên máy này.
    sheet.getRange(rowNumber, cell_(header, 'Status') + 1).setValue('Unactivated');
    releaseBinding_(key, installationId);
    return { ...result, reply: '🔄 Đã reset liên kết máy thành công. Khách có thể kích hoạt lại ngay trên máy này, hoặc trên máy khác.' };
  }

  // /lock | /unlock
  if (command === '/lock') {
    sheet.getRange(rowNumber, cell_(header, 'Status') + 1).setValue('Locked');
    return { ...result, reply: '🔒 Đã khóa bản quyền thiết bị này.' };
  }
  if (command === '/unlock') {
    const keyCol = optional_(header, 'License Key');
    const key = keyCol >= 0 ? String(row[keyCol] || '').trim() : '';
    // Máy chưa có key thì trả về Unactivated để vẫn tính theo hạn dùng thử,
    // không vô tình biến thành bản quyền không thời hạn.
    sheet.getRange(rowNumber, cell_(header, 'Status') + 1).setValue(key ? 'Active' : 'Unactivated');
    return { ...result, reply: '🔓 Đã mở khóa thiết bị.' + (key ? '' : '\nMáy chưa có key nên vẫn tính theo hạn dùng thử.') };
  }

  return { ...result, reply: '❓ Không hiểu lệnh "' + command + '".\n\n' + ADMIN_HELP };
}
