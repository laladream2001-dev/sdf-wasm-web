/**
 * sdf_wasm.js — JavaScript glue for sdf_core.c (R5) compiled to WebAssembly.
 *
 * Supports two loading modes:
 *   1. Emscripten modularized build (createSdfModule from sdf_core_em.js)
 *   2. Standalone .wasm (WebAssembly.instantiateStreaming / instantiate)
 *
 * Exact C ABI (matches sdf_core.c R5):
 *   sizeof(SdfPrim)    = 168 bytes
 *   sizeof(SdfGlobals) = 136 bytes
 *   void render_core(const SdfPrim* prims, int32_t n_prims,
 *                    const SdfGlobals* globals,
 *                    int32_t width, int32_t height,
 *                    uint8_t* out_rgb_uint8);
 */

export const PRIM_SPHERE = 0;
export const PRIM_CAPSULE = 1;
export const PRIM_BOX = 2;
export const PRIM_PLANE = 3;

export const OP_UNION = 0;
export const OP_SMOOTH = 1;

export const SDF_PRIM_BYTES = 168;
export const SDF_GLOBALS_BYTES = 136;

/**
 * Compute 3x3 rotation matrix R (row-major flat length 9) from Euler degrees
 * (rx, ry, rz), matching core.py _rot_matrix(rotation_deg): R = Rz @ Ry @ Rx.
 */
export function rotMatrixDeg(rotationDeg = [0, 0, 0]) {
  const rad = Math.PI / 180.0;
  const rx = (rotationDeg[0] || 0) * rad;
  const ry = (rotationDeg[1] || 0) * rad;
  const rz = (rotationDeg[2] || 0) * rad;

  const cx = Math.cos(rx), sx = Math.sin(rx);
  const cy = Math.cos(ry), sy = Math.sin(ry);
  const cz = Math.cos(rz), sz = Math.sin(rz);

  return [
    cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx,
    sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx,
    -sy,     cy * sx,                cy * cx,
  ];
}

function normalize3(v) {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (len < 1e-12) return [0, 0, 0];
  return [v[0] / len, v[1] / len, v[2] / len];
}

/**
 * Pack an array of primitive descriptors into Wasm linear memory.
 * Each descriptor:
 *   { type: 0|1|2|3, op: 0|1, smooth_k?: number, color: [r,g,b], params: number[] }
 * Or convenience helpers:
 *   { kind: 'sphere', center, radius, color, op?, smooth? }
 *   { kind: 'capsule', a, b, radius, color, op?, smooth? }
 *   { kind: 'box', center, half, rotation_deg?, rot?, color, op?, smooth? }
 *   { kind: 'plane', y, color, op?, smooth? }
 */
export function packPrimsIntoBuffer(buffer, byteOffset, prims) {
  const dv = new DataView(buffer, byteOffset, prims.length * SDF_PRIM_BYTES);
  for (let i = 0; i < prims.length; i++) {
    const p = prims[i];
    const base = i * SDF_PRIM_BYTES;

    let type = p.type;
    let params = p.params;
    if (p.kind) {
      if (p.kind === 'sphere') {
        type = PRIM_SPHERE;
        params = [p.center[0], p.center[1], p.center[2], p.radius];
      } else if (p.kind === 'capsule') {
        type = PRIM_CAPSULE;
        params = [p.a[0], p.a[1], p.a[2], p.b[0], p.b[1], p.b[2], p.radius];
      } else if (p.kind === 'box') {
        type = PRIM_BOX;
        const rot = p.rot || rotMatrixDeg(p.rotation_deg || [0, 0, 0]);
        params = [
          p.center[0], p.center[1], p.center[2],
          p.half[0], p.half[1], p.half[2],
          ...rot,
        ];
      } else if (p.kind === 'plane') {
        type = PRIM_PLANE;
        params = [p.y];
      } else {
        throw new Error(`Unknown primitive kind: ${p.kind}`);
      }
    }

    const op = typeof p.op === 'string'
      ? (p.op === 'smooth' ? OP_SMOOTH : OP_UNION)
      : (p.op || 0);
    const smoothK = p.smooth_k ?? p.smooth ?? 0.08;
    const col = p.color || [1, 1, 1];

    dv.setInt32(base + 0, type, true);
    dv.setInt32(base + 4, op, true);
    dv.setFloat64(base + 8, smoothK, true);
    dv.setFloat64(base + 16, col[0], true);
    dv.setFloat64(base + 24, col[1], true);
    dv.setFloat64(base + 32, col[2], true);

    for (let j = 0; j < 16; j++) {
      dv.setFloat64(base + 40 + j * 8, params && j < params.length ? params[j] : 0.0, true);
    }
  }
}

export function packGlobalsIntoBuffer(buffer, byteOffset, globals) {
  const dv = new DataView(buffer, byteOffset, SDF_GLOBALS_BYTES);
  const camPos = globals.camera_pos;
  const camTgt = globals.camera_target;
  const fovDeg = globals.fov_deg ?? 40.0;
  const bg = globals.background ?? [0.05, 0.07, 0.10];
  const ldir = normalize3(globals.light_dir ?? [0.5, 1.0, 0.6]);
  const lcol = globals.light_color ?? [1.0, 0.98, 0.92];
  const ambient = globals.ambient ?? 0.25;

  const vals = [
    camPos[0], camPos[1], camPos[2],
    camTgt[0], camTgt[1], camTgt[2],
    fovDeg,
    bg[0], bg[1], bg[2],
    ldir[0], ldir[1], ldir[2],
    lcol[0], lcol[1], lcol[2],
    ambient,
  ];
  for (let i = 0; i < vals.length; i++) {
    dv.setFloat64(byteOffset ? i * 8 : i * 8, vals[i], true);
  }
}

/**
 * Wrap an Emscripten module or a raw WebAssembly.Instance into a unified renderer.
 */
export class SdfWasmRenderer {
  constructor({ renderCore, getBuffer, alloc, free }) {
    this._renderCore = renderCore;
    this._getBuffer = getBuffer;
    this._alloc = alloc;
    this._free = free;
  }

  /**
   * Create from an Emscripten modularized factory (e.g. createSdfModule()).
   */
  static async fromEmscripten(moduleOrFactory) {
    const mod = typeof moduleOrFactory === 'function'
      ? await moduleOrFactory()
      : await moduleOrFactory;
    return new SdfWasmRenderer({
      renderCore: mod._render_core,
      getBuffer: () => mod.HEAPU8.buffer,
      alloc: (bytes) => mod._malloc(bytes),
      free: (ptr) => mod._free(ptr),
    });
  }

  /**
   * Create from a standalone .wasm URL or ArrayBuffer/Uint8Array.
   */
  static async fromStandaloneWasm(source, imports = {}) {
    let result;
    if (typeof source === 'string') {
      const resp = await fetch(source);
      const bytes = await resp.arrayBuffer();
      result = await WebAssembly.instantiate(bytes, imports);
    } else {
      result = await WebAssembly.instantiate(source, imports);
    }
    const inst = result.instance || result;
    const exp = inst.exports;
    const memory = exp.memory;
    const renderCore = exp.render_core || exp._render_core;

    if (!renderCore || !memory) {
      throw new Error('Wasm module must export memory and render_core');
    }

    if (exp.malloc && exp.free) {
      return new SdfWasmRenderer({
        renderCore,
        getBuffer: () => memory.buffer,
        alloc: (n) => exp.malloc(n),
        free: (p) => exp.free(p),
      });
    }

    // Simple scratch allocator above __heap_base when malloc is not exported.
    const heapBase = exp.__heap_base ? Number(exp.__heap_base.value ?? exp.__heap_base) : 65536;
    let cursor = (heapBase + 7) & ~7;
    return new SdfWasmRenderer({
      renderCore,
      getBuffer: () => memory.buffer,
      alloc: (n) => {
        const aligned = (n + 7) & ~7;
        const ptr = cursor;
        cursor += aligned;
        const neededPages = Math.ceil(cursor / 65536);
        const currentPages = memory.buffer.byteLength / 65536;
        if (neededPages > currentPages) {
          memory.grow(neededPages - currentPages);
        }
        return ptr;
      },
      free: () => {
        cursor = (heapBase + 7) & ~7;
      },
    });
  }

  /**
   * Render a scene description -> Uint8Array(width * height * 3) RGB.
   */
  renderRGB(sceneDesc, width = 320, height = 180) {
    const prims = sceneDesc.prims || [];
    const nPrims = prims.length;
    const primsBytes = Math.max(8, nPrims * SDF_PRIM_BYTES);
    const globalsBytes = SDF_GLOBALS_BYTES;
    const outBytes = width * height * 3;

    const pPrims = this._alloc(primsBytes);
    const pGlobals = this._alloc(globalsBytes);
    const pOut = this._alloc(outBytes);

    try {
      const buf = this._getBuffer();
      if (nPrims > 0) {
        packPrimsIntoBuffer(buf, pPrims, prims);
      }
      packGlobalsIntoBuffer(buf, pGlobals, sceneDesc.globals || sceneDesc);

      this._renderCore(pPrims, nPrims, pGlobals, width, height, pOut);

      const postBuf = this._getBuffer();
      return new Uint8Array(postBuf, pOut, outBytes).slice();
    } finally {
      this._free(pOut);
      this._free(pGlobals);
      this._free(pPrims);
    }
  }

  /**
   * Render directly into RGBA ImageData-compatible Uint8ClampedArray(width * height * 4)
   * for HTML5 <canvas> ctx.putImageData().
   */
  renderRGBA(sceneDesc, width = 320, height = 180) {
    const rgb = this.renderRGB(sceneDesc, width, height);
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
      rgba[j] = rgb[i];
      rgba[j + 1] = rgb[i + 1];
      rgba[j + 2] = rgb[i + 2];
      rgba[j + 3] = 255;
    }
    return rgba;
  }
}
