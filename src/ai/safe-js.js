'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { newQuickJSWASMModuleFromVariant } = require('quickjs-emscripten-core');
const variant = require('@jitl/quickjs-wasmfile-release-sync').default;
let enginePromise;
function getQuickJS() {
  // pkg cannot resolve the variant's dynamic ESM import inside its snapshot.
  // Static CommonJS loader plus explicit WASM bytes works in Node and the EXE.
  if (!enginePromise) enginePromise = newQuickJSWASMModuleFromVariant({
    ...variant,
    importModuleLoader: async () => {
      const load = require('../../node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.cjs');
      return options => {
        const bytes = fs.readFileSync(path.join(__dirname, '../../node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm'));
        // Compile snapshot bytes without dynamic ESM loading or file fetch.
        return load({ ...options, wasmBinary: bytes, instantiateWasm(imports, ready) {
          const module = new WebAssembly.Module(bytes), instance = new WebAssembly.Instance(module, imports);
          ready(instance, module); return instance.exports;
        } });
      };
    },
  }).catch(error => { enginePromise = null; throw error; });
  return enginePromise;
}
async function executeSafeJs(code, input, signal) {
  if (typeof code !== 'string' || code.length > 12000) throw new Error('Mã phân tích quá dài.');
  const raw = JSON.stringify(input);
  if (Buffer.byteLength(raw) > 8 * 1024 * 1024) throw new Error('Dữ liệu JS vượt giới hạn 8 MB.');
  signal?.throwIfAborted();
  const engine = await getQuickJS(), runtime = engine.newRuntime();
  runtime.setMemoryLimit(32 * 1024 * 1024); runtime.setMaxStackSize(512 * 1024);
  const deadline = Date.now() + 1500;
  runtime.setInterruptHandler(() => Date.now() > deadline || !!signal?.aborted);
  const vm = runtime.newContext();
  try {
    // JSON creates fresh guest objects, never Node handles or host functions.
    const result = vm.evalCode(`'use strict';const input=JSON.parse(${JSON.stringify(raw)});
      const helpers=Object.freeze({number:x=>Number(x)||0,normalizeText:x=>String(x??'').normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').toLowerCase(),
      sum:(rows,key)=>rows.reduce((s,x)=>s+(Number(key?x[key]:x)||0),0),groupBy:(rows,key)=>rows.reduce((groups,x)=>{const k=String(x[key]);(groups[k]??=[]).push(x);return groups},Object.create(null))});
      JSON.stringify((()=>{${code}\n})());`, 'agent-data.js');
    if (result.error) { result.error.dispose(); throw new Error('JS phân tích lỗi hoặc vượt giới hạn thời gian/bộ nhớ.'); }
    let value; try { value = vm.dump(result.value); } finally { result.value.dispose(); }
    if (typeof value !== 'string' || Buffer.byteLength(value) > 8 * 1024 * 1024) throw new Error('Kết quả JS không hợp lệ hoặc vượt giới hạn.');
    return JSON.parse(value);
  } finally { vm.dispose(); runtime.dispose(); }
}
module.exports = { executeSafeJs };
