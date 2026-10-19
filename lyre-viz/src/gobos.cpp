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

float fractf(float v) { return v - std::floor(v); }

// distance du point au segment AB
float seg_dist(float px, float py, float ax, float ay, float bx, float by) {
    float dx = bx - ax, dy = by - ay;
    float t = clampf(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy), 0.0f, 1.0f);
    float ex = px - ax - dx * t, ey = py - ay - dy * t;
    return std::sqrt(ex * ex + ey * ey);
}

// etoile a 5 branches pleine, pointe en haut
float star5(float x, float y, float cx, float cy, float R) {
    float dx = x - cx, dy = y - cy, r = std::sqrt(dx * dx + dy * dy), a = std::atan2(dy, dx) - PI / 2;
    float lim = R * (0.45f + 0.55f * std::pow(0.5f + 0.5f * std::cos(5 * a), 2.5f));
    return r < lim ? 1.0f : 0.0f;
}

// ogive (arc brise) de largeur w centree en cx, naissance de l'arc en ys, bas en ybot (y vers le haut)
float ogive(float x, float y, float cx, float w, float ys, float ybot) {
    if (std::fabs(x - cx) > w / 2 || y < ybot) return 0;
    if (y <= ys) return 1;
    float d1 = std::hypot(x - (cx + w / 2), y - ys), d2 = std::hypot(x - (cx - w / 2), y - ys);
    return (d1 <= w && d2 <= w) ? 1.0f : 0.0f;
}

// bulles : cercles de tailles variees qui ne se touchent pas (tires une fois)
struct Bubble { float x, y, r; };
const std::vector<Bubble>& bubbles() {
    static std::vector<Bubble> b;
    if (!b.empty()) return b;
    uint32_t s = 1;
    for (int i = 0; i < 6000 && b.size() < 26; i++) {
        float cx = hash01(s++) * 2 - 1, cy = hash01(s++) * 2 - 1, rr = 0.05f + 0.17f * std::pow(hash01(s++), 1.6f);
        if (std::hypot(cx, cy) + rr > 0.95f) continue;
        bool hit = false;
        for (const Bubble& o : b) hit |= std::hypot(o.x - cx, o.y - cy) < o.r + rr + 0.03f;
        if (!hit) b.push_back({cx, cy, rr});
    }
    return b;
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
    // gobos 14 a 33 : y vers le haut (comme l'image de la texture)
    const float Y = -y;
    const float aY = std::atan2(Y, x);
    switch (n) {
        case 14: return (r > 0.7f && r < 0.9f) ? 1.0f : 0.0f;  // anneau (faisceau en tube)
        case 15: {  // helice : 3 pales courbes
            if (r < 0.14f) return 0;
            return fractf(aY * 3 / (2 * PI) + r * 0.28f) < 0.3f ? 1.0f : 0.0f;
        }
        case 16: {  // soleil d'aiguilles : 16 pointes fines, une sur deux plus courte
            if (r < 0.15f) return 1;
            const int idx = (int)std::lround(aY * 16 / (2 * PI));
            const float len = (idx & 1) ? 0.62f : 0.95f;
            const float d = std::fabs(aY - idx * 2 * PI / 16) * r;
            return (r < len && d < 0.055f * (1 - r / len) + 0.006f) ? 1.0f : 0.0f;
        }
        case 17: {  // bulles
            for (const Bubble& b : bubbles()) {
                float d = std::hypot(x - b.x, Y - b.y);
                if (std::fabs(d - b.r * 0.85f) < 0.022f + b.r * 0.08f) return 1;
            }
            return 0;
        }
        case 18: {  // triangle (contour) : tube triangulaire, pointe en haut
            float m = -1e9f;
            for (int k = 0; k < 3; k++) {
                float ang = 3 * PI / 2 + k * 2 * PI / 3;
                m = std::fmax(m, x * std::cos(ang) + Y * std::sin(ang));
            }
            float sd = m - 0.41f;
            return (sd < 0 && sd > -0.11f) ? 1.0f : 0.0f;
        }
        case 19: {  // rosace : mandala a 2 couronnes de petales
            if (r < 0.1f) return 1;
            if (r > 0.15f && r < 0.48f) {
                float t = (r - 0.15f) / 0.33f, u = std::fabs(fractf(aY * 8 / (2 * PI)) - 0.5f) * 2;
                return u < 0.85f * std::pow(std::sin(PI * t), 0.7f) ? 1.0f : 0.0f;
            }
            if (r > 0.52f && r < 0.56f) return 1;
            if (r > 0.6f && r < 0.93f) {
                float t = (r - 0.6f) / 0.33f, u = std::fabs(fractf(aY * 16 / (2 * PI) + 0.5f) - 0.5f) * 2, w = std::sin(PI * t);
                if (u < 0.9f * w && !(u < 0.4f * w && t > 0.25f && t < 0.75f)) return 1;
            }
            return 0;
        }
        case 20: {  // eau : reflets (caustiques), bords doux comme un gobo de verre
            float wx = x * 3.2f + fbm(x * 1.5f + 3, Y * 1.5f, 11) * 1.8f, wy = Y * 3.2f + fbm(x * 1.5f, Y * 1.5f + 5, 12) * 1.8f;
            float ridge = 1 - std::fabs(2 * fbm(wx, wy, 13) - 1);
            return smoothstepf(0.9f, 0.97f, ridge);
        }
        case 21: {  // flammes : langues de feu qui montent
            float nn = fbm(x * 3.2f, Y * 0.8f, 21);
            float tongue = std::pow(0.5f + 0.5f * std::cos(x * 8.5f + nn * 5), 1.6f);
            float h = -0.55f + 0.95f * tongue * (1 - 0.35f * std::fabs(x)) + 0.45f * (nn - 0.5f);
            return Y < h ? 1.0f : 0.0f;
        }
        case 22: {  // verre brise : fissures depuis un impact, et 3 cercles de fissures
            for (int i = 0; i < 13; i++) {
                float c = i * 2 * PI / 13 + (hash01(900 + i) - 0.5f) * 0.35f;
                float j = aY - c - 0.025f * std::sin(r * 9 + c * 7) * (0.3f + r);
                float da = std::fabs(std::fmod(std::fmod(j + PI, 2 * PI) + 2 * PI, 2 * PI) - PI) * r;
                if (da < 0.012f + 0.004f * r && r > 0.04f) return 0;
            }
            for (float rr : {0.22f, 0.47f, 0.74f}) {
                float rj = rr + 0.02f * std::sin(aY * 7 + rr * 40) + 0.01f * std::sin(aY * 17);
                if (std::fabs(r - rj) < 0.011f) return 0;
            }
            return 1;
        }
        case 23: return smoothstepf(0.44f, 0.62f, fbm(x * 1.7f + 20, Y * 1.7f + 20, 33));  // nuages (verre, bords doux)
        case 24: {  // nid d'abeille : hexagones
            const float s = 0.22f, q = x / s, p = Y / s, k3 = std::sqrt(3.0f);
            int cx = (int)std::lround(q - p / k3), cy = (int)std::lround(p * 2 / k3);
            float best = 1e9f, bx = 0, by = 0;
            for (int j = -1; j <= 1; j++)
                for (int i = -1; i <= 1; i++) {
                    float px = (cx + i) + (cy + j) * 0.5f, py = (cy + j) * k3 / 2;
                    float d = std::hypot(q - px, p - py);
                    if (d < best) { best = d; bx = px; by = py; }
                }
            float dx = std::fabs(q - bx), dy = std::fabs(p - by);
            return std::fmax(dx * k3 / 2 + dy * 0.5f, dy) < 0.40f ? 1.0f : 0.0f;
        }
        case 25: return (((int)std::floor(x / 0.3f + 10) + (int)std::floor(Y / 0.3f + 10)) & 1) ? 1.0f : 0.0f;  // damier
        case 26: return fractf(Y * 3.2f + 0.18f * std::sin(x * 7.5f) + 10) < 0.42f ? 1.0f : 0.0f;  // vagues
        case 27: {  // fenetre a croisillons (2 x 3 carreaux)
            if (std::fabs(x) > 0.52f || std::fabs(Y) > 0.72f) return 0;
            if (std::fabs(x) < 0.035f || std::fabs(std::fabs(Y) - 0.24f) < 0.035f) return 0;
            return 1;
        }
        case 28: {  // vitrail : deux ogives et une rosace
            float v = std::fmax(ogive(x, Y, -0.22f, 0.36f, 0.15f, -0.8f), ogive(x, Y, 0.22f, 0.36f, 0.15f, -0.8f));
            float ro = std::hypot(x, Y - 0.58f);
            if (ro < 0.2f) {
                float u = std::fabs(fractf(std::atan2(Y - 0.58f, x) * 6 / (2 * PI)) - 0.5f) * 2;
                if (ro < 0.06f || (ro > 0.09f && u > 0.18f)) v = 1;
            }
            return v;
        }
        case 29: {  // toile d'araignee : 12 rayons et une spirale de fils
            const float sec = 2 * PI / 12;
            float u = std::fmod(std::fmod(aY, sec) + sec, sec);
            if (std::fmin(u, sec - u) * r < 0.011f) return 1;
            float pr = r * std::cos(std::fabs(u - sec / 2)) / std::cos(sec / 2);
            float f = fractf((pr + 0.025f * std::sin(PI * u / sec)) * 7.5f + 0.15f * aY / (2 * PI));
            return (std::fmin(f, 1 - f) < 0.06f && r > 0.06f) ? 1.0f : 0.0f;
        }
        case 30: {  // flocon : 6 branches
            const float s = PI / 3;
            float aa = std::fmod(std::fmod(aY, s) + s, s);
            if (aa > s / 2) aa = s - aa;
            float px = r * std::cos(aa), py = r * std::sin(aa);
            float d = seg_dist(px, py, 0, 0, 0.88f, 0);
            const float bt[2] = {0.36f, 0.62f}, bl[2] = {0.26f, 0.18f};
            for (int k = 0; k < 2; k++) d = std::fmin(d, seg_dist(px, py, bt[k], 0, bt[k] + bl[k] * 0.5f, bl[k] * 0.866f));
            d = std::fmin(d, seg_dist(px, py, 0.12f, 0, 0.166f, 0.096f));
            return d < 0.035f ? 1.0f : 0.0f;
        }
        case 31: {  // coeur
            float X = x / 0.72f, Yh = (Y + 0.1f) / 0.72f, q = X * X + Yh * Yh - 1;
            return q * q * q - X * X * Yh * Yh * Yh < 0 ? 1.0f : 0.0f;
        }
        case 32: {  // lune et etoiles
            float v = (std::hypot(x + 0.12f, Y) < 0.55f && std::hypot(x - 0.1f, Y - 0.1f) > 0.47f) ? 1.0f : 0.0f;
            v = std::fmax(v, star5(x, Y, 0.42f, 0.42f, 0.16f));
            v = std::fmax(v, star5(x, Y, 0.55f, -0.1f, 0.1f));
            v = std::fmax(v, star5(x, Y, 0.25f, -0.55f, 0.12f));
            return std::fmax(v, star5(x, Y, -0.35f, 0.72f, 0.08f));
        }
        case 33: {  // soleil : disque et 12 rayons ondules
            if (r < 0.3f) return 1;
            if (r < 0.38f || r > 0.92f) return 0;
            float u = std::fabs(fractf((aY + 0.07f * std::sin(r * 16)) * 12 / (2 * PI)) - 0.5f) * 2;
            return u < 0.55f * (1 - (r - 0.38f) / 0.54f) + 0.04f ? 1.0f : 0.0f;
        }
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
