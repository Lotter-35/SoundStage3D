// Generateur de spectacles laser : voir spectacles.h.
//
// Une scene programme les lasers (figures du programmeur, puis effets). L'energie regle tout, de la meme facon pour
// toutes les scenes :
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

// couleurs de laser (teintes pures)
constexpr vec3 RED = {1, 0, 0}, ORANGE = {1, 0.35f, 0}, YELLOW = {1, 0.8f, 0}, LIME = {0.55f, 1, 0}, GREEN = {0, 1, 0};
constexpr vec3 TURQ = {0, 1, 0.6f}, CYAN = {0, 0.85f, 1}, AZUR = {0, 0.45f, 1}, BLUE = {0.05f, 0.2f, 1};
constexpr vec3 PURPLE = {0.5f, 0, 1}, MAGENTA = {1, 0, 0.8f}, PINK = {1, 0.2f, 0.5f}, WHITE = {1, 1, 1};
constexpr vec3 ICE = {0.6f, 0.9f, 1}, LILAC = {0.75f, 0.45f, 1};

// roue des teintes : tirage des couleurs, et les 12 couleurs du mode arc-en-ciel
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
};

// =============================================================================================
//  Lyres des scenes : quelques styles, regles par chaque scene
//  (suspendues : tilt 0 vers le bas, < 0 vers le public ; pont : tilt > 0 vers le public ; sol et nez : tilt 0 vers
//  le haut, > 0 vers le public)
// =============================================================================================
enum LyMove { LM_NONE, LM_TILT, LM_PAN, LM_CIRCLE, LM_FIG8, LM_SCISSORS, LM_FAN };

// Faisceaux serres, mouvement selon l'energie ; 'spread' : decalage d'une lyre a l'autre.
void ly_beams(Prog& g, const std::vector<int>& s, float zoom, float tilt, int paint, int cfirst, int move, float spread = 360,
              float level = 1) {
    g.lsetup(s, [&](FixtureParams& p, int, int, Fixture&) {
        p.zoom = zoom;
        p.tilt = tilt;
        p.dimmer = level;
        p.focus = 25;
    });
    g.lpaint(s, paint, cfirst);
    const int wave = g.groove() ? WAVE_TRIANGLE : WAVE_SINE;
    switch (move) {
        case LM_TILT: g.lfx(s, FX_TILT_WAVE, g.amp(18), g.spd(32, 4), spread, wave); break;
        case LM_PAN: g.lfx(s, FX_PAN_WAVE, g.amp(28), g.spd(32, 4), spread, wave); break;
        case LM_CIRCLE: g.lfx(s, FX_CIRCLE, g.amp(14), g.spd(32, 4), spread); break;
        case LM_FIG8: g.lfx(s, FX_FIGURE8, g.amp(18), g.spd(32, 4), spread); break;
        case LM_SCISSORS: g.lfx(s, FX_PAN_WAVE, 8 + g.amp(18), g.spd(32, 2), 180.0f * (float)s.size(), wave); break;
        case LM_FAN: g.lfx(s, FX_FAN, 16 + g.amp(14), g.spd(32, 4), 0, wave); break;   // fixe a energie nulle
        default: break;
    }
    g.lpulse(s, spread);
    g.lcolor_motion(s);
}

// Lavage doux du sol (zoom large, frost) ; vague de tilt d'une lyre a l'autre.
void ly_wash(Prog& g, const std::vector<int>& s, int cfirst, float level) {
    g.lsetup(s, [&](FixtureParams& p, int, int, Fixture&) {
        p.zoom = 30;
        p.frost = 0.55f;
        p.tilt = -12;
        p.dimmer = level;
    });
    g.lpaint(s, P_BLOCK, cfirst);
    g.lfx(s, FX_TILT_WAVE, g.amp(10), g.spd(32, 8), 360);
    g.lpulse(s, 360);
    g.lcolor_motion(s);
}

// Gobos au sol (nets), qui tournent avec l'energie ; prisme en option.
void ly_gobos(Prog& g, const std::vector<int>& s, int gobo, int prism, int cfirst, float level = 0.8f) {
    const float rot = g.turn(32, 4);
    g.lsetup(s, [&](FixtureParams& p, int k, int, Fixture& f) {
        p.zoom = 22;
        p.tilt = -10;
        p.gobo = gobo;
        p.gobo_speed = (k & 1) ? -rot : rot;
        p.prism = prism;
        p.prism_speed = prism != PRISM_NONE ? 0.5f * rot : 0.0f;
        p.focus = clampf((f.mount.pos.y - 0.71f) / std::cos(10.0f * DEG), 1.0f, 80.0f);
        p.dimmer = level;
    });
    g.lpaint(s, P_ALT, cfirst);
    g.lfx(s, FX_CIRCLE, g.amp(8), g.spd(32, 8), 360);
    g.lpulse(s, Prog::scatter(s));
    g.lcolor_motion(s);
}

// Faisceaux du pont vers le public, avec un prisme qui tourne.
void ly_prism(Prog& g, const std::vector<int>& s, int prism, int cfirst) {
    const float rot = g.turn(16, 2);
    g.lsetup(s, [&](FixtureParams& p, int k, int, Fixture&) {
        p.zoom = 3;
        p.tilt = 62;
        p.prism = prism;
        p.prism_spread = 1.2f;
        p.prism_speed = (k & 1) ? -rot : rot;
    });
    g.lpaint(s, P_ALT, cfirst);
    g.lfx(s, FX_TILT_WAVE, g.amp(8), g.spd(32, 4), 360);
    g.lpulse(s, 180.0f * (float)s.size());
    g.lcolor_motion(s);
}

// Couronne : toutes les lyres visent le point P (point de visee 1) ; elles tournent autour, puis en anneau.
void ly_crown(Prog& g, const std::vector<int>& s, vec3 P, int cfirst) {
    g.rig.aim_points[0] = P;
    g.lsetup(s, [&](FixtureParams& p, int, int, Fixture&) {
        p.zoom = 2.5f;
        p.aim_point = 0;
    });
    g.lpaint(s, P_BLOCK, cfirst);
    g.lfx(s, FX_CIRCLE, g.amp(6), g.spd(32, 4), g.groove() ? 360.0f : 0.0f);
    g.lpulse(s, 360);
    g.lcolor_motion(s);
}

// Lyres de chaque scene : elles accompagnent les lasers ('cfirst' : couleur decalee dans la palette).
void lyres_for_scene(Prog& g, int scene) {
    switch (scene) {
        case 0: ly_wash(g, g.lsel(TRUSS, 3, 1), 1, 0.45f); break;                                         // Horizon
        case 1: ly_beams(g, g.lsel(TRUSS, 4, 2), 3, -8, P_GROUP, 1, LM_CIRCLE); break;                     // Plafond
        case 2:                                                                                             // Cathedrale
            ly_beams(g, g.lby_z(g.lsel(SOL | NEZ)), 5, 6, P_ONE, 0, LM_FAN, 0);
            ly_wash(g, g.lsel(TRUSS, 4), 1, 0.3f);
            break;
        case 3: ly_gobos(g, g.lsel(TRUSS, 4, 3), 8, PRISM_NONE, 1); break;                                 // Rideaux
        case 4: ly_beams(g, g.lby_x(g.lsel(TRUSS, 6, 5)), 4, -20, P_RANK, 0, LM_TILT); break;              // Portiques
        case 5: ly_gobos(g, g.lsel(TRUSS, 3), 6, PRISM_NONE, 1, 0.6f); break;                              // Pluie
        case 6: ly_crown(g, join(g.lsel(PONT), g.lsel(TRUSS, 6)), {-14, 7.5f, 0}, 1); break;              // Convergence
        case 7: ly_beams(g, g.lsel(TRUSS, 3), 3, -15, P_ALT, 1, LM_SCISSORS); break;                       // Ciseaux
        case 8: ly_beams(g, g.lby_z(g.lsel(SOL | NEZ)), 5, 25, P_HALF, 0, LM_FAN, 0); break;               // Rencontre
        case 9: ly_beams(g, g.lsel(PONT), 4, 65, P_ONE, 1, LM_PAN, 0); break;                              // Balayage
        case 10: ly_prism(g, g.lsel(PONT, 2, 1), PRISM_LINEAR_4, 1); break;                                // Radar
        case 11: ly_gobos(g, g.lsel(TRUSS, 3, 1), 5, PRISM_6, 0); break;                                   // Kaleidoscope
        case 12: ly_prism(g, g.lsel(PONT, 2), PRISM_3, 1); break;                                          // Helice
        case 13: ly_crown(g, g.lsel(TRUSS, 4), {0, 0, 0}, 1); break;                                       // Tunnel
        case 14: ly_gobos(g, g.lsel(TRUSS, 3), 10, PRISM_NONE, 1); break;                                  // Vortex
        case 15: ly_gobos(g, g.lsel(TRUSS, 4), 9, PRISM_NONE, 1); break;                                   // Rosace
        case 16: ly_beams(g, g.lsel(TRUSS, 4), 3, -20, P_BLOCK, 0, LM_CIRCLE, 720); break;                 // Spirale
        case 17: ly_gobos(g, g.lsel(TRUSS, 3), 2, PRISM_NONE, 1); break;                                   // Etoiles
        case 18: ly_gobos(g, g.lsel(TRUSS, 4, 2), 7, PRISM_3, 1); break;                                   // Geometrie
        case 19: ly_gobos(g, g.lsel(TRUSS, 3), 1, PRISM_NONE, 1, 0.6f); break;                             // Constellation
        case 20: ly_prism(g, g.lsel(PONT), PRISM_9_GRID, 1); break;                                        // Diamants
        case 21: ly_wash(g, g.lby_x(g.lsel(TRUSS, 3)), 1, 0.5f); break;                                    // Vague
        case 22: ly_wash(g, g.lby_x(g.lsel(TRUSS, 3, 2)), 1, 0.5f); break;                                 // Ressac
        case 23: ly_wash(g, g.lsel(TRUSS, 4), 1, 0.35f); break;                                            // Aurore
        case 24: {                                                                                          // Chenillard
            const auto s = g.lsel(PONT);
            ly_beams(g, s, 3, 55, P_ONE, 1, LM_NONE, 360);
            if (!g.soft()) g.lfx(s, FX_DIMMER_CHASE, 0.8f, g.spd(32, 8), 360, WAVE_SINE);   // une lumiere court, douce
            break;
        }
        case 25: {                                                                                          // Pulsation
            const auto s = g.lsel(TRUSS, 4, 1);
            ly_beams(g, s, 6, -12, P_GROUP, 1, LM_NONE);
            g.lfx(s, FX_ZOOM_PULSE, 0.3f + 0.5f * g.mv(), g.spd(16, 1), 0, g.groove() ? WAVE_SQUARE : WAVE_SINE, 0.5f);
            break;
        }
        case 26: {                                                                                          // Etincelles
            const auto s = g.lsel(TRUSS, 3);
            ly_beams(g, s, 2, -15, P_RAND, 0, LM_FIG8);
            for (int i : s) {
                FixtureParams& p = g.rig.fixtures[(size_t)i].base;
                p.pan = g.rng.range(-40, 40);
                p.tilt = -15 + g.rng.range(-15, 15);
            }
            break;
        }
        case 27: ly_beams(g, g.lby_z(g.lsel(SOL | NEZ)), 5, 3, P_BLOCK, 0, LM_FAN, 0); break;          // Mur de lumiere
        case 28: ly_beams(g, g.lsel(TRUSS, 4), 2.5f, -28, P_ALT, 1, LM_FIG8); break;                       // Toile
        default:                                                                                            // Grand final
            ly_beams(g, g.lsel(TRUSS, 2), 3.5f, -15, P_GROUP, 0, LM_CIRCLE);
            ly_prism(g, g.lsel(PONT), PRISM_8, 1);
            ly_beams(g, g.lby_z(g.lsel(SOL | NEZ)), 5, 20, P_ALT, 2, LM_FAN, 0);
            break;
    }
}

// =============================================================================================
//  Les 30 scenes
// =============================================================================================

// 1. Horizon : une nappe continue a hauteur des yeux, qui se separe en couches avec l'energie
void s_horizon(Prog& g) {
    const auto nez = g.sel(NEZ);
    g.setup(nez, [&](LaserParams& p, int, int, LaserFixture&) {
        figure(p, LS_FAN, 56, 0);
        p.tilt = -3.5f;   // 1,5 deg au-dessus de l'horizontale
    });
    g.paint(nez, P_GRAD);
    std::vector<int> all = nez;
    if (g.soft()) {
        const auto sol = g.sel(SOL);
        g.setup(sol, [&](LaserParams& p, int, int, LaserFixture&) {
            figure(p, LS_FAN, 50, 0);
            p.tilt = -12;
        });
        g.paint(sol, P_GRAD, 1);
        all = join(nez, sol);
    }
    g.fx(nez, LFX_TILT_SPREAD, g.amp(5), g.groove() ? g.spd(16, 4) : 0.0f, 0);
    g.fx(all, LFX_TILT_WAVE, g.amp(2.5f), g.spd(32, 4), 360);
    if (g.groove()) g.fx(nez, LFX_ROLL, g.amp(6), g.spd(16, 4), 180);
    g.pulse(all, 360);
    g.color_motion(all);
}

// 2. Plafond : nappes du pont au-dessus du public, qui ondulent et s'ouvrent en accordeon
void s_plafond(Prog& g) {
    const auto pont = g.sel(PONT);
    g.setup(pont, [&](LaserParams& p, int, int, LaserFixture&) {
        figure(p, LS_FAN, 46, 0);
        p.tilt = 13;   // 1 deg au-dessus de l'horizontale
    });
    g.paint(pont, P_GRAD);
    g.fx(pont, LFX_TILT_WAVE, g.amp(4), g.spd(32, 4), 360);
    if (g.soft()) g.fx(pont, LFX_ROLL, g.amp(12), g.spd(32, 8), 180);
    if (g.groove()) g.fx(pont, LFX_TILT_SPREAD, g.amp(10), g.spd(16, 4), 0);
    g.pulse(pont, 360, 2);
    g.color_motion(pont);
}

// 3. Cathedrale : eventails verticaux de traits du pont et du sol, ouverts en voute
void s_cathedrale(Prog& g) {
    const auto pont = g.sel(PONT, 2), sol = g.sel(SOL);
    g.setup(pont, [&](LaserParams& p, int k, int n, LaserFixture&) {
        figure(p, LS_FAN, 40, 14, 90);
        p.tilt = 24;
        p.pan = 26.0f * centered(k, n);
    });
    g.setup(sol, [&](LaserParams& p, int k, int n, LaserFixture&) {
        figure(p, LS_FAN, 46, 10, 90);
        p.tilt = 22;
        p.pan = -22.0f * centered(k, n);
    });
    g.paint(pont, P_ONE, 0);
    g.paint(sol, P_ONE, 1);
    const auto all = join(pont, sol);
    g.fx(all, LFX_ROLL, g.amp(12), g.spd(64, 8), 360);
    if (g.soft()) g.fx(sol, LFX_SPREAD, g.amp(12), g.spd(32, 8), 0);
    if (g.groove()) g.fx(pont, LFX_TRAIT_CHASE, 0.3f, g.spd(8, 2), 90, WAVE_SAW);
    if (g.wild()) g.pulse(all, 360, 2);
    g.color_motion(all);
}

// 4. Rideaux : murs de lumiere le long des trusses, qui ondulent comme des rideaux dans le vent
void s_rideaux(Prog& g) {
    const auto tr = g.sel(TRUSS, 4, 1);   // ~10 par ligne, ligne apres ligne
    g.setup(tr, [&](LaserParams& p, int, int, LaserFixture&) {
        figure(p, LS_FAN, 30, 0, 90);   // nappe dans l'axe de la ligne
        p.tilt = -25;                   // a la verticale
    });
    g.paint(tr, P_GROUP);
    g.fx(tr, LFX_PAN_WAVE, g.amp(7), g.spd(32, 4), 1440);   // une ondulation le long de chaque ligne
    if (g.soft()) g.fx(tr, LFX_ROLL, g.amp(10), g.spd(32, 8), 1440);
    if (g.groove()) g.fx(tr, LFX_MIRROR, g.amp(12), g.spd(16, 4), 0);
    g.pulse(tr, 1440);
    g.color_motion(tr);
}

// 5. Portiques : nappes en travers de la salle a 7 endroits, vague de la scene vers le fond
void s_portiques(Prog& g) {
    const auto tr = g.by_x(g.sel(TRUSS, 6, 2));   // 7 positions x 4 lignes, de la scene vers le fond
    g.setup(tr, [&](LaserParams& p, int, int, LaserFixture&) {
        figure(p, LS_FAN, 44, 0);   // nappe en travers de la salle
        p.tilt = -25;
    });
    g.paint(tr, P_RANK);
    g.fx(tr, LFX_TILT_WAVE, g.amp(9), g.spd(32, 4), g.groove() ? 720.0f : 360.0f);
    if (g.soft()) g.fx(tr, LFX_OPENING, 0.25f, g.spd(16, 4), 360);
    g.pulse(tr, 360);
    g.color_motion(tr);
}

// 6. Pluie : faisceaux verticaux des trusses, qui scintillent comme une averse
void s_pluie(Prog& g) {
    const auto tr = g.sel(TRUSS, 2, g.rng.below(2));
    g.setup(tr, [&](LaserParams& p, int, int, LaserFixture&) {
        figure(p, LS_FAN, 0, 1);
        p.tilt = -25 + g.rng.range(-5, 5);
        p.pan = g.rng.range(-7, 7);
    });
    g.paint(tr, P_RAND);
    g.fx(tr, LFX_RANDOM, g.amp(4), g.spd(32, 8), 360);
    if (g.groove()) g.fx(tr, LFX_SPARKLE, g.wild() ? 0.3f : 0.5f, g.bhz * (g.wild() ? 4.0f : 2.0f), Prog::scatter(tr), -1, 0.6f);
    else g.pulse(tr, Prog::scatter(tr));
    g.color_motion(tr);
}

// 7. Convergence : faisceaux de tous les cotes qui se rejoignent en un point ; le point tourne, puis s'ouvre en couronne
void s_convergence(Prog& g) {
    const vec3 C = {-14, 7.5f, 0};
    std::vector<int> s;
    for (int i : g.sel(PONT | SOL | NEZ | TRUSS))
        if (g.reach(i, C, 4.0f)) s.push_back(i);
    s = g.around(s, C);
    g.setup(s, [&](LaserParams& p, int, int, LaserFixture&) { figure(p, LS_FAN, 0, 1); });
    g.paint(s, P_BLOCK);
    // chaque laser vise le point (en premier : la convergence remplace pan et tilt) ; au-dessus de 0,55, chacun vise
    // son propre point du cercle : une couronne de faisceaux qui tourne
    if (Effect* c = g.fx(s, LFX_CONVERGE, g.amp(3.5f), g.spd(32, 4), g.groove() ? 360.0f : 0.0f)) c->color_a = C;
    if (g.wild()) g.fx(s, LFX_CIRCLE, 1.5f, g.bhz / 2, 360);
    g.pulse(s, 360);
    g.color_motion(s);
}

// 8. Ciseaux : nappes verticales du pont, un laser sur deux en miroir : elles se croisent comme des lames
void s_ciseaux(Prog& g) {
    const auto pont = g.sel(PONT);
    g.setup(pont, [&](LaserParams& p, int k, int, LaserFixture&) {
        figure(p, LS_FAN, 26, 0, 90);
        p.tilt = 3;
        if (g.e <= 0.0f) p.pan = (k & 1) ? -12.0f : 12.0f;   // fixe : croisees
    });
    g.paint(pont, P_ALT);
    const int wave = g.groove() ? WAVE_TRIANGLE : WAVE_SINE;
    g.fx(pont, LFX_SCISSORS, 12 + g.amp(12), g.spd(32, 2), 0, wave);
    if (g.soft()) g.fx(pont, LFX_ROLL, g.amp(14), g.spd(32, 8), 180.0f * (float)pont.size());   // un sur deux en sens opposes
    std::vector<int> all = pont;
    if (g.groove()) {
        const auto nez = g.sel(NEZ);
        g.setup(nez, [&](LaserParams& p, int, int, LaserFixture&) {
            figure(p, LS_FAN, 30, 6);
            p.tilt = 6;
        });
        g.paint(nez, P_ALT, 1);
        g.fx(nez, LFX_SCISSORS, g.amp(22), g.spd(32, 2), 0, WAVE_TRIANGLE, -1, 1, 0.5f);
        all = join(pont, nez);
        g.pulse(all, 180.0f * (float)all.size());   // un sur deux : pairs, puis impairs
    }
    g.color_motion(all);
}

// 9. Rencontre : les deux moities du pont balaient en sens opposes et se rejoignent au centre
void s_rencontre(Prog& g) {
    const auto pont = g.sel(PONT);   // de -z a +z
    g.setup(pont, [&](LaserParams& p, int k, int n, LaserFixture&) {
        figure(p, LS_FAN, 22, 0, 90);
        p.tilt = 2;
        if (g.e <= 0.0f) p.pan = (2 * k < n - 1 ? 1.0f : -1.0f) * 14.0f;   // fixe : en V vers le centre
    });
    g.paint(pont, P_HALF);
    const int wave = g.groove() ? WAVE_TRIANGLE : WAVE_SINE;
    const float sp = g.spd(32, 2);
    g.fx(pont, LFX_MIRROR, g.amp(26), sp, 0, wave);
    std::vector<int> all = pont;
    if (g.soft()) {
        const auto nez = g.sel(NEZ);
        g.setup(nez, [&](LaserParams& p, int, int, LaserFixture&) {
            figure(p, LS_FAN, 0, 1);
            p.tilt = 8;
        });
        g.paint(nez, P_HALF, 1);
        g.fx(nez, LFX_MIRROR, g.amp(24), sp, 0, wave, -1, 1, 0.5f);   // en opposition : ils se croisent quand le pont s'ouvre
        all = join(pont, nez);
    }
    // plein feu a chaque rencontre (et a chaque ouverture complete), attenue entre les deux (noir complet au maximum)
    if (g.groove()) g.fx(all, LFX_DIMMER_CHASE, g.wild() ? 1.0f : 0.7f, 2 * sp, 0, WAVE_SQUARE, 0.5f, 1, 0.75f);
    g.color_motion(all);
}

// 10. Balayage : eventails de faisceaux du pont qui balaient le public a l'unisson ; le nez de scene contre-balaie
void s_balayage(Prog& g) {
    const auto pont = g.sel(PONT);
    g.setup(pont, [&](LaserParams& p, int, int, LaserFixture&) {
        figure(p, LS_FAN, 44, 10);
        p.tilt = 4;
    });
    g.paint(pont, P_ONE);
    const int wave = g.groove() ? WAVE_TRIANGLE : WAVE_SINE;
    g.fx(pont, LFX_PAN_WAVE, g.amp(22), g.spd(32, 2), 0, wave);
    if (g.soft()) g.fx(pont, LFX_TILT_WAVE, g.amp(6), g.spd(64, 4), 0);
    std::vector<int> all = pont;
    if (g.groove()) {
        const auto nez = g.sel(NEZ);
        g.setup(nez, [&](LaserParams& p, int, int, LaserFixture&) {
            figure(p, LS_FAN, 36, 6);
            p.tilt = 10;
        });
        g.paint(nez, P_ONE, 1);
        g.fx(nez, LFX_PAN_WAVE, g.amp(24), g.spd(32, 2), 0, wave, -1, 1, 0.5f);
        all = join(pont, nez);
    }
    if (g.wild()) g.pulse(all, 0);
    g.color_motion(all);
}

// 11. Radar : nappes du pont qui tournent sur elles-memes, un secteur lumineux qui court sur chacune
void s_radar(Prog& g) {
    const auto pont = g.sel(PONT, 2);
    const float t = g.turn(32, 2);
    g.setup(pont, [&](LaserParams& p, int k, int n, LaserFixture&) {
        figure(p, LS_FAN, 54, 0, 180.0f * (float)k / (float)n);
        p.tilt = 6;
        p.roll_speed = (g.groove() && (k & 1)) ? -t : t;
    });
    g.paint(pont, P_GRAD);
    if (g.soft()) g.fx(pont, LFX_TRAIT_CHASE, 0.35f, g.spd(8, 1), 360, WAVE_SAW);
    if (g.wild()) g.pulse(pont, 180.0f * (float)pont.size());
    g.color_motion(pont);
}

// 12. Kaleidoscope : les nappes du pont passent toutes par un meme point, chacune tournee d'un angle
void s_kaleidoscope(Prog& g) {
    const auto pont = g.sel(PONT);
    const vec3 C = {-8, 6, 0};
    const float t = g.turn(64, 4);
    g.setup(pont, [&](LaserParams& p, int k, int n, LaserFixture&) {
        figure(p, LS_FAN, 34, 0, 180.0f * (float)k / (float)n);
        p.roll_speed = (g.wild() && (k & 1)) ? -t : t;
    });
    g.paint(pont, P_BLOCK);
    if (Effect* c = g.fx(pont, LFX_CONVERGE, g.amp(2), g.spd(64, 8), 0)) c->color_a = C;
    if (g.soft()) g.fx(pont, LFX_OPENING, 0.35f, g.spd(16, 4), 360);
    if (g.groove()) g.pulse(pont, 360);
    g.color_motion(pont);
}

// 13. Helice : doubles eventails du pont qui tournent comme des helices, un sur deux en sens contraire
void s_helice(Prog& g) {
    const auto pont = g.sel(PONT, 2, 1);
    const float t = g.turn(16, 1);
    g.setup(pont, [&](LaserParams& p, int k, int, LaserFixture&) {
        figure(p, LS_DOUBLE_FAN, 48, 0, 45.0f * (float)k);
        p.shape_param = 8;
        p.tilt = 5;
        p.roll_speed = (k & 1) ? -t : t;
    });
    g.paint(pont, P_ALT);
    if (g.soft()) g.fx(pont, LFX_OPENING, 0.3f, g.spd(16, 4), 180.0f * (float)pont.size());
    if (g.groove()) g.fx(pont, LFX_TILT_WAVE, g.amp(6), g.spd(16, 4), 360);
    if (g.wild()) g.pulse(pont, 0);
    g.color_motion(pont);
}

// 14. Tunnel : cones du pont vers le public, qui tournent, respirent, et ou court une comete
void s_tunnel(Prog& g) {
    // nappes coniques : environ 2 fois le cout d'une nappe plane, et le public est dedans (5 tunnels, pas plus)
    const auto pont = g.sel(PONT, 3, 1);
    const float t = g.turn(32, 2);
    g.setup(pont, [&](LaserParams& p, int, int, LaserFixture&) {
        figure(p, LS_CONE, 12, 0);
        p.tilt = 5;
        p.roll_speed = t;   // le degrade tourne autour du cercle
    });
    g.paint(pont, P_GRAD);
    g.fx(pont, LFX_CIRCLE, g.amp(3), g.spd(32, 8), 360);
    if (g.soft()) g.fx(pont, LFX_OPENING, 0.35f, g.spd(16, 2), 360);
    if (g.groove()) g.fx(pont, LFX_TRAIT_CHASE, 0.25f, g.spd(4, 1), 0, WAVE_SAW);
    if (g.wild()) g.pulse(pont, 180.0f * (float)pont.size());
    g.color_motion(pont);
}

// 15. Vortex : tunnels doubles du pont, demultiplies par diffraction, qui tournent en sens contraires
void s_vortex(Prog& g) {
    // 4 tunnels doubles (8 nappes coniques), demultiplies seulement au maximum : la scene la plus chere
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
    if (g.groove()) g.fx(pont, LFX_TRAIT_CHASE, 0.3f, g.spd(4, 1), 180.0f * (float)pont.size(), WAVE_SAW);
    if (g.wild()) g.pulse(pont, 0);
    g.color_motion(pont);
}

// 16. Rosace : cercles du pont disposes en anneau autour d'un point, qui respirent l'un apres l'autre
void s_rosace(Prog& g) {
    const auto pont = g.sel(PONT, 2);   // 8 cercles (nappes coniques : 16 doublaient le cout)
    g.setup(pont, [&](LaserParams& p, int, int, LaserFixture&) { figure(p, LS_CONE, 9, 0); });
    g.paint(pont, P_ALT);
    // chaque cercle centre sur son point de l'anneau (decalage 360 deg) ; l'anneau tourne avec l'energie
    if (Effect* c = g.fx(pont, LFX_CONVERGE, 2.2f, g.spd(64, 8), 360)) c->color_a = {-12, 7, 0};
    if (g.soft()) g.fx(pont, LFX_OPENING, 0.45f, g.spd(16, 2), 360);
    if (g.groove()) g.fx(pont, LFX_TRAIT_CHASE, 0.3f, g.spd(4, 1), 360, WAVE_SAW);
    if (g.wild()) g.pulse(pont, 360);
    g.color_motion(pont);
}

// 17. Spirale : cones du sol et du nez qui decrivent des cercles en decale, degrade qui tourne
void s_spirale(Prog& g) {
    const auto nez = g.sel(NEZ), sol = g.sel(SOL);
    const float t = g.turn(16, 2);
    g.setup(nez, [&](LaserParams& p, int, int, LaserFixture&) {
        figure(p, LS_CONE, 10, 0);
        p.tilt = 18;   // 23 deg au-dessus de l'horizontale
        p.roll_speed = t;
    });
    g.setup(sol, [&](LaserParams& p, int, int, LaserFixture&) {
        figure(p, LS_CONE, 10, 0);
        p.tilt = 12;   // 27 deg
        p.roll_speed = -t;
    });
    const auto all = g.by_z(join(nez, sol));
    g.paint(all, P_GRAD);
    g.fx(all, LFX_CIRCLE, 3 + g.amp(7), g.spd(32, 2), 360);
    if (g.soft()) g.fx(all, LFX_OPENING, 0.4f, g.spd(8, 2), 720);
    if (g.groove()) g.fx(all, LFX_TRAIT_CHASE, 0.3f, g.spd(4, 1), 360, WAVE_SAW);
    if (g.wild()) g.pulse(all, 180.0f * (float)all.size());
    g.color_motion(all);
}

// 18. Etoiles : etoiles du pont qui tournent en sens contraires ; diffraction et scintillement quand l'energie monte
void s_etoiles(Prog& g) {
    // 8 etoiles ; au maximum, 4 etoiles en diffraction x3 (12 : le cout des nappes qui couvrent l'ecran)
    const auto pont = g.wild() ? g.sel(PONT, 4, 1) : g.sel(PONT, 2);
    const int branches = 5 + g.rng.below(3);
    const float t = g.turn(64, 4);
    g.setup(pont, [&](LaserParams& p, int k, int, LaserFixture&) {
        figure(p, LS_STAR, 18, 0);
        p.branches = branches;
        p.tilt = 4;
        p.roll_speed = (k & 1) ? -t : t;
        p.diffraction = g.wild() ? 3 : 1;
        p.diffraction_angle = 13;
    });
    g.paint(pont, P_ALT);
    g.fx(pont, LFX_PAN_WAVE, g.amp(6), g.spd(32, 4), 360);
    if (g.soft()) g.fx(pont, LFX_OPENING, 0.3f, g.spd(16, 4), 360);
    if (g.groove()) g.fx(pont, LFX_TRAIT_CHASE, 0.3f, g.spd(4, 1), 0, WAVE_SAW);
    if (g.wild()) g.fx(pont, LFX_SPARKLE, 0.6f, 2 * g.bhz, Prog::scatter(pont), -1, 0.7f);
    g.color_motion(pont);
}

// 19. Geometrie : carres, triangles et cercles alternes sur le pont, qui tournent (par pas sur le temps)
void s_geometrie(Prog& g) {
    const auto pont = g.sel(PONT, 2);   // 8 figures (16 : deux fois le cout)
    static const int SHAPES[3] = {LS_SQUARE, LS_TRIANGLE, LS_CONE};
    const float t = g.groove() ? 0.0f : g.turn(64, 8);
    g.setup(pont, [&](LaserParams& p, int k, int, LaserFixture&) {
        figure(p, SHAPES[k % 3], 16, 0);
        p.tilt = 4;
        p.roll_speed = (k & 1) ? -t : t;
    });
    g.paint(pont, P_ALT);
    g.fx(pont, LFX_TILT_WAVE, g.amp(4), g.spd(32, 4), 360);
    if (g.soft()) g.fx(pont, LFX_OPENING, 0.3f, g.spd(16, 4), 360);
    if (g.groove()) {
        // rotation par pas, sens contraires, decalee d'un demi-cycle un laser sur deux
        const float step = g.wild() ? 45.0f : 30.0f, sp = g.bhz / (g.wild() ? 1.0f : 2.0f);
        g.fx(Prog::alt(pont, 0), LFX_ROLL_STEP, step, sp, 0);
        g.fx(Prog::alt(pont, 1), LFX_ROLL_STEP, -step, sp, 0, -1, -1, 1, 0.5f);
    }
    if (g.wild()) g.pulse(pont, 180.0f * (float)pont.size());
    g.color_motion(pont);
}

// 20. Constellation : grilles de points en diffraction x9 au-dessus du public, qui derivent, scintillent et sautent
void s_constellation(Prog& g) {
    const auto pont = g.sel(PONT, 2);
    g.setup(pont, [&](LaserParams& p, int, int, LaserFixture&) {
        figure(p, LS_GRID, 18, 16);
        p.shape_param = 4;
        p.diffraction = 9;
        p.diffraction_angle = 9;
        p.tilt = 10;
        p.roll_speed = g.amp(12);
    });
    g.paint(pont, P_ALT);
    g.fx(pont, LFX_RANDOM, g.amp(5), g.spd(32, 8), 360);
    if (g.groove()) g.fx(pont, LFX_SPARKLE, g.wild() ? 0.45f : 0.65f, g.bhz * (g.wild() ? 2.0f : 1.0f), Prog::scatter(pont), -1, 0.6f);
    else g.pulse(pont, Prog::scatter(pont));
    if (g.wild()) g.fx(pont, LFX_JUMP, 8, g.bhz / 2, Prog::scatter(pont));
    g.color_motion(pont);
}

// 21. Diamants : faisceaux des trusses en diffraction x9 vers le sol : des nuees de points qui tournent et dansent
void s_diamants(Prog& g) {
    const auto tr = g.sel(TRUSS, 6, 3);
    g.setup(tr, [&](LaserParams& p, int, int, LaserFixture&) {
        figure(p, LS_FAN, 0, 1);
        p.diffraction = 9;
        p.diffraction_angle = 3.5f;
        p.tilt = -25 + g.rng.range(-4, 4);
        p.pan = g.rng.range(-8, 8);
    });
    g.paint(tr, P_RAND);
    g.fx(tr, LFX_CIRCLE, g.amp(6), g.spd(32, 4), 360);
    if (g.groove()) g.fx(tr, LFX_SPARKLE, g.wild() ? 0.4f : 0.6f, g.bhz, Prog::scatter(tr), -1, 0.7f);
    else g.pulse(tr, Prog::scatter(tr));
    if (g.wild()) g.fx(tr, LFX_JUMP, 10, g.bhz, 0);   // tout saute sur le temps
    g.color_motion(tr);
}

// 22. Vague : nappes ondulees du nez de scene ; les vagues defilent et une lumiere court dessus
void s_vague(Prog& g) {
    const auto nez = g.sel(NEZ);
    const float wv = g.e <= 0.0f ? 0.0f : g.bhz / g.cycle_beats(8, 1);
    // une vague est decoupee en arcs (nappes coniques, 2 fois le cout d'une nappe plane) : 2 ondulations, et le pont
    // ne repond qu'au maximum
    g.setup(nez, [&](LaserParams& p, int, int, LaserFixture&) {
        figure(p, LS_WAVE, 50, 0);
        p.shape_param = 2.5f + g.amp(3);
        p.wave_cycles = 2;
        p.wave_speed = wv;
        p.tilt = -2;
    });
    g.paint(nez, P_GRAD);
    std::vector<int> all = nez;
    g.fx(nez, LFX_TILT_WAVE, g.amp(2), g.spd(32, 4), 360);
    if (g.soft()) g.fx(nez, LFX_TRAIT_CHASE, 0.3f, g.spd(16, 2), 360, WAVE_SAW);
    if (g.wild()) {
        const auto pont = g.sel(PONT, 4, 1);
        g.setup(pont, [&](LaserParams& p, int, int, LaserFixture&) {
            figure(p, LS_WAVE, 50, 0);
            p.shape_param = 4;
            p.wave_cycles = 2;
            p.wave_speed = -wv;
            p.tilt = 14;
        });
        g.paint(pont, P_GRAD, 1);
        g.fx(pont, LFX_TILT_WAVE, g.amp(4), g.spd(16, 4), 360);
        all = join(nez, pont);
    }
    if (g.wild()) g.pulse(all, 360);
    g.color_motion(all);
}

// 23. Ressac : nappes du pont qui viennent mourir au sol devant le public et repartent
void s_ressac(Prog& g) {
    const auto pont = g.sel(PONT);
    g.setup(pont, [&](LaserParams& p, int, int, LaserFixture&) {
        figure(p, LS_FAN, 50, 0);
        p.tilt = -9;   // 21 deg sous l'horizontale : la nappe touche le sol a ~30 m
    });
    g.paint(pont, P_GRAD);
    g.fx(pont, LFX_TILT_WAVE, 1.5f + g.amp(5), g.spd(32, 4), 360, g.groove() ? WAVE_SAW : WAVE_SINE);
    if (g.soft()) g.fx(pont, LFX_ROLL, g.amp(8), g.spd(32, 8), 360);
    g.pulse(pont, 360);
    g.color_motion(pont);
}

// 24. Aurore : grandes vagues lentes du pont vers le haut, couleurs qui defilent ; toujours douce
void s_aurore(Prog& g) {
    const auto pont = g.sel(PONT, 2);
    const int N = g.ncol();
    g.setup(pont, [&](LaserParams& p, int, int, LaserFixture&) {
        figure(p, LS_WAVE, 56, 0);
        p.shape_param = 5;
        p.wave_cycles = 1.5f;
        p.wave_speed = g.e <= 0.0f ? 0.0f : 0.05f + 0.25f * g.e;
        p.tilt = 22;
    });
    g.paint(pont, P_GRAD);
    if (!g.rainbow && N >= 2)
        for (int i : pont) {
            LaserParams& p = g.lr.fixtures[(size_t)i].base;
            p.gradient = LG_SCROLL;   // couleurs 1 et 2 qui defilent le long de la vague
            p.gradient_speed = g.e <= 0.0f ? 0.0f : 0.04f + 0.3f * g.e;
        }
    g.fx(pont, LFX_TILT_WAVE, g.amp(4), g.spd(64, 8), 360);
    if (g.soft()) g.fx(pont, LFX_DIMMER_CHASE, 0.5f, g.spd(32, 8), 720, WAVE_SINE);
    if (g.wild()) g.fx(pont, LFX_ROLL, g.amp(15), g.spd(16, 4), 360);
    g.color_motion(pont);
}

// 25. Chenillard : faisceaux des trusses ; une lumiere court le long de chaque ligne et revient
void s_chenillard(Prog& g) {
    std::vector<int> all;
    for (int l = 0; l < 4; l++) {
        const auto s = g.by_x(g.sel(1u << l, 2));
        g.setup(s, [&](LaserParams& p, int, int, LaserFixture&) {
            figure(p, LS_FAN, 8, 3, 90);   // 3 traits dans l'axe de la ligne
            p.tilt = -25;
        });
        g.paint(s, P_ONE, l);
        // groupe allume de plus en plus court avec l'energie ; lignes 2 et 4 en sens opposes ; bords nets des 0,55
        g.fx(s, LFX_BOUNCE, 0.5f - 0.3f * g.e, g.spd(32, 4), 0, g.groove() ? WAVE_SQUARE : WAVE_SINE, -1, 1, (l & 1) ? 0.5f : 0.0f);
        all = join(all, s);
    }
    if (g.soft()) g.fx(all, LFX_TILT_WAVE, g.amp(8), g.spd(32, 4), 720);
    if (g.wild()) g.fx(all, LFX_SCISSORS, g.amp(10), g.bhz / 2, 0);
    g.color_motion(all);
}

// 26. Pulsation : nappes du pont et cones du nez qui s'ouvrent et se ferment ensemble, sur le temps
void s_pulsation(Prog& g) {
    const auto pont = g.sel(PONT, 2), nez = g.sel(NEZ);   // nappes ouvertes jusqu'a 1,85 fois : 8 sur le pont
    g.setup(pont, [&](LaserParams& p, int, int, LaserFixture&) {
        figure(p, LS_FAN, 40, 0);
        p.tilt = 8;
    });
    g.setup(nez, [&](LaserParams& p, int, int, LaserFixture&) {
        figure(p, LS_CONE, 12, 0);
        p.tilt = 12;
    });
    g.paint(pont, P_GRAD);
    g.paint(nez, P_ONE, 1);
    const auto all = join(pont, nez);
    g.fx(all, LFX_OPENING, 0.25f + 0.6f * g.mv(), g.spd(16, 1), 0, g.groove() ? WAVE_SQUARE : WAVE_SINE, 0.5f);
    if (g.soft()) g.fx(pont, LFX_TILT_WAVE, g.amp(4), g.spd(32, 4), 360);
    if (g.groove()) g.pulse(pont, 0);
    if (g.wild()) g.fx(nez, LFX_SPARKLE, 0.5f, 2 * g.bhz, Prog::scatter(nez), -1, 0.5f);
    g.color_motion(all);
}

// 27. Etincelles : faisceaux et petits eventails du pont et des trusses qui scintillent et sautent
void s_etincelles(Prog& g) {
    const auto pont = g.sel(PONT), tr = g.sel(TRUSS, 8, g.rng.below(8));
    g.setup(pont, [&](LaserParams& p, int, int, LaserFixture&) {
        figure(p, LS_FAN, 16, 5);
        p.tilt = g.rng.range(0, 14);
        p.pan = g.rng.range(-15, 15);
    });
    g.setup(tr, [&](LaserParams& p, int, int, LaserFixture&) {
        figure(p, LS_FAN, 0, 1);
        p.tilt = -25 + g.rng.range(-10, 10);
        p.pan = g.rng.range(-12, 12);
    });
    const auto all = join(pont, tr);
    g.paint(all, P_RAND);
    const float sc = Prog::scatter(all);
    g.fx(all, LFX_RANDOM, g.amp(10), g.spd(16, 2), 360);
    if (g.groove()) {
        g.fx(all, LFX_SPARKLE, g.wild() ? 0.3f : 0.45f, g.bhz * (g.wild() ? 4.0f : 2.0f), sc, -1, 0.5f);
        g.fx(all, LFX_JUMP, g.amp(14), g.bhz / (g.wild() ? 1.0f : 2.0f), sc);
    } else if (g.soft()) {
        g.fx(all, LFX_DIMMER_CHASE, 0.6f, g.spd(8, 2), sc, WAVE_SINE);   // scintillement doux, sans clignoter
    }
    g.color_motion(all);
}

// 28. Mur de lumiere : lames verticales du nez et du sol devant la scene, qui s'ouvrent comme des portes
void s_mur(Prog& g) {
    const auto nez = g.sel(NEZ), sol = g.sel(SOL);
    g.setup(nez, [&](LaserParams& p, int, int, LaserFixture&) {
        figure(p, LS_FAN, 40, 0, 90);
        p.tilt = 22;
    });
    g.setup(sol, [&](LaserParams& p, int, int, LaserFixture&) {
        figure(p, LS_FAN, 40, 0, 90);
        p.tilt = 12;
    });
    const auto all = g.by_z(join(nez, sol));
    g.paint(all, P_GRAD);
    g.fx(all, LFX_SPREAD, 14 + g.amp(10), g.spd(32, 4), 0);   // fixe a energie nulle : les lames en eventail
    if (g.soft()) g.fx(all, LFX_MIRROR, g.amp(10), g.spd(16, 4), 0, -1, -1, 1, 0.25f);
    if (g.groove()) g.pulse(all, 360, 2);
    if (g.wild()) g.fx(all, LFX_ROLL, g.amp(25), g.bhz / 2, 180.0f * (float)all.size());
    g.color_motion(all);
}

// 29. Toile : eventails de traits du pont vers le sol et du nez vers le haut, qui se croisent en filet
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
    g.paint(pont, P_ONE, 0);
    g.paint(nez, P_ONE, 1);
    const auto all = join(pont, nez);
    g.fx(all, LFX_ROLL, g.amp(20), g.spd(64, 8), 360);
    if (g.soft()) g.fx(all, LFX_SCISSORS, g.amp(10), g.spd(32, 4), 0);
    if (g.groove()) g.fx(all, LFX_TRAIT_CHASE, 0.35f, g.spd(4, 1), 180.0f * (float)all.size(), WAVE_SAW);
    if (g.wild()) g.pulse(all, 180.0f * (float)all.size());
    g.color_motion(all);
}

// 30. Grand final : ciseaux du pont, chenillard des trusses, faisceaux du nez en miroir, helices du sol
void s_final(Prog& g) {
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
    g.paint(pont, P_ALT);
    g.paint(nez, P_HALF, 1);
    g.paint(sol, P_ALT, 2);
    g.paint(tr, P_RANK);
    const int wave = g.groove() ? WAVE_TRIANGLE : WAVE_SINE;
    g.fx(pont, LFX_SCISSORS, g.amp(20), g.spd(32, 2), 0, wave);
    g.fx(nez, LFX_MIRROR, g.amp(24), g.spd(32, 2), 0, wave, -1, 1, 0.5f);
    g.fx(tr, LFX_TILT_WAVE, g.amp(10), g.spd(32, 4), 720);
    if (g.soft()) g.fx(pont, LFX_TRAIT_CHASE, 0.3f, g.spd(8, 2), 360, WAVE_SAW);
    if (g.groove()) {
        g.fx(tr, LFX_BOUNCE, 0.15f, g.spd(16, 2), 0, WAVE_SQUARE);
        g.pulse(pont, 180.0f * (float)pont.size());
    }
    if (g.wild()) g.fx(nez, LFX_SPARKLE, 0.5f, 2 * g.bhz, Prog::scatter(nez), -1, 0.6f);
    g.color_motion(join(join(pont, nez), join(sol, tr)));
}

using SceneFn = void (*)(Prog&);
const SceneFn SCENE_FN[SPECTACLE_SCENES] = {
    s_horizon, s_plafond, s_cathedrale, s_rideaux, s_portiques, s_pluie, s_convergence, s_ciseaux, s_rencontre, s_balayage,
    s_radar, s_kaleidoscope, s_helice, s_tunnel, s_vortex, s_rosace, s_spirale, s_etoiles, s_geometrie, s_constellation,
    s_diamants, s_vague, s_ressac, s_aurore, s_chenillard, s_pulsation, s_etincelles, s_mur, s_toile, s_final};

// Couleurs tirees au hasard : 1 a 4 couleurs qui vont ensemble (teintes de la roue : complementaires, voisines, triade,
// carre...), ou l'arc-en-ciel (vide).
void draw_colors(uint32_t seed, std::vector<vec3>& out, std::string& label) {
    Rng r(seed ^ 0x9e3779b9u);
    auto W = [](int i) { return WHEEL[((i % 12) + 12) % 12]; };
    const float u = r.uni();
    const int h = r.below(12);
    out.clear();
    if (u < 0.22f) {
        if (r.uni() < 0.12f) {
            out = {WHITE};
            label = "1 couleur (blanc)";
        } else {
            out = {r.uni() < 0.3f ? GREEN : W(h)};
            label = "1 couleur";
        }
    } else if (u < 0.52f) {
        const int t = r.below(3);
        if (t == 0) { out = {W(h), W(h + 6)}; label = "2 couleurs complementaires"; }
        else if (t == 1) { out = {W(h), W(h + (r.uni() < 0.5f ? 2 : 3))}; label = "2 couleurs voisines"; }
        else { out = {W(h), WHITE}; label = "1 couleur + blanc"; }
    } else if (u < 0.77f) {
        const int t = r.below(4);
        if (t == 0) { out = {W(h), W(h + 4), W(h + 8)}; label = "3 couleurs en triade"; }
        else if (t == 1) { out = {W(h - 1), W(h), W(h + 1)}; label = "3 couleurs voisines"; }
        else if (t == 2) { out = {W(h), W(h + 5), W(h + 7)}; label = "3 couleurs (complementaires partagees)"; }
        else { out = {W(h), W(h + 6), WHITE}; label = "2 complementaires + blanc"; }
    } else if (u < 0.87f) {
        const int t = r.below(3);
        if (t == 0) { out = {W(h), W(h + 3), W(h + 6), W(h + 9)}; label = "4 couleurs en carre"; }
        else if (t == 1) { out = {W(h), W(h + 2), W(h + 6), W(h + 8)}; label = "4 couleurs en rectangle"; }
        else { out = {W(h), W(h + 1), W(h + 2), W(h + 3)}; label = "4 couleurs voisines"; }
    } else {
        label = "arc-en-ciel (toutes les teintes)";
    }
}

// Couleurs de la scene selon le mode : tirage, palette de la liste, ou palette personnalisee.
void resolve_colors(Spectacle& S) {
    if (S.color_mode == 0) {
        draw_colors(S.color_seed, S.colors, S.colors_label);
        return;
    }
    S.palette = std::clamp(S.palette, 0, SPECTACLE_PALETTE_COUNT);
    if (S.palette == SPECTACLE_PALETTE_COUNT) {
        if (S.custom.empty()) S.custom = {GREEN};
        S.colors = S.custom;
        S.colors_label = "palette personnalisee";
        return;
    }
    const SpectaclePalette& p = SPECTACLE_PALETTES[S.palette];
    S.colors.assign(p.c, p.c + p.n);
    S.colors_label = p.name;
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
    {"Horizon", "Une nappe continue a hauteur des yeux (nez de scene). Avec l'energie, elle se separe en couches qui ondulent, "
                "penchent et clignotent l'une apres l'autre.",
     {1.0f, 0.3f, 0.8f}},
    {"Plafond", "Nappes du pont au-dessus du public : un plafond de lumiere qui ondule, se balance et s'ouvre en accordeon.",
     {0.9f, 0.9f, 1.0f}},
    {"Cathedrale", "Eventails verticaux de traits du pont et du sol, ouverts en voute ; la lumiere monte le long des arches.",
     {0.8f, 0.3f, 1.0f}},
    {"Rideaux", "Murs de lumiere le long des 4 trusses, qui ondulent comme des rideaux ; les lignes s'ecartent et se rejoignent.",
     {0.2f, 1.0f, 0.6f}},
    {"Portiques", "Nappes en travers de la salle a 7 endroits : une vague court de la scene vers le fond, les portes s'allument "
                  "en sequence.",
     {0.6f, 0.4f, 1.0f}},
    {"Pluie", "Faisceaux verticaux des trusses ; ils derivent lentement, puis scintillent comme une averse.",
     {0.3f, 0.6f, 1.0f}},
    {"Convergence", "Faisceaux du pont, du sol, du nez et des trusses qui se rejoignent en un point ; le point tourne, puis "
                    "s'ouvre en couronne.",
     {1.0f, 0.9f, 0.3f}},
    {"Ciseaux", "Nappes verticales du pont, un laser sur deux en miroir : elles se croisent comme des lames ; le nez de scene "
                "repond.",
     {0.2f, 1.0f, 0.9f}},
    {"Rencontre", "Les deux moities du pont balaient en sens opposes et se rejoignent au centre ; les faisceaux du nez croisent "
                  "en sens inverse.",
     {1.0f, 0.35f, 0.6f}},
    {"Balayage", "Eventails de faisceaux du pont qui balaient le public a l'unisson ; le nez de scene contre-balaie.",
     {1.0f, 0.6f, 0.1f}},
    {"Radar", "Nappes du pont qui tournent sur elles-memes ; un secteur lumineux court sur chacune.",
     {0.5f, 0.4f, 1.0f}},
    {"Kaleidoscope", "Les nappes du pont passent toutes par un meme point, chacune tournee d'un angle : une etoile de plans "
                     "qui tourne.",
     {0.9f, 1.0f, 0.3f}},
    {"Helice", "Doubles eventails du pont qui tournent comme des helices, un sur deux en sens contraire.",
     {1.0f, 0.5f, 0.2f}},
    {"Tunnel", "Cones du pont vers le public : des tunnels qui tournent, respirent, et ou court une comete.",
     {0.3f, 1.0f, 0.3f}},
    {"Vortex", "Tunnels doubles du pont, demultiplies par diffraction, qui tournent en sens contraires.",
     {0.7f, 0.8f, 1.0f}},
    {"Rosace", "Cercles du pont disposes en anneau autour d'un point : une rosace qui tourne et respire.",
     {1.0f, 0.15f, 0.15f}},
    {"Spirale", "Cones du sol et du nez qui decrivent des cercles en decale : des spirales de couleur.",
     {1.0f, 0.85f, 0.6f}},
    {"Etoiles", "Etoiles du pont qui tournent en sens contraires ; diffraction et scintillement quand l'energie monte.",
     {0.2f, 0.7f, 1.0f}},
    {"Geometrie", "Carres, triangles et cercles alternes sur le pont, qui tournent ; par pas sur le temps a haute energie.",
     {1.0f, 0.3f, 1.0f}},
    {"Constellation", "Grilles de points en diffraction x9 au-dessus du public : un ciel d'etoiles qui derive, scintille et "
                      "saute.",
     {0.4f, 1.0f, 0.4f}},
    {"Diamants", "Faisceaux des trusses en diffraction x9 vers le sol : des nuees de points qui tournent et dansent.",
     {0.9f, 0.9f, 0.9f}},
    {"Vague", "Nappes ondulees du nez de scene ; les vagues defilent et une lumiere court dessus ; au maximum, le pont repond.",
     {0.7f, 0.2f, 1.0f}},
    {"Ressac", "Nappes du pont qui viennent mourir au sol devant le public et repartent, comme des vagues sur une plage.",
     {0.4f, 0.8f, 1.0f}},
    {"Aurore", "Grandes vagues lentes du pont vers le haut, couleurs qui defilent : une aurore boreale, toujours douce.",
     {0.2f, 1.0f, 0.7f}},
    {"Chenillard", "Faisceaux des trusses : une lumiere court le long de chaque ligne et revient, les lignes en sens opposes.",
     {1.0f, 0.8f, 0.1f}},
    {"Pulsation", "Nappes du pont et cones du nez qui s'ouvrent et se ferment ensemble, sur le temps.",
     {1.0f, 0.4f, 0.7f}},
    {"Etincelles", "Faisceaux et petits eventails du pont et des trusses qui scintillent et sautent : un feu d'artifice.",
     {1.0f, 0.4f, 0.1f}},
    {"Mur de lumiere", "Lames verticales du nez et du sol devant la scene, qui s'ouvrent comme des portes et se croisent.",
     {0.8f, 0.9f, 0.3f}},
    {"Toile", "Eventails de traits du pont vers le sol et du nez vers le haut, qui se croisent en filet.",
     {0.8f, 1.0f, 0.2f}},
    {"Grand final", "Tout en meme temps : ciseaux du pont, chenillard des trusses, faisceaux du nez en miroir, helices du sol.",
     {0.5f, 0.7f, 1.0f}},
};

const SpectaclePalette SPECTACLE_PALETTES[] = {
    {"Vert", 1, {GREEN}},
    {"Rouge", 1, {RED}},
    {"Bleu", 1, {BLUE}},
    {"Cyan", 1, {CYAN}},
    {"Rose", 1, {PINK}},
    {"Orange", 1, {ORANGE}},
    {"Violet", 1, {PURPLE}},
    {"Jaune", 1, {YELLOW}},
    {"Blanc", 1, {WHITE}},
    {"Rouge + orange", 2, {RED, ORANGE}},
    {"Orange + bleu", 2, {ORANGE, BLUE}},
    {"Rose + violet", 2, {PINK, PURPLE}},
    {"Cyan + magenta", 2, {CYAN, MAGENTA}},
    {"Vert + bleu", 2, {GREEN, BLUE}},
    {"Vert + jaune", 2, {GREEN, YELLOW}},
    {"Rouge + blanc", 2, {RED, WHITE}},
    {"Bleu + blanc", 2, {BLUE, WHITE}},
    {"Rose + cyan", 2, {PINK, CYAN}},
    {"Jaune + violet", 2, {YELLOW, PURPLE}},
    {"Feu (rouge, orange, jaune)", 3, {RED, ORANGE, YELLOW}},
    {"Coucher de soleil (orange, rose, violet)", 3, {ORANGE, PINK, PURPLE}},
    {"Ocean (bleu, cyan, turquoise)", 3, {BLUE, CYAN, TURQ}},
    {"Neon (rose, cyan, violet)", 3, {PINK, CYAN, PURPLE}},
    {"Tricolore (bleu, blanc, rouge)", 3, {BLUE, WHITE, RED}},
    {"Glace (blanc, bleu glace, bleu)", 3, {WHITE, ICE, BLUE}},
    {"RVB (rouge, vert, bleu)", 3, {RED, GREEN, BLUE}},
    {"Foret (vert, citron, turquoise)", 3, {GREEN, LIME, TURQ}},
    {"Synthwave (magenta, violet, cyan, orange)", 4, {MAGENTA, PURPLE, CYAN, ORANGE}},
    {"Tropical (vert, jaune, orange, rose)", 4, {GREEN, YELLOW, ORANGE, PINK}},
    {"Bonbons (rose, bleu glace, jaune, lilas)", 4, {PINK, ICE, YELLOW, LILAC}},
    {"Arc-en-ciel (toutes les teintes)", 0, {}},
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
    g.rainbow = S.colors.empty();
    if (g.rainbow) g.pal.assign(WHEEL, WHEEL + 12);
    else g.pal = S.colors;
    lr.palette = g.pal;
    rig.palette = g.pal;
    SCENE_FN[S.scene](g);
    lyres_for_scene(g, S.scene);
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
    S.color_mode = r.uni() < 0.5f ? 0 : 1;
    S.palette = r.below(SPECTACLE_PALETTE_COUNT);
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
    if (S.color_mode == 0) S.color_seed = r.next();
    spectacle_apply(lr, true);
}

void spectacle_start(LaserRig& lr) {
    Spectacle& S = g_spectacle;
    if (!S.start_requested) return;
    S.start_requested = false;
    spectacle_apply(lr, true);
}

// --set : spectacle=N (1 a 30 : lance la scene N), spenergie, sptempo (0 : selon l'energie), spcouleurs (0 tirage,
// 1 palette), sppalette=N (1 a la derniere : personnalisee), spperso=r,g,b/r,g,b/... (palette personnalisee),
// sptirage=n (tirage des couleurs), spgraine=n (variantes), spaleatoire=n (tout tire au hasard, graine n), spauto,
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
        S.color_mode = v != 0 ? 1 : 0;
    } else if (k == "sppalette") {
        S.palette = std::clamp((int)v - 1, 0, SPECTACLE_PALETTE_COUNT);
        S.color_mode = 1;
    } else if (k == "spperso") {
        std::vector<vec3> c;
        for (const char* p = value; *p;) {
            vec3 x;
            if (std::sscanf(p, "%f,%f,%f", &x.x, &x.y, &x.z) == 3) c.push_back(x);
            while (*p && *p != '/') p++;
            if (*p == '/') p++;
        }
        if (!c.empty()) {
            if (c.size() > 6) c.resize(6);
            S.custom = c;
            S.palette = SPECTACLE_PALETTE_COUNT;
            S.color_mode = 1;
        }
    } else if (k == "sptirage") {
        S.color_seed = (uint32_t)v;
        S.color_mode = 0;
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
//  Interface (onglet Lasers)
// =============================================================================================
namespace {
ImU32 to_u32(vec3 c) {
    return ImGui::ColorConvertFloat4ToU32(ImVec4(clampf(c.x, 0, 1), clampf(c.y, 0, 1), clampf(c.z, 0, 1), 1));
}
// petites cases de couleur a partir de 'p' (vide : arc-en-ciel)
void swatches_at(ImDrawList* dl, ImVec2 p, const std::vector<vec3>& c, float sz) {
    if (c.empty()) {
        for (int i = 0; i < 12; i++) {
            const float x = p.x + (float)i * sz * 0.5f;
            dl->AddRectFilled(ImVec2(x, p.y), ImVec2(x + sz * 0.5f, p.y + sz), to_u32(hsv2rgb((float)i / 12.0f, 1, 1)));
        }
        return;
    }
    for (size_t i = 0; i < c.size(); i++) {
        const float x = p.x + (float)i * (sz + 3);
        dl->AddRectFilled(ImVec2(x, p.y), ImVec2(x + sz, p.y + sz), to_u32(c[i]), 2.0f);
    }
}
void swatches(const std::vector<vec3>& c) {
    const float sz = ImGui::GetTextLineHeight();
    const ImVec2 p = ImGui::GetCursorScreenPos();
    swatches_at(ImGui::GetWindowDrawList(), p, c, sz);
    ImGui::Dummy(ImVec2(c.empty() ? 6 * sz : (float)c.size() * (sz + 3), sz));
}
// Ce que font les lyres de chaque scene (lyres_for_scene), pour l'infobulle.
const char* const LYRES_DESC[SPECTACLE_SCENES] = {
    "lavage doux du sol par les trusses, vague de tilt.",
    "faisceaux serres des trusses qui tournent en cercles a travers le plafond laser.",
    "colonnes de faisceaux du sol et du nez en eventail, lavage doux des trusses.",
    "gobos barres au sol qui tournent.",
    "faisceaux des trusses, vague de tilt de la scene vers le fond avec les portes.",
    "gobos breakup au sol (gouttes) qui tournent.",
    "pont et trusses visent le meme point que les lasers ; couronne qui tourne.",
    "faisceaux des trusses en ciseaux, un sur deux en sens opposes.",
    "faisceaux du sol et du nez en eventail qui s'ouvre et se referme.",
    "faisceaux du pont qui balaient le public a l'unisson.",
    "prismes lineaires du pont qui tournent.",
    "gobos fleur et prismes 6 au sol, en rotation.",
    "prismes 3 du pont qui tournent en sens contraires.",
    "faisceaux des trusses vers un point du public : un cone, puis un anneau qui tourne.",
    "gobos spirale au sol qui tournent.",
    "gobos cercle de points au sol.",
    "faisceaux des trusses qui tournent en cercles decales : spirale.",
    "gobos etoile au sol qui tournent.",
    "gobos triangles et prismes 3 au sol.",
    "gobos points au sol qui scintillent.",
    "prismes en grille 3 x 3 du pont : des nuees de faisceaux.",
    "lavage du sol en vague de la scene vers le fond.",
    "lavage du sol qui monte et redescend comme la mer.",
    "lavage tres doux qui change lentement de couleur.",
    "faisceaux du pont : une lumiere court de l'un a l'autre.",
    "faisceaux des trusses dont le zoom bat avec les lasers.",
    "faisceaux fins dans tous les sens qui scintillent.",
    "colonnes verticales du sol et du nez en eventail.",
    "faisceaux des trusses en huit.",
    "trusses en cercles, prismes 8 du pont, faisceaux du sol et du nez en eventail.",
};

std::vector<vec3> palette_colors(int i) {
    if (i >= SPECTACLE_PALETTE_COUNT) return g_spectacle.custom;
    return std::vector<vec3>(SPECTACLE_PALETTES[i].c, SPECTACLE_PALETTES[i].c + SPECTACLE_PALETTES[i].n);
}
}  // namespace

void spectacle_ui(LaserRig& lr) {
    Spectacle& S = g_spectacle;
    ImGui::SeparatorText("Spectacles : lyres + lasers (generateur de scenes)");
    ImGui::PushStyleColor(ImGuiCol_Text, ImGui::GetStyleColorVec4(ImGuiCol_TextDisabled));
    ImGui::TextWrapped("Comme une ambiance, une scene change toutes les lumieres d'un coup, selon l'energie et les couleurs "
                       "choisies ici.");
    ImGui::PopStyleColor();
    bool changed = false, restart = false;
    if (ImGui::Button("Aleatoire##sp")) {
        spectacle_draw((uint32_t)(ImGui::GetTime() * 1000.0) ^ (S.seed * 7u));
        restart = true;
    }
    ImGui::SetItemTooltip("Tire une scene, une energie et des couleurs (tirage ou palette), puis lance la scene.");
    ImGui::SameLine();
    if (ImGui::Button("< Precedente##sp")) { S.scene = (S.scene + SPECTACLE_SCENES - 1) % SPECTACLE_SCENES; restart = true; }
    ImGui::SameLine();
    if (ImGui::Button("Suivante >##sp")) { S.scene = (S.scene + 1) % SPECTACLE_SCENES; restart = true; }
    ImGui::SameLine();
    if (ImGui::Button("Relancer##sp")) restart = true;
    ImGui::SameLine();
    if (ImGui::Button("Noir##sp")) spectacle_stop(lr);

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

    // couleurs
    {
        changed |= ImGui::RadioButton("Couleurs au hasard##sp", &S.color_mode, 0);
        ImGui::SameLine();
        changed |= ImGui::RadioButton("Palette##sp", &S.color_mode, 1);
        if (S.color_mode == 0) {
            if (ImGui::Button("Nouveau tirage##sp")) {
                S.color_seed = S.color_seed * 1664525u + 1013904223u;
                changed = true;
            }
            ImGui::SameLine();
            std::vector<vec3> c;
            std::string label;
            draw_colors(S.color_seed, c, label);
            swatches(c);
            ImGui::SameLine();
            ImGui::TextDisabled("%s", label.c_str());
        } else {
            S.palette = std::clamp(S.palette, 0, SPECTACLE_PALETTE_COUNT);
            const char* cur = S.palette < SPECTACLE_PALETTE_COUNT ? SPECTACLE_PALETTES[S.palette].name : "Personnalisee";
            if (ImGui::BeginCombo("Palette##spp", cur, ImGuiComboFlags_HeightLarge)) {
                const float sz = ImGui::GetTextLineHeight();
                for (int i = 0; i <= SPECTACLE_PALETTE_COUNT; i++) {
                    ImGui::PushID(i);
                    const ImVec2 p = ImGui::GetCursorScreenPos();
                    char label[96];
                    std::snprintf(label, sizeof(label), "            %s", i < SPECTACLE_PALETTE_COUNT ? SPECTACLE_PALETTES[i].name : "Personnalisee");
                    if (ImGui::Selectable(label, i == S.palette)) {
                        S.palette = i;
                        changed = true;
                    }
                    swatches_at(ImGui::GetWindowDrawList(), ImVec2(p.x, p.y + 1), palette_colors(i), sz * 0.85f);
                    ImGui::PopID();
                }
                ImGui::EndCombo();
            }
            if (S.palette == SPECTACLE_PALETTE_COUNT) {
                // palette personnalisee : 1 a 6 couleurs
                int remove = -1;
                for (int i = 0; i < (int)S.custom.size(); i++) {
                    ImGui::PushID(i);
                    char id[32];
                    std::snprintf(id, sizeof(id), "Couleur %d##spc", i + 1);
                    changed |= ImGui::ColorEdit3(id, &S.custom[(size_t)i].x, ImGuiColorEditFlags_NoInputs);
                    if (S.custom.size() > 1) {
                        ImGui::SameLine();
                        if (ImGui::SmallButton("x")) remove = i;
                    }
                    if (i + 1 < (int)S.custom.size() && (i % 3) != 2) ImGui::SameLine();
                    ImGui::PopID();
                }
                if (remove >= 0) {
                    S.custom.erase(S.custom.begin() + remove);
                    changed = true;
                }
                if (S.custom.size() < 6) {
                    if (ImGui::SmallButton("+ couleur##spc")) {
                        S.custom.push_back(WHEEL[(S.custom.size() * 5) % 12]);
                        changed = true;
                    }
                }
            } else {
                swatches(palette_colors(S.palette));
            }
        }
    }

    // enchainement
    ImGui::Checkbox("Enchainer les scenes##sp", &S.auto_next);
    ImGui::SetItemTooltip("Une autre scene au hasard toutes les N mesures (4 temps), avec un nouveau tirage de couleurs en mode\n"
                          "\"Couleurs au hasard\". S'arrete si on change le programme des lasers (ambiance, effets).");
    if (S.auto_next) {
        ImGui::SameLine();
        ImGui::SetNextItemWidth(150);
        if (ImGui::SliderFloat("##spbars", &S.auto_bars, 1, 32, "%.0f mesures")) S.next_change = S.beats + 4.0 * S.auto_bars;
    }

    // les 30 scenes : gros boutons teintes, comme les ambiances (le bas du bouton : couleurs en cours)
    {
        const float sp = ImGui::GetStyle().ItemSpacing.x;
        const float w = (ImGui::GetContentRegionAvail().x - sp * (AMBIANCE_COLS - 1)) / AMBIANCE_COLS;
        const float h = 3.2f * ImGui::GetTextLineHeightWithSpacing();
        ImDrawList* dl = ImGui::GetWindowDrawList();
        for (int i = 0; i < SPECTACLE_SCENES; i++) {
            if (i % AMBIANCE_COLS != 0) ImGui::SameLine();
            const vec3 t = SPECTACLE_SCENE_INFO[i].tint;
            const bool cur = S.running && i == S.scene;
            const float k = cur ? 0.5f : 0.18f;
            ImGui::PushStyleColor(ImGuiCol_Button, ImVec4(0.08f + t.x * k, 0.08f + t.y * k, 0.09f + t.z * k, 1));
            ImGui::PushStyleColor(ImGuiCol_ButtonHovered, ImVec4(0.1f + t.x * 0.4f, 0.1f + t.y * 0.4f, 0.11f + t.z * 0.4f, 1));
            ImGui::PushStyleColor(ImGuiCol_ButtonActive, ImVec4(0.15f + t.x * 0.6f, 0.15f + t.y * 0.6f, 0.15f + t.z * 0.6f, 1));
            char id[64];
            std::snprintf(id, sizeof(id), "S%d\n%s##sps%d", i + 1, SPECTACLE_SCENE_INFO[i].name, i);
            if (ImGui::Button(id, ImVec2(w, h))) {
                S.scene = i;
                restart = true;
            }
            ImGui::PopStyleColor(3);
            if (ImGui::IsItemHovered()) ImGui::SetTooltip("%s\nLyres : %s", SPECTACLE_SCENE_INFO[i].description, LYRES_DESC[i]);
            const ImVec2 mn = ImGui::GetItemRectMin(), mx = ImGui::GetItemRectMax();
            dl->AddRectFilled(ImVec2(mn.x + 5, mx.y - 7), ImVec2(mx.x - 5, mx.y - 4), to_u32(t), 2);
            if (cur) dl->AddRect(mn, mx, IM_COL32(255, 255, 255, 230), ImGui::GetStyle().FrameRounding, 0, 2.0f);
        }
    }

    // en cours
    if (S.running) {
        ImGui::Spacing();
        ImGui::SeparatorText("En cours");
        ImGui::Text("S%d. %s", S.scene + 1, SPECTACLE_SCENE_INFO[S.scene].name);
        ImGui::SameLine();
        swatches(S.colors);
        ImGui::TextWrapped("%s Lyres : %s", SPECTACLE_SCENE_INFO[S.scene].description, LYRES_DESC[S.scene]);
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
