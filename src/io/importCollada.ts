// Collada 1.4 and 1.5 (.dae): the geometries of the visual scene, placed by
// its nodes, one part per material with the diffuse color of its effect and
// the picture it names when that came along. The file says its unit and which
// axis is up; parts come out Z up in millimeters. Collada is what most ROS
// robot descriptions draw their links with.
import type { MeshWithUV } from '../geometry/mesh';
import { apply, determinant, IDENTITY, multiply } from '../model/math';
import type { Mat } from '../model/math';
import type { Companion, ImportedImage, ImportedModel, ImportedPart } from './import';
import { hex, imageMime } from './material';
import { cutPolygon, MeshBuilder } from './weld';
import { childOf, childrenOf, localName, xmlTree } from './xml';
import type { XmlElement } from './xml';

const MAX_TRIANGLES = 20_000_000;
const MAX_NODES = 100_000;
const MAX_DEPTH = 64;

/** A `<source>`: its numbers and how the accessor reads them. */
interface Source {
  data: Float64Array;
  stride: number;
  offset: number;
  count: number;
}

/** What a primitive block's inputs say about where a corner's indices point. */
interface Inputs {
  /** Indices per corner. */
  stride: number;
  position: { source: Source; offset: number };
  texcoord?: { source: Source; offset: number };
}

export function parseCollada(bytes: Uint8Array, name = 'Model', companions: Companion[] = []): ImportedModel {
  if (bytes.length === 0) throw new Error('This Collada file is empty.');
  const root = xmlTree(bytes);
  if (!root || localName(root.name) !== 'COLLADA') throw new Error('This is not a Collada file.');

  // Everything with an id, for the `#id` references the file is built from.
  const byId = new Map<string, XmlElement>();
  const index = (e: XmlElement) => {
    if (e.attrs.id) byId.set(e.attrs.id, e);
    for (const c of e.children) index(c);
  };
  index(root);
  const ref = (url: string | undefined): XmlElement | undefined => (url ? byId.get(url.startsWith('#') ? url.slice(1) : url) : undefined);

  // The unit and the up axis: into millimeters, Z up.
  const asset = childOf(root, 'asset');
  const meter = parseFloat(asset && childOf(asset, 'unit')?.attrs.meter ? childOf(asset, 'unit')!.attrs.meter : '1');
  const unit = (Number.isFinite(meter) && meter > 0 ? meter : 1) * 1000;
  const up = (asset && childOf(asset, 'up_axis')?.text) || 'Y_UP';
  const placed = (x: number, y: number, z: number): [number, number, number] => (up === 'Z_UP' ? [x, y, z] : up === 'X_UP' ? [-y, -z, x] : [x, -z, y]);

  const numbers = (text: string): Float64Array => {
    const words = text.trim().split(/\s+/);
    const out = new Float64Array(words.length);
    for (let i = 0; i < words.length; i++) out[i] = Number(words[i]);
    return out;
  };
  const sources = new Map<XmlElement, Source>();
  const sourceOf = (url: string | undefined): Source | undefined => {
    const element = ref(url);
    if (!element) return undefined;
    // An input may point at the <vertices> rather than the source itself.
    if (localName(element.name) === 'vertices') return sourceOf(childrenOf(element, 'input').find((i) => i.attrs.semantic === 'POSITION')?.attrs.source);
    if (sources.has(element)) return sources.get(element);
    const array = childOf(element, 'float_array');
    const accessor = childOf(element, 'technique_common') && childOf(childOf(element, 'technique_common')!, 'accessor');
    if (!array) return undefined;
    const data = numbers(array.text);
    const stride = Math.max(1, Number(accessor?.attrs.stride ?? 1) || 1);
    const offset = Number(accessor?.attrs.offset ?? 0) || 0;
    const count = Number(accessor?.attrs.count ?? Math.floor(data.length / stride)) || 0;
    const source = { data, stride, offset, count };
    sources.set(element, source);
    return source;
  };
  const inputsOf = (primitive: XmlElement): Inputs | null => {
    const inputs = childrenOf(primitive, 'input');
    let stride = 0;
    let position: Inputs['position'] | undefined;
    let texcoord: Inputs['texcoord'] | undefined;
    let texSet = Infinity;
    for (const input of inputs) {
      const offset = Number(input.attrs.offset ?? 0) || 0;
      stride = Math.max(stride, offset + 1);
      if (input.attrs.semantic === 'VERTEX') {
        const vertices = ref(input.attrs.source);
        for (const inner of vertices ? childrenOf(vertices, 'input') : []) {
          const source = sourceOf(inner.attrs.source);
          if (!source) continue;
          if (inner.attrs.semantic === 'POSITION') position = { source, offset };
          else if (inner.attrs.semantic === 'TEXCOORD' && !texcoord) texcoord = { source, offset };
        }
      } else if (input.attrs.semantic === 'TEXCOORD') {
        const set = Number(input.attrs.set ?? 0) || 0;
        const source = sourceOf(input.attrs.source);
        if (source && set < texSet) {
          texcoord = { source, offset };
          texSet = set;
        }
      }
    }
    if (!position) return null;
    return { stride: Math.max(1, stride), position, texcoord };
  };

  // Materials: the diffuse color and picture of the effect behind a material.
  const images = new Map<string, ImportedImage | undefined>();
  const imageOf = (id: string | undefined): ImportedImage | undefined => {
    if (!id) return undefined;
    if (images.has(id)) return images.get(id);
    const image = ref(id);
    let out: ImportedImage | undefined;
    const from = image && (childOf(image, 'init_from')?.text || (childOf(image, 'init_from') && childOf(childOf(image, 'init_from')!, 'ref')?.text) || '');
    if (from) {
      const file = unescaped(from.replace(/^file:\/*/, '')).replace(/\\/g, '/');
      const tail = file.split('/').pop()!.toLowerCase();
      const mime = imageMime(tail);
      const companion = companions.find((c) => c.name.split('/').pop()!.toLowerCase() === tail);
      if (mime && companion) out = { name: companion.name.split('/').pop()!, mime, bytes: companion.bytes };
    }
    images.set(id, out);
    return out;
  };
  const materials = new Map<XmlElement, { color?: string; image?: ImportedImage; name?: string }>();
  const materialOf = (material: XmlElement | undefined) => {
    if (!material) return {};
    if (materials.has(material)) return materials.get(material)!;
    const out: { color?: string; image?: ImportedImage; name?: string } = { name: material.attrs.name || material.attrs.id };
    const effect = ref(childOf(material, 'instance_effect')?.attrs.url);
    const profile = effect && childOf(effect, 'profile_COMMON');
    const technique = profile && childOf(profile, 'technique');
    const shader = technique && technique.children.find((c) => ['lambert', 'phong', 'blinn', 'constant'].includes(localName(c.name)));
    const diffuse = shader && (childOf(shader, 'diffuse') ?? childOf(shader, 'emission'));
    const color = diffuse && childOf(diffuse, 'color');
    const texture = diffuse && childOf(diffuse, 'texture');
    if (color) {
      const c = numbers(color.text);
      if (c.length >= 3 && c.slice(0, 3).every((v) => Number.isFinite(v))) out.color = hex(c[0], c[1], c[2]);
    }
    if (texture) {
      // The texture names a sampler parameter, which names a surface parameter, which names the image (1.4); or the image itself (1.5).
      const params = profile ? childrenOf(profile, 'newparam') : [];
      const param = (sid: string | undefined) => params.find((p) => p.attrs.sid === sid);
      const sampler = param(texture.attrs.texture);
      const sampler2D = sampler && childOf(sampler, 'sampler2D');
      const surfaceName = sampler2D && childOf(sampler2D, 'source')?.text;
      const surface = param(surfaceName) && childOf(param(surfaceName)!, 'surface');
      const imageId = (surface && childOf(surface, 'init_from')?.text) || (sampler2D && childOf(sampler2D, 'instance_image')?.attrs.url) || texture.attrs.texture;
      const image = imageOf(imageId?.replace(/^#/, ''));
      if (image) out.image = image;
    }
    materials.set(material, out);
    return out;
  };

  const parts: ImportedPart[] = [];
  let triangles = 0;
  let visited = 0;
  /** The geometry's meshes placed by `world`, under the node's material bindings (symbol → material). */
  const emitGeometry = (geometry: XmlElement, bindings: Map<string, XmlElement>, nodeName: string | undefined, world: Mat) => {
    const mesh = childOf(geometry, 'mesh');
    if (!mesh) return;
    const primitives = mesh.children.filter((c) => ['triangles', 'polylist', 'polygons', 'tristrips', 'trifans'].includes(localName(c.name)));
    const mirrored = determinant(world) < 0;
    const base = nodeName || geometry.attrs.name || geometry.attrs.id || name;
    for (const [p, primitive] of primitives.entries()) {
      const inputs = inputsOf(primitive);
      if (!inputs) continue;
      const kind = localName(primitive.name);
      // The corners of every polygon, as runs of indices into the inputs.
      const polygons: number[][] = [];
      const blocks = childrenOf(primitive, 'p').map((e) => numbers(e.text));
      if (kind === 'triangles') {
        for (const block of blocks) for (let i = 0; i + 3 * inputs.stride <= block.length; i += 3 * inputs.stride) polygons.push(Array.from(block.subarray(i, i + 3 * inputs.stride)));
      } else if (kind === 'polylist') {
        const counts = childOf(primitive, 'vcount') ? numbers(childOf(primitive, 'vcount')!.text) : new Float64Array(0);
        const block = blocks[0] ?? new Float64Array(0);
        let at = 0;
        for (const c of counts) {
          const n = c * inputs.stride;
          if (at + n > block.length) break;
          polygons.push(Array.from(block.subarray(at, at + n)));
          at += n;
        }
      } else if (kind === 'polygons') {
        for (const block of blocks) polygons.push(Array.from(block));
      } else {
        // Strips and fans: every <p> is one, unrolled into triangles here.
        for (const block of blocks) {
          const corners = block.length / inputs.stride;
          for (let i = 2; i < corners; i++) {
            const [a, b, c] = kind === 'tristrips' ? (i % 2 ? [i - 1, i - 2, i] : [i - 2, i - 1, i]) : [0, i - 1, i];
            polygons.push([...block.subarray(a * inputs.stride, (a + 1) * inputs.stride), ...block.subarray(b * inputs.stride, (b + 1) * inputs.stride), ...block.subarray(c * inputs.stride, (c + 1) * inputs.stride)]);
          }
        }
      }
      const corners = polygons.reduce((n, poly) => n + poly.length / inputs.stride, 0);
      triangles += Math.max(0, corners - 2 * polygons.length);
      if (triangles > MAX_TRIANGLES) throw new Error('This Collada file has too many triangles to open.');
      const builder = new MeshBuilder(Math.max(16, inputs.position.source.count), Math.max(16, corners));
      const position = inputs.position.source;
      const placedVertex = new Map<number, number>();
      const vertex = (i: number): number => {
        let v = placedVertex.get(i);
        if (v !== undefined) return v;
        const o = position.offset + i * position.stride;
        if (i < 0 || o + 2 >= position.data.length) return -1;
        const w = apply(world, [position.data[o], position.data[o + 1], position.data[o + 2]]);
        const [px, py, pz] = placed(w[0], w[1], w[2]);
        v = builder.vertex(px * unit, py * unit, pz * unit);
        placedVertex.set(i, v);
        return v;
      };
      const uv: number[] = [];
      const tex = inputs.texcoord;
      const uvOf = (corner: number[], k: number): [number, number] => {
        if (!tex) return [0, 0];
        const i = corner[k * inputs.stride + tex.offset];
        const o = tex.source.offset + i * tex.source.stride;
        return o + 1 < tex.source.data.length ? [tex.source.data[o], tex.source.data[o + 1]] : [0, 0];
      };
      for (const poly of polygons) {
        const n = poly.length / inputs.stride;
        const at = (k: number) => poly[k * inputs.stride + inputs.position.offset];
        // A fan around the first corner, unless the polygon is not convex.
        let cut: number[] | null = null;
        if (n > 3) {
          const corners: number[] = [];
          for (let k = 0; k < n; k++) {
            const o = position.offset + at(k) * position.stride;
            if (!(o >= 0 && o + 2 < position.data.length)) break;
            corners.push(position.data[o], position.data[o + 1], position.data[o + 2]);
          }
          if (corners.length === n * 3) cut = cutPolygon(corners);
        }
        const count = cut ? cut.length / 3 : n - 2;
        for (let t = 0; t < count; t++) {
          const [i, j, l] = cut ? [cut[t * 3], cut[t * 3 + 1], cut[t * 3 + 2]] : [0, t + 1, t + 2];
          const [a, b, c] = mirrored ? [i, l, j] : [i, j, l];
          const before = builder.size;
          builder.triangle(vertex(at(a)), vertex(at(b)), vertex(at(c)));
          if (tex && builder.size > before) for (const corner of [a, b, c]) uv.push(...uvOf(poly, corner));
        }
      }
      if (builder.size === 0) continue;
      const out: MeshWithUV = builder.finish();
      if (tex) out.uv = Float32Array.from(uv);
      const material = materialOf(bindings.get(primitive.attrs.material ?? '') ?? ref(primitive.attrs.material));
      const tag = material.name && material.name !== base ? material.name : String(p + 1);
      const part: ImportedPart = { name: primitives.length > 1 ? `${base} (${tag})` : base, mesh: out };
      if (material.color) part.color = material.color;
      if (material.image) part.image = material.image;
      parts.push(part);
    }
  };
  const bindingsOf = (instance: XmlElement): Map<string, XmlElement> => {
    const out = new Map<string, XmlElement>();
    const bind = childOf(instance, 'bind_material');
    const common = bind && childOf(bind, 'technique_common');
    for (const im of common ? childrenOf(common, 'instance_material') : []) {
      const target = ref(im.attrs.target);
      if (im.attrs.symbol && target) out.set(im.attrs.symbol, target);
    }
    return out;
  };
  /** The geometry an instance draws: its own, or the one a controller (a skin, a morph) is built on. */
  const geometryOf = (instance: XmlElement): XmlElement | undefined => {
    const target = ref(instance.attrs.url);
    if (!target) return undefined;
    if (localName(target.name) === 'geometry') return target;
    if (localName(target.name) === 'controller') {
      const inner = childOf(target, 'skin') ?? childOf(target, 'morph');
      return ref(inner?.attrs.source);
    }
    return undefined;
  };
  const visit = (node: XmlElement, parent: Mat, depth: number) => {
    if (depth > MAX_DEPTH) return;
    if (++visited > MAX_NODES) throw new Error('This Collada file has too many nodes to open.');
    const world = multiply(parent, localMatrix(node));
    const label = node.attrs.name || node.attrs.id || undefined;
    for (const instance of [...childrenOf(node, 'instance_geometry'), ...childrenOf(node, 'instance_controller')]) {
      const geometry = geometryOf(instance);
      if (geometry) emitGeometry(geometry, bindingsOf(instance), label, world);
    }
    for (const instance of childrenOf(node, 'instance_node')) {
      const target = ref(instance.attrs.url);
      if (target && localName(target.name) === 'node') visit(target, world, depth + 1);
    }
    for (const child of childrenOf(node, 'node')) visit(child, world, depth + 1);
  };

  const scene = childOf(root, 'scene');
  const library = childOf(root, 'library_visual_scenes');
  const visual = ref(scene && childOf(scene, 'instance_visual_scene')?.attrs.url) ?? (library && childOf(library, 'visual_scene'));
  if (visual) for (const node of childrenOf(visual, 'node')) visit(node, IDENTITY, 0);
  // No scene: every geometry, where it is.
  if (parts.length === 0 && !visual) {
    const geometries = childOf(root, 'library_geometries');
    for (const geometry of geometries ? childrenOf(geometries, 'geometry') : []) emitGeometry(geometry, new Map(), undefined, IDENTITY);
  }
  if (parts.length === 0) throw new Error('This Collada file has no meshes.');
  return { kind: 'model', parts, used: parts.flatMap((p) => (p.image ? [p.image.name] : [])) };
}

/** A file reference with its `%20` and the like read; one with a `%` that escapes nothing is taken as it is. */
function unescaped(reference: string): string {
  try {
    return decodeURIComponent(reference);
  } catch {
    return reference;
  }
}

/** A node's own transform: its transformation elements, applied in the order written. */
function localMatrix(node: XmlElement): Mat {
  let m = IDENTITY;
  for (const e of node.children) {
    const kind = localName(e.name);
    const v = kind === 'matrix' || kind === 'translate' || kind === 'rotate' || kind === 'scale' ? e.text.trim().split(/\s+/).map(Number) : null;
    if (!v || v.some((x) => !Number.isFinite(x))) continue;
    let t: Mat | null = null;
    if (kind === 'matrix' && v.length === 16) t = [v[0], v[4], v[8], v[1], v[5], v[9], v[2], v[6], v[10], v[3], v[7], v[11]];
    else if (kind === 'translate' && v.length === 3) t = [1, 0, 0, 0, 1, 0, 0, 0, 1, v[0], v[1], v[2]];
    else if (kind === 'scale' && v.length === 3) t = [v[0], 0, 0, 0, v[1], 0, 0, 0, v[2], 0, 0, 0];
    else if (kind === 'rotate' && v.length === 4) t = axisAngle(v[0], v[1], v[2], (v[3] * Math.PI) / 180);
    if (t) m = multiply(m, t);
  }
  return m;
}

/** A turn of `angle` radians about the axis (x, y, z). */
function axisAngle(x: number, y: number, z: number, angle: number): Mat {
  const n = Math.hypot(x, y, z);
  if (n === 0) return IDENTITY;
  x /= n;
  y /= n;
  z /= n;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const k = 1 - c;
  // Columns: the images of X, Y and Z.
  return [c + x * x * k, y * x * k + z * s, z * x * k - y * s, x * y * k - z * s, c + y * y * k, z * y * k + x * s, x * z * k + y * s, y * z * k - x * s, c + z * z * k, 0, 0, 0];
}
