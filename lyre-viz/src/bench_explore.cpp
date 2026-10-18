// Banc d'exploration des lasers (--bench-explore) : voir bench_explore.h.
#include "bench_explore.h"
#include "app.h"
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <functional>

namespace explore {

const char* PLACE_NAMES[PL_COUNT] = {"repartis", "trusses", "scene (pont, sol, nez)", "trusses loin (x < 0)", "trusses au-dessus du public (x > 15)"};
const char* MOTION_NAMES[MO_COUNT] = {"fixe", "vague pan", "cercle", "balayage aleatoire", "rotation 60 deg/s"};

namespace {

const char* const BANKS[] = {"Nappes", "Faisceaux", "G\xc3\xa9om\xc3\xa9trie", "Tunnels", "Texte", "Animations", "Exemples",
                             "Crayon", "Formes", "Sinus"};
const int NBANKS = (int)(sizeof(BANKS) / sizeof(BANKS[0]));
const char* const VIEW_NAMES[] = {"public", "scene", "sous les trusses", "dans les nappes", "gros plan"};
const int NVIEWS = 5;

// tirages reproductibles (xorshift)
struct Rng {
    unsigned s;
    explicit Rng(unsigned seed) : s(seed * 2654435761u + 0x9E3779B9u) { next(); }
    unsigned next() {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        return s;
    }
    float uni() { return (next() & 0xFFFFFF) / 16777216.0f; }
    float uni(float a, float b) { return a + (b - a) * uni(); }
    int pick(int n) { return (int)(next() % (unsigned)n); }
    bool chance(float p) { return uni() < p; }
    template <typename T, size_t N> T of(const T (&v)[N]) { return v[pick((int)N)]; }
};

std::string fmt(const char* f, double v) {
    char b[64];
    std::snprintf(b, sizeof(b), f, v);
    return b;
}

// emplacements de chaque famille (indices des boitiers)
std::vector<int> eligible(int place) {
    std::vector<int> r;
    const std::vector<LaserFixture>& fx = app.lasers.fixtures;
    for (int i = 0; i < (int)fx.size(); i++) {
        const LaserMount& m = fx[i].mount;
        const bool truss = m.group <= 3;
        bool ok = true;
        switch (place) {
            case PL_TRUSSES: ok = truss; break;
            case PL_STAGE: ok = !truss; break;
            case PL_FAR: ok = truss && m.pos.x < 0.0f; break;
            case PL_NEAR: ok = truss && m.pos.x > 15.0f; break;
            default: break;
        }
        if (ok) r.push_back(i);
    }
    return r;
}

const vec3 PALETTE[] = {{0, 1, 0}, {1, 0, 0}, {0.1f, 0.35f, 1}, {1, 0.75f, 0}, {1, 0, 0.8f}, {0, 0.9f, 1}, {1, 1, 1}};

void set_shape_defaults(LaserParams& p) {
    if (p.shape == LS_GRID) p.shape_param = 5;
    else if (p.shape == LS_WAVE) { p.shape_param = 6; p.wave_cycles = 3; }
    else if (p.shape == LS_DOUBLE_FAN) p.shape_param = 10;
}

}  // namespace

std::string name(const Config& c) {
    std::string s = c.family == "hasard" ? "hasard" : (c.family == "base" ? "BASE" : c.factor + " = " + c.level);
    std::string content = c.shape == -1 ? "ILDA " + c.bank : (c.shape == -2 ? "melange" : LASER_SHAPE_NAMES[c.shape]);
    char b[512];
    std::snprintf(b, sizeof(b), "%s : %d lasers %s, %s, %d traits, %.0f deg, diffr. %d, %s / %s", s.c_str(), c.count,
                  PLACE_NAMES[c.place], content.c_str(), c.traits, c.opening, c.diffraction, MOTION_NAMES[c.motion],
                  VIEW_NAMES[c.view]);
    std::string r = b;
    if (c.fog != 1.0f) r += fmt(", fumee x%.2g", c.fog);
    for (const std::string& k : c.sets) r += ", " + k;
    return r;
}

std::vector<Config> build(bool sweep, int random, unsigned seed) {
    std::vector<Config> out;
    Config base;
    base.family = "base";
    if (sweep) {
        int since_base = 0;
        auto push = [&](Config c) {
            // la base revient tous les 20 cas : derive de la carte (temperature, frequence, autres programmes)
            if (since_base >= 20) {
                out.push_back(base);
                since_base = 0;
            }
            out.push_back(c);
            since_base++;
        };
        out.push_back(base);
        auto add = [&](const char* factor, const std::string& level, const std::function<void(Config&)>& mod) {
            Config c = base;
            c.family = "balayage";
            c.factor = factor;
            c.level = level;
            mod(c);
            push(c);
        };
        // nombre de lasers
        for (int n : {1, 10, 25, 100, 150, 200}) add("lasers", std::to_string(n), [n](Config& c) { c.count = n; });
        // emplacement (16 lasers chacun ; comparer a "repartis")
        for (int pl = 0; pl < PL_COUNT; pl++)
            add("emplacement (16 lasers)", PLACE_NAMES[pl], [pl](Config& c) { c.count = 16; c.place = pl; });
        // forme
        for (int s = 1; s < LS_COUNT; s++) add("forme", LASER_SHAPE_NAMES[s], [s](Config& c) { c.shape = s; });
        // traits
        for (int t : {0, 1, 4, 8, 16, 17, 32, 100, 300}) add("traits", std::to_string(t), [t](Config& c) { c.traits = t; });
        // ouverture
        for (float o : {0.0f, 5.0f, 10.0f, 20.0f, 60.0f}) add("ouverture", fmt("%.0f", o), [o](Config& c) { c.opening = o; });
        // diffraction
        for (int d : {3, 5, 9}) add("diffraction", std::to_string(d), [d](Config& c) { c.diffraction = d; });
        // degrade
        for (int g = 1; g < LG_COUNT; g++) add("degrade", LASER_GRADIENT_NAMES[g], [g](Config& c) { c.gradient = g; });
        // visee
        for (float t : {-25.0f, -10.0f, 10.0f, 25.0f}) add("visee (tilt)", fmt("%+.0f", t), [t](Config& c) { c.tilt = t; });
        add("ecart en pan", "30", [](Config& c) { c.pan_spread = 30; });
        // mouvement
        for (int m = 0; m < MO_COUNT; m++)
            if (m != MO_PAN_WAVE) add("mouvement", MOTION_NAMES[m], [m](Config& c) { c.motion = m; });
        // fichiers ILDA (50 lasers, un fichier de la banque chacun)
        for (int k = 0; k < NBANKS; k++)
            add("ILDA (banque)", BANKS[k], [k](Config& c) {
                c.shape = -1;
                c.bank = BANKS[k];
            });
        // melange de figures
        add("contenu", "melange", [](Config& c) { c.shape = -2; });
        // vue
        for (int v = 1; v < NVIEWS; v++) add("vue", VIEW_NAMES[v], [v](Config& c) { c.view = v; });
        // fumee
        for (float f : {0.0f, 0.25f, 2.0f, 4.0f}) add("fumee (densite x)", fmt("%.2g", f), [f](Config& c) { c.fog = f; });
        add("fumee", "sans amas (smoke=0)", [](Config& c) { c.sets = {"smoke=0"}; });
        // options du rendu, une par une
        const char* const opts[][2] = {
            {"volutes=0", "volutes coupees"},
            {"volfine=0", "2e octave des volutes coupee"},
            {"volutes=0,laserfog=0,laserphase=0", "fumee uniforme, un lobe (variante 0)"},
            {"laserimpacts=0", "impacts coupes"},
            {"laserexit=0", "lueur de sortie coupee"},
            {"laserwhite=0", "blanchiment coupe"},
            {"lasercoll=0", "collisions coupees"},
            {"lasercache=0", "cache coupe"},
            {"laserwidth=0.3", "largeur 0.3 px"},
            {"laserwidth=1.2", "largeur 1.2 px"},
            {"laserwidth=2", "largeur 2 px"},
            {"laserpower=0.2", "puissance 0.2 W"},
            {"laserpower=8", "puissance 8 W"},
            {"wet=0.3", "sol mouille 0.3"},
            {"wet=1", "sol inonde"},
            {"bloom=0", "bloom coupe"},
            {"fsr=1,fsrdiv=1.5", "FSR 1.5"},
            {"fsr=1,fsrdiv=2", "FSR 2"},
            {"lasers=0", "lasers coupes (scene seule)"},
        };
        for (const auto& o : opts)
            add("rendu", o[1], [&o](Config& c) {
                c.sets.clear();
                std::string s = o[0];
                size_t a = 0;
                while (a <= s.size()) {
                    size_t b = s.find(',', a);
                    if (b == std::string::npos) b = s.size();
                    if (b > a) c.sets.push_back(s.substr(a, b - a));
                    a = b + 1;
                }
            });
        out.push_back(base);
    }
    // programmations au hasard
    Rng r(seed);
    for (int k = 0; k < random; k++) {
        Config c;
        c.family = "hasard";
        c.seed = r.next();
        const int counts[] = {1, 3, 10, 25, 50, 100, 150, 200};
        c.count = r.of(counts);
        c.place = r.chance(0.5f) ? PL_SPREAD : r.pick(PL_COUNT);
        const float u = r.uni();
        if (u < 0.6f) c.shape = r.pick(LS_COUNT);
        else if (u < 0.8f) {
            c.shape = -1;
            c.bank = BANKS[r.pick(NBANKS)];
        } else c.shape = -2;
        const int traits[] = {0, 1, 4, 8, 16, 32, 100, 300, 1000};
        c.traits = r.of(traits);
        c.opening = r.chance(0.1f) ? 0.0f : std::round(r.uni(3, 60));
        c.diffraction = r.chance(0.7f) ? 1 : (r.chance(0.5f) ? 3 : (r.chance(0.5f) ? 5 : 9));
        c.gradient = r.chance(0.5f) ? LG_NONE : 1 + r.pick(LG_COUNT - 1);
        c.tilt = std::round(r.uni(-30, 30));
        c.pan_spread = r.chance(0.5f) ? 0.0f : std::round(r.uni(0, 30));
        c.motion = r.pick(MO_COUNT);
        c.view = r.chance(0.4f) ? 0 : r.pick(NVIEWS);
        const float fogs[] = {0.25f, 0.5f, 1.0f, 1.0f, 2.0f, 4.0f};
        c.fog = r.of(fogs);
        if (r.chance(0.2f)) c.sets.push_back("volutes=0");
        if (r.chance(0.15f)) c.sets.push_back("volfine=0");
        if (r.chance(0.15f)) c.sets.push_back("laserfog=0");
        if (r.chance(0.2f)) c.sets.push_back("laserimpacts=0");
        if (r.chance(0.15f)) c.sets.push_back("laserexit=0");
        if (r.chance(0.15f)) c.sets.push_back("lasercoll=0");
        if (r.chance(0.15f)) c.sets.push_back("lasercache=0");
        if (r.chance(0.3f)) {
            const float w[] = {0.3f, 1.2f, 2.0f};
            c.sets.push_back(fmt("laserwidth=%.1f", r.of(w)));
        }
        if (r.chance(0.25f)) c.sets.push_back(r.chance(0.5f) ? "wet=0.3" : "wet=1");
        out.push_back(c);
    }
    return out;
}

void program(const Config& c) {
    LaserRig& lr = app.lasers;
    lr.pattern = LP_PROGRAM;
    lr.effects.clear();
    lr.ilda_bias = 0;
    // lasers allumes : 'count' repartis regulierement sur les emplacements choisis
    const std::vector<int> el = eligible(c.place);
    const int N = (int)el.size(), on = std::clamp(c.count, 0, N);
    std::vector<int> lit;
    for (int i = 0; i < N && on > 0; i++)
        if ((long long)(i + 1) * on / N != (long long)i * on / N) lit.push_back(el[i]);
    // galvos, rotation continue et defilement remis a zero : chaque cas part du meme etat, quel que soit le precedent
    for (LaserFixture& f : lr.fixtures) {
        f.base = LaserParams();
        f.base.dimmer = 0;
        f.selected = false;
        f.pan = f.tilt = f.roll = f.roll_acc = f.scroll = 0;
        f.opening = f.base.opening;
    }
    std::vector<int> files;
    if (c.shape == -1) files = lr.ilda.bank(c.bank);
    std::vector<int> all_files;
    if (c.shape == -2)
        for (const char* b : BANKS) {
            const std::vector<int> v = lr.ilda.bank(b);
            all_files.insert(all_files.end(), v.begin(), v.end());
        }
    const int n = (int)lit.size();
    for (int k = 0; k < n; k++) {
        LaserFixture& f = lr.fixtures[lit[k]];
        LaserParams& p = f.base;
        const unsigned h = hash_u32(c.seed * 977u + (unsigned)lit[k]);
        p.dimmer = 1;
        p.color = PALETTE[(lit[k] + f.mount.group) % 6];
        p.color2 = PALETTE[(lit[k] + 2) % 7];
        p.color3 = PALETTE[(lit[k] + 4) % 7];
        p.shape = c.shape >= 0 ? c.shape : LS_FAN;
        p.traits = c.traits;
        p.opening = c.opening;
        p.diffraction = c.diffraction;
        p.diffraction_angle = 8;
        p.gradient = c.gradient;
        p.tilt = c.tilt;
        p.pan = n > 1 ? c.pan_spread * (2.0f * k / (n - 1) - 1.0f) : 0.0f;
        // roulis : 0 a la base (eventails a plat), au hasard dans les programmations tirees au hasard
        if (c.family == "hasard") p.roll = 180.0f * hash01(h);
        if (c.motion == MO_ROLL) p.roll_speed = 60;
        set_shape_defaults(p);
        if (c.shape == -1 && !files.empty()) {
            p.source = 1;
            p.ilda_clip = files[k % files.size()];
        } else if (c.shape == -1) {
            p.dimmer = 0;
        } else if (c.shape == -2) {
            // melange : une figure au hasard par laser (15 % de fichiers ILDA)
            const unsigned h2 = hash_u32(h + 1u), h3 = hash_u32(h + 2u);
            if (hash01(h2) < 0.15f && !all_files.empty()) {
                p.source = 1;
                p.ilda_clip = all_files[h3 % all_files.size()];
            } else {
                p.shape = (int)(h3 % LS_COUNT);
                const int tr[] = {0, 1, 8, 32, 300, 1000};
                p.traits = tr[hash_u32(h + 3u) % 6];
                p.opening = 5.0f + 50.0f * hash01(hash_u32(h + 4u));
                p.gradient = (int)(hash_u32(h + 5u) % LG_COUNT);
                set_shape_defaults(p);
            }
        }
        f.selected = true;
    }
    // mouvement : un effet sur tous les lasers allumes
    if (c.motion == MO_PAN_WAVE || c.motion == MO_CIRCLE || c.motion == MO_RANDOM) {
        lr.add_effect(c.motion == MO_PAN_WAVE ? LFX_PAN_WAVE : (c.motion == MO_CIRCLE ? LFX_CIRCLE : LFX_RANDOM));
        if (c.motion == MO_PAN_WAVE) lr.effects.back().spread = 360;
    }
    lr.select_all(false);
}

std::string csv_header() {
    return "famille;facteur;niveau;lasers_voulus;emplacement;contenu;traits;ouverture;diffraction;degrade;tilt;ecart_pan;"
           "mouvement;vue;fumee;reglages";
}

std::string csv_row(const Config& c, const char* view_name) {
    std::string content = c.shape == -1 ? "ILDA " + c.bank : (c.shape == -2 ? "melange" : LASER_SHAPE_NAMES[c.shape]);
    std::string sets;
    for (const std::string& s : c.sets) sets += (sets.empty() ? "" : " ") + s;
    char b[1024];
    std::snprintf(b, sizeof(b), "%s;%s;%s;%d;%s;%s;%d;%.1f;%d;%s;%.1f;%.1f;%s;%s;%.2f;%s", c.family.c_str(), c.factor.c_str(),
                  c.level.c_str(), c.count, PLACE_NAMES[c.place], content.c_str(), c.traits, c.opening, c.diffraction,
                  LASER_GRADIENT_NAMES[c.gradient], c.tilt, c.pan_spread, MOTION_NAMES[c.motion], view_name, c.fog, sets.c_str());
    return b;
}

}  // namespace explore
