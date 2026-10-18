// Generateur de spectacles (onglet Ambiances, categorie « Spectacles », sous les ambiances).
//
// 30 scenes nommees, un curseur d'energie (calme -> dynamique) et un theme de couleurs (tirage au hasard, ou palette
// choisie). Comme une ambiance, une scene change toutes les lumieres d'un coup : elle repart des reglages de depart
// (ambiance_reset), puis programme les lyres et les lasers comme on le ferait a la main (programmeurs et effets, dont
// ceux ajoutes pour les spectacles : ciseaux, miroir, convergence, scintillement, sauts, palette...). Tout reste
// modifiable ensuite dans les onglets Lyres, Effets et Lasers.
#pragma once
#include "mathx.h"
#include <cstdint>
#include <string>
#include <vector>

struct LaserRig;

constexpr int SPECTACLE_SCENES = 30;

struct SpectacleScene {
    const char* name;
    const char* description;
    vec3 tint;   // couleur du bouton (comme les ambiances)
};
extern const SpectacleScene SPECTACLE_SCENE_INFO[SPECTACLE_SCENES];

// Palette : n couleurs (0 : arc-en-ciel, toutes les teintes).
struct SpectaclePalette {
    const char* name;
    int n;
    vec3 c[4];
};
extern const SpectaclePalette SPECTACLE_PALETTES[];
extern const int SPECTACLE_PALETTE_COUNT;   // palettes de la liste ; l'indice SPECTACLE_PALETTE_COUNT : personnalisee

struct Spectacle {
    int scene = 0;               // scene choisie (0 .. SPECTACLE_SCENES - 1)
    bool running = false;        // une scene programme les lasers
    float energy = 0.5f;         // 0 : fixe, sans clignotement ; 1 : tres dynamique
    float tempo = 0;             // temps par minute ; 0 : selon l'energie (72 a 140)
    int color_mode = 0;          // 0 : couleurs tirees au hasard, 1 : palette choisie
    int palette = 0;             // palette choisie (SPECTACLE_PALETTE_COUNT : personnalisee)
    std::vector<vec3> custom = {{1, 0, 0.6f}, {0, 0.85f, 1}};   // palette personnalisee (1 a 6 couleurs)
    uint32_t color_seed = 1;     // tirage des couleurs (mode 0)
    uint32_t seed = 1;           // variantes des scenes (positions au hasard...)
    bool auto_next = false;      // enchainer les scenes (au hasard)
    float auto_bars = 8;         // duree d'une scene enchainee (mesures de 4 temps)
    // en cours
    std::vector<vec3> colors;    // couleurs de la scene (vide : arc-en-ciel)
    std::string colors_label;
    double beats = 0;            // horloge du spectacle (temps ecoules) : phase de tous les effets
    double next_change = 0;      // enchainement : temps de la prochaine scene
    uint32_t signature = 0;      // effets crees par la scene (si le programme a change, l'enchainement s'arrete)
    bool start_requested = false;   // --set spectacle=... : lancer au demarrage
};
extern Spectacle g_spectacle;

float spectacle_bpm();                            // tempo en cours (temps par minute)
void spectacle_apply(LaserRig& lr, bool restart);   // (re)programme la scene en cours ; restart : nouvelle scene
void spectacle_draw(uint32_t seed);               // tire scene, energie et couleurs (sans programmer)
void spectacle_stop(LaserRig& lr);                // noir : lasers eteints, effets supprimes
void spectacle_update(LaserRig& lr, float dt);    // horloge et enchainement, a chaque image
void spectacle_start(LaserRig& lr);               // au lancement (apres la construction des lasers) : --set spectacle=...
bool spectacle_set(const std::string& k, const char* value);   // cles --set sp... (voir README)
void spectacle_ui(LaserRig& lr);                  // categorie « Spectacles » de l'onglet Ambiances
