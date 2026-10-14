// Texture du sol du hangar : beton Concrete031 d'ambientCG (CC0), chargee depuis assets/ avec stb_image.
// Tout tient dans UNE texture RGBA8 avec mipmaps (calculees ici), lue une seule fois par pixel :
//   R : racine de la luminance (la couleur = luminance x teinte moyenne : la teinte du beton varie de
//       moins de 3 %) ;
//   G, B : normale x, y (format DirectX), moyennee dans les mipmaps ;
//   A : rugosite, recentree sur celle du beton uni, elargie dans les mipmaps la ou les normales
//       divergent (Toksvig) : au loin, le relief ne scintille pas et le reflet garde sa largeur reelle.
// Une seule lecture compte : le filtrage anisotrope (sol vu en rasant) multiplie le cout de chaque lecture.
// La texture contient 4 x 4 dalles separees par des joints : le shader les melange au hasard
// (floor_material, meme calcul que albedo_at ici) pour qu'aucune repetition ne se voie.
#pragma once
#include "mathx.h"
#include <cstdint>
#include <string>
#include <vector>

struct FloorTexture {
    bool ok = false;
    int size = 0;       // cote de l'image pleine (puissance de 2)
    int num_mips = 0;
    std::vector<std::vector<uint8_t>> mips;   // mips[m] : niveau m, RGBA8
    vec3 tint = {1, 1, 1};     // couleur lineaire = R^2 * tint (avant mise a l'echelle de luminosite)
    float mean_lum = 0.2f;     // luminance lineaire moyenne
    std::string error;

    // Cherche assets/Concrete031 a cote de l'executable, puis dans le dossier courant.
    // base_rough : rugosite moyenne voulue (celle du beton uni du sol).
    bool load(const char* exe_path, float base_rough);

    // Couleur lineaire du sol autour du point (x, z), moyenne sur environ 1/8 de dalle (lumiere indirecte, CPU).
    // tile : taille de repetition de la texture (m). Meme melange des dalles que le shader.
    vec3 albedo_at(float x, float z, float tile) const;

    // Eau au sol. Creux du beton (trous, pores, joints), tires de la texture au chargement : R8 avec
    // mipmaps, 0 au fond d'un creux, 1 sur la surface (passe-haut de la luminance + divergence des normales).
    std::vector<std::vector<uint8_t>> cav_mips;
    // Niveaux d'eau pour la quantite d'eau w (0..1), pour le shader (floor_material) :
    //   out[0] : niveau des flaques (champ de cuvettes hF, voir puddle_height) ;
    //   out[1] : niveau de l'eau dans les creux (hauteur hP de cav_mips) ;
    //   out[2] : film d'eau sur tout le sol (0..1) ; out[3] : part du sol en flaques.
    // Les niveaux sont tires des repartitions de hP et hF : la part de sol couverte suit w (2 % de flaques
    // a 0,1, tout couvert a 1), quelle que soit la forme du bruit.
    void water_levels(float w, float out[4]) const;

  private:
    std::vector<float> coarse_lum;   // luminance lineaire du niveau 32 x 32
    float hp_q[257] = {};            // quantiles de hP (texture pleine)
    float hf_q[257] = {};            // quantiles de hF (cuvettes + creux)
    void build_water(const std::vector<float>& lum, const std::vector<float>& nr, int s);
};

// Bruit de valeur lisse (0..1), meme calcul que floor_noise() dans shaders/lyreviz.glsl.
float floor_noise(float x, float y);
// Champ des cuvettes ou l'eau s'accumule (metres), sans les creux : meme calcul que dans floor_material().
inline float puddle_height(float x, float z) {
    return 0.55f * floor_noise(x * 0.22f, z * 0.22f) + 0.30f * floor_noise(x * 0.7f + 17.0f, z * 0.7f + 17.0f) +
           0.15f * floor_noise(x * 2.1f + 33.0f, z * 2.1f + 33.0f);
}

// Melange des dalles : meme calcul que floor_hash() dans shaders/lyreviz.glsl.
inline uint32_t floor_hash(int cx, int cz) {
    uint32_t h = (uint32_t)cx * 0x8da6b343u ^ (uint32_t)cz * 0xd8163841u;
    h ^= h >> 13;
    h *= 0x5bd1e995u;
    h ^= h >> 15;
    return h;
}
