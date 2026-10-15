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

static constexpr int NUM_AMBIANCES = 20;
static constexpr int AMBIANCE_COLS = 4;   // grille de 4 colonnes x 5 rangees
extern const AmbianceInfo AMBIANCES[NUM_AMBIANCES];

// Retient les reglages de depart (apres les options de la ligne de commande) : chaque ambiance repart d'eux.
void ambiance_capture_defaults();
void apply_ambiance(int index);
