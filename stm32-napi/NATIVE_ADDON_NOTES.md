# Native NAPI Addon for STM32F407 Emulation

This directory contains a **native Node addon** (`stm32-napi`) that links the
**JIT Unicorn** engine (`unicorn-engine` Rust crate) with an **embedded wasm
peripheral model** (`stm32-periph-wasm` compiled to wasm, executed via
`wasmtime`). Goal: run the STM32F407 firmware faster than the WASM/TCI Unicorn
build used by `emulator.js` / `cli.mjs`.

---

## Architecture

- `src/lib.rs` is the napi crate. On `create_arm_engine()` it builds a Unicorn
  ARM/THUMB/MCLASS engine, `mem_map`s flash/sram/periph/system, and instantiates
  the peripheral model wasm via wasmtime (generic stub imports).
- **Memory hooks** (`hook_mem_read` / `hook_mem_write` over `0x40000000..0x70000000`)
  call `periph_read` / `periph_write` **directly in Rust** (no JS reentrancy),
  which invoke the wasm model through wasmtime.
- `get_uart_output()` returns the model's UART buffer (the wasm function returns
  a 2-value `(ptr, len)` pair — call it with a 2-slot result array).
- The JS harness (`eth_speed.cjs`, `blinky_speed.cjs`) drives setup, calls
  `emu_start`, drains UART, and services the ETH TX/RX poll handshake by poking
  the firmware's `ETH_IRQ_FLAG` (SRAM `0x20000620`) and injecting frames.

### ABI notes
- `eth_irq_flag` (firmware global) is at `0x20000620` — confirmed via `nm`.
  Do **not** rely on `EMAC` base; the handshake is SRAM-flag based.
- `tcp_src_port` (firmware file-scope global) is at `0x20000000`;
  `tcp_target_port` at `0x20000650`; `tcp_connected` at `0x20000658`.
- The model's `periph_read`/`periph_write` are normalized to host byte order
  by `emu_start` before dispatch (so the harness deals with native-endian
  values), and the model result is byte-swapped back for the guest.

---

## Build

```bash
cd ~/Documents/stm32\ F4/stm32-napi
source ~/.cargo/env
# LIBCLANG_PATH is required for the napi bindgen; do NOT set CMAKE_PREFIX_PATH=""
# (that breaks the unicorn C build — MAP_FIXED / PROT_READ undeclared).
LIBCLANG_PATH=/usr/lib64/libclang.so CARGO_TARGET_DIR=/home/danish1075/target cargo build
cp /home/danish1075/target/debug/libstm32_napi.so libstm32_napi.node
```

The peripheral model wasm (`stm32-periph-wasm/pkg/stm32_periph_wasm_bg.wasm`)
is embedded via `include_bytes!` in `src/lib.rs`, so rebuild it first if the
model changes:

```bash
cd ~/Documents/stm32\ F4/stm32-periph-wasm && wasm-pack build --release --target nodejs
```

---

## How to run (end-to-end eth_http)

```bash
cd ~/Documents/stm32\ F4/stm32-napi
node eth_speed.cjs            # DHCP + TCP connect + HTTP GET via canned netsim
```

Expected UART (repeats every round):

```
=== ETH HTTP GET Test ===
DHCP Discover
Wait DHCP Offer
DHCP Ack IP=192.168.004.002 OK
TCP SYN
TCP fl=12
TCP connected
HTTP GET...
Hello from openhw HTTP server!CONN
```

---

## CRITICAL BUG FOUND AND FIXED (2026-08-25)

### Symptom
`eth_http` completed DHCP but never finished the TCP handshake: no `TCP
connected`, no `TCP fl=`, no `TCP SYN-ACK timeout`. A byte-perfect SYN-ACK was
injected (verified by dumping the RX slot — `sport=0x1f9c dport=0xc79c flags=0x12
seq=0x10000000 ack=0x2711`, correct MACs/IPs), yet the firmware rejected it.

### Root cause — harness restart, not a model bug
The run loop called `emuStart((pc | 1) >>> 0, 0, 0, STEP)` with a **fixed
reset-vector `pc`** on every iteration. `emu_start`'s `begin` argument is the
START address, so passing the reset vector every time **restarted the firmware
from the reset vector each call**, throwing away all progress.

Consequence: within one 1M-inst window the firmware could reach `TCP SYN` and
the harness injected the SYN-ACK, but the *next* `emu_start` reset it back to
`setup()` — so the SYN-ACK was never processed. DHCP "completed" only because
setup+DHCP+SYN happen to fit inside a single window.

A red herring: pc appeared "stuck" at `0x8000aa0` (a `delay` loop in
`setup`). That was just the restart landing in `setup`'s delay each time —
NOT a JIT hang.

### Fix
Track the live PC and resume instead of restarting:

```js
let cur = (pc | 1) >>> 0;
while (totalInst < TOTAL) {
  addon.emuStart(cur, 0, 0, stp);
  cur = (addon.getPc() | 1) >>> 0;
  // ...
}
```

This mirrors the resume pattern already used by `emulator.js` /
`cli.mjs` (`uc.emu_start(curPc|1, 0, 0, STEP)`). After the fix the full
DHCP→TCP→HTTP flow runs end-to-end (8084 sessions in 100M instructions).

---

## Performance finding (important)

With the bug fixed, `eth_http` runs end-to-end, but the **native addon is
slower than the WASM build for I/O-heavy firmware**:

| metric | native addon | WASM build (`emulator.js`) |
|---|---|---|
| wall MIPS (eth_http) | **~4.1** | **~12** (true, after block-overcount correction) |
| emu-only MIPS (eth_http) | **~6.1** | — |
| wall MIPS (blinky, compute-bound) | **~22.7** | ~17 |

Breakdown of the 100M-inst eth_http run:
- emu-only time ≈ 16.3 s (≈ 6 MIPS)
- harness RX/TX event overhead ≈ 8 s (the JS↔Rust frame-injection path)

### Why the native addon is slower here
Every **MMIO access** (USART per-character DR write, ETH DMA, GPIO) routes
through `periph_read`/`periph_write`, which are **wasmtime calls** (~20 µs
each). `eth_http` issues ~1 MMIO access per ~124 instructions, so the wasmtime
host↔guest boundary dominates. Blinky is compute-bound (few MMIO) so it hits
22.7 MIPS — proving the JIT Unicorn itself is fast.

The WASM build's peripheral model is plain **JS**, whose per-call cost is far
below a wasmtime call, so for I/O-heavy firmware the WASM build wins despite
running the ARM core under TCI.

### Path to actually beat the WASM build
Replace the wasmtime-embedded model with a **native Rust peripheral model**
(call `periph_read`/`periph_write` as direct Rust functions, ~ns/call instead
of ~µs). This means porting `stm32-periph-wasm/src/` from `wasm-bindgen`
exports to plain `pub fn`s and linking it into this crate. Correctness is
already proven through the wasmtime path, so the port is mechanical — but it is
a non-trivial refactor of the model crate.

---

## Known limitations / gotchas

- **CODE hooks do not fire** in this JIT Unicorn build (verified: tracing a
  known-executing range `0x80008f0..0x8000920` produced zero `TRACE` lines).
  Also, `set_trace` / `get_counts` are *not* exported by napi-derive in the
  current build (the proc-macro registration drops them while keeping
  `emu_start`/`get_pc`/etc.). Diagnose execution via `getPc()` snapshots
  instead of code hooks.
- The `.node` binary is ~340 MB and must never be committed (see `.gitignore`).
- The harness's `net.onTx` / `injectRx` path does many JS↔Rust calls per
  connect; this is the dominant wall-time cost after emulation and is shared
  with the WASM build's harness.
- Checksums in the canned frames are left as `0x0000` (the firmware's
  `tcp_connect` does not verify them); TCP/IP checksums were confirmed not to
  be the rejection cause once the restart bug was fixed.
