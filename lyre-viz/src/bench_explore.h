// Banc d'exploration des lasers (--bench-explore) : d'ou vient le lag des lasers ?
//
// Deux familles de cas, lyres eteintes :
//  - balayage : un cas de base (50 lasers, eventails de 1 000 traits, 40 deg, vue du public), puis chaque reglage
//    change seul, niveau par niveau (nombre de lasers, emplacement, forme, traits, ouverture, diffraction, degrade,
//    visee, mouvement, fichiers ILDA, vue, fumee, options du rendu, eau au sol, resolution). La base revient
//    plusieurs fois pour suivre la derive de la carte.
//  - hasard : des programmations tirees au hasard (graine --seed), tous les reglages a la fois, pour les cas croises.
// Resultats : exploration.csv (un cas par ligne : reglages, temps de chaque passe, compteurs), en plus du format
// habituel (resultats.txt). Analyse : tools/explore_report.py.
#pragma once
#include <string>
#include <vector>

namespace explore {

// Emplacements des lasers allumes
enum Place { PL_SPREAD = 0, PL_TRUSSES, PL_STAGE, PL_FAR, PL_NEAR, PL_COUNT };
extern const char* PLACE_NAMES[PL_COUNT];
// Mouvement des figures
enum Motion { MO_STILL = 0, MO_PAN_WAVE, MO_CIRCLE, MO_RANDOM, MO_ROLL, MO_COUNT };
extern const char* MOTION_NAMES[MO_COUNT];

struct Config {
    std::string family;   // "base", "balayage", "hasard"
    std::string factor;   // reglage change (balayage), sinon vide
    std::string level;    // sa valeur
    int count = 50;       // lasers allumes (au plus le nombre d'emplacements choisis)
    int place = PL_SPREAD;
    int shape = 0;        // LaserShape ; -1 : fichiers ILDA de la banque 'bank' ; -2 : melange (une figure au hasard par laser)
    std::string bank;
    int traits = 1000;    // 0 : nappe continue (mode ligne)
    float opening = 40;   // deg
    int diffraction = 1;
    int gradient = 0;     // LaserGradient
    float tilt = 0;       // deg, ajoute a la visee de chaque laser (+ : vers l'horizontale, donc vers le public)
    float pan_spread = 0; // deg : lasers ecartes en pan de -x a +x
    int motion = MO_PAN_WAVE;
    int view = 0;         // vue du banc (bench::VIEWS)
    float fog = 1;        // multiplicateur de la densite de la fumee
    unsigned seed = 0;    // tirages par laser (roulis, melange)
    std::vector<std::string> sets;   // reglages --set de ce cas (volutes=0, wet=0.3, fsr=1...)
};

// Cas du banc : 'random' programmations au hasard (graine 'seed'), apres le balayage si 'sweep'.
std::vector<Config> build(bool sweep, int random, unsigned seed);
// Programme les lasers du cas (programmeur, LP_PROGRAM ; lyres non touchees).
void program(const Config& c);
// Libelle court du cas (resultats.txt) ; colonnes de exploration.csv.
std::string name(const Config& c);
std::string csv_header();
std::string csv_row(const Config& c, const char* view_name);

}  // namespace explore
