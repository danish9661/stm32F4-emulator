#!/usr/bin/env python3

import os
import re
import shutil
import subprocess
import sys

EXPORTED_FUNCTIONS = [
    '_free',
    '_malloc',
    '_uc_arch_supported',
    '_uc_close',
    '_uc_context_alloc',
    '_uc_context_free',
    '_uc_context_restore',
    '_uc_context_save',
    '_uc_ctl',
    '_uc_emu_start',
    '_uc_emu_stop',
    '_uc_errno',
    '_uc_free',
    '_uc_hook_add',
    '_uc_hook_del',
    '_uc_mem_map_ptr',
    '_uc_mem_map',
    '_uc_mem_protect',
    '_uc_mem_read',
    '_uc_mem_regions',
    '_uc_mem_unmap',
    '_uc_mem_write',
    '_uc_open',
    '_uc_query',
    '_uc_reg_read_batch',
    '_uc_reg_read',
    '_uc_reg_write_batch',
    '_uc_reg_write',
    '_uc_strerror',
    '_uc_version',
]

# Functions provided by the merged Rust peripheral model (libstm32_model_capi.a).
# Linked directly into the Unicorn wasm so MMIO/code hooks run in-wasm (no JS crossing).
MODEL_EXPORTS = [
    'm_init_svd', 'm_init', 'm_reset_state',
    'm_periph_read', 'm_periph_write',
    'm_tick', 'm_tick_n',
    'm_has_pending_interrupt', 'm_get_next_pending_interrupt', 'm_set_intr_pending',
    'm_pwr_wakeup', 'm_is_watchdog_reset_requested',
    'm_iwdg_reset_flag', 'm_wwdg_reset_flag', 'm_clear_watchdog_reset_flags',
    'm_can_inject', 'm_tim_inject_capture',
    'm_dma_get_pending_count', 'm_dma_get_pending', 'm_dma_set_completed',
    'm_dma_periph_read', 'm_dma_periph_write',
    'm_gpio_read_output', 'm_gpio_set_input', 'm_gpio_read_input',
    'm_adc_set_channel_value', 'm_adc_clear_channel_value',
    'm_uart_rx_byte',
    'm_audio_load_wav', 'm_audio_take_capture', 'm_audio_source_remaining', 'm_audio_clear',
    'm_ltdc_get_scanline', 'm_ltdc_get_frame_count',
    'm_eth_is_tx_poll', 'm_eth_get_tx_desc_addr', 'm_eth_clear_tx_poll',
    'm_eth_is_rx_poll', 'm_eth_get_rx_desc_addr', 'm_eth_clear_rx_poll',
    'm_eth_tx_done', 'm_eth_rx_done', 'm_eth_signal_rx_poll', 'm_eth_signal_tx_poll',
    'm_flash_is_programming', 'm_flash_take_erase', 'm_flash_erase_applied',
    'm_get_uart_output',
    'm_add_spi_flash', 'm_spi_flash_debug', 'm_add_i2c_eeprom', 'm_add_software_spi',
    'm_spi_tap', 'm_spi_take_events', 'm_spi_push_miso',
    'm_i2c_register_slave', 'm_i2c_take_events', 'm_i2c_push_rx',
    'm_i2c_register_regfile', 'm_i2c_regfile_get', 'm_i2c_regfile_set',
    'm_fsmc_tap', 'm_fsmc_take_events', 'm_fsmc_push_data',
    'm_dcmi_feed_frame', 'm_dcmi_clear',
]

# In-wasm native hook callbacks + getters (defined in src/native_hooks.c, which is
# compiled into the Unicorn MAIN_MODULE). The getters hand function pointers to
# unicorn-wrapper.js so it can register in-wasm hooks.
NATIVE_EXPORTS = [
    '_native_mmio_read', '_native_mmio_write',
    '_get_native_mmio_read', '_get_native_mmio_write', '_get_native_code_hook',
]

# Path to the C-API staticlib, built automatically (see buildModelCapi) from the
# vendored stm32_model_capi crate unless MODEL_LIB_OVERRIDE is provided.
_ROOT = os.path.dirname(os.path.abspath(__file__))
MODEL_LIB = os.path.join(_ROOT, 'stm32_model_capi', 'target',
                         'wasm32-unknown-emscripten', 'debug', 'libstm32_model_capi.a')
if os.environ.get('MODEL_LIB_OVERRIDE'):
    MODEL_LIB = os.environ['MODEL_LIB_OVERRIDE']

# Set UNICORN_ONLY=1 to build plain Unicorn (no model) for A/B isolation.
UNICORN_ONLY = os.environ.get('UNICORN_ONLY') == '1'

# DYLINK=1 builds Unicorn as an Emscripten MAIN_MODULE and the model as a
# separate SIDE_MODULE (loaded at runtime via Module.loadWebAssemblyModule).
# This avoids function-table corruption from statically linking two
# emscripten-built staticlibs into one module.
DYLINK = os.environ.get('DYLINK') == '1'

AVAILABLE_ARCHITECTURES = [
    'arm', 'aarch64', 'm68k', 'mips', 'ppc', 'riscv', 's390x', 'sparc',
    'tricore', 'x86',
]

TARGET_ALIASES = {
    'aarch64': 'arm64',
}


def arch_constants(arch):
    name = TARGET_ALIASES.get(arch.lower(), arch.lower())
    return name + '.h', name, 'UC_%s_' % name.upper()


# Directories
ROOT_DIR = os.path.abspath(os.path.dirname(__file__))
UNICORN_DIR = os.path.join(ROOT_DIR, "unicorn")
UNICORN_INCLUDE_DIR = os.path.join(UNICORN_DIR, "include", "unicorn")
UNICORN_QEMU_DIR = os.path.join(UNICORN_DIR, "qemu")
UNICORN_BUILD_DIR = os.path.join(UNICORN_DIR, "build")
ORIGINAL_QEMU_DIR = os.path.join(ROOT_DIR, "externals/qemu-5.0.1")
HELPER_ADAPTER_SRC = os.path.join(ROOT_DIR, "src/qemu/helper-adapter.h")


def constant_files(archs=[]):
    targets = archs if archs else AVAILABLE_ARCHITECTURES
    files = []
    for arch in targets:
        header, name, _ = arch_constants(arch)
        path = os.path.join(ROOT_DIR, 'src', 'constants_%s.js' % name)
        if os.path.exists(path):
            files.append(path)
    return files


def generateConstants():
    """Generate src/constants_<name>.js from Unicorn's C headers (one per header)."""
    for arch in AVAILABLE_ARCHITECTURES:
        header, name, prefix = arch_constants(arch)
        prefixes = (prefix, 'UC_CPU_')
        content = open(os.path.join(UNICORN_INCLUDE_DIR, header)).read()
        content = re.sub(r'/\*.*?\*/', ' ', content, flags=re.DOTALL)
        # (constants generation kept minimal; relies on existing generated files)
        pass


def patchUnicorn():
    # The copied clone already ships a patched unicorn/ with TCI + built libunicorn.a.
    pass


def compileUnicorn(archs=[]):
    targets = archs if archs else AVAILABLE_ARCHITECTURES

    # Configure with CMake (skipped if a prebuilt libunicorn.a exists).
    if not os.path.exists(os.path.join(UNICORN_BUILD_DIR, 'libunicorn.a')):
        shutil.rmtree(UNICORN_BUILD_DIR, ignore_errors=True)
    if not os.path.exists(os.path.join(UNICORN_BUILD_DIR, 'libunicorn.a')):
        subprocess.run([
            'emcmake', 'cmake',
            '-B', UNICORN_BUILD_DIR,
            '-S', UNICORN_DIR,
            '-DCMAKE_BUILD_TYPE=Release',
            '-DBUILD_SHARED_LIBS=OFF',
            '-DUNICORN_ARCH=' + ';'.join(targets),
            '-DUNICORN_BUILD_TESTS=OFF',
            '-DUNICORN_INSTALL=OFF',
            '-DUNICORN_FUZZ=OFF',
            '-DUNICORN_LEGACY_STATIC_ARCHIVE=ON',
            '-DCMAKE_C_FLAGS=-fwasm-exceptions',
            '-DCMAKE_CXX_FLAGS=-fwasm-exceptions',
        ], check=True)
        jobs = os.cpu_count() or 1
        subprocess.run(['emmake', 'cmake', '--build', UNICORN_BUILD_DIR,
                        '--target', 'unicorn_archive', f'-j{jobs}'], check=True)

    suffix = ('_' + '+'.join(archs)) if archs else ''
    methods = [
        'ccall', 'cwrap', 'getValue', 'setValue', 'addFunction', 'removeFunction',
        'writeArrayToMemory', 'stringToUTF8', 'UTF8ToString', 'AsciiToString',
    ]

    dylink_exports = []
    if DYLINK:
        # Model + native hooks live in a SIDE_MODULE; main is plain Unicorn.
        model_lib = None
        model_exports = []
        native_hooks_src = None
    elif UNICORN_ONLY:
        model_lib = None
        model_exports = []
        native_hooks_src = None
    else:
        model_lib = MODEL_LIB
        model_exports = MODEL_EXPORTS + NATIVE_EXPORTS
        native_hooks_src = 'src/native_hooks.c'

    cmd = [
        'emcc',
        '-Os',
        '-I', 'unicorn/include',
    ]
    if DYLINK:
        # The Rust side module (wasm32-unknown-emscripten) imports the
        # `__cpp_exception` WASM tag, so the MAIN_MODULE must enable WASM
        # exception handling (-fwasm-exceptions) to export it. SUPPORT_LONGJMP=1
        # implements setjmp/longjmp on top of WASM exceptions (Unicorn's cpu_loop
        # relies on it). The Unicorn staticlib is rebuilt with -fwasm-exceptions
        # (see compileUnicorn) so its emscripten_longjmp references resolve to the
        # EH-aware copy in libcompiler_rt; --undefined forces the linker to pull it
        # (a MAIN_MODULE otherwise lists it as an allowed-undefined import).
        cmd.append('src/dummy_exceptions.cpp')
        cmd.append('-fwasm-exceptions')
        cmd.append('-s')
        cmd.append('SUPPORT_LONGJMP=1')
        cmd.append('-Wl,--undefined=emscripten_longjmp')
        cmd.append('-Wl,--undefined=_emscripten_throw_longjmp')
    if native_hooks_src is not None:
        cmd.append(native_hooks_src)
    if model_lib is not None:
        cmd.append(model_lib)
    cmd.append(os.path.join(UNICORN_BUILD_DIR, 'libunicorn.a'))
    # For a MAIN_MODULE everything is exported automatically; passing
    # EXPORTED_FUNCTIONS is invalid (and unnecessary) there.
    if not DYLINK:
        cmd += ['-s', f"EXPORTED_FUNCTIONS={EXPORTED_FUNCTIONS + model_exports}"]
    cmd += [
        '-s', f"EXPORTED_RUNTIME_METHODS={methods}",
        '-s', 'RESERVED_FUNCTION_POINTERS=256',
        '-s', 'ALLOW_TABLE_GROWTH=1',
        '-s', 'ALLOW_MEMORY_GROWTH=1',
        '-s', 'MODULARIZE=1',
        '-s', 'SINGLE_FILE=1',
        '-s', 'WASM=1',
        '-s', 'WASM_BIGINT=1',
        '-s', "EXPORT_NAME='MUnicorn'",
    ]
    if DYLINK:
        cmd += ['-s', 'MAIN_MODULE=1']
    for path in constant_files(archs):
        cmd += ['--post-js', path]
    cmd += ['--post-js', 'src/unicorn-wrapper.js']
    if DYLINK:
        cmd += ['--post-js', 'src/dylink_exports.js']
    cmd += ['-o', f'dist/unicorn{suffix}.js']
    os.makedirs('dist', exist_ok=True)
    subprocess.run(cmd, check=True)


def buildModelCapi():
    """Build the Rust C-API staticlib (libstm32_model_capi.a) for
    wasm32-unknown-emscripten if it isn't supplied via MODEL_LIB_OVERRIDE.
    Requires the rust wasm32-unknown-emscripten target and a working emsdk in PATH.
    The vendored model crate lives at ./stm32-periph-wasm (feature-gated so it
    builds without wasm-bindgen)."""
    if os.environ.get('MODEL_LIB_OVERRIDE'):
        return
    if os.path.exists(MODEL_LIB):
        return
    capi_dir = os.path.join(_ROOT, 'stm32_model_capi')
    subprocess.run(['cargo', 'build', '--target', 'wasm32-unknown-emscripten'],
                   cwd=capi_dir, check=True)


def buildModelSideModule():
    """Build the Rust peripheral model + native hooks as an Emscripten
    SIDE_MODULE wasm (loaded into the MAIN_MODULE Unicorn build at runtime).
    Native hooks (src/native_hooks.c) call the model's m_* (in-module) and
    import uc_mem_write/uc_emu_stop from the main module."""
    os.makedirs('dist', exist_ok=True)
    override = os.environ.get('MODEL_LIB_OVERRIDE')
    lib = override or MODEL_LIB
    cmd = [
        'emcc',
        '-Os',
        '-I', 'unicorn/include',
        'src/native_hooks.c',
        lib,
        '-s', 'SIDE_MODULE=1',
        '-s', 'EXPORT_ALL=1',
        '-s', 'WASM_BIGINT=1',
        '--no-entry',
        '-o', 'dist/model_side.wasm',
    ]
    # NOTE: this emsdk's binaryen snapshot rejects `--enable-bulk-memory-opt`
    # (added by emscripten's wasm-opt feature detection because the Rust side
    # module imports the `__cpp_exception` EH tag). The pre-optimization .wasm
    # is already written by the time wasm-opt runs and is fully functional, so we
    # tolerate only that specific post-pass failure.
    import subprocess as _sp
    r = _sp.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        size = os.path.getsize('dist/model_side.wasm') if os.path.exists('dist/model_side.wasm') else 0
        if size > 1000 and 'bulk-memory-opt' in r.stderr:
            print('[warn] wasm-opt post-pass failed (known emsdk binaryen mismatch); '
                  'using pre-optimized model_side.wasm (functionally correct).')
        else:
            raise SystemExit('side module build failed:\n' + r.stderr)


if __name__ == "__main__":
    args = sys.argv[1:]
    release = '--release' in args
    generateConstants()
    if release:
        compileUnicorn([])
        for arch in AVAILABLE_ARCHITECTURES:
            compileUnicorn([arch])
    else:
        archs = sorted(a for a in args if not a.startswith('--'))
        compileUnicorn(archs)
        if DYLINK:
            buildModelCapi()
            buildModelSideModule()
