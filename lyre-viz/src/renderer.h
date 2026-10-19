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
    // AMD FSR 1 (dernier recours) : image calculee a la resolution / fsr_div, agrandie par EASU, netteté RCAS.
    // Remplace la resolution interne quand il est actif. L'interface reste a pleine resolution.
    bool fsr = false;
    float fsr_div = 1.5f;         // diviseur de resolution (1,5 qualite, 1,7 equilibre, 2 performance, 3 ultra)
    float fsr_sharpness = 0.8f;   // netteté RCAS (1 : maximale ; attenuation en diaphragmes = 2 x (1 - netteté))
    bool surface_lights = true;   // taches de lumiere sur les surfaces
    bool specular = true;         // reflets brillants
    bool depth_prepass = true;    // pre-passe de profondeur : chaque pixel n'est eclaire qu'une fois
    bool volumetrics = true;      // faisceaux dans la fumee
    bool analytic_beams = true;   // fumee : calcul analytique (tables) plutot qu'echantillons au hasard
    bool beam_tiers = true;       // fumee : faisceaux tres doux calcules a plus basse resolution
    bool soft_lights = true;      // surfaces : lyres tres douces (frost) eclairees a 1/4 de la resolution
    int crowd_soft = 24;          // surfaces : case ou plus de N lyres sans gobo se superposent -> eclairees a 1/4 (0 : jamais)
    float sparkle = 1.75f;        // lyres douces : scintillement des reflets rendu par le relief fin (0 : reflet lisse)
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
    float bloom_strength = 0.02f;
    float exposure = 1.2f;
    float ambient = 0.0015f;      // lumiere minimale (salle noire = 0)
    float beam_range = 110.0f;    // portee des faisceaux (m)
    float lens_glow = 1.0f;       // eclat des lentilles
    bool show_fixtures = true;
    bool shadows = true;          // ombres exactes des obstacles fixes (paves) : surfaces et fumee
    bool floor_texture = true;    // sol en beton texture (Concrete031) : couleur, relief, rugosite, occlusion
    float floor_tile = 8.0f;      // taille de repetition de la texture du sol (m) : 4 x 4 dalles de 2 m
    float floor_wet = 0.0f;       // eau au sol : 0 sec, 0,1 creux remplis et quelques flaques, 1 inonde (voir floor_material)
    // reflet du sol mouille (camera miroir) : lasers dans le reflet (0 : non, 1 : a 1/4 de la resolution, 2 : a 1/2), avec la
    // lueur de leur sortie ; reflet flou sur le beton mouille hors des flaques (film d'eau, bords detrempes), et son flou
    // (x 1 : rugosite du beton mouille ; 0 : net)
    int refl_lasers = 1;
    bool refl_concrete = true;
    float refl_blur = 1.0f;
    int floor_aniso = 4;          // filtrage anisotrope du sol (1 a 16, fixe au lancement) : 4 = meme image que 16, 3 x moins cher
    bool chroma = true;           // aberration chromatique de l'optique : franges colorees au bord des taches et des gobos (+0,5 a +0,9 ms avec gobo + prisme)
    float chroma_strength = 1.0f; // intensite (1 = lyre courante)
    // lasers (PLAN-LASERS.md : segments d'eventail analytiques, tuiles en calcul)
    bool lasers = true;           // lasers dans la fumee
    float laser_gain = 1.0f;      // intensite des faisceaux dans la fumee (multiplicateur)
    float laser_width_px = 0.6f;  // largeur minimale d'un trait (sigma de la gaussienne, en pixels)
    float laser_air = 0.0005f;    // diffusion de l'air (par m) : traits visibles meme sans fumee
    bool laser_impacts = true;    // impacts sur les surfaces (points et lignes la ou les lasers touchent)
    float laser_hit_gain = 1.0f;  // intensite des impacts
    // lumiere des lasers dans la piece (PLAN-LASERS.md, etape 7) : impacts et nappes envoyes dans les sondes de lumiere
    // indirecte (avec rs.gi) ; murs, sol et decor autour des impacts prennent la couleur des lasers (active par defaut :
    // choix de l'utilisateur, 19 octobre 2026)
    bool laser_gi = true;
    float laser_gi_strength = 1.0f;   // multiplicateur (1 : lumiere des impacts et des nappes, comme celle des lyres)
    float laser_exit = 1.0f;      // lueur de sortie des lasers (point chaud et halo ; 0 : aucune)
    float laser_white = 0.6f;     // blanchiment des lasers tres intenses (comme une camera ; 0 : couleurs pures, comme l'oeil)
    bool laser_room_fog = true;   // fumee de la piece (amas, brume) lue au point de chaque nappe ; sinon uniforme
    // modele de fumee des lasers : Spatiale (v2, fumee_spatiale.h), prereglage « Nuages larges et doux » par defaut (choix de
    // l'utilisateur, 16 octobre 2026) ; Classique (reglages ci-dessous) avec --set laserfogmodel=0
    SpatialFogSettings sfog = spatial_fog_preset(4);
    // diffusion vers l'avant des lasers : deux lobes (tres avant + doux), sinon un seul comme les lyres (g de la fumee)
    bool laser_fwd_lobe = true;
    float laser_fwd_weight = 0.42f;   // part du lobe tres avant
    float laser_g_fwd = 0.88f;        // g du lobe tres avant
    float laser_g_soft = 0.35f;       // g du lobe doux (vu de cote : meme brillance qu'un lobe g = 0,55)
    // volutes fines dans les nappes (texture 3D periodique, src/volutes.cpp)
    bool laser_volutes = true;
    float laser_vol_strength = 0.6f;  // contraste (ecarts types de la modulation, dans les amas)
    float laser_vol_size = 1.6f;      // taille d'un motif (m) : 64 texels de 2,5 cm
    float laser_vol_period = 16.0f;   // duree de la boucle d'evolution (s)
    bool laser_vol_fine = true;       // 2e octave (0,44 m, texels de 7 mm), de pres seulement
    float laser_vol_fine_lod = -1.0f; // ... lue tant qu'un pixel couvre moins de 2^x de ses texels (-1 : pixel < 3,5 mm, a moins de ~7 m)
    float laser_vol_fine_weight = 0.6f;   // son poids
    // rendu « photo » des lasers (regle a l'oeil par l'utilisateur, vue --demo-laser 8, 16 octobre 2026) :
    // bords brillants : un scanner ralentit au bout de chaque aller-retour, la lumiere s'y attarde (balayage sinusoidal :
    // densite en 1 / sqrt(1 - u^2), u de -1 a 1 en travers de l'eventail) ; 0 : nappe uniforme (balayage triangulaire ideal)
    float laser_edge = 1.0f;
    float laser_edge_w = 0.025f;      // largeur de la bande brillante des bords (part de la demi-ouverture)
    // halo des lasers : lumiere des nappes diffusee une 2e fois par la brume (et lueur de l'objectif), large et douce
    float laser_halo = 0.1f;          // force (0 : aucun)
    float laser_halo_size = 0.5f;     // etendue (poids de chaque niveau plus large : 0,5 serre, 1,5 tres large)
    // convergence RGB : ecart d'angle des diodes rouge et bleue au vert (mrad ; 0 : parfaitement alignees). Bords de nappes,
    // traits et impacts frangés de rouge et de bleu (vrai defaut des projecteurs RGB, qui grandit avec la distance)
    float laser_conv = 0.3f;          // regle par l'utilisateur (vue --demo-laser 9, 16 octobre 2026)
    // Resolution des lasers (PLAN-OPTIM-LASERS.md, 2.1) : adaptative (avec adaptive), paliers 100 / 80 / 70 / 50 % seulement
    // quand l'image passe sous 60 img/s ; sinon laser_scale (fixe, 1 : pleine resolution). --set laseradaptive, laserscale
    bool laser_adaptive = true;
    float laser_scale = 1.0f;
    bool laser_merge = true;          // morceaux voisins d'un meme cercle fusionnes (PLAN-OPTIM-LASERS.md, 0.5) ; --set lasermerge
    // aberration chromatique de l'objectif sur les lasers (%, grandissement du rouge en plus et du bleu en moins ; 0 : aucune)
    float laser_lens_ca = 0.2f;
    // (laterale, prisme, axiale, active) pour les shaders : voir beam_pattern_rgb
    void chroma_params(float out[4]) const {
        const float k = chroma ? chroma_strength : 0.0f;
        out[0] = 0.006f * k;   // grandissement : +0,6 % en bleu, -0,6 % en rouge
        out[1] = 0.02f * k;    // ecart des facettes du prisme : +2 % en bleu, -2 % en rouge
        out[2] = 0.08f * k;    // distance de nettete : bleu 5 % plus pres, rouge 5 % plus loin (log2)
        out[3] = k > 0.0f ? 1.0f : 0.0f;
    }
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
    float laser_scale = 1.0f;     // resolution des lasers (2.1)
    int table_rows = 0;           // fumee analytique : lignes de tables calculees
    double table_cells = 0;       // cases de tables
    float table_scale = 1;        // reduction de resolution (atlas plein)
    int mirror_beams = 0;         // reflet du sol mouille : faisceaux visibles dans le reflet
    int mirror_lasers = 0;        // ... segments de lasers calcules pour le reflet (0 : pas de lasers dans le reflet)
    int occluded_lights = 0;      // lyres avec un obstacle (ombre) dans leur cone
    int occ_pairs = 0;            // paires (lyre, pave) : volumes d'ombre
    // lasers
    int laser_segments = 0;       // segments d'eventail envoyes au GPU
    int laser_tiles_x = 0, laser_tiles_y = 0;
    // compteurs (--stats) : lus quelques images plus tard
    double laser_tile_pairs = 0;  // tuiles de 16 px : couples (tuile, segment)
    int laser_tile_max = 0;       // segments au plus dans une tuile
    int laser_tiles_hit = 0;      // tuiles touchees par au moins un segment
    int laser_hits = 0;           // impacts dessines
    int laser_vpls = 0;           // lumieres virtuelles des lasers (impacts, nappes), comprises dans vpls
    float laser_vpl_ms = 0;       // leur temps CPU
    int laser_bin_overflow = 0;   // segments perdus par les grosses tuiles pleines (plus de LASER_CAP)
    // compteurs de mesure (variantes LASER_STATS, fumee spatiale) : passe principale [0] et des arcs [1] : couples (pixel,
    // segment) qui eclairent, noyes (pixel deja sature avant eux : 1 et 2 fois le seuil d'ACES), faibles (moins de 1 % du
    // pixel) ; eventails : qui eclairent, interpolables (piste 1.1), ecart de l'interpolation au pixel > 1 %, > 5 %
    double laser_lit[2] = {}, laser_drown1[2] = {}, laser_drown2[2] = {}, laser_small[2] = {};
    double laser_fan_lit = 0, laser_fan_interp = 0, laser_fan_err1 = 0, laser_fan_err5 = 0;
    bool laser_counted = false;   // compteurs de mesure lus (variante LASER_STATS choisie)
    int laser_fog_variant = 0;    // variante de la fumee des lasers (0 a 3, voir LASER_FOG dans le shader)
};

struct LaserRig;

class Renderer {
  public:
    void init(const Scene& scene, const GoboAtlas& gobos, const FogSim& fog, const FloorTexture& floor, int floor_aniso);
    void shutdown();
    // Prepare et soumet toutes les passes. 'ui' est appele dans la passe finale (ImGui).
    void render(const Camera& cam, const Scene& scene, const Rig& rig, const GoboAtlas& gobos, const FogSim& fog,
                const FogSettings& fs, const RenderSettings& rs, int width, int height, float time, void (*ui)(),
                const LaserRig* lasers = nullptr);
    RenderStats stats;
    void reset_quality() {
        quality = 1.0f;
        quality_ms = 0;
        laser_step = 0;
        lscale_ms = lscale_las = 0;
        lscale_hold = 0;
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
    void build_lights(const Rig& rig, const RenderSettings& rs, const GoboAtlas& gobos, const Scene& scene);
    void build_vpls(const Scene& scene, const Rig& rig, const GoboAtlas& gobos, const RenderSettings& rs, float sigma_ext, float sigma_scat);
    void build_laser_vpls(const Scene& scene, const LaserRig& lasers, const RenderSettings& rs, float sigma_ext, float sigma_scat);
    // regroupement des lumieres virtuelles des lasers par case de la grille des sondes (et par face : 6 directions de
    // surface, 7e pour la fumee) ; lgi_index : case -> groupe (-1 : aucun), remis a -1 apres usage (groupes touches)
    struct LgiBin {
        vec3 flux, pos, nrm;   // pos et nrm : sommes ponderees par la luminance
        float w = 0;
        int cx = 0, cy = 0, cz = 0, face = 0;
    };
    std::vector<int> lgi_index, lgi_keys;
    std::vector<LgiBin> lgi_bins, lgi_tmp, lgi_surf, lgi_fog;
    void build_fixture_instances(const Rig& rig, const RenderSettings& rs);
    // mirror : tables de la camera miroir (reflet du sol mouille), dans leurs propres tampons
    void build_beam_tables(const struct Camera& cam, float pixel_angle, bool mirror = false);
    void assign_beam_tiers(const struct Camera& cam, float pixel_angle, bool tiers, bool soft, int vol_div, bool crowd);
    void update_quality(const RenderSettings& rs);
    float laser_scale_for(const RenderSettings& rs);   // resolution des lasers de cette image (2.1)
    int laser_step = 0;            // palier : 100, 80, 70, 50 %
    float lscale_ms = 0, lscale_las = 0;   // temps GPU lisses : image, passes des lasers
    int lscale_hold = 0;           // images mesurees depuis le dernier changement de palier
    unsigned lscale_last_id = 0;
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
    sg_buffer cluster_buf_m = {};   // cases de lumiere de la camera miroir (reflet du sol mouille)
    sg_view cluster_view_m = {};
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
    // reflet du sol mouille : lyres dont le cone est visible dans le reflet (tables et dessin)
    // ombres des obstacles fixes : paves (une fois), et pour chaque lyre ceux qui touchent son cone
    // volume d'ombre de chaque paire (lyre, pave) : bloc de 10 vec4 (nombre de plans, 9 plans au plus)
    static constexpr int MAX_OCC_PAIRS = 2048, OCC_BLOCK = 13;   // nombre de plans, 2 rectangles, 2 plages de profondeur, 9 plans
    sg_buffer occ_light_buf = {}, occ_plane_buf = {}, occ_tile_buf = {};
    sg_view occ_light_view = {}, occ_plane_view = {}, occ_tile_view = {};
    std::vector<uint32_t> occ_tile_data;   // masques des paves par tuile d'ecran et par lyre (8 bits)
    std::vector<Occluder> occluders;
    std::vector<uint32_t> occ_light_data;   // 4 par lyre (sb_occ_t) : nombre de paves, premier bloc
    std::vector<float> occ_plane_data;      // blocs des volumes d'ombre
    int occ_pairs = 0;
    vec3 occ_pair_lens[MAX_OCC_PAIRS];   // lentille et pave de chaque paire (rectangles d'ecran)
    int occ_pair_box[MAX_OCC_PAIRS] = {};
    std::vector<uint8_t> mirror_vis;
    std::vector<uint32_t> beam_order_m;
    sg_buffer beam_list_buf_m = {};
    sg_view beam_list_view_m = {};
    // images projetees en cache (lyres a prisme) : une case de PIMG_W x PIMG_H par lyre
    static constexpr int PIMG_ATLAS_W = 8064, PIMG_ATLAS_H = 3072, PIMG_SIZE = 256, PIMG_W = 384, PIMG_H = 256;
    sg_image pimg_img = {};
    sg_view pimg_store = {}, pimg_tex = {};
    // atlas en couleur (aberration chromatique), cree a la premiere activation : 2 fois plus d'octets a
    // lire (+0,5 a +1 ms avec gobo + prisme 8) ; l'atlas R32F sert quand l'aberration est coupee
    sg_image pimg_img_rgb = {};
    sg_view pimg_store_rgb = {}, pimg_tex_rgb = {};
    sg_buffer pimg_desc_buf = {}, pimg_list_buf = {};
    sg_view pimg_desc_view = {}, pimg_list_view = {};
    std::vector<float> pimg_desc;      // vec4 par lyre
    std::vector<uint32_t> pimg_list;   // lyres qui ont une image
    // reglages de l'image de chaque case (image precedente) : une case n'est recalculee que s'ils changent
    struct PimgKey {
        float v[10];
    };
    std::vector<PimgKey> pimg_keys;
    std::vector<uint32_t> pimg_dirty;   // lyres dont l'image est a recalculer cette image-ci
    sg_buffer btab_job_buf = {};
    sg_view btab_job_view = {};
    std::vector<uint32_t> btab_jobs;   // une entree par ligne de table a calculer
    // tables de la camera miroir : memes calculs, ecrites dans le meme atlas apres la passe principale
    sg_buffer btab_buf_m = {}, btab_job_buf_m = {};
    sg_view btab_view_m = {}, btab_job_view_m = {};
    std::vector<uint8_t> btab_data_m;
    std::vector<uint32_t> btab_jobs_m;
    float btab_scale_m = 1.0f;
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
    sg_image floor_cav_img = {};   // creux du beton (eau au sol), R8
    sg_view floor_cav_view = {};
    sg_sampler floor_smp = {};
    float floor_scale = 1.0f;   // echelle de couleur : luminance moyenne du sol = celle du beton uni

    // cibles de rendu
    Target scene_color, scene_depth_lin, depth, vol_cur, vol_hist[2], combined;
    Target vol_tier[2];                 // fumee a 1/2 et 1/4 de sa resolution (faisceaux doux)
    Target scene_normal, scene_albedo;  // pour la passe des lyres douces
    Target soft_r, soft_g, soft_b, soft_spec;   // lyres douces, a 1/4 : eclairement par direction, reflet
    // reflet du sol mouille : la scene vue d'une camera miroir sous le sol, a demi-resolution
    Target refl_color, refl_depth_lin, refl_depth, refl_vol, refl_final;
    Target refl_beam_mask;   // reflet : eau sous chaque pixel du miroir (fs_refl_mask), lu par les faisceaux
    int refl_w = 0, refl_h = 0, refl_vw = 0, refl_vh = 0;
    // reflet flou du beton mouille : pyramide (mipmaps) du reflet, a 1/4 de la resolution puis 1/8...
    // (fs_refl_down), lue par la composition en filtrage anisotrope (trainees verticales)
    static constexpr int REFL_BLUR_LEVELS = 6;
    sg_image refl_blur_img = {};
    sg_view refl_blur_tex = {};                           // tous les niveaux (composition)
    sg_view refl_blur_att[REFL_BLUR_LEVELS] = {}, refl_blur_lvl[REFL_BLUR_LEVELS] = {};   // un niveau : ecriture, lecture
    int refl_blur_n = 0, refl_blur_w = 0, refl_blur_h = 0;
    sg_sampler refl_smp = {};
    sg_pipeline pip_refl_down = {};
    // lasers dans le reflet : leur image (camera miroir, a refl_w x refl_h au plus), segments avec la position de la camera
    // miroir (cam_rel), lueurs de sortie vues de la camera miroir
    sg_image refl_laser_img = {};
    sg_view refl_laser_store = {}, refl_laser_tex = {};
    sg_buffer laser_buf_m = {}, laser_exit_buf_m = {};
    sg_view laser_view_m = {}, laser_exit_view_m = {};
    std::vector<float> laser_data_m, laser_exit_data_m;
    int soft_w = 0, soft_h = 0;
    int num_soft = 0;
    int num_open = 0;   // lyres a grande tache floue sans gobo (lyres superposees : cs_cull_clusters)
    int tier_w[2] = {}, tier_h[2] = {};
    static constexpr int BLOOM_LEVELS = 6;
    Target bloom[BLOOM_LEVELS];
    int bloom_w[BLOOM_LEVELS] = {}, bloom_h[BLOOM_LEVELS] = {};
    int num_bloom = 0;
    // halo des lasers : meme pyramide que le bloom, sur l'image des lasers seule (ajoutee par la composition)
    Target lhalo[BLOOM_LEVELS];
    int lhalo_w[BLOOM_LEVELS] = {}, lhalo_h[BLOOM_LEVELS] = {};
    int num_lhalo = 0;
    int iw = 0, ih = 0, vw = 0, vh = 0;
    int hist_index = 0;
    bool hist_valid = false;
    mat4 prev_view_proj = mat4::identity();
    uint32_t frame = 0;

    // pipelines
    sg_pipeline pip_cull_clusters = {}, pip_probes = {};
    sg_pipeline pip_depth = {}, pip_soft = {}, pip_soft_simple = {};
    sg_pipeline pip_final_fsr = {}, pip_fsr_easu = {}, pip_fsr_rcas = {};
    Target fsr_in, fsr_up;              // FSR : image a agrandir (resolution interne), image agrandie (ecran)
    int fsr_w = 0, fsr_h = 0, fsr_iw = 0, fsr_ih = 0;
    // surfaces : [0] sol sec, [1] sol mouille (eau au sol : variante plus lourde, seulement si de l'eau)
    sg_pipeline pip_scene[2] = {}, pip_scene_eq[2] = {}, pip_scene_gb[2] = {}, pip_scene_eq_gb[2] = {};
    sg_pipeline pip_beam_tables = {}, pip_beams_an = {}, pip_vol_merge = {}, pip_pattern_images = {}, pip_pattern_images_rgb = {};
    sg_pipeline pip_vol_ambient = {}, pip_beams = {}, pip_temporal = {}, pip_composite = {};
    sg_pipeline pip_bloom_down = {}, pip_bloom_up = {}, pip_final = {};
    sg_pipeline pip_laser_up = {};   // lasers a resolution reduite agrandis (2.1)
    Target laser_up;                 // leur image agrandie, pleine resolution
    sg_pipeline pip_beams_m = {}, pip_beams_an_m = {}, pip_refl_compose = {}, pip_refl_mask = {}, pip_refl_block = {};   // passe miroir

    // lasers : segments d'eventail (voir shaders, section 10)
    // segments au plus (16 384 : 200 lasers qui jouent des fichiers ILDA charges en depassaient 8 192) ; LASER_CAP : comme le shader
    static constexpr int MAX_LASER_SEGS = 16384, LASER_CAP = 4096;
    sg_buffer laser_buf = {}, laser_scr_buf = {}, laser_stats_buf = {};
    sg_view laser_view = {}, laser_scr_view = {}, laser_stats_view = {};
    sg_buffer laser_ccount_buf = {}, laser_clist_buf = {};   // grosses tuiles (128 px) : nombre et liste
    sg_view laser_ccount_view = {}, laser_clist_view = {};
    int laser_ctx = 0, laser_cty = 0;                        // grosses tuiles allouees
    sg_image laser_img = {};                                 // tuiles en calcul : lasers du pixel (RGBA16F)
    sg_view laser_store = {}, laser_tex = {};
    sg_image laser_arc_img = {};                             // nappes coniques (passe des arcs), ajoutees par cs_laser_shade
    sg_view laser_arc_store = {}, laser_arc_tex = {};
    std::vector<float> laser_data;                           // sb_laser_t[] (28 flottants)
    sg_image volutes_img = {};                               // volutes fines (128^3 RGBA8, mipmaps)
    sg_view volutes_view = {};
    sg_sampler volutes_smp = {};
    sg_image clouds_img = {};                                // fumee spatiale : nuages (64^3 BC5), crees au 1er usage du modele v2
    sg_view clouds_view = {};
  public:
    double volutes_build_ms = 0;                             // generation au lancement
    std::vector<float> volutes_sd;                           // ecart type de chaque niveau de mip
    SpatialFogClouds clouds;                                 // nuages : temps de generation, contraste des niveaux
  private:
    sg_pipeline pip_laser_setup = {}, pip_laser_bin = {};
    // impacts sur les surfaces (LaserRig::hits) : bandes fines ajoutees a l'image de la scene
    static constexpr int MAX_LASER_HITS = 32768;
    sg_pipeline pip_laser_hit = {};
    sg_buffer laser_hit_buf = {};
    sg_view laser_hit_view = {};
    std::vector<float> laser_hit_data;   // sb_hit_t[] (28 flottants), coupes au plan proche de la camera
    sg_buffer laser_exit_buf = {};       // lueurs de sortie (sb_hit_t, type 3), dessinees apres la composition
    sg_view laser_exit_view = {};
    std::vector<float> laser_exit_data;
    // [sans, avec degrades (couleur au bord 1)][fumee uniforme, de la piece, avec volutes, et leur 2e octave, fumee spatiale, avec ses filaments]
    sg_pipeline pip_laser_shade[2][6][2] = {};   // [...][...][sans, avec nappes coniques (arcs)]
    sg_pipeline pip_laser_shade_c[2][6] = {};   // passe principale avec la convergence RGB (LASER_CONV)
    sg_pipeline pip_laser_shade_s[2][2][3] = {};   // mesure (--stats) : [degrade][fumee 4, 5][principale, convergence, arcs]

    // grilles
    static constexpr int CL_X = 32, CL_Y = 18, CL_Z = 24;
    static constexpr int PR_X = 40, PR_Y = 14, PR_Z = 18;
    vec3 probe_min, probe_cell;
    vec3 hall_min, hall_max;   // interieur du hangar (les faisceaux s'arretent a ses parois)
};
