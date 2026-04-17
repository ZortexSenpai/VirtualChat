// Ensure globalThis.global exists — required by some matrix-js-sdk transitive deps
if (typeof (globalThis as any).global === 'undefined') {
  ;(globalThis as any).global = globalThis
}
