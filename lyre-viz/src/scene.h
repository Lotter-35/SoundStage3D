// Scene statique : hangar, structures (trusses), scene, decor, et emplacements des lyres.
#pragma once
#include "mathx.h"
#include <string>
#include <vector>

// Une instance de maillage telle qu'envoyee au GPU (80 octets).
// r0..r2 : les 3 premieres lignes de la matrice monde (affine 3x4).
struct Instance {
    vec4 r0, r1, r2;
    vec4 albedo_rough;    // couleur de base (lineaire) + rugosite
    vec4 emissive_metal;  // emission (HDR) + metal
};

// Construit une instance a partir d'un centre et de 3 axes deja mis a l'echelle (demi-tailles).
Instance make_instance(vec3 center, vec3 ax, vec3 ay, vec3 az, vec3 albedo, float rough,
                       vec3 emissive = {0, 0, 0}, float metal = 0.0f);
// Pave aligne sur les axes.
Instance make_box(vec3 center, vec3 half, vec3 albedo, float rough, float metal = 0.0f);
// Pave oriente entre deux points (barre, tube) de section 'thick'.
Instance make_bar(vec3 a, vec3 b, float thick, vec3 albedo, float rough, float metal = 0.0f);

// Surface simple utilisee pour les lancers de rayons CPU (lumiere indirecte, visee a la souris).
struct Collider {
    vec3 mn, mx;
    vec3 albedo;
};

// Obstacle fixe qui fait de l'ombre (pave oriente : centre et 3 demi-axes).
struct Occluder {
    vec3 c, ax, ay, az;
};

struct RayHit {
    float t = 1e30f;
    vec3 pos, normal, albedo;
};

// Emplacement d'une lyre.
struct FixtureMount {
    vec3 pos;      // point d'accroche (dessous du truss ou dessus du sol)
    vec3 n;        // normale de la base : de la base vers la tete (bas si suspendue)
    vec3 f;        // direction de reference pour pan = 0 (horizontale)
    int group;     // indice de groupe
};

struct Scene {
    std::vector<Instance> cubes;       // geometrie statique (cubes unitaires -1..1)
    std::vector<Instance> cylinders;   // geometrie statique (cylindres unitaires)
    std::vector<Collider> colliders;
    std::vector<Occluder> occluders;   // ombres des faisceaux (pas les parois du hangar)
    std::vector<FixtureMount> mounts;
    std::vector<std::string> group_names;
    vec3 bounds_min, bounds_max;       // volume interieur du hangar

    void build();
    bool raycast(vec3 o, vec3 d, float tmax, RayHit& hit) const;
};
