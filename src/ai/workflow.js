'use strict';
// Local evidence is durable with the request, never trusted model-generated data.
function createWorkflow(saved = {}) {
  const evidence = saved.evidence || [], repeats = saved.repeats || {};
  let calls = saved.calls || 0;
  return {
    snapshot: () => ({ evidence, repeats, calls }),
    observe(call, result, report) {
      calls++;
      const { datasetId, ...stableData } = result.data || {};
      const key = JSON.stringify([call.function?.name, call.function?.arguments, stableData, result.error?.code]);
      repeats[key] = (repeats[key] || 0) + 1;
      if (repeats[key] > 6) throw Object.assign(Error('Agent đang lặp lại cùng kết quả. Đã giữ checkpoint; bổ sung yêu cầu hoặc tiếp tục sau khi nguồn thay đổi.'), { code: 'AGENT_NO_PROGRESS' });
      if (report) {
        let item = evidence.find(e => e.text === report);
        if (!item) { item = { id: 'E' + (evidence.length + 1), text: report, tool: result.meta.tool }; evidence.push(item); }
        result.data.localEvidence = { id: item.id, marker: '[[local:' + item.id + ']]', tool: item.tool, verified: true };
      }
    },
    render(answer) {
      const used = new Set();
      const rendered = String(answer || '').replace(/\[\[local:(E\d+)\]\]/g, (_, id) => {
        const item = evidence.find(e => e.id === id);
        if (!item) return '[Bằng chứng local chưa được xác minh]';
        used.add(id); return item.text;
      });
      // Never lose verified numbers merely because a public model omitted a marker.
      return [rendered, ...evidence.filter(e => !used.has(e.id)).map(e => e.text)].filter(Boolean).join('\n\n');
    }
  };
}
module.exports = { createWorkflow };
