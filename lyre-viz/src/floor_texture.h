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

  private:
    std::vector<float> coarse_lum;   // luminance lineaire du niveau 32 x 32
};

// Melange des dalles : meme calcul que floor_hash() dans shaders/lyreviz.glsl.
inline uint32_t floor_hash(int cx, int cz) {
    uint32_t h = (uint32_t)cx * 0x8da6b343u ^ (uint32_t)cz * 0xd8163841u;
    h ^= h >> 13;
    h *= 0x5bd1e995u;
    h ^= h >> 15;
    return h;
}
