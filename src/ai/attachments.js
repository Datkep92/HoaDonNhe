'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const XLSX = require('../../resources/xlsx.cjs');
const JSZip = require('jszip');
const MAX = 12 * 1024 * 1024;
const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.pdf': 'application/pdf' };
function createAttachments(dataDir) {
  const dir = path.join(dataDir, 'ai-uploads');
  function load(id, provider, companyId) {
    if (!/^[a-f0-9-]{36}$/.test(id || '')) throw new Error('Mã file đính kèm không hợp lệ.');
    let record;
    try { record = JSON.parse(fs.readFileSync(path.join(dir, id + '.json'), 'utf8')); } catch { throw new Error('File đính kèm không còn tồn tại.'); }
    if (record.provider !== provider) throw new Error('File thuộc cuộc trò chuyện AI khác.');
    if (companyId !== undefined && record.companyId !== companyId) throw new Error('File không thuộc công ty hiện tại.');
    return record;
  }
  async function upload(req, filename, provider, companyId = 'GLOBAL', meta = {}) {
    const ext = path.extname(filename || '').toLowerCase();
    if (!['.xlsx', '.xls', '.csv', '.txt', '.json', '.xml', '.md', '.docx', ...Object.keys(mime)].includes(ext)) throw new Error('Hỗ trợ Excel, CSV, PDF, DOCX, TXT, JSON, XML và ảnh PNG/JPG/WebP.');
    if (!filename || filename.length > 160 || /[\\/\x00-\x1f]/.test(filename)) throw new Error('Tên file đính kèm không hợp lệ.');
    let size = 0, overflow = false; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > MAX) { overflow = true; chunks.length = 0; } else if (!overflow) chunks.push(chunk); }
    if (overflow || !size) throw new Error('File phải có dữ liệu và không quá 12 MB.');
    const bytes = Buffer.concat(chunks);
    if (['.xlsx', '.docx'].includes(ext)) {
      const zip = await JSZip.loadAsync(bytes);
      let expanded = 0;
      for (const entry of Object.values(zip.files)) { expanded += entry._data?.uncompressedSize || 0; if (expanded > 48 * 1024 * 1024) throw new Error('File giải nén vượt 48 MB. Chia tài liệu nhỏ hơn.'); }
    }
    const record = { id: randomUUID(), filename, provider, companyId, ext, size, created: Date.now(),
      // `role`/`sourceId` giữ quan hệ NGUỒN (file gốc) ↔ DẪN XUẤT (vd. bản .pdf.txt do UI trích).
      // Nhờ đó tool PDF đọc đúng file gốc thay vì bản text đã mất toạ độ bảng.
      role: meta.role === 'derived' ? 'derived' : 'source',
      sourceId: typeof meta.sourceId === 'string' && /^[a-f0-9-]{36}$/.test(meta.sourceId) ? meta.sourceId : undefined };
    if (ext === '.pdf' && bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('File PDF không hợp lệ.');
    if (mime[ext]?.startsWith('image/')) {
      // Decode and normalize images rather than trusting filename/MIME.
      const sharp = require('sharp');
      const image = await sharp(bytes, { limitInputPixels: 40000000 }).rotate().resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
      record.image = 'data:image/png;base64,' + image.toString('base64');
    } else if (['.xlsx', '.xls', '.csv'].includes(ext)) {
      const book = XLSX.read(bytes, { type: 'buffer', cellFormula: false, cellHTML: false, sheetRows: 20002 });
      record.sheets = book.SheetNames.map(name => ({ name, rows: XLSX.utils.sheet_to_json(book.Sheets[name], { defval: '', raw: true }) }));
      if (record.sheets.reduce((n, s) => n + s.rows.length, 0) > 20000 || record.sheets.some(s => s.rows.length > 20000)) throw new Error('File vượt 20.000 dòng. Chia file nhỏ hơn để phân tích đủ dữ liệu.');
      // sheetRows may truncate a larger sheet: compare original range too.
      for (const sheet of Object.values(book.Sheets)) if (sheet['!fullref'] && XLSX.utils.decode_range(sheet['!fullref']).e.r >= 20002) throw new Error('Sheet vượt 20.000 dòng. Chia file nhỏ hơn.');
    } else if (ext === '.docx') {
      const zip = await JSZip.loadAsync(bytes);
      const entry = zip.file('word/document.xml');
      if (!entry || entry._data.uncompressedSize > 2 * 1024 * 1024) throw new Error('DOCX không hợp lệ hoặc nội dung quá lớn.');
      const xml = await entry.async('string');
      record.text = xml.replace(/<\/w:p>/g, '\n').replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
    } else if (ext !== '.pdf') {
      if (size > 2 * 1024 * 1024) throw new Error('File văn bản không quá 2 MB.');
      record.text = bytes.toString('utf8').replace(/^\uFEFF/, '');
      if (record.text.includes('\u0000')) throw new Error('File văn bản chứa dữ liệu nhị phân.');
      if (ext === '.json') {
        const value = JSON.parse(record.text);
        if (Array.isArray(value) && value.every(row => row && typeof row === 'object' && !Array.isArray(row))) {
          if (value.length > 20000) throw new Error('JSON vượt 20.000 dòng.');
          record.sheets = [{ name: 'JSON', rows: value }];
        }
      }
    }
    if (Buffer.byteLength(JSON.stringify(record)) > 24 * 1024 * 1024) throw new Error('Nội dung giải nén quá lớn.');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, record.id + '.upload' + ext), bytes, { flag: 'wx' });
    fs.writeFileSync(path.join(dir, record.id + '.json'), JSON.stringify(record), { flag: 'wx' });
    return publicRecord(record);
  }
  function publicRecord(record) { return { id: record.id, filename: record.filename, size: record.size, role: record.role || 'source', sourceId: record.sourceId, kind: record.image ? 'image' : record.ext === '.pdf' ? 'pdf' : record.sheets ? 'table' : 'text', sheets: record.sheets?.map(s => ({ name: s.name, rows: s.rows.length })) }; }
  // Bytes gốc đã lưu của một attachment (dùng cho chuyển PDF → Excel).
  function bytes(record) { return fs.readFileSync(path.join(dir, record.id + '.upload' + record.ext)); }
  // Bản GỐC của một attachment: nếu là bản dẫn xuất (.pdf.txt do UI trích) thì lần theo sourceId
  // để lấy đúng file nguồn — nguồn mới có toạ độ chữ để dựng lại bảng.
  function sourceRecord(record) {
    if (!record) return null;
    if (!record.sourceId) return record;
    try { return load(record.sourceId, record.provider, record.companyId); } catch { return null; }
  }
  function parts(records) {
    return records.flatMap(record => {
      if (record.image) return [{ type: 'text', text: 'Ảnh đính kèm: ' + record.filename + ' (id ' + record.id + ')' }, { type: 'image_url', image_url: { url: record.image } }];
      // PDF is parsed locally by the UI into a text attachment. Never forward
      // the whole original PDF through a direct API upload bypass.
      if (record.ext === '.pdf') return [];
      return [];
    });
  }
  return { upload, load, publicRecord, parts, bytes, sourceRecord };
}
module.exports = { createAttachments };
