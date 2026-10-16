// Scenes du moteur de rendu : 40 programmations toutes faites (ambiances 21 a 60 de l'onglet Ambiances), chacune un
// univers different (lyres, lasers en formes ou en fichiers ILDA, fumee, sol mouille, aberration, blanc des lasers),
// pour montrer ce que sait faire le rendu. Les 20 premieres ambiances sont dans src/ambiances.cpp.
// Images d'inspiration : src/scenes/references/ (voir le README du dossier).
#pragma once
#include "../ambiances.h"

namespace scenes {

constexpr int NUM_SCENES = 40;
extern const AmbianceInfo INFO[NUM_SCENES];

// Programme la scene i (0..39). Appelee par apply_ambiance apres la remise a zero (tout eteint, fumee, sol, rendu et
// lasers aux reglages de depart) : chaque scene n'ecrit que ce qu'elle change.
void apply(int i);

// Moitie de la liste (scenes_a.cpp : 0..19, scenes_b.cpp : 20..39).
void apply_a(int i);
void apply_b(int i);

}  // namespace scenes
