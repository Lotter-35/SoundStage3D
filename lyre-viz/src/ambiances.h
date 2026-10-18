// Ambiances : programmations toutes faites des lyres, des lasers, de la fumee et du sol (onglet Ambiances).
// Chaque ambiance repart des reglages de depart (fumee, sol, aberration, points de visee) et ne deplace pas
// les tetes d'un coup : les lyres vont a leur nouvelle position a leur vitesse.
#pragma once
#include "mathx.h"

struct AmbianceInfo {
    const char* name;   // court : tient sur un bouton de la grille
    const char* desc;
    vec3 tint;          // couleur du bouton
};

// 20 ambiances (ambiances.cpp), puis les 40 scenes du moteur de rendu (src/scenes : ambiances 21 a 60)
static constexpr int NUM_BASE_AMBIANCES = 20;
static constexpr int NUM_AMBIANCES = NUM_BASE_AMBIANCES + 40;
static constexpr int AMBIANCE_COLS = 4;   // grille de 4 colonnes
extern const AmbianceInfo AMBIANCES[NUM_BASE_AMBIANCES];
// Nom, description et couleur de l'ambiance i (0..NUM_AMBIANCES - 1), scenes comprises.
const AmbianceInfo& ambiance_info(int i);

// Retient les reglages de depart (apres les options de la ligne de commande) : chaque ambiance repart d'eux.
void ambiance_capture_defaults();
void apply_ambiance(int index);
// Tout eteint, effets supprimes, fumee / sol / aberration / visee aux reglages de depart (debut de chaque ambiance ;
// les spectacles, src/spectacles.cpp, repartent aussi de la).
void ambiance_reset();
