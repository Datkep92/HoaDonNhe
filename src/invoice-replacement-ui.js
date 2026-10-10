(() => {
  "use strict";
  const $ = (id) => document.getElementById(id), escape = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  let job = null, schema = null, page = 0, total = 0, selected = /* @__PURE__ */ new Set(), poll = null, detail = null, busy = false, mappingQueue = Promise.resolve(),generation=0;
  const labels = { matched: "Đủ dữ liệu", mismatch: "Lệch thuế suất", unmatched: "Chưa đối chiếu", ambiguous: "Ghép mơ hồ", error: "Lỗi dữ liệu" };
  const help = {
    files: { title: "Chuẩn bị đúng hai file", text: "Kéo thả hai file .xls/.xlsx cùng lúc. Không cần đổi tên hoặc sắp xếp thứ tự. V2: bảng kê chi tiết hóa đơn đã sử dụng + bảng kê bán ra mẫu quản trị. Bản gốc: sổ chi tiết bán hàng + danh sách hàng hóa. Mẫu nhập MISA đã có sẵn.", image: "/replacement-input-guide.svg" },
    mapping: { title: "Kiểm tra nhận diện và cột so sánh", text: "Ứng dụng tìm bảng trong các sheet và 50 dòng đầu. Kiểm tra sheet, dòng tiêu đề, loại báo cáo và giá trị mẫu. Chọn cột cho trường còn thiếu hoặc trùng; không ghép số chứng từ thành số hóa đơn, tiền thuế thành thuế suất. Cột dư không dùng tính toán. Lưu mapping chỉ áp dụng khi bộ tiêu đề vẫn khớp.", image: "/replacement-mapping-guide.svg" },
    metadata: { title: "Bổ sung thông tin cần nhập MISA", text: "Thông tin có trong file được ưu tiên giữ nguyên. Giá trị chung theo lô chỉ bù trường còn thiếu; mở Chi tiết để sửa riêng từng hóa đơn. Ký hiệu là ký hiệu hóa đơn gốc bị thay thế. Ngày mới mặc định hôm nay theo giờ Việt Nam." },
    results: { title: "Chọn và kiểm tra hóa đơn", text: "Hóa đơn có ít nhất một dòng lệch thuế suất là ứng viên. File xuất chứa toàn bộ dòng của hóa đơn đã chọn. Chỉ dòng lệch được tính lại, giữ tổng thanh toán. Dòng chưa đối chiếu/ghép mơ hồ cần xác nhận riêng để giữ nguyên. Lỗi dữ liệu, chiết khấu, khuyến mại cần sửa file nguồn. Hóa đơn hủy/đã bị thay thế bị loại." },
    export: { title: "Tạo file thay thế hàng loạt cho MISA", text: "1. Nhập hai file và xác nhận mapping. 2. Bổ sung thông tin thiếu. 3. Kiểm tra chi tiết trước/sau, xác minh trạng thái và chọn hóa đơn. 4. Xuất MISA và báo cáo đối chiếu riêng. 5. Vào MISA, dùng chức năng nhập Excel phù hợp với mẫu thay thế để nhập thử, kiểm tra trước khi phát hành. Đây là file để nhập MISA; hóa đơn chưa được phát hành. Phần mềm khác: cung cấp file mẫu nhập, hai file nguồn mẫu và yêu cầu xử lý cho Admin để xây dựng cấu trúc phù hợp.", image: "/replacement-output-guide.svg" }
  };
  function message(text, error = false) {
    $("ir-message").textContent = text;
    $("ir-message").classList.toggle("ir-error", error);
  }
  async function api(action, data = {}, get = false) {
    const params = { jobId: job?.jobId, revision: job?.revision, ...data };
    const url = "/api/invoice-replacement/" + action + (get ? "?" + new URLSearchParams(params) : "");
    const response = await fetch(url, get ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params) });
    const value = await response.json();
    if (!response.ok || value.ok === false) throw new Error(value.error || "Không xử lý được yêu cầu.");
    return value;
  }
  function guard(fn) {
    return async (...args) => {
      try {
        await fn(...args);
      } catch (e) {
        message(e.message, true);
      }
    };
  }
  function setBusy(value) {
    busy = value;
    $("ir-upload").disabled = value;
    $("ir-process").disabled = value;
    $("ir-export").disabled = value;
    $("ir-report").disabled = value;
    $("ir-stop").disabled = !value;
    $("ir-save-defaults").disabled = value || !job?.stats;
    $("ir-map-files").querySelectorAll("input,select,button").forEach((el) => el.disabled = value);
  }
  async function selectAll() {
    const revision = job.revision;
    for (let n = 0; n < Math.ceil(total / 50); n++) {
      const value = await api("results", { page: n, filter: $("ir-filter").value }, true);
      if (job.revision !== revision) throw new Error("Mapping đã đổi. Chọn lại hóa đơn.");
      value.items.filter((inv) => inv.candidate && inv.status !== "excluded" && !inv.errors).forEach((inv) => selected.add(inv.id));
    }
    await results();
  }
  function showHelp(key) {
    const h = help[key];
    $("ir-help-title").textContent = h.title;
    $("ir-help-text").textContent = h.text;
    $("ir-help-image").hidden = !h.image;
    if (h.image) $("ir-help-image").src = h.image;
    $("ir-help-dialog").showModal();
  }
  function mappingChanged() {
    selected.clear();
    $("ir-results").hidden = true;
    $("ir-save-defaults").disabled = true;
    if ($("ir-detail-dialog").open) $("ir-detail-dialog").close();
    detail = null;
    mappingQueue = mappingQueue.then(async () => {
      job = await api("invalidate");
    }).catch((e) => message(e.message, true));
    return mappingQueue;
  }
  async function init() {
    if (schema) return;
    schema = await api("schema", {}, true);
    $("ir-new-date").value = schema.today;
  }
  async function tick() {
    if (!job) return;
    const epoch=generation;
    const latest = await api("progress", {}, true);
    if(epoch!==generation)return;
    job = latest;
    $("ir-progress").value = latest.percent || 0;
    message(latest.message || "Đang nhận diện file…");
    if (latest.state === "running") return;
    if (poll) {
      clearInterval(poll);
      poll = null;
    }
    setBusy(false);
    if (latest.state === "error") throw new Error(latest.error);
    if (latest.state === "mapping") {
      renderMapping(latest);
      if (latest.selections) await run();
      else message("Có nguồn/cột chưa rõ. Kiểm tra nhận diện và xác nhận mapping.");
    }
  }
  async function upload(files) {
    await init();
    if(busy)throw new Error('Dừng xử lý trước khi nhập file mới.');
    const list = Array.from(files || []);
    if (list.length !== 2) throw new Error("Chọn đúng hai file .xls/.xlsx cùng lúc.");
    if (list.some((f) => !/^.*\.(xls|xlsx)$/i.test(f.name) || f.size > 25 * 1024 * 1024)) throw new Error("Nhận .xls/.xlsx; tối đa 25 MB mỗi file.");
    const epoch=++generation;
    if (poll) clearInterval(poll);
    if ($("ir-detail-dialog").open) $("ir-detail-dialog").close();
    detail = null;
    selected.clear();
    $("ir-results").hidden = true;
    $("ir-mapping").hidden = true;
    setBusy(true);
    try {
      const payload = await Promise.all(list.map((f) => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("Không đọc được file"));
        reader.onload = () => resolve({ name: f.name, dataBase64: String(reader.result).split(",")[1] });
        reader.readAsDataURL(f);
      })));
      if(epoch!==generation)return;
      const uploaded=await api("upload", { files: payload });
      if(epoch!==generation){await api('stop',{jobId:uploaded.jobId,revision:uploaded.revision});return;}
      job = uploaded;
      message("Đang nhận diện hai file…");
      poll = setInterval(() => guard(tick)(), 600);
    } catch (e) {
      if(epoch===generation)setBusy(false);
      throw e;
    }
  }
  function renderMapping(j) {
    $("ir-mapping").hidden = false;
    $("ir-map-files").innerHTML = j.descriptions.map((s, i) => `<section class="ir-source" data-index="${i}"><h4>${escape(s.name)}</h4><label>Bảng / loại báo cáo<select class="ir-candidate">${s.candidates.map((c, n) => `<option value="${n}">${escape(c.sheet)} · dòng ${c.start + 1}–${c.start + c.depth} · ${escape(schema.roles[c.role].label)}${c.missing.length ? " · thiếu cột" : ""}</option>`).join("")}</select></label><div class="ir-manual"><label>Sheet<select class="ir-sheet">${s.sheets.map((x) => `<option>${escape(x.name)}</option>`).join("")}</select></label><label>Loại<select class="ir-role">${Object.entries(schema.roles).map(([k, v]) => `<option value="${k}">${escape(v.label)}</option>`).join("")}</select></label><label>Dòng tiêu đề<input class="ir-start" type="number" min="1" max="50"></label><label>Số dòng tiêu đề<select class="ir-depth"><option>1</option><option>2</option><option>3</option></select></label></div><div class="ir-fields table-scroll"></div></section>`).join("");
    $("ir-map-files").querySelectorAll(".ir-source").forEach((section, i) => {
      const s = j.descriptions[i];
      function populate(c) {
        if (!c) return;
        section.querySelector(".ir-sheet").value = c.sheet;
        section.querySelector(".ir-role").value = c.role;
        section.querySelector(".ir-start").value = c.start + 1;
        section.querySelector(".ir-depth").value = c.depth;
        section.querySelector(".ir-fields").innerHTML = "<table><thead><tr><th>Trường đích</th><th>Cột trong file</th><th>Giá trị mẫu</th></tr></thead><tbody>" + Object.entries(schema.aliases).map(([f, names]) => `<tr><td>${escape(names[0])}${schema.roles[c.role].required.includes(f) ? " *" : ""}</td><td><select data-field="${f}"><option value="">Không có</option>${c.headers.map((h, n) => `<option value="${n}" ${c.fields[f] === n ? "selected" : ""}>${n + 1}. ${escape(h || "(trống)")}</option>`).join("")}</select></td><td class="ir-sample" data-sample="${f}">${escape(c.fields[f] != null ? c.samples[c.fields[f]].join(" · ") : "")}</td></tr>`).join("") + "</tbody></table>";
        section.querySelectorAll("[data-field]").forEach((el) => el.onchange = () => {
          section.querySelector(`[data-sample="${el.dataset.field}"]`).textContent = el.value === "" ? "" : (c.samples[+el.value] || []).join(" · ");
        });
      }
      const initial = j.selections?.[i] || s.candidates[0];
      const index = s.candidates.findIndex((c) => initial && c.sheet === initial.sheet && c.role === initial.role && c.start === initial.start && c.depth === initial.depth);
      section.querySelector(".ir-candidate").value = index < 0 ? "0" : String(index);
      populate(initial);
      section.querySelector(".ir-candidate").onchange = (event) => populate(s.candidates[+event.target.value]);
      section.addEventListener("change", (event) => {
        mappingChanged();
        if (event.target.closest(".ir-manual")) mappingQueue = mappingQueue.then(async () => {
          const choice = { sheet: section.querySelector(".ir-sheet").value, role: section.querySelector(".ir-role").value, start: +section.querySelector(".ir-start").value - 1, depth: +section.querySelector(".ir-depth").value };
          const value = await api("preview", { index: i, choice });
          populate(value.choice);
          if (value.saved) {
            const button = document.createElement("button");
            button.textContent = "Áp dụng mapping đã lưu cho bộ tiêu đề này";
            button.onclick = guard(async () => {
              await mappingChanged();
              populate({ ...value.choice, fields: value.saved.fields });
              button.remove();
            });
            section.querySelector(".ir-fields").prepend(button);
          }
        }).catch((e) => message(e.message, true));
      });
      const saved = j.saved?.[i] || [];
      if (saved.length) {
        const button = document.createElement("button");
        button.textContent = "Áp dụng mapping đã lưu (đúng bộ tiêu đề)";
        button.onclick = guard(async () => {
          const candidate = s.candidates[+section.querySelector(".ir-candidate").value], profile = saved.find((c) => c.role === candidate.role && c.fingerprint === candidate.fingerprint);
          if (!profile) throw new Error("Cấu trúc này chưa có mapping đã lưu.");
          await mappingChanged();
          populate({ ...candidate, fields: profile.fields });
        });
        section.appendChild(button);
      }
      if (!s.candidates.length) {
        section.querySelector(".ir-start").value = 1;
        message("Không tìm được bảng. Chọn sheet, dòng tiêu đề và loại báo cáo để mapping thủ công.", true);
      }
    });
  }
  function choices() {
    return Array.from($("ir-map-files").querySelectorAll(".ir-source")).map((section) => ({ sheet: section.querySelector(".ir-sheet").value, role: section.querySelector(".ir-role").value, start: +section.querySelector(".ir-start").value - 1, depth: +section.querySelector(".ir-depth").value, fields: Object.fromEntries(Array.from(section.querySelectorAll("[data-field]")).filter((el) => el.value !== "").map((el) => [el.dataset.field, +el.value])) }));
  }
  async function run() {
    await mappingQueue;
    const epoch=generation;
    setBusy(true);
    selected.clear();
    $("ir-results").hidden = true;
    message("Đang đối chiếu…");
    const timer = setInterval(() => guard(async () => {
      if(epoch!==generation)return;
      const status = await api("progress", {}, true);
      if(epoch!==generation)return;
      $("ir-progress").value = status.percent || 0;
      message(status.message || "Đang đối chiếu…");
    })(), 700);
    try {
      const updated=await api("mapping", { selections: choices(), save: $("ir-save-mapping").checked });
      if(epoch!==generation)return;
      job = updated;
      $("ir-results").hidden = false;
      $("ir-mapping").open = false;
      page = 0;
      await results();
      const metadataMissing = $("ir-rows").textContent.includes("Thiếu");
      $("ir-metadata-card").open = metadataMissing;
      (metadataMissing ? $("ir-metadata-card") : $("ir-results")).scrollIntoView({ behavior: "smooth", block: "start" });
    } catch(error){if(epoch===generation){try{job=await api('progress',{},true);}catch{}throw error;}} finally {
      clearInterval(timer);
      if(epoch===generation)setBusy(false);
    }
  }
  function defaults() {
    return Object.fromEntries(Array.from($("ir-defaults").querySelectorAll("[data-meta]")).map((el) => [el.dataset.meta, el.value.trim()]));
  }
  async function saveMetadata() {
    job = await api("metadata", { defaults: defaults(), newDate: $("ir-new-date").value });
    await results();
  }
  async function results() {
    const r = await api("results", { page, filter: $("ir-filter").value }, true);
    total = r.total;
    const stats = job.stats;
    $("ir-stats").textContent = stats ? `${stats.invoices} hóa đơn · ${stats.lines} dòng · ${stats.candidates} hóa đơn lệch · ${stats.changed} dòng cần sửa${stats.ignored ? ` · ${stats.ignored} dòng tổng/thiếu mã (xem báo cáo)` : ''}` : "";
    $("ir-page").textContent = `${page + 1} / ${Math.max(1, Math.ceil(total / 50))} · Đã chọn ${selected.size}`;
    $("ir-prev").disabled = page === 0;
    $("ir-next").disabled = (page + 1) * 50 >= total;
    $("ir-rows").innerHTML = r.items.map((inv) => `<tr><td><input type="checkbox" data-select="${inv.id}" ${selected.has(inv.id) ? "checked" : ""} ${!inv.candidate || inv.status === "excluded" || inv.errors ? "disabled" : ""}></td><td>${escape(inv.symbol)}<br><b>${escape(inv.number)}</b></td><td>${escape(inv.date)}</td><td>${inv.lineCount}</td><td>${inv.before.toLocaleString("vi-VN")}</td><td>${(inv.after - inv.before).toLocaleString("vi-VN")}</td><td>${escape(inv.sourceStatus || "Cần xác minh")}<br>${escape(inv.blockers.join("; ") || "Đủ điều kiện xuất")}</td><td><button data-detail="${inv.id}">Chi tiết</button></td></tr>`).join("") || '<tr><td colspan="8">Không có hóa đơn phù hợp.</td></tr>';
    $("ir-rows").querySelectorAll("[data-select]").forEach((el) => el.onchange = () => {
      el.checked ? selected.add(el.dataset.select) : selected.delete(el.dataset.select);
      $("ir-page").textContent = `${page + 1} / ${Math.max(1, Math.ceil(total / 50))} · Đã chọn ${selected.size}`;
    });
    $("ir-rows").querySelectorAll("[data-detail]").forEach((el) => el.onclick = guard(() => openDetail(el.dataset.detail)));
    $("ir-select-page").checked = false;
    if(job.blockers?.length)message(`Chặn xuất: ${job.blockers.slice(0,3).join('; ')}${job.blockers.length>3?' (xem thêm báo cáo đối chiếu)':''}`,true);
    else message("Đối chiếu hoàn tất. Kiểm tra thông tin và từng hóa đơn trước khi xuất.");
  }
  async function openDetail(id) {
    const scope = { jobId: job.jobId, revision: job.revision };
    const value = await api("detail", { invoiceId: id }, true);
    if (scope.jobId !== job?.jobId || scope.revision !== job?.revision) throw new Error("Lượt xử lý đã đổi. Mở lại chi tiết hóa đơn.");
    detail = { ...value, ...scope };
    const inv = detail.invoice;
    $("ir-detail-title").textContent = `Hóa đơn ${inv.number} · ${inv.date}`;
    $("ir-detail-errors").textContent = detail.blockers.join("; ");
    $("ir-detail-meta").innerHTML = Object.entries(schema.aliases).filter(([f]) => schema.metadataFields.includes(f)).map(([f, n]) => `<label>${escape(n[0])}<input data-override="${f}" value="${escape(detail.override[f] || "")}" placeholder="${escape(detail.metadata[f] || "Chưa có")}"></label>`).join("");
    $("ir-confirm-keep").checked = detail.confirmation?.keep === true;
    $("ir-confirm-status").checked = detail.confirmation?.status === true;
    $("ir-keep-label").hidden = !inv.unresolved;
    $("ir-status-label").hidden = inv.status !== "unknown";
    $("ir-detail-lines").innerHTML = inv.lines.map((l) => `<tr><td>${escape(l.name)}<br><small>${escape(l.source.file)} · ${escape(l.source.sheet)} · dòng ${l.source.row}</small></td><td>${escape(labels[l.state])}<br>${escape(l.issues.join("; "))}</td><td>${escape(l.before.rate)} → ${escape(l.after.rate)}</td><td>${escape(l.before.net)} → ${escape(l.after.net)}</td><td>${escape(l.before.tax)} → ${escape(l.after.tax)}</td><td>${escape(l.before.gross)} → ${escape(l.after.gross)}</td></tr>`).join("");
    $("ir-detail-dialog").showModal();
  }
  async function saveDetail() {
    if (detail?.jobId !== job?.jobId || detail?.revision !== job?.revision) throw new Error("Chi tiết cũ đã hết hiệu lực. Mở lại hóa đơn.");
    const id = detail.invoice.id, values = Object.fromEntries(Array.from($("ir-detail-meta").querySelectorAll("[data-override]")).map((el) => [el.dataset.override, el.value.trim()]));
    await api("metadata", { invoiceId: id, values, defaults: defaults(), newDate: $("ir-new-date").value });
    await api("confirm", { invoiceId: id, keep: $("ir-confirm-keep").checked, status: $("ir-confirm-status").checked });
    $("ir-detail-dialog").close();
    await results();
  }
  async function download(action) {
    await saveMetadata();
    const epoch=generation,revision=job.revision;
    setBusy(true);
    try {
      const response = await fetch("/api/invoice-replacement/" + action, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId: job.jobId, revision: job.revision, ids: [...selected] }) });
      if (!response.ok) {
        const r = await response.json();
        throw new Error(r.error);
      }
      const blob = await response.blob();
      if(epoch!==generation||revision!==job.revision)return;
      const url = URL.createObjectURL(blob), a = document.createElement("a");
      a.href = url;
      a.download = action === "report" ? "Bao-cao-doi-chieu.xlsx" : "MISA-thay-the-hoa-don.xlsx";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1e4);
      message("Đã xuất file để nhập MISA. Hóa đơn chưa được phát hành.");
    } finally {
      if(epoch===generation)setBusy(false);
    }
  }
  document.addEventListener("DOMContentLoaded", () => {
    if (!$("ir-upload")) return;
    document.querySelectorAll("[data-ir-help]").forEach((el) => el.onclick = () => showHelp(el.dataset.irHelp));
    $("ir-help-close").onclick = () => $("ir-help-dialog").close();
    $("ir-detail-close").onclick = () => $("ir-detail-dialog").close();
    $("ir-detail-save").onclick = guard(saveDetail);
    $("ir-upload").onclick = () => $("ir-files").click();
    $("ir-files").onchange = guard((e) => upload(e.target.files));
    const drop = $("ir-drop");
    drop.ondragover = (e) => {
      e.preventDefault();
      drop.classList.add("ir-drag");
    };
    drop.ondragleave = () => drop.classList.remove("ir-drag");
    drop.ondrop = guard((e) => {
      e.preventDefault();
      drop.classList.remove("ir-drag");
      return upload(e.dataTransfer.files);
    });
    $("ir-process").onclick = guard(run);
    $("ir-stop").onclick = guard(async () => {
      generation++;
      if(job)job = await api("stop");
      if (poll) clearInterval(poll);
      poll = null;
      setBusy(false);
      selected.clear();
      $("ir-results").hidden = true;
      message("Đã dừng. Kết quả và xác nhận cũ đã hết hiệu lực.");
    });
    $("ir-filter").onchange = guard(async () => {
      page = 0;
      await results();
    });
    $("ir-prev").onclick = guard(async () => {
      page--;
      await results();
    });
    $("ir-next").onclick = guard(async () => {
      page++;
      await results();
    });
    $("ir-save-defaults").onclick = guard(saveMetadata);
    $("ir-select-page").onchange = (e) => {
      $("ir-rows").querySelectorAll("[data-select]:not(:disabled)").forEach((el) => {
        el.checked = e.target.checked;
        el.checked ? selected.add(el.dataset.select) : selected.delete(el.dataset.select);
      });
      $("ir-page").textContent = `${page + 1} / ${Math.max(1, Math.ceil(total / 50))} · Đã chọn ${selected.size}`;
    };
    $("ir-export").onclick = guard(() => download("export"));
    $("ir-report").onclick = guard(() => download("report"));
    setBusy(false);
  });
  document.addEventListener("DOMContentLoaded", () => {
    if (!$("ir-select-all")) return;
    $("ir-select-all").onclick = guard(selectAll);
    $("ir-unselect-all").onclick = guard(async () => {
      selected.clear();
      await results();
    });
  });
  window.InvoiceReplacementUI = { ensureInit: guard(init) };
})();
