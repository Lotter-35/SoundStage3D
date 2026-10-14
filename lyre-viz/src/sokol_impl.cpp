// Implementation des bibliotheques sokol et du rendu ImGui.
// Sur macOS ce fichier est compile en Objective-C++ (voir build.sh).
#define SOKOL_IMPL
#include "sokol_app.h"
#include "sokol_gfx.h"
#include "sokol_glue.h"
#include "sokol_log.h"
#include "sokol_time.h"
#include "imgui.h"
#define SOKOL_IMGUI_IMPL
#include "util/sokol_imgui.h"
