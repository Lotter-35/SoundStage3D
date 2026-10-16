// Fumee des lasers, v2 (« fumee spatiale », PLAN-FUMEE-LASERS-V2.md) : une fumee 3D statique dans l'espace, commune a
// tous les lasers. Le modele « Classique » (fumee de la piece + volutes periodiques) reste intact.
//
// Etape 1 : la carte de la piece (grande echelle). La grille des amas des lyres (64 x 24 x 32, cases de ~1,5 m), deja
// lue par le shader des lasers, recoit en modele v2 :
//   g : brume de fond x bancs de fumee x decroissance en hauteur + amas des machines (densite / room_max) ;
//   b : « structure » 0..1 : part chargee de la densite (bancs, amas) ; 0 dans la brume uniforme (nappe lisse).
// Les bancs : champ procedural 3D a grande echelle (table periodique 64^3 generee au lancement), qui derive avec le
// vent et evolue lentement (deux instants melanges) : zones denses, diluees et vides (le laser n'y passe pas).
#pragma once
#include <cstdint>
#include <string>
#include <vector>

struct FogSettings;

// Reglages (cles --set : laserfogmodel, puis prefixe sf)
struct SpatialFogSettings {
    int model = 0;              // 0 : Classique, 1 : Spatiale (v2)                                   laserfogmodel
    float haze = 1.0f;          // quantite de fumee repartie par les bancs (x celle du modele Classique) sfhaze
    float sim = 0.25f;          // amas simules (machines a fumee) en plus (x amas de la scene)         sfsim
    float height = 0.03f;       // decroissance de la brume en hauteur (par m)                         sfheight
    float bank_cover = 0.45f;   // bancs : part de l'espace couverte (0 : aucun banc)                  sfcover
    float bank_size = 8.0f;     // bancs : taille (m)                                                  sfbanksize
    float bank_core = 0.5f;     // bancs : coeurs plus denses (relief interne)                         sfbankcore
    float bank_edge = 2.5f;     // bancs : nettete des bords (1 doux, 8 nets)                          sfbankedge
    float voids = 0.7f;         // zones vides : part de la fumee retiree hors des bancs (1 : rien)    sfvoid
    float bank_period = 60.0f;  // bancs : duree d'une evolution (s)                                   sfbankevol
    float bank_rag = 0.7f;      // bancs : bords nuageux (leur contour deforme par les nuages, ecarts types) sfbankrag
    // nuages (moyenne echelle) : une texture 3D ronge la fumee de la carte, selon sa structure (canal b)
    float cloud_erode = 1.0f;   // force de l'erosion (0 : nappe lisse, carte seule)                  sferode
    float cloud_size = 11.0f;   // taille du motif (m)                                                sfcloudsize
    float cloud_cover = 0.55f;  // part des nuages au coeur des bancs (le reste : trous)               sfcloudcover
    float cloud_rag = 0.8f;     // bords des bancs ronges (seuil en plus, ecarts types)               sfcloudrag
    float cloud_soft = 0.25f;   // douceur du bord des nuages (ecarts types ; petit : net)            sfcloudsoft
    float cloud_core = 0.7f;    // relief interne : coeurs plus denses que les bords (0 : nuages plats) sfcloudcore
    float cloud_period = 20.0f; // duree d'une evolution des nuages (s)                               sfcloudevol
    float cloud_lod = 5.0f;     // niveau de detail ou l'erosion s'efface (au loin)                   sfcloudlod
    // mouvement de fluide (sans simulation) : tourbillons analytiques bornes qui deforment les nuages et les filaments ;
    // les petits (filaments) sont 3,3 fois plus petits, 2,5 fois plus rapides, 3 fois plus faibles
    float swirl_amp = 0.4f;     // amplitude des tourbillons (m ; 0 : aucun)                          sfswirl
    float swirl_size = 4.0f;    // taille des tourbillons (m, longueur d'onde)                        sfswirlsize
    float swirl_speed = 0.35f;  // vitesse (rad/s ; un tour en 2 pi / vitesse)                        sfswirlspeed
    // filaments de pres (la texture des volutes, petite) : detail marbre, seulement pres de la camera
    float fil_strength = 0.6f;  // force (ecarts types de la modulation ; 0 : aucun)                  sffil
    float fil_size = 0.5f;      // taille du motif (m)                                                sffilsize
    float fil_lod = -1.0f;      // lus tant qu'un pixel couvre moins de 2^x texels (-1 : < 4 mm)      sffillod
    float fil_period = 8.0f;    // duree d'une evolution (s)                                          sffilevol
    int preset = 0;             // dernier prereglage choisi (interface ; sfpreset=n le choisit et remplit tout le reste)
};

// Prereglages (PLAN-FUMEE-LASERS-V2.md, section 4) : 0 par defaut, 1 hazer propre, 2 hazer + panache local, 3 concert
// (machines a fumee), 4 nuages larges et doux, 5 marbre de pres. Choisir un prereglage passe en modele v2.
constexpr int SPATIAL_FOG_PRESETS = 6;
extern const char* const SPATIAL_FOG_PRESET_NAMES[SPATIAL_FOG_PRESETS];
SpatialFogSettings spatial_fog_preset(int n);

// Nuages : texture 3D periodique 64^3 (bruit de Perlin-Worley, formes de cumulus), 2 instants d'une boucle d'evolution
// (canaux r, g, BC5), valeurs en loi normale : 0,5 + z x CLOUD_SD. Generee au 1er usage du modele v2.
constexpr int CLOUD_N = 64;
constexpr float CLOUD_SD = 0.15f;
struct SpatialFogClouds {
    std::vector<std::vector<uint8_t>> mips;   // BC5, 64^3 ... 1^3
    std::vector<float> level_sd;              // ecart type de chaque niveau (en z)
    float shrink = 0;                         // ecart type du niveau l ~ 1 - shrink x l^2 (ajuste sur level_sd)
    double build_ms = 0;
    void build();
};
// Uniformes de la passe des lasers pour les nuages (lvol, lvolw, lvol2, lvol3, lvol4 : voir laser_fetch, LASER_FOG 4)
void spatial_fog_cloud_params(const SpatialFogSettings& s, const SpatialFogClouds& c, float time, float wind_x, float wind_y,
                              float wind_z, float out[5][4]);
// Uniformes des tourbillons et des filaments (lswirl, lswirl2, lfil, lfil2, lfil3 : LASER_FOG 4 et 5) ; vol_sd : ecart
// type de la texture des volutes (VOLUTES_SD), vol_n : sa taille (VOLUTES_N)
void spatial_fog_motion_params(const SpatialFogSettings& s, float time, float wind_x, float wind_y, float wind_z, float vol_sd,
                               int vol_n, float out[5][4]);

// Bancs de fumee : table periodique N^3 de valeurs de loi normale (moyenne 0, ecart type 1 : le melange de deux
// instants, ramene au meme ecart type, garde exactement la meme loi, donc la meme couverture a tout instant).
struct SpatialFogBanks {
    static constexpr int N = 64;
    std::vector<float> table;
    std::vector<float> z;   // champ des bancs dans chaque case de la grille des amas (loi normale)
    double build_ms = 0;    // generation au lancement
    double field_ms = 0;    // dernier calcul du champ (CPU)
    void build();
    // champ des bancs dans la grille (nx, ny, nz) de la boite (origin, size) au temps t, vent (m/s, x et z)
    void field(int nx, int ny, int nz, const float origin[3], const float size[3], float t, float wind_x, float wind_z,
               const SpatialFogSettings& s);
};

// Profil des bancs : densite relative M (moyenne 1 sur la loi normale : la quantite de fumee ne depend que de la
// brume de fond) et part des bancs B (0..1), selon la valeur z du champ.
struct SpatialFogProfile {
    float thr = 1e9f, edge = 1, core = 0, keep = 1, inv_mean = 1;
    void setup(const SpatialFogSettings& s);
    void eval(float z, float& M, float& B) const {
        float t = (z - thr) * edge;
        t = t < 0 ? 0 : (t > 1 ? 1 : t);
        B = t * t * (3 - 2 * t);
        float c = z - thr - 1.0f / edge;
        c = c < 0 ? 0 : (c > 3 ? 3 : c);
        M = (keep * (1 - B) + (1 + core * c) * B) * inv_mean;
    }
};

// Cle --set (laserfogmodel, sf...) : vrai si reconnue
bool spatial_fog_set(SpatialFogSettings& s, const std::string& k, float v);
// Interface (onglet Lasers, « Dans la fumee ») : choix du modele, puis les reglages du modele v2
void spatial_fog_ui_model(SpatialFogSettings& s);
void spatial_fog_ui_settings(SpatialFogSettings& s, const SpatialFogBanks& banks);
