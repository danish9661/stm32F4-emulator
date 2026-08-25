#include <emscripten.h>

// Force emscripten to include WASM exception handling support (the
// `env.__cpp_exception` WASM tag) so the Rust side module can link. The
// function is kept alive and exported; its `throw` ensures the EH runtime
// (which defines/exports the tag) is linked into the MAIN_MODULE.
#ifdef __cplusplus
extern "C" {
#endif

EMSCRIPTEN_KEEPALIVE
int emscripten_dummy_force_eh() {
    throw 1;
    return 0;
}

#ifdef __cplusplus
}
#endif
