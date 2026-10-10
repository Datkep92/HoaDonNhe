'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const m=require('../src/invoice-replacement/mapping'),e=require('../src/invoice-replacement/engine'),ex=require('../src/invoice-replacement/export'),service=require('../src/invoice-replacement/service');
const H=['Ký hiệu','Số hóa đơn','Ngày hóa đơn','Mã hàng','Tên hàng','ĐVT','Số lượng','Đơn giá','Thành tiền','Thuế suất (%)','Tiền thuế GTGT','Tổng tiền TT','Trạng thái HĐ','Tên khách hàng','Địa chỉ','Hình thức TT'];
const base=['1C26ABC','00000123','01/07/2026','A','Sữa','Hộp',2,50000,100000,10,10000,110000,'Hoá đơn mới','Khách hàng','Địa chỉ gốc','TM/CK'];
const B=['Số hóa đơn','Ngày hóa đơn','Mặt hàng','Doanh số bán chưa có thuế GTGT','Thuế suất'];
function workbook(headers,data,{sheet='Dữ liệu',prefix=[],extra=[],xls=false,merges=[]}={}){const book=m.XLSX.utils.book_new();for(const [name,rows]of extra)m.XLSX.utils.book_append_sheet(book,m.XLSX.utils.aoa_to_sheet(rows),name);const table=m.XLSX.utils.aoa_to_sheet([...prefix,...headers,...data]);if(merges.length)table['!merges']=merges;m.XLSX.utils.book_append_sheet(book,table,sheet);return m.XLSX.write(book,{type:'buffer',bookType:xls?'xls':'xlsx'});}
function sources(a=[base],b=[['00000123','01/07/2026','Sữa',100000,8]],opts={}) {return [m.inspect(workbook([H],a,opts),'arbitrary.xls'),m.inspect(workbook([B],b),'renamed.xlsx')];}
function result(a,b,opts){const s=sources(a,b,opts),c=m.autoSelections(s);assert.ok(c);return e.process(s,c);}
function job(r){return {result:r,defaults:{},overrides:{},confirmations:{},newDate:'2026-10-09'};}
test('file order, names, non-first sheets and moved/extra columns do not change results',()=>{
 const s=sources(undefined,undefined,{prefix:[['BÁO CÁO'],[],[]],extra:[['Sheet trống',[[]]]],xls:true});assert.equal(m.autoSelections(s)[0].start,3);
 const a=e.process(s,m.autoSelections(s)),b=e.process([...s].reverse(),m.autoSelections([...s].reverse()));assert.deepEqual(a.stats,b.stats);assert.equal(a.stats.changed,1);
 const indexes=[15,2,10,4,0,1,14,8,7,3,9,6,11,12,13,5];const moved=m.inspect(workbook([['Cột dư',...indexes.map(i=>H[i])]],[[999,...indexes.map(i=>base[i])]]),'changed.xlsx');const r=e.process([moved,s[1]],m.autoSelections([moved,s[1]]));assert.equal(r.invoices[0].number,'00000123');assert.equal(r.invoices[0].before,110000);
});
test('missing, duplicate and semantically distinct columns require correct mapping',()=>{
 const s=sources();const choice=m.autoSelections(s)[0];assert.equal(choice.fields.number,1);assert.equal(choice.fields.rate,9);assert.equal(choice.fields.tax,10);
 assert.throws(()=>m.validateSelection(s[0],{...choice,fields:{...choice.fields,rate:10}}),/trùng cột/);
 const fields={...choice.fields};delete fields.net;assert.throws(()=>m.validateSelection(s[0],{...choice,fields}),/Thành tiền/);
 const duplicate=m.inspect(workbook([[...H,'Số hóa đơn']],[[...base,'123']]),'a.xlsx');assert.equal(m.autoSelections([duplicate,s[1]]),null);assert.deepEqual(duplicate.candidates.find(c=>c.role==='issued').conflicts.number,[1,16]);
 const confusing=m.inspect(workbook([['Số chứng từ','Ngày','Tên hàng','Thành tiền','Tiền thuế']],[[1,'01/07/2026','A',100,10]]),'a.xlsx');assert.equal(confusing.candidates.some(c=>c.fields.number!=null),false);
});
test('equivalent names, merged multiline headers, and competing sheets',()=>{
 const hs=H.map(h=>h.replace('Thuế suất (%)',' THUE SUAT (*) ').replace('Số hóa đơn','SỐ\nHÓA ĐƠN (*)'));
 const s=[m.inspect(workbook([hs],[base]),'a.xlsx'),sources()[1]];assert.ok(m.autoSelections(s));
 const multi=H.map(h=>h==='Số hóa đơn'?['Số','hóa đơn']:h==='Ngày hóa đơn'?['Ngày','hóa đơn']:[h,'']);
 const buffer=workbook([multi.map(a=>a[0]),multi.map(a=>a[1])],[base]);const inspect=m.inspect(buffer,'multi.xlsx');const c=inspect.candidates.find(c=>c.role==='issued'&&c.start===0&&c.depth===2);assert.ok(c);assert.equal(c.fields.number,1);
 const book=m.XLSX.read(sources()[0].book?workbook([H],[base]):buffer,{type:'buffer'});m.XLSX.utils.book_append_sheet(book,m.XLSX.utils.aoa_to_sheet([H,base]),'Khác');const duplicate=m.inspect(m.XLSX.write(book,{type:'buffer',bookType:'xlsx'}),'multi.xlsx');assert.equal(m.autoSelections([duplicate,sources()[1]]),null);
});
test('Vietnamese numbers, Excel/text dates, percent and blanks are interpreted explicitly',()=>{
 assert.equal(e.number('1.234.567,89'),1234567.89);assert.equal(e.number('1.234.567'),1234567);assert.equal(e.number(''),null);assert.equal(e.number('abc'),null);
 assert.equal(e.rate('8%'),8);assert.equal(e.rate(0.08),8);assert.equal(e.rate(10.000014),10);assert.equal(e.rate('KCT'),null);
 assert.equal(e.rate('0,5%'),0.5);assert.equal(e.date(44742,true),'2026-07-01');
 assert.equal(e.date('31/02/2026'),null);assert.equal(e.date('2026-10-09'),'2026-10-09');assert.equal(e.date(46204),'2026-07-01');
 assert.equal(e.date(0),null);assert.equal(e.date(60),null);
 const r=result();assert.equal(r.invoices[0].lines[0].discount,null);
});
test('missing cached formulas are data errors and never become zero',()=>{
 const s=sources();const sheet=s[0].book.Sheets['Dữ liệu'];sheet.I2={t:'n',f:'G2*H2'};const r=e.process(s,m.autoSelections(s));assert.equal(r.invoices[0].lines[0].state,'error');assert.equal(r.invoices[0].lines[0].net,null);assert.match(r.invoices[0].lines[0].issues.join(' '),/công thức/);
 sheet.I2={t:'e',v:42};const error=e.process(s,m.autoSelections(s));assert.equal(error.invoices[0].lines[0].net,null);assert.match(error.invoices[0].lines[0].issues.join(' '),/Excel báo lỗi/);
});
test('numeric invoice formats and merged data preserve leading zeroes and all rows',()=>{
 const s=sources([base,base]);const sheet=s[0].book.Sheets['Dữ liệu'];sheet.B2={t:'n',v:123,z:'00000000'};delete sheet.B3;sheet['!merges']=[{s:{r:1,c:1},e:{r:2,c:1}}];const choice=m.autoSelections(s);const parsed=e.rows(s[0],choice[0]);assert.equal(parsed[0].number,'00000123');assert.equal(parsed[1].number,'00000123');assert.equal(parsed.length,2);
});
test('a missing invoice number on a detail line cannot silently drop a source item',()=>{
 const line=[...base];line[1]='';const r=result([base,line]),j=job(r);assert.equal(r.blockers.length,1);assert.throws(()=>ex.build(j,['invoice-0']),/Thiếu số hóa đơn/);
});
test('duplicate comparator and reused comparator rows are ambiguous',()=>{
 const b=['00000123','01/07/2026','Sữa',100000,8];assert.equal(result([base],[b,b]).invoices[0].lines[0].state,'ambiguous');const r=result([base,base],[b]);assert.ok(r.invoices[0].lines.every(l=>l.state==='ambiguous'));
});
test('symbol refines matching only when present on both sources',()=>{
 const s=sources();s[1]=m.inspect(workbook([[...B,'Ký hiệu']],[['00000123','01/07/2026','Sữa',100000,8,'OTHER']]),'b.xlsx');const r=e.process(s,m.autoSelections(s));assert.equal(r.invoices[0].lines[0].state,'unmatched');
});
test('exports all lines, modifies only mismatch, preserves gross and buyer; exact 22 columns',()=>{
 const unchanged=[...base];unchanged[4]='Bánh';unchanged[8]=200000;unchanged[7]=100000;unchanged[10]=20000;unchanged[11]=220000;
 const r=result([base,unchanged],[['00000123','01/07/2026','Sữa',100000,8],['00000123','01/07/2026','Bánh',200000,10]]),inv=r.invoices[0],j=job(r);
 assert.equal(inv.lines.length,2);assert.deepEqual(inv.lines[1].after,inv.lines[1].before);assert.equal(inv.before,inv.after);assert.equal(inv.before,330000);
 const book=m.XLSX.read(ex.build(j,[inv.id]),{type:'buffer'}),sheet=book.Sheets[book.SheetNames[0]];
 assert.equal(m.XLSX.utils.decode_range(sheet['!ref']).e.c,21);assert.equal(m.XLSX.utils.decode_range(sheet['!ref']).e.r,10);assert.equal(sheet.M10.v,'00000123');assert.equal(sheet.C10.v,'Khách hàng');assert.equal(sheet.E10.v,'Địa chỉ gốc');assert.equal(sheet.B10.v,'09/10/2026');assert.equal(sheet.N10.v,'01/07/2026');assert.equal(sheet.C11,undefined);assert.equal(sheet.T11.v,200000);assert.equal(sheet.V11.v,20000);assert.match(sheet.A2.v,/Hướng dẫn/);assert.equal(sheet.AA10,undefined);
});
test('unresolved requires individual confirmation; hard errors cannot be waived; unknown status verified',()=>{
 const other=[...base];other[4]='Chưa biết';const r=result([base,other]),j=job(r),inv=r.invoices[0];assert.equal(inv.unresolved,1);assert.throws(()=>ex.build(j,[inv.id]),/xác nhận giữ nguyên/);j.confirmations[inv.id]={keep:true};assert.ok(ex.build(j,[inv.id]));
 inv.status='unknown';assert.throws(()=>ex.build(j,[inv.id]),/xác minh trạng thái/);j.confirmations[inv.id].status=true;assert.ok(ex.build(j,[inv.id]));inv.errors=1;assert.throws(()=>ex.build(j,[inv.id]),/lỗi dữ liệu/);
 const audit=m.XLSX.read(ex.build(j,[inv.id],true),{type:'buffer'});assert.ok(m.XLSX.utils.sheet_to_json(audit.Sheets['Đối chiếu'],{header:1}).some(row=>row.includes('Đã xác nhận')));
});
test('canceled and replaced invoices cannot be exported, even with confirmations',()=>{
 for(const status of ['Hóa đơn đã hủy','Hóa đơn đã bị thay thế']){const a=[...base];a[12]=status;const r=result([a]),j=job(r);j.confirmations[r.invoices[0].id]={keep:true,status:true};assert.throws(()=>ex.build(j,[r.invoices[0].id]),/đã hủy\/đã bị thay thế/);}
});
test('discount, promotion, zero quantity, negative and inconsistent total are blocked',()=>{
 for(const [field,value]of [[6,0],[7,-1],[11,999]]){const a=[...base];a[field]=value;assert.equal(result([a]).invoices[0].lines[0].state,'error');}
 for(const [header,value]of [['Tiền CK',1000],['Tỷ lệ CK (%)',5],['Hàng KM',true],['Tổng KM trước thuế',1000],['Điểm trước thuế',1000]]){const s=sources();s[0]=m.inspect(workbook([[...H,header]],[[...base,value]]),'a.xlsx');const r=e.process(s,m.autoSelections(s));assert.equal(r.invoices[0].lines[0].state,'error');}
});
test('legacy catalog conflicts are ambiguous, identical duplicates safe, revenue is not gross',()=>{
 const ledger=['Ngày','Mã đơn hàng eShop','Số hóa đơn','Mã hàng hóa','Tên hàng hóa','Đơn vị tính','Số lượng','Đơn giá trước thuế','Thành tiền trước thuế','thuế suất','Thuế GTGT','Doanh thu'];
 const a=['01/07/2026','DH1','00000123','A','Sữa','Hộp',2,50000,100000,10,10000,100000];
 const make=b=>[m.inspect(workbook([ledger],[a]),'a.xlsx'),m.inspect(workbook([['Mã hàng hóa','Thuế suất (%)']],b),'b.xlsx')];
 let s=make([['A',8],['A',10]]),r=e.process(s,m.autoSelections(s));assert.equal(r.invoices[0].lines[0].state,'error');assert.match(r.invoices[0].lines[0].issues.join(' '),/Mã hàng trùng/);s=make([['A',8],['A',8]]);r=e.process(s,m.autoSelections(s));assert.equal(r.invoices[0].lines[0].state,'mismatch');assert.equal(r.invoices[0].before,110000);
 const j=job(r);j.defaults={buyer:'Khách lẻ',symbol:'1C26ABC',payment:'TM'};j.confirmations[r.invoices[0].id]={status:true};assert.ok(ex.build(j,[r.invoices[0].id]));
});
test('invalidate removes result and all confirmations and overrides',()=>{const j={revision:1,result:{},confirmations:{x:{keep:true}},overrides:{x:{buyer:'A'}}};service.invalidate(j);assert.equal(j.revision,2);assert.equal(j.result,null);assert.deepEqual(j.confirmations,{});assert.deepEqual(j.overrides,{});});
test('worker supports inspect/process/export and real cancellation',async()=>{
 const files=[{name:'a.xlsx',buffer:workbook([H],[base])},{name:'b.xlsx',buffer:workbook([B],[['00000123','01/07/2026','Sữa',100000,8]])}];
 const j={id:'worker-test',revision:1};const inspected=await service.launch(j,{action:'inspect',files});assert.ok(inspected.selections);const result=await service.launch(j,{action:'process',files,selections:inspected.selections});assert.equal(result.result.stats.changed,1);
 const output=await service.launch(j,{action:'export',job:job(result.result),ids:['invoice-0']});assert.ok(Buffer.from(output.buffer).length>1000);
 const pending=service.launch(j,{action:'inspect',files});j.state='cancelled';await j.worker.terminate();await assert.rejects(pending,/Đã dừng/);assert.equal(j.state,'cancelled');
});
const realRoot=process.env.REPLACEMENT_FIXTURES||'C:/Users/cana2/OneDrive/Desktop/BỐ ĐẠT/x/thay thế hóa đơn';
test('real v2 regression: 257 invoices / 534 rows / 270 corrected / gross 171165002', {skip:!fs.existsSync(realRoot)},()=>{
 const names=['Bang_ke_chi_tiet_hoa_don_da_su_dung_1790946494299.xlsx','BANG_KE_HOA_DON__CHUNG_TU_HANG_HOA__DICH_VU_BAN_RA_(MAU_QUAN_TRI).xlsx'];const s=names.map(n=>m.inspect(fs.readFileSync(path.join(realRoot,n)),n));const r=e.process(s,m.autoSelections(s)),inv=r.invoices.filter(i=>i.candidate);assert.equal(inv.length,257);assert.equal(inv.reduce((n,i)=>n+i.lines.length,0),534);assert.equal(r.stats.changed,270);assert.equal(inv.reduce((n,i)=>n+i.before,0),171165002);assert.equal(inv.reduce((n,i)=>n+i.after,0),171165002);assert.equal(inv.reduce((n,i)=>n+i.errors,0),0);
 const j=job(r);j.defaults.buyer='Khách lẻ';const output=ex.build(j,inv.map(i=>i.id));const book=m.XLSX.read(output,{type:'buffer'}),sheet=book.Sheets[book.SheetNames[0]];assert.equal(m.XLSX.utils.decode_range(sheet['!ref']).e.r,542);assert.equal(m.XLSX.utils.decode_range(sheet['!ref']).e.c,21);
});
test('real legacy preserves every unchanged line and captures source locations', {skip:!fs.existsSync(path.join(realRoot,'thuế sai'))},()=>{
 const names=['SỔ CHI TIẾT BÁN HÀNG (1).xlsx','Danh sách hàng hóa (1).xlsx'];const s=names.map(n=>m.inspect(fs.readFileSync(path.join(realRoot,'thuế sai',n)),n)),r=e.process(s,m.autoSelections(s));assert.equal(r.mode,'legacy');assert.equal(r.stats.lines,3253);assert.ok(r.stats.changed>0);
 for(const inv of r.invoices){assert.equal(inv.before,inv.after);for(const l of inv.lines){if(l.state!=='mismatch')assert.deepEqual(l.before,l.after);assert.ok(l.source.row>=5);}}
});
module.exports={workbook,H,B,base};
