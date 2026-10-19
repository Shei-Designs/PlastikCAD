# Code, Security, and Quality Audit Report: Quick_CAD (PlastikCAD)

**Audit Date:** October 2026  
**Audited Target:** `Quick_CAD` (`PlastikCAD`) desktop & web 3D CAD application  
**Codebase Size:** ~24,077 lines of TypeScript/React/Three.js/WASM and Rust/Tauri v2  
**Test Suite Status:** 23 test suites, 389 unit tests passing (Vitest); 0 Rust tests  
**Overall Code Quality:** Solid modern TypeScript, strict typing, clean modular structure; however, several critical vulnerabilities, denial-of-service vectors, state desynchronizations, and WebGL/WASM memory leaks were identified across the Tauri backend, geometry worker, state manager, and 3D viewers.

---

## Table of Contents
1. [Executive Summary](#1-executive-summary)
2. [Severity & Subsystem Matrix](#2-severity--subsystem-matrix)
3. [Critical Severity Findings](#3-critical-severity-findings)
4. [High Severity Findings](#4-high-severity-findings)
5. [Medium Severity Findings](#5-medium-severity-findings)
6. [Low Severity Findings](#6-low-severity-findings)
7. [Architectural, Memory & Test Coverage Gaps](#7-architectural-memory--test-coverage-gaps)
8. [Prioritized Remediation Roadmap](#8-prioritized-remediation-roadmap)

---

## 1. Executive Summary

Quick_CAD is a modern browser- and desktop-based (Tauri v2) solid-modeling CAD application built on top of Manifold-3D (WASM), Three.js, React 19, and Vite. It supports parametric primitives, standard mechanical parts (gears, motors, ducts, fans, fasteners), 2D/3D boolean CSG operations, text engraving, image sticker projection, version history, and multi-format import/export (STL, OBJ, 3MF, SVG, DXF, GLB).

While the application features well-structured idiomatic TypeScript, functional decomposition, and robust vector math foundations, the audit uncovered **51 distinct findings** spanning:
- **Host Security:** Completely disabled Content Security Policy (`"csp": null`) combined with unrestricted, un-sandboxed filesystem write/read IPC endpoints accessible to the webview.
- **Denial of Service (DoS):** Infinite loops and OOM crashes in SVG elliptical arc parsing, unmetered synchronous 3MF decompression (zip bombs), exponential component DAG ("billion laughs") expansion, and call stack overflows in ASCII number parsing.
- **State & Data Loss:** Leaked gesture states during alignment dot hovers that permanently silence undo recording and revert user work, destructive ungrouping/editing of mixed solid/hole groups that flips inner holes into solids, and intra-process race conditions in Tauri's atomic file save.
- **3D Kernel & Geometric Stability:** Detached `ArrayBuffer` transfer corrupting the worker LRU cache on open mesh export, inverted surface normals on all mirrored objects in GLB exports, unhandled C++ exceptions in Manifold constructors leaking WASM heap memory, and degenerate mesh crashes in duct and gear generators.
- **Resource Management:** Texture canvas allocations and GPU re-uploads at 60 Hz during resize gestures, unreclaimed `ImageBitmap`s and fonts in worker and viewer caches, and uncaught async rejections that permanently freeze export panels.

---

## 2. Severity & Subsystem Matrix

| Severity | Security | Bug / Logic Error | Memory / Resource Leak | Architectural / Gap | Total |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Critical** | 3 | 2 | 0 | 0 | **5** |
| **High** | 2 | 9 | 4 | 3 | **18** |
| **Medium** | 3 | 11 | 4 | 3 | **21** |
| **Low** | 0 | 5 | 1 | 0 | **6** |
| **Gaps** | 0 | 0 | 0 | 1 | **1** |
| **Total** | **8** | **27** | **9** | **7** | **51** |

### Breakdown by Subsystem

- **Tauri Backend & Platform (`src-tauri/*`, `src/platform.ts`):** 6 findings (Arbitrary FS IPC, Null CSP, temp-file race in `write_atomic`, blocking I/O on Tokio executor, CLI startup path validation, window close bypass).
- **File Import / Export & Parsers (`src/io/*`):** 13 findings (SVG arc infinite loop, 3MF zip bomb / DAG bomb, OBJ BOM / line continuations, STL binary misidentification, GLB mirrored normal inversion, number parser stack overflow, scientific notation truncation in `fmt`, 3MF namespace & unit bugs).
- **Data Model & Schema (`src/model/*`):** 5 findings (Prototype pollution in legacy part migration and asset tables, unbounded group nesting recursion, torus ring parameter loss on ungroup, geometry cache key invalidation on natural bounds changes, division by zero in `localScale`).
- **Worker & Geometry Kernel (`src/worker/*`, `src/geometry/*`):** 9 findings (Detached buffer cache corruption, worker asset memory leak, Manifold constructor WASM leak, CrossSection vector leak, duct self-intersections, cylinder hull collapse, multi-sticker UV bleed, non-finite vertex propagation, unhandled worker termination).
- **Parametric Parts (`src/parts/*`):** 6 findings (Motor zero/negative shaft height crash, helical rack / bevel gear self-intersecting tooth loops, `invInverse` NaN on zero profile shift, bevel gear height and screw orientation, fan hole overlap, worm wheel parameter clipping).
- **State Management & History (`src/state/*`):** 7 findings (Align preview gesture leak, group dissolve / hole conversion bug, array preview baseline corruption, `editInside` undo desync and child loss, mating gear async race condition, `GeometryStore.ready()` hang, GLB export async hang on image decode failure).
- **Viewer & UI (`src/viewer/*`, `src/ui/*`, `src/App.tsx`):** 5 findings (60 Hz `CanvasTexture` GPU re-allocations during resize, multi-pointer gesture conflicts, input field focus / keyboard shortcut collisions, tree view highlight leak, inspector minimum grid clipping).

---

## 3. Critical Severity Findings

### [CRIT-01] Infinite Loop & OOM Crash in SVG Elliptical Arc Flattening
- **File & Lines:** `src/io/importSvg.ts:615, 632-652`
- **Category:** Security / Bug (Denial of Service & Process Crash)
- **Description:**  
  In `arcPoints(x0, y0, rx, ry, phi, fa, fs, x1, y1)`:
  1. If `(x0, y0)` and `(x1, y1)` are distinct floating-point numbers (`x0 === x1 && y0 === y1` is `false` on line 615) but very close relative to `rx, ry` (e.g. `<path d="M 0 0 A 1 1 0 1 1 2e-17 2e-17"/>` or `<path d="M 0 0 A 1e16 1e16 0 0 1 1 0"/>`), `Math.atan2((-py - cyp) / ry, (-px - cxp) / rx)` evaluates identically to `start`.
  2. Because `fa === 0`, `delta` remains `0`.
  3. `step = delta / n = 0 / n = 0`.
  4. When `start > 0`, `first = Math.ceil(start / 0) = +Infinity` and `last = Math.floor(end / 0) = +Infinity`.
  5. The loop `for (let i = first; i <= last; i++)` evaluates `Infinity <= Infinity` (`true`) and `Infinity + 1 === Infinity`. The loop runs forever, appending `[NaN, NaN]` to `out` until the JavaScript heap is exhausted and the browser tab or Tauri webview crashes with Out of Memory.
  6. Furthermore, on line 633:
     ```ts
     const sq = Math.sqrt(Math.max(0, (rx2 * ry2 - num) / den));
     ```
     `den = rx2 * y1p2 + ry2 * x1p2` underflows to `0` when `|x1 - x0| < 1e-162`, producing `Infinity` and `NaN` coordinates.
- **Failure / Attack Scenario:**  
  Opening an SVG file containing a tiny or degenerate arc (common in SVGs exported by CAD tools or maliciously crafted) freezes the main thread and crashes the entire application with data loss.
- **Remediation:**  
  Validate that `den > 0`, `Math.abs(delta) > 1e-12`, and `Number.isFinite(step) && step !== 0` before entering the loop:
  ```ts
  if (den <= 1e-18 || Math.abs(delta) < 1e-9 || !Number.isFinite(step) || step === 0) {
    return [[x1, y1]];
  }
  ```

---

### [CRIT-02] 3MF Zip Bomb & Exponential Component DAG ("Billion Laughs") Denial of Service
- **File & Lines:** `src/io/import3mf.ts:20, 56, 88-115`
- **Category:** Security / Bug (Denial of Service & Memory Exhaustion)
- **Description:**  
  The 3MF importer exhibits two independent unbounded expansion vulnerabilities:
  1. **Unchecked Zip Decompression:** Line 20 calls `unzipSync(bytes, { filter: ... })` from `fflate`. The filter only inspects the filename without checking `f.originalSize` or maintaining a running sum of uncompressed bytes across files. A 50 KB nested/compressed `.3mf` archive expanding to tens of gigabytes decompresses synchronously on the main thread, freezing and crashing the process.
  2. **Exponential Component DAG ("Billion Laughs"):** In `emit(ref, world, depth)` (lines 88-115), recursion depth is capped by `if (depth > MAX_DEPTH) return;` (`MAX_DEPTH = 16`). However, depth alone does not bound tree expansion. A 3MF file can define 16 objects where object $k$ references object $k+1$ ten times via `<component objectid="..." />`. At depth 16, this evaluates to $10^{16}$ recursive calls and emitted triangles from a 4 KB 3MF file.
- **Failure / Attack Scenario:**  
  A user loads a benign-looking 10 KB `.3mf` downloaded from a repository. The UI locks up completely, CPU pegs at 100%, and the system OOM-killer terminates the process.
- **Remediation:**  
  1. Enforce a cumulative decompressed byte budget in `unzipSync` (e.g. max 256 MB total across all entries).
  2. Track total emitted triangles/vertices across the entire `parse3mf()` invocation (e.g. abort if total triangles exceed `5_000_000` or total components visited exceed `50_000`).

---

### [CRIT-03] Disabled Content Security Policy Combined with Unrestricted Arbitrary File Read/Write IPC Commands
- **File & Lines:** `src-tauri/tauri.conf.json:23-25`, `src-tauri/src/lib.rs:73-105`, `src-tauri/capabilities/default.json:7`
- **Category:** Security (Privilege Escalation / Arbitrary File System Access)
- **Description:**  
  In `src-tauri/tauri.conf.json`:
  ```json
  "security": {
    "csp": null
  }
  ```
  This explicitly disables CSP in the webview. Concurrently, `src-tauri/src/lib.rs` exposes custom IPC commands `read_file` and `write_file`, granted indiscriminately to all windows via `core:default` permission:
  ```rust
  #[tauri::command]
  async fn read_file(path: String) -> Result<Vec<u8>, String> {
      fs::read(&path).map_err(|e| e.to_string())
  }

  #[tauri::command]
  async fn write_file(path: String, bytes: Vec<u8>) -> Result<(), String> {
      write_atomic(Path::new(&path), &bytes).map_err(|e| e.to_string())
  }
  ```
  Neither command verifies that `path` was selected via an approved file dialog, is within the workspace/app directory, or possesses an allowed file extension (`.plastikcad`, `.stl`, `.obj`, etc.). Any Cross-Site Scripting (XSS), malicious dependency in `node_modules`, or compromised local dev server can invoke `invoke('read_file', { path: '/home/user/.ssh/id_rsa' })` or overwrite executable scripts (`~/.bashrc`, `~/.profile`) for immediate Remote Code Execution (RCE).
- **Remediation:**  
  1. Enable a strict CSP in `tauri.conf.json`:
     ```json
     "csp": "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost"
     ```
  2. Implement a path whitelist or token capability in Rust state: only allow reading/writing paths explicitly returned by `tauri_plugin_dialog` or approved via startup CLI arguments. Deny writing to hidden dotfiles or system directories.

---

### [CRIT-04] Align Mode Hover Preview Leaks `gesture`, Permanently Disabling Undo Recording and Wiping Out Subsequent Edits
- **File & Lines:** `src/state/store.ts:130-138, 190, 204-222, 822-827, 850-861, 1066`, `src/viewer/Viewer.ts:1033-1046, 1781-1790`
- **Category:** Bug / Logic Error (State Corruption & Data Loss)
- **Description:**  
  Hovering over an alignment dot in the 3D viewport invokes `previewAlign(axis, mode)` (`store.ts:850-861`), which opens a global editor `gesture` via `beginGesture()`.
  1. If the user moves the pointer away, `previewAlign(null, 'center')` calls `endGesture(true)`, cleanly cancelling the preview.
  2. However, if while the dot is hovered, the user triggers an action that changes selection or UI mode (e.g. pressing `Delete`, `Ctrl+D` duplicate, `Ctrl+A`, `Ctrl+G`, or clicking "Edit here" on a group via `editInside()`), `set()` (`store.ts:133`) sets `state.aligning = null` **without calling `endGesture(true)`**.
  3. `Viewer.clearHandles()` (`Viewer.ts:1043`) sets `this.hovered = null` without firing `onAlignHover(null, 'center')`.
  4. Consequently, `gesture` remains non-null in module state.
  5. In `commit()` (`store.ts:190`):
     ```ts
     if (!gesture) {
       history.past.push({ scene: cloneScene(base.scene), selected: [...base.selected] });
       history.future.length = 0;
     }
     ```
     Because `gesture` is permanently stuck, **no undo steps are ever recorded for any subsequent edits in the session**.
  6. Even worse: the next time the user drags any transform handle in the viewport and releases or cancels with `Escape` (`endGesture(true)`), `base.scene` is restored back to the old alignment hover preview, wiping out hours of user edits.
- **Remediation:**  
  Whenever `state.aligning` transitions from non-null to `null` in `set()`, `editInside()`, or `adopt()`, check if an alignment gesture is open and immediately abort it (`endGesture(true)`). In `Viewer.clearHandles()`, if `this.hovered?.kind.type === 'align'`, invoke `this.options.onAlignHover(null, 'center')`.

---

### [CRIT-05] Editing Inside or Ungrouping a Mixed Solid+Hole Group Converts All Inner Holes into Solids
- **File & Lines:** `src/state/store.ts:994-1005, 1036-1041, 1086-1087`, `src/model/ops.ts:348-351`
- **Category:** Bug / Logic Error (Geometry Data Corruption)
- **Description:**  
  In `dissolve()` (`ops.ts:350`) and `ungroupSelected()` (`store.ts:1038`), when an outer group has `hole: true`:
  ```ts
  if (group.hole) {
    for (const child of children) child.hole = true;
  }
  ```
  Every child node is unconditionally overwritten with `hole: true` (in `dissolve()`, even `PictureNode` children have their `hole` field flipped).
  When the user edits inside a group using `editInside()` (`store.ts:1066`), the group is dissolved into the main scene while marked as active editing.
  When the user finishes editing via `finishEditing()` (`store.ts:1086-1087`), the nodes are rebuilt into a group using `buildGroup()`, which invokes `holeGroup(nodes)` (`store.ts:994-1005`):
  ```ts
  function holeGroup(nodes: SceneNode[]): { hole: boolean; nodes: SceneNode[] } {
    if (nodes.length > 0 && nodes.every((n) => n.hole)) {
      return { hole: true, nodes: nodes.map((n) => ({ ...n, hole: false })) };
    }
    return { hole: false, nodes };
  }
  ```
  Because `dissolve` forced `child.hole = true` on every child, `nodes.every((n) => n.hole)` evaluates to `true`! The function marks the outer group as `hole: true` and flips **every inner child to `hole: false` (solid)**!
  Any internal subtractive shapes (cylinder hole cutters, interior voids, countersinks) are permanently transformed into additive solids. The geometry is ruined.
- **Remediation:**  
  1. Only propagate `group.hole` to children upon dissolution if the group was homogeneous (all children were solid). Never mutate `child.hole` if children already have heterogeneous solid/hole roles.
  2. Never assign `hole: true` to `PictureNode`.
  3. In `finishEditing()`, preserve the individual `.hole` flags of each member child and restore the group's top-level `hole: layer.hole` explicitly via object spread.

---

## 4. High Severity Findings

### [HIGH-01] Intra-Process Temp-File Race Condition in Tauri `write_atomic`
- **File & Lines:** `src-tauri/src/lib.rs:46-71`, `src/state/store.ts:1442`
- **Category:** Bug / Race Condition & Data Corruption
- **Description:**  
  `write_atomic` constructs temporary filenames using only the process ID:
  ```rust
  let tmp = target.with_file_name(format!(".{}.{}.tmp", name, std::process::id()));
  ```
  Because `write_file` is an `async fn` called on Tokio worker threads, two concurrent writes to the same destination file share the identical temporary filename.
  For instance, when `saveVersion()` runs, line 1442 fires an unawaited `void saveDesign()`. If the user simultaneously presses `Ctrl+S`, two async invocations of `write_file` run concurrently:
  - Writer A creates `.design.plastikcad.12345.tmp` and begins writing.
  - Writer B opens `.design.plastikcad.12345.tmp` with `File::create`, truncating Writer A's file mid-stream.
  - Writer A's write finishes or fails, and Writer A renames the truncated temp file over the real design file.
  Furthermore, `File::create` does not use `create_new(true)` (`O_EXCL`), and the cleanup handler `if result.is_err() { let _ = fs::remove_file(&tmp); }` deletes the temp file even if `create` failed because another thread owned it.
- **Remediation:**  
  Use a process-wide `AtomicU64` counter or UUID in the temp filename, open with `OpenOptions::new().write(true).create_new(true)`, and only remove the temp file if creation succeeded.

---

### [HIGH-02] Detached `ArrayBuffer` Cache Corruption in Worker When Exporting Open Meshes
- **File & Lines:** `src/worker/geometry.worker.ts:32-39`, `src/geometry/kernel.ts:181-188, 385-386, 478, 501`, `src/state/glbExport.ts:33`
- **Category:** Bug / Memory Corruption & Process Crash
- **Description:**  
  When `exportNodes` is invoked with `local: true` for an open, non-watertight `ImportNode` (which `exportGlb` in `glbExport.ts:33` does for every node), `exportAt` (`kernel.ts:478`) retrieves the cached `entry.open` and pushes it directly into `parts`.
  `concatenate(parts)` (`kernel.ts:386`) returns `parts[0]` (`entry.open`) without copying.
  `geometry.worker.ts:34-37` transfers the result buffers:
  ```ts
  postMessage(response, [
    result.mesh.positions.buffer,
    result.mesh.triangles.buffer,
  ]);
  ```
  Transferring these buffers detaches the underlying `ArrayBuffer`s inside the worker's LRU `cache` (`kernel.ts:181-188`).
  Any subsequent export or second placement of this mesh throws an immediate unhandled exception:
  `DataCloneError: ArrayBuffer at index 0 is already detached`.
- **Remediation:**  
  In `kernel.ts:478`, explicitly clone `entry.open.positions` and `entry.open.triangles` before returning them when `local: true`:
  ```ts
  mesh: {
    positions: entry.open.positions.slice(),
    triangles: entry.open.triangles.slice(),
  }
  ```

---

### [HIGH-03] Inverted Vertex Normals on All Mirrored Objects in GLB Export
- **File & Lines:** `src/io/glb.ts:147-178`, `src/io/glb.test.ts:49-61`
- **Category:** Bug / 3D Export Corruption
- **Description:**  
  In `placed()` (`src/io/glb.ts:147-178`), vertex normals are transformed using the cofactor matrix `cof` of the object's transform matrix `o.matrix`.
  Mathematically: $\operatorname{cof}(M) = \det(M) \cdot (M^{-1})^T$.
  When an object is mirrored, its scale has an odd number of negative signs, so $\det(M) < 0$ (`flipped === true`).
  The cofactor matrix automatically reverses the sign of all normal vectors so they point **inward**.
  However, lines 173-175 also reverse triangle winding:
  ```ts
  if (flipped) {
    const t = triangles[i + 1];
    triangles[i + 1] = triangles[i + 2];
    triangles[i + 2] = t;
  }
  ```
  The faces point outward, but all vertex normals point inward.
  Every mirrored object exported to `.glb` renders pitch black, inverted, or inside-out in Blender, Three.js, Babylon.js, and 3D print slicers.
- **Remediation:**  
  Multiply the cofactor matrix (or each transformed normal vector) by `flipped ? -1 : 1` before normalizing in `src/io/glb.ts:165-167`.

---

### [HIGH-04] Infinite Hang in `exportGlb` When Any Image Asset Fails to Decode
- **File & Lines:** `src/viewer/skin.ts:40-46`, `src/state/glbExport.ts:20-28`
- **Category:** Bug / Async Deadlock & Resource Leak
- **Description:**  
  In `SkinPainter.image()` (`src/viewer/skin.ts:40-46`):
  ```ts
  createImageBitmap(blob)
    .then((bmp) => {
      this.images.set(key, { state: 'ready', bmp });
      this.onReady();
    })
    .catch(() => {
      this.images.set(key, { state: 'failed' });
      // BUG: this.onReady() is NOT called!
    });
  ```
  In `exportGlb()` (`src/state/glbExport.ts:20-28`), the exporter waits for `onReady`:
  ```ts
  await new Promise<void>((resolve) => {
    wake = resolve;
  });
  ```
  If any image asset fails to decode (e.g. corrupt PNG/JPEG or unsupported format), `onReady` never fires. `exportGlb()` hangs indefinitely, never reaches the error check on line 61, leaks the painter, and leaves the UI modal permanently frozen on `"Exporting…"`.
- **Remediation:**  
  Call `this.onReady()` inside the `.catch()` handler in `SkinPainter.image()`, and ensure `dispose()` wakes any pending promises with an error.

---

### [HIGH-05] Unbounded Memory Leak & Stale Asset Bug in `GeometryClient.syncAssets` and `SkinPainter`
- **File & Lines:** `src/worker/client.ts:17, 30-41`, `src/geometry/kernel.ts:37-50`, `src/viewer/skin.ts:19, 30-48`
- **Category:** Bug / Memory Leak & Geometry Stale Data
- **Description:**  
  1. **Stale Asset Bug:** `GeometryClient.syncAssets` maintains `private sentAssets = new Set<string>()`. It only checks if `key` exists in the set. If a user opens a different project or replaces an asset where the key is identical (or asset data was mutated under the same key), `client.ts` skips sending the updated bytes. The worker continues rendering the old asset.
  2. **Unbounded Leak:** Neither `sentAssets`, the worker's `assets` `Map`, nor `SkinPainter.images` ever evicts assets when nodes are deleted, when fonts change, or when documents are closed. `ImageBitmap` objects in `SkinPainter` are never closed with `bmp.close()`, causing GPU texture memory to leak indefinitely over long editing sessions.
- **Remediation:**  
  Track asset content hashes in `GeometryClient`. Implement an asset cleanup sweep during `adopt()` or garbage-collect unused assets by calling `bmp.close()` on unreferenced images.

---

### [HIGH-06] WASM Heap Memory Leak When `new k.Manifold(mesh)` Throws on Non-Manifold Meshes
- **File & Lines:** `src/geometry/kernel.ts:327-340`, `src/parts/evaluate.ts:138-146`, `src/geometry/shapes.ts:336-339`
- **Category:** Bug / WASM Memory Leak
- **Description:**  
  In `manifold-3d`, `new Module.Manifold(mesh)` allocates an underlying C++ `Manifold` object on the WASM heap. The wrapper checks `if (manifold.status() !== "NoError")` and immediately throws `ManifoldError` **without invoking `manifold.delete()`**.
  In `kernel.ts:333`:
  ```ts
  try {
    solid = new k.Manifold(mesh);
  } catch {
    solid?.delete(); // solid is null! C++ object leaked on WASM heap
  }
  ```
  Whenever an imported STL/OBJ/3MF mesh is non-manifold, or a parametric generator produces self-intersecting geometry, the C++ heap allocation leaks permanently inside the WebAssembly linear memory until the worker runs out of memory.
- **Remediation:**  
  Use the raw embind constructor prototype or wrap the allocation so that the pointer is captured and freed with `.delete()` before re-throwing or falling back to open mesh representation.

---

### [HIGH-07] Call Stack Overflow (`RangeError`) in `ByteReader.number()`
- **File & Lines:** `src/io/scan.ts:60-83, 108-112`
- **Category:** Security / Bug (Denial of Service)
- **Description:**  
  In `ByteReader.number()`, if a numeric token has `significant > 15` or exponent magnitude $> 22$, lines 108-112 execute:
  ```ts
  const s = String.fromCharCode.apply(
    null,
    b.subarray(start, i) as unknown as number[]
  );
  return Number(s);
  ```
  `Function.prototype.apply` places every element of the array slice onto the JavaScript execution stack as an argument.
  In V8 / JSC, passing an array longer than ~65,536 elements throws `RangeError: Maximum call stack size exceeded`.
  A crafted or corrupted ASCII STL, OBJ, or 3MF file with a long sequence of digits (or harmless numbers formatted with many leading/trailing zeros like `0.0000000000000000000000001`) immediately crashes the parser with an unhandled exception.
- **Remediation:**  
  Replace `String.fromCharCode.apply` with `new TextDecoder().decode(b.subarray(start, Math.min(i, start + 512)))`, and short-circuit zero values (`mantissa === 0`) directly without string conversion.

---

### [HIGH-08] Unhandled `TypeError` & Prototype Mutation via Unsanitized Dictionary Lookups
- **File & Lines:** `src/model/file.ts:169, 227-232`, `src/io/import3mf.ts:205`, `src/io/xml.ts:15, 112`
- **Category:** Security / Bug (Prototype Pollution & Unhandled Crash)
- **Description:**  
  Several lookup tables use plain object literals `{}` instead of `Object.create(null)` or `Map`:
  1. `src/model/file.ts:169`: `const renamed = RENAMED_PARTS[part];`. If a malicious or corrupted file contains `"part": "toString"`, `renamed` evaluates to `Object.prototype.toString`. Line 170 then calls `renamed.params(...)`, which throws `TypeError: renamed.params is not a function` instead of ignoring the unknown part.
  2. `src/io/import3mf.ts:205`: `model.unit = UNITS[scan.attrs().unit ?? 'millimeter'] ?? 1;`. If `unit="toString"`, `UNITS["toString"]` resolves to a function, corrupting `model.unit` with a function object and generating `NaN` across all vertices.
  3. `src/io/xml.ts:15`: `ENTITIES[name] ?? whole`. An entity named `&toString;` resolves to `"function toString() { [native code] }"`.
  4. `src/model/file.ts:227-232`: `out[key] = ...` on `const out: Record<string, Asset> = {}`. If `key === "__proto__"`, this mutates the prototype of `out` instead of creating an asset property.
- **Remediation:**  
  Use `Object.hasOwn()`, `Map`, or `Object.create(null)` for all parser lookup maps and sanitize object keys when deserializing assets.

---

### [HIGH-09] Array Preview Gesture Corruption & State Desync
- **File & Lines:** `src/state/store.ts:187-222, 902-943, 1115-1130, 1445-1449`, `src/ui/ArrayPanel.tsx`, `src/ui/Popover.tsx`
- **Category:** Bug / Undo-Redo & Scene Corruption
- **Description:**  
  `previewArray()` activates the global editor `gesture` (`beginGesture()`) for the entire duration that `ArrayPanel` is mounted.
  If the user uses keyboard shortcuts while `ArrayPanel` is open (`Ctrl+Z`, `Delete`, `Ctrl+D`, arrow keys), or starts a viewport navigation drag, the baseline `gesture.scene` is mutated or replaced while `ArrayPanel` is still active.
  Subsequent slider adjustments in `ArrayPanel` duplicate shapes exponentially or corrupt history steps.
  Furthermore, `adopt()` (`store.ts:1115`) and `viewVersion()` (`store.ts:1445`) do not call `cancelArray()`, allowing an active array preview from an old document to leak into a newly loaded project.
- **Remediation:**  
  Store the baseline scene locally inside `state.arraying` instead of holding the global drag `gesture` open, and ensure `cancelArray()` is called whenever a new file is loaded, a version is inspected, or an external edit occurs.

---

### [HIGH-10] `editInside` / `finishEditing` State Desync Across Undo/Redo and Persistence
- **File & Lines:** `src/state/store.ts:89-93, 156-159, 224-237, 1059-1111, 1183-1208, 1423-1458`
- **Category:** Bug / State Desynchronization & Data Loss
- **Description:**  
  1. **Undo History Omission:** The undo `Step` structure (`store.ts:89-93`) records `{ scene, selected }` but omits `editing`. Pressing `Ctrl+Z` immediately after `editInside()` restores the undissolved group in the scene while leaving the `"Editing inside…"` UI banner stuck. Pressing `Ctrl+Z` after `finishEditing()` dissolves the group in the scene while `editing` remains `null`, making it impossible to click "Done" to reassemble the group.
  2. **Child Dropping:** `finishEditing()` (`store.ts:1084`) regroups only `scene.filter((n) => layer.children.includes(n.id))`. Any new shape added, duplicated (`Ctrl+D`), or pasted while inside group edit mode is silently excluded from the group.
  3. **Save Corruption:** If the user saves (`Ctrl+S`) or session auto-save fires while inside `editInside`, the dissolved, ungrouped scene is persisted without the group hierarchy.
- **Remediation:**  
  Include `editing` state within undo/redo steps, treat newly created nodes inside the edit session as group children, and automatically commit `finishEditing()` before serialization or file save.

---

### [HIGH-11] Mating Gear Wizard Commits Stale or Missing Gear on Fast Accept
- **File & Lines:** `src/state/store.ts:504-593`, `src/ui/MatePanel.tsx:35, 51-55, 131-133`
- **Category:** Bug / Async Race Condition
- **Description:**  
  `MatePanel.tsx:35` binds its `"Accept"` button disable state to `useEditor((s) => s.busy !== null)`.
  However, `previewMate()` (`store.ts:524-559`) never sets `state.busy`; it only updates a private module-level boolean `mateBuilding`.
  When a user edits a tooth count in `NumberBox` and immediately clicks `"Accept"`, the `onBlur` event fires an asynchronous worker build, while `commitMate()` executes synchronously on `onClick`.
  `commitMate()` increments `mateBuilds++` (which cancels the in-flight build!) and commits either a stale prior gear or fails completely with missing geometry.
- **Remediation:**  
  Expose `mateBuilding` on `EditorState` (or await any pending `previewMate` promise inside `commitMate()`) and disable the "Accept" button until the build settles.

---

### [HIGH-12] `GeometryStore.ready()` Can Hang Indefinitely When Pending Entries Are Replaced
- **File & Lines:** `src/state/geometry.ts:77-83, 99-120, 156-160, 211, 218`
- **Category:** Bug / Async Deadlock
- **Description:**  
  In `GeometryStore.ready()`, callers await a promise that resolves when `!this.entries.get(key)`.
  However, `this.entries.delete(...)` (lines 79, 89, 211) does not notify `this.listeners`.
  When a pending build is superseded and deleted, `settle()` (`line 218: if (!this.entries.has(key)) return;`) exits early without notifying listeners.
  Any UI or export task awaiting `ready()` hangs indefinitely.
- **Remediation:**  
  Notify registered listeners whenever an entry is deleted, cancelled, or settled.

---

### [HIGH-13] Rectangular Duct `ring()` Emits Duplicate Vertices and Crashes Manifold with `Not manifold`
- **File & Lines:** `src/parts/generators/ducts.ts:27-55, 78-107, 110-119`
- **Category:** Bug / Degenerate Mesh & Kernel Crash
- **Description:**  
  In `ring(s, n, nc)` (`ducts.ts:33-50`), when `s.corner >= s.w / 2` or `s.corner >= s.h / 2`:
  Corner centers `cx = s.w / 2 - r` or `cy = s.h / 2 - r` become zero.
  Adjacent corner arc endpoints coincide, producing duplicate vertices in the contour.
  When `loft()` connects the stations and invokes `mesh.merge()`, zero-area degenerate triangles are created, causing `new k.Manifold(mesh)` to throw `ManifoldError: Not manifold`.
- **Remediation:**  
  Clamp `r <= Math.min(s.w, s.h) / 2 - 1e-4` or eliminate zero-length linear segments when corner radii meet at centerlines.

---

### [HIGH-14] Rounded `cylinder` Builder Collapses to Empty Hull or Distorts by 2×
- **File & Lines:** `src/geometry/shapes.ts:285, 385-413`
- **Category:** Bug / Mathematical & Runtime Crash
- **Description:**  
  `paramMax('cylinder', 'radius', size)` allows `radius = Math.min(size[0], size[1], size[2]) / 2`.
  When `size[0] === size[1] <= size[2]` and `radius = size[0] / 2` (e.g. standard `20×20×20` cylinder with `radius = 10`), semi-axes `a = 0` and `b = 0` on lines 392-393.
  `nx = b * Math.cos(t) = 0` and `ny = a * Math.sin(t) = 0` for all $t$.
  `len` evaluates to `0`, collapsing all generated points onto the vertical Z-axis `[0, 0, ±(lift + up)]`.
  The convex hull builder throws `Error: This shape is empty.`.
  When only one semi-axis is zero (e.g. `size = [10, 20, 30], radius = 5`), `ny = 0` everywhere, pinching the hull and distorting the shape by 2×.
- **Remediation:**  
  When `a === 0 || b === 0`, derive normal vectors from the full outer ellipse dimensions (`size[1] * cos(t)`, `size[0] * sin(t)`) rather than inner reduced radii.

---

### [HIGH-15] Multi-Sticker Atlas UV Bleeding & Single-Sticker-Per-Triangle Limit
- **File & Lines:** `src/geometry/uv.ts:80-124`, `src/geometry/skin.ts:55-76`
- **Category:** Bug / Rendering & Texture Bleed
- **Description:**  
  `layoutAtlas` packs multiple stickers vertically into a single texture atlas.
  When a sticker is smaller than the 3D triangle face it projects onto, triangle vertices have UV coordinates outside $[0, 1]$.
  When mapped into the sub-rectangle via `v0 + landing.uv[c][1] * (v1 - v0)`, out-of-range UV coordinates spill into neighboring stickers in the atlas, rendering corrupted stripes across models.
  Additionally, line 95 sets `taken[t] = 1`, limiting each triangle to exactly one sticker and silently discarding any subsequent stickers on that face.
- **Remediation:**  
  Subdivide host triangles to the exact $[0, 1]$ bounding box of each sticker or render stickers using multi-material passes.

---

### [HIGH-16] `invInverse` Returns `NaN` on Zero Involute and Diverges on Negative Shifts
- **File & Lines:** `src/parts/mates.ts:84-90, 117-126`
- **Category:** Bug / Mathematical Error & NaN Propagation
- **Description:**  
  In `src/parts/mates.ts:84-90`:
  ```ts
  function invInverse(value: number): number {
    let a = Math.cbrt(3 * value);
    for (let i = 0; i < 6; i++) {
      const diff = inv(a) - value;
      a -= diff / (Math.tan(a) ** 2);
    }
    return a;
  }
  ```
  When profile shift is zero or negative such that `value === 0`, `a = 0`.
  `(inv(0) - 0) / Math.tan(0)**2` evaluates `0 / 0 = NaN`.
  `NaN` propagates into `workingCenter` and `offset`, corrupting mating gear positioning.
- **Remediation:**  
  Add an immediate guard: `if (value <= 0) return 0;`.

---

### [HIGH-17] Motor Generator Produces Degenerate Solid (`NaN` Bounds) When `shaftLength <= pilot.h`
- **File & Lines:** `src/parts/generators/motors.ts:323, 429-433`, `src/parts/evaluate.ts:124-131`
- **Category:** Bug / Degenerate Geometry
- **Description:**  
  In `motors.ts:431`:
  ```ts
  const s = cs.extrude(shaftLen - (m.pilot?.h ?? 0));
  ```
  When a user sets `shaftLength` to a positive value smaller than or equal to the pilot boss height (e.g. `shaftLength = 2` on a `37d` motor where `pilot.h = 6`), `cs.extrude()` is called with a negative or zero height.
  This returns an `InvalidConstruction` Manifold with zero vertices, corrupting the union and resulting in `NaN` bounding boxes.
- **Remediation:**  
  Only extrude the shaft when `shaftLen > (m.pilot?.h ?? 0)` (or treat `shaftLength` as measured from the mounting face).

---

### [HIGH-18] Helical Rack & Bevel Gear Kernel Crash Under Small Module and Large Backlash
- **File & Lines:** `src/parts/generators/gears.ts:289-307, 398-405`, `src/parts/involute.ts:186-204, 295-324`, `src/parts/generators/bevel.ts:120-165`
- **Category:** Bug / Polygon Self-Intersection & Kernel Crash
- **Description:**  
  When `module` is small (`0.3` mm) and `backlash` is large (`1.0` mm):
  1. In `rackTopEdge` (`gears.ts:294`), `s = half(yRoot + rho) + rho / cosA` evaluates to a negative number (`-0.048` mm). The tooth points reverse order (`xc - s > xc + s`), forming a self-intersecting bow-tie polygon. For helical racks (`helixAngle !== 0`), `shearedPrism` triangulates this with `earcut` and crashes `new k.Manifold(mesh)` with `ManifoldError: Not manifold`.
  2. In `toothProfile` (`involute.ts:190`), negative half-angles are not rejected on the initial sample, producing self-intersecting bevel gear tooth outlines.
- **Remediation:**  
  Clamp `backlash <= 0.4 * Math.PI * module` and reject self-intersecting contour points in `toothProfile` and `rackTopEdge`.

---

## 5. Medium Severity Findings

- **[MED-01] `fmt()` Corrupts Scientific Notation Numbers (`|v| >= 1e21`):**  
  *Location:* `src/io/format.ts:2-6`  
  *Details:* `v.toFixed(decimals)` returns `"1.5e+30"`. Line 4 checks `s.includes('.')` (which is true) and applies `s.replace(/\.?0+$/, '')`. This strips trailing zeros from the **exponent**, turning `"1.5e+30"` into `"1.5e+3"` ($1.5 \times 10^{30}$ becomes $1500$).  
  *Fix:* Strip trailing zeros only before `'e'` or return scientific notation numbers unmodified.

- **[MED-02] Unbounded Recursion on Deeply Nested Groups in `.plastikcad` Files:**  
  *Location:* `src/model/file.ts:195-199`, `src/model/ops.ts`, `src/model/geomKey.ts`  
  *Details:* `readNode` recursively parses `GroupNode.children` without a depth limit. A file with ~1,500 nested groups overflows the JavaScript call stack.  
  *Fix:* Enforce a maximum hierarchy depth (e.g. `MAX_DEPTH = 32`).

- **[MED-03] Missing `'ring'` Parameter Scaling on `ungroup()`:**  
  *Location:* `src/model/ops.ts:240, 272-277`  
  *Details:* `MM_PARAMS = ['radius']` omits `'ring'` (the mm tube width of a torus) and `node.texture.scale`. Dissolving or ungrouping a scaled group leaves torus rings and textures unscaled.  
  *Fix:* Add `'ring'` and `texture.scale` to `MM_PARAMS` scaling.

- **[MED-04] Stale Geometry Cache Key (`placedKey`) When Child `natural` Bounds Change:**  
  *Location:* `src/model/geomKey.ts:65-68`  
  *Details:* `placedKey(node)` includes `node.size` but omits `node.natural`. `localScale(node)` divides by `natural` for groups, imports, and parts. Changes to natural bounds do not invalidate the placed cache key.  
  *Fix:* Include `node.natural` in `placedKey`.

- **[MED-05] Division by Zero / `NaN` in `localScale` When `importModels` Rounds Small Extents to `0`:**  
  *Location:* `src/state/store.ts:1237, 1246`, `src/model/math.ts:116-129, 156-160`  
  *Details:* `importModels` validates `natural.every((v) => v > 1e-6)` and then applies `tidyVec(natural)` (which rounds values $< 5 \times 10^{-5}$ to `0`). Dimensions in $(10^{-6}, 5 \times 10^{-5})$ become `0`, causing `0 / 0 = NaN` in `localScale`.  
  *Fix:* Clamp tidy bounds to a minimum of `1e-4`.

- **[MED-06] Legacy `tube` Migration Bugs in `readNode`:**  
  *Location:* `src/model/file.ts:126-142`  
  *Details:* Migrated `tube` nodes inherit `hidden`, `locked`, and `texture` across both `outer` and `inner` cylinders, and `wall`/`sides` are not validated for finiteness or clamped.  
  *Fix:* Pass migrated parameters through `clampParams` and omit textures from the inner hole cutter.

- **[MED-07] SVG Tag Stack Desynchronization on Void HTML Elements Inside `<foreignObject>`:**  
  *Location:* `src/io/importSvg.ts:68-95`  
  *Details:* `stack.pop()` does not match closing tag names. Void elements (`<br>`, `<img>`) inside `<foreignObject>` leave `skip: true` active after `</foreignObject>`, discarding all subsequent valid SVG elements.  
  *Fix:* Validate closing tag names before popping the stack.

- **[MED-08] 3MF XML Namespace Prefix Rejection & Sub-Model `unit` Ignored:**  
  *Location:* `src/io/import3mf.ts:116-117, 166-206`, `src/io/xml.ts:95-99`  
  *Details:* `scan.is('object')` rejects valid 3MF files using namespace prefixes (e.g. `<m:object>`), and sub-models in Production Extension archives have their local `unit` attributes ignored.  
  *Fix:* Match XML tag local names disregarding namespace prefixes and respect sub-model unit definitions.

- **[MED-09] Binary STL Misidentification & OBJ UTF-8 BOM Bug:**  
  *Location:* `src/io/importStl.ts:18-26`, `src/io/importObj.ts:41-78`  
  *Details:* Files with 80-byte headers containing `\0\0\0\0` at bytes 80..83 are misidentified as binary STLs. In OBJ imports, a leading UTF-8 BOM corrupts the first `v` line, shifting 1-based vertex indices.  
  *Fix:* Validate triangle count against file size and strip UTF-8 BOM (`0xFEFF`) before scanning.

- **[MED-10] Blocking Synchronous Filesystem I/O on Tokio Async Worker Threads:**  
  *Location:* `src-tauri/src/lib.rs:73-105`  
  *Details:* `read_file` and `write_file` execute blocking `std::fs::read` and `file.sync_all()` directly inside Tokio async worker threads without `spawn_blocking`, degrading async runtime throughput.  
  *Fix:* Use `tokio::fs` or wrap blocking calls in `tokio::task::spawn_blocking`.

- **[MED-11] `startup_file()` Accepts Non-`.plastikcad` Files and Repeats on Webview Reload:**  
  *Location:* `src-tauri/src/lib.rs:109-117`, `src/state/store.ts:1487-1498`  
  *Details:* Any command-line argument (including flags or `.stl` files) is treated as a startup file and reloaded on webview refresh, discarding unsaved in-memory changes.  
  *Fix:* Validate extension (`.plastikcad`) and consume the startup argument once.

- **[MED-12] Worker Crash Leaves `GeometryClient` Promises Hanging Forever:**  
  *Location:* `src/worker/client.ts:19-27, 60-73`, `src/worker/geometry.worker.ts:11, 45-55`  
  *Details:* `GeometryClient` lacks an `onerror` or `onmessageerror` handler that rejects pending request promises when the Web Worker crashes or fails to instantiate.  
  *Fix:* Reject all pending requests and transition client to an error state on worker failure.

- **[MED-13] `guardClose` Fails to Prevent Window Close if `confirm()` Dialog Rejects:**  
  *Location:* `src/platform.ts:185-208`  
  *Details:* In Tauri, if `confirm()` throws an error or rejects, `event.preventDefault()` is bypassed, allowing the window to close with unsaved edits.  
  *Fix:* Call `event.preventDefault()` synchronously before displaying the confirmation dialog.

- **[MED-14] WASM Memory Leak in `CrossSection.extrude()`, `revolve()`, and `toPolygons()`:**  
  *Location:* `src/parts/evaluate.ts:124-135`, `src/geometry/kernel.ts:234-235, 303, 496-498`  
  *Details:* The Manifold JS wrapper for `CrossSection` operations leaks internal C++ vector contours on the WASM heap during parametric part evaluations.  
  *Fix:* Explicitly delete intermediate vector instances.

- **[MED-15] Oval `torus` Builder Ignores `size[1]` for Ring Thickness and Closure:**  
  *Location:* `src/geometry/shapes.ts:286, 457-488`  
  *Details:* `BUILDERS.torus` calculates ring thickness solely from `size[0]`. When `size[1] < size[0]`, the central hole fails to close as intended.  
  *Fix:* Derive torus radius constraints from both $X$ and $Y$ semi-axes.

- **[MED-16] `bevelGear` Total Height Under-Reported & Inverted Set-Screw Angle:**  
  *Location:* `src/parts/generators/bevel.ts:171-191`, `src/parts/mates.ts:153, 163, 210-220`  
  *Details:* `bevelGear` calculates height from the root cone instead of tooth crests and applies a $180^\circ$ rotation around $X$ that mirrors set screw angle from $+90^\circ$ to $-90^\circ$. Rack pitch radius in `mates.ts` mistakenly incorporates profile shift.  
  *Fix:* Include addendum in bevel gear height and correct coordinate transforms.

- **[MED-17] Fan Grill / Cutout Overlap & Motor Foot Slot Degeneracy:**  
  *Location:* `src/parts/generators/fans.ts:227, 244, 250-272`, `src/parts/generators/motors.ts:389-393, 397`  
  *Details:* On small fans, mounting holes overlap the central bore under the `'EvenOdd'` fill rule, creating solid islands inside cutouts. In motors, `slotLength > footLength` extrudes solid tabs outside the foot.  
  *Fix:* Combine opening contours using union rather than EvenOdd winding and clamp slot lengths to foot bounds.

- **[MED-18] `meshEntry` Propagates Non-Finite (`NaN`/`Infinity`) Vertices:**  
  *Location:* `src/geometry/kernel.ts:307-324`, `src/geometry/skin.ts:55-68`  
  *Details:* Open meshes bypass Manifold validation and propagate `NaN` into vertex normals and bounding box computations.  
  *Fix:* Validate vertex coordinates with `Number.isFinite()` during mesh ingestion.

- **[MED-19] WebGL `CanvasTexture` Re-Allocated at 60 Hz During Resize Gestures:**  
  *Location:* `src/viewer/Viewer.ts:856-900`  
  *Details:* `applySkin()` re-creates `CanvasTexture` and calls `dropSkin()` on every pointer-move frame during resize interactions, repeatedly re-uploading up to 64 MB of texture memory to the GPU.  
  *Fix:* Update `texture.needsUpdate = true` on existing texture instances rather than recreating textures.

- **[MED-20] Multi-Pointer / Secondary Button Drag Conflicts in Viewer:**  
  *Location:* `src/viewer/Viewer.ts:475-485, 488-525, 583-596, 1257-1321`  
  *Details:* Pointer handlers do not check `event.pointerId` or `event.button`. Clicking right/middle mouse or touching a second finger corrupts or prematurely ends active transform gestures.  
  *Fix:* Bind drag tracking exclusively to the initiating `pointerId` and primary button (`button === 0`).

- **[MED-21] UI Input Field and Shortcut Desynchronizations:**  
  *Location:* `src/ui/Fields.tsx:32-42`, `src/ui/Inspector.tsx`, `src/App.tsx:44-61, 193`  
  *Details:* `NumberBox` fails to commit typed values on `Enter`, locked objects leave inspection controls enabled, `typing()` suppresses global shortcuts when color/checkbox inputs have focus, and `Ctrl+S` does not blur active inputs before saving.  
  *Fix:* Ensure proper input blur on save, disable inspector controls for locked nodes, and refine keyboard shortcut focus filtering.

---

## 6. Low Severity Findings

- **[LOW-01] `Structure.tsx` Leaks 3D Highlight Box on Unmount & Invalid ARIA Markup:**  
  *Location:* `src/ui/Structure.tsx:28-71`  
  *Details:* If the Structure panel unmounts while an item is hovered, the highlight box remains visible in the 3D scene. Non-interactive tree containers lack complete ARIA attributes.  
  *Fix:* Clear highlights in a `useEffect` cleanup hook.

- **[LOW-02] `<Hint>` Inside `<label>` Toggles Controls on Click:**  
  *Location:* `src/ui/Hint.tsx:14-25`, `src/ui/PartFields.tsx:23-28, 51-55`  
  *Details:* Clicking hint icons nested inside `<label>` elements activates associated input toggles due to browser label bubbling.  
  *Fix:* Call `e.stopPropagation()` and `e.preventDefault()` on hint click handlers.

- **[LOW-03] `HandleInput` Coerces Empty String to Zero:**  
  *Location:* `src/ui/Viewport.tsx:149-153`, `src/viewer/Viewer.ts:1569-1596`  
  *Details:* Clearing an on-screen viewport dimension handle coerces `""` to `0`, producing zero-dimension shapes.  
  *Fix:* Revert to previous value on empty input.

- **[LOW-04] Fixed `1316px` Minimum Grid Width in `.app` Clips Inspector on Small Displays:**  
  *Location:* `src/styles.css:64, 128`  
  *Details:* Hard-coded `min-width: 1316px` forces horizontal clipping of inspector panels on 1080p laptop displays with display scaling.  
  *Fix:* Make sidebar and inspector widths responsive or scrollable.

- **[LOW-05] File Picker and Drag-and-Drop Browser Edge Cases:**  
  *Location:* `src/platform.ts:42-46, 66-84, 118-124`  
  *Details:* In web mode, cancelling the file picker leaves state hanging without feedback, and folder drops are silently ignored.  
  *Fix:* Handle file picker cancellation and provide user notifications.

- **[LOW-06] Inaccurate Keyway Corner Radius & Permanent Cache of Failed Kernel Init:**  
  *Location:* `src/geometry/shapes.ts:108`, `src/parts/features.ts:185-204`, `src/geometry/kernel.ts:24-31`  
  *Details:* Keyway corner radii calculations underestimate clearance corners; failed WASM initialization permanently caches a rejected promise, preventing retry.  
  *Fix:* Refine corner radius math and clear cached init promise on catch.

---

## 7. Architectural, Memory & Test Coverage Gaps

### Architectural & Memory Management Observations
1. **WASM Heap Lifetime Management:**  
   `Manifold` and `CrossSection` instances require manual memory management. Current wrapper functions use `try...finally` in some places, but omit cleanup when constructors throw C++ exceptions (`new k.Manifold(mesh)`). A RAII-like resource scope pattern should be adopted across `kernel.ts`, `shapes.ts`, and `evaluate.ts`.
2. **GPU Texture Lifecycle:**  
   `SkinPainter` caches image bitmaps and skins indefinitely. In long editing sessions with multiple sticker projections, GPU texture memory is never freed.
3. **IPC Architecture:**  
   The Tauri backend bypasses standard security patterns by using unconstrained file reading/writing commands. Adopting the official `tauri-plugin-fs` with scoped capabilities or using an in-memory capability map in Rust would eliminate privilege escalation risks.

### Test Coverage Gaps
1. **Zero Rust Tests:**  
   `src-tauri/src/lib.rs` has 0 unit or integration tests for `write_atomic`, path handling, or CLI parsing.
2. **Untested Subsystems:**  
   The Vitest suite has 0 tests for:
   - `src-tauri/*`
   - `src/platform.ts`
   - `src/worker/*` (`client.ts`, `geometry.worker.ts`)
   - `src/state/*` (`store.ts`, `geometry.ts`, `persist.ts`, `glbExport.ts`)
   - `src/viewer/*` (`Viewer.ts`, `skin.ts`)
   - `src/ui/*` (all React components)
3. **Parametric Generator Edge Cases:**  
   Existing part tests only verify `defaultParams(gen)`. None test boundary parameters (e.g. minimum module, maximum backlash, zero shaft length, thin walls), allowing kernel crashes to remain undetected.

---

## 8. Prioritized Remediation Roadmap

### Phase 1: Immediate Security & Crash Fixes (P0)
1. **[CRIT-01]** Add denominator and delta bounds in `arcPoints` (`src/io/importSvg.ts`) to eliminate infinite loops and process crashes.
2. **[CRIT-02]** Impose cumulative uncompressed size limits and component DAG traversal limits in `src/io/import3mf.ts`.
3. **[CRIT-03]** Re-enable CSP in `src-tauri/tauri.conf.json` and restrict `read_file` / `write_file` paths in `src-tauri/src/lib.rs`.
4. **[CRIT-04]** Clear alignment hover gestures whenever alignment mode exits in `src/state/store.ts` and `src/viewer/Viewer.ts`.
5. **[CRIT-05]** Fix group dissolution logic in `src/model/ops.ts` and `src/state/store.ts` to prevent inner holes from converting to solids.

### Phase 2: High Severity Stability & Data Integrity (P1)
6. **[HIGH-01]** Fix PID-only collision in `write_atomic` (`src-tauri/src/lib.rs`) using unique atomic counters.
7. **[HIGH-02]** Clone open mesh buffers before worker transfer in `src/geometry/kernel.ts`.
8. **[HIGH-03]** Fix inverted surface normals on mirrored objects during GLB export (`src/io/glb.ts`).
9. **[HIGH-04]** Add `onReady()` callback in image load catch handler (`src/viewer/skin.ts`) to prevent GLB export freeze.
10. **[HIGH-06]** Ensure C++ Manifold pointers are freed when mesh construction fails (`src/geometry/kernel.ts`).
11. **[HIGH-07]** Replace `String.fromCharCode.apply` with `TextDecoder` in `src/io/scan.ts`.
12. **[HIGH-08]** Use `Object.create(null)` or `Map` for lookup tables across `file.ts`, `xml.ts`, and `import3mf.ts`.
13. **[HIGH-10]** Include `editing` in undo steps and auto-commit group editing before saving (`src/state/store.ts`).
14. **[HIGH-13], [HIGH-14], [HIGH-17], [HIGH-18]** Clamp parameters and guard against degenerate geometry in duct, cylinder, motor, and gear generators.

### Phase 3: Performance, Rendering & Medium Fixes (P2)
15. **[MED-19]** Avoid re-allocating `CanvasTexture` during resize gestures in `src/viewer/Viewer.ts`.
16. **[MED-01]** Fix scientific notation number truncation in `src/io/format.ts`.
17. **[HIGH-15]** Fix sticker atlas UV bleed and multi-sticker support in `src/geometry/uv.ts`.
18. **[MED-10]** Offload blocking file I/O to `spawn_blocking` in `src-tauri/src/lib.rs`.
19. **[MED-20]** Fix multi-pointer and secondary-button conflicts in `src/viewer/Viewer.ts`.
20. **[HIGH-05]** Implement asset garbage collection in `GeometryClient` and `SkinPainter`.

### Phase 4: Test Suite & Architectural Hardening (P3)
21. Add unit tests for Tauri Rust commands and atomic save behavior.
22. Add unit tests for `src/state/store.ts` covering undo/redo across `editInside`, `aligning`, and `arraying`.
23. Add parametric generator boundary tests covering min/max parameter ranges.
24. Address UI accessibility and responsive layout clipping.

