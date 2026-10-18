// =====================================================================================
//  LyreViz - banc d'essai de visualisation de lyres (moving heads) en C++
//  sokol (Metal / Direct3D 11 / OpenGL) + Dear ImGui
// =====================================================================================
#include "ambiances.h"
#include "app.h"
#include "bench_explore.h"
#include "gpu_profiler.h"
#include "spectacles.h"
#include "sokol_app.h"
#include "sokol_gfx.h"
#include "sokol_glue.h"
#include "sokol_log.h"
#include "sokol_time.h"
#include "imgui.h"
#include "util/sokol_imgui.h"
#include <algorithm>
#include <cstdio>
#if defined(_WIN32)
// les 3 fonctions de fenetre utilisees par --behind (windows.h definit des macros SC_... qui genent)
extern "C" {
__declspec(dllimport) void* __stdcall GetForegroundWindow(void);
__declspec(dllimport) int __stdcall SetForegroundWindow(void* hwnd);
__declspec(dllimport) int __stdcall SetWindowPos(void* hwnd, void* after, int x, int y, int cx, int cy, unsigned flags);
}
#pragma comment(lib, "user32")
#endif
#include <cstdarg>
#include <cstdlib>
#include <cstring>
#include <map>
#include <string>
#include <vector>

App app;

static int g_quit_after_frames = 0;   // --frames N : quitte apres N images (tests)
static bool g_novsync = false;
static bool g_fullscreen = true;    // plein ecran sans bordure au lancement (--windowed : fenetre ; F11 bascule)
// --behind : la fenetre s'ouvre derriere les autres et rend le clavier a la fenetre active (bancs lances
// pendant que l'on travaille a cote). Elle reste visible si on la ramene devant. Mais Windows donne la
// priorite a la fenetre active : derriere, le GPU est 5 a 15 % plus lent dans les cas lourds (mesure).
static bool g_behind = false;
#if defined(_WIN32)
static void* g_prev_foreground = nullptr;
#endif
static bool g_bench_requested = false;
static int g_demo = -1;           // --demo [variante] : vue d'essai des gobos au sol (aberration chromatique)
static void setup_demo();
static int g_demo_laser = -1;     // --demo-laser [variante] : vues d'essai des lasers (formes, degrades, programmation)
static bool g_play = false;        // --play : les vues d'essai (--demo, --demo-laser) demarrent sans pause, pas de 1/60 s
                                   // (images en mouvement : --frames 30 = 0,5 s)
static bool g_cam_set = false;    // --cam x,y,z,cap,site : camera au lancement (cap et site en degres)
static float g_cam[5];
static void setup_demo_laser();
static int g_ambiance = -1;       // --ambiance N : demarre sur l'ambiance N (1 a 60 ; 21 a 60 : scenes, src/scenes)
static std::string g_shot_path;
static bool g_stats = false;      // --stats : compte les couples (pixel, faisceau) de la fumee et des lasers
static bool set_render_option(RenderSettings& r, const char* kv);

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
    // banc des lasers
    {"dans les nappes", {8, 1.7f, 0.3f}, PI, 0.25f},         // L3 : au milieu des rideaux
    {"gros plan", {14, 12.5f, -2.2f}, PI * 0.93f, -0.32f},   // L5 : nappe vue de pres, en biais
    // banc des lyres (--bench-lyres) : vers le point (4, 0, 0) que visent les lyres (ambiance Couronne), a 17 m
    {"vers le point", {20, 2.5f, 6}, -2.7828f, -0.1450f},
};
enum { V_PUBLIC = 0, V_SCENE, V_TRUSSES, V_INSIDE, V_CLOSEUP, V_FOCUS };

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
    // banc des lasers (--bench-lasers)
    int lasers = LP_OFF;     // motif
    int laser_count = 200;   // boitiers allumes
    int lyres = 200;         // lyres allumees (une sur deux pour 100)
    const char* ilda = nullptr;   // banque ILDA jouee par tous les boitiers (programmeur)
    float fog = 1.0f;        // multiplicateur de la densite de la fumee
    // banc des lyres (--bench-lyres) : programmation des lyres apres le scenario, et lyres en mouvement meme avec --static
    void (*lyres_setup)() = nullptr;
    bool moving = false;
    int explore = -1;        // banc d'exploration (--bench-explore) : indice dans explore_cfgs
};
std::vector<Case> cases;
bool active = false;
bool quick = false;
std::vector<int> only;     // --cases 3,14 : seulement ces cas (numeros de la liste complete)
bool laser_bench = false;   // --bench-lasers : cas L1 a L6 et M1 (PLAN-LASERS.md, section 10)
bool lyre_bench = false;    // --bench-lyres : lyres qui visent toutes le meme point, zoom, mouvement (lasers eteints)
// --bench-explore : d'ou vient le lag des lasers (src/bench_explore.h) ; --nosweep : sans le balayage, --random N :
// N programmations au hasard (graine --seed), --shots : enregistrer l'image de chaque cas (25 Mo chacune en 4K)
bool explore_bench = false, explore_sweep = true, shots = true;
int explore_random = 120;
unsigned explore_seed = 1;
std::vector<explore::Config> explore_cfgs;
FILE* explore_csv = nullptr;
bool laser_coll_default = true, laser_cache_default = true, laser_impacts_default = true;
FogSettings fog_defaults;
bool frozen = false;   // --static : lyres et fumee immobiles (comparaison d'images sans mouvement)
std::string dir = "bench";
int index = -1, frame_in_case = 0;
// --fast : 30 images de chauffe et 60 mesurees (au lieu de 60 et 150) : un banc complet en 20 s au lieu de 45.
int WARMUP = 60, MEASURE = 150;
// mesures image par image ; on garde la mediane (insensible aux pics dus a d'autres programmes)
std::map<std::string, std::vector<float>> samples;
std::vector<std::string> order;
std::vector<float> totals, cpu_frames;
std::vector<float> cpu_rig, cpu_fog, cpu_render, cpu_wait, cpu_total, beam_frags, gpu_gaps, outside;
std::vector<float> cpu_laser, cpu_laser_build, cpu_laser_hits, laser_pairs, laser_tile_avg, laser_tile_max, laser_tiles_hit;
FILE* frames_csv = nullptr;   // une ligne par image (diagnostic)
unsigned last_id = 0;
FILE* out = nullptr;
RenderSettings defaults;

// Banc des lasers : lasers seuls (lyres eteintes), puis le mix 100 lyres + 100 lasers, puis la scene sans lasers.
void build_laser_cases() {
    auto L = [](const char* name, int view, int pattern, int count = 200, int lyres = 0, float fog = 1.0f) {
        Case c{name, view, SC_DEFAULT, nullptr};
        c.lasers = pattern;
        c.laser_count = count;
        c.lyres = lyres;
        c.fog = fog;
        cases.push_back(c);
    };
    L("L1 eventails 200 x 1000 traits / public", V_PUBLIC, LP_FANS);
    if (!quick) {
        L("L1 eventails 200 x 1000 traits / scene", V_SCENE, LP_FANS);
        L("L1 eventails 200 x 1000 traits / sous les trusses", V_TRUSSES, LP_FANS);
    }
    L("L2 cones 200 x 32 segments / public", V_PUBLIC, LP_CONES);
    if (!quick) L("L2 cones 200 x 32 segments / scene", V_SCENE, LP_CONES);
    L("L3 camera dans les nappes", V_INSIDE, LP_CURTAINS);
    L("L4 200 x 8 traits separes / public", V_PUBLIC, LP_BEAMS);
    if (!quick) {
        L("L5 nappes en gros plan, fumee epaisse", V_CLOSEUP, LP_CLOSEUP, 200, 0, 4.0f);
        L("L6 traits vers le sol et les obstacles / public", V_PUBLIC, LP_FLOOR);
    }
    L("M1 100 lyres + 100 lasers / public", V_PUBLIC, LP_FANS, 100, 100);
    if (quick) return;
    L("M1 100 lyres + 100 lasers / scene", V_SCENE, LP_FANS, 100, 100);
    L("M1 100 lyres + 100 lasers / sous les trusses", V_TRUSSES, LP_FANS, 100, 100);
    L("sans lasers (scene seule) / public", V_PUBLIC, LP_OFF);
    // programmeur : formes, degrades, diffraction et effets sur les 200 boitiers (lasers seuls)
    L("L7 programmeur : formes, degrades, effets / public", V_PUBLIC, LP_PROGRAM);
    // fichiers ILDA (PLAN-LASERS.md, etape 3 bis) : chaque boitier joue un fichier de la banque, en boucle
    auto I = [&](const char* name, const char* bank) {
        L(name, V_PUBLIC, LP_PROGRAM);
        cases.back().ilda = bank;
    };
    I("I1 ILDA nappes (banque Nappes) / public", "Nappes");
    I("I2 ILDA faisceaux (banque Faisceaux) / public", "Faisceaux");
    I("I3 ILDA geometrie (banque Geometrie) / public", "G\xc3\xa9om\xc3\xa9trie");
    I("I4 ILDA tunnels (banque Tunnels) / public", "Tunnels");
    // L1 en mode ligne : les memes eventails en nappes continues (au lieu de 1 000 traits)
    L("L1 en mode ligne (nappes continues) / public", V_PUBLIC, LP_FANS_LINE);
    // moteur de trace (PLAN-LASERS.md, etape 9) : banques generees (src/ilda.cpp, add_generated)
    I("P1 trace : dessins a main levee (banque Crayon) / public", "Crayon");
    I("P2 trace : formes (banque Formes) / public", "Formes");
    I("P3 trace : sinus modules et Lissajous animes (banque Sinus) / public", "Sinus");
}

// Banc des lyres : les 184 lyres des trusses et du pont visent toutes le meme point au sol (4, 0, 0) (ambiance
// Couronne), ou pendent droit (sans convergence, meme nombre de faisceaux) ; zooms 3, 20 et 50 deg ; vue vers le point
// (17 m) ou du public ; immobiles, ou en mouvement. Lasers eteints : on ne mesure que les lyres.
template <int ZOOM, bool FOCUS, int FROST10 = 0, int MOVE = 0> void lyres_program() {
    app.rig.aim_points[0] = {4, 0, 0};
    for (Fixture& f : app.rig.fixtures) {
        FixtureParams& p = f.base;
        p = FixtureParams();
        if (f.mount.group > 4) {   // sol et nez de scene : eteints
            p.dimmer = 0;
            continue;
        }
        p.dimmer = 1;
        p.zoom = (float)ZOOM;
        p.frost = 0.1f * (float)FROST10;
        p.focus = 18;
        if (FOCUS) p.aim_point = 0;
        else p.tilt = f.mount.group == 4 ? 30.0f : 0.0f;
    }
    app.rig.effects.clear();
    if (MOVE) {
        // deplacement : cercle (convergence) ou vagues pan et tilt (sans), comme on deplace des lyres a la main
        for (Fixture& f : app.rig.fixtures) f.selected = f.base.dimmer > 0;
        app.rig.add_effect(FOCUS ? FX_CIRCLE : FX_TILT_WAVE);
        app.rig.effects.back().size = FOCUS ? 6.0f : 25.0f;
        app.rig.effects.back().speed = 0.4f;
        app.rig.effects.back().spread = FOCUS ? 0.0f : 360.0f;
        app.rig.select_all(false);
    }
}

// Ambiance Couronne (n° 9) telle quelle (cercle en mouvement), puis avec ses lyres zoomees
template <int ZOOM> void couronne_program() {
    apply_ambiance(8);
    if (ZOOM > 0)
        for (Fixture& f : app.rig.fixtures)
            if (f.base.dimmer > 0) f.base.zoom = (float)ZOOM;
}

void build_lyre_cases() {
    auto C = [](const char* name, int view, void (*setup)(), bool moving = false) {
        Case c{name, view, SC_DEFAULT, nullptr};
        c.lyres_setup = setup;
        c.moving = moving;
        cases.push_back(c);
    };
    C("C1 convergence zoom 3 / vers le point", V_FOCUS, lyres_program<3, true>);
    C("C2 convergence zoom 20 / vers le point", V_FOCUS, lyres_program<20, true>);
    C("C3 convergence zoom 50 / vers le point", V_FOCUS, lyres_program<50, true>);
    if (quick) return;
    C("C4 convergence zoom 50 + frost 0.6 / vers le point", V_FOCUS, lyres_program<50, true, 6>);
    C("C5 convergence zoom 3 / public", V_PUBLIC, lyres_program<3, true>);
    C("C6 convergence zoom 50 / public", V_PUBLIC, lyres_program<50, true>);
    C("D1 sans convergence zoom 3 / vers le point", V_FOCUS, lyres_program<3, false>);
    C("D2 sans convergence zoom 20 / vers le point", V_FOCUS, lyres_program<20, false>);
    C("D3 sans convergence zoom 50 / vers le point", V_FOCUS, lyres_program<50, false>);
    C("M1 convergence zoom 20 en mouvement / vers le point", V_FOCUS, lyres_program<20, true, 0, 1>, true);
    C("M2 sans convergence zoom 20 en mouvement / vers le point", V_FOCUS, lyres_program<20, false, 0, 1>, true);
    C("M3 convergence zoom 50 en mouvement / vers le point", V_FOCUS, lyres_program<50, true, 0, 1>, true);
    // ambiance Couronne (reglages de l'image de l'ambiance : en dernier)
    C("K1 ambiance Couronne / public", V_PUBLIC, couronne_program<0>, true);
    C("K2 ambiance Couronne / vers le point", V_FOCUS, couronne_program<0>, true);
    C("K3 Couronne zoom 20 / vers le point", V_FOCUS, couronne_program<20>, true);
    C("K4 Couronne zoom 45 / vers le point", V_FOCUS, couronne_program<45>, true);
}

// Banc d'exploration des lasers : balayage reglage par reglage, puis programmations au hasard (lyres eteintes).
void build_explore_cases() {
    explore_cfgs = explore::build(explore_sweep, explore_random, explore_seed);
    for (size_t i = 0; i < explore_cfgs.size(); i++) {
        Case c{explore::name(explore_cfgs[i]), explore_cfgs[i].view, SC_DEFAULT, nullptr};
        c.lyres = 0;
        c.lasers = LP_PROGRAM;
        c.fog = explore_cfgs[i].fog;
        c.explore = (int)i;
        cases.push_back(c);
    }
}

void build_cases() {
    if (explore_bench) {
        build_explore_cases();
        return;
    }
    if (laser_bench) {
        build_laser_cases();
        return;
    }
    if (lyre_bench) {
        build_lyre_cases();
        return;
    }
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
    app.fog_settings = fog_defaults;
    app.fog_settings.density *= c.fog;
    app.lasers.collisions = laser_coll_default;
    app.lasers.figure_cache = laser_cache_default;
    app.lasers.impacts = laser_impacts_default;
    if (c.explore >= 0)
        for (const std::string& kv : explore_cfgs[c.explore].sets) set_render_option(app.rs, kv.c_str());
    if (c.opts) c.opts(app.rs);
    apply_scenario(c.scenario);
    if (c.lyres_setup) c.lyres_setup();
    // banc des lasers : lyres allumees (toutes, une sur deux ou aucune), motif des lasers, fumee
    if (c.lyres < 200)
        for (size_t i = 0; i < app.rig.fixtures.size(); i++)
            if (c.lyres <= 0 || (i & 1)) app.rig.fixtures[i].base.dimmer = 0;
    app.lasers.pattern = c.lasers;
    app.lasers.count = c.laser_count;
    if (c.explore >= 0) explore::program(explore_cfgs[c.explore]);
    else if (c.lasers == LP_PROGRAM) {
        if (c.ilda) app.lasers.program_ilda(c.ilda);
        else app.lasers.program_showcase();
    }
    app.lasers.time = 0;
    app.lasers.update(0.0f, 0.0f, app.scene.bounds_min, app.scene.bounds_max);   // galvos en place
    app.rig.instant_moves = true;
    app.rig.update(0);
    app.rig.update(0);   // 2e fois : la visee (aim_angles) part de la tete, placee par la 1re
    app.rig.instant_moves = false;
    app.fog.prefill();
    app.time = 0;
    app.renderer.reset_quality();
    app.paused = frozen && !c.moving;
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
    for (std::vector<float>* v : {&cpu_laser, &cpu_laser_build, &cpu_laser_hits, &laser_pairs, &laser_tile_avg, &laser_tile_max, &laser_tiles_hit}) v->clear();
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
    fog_defaults = app.fog_settings;
    laser_coll_default = app.lasers.collisions;
    laser_cache_default = app.lasers.figure_cache;
    laser_impacts_default = app.lasers.impacts;
    app.show_ui = false;
    build_cases();
    if (!only.empty()) {
        std::vector<Case> kept;
        for (int k : only)
            if (k >= 1 && k <= (int)cases.size()) kept.push_back(cases[k - 1]);
        cases = kept;
    }
#if defined(_WIN32)
    std::string cmd = "mkdir \"" + dir + "\" 2>nul";
#else
    std::string cmd = "mkdir -p '" + dir + "'";
#endif
    (void)std::system(cmd.c_str());
    out = std::fopen((dir + "/resultats.txt").c_str(), "w");
    frames_csv = std::fopen((dir + "/images.csv").c_str(), "w");
    if (frames_csv) std::fprintf(frames_csv, "cas;image;duree_ms;cpu_ms;attente_gpu_ms;gpu_ms\n");
    if (explore_bench) {
        explore_csv = std::fopen((dir + "/exploration.csv").c_str(), "w");
        if (explore_csv)
            std::fprintf(explore_csv, "cas;%s;image_ms;gpu_ms;gpu_mediane_ms;lasers_gpu_ms;las_impacts;las_tri;las_arcs;las_nappes;"
                         "las_sorties;composition;surfaces;fumee_lyres;reflet;bloom;image_finale;autres_gpu;cpu_ms;cpu_laser_ms;"
                         "cpu_morceaux_ms;cpu_impacts_ms;attente_gpu_ms;allumes;segments;traits_total;impacts;variante_fumee;"
                         "ilda_faisceaux;ilda_droites;ilda_arcs;en_cache;couples_M;tuiles;seg_par_tuile;seg_par_tuile_max\n",
                         explore::csv_header().c_str());
    }
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
        cpu_laser.push_back(app.timings.laser_ms);
        cpu_laser_build.push_back(app.lasers.cpu_build_ms);
        cpu_laser_hits.push_back(app.lasers.cpu_hits_ms);
        {
            // chaque couple (tuile, segment) calcule les 256 pixels de la tuile
            const RenderStats& rs = app.renderer.stats;
            laser_pairs.push_back((float)(rs.laser_tile_pairs * 256.0));
            laser_tile_avg.push_back(rs.laser_tiles_hit > 0 ? (float)(rs.laser_tile_pairs / rs.laser_tiles_hit) : 0.0f);
            laser_tile_max.push_back((float)rs.laser_tile_max);
            laser_tiles_hit.push_back((float)rs.laser_tiles_hit);
        }
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
    if (shots) gpuprof::save_backbuffer_bmp(dir + shot);
    auto mean = [](const std::vector<float>& v) {
        double s = 0;
        for (float x : v) s += x;
        return v.empty() ? 0.0 : s / v.size();
    };
    if (explore_csv && c.explore >= 0) {
        // temps GPU moyens par passe (ils s'additionnent jusqu'au total), compteurs de la derniere image
        auto sec = [&](const char* n) {
            auto it = samples.find(n);
            return it == samples.end() ? 0.0 : mean(it->second);
        };
        double las = 0, refl = 0;
        for (const std::string& n : order) {
            if (n.rfind("lasers", 0) == 0) las += mean(samples[n]);
            if (n.rfind("reflet", 0) == 0) refl += mean(samples[n]);
        }
        const double surf = sec("scene (surfaces)") + sec("lyres douces (1/4)");
        const double fum = sec("fumee : faisceaux") + sec("fumee : faisceaux 1/2 et 1/4") + sec("fumee : faisceaux pleine res.") +
                           sec("fumee : accumulation");
        const double fin = sec("image finale + interface") + sec("image finale (FSR)") + sec("FSR : agrandissement (EASU)") +
                           sec("FSR : nettete (RCAS) + interface");
        const double listed = las + refl + surf + fum + fin + sec("composition") + sec("bloom");
        const RenderStats& st = app.renderer.stats;
        std::fprintf(explore_csv, "%d;%s;%.3f;%.3f;%.3f;%.3f;%.3f;%.3f;%.3f;%.3f;%.3f;%.3f;%.3f;%.3f;%.3f;%.3f;%.3f;%.3f;"
                     "%.3f;%.3f;%.3f;%.3f;%.3f;%d;%d;%d;%d;%d;%d;%d;%d;%d;%.2f;%.0f;%.2f;%.0f\n",
                     index + 1, explore::csv_row(explore_cfgs[c.explore], VIEWS[c.view].name).c_str(), mean(cpu_frames), mean(totals),
                     median(totals), las, sec("lasers : impacts"), sec("lasers : tri par tuiles"), sec("lasers : arcs"),
                     sec("lasers : fumee"), sec("lasers : sorties"), sec("composition"), surf, fum, refl, sec("bloom"), fin,
                     mean(totals) - listed, mean(cpu_total), mean(cpu_laser), mean(cpu_laser_build), mean(cpu_laser_hits),
                     mean(cpu_wait), app.lasers.lit, st.laser_segments, app.lasers.total_traits, st.laser_hits, st.laser_fog_variant,
                     app.lasers.ilda_beams, app.lasers.ilda_sheets, app.lasers.ilda_arcs, app.lasers.cached_lasers,
                     g_stats ? median(laser_pairs) / 1e6 : -1.0, g_stats ? (double)median(laser_tiles_hit) : -1.0,
                     g_stats ? (double)median(laser_tile_avg) : -1.0, g_stats ? (double)median(laser_tile_max) : -1.0);
        std::fflush(explore_csv);
    }
    // duree d'image : moyenne (= vraies images par seconde ; la mediane trompe quand les images
    // alternent entre tres courtes et tres longues). GPU : moyenne, et mediane (moins sensible
    // aux autres programmes qui utilisent la carte).
    const double frame_ms = mean(cpu_frames);
    const double gpu_ms = mean(totals);
    if (index == 0) {
        if (laser_bench || explore_bench) {
            log("LyreViz banc d'essai lasers : %d x %d, %d emplacements de lasers\n", w, h, (int)app.lasers.mounts.size());
            log("Volutes fines : generees en %.0f ms ; ecart type par niveau de mip :", app.renderer.volutes_build_ms);
            for (float s : app.renderer.volutes_sd) log(" %.4f", s);
            log("\n");
        } else log("LyreViz banc d'essai : %d x %d, %d lyres\n", w, h, (int)app.rig.fixtures.size());
    }
    log("\n[%02d] %s\n  image : %.2f ms (%.1f img/s)   GPU : %.2f ms (mediane %.2f)\n", index + 1, c.name.c_str(), frame_ms,
        1000.0 / frame_ms, gpu_ms, median(totals));
    for (const std::string& n : order) log("    %-26s %7.3f ms   (moyenne %.3f)\n", n.c_str(), median(samples[n]), mean(samples[n]));
    log("  CPU (moyennes) : %.2f ms dont lyres %.2f, fumee %.2f, preparation du rendu %.2f ; attente du GPU %.2f ms\n",
        mean(cpu_total), mean(cpu_rig), mean(cpu_fog), mean(cpu_render), mean(cpu_wait));
    log("  Qualite adaptative : %.2f ; ombres : %d lyres, %d paires (lyre, pave)\n", app.renderer.stats.quality,
        app.renderer.stats.occluded_lights, app.renderer.stats.occ_pairs);
    log("  GPU entre deux images (presentation, autres programmes) : %.2f ms ; hors image (presentation, fenetre) : %.2f ms\n",
        median(gpu_gaps), median(outside));
    log("  Fumee : %.1f millions de couples (pixel, faisceau) calcules ; faisceaux par niveau %d / %d / %d ; tables : %d lignes, %.2f millions de cases, echelle %.2f\n",
        median(beam_frags) / 1e6, app.renderer.stats.tier_count[0], app.renderer.stats.tier_count[1], app.renderer.stats.tier_count[2],
        app.renderer.stats.table_rows, app.renderer.stats.table_cells / 1e6, app.renderer.stats.table_scale);
    if (laser_bench || explore_bench) {
        log("  Lasers : %d boitiers, %d segments, %d traits, %d impacts ; moteur CPU %.3f ms (morceaux %.3f, impacts %.3f) ; fumee : "
            "variante %d\n", app.lasers.lit, app.renderer.stats.laser_segments, app.lasers.total_traits, app.renderer.stats.laser_hits,
            mean(cpu_laser), mean(cpu_laser_build), mean(cpu_laser_hits), app.renderer.stats.laser_fog_variant);
        if (app.lasers.ilda_points > 0)
            log("  ILDA : %d points, %d faisceaux, %d droites, %d arcs (niveau de tolerance %d)\n", app.lasers.ilda_points,
                app.lasers.ilda_beams, app.lasers.ilda_sheets, app.lasers.ilda_arcs, app.lasers.ilda_bias);
        if (g_stats && app.renderer.stats.laser_segments > 0)
            log("  Lasers (compteurs) : %.0f tuiles de 16 px touchees sur %d, %.1f segments par tuile touchee (%.0f au plus) ; "
                "%.1f millions de couples (pixel, segment) ; %d segments perdus (grosses tuiles pleines)\n",
                median(laser_tiles_hit), app.renderer.stats.laser_tiles_x * app.renderer.stats.laser_tiles_y, median(laser_tile_avg),
                median(laser_tile_max), median(laser_pairs) / 1e6, app.renderer.stats.laser_bin_overflow);
    }
    index++;
    if (index >= (int)cases.size()) {
        if (out) std::fclose(out);
        out = nullptr;
        if (frames_csv) std::fclose(frames_csv);
        frames_csv = nullptr;
        if (explore_csv) std::fclose(explore_csv);
        explore_csv = nullptr;
        active = false;
        sapp_request_quit();
        return;
    }
    start_case();
}

}  // namespace bench

static const char* g_exe_path = "";   // pour trouver assets/ a cote de l'executable
static const char* g_ilda_dir = "";   // --ilda dossier : bibliotheque ILDA (sinon server/storage/ilda, cherche en remontant)

static float ground_height(vec3 p) {
    // la scene (cote -X) est surelevee
    if (p.x < -34.0f && std::fabs(p.z) < 16.0f) return 1.6f;
    return 0.0f;
}

static void init() {
#if defined(_WIN32)
    if (g_behind) {
        // la fenetre vient d'etre affichee (et activee) par sokol : derriere toutes les autres, et le
        // clavier rendu a la fenetre qui l'avait
        const unsigned SWP_NOSIZE_ = 0x0001, SWP_NOMOVE_ = 0x0002, SWP_NOACTIVATE_ = 0x0010;
        void* const HWND_BOTTOM_ = (void*)1;
        SetWindowPos((void*)sapp_win32_get_hwnd(), HWND_BOTTOM_, 0, 0, 0, 0, SWP_NOMOVE_ | SWP_NOSIZE_ | SWP_NOACTIVATE_);
        if (g_prev_foreground) SetForegroundWindow(g_prev_foreground);
    }
#endif
    sg_desc desc = {};
    desc.environment = sglue_environment();
    desc.logger.func = slog_func;
    desc.uniform_buffer_size = 4 * 1024 * 1024;
    desc.shader_pool_size = 96;   // 32 par defaut : depasse avec les variantes des lasers (les dernieres n'etaient pas creees)
    desc.pipeline_pool_size = 128;   // 64 par defaut : depasse avec les variantes de la fumee des lasers (idem, sans message)
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
    app.lasers.build(app.scene);
    app.lasers.ilda.scan(g_exe_path, g_ilda_dir);
    std::printf("ILDA : %d fichiers dans %s\n", (int)app.lasers.ilda.clips.size(), app.lasers.ilda.root.c_str());
    app.gobos.generate();
    if (!app.floor.load(g_exe_path, 0.32f)) std::printf("Sol : texture non chargee (%s), beton uni\n", app.floor.error.c_str());
    app.fog.init(app.scene.bounds_min, app.scene.bounds_max);
    app.renderer.init(app.scene, app.gobos, app.fog, app.floor, app.rs.floor_aniso);
    std::printf("Volutes fines des lasers : generees en %.0f ms ; ecart type par niveau :", app.renderer.volutes_build_ms);
    for (float s : app.renderer.volutes_sd) std::printf(" %.4f", s);
    std::printf("\n");
    gpuprof::init();
    gpuprof::enable_stats(g_stats);
    app.cam.update_basis();
    ambiance_capture_defaults();
    if (g_ambiance >= 0) apply_ambiance(g_ambiance);
    if (g_demo >= 0) setup_demo();
    if (g_demo_laser >= 0) setup_demo_laser();
    spectacle_start(app.lasers);   // --set spectacle=N : la scene programme les lasers
    if (g_play) app.paused = false;
    if (g_cam_set) {
        app.cam.pos = {g_cam[0], g_cam[1], g_cam[2]};
        app.cam.yaw = g_cam[3] * DEG;
        app.cam.pitch = g_cam[4] * DEG;
        app.cam.update_basis();
    }
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
        app.lasers.dyn_obstacles.push_back({c, fx * half.x, {0, half.y, 0}, fz * half.z});   // les lasers s'y arretent
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
    // touches physiques W A S D (= Z Q S D sur un clavier AZERTY) ; les fleches changent d'ambiance (voir event)
    if (!ui_kb) {
        vec3 f = app.character ? normalize(vec3(c.fwd.x, 0, c.fwd.z)) : c.fwd;
        vec3 r = c.right;
        if (app.keys[SAPP_KEYCODE_W]) move += f;
        if (app.keys[SAPP_KEYCODE_S]) move -= f;
        if (app.keys[SAPP_KEYCODE_D]) move += r;
        if (app.keys[SAPP_KEYCODE_A]) move -= r;
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
    // banc d'essai (et --play) : pas de temps constant, pour des images identiques d'une mesure a l'autre
    const float dt = (bench::active || g_play) ? 1.0f / 60.0f : std::min((float)sapp_frame_duration(), 0.1f);
    const int w = sapp_width(), h = sapp_height();
    if (!app.paused) app.time += dt;

    simgui_frame_desc_t fd = {};
    fd.width = w;
    fd.height = h;
    fd.delta_time = sapp_frame_duration();
    fd.dpi_scale = sapp_dpi_scale();
    simgui_new_frame(&fd);
    const uint64_t tu = stm_now();
    app.ambiance_tab = false;   // remis a vrai par l'onglet Ambiances s'il est affiche
    app.sel_kind = -1;          // idem : onglets Lyres, Effets (0) ou Lasers (1)
    if (app.show_ui) draw_ui();
    app.timings.ui_ms = (float)stm_ms(stm_since(tu));

    app.lasers.dyn_obstacles.clear();   // personnage : remis par add_avatar
    if (!bench::active) update_camera(dt);

    const uint64_t tr = stm_now();
    app.rig.update(app.paused ? 0.0f : dt);
    app.timings.rig_ms = (float)stm_ms(stm_since(tr));

    const uint64_t tf = stm_now();
    app.fog.update(app.paused ? 0.0f : dt, app.fog_settings, &app.rs.sfog);
    app.timings.fog_ms = (float)stm_ms(stm_since(tf));

    const uint64_t tl = stm_now();
    spectacle_update(app.lasers, app.paused ? 0.0f : dt);   // horloge du spectacle, enchainement des scenes
    app.lasers.update(app.time, app.paused ? 0.0f : dt, app.scene.bounds_min, app.scene.bounds_max);
    app.lasers.housings(app.renderer.dyn_cubes);
    app.timings.laser_ms = (float)stm_ms(stm_since(tl));

    const uint64_t tg = stm_now();
    simgui_flush();   // prepare l'interface (hors passe de rendu)
    app.renderer.render(app.cam, app.scene, app.rig, app.gobos, app.fog, app.fog_settings, app.rs, w, h, app.time, [] { simgui_draw(); },
                        &app.lasers);
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
    // banc d'essai et captures automatiques : clavier et souris ignores (on peut travailler a cote)
    if (bench::active || g_quit_after_frames > 0) return;
    const bool ui_used = simgui_handle_event(ev);
    ImGuiIO& io = ImGui::GetIO();
    switch (ev->type) {
        case SAPP_EVENTTYPE_KEY_DOWN:
            if ((int)ev->key_code >= 0 && (int)ev->key_code < 512 && !io.WantCaptureKeyboard) app.keys[ev->key_code] = true;
            if (io.WantCaptureKeyboard) break;
            if (ev->key_code == SAPP_KEYCODE_H) app.show_ui = !app.show_ui;
            if (ev->key_code == SAPP_KEYCODE_F11 && !ev->key_repeat) sapp_toggle_fullscreen();
            if (ev->key_code == SAPP_KEYCODE_F) {
                app.character = !app.character;
                if (app.character) app.player = {app.cam.pos.x, ground_height(app.cam.pos), app.cam.pos.z};
            }
            if (ev->key_code == SAPP_KEYCODE_P) app.paused = !app.paused;
            if (!ev->key_repeat) {
                // grille des ambiances, a tout moment (menu ferme ou autre onglet) : gauche / droite d'une case,
                // haut / bas d'une rangee (en boucle)
                int d = 0;
                if (ev->key_code == SAPP_KEYCODE_LEFT) d = -1;
                if (ev->key_code == SAPP_KEYCODE_RIGHT) d = 1;
                if (ev->key_code == SAPP_KEYCODE_UP) d = -AMBIANCE_COLS;
                if (ev->key_code == SAPP_KEYCODE_DOWN) d = AMBIANCE_COLS;
                if (d != 0) {
                    // les scenes des spectacles suivent les ambiances dans la meme grille (cases 60 a 89)
                    const int total = NUM_AMBIANCES + SPECTACLE_SCENES;
                    const int cur = g_spectacle.running ? NUM_AMBIANCES + g_spectacle.scene : app.ambiance;
                    const int next = ((cur + d) % total + total) % total;
                    if (next < NUM_AMBIANCES) {
                        apply_ambiance(next);
                    } else {
                        g_spectacle.scene = next - NUM_AMBIANCES;
                        spectacle_apply(app.lasers, true);
                    }
                }
            }
            if (ev->key_code == SAPP_KEYCODE_ESCAPE) { app.looking = false; sapp_lock_mouse(false); app.pick_aim = -1; app.sel_drag = false; }
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
            else if (ev->mouse_button == SAPP_MOUSEBUTTON_LEFT && !io.WantCaptureMouse && app.sel_kind >= 0 && !app.looking) {
                // selection a l'ecran (coordonnees de l'interface)
                const float k = io.DisplaySize.x / std::max(sapp_widthf(), 1.0f);
                app.sel_drag = true;
                app.sel_x0 = app.sel_x1 = ev->mouse_x * k;
                app.sel_y0 = app.sel_y1 = ev->mouse_y * k;
            }
            break;
        case SAPP_EVENTTYPE_MOUSE_UP:
            if (ev->mouse_button == SAPP_MOUSEBUTTON_RIGHT && app.looking) {
                app.looking = false;
                sapp_lock_mouse(false);
            }
            if (ev->mouse_button == SAPP_MOUSEBUTTON_LEFT && app.sel_drag) {
                const float k = io.DisplaySize.x / std::max(sapp_widthf(), 1.0f);
                app.sel_x1 = ev->mouse_x * k;
                app.sel_y1 = ev->mouse_y * k;
                app.sel_drag = false;
                select_in_rect((ev->modifiers & SAPP_MODIFIER_CTRL) ? 1 : ((ev->modifiers & SAPP_MODIFIER_SHIFT) ? 2 : 0));
            }
            break;
        case SAPP_EVENTTYPE_MOUSE_MOVE:
            if (app.sel_drag) {
                const float k = io.DisplaySize.x / std::max(sapp_widthf(), 1.0f);
                app.sel_x1 = ev->mouse_x * k;
                app.sel_y1 = ev->mouse_y * k;
            }
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

// --demo : 3 lyres en blanc, gobo etoile + prisme 8, nettes sur le sol, vues en biais depuis la salle.
// Sert a verifier les franges colorees de l'aberration chromatique (captures avec --frames et --shot).
// Variantes : --demo 1 hors de la mise au point (nettete a 60 % de la distance), --demo 2 frost 0,4,
// --demo 3 iris 0,6 et zoom plus large, --demo 4 pont de scene en rasant (taches tres allongees),
// --demo 5 eau au sol : 6 taches blanches larges vues en biais (avec --set wet=...).
static void setup_demo() {
    app.rig.effects.clear();
    if (g_demo == 5) {
        // eau au sol : 6 lyres blanches, zoom large, taches qui se touchent devant la camera (avec --set wet=...)
        for (Fixture& f : app.rig.fixtures) f.base.dimmer = 0;
        std::vector<int> used;
        for (int k = 0; k < 6; k++) {
            const vec3 target = {-2.0f + 5.0f * (float)(k % 3), 0, k < 3 ? -3.0f : 3.0f};
            const vec3 near_pos = {target.x, 18, k < 3 ? -5.0f : 5.0f};
            int best = -1;
            float bd = 1e30f;
            for (int i = 0; i < (int)app.rig.fixtures.size(); i++) {
                const vec3 d = app.rig.fixtures[i].mount.pos - near_pos;
                if (dot(d, d) < bd && std::find(used.begin(), used.end(), i) == used.end()) { bd = dot(d, d); best = i; }
            }
            if (best < 0) continue;
            used.push_back(best);
            Fixture& f = app.rig.fixtures[best];
            f.base = FixtureParams();
            f.base.zoom = 22;
            f.base.focus = length(target - f.mount.pos);
            app.rig.aim_points[k % 4] = target;
            // visee directe (4 points de visee seulement) : angles calcules ici
            app.rig.update(0);
            app.rig.aim_angles(f, target, f.base.pan, f.base.tilt);
        }
        app.rig.instant_moves = true;
        app.rig.update(0);
        app.rig.instant_moves = false;
        app.cam.pos = {19, 1.7f, 10};
        app.cam.yaw = PI + 0.45f;
        app.cam.pitch = -0.07f;
        app.cam.update_basis();
        app.paused = true;
        return;
    }
    if (g_demo == 4) {
        // pont de scene en orange, gobo barres, zoom 2,2 deg, tilt 69 deg : taches tres allongees au sol,
        // vues en rasant (verifie que la tache n'est pas coupee par le raccourcissement des faisceaux)
        for (Fixture& f : app.rig.fixtures) {
            FixtureParams& p = f.base;
            p.dimmer = 0;
            if (f.mount.group != 4) continue;
            p = FixtureParams();
            p.color = {1.0f, 165.0f / 255.0f, 0.0f};
            p.gobo = 8;   // barres
            p.zoom = 2.2f;
            p.focus = 18;
            p.pan = -3;
            p.tilt = 69;
        }
        app.rig.instant_moves = true;
        app.rig.update(0);
        app.rig.update(0);
        app.rig.instant_moves = false;
        app.cam.pos = {-9, 4.0f, 22};
        app.cam.yaw = -PI * 0.5f - 0.15f;
        app.cam.pitch = -0.30f;
        app.cam.update_basis();
        app.paused = true;
        return;
    }
    const vec3 targets[3] = {{1, 0, -4}, {1, 0, 3}, {-4, 0, 9}};
    const vec3 near_pos[3] = {{4, 18, -5}, {4, 18, 5}, {-2, 18, 15}};
    std::vector<int> used;
    for (Fixture& f : app.rig.fixtures) f.base.dimmer = 0;
    for (int k = 0; k < 3; k++) {
        int best = -1;
        float bd = 1e30f;
        for (int i = 0; i < (int)app.rig.fixtures.size(); i++) {
            const vec3 d = app.rig.fixtures[i].mount.pos - near_pos[k];
            const float dd = dot(d, d);
            if (dd < bd && std::find(used.begin(), used.end(), i) == used.end()) { bd = dd; best = i; }
        }
        if (best < 0) continue;
        used.push_back(best);
        Fixture& f = app.rig.fixtures[best];
        FixtureParams& p = f.base;
        p = FixtureParams();
        p.color = {1, 1, 1};
        p.gobo = 2;   // etoile
        p.prism = k == 2 ? PRISM_NONE : PRISM_8;
        p.zoom = k == 2 ? 9.0f : 7.0f;
        p.focus = length(targets[k] - f.mount.pos);
        if (g_demo == 1) p.focus *= 0.6f;
        if (g_demo == 2) p.frost = 0.4f;
        if (g_demo == 3) {
            p.iris = 0.6f;
            p.zoom *= 1.6f;
        }
        app.rig.aim_points[k] = targets[k];
        p.aim_point = k;
    }
    app.rig.instant_moves = true;
    app.rig.update(0);
    app.rig.update(0);   // la visee part de la tete de la lyre, connue apres la premiere mise a jour
    app.rig.instant_moves = false;
    app.cam.pos = {13, 5.0f, 0.5f};
    app.cam.yaw = PI;
    app.cam.pitch = -0.42f;
    app.cam.update_basis();
    app.paused = true;
}

// --demo-laser : vues d'essai des lasers, lyres eteintes, effets figes (captures avec --frames et --shot).
//   0 formes : 7 lasers du pont de scene, une forme chacun (eventail, double eventail, cone, tunnel, vague,
//     grille de points, eventail en reseau de diffraction x9), vus depuis le public ;
//   1 degrades : 6 eventails du pont (uni, 2 couleurs, 3 couleurs, defilant, arc-en-ciel, aleatoire par trait) ;
//   2 programmation de demonstration sur les 200 lasers (cas L7 du banc), vue du public ;
//   3 un eventail vert vu de pres, en biais, fumee epaisse : volutes (comparer a la photo 5 des references) ;
//   4 fichiers ILDA : 7 lasers du pont de scene, un fichier chacun (nappe, faisceaux, cube, tunnel, texte, coeur,
//     eventail multicolore), vus depuis le public ;
//   5 une personne dans une nappe : nappe verte a hauteur de poitrine a travers les mannequins et le personnage (mode F) ;
//   8 rendu « photo » : 2 eventails verts continus du pont qui se croisent, vus du public, fumee lisse (sans volutes).
//   9 convergence RGB : 2 eventails blancs (nappe continue, 8 traits) vers le sol devant le public (reglage « Convergence RGB »).
//   10 fumee des lasers (image 09 de docs/references-lasers/fumee-v2) : un eventail vert continu du nez de scene, vu de
//      dessous depuis le public (camera de l'image 09).
static void setup_demo_laser() {
    for (Fixture& f : app.rig.fixtures) f.base.dimmer = 0;
    app.rig.effects.clear();
    LaserRig& lr = app.lasers;
    lr.pattern = LP_PROGRAM;
    if (g_demo_laser == 2) {
        lr.program_showcase();
        app.cam.pos = {30, 1.8f, 0};
        app.cam.yaw = PI;
        app.cam.pitch = 0.08f;
    } else if (g_demo_laser == 5) {
        // une nappe verte continue a hauteur de poitrine, du nez de scene vers le public : elle traverse les mannequins
        // et le personnage (mode F, camera derriere lui) ; derriere chacun, un trou d'ombre a bord net (etape 5)
        lr.effects.clear();
        for (LaserFixture& f : lr.fixtures) {
            f.base = LaserParams();
            f.base.dimmer = 0;
        }
        int pick = -1;
        for (int i = 0; i < (int)lr.fixtures.size(); i++)
            if (lr.fixtures[i].mount.group == 6 && pick < 0) pick = i + 3;
        LaserParams& p = lr.fixtures[pick].base;
        p.dimmer = 1;
        p.color = {0, 1, 0};
        p.opening = 50;
        p.traits = 0;          // nappe continue
        p.tilt = -6.5f;        // axe du nez de scene a +5 deg : nappe 1,5 deg sous l'horizontale
        app.character = true;
        app.player = {-9, 0, -1.2f};
        app.cam.yaw = PI * 0.97f;
        app.cam.pitch = -0.12f;
    } else if (g_demo_laser == 4) {
        // 7 lasers du pont de scene, un fichier ILDA chacun (une banque par laser), vus depuis le public
        lr.effects.clear();
        for (LaserFixture& f : lr.fixtures) {
            f.base = LaserParams();
            f.base.dimmer = 0;
        }
        std::vector<int> pont;
        for (int i = 0; i < (int)lr.fixtures.size(); i++)
            if (lr.fixtures[i].mount.group == 4) pont.push_back(i);
        static const char* const FILES[7][2] = {{"Nappes", "Nappe tournante"}, {"Faisceaux", "Radar"},
                                                {"G\xc3\xa9om\xc3\xa9trie", "Cube 3D"}, {"Tunnels", "Tunnel carr\xc3\xa9"},
                                                {"Texte", "SOUNDSTAGE"}, {"Animations", "C\xc5\x93ur battant"},
                                                {"Exemples", "\xc3\x89ventail multicolore"}};
        for (int k = 0; k < 7; k++) {
            int clip = -1;
            for (int c = 0; c < (int)lr.ilda.clips.size(); c++)
                if (lr.ilda.clips[c].bank == FILES[k][0] && lr.ilda.clips[c].name == FILES[k][1]) clip = c;
            LaserParams& p = lr.fixtures[pont[1 + 2 * k]].base;
            p.dimmer = clip >= 0 ? 1.0f : 0.0f;
            p.source = 1;
            p.ilda_clip = clip;
            p.opening = 30;
            p.tilt = -6;
        }
        app.cam.pos = {-8, 6.0f, 0};
        app.cam.yaw = PI;
        app.cam.pitch = 0.05f;
    } else if (g_demo_laser == 7) {
        // programmation de depart (pont et nez de scene en eventails), dimmers montes, camera du lancement
        lr.program_default();
        for (LaserFixture& f : lr.fixtures)
            if (f.mount.group == 4 || f.mount.group == 6) f.base.dimmer = 1;
    } else if (g_demo_laser == 6) {
        // la sortie d'un laser de pres : un eventail cyan de 1 000 traits du pont de scene, camera a quelques metres de
        // la sortie, en dessous et de cote (rendu de la sortie : point chaud, lueur)
        lr.effects.clear();
        for (LaserFixture& f : lr.fixtures) {
            f.base = LaserParams();
            f.base.dimmer = 0;
        }
        int pick = -1;
        for (int i = 0; i < (int)lr.fixtures.size(); i++)
            if (lr.fixtures[i].mount.group == 4 && pick < 0) pick = i + 7;
        LaserParams& p = lr.fixtures[pick].base;
        p.dimmer = 1;
        p.color = {0, 1, 0.9f};
        p.opening = 40;
        p.traits = 1000;
        p.tilt = -8;
        lr.update(0.0f, 0.0f, app.scene.bounds_min, app.scene.bounds_max);
        if (!lr.segs.empty()) {
            const LaserSegment& g = lr.segs[0];
            vec3 n = cross(g.ec, g.es);
            if (n.y > 0) n = -n;   // vers le bas
            app.cam.pos = g.src + g.ec * 5.0f + n * 1.6f + g.es * 1.2f;
            const vec3 d = normalize(g.src - app.cam.pos);
            app.cam.yaw = std::atan2(d.z, d.x);
            app.cam.pitch = std::asin(d.y);
        }
    } else if (g_demo_laser == 3) {
        // un eventail vert du pont de scene vu de pres, en biais et par en dessous, dans une fumee epaisse : volutes
        // (comparer a docs/references-lasers/5-depence-nappe-gros-plan-volutes.png)
        lr.effects.clear();
        for (LaserFixture& f : lr.fixtures) {
            f.base = LaserParams();
            f.base.dimmer = 0;
        }
        int pick = -1;
        for (int i = 0; i < (int)lr.fixtures.size(); i++)
            if (lr.fixtures[i].mount.group == 4 && pick < 0) pick = i + 7;
        LaserParams& p = lr.fixtures[pick].base;
        p.dimmer = 1;
        p.color = {0, 1, 0};
        p.opening = 40;
        p.traits = 1000;
        p.tilt = -8;
        app.fog_settings.density *= 3.0f;
        lr.power_w = 8.0f;
        lr.update(0.0f, 0.0f, app.scene.bounds_min, app.scene.bounds_max);
        if (!lr.segs.empty()) {
            const LaserSegment& g = lr.segs[0];
            vec3 n = cross(g.ec, g.es);
            if (n.y > 0) n = -n;   // vers le bas
            const vec3 target = g.src + g.ec * 3.2f;
            app.cam.pos = g.src + g.ec * 1.6f + n * 0.7f + g.es * 0.6f;
            const vec3 d = normalize(target - app.cam.pos);
            app.cam.yaw = std::atan2(d.z, d.x);
            app.cam.pitch = std::asin(d.y);
        }
    } else if (g_demo_laser == 9) {
        // convergence RGB : 2 eventails blancs du pont (une nappe continue, 8 traits separes), vers le sol devant le public,
        // vus du public ; franges rouges et bleues sur les bords, les traits et les impacts au sol avec « Convergence RGB » (onglet
        // Lasers, « Rendu photo »)
        lr.effects.clear();
        for (LaserFixture& f : lr.fixtures) {
            f.base = LaserParams();
            f.base.dimmer = 0;
        }
        std::vector<int> pont;
        for (int i = 0; i < (int)lr.fixtures.size(); i++)
            if (lr.fixtures[i].mount.group == 4) pont.push_back(i);
        for (int k = 0; k < 2; k++) {
            LaserParams& p = lr.fixtures[pont[k == 0 ? 5 : 10]].base;
            p.dimmer = 1;
            p.color = {1, 1, 1};
            p.shape = LS_FAN;
            p.opening = 40;
            p.traits = k == 0 ? 0 : 8;
            p.tilt = -2;
            p.pan = k == 0 ? 5.0f : -5.0f;
        }
        app.rs.laser_volutes = false;
        app.rs.laser_room_fog = false;
        app.cam.pos = {8, 2.5f, 0};
        app.cam.yaw = PI;
        app.cam.pitch = 0.02f;
    } else if (g_demo_laser == 10) {
        lr.effects.clear();
        int pick = -1;
        for (int i = 0; i < (int)lr.fixtures.size(); i++) {
            lr.fixtures[i].base = LaserParams();
            lr.fixtures[i].base.dimmer = 0;
            if (lr.fixtures[i].mount.group == 6 && pick < 0) pick = i + 2;
        }
        LaserParams& p = lr.fixtures[pick].base;
        p.dimmer = 1;
        p.color = {0, 1, 0};
        p.opening = 40;
        p.tilt = 8;
        p.traits = 0;   // nappe continue
        app.cam.pos = {7.14f, 0.36f, 2.84f};
        app.cam.yaw = 189.3f * DEG;
        app.cam.pitch = 23.5f * DEG;
    } else if (g_demo_laser == 8) {
        // rendu « photo » : 2 eventails verts continus du pont de scene, inclines en sens contraires (ils se croisent),
        // vus depuis le public ; fumee lisse (uniforme, sans volutes). Reglages a essayer : onglet Lasers, « Rendu photo ».
        lr.effects.clear();
        for (LaserFixture& f : lr.fixtures) {
            f.base = LaserParams();
            f.base.dimmer = 0;
        }
        std::vector<int> pont;
        for (int i = 0; i < (int)lr.fixtures.size(); i++)
            if (lr.fixtures[i].mount.group == 4) pont.push_back(i);
        for (int k = 0; k < 2; k++) {
            LaserParams& p = lr.fixtures[pont[k == 0 ? 4 : 11]].base;
            p.dimmer = 1;
            p.color = {0, 1, 0};
            p.shape = LS_FAN;
            p.opening = 45;
            p.traits = 0;   // nappe continue
            p.tilt = 7;
            p.pan = k == 0 ? 6.0f : -6.0f;
            p.roll = k == 0 ? 28.0f : -28.0f;
        }
        app.rs.laser_volutes = false;
        app.rs.laser_room_fog = false;
        app.cam.pos = {2, 1.7f, 0};
        app.cam.yaw = PI;
        app.cam.pitch = 0.16f;
    } else {
        lr.effects.clear();
        for (LaserFixture& f : lr.fixtures) {
            f.base = LaserParams();
            f.base.dimmer = 0;
        }
        // lasers du pont de scene (groupe 4, 16 boitiers) : un sur deux a partir du 2e
        std::vector<int> pont;
        for (int i = 0; i < (int)lr.fixtures.size(); i++)
            if (lr.fixtures[i].mount.group == 4) pont.push_back(i);
        const int nshow = g_demo_laser == 0 ? 7 : 6;
        for (int k = 0; k < nshow; k++) {
            LaserParams& p = lr.fixtures[pont[1 + 2 * k]].base;
            p.dimmer = 1;
            p.opening = 30;
            p.traits = 400;
            p.tilt = -6;
            if (g_demo_laser == 0) {
                static const vec3 cols[7] = {{0, 1, 0}, {0, 0.6f, 1}, {1, 0, 0}, {1, 0.5f, 0}, {0, 1, 0.3f}, {1, 0.85f, 0.2f}, {1, 0, 1}};
                p.color = cols[k];
                p.shape = k < 6 ? k : LS_FAN;
                if (p.shape == LS_CONE || p.shape == LS_TUNNEL) p.opening = 16;
                if (p.shape == LS_GRID) { p.traits = 25; p.shape_param = 5; p.opening = 14; }
                if (p.shape == LS_WAVE) { p.shape_param = 4; p.wave_cycles = 3; }
                if (k == 6) { p.diffraction = 9; p.diffraction_angle = 9; p.opening = 8; p.traits = 100; }
            } else {
                p.shape = LS_FAN;
                p.gradient = k;
                p.color = {1, 0, 0};
                p.color2 = {0, 0.4f, 1};
                p.color3 = {0, 1, 0};
                if (k == LG_RANDOM) p.traits = 12;
            }
        }
        app.cam.pos = {-8, 6.0f, 0};
        app.cam.yaw = PI;
        app.cam.pitch = 0.05f;
    }
    app.cam.update_basis();
    app.rig.instant_moves = true;
    app.rig.update(0);
    app.rig.instant_moves = false;
    lr.update(0.0f, 0.0f, app.scene.bounds_min, app.scene.bounds_max);
    app.paused = true;
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
    else if (k == "crowd") r.crowd_soft = (int)v;
    else if (k == "sparkle") r.sparkle = v;
    else if (k == "adaptive") r.adaptive = v != 0;
    else if (k == "fps") r.target_fps = v;
    else if (k == "scale") r.render_scale = v;
    else if (k == "fsr") r.fsr = v != 0;
    else if (k == "fsrdiv") r.fsr_div = v;
    else if (k == "fsrsharp") r.fsr_sharpness = v;
    else if (k == "floor") r.floor_texture = v != 0;
    else if (k == "floortile") r.floor_tile = v;
    else if (k == "wet") r.floor_wet = v;
    else if (k == "flooraniso") r.floor_aniso = (int)v;
    else if (k == "shadows") r.shadows = v != 0;
    else if (k == "chroma") r.chroma = v != 0;
    else if (k == "chromaforce") r.chroma_strength = v;
    // lasers
    else if (k == "lasers") r.lasers = v != 0;
    else if (k == "lasergain") r.laser_gain = v;
    else if (k == "laserwidth") r.laser_width_px = v;
    else if (k == "laserair") r.laser_air = v;
    else if (k == "laserfog") r.laser_room_fog = v != 0;
    else if (k == "lasercoll") app.lasers.collisions = v != 0;
    else if (k == "lasercache") app.lasers.figure_cache = v != 0;
    else if (k == "laserwhite") r.laser_white = v;
    else if (k == "laserexit") r.laser_exit = v;
    else if (k == "laserimpacts") { r.laser_impacts = v != 0; app.lasers.impacts = v != 0; }
    else if (k == "laserhitgain") r.laser_hit_gain = v;
    else if (k == "laserphase") r.laser_fwd_lobe = v != 0;
    else if (k == "laserfwd") r.laser_fwd_weight = v;
    else if (k == "exposure") r.exposure = v;
    else if (k == "bloomforce") r.bloom_strength = v;
    else if (k == "laseredge") r.laser_edge = v;
    else if (k == "laseredgew") r.laser_edge_w = v;
    else if (k == "laserhalo") r.laser_halo = v;
    else if (k == "laserhalosize") r.laser_halo_size = v;
    else if (k == "laserconv") r.laser_conv = v;
    else if (k == "laserlensca") r.laser_lens_ca = v;
    else if (k == "laserg") r.laser_g_fwd = v;
    else if (k == "laserg2") r.laser_g_soft = v;
    else if (k == "volutes") r.laser_volutes = v != 0;
    else if (k == "volforce") r.laser_vol_strength = v;
    else if (k == "voltaille") r.laser_vol_size = v;
    else if (k == "volperiode") r.laser_vol_period = v;
    else if (k == "volfine") r.laser_vol_fine = v != 0;
    else if (k == "volfinelod") r.laser_vol_fine_lod = v;
    else if (k == "volfinepoids") r.laser_vol_fine_weight = v;
    else if (spatial_fog_set(r.sfog, k, v)) {}   // fumee spatiale des lasers : laserfogmodel, sf...
    else if (spectacle_set(k, eq + 1)) {}        // spectacles laser : spectacle, sp... (src/spectacles.cpp)
    else if (k == "laserpattern") app.lasers.pattern = (int)v;
    else if (k == "lasercount") app.lasers.count = (int)v;
    else if (k == "laserpower") app.lasers.power_w = v;
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
        else if (!std::strcmp(argv[i], "--windowed")) g_fullscreen = false;
        else if (!std::strcmp(argv[i], "--bench")) { g_bench_requested = true; g_novsync = true; }
        else if (!std::strcmp(argv[i], "--bench-lasers")) { g_bench_requested = true; g_novsync = true; bench::laser_bench = true; }
        else if (!std::strcmp(argv[i], "--bench-lyres")) { g_bench_requested = true; g_novsync = true; bench::lyre_bench = true; }
        else if (!std::strcmp(argv[i], "--bench-explore")) {
            g_bench_requested = true;
            g_novsync = true;
            bench::explore_bench = true;
            bench::shots = false;
            bench::WARMUP = 30;
            bench::MEASURE = 60;
        }
        else if (!std::strcmp(argv[i], "--nosweep")) bench::explore_sweep = false;
        else if (!std::strcmp(argv[i], "--random") && i + 1 < argc) bench::explore_random = std::atoi(argv[++i]);
        else if (!std::strcmp(argv[i], "--seed") && i + 1 < argc) bench::explore_seed = (unsigned)std::atoi(argv[++i]);
        else if (!std::strcmp(argv[i], "--shots")) bench::shots = true;
        else if (!std::strcmp(argv[i], "--measure") && i + 1 < argc) {
            // --measure chauffe,mesure : images de chauffe et images mesurees par cas
            if (std::sscanf(argv[++i], "%d,%d", &bench::WARMUP, &bench::MEASURE) != 2) std::printf("--measure chauffe,mesure\n");
        }
        else if (!std::strcmp(argv[i], "--quick")) bench::quick = true;
        else if (!std::strcmp(argv[i], "--cases") && i + 1 < argc) {
            for (const char* c = argv[++i]; *c;) {
                bench::only.push_back(std::atoi(c));
                while (*c && *c != ',') c++;
                if (*c == ',') c++;
            }
        }
        else if (!std::strcmp(argv[i], "--fast")) {
            bench::WARMUP = 30;
            bench::MEASURE = 60;
        }
        else if (!std::strcmp(argv[i], "--behind")) g_behind = true;
        else if (!std::strcmp(argv[i], "--static")) bench::frozen = true;
        else if (!std::strcmp(argv[i], "--play")) g_play = true;
        else if (!std::strcmp(argv[i], "--stats")) g_stats = true;
        else if (!std::strcmp(argv[i], "--demo")) {
            g_demo = 0;
            if (i + 1 < argc && argv[i + 1][0] >= '0' && argv[i + 1][0] <= '9') g_demo = std::atoi(argv[++i]);
        }
        else if (!std::strcmp(argv[i], "--cam") && i + 1 < argc) {
            g_cam_set = std::sscanf(argv[++i], "%f,%f,%f,%f,%f", &g_cam[0], &g_cam[1], &g_cam[2], &g_cam[3], &g_cam[4]) == 5;
        }
        else if (!std::strcmp(argv[i], "--demo-laser")) {
            g_demo_laser = 0;
            if (i + 1 < argc && argv[i + 1][0] >= '0' && argv[i + 1][0] <= '9') g_demo_laser = std::atoi(argv[++i]);
        }
        else if (!std::strcmp(argv[i], "--ambiance") && i + 1 < argc) g_ambiance = std::atoi(argv[++i]) - 1;
        else if (!std::strcmp(argv[i], "--shot") && i + 1 < argc) g_shot_path = argv[++i];
        else if (!std::strcmp(argv[i], "--ilda") && i + 1 < argc) g_ilda_dir = argv[++i];
        else if (!std::strcmp(argv[i], "--benchdir") && i + 1 < argc) bench::dir = argv[++i];
        else if (!std::strcmp(argv[i], "--set") && i + 1 < argc) {
            if (!set_render_option(app.rs, argv[++i])) std::printf("Option inconnue : %s\n", argv[i]);
        }
    }
#if defined(_WIN32)
    if (g_behind) g_prev_foreground = GetForegroundWindow();
#endif
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
