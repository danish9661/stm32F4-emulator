use napi::bindgen_prelude::*;
use napi::Status;
use napi_derive::napi;
use unicorn_engine::*;
use std::cell::RefCell;
use std::sync::atomic::{AtomicU64, Ordering};
use wasmtime::*;
use wasmtime::V128;

static READ_COUNT: AtomicU64 = AtomicU64::new(0);
static WRITE_COUNT: AtomicU64 = AtomicU64::new(0);
static TRACE_BEGIN: AtomicU64 = AtomicU64::new(0);
static TRACE_END: AtomicU64 = AtomicU64::new(0);

thread_local! {
    static ENGINE: RefCell<Option<Unicorn<()>>> = const { RefCell::new(None) };
    static MODEL: RefCell<Option<Model>> = const { RefCell::new(None) };
}

const MODEL_WASM: &[u8] =
    include_bytes!("/home/danish1075/Documents/stm32 F4/stm32-periph-wasm/pkg/stm32_periph_wasm_bg.wasm");

struct Model {
    store: Store<()>,
    instance: Instance,
    periph_read: Func,
    periph_write: Func,
    get_uart: Func,
    memory: Memory,
    scratch: i32,
}

fn err(msg: &str) -> napi::Error<Status> {
    napi::Error::new(Status::GenericFailure, msg.to_string())
}

fn engine_err<E: std::fmt::Debug>(e: E) -> napi::Error<Status> {
    err(&format!("{:?}", e))
}

fn default_val(ty: ValType) -> Val {
    match ty {
        ValType::I32 => Val::I32(0),
        ValType::I64 => Val::I64(0),
        ValType::F32 => Val::F32(0u32),
        ValType::F64 => Val::F64(0u64),
        ValType::V128 => Val::V128(V128::from(0u128)),
        ValType::Ref(_) => Val::ExternRef(None),
    }
}

fn model_read(addr: u32, width: u32) -> u32 {
    MODEL.with(|m| {
        let mut g = m.borrow_mut();
        let model = g.as_mut().expect("model not initialized");
        let mut results = [Val::I32(0)];
        let _ = model.periph_read.call(
            &mut model.store,
            &[Val::I32(addr as i32), Val::I32(width as i32)],
            &mut results,
        );
        results[0].i32().unwrap_or(0) as u32
    })
}

fn model_write(addr: u32, width: u32, value: u32) {
    MODEL.with(|m| {
        let mut g = m.borrow_mut();
        let model = g.as_mut().expect("model not initialized");
        let _ = model.periph_write.call(
            &mut model.store,
            &[
                Val::I32(addr as i32),
                Val::I32(width as i32),
                Val::I32(value as i32),
            ],
            &mut [],
        );
    })
}

fn model_get_uart() -> String {
    MODEL.with(|m| {
        let mut g = m.borrow_mut();
        let model = g.as_mut().expect("model not initialized");
        let mut results = [Val::I32(0), Val::I32(0)];
        let _ = model
            .get_uart
            .call(&mut model.store, &[], &mut results);
        let out_ptr = results[0].i32().unwrap_or(0) as usize;
        let out_len = results[1].i32().unwrap_or(0) as usize;
        if out_ptr == 0 || out_len == 0 {
            return String::new();
        }
        let mut sbuf = vec![0u8; out_len];
        if model.memory.read(&model.store, out_ptr, &mut sbuf).is_err() {
            return String::new();
        }
        if let Some(free) = model.instance.get_func(&mut model.store, "__wbindgen_free") {
            let _ = free.call(
                &mut model.store,
                &[
                    Val::I32(out_ptr as i32),
                    Val::I32(out_len as i32),
                    Val::I32(1),
                ],
                &mut [],
            );
        }
        String::from_utf8_lossy(&sbuf).to_string()
    })
}

#[napi]
pub fn create_arm_engine() -> napi::Result<()> {
    ENGINE.with(|e| {
        let mut g = e.borrow_mut();
        let mut uc =
            Unicorn::new(Arch::ARM, Mode::THUMB | Mode::MCLASS).map_err(|e| err(&format!("{:?}", e)))?;
        uc.ctl_set_cpu_model(9).map_err(engine_err)?;
        *g = Some(uc);
        Ok(())
    })
}

#[napi]
pub fn mem_map(begin: u32, size: u32, prot: u32) -> napi::Result<()> {
    ENGINE.with(|e| {
        let mut g = e.borrow_mut();
        let uc = g.as_mut().ok_or_else(|| err("engine not created"))?;
        uc.mem_map(begin as u64, size as u64, Prot(prot & 0x7))
            .map_err(engine_err)?;
        Ok(())
    })
}

#[napi]
pub fn set_sp(sp: u32) -> napi::Result<()> {
    ENGINE.with(|e| {
        let mut g = e.borrow_mut();
        let uc = g.as_mut().ok_or_else(|| err("engine not created"))?;
        uc.reg_write(RegisterARM::SP, sp as u64).map_err(engine_err)?;
        Ok(())
    })
}

#[napi]
pub fn set_pc(pc: u32) -> napi::Result<()> {
    ENGINE.with(|e| {
        let mut g = e.borrow_mut();
        let uc = g.as_mut().ok_or_else(|| err("engine not created"))?;
        uc.reg_write(RegisterARM::PC, pc as u64).map_err(engine_err)?;
        Ok(())
    })
}

#[napi]
pub fn mem_write(begin: u32, data: Buffer) -> napi::Result<()> {
    ENGINE.with(|e| {
        let mut g = e.borrow_mut();
        let uc = g.as_mut().ok_or_else(|| err("engine not created"))?;
        uc.mem_write(begin as u64, &data).map_err(engine_err)?;
        Ok(())
    })
}

#[napi]
pub fn mem_read(begin: u32, size: u32) -> napi::Result<Buffer> {
    ENGINE.with(|e| {
        let mut g = e.borrow_mut();
        let uc = g.as_mut().ok_or_else(|| err("engine not created"))?;
        let mut buf = vec![0u8; size as usize];
        uc.mem_read(begin as u64, &mut buf).map_err(engine_err)?;
        Ok(Buffer::from(buf))
    })
}

#[napi]
pub fn set_trace(begin: u32, end: u32) -> napi::Result<()> {
    TRACE_BEGIN.store(begin as u64, Ordering::SeqCst);
    TRACE_END.store(end as u64, Ordering::SeqCst);
    Ok(())
}

#[napi]
pub fn emu_start(begin: u32, until: u32, timeout: u32, count: u32) -> napi::Result<()> {
    ENGINE.with(|e| {
        let mut g = e.borrow_mut();
        let uc = g.as_mut().ok_or_else(|| err("engine not created"))?;
        let tb = TRACE_BEGIN.load(Ordering::SeqCst);
        let te = TRACE_END.load(Ordering::SeqCst);
        let mut hook_id = None;
        if tb != 0 {
            let id = uc
                .add_code_hook(tb, te, |_uc, address, _size| {
                    eprintln!("TRACE pc=0x{:x}", address);
                })
                .map_err(engine_err)?;
            hook_id = Some(id);
        }
        let r = uc
            .emu_start(begin as u64, until as u64, timeout as u64, count as usize)
            .map_err(engine_err);
        if let Some(id) = hook_id {
            let _ = uc.remove_hook(id);
        }
        r?;
        Ok(())
    })
}

#[napi]
pub fn get_pc() -> napi::Result<u32> {
    ENGINE.with(|e| {
        let mut g = e.borrow_mut();
        let uc = g.as_mut().ok_or_else(|| err("engine not created"))?;
        Ok(uc.reg_read(RegisterARM::PC).map_err(engine_err)? as u32)
    })
}

#[napi]
pub fn get_counts() -> napi::Result<[u32; 2]> {
    Ok([
        READ_COUNT.load(Ordering::SeqCst) as u32,
        WRITE_COUNT.load(Ordering::SeqCst) as u32,
    ])
}

#[napi]
pub fn init_model() -> napi::Result<()> {
    let engine = Engine::default();
    let module = Module::from_binary(&engine, MODEL_WASM)
        .map_err(|e| err(&format!("module: {:?}", e)))?;
    let mut linker = Linker::new(&engine);
    for import in module.imports() {
        if let Some(ft) = import.ty().func().cloned() {
            linker
                .func_new(import.module(), import.name(), ft, |caller, _args, results| {
                    for r in results.iter_mut() {
                        *r = default_val(r.ty(&caller).unwrap_or(ValType::I32));
                    }
                    Ok(())
                })
                .map_err(|e| err(&format!("link {}: {:?}", import.name(), e)))?;
        }
    }
    let mut store = Store::new(&engine, ());
    let instance = linker
        .instantiate(&mut store, &module)
        .map_err(|e| err(&format!("instantiate: {:?}", e)))?;
    let periph_read = instance
        .get_func(&mut store, "periph_read")
        .ok_or_else(|| err("no periph_read"))?;
    let periph_write = instance
        .get_func(&mut store, "periph_write")
        .ok_or_else(|| err("no periph_write"))?;
    let get_uart = instance
        .get_func(&mut store, "get_uart_output")
        .ok_or_else(|| err("no get_uart_output"))?;
    let memory = instance
        .get_memory(&mut store, "memory")
        .ok_or_else(|| err("no memory"))?;
    let old_pages = memory
        .grow(&mut store, 64)
        .map_err(|_| err("grow failed"))?;
    let old_bytes = old_pages as usize * 65536;
    let scratch = (old_bytes + 64 * 65536 - 8) as i32;
    let mut model = Model {
        store,
        instance,
        periph_read,
        periph_write,
        get_uart,
        memory,
        scratch,
    };
    let init_fn = model
        .instance
        .get_func(&mut model.store, "init")
        .ok_or_else(|| err("no init"))?;
    if let Err(e) = init_fn.call(&mut model.store, &[], &mut []) {
        eprintln!("INIT TRAP: {:?}", e);
    }
    MODEL.with(|m| *m.borrow_mut() = Some(model));
    Ok(())
}

#[napi]
pub fn get_uart_output() -> napi::Result<String> {
    Ok(model_get_uart())
}

#[napi]
pub fn model_reset_state() -> napi::Result<()> {
    MODEL.with(|m| {
        let mut g = m.borrow_mut();
        let model = g.as_mut().ok_or_else(|| err("model not initialized"))?;
        if let Some(f) = model.instance.get_func(&mut model.store, "reset_state") {
            let _ = f.call(&mut model.store, &[], &mut []);
        }
        Ok(())
    })
}

#[napi]
pub fn model_tick_n(delta: u32) -> napi::Result<()> {
    MODEL.with(|m| {
        let mut g = m.borrow_mut();
        let model = g.as_mut().ok_or_else(|| err("model not initialized"))?;
        if let Some(f) = model.instance.get_func(&mut model.store, "tick_n") {
            let _ = f.call(&mut model.store, &[Val::I32(delta as i32)], &mut []);
        }
        Ok(())
    })
}

#[napi]
pub fn model_has_pending_interrupt() -> napi::Result<bool> {
    MODEL.with(|m| {
        let mut g = m.borrow_mut();
        let model = g.as_mut().ok_or_else(|| err("model not initialized"))?;
        if let Some(f) = model.instance.get_func(&mut model.store, "has_pending_interrupt") {
            let mut results = [Val::I32(0)];
            if f.call(&mut model.store, &[], &mut results).is_ok() {
                return Ok(results[0].i32().unwrap_or(0) != 0);
            }
        }
        Ok(false)
    })
}

#[napi]
pub fn hook_mem_read(begin: u32, end: u32) -> napi::Result<()> {
    ENGINE.with(|e| {
        let mut g = e.borrow_mut();
        let uc = g.as_mut().ok_or_else(|| err("engine not created"))?;
        uc.add_mem_hook(
            HookType::MEM_READ,
            begin as u64,
            end as u64,
            |uc, _mt, address, size, _value| {
                READ_COUNT.fetch_add(1, Ordering::SeqCst);
                let v = model_read(address as u32, size as u32);
                let _ = uc.mem_write(address, &v.to_le_bytes());
                false
            },
        )
        .map_err(engine_err)?;
        Ok(())
    })
}

#[napi]
pub fn dbg_read(addr: u32, width: u32) -> u32 {
    model_read(addr, width)
}

#[napi]
pub fn dbg_write(addr: u32, width: u32, val: u32) {
    MODEL.with(|m| {
        let mut g = m.borrow_mut();
        let model = g.as_mut().expect("model not initialized");
        if let Err(e) = model.periph_write.call(
            &mut model.store,
            &[
                Val::I32(addr as i32),
                Val::I32(width as i32),
                Val::I32(val as i32),
            ],
            &mut [],
        ) {
            eprintln!("WRITE TRAP: {:?}", e);
        }
    });
}

fn call_i32(name: &str) -> i32 {
    MODEL.with(|m| {
        let mut g = m.borrow_mut();
        let model = g.as_mut().expect("model not initialized");
        if let Some(f) = model.instance.get_func(&mut model.store, name) {
            let mut r = [Val::I32(0)];
            if f.call(&mut model.store, &[], &mut r).is_ok() {
                return r[0].i32().unwrap_or(0);
            }
        }
        0
    })
}

fn call_void(name: &str) {
    MODEL.with(|m| {
        let mut g = m.borrow_mut();
        let model = g.as_mut().expect("model not initialized");
        if let Some(f) = model.instance.get_func(&mut model.store, name) {
            let _ = f.call(&mut model.store, &[], &mut []);
        }
    })
}

fn call_u32(name: &str, arg: u32) {
    MODEL.with(|m| {
        let mut g = m.borrow_mut();
        let model = g.as_mut().expect("model not initialized");
        if let Some(f) = model.instance.get_func(&mut model.store, name) {
            let _ = f.call(
                &mut model.store,
                &[Val::I32(arg as i32)],
                &mut [],
            );
        }
    })
}

#[napi]
pub fn eth_is_tx_poll() -> bool {
    call_i32("eth_is_tx_poll") != 0
}
#[napi]
pub fn eth_get_tx_desc_addr() -> u32 {
    call_i32("eth_get_tx_desc_addr") as u32
}
#[napi]
pub fn eth_clear_tx_poll() {
    call_void("eth_clear_tx_poll")
}
#[napi]
pub fn eth_is_rx_poll() -> bool {
    call_i32("eth_is_rx_poll") != 0
}
#[napi]
pub fn eth_get_rx_desc_addr() -> u32 {
    call_i32("eth_get_rx_desc_addr") as u32
}
#[napi]
pub fn eth_clear_rx_poll() {
    call_void("eth_clear_rx_poll")
}
#[napi]
pub fn eth_tx_done() {
    call_void("eth_tx_done")
}
#[napi]
pub fn eth_rx_done() {
    call_void("eth_rx_done")
}
#[napi]
pub fn eth_signal_rx_poll(desc: u32) {
    call_u32("eth_signal_rx_poll", desc)
}
#[napi]
pub fn eth_signal_tx_poll(desc: u32) {
    call_u32("eth_signal_tx_poll", desc)
}

#[napi]
pub fn hook_mem_write(begin: u32, end: u32) -> napi::Result<()> {
    ENGINE.with(|e| {
        let mut g = e.borrow_mut();
        let uc = g.as_mut().ok_or_else(|| err("engine not created"))?;
        uc.add_mem_hook(
            HookType::MEM_WRITE,
            begin as u64,
            end as u64,
            |_uc, _mt, address, size, value| {
                WRITE_COUNT.fetch_add(1, Ordering::SeqCst);
                model_write(address as u32, size as u32, value as u32);
                false
            },
        )
        .map_err(engine_err)?;
        Ok(())
    })
}
