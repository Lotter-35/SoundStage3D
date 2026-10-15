// Etat global de l'application.
#pragma once
#include "fixtures.h"
#include "floor_texture.h"
#include "fog.h"
#include "gobos.h"
#include "lasers.h"
#include "renderer.h"
#include "scene.h"

struct Timings {
    float frame_ms = 0, fps = 0;
    float rig_ms = 0, fog_ms = 0, render_cpu_ms = 0, ui_ms = 0;
    float laser_ms = 0;   // moteur laser (figures -> segments)
    float cpu_ms = 0;   // tout le travail CPU d'une image (attente du GPU comprise)
};

struct App {
    Scene scene;
    Rig rig;
    LaserRig lasers;
    GoboAtlas gobos;
    FloorTexture floor;
    FogSim fog;
    FogSettings fog_settings;
    RenderSettings rs;
    Renderer renderer;
    Camera cam;
    Timings timings;

    // entrees
    bool keys[512] = {};
    bool looking = false;       // clic droit maintenu : on tourne la camera
    float move_speed = 8.0f;
    bool show_ui = true;
    int pick_aim = -1;          // >= 0 : le prochain clic gauche place ce point de visee

    // mode personnage (vue a la 3e personne)
    bool character = false;
    vec3 player = {20, 0, 0};
    float player_vy = 0;
    bool on_ground = true;

    float time = 0;
    bool paused = false;        // fige les effets et la fumee

    // ambiances (onglet Ambiances) : celle en cours ; onglet ouvert = les fleches changent d'ambiance
    int ambiance = 0;
    bool ambiance_tab = false;

    // selection a l'ecran (debug) : onglet Lyres ouvert = lyres (0), onglet Lasers = lasers (1), sinon -1.
    // Clic gauche dans la scene : l'appareil le plus proche (Ctrl : l'ajoute ou le retire) ; glisser : un rectangle
    // (Ctrl ajoute, Maj retire).
    int sel_kind = -1;
    bool sel_drag = false;
    float sel_x0 = 0, sel_y0 = 0, sel_x1 = 0, sel_y1 = 0;   // coordonnees de l'interface (pas les pixels de l'image)
};

extern App app;
void draw_ui();
// Fin du glisser : selectionne les lyres ou les lasers du rectangle (mode 0 remplace, 1 ajoute, 2 retire).
void select_in_rect(int mode);
