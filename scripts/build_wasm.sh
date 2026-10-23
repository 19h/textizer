#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
wasm-pack build --target web --release --out-dir pkg -- --locked
# Keep font redistribution notices with the compiled package.
cp assets/LICENSE-misc.txt assets/LICENSE-schumacher.txt assets/LICENSE-sony.txt pkg/
cp assets/LICENSE-jetbrains-mono.txt assets/jetbrains-mono.json pkg/
cp assets/jetbrains-sizes.json pkg/
cp assets/fonts.json pkg/
