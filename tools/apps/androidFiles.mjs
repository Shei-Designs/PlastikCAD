// Small models for the Android app to be handed, written into the folder given: a cube as text STL and a cube
// with a color at each corner as PLY.
import { writeFileSync } from 'node:fs';

const dir = process.argv[2];
const corners = [[0, 0, 0], [20, 0, 0], [20, 20, 0], [0, 20, 0], [0, 0, 20], [20, 0, 20], [20, 20, 20], [0, 20, 20]];
const sides = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];

const facets = sides.flatMap(([a, b, c, d]) => [[a, b, c], [a, c, d]]).map((t) => `facet normal 0 0 0\n outer loop\n${t.map((i) => `  vertex ${corners[i].join(' ')}`).join('\n')}\n endloop\nendfacet`);
writeFileSync(`${dir}/cube.stl`, `solid cube\n${facets.join('\n')}\nendsolid cube\n`);

const head = ['ply', 'format ascii 1.0', 'element vertex 8', 'property float x', 'property float y', 'property float z', 'property uchar red', 'property uchar green', 'property uchar blue', 'element face 6', 'property list uchar int vertex_indices', 'end_header'];
const points = corners.map(([x, y, z]) => `${x} ${y} ${z} ${x ? 255 : 0} ${y ? 255 : 0} ${z ? 255 : 0}`);
writeFileSync(`${dir}/corners.ply`, [...head, ...points, ...sides.map((s) => `4 ${s.join(' ')}`), ''].join('\n'));
