#include "fog.h"
#include <algorithm>
#include <chrono>

namespace {

// Bruit de valeur 3D repetable de periode 'per' (en cellules du reseau).
float lattice(int x, int y, int z, int per, uint32_t seed) {
    x = ((x % per) + per) % per; y = ((y % per) + per) % per; z = ((z % per) + per) % per;
    return hash01((uint32_t)x * 73856093u ^ (uint32_t)y * 19349663u ^ (uint32_t)z * 83492791u ^ seed);
}
float vnoise3(float x, float y, float z, int per, uint32_t seed) {
    int ix = (int)std::floor(x), iy = (int)std::floor(y), iz = (int)std::floor(z);
    float fx = x - ix, fy = y - iy, fz = z - iz;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
    float c[8];
    for (int k = 0; k < 8; k++) c[k] = lattice(ix + (k & 1), iy + ((k >> 1) & 1), iz + (k >> 2), per, seed);
    float x00 = lerpf(c[0], c[1], fx), x10 = lerpf(c[2], c[3], fx), x01 = lerpf(c[4], c[5], fx), x11 = lerpf(c[6], c[7], fx);
    return lerpf(lerpf(x00, x10, fy), lerpf(x01, x11, fy), fz);
}
// Bruit cellulaire (Worley) repetable : distance au point le plus proche.
float worley3(float x, float y, float z, int per, uint32_t seed) {
    int ix = (int)std::floor(x), iy = (int)std::floor(y), iz = (int)std::floor(z);
    float best = 10;
    for (int k = -1; k <= 1; k++)
        for (int j = -1; j <= 1; j++)
            for (int i = -1; i <= 1; i++) {
                int cx = ix + i, cy = iy + j, cz = iz + k;
                float px = cx + lattice(cx, cy, cz, per, seed);
                float py = cy + lattice(cx, cy, cz, per, seed + 17);
                float pz = cz + lattice(cx, cy, cz, per, seed + 31);
                float dx = x - px, dy = y - py, dz = z - pz;
                best = std::min(best, dx * dx + dy * dy + dz * dz);
            }
    return std::sqrt(best);
}

}  // namespace

void FogSim::init(vec3 bmin, vec3 bmax) {
    wait();
    origin = bmin;
    size = bmax - bmin;
    d.assign(NX * NY * NZ, 0.0f);
    tmp.assign(NX * NY * NZ, 0.0f);
    upload.assign(NX * NY * NZ * 4, 0);

    machines.clear();
    machines.push_back({{-34.5f, 1.8f, -12}, normalize(vec3(1, 0.15f, 0.2f))});
    machines.push_back({{-34.5f, 1.8f, 12}, normalize(vec3(1, 0.15f, -0.2f))});
    machines.push_back({{-46, 1.8f, 0}, normalize(vec3(1, 0.3f, 0))});
    machines.push_back({{15, 0.4f, -21}, normalize(vec3(0.2f, 0.2f, 1))});
    machines.push_back({{30, 0.4f, 21}, normalize(vec3(-0.2f, 0.2f, -1))});

    // Texture de detail : volutes "nuageuses" (bruit de valeur fbm creuse par du Worley).
    detail.resize((size_t)DETAIL * DETAIL * DETAIL);
    for (int z = 0; z < DETAIL; z++)
        for (int y = 0; y < DETAIL; y++)
            for (int x = 0; x < DETAIL; x++) {
                float fx = (float)x / DETAIL, fy = (float)y / DETAIL, fz = (float)z / DETAIL;
                float v = 0, a = 0.55f, tot = 0;
                int per = 4;
                for (int o = 0; o < 4; o++) {
                    v += a * vnoise3(fx * per, fy * per, fz * per, per, 1234 + o * 77);
                    tot += a;
                    a *= 0.5f;
                    per *= 2;
                }
                v /= tot;
                float w = 1.0f - std::min(1.0f, worley3(fx * 6, fy * 6, fz * 6, 6, 999) * 1.1f);
                float n = saturate((v * 0.65f + w * 0.55f - 0.3f) * 1.6f);
                detail[(size_t)z * DETAIL * DETAIL + (size_t)y * DETAIL + x] = (uint8_t)(n * 255.0f + 0.5f);
            }
    prefill();
}

void FogSim::clear() {
    wait();
    std::fill(d.begin(), d.end(), 0.0f);
    std::fill(upload.begin(), upload.end(), 0);   // la densite de la piece sera recalculee a la prochaine mise a jour
}

void FogSim::prefill() {
    wait();
    for (int z = 0; z < NZ; z++)
        for (int y = 0; y < NY; y++)
            for (int x = 0; x < NX; x++) {
                float fx = (float)x / NX, fy = (float)y / NY, fz = (float)z / NZ;
                float n = vnoise3(fx * 5, fy * 3, fz * 3, 64, 4242) * 0.65f + vnoise3(fx * 11, fy * 6, fz * 7, 64, 777) * 0.35f;
                float clump = std::max(0.0f, n - 0.42f) * 3.2f;
                // un peu plus de fumee vers la scene et en hauteur
                clump *= 0.7f + 0.6f * (1.0f - fx) + 0.3f * fy;
                d[(size_t)z * NX * NY + (size_t)y * NX + x] = std::min(clump, 2.0f);
            }
}

float FogSim::sample(float x, float y, float z) const {
    x = clampf(x, 0, NX - 1.001f); y = clampf(y, 0, NY - 1.001f); z = clampf(z, 0, NZ - 1.001f);
    int ix = (int)x, iy = (int)y, iz = (int)z;
    float fx = x - ix, fy = y - iy, fz = z - iz;
    auto at = [&](int a, int b, int c) { return d[(size_t)c * NX * NY + (size_t)b * NX + a]; };
    float x00 = lerpf(at(ix, iy, iz), at(ix + 1, iy, iz), fx);
    float x10 = lerpf(at(ix, iy + 1, iz), at(ix + 1, iy + 1, iz), fx);
    float x01 = lerpf(at(ix, iy, iz + 1), at(ix + 1, iy, iz + 1), fx);
    float x11 = lerpf(at(ix, iy + 1, iz + 1), at(ix + 1, iy + 1, iz + 1), fx);
    return lerpf(lerpf(x00, x10, fy), lerpf(x01, x11, fy), fz);
}

void FogSim::step(float dt, const FogSettings& s, const std::vector<SmokeMachine>& mach) {
    sim_time += dt;
    const float cx = size.x / NX, cy = size.y / NY, cz = size.z / NZ;  // taille des cellules (m)
    const float wa = s.wind_angle * DEG;
    const vec3 wind = {std::cos(wa) * s.wind_speed, 0, std::sin(wa) * s.wind_speed};
    const float t = sim_time;
    const float keep = std::exp(-s.dissipation * dt);

    // termes des tourbillons precalcules par axe (evite des millions de sin/cos)
    float A[NY], F[NY], B[NZ], C[NZ], D[NX], E[NX];
    for (int y = 0; y < NY; y++) {
        float py = origin.y + (y + 0.5f) * cy;
        A[y] = std::sin(py * 0.21f + t * 0.13f + 1.7f);
        F[y] = std::cos(py * 0.15f + t * 0.06f);
    }
    for (int z = 0; z < NZ; z++) {
        float pz = origin.z + (z + 0.5f) * cz;
        B[z] = std::cos(pz * 0.17f + t * 0.05f);
        C[z] = std::sin(pz * 0.19f + t * 0.11f);
    }
    for (int x = 0; x < NX; x++) {
        float px = origin.x + (x + 0.5f) * cx;
        D[x] = std::cos(px * 0.23f - t * 0.07f);
        E[x] = std::sin(px * 0.2f + t * 0.09f + 0.5f);
    }

    // advection par tranches de z, sur 3 coeurs (chaque case ne lit que d, n'ecrit que la sienne : meme resultat)
    auto slab = [&](int z0, int z1) {
        for (int z = z0; z < z1; z++)
            for (int y = 0; y < NY; y++)
                for (int x = 0; x < NX; x++) {
                    vec3 p = {origin.x + (x + 0.5f) * cx, origin.y + (y + 0.5f) * cy, origin.z + (z + 0.5f) * cz};
                    // champ de vitesse : vent + tourbillons lents + montee + jets des machines
                    vec3 v = wind;
                    v.x += s.turbulence * A[y] * B[z];
                    v.y += s.turbulence * 0.5f * C[z] * D[x];
                    v.z += s.turbulence * E[x] * F[y];
                    v.y += s.rise;
                    for (const SmokeMachine& m : mach) {
                        if (!m.on) continue;
                        vec3 rel = p - m.pos;
                        float along = dot(rel, m.dir);
                        if (along < -1 || along > 14) continue;
                        float off = length(rel - m.dir * along);
                        float w = std::exp(-off * off / 4.0f) * (1.0f - along / 14.0f);
                        v += m.dir * (5.0f * s.machine_output * w);
                    }
                    // advection semi-lagrangienne : on remonte le courant
                    float sx = x - v.x * dt / cx, sy = y - v.y * dt / cy, sz = z - v.z * dt / cz;
                    tmp[(size_t)z * NX * NY + (size_t)y * NX + x] = sample(sx, sy, sz) * keep;
                }
    };
    std::thread t1(slab, NZ / 3, 2 * NZ / 3), t2(slab, 2 * NZ / 3, NZ);
    slab(0, NZ / 3);
    t1.join();
    t2.join();
    // injection par les machines
    for (const SmokeMachine& m : mach) {
        if (!m.on || s.machine_output <= 0) continue;
        vec3 src = m.pos + m.dir * 1.5f;
        float gx = (src.x - origin.x) / cx - 0.5f, gy = (src.y - origin.y) / cy - 0.5f, gz = (src.z - origin.z) / cz - 0.5f;
        for (int k = -2; k <= 2; k++)
            for (int j = -2; j <= 2; j++)
                for (int i = -2; i <= 2; i++) {
                    int x = (int)std::round(gx) + i, y = (int)std::round(gy) + j, z = (int)std::round(gz) + k;
                    if (x < 0 || y < 0 || z < 0 || x >= NX || y >= NY || z >= NZ) continue;
                    float dx = (x - gx) * cx, dy = (y - gy) * cy, dz = (z - gz) * cz;
                    float w = std::exp(-(dx * dx + dy * dy + dz * dz) / 2.0f);
                    float& c = tmp[(size_t)z * NX * NY + (size_t)y * NX + x];
                    c = std::min(c + 1.2f * s.machine_output * w * dt, 3.0f);
                }
    }
    d.swap(tmp);
}

void FogSim::wait() {
    if (!job.joinable()) {
        wait_ms = 0;
        return;
    }
    const auto t0 = std::chrono::steady_clock::now();
    job.join();
    wait_ms = (float)std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
}

void FogSim::update(float dt, const FogSettings& s, const SpatialFogSettings* sf) {
    wait();
    const float STEP = 1.0f / 20.0f;
    int n = 0;
    if (s.animate) {
        accum += std::min(dt, 0.25f);
        while (accum >= STEP && n < 3) { accum -= STEP; n++; }
        if (n == 3) accum = 0;
    }
    fill(s, sf);
    if (n == 0) return;
    // pas suivants en tache de fond, avec une copie des reglages et des machines (l'interface peut les changer) ; le champ
    // des bancs (fumee v2) pour le nouvel instant aussi : update_spatial ne le recalcule plus (banks_time a jour)
    const FogSettings sc = s;
    const std::vector<SmokeMachine> mach = machines;
    const bool spatial = sf && sf->model == 1;
    const SpatialFogSettings sfc = sf ? *sf : SpatialFogSettings();
    job = std::thread([this, n, STEP, sc, mach, spatial, sfc] {
        for (int i = 0; i < n; i++) step(STEP, sc, mach);
        if (spatial) {
            const float wa = sc.wind_angle * DEG;
            const float o[3] = {origin.x, origin.y, origin.z}, sz[3] = {size.x, size.y, size.z};
            banks.field(NX, NY, NZ, o, sz, sim_time, std::cos(wa) * sc.wind_speed, std::sin(wa) * sc.wind_speed, sfc);
            banks_time = sim_time;
            banks_set = sfc;
        }
    });
}

void FogSim::fill(const FogSettings& s, const SpatialFogSettings* sf) {
    if (sf && sf->model == 1) {
        update_spatial(s, *sf);
        return;
    }
    double sum = 0;
    // densite de la piece : brume x exp(-decroissance x hauteur) + poids des amas x amas (au plus 2)
    room_max = std::max(s.haze + 2.0f * s.smoke, 1e-4f);
    const float cy = size.y / NY, inv = 255.0f / room_max;
    for (int y = 0; y < NY; y++) {
        const float hz = s.haze * std::exp(-std::max(origin.y + (y + 0.5f) * cy, 0.0f) * s.height_falloff);
        for (int z = 0; z < NZ; z++) {
            const size_t o = (size_t)z * NX * NY + (size_t)y * NX;
            for (int x = 0; x < NX; x++) {
                const float dv = d[o + x];
                const uint8_t q = (uint8_t)std::min(255.0f, dv * 127.5f + 0.5f);
                upload[(o + x) * 4] = q;
                upload[(o + x) * 4 + 1] = (uint8_t)std::min(255.0f, (hz + (float)q * (1.0f / 127.5f) * s.smoke) * inv + 0.5f);
                upload[(o + x) * 4 + 2] = 0;
                sum += dv;
            }
        }
    }
    mean_smoke = (float)(sum / (double)d.size());
}

// Fumee spatiale des lasers (v2, PLAN-FUMEE-LASERS-V2.md, 3.1) : la carte envoie le champ des bancs (continu, en loi
// normale, canal a), la brume (decroissance en hauteur, canal g) et les amas (canal r, comme pour les lyres). Le profil des
// bancs (seuil, nettete, zones vides) est applique par pixel dans le shader : applique ici case par case, les bords nets
// des bancs suivaient la grille (escaliers). Les bancs sont recalcules quand la simulation avance ou que leurs reglages
// changent.
void FogSim::update_spatial(const FogSettings& s, const SpatialFogSettings& sf) {
    const float wa = s.wind_angle * DEG;
    const bool moved = sim_time != banks_time;
    const bool changed = sf.bank_size != banks_set.bank_size || sf.bank_period != banks_set.bank_period || banks.z.empty();
    if (moved || changed) {
        const float o[3] = {origin.x, origin.y, origin.z}, sz[3] = {size.x, size.y, size.z};
        banks.field(NX, NY, NZ, o, sz, sim_time, std::cos(wa) * s.wind_speed, std::sin(wa) * s.wind_speed, sf);
        banks_time = sim_time;
        banks_set = sf;
    }
    // quantite de fumee : celle du modele Classique en moyenne (brume + amas moyens), repartie par les bancs ; les amas
    // des machines s'y ajoutent (part sf.sim)
    double dsum = 0;
    for (float dv : d) dsum += dv;
    mean_smoke = (float)(dsum / (double)d.size());
    sf_haze_scale = (s.haze + s.smoke * mean_smoke) * std::max(sf.haze, 0.0f);
    sf_smoke_scale = 2.0f * s.smoke * std::max(sf.sim, 0.0f);   // canal r = amas / 2
    room_max = 1;
    // salle composee : logique de la salle (quantite, style, couverture par region), recalculee seulement quand ses
    // reglages ou le vent changent (champs fixes dans l'espace)
    const bool mix = sf.mix != 0;
    if (mix) {
        const SpatialFogSettings& b = room.built;
        const bool same = room.valid && b.seed == sf.seed && b.region_size == sf.region_size && b.dense_share == sf.dense_share &&
                          b.region_sharp == sf.region_sharp && b.stage_boost == sf.stage_boost && b.stage_dist == sf.stage_dist &&
                          b.low_boost == sf.low_boost && b.back_dilute == sf.back_dilute && b.density_var == sf.density_var &&
                          b.plumes == sf.plumes && b.plume_width == sf.plume_width && b.plume_height == sf.plume_height &&
                          room_wind == s.wind_angle;
        if (!same) {
            const float o[3] = {origin.x, origin.y, origin.z}, sz[3] = {size.x, size.y, size.z};
            room.compute(NX, NY, NZ, o, sz, std::cos(wa) * std::max(s.wind_speed, 0.01f), std::sin(wa) * std::max(s.wind_speed, 0.01f), sf);
            room_wind = s.wind_angle;
        }
        sf_haze_scale *= room.amount_max;
    }
    const float inv_amax = mix ? 1.0f / room.amount_max : 1.0f;
    const float cy = size.y / NY;
    for (int y = 0; y < NY; y++) {
        const float hz = std::exp(-std::max(origin.y + (y + 0.5f) * cy, 0.0f) * sf.height);
        for (int z = 0; z < NZ; z++) {
            const size_t o = (size_t)z * NX * NY + (size_t)y * NX;
            for (int x = 0; x < NX; x++) {
                const size_t i = o + x;
                const float am = mix ? room.amount[i] * inv_amax : 1.0f;
                const float zb = mix ? room.zbias[i] : 0.0f;
                upload[i * 4] = (uint8_t)std::min(255.0f, d[i] * 127.5f + 0.5f);
                upload[i * 4 + 1] = (uint8_t)(saturate(hz * am) * 255.0f + 0.5f);
                upload[i * 4 + 2] = mix ? (uint8_t)(saturate(room.style[i]) * 255.0f + 0.5f) : 0;
                upload[i * 4 + 3] = (uint8_t)(saturate(0.5f + (banks.z[i] + zb) * 0.125f) * 255.0f + 0.5f);
            }
        }
    }
}
