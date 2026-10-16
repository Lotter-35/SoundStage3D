// Ambiances (voir ambiances.h). Reperes de la salle : scene a -X, public a +X, trusses a 18 m (lyres vers le
// bas ; tilt > 0 vers la scene, < 0 vers le public), pont de scene a 12 m (tilt > 0 vers le public), sol et nez
// de scene vers le haut (tilt > 0 vers le public). Lasers : tilt > 0 releve la figure, pan la decale en z.
#include "ambiances.h"
#include "app.h"
#include "scenes/scenes.h"
#include <algorithm>

static_assert(NUM_AMBIANCES == NUM_BASE_AMBIANCES + scenes::NUM_SCENES, "nombre d'ambiances");

const AmbianceInfo AMBIANCES[NUM_BASE_AMBIANCES] = {
    {"Demarrage", "Les lyres du lancement : trusses blancs et bleus, vague lente. Lasers eteints.", {0.6f, 0.7f, 1.0f}},
    {"Lasers simples", "Lasers seuls, verts, au-dessus du public : nappes pleines et eventails de quelques traits (pont), "
                       "traits vers le haut (nez de scene).", {0.0f, 1.0f, 0.2f}},
    {"Ballet blanc", "Faisceaux blancs tres serres qui tournent en cercles decales (2 ailes).", {1.0f, 1.0f, 1.0f}},
    {"Gobos au sol", "Gobos tournants nets au sol, une couleur et un gobo par truss ; fumee legere.", {1.0f, 0.2f, 0.8f}},
    {"Prismes", "Prismes 3, 6 et lineaire qui tournent, faisceaux demultiplies en huit.", {1.0f, 0.6f, 0.15f}},
    {"Arc-en-ciel", "Arc-en-ciel qui defile sur les 200 lyres, vagues et eventails.", {0.9f, 0.3f, 1.0f}},
    {"Sol mouille", "Flaques au sol : reflets des faisceaux et des gobos breakup bleus.", {0.0f, 0.6f, 1.0f}},
    {"Cathedrale", "Fumee epaisse, colonnes de lumiere chaude immobiles, contre-jour du pont.", {1.0f, 0.8f, 0.55f}},
    {"Couronne", "Toutes les lyres visent le meme point au sol et tournent autour.", {1.0f, 0.75f, 0.2f}},
    {"Techno strobe", "Chenillard rouge rapide, blinders stroboscopiques, nappes laser rouges.", {1.0f, 0.0f, 0.0f}},
    {"Aube pastel", "Larges faisceaux tres doux (frost) en couleurs pastel, brume.", {1.0f, 0.6f, 0.75f}},
    {"Brasier", "Rouges et oranges qui vacillent, gobo feuillage, fumee qui monte.", {1.0f, 0.3f, 0.0f}},
    {"Optique nette", "Gobos etoile et croix nets au sol, aberration chromatique forte (franges).", {0.85f, 0.9f, 1.0f}},
    {"Tunnel laser", "Tunnels et cones laser arc-en-ciel vers le public, ouverture qui respire.", {0.3f, 1.0f, 0.9f}},
    {"Plafond laser", "Deux nappes horizontales : verte au-dessus des tetes, bleue en hauteur.", {0.0f, 0.8f, 0.8f}},
    {"Rideaux laser", "Rideaux verticaux magenta et cyan qui ondulent sous les trusses.", {1.0f, 0.0f, 1.0f}},
    {"Constellation", "Grilles de points en reseau de diffraction, balayage aleatoire.", {1.0f, 0.85f, 0.4f}},
    {"Ocean", "Lyres bleues ondulantes, sol mouille, vagues laser avec chenillard de traits.", {0.0f, 0.4f, 1.0f}},
    {"Galaxie", "Gobo galaxie violet, poussiere d'etoiles au sol, traits laser qui scintillent.", {0.45f, 0.1f, 1.0f}},
    {"Grand final", "Tout en meme temps : toutes les formes laser, lyres arc-en-ciel en cercles.", {1.0f, 1.0f, 0.3f}},
};

namespace {

FogSettings fog0;
RenderSettings rs0;
vec3 aim0[4];
float laser_power0 = 2.0f, laser_angle0 = 60.0f;
bool captured = false;

// groupes : 0-3 trusses, 4 pont de scene, 5 sol de scene, 6 nez de scene
enum : unsigned { G_TRUSS = 0xF, G_PONT = 1u << 4, G_SOL = 1u << 5, G_NEZ = 1u << 6, G_ALL = 0x7F };
bool in(unsigned mask, int group) { return group >= 0 && group < 32 && ((mask >> group) & 1u); }

const vec3 WHITE = {1, 1, 1}, RED = {1, 0, 0}, ORANGE = {1, 0.35f, 0}, AMBER = {1, 0.6f, 0.15f}, CTO = {1, 0.78f, 0.55f};
const vec3 GREEN = {0, 1, 0}, CYAN = {0, 0.85f, 1}, BLUE = {0.05f, 0.25f, 1}, DEEP_BLUE = {0, 0, 1}, MAGENTA = {1, 0, 0.8f};

// Lyres des groupes 'mask' : fn(parametres, lyre, rang dans son groupe)
template <typename F> void lyres(unsigned mask, F fn) {
    int kg[32] = {};
    for (Fixture& f : app.rig.fixtures)
        if (in(mask, f.mount.group)) fn(f.base, f, kg[f.mount.group]++);
}
template <typename F> void lasers(unsigned mask, F fn) {
    int kg[32] = {};
    for (LaserFixture& f : app.lasers.fixtures)
        if (in(mask, f.mount.group)) fn(f.base, f, kg[f.mount.group]++);
}

// Effet sur les lyres allumees des groupes 'mask' (valeurs par defaut de add_effect, puis celles-ci).
Effect& lyre_fx(unsigned mask, int type, float size, float speed, float spread, int wings = 1) {
    Rig& rig = app.rig;
    for (Fixture& f : rig.fixtures) f.selected = in(mask, f.mount.group) && f.base.dimmer > 0;
    rig.add_effect(type);
    rig.select_all(false);
    Effect& e = rig.effects.back();
    e.size = size;
    e.speed = speed;
    e.spread = spread;
    e.wings = wings;
    return e;
}
Effect& laser_fx(unsigned mask, int type, float size, float speed, float spread, int wings = 1) {
    LaserRig& lr = app.lasers;
    for (LaserFixture& f : lr.fixtures) f.selected = in(mask, f.mount.group) && f.base.dimmer > 0;
    lr.add_effect(type);
    lr.select_all(false);
    Effect& e = lr.effects.back();
    e.size = size;
    e.speed = speed;
    e.spread = spread;
    e.wings = wings;
    return e;
}

// Mise au point sur le sol d'une lyre suspendue penchee de 'tilt' degres (lentille 0,71 m sous l'accroche).
float floor_focus(const Fixture& f, float tilt) {
    const float h = f.mount.pos.y - 0.71f;
    return clampf(h / std::max(std::cos(tilt * DEG), 0.2f), 1.0f, 80.0f);
}

// Tout eteint, effets supprimes, fumee / sol / aberration / visee aux reglages de depart.
void reset_all() {
    if (!captured) ambiance_capture_defaults();
    app.fog_settings = fog0;
    RenderSettings& r = app.rs;
    r.floor_wet = rs0.floor_wet;
    r.chroma = rs0.chroma;
    r.chroma_strength = rs0.chroma_strength;
    // reglages de l'image que les scenes (src/scenes) peuvent changer
    r.exposure = rs0.exposure;
    r.bloom_strength = rs0.bloom_strength;
    r.lens_glow = rs0.lens_glow;
    r.laser_gain = rs0.laser_gain;
    r.laser_white = rs0.laser_white;
    r.laser_exit = rs0.laser_exit;
    r.laser_air = rs0.laser_air;
    r.laser_vol_strength = rs0.laser_vol_strength;
    r.laser_vol_size = rs0.laser_vol_size;
    app.lasers.power_w = laser_power0;
    app.lasers.max_angle = laser_angle0;
    Rig& rig = app.rig;
    rig.effects.clear();
    for (int i = 0; i < 4; i++) rig.aim_points[i] = aim0[i];
    for (Fixture& f : rig.fixtures) {
        f.base = FixtureParams();
        f.base.dimmer = 0;
        f.selected = false;
    }
    LaserRig& lr = app.lasers;
    lr.pattern = LP_PROGRAM;
    lr.effects.clear();
    for (LaserFixture& f : lr.fixtures) {
        f.base = LaserParams();
        f.base.dimmer = 0;
        f.selected = false;
    }
}

}  // namespace

void ambiance_capture_defaults() {
    fog0 = app.fog_settings;
    rs0 = app.rs;
    for (int i = 0; i < 4; i++) aim0[i] = app.rig.aim_points[i];
    laser_power0 = app.lasers.power_w;
    laser_angle0 = app.lasers.max_angle;
    captured = true;
}

const AmbianceInfo& ambiance_info(int i) {
    i = std::clamp(i, 0, NUM_AMBIANCES - 1);
    return i < NUM_BASE_AMBIANCES ? AMBIANCES[i] : scenes::INFO[i - NUM_BASE_AMBIANCES];
}

void apply_ambiance(int index) {
    if (index < 0 || index >= NUM_AMBIANCES) return;
    reset_all();
    app.ambiance = index;
    if (index >= NUM_BASE_AMBIANCES) {
        scenes::apply(index - NUM_BASE_AMBIANCES);
        return;
    }
    FogSettings& fog = app.fog_settings;
    RenderSettings& r = app.rs;
    switch (index) {
        case 0:   // Demarrage
            app.rig.program_default();
            app.lasers.program_default();
            break;

        case 1:   // Lasers simples : rien vers le public (tout passe au-dessus des tetes)
            lasers(G_PONT, [](LaserParams& p, LaserFixture&, int kg) {
                // une sur deux : nappe pleine, sinon 8 traits separes (moins forts : sinon ils eclipsent les nappes)
                const bool sheet = (kg & 1) == 0;
                p.dimmer = sheet ? 1.0f : 0.25f;
                p.color = GREEN;
                p.opening = sheet ? 30.0f : 40.0f;
                p.traits = sheet ? 1000 : 8;
                p.tilt = 24;                       // 12 deg au-dessus de l'horizontale
            });
            lasers(G_NEZ, [](LaserParams& p, LaserFixture&, int) {
                p.dimmer = 0.25f;
                p.color = GREEN;
                p.opening = 30;
                p.traits = 6;
                p.tilt = 30;   // 35 deg au-dessus de l'horizontale
            });
            laser_fx(G_PONT | G_NEZ, LFX_TILT_WAVE, 3, 0.08f, 360);
            break;

        case 2:   // Ballet blanc
            lyres(G_TRUSS, [](FixtureParams& p, Fixture&, int) {
                p.dimmer = 1;
                p.zoom = 2.5f;
                p.tilt = -18;
            });
            lyre_fx(G_TRUSS, FX_CIRCLE, 16, 0.15f, 360, 2);
            lyres(G_PONT, [](FixtureParams& p, Fixture&, int) {
                p.dimmer = 1;
                p.zoom = 3;
                p.tilt = 30;
            });
            lyre_fx(G_PONT, FX_PAN_WAVE, 25, 0.12f, 180, 2);
            break;

        case 3: {   // Gobos au sol
            static const int gob[4] = {2, 5, 9, 13};
            static const vec3 col[4] = {MAGENTA, CYAN, AMBER, WHITE};
            lyres(G_TRUSS, [](FixtureParams& p, Fixture& f, int kg) {
                const int g = f.mount.group;
                p.dimmer = 1;
                p.color = col[g];
                p.gobo = gob[g];
                p.gobo_speed = (kg & 1) ? 45.0f : -45.0f;
                p.zoom = 14;
                p.tilt = -6;
                p.focus = floor_focus(f, p.tilt);
            });
            lyre_fx(G_TRUSS, FX_TILT_WAVE, 8, 0.08f, 360, 2);
            fog.density *= 0.6f;
            fog.haze = 0.2f;
            break;
        }

        case 4: {   // Prismes
            static const int prisms[3] = {PRISM_3, PRISM_6, PRISM_LINEAR_4};
            lyres(G_TRUSS, [](FixtureParams& p, Fixture& f, int kg) {
                if (kg & 1) return;
                p.dimmer = 1;
                p.color = (f.mount.group & 1) ? AMBER : WHITE;
                p.prism = prisms[(kg / 2) % 3];
                p.prism_speed = (kg & 2) ? 35.0f : -35.0f;
                p.prism_spread = 1.2f;
                p.zoom = 6;
                p.tilt = -20;
            });
            lyre_fx(G_TRUSS, FX_FIGURE8, 15, 0.12f, 360, 2);
            break;
        }

        case 5:   // Arc-en-ciel
            lyres(G_ALL, [](FixtureParams& p, Fixture& f, int) {
                p.dimmer = 1;
                p.zoom = 5;
                p.tilt = f.mount.group < 4 ? -20.0f : (f.mount.group == 4 ? 30.0f : 20.0f);
            });
            lyre_fx(G_ALL, FX_RAINBOW, 1, 0.15f, 360);
            lyre_fx(G_TRUSS, FX_PAN_WAVE, 25, 0.15f, 720);
            lyre_fx(G_PONT | G_SOL | G_NEZ, FX_FAN, 35, 0.1f, 0);
            break;

        case 6:   // Sol mouille
            r.floor_wet = 0.85f;
            fog.density *= 0.8f;
            lyres(G_TRUSS, [](FixtureParams& p, Fixture& f, int kg) {
                if (kg & 1) return;
                p.dimmer = 1;
                p.color = (f.mount.group & 1) ? CYAN : BLUE;
                p.gobo = 6;   // breakup
                p.gobo_speed = (kg & 2) ? 15.0f : -15.0f;
                p.zoom = 14;
                p.tilt = -8;
                p.focus = floor_focus(f, p.tilt);
            });
            lyre_fx(G_TRUSS, FX_CIRCLE, 6, 0.06f, 360);
            lyres(G_PONT, [](FixtureParams& p, Fixture&, int) {
                p.dimmer = 1;
                p.zoom = 6;
                p.tilt = 50;
            });
            lyre_fx(G_PONT, FX_PAN_WAVE, 15, 0.08f, 360);
            break;

        case 7:   // Cathedrale
            fog.density *= 1.5f;
            fog.haze = 0.8f;
            fog.smoke = 1.3f;
            lyres(G_TRUSS, [](FixtureParams& p, Fixture& f, int kg) {
                if (f.mount.group == 1 || f.mount.group == 2 || (kg & 1)) return;
                p.dimmer = 1;
                p.color = CTO;
                p.zoom = 5;
                p.frost = 0.1f;
                p.tilt = 0;
            });
            lyres(G_PONT, [](FixtureParams& p, Fixture&, int) {
                p.dimmer = 1;
                p.color = CTO;
                p.zoom = 4;
                p.iris = 0.8f;
                p.tilt = 58;
            });
            lyre_fx(G_PONT, FX_PAN_WAVE, 4, 0.03f, 360);
            break;

        case 8:   // Couronne
            app.rig.aim_points[0] = {4, 0, 0};
            lyres(G_TRUSS | G_PONT, [](FixtureParams& p, Fixture& f, int kg) {
                if (f.mount.group < 4 && (kg & 1)) return;
                p.dimmer = 1;
                p.color = (kg & 2) ? AMBER : WHITE;
                p.zoom = 2.5f;
                p.iris = 0.7f;
                p.aim_point = 0;
            });
            lyre_fx(G_TRUSS | G_PONT, FX_CIRCLE, 3, 0.2f, 360);
            break;

        case 9: {   // Techno strobe
            lyres(G_TRUSS, [](FixtureParams& p, Fixture&, int) {
                p.dimmer = 1;
                p.color = RED;
                p.zoom = 4;
                p.tilt = -15;
            });
            lyre_fx(G_TRUSS, FX_DIMMER_CHASE, 1, 2.0f, 720, 4);
            lyre_fx(G_TRUSS, FX_TILT_WAVE, 20, 0.5f, 360, 2);
            lyres(G_PONT, [](FixtureParams& p, Fixture&, int) {
                p.dimmer = 1;
                p.zoom = 30;
                p.frost = 0.3f;
                p.tilt = 50;
                p.strobe = 8;
            });
            lasers(G_NEZ, [](LaserParams& p, LaserFixture&, int) {
                p.dimmer = 1;
                p.color = RED;
                p.traits = 12;
                p.opening = 50;
                p.tilt = -3;
            });
            laser_fx(G_NEZ, LFX_TILT_WAVE, 5, 0.5f, 360);
            break;
        }

        case 10: {   // Aube pastel
            static const vec3 col[4] = {{1, 0.45f, 0.6f}, {0.6f, 0.5f, 1}, {1, 0.7f, 0.45f}, {0.5f, 1, 0.75f}};
            fog.haze = 0.45f;
            lyres(G_TRUSS, [](FixtureParams& p, Fixture& f, int kg) {
                if (kg & 1) return;
                p.dimmer = 1;
                p.color = col[f.mount.group];
                p.zoom = 24;
                p.frost = 0.3f;
                p.tilt = 10;
            });
            lyre_fx(G_TRUSS, FX_TILT_WAVE, 15, 0.05f, 360);
            lyres(G_PONT, [](FixtureParams& p, Fixture&, int) {
                p.dimmer = 1;
                p.color = col[2];
                p.zoom = 35;
                p.frost = 0.5f;
                p.tilt = 40;
            });
            break;
        }

        case 11: {   // Brasier
            fog.smoke = 2.0f;
            fog.rise = 0.2f;
            lyres(G_TRUSS, [](FixtureParams& p, Fixture&, int kg) {
                p.dimmer = 1;
                p.color = RED;
                p.gobo = 11;   // feuillage
                p.gobo_speed = (kg & 1) ? 20.0f : -20.0f;
                p.zoom = 14;
                p.frost = 0.1f;
                p.tilt = -10;
            });
            Effect& c = lyre_fx(G_TRUSS, FX_COLOR_ALT, 0, 0.35f, 720, 3);
            c.wave = WAVE_SINE;
            c.color_a = RED;
            c.color_b = ORANGE;
            lyre_fx(G_TRUSS, FX_DIMMER_CHASE, 0.65f, 0.7f, 720, 3).wave = WAVE_SINE;
            lyres(G_PONT, [](FixtureParams& p, Fixture&, int) {
                p.dimmer = 1;
                p.color = AMBER;
                p.zoom = 10;
                p.tilt = 35;
            });
            lyre_fx(G_PONT, FX_DIMMER_CHASE, 0.5f, 0.9f, 360).wave = WAVE_SINE;
            lyres(G_SOL | G_NEZ, [](FixtureParams& p, Fixture&, int) {
                p.dimmer = 1;
                p.color = RED;
                p.zoom = 6;
                p.tilt = 10;
            });
            lyre_fx(G_SOL | G_NEZ, FX_TILT_WAVE, 8, 0.3f, 360);
            break;
        }

        case 12:   // Optique nette
            r.chroma = true;
            r.chroma_strength = 2.5f;
            fog.density *= 0.5f;
            fog.haze = 0.15f;
            lyres(G_TRUSS, [](FixtureParams& p, Fixture& f, int kg) {
                if ((f.mount.group != 1 && f.mount.group != 2) || kg % 3) return;
                const bool star = ((kg / 3) & 1) == 0;
                p.dimmer = 1;
                p.gobo = star ? 2 : 13;   // etoile, croix
                p.prism = star ? PRISM_6 : PRISM_NONE;
                p.prism_speed = 10;
                p.gobo_speed = 12;
                p.zoom = 9;
                p.tilt = -10;
                p.focus = floor_focus(f, p.tilt);
            });
            lyre_fx(G_TRUSS, FX_TILT_WAVE, 6, 0.05f, 360);
            break;

        case 13:   // Tunnel laser
            fog.density *= 1.4f;
            lasers(G_PONT, [](LaserParams& p, LaserFixture&, int kg) {
                p.dimmer = 1;
                p.shape = (kg & 1) ? LS_TUNNEL : LS_CONE;
                p.opening = 18;
                p.traits = 600;
                p.gradient = LG_RAINBOW;
                p.gradient_speed = 0.3f;
                p.roll_speed = (kg & 2) ? 30.0f : -30.0f;
                p.tilt = 10;
            });
            laser_fx(G_PONT, LFX_CIRCLE, 6, 0.15f, 360);
            laser_fx(G_PONT, LFX_OPENING, 0.4f, 0.3f, 180);
            break;

        case 14:   // Plafond laser
            lasers(G_SOL, [](LaserParams& p, LaserFixture&, int) {
                p.dimmer = 1;
                p.color = GREEN;
                p.opening = 60;
                p.traits = 1000;
                p.tilt = -12.5f;   // 2,5 deg au-dessus de l'horizontale : au-dessus des tetes
            });
            laser_fx(G_SOL, LFX_TILT_WAVE, 1.5f, 0.08f, 360);
            lasers(G_PONT, [](LaserParams& p, LaserFixture&, int) {
                p.dimmer = 1;
                p.gradient = LG_TWO;
                p.color = {0, 1, 1};
                p.color2 = {0, 0.2f, 1};
                p.opening = 60;
                p.traits = 1000;
                p.tilt = 12;   // horizontale
            });
            laser_fx(G_PONT, LFX_TILT_WAVE, 2.5f, 0.06f, 90);
            lyres(G_NEZ, [](FixtureParams& p, Fixture&, int) {
                p.dimmer = 0.5f;
                p.color = BLUE;
                p.zoom = 10;
                p.tilt = 10;
            });
            break;

        case 15:   // Rideaux laser
            lasers(G_TRUSS, [](LaserParams& p, LaserFixture&, int kg) {
                if (kg % 6) return;
                p.dimmer = 1;
                p.opening = 40;
                p.traits = 1000;
                p.tilt = -25;   // a la verticale
                p.gradient = LG_SCROLL;
                p.color = {1, 0, 1};
                p.color2 = {0, 1, 1};
                p.gradient_speed = 0.2f;
            });
            laser_fx(G_TRUSS, LFX_ROLL, 20, 0.1f, 360);
            laser_fx(G_TRUSS, LFX_TILT_WAVE, 6, 0.08f, 360);
            break;

        case 16: {   // Constellation
            fog.haze = 0.5f;
            lasers(G_PONT, [](LaserParams& p, LaserFixture&, int) {
                p.dimmer = 1;
                p.shape = LS_GRID;
                p.shape_param = 5;
                p.traits = 25;
                p.opening = 14;
                p.diffraction = 5;
                p.diffraction_angle = 9;
                p.color = {1, 0.85f, 0.4f};
                p.tilt = 6;
            });
            laser_fx(G_PONT, LFX_RANDOM, 12, 0.25f, 360);
            Effect& c = laser_fx(G_PONT, LFX_COLOR_ALT, 0, 0.2f, 360);
            c.color_a = {1, 0.85f, 0.4f};
            c.color_b = {0, 0.8f, 1};
            lasers(G_SOL, [](LaserParams& p, LaserFixture&, int) {
                p.dimmer = 1;
                p.shape = LS_DOUBLE_FAN;
                p.traits = 16;
                p.shape_param = 10;
                p.gradient = LG_RANDOM;
                p.opening = 40;
                p.tilt = -5;
            });
            laser_fx(G_SOL, LFX_SPREAD, 20, 0.1f, 0);
            break;
        }

        case 17:   // Ocean
            r.floor_wet = 0.5f;
            lyres(G_TRUSS, [](FixtureParams& p, Fixture& f, int kg) {
                if (kg & 1) return;
                p.dimmer = 0.8f;
                p.color = (f.mount.group & 1) ? CYAN : BLUE;
                p.gobo = 6;   // breakup
                p.gobo_speed = (kg & 2) ? 10.0f : -10.0f;
                p.zoom = 20;
                p.frost = 0.3f;
                p.tilt = 0;
                p.focus = floor_focus(f, 0);
            });
            lyre_fx(G_TRUSS, FX_TILT_WAVE, 8, 0.06f, 360, 2);
            lasers(G_TRUSS, [](LaserParams& p, LaserFixture&, int kg) {
                if (kg % 6 != 3) return;
                p.dimmer = 1;
                p.shape = LS_WAVE;
                p.opening = 50;
                p.traits = 400;
                p.shape_param = 5;
                p.wave_cycles = 3;
                p.gradient = LG_TWO;
                p.color = {0, 1, 0.8f};
                p.color2 = {0, 0.3f, 1};
            });
            laser_fx(G_TRUSS, LFX_TRAIT_CHASE, 0.3f, 0.3f, 90);
            break;

        case 18: {   // Galaxie
            fog.haze = 0.5f;
            lyres(G_PONT, [](FixtureParams& p, Fixture& f, int kg) {
                p.dimmer = 1;
                p.color = {0.35f, 0, 1};
                p.gobo = 12;   // galaxie
                p.gobo_speed = (kg & 1) ? 8.0f : -8.0f;
                p.zoom = 25;
                p.frost = 0.15f;
                p.tilt = 68;
                p.focus = floor_focus(f, p.tilt);
            });
            lyres(G_TRUSS, [](FixtureParams& p, Fixture& f, int kg) {
                if (kg % 4) return;
                p.dimmer = 1;
                p.color = DEEP_BLUE;
                p.gobo = 1;   // points
                p.gobo_speed = -6;
                p.zoom = 30;
                p.tilt = 0;
                p.focus = floor_focus(f, 0);
            });
            lasers(G_TRUSS, [](LaserParams& p, LaserFixture&, int kg) {
                if (kg % 3) return;
                p.dimmer = 0.15f;
                p.traits = 4;
                p.opening = 50;
                p.gradient = LG_RANDOM;
            });
            laser_fx(G_TRUSS, LFX_RANDOM, 10, 0.15f, 360);
            laser_fx(G_TRUSS, LFX_DIMMER_CHASE, 0.8f, 0.4f, 720, 5).wave = WAVE_SINE;
            break;
        }

        case 19:   // Grand final
            app.lasers.program_showcase();
            lyres(G_TRUSS, [](FixtureParams& p, Fixture&, int) {
                p.dimmer = 1;
                p.zoom = 5;
                p.tilt = -10;
            });
            lyre_fx(G_TRUSS, FX_RAINBOW, 1, 0.2f, 360);
            lyre_fx(G_TRUSS, FX_CIRCLE, 15, 0.25f, 360, 2);
            lyres(G_PONT, [](FixtureParams& p, Fixture&, int) {
                p.dimmer = 1;
                p.zoom = 4;
                p.tilt = 40;
            });
            lyre_fx(G_PONT, FX_DIMMER_CHASE, 1, 2.0f, 360);
            break;
    }
}
