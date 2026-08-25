# Native backend (napi addon) — JIT Unicorn + Rust model in one module

This document describes the **native Node.js addon** (`stm32_native.node`) that
replaces the two-WASM-module setup (`unicorn_arm.cjs` + `stm32_periph_wasm.js`)
with a single native module linking a **JIT-compiled Unicorn** and the **Rust
peripheral model** directly into one `.node` file. The goal is to remove the
~4× MMIO slowdown the browser/WASM path has, and to get native JIT speed on
Node.

> **Browser is unchanged.** This addon is Node-only. A `.node` file cannot load
> in a browser, so the Web demo and `site/vendor/` (WASM Unicorn + WASM model)
> keep working exactly as before. Use the native addon when you run the emulator
> from Node (`site/*.mjs` tests, `cli.mjs`, benchmarks) and want maximum
> throughput.

---

## Why this exists

The WASM path has three costs the native addon removes:

1. **TCI Unicorn** (the WASM build) vs **JIT Unicorn** (the native static lib
   `libunicorn.a`). JIT is dramatically faster for the tight Thumb-2 loops
   firmware runs in.
2. **MMIO traps cross into JS**. On every peripheral register read/write the
   WASM Unicorn calls a JS hook (`memReadHook`/`memWriteHook`) which calls back
   into the WASM model (`periph_read`/`periph_write`). That JS↔WASM crossing
   per access is the bulk of the MMIO overhead.
3. **The CODE/BLOCK hook** (driver logic: `tick_n`, TX/DMA polls, watchdog)
   also crosses into JS in the WASM path.

In the native addon:

- MMIO is handled **entirely in Rust** (`native_mmio_read`/`native_mmio_write`
  call `periph_read`/`periph_write` directly, then `uc_mem_write` the value
  back). No JS trap per access.
- The CODE/BLOCK hook runs **entirely in Rust** too — it advances the model
  clock via `tick_n` and stops `uc_emu_start` when the guest pends TX/DMA work.
  It does **not** re-enter the JS engine (which would crash napi — see
  *Limitations*).

Measured (see `site/bench_both.mjs`):

| firmware | native MIPS | wasm MIPS | speedup |
|---|---:|---:|---:|
| blinky    | 45.5 | 9.56  | 4.8× |
| eth_http  | 123  | 14.17 | 8.7× |
| oled_test | 48.8 | 9.84  | 4.9× |

(eth_http without a gateway is a pure compute spin; with a gateway the MMIO
phase shows the same ~5× native win.)

---

## Build

The addon lives in `/tmp/opencode/stm32_native/` (a space-free symlink is used
because the project directory contains a space — see *Path note*). It depends
on:

- `libunicorn.a` — a native Unicorn static library built from source
  (`/tmp/opencode/unicorn_build/libunicorn.a`). Built with
  `cmake -DBUILD_SHARED_LIB=OFF -DUNICORN_ARCH="ARM" -DUNICORN_USE_TCG=JIT`
  and `make`, then `ar rcs` into a single archive.
- `stm32-periph-wasm` — the Rust peripheral model crate, compiled **natively**
  (`crate-type = ["cdylib", "rlib"]`) as a path dependency. The `rlib` lets the
  addon call the model's Rust functions directly (e.g. `periph_read`,
  `tick_n`, `eth_is_tx_poll`).

```bash
cd /tmp/opencode/stm32_native
cargo build --release
cp target/release/libstm32_native.so stm32_native.node
```

`build.rs` links `libunicorn.a` with `--whole-archive` (Unicorn registers its
TCG backends statically, so all object files must be kept) plus `-lpthread
-ldl -lm`.

### Path note

The repository is at `/home/danish1075/Documents/stm32 F4/` (space in the path).
`cargo` and the model crate are symlinked into a space-free tree at
`/tmp/opencode/` so the build works:

- `/tmp/opencode/stm32_periph_wasm` → `.../stm32 F4/stm32-periph-wasm`
- `/tmp/opencode/stm32_native/Cargo.toml` depends on
  `stm32-periph-wasm = { path = "../stm32_periph_wasm" }`

The native Unicorn `libunicorn.a` is independent of the repo (it's a stock
Unicorn 2.x ARM build) and lives at `/tmp/opencode/unicorn_build/`.

---

## Usage

### As a drop-in for `emulator.js` (recommended)

`native_loader.cjs` presents the **same shape** as the WASM `unicorn_arm.cjs`
+ `stm32_periph_wasm.js` pair, so `site/emulator.js` runs unchanged:

```js
import { createEmulator } from './emulator.js';
const { Module, bindings } = require('/tmp/opencode/stm32_native/native_loader.cjs');
const unicorn = () => Module;            // emulator.js calls unicorn() as a factory
const wasmInit = null;                   // native has no wasm init step
const emu = await createEmulator({ firmware, bindings, unicorn, svdXml, wasmInit, ...opts });
```

The loader maps:

- `Module` → `{ Unicorn: NativeUnicorn, ARCH_ARM, MODE_THUMB, MODE_MCLASS,
  HOOK_*, ARM_REG_*, PROT_* }` — the Unicorn constant/class surface.
- `bindings` → all model functions, **snake_case** (as `emulator.js` expects)
  mapped onto the addon's camelCase napi exports (`periph_read` → `periphRead`,
  `init_svd` → `initSvd`, `i2c_register_slave` → `i2CRegisterSlave`, …).
- For **MMIO hooks**, the loader passes a no-op JS callback to `hook_add`
  because the native handler does the model call + write-back itself. Passing
  the real `memReadHook`/`memWriteHook` would re-apply `periph_read`/`write`
  and double-apply (some status-register reads clear on read).
- For **CODE/BLOCK hooks**, the driver's JS callback is still passed but the
  addon ignores it — the Rust hook does the tick/poll/stop work natively.

### Direct (low-level) API

The addon class is `Unicorn` (camelCase methods, f64 addresses):

```js
const addon = require('./stm32_native.node');
const uc = new addon.Unicorn(1 /*ARM*/, 1 << 4 /*THUMB*/);
uc.memMap(0x08000000, 0x100000, 7);
uc.hookAdd(1 << 10 /*MEM_READ*/, () => {}, null, 0x40000000, 0x40007fff);
uc.regWriteI(15, 0x08000185 | 1);
uc.emuStart(0x08000185 | 1, 0, 0, 1000000);
```

Model functions are top-level exports: `periphRead`, `periphWrite`,
`initSvd`, `tickN`, `getUartOutput`, `ethIsTxPoll`, `dmaPeriphRead`,
`i2CRegisterSlave`, `canInject`, … (the same set `site/emulator.js` uses, just
camelCased).

---

## Benchmark

`site/bench_both.mjs` runs the **same** `emulator.js` driver against either
backend so the comparison is apples-to-apples:

```bash
node site/bench_both.mjs native   # uses native_loader.cjs
node site/bench_both.mjs wasm     # uses site/vendor WASM modules
```

It boots `blinky`, `eth_http`, `oled_test` for ~4 s each and reports MIPS
(instructions / wall-second / 1e6). The native counter is read from the addon
(`emu.uc.inst_count()`, tracked in Rust); the WASM counter comes from
`emulator.js`'s `step()` return value.

---

## Limitations / known differences vs WASM

1. **CODE/BLOCK hook does not re-enter JS.** Calling back into the Node engine
   from inside a synchronous `uc_emu_start` (a C call invoked from JS) crashes
   napi with a segfault. Therefore the hook's logic is replicated in Rust in
   `native_code_hook` (`tick_n` every ~5000 instructions; stop on
   `eth_is_tx_poll()` or `dma_get_pending_count() > 0`; stop + reboot on
   `is_watchdog_reset_requested()`). The driver's JS `codeHook` is not invoked
   in the native path.
2. **RX injection granularity.** The WASM `codeHook` stops when
   `rxQueue.length > 0 && eth_is_rx_poll()`. The native Rust hook does **not**
   stop on RX (it cannot see the JS `rxQueue`). Instead, RX is serviced at
   every `step()` batch boundary (the driver's `processEth` runs after each
   `step()` returns). For firmware driven with a gateway this is slightly less
   granular but still correct. (No gateway → identical behaviour to WASM.)
3. **Node-only.** No browser support; `site/vendor/` WASM remains the browser
   backend.
4. The native addon is **not** committed to the repo (it is a build artifact
   produced from `libunicorn.a` + the model crate); rebuild it per the *Build*
   steps.
