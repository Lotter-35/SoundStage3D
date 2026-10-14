#include "renderer.h"
#include "sokol_app.h"
#include "sokol_glue.h"
#include "shaders/lyreviz.glsl.h"
#include <algorithm>
#include <cstring>

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
void Renderer::init(const Scene& scene, const GoboAtlas& gobos, const FogSim& fog) {
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
    tile_buf = make_storage((size_t)TILE_X * TILE_Y * 256 * sizeof(uint32_t), false, "tiles");
    vpl_buf = make_storage(MAX_VPLS * sizeof(sb_vpl_t), true, "vpls");
    probe_buf = make_storage((size_t)PR_X * PR_Y * PR_Z * sizeof(sb_probe_t), false, "probes");
    light_view = storage_view(light_buf);
    cluster_view = storage_view(cluster_buf);
    tile_view = storage_view(tile_buf);
    vpl_view = storage_view(vpl_buf);
    probe_view = storage_view(probe_buf);
    light_data.resize(MAX_LIGHTS * sizeof(sb_light_t));
    vpl_data.resize(MAX_VPLS * sizeof(sb_vpl_t));
    gobo_transmission = gobos.transmission;

    // grille de sondes (lumiere indirecte) dans le hangar
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
        d.pixel_format = SG_PIXELFORMAT_R8;
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
    pip_cull_tiles = make_compute_pipeline(cull_tiles_shader_desc(backend), "cull-tiles");
    pip_probes = make_compute_pipeline(probes_shader_desc(backend), "probes");
    {
        sg_pipeline_desc p = {};
        p.shader = sg_make_shader(scene_shader_desc(backend));
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
        p.depth.compare = SG_COMPAREFUNC_GREATER;   // Z inverse
        p.depth.write_enabled = true;
        p.color_count = 2;
        p.colors[0].pixel_format = SG_PIXELFORMAT_RGBA16F;
        p.colors[1].pixel_format = SG_PIXELFORMAT_R32F;
        p.sample_count = 1;
        p.label = "scene";
        pip_scene = sg_make_pipeline(&p);
    }
    pip_volume = make_fullscreen_pipeline(volume_shader_desc(backend), SG_PIXELFORMAT_RGBA16F, false, "volume");
    pip_temporal = make_fullscreen_pipeline(temporal_shader_desc(backend), SG_PIXELFORMAT_RGBA16F, false, "temporal");
    pip_composite = make_fullscreen_pipeline(composite_shader_desc(backend), SG_PIXELFORMAT_RGBA16F, false, "composite");
    pip_bloom_down = make_fullscreen_pipeline(bloom_down_shader_desc(backend), SG_PIXELFORMAT_RGBA16F, false, "bloom-down");
    pip_bloom_up = make_fullscreen_pipeline(bloom_up_shader_desc(backend), SG_PIXELFORMAT_RGBA16F, true, "bloom-up");
    {
        sg_pipeline_desc p = {};
        p.shader = sg_make_shader(final_shader_desc(backend));
        p.label = "final";
        pip_final = sg_make_pipeline(&p);   // formats de l'ecran par defaut
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
        make_target(scene_color, w, h, SG_PIXELFORMAT_RGBA16F, "scene-color");
        make_target(scene_depth_lin, w, h, SG_PIXELFORMAT_R32F, "scene-depth-lin");
        make_target(depth, w, h, SG_PIXELFORMAT_DEPTH, "depth");
        make_target(combined, w, h, SG_PIXELFORMAT_RGBA16F, "combined");
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
    }
    destroy_target(vol_cur);
    destroy_target(vol_hist[0]);
    destroy_target(vol_hist[1]);
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
void Renderer::build_lights(const Rig& rig, const RenderSettings& rs, const GoboAtlas& gobos) {
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
        sb_light_t& l = L[num_lights++];
        set4(l.pos_range, f.lens_pos, rs.beam_range);
        set4(l.dir_tanenv, f.dir, Tf + spread * max_facet_offset(o.prism) + 0.01f);
        set4(l.up_tanbeam, f.up, Tf);
        set4(l.color_gobo, f.emit * (base_power * gain), (float)std::clamp(o.gobo, 0, NUM_GOBOS - 1));
        set4(l.prism, (float)o.prism, spread, f.prism_rot, f.gobo_rot + o.gobo_angle * DEG);
        set4(l.optics, frost, std::max(o.focus, 0.5f), clampf(o.iris, 0.05f, 1.0f), 0.12f);
    }
    if (num_lights == 0) std::memset(L, 0, sizeof(sb_light_t));
    stats.lights = num_lights;
}

void Renderer::build_vpls(const Scene& scene, const Rig& rig, const GoboAtlas& gobos, float sigma_ext, float sigma_scat) {
    (void)rig;
    num_vpls = 0;
    sb_vpl_t* V = (sb_vpl_t*)vpl_data.data();
    const sb_light_t* L = (const sb_light_t*)light_data.data();
    for (int i = 0; i < num_lights && num_vpls < MAX_VPLS - 16; i++) {
        const sb_light_t& l = L[i];
        vec3 pos = {l.pos_range[0], l.pos_range[1], l.pos_range[2]};
        vec3 dir = {l.dir_tanenv[0], l.dir_tanenv[1], l.dir_tanenv[2]};
        vec3 up = {l.up_tanbeam[0], l.up_tanbeam[1], l.up_tanbeam[2]};
        vec3 rt = cross(dir, up);
        vec3 col = {l.color_gobo[0], l.color_gobo[1], l.color_gobo[2]};
        float Tf = l.up_tanbeam[3];
        int gobo = (int)l.color_gobo[3];
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
            vec3 refl = flux * h.albedo * (std::exp(-sigma_ext * h.t) / (float)n);
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
        dyn_cyls.push_back(make_instance(f.lens_pos, f.up * 0.13f, ta * 0.13f, f.dir * 0.012f, {0.02f, 0.02f, 0.02f}, 0.1f, emissive));
    }
}

// --------------------------------------------------------------------------------------------
//  Rendu d'une image
// --------------------------------------------------------------------------------------------
void Renderer::render(const Camera& cam, const Scene& scene, const Rig& rig, const GoboAtlas& gobos, const FogSim& fog,
                      const FogSettings& fs, const RenderSettings& rs, int width, int height, float time, void (*ui)()) {
    frame++;
    const int w = std::max(16, (int)(width * clampf(rs.render_scale, 0.25f, 1.0f)));
    const int h = std::max(16, (int)(height * clampf(rs.render_scale, 0.25f, 1.0f)));
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

    // donnees CPU -> GPU
    build_lights(rig, rs, gobos);
    if (rs.gi) build_vpls(scene, rig, gobos, sigma_ext, sigma_scat);
    build_fixture_instances(rig, rs);

    sg_write_buffer_desc wb = {};
    wb.src.data = {light_data.data(), (size_t)std::max(1, num_lights) * sizeof(sb_light_t)};
    wb.dst.buffer = light_buf;
    sg_write_buffer_transient(&wb);
    if (rs.gi) {
        wb.src.data = {vpl_data.data(), (size_t)std::max(1, num_vpls) * sizeof(sb_vpl_t)};
        wb.dst.buffer = vpl_buf;
        sg_write_buffer_transient(&wb);
    }
    const int ndc = std::min((int)dyn_cubes.size(), MAX_DYN), ndy = std::min((int)dyn_cyls.size(), MAX_DYN);
    if (ndc > 0) {
        wb.src.data = {dyn_cubes.data(), (size_t)ndc * sizeof(Instance)};
        wb.dst.buffer = dyn_cube_buf;
        sg_write_buffer_transient(&wb);
    }
    if (ndy > 0) {
        wb.src.data = {dyn_cyls.data(), (size_t)ndy * sizeof(Instance)};
        wb.dst.buffer = dyn_cyl_buf;
        sg_write_buffer_transient(&wb);
    }
    if (rs.volumetrics) {
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
    set4(cp.grid2, far_cluster, (float)TILE_X, (float)TILE_Y, rs.beam_range);
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
            sg_apply_bindings(&b);
            sg_apply_uniforms(UB_cull_params, SG_RANGE_REF(cp));
            sg_dispatch((CL_X * CL_Y * CL_Z + 63) / 64, 1, 1);
        }
        if (rs.volumetrics) {
            sg_apply_pipeline(pip_cull_tiles);
            b = {};
            b.views[VIEW_lights_cs] = light_view;
            b.views[VIEW_tiles_rw] = tile_view;
            sg_apply_bindings(&b);
            sg_apply_uniforms(UB_cull_params, SG_RANGE_REF(cp));
            sg_dispatch((TILE_X * TILE_Y + 63) / 64, 1, 1);
        }
        if (rs.gi) {
            probe_params_t pp = {};
            set4(pp.probe_min, probe_min, (float)num_vpls);
            set4(pp.probe_cell, probe_cell, 0);
            set4(pp.probe_dims, (float)PR_X, (float)PR_Y, (float)PR_Z, (float)(PR_X * PR_Y * PR_Z));
            sg_apply_pipeline(pip_probes);
            b = {};
            b.views[VIEW_vpls_ssbo] = vpl_view;
            b.views[VIEW_probes_rw] = probe_view;
            sg_apply_bindings(&b);
            sg_apply_uniforms(UB_probe_params, SG_RANGE_REF(pp));
            sg_dispatch((PR_X * PR_Y * PR_Z + 63) / 64, 1, 1);
        }
        sg_end_pass();
    }

    // ---- 4 : geometrie --------------------------------------------------------------------
    {
        sg_pass pass = {};
        pass.attachments.colors[0] = scene_color.att;
        pass.attachments.colors[1] = scene_depth_lin.att;
        pass.attachments.depth_stencil = depth.att;
        pass.action.colors[0].load_action = SG_LOADACTION_CLEAR;
        pass.action.colors[0].clear_value = {0, 0, 0, 1};
        pass.action.colors[1].load_action = SG_LOADACTION_CLEAR;
        pass.action.colors[1].clear_value = {1000.0f, 0, 0, 1};
        pass.action.depth.load_action = SG_LOADACTION_CLEAR;
        pass.action.depth.clear_value = 0.0f;
        pass.label = "scene";
        sg_begin_pass(&pass);
        sg_apply_pipeline(pip_scene);
        scene_vs_params_t vsp;
        std::memcpy(vsp.view_proj, view_proj.m, sizeof(vsp.view_proj));
        scene_fs_params_t fsp = {};
        set4(fsp.cam_pos, cam.pos, (float)num_lights);
        set4(fsp.cam_fwd, cam.fwd, 2.0f * tanY / (float)h);
        std::memcpy(fsp.grid, cp.grid, sizeof(fsp.grid));
        std::memcpy(fsp.grid2, cp.grid2, sizeof(fsp.grid2));
        set4(fsp.res, (float)w, (float)h, 0, 0);
        set4(fsp.shade, sigma_ext, rs.gi_strength, rs.specular ? 1.0f : 0.0f, rs.ambient);
        set4(fsp.probe_min, probe_min, rs.gi ? 1.0f : 0.0f);
        set4(fsp.probe_cell, probe_cell, 0);
        set4(fsp.probe_dims, (float)PR_X, (float)PR_Y, (float)PR_Z, 0);
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
            b.views[VIEW_probes_ro] = probe_view;
            b.views[VIEW_gobo_tex] = gobo_view;
            b.samplers[SMP_gobo_smp] = gobo_smp;
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

    // ---- 5-6 : fumee ------------------------------------------------------------------------
    const int cur = hist_index, prev = hist_index ^ 1;
    if (rs.volumetrics) {
        sg_pass pass = {};
        pass.attachments.colors[0] = vol_cur.att;
        pass.action.colors[0].load_action = SG_LOADACTION_DONTCARE;
        pass.label = "volume";
        sg_begin_pass(&pass);
        sg_apply_pipeline(pip_volume);
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
        set4(vp.tiles, (float)TILE_X, (float)TILE_Y, (float)std::clamp(rs.vol_samples, 1, 32), 2.0f * tanY / (float)vh);
        set4(vp.probe_min, probe_min, rs.gi ? 1.0f : 0.0f);
        set4(vp.probe_cell, probe_cell, 0);
        set4(vp.probe_dims, (float)PR_X, (float)PR_Y, (float)PR_Z, 0);
        sg_bindings b = {};
        b.views[VIEW_lights_ssbo] = light_view;
        b.views[VIEW_tiles_ro] = tile_view;
        b.views[VIEW_probes_ro] = probe_view;
        b.views[VIEW_gobo_tex] = gobo_view;
        b.views[VIEW_depth_tex] = scene_depth_lin.tex;
        b.views[VIEW_fog_tex] = fog_view;
        b.views[VIEW_detail_tex] = detail_view;
        b.samplers[SMP_gobo_smp] = gobo_smp;
        b.samplers[SMP_point_smp] = point_smp;
        b.samplers[SMP_lin_clamp_smp] = lin_clamp;
        b.samplers[SMP_lin_repeat_smp] = lin_repeat;
        sg_apply_bindings(&b);
        sg_apply_uniforms(UB_vol_params, SG_RANGE_REF(vp));
        sg_draw(0, 3, 1);
        sg_end_pass();

        // accumulation
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

    // ---- 7 : composition --------------------------------------------------------------------
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
        set4(cpp.opts, rs.volumetrics ? 1.0f : 0.0f, 0, 0, 0);
        sg_bindings b = {};
        b.views[VIEW_depth_tex] = scene_depth_lin.tex;
        b.views[VIEW_vol_hist_tex] = vol_hist[cur].tex;
        b.views[VIEW_scene_tex] = scene_color.tex;
        b.samplers[SMP_point_smp] = point_smp;
        sg_apply_bindings(&b);
        sg_apply_uniforms(UB_composite_params, SG_RANGE_REF(cpp));
        sg_draw(0, 3, 1);
        sg_end_pass();
    }
    hist_index ^= 1;
    prev_view_proj = view_proj;

    // ---- 8 : bloom --------------------------------------------------------------------------
    if (rs.bloom && num_bloom > 0) {
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
    sg_commit();
}
