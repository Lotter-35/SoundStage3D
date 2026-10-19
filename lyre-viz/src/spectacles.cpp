// Generateur de spectacles laser : voir spectacles.h.
//
// Une scene programme les lasers et les lyres (figures, gobos, puis effets), dans ses couleurs. L'energie regle tout,
// de la meme facon pour toutes les scenes :
//   0           figures fixes : aucun effet, aucun clignotement ;
//   0 a 0,3     petits mouvements lents, couleurs fixes ;
//   0,3 a 0,55  mouvements plus amples et effets doux : fondus de couleur, respiration, chenillards lents ;
//   0,55 a 0,8  rythme : chenillards et clignotements sur le temps, couleurs pas a pas, rotations ;
//   0,8 a 1     flashs, sauts, scintillement, rotations rapides dans tous les sens.
// Les vitesses sont des fractions du tempo (72 a 140 temps par minute selon l'energie, ou un tempo choisi) : un cycle
// dure un nombre de temps, en puissance de 2 des que l'energie depasse 0,4. La phase de chaque effet suit l'horloge du
// spectacle (temps ecoules) : les effets restent ensemble, et une scene regeneree (energie, couleurs) ne saute pas.
#include "spectacles.h"
#include "ambiances.h"
#include "app.h"
#include "gpu_profiler.h"
#include "imgui.h"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>

Spectacle g_spectacle;

namespace {
// --set spjournal=fichier : temps des images 120 a 420 de la scene lancee (temps reel moyen entre deux images, et temps
// GPU de chaque image : moyenne, mediane, 90e centile, maximum ; Direct3D 11), ajoutes au fichier (cout des scenes, en
// plein ecran sans synchro verticale)
std::string journal_path;
int journal_frame = 0, journal_count = 0;
double journal_wall = 0;
std::vector<float> journal_ms;
std::chrono::steady_clock::time_point journal_prev;
}  // namespace

namespace {

// groupes des boitiers : 0-3 trusses, 4 pont de scene, 5 sol de scene, 6 nez de scene
enum : unsigned { TRUSS = 0xFu, PONT = 1u << 4, SOL = 1u << 5, NEZ = 1u << 6 };

// couleurs (la bibliotheque des spectacles, SPECTACLE_COLORS, les range par famille)
constexpr vec3 RED = {1, 0, 0}, BLOOD = {0.75f, 0, 0.02f}, CARMINE = {1, 0, 0.18f}, VERMILION = {1, 0.15f, 0};
constexpr vec3 CORAL = {1, 0.3f, 0.2f}, RASPBERRY = {0.9f, 0, 0.3f};
constexpr vec3 ORANGE = {1, 0.35f, 0}, TANGERINE = {1, 0.45f, 0.05f}, AMBER = {1, 0.55f, 0.12f}, COPPER = {0.95f, 0.42f, 0.18f};
constexpr vec3 PEACH = {1, 0.62f, 0.42f};
constexpr vec3 GOLD = {1, 0.7f, 0.15f}, YELLOW = {1, 0.8f, 0}, LEMON = {0.95f, 1, 0.1f}, STRAW = {1, 0.88f, 0.55f};
constexpr vec3 LIME = {0.55f, 1, 0}, ACID = {0.75f, 1, 0.1f}, GREEN = {0, 1, 0}, MATRIX = {0.2f, 1, 0.3f};
constexpr vec3 EMERALD = {0, 0.9f, 0.35f}, MINT = {0.4f, 1, 0.6f};
constexpr vec3 TURQ = {0, 1, 0.6f}, LAGOON = {0, 1, 0.85f}, AQUA = {0.55f, 1, 0.95f}, CYAN = {0, 0.85f, 1}, ICE = {0.6f, 0.9f, 1};
constexpr vec3 SKY = {0.4f, 0.7f, 1}, AZUR = {0, 0.45f, 1}, MOON = {0.35f, 0.5f, 1}, BLUE = {0.05f, 0.2f, 1}, DEEP = {0, 0, 1};
constexpr vec3 NIGHT = {0.08f, 0.12f, 0.75f};
constexpr vec3 INDIGO = {0.3f, 0, 1}, PURPLE = {0.5f, 0, 1}, AMETHYST = {0.62f, 0.2f, 1}, LILAC = {0.75f, 0.45f, 1};
constexpr vec3 LAVENDER = {0.7f, 0.6f, 1};
constexpr vec3 MAGENTA = {1, 0, 0.8f}, FUCHSIA = {1, 0, 0.5f}, NEON_PINK = {1, 0.1f, 0.55f}, PINK = {1, 0.25f, 0.55f};
constexpr vec3 POWDER = {1, 0.55f, 0.7f};
constexpr vec3 WHITE = {1, 1, 1}, COOL_WHITE = {0.82f, 0.92f, 1}, WARM_WHITE = {1, 0.78f, 0.55f};

// roue des teintes : harmonies des couleurs tirees au hasard
const vec3 WHEEL[12] = {RED, ORANGE, YELLOW, LIME, GREEN, TURQ, CYAN, AZUR, BLUE, PURPLE, MAGENTA, PINK};

struct Rng {
    uint32_t s;
    explicit Rng(uint32_t seed) : s(hash_u32(seed * 747796405u + 2891336453u) | 1u) {}
    uint32_t next() {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        return s;
    }
    float uni() { return (float)(next() >> 8) / 16777216.0f; }
    float range(float a, float b) { return a + (b - a) * uni(); }
    int below(int n) { return n > 0 ? (int)(next() % (uint32_t)n) : 0; }
};

float centered(int k, int n) { return n > 1 ? 2.0f * (float)k / (float)(n - 1) - 1.0f : 0.0f; }

void figure(LaserParams& p, int shape, float opening, int traits, float roll = 0) {
    p.shape = shape;
    p.opening = opening;
    p.traits = traits;
    p.roll = roll;
}

std::vector<int> join(std::vector<int> a, const std::vector<int>& b) {
    a.insert(a.end(), b.begin(), b.end());
    return a;
}

// Facons de repartir les couleurs sur une selection (dans son ordre).
enum Paint {
    P_ONE,     // une seule couleur (la 'first') ; arc-en-ciel : teintes reparties
    P_ALT,     // une couleur par laser, en boucle
    P_BLOCK,   // la selection decoupee en blocs, une couleur par bloc
    P_HALF,    // moitie gauche, moitie droite
    P_GROUP,   // une couleur par groupe de boitiers (ligne de trusses, pont...)
    P_RANK,    // une couleur par rang dans le groupe (le long des trusses)
    P_RAND,    // au hasard
    P_GRAD     // degrade le long de chaque figure (2 ou 3 couleurs, arc-en-ciel)
};

// Programmation d'une scene : lasers, energie, tempo, couleurs, et les outils communs des scenes.
struct Prog {
    LaserRig& lr;
    float e = 0;           // energie
    float bhz = 1;         // temps par seconde
    double beats = 0;      // horloge du spectacle
    std::vector<vec3> pal; // couleurs (arc-en-ciel : les 12 de la roue)
    bool rainbow = false;
    Rng rng;
    std::vector<int> cidx;   // couleur de base de chaque laser (indice dans pal), pour les changements de couleur
    Rig& rig;                // lyres
    std::vector<int> lcidx;  // couleur de base de chaque lyre

    Prog(LaserRig& r, Rig& rg, uint32_t seed) : lr(r), rng(seed), cidx(r.fixtures.size(), 0), rig(rg), lcidx(rg.fixtures.size(), 0) {}

    int ncol() const { return (int)pal.size(); }
    vec3 col(int i) const {
        const int n = ncol();
        return pal[(size_t)(((i % n) + n) % n)];
    }
    // part du mouvement : 0 (fixe) a 1
    float mv() const { return e <= 0.0f ? 0.0f : std::pow(e, 0.8f); }
    float amp(float hi) const { return hi * mv(); }
    // temps par cycle, de 'slow' (energie faible) a 'fast' (forte) ; puissance de 2 au-dessus de 0,4 (sur le temps)
    float cycle_beats(float slow, float fast) const {
        float b = slow * std::pow(fast / slow, e);
        if (e >= 0.4f) b = std::exp2(std::round(std::log2(b)));
        return b;
    }
    // vitesse d'un effet (cycles/s) ; 0 a energie nulle
    float spd(float slow, float fast) const { return e <= 0.0f ? 0.0f : bhz / cycle_beats(slow, fast); }
    // rotation continue (deg/s) : un tour en 'slow' a 'fast' temps
    float turn(float slow, float fast) const { return e <= 0.0f ? 0.0f : 360.0f * spd(slow, fast); }
    bool soft() const { return e >= 0.3f; }     // effets doux
    bool groove() const { return e >= 0.55f; }  // rythme, clignotements
    bool wild() const { return e >= 0.8f; }     // flashs, sauts

    // --- selections (indices dans lr.fixtures) ---
    // lasers des groupes 'mask', un sur 'every' dans chaque groupe a partir du rang 'first'
    std::vector<int> sel(unsigned mask, int every = 1, int first = 0) const {
        std::vector<int> r;
        int kg[32] = {};
        for (int i = 0; i < (int)lr.fixtures.size(); i++) {
            const int g = lr.fixtures[i].mount.group;
            if (g < 0 || g >= 32 || !((mask >> g) & 1u)) continue;
            const int k = kg[g]++;
            if (k >= first && (k - first) % std::max(every, 1) == 0) r.push_back(i);
        }
        return r;
    }
    // triee le long de la salle (de la scene vers le fond), puis en travers
    std::vector<int> by_x(std::vector<int> s) const {
        std::stable_sort(s.begin(), s.end(), [&](int a, int b) {
            const vec3 pa = lr.fixtures[a].mount.pos, pb = lr.fixtures[b].mount.pos;
            return pa.x < pb.x - 0.01f || (std::fabs(pa.x - pb.x) <= 0.01f && pa.z < pb.z);
        });
        return s;
    }
    // triee en travers (de -z a +z)
    std::vector<int> by_z(std::vector<int> s) const {
        std::stable_sort(s.begin(), s.end(), [&](int a, int b) { return lr.fixtures[a].mount.pos.z < lr.fixtures[b].mount.pos.z; });
        return s;
    }
    // triee par angle autour de C, vu de la scene (chenillards en rond)
    std::vector<int> around(std::vector<int> s, vec3 C) const {
        auto ang = [&](int i) { const vec3 p = lr.fixtures[i].mount.pos; return std::atan2(p.y - C.y, p.z - C.z); };
        std::stable_sort(s.begin(), s.end(), [&](int a, int b) { return ang(a) < ang(b); });
        return s;
    }
    // un sur deux (parite 0 ou 1)
    static std::vector<int> alt(const std::vector<int>& s, int parity) {
        std::vector<int> r;
        for (size_t k = 0; k < s.size(); k++) if ((int)(k & 1) == parity) r.push_back(s[k]);
        return r;
    }
    // pan et tilt qui envoient l'axe du laser i sur P ; faux si P sort du champ du scanner
    bool aim_at(int i, vec3 P, float& pan, float& tilt) const {
        const LaserFixture& f = lr.fixtures[i];
        const vec3 D = P - (f.mount.pos + f.aim * 0.17f);
        const float x = dot(D, f.aim);
        if (x <= 0.05f * length(D)) return false;
        pan = std::atan(dot(D, f.right) / x) / DEG;
        tilt = std::atan(dot(D, f.up) / x) / DEG;
        const float lim = 0.5f * lr.max_angle - 2.0f;
        return std::fabs(pan) <= lim && std::fabs(tilt) <= lim;
    }
    // le laser i peut-il viser C et tout cercle de rayon r autour (convergence) ?
    bool reach(int i, vec3 C, float r) const {
        float a, b;
        for (vec3 d : {vec3(0, 0, 0), vec3(0, r, 0), vec3(0, -r, 0), vec3(0, 0, r), vec3(0, 0, -r)})
            if (!aim_at(i, C + d, a, b)) return false;
        return true;
    }

    // --- figures ---
    // allume les lasers de la selection, puis fn(parametres, rang, nombre, laser)
    template <typename F> void setup(const std::vector<int>& s, F fn) {
        const int n = (int)s.size();
        for (int k = 0; k < n; k++) {
            LaserFixture& f = lr.fixtures[(size_t)s[k]];
            f.base.dimmer = 1;
            fn(f.base, k, n, f);
        }
    }

    // --- effets ---
    // Effet sur la selection, dans son ordre (il fixe le decalage d'un laser a l'autre). Phase calee sur l'horloge du
    // spectacle (+ phase0, en cycles). Rien si la selection est vide, ou si l'effet ne ferait rien (vitesse ou
    // amplitude nulle : energie 0) ; les eventails, la convergence et les couleurs peuvent etre fixes (vitesse 0).
    Effect* fx(const std::vector<int>& s, int type, float size, float speed, float spread = 360, int wave = -1, float duty = -1,
               int wings = 1, float phase0 = 0) {
        if (s.empty()) return nullptr;
        const bool can_stay = type == LFX_SPREAD || type == LFX_TILT_SPREAD || type == LFX_ROLL_SPREAD || type == LFX_CONVERGE ||
                              type == LFX_RAINBOW || type == LFX_PALETTE;
        if (speed <= 0.0f && !can_stay) return nullptr;
        if (size == 0.0f && type != LFX_CONVERGE && type != LFX_PALETTE) return nullptr;
        lr.add_effect(type);   // valeurs par defaut de l'effet (aucun laser selectionne), puis celles-ci
        Effect& ef = lr.effects.back();
        ef.fixtures = s;
        ef.size = size;
        ef.speed = std::max(speed, 0.0f);
        ef.spread = spread;
        ef.wings = wings;
        if (wave >= 0) ef.wave = wave;
        if (duty >= 0) ef.duty = duty;
        ef.phase = (float)std::fmod(beats / (double)bhz * (double)ef.speed, 4096.0) + phase0;
        return &ef;
    }

    // Couleurs de la selection ('first' : decalage dans la palette).
    void paint(const std::vector<int>& s, int mode, int first = 0) {
        const int n = (int)s.size(), N = ncol();
        int groups[32], ng = 0;
        for (int g = 0; g < 32; g++) groups[g] = -1;
        for (int k = 0; k < n; k++) {
            const int i = s[k];
            LaserFixture& f = lr.fixtures[(size_t)i];
            LaserParams& p = f.base;
            int m = mode;
            if (rainbow && m == P_ONE) m = P_BLOCK;   // arc-en-ciel : les teintes se repartissent
            int ci = first;
            switch (m) {
                case P_ALT: ci += k; break;
                case P_BLOCK: ci += n > 0 ? k * N / n : 0; break;
                case P_HALF: ci += 2 * k >= n ? 1 : 0; break;
                case P_GROUP: {
                    const int g = std::clamp(f.mount.group, 0, 31);
                    if (groups[g] < 0) groups[g] = ng++;
                    ci += groups[g];
                    break;
                }
                case P_RANK: {
                    int r = 0;
                    for (int j = 0; j < i; j++) r += lr.fixtures[(size_t)j].mount.group == f.mount.group ? 1 : 0;
                    ci += r;
                    break;
                }
                case P_RAND: ci += rng.below(N); break;
                default: break;
            }
            cidx[(size_t)i] = ci;
            p.color = col(ci);
            p.color2 = col(ci + 1);
            p.color3 = col(ci + 2);
            p.gradient = LG_NONE;
            if (m == P_GRAD) {
                if (rainbow) {
                    p.gradient = LG_RAINBOW;
                    p.gradient_speed = 0;
                } else if (N == 2) {
                    p.gradient = LG_TWO;
                } else if (N >= 3) {
                    p.gradient = LG_THREE;
                }
            }
        }
    }

    // Couleurs qui changent selon l'energie : fixes sous 0,3 ; fondu lent (16 temps par couleur) ; puis pas a pas sur
    // le temps (4, 2 puis 1 temps par couleur). Les lasers gardent leurs ecarts de couleur (une couleur de la palette
    // chacun) : toute la palette tourne. Arc-en-ciel : les degrades defilent, les teintes tournent d'un laser a l'autre.
    void color_motion(const std::vector<int>& s) {
        if (s.empty() || e <= 0.0f) return;
        if (rainbow) {
            std::vector<int> other;
            for (int i : s) {
                LaserParams& p = lr.fixtures[(size_t)i].base;
                if (p.gradient == LG_RAINBOW) p.gradient_speed = 0.03f + 0.6f * e * e;
                else other.push_back(i);
            }
            if (soft()) fx(other, LFX_RAINBOW, 1, spd(64, 8), 360);
            return;
        }
        const int N = ncol();
        if (N < 2 || !soft()) return;
        const bool step = groove();
        const float per = !step ? 16.0f : (!wild() ? 4.0f : (e >= 0.92f ? 1.0f : 2.0f));   // temps par couleur
        for (int c = 0; c < N; c++) {
            std::vector<int> sub;
            for (int i : s) if (((cidx[(size_t)i] % N) + N) % N == c) sub.push_back(i);
            fx(sub, LFX_PALETTE, 1, bhz / (per * (float)N), 0, step ? WAVE_SQUARE : WAVE_SINE, -1, 1, (float)c / (float)N);
        }
    }

    // Intensite : respiration douce (0,3 a 0,55), chenillard sur le temps (decalage 'spread'), puis flashs rapides.
    void pulse(const std::vector<int>& s, float spread, int wings = 1) {
        if (s.empty() || !soft()) return;
        if (!groove()) fx(s, LFX_DIMMER_CHASE, 0.25f + 0.6f * (e - 0.3f), spd(16, 8), spread, WAVE_SINE, -1, wings);
        else if (!wild()) fx(s, LFX_DIMMER_CHASE, 1, bhz / 2, spread, WAVE_SQUARE, 0.5f, wings);
        else fx(s, LFX_DIMMER_CHASE, 1, e >= 0.92f ? 2 * bhz : bhz, spread, WAVE_SQUARE, 0.35f, wings);
    }
    // decalage d'un tirage au hasard (pour que les lasers voisins ne changent pas en meme temps)
    static float scatter(const std::vector<int>& s) { return 360.0f * (float)s.size() * 0.618f; }
    // --- lyres : memes outils (indices dans rig.fixtures) ---
    std::vector<int> lsel(unsigned mask, int every = 1, int first = 0) const {
        std::vector<int> r;
        int kg[32] = {};
        for (int i = 0; i < (int)rig.fixtures.size(); i++) {
            const int g = rig.fixtures[i].mount.group;
            if (g < 0 || g >= 32 || !((mask >> g) & 1u)) continue;
            const int k = kg[g]++;
            if (k >= first && (k - first) % std::max(every, 1) == 0) r.push_back(i);
        }
        return r;
    }
    std::vector<int> lby_x(std::vector<int> s) const {
        std::stable_sort(s.begin(), s.end(), [&](int a, int b) {
            const vec3 pa = rig.fixtures[a].mount.pos, pb = rig.fixtures[b].mount.pos;
            return pa.x < pb.x - 0.01f || (std::fabs(pa.x - pb.x) <= 0.01f && pa.z < pb.z);
        });
        return s;
    }
    std::vector<int> lby_z(std::vector<int> s) const {
        std::stable_sort(s.begin(), s.end(), [&](int a, int b) { return rig.fixtures[a].mount.pos.z < rig.fixtures[b].mount.pos.z; });
        return s;
    }
    template <typename F> void lsetup(const std::vector<int>& s, F fn) {
        const int n = (int)s.size();
        for (int k = 0; k < n; k++) {
            Fixture& f = rig.fixtures[(size_t)s[k]];
            f.base.dimmer = 1;
            fn(f.base, k, n, f);
        }
    }
    Effect* lfx(const std::vector<int>& s, int type, float size, float speed, float spread = 360, int wave = -1, float duty = -1,
                int wings = 1, float phase0 = 0) {
        if (s.empty()) return nullptr;
        const bool can_stay = type == FX_FAN || type == FX_RAINBOW || type == FX_PALETTE;
        if (speed <= 0.0f && !can_stay) return nullptr;
        if (size == 0.0f && type != FX_PALETTE) return nullptr;
        rig.add_effect(type);
        Effect& ef = rig.effects.back();
        ef.fixtures = s;
        ef.size = size;
        ef.speed = std::max(speed, 0.0f);
        ef.spread = spread;
        ef.wings = wings;
        if (wave >= 0) ef.wave = wave;
        if (duty >= 0) ef.duty = duty;
        ef.phase = (float)std::fmod(beats / (double)bhz * (double)ef.speed, 4096.0) + phase0;
        return &ef;
    }
    void lpaint(const std::vector<int>& s, int mode, int first = 0) {
        const int n = (int)s.size(), N = ncol();
        int groups[32], ng = 0;
        for (int g = 0; g < 32; g++) groups[g] = -1;
        for (int k = 0; k < n; k++) {
            const int i = s[k];
            Fixture& f = rig.fixtures[(size_t)i];
            int m = mode == P_GRAD ? P_ONE : mode;
            if (rainbow && m == P_ONE) m = P_BLOCK;
            int ci = first;
            switch (m) {
                case P_ALT: ci += k; break;
                case P_BLOCK: ci += n > 0 ? k * N / n : 0; break;
                case P_HALF: ci += 2 * k >= n ? 1 : 0; break;
                case P_GROUP: {
                    const int gr = std::clamp(f.mount.group, 0, 31);
                    if (groups[gr] < 0) groups[gr] = ng++;
                    ci += groups[gr];
                    break;
                }
                case P_RANK: {
                    int r = 0;
                    for (int j = 0; j < i; j++) r += rig.fixtures[(size_t)j].mount.group == f.mount.group ? 1 : 0;
                    ci += r;
                    break;
                }
                case P_RAND: ci += rng.below(N); break;
                default: break;
            }
            lcidx[(size_t)i] = ci;
            f.base.color = col(ci);
        }
    }
    void lcolor_motion(const std::vector<int>& s) {
        if (s.empty() || !soft()) return;
        if (rainbow) {
            lfx(s, FX_RAINBOW, 1, spd(64, 8), 360);
            return;
        }
        const int N = ncol();
        if (N < 2) return;
        const bool step = groove();
        const float per = !step ? 16.0f : (!wild() ? 4.0f : (e >= 0.92f ? 1.0f : 2.0f));
        for (int c = 0; c < N; c++) {
            std::vector<int> sub;
            for (int i : s) if (((lcidx[(size_t)i] % N) + N) % N == c) sub.push_back(i);
            lfx(sub, FX_PALETTE, 1, bhz / (per * (float)N), 0, step ? WAVE_SQUARE : WAVE_SINE, -1, 1, (float)c / (float)N);
        }
    }
    void lpulse(const std::vector<int>& s, float spread, int wings = 1) {
        if (s.empty() || !soft()) return;
        if (!groove()) lfx(s, FX_DIMMER_CHASE, 0.2f + 0.5f * (e - 0.3f), spd(16, 8), spread, WAVE_SINE, -1, wings);
        else if (!wild()) lfx(s, FX_DIMMER_CHASE, 0.7f, bhz / 2, spread, WAVE_SQUARE, 0.5f, wings);   // 30 % entre les temps
        else lfx(s, FX_DIMMER_CHASE, 1, e >= 0.92f ? 2 * bhz : bhz, spread, WAVE_SQUARE, 0.35f, wings);
    }
    // retouches apres setup / lsetup (sans rallumer) : fn(parametres, rang, nombre)
    template <typename F> void edit(const std::vector<int>& s, F fn) {
        const int n = (int)s.size();
        for (int k = 0; k < n; k++) fn(lr.fixtures[(size_t)s[k]].base, k, n);
    }
    template <typename F> void ledit(const std::vector<int>& s, F fn) {
        const int n = (int)s.size();
        for (int k = 0; k < n; k++) fn(rig.fixtures[(size_t)s[k]].base, k, n);
    }
};

// =============================================================================================
//  Outils des lyres
//  (suspendues : tilt 0 vers le bas, < 0 vers le public ; pont : tilt > 0 vers le public ; sol et nez : tilt 0 vers
//  le haut, > 0 vers le public)
// =============================================================================================

// gobos de la roue (GOBO_NAMES)
enum : int { GB_OPEN = 0, GB_POINTS, GB_ETOILE, GB_ANNEAUX, GB_RAYONS, GB_FLEUR, GB_BREAKUP, GB_TRIANGLES, GB_BARRES,
             GB_CERCLE_POINTS, GB_SPIRALE, GB_FEUILLAGE, GB_GALAXIE, GB_CROIX, GB_ANNEAU, GB_HELICE, GB_AIGUILLES, GB_BULLES,
             GB_TRIANGLE, GB_ROSACE, GB_EAU, GB_FLAMMES, GB_VERRE, GB_NUAGES, GB_RUCHE, GB_DAMIER, GB_VAGUES, GB_FENETRE,
             GB_VITRAIL, GB_TOILE, GB_FLOCON, GB_COEUR, GB_LUNE, GB_SOLEIL };
static_assert(GB_SOLEIL == NUM_GOBOS - 1, "gobos des spectacles : voir GOBO_NAMES");

// mise au point : sur le sol pour une lyre suspendue penchee de 'tilt', a 18 m (vers le plafond) pour le sol et le nez
float lyre_focus(const Fixture& f, float tilt) {
    if (f.mount.group >= 5) return 18.0f;
    return clampf((f.mount.pos.y - 0.71f) / std::max(std::cos(tilt * DEG), 0.2f), 1.0f, 80.0f);
}

// Faisceaux serres (sans gobo).
void ly_beams(Prog& g, const std::vector<int>& s, float zoom, float tilt, float level, int paint, int cfirst) {
    g.lsetup(s, [&](FixtureParams& p, int, int, Fixture&) {
        p.zoom = zoom;
        p.tilt = tilt;
        p.dimmer = level;
        p.focus = 25;
    });
    g.lpaint(s, paint, cfirst);
}

// Lavage doux (zoom large, frost).
void ly_wash(Prog& g, const std::vector<int>& s, float zoom, float frost, float tilt, float level, int paint, int cfirst) {
    g.lsetup(s, [&](FixtureParams& p, int, int, Fixture&) {
        p.zoom = zoom;
        p.frost = frost;
        p.tilt = tilt;
        p.dimmer = level;
    });
    g.lpaint(s, paint, cfirst);
}

// Gobo net, au sol (lyres suspendues) ou dans la fumee (sol et nez) ; il tourne avec l'energie, un tour en 'slow' a
// 'fast' temps (0 : fixe), un sur deux en sens contraire si 'alt' ; prisme en option (il tourne dans l'autre sens).
void ly_gobo(Prog& g, const std::vector<int>& s, int gobo, float zoom, float tilt, float level, int paint, int cfirst,
             float slow = 64, float fast = 8, int prism = PRISM_NONE, bool alt = true) {
    const float rot = slow > 0.0f ? g.turn(slow, fast) : 0.0f;
    g.lsetup(s, [&](FixtureParams& p, int k, int, Fixture& f) {
        p.zoom = zoom;
        p.tilt = tilt;
        p.gobo = gobo;
        p.gobo_speed = (alt && (k & 1)) ? -rot : rot;
        p.prism = prism;
        p.prism_speed = prism != PRISM_NONE ? -0.5f * rot : 0.0f;
        p.focus = lyre_focus(f, tilt);
        p.dimmer = level;
    });
    g.lpaint(s, paint, cfirst);
}

// Mouvements des lyres selon l'energie (amplitude 'amp' au maximum ; 'spread' : decalage d'une lyre a l'autre).
enum LyMove { LM_NONE, LM_TILT, LM_PAN, LM_CIRCLE, LM_FIG8, LM_SCISSORS, LM_FAN };
void ly_move(Prog& g, const std::vector<int>& s, int move, float amp, float spread = 360) {
    const int wave = g.groove() ? WAVE_TRIANGLE : WAVE_SINE;
    switch (move) {
        case LM_TILT: g.lfx(s, FX_TILT_WAVE, g.amp(amp), g.spd(32, 4), spread, wave); break;
        case LM_PAN: g.lfx(s, FX_PAN_WAVE, g.amp(amp), g.spd(32, 4), spread, wave); break;
        case LM_CIRCLE: g.lfx(s, FX_CIRCLE, g.amp(amp), g.spd(32, 4), spread); break;
        case LM_FIG8: g.lfx(s, FX_FIGURE8, g.amp(amp), g.spd(32, 4), spread); break;
        case LM_SCISSORS: g.lfx(s, FX_PAN_WAVE, 0.4f * amp + g.amp(0.6f * amp), g.spd(32, 2), 180.0f * (float)s.size(), wave); break;
        case LM_FAN: g.lfx(s, FX_FAN, 0.5f * amp + g.amp(0.5f * amp), g.spd(32, 4), 0, wave); break;   // fixe a energie nulle
        default: break;
    }
}

float half_turns(const std::vector<int>& s) { return 180.0f * (float)s.size(); }   // decalage : un sur deux en opposition

// =============================================================================================
//  Les 30 scenes : lasers et lyres. Couleurs : g.col(0) dominante, puis les accents (dans l'ordre de la scene).
//  Energie : 0 fixe ; soft() effets doux ; groove() rythme sur le temps ; wild() flashs et sauts.
// =============================================================================================

// 1. Aube : une ligne d'horizon ambree, un soleil qui se leve dans la fumee, un ciel lavande
void s_aube(Prog& g) {
    const auto nez = g.sel(NEZ);
    g.setup(nez, [&](LaserParams& p, int, int, LaserFixture&) {
        figure(p, LS_FAN, 56, 0);
        p.tilt = -4.5f;   // a peine au-dessus de l'horizontale
    });
    g.paint(nez, P_ONE, 0);
    std::vector<int> las = nez;
    g.fx(nez, LFX_TILT_WAVE, g.amp(2), g.spd(64, 8), 360);
    if (g.soft()) {
        const auto sol = g.sel(SOL, 2);
        g.setup(sol, [&](LaserParams& p, int, int, LaserFixture&) {
            figure(p, LS_FAN, 50, 0);
            p.tilt = -9;
            p.dimmer = 0.55f;
        });
        g.paint(sol, P_ONE, 1);
        g.fx(sol, LFX_ROLL, g.amp(8), g.spd(64, 8), 180);
        las = join(nez, sol);
    }
    if (g.groove()) g.fx(nez, LFX_TILT_SPREAD, g.amp(6), g.spd(16, 4), 0);
    if (g.wild()) g.pulse(las, 360);

    const auto ls = g.lby_z(g.lsel(SOL));
    ly_gobo(g, ls, GB_SOLEIL, 16, 6, 1, P_ONE, 0, 128, 8);
    g.lfx(ls, FX_FAN, 6 + g.amp(14), g.spd(64, 8), 0);
    g.lfx(ls, FX_TILT_WAVE, g.amp(6), g.spd(64, 8), 0);
    g.lpulse(ls, half_turns(ls));
    ly_wash(g, g.lsel(PONT, 2), 36, 0.6f, 30, 0.3f, P_ONE, 1);
}

// 2. Fenetres : la lumiere du jour entre par de hautes fenetres (gobo fenetre du pont, en biais dans la fumee)
void s_fenetres(Prog& g) {
    const auto pl = g.lsel(PONT, 2);
    ly_gobo(g, pl, GB_FENETRE, 16, 52, 1, P_ONE, 0, 0, 0);   // longs rais de lumiere jusqu'au public
    g.ledit(pl, [](FixtureParams& p, int k, int n) {
        p.pan = 16.0f * centered(k, n);
        p.gobo_angle = 6.0f * centered(k, n);
    });
    g.lfx(pl, FX_PAN_WAVE, g.amp(6), g.spd(128, 16), 0);   // le soleil tourne : les fenetres glissent ensemble
    if (g.soft()) g.lfx(pl, FX_TILT_WAVE, g.amp(4), g.spd(64, 8), 0);
    if (g.groove()) g.lfx(pl, FX_DIMMER_CHASE, 0.6f, g.spd(16, 4), 360, WAVE_SINE);   // des nuages passent
    if (g.wild()) g.lpulse(pl, 360);
    // rais de soleil paralleles depuis les trusses : des fenetres posees au sol, en biais, dans toute la salle
    const auto tr = g.lsel(TRUSS, 6, 2);
    ly_gobo(g, tr, GB_FENETRE, 12, -28, 1, P_ONE, 0, 0, 0, PRISM_NONE, false);
    g.lfx(tr, FX_PAN_WAVE, g.amp(5), g.spd(128, 16), 0);
    if (g.groove()) g.lfx(tr, FX_DIMMER_CHASE, 0.6f, g.spd(16, 4), 720, WAVE_SINE);
    if (g.wild()) g.lpulse(tr, 720);
    // lasers : quelques rayons de poussiere, au-dessus du public
    const auto nez = g.sel(NEZ, 2, 1);
    g.setup(nez, [&](LaserParams& p, int k, int n, LaserFixture&) {
        figure(p, LS_FAN, 0, 1);
        p.tilt = 30;
        p.pan = 20.0f * centered(k, n);
        p.dimmer = 0.12f;
    });
    g.paint(nez, P_ONE, 0);
    g.fx(nez, LFX_PAN_WAVE, g.amp(4), g.spd(64, 8), 360);
    if (g.groove()) g.fx(nez, LFX_SPARKLE, 0.6f, g.bhz / 2, Prog::scatter(nez), -1, 0.8f);
}

// 3. Ocean : un ciel liquide au-dessus des tetes, des reflets d'eau qui dansent au sol
void s_ocean(Prog& g) {
    const auto pont = g.sel(PONT);
    g.setup(pont, [&](LaserParams& p, int, int, LaserFixture&) {
        figure(p, LS_FAN, 52, 0);
        p.tilt = 13.5f;   // 1,5 deg au-dessus de l'horizontale, a 11 m
    });
    g.paint(pont, P_GRAD);
    g.fx(pont, LFX_TILT_WAVE, 0.6f + g.amp(2.5f), g.spd(64, 8), 360);
    if (g.soft()) g.fx(pont, LFX_ROLL, g.amp(7), g.spd(64, 8), 180);
    if (g.groove()) g.fx(pont, LFX_DIMMER_CHASE, 0.5f, g.spd(16, 4), 360, WAVE_SINE, -1, 2);   // la houle roule
    if (g.wild()) g.pulse(pont, 360, 2);
    if (g.groove()) g.color_motion(pont);

    const auto tr = g.lsel(TRUSS, 4, 1);
    ly_gobo(g, tr, GB_EAU, 26, -6, 0.65f, P_ALT, 0, 96, 8);
    g.lfx(tr, FX_CIRCLE, g.amp(5), g.spd(64, 8), 360);
    g.lpulse(tr, Prog::scatter(tr));
    if (g.groove()) g.lcolor_motion(tr);
}

// 4. Aurore boreale : grandes vagues lentes dont les couleurs defilent, nuages au sol ; toujours douce
void s_aurore(Prog& g) {
    const auto pont = g.sel(PONT, 2);
    g.setup(pont, [&](LaserParams& p, int, int, LaserFixture&) {
        figure(p, LS_WAVE, 56, 0);
        p.shape_param = 4 + g.amp(2);
        p.wave_cycles = 1.5f;
        p.wave_speed = g.e <= 0.0f ? 0.0f : 0.04f + 0.2f * g.e;
        p.tilt = 22;
    });
    g.paint(pont, P_ALT);
    for (int i : pont) {
        LaserParams& p = g.lr.fixtures[(size_t)i].base;
        p.gradient = g.ncol() >= 2 ? LG_SCROLL : LG_NONE;   // couleurs 1 et 2 qui defilent le long de la vague
        p.gradient_speed = g.e <= 0.0f ? 0.0f : 0.03f + 0.2f * g.e;
    }
    g.fx(pont, LFX_TILT_WAVE, g.amp(4), g.spd(64, 16), 360);
    if (g.soft()) g.fx(pont, LFX_DIMMER_CHASE, 0.5f, g.spd(32, 8), 720, WAVE_SINE);
    if (g.groove()) g.fx(pont, LFX_ROLL, g.amp(12), g.spd(32, 8), 360);

    const auto tr = g.lsel(TRUSS, 6, 2);
    ly_gobo(g, tr, GB_NUAGES, 36, -10, 0.4f, P_BLOCK, 0, 192, 16);
    g.ledit(tr, [](FixtureParams& p, int, int) { p.frost = 0.15f; });
    g.lfx(tr, FX_TILT_WAVE, g.amp(8), g.spd(64, 16), 360);
    if (g.soft()) g.lcolor_motion(tr);
    if (g.wild()) g.lpulse(tr, 360);
}

// 5. Constellations : un ciel de points laser au-dessus du public, la lune et les etoiles au sol
void s_constellations(Prog& g) {
    const auto pont = g.sel(PONT, 4, 1);
    g.setup(pont, [&](LaserParams& p, int, int, LaserFixture&) {
        figure(p, LS_GRID, 22, 9);
        p.shape_param = 3;
        p.diffraction = 9;
        p.diffraction_angle = 10;
        p.tilt = 14;
        p.roll_speed = g.amp(8);
        p.dimmer = 0.3f;
    });
    g.paint(pont, P_ONE, 0);
    g.fx(pont, LFX_RANDOM, g.amp(4), g.spd(64, 8), 360);
    if (g.groove()) g.fx(pont, LFX_SPARKLE, g.wild() ? 0.45f : 0.65f, g.bhz * (g.wild() ? 2.0f : 1.0f), Prog::scatter(pont), -1, 0.6f);
    else g.pulse(pont, Prog::scatter(pont));
    if (g.wild()) g.fx(pont, LFX_JUMP, 6, g.bhz / 2, Prog::scatter(pont));

    const auto tr = g.lsel(TRUSS, 4, 2);
    ly_gobo(g, tr, GB_LUNE, 24, -8, 0.8f, P_ONE, 1, 256, 32);
    g.lfx(tr, FX_CIRCLE, g.amp(4), g.spd(128, 16), 360);
    const auto pl = g.lsel(PONT, 4, 1);
    ly_gobo(g, pl, GB_GALAXIE, 7, 30, 0.5f, P_ONE, 0, 128, 16);
    g.lfx(pl, FX_PAN_WAVE, g.amp(10), g.spd(64, 8), 360);
    g.lpulse(pl, Prog::scatter(pl));
}

// 6. Glacier : stalactites de traits qui scintillent, flocons au sol, colonnes blanches
void s_glacier(Prog& g) {
    const auto pont = g.sel(PONT);
    g.setup(pont, [&](LaserParams& p, int k, int n, LaserFixture&) {
        figure(p, LS_FAN, 24, 9, 90);
        p.tilt = -16;
        p.pan = 22.0f * centered(k, n);
    });
    g.paint(pont, P_ALT);
    g.fx(pont, LFX_ROLL, g.amp(6), g.spd(64, 8), 360);
    if (g.soft()) g.fx(pont, LFX_TRAIT_CHASE, 0.3f, g.spd(16, 2), 360, WAVE_SAW);
    if (g.groove()) g.fx(pont, LFX_SPARKLE, g.wild() ? 0.5f : 0.7f, g.bhz * (g.wild() ? 2.0f : 1.0f), Prog::scatter(pont), -1, 0.7f);
    if (g.wild()) g.fx(pont, LFX_JUMP, 5, g.bhz / 2, Prog::scatter(pont));

    const auto tr = g.lsel(TRUSS, 3, 1);
    ly_gobo(g, tr, GB_FLOCON, 18, -6, 0.75f, P_ALT, 1, 64, 4);
    g.lfx(tr, FX_CIRCLE, g.amp(4), g.spd(64, 8), 360);
    g.lpulse(tr, Prog::scatter(tr));
    if (g.soft()) g.lcolor_motion(tr);
    ly_beams(g, g.lsel(PONT, 2, 1), 2.5f, 8, 0.8f, P_ONE, 0);   // colonnes presque verticales
}

// 7. Cathedrale de verre : arches de traits dores, vitraux colores dans la fumee
void s_cathedrale(Prog& g) {
    const auto pont = g.sel(PONT, 2), sol = g.sel(SOL);
    g.setup(pont, [&](LaserParams& p, int k, int n, LaserFixture&) {
        figure(p, LS_FAN, 40, 0, 90);   // nappes verticales : les arches
        p.tilt = 24;
        p.pan = 26.0f * centered(k, n);
    });
    g.setup(sol, [&](LaserParams& p, int k, int n, LaserFixture&) {
        figure(p, LS_FAN, 46, 12, 90);
        p.tilt = 22;
        p.pan = -22.0f * centered(k, n);
    });
    const auto all = join(pont, sol);
    g.paint(all, P_ONE, 2);
    g.fx(all, LFX_ROLL, g.amp(10), g.spd(64, 8), 360);
    if (g.soft()) g.fx(all, LFX_TRAIT_CHASE, 0.3f, g.spd(16, 2), 90, WAVE_SAW);   // la lumiere monte le long des arches
    if (g.groove()) g.fx(sol, LFX_SPREAD, g.amp(12), g.spd(16, 4), 0);
    if (g.wild()) g.pulse(all, 360, 2);

    const auto ls = g.lby_z(g.lsel(SOL)), lp = g.lsel(PONT, 2, 1);
    ly_gobo(g, ls, GB_VITRAIL, 18, 16, 1, P_ALT, 0, 0, 0);
    g.lfx(ls, FX_FAN, 10 + g.amp(8), g.spd(64, 8), 0);
    ly_gobo(g, lp, GB_VITRAIL, 20, 40, 1, P_ALT, 1, 0, 0);
    g.ledit(lp, [](FixtureParams& p, int k, int n) { p.pan = 18.0f * centered(k, n); });
    const auto ly = join(ls, lp);
    g.lpulse(ly, 360);
    if (g.groove()) g.lcolor_motion(ly);
}

// 8. Desert : une ligne d'horizon brulante qui tremble, des dunes bleu nuit, les rayons rasants du couchant
void s_desert(Prog& g) {
    const auto nez = g.sel(NEZ);
    g.setup(nez, [&](LaserParams& p, int, int, LaserFixture&) {
        figure(p, LS_FAN, 58, 0);
        p.tilt = -4;
    });
    g.paint(nez, P_ONE, 0);
    g.fx(nez, LFX_TILT_WAVE, g.amp(1.5f), g.spd(64, 8), 360);   // la chaleur fait trembler l'horizon
    if (g.soft()) g.fx(nez, LFX_ROLL, g.amp(4), g.spd(32, 8), 360);
    if (g.groove()) g.fx(nez, LFX_TILT_SPREAD, g.amp(8), g.spd(16, 4), 0);   // les couches se separent
    if (g.wild()) g.pulse(nez, 360);

    const auto tr = g.lsel(TRUSS, 4);
    ly_gobo(g, tr, GB_VAGUES, 30, -12, 0.45f, P_ONE, 1, 256, 32);
    g.ledit(tr, [](FixtureParams& p, int, int) { p.frost = 0.25f; });
    g.lfx(tr, FX_TILT_WAVE, g.amp(6), g.spd(64, 16), 360);
    const auto pl = g.lsel(PONT, 4, 1);
    ly_beams(g, pl, 3, 72, 1, P_ONE, 0);
    g.ledit(pl, [](FixtureParams& p, int k, int n) { p.pan = 25.0f * centered(k, n); });
    g.lfx(pl, FX_PAN_WAVE, g.amp(10), g.spd(64, 4), 180, g.groove() ? WAVE_TRIANGLE : WAVE_SINE);
    g.lpulse(pl, 360);
}

// 9. Jungle : feuillages au sol, canopee de vagues vertes, rayons de soleil qui percent
void s_jungle(Prog& g) {
    const auto tr = g.lsel(TRUSS, 3);
    ly_gobo(g, tr, GB_FEUILLAGE, 24, -6, 0.7f, P_ALT, 0, 96, 8);
    g.lfx(tr, FX_CIRCLE, g.amp(5), g.spd(64, 8), 360);   // les feuilles se balancent
    g.lpulse(tr, Prog::scatter(tr));

    const auto nez = g.sel(NEZ);
    const float wv = g.e <= 0.0f ? 0.0f : g.bhz / g.cycle_beats(16, 2);
    g.setup(nez, [&](LaserParams& p, int, int, LaserFixture&) {
        figure(p, LS_WAVE, 50, 0);
        p.shape_param = 2 + g.amp(2.5f);
        p.wave_cycles = 2.5f;
        p.wave_speed = wv;
        p.tilt = 2;
    });
    g.paint(nez, P_GRAD, 0);
    const auto rays = g.sel(TRUSS, 6, 3);
    g.setup(rays, [&](LaserParams& p, int, int, LaserFixture&) {
        figure(p, LS_FAN, 0, 1);
        p.tilt = -25 + g.rng.range(-5, 5);
        p.pan = g.rng.range(-8, 8);
        p.dimmer = 0.55f;
    });
    g.paint(rays, P_ONE, 2);
    g.fx(rays, LFX_RANDOM, g.amp(3), g.spd(64, 8), 360);
    if (g.soft()) g.fx(nez, LFX_TRAIT_CHASE, 0.3f, g.spd(16, 2), 360, WAVE_SAW);
    if (g.groove()) g.fx(rays, LFX_SPARKLE, g.wild() ? 0.4f : 0.6f, g.bhz, Prog::scatter(rays), -1, 0.7f);
    if (g.wild()) g.pulse(nez, 360);
}

// 10. Bulles : des cercles laser qui flottent, respirent et eclatent ; des bulles au sol
void s_bulles(Prog& g) {
    const auto pont = g.sel(PONT, 2);
    g.setup(pont, [&](LaserParams& p, int k, int, LaserFixture&) {
        figure(p, LS_CONE, 5 + 3.0f * (float)(k % 3), 0);
        p.tilt = 6 + g.rng.range(-3, 6);
        p.pan = g.rng.range(-18, 18);
    });
    g.paint(pont, P_ALT);
    g.fx(pont, LFX_RANDOM, g.amp(9), g.spd(64, 8), 360);
    if (g.soft()) g.fx(pont, LFX_OPENING, 0.3f, g.spd(16, 4), Prog::scatter(pont));
    if (g.groove()) g.fx(pont, LFX_SPARKLE, g.wild() ? 0.55f : 0.75f, g.bhz, Prog::scatter(pont), -1, 0.8f);
    if (g.wild()) g.fx(pont, LFX_JUMP, 8, g.bhz / 2, Prog::scatter(pont));
    g.color_motion(pont);

    const auto tr = g.lsel(TRUSS, 4, 3);
    ly_gobo(g, tr, GB_BULLES, 22, -8, 0.75f, P_ALT, 1, 64, 8);
    g.lfx(tr, FX_CIRCLE, g.amp(7), g.spd(32, 4), 360);
    g.lpulse(tr, Prog::scatter(tr));
}

// 11. Coeurs : des coeurs laser qui battent sur le temps, des coeurs rouges au sol
void s_coeurs(Prog& g) {
    const auto pont = g.sel(PONT, 4, 1);
    g.setup(pont, [&](LaserParams& p, int k, int n, LaserFixture&) {
        figure(p, LS_HEART, 15, 0);
        p.tilt = 6;
        p.pan = 12.0f * centered(k, n);
        p.diffraction = g.wild() ? 3 : 1;
        p.diffraction_angle = 12;
    });
    g.paint(pont, P_ONE, 0);
    // battement : l'ouverture bat (en douceur, puis sur chaque temps)
    if (g.e > 0.0f) g.fx(pont, LFX_OPENING, 0.12f + 0.2f * g.mv(), g.groove() ? g.bhz : g.spd(8, 2), 0, g.groove() ? WAVE_SQUARE : WAVE_SINE, 0.3f);
    g.fx(pont, LFX_PAN_WAVE, g.amp(6), g.spd(64, 8), 360);
    if (g.soft()) g.fx(pont, LFX_TILT_WAVE, g.amp(3), g.spd(32, 8), 180);
    if (g.wild()) g.fx(pont, LFX_ROLL, 12, g.bhz / 2, 360);

    const auto tr = g.lsel(TRUSS, 4, 1);
    ly_gobo(g, tr, GB_COEUR, 20, -8, 0.8f, P_ONE, 1, 128, 16, PRISM_NONE, false);
    g.lfx(tr, FX_CIRCLE, g.amp(4), g.spd(64, 8), 360);
    if (g.groove()) g.lfx(tr, FX_DIMMER_CHASE, 0.6f, g.bhz, 0, WAVE_SQUARE, 0.3f);
    else g.lpulse(tr, 360);
    ly_wash(g, g.lsel(PONT, 2), 34, 0.6f, 30, 0.3f, P_ONE, 0);
}

// 12. Pluie d'or : une averse de faisceaux dores, des soleils d'aiguilles dans la fumee
void s_pluie(Prog& g) {
    const auto tr = g.sel(TRUSS, 2, g.rng.below(2));
    g.setup(tr, [&](LaserParams& p, int, int, LaserFixture&) {
        figure(p, LS_FAN, 0, 1);
        p.tilt = -25 + g.rng.range(-5, 5);
        p.pan = g.rng.range(-7, 7);
        p.dimmer = 0.8f;
    });
    g.paint(tr, P_ONE, 0);
    g.fx(tr, LFX_RANDOM, g.amp(3), g.spd(32, 8), 360);
    if (g.groove()) g.fx(tr, LFX_SPARKLE, g.wild() ? 0.3f : 0.5f, g.bhz * (g.wild() ? 4.0f : 2.0f), Prog::scatter(tr), -1, 0.6f);
    else g.pulse(tr, Prog::scatter(tr));

    const auto pl = g.lsel(PONT);
    ly_gobo(g, pl, GB_AIGUILLES, 9, 34, 0.9f, P_ONE, 1, 64, 4);
    g.ledit(pl, [](FixtureParams& p, int k, int n) { p.pan = 20.0f * centered(k, n); });
    g.lfx(pl, FX_TILT_WAVE, g.amp(8), g.spd(32, 4), 360);
    g.lpulse(pl, half_turns(pl));
}

// 13. Ruche doree : alveoles ambrees au sol, des abeilles laser qui butinent
void s_ruche(Prog& g) {
    const auto tr = g.lsel(TRUSS, 3, 2);
    ly_gobo(g, tr, GB_RUCHE, 26, -6, 0.75f, P_ONE, 0, 128, 16);
    g.lfx(tr, FX_CIRCLE, g.amp(3), g.spd(64, 8), 360);
    if (g.groove()) g.lfx(tr, FX_DIMMER_CHASE, 0.5f, g.bhz / 2, 1440, WAVE_SINE);   // des ondes traversent la ruche
    else g.lpulse(tr, 1440);
    const auto pl = g.lsel(PONT, 2);
    ly_beams(g, pl, 3, 40, 0.8f, P_ONE, 1);
    ly_move(g, pl, LM_FIG8, 16);
    g.lpulse(pl, 360);

    const auto bees = g.sel(TRUSS, 7, 2);
    g.setup(bees, [&](LaserParams& p, int, int, LaserFixture&) {
        figure(p, LS_FAN, 7, 4, g.rng.range(0, 180));
        p.tilt = -22 + g.rng.range(-6, 6);
        p.pan = g.rng.range(-12, 12);
    });
    g.paint(bees, P_ONE, 1);
    g.fx(bees, LFX_RANDOM, 2 + g.amp(12), g.spd(16, 2), 360);
    if (g.soft()) g.fx(bees, LFX_ROLL, g.amp(30), g.spd(8, 1), Prog::scatter(bees));
    if (g.groove()) g.fx(bees, LFX_SPARKLE, g.wild() ? 0.45f : 0.65f, 2 * g.bhz, Prog::scatter(bees), -1, 0.7f);
}

// 14. Feu sacre : des flammes laser qui montent du nez de scene, des flammes au sol et dans la fumee
void s_feu(Prog& g) {
    const auto nez = g.by_z(g.sel(NEZ));
    const float wv = g.e <= 0.0f ? 0.0f : g.bhz / g.cycle_beats(8, 1);
    g.setup(nez, [&](LaserParams& p, int k, int n, LaserFixture&) {
        figure(p, LS_WAVE, 34, 0, 90);   // vagues verticales : des langues de feu
        p.shape_param = 3 + g.amp(3);
        p.wave_cycles = 3;
        p.wave_speed = wv;
        p.tilt = 12;
        p.pan = 16.0f * centered(k, n);
    });
    g.paint(nez, P_GRAD, 0);
    g.fx(nez, LFX_ROLL, g.amp(6), g.spd(32, 4), Prog::scatter(nez));
    if (g.soft()) g.fx(nez, LFX_DIMMER_CHASE, 0.35f, g.spd(4, 1), Prog::scatter(nez), WAVE_SINE);   // les flammes vacillent
    if (g.groove()) g.fx(nez, LFX_OPENING, 0.3f, g.bhz / 2, half_turns(nez), WAVE_SINE);
    if (g.wild()) g.fx(nez, LFX_SPARKLE, 0.6f, 2 * g.bhz, Prog::scatter(nez), -1, 0.7f);

    const auto tr = g.lsel(TRUSS, 3);
    ly_gobo(g, tr, GB_FLAMMES, 22, -6, 0.75f, P_ALT, 0, 96, 8);
    g.lfx(tr, FX_DIMMER_CHASE, 0.25f + 0.3f * g.mv(), g.spd(8, 1), Prog::scatter(tr), WAVE_SINE);
    const auto ls = g.lby_z(g.lsel(SOL));
    ly_gobo(g, ls, GB_FLAMMES, 12, 6, 1, P_ALT, 1, 32, 4);
    g.lfx(ls, FX_FAN, 8 + g.amp(10), g.spd(32, 4), 0);
    if (g.groove()) g.lpulse(ls, half_turns(ls));
}

// 15. Monolithe : une seule couleur ; une lame horizontale qui balaie, une foret de colonnes immobiles
void s_monolithe(Prog& g) {
    const auto nez = g.sel(NEZ);
    g.setup(nez, [&](LaserParams& p, int, int, LaserFixture&) {
        figure(p, LS_FAN, 58, 0);
        p.tilt = -2;
    });
    g.paint(nez, P_ONE, 0);
    g.fx(nez, LFX_TILT_WAVE, g.amp(8), g.spd(32, 2), 0, g.groove() ? WAVE_TRIANGLE : WAVE_SINE);   // la lame balaie la salle
    if (g.wild()) g.pulse(nez, 0);

    const auto pl = g.lsel(PONT, 2);
    ly_beams(g, pl, 2.5f, 0, 1, P_ONE, 0);   // colonnes verticales devant la scene
    if (g.soft()) g.lfx(pl, FX_TILT_WAVE, g.amp(10), g.spd(32, 4), 0);
    const auto tr = g.lby_x(g.lsel(TRUSS, 7, 3));
    ly_beams(g, tr, 2, 0, 0.6f, P_ONE, 0);   // la foret de colonnes dans la salle
    if (g.groove()) {
        g.lfx(tr, FX_DIMMER_CHASE, 1, g.bhz / 2, 720, WAVE_SQUARE, 0.3f);   // une vague de la scene vers le fond
        g.lfx(pl, FX_DIMMER_CHASE, 1, g.bhz / 2, 360, WAVE_SQUARE, 0.5f);
    } else {
        g.lpulse(tr, 720);
    }
}

// 16. Vert laser : le grand classique en vert pur ; eventails qui balaient, tunnels qui tournent
void s_vert(Prog& g) {
    const auto pont = g.sel(PONT), sol = g.sel(SOL);
    g.setup(pont, [&](LaserParams& p, int, int, LaserFixture&) {
        figure(p, LS_FAN, 46, 14);
        p.tilt = 4;
    });
    g.setup(sol, [&](LaserParams& p, int, int, LaserFixture&) {
        figure(p, LS_CONE, 9, 0);
        p.tilt = 10;
        p.roll_speed = g.turn(16, 2);
        p.dimmer = 0.7f;
    });
    g.paint(join(pont, sol), P_ONE, 0);
    const int wave = g.groove() ? WAVE_TRIANGLE : WAVE_SINE;
    g.fx(pont, LFX_TILT_WAVE, g.amp(8), g.spd(32, 2), 0, wave);
    g.fx(sol, LFX_CIRCLE, g.amp(6), g.spd(32, 4), 360);
    if (g.soft()) g.fx(pont, LFX_TRAIT_CHASE, 0.3f, g.spd(8, 1), 0, WAVE_SAW);
    if (g.groove()) g.fx(sol, LFX_OPENING, 0.4f, g.spd(4, 1), 360);
    if (g.wild()) {
        g.pulse(pont, half_turns(pont));
        g.fx(pont, LFX_JUMP, 6, g.bhz / 2, 0);
    }

    const auto ls = g.lby_z(g.lsel(SOL));
    ly_beams(g, ls, 4, 10, 0.6f, P_ONE, 0);
    ly_move(g, ls, LM_FAN, 24);
    g.lpulse(ls, 360);
}

// 17. Tubes : des faisceaux en tube (gobo anneau) qui tournent en cercle, des tunnels laser blancs
void s_tubes(Prog& g) {
    const auto tr = g.lsel(TRUSS, 4, 2);
    ly_gobo(g, tr, GB_ANNEAU, 5, -16, 1, P_ONE, 0, 0, 0);
    ly_move(g, tr, LM_CIRCLE, 12, 360);
    g.lpulse(tr, 1440);
    if (g.groove()) g.lfx(tr, FX_ZOOM_PULSE, 0.35f, g.bhz / 2, 0, WAVE_SINE);

    const auto pont = g.sel(PONT, 3, 1);
    g.setup(pont, [&](LaserParams& p, int, int, LaserFixture&) {
        figure(p, LS_CONE, 12, 0);
        p.tilt = 5;
        p.roll_speed = g.turn(32, 2);
    });
    g.paint(pont, P_ONE, 1);
    g.fx(pont, LFX_CIRCLE, g.amp(3), g.spd(32, 8), 360);
    if (g.soft()) g.fx(pont, LFX_OPENING, 0.35f, g.spd(16, 2), 360);
    if (g.groove()) g.fx(pont, LFX_TRAIT_CHASE, 0.25f, g.spd(4, 1), 0, WAVE_SAW);
    if (g.wild()) g.pulse(pont, half_turns(pont));
}

// 18. Helices : des helices qui tournent dans les faisceaux des trusses, doubles eventails laser
void s_helices(Prog& g) {
    const auto tr = g.lsel(TRUSS, 4);
    ly_gobo(g, tr, GB_HELICE, 9, 0, 1, P_ONE, 0, 32, 1);
    g.lfx(tr, FX_TILT_WAVE, g.amp(12), g.spd(32, 4), 720, g.groove() ? WAVE_TRIANGLE : WAVE_SINE);
    g.lpulse(tr, 720);

    const auto pont = g.sel(PONT, 2, 1);
    const float t = g.turn(16, 1);
    g.setup(pont, [&](LaserParams& p, int k, int, LaserFixture&) {
        figure(p, LS_DOUBLE_FAN, 48, 0, 45.0f * (float)k);
        p.shape_param = 8;
        p.tilt = 5;
        p.roll_speed = (k & 1) ? -t : t;
    });
    g.paint(pont, P_ONE, 1);
    if (g.soft()) g.fx(pont, LFX_OPENING, 0.3f, g.spd(16, 4), half_turns(pont));
    if (g.groove()) g.fx(pont, LFX_TILT_WAVE, g.amp(6), g.spd(16, 4), 360);
    if (g.wild()) g.pulse(pont, 0);
}

// 19. Geometrie sacree : triangles, carres, etoiles et cercles qui tournent en orbite ; tubes triangulaires
void s_geometrie(Prog& g) {
    const auto pont = g.sel(PONT, 2);
    static const int SH[4] = {LS_TRIANGLE, LS_SQUARE, LS_STAR, LS_CONE};
    const float t = g.groove() ? 0.0f : g.turn(64, 8);
    g.setup(pont, [&](LaserParams& p, int k, int n, LaserFixture&) {
        figure(p, SH[k % 4], 13, 0);
        p.branches = 5;
        p.tilt = 5;
        p.pan = 24.0f * centered(k, n);
        p.roll_speed = (k & 1) ? -t : t;
    });
    g.paint(pont, P_ALT);
    g.fx(pont, LFX_CIRCLE, 2 + g.amp(5), g.spd(32, 4), 360);   // en orbite (fixe a energie nulle)
    if (g.soft()) g.fx(pont, LFX_OPENING, 0.3f, g.spd(16, 4), half_turns(pont));
    if (g.groove()) {
        // rotation par pas, sens contraires, decalee d'un demi-cycle un laser sur deux
        const float step = g.wild() ? 45.0f : 30.0f, sp = g.bhz / (g.wild() ? 1.0f : 2.0f);
        g.fx(Prog::alt(pont, 0), LFX_ROLL_STEP, step, sp, 0);
        g.fx(Prog::alt(pont, 1), LFX_ROLL_STEP, -step, sp, 0, -1, -1, 1, 0.5f);
        g.color_motion(pont);
    }
    if (g.wild()) g.fx(pont, LFX_JUMP, 6, g.bhz / 2, Prog::scatter(pont));

    const auto tr = g.lsel(TRUSS, 6, 3);
    ly_gobo(g, tr, GB_TRIANGLE, 5, -15, 1, P_ALT, 0, 32, 4);
    ly_move(g, tr, LM_FIG8, 14, 360);
    g.lpulse(tr, 360);
}

// 20. Mandala : quatre etoiles concentriques qui tournent en sens contraires, rosaces et prismes dans la fumee
void s_mandala(Prog& g) {
    const auto pont = g.sel(PONT, 4, 1);
    static const int BR[4] = {6, 8, 10, 12};
    const float t = g.turn(64, 4);
    g.setup(pont, [&](LaserParams& p, int k, int, LaserFixture&) {
        figure(p, LS_STAR, 8 + 5.0f * (float)k, 0, 15.0f * (float)k);
        p.branches = BR[k % 4];
        p.roll_speed = (k & 1) ? -t : t;
    });
    g.paint(pont, P_ALT);
    if (Effect* c = g.fx(pont, LFX_CONVERGE, g.amp(1.2f), g.spd(64, 8), 0)) c->color_a = {-10, 7, 0};   // toutes au meme centre
    if (g.soft()) g.fx(pont, LFX_OPENING, 0.25f, g.spd(16, 4), 360);
    if (g.groove()) g.fx(pont, LFX_TRAIT_CHASE, 0.3f, g.spd(4, 1), 360, WAVE_SAW);
    if (g.wild()) g.pulse(pont, half_turns(pont));

    const auto ls = g.lby_z(g.lsel(SOL)), ln = g.lby_z(g.lsel(NEZ));
    ly_gobo(g, ls, GB_ROSACE, 14, 6, 0.9f, P_ALT, 0, 64, 4, PRISM_6);
    ly_gobo(g, ln, GB_ROSACE, 10, 14, 0.7f, P_ALT, 1, 64, 4);
    const auto ly = join(ls, ln);
    g.lfx(ly, FX_FAN, 10 + g.amp(10), g.spd(64, 8), 0);
    g.lpulse(ly, 360);
    if (g.groove()) g.lcolor_motion(ly);
}

// 21. Kaleidoscope : une etoile de plans laser qui passent tous par un point, spirales et prismes au sol
void s_kaleidoscope(Prog& g) {
    const auto pont = g.sel(PONT);
    const float t = g.turn(64, 4);
    g.setup(pont, [&](LaserParams& p, int k, int n, LaserFixture&) {
        figure(p, LS_FAN, 30, 0, 180.0f * (float)k / (float)n);
        p.roll_speed = (g.wild() && (k & 1)) ? -t : t;
    });
    g.paint(pont, P_ALT);
    if (Effect* c = g.fx(pont, LFX_CONVERGE, g.amp(2), g.spd(64, 8), 0)) c->color_a = {-8, 6, 0};
    if (g.soft()) g.fx(pont, LFX_OPENING, 0.35f, g.spd(16, 4), 360);
    if (g.groove()) {
        g.pulse(pont, 360);
        g.color_motion(pont);
    }

    const auto tr = g.lsel(TRUSS, 4, 1);
    ly_gobo(g, tr, GB_SPIRALE, 20, -6, 0.7f, P_RANK, 0, 32, 2, g.groove() ? PRISM_3 : PRISM_NONE);
    g.lfx(tr, FX_CIRCLE, g.amp(6), g.spd(32, 4), 360);
    g.lpulse(tr, Prog::scatter(tr));
}

// 22. Neon : une grille synthwave, lignes d'horizon cyan et lames roses ; faisceaux roses en huit
void s_neon(Prog& g) {
    const auto nez = g.sel(NEZ), pont = g.sel(PONT, 2);
    g.setup(nez, [&](LaserParams& p, int k, int, LaserFixture&) {
        figure(p, LS_FAN, 56, 0);
        p.tilt = -4.0f + 2.5f * (float)(k % 4);   // 4 lignes empilees au-dessus de l'horizon
    });
    g.setup(pont, [&](LaserParams& p, int k, int n, LaserFixture&) {
        figure(p, LS_FAN, 30, 0, 90);   // lames verticales
        p.tilt = 2;
        p.pan = 26.0f * centered(k, n);
    });
    g.paint(nez, P_ONE, 1);
    g.paint(pont, P_ONE, 0);
    g.fx(nez, LFX_TILT_WAVE, g.amp(2), g.spd(32, 4), 360);
    if (g.soft()) g.fx(pont, LFX_MIRROR, g.amp(10), g.spd(32, 4), 0);
    if (g.groove()) g.fx(nez, LFX_DIMMER_CHASE, 1, g.bhz / 2, 360, WAVE_SQUARE, 0.5f);   // les lignes defilent
    if (g.wild()) g.pulse(pont, half_turns(pont));

    const auto tr = g.lsel(TRUSS, 6, 1);
    ly_beams(g, tr, 2.5f, -20, 0.9f, P_ALT, 0);
    ly_move(g, tr, LM_FIG8, 18, 720);
    g.lpulse(tr, 720);
}

// 23. Op art : damiers blancs qui tournent au sol, rideaux de traits rouges qui se croisent
void s_opart(Prog& g) {
    const auto tr = g.lsel(TRUSS, 3);
    ly_gobo(g, tr, GB_DAMIER, 24, -6, 0.85f, P_ONE, 0, 32, 4);
    g.lfx(tr, FX_CIRCLE, g.amp(4), g.spd(32, 8), 360);
    if (g.groove()) g.lfx(tr, FX_DIMMER_CHASE, 1, g.bhz, half_turns(tr), WAVE_SQUARE, 0.5f);   // un sur deux
    else g.lpulse(tr, 1440);

    const auto las = g.sel(TRUSS, 6, 1);
    g.setup(las, [&](LaserParams& p, int, int, LaserFixture&) {
        figure(p, LS_FAN, 22, 10);
        p.tilt = -25;
    });
    g.paint(las, P_ONE, 1);
    g.fx(las, LFX_SCISSORS, 4 + g.amp(10), g.spd(32, 4), 0);
    if (g.soft()) g.fx(las, LFX_ROLL, g.amp(30), g.spd(32, 4), 720);
    if (g.groove()) g.pulse(las, half_turns(las));
}

// 24. Toile d'araignee : filets de traits verts qui se croisent, toiles violettes au sol
void s_toile(Prog& g) {
    const auto pont = g.sel(PONT), nez = g.sel(NEZ);
    g.setup(pont, [&](LaserParams& p, int k, int n, LaserFixture&) {
        figure(p, LS_FAN, 36, 8, 90);
        p.tilt = -14;
        p.pan = 18.0f * centered(k, n);
    });
    g.setup(nez, [&](LaserParams& p, int k, int n, LaserFixture&) {
        figure(p, LS_FAN, 36, 8, 90);
        p.tilt = 18;
        p.pan = -18.0f * centered(k, n);
    });
    const auto all = join(pont, nez);
    g.paint(all, P_ONE, 0);
    g.fx(all, LFX_ROLL, g.amp(20), g.spd(64, 8), 360);
    if (g.soft()) g.fx(all, LFX_SCISSORS, g.amp(10), g.spd(32, 4), 0);
    if (g.groove()) g.fx(all, LFX_TRAIT_CHASE, 0.35f, g.spd(4, 1), half_turns(all), WAVE_SAW);
    if (g.wild()) g.pulse(all, half_turns(all));

    const auto tr = g.lsel(TRUSS, 4, 3);
    ly_gobo(g, tr, GB_TOILE, 24, -8, 0.75f, P_ONE, 1, 128, 8);
    g.lfx(tr, FX_CIRCLE, g.amp(4), g.spd(64, 8), 360);
    g.lpulse(tr, Prog::scatter(tr));
}

// 25. Matrice : des faisceaux de traits en grille 4 x 4 qui tombent des trusses ; des vagues les parcourent
void s_matrice(Prog& g) {
    const auto tr = g.by_x(g.sel(TRUSS, 6, 3));
    g.setup(tr, [&](LaserParams& p, int, int, LaserFixture&) {
        figure(p, LS_GRID, 10, 16);
        p.shape_param = 4;
        p.tilt = -25;
        p.dimmer = 0.8f;
    });
    g.paint(tr, P_ONE, 0);
    g.fx(tr, LFX_TILT_WAVE, g.amp(10), g.spd(32, 4), 720);   // des vagues de la scene vers le fond
    if (g.soft()) g.fx(tr, LFX_ROLL, g.amp(45), g.spd(32, 8), 360);
    if (g.groove()) g.fx(tr, LFX_BOUNCE, 0.2f, g.spd(16, 2), 0, WAVE_SQUARE);
    if (g.wild()) g.fx(tr, LFX_JUMP, 8, g.bhz, Prog::scatter(tr));

    const auto pl = g.lsel(PONT, 2);
    ly_beams(g, pl, 2, 45, 0.9f, P_ONE, 1);
    ly_move(g, pl, LM_SCISSORS, 20);
    g.lpulse(pl, half_turns(pl));
}

// 26. Vortex : tunnels doubles qui tournent en sens contraires, spirales qui tournoient dans la fumee
void s_vortex(Prog& g) {
    const auto pont = g.sel(PONT, 4, 1);
    const float t = g.turn(32, 2);
    g.setup(pont, [&](LaserParams& p, int k, int, LaserFixture&) {
        figure(p, LS_TUNNEL, 16, 0);
        p.tilt = 5;
        p.roll_speed = (k & 1) ? -t : t;
        p.diffraction = g.wild() ? 3 : 1;
        p.diffraction_angle = 11;
    });
    g.paint(pont, P_GRAD);
    g.fx(pont, LFX_CIRCLE, g.amp(4), g.spd(32, 4), 180);
    if (g.soft()) g.fx(pont, LFX_OPENING, 0.3f, g.spd(16, 4), 0);
    if (g.groove()) g.fx(pont, LFX_TRAIT_CHASE, 0.3f, g.spd(4, 1), half_turns(pont), WAVE_SAW);
    if (g.wild()) g.pulse(pont, 0);

    const auto tr = g.lsel(TRUSS, 4);
    ly_gobo(g, tr, GB_SPIRALE, 8, -12, 1, P_ONE, 1, 16, 1);
    ly_move(g, tr, LM_CIRCLE, 10, 720);
    g.lpulse(tr, 720);
}

// 27. Eclats : du verre brise au sol, des eclats de laser projetes dans tous les sens
void s_eclats(Prog& g) {
    const auto tr = g.lsel(TRUSS, 4, 1);
    ly_gobo(g, tr, GB_VERRE, 24, -6, 0.8f, P_ONE, 0, 0, 0);
    g.ledit(tr, [&](FixtureParams& p, int, int) { p.gobo_angle = g.rng.range(0, 360); });
    if (g.groove()) g.lfx(tr, FX_DIMMER_CHASE, 1, g.bhz * (g.wild() ? 2.0f : 1.0f), Prog::scatter(tr), WAVE_SQUARE, 0.35f);
    else g.lpulse(tr, Prog::scatter(tr));

    const auto pont = g.sel(PONT), las = g.sel(TRUSS, 8, g.rng.below(8));
    g.setup(pont, [&](LaserParams& p, int, int, LaserFixture&) {
        figure(p, LS_FAN, 16, 5, g.rng.range(-40, 40));
        p.tilt = g.rng.range(0, 14);
        p.pan = g.rng.range(-15, 15);
    });
    g.setup(las, [&](LaserParams& p, int, int, LaserFixture&) {
        figure(p, LS_FAN, 0, 1);
        p.tilt = -25 + g.rng.range(-10, 10);
        p.pan = g.rng.range(-12, 12);
    });
    g.paint(pont, P_ONE, 1);
    g.paint(las, P_ONE, 0);
    const auto all = join(pont, las);
    const float sc = Prog::scatter(all);
    g.fx(all, LFX_RANDOM, g.amp(10), g.spd(16, 2), 360);
    if (g.groove()) {
        g.fx(all, LFX_SPARKLE, g.wild() ? 0.3f : 0.45f, g.bhz * (g.wild() ? 4.0f : 2.0f), sc, -1, 0.5f);
        g.fx(all, LFX_JUMP, g.amp(14), g.bhz / (g.wild() ? 1.0f : 2.0f), sc);
    } else if (g.soft()) {
        g.fx(all, LFX_DIMMER_CHASE, 0.6f, g.spd(8, 2), sc, WAVE_SINE);
    }
}

// 28. Tempete : des nuages violets au sol, des eclairs blancs des lyres et des lasers
void s_tempete(Prog& g) {
    const auto tr = g.lsel(TRUSS, 3, 1);
    ly_gobo(g, tr, GB_NUAGES, 34, -10, 0.65f, P_ONE, 0, 256, 32);
    g.lfx(tr, FX_TILT_WAVE, g.amp(8), g.spd(64, 8), 360);

    // eclairs : faisceaux blancs du pont dans tous les sens, de rares eclats qui deviennent un orage
    const auto pl = g.lsel(PONT);
    ly_beams(g, pl, 3, 30, g.e <= 0.0f ? 0.25f : 1.0f, P_ONE, 1);
    g.ledit(pl, [&](FixtureParams& p, int, int) {
        p.pan = g.rng.range(-35, 35);
        p.tilt = g.rng.range(15, 55);
    });
    if (g.e > 0.0f) g.lfx(pl, FX_DIMMER_CHASE, 1, g.spd(8, 1), Prog::scatter(pl), WAVE_SQUARE, 0.06f + 0.12f * g.e);
    if (g.wild()) g.ledit(pl, [](FixtureParams& p, int k, int) { if (k % 3 == 0) p.strobe = 14; });

    const auto las = g.sel(TRUSS, 6, g.rng.below(6));
    g.setup(las, [&](LaserParams& p, int, int, LaserFixture&) {
        figure(p, LS_FAN, 0, 1);
        p.tilt = -25 + g.rng.range(-12, 12);
        p.pan = g.rng.range(-15, 15);
        p.dimmer = g.e <= 0.0f ? 0.3f : 1.0f;
    });
    g.paint(las, P_ONE, 1);
    if (g.soft()) g.fx(las, LFX_SPARKLE, 0.12f + 0.3f * g.e, g.bhz * (g.groove() ? 4.0f : 1.0f), Prog::scatter(las), -1, 0.3f);
    if (g.wild()) g.fx(las, LFX_JUMP, 12, g.bhz, Prog::scatter(las));
    const auto nez = g.sel(NEZ, 2);
    g.setup(nez, [&](LaserParams& p, int, int, LaserFixture&) {
        figure(p, LS_FAN, 56, 0);
        p.tilt = 20;   // le plafond de nuages
        p.dimmer = 0.9f;
    });
    g.paint(nez, P_ONE, 0);
    g.fx(nez, LFX_TILT_WAVE, g.amp(4), g.spd(64, 8), 360);
}

// 29. Pulsar : tout en blanc ; des lames qui s'ouvrent sur le temps, un eventail de faisceaux qui flashe
void s_pulsar(Prog& g) {
    const auto pl = g.lby_z(g.lsel(PONT));
    ly_beams(g, pl, 2, 30, 1, P_ONE, 0);
    ly_move(g, pl, LM_FAN, 30);
    if (g.groove()) g.lfx(pl, FX_DIMMER_CHASE, 1, g.bhz, g.wild() ? half_turns(pl) : 0.0f, WAVE_SQUARE, 0.3f);
    else g.lpulse(pl, 360);
    if (g.wild()) g.ledit(pl, [](FixtureParams& p, int k, int) { if (k % 4 == 0) p.strobe = 12; });

    const auto pont = g.sel(PONT, 2);
    g.setup(pont, [&](LaserParams& p, int, int, LaserFixture&) {
        figure(p, LS_FAN, 40, 0);
        p.tilt = 6;
    });
    g.paint(pont, P_ONE, 0);
    g.fx(pont, LFX_OPENING, 0.2f + 0.5f * g.mv(), g.spd(16, 1), 0, g.groove() ? WAVE_SQUARE : WAVE_SINE, 0.5f);
    if (g.soft()) g.fx(pont, LFX_TILT_WAVE, g.amp(4), g.spd(32, 4), 360);
    if (g.wild()) g.fx(pont, LFX_SPARKLE, 0.5f, 2 * g.bhz, Prog::scatter(pont), -1, 0.5f);
}

// 30. Apotheose : tout en meme temps, 4 couleurs ; ciseaux du pont, chenillard des trusses, helices du sol, soleils
void s_apotheose(Prog& g) {
    const auto pont = g.sel(PONT), nez = g.sel(NEZ), sol = g.sel(SOL);
    const auto tr = g.by_x(g.sel(TRUSS, 6, 2));
    g.setup(pont, [&](LaserParams& p, int, int, LaserFixture&) {
        figure(p, LS_FAN, 40, 12);
        p.tilt = 6;
    });
    g.setup(nez, [&](LaserParams& p, int, int, LaserFixture&) {
        figure(p, LS_FAN, 0, 1);
        p.tilt = 12;
    });
    const float t = g.turn(16, 1);
    g.setup(sol, [&](LaserParams& p, int k, int, LaserFixture&) {
        figure(p, LS_DOUBLE_FAN, 44, 0, 45.0f * (float)k);
        p.shape_param = 10;
        p.tilt = 15;
        p.roll_speed = (k & 1) ? -t : t;
    });
    g.setup(tr, [&](LaserParams& p, int, int, LaserFixture&) {
        figure(p, LS_FAN, 0, 1);
        p.tilt = -25;
    });
    g.paint(pont, P_ALT, 0);
    g.paint(nez, P_HALF, 2);
    g.paint(sol, P_ALT, 3);
    g.paint(tr, P_ONE, 1);
    const int wave = g.groove() ? WAVE_TRIANGLE : WAVE_SINE;
    g.fx(pont, LFX_SCISSORS, g.amp(20), g.spd(32, 2), 0, wave);
    g.fx(nez, LFX_MIRROR, g.amp(24), g.spd(32, 2), 0, wave, -1, 1, 0.5f);
    g.fx(tr, LFX_TILT_WAVE, g.amp(10), g.spd(32, 4), 720);
    if (g.soft()) g.fx(pont, LFX_TRAIT_CHASE, 0.3f, g.spd(8, 2), 360, WAVE_SAW);
    if (g.groove()) {
        g.fx(tr, LFX_BOUNCE, 0.15f, g.spd(16, 2), 0, WAVE_SQUARE);
        g.pulse(pont, half_turns(pont));
    }
    if (g.wild()) g.fx(nez, LFX_SPARKLE, 0.5f, 2 * g.bhz, Prog::scatter(nez), -1, 0.6f);

    const auto ls = g.lby_z(g.lsel(SOL));
    ly_gobo(g, ls, GB_AIGUILLES, 12, 8, 1, P_ONE, 0, 32, 2, PRISM_3);
    g.lfx(ls, FX_FAN, 10 + g.amp(12), g.spd(32, 4), 0);
    const auto lt = g.lsel(TRUSS, 4, 2);
    ly_beams(g, lt, 3, -15, 0.9f, P_ALT, 0);
    ly_move(g, lt, LM_CIRCLE, 14, 720);
    const auto lp = g.lsel(PONT, 2);
    ly_beams(g, lp, 3, 55, 1, P_ALT, 2);
    ly_move(g, lp, LM_SCISSORS, 22);
    const auto ly = join(join(ls, lt), lp);
    g.lpulse(ly, 360);
    if (g.groove()) g.lcolor_motion(lt);
}

using SceneFn = void (*)(Prog&);
const SceneFn SCENE_FN[SPECTACLE_SCENES] = {
    s_aube, s_fenetres, s_ocean, s_aurore, s_constellations, s_glacier, s_cathedrale, s_desert, s_jungle, s_bulles,
    s_coeurs, s_pluie, s_ruche, s_feu, s_monolithe, s_vert, s_tubes, s_helices, s_geometrie, s_mandala,
    s_kaleidoscope, s_neon, s_opart, s_toile, s_matrice, s_vortex, s_eclats, s_tempete, s_pulsar, s_apotheose};

// Tirage de n couleurs qui vont ensemble : une association de la liste (une fois sur deux), sinon une harmonie de la
// roue des teintes (complementaires, voisines, triade, carre...), parfois avec du blanc.
void draw_colors(uint32_t seed, int n, std::vector<vec3>& out, std::string& label) {
    Rng r(seed ^ 0x9e3779b9u);
    n = std::clamp(n, 1, SPECTACLE_MAX_COLORS);
    out.clear();
    if (n >= 2 && r.uni() < 0.5f) {
        int cand[256], nc = 0;
        for (int i = 0; i < SPECTACLE_PALETTE_COUNT && nc < 256; i++)
            if (SPECTACLE_PALETTES[i].n == n) cand[nc++] = i;
        if (nc > 0) {
            const SpectaclePalette& p = SPECTACLE_PALETTES[cand[r.below(nc)]];
            out.assign(p.c, p.c + n);
            label = std::string("au hasard : ") + p.name;
            return;
        }
    }
    auto W = [](int i) { return WHEEL[((i % 12) + 12) % 12]; };
    const int h = r.below(12);
    if (n == 1) {
        // une couleur vive de la bibliotheque (pas les blancs)
        int i;
        do i = r.below(SPECTACLE_COLOR_COUNT); while (SPECTACLE_COLORS[i].family == SPECTACLE_COLOR_FAMILY_COUNT - 1);
        out = {SPECTACLE_COLORS[i].c};
        label = std::string("au hasard : ") + SPECTACLE_COLORS[i].name;
    } else if (n == 2) {
        const int t = r.below(3);
        if (t == 0) { out = {W(h), W(h + 6)}; label = "au hasard : complementaires"; }
        else if (t == 1) { out = {W(h), W(h + (r.uni() < 0.5f ? 2 : 3))}; label = "au hasard : voisines"; }
        else { out = {W(h), WHITE}; label = "au hasard : une couleur et du blanc"; }
    } else if (n == 3) {
        const int t = r.below(4);
        if (t == 0) { out = {W(h), W(h + 4), W(h + 8)}; label = "au hasard : triade"; }
        else if (t == 1) { out = {W(h), W(h - 1), W(h + 1)}; label = "au hasard : voisines"; }
        else if (t == 2) { out = {W(h), W(h + 5), W(h + 7)}; label = "au hasard : complementaires partagees"; }
        else { out = {W(h), W(h + 6), WHITE}; label = "au hasard : complementaires et blanc"; }
    } else {
        const int t = r.below(3);
        if (t == 0) { out = {W(h), W(h + 3), W(h + 6), W(h + 9)}; label = "au hasard : carre"; }
        else if (t == 1) { out = {W(h), W(h + 2), W(h + 6), W(h + 8)}; label = "au hasard : rectangle"; }
        else { out = {W(h), W(h + 1), W(h + 2), WHITE}; label = "au hasard : voisines et blanc"; }
    }
}

// Couleurs de la scene en cours selon le mode.
void resolve_colors(Spectacle& S) {
    const SpectacleScene& sc = SPECTACLE_SCENE_INFO[S.scene];
    const int n = std::clamp(sc.ncol, 1, SPECTACLE_MAX_COLORS);
    if (S.color_mode == SPC_CUSTOM) {
        std::vector<vec3>& c = S.custom[n];
        if ((int)c.size() != n) c.assign(sc.colors, sc.colors + n);
        S.colors = c;
        S.colors_label = "couleurs choisies";
    } else if (S.color_mode == SPC_RANDOM) {
        draw_colors(S.color_seed, n, S.colors, S.colors_label);
    } else {
        S.colors.assign(sc.colors, sc.colors + n);
        S.colors_label = "couleurs de la scene";
    }
}

uint32_t effects_signature(const LaserRig& lr) {
    uint32_t h = 2166136261u;
    for (const Effect& e : lr.effects) h = (h ^ (uint32_t)e.type ^ ((uint32_t)e.fixtures.size() << 8)) * 16777619u;
    return h ^ (uint32_t)lr.effects.size();
}

const char* energy_label(float e) {
    if (e <= 0.0f) return "fixe";
    if (e < 0.3f) return "calme";
    if (e < 0.55f) return "doux";
    if (e < 0.8f) return "rythme";
    return "dynamique";
}

}  // namespace

const SpectacleScene SPECTACLE_SCENE_INFO[SPECTACLE_SCENES] = {
    {"Aube", "Une ligne d'horizon ambree a hauteur des yeux (nez de scene) ; avec l'energie, un ciel lavande s'ouvre au-dessus "
             "et l'horizon se separe en couches.",
     "un soleil (gobo soleil) se leve dans la fumee depuis le sol de scene ; le pont lave le ciel en lavande.",
     2, {AMBER, LAVENDER}},
    {"Fenetres", "Quelques rayons de poussiere laser, au-dessus du public : la lumiere vient surtout des lyres.",
     "la lumiere du jour entre en biais par de hautes fenetres (gobo fenetre du pont et des trusses, rais paralleles) ; "
     "elles glissent avec le soleil, des nuages passent.",
     1, {WARM_WHITE}},
    {"Ocean", "Un ciel liquide : nappes du pont juste au-dessus des tetes, degrade bleu vers cyan, une houle qui roule.",
     "des reflets d'eau (gobo eau) dansent sur tout le sol.",
     2, {BLUE, CYAN}},
    {"Aurore boreale", "Grandes vagues lentes du pont vers le haut, couleurs qui defilent le long des vagues ; toujours douce.",
     "des nuages colores (gobo nuages) derivent au sol.",
     3, {EMERALD, TURQ, PURPLE}},
    {"Constellations", "Un ciel d'etoiles laser bleutees (grilles en diffraction x 9) au-dessus du public, qui derive et scintille.",
     "la lune et les etoiles blanches au sol, une galaxie bleue dans les faisceaux du pont.",
     2, {MOON, COOL_WHITE}},
    {"Glacier", "Des stalactites de traits laser qui pendent du pont et scintillent.",
     "des flocons qui tournent au sol, des colonnes blanches devant la scene.",
     3, {COOL_WHITE, ICE, AZUR}},
    {"Cathedrale de verre", "Arches de traits dores du pont et du sol ; la lumiere monte le long des arches.",
     "des vitraux colores (gobo vitrail) dans la fumee, depuis le sol de scene et le pont.",
     3, {BLUE, CARMINE, GOLD}},
    {"Desert", "Une ligne d'horizon brulante qui tremble ; avec l'energie, elle se separe en couches.",
     "des dunes bleu nuit au sol (gobo vagues), les rayons rasants du couchant depuis le pont.",
     2, {AMBER, NIGHT}},
    {"Jungle", "Une canopee de vagues vertes au ras des tetes, des rayons de soleil qui percent depuis les trusses.",
     "des feuillages qui se balancent au sol.",
     3, {GREEN, LIME, YELLOW}},
    {"Bulles", "Des cercles laser qui flottent au-dessus du public, respirent, puis eclatent.",
     "des bulles (gobo bulles) qui tournent au sol.",
     3, {CYAN, PINK, LILAC}},
    {"Coeurs", "Des coeurs laser qui battent : doucement, puis sur chaque temps.",
     "des coeurs rouges au sol qui battent avec eux, un lavage rose du pont.",
     2, {NEON_PINK, RED}},
    {"Pluie d'or", "Une averse de faisceaux dores des trusses, qui derivent puis scintillent.",
     "des soleils d'aiguilles (gobo) dans les faisceaux du pont.",
     2, {GOLD, WARM_WHITE}},
    {"Ruche doree", "Des abeilles laser (petits eventails des trusses) qui butinent dans tous les sens.",
     "des alveoles ambrees au sol (gobo nid d'abeille), des faisceaux jaunes du pont en huit.",
     2, {AMBER, YELLOW}},
    {"Feu sacre", "Des flammes laser (vagues verticales du nez de scene) qui montent et vacillent, du rouge vers l'or.",
     "des flammes au sol et dans la fumee (gobo flammes).",
     3, {RED, ORANGE, GOLD}},
    {"Monolithe", "Une seule couleur ; une lame horizontale qui balaie toute la salle.",
     "une foret de colonnes immobiles dans la salle et devant la scene ; sur le temps, une vague les parcourt.",
     1, {RED}},
    {"Vert laser", "Le grand classique en vert pur : eventails du pont qui balaient, tunnels du sol qui tournent.",
     "faisceaux verts du sol de scene en eventail, en contre-jour.",
     1, {GREEN}},
    {"Tubes", "Des tunnels laser blancs du pont vers le public, qui tournent et respirent.",
     "des faisceaux en tube (gobo anneau) qui tournent en cercle sous les trusses.",
     2, {MAGENTA, COOL_WHITE}},
    {"Helices", "Doubles eventails du pont qui tournent comme des helices, un sur deux en sens contraire.",
     "des helices (gobo helice) qui tournent dans les faisceaux verticaux des trusses.",
     2, {CYAN, PURPLE}},
    {"Geometrie sacree", "Triangles, carres, etoiles et cercles du pont qui tournent en orbite ; par pas sur le temps.",
     "des tubes triangulaires (gobo triangle) des trusses, en huit.",
     3, {GOLD, MAGENTA, CYAN}},
    {"Mandala", "Quatre etoiles concentriques (6 a 12 branches) qui tournent en sens contraires autour du meme centre.",
     "des rosaces et des prismes 6 dans la fumee, depuis le sol et le nez de scene.",
     3, {FUCHSIA, TANGERINE, PURPLE}},
    {"Kaleidoscope", "Une etoile de plans laser qui passent tous par un meme point et tournent.",
     "des spirales au sol qui tournent (avec un prisme sur le temps).",
     4, {RED, YELLOW, CYAN, PURPLE}},
    {"Neon", "Une grille synthwave : lignes d'horizon cyan du nez de scene, lames roses du pont en miroir.",
     "faisceaux roses et cyan des trusses en huit.",
     2, {NEON_PINK, CYAN}},
    {"Op art", "Des rideaux de traits rouges des trusses qui se croisent comme des ciseaux.",
     "des damiers blancs qui tournent au sol ; sur le temps, un sur deux.",
     2, {WHITE, RED}},
    {"Toile d'araignee", "Filets de traits verts du pont vers le sol et du nez vers le haut, qui se croisent.",
     "des toiles d'araignee violettes au sol.",
     2, {ACID, PURPLE}},
    {"Matrice", "Des faisceaux de traits en grille 4 x 4 qui tombent des trusses ; des vagues les parcourent.",
     "faisceaux blancs du pont en ciseaux.",
     2, {MATRIX, COOL_WHITE}},
    {"Vortex", "Tunnels doubles du pont qui tournent en sens contraires ; demultiplies au maximum.",
     "des spirales qui tournoient dans les faisceaux des trusses.",
     2, {INDIGO, CYAN}},
    {"Eclats", "Des eclats de laser (petits eventails et faisceaux) projetes dans tous les sens, qui scintillent et sautent.",
     "du verre brise au sol (gobo verre brise), qui eclate sur le temps.",
     2, {COOL_WHITE, CYAN}},
    {"Tempete", "Un plafond de nuages violets du nez de scene ; des eclairs blancs des trusses, de plus en plus frequents.",
     "des nuages violets au sol, des eclairs blancs du pont dans tous les sens (stroboscope au maximum).",
     2, {PURPLE, WHITE}},
    {"Pulsar", "Tout en blanc : des lames du pont qui s'ouvrent et se ferment sur le temps.",
     "un eventail de faisceaux blancs du pont qui flashe (stroboscope au maximum).",
     1, {WHITE}},
    {"Apotheose", "Tout en meme temps, 4 couleurs : ciseaux du pont, chenillard des trusses, faisceaux du nez en miroir, "
                  "helices du sol.",
     "soleils d'aiguilles et prismes du sol, cercles des trusses, ciseaux du pont.",
     4, {GOLD, WHITE, MAGENTA, CYAN}},
};

const char* const SPECTACLE_COLOR_FAMILIES[] = {"Rouges", "Oranges", "Jaunes", "Verts", "Turquoises", "Bleus", "Violets",
                                                "Roses", "Blancs"};
const int SPECTACLE_COLOR_FAMILY_COUNT = (int)(sizeof(SPECTACLE_COLOR_FAMILIES) / sizeof(SPECTACLE_COLOR_FAMILIES[0]));

const SpectacleColor SPECTACLE_COLORS[] = {
    {"Rouge", RED, 0}, {"Rouge sang", BLOOD, 0}, {"Carmin", CARMINE, 0}, {"Vermillon", VERMILION, 0}, {"Corail", CORAL, 0},
    {"Framboise", RASPBERRY, 0},
    {"Orange", ORANGE, 1}, {"Mandarine", TANGERINE, 1}, {"Ambre", AMBER, 1}, {"Cuivre", COPPER, 1}, {"Peche", PEACH, 1},
    {"Or", GOLD, 2}, {"Jaune", YELLOW, 2}, {"Citron", LEMON, 2}, {"Paille", STRAW, 2},
    {"Citron vert", LIME, 3}, {"Vert acide", ACID, 3}, {"Vert", GREEN, 3}, {"Vert matrice", MATRIX, 3}, {"Emeraude", EMERALD, 3},
    {"Menthe", MINT, 3},
    {"Turquoise", TURQ, 4}, {"Lagon", LAGOON, 4}, {"Aqua", AQUA, 4}, {"Cyan", CYAN, 4}, {"Bleu glace", ICE, 4},
    {"Bleu ciel", SKY, 5}, {"Azur", AZUR, 5}, {"Bleu lunaire", MOON, 5}, {"Bleu roi", BLUE, 5}, {"Bleu profond", DEEP, 5},
    {"Bleu nuit", NIGHT, 5},
    {"Indigo", INDIGO, 6}, {"Violet", PURPLE, 6}, {"Amethyste", AMETHYST, 6}, {"Lilas", LILAC, 6}, {"Lavande", LAVENDER, 6},
    {"Magenta", MAGENTA, 7}, {"Fuchsia", FUCHSIA, 7}, {"Rose neon", NEON_PINK, 7}, {"Rose", PINK, 7}, {"Rose poudre", POWDER, 7},
    {"Blanc", WHITE, 8}, {"Blanc froid", COOL_WHITE, 8}, {"Blanc chaud", WARM_WHITE, 8},
};
const int SPECTACLE_COLOR_COUNT = (int)(sizeof(SPECTACLE_COLORS) / sizeof(SPECTACLE_COLORS[0]));

const SpectaclePalette SPECTACLE_PALETTES[] = {
    // 2 couleurs
    {"Feu et glace (orange, cyan)", 2, {ORANGE, CYAN}},
    {"Nuit d'ete (bleu roi, ambre)", 2, {BLUE, AMBER}},
    {"Synthwave (rose neon, cyan)", 2, {NEON_PINK, CYAN}},
    {"Royal (violet, or)", 2, {PURPLE, GOLD}},
    {"Concert (bleu profond, magenta)", 2, {DEEP, MAGENTA}},
    {"Psychedelique (magenta, jaune)", 2, {MAGENTA, YELLOW}},
    {"Lagon (corail, turquoise)", 2, {CORAL, TURQ}},
    {"Braise (rouge, ambre)", 2, {RED, AMBER}},
    {"Printemps (citron vert, bleu roi)", 2, {LIME, BLUE}},
    {"Douceur (lavande, peche)", 2, {LAVENDER, PEACH}},
    {"Jardin (emeraude, or)", 2, {EMERALD, GOLD}},
    {"Veillee (blanc chaud, bleu nuit)", 2, {WARM_WHITE, NIGHT}},
    {"Givre (cyan, blanc froid)", 2, {CYAN, COOL_WHITE}},
    {"Bleu et blanc", 2, {BLUE, WHITE}},
    {"Rouge et blanc", 2, {RED, WHITE}},
    {"Rose et blanc", 2, {PINK, WHITE}},
    {"Poison (vert acide, violet)", 2, {ACID, PURPLE}},
    {"Pop (rouge, cyan)", 2, {RED, CYAN}},
    {"Velours (framboise, indigo)", 2, {RASPBERRY, INDIGO}},
    {"Agrume (mandarine, citron)", 2, {TANGERINE, LEMON}},
    // 3 couleurs
    {"Feu (rouge, orange, or)", 3, {RED, ORANGE, GOLD}},
    {"Coucher de soleil (orange, rose, violet)", 3, {ORANGE, PINK, PURPLE}},
    {"Ocean (bleu roi, cyan, turquoise)", 3, {BLUE, CYAN, TURQ}},
    {"Aurore boreale (emeraude, turquoise, violet)", 3, {EMERALD, TURQ, PURPLE}},
    {"Neon (rose neon, cyan, violet)", 3, {NEON_PINK, CYAN, PURPLE}},
    {"Tricolore (bleu, blanc, rouge)", 3, {BLUE, WHITE, RED}},
    {"Glace (blanc froid, bleu glace, bleu roi)", 3, {COOL_WHITE, ICE, BLUE}},
    {"RVB (rouge, vert, bleu)", 3, {RED, GREEN, BLUE}},
    {"Foret (vert, citron vert, turquoise)", 3, {GREEN, LIME, TURQ}},
    {"Lagune (turquoise, azur, blanc)", 3, {TURQ, AZUR, WHITE}},
    {"Braise (rouge sang, orange, ambre)", 3, {BLOOD, ORANGE, AMBER}},
    {"Fruits rouges (framboise, rose, violet)", 3, {RASPBERRY, PINK, PURPLE}},
    {"Desert (ambre, cuivre, bleu nuit)", 3, {AMBER, COPPER, NIGHT}},
    {"Bonbon (rose poudre, bleu glace, lavande)", 3, {POWDER, ICE, LAVENDER}},
    {"Vaporwave (rose, lilas, cyan)", 3, {PINK, LILAC, CYAN}},
    {"Agrumes (orange, jaune, citron vert)", 3, {ORANGE, YELLOW, LIME}},
    {"Galaxie (indigo, magenta, bleu glace)", 3, {INDIGO, MAGENTA, ICE}},
    {"Electrique (cyan, bleu roi, blanc)", 3, {CYAN, BLUE, WHITE}},
    {"Or et nuit (or, bleu nuit, blanc chaud)", 3, {GOLD, NIGHT, WARM_WHITE}},
    {"Corail (corail, peche, turquoise)", 3, {CORAL, PEACH, TURQ}},
    // 4 couleurs
    {"Synthwave (magenta, violet, cyan, orange)", 4, {MAGENTA, PURPLE, CYAN, ORANGE}},
    {"Tropical (vert, jaune, orange, rose)", 4, {GREEN, YELLOW, ORANGE, PINK}},
    {"Bonbons (rose, bleu glace, jaune, lilas)", 4, {PINK, ICE, YELLOW, LILAC}},
    {"Carnaval (magenta, jaune, cyan, orange)", 4, {MAGENTA, YELLOW, CYAN, ORANGE}},
    {"Automne (rouge sang, orange, or, cuivre)", 4, {BLOOD, ORANGE, GOLD, COPPER}},
    {"Pastel (rose poudre, peche, menthe, lavande)", 4, {POWDER, PEACH, MINT, LAVENDER}},
    {"Nuit de fete (bleu roi, magenta, or, blanc)", 4, {BLUE, MAGENTA, GOLD, WHITE}},
    {"Paon (emeraude, turquoise, bleu roi, violet)", 4, {EMERALD, TURQ, BLUE, PURPLE}},
    {"Cosmos (indigo, violet, magenta, bleu glace)", 4, {INDIGO, PURPLE, MAGENTA, ICE}},
    {"Prisme (rouge, jaune, cyan, violet)", 4, {RED, YELLOW, CYAN, PURPLE}},
    {"Volcan (rouge, orange, jaune, blanc)", 4, {RED, ORANGE, YELLOW, WHITE}},
    {"Abysses (bleu nuit, bleu roi, cyan, turquoise)", 4, {NIGHT, BLUE, CYAN, TURQ}},
};
const int SPECTACLE_PALETTE_COUNT = (int)(sizeof(SPECTACLE_PALETTES) / sizeof(SPECTACLE_PALETTES[0]));

float spectacle_bpm() {
    const Spectacle& S = g_spectacle;
    return S.tempo > 0.0f ? clampf(S.tempo, 30.0f, 240.0f) : 72.0f + 68.0f * clampf(S.energy, 0.0f, 1.0f);
}

void spectacle_apply(LaserRig& lr, bool restart) {
    Spectacle& S = g_spectacle;
    S.scene = std::clamp(S.scene, 0, SPECTACLE_SCENES - 1);
    S.energy = clampf(S.energy, 0.0f, 1.0f);
    // couleurs au hasard : un nouveau tirage a chaque scene lancee (meme si c'est la meme)
    if (restart && S.color_mode == SPC_RANDOM) S.color_seed = hash_u32(S.color_seed * 1664525u + 1013904223u) | 1u;
    resolve_colors(S);
    // comme une ambiance : nouvelle scene = reglages de depart (fumee, sol, visee, tout eteint) ; sinon (energie,
    // couleurs) seulement la programmation des lyres et des lasers
    Rig& rig = app.rig;
    if (restart) ambiance_reset();
    lr.pattern = LP_PROGRAM;
    lr.effects.clear();
    for (LaserFixture& f : lr.fixtures) {
        f.base = LaserParams();
        f.base.dimmer = 0;
        f.selected = false;
    }
    rig.effects.clear();
    for (Fixture& f : rig.fixtures) {
        f.base = FixtureParams();
        f.base.dimmer = 0;
        f.selected = false;
    }
    Prog g(lr, rig, S.seed * 2654435761u + (uint32_t)S.scene * 40503u);
    g.e = S.energy;
    g.bhz = spectacle_bpm() / 60.0f;
    g.beats = S.beats;
    g.pal = S.colors;
    lr.palette = g.pal;
    rig.palette = g.pal;
    SCENE_FN[S.scene](g);
    lr.select_all(false);
    rig.select_all(false);
    S.running = true;
    S.signature = effects_signature(lr);
    if (restart) S.next_change = S.beats + 4.0 * std::max(S.auto_bars, 1.0f);
}

void spectacle_draw(uint32_t seed) {
    Spectacle& S = g_spectacle;
    Rng r(seed * 2246822519u + 3266489917u);
    S.scene = r.below(SPECTACLE_SCENES);
    S.energy = std::round(r.range(0.05f, 1.0f) * 100.0f) / 100.0f;
    S.color_mode = r.uni() < 0.5f ? SPC_SCENE : SPC_RANDOM;
    S.color_seed = r.next();
    S.seed = r.next();
}

void spectacle_stop(LaserRig& lr) {
    Spectacle& S = g_spectacle;
    lr.effects.clear();
    for (LaserFixture& f : lr.fixtures) f.base.dimmer = 0;
    app.rig.effects.clear();
    for (Fixture& f : app.rig.fixtures) f.base.dimmer = 0;
    S.running = false;
}

void spectacle_update(LaserRig& lr, float dt) {
    Spectacle& S = g_spectacle;
    if (!journal_path.empty()) {
        const auto now = std::chrono::steady_clock::now();
        if (journal_frame > 120) {
            journal_wall += std::chrono::duration<double, std::milli>(now - journal_prev).count();
            if (gpuprof::available()) journal_ms.push_back(gpuprof::last_total_ms());
            journal_count++;
        }
        journal_prev = now;
        journal_frame++;
        if (journal_count >= 300) {
            float sum = 0;
            for (float v : journal_ms) sum += v;
            std::sort(journal_ms.begin(), journal_ms.end());
            const size_t n = journal_ms.size();
            auto at = [&](size_t i) { return n ? journal_ms[std::min(i, n - 1)] : 0.0f; };
            if (FILE* f = std::fopen(journal_path.c_str(), "a")) {
                // scene, nom, energie, image (ms, temps reel), GPU moyen, mediane, 90e centile, maximum, lasers allumes,
                // segments, effets
                std::fprintf(f, "%d\t%s\t%.2f\t%.2f\t%.2f\t%.2f\t%.2f\t%.2f\t%d\t%d\t%d\n", S.running ? S.scene + 1 : 0,
                             S.running ? SPECTACLE_SCENE_INFO[S.scene].name : "-", S.energy, journal_wall / journal_count,
                             n ? sum / (float)n : 0.0f, at(n / 2), at(n * 9 / 10), at(n - 1), lr.lit, (int)lr.segs.size(),
                             (int)lr.effects.size());
                std::fclose(f);
            }
            journal_path.clear();
        }
    }
    if (dt <= 0.0f) return;
    S.beats += (double)(spectacle_bpm() / 60.0f) * (double)dt;
    if (!S.running || !S.auto_next || S.beats < S.next_change) return;
    // le programme des lasers a change (ambiance, autre programmation) : l'enchainement s'arrete
    if (lr.pattern != LP_PROGRAM || effects_signature(lr) != S.signature) {
        S.running = false;
        return;
    }
    Rng r((uint32_t)(S.beats * 977.0) ^ S.seed);
    int next = r.below(SPECTACLE_SCENES - 1);
    if (next >= S.scene) next++;
    S.scene = next;
    S.seed = r.next();
    spectacle_apply(lr, true);
}

void spectacle_start(LaserRig& lr) {
    Spectacle& S = g_spectacle;
    if (!S.start_requested) return;
    S.start_requested = false;
    spectacle_apply(lr, true);
}

namespace {
// couleurs choisies pour la scene en cours (n couleurs)
std::vector<vec3>& custom_for_scene(Spectacle& S) {
    const SpectacleScene& sc = SPECTACLE_SCENE_INFO[std::clamp(S.scene, 0, SPECTACLE_SCENES - 1)];
    std::vector<vec3>& c = S.custom[sc.ncol];
    if ((int)c.size() != sc.ncol) c.assign(sc.colors, sc.colors + sc.ncol);
    return c;
}
}  // namespace

// --set : spectacle=N (1 a 30 : lance la scene N), spenergie, sptempo (0 : selon l'energie), spcouleurs (0 celles de la
// scene, 1 choisies, 2 au hasard), sptirage=n (graine du tirage ; passe au hasard), sppalette=N (association n° N de la
// liste, pour les scenes qui ont son nombre de couleurs ; passe en choisies), spperso=r,g,b/r,g,b/... (couleurs choisies,
// pour les scenes qui en ont autant), spgraine=n (variantes), spaleatoire=n (tout tire au hasard, graine n), spauto,
// spmesures, spjournal=fichier (temps image de la scene, ajoute au fichier).
bool spectacle_set(const std::string& k, const char* value) {
    Spectacle& S = g_spectacle;
    const float v = (float)std::atof(value);
    if (k == "spectacle") {
        S.scene = std::clamp((int)v - 1, 0, SPECTACLE_SCENES - 1);
        S.start_requested = true;
    } else if (k == "spenergie") {
        S.energy = clampf(v, 0.0f, 1.0f);
    } else if (k == "sptempo") {
        S.tempo = std::max(v, 0.0f);
    } else if (k == "spcouleurs") {
        S.color_mode = std::clamp((int)v, 0, 2);
    } else if (k == "sppalette") {
        const SpectaclePalette& p = SPECTACLE_PALETTES[std::clamp((int)v - 1, 0, SPECTACLE_PALETTE_COUNT - 1)];
        S.custom[p.n].assign(p.c, p.c + p.n);
        S.color_mode = SPC_CUSTOM;
    } else if (k == "spperso") {
        std::vector<vec3> c;
        for (const char* p = value; *p;) {
            vec3 x;
            if (std::sscanf(p, "%f,%f,%f", &x.x, &x.y, &x.z) == 3) c.push_back(x);
            while (*p && *p != '/') p++;
            if (*p == '/') p++;
        }
        if (!c.empty()) {
            if ((int)c.size() > SPECTACLE_MAX_COLORS) c.resize(SPECTACLE_MAX_COLORS);
            S.custom[c.size()] = c;
            S.color_mode = SPC_CUSTOM;
        }
    } else if (k == "sptirage") {
        S.color_seed = (uint32_t)v;
        S.color_mode = SPC_RANDOM;
    } else if (k == "spgraine") {
        S.seed = (uint32_t)v;
    } else if (k == "spaleatoire") {
        spectacle_draw((uint32_t)v);
        S.start_requested = true;
    } else if (k == "spauto") {
        S.auto_next = v != 0;
    } else if (k == "spmesures") {
        S.auto_bars = std::max(v, 1.0f);
    } else if (k == "spjournal") {
        journal_path = value;
    } else {
        return false;
    }
    return true;
}

// =============================================================================================
//  Interface (onglet Ambiances)
// =============================================================================================
namespace {
ImU32 to_u32(vec3 c) {
    return ImGui::ColorConvertFloat4ToU32(ImVec4(clampf(c.x, 0, 1), clampf(c.y, 0, 1), clampf(c.z, 0, 1), 1));
}
ImVec4 to_v4(vec3 c) { return ImVec4(clampf(c.x, 0, 1), clampf(c.y, 0, 1), clampf(c.z, 0, 1), 1); }
// petites cases de couleur a partir de 'p'
void swatches_at(ImDrawList* dl, ImVec2 p, const vec3* c, int n, float sz) {
    for (int i = 0; i < n; i++) {
        const float x = p.x + (float)i * (sz + 3);
        dl->AddRectFilled(ImVec2(x, p.y), ImVec2(x + sz, p.y + sz), to_u32(c[i]), 2.0f);
    }
}

// Bibliotheque des couleurs (une ligne par famille), puis le choix libre : change 'c'. Vrai si 'c' a change.
bool color_library(vec3& c) {
    bool changed = false;
    const float sz = ImGui::GetFrameHeight();
    for (int fam = 0; fam < SPECTACLE_COLOR_FAMILY_COUNT; fam++) {
        ImGui::AlignTextToFramePadding();
        ImGui::TextDisabled("%-11s", SPECTACLE_COLOR_FAMILIES[fam]);
        for (int i = 0; i < SPECTACLE_COLOR_COUNT; i++) {
            const SpectacleColor& sc = SPECTACLE_COLORS[i];
            if (sc.family != fam) continue;
            ImGui::SameLine();
            ImGui::PushID(i);
            if (ImGui::ColorButton(sc.name, to_v4(sc.c), ImGuiColorEditFlags_NoTooltip, ImVec2(sz * 1.4f, sz))) {
                c = sc.c;
                changed = true;
                ImGui::CloseCurrentPopup();
            }
            ImGui::SetItemTooltip("%s", sc.name);
            ImGui::PopID();
        }
    }
    ImGui::Separator();
    ImGui::TextDisabled("Ou une couleur libre :");
    ImGui::SetNextItemWidth(220);
    changed |= ImGui::ColorPicker3("##splibre", &c.x, ImGuiColorEditFlags_NoSidePreview | ImGuiColorEditFlags_NoInputs);
    return changed;
}
}  // namespace

void spectacle_ui(LaserRig& lr) {
    Spectacle& S = g_spectacle;
    ImGui::SeparatorText("Spectacles : lyres + lasers");
    ImGui::PushStyleColor(ImGuiCol_Text, ImGui::GetStyleColorVec4(ImGuiCol_TextDisabled));
    ImGui::TextWrapped("Comme une ambiance, une scene change toutes les lumieres d'un coup. Cliquez une scene, ou fleches du "
                       "clavier pour passer de l'une a l'autre.");
    ImGui::PopStyleColor();
    bool changed = false, restart = false;
    S.scene = std::clamp(S.scene, 0, SPECTACLE_SCENES - 1);
    const SpectacleScene& cur_sc = SPECTACLE_SCENE_INFO[S.scene];

    // energie et tempo
    {
        char fmt[48];
        std::snprintf(fmt, sizeof(fmt), "%%.2f (%s)", energy_label(S.energy));
        changed |= ImGui::SliderFloat("Energie##sp", &S.energy, 0, 1, fmt);
        ImGui::SetItemTooltip("0 : figures fixes, aucun clignotement. Puis petits mouvements, effets doux, rythme sur le temps,\n"
                              "et jusqu'a 1 : flashs, sauts, scintillement, rotations dans tous les sens.");
        bool auto_tempo = S.tempo <= 0.0f;
        if (ImGui::Checkbox("Tempo selon l'energie##sp", &auto_tempo)) {
            S.tempo = auto_tempo ? 0.0f : std::round(spectacle_bpm());
            changed = true;
        }
        ImGui::SameLine();
        if (auto_tempo) {
            ImGui::TextDisabled("(%.0f temps/min)", spectacle_bpm());
        } else {
            ImGui::SetNextItemWidth(160);
            changed |= ImGui::SliderFloat("##sptempo", &S.tempo, 60, 180, "%.0f temps/min");
        }
    }

    // couleurs : celles de la scene, choisies (autant que la scene en a), ou au hasard a chaque scene
    {
        ImGui::AlignTextToFramePadding();
        ImGui::TextUnformatted("Couleurs");
        ImGui::SameLine();
        changed |= ImGui::RadioButton("De la scene##spm", &S.color_mode, SPC_SCENE);
        ImGui::SetItemTooltip("Chaque scene a ses couleurs (1 a 4).");
        ImGui::SameLine();
        changed |= ImGui::RadioButton("Choisies##spm", &S.color_mode, SPC_CUSTOM);
        ImGui::SetItemTooltip("Vos couleurs, autant que la scene en a : une liste pour les scenes a 1 couleur, une pour celles a 2...");
        ImGui::SameLine();
        changed |= ImGui::RadioButton("Au hasard##spm", &S.color_mode, SPC_RANDOM);
        ImGui::SetItemTooltip("Un nouveau tirage a chaque changement de scene (meme en revenant sur la meme).");

        const int n = cur_sc.ncol;
        const float sz = 1.6f * ImGui::GetFrameHeight();
        ImGui::TextDisabled("S%d. %s : %d couleur%s", S.scene + 1, cur_sc.name, n, n > 1 ? "s" : "");
        static int edit_slot = 0;
        if (S.color_mode == SPC_CUSTOM) {
            std::vector<vec3>& c = custom_for_scene(S);
            for (int i = 0; i < n; i++) {
                ImGui::PushID(i);
                if (i > 0) ImGui::SameLine();
                if (ImGui::ColorButton("##spslot", to_v4(c[(size_t)i]), ImGuiColorEditFlags_NoTooltip, ImVec2(sz, sz))) {
                    edit_slot = i;
                    ImGui::OpenPopup("spbib");
                }
                ImGui::SetItemTooltip("Couleur %d : cliquez pour la changer", i + 1);
                if (ImGui::BeginPopup("spbib")) {
                    ImGui::Text("Couleur %d", edit_slot + 1);
                    if (color_library(c[(size_t)edit_slot])) changed = true;
                    ImGui::EndPopup();
                }
                ImGui::PopID();
            }
            ImGui::SameLine();
            if (ImGui::Button("Au hasard##spc")) {
                std::string label;
                draw_colors((uint32_t)(ImGui::GetTime() * 1000.0) ^ (S.color_seed * 7u), n, c, label);
                changed = true;
            }
            ImGui::SetItemTooltip("Tire %d couleur%s qui vont ensemble.", n, n > 1 ? "s" : "");
            ImGui::SameLine();
            if (ImGui::Button("Celles de la scene##spc")) {
                c.assign(cur_sc.colors, cur_sc.colors + n);
                changed = true;
            }
            if (n >= 2) {
                // associations toutes faites de n couleurs
                ImGui::SetNextItemWidth(-1);
                if (ImGui::BeginCombo("##spasso", "Associations de couleurs...", ImGuiComboFlags_HeightLarge)) {
                    const float s2 = ImGui::GetTextLineHeight();
                    for (int i = 0; i < SPECTACLE_PALETTE_COUNT; i++) {
                        const SpectaclePalette& p = SPECTACLE_PALETTES[i];
                        if (p.n != n) continue;
                        ImGui::PushID(i);
                        const ImVec2 pos = ImGui::GetCursorScreenPos();
                        char label[112];
                        std::snprintf(label, sizeof(label), "%*s%s", 3 * n + 1, "", p.name);
                        if (ImGui::Selectable(label, false)) {
                            c.assign(p.c, p.c + n);
                            changed = true;
                        }
                        swatches_at(ImGui::GetWindowDrawList(), ImVec2(pos.x, pos.y + 1), p.c, n, s2 * 0.85f);
                        ImGui::PopID();
                    }
                    ImGui::EndCombo();
                }
            }
        } else {
            const ImVec2 p = ImGui::GetCursorScreenPos();
            std::vector<vec3> shown;
            if (S.running) {
                shown = S.colors;
            } else {
                Spectacle tmp = S;
                resolve_colors(tmp);
                shown = tmp.colors;
            }
            swatches_at(ImGui::GetWindowDrawList(), p, shown.data(), (int)shown.size(), sz);
            ImGui::Dummy(ImVec2((float)shown.size() * (sz + 3), sz));
            if (S.color_mode == SPC_RANDOM) {
                ImGui::SameLine();
                if (ImGui::Button("Nouveau tirage##sp")) {
                    S.color_seed = hash_u32(S.color_seed * 1664525u + 1013904223u) | 1u;
                    changed = true;
                }
            }
        }
    }

    // enchainement
    ImGui::Checkbox("Enchainer les scenes##sp", &S.auto_next);
    ImGui::SetItemTooltip("Une autre scene au hasard toutes les N mesures (4 temps). S'arrete si on change le programme des\n"
                          "lasers (ambiance, effets).");
    if (S.auto_next) {
        ImGui::SameLine();
        ImGui::SetNextItemWidth(150);
        if (ImGui::SliderFloat("##spbars", &S.auto_bars, 1, 32, "%.0f mesures")) S.next_change = S.beats + 4.0 * S.auto_bars;
    }

    // les 30 scenes : gros boutons teintes de la couleur dominante, les couleurs de la scene en bas du bouton
    {
        const float sp = ImGui::GetStyle().ItemSpacing.x;
        const float w = (ImGui::GetContentRegionAvail().x - sp * (AMBIANCE_COLS - 1)) / AMBIANCE_COLS;
        const float h = 3.2f * ImGui::GetTextLineHeightWithSpacing();
        ImDrawList* dl = ImGui::GetWindowDrawList();
        for (int i = 0; i < SPECTACLE_SCENES; i++) {
            if (i % AMBIANCE_COLS != 0) ImGui::SameLine();
            const SpectacleScene& sc = SPECTACLE_SCENE_INFO[i];
            const bool cur = S.running && i == S.scene;
            const vec3* cols = cur ? S.colors.data() : sc.colors;
            const int nc = cur ? (int)S.colors.size() : sc.ncol;
            const vec3 t = nc > 0 ? cols[0] : vec3{1, 1, 1};
            const float k = cur ? 0.5f : 0.18f;
            ImGui::PushStyleColor(ImGuiCol_Button, ImVec4(0.08f + t.x * k, 0.08f + t.y * k, 0.09f + t.z * k, 1));
            ImGui::PushStyleColor(ImGuiCol_ButtonHovered, ImVec4(0.1f + t.x * 0.4f, 0.1f + t.y * 0.4f, 0.11f + t.z * 0.4f, 1));
            ImGui::PushStyleColor(ImGuiCol_ButtonActive, ImVec4(0.15f + t.x * 0.6f, 0.15f + t.y * 0.6f, 0.15f + t.z * 0.6f, 1));
            char id[64];
            std::snprintf(id, sizeof(id), "S%d\n%s##sps%d", i + 1, sc.name, i);
            if (ImGui::Button(id, ImVec2(w, h))) {
                S.scene = i;
                restart = true;
            }
            ImGui::PopStyleColor(3);
            if (ImGui::IsItemHovered()) ImGui::SetTooltip("%s\nLyres : %s\n%d couleur%s", sc.description, sc.lyres, sc.ncol, sc.ncol > 1 ? "s" : "");
            // bande du bas : une part par couleur
            const ImVec2 mn = ImGui::GetItemRectMin(), mx = ImGui::GetItemRectMax();
            const float x0 = mn.x + 5, x1 = mx.x - 5, seg = (x1 - x0) / (float)std::max(nc, 1);
            for (int c = 0; c < nc; c++)
                dl->AddRectFilled(ImVec2(x0 + seg * (float)c, mx.y - 7), ImVec2(x0 + seg * (float)(c + 1) - (c + 1 < nc ? 2.0f : 0.0f), mx.y - 4),
                                  to_u32(cols[c]), 2);
            if (cur) dl->AddRect(mn, mx, IM_COL32(255, 255, 255, 230), ImGui::GetStyle().FrameRounding, 0, 2.0f);
        }
    }

    // en cours
    if (S.running) {
        ImGui::Spacing();
        ImGui::SeparatorText("En cours");
        ImGui::Text("S%d. %s", S.scene + 1, cur_sc.name);
        ImGui::TextWrapped("%s Lyres : %s", cur_sc.description, cur_sc.lyres);
        ImGui::TextDisabled("Energie %.2f (%s), %.0f temps/min, %s ; %d faisceaux de lyres, %d lasers allumes", S.energy,
                            energy_label(S.energy), spectacle_bpm(), S.colors_label.c_str(), app.renderer.stats.lights, lr.lit);
        ImGui::PushStyleColor(ImGuiCol_Text, ImGui::GetStyleColorVec4(ImGuiCol_TextDisabled));
        ImGui::TextWrapped("Les onglets Lyres, Effets, Lasers et Fumee montrent sa programmation : on peut la retoucher "
                           "(changer l'energie ou les couleurs refait la scene).");
        ImGui::PopStyleColor();
    }

    if (restart) {
        spectacle_apply(lr, true);
    } else if (changed && S.running) {
        spectacle_apply(lr, false);
    }
}
