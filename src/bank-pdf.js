'use strict';
// ---------------------------------------------------------------------------
// SAO KÊ — PHÂN LOẠI FILE + ĐỌC PDF CÓ CHỮ (LOCAL).
// Phân theo yêu cầu: Excel/CSV → JS local; PDF CÓ CHỮ → pdfjs local (ghép bảng
// theo toạ độ chữ, port từ "src/pdf conver/sidepanel/pdf-to-tables.js");
// PDF SCAN / ẢNH → KHÔNG đọc ở đây, trả kind để UI gửi lên server gọi AI.
// Trang app dùng ES5 + <script> thường (không module), nên file này là IIFE
// gắn window.BankPdf. pdfjs nạp ESM động qua import() — được phép vì 'self'.
// ---------------------------------------------------------------------------

(function () {
  // ---- 1. PHÂN LOẠI -------------------------------------------------------
  // 'excel' = Excel/CSV (JS local); 'pdf-text' = PDF có chữ (pdfjs local);
  // 'pdf-scan' = PDF không có chữ (AI); 'image' = ảnh (AI).
  function classify(fileName, buffer) {
    const name = String(fileName || '').toLowerCase();
    if (/\.csv$/.test(name)) return 'excel';
    if (/\.(xlsx|xls)$/.test(name)) return 'excel';
    if (/\.pdf$/.test(name)) {
      // Đo lượng chữ trong PDF: header %PDF + tìm /Text trong các object nén thô
      // chỉ là DỰ PHÒNG — chính xác là đọc bằng pdfjs rồi đếm ký tự (readPdf).
      return 'pdf-unknown';
    }
    if (/\.(png|jpe?g)$/.test(name)) return 'image';
    return 'unknown';
  }

  // ---- 2. PDFJS (nạp 1 lần, lười) ------------------------------------------
  let pdfjsPromise = null;
  function loadPdfjs() {
    if (!pdfjsPromise) {
      pdfjsPromise = import('./vendor/pdfjs/pdf.min.mjs').then(lib => {
        lib.GlobalWorkerOptions.workerSrc = './vendor/pdfjs/pdf.worker.min.mjs';
        return lib;
      }).catch(error => {
        pdfjsPromise = null;
        throw new Error('Không nạp được bộ đọc PDF: ' + error.message);
      });
    }
    return pdfjsPromise;
  }

  // ---- 3. PORT pdf-to-tables (ghép bảng theo toạ độ) -----------------------
  function clusterIntoRows(items, yTolerance) {
    if (!items.length) return [];
    const sorted = items.slice().sort((a, b) => a.y - b.y);
    const rows = [];
    let current = [sorted[0]];
    let currentY = sorted[0].y;
    for (let i = 1; i < sorted.length; i++) {
      const it = sorted[i];
      if (Math.abs(it.y - currentY) <= yTolerance) {
        current.push(it);
        currentY = (currentY * (current.length - 1) + it.y) / current.length;
      } else {
        rows.push(current);
        current = [it];
        currentY = it.y;
      }
    }
    if (current.length) rows.push(current);
    for (const row of rows) row.sort((a, b) => a.x - b.x);
    return rows;
  }

  function detectColumnAnchors(rows, xTolerance) {
    const xs = [];
    for (const row of rows) for (const it of row) xs.push(it.x);
    if (!xs.length) return [];
    xs.sort((a, b) => a - b);
    const anchors = [];
    let cluster = [xs[0]];
    for (let i = 1; i < xs.length; i++) {
      if (xs[i] - cluster[cluster.length - 1] <= xTolerance) cluster.push(xs[i]);
      else { anchors.push(cluster.reduce((a, b) => a + b, 0) / cluster.length); cluster = [xs[i]]; }
    }
    if (cluster.length) anchors.push(cluster.reduce((a, b) => a + b, 0) / cluster.length);
    return anchors;
  }

  const NUMERIC_RE = /^[-+(]?[$€£¥₽]?\s?\d[\d,.\s]*\)?%?$/;
  function isNumericItem(it) { return it.width > 0 && NUMERIC_RE.test(it.text.trim()); }

  function detectRightColumns(rows, xTolerance, minSupport) {
    minSupport = minSupport || 3;
    const pieces = new Set();
    for (const row of rows) {
      for (let i = 0; i + 1 < row.length; i++) {
        if (row[i + 1].x - (row[i].x + row[i].width) < 1) pieces.add(row[i]);
      }
    }
    const nums = [];
    for (const row of rows) for (const it of row) if (isNumericItem(it) && !pieces.has(it)) nums.push(it);
    nums.sort((a, b) => (a.x + a.width) - (b.x + b.width));
    const cols = [];
    let cluster = [];
    const flush = () => {
      if (cluster.length < minSupport) return;
      const lefts = cluster.map(it => it.x);
      if (Math.max.apply(null, lefts) - Math.min.apply(null, lefts) <= xTolerance) return;
      cols.push({
        right: cluster.reduce((s, it) => s + it.x + it.width, 0) / cluster.length,
        left: Math.min.apply(null, cluster.map(it => it.x)),
        top: Math.min.apply(null, cluster.map(it => it.y)),
        bottom: Math.max.apply(null, cluster.map(it => it.y)),
        members: new Set(cluster),
      });
    };
    for (const it of nums) {
      const last = cluster[cluster.length - 1];
      if (last && (it.x + it.width) - (last.x + last.width) > xTolerance) { flush(); cluster = []; }
      cluster.push(it);
    }
    flush();
    return cols;
  }

  function rightColumnOf(it, rightCols, xTolerance) {
    const found = rightCols.findIndex(c => c.members.has(it));
    if (found >= 0) return found;
    const right = it.x + (it.width || 0);
    const center = it.x + (it.width || 0) / 2;
    return rightCols.findIndex(c => center >= c.left - xTolerance
      && center <= c.right + xTolerance
      && Math.abs(right - c.right) <= xTolerance * 2
      && it.y >= c.top - xTolerance * 15 && it.y <= c.bottom + xTolerance);
  }

  function alignRightColumns(rows, xTolerance) {
    const rightCols = detectRightColumns(rows, xTolerance);
    if (!rightCols.length) return rows;
    return rows.map(row => {
      const out = row.slice();
      for (let i = 0; i < row.length; i++) {
        const rc = rightColumnOf(row[i], rightCols, xTolerance);
        if (rc < 0) continue;
        const dx = rightCols[rc].left - row[i].x;
        for (let j = i; j >= 0 && (j === i || row[j + 1].x - (row[j].x + row[j].width) < 1); j--) {
          out[j] = Object.assign({}, row[j], { x: row[j].x + dx });
        }
      }
      return out;
    });
  }

  function assignToColumns(rows, anchors) {
    const grid = [];
    for (const row of rows) {
      const cells = new Array(anchors.length).fill('');
      for (const it of row) {
        let best = 0;
        let bestDist = Math.abs(it.x - anchors[0]);
        for (let i = 1; i < anchors.length; i++) {
          const d = Math.abs(it.x - anchors[i]);
          if (d < bestDist) { bestDist = d; best = i; }
        }
        cells[best] = cells[best] ? cells[best] + ' ' + it.text.trim() : it.text.trim();
      }
      grid.push(cells);
    }
    return grid;
  }

  function trimEmptyRows(grid) { return grid.filter(row => row.some(c => c && String(c).trim().length > 0)); }

  function trimEmptyColumns(grid) {
    if (!grid.length) return grid;
    const nCols = Math.max.apply(null, grid.map(r => r.length));
    const keep = new Array(nCols).fill(false);
    for (const row of grid) for (let i = 0; i < row.length; i++) if (row[i] && String(row[i]).trim().length > 0) keep[i] = true;
    return grid.map(row => row.filter((_, i) => keep[i]));
  }

  function medianItemHeight(items) {
    if (!items.length) return 10;
    const heights = items.map(it => it.height || 0).filter(h => h > 0).sort((a, b) => a - b);
    if (!heights.length) return 10;
    return heights[Math.floor(heights.length / 2)];
  }

  function mergeSparseColumns(grid, minFillRatio) {
    minFillRatio = minFillRatio || 0.15;
    if (grid.length < 4) return grid;
    const nCols = Math.max.apply(null, grid.map(r => r.length));
    if (nCols < 3) return grid;
    const fillCount = new Array(nCols).fill(0);
    for (const row of grid) for (let i = 0; i < row.length; i++) if (row[i] && String(row[i]).trim().length > 0) fillCount[i]++;
    const minRows = Math.max(2, Math.ceil(grid.length * minFillRatio));
    const sparseIdx = new Set();
    for (let i = 0; i < nCols; i++) if (fillCount[i] < minRows) sparseIdx.add(i);
    if (!sparseIdx.size) return grid;
    return grid.map(row => {
      const out = [];
      for (let i = 0; i < row.length; i++) {
        const v = (row[i] || '').trim();
        if (!sparseIdx.has(i)) out.push(v);
        else if (v) {
          if (out.length > 0) out[out.length - 1] = out[out.length - 1] ? out[out.length - 1] + ' ' + v : v;
          else out.push(v);
        }
      }
      return out;
    });
  }

  function pageToGrid(items, opts) {
    opts = opts || {};
    const usable = items.filter(it => it.text && it.text.trim().length > 0);
    if (!usable.length) return { grid: [], chars: 0 };

    const medH = medianItemHeight(usable);
    const yTolerance = opts.yTolerance || Math.max(2, Math.min(6, medH * 0.5));
    const xTolerance = opts.xTolerance || Math.max(3, Math.min(8, medH * 0.6));
    const maxCols = opts.maxCols || 9; // sao kê VN thường 7-9 cột

    let grid = assignToColumns(alignRightColumns(clusterIntoRows(usable, yTolerance), xTolerance), detectColumnAnchors(usable.length ? clusterIntoRows(usable, yTolerance) : [], xTolerance));
    grid = mergeSparseColumns(grid, 0.12);
    grid = trimEmptyColumns(grid);
    // Chỉ gộp cột khi vượt maxCols — sao kê cần giữ nhiều cột nên cap cao hơn PDF hoá đơn.
    while (grid.length && Math.max.apply(null, grid.map(r => r.length)) > maxCols) {
      const fill = new Array(maxCols + 2).fill(0);
      for (const row of grid) for (let i = 0; i < row.length; i++) if (row[i] && String(row[i]).trim().length > 0) fill[i]++;
      let minIdx = 0;
      for (let i = 1; i < grid[0].length; i++) if (fill[i] < fill[minIdx]) minIdx = i;
      const target = minIdx > 0 ? minIdx - 1 : 1;
      grid = grid.map(row => {
        const out = row.slice();
        const val = (out[minIdx] || '').trim();
        if (val) out[target] = out[target] ? out[target] + ' ' + val : val;
        out.splice(minIdx, 1);
        return out;
      });
    }
    grid = trimEmptyRows(grid);
    const chars = usable.reduce((sum, it) => sum + it.text.length, 0);
    return { grid, chars };
  }

  // ---- 4. ĐỌC PDF: trả { kind, grid, chars, pages } ------------------------
  async function readPdf(arrayBuffer) {
    const lib = await loadPdfjs();
    const pdf = await lib.getDocument({ data: arrayBuffer }).promise;
    const grid = [];
    let chars = 0;
    let pages = 0;
    const MAX_PAGES = 30; // chặn file khổng lồ treo UI; file dài hơn thì dùng AI
    for (let i = 1; i <= Math.min(pdf.numPages, MAX_PAGES); i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const viewport = page.getViewport({ scale: 1 });
      const items = content.items.map(it => ({
        text: it.str,
        x: it.transform[4],
        y: viewport.height - it.transform[5],
        width: it.width,
        height: it.height,
      }));
      const result = pageToGrid(items);
      chars += result.chars;
      pages += 1;
      if (i > 1) grid.push([]); // ngăn cách giữa các trang
      for (const row of result.grid) grid.push(row);
      page.cleanup();
    }
    await pdf.destroy();
    if (chars <= 50) return { kind: 'pdf-scan', grid: [], chars, pages: pdf.numPages };
    return { kind: 'pdf-text', grid, chars, pages };
  }

  // ---- 5. API CHÍNH --------------------------------------------------------
  // Đọc file theo loại: Excel/CSV/PDF-chữ trả grid NGAY (local, offline).
  // PDF-scan/ảnh trả { kind } để UI gửi nguyên buffer lên server gọi AI.
  async function readAny(file) {
    const kind = classify(file.name);
    if (kind === 'excel') return { kind: 'excel' }; // UI gửi thẳng cho server đường cũ/mới
    if (kind === 'image') return { kind: 'image' };
    if (kind === 'pdf-unknown') {
      let buffer;
      try { buffer = await file.arrayBuffer(); } catch (error) { throw new Error('Đọc file không được: ' + error.message); }
      const result = await readPdf(buffer);
      if (result.kind === 'pdf-scan') return { kind: 'pdf-scan' }; // không có chữ → AI
      return { kind: 'pdf-text', grid: result.grid, pages: result.pages };
    }
    throw new Error('Chỉ nhận file .xlsx, .xls, .csv, .pdf, .png hoặc .jpg.');
  }

  window.BankPdf = { classify, readAny, readPdf };
})();
