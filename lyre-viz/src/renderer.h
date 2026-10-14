// Moteur de rendu : ressources GPU et enchainement des passes (voir shaders/lyreviz.glsl).
#pragma once
#include "fixtures.h"
#include "fog.h"
#include "gobos.h"
#include "mathx.h"
#include "scene.h"
#include "sokol_gfx.h"
#include <vector>

struct Camera {
    vec3 pos = {30, 1.8f, 0};
    float yaw = PI;      // 0 = vers +X
    float pitch = 0.08f;
    float fovy = 60 * DEG;
    vec3 fwd, right, up;
    void update_basis() {
        fwd = {std::cos(pitch) * std::cos(yaw), std::sin(pitch), std::cos(pitch) * std::sin(yaw)};
        right = normalize(cross(fwd, vec3(0, 1, 0)));
        up = cross(right, fwd);
    }
};

// Toutes les options de qualite / effets (activables une par une).
struct RenderSettings {
    float render_scale = 1.0f;    // resolution interne (1 = native)
    bool surface_lights = true;   // taches de lumiere sur les surfaces
    bool specular = true;         // reflets brillants
    bool volumetrics = true;      // faisceaux dans la fumee
    int vol_div = 2;              // fumee a 1/2, 1/3 ou 1/4 de la resolution
    int vol_samples = 10;         // echantillons par faisceau et par pixel
    bool temporal = true;         // accumulation dans le temps
    float temporal_weight = 0.88f;
    bool gi = true;               // lumiere indirecte (rebonds)
    float gi_strength = 1.0f;
    float gi_fog = 1.0f;          // lumiere indirecte dans la fumee
    bool bloom = true;
    float bloom_strength = 0.05f;
    float exposure = 1.2f;
    float ambient = 0.0015f;      // lumiere minimale (salle noire = 0)
    float beam_range = 110.0f;    // portee des faisceaux (m)
    float lens_glow = 1.0f;       // eclat des lentilles
    bool show_fixtures = true;
};

struct RenderStats {
    int lights = 0;
    int vpls = 0;
    int internal_w = 0, internal_h = 0;
    int vol_w = 0, vol_h = 0;
};

class Renderer {
  public:
    void init(const Scene& scene, const GoboAtlas& gobos, const FogSim& fog);
    void shutdown();
    // Prepare et soumet toutes les passes. 'ui' est appele dans la passe finale (ImGui).
    void render(const Camera& cam, const Scene& scene, const Rig& rig, const GoboAtlas& gobos, const FogSim& fog,
                const FogSettings& fs, const RenderSettings& rs, int width, int height, float time, void (*ui)());
    RenderStats stats;
    std::vector<Instance> dyn_cubes, dyn_cyls;   // remplis par l'appelant (avatar) + lyres

  private:
    struct Target {
        sg_image img = {};
        sg_view tex = {}, att = {};
    };
    void make_target(Target& t, int w, int h, sg_pixel_format fmt, const char* label);
    void destroy_target(Target& t);
    void resize(int iw, int ih, int vw, int vh);
    void build_lights(const Rig& rig, const RenderSettings& rs, const GoboAtlas& gobos);
    void build_vpls(const Scene& scene, const Rig& rig, const GoboAtlas& gobos, float sigma_ext, float sigma_scat);
    void build_fixture_instances(const Rig& rig, const RenderSettings& rs);

    // maillages
    sg_buffer cube_vb = {}, cube_ib = {}, cyl_vb = {}, cyl_ib = {};
    int cube_indices = 0, cyl_indices = 0;
    sg_buffer static_cubes = {}, static_cyls = {};
    int num_static_cubes = 0, num_static_cyls = 0;
    sg_buffer dyn_cube_buf = {}, dyn_cyl_buf = {};
    static constexpr int MAX_DYN = 4096;

    // donnees des lumieres
    static constexpr int MAX_LIGHTS = 256;
    static constexpr int MAX_VPLS = 4096;
    sg_buffer light_buf = {}, cluster_buf = {}, tile_buf = {}, vpl_buf = {}, probe_buf = {};
    sg_view light_view = {}, cluster_view = {}, tile_view = {}, vpl_view = {}, probe_view = {};
    std::vector<uint8_t> light_data;   // sb_light_t[]
    std::vector<uint8_t> vpl_data;     // sb_vpl_t[]
    std::vector<float> gobo_transmission;
    int num_lights = 0, num_vpls = 0;

    // textures
    sg_image gobo_img = {}, fog_img = {}, detail_img = {};
    sg_view gobo_view = {}, fog_view = {}, detail_view = {};
    sg_sampler gobo_smp = {}, point_smp = {}, lin_clamp = {}, lin_repeat = {};

    // cibles de rendu
    Target scene_color, scene_depth_lin, depth, vol_cur, vol_hist[2], combined;
    static constexpr int BLOOM_LEVELS = 6;
    Target bloom[BLOOM_LEVELS];
    int bloom_w[BLOOM_LEVELS] = {}, bloom_h[BLOOM_LEVELS] = {};
    int num_bloom = 0;
    int iw = 0, ih = 0, vw = 0, vh = 0;
    int hist_index = 0;
    bool hist_valid = false;
    mat4 prev_view_proj = mat4::identity();
    uint32_t frame = 0;

    // pipelines
    sg_pipeline pip_cull_clusters = {}, pip_cull_tiles = {}, pip_probes = {};
    sg_pipeline pip_scene = {}, pip_volume = {}, pip_temporal = {}, pip_composite = {};
    sg_pipeline pip_bloom_down = {}, pip_bloom_up = {}, pip_final = {};

    // grilles
    static constexpr int CL_X = 16, CL_Y = 9, CL_Z = 24;
    static constexpr int TILE_X = 32, TILE_Y = 18;
    static constexpr int PR_X = 40, PR_Y = 14, PR_Z = 18;
    vec3 probe_min, probe_cell;
};
