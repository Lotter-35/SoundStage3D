// Lasers (PLAN-LASERS.md) : boitiers, programmeur, formes et effets, decoupes en segments d'eventail pour le
// rendu (voir le shader, laser_eval).
//
// Un boitier est fixe : son axe d'accroche est regle une fois (groupe). La figure se place dans le champ du
// scanner (pan, tilt, roll), dans la limite de son angle maximal, comme sur un vrai laser.
#pragma once
#include "fixtures.h"
#include "ilda.h"
#include "mathx.h"
#include "scene.h"
#include <string>
#include <vector>

// Un segment d'eventail : n traits dans un plan, repartis entre deux directions de bord. La couleur varie
// lineairement d'un bord a l'autre (flux au bord 0, flux1 au bord 1) : degrades et profils le long d'une figure.
// Nombre de traits d'une nappe continue (balayage sans coupure : mode ligne, nappes ILDA). Le rendu la calcule en
// nappe lisse ; aucune ondulation de traits n'y est visible.
constexpr int LASER_SHEET_TRAITS = 1 << 20;
// Segments au plus par image (comme Renderer::MAX_LASER_SEGS).
constexpr int LASER_MAX_SEGS = 16384;

struct LaserSegment {
    vec3 src;           // source
    float range;        // portee (m)
    vec3 ec;            // direction du milieu de l'eventail
    float half_angle;   // demi-ouverture (rad)
    vec3 es;            // direction dans le plan, perpendiculaire a ec
    float traits;       // nombre de traits (1 = un trait seul)
    vec3 flux;          // puissance de tout le segment (couleur x W), au bord 0
    float pad;
    vec3 flux1;         // idem au bord 1
    float pad1;
};

// Emplacement d'un boitier : 168 sur les trusses (entre les lyres), 16 sur le pont de scene, 8 au sol de
// la scene, 8 en nez de scene.
struct LaserMount {
    vec3 pos;
    vec3 n;     // de la base vers la sortie (bas si suspendu)
    int group;  // memes groupes que les lyres
};

// Motifs du banc d'essai (cas L1 a L6 et M1), ou le programmeur (LP_PROGRAM, mode normal).
enum LaserPattern {
    LP_OFF = 0,
    LP_FANS,       // L1 : eventails de 1 000 traits, balayage + rotation
    LP_CONES,      // L2 : cones de traits (32 segments par laser)
    LP_CURTAINS,   // L3 : rideaux verticaux tout autour de la camera
    LP_BEAMS,      // L4 : 8 traits separes par laser, en mouvement
    LP_CLOSEUP,    // L5 : nappes fixes vues en gros plan (fumee epaisse)
    LP_FLOOR,      // L6 : traits vers le sol, les obstacles et les mannequins
    LP_PROGRAM,    // programmeur : reglages, formes et effets de chaque boitier
    LP_FANS_LINE,  // L1 en mode ligne : les memes eventails en nappes continues (au lieu de 1 000 traits)
    LP_COUNT
};
extern const char* LASER_PATTERN_NAMES[LP_COUNT];

enum LaserShape { LS_FAN = 0, LS_DOUBLE_FAN, LS_CONE, LS_TUNNEL, LS_WAVE, LS_GRID, LS_COUNT };
extern const char* LASER_SHAPE_NAMES[LS_COUNT];

// Couleur le long de la figure (du bord 0 au bord 1, ou autour du cercle).
enum LaserGradient { LG_NONE = 0, LG_TWO, LG_THREE, LG_SCROLL, LG_RAINBOW, LG_RANDOM, LG_COUNT };
extern const char* LASER_GRADIENT_NAMES[LG_COUNT];

// Effets des lasers (meme moteur que les lyres : forme d'onde, vitesse, amplitude, decalage, ailes).
enum LaserEffectType {
    LFX_PAN_WAVE = 0,
    LFX_TILT_WAVE,
    LFX_CIRCLE,
    LFX_FIGURE8,
    LFX_RANDOM,       // balayage aleatoire : pan et tilt errent sans se repeter, chaque boitier a sa trajectoire
    LFX_SPREAD,       // eventail des figures : pan reparti sur la selection
    LFX_ROLL,         // rotation de la figure autour de son axe (aller-retour)
    LFX_OPENING,      // pulsation de l'ouverture
    LFX_TRAIT_CHASE,  // chenillard de traits : une vague de traits allumes parcourt la figure
    LFX_DIMMER_CHASE, // chenillard d'intensite d'un boitier a l'autre
    LFX_RAINBOW,      // arc-en-ciel d'un boitier a l'autre
    LFX_COLOR_ALT,    // alternance de deux couleurs
    LFX_COUNT
};
extern const char* LASER_EFFECT_NAMES[LFX_COUNT];

// Valeurs du programmeur d'un boitier (ce que regle l'utilisateur).
struct LaserParams {
    float dimmer = 1;          // 0..1
    float strobe = 0;          // Hz, 0 = ouvert
    vec3 color = {0, 1, 0};    // couleur (0..1 par canal)
    vec3 color2 = {0, 0.3f, 1};
    vec3 color3 = {1, 0, 0.6f};
    int gradient = LG_NONE;
    float gradient_speed = 0.25f;   // defilement le long de la figure (cycles/s) : defilant, arc-en-ciel
    int shape = LS_FAN;
    float opening = 60;        // deg : 0 = un point (tous les traits confondus) .. angle maximal du boitier
    int traits = 1000;         // nombre de traits de la figure (1 = un trait seul, 0 = nappe continue : mode ligne)
    float pan = 0, tilt = 0;   // deg : position de la figure dans le champ du scanner
    float roll = 0;            // deg : rotation de la figure autour de son axe
    float roll_speed = 0;      // deg/s : rotation continue
    int diffraction = 1;       // reseau de diffraction : 1, 3, 5 ou 9 copies de la figure
    float diffraction_angle = 8;   // deg entre deux copies
    float shape_param = 10;    // double eventail : ecart (deg) ; vague : amplitude (deg) ; grille : rangees
    float wave_cycles = 3;     // vague : ondulations le long de l'eventail
    // source : la figure du programmeur (0) ou un fichier ILDA (1, bibliotheque server/storage/ilda)
    int source = 0;
    int ilda_clip = -1;        // indice dans LaserRig::ilda
    float ilda_fps = 30;       // images du fichier par seconde
    int ilda_play = 0;         // boucle (0), aller-retour (1), image fixe (2)
    int ilda_frame = 0;        // image fixe
    bool ilda_colors = true;   // couleurs du fichier (sinon : sa luminosite, teintee par la couleur du laser)
    // calcules par les effets (pas regles directement)
    float chase_pos = -1;      // chenillard de traits : position de la vague (0..1), < 0 : aucun
    float chase_width = 0.2f;
};

struct LaserFixture {
    LaserMount mount;
    vec3 aim, right, up;       // axe du boitier et repere du champ du scanner
    LaserParams base, out;     // programmeur, puis apres effets
    float pan = 0, tilt = 0, roll = 0, opening = 60;   // positions des galvos (avec inertie)
    float roll_acc = 0;        // rotation continue cumulee (deg)
    float scroll = 0;          // defilement du degrade (cycles)
    bool selected = false;
};

struct LaserRig {
    std::vector<LaserMount> mounts;
    std::vector<LaserFixture> fixtures;
    std::vector<Effect> effects;     // type : LaserEffectType
    std::vector<LaserSegment> segs;
    std::vector<std::string> group_names;
    int pattern = LP_PROGRAM;
    int count = 200;            // motifs du banc : boitiers allumes (repartis sur tous les emplacements)
    float power_w = 2.0f;       // puissance d'un boitier (W)
    float master = 1.0f;
    float max_angle = 60.0f;    // angle maximal du scanner (deg)
    float galvo_ms = 8.0f;      // inertie des galvos (constante de temps, ms)
    float aperture_mm = 5.0f;   // diametre de sortie (1/e2)
    float divergence_mrad = 1.0f;   // divergence (angle total)
    bool show_housings = true;
    int total_traits = 0;       // traits de toutes les figures (compteur ; une nappe continue n'en compte aucun)
    // fichiers ILDA (src/ilda.h) : bibliotheque, niveau de tolerance global (monte quand les segments depassent le
    // budget, comme le budget adaptatif du web), compteurs
    IldaLibrary ilda;
    int ilda_bias = 0;
    int ilda_points = 0, ilda_beams = 0, ilda_sheets = 0;
    int lit = 0;                // boitiers allumes (compteur)
    double time = 0;

    void build(const Scene& scene);
    // Figures a l'instant 'time' : motif du banc, ou programmeur et effets (dt : pas de temps).
    void update(float time, float dt, vec3 hall_min, vec3 hall_max);
    // Corps des boitiers (paves sombres) et sorties, pour le rendu de la scene.
    void housings(std::vector<Instance>& cubes) const;

    // Programmeur (comme les lyres)
    template <typename F> void for_selected(F fn) {
        for (LaserFixture& f : fixtures) if (f.selected) fn(f.base);
    }
    int first_selected() const;
    int selected_count() const;
    void select_group(int group, bool additive);
    void select_all(bool v);
    void select_odd_even(bool odd);
    void invert_selection();
    void add_effect(int type);
    // Programmation de demonstration (vues --demo-laser, cas L7 du banc).
    void program_default();
    void program_showcase();
    // Tous les boitiers jouent les fichiers ILDA d'une banque (un fichier par boitier, en boucle) : bancs, vues.
    void program_ilda(const std::string& bank);
};
