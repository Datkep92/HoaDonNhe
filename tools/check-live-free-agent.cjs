'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { runAgent } = require('../src/ai/agent'), { createRuntime } = require('../src/ai/free-runtime');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cntax-live-agent-'));
const network = [], events = [];
const runtime = createRuntime(directory, { fetchImpl: async (url, init) => {
 const r = await fetch(url, init); network.push({ status: r.status, endpoint: url, ...(r.ok ? {} : { error: (await r.clone().text()).slice(0, 1500) }) }); return r;
} });
const rows = Array.from({length:2}, () => ({so_hd:'00001', mst_ban:'0123456789', mst_mua:'9876543210', ngay_lap:'2026-09-01', tong_tien:100}));
const app = { context: () => ({currentUser:{selectedMst:'0123456789'}}), search: async () => rows };
(async()=>{
 let answer, error;
 try { answer = await runAgent({ config:{endpoint:'http://127.0.0.1/disabled-cloud', chatTransport:runtime.chat, model:'Auto Free',apiKey:'anonymous-not-a-secret'}, checkLicense:async()=>({status:'Active'}), history:[], text:'Dùng invoice.search lấy hóa đơn tháng 9/2026 chiều SELL, dùng invoice.find_duplicates và xuất Excel bằng file.export_excel. Đây là dữ liệu thử nghiệm.',screen:{},app,dataDir:directory,files:{},emit:e=>events.push(e),signal:AbortSignal.timeout(120000),requestApproval:async()=>true }); }
 catch(e) {error=e.message;process.exitCode=1;}
 finally { runtime.close(); const report={answer,error,network,events,directory};fs.mkdirSync('artifacts',{recursive:true});fs.writeFileSync('artifacts/live-agent-result.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report)); }
})();
