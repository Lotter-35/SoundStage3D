#include "ilda.h"
#include <algorithm>
#include <cmath>
#include <cstdio>
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

// ---- Banques generees (bancs P1 a P3) ---------------------------------------------------------------------------
// Une image se construit comme un fichier ILDA : points de duree egale, a ~30 000 points/s ; les coins sont tenus
// quelques points (le faisceau s'y arrete, comme dans un fichier bien fait), les sauts sont eteints.
struct FrameBuilder {
    IldaFrame f;
    float x = 0, y = 0;
    void point(float px, float py, float r, float g, float b) {
        f.push(px, py, r, g, b);
        x = px;
        y = py;
    }
    // saut eteint (n points le long du saut, puis 6 points sur place : les miroirs arrivent)
    void blank_to(float px, float py, int n = 8) {
        for (int i = 1; i <= n; i++) point(x + (px - x) * i / n, y + (py - y) * i / n, 0, 0, 0);
        for (int i = 0; i < 6; i++) point(px, py, 0, 0, 0);
    }
    void hold(int n, float r, float g, float b) {
        for (int i = 0; i < n; i++) point(x, y, r, g, b);
    }
    // trait allume, un point tous les 'step'
    void line_to(float px, float py, float r, float g, float b, float step = 0.02f) {
        const float d = std::sqrt((px - x) * (px - x) + (py - y) * (py - y));
        const int n = std::max(1, (int)std::ceil(d / step));
        const float x0 = x, y0 = y;
        for (int i = 1; i <= n; i++) point(x0 + (px - x0) * i / n, y0 + (py - y0) * i / n, r, g, b);
    }
};

// Generateur pseudo-aleatoire reproductible (bancs).
struct Rng {
    uint32_t s;
    float uni() {
        s = s * 1664525u + 1013904223u;
        return (float)(s >> 8) / 16777216.0f;
    }
    float gauss() {
        const float u = std::max(uni(), 1e-7f), v = uni();
        return std::sqrt(-2.0f * std::log(u)) * std::cos(6.2831853f * v);
    }
};

// Dessin a main levee : courbe lisse au hasard, vitesse irreguliere, tremblement de la main ; trait ouvert, retour
// eteint au depart.
IldaFrame pencil_frame(uint32_t seed) {
    Rng R{seed * 2654435761u + 17u};
    float ax[3], ay[3], fx[3], fy[3], px[3], py[3];
    for (int k = 0; k < 3; k++) {
        ax[k] = (0.55f - 0.15f * k) * (0.6f + 0.4f * R.uni());
        ay[k] = (0.5f - 0.13f * k) * (0.6f + 0.4f * R.uni());
        fx[k] = (0.7f + 1.4f * k) * (0.8f + 0.4f * R.uni());
        fy[k] = (0.6f + 1.3f * k) * (0.8f + 0.4f * R.uni());
        px[k] = 6.2831853f * R.uni();
        py[k] = 6.2831853f * R.uni();
    }
    const float hue = R.uni();
    const float r = 0.5f + 0.5f * std::cos(6.2831853f * hue), g = 0.5f + 0.5f * std::cos(6.2831853f * (hue - 0.333f)),
                b = 0.5f + 0.5f * std::cos(6.2831853f * (hue - 0.667f));
    FrameBuilder fb;
    auto curve = [&](float t, float& cx, float& cy) {
        cx = 0.0f;
        cy = 0.0f;
        for (int k = 0; k < 3; k++) {
            cx += ax[k] * std::sin(6.2831853f * fx[k] * t + px[k]);
            cy += ay[k] * std::sin(6.2831853f * fy[k] * t + py[k]);
        }
    };
    const int N = 1200;
    float t = 0.0f, cx, cy;
    curve(0.0f, cx, cy);
    fb.blank_to(cx, cy);
    fb.hold(4, r, g, b);
    float jx = 0.0f, jy = 0.0f;
    for (int i = 0; i < N; i++) {
        // vitesse irreguliere (la main accelere et ralentit) ; tremblement : bruit correle sur quelques points
        t += (1.0f + 0.6f * std::sin(i * 0.05f) + 0.4f * R.uni()) / (float)N;
        jx = 0.7f * jx + 0.3f * 0.003f * R.gauss();
        jy = 0.7f * jy + 0.3f * 0.003f * R.gauss();
        curve(t, cx, cy);
        fb.point(cx + jx, cy + jy, r, g, b);
    }
    fb.hold(4, r, g, b);
    return fb.f;
}

// Contour ferme par sommets, coins tenus 'hold' points.
IldaFrame polygon_frame(const std::vector<float>& vx, const std::vector<float>& vy, float r, float g, float b, int hold = 5) {
    FrameBuilder fb;
    fb.blank_to(vx[0], vy[0]);
    fb.hold(hold, r, g, b);
    for (size_t i = 1; i <= vx.size(); i++) {
        const size_t k = i % vx.size();
        fb.line_to(vx[k], vy[k], r, g, b);
        fb.hold(hold, r, g, b);
    }
    return fb.f;
}

// Courbe parametree fermee (n points), points tenus aux parametres 'holds' (pointes).
template <typename F>
IldaFrame curve_frame(F fn, int n, float r, float g, float b, std::vector<int> holds = {}) {
    FrameBuilder fb;
    float x0, y0;
    fn(0.0f, x0, y0);
    fb.blank_to(x0, y0);
    for (int i = 0; i <= n; i++) {
        float x, y;
        fn((float)i / (float)n, x, y);
        fb.point(x, y, r, g, b);
        for (int h : holds)
            if (h == i % n) fb.hold(5, r, g, b);
    }
    return fb.f;
}

void add_clip(std::vector<IldaClip>& clips, const char* bank, const char* name, std::vector<IldaFrame> frames) {
    IldaClip c;
    c.bank = bank;
    c.name = name;
    c.loaded = true;
    c.frames = std::move(frames);
    for (const IldaFrame& f : c.frames) c.points_max = std::max(c.points_max, f.size());
    for (int l = 0; l < ILDA_LEVELS; l++) {
        c.prims[l].assign(c.frames.size(), IldaPrims());
        c.done[l].assign(c.frames.size(), 0);
    }
    clips.push_back(std::move(c));
}

}  // namespace

void IldaLibrary::add_generated() {
    const float TAU = 6.2831853f;
    // P1 : dessins a main levee
    for (int s = 0; s < 8; s++) {
        char nm[32];
        std::snprintf(nm, sizeof(nm), "Dessin %d", s + 1);
        add_clip(clips, "Crayon", nm, {pencil_frame((uint32_t)s)});
    }
    // P2 : formes
    {
        std::vector<float> vx, vy;
        add_clip(clips, "Formes", "Carre", {polygon_frame({-0.6f, 0.6f, 0.6f, -0.6f}, {-0.6f, -0.6f, 0.6f, 0.6f}, 0, 1, 0)});
        for (int k = 0; k < 10; k++) {
            const float a = TAU * k / 10.0f + 0.25f * TAU, rr = k % 2 == 0 ? 0.8f : 0.33f;
            vx.push_back(rr * std::cos(a));
            vy.push_back(rr * std::sin(a));
        }
        add_clip(clips, "Formes", "Etoile", {polygon_frame(vx, vy, 1, 0.8f, 0)});
        add_clip(clips, "Formes", "Triangle", {polygon_frame({0.0f, 0.7f, -0.7f}, {0.75f, -0.55f, -0.55f}, 0, 0.5f, 1)});
        add_clip(clips, "Formes", "Coeur", {curve_frame([&](float u, float& x, float& y) {
            const float t = TAU * u, st = std::sin(t);
            x = 0.045f * 16.0f * st * st * st;
            y = 0.045f * (13.0f * std::cos(t) - 5.0f * std::cos(2 * t) - 2.0f * std::cos(3 * t) - std::cos(4 * t)) + 0.1f;
        }, 300, 1, 0, 0.1f, {0, 150})});
        add_clip(clips, "Formes", "Cercle", {curve_frame([&](float u, float& x, float& y) {
            x = 0.7f * std::cos(TAU * u);
            y = 0.7f * std::sin(TAU * u);
        }, 160, 0, 0.9f, 1)});
        add_clip(clips, "Formes", "Spirale", {curve_frame([&](float u, float& x, float& y) {
            const float rr = 0.1f + 0.7f * u;
            x = rr * std::cos(3.0f * TAU * u);
            y = rr * std::sin(3.0f * TAU * u);
        }, 500, 1, 0, 1)});
        FrameBuilder fb;
        for (int k = 0; k < 3; k++) {
            fb.blank_to(-0.8f, 0.5f - 0.5f * k);
            fb.hold(4, 1, 1, 1);
            fb.line_to(0.8f, 0.5f - 0.5f * k + 0.2f, 1, 1, 1);
            fb.hold(4, 1, 1, 1);
        }
        add_clip(clips, "Formes", "Lignes", {fb.f});
        FrameBuilder fp;
        for (int k = 0; k < 8; k++) {
            fp.blank_to(0.7f * std::cos(TAU * k / 8.0f), 0.7f * std::sin(TAU * k / 8.0f));
            fp.hold(12, 0.2f, 1, 0.2f);
        }
        add_clip(clips, "Formes", "Points", {fp.f});
    }
    // P3 : sinus modules et Lissajous, animes (60 images)
    {
        std::vector<IldaFrame> sin_frames, lis_frames;
        for (int i = 0; i < 60; i++) {
            const float ph = TAU * i / 60.0f;
            FrameBuilder fb;
            fb.blank_to(-0.9f, 0.0f);
            for (int k = 0; k <= 400; k++) {
                const float x = -0.9f + 1.8f * k / 400.0f;
                const float amp = 0.25f + 0.2f * std::sin(ph + 2.0f * x);
                fb.point(x, amp * std::sin(4.0f * TAU * 0.25f * (x + 1.0f) * 2.0f + 3.0f * ph), 0.1f, 1, 0.3f);
            }
            sin_frames.push_back(fb.f);
            lis_frames.push_back(curve_frame([&](float u, float& x, float& y) {
                x = 0.7f * std::sin(3.0f * TAU * u + ph);
                y = 0.7f * std::sin(2.0f * TAU * u);
            }, 500, 1, 0.3f, 0.8f));
        }
        add_clip(clips, "Sinus", "Sinus module", std::move(sin_frames));
        add_clip(clips, "Sinus", "Lissajous", std::move(lis_frames));
    }
    labels.clear();
    for (const IldaClip& c : clips) labels.push_back(c.bank.empty() ? c.name : c.bank + " / " + c.name);
}

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
    if (base.empty() || !fs::is_directory(base, ec)) {
        add_generated();
        return;
    }
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
    add_generated();
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
        // faisceau sur place : la moitie de sa divergence (angles pour +-30 deg, ramenes aux coordonnees du fichier) ;
        // ecart aux arcs et droites : 5e-4 du champ (0,01 deg pour 40 deg d'ouverture), double a chaque niveau
        const IldaFrame& f = c.frames[frame];
        TraceParams tp;
        tp.dwell = std::max(divergence * 0.5f, 2.5e-4f) / REF_HALF_FIELD;
        tp.tol = 5e-4f * (float)(1 << level);
        std::vector<vec3> col(f.size());
        for (int i = 0; i < f.size(); i++) col[i] = vec3(srgb_to_linear(f.r[i]), srgb_to_linear(f.g[i]), srgb_to_linear(f.b[i]));
        // trop de morceaux a ce niveau : la derniere passe garde tout
        IldaPrims& P = c.prims[level][frame];
        P.over = !trace_fit(f.x, f.y, col, tp, level < ILDA_LEVELS - 1 ? ILDA_MAX_PRIMS : 1 << 30, P.prims);
        if (P.over) P.prims.clear();
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
