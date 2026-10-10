'use strict';
// The embedded legacy BIFF8 template needs BIFF8 output, which the artifact
// XLSX-only writer does not provide. Use the application's existing serializer.
const fs=require('node:fs'),assert=require('node:assert/strict'),XLSX=require('../resources/xlsx.cjs');
const file='resources/invoice-replacement-misa.xls';
const book=XLSX.read(fs.readFileSync(file),{type:'buffer',cellStyles:true});
const sheet=book.Sheets[book.SheetNames[0]];
const before=XLSX.utils.sheet_to_json(sheet,{header:1,defval:''}).slice(0,9);
for(const key of Object.keys(sheet))if(!key.startsWith('!')&&XLSX.utils.decode_cell(key).r>=9)delete sheet[key];
sheet['!ref']='A1:V9';sheet['!rows']=(sheet['!rows']||[]).slice(0,9);sheet['!merges']=(sheet['!merges']||[]).filter(m=>m.e.r<9);
delete sheet['!autofilter'];book.Props={};book.Custprops={};
const buffer=XLSX.write(book,{type:'buffer',bookType:'biff8',cellStyles:true});
const checked=XLSX.read(buffer,{type:'buffer',cellStyles:true});
const after=XLSX.utils.sheet_to_json(checked.Sheets[checked.SheetNames[0]],{header:1,defval:''});
assert.deepEqual(after,before);assert.equal(after.length,9);assert.equal(checked.SheetNames.length,1);
fs.writeFileSync(file,buffer);console.log(JSON.stringify({ok:true,format:'BIFF8',rows:9,columns:22,examplesRemoved:true,instructionsUnchanged:true}));
