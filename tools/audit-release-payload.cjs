'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function main(){
 const version=process.argv[2],dir=path.resolve(process.argv[3]);if(!/^\d+\.\d+\.\d+$/.test(version))throw Error('Expected a numeric X.Y.Z version');
 const setup=path.join(dir,'CN-Tax-Tools-Setup-v'+version+'.exe'),standalone=path.join(dir,'CN-Tax-Tools-v'+version+'.exe');
 const dest=path.resolve('artifacts','release-audit','extracted-'+version);fs.mkdirSync(dest,{recursive:true});
 await new Promise((resolve,reject)=>{const p=spawn(setup,['/S','/PORTABLE','/D='+dest],{windowsHide:true,stdio:'ignore'});p.on('error',reject);p.on('exit',code=>code===0?resolve():reject(Error('Setup exit '+code)));});
 const installed=path.join(dest,'CN-Tax-Tools.exe'),a=hash(standalone),b=hash(installed);
 const result={version,setupHash:hash(setup),standaloneHash:a,payloadHash:b,identical:a===b,extracted:installed};
 fs.writeFileSync(path.join(dest,'audit.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));if(a!==b)process.exitCode=1;
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
