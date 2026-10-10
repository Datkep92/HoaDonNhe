'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process');
async function main(){
 const exe=path.resolve(process.argv[2]),temp=fs.mkdtempSync(path.join(os.tmpdir(),'cntax-fresh-ocr-'));
 const env={...process.env,TMP:temp,TEMP:temp,HOADON_TEST_DATA:path.join(temp,'data'),HOADON_NO_UPDATE_CHECK:'1'};delete env.HOADON_OCR_MODEL;delete env.HOADON_OCR_CHARSET;
 await new Promise((resolve,reject)=>{let output='';const p=spawn(exe,['--test-server','--ocr-check'],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});p.stdout.on('data',v=>output+=v);p.stderr.on('data',v=>output+=v);p.on('error',reject);p.on('exit',code=>{console.log(JSON.stringify({exe,code,output:output.trim(),freshModelBytes:fs.existsSync(path.join(temp,'CN-Tax-Tools-ocr','common.onnx'))?fs.statSync(path.join(temp,'CN-Tax-Tools-ocr','common.onnx')).size:0}));code===0?resolve():reject(Error('OCR check failed'));});});
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
