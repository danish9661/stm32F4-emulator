# Merged WASM — Unicorn (MAIN_MODULE) + Rust model (SIDE_MODULE)

This branch builds an STM32F407 emulator where the Unicorn CPU core and the
Rust peripheral model run **in a single wasm instance with zero JS crossing**
during MMIO. MMIO reads/writes call the Rust model directly inside wasm via
Emscripten dynamic linking (MAIN_MODULE + SIDE_MODULE), instead of bouncing
through a JS hook on every access.

## Layout

- `unicorn/` — patched Unicorn 2.1.4 with TCI + a prebuilt `libunicorn.a`
  (compiled with `-fwasm-exceptions` so its `setjmp/longjmp` resolves under
  WASM exceptions).
- `src/native_hooks.c` — native MMIO/code callbacks, compiled into the main
  module. They call the model's `m_*` functions in-module and import
  `uc_mem_write` / `uc_emu_stop` from Unicorn.
- `src/dummy_exceptions.cpp` — forces the `__cpp_exception` EH tag path.
- `src/dylink_exports.js` — exposes `Module.loadWebAssemblyModule`.
- `stm32-periph-wasm/` — vendored peripheral model crate (feature-gated so it
  builds for `wasm32-unknown-emscripten` without `wasm-bindgen`).
- `stm32_model_capi/` — vendored C-API crate that wraps the model with `m_*`
  symbols; built to `libstm32_model_capi.a`.
- `dist/unicorn_arm.js`, `dist/model_side.wasm` — **prebuilt artifacts**
  (force-added) so the emulator runs without rebuilding.

## Build (from scratch)

Requires: emsdk (emcc on PATH) and the rust `wasm32-unknown-emscripten` target.

```bash
source ~/emsdk/emsdk_env.sh
DYLINK=1 python3 build.py arm
```

`build.py` will:
1. Build Unicorn as a `MAIN_MODULE` (`dist/unicorn_arm.js`) with
   `-fwasm-exceptions -s SUPPORT_LONGJMP=1`.
2. Build the `stm32_model_capi` crate for `wasm32-unknown-emscripten`
   (unless `MODEL_LIB_OVERRIDE=...` is set) → `libstm32_model_capi.a`.
3. Build the Rust model + native hooks as a `SIDE_MODULE`
   (`dist/model_side.wasm`).

> Note: this emsdk's bundled binaryen rejects `--enable-bulk-memory-opt`
> during the side-module wasm-opt post-pass (a binaryen/emscripten version
> mismatch). The pre-optimized `.wasm` is already correct, so the build
> tolerates that specific failure.

To supply a prebuilt model staticlib instead of building it:

```bash
MODEL_LIB_OVERRIDE=/path/to/libstm32_model_capi.a DYLINK=1 python3 build.py arm
```

## Run

```bash
BLINKY_BIN=/path/to/blinky.bin node test_merged_mmio.cjs
```

Expected output ends with:

```
=== Blinky ===
LED: GPIOA PA5
UART: 115200 8N1
No ethernet required
tick 0 LED=ON
PASS: native in-wasm MMIO hooks ran without crashing; UART captured.
```

## Benchmark

```bash
node bench_merged.cjs
```

Measures instruction throughput (TCI interpreter; ~6 MIPS on blinky).

## How it works (vs. the old single-module merge)

Statically linking two emscripten-built staticlibs into one module corrupts
the function table (null-function / signature-mismatch crashes). Instead, the
Rust model is a **side module** loaded at runtime via
`Module.loadWebAssemblyModule`. The main module imports the model's symbols
into its table; `native_hooks.c` (compiled into the main module) calls the
model's `m_*` functions directly, and the model imports `uc_mem_write` /
`uc_emu_stop` back from the main module. Result: one instance, shared memory,
in-wasm MMIO — no per-access JS crossing.
