// Panneau de controle (Dear ImGui).
#include "app.h"
#include "gpu_profiler.h"
#include "imgui.h"
#include "sokol_gfx.h"
#include <cstdio>

namespace {

// Applique un champ a toutes les lyres selectionnees.
#define APPLY(field, value) app.rig.for_selected([&](FixtureParams& q) { q.field = (value); })

struct Swatch {
    const char* name;
    vec3 c;
};
const Swatch SWATCHES[] = {
    {"Blanc", {1, 1, 1}},       {"Rouge", {1, 0, 0}},          {"Orange", {1, 0.35f, 0}},  {"Ambre", {1, 0.6f, 0.15f}},
    {"Jaune", {1, 0.9f, 0}},    {"Vert", {0, 1, 0.05f}},       {"Cyan", {0, 0.85f, 1}},    {"Bleu", {0.05f, 0.25f, 1}},
    {"Bleu nuit", {0, 0, 1}},   {"UV", {0.35f, 0, 1}},         {"Magenta", {1, 0, 0.8f}},  {"Rose", {1, 0.3f, 0.55f}},
    {"Chaud (CTO)", {1, 0.78f, 0.55f}},
};

void selection_ui() {
    Rig& rig = app.rig;
    ImGui::Text("Selection : %d / %d lyres", rig.selected_count(), (int)rig.fixtures.size());
    if (ImGui::Button("Toutes")) rig.select_all(true);
    ImGui::SameLine();
    if (ImGui::Button("Aucune")) rig.select_all(false);
    ImGui::SameLine();
    if (ImGui::Button("Inverser")) rig.invert_selection();
    ImGui::SameLine();
    if (ImGui::Button("1 sur 2 (paires)")) rig.select_odd_even(false);
    ImGui::SameLine();
    if (ImGui::Button("Impaires")) rig.select_odd_even(true);
    ImGui::TextDisabled("Groupes (Ctrl + clic pour ajouter) :");
    for (int g = 0; g < (int)app.scene.group_names.size(); g++) {
        if (g > 0 && g % 4 != 0) ImGui::SameLine();
        if (ImGui::Button(app.scene.group_names[g].c_str())) rig.select_group(g, ImGui::GetIO().KeyCtrl);
    }
    if (ImGui::TreeNode("Selection fine (une par une)")) {
        for (int g = 0; g < (int)app.scene.group_names.size(); g++) {
            ImGui::TextDisabled("%s", app.scene.group_names[g].c_str());
            int k = 0;
            for (size_t i = 0; i < rig.fixtures.size(); i++) {
                Fixture& f = rig.fixtures[i];
                if (f.mount.group != g) continue;
                if (k % 14 != 0) ImGui::SameLine();
                char id[32];
                std::snprintf(id, sizeof(id), "##f%d", (int)i);
                ImGui::PushStyleVar(ImGuiStyleVar_FramePadding, ImVec2(2, 2));
                ImGui::Checkbox(id, &f.selected);
                ImGui::PopStyleVar();
                if (ImGui::IsItemHovered()) ImGui::SetTooltip("Lyre %d", (int)i + 1);
                k++;
            }
        }
        ImGui::TreePop();
    }
}

void programmer_ui() {
    Rig& rig = app.rig;
    int first = rig.first_selected();
    if (first < 0) {
        ImGui::TextColored(ImVec4(1, 0.7f, 0.3f, 1), "Selectionnez des lyres pour les regler.");
        return;
    }
    FixtureParams p = rig.fixtures[first].base;   // valeurs affichees : la 1re lyre selectionnee

    ImGui::SeparatorText("Intensite");
    if (ImGui::SliderFloat("Dimmer", &p.dimmer, 0, 1)) APPLY(dimmer, p.dimmer);
    if (ImGui::SliderFloat("Strobe (Hz)", &p.strobe, 0, 25, p.strobe <= 0.05f ? "ouvert" : "%.1f Hz")) APPLY(strobe, p.strobe);
    if (ImGui::Button("Plein feu")) { APPLY(dimmer, 1.0f); APPLY(strobe, 0.0f); }
    ImGui::SameLine();
    if (ImGui::Button("Noir")) APPLY(dimmer, 0.0f);

    ImGui::SeparatorText("Couleur");
    float col[3] = {p.color.x, p.color.y, p.color.z};
    if (ImGui::ColorEdit3("Couleur", col)) APPLY(color, vec3(col[0], col[1], col[2]));
    for (int i = 0; i < (int)(sizeof(SWATCHES) / sizeof(SWATCHES[0])); i++) {
        if (i % 7 != 0) ImGui::SameLine();
        const vec3& c = SWATCHES[i].c;
        if (ImGui::ColorButton(SWATCHES[i].name, ImVec4(c.x, c.y, c.z, 1), 0, ImVec2(26, 20))) APPLY(color, c);
    }

    ImGui::SeparatorText("Position");
    if (ImGui::SliderFloat("Pan", &p.pan, -270, 270, "%.0f deg")) { APPLY(pan, p.pan); APPLY(aim_point, -1); }
    if (ImGui::SliderFloat("Tilt", &p.tilt, -135, 135, "%.0f deg")) { APPLY(tilt, p.tilt); APPLY(aim_point, -1); }
    if (ImGui::Button("Home (0 / 0)")) rig.home_selected();

    ImGui::SeparatorText("Faisceau");
    if (ImGui::SliderFloat("Zoom", &p.zoom, 1.5f, 50, "%.1f deg")) APPLY(zoom, p.zoom);
    if (ImGui::SliderFloat("Mise au point", &p.focus, 1, 80, "%.1f m")) APPLY(focus, p.focus);
    if (ImGui::SliderFloat("Frost", &p.frost, 0, 1)) APPLY(frost, p.frost);
    if (ImGui::SliderFloat("Iris", &p.iris, 0.05f, 1)) APPLY(iris, p.iris);

    ImGui::SeparatorText("Gobo");
    if (ImGui::Combo("Gobo", &p.gobo, GOBO_NAMES, NUM_GOBOS)) APPLY(gobo, p.gobo);
    if (ImGui::SliderFloat("Angle gobo", &p.gobo_angle, -180, 180, "%.0f deg")) APPLY(gobo_angle, p.gobo_angle);
    if (ImGui::SliderFloat("Rotation gobo", &p.gobo_speed, -360, 360, "%.0f deg/s")) APPLY(gobo_speed, p.gobo_speed);

    ImGui::SeparatorText("Prisme");
    if (ImGui::Combo("Prisme", &p.prism, PRISM_NAMES, PRISM_COUNT)) APPLY(prism, p.prism);
    if (ImGui::SliderFloat("Ecartement", &p.prism_spread, 0.2f, 2.5f)) APPLY(prism_spread, p.prism_spread);
    if (ImGui::SliderFloat("Rotation prisme", &p.prism_speed, -360, 360, "%.0f deg/s")) APPLY(prism_speed, p.prism_speed);
}

void aim_ui() {
    Rig& rig = app.rig;
    ImGui::SeparatorText("Points de visee");
    for (int i = 0; i < 4; i++) {
        ImGui::PushID(i);
        char label[32];
        std::snprintf(label, sizeof(label), "P%d", i + 1);
        ImGui::SetNextItemWidth(200);
        ImGui::DragFloat3(label, &rig.aim_points[i].x, 0.1f);
        ImGui::SameLine();
        if (ImGui::Button(app.pick_aim == i ? "Cliquez dans la scene..." : "Placer a la souris")) app.pick_aim = i;
        ImGui::SameLine();
        if (ImGui::Button("Viser")) APPLY(aim_point, i);
        ImGui::PopID();
    }
    if (ImGui::Button("Arreter la visee (selection)")) APPLY(aim_point, -1);
}

void rig_global_ui() {
    Rig& rig = app.rig;
    ImGui::SeparatorText("Toutes les lyres");
    ImGui::SliderFloat("Grand master", &rig.master, 0, 1);
    ImGui::SliderFloat("Puissance", &rig.power, 0.05f, 4.0f, "x %.2f");
    ImGui::SliderFloat("Diametre de la lentille", &rig.lens_diameter, 0.02f, 0.5f, "%.2f m");
    ImGui::SliderFloat("Vitesse pan", &rig.pan_speed, 30, 600, "%.0f deg/s");
    ImGui::SliderFloat("Vitesse tilt", &rig.tilt_speed, 30, 600, "%.0f deg/s");
    ImGui::SliderFloat("Acceleration", &rig.accel, 100, 4000, "%.0f deg/s2");
    ImGui::Checkbox("Mouvements instantanes", &rig.instant_moves);
}

void effects_ui() {
    Rig& rig = app.rig;
    static int new_type = 0;
    ImGui::SetNextItemWidth(220);
    ImGui::Combo("##type", &new_type, EFFECT_NAMES, FX_COUNT);
    ImGui::SameLine();
    if (ImGui::Button("Ajouter sur la selection")) {
        if (rig.selected_count() > 0) rig.add_effect(new_type);
    }
    if (rig.selected_count() == 0) ImGui::TextDisabled("(selectionnez des lyres d'abord)");
    if (ImGui::Button("Supprimer tous les effets")) rig.effects.clear();

    int remove = -1;
    for (int i = 0; i < (int)rig.effects.size(); i++) {
        Effect& e = rig.effects[i];
        ImGui::PushID(i);
        char title[96];
        std::snprintf(title, sizeof(title), "%s  (%d lyres)###fx", e.name.c_str(), (int)e.fixtures.size());
        bool open = ImGui::CollapsingHeader(title, ImGuiTreeNodeFlags_DefaultOpen);
        if (open) {
            ImGui::Checkbox("Actif", &e.enabled);
            ImGui::SameLine();
            if (ImGui::Button("Reprendre la selection")) {
                e.fixtures.clear();
                for (size_t k = 0; k < rig.fixtures.size(); k++) if (rig.fixtures[k].selected) e.fixtures.push_back((int)k);
            }
            ImGui::SameLine();
            if (ImGui::Button("Supprimer")) remove = i;
            ImGui::Combo("Forme", &e.wave, WAVE_NAMES, WAVE_COUNT);
            ImGui::SliderFloat("Vitesse", &e.speed, 0, 3, "%.2f cycle/s");
            bool movement = e.type <= FX_FAN;
            if (movement) ImGui::SliderFloat("Amplitude", &e.size, 0, 120, "%.0f deg");
            else if (e.type != FX_COLOR_ALT) ImGui::SliderFloat("Amplitude", &e.size, 0, 1);
            ImGui::SliderFloat("Decalage", &e.spread, 0, 720, "%.0f deg");
            ImGui::SliderInt("Ailes", &e.wings, 1, 8);
            if (e.wave == WAVE_SQUARE) ImGui::SliderFloat("Rapport cyclique", &e.duty, 0.05f, 0.95f);
            if (e.type == FX_COLOR_ALT) {
                ImGui::ColorEdit3("Couleur A", &e.color_a.x);
                ImGui::ColorEdit3("Couleur B", &e.color_b.x);
            }
        }
        ImGui::PopID();
    }
    if (remove >= 0) rig.effects.erase(rig.effects.begin() + remove);
}

void fog_ui() {
    FogSettings& f = app.fog_settings;
    ImGui::SeparatorText("Fumee");
    ImGui::SliderFloat("Densite globale", &f.density, 0, 0.2f, "%.3f");
    ImGui::SliderFloat("Brume de fond (hazer)", &f.haze, 0, 1.5f);
    ImGui::SliderFloat("Amas de fumee", &f.smoke, 0, 3);
    ImGui::SliderFloat("Volutes fines", &f.detail_strength, 0, 1);
    ImGui::SliderFloat("Taille des volutes", &f.detail_scale, 1, 25, "%.1f m");
    ImGui::SliderFloat("Plus dense en bas", &f.height_falloff, 0, 0.15f, "%.3f");
    ImGui::SliderFloat("Diffusion vers l'avant", &f.anisotropy, 0, 0.9f);
    ImGui::SliderFloat("Albedo de la fumee", &f.scattering, 0.1f, 1);
    ImGui::SeparatorText("Mouvement");
    ImGui::Checkbox("Animer la fumee", &f.animate);
    ImGui::SliderFloat("Vent", &f.wind_speed, 0, 3, "%.2f m/s");
    ImGui::SliderFloat("Direction du vent", &f.wind_angle, -180, 180, "%.0f deg");
    ImGui::SliderFloat("Turbulence", &f.turbulence, 0, 3, "%.2f m/s");
    ImGui::SliderFloat("Montee (chaleur)", &f.rise, -0.3f, 0.5f, "%.2f m/s");
    ImGui::SliderFloat("Dissipation", &f.dissipation, 0, 0.1f, "%.3f /s");
    ImGui::SeparatorText("Machines a fumee");
    ImGui::SliderFloat("Debit", &f.machine_output, 0, 4);
    for (size_t i = 0; i < app.fog.machines.size(); i++) {
        char label[48];
        vec3 p = app.fog.machines[i].pos;
        std::snprintf(label, sizeof(label), "Machine %d (%.0f, %.0f)", (int)i + 1, p.x, p.z);
        ImGui::Checkbox(label, &app.fog.machines[i].on);
    }
    if (ImGui::Button("Remplir la salle")) app.fog.prefill();
    ImGui::SameLine();
    if (ImGui::Button("Vider (aerer)")) app.fog.clear();
}

void render_ui() {
    RenderSettings& r = app.rs;
    const Timings& t = app.timings;
    const RenderStats& s = app.renderer.stats;
    ImGui::Text("%.1f images/s  (%.2f ms)", t.fps, t.frame_ms);
    ImGui::Text("CPU : lyres %.2f ms, fumee %.2f ms, envoi GPU %.2f ms, UI %.2f ms", t.rig_ms, t.fog_ms, t.render_cpu_ms, t.ui_ms);
    ImGui::Text("Rendu %d x %d, fumee %d x %d", s.internal_w, s.internal_h, s.vol_w, s.vol_h);
    ImGui::Text("Faisceaux allumes : %d, lumieres indirectes : %d", s.lights, s.vpls);
    const char* backends[] = {"OpenGL", "OpenGL ES", "Direct3D 11", "Metal (iOS)", "Metal (macOS)", "Metal (sim)", "WebGPU", "Vulkan", "aucun"};
    int b = (int)sg_query_backend();
    ImGui::Text("API graphique : %s", (b >= 0 && b < 9) ? backends[b] : "?");
    if (gpuprof::available()) {
        ImGui::SeparatorText("Temps GPU par passe");
        // valeurs lissees pour qu'elles restent lisibles
        static float smooth[32] = {};
        static float smooth_total = 0;
        const std::vector<gpuprof::Section>& secs = gpuprof::last();
        for (size_t i = 0; i < secs.size() && i < 32; i++) {
            smooth[i] = smooth[i] * 0.9f + secs[i].ms * 0.1f;
            ImGui::Text("%-26s %6.2f ms", secs[i].name, smooth[i]);
        }
        smooth_total = smooth_total * 0.9f + gpuprof::last_total_ms() * 0.1f;
        ImGui::Text("%-26s %6.2f ms", "total GPU", smooth_total);
    } else {
        ImGui::TextDisabled("Temps GPU par passe : Direct3D 11 seulement.");
    }

    ImGui::SeparatorText("Qualite");
    ImGui::Checkbox("Qualite adaptative (tient la cadence)", &r.adaptive);
    ImGui::SameLine();
    ImGui::TextDisabled("%.0f %%", s.quality * 100.0f);
    ImGui::SliderFloat("Cadence visee", &r.target_fps, 30, 240, "%.0f img/s");
    ImGui::SliderFloat("Resolution interne", &r.render_scale, 0.25f, 1.0f, "x %.2f");
    ImGui::Checkbox("Taches de lumiere sur les surfaces", &r.surface_lights);
    ImGui::Checkbox("Reflets brillants", &r.specular);
    ImGui::Checkbox("Lyres tres douces (frost) eclairees a 1/4 de la resolution", &r.soft_lights);
    ImGui::SameLine();
    ImGui::TextDisabled("(%d)", s.soft_lights);
    ImGui::Checkbox("Pre-passe de profondeur (plus rapide, meme image)", &r.depth_prepass);
    ImGui::Checkbox("Faisceaux dans la fumee", &r.volumetrics);
    ImGui::Checkbox("Fumee : calcul analytique (sans bruit, rapide)", &r.analytic_beams);
    ImGui::Checkbox("Fumee : faisceaux doux a plus basse resolution", &r.beam_tiers);
    ImGui::Text("Faisceaux par resolution : %d (1) / %d (1/2) / %d (1/4)", s.tier_count[0], s.tier_count[1], s.tier_count[2]);
    ImGui::SliderInt("Fumee : diviseur de resolution", &r.vol_div, 1, 4);
    ImGui::SliderInt("Fumee : echantillons par faisceau", &r.vol_samples, 2, 32);
    ImGui::Checkbox("Accumulation temporelle", &r.temporal);
    ImGui::SliderFloat("Poids de l'historique", &r.temporal_weight, 0, 0.97f);
    ImGui::Checkbox("Lumiere indirecte (rebonds)", &r.gi);
    ImGui::SliderFloat("Force des rebonds", &r.gi_strength, 0, 4);
    ImGui::SliderFloat("Rebonds dans la fumee", &r.gi_fog, 0, 4);
    ImGui::Checkbox("Bloom (halo)", &r.bloom);
    ImGui::SliderFloat("Force du bloom", &r.bloom_strength, 0, 0.3f);
    ImGui::Checkbox("Ombres des obstacles (exactes)", &r.shadows);
    ImGui::SameLine();
    ImGui::TextDisabled("(%d lyres)", s.occluded_lights);
    ImGui::Checkbox("Sol en beton texture", &r.floor_texture);
    if (!app.floor.ok) {
        ImGui::SameLine();
        ImGui::TextDisabled("(texture absente)");
    }
    ImGui::SliderFloat("Eau au sol", &r.floor_wet, 0, 1, r.floor_wet <= 0.001f ? "sec" : "%.2f");
    ImGui::Checkbox("Afficher les lyres", &r.show_fixtures);
    ImGui::SliderFloat("Eclat des lentilles", &r.lens_glow, 0, 4);
    ImGui::SeparatorText("Image");
    ImGui::SliderFloat("Exposition", &r.exposure, 0.05f, 8, "%.2f", ImGuiSliderFlags_Logarithmic);
    ImGui::SliderFloat("Lumiere ambiante", &r.ambient, 0, 0.05f, "%.4f", ImGuiSliderFlags_Logarithmic);
    ImGui::SliderFloat("Portee des faisceaux", &r.beam_range, 10, 160, "%.0f m");
}

void help_ui() {
    ImGui::TextWrapped("Camera : clic droit maintenu pour regarder, W A S D (Z Q S D en AZERTY) ou fleches pour avancer, "
                       "Espace / E pour monter, C / A(Q) pour descendre, Maj pour aller vite, molette pour la vitesse.");
    ImGui::TextWrapped("F : mode personnage (vue a la 3e personne, Espace pour sauter). H : cacher le panneau. P : pause.");
    ImGui::SliderFloat("Vitesse camera", &app.move_speed, 0.5f, 80, "%.1f m/s");
    ImGui::SliderFloat("Champ de vision", &app.cam.fovy, 20 * DEG, 100 * DEG, "%.2f rad");
    ImGui::Checkbox("Mode personnage", &app.character);
    ImGui::Checkbox("Pause (effets + fumee)", &app.paused);
}

}  // namespace

void draw_ui() {
    ImGui::SetNextWindowPos(ImVec2(10, 10), ImGuiCond_FirstUseEver);
    ImGui::SetNextWindowSize(ImVec2(470, 760), ImGuiCond_FirstUseEver);
    ImGui::Begin("LyreViz");
    ImGui::Text("%.0f img/s", app.timings.fps);
    ImGui::SameLine();
    ImGui::TextDisabled("| H : cacher | F : personnage | clic droit : regarder");
    if (ImGui::BeginTabBar("tabs")) {
        if (ImGui::BeginTabItem("Lyres")) {
            selection_ui();
            programmer_ui();
            aim_ui();
            rig_global_ui();
            ImGui::EndTabItem();
        }
        if (ImGui::BeginTabItem("Effets")) {
            effects_ui();
            ImGui::EndTabItem();
        }
        if (ImGui::BeginTabItem("Fumee")) {
            fog_ui();
            ImGui::EndTabItem();
        }
        if (ImGui::BeginTabItem("Rendu")) {
            render_ui();
            ImGui::EndTabItem();
        }
        if (ImGui::BeginTabItem("Aide")) {
            help_ui();
            ImGui::EndTabItem();
        }
        ImGui::EndTabBar();
    }
    ImGui::End();
}
