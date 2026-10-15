#include "ilda.h"
#include <algorithm>
#include <cmath>
#include <filesystem>
#include <fstream>

namespace fs = std::filesystem;

namespace {

// Palette ILDA par defaut (64 couleurs, norme ILDA ; la meme que src/laser2/ilda/IldaParser.js).
const uint8_t DEFAULT_PALETTE[64][3] = {
    {255, 0, 0}, {255, 16, 0}, {255, 32, 0}, {255, 48, 0}, {255, 64, 0}, {255, 80, 0}, {255, 96, 0}, {255, 112, 0},
    {255, 128, 0}, {255, 144, 0}, {255, 160, 0}, {255, 176, 0}, {255, 192, 0}, {255, 208, 0}, {255, 224, 0}, {255, 240, 0},
    {255, 255, 0}, {224, 255, 0}, {192, 255, 0}, {160, 255, 0}, {128, 255, 0}, {96, 255, 0}, {64, 255, 0}, {32, 255, 0},
    {0, 255, 0}, {0, 255, 36}, {0, 255, 73}, {0, 255, 109}, {0, 255, 146}, {0, 255, 182}, {0, 255, 219}, {0, 255, 255},
    {0, 227, 255}, {0, 198, 255}, {0, 170, 255}, {0, 142, 255}, {0, 113, 255}, {0, 85, 255}, {0, 56, 255}, {0, 28, 255},
    {0, 0, 255}, {32, 0, 255}, {64, 0, 255}, {96, 0, 255}, {128, 0, 255}, {160, 0, 255}, {192, 0, 255}, {224, 0, 255},
    {255, 0, 255}, {255, 32, 255}, {255, 64, 255}, {255, 96, 255}, {255, 128, 255}, {255, 160, 255}, {255, 192, 255}, {255, 224, 255},
    {255, 255, 255}, {255, 224, 224}, {255, 192, 192}, {255, 160, 160}, {255, 128, 128}, {255, 96, 96}, {255, 64, 64}, {255, 32, 32},
};
constexpr int MAX_POINTS = 60000;        // par image, a la lecture
constexpr float STEP = 0.035f;           // complement des traits : un point tous les 0,035 (comme le web)
constexpr int MAX_COMPLETED = 20000;     // ... sans depasser 20 000 points par image
// Les tolerances du web sont en angle, pour une image de +-30 deg : ramenees aux coordonnees du fichier.
constexpr float REF_HALF_FIELD = 0.5235988f;

uint16_t be16(const uint8_t* p) { return (uint16_t)((p[0] << 8) | p[1]); }
int16_t be16s(const uint8_t* p) { return (int16_t)be16(p); }

float srgb_to_linear(float c) { return c <= 0.04045f ? c / 12.92f : std::pow((c + 0.055f) / 1.055f, 2.4f); }

// Points ajoutes le long des traits allumes (la puissance etant repartie entre les points, un long trait de 2
// points paraitrait sinon bien plus sombre qu'un court) ; couleur du point d'arrivee (norme ILDA).
IldaFrame complete(const IldaFrame& f, float step) {
    const int n = f.size();
    if (n < 2) return f;
    IldaFrame out;
    auto lit = [&](int i) { return f.r[i] + f.g[i] + f.b[i] > 1e-4f; };
    for (int i = 0; i < n; i++) {
        const int p = (i - 1 + n) % n;
        if (lit(i) && lit(p)) {
            const float dx = f.x[i] - f.x[p], dy = f.y[i] - f.y[p];
            const int k = (int)std::ceil(std::sqrt(dx * dx + dy * dy) / step);
            for (int s = 1; s < k; s++) out.push(f.x[p] + dx * s / k, f.y[p] + dy * s / k, f.r[i], f.g[i], f.b[i]);
        }
        out.push(f.x[i], f.y[i], f.r[i], f.g[i], f.b[i]);
    }
    return out;
}

IldaFrame complete_frame(const IldaFrame& f) {
    float step = STEP;
    IldaFrame out = complete(f, step);
    for (int i = 0; i < 4 && out.size() > MAX_COMPLETED && out.size() > f.size(); i++) {
        step *= (float)out.size() / (float)MAX_COMPLETED;
        out = complete(f, step);
    }
    if (out.size() > MAX_COMPLETED && out.size() > f.size()) return f;
    return out;
}

// Reduction d'une image en faisceaux et nappes (reprise de Laser2Scanner._extractPass du web).
//   - un point a moins de 'dwell' du precedent (ou apres un point masque) : le faisceau reste sur place, son
//     energie s'ajoute au faisceau courant (position moyenne ponderee) ;
//   - sinon, le segment (point precedent -> point) ouvre ou prolonge une nappe, coupee quand le trace tourne
//     (ecart > tol), revient en arriere, change d'espacement entre points (+-12 %), de niveau (15 %) ou de teinte ;
//   - nappe plus courte que 'dwell' : un faisceau en son milieu ; faisceaux au meme endroit fusionnes.
// Faux si plus de 'limit' primitives (passe interrompue).
bool extract(const IldaFrame& f, float dwell, float tol, int limit, IldaPrims& out) {
    out.beams.clear();
    out.sheets.clear();
    const int n = f.size();
    if (n == 0) return true;
    const float inv = 1.0f / (float)n;
    // couleurs lineaires, l : canal le plus fort ; le point 0 est precede du dernier (image fermee)
    std::vector<float> R(n), G(n), B(n), L(n);
    for (int i = 0; i < n; i++) {
        R[i] = srgb_to_linear(f.r[i]);
        G[i] = srgb_to_linear(f.g[i]);
        B[i] = srgb_to_linear(f.b[i]);
        L[i] = std::max(R[i], std::max(G[i], B[i]));
    }
    bool over = false;
    int mode = 0;   // 0 rien, 1 faisceau, 2 nappe
    float bx = 0, by = 0, bw = 0, br = 0, bg = 0, bb = 0, bl = 0;
    int bn = 0;
    float sx0 = 0, sy0 = 0, sx1 = 0, sy1 = 0, sr = 0, sg = 0, sb = 0, sl = 0;
    float sL = 0, sd0 = 0, sdx = 0, sdy = 0, sProj = 0, sLevel = 0;
    int sCount = 0;
    bool prevLit = false;
    float qx = 0, qy = 0;
    auto count = [&]() { return (int)(out.beams.size() / 6 + out.sheets.size() / 8); };
    auto emit_beam = [&](float x, float y, float r, float g, float b, float l) {
        std::vector<float>& A = out.beams;
        const int nb = (int)(A.size() / 6);
        for (int i = std::max(0, nb - 48); i < nb; i++) {
            float* o = &A[(size_t)i * 6];
            if (std::fabs(o[0] - x) < dwell * 2 && std::fabs(o[1] - y) < dwell * 2) {
                const float w0 = o[2] + o[3] + o[4], w1 = r + g + b;
                const float wt = w0 + w1 > 0 ? w1 / (w0 + w1) : 0.5f;
                o[0] += (x - o[0]) * wt;
                o[1] += (y - o[1]) * wt;
                o[2] += r; o[3] += g; o[4] += b; o[5] += l;
                return;
            }
        }
        if (count() >= limit) { over = true; return; }
        A.insert(A.end(), {x, y, r, g, b, l});
    };
    auto close_beam = [&]() {
        if (bw > 0) emit_beam(bx / bw, by / bw, br * inv, bg * inv, bb * inv, bl * inv);
        bw = br = bg = bb = bl = bx = by = 0;
        bn = 0;
    };
    auto close_sheet = [&]() {
        if (sL < dwell) {
            if (sr + sg + sb > 0) emit_beam((sx0 + sx1) * 0.5f, (sy0 + sy1) * 0.5f, sr * inv, sg * inv, sb * inv, sl * inv);
        } else if (count() >= limit) {
            over = true;
        } else {
            out.sheets.insert(out.sheets.end(), {sx0, sy0, sx1, sy1, sr * inv, sg * inv, sb * inv, sl * inv});
        }
        sr = sg = sb = sl = sL = 0;
        sCount = 0;
    };
    auto start_sheet = [&](float x, float y) {
        sx0 = sx1 = x;
        sy0 = sy1 = y;
        sr = sg = sb = sl = sL = sd0 = sProj = 0;
        sCount = 0;
    };
    {
        const int o = n - 1;
        if (R[o] + G[o] + B[o] > 1e-6f) { prevLit = true; qx = f.x[o]; qy = f.y[o]; }
    }
    for (int o = 0; o < n; o++) {
        const float r = R[o], g = G[o], b = B[o], l = L[o];
        const float x = f.x[o], y = f.y[o];
        const float lvl = r + g + b;
        if (lvl <= 1e-6f) {
            if (mode == 1) close_beam(); else if (mode == 2) close_sheet();
            mode = 0;
            prevLit = false;
            qx = x;
            qy = y;
            continue;
        }
        const float ddx = x - qx, ddy = y - qy;
        const float d = prevLit ? std::sqrt(ddx * ddx + ddy * ddy) : 0.0f;
        if (!prevLit || d < dwell) {
            if (mode == 2) close_sheet();
            if (mode != 1) { mode = 1; bw = br = bg = bb = bl = bx = by = 0; bn = 0; }
            bx += x * lvl; by += y * lvl; bw += lvl;
            br += r; bg += g; bb += b; bl += l;
            bn++;
        } else {
            if (mode == 1) {
                // un seul point avant le trait (son depart) : il appartient au trait, ce n'est pas un faisceau
                const bool lone = bn == 1;
                const float cr = br, cg = bg, cb = bb, cl = bl;
                if (lone) { bw = br = bg = bb = bl = bx = by = 0; bn = 0; } else close_beam();
                start_sheet(qx, qy);
                if (lone) { sr = cr; sg = cg; sb = cb; sl = cl; }
                mode = 2;
            } else if (mode == 0) {
                start_sheet(qx, qy);
                mode = 2;
            } else {
                const float ex = x - sx0, ey = y - sy0;
                const float proj = ex * sdx + ey * sdy;
                const float perp = std::fabs(ex * sdy - ey * sdx);
                const float ratio = d / sd0;
                bool cut = perp > tol || proj <= sProj || ratio < 0.88f || ratio > 1.14f;
                if (!cut) {
                    const float lv = sLevel / (float)sCount, se = sr + sg + sb;
                    cut = std::fabs(lvl - lv) > 0.15f * lv || std::fabs(r / lvl - sr / se) > 0.06f || std::fabs(g / lvl - sg / se) > 0.06f;
                }
                if (cut) {
                    close_sheet();
                    start_sheet(qx, qy);
                }
            }
            if (sCount == 0) {
                sd0 = d;
                sdx = (x - sx0) / d;
                sdy = (y - sy0) / d;
                sLevel = 0;
            }
            sx1 = x;
            sy1 = y;
            sProj = (x - sx0) * sdx + (y - sy0) * sdy;
            sL += d;
            sr += r; sg += g; sb += b; sl += l;
            sLevel += lvl;
            sCount++;
        }
        prevLit = true;
        qx = x;
        qy = y;
    }
    if (mode == 1) close_beam(); else if (mode == 2) close_sheet();
    return !over;
}

}  // namespace

bool ilda_parse(const uint8_t* data, size_t size, std::vector<IldaFrame>& frames, std::string& name) {
    static const int RECORD[6] = {8, 6, 3, 0, 10, 8};
    uint8_t palette[256][3];
    int npal = 64;
    for (int i = 0; i < 64; i++) for (int c = 0; c < 3; c++) palette[i][c] = DEFAULT_PALETTE[i][c];
    frames.clear();
    name.clear();
    size_t o = 0;
    while (o + 32 <= size) {
        const uint8_t* h = data + o;
        if (h[0] != 'I' || h[1] != 'L' || h[2] != 'D' || h[3] != 'A') break;
        const int format = h[7];
        const int count = be16(h + 24);
        if (name.empty()) {
            for (int i = 0; i < 8 && h[8 + i]; i++) name += (char)h[8 + i];
        }
        o += 32;
        if (format < 0 || format > 5 || RECORD[format] == 0) break;   // format inconnu : fin de lecture
        if (count == 0) break;                                         // en-tete de fin de fichier
        const int rs = RECORD[format];
        if (o + (size_t)count * rs > size) break;                      // fichier tronque
        if (format == 2) {
            npal = std::min(count, 256);
            for (int i = 0; i < npal; i++) for (int c = 0; c < 3; c++) palette[i][c] = data[o + (size_t)i * 3 + c];
            o += (size_t)count * rs;
            continue;
        }
        IldaFrame f;
        const bool is3d = format == 0 || format == 4;
        const int n = std::min(count, MAX_POINTS);
        for (int i = 0; i < n; i++) {
            const uint8_t* p = data + o + (size_t)i * rs;
            const float x = be16s(p) / 32768.0f, y = be16s(p + 2) / 32768.0f;
            const uint8_t* sp = p + (is3d ? 6 : 4);
            const uint8_t status = sp[0];
            float r = 0, g = 0, b = 0;
            if (!(status & 0x40)) {
                if (format == 4 || format == 5) {
                    b = sp[1] / 255.0f;
                    g = sp[2] / 255.0f;
                    r = sp[3] / 255.0f;
                } else {
                    const int ci = sp[1] < npal ? sp[1] : 0;
                    r = palette[ci][0] / 255.0f;
                    g = palette[ci][1] / 255.0f;
                    b = palette[ci][2] / 255.0f;
                }
            }
            f.push(x, y, r, g, b);
        }
        if (f.size() == 0) f.push(0, 0, 0, 0, 0);
        frames.push_back(std::move(f));
        o += (size_t)count * rs;
    }
    while (!name.empty() && name.back() == ' ') name.pop_back();
    return !frames.empty();
}

void IldaLibrary::scan(const std::string& exe_path, const std::string& dir) {
    clips.clear();
    labels.clear();
    root.clear();
    std::error_code ec;
    fs::path base;
    if (!dir.empty()) {
        base = fs::u8path(dir);
    } else {
        // depuis le dossier de l'executable (lyre-viz\ ou lyre-viz\bench\ref\), en remontant
        fs::path p = fs::absolute(fs::u8path(exe_path.empty() ? "." : exe_path), ec).parent_path();
        for (int i = 0; i < 6 && !p.empty(); i++) {
            const fs::path c = p / "server" / "storage" / "ilda";
            if (fs::is_directory(c, ec)) { base = c; break; }
            if (p == p.parent_path()) break;
            p = p.parent_path();
        }
    }
    if (base.empty() || !fs::is_directory(base, ec)) return;
    root = base.u8string();
    for (auto it = fs::recursive_directory_iterator(base, ec); it != fs::recursive_directory_iterator(); it.increment(ec)) {
        if (ec) break;
        if (!it->is_regular_file(ec)) continue;
        std::string ext = it->path().extension().u8string();
        std::transform(ext.begin(), ext.end(), ext.begin(), [](unsigned char c) { return (char)std::tolower(c); });
        if (ext != ".ild") continue;
        IldaClip c;
        c.path = it->path().u8string();
        const fs::path rel = fs::relative(it->path(), base, ec);
        c.bank = rel.has_parent_path() ? rel.parent_path().u8string() : std::string();
        c.name = it->path().stem().u8string();
        clips.push_back(std::move(c));
    }
    std::sort(clips.begin(), clips.end(), [](const IldaClip& a, const IldaClip& b) {
        return a.bank != b.bank ? a.bank < b.bank : a.name < b.name;
    });
    for (const IldaClip& c : clips) labels.push_back(c.bank.empty() ? c.name : c.bank + " / " + c.name);
}

IldaClip* IldaLibrary::get(int i) {
    if (i < 0 || i >= (int)clips.size()) return nullptr;
    IldaClip& c = clips[i];
    if (!c.loaded) {
        c.loaded = true;
        std::ifstream in(fs::u8path(c.path), std::ios::binary);
        std::vector<uint8_t> buf((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
        std::vector<IldaFrame> raw;
        std::string nm;
        c.failed = !ilda_parse(buf.data(), buf.size(), raw, nm);
        for (const IldaFrame& f : raw) {
            c.frames.push_back(complete_frame(f));
            c.points_max = std::max(c.points_max, c.frames.back().size());
        }
        for (int l = 0; l < ILDA_LEVELS; l++) {
            c.prims[l].assign(c.frames.size(), IldaPrims());
            c.done[l].assign(c.frames.size(), 0);
        }
    }
    return c.failed || c.frames.empty() ? nullptr : &c;
}

const IldaPrims& IldaLibrary::prims(IldaClip& c, int frame, int level, float divergence) {
    frame = std::clamp(frame, 0, (int)c.frames.size() - 1);
    level = std::clamp(level, 0, ILDA_LEVELS - 1);
    if (!c.done[level][frame]) {
        c.done[level][frame] = 1;
        // tolerances du web (angles pour +-30 deg), ramenees aux coordonnees du fichier
        const float dwell = std::max(divergence * 0.5f, 2.5e-4f) / REF_HALF_FIELD;
        const float tol = 7e-4f * (float)(1 << level) / REF_HALF_FIELD;
        // trop de primitives a ce niveau : la derniere passe garde tout
        IldaPrims& P = c.prims[level][frame];
        P.over = !extract(c.frames[frame], dwell, tol, level < ILDA_LEVELS - 1 ? ILDA_MAX_PRIMS : 1 << 30, P);
        if (P.over) {
            P.beams.clear();
            P.sheets.clear();
        }
    }
    return c.prims[level][frame];
}

std::vector<int> IldaLibrary::bank(const std::string& name) const {
    std::vector<int> r;
    for (int i = 0; i < (int)clips.size(); i++) if (clips[i].bank == name) r.push_back(i);
    return r;
}

int ilda_frame_index(int nframes, float fps, double t, int mode, int fixed) {
    if (nframes <= 1) return 0;
    if (mode == 2) return std::clamp(fixed, 0, nframes - 1);
    const long long slot = (long long)std::floor(t * std::max(fps, 0.01f));
    if (mode == 1) {
        const long long P = 2LL * nframes - 2;
        const long long m = ((slot % P) + P) % P;
        return (int)(m < nframes ? m : P - m);
    }
    return (int)(((slot % nframes) + nframes) % nframes);
}
