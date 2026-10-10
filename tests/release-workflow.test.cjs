'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{spawnSync}=require('node:child_process');
const source=fs.readFileSync('.github/workflows/release.yml','utf8'),block=source.slice(source.indexOf('          $existingJson ='),source.indexOf('          gh release create')).replace(/^          /gm,'');
for(const mode of ['complete','incomplete','absent'])test('published release handling: '+mode,()=>{
 const names=mode==='complete'?['Setup.exe','Setup.exe.sha256','App.exe','App.exe.sha256']:['Setup.exe'];
 const code=`$ErrorActionPreference='Stop'; $tag='v1.1.6'; $setup='release/Setup.exe'; $binary='release/App.exe'; function gh { $global:LASTEXITCODE=${mode==='absent'?1:0}; '${JSON.stringify({assets:names.map(name=>({name}))})}' };\n${block}\nWrite-Output 'CREATE_NEW_RELEASE'`;
 const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',code],{encoding:'utf8',windowsHide:true});
 if(mode==='incomplete'){assert.notEqual(r.status,0);assert.match(r.stderr,/incomplete/);}
 else {assert.equal(r.status,0,r.stderr);assert.equal(r.stdout.includes('CREATE_NEW_RELEASE'),mode==='absent');if(mode==='complete')assert.match(r.stdout,/Keeping published files unchanged/);}
});
