#include "scene.h"

Instance make_instance(vec3 c, vec3 ax, vec3 ay, vec3 az, vec3 albedo, float rough, vec3 emissive, float metal) {
    Instance i;
    i.r0 = {ax.x, ay.x, az.x, c.x};
    i.r1 = {ax.y, ay.y, az.y, c.y};
    i.r2 = {ax.z, ay.z, az.z, c.z};
    i.albedo_rough = vec4(albedo, rough);
    i.emissive_metal = vec4(emissive, metal);
    return i;
}

Instance make_box(vec3 c, vec3 h, vec3 albedo, float rough, float metal) {
    return make_instance(c, {h.x, 0, 0}, {0, h.y, 0}, {0, 0, h.z}, albedo, rough, {0, 0, 0}, metal);
}

Instance make_bar(vec3 a, vec3 b, float thick, vec3 albedo, float rough, float metal) {
    vec3 d = b - a;
    float len = length(d);
    vec3 z = d / len;
    vec3 ref = std::fabs(z.y) < 0.9f ? vec3(0, 1, 0) : vec3(1, 0, 0);
    vec3 x = normalize(cross(ref, z));
    vec3 y = cross(z, x);
    float h = thick * 0.5f;
    return make_instance((a + b) * 0.5f, x * h, y * h, z * (len * 0.5f), albedo, rough, {0, 0, 0}, metal);
}

// --------------------------------------------------------------------------------------------
//  Construction du hangar
// --------------------------------------------------------------------------------------------
namespace {

const vec3 STEEL = {0.32f, 0.33f, 0.35f};    // alu des trusses
const vec3 BLACK_STEEL = {0.04f, 0.04f, 0.045f};

// Truss carre de 40 cm entre deux points horizontaux le long de X ou Z.
void add_truss(Scene& s, vec3 a, vec3 b, float size = 0.4f) {
    vec3 dir = normalize(b - a);
    vec3 side = normalize(cross(dir, vec3(0, 1, 0)));
    float hs = size * 0.5f;
    vec3 c[4] = {side * hs + vec3(0, hs, 0), side * -hs + vec3(0, hs, 0),
                 side * -hs + vec3(0, -hs, 0), side * hs + vec3(0, -hs, 0)};
    for (int i = 0; i < 4; i++) s.cubes.push_back(make_bar(a + c[i], b + c[i], 0.05f, STEEL, 0.35f, 1.0f));
    float len = length(b - a);
    int n = (int)(len / size);
    for (int k = 0; k < n; k++) {
        vec3 p0 = a + dir * (k * size), p1 = a + dir * ((k + 1) * size);
        // diagonales sur les 4 faces (alternees)
        for (int f = 0; f < 4; f++) {
            vec3 u = c[f], v = c[(f + 1) & 3];
            if (k & 1) s.cubes.push_back(make_bar(p0 + u, p1 + v, 0.025f, STEEL, 0.4f, 1.0f));
            else s.cubes.push_back(make_bar(p0 + v, p1 + u, 0.025f, STEEL, 0.4f, 1.0f));
        }
    }
}

void add_collider_box(Scene& s, vec3 c, vec3 h, vec3 albedo, float rough, float metal = 0.0f, bool visible = true,
                      bool occluder = true) {
    if (visible) s.cubes.push_back(make_box(c, h, albedo, rough, metal));
    s.colliders.push_back({c - h, c + h, albedo});
    if (occluder) {
        s.occluders.push_back({c, {h.x, 0, 0}, {0, h.y, 0}, {0, 0, h.z}});
        s.laser_occluders.push_back(s.occluders.back());
    }
}

// Mannequin simple (silhouette humaine en paves).
void add_mannequin(Scene& s, vec3 feet, float yaw, vec3 albedo) {
    vec3 fx = {std::cos(yaw), 0, std::sin(yaw)}, fz = {-std::sin(yaw), 0, std::cos(yaw)};
    auto part = [&](vec3 local, vec3 half) {
        vec3 c = feet + fx * local.x + vec3(0, local.y, 0) + fz * local.z;
        s.cubes.push_back(make_instance(c, fx * half.x, {0, half.y, 0}, fz * half.z, albedo, 0.7f));
        s.laser_occluders.push_back({c, fx * half.x, {0, half.y, 0}, fz * half.z});
    };
    // ombre : 2 paves (corps de la tete aux pieds, bras) au lieu de 6 pieces
    s.occluders.push_back({feet + vec3(0, 0.9f, 0), fx * 0.12f, {0, 0.9f, 0}, fz * 0.2f});
    s.occluders.push_back({feet + vec3(0, 1.2f, 0), fx * 0.06f, {0, 0.3f, 0}, fz * 0.33f});
    part({0, 0.45f, -0.1f}, {0.07f, 0.45f, 0.07f});   // jambes
    part({0, 0.45f, 0.1f}, {0.07f, 0.45f, 0.07f});
    part({0, 1.22f, 0}, {0.12f, 0.32f, 0.2f});       // torse
    part({0, 1.68f, 0}, {0.1f, 0.12f, 0.09f});       // tete
    part({0, 1.2f, -0.28f}, {0.05f, 0.3f, 0.05f});   // bras
    part({0, 1.2f, 0.28f}, {0.05f, 0.3f, 0.05f});
    s.colliders.push_back({feet + vec3(-0.25f, 0, -0.35f), feet + vec3(0.25f, 1.8f, 0.35f), albedo});
}

}  // namespace

void Scene::build() {
    cubes.clear(); cylinders.clear(); colliders.clear(); occluders.clear(); laser_occluders.clear(); mounts.clear(); group_names.clear();

    // Hangar : 100 m (X) x 44 m (Z) x 34 m (Y)
    const float HX = 50, HZ = 22, H = 34;
    bounds_min = {-HX, 0, -HZ};
    bounds_max = {HX, H, HZ};

    const vec3 concrete = {0.20f, 0.20f, 0.21f};
    const vec3 wall = {0.16f, 0.165f, 0.17f};
    const vec3 roof = {0.07f, 0.07f, 0.075f};

    // sol (beton lisse) ; metal = -1 : le shader y pose la texture de beton (si elle est active)
    // parois du hangar : recoivent la lumiere, ne font pas d'ombre (rien n'est derriere)
    add_collider_box(*this, {0, -0.5f, 0}, {HX + 1, 0.5f, HZ + 1}, concrete, 0.32f, -1.0f, true, false);
    add_collider_box(*this, {0, H + 0.5f, 0}, {HX + 1, 0.5f, HZ + 1}, roof, 0.9f, 0.0f, true, false);        // toit
    add_collider_box(*this, {-HX - 0.5f, H * 0.5f, 0}, {0.5f, H * 0.5f, HZ + 1}, wall, 0.8f, 0.0f, true, false);
    add_collider_box(*this, {HX + 0.5f, H * 0.5f, 0}, {0.5f, H * 0.5f, HZ + 1}, wall, 0.8f, 0.0f, true, false);
    add_collider_box(*this, {0, H * 0.5f, -HZ - 0.5f}, {HX + 1, H * 0.5f, 0.5f}, wall, 0.8f, 0.0f, true, false);
    add_collider_box(*this, {0, H * 0.5f, HZ + 0.5f}, {HX + 1, H * 0.5f, 0.5f}, wall, 0.8f, 0.0f, true, false);

    // Poteaux en H le long des murs et poutres de toit
    for (float x = -48; x <= 48.1f; x += 8) {
        for (int side = -1; side <= 1; side += 2) {
            float z = side * (HZ - 0.35f);
            cubes.push_back(make_box({x, H * 0.5f, z}, {0.3f, H * 0.5f, 0.3f}, BLACK_STEEL, 0.5f, 1.0f));
        }
        cubes.push_back(make_box({x, H - 0.6f, 0}, {0.25f, 0.6f, HZ}, BLACK_STEEL, 0.5f, 1.0f));
    }
    for (float z = -HZ + 4; z <= HZ - 3.9f; z += 6) cubes.push_back(make_box({0, H - 1.3f, z}, {HX, 0.12f, 0.12f}, BLACK_STEEL, 0.5f, 1.0f));

    // Scene (cote -X)
    const float stageX0 = -HX, stageX1 = -34, stageH = 1.6f;
    add_collider_box(*this, {(stageX0 + stageX1) * 0.5f, stageH * 0.5f, 0}, {(stageX1 - stageX0) * 0.5f, stageH * 0.5f, 16}, {0.05f, 0.05f, 0.055f}, 0.25f);
    // Mur LED eteint (noir brillant) au fond de la scene
    add_collider_box(*this, {-HX + 0.6f, stageH + 7, 0}, {0.2f, 7, 12}, {0.015f, 0.015f, 0.02f}, 0.12f);
    // Stacks de son (noirs) de chaque cote
    for (int side = -1; side <= 1; side += 2) {
        add_collider_box(*this, {-33, 2.5f, side * 18.0f}, {1.2f, 2.5f, 1.5f}, {0.025f, 0.025f, 0.025f}, 0.6f);
    }
    // Regie DJ
    add_collider_box(*this, {-40, stageH + 0.55f, 0}, {0.8f, 0.55f, 2.5f}, {0.6f, 0.6f, 0.62f}, 0.4f);

    // Decor colore dans la salle : pour verifier que chaque surface renvoie sa vraie couleur
    struct Prop { vec3 c, h, col; };
    const Prop props[] = {
        {{-10, 1.0f, -6}, {1, 1, 1}, {0.85f, 0.35f, 0.05f}},   // orange
        {{-10, 0.75f, 6}, {0.75f, 0.75f, 0.75f}, {0.05f, 0.25f, 0.8f}},  // bleu
        {{5, 1.25f, -10}, {1.25f, 1.25f, 1.25f}, {0.8f, 0.8f, 0.8f}},   // blanc
        {{5, 0.6f, 10}, {0.6f, 0.6f, 0.6f}, {0.75f, 0.05f, 0.05f}},     // rouge
        {{20, 1.5f, 0}, {0.5f, 1.5f, 0.5f}, {0.1f, 0.6f, 0.15f}},       // vert
        {{30, 0.8f, -14}, {2.0f, 0.8f, 0.8f}, {0.7f, 0.2f, 0.5f}},      // rose
        {{-20, 0.5f, 0}, {0.5f, 0.5f, 0.5f}, {0.9f, 0.75f, 0.1f}},      // jaune
    };
    for (const Prop& p : props) add_collider_box(*this, p.c, p.h, p.col, 0.6f);
    // Cube suspendu sous le truss 2 (essai des ombres) : sa face z = -5 est dans le plan des faisceaux du
    // truss 2, qu'elle coupe en deux dans leur longueur : demi-taches au sol, demi-faisceaux dans la fumee
    add_collider_box(*this, {10, 9, -3.5f}, {2.0f, 0.4f, 1.5f}, {0.5f, 0.5f, 0.52f}, 0.5f);

    // Mannequins sur scene et dans la salle
    add_mannequin(*this, {-41, stageH, -6}, 0, {0.6f, 0.6f, 0.6f});
    add_mannequin(*this, {-41, stageH, 6}, 0, {0.6f, 0.6f, 0.6f});
    add_mannequin(*this, {-15, 0, 2}, 0.3f, {0.7f, 0.5f, 0.35f});
    add_mannequin(*this, {-14, 0, -3}, -0.2f, {0.2f, 0.3f, 0.6f});
    add_mannequin(*this, {-5, 0, 0}, 0.1f, {0.75f, 0.75f, 0.75f});

    // ---------------------------------------------------------------------------------------
    //  Structures et lyres
    // ---------------------------------------------------------------------------------------
    const float trussY = 18.0f;
    const float trussZ[4] = {-15, -5, 5, 15};
    const float tx0 = -30, tx1 = 46;
    const int perLine = 42;
    for (int l = 0; l < 4; l++) {
        group_names.push_back("Truss " + std::to_string(l + 1));
        add_truss(*this, {tx0 - 1, trussY, trussZ[l]}, {tx1 + 1, trussY, trussZ[l]});
        // moteurs de levage (chaines vers le toit)
        for (float x = tx0; x <= tx1; x += 12) cubes.push_back(make_bar({x, trussY + 0.2f, trussZ[l]}, {x, H - 1.3f, trussZ[l]}, 0.03f, BLACK_STEEL, 0.6f, 1.0f));
        for (int i = 0; i < perLine; i++) {
            float x = tx0 + (tx1 - tx0) * (i + 0.5f) / perLine;
            mounts.push_back({{x, trussY - 0.22f, trussZ[l]}, {0, -1, 0}, {-1, 0, 0}, l});
        }
    }
    // Pont de scene
    group_names.push_back("Pont scene");
    const float stageTrussY = 12.0f;
    add_truss(*this, {-42, stageTrussY, -17}, {-42, stageTrussY, 17});
    for (float z = -15; z <= 15.1f; z += 15) cubes.push_back(make_bar({-42, stageTrussY + 0.2f, z}, {-42, H - 1.3f, z}, 0.03f, BLACK_STEEL, 0.6f, 1.0f));
    for (int i = 0; i < 16; i++) {
        float z = -16 + 32 * (i + 0.5f) / 16;
        mounts.push_back({{-42, stageTrussY - 0.22f, z}, {0, -1, 0}, {1, 0, 0}, 4});
    }
    // Sol de scene
    group_names.push_back("Sol scene");
    for (int i = 0; i < 8; i++) {
        float z = -14 + 28 * (i + 0.5f) / 8;
        mounts.push_back({{-46, stageH, z}, {0, 1, 0}, {1, 0, 0}, 5});
    }
    // Nez de scene
    group_names.push_back("Nez de scene");
    for (int i = 0; i < 8; i++) {
        float z = -14 + 28 * (i + 0.5f) / 8;
        mounts.push_back({{-33.2f, 0, z}, {0, 1, 0}, {1, 0, 0}, 6});
    }
}

bool Scene::raycast(vec3 o, vec3 d, float tmax, RayHit& hit) const {
    bool found = false;
    hit.t = tmax;
    for (const Collider& c : colliders) {
        float t0 = 0, t1 = hit.t;
        int axis = -1;
        float sign = 0;
        bool miss = false;
        for (int a = 0; a < 3; a++) {
            float inv = 1.0f / (std::fabs(d[a]) > 1e-9f ? d[a] : 1e-9f);
            float ta = (c.mn[a] - o[a]) * inv, tb = (c.mx[a] - o[a]) * inv;
            float sgn = -1;
            if (ta > tb) { float tmp = ta; ta = tb; tb = tmp; sgn = 1; }
            if (ta > t0) { t0 = ta; axis = a; sign = sgn; }
            if (tb < t1) t1 = tb;
            if (t0 > t1) { miss = true; break; }
        }
        if (miss || axis < 0) continue;  // rayon parti de l'interieur : ignore
        hit.t = t0;
        hit.pos = o + d * t0;
        hit.normal = {0, 0, 0};
        hit.normal[axis] = sign;
        hit.albedo = c.albedo;
        found = true;
    }
    return found;
}
