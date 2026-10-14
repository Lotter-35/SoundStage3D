// Petite bibliotheque de maths : vecteurs, matrices (colonnes, comme GLSL), quelques utilitaires.
// Repere : main droite, Y vers le haut. La camera regarde vers -Z dans son repere.
#pragma once
#include <cmath>
#include <cstdint>

static constexpr float PI = 3.14159265358979f;
static constexpr float DEG = PI / 180.0f;

struct vec2 { float x, y; };
struct vec3 {
    float x, y, z;
    vec3() : x(0), y(0), z(0) {}
    constexpr vec3(float a, float b, float c) : x(a), y(b), z(c) {}
    float& operator[](int i) { return (&x)[i]; }
    float operator[](int i) const { return (&x)[i]; }
};
struct vec4 {
    float x, y, z, w;
    vec4() : x(0), y(0), z(0), w(0) {}
    constexpr vec4(float a, float b, float c, float d) : x(a), y(b), z(c), w(d) {}
    vec4(const vec3& v, float d) : x(v.x), y(v.y), z(v.z), w(d) {}
};

inline vec3 operator+(vec3 a, vec3 b) { return {a.x + b.x, a.y + b.y, a.z + b.z}; }
inline vec3 operator-(vec3 a, vec3 b) { return {a.x - b.x, a.y - b.y, a.z - b.z}; }
inline vec3 operator-(vec3 a) { return {-a.x, -a.y, -a.z}; }
inline vec3 operator*(vec3 a, float s) { return {a.x * s, a.y * s, a.z * s}; }
inline vec3 operator*(float s, vec3 a) { return {a.x * s, a.y * s, a.z * s}; }
inline vec3 operator*(vec3 a, vec3 b) { return {a.x * b.x, a.y * b.y, a.z * b.z}; }
inline vec3 operator/(vec3 a, float s) { return a * (1.0f / s); }
inline vec3& operator+=(vec3& a, vec3 b) { a = a + b; return a; }
inline vec3& operator-=(vec3& a, vec3 b) { a = a - b; return a; }
inline vec3& operator*=(vec3& a, float s) { a = a * s; return a; }
inline float dot(vec3 a, vec3 b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
inline vec3 cross(vec3 a, vec3 b) { return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x}; }
inline float length(vec3 a) { return std::sqrt(dot(a, a)); }
inline vec3 normalize(vec3 a) { float l = length(a); return l > 1e-12f ? a / l : vec3(0, 0, 0); }
inline vec3 lerp(vec3 a, vec3 b, float t) { return a + (b - a) * t; }
inline vec3 vmin(vec3 a, vec3 b) { return {std::fmin(a.x, b.x), std::fmin(a.y, b.y), std::fmin(a.z, b.z)}; }
inline vec3 vmax(vec3 a, vec3 b) { return {std::fmax(a.x, b.x), std::fmax(a.y, b.y), std::fmax(a.z, b.z)}; }

inline float clampf(float v, float a, float b) { return v < a ? a : (v > b ? b : v); }
inline float saturate(float v) { return clampf(v, 0.0f, 1.0f); }
inline float lerpf(float a, float b, float t) { return a + (b - a) * t; }
inline float smoothstepf(float a, float b, float x) { float t = saturate((x - a) / (b - a)); return t * t * (3 - 2 * t); }
inline float fractf(float x) { return x - std::floor(x); }

// Matrice 4x4 rangee par colonnes : m[col*4 + row] (meme convention que GLSL / sokol).
struct mat4 {
    float m[16];
    static mat4 identity() { mat4 r{}; r.m[0] = r.m[5] = r.m[10] = r.m[15] = 1; return r; }
    float& at(int row, int col) { return m[col * 4 + row]; }
    float at(int row, int col) const { return m[col * 4 + row]; }
};

inline mat4 operator*(const mat4& a, const mat4& b) {
    mat4 r{};
    for (int c = 0; c < 4; c++)
        for (int rr = 0; rr < 4; rr++) {
            float s = 0;
            for (int k = 0; k < 4; k++) s += a.at(rr, k) * b.at(k, c);
            r.at(rr, c) = s;
        }
    return r;
}

inline vec4 mul(const mat4& a, vec4 v) {
    return {a.at(0, 0) * v.x + a.at(0, 1) * v.y + a.at(0, 2) * v.z + a.at(0, 3) * v.w,
            a.at(1, 0) * v.x + a.at(1, 1) * v.y + a.at(1, 2) * v.z + a.at(1, 3) * v.w,
            a.at(2, 0) * v.x + a.at(2, 1) * v.y + a.at(2, 2) * v.z + a.at(2, 3) * v.w,
            a.at(3, 0) * v.x + a.at(3, 1) * v.y + a.at(3, 2) * v.z + a.at(3, 3) * v.w};
}

// Vue : passe du monde au repere camera (camera en 0, regarde vers -Z).
inline mat4 look_basis(vec3 eye, vec3 right, vec3 up, vec3 fwd) {
    mat4 r = mat4::identity();
    r.at(0, 0) = right.x; r.at(0, 1) = right.y; r.at(0, 2) = right.z; r.at(0, 3) = -dot(right, eye);
    r.at(1, 0) = up.x;    r.at(1, 1) = up.y;    r.at(1, 2) = up.z;    r.at(1, 3) = -dot(up, eye);
    r.at(2, 0) = -fwd.x;  r.at(2, 1) = -fwd.y;  r.at(2, 2) = -fwd.z;  r.at(2, 3) = dot(fwd, eye);
    return r;
}

// Projection perspective "Z inverse" a plan lointain infini, profondeur 0..1 (style D3D/Metal) :
// z = near -> 1, z -> infini -> 0. Precision quasi parfaite sur toute la profondeur.
// Pour OpenGL, les shaders sont compiles avec 'fixup_clipspace' qui convertit en -1..1.
inline mat4 perspective_reverse_z(float fovy, float aspect, float znear) {
    float f = 1.0f / std::tan(fovy * 0.5f);
    mat4 r{};
    r.at(0, 0) = f / aspect;
    r.at(1, 1) = f;
    r.at(2, 3) = znear;
    r.at(3, 2) = -1.0f;
    return r;
}

// Hash entier -> flottant 0..1 (deterministe, pour le placement et le bruit).
inline uint32_t hash_u32(uint32_t x) {
    x ^= x >> 16; x *= 0x7feb352dU; x ^= x >> 15; x *= 0x846ca68bU; x ^= x >> 16;
    return x;
}
inline float hash01(uint32_t x) { return (hash_u32(x) & 0xFFFFFF) / 16777216.0f; }

// Couleur HSV -> RGB (h en 0..1).
inline vec3 hsv2rgb(float h, float s, float v) {
    h = fractf(h) * 6.0f;
    int i = (int)h;
    float f = h - (float)i;
    float p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
    switch (i) {
        case 0: return {v, t, p};
        case 1: return {q, v, p};
        case 2: return {p, v, t};
        case 3: return {p, q, v};
        case 4: return {t, p, v};
        default: return {v, p, q};
    }
}
