// Benchmark BOTH backends through the SAME driver (site/emulator.js):
//   - native: napi addon (JIT Unicorn + Rust model, native MMIO)
//   - wasm:   unicorn_arm.cjs + stm32_periph_wasm.js (WASM Unicorn, JS MMIO trap)
// Usage:
//   node site/bench_both.mjs native
//   node site/bench_both.mjs wasm
// Reports MIPS (instructions / wall-second / 1e6) per firmware.
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { createEmulator } from './emulator.js';

const require = createRequire(import.meta.url);
const backend = process.argv[2] || 'native';

let unicorn, bindings, wasmInit;
if (backend === 'native') {
  const loader = require('/tmp/opencode/stm32_native/native_loader.cjs');
  unicorn = () => loader.Module;
  bindings = loader.bindings;
  wasmInit = null;
  console.log('backend: NATIVE (napi addon, JIT Unicorn + native MMIO)');
} else {
  bindings = await import('./vendor/stm32_periph_wasm.js');
  unicorn = require('./vendor/unicorn_arm.cjs');
  wasmInit = new Uint8Array(readFileSync(new URL('./vendor/stm32_periph_wasm_bg.wasm', import.meta.url)));
  console.log('backend: WASM (unicorn_arm.cjs + stm32_periph_wasm.js)');
}

const svdXml = readFileSync(new URL('./vendor/stm32f407.svd', import.meta.url), 'utf8');

const RUN_WALL_MS = 4000;
const FW = [
  { name: 'blinky',    bin: '../blinky/blinky.bin',            opts: {} },
  { name: 'eth_http',  bin: '../eth_http/eth_http.bin',        opts: {} },
  { name: 'oled_test', bin: '../oled_test/oled_test.bin',      opts: { ext_devices: { oled: { i2c: 'I2C1', addr: 0x3C } } } },
];

async function benchOne(name, binPath, opts) {
  const firmware = new Uint8Array(readFileSync(new URL(binPath, import.meta.url)));
  const emu = await createEmulator({ firmware, bindings, unicorn, svdXml, wasmInit, ...opts });
  let last = 0, totalInst = 0;
  const start = Date.now();
  const nativeCounter = (typeof emu.uc.inst_count === 'function');
  while (Date.now() - start < RUN_WALL_MS) {
    const r = emu.step(500000);
    // Native tracks the counter in Rust (no JS re-entrancy): read via uc.
    // WASM backend: emulator.js exposes it on the step() return value.
    const cur = nativeCounter ? Number(emu.uc.inst_count()) : (r?.instCount ?? 0);
    totalInst += Math.max(0, cur - last);
    last = cur;
    emu.drainUart();
  }
  const secs = (Date.now() - start) / 1000;
  const mips = totalInst / secs / 1e6;
  emu.close();
  return { mips, totalInst, secs };
}

console.log(`\n${'firmware'.padEnd(12)} ${'MIPS'.padStart(10)} ${'instr'.padStart(14)} ${'wall_s'.padStart(8)}`);
for (const f of FW) {
  try {
    const r = await benchOne(f.name, f.bin, f.opts);
    console.log(`${f.name.padEnd(12)} ${r.mips.toFixed(2).padStart(10)} ${r.totalInst.toFixed(0).padStart(14)} ${r.secs.toFixed(1).padStart(8)}`);
  } catch (e) {
    console.log(`${f.name.padEnd(12)} ${'ERROR: ' + e.message}`);
    if (process.env.BSTACK) console.log(e.stack);
  }
}
