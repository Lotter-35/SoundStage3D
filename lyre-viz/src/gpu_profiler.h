// Chronometrage GPU par passe (requetes "timestamp") et capture de l'image affichee.
// Disponible sous Direct3D 11 ; sur les autres API les fonctions ne font rien (available() = false).
#pragma once
#include "sokol_gfx.h"
#include <string>
#include <vector>

namespace gpuprof {

struct Section {
    const char* name;
    float ms;
};

void init();                  // apres sg_setup()
bool available();
void frame_begin();
void mark(const char* name);  // debut de la section 'name' (termine la precedente)
void frame_end();
// Dernieres mesures disponibles (en retard de quelques images sur le rendu).
const std::vector<Section>& last();
float last_total_ms();
// Numero (croissant) de la derniere image mesuree : permet de ne compter chaque mesure qu'une fois.
unsigned last_id();
// Temps passe a attendre le GPU (limiteur de latence) dans la derniere image.
float last_wait_ms();
// Nombre de pixels calcules (fragment shader) entre stats_begin() et stats_end() dans la derniere
// image mesuree : pour la fumee, c'est le nombre de couples (pixel, faisceau).
void stats_begin();
void stats_end();
double last_fragments();
// Le comptage des pixels calcules ralentit le GPU : desactive par defaut (--stats pour l'activer).
void enable_stats(bool on);
bool stats_enabled();
// Lit les 4 premiers entiers d'un tampon du GPU (compteurs), sans attendre : valeurs d'il y a quelques
// images. A appeler une fois par image, apres la passe qui les ecrit. Direct3D 11 seulement.
bool readback_u32x4(sg_buffer buf, unsigned out[4]);
// Temps GPU entre la fin d'une image et le debut de la suivante (presentation, autres programmes).
float last_gap_ms();

// Enregistre l'image en cours (avant presentation) dans un fichier BMP 24 bits.
bool save_backbuffer_bmp(const std::string& path);

}  // namespace gpuprof
