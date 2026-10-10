'use strict';
const fs=require('node:fs');
const f='src/code.gs.txt',old=fs.readFileSync(f,'utf8');
const marker="'use strict';\n// Portable rules shared by Node, Apps Script and the gateway.";
const index=old.indexOf(marker);if(index<0)throw Error('Missing billing marker');
const core=fs.readFileSync('src/billing-core.js','utf8').replace('module.exports = { BillingCore, ...BillingCore() };','');
const gas=old.slice(0,index)+core+'\n'+fs.readFileSync('src/billing-gas.gs.txt','utf8');
fs.writeFileSync(f,gas);fs.writeFileSync('support-gateway/apps-script/Code.gs',gas);
fs.writeFileSync('src/index.js.txt',fs.readFileSync('cloudflare-worker/src/index.js','utf8'));
