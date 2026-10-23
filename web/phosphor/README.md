# Phosphor (vendored)

Copied from the Phosphor Design System project (claude.ai/design project
`fb6aa4cd-3d01-4b74-821e-5d5151571665`) so the web UI needs no build step or
framework. Only the stylesheet layer is used; the project's React components are
not, because the UI renders the same `.ph-*` markup directly.

| path | source | changes |
| --- | --- | --- |
| `styles.css` | `styles.css` | none |
| `tokens/*.css` | `tokens/*.css` | none |
| `components/ui.css` | `components/ui.css` | none |
| `icons/*.svg` | `assets/icons/*.svg` | subset of the 40 vendored glyphs |

`tokens/fonts.css` still loads Martian Mono and DM Mono from Google Fonts; with
no network the UI falls back to the platform monospace face. Rendering is
unaffected because page glyphs come from the WASM package, not from CSS fonts.

The icons are [Lucide](https://lucide.dev) glyphs, redistributed under the ISC
and MIT notices in [icons/LICENSE](icons/LICENSE).
