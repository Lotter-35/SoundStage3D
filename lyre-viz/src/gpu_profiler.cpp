#include "gpu_profiler.h"
#include "sokol_app.h"
#include "sokol_gfx.h"
#include "sokol_glue.h"
#include <cstdio>

#if defined(SOKOL_D3D11)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <d3d11.h>
#endif

namespace gpuprof {

static std::vector<Section> g_last;
static float g_last_total = 0;
static unsigned g_last_id = 0;
static float g_wait_ms = 0;
static double g_last_frags = 0;
static bool g_stats_enabled = false;
static float g_gap_ms = 0;
static unsigned long long g_prev_end = 0;
static unsigned g_prev_id = 0;

const std::vector<Section>& last() { return g_last; }
float last_total_ms() { return g_last_total; }
unsigned last_id() { return g_last_id; }
float last_wait_ms() { return g_wait_ms; }
double last_fragments() { return g_last_frags; }
void enable_stats(bool on) { g_stats_enabled = on; }
float last_gap_ms() { return g_gap_ms; }

#if defined(SOKOL_D3D11)

namespace {
constexpr int SLOTS = 6;        // images en vol (on lit les resultats avec quelques images de retard)
constexpr int MAX_MARKS = 32;
struct Slot {
    ID3D11Query* done = nullptr;      // fin de l'image sur le GPU (limiteur de latence)
    ID3D11Query* disjoint = nullptr;
    ID3D11Query* ts[MAX_MARKS + 1] = {};
    ID3D11Query* stats = nullptr;     // statistiques du pipeline (pixels calcules)
    bool stats_used = false;
    const char* names[MAX_MARKS] = {};
    int count = 0;               // nombre de sections ouvertes
    bool pending = false;
    unsigned id = 0;
};
Slot g_slots[SLOTS];
ID3D11Device* g_dev = nullptr;
ID3D11DeviceContext* g_ctx = nullptr;
int g_cur = -1;
unsigned g_frame = 0;

void resolve(Slot& s) {
    if (!s.pending) return;
    D3D11_QUERY_DATA_TIMESTAMP_DISJOINT dj;
    if (g_ctx->GetData(s.disjoint, &dj, sizeof(dj), 0) != S_OK) return;
    UINT64 t[MAX_MARKS + 1];
    for (int i = 0; i <= s.count; i++) {
        if (g_ctx->GetData(s.ts[i], &t[i], sizeof(UINT64), 0) != S_OK) return;
    }
    s.pending = false;
    if (s.stats_used) {
        D3D11_QUERY_DATA_PIPELINE_STATISTICS ps;
        if (g_ctx->GetData(s.stats, &ps, sizeof(ps), 0) == S_OK) g_last_frags = (double)ps.PSInvocations;
    }
    if (dj.Disjoint || dj.Frequency == 0) return;
    const double k = 1000.0 / (double)dj.Frequency;
    g_last.clear();
    for (int i = 0; i < s.count; i++) g_last.push_back({s.names[i], (float)((double)(t[i + 1] - t[i]) * k)});
    g_last_total = (float)((double)(t[s.count] - t[0]) * k);
    if (g_prev_id + 1 == s.id && t[0] > g_prev_end) g_gap_ms = (float)((double)(t[0] - g_prev_end) * k);
    g_prev_end = t[s.count];
    g_prev_id = s.id;
    g_last_id = s.id;
}
}  // namespace

void init() {
    if (sg_query_backend() != SG_BACKEND_D3D11) return;
    g_dev = (ID3D11Device*)sg_d3d11_device();
    g_ctx = (ID3D11DeviceContext*)sg_d3d11_device_context();
    if (!g_dev || !g_ctx) return;
    D3D11_QUERY_DESC qd = {};
    for (Slot& s : g_slots) {
        qd.Query = D3D11_QUERY_EVENT;
        g_dev->CreateQuery(&qd, &s.done);
        qd.Query = D3D11_QUERY_TIMESTAMP_DISJOINT;
        g_dev->CreateQuery(&qd, &s.disjoint);
        qd.Query = D3D11_QUERY_TIMESTAMP;
        for (ID3D11Query*& q : s.ts) g_dev->CreateQuery(&qd, &q);
        qd.Query = D3D11_QUERY_PIPELINE_STATISTICS;
        g_dev->CreateQuery(&qd, &s.stats);
    }
}

bool available() { return g_ctx != nullptr; }

void frame_begin() {
    if (!g_ctx) return;
    // Limiteur de latence : le CPU ne prend pas plus de LATENCY images d'avance sur le GPU.
    // Sans lui, le pilote accepte des dizaines d'images en attente (commandes en retard,
    // mesures impossibles), malgre SetMaximumFrameLatency.
    constexpr unsigned LATENCY = 2;
    g_wait_ms = 0;
    if (g_frame >= LATENCY) {
        Slot& old = g_slots[(g_frame + 1 - LATENCY) % SLOTS];
        BOOL done = FALSE;
        LARGE_INTEGER f, a, b;
        QueryPerformanceFrequency(&f);
        QueryPerformanceCounter(&a);
        while (old.done && g_ctx->GetData(old.done, &done, sizeof(done), 0) == S_FALSE) SwitchToThread();
        QueryPerformanceCounter(&b);
        g_wait_ms = (float)((double)(b.QuadPart - a.QuadPart) * 1000.0 / (double)f.QuadPart);
    }
    g_frame++;
    g_cur = (int)(g_frame % SLOTS);
    Slot& s = g_slots[g_cur];
    resolve(s);   // derniere chance ; sinon la mesure est perdue
    s.pending = false;
    s.count = 0;
    s.stats_used = false;
    s.id = g_frame;
    g_ctx->Begin(s.disjoint);
}

void mark(const char* name) {
    if (!g_ctx || g_cur < 0) return;
    Slot& s = g_slots[g_cur];
    if (s.count >= MAX_MARKS) return;
    g_ctx->End(s.ts[s.count]);
    s.names[s.count++] = name;
}

void stats_begin() {
    if (!g_stats_enabled || !g_ctx || g_cur < 0 || !g_slots[g_cur].stats) return;
    g_ctx->Begin(g_slots[g_cur].stats);
    g_slots[g_cur].stats_used = true;
}

void stats_end() {
    if (!g_ctx || g_cur < 0 || !g_slots[g_cur].stats_used) return;
    g_ctx->End(g_slots[g_cur].stats);
}

void frame_end() {
    if (!g_ctx || g_cur < 0) return;
    Slot& s = g_slots[g_cur];
    if (s.count == 0) mark("image");
    g_ctx->End(s.ts[s.count]);
    g_ctx->End(s.disjoint);
    g_ctx->End(s.done);
    s.pending = true;
    // lit les images precedentes, de la plus ancienne a la plus recente
    for (int k = SLOTS - 1; k >= 1; k--) resolve(g_slots[(g_cur + SLOTS - k) % SLOTS]);
    g_cur = -1;
}

bool save_backbuffer_bmp(const std::string& path) {
    if (!g_ctx) return false;
    sg_swapchain sc = sglue_swapchain();
    ID3D11RenderTargetView* rtv = (ID3D11RenderTargetView*)sc.d3d11.render_view;
    if (!rtv) return false;
    ID3D11Resource* res = nullptr;
    rtv->GetResource(&res);
    ID3D11Texture2D* tex = nullptr;
    if (!res || FAILED(res->QueryInterface(__uuidof(ID3D11Texture2D), (void**)&tex))) {
        if (res) res->Release();
        return false;
    }
    res->Release();
    D3D11_TEXTURE2D_DESC td;
    tex->GetDesc(&td);
    const bool bgra = td.Format == DXGI_FORMAT_B8G8R8A8_UNORM || td.Format == DXGI_FORMAT_B8G8R8A8_UNORM_SRGB;
    const bool rgba = td.Format == DXGI_FORMAT_R8G8B8A8_UNORM || td.Format == DXGI_FORMAT_R8G8B8A8_UNORM_SRGB;
    if (td.SampleDesc.Count != 1 || (!bgra && !rgba)) {
        tex->Release();
        return false;
    }
    D3D11_TEXTURE2D_DESC sd = td;
    sd.Usage = D3D11_USAGE_STAGING;
    sd.BindFlags = 0;
    sd.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    sd.MiscFlags = 0;
    sd.MipLevels = 1;
    sd.ArraySize = 1;
    ID3D11Texture2D* staging = nullptr;
    if (FAILED(g_dev->CreateTexture2D(&sd, nullptr, &staging))) {
        tex->Release();
        return false;
    }
    g_ctx->CopyResource(staging, tex);
    tex->Release();
    D3D11_MAPPED_SUBRESOURCE m;
    bool ok = false;
    if (SUCCEEDED(g_ctx->Map(staging, 0, D3D11_MAP_READ, 0, &m))) {
        FILE* f = std::fopen(path.c_str(), "wb");
        if (f) {
            const int w = (int)td.Width, h = (int)td.Height;
            const int row = (w * 3 + 3) & ~3;
            const unsigned size = 54u + (unsigned)row * (unsigned)h;
            unsigned char hdr[54] = {'B', 'M'};
            auto put32 = [&](int at, unsigned v) { for (int i = 0; i < 4; i++) hdr[at + i] = (unsigned char)(v >> (8 * i)); };
            put32(2, size);
            put32(10, 54);
            put32(14, 40);
            put32(18, (unsigned)w);
            put32(22, (unsigned)h);
            hdr[26] = 1;
            hdr[28] = 24;
            put32(34, (unsigned)row * (unsigned)h);
            std::fwrite(hdr, 1, 54, f);
            std::vector<unsigned char> line((size_t)row, 0);
            for (int y = h - 1; y >= 0; y--) {   // BMP : de bas en haut
                const unsigned char* src = (const unsigned char*)m.pData + (size_t)y * m.RowPitch;
                for (int x = 0; x < w; x++) {
                    const unsigned char* p = src + x * 4;
                    line[x * 3 + 0] = bgra ? p[0] : p[2];
                    line[x * 3 + 1] = p[1];
                    line[x * 3 + 2] = bgra ? p[2] : p[0];
                }
                std::fwrite(line.data(), 1, line.size(), f);
            }
            std::fclose(f);
            ok = true;
        }
        g_ctx->Unmap(staging, 0);
    }
    staging->Release();
    return ok;
}

#else   // pas de Direct3D 11 : pas de mesure

void init() {}
bool available() { return false; }
void frame_begin() {}
void mark(const char*) {}
void frame_end() {}
void stats_begin() {}
void stats_end() {}
bool save_backbuffer_bmp(const std::string&) { return false; }

#endif

}  // namespace gpuprof
