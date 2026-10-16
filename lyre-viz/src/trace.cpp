// Moteur de trace : miroirs, faisceaux et balayages, ajustement en arcs et en droites (voir trace.h).
#include "trace.h"
#include <algorithm>
#include <cmath>

namespace {

constexpr float TWO_PI = 6.28318531f;

inline vec2 add2(vec2 a, vec2 b) { return {a.x + b.x, a.y + b.y}; }
inline vec2 sub2(vec2 a, vec2 b) { return {a.x - b.x, a.y - b.y}; }
inline vec2 mul2(vec2 a, float s) { return {a.x * s, a.y * s}; }
inline float dot2(vec2 a, vec2 b) { return a.x * b.x + a.y * b.y; }
inline float cross2(vec2 a, vec2 b) { return a.x * b.y - a.y * b.x; }
inline float len2(vec2 a) { return std::sqrt(dot2(a, a)); }
inline vec2 norm2(vec2 a) {
    const float l = len2(a);
    return l > 1e-20f ? mul2(a, 1.0f / l) : vec2{1.0f, 0.0f};
}
inline float lum(vec3 c) { return c.x + c.y + c.z; }
// angle ramene dans [0, 2 pi)
inline float wrap(float a) { return a - TWO_PI * std::floor(a / TWO_PI); }

// Geometrie d'un morceau en cours d'essai.
struct Geo {
    bool ok = false, arc = false;
    vec2 p{0, 0}, q{0, 0}, c{0, 0};
    float rho = 0, a0 = 0, da = 0, len = 0;
};

Geo geo_line(vec2 p, vec2 q) {
    Geo g;
    g.ok = true;
    g.p = p;
    g.q = q;
    g.len = len2(sub2(q, p));
    return g;
}

// Arc de centre c de p a q, dans le sens s (> 0 : trigonometrique). Presque plat ou immense : droite.
Geo geo_arc(vec2 p, vec2 q, vec2 c, float s, float tol) {
    const float rho = len2(sub2(p, c));
    const float ap = std::atan2(p.y - c.y, p.x - c.x), aq = std::atan2(q.y - c.y, q.x - c.x);
    const float da = s > 0.0f ? wrap(aq - ap) : -wrap(ap - aq);
    if (!(rho < 1e3f) || rho * (1.0f - std::cos(0.5f * da)) < 0.1f * tol) return geo_line(p, q);
    Geo g;
    g.ok = true;
    g.arc = true;
    g.p = p;
    g.q = q;
    g.c = c;
    g.rho = rho;
    g.a0 = ap;
    g.da = da;
    g.len = rho * std::fabs(da);
    return g;
}

// Arc qui part de p avec la tangente t et passe par q.
Geo geo_tangent(vec2 p, vec2 t, vec2 q, float tol) {
    const vec2 v = sub2(q, p), n = {-t.y, t.x};
    const float vv = dot2(v, v), den = 2.0f * dot2(n, v);
    if (vv <= 0.0f) return Geo();
    if (std::fabs(den) <= 1e-7f * std::sqrt(vv)) {
        if (dot2(v, t) <= 0.0f) return Geo();   // q derriere : demi-tour
        return geo_line(p, q);
    }
    const float sc = vv / den;
    return geo_arc(p, q, add2(p, mul2(n, sc)), sc, tol);
}

// Cercle par trois points (p, m, q dans l'ordre du trace).
Geo geo_three(vec2 p, vec2 m, vec2 q, float tol) {
    const vec2 a = sub2(m, p), b = sub2(q, p);
    const float aa = dot2(a, a), bb = dot2(b, b), d = 2.0f * cross2(a, b);
    if (std::fabs(d) <= 1e-9f * std::sqrt(aa * bb)) return geo_line(p, q);
    const vec2 c = add2(p, vec2{(b.y * aa - a.y * bb) / d, (a.x * bb - b.x * aa) / d});
    return geo_arc(p, q, c, cross2(a, sub2(q, m)), tol);
}

// Ecart d'un point au morceau (grand s'il est hors du morceau).
float deviation(const Geo& g, vec2 x, float tol) {
    if (!g.arc) {
        const vec2 d = sub2(g.q, g.p);
        if (g.len <= 0.0f) return len2(sub2(x, g.p));
        const vec2 u = mul2(d, 1.0f / g.len);
        const vec2 r = sub2(x, g.p);
        const float s = dot2(r, u);
        if (s < -tol || s > g.len + tol) return 1e30f;
        return std::fabs(cross2(u, r));
    }
    const vec2 r = sub2(x, g.c);
    const float a = std::atan2(r.y, r.x) - g.a0;
    const float rel = g.da > 0.0f ? wrap(a) : wrap(-a), sw = std::fabs(g.da), slack = tol / g.rho + 1e-5f;
    if (rel > sw + slack && rel < TWO_PI - slack) return 1e30f;
    return std::fabs(len2(r) - g.rho);
}

// Un balayage : points Q[0..m], energie e[k] du pas Q[k-1] -> Q[k] (k >= 1).
struct Run {
    std::vector<vec2> Q;
    std::vector<vec3> e;
};

// Ajustement d'un balayage en arcs et droites raccordes.
class Fitter {
public:
    Fitter(const Run& r, float tol) : Q(r.Q), tol(tol) {
        const int m = (int)Q.size() - 1;
        s.assign(m + 1, 0.0f);
        E.assign(m + 1, vec3());
        for (int k = 1; k <= m; k++) {
            s[k] = s[k - 1] + len2(sub2(Q[k], Q[k - 1]));
            E[k] = E[k - 1] + r.e[k];
        }
    }

    // Morceaux de tout le balayage, chacun le plus long possible (cercle par trois points du trace, ou droite). Pas de
    // tangente imposee d'un morceau au suivant (elle fait deriver les rayons d'un arc a l'autre) : chaque morceau
    // colle au trace a tol pres, l'angle entre deux morceaux voisins reste de l'ordre de tol / longueur, invisible ;
    // un vrai coin du trace arrete simplement le morceau. Faux si 'limit' est depasse.
    bool fit(std::vector<TracePrim>& out, int limit) {
        const int m = (int)Q.size() - 1;
        int i = 0;
        while (i < m) {
            Geo g;
            const int j = longest(i, false, vec2{1, 0}, g);
            if ((int)out.size() >= limit) return false;
            out.push_back(make_prim(g, i, j));
            i = j;
        }
        return true;
    }

private:
    const std::vector<vec2>& Q;
    float tol;
    std::vector<float> s;
    std::vector<vec3> E;

    Geo geometry(int i, int j, bool useT, vec2 T) const {
        if (useT) return geo_tangent(Q[i], T, Q[j], tol);
        if (j - i < 2) return geo_line(Q[i], Q[j]);
        // point du milieu (en longueur)
        const float sm = 0.5f * (s[i] + s[j]);
        int a = i + 1, b = j - 1;
        while (a < b) {
            const int c = (a + b + 1) / 2;
            if (s[c] <= sm) a = c; else b = c - 1;
        }
        return geo_three(Q[i], Q[a], Q[j], tol);
    }

    // Energie cumulee depuis Q[i] a la longueur sl (interpolee).
    vec3 cum_energy(int i, int j, float sl) const {
        const float target = s[i] + sl;
        int a = i, b = j;
        while (b - a > 1) {
            const int c = (a + b) / 2;
            if (s[c] <= target) a = c; else b = c;
        }
        const float w = s[b] > s[a] ? clampf((target - s[a]) / (s[b] - s[a]), 0.0f, 1.0f) : 0.0f;
        return E[a] + (E[b] - E[a]) * w - E[i];
    }

    // Lumiere lineaire le long du morceau : energies aux bouts (voir TracePrim), juste au milieu et au total.
    void end_energy(int i, int j, vec3& f0, vec3& f1) const {
        const vec3 Et = E[j] - E[i];
        const float L = s[j] - s[i];
        if (j - i < 2 || L <= 0.0f) {
            f0 = f1 = Et;
            return;
        }
        const vec3 Em = cum_energy(i, j, 0.5f * L);
        f0 = Em * 4.0f - Et;
        f1 = Et * 3.0f - Em * 4.0f;
        for (int c = 0; c < 3; c++) {
            if (f0[c] < 0.0f) { f0[c] = 0.0f; f1[c] = 2.0f * Et[c]; }
            if (f1[c] < 0.0f) { f1[c] = 0.0f; f0[c] = 2.0f * Et[c]; }
        }
    }

    bool fits(int i, int j, bool useT, vec2 T, Geo& g) const {
        g = geometry(i, j, useT, T);
        if (!g.ok) return false;
        if (g.arc && std::fabs(g.da) > 4.7f) return false;   // 270 deg au plus
        for (int k = i + 1; k < j; k++)
            if (deviation(g, Q[k], tol) > tol) return false;
        if (j - i < 3) return true;
        // la lumiere doit rester lineaire le long du morceau (a 15 % pres), couleur par couleur
        vec3 f0, f1;
        end_energy(i, j, f0, f1);
        const vec3 Et = E[j] - E[i];
        const float L = s[j] - s[i], el = lum(Et);
        if (L <= 0.0f) return true;
        for (int k = i + 1; k < j; k++) {
            const float u = (s[k] - s[i]) / L;
            const vec3 model = f0 * u + (f1 - f0) * (0.5f * u * u), act = E[k] - E[i];
            for (int c = 0; c < 3; c++)
                if (std::fabs(act[c] - model[c]) > 0.15f * Et[c] + 0.02f * el) return false;
        }
        return true;
    }

    // Le j le plus loin (recherche par doublement puis dichotomie) dont le morceau i..j passe.
    int longest(int i, bool useT, vec2 T, Geo& g) const {
        const int m = (int)Q.size() - 1;
        Geo gg;
        if (!fits(i, i + 1, useT, T, gg)) {
            if (useT) return longest(i, false, T, g);
            g = geo_line(Q[i], Q[i + 1]);
            return i + 1;
        }
        g = gg;
        int lo = i + 1, hi = -1, step = 2;
        while (true) {
            const int j = std::min(i + step, m);
            if (j <= lo) break;
            if (fits(i, j, useT, T, gg)) {
                lo = j;
                g = gg;
                if (j == m) break;
                step *= 2;
            } else {
                hi = j;
                break;
            }
        }
        while (hi > lo + 1) {
            const int j = (lo + hi) / 2;
            if (fits(i, j, useT, T, gg)) {
                lo = j;
                g = gg;
            } else {
                hi = j;
            }
        }
        return lo;
    }

    TracePrim make_prim(const Geo& g, int i, int j) const {
        TracePrim p;
        p.kind = g.arc ? TP_ARC : TP_LINE;
        p.p0 = Q[i];
        p.p1 = Q[j];
        p.c = g.c;
        p.rho = g.rho;
        p.a0 = g.a0;
        p.da = g.da;
        end_energy(i, j, p.f0, p.f1);
        return p;
    }
};

}  // namespace

bool trace_fit(const std::vector<float>& x, const std::vector<float>& y, const std::vector<vec3>& col,
               const TraceParams& p, int limit, std::vector<TracePrim>& out) {
    out.clear();
    const int n = (int)x.size();
    if (n == 0) return true;
    const float inv = 1.0f / (float)n;
    // miroirs : suivi du 2e ordre amorti (constante de temps scan_us). La couleur est retardee du retard des miroirs
    // (2 scan_us : le laser s'allume quand ils arrivent). Image entierement allumee : en boucle (2 tours, regime etabli).
    // Sinon, chaque course allumee a part : les miroirs partent au repos de son premier point (les sauts eteints sont
    // supposes assez longs pour qu'ils y arrivent), puis, apres son dernier point, le laser s'eteint quand ils l'ont
    // rejoint (dernier point tenu le temps du retard). Pas de trainee allumee pendant un saut eteint : un projecteur
    // bien regle (choix « sans defaut »), quel que soit le nombre de points de saut du fichier.
    std::vector<vec2> pos(n);
    std::vector<char> lit(n);
    for (int i = 0; i < n; i++) lit[i] = lum(col[i]) > 1e-9f;
    if (p.scan_us > 0.0f && n > 1) {
        const float w = 1.0f / (p.scan_us * 1e-6f), dt = 1.0f / std::max(p.pps, 1.0f);
        const int sub = std::max(1, (int)std::ceil(dt * w * 4.0f));
        const float h = dt / (float)sub;
        const int shift = std::min(n - 1, (int)std::lround(2.0f * p.scan_us * 1e-6f * p.pps));
        float X = 0.0f, Y = 0.0f, VX = 0.0f, VY = 0.0f;
        auto step = [&](float tx, float ty) {
            for (int k = 0; k < sub; k++) {
                VX += (w * w * (tx - X) - 2.0f * w * VX) * h;
                VY += (w * w * (ty - Y) - 2.0f * w * VY) * h;
                X += VX * h;
                Y += VY * h;
            }
        };
        int first_dark = -1;
        for (int i = 0; i < n && first_dark < 0; i++) if (!lit[i]) first_dark = i;
        if (first_dark < 0) {
            // en boucle ; position du point i : celle des miroirs 'shift' pas plus tard
            X = x[n - 1];
            Y = y[n - 1];
            for (int pass = 0; pass < 2; pass++)
                for (int i = 0; i < n; i++) {
                    step(x[i], y[i]);
                    if (pass == 1) pos[(i - shift + n) % n] = {X, Y};
                }
        } else {
            // courses allumees, en partant d'un point eteint
            for (int c = 0; c < n;) {
                const int a = (first_dark + c) % n;
                if (!lit[a]) { c++; continue; }
                int len = 0;
                while (c + len < n && lit[(a + len) % n]) len++;
                X = x[a];
                Y = y[a];
                VX = VY = 0.0f;
                for (int k = 0; k < len + shift; k++) {
                    const int src = (a + std::min(k, len - 1)) % n;
                    step(x[src], y[src]);
                    if (k >= shift) pos[(a + k - shift) % n] = {X, Y};
                }
                c += len;
            }
        }
    } else {
        for (int i = 0; i < n; i++) pos[i] = {x[i], y[i]};
    }
    // pas i : de pos[i - 1] a pos[i], energie de sa couleur ; 0 eteint, 1 sur place, 2 balayage. Le premier point
    // d'une course allumee n'a pas de pas allume avant lui : sur place.
    std::vector<vec3> e(n);
    std::vector<int> cls(n, 0);
    for (int i = 0; i < n; i++) {
        e[i] = col[i] * inv;
        if (!lit[i]) continue;
        const int pi = (i - 1 + n) % n;
        cls[i] = !lit[pi] || len2(sub2(pos[i], pos[pi])) < p.dwell ? 1 : 2;
    }
    // premier point d'une course allumee : point de depart du pas suivant, qui recoit sa lumiere (sinon chaque trait
    // aurait un petit faisceau a son debut)
    for (int i = 0; i < n; i++) {
        const int pi = (i - 1 + n) % n, ni = (i + 1) % n;
        if (!lit[i] || lit[pi] || !lit[ni] || ni == i) continue;
        e[ni] += e[i];
        e[i] = vec3();
        cls[i] = 0;
    }
    // un passage lent (pas courts, mais qui avance) n'est pas un faisceau : etendue au-dela de 4 x dwell (les miroirs
    // qui finissent d'arriver sur un coin tenu font encore quelques pas courts : le coin reste un faisceau)
    {
        std::vector<char> seen(n, 0);
        for (int i = 0; i < n; i++) {
            if (cls[i] != 1 || seen[i]) continue;
            int a = i;
            while (cls[(a - 1 + n) % n] == 1 && (a - 1 + n) % n != i) a = (a - 1 + n) % n;
            std::vector<int> idx;
            for (int k = a, c = 0; cls[k] == 1 && c < n; k = (k + 1) % n, c++) {
                idx.push_back(k);
                seen[k] = 1;
            }
            float ext = 0.0f;
            for (int k : idx) ext = std::max(ext, len2(sub2(pos[k], pos[idx[0]])));
            if (ext > 4.0f * p.dwell)
                for (int k : idx) cls[k] = 2;
        }
    }
    // depart du parcours a un changement de classe (sinon un balayage serait coupe en deux au point 0)
    int start = 0;
    for (int i = 0; i < n; i++)
        if (cls[i] != cls[(i - 1 + n) % n]) { start = i; break; }
    // faisceaux (fusionnes s'ils sont au meme endroit), balayages
    struct Beam { vec2 p; vec3 f; };
    std::vector<Beam> beams;
    auto add_beam = [&](vec2 q, vec3 f) {
        for (int k = std::max(0, (int)beams.size() - 48); k < (int)beams.size(); k++) {
            Beam& b = beams[k];
            if (len2(sub2(b.p, q)) < 2.0f * p.dwell) {
                const float w0 = lum(b.f), w1 = lum(f), wt = w0 + w1 > 0.0f ? w1 / (w0 + w1) : 0.5f;
                b.p = add2(b.p, mul2(sub2(q, b.p), wt));
                b.f += f;
                return;
            }
        }
        beams.push_back({q, f});
    };
    std::vector<Run> runs;
    for (int c = 0; c < n;) {
        const int i = (start + c) % n;
        const int k0 = cls[i];
        if (k0 == 0) { c++; continue; }
        if (k0 == 1) {
            vec2 acc{0, 0};
            vec3 f;
            float wl = 0.0f;
            while (c < n && cls[(start + c) % n] == 1) {
                const int k = (start + c) % n;
                acc = add2(acc, mul2(pos[k], lum(e[k])));
                wl += lum(e[k]);
                f += e[k];
                c++;
            }
            add_beam(mul2(acc, 1.0f / std::max(wl, 1e-30f)), f);
            continue;
        }
        Run r;
        r.Q.push_back(pos[(i - 1 + n) % n]);
        r.e.push_back(vec3());
        while (c < n && cls[(start + c) % n] == 2) {
            const int k = (start + c) % n;
            r.Q.push_back(pos[k]);
            r.e.push_back(e[k]);
            c++;
        }
        runs.push_back(std::move(r));
    }
    // balayage plus court que dwell : un faisceau en son milieu
    for (const Run& r : runs) {
        float L = 0.0f;
        vec3 f;
        for (size_t k = 1; k < r.Q.size(); k++) {
            L += len2(sub2(r.Q[k], r.Q[k - 1]));
            f += r.e[k];
        }
        if (L < p.dwell) {
            add_beam(mul2(add2(r.Q.front(), r.Q.back()), 0.5f), f);
            continue;
        }
        Fitter ft(r, p.tol);
        if (!ft.fit(out, limit)) return false;
    }
    for (const Beam& b : beams) {
        if ((int)out.size() >= limit) return false;
        TracePrim t;
        t.kind = TP_BEAM;
        t.p0 = t.p1 = b.p;
        t.f0 = t.f1 = b.f;
        out.push_back(t);
    }
    return true;
}

void trace_fit_curve(const std::vector<vec2>& P, float tol, std::vector<TracePrim>& out) {
    out.clear();
    if (P.size() < 2) return;
    Run r;
    r.Q = P;
    r.e.assign(P.size(), vec3(1.0f, 1.0f, 1.0f));   // lumiere uniforme : seule la geometrie decide
    float L = 0.0f;
    for (size_t k = 1; k < P.size(); k++) {
        const float l = len2(sub2(P[k], P[k - 1]));
        r.e[k] = vec3(l, l, l);
        L += l;
    }
    if (L <= 0.0f) return;
    Fitter ft(r, tol);
    ft.fit(out, 1 << 30);
    for (TracePrim& t : out) t.f0 = t.f1 = vec3();
}
