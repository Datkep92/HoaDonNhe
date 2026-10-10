'use strict';
const crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
function usable(v) {
  const s=String(v||'').trim().toUpperCase();
  return s && !/^(UNKNOWN|NONE|N\/A|NOT APPLICABLE|SYSTEM SERIAL NUMBER|DEFAULT STRING|TO BE FILLED.*|0+|F+)$/.test(s) && !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(s) && !/^F{8}-F{4}-F{4}-F{4}-F{12}$/.test(s) ? s : '';
}
function derive(value) {
  const uuid=usable(value.uuid), board=usable(value.board);
  if(!uuid&&!board)return {id:'',source:'unavailable'};
  return {id:'HW2-'+crypto.createHash('sha256').update('cntax-hardware-v2|'+uuid+'|'+board).digest('hex').slice(0,32).toUpperCase(),source:uuid&&board?'uuid-board':uuid?'uuid':'board'};
}
let cached;
function identity() {
  if(cached)return cached;
  if(process.platform!=='win32')return cached={id:'',source:'unavailable'};
  try {
    const result=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$u=(Get-CimInstance Win32_ComputerSystemProduct -ErrorAction Stop).UUID; $b=(Get-CimInstance Win32_BaseBoard -ErrorAction Stop | Select-Object -First 1).SerialNumber; @{uuid=$u;board=$b}|ConvertTo-Json -Compress"],{windowsHide:true,encoding:'utf8',timeout:12000});
    return cached=derive(JSON.parse(result));
  }catch{return cached={id:'',source:'unavailable'};}
}
module.exports={identity,derive,usable};
