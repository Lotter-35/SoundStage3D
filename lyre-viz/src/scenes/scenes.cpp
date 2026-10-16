// Liste des 40 scenes (ambiances 21 a 60) ; leurs programmations : scenes_a.cpp et scenes_b.cpp.
#include "scenes.h"

namespace scenes {

const AmbianceInfo INFO[NUM_SCENES] = {
    // --- scenes_a.cpp ---
    {"Ciel liquide", "Nappes continues rouges et blanches au ras des tetes, fumee epaisse et volutes fortes : un ciel "
                     "qui ondule (reference 05).", {1.0f, 0.3f, 0.35f}},
    {"Pyramide laser", "Nappes arc-en-ciel du sol et du nez de scene qui se croisent en pyramide au-dessus du public "
                       "(reference 01).", {0.7f, 0.4f, 1.0f}},
    {"Couronne blanche", "Faisceaux blancs serres du pont et des trusses, tous vers le chanteur : une couronne de lumiere "
                         "dans une fumee dense (reference 03).", {1.0f, 1.0f, 1.0f}},
    {"Traits croises", "Traits laser roses et cyan qui se croisent au hasard, colonnes rouges du pont (reference 02).",
     {1.0f, 0.3f, 0.8f}},
    {"Vert pur", "Show laser tout vert : eventails de traits, nappes, et contre-jour blanc aveuglant du pont "
                 "(reference 06).", {0.1f, 1.0f, 0.2f}},
    {"Nappes bleues", "Nappes bleues presque horizontales et traits blancs tres intenses qui virent au blanc "
                      "(reference 07).", {0.2f, 0.3f, 1.0f}},
    {"Volutes", "Eventails a larges bandes de couleur dans une fumee tres epaisse et turbulente : les volutes "
                "dessinent la fumee (reference 04).", {0.8f, 0.2f, 1.0f}},
    {"Aurore boreale", "Vagues laser vertes et turquoise qui ondulent lentement, sol legerement mouille.",
     {0.0f, 1.0f, 0.6f}},
    {"Neon Tokyo", "Sol inonde, magenta et cyan, prismes lineaires, grilles laser, aberration chromatique.",
     {1.0f, 0.1f, 0.9f}},
    {"Desert", "Brume dense et basse, vent, lumieres ambre tres larges comme un soleil couchant. Aucun laser.",
     {1.0f, 0.65f, 0.25f}},
    {"Abysses", "Bleu profond, gobos breakup qui ondulent, rayons laser cyan verticaux comme la lumiere sous l'eau.",
     {0.0f, 0.2f, 0.8f}},
    {"Orage", "Eclairs stroboscopiques du pont, faisceaux bleus, traits laser blancs qui fouettent l'air.",
     {0.6f, 0.7f, 1.0f}},
    {"Feu d'artifice", "Fichiers ILDA : feux d'artifice et explosions de faisceaux, lyres scintillantes.",
     {1.0f, 0.8f, 0.2f}},
    {"Textes ILDA", "Fichiers ILDA de la banque Texte sur le pont, faisceaux verts qui balaient.", {0.3f, 1.0f, 0.4f}},
    {"Geometrie ILDA", "Fichiers ILDA de la banque Geometrie (cube, atome, mandala...) depuis les trusses.",
     {0.4f, 0.8f, 1.0f}},
    {"Tunnels ILDA", "Les 16 lasers du pont jouent les tunnels ILDA vers le public, fumee dense.", {0.3f, 1.0f, 0.9f}},
    {"Dessins", "Dessins a main levee (banque Crayon) en courbes exactes, lumiere douce.", {0.9f, 0.9f, 0.6f}},
    {"Lissajous", "Sinus modules et Lissajous animes depuis les trusses, lyres violettes.", {0.6f, 0.3f, 1.0f}},
    {"Formes", "Carres, triangles, etoiles, coeurs et cercles arc-en-ciel qui tournent.", {1.0f, 0.5f, 0.0f}},
    {"Coeurs", "Coeurs laser roses qui battent, gobos fleur roses au sol.", {1.0f, 0.3f, 0.5f}},
    // --- scenes_b.cpp ---
    {"Etoiles filantes", "Petites etoiles laser qui filent dans tout le hangar, gobo galaxie au sol.",
     {1.0f, 0.9f, 0.4f}},
    {"Nef de lasers", "Grandes nappes verticales blanches et bleues du sol et du nez de scene, colonnes de lumiere.",
     {0.7f, 0.85f, 1.0f}},
    {"Rave rouge", "Tout rouge, chenillards rapides, stroboscope, traits laser qui battent.", {1.0f, 0.0f, 0.1f}},
    {"Cercles au sol", "Cones laser arc-en-ciel vers le bas : cercles qui tournent sur le sol mouille.",
     {0.5f, 1.0f, 0.5f}},
    {"Disco", "Prismes 8 et gobos points blancs qui tournent, grilles laser en diffraction.", {1.0f, 0.95f, 0.8f}},
    {"Spirale", "Gobos spirale magenta et cyan en rotation, tunnels laser qui tournent.", {0.9f, 0.2f, 1.0f}},
    {"Matrice", "Pluie verte : grilles laser en diffraction x9, gobos barres verts.", {0.0f, 0.9f, 0.3f}},
    {"Jungle", "Feuillages verts et jaunes au sol, fumee qui monte, rayons de soleil ambre.", {0.5f, 0.9f, 0.1f}},
    {"Lagune", "Sol inonde, reflets cyan, nappe laser turquoise au ras des tetes.", {0.0f, 0.9f, 0.9f}},
    {"Glace", "Blanc glace, prismes en grille, flocons laser, aberration chromatique.", {0.75f, 0.9f, 1.0f}},
    {"Volcan", "Fumee qui monte, nappes rouges et oranges qui jaillissent du sol, reflets rouges.",
     {1.0f, 0.25f, 0.0f}},
    {"Hypnose", "Doubles eventails et tunnels blancs qui tournent en sens contraires.", {0.85f, 0.85f, 0.85f}},
    {"Minimal", "Presque rien : quelques faisceaux blancs tres fins et un seul trait vert, air clair.",
     {0.5f, 0.5f, 0.5f}},
    {"Brume doree", "Brume epaisse et doree, faisceaux larges et doux, nappes ambre tres douces.", {1.0f, 0.75f, 0.3f}},
    {"Scanner", "Un faisceau par laser qui balaie vite, couleurs arc-en-ciel : la vitesse des galvos.",
     {0.4f, 1.0f, 1.0f}},
    {"Pluie de points", "Traits laser vers le sol : points qui dansent sur le sol mouille, air clair.",
     {0.3f, 0.7f, 1.0f}},
    {"Contre-jour", "Le pont eblouit le public de face dans une fumee epaisse : silhouettes.", {0.95f, 0.95f, 0.9f}},
    {"Kaleidoscope", "Prismes, cercles de points arc-en-ciel, etoiles laser en diffraction, franges colorees.",
     {1.0f, 0.4f, 0.7f}},
    {"Synthwave", "Grille laser magenta et orange au sol mouille, soleil orange au fond, violet partout.",
     {1.0f, 0.3f, 0.6f}},
    {"Final ILDA", "Tous les fichiers ILDA a la fois (tunnels, geometrie, animations, faisceaux, nappes) et lyres "
                   "arc-en-ciel.", {1.0f, 1.0f, 0.5f}},
};

void apply(int i) {
    if (i < 0 || i >= NUM_SCENES) return;
    if (i < 20) apply_a(i);
    else apply_b(i);
}

}  // namespace scenes
