'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function load(){const context={module:{exports:{}},setTimeout,require:name=>name==='./tct-api'?{captcha:async()=>({key:'private-key',captcha:'private-image'}),authenticate:async()=> 'private-token'}:{solve:async()=> 'private-answer',lastErrorMessage:()=>''}};vm.runInNewContext(fs.readFileSync('src/login-auto.js','utf8'),context);return context.module.exports;}
test('login stages identify captcha, OCR and authenticate without exposing credentials',async()=>{
 const stages=[],result=await load().autoLogin({username:'private-user',password:'private-password',mst:'0123456789',onStage:(stage,attempt)=>stages.push({stage,attempt})});
 assert.equal(result.ok,true);assert.deepEqual(stages.map(x=>x.stage),['captcha-request','ocr-start','authenticate-request','authenticated']);assert.equal(JSON.stringify(stages).includes('private'),false);
});
test('diagnostic logger failure does not alter authentication',async()=>{assert.equal((await load().autoLogin({username:'a',password:'b',onStage:()=>{throw Error('logger');}})).ok,true);});
