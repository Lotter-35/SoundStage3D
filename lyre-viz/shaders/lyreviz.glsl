// =====================================================================================
//  LyreViz - tous les shaders (GLSL annote pour sokol-shdc, compile en Metal / HLSL / GLSL)
//
//  Passes d'une image :
//    1. cull_clusters (calcul) : liste des lyres qui touchent chaque case 3D de l'ecran
//    3. probes        (calcul) : lumiere indirecte (rebonds) dans une grille 3D de sondes
//    4. scene         : geometrie + eclairage direct (gobo, prisme, zoom, frost...) + indirect
//    5. beams         : faisceaux dans la fumee : chaque faisceau est dessine comme un cone, le calcul
//                       ne se fait que pour les pixels qu'il couvre (resolution reduite)
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
// Le faisceau sort de toute la lentille : c'est un cone tronque. Son sommet (pos_range) est place
// derriere la lentille, a la distance ou le cone a le diametre de la lentille (optics.w). Le faisceau
// commence a la lentille : rien n'est eclaire entre le sommet et elle.
struct sb_light {
    vec4 pos_range;    // xyz : sommet du cone (derriere la lentille), w : longueur du faisceau depuis le sommet
    vec4 dir_tanenv;   // xyz : axe du faisceau, w : tan(demi-angle de l'enveloppe, prisme compris)
    vec4 up_tanbeam;   // xyz : "haut" du gobo, w : tan(demi-angle du faisceau, frost compris)
    vec4 color_gobo;   // rgb : intensite (couleur * puissance), w : indice du gobo (+ 32 : lyre "douce", voir SOFT_FLAG)
    vec4 prism;        // x : type de prisme, y : ecart des facettes (tan), z : rotation prisme, w : rotation gobo
    vec4 optics;       // x : frost, y : distance de nettete, z : iris, w : distance du sommet a la lentille
};

struct sb_index {
    uint v;
};

struct sb_vec4 {
    vec4 v;
};

// Table d'un faisceau pour le calcul analytique dans la fumee (doit correspondre a sb_btab_t cote C).
// Repere "epipolaire" de la lyre : a = direction lyre -> camera. Une direction u se note
// u = cos(psi) a + sin(psi) (cos(phi) e1 + sin(phi) e2). Tout rayon de camera reste dans un plan
// phi = constante, et y parcourt psi de facon monotone : la lumiere que le faisceau envoie sur ce
// rayon est l'integrale de l'image projetee le long d'une ligne (phi fixe) de la table.
// Chaque ligne de la table contient cette integrale cumulee : un morceau de rayon coute alors
// une difference de deux valeurs, quel que soit le gobo ou le nombre de facettes du prisme.
// La table existe en plusieurs couches de plus en plus floues (mipmaps du gobo).
struct sb_btab {
    vec4 a_psimin;     // xyz : a, w : psi min
    vec4 e1_psimax;    // xyz : e1 (vers l'axe du faisceau), w : psi max
    vec4 e2_phimin;    // xyz : e2, w : phi min
    vec4 info;         // x : phi max, y : flou (lod) de la couche 0, z : nombre de couches, w : texel du gobo (rad, couche 0)
    vec4 lay0;         // couches : (x, y) du coin dans l'atlas, lignes, colonnes
    vec4 lay1;
    vec4 lay2;
    vec4 lay3;
    vec4 lay4;
};
const float BTAB_LOD_STEP = 2.0;
// Lyre "douce" : sa tache sur les surfaces n'a pas de detail fin (frost, bord doux, grande a l'ecran).
// Elle est eclairee a 1/4 de la resolution (passe soft_light). Marquee en ajoutant SOFT_FLAG au gobo.
const float SOFT_FLAG = 32.0;
// Image projetee mise en cache (lyres a prisme) : 256 x 256 + 5 niveaux de flou (128 .. 8), rangees a
// droite dans une case de 384 x 256 de l'atlas. Doit correspondre au code C (PIMG_*).
const float PIMG_SIZE = 256.0;
const float PIMG_LEVELS = 6.0;   // ecart de flou entre deux couches (doit correspondre au code C)

// Sondes de lumiere indirecte : stockees en demi-flottants, divisees par 16 (marge contre le
// depassement, sans perte : puissance de 2).
const float PROBE_PACK = 0.0625;
const float PROBE_UNPACK = 16.0;

// Parametres de la grille de cases (doivent correspondre au code C)
const int CL_STRIDE = 256;   // 1 compteur + 255 indices par case

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

// Decalage de la facette k du prisme dans le plan image (unites : tan), avant rotation et ecartement.
// Sans trigonometrie : les directions des prismes circulaires sont dans des tables.
const vec2 RING3[3] = vec2[3](vec2(1.0, 0.0), vec2(-0.5, 0.8660254), vec2(-0.5, -0.8660254));
const vec2 RING6[6] = vec2[6](vec2(1.0, 0.0), vec2(0.5, 0.8660254), vec2(-0.5, 0.8660254),
                              vec2(-1.0, 0.0), vec2(-0.5, -0.8660254), vec2(0.5, -0.8660254));
const vec2 RING8[8] = vec2[8](vec2(1.0, 0.0), vec2(0.70710678, 0.70710678), vec2(0.0, 1.0), vec2(-0.70710678, 0.70710678),
                              vec2(-1.0, 0.0), vec2(-0.70710678, -0.70710678), vec2(0.0, -1.0), vec2(0.70710678, -0.70710678));
vec2 facet_base(int type, int k) {
    if (type == 1) return RING3[k];
    if (type == 2) return RING6[k];
    if (type == 3 || (type == 4 && k < 8)) return RING8[k];
    if (type == 5) return vec2(float(k - (k / 3) * 3) - 1.0, float(k / 3) - 1.0) * 0.8;
    if (type == 6) return vec2((float(k) - 1.5) * 0.7, 0.0);
    return vec2(0.0);
}

// Tout ce qui ne depend que du faisceau (calcule une fois par faisceau, pas a chaque echantillon).
struct beam_ctx {
    vec3 f, rt, up;      // repere du faisceau
    float T;             // tan du demi-angle du faisceau (frost compris)
    float tenv2;         // tan^2 de l'enveloppe
    int n;               // nombre de facettes
    int type;
    vec4 prot;           // rotation du prisme * ecartement : (c, s) * spread, puis (cos, sin) de la rotation du gobo
    float frost, iris, soft, layer;
    float lod0;          // part du flou qui ne depend pas du point (frost)
    float log2_focus;
};

beam_ctx make_beam(vec4 dir_tanenv, vec4 up_tanbeam, vec4 color_gobo, vec4 prism, vec4 optics) {
    beam_ctx b;
    b.f = dir_tanenv.xyz;
    b.up = up_tanbeam.xyz;
    b.rt = cross(b.f, b.up);
    b.T = up_tanbeam.w;
    b.tenv2 = dir_tanenv.w * dir_tanenv.w;
    b.type = int(prism.x + 0.5);
    b.n = facet_count(b.type);
    float spread = (b.n > 1) ? prism.y : 0.0;
    b.prot = vec4(cos(prism.z) * spread, sin(prism.z) * spread, cos(prism.w), sin(prism.w));
    b.frost = optics.x;
    b.iris = optics.z;
    b.soft = 0.05 + 0.85 * b.frost;
    b.layer = mod(color_gobo.w, SOFT_FLAG);
    b.lod0 = b.frost * 5.0;
    b.log2_focus = log2(max(optics.y, 0.2));
    return b;
}

// Niveau de flou de l'image projetee : frost + ecart a la distance de nettete + taille du pixel.
float beam_lod(float lod0, float log2_focus, float T, float z, float dist, float pix_world) {
    float defocus = abs(log2(max(dist, 0.2)) - log2_focus);
    float lod_aa = log2(max(pix_world * 128.0 / (T * z), 1.0));
    return clamp(lod0 + defocus * 1.4 + lod_aa, 0.0, 7.5);
}

vec4 btab_layer(sb_btab B, int k) {
    if (k <= 0) return B.lay0;
    if (k == 1) return B.lay1;
    if (k == 2) return B.lay2;
    if (k == 3) return B.lay3;
    return B.lay4;
}

// Centre de la facette k (unites : tan), rotation et ecartement compris.
vec2 facet_center(beam_ctx b, int k) {
    vec2 o = facet_base(b.type, k);
    return vec2(b.prot.x * o.x - b.prot.y * o.y, b.prot.y * o.x + b.prot.x * o.y);
}

// Intervalle du parametre t ou la droite (X, Y, Z) = (X0 + X1 t, ...) est dans le cone
// X^2 + Y^2 < T^2 Z^2 avec 0 < Z < h. Les composantes .x sont les valeurs en t = 0, .y les pentes.
// Renvoie (t0, t1) ; vide si t0 >= t1.
vec2 cone_interval(vec2 X, vec2 Y, vec2 Z, float T2, float h) {
    // tranche le long de l'axe
    float s0 = -1e30, s1 = 1e30;
    if (abs(Z.y) > 1e-7) {
        float ta = -Z.x / Z.y, tb = (h - Z.x) / Z.y;
        s0 = min(ta, tb);
        s1 = max(ta, tb);
    } else if (Z.x <= 0.0 || Z.x > h) {
        return vec2(1.0, 0.0);
    }
    float A = X.y * X.y + Y.y * Y.y - T2 * Z.y * Z.y;
    float hb = X.x * X.y + Y.x * Y.y - T2 * Z.x * Z.y;   // B / 2
    float C = X.x * X.x + Y.x * Y.x - T2 * Z.x * Z.x;
    float lo = -1e30, hi = 1e30;
    if (abs(A) < 1e-9) {
        if (abs(hb) < 1e-12) {
            if (C >= 0.0) return vec2(1.0, 0.0);
        } else {
            float r = -C / (2.0 * hb);
            if (hb > 0.0) hi = r; else lo = r;
        }
    } else {
        float disc = hb * hb - A * C;
        if (disc < 0.0) {
            if (A > 0.0) return vec2(1.0, 0.0);
        } else {
            float sq = sqrt(disc);
            float r1 = (-hb - sq) / A, r2 = (-hb + sq) / A;
            float rmin = min(r1, r2), rmax = max(r1, r2);
            if (A > 0.0) {
                // un seul morceau ; il doit etre dans la nappe avant (Z > 0)
                if (Z.x + Z.y * (0.5 * (rmin + rmax)) <= 0.0) return vec2(1.0, 0.0);
                lo = rmin;
                hi = rmax;
            } else if (Z.y > 0.0) {
                lo = rmax;
            } else {
                hi = rmin;
            }
        }
    }
    return vec2(max(lo, s0), min(hi, s1));
}

// Fonction de phase de Henyey-Greenstein (diffusion de la fumee, g > 0 : vers l'avant)
float phase_hg(float cos_theta, float g) {
    float g2 = g * g;
    float denom = 1.0 + g2 - 2.0 * g * cos_theta;
    return (1.0 - g2) / (4.0 * PI * denom * sqrt(denom));
}
@end

// Image projetee par une lyre : gobo x iris x prisme x frost x mise au point.
// 'p' = point dans le plan image du faisceau (unites : tan), 'z' = distance le long de l'axe,
// 'dist' = distance a la lentille, 'pix_world' = taille d'un pixel a cet endroit (anti-crenelage).
// Necessite gobo_tex / gobo_smp declares avant l'inclusion.
@block beam_pattern
// Une facette : gobo x bord de l'iris x profil (centre un peu plus chaud). q : point dans le gobo (rayon 1).
// Nul au-dela de l'iris (iris <= 1), sans test : voir beam_pattern_lod.
float facet_value(beam_ctx b, vec2 q, float lod, float e0, float prof) {
    float r2 = dot(q, q);
    float edge = 1.0 - smoothstep(e0, b.iris, sqrt(r2));
    vec2 uv = vec2(b.prot.z * q.x - b.prot.w * q.y, b.prot.w * q.x + b.prot.z * q.y) * 0.5 + 0.5;
    float g = textureLod(sampler2DArray(gobo_tex, gobo_smp), vec3(uv, b.layer), lod).r;
    return g * edge * (1.0 - r2 * prof);
}

float beam_pattern_lod(beam_ctx b, vec2 p, float lod) {
    float invT = 1.0 / b.T;
    float e0 = b.iris * (1.0 - b.soft);
    float prof = 0.2 + 0.6 * b.frost;
    if (b.n == 1) {
        return facet_value(b, p * invT, lod, e0, prof);
    }
    // Prisme : boucle sans sortie anticipee. Le compilateur la deroule et lance toutes les lectures
    // du gobo ensemble ; avec des "continue", chaque lecture attendait la precedente (5 fois plus lent).
    float sum = 0.0;
    for (int k = 0; k < 9; k++) {
        vec2 q = (p - facet_center(b, min(k, b.n - 1))) * invT;
        float v = facet_value(b, q, lod, e0, prof);
        sum += (k < b.n) ? v : 0.0;
    }
    return sum / float(b.n);
}

float beam_pattern(beam_ctx b, vec2 p, float z, float dist, float pix_world) {
    return beam_pattern_lod(b, p, beam_lod(b.lod0, b.log2_focus, b.T, z, dist, pix_world));
}
@end

// Image projetee en cache : desc = (x, y) du coin dans l'atlas, flou de la couche 0, 1 si presente.
// p : point dans le plan image (unites : tan), tenv : demi-largeur couverte par l'image.
// 2 lectures (deux niveaux de flou) au lieu d'une par facette du prisme.
// Necessite pimg_tex, lin_clamp_smp et tiles2 (xy : 1 / taille de l'atlas) declares avant l'inclusion.
@block pattern_image
float pimg_level(vec4 desc, vec2 uv, int k) {
    float sz = PIMG_SIZE / exp2(float(k));
    vec2 org = desc.xy;
    if (k > 0) {
        org += vec2(PIMG_SIZE, PIMG_SIZE - 2.0 * sz);
    }
    vec2 tc = org + clamp(uv * sz, vec2(0.5), vec2(sz - 0.5));
    return textureLod(sampler2D(pimg_tex, lin_clamp_smp), tc * pimg_inv, 0.0).r;
}

float pattern_image(vec4 desc, vec2 p, float tenv, float lod) {
    vec2 uv = p / (2.0 * tenv) + 0.5;
    float lv = clamp(lod - desc.z, 0.0, PIMG_LEVELS - 1.0);
    int k0 = int(floor(lv));
    int k1 = min(k0 + 1, int(PIMG_LEVELS) - 1);
    return mix(pimg_level(desc, uv, k0), pimg_level(desc, uv, k1), lv - float(k0));
}
@end

// Lumiere indirecte : grille de sondes (harmoniques spheriques d'ordre 1, rgb).
// Les sondes sont rangees dans 3 textures 2D (tranches z empilees en hauteur), filtrees par le
// materiel : 2 lectures bilineaires + 1 melange par texture au lieu de 8 sondes x 3 vec4.
// Rangement des 12 coefficients :
//   A = (r L00, g L00, b L00, r L1y)   B = (g L1y, b L1y, r L1z, g L1z)   C = (b L1z, r L1x, g L1x, b L1x)
// Necessite probe_a et lin_clamp_smp declares avant l'inclusion.
@block probe_sampling
struct probe_sh {
    vec4 r;
    vec4 g;
    vec4 b;
};

// Coordonnees des deux tranches z qui encadrent le point, et le poids de melange.
void probe_coords(vec3 pos, vec3 pmin, vec3 pcell, ivec3 dims, out vec2 uv0, out vec2 uv1, out float fz) {
    vec3 g = clamp((pos - pmin) / pcell, vec3(0.0), vec3(dims - 1) - 0.001);
    float z0 = floor(g.z);
    fz = g.z - z0;
    vec2 inv = 1.0 / vec2(float(dims.x), float(dims.y * dims.z));
    uv0 = vec2(g.x + 0.5, z0 * float(dims.y) + g.y + 0.5) * inv;
    uv1 = uv0 + vec2(0.0, float(dims.y) * inv.y);
}

// Seulement le terme constant (L00) en rgb : la fumee diffuse dans toutes les directions.
vec3 sample_probes_l0(vec3 pos, vec3 pmin, vec3 pcell, ivec3 dims) {
    vec2 uv0, uv1;
    float fz;
    probe_coords(pos, pmin, pcell, dims, uv0, uv1, fz);
    return mix(textureLod(sampler2D(probe_a, lin_clamp_smp), uv0, 0.0).rgb, textureLod(sampler2D(probe_a, lin_clamp_smp), uv1, 0.0).rgb, fz) * PROBE_UNPACK;
}

@end

// Echantillonnage complet (surfaces) : en plus de probe_sampling, necessite probe_b et probe_c.
@block probe_sampling_full
probe_sh sample_probes(vec3 pos, vec3 pmin, vec3 pcell, ivec3 dims) {
    vec2 uv0, uv1;
    float fz;
    probe_coords(pos, pmin, pcell, dims, uv0, uv1, fz);
    vec4 A = mix(textureLod(sampler2D(probe_a, lin_clamp_smp), uv0, 0.0), textureLod(sampler2D(probe_a, lin_clamp_smp), uv1, 0.0), fz) * PROBE_UNPACK;
    vec4 B = mix(textureLod(sampler2D(probe_b, lin_clamp_smp), uv0, 0.0), textureLod(sampler2D(probe_b, lin_clamp_smp), uv1, 0.0), fz) * PROBE_UNPACK;
    vec4 C = mix(textureLod(sampler2D(probe_c, lin_clamp_smp), uv0, 0.0), textureLod(sampler2D(probe_c, lin_clamp_smp), uv1, 0.0), fz) * PROBE_UNPACK;
    probe_sh acc;
    acc.r = vec4(A.x, A.w, B.z, C.y);
    acc.g = vec4(A.y, B.x, B.w, C.z);
    acc.b = vec4(A.z, B.y, C.x, C.w);
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
// textureLod (niveau 0, ces textures n'ont pas de mipmaps) : meme resultat que texture(), mais sans
// derivees implicites. Dans une boucle dynamique, texture() oblige le compilateur HLSL (fxc) a
// derouler la boucle : 25 s de compilation au demarrage, puis echec -> plus de faisceaux sous D3D11.
@block fog_density
float fog_density(vec3 x, vec4 fog_box_min, vec4 fog_box_inv, vec4 f0, vec4 f1, vec4 f2) {
    vec3 uvw = (x - fog_box_min.xyz) * fog_box_inv.xyz;
    float smoke = textureLod(sampler3D(fog_tex, lin_clamp_smp), uvw, 0.0).r * 2.0;
    float det = textureLod(sampler3D(detail_tex, lin_repeat_smp), x * f1.y + f2.xyz, 0.0).r;
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
    vec4 grid2;       // x : profondeur max
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
    int nsharp = 0;
    int nl = int(cam_pos.w);
    // deux tours : les lyres nettes d'abord, puis les douces
    for (int pass = 0; pass < 2; pass++) {
    for (int i = 0; i < nl; i++) {
        sb_light L = lights[i];
        if ((L.color_gobo.w >= SOFT_FLAG) != (pass == 1)) {
            continue;
        }
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
    if (pass == 0) {
        nsharp = count;
    }
    }
    clusters_w[base].v = uint(nsharp) | (uint(count) << 16);
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
layout(binding=15, rgba16f) uniform writeonly image2D probe_a_w;
layout(binding=16, rgba16f) uniform writeonly image2D probe_b_w;
layout(binding=17, rgba16f) uniform writeonly image2D probe_c_w;

layout(local_size_x=64, local_size_y=1, local_size_z=1) in;

// Les VPL sont lues par paquets de 64 en memoire partagee (une lecture par VPL et par groupe,
// au lieu d'une par sonde).
shared vec4 s_pos[64];
shared vec4 s_nrm[64];
shared vec4 s_flux[64];

void main() {
    int pi = int(gl_GlobalInvocationID.x);
    int li = int(gl_LocalInvocationIndex);
    bool valid = pi < int(probe_dims.w);
    ivec3 dims = ivec3(probe_dims.xyz);
    ivec3 c = ivec3(pi % dims.x, (pi / dims.x) % dims.y, pi / (dims.x * dims.y));
    vec3 p = probe_min.xyz + vec3(c) * probe_cell.xyz;
    vec4 shr = vec4(0.0), shg = vec4(0.0), shb = vec4(0.0);
    int n = int(probe_min.w);
    for (int base = 0; base < n; base += 64) {
        int j = base + li;
        if (j < n) {
            s_pos[li] = vpls[j].pos_radius;
            s_nrm[li] = vpls[j].normal_type;
            s_flux[li] = vpls[j].flux;
        }
        barrier();
        int cnt = min(64, n - base);
        for (int k = 0; k < cnt; k++) {
            vec4 pr = s_pos[k];
            vec4 nt = s_nrm[k];
            vec3 d = pr.xyz - p;
            float d2 = dot(d, d);
            vec3 l = d * inversesqrt(max(d2, 1e-6));
            float emit;
            if (nt.w < 0.5) {
                emit = max(dot(nt.xyz, -l), 0.0) * 0.31830989;   // 1/pi
            } else {
                emit = 0.07957747;  // 1/(4 pi)
            }
            vec3 lum = s_flux[k].rgb * (emit / (d2 + pr.w * pr.w));
            vec4 y = vec4(0.282095, 0.488603 * l.y, 0.488603 * l.z, 0.488603 * l.x);
            shr += lum.r * y;
            shg += lum.g * y;
            shb += lum.b * y;
        }
        barrier();
    }
    if (valid) {
        ivec2 at = ivec2(c.x, c.z * dims.y + c.y);
        imageStore(probe_a_w, at, vec4(shr.x, shg.x, shb.x, shr.y) * PROBE_PACK);
        imageStore(probe_b_w, at, vec4(shg.y, shb.y, shr.z, shg.z) * PROBE_PACK);
        imageStore(probe_c_w, at, vec4(shb.z, shr.w, shg.w, shb.w) * PROBE_PACK);
    }
}
@end

// -------------------------------------------------------------------------------------
//  3a. Images projetees des lyres a prisme (gobo x facettes x iris x frost), avec niveaux de flou.
// -------------------------------------------------------------------------------------
@cs cs_pattern_images
@include_block common
layout(binding=0) readonly buffer lights_cs { sb_light lights[]; };
layout(binding=26) readonly buffer pimg_desc_cs { sb_vec4 pdesc[]; };
layout(binding=27) readonly buffer pimg_list_cs { sb_index plist[]; };
layout(binding=5) uniform texture2DArray gobo_tex_ci;
layout(binding=0) uniform sampler gobo_smp_ci;
#define gobo_tex gobo_tex_ci
#define gobo_smp gobo_smp_ci
layout(binding=28, r32f) uniform writeonly image2D pimg_w;
@include_block beam_pattern

layout(local_size_x=8, local_size_y=8, local_size_z=1) in;

void main() {
    int li = int(plist[gl_WorkGroupID.z].v);
    ivec2 xy = ivec2(gl_GlobalInvocationID.xy);   // dans la case 384 x 256
    int S = int(PIMG_SIZE);
    int k = 0;
    ivec2 t = xy;
    if (xy.x >= S) {
        // niveaux 1.. : colonne de droite, empiles vers le bas
        int y = xy.y;
        k = 1;
        int sz = S / 2;
        while (k < int(PIMG_LEVELS) - 1 && y >= sz) {
            y -= sz;
            sz /= 2;
            k++;
        }
        t = ivec2(xy.x - S, y);
        if (t.x >= sz || t.y >= sz) {
            return;
        }
    }
    vec4 desc = pdesc[li].v;
    float sz = PIMG_SIZE / exp2(float(k));
    sb_light L = lights[li];
    beam_ctx b = make_beam(L.dir_tanenv, L.up_tanbeam, L.color_gobo, L.prism, L.optics);
    vec2 p = ((vec2(t) + 0.5) / sz * 2.0 - 1.0) * L.dir_tanenv.w;
    float v = beam_pattern_lod(b, p, desc.z + float(k));
    imageStore(pimg_w, ivec2(desc.xy) + xy, vec4(v));
}
@end

// -------------------------------------------------------------------------------------
//  3b. Tables des faisceaux (calcul analytique dans la fumee) : un fil par ligne de table.
// -------------------------------------------------------------------------------------
@cs cs_beam_tables
@include_block common
layout(binding=0) uniform table_params {
    vec4 info;   // x : nombre de lignes a calculer, y : groupes par rangee de la grille de calcul
};
layout(binding=0) readonly buffer lights_cs { sb_light lights[]; };
layout(binding=4) readonly buffer btabs_cs { sb_btab btabs[]; };
layout(binding=20) readonly buffer btab_jobs { sb_index jobs[]; };   // lyre << 16 | couche << 12 | ligne
// noms propres au calcul (sokol-shdc refuse qu'une meme texture serve a deux etages differents)
layout(binding=5) uniform texture2DArray gobo_tex_cs;
layout(binding=0) uniform sampler gobo_smp_cs;
#define gobo_tex gobo_tex_cs
#define gobo_smp gobo_smp_cs
layout(binding=19, r32f) uniform writeonly image2D table_w;
layout(binding=26) readonly buffer pimg_desc_tb { sb_vec4 pdesc[]; };
layout(binding=29) uniform texture2D pimg_tex_tb;
layout(binding=2) uniform sampler lin_clamp_tb;
#define pimg_tex pimg_tex_tb
#define lin_clamp_smp lin_clamp_tb
#define pimg_inv vec2(1.0 / 8064.0, 1.0 / 3072.0)
@include_block beam_pattern
@include_block pattern_image

// Un groupe de 64 fils par ligne de table : chaque fil integre quelques colonnes, puis une somme
// cumulee en parallele (memoire partagee) donne la ligne entiere.
layout(local_size_x=64, local_size_y=1, local_size_z=1) in;

shared float s_inc[512];   // integrale de chaque colonne
shared float s_part[64];   // somme des colonnes de chaque fil

void main() {
    int job = int(gl_WorkGroupID.y) * int(info.y) + int(gl_WorkGroupID.x);
    if (job >= int(info.x)) {
        return;   // tout le groupe sort ensemble
    }
    uint code = jobs[job].v;
    int li = int(code >> 16);
    int k = int((code >> 12) & 15u);
    int r = int(code & 4095u);
    int tid = int(gl_LocalInvocationIndex);
    sb_btab B = btabs[li];
    vec4 lay = btab_layer(B, k);
    int R = int(lay.z), C = int(lay.w);
    sb_light L = lights[li];
    beam_ctx b = make_beam(L.dir_tanenv, L.up_tanbeam, L.color_gobo, L.prism, L.optics);
    float lod = B.info.y + float(k) * BTAB_LOD_STEP;
    vec4 pd = pdesc[li].v;   // image projetee en cache (prisme) ?
    float phi = mix(B.e2_phimin.w, B.info.x, float(r) / float(max(R - 1, 1)));
    vec3 a = B.a_psimin.xyz;
    vec3 side = cos(phi) * B.e1_psimax.xyz + sin(phi) * B.e2_phimin.xyz;
    float psi0 = B.a_psimin.w;
    float dpsi = (B.e1_psimax.w - psi0) / float(max(C - 1, 1));
    // points par colonne : un par texel du gobo (au flou de la couche)
    float texel = B.info.w * exp2(float(k) * BTAB_LOD_STEP);
    int nsub = clamp(int(ceil(dpsi / texel)), 1, 8);
    float w = dpsi / float(nsub);
    // 1. integrale de chaque colonne : le fil tid traite les colonnes tid, tid + 64, ...
    for (int j = 0; j < 8; j++) {
        int c = tid + 64 * j;
        if (c >= C) {
            break;
        }
        float inc = 0.0;
        if (c > 0) {
            for (int h = 0; h < 8; h++) {
                if (h >= nsub) {
                    break;
                }
                float psi = psi0 + (float(c - 1) + (float(h) + 0.5) / float(nsub)) * dpsi;
                vec3 u = cos(psi) * a + sin(psi) * side;
                float z = dot(u, b.f);
                if (z > 1e-4) {
                    vec2 p = vec2(dot(u, b.rt), dot(u, b.up)) / z;
                    if (dot(p, p) <= b.tenv2) {
                        inc += (pd.w > 0.5) ? pattern_image(pd, p, L.dir_tanenv.w, lod) : beam_pattern_lod(b, p, lod);
                    }
                }
            }
        }
        s_inc[c] = inc * w;
    }
    barrier();
    // 2. somme cumulee : chaque fil cumule 8 colonnes consecutives...
    int c0 = tid * 8;
    float part = 0.0;
    for (int j = 0; j < 8; j++) {
        if (c0 + j < C) {
            part += s_inc[c0 + j];
            s_inc[c0 + j] = part;
        }
    }
    s_part[tid] = part;
    barrier();
    // ... puis les 64 totaux (Hillis-Steele), et chaque fil decale ses 8 colonnes
    for (int off = 1; off < 64; off *= 2) {
        float v = (tid >= off) ? s_part[tid - off] : 0.0;
        barrier();
        s_part[tid] += v;
        barrier();
    }
    float before = s_part[tid] - part;
    for (int j = 0; j < 8; j++) {
        if (c0 + j < C) {
            s_inc[c0 + j] += before;
        }
    }
    barrier();
    // 3. ecriture : colonnes contigues pour des fils voisins
    ivec2 at = ivec2(int(lay.x), int(lay.y) + r);
    for (int j = 0; j < 8; j++) {
        int c = tid + 64 * j;
        if (c >= C) {
            break;
        }
        imageStore(table_w, at + ivec2(c, 0), vec4(s_inc[c]));
    }
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

// Reflet speculaire GGX (Cook-Torrance) avec Fresnel de Schlick
@block ggx
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
@end

@block scene_fs_body
@include_block common
layout(binding=2) uniform scene_fs_params {
    vec4 cam_pos;     // w : nombre de lumieres
    vec4 cam_fwd;     // w : angle d'un pixel (rad)
    vec4 grid;        // comme cull_params.grid
    vec4 grid2;       // comme cull_params.grid2
    vec4 res;         // xy : taille de rendu, zw : 1 / taille de l'atlas des images projetees
    vec4 shade;       // x : extinction moyenne de la fumee, y : force indirecte, z : speculaire (0/1), w : ambiance
    vec4 probe_min;   // w : indirect actif (0/1)
    vec4 probe_cell;
    vec4 probe_dims;
};
layout(binding=0) readonly buffer lights_ssbo { sb_light lights[]; };
layout(binding=1) readonly buffer clusters_ro { sb_index clusters[]; };
layout(binding=5) uniform texture2DArray gobo_tex;
layout(binding=15) uniform texture2D probe_a;
layout(binding=16) uniform texture2D probe_b;
layout(binding=17) uniform texture2D probe_c;
layout(binding=0) uniform sampler gobo_smp;
layout(binding=2) uniform sampler lin_clamp_smp;
layout(binding=26) readonly buffer pimg_desc_ro { sb_vec4 pdesc[]; };
layout(binding=29) uniform texture2D pimg_tex;

@include_block beam_pattern
@include_block probe_sampling
@include_block probe_sampling_full
#define pimg_inv res.zw
@include_block pattern_image

in vec3 v_world;
in vec3 v_normal;
in vec4 v_albedo;
in vec4 v_emissive;
layout(location=0) out vec4 frag_color;
layout(location=1) out vec4 frag_depth;
#ifdef SCENE_GBUFFER
layout(location=2) out vec4 frag_normal;   // normale (tournee vers la camera), rugosite
layout(location=3) out vec4 frag_albedo;   // couleur, metal
#endif

@include_block ggx

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
    int count = (cam_pos.w > 0.5) ? int(clusters[base].v & 65535u) : 0;   // lyres nettes seulement

    vec3 diffuse = vec3(0.0);
    vec3 spec = vec3(0.0);
    for (int i = 0; i < count; i++) {
        // les donnees de la lyre ne sont lues qu'au fur et a mesure des tests
        uint li = clusters[base + 1 + i].v;
        vec3 rel = P - lights[li].pos_range.xyz;
        float d2 = dot(rel, rel);
        float d = sqrt(d2);
        vec3 l = -rel / d;
        float nl = dot(N, l);
        if (nl <= 0.0) {
            continue;
        }
        vec4 dte = lights[li].dir_tanenv;
        float z = dot(rel, dte.xyz);
        if (z <= lights[li].optics.w) {   // derriere la lentille
            continue;
        }
        vec4 ut = lights[li].up_tanbeam;
        vec2 p = vec2(dot(rel, cross(dte.xyz, ut.xyz)), dot(rel, ut.xyz)) / z;
        if (dot(p, p) > dte.w * dte.w) {   // hors de l'enveloppe
            continue;
        }
        vec4 cg = lights[li].color_gobo;
        vec4 pd = pdesc[li].v;
        float pat;
        if (pd.w > 0.5) {
            // image projetee en cache (prisme) : seul le flou est a calculer
            vec4 op = lights[li].optics;
            pat = pattern_image(pd, p, dte.w, beam_lod(op.x * 5.0, log2(max(op.y, 0.2)), ut.w, z, d, pixWorld));
        } else {
            beam_ctx b = make_beam(dte, ut, cg, lights[li].prism, lights[li].optics);
            pat = beam_pattern(b, p, z, d, pixWorld);
        }
        if (pat <= 0.0) {
            continue;
        }
        vec3 E = cg.rgb * (pat * nl * exp(-sigma * d) / max(d2, 0.04));
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
#ifdef SCENE_GBUFFER
    frag_normal = vec4(N, rough);
    frag_albedo = vec4(albedo, metal);
#endif
}
@end

@fs fs_scene
@include_block scene_fs_body
@end

// Meme passe, qui ecrit aussi normale et matiere pour la passe des lyres douces.
@fs fs_scene_gb
#define SCENE_GBUFFER 1
@include_block scene_fs_body
@end

// -------------------------------------------------------------------------------------
//  4b. Lyres douces sur les surfaces, a 1/4 de la resolution : eclairement diffus et reflet,
//      ajoutes a l'image pleine resolution par composite (en respectant bords et normales).
// -------------------------------------------------------------------------------------
@fs fs_soft_light
@include_block common
layout(binding=3) uniform soft_params {
    vec4 cam_pos;     // w : extinction moyenne de la fumee
    vec4 cam_right;   // w : tan x
    vec4 cam_up;      // w : tan y
    vec4 cam_fwd;     // w : angle d'un pixel plein ecran (rad)
    vec4 grid;        // comme cull_params.grid
    vec4 grid2;       // comme cull_params.grid2
    vec4 res;         // xy : rendu plein, zw : cette passe
    vec4 shade;       // xy : 1 / taille de l'atlas des images projetees, z : speculaire (0/1)
};
layout(binding=0) readonly buffer lights_ssbo { sb_light lights[]; };
layout(binding=1) readonly buffer clusters_ro { sb_index clusters[]; };
layout(binding=5) uniform texture2DArray gobo_tex;
layout(binding=6) uniform texture2D depth_tex;
layout(binding=24) uniform texture2D normal_tex;
layout(binding=25) uniform texture2D albedo_tex;
layout(binding=0) uniform sampler gobo_smp;
layout(binding=1) uniform sampler point_smp;
layout(binding=26) readonly buffer pimg_desc_ro { sb_vec4 pdesc[]; };
layout(binding=29) uniform texture2D pimg_tex;
layout(binding=2) uniform sampler lin_clamp_smp;
@image_sample_type normal_tex unfilterable_float
#define pimg_inv shade.xy
@include_block beam_pattern
@include_block pattern_image
@include_block ggx

layout(location=0) out vec4 out_diffuse;   // eclairement (rgb), profondeur utilisee
layout(location=1) out vec4 out_spec;      // reflet (rgb)

void main() {
    vec2 uv = gl_FragCoord.xy / res.zw;
    ivec2 fp = clamp(ivec2(uv * res.xy), ivec2(0), ivec2(res.xy) - 1);
    float viewZ = texelFetch(sampler2D(depth_tex, point_smp), fp, 0).r;
    vec4 nr = texelFetch(sampler2D(normal_tex, point_smp), fp, 0);
    vec4 am = texelFetch(sampler2D(albedo_tex, point_smp), fp, 0);
    vec2 ndc = ndc_from_uv((vec2(fp) + 0.5) / res.xy);
    vec3 dir = normalize(cam_fwd.xyz + cam_right.xyz * (ndc.x * cam_right.w) + cam_up.xyz * (ndc.y * cam_up.w));
    vec3 P = cam_pos.xyz + dir * (viewZ / max(dot(dir, cam_fwd.xyz), 1e-3));
    vec3 N = normalize(nr.xyz);
    vec3 V = -dir;
    float rough = clamp(nr.w, 0.04, 1.0);
    vec3 f0 = mix(vec3(0.04), am.rgb, am.a);
    float sigma = cam_pos.w;
    float pixWorld = viewZ * cam_fwd.w;
    int cx = clamp(int((ndc.x * 0.5 + 0.5) * grid.x), 0, int(grid.x) - 1);
    int cy = clamp(int((ndc.y * 0.5 + 0.5) * grid.y), 0, int(grid.y) - 1);
    int cz = 0;
    if (viewZ > grid.w) {
        cz = 1 + int(log(viewZ / grid.w) / log(grid2.x / grid.w) * (grid.z - 1.0));
    }
    cz = clamp(cz, 0, int(grid.z) - 1);
    int base = ((cz * int(grid.y) + cy) * int(grid.x) + cx) * CL_STRIDE;
    uint head = clusters[base].v;
    int first = int(head & 65535u), total = int(head >> 16);
    vec3 diffuse = vec3(0.0);
    vec3 spec = vec3(0.0);
    for (int i = first; i < total; i++) {
        uint li = clusters[base + 1 + i].v;
        vec3 rel = P - lights[li].pos_range.xyz;
        float d2 = dot(rel, rel);
        float d = sqrt(d2);
        vec3 l = -rel / d;
        float nl = dot(N, l);
        if (nl <= 0.0) {
            continue;
        }
        vec4 dte = lights[li].dir_tanenv;
        float z = dot(rel, dte.xyz);
        if (z <= lights[li].optics.w) {   // derriere la lentille
            continue;
        }
        vec4 ut = lights[li].up_tanbeam;
        vec2 p = vec2(dot(rel, cross(dte.xyz, ut.xyz)), dot(rel, ut.xyz)) / z;
        if (dot(p, p) > dte.w * dte.w) {
            continue;
        }
        vec4 cg = lights[li].color_gobo;
        vec4 pd = pdesc[li].v;
        float pat;
        if (pd.w > 0.5) {
            // image projetee en cache (prisme) : seul le flou est a calculer
            vec4 op = lights[li].optics;
            pat = pattern_image(pd, p, dte.w, beam_lod(op.x * 5.0, log2(max(op.y, 0.2)), ut.w, z, d, pixWorld));
        } else {
            beam_ctx b = make_beam(dte, ut, cg, lights[li].prism, lights[li].optics);
            pat = beam_pattern(b, p, z, d, pixWorld);
        }
        if (pat <= 0.0) {
            continue;
        }
        vec3 E = cg.rgb * (pat * nl * exp(-sigma * d) / max(d2, 0.04));
        diffuse += E;
        if (shade.z > 0.5) {
            spec += E * ggx_spec(N, V, l, rough, f0);
        }
    }
    out_diffuse = vec4(diffuse, viewZ);
    out_spec = vec4(spec, 0.0);
}
@end

// Pre-passe de profondeur : la scene est d'abord dessinee sans eclairage, pour que la passe
// eclairee ne calcule chaque pixel qu'une fois (pas de calcul pour les pixels caches).
@fs fs_depth_only
in vec3 v_world;
in vec3 v_normal;
in vec4 v_albedo;
in vec4 v_emissive;
void main() {
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
// Reglages communs aux deux passes de la fumee.
@block vol_uniforms
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
    vec4 tiles;        // xy : 1 / taille de l'atlas des tables, z : echantillons par faisceau, w : angle pixel fumee
    vec4 probe_min;    // w : indirect actif
    vec4 probe_cell;
    vec4 probe_dims;
};
layout(binding=6) uniform texture2D depth_tex;
layout(binding=7) uniform texture3D fog_tex;
layout(binding=8) uniform texture3D detail_tex;
layout(binding=1) uniform sampler point_smp;
layout(binding=2) uniform sampler lin_clamp_smp;
layout(binding=3) uniform sampler lin_repeat_smp;
@image_sample_type depth_tex unfilterable_float
@sampler_type point_smp nonfiltering

// Rayon de camera du pixel (fumee), et distance jusqu'a la premiere surface.
vec3 vol_ray(vec2 pix, out float tMax) {
    vec2 uv = pix / res.xy;
    vec2 ndc = ndc_from_uv(uv);
    vec3 dir = normalize(cam_fwd.xyz + cam_right.xyz * (ndc.x * cam_right.w) + cam_up.xyz * (ndc.y * cam_up.w));
    ivec2 fullPix = clamp(ivec2(uv * res.zw), ivec2(0), ivec2(res.zw) - 1);
    float viewZ = texelFetch(sampler2D(depth_tex, point_smp), fullPix, 0).r;
    tMax = viewZ / max(dot(dir, cam_fwd.xyz), 1e-3);
    return dir;
}
@end

@block ray_cone
// Intervalle [t0, t1] ou le rayon (sommet + co + t v) est dans le cone (axe d, cos^2 du demi-angle,
// longueur h). 'co' : origine du rayon vue depuis le sommet du cone.
bool ray_cone(vec3 co, vec3 v, vec3 d, float cos2, float h0, float h, out float t0, out float t1) {
    t0 = 0.0;
    t1 = 0.0;
    float vd = dot(v, d), cd = dot(co, d);
    // tranche le long de l'axe : h0 (la lentille) <= distance axiale <= h
    float s0 = -1e30, s1 = 1e30;
    if (abs(vd) > 1e-6) {
        float ta = (h0 - cd) / vd, tb = (h - cd) / vd;
        s0 = min(ta, tb);
        s1 = max(ta, tb);
    } else if (cd < h0 || cd > h) {
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
@end

// 5a. Lumiere indirecte diffusee par la fumee (la salle "s'allume") : plein ecran, ecrit le fond
//     de la fumee ; les faisceaux s'y ajoutent ensuite.
@fs fs_vol_ambient
@include_block common
@include_block vol_uniforms
layout(binding=15) uniform texture2D probe_a;
@include_block probe_sampling
@include_block fog_density

out vec4 frag_color;

void main() {
    float tMax;
    vec3 dir = vol_ray(gl_FragCoord.xy, tMax);
    vec3 cam = cam_pos.xyz;
    float sigmaAvg = fog_box_min.w;
    float jitter = fract(ign(gl_FragCoord.xy) + cam_fwd.w * 0.61803399);
    float tEnd = min(tMax, 90.0);
    const int NA = 4;
    float dt = tEnd / float(NA);
    vec3 amb = vec3(0.0);
    for (int k = 0; k < NA; k++) {
        float t = (float(k) + jitter) * dt;
        vec3 X = cam + dir * t;
        vec3 l0 = sample_probes_l0(X, probe_min.xyz, probe_cell.xyz, ivec3(probe_dims.xyz));
        float dens = fog_density(X, fog_box_min, fog_box_inv, fog0, fog1, fog2);
        amb += l0 * (0.282095 * dens * exp(-sigmaAvg * t) * dt);
    }
    frag_color = vec4(max(amb, vec3(0.0)) * fog0.x * fog1.w * fog2.w, 1.0);
}
@end

// 5b. Faisceaux : un cone par lyre (enveloppe, prisme compris), dessine en instances. Seules ses
//     faces arriere sont dessinees : chaque pixel couvert est calcule une fois, meme quand la camera
//     est dans le faisceau. Les resultats s'additionnent (melange additif).
@vs vs_beam
@glsl_options fixup_clipspace
@include_block common
layout(binding=1) uniform beam_vs_params {
    mat4 view_proj;
    vec4 info;        // x : debut de ce niveau dans la liste des faisceaux
};
layout(binding=18) readonly buffer lights_vs { sb_light vlights[]; };
layout(binding=21) readonly buffer beam_list_vs { sb_index beam_list[]; };   // faisceaux tries par niveau
in vec3 cone_pos;     // xy : cercle de rayon 1, z : 0 (sommet) .. 1 (bout du faisceau)
flat out int v_light;

// le polygone a 24 cotes doit contenir le cercle
const float CONE_INFLATE = 1.0086565;   // 1 / cos(pi / 24)

void main() {
    int li = int(beam_list[int(info.x) + gl_InstanceIndex].v);
    vec4 pr = vlights[li].pos_range;
    vec4 dte = vlights[li].dir_tanenv;
    vec3 up = vlights[li].up_tanbeam.xyz;
    vec3 rt = cross(dte.xyz, up);
    float axial = cone_pos.z * pr.w;
    float radius = axial * dte.w * CONE_INFLATE;
    vec3 w = pr.xyz + dte.xyz * axial + (up * cone_pos.x + rt * cone_pos.y) * radius;
    gl_Position = view_proj * vec4(w, 1.0);
    v_light = li;
}
@end

@fs fs_beam
@include_block common
@include_block vol_uniforms
layout(binding=0) readonly buffer lights_ssbo { sb_light lights[]; };
layout(binding=5) uniform texture2DArray gobo_tex;
layout(binding=0) uniform sampler gobo_smp;
@include_block beam_pattern
@include_block fog_density
@include_block ray_cone

flat in int v_light;
out vec4 frag_color;

void main() {
    float tMax;
    vec3 dir = vol_ray(gl_FragCoord.xy, tMax);
    vec3 cam = cam_pos.xyz;
    float g = fog0.w;
    float sigmaAvg = fog_box_min.w;
    float jitter = fract(ign(gl_FragCoord.xy) + cam_fwd.w * 0.61803399);
    int ns = int(tiles.z);
    int li = v_light;
    vec4 pr = lights[li].pos_range;
    vec4 dte = lights[li].dir_tanenv;
    float cos2 = 1.0 / (1.0 + dte.w * dte.w);
    // Tout est calcule depuis le point du rayon le plus proche de la lentille (t = delta), et
    // non depuis la camera : vu de loin, les equations d'un cone fin melangent de grands nombres
    // voisins et perdent leur precision (faisceau mal coupe ou mal pondere pres de la lentille).
    vec3 co = cam - pr.xyz;
    float delta = -dot(co, dir);
    vec3 cc = co + dir * delta;   // de la lentille au point le plus proche du rayon
    float t0, t1;                 // relatifs a delta
    float d0 = lights[li].optics.w;
    if (!ray_cone(cc, dir, dte.xyz, cos2, d0, pr.w, t0, t1)) {   // enveloppe
        discard;
    }
    t0 = max(t0, -delta);
    t1 = min(t1, tMax - delta);
    if (t1 <= t0) {
        discard;
    }
    vec4 cg = lights[li].color_gobo;
    vec4 op = lights[li].optics;
    beam_ctx b = make_beam(dte, lights[li].up_tanbeam, cg, lights[li].prism, op);
    // le rayon dans le repere du faisceau : X(t) = X.x + X.y * t, de meme pour Y et Z
    vec2 X = vec2(dot(cc, b.rt), dot(dir, b.rt));
    vec2 Y = vec2(dot(cc, b.up), dot(dir, b.up));
    vec2 Z = vec2(dot(cc, b.f), dot(dir, b.f));
    // intervalle exact ou le faisceau eclaire : reunion des cones des facettes (rayon = iris)
    float Ti = b.T * b.iris;
    float lo = 1e30, hi = -1e30;
    for (int k = 0; k < 9; k++) {
        if (k >= b.n) {
            break;
        }
        vec2 c = facet_center(b, k);
        vec2 iv = cone_interval(X - c.x * Z, Y - c.y * Z, Z, Ti * Ti, pr.w);
        if (iv.x < iv.y) {
            lo = min(lo, iv.x);
            hi = max(hi, iv.y);
        }
    }
    t0 = max(t0, lo);
    t1 = min(t1, hi);
    if (t1 <= t0) {
        discard;
    }
    // echantillonnage equiangulaire : les echantillons se resserrent pres de la lyre (1/d^2)
    float D = sqrt(dot(cc, cc) + 1e-6);
    float thA = atan(t0 / D), thB = atan(t1 / D);
    float acc = 0.0;
    for (int s = 0; s < 32; s++) {
        if (s >= ns) {
            break;
        }
        float u = (float(s) + jitter) / float(ns);
        float tr = D * tan(mix(thA, thB, u));   // relatif a delta
        float t = delta + tr;
        float z = Z.x + Z.y * tr;
        if (z <= d0) {
            continue;
        }
        vec2 p = vec2(X.x + X.y * tr, Y.x + Y.y * tr) / z;
        vec3 rel = cc + dir * tr;
        float dl = length(rel);
        float pat = beam_pattern(b, p, z, dl, t * tiles.w);
        if (pat <= 0.0) {
            continue;
        }
        float dens = fog_density(cam + dir * t, fog_box_min, fog_box_inv, fog0, fog1, fog2);
        float ph = phase_hg(-dot(rel, dir) / dl, g);
        acc += pat * dens * ph * exp(-sigmaAvg * (t + dl));
    }
    frag_color = vec4(cg.rgb * (acc * (thB - thA) / (D * float(ns))) * (fog0.x * fog1.w), 0.0);
}
@end

// 5c. Faisceaux, calcul analytique : meme lumiere que fs_beam, mais sans echantillons au hasard.
//     Le rayon est coupe en quelques morceaux ; sur chacun, l'image projetee est integree
//     exactement (table cumulee), et ce qui varie lentement (fumee, diffusion, attenuation,
//     distance) est pris au milieu du morceau. Pas de bruit, cout independant du prisme.
@fs fs_beam_an
@include_block common
@include_block vol_uniforms
layout(binding=0) readonly buffer lights_ssbo { sb_light lights[]; };
layout(binding=4) readonly buffer btabs_ro { sb_btab btabs[]; };
layout(binding=19) uniform texture2D table_tex;
@include_block fog_density
@include_block ray_cone

flat in int v_light;
out vec4 frag_color;

// Valeur cumulee de la couche 'lay' en (ligne, colonne), coordonnees continues en texels.
float table_at(vec4 lay, float row, float col) {
    vec2 tc = lay.xy + vec2(clamp(col, 0.0, lay.w - 1.0), clamp(row, 0.0, lay.z - 1.0)) + 0.5;
    return textureLod(sampler2D(table_tex, lin_clamp_smp), tc * tiles.xy, 0.0).r;
}

void main() {
    float tMax;
    vec3 dir = vol_ray(gl_FragCoord.xy, tMax);
    vec3 cam = cam_pos.xyz;
    float g = fog0.w;
    float sigmaAvg = fog_box_min.w;
    int li = v_light;
    vec4 pr = lights[li].pos_range;
    vec4 dte = lights[li].dir_tanenv;
    float cos2 = 1.0 / (1.0 + dte.w * dte.w);
    // depuis le point du rayon le plus proche de la lentille (precision, voir fs_beam)
    vec3 co = cam - pr.xyz;
    float delta = -dot(co, dir);
    vec3 cc = co + dir * delta;
    float t0, t1;
    if (!ray_cone(cc, dir, dte.xyz, cos2, lights[li].optics.w, pr.w, t0, t1)) {
        discard;
    }
    t0 = max(t0, -delta);
    t1 = min(t1, tMax - delta);
    if (t1 <= t0) {
        discard;
    }
    sb_btab B = btabs[li];
    // plan epipolaire du rayon : phi, et angle psi du point le plus proche de la lentille
    vec3 a = B.a_psimin.xyz;
    vec3 bv = dir - a * dot(dir, a);
    float bl = length(bv);
    if (bl < 1e-6) {
        discard;
    }
    bv /= bl;
    float phi = atan(dot(bv, B.e2_phimin.xyz), dot(bv, B.e1_psimax.xyz));
    float fphi = (phi - B.e2_phimin.w) / (B.info.x - B.e2_phimin.w);
    float D = max(length(cc), 1e-5);
    float psiH = atan(dot(cc, bv), dot(cc, a));
    float psiScale = 1.0 / (B.e1_psimax.w - B.a_psimin.w);
    float thA = atan(t0 / D), thB = atan(t1 / D);
    vec4 cg = lights[li].color_gobo;
    vec4 op = lights[li].optics;
    float T = lights[li].up_tanbeam.w;
    float lod0 = op.x * 5.0;
    float log2f = log2(max(op.y, 0.2));
    float Zx = dot(cc, dte.xyz), Zy = dot(dir, dte.xyz);
    int nl = int(B.info.z);
    // Flou : un seul choix pour tout le morceau de rayon (au milieu), pour que les morceaux partagent
    // leurs lectures de table aux frontieres.
    float thc = 0.5 * (thA + thB);
    float tc = D * tan(thc);
    float lod = beam_lod(lod0, log2f, T, max(Zx + Zy * tc, 1e-3), D / cos(thc), (delta + tc) * tiles.w);
    float lk = clamp((lod - B.info.y) / BTAB_LOD_STEP, 0.0, float(nl - 1));
    int k0 = int(floor(lk));
    float fk = lk - float(k0);
    vec4 L0 = btab_layer(B, k0);
    vec4 L1 = btab_layer(B, min(k0 + 1, nl - 1));
    float row0 = fphi * (L0.z - 1.0), row1 = fphi * (L1.z - 1.0);
    float cs0 = psiScale * (L0.w - 1.0), cs1 = psiScale * (L1.w - 1.0);
    float cb = psiH - B.a_psimin.w;
    // nombre de morceaux : reglage "echantillons" / 10 * 2 morceaux par radian (vus de la lyre)
    int K = clamp(int(ceil((thB - thA) * tiles.z * 0.2)), 1, 8);
    float Sprev = mix(table_at(L0, row0, (cb + thA) * cs0), table_at(L1, row1, (cb + thA) * cs1), fk);
    float acc = 0.0;
    for (int j = 1; j <= 8; j++) {
        if (j > K) {
            break;
        }
        float th1 = mix(thA, thB, float(j) / float(K));
        float S = mix(table_at(L0, row0, (cb + th1) * cs0), table_at(L1, row1, (cb + th1) * cs1), fk);
        float I = S - Sprev;
        Sprev = S;
        if (I <= 0.0) {
            continue;   // morceau hors du faisceau : pas de lecture de la fumee
        }
        // ce qui varie lentement : pris au milieu du morceau
        float thm = mix(thA, thB, (float(j) - 0.5) / float(K));
        float tm = D * tan(thm);
        float t = delta + tm;
        float dl = D / cos(thm);
        float dens = fog_density(cam + dir * t, fog_box_min, fog_box_inv, fog0, fog1, fog2);
        float ph = phase_hg(-sin(thm), g);
        acc += I * dens * ph * exp(-sigmaAvg * (t + dl));
    }
    frag_color = vec4(cg.rgb * (acc / D) * (fog0.x * fog1.w), 0.0);
}
@end

// 5d. Faisceaux tres doux (frost, flou) calcules a 1/2 et 1/4 de la resolution de la fumee : on les
//     ajoute ici, en n'interpolant qu'entre les points de profondeur proche (pas de fumee qui bave
//     sur le bord des objets).
@fs fs_vol_merge
layout(binding=0) uniform merge_params {
    vec4 res;      // xy : taille fumee, zw : taille du rendu plein
    vec4 t1;       // xy : taille du niveau 1, z : niveau 1 utilise
    vec4 t2;       // xy : taille du niveau 2, z : niveau 2 utilise
};
layout(binding=6) uniform texture2D depth_tex;
layout(binding=22) uniform texture2D vol_t1_tex;
layout(binding=23) uniform texture2D vol_t2_tex;
layout(binding=1) uniform sampler point_smp;
@image_sample_type vol_t1_tex unfilterable_float
@image_sample_type vol_t2_tex unfilterable_float

out vec4 frag_color;

float depth_at(vec2 uv) {
    ivec2 p = clamp(ivec2(uv * res.zw), ivec2(0), ivec2(res.zw) - 1);
    return texelFetch(sampler2D(depth_tex, point_smp), p, 0).r;
}

vec3 upsample(vec2 size, float z, bool second) {
    vec2 lp = gl_FragCoord.xy * (size / res.xy) - 0.5;
    ivec2 l0 = ivec2(floor(lp));
    vec2 f = lp - vec2(l0);
    ivec2 lmax = ivec2(size) - 1;
    vec3 acc = vec3(0.0);
    float wsum = 0.0;
    for (int k = 0; k < 4; k++) {
        ivec2 o = ivec2(k & 1, k >> 1);
        ivec2 lc = clamp(l0 + o, ivec2(0), lmax);
        // profondeur utilisee pour ce point du niveau (meme lecture que vol_ray)
        float dz = depth_at((vec2(lc) + 0.5) / size);
        float wb = (o.x == 1 ? f.x : 1.0 - f.x) * (o.y == 1 ? f.y : 1.0 - f.y);
        float wd = 1.0 / (0.02 + abs(dz - z) / max(z, 0.1) * 8.0);
        float w = wb * wd + 1e-5;
        vec3 c = second ? texelFetch(sampler2D(vol_t2_tex, point_smp), lc, 0).rgb : texelFetch(sampler2D(vol_t1_tex, point_smp), lc, 0).rgb;
        acc += c * w;
        wsum += w;
    }
    return acc / wsum;
}

void main() {
    float z = depth_at(gl_FragCoord.xy / res.xy);
    vec3 c = vec3(0.0);
    if (t1.z > 0.5) {
        c += upsample(t1.xy, z, false);
    }
    if (t2.z > 0.5) {
        c += upsample(t2.xy, z, true);
    }
    frag_color = vec4(c, 0.0);
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
    vec4 opts;         // x : fumee active, y : lyres douces actives, zw : taille de la passe des lyres douces
};
layout(binding=6) uniform texture2D depth_tex;
layout(binding=10) uniform texture2D vol_hist_tex;
layout(binding=11) uniform texture2D scene_tex;
layout(binding=24) uniform texture2D normal_tex;
layout(binding=25) uniform texture2D albedo_tex;
layout(binding=26) uniform texture2D soft_diffuse_tex;
layout(binding=27) uniform texture2D soft_spec_tex;
layout(binding=1) uniform sampler point_smp;
@image_sample_type soft_diffuse_tex unfilterable_float
@image_sample_type soft_spec_tex unfilterable_float

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
    if (opts.y > 0.5) {
        // lyres douces : 4 points de la passe a 1/4, ponderes par la profondeur et la normale
        vec3 N = texelFetch(sampler2D(normal_tex, point_smp), p, 0).xyz;
        vec4 am = texelFetch(sampler2D(albedo_tex, point_smp), p, 0);
        vec2 ssz = opts.zw;
        vec2 lp = gl_FragCoord.xy * (ssz / res.xy) - 0.5;
        ivec2 l0 = ivec2(floor(lp));
        vec2 f = lp - vec2(l0);
        ivec2 lmax = ivec2(ssz) - 1;
        vec3 dsum = vec3(0.0), ssum = vec3(0.0);
        float wsum = 0.0;
        for (int k = 0; k < 4; k++) {
            ivec2 o = ivec2(k & 1, k >> 1);
            ivec2 lc = clamp(l0 + o, ivec2(0), lmax);
            vec4 dv = texelFetch(sampler2D(soft_diffuse_tex, point_smp), lc, 0);
            ivec2 fc = clamp(ivec2((vec2(lc) + 0.5) / ssz * res.xy), ivec2(0), ivec2(res.xy) - 1);
            vec3 Nk = texelFetch(sampler2D(normal_tex, point_smp), fc, 0).xyz;
            float wb = (o.x == 1 ? f.x : 1.0 - f.x) * (o.y == 1 ? f.y : 1.0 - f.y);
            float wd = 1.0 / (0.02 + abs(dv.w - viewZ) / max(viewZ, 0.1) * 8.0);
            float wn = pow(max(dot(N, Nk), 0.0), 8.0);
            float w = wb * wd * wn + 1e-6;
            dsum += dv.rgb * w;
            ssum += texelFetch(sampler2D(soft_spec_tex, point_smp), lc, 0).rgb * w;
            wsum += w;
        }
        color += (am.rgb * (1.0 - am.a) * 0.31830989) * (dsum / wsum) + ssum / wsum;
    }
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
@program probes cs_probes
@program scene vs_scene fs_scene
@program scene_gb vs_scene fs_scene_gb
@program soft_light vs_fullscreen fs_soft_light
@program depth_only vs_scene fs_depth_only
@program vol_ambient vs_fullscreen fs_vol_ambient
@program beams vs_beam fs_beam
@program beams_an vs_beam fs_beam_an
@program vol_merge vs_fullscreen fs_vol_merge
@program beam_tables cs_beam_tables
@program pattern_images cs_pattern_images
@program temporal vs_fullscreen fs_temporal
@program composite vs_fullscreen fs_composite
@program bloom_down vs_fullscreen fs_bloom_down
@program bloom_up vs_fullscreen fs_bloom_up
@program final vs_fullscreen fs_final
