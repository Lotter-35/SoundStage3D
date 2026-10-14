#!/usr/bin/env bash
# Recompile shaders/lyreviz.glsl -> src/shaders/lyreviz.glsl.h (Metal + Direct3D 11 + OpenGL)
# A lancer seulement apres avoir modifie les shaders. Telecharge sokol-shdc au premier lancement.
set -e
cd "$(dirname "$0")/.."
case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) P=osx_arm64 ;;
    Darwin-*) P=osx ;;
    Linux-aarch64) P=linux_arm64 ;;
    *) P=linux ;;
esac
SHDC=tools/bin/sokol-shdc-$P
if [ ! -x "$SHDC" ]; then
    mkdir -p tools/bin
    echo "Telechargement de sokol-shdc ($P)..."
    curl -fL -o "$SHDC" "https://raw.githubusercontent.com/floooh/sokol-tools-bin/master/bin/$P/sokol-shdc"
    chmod +x "$SHDC"
fi
"$SHDC" -i shaders/lyreviz.glsl -o src/shaders/lyreviz.glsl.h -l glsl430:hlsl5:metal_macos --ifdef
echo "OK : src/shaders/lyreviz.glsl.h"
