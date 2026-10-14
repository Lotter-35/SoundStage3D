// =====================================================================================
//  LyreViz - banc d'essai de visualisation de lyres (moving heads) en C++
//  sokol (Metal / Direct3D 11 / OpenGL) + Dear ImGui
// =====================================================================================
#include "app.h"
#include "gpu_profiler.h"
#include "sokol_app.h"
#include "sokol_gfx.h"
#include "sokol_glue.h"
#include "sokol_log.h"
#include "sokol_time.h"
#include "imgui.h"
#include "util/sokol_imgui.h"
#include <cstdio>
#include <algorithm>
#include <cstdarg>
#include <cstdlib>
#include <cstring>
#include <map>
#include <string>
#include <vector>

App app;

static int g_quit_after_frames = 0;   // --frames N : quitte apres N images (tests)
static bool g_novsync = false;
static bool g_fullscreen = false;
static bool g_bench_requested = false;
static std::string g_shot_path;
static bool g_stats = false;      // --stats : compte les couples (pixel, faisceau) de la fumee   // --shot fichier.bmp : capture de la derniere image (avec --frames)

// ---------------------------------------------------------------------------------------------
//  Banc d'essai (--bench) : vues et scenarios fixes, pas de temps constant (resultats
//  reproductibles), temps GPU par passe, capture de l'image de chaque cas (comparaison visuelle).
// ---------------------------------------------------------------------------------------------
namespace bench {

struct View {
    const char* name;
    vec3 pos;
    float yaw, pitch;
};
const View VIEWS[] = {
    {"public", {30, 1.8f, 0}, PI, 0.08f},                    // du fond de la salle vers la scene
    {"scene", {-30, 3.0f, 2}, 0.0f, 0.12f},                  // de la scene vers la salle
    {"sous les trusses", {8, 2.0f, 0}, PI * 0.85f, 0.75f},   // vers le haut, dans les faisceaux
};

// Scenarios de lyres
enum { SC_DEFAULT = 0, SC_GOBO_PRISM, SC_FROST_WIDE, SC_COUNT };
const char* SC_NAMES[SC_COUNT] = {"defaut", "gobo + prisme 8 + zoom 25", "zoom 45 + frost 0.6"};

void apply_scenario(int sc) {
    app.rig.build(app.scene);
    for (size_t i = 0; i < app.rig.fixtures.size(); i++) {
        FixtureParams& p = app.rig.fixtures[i].base;
        if (sc == SC_GOBO_PRISM) {
            p.gobo = 1 + (int)(i % 6);
            p.gobo_speed = 40;
            p.prism = PRISM_8;
            p.prism_speed = 25;
            p.zoom = 25;
        } else if (sc == SC_FROST_WIDE) {
            p.gobo = 6;
            p.zoom = 45;
            p.frost = 0.6f;
        }
    }
}

struct Case {
    std::string name;
    int view, scenario;
    void (*opts)(RenderSettings&);
};
std::vector<Case> cases;
bool active = false;
bool quick = false;
bool frozen = false;   // --static : lyres et fumee immobiles (comparaison d'images sans mouvement)
std::string dir = "bench";
int index = -1, frame_in_case = 0;
const int WARMUP = 60, MEASURE = 150;
// mesures image par image ; on garde la mediane (insensible aux pics dus a d'autres programmes)
std::map<std::string, std::vector<float>> samples;
std::vector<std::string> order;
std::vector<float> totals, cpu_frames;
std::vector<float> cpu_rig, cpu_fog, cpu_render, cpu_wait, cpu_total, beam_frags, gpu_gaps, outside;
FILE* frames_csv = nullptr;   // une ligne par image (diagnostic)
unsigned last_id = 0;
FILE* out = nullptr;
RenderSettings defaults;

void build_cases() {
    for (int sc = 0; sc < SC_COUNT; sc++)
        for (int v = 0; v < (quick ? 1 : 3); v++) cases.push_back({std::string(SC_NAMES[sc]) + " / " + VIEWS[v].name, v, sc, nullptr});
    if (quick) return;
    // options coupees une par une (scenario par defaut, vue public)
    cases.push_back({"sans rebonds (GI)", 0, 0, [](RenderSettings& r) { r.gi = false; }});
    cases.push_back({"sans fumee volumetrique", 0, 0, [](RenderSettings& r) { r.volumetrics = false; }});
    cases.push_back({"sans taches sur surfaces", 0, 0, [](RenderSettings& r) { r.surface_lights = false; }});
    cases.push_back({"sans reflets", 0, 0, [](RenderSettings& r) { r.specular = false; }});
    cases.push_back({"sans bloom", 0, 0, [](RenderSettings& r) { r.bloom = false; }});
    // sol mouille (eau 0,8 : flaques) avec le reflet miroir
    cases.push_back({"sol mouille / public", 0, SC_DEFAULT, [](RenderSettings& r) { r.floor_wet = 0.8f; }});
    cases.push_back({"sol mouille + gobo + prisme 8 / scene", 1, SC_GOBO_PRISM, [](RenderSettings& r) { r.floor_wet = 0.8f; }});
}

void start_case() {
    const Case& c = cases[index];
    app.rs = defaults;
    if (c.opts) c.opts(app.rs);
    apply_scenario(c.scenario);
    app.rig.instant_moves = true;
    app.rig.update(0);
    app.rig.instant_moves = false;
    app.fog.prefill();
    app.time = 0;
    app.renderer.reset_quality();
    app.paused = frozen;
    const View& v = VIEWS[c.view];
    app.cam.pos = v.pos;
    app.cam.yaw = v.yaw;
    app.cam.pitch = v.pitch;
    app.cam.update_basis();
    frame_in_case = 0;
    samples.clear();
    order.clear();
    totals.clear();
    cpu_frames.clear();
    cpu_rig.clear();
    cpu_fog.clear();
    cpu_render.clear();
    cpu_wait.clear();
    cpu_total.clear();
    beam_frags.clear();
    gpu_gaps.clear();
    outside.clear();
}

void log(const char* fmt, ...) {
    char buf[1024];
    va_list ap;
    va_start(ap, fmt);
    std::vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    std::fputs(buf, stdout);
    std::fflush(stdout);
    if (out) {
        std::fputs(buf, out);
        std::fflush(out);
    }
}

void begin() {
    active = true;
    defaults = app.rs;
    app.show_ui = false;
    build_cases();
#if defined(_WIN32)
    std::string cmd = "mkdir \"" + dir + "\" 2>nul";
#else
    std::string cmd = "mkdir -p '" + dir + "'";
#endif
    (void)std::system(cmd.c_str());
    out = std::fopen((dir + "/resultats.txt").c_str(), "w");
    frames_csv = std::fopen((dir + "/images.csv").c_str(), "w");
    if (frames_csv) std::fprintf(frames_csv, "cas;image;duree_ms;cpu_ms;attente_gpu_ms;gpu_ms\n");
    index = 0;
    start_case();
}

float median(std::vector<float> v) {
    if (v.empty()) return 0;
    std::nth_element(v.begin(), v.begin() + v.size() / 2, v.end());
    return v[v.size() / 2];
}

// Appele apres le rendu de chaque image.
void after_frame(int w, int h) {
    if (!active) return;
    // duree reelle de l'image (sapp_frame_duration() est plafonnee a 100 ms)
    static uint64_t lap = 0;
    const double frame_ms_now = stm_ms(stm_laptime(&lap));
    frame_in_case++;
    if (frame_in_case > WARMUP) {
        cpu_frames.push_back((float)frame_ms_now);
        if (frames_csv) std::fprintf(frames_csv, "%d;%d;%.3f;%.3f;%.3f;%.3f\n", index + 1, frame_in_case, frame_ms_now, app.timings.cpu_ms,
                                     gpuprof::last_wait_ms(), gpuprof::last_total_ms());
        outside.push_back((float)frame_ms_now - app.timings.cpu_ms);
        cpu_rig.push_back(app.timings.rig_ms);
        cpu_fog.push_back(app.timings.fog_ms);
        cpu_render.push_back(app.timings.render_cpu_ms - gpuprof::last_wait_ms());
        cpu_wait.push_back(gpuprof::last_wait_ms());
        cpu_total.push_back(app.timings.cpu_ms - gpuprof::last_wait_ms());
        if (gpuprof::last_id() != last_id) {
            last_id = gpuprof::last_id();
            for (const gpuprof::Section& s : gpuprof::last()) {
                if (!samples.count(s.name)) order.push_back(s.name);
                samples[s.name].push_back(s.ms);
            }
            totals.push_back(gpuprof::last_total_ms());
            beam_frags.push_back((float)gpuprof::last_fragments());
            gpu_gaps.push_back(gpuprof::last_gap_ms());
        }
    }
    if (frame_in_case < WARMUP + MEASURE) return;
    const Case& c = cases[index];
    char shot[32];
    std::snprintf(shot, sizeof(shot), "/%02d.bmp", index + 1);
    gpuprof::save_backbuffer_bmp(dir + shot);
    auto mean = [](const std::vector<float>& v) {
        double s = 0;
        for (float x : v) s += x;
        return v.empty() ? 0.0 : s / v.size();
    };
    // duree d'image : moyenne (= vraies images par seconde ; la mediane trompe quand les images
    // alternent entre tres courtes et tres longues). GPU : moyenne, et mediane (moins sensible
    // aux autres programmes qui utilisent la carte).
    const double frame_ms = mean(cpu_frames);
    const double gpu_ms = mean(totals);
    if (index == 0) log("LyreViz banc d'essai : %d x %d, %d lyres\n", w, h, (int)app.rig.fixtures.size());
    log("\n[%02d] %s\n  image : %.2f ms (%.1f img/s)   GPU : %.2f ms (mediane %.2f)\n", index + 1, c.name.c_str(), frame_ms,
        1000.0 / frame_ms, gpu_ms, median(totals));
    for (const std::string& n : order) log("    %-26s %7.3f ms   (moyenne %.3f)\n", n.c_str(), median(samples[n]), mean(samples[n]));
    log("  CPU (moyennes) : %.2f ms dont lyres %.2f, fumee %.2f, preparation du rendu %.2f ; attente du GPU %.2f ms\n",
        mean(cpu_total), mean(cpu_rig), mean(cpu_fog), mean(cpu_render), mean(cpu_wait));
    log("  Qualite adaptative : %.2f\n", app.renderer.stats.quality);
    log("  GPU entre deux images (presentation, autres programmes) : %.2f ms ; hors image (presentation, fenetre) : %.2f ms\n",
        median(gpu_gaps), median(outside));
    log("  Fumee : %.1f millions de couples (pixel, faisceau) calcules ; faisceaux par niveau %d / %d / %d ; tables : %d lignes, %.2f millions de cases, echelle %.2f\n",
        median(beam_frags) / 1e6, app.renderer.stats.tier_count[0], app.renderer.stats.tier_count[1], app.renderer.stats.tier_count[2],
        app.renderer.stats.table_rows, app.renderer.stats.table_cells / 1e6, app.renderer.stats.table_scale);
    index++;
    if (index >= (int)cases.size()) {
        if (out) std::fclose(out);
        out = nullptr;
        if (frames_csv) std::fclose(frames_csv);
        frames_csv = nullptr;
        active = false;
        sapp_request_quit();
        return;
    }
    start_case();
}

}  // namespace bench

static const char* g_exe_path = "";   // pour trouver assets/ a cote de l'executable

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
    if (!app.floor.load(g_exe_path, 0.32f)) std::printf("Sol : texture non chargee (%s), beton uni\n", app.floor.error.c_str());
    app.fog.init(app.scene.bounds_min, app.scene.bounds_max);
    app.renderer.init(app.scene, app.gobos, app.fog, app.floor, app.rs.floor_aniso);
    gpuprof::init();
    gpuprof::enable_stats(g_stats);
    app.cam.update_basis();
    if (g_bench_requested) bench::begin();
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
    // banc d'essai : pas de temps constant, pour des images identiques d'une mesure a l'autre
    const float dt = bench::active ? 1.0f / 60.0f : std::min((float)sapp_frame_duration(), 0.1f);
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

    if (!bench::active) update_camera(dt);

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

    app.timings.cpu_ms = (float)stm_ms(stm_since(t0));
    const float frame_ms = (float)(sapp_frame_duration() * 1000.0);
    app.timings.frame_ms = app.timings.frame_ms * 0.95f + frame_ms * 0.05f;
    app.timings.fps = app.timings.frame_ms > 0 ? 1000.0f / app.timings.frame_ms : 0;

    bench::after_frame(w, h);
    if (g_quit_after_frames > 0 && (int)sapp_frame_count() >= g_quit_after_frames) {
        std::printf("Images rendues : %d, temps moyen %.2f ms\n", (int)sapp_frame_count(), app.timings.frame_ms);
        if (!g_shot_path.empty()) gpuprof::save_backbuffer_bmp(g_shot_path);
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
            if ((int)ev->key_code >= 0 && (int)ev->key_code < 512 && !io.WantCaptureKeyboard) app.keys[ev->key_code] = true;
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
            if ((int)ev->key_code >= 0 && (int)ev->key_code < 512) app.keys[ev->key_code] = false;
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

// --set nom=valeur : change un reglage de l'onglet Rendu au lancement (mesures, comparaisons).
static bool set_render_option(RenderSettings& r, const char* kv) {
    const char* eq = std::strchr(kv, '=');
    if (!eq) return false;
    const std::string k(kv, eq - kv);
    const float v = (float)std::atof(eq + 1);
    if (k == "samples") r.vol_samples = (int)v;
    else if (k == "voldiv") r.vol_div = (int)v;
    else if (k == "temporal") r.temporal = v != 0;
    else if (k == "history") r.temporal_weight = v;
    else if (k == "gi") r.gi = v != 0;
    else if (k == "volumetrics") r.volumetrics = v != 0;
    else if (k == "surfaces") r.surface_lights = v != 0;
    else if (k == "specular") r.specular = v != 0;
    else if (k == "bloom") r.bloom = v != 0;
    else if (k == "prepass") r.depth_prepass = v != 0;
    else if (k == "analytic") r.analytic_beams = v != 0;
    else if (k == "tiers") r.beam_tiers = v != 0;
    else if (k == "soft") r.soft_lights = v != 0;
    else if (k == "adaptive") r.adaptive = v != 0;
    else if (k == "fps") r.target_fps = v;
    else if (k == "scale") r.render_scale = v;
    else if (k == "floor") r.floor_texture = v != 0;
    else if (k == "floortile") r.floor_tile = v;
    else if (k == "wet") r.floor_wet = v;
    else if (k == "flooraniso") r.floor_aniso = (int)v;
    // fumee
    else if (k == "density") app.fog_settings.density = v;
    else if (k == "haze") app.fog_settings.haze = v;
    else if (k == "smoke") app.fog_settings.smoke = v;
    else if (k == "detail") app.fog_settings.detail_strength = v;
    else return false;
    return true;
}

sapp_desc sokol_main(int argc, char* argv[]) {
    if (argc > 0) g_exe_path = argv[0];
    for (int i = 1; i < argc; i++) {
        if (!std::strcmp(argv[i], "--frames") && i + 1 < argc) g_quit_after_frames = std::atoi(argv[++i]);
        else if (!std::strcmp(argv[i], "--novsync")) g_novsync = true;
        else if (!std::strcmp(argv[i], "--noui")) app.show_ui = false;
        else if (!std::strcmp(argv[i], "--nogi")) app.rs.gi = false;
        else if (!std::strcmp(argv[i], "--scale") && i + 1 < argc) app.rs.render_scale = (float)std::atof(argv[++i]);
        else if (!std::strcmp(argv[i], "--fullscreen")) g_fullscreen = true;
        else if (!std::strcmp(argv[i], "--bench")) { g_bench_requested = true; g_novsync = true; }
        else if (!std::strcmp(argv[i], "--quick")) bench::quick = true;
        else if (!std::strcmp(argv[i], "--static")) bench::frozen = true;
        else if (!std::strcmp(argv[i], "--stats")) g_stats = true;
        else if (!std::strcmp(argv[i], "--shot") && i + 1 < argc) g_shot_path = argv[++i];
        else if (!std::strcmp(argv[i], "--benchdir") && i + 1 < argc) bench::dir = argv[++i];
        else if (!std::strcmp(argv[i], "--set") && i + 1 < argc) {
            if (!set_render_option(app.rs, argv[++i])) std::printf("Option inconnue : %s\n", argv[i]);
        }
    }
    sapp_desc d = {};
    d.init_cb = init;
    d.frame_cb = frame;
    d.cleanup_cb = cleanup;
    d.event_cb = event;
    d.width = 1600;
    d.height = 900;
    d.high_dpi = true;
    d.fullscreen = g_fullscreen;
    d.swap_interval = 1;
#if defined(LYREVIZ_LEGACY_SAPP)
    if (g_novsync) d.swap_interval = 0;   // ancienne version de sokol_app (Mac avec un Xcode < 15)
#else
    d.disable_vsync = g_novsync;
#endif
    d.window_title = "LyreViz - banc d'essai lyres";
    d.logger.func = slog_func;
    d.win32.console_attach = true;
    return d;
}
