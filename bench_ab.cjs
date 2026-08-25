// A/B benchmark: classic (unicorn_arm.cjs + stm32_periph_wasm.js, JS MMIO hooks)
// vs merged (uniconjs-merged in-wasm MMIO). Runs each firmware for a fixed
// instruction budget and reports MIPS.
const fs = require('fs');
const path = require('path');

// --- merged-wasm constants (Unicorn 2.2.0+ MAIN_MODULE build) ---
// Register enum was renumbered vs 2.1.4: PC=11, SP=12 (not 15/13).
const M_ARCH_ARM = 1, M_MODE_THUMB = 16, M_MODE_MCLASS = 32;
const M_PROT_READ = 1, M_PROT_WRITE = 2, M_PROT_EXEC = 4;
const M_HOOK_READ = 1024, M_HOOK_WRITE = 2048;
const M_REG_SP = 12, M_REG_PC = 11;

const FLASH = 0x08000000, FLASH_SZ = 0x00100000;
const SRAM = 0x20000000, SRAM_SZ = 0x00020000;
const PERIPH = 0x40000000, PERIPH_SZ = 0x10000000;
const SYS = 0xE0000000, SYS_SZ = 0x01000000;

const BATCH = 200000;
const TOTAL_BATCHES = 80; // 16M instructions per firmware

const FIRMWARES = [
  { name: 'blinky',    bin: 'blinky/blinky.bin' },
  { name: 'can_test',  bin: 'can_test/can_test.bin' },
  { name: 'eth_dhcp',  bin: 'eth_dhcp/eth_dhcp.bin' },
  { name: 'eth_http',  bin: 'eth_http/eth_http.bin' },
  { name: 'rtc_test',  bin: 'rtc_test/rtc_test.bin' },
];

const svdXml = fs.readFileSync(path.join(__dirname, 'monox/stm32f407.svd'), 'utf8');

function boot(uc, bin, getReg, setReg) {
  uc.mem_map(FLASH, FLASH_SZ, M_PROT_READ | M_PROT_WRITE | M_PROT_EXEC);
  uc.mem_write(FLASH, bin);
  uc.mem_map(SRAM, SRAM_SZ, M_PROT_READ | M_PROT_WRITE | M_PROT_EXEC);
  uc.mem_map(PERIPH, PERIPH_SZ, M_PROT_READ | M_PROT_WRITE | M_PROT_EXEC);
  uc.mem_map(SYS, SYS_SZ, M_PROT_READ | M_PROT_WRITE | M_PROT_EXEC);
  const rd32 = (a) => { const b = uc.mem_read(a, 4); return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0; };
  setReg(M_REG_SP, rd32(FLASH));
  setReg(M_REG_PC, rd32(FLASH + 4) | 1);
}

async function benchMerged(fw) {
  const MUnicorn = require('./uniconjs-merged/dist/unicorn_arm.js');
  const Module = await MUnicorn();
  const side = await Module.loadWebAssemblyModule(
    fs.readFileSync('./uniconjs-merged/dist/model_side.wasm'), { loadAsync: true });
  side.m_init();
  const uc = new Module.Unicorn(M_ARCH_ARM, M_MODE_THUMB | M_MODE_MCLASS);
  boot(uc, fw, null, (r, v) => uc.reg_write(r, new Uint32Array([v >>> 0])));
  uc.hook_add(M_HOOK_READ, Number(side.get_native_mmio_read()), null, PERIPH, PERIPH + PERIPH_SZ - 1);
  uc.hook_add(M_HOOK_WRITE, Number(side.get_native_mmio_write()), null, PERIPH, PERIPH + PERIPH_SZ - 1);
  uc.hook_add(M_HOOK_READ, Number(side.get_native_mmio_read()), null, SYS, SYS + SYS_SZ - 1);
  uc.hook_add(M_HOOK_WRITE, Number(side.get_native_mmio_write()), null, SYS, SYS + SYS_SZ - 1);
  const uartBuf = Module._malloc(8192);
  let pc = (() => { const b = uc.mem_read(FLASH + 4, 4); return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24) | 1) >>> 0; })();
  const t0 = Date.now();
  let done = 0, failAt = -1;
  for (let i = 0; i < TOTAL_BATCHES; i++) {
    try { uc.emu_start(pc, 0, 0, BATCH); done += BATCH; }
    catch (e) { failAt = i; console.error('  [merged] emu threw:', e && e.stack ? e.stack : String(e)); break; }
    pc = (uc.reg_read_i32(M_REG_PC) | 1) >>> 0;
    if (i % 10 === 0) side.m_get_uart_output(uartBuf, 8192);
  }
  const dt = (Date.now() - t0) / 1000;
  uc.close();
  return { mips: done / 1e6 / dt, done, dt, failAt };
}

async function benchClassic(fw) {
  const unicorn_arm = require('./stm32-periph-wasm/pkg/unicorn_arm.cjs');
  const bindings = require('./stm32-periph-wasm/pkg/stm32_periph_wasm.js');
  const Module = await unicorn_arm({});
  bindings.init_svd(svdXml);
  const uc = new Module.Unicorn(Module.ARCH_ARM, Module.MODE_MCLASS | Module.MODE_LITTLE_ENDIAN);
  uc.mem_map(FLASH, FLASH_SZ, Module.PROT_ALL);
  uc.mem_write(FLASH, fw);
  uc.mem_map(SRAM, SRAM_SZ, Module.PROT_ALL);
  uc.mem_map(PERIPH, PERIPH_SZ, Module.PROT_ALL);
  uc.mem_map(SYS, SYS_SZ, Module.PROT_ALL);
  const rd32 = (a) => { const b = uc.mem_read(BigInt(a), 4); return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0; };
  uc.reg_write_i32(Module.ARM_REG_SP, rd32(FLASH));
  uc.reg_write_i32(Module.ARM_REG_PC, rd32(FLASH + 4) | 1);

  const memReadHook = (h, type, address, size, value, ud) => {
    const addr32 = Number(address);
    const val = bindings.periph_read(addr32, size) >>> 0;
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) bytes[i] = (val >> (i * 8)) & 0xFF;
    uc.mem_write(address, bytes);
  };
  const memWriteHook = (h, type, address, size, value, ud) => {
    bindings.periph_write(Number(address), size, Number(value));
  };
  for (const [s, e] of [[PERIPH, PERIPH + PERIPH_SZ - 1], [SYS, SYS + SYS_SZ - 1]]) {
    uc.hook_add(Module.HOOK_MEM_READ, memReadHook, null, s, e);
    uc.hook_add(Module.HOOK_MEM_WRITE, memWriteHook, null, s, e);
  }
  let pc = (rd32(FLASH + 4) | 1) >>> 0;
  const t0 = Date.now();
  let done = 0, failAt = -1;
  for (let i = 0; i < TOTAL_BATCHES; i++) {
    try { uc.emu_start(BigInt(pc), 0n, 0n, BATCH); done += BATCH; }
    catch (e) { failAt = i; console.error('  [classic] emu threw:', e && e.stack ? String(e) : String(e)); break; }
    pc = (uc.reg_read_i32(Module.ARM_REG_PC) | 1) >>> 0;
    if (i % 10 === 0) bindings.get_uart_output();
  }
  const dt = (Date.now() - t0) / 1000;
  uc.close();
  return { mips: done / 1e6 / dt, done, dt, failAt };
}

(async () => {
  console.log(`\n${'firmware'.padEnd(12)}${'CLASSIC MIPS'.padStart(14)}${'MERGED MIPS'.padStart(14)}${'speedup'.padStart(10)}`);
  for (const f of FIRMWARES) {
    const bin = fs.readFileSync(f.bin);
    let c, m;
    try { c = await benchClassic(bin); } catch (e) { c = { mips: NaN, err: e.message }; console.error(`classic ${f.name} failed:`, e.message); }
    try { m = await benchMerged(bin); } catch (e) { m = { mips: NaN, err: e.message }; console.error(`merged ${f.name} failed:`, e.message); }
    const cm = (c && c.mips) || NaN, mm = (m && m.mips) || NaN;
    const sp = isNaN(cm) || isNaN(mm) || cm === 0 ? 'n/a' : (mm / cm).toFixed(2) + 'x';
    console.log(`${f.name.padEnd(12)}${cm.toFixed(2).padStart(14)}${mm.toFixed(2).padStart(14)}${sp.padStart(10)}  (c:${c?c.done:0}/${c?c.failAt:-1}, m:${m?m.done:0}/${m?m.failAt:-1})`);
  }
})();
