#include "floor_texture.h"
#define STB_IMAGE_IMPLEMENTATION
#define STBI_ONLY_JPEG
#define STBI_ONLY_PNG
#include "stb_image.h"
#include <algorithm>
#include <cstdio>

namespace {

float srgb_to_linear(float c) { return c <= 0.04045f ? c / 12.92f : std::pow((c + 0.055f) / 1.055f, 2.4f); }
uint8_t to_u8(float v) { return (uint8_t)clampf(v * 255.0f + 0.5f, 0.0f, 255.0f); }

struct Image {
    int w = 0, h = 0;
    std::vector<uint8_t> px;   // 'ch' canaux par pixel
};

bool load_image(const std::string& path, int ch, Image& out) {
    int n = 0;
    uint8_t* d = stbi_load(path.c_str(), &out.w, &out.h, &n, ch);
    if (!d) return false;
    out.px.assign(d, d + (size_t)out.w * out.h * ch);
    stbi_image_free(d);
    return true;
}

bool exists(const std::string& path) {
    FILE* f = std::fopen(path.c_str(), "rb");
    if (!f) return false;
    std::fclose(f);
    return true;
}

// Reduction 2x2 d'une image flottante a 'ch' canaux.
std::vector<float> half(const std::vector<float>& src, int s, int ch) {
    const int d = s / 2;
    std::vector<float> dst((size_t)d * d * ch);
    for (int y = 0; y < d; y++)
        for (int x = 0; x < d; x++)
            for (int c = 0; c < ch; c++) {
                const size_t a = ((size_t)(2 * y) * s + 2 * x) * ch + c, b = a + (size_t)s * ch;
                dst[((size_t)y * d + x) * ch + c] = 0.25f * (src[a] + src[a + ch] + src[b] + src[b + ch]);
            }
    return dst;
}

}  // namespace

bool FloorTexture::load(const char* exe_path, float base_rough) {
    // dossier des textures : a cote de l'executable, sinon dossier courant
    std::vector<std::string> dirs;
    if (exe_path && *exe_path) {
        std::string p = exe_path;
        size_t k = p.find_last_of("/\\");
        if (k != std::string::npos) dirs.push_back(p.substr(0, k + 1) + "assets/Concrete031/");
    }
    dirs.push_back("assets/Concrete031/");
    std::string dir;
    for (const std::string& d : dirs)
        if (exists(d + "Color.jpg")) { dir = d; break; }
    if (dir.empty()) { error = "assets/Concrete031/Color.jpg introuvable"; return false; }

    Image col, nrm, rgh;
    if (!load_image(dir + "Color.jpg", 3, col) || !load_image(dir + "NormalDX.jpg", 3, nrm) || !load_image(dir + "Roughness.jpg", 1, rgh)) {
        error = std::string("lecture impossible dans ") + dir + " : " + stbi_failure_reason();
        return false;
    }
    const int s = col.w;
    if (col.h != s || nrm.w != s || nrm.h != s || rgh.w != s || rgh.h != s || s < 64 || (s & (s - 1))) {
        error = "les images doivent etre carrees, de meme taille, en puissance de 2";
        return false;
    }
    size = s;
    const size_t npx = (size_t)s * s;

    // image pleine en flottant : luminance lineaire ; normale ramenee a 1 (le fichier ne l'est pas) ; rugosite
    float lut[256];
    for (int i = 0; i < 256; i++) lut[i] = srgb_to_linear(i / 255.0f);
    std::vector<float> lum(npx), nr(npx * 4);
    double sum_col[3] = {}, sum_lum = 0, sum_rough = 0;
    for (size_t i = 0; i < npx; i++) {
        const float r = lut[col.px[i * 3]], g = lut[col.px[i * 3 + 1]], b = lut[col.px[i * 3 + 2]];
        lum[i] = 0.2126f * r + 0.7152f * g + 0.0722f * b;
        sum_col[0] += r; sum_col[1] += g; sum_col[2] += b;
        sum_lum += lum[i];
        sum_rough += rgh.px[i] / 255.0f;
    }
    mean_lum = (float)(sum_lum / npx);
    tint = vec3((float)(sum_col[0] / npx), (float)(sum_col[1] / npx), (float)(sum_col[2] / npx)) / std::max(mean_lum, 1e-4f);
    const float mean_rough = (float)(sum_rough / npx);
    for (size_t i = 0; i < npx; i++) {
        vec3 v = normalize(vec3(nrm.px[i * 3] / 127.5f - 1.0f, nrm.px[i * 3 + 1] / 127.5f - 1.0f, nrm.px[i * 3 + 2] / 127.5f - 1.0f));
        if (v.z <= 0.0f) v = {0, 0, 1};
        // rugosite du beton uni, plus les variations de la texture autour de sa moyenne ; stockee en alpha^2
        const float r = clampf(base_rough + (rgh.px[i] / 255.0f - mean_rough), 0.04f, 1.0f);
        nr[i * 4] = v.x; nr[i * 4 + 1] = v.y; nr[i * 4 + 2] = v.z; nr[i * 4 + 3] = r * r * r * r;
    }

    build_water(lum, nr, s);

    // mipmaps : moyennes en lumiere lineaire ; normales moyennees SANS les ramener a 1 : la longueur L
    // de la moyenne mesure leur dispersion, ajoutee a la rugosite (Toksvig : alpha^2 += 2 (1 - L) / L)
    mips.clear();
    for (int ls = s; ls >= 1; ls /= 2) {
        std::vector<uint8_t> m((size_t)ls * ls * 4);
        for (size_t i = 0; i < (size_t)ls * ls; i++) {
            const float* n = &nr[i * 4];
            const float L = std::max(std::sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]), 1e-3f);
            const float a2 = std::min(n[3] + 2.0f * (1.0f - L) / L, 1.0f);
            m[i * 4] = to_u8(std::sqrt(lum[i]));
            m[i * 4 + 1] = to_u8(n[0] * 0.5f + 0.5f);
            m[i * 4 + 2] = to_u8(n[1] * 0.5f + 0.5f);
            m[i * 4 + 3] = to_u8(std::sqrt(std::sqrt(a2)));
        }
        mips.push_back(std::move(m));
        if (ls == 32) coarse_lum = lum;
        if (ls > 1) {
            lum = half(lum, ls, 1);
            nr = half(nr, ls, 4);
        }
    }
    num_mips = (int)mips.size();
    ok = true;
    std::printf("Sol : %s (%d px, %d niveaux), luminance moyenne %.3f, rugosite %.2f -> %.2f\n", dir.c_str(), s, num_mips,
                mean_lum, mean_rough, base_rough);
    return true;
}

namespace {

// Flou en boite separable (rayon r, texture qui se repete), applique 'passes' fois (~ gaussienne).
std::vector<float> box_blur(std::vector<float> v, int s, int r, int passes) {
    std::vector<float> tmp(v.size());
    const float inv = 1.0f / (2 * r + 1);
    for (int p = 0; p < passes; p++) {
        for (int y = 0; y < s; y++) {
            float acc = 0;
            for (int k = -r; k <= r; k++) acc += v[(size_t)y * s + ((k + s) & (s - 1))];
            for (int x = 0; x < s; x++) {
                tmp[(size_t)y * s + x] = acc * inv;
                acc += v[(size_t)y * s + ((x + r + 1) & (s - 1))] - v[(size_t)y * s + ((x - r + s) & (s - 1))];
            }
        }
        for (int x = 0; x < s; x++) {
            float acc = 0;
            for (int k = -r; k <= r; k++) acc += tmp[(size_t)((k + s) & (s - 1)) * s + x];
            for (int y = 0; y < s; y++) {
                v[(size_t)y * s + x] = acc * inv;
                acc += tmp[(size_t)((y + r + 1) & (s - 1)) * s + x] - tmp[(size_t)((y - r + s) & (s - 1)) * s + x];
            }
        }
    }
    return v;
}

float quantile_of(std::vector<float> v, float q) {
    const size_t k = std::min(v.size() - 1, (size_t)(q * (v.size() - 1)));
    std::nth_element(v.begin(), v.begin() + k, v.end());
    return v[k];
}

// Valeur du tableau de quantiles q[0..256] pour la fraction f (0..1).
float table_at(const float* q, float f) {
    const float x = clampf(f, 0.0f, 1.0f) * 256.0f;
    const int i = std::min((int)x, 255);
    return lerpf(q[i], q[i + 1], x - i);
}

}  // namespace

float floor_noise(float x, float y) {
    const float ix = std::floor(x), iy = std::floor(y);
    float fx = x - ix, fy = y - iy;
    fx = fx * fx * (3.0f - 2.0f * fx);
    fy = fy * fy * (3.0f - 2.0f * fy);
    const int cx = (int)ix, cy = (int)iy;
    auto v = [](int a, int b) { return (float)(floor_hash(a, b) & 65535u); };
    return lerpf(lerpf(v(cx, cy), v(cx + 1, cy), fx), lerpf(v(cx, cy + 1), v(cx + 1, cy + 1), fx), fy) * (1.0f / 65535.0f);
}

// Creux du beton : la texture n'a pas de carte de hauteur. Les trous, pores et joints sont plus sombres
// que leur voisinage (passe-haut de la luminance : pas les grandes taches, qui ne sont que des salissures)
// et les normales y convergent (divergence). Les deux, remis a l'echelle par leurs centiles, donnent la
// profondeur des creux (d'apres Lagarde, « Water drop 2b », sans carte de hauteur).
void FloorTexture::build_water(const std::vector<float>& lum, const std::vector<float>& nr, int s) {
    const size_t npx = (size_t)s * s;
    const std::vector<float> lb = box_blur(lum, s, 8, 3);
    std::vector<float> hp(npx), dv(npx);
    for (int y = 0; y < s; y++)
        for (int x = 0; x < s; x++) {
            const size_t i = (size_t)y * s + x;
            hp[i] = lum[i] / std::max(lb[i], 1e-4f);
            // normale DirectX : y vers le bas de l'image
            const float nxr = nr[((size_t)y * s + ((x + 1) & (s - 1))) * 4], nxl = nr[((size_t)y * s + ((x - 1 + s) & (s - 1))) * 4];
            const float nyd = -nr[((size_t)((y + 1) & (s - 1)) * s + x) * 4 + 1], nyu = -nr[((size_t)((y - 1 + s) & (s - 1)) * s + x) * 4 + 1];
            dv[i] = (nxr - nxl) + (nyd - nyu);
        }
    dv = box_blur(dv, s, 1, 1);
    const float h50 = quantile_of(hp, 0.5f), h1 = quantile_of(hp, 0.01f);
    const float d50 = quantile_of(dv, 0.5f), d99 = quantile_of(dv, 0.99f);
    std::vector<float> hgt(npx);
    for (size_t i = 0; i < npx; i++) {
        const float dl = clampf((h50 - hp[i]) / std::max(h50 - h1, 1e-4f), 0.0f, 1.0f);
        const float dn = clampf((dv[i] - d50) / std::max(d99 - d50, 1e-4f), 0.0f, 1.0f);
        hgt[i] = 1.0f - clampf(0.6f * dl + 0.6f * dn, 0.0f, 1.0f);
    }
    hgt = box_blur(hgt, s, 1, 1);
    // quantiles de hP (texture pleine)
    {
        std::vector<float> v = hgt;
        std::sort(v.begin(), v.end());
        for (int k = 0; k <= 256; k++) hp_q[k] = v[std::min(npx - 1, (size_t)k * (npx - 1) / 256)];
    }
    // quantiles de hF = cuvettes + 0,15 (hP - 0,5), sur un grand morceau de sol
    {
        const int n = 1 << 16;
        std::vector<float> v(n);
        uint32_t r = 12345u;
        auto rnd = [&r]() { r = r * 1664525u + 1013904223u; return (r >> 8) * (1.0f / 16777216.0f); };
        for (int k = 0; k < n; k++) {
            const float x = rnd() * 400.0f - 200.0f, z = rnd() * 400.0f - 200.0f;
            const float hpv = hgt[(size_t)(rnd() * (float)(npx - 1))];
            v[k] = puddle_height(x, z) + 0.15f * (hpv - 0.5f);
        }
        std::sort(v.begin(), v.end());
        for (int k = 0; k <= 256; k++) hf_q[k] = v[std::min((size_t)n - 1, (size_t)k * (n - 1) / 256)];
    }
    // mipmaps (moyennes)
    cav_mips.clear();
    for (int ls = s; ls >= 1; ls /= 2) {
        std::vector<uint8_t> m((size_t)ls * ls);
        for (size_t i = 0; i < (size_t)ls * ls; i++) m[i] = to_u8(hgt[i]);
        cav_mips.push_back(std::move(m));
        if (ls > 1) hgt = half(hgt, ls, 1);
    }
}

void FloorTexture::water_levels(float w, float out[4]) const {
    w = clampf(w, 0.0f, 1.0f);
    // 1. creux : les plus profonds se remplissent d'abord (10 % de la texture a w = 0,35)
    const float fp = 0.10f * smoothstepf(0.0f, 0.35f, w);
    out[1] = fp > 0.0f ? table_at(hp_q, fp) + 0.03f : -1.0f;
    // 2. flaques : part du sol couverte 2 % a w = 0,1, 30 % a 0,5, 60 % a 0,75, tout a 1
    const float cov = w <= 0.05f ? 0.0f : 0.02f + 0.98f * std::pow((w - 0.05f) / 0.95f, 1.7f);
    out[0] = w >= 0.999f ? hf_q[256] + 0.1f : (cov > 0.0f ? table_at(hf_q, cov) : hf_q[0] - 0.1f);
    // 3. film d'eau sur le reste du sol : sec jusqu'a 0,45
    out[2] = smoothstepf(0.45f, 0.95f, w);
    out[3] = w >= 0.999f ? 1.0f : cov;   // part du sol en flaques (lumiere indirecte, CPU)
}

vec3 FloorTexture::albedo_at(float x, float z, float tile) const {
    if (!ok || coarse_lum.empty()) return tint * mean_lum;
    // dalle du sol et transformation (meme calcul que floor_material() dans le shader)
    const float wx = x * 4.0f / tile, wz = z * 4.0f / tile;
    const float cx = std::floor(wx), cz = std::floor(wz);
    const float qx = wx - cx - 0.5f, qy = wz - cz - 0.5f;
    const uint32_t h = floor_hash((int)cx, (int)cz);
    const uint32_t rot = h & 3u, idx = (h >> 2) & 15u;
    const float sg = (rot & 2u) ? -1.0f : 1.0f;
    float tx, ty;
    if (rot & 1u) { tx = -sg * qy; ty = sg * qx; }
    else { tx = sg * qx; ty = sg * qy; }
    if (h & 64u) tx = -tx;
    const float u = ((float)(idx & 3u) + tx + 0.5f) * 0.25f, v = ((float)(idx >> 2) + ty + 0.5f) * 0.25f;
    // lecture bilineaire du niveau 32 x 32
    const int cs = 32;
    const float fx = u * cs - 0.5f, fy = v * cs - 0.5f;
    const int x0 = (int)std::floor(fx), y0 = (int)std::floor(fy);
    const float ax = fx - x0, ay = fy - y0;
    auto at = [&](int xx, int yy) { return coarse_lum[(size_t)((yy & (cs - 1)) * cs + (xx & (cs - 1)))]; };
    const float l = lerpf(lerpf(at(x0, y0), at(x0 + 1, y0), ax), lerpf(at(x0, y0 + 1), at(x0 + 1, y0 + 1), ax), ay);
    return tint * l;
}
