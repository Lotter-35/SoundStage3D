// Moteur de rendu : ressources GPU et enchainement des passes (voir shaders/lyreviz.glsl).
#pragma once
#include "fixtures.h"
#include "floor_texture.h"
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
    bool depth_prepass = true;    // pre-passe de profondeur : chaque pixel n'est eclaire qu'une fois
    bool volumetrics = true;      // faisceaux dans la fumee
    bool analytic_beams = true;   // fumee : calcul analytique (tables) plutot qu'echantillons au hasard
    bool beam_tiers = true;       // fumee : faisceaux tres doux calcules a plus basse resolution
    bool soft_lights = true;      // surfaces : lyres tres douces (frost) eclairees a 1/4 de la resolution
    bool adaptive = true;         // qualite adaptative : tient la cadence visee dans les scenes lourdes
    float target_fps = 120.0f;
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
    bool floor_texture = true;    // sol en beton texture (Concrete031) : couleur, relief, rugosite, occlusion
    float floor_tile = 8.0f;      // taille de repetition de la texture du sol (m) : 4 x 4 dalles de 2 m
    float floor_wet = 0.0f;       // eau au sol : 0 sec, 0,4 humide, 1 inonde (flaques)
    int floor_aniso = 4;          // filtrage anisotrope du sol (1 a 16, fixe au lancement) : 4 = meme image que 16, 3 x moins cher
};

struct RenderStats {
    int lights = 0;
    int vpls = 0;
    int internal_w = 0, internal_h = 0;
    int vol_w = 0, vol_h = 0;
    int tier_count[3] = {};       // faisceaux par niveau de resolution (1, 1/2, 1/4)
    int soft_lights = 0;          // lyres eclairees a 1/4 sur les surfaces
    int pattern_images = 0;       // images projetees en cache (lyres a prisme)
    float quality = 1.0f;         // qualite adaptative (1 = pleine qualite)
    int table_rows = 0;           // fumee analytique : lignes de tables calculees
    double table_cells = 0;       // cases de tables
    float table_scale = 1;        // reduction de resolution (atlas plein)
};

class Renderer {
  public:
    void init(const Scene& scene, const GoboAtlas& gobos, const FogSim& fog, const FloorTexture& floor, int floor_aniso);
    void shutdown();
    // Prepare et soumet toutes les passes. 'ui' est appele dans la passe finale (ImGui).
    void render(const Camera& cam, const Scene& scene, const Rig& rig, const GoboAtlas& gobos, const FogSim& fog,
                const FogSettings& fs, const RenderSettings& rs, int width, int height, float time, void (*ui)());
    RenderStats stats;
    void reset_quality() {
        quality = 1.0f;
        quality_ms = 0;
    }   // banc d'essai : chaque cas repart de la pleine qualite
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
    void build_vpls(const Scene& scene, const Rig& rig, const GoboAtlas& gobos, const RenderSettings& rs, float sigma_ext, float sigma_scat);
    void build_fixture_instances(const Rig& rig, const RenderSettings& rs);
    void build_beam_tables(const struct Camera& cam, float pixel_angle);
    void assign_beam_tiers(const struct Camera& cam, float pixel_angle, bool tiers, bool soft, int vol_div);
    void update_quality(const RenderSettings& rs);
    float quality = 1.0f;          // facteur de qualite adaptative (0.2 .. 1)
    float quality_ms = 0;          // temps GPU lisse
    unsigned quality_last_id = 0;

    // maillages
    sg_buffer cube_vb = {}, cube_ib = {}, cyl_vb = {}, cyl_ib = {};
    sg_buffer cone_vb = {}, cone_ib = {};   // cone d'un faisceau (fumee)
    int cube_indices = 0, cyl_indices = 0, cone_indices = 0;
    sg_buffer static_cubes = {}, static_cyls = {};
    int num_static_cubes = 0, num_static_cyls = 0;
    sg_buffer dyn_cube_buf = {}, dyn_cyl_buf = {};
    static constexpr int MAX_DYN = 4096;

    // donnees des lumieres
    static constexpr int MAX_LIGHTS = 256;
    static constexpr int MAX_VPLS = 4096;
    sg_buffer light_buf = {}, cluster_buf = {}, vpl_buf = {};
    sg_view light_view = {}, cluster_view = {}, vpl_view = {};
    // sondes : 3 textures (12 coefficients), ecrites par le calcul, lues avec filtrage
    sg_image probe_img[3] = {};
    sg_view probe_store[3] = {}, probe_tex[3] = {};
    std::vector<uint8_t> light_data;   // sb_light_t[]
    std::vector<uint8_t> vpl_data;     // sb_vpl_t[]
    // tables des faisceaux (calcul analytique de la fumee)
    static constexpr int BTAB_W = 8192, BTAB_H = 4096, BTAB_LAYERS = 5;
    static constexpr float BTAB_LOD_STEP = 2.0f;   // ecart de flou entre deux couches (comme le shader)
    sg_buffer btab_buf = {};
    sg_view btab_view = {};
    sg_image btab_img = {};
    sg_view btab_store = {}, btab_tex = {};
    std::vector<uint8_t> btab_data;    // sb_btab_t[]
    // faisceaux tries par niveau de resolution : beam_tier[i] = niveau de la lyre i
    std::vector<int> beam_tier;
    std::vector<float> beam_px;          // largeur a l'ecran (pixels de la fumee) du faisceau i
    std::vector<uint32_t> beam_order;
    int tier_first[3] = {}, tier_num[3] = {};
    sg_buffer beam_list_buf = {};
    sg_view beam_list_view = {};
    // images projetees en cache (lyres a prisme) : une case de PIMG_W x PIMG_H par lyre
    static constexpr int PIMG_ATLAS_W = 8064, PIMG_ATLAS_H = 3072, PIMG_SIZE = 256, PIMG_W = 384, PIMG_H = 256;
    sg_image pimg_img = {};
    sg_view pimg_store = {}, pimg_tex = {};
    sg_buffer pimg_desc_buf = {}, pimg_list_buf = {};
    sg_view pimg_desc_view = {}, pimg_list_view = {};
    std::vector<float> pimg_desc;      // vec4 par lyre
    std::vector<uint32_t> pimg_list;   // lyres qui ont une image
    sg_buffer btab_job_buf = {};
    sg_view btab_job_view = {};
    std::vector<uint32_t> btab_jobs;   // une entree par ligne de table a calculer
    static constexpr int MAX_BTAB_JOBS = 1 << 18;
    float btab_scale = 1.0f;
    std::vector<float> gobo_transmission;
    int num_lights = 0, num_vpls = 0;

    // textures
    sg_image gobo_img = {}, fog_img = {}, detail_img = {};
    sg_view gobo_view = {}, fog_view = {}, detail_view = {};
    sg_sampler gobo_smp = {}, point_smp = {}, lin_clamp = {}, lin_repeat = {};
    // sol texture : luminance, normale, rugosite (avec mipmaps, filtrage anisotrope)
    const FloorTexture* floor_tex = nullptr;
    sg_image floor_img = {};
    sg_view floor_view = {};
    sg_sampler floor_smp = {};
    float floor_scale = 1.0f;   // echelle de couleur : luminance moyenne du sol = celle du beton uni

    // cibles de rendu
    Target scene_color, scene_depth_lin, depth, vol_cur, vol_hist[2], combined;
    Target vol_tier[2];                 // fumee a 1/2 et 1/4 de sa resolution (faisceaux doux)
    Target scene_normal, scene_albedo;  // pour la passe des lyres douces
    Target soft_diffuse, soft_spec;     // lyres douces, a 1/4 de la resolution
    int soft_w = 0, soft_h = 0;
    int num_soft = 0;
    int tier_w[2] = {}, tier_h[2] = {};
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
    sg_pipeline pip_cull_clusters = {}, pip_probes = {};
    sg_pipeline pip_depth = {}, pip_scene_eq = {}, pip_scene_gb = {}, pip_scene_eq_gb = {}, pip_soft = {};
    sg_pipeline pip_beam_tables = {}, pip_beams_an = {}, pip_vol_merge = {}, pip_pattern_images = {};
    sg_pipeline pip_scene = {}, pip_vol_ambient = {}, pip_beams = {}, pip_temporal = {}, pip_composite = {};
    sg_pipeline pip_bloom_down = {}, pip_bloom_up = {}, pip_final = {};

    // grilles
    static constexpr int CL_X = 32, CL_Y = 18, CL_Z = 24;
    static constexpr int PR_X = 40, PR_Y = 14, PR_Z = 18;
    vec3 probe_min, probe_cell;
    vec3 hall_min, hall_max;   // interieur du hangar (les faisceaux s'arretent a ses parois)
};
