// Fumee de scene : simulation grossiere sur CPU (amas qui derivent, machines a fumee)
// + texture de detail 3D (volutes fines) generee une fois. Le GPU combine les deux.
#pragma once
#include "mathx.h"
#include <cstdint>
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
    std::vector<uint8_t> upload; // densite quantifiee pour le GPU (NX*NY*NZ)
    std::vector<uint8_t> detail; // bruit de detail (DETAIL^3)
    std::vector<SmokeMachine> machines;
    float sim_time = 0;
    float mean_smoke = 0;        // densite moyenne des amas (pour l'extinction globale)
    float accum = 0;

    void init(vec3 bmin, vec3 bmax);
    void prefill();   // remplit d'amas pour que la salle soit deja enfumee
    void clear();
    void update(float dt, const FogSettings& s);

  private:
    void step(float dt, const FogSettings& s);
    float sample(float x, float y, float z) const;
};
