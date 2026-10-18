// Fumee de scene : simulation grossiere sur CPU (amas qui derivent, machines a fumee)
// + texture de detail 3D (volutes fines) generee une fois. Le GPU combine les deux.
#pragma once
#include "fumee_spatiale.h"
#include "mathx.h"
#include <cstdint>
#include <thread>
#include <vector>

struct SmokeMachine {
    vec3 pos;
    vec3 dir;         // direction du jet
    bool on = true;
};

struct FogSettings {
    float density = 0.035f;     // densite globale (extinction par metre pour une fumee "pleine")
    float haze = 0.35f;         // fond de brume uniforme (hazer) 0..1
    float smoke = 1.0f;         // poids des amas de fumee simules
    float machine_output = 1.0f;
    float dissipation = 0.012f; // perte par seconde
    float wind_speed = 0.35f;   // m/s
    float wind_angle = 0.0f;    // degres
    float turbulence = 0.6f;    // m/s
    float rise = 0.08f;         // m/s (chaleur : la fumee monte)
    float height_falloff = 0.03f;  // la brume est plus dense en bas (par metre)
    float detail_strength = 0.2f;  // volutes fines 0..1
    float detail_scale = 7.0f;     // taille des volutes (m)
    float anisotropy = 0.55f;   // diffusion vers l'avant (g de Henyey-Greenstein)
    float scattering = 0.9f;    // part diffusee (albedo du milieu)
    bool animate = true;
};

struct FogSim {
    static constexpr int NX = 64, NY = 24, NZ = 32;
    static constexpr int DETAIL = 64;  // texture de detail DETAIL^3, repetable

    vec3 origin, size;           // boite couverte (= hangar)
    std::vector<float> d, tmp;   // densite simulee
    // densite quantifiee pour le GPU (NX*NY*NZ, RGBA8) : r = amas / 2 (lyres, fog_density) ; g = densite de la piece
    // (brume x decroissance en hauteur + amas) / room_max, pour les lasers (meme texture : une 2e texture envoyee a
    // chaque image faisait attendre la carte sous Direct3D 11). Fumee spatiale v2 (lasers) : g = brume (decroissance en
    // hauteur, logique de la salle), b = style de la region (salle composee), a = champ des bancs (loi normale,
    // 0,5 + z / 8), seuille par pixel dans le shader
    std::vector<uint8_t> upload;
    float room_max = 1;
    // fumee spatiale des lasers (v2, fumee_spatiale.h) : bancs de fumee, recalcules a chaque pas de la simulation
    SpatialFogBanks banks;
    float banks_time = -1;
    SpatialFogSettings banks_set;
    SpatialFogRoom room;                           // salle composee : logique de la salle, recalculee a chaque reglage
    float room_wind = 0;
    float sf_haze_scale = 0, sf_smoke_scale = 0;   // v2 : brume = canal g x sf_haze_scale, amas = canal r x sf_smoke_scale
    std::vector<uint8_t> detail; // bruit de detail (DETAIL^3)
    std::vector<SmokeMachine> machines;
    float sim_time = 0;
    float mean_smoke = 0;        // densite moyenne des amas (pour l'extinction globale)
    float accum = 0;

    ~FogSim() { wait(); }
    void init(vec3 bmin, vec3 bmax);
    void prefill();   // remplit d'amas pour que la salle soit deja enfumee
    void clear();
    // sf : fumee des lasers (modele v2 : canal g selon les bancs, canal b) ; nul ou modele Classique : comme avant
    void update(float dt, const FogSettings& s, const SpatialFogSettings* sf = nullptr);
    // Pas de la simulation en tache de fond (PLAN-OPTIM-LASERS.md, 0.2) : lance a la fin de update (pas et champ des
    // bancs, sur plusieurs coeurs), attendu au debut de la suivante, et avant init, clear et prefill. Rien d'autre ne lit
    // d, tmp, sim_time ni banks pendant le calcul. La carte envoyee au GPU a donc une image de retard sur la simulation
    // (meme suite d'etats ; a 20 pas par seconde, invisible).
    void wait();
    float wait_ms = 0;   // attente du dernier pas, au debut de update (journal)

  private:
    std::thread job;
    void fill(const FogSettings& s, const SpatialFogSettings* sf);   // carte envoyee au GPU (upload), depuis l'etat publie
    void step(float dt, const FogSettings& s, const std::vector<SmokeMachine>& mach);
    void update_spatial(const FogSettings& s, const SpatialFogSettings& sf);
    float sample(float x, float y, float z) const;
};
