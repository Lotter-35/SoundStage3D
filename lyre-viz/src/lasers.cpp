#include "lasers.h"
#include <algorithm>
#include <functional>

const char* LASER_PATTERN_NAMES[LP_COUNT] = {"eteints", "eventails 1000 traits (L1)", "cones 32 segments (L2)",
                                             "rideaux autour de la camera (L3)", "8 traits separes (L4)",
                                             "nappes fixes, gros plan (L5)", "vers le sol et les obstacles (L6)",
                                             "programmeur"};
const char* LASER_SHAPE_NAMES[LS_COUNT] = {"Eventail", "Double eventail", "Cone", "Tunnel", "Vague", "Grille de points"};
const char* LASER_GRADIENT_NAMES[LG_COUNT] = {"Uni", "2 couleurs", "3 couleurs", "Defilant", "Arc-en-ciel", "Aleatoire par trait"};
const char* LASER_EFFECT_NAMES[LFX_COUNT] = {"Vague pan", "Vague tilt", "Cercle (pan/tilt)", "Huit", "Balayage aleatoire",
                                             "Eventail des figures",
                                             "Roulis", "Pulsation de l'ouverture", "Chenillard de traits",
                                             "Chenillard d'intensite", "Arc-en-ciel", "Alternance de couleurs"};

namespace {

// Distance le long de d (unitaire) pour sortir de la boite [mn, mx], depuis p (dedans).
float exit_distance(vec3 p, vec3 d, vec3 mn, vec3 mx) {
    float t = 1e30f;
    for (int a = 0; a < 3; a++) {
        if (d[a] > 1e-6f) t = std::min(t, (mx[a] - p[a]) / d[a]);
        else if (d[a] < -1e-6f) t = std::min(t, (mn[a] - p[a]) / d[a]);
    }
    return std::max(t, 0.0f);
}

// Une direction perpendiculaire a 'a' (unitaire), stable.
vec3 any_perp(vec3 a) {
    const vec3 r = std::fabs(a.y) < 0.9f ? vec3(0, 1, 0) : vec3(1, 0, 0);
    return normalize(cross(a, r));
}

// Teinte pseudo-aleatoire stable (degrade "aleatoire par trait").
float hash01(int i) {
    uint32_t h = (uint32_t)i * 747796405u + 2891336453u;
    h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
    return (float)((h >> 22u) ^ h) / 4294967296.0f;
}

// Bruit lisse de -1 a 1 (une nouvelle valeur par cycle, raccord en S) : balayage aleatoire.
float smooth_noise(int seed, float t) {
    const float fl = std::floor(t);
    const int i = (int)fl;
    const float f = t - fl, u = f * f * (3.0f - 2.0f * f);
    const float a = hash01(seed * 7919 + i), b = hash01(seed * 7919 + i + 1);
    return 2.0f * (a + (b - a) * u) - 1.0f;
}

// Couleur (et intensite) le long d'une figure : t de 0 (bord 0) a 1 (bord 1), ou autour d'un cercle.
using Profile = std::function<vec3(float)>;

struct Builder {
    std::vector<LaserSegment>& segs;
    vec3 mn, mx;
    int traits = 0;

    // Un segment : portee = le plus loin que l'eventail va avant de sortir du hangar (5 directions).
    void seg(vec3 S, vec3 ec, vec3 es, float ha, int n, vec3 f0, vec3 f1) {
        if (segs.size() >= 8192) return;
        const float c1 = std::cos(0.5f * ha), s1 = std::sin(0.5f * ha), c2 = std::cos(ha), s2 = std::sin(ha);
        float R = exit_distance(S, ec, mn, mx);
        if (ha > 0.0f) {
            for (int sg = -1; sg <= 1; sg += 2) {
                R = std::max(R, exit_distance(S, ec * c1 + es * (s1 * sg), mn, mx));
                R = std::max(R, exit_distance(S, ec * c2 + es * (s2 * sg), mn, mx));
            }
        }
        LaserSegment s;
        s.src = S;
        s.range = std::min(R, 160.0f);
        s.ec = ec;
        s.half_angle = n > 1 ? ha : 0.0f;
        s.es = es;
        s.traits = (float)std::max(n, 1);
        s.flux = f0;
        s.pad = 0;
        s.flux1 = f1;
        s.pad1 = 0;
        segs.push_back(s);
        traits += std::max(n, 1);
    }

    // Eventail de n traits (milieu ec, plan (ec, es), demi-ouverture ha), puissance P, couleur prof(t) entre
    // t0 et t1. Peu de traits (16 au plus) : un segment par trait (a l'ecran, une bande fine ; le rendu
    // rejette en 3 operations les pixels hors de la bande). Sinon K morceaux, chacun en degrade lineaire.
    void fan(vec3 S, vec3 ec, vec3 es, float ha, int n, float P, const Profile& prof, int K = 1, float t0 = 0, float t1 = 1,
             bool flat = false) {
        ha = clampf(ha, 0.0f, 60.0f * DEG);
        n = std::max(n, 1);
        if (n == 1 || ha <= 0.0f) {
            const vec3 c = prof(0.5f * (t0 + t1)) * P;
            seg(S, ec, es, 0.0f, n, c, c);
            return;
        }
        const float da = 2.0f * ha / (float)(n - 1);
        if (n <= 16) {
            for (int k = 0; k < n; k++) {
                const float a = -ha + da * (float)k;
                const vec3 c = prof(t0 + (t1 - t0) * (k + 0.5f) / n) * (P / (float)n);
                seg(S, ec * std::cos(a) + es * std::sin(a), es * std::cos(a) - ec * std::sin(a), 0.0f, 1, c, c);
            }
            return;
        }
        K = std::clamp(K, 1, n / 2);
        for (int k = 0; k < K; k++) {
            const int j0 = k * n / K, j1 = (k + 1) * n / K - 1, nk = j1 - j0 + 1;
            const float a = -ha + da * 0.5f * (float)(j0 + j1), half = da * 0.5f * (float)(j1 - j0);
            const float tl = t0 + (t1 - t0) * (float)j0 / n, th = t0 + (t1 - t0) * (float)(j1 + 1) / n;
            const float w = P * (float)nk / (float)n;
            vec3 c0 = prof(tl) * w, c1 = prof(th) * w;
            if (flat) c0 = c1 = prof(0.5f * (tl + th)) * w;   // un aplat par morceau (aleatoire)
            seg(S, ec * std::cos(a) + es * std::sin(a), es * std::cos(a) - ec * std::sin(a), half, nk, c0, c1);
        }
    }

    // Ancienne forme (motifs du banc) : couleur uniforme, flux = puissance de toute la figure.
    void fan(vec3 S, vec3 ec, vec3 es, float ha, int n, vec3 flux) {
        const float P = std::max(std::max(flux.x, flux.y), std::max(flux.z, 1e-9f));
        fan(S, ec, es, ha, n, P, [&](float) { return flux * (1.0f / P); });
    }
    // Eventail dont le plan tourne de 'roll' autour de ec (0 : es horizontal si possible).
    void fan_roll(vec3 S, vec3 ec, float roll, float ha, int n, vec3 flux) {
        const vec3 r0 = any_perp(ec), r1 = cross(ec, r0);
        fan(S, ec, r0 * std::cos(roll) + r1 * std::sin(roll), ha, n, flux);
    }

    // Ligne brisee de directions D[0..m] (traits regulierement repartis, aucun double aux jonctions) : un
    // morceau plan par intervalle, n traits en tout, couleur prof aux points tt[i].
    void polyline(vec3 S, const vec3* D, const float* tt, int m, int n, float P, const Profile& prof, bool flat) {
        const int per = std::max(1, n / m);
        for (int j = 0; j < m; j++) {
            const vec3 d0 = D[j], d1 = D[j + 1];
            const float ang = std::acos(clampf(dot(d0, d1), -1.0f, 1.0f));
            const float half = 0.5f * ang * (float)(per - 1) / (float)per;
            const float w = P / (float)m;
            vec3 c0 = prof(tt[j]) * w, c1 = prof(tt[j + 1]) * w;
            if (flat) c0 = c1 = prof(0.5f * (tt[j] + tt[j + 1])) * w;
            const vec3 ec = normalize(d0 + d1);
            const vec3 es = ang > 1e-6f ? normalize(d1 - d0) : any_perp(ec);
            if (per == 1) seg(S, ec, es, 0.0f, 1, c0 * 0.5f + c1 * 0.5f, c0 * 0.5f + c1 * 0.5f);
            else seg(S, ec, es, half, per, c0, c1);
        }
    }

    // Cone de traits (cercle) : nseg morceaux plans dont les bouts sont sur le cone.
    void cone(vec3 S, vec3 axis, vec3 u, float half_cone, int nseg, int n_total, float spin, float P, const Profile& prof, bool flat) {
        const vec3 w = cross(axis, u);
        nseg = std::clamp(nseg, 1, 64);
        const float cb = std::cos(half_cone), sb = std::sin(half_cone);
        vec3 D[65];
        float tt[65];
        for (int j = 0; j <= nseg; j++) {
            const float a = spin + 2 * PI * j / nseg;
            D[j] = axis * cb + (u * std::cos(a) + w * std::sin(a)) * sb;
            tt[j] = (float)j / (float)nseg;
        }
        polyline(S, D, tt, nseg, n_total, P, prof, flat);
    }
    // Ancienne forme (motifs du banc).
    void cone(vec3 S, vec3 axis, float half_cone, int nseg, int n_total, float spin, vec3 flux) {
        const float P = std::max(std::max(flux.x, flux.y), std::max(flux.z, 1e-9f));
        cone(S, axis, any_perp(axis), half_cone, nseg, n_total, spin, P, [&](float) { return flux * (1.0f / P); }, false);
    }
};

const vec3 GROUP_COLORS[7] = {{0, 1, 0}, {1, 0, 0}, {0.1f, 0.35f, 1}, {0, 1, 0}, {1, 0.75f, 0}, {1, 0, 0.8f}, {0, 0.9f, 1}};

}  // namespace

// ---------------------------------------------------------------------------------------------
//  Emplacements, boitiers, selection
// ---------------------------------------------------------------------------------------------
void LaserRig::build(const Scene& scene) {
    mounts.clear();
    fixtures.clear();
    effects.clear();
    group_names = scene.group_names;
    // trusses (memes lignes que les lyres, a mi-chemin entre deux lyres, un peu plus bas)
    const float trussY = 18.0f;
    const float trussZ[4] = {-15, -5, 5, 15};
    const float tx0 = -30, tx1 = 46;
    const int perLine = 42;
    for (int l = 0; l < 4; l++)
        for (int i = 0; i < perLine; i++) {
            const float x = tx0 + (tx1 - tx0) * (i + 1.0f) / perLine;
            mounts.push_back({{x, trussY - 0.45f, trussZ[l]}, {0, -1, 0}, l});
        }
    // pont de scene
    for (int i = 0; i < 16; i++) mounts.push_back({{-42, 12.0f - 0.45f, -16 + 32 * (i + 1.0f) / 17}, {0, -1, 0}, 4});
    // sol de scene, nez de scene
    for (int i = 0; i < 8; i++) mounts.push_back({{-45, 1.6f + 0.25f, -14 + 28 * (i + 1.0f) / 9}, {0, 1, 0}, 5});
    for (int i = 0; i < 8; i++) mounts.push_back({{-34.5f, 1.6f + 0.25f, -14 + 28 * (i + 1.0f) / 9}, {0, 1, 0}, 6});
    // boitiers : axe d'accroche par groupe (trusses : vers le bas, penche de 25 deg vers le public ; pont :
    // vers le public, 12 deg sous l'horizontale ; sol et nez de scene : vers le public, 15 et 5 deg au-dessus)
    for (const LaserMount& m : mounts) {
        LaserFixture f;
        f.mount = m;
        float el;   // elevation de l'axe (deg), vers +X (le public)
        switch (m.group) {
            case 4: el = -12; break;
            case 5: el = 15; break;
            case 6: el = 5; break;
            default: el = -65; break;
        }
        f.aim = normalize(vec3(std::cos(el * DEG), std::sin(el * DEG), 0));
        f.right = normalize(cross(f.aim, vec3(0, 1, 0)));
        f.up = cross(f.right, f.aim);
        fixtures.push_back(f);
    }
    program_default();
}

int LaserRig::first_selected() const {
    for (size_t i = 0; i < fixtures.size(); i++) if (fixtures[i].selected) return (int)i;
    return -1;
}
int LaserRig::selected_count() const {
    int n = 0;
    for (const LaserFixture& f : fixtures) n += f.selected ? 1 : 0;
    return n;
}
void LaserRig::select_group(int group, bool additive) {
    for (LaserFixture& f : fixtures) {
        if (f.mount.group == group) f.selected = true;
        else if (!additive) f.selected = false;
    }
}
void LaserRig::select_all(bool v) { for (LaserFixture& f : fixtures) f.selected = v; }
void LaserRig::invert_selection() { for (LaserFixture& f : fixtures) f.selected = !f.selected; }
void LaserRig::select_odd_even(bool odd) {
    int k = 0;
    for (LaserFixture& f : fixtures) {
        if (!f.selected) continue;
        f.selected = ((k & 1) == 1) == odd;
        k++;
    }
}

void LaserRig::add_effect(int type) {
    Effect e;
    e.type = type;
    e.name = LASER_EFFECT_NAMES[type];
    for (size_t i = 0; i < fixtures.size(); i++) if (fixtures[i].selected) e.fixtures.push_back((int)i);
    switch (type) {
        case LFX_PAN_WAVE: case LFX_TILT_WAVE: e.size = 15; e.speed = 0.2f; break;
        case LFX_CIRCLE: e.size = 10; e.speed = 0.25f; break;
        case LFX_FIGURE8: e.size = 12; e.speed = 0.15f; break;
        case LFX_RANDOM: e.size = 12; e.speed = 0.6f; break;
        case LFX_SPREAD: e.size = 20; e.speed = 0; e.spread = 0; break;
        case LFX_ROLL: e.size = 45; e.speed = 0.15f; break;
        case LFX_OPENING: e.size = 0.6f; e.speed = 0.3f; break;
        case LFX_TRAIT_CHASE: e.size = 0.2f; e.speed = 0.5f; e.wave = WAVE_SAW; e.spread = 0; break;
        case LFX_DIMMER_CHASE: e.size = 1; e.speed = 1; e.wave = WAVE_SQUARE; e.duty = 0.3f; break;
        case LFX_RAINBOW: e.speed = 0.1f; e.size = 1; break;
        case LFX_COLOR_ALT: e.speed = 0.5f; e.wave = WAVE_SQUARE; e.color_a = {0, 1, 0}; e.color_b = {0, 0.3f, 1}; break;
    }
    effects.push_back(e);
}

// Au lancement : le pont et le nez de scene en eventails verts qui balaient lentement ; le reste eteint.
void LaserRig::program_default() {
    effects.clear();
    for (LaserFixture& f : fixtures) {
        f.base = LaserParams();
        f.base.dimmer = 0;
        f.base.color = GROUP_COLORS[f.mount.group];
        f.selected = false;
        if (f.mount.group == 4 || f.mount.group == 6) {
            f.base.dimmer = 1;
            f.base.traits = 300;
            f.base.opening = 50;
            f.selected = true;
        }
    }
    add_effect(LFX_TILT_WAVE);
    effects.back().size = 8;
    effects.back().speed = 0.12f;
    select_all(false);
}

// Toutes les formes, degrades et effets sur les 200 boitiers (vue --demo-laser 0, cas L7 du banc).
void LaserRig::program_showcase() {
    effects.clear();
    for (LaserFixture& f : fixtures) {
        LaserParams& p = f.base;
        p = LaserParams();
        f.selected = false;
        switch (f.mount.group) {
            case 0:   // eventails 1000 traits, arc-en-ciel qui defile, rotation continue
                p.shape = LS_FAN; p.traits = 1000; p.opening = 50; p.gradient = LG_RAINBOW; p.roll_speed = 25; break;
            case 1:   // cones, 3 couleurs
                p.shape = LS_CONE; p.traits = 600; p.opening = 20; p.gradient = LG_THREE;
                p.color = {1, 0, 0}; p.color2 = {1, 0.8f, 0}; p.color3 = {0, 1, 0}; break;
            case 2:   // doubles eventails, 2 couleurs
                p.shape = LS_DOUBLE_FAN; p.traits = 400; p.opening = 40; p.gradient = LG_TWO;
                p.color = {0, 0.3f, 1}; p.color2 = {1, 0, 0.8f}; p.shape_param = 8; break;
            case 3:   // vagues vertes, chenillard de traits
                p.shape = LS_WAVE; p.traits = 500; p.opening = 50; p.color = {0, 1, 0.1f}; p.shape_param = 4; p.wave_cycles = 3; break;
            case 4:   // grilles de points, diffraction x3
                p.shape = LS_GRID; p.traits = 25; p.opening = 16; p.shape_param = 5; p.color = {1, 0.85f, 0.2f};
                p.diffraction = 3; p.diffraction_angle = 18; break;
            case 5:   // tunnels rouge -> orange
                p.shape = LS_TUNNEL; p.traits = 800; p.opening = 24; p.gradient = LG_TWO; p.color = {1, 0, 0}; p.color2 = {1, 0.45f, 0}; break;
            default:  // nez de scene : 8 traits, couleurs aleatoires par trait
                p.shape = LS_FAN; p.traits = 8; p.opening = 40; p.gradient = LG_RANDOM; break;
        }
    }
    auto fx = [&](int group, int type, float size, float speed, float spread) {
        select_group(group, false);
        add_effect(type);
        Effect& e = effects.back();
        e.size = size;
        e.speed = speed;
        e.spread = spread;
    };
    fx(0, LFX_PAN_WAVE, 15, 0.12f, 360);
    fx(1, LFX_CIRCLE, 10, 0.2f, 360);
    fx(2, LFX_TILT_WAVE, 12, 0.15f, 180);
    fx(3, LFX_TRAIT_CHASE, 0.25f, 0.4f, 90);
    fx(4, LFX_SPREAD, 25, 0, 0);
    fx(5, LFX_OPENING, 0.5f, 0.25f, 180);
    fx(6, LFX_DIMMER_CHASE, 1, 1, 360);
    select_all(false);
}

// ---------------------------------------------------------------------------------------------
//  Corps des boitiers
// ---------------------------------------------------------------------------------------------
void LaserRig::housings(std::vector<Instance>& cubes) const {
    if (!show_housings || pattern == LP_OFF) return;
    const vec3 body = {0.035f, 0.035f, 0.04f};
    for (const LaserFixture& f : fixtures) {
        // pave de 32 x 20 x 26 cm, sortie sur la face avant
        cubes.push_back(make_instance(f.mount.pos, f.aim * 0.16f, f.up * 0.10f, f.right * 0.13f, body, 0.5f));
        cubes.push_back(make_instance(f.mount.pos + f.aim * 0.162f, f.aim * 0.004f, f.up * 0.025f, f.right * 0.04f, {0.01f, 0.01f, 0.012f}, 0.2f));
    }
}

// ---------------------------------------------------------------------------------------------
//  Figures : motifs du banc, ou programmeur
// ---------------------------------------------------------------------------------------------
void LaserRig::update(float t, float dt, vec3 hall_min, vec3 hall_max) {
    segs.clear();
    Builder b{segs, hall_min, hall_max};
    lit = 0;
    total_traits = 0;
    time += dt;
    const int N = (int)mounts.size();
    const float TAU = 2 * PI;
    if (pattern == LP_OFF) return;
    if (pattern != LP_PROGRAM) {
        const int on = std::clamp(count, 0, N);
        for (int i = 0; i < N && on > 0; i++) {
            // 'on' boitiers repartis regulierement sur les emplacements
            if ((long long)(i + 1) * on / N == (long long)i * on / N) continue;
            lit++;
            const LaserMount& m = mounts[i];
            const float ph = i * 0.37f + m.group * 1.3f;
            const vec3 flux = GROUP_COLORS[m.group] * power_w;
            const bool hanging = m.n.y < 0;
            const vec3 S = m.pos + m.n * 0.12f;
            switch (pattern) {
                case LP_FANS:
                case LP_BEAMS: {
                    // balayage (tilt et pan en sinus) et rotation continue du plan de l'eventail
                    vec3 ec;
                    if (hanging) {
                        const float th = (30.0f + 20.0f * std::sin(TAU * 0.13f * t + ph)) * DEG;
                        const float ps = 25.0f * DEG * std::sin(TAU * 0.09f * t + 1.7f * ph);
                        ec = {std::sin(th) * std::cos(ps), -std::cos(th), std::sin(th) * std::sin(ps)};
                    } else {
                        const float el = (22.0f + 12.0f * std::sin(TAU * 0.11f * t + ph)) * DEG;
                        const float ps = 30.0f * DEG * std::sin(TAU * 0.07f * t + 1.3f * ph);
                        ec = {std::cos(el) * std::cos(ps), std::sin(el), std::cos(el) * std::sin(ps)};
                    }
                    const float roll = 0.6f * t + ph;
                    if (pattern == LP_FANS) b.fan_roll(S, ec, roll, 30.0f * DEG, 1000, flux);
                    else b.fan_roll(S, ec, roll, 25.0f * DEG, 8, flux);
                    break;
                }
                case LP_CONES: {
                    vec3 axis;
                    if (hanging) {
                        const float th = (25.0f + 15.0f * std::sin(TAU * 0.1f * t + ph)) * DEG;
                        const float ps = TAU * 0.05f * t + ph;   // l'axe tourne (cercle)
                        axis = {std::sin(th) * std::cos(ps), -std::cos(th), std::sin(th) * std::sin(ps)};
                    } else {
                        const float el = (25.0f + 10.0f * std::sin(TAU * 0.1f * t + ph)) * DEG;
                        axis = {std::cos(el), std::sin(el), 0.3f * std::sin(TAU * 0.06f * t + ph)};
                        axis = normalize(axis);
                    }
                    const float hc = (8.0f + 4.0f * std::sin(TAU * 0.17f * t + 2.1f * ph)) * DEG;
                    b.cone(S, axis, hc, 32, 1000, 0.8f * t + ph, flux);
                    break;
                }
                case LP_CURTAINS: {
                    // rideaux verticaux (vers le bas, ou le haut au sol), plan qui tourne lentement
                    const float sway = 4.0f * DEG * std::sin(TAU * 0.1f * t + ph);
                    const vec3 ec = hanging ? vec3(std::sin(sway), -std::cos(sway), 0) : vec3(std::sin(sway), std::cos(sway), 0);
                    const float rho = 0.3f * t + ph;
                    const vec3 hz = {std::cos(rho), 0, std::sin(rho)};
                    b.fan(S, ec, normalize(hz - ec * dot(hz, ec)), 30.0f * DEG, 1000, flux);
                    break;
                }
                case LP_CLOSEUP: {
                    // nappes fixes : vers le public, inclinees, ouvertes en largeur (z)
                    const vec3 ec = hanging ? normalize(vec3(std::sin(35.0f * DEG), -std::cos(35.0f * DEG), 0)) : normalize(vec3(1, 0.45f, 0));
                    b.fan(S, ec, vec3(0, 0, 1), 28.0f * DEG, 1000, flux);
                    break;
                }
                case LP_FLOOR: {
                    if (hanging) {
                        // nappes presque verticales qui balaient le sol
                        const float th = (15.0f + 10.0f * std::sin(TAU * 0.12f * t + ph)) * DEG;
                        const float ps = TAU * 0.04f * t + ph;
                        const vec3 ec = {std::sin(th) * std::cos(ps), -std::cos(th), std::sin(th) * std::sin(ps)};
                        b.fan_roll(S, ec, 0.4f * t + ph, 30.0f * DEG, 1000, flux);
                    } else {
                        // nez et sol de scene : nappes horizontales a hauteur d'homme, a travers le public
                        const float el = (-0.5f + 1.0f * std::sin(TAU * 0.15f * t + ph)) * DEG;
                        const vec3 ec = {std::cos(el), std::sin(el), 0};
                        b.fan(S, ec, vec3(0, 0, 1), 30.0f * DEG, 1000, flux);
                    }
                    break;
                }
                default: break;
            }
        }
        total_traits = b.traits;
        return;
    }

    // ---- programmeur : effets, galvos, puis figures ----
    for (LaserFixture& f : fixtures) f.out = f.base;
    for (Effect& e : effects) {
        e.phase += e.speed * dt;
        if (!e.enabled || e.fixtures.empty()) continue;
        const int n = (int)e.fixtures.size();
        for (int i = 0; i < n; i++) {
            const int idx = e.fixtures[i];
            if (idx < 0 || idx >= N) continue;
            LaserParams& o = fixtures[idx].out;
            const float ph = effect_phase(e, i, n);
            const float w = effect_wave(e.wave, ph, e.duty);
            const float w01 = 0.5f + 0.5f * w;
            switch (e.type) {
                case LFX_PAN_WAVE: o.pan += e.size * w; break;
                case LFX_TILT_WAVE: o.tilt += e.size * w; break;
                case LFX_CIRCLE:
                    o.pan += e.size * std::cos(TAU * ph);
                    o.tilt += e.size * std::sin(TAU * ph);
                    break;
                case LFX_FIGURE8:
                    o.pan += e.size * std::sin(TAU * ph);
                    o.tilt += e.size * 0.5f * std::sin(2 * TAU * ph);
                    break;
                case LFX_RANDOM:
                    o.pan += e.size * smooth_noise(2 * idx, ph);
                    o.tilt += e.size * smooth_noise(2 * idx + 1, ph + 0.5f);
                    break;
                case LFX_SPREAD: {
                    const float centered = n > 1 ? 2.0f * (float)i / (float)(n - 1) - 1.0f : 0.0f;
                    const float amount = e.speed > 0 ? effect_wave(e.wave, e.phase, e.duty) : 1.0f;
                    o.pan += e.size * centered * amount;
                    break;
                }
                case LFX_ROLL: o.roll += e.size * w; break;
                case LFX_OPENING: o.opening = std::max(0.0f, o.opening * (1.0f + clampf(e.size, 0, 1) * w)); break;
                case LFX_TRAIT_CHASE:
                    o.chase_pos = fractf(ph);
                    o.chase_width = clampf(e.size, 0.02f, 1.0f);
                    break;
                case LFX_DIMMER_CHASE: o.dimmer *= 1.0f - clampf(e.size, 0, 1) * (1.0f - w01); break;
                case LFX_RAINBOW: o.color = hsv2rgb(ph, clampf(e.size, 0, 1), 1); break;
                case LFX_COLOR_ALT: o.color = w > 0 ? e.color_a : e.color_b; break;
            }
        }
    }
    // galvos : rattrapage du premier ordre (dt = 0 : position atteinte tout de suite)
    const float k = dt > 0.0f ? 1.0f - std::exp(-dt / std::max(galvo_ms * 1e-3f, 1e-4f)) : 1.0f;
    const float half_field = 0.5f * max_angle;
    for (LaserFixture& f : fixtures) {
        LaserParams& o = f.out;
        o.opening = clampf(o.opening, 0.0f, max_angle);
        o.pan = clampf(o.pan, -half_field, half_field);
        o.tilt = clampf(o.tilt, -half_field, half_field);
        f.pan += (o.pan - f.pan) * k;
        f.tilt += (o.tilt - f.tilt) * k;
        f.roll += (o.roll - f.roll) * k;
        f.opening += (o.opening - f.opening) * k;
        f.roll_acc = std::fmod(f.roll_acc + o.roll_speed * dt, 360.0f);
        f.scroll = fractf(f.scroll + o.gradient_speed * dt);
    }

    for (const LaserFixture& f : fixtures) {
        const LaserParams& o = f.out;
        float gate = 1.0f;
        if (o.strobe > 0.05f) gate = fractf((float)time * o.strobe) < 0.2f ? 1.0f : 0.0f;
        const float P = power_w * master * clampf(o.dimmer, 0, 1) * gate;
        if (P <= 1e-6f) continue;
        lit++;
        // couleur le long de la figure, puis profil du chenillard de traits
        const vec3 c1 = o.color, c2 = o.color2, c3 = o.color3;
        const int grad = o.gradient;
        const float scroll = f.scroll;
        const int ncell = std::max(1, std::min(o.traits, 16));
        const float chase = o.chase_pos, cw = o.chase_width;
        const bool closed = o.shape == LS_CONE || o.shape == LS_TUNNEL;
        const Profile prof = [=](float tt) {
            vec3 c;
            switch (grad) {
                case LG_TWO: c = lerp(c1, c2, tt); break;
                case LG_THREE: c = tt < 0.5f ? lerp(c1, c2, 2.0f * tt) : lerp(c2, c3, 2.0f * tt - 1.0f); break;
                case LG_SCROLL: c = lerp(c1, c2, 0.5f - 0.5f * std::cos(TAU * (2.0f * tt - scroll))); break;
                case LG_RAINBOW: c = hsv2rgb(fractf(tt + scroll), 1.0f, 1.0f); break;
                case LG_RANDOM: c = hsv2rgb(hash01((int)std::floor(clampf(tt, 0.0f, 0.9999f) * ncell)), 1.0f, 1.0f); break;
                default: c = c1; break;
            }
            if (chase >= 0.0f) {
                float d = std::fabs(tt - chase);
                if (closed) d = std::min(d, 1.0f - d);
                c *= std::max(0.0f, 1.0f - d / cw);
            }
            return c;
        };
        const bool flat = grad == LG_RANDOM;
        // morceaux : 12 pour un degrade qui defile ou un chenillard, 16 aplats pour l'aleatoire, sinon au moins un
        // morceau par 15 deg d'ouverture des qu'il y a un degrade (le shader repere la couleur par un sinus)
        const int kmin = grad == LG_NONE ? 1 : std::max(1, (int)std::ceil(f.opening / 15.0f));
        const int K = std::max(kmin, (grad == LG_SCROLL || grad == LG_RAINBOW || chase >= 0.0f) ? 12 : (grad == LG_THREE ? 2 : (flat ? 16 : 1)));
        // direction de la figure dans le champ du scanner, puis repere autour d'elle
        const vec3 S = f.mount.pos + f.aim * 0.17f;
        const vec3 d0 = normalize(f.aim + f.right * std::tan(f.pan * DEG) + f.up * std::tan(f.tilt * DEG));
        const vec3 r1 = normalize(f.right - d0 * dot(d0, f.right)), u1 = cross(r1, d0);
        const float roll = (f.roll + f.roll_acc) * DEG;
        const float ha = 0.5f * f.opening * DEG;
        // reseau de diffraction : copies decalees de la figure (puissance repartie)
        static const int OFF3[3][2] = {{-1, 0}, {0, 0}, {1, 0}};
        static const int OFF5[5][2] = {{0, 0}, {-1, 0}, {1, 0}, {0, -1}, {0, 1}};
        int ncopy = o.diffraction >= 9 ? 9 : (o.diffraction >= 5 ? 5 : (o.diffraction >= 3 ? 3 : 1));
        const float da = o.diffraction_angle * DEG;
        for (int c = 0; c < ncopy; c++) {
            int ox = 0, oy = 0;
            if (ncopy == 3) { ox = OFF3[c][0]; oy = OFF3[c][1]; }
            else if (ncopy == 5) { ox = OFF5[c][0]; oy = OFF5[c][1]; }
            else if (ncopy == 9) { ox = c % 3 - 1; oy = c / 3 - 1; }
            const vec3 d = normalize(d0 + r1 * std::tan(ox * da) + u1 * std::tan(oy * da));
            const vec3 rr = normalize(r1 - d * dot(d, r1)), uu = cross(rr, d);
            const vec3 w = rr * std::cos(roll) + uu * std::sin(roll);   // etalement de l'eventail
            const vec3 nf = cross(d, w);                                 // normale du plan de l'eventail
            const float Pc = P / (float)ncopy;
            const int n = std::max(o.traits, 1);
            switch (o.shape) {
                case LS_DOUBLE_FAN: {
                    const float g = 0.5f * o.shape_param * DEG;
                    for (int s = -1; s <= 1; s += 2)
                        b.fan(S, normalize(d * std::cos(g) + nf * (s * std::sin(g))), w, ha, std::max(1, n / 2), 0.5f * Pc, prof, K, 0, 1, flat);
                    break;
                }
                case LS_CONE:
                    b.cone(S, d, w, std::max(ha, 0.05f * DEG), std::min(32, n), n, 0.0f, Pc, prof, flat);
                    break;
                case LS_TUNNEL:
                    b.cone(S, d, w, std::max(ha, 0.05f * DEG), std::min(16, n), std::max(1, n / 2), 0.0f, 0.5f * Pc, prof, flat);
                    b.cone(S, d, w, std::max(0.6f * ha, 0.05f * DEG), std::min(16, n), std::max(1, n / 2), PI / 16, 0.5f * Pc, prof, flat);
                    break;
                case LS_WAVE: {
                    // traits qui ondulent hors du plan : ligne brisee de directions (8 morceaux par ondulation)
                    const int m = std::clamp((int)(8.0f * o.wave_cycles), 8, 48);
                    const float amp = o.shape_param * DEG;
                    vec3 D[49];
                    float tt[49];
                    for (int j = 0; j <= m; j++) {
                        const float u = (float)j / (float)m;
                        const float a = -ha + 2.0f * ha * u;
                        const float beta = amp * std::sin(TAU * (o.wave_cycles * u - 0.5f * (float)time));
                        D[j] = normalize((d * std::cos(a) + w * std::sin(a)) * std::cos(beta) + nf * std::sin(beta));
                        tt[j] = u;
                    }
                    if (ha > 0.0f) b.polyline(S, D, tt, m, n, Pc, prof, flat);
                    else b.fan(S, d, w, 0.0f, n, Pc, prof);
                    break;
                }
                case LS_GRID: {
                    // plusieurs eventails paralleles : une grille de points sur une surface
                    const int rows = std::clamp((int)std::lround(o.shape_param), 2, 16);
                    for (int r = 0; r < rows; r++) {
                        const float g = ha * (2.0f * (float)r / (float)(rows - 1) - 1.0f);
                        b.fan(S, normalize(d + nf * std::tan(g)), w, ha, std::max(1, n / rows), Pc / rows, prof, K, 0, 1, flat);
                    }
                    break;
                }
                default:
                    b.fan(S, d, w, ha, n, Pc, prof, K, 0, 1, flat);
                    break;
            }
        }
    }
    total_traits = b.traits;
}
