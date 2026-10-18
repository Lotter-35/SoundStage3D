// Panneau de controle (Dear ImGui).
#include "ambiances.h"
#include "app.h"
#include "gpu_profiler.h"
#include "imgui.h"
#include "sokol_gfx.h"
#include "spectacles.h"
#include <algorithm>
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

// ---------------------------------------------------------------------------------------------
//  Selection a l'ecran (debug) : reperes autour des appareils selectionnes, rectangle, pas a pas
// ---------------------------------------------------------------------------------------------

// Position a l'ecran (coordonnees de l'interface) d'un point de la scene, et pixels par metre a sa distance.
// Faux s'il est derriere la camera.
bool to_screen(vec3 p, ImVec2& out, float& px_per_m) {
    const Camera& c = app.cam;
    const ImVec2 ds = ImGui::GetIO().DisplaySize;
    const vec3 d = p - c.pos;
    const float z = dot(d, c.fwd);
    if (z < 0.2f || ds.y <= 0) return false;
    const float tanY = std::tan(c.fovy * 0.5f), tanX = tanY * ds.x / ds.y;
    out = ImVec2((0.5f + 0.5f * dot(d, c.right) / (z * tanX)) * ds.x, (0.5f - 0.5f * dot(d, c.up) / (z * tanY)) * ds.y);
    px_per_m = 0.5f * ds.y / (z * tanY);
    return true;
}

vec3 fixture_pos(const Fixture& f) { return f.head_center; }
vec3 fixture_pos(const LaserFixture& f) { return f.mount.pos; }

// Selectionne seulement l'appareil suivant (dir = 1) ou precedent (-1) ; s'il n'y en a pas exactement un de
// selectionne, part du premier (ou du dernier).
template <typename T> void step_selection(std::vector<T>& v, int dir) {
    const int n = (int)v.size();
    if (n == 0) return;
    int cur = -1, count = 0;
    for (int i = 0; i < n; i++)
        if (v[i].selected) {
            if (count == 0) cur = i;
            count++;
        }
    const int next = count == 1 ? (cur + dir + n) % n : (dir > 0 ? 0 : n - 1);
    for (T& f : v) f.selected = false;
    v[next].selected = true;
}

template <typename T> void step_ui(std::vector<T>& v, const char* what, const std::vector<std::string>& groups) {
    ImGui::PushID(what);
    if (ImGui::Button("< Precedent")) step_selection(v, -1);
    ImGui::SameLine();
    if (ImGui::Button("Suivant >")) step_selection(v, 1);
    int one = -1, count = 0;
    for (int i = 0; i < (int)v.size(); i++)
        if (v[i].selected) { one = i; count++; }
    ImGui::SameLine();
    if (count == 1) {
        const int g = v[one].mount.group;
        ImGui::Text("%s %d / %d (%s)", what, one + 1, (int)v.size(), g >= 0 && g < (int)groups.size() ? groups[g].c_str() : "?");
    } else {
        ImGui::TextDisabled("(un seul a la fois)");
    }
    ImGui::TextDisabled("Dans la scene : clic = un seul, glisser = rectangle (Ctrl ajoute, Maj retire), Ctrl + clic = ajoute ou retire.");
    ImGui::PopID();
}

// Rectangle (ou clic) : appareils dont le centre tombe dedans (le plus proche du clic pour un clic).
template <typename T> void pick(std::vector<T>& v, int mode) {
    const float x0 = std::min(app.sel_x0, app.sel_x1), x1 = std::max(app.sel_x0, app.sel_x1);
    const float y0 = std::min(app.sel_y0, app.sel_y1), y1 = std::max(app.sel_y0, app.sel_y1);
    const bool click = x1 - x0 < 5 && y1 - y0 < 5;
    int best = -1;
    float best_d = 1e30f;
    std::vector<char> hit(v.size(), 0);
    for (int i = 0; i < (int)v.size(); i++) {
        ImVec2 p;
        float k;
        if (!to_screen(fixture_pos(v[i]), p, k)) continue;
        if (click) {
            const float r = std::max(14.0f, 0.4f * k);
            const float dx = p.x - app.sel_x1, dy = p.y - app.sel_y1, d = dx * dx + dy * dy;
            if (d < r * r && d < best_d) { best_d = d; best = i; }
        } else {
            hit[i] = p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
        }
    }
    if (click && best >= 0) {
        hit[best] = 1;
        if (mode == 1) {   // Ctrl + clic : ajoute ou retire celui-la
            v[best].selected = !v[best].selected;
            return;
        }
    }
    for (int i = 0; i < (int)v.size(); i++) {
        if (mode == 0) v[i].selected = hit[i] != 0;
        else if (hit[i]) v[i].selected = mode == 1;
    }
}

// Reperes : cadre autour de chaque appareil selectionne (lyres en jaune, lasers en vert d'eau), avec son numero
// s'il y en a peu ; petit point sur les autres quand leur onglet est ouvert.
template <typename T> void overlay(const std::vector<T>& v, float size_m, ImU32 col) {
    ImDrawList* dl = ImGui::GetBackgroundDrawList();
    int count = 0;
    for (const T& f : v) count += f.selected ? 1 : 0;
    for (int i = 0; i < (int)v.size(); i++) {
        const T& f = v[i];
        ImVec2 p;
        float k;
        if (!to_screen(fixture_pos(f), p, k)) continue;
        if (f.selected) {
            const float h = clampf(size_m * k, 5.0f, 80.0f);
            dl->AddRect(ImVec2(p.x - h - 1, p.y - h - 1), ImVec2(p.x + h + 1, p.y + h + 1), IM_COL32(0, 0, 0, 200), 0, 0, 3.0f);
            dl->AddRect(ImVec2(p.x - h, p.y - h), ImVec2(p.x + h, p.y + h), col, 0, 0, 1.5f);
            if (count <= 24) {
                char t[16];
                std::snprintf(t, sizeof(t), "%d", i + 1);
                dl->AddText(ImVec2(p.x + h + 3, p.y - h - 2), IM_COL32(0, 0, 0, 255), t);
                dl->AddText(ImVec2(p.x + h + 2, p.y - h - 3), col, t);
            }
        } else {
            dl->AddCircleFilled(p, 2.0f, (col & 0x00FFFFFFu) | 0x70000000u);
        }
    }
}

void selection_overlay() {
    // seulement les appareils de l'onglet ouvert (Lyres ou Lasers), rien ailleurs
    if (app.sel_kind == 0) overlay(app.rig.fixtures, 0.45f, IM_COL32(255, 210, 0, 255));
    if (app.sel_kind == 1) overlay(app.lasers.fixtures, 0.3f, IM_COL32(0, 255, 170, 255));
    if (app.sel_drag) {
        ImDrawList* dl = ImGui::GetForegroundDrawList();
        const ImVec2 a(std::min(app.sel_x0, app.sel_x1), std::min(app.sel_y0, app.sel_y1));
        const ImVec2 b(std::max(app.sel_x0, app.sel_x1), std::max(app.sel_y0, app.sel_y1));
        dl->AddRectFilled(a, b, IM_COL32(120, 200, 255, 40));
        dl->AddRect(a, b, IM_COL32(120, 200, 255, 220), 0, 0, 1.5f);
    }
}

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
    step_ui(rig.fixtures, "Lyre", app.scene.group_names);
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

// ---------------------------------------------------------------------------------------------
//  Onglet Lasers : selection, programmeur, effets, boitiers (meme organisation que les lyres)
// ---------------------------------------------------------------------------------------------
#define LAPPLY(field, value) app.lasers.for_selected([&](LaserParams& q) { q.field = (value); })

const Swatch LASER_SWATCHES[] = {
    {"Rouge", {1, 0, 0}},   {"Orange", {1, 0.35f, 0}}, {"Jaune", {1, 0.85f, 0}}, {"Vert", {0, 1, 0}},
    {"Cyan", {0, 1, 1}},    {"Bleu", {0, 0.25f, 1}},   {"Violet", {0.6f, 0, 1}}, {"Magenta", {1, 0, 1}},
    {"Blanc", {1, 1, 1}},
};

void laser_selection_ui() {
    LaserRig& lr = app.lasers;
    ImGui::Text("Selection : %d / %d lasers", lr.selected_count(), (int)lr.fixtures.size());
    if (ImGui::Button("Tous##l")) lr.select_all(true);
    ImGui::SameLine();
    if (ImGui::Button("Aucun##l")) lr.select_all(false);
    ImGui::SameLine();
    if (ImGui::Button("Inverser##l")) lr.invert_selection();
    ImGui::SameLine();
    if (ImGui::Button("1 sur 2 (paires)##l")) lr.select_odd_even(false);
    ImGui::SameLine();
    if (ImGui::Button("Impaires##l")) lr.select_odd_even(true);
    step_ui(lr.fixtures, "Laser", lr.group_names);
    ImGui::TextDisabled("Groupes (Ctrl + clic pour ajouter) :");
    for (int g = 0; g < (int)lr.group_names.size(); g++) {
        if (g > 0 && g % 4 != 0) ImGui::SameLine();
        char id[64];
        std::snprintf(id, sizeof(id), "%s##lg", lr.group_names[g].c_str());
        if (ImGui::Button(id)) lr.select_group(g, ImGui::GetIO().KeyCtrl);
    }
    if (ImGui::TreeNode("Selection fine (un par un)##l")) {
        for (int g = 0; g < (int)lr.group_names.size(); g++) {
            ImGui::TextDisabled("%s", lr.group_names[g].c_str());
            int k = 0;
            for (size_t i = 0; i < lr.fixtures.size(); i++) {
                LaserFixture& f = lr.fixtures[i];
                if (f.mount.group != g) continue;
                if (k % 14 != 0) ImGui::SameLine();
                char id[32];
                std::snprintf(id, sizeof(id), "##lf%d", (int)i);
                ImGui::PushStyleVar(ImGuiStyleVar_FramePadding, ImVec2(2, 2));
                ImGui::Checkbox(id, &f.selected);
                ImGui::PopStyleVar();
                if (ImGui::IsItemHovered()) ImGui::SetTooltip("Laser %d", (int)i + 1);
                k++;
            }
        }
        ImGui::TreePop();
    }
}

void laser_programmer_ui() {
    LaserRig& lr = app.lasers;
    const int first = lr.first_selected();
    if (first < 0) {
        ImGui::TextColored(ImVec4(1, 0.7f, 0.3f, 1), "Selectionnez des lasers pour les regler.");
        return;
    }
    LaserParams p = lr.fixtures[first].base;   // valeurs affichees : le 1er laser selectionne

    ImGui::SeparatorText("Intensite##l");
    if (ImGui::SliderFloat("Dimmer##l", &p.dimmer, 0, 1)) LAPPLY(dimmer, p.dimmer);
    if (ImGui::SliderFloat("Strobe (Hz)##l", &p.strobe, 0, 25, p.strobe <= 0.05f ? "ouvert" : "%.1f Hz")) LAPPLY(strobe, p.strobe);
    if (ImGui::Button("Plein feu##l")) { LAPPLY(dimmer, 1.0f); LAPPLY(strobe, 0.0f); }
    ImGui::SameLine();
    if (ImGui::Button("Noir##l")) LAPPLY(dimmer, 0.0f);

    ImGui::SeparatorText("Couleur##l");
    if (ImGui::ColorEdit3("Couleur##l", &p.color.x)) LAPPLY(color, p.color);
    for (int i = 0; i < (int)(sizeof(LASER_SWATCHES) / sizeof(LASER_SWATCHES[0])); i++) {
        if (i % 9 != 0) ImGui::SameLine();
        const vec3& c = LASER_SWATCHES[i].c;
        char id[48];
        std::snprintf(id, sizeof(id), "%s##ls", LASER_SWATCHES[i].name);
        if (ImGui::ColorButton(id, ImVec4(c.x, c.y, c.z, 1), 0, ImVec2(26, 20))) LAPPLY(color, c);
    }
    if (ImGui::Combo("Degrade##l", &p.gradient, LASER_GRADIENT_NAMES, LG_COUNT)) LAPPLY(gradient, p.gradient);
    if (p.gradient == LG_TWO || p.gradient == LG_THREE || p.gradient == LG_SCROLL)
        if (ImGui::ColorEdit3("Couleur 2##l", &p.color2.x)) LAPPLY(color2, p.color2);
    if (p.gradient == LG_THREE)
        if (ImGui::ColorEdit3("Couleur 3##l", &p.color3.x)) LAPPLY(color3, p.color3);
    if (p.gradient == LG_SCROLL || p.gradient == LG_RAINBOW)
        if (ImGui::SliderFloat("Defilement##l", &p.gradient_speed, -2, 2, "%.2f cycle/s")) LAPPLY(gradient_speed, p.gradient_speed);

    ImGui::SeparatorText("Figure##l");
    static const char* SOURCES[] = {"Programmeur (formes)", "Fichier ILDA"};
    if (ImGui::Combo("Source##l", &p.source, SOURCES, 2)) LAPPLY(source, p.source);
    if (p.source == 1) {
        // fichier ILDA : bibliotheque server/storage/ilda (une banque par sous-dossier)
        IldaLibrary& lib = lr.ilda;
        if (lib.clips.empty()) {
            ImGui::TextColored(ImVec4(1, 0.7f, 0.3f, 1), "Aucun fichier ILDA (server/storage/ilda introuvable ; option --ilda dossier).");
        } else {
            const char* cur = p.ilda_clip >= 0 && p.ilda_clip < (int)lib.labels.size() ? lib.labels[p.ilda_clip].c_str() : "(aucun)";
            if (ImGui::BeginCombo("Fichier##l", cur)) {
                std::string bank = "\x01";
                for (int i = 0; i < (int)lib.clips.size(); i++) {
                    if (lib.clips[i].bank != bank) {
                        bank = lib.clips[i].bank;
                        ImGui::SeparatorText(bank.empty() ? "(racine)" : bank.c_str());
                    }
                    char id[160];
                    std::snprintf(id, sizeof(id), "%s##ilda%d", lib.clips[i].name.c_str(), i);
                    if (ImGui::Selectable(id, i == p.ilda_clip)) LAPPLY(ilda_clip, i);
                }
                ImGui::EndCombo();
            }
            if (ImGui::Button("< Fichier precedent##l")) LAPPLY(ilda_clip, std::max(0, p.ilda_clip - 1));
            ImGui::SameLine();
            if (ImGui::Button("Fichier suivant >##l")) LAPPLY(ilda_clip, std::min((int)lib.clips.size() - 1, p.ilda_clip + 1));
        }
        static const char* PLAY[] = {"Boucle", "Aller-retour", "Image fixe"};
        if (ImGui::Combo("Lecture##l", &p.ilda_play, PLAY, 3)) LAPPLY(ilda_play, p.ilda_play);
        if (p.ilda_play == 2) {
            if (ImGui::SliderInt("Image##l", &p.ilda_frame, 0, 500)) LAPPLY(ilda_frame, p.ilda_frame);
        } else if (ImGui::SliderFloat("Cadence##l", &p.ilda_fps, 1, 60, "%.0f images/s")) {
            LAPPLY(ilda_fps, p.ilda_fps);
        }
        if (ImGui::Checkbox("Couleurs du fichier (sinon : couleur du laser)##l", &p.ilda_colors)) LAPPLY(ilda_colors, p.ilda_colors);
        if (ImGui::SliderFloat("Taille##l", &p.opening, 0, lr.max_angle, "%.1f deg")) LAPPLY(opening, p.opening);
        ImGui::TextDisabled("(%d points, %d faisceaux, %d droites, %d arcs pour tous les lasers ILDA ; tolerance %d)", lr.ilda_points,
                            lr.ilda_beams, lr.ilda_sheets, lr.ilda_arcs, lr.ilda_bias);
    } else {
    if (ImGui::Combo("Forme##l", &p.shape, LASER_SHAPE_NAMES, LS_COUNT)) LAPPLY(shape, p.shape);
    if (ImGui::SliderFloat("Ouverture##l", &p.opening, 0, lr.max_angle, p.opening <= 0.05f ? "un point" : "%.1f deg")) LAPPLY(opening, p.opening);
    if (ImGui::SliderInt("Traits##l", &p.traits, 0, 2000, p.traits <= 0 ? "nappe continue (ligne)" : "%d", ImGuiSliderFlags_Logarithmic))
        LAPPLY(traits, p.traits);
    ImGui::SameLine();
    if (ImGui::Button("Ligne##l")) LAPPLY(traits, 0);
    if (p.shape == LS_DOUBLE_FAN && ImGui::SliderFloat("Ecart des deux eventails##l", &p.shape_param, 0, 40, "%.1f deg")) LAPPLY(shape_param, p.shape_param);
    if (p.shape == LS_WAVE) {
        if (ImGui::SliderFloat("Amplitude de la vague##l", &p.shape_param, 0, 20, "%.1f deg")) LAPPLY(shape_param, p.shape_param);
        if (ImGui::SliderFloat("Ondulations##l", &p.wave_cycles, 0.5f, 6, "%.1f")) LAPPLY(wave_cycles, p.wave_cycles);
    }
    if (p.shape == LS_GRID) {
        int rows = (int)std::lround(p.shape_param);
        if (ImGui::SliderInt("Rangees##l", &rows, 2, 16)) LAPPLY(shape_param, (float)rows);
    }
    if (p.shape == LS_STAR && ImGui::SliderInt("Branches de l'etoile##l", &p.branches, 3, 12)) LAPPLY(branches, p.branches);
    }
    static const char* DIFF_NAMES[] = {"aucun", "x3", "x5", "x9"};
    int di = p.diffraction >= 9 ? 3 : (p.diffraction >= 5 ? 2 : (p.diffraction >= 3 ? 1 : 0));
    if (ImGui::Combo("Reseau de diffraction##l", &di, DIFF_NAMES, 4)) {
        static const int DV[] = {1, 3, 5, 9};
        LAPPLY(diffraction, DV[di]);
    }
    if (p.diffraction > 1 && ImGui::SliderFloat("Ecart des copies##l", &p.diffraction_angle, 1, 30, "%.1f deg")) LAPPLY(diffraction_angle, p.diffraction_angle);

    ImGui::SeparatorText("Position##l");
    const float hf = 0.5f * lr.max_angle;
    if (ImGui::SliderFloat("Pan##l", &p.pan, -hf, hf, "%.1f deg")) LAPPLY(pan, p.pan);
    if (ImGui::SliderFloat("Tilt##l", &p.tilt, -hf, hf, "%.1f deg")) LAPPLY(tilt, p.tilt);
    if (ImGui::SliderFloat("Roulis##l", &p.roll, -180, 180, "%.0f deg")) LAPPLY(roll, p.roll);
    if (ImGui::SliderFloat("Rotation continue##l", &p.roll_speed, -360, 360, "%.0f deg/s")) LAPPLY(roll_speed, p.roll_speed);
    if (ImGui::Button("Centre (0 / 0 / 0)##l")) { LAPPLY(pan, 0.0f); LAPPLY(tilt, 0.0f); LAPPLY(roll, 0.0f); LAPPLY(roll_speed, 0.0f); }
}

void laser_effects_ui() {
    LaserRig& lr = app.lasers;
    static int new_type = 0;
    ImGui::SetNextItemWidth(220);
    ImGui::Combo("##ltype", &new_type, LASER_EFFECT_NAMES, LFX_COUNT);
    ImGui::SameLine();
    if (ImGui::Button("Ajouter sur la selection##l")) {
        if (lr.selected_count() > 0) lr.add_effect(new_type);
    }
    if (lr.selected_count() == 0) ImGui::TextDisabled("(selectionnez des lasers d'abord)");
    if (ImGui::Button("Supprimer tous les effets##l")) lr.effects.clear();
    int remove = -1;
    for (int i = 0; i < (int)lr.effects.size(); i++) {
        Effect& e = lr.effects[i];
        ImGui::PushID(1000 + i);
        char title[96];
        std::snprintf(title, sizeof(title), "%s  (%d lasers)###lfx", e.name.c_str(), (int)e.fixtures.size());
        if (ImGui::CollapsingHeader(title, ImGuiTreeNodeFlags_DefaultOpen)) {
            ImGui::Checkbox("Actif", &e.enabled);
            ImGui::SameLine();
            if (ImGui::Button("Reprendre la selection")) {
                e.fixtures.clear();
                for (size_t k = 0; k < lr.fixtures.size(); k++) if (lr.fixtures[k].selected) e.fixtures.push_back((int)k);
            }
            ImGui::SameLine();
            if (ImGui::Button("Supprimer")) remove = i;
            ImGui::Combo("Forme", &e.wave, WAVE_NAMES, WAVE_COUNT);
            ImGui::SliderFloat("Vitesse", &e.speed, 0, 3, "%.2f cycle/s");
            const float amax = laser_effect_angle_max(e.type);
            if (amax > 0) ImGui::SliderFloat("Amplitude", &e.size, 0, amax, "%.0f deg");
            else if (e.type == LFX_TRAIT_CHASE || e.type == LFX_BOUNCE) ImGui::SliderFloat("Largeur de la vague", &e.size, 0.02f, 1);
            else if (e.type == LFX_SPARKLE) ImGui::SliderFloat("Part des lasers allumes", &e.size, 0, 1);
            else if (e.type == LFX_CONVERGE) {
                ImGui::SliderFloat("Rayon du cercle", &e.size, 0, 10, "%.1f m");
                ImGui::DragFloat3("Point vise (m)", &e.color_a.x, 0.1f);
            }
            else if (e.type != LFX_COLOR_ALT && e.type != LFX_PALETTE) ImGui::SliderFloat("Amplitude", &e.size, 0, 1);
            ImGui::SliderFloat("Decalage", &e.spread, 0, 720, "%.0f deg");
            ImGui::SliderInt("Ailes", &e.wings, 1, 8);
            if (e.wave == WAVE_SQUARE || e.type == LFX_SPARKLE) ImGui::SliderFloat("Rapport cyclique", &e.duty, 0.05f, 0.95f);
            if (e.type == LFX_COLOR_ALT) {
                ImGui::ColorEdit3("Couleur A", &e.color_a.x);
                ImGui::ColorEdit3("Couleur B", &e.color_b.x);
            }
        }
        ImGui::PopID();
    }
    if (remove >= 0) lr.effects.erase(lr.effects.begin() + remove);
}

void laser_global_ui() {
    LaserRig& lr = app.lasers;
    RenderSettings& r = app.rs;
    ImGui::SeparatorText("Boitiers");
    ImGui::Combo("Pilotage##l", &lr.pattern, LASER_PATTERN_NAMES, LP_COUNT);
    if (lr.pattern != LP_PROGRAM && lr.pattern != LP_OFF)
        ImGui::SliderInt("Boitiers allumes (motif d'essai)", &lr.count, 1, (int)lr.mounts.size());
    if (ImGui::Button("Programmation de depart##l")) lr.program_default();
    ImGui::SameLine();
    if (ImGui::Button("Demonstration (toutes les formes)##l")) lr.program_showcase();
    ImGui::SliderFloat("Grand master##l", &lr.master, 0, 1);
    ImGui::SliderFloat("Puissance d'un boitier", &lr.power_w, 0.05f, 30, "%.2f W", ImGuiSliderFlags_Logarithmic);
    ImGui::SliderFloat("Angle maximal du scanner", &lr.max_angle, 10, 90, "%.0f deg");
    ImGui::SliderFloat("Inertie des galvos", &lr.galvo_ms, 0, 100, "%.0f ms");
    ImGui::SliderFloat("Diametre de sortie", &lr.aperture_mm, 1, 20, "%.1f mm");
    ImGui::SliderFloat("Divergence", &lr.divergence_mrad, 0.2f, 5, "%.2f mrad");
    ImGui::Checkbox("Afficher les boitiers##l", &lr.show_housings);
    ImGui::SameLine();
    ImGui::TextDisabled("(%d allumes, %d segments, %d traits)", lr.lit, app.renderer.stats.laser_segments, lr.total_traits);
    ImGui::SeparatorText("Dans la fumee");
    ImGui::Checkbox("Lasers dans la fumee", &r.lasers);
    ImGui::SliderFloat("Intensite dans la fumee", &r.laser_gain, 0.01f, 100, "x %.2f", ImGuiSliderFlags_Logarithmic);
    ImGui::SliderFloat("Largeur minimale d'un trait", &r.laser_width_px, 0.3f, 2.0f, "%.2f pixel");
    ImGui::SliderFloat("Diffusion de l'air", &r.laser_air, 0, 0.005f, "%.4f /m");
    spatial_fog_ui_model(r.sfog);
    if (r.sfog.model == 0) ImGui::Checkbox("Fumee de la piece (amas, brume ; sinon uniforme)##l", &r.laser_room_fog);
    ImGui::Checkbox("Diffusion tres avant (2 lobes)##l", &r.laser_fwd_lobe);
    if (r.laser_fwd_lobe) {
        ImGui::SliderFloat("Part du lobe tres avant##l", &r.laser_fwd_weight, 0, 1, "%.2f");
        ImGui::SliderFloat("g du lobe tres avant##l", &r.laser_g_fwd, 0.5f, 0.98f, "%.2f");
        ImGui::SliderFloat("g du lobe doux##l", &r.laser_g_soft, -0.3f, 0.9f, "%.2f");
    }
    if (r.sfog.model == 0) ImGui::Checkbox("Volutes fines dans les nappes##l", &r.laser_volutes);
    spatial_fog_ui_settings(r.sfog, app.fog.banks, app.fog.room);
    if (r.sfog.model == 0 && r.laser_volutes) {
        ImGui::SliderFloat("Contraste des volutes##l", &r.laser_vol_strength, 0, 1.5f, "%.2f");
        ImGui::SliderFloat("Taille des volutes##l", &r.laser_vol_size, 0.3f, 6, "%.2f m");
        ImGui::SliderFloat("Evolution (boucle)##l", &r.laser_vol_period, 2, 60, "%.0f s");
        ImGui::Checkbox("2e octave de pres##l", &r.laser_vol_fine);
        if (r.laser_vol_fine) {
            ImGui::SliderFloat("2e octave : portee (niveau)##l", &r.laser_vol_fine_lod, -2, 4, "%.1f");
            ImGui::SliderFloat("2e octave : poids##l", &r.laser_vol_fine_weight, 0, 1.5f, "%.2f");
        }
    }
    ImGui::SeparatorText("Rendu photo (essais)");
    ImGui::SliderFloat("Bords brillants (scanner)##l", &r.laser_edge, 0, 1, "%.2f");
    ImGui::SetItemTooltip("Le scanner ralentit au bout de chaque balayage : la lumiere se concentre sur les bords de l'eventail.\n0 : nappe uniforme, 1 : balayage sinusoidal.");
    if (r.laser_edge > 0.0f) ImGui::SliderFloat("Largeur des bords##l", &r.laser_edge_w, 0.005f, 0.3f, "%.3f", ImGuiSliderFlags_Logarithmic);
    ImGui::SliderFloat("Halo des lasers##l", &r.laser_halo, 0, 3, "%.2f");
    ImGui::SetItemTooltip("Lumiere des nappes diffusee une 2e fois par la brume, et lueur de l'objectif : halo large et doux autour des nappes.");
    if (r.laser_halo > 0.0f) ImGui::SliderFloat("Etendue du halo##l", &r.laser_halo_size, 0.3f, 1.8f, "%.2f");
    ImGui::SliderFloat("Convergence RGB##l", &r.laser_conv, 0, 3, "%.2f mrad");
    ImGui::SetItemTooltip("Les diodes rouge, verte et bleue d'un projecteur RGB ne sont jamais parfaitement alignees :\nchaque couleur part avec un petit ecart d'angle. Bords colores sur les nappes, les traits et les impacts\n(seulement pour les couleurs melangees : un laser vert pur n'a pas de franges).");
    ImGui::SliderFloat("Aberration de l'objectif##l", &r.laser_lens_ca, 0, 1, "%.2f %%");
    ImGui::SetItemTooltip("Defaut de l'appareil photo (pas du laser) : franges rouges et bleues autour des lasers intenses, plus fortes au bord de l'image.");
    ImGui::SliderFloat("Exposition##l", &r.exposure, 0.1f, 8.0f, "%.2f", ImGuiSliderFlags_Logarithmic);
    ImGui::SliderFloat("Blanchiment##l", &r.laser_white, 0.0f, 1.5f, "%.2f");
    // point de vue et reglages, a copier pour les retrouver (option --cam du lancement, cles --set)
    {
        const Camera& c = app.cam;
        char buf[512];
        std::snprintf(buf, sizeof(buf), "--cam %.2f,%.2f,%.2f,%.1f,%.1f --set laseredge=%.2f --set laseredgew=%.3f --set laserhalo=%.2f "
                      "--set laserhalosize=%.2f --set laserconv=%.2f --set laserlensca=%.2f --set exposure=%.2f --set laserwhite=%.2f --set laserpower=%.2f",
                      c.pos.x, c.pos.y, c.pos.z, c.yaw / DEG, c.pitch / DEG, r.laser_edge, r.laser_edge_w, r.laser_halo, r.laser_halo_size,
                      r.laser_conv, r.laser_lens_ca, r.exposure, r.laser_white, app.lasers.power_w);
        ImGui::TextWrapped("%s", buf);
        if (ImGui::Button("Copier (vue et reglages)##l")) ImGui::SetClipboardText(buf);
    }
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
    if (!r.fsr) ImGui::SliderFloat("Resolution interne", &r.render_scale, 0.25f, 1.0f, "x %.2f");
    ImGui::Checkbox("AMD FSR 1 (dernier recours)", &r.fsr);
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("Calcule l'image plus petite puis l'agrandit (EASU) et rend la nettete (RCAS).\n"
                          "Remplace la resolution interne. L'interface reste a pleine resolution.\n"
                          "Plus rapide, mais traits fins (lasers) et scintillement du sol plus doux.");
    if (r.fsr) {
        ImGui::SliderFloat("FSR : resolution divisee par", &r.fsr_div, 1.0f, 3.0f, "%.2f");
        if (ImGui::Button("Qualite")) r.fsr_div = 1.5f;
        ImGui::SameLine();
        if (ImGui::Button("Equilibre")) r.fsr_div = 1.7f;
        ImGui::SameLine();
        if (ImGui::Button("Performance")) r.fsr_div = 2.0f;
        ImGui::SameLine();
        if (ImGui::Button("Ultra")) r.fsr_div = 3.0f;
        ImGui::SliderFloat("FSR : nettete", &r.fsr_sharpness, 0.0f, 1.0f, "%.2f");
        ImGui::TextDisabled("Rendu %d x %d -> ecran", s.internal_w, s.internal_h);
    }
    ImGui::Checkbox("Taches de lumiere sur les surfaces", &r.surface_lights);
    ImGui::Checkbox("Reflets brillants", &r.specular);
    ImGui::Checkbox("Lyres tres douces (frost) eclairees a 1/4 de la resolution", &r.soft_lights);
    ImGui::SameLine();
    ImGui::TextDisabled("(%d)", s.soft_lights);
    ImGui::SliderInt("Lyres superposees a 1/4 au-dela de", &r.crowd_soft, 0, 96, r.crowd_soft > 0 ? "%d lyres" : "jamais");
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("Case de l'ecran ou plus de N lyres sans gobo se superposent (convergence, grand zoom) :\n"
                          "leur lumiere y est calculee a 1/4 de la resolution (relief du sol exact, reflets lisses).\n"
                          "Seulement les lyres dont la tache a un bord large et flou (grand zoom, frost, hors mise au point).\n"
                          "Jusqu'a 4 fois plus rapide sur une convergence. 0 : jamais.");
    ImGui::SliderFloat("Scintillement des reflets a 1/4", &r.sparkle, 0.0f, 3.0f, "%.2f");
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("Lyres eclairees a 1/4 : le reflet est module pixel par pixel par le relief fin du sol.\n"
                          "1,75 : autant de grains brillants qu'a pleine resolution. 0 : reflet lisse.");
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
    ImGui::Checkbox("Aberration chromatique (franges des gobos)", &r.chroma);
    ImGui::SliderFloat("Intensite de l'aberration", &r.chroma_strength, 0, 4, "%.2f");
    ImGui::Checkbox("Sol en beton texture", &r.floor_texture);
    if (!app.floor.ok) {
        ImGui::SameLine();
        ImGui::TextDisabled("(texture absente)");
    }
    ImGui::SliderFloat("Eau au sol", &r.floor_wet, 0, 1, r.floor_wet <= 0.001f ? "sec" : "%.2f");
    ImGui::Checkbox("Afficher les lyres", &r.show_fixtures);
    ImGui::SliderFloat("Eclat des lentilles", &r.lens_glow, 0, 4);
    ImGui::Checkbox("Lasers dans la fumee (reglages : onglet Lasers)", &r.lasers);
    ImGui::SameLine();
    ImGui::TextDisabled("(%d segments, %d traits)", s.laser_segments, app.lasers.total_traits);
    ImGui::Checkbox("Lasers : fumee de la piece (amas, brume ; sinon uniforme)", &r.laser_room_fog);
    ImGui::Checkbox("Lasers : arretes par les obstacles et le personnage", &app.lasers.collisions);
    ImGui::SameLine();
    ImGui::TextDisabled("(%d segments coupes)", app.lasers.cut_segments);
    ImGui::SliderFloat("Lasers : blanchiment (0 = oeil, 1 = camera)", &r.laser_white, 0.0f, 1.5f, "%.2f");
    ImGui::Checkbox("Lasers : resolution adaptative (80, 70, 50 % sous 60 img/s)", &r.laser_adaptive);
    ImGui::SameLine();
    ImGui::TextDisabled("(%.0f %%)", app.renderer.stats.laser_scale * 100.0f);
    ImGui::SliderFloat("Lasers : lueur de sortie", &r.laser_exit, 0.0f, 4.0f, "x %.2f");
    ImGui::Checkbox("Lasers : cache des figures fixes (moteur CPU)", &app.lasers.figure_cache);
    ImGui::SameLine();
    ImGui::TextDisabled("(%d lasers repris ; moteur %.2f ms : morceaux %.2f, impacts %.2f)", app.lasers.cached_lasers,
                        app.lasers.cpu_build_ms + app.lasers.cpu_hits_ms, app.lasers.cpu_build_ms, app.lasers.cpu_hits_ms);
    if (ImGui::Checkbox("Lasers : impacts sur les surfaces (points et lignes)", &r.laser_impacts)) app.lasers.impacts = r.laser_impacts;
    ImGui::SameLine();
    ImGui::TextDisabled("(%d)", s.laser_hits);
    ImGui::SliderFloat("Intensite des impacts", &r.laser_hit_gain, 0.01f, 10, "x %.2f", ImGuiSliderFlags_Logarithmic);
    ImGui::Checkbox("Lasers : diffusion tres avant (2 lobes ; sinon comme les lyres)", &r.laser_fwd_lobe);
    ImGui::Checkbox("Lasers : volutes fines dans les nappes", &r.laser_volutes);
    ImGui::Checkbox("Lasers : volutes, 2e octave de pres (detail de quelques mm)", &r.laser_vol_fine);
    ImGui::SeparatorText("Image");
    ImGui::SliderFloat("Exposition", &r.exposure, 0.05f, 8, "%.2f", ImGuiSliderFlags_Logarithmic);
    ImGui::SliderFloat("Lumiere ambiante", &r.ambient, 0, 0.05f, "%.4f", ImGuiSliderFlags_Logarithmic);
    ImGui::SliderFloat("Portee des faisceaux", &r.beam_range, 10, 160, "%.0f m");
}

// Grille des ambiances : un bouton par ambiance (bande de sa couleur en bas, cadre blanc sur celle en cours).
void ambiances_ui() {
    ImGui::TextWrapped("Cliquez une ambiance, ou fleches du clavier pour passer de l'une a l'autre (tant que cet onglet "
                       "est ouvert ; la camera se deplace alors avec Z Q S D).");
    const float sp = ImGui::GetStyle().ItemSpacing.x;
    const float w = (ImGui::GetContentRegionAvail().x - sp * (AMBIANCE_COLS - 1)) / AMBIANCE_COLS;
    const float h = 3.2f * ImGui::GetTextLineHeightWithSpacing();
    ImDrawList* dl = ImGui::GetWindowDrawList();
    for (int i = 0; i < NUM_AMBIANCES; i++) {
        if (i == NUM_BASE_AMBIANCES) ImGui::SeparatorText("Scenes du moteur de rendu (src/scenes)");
        if (i % AMBIANCE_COLS != 0) ImGui::SameLine();
        const AmbianceInfo& a = ambiance_info(i);
        const vec3 t = a.tint;
        const bool cur = i == app.ambiance && !g_spectacle.running;
        const float k = cur ? 0.5f : 0.18f;
        ImGui::PushStyleColor(ImGuiCol_Button, ImVec4(0.08f + t.x * k, 0.08f + t.y * k, 0.09f + t.z * k, 1));
        ImGui::PushStyleColor(ImGuiCol_ButtonHovered, ImVec4(0.1f + t.x * 0.4f, 0.1f + t.y * 0.4f, 0.11f + t.z * 0.4f, 1));
        ImGui::PushStyleColor(ImGuiCol_ButtonActive, ImVec4(0.15f + t.x * 0.6f, 0.15f + t.y * 0.6f, 0.15f + t.z * 0.6f, 1));
        char label[64];
        std::snprintf(label, sizeof(label), "%d\n%s##amb%d", i + 1, a.name, i);
        if (ImGui::Button(label, ImVec2(w, h))) apply_ambiance(i);
        ImGui::PopStyleColor(3);
        if (ImGui::IsItemHovered()) ImGui::SetTooltip("%s", a.desc);
        const ImVec2 mn = ImGui::GetItemRectMin(), mx = ImGui::GetItemRectMax();
        dl->AddRectFilled(ImVec2(mn.x + 5, mx.y - 7), ImVec2(mx.x - 5, mx.y - 4), ImGui::ColorConvertFloat4ToU32(ImVec4(t.x, t.y, t.z, 1)), 2);
        if (cur) dl->AddRect(mn, mx, IM_COL32(255, 255, 255, 230), ImGui::GetStyle().FrameRounding, 0, 2.0f);
    }
    ImGui::Spacing();
    spectacle_ui(app.lasers);   // spectacles : generateur de scenes lasers + lyres (src/spectacles.cpp)
    if (g_spectacle.running) return;   // le spectacle affiche lui-meme ce qui est en cours
    const AmbianceInfo& a = ambiance_info(app.ambiance);
    ImGui::SeparatorText("En cours");
    ImGui::Text("%d. %s", app.ambiance + 1, a.name);
    ImGui::TextWrapped("%s", a.desc);
    ImGui::TextDisabled("%d faisceaux de lyres, %d lasers allumes (%d traits)", app.renderer.stats.lights, app.lasers.lit,
                        app.lasers.total_traits);
    ImGui::PushStyleColor(ImGuiCol_Text, ImGui::GetStyleColorVec4(ImGuiCol_TextDisabled));
    ImGui::TextWrapped("Les onglets Lyres, Effets, Lasers et Fumee montrent sa programmation : on peut la retoucher.");
    ImGui::PopStyleColor();
}

void help_ui() {
    ImGui::TextWrapped("Camera : clic droit maintenu pour regarder, W A S D (Z Q S D en AZERTY) ou fleches pour avancer, "
                       "Espace / E pour monter, C / A(Q) pour descendre, Maj pour aller vite, molette pour la vitesse.");
    ImGui::TextWrapped("Onglet Ambiances ouvert : les fleches passent d'une ambiance a l'autre (la camera garde Z Q S D).");
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
        if (ImGui::BeginTabItem("Ambiances")) {
            app.ambiance_tab = true;
            ambiances_ui();
            ImGui::EndTabItem();
        }
        if (ImGui::BeginTabItem("Lyres")) {
            app.sel_kind = 0;
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
        if (ImGui::BeginTabItem("Lasers")) {
            app.sel_kind = 1;
            laser_selection_ui();
            laser_programmer_ui();
            ImGui::SeparatorText("Effets des lasers");
            laser_effects_ui();
            laser_global_ui();
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
    selection_overlay();
}

void select_in_rect(int mode) {
    if (app.sel_kind == 0) pick(app.rig.fixtures, mode);
    else if (app.sel_kind == 1) pick(app.lasers.fixtures, mode);
}
