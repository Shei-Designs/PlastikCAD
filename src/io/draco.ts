// The Draco decoder, for glTF files whose meshes are compressed with it
// (KHR_draco_mesh_compression). The build that ships with three.js is used:
// some 190 kB of WebAssembly, loaded when the first such file is read.
// Where its file is depends on who runs it (the worker is given an address
// by the bundler, a test reads it from disk), so that is handed in.

/** One attribute of a decoded mesh: `size` numbers a corner. */
export interface DracoAttribute {
  data: Float32Array;
  size: number;
}

/** Decodes one compressed primitive: its triangles, and the attributes asked for by the ids the file gives them. */
export type DracoDecode = (bytes: Uint8Array, attributes: Record<string, number>) => { indices: Uint32Array; attributes: Record<string, DracoAttribute> };

// What is used of the decoder module, which comes without types.
interface DracoStatus {
  ok(): boolean;
  error_msg(): string;
}
interface DracoMesh {
  ptr: number;
  num_points(): number;
  num_faces(): number;
}
interface DracoModule {
  TRIANGULAR_MESH: number;
  DT_FLOAT32: number;
  HEAPF32: Float32Array;
  HEAPU32: Uint32Array;
  _malloc(bytes: number): number;
  _free(at: number): void;
  destroy(o: unknown): void;
  Decoder: new () => {
    GetEncodedGeometryType(buffer: unknown): number;
    DecodeBufferToMesh(buffer: unknown, mesh: DracoMesh): DracoStatus;
    GetTrianglesUInt32Array(mesh: DracoMesh, bytes: number, at: number): boolean;
    GetAttributeByUniqueId(mesh: DracoMesh, id: number): { ptr: number; num_components(): number };
    GetAttributeDataArrayForAllPoints(mesh: DracoMesh, attribute: unknown, type: number, bytes: number, at: number): boolean;
  };
  DecoderBuffer: new () => { Init(data: Int8Array, length: number): void };
  Mesh: new () => DracoMesh;
}
type DracoFactory = (options: Record<string, unknown>) => Promise<DracoModule>;

let loading: Promise<DracoDecode> | null = null;

/** Loads the decoder once; `options` say where its WebAssembly is. A failed load is tried again when next asked for. */
export function loadDraco(options: { wasmBinary?: Uint8Array | ArrayBuffer; locateFile?: (file: string) => string }): Promise<DracoDecode> {
  loading ??= import('three/examples/jsm/libs/draco/gltf/draco_wasm_wrapper.js')
    .then((module: { default: DracoFactory }) => module.default({ ...options }))
    .then(decoderOf)
    .catch((e: unknown) => {
      loading = null;
      throw e;
    });
  return loading;
}

function decoderOf(draco: DracoModule): DracoDecode {
  return (bytes, wanted) => {
    const decoder = new draco.Decoder();
    const buffer = new draco.DecoderBuffer();
    const mesh = new draco.Mesh();
    try {
      buffer.Init(new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), bytes.byteLength);
      if (decoder.GetEncodedGeometryType(buffer) !== draco.TRIANGULAR_MESH) throw new Error('not a triangle mesh');
      const status = decoder.DecodeBufferToMesh(buffer, mesh);
      if (!status.ok() || mesh.ptr === 0) throw new Error(status.error_msg());
      const points = mesh.num_points();
      const faces = mesh.num_faces();
      /** `count` numbers of four bytes each, read by `fill` into the module's own memory and copied out of it. */
      const read = <T extends Float32Array | Uint32Array>(count: number, heap: () => T, fill: (bytes: number, at: number) => boolean): T => {
        const at = draco._malloc(count * 4);
        try {
          if (!fill(count * 4, at)) throw new Error('could not be read out');
          // The heap is looked up after the call: it may have grown, and moved, meanwhile.
          return heap().slice(at / 4, at / 4 + count) as T;
        } finally {
          draco._free(at);
        }
      };
      const indices = read(faces * 3, () => draco.HEAPU32, (size, at) => decoder.GetTrianglesUInt32Array(mesh, size, at));
      const attributes: Record<string, DracoAttribute> = {};
      for (const [name, id] of Object.entries(wanted)) {
        const attribute = decoder.GetAttributeByUniqueId(mesh, id);
        if (!attribute || attribute.ptr === 0) continue;
        const size = attribute.num_components();
        attributes[name] = { size, data: read(points * size, () => draco.HEAPF32, (bytesOut, at) => decoder.GetAttributeDataArrayForAllPoints(mesh, attribute, draco.DT_FLOAT32, bytesOut, at)) };
      }
      return { indices, attributes };
    } finally {
      draco.destroy(mesh);
      draco.destroy(buffer);
      draco.destroy(decoder);
    }
  };
}
