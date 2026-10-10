'use strict';
const { randomUUID } = require('node:crypto');
function createDatasetStore(snapshot = []) {
  const datasets = new Map(snapshot); let bytes = Buffer.byteLength(JSON.stringify(snapshot));
  function put(rows, mst) {
    if (!Array.isArray(rows) || rows.length > 20000) throw new Error('Dataset tối đa 20.000 dòng; chọn khoảng ngày hẹp hơn.');
    const raw = JSON.stringify(rows), size = Buffer.byteLength(raw);
    if (bytes + size > 32 * 1024 * 1024 || datasets.size >= 16) throw new Error('Dataset vượt giới hạn bộ nhớ; chọn khoảng ngày hẹp hơn.');
    const datasetId = 'ds_' + randomUUID(); datasets.set(datasetId, { rows: JSON.parse(raw), mst }); bytes += size;
    return { datasetId, rows: rows.length, schema: Object.keys(rows[0] || {}), samples: rows.slice(0, 3) };
  }
  function get(id, mst) { const value = datasets.get(id); if (!value || value.mst !== mst) throw new Error('Dataset không tồn tại trong tác vụ/MST này. Tìm lại dữ liệu.'); return value.rows; }
  return { put, get, snapshot: () => [...datasets] };
}
module.exports = { createDatasetStore };
