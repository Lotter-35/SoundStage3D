#!/usr/bin/env bash
# Compilation de LyreViz sur macOS (Metal) ou Linux (OpenGL 4.3).
#   ./build.sh          -> version optimisee
#   ./build.sh debug    -> version de debogage (couche de validation sokol active)
set -e
cd "$(dirname "$0")"

MODE=${1:-release}
OS=$(uname -s)
CXX=${CXX:-clang++}
if ! command -v "$CXX" >/dev/null 2>&1; then CXX=g++; fi

if [ "$MODE" = "debug" ]; then
    OPT="-O0 -g"
else
    OPT="-O2 -DNDEBUG"
fi
FLAGS="-std=c++17 $OPT -Isrc -Iexternal/sokol -Iexternal/imgui -Iexternal/stb"

case "$OS" in
    Darwin)
        BACKEND="-DSOKOL_METAL"
        IMPL_FLAGS="-x objective-c++ -fobjc-arc"
        LIBS="-framework Metal -framework MetalKit -framework Cocoa -framework QuartzCore"
        # Les versions recentes de sokol_app.h demandent le SDK macOS 14 (Xcode 15) ;
        # avec un SDK plus ancien, on prend l'ancienne version (MTKView), voir external/sokol/legacy_macos.
        SDK_VER=$(xcrun --sdk macosx --show-sdk-version 2>/dev/null || echo 0)
        if [ "${SDK_VER%%.*}" -lt 14 ] || [ -n "$LEGACY" ]; then
            echo "SDK macOS $SDK_VER : fenetre en mode compatible (MTKView)"
            LEGACY=1
        fi
        ;;
    Linux)
        BACKEND="-DSOKOL_GLCORE"
        IMPL_FLAGS=""
        LIBS="-lX11 -lXi -lXcursor -lGL -ldl -lpthread -lm"
        ;;
    *)
        echo "Systeme non gere : $OS (sous Windows, utiliser build.bat)"
        exit 1
        ;;
esac

if [ -n "$LEGACY" ]; then
    FLAGS="-Iexternal/sokol/legacy_macos $FLAGS -DLYREVIZ_LEGACY_SAPP"
    MODE_DIR="$MODE-legacy"
else
    MODE_DIR="$MODE"
fi
OBJ=build/$MODE_DIR
mkdir -p "$OBJ"
SRCS="src/main.cpp src/scene.cpp src/fixtures.cpp src/gobos.cpp src/fog.cpp src/renderer.cpp src/ui.cpp src/gpu_profiler.cpp src/floor_texture.cpp src/lasers.cpp src/ilda.cpp src/trace.cpp src/volutes.cpp src/fumee_spatiale.cpp src/ambiances.cpp src/scenes/scenes.cpp src/scenes/scenes_a.cpp src/scenes/scenes_b.cpp
      external/imgui/imgui.cpp external/imgui/imgui_draw.cpp external/imgui/imgui_tables.cpp external/imgui/imgui_widgets.cpp"

echo "Compilation ($OS, $MODE, $CXX)..."
pids=()
for s in $SRCS; do
    o="$OBJ/$(basename "${s%.cpp}").o"
    # ne recompile que ce qui a change (les .h du projet comptent aussi)
    if [ ! -f "$o" ] || [ "$s" -nt "$o" ] || [ -n "$(find src -name '*.h' -newer "$o" 2>/dev/null | head -1)" ]; then
        $CXX $FLAGS $BACKEND -c "$s" -o "$o" &
        pids+=($!)
    fi
done
o="$OBJ/sokol_impl.o"
if [ ! -f "$o" ] || [ src/sokol_impl.cpp -nt "$o" ]; then
    $CXX $FLAGS $BACKEND $IMPL_FLAGS -c src/sokol_impl.cpp -o "$o" &
    pids+=($!)
fi
for p in "${pids[@]}"; do wait "$p"; done

$CXX "$OBJ"/*.o -o LyreViz $LIBS
echo "OK : ./LyreViz"
