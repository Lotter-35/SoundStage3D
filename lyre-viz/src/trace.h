// Moteur de trace (PLAN-LASERS.md, etape 9) : un laser projette un trace de scanner (suite de points de duree egale,
// comme un fichier ILDA), quelle que soit sa source : fichier, dessin a main levee, forme du programmeur. Le trace
// passe par les miroirs (inertie), puis se decoupe en morceaux que le rendu sait calculer exactement :
//   - faisceau : le point reste sur place (toute son energie dans un trait seul) ;
//   - droite : nappe plane (segment d'eventail) ;
//   - arc de cercle : nappe conique exacte (laser_arc).
// Les arcs et les droites se raccordent sans cassure (meme tangente) sauf aux vrais coins : aucune courbe n'est faite
// de traits droits. La lumiere varie lineairement le long de chaque morceau (temps passe par unite de longueur : un
// passage lent est plus lumineux).
//
// Repere : le champ du scanner, x a droite, y en haut, de -1 a 1 (coordonnees d'un fichier ILDA). Le rendu le pose
// sur le plan de projection du laser (a distance 1 de la sortie) a l'echelle tan(demi-ouverture) : une droite y reste
// une droite, un cercle un cercle (comme un projecteur corrige, une figure dessinee apparait telle quelle sur un mur).
#pragma once
#include "mathx.h"
#include <vector>

enum TracePrimKind { TP_LINE = 0, TP_ARC = 1, TP_BEAM = 2 };

// Un morceau. Droite : p0 -> p1. Arc : centre c, rayon rho, de l'angle a0 (au point p0) sur un balayage da signe
// (sens trigonometrique si > 0) jusqu'a p1. Faisceau : en p0. Energie f0, f1 (part du temps de l'image x couleur
// lineaire) : celle du morceau s'il etait uniforme de la lumiere de son bout p0 (f0) ou p1 (f1) ; egales pour un
// faisceau.
struct TracePrim {
    int kind = TP_LINE;
    vec2 p0{0, 0}, p1{0, 0}, c{0, 0};
    float rho = 0, a0 = 0, da = 0;
    vec3 f0, f1;
};

struct TraceParams {
    float pps = 30000.0f;   // points par seconde du scanner
    float scan_us = 60.0f;  // inertie des miroirs : constante de temps (us) d'un suivi du 2e ordre amorti ; 0 : aucune
    float dwell = 1e-3f;    // deplacement d'un point au suivant en dessous duquel le faisceau reste sur place
    float tol = 4e-4f;      // ecart maximal du trace aux arcs et aux droites
};

// Trace d'une image (fermee : le dernier point precede le premier) : points de duree egale, couleur lineaire (0 :
// eteint) -> morceaux. Faux si plus de 'limit' morceaux (passe interrompue, 'out' incomplet).
bool trace_fit(const std::vector<float>& x, const std::vector<float>& y, const std::vector<vec3>& col,
               const TraceParams& p, int limit, std::vector<TracePrim>& out);

// Courbe deja connue (forme du programmeur : ni miroirs, ni faisceaux, ni lumiere a suivre) : ligne brisee dense
// P[0..n-1] (fermee si le dernier point est le premier) -> arcs et droites a tol pres (f0, f1 nuls).
void trace_fit_curve(const std::vector<vec2>& P, float tol, std::vector<TracePrim>& out);
