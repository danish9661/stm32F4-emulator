//! C-API bridge between the Unicorn CPU emulator and the Rust STM32 peripheral model.
//!
//! Every `m_*` function is a `#[no_mangle] pub extern "C"` entry point that the
//! Unicorn wasm (or native node addon) links against. Functions taking Rust
//! slices/strings/Vecs convert from raw C pointers.

use std::ffi::CStr;
use std::os::raw::c_char;

use stm32_periph_wasm as model;

/// Borrow a `&str` from a C string pointer (empty if null / invalid UTF-8).
unsafe fn cstr<'a>(p: *const c_char) -> &'a str {
    if p.is_null() {
        ""
    } else {
        CStr::from_ptr(p).to_str().unwrap_or("")
    }
}

/// Borrow an `Option<&str>` from a C string pointer.
unsafe fn cstropt<'a>(p: *const c_char) -> Option<&'a str> {
    if p.is_null() {
        None
    } else {
        CStr::from_ptr(p).to_str().ok()
    }
}

/// Copy a `Vec<u32>` into a caller-provided buffer; returns items written.
unsafe fn write_u32_slice(v: &[u32], out: *mut u32, cap: u32) -> u32 {
    if out.is_null() {
        return 0;
    }
    let n = v.len().min(cap as usize);
    std::ptr::copy_nonoverlapping(v.as_ptr(), out, n);
    n as u32
}

/// Copy a `Vec<u8>` into a caller-provided buffer; returns bytes written.
unsafe fn write_u8_slice(v: &[u8], out: *mut u8, cap: u32) -> u32 {
    if out.is_null() {
        return 0;
    }
    let n = v.len().min(cap as usize);
    std::ptr::copy_nonoverlapping(v.as_ptr(), out, n);
    n as u32
}

/// Copy a `Vec<u16>` into a caller-provided buffer; returns items written.
unsafe fn write_u16_slice(v: &[u16], out: *mut u16, cap: u32) -> u32 {
    if out.is_null() {
        return 0;
    }
    let n = v.len().min(cap as usize);
    std::ptr::copy_nonoverlapping(v.as_ptr(), out, n);
    n as u32
}

#[no_mangle]
pub extern "C" fn m_init() {
    model::init();
}

#[no_mangle]
pub extern "C" fn m_init_svd(svd_xml: *const c_char) {
    let xml = unsafe { cstr(svd_xml) };
    model::init_svd(xml);
}

#[no_mangle]
pub extern "C" fn m_reset_state() {
    model::reset_state();
}

#[no_mangle]
pub extern "C" fn m_periph_read(addr: u32, width: u32) -> u32 {
    model::periph_read(addr, width)
}

#[no_mangle]
pub extern "C" fn m_periph_write(addr: u32, width: u32, value: u32) {
    model::periph_write(addr, width, value);
}

#[no_mangle]
pub extern "C" fn m_tick() {
    model::tick();
}

#[no_mangle]
pub extern "C" fn m_tick_n(delta: u32) {
    model::tick_n(delta);
}

#[no_mangle]
pub extern "C" fn m_has_pending_interrupt() -> bool {
    model::has_pending_interrupt()
}

#[no_mangle]
pub extern "C" fn m_get_next_pending_interrupt() -> i32 {
    model::get_next_pending_interrupt()
}

#[no_mangle]
pub extern "C" fn m_set_intr_pending(irq: i32) {
    model::set_intr_pending(irq);
}

#[no_mangle]
pub extern "C" fn m_pwr_wakeup() {
    model::pwr_wakeup();
}

#[no_mangle]
pub extern "C" fn m_is_watchdog_reset_requested() -> bool {
    model::is_watchdog_reset_requested()
}

#[no_mangle]
pub extern "C" fn m_iwdg_reset_flag() -> bool {
    model::iwdg_reset_flag()
}

#[no_mangle]
pub extern "C" fn m_wwdg_reset_flag() -> bool {
    model::wwdg_reset_flag()
}

#[no_mangle]
pub extern "C" fn m_clear_watchdog_reset_flags() {
    model::clear_watchdog_reset_flags();
}

#[no_mangle]
pub extern "C" fn m_can_inject(id: u32, dlc: u32, data: *const u8, len: u32) {
    let d = unsafe { std::slice::from_raw_parts(data, len as usize) };
    model::can_inject(id, dlc, d);
}

#[no_mangle]
pub extern "C" fn m_tim_inject_capture(name: *const c_char, ch: u32) {
    let n = unsafe { cstr(name) };
    model::tim_inject_capture(n.to_string(), ch);
}

#[no_mangle]
pub extern "C" fn m_dma_get_pending_count() -> u32 {
    model::dma_get_pending_count()
}

#[no_mangle]
pub extern "C" fn m_dma_get_pending(index: u32, out: *mut u32, cap: u32, out_len: *mut u32) {
    let v = model::dma_get_pending(index);
    unsafe {
        let n = write_u32_slice(&v, out, cap);
        if !out_len.is_null() {
            *out_len = n;
        }
    }
}

#[no_mangle]
pub extern "C" fn m_dma_set_completed(stream_idx: u32, success: bool) {
    model::dma_set_completed(stream_idx, success);
}

#[no_mangle]
pub extern "C" fn m_dma_periph_read(
    addr: u32,
    size: u32,
    pinc: bool,
    psize: u32,
    out: *mut u8,
    cap: u32,
    out_len: *mut u32,
) {
    let v = model::dma_periph_read(addr, size, pinc, psize);
    unsafe {
        let n = write_u8_slice(&v, out, cap);
        if !out_len.is_null() {
            *out_len = n;
        }
    }
}

#[no_mangle]
pub extern "C" fn m_dma_periph_write(addr: u32, data: *const u8, len: u32) {
    let d = unsafe { std::slice::from_raw_parts(data, len as usize) };
    model::dma_periph_write(addr, d.to_vec());
}

#[no_mangle]
pub extern "C" fn m_gpio_read_output(port: u32, pin: u32) -> bool {
    model::gpio_read_output(port, pin)
}

#[no_mangle]
pub extern "C" fn m_gpio_set_input(port: u32, pin: u32, value: bool) {
    model::gpio_set_input(port, pin, value);
}

#[no_mangle]
pub extern "C" fn m_gpio_read_input(port: u32, pin: u32) -> bool {
    model::gpio_read_input(port, pin)
}

#[no_mangle]
pub extern "C" fn m_adc_set_channel_value(peripheral: *const c_char, channel: u32, value: u32) {
    let p = unsafe { cstr(peripheral) };
    model::adc_set_channel_value(p, channel, value);
}

#[no_mangle]
pub extern "C" fn m_adc_clear_channel_value(peripheral: *const c_char, channel: u32) {
    let p = unsafe { cstr(peripheral) };
    model::adc_clear_channel_value(p, channel);
}

#[no_mangle]
pub extern "C" fn m_uart_rx_byte(addr: u32, byte: u8) -> bool {
    model::uart_rx_byte(addr, byte)
}

#[no_mangle]
pub extern "C" fn m_audio_load_wav(bytes: *const u8, len: u32) -> i32 {
    let b = unsafe { std::slice::from_raw_parts(bytes, len as usize) };
    match model::audio_load_wav(b.to_vec()) {
        Ok(()) => 0,
        Err(_) => -1,
    }
}

#[no_mangle]
pub extern "C" fn m_audio_take_capture(out: *mut u16, cap: u32, out_len: *mut u32) {
    let v = model::audio_take_capture();
    unsafe {
        let n = write_u16_slice(&v, out, cap);
        if !out_len.is_null() {
            *out_len = n;
        }
    }
}

#[no_mangle]
pub extern "C" fn m_audio_source_remaining() -> u32 {
    model::audio_source_remaining()
}

#[no_mangle]
pub extern "C" fn m_audio_clear() {
    model::audio_clear();
}

#[no_mangle]
pub extern "C" fn m_ltdc_get_scanline() -> u32 {
    model::ltdc_get_scanline()
}

#[no_mangle]
pub extern "C" fn m_ltdc_get_frame_count() -> u32 {
    model::ltdc_get_frame_count()
}

#[no_mangle]
pub extern "C" fn m_eth_is_tx_poll() -> bool {
    model::eth_is_tx_poll()
}

#[no_mangle]
pub extern "C" fn m_eth_get_tx_desc_addr() -> u32 {
    model::eth_get_tx_desc_addr()
}

#[no_mangle]
pub extern "C" fn m_eth_clear_tx_poll() {
    model::eth_clear_tx_poll();
}

#[no_mangle]
pub extern "C" fn m_eth_is_rx_poll() -> bool {
    model::eth_is_rx_poll()
}

#[no_mangle]
pub extern "C" fn m_eth_get_rx_desc_addr() -> u32 {
    model::eth_get_rx_desc_addr()
}

#[no_mangle]
pub extern "C" fn m_eth_clear_rx_poll() {
    model::eth_clear_rx_poll();
}

#[no_mangle]
pub extern "C" fn m_eth_tx_done() {
    model::eth_tx_done();
}

#[no_mangle]
pub extern "C" fn m_eth_rx_done() {
    model::eth_rx_done();
}

#[no_mangle]
pub extern "C" fn m_eth_signal_rx_poll(desc_addr: u32) {
    model::eth_signal_rx_poll(desc_addr);
}

#[no_mangle]
pub extern "C" fn m_eth_signal_tx_poll(desc_addr: u32) {
    model::eth_signal_tx_poll(desc_addr);
}

#[no_mangle]
pub extern "C" fn m_flash_is_programming() -> bool {
    model::flash_is_programming()
}

#[no_mangle]
pub extern "C" fn m_flash_take_erase(out: *mut u32, cap: u32, out_len: *mut u32) {
    let v = model::flash_take_erase();
    unsafe {
        let n = write_u32_slice(&v, out, cap);
        if !out_len.is_null() {
            *out_len = n;
        }
    }
}

#[no_mangle]
pub extern "C" fn m_flash_erase_applied() {
    model::flash_erase_applied();
}

/// Write the UART output string into `out` (nul-terminated); returns length
/// excluding the terminator. Returns required capacity (including nul) if
/// `out` is null or too small.
#[no_mangle]
pub extern "C" fn m_get_uart_output(out: *mut c_char, cap: u32) -> u32 {
    let s = model::get_uart_output();
    let bytes = s.as_bytes();
    if out.is_null() || cap == 0 {
        return (bytes.len() + 1) as u32;
    }
    let n = bytes.len().min(cap as usize - 1);
    unsafe {
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), out as *mut u8, n);
        *out.add(n) = 0;
    }
    n as u32
}

#[no_mangle]
pub extern "C" fn m_add_spi_flash(
    peripheral: *const c_char,
    jedec_id: u32,
    data: *const u8,
    len: u32,
    cs: *const c_char,
) {
    let p = unsafe { cstr(peripheral) };
    let d = unsafe { std::slice::from_raw_parts(data, len as usize) };
    let cs = unsafe { cstropt(cs) }.map(|s| s.to_string());
    model::add_spi_flash(p, jedec_id, d, cs);
}

#[no_mangle]
pub extern "C" fn m_spi_flash_debug(peripheral: *const c_char, out: *mut u32, cap: u32, out_len: *mut u32) {
    let p = unsafe { cstr(peripheral) };
    let v = model::spi_flash_debug(p);
    unsafe {
        let n = write_u32_slice(&v, out, cap);
        if !out_len.is_null() {
            *out_len = n;
        }
    }
}

#[no_mangle]
pub extern "C" fn m_add_i2c_eeprom(peripheral: *const c_char, address: u8, data: *const u8, len: u32) {
    let p = unsafe { cstr(peripheral) };
    let d = unsafe { std::slice::from_raw_parts(data, len as usize) };
    model::add_i2c_eeprom(p, address, d);
}

#[no_mangle]
pub extern "C" fn m_add_software_spi(
    name: *const c_char,
    cs: *const c_char,
    clk: *const c_char,
    miso: *const c_char,
    mosi: *const c_char,
) {
    let n = unsafe { cstr(name) };
    let cs = unsafe { cstropt(cs) }.map(|s| s.to_string());
    let clk = unsafe { cstr(clk) };
    let miso = unsafe { cstr(miso) };
    let mosi = unsafe { cstr(mosi) };
    model::add_software_spi(n, cs, clk, miso, mosi);
}

#[no_mangle]
pub extern "C" fn m_spi_tap(peripheral: *const c_char, cs: *const c_char, dc: *const c_char) {
    let p = unsafe { cstr(peripheral) };
    let cs = unsafe { cstropt(cs) }.map(|s| s.to_string());
    let dc = unsafe { cstropt(dc) }.map(|s| s.to_string());
    model::spi_tap(p, cs, dc);
}

#[no_mangle]
pub extern "C" fn m_spi_take_events(peripheral: *const c_char, out: *mut u32, cap: u32, out_len: *mut u32) {
    let p = unsafe { cstr(peripheral) };
    let v = model::spi_take_events(p);
    unsafe {
        let n = write_u32_slice(&v, out, cap);
        if !out_len.is_null() {
            *out_len = n;
        }
    }
}

#[no_mangle]
pub extern "C" fn m_spi_push_miso(peripheral: *const c_char, bytes: *const u8, len: u32) {
    let p = unsafe { cstr(peripheral) };
    let b = unsafe { std::slice::from_raw_parts(bytes, len as usize) };
    model::spi_push_miso(p, b);
}

#[no_mangle]
pub extern "C" fn m_i2c_register_slave(peripheral: *const c_char, address: u8) {
    let p = unsafe { cstr(peripheral) };
    model::i2c_register_slave(p, address);
}

#[no_mangle]
pub extern "C" fn m_i2c_take_events(peripheral: *const c_char, out: *mut u32, cap: u32, out_len: *mut u32) {
    let p = unsafe { cstr(peripheral) };
    let v = model::i2c_take_events(p);
    unsafe {
        let n = write_u32_slice(&v, out, cap);
        if !out_len.is_null() {
            *out_len = n;
        }
    }
}

#[no_mangle]
pub extern "C" fn m_i2c_push_rx(peripheral: *const c_char, bytes: *const u8, len: u32) {
    let p = unsafe { cstr(peripheral) };
    let b = unsafe { std::slice::from_raw_parts(bytes, len as usize) };
    model::i2c_push_rx(p, b);
}

#[no_mangle]
pub extern "C" fn m_i2c_register_regfile(
    peripheral: *const c_char,
    address: u8,
    size: u32,
    init: *const u8,
    init_len: u32,
) {
    let p = unsafe { cstr(peripheral) };
    let i = unsafe { std::slice::from_raw_parts(init, init_len as usize) };
    model::i2c_register_regfile(p, address, size as usize, i);
}

#[no_mangle]
pub extern "C" fn m_i2c_regfile_get(peripheral: *const c_char, offset: u32) -> u8 {
    let p = unsafe { cstr(peripheral) };
    model::i2c_regfile_get(p, offset as usize)
}

#[no_mangle]
pub extern "C" fn m_i2c_regfile_set(peripheral: *const c_char, offset: u32, value: u8) {
    let p = unsafe { cstr(peripheral) };
    model::i2c_regfile_set(p, offset as usize, value);
}

#[no_mangle]
pub extern "C" fn m_fsmc_tap(bank: u32) {
    model::fsmc_tap(bank);
}

#[no_mangle]
pub extern "C" fn m_fsmc_take_events(bank: u32, out: *mut u32, cap: u32, out_len: *mut u32) {
    let v = model::fsmc_take_events(bank);
    unsafe {
        let n = write_u32_slice(&v, out, cap);
        if !out_len.is_null() {
            *out_len = n;
        }
    }
}

#[no_mangle]
pub extern "C" fn m_fsmc_push_data(bank: u32, values: *const u32, len: u32) {
    let v = unsafe { std::slice::from_raw_parts(values, len as usize) };
    model::fsmc_push_data(bank, v);
}

#[no_mangle]
pub extern "C" fn m_dcmi_feed_frame(w: u32, h: u32, pixels: *const u8, len: u32) {
    let p = unsafe { std::slice::from_raw_parts(pixels, len as usize) };
    model::dcmi_feed_frame(w, h, p);
}

#[no_mangle]
pub extern "C" fn m_dcmi_clear() {
    model::dcmi_clear();
}
