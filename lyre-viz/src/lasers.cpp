#include "lasers.h"
#include "trace.h"
#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstring>
#include <functional>
#include <memory>
#include <mutex>
#include <thread>

const char* LASER_PATTERN_NAMES[LP_COUNT] = {"eteints", "eventails 1000 traits (L1)", "cones 32 segments (L2)",
                                             "rideaux autour de la camera (L3)", "8 traits separes (L4)",
                                             "nappes fixes, gros plan (L5)", "vers le sol et les obstacles (L6)",
                                             "programmeur", "eventails en nappes continues (L1 ligne)"};
const char* LASER_SHAPE_NAMES[LS_COUNT] = {"Eventail", "Double eventail", "Cone", "Tunnel", "Vague", "Grille de points",
                                           "Carre", "Triangle", "Etoile", "Coeur"};
const char* LASER_GRADIENT_NAMES[LG_COUNT] = {"Uni", "2 couleurs", "3 couleurs", "Defilant", "Arc-en-ciel", "Aleatoire par trait"};
const char* LASER_EFFECT_NAMES[LFX_COUNT] = {"Vague pan", "Vague tilt", "Cercle (pan/tilt)", "Huit", "Balayage aleatoire",
                                             "Eventail des figures",
                                             "Roulis", "Pulsation de l'ouverture", "Chenillard de traits",
                                             "Chenillard d'intensite", "Arc-en-ciel", "Alternance de couleurs",
                                             "Ciseaux (un sur deux en miroir)", "Miroir (deux moities)", "Eventail en tilt",
                                             "Eventail de roulis", "Chenillard aller-retour", "Scintillement aleatoire",
                                             "Sauts aleatoires", "Couleurs de la palette", "Rotation par pas",
                                             "Convergence vers un point"};

float laser_effect_angle_max(int type) {
    switch (type) {
        case LFX_ROLL: case LFX_ROLL_SPREAD: case LFX_ROLL_STEP: return 180.0f;
        case LFX_PAN_WAVE: case LFX_TILT_WAVE: case LFX_CIRCLE: case LFX_FIGURE8: case LFX_RANDOM: case LFX_SPREAD:
        case LFX_SCISSORS: case LFX_MIRROR: case LFX_TILT_SPREAD: case LFX_JUMP: return 60.0f;
        default: return 0.0f;
    }
}

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

// Sortie de la boite [mn, mx] depuis p (dedans) le long de d : distance, et face touchee (0..5 : -x, +x, -y, +y, -z, +z).
float exit_face(vec3 p, vec3 d, vec3 mn, vec3 mx, int& face) {
    float t = 1e30f;
    face = 0;
    for (int a = 0; a < 3; a++) {
        if (d[a] > 1e-6f) { const float u = (mx[a] - p[a]) / d[a]; if (u < t) { t = u; face = 2 * a + 1; } }
        else if (d[a] < -1e-6f) { const float u = (mn[a] - p[a]) / d[a]; if (u < t) { t = u; face = 2 * a; } }
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

// Distance d'entree du rayon (o, d unitaire) dans un pave oriente (methode des dalles), 1e30 s'il le manque.
float ray_box(vec3 o, vec3 d, const Occluder& b) {
    const vec3 rel = o - b.c;
    const vec3 ax[3] = {b.ax, b.ay, b.az};
    float t0 = 0.0f, t1 = 1e30f;
    for (int i = 0; i < 3; i++) {
        const float l2 = dot(ax[i], ax[i]);
        if (l2 < 1e-12f) return 1e30f;
        const float p = dot(rel, ax[i]) / l2, v = dot(d, ax[i]) / l2;   // en demi-tailles
        if (std::fabs(v) < 1e-12f) {
            if (std::fabs(p) > 1.0f) return 1e30f;
            continue;
        }
        float ta = (-1.0f - p) / v, tb = (1.0f - p) / v;
        if (ta > tb) std::swap(ta, tb);
        t0 = std::max(t0, ta);
        t1 = std::min(t1, tb);
        if (t0 > t1) return 1e30f;
    }
    return t0;
}

// Normale (vers l'exterieur) de la face d'un pave touchee au point X.
vec3 box_normal(const Occluder& b, vec3 X) {
    const vec3 rel = X - b.c;
    const vec3 ax[3] = {b.ax, b.ay, b.az};
    int best = 0;
    float bv = -1, sgn = 1;
    for (int i = 0; i < 3; i++) {
        const float l2 = std::max(dot(ax[i], ax[i]), 1e-12f);
        const float p = dot(rel, ax[i]) / l2;
        if (std::fabs(p) > bv) { bv = std::fabs(p); best = i; sgn = p < 0 ? -1.0f : 1.0f; }
    }
    return normalize(ax[best]) * sgn;
}

// Coupe d'un pave par le plan d'un eventail : polygone convexe (au plus 6 sommets) en coordonnees du plan
// (x le long de ec, y le long de es, origine a la source), sommets tries par angle autour de leur centre.
int box_section(const Occluder& b, vec3 S, vec3 ec, vec3 es, vec3 nrm, vec2* out) {
    vec3 P[8];
    float d[8];
    for (int k = 0; k < 8; k++) {
        P[k] = b.c + b.ax * ((k & 1) ? 1.0f : -1.0f) + b.ay * ((k & 2) ? 1.0f : -1.0f) + b.az * ((k & 4) ? 1.0f : -1.0f);
        d[k] = dot(P[k] - S, nrm);
    }
    int m = 0;
    for (int k = 0; k < 8; k++)
        for (int bit = 1; bit <= 4; bit <<= 1) {
            const int j = k | bit;
            if (j == k) continue;
            if ((d[k] < 0.0f) == (d[j] < 0.0f)) continue;
            const vec3 X = P[k] + (P[j] - P[k]) * (d[k] / (d[k] - d[j]));
            if (m < 6) out[m++] = {dot(X - S, ec), dot(X - S, es)};
        }
    if (m < 3) return 0;
    float cx = 0, cy = 0;
    for (int i = 0; i < m; i++) { cx += out[i].x; cy += out[i].y; }
    cx /= m;
    cy /= m;
    std::sort(out, out + m, [&](vec2 a, vec2 b2) { return std::atan2(a.y - cy, a.x - cx) < std::atan2(b2.y - cy, b2.x - cx); });
    return m;
}

// Un trait de figure du programmeur (Builder::figure) : courbe du plan de projection en points denses (fermee si le
// dernier point est le premier), traits (0 : nappe continue), part de la puissance, couleur prof(t) de t0 a t1.
struct FigRun {
    std::vector<vec2> p;
    std::vector<TracePrim> exact;   // morceaux deja exacts (droites, cercles, polygones) : pas d'ajustement, p ignore
    int traits = 0;
    bool closed = false;
    float power = 1.0f, t0 = 0.0f, t1 = 1.0f;
};

struct Builder {
    std::vector<LaserSegment>& segs;
    vec3 mn, mx;
    int traits = 0;
    int cuts = 0;
    // obstacles (decor, personnage) et rayon de leur sphere englobante ; 'local' : ceux qui touchent le cone de
    // balayage du laser en cours (set_source), sinon tous
    std::vector<const Occluder*> all;
    std::vector<float> rad;
    std::vector<int> all_idx, local;
    std::vector<int> arc_near;   // arc en cours : paves dont l'ombre peut le toucher
    std::vector<int> arc_bounds; // arc en cours : coupes (indices de traits), gardees d'un arc a l'autre (pas d'allocation)
    bool use_local = false;
    // morceau d'eventail en cours (seg, seg_raw) : position de ses bords dans toute la figure (voir LaserSegment::eu0)
    float cur_eu0 = 0, cur_eu1 = 0;

    void set_obstacles(const std::vector<Occluder>& a, const std::vector<Occluder>& b) {
        for (const std::vector<Occluder>* L : {&a, &b})
            for (const Occluder& o : *L) {
                all_idx.push_back((int)all.size());
                all.push_back(&o);
                rad.push_back(length(o.ax) + length(o.ay) + length(o.az));
            }
    }
    // Laser en cours : source S, axe de sa figure et demi-angle (rad) qui contient toute la figure.
    void set_source(vec3 S, vec3 axis, float theta) {
        local.clear();
        use_local = true;
        const float ct = std::cos(theta), st = std::sin(theta);
        for (int i : all_idx) {
            const vec3 v = all[i]->c - S;
            const float dist = length(v);
            if (dist <= rad[i]) { local.push_back(i); continue; }
            // sphere et cone : l'angle entre l'axe et le centre, moins le demi-angle vu de la sphere, sous theta
            const float ca = dot(v, axis) / dist, sa = std::sqrt(std::max(0.0f, 1.0f - ca * ca));
            const float sr = rad[i] / dist, cr = std::sqrt(std::max(0.0f, 1.0f - sr * sr));
            // cos(angle - asin(sr)) >= cos(theta)
            if (ca * cr + sa * sr >= ct || theta >= 1.5f) local.push_back(i);
            (void)st;
        }
    }
    void clear_source() { use_local = false; }
    const std::vector<int>& cand() const { return use_local ? local : all_idx; }

    // Portee d'un trait : sortie du hangar, ou le premier obstacle.
    float trait_range(vec3 S, vec3 d, float R) const {
        for (int i : cand()) {
            const vec3 rel = all[i]->c - S;
            const float proj = dot(rel, d), r = rad[i];
            if (proj < -r || proj - r > R) continue;
            if (dot(rel, rel) - proj * proj > r * r) continue;
            R = std::min(R, ray_box(S, d, *all[i]));
        }
        return R;
    }

    // Un segment, coupe par les obstacles. Le plan de l'eventail est coupe par chaque pave proche (polygone) ; les
    // angles des sommets de ces polygones decoupent l'eventail en morceaux (recales entre deux traits). Dans chaque
    // morceau, le pave le plus proche (s'il y en a un) est vu par une seule de ses aretes : le morceau s'arrete
    // exactement sur cette droite (portee a chaque bord, range et range1). Un trait seul : un rayon.
    void seg(vec3 S, vec3 ec, vec3 es, float ha, int n, vec3 f0, vec3 f1) {
        if (cand().empty()) {
            seg_raw(S, ec, es, ha, n, f0, f1, -1.0f, 0.0f);
            return;
        }
        if (n <= 1 || ha <= 0.0f) {
            seg_raw(S, ec, es, 0.0f, 1, f0, f1, -2.0f, 0.0f);   // portee du trait : rayon (seg_raw)
            return;
        }
        const vec3 nrm = cross(ec, es);
        const float Rh = hall_range(S, ec, es, ha);
        const float sh0 = std::sin(ha), ch0 = std::cos(ha);
        // paves coupes par le plan, a portee et dans l'angle de l'eventail
        struct Sec { vec2 p[6]; int m; };
        Sec secs[24];
        int ns = 0;
        float splits[160];
        int nsp = 0;
        {
            for (int bi : cand()) {
                const Occluder& b = *all[bi];
                const float r = rad[bi];
                const vec3 rel = b.c - S;
                if (std::fabs(dot(rel, nrm)) > r) continue;   // le plan ne touche pas le pave
                // dans le coin de l'eventail elargi de r, a portee (sans racine ni trigonometrie)
                const float x = dot(rel, ec), y = dot(rel, es);
                if (x + r <= 0.0f || x * x + y * y > (Rh + r) * (Rh + r)) continue;
                if (-x * sh0 - y * ch0 > r || -x * sh0 + y * ch0 > r) continue;
                if (ns >= 24) break;
                Sec& sc = secs[ns];
                sc.m = box_section(b, S, ec, es, nrm, sc.p);
                if (sc.m == 0) continue;
                bool ok = true;
                for (int i = 0; i < sc.m; i++) ok = ok && sc.p[i].x > 1e-3f;
                if (!ok) continue;   // pave contre la sortie : ignore
                ns++;
                for (int i = 0; i < sc.m && nsp < 160; i++) {
                    const float a = std::atan2(sc.p[i].y, sc.p[i].x);
                    if (a > -ha && a < ha) splits[nsp++] = a;
                }
            }
        }
        if (ns == 0) {
            seg_raw(S, ec, es, ha, n, f0, f1, -1.0f, 0.0f);
            return;
        }
        // morceaux en traits : bornes entre deux traits (traits aux angles -ha + k da, k = 0 .. n - 1)
        const int N = n <= 0 ? LASER_SHEET_TRAITS : n;
        const float da = 2.0f * ha / (float)(N - 1);
        std::sort(splits, splits + nsp);
        int bounds[162];
        int nb = 0;
        bounds[nb++] = 0;
        for (int i = 0; i < nsp; i++) {
            const int j = std::clamp((int)std::floor((splits[i] + ha) / da) + 1, 1, N - 1);
            if (j > bounds[nb - 1]) bounds[nb++] = j;
        }
        bounds[nb++] = N;
        for (int k = 0; k + 1 < nb; k++) {
            const int j0 = bounds[k], j1 = bounds[k + 1] - 1;   // traits j0 .. j1
            const int nk = j1 - j0 + 1;
            const float u0 = N > 1 ? (float)j0 / (float)(N - 1) : 0.0f, u1 = N > 1 ? (float)j1 / (float)(N - 1) : 0.0f;
            const vec3 c0 = (f0 + (f1 - f0) * u0) * ((float)nk / (float)N), c1 = (f0 + (f1 - f0) * u1) * ((float)nk / (float)N);
            const float g = -ha + da * 0.5f * (float)(j0 + j1), h = da * 0.5f * (float)(j1 - j0);
            const float cg = std::cos(g), sg = std::sin(g);
            const vec3 ec2 = ec * cg + es * sg, es2 = es * cg - ec * sg;
            // bords de ce morceau dans toute la figure (le morceau parent va de cur_eu0 a cur_eu1)
            const float pe0 = cur_eu0, pe1 = cur_eu1;
            struct EuRestore { Builder* b; float e0, e1; ~EuRestore() { b->cur_eu0 = e0; b->cur_eu1 = e1; } } eu_restore{this, pe0, pe1};
            cur_eu0 = pe0 + (pe1 - pe0) * (g - h + ha) / (2.0f * ha);
            cur_eu1 = pe0 + (pe1 - pe0) * (g + h + ha) / (2.0f * ha);
            const bool cnt = N < LASER_SHEET_TRAITS;
            if (nk == 1) {
                seg_raw(S, ec2, es2, 0.0f, 1, c0, c0, -2.0f, 0.0f, cnt);
                continue;
            }
            // pave le plus proche sur le rayon du milieu du morceau, et l'arete qu'il touche
            float best = 1e30f;
            vec2 ea = {0, 0}, eb = {0, 0};
            for (int s = 0; s < ns; s++) {
                const Sec& sc = secs[s];
                for (int i = 0; i < sc.m; i++) {
                    const vec2 p = sc.p[i], q = sc.p[(i + 1) % sc.m];
                    // rayon t (cg, sg) contre l'arete p + u (q - p)
                    const float ex = q.x - p.x, ey = q.y - p.y;
                    const float den = cg * ey - sg * ex;
                    if (std::fabs(den) < 1e-12f) continue;
                    const float t = (p.x * ey - p.y * ex) / den, u = (p.x * sg - p.y * cg) / den;
                    if (t > 0.0f && t < best && u >= -1e-4f && u <= 1.0f + 1e-4f) {
                        best = t;
                        ea = p;
                        eb = q;
                    }
                }
            }
            const float Rk = hall_range(S, ec2, es2, h);
            if (best >= Rk) {
                seg_raw(S, ec2, es2, h, nk, c0, c1, Rk, 0.0f, cnt);
                continue;
            }
            // droite de l'arete dans le repere du morceau, puis portee le long de ses deux bords
            const vec2 pa = {ea.x * cg + ea.y * sg, ea.y * cg - ea.x * sg}, pb = {eb.x * cg + eb.y * sg, eb.y * cg - eb.x * sg};
            vec2 nn = {pb.y - pa.y, pa.x - pb.x};
            float dd = nn.x * pa.x + nn.y * pa.y;
            if (dd < 0.0f) { nn.x = -nn.x; nn.y = -nn.y; dd = -dd; }
            const float ch = std::cos(h), sh = std::sin(h);
            const float q0 = nn.x * ch - nn.y * sh, q1 = nn.x * ch + nn.y * sh;   // bords 0 (-h) et 1 (+h)
            const float r0 = q0 > 1e-9f ? std::min(dd / q0, Rk) : Rk, r1 = q1 > 1e-9f ? std::min(dd / q1, Rk) : Rk;
            seg_raw(S, ec2, es2, h, nk, c0, c1, std::max(r0, 0.01f), std::max(r1, 0.01f), cnt);
            if (!segs.empty()) {
                segs.back().cut_a = nn.x / dd;
                segs.back().cut_b = nn.y / dd;
            }
            cuts++;
        }
    }

    // Portee dans le hangar : le plus loin que l'eventail va avant d'en sortir (5 directions).
    float hall_range(vec3 S, vec3 ec, vec3 es, float ha) const {
        const float c1 = std::cos(0.5f * ha), s1 = std::sin(0.5f * ha), c2 = std::cos(ha), s2 = std::sin(ha);
        float R = exit_distance(S, ec, mn, mx);
        if (ha > 0.0f) {
            for (int sg = -1; sg <= 1; sg += 2) {
                R = std::max(R, exit_distance(S, ec * c1 + es * (s1 * sg), mn, mx));
                R = std::max(R, exit_distance(S, ec * c2 + es * (s2 * sg), mn, mx));
            }
        }
        return std::min(R, 160.0f);
    }

    // Un segment tel quel : portee 'R' (< 0 : celle du hangar ; -2 : trait arrete au premier obstacle), 'R1' > 0 :
    // coupe (portee au bord 1).
    void seg_raw(vec3 S, vec3 ec, vec3 es, float ha, int n, vec3 f0, vec3 f1, float R, float R1, bool count = true) {
        if (segs.size() >= LASER_MAX_SEGS) return;
        if (R == -2.0f) R = trait_range(S, ec, hall_range(S, ec, es, 0.0f));
        else if (R < 0.0f) R = hall_range(S, ec, es, n > 1 ? ha : 0.0f);
        LaserSegment s;
        s.src = S;
        s.range = R;
        s.ec = ec;
        s.half_angle = n > 1 ? ha : 0.0f;
        s.es = es;
        s.traits = (float)std::max(n, 1);
        s.flux = f0;
        s.pad = 0;
        s.flux1 = f1;
        s.range1 = R1;
        s.cut_a = s.cut_b = 0.0f;
        s.eu0 = cur_eu0;
        s.eu1 = cur_eu1;
        segs.push_back(s);
        if (count && n < LASER_SHEET_TRAITS) traits += std::max(n, 1);
    }

    // Eventail de n traits (milieu ec, plan (ec, es), demi-ouverture ha), puissance P, couleur prof(t) entre
    // t0 et t1. Peu de traits (16 au plus) : un segment par trait (a l'ecran, une bande fine ; le rendu
    // rejette en 3 operations les pixels hors de la bande). Sinon K morceaux, chacun en degrade lineaire.
    void fan(vec3 S, vec3 ec, vec3 es, float ha, int n, float P, const Profile& prof, int K = 1, float t0 = 0, float t1 = 1,
             bool flat = false) {
        ha = clampf(ha, 0.0f, 60.0f * DEG);
        n = n <= 0 ? LASER_SHEET_TRAITS : n;   // 0 : nappe continue (mode ligne)
        if (n == 1 || ha <= 0.0f) {
            const vec3 c = prof(0.5f * (t0 + t1)) * P;
            seg(S, ec, es, 0.0f, 1, c, c);
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
        if (!all.empty()) set_source(S, ec, ha + 2.0f * DEG);   // obstacles dans le coin de la figure
        const float P = std::max(std::max(flux.x, flux.y), std::max(flux.z, 1e-9f));
        fan(S, ec, es, ha, n, P, [&](float) { return flux * (1.0f / P); });
    }
    // Eventail dont le plan tourne de 'roll' autour de ec (0 : es horizontal si possible).
    void fan_roll(vec3 S, vec3 ec, float roll, float ha, int n, vec3 flux) {
        const vec3 r0 = any_perp(ec), r1 = cross(ec, r0);
        fan(S, ec, r0 * std::cos(roll) + r1 * std::sin(roll), ha, n, flux);
    }

    // Arc de cercle du plan de projection du scanner : nappe conique exacte (rendu : laser_arc). Repere : axe d,
    // rr, uu = d x rr ; cercle (cx, cy, rho) ; de l'angle th0 a th0 + dth autour du centre ; n traits (0 : nappe
    // continue), aux deux bouts compris ; puissance P, couleur prof(t) de t0 a t1. Morceaux de 90 deg au plus (et K au
    // moins, pour les degrades). Obstacles : chaque pave est projete dans le plan du scanner ; les angles ou le cercle
    // coupe ses 12 aretes (entree et sortie de son ombre, changement de face) coupent l'arc ; un morceau a l'ombre
    // s'arrete exactement sur le plan de la face que touche son rayon du milieu (sb_laser.stop, teste dans le shader).
    void arc(vec3 S, vec3 d, vec3 rr, float cx, float cy, float rho, float th0, float dth, int n, float P, const Profile& prof,
             int K, float t0, float t1, bool flat) {
        const vec3 uu = cross(d, rr);
        const int N = n <= 0 ? LASER_SHEET_TRAITS : std::max(n, 2);
        auto dirf = [&](float th) { return normalize(d + rr * (cx + rho * std::cos(th)) + uu * (cy + rho * std::sin(th))); };
        const float dt = dth / (float)(N - 1);   // ecart de deux traits (en theta)
        auto jof = [&](float th) { return std::clamp((int)std::floor((th - th0) / dt) + 1, 1, N - 1); };
        std::vector<int>& bounds = arc_bounds;
        bounds.assign(1, 0);
        const int pieces = std::clamp(std::max(K, (int)std::ceil(dth / (0.5f * PI) - 1e-4f)), 1, std::max(1, N - 1));
        for (int k = 1; k < pieces; k++) bounds.push_back((int)((long long)k * (N - 1) / pieces) + 1);
        // ombres des paves sur le cercle ; d'abord un tri : la sphere englobante du pave, projetee sur le plan du
        // scanner, doit toucher le cercle (sinon le pave ne coupe aucune direction de l'arc)
        std::vector<int>& near = arc_near;
        near.clear();
        for (int bi : cand()) {
            const vec3 X = all[bi]->c - S;
            const float zd = dot(X, d), r = rad[bi];
            if (zd + r <= 0.0f) continue;   // derriere la source
            if (zd > 2.0f * r) {
                const float px = dot(X, rr) / zd - cx, py = dot(X, uu) / zd - cy;
                const float pr = r / (zd - r) * 1.2f;   // rayon apparent (majore)
                if (std::fabs(std::sqrt(px * px + py * py) - rho) > pr) continue;
            }
            near.push_back(bi);
        }
        for (int bi : near) {
            const Occluder& o = *all[bi];
            vec2 pc[8];
            bool ok = true;
            for (int k = 0; k < 8 && ok; k++) {
                const vec3 X = o.c + o.ax * ((k & 1) ? 1.0f : -1.0f) + o.ay * ((k & 2) ? 1.0f : -1.0f) + o.az * ((k & 4) ? 1.0f : -1.0f) - S;
                const float zd = dot(X, d);
                if (zd <= 0.05f) ok = false;
                else pc[k] = {dot(X, rr) / zd, dot(X, uu) / zd};
            }
            // les 12 aretes projetees (coins voisins : un seul bit de difference) : le cercle coupe chacune en 2 points au
            // plus, angles exacts ; pave a cheval sur le plan de la source (projection impossible) : rayons lances (ray_box)
            if (ok) {
                static const int EDGES[12][2] = {{0, 1}, {2, 3}, {4, 5}, {6, 7}, {0, 2}, {1, 3}, {4, 6}, {5, 7}, {0, 4}, {1, 5}, {2, 6}, {3, 7}};
                for (const auto& e : EDGES) {
                    const vec2 p = pc[e[0]], q = pc[e[1]];
                    const float ex = q.x - p.x, ey = q.y - p.y, fx = p.x - cx, fy = p.y - cy;
                    const float A = ex * ex + ey * ey, B = fx * ex + fy * ey, Cq = fx * fx + fy * fy - rho * rho;
                    const float disc = B * B - A * Cq;
                    if (A < 1e-12f || disc < 0.0f) continue;
                    for (float sg : {-1.0f, 1.0f}) {
                        const float u = (-B + sg * std::sqrt(disc)) / A;
                        if (u < 0.0f || u > 1.0f) continue;
                        float th = std::atan2(fy + ey * u, fx + ex * u);
                        th -= 2.0f * PI * std::floor((th - th0) / (2.0f * PI));   // dans [th0, th0 + 2 pi)
                        if (th > th0 && th < th0 + dth) bounds.push_back(jof(th));
                    }
                }
                continue;
            }
            // pave a cheval sur le plan de la source : rayons lances, puis dichotomie
            auto inside = [&](float th) { return ray_box(S, dirf(th), o) < 1e29f; };
            const int ns = std::clamp((int)(dth / (2.0f * DEG)), 8, 180);
            bool prev = inside(th0);
            for (int k = 1; k <= ns; k++) {
                const float th = th0 + dth * (float)k / (float)ns;
                const bool in = inside(th);
                if (in != prev) {
                    float lo = th - dth / (float)ns, hi = th;
                    for (int it = 0; it < 10; it++) {
                        const float m = 0.5f * (lo + hi);
                        if (inside(m) == prev) lo = m; else hi = m;
                    }
                    bounds.push_back(jof(0.5f * (lo + hi)));
                }
                prev = in;
            }
        }
        bounds.push_back(N);
        std::sort(bounds.begin(), bounds.end());
        bounds.erase(std::unique(bounds.begin(), bounds.end()), bounds.end());
        for (size_t k = 0; k + 1 < bounds.size(); k++) {
            const int j0 = bounds[k], j1 = bounds[k + 1] - 1;
            if (j1 < j0) continue;
            // a l'ombre ? pave le plus proche sur le rayon du milieu : arret sur le plan de la face touchee (entre deux aretes,
            // tout le morceau touche cette face)
            const vec3 Dm = dirf(th0 + dt * 0.5f * (float)(j0 + j1));
            float best = exit_distance(S, Dm, mn, mx);
            const Occluder* hit = nullptr;
            for (int bi : near) {
                const float tb = ray_box(S, Dm, *all[bi]);
                if (tb < best) {
                    best = tb;
                    hit = all[bi];
                }
            }
            if (hit) {
                const vec3 X = S + Dm * best;
                const vec3 sn = box_normal(*hit, X) * -1.0f;   // vers l'interieur du pave
                emit_arc(S, d, rr, uu, cx, cy, rho, th0, dt, j0, j1, N, P, prof, t0, t1, flat, dirf, sn, dot(sn, X - S));
                cuts++;
            } else {
                emit_arc(S, d, rr, uu, cx, cy, rho, th0, dt, j0, j1, N, P, prof, t0, t1, flat, dirf, vec3(), 1e30f);
            }
        }
    }
    // Un morceau d'arc : traits j0 .. j1 ; portee : sortie du hangar ou plan d'arret (sn, sd : voir LaserSegment), le
    // plus loin de 9 rayons.
    template <typename F>
    void emit_arc(vec3 S, vec3 d, vec3 rr, vec3 uu, float cx, float cy, float rho, float th0, float dt, int j0, int j1, int N,
                  float P, const Profile& prof, float t0, float t1, bool flat, const F& dirf, vec3 sn, float sd) {
        if (segs.size() >= LASER_MAX_SEGS) return;
        const int nk = j1 - j0 + 1;
        const float a0 = th0 + dt * (float)j0, da = dt * (float)(j1 - j0);
        const float ta = t0 + (t1 - t0) * (float)j0 / (float)(N - 1), tb = t0 + (t1 - t0) * (float)j1 / (float)(N - 1);
        const float w = P * (float)nk / (float)N;
        vec3 c0 = prof(ta) * w, c1 = prof(tb) * w;
        if (flat) c0 = c1 = prof(0.5f * (ta + tb)) * w;
        if (nk == 1) {
            const vec3 D = dirf(a0);
            seg_raw(S, D, any_perp(D), 0.0f, 1, c0, c0, -2.0f, 0.0f, N < LASER_SHEET_TRAITS);
            return;
        }
        float R = 0.0f;
        for (int i = 0; i < 9; i++) {
            const vec3 D = dirf(a0 + da * (float)i * 0.125f);
            float e = exit_distance(S, D, mn, mx);
            const float dn = dot(sn, D);
            if (sd < 1e29f && dn > 1e-6f) e = std::min(e, sd / dn);
            R = std::max(R, e);
        }
        R *= 1.05f;   // entre deux rayons : le sol (ou la face) arrete la nappe, la portee ne doit pas la couper avant
        LaserSegment s;
        s.src = S;
        s.range = std::min(R, 160.0f);
        s.ec = d;
        s.half_angle = 0.0f;
        s.es = rr;
        s.traits = (float)nk;
        s.flux = c0;
        s.pad = 0;
        s.flux1 = c1;
        s.range1 = 0;
        s.arc = 1;
        s.uu = uu;
        s.cx = cx;
        s.cy = cy;
        s.rho = rho;
        s.th0 = a0;
        s.dth = da;
        s.stop_n = sn;
        s.stop_d = sd;
        segs.push_back(s);
        if (N < LASER_SHEET_TRAITS) traits += nk;
    }

    // Figure du programmeur (moteur de trace, PLAN-LASERS.md etape 9) : chaque trait de la figure est une courbe du plan
    // de projection (repere d, rr, uu = d x rr, comme arc), en points denses, decoupee en arcs et droites exacts
    // (trace_fit_curve), puis ses traits repartis le long (aux deux bouts compris si elle est ouverte ; 0 : nappe
    // continue). Peu de traits (16 au plus) : un trait seul chacun (le chemin le moins cher). Degrades : morceaux de
    // longueur 1 / K au plus (couleur lineaire dans chacun). Puissance P x part de chaque trait de figure.
    void figure(vec3 S, vec3 d, vec3 rr, const std::vector<FigRun>& runs, float P, const Profile& prof, int K, bool flat) {
        const vec3 uu = cross(d, rr);
        auto dir_of = [&](vec2 q) { return normalize(d + rr * q.x + uu * q.y); };
        std::vector<TracePrim> prims;
        for (const FigRun& run : runs) {
            if ((run.p.size() < 2 && run.exact.empty()) || run.power <= 0.0f) continue;
            const float Pr = P * run.power;
            if (!run.exact.empty()) prims = run.exact;
            else trace_fit_curve(run.p, 2e-4f, prims);
            // morceaux (droite ou arc), longueur, et decoupe pour les degrades
            struct Pc { bool arc; vec2 p0, p1, c; float rho, a0, da, len; };
            std::vector<Pc> pcs;
            float L = 0.0f;
            for (const TracePrim& t : prims) {
                Pc q{t.kind == TP_ARC, t.p0, t.p1, t.c, t.rho, t.a0, t.da, 0.0f};
                q.len = q.arc ? t.rho * std::fabs(t.da) : std::sqrt((t.p1.x - t.p0.x) * (t.p1.x - t.p0.x) + (t.p1.y - t.p0.y) * (t.p1.y - t.p0.y));
                if (q.len <= 0.0f) continue;
                pcs.push_back(q);
                L += q.len;
            }
            if (L <= 0.0f) continue;
            auto point_at = [&](const Pc& q, float sl) {   // a la distance sl du debut du morceau
                if (!q.arc) return vec2{q.p0.x + (q.p1.x - q.p0.x) * sl / q.len, q.p0.y + (q.p1.y - q.p0.y) * sl / q.len};
                const float a = q.a0 + (q.da >= 0.0f ? sl : -sl) / q.rho;
                return vec2{q.c.x + q.rho * std::cos(a), q.c.y + q.rho * std::sin(a)};
            };
            auto t_at = [&](float s) { return run.t0 + (run.t1 - run.t0) * s / L; };
            const int N = run.traits;
            if (N > 0 && N <= 16) {
                // traits seuls : positions le long de la courbe
                for (int i = 0; i < N; i++) {
                    const float sa = run.closed ? L * (float)i / (float)N : (N == 1 ? 0.5f * L : L * (float)i / (float)(N - 1));
                    float s = sa;
                    size_t k = 0;
                    while (k + 1 < pcs.size() && s > pcs[k].len) {
                        s -= pcs[k].len;
                        k++;
                    }
                    const vec3 D = dir_of(point_at(pcs[k], std::min(s, pcs[k].len)));
                    const vec3 f = prof(t_at(sa)) * (Pr / (float)N);
                    seg(S, D, any_perp(D), 0.0f, 1, f, f);
                }
                continue;
            }
            const bool cont = N <= 0 || N >= LASER_SHEET_TRAITS;
            const float sp = cont ? 0.0f : (run.closed ? L / (float)N : L / (float)std::max(N - 1, 1));
            const float cut = L / (float)std::max(K, 1);   // decoupe des degrades
            float s0 = 0.0f;
            for (const Pc& q : pcs) {
                // sous-morceaux : coupes aux multiples de L / K
                std::vector<float> marks = {0.0f};
                if (K > 1)
                    for (float m = std::ceil(s0 / cut + 1e-4f) * cut; m < s0 + q.len - 1e-6f; m += cut) marks.push_back(m - s0);
                marks.push_back(q.len);
                for (size_t mi = 0; mi + 1 < marks.size(); mi++) {
                    const float la = marks[mi], lb = marks[mi + 1];
                    if (lb - la <= 0.0f) continue;
                    // traits de [s0 + la, s0 + lb) : positions i x sp
                    float sa = la, sb = lb, Pp;
                    int nk;
                    if (cont) {
                        nk = 0;
                        Pp = Pr * (lb - la) / L;
                    } else {
                        const int nmax = N - 1;
                        const int i0 = std::max(0, (int)std::ceil((s0 + la) / sp - 1e-4f));
                        const bool last = mi + 2 == marks.size() && &q == &pcs.back();
                        int i1 = std::min(nmax, (int)std::ceil((s0 + lb) / sp - 1e-4f) - 1);
                        if (last) i1 = std::min(nmax, (int)std::floor((s0 + lb) / sp + 1e-4f));
                        nk = i1 - i0 + 1;
                        if (nk <= 0) continue;
                        sa = (float)i0 * sp - s0;
                        sb = (float)i1 * sp - s0;
                        Pp = Pr * (float)nk / (float)N;
                    }
                    float ta = t_at(s0 + sa), tb = t_at(s0 + sb);
                    if (flat) ta = tb = 0.5f * (ta + tb);
                    if (nk == 1) {
                        const vec3 D = dir_of(point_at(q, sa)), f = prof(ta) * Pp;
                        seg(S, D, any_perp(D), 0.0f, 1, f, f);
                    } else if (q.arc) {
                        float aa = q.a0 + (q.da >= 0.0f ? sa : -sa) / q.rho, ab = q.a0 + (q.da >= 0.0f ? sb : -sb) / q.rho;
                        if (ab < aa) {
                            std::swap(aa, ab);
                            std::swap(ta, tb);
                        }
                        arc(S, d, rr, q.c.x, q.c.y, q.rho, aa, ab - aa, cont ? 0 : nk, Pp, prof, 1, ta, tb, flat);
                    } else {
                        const vec3 Da = dir_of(point_at(q, sa)), Db = dir_of(point_at(q, sb));
                        const float half = 0.5f * std::acos(clampf(dot(Da, Db), -1.0f, 1.0f));
                        const vec3 fa = prof(ta) * Pp, fb = prof(tb) * Pp;
                        // eventail (une seule droite, ouverte) : le scanner rebrousse chemin a ses deux bouts (bords brillants)
                        if (!run.closed && pcs.size() == 1) {
                            cur_eu0 = 2.0f * (s0 + sa) / L - 1.0f;
                            cur_eu1 = 2.0f * (s0 + sb) / L - 1.0f;
                        }
                        if (half < 1e-6f) seg(S, Da, any_perp(Da), 0.0f, 1, (fa + fb) * 0.5f, (fa + fb) * 0.5f);
                        else seg(S, normalize(Da + Db), normalize(Db - Da), half, cont ? LASER_SHEET_TRAITS : nk, fa, fb);
                        cur_eu0 = cur_eu1 = 0.0f;
                    }
                }
                s0 += q.len;
            }
        }
    }

    // Cone de traits (cercle) : une nappe conique exacte autour de l'axe (arc de 360 deg, cercle centre).
    void cone(vec3 S, vec3 axis, vec3 u, float half_cone, int nseg, int n_total, float spin, float P, const Profile& prof, bool flat) {
        (void)nseg;
        const vec3 rr = normalize(u - axis * dot(u, axis));
        const int n = n_total >= LASER_SHEET_TRAITS || n_total <= 0 ? 0 : std::max(n_total, 3);
        // n traits sur le cercle : le dernier a un ecart du premier (pas de double) ; nappe continue : tout le tour
        const float span = n > 0 ? 2.0f * PI * (float)(n - 1) / (float)n : 2.0f * PI;
        const int K = flat ? 16 : 4;
        arc(S, axis, rr, 0.0f, 0.0f, std::tan(std::max(half_cone, 0.05f * DEG)), spin, span, n, P, prof, K, 0.0f, 1.0f, flat);
    }
    // Ancienne forme (motifs du banc).
    void cone(vec3 S, vec3 axis, float half_cone, int nseg, int n_total, float spin, vec3 flux) {
        if (!all.empty()) set_source(S, axis, half_cone + 2.0f * DEG);
        const float P = std::max(std::max(flux.x, flux.y), std::max(flux.z, 1e-9f));
        cone(S, axis, any_perp(axis), half_cone, nseg, n_total, spin, P, [&](float) { return flux * (1.0f / P); }, false);
    }
};

// Morceaux d'une image ILDA (moteur de trace, coordonnees du fichier de -1 a 1) dans le champ du scanner : rotation
// 'roll', puis pose sur le plan de projection a l'echelle tan(ha) (direction d + rr x + uu y) : une droite reste une
// nappe plane, un arc une nappe conique exacte. Energie : part du temps de l'image (deja dans les morceaux) x
// puissance du boitier.
void emit_ilda(Builder& b, const IldaPrims& pr, vec3 S, vec3 d, vec3 rr, vec3 uu, float roll, float ha, float hmax, float P,
               const LaserParams& o) {
    const float c = std::cos(roll), s = std::sin(roll), k = std::tan(std::min(ha, hmax));
    auto plane = [&](vec2 q) { return vec2{(q.x * c - q.y * s) * k, (q.x * s + q.y * c) * k}; };
    auto dir = [&](vec2 q) {
        const vec2 m = plane(q);
        return normalize(d + rr * m.x + uu * m.y);
    };
    auto flux = [&](vec3 f) { return (o.ilda_colors ? f : o.color * std::max(f.x, std::max(f.y, f.z))) * P; };
    for (const TracePrim& t : pr.prims) {
        const vec3 F0 = flux(t.f0), F1 = flux(t.f1);
        if (t.kind == TP_BEAM) {
            const vec3 D = dir(t.p0);
            b.seg(S, D, any_perp(D), 0.0f, 1, F0, F0);
            continue;
        }
        if (t.kind == TP_LINE) {
            const vec3 D0 = dir(t.p0), D1 = dir(t.p1);
            const float half = 0.5f * std::acos(clampf(dot(D0, D1), -1.0f, 1.0f));
            if (half < 1e-6f) b.seg(S, D0, any_perp(D0), 0.0f, 1, (F0 + F1) * 0.5f, (F0 + F1) * 0.5f);
            else b.seg(S, normalize(D0 + D1), normalize(D1 - D0), half, LASER_SHEET_TRAITS, F0, F1);
            continue;
        }
        // arc : repere des nappes coniques (direction d + rr x + (d x rr) y, donc y retourne), angles tournes de roll
        const vec2 C = plane(t.c);
        float th0 = -(t.a0 + roll), dth = -t.da, t0 = 0.0f, t1 = 1.0f;
        if (dth < 0.0f) {
            th0 += dth;
            dth = -dth;
            t0 = 1.0f;
            t1 = 0.0f;
        }
        const float Pm = std::max(1e-30f, std::max(std::max(std::max(F0.x, F0.y), F0.z), std::max(std::max(F1.x, F1.y), F1.z)));
        const vec3 A = F0 * (1.0f / Pm), B = F1 * (1.0f / Pm);
        b.arc(S, d, rr, C.x, -C.y, t.rho * k, th0, dth, 0, Pm, [A, B](float u) { return lerp(A, B, u); }, 1, t0, t1, false);
    }
}

const vec3 GROUP_COLORS[7] = {{0, 1, 0}, {1, 0, 0}, {0.1f, 0.35f, 1}, {0, 1, 0}, {1, 0.75f, 0}, {1, 0, 0.8f}, {0, 0.9f, 1}};

}  // namespace

// ---------------------------------------------------------------------------------------------
//  Emplacements, boitiers, selection
// ---------------------------------------------------------------------------------------------
void LaserRig::build(const Scene& scene) {
    mounts.clear();
    fixtures.clear();
    effects.clear();
    obstacles = scene.laser_occluders;
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
        case LFX_SCISSORS: case LFX_MIRROR: e.size = 15; e.speed = 0.2f; e.spread = 0; break;
        case LFX_TILT_SPREAD: e.size = 10; e.speed = 0; e.spread = 0; break;
        case LFX_ROLL_SPREAD: e.size = 90; e.speed = 0; e.spread = 0; break;
        case LFX_BOUNCE: e.size = 0.2f; e.speed = 0.25f; e.spread = 0; break;
        case LFX_SPARKLE: e.size = 0.35f; e.speed = 2; e.wave = WAVE_SQUARE; e.duty = 0.5f; e.spread = 0; break;
        case LFX_JUMP: e.size = 10; e.speed = 1; e.spread = 0; break;
        case LFX_PALETTE: e.size = 1; e.speed = 0.1f; e.wave = WAVE_SQUARE; break;
        case LFX_ROLL_STEP: e.size = 45; e.speed = 1; e.spread = 0; break;
        case LFX_CONVERGE: e.size = 0; e.speed = 0.1f; e.spread = 0; e.color_a = {-12, 7, 0}; break;
    }
    effects.push_back(e);
}

// Au lancement : tous les lasers eteints (ambiance 1 : les lyres seules). Le pont et le nez de scene sont
// prets en eventails qui balaient lentement : il suffit de monter leur dimmer.
void LaserRig::program_default() {
    effects.clear();
    for (LaserFixture& f : fixtures) {
        f.base = LaserParams();
        f.base.dimmer = 0;
        f.base.color = GROUP_COLORS[f.mount.group];
        f.selected = false;
        if (f.mount.group == 4 || f.mount.group == 6) {
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

// Tous les boitiers jouent les fichiers d'une banque ILDA (un par boitier, decales d'une image a l'autre).
void LaserRig::program_ilda(const std::string& bank) {
    effects.clear();
    ilda_bias = 0;
    const std::vector<int> files = ilda.bank(bank);
    for (size_t i = 0; i < fixtures.size(); i++) {
        LaserParams& p = fixtures[i].base;
        p = LaserParams();
        fixtures[i].selected = false;
        if (files.empty()) {
            p.dimmer = 0;
            continue;
        }
        p.source = 1;
        p.ilda_clip = files[i % files.size()];
        p.opening = 40;
        p.color = GROUP_COLORS[fixtures[i].mount.group];
    }
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
//  Plusieurs coeurs (PLAN-LASERS.md, etape 9d) : chaque laser est construit a part (un Builder par fil, ses
//  morceaux dans son propre tableau), puis les morceaux sont mis bout a bout dans l'ordre des lasers : le resultat
//  est celui du calcul sur un seul coeur (sauf au plafond LASER_MAX_SEGS, ou ce ne sont pas les memes morceaux qui
//  manquent).
// ---------------------------------------------------------------------------------------------
namespace {

// Fils permanents (crees une fois) : run(f) appelle f(fil) sur chacun, le fil appelant compris (fil 0).
class WorkPool {
public:
    explicit WorkPool(int n) {
        for (int i = 0; i < n; i++) th_.emplace_back([this, i] { loop(i + 1); });
    }
    ~WorkPool() {
        {
            std::lock_guard<std::mutex> l(m_);
            quit_ = true;
        }
        cv_.notify_all();
        for (std::thread& t : th_) t.join();
    }
    int size() const { return (int)th_.size() + 1; }
    void run(const std::function<void(int)>& f) {
        {
            std::lock_guard<std::mutex> l(m_);
            job_ = &f;
            pending_ = (int)th_.size();
            gen_++;
        }
        cv_.notify_all();
        f(0);
        std::unique_lock<std::mutex> l(m_);
        done_.wait(l, [this] { return pending_ == 0; });
        job_ = nullptr;
    }

private:
    void loop(int w) {
        unsigned seen = 0;
        for (;;) {
            const std::function<void(int)>* job;
            {
                std::unique_lock<std::mutex> l(m_);
                cv_.wait(l, [&] { return quit_ || gen_ != seen; });
                if (quit_) return;
                seen = gen_;
                job = job_;
            }
            (*job)(w);
            std::lock_guard<std::mutex> l(m_);
            if (--pending_ == 0) done_.notify_one();
        }
    }
    std::vector<std::thread> th_;
    std::mutex m_;
    std::condition_variable cv_, done_;
    const std::function<void(int)>* job_ = nullptr;
    unsigned gen_ = 0;
    int pending_ = 0;
    bool quit_ = false;
};

WorkPool& work_pool() {
    static WorkPool pool(std::clamp((int)std::thread::hardware_concurrency() - 1, 0, 15));
    return pool;
}

// ntask lasers : fn(tache, Builder du fil) ; morceaux mis bout a bout dans l'ordre des taches (segs), compteurs de
// traits et de coupes additionnes ; ranges : plage de chaque tache dans segs (entiere ou coupee par le plafond).
template <typename F>
void build_parallel(int ntask, vec3 mn, vec3 mx, bool coll, const std::vector<Occluder>& obs, const std::vector<Occluder>& dyn,
                    std::vector<LaserSegment>& segs, int& traits, int& cuts, std::vector<LaserRig::TaskRange>& ranges, F fn) {
    WorkPool& pool = work_pool();
    const int nw = pool.size();
    static std::vector<std::vector<LaserSegment>> wsegs;
    if ((int)wsegs.size() < nw) wsegs.resize(nw);
    struct Rec { int w, a, b, traits, cuts; };
    std::vector<Rec> rec(ntask);
    std::atomic<int> next{0};
    const std::function<void(int)> job = [&](int w) {
        std::vector<LaserSegment>& out = wsegs[w];
        out.clear();
        Builder b{out, mn, mx};
        if (coll) b.set_obstacles(obs, dyn);
        for (int t; (t = next.fetch_add(1)) < ntask;) {
            const int a = (int)out.size(), tr = b.traits, cu = b.cuts;
            fn(t, b);
            rec[t] = {w, a, (int)out.size(), b.traits - tr, b.cuts - cu};
        }
    };
    if (ntask > 1 && nw > 1) pool.run(job);
    else job(0);
    size_t total = 0;
    for (const Rec& r : rec) total += (size_t)(r.b - r.a);
    segs.clear();
    segs.reserve(std::min(total, (size_t)LASER_MAX_SEGS));
    ranges.resize(ntask);
    for (int t = 0; t < ntask; t++) {
        const Rec& r = rec[t];
        traits += r.traits;
        cuts += r.cuts;
        const size_t room = (size_t)LASER_MAX_SEGS - segs.size();
        const size_t cnt = std::min((size_t)(r.b - r.a), room);
        ranges[t].a = (int)segs.size();
        ranges[t].b = (int)(segs.size() + cnt);
        ranges[t].whole = cnt == (size_t)(r.b - r.a);
        segs.insert(segs.end(), wsegs[r.w].begin() + r.a, wsegs[r.w].begin() + r.a + cnt);
    }
}

// Cle du cache des figures fixes : tout ce que lit la construction d'une figure du programmeur (bits exacts).
void push_bits(std::vector<float>& k, const void* p, size_t n) {
    const size_t i = k.size();
    k.resize(i + (n + 3) / 4, 0.0f);
    std::memcpy(&k[i], p, n);
}
void push_vec(std::vector<float>& k, vec3 v) {
    k.push_back(v.x);
    k.push_back(v.y);
    k.push_back(v.z);
}
void figure_key(std::vector<float>& k, const LaserFixture& f, float P, const IldaPrims* pr, double time) {
    const LaserParams& o = f.out;
    k.clear();
    push_vec(k, f.mount.pos);
    push_vec(k, f.aim);
    push_vec(k, f.right);
    push_vec(k, f.up);
    for (float v : {f.pan, f.tilt, f.roll, f.roll_acc, f.opening, P, (float)o.source, (float)o.diffraction, o.diffraction_angle})
        k.push_back(v);
    push_bits(k, &pr, sizeof(pr));
    push_vec(k, o.color);
    if (pr) {
        k.push_back(o.ilda_colors ? 1.0f : 0.0f);
        return;
    }
    push_vec(k, o.color2);
    push_vec(k, o.color3);
    for (float v : {(float)o.gradient, (float)o.shape, (float)o.traits, o.shape_param, o.wave_cycles, (float)o.branches, o.chase_pos,
                    o.chase_width})
        k.push_back(v);
    if (o.gradient == LG_SCROLL || o.gradient == LG_RAINBOW) k.push_back(f.scroll);
    if (o.shape == LS_WAVE) push_bits(k, &time, sizeof(time));
}

double ms_since(std::chrono::steady_clock::time_point t) {
    return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t).count();
}

}  // namespace

int laser_workers() { return work_pool().size(); }
void laser_parallel(const std::function<void(int)>& f) {
    if (work_pool().size() > 1) work_pool().run(f);
    else f(0);
}

// ---------------------------------------------------------------------------------------------
//  Figures : motifs du banc, ou programmeur
// ---------------------------------------------------------------------------------------------
void LaserRig::update(float t, float dt, vec3 hall_min, vec3 hall_max) {
    const auto t_start = std::chrono::steady_clock::now();
    segs.clear();
    lit = 0;
    total_traits = 0;
    cut_segments = 0;
    cpu_build_ms = cpu_hits_ms = 0.0f;
    exits.clear();
    ilda_points = ilda_beams = ilda_sheets = ilda_arcs = 0;
    time += dt;
    const int N = (int)mounts.size();
    const float TAU = 2 * PI;
    if (pattern == LP_OFF) return;
    if (pattern != LP_PROGRAM) {
        const int on = std::clamp(count, 0, N);
        std::vector<int> todo;
        for (int i = 0; i < N && on > 0; i++) {
            // 'on' boitiers repartis regulierement sur les emplacements
            if ((long long)(i + 1) * on / N == (long long)i * on / N) continue;
            todo.push_back(i);
        }
        lit = (int)todo.size();
        for (int i : todo) exits.push_back({mounts[i].pos + mounts[i].n * 0.12f, mounts[i].n, GROUP_COLORS[mounts[i].group] * power_w});
        task_slot.assign(todo.size(), -1);
        build_parallel((int)todo.size(), hall_min, hall_max, collisions, obstacles, dyn_obstacles, segs, total_traits, cut_segments,
                       task_ranges, [&](int task, Builder& b) {
            const int i = todo[task];
            const LaserMount& m = mounts[i];
            const float ph = i * 0.37f + m.group * 1.3f;
            const vec3 flux = GROUP_COLORS[m.group] * power_w;
            const bool hanging = m.n.y < 0;
            const vec3 S = m.pos + m.n * 0.12f;
            b.clear_source();   // motifs : chaque figure choisit ses obstacles (fan, cone)
            switch (pattern) {
                case LP_FANS:
                case LP_FANS_LINE:
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
                    else if (pattern == LP_FANS_LINE) b.fan_roll(S, ec, roll, 30.0f * DEG, 0, flux);
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
        });
        cpu_build_ms = (float)ms_since(t_start);
        const auto t_hits = std::chrono::steady_clock::now();
        build_hits(hall_min, hall_max);
        cpu_hits_ms = (float)ms_since(t_hits);
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
                // effets des spectacles
                case LFX_SCISSORS: o.pan += e.size * w * ((i & 1) ? -1.0f : 1.0f); break;
                case LFX_MIRROR: {
                    // moitie gauche et moitie droite de la selection en sens opposes (le laser du milieu ne bouge pas)
                    const float side = 2.0f * (float)i - (float)(n - 1);
                    o.pan += e.size * w * (side > 0.0f ? 1.0f : (side < 0.0f ? -1.0f : 0.0f));
                    break;
                }
                case LFX_TILT_SPREAD:
                case LFX_ROLL_SPREAD: {
                    const float centered = n > 1 ? 2.0f * (float)i / (float)(n - 1) - 1.0f : 0.0f;
                    const float amount = e.speed > 0 ? effect_wave(e.wave, e.phase, e.duty) : 1.0f;
                    (e.type == LFX_TILT_SPREAD ? o.tilt : o.roll) += e.size * centered * amount;
                    break;
                }
                case LFX_BOUNCE: {
                    // position du groupe allume : aller-retour sur la selection (forme carre : bords nets)
                    const float f = fractf(e.phase), pos = f < 0.5f ? 2.0f * f : 2.0f - 2.0f * f;
                    const float d = std::fabs((n > 1 ? (float)i / (float)(n - 1) : 0.5f) - pos);
                    const float wd = clampf(e.size, 0.02f, 1.0f);
                    o.dimmer *= e.wave == WAVE_SQUARE ? (d <= 0.5f * wd ? 1.0f : 0.0f)
                                                      : 0.5f + 0.5f * std::cos(PI * std::min(d / wd, 1.0f));
                    break;
                }
                case LFX_SPARKLE: {
                    const uint32_t k = (uint32_t)(int64_t)std::floor(ph);
                    const bool on = hash01((int)((uint32_t)idx * 7919u + k * 104729u + 17u)) < e.size && fractf(ph) < e.duty;
                    o.dimmer *= on ? 1.0f : 0.0f;
                    break;
                }
                case LFX_JUMP: {
                    const uint32_t k = (uint32_t)(int64_t)std::floor(ph);
                    o.pan += e.size * (2.0f * hash01((int)((uint32_t)idx * 7919u + k * 104729u + 3u)) - 1.0f);
                    o.tilt += 0.6f * e.size * (2.0f * hash01((int)((uint32_t)idx * 7919u + k * 104729u + 11u)) - 1.0f);
                    break;
                }
                case LFX_PALETTE: {
                    // palette du rig, sinon les 3 couleurs du laser ; les couleurs 2 et 3 suivent (degrades)
                    const vec3 own[3] = {o.color, o.color2, o.color3};
                    const int np = palette.empty() ? 3 : (int)palette.size();
                    auto at = [&](int j) { j %= np; return palette.empty() ? own[j] : palette[j]; };
                    const float x = fractf(ph) * (float)np;
                    const int j0 = std::min((int)x, np - 1);
                    if (e.wave == WAVE_SINE) {
                        const float t = x - (float)j0, s = t * t * (3.0f - 2.0f * t);
                        o.color = lerp(at(j0), at(j0 + 1), s);
                        o.color2 = lerp(at(j0 + 1), at(j0 + 2), s);
                        o.color3 = lerp(at(j0 + 2), at(j0 + 3), s);
                    } else {
                        o.color = at(j0);
                        o.color2 = at(j0 + 1);
                        o.color3 = at(j0 + 2);
                    }
                    break;
                }
                case LFX_ROLL_STEP: o.roll += std::fmod(e.size * std::floor(ph), 23040.0f); break;
                case LFX_CONVERGE: {
                    // pan et tilt qui envoient l'axe de la figure sur le point (remplacent ceux du programmeur : a placer
                    // avant les autres effets de mouvement) ; le point tourne sur un cercle vertical face a la scene
                    const LaserFixture& lf = fixtures[idx];
                    const vec3 P = e.color_a + vec3(0.0f, e.size * std::sin(TAU * ph), e.size * std::cos(TAU * ph));
                    const vec3 D = P - (lf.mount.pos + lf.aim * 0.17f);
                    const float x = dot(D, lf.aim);
                    if (x > 0.05f * length(D)) {
                        o.pan = std::atan(dot(D, lf.right) / x) / DEG;
                        o.tilt = std::atan(dot(D, lf.up) / x) / DEG;
                    }
                    break;
                }
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

    // boitiers allumes, et morceaux de leur image ILDA (calcules ici, sur un seul coeur : le cache de la bibliotheque
    // se remplit a la demande)
    struct Task { int f; float P; const IldaPrims* ilda; };
    std::vector<Task> todo;
    for (int fi = 0; fi < (int)fixtures.size(); fi++) {
        const LaserFixture& f = fixtures[fi];
        const LaserParams& o = f.out;
        float gate = 1.0f;
        if (o.strobe > 0.05f) gate = fractf((float)time * o.strobe) < 0.2f ? 1.0f : 0.0f;
        const float P = power_w * master * clampf(o.dimmer, 0, 1) * gate;
        if (P <= 1e-6f) continue;
        // fichier ILDA : morceaux de l'image affichee (en cache, niveau de tolerance le plus fin qui tient dans
        // ILDA_MAX_PRIMS, releve si les segments depassent le budget)
        const IldaPrims* ilda_pr = nullptr;
        if (o.source == 1) {
            IldaClip* clip = ilda.get(o.ilda_clip);
            if (!clip) continue;
            const int fr = ilda_frame_index((int)clip->frames.size(), o.ilda_fps, time, o.ilda_play, o.ilda_frame);
            int level = std::clamp(ilda_bias, 0, ILDA_LEVELS - 1);
            const float div = divergence_mrad * 1e-3f;
            while (level < ILDA_LEVELS - 1 && ilda.prims(*clip, fr, level, div).over) level++;
            ilda_pr = &ilda.prims(*clip, fr, level, div);
            ilda_points += clip->frames[fr].size();
            for (const TracePrim& tp : ilda_pr->prims) {
                if (tp.kind == TP_BEAM) ilda_beams++;
                else if (tp.kind == TP_ARC) ilda_arcs++;
                else ilda_sheets++;
            }
        }
        lit++;
        todo.push_back({fi, P, ilda_pr});
        // couleur de la sortie : celle du laser, ou la moyenne des couleurs de l'image ILDA (ramenee a 1 au plus fort)
        vec3 ecol = o.color;
        if (ilda_pr && o.ilda_colors && !ilda_pr->prims.empty()) {
            vec3 c;
            for (const TracePrim& tp : ilda_pr->prims) c += tp.f0 + tp.f1;
            const float m = std::max(c.x, std::max(c.y, c.z));
            if (m > 0.0f) ecol = c * (1.0f / m);
        }
        exits.push_back({f.mount.pos + f.aim * 0.17f, f.aim, ecol * P});
    }
    auto build_figure = [&](int task, Builder& b) {
        const LaserFixture& f = fixtures[todo[task].f];
        const LaserParams& o = f.out;
        const float P = todo[task].P;
        const IldaPrims* ilda_pr = todo[task].ilda;
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
        {
            // obstacles dans le cone de la figure : ouverture (coin du champ pour un fichier ILDA ou une grille),
            // forme (double eventail, vague), copies de la diffraction, marge
            const float spread = o.diffraction > 1 ? 1.5f * o.diffraction_angle : 0.0f;
            const float extra = std::max(o.shape_param, 0.0f);
            const float th = (0.5f * f.opening * 1.42f + spread + extra + 2.0f) * DEG;
            b.set_source(S, d0, std::min(th, 1.6f));
        }
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
            const int n = o.traits <= 0 ? LASER_SHEET_TRAITS : o.traits;
            if (ilda_pr) {
                emit_ilda(b, *ilda_pr, S, d, rr, uu, roll, ha, 0.5f * max_angle * DEG, Pc, o);
                continue;
            }
            // figure : ses traits sont des courbes du plan de projection (direction d + w x + nf y), en points denses ;
            // Builder::figure les decoupe en arcs et droites exacts et y repartit les traits. Ouverture nulle : tous les
            // traits confondus (un trait).
            const bool closed_shape = o.shape == LS_CONE || o.shape == LS_TUNNEL || o.shape >= LS_SQUARE;
            if (ha <= 1e-6f && !closed_shape) {
                b.fan(S, d, w, 0.0f, n, Pc, prof);
                continue;
            }
            const float th = std::tan(ha), thc = std::tan(std::max(ha, 0.05f * DEG));
            std::vector<FigRun> runs;
            // droites, polygones et cercles : morceaux exacts donnes directement (pas d'ajustement)
            auto seg_prim = [](vec2 p0, vec2 p1) {
                TracePrim t;
                t.kind = TP_LINE;
                t.p0 = p0;
                t.p1 = p1;
                return t;
            };
            auto line = [&](vec2 p0, vec2 p1, int tr, float pw) {
                FigRun r;
                r.exact = {seg_prim(p0, p1)};
                r.traits = tr;
                r.power = pw;
                runs.push_back(std::move(r));
            };
            auto polygon = [&](const std::vector<vec2>& c, int tr) {
                FigRun r;
                for (size_t k = 0; k < c.size(); k++) r.exact.push_back(seg_prim(c[k], c[(k + 1) % c.size()]));
                r.traits = tr;
                r.closed = true;
                runs.push_back(std::move(r));
            };
            auto circle = [&](float rad, float a0, int tr, float pw) {
                FigRun r;
                TracePrim t;
                t.kind = TP_ARC;
                t.c = {0.0f, 0.0f};
                t.rho = rad;
                t.a0 = a0;
                t.da = TAU;
                t.p0 = t.p1 = {rad * std::cos(a0), rad * std::sin(a0)};
                r.exact = {t};
                r.traits = tr;
                r.closed = true;
                r.power = pw;
                runs.push_back(std::move(r));
            };
            switch (o.shape) {
                case LS_DOUBLE_FAN: {
                    const float g = 0.5f * o.shape_param * DEG, x = th / std::cos(g);
                    for (int sg = -1; sg <= 1; sg += 2) line({-x, sg * std::tan(g)}, {x, sg * std::tan(g)}, std::max(1, n / 2), 0.5f);
                    break;
                }
                case LS_CONE: circle(thc, 0.0f, n, 1.0f); break;
                case LS_TUNNEL:
                    circle(thc, 0.0f, std::max(1, n / 2), 0.5f);
                    circle(std::tan(std::max(0.6f * ha, 0.05f * DEG)), PI / 16, std::max(1, n / 2), 0.5f);
                    break;
                case LS_WAVE: {
                    // traits qui ondulent hors du plan : direction (d cos a + w sin a) cos b + nf sin b
                    const float amp = o.shape_param * DEG;
                    const int m = std::clamp((int)(64.0f * o.wave_cycles), 64, 512);
                    FigRun r;
                    for (int k = 0; k <= m; k++) {
                        const float u = (float)k / (float)m, a = -ha + 2.0f * ha * u;
                        const float beta = amp * std::sin(TAU * (o.wave_cycles * u - o.wave_speed * (float)time));
                        r.p.push_back({std::tan(a), std::tan(beta) / std::cos(a)});
                    }
                    r.traits = n;
                    runs.push_back(std::move(r));
                    break;
                }
                case LS_GRID: {
                    // eventails paralleles : une grille de points sur une surface
                    const int rows = std::clamp((int)std::lround(o.shape_param), 2, 16);
                    for (int r = 0; r < rows; r++) {
                        const float g = ha * (2.0f * (float)r / (float)(rows - 1) - 1.0f), x = th / std::cos(g);
                        line({-x, std::tan(g)}, {x, std::tan(g)}, std::max(1, n / rows), 1.0f / (float)rows);
                    }
                    break;
                }
                case LS_SQUARE: {
                    const float h = thc * 0.70710678f;
                    polygon({{-h, -h}, {h, -h}, {h, h}, {-h, h}}, n);
                    break;
                }
                case LS_TRIANGLE:
                    polygon({{0.0f, thc}, {-0.8660254f * thc, -0.5f * thc}, {0.8660254f * thc, -0.5f * thc}}, n);
                    break;
                case LS_STAR: {
                    const int nb = std::clamp(o.branches, 3, 12);
                    std::vector<vec2> c;
                    for (int k = 0; k < 2 * nb; k++) {
                        const float a = PI * 0.5f + PI * (float)k / (float)nb, rr2 = (k & 1) ? 0.42f * thc : thc;
                        c.push_back({rr2 * std::cos(a), rr2 * std::sin(a)});
                    }
                    polygon(c, n);
                    break;
                }
                case LS_HEART: {
                    // courbe du coeur (pointes en haut au centre et en bas : deux traits qui se rejoignent)
                    FigRun r;
                    const float sc = thc / 17.0f;
                    for (int k = 0; k <= 256; k++) {
                        const float t2 = TAU * (float)k / 256.0f, st = std::sin(t2);
                        r.p.push_back({sc * 16.0f * st * st * st,
                                       sc * (13.0f * std::cos(t2) - 5.0f * std::cos(2 * t2) - 2.0f * std::cos(3 * t2) - std::cos(4 * t2) + 2.5f)});
                    }
                    r.traits = n;
                    r.closed = true;
                    runs.push_back(std::move(r));
                    break;
                }
                default: line({-th, 0.0f}, {th, 0.0f}, n, 1.0f); break;
            }
            b.figure(S, d, w, runs, Pc, prof, K, flat);
        }
    };
    // cache des figures fixes : entrees communes (hangar, obstacles, champ), puis celles de chaque figure ; une figure dont
    // rien n'a change reprend ses morceaux (et ses impacts, build_hits) de l'image precedente
    {
        std::vector<float> sk;
        push_vec(sk, hall_min);
        push_vec(sk, hall_max);
        sk.push_back(max_angle);
        sk.push_back(collisions ? 1.0f : 0.0f);
        sk.push_back((float)obstacles.size());
        if (!obstacles.empty()) push_bits(sk, obstacles.data(), obstacles.size() * sizeof(Occluder));
        if (!dyn_obstacles.empty()) push_bits(sk, dyn_obstacles.data(), dyn_obstacles.size() * sizeof(Occluder));
        const bool same = figure_cache && sk.size() == cache_scene.size() && fig_cache.size() == fixtures.size() &&
                          std::memcmp(sk.data(), cache_scene.data(), sk.size() * sizeof(float)) == 0;
        if (!same) {
            fig_cache.assign(fixtures.size(), FigCache());
            cache_scene = sk;
        }
    }
    cached_lasers = 0;
    task_slot.resize(todo.size());
    std::vector<char> reuse(todo.size(), 0);
    {
        std::vector<float> key;
        for (size_t i = 0; i < todo.size(); i++) {
            const int fi = todo[i].f;
            FigCache& c = fig_cache[fi];
            figure_key(key, fixtures[fi], todo[i].P, todo[i].ilda, time);
            reuse[i] = figure_cache && c.valid && key.size() == c.key.size() &&
                       std::memcmp(key.data(), c.key.data(), key.size() * sizeof(float)) == 0;
            if (!reuse[i]) {
                c.key = key;
                c.valid = false;
                c.hits_valid = false;
            }
            cached_lasers += reuse[i];
            task_slot[i] = figure_cache ? fi : -1;
        }
    }
    build_parallel((int)todo.size(), hall_min, hall_max, collisions, obstacles, dyn_obstacles, segs, total_traits, cut_segments,
                   task_ranges, [&](int task, Builder& b) {
        FigCache& cache = fig_cache[todo[task].f];
        if (reuse[task]) {
            b.segs.insert(b.segs.end(), cache.segs.begin(), cache.segs.end());
            b.traits += cache.traits;
            b.cuts += cache.cuts;
            return;
        }
        const size_t seg0 = b.segs.size();
        const int traits0 = b.traits, cuts0 = b.cuts;
        build_figure(task, b);
        if (figure_cache) {
            cache.segs.assign(b.segs.begin() + seg0, b.segs.end());
            cache.traits = b.traits - traits0;
            cache.cuts = b.cuts - cuts0;
            cache.valid = true;
        }
    });
    cpu_build_ms = (float)ms_since(t_start);
    const auto t_hits = std::chrono::steady_clock::now();
    build_hits(hall_min, hall_max);
    cpu_hits_ms = (float)ms_since(t_hits);
    // budget global (LASER_MAX_SEGS) : primitives ILDA regroupees plus largement quand il est presque atteint
    if (ilda_beams + ilda_sheets + ilda_arcs > 0) {
        if (segs.size() >= (size_t)LASER_MAX_SEGS * 95 / 100 && ilda_bias < ILDA_LEVELS - 1) ilda_bias++;
        else if (segs.size() < (size_t)LASER_MAX_SEGS * 35 / 100 && ilda_bias > 0) ilda_bias--;
    }
}

// ---------------------------------------------------------------------------------------------
//  Impacts sur les surfaces (etape 5)
// ---------------------------------------------------------------------------------------------
// Pour chaque segment : un trait laisse un point la ou il s'arrete (le premier obstacle, sinon la paroi du hangar) ;
// un morceau d'eventail laisse une ligne. Coupe par un obstacle : la droite qui joint ses deux impacts, sur la face
// de l'obstacle. Sinon : sa coupe par les parois du hangar (sol, murs, plafond), en deux lignes (ou plus) s'il passe
// un coin (angle du coin cherche par dichotomie). Les obstacles ne sont pas dans les morceaux non coupes (decoupage
// des segments), les lignes sur les parois sont donc entieres.
void LaserRig::build_hits(vec3 mn, vec3 mx) {
    hits.clear();
    if (!impacts) return;
    const float tiny = 1e-6f;
    auto all_obs = [&](vec3 X, vec3& nrm) {
        float best = 1e30f;
        for (const std::vector<Occluder>* L : {&obstacles, &dyn_obstacles})
            for (const Occluder& o : *L) {
                const vec3 rel = X - o.c;
                // le point est-il sur ce pave (a 2 cm pres) ?
                float worst = 0;
                const vec3 ax[3] = {o.ax, o.ay, o.az};
                for (int i = 0; i < 3; i++) {
                    const float l = length(ax[i]);
                    worst = std::max(worst, std::fabs(dot(rel, ax[i])) / std::max(l, tiny) - l);
                }
                if (worst < best) { best = worst; nrm = box_normal(o, X); }
            }
        return best;
    };
    static const vec3 FACE_N[6] = {{1, 0, 0}, {-1, 0, 0}, {0, 1, 0}, {0, -1, 0}, {0, 0, 1}, {0, 0, -1}};   // vers l'interieur
    // un morceau : ses impacts dans 'out'
    auto one = [&](const LaserSegment& g, std::vector<LaserHit>& out) {
            if (g.arc) {
                // arc : morceaux de la courbe (meme face de sortie, 4 deg de direction et 22,5 deg d'arc au plus) ; le
                // dessin teste la distance exacte au cone (kind 2) : courbe exacte, bouts fondus en angle (sans trou aux
                // jonctions). L'arc couvre ses traits plus un demi-ecart de chaque cote (les morceaux se touchent).
                const vec3 d = g.ec, rr = g.es, uu = g.uu;
                const float nk = std::max(g.traits, 2.0f);
                auto dirf = [&](float th) {
                    return normalize(d + rr * (g.cx + g.rho * std::cos(th)) + uu * (g.cy + g.rho * std::sin(th)));
                };
                const float dt = g.dth / (nk - 1.0f);
                const float ta = g.th0 - 0.5f * dt, span = g.dth + dt;
                if (span <= 1e-7f) return;
                const vec3 fa = g.flux / span, fb = g.flux1 / span;   // puissance par radian de theta
                LaserHit h = {};
                h.kind = 2;
                h.src = g.src;
                h.nrm = d;
                h.pad0 = g.rho;
                h.pad1 = rr.x;
                h.pad2 = g.cx;
                h.pad3 = rr.y;
                h.pad4 = rr.z;
                h.pad5 = g.cy;
                auto push = [&](float t0, float t1, float e0, float e1, vec3 sn) {
                    if ((int)out.size() >= LASER_MAX_SEGS * 2) return;
                    LaserHit q = h;
                    q.a = g.src + dirf(t0) * e0;
                    q.b = g.src + dirf(t1) * e1;
                    q.f0 = fa + (fb - fa) * ((t0 - ta) / span);
                    q.f1 = fa + (fb - fa) * ((t1 - ta) / span);
                    q.span = t1 - t0;
                    q.surf = sn;
                    out.push_back(q);
                };
                if (g.stop_d < 1e29f) {
                    // arrete sur la face d'un obstacle (plan stop) : la courbe exacte sur cette face, en morceaux recoupes tant
                    // qu'elle s'ecarte de sa corde de plus de 4 % de sa longueur (+ 5 mm), comme sur les parois
                    auto facep = [&](float t, float& e) {
                        const vec3 D = dirf(t);
                        e = exit_distance(g.src, D, mn, mx);
                        const float dn = dot(g.stop_n, D);
                        if (dn > 1e-6f) e = std::min(e, g.stop_d / dn);
                        return g.src + D * e;
                    };
                    struct Ch { float t0, t1; int depth; };
                    Ch cs[16];
                    int nc = 0;
                    cs[nc++] = {ta, ta + span, 0};
                    while (nc > 0) {
                        const Ch q = cs[--nc];
                        float e0, e1, em;
                        const vec3 Pa = facep(q.t0, e0), Pb = facep(q.t1, e1), Pm = facep(0.5f * (q.t0 + q.t1), em);
                        if (q.depth < 7 && nc + 2 <= 16 && length(Pm - (Pa + Pb) * 0.5f) > 0.04f * length(Pb - Pa) + 0.005f) {
                            cs[nc++] = {0.5f * (q.t0 + q.t1), q.t1, q.depth + 1};
                            cs[nc++] = {q.t0, 0.5f * (q.t0 + q.t1), q.depth + 1};
                            continue;
                        }
                        push(q.t0, q.t1, e0, e1, g.stop_n * -1.0f);
                    }
                    return;
                }
                // tranches de 22,5 deg d'abord : la face de sortie n'est lue qu'aux bouts d'un morceau, et un cercle complet
                // (ou un arc qui passe du mur au sol et revient au mur) a ses deux bouts sur la meme face ; toute la courbe
                // prenait alors la normale de la face de son debut, qui tourne avec la figure (sol au loin sans largeur
                // minimale a l'ecran : traits qui clignotent par morceaux)
                struct Piece { float t0, t1; };
                const int m0 = std::clamp((int)std::ceil(span / (22.5f * DEG)), 1, 64);
                for (int c0 = 0; c0 < m0; c0++) {
                    Piece st[8];
                    int ns = 0;
                    st[ns++] = {ta + span * (float)c0 / (float)m0, c0 + 1 < m0 ? ta + span * (float)(c0 + 1) / (float)m0 : ta + span};
                    int guard = 0;
                    while (ns > 0 && guard++ < 16) {
                        const Piece p = st[--ns];
                        int f0i, f1i;
                        exit_face(g.src, dirf(p.t0), mn, mx, f0i);
                        exit_face(g.src, dirf(p.t1), mn, mx, f1i);
                        if (f0i == f1i || p.t1 - p.t0 < 1e-5f) {
                            // morceaux de 22,5 deg d'arc au plus, recoupes en deux tant que la courbe s'ecarte de sa corde de plus
                            // de 4 % de sa longueur (+ 5 mm) : le dessin n'ajoute que cette marge (vs_laser_hit)
                            auto exitp = [&](float t) {
                                int fc;
                                const vec3 D = dirf(t);
                                return g.src + D * exit_face(g.src, D, mn, mx, fc);
                            };
                            const int m = std::clamp((int)std::ceil((p.t1 - p.t0) / (22.5f * DEG)), 1, 64);
                            vec3 Pc = exitp(p.t0);
                            for (int c = 0; c < m; c++) {
                                struct Ch { float t0, t1; vec3 Pa, Pb; int depth; };
                                Ch cs[16];
                                int nc = 0;
                                const float c1 = p.t0 + (p.t1 - p.t0) * (float)(c + 1) / (float)m;
                                const vec3 Pn = exitp(c1);
                                cs[nc++] = {p.t0 + (p.t1 - p.t0) * (float)c / (float)m, c1, Pc, Pn, 0};
                                Pc = Pn;
                                while (nc > 0) {
                                    const Ch q = cs[--nc];
                                    const float tm = 0.5f * (q.t0 + q.t1);
                                    const vec3 Pm = exitp(tm);
                                    if (q.depth < 7 && nc + 2 <= 16 && length(Pm - (q.Pa + q.Pb) * 0.5f) > 0.04f * length(q.Pb - q.Pa) + 0.005f) {
                                        cs[nc++] = {tm, q.t1, Pm, q.Pb, q.depth + 1};
                                        cs[nc++] = {q.t0, tm, q.Pa, Pm, q.depth + 1};
                                        continue;
                                    }
                                    push(q.t0, q.t1, length(q.Pa - g.src), length(q.Pb - g.src), FACE_N[f0i]);
                                }
                            }
                            continue;
                        }
                        float lo = p.t0, hi = p.t1;
                        for (int it = 0; it < 14; it++) {
                            const float mid = 0.5f * (lo + hi);
                            int fm;
                            exit_face(g.src, dirf(mid), mn, mx, fm);
                            if (fm == f0i) lo = mid; else hi = mid;
                        }
                        if (ns + 2 <= 8) {
                            // les deux cotes du coin se touchent (meme angle) : pas de trou
                            st[ns++] = {0.5f * (lo + hi), p.t1};
                            st[ns++] = {p.t0, 0.5f * (lo + hi)};
                        }
                    }
                }
                return;
            }
            const bool fan = g.traits > 1.5f && g.half_angle > 1e-6f;
            LaserHit h = {};
            h.src = g.src;
            if (!fan) {
                // trait : point d'arrivee
                h.kind = 1;
                h.a = g.src + g.ec * g.range;
                h.b = h.a;
                h.nrm = g.ec;
                h.f0 = g.flux;
                int face;
                const float tw = exit_face(g.src, g.ec, mn, mx, face);
                vec3 sn = FACE_N[face];
                if (g.range < tw - 0.01f) all_obs(h.a, sn);
                h.surf = sn;
                out.push_back(h);
                return;
            }
            const vec3 nrm = normalize(cross(g.ec, g.es));
            const float ha = g.half_angle;
            const vec3 f0 = g.flux / (2.0f * ha), f1 = g.flux1 / (2.0f * ha);   // puissance par radian aux bords
            auto dir = [&](float th) { return g.ec * std::cos(th) + g.es * std::sin(th); };
            h.kind = 0;
            h.nrm = nrm;
            if (g.range1 > 0.0f) {
                // coupe : ligne sur la face de l'obstacle
                h.a = g.src + dir(-ha) * g.range;
                h.b = g.src + dir(ha) * g.range1;
                h.f0 = f0;
                h.f1 = f1;
                h.span = 2.0f * ha;
                vec3 sn = {0, 1, 0};
                all_obs((h.a + h.b) * 0.5f, sn);
                h.surf = sn;
                out.push_back(h);
                return;
            }
            // parois du hangar : morceaux d'angle qui sortent par la meme face
            struct Piece { float t0, t1; };
            Piece st[8];
            int ns = 0;
            st[ns++] = {-ha, ha};
            int guard = 0;
            while (ns > 0 && guard++ < 16) {
                const Piece p = st[--ns];
                int fa, fb;
                const float ta = exit_face(g.src, dir(p.t0), mn, mx, fa), tb = exit_face(g.src, dir(p.t1), mn, mx, fb);
                if (fa == fb || p.t1 - p.t0 < 1e-5f) {
                    const float u0 = (p.t0 + ha) / (2.0f * ha), u1 = (p.t1 + ha) / (2.0f * ha);
                    LaserHit q = h;
                    q.a = g.src + dir(p.t0) * ta;
                    q.b = g.src + dir(p.t1) * tb;
                    q.f0 = f0 + (f1 - f0) * u0;
                    q.f1 = f0 + (f1 - f0) * u1;
                    q.span = p.t1 - p.t0;
                    q.surf = FACE_N[fa];
                    out.push_back(q);
                    continue;
                }
                // coin : angle ou la face de sortie change (dichotomie)
                float lo = p.t0, hi = p.t1;
                for (int it = 0; it < 14; it++) {
                    const float m = 0.5f * (lo + hi);
                    int fm;
                    exit_face(g.src, dir(m), mn, mx, fm);
                    if (fm == fa) lo = m; else hi = m;
                }
                if (ns + 2 <= 8) {
                    st[ns++] = {hi, p.t1};
                    st[ns++] = {p.t0, lo};
                }
            }
    };
    // plusieurs coeurs : un laser par tache (plages de update), impacts mis bout a bout dans l'ordre (meme resultat que
    // sur un seul coeur) ; une figure fixe (cache, morceaux entiers) reprend ses impacts
    const int nt = (int)task_ranges.size();
    static std::vector<std::vector<LaserHit>> parts;
    if ((int)parts.size() < nt) parts.resize(nt);
    std::atomic<int> next{0};
    const std::function<void(int)> job = [&](int) {
        for (int t; (t = next.fetch_add(1)) < nt;) {
            const TaskRange& r = task_ranges[t];
            const int slot = t < (int)task_slot.size() ? task_slot[t] : -1;
            FigCache* c = slot >= 0 && slot < (int)fig_cache.size() && r.whole ? &fig_cache[slot] : nullptr;
            parts[t].clear();
            if (c && c->hits_valid) continue;
            for (int i = r.a; i < r.b; i++) one(segs[i], parts[t]);
            if (c) {
                c->hits = parts[t];
                c->hits_valid = true;
            }
        }
    };
    if (nt > 1) work_pool().run(job);
    else job(0);
    for (int t = 0; t < nt && (int)hits.size() < LASER_MAX_SEGS * 2; t++) {
        const TaskRange& r = task_ranges[t];
        const int slot = t < (int)task_slot.size() ? task_slot[t] : -1;
        const std::vector<LaserHit>& src =
            slot >= 0 && slot < (int)fig_cache.size() && r.whole && fig_cache[slot].hits_valid ? fig_cache[slot].hits : parts[t];
        const size_t cnt = std::min(src.size(), (size_t)(LASER_MAX_SEGS * 2) - hits.size());
        hits.insert(hits.end(), src.begin(), src.begin() + cnt);
    }
}
