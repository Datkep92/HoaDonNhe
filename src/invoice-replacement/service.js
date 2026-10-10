"use strict";
const crypto = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs");
const { Worker } = require("node:worker_threads");
const { exportCheck, todayVN, date } = require("./engine");
const { roles, aliases, metadataFields } = require("./mapping");
const jobs = /* @__PURE__ */ new Map();
const MAX_JOBS = 4, MAX_FILE = 25 * 1024 * 1024;
function launch(job, input) {
  if (job.worker) throw new Error("Tác vụ đang chạy.");
  require("./worker");
  const worker = new Worker(path.join(__dirname, "worker.js"));
  job.worker = worker;
  job.state = "running";
  job.percent = 0;
  job.error = "";
  return new Promise((resolve, reject) => {
    let settled = false;
    function finish(error, message) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (job.worker === worker) job.worker = null;
      worker.terminate();
      if (error) {
        if (job.state !== "cancelled") {
          job.state = "error";
          job.error = error.message;
        }
        reject(error);
      } else {
        job.state = "ready";
        job.percent = 100;
        resolve(message);
      }
    }
    const timer = setTimeout(() => finish(new Error("Quá thời gian xử lý. Vui lòng chia nhỏ file.")), 5 * 60 * 1e3);
    timer.unref();
    worker.on("message", (m) => {
      if (m.error) finish(new Error(m.error));
      else if (m.done) finish(null, m);
      else {
        job.percent = m.percent;
        job.message = m.message;
      }
    });
    worker.on("error", (e) => finish(e));
    worker.on("exit", (code) => {
      if (!settled) finish(new Error(job.state === "cancelled" ? "Đã dừng tác vụ." : `Worker đã dừng (${code}).`));
    });
    worker.postMessage(input);
  });
}
function invalidate(job) {
  if (job.worker) {
    job.state = "cancelled";
    job.worker.terminate();
    job.worker = null;
  }
  job.exported=false;
  job.revision++;
  job.result = null;
  job.confirmations = {};
  job.overrides = {};
  job.state = "mapping";
}
function snapshot(job) {
  return { jobId: job.id, revision: job.revision, state: job.state, percent: job.percent, message: job.message, error: job.error, descriptions: job.descriptions, selections: job.selections, defaults: job.defaults, newDate: job.newDate, stats: job.result?.stats, blockers:job.result?.blockers };
}
async function handle(req, res, url, context) {
  const { reply, readBody, dataDir, billing, checkLicense } = context;
  const action = url.pathname.slice("/api/invoice-replacement/".length);
  if (action === "schema") return reply(res, 200, { ok: true, roles, aliases, metadataFields, today: todayVN() });
  const body = req.method === "GET" ? Object.fromEntries(url.searchParams) : await readBody(req);
  const profilePath = path.join(dataDir, "invoice-replacement-mappings.json");
  if (action === "upload") {
    if (!Array.isArray(body.files) || body.files.length !== 2) throw new Error("Nhập đúng hai file .xls/.xlsx.");
    const files = body.files.map((f) => {
      if (!/\.(xls|xlsx)$/i.test(f.name || "")) throw new Error("Chỉ nhận .xls hoặc .xlsx.");
      const buffer = Buffer.from(f.dataBase64 || "", "base64");
      if (!buffer.length || buffer.length > MAX_FILE) throw new Error("Mỗi file phải có dữ liệu và tối đa 25 MB.");
      return { name: path.basename(f.name), buffer };
    });
    for (const [id, j] of jobs) if (Date.now() - j.updated > 60 * 60 * 1e3 && !j.worker) jobs.delete(id);
    if (jobs.size >= MAX_JOBS) {
      const old = [...jobs.values()].find((j) => !j.worker);
      if (!old) throw new Error("Có nhiều tác vụ đang chạy. Hãy dừng một lượt.");
      jobs.delete(old.id);
    }
    const job2 = { id: crypto.randomUUID(), revision: 1, files, updated: Date.now(), defaults: {}, overrides: {}, confirmations: {}, newDate: todayVN() };
    jobs.set(job2.id, job2);
    const pending = launch(job2, { action: "inspect", files }).then((m) => {
      job2.descriptions = m.descriptions;
      job2.selections = m.selections;
      job2.state = "mapping";
      let profiles = {};
      try {
        profiles = JSON.parse(fs.readFileSync(profilePath, "utf8"));
      } catch {
      }
      job2.saved = job2.descriptions.map((s) => s.candidates.map((c) => profiles[`${c.role}:${c.fingerprint}`]).filter(Boolean));
    }).catch(() => {
    });
    void pending;
    return reply(res, 200, { ok: true, ...snapshot(job2) });
  }
  const job = jobs.get(body.jobId);
  if (!job) throw new Error("Lượt xử lý không còn tồn tại. Nhập lại hai file.");
  job.updated = Date.now();
  if (action === "progress") return reply(res, 200, { ok: true, ...snapshot(job), saved: job.saved });
  if (action === "stop") {
    invalidate(job);
    job.state = "cancelled";
    return reply(res, 200, { ok: true, ...snapshot(job) });
  }
  if (+body.revision !== job.revision) throw new Error("Kết quả cũ đã hết hiệu lực. Tải lại lượt xử lý.");
  if (action === "invalidate") {
    if (job.worker) throw new Error("Dừng tác vụ trước khi đổi mapping.");
    invalidate(job);
    return reply(res, 200, { ok: true, ...snapshot(job) });
  }
  if (action === "preview") {
    const output = await launch(job, { action: "preview", files: job.files, index: body.index, choice: body.choice });
    let profiles = {};
    try {
      profiles = JSON.parse(fs.readFileSync(profilePath, "utf8"));
    } catch {
    }
    const saved = profiles[`${output.choice.role}:${output.choice.fingerprint}`];
    return reply(res, 200, { ok: true, choice: output.choice, saved });
  }
  if (action === "mapping" || action === "process") {
    if (job.worker) throw new Error("Dừng tác vụ trước khi đổi mapping.");
    if (!Array.isArray(body.selections) || body.selections.length !== 2) throw new Error("Xác nhận mapping của cả hai file.");
    invalidate(job);
    job.selections=body.selections;
    const result = await launch(job, { action: "process", files: job.files, selections: body.selections });
    job.selections = result.selections;
    job.result = result.result;
    job.state = "ready";
    if (body.save) {
      let profiles = {};
      try {
        profiles = JSON.parse(fs.readFileSync(profilePath, "utf8"));
      } catch {
      }
      for (let i = 0; i < 2; i++) {
        const c = job.selections[i];
        profiles[`${c.role}:${c.fingerprint}`] = c;
      }
      fs.mkdirSync(dataDir, { recursive: true });
      const tmp = profilePath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(profiles));
      fs.renameSync(tmp, profilePath);
    }
    return reply(res, 200, { ok: true, ...snapshot(job) });
  }
  if (!job.result) throw new Error("Chưa có kết quả đối chiếu.");
  if (action === "metadata") {
    for (const value of [body.defaults, body.values]) if (value !== void 0) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Thông tin bổ sung không hợp lệ.");
      for (const [f, v] of Object.entries(value)) if (!metadataFields.includes(f) || typeof v !== "string" || v.length > 1e3) throw new Error("Thông tin bổ sung không hợp lệ.");
    }
    if (body.newDate !== void 0 && !date(body.newDate)) throw new Error("Ngày hóa đơn mới không hợp lệ.");
    if (body.defaults !== void 0) job.defaults = body.defaults;
    if (body.newDate !== void 0) job.newDate = body.newDate;
    if (body.invoiceId) {
      if (!job.result.invoices.some((i) => i.id === body.invoiceId)) throw new Error("Không có hóa đơn này.");
      job.overrides[body.invoiceId] = body.values || {};
    }
    return reply(res, 200, { ok: true, ...snapshot(job) });
  }
  if (action === "confirm") {
    const inv = job.result.invoices.find((i) => i.id === body.invoiceId);
    if (!inv || inv.status === "excluded") throw new Error("Không thể xác nhận hóa đơn này.");
    job.confirmations[inv.id] = { keep: body.keep === true, status: body.status === true };
    return reply(res, 200, { ok: true });
  }
  if (action === "results") {
    let items = job.result.invoices;
    if (body.filter === "candidates") items = items.filter((i) => i.candidate);
    const page = Math.max(0, Number(body.page) || 0), size = 50;
    return reply(res, 200, { ok: true, total: items.length, page, items: items.slice(page * size, (page + 1) * size).map(({ lines, ...inv }) => ({ ...inv, lineCount: lines.length, blockers: exportCheck({ ...inv, lines }, job).blockers, confirmation: job.confirmations[inv.id] })) });
  }
  if (action === "detail") {
    const inv = job.result.invoices.find((i) => i.id === body.invoiceId);
    if (!inv) throw new Error("Không có hóa đơn này.");
    return reply(res, 200, { ok: true, invoice: inv, ...exportCheck(inv, job), confirmation: job.confirmations[inv.id], override: job.overrides[inv.id] || {} });
  }
  if (action === "export" || action === "report") {
    if (!Array.isArray(body.ids) || body.ids.length > 2e4) throw new Error("Danh sách chọn không hợp lệ.");
    if(checkLicense)await checkLicense();
    const produce = () => launch(job, { action: "export", job: { result: job.result, defaults: job.defaults, overrides: job.overrides, confirmations: job.confirmations, newDate: job.newDate }, ids: body.ids, report: action === "report" });
    const fingerprint=JSON.stringify({files:job.files.map(f=>crypto.createHash('sha256').update(f.buffer).digest('hex')).sort(),selections:job.selections,defaults:job.defaults,overrides:job.overrides,ids:body.ids.slice().sort(),newDate:job.newDate});
    const output=action==='export'&&billing?await billing.limited('replacement',fingerprint,produce):await produce();
    if(action==='export')job.exported=true;
    const buffer = Buffer.from(output.buffer);
    res.writeHead(200, { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="${action === "report" ? "Doi-chieu" : "MISA-thay-the"}.xlsx"`, "Cache-Control": "no-store" });
    return res.end(buffer);
  }
  throw new Error("API thay thế hóa đơn không tồn tại.");
}
module.exports = { handle, jobs, launch, invalidate, snapshot, hasUnsavedWork:()=>[...jobs.values()].some(j=>j.worker||(!j.exported&&j.state!=='cancelled'&&j.state!=='error')) };
