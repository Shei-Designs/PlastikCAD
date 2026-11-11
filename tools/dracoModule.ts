// three.js ships the Draco decoder as a script that leaves its factory in a
// global, `DracoDecoderModule`: read as a module it exports nothing, and the
// app may not evaluate text as code (its content security policy forbids it,
// rightly). This hands the factory out as the module's default export, for
// the app's build and for the tests alike (see src/io/draco.ts).
import type { Plugin } from 'vite';

export function dracoModule(): Plugin {
  return {
    name: 'draco-module',
    transform(code, id) {
      if (!id.replace(/\\/g, '/').includes('/libs/draco/gltf/draco_wasm_wrapper.js')) return null;
      // Its last statement offers the factory to whatever module system it finds, which a module runner may seem to
      // be: that statement is left off.
      const offer = code.lastIndexOf('"object"===typeof exports&&"object"===typeof module');
      if (offer < 0) throw new Error('The Draco decoder in three.js no longer ends the way tools/dracoModule.ts expects.');
      return { code: `${code.slice(0, offer)}\nexport default DracoDecoderModule;\n`, map: null };
    },
  };
}
