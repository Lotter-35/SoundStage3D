// Etat global de l'application.
#pragma once
#include "fixtures.h"
#include "fog.h"
#include "gobos.h"
#include "renderer.h"
#include "scene.h"

struct Timings {
    float frame_ms = 0, fps = 0;
    float rig_ms = 0, fog_ms = 0, render_cpu_ms = 0, ui_ms = 0;
    float cpu_ms = 0;   // tout le travail CPU d'une image (attente du GPU comprise)
};

struct App {
    Scene scene;
    Rig rig;
    GoboAtlas gobos;
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
};

extern App app;
void draw_ui();
