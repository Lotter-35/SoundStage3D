#include "volutes.h"
#include "mathx.h"
#include <algorithm>
#include <chrono>
#include <thread>

namespace {

// Bruit de gradient 3D periodique (periode 'per' cellules sur [0, 1)), valeurs ~[-0,7 ; 0,7].
struct GradNoise {
    int per;
    std::vector<vec3> g;
    GradNoise(int p, uint32_t seed) : per(p), g((size_t)p * p * p) {
        for (size_t i = 0; i < g.size(); i++) {
            // direction au hasard (rejet hors de la boule unite)
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

// Somme d'octaves (periodes per, 2 per, 4 per ...), normalisee.
struct Fbm {
    std::vector<GradNoise> oct;
    float gain, norm;
    Fbm(int per, uint32_t seed, int octaves, float g) : gain(g) {
        float a = 1, tot = 0;
        for (int o = 0; o < octaves; o++) {
            oct.emplace_back(per << o, seed + 101u * (uint32_t)o);
            tot += a;
            a *= g;
        }
        norm = 1.0f / tot;
    }
    float operator()(vec3 p) const {
        float v = 0, a = 1;
        for (const GradNoise& n : oct) {
            v += a * n(p);
            a *= gain;
        }
        return v * norm;
    }
};

struct VFbm {
    Fbm x, y, z;
    VFbm(int per, uint32_t seed, int octaves) : x(per, seed, octaves, 0.5f), y(per, seed + 1000, octaves, 0.5f), z(per, seed + 2000, octaves, 0.5f) {}
    vec3 operator()(vec3 p) const { return {x(p), y(p), z(p)}; }
};

vec3 wrap(vec3 p) { return {p.x - std::floor(p.x), p.y - std::floor(p.y), p.z - std::floor(p.z)}; }

// Un bloc BC4 (4 x 4 valeurs 0..1, rangees par lignes) : extremes du bloc, puis pour chaque valeur l'indice de la plus
// proche des 8 valeurs interpolees (mode r0 > r1 : r0, r1, puis 6 valeurs entre les deux).
void bc4_block(const float* v, uint8_t* out) {
    float lo = 1, hi = 0;
    for (int i = 0; i < 16; i++) {
        lo = std::min(lo, v[i]);
        hi = std::max(hi, v[i]);
    }
    int r0 = (int)std::lround(saturate(hi) * 255.0f), r1 = (int)std::lround(saturate(lo) * 255.0f);
    uint64_t bits = 0;
    if (r0 > r1) {
        float pal[8];
        pal[0] = (float)r0;
        pal[1] = (float)r1;
        for (int k = 1; k <= 6; k++) pal[k + 1] = ((7 - k) * r0 + k * r1) / 7.0f;
        for (int i = 0; i < 16; i++) {
            const float x = v[i] * 255.0f;
            int best = 0;
            float bd = 1e9f;
            for (int k = 0; k < 8; k++) {
                const float d = std::fabs(pal[k] - x);
                if (d < bd) { bd = d; best = k; }
            }
            bits |= (uint64_t)best << (3 * i);
        }
    } else {
        r1 = r0;   // bloc uniforme : indice 0 partout
    }
    out[0] = (uint8_t)r0;
    out[1] = (uint8_t)r1;
    for (int b = 0; b < 6; b++) out[2 + b] = (uint8_t)(bits >> (8 * b));
}

// Un niveau (n^3 valeurs par canal, 2 canaux entrelaces) en blocs BC5 : par tranche, blocs de 4 x 4 (bords
// recopies quand n < 4).
std::vector<uint8_t> bc5_level(const std::vector<float>& f, int n) {
    const int nb = (n + 3) / 4;
    std::vector<uint8_t> out((size_t)n * nb * nb * 16);
    for (int z = 0; z < n; z++)
        for (int by = 0; by < nb; by++)
            for (int bx = 0; bx < nb; bx++) {
                uint8_t* o = &out[(((size_t)z * nb + by) * nb + bx) * 16];
                for (int c = 0; c < 2; c++) {
                    float v[16];
                    for (int i = 0; i < 16; i++) {
                        const int x = std::min(bx * 4 + (i & 3), n - 1), y = std::min(by * 4 + (i >> 2), n - 1);
                        v[i] = f[(((size_t)z * n + y) * n + x) * 2 + c];
                    }
                    bc4_block(v, o + 8 * c);
                }
            }
    return out;
}

}  // namespace

// Champ (prototype compare a la photo 5 de docs/references-lasers) : bruit a 5 octaves dans un domaine deforme
// deux fois (deformations de Quilez). La 1re deformation, large, tourne au fil de la boucle d'evolution
// (cos, sin de la phase) : c'est elle qui fait evoluer les volutes ; la 2e, plus fine, les enroule. Puis un
// contraste par seuil doux : des plaques claires a bords vifs, des trous sombres, des filaments etires.
// Champ (prototype compare a la photo 5 de docs/references-lasers) : bruit a 5 octaves dans un domaine deforme
// deux fois (deformations de Quilez). La 1re deformation, large, tourne au fil de la boucle d'evolution
// (cos, sin de la phase) : c'est elle qui fait evoluer les volutes ; la 2e, plus fine, les enroule. Puis un
// contraste par seuil doux : des plaques claires a bords vifs, des trous sombres, des filaments etires.
// Canal r : phase 0 ; canal g : phase 1/2 (deformation opposee).
void Volutes::build() {
    const auto t0 = std::chrono::steady_clock::now();
    const int N = VOLUTES_N;
    const VFbm w1(2, 11, 4), w2(3, 37, 4);
    const Fbm base(3, 51, 4, 0.55f);
    const float A1 = 0.35f, A2 = 0.15f;
    const size_t count = (size_t)N * N * N;
    std::vector<float> field(count * 2);
    const int nthreads = (int)std::max(1u, std::min(16u, std::thread::hardware_concurrency()));
    std::vector<std::thread> th;
    for (int t = 0; t < nthreads; t++) {
        th.emplace_back([&, t]() {
            for (int z = t; z < N; z += nthreads)
                for (int y = 0; y < N; y++)
                    for (int x = 0; x < N; x++) {
                        const vec3 p = {(x + 0.5f) / N, (y + 0.5f) / N, (z + 0.5f) / N};
                        const vec3 a = w1(p);
                        for (int c = 0; c < 2; c++) {
                            vec3 q = wrap(p + a * (c == 0 ? A1 : -A1));
                            q = wrap(q + w2(q) * A2);
                            field[(((size_t)z * N + y) * N + x) * 2 + c] = base(q);
                        }
                    }
        });
    }
    for (std::thread& t : th) t.join();
    // contraste par canal : ecart a la moyenne, seuil doux, puis moyenne 0,5 et ecart type VOLUTES_SD
    for (int c = 0; c < 2; c++) {
        double s = 0, s2 = 0;
        for (size_t i = 0; i < count; i++) {
            const double v = field[i * 2 + c];
            s += v;
            s2 += v * v;
        }
        const float m = (float)(s / count), sd = (float)std::sqrt(std::max(s2 / count - (s / count) * (s / count), 1e-12));
        double t1 = 0, t2 = 0;
        for (size_t i = 0; i < count; i++) {
            const float zs = (field[i * 2 + c] - m) / sd;
            const float v = smoothstepf(-0.5f, 1.5f, zs) + 0.3f * zs;
            field[i * 2 + c] = v;
            t1 += v;
            t2 += (double)v * v;
        }
        const float m2 = (float)(t1 / count), sd2 = (float)std::sqrt(std::max(t2 / count - (t1 / count) * (t1 / count), 1e-12));
        for (size_t i = 0; i < count; i++) field[i * 2 + c] = saturate(0.5f + (field[i * 2 + c] - m2) / sd2 * VOLUTES_SD);
    }
    // mipmaps : moyenne de 2 x 2 x 2 (texture periodique : pas de bord), chaque niveau compresse en BC5
    auto sd_of = [](const std::vector<float>& f) {
        double s = 0, s2 = 0;
        for (size_t i = 0; i < f.size(); i += 2) { s += f[i]; s2 += (double)f[i] * f[i]; }
        const double n = (double)(f.size() / 2);
        return (float)std::sqrt(std::max(s2 / n - (s / n) * (s / n), 0.0));
    };
    mips.clear();
    level_sd.clear();
    level_sd.push_back(sd_of(field));
    mips.push_back(bc5_level(field, N));
    for (int n = N; n > 1; n /= 2) {
        const int h = n / 2;
        std::vector<float> dst((size_t)h * h * h * 2);
        for (int z = 0; z < h; z++)
            for (int y = 0; y < h; y++)
                for (int x = 0; x < h; x++)
                    for (int c = 0; c < 2; c++) {
                        float s = 0;
                        for (int k = 0; k < 8; k++)
                            s += field[((((size_t)(2 * z + (k >> 2)) * n + 2 * y + ((k >> 1) & 1)) * n) + 2 * x + (k & 1)) * 2 + c];
                        dst[(((size_t)z * h + y) * h + x) * 2 + c] = s * 0.125f;
                    }
        field.swap(dst);
        level_sd.push_back(sd_of(field));
        mips.push_back(bc5_level(field, h));
    }
    build_ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
}
