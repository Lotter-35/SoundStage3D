#include "fumee_spatiale.h"
#include "imgui.h"
#include "mathx.h"
#include "volutes.h"
#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <numeric>
#include <thread>

namespace {

// Bruit de gradient 3D periodique (periode 'per' cellules sur [0, 1)), valeurs ~[-0,7 ; 0,7].
struct GradNoise {
    int per;
    std::vector<vec3> g;
    GradNoise(int p, uint32_t seed) : per(p), g((size_t)p * p * p) {
        for (size_t i = 0; i < g.size(); i++) {
            uint32_t s = seed * 2654435761u + (uint32_t)i * 2246822519u;
            vec3 d;
            do {
                d = {hash01(s) * 2 - 1, hash01(s + 1) * 2 - 1, hash01(s + 2) * 2 - 1};
                s += 3;
            } while (dot(d, d) > 1.0f || dot(d, d) < 1e-4f);
            g[i] = normalize(d);
        }
    }
    float operator()(vec3 p) const {
        const float x = p.x * per, y = p.y * per, z = p.z * per;
        const int ix = (int)std::floor(x), iy = (int)std::floor(y), iz = (int)std::floor(z);
        const float fx = x - ix, fy = y - iy, fz = z - iz;
        auto fade = [](float t) { return t * t * t * (t * (t * 6 - 15) + 10); };
        const float ux = fade(fx), uy = fade(fy), uz = fade(fz);
        float r = 0;
        for (int k = 0; k < 8; k++) {
            const int dx = k & 1, dy = (k >> 1) & 1, dz = k >> 2;
            const int cx = ((ix + dx) % per + per) % per, cy = ((iy + dy) % per + per) % per, cz = ((iz + dz) % per + per) % per;
            const vec3& c = g[((size_t)cz * per + cy) * per + cx];
            const float w = (dx ? ux : 1 - ux) * (dy ? uy : 1 - uy) * (dz ? uz : 1 - uz);
            r += w * (c.x * (fx - dx) + c.y * (fy - dy) + c.z * (fz - dz));
        }
        return r;
    }
};

struct Fbm {
    std::vector<GradNoise> oct;
    float gain;
    Fbm(int per, uint32_t seed, int octaves, float g) : gain(g) {
        for (int o = 0; o < octaves; o++) oct.emplace_back(per << o, seed + 101u * (uint32_t)o);
    }
    float operator()(vec3 p) const {
        float v = 0, a = 1;
        for (const GradNoise& n : oct) {
            v += a * n(p);
            a *= gain;
        }
        return v;
    }
};

// Inverse de la fonction de repartition de la loi normale (Acklam, erreur relative < 1,2e-9)
double inv_norm_cdf(double p) {
    static const double a[] = {-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
                               1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00};
    static const double b[] = {-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
                               6.680131188771972e+01, -1.328068155288572e+01};
    static const double c[] = {-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
                               -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00};
    static const double d[] = {7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00};
    p = std::min(std::max(p, 1e-12), 1.0 - 1e-12);
    if (p < 0.02425) {
        const double q = std::sqrt(-2 * std::log(p));
        return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    if (p > 1 - 0.02425) {
        const double q = std::sqrt(-2 * std::log(1 - p));
        return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    const double q = p - 0.5, r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
           (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// Un nombre au hasard dans [0, 1) pour (cycle, couche, k)
float rnd(int cycle, int layer, int k) {
    return hash01((uint32_t)cycle * 2654435761u ^ (uint32_t)(layer * 7 + k) * 40503u ^ 0x5bd1e995u);
}

}  // namespace

void SpatialFogBanks::build() {
    const auto t0 = std::chrono::steady_clock::now();
    // Bancs : somme d'octaves de bruit de gradient (periodes 5 et 10 sur la table) dans un domaine deforme par un
    // bruit plus lent (formes arrondies et etirees, pas de grille visible). Periode de la table : 10 tailles de banc
    // (80 m pour des bancs de 8 m : le hangar fait 100 m), lue en biais par deux couches decalees : aucune repetition.
    // Seulement 2 octaves : le champ est echantillonne dans les cases de ~1,5 m de la carte puis interpole ; une 3e octave
    // (periode de ~4 m, ~2,5 m en hauteur) n'y tenait pas : pentes droites entre deux cases, que le seuil net des bancs
    // changeait en bords rectilignes (rectangles). Le detail fin des bords vient des nuages, lus par pixel.
    const Fbm main(5, 0x51u, 2, 0.5f);
    const Fbm wx(3, 0x9e1u, 2, 0.5f), wy(3, 0x3c7u, 2, 0.5f), wz(3, 0x7f3u, 2, 0.5f);
    const size_t M = (size_t)N * N * N;
    std::vector<float> v(M);
    const int nthreads = (int)std::max(1u, std::min(16u, std::thread::hardware_concurrency()));
    std::vector<std::thread> th;
    for (int t = 0; t < nthreads; t++) {
        th.emplace_back([&, t] {
            for (int z = t; z < N; z += nthreads)
                for (int y = 0; y < N; y++)
                    for (int x = 0; x < N; x++) {
                        const vec3 p = {(float)x / N, (float)y / N, (float)z / N};
                        const vec3 q = p + vec3(wx(p), wy(p), wz(p)) * 0.15f;
                        v[((size_t)z * N + y) * N + x] = main(q);
                    }
        });
    }
    for (std::thread& t : th) t.join();
    // loi normale exacte : chaque valeur remplacee par le quantile de son rang
    std::vector<uint32_t> idx(M);
    std::iota(idx.begin(), idx.end(), 0u);
    std::sort(idx.begin(), idx.end(), [&](uint32_t a, uint32_t b) { return v[a] < v[b]; });
    table.resize(M);
    for (size_t r = 0; r < M; r++) table[idx[r]] = (float)inv_norm_cdf((r + 0.5) / (double)M);
    build_ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
}

void SpatialFogBanks::field(int nx, int ny, int nz, const float origin[3], const float size[3], float t, float wind_x,
                            float wind_z, const SpatialFogSettings& s) {
    const auto t0 = std::chrono::steady_clock::now();
    if (table.empty()) build();
    z.resize((size_t)nx * ny * nz);
    // table : 10 tailles de banc par periode ; bancs 1,3 fois plus minces en hauteur (fumee en couches ; pas plus : les
    // cases de la carte font 1,4 m en hauteur)
    const float tex_per_m = (float)N / (10.0f * std::max(s.bank_size, 0.5f));
    const float scale[3] = {tex_per_m, tex_per_m * 1.3f, tex_per_m};
    const float wind[3] = {wind_x, 0.0f, wind_z};
    const int n[3] = {nx, ny, nz};
    // deux couches, chacune deplacee au hasard a chaque cycle (quand son poids est nul), qui glissent un peu pendant
    // le cycle (les formes se deforment au lieu d'apparaitre et disparaitre sur place) ; melange en triangle ramene au
    // meme ecart type (loi normale inchangee)
    const float T = std::max(s.bank_period, 1.0f);
    float w[2];
    std::vector<int> i0[2][3], i1[2][3];
    std::vector<float> fr[2][3];
    for (int L = 0; L < 2; L++) {
        const float ph = t / T + 0.5f * L;
        const int cyc = (int)std::floor(ph);
        const float f = ph - cyc;
        w[L] = 1.0f - std::fabs(2.0f * f - 1.0f);
        const float morph = (f - 0.5f) * 0.05f * N;   // une demi-taille de banc sur le cycle
        const float ang = rnd(cyc, L, 3) * 2.0f * PI;
        const float mdir[3] = {std::cos(ang), 0.3f * (rnd(cyc, L, 4) - 0.5f), std::sin(ang)};
        for (int a = 0; a < 3; a++) {
            const float jump = rnd(cyc, L, a) * N;
            const float cell = size[a] / n[a];
            i0[L][a].resize(n[a]);
            i1[L][a].resize(n[a]);
            fr[L][a].resize(n[a]);
            for (int i = 0; i < n[a]; i++) {
                const float pw = origin[a] + (i + 0.5f) * cell - wind[a] * t;
                const float u = pw * scale[a] + jump + morph * mdir[a];
                const float fl = std::floor(u);
                const int iu = (int)fl & (N - 1);
                i0[L][a][i] = iu;
                i1[L][a][i] = (iu + 1) & (N - 1);
                fr[L][a][i] = u - fl;
            }
        }
    }
    const float kn = 1.0f / std::sqrt(w[0] * w[0] + w[1] * w[1]);
    const float w0 = w[0] * kn, w1 = w[1] * kn;
    auto at = [&](int x, int y, int zz) { return table[((size_t)zz * N + y) * N + x]; };
    for (int k = 0; k < nz; k++)
        for (int j = 0; j < ny; j++) {
            float* out = &z[((size_t)k * ny + j) * nx];
            for (int i = 0; i < nx; i++) out[i] = 0.0f;
            for (int L = 0; L < 2; L++) {
                const float wl = L ? w1 : w0;
                if (wl <= 0.0f) continue;
                const int z0 = i0[L][2][k], z1 = i1[L][2][k], y0 = i0[L][1][j], y1 = i1[L][1][j];
                const float fz = fr[L][2][k], fy = fr[L][1][j];
                for (int i = 0; i < nx; i++) {
                    const int x0 = i0[L][0][i], x1 = i1[L][0][i];
                    const float fx = fr[L][0][i];
                    const float a00 = lerpf(at(x0, y0, z0), at(x1, y0, z0), fx), a10 = lerpf(at(x0, y1, z0), at(x1, y1, z0), fx);
                    const float a01 = lerpf(at(x0, y0, z1), at(x1, y0, z1), fx), a11 = lerpf(at(x0, y1, z1), at(x1, y1, z1), fx);
                    out[i] += wl * lerpf(lerpf(a00, a10, fy), lerpf(a01, a11, fy), fz);
                }
            }
        }
    field_ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
}

namespace {
// Bruit cellulaire (Worley) periodique : distance au point le plus proche, un point par cellule d'un reseau de periode
// 'per' sur [0, 1)
struct Worley {
    int per;
    std::vector<vec3> pts;
    Worley(int p, uint32_t seed) : per(p), pts((size_t)p * p * p) {
        for (size_t i = 0; i < pts.size(); i++) {
            const uint32_t h = seed * 2654435761u + (uint32_t)i * 2246822519u;
            pts[i] = {hash01(h), hash01(h + 1), hash01(h + 2)};
        }
    }
    float operator()(vec3 p) const {
        const float x = p.x * per, y = p.y * per, z = p.z * per;
        const int ix = (int)std::floor(x), iy = (int)std::floor(y), iz = (int)std::floor(z);
        float best = 9;
        for (int k = -1; k <= 1; k++)
            for (int j = -1; j <= 1; j++)
                for (int i = -1; i <= 1; i++) {
                    const int cx = ix + i, cy = iy + j, cz = iz + k;
                    const int wx = (cx % per + per) % per, wy = (cy % per + per) % per, wz = (cz % per + per) % per;
                    const vec3& o = pts[((size_t)wz * per + wy) * per + wx];
                    const float dx = cx + o.x - x, dy = cy + o.y - y, dz = cz + o.z - z;
                    best = std::min(best, dx * dx + dy * dy + dz * dz);
                }
        return std::sqrt(best);
    }
};

// Chaque valeur du canal c (sur 2) remplacee par le quantile de son rang dans la loi normale : 0,5 + z x CLOUD_SD
void to_normal(std::vector<float>& f, int c) {
    const size_t M = f.size() / 2;
    std::vector<uint32_t> idx(M);
    std::iota(idx.begin(), idx.end(), 0u);
    std::sort(idx.begin(), idx.end(), [&](uint32_t a, uint32_t b) { return f[(size_t)a * 2 + c] < f[(size_t)b * 2 + c]; });
    std::vector<float> out(M);
    for (size_t r = 0; r < M; r++) out[idx[r]] = saturate(0.5f + CLOUD_SD * (float)inv_norm_cdf((r + 0.5) / (double)M));
    for (size_t i = 0; i < M; i++) f[i * 2 + c] = out[i];
}
}  // namespace

// Nuages : bruit de Perlin-Worley (nuages temps reel de Schneider : un Perlin remappe par un Worley inverse a 3 octaves,
// formes bombees de cumulus), periode 1 = un motif. Les 2 canaux sont le meme champ a deux instants : domaine deforme par
// un bruit lent dans un sens, puis dans l'autre (comme les volutes) ; le shader les melange en aller-retour.
void SpatialFogClouds::build() {
    const auto t0 = std::chrono::steady_clock::now();
    const int N = CLOUD_N;
    const Fbm perlin(4, 0x2a1u, 4, 0.5f);
    const Worley w4(4, 0x11u), w8(8, 0x23u), w16(16, 0x37u);
    const Fbm dx(2, 0x51u, 3, 0.5f), dy(2, 0x52u, 3, 0.5f), dz(2, 0x53u, 3, 0.5f);
    const float A = 0.12f;
    const size_t M = (size_t)N * N * N;
    std::vector<float> f(M * 2);
    const int nthreads = (int)std::max(1u, std::min(16u, std::thread::hardware_concurrency()));
    std::vector<std::thread> th;
    for (int t = 0; t < nthreads; t++) {
        th.emplace_back([&, t] {
            for (int z = t; z < N; z += nthreads)
                for (int y = 0; y < N; y++)
                    for (int x = 0; x < N; x++) {
                        const vec3 p = {(x + 0.5f) / N, (y + 0.5f) / N, (z + 0.5f) / N};
                        const vec3 a = vec3(dx(p), dy(p), dz(p)) * A;
                        for (int c = 0; c < 2; c++) {
                            const vec3 q = c == 0 ? p + a : p - a;
                            const float pn = saturate(0.5f + perlin(q) * 1.4f);
                            const float wf = 0.625f * (1 - std::min(w4(q), 1.0f)) + 0.25f * (1 - std::min(w8(q), 1.0f)) +
                                             0.125f * (1 - std::min(w16(q), 1.0f));
                            f[(((size_t)z * N + y) * N + x) * 2 + c] = (pn - (wf - 1.0f)) / (2.0f - wf);
                        }
                    }
        });
    }
    for (std::thread& t : th) t.join();
    to_normal(f, 0);
    to_normal(f, 1);
    auto sd_of = [](const std::vector<float>& v) {
        double a = 0, a2 = 0;
        for (size_t i = 0; i < v.size(); i += 2) { a += v[i]; a2 += (double)v[i] * v[i]; }
        const double n = (double)(v.size() / 2);
        return (float)(std::sqrt(std::max(a2 / n - (a / n) * (a / n), 0.0)) / CLOUD_SD);
    };
    mips.clear();
    level_sd.clear();
    level_sd.push_back(sd_of(f));
    mips.push_back(bc5_compress_level(f, N));
    for (int n = N; n > 1; n /= 2) {
        const int h = n / 2;
        std::vector<float> dst((size_t)h * h * h * 2);
        for (int z = 0; z < h; z++)
            for (int y = 0; y < h; y++)
                for (int x = 0; x < h; x++)
                    for (int c = 0; c < 2; c++) {
                        float a = 0;
                        for (int k = 0; k < 8; k++)
                            a += f[((((size_t)(2 * z + (k >> 2)) * n + 2 * y + ((k >> 1) & 1)) * n) + 2 * x + (k & 1)) * 2 + c];
                        dst[(((size_t)z * h + y) * h + x) * 2 + c] = a * 0.125f;
                    }
        f.swap(dst);
        level_sd.push_back(sd_of(f));
        mips.push_back(bc5_compress_level(f, h));
    }
    // ecart type des niveaux 1 a 4 relatif au niveau 0 : 1 - shrink x l^2 (moindres carres)
    double num = 0, den = 0;
    for (int l = 1; l <= 4 && l < (int)level_sd.size(); l++) {
        const double x = (double)l * l, y = 1.0 - level_sd[l] / level_sd[0];
        num += x * y;
        den += x * x;
    }
    shrink = den > 0 ? (float)(num / den) : 0.0f;
    build_ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
}

void spatial_fog_cloud_params(const SpatialFogSettings& s, const SpatialFogClouds& c, float time, float wind_x, float wind_y,
                              float wind_z, float out[5][4]) {
    const float sz = std::max(s.cloud_size, 0.5f);
    // lvol : derive avec le vent, 1 / taille
    out[0][0] = -wind_x * time / sz;
    out[0][1] = -wind_y * time / sz;
    out[0][2] = -wind_z * time / sz;
    out[0][3] = 1.0f / sz;
    // lvolw, lvol2.x : 2 instants melanges en aller-retour, en ecarts types (z = r wr + g wg + lvol2.x)
    const float f = 1.0f - std::fabs(1.0f - 2.0f * fractf(time / std::max(s.cloud_period, 0.5f)));
    const float kn = 1.0f / (CLOUD_SD * std::sqrt((1.0f - f) * (1.0f - f) + f * f));
    out[1][0] = (1.0f - f) * kn;
    out[1][1] = f * kn;
    out[1][2] = out[1][3] = 0.0f;
    out[2][0] = -0.5f * kn;
    out[2][1] = std::log2((float)CLOUD_N / sz);   // texels par metre
    out[2][2] = s.cloud_erode > 0.0f ? s.cloud_lod : -1000.0f;
    out[2][3] = s.cloud_erode > 0.0f ? std::max(s.bank_rag, 0.0f) : 0.0f;   // contour des bancs deforme par les nuages
    // lvol3 : contraste perdu par niveau, seuil au coeur des bancs, seuil en plus a leur bord, demi-largeur du bord
    const float tz = (float)inv_norm_cdf(1.0 - clampf(s.cloud_cover, 0.02f, 0.98f));
    const float w = std::max(s.cloud_soft, 0.02f);
    out[3][0] = c.shrink;
    out[3][1] = tz;
    out[3][2] = std::max(s.cloud_rag, 0.0f);
    out[3][3] = w;
    // lvol4 : 1 / moyenne du masque au coeur des bancs (brillance moyenne d'un banc inchangee), force de l'erosion,
    // relief interne (a + b x (z - seuil), de 1 - relief au bord a 1 a 1,5 ecart type du bord)
    const float core = saturate(s.cloud_core), a = 1.0f - core, b = core / 1.5f;
    double sum = 0, wsum = 0;
    for (int i = 0; i <= 1200; i++) {
        const float z = -6.0f + i * 0.01f;
        const double pdf = std::exp(-0.5 * z * z);
        sum += pdf * smoothstepf(tz - w, tz + w, z) * (a + b * clampf(z - tz, 0.0f, 1.5f));
        wsum += pdf;
    }
    out[4][0] = (float)(wsum / std::max(sum, 1e-6));
    out[4][1] = std::max(s.cloud_erode, 0.0f);
    out[4][2] = a;
    out[4][3] = b;
}

void spatial_fog_motion_params(const SpatialFogSettings& s, float time, float wind_x, float wind_y, float wind_z, float vol_sd,
                               int vol_n, float out[6][4]) {
    // lswirl, lswirl2 : (nombre d'onde, amplitude, phase) ; phase reduite modulo 2 pi x 100 (precision des flottants)
    const float k = 2.0f * PI / std::max(s.swirl_size, 0.2f);
    const float ph = std::fmod(time * s.swirl_speed, 200.0f * PI);
    out[0][0] = k;
    out[0][1] = std::max(s.swirl_amp, 0.0f);
    out[0][2] = ph;
    out[0][3] = 0.0f;
    out[1][0] = k * 3.3f;
    out[1][1] = out[0][1] / 3.0f;
    out[1][2] = std::fmod(time * s.swirl_speed * 2.5f, 200.0f * PI);
    out[1][3] = 0.0f;
    // lfil : derive avec le vent (1,6 fois plus vite : petite echelle), 1 / taille
    const float sz = std::max(s.fil_size, 0.05f);
    out[2][0] = -1.6f * wind_x * time / sz;
    out[2][1] = -1.6f * wind_y * time / sz;
    out[2][2] = -1.6f * wind_z * time / sz;
    out[2][3] = 1.0f / sz;
    // lfil2 : 2 instants melanges en aller-retour, en ecarts types ; texels par metre
    const float f = 1.0f - std::fabs(1.0f - 2.0f * fractf(time / std::max(s.fil_period, 0.5f)));
    const float kn = 1.0f / (vol_sd * std::sqrt((1.0f - f) * (1.0f - f) + f * f));
    out[3][0] = (1.0f - f) * kn;
    out[3][1] = f * kn;
    out[3][2] = -0.5f * kn;
    out[3][3] = std::log2((float)vol_n / sz);
    // lfil3 : niveau ou ils s'effacent, force
    out[4][0] = s.fil_strength > 0.0f ? s.fil_lod : -1000.0f;
    out[4][1] = std::max(s.fil_strength, 0.0f);
    out[4][2] = out[4][3] = 0.0f;
    // lwarp : deformation des nuages a tres grande echelle (longueur d'onde ~4,3 fois leur motif, sans rapport entier : le
    // motif ne retombe jamais sur lui-meme), fixe dans l'espace
    out[5][0] = 2.0f * PI / (4.3f * std::max(s.cloud_size, 0.5f));
    out[5][1] = std::max(s.cloud_warp, 0.0f);
    out[5][2] = 2.3f;
    out[5][3] = 0.0f;
}

void SpatialFogProfile::setup(const SpatialFogSettings& s) {
    thr = s.bank_cover <= 0.001f ? 1e9f : (float)inv_norm_cdf(1.0 - std::min(s.bank_cover, 0.999f));
    edge = std::max(s.bank_edge, 0.1f);
    core = std::max(s.bank_core, 0.0f);
    keep = saturate(1.0f - s.voids);
    inv_mean = 1;
    // moyenne sur la loi normale (la couverture et la loi du champ ne changent pas dans le temps : quantite constante)
    double sum = 0, wsum = 0;
    for (int i = 0; i <= 1200; i++) {
        const float zz = -6.0f + i * 0.01f;
        const double pdf = std::exp(-0.5 * zz * zz);
        float M, B;
        eval(zz, M, B);
        sum += pdf * M;
        wsum += pdf;
    }
    const double mean = sum / wsum;
    inv_mean = mean > 1e-6 ? (float)(1.0 / mean) : 1.0f;
}

const char* const SPATIAL_FOG_PRESET_NAMES[SPATIAL_FOG_PRESETS] = {
    "Par defaut (bancs, nuages, filaments)", "Hazer propre (nappe lisse)", "Hazer + panache local", "Concert, machines a fumee",
    "Nuages larges et doux", "Marbre de pres", "Salle composee (melange)"};

SpatialFogSettings spatial_fog_preset(int n) {
    SpatialFogSettings s;
    s.model = 1;
    s.preset = n;
    switch (n) {
        case 1:   // brume uniforme du hazer : aucun banc, rien de ronge (variante 1, comme sans volutes)
            s.bank_cover = 0;
            s.voids = 0;
            s.sim = 0;
            s.cloud_erode = 0;
            s.fil_strength = 0;
            break;
        case 2:   // brume uniforme diluee ; seuls les amas des machines ont des nuages et des filaments (image 04)
            s.bank_cover = 0;
            s.voids = 0;
            s.sim = 1.0f;
            s.cloud_cover = 0.6f;
            s.cloud_rag = 1.2f;
            s.cloud_soft = 0.3f;
            break;
        case 3:   // bancs denses a bords nets, zones vides, nuages epais et trous (images 01, 05)
        case 5:   // idem, avec des filaments marbres forts de pres (image 06)
            s.bank_cover = 0.4f;
            s.bank_size = 9.0f;
            s.bank_edge = 4.0f;
            s.bank_core = 0.6f;
            s.bank_rag = 0.9f;
            s.voids = 0.95f;
            s.sim = 0.3f;
            s.cloud_size = 10.0f;
            s.cloud_cover = 0.5f;
            s.cloud_rag = 1.0f;
            s.cloud_soft = 0.12f;
            s.cloud_core = 0.8f;
            if (n == 5) {
                s.fil_strength = 1.2f;
                s.fil_size = 0.35f;
                s.fil_lod = 0.0f;
                s.swirl_amp = 0.5f;
                s.swirl_size = 3.0f;
            }
            break;
        case 4:   // bancs larges sans trous, nuages larges a bords doux (images 03, 07, 08)
            s.bank_size = 14.0f;
            s.bank_cover = 0.6f;
            s.bank_edge = 1.2f;
            s.bank_rag = 0.5f;
            s.voids = 0.4f;
            s.sim = 0.2f;
            s.cloud_erode = 0.8f;
            s.cloud_size = 20.0f;
            s.cloud_cover = 0.65f;
            s.cloud_rag = 0.4f;
            s.cloud_soft = 0.6f;
            s.fil_strength = 0.3f;
            s.swirl_amp = 0.6f;
            s.swirl_size = 8.0f;
            break;
        case 6:   // salle composee : nuages larges et doux, concert pres de la scene et en bas, panaches
            s.mix = 1;
            break;
        default:
            break;
    }
    return s;
}

SpatialFogSettings spatial_fog_style(const SpatialFogSettings& s, int dense) {
    if (!s.mix) return s;
    const SpatialFogSettings p = spatial_fog_preset(dense ? s.mix_dense : s.mix_soft);
    SpatialFogSettings r = s;
    r.bank_cover = p.bank_cover;
    r.bank_core = p.bank_core;
    r.bank_edge = p.bank_edge;
    r.voids = p.voids;
    r.bank_rag = p.bank_rag;
    r.cloud_erode = p.cloud_erode;
    r.cloud_cover = p.cloud_cover;
    r.cloud_rag = p.cloud_rag;
    r.cloud_soft = p.cloud_soft;
    r.cloud_core = p.cloud_core;
    return r;
}

void spatial_fog_randomize(SpatialFogSettings& s, uint32_t n) {
    // fourchettes verifiees aux deux bouts (images bench/lasers_images/fumee_v2/e6_extremes*) : au-dela, la salle devient
    // soit uniforme (plus rien a melanger), soit un damier de regions trop petites, soit noyee pres de la scene (au
    // maximum de la scene, du sol, des panaches et de la quantite a la fois, l'image y etait blanche)
    uint32_t k = n * 2654435761u + 0x9e3779b9u;
    auto r = [&](float a, float b) { k = hash_u32(k + 0x632be5abu); return a + (b - a) * ((k & 0xFFFFFF) / 16777216.0f); };
    static const int SOFT[5] = {0, 0, 1, 2, 4};
    s = spatial_fog_preset(6);
    s.mix_soft = SOFT[(int)r(0, 4.999f)];
    s.mix_dense = r(0, 1) < 0.65f ? 3 : 5;
    s.region_size = r(18, 60);
    s.dense_share = r(0.25f, 0.6f);
    s.region_sharp = r(0.1f, 0.5f);
    s.stage_boost = r(0.3f, 0.9f);
    s.stage_dist = r(15, 40);
    s.low_boost = r(0.2f, 0.8f);
    s.back_dilute = r(0.2f, 0.7f);
    s.density_var = r(0.15f, 0.5f);
    s.plumes = (int)r(2, 8.999f);
    s.plume_width = r(2, 5);
    s.plume_height = r(8, 22);
    s.bank_size = r(6, 12);
    s.cloud_size = r(8, 16);
    s.cloud_warp = r(2.5f, 6);
    s.swirl_amp = r(0.2f, 0.7f);
    s.swirl_size = r(3, 8);
    s.haze = r(0.85f, 1.15f);
    s.seed = (int)(n % 100000u) + 1;
}

namespace {
// Bruit de gradient 3D sans periode (reseau infini, gradients tires d'un hachage) : les champs de la salle ne se
// repetent jamais, quelle que soit sa taille. Valeurs ~[-0,7 ; 0,7].
float gnoise(float x, float y, float z, uint32_t seed) {
    const int ix = (int)std::floor(x), iy = (int)std::floor(y), iz = (int)std::floor(z);
    const float fx = x - ix, fy = y - iy, fz = z - iz;
    auto fade = [](float t) { return t * t * t * (t * (t * 6 - 15) + 10); };
    const float ux = fade(fx), uy = fade(fy), uz = fade(fz);
    float r = 0;
    for (int c = 0; c < 8; c++) {
        const int dx = c & 1, dy = (c >> 1) & 1, dz = c >> 2;
        uint32_t h = hash_u32((uint32_t)(ix + dx) * 73856093u ^ (uint32_t)(iy + dy) * 19349663u ^ (uint32_t)(iz + dz) * 83492791u ^ seed);
        // une des 12 directions des aretes d'un cube (Perlin ameliore)
        static const float G[12][3] = {{1, 1, 0}, {-1, 1, 0}, {1, -1, 0}, {-1, -1, 0}, {1, 0, 1}, {-1, 0, 1},
                                       {1, 0, -1}, {-1, 0, -1}, {0, 1, 1}, {0, -1, 1}, {0, 1, -1}, {0, -1, -1}};
        const float* g = G[h % 12];
        const float w = (dx ? ux : 1 - ux) * (dy ? uy : 1 - uy) * (dz ? uz : 1 - uz);
        r += w * (g[0] * (fx - dx) + g[1] * (fy - dy) + g[2] * (fz - dz));
    }
    return r;
}
float gfbm(vec3 p, uint32_t seed, int oct) {
    float v = 0, a = 1;
    for (int o = 0; o < oct; o++) {
        v += a * gnoise(p.x, p.y, p.z, seed + 977u * (uint32_t)o);
        p = vec3(p.z * 1.6f + p.x * 0.8f, p.y * 2.0f, p.x * 1.6f - p.z * 0.8f) + vec3(17.3f, 5.1f, -9.7f);   // rotation, x 2
        a *= 0.5f;
    }
    return v;
}
void standardize(std::vector<float>& v) {
    double a = 0, a2 = 0;
    for (float x : v) { a += x; a2 += (double)x * x; }
    const double m = a / v.size(), sd = std::sqrt(std::max(a2 / v.size() - m * m, 1e-12));
    for (float& x : v) x = (float)((x - m) / sd);
}
}  // namespace

void SpatialFogRoom::compute(int nx, int ny, int nz, const float origin[3], const float size[3], float wind_x, float wind_z,
                             const SpatialFogSettings& s) {
    const auto t0 = std::chrono::steady_clock::now();
    const size_t M = (size_t)nx * ny * nz;
    amount.resize(M);
    style.resize(M);
    zbias.resize(M);
    std::vector<float> n1(M), n2(M), n3(M), plume(M, 0.0f);
    // la scene est au bout -x du hangar (nez de scene a 15,5 % de la longueur) ; le public vers +x
    const float x0 = origin[0], x1 = origin[0] + size[0], front = x0 + 0.155f * size[0];
    const uint32_t seed = (uint32_t)s.seed * 7919u;
    const float rs = std::max(s.region_size, 5.0f);
    // panaches : colonnes qui montent (plus nombreuses pres de la scene), penchees par le vent, qui ondulent et
    // s'evasent en montant
    struct Plume { float x, z, w, h, ph, str; };
    std::vector<Plume> pl;
    {
        uint32_t k = seed + 0x51ed27u;
        auto r = [&](float a, float b) { k = hash_u32(k + 0x2545f491u); return a + (b - a) * ((k & 0xFFFFFF) / 16777216.0f); };
        for (int i = 0; i < std::min(std::max(s.plumes, 0), 16); i++) {
            const bool near_stage = r(0, 1) < 0.6f;
            const float px = near_stage ? r(front - 4, front + 30) : r(front, x1 - 3);
            pl.push_back({px, r(origin[2] + 3, origin[2] + size[2] - 3), s.plume_width * r(0.7f, 1.3f),
                          s.plume_height * r(0.7f, 1.3f), r(0, 6.28f), r(0.7f, 1.2f)});
        }
    }
    const float wl = std::sqrt(wind_x * wind_x + wind_z * wind_z);
    const float wdx = wl > 1e-4f ? wind_x / wl : 1, wdz = wl > 1e-4f ? wind_z / wl : 0;
    const float bend = 0.35f * std::min(wl / 0.35f, 2.0f);
    const int nthreads = (int)std::max(1u, std::min(16u, std::thread::hardware_concurrency()));
    std::vector<std::thread> th;
    for (int t = 0; t < nthreads; t++) {
        th.emplace_back([&, t] {
            for (int z = t; z < nz; z += nthreads)
                for (int y = 0; y < ny; y++)
                    for (int x = 0; x < nx; x++) {
                        const size_t i = ((size_t)z * ny + y) * nx + x;
                        const vec3 p = {origin[0] + (x + 0.5f) * size[0] / nx, origin[1] + (y + 0.5f) * size[1] / ny,
                                        origin[2] + (z + 0.5f) * size[2] / nz};
                        // regions plus larges que hautes (couches de fumee)
                        const vec3 q = vec3(p.x, p.y * 1.6f, p.z) * (1.0f / rs);
                        n1[i] = gfbm(q, seed + 11u, 3);
                        n2[i] = gfbm(q * 0.8f + vec3(31.7f, 0, 12.9f), seed + 23u, 3);
                        n3[i] = gfbm(q * 1.4f + vec3(-8.3f, 0, 44.1f), seed + 37u, 3);
                        float P = 0;
                        for (const Plume& u : pl) {
                            if (p.y > u.h * 1.3f) continue;
                            const float cx = u.x + wdx * bend * p.y + 1.2f * std::sin(p.y * 0.35f + u.ph);
                            const float cz = u.z + wdz * bend * p.y + 1.2f * std::cos(p.y * 0.27f + u.ph * 1.7f);
                            const float R = u.w * (0.7f + 0.6f * p.y / u.h);
                            const float d2 = (p.x - cx) * (p.x - cx) + (p.z - cz) * (p.z - cz);
                            P = std::max(P, u.str * std::exp(-d2 / (2 * R * R)) * smoothstepf(u.h * 1.3f, u.h * 0.4f, p.y));
                        }
                        plume[i] = P;
                    }
        });
    }
    for (std::thread& t : th) t.join();
    standardize(n1);
    standardize(n2);
    standardize(n3);
    // style (0 doux, 1 charge) : regions organiques, plus chargees pres de la scene, pres du sol et dans les panaches,
    // plus douces au fond ; seuil choisi pour que la part chargee soit dense_share
    std::vector<float> raw(M);
    double asum = 0;
    for (int z = 0; z < nz; z++)
        for (int y = 0; y < ny; y++)
            for (int x = 0; x < nx; x++) {
                const size_t i = ((size_t)z * ny + y) * nx + x;
                const float px = origin[0] + (x + 0.5f) * size[0] / nx, py = origin[1] + (y + 0.5f) * size[1] / ny;
                const float near = px < front ? 1.0f : std::exp(-(px - front) / std::max(s.stage_dist, 1.0f));
                const float back = saturate((px - front) / std::max(x1 - front, 1.0f));
                const float low = std::exp(-std::max(py, 0.0f) / 4.0f);
                raw[i] = n1[i] + 1.0f * s.stage_boost * near + 0.5f * s.low_boost * low - 0.8f * s.back_dilute * back + 2.0f * plume[i];
                amount[i] = (1 + s.stage_boost * near) * (1 + s.low_boost * low) *
                            (1 - s.back_dilute * smoothstepf(0.15f, 1.0f, back)) * std::exp(s.density_var * 0.8f * n2[i]) *
                            (1 + 1.5f * plume[i]);
                asum += amount[i];
                zbias[i] = clampf(0.7f * n3[i] + 0.4f * s.low_boost * low - 0.6f * s.back_dilute * back + 2.5f * plume[i], -2.5f, 2.5f);
            }
    std::vector<float> sorted = raw;
    const size_t qi = std::min(M - 1, (size_t)((1.0f - saturate(s.dense_share)) * M));
    std::nth_element(sorted.begin(), sorted.begin() + qi, sorted.end());
    // demi-largeur de la transition, en ecarts types du champ des regions : au plus net, 0,5 (encore quelques metres) ;
    // plus court, les deux ambiances se coupaient (frontiere visible)
    const float q = sorted[qi], w = lerpf(2.0f, 0.5f, saturate(s.region_sharp));
    // moyenne 1 (la quantite de fumee reste celle du reglage), concentration plafonnee a 3,2 fois la moyenne (sinon la
    // scene est noyee quand tout s'additionne : scene, sol, panaches), puis moyenne remise a 1
    const float inv_mean = (float)(M / std::max(asum, 1e-9));
    double csum = 0;
    for (size_t i = 0; i < M; i++) {
        style[i] = s.dense_share <= 0.001f ? 0.0f : (s.dense_share >= 0.999f ? 1.0f : smoothstepf(q - w, q + w, raw[i]));
        amount[i] = std::min(amount[i] * inv_mean, 3.2f);
        csum += amount[i];
    }
    const float renorm = (float)(M / std::max(csum, 1e-9));
    amount_max = 1e-6f;
    for (size_t i = 0; i < M; i++) {
        amount[i] *= renorm;
        amount_max = std::max(amount_max, amount[i]);
    }
    built = s;
    valid = true;
    build_ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
}

bool spatial_fog_set(SpatialFogSettings& s, const std::string& k, float v) {
    if (k == "laserfogmodel") s.model = (int)v;
    else if (k == "sfpreset") s = spatial_fog_preset(std::min(std::max((int)v, 0), SPATIAL_FOG_PRESETS - 1));
    else if (k == "sfrandom") spatial_fog_randomize(s, (uint32_t)v);
    else if (k == "sfhaze") s.haze = v;
    else if (k == "sfsim") s.sim = v;
    else if (k == "sfheight") s.height = v;
    else if (k == "sfcover") s.bank_cover = v;
    else if (k == "sfbanksize") s.bank_size = v;
    else if (k == "sfbankcore") s.bank_core = v;
    else if (k == "sfbankedge") s.bank_edge = v;
    else if (k == "sfvoid") s.voids = v;
    else if (k == "sfbankevol") s.bank_period = v;
    else if (k == "sfbankrag") s.bank_rag = v;
    else if (k == "sferode") s.cloud_erode = v;
    else if (k == "sfcloudsize") s.cloud_size = v;
    else if (k == "sfcloudcover") s.cloud_cover = v;
    else if (k == "sfcloudrag") s.cloud_rag = v;
    else if (k == "sfcloudsoft") s.cloud_soft = v;
    else if (k == "sfcloudcore") s.cloud_core = v;
    else if (k == "sfcloudevol") s.cloud_period = v;
    else if (k == "sfcloudlod") s.cloud_lod = v;
    else if (k == "sfcloudwarp") s.cloud_warp = v;
    else if (k == "sfswirl") s.swirl_amp = v;
    else if (k == "sfswirlsize") s.swirl_size = v;
    else if (k == "sfswirlspeed") s.swirl_speed = v;
    else if (k == "sffil") s.fil_strength = v;
    else if (k == "sffilsize") s.fil_size = v;
    else if (k == "sffillod") s.fil_lod = v;
    else if (k == "sffilevol") s.fil_period = v;
    else if (k == "sfmix") s.mix = (int)v;
    else if (k == "sfmixa") s.mix_soft = (int)v;
    else if (k == "sfmixb") s.mix_dense = (int)v;
    else if (k == "sfregion") s.region_size = v;
    else if (k == "sfdense") s.dense_share = v;
    else if (k == "sfregsharp") s.region_sharp = v;
    else if (k == "sfstage") s.stage_boost = v;
    else if (k == "sfstagedist") s.stage_dist = v;
    else if (k == "sflow") s.low_boost = v;
    else if (k == "sfback") s.back_dilute = v;
    else if (k == "sfvar") s.density_var = v;
    else if (k == "sfplumes") s.plumes = (int)v;
    else if (k == "sfplumew") s.plume_width = v;
    else if (k == "sfplumeh") s.plume_height = v;
    else if (k == "sfseed") s.seed = (int)v;
    else return false;
    return true;
}

void spatial_fog_ui_model(SpatialFogSettings& s) {
    ImGui::Combo("Modele de fumee##sf", &s.model, "Classique\0Spatiale (v2)\0");
    ImGui::SetItemTooltip("Classique : fumee de la piece et volutes periodiques.\n"
                          "Spatiale (v2) : bancs de fumee 3D fixes dans l'espace, communs a tous les lasers\n"
                          "(zones chargees, diluees, vides).");
}

namespace {
// Choix d'un prereglage parmi une liste (ambiances de la salle composee)
void preset_combo(const char* label, int& v, const int* list, int n) {
    if (ImGui::BeginCombo(label, SPATIAL_FOG_PRESET_NAMES[v])) {
        for (int i = 0; i < n; i++)
            if (ImGui::Selectable(SPATIAL_FOG_PRESET_NAMES[list[i]], v == list[i])) v = list[i];
        ImGui::EndCombo();
    }
}
}  // namespace

void spatial_fog_ui_settings(SpatialFogSettings& s, const SpatialFogBanks& banks, const SpatialFogRoom& room) {
    if (s.model != 1) return;
    // prereglage : remplit tous les reglages en dessous ; « (modifie) » si l'un d'eux a change depuis
    {
        const SpatialFogSettings p = spatial_fog_preset(s.preset);
        const bool same = std::memcmp(&p, &s, sizeof(SpatialFogSettings)) == 0;
        char label[96];
        std::snprintf(label, sizeof(label), "%s%s", SPATIAL_FOG_PRESET_NAMES[s.preset], same ? "" : " (modifie)");
        if (ImGui::BeginCombo("Prereglage##sf", label)) {
            for (int i = 0; i < SPATIAL_FOG_PRESETS; i++)
                if (ImGui::Selectable(SPATIAL_FOG_PRESET_NAMES[i], i == s.preset)) s = spatial_fog_preset(i);
            ImGui::EndCombo();
        }
        ImGui::SameLine();
        if (ImGui::SmallButton("Revenir##sf")) s = spatial_fog_preset(s.preset);
    }
    ImGui::SliderFloat("Quantite de fumee##sf", &s.haze, 0, 3, "x %.2f");
    ImGui::SetItemTooltip("x la fumee moyenne du modele Classique (brume et amas). Les bancs la repartissent sans changer sa moyenne.");
    ImGui::SliderFloat("Amas des machines (en plus)##sf", &s.sim, 0, 2, "x %.2f");
    ImGui::SliderFloat("Decroissance en hauteur##sf", &s.height, 0, 0.15f, "%.3f /m");
    if (s.mix && ImGui::TreeNodeEx("Salle composee (ambiances melangees dans la piece)##sf", ImGuiTreeNodeFlags_DefaultOpen)) {
        if (ImGui::Button("Aleatoire##sfm")) spatial_fog_randomize(s, (uint32_t)(ImGui::GetTime() * 1000.0) ^ (uint32_t)s.seed * 7u);
        ImGui::SetItemTooltip("Tire tous les reglages de la salle composee dans des fourchettes realistes (et une nouvelle disposition).");
        ImGui::SameLine();
        ImGui::SetNextItemWidth(120);
        ImGui::InputInt("Graine (disposition)##sfm", &s.seed);
        static const int SOFT[4] = {0, 1, 2, 4}, DENSE[2] = {3, 5};
        preset_combo("Ambiance douce##sfm", s.mix_soft, SOFT, 4);
        preset_combo("Ambiance chargee##sfm", s.mix_dense, DENSE, 2);
        ImGui::SliderFloat("Taille des regions##sfm", &s.region_size, 15, 80, "%.0f m");
        ImGui::SliderFloat("Part chargee##sfm", &s.dense_share, 0, 1, "%.2f");
        ImGui::SliderFloat("Transitions (longues / courtes)##sfm", &s.region_sharp, 0, 1, "%.2f");
        ImGui::SetItemTooltip("Les ambiances se superposent toujours en degrade (aucune coupure) ; 1 : degrade plus court.");
        ImGui::SliderFloat("Plus de fumee pres de la scene##sfm", &s.stage_boost, 0, 2, "%.2f");
        ImGui::SliderFloat("... sur##sfm", &s.stage_dist, 5, 60, "%.0f m");
        ImGui::SliderFloat("Fumee pres du sol##sfm", &s.low_boost, 0, 2, "%.2f");
        ImGui::SliderFloat("Fond de salle dilue##sfm", &s.back_dilute, 0, 1, "%.2f");
        ImGui::SliderFloat("Variation de la quantite##sfm", &s.density_var, 0, 1, "%.2f");
        ImGui::SliderInt("Panaches qui montent##sfm", &s.plumes, 0, 16);
        if (s.plumes > 0) {
            ImGui::SliderFloat("Largeur des panaches##sfm", &s.plume_width, 1, 8, "%.1f m");
            ImGui::SliderFloat("Hauteur des panaches##sfm", &s.plume_height, 4, 30, "%.0f m");
        }
        ImGui::TextDisabled("(salle calculee en %.1f ms, a chaque changement de ces reglages)", room.build_ms);
        ImGui::TreePop();
    }
    const SpatialFogSettings sa = spatial_fog_style(s, 0), sb = spatial_fog_style(s, 1);
    const float erode_any = std::max(sa.cloud_erode, sb.cloud_erode);
    if (ImGui::TreeNodeEx("Bancs de fumee (grande echelle)##sf", ImGuiTreeNodeFlags_DefaultOpen)) {
        if (!s.mix) {
            ImGui::SliderFloat("Couverture##sfb", &s.bank_cover, 0, 1, "%.2f");
            ImGui::SetItemTooltip("Part de l'espace occupee par les bancs de fumee (0 : brume uniforme).");
        }
        ImGui::SliderFloat("Taille##sfb", &s.bank_size, 2, 20, "%.1f m");
        if (!s.mix) {
            ImGui::SliderFloat("Coeurs denses##sfb", &s.bank_core, 0, 2, "%.2f");
            ImGui::SliderFloat("Nettete des bords##sfb", &s.bank_edge, 0.5f, 8, "%.2f");
            ImGui::SliderFloat("Zones vides##sfb", &s.voids, 0, 1, "%.2f");
            ImGui::SetItemTooltip("Part de la fumee retiree hors des bancs (1 : rien hors des bancs, le laser n'y passe pas).");
        }
        ImGui::SliderFloat("Evolution##sfb", &s.bank_period, 5, 300, "%.0f s", ImGuiSliderFlags_Logarithmic);
        if (!s.mix) {
            ImGui::SliderFloat("Bords nuageux##sfb", &s.bank_rag, 0, 2, "%.2f");
            ImGui::SetItemTooltip("Le contour des bancs prend la forme des nuages (bombe, dechiquete) au lieu d'une grande courbe lisse.\n"
                                  "0 : contour lisse. Sans effet si l'erosion des nuages est coupee.");
        } else {
            ImGui::TextDisabled("(couverture, bords, zones vides : ceux des deux ambiances)");
        }
        ImGui::TextDisabled("(table %.0f ms au 1er usage ; champ %.2f ms par pas de la simulation)", banks.build_ms, banks.field_ms);
        ImGui::TreePop();
    }
    if (ImGui::TreeNodeEx("Nuages (moyenne echelle)##sf", ImGuiTreeNodeFlags_DefaultOpen)) {
        if (!s.mix) {
            ImGui::SliderFloat("Erosion##sfn", &s.cloud_erode, 0, 1, "%.2f");
            ImGui::SetItemTooltip("Une texture de nuages ronge la fumee des bancs et des amas (0 : nappe lisse, la carte seule).\n"
                                  "La brume uniforme n'est jamais rongee.");
        }
        if (erode_any > 0.0f) {
            ImGui::SliderFloat("Taille##sfn", &s.cloud_size, 2, 30, "%.1f m");
            if (!s.mix) {
                ImGui::SliderFloat("Couverture##sfn", &s.cloud_cover, 0.05f, 0.95f, "%.2f");
                ImGui::SetItemTooltip("Part des nuages au coeur des bancs ; le reste devient des trous.");
                ImGui::SliderFloat("Bords des bancs ronges##sfn", &s.cloud_rag, 0, 2, "%.2f");
                ImGui::SliderFloat("Douceur des bords##sfn", &s.cloud_soft, 0.02f, 1.5f, "%.2f", ImGuiSliderFlags_Logarithmic);
                ImGui::SliderFloat("Coeurs denses##sfn", &s.cloud_core, 0, 1, "%.2f");
            }
            ImGui::SliderFloat("Evolution##sfn", &s.cloud_period, 2, 120, "%.0f s", ImGuiSliderFlags_Logarithmic);
            ImGui::SliderFloat("Portee (niveau)##sfn", &s.cloud_lod, 1, 7, "%.1f");
            ImGui::SliderFloat("Variation a tres grande echelle##sfn", &s.cloud_warp, 0, 10, "%.1f m");
            ImGui::SetItemTooltip("Le motif des nuages est deforme a tres grande echelle (~4 fois leur taille, sans periode) :\n"
                                  "il ne se repete plus d'un bout a l'autre de la salle.");
        }
        ImGui::TreePop();
    }
    if (erode_any > 0.0f && ImGui::TreeNodeEx("Mouvement (tourbillons)##sf", ImGuiTreeNodeFlags_DefaultOpen)) {
        ImGui::SliderFloat("Amplitude##sft", &s.swirl_amp, 0, 2, "%.2f m");
        ImGui::SetItemTooltip("La fumee tourne et se tord sur place (champ de tourbillons analytique, sans simulation).\n"
                              "Le vent et la turbulence restent ceux de la simulation (onglet Fumee).");
        ImGui::SliderFloat("Taille##sft", &s.swirl_size, 0.5f, 20, "%.1f m", ImGuiSliderFlags_Logarithmic);
        ImGui::SliderFloat("Vitesse##sft", &s.swirl_speed, 0, 2, "%.2f rad/s");
        ImGui::TreePop();
    }
    if (erode_any > 0.0f && ImGui::TreeNodeEx("Filaments de pres (marbre)##sf", ImGuiTreeNodeFlags_DefaultOpen)) {
        ImGui::SliderFloat("Force##sff", &s.fil_strength, 0, 1.5f, "%.2f");
        ImGui::SetItemTooltip("Seulement dans les bancs et les amas, pres de la camera.");
        if (s.fil_strength > 0.0f) {
            ImGui::SliderFloat("Taille##sff", &s.fil_size, 0.1f, 6, "%.2f m", ImGuiSliderFlags_Logarithmic);
            ImGui::SliderFloat("Portee (niveau)##sff", &s.fil_lod, -3, 3, "%.1f");
            ImGui::SetItemTooltip("Lus tant qu'un pixel couvre moins de 2^x texels de leur texture (1 : un texel = taille / 64,\n"
                                  "soit ~6 cm pour 2 m ; plus haut : lus plus loin, plus cher).");
            ImGui::SliderFloat("Evolution##sff", &s.fil_period, 1, 240, "%.0f s", ImGuiSliderFlags_Logarithmic);
        }
        ImGui::TreePop();
    }
}
