// Outils communs des scenes (src/scenes) : groupes d'appareils, couleurs, programmation des lyres et des lasers,
// effets, fichiers ILDA. Memes conventions que les ambiances (src/ambiances.cpp) :
//   - salle : scene a -X, public a +X ; trusses a 18 m (z = -15, -5, 5, 15), pont de scene a 12 m (x = -42), sol de
//     scene (x = -46, vers le haut), nez de scene (x = -33, au sol, vers le haut) ;
//   - lyres suspendues : tilt 0 vers le bas, > 0 vers la scene, < 0 vers le public ; pont : tilt > 0 vers le public ;
//     sol et nez : tilt 0 vers le haut, > 0 vers le public ;
//   - lasers : axe des trusses 65 deg sous l'horizontale vers le public, du pont 12 deg sous l'horizontale, du sol
//     15 deg et du nez 5 deg au-dessus ; tilt > 0 releve la figure, pan la decale en z (+-30 deg au plus).
#pragma once
#include "app.h"
#include <cstring>
#include <string>

namespace scenes {

// groupes : 0-3 trusses, 4 pont de scene, 5 sol de scene, 6 nez de scene
enum : unsigned { G_T1 = 1u, G_T2 = 2u, G_T3 = 4u, G_T4 = 8u, G_TRUSS = 0xF, G_PONT = 1u << 4, G_SOL = 1u << 5,
                  G_NEZ = 1u << 6, G_SCENE = G_PONT | G_SOL | G_NEZ, G_ALL = 0x7F };
inline bool in(unsigned mask, int group) { return group >= 0 && group < 32 && ((mask >> group) & 1u); }

const vec3 WHITE = {1, 1, 1}, RED = {1, 0, 0}, ORANGE = {1, 0.35f, 0}, AMBER = {1, 0.6f, 0.15f}, CTO = {1, 0.78f, 0.55f};
const vec3 GREEN = {0, 1, 0}, LIME = {0.6f, 1, 0}, CYAN = {0, 0.85f, 1}, TEAL = {0, 1, 0.6f}, BLUE = {0.05f, 0.25f, 1};
const vec3 DEEP_BLUE = {0, 0, 1}, MAGENTA = {1, 0, 0.8f}, PINK = {1, 0.25f, 0.55f}, PURPLE = {0.5f, 0, 1};
const vec3 YELLOW = {1, 0.85f, 0}, ICE = {0.7f, 0.9f, 1}, UV = {0.3f, 0, 1};

// Gobos (GOBO_NAMES) : 0 ouvert, 1 points, 2 etoile, 3 anneaux, 4 rayons, 5 fleur, 6 breakup, 7 triangles, 8 barres,
// 9 cercle de points, 10 spirale, 11 feuillage, 12 galaxie, 13 croix.

// Lyres des groupes 'mask' : fn(parametres, lyre, rang dans son groupe)
template <typename F> void lyres(unsigned mask, F fn) {
    int kg[32] = {};
    for (Fixture& f : app.rig.fixtures)
        if (in(mask, f.mount.group)) fn(f.base, f, kg[f.mount.group]++);
}
template <typename F> void lasers(unsigned mask, F fn) {
    int kg[32] = {};
    for (LaserFixture& f : app.lasers.fixtures)
        if (in(mask, f.mount.group)) fn(f.base, f, kg[f.mount.group]++);
}

// Effet sur les lyres allumees des groupes 'mask'.
inline Effect& lyre_fx(unsigned mask, int type, float size, float speed, float spread, int wings = 1) {
    Rig& rig = app.rig;
    for (Fixture& f : rig.fixtures) f.selected = in(mask, f.mount.group) && f.base.dimmer > 0;
    rig.add_effect(type);
    rig.select_all(false);
    Effect& e = rig.effects.back();
    e.size = size;
    e.speed = speed;
    e.spread = spread;
    e.wings = wings;
    return e;
}
inline Effect& laser_fx(unsigned mask, int type, float size, float speed, float spread, int wings = 1) {
    LaserRig& lr = app.lasers;
    for (LaserFixture& f : lr.fixtures) f.selected = in(mask, f.mount.group) && f.base.dimmer > 0;
    lr.add_effect(type);
    lr.select_all(false);
    Effect& e = lr.effects.back();
    e.size = size;
    e.speed = speed;
    e.spread = spread;
    e.wings = wings;
    return e;
}

// Mise au point sur le sol d'une lyre suspendue penchee de 'tilt' degres (lentille 0,71 m sous l'accroche).
inline float floor_focus(const Fixture& f, float tilt) {
    const float h = f.mount.pos.y - 0.71f;
    return clampf(h / std::max(std::cos(tilt * DEG), 0.2f), 1.0f, 80.0f);
}

// Fichiers ILDA : le k-ieme fichier de la banque 'bank' (en boucle sur la banque), -1 si elle n'existe pas. Noms des
// banques en UTF-8 : "G\xc3\xa9om\xc3\xa9trie" pour Geometrie.
inline int ilda_in_bank(const char* bank, int k) {
    const std::vector<int> b = app.lasers.ilda.bank(bank);
    if (b.empty()) return -1;
    return b[(size_t)((k % (int)b.size() + (int)b.size()) % (int)b.size())];
}
// Le fichier dont le nom commence par 'name' dans la banque 'bank' (-1 : absent).
inline int ilda_named(const char* bank, const char* name) {
    for (int i : app.lasers.ilda.bank(bank))
        if (app.lasers.ilda.clips[i].name.compare(0, std::strlen(name), name) == 0) return i;
    return -1;
}
// Un laser joue un fichier ILDA (taille = ouverture du champ, deg).
inline void play_ilda(LaserParams& p, int clip, float size, float fps = 30.0f, bool file_colors = true) {
    p.source = 1;
    p.ilda_clip = clip;
    p.opening = size;
    p.ilda_fps = fps;
    p.ilda_play = 0;
    p.ilda_colors = file_colors;
    p.dimmer = clip >= 0 ? p.dimmer : 0.0f;
}

}  // namespace scenes
