#include "gobos.h"
#include "fixtures.h"
#include "mathx.h"

namespace {

float value_noise(float x, float y, uint32_t seed) {
    int ix = (int)std::floor(x), iy = (int)std::floor(y);
    float fx = x - ix, fy = y - iy;
    auto h = [&](int a, int b) { return hash01((uint32_t)(a * 73856093) ^ (uint32_t)(b * 19349663) ^ seed); };
    float sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    float a = lerpf(h(ix, iy), h(ix + 1, iy), sx);
    float b = lerpf(h(ix, iy + 1), h(ix + 1, iy + 1), sx);
    return lerpf(a, b, sy);
}

float fbm(float x, float y, uint32_t seed) {
    float s = 0, a = 0.5f;
    for (int o = 0; o < 4; o++) { s += a * value_noise(x, y, seed + o * 101); x *= 2.03f; y *= 2.03f; a *= 0.5f; }
    return s;
}

float disc(float x, float y, float cx, float cy, float r) {
    float dx = x - cx, dy = y - cy;
    return dx * dx + dy * dy < r * r ? 1.0f : 0.0f;
}

// Motif du gobo n au point (x, y) du disque unite. Renvoie 0 (opaque) ou 1 (transparent).
float pattern(int n, float x, float y) {
    float r = std::sqrt(x * x + y * y);
    float a = std::atan2(y, x);
    if (r > 1.0f) return 0;
    switch (n) {
        case 0: return 1;
        case 1: {  // grille de points
            float s = 0.36f;
            float gx = x / s, gy = y / s;
            float cx = std::round(gx), cy = std::round(gy);
            return disc(gx, gy, cx, cy, 0.32f) * (r < 0.95f ? 1.0f : 0.0f);
        }
        case 2: {  // etoile a 5 branches
            float k = std::cos(5 * a);
            float lim = 0.42f + 0.48f * std::pow(0.5f + 0.5f * k, 3.0f);
            return r < lim ? 1.0f : 0.0f;
        }
        case 3: return (std::fmod(r * 5.0f, 1.0f) < 0.5f) ? 1.0f : 0.0f;  // anneaux
        case 4: return (std::fmod((a / (2 * PI) + 1.0f) * 12.0f, 1.0f) < 0.45f && r > 0.12f) ? 1.0f : 0.0f;  // rayons
        case 5: return r < 0.92f * std::fabs(std::cos(3 * a)) + 0.08f ? 1.0f : 0.0f;  // fleur
        case 6: return fbm(x * 3.0f + 10, y * 3.0f + 10, 7) > 0.5f ? 1.0f : 0.0f;  // breakup
        case 7: {  // trois triangles
            float best = 0;
            for (int k = 0; k < 3; k++) {
                float ang = k * 2 * PI / 3 + PI / 2;
                float cx = 0.5f * std::cos(ang), cy = 0.5f * std::sin(ang);
                float lx = x - cx, ly = y - cy;
                // triangle equilateral pointe vers l'exterieur
                float ca = std::cos(-ang), sa = std::sin(-ang);
                float u = lx * ca - ly * sa, v = lx * sa + ly * ca;
                bool in = u > -0.22f && std::fabs(v) < (0.25f - u) * 0.75f && u < 0.25f;
                if (in) best = 1;
            }
            return best;
        }
        case 8: return (std::fmod(x * 3.5f + 10.0f, 1.0f) < 0.5f) ? 1.0f : 0.0f;  // barres
        case 9: {  // cercle de points
            float v = disc(x, y, 0, 0, 0.18f);
            for (int k = 0; k < 8; k++) {
                float ang = k * 2 * PI / 8;
                v = std::fmax(v, disc(x, y, 0.66f * std::cos(ang), 0.66f * std::sin(ang), 0.17f));
            }
            return v;
        }
        case 10: {  // spirale a 3 bras
            float s = std::fmod(a / (2 * PI) * 3.0f + r * 2.5f + 10.0f, 1.0f);
            return (s < 0.45f && r > 0.06f) ? 1.0f : 0.0f;
        }
        case 11: {  // feuillage (cellules)
            float best = 10, second = 10;
            float gx = x * 4.0f, gy = y * 4.0f;
            int ix = (int)std::floor(gx), iy = (int)std::floor(gy);
            for (int j = -1; j <= 1; j++)
                for (int i = -1; i <= 1; i++) {
                    uint32_t h = (uint32_t)((ix + i) * 73856093) ^ (uint32_t)((iy + j) * 19349663);
                    float px = ix + i + hash01(h), py = iy + j + hash01(h * 7 + 3);
                    float d = std::sqrt((gx - px) * (gx - px) + (gy - py) * (gy - py));
                    if (d < best) { second = best; best = d; } else if (d < second) second = d;
                }
            return (second - best) > 0.12f ? 1.0f : 0.0f;
        }
        case 12: {  // galaxie : petits points aleatoires
            float gx = x * 9.0f, gy = y * 9.0f;
            int ix = (int)std::floor(gx), iy = (int)std::floor(gy);
            uint32_t h = (uint32_t)(ix * 73856093) ^ (uint32_t)(iy * 19349663) ^ 0x51ed;
            if (hash01(h) > 0.55f) return 0;
            float px = ix + 0.2f + 0.6f * hash01(h + 1), py = iy + 0.2f + 0.6f * hash01(h + 2);
            return disc(gx, gy, px, py, 0.12f + 0.12f * hash01(h + 3));
        }
        case 13: return (std::fabs(x) < 0.16f || std::fabs(y) < 0.16f) ? 1.0f : 0.0f;  // croix
    }
    return 1;
}

}  // namespace

void GoboAtlas::generate() {
    num_layers = NUM_GOBOS;
    num_mips = 0;
    for (int s = SIZE; s >= 1; s >>= 1) num_mips++;
    mips.assign(num_mips, {});
    transmission.assign(num_layers, 0.0f);

    const int SS = 3;  // sur-echantillonnage pour des bords propres
    std::vector<uint8_t>& m0 = mips[0];
    m0.resize((size_t)SIZE * SIZE * num_layers);
    for (int l = 0; l < num_layers; l++) {
        double sum = 0;
        int count = 0;
        for (int y = 0; y < SIZE; y++)
            for (int x = 0; x < SIZE; x++) {
                float acc = 0;
                for (int sy = 0; sy < SS; sy++)
                    for (int sx = 0; sx < SS; sx++) {
                        float u = ((x + (sx + 0.5f) / SS) / SIZE) * 2.0f - 1.0f;
                        float v = ((y + (sy + 0.5f) / SS) / SIZE) * 2.0f - 1.0f;
                        acc += pattern(l, u, v);
                    }
                acc /= (float)(SS * SS);
                m0[(size_t)l * SIZE * SIZE + (size_t)y * SIZE + x] = (uint8_t)(acc * 255.0f + 0.5f);
                float u = ((x + 0.5f) / SIZE) * 2 - 1, v = ((y + 0.5f) / SIZE) * 2 - 1;
                if (u * u + v * v < 1) { sum += acc; count++; }
            }
        transmission[l] = count ? (float)(sum / count) : 1.0f;
    }
    // mipmaps (filtre boite)
    for (int m = 1; m < num_mips; m++) {
        int ps = SIZE >> (m - 1), s = SIZE >> m;
        const std::vector<uint8_t>& src = mips[m - 1];
        std::vector<uint8_t>& dst = mips[m];
        dst.resize((size_t)s * s * num_layers);
        for (int l = 0; l < num_layers; l++)
            for (int y = 0; y < s; y++)
                for (int x = 0; x < s; x++) {
                    const uint8_t* p = &src[(size_t)l * ps * ps];
                    int sum = p[(2 * y) * ps + 2 * x] + p[(2 * y) * ps + 2 * x + 1] + p[(2 * y + 1) * ps + 2 * x] + p[(2 * y + 1) * ps + 2 * x + 1];
                    dst[(size_t)l * s * s + (size_t)y * s + x] = (uint8_t)((sum + 2) / 4);
                }
    }
}
