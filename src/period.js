'use strict';
// Tính khoảng ngày cho phần "chọn nhanh" ở giao diện (năm + tháng / quý / cả năm).
// Dùng chung cho giao diện (src/period.js được nạp bằng <script>) và cho test.
// Ví dụ: Quý 1 năm 2025 -> 2025-01-01 … 2025-03-31.
function pad(value) { return String(value).padStart(2, '0'); }
function lastDay(year, month) { return new Date(Date.UTC(year, month, 0)).getUTCDate(); }

function monthRange(year, month) {
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new Error('Tháng không hợp lệ.');
  return { from: `${year}-${pad(month)}-01`, to: `${year}-${pad(month)}-${pad(lastDay(year, month))}` };
}
function quarterRange(year, quarter) {
  if (!Number.isInteger(quarter) || quarter < 1 || quarter > 4) throw new Error('Quý không hợp lệ.');
  const first = monthRange(year, (quarter - 1) * 3 + 1);
  const last = monthRange(year, quarter * 3);
  return { from: first.from, to: last.to };
}
function yearRange(year) { return { from: `${year}-01-01`, to: `${year}-12-31` }; }

// mode: 'month' | 'quarter' | 'year'; unit: số tháng (1-12) hoặc số quý (1-4).
function rangeFor(mode, year, unit) {
  const value = Number(year);
  if (!Number.isInteger(value) || value < 2000 || value > 2100) throw new Error('Năm không hợp lệ.');
  if (mode === 'quarter') { const range = quarterRange(value, Number(unit)); return { ...range, label: `Quý ${Number(unit)}/${value}` }; }
  if (mode === 'year') return { ...yearRange(value), label: `Năm ${value}` };
  const range = monthRange(value, Number(unit));
  return { ...range, label: `Tháng ${Number(unit)}/${value}` };
}
// Quý chứa tháng đã cho (dùng để đồng bộ ô Quý theo Từ ngày hiện tại).
function quarterOf(month) { return Math.floor((Number(month) - 1) / 3) + 1; }

// Giữ giá trị ISO cho toàn bộ logic/API, nhưng hiển thị ô nhập ngày theo chuẩn Việt Nam DD/MM/YYYY.
// Ô type=date gốc vẫn tồn tại (cùng id) nên mọi mã hiện có tiếp tục đọc/ghi YYYY-MM-DD như trước.
function initVietnameseDateInputs(root) {
  if (typeof document === 'undefined' || typeof HTMLInputElement === 'undefined') return;
  const scope = root || document;
  const valueDescriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  if (!valueDescriptor || !valueDescriptor.get || !valueDescriptor.set) return;

  const isoToDisplay = iso => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    return match ? `${match[3]}/${match[2]}/${match[1]}` : '';
  };
  const displayToIso = display => {
    const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(display || '').trim());
    if (!match) return '';
    const day = Number(match[1]); const month = Number(match[2]); const year = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return '';
    return `${match[3]}-${match[2]}-${match[1]}`;
  };
  const maskDisplay = raw => {
    const text = String(raw || '').trim();
    const iso = isoToDisplay(text);
    if (iso) return iso;
    const digits = text.replace(/\D/g, '').slice(0, 8);
    return digits.length > 4 ? `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`
      : digits.length > 2 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : digits;
  };

  for (const source of scope.querySelectorAll('input[type="date"]')) {
    if (source.dataset.dmyReady === '1') continue;
    source.dataset.dmyReady = '1';
    const proxy = document.createElement('input');
    proxy.type = 'text';
    proxy.className = `${source.className || ''} date-dmy-input`.trim();
    proxy.placeholder = 'DD/MM/YYYY';
    proxy.inputMode = 'numeric';
    proxy.maxLength = 10;
    proxy.autocomplete = 'off';
    proxy.spellcheck = false;
    proxy.setAttribute('aria-label', source.getAttribute('aria-label') || 'Ngày (DD/MM/YYYY)');
    proxy.value = isoToDisplay(valueDescriptor.get.call(source));
    source.classList.add('date-iso-source');
    source.tabIndex = -1;
    source.setAttribute('aria-hidden', 'true');
    source.insertAdjacentElement('afterend', proxy);

    const render = value => { proxy.value = isoToDisplay(value); proxy.setCustomValidity(''); };
    Object.defineProperty(source, 'value', {
      configurable: true,
      get() { return valueDescriptor.get.call(source); },
      set(value) { valueDescriptor.set.call(source, value || ''); render(valueDescriptor.get.call(source)); },
    });
    const commit = () => {
      const text = proxy.value.trim();
      if (!text) {
        proxy.setCustomValidity('');
        if (source.value !== '') { source.value = ''; source.dispatchEvent(new Event('change', { bubbles: true })); }
        return true;
      }
      const iso = displayToIso(text);
      if (!iso) {
        proxy.setCustomValidity('Nhập ngày đúng định dạng DD/MM/YYYY.');
        proxy.classList.add('date-invalid');
        return false;
      }
      proxy.classList.remove('date-invalid');
      proxy.setCustomValidity('');
      if (source.value !== iso) { source.value = iso; source.dispatchEvent(new Event('change', { bubbles: true })); }
      else render(iso);
      return true;
    };
    proxy.addEventListener('input', () => {
      const next = maskDisplay(proxy.value);
      if (proxy.value !== next) proxy.value = next;
      proxy.classList.remove('date-invalid');
      proxy.setCustomValidity('');
    });
    proxy.addEventListener('blur', commit);
    proxy.addEventListener('change', commit);
    proxy.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !commit()) { event.preventDefault(); proxy.reportValidity(); }
    });
  }
}

const api = { rangeFor, monthRange, quarterRange, yearRange, quarterOf, initVietnameseDateInputs };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') {
  window.Period = api;
  initVietnameseDateInputs(document);
}
