// Validate the merged wasm (MAIN_MODULE Unicorn + SIDE_MODULE model) with
// in-wasm native MMIO hooks. Proves the dynamic-linking approach fixes the
// static-merge "null function or function signature mismatch" crash.
const path = require('path');
const fs = require('fs');

const MODULE_DIR = __dirname;
const MUnicorn = require(path.join(MODULE_DIR, "dist", "unicorn_arm.js"));

function die(msg) { console.error('FAIL:', msg); process.exit(1); }

// Unicorn constants (not surfaced on Module in this MAIN_MODULE build).
const UC_ARCH_ARM = 1;
const UC_MODE_THUMB = 16;
const UC_MODE_MCLASS = 32;
const UC_PROT_READ = 1, UC_PROT_WRITE = 2, UC_PROT_EXEC = 4;
const HOOK_MEM_READ = 1024, HOOK_MEM_WRITE = 2048;
const UC_ARM_REG_SP = 13, UC_ARM_REG_PC = 15;

(async () => {
  const Module = await MUnicorn();
  const sideBytes = fs.readFileSync(path.join(MODULE_DIR, "dist", "model_side.wasm"));
  console.log('loading side module...');
  const side = await Module.loadWebAssemblyModule(sideBytes, { loadAsync: true });
  console.log('side module loaded; model exports present:',
    typeof side.m_init === 'function' && typeof side.get_native_mmio_read === 'function');

  side.m_init();

  const uc = new Module.Unicorn(UC_ARCH_ARM, UC_MODE_THUMB | UC_MODE_MCLASS);

  const FLASH = 0x08000000, FLASH_SZ = 0x00100000;
  const SRAM = 0x20000000, SRAM_SZ = 0x00020000;
  const PERIPH = 0x40000000, PERIPH_SZ = 0x10000000;

  uc.mem_map(FLASH, FLASH_SZ, UC_PROT_READ | UC_PROT_WRITE | UC_PROT_EXEC);
  uc.mem_map(SRAM, SRAM_SZ, UC_PROT_READ | UC_PROT_WRITE | UC_PROT_EXEC);
  uc.mem_map(PERIPH, PERIPH_SZ, UC_PROT_READ | UC_PROT_WRITE | UC_PROT_EXEC);

  const bin = fs.readFileSync(process.env.BLINKY_BIN || '/home/danish1075/Documents/stm32 F4/blinky/blinky.bin');
  uc.mem_write(FLASH, bin);

  // Reset vector: SP at 0x08000000, PC at 0x08000004 (Thumb bit set).
  const readU32 = (a) => { const b = uc.mem_read(a, 4); return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0; };
  const sp = readU32(FLASH);
  const pc = readU32(FLASH + 4);
  uc.reg_write(UC_ARM_REG_SP, sp);
  uc.reg_write(UC_ARM_REG_PC, pc | 1);
  console.log(`reset SP=0x${sp.toString(16)} PC=0x${pc.toString(16)}`);

  // Native in-wasm MMIO hooks (function pointers from the side module's table).
  const rHook = uc.hook_add(HOOK_MEM_READ, Number(side.get_native_mmio_read()), null, PERIPH, PERIPH + PERIPH_SZ - 1);
  const wHook = uc.hook_add(HOOK_MEM_WRITE, Number(side.get_native_mmio_write()), null, PERIPH, PERIPH + PERIPH_SZ - 1);
  console.log('hooks registered:', !!rHook, !!wHook);

  const UART_BUF = Module._malloc(8192);
  let out = '';
  const STEP = 2000000;
  const TOTAL = 40000000;
  let executed = 0;

  try {
    while (executed < TOTAL) {
      uc.emu_start(pc | 1, 0, 0, STEP);
      executed += STEP;
      const len = side.m_get_uart_output(UART_BUF, 8192);
      if (len > 0) {
        const chunk = Module.UTF8ToString ? Module.UTF8ToString(UART_BUF) : '';
        out += chunk;
        if (/tick\s+\d+/.test(out)) break;
      }
    }
  } catch (e) {
    die('emu_start threw (crash reproduced?): ' + e.message);
  }

  console.log('executed ~', executed, 'instructions');
  console.log('--- UART output ---');
  process.stdout.write(out);
  console.log('--- end ---');

  const ok = /blinky|tick\s+\d+/i.test(out);
  console.log(ok ? 'PASS: native in-wasm MMIO hooks ran without crashing; UART captured.' : 'WARN: no UART captured (but no crash).');
  process.exit(ok ? 0 : 2);
})().catch(e => die(e.stack || String(e)));
