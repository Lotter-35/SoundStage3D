// Volutes fines de la fumee, pour les lasers (PLAN-LASERS.md, section 4.1) : texture 3D periodique 128^3, generee
// au lancement. Une nappe laser n'eclaire qu'une tranche de la fumee : on y voit une coupe de cette texture.
//
// Les deux canaux (r, g) sont le meme champ a deux instants opposes d'une boucle d'evolution : le shader les melange
// en aller-retour avec une seule lecture, et les volutes se tordent et se defont au lieu de glisser comme un decor.
// Valeurs de moyenne 0,5 et d'ecart type VOLUTES_SD (avant les mipmaps).
//
// Compressee en BC5 (1 octet par texel) : le cout des volutes vient de la memoire lue par couple (pixel, segment)
// (PERFORMANCE.md) ; en RGBA8 (4 octets), la passe des lasers etait 60 a 90 % plus lente.
#pragma once
#include <cstdint>
#include <vector>

constexpr int VOLUTES_N = 64;
constexpr float VOLUTES_SD = 0.17f;

struct Volutes {
    // mips[0] : 128^3, puis 64^3, ... 1^3 (moyenne 2 x 2 x 2), chacun en blocs BC5 (4 x 4 texels d'une tranche)
    std::vector<std::vector<uint8_t>> mips;
    std::vector<float> level_sd;   // ecart type de chaque niveau (contraste qui reste au loin)
    double build_ms = 0;
    void build();
};
