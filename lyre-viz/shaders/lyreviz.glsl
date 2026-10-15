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

// Obstacles dans le cone d'une lyre : x nombre de paves (0..8), y premier bloc de plans (voir occlusion).
struct sb_occ {
    uvec4 v;
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

// Les 3 couleurs (aberration chromatique axiale) : le rouge est net ez plus loin, le bleu ez plus pres
// (log2 de la distance). Seul l'ecart a la nettete change d'une couleur a l'autre.
vec3 beam_lod3(float lod0, float log2_focus, float T, float z, float dist, float pix_world, float ez) {
    float D = log2(max(dist, 0.2)) - log2_focus;
    float base = lod0 + log2(max(pix_world * 128.0 / (T * z), 1.0));
    return clamp(base + 1.4 * vec3(abs(D - ez), abs(D), abs(D + ez)), 0.0, 7.5);
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

// fs : echelle des ecarts des facettes du prisme (1 ; un peu plus ou moins selon la couleur, voir chroma).
float beam_pattern_lod_s(beam_ctx b, vec2 p, float lod, float fs) {
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
        vec2 q = (p - facet_center(b, min(k, b.n - 1)) * fs) * invT;
        float v = facet_value(b, q, lod, e0, prof);
        sum += (k < b.n) ? v : 0.0;
    }
    return sum / float(b.n);
}

float beam_pattern_lod(beam_ctx b, vec2 p, float lod) {
    return beam_pattern_lod_s(b, p, lod, 1.0);
}

float beam_pattern(beam_ctx b, vec2 p, float z, float dist, float pix_world) {
    return beam_pattern_lod(b, p, beam_lod(b.lod0, b.log2_focus, b.T, z, dist, pix_world));
}

// Aberration chromatique de l'optique (surfaces) : le verre devie plus le bleu que le rouge.
//  - laterale : l'image bleue est un peu plus grande, la rouge un peu plus petite (ch.x) ; le decalage
//    croit avec la distance a l'axe : franges bleues vers l'exterieur, rouges / jaunes vers l'axe ;
//  - prisme : il ecarte un peu plus les facettes bleues (ch.y) ;
//  - axiale : le bleu est net un peu plus pres, le rouge un peu plus loin (ch.z, en log2 de la distance).
//    Le frost diffuse toutes les couleurs pareil : l'ecart de flou entre couleurs s'efface avec lui.
// ch = (laterale, prisme, axiale, active). Le vert est l'image sans aberration (celle de la fumee).
vec3 beam_pattern_rgb(beam_ctx b, vec2 p, float z, float dist, float pix_world, vec4 ch) {
    if (ch.w < 0.5) {
        return vec3(beam_pattern(b, p, z, dist, pix_world));
    }
    vec3 lod3 = beam_lod3(b.lod0, b.log2_focus, b.T, z, dist, pix_world, ch.z * (1.0 - b.frost));
    float r = beam_pattern_lod_s(b, p / (1.0 - ch.x), lod3.r, 1.0 - ch.y);
    float g = beam_pattern_lod(b, p, lod3.g);
    float bl = beam_pattern_lod_s(b, p / (1.0 + ch.x), lod3.b, 1.0 + ch.y);
    return vec3(r, g, bl);
}
@end

// Image projetee en cache : desc = (x, y) du coin dans l'atlas, flou de la couche 0, 1 si presente.
// p : point dans le plan image (unites : tan), tenv : demi-largeur couverte par l'image.
// 2 lectures (deux niveaux de flou) au lieu d'une par facette du prisme.
// Necessite pimg_tex, lin_clamp_smp et tiles2 (xy : 1 / taille de l'atlas) declares avant l'inclusion.
// Canal r : l'image sans aberration chromatique. Avec l'aberration (atlas RGBA16F), g et b contiennent
// les images rouge et bleue (aberration laterale et du prisme). Sans elle, l'atlas est en R32F.
@block pattern_image
vec3 pimg_level(vec4 desc, vec2 uv, int k) {
    float sz = PIMG_SIZE / exp2(float(k));
    vec2 org = desc.xy;
    if (k > 0) {
        org += vec2(PIMG_SIZE, PIMG_SIZE - 2.0 * sz);
    }
    vec2 tc = org + clamp(uv * sz, vec2(0.5), vec2(sz - 0.5));
    return textureLod(sampler2D(pimg_tex, lin_clamp_smp), tc * pimg_inv, 0.0).rgb;
}

// Image sans aberration (fumee).
float pattern_image(vec4 desc, vec2 p, float tenv, float lod) {
    vec2 uv = p / (2.0 * tenv) + 0.5;
    float lv = clamp(lod - desc.z, 0.0, PIMG_LEVELS - 1.0);
    int k0 = int(floor(lv));
    int k1 = min(k0 + 1, int(PIMG_LEVELS) - 1);
    return mix(pimg_level(desc, uv, k0).r, pimg_level(desc, uv, k1).r, lv - float(k0));
}

// Surfaces : les 3 couleurs, chacune a son flou (aberration axiale : lod3 differe d'une couleur a l'autre).
// Memes 2 lectures : seul le melange des deux niveaux change selon la couleur. on : aberration active.
vec3 pattern_image_rgb(vec4 desc, vec2 p, float tenv, vec3 lod3, float on) {
    vec2 uv = p / (2.0 * tenv) + 0.5;
    float lv = clamp(lod3.g - desc.z, 0.0, PIMG_LEVELS - 1.0);
    int k0 = int(floor(lv));
    int k1 = min(k0 + 1, int(PIMG_LEVELS) - 1);
    vec3 c0 = pimg_level(desc, uv, k0);
    vec3 c1 = pimg_level(desc, uv, k1);
    if (on < 0.5) {
        return vec3(mix(c0.r, c1.r, lv - float(k0)));
    }
    vec3 t = clamp(lod3 - desc.z - float(k0), vec3(0.0), vec3(1.0));
    return mix(c0.grb, c1.grb, t);
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
    vec4 grid2;       // x : profondeur max, y : camera miroir (rectangles d'ombre)
};
layout(binding=0) readonly buffer lights_cs { sb_light lights[]; };
layout(binding=1) buffer clusters_rw { sb_index clusters_w[]; };
layout(binding=22) readonly buffer occ_lights_cs { sb_occ occ_lights[]; };
layout(binding=23) readonly buffer occ_planes_cs { sb_vec4 occ_planes[]; };
layout(binding=24) readonly buffer occ_tiles_cs { sb_index occ_tiles[]; };

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
            // ombres : un des volumes d'ombre de la lyre touche-t-il la case ? (sphere de la case contre
            // les plans de chaque volume) -> bit 16 : seules ces cases testent l'ombre pixel par pixel
            uint entry = uint(i);
            // paves dont le rectangle d'ecran touche cette colonne de cases : masque calcule sur le CPU
            // (memes 32 x 18 tuiles que les cases), une seule lecture
            uint tmask = (occ_tiles[(int(grid2.y) * 576 + iy * 32 + ix) * 64 + i / 4].v >> uint(8 * (i & 3))) & 255u;
            uvec4 oi = tmask != 0u ? occ_lights[i].v : uvec4(0u);
            for (int k = 0; k < 8; k++) {
                if ((tmask >> uint(k)) == 0u) {
                    break;
                }
                if ((tmask & (1u << uint(k))) == 0u) {
                    continue;
                }
                // plage de profondeur du volume (CPU) contre la tranche de la case : test large, le pixel
                // fait ensuite le test exact
                vec4 zr = occ_planes[(int(oi.y) + k) * 13 + 3].v;
                vec2 zz = grid2.y > 0.5 ? zr.zw : zr.xy;
                if (z1 >= zz.x && z0 <= zz.y) {
                    entry |= 65536u << uint(k);   // bits 16..23 : paires dont l'ombre touche la case
                }
            }
            clusters_w[base + 1 + count].v = entry;
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
@block pattern_images_body
@include_block common
layout(binding=0) readonly buffer lights_cs { sb_light lights[]; };
layout(binding=26) readonly buffer pimg_desc_cs { sb_vec4 pdesc[]; };
layout(binding=27) readonly buffer pimg_list_cs { sb_index plist[]; };
layout(binding=5) uniform texture2DArray gobo_tex_ci;
layout(binding=0) uniform sampler gobo_smp_ci;
#define gobo_tex gobo_tex_ci
#define gobo_smp gobo_smp_ci
layout(binding=0) uniform pimg_params {
    vec4 chroma;   // aberration chromatique : laterale, prisme, axiale, active (voir beam_pattern_rgb)
};
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
    float lod = desc.z + float(k);
    // r : image sans aberration (fumee, et surfaces si l'aberration est coupee : atlas R32F) ;
    // g, b : images rouge et bleue avec l'aberration laterale et celle du prisme (atlas RGBA16F)
    vec4 v = vec4(beam_pattern_lod(b, p, lod));
    if (chroma.w > 0.5) {
        v.g = beam_pattern_lod_s(b, p / (1.0 - chroma.x), lod, 1.0 - chroma.y);
        v.b = beam_pattern_lod_s(b, p / (1.0 + chroma.x), lod, 1.0 + chroma.y);
    }
    imageStore(pimg_w, ivec2(desc.xy) + xy, v);
}
@end

// Aberration coupee : atlas R32F (comme avant, 2 fois moins d'octets a lire que RGBA16F).
@cs cs_pattern_images
layout(binding=28, r32f) uniform writeonly image2D pimg_w;
@include_block pattern_images_body
@end

// Aberration active : atlas RGBA16F (r : image, g : rouge, b : bleu).
@cs cs_pattern_images_rgb
layout(binding=28, rgba16f) uniform writeonly image2D pimg_w_rgb;
#define pimg_w pimg_w_rgb
@include_block pattern_images_body
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
    vec4 pd = pdesc[li].v;   // image projetee en cache (prisme) ? (2 : lyre sans prisme, surfaces seulement)
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
                        inc += (pd.w > 0.5 && pd.w < 1.5) ? pattern_image(pd, p, L.dir_tanenv.w, lod) : beam_pattern_lod(b, p, lod);
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

// -------------------------------------------------------------------------------------
//  Ombres des obstacles fixes (paves : scene, decor, mannequins, cube suspendu).
//  Pour chaque lyre, le CPU garde les paves qui touchent son cone (8 au plus, presque toujours 0
//  a 2) et calcule le VOLUME D'OMBRE de chacun vu de la lentille : un convexe defini par 9 plans au
//  plus (faces eclairees + plans des aretes de silhouette), en coordonnees monde, n.X <= h.
//  occ_lights[lyre] = (nombre de paves, premier bloc) ; un bloc = 13 vec4 : (nombre de plans), rectangle
//  de l'ecran couvert par le volume (camera, puis camera miroir), plage de profondeur (camera, miroir),
//  plans.
//  Tri : sur le CPU, rectangle d'ecran et plage de profondeur de chaque volume -> masques par tuile
//  d'ecran (32 x 18) ; le calcul des cases de lumiere en deduit, pour chaque case et chaque lyre, les
//  paves dont l'ombre peut la toucher (bits 16..23 de l'entree de la case). Un pixel ne teste que
//  ceux-la ; un pixel de fumee lit le masque de sa tuile. Sans ombre pres d'un pixel : rien de plus.
//  - surfaces : le point est-il dans un volume d'ombre ? (produits scalaires, sortie au 1er plan) ;
//  - fumee : morceau exact du rayon dans le volume (decoupe de la droite par les plans).
//  Ne depend ni du gobo, ni du prisme, ni du zoom : seulement de la lentille et des paves.
//  Necessite occ_lights et occ_planes declares avant l'inclusion.
// -------------------------------------------------------------------------------------
@block occlusion
const int OCC_BLOCK = 13;

// Le point P est-il dans un des volumes d'ombre de la lyre designes par le masque (bit k : k-ieme pave) ?
bool occ_blocked_mask(uvec4 oi, vec3 P, uint mask) {
    for (int k = 0; k < 8; k++) {
        if ((mask >> uint(k)) == 0u) {
            break;
        }
        if ((mask & (1u << uint(k))) == 0u) {
            continue;
        }
        int base = (int(oi.y) + k) * OCC_BLOCK;
        int np = int(occ_planes[base].v.x);
        bool inside = true;
        for (int q = 0; q < 9; q++) {
            if (q >= np) {
                break;
            }
            vec4 pl = occ_planes[base + 4 + q].v;
            if (dot(pl.xyz, P) > pl.w) {
                inside = false;
                break;
            }
        }
        if (inside) {
            return true;
        }
    }
    return false;
}

// Part de la lumiere de la lyre qui atteint P (0 : ombre, 1 : eclaire), avec penombre : la lentille n'est pas
// un point. Distance signee de P au volume d'ombre (le plus grand ecart aux plans, normales unitaires),
// adoucie sur la largeur de la penombre : rayon de la lentille x (distance pave -> P) / (lentille -> pave).
// Bord net quand l'obstacle est pres de la surface, doux quand il est pres de la lyre.
float occ_light(uvec4 oi, vec3 P, uint mask, vec3 Lw) {
    float vis = 1.0;
    float dP = length(P - Lw);
    for (int k = 0; k < 8; k++) {
        if ((mask >> uint(k)) == 0u) {
            break;
        }
        if ((mask & (1u << uint(k))) == 0u) {
            continue;
        }
        int base = (int(oi.y) + k) * OCC_BLOCK;
        vec4 hd = occ_planes[base].v;   // nombre de plans, distance lentille -> pave, rayon de la lentille
        float w = max(hd.z * max(dP - hd.y, 0.0) / max(hd.y, 0.1), 0.004);
        float m = -1e30;
        for (int q = 0; q < 9; q++) {
            if (q >= int(hd.x)) {
                break;
            }
            vec4 pl = occ_planes[base + 4 + q].v;
            m = max(m, dot(pl.xyz, P) - pl.w);
            if (m >= w) {
                break;   // hors de la penombre : eclaire par ce pave
            }
        }
        vis *= smoothstep(-w, w, m);
        if (vis <= 0.0) {
            break;
        }
    }
    return vis;
}

// Morceau [ta, tb] du rayon cam + t dir dans le volume d'ombre du bloc 'blk' ; faux s'il est vide.
bool occ_interval(int blk, vec3 cam, vec3 dir, out float ta, out float tb) {
    ta = -1e30;
    tb = 1e30;
    int base = blk * OCC_BLOCK;
    int np = int(occ_planes[base].v.x);
    for (int q = 0; q < 9; q++) {
        if (q >= np) {
            break;
        }
        vec4 pl = occ_planes[base + 4 + q].v;
        float nd = dot(pl.xyz, dir);
        float num = pl.w - dot(pl.xyz, cam);
        if (abs(nd) < 1e-9) {
            if (num < 0.0) {
                return false;
            }
        } else if (nd > 0.0) {
            tb = min(tb, num / nd);
        } else {
            ta = max(ta, num / nd);
        }
    }
    return tb > ta;
}
@end

// Tuiles d'ecran des ombres (passes des faisceaux) : necessite occ_tiles.
@block occlusion_tiles
// Masque des paves de la lyre li dont l'ombre touche la tuile d'ecran du pixel (32 x 18 tuiles, ndc ;
// side 1 camera, 2 miroir). Rempli sur le CPU avec les rectangles : une seule lecture par pixel.
uint occ_tile_mask(int li, vec2 ndc, int side) {
    ivec2 t = clamp(ivec2((ndc * 0.5 + 0.5) * vec2(32.0, 18.0)), ivec2(0), ivec2(31, 17));
    int idx = ((side - 1) * 576 + t.y * 32 + t.x) * 64 + li / 4;
    return (occ_tiles[idx].v >> uint(8 * (li & 3))) & 255u;
}

@end

// Sol en beton texture (Concrete031, ambientCG) : voir src/floor_texture.h.
// La texture contient 4 x 4 dalles separees par des joints. Chaque dalle du sol prend une dalle de la
// texture au hasard, tournee d'un quart de tour et retournee au hasard (128 variantes) : les joints
// restent alignes et aucune repetition ne se voit de loin, pour une seule lecture par texture.
// Necessite floor_tex, floor_smp et les uniformes floor_p, floor_q declares avant l'inclusion.
// Eau au sol : quantite d'eau en un point du sol (materiau du sol, masque du reflet).
// Necessite floor_cav, floor_smp, floor_p et floor_w declares avant l'inclusion.
@block floor_water
// Meme calcul que floor_hash() dans src/floor_texture.h.
uint floor_hash(ivec2 c) {
    uint h = uint(c.x) * 0x8da6b343u ^ uint(c.y) * 0xd8163841u;
    h ^= h >> 13u;
    h *= 0x5bd1e995u;
    h ^= h >> 15u;
    return h;
}

// Bruit de valeur lisse (0..1) : cuvettes ou l'eau s'accumule.
float floor_noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = p - i;
    f = f * f * (3.0 - 2.0 * f);
    ivec2 c = ivec2(i);
    float a = float(floor_hash(c) & 65535u);
    float b = float(floor_hash(c + ivec2(1, 0)) & 65535u);
    float d = float(floor_hash(c + ivec2(0, 1)) & 65535u);
    float e = float(floor_hash(c + ivec2(1, 1)) & 65535u);
    return mix(mix(a, b, f.x), mix(d, e, f.x), f.y) * (1.0 / 65535.0);
}

// Dalle de la texture sous le point fw (coordonnees en dalles) : uv dans la texture, et M, rotation et
// retournement de la dalle (memes calculs que FloorTexture::albedo_at).
void floor_tile(vec2 fw, out vec2 uv, out mat2 M) {
    vec2 cell = floor(fw);
    vec2 q = fw - cell - 0.5;
    uint h = floor_hash(ivec2(cell));
    uint rot = h & 3u;
    uint idx = (h >> 2u) & 15u;
    float s = (rot & 2u) != 0u ? -1.0 : 1.0;
    M = (rot & 1u) != 0u ? mat2(0.0, s, -s, 0.0) : mat2(s, 0.0, 0.0, s);
    if ((h & 64u) != 0u) {
        M = mat2(-1.0, 0.0, 0.0, 1.0) * M;
    }
    uv = (vec2(float(idx & 3u), float(idx >> 2u)) + M * q + 0.5) * 0.25;
}

// Eau au sol (curseur floor_p.y), d'apres Lagarde, « Water drop 2b » et « 3b ». Le niveau d'eau monte :
//  1. les creux du beton (trous, pores, joints : floor_cav) se remplissent d'abord : miroir affleurant ;
//  2. puis des flaques, de plus en plus nombreuses et grandes : cuvettes de quelques metres (bruit en
//     coordonnees du monde, sans repetition) dont le bord suit les creux ; chaque flaque a un bord de
//     beton detrempe (plus sombre, plus brillant) ;
//  3. le reste du sol reste sec jusqu'a la moitie, puis se mouille ; a 1, l'eau couvre tout.
// floor_w (calcule sur le CPU, FloorTexture::water_levels) : x niveau des flaques, y niveau des creux,
// z film d'eau. Les niveaux suivent les repartitions de hF et hP : 2 % de flaques a 0,1, tout a 1.
// Renvoie (flaque, bord detrempe, creux remplis), de 0 a 1. margin elargit l'eau (masque du reflet).
// Profondeur des creux du beton (0 : fond d'un trou, 1 : surface).
float floor_cavity(vec2 uv, mat2 M, vec2 gx, vec2 gy) {
    return textureGrad(sampler2D(floor_cav, floor_smp), uv, (M * gx) * 0.25, (M * gy) * 0.25).r;
}

// Cuvettes ou l'eau s'accumule (sans les creux) : varie lentement (motifs de 1,5 a 5 m).
float floor_basins(vec2 fw) {
    vec2 pm = fw / floor_p.x;   // metres
    return 0.55 * floor_noise(pm * 0.22) + 0.30 * floor_noise(pm * 0.7 + 17.0) + 0.15 * floor_noise(pm * 2.1 + 33.0);
}

// hP : creux (floor_cavity), hB : cuvettes (floor_basins).
vec3 floor_water_at(float hP, float hB, vec2 gx, vec2 gy, float margin) {
    float hF = hB + 0.15 * (hP - 0.5);
    float d = floor_w.x - hF + margin;
    // bord de flaque : net, mais sur au moins un pixel (sinon il scintille en 4K)
    float pix = (length(gx) + length(gy)) / floor_p.x;
    float puddle = smoothstep(0.0, max(0.004, 0.6 * pix), d);
    float rim = smoothstep(-0.03, 0.0, d);                               // beton detrempe autour de la flaque
    float holes = clamp((floor_w.y + margin - hP) / 0.06, 0.0, 1.0);     // eau dans les creux
    return vec3(puddle, rim, holes);
}

vec3 floor_water(vec2 uv, mat2 M, vec2 fw, vec2 gx, vec2 gy, float margin) {
    return floor_water_at(floor_cavity(uv, M, gx, gy), floor_basins(fw), gx, gy, margin);
}
@end

@block floor_material
@include_block floor_water

// Materiau du sol au point P. fw, gx, gy : coordonnees en dalles (P.xz * floor_p.x) et leurs derivees
// a l'ecran (calculees hors de tout branchement). Modifie N, albedo, rough ; renvoie la quantite d'eau
// en surface (0 : pas d'eau, 1 : flaque). Une seule lecture de texture (voir src/floor_texture.h) :
// le filtrage anisotrope multiplie le cout de chaque lecture.
float floor_material(vec2 fw, vec2 gx, vec2 gy, inout vec3 N, inout vec3 albedo, inout float rough) {
    vec2 uv;
    mat2 M;
    floor_tile(fw, uv, M);
    // derivees continues (celles du sol, tournees) : pas de couture de mipmap aux joints
    vec4 t = textureGrad(sampler2D(floor_tex, floor_smp), uv, (M * gx) * 0.25, (M * gy) * 0.25);

    // normale (format DirectX : y vers les v croissants = +Z du monde), ramenee dans le repere du sol ;
    // moyennee dans les mipmaps, elle raccourcit : z reconstruit plus grand = relief adouci au loin
    vec2 nt = t.yz * 2.0 - 1.0;
    vec2 nxz = transpose(M) * nt;
    N = normalize(vec3(nxz.x, sqrt(max(1.0 - dot(nt, nt), 0.0)), nxz.y));
    rough = max(t.w, 0.04);   // recentree sur le beton uni et elargie au loin (Toksvig), voir floor_texture.cpp
    albedo = floor_q.rgb * (t.x * t.x);

    // Eau au sol (voir floor_water). Dans l'eau : normale plate, surface lisse ; le reflet (passe miroir)
    // y est toujours net.
    // Seulement dans les variantes FLOOR_WET (fs_scene_wet...) : par temps sec, le code de l'eau, meme
    // jamais execute, ralentissait la boucle des lyres de la passe des surfaces (+0,25 ms, +0,9 avec prisme).
    float water = 0.0;
#ifdef FLOOR_WET
    [[dont_flatten]] if (floor_p.y > 0.0) {
        vec3 w = floor_water(uv, M, fw, gx, gy, 0.0);
        float puddle = w.x, holes = w.z;
        float wetAmt = max(max(floor_w.z, w.y), holes);
        // beton mouille : l'eau remplit les pores (porosite du beton ~0,75) : plus sombre, plus brillant
        albedo *= mix(1.0, 0.45, wetAmt);
        rough = mix(rough, max(rough * 0.4, 0.12), wetAmt);
        // eau : surface plate et lisse (rugosite 0,05 : un reflet de lampe plus petit qu'un pixel scintillerait)
        water = max(puddle, holes);
        rough = mix(rough, 0.05, water);
        N = normalize(mix(N, vec3(0.0, 1.0, 0.0), water));
    }
#endif
    return water;
}
@end

@block scene_fs_body
#extension GL_EXT_control_flow_attributes : require
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
    vec4 floor_p;     // sol texture : x : dalles par metre (4 / repetition), y : eau (0..1), w : actif
    vec4 floor_q;     // rgb : couleur lineaire = R^2 * floor_q.rgb, w : 1 / R moyen
    vec4 floor_w;     // eau au sol : x niveau des flaques, y niveau des creux, z film d'eau (voir floor_material)
    vec4 chroma;      // aberration chromatique : laterale, prisme, axiale, active (voir beam_pattern_rgb)
};
layout(binding=0) readonly buffer lights_ssbo { sb_light lights[]; };
layout(binding=1) readonly buffer clusters_ro { sb_index clusters[]; };
layout(binding=5) uniform texture2DArray gobo_tex;
layout(binding=30) uniform texture2D floor_tex;
layout(binding=31) uniform texture2D floor_cav;   // creux du beton (eau au sol)
layout(binding=4) uniform sampler floor_smp;
layout(binding=22) readonly buffer occ_lights_ro { sb_occ occ_lights[]; };
layout(binding=23) readonly buffer occ_planes_ro { sb_vec4 occ_planes[]; };
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
@include_block occlusion
@include_block floor_material

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
    float metal = max(v_emissive.a, 0.0);   // -1 : sol en beton texture (non metallique)
    // sol texture : derivees calculees ici, hors de tout branchement
    vec2 fw = P.xz * floor_p.x;
    vec2 fgx = dFdx(fw);
    vec2 fgy = dFdy(fw);
    // vrai branchement : sinon le compilateur HLSL execute le materiau du sol sur tous les pixels
    float water = 0.0;
    [[dont_flatten]] if (v_emissive.a < -0.5 && floor_p.w > 0.5) {
        water = floor_material(fw, fgx, fgy, N, albedo, rough);
    }
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
    // lyres nettes seulement (les douces sont dans leur passe a 1/4) ; passe miroir (probe_cell.w) : toutes
    uint head = clusters[base].v;
    int count = (cam_pos.w > 0.5) ? int(probe_cell.w > 0.5 ? (head >> 16) : (head & 65535u)) : 0;

    vec3 diffuse = vec3(0.0);
    vec3 spec = vec3(0.0);
    for (int i = 0; i < count; i++) {
        // les donnees de la lyre ne sont lues qu'au fur et a mesure des tests
        uint ce = clusters[base + 1 + i].v;   // lyre (16 bits) ; bits 16..23 : ombres qui touchent la case
        uint li = ce & 65535u;
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
        if (z <= lights[li].optics.w || z > lights[li].pos_range.w) {   // derriere la lentille, ou apres un obstacle
            continue;
        }
        vec4 ut = lights[li].up_tanbeam;
        vec2 p = vec2(dot(rel, cross(dte.xyz, ut.xyz)), dot(rel, ut.xyz)) / z;
        if (dot(p, p) > dte.w * dte.w) {   // hors de l'enveloppe
            continue;
        }
        vec4 cg = lights[li].color_gobo;
        vec4 pd = pdesc[li].v;
        vec3 pat;   // image projetee, par couleur (aberration chromatique)
        if (pd.w > 0.5) {
            // image projetee en cache (prisme) : seul le flou est a calculer (un par couleur : aberration axiale)
            vec4 op = lights[li].optics;
            vec3 lod3 = beam_lod3(op.x * 5.0, log2(max(op.y, 0.2)), ut.w, z, d, pixWorld, chroma.z * (1.0 - op.x));
            pat = pattern_image_rgb(pd, p, dte.w, lod3, chroma.w);
        } else {
            beam_ctx b = make_beam(dte, ut, cg, lights[li].prism, lights[li].optics);
            pat = beam_pattern_rgb(b, p, z, d, pixWorld, chroma);
        }
        if (max(pat.r, max(pat.g, pat.b)) <= 0.0) {
            continue;
        }
        if (ce > 65535u) {   // un volume d'ombre de la lyre touche cette case : ombre et penombre
            float sh = occ_light(occ_lights[li].v, P, ce >> 16u, lights[li].pos_range.xyz + dte.xyz * lights[li].optics.w);
            if (sh <= 0.0) {
                continue;
            }
            pat *= sh;
        }
        vec3 E = cg.rgb * pat * (nl * exp(-sigma * d) / max(d2, 0.04));
        diffuse += E;
        if (shade.z > 0.5) {
            spec += E * ggx_spec(N, V, l, rough, f0);
        }
    }
    // dans l'eau, le reflet des lentilles est celui de la passe miroir (composition) : pas deux fois
    vec3 color = diffColor * diffuse * 0.31830989 + spec * (1.0 - water);

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

// Sol mouille (curseur d'eau > 0) : memes passes, avec l'eau au sol (floor_material).
@fs fs_scene_wet
#define FLOOR_WET 1
@include_block scene_fs_body
@end

// Meme passe, qui ecrit aussi normale et matiere pour la passe des lyres douces.
@fs fs_scene_gb
#define SCENE_GBUFFER 1
@include_block scene_fs_body
@end

@fs fs_scene_gb_wet
#define SCENE_GBUFFER 1
#define FLOOR_WET 1
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
    vec4 chroma;      // aberration chromatique (comme scene_fs_params)
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
layout(binding=22) readonly buffer occ_lights_ro { sb_occ occ_lights[]; };
layout(binding=23) readonly buffer occ_planes_ro { sb_vec4 occ_planes[]; };
@image_sample_type normal_tex unfilterable_float
#define pimg_inv shade.xy
@include_block beam_pattern
@include_block pattern_image
@include_block occlusion
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
        uint ce = clusters[base + 1 + i].v;   // lyre (16 bits) ; bits 16..23 : ombres qui touchent la case
        uint li = ce & 65535u;
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
        if (z <= lights[li].optics.w || z > lights[li].pos_range.w) {   // derriere la lentille, ou apres un obstacle
            continue;
        }
        vec4 ut = lights[li].up_tanbeam;
        vec2 p = vec2(dot(rel, cross(dte.xyz, ut.xyz)), dot(rel, ut.xyz)) / z;
        if (dot(p, p) > dte.w * dte.w) {
            continue;
        }
        vec4 cg = lights[li].color_gobo;
        vec4 pd = pdesc[li].v;
        vec3 pat;   // image projetee, par couleur (aberration chromatique)
        if (pd.w > 0.5) {
            // image projetee en cache (prisme) : seul le flou est a calculer (un par couleur : aberration axiale)
            vec4 op = lights[li].optics;
            vec3 lod3 = beam_lod3(op.x * 5.0, log2(max(op.y, 0.2)), ut.w, z, d, pixWorld, chroma.z * (1.0 - op.x));
            pat = pattern_image_rgb(pd, p, dte.w, lod3, chroma.w);
        } else {
            beam_ctx b = make_beam(dte, ut, cg, lights[li].prism, lights[li].optics);
            pat = beam_pattern_rgb(b, p, z, d, pixWorld, chroma);
        }
        if (max(pat.r, max(pat.g, pat.b)) <= 0.0) {
            continue;
        }
        if (ce > 65535u) {   // un volume d'ombre de la lyre touche cette case : ombre et penombre
            float sh = occ_light(occ_lights[li].v, P, ce >> 16u, lights[li].pos_range.xyz + dte.xyz * lights[li].optics.w);
            if (sh <= 0.0) {
                continue;
            }
            pat *= sh;
        }
        vec3 E = cg.rgb * pat * (nl * exp(-sigma * d) / max(d2, 0.04));
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
// Reflet : profondeur 0 hors de l'eau (passe fs_refl_mask) : pas de faisceau a calculer.
#define VOL_RAY_SKIP(tMax) if (tMax <= 0.0) { discard; }
@end

// Faisceaux du reflet : seulement ou il y a de l'eau (masque de fs_refl_mask, a la resolution du miroir,
// 2 fois celle des faisceaux). Lu en bilineaire au centre du pixel des faisceaux : moyenne des 2 x 2
// pixels du miroir qu'il couvre, non nulle si l'un d'eux est mouille. probe_cell.w : camera miroir.
// Necessite vol_uniforms.
@block beam_mask
layout(binding=9) uniform texture2D beam_mask_tex;
#define BEAM_MASK_SKIP() if (probe_cell.w > 0.5 && textureLod(sampler2D(beam_mask_tex, lin_clamp_smp), gl_FragCoord.xy / res.xy, 0.0).r <= 0.0) { discard; }
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
    VOL_RAY_SKIP(tMax)
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
layout(binding=22) readonly buffer occ_lights_ro { sb_occ occ_lights[]; };
layout(binding=23) readonly buffer occ_planes_ro { sb_vec4 occ_planes[]; };
layout(binding=24) readonly buffer occ_tiles_ro { sb_index occ_tiles[]; };
@include_block occlusion
@include_block occlusion_tiles
@include_block beam_pattern
@include_block fog_density
@include_block ray_cone
@include_block beam_mask

flat in int v_light;
out vec4 frag_color;

void main() {
    float tMax;
    vec3 dir = vol_ray(gl_FragCoord.xy, tMax);
    VOL_RAY_SKIP(tMax)
    BEAM_MASK_SKIP()
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
    uint omask = occ_tile_mask(li, ndc_from_uv(gl_FragCoord.xy / res.xy), probe_cell.w > 0.5 ? 2 : 1);   // ombres
    uvec4 oi = omask != 0u ? occ_lights[li].v : uvec4(0u);
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
        if (omask != 0u && occ_blocked_mask(oi, cam + dir * t, omask)) {
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
layout(binding=22) readonly buffer occ_lights_ro { sb_occ occ_lights[]; };
layout(binding=23) readonly buffer occ_planes_ro { sb_vec4 occ_planes[]; };
layout(binding=24) readonly buffer occ_tiles_ro { sb_index occ_tiles[]; };
@include_block fog_density
@include_block ray_cone
@include_block occlusion
@include_block occlusion_tiles
@include_block beam_mask

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
    VOL_RAY_SKIP(tMax)
    BEAM_MASK_SKIP()
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
    // ombres des paves : integrale de chaque morceau du rayon dans un volume d'ombre (difference de deux
    // valeurs de la table, termes lents pris en son milieu), retiree. Deux ombres qui se chevauchent
    // sur le rayon seraient retirees deux fois : le total est borne a 0.
    uint omask = occ_tile_mask(li, ndc_from_uv(gl_FragCoord.xy / res.xy), probe_cell.w > 0.5 ? 2 : 1);
    uvec4 oi = omask != 0u ? occ_lights[li].v : uvec4(0u);
    for (int k = 0; k < 8; k++) {
        if ((omask >> uint(k)) == 0u) {
            break;
        }
        if ((omask & (1u << uint(k))) == 0u) {
            continue;
        }
        float sa, sb;
        if (!occ_interval(int(oi.y) + k, cam, dir, sa, sb)) {
            continue;
        }
        float lo = max(atan((sa - delta) / D), thA), hi = min(atan((sb - delta) / D), thB);
        if (hi <= lo) {
            continue;
        }
        float I = mix(table_at(L0, row0, (cb + hi) * cs0), table_at(L1, row1, (cb + hi) * cs1), fk)
                - mix(table_at(L0, row0, (cb + lo) * cs0), table_at(L1, row1, (cb + lo) * cs1), fk);
        if (I <= 0.0) {
            continue;
        }
        float thm = 0.5 * (lo + hi);
        float t = delta + D * tan(thm);
        float dl = D / cos(thm);
        float dens = fog_density(cam + dir * t, fog_box_min, fog_box_inv, fog0, fog1, fog2);
        acc -= I * dens * phase_hg(-sin(thm), g) * exp(-sigmaAvg * (t + dl));
    }
    acc = max(acc, 0.0);
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
// -------------------------------------------------------------------------------------
//  6b. Reflet du sol mouille : composition de l'image miroir (surfaces attenuees par la fumee +
//      faisceaux), a demi-resolution. Les niveaux plus flous sont faits par la reduction du bloom.
// -------------------------------------------------------------------------------------
// Masque du reflet (passe miroir) : ou y a-t-il de l'eau au sol, pixel par pixel de l'image miroir ?
// (seulement la presence d'eau : la quantite est calculee par la composition)
// Le point du sol est celui que voit la camera principale a la meme place a l'ecran (le reflet y est lu
// par la composition). Passe 1 : eau sous chaque pixel du miroir ; passe 2 (fs_refl_block) : blocs.
// Marge : l'eau est un peu elargie (bords des flaques ; le bruit des cuvettes est pris au centre).
@fs fs_refl_mask
#extension GL_EXT_control_flow_attributes : require
@include_block common
layout(binding=5) uniform refl_mask_params {
    vec4 cam_pos;      // camera principale
    vec4 cam_right;    // w : tan x
    vec4 cam_up;       // w : tan y
    vec4 cam_fwd;
    vec4 res;          // xy : taille du miroir, zw : taille du rendu plein
    vec4 floor_p;      // comme scene_fs_params
    vec4 floor_w;
};
layout(binding=6) uniform texture2D depth_tex;     // profondeur lineaire de la camera principale
layout(binding=31) uniform texture2D floor_cav;
layout(binding=1) uniform sampler point_smp;
layout(binding=4) uniform sampler floor_smp;
@include_block floor_water
layout(location=0) out vec4 frag_wet;   // 1 : de l'eau sous l'un des 4 pixels pleins
// Point du sol vu par la camera principale au pixel plein fp (y : hauteur, 1000 si rien).
vec3 floor_point(ivec2 fp) {
    float viewZ = texelFetch(sampler2D(depth_tex, point_smp), fp, 0).r;
    vec2 ndc = ndc_from_uv((vec2(fp) + 0.5) / res.zw);
    vec3 dir = normalize(cam_fwd.xyz + cam_right.xyz * (ndc.x * cam_right.w) + cam_up.xyz * (ndc.y * cam_up.w));
    vec3 P = cam_pos.xyz + dir * (viewZ / max(dot(dir, cam_fwd.xyz), 1e-3));
    return viewZ < 900.0 ? P : vec3(0.0, 1000.0, 0.0);
}

void main() {
    // les 4 pixels pleins couverts par ce pixel du miroir (la composition y lit le reflet) : les creux
    // remplis ne font souvent qu'un pixel
    vec2 r = res.zw / res.xy;
    ivec2 base = ivec2(floor((gl_FragCoord.xy - 0.5) * r + 0.5));
    ivec2 fmax = ivec2(res.zw) - 1;
    vec3 Pc = floor_point(clamp(base, ivec2(0), fmax));
    vec2 fwc = Pc.xz * floor_p.x;
    vec2 gx = dFdx(fwc) / r.x;   // derivees d'un pixel plein (meme flou des creux que la composition)
    vec2 gy = dFdy(fwc) / r.y;
    bool wet = false;
    float hB = floor_basins(fwc);   // varie lentement : une fois pour les 4 pixels (marge ci-dessous)
    for (int k = 0; k < 4; k++) {
        vec3 P = floor_point(clamp(base + ivec2(k & 1, k >> 1), ivec2(0), fmax));
        if (abs(P.y) < 0.03) {
            vec2 fw = P.xz * floor_p.x;
            vec2 tuv;
            mat2 M;
            floor_tile(fw, tuv, M);
            vec3 w = floor_water_at(floor_cavity(tuv, M, gx, gy), hB, gx, gy, 0.02);
            wet = wet || max(w.x, w.z) > 0.0;
        }
    }
    frag_wet = vec4(wet ? 1.0 : 0.0, 0.0, 0.0, 1.0);
}
@end

// Masque du reflet, passe 2 : par blocs de 2 x 2 pixels du miroir (un pixel des faisceaux du miroir) :
// tout le bloc est calcule si l'un de ses pixels est mouille. Hors des blocs mouilles : profondeur au plus
// pres (Z inverse : 1 ; la scene miroir y est rejetee avant le shader) et profondeur lineaire a 0.
@fs fs_refl_block
layout(binding=12) uniform texture2D src_tex;   // eau par pixel (fs_refl_mask)
layout(binding=1) uniform sampler point_smp;
layout(location=0) out vec4 frag_depth_lin;
void main() {
    ivec2 b = (ivec2(gl_FragCoord.xy) / 2) * 2;
    ivec2 m = textureSize(sampler2D(src_tex, point_smp), 0) - 1;
    float w = texelFetch(sampler2D(src_tex, point_smp), b, 0).r + texelFetch(sampler2D(src_tex, point_smp), min(b + ivec2(1, 0), m), 0).r
            + texelFetch(sampler2D(src_tex, point_smp), min(b + ivec2(0, 1), m), 0).r + texelFetch(sampler2D(src_tex, point_smp), min(b + ivec2(1, 1), m), 0).r;
    bool wet = w > 0.0;
    gl_FragDepth = wet ? 0.0 : 1.0;
    frag_depth_lin = vec4(wet ? 1000.0 : 0.0, 0.0, 0.0, 1.0);
}
@end

@fs fs_refl_compose
@include_block common
layout(binding=5) uniform refl_params {
    vec4 cam_right;    // camera miroir ; w : tan x
    vec4 cam_up;       // w : tan y
    vec4 cam_fwd;      // w : extinction moyenne de la fumee
    vec4 res;          // xy : taille du miroir, zw : taille de sa fumee
};
layout(binding=6) uniform texture2D depth_tex;
layout(binding=11) uniform texture2D scene_tex;
layout(binding=10) uniform texture2D vol_hist_tex;
layout(binding=1) uniform sampler point_smp;
layout(binding=2) uniform sampler lin_clamp_smp;
out vec4 frag_color;
void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec2 uv = gl_FragCoord.xy / res.xy;
    vec3 scene = texelFetch(sampler2D(scene_tex, point_smp), p, 0).rgb;
    float viewZ = texelFetch(sampler2D(depth_tex, point_smp), p, 0).r;
    vec2 ndc = ndc_from_uv(uv);
    vec3 dir = normalize(cam_fwd.xyz + cam_right.xyz * (ndc.x * cam_right.w) + cam_up.xyz * (ndc.y * cam_up.w));
    float t = viewZ / max(dot(dir, cam_fwd.xyz), 1e-3);
    vec3 c = scene * exp(-cam_fwd.w * t) + textureLod(sampler2D(vol_hist_tex, lin_clamp_smp), uv, 0.0).rgb;
    frag_color = vec4(c, 1.0);
}
@end


@fs fs_composite
#extension GL_EXT_control_flow_attributes : require
@include_block common
layout(binding=5) uniform composite_params {
    vec4 cam_right;    // w : tan x
    vec4 cam_up;       // w : tan y
    vec4 cam_fwd;      // w : extinction moyenne
    vec4 res;          // xy : rendu plein, zw : fumee
    vec4 opts;         // x : fumee active, y : lyres douces actives, zw : taille de la passe des lyres douces
    vec4 cam_pos;      // xyz : camera, w : reflet du sol calcule (passe miroir)
    vec4 floor_p;      // comme scene_fs_params (sol texture ; y : eau)
    vec4 floor_q;
    vec4 floor_w;
    vec4 laser;        // x : ajoute le calque des lasers (tuiles en calcul)
};
layout(binding=6) uniform texture2D depth_tex;
layout(binding=13) uniform texture2D laser_tex;    // lasers dans la fumee (cs_laser_shade)
layout(binding=10) uniform texture2D vol_hist_tex;
layout(binding=11) uniform texture2D scene_tex;
layout(binding=24) uniform texture2D normal_tex;
layout(binding=25) uniform texture2D albedo_tex;
layout(binding=26) uniform texture2D soft_diffuse_tex;
layout(binding=27) uniform texture2D soft_spec_tex;
layout(binding=30) uniform texture2D floor_tex;
layout(binding=28) uniform texture2D refl0_tex;
layout(binding=9) uniform texture2D refl_mask_tex;   // profondeur lineaire du miroir : 0 hors de l'eau
layout(binding=31) uniform texture2D floor_cav;
layout(binding=1) uniform sampler point_smp;
layout(binding=2) uniform sampler lin_clamp_smp;
layout(binding=4) uniform sampler floor_smp;
@image_sample_type soft_diffuse_tex unfilterable_float
@image_sample_type soft_spec_tex unfilterable_float

out vec4 frag_color;

#define FLOOR_WET 1
@include_block floor_material

// Reflet du sol mouille (passe miroir, voir Renderer::render) : la scene vue d'une camera miroir sous
// le sol, a la meme position a l'ecran. Seulement dans l'eau (flaques, creux remplis), et toujours net :
// pas de reflet flou ou etire intermediaire (le beton mouille garde les reflets des lampes, rugueux, de la
// passe des surfaces). Fresnel de l'eau (F0 = 0,02). Pas de decalage par le relief : l'eau est plate.
vec3 floor_reflection(vec3 P, vec3 dir, vec2 fw, vec2 gx, vec2 gy, vec2 uv) {
    vec3 N = vec3(0.0, 1.0, 0.0);
    vec3 alb = vec3(0.0);
    float rough = 0.32;
    float water = floor_material(fw, gx, gy, N, alb, rough);
    if (water <= 0.0) {
        return vec3(0.0);
    }
    float cosv = max(-dir.y, 0.02);                     // sol horizontal
    float F = 0.02 + 0.98 * pow(1.0 - cosv, 5.0);       // eau
    // lecture bilineaire du reflet sans les pixels du miroir hors de l'eau (non calcules : masque), pour
    // ne pas melanger du noir au bord d'une flaque ou d'un creux rempli
    ivec2 rs = textureSize(sampler2D(refl0_tex, point_smp), 0);
    vec2 mp = uv * vec2(rs) - 0.5;
    ivec2 i0 = ivec2(floor(mp));
    vec2 f = mp - vec2(i0);
    vec3 acc = vec3(0.0);
    float wsum = 0.0;
    for (int k = 0; k < 4; k++) {
        ivec2 o = ivec2(k & 1, k >> 1);
        ivec2 c = clamp(i0 + o, ivec2(0), rs - 1);
        float wb = (o.x == 1 ? f.x : 1.0 - f.x) * (o.y == 1 ? f.y : 1.0 - f.y);
        wb *= texelFetch(sampler2D(refl_mask_tex, point_smp), c, 0).r > 0.0 ? 1.0 : 0.0;
        acc += texelFetch(sampler2D(refl0_tex, point_smp), c, 0).rgb * wb;
        wsum += wb;
    }
    return acc / max(wsum, 1e-4) * (F * water);
}

void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec3 scene = texelFetch(sampler2D(scene_tex, point_smp), p, 0).rgb;
    float viewZ = texelFetch(sampler2D(depth_tex, point_smp), p, 0).r;
    vec2 uv = gl_FragCoord.xy / res.xy;
    vec2 ndc = ndc_from_uv(uv);
    vec3 dir = normalize(cam_fwd.xyz + cam_right.xyz * (ndc.x * cam_right.w) + cam_up.xyz * (ndc.y * cam_up.w));
    float t = viewZ / max(dot(dir, cam_fwd.xyz), 1e-3);
    vec3 color = scene;
    // reflet du sol mouille (seulement avec de l'eau au sol)
    vec3 Pw = cam_pos.xyz + dir * t;
    vec2 fw = Pw.xz * floor_p.x;
    vec2 fgx = dFdx(fw);
    vec2 fgy = dFdy(fw);
    [[dont_flatten]] if (cam_pos.w > 0.5 && abs(Pw.y) < 0.03 && viewZ < 900.0) {
        color += floor_reflection(Pw, dir, fw, fgx, fgy, uv);
    }
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
    if (laser.x > 0.5) {
        color += texelFetch(sampler2D(laser_tex, point_smp), p, 0).rgb;
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
//  10. Lasers dans la fumee (PLAN-LASERS.md, etape 1 : prototype)
//
//  Tout laser est fait de segments d'eventail plans : une source, n traits repartis entre deux
//  directions de bord. La lumiere d'un segment dans un rayon de la camera se calcule en forme fermee,
//  quel que soit n (voir laser_eval). Rendu par tuiles en calcul : tri des segments par tuiles d'ecran
//  (cs_laser_setup, cs_laser_bin), puis chaque pixel additionne tous ses segments dans ses registres et
//  ecrit une fois (cs_laser_shade). Les triangles en addition (un prisme par segment) ont ete essayes et
//  ecartes : 25 a 43 % plus lents (PERFORMANCE.md).
// -------------------------------------------------------------------------------------
@block laser_data
// Un segment d'eventail. Doit correspondre a sb_laser_t cote C (Renderer : envoi des segments).
struct sb_laser {
    vec4 ec_half;     // xyz : direction du milieu de l'eventail, w : sinus de la demi-ouverture
    vec4 es_n;        // xyz : direction dans le plan, perpendiculaire a ec, w : nombre de traits
    vec4 nrm_range;   // xyz : normale du plan (ec x es), w : portee (m)
    vec4 cam_rel;     // xyz : camera - source dans le repere (ec, es, normale), w : cosinus de la demi-ouverture
    vec4 flux;        // rgb : puissance d'un trait x diffusion par metre, au bord 0 ; w : 1 / ecart angulaire de deux traits (rad)
    vec4 flux1;       // rgb : idem au bord 1 (degrade lineaire le long de l'eventail) ; w : 1 / nombre de traits
};
// source = camera - (ec, es, normale) . cam_rel
vec3 laser_source(sb_laser L, vec3 cam) {
    return cam - L.ec_half.xyz * L.cam_rel.x - L.es_n.xyz * L.cam_rel.y - L.nrm_range.xyz * L.cam_rel.z;
}
@end


@block laser_uniforms_cs
layout(binding=0) uniform laser_cs_params {
    vec4 cam_pos;     // w : inutilise
    vec4 cam_right;   // w : tan x
    vec4 cam_up;      // w : tan y
    vec4 cam_fwd;     // w : extinction moyenne par metre
    vec4 res;         // xy : taille du rendu, z : nombre de segments, w : angle d'un pixel (rad)
    vec4 beam;        // x : sigma^2 a la sortie (m2), y : (divergence / 4)^2, z : largeur minimale (sigma, pixels), w : g
    vec4 tiles;       // x, y : tuiles de 16 pixels, z : grosses tuiles (128 pixels) en x, w : compteurs actifs
    vec4 hall_min;    // interieur du hangar : rien n'est visible au-dela de ses parois
    vec4 hall_max;
    // fumee de la piece : boite de la grille simulee (laser_fog_tex, la texture des amas des lyres)
    vec4 fog_box_min;
    vec4 fog_box_inv;
    vec4 lfog;        // x : diffusion uniforme (air + fumee moyenne), y : 1 = fumee de la piece (laser_fog_tex),
                      // z : force des volutes en fumee uniforme
    vec4 lroom;       // x : air, y : densite x albedo x room_max, z, w : force des volutes (part fixe, part des amas)
    vec4 lroom2;      // x : pente de la part des amas
    vec4 lvol;        // volutes fines : xyz decalage (vent), w : 1 / taille (0 : coupees)
    vec4 lvolw;       // poids des 2 instants (canaux r, g), divises par l'ecart type (contraste constant pendant le melange)
    vec4 lvol2;       // x : -0,5 x somme des poids, y : log2(texels par metre), z : niveau ou les volutes s'effacent
    vec4 lvol3;       // 2e octave (de pres) : xyz decalage, w : 1 / taille (0 : coupee)
    vec4 lvol4;       // x : log2(texels par metre) de la 2e octave, y : niveau ou elle s'efface, z : son poids
    vec4 lphase0;     // lobe doux : 1 + g^2, 2 g, poids x (1 - g^2) / 4 pi
    vec4 lphase1;     // lobe tres avant : idem (poids 0 : un seul lobe, comme les lyres)
};
@end

// Lumiere d'un segment dans un rayon de la camera. Necessite laser_uniforms_cs.
// Tout est calcule dans le repere de l'eventail (ec, es, normale), ou la camera (cam_rel) est connue une fois
// par image : par pixel, il ne reste que le rayon a exprimer dans ce repere.
@block laser_eval
const float LASER_TWO_PI = 6.2831853;

// sigma^2 d'un trait a la distance s de la source, vu a la distance t de la camera : largeur physique
// (ouverture + divergence) et largeur minimale en pixels, sommees en carre. L'energie est conservee :
// un trait plus fin qu'un pixel devient plus large et plus sombre, sans escalier ni scintillement.
float laser_sig2(float s, float t) {
    float px = beam.z * res.w * t;
    return beam.x + beam.y * s * s + px * px;
}

// Diffusion par metre au point X : air (visibilite minimale, traits visibles meme sans fumee) + fumee de la
// piece (amas simules, brume plus dense en bas : la meme que pour les lyres, sans le detail des lyres). Un laser
// qui traverse un amas s'y illumine davantage. La densite (brume x decroissance en hauteur + amas) est preparee sur
// le CPU dans le 2e canal de la texture des amas des lyres (64 x 24 x 32, RG8) : une lecture et 2 operations par
// couple (pixel, segment). Une 2e texture envoyee a chaque image faisait attendre la carte sous Direct3D 11 (+1 a
// +1,3 ms par image en moyenne) ; la calculer dans le shader (exponentielle, division) coutait +3 a +10 %.
// lfog.y = 0 : fumee uniforme (moyenne de la piece).
// Volutes fines (PLAN-LASERS.md, 4.1) : la fumee de la piece est modulee par une texture 3D periodique de volutes
// (src/volutes.cpp), lue au point X ; 'foot' est la taille d'un pixel en X (m), etiree quand la nappe est vue en
// biais. Une lecture donne les 2 instants de la boucle d'evolution (canaux r, g, BC5), melanges par un produit scalaire.
// Niveau de detail : mip choisi selon la taille du pixel (aucun scintillement) ; au-dela de lvol2.z, plus rien a
// lire (la texture y est presque uniforme : effacement progressif, pas de saut). Moyenne 1 : la brillance moyenne ne
// change pas, seule sa repartition change. Force : plus forte dans les amas des machines a fumee que dans la
// brume du hazer.
//
// 2e octave, de pres seulement : la meme texture 3,6 fois plus petite (0,44 m), axes tournes (aucune repetition
// alignee), plus rapide, a l'autre instant de l'evolution (canaux inverses) : detail de quelques millimetres.
//
// Les lectures sont independantes (les volutes ne dependent pas de la force lue dans la piece) et partent ensemble,
// tot ; leur resultat ne sert qu'a la fin du calcul du segment (la passe a peu de groupes actifs pour masquer leur
// attente). Resultat : (diffusion, force des volutes, 1re octave aux deux instants), et f2 : 2e octave.
// lf : log2 de la taille du pixel en X. Volutes coupees : lvol2.z et lvol4.y tres negatifs (rien a lire).
//
// Quatre variantes du shader (LASER_FOG, choisie a chaque image) : la passe est limitee par le calcul et les
// registres, et ce code, meme coupe par un reglage, la ralentissait de 6 a 15 %.
//   0 : fumee uniforme, un lobe (le code d'avant l'etape 3) ;
//   1 : fumee de la piece, deux lobes ;
//   2 : fumee de la piece, deux lobes, volutes fines (1re octave) ;
//   3 : idem avec la 2e octave, seulement si un segment passe assez pres de la camera pour qu'elle soit lue (le
//       CPU calcule la distance de la camera au triangle de chaque segment).
#ifndef LASER_FOG
#define LASER_FOG 0
#endif
#if LASER_FOG >= 1
vec4 laser_fetch(vec3 X, float lf, out vec2 f2) {
    vec4 f = vec4(lfog.xz, 0.5, 0.5);
    f2 = vec2(0.5);
    if (lfog.y > 0.0) {
        // r : amas / 2, g : densite de la piece / room_max (preparee sur le CPU, FogSim::update)
        vec2 fr = textureLod(sampler3D(laser_fog_tex, laser_lin_clamp), X * fog_box_inv.xyz - fog_box_min.xyz, 0.0).rg;
        f.x = lroom.x + lroom.y * fr.y;
        f.y = lroom.z + min(fr.x * lroom2.x, lroom.w);
    }
#if LASER_FOG >= 2
    float lod = lf + lvol2.y;
    if (lod < lvol2.z) {
        f.zw = textureLod(sampler3D(laser_vol_tex, laser_vol_smp), X * lvol.w + lvol.xyz, max(lod, 0.0)).rg;
#if LASER_FOG >= 3
        // 2e octave : axes permutes et cisailles (3 operations au lieu d'une rotation)
        float lod2 = lf + lvol4.x;
        if (lod2 < lvol4.y) {
            f2 = textureLod(sampler3D(laser_vol_tex, laser_vol_smp), (X.zxy + X.yzx * 0.37) * lvol3.w + lvol3.xyz, max(lod2, 0.0)).gr;
        }
#endif
    }
#endif
    return f;
}
// Diffusion au point lu (f, f2 : laser_fetch) : effacement des volutes au loin, sans saut. Somme des deux octaves
// ramenee a l'ecart type d'une seule (1 / sqrt(1 + k2^2), approche lineairement : lvol4.w).
float laser_sigma_of(vec4 f, vec2 f2, float lf) {
#if LASER_FOG >= 2
    float fade = clamp(lvol2.z - (lf + lvol2.y), 0.0, 1.0) * f.y;
#if LASER_FOG >= 3
    float k2 = clamp(lvol4.y - (lf + lvol4.x), 0.0, 1.0) * lvol4.z;
    float z = (dot(f.zw, lvolw.xy) + lvol2.x + k2 * (dot(f2, lvolw.xy) + lvol2.x)) * (1.0 - lvol4.w * k2);
#else
    float z = dot(f.zw, lvolw.xy) + lvol2.x;
#endif
    return f.x * max(1.0 + fade * z, 0.0);
#else
    return f.x;
#endif
}
#endif
float laser_sigma(vec3 X, float foot) {
#if LASER_FOG >= 1
    vec2 f2;
    float lf = log2(foot);
    vec4 f = laser_fetch(X, lf, f2);
    return laser_sigma_of(f, f2, lf);
#else
    return lfog.x;
#endif
}

// Diffusion vers l'avant ; b : cos(rayon, trait), l'angle de diffusion est son oppose. Deux lobes de
// Henyey-Greenstein (PLAN-LASERS.md, section 4) : les gouttelettes de fumee renvoient une grande part de la lumiere
// dans un cone etroit autour du faisceau (lobe tres avant, g ~ 0,9), le reste plus largement (lobe doux). Un laser
// vu dans son axe, ou presque, est beaucoup plus brillant ; vu de cote, comme avec un seul lobe.
float laser_phase(float b) {
#if LASER_FOG >= 1
    float h0 = inversesqrt(lphase0.x + lphase0.y * b);
    float h1 = inversesqrt(lphase1.x + lphase1.y * b);
    return lphase0.z * h0 * h0 * h0 + lphase1.z * h1 * h1 * h1;
#else
    float hd = inversesqrt(lphase0.x + lphase0.y * b);
    return lphase0.z * hd * hd * hd;
#endif
}

// Un trait seul, le long du 1er axe du repere (longueur R), dans le rayon q + t dv (q : camera - source,
// t <= tMax) : noyau gaussien a la distance des deux droites, divise par le sinus de leur angle (formule des
// photon beams, Jarosz 2011), diffusion vers l'avant et attenuation. Le 1 / sin est plafonne par la longueur
// du trait (trait vu dans son axe).
float laser_trait(vec3 q, vec3 dv, vec3 vw, float R, float tMax) {
    float b = dv.x, d = dot(dv, q), ee = q.x;
    float s2 = max(1.0 - b * b, 1e-7);
    // points les plus proches du rayon (t dans [0, tMax]) et du trait (s dans [0, R])
    float t = clamp((b * ee - d) / s2, 0.0, tMax);
    float s = clamp(ee + b * t, 0.0, R);
    t = clamp(s * b - d, 0.0, tMax);
    vec3 w = q + dv * t - vec3(s, 0.0, 0.0);
    float u2 = dot(w, w);
    float sig2 = laser_sig2(s, t);
    if (u2 > 16.0 * sig2) {
        return 0.0;
    }
    float isig = inversesqrt(sig2);
    float inv_sin = min(inversesqrt(s2), 0.4 * max(R, 1.0) * isig);
    return exp(-0.5 * u2 * isig * isig) * isig * 0.39894228 * inv_sin * laser_phase(b) * exp(-cam_fwd.w * (t + s))
         * laser_sigma(cam_pos.xyz + vw * t, res.w * t);
}

// Segment d'eventail de 2 traits ou plus (L0..L4 : sb_laser) dans le rayon de direction v (t <= tMax). Les
// traits seuls passent par laser_trait (cs_laser_shade).
// Le rayon traverse le plan de l'eventail en P (distance tP de la camera, rP de la source). Pres de P, les
// traits sont des droites presque paralleles : la distance du rayon au trait k est (x - k) du, ou x est la
// position de P en traits et du l'ecart de deux traits mesure sur le rayon. Chaque trait donne une gaussienne
// en x, de largeur Q = sigma / du ; leur somme S(x) vaut 1 en moyenne (la nappe) :
//   L = (puissance d'un trait x diffusion) x S(x) x phase x attenuation / (|n.v| rP dphi)
//   - traits separes (Q < 0,35, et au moins 4 pixels entre deux traits a l'ecran) : somme des gaussiennes
//     voisines ;
//   - sinon : somme de Poisson, la moyenne plus une ondulation (1er terme) qui s'efface quand les traits se
//     serrent (Q) ou quand leur ecart a l'ecran approche 2 pixels (f) : aucun moire ;
//   - entre 4 et 3,3 pixels d'ecart, melange des deux (pas de saut visible).
// Le cout vient surtout des operations speciales (divisions, racines, exponentielles, cosinus). La nappe lisse
// (cas le plus courant) n'en demande que 4 : Q et f y sont compares au carre, et les bords sont testes avec le
// sinus de l'angle vu de la source (juste pres des bords, la ou il sert) au lieu de l'arc tangente.
vec3 laser_eval(vec4 L0, vec4 L1, vec4 L2, vec4 L3, vec4 L4, vec4 L5, vec3 v, float tMax) {
    float R = L2.w, nb = L1.w;
    float ia = 1.0 / dot(v, L2.xyz);   // rayon dans le repere de l'eventail : composante sur la normale
    float tP = -L3.z * ia;
    // P devant la camera et devant la premiere surface (rayon dans le plan : division par 0, rejete aussi)
    if (!(tP > 0.0 && tP <= tMax)) {
        return vec3(0.0);
    }
    vec2 dxy = vec2(dot(v, L0.xyz), dot(v, L1.xyz));
    vec2 p2 = L3.xy + dxy * tP;   // P dans le plan, depuis la source
    float r2 = dot(p2, p2);
    if (r2 > R * R || p2.x <= 0.0) {
        return vec3(0.0);
    }
    float irP = inversesqrt(r2);
    // distances angulaires aux bords, en traits (x + 1/2 et nb - 1/2 - x), par le sinus des angles aux bords
    float sh = L0.w, ch = L3.w;   // sinus et cosinus de la demi-ouverture
    float u0 = p2.y * ch + p2.x * sh, u1 = p2.x * sh - p2.y * ch;   // rP x sinus des angles aux bords
    float e0 = u0 * irP * L4.w + 0.5, e1 = u1 * irP * L4.w + 0.5;
    float rP = r2 * irP;
    float bP = dot(dxy, p2) * irP;   // cos(rayon, trait)
    float sig2 = laser_sig2(rP, tP);
    // 1 / |n.v| plafonne par l'epaisseur de la nappe (nappe vue par la tranche : rare, la racine seulement alors)
    float m = max(rP, 0.5);
    float iaa = abs(ia);
    if (ia * ia * sig2 > 0.16 * m * m) {
        iaa = 0.4 * m * inversesqrt(sig2);
    }
    // fumee au point P : les deux lectures (piece, volutes) partent ici ensemble, leur resultat ne sert qu'a la fin
    // (le temps du calcul de la nappe) ; le pixel couvre res.w tP / |n.v| dans la nappe
#if LASER_FOG >= 1
    float lfoot = log2(res.w * tP * iaa);
    vec2 fog2;
    vec4 fog = laser_fetch(cam_pos.xyz + v * tP, lfoot, fog2);
#endif
    // 1 / sin plafonne par la longueur du trait jusqu'a P (trait vu dans son axe) ; tout au carre
    float sin2 = max(1.0 - bP * bP, 6.25 * sig2 * irP * irP);
    float k = L4.w * irP * iaa;
    float idu2 = sin2 * k * k;          // (1 / ecart de deux traits, mesure sur le rayon)^2
    float Q2 = sig2 * idu2;             // (largeur d'un trait / ecart)^2
    float pt = res.w * tP;
    float f2 = pt * pt * idu2;          // (pixel / ecart)^2
    // hors de l'eventail, a plus de max(1,5 ; 4 Q) traits d'un bord
    float emin = min(e0, e1);
    if (emin < 0.0 && emin * emin > max(2.25, 16.0 * Q2)) {
        return vec3(0.0);
    }
    float S;
    float tc = 0.0;   // position le long de l'eventail (0 au bord 0, 1 au bord 1) : couleur du degrade
    if (Q2 >= 0.5625 || f2 >= 0.25) {
#ifdef LASER_GRADIENT
        tc = clamp(e0 * L5.w, 0.0, 1.0);   // par le sinus de l'angle au bord 0 (morceaux de 15 deg au plus)
#endif
        // nappe lisse (traits confondus) : 1, sauf a moins de 2 largeurs de trait d'un bord
        S = 1.0;
        if (emin < 0.0 || emin * emin < 4.0 * Q2) {
            float iq = inversesqrt(Q2);
            S = smoothstep(-2.0, 2.0, e0 * iq) * smoothstep(-2.0, 2.0, e1 * iq);
        }
    } else {
        // sans racine pour f, une seule pour Q (1 / Q)
        float iq = inversesqrt(Q2);
        float Q = Q2 * iq;
        // position exacte de P en traits : angle depuis le bord 0 (arc tangente approche, erreur < 1e-5 rad)
        float c0 = p2.x * ch - p2.y * sh;   // rP x cosinus de l'angle depuis le bord 0
        float au = abs(u0), ac = abs(c0);
        float z = min(au, ac) / max(max(au, ac), 1e-20);
        float z2 = z * z;
        float ang = z * (0.99997726 + z2 * (-0.33262347 + z2 * (0.19354346 + z2 * (-0.11643287 + z2 * (0.05265332 - 0.01172120 * z2)))));
        ang = au > ac ? 1.5707963 - ang : ang;
        ang = c0 < 0.0 ? 3.1415927 - ang : ang;
        float x = (u0 < 0.0 ? -ang : ang) * L4.w;
#ifdef LASER_GRADIENT
        tc = clamp((x + 0.5) * L5.w, 0.0, 1.0);
#endif
        float wp = Q2 >= 0.1225 ? 1.0 : smoothstep(0.04, 0.09, f2);   // part de la somme de Poisson (f de 0,2 a 0,3)
        S = 0.0;
        if (wp < 1.0) {
            // traits separes : le plus proche, et ses voisins s'ils sont a moins de 4 largeurs (Q > 0,125)
            float kc = clamp(floor(x + 0.5), 0.0, nb - 1.0);
            float e = (x - kc) * iq;
            float sd = abs(e) < 4.0 ? exp(-0.5 * e * e) : 0.0;
            if (Q2 > 0.015625) {
                float em = e + iq, ep = e - iq;   // traits kc - 1 et kc + 1 (Q > 0,125)
                if (kc > 0.5 && abs(em) < 4.0) {
                    sd += exp(-0.5 * em * em);
                }
                if (kc < nb - 1.5 && abs(ep) < 4.0) {
                    sd += exp(-0.5 * ep * ep);
                }
            }
            S = sd * iq * 0.39894228 * (1.0 - wp);
        }
        if (wp > 0.0) {
            // nappe : moyenne, bords adoucis sur la largeur d'un trait (seulement pres d'un bord), ondulation
            // des traits, effacee quand leur ecart a l'ecran passe de 4 a 2 pixels (f de 0,25 a 0,5)
            float edge = 1.0;
            if (min(x + 0.5, nb - 0.5 - x) < 2.0 * Q) {
                edge = smoothstep(-2.0, 2.0, (x + 0.5) * iq) * smoothstep(-2.0, 2.0, (nb - 0.5 - x) * iq);
            }
            float rip = 2.0 * exp(-19.739209 * Q2) * clamp((0.25 - f2) * 5.3333333, 0.0, 1.0) * cos(LASER_TWO_PI * fract(x));
            S += (1.0 + rip) * edge * wp;
        }
        if (S <= 0.0) {
            return vec3(0.0);   // entre deux traits separes
        }
    }
#ifdef LASER_GRADIENT
    vec3 col = mix(L4.rgb, L5.rgb, tc);
#else
    vec3 col = L4.rgb;
#endif
    return col * (S * laser_phase(bP) * exp(-cam_fwd.w * (tP + rP)) * L4.w * irP * iaa
#if LASER_FOG >= 1
               * laser_sigma_of(fog, fog2, lfoot));
#else
               * lfog.x);
#endif
}
@end

// Rayon du pixel (rendu plein) et distance de la premiere surface. Necessite laser_uniforms_cs.
@block laser_ray
vec3 laser_ray(vec2 pix, float viewZ, out float tMax) {
    vec2 ndc = ndc_from_uv(pix / res.xy);
    vec3 v = normalize(cam_fwd.xyz + cam_right.xyz * (ndc.x * cam_right.w) + cam_up.xyz * (ndc.y * cam_up.w));
    tMax = viewZ / max(dot(v, cam_fwd.xyz), 1e-3);
    return v;
}
@end

// 10a. Tuiles en calcul. Ecran du segment (cs_laser_setup) : 9 vec4, rectangle puis 8 bords au plus
//      (nx, ny, c : dedans si n.p <= c).
@block laser_tiles
const uint LASER_CAP = 4096u;   // segments au plus par grosse tuile (128 pixels)

bool laser_tile_hit(uint i, vec2 c, vec2 hs) {
    vec4 bb = scr[i * 9u].v;
    if (c.x + hs.x < bb.x || c.x - hs.x > bb.z || c.y + hs.y < bb.y || c.y - hs.y > bb.w) {
        return false;
    }
    for (uint k = 1u; k <= 8u; k++) {
        vec4 e = scr[i * 9u + k].v;
        if (dot(e.xy, c) - dot(abs(e.xy), hs) > e.z) {
            return false;
        }
    }
    return true;
}
@end

@cs cs_laser_setup
@include_block common
@include_block laser_data
@include_block laser_uniforms_cs
layout(binding=10) readonly buffer lasers_cs { sb_laser lasers[]; };
layout(binding=11) buffer laser_scr_rw { sb_vec4 scr_w[]; };
layout(binding=12) buffer laser_stats_rw { sb_index stats_w[]; };
layout(local_size_x=64, local_size_y=1, local_size_z=1) in;

vec3 to_view(vec3 p) {
    vec3 d = p - cam_pos.xyz;
    return vec3(dot(d, cam_right.xyz), dot(d, cam_up.xyz), dot(d, cam_fwd.xyz));
}

// Plan du monde dot(n, p) <= d, dans le repere de la camera.
vec4 view_plane(vec3 n, float d) {
    return vec4(dot(n, cam_right.xyz), dot(n, cam_up.xyz), dot(n, cam_fwd.xyz), d - dot(n, cam_pos.xyz));
}

// Ecran d'un segment : triangle de l'eventail coupe par les parois du hangar (rien n'est visible au-dela),
// par le plan proche et par l'ecran elargi de moitie (un sommet tres pres de la camera, loin hors de
// l'ecran, aurait une marge de centaines de pixels, appliquee a tout un bord). Puis, en pixels, chaque bord
// repousse de 3,5 largeurs de trait (marge de ses deux sommets) + 1 pixel.
void main() {
    uint i = gl_GlobalInvocationID.x;
    if (i == 0u) {
        for (int k = 0; k < 4; k++) {
            stats_w[k].v = 0u;
        }
    }
    if (i >= uint(res.z)) {
        return;
    }
    sb_laser L = lasers[i];
    vec3 S = laser_source(L, cam_pos.xyz), ec = L.ec_half.xyz, es = L.es_n.xyz;
    float R = L.nrm_range.w;
    float sh = L.ec_half.w, ch = L.cam_rel.w;   // sinus et cosinus de la demi-ouverture
    float Rf = R / ch;   // la corde des bouts contient l'arc des traits
    // sommets (xyz : repere de la camera, w : distance a la source), coupes plan par plan (Sutherland-Hodgman)
    vec4 pl[11];
    pl[0] = view_plane(vec3(-1, 0, 0), -hall_min.x);
    pl[1] = view_plane(vec3(1, 0, 0), hall_max.x);
    pl[2] = view_plane(vec3(0, -1, 0), -hall_min.y);
    pl[3] = view_plane(vec3(0, 1, 0), hall_max.y);
    pl[4] = view_plane(vec3(0, 0, -1), -hall_min.z);
    pl[5] = view_plane(vec3(0, 0, 1), hall_max.z);
    const float ZN = 0.05, G = 1.5;
    pl[6] = vec4(0.0, 0.0, -1.0, -ZN);
    pl[7] = vec4(1.0, 0.0, -G * cam_right.w, 0.0);
    pl[8] = vec4(-1.0, 0.0, -G * cam_right.w, 0.0);
    pl[9] = vec4(0.0, 1.0, -G * cam_up.w, 0.0);
    pl[10] = vec4(0.0, -1.0, -G * cam_up.w, 0.0);
    vec4 va[16], vb[16];
    for (int k = 0; k < 16; k++) {
        va[k] = vec4(0.0);
        vb[k] = vec4(0.0);
    }
    va[0] = vec4(to_view(S), 0.0);
    va[1] = vec4(to_view(S + (ec * ch - es * sh) * Rf), Rf);
    va[2] = vec4(to_view(S + (ec * ch + es * sh) * Rf), Rf);
    int np = 3;
    for (int j = 0; j < 11; j++) {
        vec4 P = pl[j];
        int no = 0;
        for (int k = 0; k < 16; k++) {
            if (k >= np) {
                break;
            }
            vec4 A = va[k], B = va[k + 1 < np ? k + 1 : 0];
            float da = dot(P.xyz, A.xyz) - P.w, db = dot(P.xyz, B.xyz) - P.w;
            if (da <= 0.0 && no < 16) {
                vb[no] = A;
                no++;
            }
            if ((da <= 0.0) != (db <= 0.0) && no < 16) {
                vb[no] = mix(A, B, da / (da - db));
                no++;
            }
        }
        np = no;
        for (int k = 0; k < 16; k++) {
            va[k] = vb[k];
        }
    }
    if (np < 3) {
        scr_w[i * 9u].v = vec4(1e9, 1e9, -1e9, -1e9);
        return;
    }
    vec2 pp[16];
    float pm[16];
    vec2 lo = vec2(1e30), hi = vec2(-1e30);
    float mmax = 0.0, area = 0.0;
    for (int k = 0; k < 16; k++) {
        if (k >= np) {
            break;
        }
        vec4 P = va[k];
        pp[k] = uv_from_ndc(vec2(P.x / (P.z * cam_right.w), P.y / (P.z * cam_up.w))) * res.xy;
        float sp = sqrt(beam.x + beam.y * P.w * P.w) / (P.z * res.w);
        pm[k] = 3.5 * sqrt(sp * sp + beam.z * beam.z) + 1.0;
        lo = min(lo, pp[k]);
        hi = max(hi, pp[k]);
        mmax = max(mmax, pm[k]);
    }
    for (int k = 0; k < 16; k++) {
        if (k >= np) {
            break;
        }
        vec2 a = pp[k], b = pp[k + 1 < np ? k + 1 : 0];
        area += a.x * b.y - a.y * b.x;
    }
    scr_w[i * 9u].v = vec4(lo - mmax, hi + mmax);
    float orient = area < 0.0 ? -1.0 : 1.0;
    // Trait seul : sa droite a l'ecran (n.p + c = distance en pixels) et la demi-largeur ou il eclaire
    // (4 largeurs de trait + 1 pixel), rangees dans les w des bords 1 a 4 : cs_laser_shade rejette les pixels
    // hors de cette bande en 3 operations. Trait vu presque dans son axe (moins d'un pixel) : pas de rejet.
    vec4 ln = vec4(0.0, 0.0, 0.0, 1e30);
    if (L.es_n.w < 1.5) {
        vec2 a = pp[0], b = pp[0];
        float far2 = 0.0, mline = 0.0;
        for (int k = 0; k < 16; k++) {
            if (k >= np) {
                break;
            }
            vec2 d = pp[k] - pp[0];
            if (dot(d, d) > far2) {
                far2 = dot(d, d);
                b = pp[k];
            }
            vec4 P = va[k];
            float sp = sqrt(beam.x + beam.y * P.w * P.w) / (P.z * res.w);
            mline = max(mline, 4.0 * sqrt(sp * sp + beam.z * beam.z) + 1.0);
        }
        if (far2 > 1.0) {
            vec2 nl = vec2(b.y - a.y, a.x - b.x) * inversesqrt(far2);
            ln = vec4(nl, -dot(nl, a), mline);
        }
    }
    // 8 bords au plus (garder une partie des bords seulement rend le test plus large, jamais faux)
    for (int k = 0; k < 8; k++) {
        vec4 e = vec4(0.0, 0.0, 1e30, k < 4 ? ln[k] : 0.0);
        if (k < np) {
            int k1 = k + 1 < np ? k + 1 : 0;
            vec2 a = pp[k], b = pp[k1];
            vec2 d = b - a;
            float len = length(d);
            if (len > 1e-3) {
                vec2 n = vec2(d.y, -d.x) * (orient / len);
                e = vec4(n, dot(n, a) + max(pm[k], pm[k1]), k < 4 ? ln[k] : 0.0);
            }
        }
        scr_w[i * 9u + uint(k) + 1u].v = e;
    }
}
@end

// Grosses tuiles (128 pixels) : un groupe par tuile teste tous les segments.
@cs cs_laser_bin
@include_block common
@include_block laser_uniforms_cs
layout(binding=11) readonly buffer laser_scr_ro { sb_vec4 scr[]; };
layout(binding=12) buffer laser_stats_rw { sb_index stats_w[]; };
layout(binding=13) buffer laser_ccount_rw { sb_index ccount_w[]; };
layout(binding=14) buffer laser_clist_rw { sb_index clist_w[]; };
@include_block laser_tiles
layout(local_size_x=256, local_size_y=1, local_size_z=1) in;

shared uint s_n;
shared uint s_list[4096];

void main() {
    uint ct = gl_WorkGroupID.x + gl_WorkGroupID.y * uint(tiles.z);
    uint lid = gl_LocalInvocationIndex;
    vec2 c = (vec2(gl_WorkGroupID.xy) + 0.5) * 128.0;
    if (lid == 0u) {
        s_n = 0u;
    }
    barrier();
    int n = int(res.z);
    for (int base = 0; base < n; base += 256) {
        uint i = uint(base) + lid;
        if (i < uint(n) && laser_tile_hit(i, c, vec2(64.0))) {
            uint k = atomicAdd(s_n, 1u);
            if (k < LASER_CAP) {
                s_list[k] = i;
            } else {
                atomicAdd(stats_w[3].v, 1u);   // debordement (segments perdus pour cette grosse tuile)
            }
        }
    }
    barrier();
    uint m = min(s_n, LASER_CAP);
    for (uint k = lid; k < m; k += 256u) {
        clist_w[ct * LASER_CAP + k].v = s_list[k];
    }
    if (lid == 0u) {
        ccount_w[ct].v = m;
    }
}
@end

// Tuiles de 16 pixels : le groupe garde les segments de sa grosse tuile qui touchent la sienne (un test par
// fil), les met en memoire partagee, puis chaque pixel les additionne dans ses registres. Une seule
// ecriture par pixel, la profondeur lue une fois.
@block laser_shade_body
@include_block common
@include_block laser_data
@include_block laser_uniforms_cs
layout(binding=10) readonly buffer lasers_cs { sb_laser lasers[]; };
layout(binding=11) readonly buffer laser_scr_ro { sb_vec4 scr[]; };
layout(binding=12) buffer laser_stats_rw { sb_index stats_w[]; };
layout(binding=13) readonly buffer laser_ccount_ro { sb_index ccount[]; };
layout(binding=14) readonly buffer laser_clist_ro { sb_index clist[]; };
layout(binding=6) uniform texture2D laser_depth_cs;
layout(binding=7) uniform texture3D laser_fog_tex;    // amas de fumee simules (la texture des lyres : fog_tex)
layout(binding=8) uniform texture3D laser_vol_tex;    // volutes fines (2 instants, BC5)
layout(binding=1) uniform sampler laser_smp_cs;
layout(binding=2) uniform sampler laser_lin_clamp;
layout(binding=3) uniform sampler laser_vol_smp;      // repetee, mipmaps lineaires
layout(binding=15, rgba16f) uniform writeonly image2D laser_w;
@include_block laser_eval
@include_block laser_ray
@include_block laser_tiles
// 128 fils pour une tuile de 16 x 16 : chaque fil calcule 2 pixels (8 lignes d'ecart), chaque segment est lu
// une fois en memoire partagee pour les deux.
layout(local_size_x=16, local_size_y=8, local_size_z=1) in;

shared uint s_n;
shared uint s_idx[128];
#ifdef LASER_GRADIENT
const uint LS = 6u;   // vec4 par segment en memoire partagee (couleur au bord 1 comprise)
#else
const uint LS = 5u;
#endif
shared vec4 s_seg[128u * LS];
shared vec4 s_line[128];   // traits seuls : droite a l'ecran et demi-largeur (cs_laser_setup)

void main() {
    uint lid = gl_LocalInvocationIndex;
    ivec2 pa = ivec2(gl_WorkGroupID.xy) * 16 + ivec2(gl_LocalInvocationID.xy);
    ivec2 pb = pa + ivec2(0, 8);
    uint ct = (gl_WorkGroupID.x >> 3u) + (gl_WorkGroupID.y >> 3u) * uint(tiles.z);
    uint n = ccount[ct].v;
    vec2 tc = (vec2(gl_WorkGroupID.xy) + 0.5) * 16.0;
    ivec2 pmax = ivec2(res.xy) - 1;
    float tMaxA, tMaxB;
    vec3 va = laser_ray(vec2(pa) + 0.5, texelFetch(sampler2D(laser_depth_cs, laser_smp_cs), min(pa, pmax), 0).r, tMaxA);
    vec3 vb = laser_ray(vec2(pb) + 0.5, texelFetch(sampler2D(laser_depth_cs, laser_smp_cs), min(pb, pmax), 0).r, tMaxB);
    vec2 fpA = vec2(pa) + 0.5, fpB = vec2(pb) + 0.5;   // centres des pixels (meme repere que cs_laser_setup)
    vec3 accA = vec3(0.0), accB = vec3(0.0);
    uint total = 0u;
    for (uint base = 0u; base < n; base += 128u) {
        if (lid == 0u) {
            s_n = 0u;
        }
        barrier();
        uint i = base + lid;
        if (i < n) {
            uint si = clist[ct * LASER_CAP + i].v;
            if (laser_tile_hit(si, tc, vec2(8.0))) {
                s_idx[atomicAdd(s_n, 1u)] = si;
            }
        }
        barrier();
        uint m = s_n;
        if (lid < m) {
            sb_laser L = lasers[s_idx[lid]];
            s_seg[lid * LS] = L.ec_half;
            s_seg[lid * LS + 1u] = L.es_n;
            s_seg[lid * LS + 2u] = L.nrm_range;
            s_seg[lid * LS + 3u] = L.cam_rel;
            s_seg[lid * LS + 4u] = L.flux;
#ifdef LASER_GRADIENT
            s_seg[lid * LS + 5u] = L.flux1;
#endif
            uint so = s_idx[lid] * 9u;
            s_line[lid] = vec4(scr[so + 1u].v.w, scr[so + 2u].v.w, scr[so + 3u].v.w, scr[so + 4u].v.w);
        }
        barrier();
        for (uint j = 0u; j < m; j++) {
            uint o = j * LS;
            vec4 L0 = s_seg[o], L1 = s_seg[o + 1u], L2 = s_seg[o + 2u], L3 = s_seg[o + 3u], L4 = s_seg[o + 4u];
#ifdef LASER_GRADIENT
            vec4 L5 = s_seg[o + 5u];
#else
            vec4 L5 = vec4(0.0);
#endif
            if (L1.w < 1.5) {
                // trait seul : rien a calculer hors de sa bande a l'ecran
                vec4 ln = s_line[j];
                if (abs(dot(fpA, ln.xy) + ln.z) <= ln.w) {
                    accA += L4.rgb * laser_trait(L3.xyz, vec3(dot(va, L0.xyz), dot(va, L1.xyz), dot(va, L2.xyz)), va, L2.w, tMaxA);
                }
                if (abs(dot(fpB, ln.xy) + ln.z) <= ln.w) {
                    accB += L4.rgb * laser_trait(L3.xyz, vec3(dot(vb, L0.xyz), dot(vb, L1.xyz), dot(vb, L2.xyz)), vb, L2.w, tMaxB);
                }
            } else {
                accA += laser_eval(L0, L1, L2, L3, L4, L5, va, tMaxA);
                accB += laser_eval(L0, L1, L2, L3, L4, L5, vb, tMaxB);
            }
        }
        total += m;
        barrier();
    }
    if (tiles.w > 0.5 && lid == 0u) {
        atomicAdd(stats_w[0].v, total);
        atomicMax(stats_w[1].v, total);
        atomicAdd(stats_w[2].v, total > 0u ? 1u : 0u);
    }
    if (pa.x < int(res.x) && pa.y < int(res.y)) {
        imageStore(laser_w, pa, vec4(min(accA, vec3(60000.0)), 1.0));
    }
    if (pb.x < int(res.x) && pb.y < int(res.y)) {
        imageStore(laser_w, pb, vec4(min(accB, vec3(60000.0)), 1.0));
    }
}
@end

// Variantes : sans degrade (aucune figure n'en a : rien a lire ni a melanger) et avec ; fumee uniforme (0), de la
// piece (1), avec volutes (2, 3) : voir LASER_FOG.
@cs cs_laser_shade
@image_sample_type laser_depth_cs unfilterable_float
@sampler_type laser_smp_cs nonfiltering
@include_block laser_shade_body
@end

@cs cs_laser_shade_f1
#define LASER_FOG 1
@include_block laser_shade_body
@end

@cs cs_laser_shade_f2
#define LASER_FOG 2
@include_block laser_shade_body
@end

@cs cs_laser_shade_f3
#define LASER_FOG 3
@include_block laser_shade_body
@end

@cs cs_laser_shade_grad
#define LASER_GRADIENT 1
@include_block laser_shade_body
@end

@cs cs_laser_shade_grad_f1
#define LASER_GRADIENT 1
#define LASER_FOG 1
@include_block laser_shade_body
@end

@cs cs_laser_shade_grad_f2
#define LASER_GRADIENT 1
#define LASER_FOG 2
@include_block laser_shade_body
@end

@cs cs_laser_shade_grad_f3
#define LASER_GRADIENT 1
#define LASER_FOG 3
@include_block laser_shade_body
@end

// -------------------------------------------------------------------------------------
//  Programmes
// -------------------------------------------------------------------------------------
@program cull_clusters cs_cull_clusters
@program probes cs_probes
@program scene vs_scene fs_scene
@program scene_gb vs_scene fs_scene_gb
@program scene_wet vs_scene fs_scene_wet
@program scene_gb_wet vs_scene fs_scene_gb_wet
@program soft_light vs_fullscreen fs_soft_light
@program depth_only vs_scene fs_depth_only
@program vol_ambient vs_fullscreen fs_vol_ambient
@program beams vs_beam fs_beam
@program beams_an vs_beam fs_beam_an
@program vol_merge vs_fullscreen fs_vol_merge
@program beam_tables cs_beam_tables
@program pattern_images cs_pattern_images
@program pattern_images_rgb cs_pattern_images_rgb
@program temporal vs_fullscreen fs_temporal
@program refl_mask vs_fullscreen fs_refl_mask
@program refl_block vs_fullscreen fs_refl_block
@program refl_compose vs_fullscreen fs_refl_compose
@program composite vs_fullscreen fs_composite
@program bloom_down vs_fullscreen fs_bloom_down
@program bloom_up vs_fullscreen fs_bloom_up
@program final vs_fullscreen fs_final
@program laser_setup cs_laser_setup
@program laser_bin cs_laser_bin
@program laser_shade cs_laser_shade
@program laser_shade_f1 cs_laser_shade_f1
@program laser_shade_f2 cs_laser_shade_f2
@program laser_shade_f3 cs_laser_shade_f3
@program laser_shade_grad cs_laser_shade_grad
@program laser_shade_grad_f1 cs_laser_shade_grad_f1
@program laser_shade_grad_f2 cs_laser_shade_grad_f2
@program laser_shade_grad_f3 cs_laser_shade_grad_f3
