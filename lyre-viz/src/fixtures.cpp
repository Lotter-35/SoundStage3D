#include "fixtures.h"
#include <algorithm>

const char* PRISM_NAMES[PRISM_COUNT] = {"Aucun", "3 facettes", "6 facettes", "8 facettes", "9 (8 + centre)", "9 (grille 3x3)", "Lineaire 4"};
const char* GOBO_NAMES[NUM_GOBOS] = {"Ouvert", "Points", "Etoile", "Anneaux", "Rayons", "Fleur", "Breakup", "Triangles",
                                     "Barres", "Cercle de points", "Spirale", "Feuillage", "Galaxie", "Croix"};
const char* EFFECT_NAMES[FX_COUNT] = {"Cercle (pan/tilt)", "Vague pan", "Vague tilt", "Huit", "Eventail", "Chenillard dimmer",
                                      "Arc-en-ciel", "Alternance 2 couleurs", "Pulsation zoom"};
const char* WAVE_NAMES[WAVE_COUNT] = {"Sinus", "Triangle", "Carre", "Dent de scie"};

vec3 fixture_dir(const Fixture& f, float pan_deg, float tilt_deg) {
    float p = pan_deg * DEG, t = tilt_deg * DEG;
    vec3 h = f.mount.f * std::cos(p) + f.side * std::sin(p);
    return f.mount.n * std::cos(t) + h * std::sin(t);
}

void Rig::build(const Scene& scene) {
    fixtures.clear();
    effects.clear();
    for (const FixtureMount& m : scene.mounts) {
        Fixture f;
        f.mount = m;
        f.side = normalize(cross(m.n, m.f));
        FixtureParams& p = f.base;
        p.zoom = 4;
        p.focus = 18;
        switch (m.group) {
            case 0: case 3: p.tilt = 28; p.color = {1, 1, 1}; break;
            case 1: case 2: p.tilt = 12; p.color = {0.05f, 0.25f, 1.0f}; break;
            case 4: p.tilt = 38; p.color = {1, 1, 1}; break;         // pont de scene vers le public
            case 5: p.tilt = 15; p.color = {0.05f, 0.25f, 1.0f}; break;
            default: p.tilt = 25; p.color = {1, 1, 1}; break;
        }
        f.pan = p.pan;
        f.tilt = p.tilt;
        fixtures.push_back(f);
    }
    // Effet de depart : vague lente sur les trusses blancs
    select_all(false);
    select_group(0, true);
    select_group(3, true);
    add_effect(FX_TILT_WAVE);
    effects.back().size = 15;
    effects.back().speed = 0.12f;
    select_all(false);
}

int Rig::first_selected() const {
    for (size_t i = 0; i < fixtures.size(); i++) if (fixtures[i].selected) return (int)i;
    return -1;
}
int Rig::selected_count() const {
    int n = 0;
    for (const Fixture& f : fixtures) n += f.selected ? 1 : 0;
    return n;
}
void Rig::select_group(int group, bool additive) {
    for (Fixture& f : fixtures) {
        if (f.mount.group == group) f.selected = true;
        else if (!additive) f.selected = false;
    }
}
void Rig::select_all(bool v) { for (Fixture& f : fixtures) f.selected = v; }
void Rig::invert_selection() { for (Fixture& f : fixtures) f.selected = !f.selected; }
void Rig::select_odd_even(bool odd) {
    // garde dans la selection une lyre sur deux
    int k = 0;
    for (Fixture& f : fixtures) {
        if (!f.selected) continue;
        f.selected = ((k & 1) == 1) == odd;
        k++;
    }
}
void Rig::home_selected() {
    for_selected([](FixtureParams& p) { p.pan = 0; p.tilt = 0; p.aim_point = -1; });
}

void Rig::add_effect(int type) {
    Effect e;
    e.type = type;
    e.name = EFFECT_NAMES[type];
    for (size_t i = 0; i < fixtures.size(); i++) if (fixtures[i].selected) e.fixtures.push_back((int)i);
    switch (type) {
        case FX_CIRCLE: e.size = 20; e.speed = 0.25f; break;
        case FX_PAN_WAVE: case FX_TILT_WAVE: e.size = 25; e.speed = 0.2f; break;
        case FX_FIGURE8: e.size = 20; e.speed = 0.15f; break;
        case FX_FAN: e.size = 30; e.speed = 0; e.spread = 0; break;
        case FX_DIMMER_CHASE: e.size = 1; e.speed = 1; e.wave = WAVE_SQUARE; e.duty = 0.3f; break;
        case FX_RAINBOW: e.speed = 0.1f; e.size = 1; break;
        case FX_COLOR_ALT: e.speed = 0.5f; e.wave = WAVE_SQUARE; break;
        case FX_ZOOM_PULSE: e.size = 0.6f; e.speed = 0.5f; break;
    }
    effects.push_back(e);
}

void Rig::aim_angles(const Fixture& f, vec3 target, float& pan, float& tilt) const {
    vec3 v = normalize(target - f.head_center);
    float vn = clampf(dot(v, f.mount.n), -1, 1);
    float t0 = std::acos(vn) / DEG;
    float p0 = std::atan2(dot(v, f.side), dot(v, f.mount.f)) / DEG;
    float best = 1e30f;
    float cur_p = f.pan, cur_t = f.tilt;
    for (int flip = 0; flip < 2; flip++) {
        float pp = flip ? p0 + 180 : p0;
        float tt = flip ? -t0 : t0;
        if (tt < -135 || tt > 135) continue;
        for (int k = -2; k <= 2; k++) {
            float pk = pp + 360.0f * k;
            if (pk < -270 || pk > 270) continue;
            float cost = std::fabs(pk - cur_p) + std::fabs(tt - cur_t);
            if (cost < best) { best = cost; pan = pk; tilt = tt; }
        }
    }
    if (best == 1e30f) { pan = p0; tilt = t0; }
}

static float wave_value(int wave, float phase, float duty) {
    float f = fractf(phase);
    switch (wave) {
        case WAVE_TRIANGLE: return 1.0f - 4.0f * std::fabs(f - 0.5f);
        case WAVE_SQUARE: return f < duty ? 1.0f : -1.0f;
        case WAVE_SAW: return 2.0f * f - 1.0f;
        default: return std::sin(2.0f * PI * f);
    }
}

void Rig::update(float dt) {
    time += dt;
    // 1. programmeur -> sorties, visee
    for (Fixture& f : fixtures) {
        f.out = f.base;
        if (f.base.aim_point >= 0 && f.base.aim_point < 4) aim_angles(f, aim_points[f.base.aim_point], f.out.pan, f.out.tilt);
    }
    // 2. effets
    for (Effect& e : effects) {
        e.phase += e.speed * dt;
        if (!e.enabled || e.fixtures.empty()) continue;
        int n = (int)e.fixtures.size();
        int wings = std::max(1, e.wings);
        for (int i = 0; i < n; i++) {
            int idx = e.fixtures[i];
            if (idx < 0 || idx >= (int)fixtures.size()) continue;
            FixtureParams& o = fixtures[idx].out;
            float pos = n > 1 ? (float)i / (float)n : 0.0f;
            float seg = pos * wings;
            float local = fractf(seg);
            if (((int)seg) & 1) local = 1.0f - local;
            float ph = e.phase + local * e.spread / 360.0f;
            float w = wave_value(e.wave, ph, e.duty);
            float w01 = 0.5f + 0.5f * w;
            switch (e.type) {
                case FX_CIRCLE:
                    o.pan += e.size * std::cos(2 * PI * ph);
                    o.tilt += e.size * std::sin(2 * PI * ph);
                    break;
                case FX_PAN_WAVE: o.pan += e.size * w; break;
                case FX_TILT_WAVE: o.tilt += e.size * w; break;
                case FX_FIGURE8:
                    o.pan += e.size * std::sin(2 * PI * ph);
                    o.tilt += e.size * 0.5f * std::sin(4 * PI * ph);
                    break;
                case FX_FAN: {
                    float centered = n > 1 ? 2.0f * (float)i / (float)(n - 1) - 1.0f : 0.0f;
                    float amount = e.speed > 0 ? wave_value(e.wave, e.phase, e.duty) : 1.0f;
                    o.pan += e.size * centered * amount;
                    break;
                }
                case FX_DIMMER_CHASE: o.dimmer *= 1.0f - clampf(e.size, 0, 1) * (1.0f - w01); break;
                case FX_RAINBOW: o.color = hsv2rgb(ph, clampf(e.size, 0, 1), 1); break;
                case FX_COLOR_ALT: o.color = w > 0 ? e.color_a : e.color_b; break;
                case FX_ZOOM_PULSE: o.zoom = clampf(o.zoom * (1.0f + e.size * w), 1.5f, 55); break;
            }
        }
    }
    // 3. mouvements physiques et valeurs derivees
    auto move = [&](float& pos, float& vel, float target, float vmax) {
        if (instant_moves) { pos = target; vel = 0; return; }
        float err = target - pos;
        float vdes = (err > 0 ? 1.0f : -1.0f) * std::min(vmax, std::sqrt(2.0f * accel * std::fabs(err)));
        float dv = clampf(vdes - vel, -accel * dt, accel * dt);
        vel += dv;
        pos += vel * dt;
        if (std::fabs(target - pos) < 0.02f && std::fabs(vel) < 2.0f) { pos = target; vel = 0; }
    };
    for (Fixture& f : fixtures) {
        FixtureParams& o = f.out;
        o.pan = clampf(o.pan, -270, 270);
        o.tilt = clampf(o.tilt, -135, 135);
        move(f.pan, f.pan_vel, o.pan, pan_speed);
        move(f.tilt, f.tilt_vel, o.tilt, tilt_speed);
        f.gobo_rot += (o.gobo_speed * DEG) * dt;
        f.prism_rot += (o.prism_speed * DEG) * dt;
        f.gobo_rot = std::fmod(f.gobo_rot, 2 * PI);
        f.prism_rot = std::fmod(f.prism_rot, 2 * PI);

        f.head_center = f.mount.pos + f.mount.n * 0.47f;
        f.dir = fixture_dir(f, f.pan, f.tilt);
        float p = f.pan * DEG;
        vec3 h = f.mount.f * std::cos(p) + f.side * std::sin(p);
        f.tilt_axis = normalize(cross(f.mount.n, h));
        f.up = normalize(cross(f.tilt_axis, f.dir));
        f.lens_pos = f.head_center + f.dir * 0.24f;

        float gate = 1.0f;
        if (o.strobe > 0.05f) gate = fractf((float)time * o.strobe) < 0.2f ? 1.0f : 0.0f;
        f.emit = o.color * (clampf(o.dimmer, 0, 1) * master * gate);
    }
}
