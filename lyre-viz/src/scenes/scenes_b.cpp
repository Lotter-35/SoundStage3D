// Scenes 21 a 40 (ambiances 41 a 60) : voir scenes.h et scene_kit.h (reperes de la salle).
#include "scene_kit.h"
#include "scenes.h"

namespace scenes {

void apply_b(int i) {
    FogSettings& fog = app.fog_settings;
    RenderSettings& r = app.rs;
    switch (i) {
        case 20: {   // Etoiles filantes
            fog.haze = 0.5f;
            lasers(G_TRUSS, [](LaserParams& p, LaserFixture& f, int kg) {
                if (kg % 4 != 1) return;
                p.dimmer = 0.6f;
                p.shape = LS_STAR;
                p.branches = 5;
                p.traits = 0;
                p.opening = 6;
                p.color = (f.mount.group & 1) ? YELLOW : WHITE;
                p.tilt = 10;
                p.roll_speed = 90;
            });
            laser_fx(G_TRUSS, LFX_RANDOM, 25, 0.3f, 360);
            lyres(G_PONT, [](FixtureParams& p, Fixture& f, int kg) {
                if (kg & 1) return;
                p.dimmer = 1;
                p.color = DEEP_BLUE;
                p.gobo = 12;   // galaxie
                p.gobo_speed = 5;
                p.zoom = 28;
                p.tilt = 68;
                p.focus = floor_focus(f, 68);
            });
            break;
        }

        case 21: {   // Nef de lasers : nappes verticales, colonnes de lumiere
            fog.density *= 1.3f;
            fog.haze = 0.7f;
            app.lasers.power_w = 6.0f;
            lasers(G_NEZ | G_SOL, [](LaserParams& p, LaserFixture&, int kg) {
                p.dimmer = 1;
                p.traits = 0;
                p.opening = 30;
                p.roll = 90;   // eventail vertical
                p.gradient = LG_TWO;
                p.color = ICE;
                p.color2 = BLUE;
                p.tilt = 30;
                p.pan = -24.0f + 6.9f * (float)kg;
            });
            laser_fx(G_NEZ | G_SOL, LFX_PAN_WAVE, 4, 0.05f, 360);
            lyres(G_TRUSS, [](FixtureParams& p, Fixture&, int kg) {
                if (kg % 4) return;
                p.dimmer = 0.9f;
                p.color = ICE;
                p.zoom = 3;
                p.tilt = 0;
            });
            break;
        }

        case 22: {   // Rave rouge
            lyres(G_TRUSS, [](FixtureParams& p, Fixture&, int) {
                p.dimmer = 1;
                p.color = RED;
                p.zoom = 3;
                p.tilt = -25;
            });
            Effect& c = lyre_fx(G_TRUSS, FX_DIMMER_CHASE, 1, 3.0f, 1440, 4);
            c.wave = WAVE_SQUARE;
            c.duty = 0.35f;
            lyre_fx(G_TRUSS, FX_PAN_WAVE, 30, 0.6f, 360, 2);
            lyres(G_PONT, [](FixtureParams& p, Fixture&, int) {
                p.dimmer = 1;
                p.zoom = 30;
                p.frost = 0.3f;
                p.tilt = 55;
                p.strobe = 10;
            });
            lasers(G_TRUSS, [](LaserParams& p, LaserFixture&, int kg) {
                if (kg % 6 != 3) return;
                p.dimmer = 1;
                p.color = RED;
                p.traits = 6;
                p.opening = 40;
                p.tilt = 10;
            });
            laser_fx(G_TRUSS, LFX_TILT_WAVE, 15, 0.8f, 360);
            Effect& d = laser_fx(G_TRUSS, LFX_DIMMER_CHASE, 1, 2.0f, 720);
            d.wave = WAVE_SQUARE;
            break;
        }

        case 23: {   // Cercles au sol : cones arc-en-ciel vers le bas
            r.floor_wet = 0.4f;
            fog.haze = 0.3f;
            lasers(G_TRUSS, [](LaserParams& p, LaserFixture&, int kg) {
                if (kg % 4 != 2) return;
                p.dimmer = 1;
                p.shape = LS_CONE;
                p.traits = 0;
                p.opening = 12;
                p.gradient = LG_RAINBOW;
                p.gradient_speed = 0.3f;
                p.roll_speed = 60;
                p.tilt = -25;   // vers le bas
            });
            laser_fx(G_TRUSS, LFX_CIRCLE, 8, 0.12f, 360);
            laser_fx(G_TRUSS, LFX_OPENING, 0.4f, 0.2f, 360);
            break;
        }

        case 24: {   // Disco
            lyres(G_TRUSS, [](FixtureParams& p, Fixture& f, int kg) {
                if (kg & 1) return;
                p.dimmer = 1;
                p.gobo = 1;   // points
                p.gobo_speed = 30;
                p.prism = PRISM_8;
                p.prism_speed = (kg & 2) ? 25.0f : -25.0f;
                p.zoom = 18;
                p.tilt = -5;
                p.focus = floor_focus(f, -5);
            });
            Effect& c = lyre_fx(G_TRUSS, FX_COLOR_ALT, 0, 0.25f, 720, 2);
            c.color_a = WHITE;
            c.color_b = AMBER;
            lyre_fx(G_TRUSS, FX_CIRCLE, 6, 0.08f, 360);
            lasers(G_PONT, [](LaserParams& p, LaserFixture&, int kg) {
                if (kg % 3) return;
                p.dimmer = 0.8f;
                p.shape = LS_GRID;
                p.shape_param = 5;
                p.traits = 25;
                p.opening = 10;
                p.diffraction = 9;
                p.diffraction_angle = 8;
                p.color = WHITE;
                p.tilt = 12;
            });
            laser_fx(G_PONT, LFX_RANDOM, 12, 0.2f, 360);
            break;
        }

        case 25: {   // Spirale
            lyres(G_TRUSS, [](FixtureParams& p, Fixture& f, int kg) {
                if (kg % 3) return;
                p.dimmer = 1;
                p.color = (f.mount.group & 1) ? CYAN : MAGENTA;
                p.gobo = 10;   // spirale
                p.gobo_speed = (f.mount.group & 1) ? 60.0f : -60.0f;
                p.zoom = 16;
                p.tilt = 0;
                p.focus = floor_focus(f, 0);
            });
            lyre_fx(G_TRUSS, FX_CIRCLE, 10, 0.1f, 360, 4);
            lasers(G_PONT, [](LaserParams& p, LaserFixture&, int kg) {
                if (kg & 1) return;
                p.dimmer = 1;
                p.shape = LS_TUNNEL;
                p.traits = 0;
                p.opening = 20;
                p.gradient = LG_TWO;
                p.color = MAGENTA;
                p.color2 = CYAN;
                p.roll_speed = (kg & 2) ? 90.0f : -90.0f;
                p.tilt = 12;
            });
            break;
        }

        case 26: {   // Matrice
            fog.haze = 0.6f;
            lasers(G_PONT, [](LaserParams& p, LaserFixture&, int kg) {
                if (kg % 3 != 1) return;
                p.dimmer = 1;
                p.shape = LS_GRID;
                p.shape_param = 8;
                p.traits = 40;
                p.opening = 30;
                p.diffraction = 9;
                p.diffraction_angle = 7;
                p.color = GREEN;
                p.tilt = 14;
            });
            laser_fx(G_PONT, LFX_TILT_WAVE, 6, 0.15f, 360);
            lyres(G_TRUSS, [](FixtureParams& p, Fixture& f, int kg) {
                if (kg % 3) return;
                p.dimmer = 1;
                p.color = GREEN;
                p.gobo = 8;   // barres
                p.gobo_speed = 20;
                p.zoom = 10;
                p.tilt = -8;
                p.focus = floor_focus(f, -8);
            });
            lyre_fx(G_TRUSS, FX_TILT_WAVE, 10, 0.3f, 720);
            break;
        }

        case 27: {   // Jungle
            fog.smoke = 1.6f;
            fog.rise = 0.25f;
            fog.turbulence = 1.0f;
            static const vec3 cols[3] = {LIME, GREEN, YELLOW};
            lyres(G_TRUSS, [](FixtureParams& p, Fixture& f, int kg) {
                if (kg & 1) return;
                p.dimmer = 1;
                p.color = cols[(kg / 2) % 3];
                p.gobo = 11;   // feuillage
                p.gobo_speed = (kg & 2) ? 8.0f : -8.0f;
                p.zoom = 20;
                p.frost = 0.1f;
                p.tilt = 5;
                p.focus = floor_focus(f, 5);
            });
            lyre_fx(G_TRUSS, FX_TILT_WAVE, 4, 0.05f, 360, 2);
            lyres(G_PONT, [](FixtureParams& p, Fixture&, int kg) {
                if (kg % 3) return;
                p.dimmer = 1;
                p.color = AMBER;
                p.zoom = 3;
                p.tilt = 45;
            });
            lasers(G_PONT, [](LaserParams& p, LaserFixture&, int kg) {
                if (kg % 4) return;
                p.dimmer = 0.3f;
                p.traits = 4;
                p.opening = 30;
                p.color = LIME;
                p.tilt = 20;
            });
            laser_fx(G_PONT, LFX_PAN_WAVE, 10, 0.08f, 360);
            break;
        }

        case 28: {   // Lagune
            r.floor_wet = 1.0f;
            app.lasers.power_w = 5.0f;
            lyres(G_TRUSS, [](FixtureParams& p, Fixture& f, int kg) {
                if (kg % 3) return;
                p.dimmer = 1;
                p.color = (f.mount.group & 1) ? CYAN : TEAL;
                p.gobo = 6;   // breakup
                p.gobo_speed = (kg & 1) ? 8.0f : -8.0f;
                p.zoom = 25;
                p.frost = 0.2f;
                p.tilt = 0;
                p.focus = floor_focus(f, 0);
            });
            lyre_fx(G_TRUSS, FX_CIRCLE, 5, 0.04f, 360);
            lasers(G_SOL, [](LaserParams& p, LaserFixture&, int) {
                p.dimmer = 0.8f;
                p.traits = 0;
                p.opening = 60;
                p.color = TEAL;
                p.tilt = -12;   // 3 deg au-dessus de l'horizontale : au ras des tetes, puis au-dessus
            });
            laser_fx(G_SOL, LFX_TILT_WAVE, 1, 0.05f, 360);
            break;
        }

        case 29: {   // Glace
            r.chroma = true;
            r.chroma_strength = 2.0f;
            fog.haze = 0.5f;
            fog.density *= 0.8f;
            lyres(G_TRUSS, [](FixtureParams& p, Fixture&, int kg) {
                if (kg & 1) return;
                p.dimmer = 1;
                p.color = ICE;
                p.prism = PRISM_9_GRID;
                p.prism_speed = 15;
                p.zoom = 6;
                p.tilt = -12;
            });
            lyre_fx(G_TRUSS, FX_FIGURE8, 10, 0.06f, 360, 2);
            lasers(G_PONT, [](LaserParams& p, LaserFixture&, int kg) {
                if (kg & 1) return;
                p.dimmer = 0.8f;
                p.shape = LS_STAR;
                p.branches = 6;
                p.traits = 0;
                p.opening = 14;
                p.color = ICE;
                p.diffraction = 3;
                p.diffraction_angle = 10;
                p.roll_speed = 15;
                p.tilt = 16;
            });
            break;
        }

        case 30: {   // Volcan
            fog.smoke = 2.2f;
            fog.rise = 0.35f;
            fog.machine_output = 1.5f;
            r.floor_wet = 0.2f;
            r.laser_white = 0.8f;
            app.lasers.power_w = 6.0f;
            lasers(G_SOL | G_NEZ, [](LaserParams& p, LaserFixture&, int kg) {
                p.dimmer = 1;
                p.traits = 0;
                p.opening = 25;
                p.roll = 90;   // nappes verticales : jets
                p.gradient = LG_TWO;
                p.color = RED;
                p.color2 = ORANGE;
                p.tilt = 25;
                p.pan = -24.0f + 6.9f * (float)kg;
            });
            laser_fx(G_SOL | G_NEZ, LFX_TILT_WAVE, 5, 0.4f, 360);
            lyres(G_TRUSS, [](FixtureParams& p, Fixture& f, int kg) {
                if (kg % 3) return;
                p.dimmer = 1;
                p.color = (kg & 1) ? RED : ORANGE;
                p.gobo = 6;
                p.gobo_speed = 12;
                p.zoom = 18;
                p.tilt = 0;
                p.focus = floor_focus(f, 0);
            });
            lyre_fx(G_TRUSS, FX_DIMMER_CHASE, 0.6f, 0.5f, 720, 3).wave = WAVE_SINE;
            break;
        }

        case 31: {   // Hypnose
            fog.haze = 0.5f;
            lasers(G_PONT, [](LaserParams& p, LaserFixture&, int kg) {
                if (kg & 1) return;
                p.dimmer = 1;
                p.shape = LS_DOUBLE_FAN;
                p.shape_param = 12;
                p.traits = 30;
                p.opening = 40;
                p.color = WHITE;
                p.roll_speed = (kg & 2) ? 45.0f : -45.0f;
                p.tilt = 12;
            });
            lasers(G_NEZ, [](LaserParams& p, LaserFixture&, int kg) {
                p.dimmer = 0.8f;
                p.shape = LS_TUNNEL;
                p.traits = 0;
                p.opening = 16;
                p.color = WHITE;
                p.roll_speed = (kg & 1) ? 60.0f : -60.0f;
                p.tilt = 20;
            });
            break;
        }

        case 32: {   // Minimal : air clair, quelques faisceaux fins, un trait vert
            fog.haze = 0.12f;
            fog.density *= 0.5f;
            fog.smoke = 0.3f;
            lyres(G_TRUSS, [](FixtureParams& p, Fixture&, int kg) {
                if (kg % 10 != 5) return;
                p.dimmer = 1;
                p.zoom = 2;
                p.tilt = 0;
            });
            lasers(G_PONT, [](LaserParams& p, LaserFixture&, int kg) {
                if (kg != 7) return;
                p.dimmer = 1;
                p.traits = 1;
                p.opening = 0;
                p.color = GREEN;
                p.tilt = 12;
            });
            laser_fx(G_PONT, LFX_PAN_WAVE, 20, 0.05f, 0);
            break;
        }

        case 33: {   // Brume doree
            fog.haze = 0.6f;
            lyres(G_TRUSS, [](FixtureParams& p, Fixture& f, int kg) {
                if (kg & 1) return;
                p.dimmer = 1;
                p.color = (f.mount.group & 1) ? AMBER : CTO;
                p.zoom = 12;
                p.frost = 0.3f;
                p.tilt = 10;
            });
            lyre_fx(G_TRUSS, FX_TILT_WAVE, 8, 0.03f, 360);
            lyres(G_PONT, [](FixtureParams& p, Fixture&, int) {
                p.dimmer = 0.9f;
                p.color = CTO;
                p.iris = 0.5f;
                p.zoom = 4;
                p.tilt = 35;
            });
            lyre_fx(G_PONT, FX_FAN, 25, 0.03f, 0);
            lasers(G_PONT, [](LaserParams& p, LaserFixture&, int kg) {
                if (kg % 4 != 2) return;
                p.dimmer = 0.4f;
                p.traits = 0;
                p.opening = 60;
                p.color = AMBER;
                p.tilt = 24;
            });
            break;
        }

        case 34: {   // Scanner : un faisceau par laser qui balaie vite
            fog.haze = 0.5f;
            lasers(G_PONT | G_NEZ, [](LaserParams& p, LaserFixture&, int) {
                p.dimmer = 1;
                p.traits = 1;
                p.opening = 0;
                p.tilt = 15;
            });
            laser_fx(G_PONT | G_NEZ, LFX_PAN_WAVE, 25, 1.0f, 360);
            laser_fx(G_PONT | G_NEZ, LFX_TILT_WAVE, 10, 0.7f, 360);
            laser_fx(G_PONT | G_NEZ, LFX_RAINBOW, 1, 0.1f, 360);
            break;
        }

        case 35: {   // Pluie de points : traits vers le sol
            fog.haze = 0.2f;
            fog.density *= 0.5f;
            r.floor_wet = 0.5f;
            lasers(G_TRUSS, [](LaserParams& p, LaserFixture& f, int kg) {
                if (kg % 3) return;
                p.dimmer = 0.8f;
                p.traits = 8;
                p.opening = 30;
                p.color = (f.mount.group & 1) ? CYAN : MAGENTA;
                p.tilt = -25;   // vers le bas
            });
            laser_fx(G_TRUSS, LFX_RANDOM, 15, 0.15f, 360);
            laser_fx(G_TRUSS, LFX_ROLL, 40, 0.1f, 360);
            break;
        }

        case 36: {   // Contre-jour : le pont eblouit le public de face
            fog.smoke = 1.4f;
            fog.haze = 0.5f;
            r.exposure *= 1.5f;
            lyres(G_PONT, [](FixtureParams& p, Fixture&, int) {
                p.dimmer = 1;
                p.zoom = 14;
                p.frost = 0.15f;
                p.tilt = 72;   // vers le public, au-dessus des tetes
            });
            lyres(G_SOL, [](FixtureParams& p, Fixture&, int) {
                p.dimmer = 1;
                p.zoom = 10;
                p.frost = 0.2f;
                p.tilt = 80;
            });
            lyre_fx(G_PONT | G_SOL, FX_DIMMER_CHASE, 0.4f, 0.1f, 360).wave = WAVE_SINE;
            break;
        }

        case 37: {   // Kaleidoscope
            r.chroma = true;
            r.chroma_strength = 1.5f;
            static const int prisms[3] = {PRISM_6, PRISM_8, PRISM_9_RING};
            lyres(G_TRUSS, [](FixtureParams& p, Fixture& f, int kg) {
                if (kg & 1) return;
                p.dimmer = 1;
                p.gobo = 9;   // cercle de points
                p.gobo_speed = 20;
                p.prism = prisms[(kg / 2) % 3];
                p.prism_speed = (kg & 2) ? 30.0f : -30.0f;
                p.zoom = 12;
                p.tilt = -10;
                p.focus = floor_focus(f, -10);
            });
            lyre_fx(G_TRUSS, FX_RAINBOW, 1, 0.12f, 720);
            lasers(G_PONT, [](LaserParams& p, LaserFixture&, int kg) {
                if (kg % 3) return;
                p.dimmer = 0.9f;
                p.shape = LS_STAR;
                p.branches = 8;
                p.traits = 0;
                p.opening = 12;
                p.diffraction = 5;
                p.diffraction_angle = 9;
                p.gradient = LG_RAINBOW;
                p.gradient_speed = 0.2f;
                p.roll_speed = 40;
                p.tilt = 14;
            });
            break;
        }

        case 38: {   // Synthwave : grille laser au sol mouille, soleil orange
            r.floor_wet = 0.8f;
            fog.haze = 0.45f;
            app.lasers.power_w = 8.0f;
            lasers(G_PONT, [](LaserParams& p, LaserFixture&, int kg) {
                if (kg % 4 != 1) return;
                p.dimmer = 1;
                p.shape = LS_GRID;
                p.shape_param = 8;
                p.traits = 0;
                p.opening = 50;
                p.gradient = LG_TWO;
                p.color = MAGENTA;
                p.color2 = ORANGE;
                p.tilt = -2;   // vers le sol, devant la scene
            });
            laser_fx(G_PONT, LFX_TILT_WAVE, 3, 0.1f, 0);
            lyres(G_PONT, [](FixtureParams& p, Fixture&, int kg) {
                if (kg % 2) return;
                p.dimmer = 1;
                p.color = PURPLE;
                p.zoom = 20;
                p.frost = 0.2f;
                p.tilt = 55;
            });
            lyres(G_TRUSS, [](FixtureParams& p, Fixture& f, int kg) {
                if (f.mount.pos.x > -18.0f || (kg & 1)) return;
                p.dimmer = 1;
                p.color = ORANGE;
                p.zoom = 50;
                p.frost = 0.6f;
                p.tilt = 40;   // vers la scene : soleil au fond
            });
            break;
        }

        case 39: {   // Final ILDA : tous les fichiers a la fois
            static const char* const banks[3] = {"Tunnels", "G\xc3\xa9om\xc3\xa9trie", "Animations"};
            r.laser_white = 0.8f;
            lasers(G_PONT, [](LaserParams& p, LaserFixture&, int kg) {
                p.dimmer = 1;
                play_ilda(p, ilda_in_bank(banks[kg % 3], kg / 3), 30);
                p.tilt = 14;
            });
            lasers(G_NEZ, [](LaserParams& p, LaserFixture&, int kg) {
                p.dimmer = 1;
                play_ilda(p, ilda_in_bank("Faisceaux", kg), 45);
                p.tilt = 25;
            });
            lasers(G_TRUSS, [](LaserParams& p, LaserFixture&, int kg) {
                if (kg % 8 != 4) return;
                p.dimmer = 1;
                play_ilda(p, ilda_in_bank("Nappes", kg / 8), 35);
                p.tilt = 20;
            });
            lyres(G_TRUSS, [](FixtureParams& p, Fixture&, int kg) {
                if (kg & 1) return;
                p.dimmer = 1;
                p.zoom = 5;
                p.tilt = -10;
            });
            lyre_fx(G_TRUSS, FX_RAINBOW, 1, 0.2f, 360);
            lyre_fx(G_TRUSS, FX_CIRCLE, 12, 0.2f, 360, 2);
            break;
        }
    }
}

}  // namespace scenes
