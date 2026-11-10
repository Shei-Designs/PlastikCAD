import { describe, expect, it } from 'vitest';
import { parseCollada } from './importCollada';
import { fileKind, importFile } from './import';

const encode = (text: string) => new TextEncoder().encode(text);

/** A Y-up file in centimeters: a 10-unit cube as a polylist lifted 20 up, and a red 4-unit tile as triangles with texture coordinates, turned 90° about Y through a library node. */
const SCENE = `<?xml version="1.0" encoding="utf-8"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
  <asset><unit name="centimeter" meter="0.01"/><up_axis>Y_UP</up_axis></asset>
  <library_effects>
    <effect id="Red-effect"><profile_COMMON><technique sid="common"><lambert>
      <diffuse><color sid="diffuse">1 0 0 1</color></diffuse>
    </lambert></technique></profile_COMMON></effect>
  </library_effects>
  <library_materials><material id="Red" name="Red"><instance_effect url="#Red-effect"/></material></library_materials>
  <library_geometries>
    <geometry id="cube" name="Cube"><mesh>
      <source id="cube-pos"><float_array id="cube-pos-array" count="24">0 0 0 10 0 0 10 10 0 0 10 0 0 0 10 10 0 10 10 10 10 0 10 10</float_array>
        <technique_common><accessor source="#cube-pos-array" count="8" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source>
      <source id="cube-nrm"><float_array id="cube-nrm-array" count="3">0 0 1</float_array>
        <technique_common><accessor source="#cube-nrm-array" count="1" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source>
      <vertices id="cube-vtx"><input semantic="POSITION" source="#cube-pos"/></vertices>
      <polylist count="6">
        <input semantic="VERTEX" source="#cube-vtx" offset="0"/><input semantic="NORMAL" source="#cube-nrm" offset="1"/>
        <vcount>4 4 4 4 4 4</vcount>
        <p>0 0 3 0 2 0 1 0  4 0 5 0 6 0 7 0  0 0 1 0 5 0 4 0  1 0 2 0 6 0 5 0  2 0 3 0 7 0 6 0  3 0 0 0 4 0 7 0</p>
      </polylist>
    </mesh></geometry>
    <geometry id="tile" name="Tile"><mesh>
      <source id="tile-pos"><float_array id="tile-pos-array" count="12">0 0 0 4 0 0 4 0 4 0 0 4</float_array>
        <technique_common><accessor source="#tile-pos-array" count="4" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source>
      <source id="tile-uv"><float_array id="tile-uv-array" count="8">0 0 1 0 1 1 0 1</float_array>
        <technique_common><accessor source="#tile-uv-array" count="4" stride="2"><param name="S" type="float"/><param name="T" type="float"/></accessor></technique_common></source>
      <vertices id="tile-vtx"><input semantic="POSITION" source="#tile-pos"/></vertices>
      <triangles count="2" material="mat">
        <input semantic="VERTEX" source="#tile-vtx" offset="0"/><input semantic="TEXCOORD" source="#tile-uv" offset="1" set="0"/>
        <p>0 0 1 1 2 2  0 0 2 2 3 3</p>
      </triangles>
    </mesh></geometry>
  </library_geometries>
  <library_nodes>
    <node id="tileNode"><instance_geometry url="#tile"><bind_material><technique_common><instance_material symbol="mat" target="#Red"/></technique_common></bind_material></instance_geometry></node>
  </library_nodes>
  <library_visual_scenes><visual_scene id="Scene">
    <node id="box" name="Box"><translate>0 20 0</translate><instance_geometry url="#cube"/></node>
    <node id="tiles" name="Tiles"><rotate>0 1 0 90</rotate><instance_node url="#tileNode"/></node>
  </visual_scene></library_visual_scenes>
  <scene><instance_visual_scene url="#Scene"/></scene>
</COLLADA>`;

const bounds = (p: Float32Array) => {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], p[i + k]);
      max[k] = Math.max(max[k], p[i + k]);
    }
  return { min: min.map((v) => Math.round(v * 1000) / 1000 || 0), max: max.map((v) => Math.round(v * 1000) / 1000 || 0) };
};

describe('parseCollada', () => {
  it('places the scene Z up in millimeters, by unit and up axis, with colors and texture coordinates', () => {
    const model = parseCollada(encode(SCENE), 'scene');
    expect(model.parts.map((p) => p.name)).toEqual(['Box', 'tileNode']);
    const [box, tile] = model.parts;
    // The cube, lifted 20 up in a Y-up file: its Y becomes Z, its Z becomes -Y; centimeters become millimeters.
    expect(box.mesh.positions.length).toBe(8 * 3);
    expect(box.mesh.triangles.length).toBe(12 * 3);
    expect(bounds(box.mesh.positions)).toEqual({ min: [0, -100, 200], max: [100, 0, 300] });
    expect(box.color).toBeUndefined();
    // The tile, turned 90° about Y then laid Z up: a 40 mm square on the floor, red.
    expect(tile.mesh.triangles.length).toBe(2 * 3);
    expect(bounds(tile.mesh.positions)).toEqual({ min: [0, 0, 0], max: [40, 40, 0] });
    expect(tile.color).toBe('#ff0000');
    expect(Array.from(tile.mesh.uv!)).toEqual([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]);
  });

  it('is found by its extension or its root element and imports like any model', () => {
    expect(fileKind('robot.dae', encode(SCENE))).toBe('dae');
    expect(fileKind('robot', encode(SCENE))).toBe('dae');
    const imported = importFile('robot.dae', encode(SCENE));
    expect(imported.kind).toBe('model');
    if (imported.kind === 'model') expect(imported.parts.length).toBe(2);
  });

  it('reads geometries with no scene where they stand, and refuses what is not Collada', () => {
    const bare = SCENE.replace(/<library_nodes>[\s\S]*<\/scene>/, '');
    const model = parseCollada(encode(bare));
    expect(model.parts.map((p) => p.name)).toEqual(['Cube', 'Tile']);
    expect(bounds(model.parts[0].mesh.positions)).toEqual({ min: [0, -100, 0], max: [100, 0, 100] });
    expect(() => parseCollada(encode('<svg/>'))).toThrow(/not a Collada file/);
    expect(() => parseCollada(encode(SCENE.replace(/<library_geometries>[\s\S]*<\/library_geometries>/, '')))).toThrow(/no meshes/);
  });

  it('turns a mirrored node inside out so its faces still point outward', () => {
    const mirrored = SCENE.replace('<translate>0 20 0</translate>', '<scale>-1 1 1</scale>');
    const [box] = parseCollada(encode(mirrored)).parts;
    expect(bounds(box.mesh.positions)).toEqual({ min: [-100, -100, 0], max: [0, 0, 100] });
    // The cube's first face is wound as the file wrote it, read back through the flipped corners: the signed volume stays positive.
    const p = box.mesh.positions;
    const t = box.mesh.triangles;
    let volume = 0;
    for (let i = 0; i < t.length; i += 3) {
      const [a, b, c] = [t[i] * 3, t[i + 1] * 3, t[i + 2] * 3];
      volume += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6;
    }
    expect(Math.abs(volume)).toBeCloseTo(100 * 100 * 100, 0);
  });

  it('cuts a polygon that is not convex into triangles that stay inside it', () => {
    // An L of area 3 m², listed from the corner next to its notch, with texture coordinates that follow the corners.
    const model = parseCollada(encode(flat('<polylist count="1"><input semantic="VERTEX" source="#v" offset="0"/><input semantic="TEXCOORD" source="#uv" offset="1"/><vcount>6</vcount><p>2 2 3 3 4 4 5 5 0 0 1 1</p></polylist>')));
    const { positions: p, triangles: t, uv } = model.parts[0].mesh;
    expect(t.length).toBe(4 * 3);
    let total = 0;
    for (let i = 0; i < t.length; i += 3) {
      const [a, b, c] = [t[i] * 3, t[i + 1] * 3, t[i + 2] * 3];
      const area = ((p[b] - p[a]) * (p[c + 1] - p[a + 1]) - (p[c] - p[a]) * (p[b + 1] - p[a + 1])) / 2;
      expect(area).toBeGreaterThan(0);
      total += area;
      // Each corner still carries the texture coordinate written for it: here, its own position in meters.
      for (const [k, v] of [a, b, c].entries()) expect([uv![(i + k) * 2] * 1000, uv![(i + k) * 2 + 1] * 1000]).toEqual([p[v], p[v + 1]]);
    }
    expect(total).toBeCloseTo(3e6, 0);
  });
});

describe('a Collada file that is not as it should be', () => {
  const textured = (image: string) =>
    `<COLLADA><asset><up_axis>Z_UP</up_axis></asset><library_images><image id="i"><init_from>${image}</init_from></image></library_images><library_effects><effect id="e"><profile_COMMON><technique><lambert><diffuse><texture texture="i"/></diffuse></lambert></technique></profile_COMMON></effect></library_effects><library_materials><material id="m"><instance_effect url="#e"/></material></library_materials><library_geometries><geometry id="g"><mesh><source id="p"><float_array>0 0 0 1 0 0 0 1 0</float_array><technique_common><accessor stride="3"/></technique_common></source><vertices id="v"><input semantic="POSITION" source="#p"/></vertices><triangles material="m"><input semantic="VERTEX" source="#v" offset="0"/><p>0 1 2</p></triangles></mesh></geometry></library_geometries></COLLADA>`;
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

  it('finds a picture whose name has a percent sign in it, escaped or not', () => {
    const plain = parseCollada(encode(textured('100%_wood.png')), 'a', [{ name: '100%_wood.png', bytes: png }]);
    expect(plain.parts[0].image?.name).toBe('100%_wood.png');
    const escaped = parseCollada(encode(textured('file:///tmp/my%20wood.png')), 'a', [{ name: 'my wood.png', bytes: png }]);
    expect(escaped.parts[0].image?.name).toBe('my wood.png');
  });

  it('refuses a file nested deeper than any drawing is, without falling over', () => {
    const deep = `<COLLADA>${'<a>'.repeat(200_000)}${'</a>'.repeat(200_000)}</COLLADA>`;
    expect(() => importFile('a.dae', encode(deep))).toThrow(/nested too deeply/);
  });
});

/** A Z-up file in meters with one flat geometry: an L-shaped outline of six corners, and texture coordinates equal to their positions. */
const flat = (primitive: string) => `<COLLADA><asset><up_axis>Z_UP</up_axis></asset><library_geometries><geometry id="g"><mesh>
  <source id="p"><float_array>0 0 0 2 0 0 2 1 0 1 1 0 1 2 0 0 2 0</float_array><technique_common><accessor stride="3"/></technique_common></source>
  <source id="uv"><float_array>0 0 2 0 2 1 1 1 1 2 0 2</float_array><technique_common><accessor stride="2"/></technique_common></source>
  <vertices id="v"><input semantic="POSITION" source="#p"/></vertices>${primitive}</mesh></geometry></library_geometries></COLLADA>`;
