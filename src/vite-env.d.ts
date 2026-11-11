/// <reference types="vite/client" />

// The Draco decoder that ships with three.js: a script without types (see io/draco.ts for what is used of it).
declare module 'three/examples/jsm/libs/draco/gltf/draco_wasm_wrapper.js' {
  const factory: (options: Record<string, unknown>) => Promise<never>;
  export default factory;
}
