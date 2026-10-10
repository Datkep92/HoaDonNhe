'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createUpdateMonitor}=require('../src/update-monitor');
test('background monitor discovers a release after startup without restarting; one announcement per version',async()=>{
 let time=0,calls=0,latest='',notices=[];
 const tick=createUpdateMonitor({now:()=>time,check:async()=>{calls++;return{latest,updateAvailable:!!latest};},publish:s=>notices.push(s.latest)});
 await tick();assert.equal(calls,1);
 latest='1.1.8';time=14*60000;await tick();assert.equal(calls,1);
 time=15*60000;await tick();assert.deepEqual(notices,['1.1.8']);
 time=30*60000;await tick();assert.deepEqual(notices,['1.1.8']);
 latest='1.1.9';time=45*60000;await tick();assert.deepEqual(notices,['1.1.8','1.1.9']);
});
test('network failures retry after five minutes and concurrent ticks do not duplicate checks',async()=>{
 let time=0,calls=0,release,fail=true;
 const tick=createUpdateMonitor({now:()=>time,publish:()=>{},check:async()=>{calls++;if(fail)throw Error('offline');return new Promise(r=>release=r);}});
 await assert.rejects(tick(),/offline/);time=299999;await tick();assert.equal(calls,1);
 time=300000;fail=false;const pending=tick();await tick();assert.equal(calls,2);release({updateAvailable:false});await pending;
});
test('failure to publish is retried instead of marking the version announced',async()=>{
 let time=0,attempts=0;
 const tick=createUpdateMonitor({now:()=>time,check:async()=>({latest:'1.1.8',updateAvailable:true}),publish:()=>{if(++attempts===1)throw Error('disk');}});
 await assert.rejects(tick(),/disk/);time=300000;await tick();assert.equal(attempts,2);
});
test('Windows tray script parses and notification click opens the existing application',()=>{
 const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),os=require('node:os');
 const source=fs.readFileSync(path.join(__dirname,'../src/server.js'),'utf8');
 const start=source.indexOf('function trayScript(port)'),end=source.indexOf('\nfunction trayAlive()',start);
 const script=vm.runInNewContext(source.slice(start,end)+';trayScript(62042)',{trayIconPath:()=>'',path,dataDir:os.tmpdir(),sessionSecret:'synthetic',require:()=>({version:'1.1.7'})});
 assert(script.includes("add_BalloonTipClicked({ Invoke-App '/api/window/show' 'POST'"));
 assert(script.includes('[version]$v -gt [version]$installedVersion'));assert(script.includes('$announcedUpdate -ne $v'));
 if(process.platform==='win32'){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tray-parser-')),file=path.join(dir,'tray.ps1');fs.writeFileSync(file,'\ufeff'+script,'utf16le');
  try{require('node:child_process').execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$t=$null;$e=$null;[System.Management.Automation.Language.Parser]::ParseFile('"+file.replace(/'/g,"''")+"',[ref]$t,[ref]$e)|Out-Null;if($e.Count){$e|ForEach-Object Message;exit 1}"],{windowsHide:true,timeout:15000});}finally{fs.rmSync(dir,{recursive:true,force:true});}
 }
});
