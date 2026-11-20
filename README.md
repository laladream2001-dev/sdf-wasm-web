# sdf-wasm-web — SDF renderer as WebAssembly, embeddable in blogs

Interactive 3D demos rendered **in the reader's browser** by the SDF
raymarcher compiled to WebAssembly. The Wasm build is verified
bit-identical to the native C core (pixel gate 2026-11-19; scenes re-gated
2026-11-20, mean diff < 0.03/255).

- Live demo: https://laladream2001-dev.github.io/sdf-wasm-web/
- Scenes: `?scene=electrolysis` (default), `?scene=mole_atoms`,
  `?scene=water_molecule`
- Versioned path: everything under `v1/` is pinned — a core update ships
  as `v2/`, never silently changing live blog embeds.
- Embed in Blogger: `<iframe src="https://laladream2001-dev.github.io/sdf-wasm-web/?scene=water_molecule" width="100%" height="420" frameborder="0"></iframe>`
- Fallback: each scene ships a pre-rendered PNG (`scenes/*.png`) shown
  before / instead of the Wasm render.

Source of the renderer: `~/workspace/sdf-renderer/` (SDF core, scenes,
export + gate scripts). License: same as the SDF renderer project.
