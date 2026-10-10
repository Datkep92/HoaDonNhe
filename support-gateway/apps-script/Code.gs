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
 * tab AI_PROFILES: Alias | Active | Base URL | Model | API Keys | Updated At | Updated By
 *   Cấu hình AI cho bot (url + model + nhiều API key để xoay vòng). Admin sửa
 *   bằng lệnh /ai... trên Telegram; Gateway đọc tab này để gọi AI thay máy
 *   khách, nên API key KHÔNG bao giờ đi xuống máy khách.
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
const AI_SHEET = 'AI_PROFILES';
// Cấu hình AI nên nằm ở Sheet RIÊNG, không nhét vào Sheet bản quyền: khi đó có
// thể chia sẻ Sheet CRM cho kế toán/nhân sự mà không kéo theo API key của bot.
// Script Property AI_CONFIG_SPREADSHEET_ID trỏ tới Sheet đó (chỉ ID nằm trong
// property, không nằm trong code). Để trống thì rơi về tab AI_PROFILES của Sheet
// CRM — đường cũ vẫn chạy được, không ai bị mất cấu hình đang dùng.
const AI_CONFIG_PROPERTY = 'AI_CONFIG_SPREADSHEET_ID';
const AI_EXTERNAL_SHEET = 'PROFILES';
const TRIAL_DAYS = 30;

// Tên gọi cấu hình AI và API key: chỉ ký tự an toàn để dùng được trong vòng lệnh
// Telegram (alias trong lệnh, key dán thẳng sau lệnh). Chặn ký tự lạ để một ô
// viết sai không biến thành công thức hay đường dẫn ngoài ý muốn.
const AI_ALIAS_PATTERN = /^[A-Za-z0-9_.-]{1,40}$/;
const AI_KEY_PATTERN = /^[A-Za-z0-9._~+/=-]{8,200}$/;

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
const DEVICE_OPTIONAL_COLUMNS = ['Phone', 'Name', 'Plan', 'Hardware Hash', 'Machine ID', 'Telegram Topic ID', 'First Install Time', 'Last Seen Time', 'License Key', 'Chat Room ID', 'Hardware ID V2'];


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

    // Script mới chưa gắn Sheet nào vẫn phải phục vụ được: Gateway nhận cấu
    // hình AI qua action riêng và KHÔNG cần tới Sheet CRM. Nếu cứ chạy
    // ensureTabs_() ở đây thì mọi lệnh /ai trên Telegram chết ngay ở máy chủ
    // cho tới khi admin dựng xong Sheet CRM — lúc đó nhân viên lại không cài
    // được app để dùng.
    // Secret phải kiểm TRƯỚC mọi việc khác: không có secret thì không đụng
    // vào Sheet nào, kể cả việc tự tạo tab.
    const expectedSecret = PropertiesService.getScriptProperties().getProperty('GATEWAY_SHARED_SECRET');
    if (!expectedSecret || input.gatewaySecret !== expectedSecret) {
      throw new Error('Unauthorized gateway.');
    }
    // Sheet mới tạo chưa có tab nào -> tạo trước rồi mới xử lý. Đây cũng là bước
    // tự phục hồi: đã có đủ tab thì không động vào gì.
    if (needsCrm_(input.action)) ensureTabs_();

    const action = String(input.action || '');
    if(action === 'billing_setup') return reply_({ok:true,value:billingSetup_(input)});
    if(action === 'billing') return reply_({ok:true,value:billingAction_(input)});
    const chatRoomId = String(input.chatRoomId || '');
    const installId = String(input.installationId || '');

    // Lệnh quản trị do Gateway chuyển tiếp (lấy từ Topic Telegram) chỉ cần biết phòng chat;
    // Apps Script không tự nói chuyện với Telegram, Gateway lo phần gửi/nhận.
    if (action === 'admin_command') {
      if (!ROOM_PATTERN.test(chatRoomId)) throw new Error('Invalid device identity.');
      return reply_({ ok: true, value: billingAdminResult_(adminCommand_(input),input) });
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

    // Cấu hình AI của bot: cũng là lệnh TOÀN CỤC của admin như /online, vì
    // url/model/key dùng chung cho mọi máy chứ không gắn với phòng nào.
    // KHÔNG trả key cho app: chỉ Gateway gọi được (đã qua khoá gatewaySecret).
    if (action === 'ai_admin') {
      return reply_({ ok: true, value: aiAdmin_(input) });
    }
    if (action === 'ai_config') {
      // Chỉ Gateway gọi được (đã qua khoá gatewaySecret) và đây là nơi duy
      // nhất trả API key ra ngoài Sheet — app không bao giờ nhận key.
      return reply_({ ok: true, value: aiConfig_(input) });
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
      billingHardware_(input);
    } else if (action === 'verify_key') {
      result = verifyKey_(input);
    } else if (action === 'license_status') {
      result = licenseStatus_(input);
    } else if (action === 'get_notice') {
      result = notice_();
    } else {
      throw new Error('Unknown action.');
    }

    if(['register_device','verify_key','license_status'].indexOf(action)>=0) result=billingAttach_(result,input);
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

  const hw=String(input.hardwareIdV2||'');
  if(hw) {
    if(!/^HW2-[A-F0-9]{32}$/.test(hw)) throw new Error('Hardware ID không hợp lệ.');
    const matches=data.values.map((r,i)=>String(r[optional_(header,'Hardware ID V2')]||'')===hw?i:-1).filter(i=>i>=0);
    if(matches.length>1)throw new Error('Hardware ID trùng; liên hệ Admin.');
    if(matches.length===1)return {index:matches[0],via:'hardwareIdV2'};
  }
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
  {
    name: AI_SHEET,
    headers: ['Alias', 'Active', 'Base URL', 'Model', 'API Keys', 'Order', 'Updated At', 'Updated By']
  },
];

// Action nào cần tới Sheet CRM. Các action AI không cần: chúng đọc Sheet cấu
// hình riêng (nếu có) và luôn phải chạy được kể cả khi script chưa gắn Sheet.
function needsCrm_(action) {
  return String(action || '') !== 'ai_admin' && String(action || '') !== 'ai_config';
}

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
  const canonicalInstall=String(device[cell_(deviceData.header,'Hardware ID')]||input.installationId);
  const alreadyHere = boundList.some(row => String(row[boundHardwareCol] || '').trim() === input.installationId || String(row[boundHardwareCol]||'').trim()===canonicalInstall) || legacyBound === input.installationId || legacyBound===canonicalInstall;
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
        'Hardware ID': canonicalInstall,
        'Chat Room ID': input.chatRoomId,
        'Activated At': new Date()
      });
    }
  }

  licenses.getRange(found + 2, boundCol + 1).setValue(legacyBound || canonicalInstall);
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
  '/lock | /unlock — khóa / mở khóa thiết bị',
  '/ai — cấu hình AI của bot (url, model, API key)',
].join('\n');

function adminDate_(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (isNaN(date.getTime())) return '';
  return Utilities.formatDate(date, 'GMT+7', 'dd/MM/yyyy');
}

function adminCommand_(input) {
  var commerce = billingAdmin_(input); if(commerce) return commerce;
  var lock=LockService.getScriptLock();lock.waitLock(30000);
  try {
    var receipt=input.requestId?billingJson_('AdminUIRequests',String(input.chatRoomId)+'|'+String(input.requestId).slice(0,200)):null;
    if(receipt&&receipt.value)return receipt.value;
    var out=adminLegacyCommand_(input);
    if(out.found){
      var fresh=rows_(deviceSheet_()),i=find_(fresh.values,cell_(fresh.header,'Chat Room ID'),input.chatRoomId);
      if(i>=0)Object.assign(out,deviceResult_(fresh.values[i],fresh.header));
      if(receipt)billingPut_(receipt,String(input.chatRoomId)+'|'+String(input.requestId).slice(0,200),out);
      if(input.requestId)billingTable_('AdminAudit',['Time','Room','Actor','Command']).appendRow([new Date(),input.chatRoomId,String(input.actor||''),String(input.text||input.command)]);
    }
    return out;
  } finally {lock.releaseLock();}
}
function adminLegacyCommand_(input) {
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
  if(input.expectedKey!==undefined&&String(row[cell_(header,'License Key')]||'')!==String(input.expectedKey))throw new Error('Key đã thay đổi. Mở lại menu và kiểm tra khách.');
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
      '🆔 Máy: ' + String(row[optional_(header,'Hardware ID V2')] || row[optional_(header,'Machine ID')] || installationId),
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
    const oldEnt=billingEntitlement_(String(row[cell_(header,'License Key')]||''));
    if(oldEnt){oldEnt.expiryAt=base.toISOString();oldEnt.revision++;billingPut_(billingJson_('KeyEntitlements',String(row[cell_(header,'License Key')])),String(row[cell_(header,'License Key')]),oldEnt);}
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

// ==========================================
// CẤU HÌNH AI DO ADMIN ĐẶT TỪ TELEGRAM (/ai)
// ==========================================
// Mục tiêu: admin đổi url / model / API key ngay trong Telegram, không phải sửa
// code hay đụng vào máy khách. Cấu hình nằm trên Sheet; Gateway đọc tab này để
// gọi AI hộ máy khách và xoay key khi hết quota.
//
// Ranh giới an toàn (đừng nới):
//   - Key chỉ trả cho Gateway, không trả cho app. App chỉ nhận câu trả lời của
//     model, không bao giờ thấy key.
//   - Chỉ nhận https. Gateway chạy ở Cloudflare nên localhost ở đây nghĩa là
//     chính Cloudflare, không phải máy khách -> không dùng được, chặn luôn.
//   - Mọi ô admin gõ đều đi qua kiểm tra trước khi ghi, và báo lại giá trị đã
//     lưu để admin nhìn thấy ngay kết quả (tránh lệnh sai mà tưởng đã đúng).
const AI_HELP = [
  '🤖 CẤU HÌNH AI',
  '/ai — xem cấu hình đang dùng',
  '/ai add <tên> <url> <model> — tạo mới hoặc sửa url/model',
  '/ai url <tên> <url> — chỉ đổi địa chỉ API',
  '/ai model <tên> <model> — chỉ đổi model',
  '/ai use <tên> — bật cấu hình này',
  '/ai del <tên> — xoá cấu hình',
  '/ai key <tên> add <key> — thêm API key (xoay vòng khi hết quota)',
  '/ai key <tên> list — xem key đang lưu (che giữa)',
  '/ai key <tên> del <số> — xoá key thứ n',
  '/ai key <tên> check — hướng dẫn kiểm tra key',
  '',
  'Trên Telegram có nút bấm: gõ /ai sẽ hiện menu quản lý (xem, bật, xoá, thêm key, kiểm tra key).',
].join('\n');

function aiMask_(key) {
  const value = String(key || '');
  if (value.length < 8) return '***';
  return value.slice(0, 6) + '...' + value.slice(-4) + ' (' + value.length + ' ký tự)';
}

function aiKeys_(value) {
  if (value instanceof Array) return value.map(item => String(item).trim()).filter(Boolean);
  // Nhiều key trong một ô: tách theo xuống dòng hoặc dấu phẩy, bỏ khoảng trắng.
  return String(value == null ? '' : value).split(/[\n,;]+/).map(item => item.trim()).filter(Boolean);
}

// Số thứ tự cho dòng mới: lấy lớn nhất đang có rồi +10. Cách này giữ được
// thứ tự ưu tiên của các dòng cũ thay vì dồn tất cả vào một số bằng nhau.
function nextOrder_(data) {
  const column = optional_(data.header, 'Order');
  if (column < 0) return '';
  let biggest = 0;
  for (const row of data.values) {
    const value = Number(row[column]);
    if (Number.isFinite(value) && value > biggest) biggest = value;
  }
  return biggest + 10;
}

function aiNormalizeUrl_(value) {
  const raw = String(value || '').trim();
  if (!/^https:\/\/[^\s/$.?#].[^\s]*$/i.test(raw)) throw new Error('URL phải bắt đầu bằng https://');
  if (/@/.test(raw)) throw new Error('URL chứa thông tin đăng nhập — không nhận dạng hình thức này.');
  return raw.replace(/\/+$/, '');
}

function aiNormalizeModel_(value) {
  const raw = String(value || '').trim();
  if (!/^[A-Za-z0-9._:/|-]{1,120}$/.test(raw)) throw new Error('Model chỉ gồm chữ/số và các ký tự . _ : / | -');
  return raw;
}

// Nguồn cấu hình AI: Sheet RIÊNG nếu Script Property có trỏ tới, không thì
// rơi về tab AI_PROFILES của Sheet CRM (đường cũ). Sheet riêng có thể tạo
// tay với đúng tên tab PROFILES, cũng có thể để script tự tạo — miễn là AI nằm
// ngoài Sheet CRM thì không đụng vào cấu trúc CRM đang chạy.
const AI_HEADERS = ['Alias', 'Active', 'Base URL', 'Model', 'API Keys', 'Order', 'Updated At', 'Updated By'];

// Sheet vừa tạo còn trống hoàn toàn: ensureColumns_() cố tình không ghi khi
// chưa có hàng tiêu đề, nên ở đây tự ghi. Không có bước này thì lệnh /ai đầu
// tiên sẽ chết vì thiếu cột Alias trong khi admin mới tạo Sheet.
function aiPrepare_(sheet) {
  if (!rows_(sheet).header.length) sheet.getRange(1, 1, 1, AI_HEADERS.length).setValues([AI_HEADERS]);
  else ensureColumns_(sheet, AI_HEADERS);
  return sheet;
}

// Tạo Sheet riêng cho cấu hình AI rồi tự trỏ Script Property vào đó.
// Chạy một lần bằng:  clasp run setupAiConfigSheet
// (hoặc trong Apps Script editor: chọn hàm này rồi Run — hữu ích khi không có CLI).
// Vì sao cần hàm này: cấu hình AI chứa API key, tách khỏi Sheet bản quyền thì có
// thể chia sẻ Sheet CRM cho kế toán mà không lộ key. Làm thủ công thì dễ quên
// tạo tab đúng tên, và mọi lệnh /ai sẽ báo lỗi vì không tìm thấy nơi lưu.
function setupAiConfigSheet() {
  const existing = String(PropertiesService.getScriptProperties().getProperty(AI_CONFIG_PROPERTY) || '').trim();
  if (existing) {
    return { ok: true, created: false, spreadsheetId: existing, url: 'https://docs.google.com/spreadsheets/d/' + existing + '/edit', note: 'Đã có ' + AI_CONFIG_PROPERTY + ', không tạo mới.' };
  }
  const name = 'HoaDonNhe_AI_Config';
  const doc = SpreadsheetApp.create(name);
  const sheets = doc.getSheets();
  // Sheet mới tạo có sẵn một tab (Sheet1). Bỏ hết rồi tạo đúng tên để không
  // phải đoán tên tab mặc định là gì theo ngôn ngữ tài khoản.
  for (const sheet of sheets.slice(1)) doc.deleteSheet(sheet);
  const sheet = sheets[0];
  sheet.setName(AI_EXTERNAL_SHEET);
  aiPrepare_(sheet);
  PropertiesService.getScriptProperties().setProperty(AI_CONFIG_PROPERTY, doc.getId());
  return { ok: true, created: true, spreadsheetId: doc.getId(), url: doc.getUrl(), tab: AI_EXTERNAL_SHEET, headers: AI_HEADERS };
}

// `idHint` là ID Sheet do Gateway truyền kèm (secret AI_CONFIG_SHEET_ID).
// Cần đường này vì Script Property không set được qua API mà không phải chạy
// code trong editor — mà Gateway thì deploy bằng CLI, không mở editor.
function aiSheet_(idHint) {
  const id = String(idHint || PropertiesService.getScriptProperties().getProperty(AI_CONFIG_PROPERTY) || '').trim();
  if (id) {
    let doc;
    try { doc = SpreadsheetApp.openById(id); }
    catch (error) { throw new Error('Không mở được Sheet cấu hình AI (' + id + '): ' + error.message); }
    let sheet = doc.getSheetByName(AI_EXTERNAL_SHEET);
    if (!sheet) {
      // Sheet admin vừa tạo có đúng một tab rỗng theo tên mặc định (Sheet1 / Trang
      // tính 1 / …). Đổi tên tab đó thay vì tạo thêm: nếu tạo thêm mà quên xoá,
      // Sheet sẽ có 2 tab và admin không biết tab nào là tab thật.
      const sheets = doc.getSheets() || [];
      const blank = sheets.length === 1 && sheets[0].getLastRow() === 0 ? sheets[0] : null;
      if (blank) { blank.setName(AI_EXTERNAL_SHEET); sheet = blank; }
      else sheet = doc.insertSheet(AI_EXTERNAL_SHEET);
    }
    return aiPrepare_(sheet);
  }
  // Chưa trỏ Sheet riêng: dùng tab AI_PROFILES của Sheet CRM, và TỰ TẠO nếu
  // thiếu — để lệnh /ai vẫn chạy được ngay thay vì bắt admin tạo tab bằng tay.
  let sheet = sheet_(AI_SHEET);
  if (!sheet) {
    const parent = SpreadsheetApp.getActive();
    if (!parent) {
      throw new Error('Chưa có nơi lưu cấu hình AI: script chưa gắn với Google Sheet nào, và Gateway chưa truyền ' + AI_CONFIG_PROPERTY + '.');
    }
    sheet = parent.insertSheet(AI_SHEET);
  }
  return aiPrepare_(sheet);
}

// Toàn bộ cấu hình AI dạng đọc được cho Gateway. Key trả về ở đây là toàn bộ
// (không che) vì chỉ Gateway gọi được action này qua gatewaySecret; tuyệt đối
// không đưa nhánh này vào bất kỳ action nào app gọi trực tiếp.
function aiConfig_(input) {
  const sheet = aiSheet_(input && input.aiSheetId);
  const data = rows_(sheet);
  const header = data.header;
  const aliasCol = cell_(header, 'Alias');
  const activeCol = optional_(header, 'Active');
  const urlCol = cell_(header, 'Base URL');
  const modelCol = cell_(header, 'Model');
  const keyCol = cell_(header, 'API Keys');
  const orderCol = optional_(header, 'Order');
  const profiles = [];
  for (const row of data.values) {
    const alias = String(row[aliasCol] || '').trim();
    if (!alias || !AI_ALIAS_PATTERN.test(alias)) continue;
    // Order trống = ưu tiên sau mọi dòng có số, để thêm dòng mới bằng tay không
    // bị chen vào giữa chuỗi dự phòng.
    const order = orderCol >= 0 && Number.isFinite(Number(row[orderCol])) ? Number(row[orderCol]) : 999;
    profiles.push({
      alias: alias,
      order: order,
      active: activeCol >= 0 && /^(1|true|yes|active|x|✓)$/i.test(String(row[activeCol] || '').trim()),
      baseURL: String(row[urlCol] || '').trim(),
      model: String(row[modelCol] || '').trim(),
      keys: aiKeys_(row[keyCol]),
    });
  }
  profiles.sort((a, b) => a.order - b.order);
  // Cấu hình đang bật: ưu tiên dòng Active, không có thì lấy dòng đầu tiên có
  // đủ url + model + key. Thiếu key thì coi như chưa dùng được — báo rõ hơn là
  // im lặng rồi lỗi "chưa cấu hình" khi khách chat.
  const usable = profiles.filter(p => p.baseURL && p.model && p.keys.length);
  const active = usable.find(p => p.active) || usable[0] || null;
  return {
    active: active ? active.alias : '',
    profiles: profiles.map(p => ({
      alias: p.alias,
      order: p.order,
      active: p.active,
      baseURL: p.baseURL,
      model: p.model,
      keys: p.keys,
      keyCount: p.keys.length,
      usable: !!(p.baseURL && p.model && p.keys.length),
    })),
  };
}

// `input` được truyền xuống chỉ để lấy aiSheetId; gọi aiView_() không có tham số
// vẫn đọc được (rơi về Script Property / Sheet CRM).
function aiView_(input) {
  const value = aiConfig_(input);
  if (!value.profiles.length) {
    return '🤖 CHƯA CÓ CẤU HÌNH AI\n\nThêm bằng:\n/ai add <tên> <url> <model>\n/ai key <tên> add <key>\n\n' + AI_HELP;
  }
  const lines = ['🤖 CẤU HÌNH AI'];
  for (const p of value.profiles) {
    const mark = p.alias === value.active ? '▶️' : '  ';
    lines.push('');
    lines.push(mark + ' ' + p.alias + (p.alias === value.active ? '  (đang dùng)' : ''));
    lines.push('   URL: ' + (p.baseURL || '⚠️ thiếu URL'));
    lines.push('   Model: ' + (p.model || '⚠️ thiếu model'));
    lines.push('   Key: ' + (p.keyCount ? p.keyCount + ' key' : '⚠️ chưa có key'));
    lines.push('   Thứ tự dự phòng: ' + p.order);
  }
  if (!value.active) lines.push('', '⚠️ Chưa cấu hình nào đủ url + model + key. Bot sẽ báo lỗi khi khách chat.');
  return lines.join('\n');
}

// Xử lý /ai... của admin. Trả về { reply, config } để Gateway lưu luôn bản cấu
// hình mới và app dùng ngay ở lượt kế tiếp, không chờ hết hạn cache.
function aiAdmin_(input) {
  const text = String(input.text || '').trim();
  const parts = text.split(/\s+/).filter(Boolean);
  const command = (parts[0] || '').toLowerCase().replace(/@[\w_]+$/, '');
  const done = reply => ({ ok: true, reply: reply, config: aiConfig_(input) });

  if (!/^\/ai/.test(command)) return done('❓ Lệnh này không phải lệnh cấu hình AI.\n\n' + AI_HELP);
  // `/ai` để xem, `/ai help` để xem cú pháp. Còn lại thì đọc tiếp từ parts[1]:
  // Telegram gửi lệnh với dấu cách ("/ai add ...") nên phần phụ KHÔNG nằm trong
  // parts[0] — trước đây gộp chung dẫn tới việc mọi lệnh con đều rơi về AI_HELP.
  const rest = parts.slice(1);
  if (!rest.length) return done(aiView_(input));
  if (/^(help|huongdan|hd)$/i.test(rest[0])) return done(AI_HELP);

  const sheet = aiSheet_(input && input.aiSheetId);
  const data = rows_(sheet);
  const header = data.header;
  const aliasCol = cell_(header, 'Alias');
  const activeCol = cell_(header, 'Active');
  const urlCol = cell_(header, 'Base URL');
  const modelCol = cell_(header, 'Model');
  const keyCol = cell_(header, 'API Keys');
  const stampCol = cell_(header, 'Updated At');
  const byCol = cell_(header, 'Updated By');
  const who = String(input.updatedBy || 'telegram').slice(0, 40);
  const rowOf = alias => {
    const index = find_(data.values, aliasCol, alias);
    return index < 0 ? -1 : index + 2;
  };
  const touch = row => {
    sheet.getRange(row, stampCol + 1).setValue(new Date());
    sheet.getRange(row, byCol + 1).setValue(who);
  };

  // /ai key <alias> ...
  const sub1 = String(rest[0] || '').toLowerCase();
  if (sub1 === 'key' || sub1 === 'keys' || sub1 === 'apikey') {
    const alias = String(rest[1] || '').trim();
    const sub = String(rest[2] || '').toLowerCase();
    if (!AI_ALIAS_PATTERN.test(alias)) return done('❌ Sai tên cấu hình: ' + (alias || '(trống)') + '\n\n' + AI_HELP);
    const row = rowOf(alias);
    if (row < 0) return done('❌ Chưa có cấu hình "' + alias + '". Thêm trước bằng /ai add ' + alias + ' <url> <model>');
    const keys = aiKeys_(data.values[row - 2][keyCol]);
    if (sub === 'list' || sub === 'ls') {
      if (!keys.length) return done('🔑 ' + alias + ' chưa có key nào.\nThêm: /ai key ' + alias + ' add <key>');
      return done('🔑 KEY CỦA ' + alias + ' (' + keys.length + ')\n' + keys.map((k, i) => (i + 1) + '. ' + aiMask_(k)).join('\n'));
    }
    if (sub === 'add') {
      const key = String(rest[3] || '').trim();
      if (!AI_KEY_PATTERN.test(key)) return done('❌ Key không hợp lệ. Dán đúng key, không có dấu cách.');
      if (keys.indexOf(key) >= 0) return done('ℹ️ Key này đã có trong ' + alias + '.');
      keys.push(key);
      sheet.getRange(row, keyCol + 1).setValue(keys.join('\n'));
      touch(row);
      return done('✅ Đã thêm key cho ' + alias + ' (tổng ' + keys.length + ' key).\nGateway sẽ xoay vòng các key này, key hết quota bị tự loại tạm.');
    }
    if (sub === 'del' || sub === 'rm' || sub === 'remove') {
      const index = parseInt(rest[3], 10);
      if (!Number.isFinite(index) || index < 1 || index > keys.length) return done('❌ Số thứ tự không hợp lệ. Xem danh sách bằng /ai key ' + alias + ' list');
      const removed = keys.splice(index - 1, 1)[0];
      sheet.getRange(row, keyCol + 1).setValue(keys.join('\n'));
      touch(row);
      return done('🗑 Đã xoá key ' + index + ' (' + aiMask_(removed) + ') khỏi ' + alias + '. Còn ' + keys.length + ' key.');
    }
    if (sub === 'check') {
      // Việc gọi nhà cung cấp để kiểm key là việc của Gateway (chỉ Gateway giữ
      // key). GAS chỉ trả lời hướng dẫn, không tự gọi ra Internet.
      return done('🔍 Bấm nút "🔍 Kiểm tra key" trong menu /ai — Gateway sẽ thử từng key và báo key nào còn dùng được.');
    }
    return done('❓ Không hiểu "key ' + sub + '".\n\n' + AI_HELP);
  }

  // /ai add <alias> <url> <model> — tạo mới, hoặc sửa url/model của alias cũ.
  if (sub1 === 'add' || sub1 === 'new') {
    const alias = String(rest[1] || '').trim();
    if (!AI_ALIAS_PATTERN.test(alias)) return done('❌ Tên cấu hình chỉ gồm chữ/số và . _ - (tối đa 40 ký tự).\n\n' + AI_HELP);
    let url, model;
    try {
      url = aiNormalizeUrl_(rest[2]);
      model = aiNormalizeModel_(rest[3]);
    } catch (error) {
      return done('❌ ' + error.message + '\n\nCú pháp: /ai add ' + alias + ' <url> <model>\nVí dụ: /ai add chinh https://openrouter.ai/api/v1 stealth/space-bunny-alpha');
    }
    const row = rowOf(alias);
    if (row > 0) {
      // Sửa cấu hình cũ: giữ nguyên danh sách key đang chạy, chỉ đổi url/model.
      sheet.getRange(row, urlCol + 1).setValue(url);
      sheet.getRange(row, modelCol + 1).setValue(model);
      touch(row);
      return done('✏️ Đã cập nhật ' + alias + '.\nURL: ' + url + '\nModel: ' + model + '\nKey đang có: ' + aiKeys_(data.values[row - 2][keyCol]).length);
    }
    appendMapped_(sheet, {
      'Alias': alias,
      'Active': '',
      'Base URL': url,
      'Model': model,
      'API Keys': '',
      // Dòng mới luôn nằm CUỐI chuỗi dự phòng: cấu hình đang chạy không bị
      // đổi chỉ vì admin thêm một dòng dự phòng.
      'Order': nextOrder_(data),
      'Updated At': new Date(),
      'Updated By': who,
    });
    const saved = rows_(sheet);
    const fresh = find_(saved.values, cell_(saved.header, 'Alias'), alias);
    if (fresh >= 0) touch(fresh + 2);
    return done('➕ Đã tạo cấu hình ' + alias + '.\nURL: ' + url + '\nModel: ' + model + '\n\nBước tiếp theo: thêm key rồi bật\n/ai key ' + alias + ' add <key>\n/ai use ' + alias);
  }

  // Các lệnh cần alias đã có.
  const needAlias = () => {
    const alias = String(rest[1] || '').trim();
    if (!AI_ALIAS_PATTERN.test(alias)) throw new Error('Sai tên cấu hình: ' + (alias || '(trống)'));
    const row = rowOf(alias);
    if (row < 0) throw new Error('Chưa có cấu hình "' + alias + '"');
    return { alias, row };
  };

  try {
    if (sub1 === 'use' || sub1 === 'active' || sub1 === 'bat') {
      const { alias, row } = needAlias();
      // Chỉ một cấu hình được bật: dùng "Yes"/"" thay vì TRUE/FALSE để dễ đọc
      // khi mở Sheet bằng tay.
      for (let i = 0; i < data.values.length; i++) sheet.getRange(i + 2, activeCol + 1).setValue('');
      sheet.getRange(row, activeCol + 1).setValue('Yes');
      touch(row);
      return done('✅ Đã bật cấu hình ' + alias + '. Mọi máy sẽ dùng cấu hình này ở lượt chat kế tiếp.');
    }
    if (sub1 === 'del' || sub1 === 'delete' || sub1 === 'rm') {
      const { alias, row } = needAlias();
      sheet.deleteRow(row);
      return done('🗑 Đã xoá cấu hình ' + alias + '.\n\n' + aiView_(input));
    }
    if (sub1 === 'url' || sub1 === 'model') {
      const { alias, row } = needAlias();
      const value = rest.slice(2).join(' ');
      try {
        if (sub1 === 'url') sheet.getRange(row, urlCol + 1).setValue(aiNormalizeUrl_(value));
        else sheet.getRange(row, modelCol + 1).setValue(aiNormalizeModel_(value));
      } catch (error) {
        return done('❌ ' + error.message);
      }
      touch(row);
      const after = rows_(sheet);
      const saved = after.values[row - 2];
      return done('✏️ Đã cập nhật ' + alias + '.\nURL: ' + saved[cell_(after.header, 'Base URL')] + '\nModel: ' + saved[cell_(after.header, 'Model')] + '\nKey đang có: ' + aiKeys_(saved[cell_(after.header, 'API Keys')]).length);
    }
  } catch (error) {
    return done('❌ ' + error.message + '\n\n' + AI_HELP);
  }

  return done('❓ Không hiểu "' + text + '".\n\n' + AI_HELP);
}

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


// Billing extension. Called only after the existing gateway secret check.
function billingConfig_() {
  var p = PropertiesService.getScriptProperties();
  var raw = p.getProperty('BILLING_CONFIG');
  var c = raw ? JSON.parse(raw) : { commercial: false, revision: 0 };
  c.plans = c.commercial ? billingPlans_() : BillingCore().defaults;
  return c;
}
function billingTable_(name, columns) {
  var ss=SpreadsheetApp.getActive(), s=ss.getSheetByName(name);
  if(!s) { s=ss.insertSheet(name); s.appendRow(columns); }
  ensureColumns_(s,columns); return s;
}
function billingSetup_(input) {
  if(SpreadsheetApp.getActive().getId()!==String(input.expectedSheetId||'')) throw new Error('CRM Sheet không khớp.');
  var lock=LockService.getScriptLock();lock.waitLock(30000);
  try {
    var names=['Quotes','Orders','KeyEntitlements','LicenseMSTs','QuotaLedger','Releases','AdminUIRequests'];
    names.forEach(function(name){billingTable_(name,['ID','JSON']);});
    billingPlans_();billingTable_('AdminAudit',['Time','Room','Actor','Command']);
    billingTable_('UsageDaily',billingUsageColumns_());
    billingTable_('UsageFeatures',['ID','Hardware ID','Installation ID','Ngày','Tính năng','Kết quả','Giá trị','Đơn vị','Cập nhật']);
    return {commercial:billingConfig_().commercial,revision:'billing-20261010-v1',tables:names.concat(['Plans','AdminAudit','UsageDaily','UsageFeatures'])};
  } finally {lock.releaseLock();}
}
function billingUsageColumns_() {
  return ['ID','JSON','Hardware ID','Installation ID','Cập nhật','Số MST','Danh sách MST','Thời gian sử dụng (giây)','Yêu cầu tải hóa đơn','Nhập sao kê thành công','Yêu cầu tra cứu MST','Yêu cầu tải tờ khai','Xuất MISA thành công'];
}
function billingUsageSummary_(payload) {
  var totals={activeSeconds:0,invoice:0,bank:0,lookup:0,declaration:0,replacement:0};
  Object.keys(payload.counters||{}).forEach(function(key){
    var m=/^(\d{4}-\d{2}-\d{2}):(.*):(ok|error)$/.exec(key), n=Number(payload.counters[key]);
    if(!m||m[3]!=='ok'||!isFinite(n)||n<0)return;
    var f=m[2];
    if(f==='/api/download')totals.invoice+=n;
    else if(f==='bank_import')totals.bank+=n;
    else if(f==='/api/mst/lookup/search')totals.lookup+=n;
    else if(f==='/api/tokhai/download')totals.declaration+=n;
    else if(f==='/api/invoice-replacement/export')totals.replacement+=n;
    else if(f.indexOf('/api/')!==0)totals.activeSeconds+=n;
  });
  return totals;
}
function billingDataReport_(row,header) {
  var aliases=[row[optional_(header,'Hardware ID V2')],row[optional_(header,'Machine ID')],row[cell_(header,'Hardware ID')]].filter(Boolean).map(String);
  var sheet=SpreadsheetApp.getActive().getSheetByName('UsageDaily'),byInstall={};
  if(sheet) {
    var data=rows_(sheet),jsonCol=cell_(data.header,'JSON'),idCol=cell_(data.header,'ID');
    data.values.forEach(function(r){
      var value;try{value=JSON.parse(String(r[jsonCol]||'null'));}catch{return;}
      if(!value||aliases.indexOf(String(value.machine))<0)return;
      var install=String(value.installationId||String(r[idCol]).split(':').slice(1).join(':'));
      if(!byInstall[install]||Number(value.updatedAt)>Number(byInstall[install].updatedAt))byInstall[install]=value;
    });
  }
  var reports=Object.keys(byInstall).map(function(k){return byInstall[k];}).sort(function(a,b){return Number(b.updatedAt)-Number(a.updatedAt);});
  var name=String(row[optional_(header,'Name')]||row[optional_(header,'Phone')]||'Khách trong Topic này').slice(0,80);
  var lines=['📊 DỮ LIỆU & HÀNH VI','👤 '+name];
  if(!reports.length)return lines.concat(['','Chưa có báo cáo từ EXE mới.','Mở EXE mới: gửi sau 1 phút, rồi mỗi 15 phút.','Chưa có báo cáo không có nghĩa là số liệu bằng 0.']).join('\n');
  var month=BillingCore().month(Date.now()),latest=reports[0],msts=Array.from(new Set(latest.mst||[]));
  var empty=function(){return {activeSeconds:0,invoice:0,bank:0,lookup:0,declaration:0,replacement:0};};
  var total=empty(),current=empty(),features={};
  reports.forEach(function(v){
    var counters=v.counters||{},monthly={};
    Object.keys(counters).forEach(function(k){if(k.slice(0,7)===month)monthly[k]=counters[k];var m=/^(\d{4}-\d{2}-\d{2}):(.*):ok$/.exec(k),n=Number(counters[k]);if(m&&m[2].indexOf('/api/')!==0&&m[2]!=='bank_import'&&isFinite(n)&&n>0)features[m[2]]=(features[m[2]]||0)+n;});
    var all=billingUsageSummary_(v),one=billingUsageSummary_({counters:monthly});Object.keys(total).forEach(function(k){total[k]+=all[k];current[k]+=one[k];});
  });
  var count=function(n){return String(Math.floor(n)).replace(/\B(?=(\d{3})+(?!\d))/g,'.');};
  var duration=function(n){n=Math.floor(n);return n<60?n+' giây':Math.floor(n/3600)+' giờ '+Math.floor(n%3600/60)+' phút';};
  lines.push('🗂 MST đang quản lý: '+count(msts.length),'🖥 Bản cài đã báo cáo: '+count(reports.length),'🕒 Cập nhật: '+Utilities.formatDate(new Date(Number(latest.updatedAt)),'Asia/Ho_Chi_Minh','dd/MM/yyyy HH:mm'));
  if(Date.now()-Number(latest.updatedAt)>30*60*1000)lines.push('⚠️ Báo cáo đã quá 30 phút; máy có thể chưa mở hoặc chưa gửi lại.');
  if(msts.length)lines.push('MST: '+msts.slice(0,8).join(', ')+(msts.length>8?' … (còn '+(msts.length-8)+' MST)':''));
  lines.push('','📅 Tháng '+month.slice(5)+'/'+month.slice(0,4)+' / Tổng đã ghi nhận');
  [['Tải hóa đơn (lượt yêu cầu)','invoice'],['Tra cứu MST (lượt yêu cầu)','lookup'],['Tải tờ khai (lượt yêu cầu)','declaration'],['Nhập sao kê thành công','bank'],['Xuất MISA thành công','replacement']].forEach(function(pair){lines.push('• '+pair[0]+': '+count(current[pair[1]])+' / '+count(total[pair[1]]));});
  lines.push('• Thời gian tương tác: '+duration(current.activeSeconds)+' / '+duration(total.activeSeconds));
  var top=Object.keys(features).sort(function(a,b){return features[b]-features[a];}).slice(0,3);
  var labels={overview:'Tổng quan',invoice:'Hóa đơn',invoices:'Hóa đơn',bank:'Sao kê',goods:'Hàng hóa',partners:'Đối tác',mst:'Tra cứu MST',tokhai:'Tờ khai',replacement:'Thay thế hóa đơn',app:'Ứng dụng'};
  if(top.length)lines.push('','⭐ Dùng nhiều: '+top.map(function(f){return (labels[f]||f).slice(0,60)+' ('+duration(features[f])+')';}).join(' · '));
  lines.push('','Lượt yêu cầu ≠ số hóa đơn/tờ khai tải thành công.','Không bao gồm dữ liệu chưa gửi từ EXE.');
  return lines.join('\n');
}
function billingSaveUsage_(input,d,now) {
  var counters=input.snapshot||{}, keys=Object.keys(counters);
  if(Array.isArray(counters)||keys.length>3000)throw new Error('Báo cáo không hợp lệ.');
  keys.forEach(function(k){if(!/^(\d{4}-\d{2}-\d{2}):(.{1,60}):(ok|error)$/.test(k)||!isFinite(Number(counters[k]))||Number(counters[k])<0)throw new Error('Bộ đếm không hợp lệ.');});
  var install=String(input.installationId), id=d.machine+':'+install;
  if(input.reportId&&String(input.reportId)!==install)throw new Error('Bản cài không khớp báo cáo.');
  var msts=Array.from(new Set((input.mst||[]).map(function(m){return String(m).trim();}).filter(function(m){return /^\d{10}(?:-?\d{3})?$/.test(m);})));
  var payload={machine:d.machine,key:d.key,installationId:install,updatedAt:now,mst:msts,counters:counters};
  if(JSON.stringify(payload).length>150000)throw new Error('Báo cáo quá lớn.');
  var summary=billingUsageSummary_(payload),table=billingTable_('UsageDaily',billingUsageColumns_()),record=billingJson_('UsageDaily',id);
  billingPut_(record,id,payload);
  record=billingJson_('UsageDaily',id);
  var values={'Hardware ID':d.machine,'Installation ID':install,'Cập nhật':new Date(now),'Số MST':msts.length,'Danh sách MST':msts.join(', '),'Thời gian sử dụng (giây)':summary.activeSeconds,'Yêu cầu tải hóa đơn':summary.invoice,'Nhập sao kê thành công':summary.bank,'Yêu cầu tra cứu MST':summary.lookup,'Yêu cầu tải tờ khai':summary.declaration,'Xuất MISA thành công':summary.replacement};
  Object.keys(values).forEach(function(k){table.getRange(record.row,cell_(record.header,k)+1).setValue(values[k]);});
  var features=billingTable_('UsageFeatures',['ID','Hardware ID','Installation ID','Ngày','Tính năng','Kết quả','Giá trị','Đơn vị','Cập nhật']);
  var existing=rows_(features), index={};existing.values.forEach(function(r,i){index[String(r[0])]=i+2;});
  keys.forEach(function(k){var m=/^(\d{4}-\d{2}-\d{2}):(.*):(ok|error)$/.exec(k),fid=id+':'+k;
    var row=[fid,d.machine,install,m[1],m[2],m[3],Number(counters[k]),m[2].indexOf('/api/')!==0&&m[2]!=='bank_import'?'giây':'lượt',new Date(now)];
    if(index[fid])features.getRange(index[fid],1,1,row.length).setValues([row]);else features.appendRow(row);
  });
  return {saved:true,mstCount:msts.length};
}
function billingPlans_() {
  var s=billingTable_('Plans',['Plan ID','Max MST','Monthly Price']);
  if(s.getLastRow()<2) BillingCore().defaults.forEach(function(p){s.appendRow([p.id,p.maxMst,p.price]);});
  var d=rows_(s); return d.values.map(function(r){return {id:String(r[cell_(d.header,'Plan ID')]),maxMst:Number(r[cell_(d.header,'Max MST')]),price:Number(r[cell_(d.header,'Monthly Price')])};});
}
function billingJson_(name, id) {
  var s=billingTable_(name,['ID','JSON']), d=rows_(s), i=find_(d.values,cell_(d.header,'ID'),id);
  return {sheet:s, row:i<0?0:i+2, value:i<0?null:JSON.parse(String(d.values[i][cell_(d.header,'JSON')]||'null')),header:d.header};
}
function billingPut_(record,id,value) {
  if(record.row) record.sheet.getRange(record.row,cell_(record.header,'JSON')+1).setValue(JSON.stringify(value));
  else appendMapped_(record.sheet,{'ID':id,'JSON':JSON.stringify(value)});
}
function billingDevice_(input) {
  var d=rows_(deviceSheet_()), f=findDevice_(d,input);
  if(f.index<0) throw new Error('Thiết bị chưa đăng ký.');
  var r=d.values[f.index], storedHardware=String(r[optional_(d.header,'Hardware ID V2')]||'');
  if(input.hardwareIdV2&&storedHardware&&String(input.hardwareIdV2)!==storedHardware)throw new Error('Phần cứng thay đổi; cần Admin xác minh.');
  var machine=storedHardware||String(input.machineId||r[optional_(d.header,'Machine ID')]||r[cell_(d.header,'Hardware ID')]||'');
  if(String(r[cell_(d.header,'Chat Room ID')]||'')!==String(input.chatRoomId||''))throw new Error('Thiết bị không khớp phiên hỗ trợ.');
  var key=String(r[cell_(d.header,'License Key')]||'');
  if(String(r[cell_(d.header,'Status')]).toLowerCase()==='locked') throw new Error('Thiết bị đã bị khóa.');
  return {machine:machine,key:key,row:f.index+2,header:d.header,firstInstall:r[optional_(d.header,'First Install Time')]};
}
function billingEntitlement_(key) {
  return key&&SpreadsheetApp.getActive().getSheetByName('KeyEntitlements')?billingJson_('KeyEntitlements',key).value:null;
}
function billingAttach_(result,input) {
  result.billing=billingConfig_();
  result.entitlement=billingEntitlement_(result.keyName||'');
  return result;
}
function billingAdminResult_(result,input) {
  var s=deviceSheet_(),d=rows_(s),i=find_(d.values,cell_(d.header,'Chat Room ID'),input.chatRoomId);
  if(i<0)return result;
  var current=deviceResult_(d.values[i],d.header), key=current.keyName;
  var cmd=String(input.text||input.command||'');
  if(/^\/extend\b/.test(cmd)&&key) {
    d.values.forEach(function(r,index){if(String(r[cell_(d.header,'License Key')])===key){s.getRange(index+2,cell_(d.header,'Expiry Date')+1).setValue(current.expiryAt);s.getRange(index+2,cell_(d.header,'Status')+1).setValue('Active');}});
  }
  result=Object.assign({},result,current);
  result.billing=billingConfig_();result.entitlement=billingEntitlement_(key);
  result.release=billingJson_('Releases','current').value;
  result.affectedRooms=d.values.filter(function(r){return key&&String(r[cell_(d.header,'License Key')])===key;}).map(function(r){return String(r[cell_(d.header,'Chat Room ID')]);});
  return result;
}
function billingAction_(input) {
  var lock=LockService.getScriptLock(); lock.waitLock(30000);
  try { return billingActionLocked_(input); } finally { lock.releaseLock(); }
}
function billingActionLocked_(input) {
  var action=String(input.billingAction||''), c=billingConfig_(), core=BillingCore(), now=Date.now();
  if(action==='config') return {config:c,release:billingJson_('Releases','current').value};
  var d=billingDevice_(input), ent=billingEntitlement_(d.key);
  if(action==='quote') {
    if(!c.commercial) throw new Error('Hiện đang sử dụng miễn phí.');
    var q=core.quote(input,c.plans); q.owner=d.machine; q.createdAt=now;q.validUntil=now+86400000;
    q.periodFullPrice=q.total;
    if(input.upgrade) { if(!ent) throw new Error('Key chưa có gói để nâng cấp.'); q.upgrade=true;q.total=core.upgrade(ent,q,now);q.entitlementRevision=ent.revision; }
    var id='Q-'+Utilities.getUuid();billingPut_(billingJson_('Quotes',id),id,q);return {quoteId:id,quote:q};
  }
  if(action==='order') {
    var qr=billingJson_('Quotes',String(input.quoteId)), q=qr.value;
    if(!q||q.validUntil<now) throw new Error('Báo giá đã hết hiệu lực.');
    if(q.owner&&q.owner!==d.machine) throw new Error('Báo giá không thuộc thiết bị.');
    // Legacy quotes created before owner support are rejected, never adopted.
    if(!q.owner) throw new Error('Vui lòng lấy báo giá mới.');
    var id='O-'+String(input.quoteId).slice(2), existing=billingJson_('Orders',id);
    if(existing.value) return existing.value;
    var o={id:id,machine:d.machine,key:d.key,room:input.chatRoomId,quote:q,status:'pending',createdAt:now};
    billingPut_(existing,id,o);return o;
  }
  if(action==='orders'||action==='cancel') {
    var table=billingTable_('Orders',['ID','JSON']), all=rows_(table).values.map(function(r){return JSON.parse(String(r[1]));}).filter(function(o){return o.machine===d.machine;});
    if(action==='orders')return all.slice(-30);
    var item=all.find(function(o){return o.id===input.orderId;});if(!item||item.status!=='pending')throw new Error('Yêu cầu không thể hủy.');
    item.status='cancelled';billingPut_(billingJson_('Orders',item.id),item.id,item);return item;
  }
  if(action==='usage') {
    return billingSaveUsage_(input,d,now);
  }
  if(!c.commercial)return {allowed:true};
  var license=licenseStatus_(input), initial=!license.keyName&&now<Math.max(Number(new Date(c.launchAt||0)),Number(new Date(d.firstInstall||c.launchAt||0)))+30*86400000;
  var active=String(license.status).toLowerCase()==='active';
  if(initial||active&&!ent)return {allowed:true};
  var basic=!active, owner=basic?d.machine:d.key;
  if(action==='mst_use'||action==='mst_select') {
    var mst=String(input.mst||'').replace(/-/g,'');if(!/^\d{10}(\d{3})?$/.test(mst))throw new Error('MST không hợp lệ.');
    var r=billingJson_('LicenseMSTs',owner), value=r.value||{mst:[],changes:0};
    if(basic) {
      if(!value.selectedMst)value.selectedMst=mst;
      else if(value.selectedMst!==mst) {if(action!=='mst_select')throw new Error('Chọn MST được phép trong danh sách tài khoản trước.');if(value.changes>=3)throw new Error('Đã dùng hết 3 lần đổi MST. Liên hệ Admin.');value.changes++;value.selectedMst=mst;}
      value.mst=[mst];
    } else {
      if(value.mst.length>ent.maxMst)throw new Error('Gói đã giảm; cần Admin chọn lại danh sách MST.');
      if(value.mst.indexOf(mst)<0) {if(value.mst.length>=ent.maxMst)throw new Error('Đã hết suất MST; liên hệ Admin nâng gói hoặc thay MST.');value.mst.push(mst);}
    }
    billingPut_(r,owner,value);return {allowed:true,selectedMst:value.selectedMst||'',changes:value.changes,mst:value.mst};
  }
  if(action.indexOf('quota_')===0) {
    if(!basic)return {ticket:'unlimited'};
    var record=billingJson_('QuotaLedger',owner), ledger=record.value||{}, ticket=String(input.ticket||'');
    if(action==='quota_reserve') {
      var kind=String(input.kind);if(['bank','replacement'].indexOf(kind)<0)throw new Error('Loại hạn mức không hợp lệ.');
      var period=core.month(now), bucket=kind+':'+period, hash=String(input.fingerprint||'');
      if(!/^[a-f0-9]{64}$/.test(hash))throw new Error('Dấu nhận diện file không hợp lệ.');
      ticket=bucket+':'+hash;
      if(ledger[ticket]&&ledger[ticket].state==='committed')return {ticket:ticket};
      var count=Object.keys(ledger).filter(function(k){return k.indexOf(bucket+':')===0&&(ledger[k].state==='committed'||ledger[k].until>now);}).length;
      if(count>=(kind==='bank'?2:1)&&!(ledger[ticket]&&ledger[ticket].until>now))throw new Error('Đã hết lượt '+(kind==='bank'?'sao kê tháng này.':'xuất MISA tháng này.'));
      ledger[ticket]={state:'reserved',until:now+30*60000};
    } else {
      if(ticket==='unlimited')return {ok:true};
      if(!ledger[ticket])throw new Error('Lượt giữ chỗ không tồn tại.');
      if(action==='quota_commit')ledger[ticket]={state:'committed',at:now};
      else if(action==='quota_release'&&ledger[ticket].state!=='committed')delete ledger[ticket];
      else if(action!=='quota_release')throw new Error('Thao tác không hợp lệ.');
    }
    billingPut_(record,owner,ledger);return {ticket:ticket};
  }
  throw new Error('Thao tác chưa hỗ trợ.');
}
function billingAdmin_(input) {
  var text=String(input.text||input.command||''), parts=text.trim().split(/\s+/), cmd=parts[0].toLowerCase().replace(/@\w+$/,'');
  if(['/commerce','/plans','/orders','/approve','/reject','/newplan','/setplan','/usage','/checkdulieu','/mst','/replace_mst','/reset_mst_changes','/release','/release_preview'].indexOf(cmd)<0)return null;
  var lock=LockService.getScriptLock();lock.waitLock(30000);
  try {
    var ds=rows_(deviceSheet_()), idx=find_(ds.values,cell_(ds.header,'Chat Room ID'),input.chatRoomId);
    if(idx<0)throw new Error('Không tìm thấy thiết bị.');
    var uiReceipt=null;
    if(input.requestId&&['/newplan','/setplan','/commerce','/approve','/reject','/replace_mst','/reset_mst_changes','/release'].indexOf(cmd)>=0) {
      var uiId=String(input.chatRoomId)+'|'+String(input.requestId).slice(0,200);
      uiReceipt=billingJson_('AdminUIRequests',uiId);
      if(uiReceipt.value)throw new Error('Thao tác này đã được xử lý. Mở menu mới để thực hiện yêu cầu khác.');
    }
    var row=ds.values[idx], key=String(row[cell_(ds.header,'License Key')]||''), machine=String(row[optional_(ds.header,'Hardware ID V2')]||row[optional_(ds.header,'Machine ID')]||row[cell_(ds.header,'Hardware ID')]);
    if(input.expectedKey!==undefined&&key!==String(input.expectedKey))throw new Error('Key đã thay đổi. Mở lại menu và kiểm tra khách.');
    var reply='',menuOrders=null,menuRelease=null;
    if(cmd==='/commerce') {
      if(['on','off'].indexOf(parts[1])<0)throw new Error('/commerce on|off');
      var c=billingConfig_();c.commercial=parts[1]==='on';c.revision=Number(c.revision||0)+1;
      if(c.commercial&&!c.launchAt)c.launchAt=new Date().toISOString();
      delete c.plans;PropertiesService.getScriptProperties().setProperty('BILLING_CONFIG',JSON.stringify(c));reply=c.commercial?'Đã công bố thương mại.':'Đã bật miễn phí toàn bộ.';
    } else if(cmd==='/plans') reply=billingPlans_().map(function(p){return p.id+': '+p.maxMst+' MST / '+p.price+'đ/tháng';}).join('\n');
    else if(cmd==='/orders') {
      var orders=rows_(billingTable_('Orders',['ID','JSON'])).values.map(function(r){return JSON.parse(r[1]);}).filter(function(o){return o.room===input.chatRoomId;});
      menuOrders=orders.filter(function(o){return o.status==='pending';}).slice(-10).map(function(o){return {id:o.id,planId:o.quote.planId,devices:o.quote.devices,term:o.quote.term,total:o.quote.total};});
      reply=orders.slice(-10).map(function(o){return o.id+' '+o.quote.planId+' '+o.quote.devices+' máy '+o.quote.term+' '+o.quote.total+'đ '+o.status;}).join('\n')||'Chưa có yêu cầu.';
    } else if(cmd==='/approve'||cmd==='/reject') {
      var rec=billingJson_('Orders',parts[1]), o=rec.value;
      if(!o||o.room!==input.chatRoomId)throw new Error('Yêu cầu không thuộc Topic này.');
      if(o.status!=='pending')return {reply:'Yêu cầu đã được xử lý: '+o.status};
      if(cmd==='/reject'){o.status='rejected';billingPut_(rec,o.id,o);reply='Đã từ chối '+o.id;}
      else {
        if(parts[2]!=='paid')throw new Error('Xác nhận đã nhận tiền: /approve '+o.id+' paid');
        var q=o.quote, old=billingEntitlement_(o.key), start=Date.now(), expiry;
        if(q.upgrade){if(!old||old.revision!==q.entitlementRevision)throw new Error('Key đã thay đổi; cần báo giá mới.');if(new Date(old.expiryAt)<=new Date())throw new Error('Key đã hết hạn; cần báo giá mới.');expiry=old.expiryAt;}
        else {start=Math.max(start,old?Number(new Date(old.expiryAt)):0);expiry=BillingCore().addMonths(start,q.months);}
        key=o.key||'KEY-'+Utilities.getUuid().replace(/-/g,'').slice(0,16).toUpperCase();
        billingGrant_(key,input.chatRoomId,q,expiry,q.upgrade?old.periodStart:new Date(start).toISOString(),q.periodFullPrice);
        o.status='approved';o.key=key;o.approvedAt=Date.now();billingPut_(rec,o.id,o);reply='Đã xác nhận '+o.id+'\nKey: '+key+'\nHạn: '+expiry;
      }
    } else if(cmd==='/newplan'||cmd==='/setplan') {
      var p=billingPlans_().find(function(p){return p.id===String(parts[1]).toUpperCase();});if(!p)throw new Error('Gói không hợp lệ.');
      var devices=BillingCore().integer(parts[3]||1,1,100), days=BillingCore().integer(parts[2]||30,1,3650), expiry=new Date(Date.now()+days*86400000).toISOString();
      if(cmd==='/newplan')key='KEY-'+Utilities.getUuid().replace(/-/g,'').slice(0,16).toUpperCase();else if(!key)throw new Error('Thiết bị chưa có key.');
      billingGrant_(key,input.chatRoomId,{planId:p.id,maxMst:p.maxMst,devices:devices,term:'custom'},expiry,new Date().toISOString(),0);reply='Key: '+key+'\nGói: '+p.id+'\nHạn: '+expiry;
    } else if(cmd==='/mst'||cmd==='/replace_mst'||cmd==='/reset_mst_changes') {
      var owner=key&&billingEntitlement_(key)?key:machine, r=billingJson_('LicenseMSTs',owner), v=r.value||{mst:[],changes:0};
      if(cmd==='/replace_mst'){var old=String(parts[1]||''), next=String(parts[2]||'').replace(/-/g,'');if(!/^\d{10}(\d{3})?$/.test(next)||v.mst.indexOf(old)<0||v.mst.indexOf(next)>=0)throw new Error('/replace_mst <MST cũ> <MST mới>');v.mst[v.mst.indexOf(old)]=next;if(v.selectedMst===old)v.selectedMst=next;}
      if(cmd==='/reset_mst_changes')v.changes=0;
      billingPut_(r,owner,v);reply='MST: '+v.mst.join(', ')+'\nSố lần đổi: '+v.changes;
    } else if(cmd==='/usage'||cmd==='/checkdulieu') {
      reply=billingDataReport_(row,ds.header);
    } else if(cmd==='/release_preview') {
      menuRelease=billingJson_('Releases','draft').value;
      reply=menuRelease?'BẢN NHÁP CẬP NHẬT\nv'+menuRelease.version+'\n'+menuRelease.notes+'\nChưa công bố.':'Chưa có bản nháp cập nhật.';
    } else if(cmd==='/release') {
      if(parts[1]==='off'){billingPut_(billingJson_('Releases','current'),'current',{published:false});reply='Đã thu hồi cập nhật.';}
      else if(parts[1]==='publish'){var draft=billingJson_('Releases','draft').value;if(!draft)throw new Error('Chưa có bản nháp.');if(input.expectedDraftAt!==undefined&&Number(input.expectedDraftAt)!==Number(draft.at))throw new Error('Bản nháp đã thay đổi. Xem lại trước khi công bố.');draft.published=true;billingPut_(billingJson_('Releases','current'),'current',draft);reply='Đã công bố v'+draft.version+'\n'+draft.notes;}
      else {var version=parts[1];if(!/^\d+\.\d+\.\d+$/.test(version))throw new Error('/release <phiên bản> <nội dung>');var notes=parts.slice(2).join(' ');if(!notes)throw new Error('Cần nội dung cập nhật.');var value={version:version,notes:notes.slice(0,4000),published:false,at:Date.now()};billingPut_(billingJson_('Releases','draft'),'draft',value);reply='Bản nháp v'+version+'\n'+value.notes+'\nCông bố: /release publish';}
    }
    var audit=billingTable_('AdminAudit',['Time','Room','Actor','Command']);audit.appendRow([new Date(),input.chatRoomId,String(input.actor||''),text]);
    var result={...deviceResult_(rows_(deviceSheet_()).values[idx],ds.header),reply:reply,billing:billingConfig_(),release:billingJson_('Releases','current').value,entitlement:billingEntitlement_(key),affectedRooms:rows_(deviceSheet_()).values.filter(function(r){return key&&String(r[cell_(ds.header,'License Key')])===key;}).map(function(r){return String(r[cell_(ds.header,'Chat Room ID')]);})};
    if(menuOrders)result.menuOrders=menuOrders;
    if(cmd==='/release_preview')result.menuRelease=menuRelease;
    if(uiReceipt)billingPut_(uiReceipt,uiId,result);
    return result;
  } finally {lock.releaseLock();}
}
function billingGrant_(key,room,q,expiry,start,price) {
  var s=licenseSheet_(),d=rows_(s),i=find_(d.values,cell_(d.header,'License Key'),key);
  var fields={'License Key':key,'Status':'Active','Expiry Date':new Date(expiry),'Chat Room ID':room,'Max Devices':q.devices};
  if(i<0)appendMapped_(s,fields);else Object.keys(fields).forEach(function(k){s.getRange(i+2,cell_(d.header,k)+1).setValue(fields[k]);});
  var old=billingEntitlement_(key), ent={planId:q.planId,maxMst:q.maxMst,devices:q.devices,term:q.term,expiryAt:expiry,periodStart:start,periodPrice:price,revision:(old?old.revision:0)+1};
  billingPut_(billingJson_('KeyEntitlements',key),key,ent);
  var ds=deviceSheet_(),data=rows_(ds);
  data.values.forEach(function(r,i){if(String(r[cell_(data.header,'License Key')])===key||String(r[cell_(data.header,'Chat Room ID')])===room){ds.getRange(i+2,cell_(data.header,'License Key')+1).setValue(key);ds.getRange(i+2,cell_(data.header,'Status')+1).setValue('Active');ds.getRange(i+2,cell_(data.header,'Expiry Date')+1).setValue(new Date(expiry));}});
}
function billingHardware_(input) {
  if(!input.hardwareIdV2)return;
  var sheet=deviceSheet_();ensureColumns_(sheet,['Hardware ID V2']);
  var data=rows_(sheet), f=findDevice_(data,input);if(f.index<0)return;
  var col=cell_(data.header,'Hardware ID V2'), old=String(data.values[f.index][col]||'');
  if(old&&old!==input.hardwareIdV2)throw new Error('Phần cứng thay đổi; cần Admin xác minh.');
  sheet.getRange(f.index+2,col+1).setValue(input.hardwareIdV2);
}
