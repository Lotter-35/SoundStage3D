// Lyres : parametres (comme les canaux d'une vraie lyre), mouvements physiques, effets, visee.
#pragma once
#include "mathx.h"
#include "scene.h"
#include <string>
#include <vector>

enum PrismType {
    PRISM_NONE = 0,
    PRISM_3,          // 3 facettes circulaire
    PRISM_6,          // 6 facettes circulaire
    PRISM_8,          // 8 facettes circulaire
    PRISM_9_RING,     // 8 autour + 1 au centre
    PRISM_9_GRID,     // grille 3 x 3
    PRISM_LINEAR_4,   // 4 en ligne
    PRISM_COUNT
};
extern const char* PRISM_NAMES[PRISM_COUNT];

// Nombre de gobos dans la roue (le 0 est "ouvert").
static constexpr int NUM_GOBOS = 14;
extern const char* GOBO_NAMES[NUM_GOBOS];

// Valeurs du "programmeur" d'une lyre (ce que regle l'utilisateur).
struct FixtureParams {
    float pan = 0;          // degres (-270..270)
    float tilt = 0;         // degres (-135..135), 0 = dans l'axe de la base
    float dimmer = 1;       // 0..1
    float strobe = 0;       // Hz, 0 = ouvert
    vec3 color = {1, 1, 1}; // melange de couleur 0..1
    int gobo = 0;
    float gobo_angle = 0;   // degres (indexation)
    float gobo_speed = 0;   // degres / s (rotation continue)
    int prism = PRISM_NONE;
    float prism_speed = 0;  // degres / s
    float prism_spread = 1; // ecartement des facettes (0.3..2)
    float zoom = 8;         // angle total du faisceau en degres (2..50)
    float focus = 20;       // distance de nettete en metres
    float frost = 0;        // 0..1
    float iris = 1;         // 0..1
    int aim_point = -1;     // -1 : pas de visee, sinon indice du point vise
};

struct Fixture {
    FixtureMount mount;
    vec3 side;                  // troisieme axe du repere local
    FixtureParams base;         // programmeur
    FixtureParams out;          // apres effets (cibles)
    float pan = 0, tilt = 0;    // position physique actuelle
    float pan_vel = 0, tilt_vel = 0;
    float gobo_rot = 0, prism_rot = 0;  // angles courants (radians)
    bool selected = false;
    // valeurs derivees pour le rendu
    vec3 head_center, lens_pos, dir, up, tilt_axis;
    vec3 emit;                  // couleur * intensite emise (apres dimmer / strobe)
};

enum EffectType {
    FX_CIRCLE = 0,
    FX_PAN_WAVE,
    FX_TILT_WAVE,
    FX_FIGURE8,
    FX_FAN,
    FX_DIMMER_CHASE,
    FX_RAINBOW,
    FX_COLOR_ALT,
    FX_ZOOM_PULSE,
    FX_COUNT
};
extern const char* EFFECT_NAMES[FX_COUNT];

enum WaveForm { WAVE_SINE = 0, WAVE_TRIANGLE, WAVE_SQUARE, WAVE_SAW, WAVE_COUNT };
extern const char* WAVE_NAMES[WAVE_COUNT];

struct Effect {
    int type = FX_CIRCLE;
    bool enabled = true;
    int wave = WAVE_SINE;
    float speed = 0.25f;      // cycles / s
    float size = 20;          // amplitude (degres pour les mouvements, 0..1 sinon)
    float spread = 360;       // decalage de phase reparti sur les lyres (degres)
    int wings = 1;            // nombre d'ailes (symetrie)
    float duty = 0.5f;        // pour les chenillards
    vec3 color_a = {1, 0, 0}, color_b = {0, 0, 1};
    float phase = 0;          // phase courante (cycles)
    std::vector<int> fixtures;
    std::string name;
};

struct Rig {
    std::vector<Fixture> fixtures;
    std::vector<Effect> effects;
    vec3 aim_points[4] = {{-20, 0, 0}, {0, 0, 0}, {20, 0, 0}, {-40, 1.6f, 0}};
    float master = 1.0f;
    float power = 1.0f;           // puissance des lyres (multiplicateur)
    float lens_diameter = 0.26f;  // diametre de la lentille (m) : le faisceau en sort sur toute sa largeur
    float pan_speed = 250;        // deg/s max
    float tilt_speed = 200;
    float accel = 900;            // deg/s^2
    bool instant_moves = false;
    double time = 0;

    void build(const Scene& scene);
    void update(float dt);

    // Programmeur : applique une valeur aux lyres selectionnees.
    template <typename F> void for_selected(F fn) {
        for (Fixture& f : fixtures) if (f.selected) fn(f.base);
    }
    int first_selected() const;
    int selected_count() const;
    void select_group(int group, bool additive);
    void select_all(bool v);
    void select_odd_even(bool odd);
    void invert_selection();
    void add_effect(int type);
    void home_selected();

    // Calcule pan/tilt pour viser un point depuis une lyre (au plus proche de la position actuelle).
    void aim_angles(const Fixture& f, vec3 target, float& pan, float& tilt) const;
};

// Direction du faisceau pour un couple pan/tilt dans le repere de la lyre.
vec3 fixture_dir(const Fixture& f, float pan_deg, float tilt_deg);
