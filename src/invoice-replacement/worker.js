"use strict";
const { parentPort } = require("node:worker_threads");
if (parentPort) parentPort.on("message", (input) => {
  try {
    if (input.action === "export") {
      const buffer = require("./export").build(input.job, input.ids, input.report);
      parentPort.postMessage({ done: true, buffer });
      return;
    }
    const mapping = require("./mapping");
    const sources = input.files.map((f) => mapping.inspect(Buffer.from(f.buffer), f.name));
    if (input.action === "preview") {
      const s = sources[input.index], c = input.choice;
      if (!s?.book.Sheets[c.sheet] || !Number.isInteger(c.start) || c.start < 0 || c.start > 49 || ![1, 2, 3].includes(c.depth) || !mapping.roles[c.role]) throw new Error("Vị trí bảng không hợp lệ.");
      const headers = mapping.headerAt(s.book.Sheets[c.sheet], c.start, c.depth), samples = headers.map((_, col) => [0, 1, 2].map((n) => {
        try {
          return mapping.cellValue(s.book.Sheets[c.sheet], c.start + c.depth + n, col);
        } catch {
          return "[Công thức thiếu giá trị]";
        }
      }));
      parentPort.postMessage({ done: true, choice: { ...c, headers, samples, fields: mapping.mapHeaders(headers).fields, fingerprint: mapping.fingerprint(headers) } });
      return;
    }
    const descriptions = sources.map((s) => ({ name: s.name, candidates: s.candidates, sheets: s.book.SheetNames.map((name) => ({ name, ref: s.book.Sheets[name]["!ref"] })) }));
    if (input.action === "inspect") {
      parentPort.postMessage({ done: true, descriptions, selections: mapping.autoSelections(sources) });
      return;
    }
    const result = require("./engine").process(sources, input.selections, (percent, message) => parentPort.postMessage({ percent, message }));
    parentPort.postMessage({ done: true, result, selections: sources.map((source, i) => mapping.validateSelection(source, input.selections[i])) });
  } catch (error) {
    parentPort.postMessage({ error: error.message });
  }
});
