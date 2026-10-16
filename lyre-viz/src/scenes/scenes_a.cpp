// Scenes 1 a 20 (ambiances 21 a 40) : voir scenes.h et scene_kit.h (reperes de la salle).
#include "scene_kit.h"
#include "scenes.h"

namespace scenes {

void apply_a(int i) {
    FogSettings& fog = app.fog_settings;
    RenderSettings& r = app.rs;
    Rig& rig = app.rig;
    switch (i) {
        case 0: {   // Ciel liquide : nappes rouges et blanches au ras des tetes, fumee epaisse (reference 05)
            fog.density *= 1.6f;
            fog.smoke = 1.8f;
            fog.haze = 0.5f;
            fog.turbulence = 0.9f;
            r.laser_vol_strength = 1.0f;
            app.lasers.power_w = 15.0f;
            lasers(G_PONT, [](LaserParams& p, LaserFixture&, int kg) {
                if (kg & 1) return;
                p.dimmer = 1;
                p.traits = 0;
                p.opening = 60;
                p.gradient = LG_TWO;
                p.color = (kg & 2) ? RED : vec3{1, 0.85f, 0.85f};
                p.color2 = (kg & 2) ? vec3{1, 0.85f, 0.85f} : RED;
                p.tilt = 13;   // 1 deg au-dessus de l'horizontale, a 11 m : un plafond
            });
            laser_fx(G_PONT, LFX_TILT_WAVE, 2.5f, 0.05f, 360);
            laser_fx(G_PONT, LFX_ROLL, 4, 0.04f, 360);
            lasers(G_SOL, [](LaserParams& p, LaserFixture&, int kg) {
                p.dimmer = 1;
                p.traits = 0;   // nappe continue
                p.opening = 60;
                p.gradient = LG_TWO;
                p.color = RED;
                p.color2 = {1, 0.85f, 0.85f};
                p.tilt = -6;   // 9 deg au-dessus de l'horizontale
                p.roll = (kg & 1) ? 6.0f : -6.0f;
            });
            laser_fx(G_SOL, LFX_SPREAD, 22, 0, 0);
            laser_fx(G_SOL, LFX_ROLL, 5, 0.06f, 360);
            laser_fx(G_SOL, LFX_TILT_WAVE, 1.2f, 0.05f, 180);
            break;
        }

        case 1: {   // Pyramide laser : nappes arc-en-ciel du sol et du nez qui se croisent (reference 01)
            fog.haze = 0.6f;
            fog.smoke = 1.4f;
            r.laser_vol_strength = 0.9f;
            r.laser_white = 0.8f;
            app.lasers.power_w = 8.0f;
            lasers(G_NEZ | G_SOL, [](LaserParams& p, LaserFixture& f, int kg) {
                p.dimmer = 1;
                p.traits = 0;
                p.opening = 50;
                p.gradient = LG_RAINBOW;
                p.gradient_speed = 0.04f;
                p.tilt = f.mount.group == 6 ? 14.0f : 6.0f;   // ~20 deg au-dessus de l'horizontale : au-dessus du public
                p.roll = (kg & 1) ? 35.0f : -35.0f;            // nappes inclinees : elles se croisent
            });
            laser_fx(G_NEZ | G_SOL, LFX_SPREAD, 24, 0, 0);
            laser_fx(G_NEZ | G_SOL, LFX_ROLL, 6, 0.05f, 180, 2);
            lyres(G_TRUSS, [](FixtureParams& p, Fixture&, int kg) {
                if (kg % 4) return;
                p.dimmer = 0.35f;
                p.color = UV;
                p.zoom = 30;
                p.frost = 0.5f;
                p.tilt = 15;
            });
            break;
        }

        case 2: {   // Couronne blanche : faisceaux blancs vers le chanteur (reference 03)
            fog.smoke = 1.2f;
            fog.haze = 0.55f;   // densite d'origine : plus dense, la scene (70 m) serait noyee
            r.exposure *= 1.8f;
            rig.aim_points[0] = {-22, 0, 7};   // devant la scene, a cote du pilier central (visible depuis le public)
            lyres(G_PONT | G_TRUSS, [](FixtureParams& p, Fixture& f, int) {
                if (f.mount.group < 4 && f.mount.pos.x > -22.0f) return;   // trusses : les 4 premieres lyres
                p.dimmer = 1;
                p.color = WHITE;
                p.zoom = 3.0f;
                p.frost = 0.05f;
                p.aim_point = 0;
            });
            lyre_fx(G_PONT | G_TRUSS, FX_CIRCLE, 1.5f, 0.05f, 360);
            lyres(G_SOL, [](FixtureParams& p, Fixture&, int kg) {
                if (kg != 2 && kg != 5) return;
                p.dimmer = 0.6f;
                p.color = CTO;
                p.zoom = 12;
                p.frost = 0.2f;
                p.tilt = 20;
            });
            break;
        }

        case 3: {   // Traits croises : traits roses et cyan au hasard, colonnes rouges (reference 02)
            fog.haze = 0.5f;
            r.laser_white = 0.8f;
            lasers(G_TRUSS, [](LaserParams& p, LaserFixture& f, int kg) {
                if (kg % 3) return;
                p.dimmer = 0.7f;
                p.traits = 10;
                p.opening = 40;
                p.color = (f.mount.group & 1) ? CYAN : PINK;
                p.tilt = 10;
            });
            laser_fx(G_TRUSS, LFX_RANDOM, 18, 0.12f, 360);
            lasers(G_NEZ, [](LaserParams& p, LaserFixture&, int kg) {
                p.dimmer = 0.8f;
                p.traits = 12;
                p.opening = 55;
                p.color = (kg & 1) ? WHITE : PINK;
                p.tilt = 22;
            });
            laser_fx(G_NEZ, LFX_PAN_WAVE, 12, 0.15f, 360);
            lyres(G_PONT, [](FixtureParams& p, Fixture&, int kg) {
                if (kg % 3) return;
                p.dimmer = 1;
                p.color = {1, 0.05f, 0.3f};
                p.zoom = 7;
                p.tilt = 0;   // colonnes verticales
            });
            lyres(G_TRUSS, [](FixtureParams& p, Fixture&, int kg) {
                if (kg % 7) return;
                p.dimmer = 0.8f;
                p.color = MAGENTA;
                p.zoom = 2.5f;
                p.tilt = -20;
            });
            lyre_fx(G_TRUSS, FX_PAN_WAVE, 20, 0.1f, 720);
            break;
        }

        case 4: {   // Vert pur : eventails verts, nappes, contre-jour blanc (reference 06)
            fog.haze = 0.7f;
            r.laser_white = 0.9f;
            lasers(G_PONT, [](LaserParams& p, LaserFixture&, int kg) {
                p.dimmer = 1;
                p.color = GREEN;
                p.traits = (kg & 1) ? 12 : 8;
                p.opening = 50;
                p.tilt = 18;
            });
            laser_fx(G_PONT, LFX_PAN_WAVE, 10, 0.1f, 360, 2);
            lasers(G_NEZ, [](LaserParams& p, LaserFixture&, int) {
                p.dimmer = 1;
                p.color = GREEN;
                p.traits = 9;
                p.opening = 45;
                p.tilt = 25;
            });
            laser_fx(G_NEZ, LFX_SPREAD, 18, 0, 0);
            lasers(G_SOL, [](LaserParams& p, LaserFixture&, int kg) {
                if (kg & 1) return;
                p.dimmer = 0.7f;
                p.color = GREEN;
                p.traits = 0;
                p.opening = 60;
                p.tilt = -12;
            });
            lyres(G_PONT, [](FixtureParams& p, Fixture&, int kg) {
                if (kg % 4 != 1) return;
                p.dimmer = 0.8f;
                p.zoom = 40;
                p.frost = 0.6f;
                p.tilt = 75;   // vers le public : contre-jour aveuglant
            });
            lyres(G_TRUSS, [](FixtureParams& p, Fixture&, int kg) {
                if (kg % 8) return;
                p.dimmer = 0.9f;
                p.zoom = 2;
                p.tilt = 0;
            });
            break;
        }

        case 5: {   // Nappes bleues : nappes presque horizontales et traits blancs intenses (reference 07)
            fog.density *= 1.3f;
            r.laser_vol_strength = 0.9f;
            r.laser_white = 1.0f;
            app.lasers.power_w = 6.0f;
            lasers(G_SOL, [](LaserParams& p, LaserFixture&, int) {
                p.dimmer = 1;
                p.traits = 1000;
                p.opening = 55;
                p.gradient = LG_TWO;
                p.color = BLUE;
                p.color2 = PURPLE;
                p.tilt = -8;   // 7 deg au-dessus de l'horizontale
            });
            laser_fx(G_SOL, LFX_TILT_WAVE, 1.5f, 0.06f, 360);
            lasers(G_NEZ, [](LaserParams& p, LaserFixture&, int) {
                p.dimmer = 1;
                p.traits = 6;
                p.opening = 50;
                p.color = WHITE;
                p.tilt = -2;    // 3 deg au-dessus de l'horizontale
            });
            laser_fx(G_NEZ, LFX_PAN_WAVE, 6, 0.08f, 360);
            break;
        }

        case 6: {   // Volutes : larges bandes de couleur dans une fumee tres epaisse (reference 04)
            fog.density *= 1.3f;
            fog.smoke = 2.2f;
            app.lasers.power_w = 8.0f;
            fog.turbulence = 1.2f;
            fog.haze = 0.4f;
            r.laser_vol_strength = 1.2f;
            r.laser_vol_size = 1.1f;
            lasers(G_PONT, [](LaserParams& p, LaserFixture&, int kg) {
                if (kg & 1) return;
                p.dimmer = 1;
                p.traits = 10;
                p.opening = 55;
                p.gradient = LG_RANDOM;
                p.tilt = 14;
            });
            laser_fx(G_PONT, LFX_ROLL, 25, 0.05f, 180);
            laser_fx(G_PONT, LFX_TILT_WAVE, 5, 0.07f, 360);
            break;
        }

        case 7: {   // Aurore boreale
            fog.haze = 0.5f;
            r.floor_wet = 0.35f;
            lasers(G_TRUSS, [](LaserParams& p, LaserFixture&, int kg) {
                if (kg % 6 != 2) return;
                p.dimmer = 1;
                p.shape = LS_WAVE;
                p.traits = 0;
                p.opening = 55;
                p.shape_param = 6;
                p.wave_cycles = 2;
                p.gradient = LG_SCROLL;
                p.color = GREEN;
                p.color2 = TEAL;
                p.gradient_speed = 0.1f;
                p.tilt = 25;
            });
            laser_fx(G_TRUSS, LFX_ROLL, 10, 0.04f, 360);
            lyres(G_TRUSS, [](FixtureParams& p, Fixture&, int kg) {
                if (kg % 5) return;
                p.dimmer = 0.3f;
                p.color = DEEP_BLUE;
                p.zoom = 35;
                p.frost = 0.6f;
                p.tilt = 0;
            });
            break;
        }

        case 8: {   // Neon Tokyo
            r.floor_wet = 1.0f;
            r.chroma = true;
            r.chroma_strength = 1.5f;
            fog.haze = 0.4f;
            lyres(G_TRUSS, [](FixtureParams& p, Fixture& f, int kg) {
                if (kg & 1) return;
                p.dimmer = 1;
                p.color = (f.mount.group & 1) ? CYAN : MAGENTA;
                p.prism = PRISM_LINEAR_4;
                p.prism_speed = (kg & 2) ? 20.0f : -20.0f;
                p.zoom = 5;
                p.tilt = -15;
            });
            lyre_fx(G_TRUSS, FX_PAN_WAVE, 18, 0.12f, 360, 2);
            lyres(G_PONT, [](FixtureParams& p, Fixture& f, int kg) {
                if (kg & 1) return;
                p.dimmer = 1;
                p.color = PINK;
                p.gobo = 8;   // barres
                p.gobo_speed = 15;
                p.zoom = 18;
                p.tilt = 60;
                p.focus = 30;
                (void)f;
            });
            lasers(G_TRUSS, [](LaserParams& p, LaserFixture&, int kg) {
                if (kg % 7 != 3) return;
                p.dimmer = 0.8f;
                p.shape = LS_GRID;
                p.shape_param = 4;
                p.traits = 16;
                p.opening = 16;
                p.color = CYAN;
                p.diffraction = 3;
                p.diffraction_angle = 8;
                p.tilt = 5;
            });
            laser_fx(G_TRUSS, LFX_RANDOM, 10, 0.2f, 360);
            break;
        }

        case 9: {   // Desert : brume basse, vent, soleil couchant
            fog.haze = 0.9f;
            fog.haze = 0.6f;
            fog.height_falloff = 0.08f;
            fog.wind_speed = 1.5f;
            fog.wind_angle = 90;
            fog.smoke = 0.4f;
            r.exposure *= 1.15f;
            lyres(G_TRUSS, [](FixtureParams& p, Fixture& f, int kg) {
                if (kg % 3) return;
                p.dimmer = 0.9f;
                p.color = (f.mount.group & 1) ? AMBER : CTO;
                p.zoom = 10;
                p.frost = 0.15f;
                p.tilt = 25;
            });
            lyre_fx(G_TRUSS, FX_TILT_WAVE, 5, 0.03f, 360);
            lyres(G_PONT, [](FixtureParams& p, Fixture&, int kg) {
                if (kg % 2) return;
                p.dimmer = 1;
                p.color = AMBER;
                p.zoom = 50;
                p.frost = 0.8f;
                p.tilt = 75;
            });
            break;
        }

        case 10: {   // Abysses : bleu profond, rayons laser verticaux
            fog.density *= 1.8f;
            fog.haze = 0.9f;
            fog.rise = 0.0f;
            r.floor_wet = 0.6f;
            r.exposure *= 0.9f;
            lyres(G_TRUSS, [](FixtureParams& p, Fixture& f, int kg) {
                if (kg % 3) return;
                p.dimmer = 1;
                p.color = DEEP_BLUE;
                p.gobo = 6;   // breakup
                p.gobo_speed = (kg & 1) ? 6.0f : -6.0f;
                p.zoom = 14;
                p.tilt = 5;
                p.focus = floor_focus(f, 5);
            });
            lyre_fx(G_TRUSS, FX_TILT_WAVE, 6, 0.04f, 360, 2);
            lasers(G_TRUSS, [](LaserParams& p, LaserFixture&, int kg) {
                if (kg % 7) return;
                p.dimmer = 0.35f;
                p.traits = 30;
                p.opening = 18;
                p.color = CYAN;
                p.tilt = -25;   // a la verticale
            });
            laser_fx(G_TRUSS, LFX_ROLL, 30, 0.03f, 360);
            break;
        }

        case 11: {   // Orage
            fog.density *= 1.4f;
            fog.wind_speed = 2.0f;
            lyres(G_PONT, [](FixtureParams& p, Fixture&, int) {
                p.dimmer = 1;
                p.zoom = 45;
                p.frost = 0.4f;
                p.tilt = 50;
            });
            Effect& e = lyre_fx(G_PONT, FX_DIMMER_CHASE, 1, 0.9f, 720, 2);
            e.wave = WAVE_SQUARE;
            e.duty = 0.08f;
            lyres(G_TRUSS, [](FixtureParams& p, Fixture&, int kg) {
                if (kg & 1) return;
                p.dimmer = 0.5f;
                p.color = DEEP_BLUE;
                p.zoom = 8;
                p.tilt = -10;
            });
            lyre_fx(G_TRUSS, FX_CIRCLE, 8, 0.05f, 360);
            lasers(G_TRUSS, [](LaserParams& p, LaserFixture&, int kg) {
                if (kg % 10) return;
                p.dimmer = 1;
                p.traits = 1;
                p.opening = 0;
                p.color = WHITE;
            });
            laser_fx(G_TRUSS, LFX_RANDOM, 25, 0.7f, 360);
            Effect& l = laser_fx(G_TRUSS, LFX_DIMMER_CHASE, 1, 1.1f, 720);
            l.wave = WAVE_SQUARE;
            l.duty = 0.15f;
            break;
        }

        case 12: {   // Feu d'artifice : fichiers ILDA
            fog.haze = 0.4f;
            app.lasers.power_w = 6.0f;
            lasers(G_PONT, [](LaserParams& p, LaserFixture&, int kg) {
                if (kg & 1) return;
                p.dimmer = 1;
                play_ilda(p, ilda_named("Animations", "Feu"), 40);
                p.tilt = 20;
                p.pan = -14.0f + 4.0f * (float)(kg / 2);
            });
            lasers(G_NEZ, [](LaserParams& p, LaserFixture&, int kg) {
                if (kg & 1) return;
                p.dimmer = 1;
                play_ilda(p, ilda_named("Faisceaux", "Explosion"), 50);
                p.tilt = 25;
            });
            lyres(G_TRUSS, [](FixtureParams& p, Fixture& f, int kg) {
                if (kg % 3) return;
                p.dimmer = 1;
                p.gobo = 1;   // points
                p.prism = PRISM_8;
                p.prism_speed = 40;
                p.zoom = 6;
                p.tilt = -5;
                p.focus = floor_focus(f, -5);
            });
            Effect& e = lyre_fx(G_TRUSS, FX_DIMMER_CHASE, 1, 1.5f, 1440, 4);
            e.wave = WAVE_SQUARE;
            e.duty = 0.3f;
            break;
        }

        case 13: {   // Textes ILDA
            lasers(G_PONT, [](LaserParams& p, LaserFixture&, int kg) {
                if (kg < 5 || kg > 10) return;
                p.dimmer = 1;
                play_ilda(p, ilda_in_bank("Texte", kg), 32, 30, true);
                p.tilt = 18;
                p.pan = -12.0f + 4.0f * (float)(kg - 5);
            });
            lyres(G_TRUSS, [](FixtureParams& p, Fixture&, int kg) {
                if (kg % 4) return;
                p.dimmer = 1;
                p.color = GREEN;
                p.zoom = 3;
                p.tilt = -25;
            });
            lyre_fx(G_TRUSS, FX_PAN_WAVE, 22, 0.1f, 720, 2);
            break;
        }

        case 14: {   // Geometrie ILDA depuis les trusses
            fog.haze = 0.45f;
            lasers(G_TRUSS, [](LaserParams& p, LaserFixture&, int kg) {
                if (kg % 6 != 2) return;
                p.dimmer = 1;
                play_ilda(p, ilda_in_bank("G\xc3\xa9om\xc3\xa9trie", kg / 6), 30);
                p.tilt = 15;
            });
            lyres(G_PONT, [](FixtureParams& p, Fixture&, int) {
                p.dimmer = 0.5f;
                p.color = UV;
                p.zoom = 30;
                p.frost = 0.5f;
                p.tilt = 45;
            });
            break;
        }

        case 15: {   // Tunnels ILDA
            fog.density *= 1.3f;
            lasers(G_PONT, [](LaserParams& p, LaserFixture&, int kg) {
                p.dimmer = 1;
                play_ilda(p, ilda_in_bank("Tunnels", kg), 25);
                p.tilt = 12;
            });
            laser_fx(G_PONT, LFX_CIRCLE, 4, 0.1f, 360);
            break;
        }

        case 16: {   // Dessins a main levee (banque Crayon)
            fog.haze = 0.6f;
            app.lasers.power_w = 5.0f;
            lasers(G_PONT, [](LaserParams& p, LaserFixture&, int kg) {
                if (kg & 1) return;
                p.dimmer = 1;
                play_ilda(p, ilda_in_bank("Crayon", kg / 2), 40);
                p.tilt = 22;
            });
            laser_fx(G_PONT, LFX_ROLL, 10, 0.05f, 360);
            lyres(G_TRUSS, [](FixtureParams& p, Fixture&, int kg) {
                if (kg % 4) return;
                p.dimmer = 0.3f;
                p.color = CTO;
                p.zoom = 30;
                p.frost = 0.5f;
                p.tilt = 5;
            });
            break;
        }

        case 17: {   // Lissajous et sinus depuis les trusses
            lasers(G_TRUSS, [](LaserParams& p, LaserFixture&, int kg) {
                if (kg % 5 != 1) return;
                p.dimmer = 1;
                play_ilda(p, ilda_in_bank("Sinus", kg / 5), 35);
                p.tilt = 20;
            });
            lyres(G_PONT, [](FixtureParams& p, Fixture&, int) {
                p.dimmer = 0.8f;
                p.color = PURPLE;
                p.zoom = 10;
                p.tilt = 35;
            });
            lyre_fx(G_PONT, FX_FAN, 30, 0.05f, 0);
            break;
        }

        case 18: {   // Formes du programmeur
            static const int shapes[5] = {LS_SQUARE, LS_TRIANGLE, LS_STAR, LS_HEART, LS_CONE};
            lasers(G_PONT, [](LaserParams& p, LaserFixture&, int kg) {
                p.dimmer = 1;
                p.shape = shapes[kg % 5];
                p.traits = 0;
                p.opening = 20;
                p.branches = 5 + (kg % 3);
                p.gradient = LG_RAINBOW;
                p.gradient_speed = 0.2f;
                p.roll_speed = (kg & 1) ? 25.0f : -25.0f;
                p.tilt = 15;
            });
            laser_fx(G_PONT, LFX_CIRCLE, 5, 0.12f, 360);
            break;
        }

        case 19: {   // Coeurs qui battent
            r.floor_wet = 0.3f;
            lasers(G_PONT, [](LaserParams& p, LaserFixture&, int kg) {
                if (kg & 1) return;
                p.dimmer = 1;
                p.shape = LS_HEART;
                p.traits = 0;
                p.opening = 18;
                p.color = PINK;
                p.tilt = 15;
            });
            laser_fx(G_PONT, LFX_OPENING, 0.25f, 1.1f, 0);
            lyres(G_TRUSS, [](FixtureParams& p, Fixture& f, int kg) {
                if (kg % 3) return;
                p.dimmer = 1;
                p.color = PINK;
                p.gobo = 5;   // fleur
                p.gobo_speed = (kg & 1) ? 10.0f : -10.0f;
                p.zoom = 16;
                p.tilt = -5;
                p.focus = floor_focus(f, -5);
            });
            lyre_fx(G_TRUSS, FX_CIRCLE, 4, 0.05f, 360);
            break;
        }
    }
}

}  // namespace scenes
