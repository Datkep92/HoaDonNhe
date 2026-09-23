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
 *   installationId    = UUID của máy (khoá dòng trong sheet Devices)
 *   chatRoomId        = ROOM_WIN_... phòng chat của app, do EXE gửi lên và giữ nguyên
 *   telegramThreadId  = id Topic Telegram, chỉ tồn tại ở Firebase/Gateway
 */
const DEVICE_SHEET = 'Devices';
const LICENSE_SHEET = 'Licenses';
const BINDING_SHEET = 'Bindings';
const SETTINGS_SHEET = 'Settings';
const TRIAL_DAYS = 3;

function doPost(e) {
  try {
    const input = JSON.parse(e.postData && e.postData.contents || '{}');

    // Mọi request đều phải có secret của Gateway
    const expectedSecret = PropertiesService.getScriptProperties().getProperty('GATEWAY_SHARED_SECRET');
    if (!expectedSecret || input.gatewaySecret !== expectedSecret) {
      throw new Error('Unauthorized gateway.');
    }

    const action = String(input.action || '');
    const chatRoomId = String(input.chatRoomId || '');
    const installId = String(input.installationId || '');

    // Lệnh quản trị do Gateway chuyển tiếp (lấy từ Topic Telegram) chỉ cần biết phòng chat;
    // Apps Script không tự nói chuyện với Telegram, Gateway lo phần gửi/nhận.
    if (action === 'admin_command') {
      if (!/^ROOM_WIN_[A-Z0-9]{8,40}$/.test(chatRoomId)) throw new Error('Invalid device identity.');
      return reply_({ ok: true, value: adminCommand_(input) });
    }

    if (!/^[0-9a-f-]{36}$/i.test(installId) || !/^ROOM_WIN_[A-Z0-9]{8,40}$/.test(chatRoomId)) {
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
  const data = rows_(sheet);
  const header = data.header;
  const hardwareCol = cell_(header, 'Hardware ID');
  const installId = String(input.installationId || '');
  const roomId = String(input.chatRoomId || '');
  const phone = String(input.phone || '').trim();
  const name = String(input.name || '').trim();
  const plan = String(input.plan || '').trim();
  const hash = String(input.hardwareHash || '').trim();
  const hashCol = optional_(header, 'Hardware Hash');

  let found = find_(data.values, hardwareCol, installId);

  // Cùng một bộ máy nhưng mã cục bộ đã đổi (cài lại / xoá cấu hình): nối tiếp
  // dòng cũ để giữ nguyên First Install Time và liên kết bản quyền.
  if (found < 0 && hash && hashCol >= 0) {
    const byHash = find_(data.values, hashCol, hash);
    if (byHash >= 0) {
      const previous = String(data.values[byHash][hardwareCol] || '').trim();
      sheet.getRange(byHash + 2, hardwareCol + 1).setValue(installId);
      data.values[byHash][hardwareCol] = installId;
      if (previous && previous !== installId) rebindDevice_(previous, installId, roomId);
      found = byHash;
    }
  }

  if (found < 0) {
    // Máy mới kết nối lần đầu: tạo record, dùng thử bắt đầu tính từ First Install Time.
    // chatRoomId giữ đúng giá trị EXE gửi lên; Telegram không đi qua Apps Script.
    const row = appendMapped_(sheet, {
      'Hardware ID': installId,
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
  if (hash) update('Hardware Hash', hash);
  if (phone) update('Phone', phone);
  if (name) update('Name', name);
  if (plan) update('Plan', plan);

  return { ...deviceResult_(row, header), registered: false };
}

// Đổi chủ liên kết khi mã máy cục bộ thay đổi nhưng vẫn là máy cũ.
function rebindDevice_(previousId, installId, roomId) {
  const licenses = licenseSheet_();
  const data = rows_(licenses);
  const hardwareCol = cell_(data.header, 'Hardware ID');
  const index = find_(data.values, hardwareCol, previousId);
  if (index >= 0) licenses.getRange(index + 2, hardwareCol + 1).setValue(installId);
  const bindings = bindingsSheet_();
  if (!bindings) return;
  const bindingData = rows_(bindings);
  const bindingHardwareCol = cell_(bindingData.header, 'Hardware ID');
  const bindingIndex = find_(bindingData.values, bindingHardwareCol, previousId);
  if (bindingIndex >= 0) {
    bindings.getRange(bindingIndex + 2, bindingHardwareCol + 1).setValue(installId);
    // Phòng chat chỉ ghi khi dòng liên kết còn trống — cùng quy tắc với verifyKey_.
    // Trước đây chỗ này dùng biến `roomId` không tồn tại trong hàm, nên khi Sheet có
    // tab Bindings thì rebind ném ReferenceError và register_device thất bại âm thầm.
    const bindingRoomCol = optional_(bindingData.header, 'Chat Room ID');
    const currentRoom = bindingRoomCol >= 0 ? String(bindingData.values[bindingIndex][bindingRoomCol] || '').trim() : '';
    if (roomId && bindingRoomCol >= 0 && !currentRoom) {
      bindings.getRange(bindingIndex + 2, bindingRoomCol + 1).setValue(roomId);
    }
  }
}

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
  const deviceData = rows_(devices);
  const deviceHardwareCol = cell_(deviceData.header, 'Hardware ID');
  const deviceStatusCol = cell_(deviceData.header, 'Status');
  const deviceRow = find_(deviceData.values, deviceHardwareCol, input.installationId);
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

  return { status: 'Active', expiryAt: license[expiryCol] || '', keyName: key, hardwareId: input.installationId, chatRoomId: input.chatRoomId };
}

function licenseStatus_(input) {
  const data = rows_(deviceSheet_());
  const hardwareCol = cell_(data.header, 'Hardware ID');
  const found = find_(data.values, hardwareCol, input.installationId);
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
  const result = { found: true, installationId, chatRoomId: room };

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
    return { ...result, reply: lines.join('\n') };
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

    return { ...result, keyName: newKey, reply: ['🎉 CẤP KEY THÀNH CÔNG!', '🔑 Key: ' + newKey, '⏳ Hạn: ' + adminDate_(expiry), '💻 Số máy: ' + maxDevices].join('\n') };
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
    sheet.getRange(rowNumber, hardwareCol + 1).setValue('');
    sheet.getRange(rowNumber, cell_(header, 'Status') + 1).setValue('Unactivated');
    releaseBinding_(key, installationId);
    return { ...result, reply: '🔄 Đã reset liên kết máy thành công. Khách có thể kích hoạt lại trên máy này hoặc máy mới.' };
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
