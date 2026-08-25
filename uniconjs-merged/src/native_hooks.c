// In-wasm native hooks: Unicorn calls these C callbacks directly (no JS
// crossing) and they delegate to the Rust peripheral model, which is loaded as
// a separate Emscripten SIDE_MODULE at runtime.
//
// Compiled into the Unicorn MAIN_MODULE. The `m_*` symbols are resolved from
// the model side module when it is loaded via Module.loadWebAssemblyModule.

#include <stdint.h>
#include <stdbool.h>
#include "unicorn/unicorn.h"

// Model C-API (resolved from the side module at load time).
extern uint32_t m_periph_read(uint32_t addr, uint32_t width);
extern void     m_periph_write(uint32_t addr, uint32_t width, uint32_t value);
extern void     m_tick_n(uint32_t delta);
extern bool     m_has_pending_interrupt(void);
extern int32_t  m_get_next_pending_interrupt(void);
extern void     m_set_intr_pending(int32_t irq);

// MMIO read hook: answer from the peripheral model, then write the modeled
// value back into guest memory so the guest sees it.
static void native_mmio_read_cb(uc_engine *uc, uc_mem_type type,
                                uint64_t address, int size, int64_t value,
                                void *user_data) {
    uint32_t v = m_periph_read((uint32_t)address, (uint32_t)size);
    uc_mem_write(uc, address, &v, (uint64_t)size);
}

// MMIO write hook: forward to the peripheral model.
static void native_mmio_write_cb(uc_engine *uc, uc_mem_type type,
                                 uint64_t address, int size, int64_t value,
                                 void *user_data) {
    m_periph_write((uint32_t)address, (uint32_t)size, (uint32_t)value);
}

// Code hook: advance the model's virtual time and stop the block when an
// interrupt is pending so the driver can service it.
static void native_code_hook_cb(uc_engine *uc, uint64_t address,
                                uint32_t size, void *user_data) {
    m_tick_n((uint32_t)(size / 2));  // Thumb-2: 2 bytes per halfword
    if (m_has_pending_interrupt()) {
        uc_emu_stop(uc);
    }
}

// Getters returning the callback pointers (consumed by unicorn-wrapper.js).
uintptr_t get_native_mmio_read(void) {
    return (uintptr_t)&native_mmio_read_cb;
}
uintptr_t get_native_mmio_write(void) {
    return (uintptr_t)&native_mmio_write_cb;
}
uintptr_t get_native_code_hook(void) {
    return (uintptr_t)&native_code_hook_cb;
}
