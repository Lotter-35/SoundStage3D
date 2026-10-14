// =====================================================================================
//  LyreViz - banc d'essai de visualisation de lyres (moving heads) en C++
//  sokol (Metal / Direct3D 11 / OpenGL) + Dear ImGui
// =====================================================================================
#include "app.h"
#include "sokol_app.h"
#include "sokol_gfx.h"
#include "sokol_glue.h"
#include "sokol_log.h"
#include "sokol_time.h"
#include "imgui.h"
#include "util/sokol_imgui.h"
#include <cstdio>
#include <cstdlib>
#include <cstring>

App app;

static int g_quit_after_frames = 0;   // --frames N : quitte apres N images (tests)
static bool g_novsync = false;

static float ground_height(vec3 p) {
    // la scene (cote -X) est surelevee
    if (p.x < -34.0f && std::fabs(p.z) < 16.0f) return 1.6f;
    return 0.0f;
}

static void init() {
    sg_desc desc = {};
    desc.environment = sglue_environment();
    desc.logger.func = slog_func;
    desc.uniform_buffer_size = 4 * 1024 * 1024;
    sg_setup(&desc);
    stm_setup();

    simgui_desc_t sd = {};
    sd.ini_filename = "lyreviz-ui.ini";
    sd.logger.func = slog_func;
    simgui_setup(&sd);
    ImGuiStyle& st = ImGui::GetStyle();
    st.WindowRounding = 6;
    st.FrameRounding = 4;
    st.GrabRounding = 4;
    st.Colors[ImGuiCol_WindowBg].w = 0.92f;

    app.scene.build();
    app.rig.build(app.scene);
    app.gobos.generate();
    app.fog.init(app.scene.bounds_min, app.scene.bounds_max);
    app.renderer.init(app.scene, app.gobos, app.fog);
    app.cam.update_basis();
    std::printf("LyreViz : %d lyres, %d objets statiques, backend %d\n", (int)app.rig.fixtures.size(),
                (int)app.scene.cubes.size(), (int)sg_query_backend());
}

static void add_avatar() {
    // silhouette du personnage (eclairee comme le reste de la scene)
    const vec3 skin = {0.72f, 0.72f, 0.74f};
    float yaw = app.cam.yaw;
    vec3 fx = {std::cos(yaw), 0, std::sin(yaw)}, fz = {-std::sin(yaw), 0, std::cos(yaw)};
    auto part = [&](vec3 local, vec3 half) {
        vec3 c = app.player + fx * local.x + vec3(0, local.y, 0) + fz * local.z;
        app.renderer.dyn_cubes.push_back(make_instance(c, fx * half.x, {0, half.y, 0}, fz * half.z, skin, 0.6f));
    };
    part({0, 0.45f, -0.1f}, {0.08f, 0.45f, 0.08f});
    part({0, 0.45f, 0.1f}, {0.08f, 0.45f, 0.08f});
    part({0, 1.22f, 0}, {0.13f, 0.32f, 0.21f});
    part({0, 1.68f, 0}, {0.11f, 0.13f, 0.1f});
    part({0, 1.2f, -0.3f}, {0.06f, 0.3f, 0.06f});
    part({0, 1.2f, 0.3f}, {0.06f, 0.3f, 0.06f});
}

static void update_camera(float dt) {
    Camera& c = app.cam;
    c.update_basis();
    const bool ui_kb = ImGui::GetIO().WantCaptureKeyboard;
    float speed = app.move_speed * (app.keys[SAPP_KEYCODE_LEFT_SHIFT] ? 4.0f : 1.0f);
    vec3 move = {0, 0, 0};
    // touches physiques W A S D (= Z Q S D sur un clavier AZERTY) et fleches
    if (!ui_kb) {
        vec3 f = app.character ? normalize(vec3(c.fwd.x, 0, c.fwd.z)) : c.fwd;
        vec3 r = c.right;
        if (app.keys[SAPP_KEYCODE_W] || app.keys[SAPP_KEYCODE_UP]) move += f;
        if (app.keys[SAPP_KEYCODE_S] || app.keys[SAPP_KEYCODE_DOWN]) move -= f;
        if (app.keys[SAPP_KEYCODE_D] || app.keys[SAPP_KEYCODE_RIGHT]) move += r;
        if (app.keys[SAPP_KEYCODE_A] || app.keys[SAPP_KEYCODE_LEFT]) move -= r;
        if (!app.character) {
            if (app.keys[SAPP_KEYCODE_SPACE] || app.keys[SAPP_KEYCODE_E]) move += vec3(0, 1, 0);
            if (app.keys[SAPP_KEYCODE_C] || app.keys[SAPP_KEYCODE_Q]) move -= vec3(0, 1, 0);
        }
    }
    if (length(move) > 0) move = normalize(move) * (speed * dt);
    const vec3 bmin = app.scene.bounds_min + vec3(0.4f, 0.1f, 0.4f), bmax = app.scene.bounds_max - vec3(0.4f, 0.4f, 0.4f);
    if (app.character) {
        vec3 p = app.player + vec3(move.x, 0, move.z) * 0.6f;
        p = vmax(bmin, vmin(bmax, p));
        float gh = ground_height(p);
        // on ne grimpe pas sur la scene en marchant (sauf en sautant assez haut)
        if (gh > app.player.y + 0.4f) p = {app.player.x, p.y, app.player.z};
        app.player.x = p.x;
        app.player.z = p.z;
        if (!ui_kb && app.on_ground && app.keys[SAPP_KEYCODE_SPACE]) { app.player_vy = 5.0f; app.on_ground = false; }
        app.player_vy -= 9.81f * dt;
        app.player.y += app.player_vy * dt;
        float g = ground_height(app.player);
        if (app.player.y <= g) { app.player.y = g; app.player_vy = 0; app.on_ground = true; }
        vec3 back = normalize(vec3(c.fwd.x, 0, c.fwd.z));
        c.pos = app.player + vec3(0, 2.0f, 0) - back * 4.0f + vec3(0, -c.fwd.y * 2.0f, 0);
        c.pos = vmax(bmin, vmin(bmax, c.pos));
        add_avatar();
    } else {
        c.pos = vmax(bmin, vmin(bmax, c.pos + move));
    }
}

static void frame() {
    const uint64_t t0 = stm_now();
    const float dt = std::min((float)sapp_frame_duration(), 0.1f);
    const int w = sapp_width(), h = sapp_height();
    if (!app.paused) app.time += dt;

    simgui_frame_desc_t fd = {};
    fd.width = w;
    fd.height = h;
    fd.delta_time = sapp_frame_duration();
    fd.dpi_scale = sapp_dpi_scale();
    simgui_new_frame(&fd);
    const uint64_t tu = stm_now();
    if (app.show_ui) draw_ui();
    app.timings.ui_ms = (float)stm_ms(stm_since(tu));

    update_camera(dt);

    const uint64_t tr = stm_now();
    app.rig.update(app.paused ? 0.0f : dt);
    app.timings.rig_ms = (float)stm_ms(stm_since(tr));

    const uint64_t tf = stm_now();
    app.fog.update(app.paused ? 0.0f : dt, app.fog_settings);
    app.timings.fog_ms = (float)stm_ms(stm_since(tf));

    const uint64_t tg = stm_now();
    simgui_flush();   // prepare l'interface (hors passe de rendu)
    app.renderer.render(app.cam, app.scene, app.rig, app.gobos, app.fog, app.fog_settings, app.rs, w, h, app.time, [] { simgui_draw(); });
    app.timings.render_cpu_ms = (float)stm_ms(stm_since(tg));

    const float ms = (float)stm_ms(stm_since(t0));
    (void)ms;
    const float frame_ms = (float)(sapp_frame_duration() * 1000.0);
    app.timings.frame_ms = app.timings.frame_ms * 0.95f + frame_ms * 0.05f;
    app.timings.fps = app.timings.frame_ms > 0 ? 1000.0f / app.timings.frame_ms : 0;

    if (g_quit_after_frames > 0 && (int)sapp_frame_count() >= g_quit_after_frames) {
        std::printf("Images rendues : %d, temps moyen %.2f ms\n", (int)sapp_frame_count(), app.timings.frame_ms);
        sapp_request_quit();
    }
}

static void pick_aim_point(float mx, float my) {
    const Camera& c = app.cam;
    float w = sapp_widthf(), h = sapp_heightf();
    float tanY = std::tan(c.fovy * 0.5f), tanX = tanY * w / h;
    float nx = mx / w * 2 - 1, ny = 1 - my / h * 2;
    vec3 d = normalize(c.fwd + c.right * (nx * tanX) + c.up * (ny * tanY));
    RayHit hit;
    if (app.scene.raycast(c.pos, d, 500, hit)) app.rig.aim_points[app.pick_aim] = hit.pos;
    app.pick_aim = -1;
}

static void event(const sapp_event* ev) {
    const bool ui_used = simgui_handle_event(ev);
    ImGuiIO& io = ImGui::GetIO();
    switch (ev->type) {
        case SAPP_EVENTTYPE_KEY_DOWN:
            if (ev->key_code >= 0 && ev->key_code < 512 && !io.WantCaptureKeyboard) app.keys[ev->key_code] = true;
            if (io.WantCaptureKeyboard) break;
            if (ev->key_code == SAPP_KEYCODE_H) app.show_ui = !app.show_ui;
            if (ev->key_code == SAPP_KEYCODE_F) {
                app.character = !app.character;
                if (app.character) app.player = {app.cam.pos.x, ground_height(app.cam.pos), app.cam.pos.z};
            }
            if (ev->key_code == SAPP_KEYCODE_P) app.paused = !app.paused;
            if (ev->key_code == SAPP_KEYCODE_ESCAPE) { app.looking = false; sapp_lock_mouse(false); app.pick_aim = -1; }
            break;
        case SAPP_EVENTTYPE_KEY_UP:
            if (ev->key_code >= 0 && ev->key_code < 512) app.keys[ev->key_code] = false;
            break;
        case SAPP_EVENTTYPE_MOUSE_DOWN:
            if (ev->mouse_button == SAPP_MOUSEBUTTON_RIGHT && !io.WantCaptureMouse) {
                app.looking = true;
                sapp_lock_mouse(true);
            }
            if (ev->mouse_button == SAPP_MOUSEBUTTON_LEFT && !io.WantCaptureMouse && app.pick_aim >= 0) pick_aim_point(ev->mouse_x, ev->mouse_y);
            break;
        case SAPP_EVENTTYPE_MOUSE_UP:
            if (ev->mouse_button == SAPP_MOUSEBUTTON_RIGHT && app.looking) {
                app.looking = false;
                sapp_lock_mouse(false);
            }
            break;
        case SAPP_EVENTTYPE_MOUSE_MOVE:
            if (app.looking) {
                app.cam.yaw += ev->mouse_dx * 0.0025f;
                app.cam.pitch = clampf(app.cam.pitch - ev->mouse_dy * 0.0025f, -1.5f, 1.5f);
            }
            break;
        case SAPP_EVENTTYPE_MOUSE_SCROLL:
            if (!io.WantCaptureMouse) app.move_speed = clampf(app.move_speed * (ev->scroll_y > 0 ? 1.15f : 1.0f / 1.15f), 0.5f, 80.0f);
            break;
        case SAPP_EVENTTYPE_UNFOCUSED:
            std::memset(app.keys, 0, sizeof(app.keys));
            break;
        default: break;
    }
    (void)ui_used;
}

static void cleanup() {
    app.renderer.shutdown();
    simgui_shutdown();
    sg_shutdown();
}

sapp_desc sokol_main(int argc, char* argv[]) {
    for (int i = 1; i < argc; i++) {
        if (!std::strcmp(argv[i], "--frames") && i + 1 < argc) g_quit_after_frames = std::atoi(argv[++i]);
        else if (!std::strcmp(argv[i], "--novsync")) g_novsync = true;
        else if (!std::strcmp(argv[i], "--noui")) app.show_ui = false;
        else if (!std::strcmp(argv[i], "--nogi")) app.rs.gi = false;
        else if (!std::strcmp(argv[i], "--scale") && i + 1 < argc) app.rs.render_scale = (float)std::atof(argv[++i]);
    }
    sapp_desc d = {};
    d.init_cb = init;
    d.frame_cb = frame;
    d.cleanup_cb = cleanup;
    d.event_cb = event;
    d.width = 1600;
    d.height = 900;
    d.high_dpi = true;
    d.swap_interval = 1;
    d.disable_vsync = g_novsync;
    d.window_title = "LyreViz - banc d'essai lyres";
    d.logger.func = slog_func;
    d.win32.console_attach = true;
    return d;
}
