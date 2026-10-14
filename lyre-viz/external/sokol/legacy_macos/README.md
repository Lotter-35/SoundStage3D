Versions de `sokol_app.h` et `sokol_glue.h` d'avant le 20 fevrier 2026 (commit sokol e01e395c).

Les versions recentes de sokol_app.h utilisent `CADisplayLink`, qui n'existe que dans le SDK macOS 14 (Xcode 15)
et plus. Sur un Mac avec un Xcode plus ancien, `build.sh` utilise automatiquement ces deux fichiers
(MTKView) a la place ; `sokol_gfx.h` reste le meme.
