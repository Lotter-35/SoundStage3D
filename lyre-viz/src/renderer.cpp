#include "renderer.h"
#include "gpu_profiler.h"
#include "lasers.h"
#include "volutes.h"
#include "sokol_time.h"
#include "sokol_app.h"
#include "sokol_glue.h"
#include "shaders/lyreviz.glsl.h"
#include <algorithm>
#include <atomic>
#include <cstring>
#include <cstdlib>
#include <functional>

// flottants par segment envoye au rendu (sb_laser du shader)
static constexpr int LASER_FLOATS = (int)(sizeof(sb_laser_t) / sizeof(float));

namespace {

struct Vertex {
    float px, py, pz, nx, ny, nz;
};

void make_cube(std::vector<Vertex>& v, std::vector<uint16_t>& idx) {
    const float n[6][3] = {{1, 0, 0}, {-1, 0, 0}, {0, 1, 0}, {0, -1, 0}, {0, 0, 1}, {0, 0, -1}};
    for (int f = 0; f < 6; f++) {
        vec3 N = {n[f][0], n[f][1], n[f][2]};
        vec3 a = std::fabs(N.y) > 0.5f ? vec3(1, 0, 0) : vec3(0, 1, 0);
        vec3 b = cross(N, a);
        uint16_t base = (uint16_t)v.size();
        const float s[4][2] = {{-1, -1}, {1, -1}, {1, 1}, {-1, 1}};
        for (int k = 0; k < 4; k++) {
            vec3 p = N + a * s[k][0] + b * s[k][1];
            v.push_back({p.x, p.y, p.z, N.x, N.y, N.z});
        }
        uint16_t q[6] = {0, 1, 2, 0, 2, 3};
        for (uint16_t i : q) idx.push_back(base + i);
    }
}

void make_cylinder(std::vector<Vertex>& v, std::vector<uint16_t>& idx, int seg) {
    // axe Z de -1 a 1, rayon 1
    for (int i = 0; i <= seg; i++) {
        float a = 2 * PI * i / seg;
        float c = std::cos(a), s = std::sin(a);
        v.push_back({c, s, -1, c, s, 0});
        v.push_back({c, s, 1, c, s, 0});
    }
    for (int i = 0; i < seg; i++) {
        uint16_t b = (uint16_t)(i * 2);
        uint16_t q[6] = {b, (uint16_t)(b + 2), (uint16_t)(b + 1), (uint16_t)(b + 1), (uint16_t)(b + 2), (uint16_t)(b + 3)};
        for (uint16_t k : q) idx.push_back(k);
    }
    for (int cap = 0; cap < 2; cap++) {
        float z = cap ? 1.0f : -1.0f;
        uint16_t center = (uint16_t)v.size();
        v.push_back({0, 0, z, 0, 0, z});
        for (int i = 0; i <= seg; i++) {
            float a = 2 * PI * i / seg;
            v.push_back({std::cos(a), std::sin(a), z, 0, 0, z});
        }
        for (int i = 0; i < seg; i++) {
            idx.push_back(center);
            idx.push_back((uint16_t)(center + 1 + i));
            idx.push_back((uint16_t)(center + 2 + i));
        }
    }
}

// Cone d'un faisceau : sommet en 0, cercle de rayon 1 en z = 1, ferme par un disque.
// Polygone a 24 cotes (le vertex shader l'agrandit pour qu'il contienne le vrai cone).
void make_beam_cone(std::vector<float>& v, std::vector<uint16_t>& idx) {
    const int N = 24;
    v = {0, 0, 0};
    for (int i = 0; i < N; i++) {
        float a = 2 * PI * i / N;
        v.insert(v.end(), {std::cos(a), std::sin(a), 1.0f});
    }
    v.insert(v.end(), {0, 0, 1});
    const uint16_t cap = (uint16_t)(N + 1);
    for (int i = 0; i < N; i++) {
        uint16_t r0 = (uint16_t)(1 + i), r1 = (uint16_t)(1 + (i + 1) % N);
        idx.insert(idx.end(), {0, r0, r1});      // cote
        idx.insert(idx.end(), {cap, r1, r0});    // fond
    }
}

// Puissance d'un laser dans la fumee : couleur x W x LASER_FLUX_PER_W (meme unite que les lyres).
// Provisoire : la puissance en watts par couleur et le blanchiment viendront a l'etape 4 du plan.
constexpr float LASER_FLUX_PER_W = 20.0f;
// Lueur de sortie : part de la puissance diffusee par la fenetre de sortie d'un laser, par steradian (reglee a l'oeil
// sur les photos de reference : sortie blanche a 10 m, halo de la couleur du laser)
constexpr float LASER_EXIT_SCATTER = 0.02f;
constexpr int MAX_LASER_EXITS = 512;

// Distance le long de d (unitaire) pour sortir de la boite [mn, mx], depuis p (dedans) : portee d'une nappe dans le hangar.
float exit_box(vec3 p, vec3 d, vec3 mn, vec3 mx) {
    float t = 1e30f;
    for (int a = 0; a < 3; a++) {
        if (d[a] > 1e-6f) t = std::min(t, (mx[a] - p[a]) / d[a]);
        else if (d[a] < -1e-6f) t = std::min(t, (mn[a] - p[a]) / d[a]);
    }
    return std::max(t, 0.0f);
}

// Point du triangle (a, b, c) le plus proche de p (Ericson, Real-Time Collision Detection, 5.1.5).
vec3 closest_on_triangle(vec3 p, vec3 a, vec3 b, vec3 c) {
    const vec3 ab = b - a, ac = c - a, ap = p - a;
    const float d1 = dot(ab, ap), d2 = dot(ac, ap);
    if (d1 <= 0 && d2 <= 0) return a;
    const vec3 bp = p - b;
    const float d3 = dot(ab, bp), d4 = dot(ac, bp);
    if (d3 >= 0 && d4 <= d3) return b;
    const float vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) return a + ab * (d1 / (d1 - d3));
    const vec3 cp = p - c;
    const float d5 = dot(ab, cp), d6 = dot(ac, cp);
    if (d6 >= 0 && d5 <= d6) return c;
    const float vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) return a + ac * (d2 / (d2 - d6));
    const float va = d3 * d6 - d5 * d4;
    if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) return b + (c - b) * ((d4 - d3) / ((d4 - d3) + (d5 - d6)));
    const float den = 1.0f / (va + vb + vc);
    return a + ab * (vb * den) + ac * (vc * den);
}

// Force des volutes fines (amplitude de la modulation, en ecarts types) : 'hz' brume, 'smoke' amas (memes unites).
// Faibles dans la brume du hazer (fumee fine et reguliere), fortes dans les amas des machines a fumee.
float volutes_force(const RenderSettings& rs, float hz, float smoke) {
    if (!rs.laser_volutes) return 0.0f;
    const float part = smoke / std::max(hz + smoke, 1e-4f);
    return rs.laser_vol_strength * (0.35f + 0.65f * part);
}

sg_buffer make_buffer(const void* data, size_t size, bool index, const char* label) {
    sg_buffer_desc d = {};
    d.size = size;
    d.data.ptr = data;
    d.data.size = size;
    d.usage.vertex_buffer = !index;
    d.usage.index_buffer = index;
    d.label = label;
    return sg_make_buffer(&d);
}

sg_buffer make_storage(size_t size, bool transient, const char* label) {
    sg_buffer_desc d = {};
    d.size = size;
    d.usage.storage_buffer = true;
    d.usage.vertex_buffer = false;
    d.usage.write_transient = transient;
    d.label = label;
    return sg_make_buffer(&d);
}

sg_view storage_view(sg_buffer b) {
    sg_view_desc d = {};
    d.storage_buffer.buffer = b;
    return sg_make_view(&d);
}

sg_view texture_view(sg_image img) {
    sg_view_desc d = {};
    d.texture.image = img;
    return sg_make_view(&d);
}

void set4(float* dst, vec3 v, float w) { dst[0] = v.x; dst[1] = v.y; dst[2] = v.z; dst[3] = w; }
void set4(float* dst, float x, float y, float z, float w) { dst[0] = x; dst[1] = y; dst[2] = z; dst[3] = w; }

sg_pipeline make_fullscreen_pipeline(const sg_shader_desc* sd, sg_pixel_format fmt, bool additive, const char* label) {
    sg_pipeline_desc p = {};
    p.shader = sg_make_shader(sd);
    p.color_count = 1;
    p.colors[0].pixel_format = fmt;
    if (additive) {
        p.colors[0].blend.enabled = true;
        p.colors[0].blend.src_factor_rgb = SG_BLENDFACTOR_ONE;
        p.colors[0].blend.dst_factor_rgb = SG_BLENDFACTOR_ONE;
        p.colors[0].blend.src_factor_alpha = SG_BLENDFACTOR_ONE;
        p.colors[0].blend.dst_factor_alpha = SG_BLENDFACTOR_ONE;
    }
    p.depth.pixel_format = SG_PIXELFORMAT_NONE;
    p.sample_count = 1;
    p.label = label;
    return sg_make_pipeline(&p);
}

sg_pipeline make_compute_pipeline(const sg_shader_desc* sd, const char* label) {
    sg_pipeline_desc p = {};
    p.compute = true;
    p.shader = sg_make_shader(sd);
    p.label = label;
    return sg_make_pipeline(&p);
}

// Distance le long de l'axe a partir de laquelle tout le cone (sommet a, axe f, demi-angle de
// tangente t) est sorti de la boite [mn, mx] (le hangar). Au-dela, le cone est entierement derriere
// le sol, un mur ou le toit : il ne peut ni etre vu, ni eclairer une surface visible. Couper le
// faisceau la ne change donc pas l'image, mais evite de trier et de tester un cone 5 fois trop long.
float cone_exit_distance(vec3 a, vec3 f, float t, vec3 mn, vec3 mx) {
    float h = 1e30f;
    for (int axis = 0; axis < 3; axis++) {
        for (int side = 0; side < 2; side++) {
            // plan : s * x[axis] = c, interieur : s * x[axis] < c
            const float s = side ? 1.0f : -1.0f;
            const float c = side ? mx[axis] : -mn[axis];
            const float nf = s * f[axis];
            // point du disque le plus en arriere : n.f - t * |n x f|
            const float rate = nf - t * std::sqrt(std::max(0.0f, 1.0f - nf * nf));
            if (rate <= 1e-6f) continue;   // le cone ne sort jamais en entier par ce plan
            h = std::min(h, std::max(0.0f, (c - s * a[axis]) / rate));
        }
    }
    return h;
}

float max_facet_offset(int prism) {
    switch (prism) {
        case PRISM_9_GRID: return 1.15f;
        case PRISM_LINEAR_4: return 1.06f;
        case PRISM_NONE: return 0.0f;
        default: return 1.0f;
    }
}

}  // namespace

// --------------------------------------------------------------------------------------------
//  Initialisation
// --------------------------------------------------------------------------------------------
void Renderer::init(const Scene& scene, const GoboAtlas& gobos, const FogSim& fog, const FloorTexture& floor, int floor_aniso) {
    const sg_backend backend = sg_query_backend();

    // maillages
    std::vector<Vertex> v;
    std::vector<uint16_t> idx;
    make_cube(v, idx);
    cube_vb = make_buffer(v.data(), v.size() * sizeof(Vertex), false, "cube-vb");
    cube_ib = make_buffer(idx.data(), idx.size() * sizeof(uint16_t), true, "cube-ib");
    cube_indices = (int)idx.size();
    v.clear();
    idx.clear();
    make_cylinder(v, idx, 24);
    cyl_vb = make_buffer(v.data(), v.size() * sizeof(Vertex), false, "cyl-vb");
    cyl_ib = make_buffer(idx.data(), idx.size() * sizeof(uint16_t), true, "cyl-ib");
    cyl_indices = (int)idx.size();
    {
        std::vector<float> cv;
        std::vector<uint16_t> ci;
        make_beam_cone(cv, ci);
        cone_vb = make_buffer(cv.data(), cv.size() * sizeof(float), false, "cone-vb");
        cone_ib = make_buffer(ci.data(), ci.size() * sizeof(uint16_t), true, "cone-ib");
        cone_indices = (int)ci.size();
    }

    num_static_cubes = (int)scene.cubes.size();
    num_static_cyls = (int)scene.cylinders.size();
    if (num_static_cubes) static_cubes = make_buffer(scene.cubes.data(), scene.cubes.size() * sizeof(Instance), false, "static-cubes");
    if (num_static_cyls) static_cyls = make_buffer(scene.cylinders.data(), scene.cylinders.size() * sizeof(Instance), false, "static-cyls");
    {
        sg_buffer_desc d = {};
        d.size = MAX_DYN * sizeof(Instance);
        d.usage.vertex_buffer = true;
        d.usage.write_transient = true;
        d.label = "dyn-cubes";
        dyn_cube_buf = sg_make_buffer(&d);
        d.label = "dyn-cyls";
        dyn_cyl_buf = sg_make_buffer(&d);
    }

    // donnees des lumieres
    light_buf = make_storage(MAX_LIGHTS * sizeof(sb_light_t), true, "lights");
    cluster_buf = make_storage((size_t)CL_X * CL_Y * CL_Z * 256 * sizeof(uint32_t), false, "clusters");
    vpl_buf = make_storage(MAX_VPLS * sizeof(sb_vpl_t), true, "vpls");
    light_view = storage_view(light_buf);
    cluster_view = storage_view(cluster_buf);
    cluster_buf_m = make_storage((size_t)CL_X * CL_Y * CL_Z * 256 * sizeof(uint32_t), false, "clusters-mirror");
    cluster_view_m = storage_view(cluster_buf_m);
    vpl_view = storage_view(vpl_buf);
    for (int i = 0; i < 3; i++) {
        sg_image_desc d = {};
        d.width = PR_X;
        d.height = PR_Y * PR_Z;
        d.pixel_format = SG_PIXELFORMAT_RGBA16F;
        d.usage.storage_image = true;
        d.label = "probes";
        probe_img[i] = sg_make_image(&d);
        sg_view_desc vd = {};
        vd.storage_image.image = probe_img[i];
        probe_store[i] = sg_make_view(&vd);
        probe_tex[i] = texture_view(probe_img[i]);
    }
    light_data.resize(MAX_LIGHTS * sizeof(sb_light_t));
    // obstacles fixes (ombres) : volumes d'ombre recalcules a chaque image (les lyres bougent)
    occluders = scene.occluders;
    occ_light_buf = make_storage(MAX_LIGHTS * sizeof(sb_occ_t), true, "occluders-per-light");
    occ_light_view = storage_view(occ_light_buf);
    occ_light_data.assign(MAX_LIGHTS * 4, 0);
    occ_plane_buf = make_storage(MAX_OCC_PAIRS * OCC_BLOCK * sizeof(sb_vec4_t), true, "shadow-volumes");
    occ_plane_view = storage_view(occ_plane_buf);
    occ_plane_data.assign(MAX_OCC_PAIRS * OCC_BLOCK * 4, 0.0f);
    occ_tile_data.assign(2 * 576 * 64, 0u);   // 2 cameras x 32 x 18 tuiles x 256 lyres (8 bits)
    occ_tile_buf = make_storage(occ_tile_data.size() * sizeof(uint32_t), true, "shadow-tiles");
    occ_tile_view = storage_view(occ_tile_buf);
    btab_buf = make_storage(MAX_LIGHTS * sizeof(sb_btab_t), true, "beam-tables");
    btab_view = storage_view(btab_buf);
    btab_data.resize(MAX_LIGHTS * sizeof(sb_btab_t));
    btab_job_buf = make_storage(MAX_BTAB_JOBS * sizeof(uint32_t), true, "beam-table-jobs");
    beam_list_buf = make_storage(MAX_LIGHTS * sizeof(uint32_t), true, "beam-list");
    pimg_desc_buf = make_storage(MAX_LIGHTS * 4 * sizeof(float), true, "pattern-image-desc");
    pimg_list_buf = make_storage(MAX_LIGHTS * sizeof(uint32_t), true, "pattern-image-list");
    pimg_desc_view = storage_view(pimg_desc_buf);
    pimg_list_view = storage_view(pimg_list_buf);
    pimg_desc.assign(MAX_LIGHTS * 4, 0.0f);
    {
        sg_image_desc d = {};
        d.width = PIMG_ATLAS_W;
        d.height = PIMG_ATLAS_H;
        d.pixel_format = SG_PIXELFORMAT_R32F;   // en couleur avec l'aberration chromatique : pimg_img_rgb
        d.usage.storage_image = true;
        d.label = "pattern-images";
        pimg_img = sg_make_image(&d);
        sg_view_desc vd = {};
        vd.storage_image.image = pimg_img;
        pimg_store = sg_make_view(&vd);
        pimg_tex = texture_view(pimg_img);
    }
    beam_list_view = storage_view(beam_list_buf);
    beam_list_buf_m = make_storage(MAX_LIGHTS * sizeof(uint32_t), true, "beam-list-mirror");
    beam_list_view_m = storage_view(beam_list_buf_m);
    beam_order_m.reserve(MAX_LIGHTS);
    beam_order.reserve(MAX_LIGHTS);
    btab_job_view = storage_view(btab_job_buf);
    btab_jobs.reserve(MAX_BTAB_JOBS);
    btab_buf_m = make_storage(MAX_LIGHTS * sizeof(sb_btab_t), true, "beam-tables-mirror");
    btab_view_m = storage_view(btab_buf_m);
    btab_data_m.resize(MAX_LIGHTS * sizeof(sb_btab_t));
    btab_job_buf_m = make_storage(MAX_BTAB_JOBS * sizeof(uint32_t), true, "beam-table-jobs-mirror");
    btab_job_view_m = storage_view(btab_job_buf_m);
    btab_jobs_m.reserve(MAX_BTAB_JOBS);
    {
        sg_image_desc d = {};
        d.width = BTAB_W;
        d.height = BTAB_H;
        d.pixel_format = SG_PIXELFORMAT_R32F;
        d.usage.storage_image = true;
        d.label = "beam-table-atlas";
        btab_img = sg_make_image(&d);
        sg_view_desc vd = {};
        vd.storage_image.image = btab_img;
        btab_store = sg_make_view(&vd);
        btab_tex = texture_view(btab_img);
    }
    vpl_data.resize(MAX_VPLS * sizeof(sb_vpl_t));
    gobo_transmission = gobos.transmission;

    // grille de sondes (lumiere indirecte) dans le hangar
    hall_min = scene.bounds_min;
    hall_max = scene.bounds_max;
    probe_min = scene.bounds_min + vec3(0.5f, 0.3f, 0.5f);
    vec3 pmax = scene.bounds_max - vec3(0.5f, 0.5f, 0.5f);
    probe_cell = {(pmax.x - probe_min.x) / (PR_X - 1), (pmax.y - probe_min.y) / (PR_Y - 1), (pmax.z - probe_min.z) / (PR_Z - 1)};

    // textures
    {
        sg_image_desc d = {};
        d.type = SG_IMAGETYPE_ARRAY;
        d.width = GoboAtlas::SIZE;
        d.height = GoboAtlas::SIZE;
        d.num_slices = gobos.num_layers;
        d.num_mipmaps = gobos.num_mips;
        d.pixel_format = SG_PIXELFORMAT_R8;
        for (int m = 0; m < gobos.num_mips; m++) {
            d.data.mip_levels[m].ptr = gobos.mips[m].data();
            d.data.mip_levels[m].size = gobos.mips[m].size();
        }
        d.label = "gobos";
        gobo_img = sg_make_image(&d);
        gobo_view = texture_view(gobo_img);
    }
    {
        sg_image_desc d = {};
        d.type = SG_IMAGETYPE_3D;
        d.width = FogSim::NX;
        d.height = FogSim::NY;
        d.num_slices = FogSim::NZ;
        d.pixel_format = SG_PIXELFORMAT_RGBA8;   // r : amas (lyres), g : densite de la piece (lasers), b : structure (v2)
        d.usage.write_transient = true;
        d.label = "fog";
        fog_img = sg_make_image(&d);
        fog_view = texture_view(fog_img);
    }
    {
        sg_image_desc d = {};
        d.type = SG_IMAGETYPE_3D;
        d.width = d.height = d.num_slices = FogSim::DETAIL;
        d.pixel_format = SG_PIXELFORMAT_R8;
        d.data.mip_levels[0].ptr = fog.detail.data();
        d.data.mip_levels[0].size = fog.detail.size();
        d.label = "fog-detail";
        detail_img = sg_make_image(&d);
        detail_view = texture_view(detail_img);
    }
    {
        // lasers : volutes fines (texture 3D periodique, 4 instants de l'evolution par canal), generees ici
        Volutes vol;
        vol.build();
        volutes_build_ms = vol.build_ms;
        volutes_sd = vol.level_sd;
        sg_image_desc d = {};
        d.type = SG_IMAGETYPE_3D;
        d.width = d.height = d.num_slices = VOLUTES_N;
        d.num_mipmaps = (int)vol.mips.size();
        d.pixel_format = SG_PIXELFORMAT_BC5_RG;
        for (size_t m = 0; m < vol.mips.size(); m++) {
            d.data.mip_levels[m].ptr = vol.mips[m].data();
            d.data.mip_levels[m].size = vol.mips[m].size();
        }
        d.label = "laser-volutes";
        volutes_img = sg_make_image(&d);
        volutes_view = texture_view(volutes_img);
        sg_sampler_desc s = {};
        s.min_filter = s.mag_filter = s.mipmap_filter = SG_FILTER_LINEAR;
        s.wrap_u = s.wrap_v = s.wrap_w = SG_WRAP_REPEAT;
        s.label = "volutes-smp";
        volutes_smp = sg_make_sampler(&s);
    }
    {
        // sol texture (sans fichiers : une image unie, le sol garde le beton uni)
        floor_tex = floor.ok ? &floor : nullptr;
        static const uint8_t flat[4] = {115, 128, 128, 82};
        sg_image_desc d = {};
        d.pixel_format = SG_PIXELFORMAT_RGBA8;
        if (floor.ok) {
            d.width = d.height = floor.size;
            d.num_mipmaps = floor.num_mips;
            for (int m = 0; m < floor.num_mips; m++) {
                d.data.mip_levels[m].ptr = floor.mips[m].data();
                d.data.mip_levels[m].size = floor.mips[m].size();
            }
        } else {
            d.width = d.height = 1;
            d.data.mip_levels[0].ptr = flat;
            d.data.mip_levels[0].size = 4;
        }
        d.label = "floor";
        floor_img = sg_make_image(&d);
        floor_view = texture_view(floor_img);
        // creux du beton (eau au sol) ; sans texture : aucun creux
        static const uint8_t no_cav[1] = {255};
        sg_image_desc dc = {};
        dc.pixel_format = SG_PIXELFORMAT_R8;
        if (floor.ok) {
            dc.width = dc.height = floor.size;
            dc.num_mipmaps = (int)floor.cav_mips.size();
            for (int m = 0; m < dc.num_mipmaps; m++) {
                dc.data.mip_levels[m].ptr = floor.cav_mips[m].data();
                dc.data.mip_levels[m].size = floor.cav_mips[m].size();
            }
        } else {
            dc.width = dc.height = 1;
            dc.data.mip_levels[0].ptr = no_cav;
            dc.data.mip_levels[0].size = 1;
        }
        dc.label = "floor-cavities";
        floor_cav_img = sg_make_image(&dc);
        floor_cav_view = texture_view(floor_cav_img);
        // luminance moyenne = celle du beton uni (instance du sol, scene.cpp) : 0,2007
        floor_scale = floor.ok ? 0.2007f / std::max(floor.mean_lum, 1e-3f) : 1.0f;
        sg_sampler_desc s = {};
        s.min_filter = s.mag_filter = s.mipmap_filter = SG_FILTER_LINEAR;
        s.wrap_u = s.wrap_v = SG_WRAP_REPEAT;
        s.max_anisotropy = (uint32_t)std::clamp(floor_aniso, 1, 16);   // sol vu en rasant : net au loin, sans moire
        s.label = "floor-smp";
        floor_smp = sg_make_sampler(&s);
    }
    {
        sg_sampler_desc s = {};
        s.min_filter = SG_FILTER_LINEAR;
        s.mag_filter = SG_FILTER_LINEAR;
        s.mipmap_filter = SG_FILTER_LINEAR;
        s.wrap_u = s.wrap_v = s.wrap_w = SG_WRAP_CLAMP_TO_EDGE;
        s.label = "gobo-smp";
        gobo_smp = sg_make_sampler(&s);
        s.mipmap_filter = SG_FILTER_NEAREST;
        s.label = "lin-clamp";
        lin_clamp = sg_make_sampler(&s);
        s.wrap_u = s.wrap_v = s.wrap_w = SG_WRAP_REPEAT;
        s.label = "lin-repeat";
        lin_repeat = sg_make_sampler(&s);
        // reflet flou du beton mouille : pyramide lue en trilineaire anisotrope (trainees verticales)
        s.mipmap_filter = SG_FILTER_LINEAR;
        s.wrap_u = s.wrap_v = s.wrap_w = SG_WRAP_CLAMP_TO_EDGE;
        s.max_anisotropy = 4;
        s.label = "refl-smp";
        refl_smp = sg_make_sampler(&s);
        s = {};
        s.min_filter = SG_FILTER_NEAREST;
        s.mag_filter = SG_FILTER_NEAREST;
        s.mipmap_filter = SG_FILTER_NEAREST;
        s.wrap_u = s.wrap_v = s.wrap_w = SG_WRAP_CLAMP_TO_EDGE;
        s.label = "point-smp";
        point_smp = sg_make_sampler(&s);
    }

    // pipelines
    pip_cull_clusters = make_compute_pipeline(cull_clusters_shader_desc(backend), "cull-clusters");
    pip_probes = make_compute_pipeline(probes_shader_desc(backend), "probes");
    pip_beam_tables = make_compute_pipeline(beam_tables_shader_desc(backend), "beam-tables");
    pip_pattern_images = make_compute_pipeline(pattern_images_shader_desc(backend), "pattern-images");
    pip_pattern_images_rgb = make_compute_pipeline(pattern_images_rgb_shader_desc(backend), "pattern-images-rgb");
    for (int pass = 0; pass < 3; pass++) {
        // pass 0 : pre-passe de profondeur ; pass 1 : surfaces eclairees ; pass 2 : idem, sol mouille
        const int wet = pass == 2 ? 1 : 0;
        sg_pipeline_desc p = {};
        p.shader = sg_make_shader(pass == 0 ? depth_only_shader_desc(backend)
                                            : (wet ? scene_wet_shader_desc(backend) : scene_shader_desc(backend)));
        p.layout.buffers[0].stride = sizeof(Vertex);
        p.layout.buffers[1].stride = sizeof(Instance);
        p.layout.buffers[1].step_func = SG_VERTEXSTEP_PER_INSTANCE;
        p.layout.attrs[ATTR_scene_position] = {0, 0, SG_VERTEXFORMAT_FLOAT3};
        p.layout.attrs[ATTR_scene_normal] = {0, 12, SG_VERTEXFORMAT_FLOAT3};
        p.layout.attrs[ATTR_scene_inst_r0] = {1, 0, SG_VERTEXFORMAT_FLOAT4};
        p.layout.attrs[ATTR_scene_inst_r1] = {1, 16, SG_VERTEXFORMAT_FLOAT4};
        p.layout.attrs[ATTR_scene_inst_r2] = {1, 32, SG_VERTEXFORMAT_FLOAT4};
        p.layout.attrs[ATTR_scene_inst_albedo] = {1, 48, SG_VERTEXFORMAT_FLOAT4};
        p.layout.attrs[ATTR_scene_inst_emissive] = {1, 64, SG_VERTEXFORMAT_FLOAT4};
        p.index_type = SG_INDEXTYPE_UINT16;
        p.cull_mode = SG_CULLMODE_NONE;
        p.depth.pixel_format = SG_PIXELFORMAT_DEPTH;
        p.sample_count = 1;
        if (pass == 0) {
            p.depth.compare = SG_COMPAREFUNC_GREATER;   // Z inverse
            p.depth.write_enabled = true;
            p.color_count = 0;
            p.label = "depth-prepass";
            pip_depth = sg_make_pipeline(&p);
        } else {
            p.color_count = 2;
            p.colors[0].pixel_format = SG_PIXELFORMAT_RGBA16F;
            p.colors[1].pixel_format = SG_PIXELFORMAT_R32F;
            p.label = wet ? "scene-wet" : "scene";
            p.depth.compare = SG_COMPAREFUNC_GREATER;
            p.depth.write_enabled = true;
            pip_scene[wet] = sg_make_pipeline(&p);
            // apres la pre-passe : meme profondeur exactement (meme vertex shader), pas d'ecriture
            p.depth.compare = SG_COMPAREFUNC_GREATER_EQUAL;
            p.depth.write_enabled = false;
            p.label = wet ? "scene-wet-after-prepass" : "scene-after-prepass";
            pip_scene_eq[wet] = sg_make_pipeline(&p);
            // variantes qui ecrivent aussi normale et matiere (passe des lyres douces)
            p.shader = sg_make_shader(wet ? scene_gb_wet_shader_desc(backend) : scene_gb_shader_desc(backend));
            p.color_count = 4;
            p.colors[2].pixel_format = SG_PIXELFORMAT_RGBA16F;
            p.colors[3].pixel_format = SG_PIXELFORMAT_RGBA8;
            p.label = wet ? "scene-gb-wet-after-prepass" : "scene-gb-after-prepass";
            pip_scene_eq_gb[wet] = sg_make_pipeline(&p);
            p.depth.compare = SG_COMPAREFUNC_GREATER;
            p.depth.write_enabled = true;
            p.label = wet ? "scene-gb-wet" : "scene-gb";
            pip_scene_gb[wet] = sg_make_pipeline(&p);
        }
    }
    pip_vol_ambient = make_fullscreen_pipeline(vol_ambient_shader_desc(backend), SG_PIXELFORMAT_RGBA16F, false, "vol-ambient");
    {
        sg_pipeline_desc p = {};
        p.shader = sg_make_shader(soft_light_shader_desc(backend));
        p.color_count = 4;
        for (int k = 0; k < 4; k++) p.colors[k].pixel_format = SG_PIXELFORMAT_RGBA16F;
        p.depth.pixel_format = SG_PIXELFORMAT_NONE;
        p.sample_count = 1;
        p.label = "soft-light";
        pip_soft = sg_make_pipeline(&p);
        // variante legere (lyres frost seules) : eclairement et reflet
        p.shader = sg_make_shader(soft_simple_shader_desc(backend));
        p.color_count = 2;
        p.label = "soft-simple";
        pip_soft_simple = sg_make_pipeline(&p);
    }
    pip_vol_merge = make_fullscreen_pipeline(vol_merge_shader_desc(backend), SG_PIXELFORMAT_RGBA16F, true, "vol-merge");
    {
        // faisceaux : cones en instances, faces arriere seulement, additionnes
        sg_pipeline_desc p = {};
        p.shader = sg_make_shader(beams_shader_desc(backend));
        p.layout.attrs[ATTR_beams_cone_pos].format = SG_VERTEXFORMAT_FLOAT3;
        p.index_type = SG_INDEXTYPE_UINT16;
        // les triangles du cone tournent dans le sens des aiguilles d'une montre vus de l'exterieur :
        // on garde les faces les plus eloignees (elles existent aussi quand la camera est dans le cone)
        p.cull_mode = SG_CULLMODE_BACK;
        p.face_winding = SG_FACEWINDING_CCW;
        p.depth.pixel_format = SG_PIXELFORMAT_NONE;
        // somme en demi-flottants : meme image qu'en 32 bits (mesure), melange deux fois plus rapide
        p.colors[0].pixel_format = SG_PIXELFORMAT_RGBA16F;
        p.colors[0].blend.enabled = true;
        p.colors[0].blend.src_factor_rgb = SG_BLENDFACTOR_ONE;
        p.colors[0].blend.dst_factor_rgb = SG_BLENDFACTOR_ONE;
        p.colors[0].blend.src_factor_alpha = SG_BLENDFACTOR_ZERO;
        p.colors[0].blend.dst_factor_alpha = SG_BLENDFACTOR_ONE;
        p.sample_count = 1;
        p.label = "beams";
        pip_beams = sg_make_pipeline(&p);
        p.shader = sg_make_shader(beams_an_shader_desc(backend));
        p.label = "beams-analytic";
        pip_beams_an = sg_make_pipeline(&p);
        // camera miroir : l'image est retournee, les faces eloignees sont les faces avant
        p.shader = sg_make_shader(beams_shader_desc(backend));
        p.cull_mode = SG_CULLMODE_FRONT;
        p.label = "beams-mirror";
        pip_beams_m = sg_make_pipeline(&p);
        p.shader = sg_make_shader(beams_an_shader_desc(backend));
        p.label = "beams-analytic-mirror";
        pip_beams_an_m = sg_make_pipeline(&p);
    }
    pip_refl_compose = make_fullscreen_pipeline(refl_compose_shader_desc(backend), SG_PIXELFORMAT_RGBA16F, false, "refl-compose");
    pip_refl_down = make_fullscreen_pipeline(refl_down_shader_desc(backend), SG_PIXELFORMAT_RGBA16F, false, "refl-down");
    {
        // masque du reflet : eau par pixel du miroir, puis par blocs : profondeur de la camera miroir (ecrite
        // par le shader) et profondeur lineaire
        pip_refl_mask = make_fullscreen_pipeline(refl_mask_shader_desc(backend), SG_PIXELFORMAT_R8, false, "refl-mask");
        sg_pipeline_desc p = {};
        p.shader = sg_make_shader(refl_block_shader_desc(backend));
        p.color_count = 1;
        p.colors[0].pixel_format = SG_PIXELFORMAT_R32F;
        p.depth.pixel_format = SG_PIXELFORMAT_DEPTH;
        p.depth.compare = SG_COMPAREFUNC_ALWAYS;
        p.depth.write_enabled = true;
        p.sample_count = 1;
        p.label = "refl-block";
        pip_refl_block = sg_make_pipeline(&p);
    }
    pip_temporal = make_fullscreen_pipeline(temporal_shader_desc(backend), SG_PIXELFORMAT_RGBA16F, false, "temporal");
    pip_composite = make_fullscreen_pipeline(composite_shader_desc(backend), SG_PIXELFORMAT_RGBA16F, false, "composite");
    pip_bloom_down = make_fullscreen_pipeline(bloom_down_shader_desc(backend), SG_PIXELFORMAT_RGBA16F, false, "bloom-down");
    pip_laser_up = make_fullscreen_pipeline(laser_up_shader_desc(backend), SG_PIXELFORMAT_RGBA16F, false, "laser-up");
    pip_bloom_up = make_fullscreen_pipeline(bloom_up_shader_desc(backend), SG_PIXELFORMAT_RGBA16F, true, "bloom-up");
    {
        sg_pipeline_desc p = {};
        p.shader = sg_make_shader(final_shader_desc(backend));
        p.label = "final";
        pip_final = sg_make_pipeline(&p);   // formats de l'ecran par defaut
    }
    // FSR 1 : fs_final dans une image a la resolution interne, EASU vers l'ecran agrandi, RCAS sur l'ecran
    pip_final_fsr = make_fullscreen_pipeline(final_shader_desc(backend), SG_PIXELFORMAT_RGBA16F, false, "final-fsr");
    pip_fsr_easu = make_fullscreen_pipeline(fsr_easu_shader_desc(backend), SG_PIXELFORMAT_RGBA16F, false, "fsr-easu");
    {
        sg_pipeline_desc p = {};
        p.shader = sg_make_shader(fsr_rcas_shader_desc(backend));
        p.label = "fsr-rcas";
        pip_fsr_rcas = sg_make_pipeline(&p);   // formats de l'ecran par defaut
    }

    // lasers (tuiles en calcul)
    laser_buf = make_storage(MAX_LASER_SEGS * sizeof(sb_laser_t), true, "laser-segments");
    laser_view = storage_view(laser_buf);
    // reflet du sol mouille : memes segments, camera miroir (cam_rel), et lueurs de sortie vues du miroir
    laser_buf_m = make_storage(MAX_LASER_SEGS * sizeof(sb_laser_t), true, "laser-segments-mirror");
    laser_view_m = storage_view(laser_buf_m);
    laser_exit_buf_m = make_storage((size_t)MAX_LASER_EXITS * sizeof(sb_hit_t), true, "laser-exits-mirror");
    laser_exit_view_m = storage_view(laser_exit_buf_m);
    laser_scr_buf = make_storage((size_t)MAX_LASER_SEGS * 9 * sizeof(sb_vec4_t), false, "laser-screen");
    laser_scr_view = storage_view(laser_scr_buf);
    laser_stats_buf = make_storage(16 * sizeof(uint32_t), false, "laser-stats");
    laser_stats_view = storage_view(laser_stats_buf);
    laser_data.reserve((size_t)MAX_LASER_SEGS * LASER_FLOATS);
    pip_laser_setup = make_compute_pipeline(laser_setup_shader_desc(backend), "laser-setup");
    {
        // impacts : 6 sommets par impact (instances), sans tampon de sommets, additionnes a l'image de la scene
        laser_hit_buf = make_storage((size_t)MAX_LASER_HITS * sizeof(sb_hit_t), true, "laser-hits");
        laser_hit_view = storage_view(laser_hit_buf);
        laser_hit_data.reserve((size_t)MAX_LASER_HITS * 28);
        laser_exit_buf = make_storage((size_t)MAX_LASER_EXITS * sizeof(sb_hit_t), true, "laser-exits");
        laser_exit_view = storage_view(laser_exit_buf);
        sg_pipeline_desc p = {};
        p.shader = sg_make_shader(laser_hit_shader_desc(backend));
        p.depth.pixel_format = SG_PIXELFORMAT_NONE;
        p.colors[0].pixel_format = SG_PIXELFORMAT_RGBA16F;
        p.colors[0].blend.enabled = true;
        p.colors[0].blend.src_factor_rgb = SG_BLENDFACTOR_ONE;
        p.colors[0].blend.dst_factor_rgb = SG_BLENDFACTOR_ONE;
        p.colors[0].blend.src_factor_alpha = SG_BLENDFACTOR_ZERO;
        p.colors[0].blend.dst_factor_alpha = SG_BLENDFACTOR_ONE;
        p.sample_count = 1;
        p.label = "laser-hits";
        pip_laser_hit = sg_make_pipeline(&p);
    }
    pip_laser_bin = make_compute_pipeline(laser_bin_shader_desc(backend), "laser-bin");
    pip_laser_shade[0][0][0] = make_compute_pipeline(laser_shade_shader_desc(backend), "laser-shade");
    pip_laser_shade[0][0][1] = make_compute_pipeline(laser_shade_a_shader_desc(backend), "laser-shade-arcs");
    pip_laser_shade[0][1][0] = make_compute_pipeline(laser_shade_f1_shader_desc(backend), "laser-shade-fog1");
    pip_laser_shade[0][1][1] = make_compute_pipeline(laser_shade_f1_a_shader_desc(backend), "laser-shade-fog1-arcs");
    pip_laser_shade[0][2][0] = make_compute_pipeline(laser_shade_f2_shader_desc(backend), "laser-shade-fog2");
    pip_laser_shade[0][2][1] = make_compute_pipeline(laser_shade_f2_a_shader_desc(backend), "laser-shade-fog2-arcs");
    pip_laser_shade[0][3][0] = make_compute_pipeline(laser_shade_f3_shader_desc(backend), "laser-shade-fog3");
    pip_laser_shade[0][3][1] = make_compute_pipeline(laser_shade_f3_a_shader_desc(backend), "laser-shade-fog3-arcs");
    pip_laser_shade[1][0][0] = make_compute_pipeline(laser_shade_grad_shader_desc(backend), "laser-shade-gradient");
    pip_laser_shade[1][0][1] = make_compute_pipeline(laser_shade_grad_a_shader_desc(backend), "laser-shade-gradient-arcs");
    pip_laser_shade[1][1][0] = make_compute_pipeline(laser_shade_grad_f1_shader_desc(backend), "laser-shade-gradient-fog1");
    pip_laser_shade[1][1][1] = make_compute_pipeline(laser_shade_grad_f1_a_shader_desc(backend), "laser-shade-gradient-fog1-arcs");
    pip_laser_shade[1][2][0] = make_compute_pipeline(laser_shade_grad_f2_shader_desc(backend), "laser-shade-gradient-fog2");
    pip_laser_shade[1][2][1] = make_compute_pipeline(laser_shade_grad_f2_a_shader_desc(backend), "laser-shade-gradient-fog2-arcs");
    pip_laser_shade[1][3][0] = make_compute_pipeline(laser_shade_grad_f3_shader_desc(backend), "laser-shade-gradient-fog3");
    pip_laser_shade[1][3][1] = make_compute_pipeline(laser_shade_grad_f3_a_shader_desc(backend), "laser-shade-gradient-fog3-arcs");
    pip_laser_shade[0][4][0] = make_compute_pipeline(laser_shade_f4_shader_desc(backend), "laser-shade-fog4");
    pip_laser_shade[0][4][1] = make_compute_pipeline(laser_shade_f4_a_shader_desc(backend), "laser-shade-fog4-arcs");
    pip_laser_shade[1][4][0] = make_compute_pipeline(laser_shade_grad_f4_shader_desc(backend), "laser-shade-gradient-fog4");
    pip_laser_shade[1][4][1] = make_compute_pipeline(laser_shade_grad_f4_a_shader_desc(backend), "laser-shade-gradient-fog4-arcs");
    pip_laser_shade[0][5][0] = make_compute_pipeline(laser_shade_f5_shader_desc(backend), "laser-shade-fog5");
    pip_laser_shade[0][5][1] = make_compute_pipeline(laser_shade_f5_a_shader_desc(backend), "laser-shade-fog5-arcs");
    pip_laser_shade[1][5][0] = make_compute_pipeline(laser_shade_grad_f5_shader_desc(backend), "laser-shade-gradient-fog5");
    pip_laser_shade[1][5][1] = make_compute_pipeline(laser_shade_grad_f5_a_shader_desc(backend), "laser-shade-gradient-fog5-arcs");
    pip_laser_shade_c[0][0] = make_compute_pipeline(laser_shade_c_shader_desc(backend), "laser-shade-conv");
    pip_laser_shade_c[0][1] = make_compute_pipeline(laser_shade_f1_c_shader_desc(backend), "laser-shade-f1-conv");
    pip_laser_shade_c[0][2] = make_compute_pipeline(laser_shade_f2_c_shader_desc(backend), "laser-shade-f2-conv");
    pip_laser_shade_c[0][3] = make_compute_pipeline(laser_shade_f3_c_shader_desc(backend), "laser-shade-f3-conv");
    pip_laser_shade_c[0][4] = make_compute_pipeline(laser_shade_f4_c_shader_desc(backend), "laser-shade-f4-conv");
    pip_laser_shade_c[0][5] = make_compute_pipeline(laser_shade_f5_c_shader_desc(backend), "laser-shade-f5-conv");
    pip_laser_shade_c[1][0] = make_compute_pipeline(laser_shade_grad_c_shader_desc(backend), "laser-shade-grad-conv");
    pip_laser_shade_c[1][1] = make_compute_pipeline(laser_shade_grad_f1_c_shader_desc(backend), "laser-shade-grad-f1-conv");
    pip_laser_shade_c[1][2] = make_compute_pipeline(laser_shade_grad_f2_c_shader_desc(backend), "laser-shade-grad-f2-conv");
    pip_laser_shade_c[1][3] = make_compute_pipeline(laser_shade_grad_f3_c_shader_desc(backend), "laser-shade-grad-f3-conv");
    pip_laser_shade_c[1][4] = make_compute_pipeline(laser_shade_grad_f4_c_shader_desc(backend), "laser-shade-grad-f4-conv");
    pip_laser_shade_c[1][5] = make_compute_pipeline(laser_shade_grad_f5_c_shader_desc(backend), "laser-shade-grad-f5-conv");
    {   // variantes de mesure (LASER_STATS), choisies seulement avec --stats
        pip_laser_shade_s[0][0][0] = make_compute_pipeline(laser_shade_f4_s_shader_desc(backend), "laser-shade-f4-stats");
        pip_laser_shade_s[0][1][0] = make_compute_pipeline(laser_shade_f5_s_shader_desc(backend), "laser-shade-f5-stats");
        pip_laser_shade_s[1][0][0] = make_compute_pipeline(laser_shade_grad_f4_s_shader_desc(backend), "laser-shade-grad-f4-stats");
        pip_laser_shade_s[1][1][0] = make_compute_pipeline(laser_shade_grad_f5_s_shader_desc(backend), "laser-shade-grad-f5-stats");
        pip_laser_shade_s[0][0][1] = make_compute_pipeline(laser_shade_f4_c_s_shader_desc(backend), "laser-shade-f4-conv-stats");
        pip_laser_shade_s[0][1][1] = make_compute_pipeline(laser_shade_f5_c_s_shader_desc(backend), "laser-shade-f5-conv-stats");
        pip_laser_shade_s[1][0][1] = make_compute_pipeline(laser_shade_grad_f4_c_s_shader_desc(backend), "laser-shade-grad-f4-conv-stats");
        pip_laser_shade_s[1][1][1] = make_compute_pipeline(laser_shade_grad_f5_c_s_shader_desc(backend), "laser-shade-grad-f5-conv-stats");
        pip_laser_shade_s[0][0][2] = make_compute_pipeline(laser_shade_f4_a_s_shader_desc(backend), "laser-shade-f4-arcs-stats");
        pip_laser_shade_s[0][1][2] = make_compute_pipeline(laser_shade_f5_a_s_shader_desc(backend), "laser-shade-f5-arcs-stats");
        pip_laser_shade_s[1][0][2] = make_compute_pipeline(laser_shade_grad_f4_a_s_shader_desc(backend), "laser-shade-grad-f4-arcs-stats");
        pip_laser_shade_s[1][1][2] = make_compute_pipeline(laser_shade_grad_f5_a_s_shader_desc(backend), "laser-shade-grad-f5-arcs-stats");
    }
}

void Renderer::make_target(Target& t, int w, int h, sg_pixel_format fmt, const char* label) {
    sg_image_desc d = {};
    d.width = w;
    d.height = h;
    d.pixel_format = fmt;
    d.sample_count = 1;
    d.label = label;
    if (fmt == SG_PIXELFORMAT_DEPTH) d.usage.depth_stencil_attachment = true;
    else d.usage.color_attachment = true;
    t.img = sg_make_image(&d);
    sg_view_desc vd = {};
    if (fmt == SG_PIXELFORMAT_DEPTH) {
        vd.depth_stencil_attachment.image = t.img;
        t.att = sg_make_view(&vd);
        t.tex = {};
    } else {
        vd.color_attachment.image = t.img;
        t.att = sg_make_view(&vd);
        t.tex = texture_view(t.img);
    }
}

void Renderer::destroy_target(Target& t) {
    if (t.tex.id) sg_destroy_view(t.tex);
    if (t.att.id) sg_destroy_view(t.att);
    if (t.img.id) sg_destroy_image(t.img);
    t = Target();
}

void Renderer::resize(int w, int h, int volw, int volh) {
    if (w == iw && h == ih && volw == vw && volh == vh) return;
    if (w != iw || h != ih) {
        destroy_target(scene_color);
        destroy_target(scene_depth_lin);
        destroy_target(depth);
        destroy_target(combined);
        for (Target& b : bloom) destroy_target(b);
        for (Target& b : lhalo) destroy_target(b);
        destroy_target(laser_up);
        make_target(laser_up, w, h, SG_PIXELFORMAT_RGBA16F, "laser-up");
        make_target(scene_color, w, h, SG_PIXELFORMAT_RGBA16F, "scene-color");
        make_target(scene_depth_lin, w, h, SG_PIXELFORMAT_R32F, "scene-depth-lin");
        make_target(depth, w, h, SG_PIXELFORMAT_DEPTH, "depth");
        make_target(combined, w, h, SG_PIXELFORMAT_RGBA16F, "combined");
        destroy_target(scene_normal);
        destroy_target(scene_albedo);
        destroy_target(soft_r);
        destroy_target(soft_g);
        destroy_target(soft_b);
        destroy_target(soft_spec);
        make_target(scene_normal, w, h, SG_PIXELFORMAT_RGBA16F, "scene-normal");
        make_target(scene_albedo, w, h, SG_PIXELFORMAT_RGBA8, "scene-albedo");
        soft_w = std::max(4, w / 4);
        soft_h = std::max(4, h / 4);
        make_target(soft_r, soft_w, soft_h, SG_PIXELFORMAT_RGBA16F, "soft-r");
        make_target(soft_g, soft_w, soft_h, SG_PIXELFORMAT_RGBA16F, "soft-g");
        make_target(soft_b, soft_w, soft_h, SG_PIXELFORMAT_RGBA16F, "soft-b");
        make_target(soft_spec, soft_w, soft_h, SG_PIXELFORMAT_RGBA16F, "soft-spec");
        // reflet du sol mouille (camera miroir), a demi-resolution ; sa fumee a 1/4
        for (Target* t : {&refl_color, &refl_depth_lin, &refl_depth, &refl_vol, &refl_final, &refl_beam_mask}) destroy_target(*t);
        refl_w = std::max(8, w / 2);
        refl_h = std::max(8, h / 2);
        refl_vw = std::max(4, refl_w / 2);
        refl_vh = std::max(4, refl_h / 2);
        make_target(refl_color, refl_w, refl_h, SG_PIXELFORMAT_RGBA16F, "refl-color");
        make_target(refl_depth_lin, refl_w, refl_h, SG_PIXELFORMAT_R32F, "refl-depth-lin");
        make_target(refl_beam_mask, refl_w, refl_h, SG_PIXELFORMAT_R8, "refl-beam-mask");
        make_target(refl_depth, refl_w, refl_h, SG_PIXELFORMAT_DEPTH, "refl-depth");
        make_target(refl_vol, refl_vw, refl_vh, SG_PIXELFORMAT_RGBA16F, "refl-vol");
        make_target(refl_final, refl_w, refl_h, SG_PIXELFORMAT_RGBA16F, "refl-final");
        // reflet flou du beton : pyramide a partir de 1/4 de la resolution (un niveau par vue d'ecriture et de lecture)
        if (refl_blur_img.id) {
            sg_destroy_view(refl_blur_tex);
            for (int i = 0; i < refl_blur_n; i++) {
                sg_destroy_view(refl_blur_att[i]);
                sg_destroy_view(refl_blur_lvl[i]);
            }
            sg_destroy_image(refl_blur_img);
        }
        {
            refl_blur_w = std::max(4, refl_w / 2);
            refl_blur_h = std::max(4, refl_h / 2);
            refl_blur_n = 1;
            while (refl_blur_n < REFL_BLUR_LEVELS && std::min(refl_blur_w, refl_blur_h) >> refl_blur_n >= 4) refl_blur_n++;
            sg_image_desc d = {};
            d.width = refl_blur_w;
            d.height = refl_blur_h;
            d.num_mipmaps = refl_blur_n;
            d.pixel_format = SG_PIXELFORMAT_RGBA16F;
            d.sample_count = 1;
            d.usage.color_attachment = true;
            d.label = "refl-blur";
            refl_blur_img = sg_make_image(&d);
            refl_blur_tex = texture_view(refl_blur_img);
            for (int i = 0; i < refl_blur_n; i++) {
                sg_view_desc vd = {};
                vd.color_attachment.image = refl_blur_img;
                vd.color_attachment.mip_level = i;
                refl_blur_att[i] = sg_make_view(&vd);
                vd = {};
                vd.texture.image = refl_blur_img;
                vd.texture.mip_levels.base = i;
                vd.texture.mip_levels.count = 1;
                refl_blur_lvl[i] = sg_make_view(&vd);
            }
        }
        // lasers du reflet (cs_laser_shade, camera miroir) : calcules dans le coin, a 1/2 ou 1/4 de la resolution du miroir
        if (refl_laser_img.id) {
            sg_destroy_view(refl_laser_store);
            sg_destroy_view(refl_laser_tex);
            sg_destroy_image(refl_laser_img);
        }
        {
            sg_image_desc d = {};
            d.width = refl_w;
            d.height = refl_h;
            d.pixel_format = SG_PIXELFORMAT_RGBA16F;
            d.usage.storage_image = true;
            d.label = "refl-lasers";
            refl_laser_img = sg_make_image(&d);
            sg_view_desc vd = {};
            vd.storage_image.image = refl_laser_img;
            refl_laser_store = sg_make_view(&vd);
            refl_laser_tex = texture_view(refl_laser_img);
        }
        num_bloom = 0;
        int bw = w, bh = h;
        for (int i = 0; i < BLOOM_LEVELS; i++) {
            bw = std::max(1, bw / 2);
            bh = std::max(1, bh / 2);
            bloom_w[i] = bw;
            bloom_h[i] = bh;
            make_target(bloom[i], bw, bh, SG_PIXELFORMAT_RGBA16F, "bloom");
            num_bloom++;
            if (bw <= 8 || bh <= 8) break;
        }
        num_lhalo = 0;
        bw = std::max(1, w / 2);   // halo : 1er niveau au quart (lu directement dans l'image des lasers, 4 x 4 texels)
        bh = std::max(1, h / 2);
        for (int i = 0; i < BLOOM_LEVELS; i++) {
            bw = std::max(1, bw / 2);
            bh = std::max(1, bh / 2);
            lhalo_w[i] = bw;
            lhalo_h[i] = bh;
            make_target(lhalo[i], bw, bh, SG_PIXELFORMAT_RGBA16F, "laser-halo");
            num_lhalo++;
            if (bw <= 8 || bh <= 8) break;
        }
        // lasers (tuiles en calcul) : image ecrite par cs_laser_shade, lue par la composition
        if (laser_img.id) {
            sg_destroy_view(laser_store);
            sg_destroy_view(laser_tex);
            sg_destroy_image(laser_img);
            sg_destroy_view(laser_arc_store);
            sg_destroy_view(laser_arc_tex);
            sg_destroy_image(laser_arc_img);
        }
        sg_image_desc ld = {};
        ld.width = w;
        ld.height = h;
        ld.pixel_format = SG_PIXELFORMAT_RGBA16F;
        ld.usage.storage_image = true;
        ld.label = "lasers";
        laser_img = sg_make_image(&ld);
        sg_view_desc lvd = {};
        lvd.storage_image.image = laser_img;
        laser_store = sg_make_view(&lvd);
        laser_tex = texture_view(laser_img);
        // nappes coniques : leur passe (variantes _a) ecrit cette image, la passe principale l'ajoute
        ld.label = "lasers-arcs";
        laser_arc_img = sg_make_image(&ld);
        lvd.storage_image.image = laser_arc_img;
        laser_arc_store = sg_make_view(&lvd);
        laser_arc_tex = texture_view(laser_arc_img);
        // grosses tuiles de 128 pixels : nombre de segments et liste (LASER_CAP au plus)
        if (laser_ccount_buf.id) {
            sg_destroy_view(laser_ccount_view);
            sg_destroy_view(laser_clist_view);
            sg_destroy_buffer(laser_ccount_buf);
            sg_destroy_buffer(laser_clist_buf);
        }
        laser_ctx = (w + 127) / 128;
        laser_cty = (h + 127) / 128;
        laser_ccount_buf = make_storage((size_t)laser_ctx * laser_cty * sizeof(uint32_t), false, "laser-coarse-count");
        laser_clist_buf = make_storage((size_t)laser_ctx * laser_cty * LASER_CAP * sizeof(uint32_t), false, "laser-coarse-list");
        laser_ccount_view = storage_view(laser_ccount_buf);
        laser_clist_view = storage_view(laser_clist_buf);
    }
    destroy_target(vol_cur);
    destroy_target(vol_hist[0]);
    destroy_target(vol_hist[1]);
    for (int i = 0; i < 2; i++) {
        destroy_target(vol_tier[i]);
        tier_w[i] = std::max(4, volw >> (i + 1));
        tier_h[i] = std::max(4, volh >> (i + 1));
        make_target(vol_tier[i], tier_w[i], tier_h[i], SG_PIXELFORMAT_RGBA16F, "vol-tier");
    }
    make_target(vol_cur, volw, volh, SG_PIXELFORMAT_RGBA16F, "vol-cur");
    make_target(vol_hist[0], volw, volh, SG_PIXELFORMAT_RGBA16F, "vol-hist0");
    make_target(vol_hist[1], volw, volh, SG_PIXELFORMAT_RGBA16F, "vol-hist1");
    hist_valid = false;
    iw = w; ih = h; vw = volw; vh = volh;
}

void Renderer::shutdown() {
    // sg_shutdown() libere toutes les ressources restantes
}

// --------------------------------------------------------------------------------------------
//  Donnees par image
// --------------------------------------------------------------------------------------------
static bool shadow_volume(const Occluder& o, vec3 L, float* out);   // plus bas

void Renderer::build_lights(const Rig& rig, const RenderSettings& rs, const GoboAtlas& gobos, const Scene& scene) {
    (void)gobos;
    num_lights = 0;
    sb_light_t* L = (sb_light_t*)light_data.data();
    const float ref_tan = std::tan(5.0f * DEG);
    const float base_power = 2000.0f * rig.power;
    for (const Fixture& f : rig.fixtures) {
        float lum = f.emit.x + f.emit.y + f.emit.z;
        if (lum < 1e-4f || num_lights >= MAX_LIGHTS) continue;
        const FixtureParams& o = f.out;
        float T = std::tan(clampf(o.zoom, 1.5f, 60.0f) * 0.5f * DEG);
        float frost = clampf(o.frost, 0, 1);
        float Tf = T * (1.0f + frost * 1.2f);
        float gain = clampf((ref_tan / T) * (ref_tan / T), 0.02f, 40.0f) / ((1.0f + frost * 1.2f) * (1.0f + frost * 1.2f));
        float spread = o.prism != PRISM_NONE ? 0.11f * o.prism_spread : 0.0f;
        float tenv = Tf + spread * max_facet_offset(o.prism);
        // aberration chromatique : l'image bleue deborde un peu (grandissement, facettes plus ecartees).
        // La marge de 0,01 suffit jusqu'a l'intensite 2 environ : l'enveloppe ne grandit qu'au-dela (elle
        // agrandit les cones de fumee, les tables et le test des surfaces : +2 % = jusqu'a +0,5 ms).
        float ch[4];
        rs.chroma_params(ch);
        tenv += std::max(tenv * ch[0] + spread * max_facet_offset(o.prism) * ch[1] - 0.005f, 0.0f) + 0.01f;
        // le faisceau sort de toute la lentille : sommet du cone place derriere elle
        const float lens_r = std::max(rig.lens_diameter * 0.5f, 0.005f);
        float d0 = std::min(lens_r / std::max(Tf * clampf(o.iris, 0.05f, 1.0f), 1e-3f), 15.0f);
        // prisme : toutes les facettes partent de ce meme sommet, decalees de spread par metre. Avec un
        // faisceau serre, le sommet est loin derriere (10 m a 1,5 deg) et les facettes arrivaient a la
        // lentille deja ecartees d'un metre : copies a cote de la lyre. On rapproche le sommet pour que
        // l'enveloppe des facettes tienne dans la lentille : tous les rayons sortent de la lyre.
        if (spread > 0.0f) d0 = std::min(d0, lens_r / std::max(tenv - 0.01f, 1e-3f));
        const vec3 apex = f.lens_pos - f.dir * d0;
        float range = std::min(rs.beam_range + d0, cone_exit_distance(apex, f.dir, tenv, hall_min, hall_max) + 0.05f);
        // Obstacles (sol, sol de scene, decor, cube suspendu...) : le faisceau n'est coupe que si tout le
        // faisceau est arrete (l'axe et 8 rayons du bord de l'enveloppe touchent un objet) ; un obstacle
        // qui n'en cache qu'une partie ne le coupe pas (son ombre est calculee a part).
        // Longueur : le plus loin des 9 points touches, le long de l'axe. Si les 9 points sont sur un meme
        // plan (le cas du sol), la distance exacte ou le cone entier l'a franchi (comme cone_exit_distance :
        // point de la section le plus en arriere) : sur un sol vu en rasant, le bout de la tache (tres
        // allongee) tombait entre deux rayons du bord et etait coupe net. Pas de plan infini pour des faces
        // differentes : une face presque parallele au faisceau l'allongerait pour rien (+0,5 a +1 ms).
        {
            const vec3 rt = cross(f.dir, f.up);
            float far_z = 0.0f;
            bool all_hit = true, one_plane = true;
            vec3 n0 = {0, 0, 0};
            float off0 = 0.0f;
            for (int k = 0; k < 9 && all_hit; k++) {
                vec3 d = f.dir;
                if (k > 0) {
                    const float a = (k - 1) * (PI * 0.25f);
                    d = normalize(f.dir + (f.up * std::cos(a) + rt * std::sin(a)) * (tenv - 0.01f));
                }
                RayHit hit;
                if (!scene.raycast(f.lens_pos, d, range, hit)) { all_hit = false; break; }
                far_z = std::max(far_z, d0 + dot(hit.pos - f.lens_pos, f.dir));   // depuis le sommet du cone
                if (k == 0) {
                    n0 = hit.normal;
                    off0 = dot(hit.normal, hit.pos);
                } else if (dot(hit.normal, n0) < 0.999f || std::fabs(dot(n0, hit.pos) - off0) > 1e-3f) {
                    one_plane = false;
                }
            }
            if (all_hit && one_plane) {
                // m : normale du plan vers l'interieur de l'objet (la normale renvoyee regarde la lyre)
                const vec3 m = n0 * -1.0f;
                const float mf = dot(m, f.dir);
                const float rate = mf - tenv * std::sqrt(std::max(0.0f, 1.0f - mf * mf));
                if (rate > 1e-4f) far_z = std::max(far_z, (off0 * -1.0f - dot(apex, m)) / rate);
                else all_hit = false;   // le cone ne franchit jamais ce plan en entier
            }
            if (all_hit) range = std::min(range, far_z + 0.1f);
        }
        sb_light_t& l = L[num_lights++];
        set4(l.pos_range, apex, range);
        set4(l.dir_tanenv, f.dir, tenv);
        set4(l.up_tanbeam, f.up, Tf);
        set4(l.color_gobo, f.emit * (base_power * gain), (float)std::clamp(o.gobo, 0, NUM_GOBOS - 1));
        set4(l.prism, (float)o.prism, spread, f.prism_rot, f.gobo_rot + o.gobo_angle * DEG);
        set4(l.optics, frost, std::max(o.focus, 0.5f) + d0, clampf(o.iris, 0.05f, 1.0f), d0);
    }
    if (num_lights == 0) std::memset(L, 0, sizeof(sb_light_t));
    stats.lights = num_lights;
    // Images projetees en cache : pour les lyres a prisme, l'image entiere (toutes les facettes) est
    // calculee une fois par image, puis lue en 2 fois par les surfaces et les tables de la fumee,
    // au lieu d'additionner 3 a 9 facettes a chaque lecture.
    // L'image ne depend que des reglages de la lyre (pas de sa position) : les lyres reglees pareil
    // (programmees ensemble, cas courant) partagent la meme image, calculee une seule fois.
    // Une image n'est recalculee que si les reglages de sa case ont change depuis l'image precedente :
    // lyres immobiles en gobo et en prisme (cas courant), aucun calcul. Sinon, la passe de calcul devait
    // aussi attendre que les surfaces de l'image precedente aient fini de lire l'atlas (+0,2 a +0,8 ms).
    pimg_list.clear();
    pimg_dirty.clear();
    const int per_row = PIMG_ATLAS_W / PIMG_W, max_img = per_row * (PIMG_ATLAS_H / PIMG_H);
    using Key = PimgKey;
    // Avec l'aberration chromatique, les lyres sans prisme ont aussi leur image en cache (en couleur) :
    // les surfaces la lisent en 2 fois au lieu de lire 3 fois le gobo (une par couleur, 2 niveaux de flou
    // chacune). Marquee 2 : les tables de la fumee, elles, lisent toujours le gobo (1 lecture).
    float chp[4];
    rs.chroma_params(chp);
    const bool chroma_img = chp[3] > 0.5f;
    std::vector<Key> keys;
    for (int i = 0; i < num_lights; i++) {
        float* d = &pimg_desc[i * 4];
        d[0] = d[1] = d[2] = d[3] = 0;
        const int prism = (int)(L[i].prism[0] + 0.5f);
        if (prism == PRISM_NONE && !chroma_img) continue;
        // le dernier terme : intensite de l'aberration chromatique (0 si coupee), commune a toutes les images
        const Key key = {{L[i].up_tanbeam[3], L[i].dir_tanenv[3], L[i].color_gobo[3], L[i].prism[0], L[i].prism[1], L[i].prism[2],
                          L[i].prism[3], L[i].optics[0], L[i].optics[2], chp[3] > 0.5f ? chp[0] : 0.0f}};
        int slot = -1;
        for (size_t k = 0; k < keys.size() && slot < 0; k++)
            if (std::memcmp(&keys[k], &key, sizeof(Key)) == 0) slot = (int)k;
        if (slot >= 0) {
            std::memcpy(d, &pimg_desc[pimg_list[slot] * 4], 4 * sizeof(float));
            continue;
        }
        if ((int)pimg_list.size() >= max_img) continue;
        slot = (int)pimg_list.size();
        keys.push_back(key);
        const float tenv = L[i].dir_tanenv[3], T = L[i].up_tanbeam[3];
        // flou de la couche 0 : celui du frost, ou plus si l'image est moins fine que le gobo
        const float lod0 = std::max(L[i].optics[0] * 5.0f, std::log2(std::max(tenv / std::max(T, 1e-5f), 1.0f)));
        d[0] = (float)((slot % per_row) * PIMG_W);
        d[1] = (float)((slot / per_row) * PIMG_H);
        d[2] = lod0;
        d[3] = prism == PRISM_NONE ? 2.0f : 1.0f;
        pimg_list.push_back((uint32_t)i);
        if (slot >= (int)pimg_keys.size() || std::memcmp(&pimg_keys[slot], &key, sizeof(Key)) != 0) pimg_dirty.push_back((uint32_t)i);
    }
    pimg_keys = keys;
    stats.pattern_images = (int)pimg_list.size();

    // Obstacles dans le cone de chaque lyre (ombres) : test de la sphere englobante de chaque pave contre
    // le cone (lentille, axe, ouverture de l'enveloppe, longueur) ; les 8 plus proches de la lentille.
    const float lens_r = std::max(rig.lens_diameter * 0.5f, 0.005f);
    if (!rs.shadows) std::fill(occ_light_data.begin(), occ_light_data.begin() + num_lights * 4, 0u);
    int occ_lights_n = 0;
    occ_pairs = 0;
    for (int i = 0; i < num_lights && rs.shadows; i++) {
        uint32_t* oi = &occ_light_data[i * 4];
        oi[0] = oi[1] = oi[2] = oi[3] = 0;
        const sb_light_t& l = L[i];
        const vec3 dir = {l.dir_tanenv[0], l.dir_tanenv[1], l.dir_tanenv[2]};
        const vec3 lens = vec3(l.pos_range[0], l.pos_range[1], l.pos_range[2]) + dir * l.optics[3];
        const float len = l.pos_range[3] - l.optics[3], tenv = l.dir_tanenv[3];
        const float slope = std::sqrt(1.0f + tenv * tenv);
        std::pair<float, int> found[8];
        int n = 0;
        for (size_t k = 0; k < occluders.size(); k++) {
            const Occluder& o = occluders[k];
            const float r = std::sqrt(dot(o.ax, o.ax) + dot(o.ay, o.ay) + dot(o.az, o.az));
            const vec3 v = o.c - lens;
            const float a = dot(v, dir);
            if (a < -r || a > len + r) continue;
            const float perp = std::sqrt(std::max(dot(v, v) - a * a, 0.0f));
            if (perp > lens_r + std::max(a, 0.0f) * tenv + r * slope) continue;
            if (n < 8) found[n++] = {a, (int)k};
            else {
                int far_k = 0;
                for (int q = 1; q < 8; q++) if (found[q].first > found[far_k].first) far_k = q;
                if (a < found[far_k].first) found[far_k] = {a, (int)k};
            }
        }
        if (n == 0) continue;
        std::sort(found, found + n);
        int kept = 0;
        for (int q = 0; q < n && occ_pairs + kept < MAX_OCC_PAIRS; q++) {
            float* blk = &occ_plane_data[(size_t)(occ_pairs + kept) * OCC_BLOCK * 4];
            if (shadow_volume(occluders[found[q].second], lens, blk)) {
                blk[1] = length(occluders[found[q].second].c - lens);   // penombre : distance lentille -> pave
                blk[2] = lens_r;                                        // et rayon de la lentille
                occ_pair_lens[occ_pairs + kept] = lens;
                occ_pair_box[occ_pairs + kept] = found[q].second;
                kept++;
            }
        }
        if (kept == 0) continue;
        oi[0] = (uint32_t)kept;
        oi[1] = (uint32_t)occ_pairs;
        occ_pairs += kept;
        occ_lights_n++;
    }
    stats.occluded_lights = occ_lights_n;
    stats.occ_pairs = occ_pairs;
}

// Qualite adaptative (comme la resolution dynamique des jeux) : si une image prend plus que la
// cadence visee, le facteur de qualite baisse un peu (plus de faisceaux en 1/2 et 1/4, tables plus
// legeres, plus de lyres douces a 1/4 sur les surfaces) ; il remonte doucement quand il y a de la
// marge. Dans une scene legere il reste a 1 : aucune difference.
void Renderer::update_quality(const RenderSettings& rs) {
    if (!rs.adaptive) {
        quality = 1.0f;
        stats.quality = quality;
        return;
    }
    // temps GPU de la derniere image mesuree (Direct3D 11), sinon duree de la derniere image
    float ms = 0;
    if (gpuprof::available()) {
        if (gpuprof::last_id() == quality_last_id) return;
        quality_last_id = gpuprof::last_id();
        // toutes les passes sauf la derniere : celle-ci dessine dans l'image de l'ecran et peut
        // attendre que l'ecran la libere (presentation a 120 Hz) ; ce n'est pas du calcul
        const std::vector<gpuprof::Section>& secs = gpuprof::last();
        for (size_t i = 0; i + 1 < secs.size(); i++) ms += secs[i].ms;
        ms += 0.3f;
    } else {
        static uint64_t lap = 0;
        ms = (float)stm_ms(stm_laptime(&lap));
    }
    // moyenne glissante : un pic isole (autre programme sur la carte) ne fait pas baisser la qualite
    quality_ms = quality_ms > 0 ? quality_ms * 0.85f + ms * 0.15f : ms;
    const float target = 1000.0f / std::max(rs.target_fps, 10.0f) * 0.92f;   // marge pour le reste de l'image
    if (quality_ms > target) quality *= std::max(0.94f, std::pow(target / quality_ms, 0.25f));
    else if (quality_ms < target * 0.93f) quality *= 1.005f;
    quality = clampf(quality, 0.8f, 1.0f);   // plancher eleve : la qualite adaptative lisse les pics, sans degrader l'image
    stats.quality = quality;
}

// Resolution des lasers (PLAN-OPTIM-LASERS.md, 2.1, decision de l'utilisateur) : paliers 100, 80, 70, 50 %, seulement quand
// l'image passe sous 60 img/s (temps GPU lisse au-dessus de 16,7 ms, 10 images de suite au moins depuis le dernier changement).
// Retour au palier du dessus quand le temps prevu y reste sous 90 % de 16,7 ms (passes des lasers en proportion des pixels),
// apres 60 images au moins : hysteresis, pas d'aller-retour. Temps GPU mesure (Direct3D 11) ; ailleurs, pleine resolution.
float Renderer::laser_scale_for(const RenderSettings& rs) {
    static const float STEPS[4] = {1.0f, 0.8f, 0.7f, 0.5f};
    if (!rs.adaptive || !rs.laser_adaptive || !gpuprof::available()) {
        laser_step = 0;
        return clampf(rs.laser_scale, 0.25f, 1.0f);
    }
    if (gpuprof::last_id() != lscale_last_id) {
        lscale_last_id = gpuprof::last_id();
        // comme update_quality : toutes les passes sauf la derniere (attente de l'ecran) ; passes des lasers a part
        const std::vector<gpuprof::Section>& secs = gpuprof::last();
        float ms = 0.3f, las = 0.0f;
        for (size_t i = 0; i + 1 < secs.size(); i++) {
            ms += secs[i].ms;
            const std::string n = secs[i].name;
            if (n.rfind("lasers", 0) == 0 && n != "lasers : impacts" && n != "lasers : sorties") las += secs[i].ms;
        }
        lscale_ms = lscale_ms > 0 ? lscale_ms * 0.8f + ms * 0.2f : ms;
        lscale_las = lscale_las > 0 ? lscale_las * 0.8f + las * 0.2f : las;
        lscale_hold++;
        const float limit = 1000.0f / 60.0f;
        if (lscale_hold >= 10 && lscale_ms > limit && laser_step < 3) {
            laser_step++;
            lscale_hold = 0;
        } else if (lscale_hold >= 60 && laser_step > 0) {
            const float s = STEPS[laser_step], su = STEPS[laser_step - 1];
            if (lscale_ms + lscale_las * ((su * su) / (s * s) - 1.0f) < 0.9f * limit) {
                laser_step--;
                lscale_hold = 0;
            }
        }
    }
    return STEPS[laser_step];
}

// Niveau de resolution de chaque faisceau dans la fumee. Un faisceau dont l'image a l'ecran ne
// contient pas de detail plus fin que quelques pixels (frost, bord doux, gobo flou) est calcule a
// 1/2 ou 1/4 de la resolution de la fumee : 4 ou 16 fois moins de calcul, sans difference visible.
void Renderer::assign_beam_tiers(const Camera& cam, float pixel_angle, bool tiers, bool soft, int vol_div, bool crowd) {
    num_open = 0;
    sb_light_t* L = (sb_light_t*)light_data.data();
    num_soft = 0;
    beam_tier.assign(num_lights, 0);
    beam_px.assign(num_lights, 1e9f);
    for (int i = 0; i < num_lights; i++) {
        const sb_light_t& l = L[i];
        const vec3 lp = {l.pos_range[0], l.pos_range[1], l.pos_range[2]};
        const vec3 f = {l.dir_tanenv[0], l.dir_tanenv[1], l.dir_tanenv[2]};
        const float h = l.pos_range[3], tenv = l.dir_tanenv[3], T = l.up_tanbeam[3];
        // largeur a l'ecran au milieu du faisceau (et dedans : tout l'ecran)
        const vec3 c = lp + f * (0.5f * h);
        const float dc = length(c - cam.pos);
        const float rad = 0.5f * h * tenv;
        const bool inside = dc <= rad * 1.2f || dot(normalize(cam.pos - lp), f) > 1.0f / std::sqrt(1.0f + tenv * tenv);
        const float width_px = inside ? 1e6f : 2.0f * rad / dc / pixel_angle;
        beam_px[i] = width_px;
        // plus petit detail de l'image, en fraction de la largeur d'une facette
        const float frost = l.optics[0];
        const float edge = 0.05f + 0.85f * frost;
        const float detail = std::max(std::exp2(frost * 5.0f) / 64.0f, edge * 0.5f);
        const float detail_px = width_px * (T / std::max(tenv, 1e-4f)) * detail;
        // seuils abaisses par la qualite adaptative : plus de faisceaux calcules a basse resolution
        if (tiers) beam_tier[i] = detail_px >= 12.0f * quality ? 2 : (detail_px >= 6.0f * quality ? 1 : 0);
        // surfaces : la tache n'a pas de detail de moins de 16 pixels (plein ecran) -> passe a 1/4
        if (soft && (frost >= 0.35f * quality || quality <= 0.4f) && detail_px * (float)vol_div >= 16.0f * quality) {
            static_assert(NUM_GOBOS < 64, "SOFT_FLAG du shader : au-dessus du nombre de gobos");
            L[i].color_gobo[3] += 64.0f;   // SOFT_FLAG du shader (> NUM_GOBOS)
            num_soft++;
        } else if (crowd && l.color_gobo[3] < 0.5f && l.prism[0] < 0.5f) {
            // lyres superposees (cs_cull_clusters) : seulement une lyre sans gobo dont le bord de la tache, la ou
            // elle arrive (au bout du faisceau), fait au moins 10 pixels a l'ecran (grand zoom, frost, hors de la
            // mise au point) : calculee a 1/4, elle ne change pas
            const vec3 pe = lp + f * h;
            const float ds = std::max(length(pe - cam.pos), 0.1f);
            const float defocus = std::fabs(std::log2(std::max(h, 0.2f)) - std::log2(std::max(l.optics[1], 0.2f)));
            const float blur = std::exp2(frost * 5.0f + defocus * 1.4f) / 128.0f;
            const float band = std::max(l.optics[2] * edge, blur);
            const float edge_px = h * T * band / ds / (pixel_angle / (float)vol_div);
            if (edge_px >= 10.0f) {
                L[i].prism[0] = -1.0f;   // marque lue par cl_open
                num_open++;
            }
        }
    }
    stats.soft_lights = num_soft;
    beam_order.clear();
    for (int t = 0; t < 3; t++) {
        tier_first[t] = (int)beam_order.size();
        for (int i = 0; i < num_lights; i++)
            if (beam_tier[i] == t) beam_order.push_back((uint32_t)i);
        tier_num[t] = (int)beam_order.size() - tier_first[t];
        stats.tier_count[t] = tier_num[t];
    }
}

// Tables des faisceaux : repere epipolaire de chaque lyre (relatif a la camera), etendue angulaire,
// resolution, et rangement de toutes les couches dans l'atlas (rangees de hauteur decroissante).
void Renderer::build_beam_tables(const Camera& cam, float pixel_angle, bool mirror) {
    const vec3 cam_pos = cam.pos;
    std::vector<uint32_t>& jobs = mirror ? btab_jobs_m : btab_jobs;
    float& bscale = mirror ? btab_scale_m : btab_scale;
    sb_btab_t* B = (sb_btab_t*)(mirror ? btab_data_m : btab_data).data();
    const sb_light_t* L = (const sb_light_t*)light_data.data();
    struct Rect {
        int light, layer, w, h, x, y;
    };
    std::vector<Rect> rects;
    // la resolution baisse si l'atlas est plein ; elle remonte doucement ensuite
    float scale = std::min(std::sqrt(quality), bscale * 1.05f);
    // reflet : image a demi-resolution, souvent floue (beton humide) : tables deux fois moins fines
    const float res_mul = mirror ? 0.5f : 1.0f;
    for (int attempt = 0; attempt < 12; attempt++) {
        rects.clear();
        double area = 0;
        for (int i = 0; i < num_lights; i++) {
            if (mirror && !mirror_vis[i]) continue;   // cone hors du reflet : ni table, ni dessin
            const sb_light_t& l = L[i];
            const vec3 lp = {l.pos_range[0], l.pos_range[1], l.pos_range[2]};
            const vec3 f = {l.dir_tanenv[0], l.dir_tanenv[1], l.dir_tanenv[2]};
            const float tenv = l.dir_tanenv[3], T = l.up_tanbeam[3];
            vec3 a = cam_pos - lp;
            float dist = length(a);
            a = dist > 1e-3f ? a / dist : f * -1.0f;
            vec3 fp = f - a * dot(f, a);
            if (length(fp) < 1e-5f) fp = std::fabs(a.y) < 0.9f ? cross(a, vec3(0, 1, 0)) : cross(a, vec3(1, 0, 0));
            const vec3 e1 = normalize(fp), e2 = cross(a, e1);
            const float psi_f = std::acos(clampf(dot(a, f), -1.0f, 1.0f));
            const float alpha = std::atan(tenv) * 1.02f;
            const bool full = psi_f <= alpha || psi_f >= PI - alpha;
            const float psimin = psi_f <= alpha ? 0.0f : std::max(0.0f, psi_f - alpha);
            const float psimax = std::min(PI, psi_f + alpha);
            float phimax = PI;
            if (!full) phimax = std::min(PI * 0.5f, std::asin(std::min(1.0f, std::sin(alpha) / std::max(std::sin(psi_f), 1e-6f))) * 1.02f);
            // un texel de gobo (au flou de la couche 0) vu de la lyre ; pour une lyre a prisme, la table
            // lit l'image projetee en cache : son texel est le detail le plus fin qui existe
            float lod_base = l.optics[0] * 5.0f;
            float texel = 2.0f * std::atan(T) / 256.0f * std::exp2(lod_base);
            if (pimg_desc[i * 4 + 3] > 0.5f && pimg_desc[i * 4 + 3] < 1.5f) {
                lod_base = pimg_desc[i * 4 + 2];
                texel = 2.0f * std::atan(tenv) / (float)PIMG_SIZE;
            }
            const float arc = full ? 2.0f * PI * std::sin(std::min(psimax, PI * 0.5f)) : 2.0f * phimax * std::sin(psi_f);
            // Taille du faisceau a l'ecran (pixels de la fumee) : inutile d'avoir plus de lignes que de
            // pixels en travers du faisceau, ni plus de colonnes que de pixels sur sa longueur.
            float scr_w = 0, scr_l = 0;
            {
                const float h = l.pos_range[3];
                vec3 d0 = normalize(lp - cam_pos);
                bool inside = full;
                for (int s = 1; s <= 4; s++) {
                    const float ax = h * s / 4.0f;
                    const vec3 c = lp + f * ax;
                    const float dc = length(c - cam_pos);
                    const float rad = ax * tenv;
                    if (dc <= rad * 1.2f) inside = true;
                    else scr_w = std::max(scr_w, 2.0f * rad / dc);
                    scr_l = std::max(scr_l, std::acos(clampf(dot(d0, (c - cam_pos) / std::max(dc, 1e-4f)), -1.0f, 1.0f)));
                }
                if (inside) scr_w = scr_l = 1e9f;
                // pixel du niveau de resolution du faisceau
                const float pa = pixel_angle * (float)(1 << (!mirror && i < (int)beam_tier.size() ? beam_tier[i] : 0));
                scr_w /= pa;
                scr_l /= pa;
            }
            const int C0 = std::clamp((int)std::ceil(std::min((psimax - psimin) / texel, scr_l + 16.0f) * scale * res_mul) + 1, 8, 512);
            const int R0 = std::clamp((int)std::ceil(std::min(arc / texel, scr_w + 16.0f) * scale * res_mul) + 1, 8, 1024);
            sb_btab_t& b = B[i];
            set4(b.a_psimin, a, psimin);
            set4(b.e1_psimax, e1, psimax);
            set4(b.e2_phimin, e2, full ? -PI : -phimax);
            int nl = 0;
            for (int k = 0; k < BTAB_LAYERS; k++) {
                if (k > 0 && lod_base + (k - 1) * BTAB_LOD_STEP >= 7.5f) break;   // le flou va jusqu'a 7.5
                const float div = std::exp2(0.5f * BTAB_LOD_STEP * k);   // resolution / 2 par couche : le bord de l'iris reste net
                const int w = std::max(4, (int)std::ceil(C0 / div)), h = std::max(4, (int)std::ceil(R0 / div));
                rects.push_back({i, k, w, h, 0, 0});
                area += (double)w * h;
                nl++;
            }
            set4(b.info, full ? PI : phimax, lod_base, (float)nl, texel);
        }
        if (area > 0.9 * BTAB_W * BTAB_H) {
            scale *= (float)std::sqrt(0.9 * BTAB_W * BTAB_H / area) * 0.98f;
            continue;
        }
        // rangement : rangees de hauteur decroissante
        std::vector<int> order(rects.size());
        for (size_t k = 0; k < order.size(); k++) order[k] = (int)k;
        std::sort(order.begin(), order.end(), [&](int x, int y) { return rects[x].h > rects[y].h; });
        int x = 0, y = 0, shelf = 0;
        bool ok = true;
        for (int idx : order) {
            Rect& r = rects[idx];
            if (x + r.w > BTAB_W) {
                y += shelf;
                x = 0;
                shelf = 0;
            }
            if (shelf == 0) shelf = r.h;
            if (y + r.h > BTAB_H) {
                ok = false;
                break;
            }
            r.x = x;
            r.y = y;
            x += r.w;
        }
        if (ok) break;
        scale *= 0.9f;
    }
    bscale = scale;
    jobs.clear();
    if (!mirror) {
        stats.table_cells = 0;
        for (const Rect& r : rects) stats.table_cells += (double)r.w * r.h;
        stats.table_scale = scale;
    }
    for (const Rect& r : rects) {
        float* lay = r.layer == 0 ? B[r.light].lay0 : r.layer == 1 ? B[r.light].lay1 : r.layer == 2 ? B[r.light].lay2
                   : r.layer == 3 ? B[r.light].lay3 : B[r.light].lay4;
        set4(lay, (float)r.x, (float)r.y, (float)r.h, (float)r.w);
        for (int row = 0; row < r.h && (int)jobs.size() < MAX_BTAB_JOBS; row++)
            jobs.push_back((uint32_t)r.light << 16 | (uint32_t)r.layer << 12 | (uint32_t)row);
    }
    if (!mirror) stats.table_rows = (int)jobs.size();
}

void Renderer::build_vpls(const Scene& scene, const Rig& rig, const GoboAtlas& gobos, const RenderSettings& rs, float sigma_ext, float sigma_scat) {
    (void)rig;
    // sol texture : couleur lue sous la tache (meme melange des dalles que le shader), assombrie par l'eau
    const bool tex_floor = floor_tex && rs.floor_texture;
    // comme floor_material (shader) : le beton mouille (film, flaques et leur bord) fonce jusqu'a x 0,45 ;
    // en moyenne sur la tache, selon la part de sol mouillee
    float wl[4] = {-1.0f, -1.0f, 0.0f, 0.0f};
    if (floor_tex) floor_tex->water_levels(rs.floor_wet, wl);
    const float wet_factor = lerpf(1.0f, 0.45f, std::max(wl[2], std::min(1.0f, wl[3] * 1.3f)));
    const float tile = std::max(rs.floor_tile, 0.25f);
    num_vpls = 0;
    sb_vpl_t* V = (sb_vpl_t*)vpl_data.data();
    const sb_light_t* L = (const sb_light_t*)light_data.data();
    for (int i = 0; i < num_lights && num_vpls < MAX_VPLS - 16; i++) {
        const sb_light_t& l = L[i];
        vec3 dir = {l.dir_tanenv[0], l.dir_tanenv[1], l.dir_tanenv[2]};
        vec3 pos = vec3(l.pos_range[0], l.pos_range[1], l.pos_range[2]) + dir * l.optics[3];   // centre de la lentille
        vec3 up = {l.up_tanbeam[0], l.up_tanbeam[1], l.up_tanbeam[2]};
        vec3 rt = cross(dir, up);
        vec3 col = {l.color_gobo[0], l.color_gobo[1], l.color_gobo[2]};
        float Tf = l.up_tanbeam[3];
        int gobo = (int)l.color_gobo[3] % 64;   // sans le marqueur "lyre douce"
        int prism = (int)(l.prism[0] + 0.5f);
        float spread = l.prism[1];
        float iris = l.optics[2];
        // flux total du faisceau
        float trans = (gobo >= 0 && gobo < (int)gobos.transmission.size()) ? gobos.transmission[gobo] : 1.0f;
        vec3 flux = col * (PI * Tf * Tf * trans * 0.8f * iris * iris);

        // directions des rayons : facettes du prisme, ou centre + 4 autour
        vec2 offs[9];
        int n = 0;
        if (prism == PRISM_NONE) {
            offs[n++] = {0, 0};
            for (int k = 0; k < 4; k++) offs[n++] = {0.55f * Tf * std::cos(k * PI * 0.5f + 0.4f), 0.55f * Tf * std::sin(k * PI * 0.5f + 0.4f)};
        } else {
            int count = prism == PRISM_3 ? 3 : prism == PRISM_6 ? 6 : prism == PRISM_8 ? 8 : prism == PRISM_LINEAR_4 ? 4 : 9;
            float rot = l.prism[2];
            for (int k = 0; k < count; k++) {
                vec2 o = {0, 0};
                if (prism == PRISM_9_GRID) o = {((float)(k % 3) - 1.0f) * 0.8f, ((float)(k / 3) - 1.0f) * 0.8f};
                else if (prism == PRISM_LINEAR_4) o = {(k - 1.5f) * 0.7f, 0};
                else if (!(prism == PRISM_9_RING && k == 8)) {
                    float nn = prism == PRISM_3 ? 3.0f : prism == PRISM_6 ? 6.0f : 8.0f;
                    o = {std::cos(k * 2 * PI / nn), std::sin(k * 2 * PI / nn)};
                }
                float c = std::cos(rot), s = std::sin(rot);
                offs[n++] = {(c * o.x - s * o.y) * spread, (s * o.x + c * o.y) * spread};
            }
        }
        float hit_center = 60.0f;
        for (int k = 0; k < n; k++) {
            vec3 d = normalize(dir + rt * offs[k].x + up * offs[k].y);
            RayHit h;
            if (!scene.raycast(pos, d, 200.0f, h)) continue;
            if (k == 0) hit_center = h.t;
            sb_vpl_t& v = V[num_vpls++];
            vec3 alb = h.albedo;
            if (tex_floor && h.normal.y > 0.5f && h.pos.y < 0.05f) alb = floor_tex->albedo_at(h.pos.x, h.pos.z, tile) * (floor_scale * wet_factor);
            vec3 refl = flux * alb * (std::exp(-sigma_ext * h.t) / (float)n);
            set4(v.pos_radius, h.pos + h.normal * 0.1f, std::max(0.6f, h.t * Tf));
            set4(v.normal_type, h.normal, 0.0f);
            set4(v.flux, refl, 0.0f);
        }
        // lumiere diffusee par la fumee le long du faisceau
        float seg = std::min(hit_center, 80.0f) / 3.0f;
        for (int k = 0; k < 3; k++) {
            float t = (k + 0.5f) * seg;
            sb_vpl_t& v = V[num_vpls++];
            set4(v.pos_radius, pos + dir * t, std::max(1.0f, seg * 0.5f));
            set4(v.normal_type, 0, 1, 0, 1.0f);
            set4(v.flux, flux * (sigma_scat * seg * std::exp(-sigma_ext * t)), 0.0f);
        }
    }
    if (num_vpls == 0) std::memset(V, 0, sizeof(sb_vpl_t));
    stats.vpls = num_vpls;
}

// Lumiere des lasers dans la piece (PLAN-LASERS.md, etape 7) : lumieres virtuelles ajoutees a celles des lyres, dans les
// memes sondes. Surfaces : les impacts (LaserRig::hits, deja calcules pour le dessin), echantillonnes en angle le long de
// chaque morceau, puissance x couleur de la surface x attenuation par la fumee ; fumee : quelques points le long de chaque
// nappe ou trait (comme les 3 points d'un faisceau de lyre), puissance x diffusion x longueur. Les points sont regroupes
// par case de la grille des sondes (et par face pour les surfaces), puis par cases 2 fois plus grandes tant qu'il y en a
// trop : le nombre de lumieres reste borne quel que soit le nombre de lasers ou de morceaux.
void Renderer::build_laser_vpls(const Scene& scene, const LaserRig& las, const RenderSettings& rs, float sigma_ext, float sigma_scat) {
    const uint64_t t_start = stm_now();
    const int NF = 7;   // faces 0..5 : -x, +x, -y, +y, -z, +z (normale de la surface) ; 6 : fumee
    const int ncells = PR_X * PR_Y * PR_Z * NF;
    if ((int)lgi_index.size() != ncells) lgi_index.assign(ncells, -1);
    lgi_bins.clear();
    lgi_keys.clear();
    const vec3 inv = {1.0f / probe_cell.x, 1.0f / probe_cell.y, 1.0f / probe_cell.z};
    // groupes d'un fil : table case -> groupe (remise a -1 apres usage), groupes, cases touchees
    struct Acc {
        std::vector<int> index, keys;
        std::vector<LgiBin> bins;
    };
    static std::vector<Acc> acc;
    auto add = [&](Acc& A, vec3 P, vec3 n, int face, vec3 flux) {
        const float wl = flux.x + flux.y + flux.z;
        if (!(wl > 0.0f)) return;
        // sonde la plus proche (bornee avant l'arrondi : la troncature vaut alors l'arrondi)
        const int cx = (int)(std::clamp((P.x - probe_min.x) * inv.x, 0.0f, (float)(PR_X - 1)) + 0.5f);
        const int cy = (int)(std::clamp((P.y - probe_min.y) * inv.y, 0.0f, (float)(PR_Y - 1)) + 0.5f);
        const int cz = (int)(std::clamp((P.z - probe_min.z) * inv.z, 0.0f, (float)(PR_Z - 1)) + 0.5f);
        const int key = ((cz * PR_Y + cy) * PR_X + cx) * NF + face;
        int& bi = A.index[key];
        if (bi < 0) {
            bi = (int)A.bins.size();
            LgiBin nb;
            nb.cx = cx;
            nb.cy = cy;
            nb.cz = cz;
            nb.face = face;
            A.bins.push_back(nb);
            A.keys.push_back(key);
        }
        LgiBin& b = A.bins[bi];
        b.flux = b.flux + flux;
        b.pos = b.pos + P * wl;
        b.nrm = b.nrm + n * wl;
        b.w += wl;
    };
    auto face_of = [](vec3 n) {
        const float ax = std::fabs(n.x), ay = std::fabs(n.y), az = std::fabs(n.z);
        const int a = ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2;
        return 2 * a + (n[a] > 0.0f ? 1 : 0);
    };
    const float k = rs.laser_gain * LASER_FLUX_PER_W * rs.laser_gi_strength;
    const float cell_len = std::max(probe_cell.x, std::max(probe_cell.y, probe_cell.z));

    // impacts : lumiere renvoyee par la surface (meme puissance que le dessin des impacts, reglage compris)
    const float kh = k * rs.laser_hit_gain;
    const float step = cell_len;   // un point par case des sondes environ
    auto one_hit = [&](Acc& A, const LaserHit& h) {
        if (h.kind > 0.5f && h.kind < 1.5f) {   // trait : point d'arrivee, puissance f0
            vec3 n = h.surf;
            if (dot(n, h.src - h.a) < 0.0f) n = n * -1.0f;
            add(A, h.a, n, face_of(n), h.f0 * (kh * std::exp(-sigma_ext * length(h.a - h.src))));
            return;
        }
        // ligne ou arc : points repartis en angle de a a b, sur le plan de la surface touchee
        vec3 n = h.surf;
        if (dot(n, h.src - (h.a + h.b) * 0.5f) < 0.0f) n = n * -1.0f;
        const int ns = std::clamp((int)std::ceil(length(h.b - h.a) / step), 1, 32);
        const vec3 da = normalize(h.a - h.src), db = normalize(h.b - h.src);
        const float an = dot(h.a - h.src, n);
        const int face = face_of(n);
        for (int j = 0; j < ns; j++) {
            const float u = ((float)j + 0.5f) / (float)ns;
            const vec3 D = normalize(da + (db - da) * u);
            const float dn = dot(D, n);
            float t = dn < -1e-3f ? an / dn : -1.0f;
            vec3 P;
            if (t > 0.0f && t < 400.0f) P = h.src + D * t;
            else {
                P = h.a + (h.b - h.a) * u;
                t = length(P - h.src);
            }
            add(A, P, n, face, (h.f0 + (h.f1 - h.f0) * u) * (h.span / (float)ns * kh * std::exp(-sigma_ext * t)));
        }
    };
    // fumee : lumiere diffusee le long des nappes et des traits (diffusion de l'air et de la fumee de la piece, uniforme)
    const float sl = rs.laser_air + sigma_scat;
    const vec3 up = {0, 1, 0};
    auto along = [&](Acc& A, vec3 src, vec3 D, float r, vec3 P) {
        r = std::min(r, 80.0f);
        if (!(r > 0.05f)) return;
        const int nt = std::clamp((int)std::ceil(r / (2.0f * cell_len)), 1, 3);
        const float seg = r / (float)nt;
        for (int j = 0; j < nt; j++) {
            const float t = ((float)j + 0.5f) * seg;
            add(A, src + D * t, up, 6, P * (k * sl * seg * std::exp(-sigma_ext * t)));
        }
    };
    auto one_seg = [&](Acc& A, const LaserSegment& g) {
        if (g.arc) {
            const int m = std::clamp((int)std::ceil(g.dth / (30.0f * DEG)), 1, 8);
            for (int j = 0; j < m; j++) {
                const float u = ((float)j + 0.5f) / (float)m, th = g.th0 + g.dth * u;
                const vec3 D = normalize(g.ec + g.es * (g.cx + g.rho * std::cos(th)) + g.uu * (g.cy + g.rho * std::sin(th)));
                float r = std::min(g.range, exit_box(g.src, D, hall_min, hall_max));
                if (g.stop_d < 1e29f) {
                    const float dn = dot(g.stop_n, D);
                    if (dn > 1e-6f) r = std::min(r, g.stop_d / dn);
                }
                along(A, g.src, D, r, (g.flux + (g.flux1 - g.flux) * u) * (1.0f / (float)m));
            }
        } else if (g.traits > 1.5f && g.half_angle > 1e-6f) {
            const float ha = g.half_angle;
            const int m = std::clamp((int)std::ceil(2.0f * ha / (20.0f * DEG)), 1, 6);
            for (int j = 0; j < m; j++) {
                const float u = ((float)j + 0.5f) / (float)m, th = -ha + 2.0f * ha * u;
                const float c = std::cos(th), sn = std::sin(th);
                const vec3 D = g.ec * c + g.es * sn;
                float r = exit_box(g.src, D, hall_min, hall_max);
                if (g.range1 > 0.0f) {   // coupe par un obstacle : droite d'arret a x + b y = 1
                    const float cd = g.cut_a * c + g.cut_b * sn;
                    if (cd > 1e-6f) r = std::min(r, 1.0f / cd);
                } else r = std::min(r, g.range);
                along(A, g.src, D, r, (g.flux + (g.flux1 - g.flux) * u) * (1.0f / (float)m));
            }
        } else {
            along(A, g.src, g.ec, g.range, g.flux);
        }
    };
    // Tous les coeurs (fils du moteur laser) : paquets d'impacts et de morceaux, chaque fil dans ses propres groupes,
    // reunis ensuite. Aucun laser allume : rien (le moteur garde alors les impacts de la derniere figure).
    const bool lit = !las.segs.empty();
    const int nh = lit && rs.laser_impacts ? (int)las.hits.size() : 0;
    const int nsg = lit && sl > 0.0f ? (int)las.segs.size() : 0;
    const int HC = 256, SC = 128;
    const int nhc = (nh + HC - 1) / HC, nsc = (nsg + SC - 1) / SC;
    const int nw = laser_workers();
    if ((int)acc.size() < nw) acc.resize(nw);
    for (Acc& A : acc) A.bins.clear();   // un fil sans paquet garde sinon ceux de l'image d'avant
    std::atomic<int> next{0};
    const std::function<void(int)> job = [&](int w) {
        Acc& A = acc[w];
        if ((int)A.index.size() != ncells) A.index.assign(ncells, -1);
        A.bins.clear();
        A.keys.clear();
        for (int c; (c = next.fetch_add(1)) < nhc + nsc;) {
            if (c < nhc) {
                for (int i = c * HC, e = std::min(nh, i + HC); i < e; i++) one_hit(A, las.hits[i]);
            } else {
                for (int i = (c - nhc) * SC, e = std::min(nsg, i + SC); i < e; i++) one_seg(A, las.segs[i]);
            }
        }
        for (int key : A.keys) A.index[key] = -1;
    };
    if (nhc + nsc > 1) laser_parallel(job);
    else job(0);
    for (int w = 0; w < nw; w++)
        for (const LgiBin& b : acc[w].bins) {
            const int key = ((b.cz * PR_Y + b.cy) * PR_X + b.cx) * NF + b.face;
            int& bi = lgi_index[key];
            if (bi < 0) {
                bi = (int)lgi_bins.size();
                lgi_bins.push_back(b);
                lgi_keys.push_back(key);
            } else {
                LgiBin& d = lgi_bins[bi];
                d.flux = d.flux + b.flux;
                d.pos = d.pos + b.pos;
                d.nrm = d.nrm + b.nrm;
                d.w += b.w;
            }
        }
    for (int key : lgi_keys) lgi_index[key] = -1;

    // trop de groupes : cases 2 fois plus grandes (surfaces et fumee separement), jusqu'a tenir dans le budget
    const int avail = MAX_VPLS - num_vpls;
    const size_t budget_surf = (size_t)std::max(0, std::min(1024, avail * 3 / 4));
    const size_t budget_fog = (size_t)std::max(0, std::min(384, avail - (int)budget_surf));
    // cases grossies : memes indices que les cases fines (coordonnees divisees par 2, toujours dans la grille), table
    // lgi_index reprise puis remise a -1
    auto reduce = [&](std::vector<LgiBin>& bins, size_t budget) {
        int lvl = 0;
        while (bins.size() > budget && lvl < 6) {
            lgi_tmp.clear();
            lgi_keys.clear();
            for (const LgiBin& b : bins) {
                const int cx = b.cx >> 1, cy = b.cy >> 1, cz = b.cz >> 1;
                const int key = ((cz * PR_Y + cy) * PR_X + cx) * NF + b.face;
                int& bi = lgi_index[key];
                if (bi < 0) {
                    bi = (int)lgi_tmp.size();
                    lgi_keys.push_back(key);
                    LgiBin c = b;
                    c.cx = cx;
                    c.cy = cy;
                    c.cz = cz;
                    lgi_tmp.push_back(c);
                } else {
                    LgiBin& d = lgi_tmp[bi];
                    d.flux = d.flux + b.flux;
                    d.pos = d.pos + b.pos;
                    d.nrm = d.nrm + b.nrm;
                    d.w += b.w;
                }
            }
            for (int key : lgi_keys) lgi_index[key] = -1;
            bins.swap(lgi_tmp);
            lvl++;
        }
        if (bins.size() > budget) {   // encore trop (budget presque nul) : garde les plus lumineux
            std::nth_element(bins.begin(), bins.begin() + budget, bins.end(), [](const LgiBin& a, const LgiBin& b) { return a.w > b.w; });
            bins.resize(budget);
        }
        return lvl;
    };
    lgi_surf.clear();
    lgi_fog.clear();
    for (const LgiBin& b : lgi_bins) (b.face < 6 ? lgi_surf : lgi_fog).push_back(b);
    const int lvl_s = reduce(lgi_surf, budget_surf), lvl_f = reduce(lgi_fog, budget_fog);

    // couleur de la surface (comme build_vpls : sol texture sous le point, assombri par l'eau ; sinon celle du pave)
    const bool tex_floor = floor_tex && rs.floor_texture;
    float wl[4] = {-1.0f, -1.0f, 0.0f, 0.0f};
    if (floor_tex) floor_tex->water_levels(rs.floor_wet, wl);
    const float wet_factor = lerpf(1.0f, 0.45f, std::max(wl[2], std::min(1.0f, wl[3] * 1.3f)));
    const float tile = std::max(rs.floor_tile, 0.25f);
    sb_vpl_t* V = (sb_vpl_t*)vpl_data.data();
    const int first = num_vpls;
    const float rad_s = std::max(0.6f, 0.35f * cell_len * (float)(1 << lvl_s));
    for (const LgiBin& b : lgi_surf) {
        if (num_vpls >= MAX_VPLS) break;
        vec3 P = b.pos * (1.0f / b.w);
        vec3 n = b.nrm;
        const float ln = length(n);
        n = ln > 1e-6f ? n * (1.0f / ln) : vec3(0, 1, 0);
        vec3 alb = {0.4f, 0.4f, 0.4f};
        RayHit h;
        if (scene.raycast(P + n * 0.3f, n * -1.0f, 1.5f, h)) {
            alb = h.albedo;
            P = h.pos;
            if (tex_floor && h.normal.y > 0.5f && h.pos.y < 0.05f) alb = floor_tex->albedo_at(h.pos.x, h.pos.z, tile) * (floor_scale * wet_factor);
        }
        sb_vpl_t& v = V[num_vpls++];
        set4(v.pos_radius, P + n * 0.1f, rad_s);
        set4(v.normal_type, n, 0.0f);
        set4(v.flux, b.flux * alb, 0.0f);
    }
    const float rad_f = std::max(1.0f, 0.5f * cell_len * (float)(1 << lvl_f));
    for (const LgiBin& b : lgi_fog) {
        if (num_vpls >= MAX_VPLS) break;
        sb_vpl_t& v = V[num_vpls++];
        set4(v.pos_radius, b.pos * (1.0f / b.w), rad_f);
        set4(v.normal_type, 0, 1, 0, 1.0f);
        set4(v.flux, b.flux, 0.0f);
    }
    if (num_vpls == 0) std::memset(V, 0, sizeof(sb_vpl_t));
    stats.vpls = num_vpls;
    stats.laser_vpls = num_vpls - first;
    stats.laser_vpl_ms = (float)stm_ms(stm_since(t_start));
}

void Renderer::build_fixture_instances(const Rig& rig, const RenderSettings& rs) {
    if (!rs.show_fixtures) return;
    const vec3 body = {0.035f, 0.035f, 0.04f};
    const float ref_tan = std::tan(5.0f * DEG);
    for (const Fixture& f : rig.fixtures) {
        const vec3 n = f.mount.n, side = f.side, fw = f.mount.f;
        // base
        dyn_cubes.push_back(make_instance(f.mount.pos + n * 0.075f, side * 0.18f, n * 0.075f, fw * 0.22f, body, 0.5f));
        // lyre (fourche) : tourne avec le pan
        float p = f.pan * DEG;
        vec3 h = fw * std::cos(p) + side * std::sin(p);
        vec3 ta = f.tilt_axis;
        dyn_cubes.push_back(make_instance(f.mount.pos + n * 0.17f, ta * 0.22f, n * 0.025f, h * 0.08f, body, 0.5f));
        for (int s = -1; s <= 1; s += 2)
            dyn_cubes.push_back(make_instance(f.mount.pos + n * 0.36f + ta * (0.2f * s), ta * 0.025f, n * 0.2f, h * 0.075f, body, 0.5f));
        // tete
        dyn_cyls.push_back(make_instance(f.head_center - f.dir * 0.02f, f.up * 0.17f, ta * 0.17f, f.dir * 0.22f, body, 0.45f));
        // lentille : emet la couleur de la lyre
        float T = std::tan(clampf(f.out.zoom, 1.5f, 60.0f) * 0.5f * DEG);
        float gain = clampf((ref_tan / T) * (ref_tan / T), 0.02f, 40.0f);
        vec3 emissive = f.emit * (rs.lens_glow * (60.0f + 3.0f * gain) * rig.power);
        dyn_cyls.push_back(make_instance(f.lens_pos, f.up * (rig.lens_diameter * 0.5f), ta * (rig.lens_diameter * 0.5f), f.dir * 0.012f, {0.02f, 0.02f, 0.02f}, 0.1f, emissive));
    }
}

// Volume d'ombre du pave o vu du point L : convexe { X : n.X <= h } (faces eclairees, aretes de silhouette),
// en coordonnees monde, normales unitaires. Ecrit (nombre de plans) puis les plans dans out (10 vec4).
// Faux si L est dans le pave.
static bool shadow_volume(const Occluder& o, vec3 L, float* out) {
    const vec3 axw[3] = {o.ax, o.ay, o.az};
    vec3 a[3];
    float off[3], Ll[3];
    for (int i = 0; i < 3; i++) {
        a[i] = axw[i] / std::max(dot(axw[i], axw[i]), 1e-8f);   // ligne de monde -> local
        off[i] = -dot(a[i], o.c);
        Ll[i] = dot(a[i], L) + off[i];
    }
    if (std::fabs(Ll[0]) <= 1 && std::fabs(Ll[1]) <= 1 && std::fabs(Ll[2]) <= 1) return false;
    int n = 0;
    auto add = [&](float nl0, float nl1, float nl2, float hl) {
        // plan local nl.x_l <= hl -> monde : (sum nl_i a_i).X <= hl - sum nl_i off_i
        vec3 nw = a[0] * nl0 + a[1] * nl1 + a[2] * nl2;
        float hw = hl - (nl0 * off[0] + nl1 * off[1] + nl2 * off[2]);
        const float len = std::max(length(nw), 1e-12f);
        set4(out + 4 * (4 + n), nw / len, hw / len);
        n++;
    };
    // faces eclairees : l'ombre est derriere (2 cm en retrait : le point sur la face reste eclaire)
    for (int i = 0; i < 3; i++) {
        const float sg = Ll[i] > 1 ? 1.0f : (Ll[i] < -1 ? -1.0f : 0.0f);
        if (sg == 0) continue;
        float nl[3] = {0, 0, 0};
        nl[i] = sg;
        add(nl[0], nl[1], nl[2], 1.0f);
        float* pl = out + 4 * (3 + n);   // dernier plan ajoute
        pl[3] -= 0.02f;
    }
    // aretes de silhouette : plan passant par L et l'arete, le pave du cote de l'ombre
    const vec3 Lv = {Ll[0], Ll[1], Ll[2]};
    for (int k = 0; k < 3; k++) {
        const int i = (k + 1) % 3, j = (k + 2) % 3;
        for (int q = 0; q < 4; q++) {
            const float si = (q & 1) ? 1.0f : -1.0f, sj = (q & 2) ? 1.0f : -1.0f;
            if ((si * Ll[i] > 1) == (sj * Ll[j] > 1)) continue;
            vec3 E = {0, 0, 0}, ek = {0, 0, 0};
            E[i] = si;
            E[j] = sj;
            ek[k] = 1;
            vec3 nl = cross(E - Lv, ek);
            if (dot(nl, Lv * -1.0f) < 0) nl = nl * -1.0f;
            // dot(nl, X - L) >= 0  <=>  -nl.X <= -nl.L
            add(-nl.x, -nl.y, -nl.z, -dot(nl, Lv));
        }
    }
    out[0] = (float)n;
    out[1] = out[2] = out[3] = 0;
    return n > 0;
}

// Rectangle de l'ecran (ndc x0 y0 x1 y1) et plage de profondeur (zr) couverts par le volume d'ombre du pave o
// vu de L, dans le hangar : enveloppe convexe des coins du pave et de leurs prolongements, coupee au plan
// avant de la camera (points devant + intersections du plan avec les segments entre les points : elles
// contiennent celles des aretes de l'enveloppe). Prolongements : jusqu'a la paroi touchee si tous les
// coins sortent par la meme paroi, sinon jusqu'a une distance qui depasse toutes les parois.
static void shadow_rect(const Occluder& o, vec3 L, const Camera& c, float tanX, float tanY, vec3 hmin, vec3 hmax, float* r,
                        float* zr) {
    vec3 V[8], D[8];
    float T[8];
    int face0 = -1;
    bool same = true;
    for (int k = 0; k < 8; k++) {
        V[k] = o.c + o.ax * ((k & 1) ? 1.0f : -1.0f) + o.ay * ((k & 2) ? 1.0f : -1.0f) + o.az * ((k & 4) ? 1.0f : -1.0f);
        D[k] = normalize(V[k] - L);
        T[k] = 1e9f;
        int face = -1;
        for (int i = 0; i < 3; i++) {
            if (std::fabs(D[k][i]) < 1e-6f) continue;
            const float ti = ((D[k][i] > 0 ? hmax[i] : hmin[i]) - V[k][i]) / D[k][i];
            if (ti < T[k]) { T[k] = ti; face = i * 2 + (D[k][i] > 0 ? 1 : 0); }
        }
        if (face0 < 0) face0 = face;
        else if (face != face0) same = false;
    }
    vec3 pts[16];
    for (int k = 0; k < 8; k++) {
        float t = std::max(T[k], 0.0f);
        if (!same) {   // plus loin que toutes les parois
            t = 0.0f;
            for (int q = 0; q < 8; q++) {
                const vec3 h = {(q & 1) ? hmax.x : hmin.x, (q & 2) ? hmax.y : hmin.y, (q & 4) ? hmax.z : hmin.z};
                t = std::max(t, length(h - V[k]));
            }
        }
        pts[k] = V[k];
        pts[8 + k] = V[k] + D[k] * t;
    }
    const float near_z = 0.06f;
    float z[16];
    for (int k = 0; k < 16; k++) z[k] = dot(pts[k] - c.pos, c.fwd);
    float x0 = 1e9f, y0 = 1e9f, x1 = -1e9f, y1 = -1e9f, zmin = 1e9f, zmax = -1e9f;
    auto add = [&](vec3 p) {
        const vec3 rel = p - c.pos;
        const float zz = std::max(dot(rel, c.fwd), near_z);
        const float x = dot(rel, c.right) / (zz * tanX), y = dot(rel, c.up) / (zz * tanY);
        x0 = std::min(x0, x); y0 = std::min(y0, y);
        x1 = std::max(x1, x); y1 = std::max(y1, y);
        zmin = std::min(zmin, zz); zmax = std::max(zmax, zz);
    };
    for (int k = 0; k < 16; k++)
        if (z[k] >= near_z) add(pts[k]);
    for (int a = 0; a < 16; a++)
        for (int b = a + 1; b < 16; b++)
            if ((z[a] >= near_z) != (z[b] >= near_z)) add(pts[a] + (pts[b] - pts[a]) * ((near_z - z[a]) / (z[b] - z[a])));
    if (zmax < near_z) {   // tout derriere la camera : jamais
        r[0] = r[1] = 2.0f; r[2] = r[3] = -2.0f;
        zr[0] = 1e9f; zr[1] = -1e9f;
        return;
    }
    const float m = 0.01f;
    r[0] = std::max(x0 - m, -1.0f); r[1] = std::max(y0 - m, -1.0f);
    r[2] = std::min(x1 + m, 1.0f); r[3] = std::min(y1 + m, 1.0f);
    if (r[2] < r[0] || r[3] < r[1]) { r[0] = r[1] = 2.0f; r[2] = r[3] = -2.0f; }   // hors de l'ecran : jamais
    zr[0] = zmin - 0.1f;
    zr[1] = zmax + 0.1f;
}

// Rectangle de l'ecran (ndc, x0 y0 x1 y1) ou le sol (y = 0) du hangar est visible ; faux s'il ne l'est pas.
static bool floor_screen_rect(const Camera& cam, float tanX, float tanY, vec3 mn, vec3 mx, float r[4]) {
    vec3 poly[4] = {{mn.x, 0, mn.z}, {mx.x, 0, mn.z}, {mx.x, 0, mx.z}, {mn.x, 0, mx.z}};
    vec3 clip[8];
    int n = 0;
    const float near_z = 0.06f;
    for (int i = 0; i < 4; i++) {
        const vec3 a = poly[i], b = poly[(i + 1) & 3];
        const float da = dot(a - cam.pos, cam.fwd) - near_z, db = dot(b - cam.pos, cam.fwd) - near_z;
        if (da >= 0) clip[n++] = a;
        if ((da >= 0) != (db >= 0)) clip[n++] = a + (b - a) * (da / (da - db));
    }
    if (n == 0) return false;
    r[0] = r[1] = 1e9f;
    r[2] = r[3] = -1e9f;
    for (int i = 0; i < n; i++) {
        const vec3 rel = clip[i] - cam.pos;
        const float z = std::max(dot(rel, cam.fwd), 1e-4f);
        const float x = dot(rel, cam.right) / (z * tanX), y = dot(rel, cam.up) / (z * tanY);
        r[0] = std::min(r[0], x); r[1] = std::min(r[1], y);
        r[2] = std::max(r[2], x); r[3] = std::max(r[3], y);
    }
    r[0] = std::max(r[0], -1.0f); r[1] = std::max(r[1], -1.0f);
    r[2] = std::min(r[2], 1.0f); r[3] = std::min(r[3], 1.0f);
    return r[2] > r[0] && r[3] > r[1];
}

// --------------------------------------------------------------------------------------------
//  Rendu d'une image
// --------------------------------------------------------------------------------------------
void Renderer::render(const Camera& cam, const Scene& scene, const Rig& rig, const GoboAtlas& gobos, const FogSim& fog,
                      const FogSettings& fs, const RenderSettings& rs, int width, int height, float time, void (*ui)(),
                      const LaserRig* lasers) {
    frame++;
    update_quality(rs);
    // FSR : la resolution interne est celle de l'ecran / diviseur (remplace render_scale)
    const float scale = rs.fsr ? 1.0f / clampf(rs.fsr_div, 1.0f, 4.0f) : clampf(rs.render_scale, 0.25f, 1.0f);
    const int w = std::max(16, (int)(width * scale));
    const int h = std::max(16, (int)(height * scale));
    const bool fsr = rs.fsr && (w < width || h < height);
    const int div = std::clamp(rs.vol_div, 1, 4);
    resize(w, h, std::max(8, w / div), std::max(8, h / div));
    stats.internal_w = iw; stats.internal_h = ih; stats.vol_w = vw; stats.vol_h = vh;

    // matrices camera
    const float aspect = (float)w / (float)h;
    const float tanY = std::tan(cam.fovy * 0.5f), tanX = tanY * aspect;
    const mat4 view = look_basis(cam.pos, cam.right, cam.up, cam.fwd);
    const mat4 proj = perspective_reverse_z(cam.fovy, aspect, 0.05f);
    const mat4 view_proj = proj * view;
    const float near_cluster = 1.0f, far_cluster = 160.0f;

    // fumee : coefficients moyens
    const float smoke_mean = fog.mean_smoke * fs.smoke;
    const float sigma_ext = fs.density * (fs.haze * 0.7f + smoke_mean);
    const float sigma_scat = sigma_ext * fs.scattering;

    // sol texture (passe des surfaces et reflets des flaques dans la composition)
    // z : 1 = reflet flou du beton mouille (0 : reflet seulement dans l'eau)
    float floor_p[4] = {4.0f / std::max(rs.floor_tile, 0.25f), saturate(rs.floor_wet), rs.refl_concrete ? 1.0f : 0.0f,
                        (floor_tex && rs.floor_texture) ? 1.0f : 0.0f};
    float floor_q[4] = {};
    if (floor_tex) set4(floor_q, floor_tex->tint * floor_scale, 1.0f / std::max(std::sqrt(floor_tex->mean_lum), 0.01f));
    // niveaux d'eau : flaques, creux, film (voir FloorTexture::water_levels)
    float floor_w[4] = {-1.0f, -1.0f, 0.0f, 0.0f};
    if (floor_tex) floor_tex->water_levels(floor_p[1], floor_w);
    floor_w[3] = std::max(rs.refl_blur, 0.0f);   // shaders : flou du reflet (la part de flaques ne sert qu'au CPU)
    // reflet du sol mouille : camera miroir sous le sol, seulement si de l'eau et du sol sont visibles
    float floor_rect[4] = {};
    bool mirror = floor_p[3] > 0.5f && floor_p[1] > 0.0f &&
                  floor_screen_rect(cam, tanX, tanY, hall_min, hall_max, floor_rect);
    Camera mcam = cam;
    mcam.pos.y = -cam.pos.y;
    mcam.fwd.y = -cam.fwd.y;
    mcam.right.y = -cam.right.y;
    mcam.up.y = -cam.up.y;
    const mat4 view_proj_m = proj * look_basis(mcam.pos, mcam.right, mcam.up, mcam.fwd);

    // donnees CPU -> GPU
    build_lights(rig, rs, gobos, scene);
    // rectangles d'ecran des volumes d'ombre (camera, camera miroir), puis masques des tuiles d'ecran
    // (32 x 18) : pour chaque tuile et chaque lyre, les paves dont l'ombre peut toucher la tuile
    std::fill(occ_tile_data.begin(), occ_tile_data.end(), 0u);
    {
        const sb_occ_t* OL = (const sb_occ_t*)occ_light_data.data();
        for (int i = 0; i < num_lights; i++) {
            for (uint32_t k = 0; k < OL[i].v[0]; k++) {
                const int p = (int)OL[i].v[1] + (int)k;
                float* blk = &occ_plane_data[(size_t)p * OCC_BLOCK * 4];
                // pave grossi de 2 rayons de lentille : la penombre deborde du volume d'ombre
                Occluder o = occluders[occ_pair_box[p]];
                const float pad = 2.0f * std::max(rig.lens_diameter * 0.5f, 0.005f);
                o.ax = o.ax * (1.0f + pad / std::max(length(o.ax), 1e-3f));
                o.ay = o.ay * (1.0f + pad / std::max(length(o.ay), 1e-3f));
                o.az = o.az * (1.0f + pad / std::max(length(o.az), 1e-3f));
                shadow_rect(o, occ_pair_lens[p], cam, tanX, tanY, hall_min, hall_max, blk + 4, blk + 12);
                if (mirror) shadow_rect(o, occ_pair_lens[p], mcam, tanX, tanY, hall_min, hall_max, blk + 8, blk + 14);
                else { set4(blk + 8, -1, -1, 1, 1); blk[14] = 0.0f; blk[15] = 1e9f; }
                for (int side = 0; side < (mirror ? 2 : 1); side++) {
                    const float* r = blk + 4 + 4 * side;
                    if (r[2] < r[0]) continue;
                    const int tx0 = std::clamp((int)((r[0] * 0.5f + 0.5f) * 32), 0, 31), tx1 = std::clamp((int)((r[2] * 0.5f + 0.5f) * 32), 0, 31);
                    const int ty0 = std::clamp((int)((r[1] * 0.5f + 0.5f) * 18), 0, 17), ty1 = std::clamp((int)((r[3] * 0.5f + 0.5f) * 18), 0, 17);
                    for (int ty = ty0; ty <= ty1; ty++)
                        for (int tx = tx0; tx <= tx1; tx++)
                            occ_tile_data[(size_t)((side * 576 + ty * 32 + tx) * 64 + i / 4)] |= (1u << k) << (8 * (i & 3));
                }
            }
        }
    }
    const bool analytic = rs.volumetrics && rs.analytic_beams && num_lights > 0;
    const float vol_pixel_angle = 2.0f * std::tan(cam.fovy * 0.5f) / (float)std::max(8, h / div);
    assign_beam_tiers(cam, vol_pixel_angle, rs.volumetrics && rs.beam_tiers, rs.soft_lights && rs.surface_lights, div,
                      rs.soft_lights && rs.surface_lights && rs.crowd_soft > 0);
    // cases chargees (cs_cull_clusters) : seulement si plus de crowd_soft taches de lyres a grande tache floue se
    // superposent quelque part a l'ecran (sphere de chaque tache, au bout du faisceau, sur 32 x 18 tuiles). Sinon
    // pas de passe a 1/4 ni de normales a ecrire (+0,1 a +0,8 ms) : l'image est la meme.
    bool crowd_on = rs.soft_lights && rs.surface_lights && rs.crowd_soft > 0 && num_open > rs.crowd_soft;
    if (crowd_on) {
        int tiles[18][32] = {};
        int most = 0;
        const sb_light_t* Lc = (const sb_light_t*)light_data.data();
        for (int i = 0; i < num_lights && most <= rs.crowd_soft; i++) {
            if (Lc[i].prism[0] > -0.5f) continue;
            const float h = Lc[i].pos_range[3];
            const vec3 pe = vec3{Lc[i].pos_range[0], Lc[i].pos_range[1], Lc[i].pos_range[2]} +
                            vec3{Lc[i].dir_tanenv[0], Lc[i].dir_tanenv[1], Lc[i].dir_tanenv[2]} * h;
            const float R = h * Lc[i].dir_tanenv[3];
            const vec3 v = pe - cam.pos;
            const float z = dot(v, cam.fwd);
            int x0 = 0, x1 = 31, y0 = 0, y1 = 17;
            if (z > R) {   // sinon la tache entoure la camera : tout l'ecran
                const float x = dot(v, cam.right) / (z * tanX), y = dot(v, cam.up) / (z * tanY);
                const float rx = R / ((z - R) * tanX), ry = R / ((z - R) * tanY);
                x0 = std::max(0, (int)std::floor((x - rx + 1.0f) * 16.0f));
                x1 = std::min(31, (int)std::floor((x + rx + 1.0f) * 16.0f));
                y0 = std::max(0, (int)std::floor((y - ry + 1.0f) * 9.0f));
                y1 = std::min(17, (int)std::floor((y + ry + 1.0f) * 9.0f));
            }
            for (int ty = y0; ty <= y1; ty++)
                for (int tx = x0; tx <= x1; tx++) most = std::max(most, ++tiles[ty][tx]);
        }
        crowd_on = most > rs.crowd_soft;
    }
    const bool soft_pass = num_soft > 0 || crowd_on;
    if (analytic) build_beam_tables(cam, vol_pixel_angle);
    const bool mirror_an = mirror && analytic;
    // cones visibles dans le reflet : test du cone (sommet, axe, longueur, rayon au bout) contre les
    // 4 plans de la camera miroir restreints au rectangle du sol a l'ecran, et le plan proche
    beam_order_m.clear();
    if (mirror) {
        mirror_vis.assign(num_lights, 0);
        const vec3 F = mcam.fwd, Rt = mcam.right, Up = mcam.up;
        const vec3 planes[5] = {normalize(Rt - F * (floor_rect[0] * tanX)), normalize(F * (floor_rect[2] * tanX) - Rt),
                                normalize(Up - F * (floor_rect[1] * tanY)), normalize(F * (floor_rect[3] * tanY) - Up), F};
        const sb_light_t* L = (const sb_light_t*)light_data.data();
        for (int i = 0; i < num_lights; i++) {
            const vec3 A = vec3(L[i].pos_range[0], L[i].pos_range[1], L[i].pos_range[2]) - mcam.pos;
            const vec3 d = {L[i].dir_tanenv[0], L[i].dir_tanenv[1], L[i].dir_tanenv[2]};
            const float hl = L[i].pos_range[3], Rend = hl * L[i].dir_tanenv[3];
            bool vis = true;
            for (const vec3& n : planes) {
                const float nd = dot(n, d);
                const float far_pt = dot(n, A + d * hl) + Rend * std::sqrt(std::max(0.0f, 1.0f - nd * nd));
                if (std::max(dot(n, A), far_pt) < 0.0f) { vis = false; break; }
            }
            mirror_vis[i] = vis;
            if (vis) beam_order_m.push_back((uint32_t)i);
        }
        stats.mirror_beams = (int)beam_order_m.size();
    }
    if (mirror_an && !beam_order_m.empty()) build_beam_tables(mcam, 2.0f * tanY / (float)refl_vh, true);
    stats.laser_vpls = 0;
    stats.laser_vpl_ms = 0;
    if (rs.gi) {
        build_vpls(scene, rig, gobos, rs, sigma_ext, sigma_scat);
        if (rs.laser_gi && rs.lasers && lasers) build_laser_vpls(scene, *lasers, rs, sigma_ext, sigma_scat);
    }
    build_fixture_instances(rig, rs);
    // lasers : segments de l'image (puissance mise a l'echelle de la fumee)
    int nlas = 0;      // segments envoyes au GPU (morceaux d'arcs voisins fusionnes)
    int nlas_cpu = 0;  // segments du moteur (LaserRig::segs)
    bool laser_grad = false;   // une figure au moins a un degrade : variante du shader qui les lit
    bool laser_arcs = false;   // une figure au moins a une nappe conique (arc) : variante du shader avec laser_arc
    bool laser_conv_used = false;   // convergence RGB reglee et un eventail ou un trait a des couleurs melangees (LASER_CONV)
    auto mixed_color = [](vec3 a, vec3 b) {
        const vec3 c = a + b;
        return (c.x > 0.0f ? 1 : 0) + (c.y > 0.0f ? 1 : 0) + (c.z > 0.0f ? 1 : 0) >= 2;
    };
    if (rs.lasers && lasers) {
        nlas_cpu = std::min((int)lasers->segs.size(), MAX_LASER_SEGS);
        // puissance d'un trait ; la diffusion (air + fumee de la piece) est lue au point de la nappe (laser_sigma)
        const float k = rs.laser_gain * LASER_FLUX_PER_W;
        laser_data.resize((size_t)std::max(nlas_cpu, 1) * LASER_FLOATS);
        for (int i = 0; i < nlas_cpu; i++) {
            LaserSegment g = lasers->segs[i];
            if (g.arc) {
                // Morceaux voisins d'un meme cercle fusionnes en une seule nappe conique (PLAN-OPTIM-LASERS.md, 0.5) : le moteur
                // decoupe les arcs en morceaux de 90 deg au plus (ses impacts en ont besoin), et chaque morceau calculait le
                // cone entier dans les pixels qu'il couvre avant de rejeter l'autre cote. Fusion : meme cercle, sans arret sur
                // un obstacle, meme ecart des traits, a la suite, meme puissance par trait et couleur unie ; jamais un tour
                // complet (la jonction du cercle garde ses deux bords : un cercle entier fait 2 morceaux au lieu de 4).
                if (rs.laser_merge) {
                    const float dt = g.dth / std::max(g.traits - 1.0f, 1.0f);
                    auto flat = [](const LaserSegment& s) { return s.flux.x == s.flux1.x && s.flux.y == s.flux1.y && s.flux.z == s.flux1.z; };
                    while (i + 1 < nlas_cpu && g.stop_d >= 1e29f && flat(g)) {
                        const LaserSegment& h = lasers->segs[i + 1];
                        if (!h.arc || h.stop_d < 1e29f || !flat(h) || h.traits < 2.0f) break;
                        if (!(h.src.x == g.src.x && h.src.y == g.src.y && h.src.z == g.src.z && h.ec.x == g.ec.x && h.ec.y == g.ec.y &&
                              h.ec.z == g.ec.z && h.es.x == g.es.x && h.es.y == g.es.y && h.es.z == g.es.z && h.cx == g.cx && h.cy == g.cy &&
                              h.rho == g.rho))
                            break;
                        const float dth_h = h.dth / (h.traits - 1.0f);
                        if (std::fabs(dth_h - dt) > 1e-4f * dt || std::fabs(h.th0 - (g.th0 + g.dth + dt)) > 1e-3f * dt) break;
                        const vec3 pa = g.flux * (1.0f / g.traits), pb = h.flux * (1.0f / h.traits);
                        if (std::fabs(pa.x - pb.x) > 1e-5f * (pa.x + 1e-20f) || std::fabs(pa.y - pb.y) > 1e-5f * (pa.y + 1e-20f) ||
                            std::fabs(pa.z - pb.z) > 1e-5f * (pa.z + 1e-20f))
                            break;
                        const float nb = g.traits + h.traits;
                        if ((nb - 1.0f) * dt + dt >= 2.0f * PI - 1e-3f) break;   // jamais un tour complet
                        g.traits = nb;
                        g.dth = (nb - 1.0f) * dt;
                        g.flux = g.flux + h.flux;
                        g.flux1 = g.flux;
                        g.range = std::max(g.range, h.range);
                        i++;
                    }
                }
                // nappe conique (laser_arc) : repere (d, rr, uu), cercle, angles ; traits aux deux bouts compris
                const float nbA = std::max(g.traits, 2.0f);
                const vec3 q = cam.pos - g.src;
                float* d = &laser_data[(size_t)nlas * LASER_FLOATS];
                nlas++;
                set4(d, g.ec, g.th0);
                set4(d + 4, g.es, -nbA);
                set4(d + 8, g.uu, g.range);
                set4(d + 12, dot(q, g.ec), dot(q, g.es), dot(q, g.uu), g.dth);
                set4(d + 16, g.flux * (k / nbA), (nbA - 1.0f) / std::max(g.dth, 1e-6f));
                set4(d + 20, g.flux1 * (k / nbA), 1.0f / nbA);
                set4(d + 24, g.cx, g.cy, g.rho, 0.0f);
                // arret sur la face d'un obstacle, dans le repere (d, rr, uu)
                if (g.stop_d < 1e29f) set4(d + 28, dot(g.stop_n, g.ec), dot(g.stop_n, g.es), dot(g.stop_n, g.uu), g.stop_d);
                else set4(d + 28, 0.0f, 0.0f, 0.0f, 1e30f);
                laser_grad = laser_grad || g.flux1.x != g.flux.x || g.flux1.y != g.flux.y || g.flux1.z != g.flux.z;
                laser_arcs = true;
                continue;
            }
            float nb = std::max(g.traits, 1.0f);
            if (g.half_angle < 1e-6f) nb = 1.0f;   // ouverture nulle : tous les traits confondus
            const vec3 nrm = cross(g.ec, g.es);
            const vec3 q = cam.pos - g.src;      // camera dans le repere de l'eventail (une fois par image)
            float* d = &laser_data[(size_t)nlas * LASER_FLOATS];
            nlas++;
            set4(d, g.ec, std::sin(g.half_angle));
            set4(d + 4, g.es, nb);
            // portee : coupe par un obstacle (range1 > 0), la plus grande des deux bords ; la droite d'arret (cut) fait la coupe exacte.
            // Avec la portee du bord 0 seule, un triangle de nappe disparaissait devant la face quand le bord 1 la touche plus loin
            set4(d + 8, nrm, std::max(g.range, g.range1));
            set4(d + 12, dot(q, g.ec), dot(q, g.es), dot(q, nrm), std::cos(g.half_angle));
            set4(d + 16, g.flux * (k / nb), nb > 1.5f ? (nb - 1.0f) / (2.0f * g.half_angle) : 0.0f);
            set4(d + 20, g.flux1 * (k / nb), 1.0f / nb);
            // coupe par un obstacle : droite d'arret (a x + b y <= 1 du cote de la source), portee au bord 1
            if (nb > 1.5f) set4(d + 24, g.cut_a, g.cut_b, g.range1, 0.0f);
            else set4(d + 24, 0.0f, 0.0f, 0.0f, 0.0f);
            set4(d + 28, g.eu0, g.eu1, 0.0f, 1e30f);   // eventails : position des bords dans la figure (bords brillants)
            laser_conv_used = laser_conv_used || (rs.laser_conv > 0.0f && mixed_color(g.flux, g.flux1));
            laser_grad = laser_grad || g.flux1.x != g.flux.x || g.flux1.y != g.flux.y || g.flux1.z != g.flux.z;
        }
    }
    stats.laser_segments = nlas;
    // lasers dans le reflet du sol mouille : memes segments vus de la camera miroir. Seule la camera dans le repere de chaque
    // nappe (cam_rel, flottants 12 a 14 : camera - source sur ec, es, normale ou uu) change : camera miroir = camera + delta.
    const bool mirror_las = mirror && rs.refl_lasers > 0 && nlas > 0;
    stats.mirror_lasers = mirror_las ? nlas : 0;
    if (mirror_las) {
        laser_data_m.assign(laser_data.begin(), laser_data.begin() + (size_t)nlas * LASER_FLOATS);
        const vec3 delta = mcam.pos - cam.pos;
        for (int i = 0; i < nlas; i++) {
            float* d = &laser_data_m[(size_t)i * LASER_FLOATS];
            for (int j = 0; j < 3; j++) d[12 + j] += delta.x * d[4 * j] + delta.y * d[4 * j + 1] + delta.z * d[4 * j + 2];
        }
    }
    // impacts : coupes au plan proche de la camera (bandes dessinees a l'ecran)
    laser_hit_data.clear();
    int nhits = 0;
    if (rs.lasers && rs.laser_impacts && lasers && nlas > 0) {
        const float zn = 0.1f;
        for (const LaserHit& hh : lasers->hits) {
            if (nhits >= MAX_LASER_HITS) break;
            LaserHit q = hh;
            const float za = dot(q.a - cam.pos, cam.fwd), zb = dot(q.b - cam.pos, cam.fwd);
            if (q.kind > 0.5f && q.kind < 1.5f) {   // point (trait) ; lignes et arcs : coupes au plan proche
                if (za < zn) continue;
            } else {
                if (za < zn && zb < zn) continue;
                if (za < zn) q.a = q.a + (q.b - q.a) * ((zn - za) / (zb - za));
                else if (zb < zn) q.b = q.b + (q.a - q.b) * ((zn - zb) / (za - zb));
                // puissance par radian aux nouveaux bouts : approchee par celle des anciens (la coupe est rare)
            }
            const float k = rs.laser_gain * LASER_FLUX_PER_W;
            float d[28];
            set4(d, q.a, q.kind);
            set4(d + 4, q.b, q.pad0);   // arc : rho, rr, cx, cy dans les w (LaserHit)
            set4(d + 8, q.src, q.pad1);
            set4(d + 12, q.nrm, q.pad2);
            set4(d + 16, q.f0 * k, q.pad3);
            set4(d + 20, q.f1 * k, q.pad4);
            set4(d + 24, q.surf, q.pad5);
            laser_hit_data.insert(laser_hit_data.end(), d, d + 28);
            nhits++;
        }
    }
    // lueur de sortie : un « impact » de type 3 par laser allume (point chaud et halo autour de la sortie, fs_laser_hit),
    // dessine apres la composition (un eblouissement de l'optique : pas attenue par la fumee de la scene pixel par pixel).
    // Part de la puissance diffusee par la fenetre de sortie, par steradian : LASER_EXIT_SCATTER x reglage.
    laser_exit_data.clear();
    int nexits = 0;
    if (rs.lasers && lasers && nlas > 0 && rs.laser_exit > 0.0f) {
        const float k = rs.laser_gain * LASER_FLUX_PER_W * LASER_EXIT_SCATTER * rs.laser_exit;
        for (const LaserRig::Exit& e : lasers->exits) {
            if (nexits >= MAX_LASER_EXITS) break;
            if (dot(e.pos - cam.pos, cam.fwd) < 0.1f) continue;
            float d[28] = {};
            set4(d, e.pos, 3.0f);
            set4(d + 4, e.pos, 0.0f);
            set4(d + 8, e.pos, 0.0f);
            set4(d + 12, e.dir, 0.0f);
            set4(d + 16, e.flux * k, 0.0f);
            laser_exit_data.insert(laser_exit_data.end(), d, d + 28);
            nexits++;
        }
    }
    // ... et leur reflet dans le sol mouille (vues de la camera miroir)
    laser_exit_data_m.clear();
    int nexits_m = 0;
    if (mirror_las && rs.laser_exit > 0.0f) {
        const float k = rs.laser_gain * LASER_FLUX_PER_W * LASER_EXIT_SCATTER * rs.laser_exit;
        for (const LaserRig::Exit& e : lasers->exits) {
            if (nexits_m >= MAX_LASER_EXITS) break;
            if (dot(e.pos - mcam.pos, mcam.fwd) < 0.1f) continue;
            float d[28] = {};
            set4(d, e.pos, 3.0f);
            set4(d + 4, e.pos, 0.0f);
            set4(d + 8, e.pos, 0.0f);
            set4(d + 12, e.dir, 0.0f);
            set4(d + 16, e.flux * k, 0.0f);
            laser_exit_data_m.insert(laser_exit_data_m.end(), d, d + 28);
            nexits_m++;
        }
    }
    stats.laser_hits = nhits;
    const bool hit_pass = nhits > 0;
    const bool laser_tiles = nlas > 0;
    // resolution des lasers (2.1) : calcules dans le coin (lw x lh) de leur image, agrandis ensuite (fs_laser_up)
    const float lscale = laser_tiles ? laser_scale_for(rs) : 1.0f;
    const int lw = lscale < 0.999f ? std::max(16, (int)std::lround(w * lscale)) : w;
    const int lh = lscale < 0.999f ? std::max(16, (int)std::lround(h * lscale)) : h;
    const bool laser_lo = lw != w || lh != h;
    const int lctx = (lw + 127) / 128, lcty = (lh + 127) / 128;
    stats.laser_scale = (float)lw / (float)w;
    stats.laser_tiles_x = (lw + 15) / 16;
    stats.laser_tiles_y = (lh + 15) / 16;
    laser_cs_params_t lp = {};
    {
        // rayon de sortie a 1/e2 (m) et demi-divergence (rad) : reglages des boitiers
        const float ap = lasers ? 0.0005f * lasers->aperture_mm : 0.0025f;
        const float div_half = lasers ? 0.0005f * lasers->divergence_mrad : 0.0005f;
        set4(lp.cam_pos, cam.pos, 0.0f);
        set4(lp.cam_right, cam.right, tanX);
        set4(lp.cam_up, cam.up, tanY);
        set4(lp.cam_fwd, cam.fwd, sigma_ext);
        set4(lp.res, (float)lw, (float)lh, (float)nlas, 2.0f * tanY / (float)lh);
        set4(lp.beam, ap * ap * 0.25f, div_half * div_half * 0.25f, rs.laser_width_px, clampf(fs.anisotropy, -0.95f, 0.95f));
        set4(lp.tiles, (float)stats.laser_tiles_x, (float)stats.laser_tiles_y, (float)lctx, gpuprof::stats_enabled() ? 1.0f : 0.0f);
        set4(lp.hall_min, hall_min, (float)w / (float)lw);
        set4(lp.hall_max, hall_max, (float)h / (float)lh);
        // fumee de la piece : coordonnee de texture = X * inv - min * inv (une operation par axe dans le shader)
        set4(lp.fog_box_min, fog.origin.x / fog.size.x, fog.origin.y / fog.size.y, fog.origin.z / fog.size.z, 0.0f);
        set4(lp.fog_box_inv, 1.0f / fog.size.x, 1.0f / fog.size.y, 1.0f / fog.size.z, 0.0f);
        const bool sfog = rs.sfog.model == 1;   // fumee spatiale (v2) : toujours la fumee de la piece, sans les volutes
        // w : rectangle de tri des grosses tuiles (cs_laser_bin), x min ; tout l'ecran (reflet : le sol a l'ecran)
        set4(lp.lfog, rs.laser_air + sigma_scat, (rs.laser_room_fog || sfog) ? 1.0f : 0.0f,
             sfog ? 0.0f : volutes_force(rs, fs.haze * 0.7f, smoke_mean), -2.0f);
        // fumee de la piece (texture des amas, canal g : densite / room_max, voir FogSim::update) : air + densite x
        // albedo x densite ; force des volutes : rampe sur les amas (canal r = amas / 2), au plus fort quand ils valent
        // la brume moyenne
        {
            const float vs = (rs.laser_volutes && !sfog) ? rs.laser_vol_strength : 0.0f;
            set4(lp.lroom, rs.laser_air, fs.density * fs.scattering * fog.room_max, vs * 0.35f, vs * 0.65f);
            set4(lp.lroom2, 0.65f * vs * 2.0f * fs.smoke / std::max(fs.haze * 0.7f, 0.01f), -2.0f, 2.0f, 2.0f);   // yzw : rectangle de tri
        }
        // volutes : vent (meme derive que le detail des lyres) et boucle d'evolution (2 instants melanges en aller-retour ;
        // divises par l'ecart type du melange : le contraste ne baisse pas entre les deux)
        if (rs.laser_volutes && volutes_img.id && !sfog) {
            const float wa = fs.wind_angle * DEG;
            const float tt = fs.animate ? time : 0.0f;
            const float sz = std::max(rs.laser_vol_size, 0.05f);
            const vec3 drift = vec3(std::cos(wa) * fs.wind_speed, fs.rise * 0.25f, std::sin(wa) * fs.wind_speed) * tt;
            set4(lp.lvol, drift * (-1.0f / sz), 1.0f / sz);
            const float f = 1.0f - std::fabs(1.0f - 2.0f * fractf(tt / std::max(rs.laser_vol_period, 0.5f)));
            const float kn = 1.0f / (VOLUTES_SD * std::sqrt((1.0f - f) * (1.0f - f) + f * f));
            set4(lp.lvolw, (1.0f - f) * kn, f * kn, 0.0f, 0.0f);
            // texels par metre : VOLUTES_N / taille ; niveau 0 tant qu'un pixel couvre moins d'un texel
            set4(lp.lvol2, -0.5f * kn, std::log2((float)VOLUTES_N / sz), 6.0f, 0.0f);
            // 2e octave : 3,6 fois plus petite, 1,6 fois plus rapide ; lue tant qu'un pixel couvre moins de 2^lim texels
            if (rs.laser_vol_fine) {
                const float sz2 = sz / 3.6f, w2 = std::max(rs.laser_vol_fine_weight, 1e-3f);
                set4(lp.lvol3, drift * (-1.6f / sz2), 1.0f / sz2);
                set4(lp.lvol4, std::log2((float)VOLUTES_N / sz2), rs.laser_vol_fine_lod, rs.laser_vol_fine_weight,
                     (1.0f - 1.0f / std::sqrt(1.0f + w2 * w2)) / w2);
            } else {
                set4(lp.lvol4, 0.0f, -1000.0f, 0.0f, 0.0f);
            }
        } else {
            set4(lp.lvol2, 0.0f, 0.0f, -1000.0f, 0.0f);
            set4(lp.lvol4, 0.0f, -1000.0f, 0.0f, 0.0f);
        }
        // fumee spatiale : profil des bancs (seuil par pixel), nuages (meme vent que les volutes), texture generee au 1er
        // usage ; salle composee : ambiance douce (A, uniformes habituels) et chargee (B, lmixb*), melangees par pixel
        if (sfog) {
            const SpatialFogSettings sa = spatial_fog_style(rs.sfog, 0), sb = spatial_fog_style(rs.sfog, 1);
            SpatialFogProfile pa, pb;
            pa.setup(sa);
            pb.setup(sb);
            const float k = fs.density * fs.scattering;
            set4(lp.lbank, std::min(pa.thr, 1e6f), pa.edge, pa.thr + 1.0f / pa.edge, pa.core);
            set4(lp.lbank2, pa.keep * pa.inv_mean, pa.inv_mean, k * fog.sf_haze_scale, k * fog.sf_smoke_scale);
            if (!clouds_img.id) {
                clouds.build();
                sg_image_desc d = {};
                d.type = SG_IMAGETYPE_3D;
                d.width = d.height = d.num_slices = CLOUD_N;
                d.num_mipmaps = (int)clouds.mips.size();
                d.pixel_format = SG_PIXELFORMAT_BC5_RG;
                for (size_t m = 0; m < clouds.mips.size(); m++) {
                    d.data.mip_levels[m].ptr = clouds.mips[m].data();
                    d.data.mip_levels[m].size = clouds.mips[m].size();
                }
                d.label = "laser-clouds";
                clouds_img = sg_make_image(&d);
                clouds_view = texture_view(clouds_img);
                clouds.mips.clear();
            }
            const float wa = fs.wind_angle * DEG;
            const float tt = fs.animate ? time : 0.0f;
            const float wx = std::cos(wa) * fs.wind_speed, wy = fs.rise * 0.25f, wz = std::sin(wa) * fs.wind_speed;
            // nuages lus si l'une des deux ambiances ronge
            SpatialFogSettings sr = sa;
            sr.cloud_erode = std::max(sa.cloud_erode, sb.cloud_erode);
            float cpar[6][4], cb[5][4];
            spatial_fog_cloud_params(sr, clouds, tt, wx, wy, wz, cpar);
            const float rag_a = sa.cloud_erode > 0.0f ? std::max(sa.bank_rag, 0.0f) : 0.0f;
            set4(lp.lvol, cpar[0][0], cpar[0][1], cpar[0][2], cpar[0][3]);
            set4(lp.lvolw, cpar[1][0], cpar[1][1], cpar[1][2], cpar[1][3]);
            set4(lp.lvol2, cpar[2][0], cpar[2][1], cpar[2][2], rag_a);
            spatial_fog_cloud_params(sa, clouds, tt, wx, wy, wz, cpar);
            set4(lp.lvol3, cpar[3][0], cpar[3][1], cpar[3][2], cpar[3][3]);
            set4(lp.lvol4, cpar[4][0], cpar[4][1], cpar[4][2], cpar[4][3]);
            spatial_fog_cloud_params(sb, clouds, tt, wx, wy, wz, cb);
            set4(lp.lmixb0, std::min(pb.thr, 1e6f), pb.edge, pb.core, pb.keep * pb.inv_mean);
            set4(lp.lmixb1, pb.inv_mean, sb.cloud_erode > 0.0f ? std::max(sb.bank_rag, 0.0f) : 0.0f, cb[3][1], cb[3][2]);
            set4(lp.lmixb2, cb[3][3], cb[4][2], cb[4][3], cb[4][0]);
            set4(lp.lmixb3, cb[4][1], 0.0f, 0.0f, 0.0f);
            // tourbillons, filaments de pres (texture des volutes), deformation a tres grande echelle
            spatial_fog_motion_params(rs.sfog, tt, wx, wy, wz, VOLUTES_SD, VOLUTES_N, cpar);
            set4(lp.lswirl, cpar[0][0], cpar[0][1], cpar[0][2], cpar[0][3]);
            set4(lp.lswirl2, cpar[1][0], cpar[1][1], cpar[1][2], cpar[1][3]);
            set4(lp.lfil, cpar[2][0], cpar[2][1], cpar[2][2], cpar[2][3]);
            set4(lp.lfil2, cpar[3][0], cpar[3][1], cpar[3][2], cpar[3][3]);
            set4(lp.lfil3, cpar[4][0], cpar[4][1], cpar[4][2], cpar[4][3]);
            set4(lp.lwarp, cpar[5][0], cpar[5][1], cpar[5][2], cpar[5][3]);
        }
        // diffusion vers l'avant : lobe doux (g de la fumee si un seul lobe) + lobe tres avant (poids w)
        const float w = rs.laser_fwd_lobe ? saturate(rs.laser_fwd_weight) : 0.0f;
        const float g0 = clampf(rs.laser_fwd_lobe ? rs.laser_g_soft : fs.anisotropy, -0.95f, 0.95f);
        const float g1 = clampf(rs.laser_g_fwd, -0.98f, 0.98f);
        set4(lp.lphase0, 1.0f + g0 * g0, 2.0f * g0, (1.0f - w) * (1.0f - g0 * g0) * 0.07957747f, 0.0f);
        set4(lp.lphase1, 1.0f + g1 * g1, 2.0f * g1, w * (1.0f - g1 * g1) * 0.07957747f, 0.0f);
        // bords brillants : densite 1 / sqrt(max(1 - u^2, eps)), eps = 2 x largeur de la bande (1 - u^2 ~ 2 (1 - |u|) au
        // bord), ramenee a une moyenne de 1 sur u de -1 a 1
        {
            const float eps = std::max(2.0f * rs.laser_edge_w, 1e-4f);
            double sum = 0.0;
            const int N = 2048;
            for (int k = 0; k < N; k++) {
                const double u = -1.0 + (k + 0.5) * 2.0 / N;
                sum += 1.0 / std::sqrt(std::max(1.0 - u * u, (double)eps));
            }
            set4(lp.ledge, saturate(rs.laser_edge), eps, (float)(N / sum), std::max(rs.laser_conv, 0.0f) * 1e-3f);
        }
    }
    // variante du shader : fumee uniforme et un lobe (0), fumee de la piece et deux lobes (1), avec les volutes (2), et
    // leur 2e octave (3) seulement si un segment passe assez pres de la camera pour qu'elle y soit lue
    int fogv = 0;
    if (laser_tiles) {
        // fumee spatiale : carte et nuages (4 ; nuages coupes, erosion 0 : rien n'est lu, lvol2.z), avec les filaments de
        // pres (5) seulement si un segment passe assez pres de la camera pour qu'ils y soient lus
        if (rs.sfog.model == 1 && clouds_img.id) {
            fogv = 4;
            const float erode_any = std::max(spatial_fog_style(rs.sfog, 0).cloud_erode, spatial_fog_style(rs.sfog, 1).cloud_erode);
            if (rs.sfog.fil_strength > 0.0f && erode_any > 0.0f && volutes_img.id) {
                // lus si log2(taille du pixel) + lfil2.w < lfil3.x ; meme calcul que la 2e octave du Classique
                const float dmax = std::exp2(lp.lfil3[0] - lp.lfil2[3]) / lp.res[3];
                for (int i = 0; i < nlas_cpu && fogv == 4; i++) {
                    const LaserSegment& g = lasers->segs[i];
                    const float ch = std::cos(g.half_angle), sh = std::sin(g.half_angle), Rf = g.range / std::max(ch, 1e-3f);
                    const vec3 a = g.src, b = g.src + (g.ec * ch - g.es * sh) * Rf, c = g.src + (g.ec * ch + g.es * sh) * Rf;
                    if (length(closest_on_triangle(cam.pos, a, b, c) - cam.pos) < dmax) fogv = 5;
                }
            }
        } else {
            fogv = (rs.laser_volutes && volutes_img.id) ? 2 : (rs.laser_room_fog || rs.laser_fwd_lobe) ? 1 : 0;
        }
        if (fogv == 2 && rs.laser_vol_fine) {
            // lue si log2(taille du pixel) + lvol4.x < lvol4.y ; un pixel a la distance d couvre au moins d x angle
            const float dmax = std::exp2(lp.lvol4[1] - lp.lvol4[0]) / lp.res[3];
            for (int i = 0; i < nlas_cpu && fogv == 2; i++) {
                const LaserSegment& g = lasers->segs[i];
                const float ch = std::cos(g.half_angle), sh = std::sin(g.half_angle), Rf = g.range / std::max(ch, 1e-3f);
                const vec3 a = g.src, b = g.src + (g.ec * ch - g.es * sh) * Rf, c = g.src + (g.ec * ch + g.es * sh) * Rf;
                if (length(closest_on_triangle(cam.pos, a, b, c) - cam.pos) < dmax) fogv = 3;
            }
        }
    }
    stats.laser_fog_variant = fogv;
    gpuprof::frame_begin();
    gpuprof::mark("envois CPU -> GPU");
    sg_write_buffer_desc wb = {};
    wb.src.data = {light_data.data(), (size_t)std::max(1, num_lights) * sizeof(sb_light_t)};
    wb.dst.buffer = light_buf;
    sg_write_buffer_transient(&wb);
    wb.src.data = {pimg_desc.data(), (size_t)std::max(1, num_lights) * 4 * sizeof(float)};
    wb.dst.buffer = pimg_desc_buf;
    sg_write_buffer_transient(&wb);
    wb.src.data = {occ_light_data.data(), (size_t)std::max(1, num_lights) * sizeof(sb_occ_t)};
    wb.dst.buffer = occ_light_buf;
    sg_write_buffer_transient(&wb);
    if (occ_pairs > 0) {
        wb.src.data = {occ_plane_data.data(), (size_t)occ_pairs * OCC_BLOCK * sizeof(sb_vec4_t)};
        wb.dst.buffer = occ_plane_buf;
        sg_write_buffer_transient(&wb);
    }
    wb.src.data = {occ_tile_data.data(), occ_tile_data.size() * sizeof(uint32_t)};
    wb.dst.buffer = occ_tile_buf;
    sg_write_buffer_transient(&wb);
    if (!pimg_dirty.empty()) {
        wb.src.data = {pimg_dirty.data(), pimg_dirty.size() * sizeof(uint32_t)};
        wb.dst.buffer = pimg_list_buf;
        sg_write_buffer_transient(&wb);
    }
    if (rs.volumetrics && num_lights > 0) {
        wb.src.data = {beam_order.data(), beam_order.size() * sizeof(uint32_t)};
        wb.dst.buffer = beam_list_buf;
        sg_write_buffer_transient(&wb);
    }
    if (analytic) {
        wb.src.data = {btab_data.data(), (size_t)num_lights * sizeof(sb_btab_t)};
        wb.dst.buffer = btab_buf;
        sg_write_buffer_transient(&wb);
        if (!btab_jobs.empty()) {
            wb.src.data = {btab_jobs.data(), btab_jobs.size() * sizeof(uint32_t)};
            wb.dst.buffer = btab_job_buf;
            sg_write_buffer_transient(&wb);
        }
    }
    if (!beam_order_m.empty()) {
        wb.src.data = {beam_order_m.data(), beam_order_m.size() * sizeof(uint32_t)};
        wb.dst.buffer = beam_list_buf_m;
        sg_write_buffer_transient(&wb);
    }
    if (mirror_an && !beam_order_m.empty()) {
        wb.src.data = {btab_data_m.data(), (size_t)num_lights * sizeof(sb_btab_t)};
        wb.dst.buffer = btab_buf_m;
        sg_write_buffer_transient(&wb);
        if (!btab_jobs_m.empty()) {
            wb.src.data = {btab_jobs_m.data(), btab_jobs_m.size() * sizeof(uint32_t)};
            wb.dst.buffer = btab_job_buf_m;
            sg_write_buffer_transient(&wb);
        }
    }
    if (nlas > 0) {
        wb.src.data = {laser_data.data(), (size_t)nlas * sizeof(sb_laser_t)};
        wb.dst.buffer = laser_buf;
        sg_write_buffer_transient(&wb);
    }
    if (mirror_las) {
        wb.src.data = {laser_data_m.data(), (size_t)nlas * sizeof(sb_laser_t)};
        wb.dst.buffer = laser_buf_m;
        sg_write_buffer_transient(&wb);
    }
    if (nexits_m > 0) {
        wb.src.data = {laser_exit_data_m.data(), (size_t)nexits_m * sizeof(sb_hit_t)};
        wb.dst.buffer = laser_exit_buf_m;
        sg_write_buffer_transient(&wb);
    }
    if (hit_pass) {
        wb.src.data = {laser_hit_data.data(), (size_t)nhits * sizeof(sb_hit_t)};
        wb.dst.buffer = laser_hit_buf;
        sg_write_buffer_transient(&wb);
    }
    if (nexits > 0) {
        wb.src.data = {laser_exit_data.data(), (size_t)nexits * sizeof(sb_hit_t)};
        wb.dst.buffer = laser_exit_buf;
        sg_write_buffer_transient(&wb);
    }
    if (rs.gi) {
        wb.src.data = {vpl_data.data(), (size_t)std::max(1, num_vpls) * sizeof(sb_vpl_t)};
        wb.dst.buffer = vpl_buf;
        sg_write_buffer_transient(&wb);
    }
    const int ndc_up = std::min((int)dyn_cubes.size(), MAX_DYN), ndy_up = std::min((int)dyn_cyls.size(), MAX_DYN);
    if (ndc_up > 0) {
        wb.src.data = {dyn_cubes.data(), (size_t)ndc_up * sizeof(Instance)};
        wb.dst.buffer = dyn_cube_buf;
        sg_write_buffer_transient(&wb);
    }
    if (ndy_up > 0) {
        wb.src.data = {dyn_cyls.data(), (size_t)ndy_up * sizeof(Instance)};
        wb.dst.buffer = dyn_cyl_buf;
        sg_write_buffer_transient(&wb);
    }
    if (rs.volumetrics || fogv >= 1) {   // amas de fumee : faisceaux des lyres et lasers
        sg_write_image_desc wi = {};
        wi.src.data = {fog.upload.data(), fog.upload.size()};
        wi.dst.image = fog_img;
        sg_write_image_transient(&wi);
    }

    // ---- 1-3 : passes de calcul -------------------------------------------------------------
    cull_params_t cp = {};
    set4(cp.cam_pos, cam.pos, (float)num_lights);
    set4(cp.cam_right, cam.right, tanX);
    set4(cp.cam_up, cam.up, tanY);
    set4(cp.cam_fwd, cam.fwd, 0);
    set4(cp.grid, (float)CL_X, (float)CL_Y, (float)CL_Z, near_cluster);
    set4(cp.grid2, far_cluster, 0, crowd_on ? (float)rs.crowd_soft : 0.0f, 0);
    // atlas des images projetees : en couleur avec l'aberration chromatique (cree a la premiere activation)
    float chp[4];
    rs.chroma_params(chp);
    const bool chroma_on = chp[3] > 0.5f;
    if (chroma_on && pimg_img_rgb.id == SG_INVALID_ID) {
        sg_image_desc d = {};
        d.width = PIMG_ATLAS_W;
        d.height = PIMG_ATLAS_H;
        d.pixel_format = SG_PIXELFORMAT_RGBA16F;
        d.usage.storage_image = true;
        d.label = "pattern-images-rgb";
        pimg_img_rgb = sg_make_image(&d);
        sg_view_desc vd = {};
        vd.storage_image.image = pimg_img_rgb;
        pimg_store_rgb = sg_make_view(&vd);
        pimg_tex_rgb = texture_view(pimg_img_rgb);
    }
    const sg_view pimg_t = chroma_on ? pimg_tex_rgb : pimg_tex;
    gpuprof::mark("calcul : tri + sondes");
    {
        sg_pass pass = {};
        pass.compute = true;
        pass.label = "compute";
        sg_begin_pass(&pass);
        sg_bindings b = {};
        b.views[VIEW_lights_cs] = light_view;
        if (rs.surface_lights) {
            sg_apply_pipeline(pip_cull_clusters);
            b.views[VIEW_clusters_rw] = cluster_view;
            b.views[VIEW_occ_lights_cs] = occ_light_view;
            b.views[VIEW_occ_planes_cs] = occ_plane_view;
            b.views[VIEW_occ_tiles_cs] = occ_tile_view;
            sg_apply_bindings(&b);
            sg_apply_uniforms(UB_cull_params, SG_RANGE_REF(cp));
            sg_dispatch((CL_X * CL_Y * CL_Z + 63) / 64, 1, 1);
            if (mirror) {
                cull_params_t cpm = cp;
                cpm.grid2[1] = 1.0f;   // rectangles d'ombre de la camera miroir
                set4(cpm.cam_pos, mcam.pos, (float)num_lights);
                set4(cpm.cam_right, mcam.right, tanX);
                set4(cpm.cam_up, mcam.up, tanY);
                set4(cpm.cam_fwd, mcam.fwd, 0);
                b.views[VIEW_clusters_rw] = cluster_view_m;
                sg_apply_bindings(&b);
                sg_apply_uniforms(UB_cull_params, SG_RANGE_REF(cpm));
                sg_dispatch((CL_X * CL_Y * CL_Z + 63) / 64, 1, 1);
            }
        }
        if (rs.gi) {
            probe_params_t pp = {};
            set4(pp.probe_min, probe_min, (float)num_vpls);
            set4(pp.probe_cell, probe_cell, 0);
            set4(pp.probe_dims, (float)PR_X, (float)PR_Y, (float)PR_Z, (float)(PR_X * PR_Y * PR_Z));
            sg_apply_pipeline(pip_probes);
            b = {};
            b.views[VIEW_vpls_ssbo] = vpl_view;
            b.views[VIEW_probe_a_w] = probe_store[0];
            b.views[VIEW_probe_b_w] = probe_store[1];
            b.views[VIEW_probe_c_w] = probe_store[2];
            sg_apply_bindings(&b);
            sg_apply_uniforms(UB_probe_params, SG_RANGE_REF(pp));
            sg_dispatch((PR_X * PR_Y * PR_Z + 63) / 64, 1, 1);
        }
        // Images projetees en cache : apres le tri et les sondes, qui n'en ont pas besoin (lancees avant,
        // elles retardaient le tri de 0,1 ms), avant les tables qui les lisent.
        if (!pimg_dirty.empty()) {
            gpuprof::mark("calcul : images projetees");
            sg_apply_pipeline(chroma_on ? pip_pattern_images_rgb : pip_pattern_images);
            b = {};
            b.views[VIEW_lights_cs] = light_view;
            b.views[VIEW_pimg_desc_cs] = pimg_desc_view;
            b.views[VIEW_pimg_list_cs] = pimg_list_view;
            b.views[VIEW_gobo_tex_ci] = gobo_view;
            if (chroma_on) b.views[VIEW_pimg_w_rgb] = pimg_store_rgb;
            else b.views[VIEW_pimg_w] = pimg_store;
            b.samplers[SMP_gobo_smp_ci] = gobo_smp;
            sg_apply_bindings(&b);
            pimg_params_t pp = {};
            rs.chroma_params(pp.chroma);
            sg_apply_uniforms(UB_pimg_params, SG_RANGE_REF(pp));
            sg_dispatch(PIMG_W / 8, PIMG_H / 8, (int)pimg_dirty.size());
        }
        if (analytic && !btab_jobs.empty()) {
            gpuprof::mark("calcul : tables fumee");
            sg_apply_pipeline(pip_beam_tables);
            const int njobs = (int)btab_jobs.size();
            const int gx = std::min(njobs, 16384), gy = (njobs + gx - 1) / gx;
            table_params_t tp = {};
            set4(tp.info, (float)njobs, (float)gx, 0, 0);
            b = {};
            b.views[VIEW_lights_cs] = light_view;
            b.views[VIEW_btabs_cs] = btab_view;
            b.views[VIEW_btab_jobs] = btab_job_view;
            b.views[VIEW_pimg_desc_tb] = pimg_desc_view;
            b.views[VIEW_pimg_tex_tb] = pimg_t;
            b.samplers[SMP_lin_clamp_tb] = lin_clamp;
            b.views[VIEW_gobo_tex_cs] = gobo_view;
            b.views[VIEW_table_w] = btab_store;
            b.samplers[SMP_gobo_smp_cs] = gobo_smp;
            sg_apply_bindings(&b);
            sg_apply_uniforms(UB_table_params, SG_RANGE_REF(tp));
            sg_dispatch(gx, gy, 1);
        }
        sg_end_pass();
    }

    // ---- 4 : geometrie --------------------------------------------------------------------
    const int ndc = std::min((int)dyn_cubes.size(), MAX_DYN), ndy = std::min((int)dyn_cyls.size(), MAX_DYN);
    scene_vs_params_t vsp;
    std::memcpy(vsp.view_proj, view_proj.m, sizeof(vsp.view_proj));
    if (rs.depth_prepass) {
        gpuprof::mark("pre-passe profondeur");
        sg_pass pass = {};
        pass.attachments.depth_stencil = depth.att;
        pass.action.depth.load_action = SG_LOADACTION_CLEAR;
        pass.action.depth.store_action = SG_STOREACTION_STORE;
        pass.action.depth.clear_value = 0.0f;
        pass.label = "depth-prepass";
        sg_begin_pass(&pass);
        sg_apply_pipeline(pip_depth);
        sg_apply_uniforms(UB_scene_vs_params, SG_RANGE_REF(vsp));
        auto draw = [&](sg_buffer vb, sg_buffer ib, int nidx, sg_buffer inst, int count) {
            if (count <= 0 || !inst.id) return;
            sg_bindings b = {};
            b.vertex_buffers[0] = vb;
            b.vertex_buffers[1] = inst;
            b.index_buffer = ib;
            sg_apply_bindings(&b);
            sg_draw(0, nidx, count);
        };
        draw(cube_vb, cube_ib, cube_indices, static_cubes, num_static_cubes);
        draw(cyl_vb, cyl_ib, cyl_indices, static_cyls, num_static_cyls);
        draw(cube_vb, cube_ib, cube_indices, dyn_cube_buf, ndc);
        draw(cyl_vb, cyl_ib, cyl_indices, dyn_cyl_buf, ndy);
        sg_end_pass();
    }
    gpuprof::mark("scene (surfaces)");
    {
        sg_pass pass = {};
        pass.attachments.colors[0] = scene_color.att;
        pass.attachments.colors[1] = scene_depth_lin.att;
        if (soft_pass || hit_pass) {   // normale et couleur : lyres douces, impacts des lasers
            pass.attachments.colors[2] = scene_normal.att;
            pass.attachments.colors[3] = scene_albedo.att;
            pass.action.colors[2].load_action = SG_LOADACTION_DONTCARE;
            pass.action.colors[3].load_action = SG_LOADACTION_DONTCARE;
        }
        pass.attachments.depth_stencil = depth.att;
        pass.action.colors[0].load_action = SG_LOADACTION_CLEAR;
        pass.action.colors[0].clear_value = {0, 0, 0, 1};
        pass.action.colors[1].load_action = SG_LOADACTION_CLEAR;
        pass.action.colors[1].clear_value = {1000.0f, 0, 0, 1};
        pass.action.depth.load_action = rs.depth_prepass ? SG_LOADACTION_LOAD : SG_LOADACTION_CLEAR;
        pass.action.depth.clear_value = 0.0f;
        pass.label = "scene";
        sg_begin_pass(&pass);
        const int wet = (floor_p[3] > 0.5f && floor_p[1] > 0.0f) ? 1 : 0;   // eau au sol : variante mouillee
        if (soft_pass || hit_pass) sg_apply_pipeline(rs.depth_prepass ? pip_scene_eq_gb[wet] : pip_scene_gb[wet]);
        else sg_apply_pipeline(rs.depth_prepass ? pip_scene_eq[wet] : pip_scene[wet]);
        scene_fs_params_t fsp = {};
        set4(fsp.cam_pos, cam.pos, (float)num_lights);
        set4(fsp.cam_fwd, cam.fwd, 2.0f * tanY / (float)h);
        std::memcpy(fsp.grid, cp.grid, sizeof(fsp.grid));
        std::memcpy(fsp.grid2, cp.grid2, sizeof(fsp.grid2));
        set4(fsp.res, (float)w, (float)h, 1.0f / PIMG_ATLAS_W, 1.0f / PIMG_ATLAS_H);
        set4(fsp.shade, sigma_ext, rs.gi_strength, rs.specular ? 1.0f : 0.0f, rs.ambient);
        set4(fsp.probe_min, probe_min, rs.gi ? 1.0f : 0.0f);
        set4(fsp.probe_cell, probe_cell, 0);
        set4(fsp.probe_dims, (float)PR_X, (float)PR_Y, (float)PR_Z, 0);
        std::memcpy(fsp.floor_p, floor_p, sizeof(fsp.floor_p));
        std::memcpy(fsp.floor_q, floor_q, sizeof(fsp.floor_q));
        std::memcpy(fsp.floor_w, floor_w, sizeof(fsp.floor_w));
        rs.chroma_params(fsp.chroma);
        if (!rs.surface_lights) fsp.cam_pos[3] = 0;   // pas d'eclairage direct
        sg_apply_uniforms(UB_scene_vs_params, SG_RANGE_REF(vsp));
        sg_apply_uniforms(UB_scene_fs_params, SG_RANGE_REF(fsp));

        auto draw = [&](sg_buffer vb, sg_buffer ib, int nidx, sg_buffer inst, int count) {
            if (count <= 0 || !inst.id) return;
            sg_bindings b = {};
            b.vertex_buffers[0] = vb;
            b.vertex_buffers[1] = inst;
            b.index_buffer = ib;
            b.views[VIEW_lights_ssbo] = light_view;
            b.views[VIEW_clusters_ro] = cluster_view;
            b.views[VIEW_probe_a] = probe_tex[0];
            b.views[VIEW_probe_b] = probe_tex[1];
            b.views[VIEW_probe_c] = probe_tex[2];
            b.views[VIEW_gobo_tex] = gobo_view;
            b.views[VIEW_pimg_desc_ro] = pimg_desc_view;
            b.views[VIEW_pimg_tex] = pimg_t;
            b.views[VIEW_floor_tex] = floor_view;
            if (wet) b.views[VIEW_floor_cav] = floor_cav_view;   // creux du beton : variante mouillee seulement
            b.views[VIEW_occ_lights_ro] = occ_light_view;
            b.views[VIEW_occ_planes_ro] = occ_plane_view;
            b.samplers[SMP_gobo_smp] = gobo_smp;
            b.samplers[SMP_lin_clamp_smp] = lin_clamp;
            b.samplers[SMP_floor_smp] = floor_smp;
            sg_apply_bindings(&b);
            sg_draw(0, nidx, count);
        };
        draw(cube_vb, cube_ib, cube_indices, static_cubes, num_static_cubes);
        draw(cyl_vb, cyl_ib, cyl_indices, static_cyls, num_static_cyls);
        draw(cube_vb, cube_ib, cube_indices, dyn_cube_buf, ndc);
        draw(cyl_vb, cyl_ib, cyl_indices, dyn_cyl_buf, ndy);
        sg_end_pass();
    }
    dyn_cubes.clear();
    dyn_cyls.clear();

    // ---- 4b : lyres douces sur les surfaces (1/4 de la resolution) -------------------------
    if (soft_pass) {
        gpuprof::mark("lyres douces (1/4)");
        sg_pass pass = {};
        // lyres superposees : eclairement par direction (4 cibles) ; lyres frost seules : variante legere (2)
        if (crowd_on) {
            pass.attachments.colors[0] = soft_r.att;
            pass.attachments.colors[1] = soft_g.att;
            pass.attachments.colors[2] = soft_b.att;
            pass.attachments.colors[3] = soft_spec.att;
            for (int k = 0; k < 4; k++) pass.action.colors[k].load_action = SG_LOADACTION_DONTCARE;
        } else {
            pass.attachments.colors[0] = soft_r.att;
            pass.attachments.colors[1] = soft_spec.att;
            for (int k = 0; k < 2; k++) pass.action.colors[k].load_action = SG_LOADACTION_DONTCARE;
        }
        pass.label = "soft-lights";
        sg_begin_pass(&pass);
        sg_apply_pipeline(crowd_on ? pip_soft : pip_soft_simple);
        soft_params_t sp = {};
        set4(sp.cam_pos, cam.pos, sigma_ext);
        set4(sp.cam_right, cam.right, tanX);
        set4(sp.cam_up, cam.up, tanY);
        set4(sp.cam_fwd, cam.fwd, 2.0f * tanY / (float)h);
        std::memcpy(sp.grid, cp.grid, sizeof(sp.grid));
        std::memcpy(sp.grid2, cp.grid2, sizeof(sp.grid2));
        set4(sp.res, (float)w, (float)h, (float)soft_w, (float)soft_h);
        set4(sp.shade, 1.0f / PIMG_ATLAS_W, 1.0f / PIMG_ATLAS_H, rs.specular ? 1.0f : 0.0f, 0);
        rs.chroma_params(sp.chroma);
        sg_bindings b = {};
        b.views[VIEW_lights_ssbo] = light_view;
        b.views[VIEW_clusters_ro] = cluster_view;
        b.views[VIEW_gobo_tex] = gobo_view;
        b.views[VIEW_depth_tex] = scene_depth_lin.tex;
        b.views[VIEW_normal_tex] = scene_normal.tex;
        b.views[VIEW_albedo_tex] = scene_albedo.tex;
        b.views[VIEW_pimg_desc_ro] = pimg_desc_view;
        b.views[VIEW_pimg_tex] = pimg_t;
        b.views[VIEW_occ_lights_ro] = occ_light_view;
        b.views[VIEW_occ_planes_ro] = occ_plane_view;
        b.samplers[SMP_gobo_smp] = gobo_smp;
        b.samplers[SMP_point_smp] = point_smp;
        b.samplers[SMP_lin_clamp_smp] = lin_clamp;
        sg_apply_bindings(&b);
        sg_apply_uniforms(UB_soft_params, SG_RANGE_REF(sp));
        sg_draw(0, 3, 1);
        sg_end_pass();
    }

    // ---- 4c : impacts des lasers sur les surfaces (ajoutes a l'image de la scene) ----------------
    if (hit_pass) {
        gpuprof::mark("lasers : impacts");
        sg_pass pass = {};
        pass.attachments.colors[0] = scene_color.att;
        pass.action.colors[0].load_action = SG_LOADACTION_LOAD;
        pass.label = "laser-hits";
        sg_begin_pass(&pass);
        sg_apply_pipeline(pip_laser_hit);
        hit_vs_params_t hv = {};
        std::memcpy(hv.view_proj, view_proj.m, sizeof(hv.view_proj));
        set4(hv.cam_pos, cam.pos, 2.0f * tanY / (float)h);
        set4(hv.cam_fwd, cam.fwd, 0.0f);
        set4(hv.beam, lp.beam[0], lp.beam[1], lp.beam[2], 0.0f);
        set4(hv.res, (float)w, (float)h, std::max(rs.laser_conv, 0.0f) * 1e-3f, 0.0f);
        hit_fs_params_t hf = {};
        set4(hf.conv, std::max(rs.laser_conv, 0.0f) * 1e-3f, 0.0f, 0.0f, 0.0f);
        set4(hf.cam_pos, cam.pos, sigma_ext);
        set4(hf.cam_right, cam.right, tanX);
        set4(hf.cam_up, cam.up, tanY);
        set4(hf.cam_fwd, cam.fwd, rs.laser_hit_gain);
        set4(hf.res, (float)w, (float)h, 2.0f * tanY / (float)h, std::max(rs.exposure, 1e-3f));
        set4(hf.beam, lp.beam[0], lp.beam[1], lp.beam[2], std::max(rs.laser_white, 0.0f));
        sg_bindings b = {};
        b.views[VIEW_hits_vs] = laser_hit_view;
        b.views[VIEW_hits_fs] = laser_hit_view;
        b.views[VIEW_hit_depth] = scene_depth_lin.tex;
        b.views[VIEW_hit_normal] = scene_normal.tex;
        b.views[VIEW_hit_albedo] = scene_albedo.tex;
        b.samplers[SMP_hit_smp] = point_smp;
        sg_apply_bindings(&b);
        sg_apply_uniforms(UB_hit_vs_params, SG_RANGE_REF(hv));
        sg_apply_uniforms(UB_hit_fs_params, SG_RANGE_REF(hf));
        sg_draw(0, 6, nhits);
        sg_end_pass();
    }

    // ---- 5-6 : fumee ------------------------------------------------------------------------
    const int cur = hist_index, prev = hist_index ^ 1;
    if (rs.volumetrics && num_lights == 0 && stats.laser_vpls == 0) {
        // Aucune lyre allumee (PLAN-OPTIM-LASERS.md, 0.9) : pas de faisceau, et la lumiere indirecte de la fumee est nulle (ses
        // sources, les VPL, viennent des lyres, ou des lasers avec laser_gi) ; l'accumulation, bornee au voisinage de l'image
        // courante, rendrait alors exactement (0, 0, 0, 1) des la premiere image. On l'ecrit directement (meme image, meme
        // historique).
        gpuprof::mark("fumee : faisceaux");
        sg_pass pass = {};
        pass.attachments.colors[0] = vol_hist[cur].att;
        pass.action.colors[0].load_action = SG_LOADACTION_CLEAR;
        pass.action.colors[0].clear_value = {0, 0, 0, 1};
        pass.label = "temporal-off";
        sg_begin_pass(&pass);
        sg_end_pass();
        hist_valid = true;
    } else if (rs.volumetrics) {
        gpuprof::mark("fumee : faisceaux");
        vol_params_t vp = {};
        const float wa = fs.wind_angle * DEG;
        const float drift = fs.animate ? time : 0.0f;
        set4(vp.cam_pos, cam.pos, time);
        set4(vp.cam_right, cam.right, tanX);
        set4(vp.cam_up, cam.up, tanY);
        set4(vp.cam_fwd, cam.fwd, (float)(frame % 1024));
        set4(vp.res, (float)vw, (float)vh, (float)w, (float)h);
        set4(vp.fog0, fs.density, fs.haze, fs.smoke, clampf(fs.anisotropy, -0.95f, 0.95f));
        set4(vp.fog1, fs.detail_strength, 1.0f / std::max(fs.detail_scale, 0.5f), fs.height_falloff, fs.scattering);
        set4(vp.fog2, -std::cos(wa) * fs.wind_speed * drift / std::max(fs.detail_scale, 0.5f), -0.02f * drift,
             -std::sin(wa) * fs.wind_speed * drift / std::max(fs.detail_scale, 0.5f), rs.gi_fog * rs.gi_strength);
        set4(vp.fog_box_min, fog.origin, sigma_ext);
        set4(vp.fog_box_inv, 1.0f / fog.size.x, 1.0f / fog.size.y, 1.0f / fog.size.z, 0);
        set4(vp.tiles, 1.0f / BTAB_W, 1.0f / BTAB_H, (float)std::clamp(rs.vol_samples, 1, 32) * (analytic ? std::max(quality, 0.5f) : 1.0f),
             2.0f * tanY / (float)vh);
        set4(vp.probe_min, probe_min, rs.gi ? 1.0f : 0.0f);
        set4(vp.probe_cell, probe_cell, 0);
        set4(vp.probe_dims, (float)PR_X, (float)PR_Y, (float)PR_Z, 0);
        sg_bindings b = {};

        // faisceaux d'un niveau de resolution (cones en instances)
        double frags = 0;
        auto draw_beams = [&](int tier, int tw, int th) {
            if (tier_num[tier] <= 0) return;
            sg_apply_pipeline(analytic ? pip_beams_an : pip_beams);
            beam_vs_params_t bvp = {};
            std::memcpy(bvp.view_proj, view_proj.m, sizeof(bvp.view_proj));
            set4(bvp.info, (float)tier_first[tier], 0, 0, 0);
            vol_params_t tvp = vp;
            set4(tvp.res, (float)tw, (float)th, (float)w, (float)h);
            // flou d'anti-crenelage de la taille d'un pixel de la fumee, pas de ce niveau : a 1/2 ou 1/4, un flou
            // plus large deborde de l'enveloppe du cone et y est coupe net (marches droites depuis la lentille)
            tvp.tiles[3] = 2.0f * tanY / (float)vh;
            sg_bindings bb = {};
            bb.vertex_buffers[0] = cone_vb;
            bb.index_buffer = cone_ib;
            bb.views[VIEW_lights_vs] = light_view;
            bb.views[VIEW_beam_list_vs] = beam_list_view;
            bb.views[VIEW_lights_ssbo] = light_view;
            if (analytic) {
                bb.views[VIEW_btabs_ro] = btab_view;
                bb.views[VIEW_table_tex] = btab_tex;
            } else {
                bb.views[VIEW_gobo_tex] = gobo_view;
                bb.samplers[SMP_gobo_smp] = gobo_smp;
            }
            bb.views[VIEW_depth_tex] = scene_depth_lin.tex;
            bb.views[VIEW_occ_lights_ro] = occ_light_view;
            bb.views[VIEW_occ_planes_ro] = occ_plane_view;
            bb.views[VIEW_occ_tiles_ro] = occ_tile_view;
            bb.views[VIEW_beam_mask_tex] = refl_beam_mask.tex;   // masque des faisceaux du reflet (lu par la camera miroir seulement)
            bb.views[VIEW_fog_tex] = fog_view;
            bb.views[VIEW_detail_tex] = detail_view;
            bb.samplers[SMP_point_smp] = point_smp;
            bb.samplers[SMP_lin_clamp_smp] = lin_clamp;
            bb.samplers[SMP_lin_repeat_smp] = lin_repeat;
            sg_apply_bindings(&bb);
            sg_apply_uniforms(UB_beam_vs_params, SG_RANGE_REF(bvp));
            sg_apply_uniforms(UB_vol_params, SG_RANGE_REF(tvp));
            sg_draw(0, cone_indices, tier_num[tier]);
        };
        gpuprof::stats_begin();
        if (tier_num[1] > 0 || tier_num[2] > 0) gpuprof::mark("fumee : faisceaux 1/2 et 1/4");
        const bool tier_used[3] = {true, tier_num[1] > 0, tier_num[2] > 0};
        for (int t = 1; t <= 2; t++) {
            sg_pass tp = {};
            tp.attachments.colors[0] = vol_tier[t - 1].att;
            tp.action.colors[0].load_action = SG_LOADACTION_CLEAR;
            tp.action.colors[0].clear_value = {0, 0, 0, 0};
            tp.label = "volume-tier";
            if (!tier_used[t]) continue;
            sg_begin_pass(&tp);
            draw_beams(t, tier_w[t - 1], tier_h[t - 1]);
            sg_end_pass();
        }

        if (tier_used[1] || tier_used[2]) gpuprof::mark("fumee : faisceaux pleine res.");
        sg_pass pass = {};
        pass.attachments.colors[0] = vol_cur.att;
        pass.action.colors[0].load_action = SG_LOADACTION_CLEAR;
        pass.action.colors[0].clear_value = {0, 0, 0, 1};
        pass.label = "volume";
        sg_begin_pass(&pass);
        if (rs.gi) {
            // fond : lumiere indirecte diffusee par la fumee (a la resolution de la fumee : plus bas,
            // les volutes de la brume deviennent des taches)
            sg_apply_pipeline(pip_vol_ambient);
            b = {};
            b.views[VIEW_probe_a] = probe_tex[0];
            b.views[VIEW_depth_tex] = scene_depth_lin.tex;
            b.views[VIEW_fog_tex] = fog_view;
            b.views[VIEW_detail_tex] = detail_view;
            b.samplers[SMP_point_smp] = point_smp;
            b.samplers[SMP_lin_clamp_smp] = lin_clamp;
            b.samplers[SMP_lin_repeat_smp] = lin_repeat;
            sg_apply_bindings(&b);
            sg_apply_uniforms(UB_vol_params, SG_RANGE_REF(vp));
            sg_draw(0, 3, 1);
        }
        draw_beams(0, vw, vh);
        gpuprof::stats_end();
        (void)frags;
        if (tier_used[1] || tier_used[2]) {
            // ajout des faisceaux calcules a plus basse resolution
            sg_apply_pipeline(pip_vol_merge);
            merge_params_t mp = {};
            set4(mp.res, (float)vw, (float)vh, (float)w, (float)h);
            set4(mp.t1, (float)tier_w[0], (float)tier_h[0], tier_used[1] ? 1.0f : 0.0f, 0);
            set4(mp.t2, (float)tier_w[1], (float)tier_h[1], tier_used[2] ? 1.0f : 0.0f, 0);
            b = {};
            b.views[VIEW_depth_tex] = scene_depth_lin.tex;
            b.views[VIEW_vol_t1_tex] = vol_tier[0].tex;
            b.views[VIEW_vol_t2_tex] = vol_tier[1].tex;
            b.samplers[SMP_point_smp] = point_smp;
            sg_apply_bindings(&b);
            sg_apply_uniforms(UB_merge_params, SG_RANGE_REF(mp));
            sg_draw(0, 3, 1);
        }
        sg_end_pass();

        // accumulation
        gpuprof::mark("fumee : accumulation");
        pass = {};
        pass.attachments.colors[0] = vol_hist[cur].att;
        pass.action.colors[0].load_action = SG_LOADACTION_DONTCARE;
        pass.label = "temporal";
        sg_begin_pass(&pass);
        sg_apply_pipeline(pip_temporal);
        temporal_params_t tp = {};
        std::memcpy(tp.prev_view_proj, prev_view_proj.m, sizeof(tp.prev_view_proj));
        set4(tp.cam_pos, cam.pos, 0);
        set4(tp.cam_right, cam.right, tanX);
        set4(tp.cam_up, cam.up, tanY);
        set4(tp.cam_fwd, cam.fwd, (rs.temporal && hist_valid) ? clampf(rs.temporal_weight, 0, 0.98f) : 0.0f);
        set4(tp.res, (float)vw, (float)vh, (float)w, (float)h);
        b = {};
        b.views[VIEW_depth_tex] = scene_depth_lin.tex;
        b.views[VIEW_vol_cur_tex] = vol_cur.tex;
        b.views[VIEW_vol_hist_tex] = vol_hist[prev].tex;
        b.samplers[SMP_point_smp] = point_smp;
        b.samplers[SMP_lin_clamp_smp] = lin_clamp;
        sg_apply_bindings(&b);
        sg_apply_uniforms(UB_temporal_params, SG_RANGE_REF(tp));
        sg_draw(0, 3, 1);
        sg_end_pass();
        hist_valid = true;
    } else {
        hist_valid = false;
    }

    // ---- 6a : lasers, tuiles en calcul -----------------------------------------------------------
    if (laser_tiles) {
        gpuprof::mark("lasers : tri par tuiles");
        sg_pass pass = {};
        pass.compute = true;
        pass.label = "lasers";
        sg_begin_pass(&pass);
        // compteurs de mesure (LASER_STATS) : exposition et blanchiment (saturation de l'image finale)
        lp.lmixb3[1] = std::max(rs.exposure, 1e-3f);
        lp.lmixb3[2] = std::max(rs.laser_white, 0.0f);
        const bool counted = gpuprof::stats_enabled() && fogv >= 4;
        const laser_cs_params_t& lcp = lp;
        sg_apply_pipeline(pip_laser_setup);
        sg_bindings b = {};
        b.views[VIEW_lasers_cs] = laser_view;
        b.views[VIEW_laser_scr_rw] = laser_scr_view;
        b.views[VIEW_laser_stats_rw] = laser_stats_view;
        sg_apply_bindings(&b);
        sg_apply_uniforms(UB_laser_cs_params, SG_RANGE_REF(lcp));
        sg_dispatch((nlas + 63) / 64, 1, 1);
        sg_apply_pipeline(pip_laser_bin);
        b = {};
        b.views[VIEW_laser_scr_ro] = laser_scr_view;
        b.views[VIEW_laser_stats_rw] = laser_stats_view;
        b.views[VIEW_laser_ccount_rw] = laser_ccount_view;
        b.views[VIEW_laser_clist_rw] = laser_clist_view;
        sg_apply_bindings(&b);
        sg_apply_uniforms(UB_laser_cs_params, SG_RANGE_REF(lcp));
        sg_dispatch(lctx, lcty, 1);
        // Nappes coniques (arcs) d'abord, dans leur passe et leur image (leur long calcul ralentissait aussi les
        // eventails quand il etait dans la meme boucle) ; la passe principale ajoute cette image (cam_pos.w = 1).
        laser_cs_params_t lcp_main = lp;
        lcp_main.cam_pos[3] = laser_arcs ? 1.0f : 0.0f;
        for (int pass_arcs = laser_arcs ? 1 : 0; pass_arcs >= 0; pass_arcs--) {
            if (pass_arcs) gpuprof::mark("lasers : arcs");
            else gpuprof::mark("lasers : fumee");
            // convergence RGB : variante avec son code seulement si l'ecart est regle et qu'un segment a des couleurs melangees
            if (counted) sg_apply_pipeline(pip_laser_shade_s[laser_grad ? 1 : 0][fogv - 4][pass_arcs ? 2 : laser_conv_used ? 1 : 0]);
            else if (!pass_arcs && laser_conv_used) sg_apply_pipeline(pip_laser_shade_c[laser_grad ? 1 : 0][fogv]);
            else sg_apply_pipeline(pip_laser_shade[laser_grad ? 1 : 0][fogv][pass_arcs]);
            b = {};
            b.views[VIEW_lasers_cs] = laser_view;
            b.views[VIEW_laser_scr_ro] = laser_scr_view;
            b.views[VIEW_laser_stats_rw] = laser_stats_view;
            b.views[VIEW_laser_ccount_ro] = laser_ccount_view;
            b.views[VIEW_laser_clist_ro] = laser_clist_view;
            b.views[VIEW_laser_depth_cs] = scene_depth_lin.tex;
            if (fogv >= 1) b.views[VIEW_laser_fog_tex] = fog_view;
            if (fogv >= 2) {
                b.views[VIEW_laser_vol_tex] = fogv >= 4 ? clouds_view : volutes_view;
                if (fogv == 5) b.views[VIEW_laser_fil_tex] = volutes_view;
                b.samplers[SMP_laser_vol_smp] = volutes_smp;
            }
            b.views[VIEW_laser_w] = pass_arcs ? laser_arc_store : laser_store;
            if (!pass_arcs) b.views[VIEW_laser_arc_in] = laser_arc_tex;
            b.samplers[SMP_laser_smp_cs] = point_smp;
            b.samplers[SMP_laser_lin_clamp] = lin_clamp;
            sg_apply_bindings(&b);
            sg_apply_uniforms(UB_laser_cs_params, SG_RANGE_REF(lcp_main));
            sg_dispatch(stats.laser_tiles_x, stats.laser_tiles_y, 1);
            if (pass_arcs) {
                // l'image des arcs, ecrite, sera lue : nouvelle passe (Direct3D 11 : vue d'ecriture detachee)
                sg_end_pass();
                sg_begin_pass(&pass);
            }
        }
        sg_end_pass();
        if (gpuprof::stats_enabled()) {
            unsigned c[16];
            if (gpuprof::readback_u32x16(laser_stats_buf, c)) {
                stats.laser_tile_pairs = (double)c[0];
                stats.laser_tile_max = (int)c[1];
                stats.laser_tiles_hit = (int)c[2];
                stats.laser_bin_overflow = (int)c[3];
                for (int k = 0; k < 2; k++) {
                    stats.laser_lit[k] = (double)c[k ? 12 : 4];
                    stats.laser_drown1[k] = (double)c[k ? 13 : 5];
                    stats.laser_drown2[k] = (double)c[k ? 14 : 6];
                    stats.laser_small[k] = (double)c[k ? 15 : 7];
                }
                stats.laser_fan_lit = (double)c[8];
                stats.laser_fan_interp = (double)c[9];
                stats.laser_fan_err1 = (double)c[10];
                stats.laser_fan_err5 = (double)c[11];
                stats.laser_counted = counted;
            }
        }
        // lasers a resolution reduite (2.1) : agrandis a la pleine resolution, en tenant compte de la profondeur
        if (laser_lo) {
            gpuprof::mark("lasers : agrandissement");
            sg_pass up = {};
            up.attachments.colors[0] = laser_up.att;
            up.action.colors[0].load_action = SG_LOADACTION_DONTCARE;
            up.label = "laser-up";
            sg_begin_pass(&up);
            sg_apply_pipeline(pip_laser_up);
            laser_up_params_t upp = {};
            set4(upp.res, (float)w, (float)h, (float)lw, (float)lh);
            sg_bindings ub = {};
            ub.views[VIEW_laser_lo_tex] = laser_tex;
            ub.views[VIEW_up_depth_tex] = scene_depth_lin.tex;
            ub.samplers[SMP_up_point_smp] = point_smp;
            sg_apply_bindings(&ub);
            sg_apply_uniforms(UB_laser_up_params, SG_RANGE_REF(upp));
            sg_draw(0, 3, 1);
            sg_end_pass();
        }
        // halo des lasers : l'image des lasers reduite niveau par niveau (filtre du bloom), puis les niveaux ajoutes du plus
        // large au plus fin, chacun avec le poids laser_halo_size (plus de 1 : halo plus large). La composition l'ajoute.
        if (rs.laser_halo > 0.0f && num_lhalo > 0) {
            gpuprof::mark("lasers : halo");
            for (int i = 0; i < num_lhalo; i++) {
                sg_pass hp = {};
                hp.attachments.colors[0] = lhalo[i].att;
                hp.action.colors[0].load_action = SG_LOADACTION_DONTCARE;
                hp.label = "laser-halo-down";
                sg_begin_pass(&hp);
                sg_apply_pipeline(pip_bloom_down);
                const int sw = i == 0 ? w : lhalo_w[i - 1], sh = i == 0 ? h : lhalo_h[i - 1];
                bloom_params_t bp = {};
                set4(bp.texel, 1.0f / sw, 1.0f / sh, i == 0 ? 2.0f : 0.0f, 1.0f);   // 1re passe : reduction au quart
                sg_bindings hb = {};
                hb.views[VIEW_src_tex] = i == 0 ? (laser_lo ? laser_up.tex : laser_tex) : lhalo[i - 1].tex;
                hb.samplers[SMP_lin_clamp_smp] = lin_clamp;
                sg_apply_bindings(&hb);
                sg_apply_uniforms(UB_bloom_params, SG_RANGE_REF(bp));
                sg_draw(0, 3, 1);
                sg_end_pass();
            }
            for (int i = num_lhalo - 1; i >= 1; i--) {
                sg_pass hp = {};
                hp.attachments.colors[0] = lhalo[i - 1].att;
                hp.action.colors[0].load_action = SG_LOADACTION_LOAD;
                hp.label = "laser-halo-up";
                sg_begin_pass(&hp);
                sg_apply_pipeline(pip_bloom_up);
                bloom_params_t bp = {};
                set4(bp.texel, 1.0f / lhalo_w[i], 1.0f / lhalo_h[i], 0, std::max(rs.laser_halo_size, 0.0f));
                sg_bindings hb = {};
                hb.views[VIEW_src_tex] = lhalo[i].tex;
                hb.samplers[SMP_lin_clamp_smp] = lin_clamp;
                sg_apply_bindings(&hb);
                sg_apply_uniforms(UB_bloom_params, SG_RANGE_REF(bp));
                sg_draw(0, 3, 1);
                sg_end_pass();
            }
        }
    }

    // ---- 6b : reflet du sol mouille (camera miroir, demi-resolution) --------------------------
    if (mirror) {
        // seulement la partie de l'ecran ou le sol est visible
        const int sx0 = std::max(0, (int)((floor_rect[0] * 0.5f + 0.5f) * refl_w) - 2);
        const int sx1 = std::min(refl_w, (int)((floor_rect[2] * 0.5f + 0.5f) * refl_w) + 3);
        const int sy0 = std::max(0, (int)((0.5f - floor_rect[3] * 0.5f) * refl_h) - 2);   // origine en haut
        const int sy1 = std::min(refl_h, (int)((0.5f - floor_rect[1] * 0.5f) * refl_h) + 3);
        auto scissor = [&](int sw, int sh) {
            const float kx = (float)sw / refl_w, ky = (float)sh / refl_h;
            sg_apply_scissor_rect((int)(sx0 * kx), (int)(sy0 * ky), std::max(1, (int)std::ceil((sx1 - sx0) * kx) + 1),
                                  std::max(1, (int)std::ceil((sy1 - sy0) * ky) + 1), true);
        };
        if (mirror_an && !beam_order_m.empty() && !btab_jobs_m.empty()) {
            gpuprof::mark("reflet : tables");
            sg_pass pass = {};
            pass.compute = true;
            pass.label = "mirror-tables";
            sg_begin_pass(&pass);
            sg_apply_pipeline(pip_beam_tables);
            const int njobs = (int)btab_jobs_m.size();
            const int gx = std::min(njobs, 16384), gy = (njobs + gx - 1) / gx;
            table_params_t tp = {};
            set4(tp.info, (float)njobs, (float)gx, 0, 0);
            sg_bindings b = {};
            b.views[VIEW_lights_cs] = light_view;
            b.views[VIEW_btabs_cs] = btab_view_m;
            b.views[VIEW_btab_jobs] = btab_job_view_m;
            b.views[VIEW_pimg_desc_tb] = pimg_desc_view;
            b.views[VIEW_pimg_tex_tb] = pimg_t;
            b.samplers[SMP_lin_clamp_tb] = lin_clamp;
            b.views[VIEW_gobo_tex_cs] = gobo_view;
            b.views[VIEW_table_w] = btab_store;
            b.samplers[SMP_gobo_smp_cs] = gobo_smp;
            sg_apply_bindings(&b);
            sg_apply_uniforms(UB_table_params, SG_RANGE_REF(tp));
            sg_dispatch(gx, gy, 1);
            sg_end_pass();
        }
        // Masque : le reflet n'est calcule que la ou il y a de l'eau au sol (fs_refl_mask). Hors de l'eau,
        // profondeur au plus pres (la scene miroir y est rejetee avant le shader) et profondeur lineaire a 0
        // (les faisceaux du miroir s'arretent tout de suite).
        gpuprof::mark("reflet : masque");
        {
            sg_pass pass = {};
            pass.attachments.colors[0] = refl_beam_mask.att;
            pass.action.colors[0].load_action = SG_LOADACTION_CLEAR;
            pass.action.colors[0].clear_value = {0.0f, 0, 0, 1};
            pass.label = "mirror-mask";
            sg_begin_pass(&pass);
            sg_apply_pipeline(pip_refl_mask);
            scissor(refl_w, refl_h);
            refl_mask_params_t mp = {};
            set4(mp.cam_pos, cam.pos, 0);
            set4(mp.cam_right, cam.right, tanX);
            set4(mp.cam_up, cam.up, tanY);
            set4(mp.cam_fwd, cam.fwd, 0);
            set4(mp.res, (float)refl_w, (float)refl_h, (float)w, (float)h);
            std::memcpy(mp.floor_p, floor_p, sizeof(mp.floor_p));
            std::memcpy(mp.floor_w, floor_w, sizeof(mp.floor_w));
            sg_bindings b = {};
            b.views[VIEW_depth_tex] = scene_depth_lin.tex;
            b.views[VIEW_floor_cav] = floor_cav_view;
            b.samplers[SMP_point_smp] = point_smp;
            b.samplers[SMP_floor_smp] = floor_smp;
            sg_apply_bindings(&b);
            sg_apply_uniforms(UB_refl_mask_params, SG_RANGE_REF(mp));
            sg_draw(0, 3, 1);
            sg_end_pass();
        }
        {
            sg_pass pass = {};
            pass.attachments.colors[0] = refl_depth_lin.att;
            pass.attachments.depth_stencil = refl_depth.att;
            pass.action.colors[0].load_action = SG_LOADACTION_CLEAR;
            pass.action.colors[0].clear_value = {0.0f, 0, 0, 1};
            pass.action.depth.load_action = SG_LOADACTION_CLEAR;
            pass.action.depth.clear_value = 1.0f;
            pass.label = "mirror-block";
            sg_begin_pass(&pass);
            sg_apply_pipeline(pip_refl_block);
            scissor(refl_w, refl_h);
            sg_bindings b = {};
            b.views[VIEW_src_tex] = refl_beam_mask.tex;
            b.samplers[SMP_point_smp] = point_smp;
            sg_apply_bindings(&b);
            sg_draw(0, 3, 1);
            sg_end_pass();
        }
        gpuprof::mark("reflet : surfaces");
        {
            sg_pass pass = {};
            pass.attachments.colors[0] = refl_color.att;
            pass.attachments.colors[1] = refl_depth_lin.att;
            pass.attachments.depth_stencil = refl_depth.att;
            pass.action.colors[0].load_action = SG_LOADACTION_CLEAR;
            pass.action.colors[0].clear_value = {0, 0, 0, 1};
            pass.action.colors[1].load_action = SG_LOADACTION_LOAD;   // masque
            pass.action.depth.load_action = SG_LOADACTION_LOAD;       // masque
            pass.label = "mirror-scene";
            sg_begin_pass(&pass);
            sg_apply_pipeline(pip_scene[0]);   // le sol n'est pas vu par la camera miroir
            scissor(refl_w, refl_h);
            scene_vs_params_t mvsp;
            std::memcpy(mvsp.view_proj, view_proj_m.m, sizeof(mvsp.view_proj));
            scene_fs_params_t fsp = {};
            set4(fsp.cam_pos, mcam.pos, rs.surface_lights ? (float)num_lights : 0.0f);
            set4(fsp.cam_fwd, mcam.fwd, 2.0f * tanY / (float)refl_h);
            std::memcpy(fsp.grid, cp.grid, sizeof(fsp.grid));
            std::memcpy(fsp.grid2, cp.grid2, sizeof(fsp.grid2));
            set4(fsp.res, (float)refl_w, (float)refl_h, 1.0f / PIMG_ATLAS_W, 1.0f / PIMG_ATLAS_H);
            set4(fsp.shade, sigma_ext, rs.gi_strength, rs.specular ? 1.0f : 0.0f, rs.ambient);
            set4(fsp.probe_min, probe_min, rs.gi ? 1.0f : 0.0f);
            set4(fsp.probe_cell, probe_cell, 1.0f);   // toutes les lyres (pas de passe des lyres douces ici)
            rs.chroma_params(fsp.chroma);
            set4(fsp.probe_dims, (float)PR_X, (float)PR_Y, (float)PR_Z, 0);
            sg_apply_uniforms(UB_scene_vs_params, SG_RANGE_REF(mvsp));
            sg_apply_uniforms(UB_scene_fs_params, SG_RANGE_REF(fsp));
            auto draw = [&](sg_buffer vb, sg_buffer ib, int nidx, sg_buffer inst, int count, int first) {
                if (count - first <= 0 || !inst.id) return;
                sg_bindings b = {};
                b.vertex_buffers[0] = vb;
                b.vertex_buffers[1] = inst;
                b.vertex_buffer_offsets[1] = first * (int)sizeof(Instance);
                b.index_buffer = ib;
                b.views[VIEW_lights_ssbo] = light_view;
                b.views[VIEW_clusters_ro] = cluster_view_m;
                b.views[VIEW_probe_a] = probe_tex[0];
                b.views[VIEW_probe_b] = probe_tex[1];
                b.views[VIEW_probe_c] = probe_tex[2];
                b.views[VIEW_gobo_tex] = gobo_view;
                b.views[VIEW_pimg_desc_ro] = pimg_desc_view;
                b.views[VIEW_pimg_tex] = pimg_t;
                b.views[VIEW_floor_tex] = floor_view;
                b.views[VIEW_occ_lights_ro] = occ_light_view;
                b.views[VIEW_occ_planes_ro] = occ_plane_view;
                b.samplers[SMP_gobo_smp] = gobo_smp;
                b.samplers[SMP_lin_clamp_smp] = lin_clamp;
                b.samplers[SMP_floor_smp] = floor_smp;
                sg_apply_bindings(&b);
                sg_draw(0, nidx, count - first);
            };
            // le premier cube est le sol (scene.cpp) : la camera miroir est dessous, on le saute
            draw(cube_vb, cube_ib, cube_indices, static_cubes, num_static_cubes, 1);
            draw(cyl_vb, cyl_ib, cyl_indices, static_cyls, num_static_cyls, 0);
            draw(cube_vb, cube_ib, cube_indices, dyn_cube_buf, ndc, 0);
            draw(cyl_vb, cyl_ib, cyl_indices, dyn_cyl_buf, ndy, 0);
            sg_end_pass();
        }
        gpuprof::mark("reflet : faisceaux");
        {
            sg_pass pass = {};
            pass.attachments.colors[0] = refl_vol.att;
            pass.action.colors[0].load_action = SG_LOADACTION_CLEAR;
            pass.action.colors[0].clear_value = {0, 0, 0, 1};
            pass.label = "mirror-beams";
            sg_begin_pass(&pass);
            if (rs.volumetrics && !beam_order_m.empty()) {
                // calcul analytique avec les tables de la camera miroir (sinon par echantillons)
                sg_apply_pipeline(mirror_an ? pip_beams_an_m : pip_beams_m);
                scissor(refl_vw, refl_vh);
                const float wa = fs.wind_angle * DEG;
                const float drift = fs.animate ? time : 0.0f;
                vol_params_t vp = {};
                set4(vp.cam_pos, mcam.pos, time);
                set4(vp.cam_right, mcam.right, tanX);
                set4(vp.cam_up, mcam.up, tanY);
                set4(vp.cam_fwd, mcam.fwd, (float)(frame % 1024));
                set4(vp.res, (float)refl_vw, (float)refl_vh, (float)refl_w, (float)refl_h);
                set4(vp.fog0, fs.density, fs.haze, fs.smoke, clampf(fs.anisotropy, -0.95f, 0.95f));
                set4(vp.fog1, fs.detail_strength, 1.0f / std::max(fs.detail_scale, 0.5f), fs.height_falloff, fs.scattering);
                set4(vp.fog2, -std::cos(wa) * fs.wind_speed * drift / std::max(fs.detail_scale, 0.5f), -0.02f * drift,
                     -std::sin(wa) * fs.wind_speed * drift / std::max(fs.detail_scale, 0.5f), rs.gi_fog * rs.gi_strength);
                set4(vp.fog_box_min, fog.origin, sigma_ext);
                set4(vp.fog_box_inv, 1.0f / fog.size.x, 1.0f / fog.size.y, 1.0f / fog.size.z, 0);
                set4(vp.tiles, 1.0f / BTAB_W, 1.0f / BTAB_H, (float)std::clamp(rs.vol_samples, 1, 32) * (mirror_an ? std::max(quality, 0.5f) : 1.0f),
                     2.0f * tanY / (float)refl_vh);
                set4(vp.probe_min, probe_min, 0.0f);
                set4(vp.probe_cell, probe_cell, 1.0f);   // camera miroir (rectangles d'ombre)
                set4(vp.probe_dims, (float)PR_X, (float)PR_Y, (float)PR_Z, 0);
                beam_vs_params_t bvp = {};
                std::memcpy(bvp.view_proj, view_proj_m.m, sizeof(bvp.view_proj));
                set4(bvp.info, 0, 0, 0, 0);
                sg_bindings bb = {};
                bb.vertex_buffers[0] = cone_vb;
                bb.index_buffer = cone_ib;
                bb.views[VIEW_lights_vs] = light_view;
                bb.views[VIEW_beam_list_vs] = beam_list_view_m;
                bb.views[VIEW_lights_ssbo] = light_view;
                if (mirror_an) {
                    bb.views[VIEW_btabs_ro] = btab_view_m;
                    bb.views[VIEW_table_tex] = btab_tex;
                } else {
                    bb.views[VIEW_gobo_tex] = gobo_view;
                    bb.samplers[SMP_gobo_smp] = gobo_smp;
                }
                bb.views[VIEW_depth_tex] = refl_depth_lin.tex;
                bb.views[VIEW_occ_lights_ro] = occ_light_view;
                bb.views[VIEW_occ_planes_ro] = occ_plane_view;
                bb.views[VIEW_occ_tiles_ro] = occ_tile_view;
                bb.views[VIEW_beam_mask_tex] = refl_beam_mask.tex;   // masque des faisceaux du reflet (lu par la camera miroir seulement)
                bb.views[VIEW_fog_tex] = fog_view;
                bb.views[VIEW_detail_tex] = detail_view;
                bb.samplers[SMP_point_smp] = point_smp;
                bb.samplers[SMP_lin_clamp_smp] = lin_clamp;
                bb.samplers[SMP_lin_repeat_smp] = lin_repeat;
                sg_apply_bindings(&bb);
                sg_apply_uniforms(UB_beam_vs_params, SG_RANGE_REF(bvp));
                sg_apply_uniforms(UB_vol_params, SG_RANGE_REF(vp));
                sg_draw(0, cone_indices, (int)beam_order_m.size());
            }
            sg_end_pass();
        }
        // Lasers du reflet : la passe des lasers (6a) refaite depuis la camera miroir, a 1/4 (ou 1/2) de la resolution du
        // miroir, dans le coin de son image. Les grosses tuiles hors du sol a l'ecran n'ont aucun segment (rectangle de tri) ;
        // hors de l'eau, la profondeur du miroir est 0 : rien n'y est ajoute. Memes tampons de tri (la passe principale est
        // finie), sans la convergence RGB ni la 2e octave des volutes (reflet flou), image des arcs reprise.
        const int mlw = rs.refl_lasers >= 2 ? refl_w : refl_vw, mlh = rs.refl_lasers >= 2 ? refl_h : refl_vh;
        if (mirror_las) {
            gpuprof::mark("reflet : lasers");
            laser_cs_params_t lpm = lp;
            set4(lpm.cam_pos, mcam.pos, laser_arcs ? 1.0f : 0.0f);
            set4(lpm.cam_right, mcam.right, tanX);
            set4(lpm.cam_up, mcam.up, tanY);
            set4(lpm.cam_fwd, mcam.fwd, sigma_ext);
            set4(lpm.res, (float)mlw, (float)mlh, (float)nlas, 2.0f * tanY / (float)mlh);
            const int mtx = (mlw + 15) / 16, mty = (mlh + 15) / 16, mctx = (mlw + 127) / 128, mcty = (mlh + 127) / 128;
            set4(lpm.tiles, (float)mtx, (float)mty, (float)mctx, 0.0f);
            lpm.hall_min[3] = (float)refl_w / (float)mlw;   // profondeur du miroir (refl_w x refl_h) par pixel des lasers
            lpm.hall_max[3] = (float)refl_h / (float)mlh;
            lpm.lfog[3] = floor_rect[0];
            lpm.lroom2[1] = floor_rect[1];
            lpm.lroom2[2] = floor_rect[2];
            lpm.lroom2[3] = floor_rect[3];
            const int fogm = fogv == 3 ? 2 : (fogv == 5 ? 4 : fogv);
            sg_pass pass = {};
            pass.compute = true;
            pass.label = "mirror-lasers";
            sg_begin_pass(&pass);
            sg_apply_pipeline(pip_laser_setup);
            sg_bindings b = {};
            b.views[VIEW_lasers_cs] = laser_view_m;
            b.views[VIEW_laser_scr_rw] = laser_scr_view;
            b.views[VIEW_laser_stats_rw] = laser_stats_view;
            sg_apply_bindings(&b);
            sg_apply_uniforms(UB_laser_cs_params, SG_RANGE_REF(lpm));
            sg_dispatch((nlas + 63) / 64, 1, 1);
            sg_apply_pipeline(pip_laser_bin);
            b = {};
            b.views[VIEW_laser_scr_ro] = laser_scr_view;
            b.views[VIEW_laser_stats_rw] = laser_stats_view;
            b.views[VIEW_laser_ccount_rw] = laser_ccount_view;
            b.views[VIEW_laser_clist_rw] = laser_clist_view;
            sg_apply_bindings(&b);
            sg_apply_uniforms(UB_laser_cs_params, SG_RANGE_REF(lpm));
            sg_dispatch(mctx, mcty, 1);
            for (int pass_arcs = laser_arcs ? 1 : 0; pass_arcs >= 0; pass_arcs--) {
                sg_apply_pipeline(pip_laser_shade[laser_grad ? 1 : 0][fogm][pass_arcs]);
                b = {};
                b.views[VIEW_lasers_cs] = laser_view_m;
                b.views[VIEW_laser_scr_ro] = laser_scr_view;
                b.views[VIEW_laser_stats_rw] = laser_stats_view;
                b.views[VIEW_laser_ccount_ro] = laser_ccount_view;
                b.views[VIEW_laser_clist_ro] = laser_clist_view;
                b.views[VIEW_laser_depth_cs] = refl_depth_lin.tex;
                if (fogm >= 1) b.views[VIEW_laser_fog_tex] = fog_view;
                if (fogm >= 2) {
                    b.views[VIEW_laser_vol_tex] = fogm >= 4 ? clouds_view : volutes_view;
                    b.samplers[SMP_laser_vol_smp] = volutes_smp;
                }
                b.views[VIEW_laser_w] = pass_arcs ? laser_arc_store : refl_laser_store;
                if (!pass_arcs) b.views[VIEW_laser_arc_in] = laser_arc_tex;
                b.samplers[SMP_laser_smp_cs] = point_smp;
                b.samplers[SMP_laser_lin_clamp] = lin_clamp;
                sg_apply_bindings(&b);
                sg_apply_uniforms(UB_laser_cs_params, SG_RANGE_REF(lpm));
                sg_dispatch(mtx, mty, 1);
                if (pass_arcs) {
                    sg_end_pass();
                    sg_begin_pass(&pass);
                }
            }
            sg_end_pass();
        }
        gpuprof::mark("reflet : composition");
        {
            sg_pass pass = {};
            pass.attachments.colors[0] = refl_final.att;
            pass.action.colors[0].load_action = SG_LOADACTION_CLEAR;
            pass.action.colors[0].clear_value = {0, 0, 0, 1};
            pass.label = "mirror-compose";
            sg_begin_pass(&pass);
            sg_apply_pipeline(pip_refl_compose);
            scissor(refl_w, refl_h);
            refl_params_t rp = {};
            set4(rp.cam_right, mcam.right, tanX);
            set4(rp.cam_up, mcam.up, tanY);
            set4(rp.cam_fwd, mcam.fwd, rs.volumetrics ? sigma_ext : 0.0f);
            set4(rp.res, (float)refl_w, (float)refl_h, (float)refl_vw, (float)refl_vh);
            set4(rp.lasers, (float)mlw / (float)refl_w, (float)mlh / (float)refl_h, mirror_las ? 1.0f : 0.0f, 0.0f);
            sg_bindings b = {};
            b.views[VIEW_depth_tex] = refl_depth_lin.tex;
            b.views[VIEW_scene_tex] = refl_color.tex;
            b.views[VIEW_vol_hist_tex] = refl_vol.tex;
            b.views[VIEW_laser_tex] = refl_laser_tex;
            b.samplers[SMP_point_smp] = point_smp;
            b.samplers[SMP_lin_clamp_smp] = lin_clamp;
            sg_apply_bindings(&b);
            sg_apply_uniforms(UB_refl_params, SG_RANGE_REF(rp));
            sg_draw(0, 3, 1);
            // lueurs de sortie des lasers vues de la camera miroir (comme 7b : pas attenuees pixel par pixel, cachees par
            // ce qui est devant la source dans le miroir)
            if (nexits_m > 0) {
                sg_apply_pipeline(pip_laser_hit);
                hit_vs_params_t hv = {};
                std::memcpy(hv.view_proj, view_proj_m.m, sizeof(hv.view_proj));
                set4(hv.cam_pos, mcam.pos, 2.0f * tanY / (float)refl_h);
                set4(hv.cam_fwd, mcam.fwd, 0.0f);
                set4(hv.beam, lp.beam[0], lp.beam[1], lp.beam[2], 0.0f);
                set4(hv.res, (float)refl_w, (float)refl_h, 0.0f, 0.0f);
                hit_fs_params_t hf = {};
                set4(hf.cam_pos, mcam.pos, rs.volumetrics ? sigma_ext : 0.0f);
                set4(hf.cam_right, mcam.right, tanX);
                set4(hf.cam_up, mcam.up, tanY);
                set4(hf.cam_fwd, mcam.fwd, 1.0f);
                set4(hf.res, (float)refl_w, (float)refl_h, 2.0f * tanY / (float)refl_h, std::max(rs.exposure, 1e-3f));
                set4(hf.beam, lp.beam[0], lp.beam[1], lp.beam[2], std::max(rs.laser_white, 0.0f));
                sg_bindings hb = {};
                hb.views[VIEW_hits_vs] = laser_exit_view_m;
                hb.views[VIEW_hits_fs] = laser_exit_view_m;
                hb.views[VIEW_hit_depth] = refl_depth_lin.tex;
                hb.views[VIEW_hit_normal] = scene_normal.tex;   // pas lues par les lueurs de sortie
                hb.views[VIEW_hit_albedo] = scene_albedo.tex;
                hb.samplers[SMP_hit_smp] = point_smp;
                sg_apply_bindings(&hb);
                sg_apply_uniforms(UB_hit_vs_params, SG_RANGE_REF(hv));
                sg_apply_uniforms(UB_hit_fs_params, SG_RANGE_REF(hf));
                sg_draw(0, 6, nexits_m);
            }
            sg_end_pass();
        }
        // reflet flou du beton mouille : pyramide du reflet (fs_refl_down), seulement sous le sol a l'ecran
        if (floor_p[2] > 0.0f || floor_w[3] > 0.0f) {
            gpuprof::mark("reflet : flou");
            for (int i = 0; i < refl_blur_n; i++) {
                const int lw_ = std::max(1, refl_blur_w >> i), lh_ = std::max(1, refl_blur_h >> i);
                sg_pass pass = {};
                pass.attachments.colors[0] = refl_blur_att[i];
                pass.action.colors[0].load_action = SG_LOADACTION_CLEAR;
                pass.action.colors[0].clear_value = {0, 0, 0, 0};
                pass.label = "mirror-blur";
                sg_begin_pass(&pass);
                sg_apply_pipeline(pip_refl_down);
                scissor(lw_, lh_);
                refl_down_params_t dp = {};
                const int sw = i == 0 ? refl_w : std::max(1, refl_blur_w >> (i - 1)), sh = i == 0 ? refl_h : std::max(1, refl_blur_h >> (i - 1));
                set4(dp.texel, 1.0f / sw, 1.0f / sh, i == 0 ? 1.0f : 0.0f, 0.0f);
                sg_bindings b = {};
                b.views[VIEW_src_tex] = i == 0 ? refl_final.tex : refl_blur_lvl[i - 1];
                b.views[VIEW_depth_tex] = refl_depth_lin.tex;
                b.samplers[SMP_point_smp] = point_smp;
                b.samplers[SMP_lin_clamp_smp] = lin_clamp;
                sg_apply_bindings(&b);
                sg_apply_uniforms(UB_refl_down_params, SG_RANGE_REF(dp));
                sg_draw(0, 3, 1);
                sg_end_pass();
            }
        }
    }

    // ---- 7 : composition --------------------------------------------------------------------
    gpuprof::mark("composition");
    {
        sg_pass pass = {};
        pass.attachments.colors[0] = combined.att;
        pass.action.colors[0].load_action = SG_LOADACTION_DONTCARE;
        pass.label = "composite";
        sg_begin_pass(&pass);
        sg_apply_pipeline(pip_composite);
        composite_params_t cpp = {};
        set4(cpp.cam_right, cam.right, tanX);
        set4(cpp.cam_up, cam.up, tanY);
        set4(cpp.cam_fwd, cam.fwd, rs.volumetrics ? sigma_ext : 0.0f);
        set4(cpp.res, (float)w, (float)h, (float)vw, (float)vh);
        set4(cpp.opts, rs.volumetrics ? 1.0f : 0.0f, soft_pass ? (crowd_on ? 2.0f : 1.0f) : 0.0f, (float)soft_w, (float)soft_h);
        set4(cpp.cam_pos, cam.pos, mirror ? 1.0f : 0.0f);
        std::memcpy(cpp.floor_p, floor_p, sizeof(cpp.floor_p));   // memes valeurs que la passe des surfaces
        std::memcpy(cpp.floor_q, floor_q, sizeof(cpp.floor_q));
        std::memcpy(cpp.floor_w, floor_w, sizeof(cpp.floor_w));
        set4(cpp.laser, laser_tiles ? 1.0f : 0.0f, std::max(rs.exposure, 1e-3f), std::max(rs.laser_white, 0.0f),
             rs.specular ? std::max(rs.sparkle, 0.0f) : 0.0f);
        std::memcpy(cpp.grid, cp.grid, sizeof(cpp.grid));
        std::memcpy(cpp.grid2, cp.grid2, sizeof(cpp.grid2));
        {
            // halo des lasers : niveau 0 = somme des niveaux ponderes (1, w, w^2...) : ramene a une moyenne
            float sw = 0.0f, wk = 1.0f;
            for (int i = 0; i < num_lhalo; i++, wk *= std::max(rs.laser_halo_size, 0.0f)) sw += wk;
            const bool on = laser_tiles && rs.laser_halo > 0.0f && num_lhalo > 0;
            set4(cpp.lhalo, on ? rs.laser_halo / std::max(sw, 1e-3f) : 0.0f, rs.laser_lens_ca * 0.01f, 0.0f, 0.0f);
        }
        sg_bindings b = {};
        b.views[VIEW_depth_tex] = scene_depth_lin.tex;
        b.views[VIEW_laser_tex] = laser_lo ? laser_up.tex : laser_tex;
        b.views[VIEW_laser_halo_tex] = num_lhalo > 0 ? lhalo[0].tex : laser_tex;
        b.views[VIEW_vol_hist_tex] = vol_hist[cur].tex;
        b.views[VIEW_scene_tex] = scene_color.tex;
        b.views[VIEW_normal_tex] = scene_normal.tex;
        b.views[VIEW_albedo_tex] = scene_albedo.tex;
        b.views[VIEW_clusters_ro] = cluster_view;
        b.views[VIEW_soft_r_tex] = soft_r.tex;
        b.views[VIEW_soft_g_tex] = soft_g.tex;
        b.views[VIEW_soft_b_tex] = soft_b.tex;
        b.views[VIEW_soft_spec_tex] = soft_spec.tex;
        b.views[VIEW_floor_tex] = floor_view;
        b.views[VIEW_refl0_tex] = refl_final.tex;
        b.views[VIEW_refl_mask_tex] = refl_depth_lin.tex;
        b.views[VIEW_refl_blur_tex] = refl_blur_tex;
        b.views[VIEW_floor_cav] = floor_cav_view;
        b.samplers[SMP_point_smp] = point_smp;
        b.samplers[SMP_lin_clamp_smp] = lin_clamp;
        b.samplers[SMP_floor_smp] = floor_smp;
        b.samplers[SMP_refl_smp] = refl_smp;
        sg_apply_bindings(&b);
        sg_apply_uniforms(UB_composite_params, SG_RANGE_REF(cpp));
        sg_draw(0, 3, 1);
        sg_end_pass();
    }
    hist_index ^= 1;
    prev_view_proj = view_proj;

    // ---- 7b : lueurs de sortie des lasers (point chaud et halo), ajoutees a l'image composee, avant le bloom ----
    if (nexits > 0) {
        gpuprof::mark("lasers : sorties");
        sg_pass pass = {};
        pass.attachments.colors[0] = combined.att;
        pass.action.colors[0].load_action = SG_LOADACTION_LOAD;
        pass.label = "laser-exits";
        sg_begin_pass(&pass);
        sg_apply_pipeline(pip_laser_hit);
        hit_vs_params_t hv = {};
        std::memcpy(hv.view_proj, view_proj.m, sizeof(hv.view_proj));
        set4(hv.cam_pos, cam.pos, 2.0f * tanY / (float)h);
        set4(hv.cam_fwd, cam.fwd, 0.0f);
        set4(hv.beam, lp.beam[0], lp.beam[1], lp.beam[2], 0.0f);
        set4(hv.res, (float)w, (float)h, std::max(rs.laser_conv, 0.0f) * 1e-3f, 0.0f);
        hit_fs_params_t hf = {};
        set4(hf.conv, std::max(rs.laser_conv, 0.0f) * 1e-3f, 0.0f, 0.0f, 0.0f);
        set4(hf.cam_pos, cam.pos, rs.volumetrics ? sigma_ext : 0.0f);
        set4(hf.cam_right, cam.right, tanX);
        set4(hf.cam_up, cam.up, tanY);
        set4(hf.cam_fwd, cam.fwd, 1.0f);
        set4(hf.res, (float)w, (float)h, 2.0f * tanY / (float)h, std::max(rs.exposure, 1e-3f));
        set4(hf.beam, lp.beam[0], lp.beam[1], lp.beam[2], std::max(rs.laser_white, 0.0f));
        sg_bindings b = {};
        b.views[VIEW_hits_vs] = laser_exit_view;
        b.views[VIEW_hits_fs] = laser_exit_view;
        b.views[VIEW_hit_depth] = scene_depth_lin.tex;
        b.views[VIEW_hit_normal] = scene_normal.tex;
        b.views[VIEW_hit_albedo] = scene_albedo.tex;
        b.samplers[SMP_hit_smp] = point_smp;
        sg_apply_bindings(&b);
        sg_apply_uniforms(UB_hit_vs_params, SG_RANGE_REF(hv));
        sg_apply_uniforms(UB_hit_fs_params, SG_RANGE_REF(hf));
        sg_draw(0, 6, nexits);
        sg_end_pass();
    }


    // ---- 8 : bloom --------------------------------------------------------------------------
    if (rs.bloom && num_bloom > 0) {
        gpuprof::mark("bloom");
        for (int i = 0; i < num_bloom; i++) {
            sg_pass pass = {};
            pass.attachments.colors[0] = bloom[i].att;
            pass.action.colors[0].load_action = SG_LOADACTION_DONTCARE;
            pass.label = "bloom-down";
            sg_begin_pass(&pass);
            sg_apply_pipeline(pip_bloom_down);
            const int sw = i == 0 ? w : bloom_w[i - 1], sh = i == 0 ? h : bloom_h[i - 1];
            bloom_params_t bp = {};
            set4(bp.texel, 1.0f / sw, 1.0f / sh, i == 0 ? 1.0f : 0.0f, 1.0f);
            sg_bindings b = {};
            b.views[VIEW_src_tex] = i == 0 ? combined.tex : bloom[i - 1].tex;
            b.samplers[SMP_lin_clamp_smp] = lin_clamp;
            sg_apply_bindings(&b);
            sg_apply_uniforms(UB_bloom_params, SG_RANGE_REF(bp));
            sg_draw(0, 3, 1);
            sg_end_pass();
        }
        for (int i = num_bloom - 1; i >= 1; i--) {
            sg_pass pass = {};
            pass.attachments.colors[0] = bloom[i - 1].att;
            pass.action.colors[0].load_action = SG_LOADACTION_LOAD;
            pass.label = "bloom-up";
            sg_begin_pass(&pass);
            sg_apply_pipeline(pip_bloom_up);
            bloom_params_t bp = {};
            set4(bp.texel, 1.0f / bloom_w[i], 1.0f / bloom_h[i], 0, 1.0f);
            sg_bindings b = {};
            b.views[VIEW_src_tex] = bloom[i].tex;
            b.samplers[SMP_lin_clamp_smp] = lin_clamp;
            sg_apply_bindings(&b);
            sg_apply_uniforms(UB_bloom_params, SG_RANGE_REF(bp));
            sg_draw(0, 3, 1);
            sg_end_pass();
        }
    }

    // ---- 9 : ecran ------------------------------------------------------------------------------
    if (fsr) {
        if (fsr_w != width || fsr_h != height || fsr_iw != w || fsr_ih != h) {
            destroy_target(fsr_in);
            destroy_target(fsr_up);
            make_target(fsr_in, w, h, SG_PIXELFORMAT_RGBA16F, "fsr-in");
            make_target(fsr_up, width, height, SG_PIXELFORMAT_RGBA16F, "fsr-up");
            fsr_w = width;
            fsr_h = height;
            fsr_iw = w;
            fsr_ih = h;
        }
        gpuprof::mark("image finale (FSR)");
        sg_pass pass = {};
        pass.attachments.colors[0] = fsr_in.att;
        pass.action.colors[0].load_action = SG_LOADACTION_DONTCARE;
        pass.label = "final-fsr";
        sg_begin_pass(&pass);
        sg_apply_pipeline(pip_final_fsr);
        final_params_t fp = {};
        set4(fp.res, (float)w, (float)h, 1.0f, 0);
        set4(fp.opts, rs.exposure, rs.bloom_strength, (rs.bloom && num_bloom > 0) ? 1.0f : 0.0f, (float)(frame % 64));
        sg_bindings b = {};
        b.views[VIEW_combined_tex] = combined.tex;
        b.views[VIEW_bloom_tex] = num_bloom > 0 ? bloom[0].tex : combined.tex;
        b.samplers[SMP_lin_clamp_smp] = lin_clamp;
        sg_apply_bindings(&b);
        sg_apply_uniforms(UB_final_params, SG_RANGE_REF(fp));
        sg_draw(0, 3, 1);
        sg_end_pass();
        // constantes de FsrEasuCon (entree w x h, sortie width x height) et de FsrRcasCon
        fsr_params_t fc = {};
        const float iw_ = (float)w, ih_ = (float)h, ow = (float)width, oh = (float)height;
        set4(fc.con0, iw_ / ow, ih_ / oh, 0.5f * iw_ / ow - 0.5f, 0.5f * ih_ / oh - 0.5f);
        set4(fc.con1, 1.0f / iw_, 1.0f / ih_, 1.0f / iw_, -1.0f / ih_);
        set4(fc.con2, -1.0f / iw_, 2.0f / ih_, 1.0f / iw_, 2.0f / ih_);
        set4(fc.con3, 0.0f, 4.0f / ih_, 0.0f, std::exp2(-2.0f * (1.0f - clampf(rs.fsr_sharpness, 0.0f, 1.0f))));
        set4(fc.opts, (float)(frame % 64), 0, 0, 0);
        gpuprof::mark("FSR : agrandissement (EASU)");
        sg_pass ep = {};
        ep.attachments.colors[0] = fsr_up.att;
        ep.action.colors[0].load_action = SG_LOADACTION_DONTCARE;
        ep.label = "fsr-easu";
        sg_begin_pass(&ep);
        sg_apply_pipeline(pip_fsr_easu);
        sg_bindings eb = {};
        eb.views[VIEW_fsr_in_tex] = fsr_in.tex;
        eb.samplers[SMP_lin_clamp_smp] = lin_clamp;
        sg_apply_bindings(&eb);
        sg_apply_uniforms(UB_fsr_params, SG_RANGE_REF(fc));
        sg_draw(0, 3, 1);
        sg_end_pass();
        // netteté (RCAS) sur l'ecran, puis l'interface a pleine resolution
        gpuprof::mark("FSR : nettete (RCAS) + interface");
        sg_pass rp = {};
        rp.action.colors[0].load_action = SG_LOADACTION_DONTCARE;
        rp.swapchain = sglue_swapchain();
        rp.label = "fsr-rcas";
        sg_begin_pass(&rp);
        sg_apply_pipeline(pip_fsr_rcas);
        sg_bindings rb = {};
        rb.views[VIEW_fsr_up_tex] = fsr_up.tex;
        rb.samplers[SMP_point_smp] = point_smp;
        sg_apply_bindings(&rb);
        sg_apply_uniforms(UB_fsr_params, SG_RANGE_REF(fc));
        sg_draw(0, 3, 1);
        if (ui) ui();
        sg_end_pass();
    } else {
    gpuprof::mark("image finale + interface");
    {
        sg_pass pass = {};
        pass.action.colors[0].load_action = SG_LOADACTION_DONTCARE;
        pass.swapchain = sglue_swapchain();
        pass.label = "final";
        sg_begin_pass(&pass);
        sg_apply_pipeline(pip_final);
        final_params_t fp = {};
        set4(fp.res, (float)width, (float)height, 0, 0);
        set4(fp.opts, rs.exposure, rs.bloom_strength, (rs.bloom && num_bloom > 0) ? 1.0f : 0.0f, (float)(frame % 64));
        sg_bindings b = {};
        b.views[VIEW_combined_tex] = combined.tex;
        b.views[VIEW_bloom_tex] = num_bloom > 0 ? bloom[0].tex : combined.tex;
        b.samplers[SMP_lin_clamp_smp] = lin_clamp;
        sg_apply_bindings(&b);
        sg_apply_uniforms(UB_final_params, SG_RANGE_REF(fp));
        sg_draw(0, 3, 1);
        if (ui) ui();
        sg_end_pass();
    }
    }
    gpuprof::frame_end();
    sg_commit();
}
