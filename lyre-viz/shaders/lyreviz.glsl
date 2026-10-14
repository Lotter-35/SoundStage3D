// =====================================================================================
//  LyreViz - tous les shaders (GLSL annote pour sokol-shdc, compile en Metal / HLSL / GLSL)
//
//  Passes d'une image :
//    1. cull_clusters (calcul) : liste des lyres qui touchent chaque case 3D de l'ecran
//    2. cull_tiles    (calcul) : liste des faisceaux qui traversent chaque tuile 2D (fumee)
//    3. probes        (calcul) : lumiere indirecte (rebonds) dans une grille 3D de sondes
//    4. scene         : geometrie + eclairage direct (gobo, prisme, zoom, frost...) + indirect
//    5. volume        : faisceaux dans la fumee (resolution reduite, echantillonnage equiangulaire)
//    6. temporal      : accumulation dans le temps (lisse le bruit des echantillons)
//    7. composite     : scene * transmission de la fumee + lumiere diffusee
//    8. bloom         : halo des sources tres lumineuses
//    9. final         : exposition, tonemapping, vers l'ecran
// =====================================================================================

// -------------------------------------------------------------------------------------
//  Donnees partagees
// -------------------------------------------------------------------------------------
@block common
// Un faisceau (une lyre allumee). Doit correspondre a sb_light_t cote C.
struct sb_light {
    vec4 pos_range;    // xyz : centre de la lentille, w : longueur du faisceau
    vec4 dir_tanenv;   // xyz : axe du faisceau, w : tan(demi-angle de l'enveloppe, prisme compris)
    vec4 up_tanbeam;   // xyz : "haut" du gobo, w : tan(demi-angle du faisceau, frost compris)
    vec4 color_gobo;   // rgb : intensite (couleur * puissance), w : indice du gobo
    vec4 prism;        // x : type de prisme, y : ecart des facettes (tan), z : rotation prisme, w : rotation gobo
    vec4 optics;       // x : frost, y : distance de nettete, z : iris, w : rayon de lentille
};

struct sb_index {
    uint v;
};

// Sonde de lumiere indirecte : harmoniques spheriques d'ordre 1 par canal (L00, L1y, L1z, L1x)
struct sb_probe {
    vec4 r;
    vec4 g;
    vec4 b;
};

// Parametres de la grille de cases (doivent correspondre au code C)
const int CL_STRIDE = 256;   // 1 compteur + 255 indices par case
const int TILE_STRIDE = 256;

const float PI = 3.14159265;

// Coordonnees ecran normalisees (-1..1, y vers le haut) depuis uv = fragcoord / taille.
vec2 ndc_from_uv(vec2 uv) {
#if SOKOL_GLSL
    return uv * 2.0 - 1.0;
#else
    return vec2(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
#endif
}
vec2 uv_from_ndc(vec2 ndc) {
#if SOKOL_GLSL
    return ndc * 0.5 + 0.5;
#else
    return vec2(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
#endif
}

// Bruit "interleaved gradient" (Jimenez) : tres bon pour decaler les echantillons par pixel.
float ign(vec2 p) {
    return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

int facet_count(int type) {
    if (type == 1) return 3;
    if (type == 2) return 6;
    if (type == 3) return 8;
    if (type == 4 || type == 5) return 9;
    if (type == 6) return 4;
    return 1;
}

// Decalage de la facette k du prisme dans le plan image (unites : tan), avant ecartement.
vec2 facet_offset(int type, int k, float rot) {
    vec2 o = vec2(0.0);
    if (type == 1 || type == 2 || type == 3 || (type == 4 && k < 8)) {
        float n = (type == 1) ? 3.0 : ((type == 2) ? 6.0 : 8.0);
        float a = float(k) * 2.0 * PI / n;
        o = vec2(cos(a), sin(a));
    } else if (type == 5) {
        o = vec2(float(k % 3) - 1.0, float(k / 3) - 1.0) * 0.8;
    } else if (type == 6) {
        o = vec2((float(k) - 1.5) * 0.7, 0.0);
    }
    float c = cos(rot), s = sin(rot);
    return vec2(c * o.x - s * o.y, s * o.x + c * o.y);
}

// Fonction de phase de Henyey-Greenstein (diffusion de la fumee, g > 0 : vers l'avant)
float phase_hg(float cos_theta, float g) {
    float g2 = g * g;
    float denom = 1.0 + g2 - 2.0 * g * cos_theta;
    return (1.0 - g2) / (4.0 * PI * denom * sqrt(denom));
}
@end

// Image projetee par une lyre : gobo x iris x prisme x frost x mise au point.
// 'rel' = point - lentille. 'pix_world' = taille d'un pixel a cet endroit (anti-crenelage).
// Necessite gobo_tex / gobo_smp declares avant l'inclusion.
@block beam_pattern
float beam_pattern(sb_light L, vec3 rel, float pix_world) {
    vec3 f = L.dir_tanenv.xyz;
    float z = dot(rel, f);
    if (z <= 0.01) {
        return 0.0;
    }
    vec3 up = L.up_tanbeam.xyz;
    vec3 rt = cross(f, up);
    vec2 p = vec2(dot(rel, rt), dot(rel, up)) / z;
    float T = L.up_tanbeam.w;
    // sortie rapide : hors de l'enveloppe
    float tenv = L.dir_tanenv.w;
    if (dot(p, p) > tenv * tenv) {
        return 0.0;
    }
    int type = int(L.prism.x + 0.5);
    int n = facet_count(type);
    float spread = L.prism.y;
    float frost = L.optics.x;
    float iris = L.optics.z;
    float soft = 0.05 + 0.85 * frost;
    float gr = L.prism.w;
    float gc = cos(gr), gs = sin(gr);
    float layer = L.color_gobo.w;
    float dist = length(rel);
    // flou : frost + ecart a la distance de nettete + taille du pixel
    float defocus = abs(log2(max(dist, 0.2) / max(L.optics.y, 0.2)));
    float lod_aa = log2(max(pix_world * 128.0 / (T * z), 1.0));
    float lod = clamp(frost * 5.0 + defocus * 1.4 + lod_aa, 0.0, 7.5);
    float sum = 0.0;
    for (int k = 0; k < 9; k++) {
        if (k >= n) {
            break;
        }
        vec2 c = (n > 1) ? facet_offset(type, k, L.prism.z) * spread : vec2(0.0);
        vec2 q = (p - c) / T;
        float r2 = dot(q, q);
        if (r2 >= 1.0) {
            continue;
        }
        float r = sqrt(r2);
        float edge = 1.0 - smoothstep(iris * (1.0 - soft), iris, r);
        if (edge <= 0.0) {
            continue;
        }
        vec2 uv = vec2(gc * q.x - gs * q.y, gs * q.x + gc * q.y) * 0.5 + 0.5;
        float g = textureLod(sampler2DArray(gobo_tex, gobo_smp), vec3(uv, layer), lod).r;
        float profile = 1.0 - r2 * (0.2 + 0.6 * frost);   // centre un peu plus chaud
        sum += g * edge * profile;
    }
    return sum / float(n);
}
@end

// Lumiere indirecte : grille de sondes (harmoniques spheriques d'ordre 1, rgb).
// Necessite probes_ro declare avant l'inclusion.
@block probe_sampling
struct probe_sh {
    vec4 r;
    vec4 g;
    vec4 b;
};

probe_sh fetch_probe(ivec3 c, ivec3 dims) {
    int i = (c.z * dims.y + c.y) * dims.x + c.x;
    probe_sh p;
    p.r = probes[i].r;
    p.g = probes[i].g;
    p.b = probes[i].b;
    return p;
}

// Interpolation trilineaire des 8 sondes autour du point.
probe_sh sample_probes(vec3 pos, vec3 pmin, vec3 pcell, ivec3 dims) {
    vec3 g = clamp((pos - pmin) / pcell, vec3(0.0), vec3(dims - 1) - 0.001);
    ivec3 c0 = ivec3(floor(g));
    vec3 f = g - vec3(c0);
    probe_sh acc;
    acc.r = vec4(0.0);
    acc.g = vec4(0.0);
    acc.b = vec4(0.0);
    for (int k = 0; k < 8; k++) {
        ivec3 o = ivec3(k & 1, (k >> 1) & 1, k >> 2);
        vec3 w3 = mix(1.0 - f, f, vec3(o));
        float w = w3.x * w3.y * w3.z;
        probe_sh p = fetch_probe(c0 + o, dims);
        acc.r += p.r * w;
        acc.g += p.g * w;
        acc.b += p.b * w;
    }
    return acc;
}

// Eclairement recu par une surface de normale n.
vec3 sh_irradiance(probe_sh p, vec3 n) {
    vec4 basis = vec4(PI * 0.282095, 2.0943951 * 0.488603 * n.y, 2.0943951 * 0.488603 * n.z, 2.0943951 * 0.488603 * n.x);
    return max(vec3(dot(p.r, basis), dot(p.g, basis), dot(p.b, basis)), vec3(0.0));
}
@end

// Densite de la fumee en un point (amas simules x volutes de detail).
// Necessite fog_tex, detail_tex, lin_clamp_smp, lin_repeat_smp declares avant l'inclusion.
@block fog_density
float fog_density(vec3 x, vec4 fog_box_min, vec4 fog_box_inv, vec4 f0, vec4 f1, vec4 f2) {
    vec3 uvw = (x - fog_box_min.xyz) * fog_box_inv.xyz;
    float smoke = texture(sampler3D(fog_tex, lin_clamp_smp), uvw).r * 2.0;
    float det = texture(sampler3D(detail_tex, lin_repeat_smp), x * f1.y + f2.xyz).r;
    float h = exp(-max(x.y, 0.0) * f1.z);
    float base = f0.y * h + smoke * f0.z;
    return base * mix(1.0, det * 2.0, f1.x);
}
@end

// -------------------------------------------------------------------------------------
//  1. Tri des lumieres par case 3D (pour l'eclairage des surfaces)
// -------------------------------------------------------------------------------------
@cs cs_cull_clusters
@include_block common
layout(binding=0) uniform cull_params {
    vec4 cam_pos;     // w : nombre de lumieres
    vec4 cam_right;   // w : tan(fov x / 2)
    vec4 cam_up;      // w : tan(fov y / 2)
    vec4 cam_fwd;
    vec4 grid;        // x, y : cases ecran, z : tranches de profondeur, w : profondeur de la 1re tranche
    vec4 grid2;       // x : profondeur max, y, z : tuiles fumee, w : longueur des faisceaux
};
layout(binding=0) readonly buffer lights_cs { sb_light lights[]; };
layout(binding=1) buffer clusters_rw { sb_index clusters_w[]; };

layout(local_size_x=64, local_size_y=1, local_size_z=1) in;

float slice_depth(float k) {
    if (k <= 0.0) return 0.05;
    return grid.w * pow(grid2.x / grid.w, (k - 1.0) / (grid.z - 1.0));
}

void main() {
    int nx = int(grid.x), ny = int(grid.y), nz = int(grid.z);
    int ci = int(gl_GlobalInvocationID.x);
    if (ci >= nx * ny * nz) {
        return;
    }
    int ix = ci % nx;
    int iy = (ci / nx) % ny;
    int iz = ci / (nx * ny);
    float z0 = slice_depth(float(iz)), z1 = slice_depth(float(iz + 1));
    vec2 n0 = vec2(float(ix) / grid.x, float(iy) / grid.y) * 2.0 - 1.0;
    vec2 n1 = vec2(float(ix + 1) / grid.x, float(iy + 1) / grid.y) * 2.0 - 1.0;
    // boite englobante de la case (repere monde) -> sphere
    vec3 mn = vec3(1e30), mx = vec3(-1e30);
    for (int k = 0; k < 8; k++) {
        float z = ((k & 4) != 0) ? z1 : z0;
        float nx_ = ((k & 1) != 0) ? n1.x : n0.x;
        float ny_ = ((k & 2) != 0) ? n1.y : n0.y;
        vec3 p = cam_pos.xyz + cam_fwd.xyz * z + cam_right.xyz * (nx_ * cam_right.w * z) + cam_up.xyz * (ny_ * cam_up.w * z);
        mn = min(mn, p);
        mx = max(mx, p);
    }
    vec3 center = (mn + mx) * 0.5;
    float radius = length(mx - mn) * 0.5;

    int base = ci * CL_STRIDE;
    int count = 0;
    int nl = int(cam_pos.w);
    for (int i = 0; i < nl; i++) {
        sb_light L = lights[i];
        vec3 V = center - L.pos_range.xyz;
        float vlen2 = dot(V, V);
        float v1 = dot(V, L.dir_tanenv.xyz);
        float t = L.dir_tanenv.w;
        float cosA = inversesqrt(1.0 + t * t);
        float sinA = t * cosA;
        float dist_closest = cosA * sqrt(max(vlen2 - v1 * v1, 0.0)) - v1 * sinA;
        bool cull = (dist_closest > radius) || (v1 > radius + L.pos_range.w) || (v1 < -radius);
        if (!cull && count < CL_STRIDE - 1) {
            clusters_w[base + 1 + count].v = uint(i);
            count++;
        }
    }
    clusters_w[base].v = uint(count);
}
@end

// -------------------------------------------------------------------------------------
//  2. Tri des faisceaux par tuile 2D (pour la fumee)
// -------------------------------------------------------------------------------------
@cs cs_cull_tiles
@include_block common
layout(binding=0) uniform cull_params {
    vec4 cam_pos;
    vec4 cam_right;
    vec4 cam_up;
    vec4 cam_fwd;
    vec4 grid;
    vec4 grid2;
};
layout(binding=0) readonly buffer lights_cs { sb_light lights[]; };
layout(binding=2) buffer tiles_rw { sb_index tiles_w[]; };

layout(local_size_x=64, local_size_y=1, local_size_z=1) in;

vec3 tile_dir(float nx, float ny) {
    return cam_fwd.xyz + cam_right.xyz * (nx * cam_right.w) + cam_up.xyz * (ny * cam_up.w);
}

// Le cone est-il entierement du mauvais cote du plan (normale n, passant par la camera) ?
bool cone_outside(vec3 n, sb_light L) {
    vec3 a = L.pos_range.xyz - cam_pos.xyz;
    vec3 v = L.dir_tanenv.xyz;
    float h = L.pos_range.w;
    float s0 = dot(n, a);
    float nv = dot(n, v);
    float s1 = dot(n, a + v * h) + h * L.dir_tanenv.w * sqrt(max(1.0 - nv * nv, 0.0));
    return max(s0, s1) < 0.0;
}

void main() {
    int tx = int(grid2.y), ty = int(grid2.z);
    int ti = int(gl_GlobalInvocationID.x);
    if (ti >= tx * ty) {
        return;
    }
    int ix = ti % tx, iy = ti / tx;
    float x0 = float(ix) / grid2.y * 2.0 - 1.0, x1 = float(ix + 1) / grid2.y * 2.0 - 1.0;
    float y0 = float(iy) / grid2.z * 2.0 - 1.0, y1 = float(iy + 1) / grid2.z * 2.0 - 1.0;
    vec3 c = tile_dir((x0 + x1) * 0.5, (y0 + y1) * 0.5);
    vec3 d00 = tile_dir(x0, y0), d10 = tile_dir(x1, y0), d01 = tile_dir(x0, y1), d11 = tile_dir(x1, y1);
    vec3 planes[5];
    planes[0] = normalize(cross(d00, d01));
    planes[1] = normalize(cross(d11, d10));
    planes[2] = normalize(cross(d10, d00));
    planes[3] = normalize(cross(d01, d11));
    for (int k = 0; k < 4; k++) {
        if (dot(planes[k], c) < 0.0) planes[k] = -planes[k];
    }
    planes[4] = cam_fwd.xyz;

    int base = ti * TILE_STRIDE;
    int count = 0;
    int nl = int(cam_pos.w);
    for (int i = 0; i < nl; i++) {
        sb_light L = lights[i];
        bool out_ = false;
        for (int k = 0; k < 5; k++) {
            if (cone_outside(planes[k], L)) {
                out_ = true;
                break;
            }
        }
        if (!out_ && count < TILE_STRIDE - 1) {
            tiles_w[base + 1 + count].v = uint(i);
            count++;
        }
    }
    tiles_w[base].v = uint(count);
}
@end

// -------------------------------------------------------------------------------------
//  3. Lumiere indirecte : chaque sonde additionne les "lumieres virtuelles" (VPL) :
//     taches au sol / murs (avec leur couleur) et lumiere diffusee par la fumee.
// -------------------------------------------------------------------------------------
@cs cs_probes
@include_block common
layout(binding=0) uniform probe_params {
    vec4 probe_min;   // w : nombre de VPL
    vec4 probe_cell;
    vec4 probe_dims;  // w : nombre total de sondes
};
struct sb_vpl {
    vec4 pos_radius;   // xyz, w : rayon (adoucit 1/d^2)
    vec4 normal_type;  // xyz : normale, w : 0 surface (cosinus), 1 volume (isotrope)
    vec4 flux;         // rgb
};
layout(binding=3) readonly buffer vpls_ssbo { sb_vpl vpls[]; };
layout(binding=4) buffer probes_rw { sb_probe probes_w[]; };

layout(local_size_x=64, local_size_y=1, local_size_z=1) in;

void main() {
    int pi = int(gl_GlobalInvocationID.x);
    if (pi >= int(probe_dims.w)) {
        return;
    }
    ivec3 dims = ivec3(probe_dims.xyz);
    ivec3 c = ivec3(pi % dims.x, (pi / dims.x) % dims.y, pi / (dims.x * dims.y));
    vec3 p = probe_min.xyz + vec3(c) * probe_cell.xyz;
    vec4 shr = vec4(0.0), shg = vec4(0.0), shb = vec4(0.0);
    int n = int(probe_min.w);
    for (int i = 0; i < n; i++) {
        sb_vpl v = vpls[i];
        vec3 d = v.pos_radius.xyz - p;
        float d2 = dot(d, d);
        vec3 l = d * inversesqrt(max(d2, 1e-6));
        float emit;
        if (v.normal_type.w < 0.5) {
            emit = max(dot(v.normal_type.xyz, -l), 0.0) * 0.31830989;   // 1/pi
        } else {
            emit = 0.07957747;  // 1/(4 pi)
        }
        vec3 li = v.flux.rgb * (emit / (d2 + v.pos_radius.w * v.pos_radius.w));
        vec4 y = vec4(0.282095, 0.488603 * l.y, 0.488603 * l.z, 0.488603 * l.x);
        shr += li.r * y;
        shg += li.g * y;
        shb += li.b * y;
    }
    probes_w[pi].r = shr;
    probes_w[pi].g = shg;
    probes_w[pi].b = shb;
}
@end

// -------------------------------------------------------------------------------------
//  4. Geometrie et eclairage des surfaces
// -------------------------------------------------------------------------------------
@vs vs_scene
@glsl_options fixup_clipspace
layout(binding=1) uniform scene_vs_params {
    mat4 view_proj;
};
in vec3 position;
in vec3 normal;
in vec4 inst_r0;
in vec4 inst_r1;
in vec4 inst_r2;
in vec4 inst_albedo;
in vec4 inst_emissive;

out vec3 v_world;
out vec3 v_normal;
out vec4 v_albedo;
out vec4 v_emissive;

void main() {
    vec4 p = vec4(position, 1.0);
    vec3 w = vec3(dot(inst_r0, p), dot(inst_r1, p), dot(inst_r2, p));
    vec3 m0 = vec3(inst_r0.x, inst_r1.x, inst_r2.x);
    vec3 m1 = vec3(inst_r0.y, inst_r1.y, inst_r2.y);
    vec3 m2 = vec3(inst_r0.z, inst_r1.z, inst_r2.z);
    vec3 n = cross(m1, m2) * normal.x + cross(m2, m0) * normal.y + cross(m0, m1) * normal.z;
    v_world = w;
    v_normal = normalize(n);
    v_albedo = inst_albedo;
    v_emissive = inst_emissive;
    gl_Position = view_proj * vec4(w, 1.0);
}
@end

@fs fs_scene
@include_block common
layout(binding=2) uniform scene_fs_params {
    vec4 cam_pos;     // w : nombre de lumieres
    vec4 cam_fwd;     // w : angle d'un pixel (rad)
    vec4 grid;        // comme cull_params.grid
    vec4 grid2;       // comme cull_params.grid2
    vec4 res;         // xy : taille de rendu
    vec4 shade;       // x : extinction moyenne de la fumee, y : force indirecte, z : speculaire (0/1), w : ambiance
    vec4 probe_min;   // w : indirect actif (0/1)
    vec4 probe_cell;
    vec4 probe_dims;
};
layout(binding=0) readonly buffer lights_ssbo { sb_light lights[]; };
layout(binding=1) readonly buffer clusters_ro { sb_index clusters[]; };
layout(binding=4) readonly buffer probes_ro { sb_probe probes[]; };
layout(binding=5) uniform texture2DArray gobo_tex;
layout(binding=0) uniform sampler gobo_smp;

@include_block beam_pattern
@include_block probe_sampling

in vec3 v_world;
in vec3 v_normal;
in vec4 v_albedo;
in vec4 v_emissive;
layout(location=0) out vec4 frag_color;
layout(location=1) out vec4 frag_depth;

// Reflet speculaire GGX (Cook-Torrance) avec Fresnel de Schlick
vec3 ggx_spec(vec3 n, vec3 v, vec3 l, float rough, vec3 f0) {
    vec3 h = normalize(v + l);
    float nh = max(dot(n, h), 0.0);
    float nv = max(dot(n, v), 1e-3);
    float nl = max(dot(n, l), 1e-3);
    float a = rough * rough;
    float a2 = a * a;
    float dd = nh * nh * (a2 - 1.0) + 1.0;
    float D = a2 / (PI * dd * dd);
    float k = a * 0.5;
    float G = (nv / (nv * (1.0 - k) + k)) * (nl / (nl * (1.0 - k) + k));
    vec3 F = f0 + (1.0 - f0) * pow(1.0 - max(dot(h, v), 0.0), 5.0);
    return D * G * F / (4.0 * nv * nl);
}

void main() {
    vec3 P = v_world;
    vec3 N = normalize(v_normal);
    vec3 toCam = cam_pos.xyz - P;
    float camDist = length(toCam);
    vec3 V = toCam / camDist;
    if (dot(N, V) < 0.0) {
        N = -N;
    }
    float viewZ = dot(P - cam_pos.xyz, cam_fwd.xyz);
    vec3 albedo = v_albedo.rgb;
    float rough = clamp(v_albedo.a, 0.04, 1.0);
    float metal = v_emissive.a;
    vec3 diffColor = albedo * (1.0 - metal);
    vec3 f0 = mix(vec3(0.04), albedo, metal);
    float sigma = shade.x;
    float pixWorld = viewZ * cam_fwd.w;

    // case de la grille
    vec2 ndc = ndc_from_uv(gl_FragCoord.xy / res.xy);
    int cx = clamp(int((ndc.x * 0.5 + 0.5) * grid.x), 0, int(grid.x) - 1);
    int cy = clamp(int((ndc.y * 0.5 + 0.5) * grid.y), 0, int(grid.y) - 1);
    int cz = 0;
    if (viewZ > grid.w) {
        cz = 1 + int(log(viewZ / grid.w) / log(grid2.x / grid.w) * (grid.z - 1.0));
    }
    cz = clamp(cz, 0, int(grid.z) - 1);
    int ci = (cz * int(grid.y) + cy) * int(grid.x) + cx;
    int base = ci * CL_STRIDE;
    int count = (cam_pos.w > 0.5) ? int(clusters[base].v) : 0;

    vec3 diffuse = vec3(0.0);
    vec3 spec = vec3(0.0);
    for (int i = 0; i < count; i++) {
        sb_light L = lights[clusters[base + 1 + i].v];
        vec3 rel = P - L.pos_range.xyz;
        float d2 = dot(rel, rel);
        float d = sqrt(d2);
        vec3 l = -rel / d;
        float nl = dot(N, l);
        if (nl <= 0.0) {
            continue;
        }
        float pat = beam_pattern(L, rel, pixWorld);
        if (pat <= 0.0) {
            continue;
        }
        vec3 E = L.color_gobo.rgb * (pat * nl * exp(-sigma * d) / max(d2, 0.04));
        diffuse += E;
        if (shade.z > 0.5) {
            spec += E * ggx_spec(N, V, l, rough, f0);
        }
    }
    vec3 color = diffColor * diffuse * 0.31830989 + spec;

    // lumiere indirecte (rebonds colores) + reflet approximatif de cette lumiere
    if (probe_min.w > 0.5) {
        probe_sh sh = sample_probes(P + N * 0.3, probe_min.xyz, probe_cell.xyz, ivec3(probe_dims.xyz));
        vec3 irr = sh_irradiance(sh, N) * shade.y;
        color += diffColor * irr * 0.31830989;
        vec3 R = reflect(-V, N);
        float specAmb = mix(1.0, 0.25, rough);
        color += f0 * sh_irradiance(sh, R) * shade.y * 0.31830989 * specAmb;
    }
    color += albedo * shade.w;   // ambiance minimale (reglable)
    color += v_emissive.rgb;
    frag_color = vec4(color, 1.0);
    frag_depth = vec4(viewZ, 0.0, 0.0, 1.0);
}
@end

// -------------------------------------------------------------------------------------
//  Triangle plein ecran (pas de tampon de sommets)
// -------------------------------------------------------------------------------------
@vs vs_fullscreen
void main() {
    vec2 p = vec2(float((gl_VertexIndex << 1) & 2), float(gl_VertexIndex & 2));
    gl_Position = vec4(p * 2.0 - 1.0, 0.5, 1.0);
}
@end

// -------------------------------------------------------------------------------------
//  5. Faisceaux dans la fumee
// -------------------------------------------------------------------------------------
@fs fs_volume
@include_block common
layout(binding=3) uniform vol_params {
    vec4 cam_pos;      // w : temps
    vec4 cam_right;    // w : tan x
    vec4 cam_up;       // w : tan y
    vec4 cam_fwd;      // w : numero d'image
    vec4 res;          // xy : taille fumee, zw : taille du rendu plein
    vec4 fog0;         // x : densite, y : brume, z : poids des amas, w : anisotropie g
    vec4 fog1;         // x : detail, y : 1/taille detail, z : decroissance en hauteur, w : albedo de diffusion
    vec4 fog2;         // xyz : derive du detail (vent), w : force indirecte dans la fumee
    vec4 fog_box_min;  // w : extinction moyenne
    vec4 fog_box_inv;
    vec4 tiles;        // x, y : tuiles, z : echantillons par faisceau, w : angle pixel fumee
    vec4 probe_min;    // w : indirect actif
    vec4 probe_cell;
    vec4 probe_dims;
};
layout(binding=0) readonly buffer lights_ssbo { sb_light lights[]; };
layout(binding=2) readonly buffer tiles_ro { sb_index tiles_l[]; };
layout(binding=4) readonly buffer probes_ro { sb_probe probes[]; };
layout(binding=5) uniform texture2DArray gobo_tex;
layout(binding=6) uniform texture2D depth_tex;
layout(binding=7) uniform texture3D fog_tex;
layout(binding=8) uniform texture3D detail_tex;
layout(binding=0) uniform sampler gobo_smp;
layout(binding=1) uniform sampler point_smp;
layout(binding=2) uniform sampler lin_clamp_smp;
layout(binding=3) uniform sampler lin_repeat_smp;
@image_sample_type depth_tex unfilterable_float
@sampler_type point_smp nonfiltering

@include_block beam_pattern
@include_block probe_sampling
@include_block fog_density

out vec4 frag_color;

// Intervalle [t0, t1] ou le rayon (o + t v) est dans le cone (sommet a, axe d, cos^2 du demi-angle, longueur h).
bool ray_cone(vec3 o, vec3 v, vec3 a, vec3 d, float cos2, float h, out float t0, out float t1) {
    t0 = 0.0;
    t1 = 0.0;
    vec3 co = o - a;
    float vd = dot(v, d), cd = dot(co, d);
    // tranche le long de l'axe : 0 <= distance axiale <= h
    float s0 = -1e30, s1 = 1e30;
    if (abs(vd) > 1e-6) {
        float ta = -cd / vd, tb = (h - cd) / vd;
        s0 = min(ta, tb);
        s1 = max(ta, tb);
    } else if (cd < 0.0 || cd > h) {
        return false;
    }
    float A = vd * vd - cos2;
    float B = 2.0 * (vd * cd - cos2 * dot(v, co));
    float C = cd * cd - cos2 * dot(co, co);
    float lo = -1e30, hi = 1e30;
    if (abs(A) < 1e-7) {
        if (abs(B) < 1e-9) {
            if (C < 0.0) return false;
        } else {
            float r = -C / B;
            if (B > 0.0) lo = r; else hi = r;
        }
    } else {
        float disc = B * B - 4.0 * A * C;
        if (disc < 0.0) {
            if (A < 0.0) return false;
        } else {
            float sq = sqrt(disc);
            float r1 = (-B - sq) / (2.0 * A), r2 = (-B + sq) / (2.0 * A);
            float rmin = min(r1, r2), rmax = max(r1, r2);
            if (A < 0.0) {
                lo = rmin;
                hi = rmax;
            } else {
                // deux morceaux ; la tranche garde celui de la nappe avant
                float a0 = s0, a1 = min(s1, rmin);
                float b0 = max(s0, rmax), b1 = s1;
                bool p1 = a1 > a0, p2 = b1 > b0;
                if (p1 && p2) { lo = a0; hi = b1; }
                else if (p1) { lo = a0; hi = a1; }
                else if (p2) { lo = b0; hi = b1; }
                else return false;
            }
        }
    }
    t0 = max(lo, s0);
    t1 = min(hi, s1);
    return t1 > t0;
}

void main() {
    vec2 pix = gl_FragCoord.xy;
    vec2 uv = pix / res.xy;
    vec2 ndc = ndc_from_uv(uv);
    vec3 dir = normalize(cam_fwd.xyz + cam_right.xyz * (ndc.x * cam_right.w) + cam_up.xyz * (ndc.y * cam_up.w));
    ivec2 fullPix = clamp(ivec2(uv * res.zw), ivec2(0), ivec2(res.zw) - 1);
    float viewZ = texelFetch(sampler2D(depth_tex, point_smp), fullPix, 0).r;
    float tMax = viewZ / max(dot(dir, cam_fwd.xyz), 1e-3);
    vec3 cam = cam_pos.xyz;
    float g = fog0.w;
    float sigmaAvg = fog_box_min.w;
    float jitter = fract(ign(pix) + cam_fwd.w * 0.61803399);

    int tx = clamp(int((ndc.x * 0.5 + 0.5) * tiles.x), 0, int(tiles.x) - 1);
    int ty = clamp(int((ndc.y * 0.5 + 0.5) * tiles.y), 0, int(tiles.y) - 1);
    int base = (ty * int(tiles.x) + tx) * TILE_STRIDE;
    int count = int(tiles_l[base].v);
    int ns = int(tiles.z);

    vec3 radiance = vec3(0.0);
    for (int i = 0; i < count; i++) {
        sb_light L = lights[tiles_l[base + 1 + i].v];
        float tenv = L.dir_tanenv.w;
        float cos2 = 1.0 / (1.0 + tenv * tenv);
        float t0, t1;
        if (!ray_cone(cam, dir, L.pos_range.xyz, L.dir_tanenv.xyz, cos2, L.pos_range.w, t0, t1)) {
            continue;
        }
        t0 = max(t0, 0.0);
        t1 = min(t1, tMax);
        if (t1 <= t0) {
            continue;
        }
        // echantillonnage equiangulaire : les echantillons se resserrent pres de la lyre (1/d^2)
        vec3 lp = L.pos_range.xyz;
        float delta = dot(lp - cam, dir);
        float lensR = L.optics.w;
        float D = sqrt(max(dot(lp - cam, lp - cam) - delta * delta, 0.0) + lensR * lensR);
        float thA = atan((t0 - delta) / D), thB = atan((t1 - delta) / D);
        float acc = 0.0;
        for (int s = 0; s < 32; s++) {
            if (s >= ns) {
                break;
            }
            float u = (float(s) + jitter) / float(ns);
            float t = delta + D * tan(mix(thA, thB, u));
            vec3 X = cam + dir * t;
            vec3 rel = X - lp;
            float pat = beam_pattern(L, rel, t * tiles.w);
            if (pat <= 0.0) {
                continue;
            }
            float dens = fog_density(X, fog_box_min, fog_box_inv, fog0, fog1, fog2);
            float dl = length(rel);
            float ph = phase_hg(dot(rel / dl, -dir), g);
            acc += pat * dens * ph * exp(-sigmaAvg * (t + dl));
        }
        radiance += L.color_gobo.rgb * (acc * (thB - thA) / (D * float(ns)));
    }
    radiance *= fog0.x * fog1.w;

    // lumiere indirecte diffusee par la fumee (la salle "s'allume")
    if (probe_min.w > 0.5) {
        float tEnd = min(tMax, 90.0);
        const int NA = 4;
        float dt = tEnd / float(NA);
        vec3 amb = vec3(0.0);
        for (int k = 0; k < NA; k++) {
            float t = (float(k) + jitter) * dt;
            vec3 X = cam + dir * t;
            probe_sh sh = sample_probes(X, probe_min.xyz, probe_cell.xyz, ivec3(probe_dims.xyz));
            float dens = fog_density(X, fog_box_min, fog_box_inv, fog0, fog1, fog2);
            amb += vec3(sh.r.x, sh.g.x, sh.b.x) * (0.282095 * dens * exp(-sigmaAvg * t) * dt);
        }
        radiance += max(amb, vec3(0.0)) * fog0.x * fog1.w * fog2.w;
    }
    frag_color = vec4(radiance, 1.0);
}
@end

// -------------------------------------------------------------------------------------
//  6. Accumulation temporelle de la fumee
// -------------------------------------------------------------------------------------
@fs fs_temporal
@include_block common
layout(binding=4) uniform temporal_params {
    mat4 prev_view_proj;
    vec4 cam_pos;
    vec4 cam_right;    // w : tan x
    vec4 cam_up;       // w : tan y
    vec4 cam_fwd;      // w : poids de l'historique (0 = pas d'historique)
    vec4 res;          // xy : taille fumee, zw : taille du rendu plein
};
layout(binding=6) uniform texture2D depth_tex;
layout(binding=9) uniform texture2D vol_cur_tex;
layout(binding=10) uniform texture2D vol_hist_tex;
layout(binding=1) uniform sampler point_smp;
layout(binding=2) uniform sampler lin_clamp_smp;

out vec4 frag_color;

void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    ivec2 maxp = ivec2(res.xy) - 1;
    vec3 cur = texelFetch(sampler2D(vol_cur_tex, point_smp), p, 0).rgb;
    vec3 mn = cur, mx = cur;
    // voisinage 3x3 (anti-fantome)
    for (int j = -1; j <= 1; j++) {
        for (int i = -1; i <= 1; i++) {
            vec3 c = texelFetch(sampler2D(vol_cur_tex, point_smp), clamp(p + ivec2(i, j), ivec2(0), maxp), 0).rgb;
            mn = min(mn, c);
            mx = max(mx, c);
        }
    }
    float w = cam_fwd.w;
    vec3 result = cur;
    if (w > 0.0) {
        vec2 uv = gl_FragCoord.xy / res.xy;
        vec2 ndc = ndc_from_uv(uv);
        vec3 dir = normalize(cam_fwd.xyz + cam_right.xyz * (ndc.x * cam_right.w) + cam_up.xyz * (ndc.y * cam_up.w));
        ivec2 fullPix = clamp(ivec2(uv * res.zw), ivec2(0), ivec2(res.zw) - 1);
        float viewZ = texelFetch(sampler2D(depth_tex, point_smp), fullPix, 0).r;
        float t = min(viewZ, 60.0) / max(dot(dir, cam_fwd.xyz), 1e-3);
        vec3 X = cam_pos.xyz + dir * t;
        vec4 clip = prev_view_proj * vec4(X, 1.0);
        if (clip.w > 1e-3) {
            vec2 puv = uv_from_ndc(clip.xy / clip.w);
            if (puv.x > 0.0 && puv.y > 0.0 && puv.x < 1.0 && puv.y < 1.0) {
                vec3 hist = texture(sampler2D(vol_hist_tex, lin_clamp_smp), puv).rgb;
                // marge pour garder la convergence malgre le bruit
                vec3 ext = (mx - mn) * 0.25;
                hist = clamp(hist, mn - ext, mx + ext);
                result = mix(cur, hist, w);
            }
        }
    }
    frag_color = vec4(result, 1.0);
}
@end

// -------------------------------------------------------------------------------------
//  7. Composition : scene vue a travers la fumee + lumiere diffusee (agrandie avec la profondeur)
// -------------------------------------------------------------------------------------
@fs fs_composite
@include_block common
layout(binding=5) uniform composite_params {
    vec4 cam_right;    // w : tan x
    vec4 cam_up;       // w : tan y
    vec4 cam_fwd;      // w : extinction moyenne
    vec4 res;          // xy : rendu plein, zw : fumee
    vec4 opts;         // x : fumee active
};
layout(binding=6) uniform texture2D depth_tex;
layout(binding=10) uniform texture2D vol_hist_tex;
layout(binding=11) uniform texture2D scene_tex;
layout(binding=1) uniform sampler point_smp;

out vec4 frag_color;

void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec3 scene = texelFetch(sampler2D(scene_tex, point_smp), p, 0).rgb;
    float viewZ = texelFetch(sampler2D(depth_tex, point_smp), p, 0).r;
    vec2 uv = gl_FragCoord.xy / res.xy;
    vec2 ndc = ndc_from_uv(uv);
    vec3 dir = normalize(cam_fwd.xyz + cam_right.xyz * (ndc.x * cam_right.w) + cam_up.xyz * (ndc.y * cam_up.w));
    float t = viewZ / max(dot(dir, cam_fwd.xyz), 1e-3);
    vec3 color = scene;
    if (opts.x > 0.5) {
        color *= exp(-cam_fwd.w * t);
        // agrandissement bilateral : on ignore les texels de fumee d'une autre profondeur
        vec2 scale = res.zw / res.xy;
        vec2 lp = gl_FragCoord.xy * scale - 0.5;
        ivec2 l0 = ivec2(floor(lp));
        vec2 f = lp - vec2(l0);
        ivec2 lmax = ivec2(res.zw) - 1;
        ivec2 fmax = ivec2(res.xy) - 1;
        vec3 acc = vec3(0.0);
        float wsum = 0.0;
        for (int k = 0; k < 4; k++) {
            ivec2 o = ivec2(k & 1, k >> 1);
            ivec2 lc = clamp(l0 + o, ivec2(0), lmax);
            ivec2 fc = clamp(ivec2((vec2(lc) + 0.5) / scale), ivec2(0), fmax);
            float dz = texelFetch(sampler2D(depth_tex, point_smp), fc, 0).r;
            float wb = (o.x == 1 ? f.x : 1.0 - f.x) * (o.y == 1 ? f.y : 1.0 - f.y);
            float wd = 1.0 / (0.02 + abs(dz - viewZ) / max(viewZ, 0.1) * 8.0);
            float w = wb * wd + 1e-5;
            acc += texelFetch(sampler2D(vol_hist_tex, point_smp), lc, 0).rgb * w;
            wsum += w;
        }
        color += acc / wsum;
    }
    frag_color = vec4(color, 1.0);
}
@end

// -------------------------------------------------------------------------------------
//  8. Bloom (halo) : reduction puis agrandissement additif
// -------------------------------------------------------------------------------------
@fs fs_bloom_down
layout(binding=6) uniform bloom_params {
    vec4 texel;        // xy : 1 / taille de la source, z : 1 = premiere passe (anti-luciole)
};
layout(binding=12) uniform texture2D src_tex;
layout(binding=2) uniform sampler lin_clamp_smp;
out vec4 frag_color;

vec3 tap(vec2 uv) {
    return texture(sampler2D(src_tex, lin_clamp_smp), uv).rgb;
}
float karis(vec3 c) {
    return 1.0 / (1.0 + max(max(c.r, c.g), c.b) * 0.25);
}
void main() {
    // la cible fait la moitie de la source : uv du pixel cible = uv dans la source
    vec2 uv = (floor(gl_FragCoord.xy) + 0.5) * texel.xy * 2.0;
    vec2 t = texel.xy;
    vec3 a = tap(uv + t * vec2(-2, -2)), b = tap(uv + t * vec2(0, -2)), c = tap(uv + t * vec2(2, -2));
    vec3 d = tap(uv + t * vec2(-1, -1)), e = tap(uv + t * vec2(1, -1));
    vec3 f = tap(uv + t * vec2(-2, 0)), g = tap(uv), h = tap(uv + t * vec2(2, 0));
    vec3 i = tap(uv + t * vec2(-1, 1)), j = tap(uv + t * vec2(1, 1));
    vec3 k = tap(uv + t * vec2(-2, 2)), l = tap(uv + t * vec2(0, 2)), m = tap(uv + t * vec2(2, 2));
    vec3 res;
    if (texel.z > 0.5) {
        vec3 g0 = (a + b + f + g) * 0.25, g1 = (b + c + g + h) * 0.25, g2 = (f + g + k + l) * 0.25, g3 = (g + h + l + m) * 0.25, g4 = (d + e + i + j) * 0.25;
        float w0 = karis(g0) * 0.125, w1 = karis(g1) * 0.125, w2 = karis(g2) * 0.125, w3 = karis(g3) * 0.125, w4 = karis(g4) * 0.5;
        res = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4);
    } else {
        res = (d + e + i + j) * 0.125 + (a + c + k + m) * 0.03125 + (b + f + h + l) * 0.0625 + g * 0.125;
    }
    frag_color = vec4(res, 1.0);
}
@end

@fs fs_bloom_up
layout(binding=6) uniform bloom_params {
    vec4 texel;        // xy : 1 / taille de la source, w : poids
};
layout(binding=12) uniform texture2D src_tex;
layout(binding=2) uniform sampler lin_clamp_smp;
out vec4 frag_color;

void main() {
    // la cible fait le double de la source
    vec2 uv = (floor(gl_FragCoord.xy) + 0.5) * texel.xy * 0.5;
    vec2 t = texel.xy;
    vec3 s = texture(sampler2D(src_tex, lin_clamp_smp), uv).rgb * 4.0;
    s += (texture(sampler2D(src_tex, lin_clamp_smp), uv + vec2(-t.x, 0)).rgb + texture(sampler2D(src_tex, lin_clamp_smp), uv + vec2(t.x, 0)).rgb +
          texture(sampler2D(src_tex, lin_clamp_smp), uv + vec2(0, -t.y)).rgb + texture(sampler2D(src_tex, lin_clamp_smp), uv + vec2(0, t.y)).rgb) * 2.0;
    s += texture(sampler2D(src_tex, lin_clamp_smp), uv + vec2(-t.x, -t.y)).rgb + texture(sampler2D(src_tex, lin_clamp_smp), uv + vec2(t.x, -t.y)).rgb +
         texture(sampler2D(src_tex, lin_clamp_smp), uv + vec2(-t.x, t.y)).rgb + texture(sampler2D(src_tex, lin_clamp_smp), uv + vec2(t.x, t.y)).rgb;
    frag_color = vec4(s / 16.0 * texel.w, 1.0);
}
@end

// -------------------------------------------------------------------------------------
//  9. Image finale : exposition + bloom + tonemapping ACES + gamma
// -------------------------------------------------------------------------------------
@fs fs_final
@include_block common
layout(binding=7) uniform final_params {
    vec4 res;          // xy : taille de l'ecran
    vec4 opts;         // x : exposition, y : force du bloom, z : bloom actif, w : numero d'image
};
layout(binding=13) uniform texture2D combined_tex;
layout(binding=14) uniform texture2D bloom_tex;
layout(binding=2) uniform sampler lin_clamp_smp;
out vec4 frag_color;

vec3 aces(vec3 x) {
    // ACES (approximation de Narkowicz) : les couleurs tres intenses tirent vers le blanc, comme en vrai
    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
    vec2 uv = gl_FragCoord.xy / res.xy;
    vec3 c = texture(sampler2D(combined_tex, lin_clamp_smp), uv).rgb;
    if (opts.z > 0.5) {
        vec3 b = texture(sampler2D(bloom_tex, lin_clamp_smp), uv).rgb;
        c = mix(c, b, opts.y);
    }
    c *= opts.x;
    c = aces(c);
    c = pow(c, vec3(1.0 / 2.2));
    // tramage leger : evite les bandes dans les degrades sombres
    c += (ign(gl_FragCoord.xy + opts.w * 7.0) - 0.5) / 255.0;
    frag_color = vec4(c, 1.0);
}
@end

// -------------------------------------------------------------------------------------
//  Programmes
// -------------------------------------------------------------------------------------
@program cull_clusters cs_cull_clusters
@program cull_tiles cs_cull_tiles
@program probes cs_probes
@program scene vs_scene fs_scene
@program volume vs_fullscreen fs_volume
@program temporal vs_fullscreen fs_temporal
@program composite vs_fullscreen fs_composite
@program bloom_down vs_fullscreen fs_bloom_down
@program bloom_up vs_fullscreen fs_bloom_up
@program final vs_fullscreen fs_final
