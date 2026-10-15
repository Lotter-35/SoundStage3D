// Fichiers ILDA (ILDA Image Data Transfer Format) pour les lasers : lecture, bibliotheque, reduction en primitives.
//
// Meme principe que le laser 2 du simulateur web (src/laser2/, docs/laser2-cahier-des-charges.md) : un laser est
// un seul faisceau renvoye par deux miroirs ; chaque image ILDA (une suite de points) se reduit a deux primitives :
//   - le faisceau (le point reste sur place : toute l'energie de ses points dans un trait seul) ;
//   - la nappe (le faisceau balaie d'un point a l'autre : l'energie des points repartie sur l'angle balaye).
// Dans LyreViz, une nappe est un segment d'eventail en nappe lisse, un faisceau un trait seul (shader : laser_eval,
// laser_trait). La reduction se fait une fois par image du fichier, dans le repere du fichier (coordonnees de -1 a
// 1), et reste en cache : la taille, la rotation et la position de chaque laser ne changent pas les primitives.
#pragma once
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

// Primitives d'une image, energie deja divisee par le nombre de points (chaque point compte 1 / N du temps).
// Couleurs en lumiere lineaire ; l = somme du canal le plus fort (mode « couleur du laser »).
struct IldaPrims {
    std::vector<float> beams;    // x, y, r, g, b, l
    std::vector<float> sheets;   // x0, y0, x1, y1, r, g, b, l
    bool over = false;           // plus de ILDA_MAX_PRIMS a ce niveau : prendre le suivant
    int count() const { return (int)(beams.size() / 6 + sheets.size() / 8); }
};

// Niveaux de tolerance de la reduction (chacun 2 fois plus large que le precedent) : un laser dont l'image a trop
// de primitives (plus de ILDA_MAX_PRIMS) passe au niveau suivant, comme sur le web.
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

    // Cherche server/storage/ilda en remontant depuis le dossier de l'executable (ou 'dir' s'il est donne).
    void scan(const std::string& exe_path, const std::string& dir = "");
    // Fichier charge (nullptr si l'indice est mauvais ou le fichier illisible).
    IldaClip* get(int i);
    // Primitives de l'image 'frame' au niveau de tolerance 'level' (0..3) ; 'divergence' du faisceau en rad.
    const IldaPrims& prims(IldaClip& c, int frame, int level, float divergence);
    // Indices des fichiers d'une banque (bancs d'essai).
    std::vector<int> bank(const std::string& name) const;
};

// Image affichee a l'instant t : boucle (0), aller-retour (1), image fixe (2, image 'fixed').
int ilda_frame_index(int nframes, float fps, double t, int mode, int fixed);
