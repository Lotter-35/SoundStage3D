// Roue de gobos generee par programme (texture tableau 2D, niveau de gris, avec mipmaps).
// Les mipmaps servent au flou : frost et mise au point lisent un niveau plus flou.
#pragma once
#include <cstdint>
#include <vector>

struct GoboAtlas {
    static constexpr int SIZE = 256;
    int num_layers = 0;
    int num_mips = 0;
    std::vector<std::vector<uint8_t>> mips;  // mips[m] = toutes les couches du niveau m, a la suite
    std::vector<float> transmission;          // part de lumiere qui passe a travers chaque gobo (0..1)

    void generate();
};
