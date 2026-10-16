// Fichiers ILDA (ILDA Image Data Transfer Format) pour les lasers : lecture, bibliotheque, morceaux de chaque image.
//
// Un laser est un seul faisceau renvoye par deux miroirs ; chaque image ILDA (une suite de points) passe par le moteur
// de trace (src/trace.h, PLAN-LASERS.md etape 9) : miroirs, faisceaux (le point reste sur place), droites et arcs de
// cercle raccordes (le faisceau balaie). Le calcul se fait une fois par image du fichier, dans le repere du fichier
// (coordonnees de -1 a 1), et reste en cache : la taille, la rotation et la position de chaque laser ne changent pas
// les morceaux.
#pragma once
#include "trace.h"
#include <cstdint>
#include <string>
#include <vector>

// Une image : points (x, y de -1 a 1, y vers le haut), couleur du fichier (0..1, sRGB), point masque = noir.
struct IldaFrame {
    std::vector<float> x, y, r, g, b;
    int size() const { return (int)x.size(); }
    void push(float px, float py, float pr, float pg, float pb) {
        x.push_back(px); y.push_back(py); r.push_back(pr); g.push_back(pg); b.push_back(pb);
    }
};

// Morceaux d'une image (moteur de trace, src/trace.h) : faisceaux, droites et arcs, energie deja divisee par le
// nombre de points (chaque point compte 1 / N du temps), couleurs en lumiere lineaire.
struct IldaPrims {
    std::vector<TracePrim> prims;
    bool over = false;           // plus de ILDA_MAX_PRIMS a ce niveau : prendre le suivant
    int count() const { return (int)prims.size(); }
};

// Niveaux de tolerance du trace (chacun 2 fois plus large que le precedent) : un laser dont l'image a trop de
// morceaux (plus de ILDA_MAX_PRIMS) passe au niveau suivant.
constexpr int ILDA_LEVELS = 4;
constexpr int ILDA_MAX_PRIMS = 700;

struct IldaClip {
    std::string bank, name, path;   // path : UTF-8
    bool loaded = false, failed = false;
    std::vector<IldaFrame> frames;  // completees (points ajoutes le long des traits longs)
    int points_max = 0;
    // reduction par image et par niveau de tolerance (0 : la plus fine), calculee a la premiere utilisation
    std::vector<IldaPrims> prims[ILDA_LEVELS];
    std::vector<uint8_t> done[ILDA_LEVELS];
};

// Formats 0, 1 (couleur indexee, palette ILDA par defaut), 2 (palette), 4, 5 (couleur vraie). Faux si rien de lisible.
bool ilda_parse(const uint8_t* data, size_t size, std::vector<IldaFrame>& frames, std::string& name);

struct IldaLibrary {
    std::string root;                // dossier de la bibliotheque (UTF-8)
    std::vector<IldaClip> clips;     // tries par banque puis par nom
    std::vector<std::string> labels; // "Banque / nom" (interface)

    // Cherche server/storage/ilda en remontant depuis le dossier de l'executable (ou 'dir' s'il est donne), puis
    // ajoute les banques generees (add_generated).
    void scan(const std::string& exe_path, const std::string& dir = "");
    // Banques generees en memoire (bancs P1 a P3, essais) : « Crayon » (dessins a main levee, tremblement et vitesse
    // irreguliere), « Formes » (carre, etoile, coeur, cercle, triangle, spirale, lignes, points), « Sinus » (sinus
    // modules et Lissajous animes).
    void add_generated();
    // Fichier charge (nullptr si l'indice est mauvais ou le fichier illisible).
    IldaClip* get(int i);
    // Primitives de l'image 'frame' au niveau de tolerance 'level' (0..3) ; 'divergence' du faisceau en rad.
    const IldaPrims& prims(IldaClip& c, int frame, int level, float divergence);
    // Indices des fichiers d'une banque (bancs d'essai).
    std::vector<int> bank(const std::string& name) const;
};

// Image affichee a l'instant t : boucle (0), aller-retour (1), image fixe (2, image 'fixed').
int ilda_frame_index(int nframes, float fps, double t, int mode, int fixed);
