// Benchmark the merged wasm (MAIN Unicorn + SIDE model) instruction throughput.
const path = require('path');
const fs = require('fs');
const MUnicorn = require(path.join(__dirname, 'dist', 'unicorn_arm.js'));

const UC_ARCH_ARM = 1, UC_MODE_THUMB = 16, UC_MODE_MCLASS = 32;
const UC_PROT_READ = 1, UC_PROT_WRITE = 2, UC_PROT_EXEC = 4;
const HOOK_MEM_READ = 1024, HOOK_MEM_WRITE = 2048;
const UC_ARM_REG_SP = 13, UC_ARM_REG_PC = 15;

(async () => {
  const Module = await MUnicorn();
  const side = await Module.loadWebAssemblyModule(
    fs.readFileSync(path.join(__dirname, 'dist', 'model_side.wasm')), { loadAsync: true });
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
  const rb = (a) => { const b = uc.mem_read(a, 4); return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0; };
  uc.reg_write(UC_ARM_REG_SP, rb(FLASH));
  uc.reg_write(UC_ARM_REG_PC, rb(FLASH + 4) | 1);
  uc.hook_add(HOOK_MEM_READ, Number(side.get_native_mmio_read()), null, PERIPH, PERIPH + PERIPH_SZ - 1);
  uc.hook_add(HOOK_MEM_WRITE, Number(side.get_native_mmio_write()), null, PERIPH, PERIPH + PERIPH_SZ - 1);

  const TOTAL = 60000000;       // instructions to run
  const STEP = 2000000;
  const t0 = Date.now();
  let done = 0, pc = rb(FLASH + 4) | 1;
  try {
    while (done < TOTAL) { uc.emu_start(pc | 1, 0, 0, STEP); done += STEP; }
  } catch (e) { console.error('emu threw:', e.message); }
  const dt = (Date.now() - t0) / 1000;
  console.log(`ran ${done} instructions in ${dt.toFixed(2)}s = ${(done / 1e6 / dt).toFixed(2)} MIPS`);
})().catch(e => { console.error(e); process.exit(1); });
