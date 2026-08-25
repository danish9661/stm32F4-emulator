// Expose emscripten's internal dylink entry points to JS so the side module
// (the Rust peripheral model) can be loaded at runtime via
// Module.loadWebAssemblyModule(bytes, {loadAsync:true}).
(function () {
  try {
    if (typeof loadWebAssemblyModule !== 'undefined') {
      Module.loadWebAssemblyModule = loadWebAssemblyModule;
    }
  } catch (e) {}
  try {
    if (typeof loadDynamicLibrary !== 'undefined') {
      Module.loadDynamicLibrary = loadDynamicLibrary;
    }
  } catch (e) {}
})();
