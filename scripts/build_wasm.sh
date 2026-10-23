#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
wasm-pack build --target web --release --out-dir pkg -- --locked
# Keep font redistribution notices with the compiled package.
cp assets/LICENSE-misc.txt assets/LICENSE-schumacher.txt assets/LICENSE-sony.txt pkg/
cp assets/fonts.json pkg/
