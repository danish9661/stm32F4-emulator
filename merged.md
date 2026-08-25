# Merged-WASM vs Classic-WASM Benchmark — Investigation Report

**Date:** 2026-08-25
**Author:** opencode session
**Repo:** `/home/danish1075/Documents/stm32 F4/`
**Harness:** `bench_ab.cjs` (root of repo)

---

## 1. Objective

Two emulator backends exist for running STM32F407 firmware under Unicorn:

- **Classic path** — `unicorn_arm.cjs` (Unicorn 2.1.4, AlexAltea build) + `stm32_periph_wasm.js` / `stm32_periph_wasm_bg.wasm` (Rust model, wasm-bindgen). MMIO is serviced by **JS memory hooks** (`periph_read`/`periph_write`), which means every peripheral access crosses the wasm↔JS boundary.
- **Merged path** — `uniconjs-merged/dist/unicorn_arm.js` (Unicorn, **MAIN_MODULE**) + `uniconjs-merged/dist/model_side.wasm` (Rust model, **SIDE_MODULE**), linked together with Emscripten dynamic linking. MMIO is serviced by **in-wasm C hooks** that call the model directly with zero JS crossing.

Prior claims (AGENTS.md) asserted the merged path was **~2× faster** (~6 MIPS vs ~2–3 MIPS). This session built a fair A/B benchmark to verify that claim across multiple firmwares, and diagnosed why the merged path could not run firmware continuously.

---

## 2. What was built

`bench_ab.cjs` is a self-contained Node CJS harness that:

1. For each firmware, loads **both** backends and runs the same workload.
2. Maps FLASH (0x08000000), SRAM (0x20000000), PERIPH (0x40000000, 256 MB), SYS (0xE0000000, 16 MB).
3. Loads the `.bin` from the vector table (SP/PC at 0x08000000 / 0x08000004, Thumb bit set).
4. Registers MMIO hooks over the peripheral + system ranges.
5. Runs `TOTAL_BATCHES = 80` batches of `BATCH = 200000` instructions (= 16M instructions), resuming from the read-back PC between batches (**continuous execution**).
6. Measures wall time → MIPS = `instructions / wall_seconds / 1e6`.

### Classic hook (JS)
```js
const memReadHook = (h, type, address, size, value, ud) => {
  const v = bindings.periph_read(Number(address), size) >>> 0;
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (v >> (i*8)) & 0xFF;
  uc.mem_write(address, bytes);            // write modeled value back to guest
};
const memWriteHook = (h, type, address, size, value, ud) =>
  bindings.periph_write(Number(address), size, Number(value));
```

### Merged hook (in-wasm C, `src/native_hooks.c`)
```c
static void native_mmio_read_cb(uc_engine *uc, uc_mem_type type,
                                uint64_t address, int size, int64_t value, void *ud) {
    uint32_t v = m_periph_read((uint32_t)address, (uint32_t)size);
    uc_mem_write(uc, address, &v, (uint64_t)size);   // write modeled value back
}
static void native_mmio_write_cb(uc_engine *uc, uc_mem_type type,
                                 uint64_t address, int size, int64_t value, void *ud) {
    m_periph_write((uint32_t)address, (uint32_t)size, (uint32_t)value);
}
```
Registered via function pointers: `uc.hook_add(HOOK_MEM_READ, Number(side.get_native_mmio_read()), ...)`.

### Firmwares benchmarked
`blinky`, `can_test`, `eth_dhcp`, `eth_http`, `rtc_test`.

---

## 3. Bugs found and fixed during this session

### Bug A — `reg_write` requires a typed array (merged build)
The merged Unicorn JS glue's `uc.reg_write(reg, value)` **silently ignores a JS number** and writes garbage. Passing `new Uint32Array([val])` works.

```js
// wrong: uc.reg_write(15, 0x08000185)  -> writes 0x1d4 (garbage)
// right: uc.reg_write(15, new Uint32Array([0x08000185]))
```
Fixed in the harness setter: `uc.reg_write(r, new Uint32Array([v >>> 0]))`.

### Bug B — Register enum renumbered in Unicorn 2.2.0+ (the real continuous-execution defect)
The merged build is **Unicorn 2.2.0+**, whose ARM register enum was **renumbered** vs the 2.1.4 build the harness constants assumed:

```c
// unicorn/include/unicorn/arm.h (merged build)
typedef enum uc_arm_reg {
    UC_ARM_REG_INVALID = 0,   // reading this is a no-op ("deprecated" warning)
    UC_ARM_REG_APSR,
    UC_ARM_REG_APSR_NZCV,
    ...
    UC_ARM_REG_LR,    // 10
    UC_ARM_REG_PC,    // 11   <-- NOT 15
    UC_ARM_REG_SP,    // 12   <-- NOT 13
    UC_ARM_REG_SPSR,  // 13
    ...
}
```

The harness used `M_REG_PC = 15` / `M_REG_SP = 13` (old 2.1.4 values). So `reg_read_i32(15)` was reading **R1**, not PC. Proof: a controlled micro-program whose true final PC is `0x08000014` read back as `0x111` (the upper bits dropped — actually R1's value). After switching to `M_REG_PC = 11` / `M_REG_SP = 12`, the same micro-program read back the correct `0x08000014`.

This was the **actual root cause** of "merged cannot run continuously" — the resume PC was read from the wrong register and pointed into unmapped memory, so the next batch faulted with `UC_ERR_FETCH_UNMAPPED`.

> **Important correction:** the earlier hypothesis that the *in-wasm MMIO read write-back* (`uc_mem_write` inside the read hook) was corrupting guest execution was **false**. Verified by running the merged Unicorn with a **JS** read/write hook that called `side.m_periph_read` + `uc.mem_write` — it completed 5M instructions and only failed to report PC (because of Bug B). The MMIO read path itself was always correct.

### Bug C — `reg_read` returns an empty Uint8Array (merged build)
Minor: `uc.reg_read(15)` (generic byte buffer form) returns `Uint8Array(0)`. Use `reg_read_i32(15)` instead (works once Bug B is fixed).

---

## 4. Benchmark results

All runs: 80 batches × 200000 instructions = **16M instructions per firmware**, continuous execution (resume via read-back PC). No faults.

| firmware  | classic MIPS | merged MIPS | speedup |
|-----------|-------------:|------------:|--------:|
| blinky    | 13.69        | 8.47        | 0.62x  |
| can_test  | 15.07        | 15.44       | 1.03x  |
| eth_dhcp  | 15.01        | 15.01       | 1.00x  |
| eth_http  | 14.90        | 10.92       | 0.73x  |
| rtc_test  | 4.19         | 4.85        | 1.16x  |

(Range: **0.62x – 1.16x** — i.e. merged is at parity, sometimes *slower*.)

For reference, the earlier restart-from-reset-every-batch methodology produced the same parity range (0.61x – 1.25x); it was never a 2× speedup either.

---

## 5. Interpretation

- **The merged in-wasm MMIO path now runs firmware continuously** — the blocker (Bug B) is resolved.
- **No 2× speedup is observed.** The merged path is at parity with, or slightly slower than, the JS-hook classic path.
- **Why:** WASM Unicorn is a **TCI interpreter** (it cannot JIT in the browser), so the interpreter itself dominates cost; the per-access JS↔wasm crossing is a small fraction of total time. Furthermore, the in-wasm C hook calls the model through an **Emscripten dylink cross-module dynamic call**, which under V8 is apparently no cheaper — and on MMIO-heavy `eth_http` is ~27% *slower* — than the JS-hook path (V8 optimizes wasm↔JS well).
- The prior "2× / 6 MIPS" figure came from the restart-from-reset validation, which (a) never exercised continuous resume and (b) does not reproduce here even in that mode.

---

## 6. Conclusion & recommendations

1. **The merged-wasm "eliminate JS crossings" premise does not yield a measurable speedup under TCI with these builds.** It is a correctness-valid alternative path (now running continuously) but not a performance win for the WASM-only use case.
2. **The real performance lever is the native JIT addon** (NAPI: `unicorn_arm` native + Rust model via `extern "C"`), which earlier notes placed at **5–9× faster** than any WASM path because it runs Unicorn as a real JIT. That addon was lost in a prior workspace wipe and has not been rebuilt. **This is the path to pursue for actual speed.**
3. **AGENTS.md still asserts the merged build is ~2× faster** — that claim is now contradicted by `bench_ab.cjs` and should be corrected.

---

## 7. How to reproduce

```bash
cd /home/danish1075/Documents/stm32 F4
node bench_ab.cjs
# prints CLASSIC MIPS / MERGED MIPS / speedup per firmware
```

`bench_ab.cjs` is self-contained (no extra deps). It loads:
- classic: `./stm32-periph-wasm/pkg/unicorn_arm.cjs` + `./stm32-periph-wasm/pkg/stm32_periph_wasm.{js,wasm}` + `./monox/stm32f407.svd`
- merged:  `./uniconjs-merged/dist/unicorn_arm.js` + `./uniconjs-merged/dist/model_side.wasm`

To change the workload: edit `BATCH` / `TOTAL_BATCHES` or the `FIRMWARES` array (paths are relative to repo root).
