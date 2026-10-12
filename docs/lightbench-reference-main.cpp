// =====================================================================================
//  LightBench - banc d'essai de rendu "lumieres de concert"
//  OpenGL 4.5 + compute shaders (GTX 1080 OK)
//
//  Ce que ca teste (tout ce dont on a parle) :
//    1. Lumieres CLUSTEREES : des centaines de spots, chaque pixel ne lit que les lumieres de son cluster
//    2. Ombres STATIQUES : une cubemap de distance par lumiere, cuite une fois au demarrage
//       (une lecture de texture par lumiere et par pixel, orientation du spot sans importance)
//    3. Brouillard en FROXELS : grille 3D alignee sur la camera, accumulation temporelle, integration
//       -> les faisceaux et la fumee eclairee viennent de la, cout presque independant de la resolution
//    4. GI en grille : les lumieres eclairent une grille 3D monde, qui rebondit sur les surfaces
//       ET alimente le brouillard (la piece "s'allume" quand on tire une lyre droit devant)
//    5. Rendu a resolution interne reduite + agrandissement (pas de FSR ici, juste du bilineaire)
//
//  Mesures GPU par passe (timer queries) + percentiles de temps d'image.
// =====================================================================================
#define GLFW_INCLUDE_NONE
#include <GLFW/glfw3.h>
#include "imgui.h"
#include "imgui_impl_glfw.h"
#include "imgui_impl_opengl3.h"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

// ------------------------------------------------------------------------------------
//  Mini chargeur OpenGL (aucune dependance : on charge nous-memes les ~60 fonctions)
// ------------------------------------------------------------------------------------
typedef unsigned int GLenum;
typedef unsigned int GLuint;
typedef int GLint;
typedef int GLsizei;
typedef unsigned int GLbitfield;
typedef float GLfloat;
typedef unsigned char GLboolean;
typedef char GLchar;
typedef unsigned char GLubyte;
typedef ptrdiff_t GLsizeiptr;
typedef ptrdiff_t GLintptr;
typedef unsigned long long GLuint64;

#define GL_COLOR_BUFFER_BIT 0x00004000
#define GL_DEPTH_BUFFER_BIT 0x00000100
#define GL_DEPTH_TEST 0x0B71
#define GL_LESS 0x0201
#define GL_FLOAT 0x1406
#define GL_UNSIGNED_BYTE 0x1401
#define GL_TRIANGLES 0x0004
#define GL_FALSE 0
#define GL_TRUE 1
#define GL_VERTEX_SHADER 0x8B31
#define GL_FRAGMENT_SHADER 0x8B30
#define GL_COMPUTE_SHADER 0x91B9
#define GL_COMPILE_STATUS 0x8B81
#define GL_LINK_STATUS 0x8B82
#define GL_INFO_LOG_LENGTH 0x8B84
#define GL_ARRAY_BUFFER 0x8892
#define GL_UNIFORM_BUFFER 0x8A11
#define GL_SHADER_STORAGE_BUFFER 0x90D2
#define GL_STATIC_DRAW 0x88E4
#define GL_DYNAMIC_DRAW 0x88E8
#define GL_TEXTURE_2D 0x0DE1
#define GL_TEXTURE_3D 0x806F
#define GL_TEXTURE_CUBE_MAP_ARRAY 0x9009
#define GL_TEXTURE_MIN_FILTER 0x2801
#define GL_TEXTURE_MAG_FILTER 0x2800
#define GL_TEXTURE_WRAP_S 0x2802
#define GL_TEXTURE_WRAP_T 0x2803
#define GL_TEXTURE_WRAP_R 0x8072
#define GL_LINEAR 0x2601
#define GL_NEAREST 0x2600
#define GL_CLAMP_TO_EDGE 0x812F
#define GL_RGBA16F 0x881A
#define GL_R32F 0x822E
#define GL_DEPTH_COMPONENT32F 0x8CAC
#define GL_DEPTH_COMPONENT 0x1902
#define GL_RGBA 0x1908
#define GL_RGB 0x1907
#define GL_FRAMEBUFFER 0x8D40
#define GL_COLOR_ATTACHMENT0 0x8CE0
#define GL_DEPTH_ATTACHMENT 0x8D00
#define GL_FRAMEBUFFER_COMPLETE 0x8CD5
#define GL_TEXTURE0 0x84C0
#define GL_READ_ONLY 0x88B8
#define GL_WRITE_ONLY 0x88B9
#define GL_SHADER_IMAGE_ACCESS_BARRIER_BIT 0x00000020
#define GL_SHADER_STORAGE_BARRIER_BIT 0x00002000
#define GL_TEXTURE_FETCH_BARRIER_BIT 0x00000008
#define GL_UNIFORM_BARRIER_BIT 0x00000004
#define GL_TIME_ELAPSED 0x88BF
#define GL_QUERY_RESULT 0x8866
#define GL_QUERY_RESULT_AVAILABLE 0x8867
#define GL_VERSION 0x1F02
#define GL_RENDERER 0x1F01
#define GL_PACK_ALIGNMENT 0x0D05
#define GL_NO_ERROR 0
#define GL_RED 0x1903
#define GL_MAX_TEXTURE_SIZE 0x0D33

#define GL_FUNCS(X)                                                                              \
  X(void, glViewport, GLint, GLint, GLsizei, GLsizei)                                            \
  X(void, glClear, GLbitfield)                                                                   \
  X(void, glClearColor, GLfloat, GLfloat, GLfloat, GLfloat)                                      \
  X(void, glEnable, GLenum)                                                                      \
  X(void, glDisable, GLenum)                                                                     \
  X(void, glDepthFunc, GLenum)                                                                   \
  X(const GLubyte*, glGetString, GLenum)                                                         \
  X(void, glGetIntegerv, GLenum, GLint*)                                                         \
  X(void, glReadPixels, GLint, GLint, GLsizei, GLsizei, GLenum, GLenum, void*)                   \
  X(void, glPixelStorei, GLenum, GLint)                                                          \
  X(void, glFinish, void)                                                                        \
  X(GLenum, glGetError, void)                                                                    \
  X(GLuint, glCreateShader, GLenum)                                                              \
  X(void, glShaderSource, GLuint, GLsizei, const GLchar* const*, const GLint*)                   \
  X(void, glCompileShader, GLuint)                                                               \
  X(void, glGetShaderiv, GLuint, GLenum, GLint*)                                                 \
  X(void, glGetShaderInfoLog, GLuint, GLsizei, GLsizei*, GLchar*)                                \
  X(void, glDeleteShader, GLuint)                                                                \
  X(GLuint, glCreateProgram, void)                                                               \
  X(void, glAttachShader, GLuint, GLuint)                                                        \
  X(void, glLinkProgram, GLuint)                                                                 \
  X(void, glGetProgramiv, GLuint, GLenum, GLint*)                                                \
  X(void, glGetProgramInfoLog, GLuint, GLsizei, GLsizei*, GLchar*)                               \
  X(void, glUseProgram, GLuint)                                                                  \
  X(void, glGenBuffers, GLsizei, GLuint*)                                                        \
  X(void, glBindBuffer, GLenum, GLuint)                                                          \
  X(void, glBufferData, GLenum, GLsizeiptr, const void*, GLenum)                                 \
  X(void, glBufferSubData, GLenum, GLintptr, GLsizeiptr, const void*)                            \
  X(void, glBindBufferBase, GLenum, GLuint, GLuint)                                              \
  X(void, glGenVertexArrays, GLsizei, GLuint*)                                                   \
  X(void, glBindVertexArray, GLuint)                                                             \
  X(void, glVertexAttribPointer, GLuint, GLint, GLenum, GLboolean, GLsizei, const void*)         \
  X(void, glEnableVertexAttribArray, GLuint)                                                     \
  X(void, glDrawArrays, GLenum, GLint, GLsizei)                                                  \
  X(void, glGenTextures, GLsizei, GLuint*)                                                       \
  X(void, glDeleteTextures, GLsizei, const GLuint*)                                              \
  X(void, glBindTexture, GLenum, GLuint)                                                         \
  X(void, glActiveTexture, GLenum)                                                               \
  X(void, glTexParameteri, GLenum, GLenum, GLint)                                                \
  X(void, glTexStorage2D, GLenum, GLsizei, GLenum, GLsizei, GLsizei)                             \
  X(void, glTexStorage3D, GLenum, GLsizei, GLenum, GLsizei, GLsizei, GLsizei)                    \
  X(void, glBindImageTexture, GLuint, GLuint, GLint, GLboolean, GLint, GLenum, GLenum)           \
  X(void, glClearTexImage, GLuint, GLint, GLenum, GLenum, const void*)                           \
  X(void, glGenFramebuffers, GLsizei, GLuint*)                                                   \
  X(void, glDeleteFramebuffers, GLsizei, const GLuint*)                                          \
  X(void, glBindFramebuffer, GLenum, GLuint)                                                     \
  X(void, glFramebufferTexture2D, GLenum, GLenum, GLenum, GLuint, GLint)                         \
  X(GLenum, glCheckFramebufferStatus, GLenum)                                                    \
  X(void, glDispatchCompute, GLuint, GLuint, GLuint)                                             \
  X(void, glMemoryBarrier, GLbitfield)                                                           \
  X(void, glGenQueries, GLsizei, GLuint*)                                                        \
  X(void, glBeginQuery, GLenum, GLuint)                                                          \
  X(void, glEndQuery, GLenum)                                                                    \
  X(void, glGetQueryObjectiv, GLuint, GLenum, GLint*)                                            \
  X(void, glGetQueryObjectui64v, GLuint, GLenum, GLuint64*)                                      \
  X(void, glGetTextureSubImage, GLuint, GLint, GLint, GLint, GLint, GLsizei, GLsizei, GLsizei, GLenum, GLenum, GLsizei, void*)

#define X(ret, name, ...)                                         \
  typedef ret(APIENTRY* PFN_##name)(__VA_ARGS__);                 \
  static PFN_##name name = nullptr;
GL_FUNCS(X)
#undef X

static bool loadGL() {
  bool ok = true;
#define X(ret, name, ...)                                                 \
  name = (PFN_##name)glfwGetProcAddress(#name);                           \
  if (!name) { std::fprintf(stderr, "Fonction OpenGL manquante : %s\n", #name); ok = false; }
  GL_FUNCS(X)
#undef X
  return ok;
}

// ------------------------------------------------------------------------------------
//  Maths minimales (matrices colonne-major, comme OpenGL)
// ------------------------------------------------------------------------------------
struct V3 { float x, y, z; };
static V3 operator+(V3 a, V3 b) { return {a.x + b.x, a.y + b.y, a.z + b.z}; }
static V3 operator-(V3 a, V3 b) { return {a.x - b.x, a.y - b.y, a.z - b.z}; }
static V3 operator*(V3 a, float s) { return {a.x * s, a.y * s, a.z * s}; }
static float dot(V3 a, V3 b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
static V3 cross(V3 a, V3 b) { return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x}; }
static V3 norm(V3 a) { float l = std::sqrt(dot(a, a)); return l > 1e-8f ? a * (1.0f / l) : V3{0, 1, 0}; }
static float clamp01(float v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

struct Mat4 { float m[16]; };
static Mat4 mul(const Mat4& a, const Mat4& b) {
  Mat4 r;
  for (int c = 0; c < 4; ++c)
    for (int rr = 0; rr < 4; ++rr) {
      float s = 0;
      for (int k = 0; k < 4; ++k) s += a.m[k * 4 + rr] * b.m[c * 4 + k];
      r.m[c * 4 + rr] = s;
    }
  return r;
}
static Mat4 perspective(float fovy, float aspect, float n, float f) {
  Mat4 r; std::memset(r.m, 0, sizeof(r.m));
  float t = 1.0f / std::tan(fovy * 0.5f);
  r.m[0] = t / aspect; r.m[5] = t;
  r.m[10] = -(f + n) / (f - n); r.m[11] = -1.0f; r.m[14] = -2.0f * f * n / (f - n);
  return r;
}
static Mat4 lookAt(V3 eye, V3 center, V3 up, Mat4* inv) {
  V3 f = norm(center - eye), s = norm(cross(f, up)), u = cross(s, f);
  Mat4 r; std::memset(r.m, 0, sizeof(r.m));
  r.m[0] = s.x; r.m[4] = s.y; r.m[8] = s.z;
  r.m[1] = u.x; r.m[5] = u.y; r.m[9] = u.z;
  r.m[2] = -f.x; r.m[6] = -f.y; r.m[10] = -f.z;
  r.m[12] = -dot(s, eye); r.m[13] = -dot(u, eye); r.m[14] = dot(f, eye); r.m[15] = 1;
  if (inv) {
    Mat4 i; std::memset(i.m, 0, sizeof(i.m));
    i.m[0] = s.x; i.m[1] = s.y; i.m[2] = s.z;
    i.m[4] = u.x; i.m[5] = u.y; i.m[6] = u.z;
    i.m[8] = -f.x; i.m[9] = -f.y; i.m[10] = -f.z;
    i.m[12] = eye.x; i.m[13] = eye.y; i.m[14] = eye.z; i.m[15] = 1;
    *inv = i;
  }
  return r;
}

static uint32_t hash32(uint32_t x) {
  x ^= x >> 16; x *= 0x7feb352dU; x ^= x >> 15; x *= 0x846ca68bU; x ^= x >> 16; return x;
}
static float rnd(uint32_t i, uint32_t k) { return (hash32(i * 2654435761U + k * 40503U + 12345U) & 0xFFFFFF) / 16777216.0f; }
static float halton(int i, int b) { float f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i /= b; } return r; }
static V3 hsv(float h, float s, float v) {
  h = h - std::floor(h);
  float r = clamp01(std::fabs(h * 6 - 3) - 1), g = clamp01(2 - std::fabs(h * 6 - 2)), b = clamp01(2 - std::fabs(h * 6 - 4));
  return {(1 + s * (r - 1)) * v, (1 + s * (g - 1)) * v, (1 + s * (b - 1)) * v};
}

// ------------------------------------------------------------------------------------
//  Shaders (GLSL 4.50). Decoupes en plusieurs morceaux : la limite de MSVC est 16 Ko par chaine.
// ------------------------------------------------------------------------------------
static const char* SRC_COMMON_A = R"GLSL(#version 450 core
layout(std140, binding=0) uniform Frame {
  mat4 uView; mat4 uInvView; mat4 uViewProj; mat4 uPrevViewProj;
  vec4 uCam;        // xyz position, w temps
  vec4 uProj;       // x tanHalfX, y tanHalfY, z near, w far
  vec4 uFog;        // x densite, y fogNear, z fogFar, w intensite GI->brouillard
  vec4 uFogDim;     // xyz dimensions froxels, w poids de l'historique (0 = temporel desactive)
  vec4 uJitter;     // xyz gigue (-0.5..0.5), w numero d'image
  ivec4 uCounts;    // x nb lumieres, y nb boites, z ombres actives, w GI active
  ivec4 uClusterDim;// xyz dimensions des clusters, w max de lumieres par cluster
  vec4 uClusterZ;   // x near cluster, y far cluster, z taille texel ombre, w force GI
  vec4 uRoomMin; vec4 uRoomMax;
  ivec4 uGiDim;     // xyz dimensions grille GI, w decalage de tranche
  vec4 uGiParams;   // x diviseur de mise a jour, w exposition
  vec4 uScreen;     // xy taille de rendu, zw taille de sortie
  ivec4 uMisc;      // x taille cubemap, y tilesPerRow, z beamMode, w beamSteps
  vec4 uBeamParams; // x beamIntensity, y beamSharpness, z floorRoughness, w floorSpecular
  vec4 uSSParams;   // x ssScatter, y ssRadius, z ssDepthSharp, w ssRaymarch
};
struct Light { vec4 posRange; vec4 dirCos; vec4 colorInt; vec4 params; };
layout(std430, binding=0) buffer LightBuf { Light lights[]; };
layout(std430, binding=1) buffer BoxBuf { vec4 boxes[]; };
layout(std430, binding=2) buffer CountBuf { uint clusterCount[]; };
layout(std430, binding=3) buffer IdxBuf { uint clusterIdx[]; };
layout(std430, binding=4) buffer Tile2dBuf { uint tile2dData[]; };
layout(binding=0) uniform sampler2D uShadow;   // atlas 2D : 6 tuiles (faces) par lumiere
layout(binding=1) uniform sampler3D uGI;
layout(binding=2) uniform sampler3D uHist;
layout(binding=3) uniform sampler3D uInteg;
const float PI = 3.14159265359;

float hash13(vec3 p) {
  p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z);
}
float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  float a = mix(hash13(i), hash13(i + vec3(1,0,0)), f.x);
  float b = mix(hash13(i + vec3(0,1,0)), hash13(i + vec3(1,1,0)), f.x);
  float c = mix(hash13(i + vec3(0,0,1)), hash13(i + vec3(1,0,1)), f.x);
  float d = mix(hash13(i + vec3(0,1,1)), hash13(i + vec3(1,1,1)), f.x);
  return mix(mix(a, b, f.y), mix(c, d, f.y), f.z);
}
float densityField(vec3 p, float t) {
  vec3 q = p * 0.12 + vec3(t * 0.05, t * 0.01, t * 0.03);
  float n = 0.6 * vnoise(q) + 0.3 * vnoise(q * 2.3 + 17.0) + 0.1 * vnoise(q * 5.1);
  float h = exp(-max(p.y - 2.0, 0.0) * 0.10);
  return uFog.x * (0.35 + 1.3 * n) * (0.45 + 0.55 * h);
}
float fogSliceDepth(float t) { return uFog.y * pow(uFog.z / uFog.y, t); }
float fogDepthToT(float d) { return log(d / uFog.y) / log(uFog.z / uFog.y); }

uint clusterIndexFromUV(vec2 uv, float depth) {
  uvec3 dim = uvec3(uClusterDim.xyz);
  uint cx = min(uint(max(uv.x, 0.0) * float(dim.x)), dim.x - 1u);
  uint cy = min(uint(max(uv.y, 0.0) * float(dim.y)), dim.y - 1u);
  float s = log(max(depth, uClusterZ.x) / uClusterZ.x) / log(uClusterZ.y / uClusterZ.x) * float(dim.z);
  uint cz = min(uint(max(s, 0.0)), dim.z - 1u);
  return (cz * dim.y + cy) * dim.x + cx;
}
)GLSL";

static const char* SRC_COMMON_B = R"GLSL(
float goboPattern(float type, float r, float ang) {
  if (type < 0.5) return 1.0;
  if (type < 1.5) return 0.35 + 0.65 * smoothstep(0.35, 0.65, 0.5 + 0.5 * sin(r * 18.0));
  if (type < 2.5) return 0.25 + 0.75 * smoothstep(0.3, 0.7, 0.5 + 0.5 * sin(ang * 8.0));
  vec2 p = vec2(cos(ang), sin(ang)) * r * 5.0;
  float l = length(abs(fract(p) - 0.5));
  return 0.3 + 0.7 * (1.0 - smoothstep(0.26, 0.34, l));
}

// Facteur de spot (cone + attenuation + gobo), sans l'ombre. Ldir = surface -> lumiere.
float spotFactor(Light L, vec3 P, out vec3 Ldir, out float dist, bool useGobo) {
  vec3 v = P - L.posRange.xyz;
  dist = length(v);
  vec3 dfl = v / max(dist, 1e-4);
  Ldir = -dfl;
  float cosA = dot(dfl, L.dirCos.xyz);
  float spot = smoothstep(L.dirCos.w, L.params.x, cosA);
  if (spot <= 0.0) return 0.0;
  float w = clamp(1.0 - pow(dist / L.posRange.w, 4.0), 0.0, 1.0);
  float att = w * w / (dist * dist + 1.0);
  float g = 1.0;
  if (useGobo && L.params.y > 0.5) {
    vec3 axis = L.dirCos.xyz;
    vec3 helper = abs(axis.y) > 0.95 ? vec3(1, 0, 0) : vec3(0, 1, 0);
    vec3 u = normalize(cross(helper, axis));
    vec3 wv = cross(axis, u);
    float tanA = sqrt(max(1.0 - cosA * cosA, 0.0)) / max(cosA, 1e-3);
    float tanO = sqrt(max(1.0 - L.dirCos.w * L.dirCos.w, 0.0)) / L.dirCos.w;
    g = goboPattern(L.params.y, tanA / tanO, atan(dot(dfl, wv), dot(dfl, u)) + L.params.w);
  }
  return spot * att * g;
}

// Lecture manuelle d'une "cubemap" rangee dans un atlas 2D (aucune limite de couches, contrairement aux cubemap arrays)
float shadowStored(uint li, vec3 v) {
  vec3 a = abs(v);
  int face; float ma, sc, tc;
  if (a.x >= a.y && a.x >= a.z) { ma = a.x; if (v.x > 0.0) { face = 0; sc = -v.z; tc = -v.y; } else { face = 1; sc = v.z; tc = -v.y; } }
  else if (a.y >= a.z)          { ma = a.y; if (v.y > 0.0) { face = 2; sc = v.x;  tc = v.z; }  else { face = 3; sc = v.x; tc = -v.z; } }
  else                          { ma = a.z; if (v.z > 0.0) { face = 4; sc = v.x;  tc = -v.y; } else { face = 5; sc = -v.x; tc = -v.y; } }
  vec2 st = (vec2(sc, tc) / ma + 1.0) * 0.5;
  int S = uMisc.x;
  ivec2 p = clamp(ivec2(st * float(S)), ivec2(0), ivec2(S - 1));
  int tile = int(li) * 6 + face;
  ivec2 t = ivec2(tile % uMisc.y, tile / uMisc.y);
  return texelFetch(uShadow, t * S + p, 0).r;
}
float shadowVis(uint li, vec3 P, vec3 lightPos, float bias) {
  if (uCounts.z == 0) return 1.0;
  vec3 v = P - lightPos;
  float d = length(v);
  return (d - bias <= shadowStored(li, v)) ? 1.0 : 0.0;
}

float hgp(float c, float g) { float g2 = g * g; return (1.0 - g2) / pow(1.0 + g2 - 2.0 * g * c, 1.5); }
float phaseFn(float c) { return 0.5 * hgp(c, 0.6) + 0.5 * hgp(c, -0.1); }

bool intersectCone(vec3 ro, vec3 rd, vec3 apex, vec3 axis, float cosAng, float range, out float t0, out float t1) {
  vec3 delta = ro - apex;
  float c2 = cosAng * cosAng;
  float dv = dot(rd, axis);
  float da = dot(delta, axis);
  float d_rd = dot(rd, delta);
  float d_del = dot(delta, delta);

  float A = dv * dv - c2;
  float B = dv * da - c2 * d_rd;
  float C = da * da - c2 * d_del;

  float disc = B * B - A * C;
  if (disc < 0.0) return false;

  float s = sqrt(disc);
  float tin = 0.0, tout = 1e9;

  if (abs(A) < 1e-6) {
    if (abs(B) > 1e-6) {
      float t = -C / (2.0 * B);
      if (dv > 0.0) { tin = t; tout = (range - da) / dv; }
      else { tin = (range - da) / dv; tout = t; }
    } else return false;
  } else if (A < 0.0) {
    float r1 = (-B - s) / A;
    float r2 = (-B + s) / A;
    if (r1 > r2) { float tmp = r1; r1 = r2; r2 = tmp; }
    tin = r1;
    tout = r2;
    if (abs(dv) > 1e-5) {
      float tCap = (range - da) / dv;
      if (dv > 0.0) tout = min(tout, tCap);
      else tin = max(tin, tCap);

      float tApex = -da / dv;
      if (dv > 0.0) tin = max(tin, tApex);
      else tout = min(tout, tApex);
    }
  } else {
    float r1 = (-B - s) / A;
    float r2 = (-B + s) / A;
    if (r1 > r2) { float tmp = r1; r1 = r2; r2 = tmp; }
    float tCap = (range - da) / dv;
    if (dv > 0.0) {
      tin = r2;
      tout = tCap;
    } else {
      tin = tCap;
      tout = r1;
    }
  }

  t0 = max(0.0, tin);
  t1 = tout;
  if (t0 >= t1) return false;

  vec3 mid = ro + rd * (0.5 * (t0 + t1));
  vec3 dMid = mid - apex;
  float distMid = length(dMid);
  return (distMid <= range && distMid > 0.01 && dot(dMid, axis) / distMid >= cosAng * 0.98);
}
)GLSL";

// --- Passe 0 : culling des lumieres par cluster 3D et tuile 2D (colonnes de rayon pour les beams)
static const char* SRC_CULL = R"GLSL(
layout(local_size_x = 64) in;
shared uint sCount;
shared uint sCount2D;
shared vec3 sC2d[12];
shared float sr2d[12];

bool coneSphere(vec3 O, vec3 D, float cosT, float sinT, float R, vec3 C, float r) {
  vec3 V = C - O;
  float V2 = dot(V, V), V1 = dot(V, D);
  float dcp = cosT * sqrt(max(V2 - V1 * V1, 0.0)) - V1 * sinT;
  return !(dcp > r || V1 > r + R || V1 < -r);
}

void main() {
  uint cl = gl_WorkGroupID.x;
  uvec3 dim = uvec3(uClusterDim.xyz);
  if (cl >= dim.x * dim.y * dim.z) return;
  uint cx = cl % dim.x, cy = (cl / dim.x) % dim.y, cz = cl / (dim.x * dim.y);
  if (gl_LocalInvocationIndex == 0u) { sCount = 0u; sCount2D = 0u; }

  vec2 n0 = vec2(float(cx), float(cy)) / vec2(dim.xy) * 2.0 - 1.0;
  vec2 n1 = vec2(float(cx + 1u), float(cy + 1u)) / vec2(dim.xy) * 2.0 - 1.0;
  float zr = log(uClusterZ.y / uClusterZ.x);

  if (cz == 0u && gl_LocalInvocationIndex < 12u) {
    float sa = float(gl_LocalInvocationIndex) / 12.0;
    float sb = float(gl_LocalInvocationIndex + 1u) / 12.0;
    float sd0 = uClusterZ.x * exp(zr * sa);
    float sd1 = uClusterZ.x * exp(zr * sb);
    vec3 mn2 = vec3(1e9), mx2 = vec3(-1e9);
    for (int i = 0; i < 8; i++) {
      vec2 n = vec2((i & 1) != 0 ? n1.x : n0.x, (i & 2) != 0 ? n1.y : n0.y);
      float d = (i & 4) != 0 ? sd1 : sd0;
      vec3 p = vec3(n.x * uProj.x * d, n.y * uProj.y * d, -d);
      mn2 = min(mn2, p); mx2 = max(mx2, p);
    }
    sC2d[gl_LocalInvocationIndex] = (mn2 + mx2) * 0.5;
    sr2d[gl_LocalInvocationIndex] = length(mx2 - mn2) * 0.5 * 1.15;
  }
  barrier();

  float d0 = uClusterZ.x * exp(zr * float(cz) / float(dim.z));
  float d1 = uClusterZ.x * exp(zr * float(cz + 1u) / float(dim.z));
  vec3 mn = vec3(1e9), mx = vec3(-1e9);
  for (int i = 0; i < 8; i++) {
    vec2 n = vec2((i & 1) != 0 ? n1.x : n0.x, (i & 2) != 0 ? n1.y : n0.y);
    float d = (i & 4) != 0 ? d1 : d0;
    vec3 p = vec3(n.x * uProj.x * d, n.y * uProj.y * d, -d);
    mn = min(mn, p); mx = max(mx, p);
  }
  vec3 C = (mn + mx) * 0.5;
  float r = length(mx - mn) * 0.5;

  uint maxPer = uint(uClusterDim.w);
  for (uint i = gl_LocalInvocationIndex; i < uint(uCounts.x); i += 64u) {
    Light L = lights[i];
    vec3 O = (uView * vec4(L.posRange.xyz, 1.0)).xyz;
    vec3 D = normalize(mat3(uView) * L.dirCos.xyz);
    float cosT = L.dirCos.w;
    float sinT = sqrt(max(1.0 - cosT * cosT, 0.0));
    if (coneSphere(O, D, cosT, sinT, L.posRange.w, C, r)) {
      uint s = atomicAdd(sCount, 1u);
      if (s < maxPer) clusterIdx[cl * maxPer + s] = i;
    }
    if (cz == 0u) {
      bool hit2d = false;
      for (int seg = 0; seg < 12; ++seg) {
        if (coneSphere(O, D, cosT, sinT, L.posRange.w, sC2d[seg], sr2d[seg])) {
          hit2d = true;
          break;
        }
      }
      if (hit2d) {
        uint s2 = atomicAdd(sCount2D, 1u);
        if (s2 < 256u) tile2dData[(cx + cy * dim.x) * 257u + 1u + s2] = i;
      }
    }
  }
  barrier();
  if (gl_LocalInvocationIndex == 0u) {
    clusterCount[cl] = min(sCount, maxPer);
    if (cz == 0u) tile2dData[(cx + cy * dim.x) * 257u] = min(sCount2D, 256u);
  }
}
)GLSL";

// --- Cuisson des ombres statiques : distance au premier obstacle, pour chaque direction de chaque lumiere
static const char* SRC_BAKE = R"GLSL(
layout(local_size_x = 8, local_size_y = 8, local_size_z = 1) in;
layout(binding = 3, r32f) writeonly uniform image2D uBake;
float rayBox(vec3 o, vec3 d, vec3 bmin, vec3 bmax) {
  vec3 inv = 1.0 / d;
  vec3 t0 = (bmin - o) * inv, t1 = (bmax - o) * inv;
  vec3 tmin = min(t0, t1), tmax = max(t0, t1);
  float tn = max(max(tmin.x, tmin.y), tmin.z), tf = min(min(tmax.x, tmax.y), tmax.z);
  return (tn <= tf && tf > 0.0 && tn > 0.0) ? tn : 1e9;
}
void main() {
  ivec3 id = ivec3(gl_GlobalInvocationID);
  int size = uMisc.x;
  if (id.x >= size || id.y >= size) return;
  int layer = id.z, face = layer % 6, li = layer / 6;
  vec2 st = (vec2(id.xy) + 0.5) / float(size) * 2.0 - 1.0;
  float sc = st.x, tc = st.y;
  vec3 d;
  if (face == 0) d = vec3(1.0, -tc, -sc);
  else if (face == 1) d = vec3(-1.0, -tc, sc);
  else if (face == 2) d = vec3(sc, 1.0, tc);
  else if (face == 3) d = vec3(sc, -1.0, -tc);
  else if (face == 4) d = vec3(sc, -tc, 1.0);
  else d = vec3(-sc, -tc, -1.0);
  d = normalize(d);
  d += vec3(1e-7);
  vec3 o = lights[li].posRange.xyz;
  vec3 tw = mix((uRoomMin.xyz - o) / d, (uRoomMax.xyz - o) / d, greaterThan(d, vec3(0.0)));
  float t = min(min(tw.x, tw.y), tw.z);
  for (int b = 0; b < uCounts.y; b++) t = min(t, rayBox(o, d, boxes[b * 2].xyz, boxes[b * 2 + 1].xyz));
  ivec2 tile = ivec2(layer % uMisc.y, layer / uMisc.y);
  imageStore(uBake, tile * size + id.xy, vec4(t));
}
)GLSL";

// --- GI en grille 3D monde : lumiere recue par chaque cellule (mise a jour par tranches, 1/div par image)
static const char* SRC_GI = R"GLSL(
layout(local_size_x = 4, local_size_y = 4, local_size_z = 4) in;
layout(binding = 2, rgba16f) writeonly uniform image3D uGiOut;
void main() {
  ivec3 id = ivec3(gl_GlobalInvocationID);
  int div = int(uGiParams.x);
  int zi = id.z * div + uGiDim.w;
  if (id.x >= uGiDim.x || id.y >= uGiDim.y || zi >= uGiDim.z) return;
  vec3 P = uRoomMin.xyz + (vec3(id.x, id.y, zi) + 0.5) / vec3(uGiDim.xyz) * (uRoomMax.xyz - uRoomMin.xyz);
  vec3 E = vec3(0.0);
  for (uint i = 0u; i < uint(uCounts.x); i++) {
    Light L = lights[i];
    vec3 Ld; float dist;
    float f = spotFactor(L, P, Ld, dist, false);
    if (f <= 0.0) continue;
    float sh = shadowVis(i, P, L.posRange.xyz, 0.2 + dist * uClusterZ.z);
    E += L.colorInt.rgb * L.colorInt.w * f * sh;
  }
  imageStore(uGiOut, ivec3(id.x, id.y, zi), vec4(E, 1.0));
}
)GLSL";

// --- Brouillard : injection de la lumiere dans chaque froxel (+ reprojection temporelle)
static const char* SRC_INJECT = R"GLSL(
layout(local_size_x = 8, local_size_y = 8, local_size_z = 4) in;
layout(binding = 0, rgba16f) writeonly uniform image3D uOut;
void main() {
  ivec3 id = ivec3(gl_GlobalInvocationID);
  ivec3 dim = ivec3(uFogDim.xyz);
  if (any(greaterThanEqual(id, dim))) return;
  vec3 uvw = (vec3(id) + 0.5 + uJitter.xyz) / vec3(dim);
  float depth = fogSliceDepth(uvw.z);
  vec2 ndc = uvw.xy * 2.0 - 1.0;
  vec3 vp = vec3(ndc.x * uProj.x * depth, ndc.y * uProj.y * depth, -depth);
  vec3 wp = (uInvView * vec4(vp, 1.0)).xyz;
  float dens = densityField(wp, uCam.w);
  vec3 viewRay = normalize(wp - uCam.xyz);
  vec3 acc = vec3(0.0);
  uint ci = clusterIndexFromUV(uvw.xy, depth);
  uint cnt = clusterCount[ci];
  uint maxPer = uint(uClusterDim.w);
  for (uint k = 0u; k < cnt; k++) {
    uint li = clusterIdx[ci * maxPer + k];
    Light L = lights[li];
    vec3 Ld; float dist;
    float f = spotFactor(L, wp, Ld, dist, true);
    if (f <= 0.0) continue;
    float sh = shadowVis(li, wp, L.posRange.xyz, 0.25 + dist * uClusterZ.z);
    if (sh <= 0.0) continue;
    float ph = phaseFn(dot(-Ld, -viewRay));
    acc += L.colorInt.rgb * L.colorInt.w * f * sh * ph;
  }
  vec3 amb = vec3(0.0);
  if (uCounts.w != 0)
    amb = texture(uGI, (wp - uRoomMin.xyz) / (uRoomMax.xyz - uRoomMin.xyz)).rgb * uFog.w;
  vec4 res = vec4((acc + amb) * dens, dens);
  if (uFogDim.w > 0.0) {
    vec4 pc = uPrevViewProj * vec4(wp, 1.0);
    if (pc.w > 0.01) {
      vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
      float pt = fogDepthToT(pc.w);
      if (all(greaterThanEqual(vec3(puv, pt), vec3(0.0))) && all(lessThanEqual(vec3(puv, pt), vec3(1.0))))
        res = mix(res, texture(uHist, vec3(puv, pt)), uFogDim.w);
    }
  }
  imageStore(uOut, id, res);
}
)GLSL";

// --- Brouillard : integration front-to-back le long de la profondeur
static const char* SRC_INTEGRATE = R"GLSL(
layout(local_size_x = 8, local_size_y = 8) in;
layout(binding = 0, rgba16f) readonly uniform image3D uCur;
layout(binding = 1, rgba16f) writeonly uniform image3D uOut;
void main() {
  ivec2 id = ivec2(gl_GlobalInvocationID.xy);
  ivec3 dim = ivec3(uFogDim.xyz);
  if (any(greaterThanEqual(id, dim.xy))) return;
  vec3 acc = vec3(0.0);
  float T = 1.0;
  for (int z = 0; z < dim.z; z++) {
    vec4 s = imageLoad(uCur, ivec3(id, z));
    float d0 = fogSliceDepth(float(z) / float(dim.z));
    float d1 = fogSliceDepth(float(z + 1) / float(dim.z));
    float ext = max(s.a, 1e-6);
    float Tz = exp(-ext * (d1 - d0));
    acc += T * (s.rgb - s.rgb * Tz) / ext;
    T *= Tz;
    imageStore(uOut, ivec3(id, z), vec4(acc, T));
  }
}
)GLSL";

// --- Decor : lumieres clusterees + ombres statiques + GI + brouillard applique directement
static const char* SRC_SCENE_VS = R"GLSL(
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNrm;
layout(location = 2) in float aMat;
out vec3 vPos; out vec3 vNrm; flat out float vMat;
void main() {
  vPos = aPos; vNrm = aNrm; vMat = aMat;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}
)GLSL";

static const char* SRC_SCENE_FS = R"GLSL(
in vec3 vPos; in vec3 vNrm; flat in float vMat;
layout(location = 0) out vec4 outColor;

void material(float m, vec3 P, out vec3 albedo, out float rough) {
  if (m < 0.5) {
    vec2 g = P.xz;
    vec2 cell = abs(fract(g) - 0.5);
    float line = smoothstep(0.46, 0.5, max(cell.x, cell.y));
    float big = hash13(vec3(floor(g / 4.0), 1.0));
    albedo = mix(vec3(0.10, 0.10, 0.11), vec3(0.22, 0.22, 0.24), line * 0.6) * (0.8 + 0.4 * big);
    rough = clamp(0.28 * uBeamParams.z, 0.04, 0.95);
  } else if (m < 1.5) {
    float panel = step(0.5, fract(P.x * 0.25 + P.z * 0.25));
    albedo = mix(vec3(0.55, 0.50, 0.45), vec3(0.45, 0.42, 0.40), panel);
    rough = 0.8;
  } else if (m < 2.5) { albedo = vec3(0.18); rough = 0.9; }
  else if (m < 3.5) { albedo = vec3(0.06); rough = 0.4; }
  else { albedo = vec3(0.50, 0.48, 0.45); rough = 0.85; }
}

void main() {
  vec3 N = normalize(vNrm);
  vec3 P = vPos;
  vec3 V = normalize(uCam.xyz - P);
  vec3 albedo; float rough;
  material(vMat, P, albedo, rough);
  float a = rough * rough, a2 = a * a;

  float viewDepth = 1.0 / gl_FragCoord.w;
  vec2 uv = gl_FragCoord.xy / uScreen.xy;
  uint ci = clusterIndexFromUV(uv, viewDepth);
  uint cnt = clusterCount[ci];
  uint maxPer = uint(uClusterDim.w);

  vec3 col = vec3(0.0);
  float specBoost = (vMat < 0.5) ? uBeamParams.w : 1.0;

  for (uint k = 0u; k < cnt; k++) {
    uint li = clusterIdx[ci * maxPer + k];
    Light L = lights[li];
    vec3 Ld; float dist;
    float f = spotFactor(L, P, Ld, dist, true);
    if (f <= 0.0) continue;
    float NoL = dot(N, Ld);
    if (NoL <= 0.0) continue;
    float bias = 0.03 + dist * uClusterZ.z * 1.5 / max(NoL, 0.2);
    float sh = shadowVis(li, P + N * 0.03, L.posRange.xyz, bias);
    if (sh <= 0.0) continue;
    vec3 rad = L.colorInt.rgb * L.colorInt.w * f * sh;
    vec3 H = normalize(Ld + V);
    float NoH = max(dot(N, H), 0.0), VoH = max(dot(V, H), 0.0), LoH = max(dot(Ld, H), 0.0);
    float dd = NoH * NoH * (a2 - 1.0) + 1.0;
    float D = a2 / (PI * dd * dd);
    float F = 0.04 + 0.96 * pow(1.0 - VoH, 5.0);
    float vis = 0.25 / max(LoH * LoH, 0.05);
    col += rad * NoL * (albedo / PI + vec3(D * F * vis) * specBoost);
  }

  vec3 amb = vec3(0.004) * albedo;
  if (uCounts.w != 0) {
    vec3 gp = (P + N * 0.4 - uRoomMin.xyz) / (uRoomMax.xyz - uRoomMin.xyz);
    amb += albedo * texture(uGI, gp).rgb * uClusterZ.w;
  }
  col += amb;

  // --- Rendu des faisceaux lumineux directs en 4K (Modes 1, 2, 3, 4 ; le Mode 5 est deporte dans progSSBeam)
  vec3 beamAccum = vec3(0.0);
  int bMode = uMisc.z;
  if (bMode > 0 && bMode < 5) {
    int bSteps = max(4, uMisc.w);
    float bInt = uBeamParams.x * uFog.x * 0.12;
    vec3 ro = uCam.xyz;
    vec3 rd = normalize(P - ro);
    float surfDist = length(P - ro);

    uvec3 dim = uvec3(uClusterDim.xyz);
    uint cx = min(uint(max(uv.x, 0.0) * float(dim.x)), dim.x - 1u);
    uint cy = min(uint(max(uv.y, 0.0) * float(dim.y)), dim.y - 1u);
    uint t2d = cx + cy * dim.x;
    uint numBeamL = min(tile2dData[t2d * 257u], 256u);

    for (uint k = 0u; k < numBeamL; ++k) {
      uint li = tile2dData[t2d * 257u + 1u + k];
      Light L = lights[li];
      vec3 apex = L.posRange.xyz;
      float range = L.posRange.w;
      vec3 axis = L.dirCos.xyz;
      float cosOuter = L.dirCos.w;

      // Culling analytique instantane par sphere englobante du cone (3 instructions GPU)
      vec3 sphC = apex + axis * (range * 0.5);
      float sphR = range * 0.65;
      vec3 oc = sphC - ro;
      float tProj = dot(oc, rd);
      float d2 = dot(oc, oc) - tProj * tProj;
      if (d2 > sphR * sphR || tProj + sphR < 0.0 || tProj - sphR > surfDist) continue;

      float t0, t1;
      if (intersectCone(ro, rd, apex, axis, cosOuter, range, t0, t1)) {
        float tExit = min(t1, surfDist);
        if (t0 < tExit) {
          float segLen = tExit - t0;
          if (bMode == 1 || bMode == 4) {
            // Mode 1 & 4 : Raymarching precis dans le volume du cone (8 a 16 pas)
            float stepSize = segLen / float(bSteps);
            vec3 curBeam = vec3(0.0);
            for (int s = 0; s < bSteps; ++s) {
              float t = t0 + (float(s) + 0.5) * stepSize;
              vec3 smpP = ro + rd * t;
              vec3 Ld; float dist;
              float f = spotFactor(L, smpP, Ld, dist, true);
              if (f > 0.0) {
                float sh = shadowVis(li, smpP, apex, 0.25 + dist * uClusterZ.z);
                float phase = phaseFn(dot(-Ld, -rd));
                curBeam += L.colorInt.rgb * L.colorInt.w * (f * sh * phase) * stepSize;
              }
            }
            beamAccum += curBeam * bInt;
          } else if (bMode == 2) {
            // Mode 2 : Integration Analytique par quadrature a 3 points (0 boucle for, cylindre lisse)
            float tA = mix(t0, tExit, 0.2113);
            float tB = mix(t0, tExit, 0.5000);
            float tC = mix(t0, tExit, 0.7887);
            vec3 pB = ro + rd * tB;
            vec3 Ld; float dist;
            float fB = spotFactor(L, pB, Ld, dist, true);
            float fA = spotFactor(L, ro + rd * tA, Ld, dist, false);
            float fC = spotFactor(L, ro + rd * tC, Ld, dist, false);
            float fAvg = 0.28 * fA + 0.44 * fB + 0.28 * fC;
            if (fAvg > 0.0) {
              float sh = shadowVis(li, pB, apex, 0.25 + dist * uClusterZ.z);
              float phase = phaseFn(dot(-Ld, -rd));
              beamAccum += L.colorInt.rgb * L.colorInt.w * (fAvg * sh * phase) * segLen * bInt;
            }
          } else if (bMode == 3) {
            // Mode 3 : Faisceaux Doux (Soft Optical Beams, 300+ FPS)
            float tMid = 0.5 * (t0 + tExit);
            vec3 smpP = ro + rd * tMid;
            float dist = length(smpP - apex);
            float fade = smoothstep(0.0, 1.2, segLen);
            float phase = phaseFn(dot(axis, rd));
            beamAccum += L.colorInt.rgb * L.colorInt.w * (fade / (1.0 + 0.03 * dist * dist)) * segLen * bInt * 0.45 * phase;
          }
        }
      }
    }
  }

  // Brouillard volumetrique Froxels 3D (pour Mode 0 ou Mode 4 Hybride)
  if (bMode == 0 || bMode == 4) {
    if (uFog.x > 0.0) {
      float t = fogDepthToT(max(viewDepth, uFog.y));
      float w = clamp(t - 0.5 / uFogDim.z, 0.0, 1.0);
      vec4 fg = texture(uInteg, vec3(uv, w));
      col = col * fg.a + fg.rgb;
    }
  }
  col += beamAccum;

  // On stocke viewDepth dans le canal alpha (.a) pour le Screen-Space Depth Scattering !
  outColor = vec4(min(col, vec3(60000.0)), clamp(viewDepth, 0.1, 200.0));
}
)GLSL";

// --- Passe Mode 5 : Screen-Space Depth Scattering (rendu volumetrique basse resolution + damier de profondeur Min/Max)
static const char* SRC_SSBEAM = R"GLSL(
layout(local_size_x = 8, local_size_y = 8) in;
layout(binding = 4) uniform sampler2D uHdr;
layout(binding = 0, rgba16f) writeonly uniform image2D uSSOut;

void main() {
  ivec2 id = ivec2(gl_GlobalInvocationID.xy);
  ivec2 ssDim = imageSize(uSSOut);
  if (any(greaterThanEqual(id, ssDim))) return;

  vec2 uv = (vec2(id) + 0.5) / vec2(ssDim);

  // Downsampling de profondeur en damier Min/Max (Checkerboard Depth) pour preserver les silhouettes 4K
  ivec2 fullDim = ivec2(uScreen.xy);
  ivec2 baseCoord = clamp(ivec2(uv * uScreen.xy), ivec2(0), fullDim - 2);
  float d00 = texelFetch(uHdr, baseCoord, 0).a;
  float d10 = texelFetch(uHdr, baseCoord + ivec2(1, 0), 0).a;
  float d01 = texelFetch(uHdr, baseCoord + ivec2(0, 1), 0).a;
  float d11 = texelFetch(uHdr, baseCoord + ivec2(1, 1), 0).a;
  float dMin = min(min(d00, d10), min(d01, d11));
  float dMax = max(max(d00, d10), max(d01, d11));
  float viewDepth = (((id.x + id.y) & 1) == 0) ? dMin : dMax;

  vec2 ndc = uv * 2.0 - 1.0;
  vec3 vp = vec3(ndc.x * uProj.x * viewDepth, ndc.y * uProj.y * viewDepth, -viewDepth);
  vec3 P = (uInvView * vec4(vp, 1.0)).xyz;
  vec3 ro = uCam.xyz;
  vec3 rd = normalize(P - ro);
  float surfDist = length(P - ro);

  uvec3 dim = uvec3(uClusterDim.xyz);
  uint cx = min(uint(max(uv.x, 0.0) * float(dim.x)), dim.x - 1u);
  uint cy = min(uint(max(uv.y, 0.0) * float(dim.y)), dim.y - 1u);
  uint t2d = cx + cy * dim.x;
  uint numBeamL = min(tile2dData[t2d * 257u], 256u);

  int bSteps = max(4, uMisc.w);
  bool useRaymarch = (uSSParams.w > 0.5);
  float bInt = uBeamParams.x * uFog.x * 0.12;
  vec3 beamAccum = vec3(0.0);

  for (uint k = 0u; k < numBeamL; ++k) {
    uint li = tile2dData[t2d * 257u + 1u + k];
    Light L = lights[li];
    vec3 apex = L.posRange.xyz;
    float range = L.posRange.w;
    vec3 axis = L.dirCos.xyz;
    float cosOuter = L.dirCos.w;

    vec3 sphC = apex + axis * (range * 0.5);
    float sphR = range * 0.65;
    vec3 oc = sphC - ro;
    float tProj = dot(oc, rd);
    float d2 = dot(oc, oc) - tProj * tProj;
    if (d2 > sphR * sphR || tProj + sphR < 0.0 || tProj - sphR > surfDist) continue;

    float t0, t1;
    if (intersectCone(ro, rd, apex, axis, cosOuter, range, t0, t1)) {
      float tExit = min(t1, surfDist);
      if (t0 < tExit) {
        float segLen = tExit - t0;
        if (useRaymarch) {
          float stepSize = segLen / float(bSteps);
          vec3 curBeam = vec3(0.0);
          for (int s = 0; s < bSteps; ++s) {
            float t = t0 + (float(s) + 0.5) * stepSize;
            vec3 smpP = ro + rd * t;
            vec3 Ld; float dist;
            float f = spotFactor(L, smpP, Ld, dist, true);
            if (f > 0.0) {
              float sh = shadowVis(li, smpP, apex, 0.25 + dist * uClusterZ.z);
              float phase = phaseFn(dot(-Ld, -rd));
              curBeam += L.colorInt.rgb * L.colorInt.w * (f * sh * phase) * stepSize;
            }
          }
          beamAccum += curBeam * bInt;
        } else {
          float tA = mix(t0, tExit, 0.2113);
          float tB = mix(t0, tExit, 0.5000);
          float tC = mix(t0, tExit, 0.7887);
          vec3 pB = ro + rd * tB;
          vec3 Ld; float dist;
          float fB = spotFactor(L, pB, Ld, dist, true);
          float fA = spotFactor(L, ro + rd * tA, Ld, dist, false);
          float fC = spotFactor(L, ro + rd * tC, Ld, dist, false);
          float fAvg = 0.28 * fA + 0.44 * fB + 0.28 * fC;
          if (fAvg > 0.0) {
            float sh = shadowVis(li, pB, apex, 0.25 + dist * uClusterZ.z);
            float phase = phaseFn(dot(-Ld, -rd));
            beamAccum += L.colorInt.rgb * L.colorInt.w * (fAvg * sh * phase) * segLen * bInt;
          }
        }
      }
    }
  }

  imageStore(uSSOut, id, vec4(min(beamAccum, vec3(60000.0)), viewDepth));
}
)GLSL";

// --- Post : Upsampling Bilateral 4K + Screen-Space Depth Scattering + Tonemapping ACES
static const char* SRC_POST_VS = R"GLSL(
out vec2 vUV;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUV = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
)GLSL";

static const char* SRC_POST_FS = R"GLSL(
in vec2 vUV;
layout(binding = 4) uniform sampler2D uHdr;
layout(binding = 5) uniform sampler2D uSSBeam;
layout(location = 0) out vec4 outColor;
void main() {
  vec4 centerHdr = texture(uHdr, vUV);
  vec3 col = centerHdr.rgb;
  float centerDepth = max(centerHdr.a, 0.1);
  int bMode = uMisc.z;

  // --- 1. Mode 5 : Joint Bilateral Depth-Aware Upsampling (reconstruction 4K nette sur les piliers)
  if (bMode == 5) {
    vec2 ssTexel = 1.0 / vec2(textureSize(uSSBeam, 0));
    float depthSharp = 35.0 * uSSParams.z;
    vec3 beamSum = vec3(0.0);
    float wSum = 0.0;

    for (int dy = -1; dy <= 1; ++dy) {
      for (int dx = -1; dx <= 1; ++dx) {
        vec2 suv = clamp(vUV + vec2(float(dx), float(dy)) * ssTexel, vec2(0.001), vec2(0.999));
        vec4 s = texture(uSSBeam, suv);
        float relDz = abs(centerDepth - s.a) / max(centerDepth, 0.5);
        float wDepth = exp(-relDz * relDz * depthSharp);
        float wSpat = (dx == 0 && dy == 0) ? 1.0 : ((dx == 0 || dy == 0) ? 0.6 : 0.35);
        float w = wSpat * wDepth;
        beamSum += s.rgb * w;
        wSum += w;
      }
    }
    vec3 upsampledBeam = (wSum > 1e-4) ? (beamSum / wSum) : texture(uSSBeam, vUV).rgb;
    col += upsampledBeam;
  }

  // --- 2. Screen-Space Depth Scattering (Diffusion atmospherique optique guidee par la profondeur)
  float scatterStrength = uSSParams.x;
  if (scatterStrength > 0.005) {
    float aspect = uScreen.x / max(uScreen.y, 1.0);
    float rad = uSSParams.y * 0.022 / clamp(centerDepth * 0.06, 0.45, 2.5);
    vec2 stepScale = vec2(rad / aspect, rad);

    const vec2 poisson[8] = vec2[8](
      vec2(-0.326, -0.406), vec2(-0.840, -0.074),
      vec2(-0.696,  0.457), vec2(-0.203,  0.621),
      vec2( 0.962, -0.195), vec2( 0.473, -0.480),
      vec2( 0.519,  0.767), vec2( 0.185, -0.893)
    );

    vec3 scatterAcc = vec3(0.0);
    float scatterW = 0.0;
    for (int i = 0; i < 8; ++i) {
      vec2 tuv = clamp(vUV + poisson[i] * stepScale, vec2(0.001), vec2(0.999));
      vec4 tapHdr = texture(uHdr, tuv);
      float tapDepth = max(tapHdr.a, 0.1);
      vec3 tapCol = tapHdr.rgb;
      if (bMode == 5) {
        tapCol += texture(uSSBeam, tuv).rgb;
      }
      // Occultation physique asymetrique : un pilier au 1er plan bloque la lumiere derriere lui,
      // mais une lumiere devant un mur diffuse librement son halo dans l'air !
      float dz = tapDepth - centerDepth;
      float wOcc = (dz > 0.3) ? exp(-dz * dz * 1.8) : exp(-dz * dz * 0.03);
      scatterAcc += tapCol * wOcc;
      scatterW += wOcc;
    }
    if (scatterW > 1e-4) {
      vec3 glow = scatterAcc / scatterW;
      col = mix(col, col + glow * 0.45, clamp(scatterStrength * 0.5, 0.0, 0.85));
    }
  }

  vec3 c = col * uGiParams.w;
  c = (c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14);
  c = pow(clamp(c, 0.0, 1.0), vec3(1.0 / 2.2));
  outColor = vec4(c, 1.0);
}
)GLSL";

// ------------------------------------------------------------------------------------
//  Donnees partagees CPU <-> GPU
// ------------------------------------------------------------------------------------
struct FrameUBO {  // doit correspondre exactement au bloc "Frame" (std140)
  float view[16], invView[16], viewProj[16], prevViewProj[16];
  float cam[4], proj[4], fog[4], fogDim[4], jitter[4];
  int counts[4], clusterDim[4];
  float clusterZ[4], roomMin[4], roomMax[4];
  int giDim[4];
  float giParams[4], screen[4];
  int misc[4];
  float beamParams[4];
  float ssParams[4];
};
struct GPULight { float posRange[4], dirCos[4], colorInt[4], params[4]; };
struct LightStatic {
  V3 pos, target; int ax1, ax2;
  float hue, outer, innerFrac, range, baseI; int gobo;
  float f1, f2, p1, p2, amp1, amp2, pulseF, pulseP, spin;
};
struct Box { V3 mn, mx; float mat; };

struct Options {
  int lights = 256, maxLights = 1024, shadowRes = 64, fog = 2;
  float scale = 1.0f;
  int width = 3840, height = 2160;
  bool fullscreen = false, gi = true, shadows = true, vsync = false, bench = false, temporal = true;
  const char* shot = nullptr;
  int frames = 0;
};

static const V3 ROOM_MIN = {-20, 0, -30}, ROOM_MAX = {20, 12, 30};
static const int CLUSTER_DIM[3] = {24, 14, 24};
static const int MAX_PER_CLUSTER = 128;
static const int GI_DIM[3] = {48, 16, 64};
static const int GI_DIV = 4;
static bool g_havePrev = false;
struct FogPreset {
  const char* label;
  const char* shortName;
  int w, h, d;
};
static const FogPreset FOG_PRESETS[] = {
  { "0. Desactive", "off", 0, 0, 0 },
  { "1. Basse (96x54 x 48)  [~6 Mo VRAM]", "96x54x48", 96, 54, 48 },
  { "2. Moyenne (160x90 x 64)  [~22 Mo VRAM]", "160x90x64", 160, 90, 64 },
  { "3. Haute (240x135 x 96)  [~75 Mo VRAM]", "240x135x96", 240, 135, 96 },
  { "4. Ultra (320x180 x 96)  [~133 Mo VRAM]", "320x180x96", 320, 180, 96 },
  { "5. Extreme (480x270 x 96)  [~298 Mo VRAM]", "480x270x96", 480, 270, 96 },
  { "6. qHD 540p (960x540 x 64)  [~796 Mo VRAM]", "960x540x64", 960, 540, 64 },
  { "7. HD 720p (1280x720 x 64)  [~1.4 Go VRAM]", "1280x720x64", 1280, 720, 64 },
  { "8. Full HD 1080p (1920x1080 x 32)  [~1.6 Go VRAM]", "1080px32", 1920, 1080, 32 },
  { "9. Full HD 1080p Max (1920x1080 x 48)  [~2.4 Go VRAM]", "1080px48", 1920, 1080, 48 },
  { "10. Full HD 1080p Ultra (1920x1080 x 64)  [~3.2 Go VRAM]", "1080px64", 1920, 1080, 64 },
  { "11. 2K QHD 1440p (2560x1440 x 32)  [~2.8 Go VRAM]", "1440px32", 2560, 1440, 32 },
  { "12. 4K UHD Ecran (3840x2160 x 16)  [~3.2 Go VRAM]", "4Kx16", 3840, 2160, 16 },
  { "13. 4K UHD Ecran Max (3840x2160 x 24)  [~4.8 Go VRAM]", "4Kx24", 3840, 2160, 24 },
  { "14. 4K UHD Ecran Extreme (3840x2160 x 32)  [~6.4 Go VRAM]", "4Kx32", 3840, 2160, 32 }
};
static const int NUM_FOG_PRESETS = (int)(sizeof(FOG_PRESETS) / sizeof(FOG_PRESETS[0]));
static const float SCALE_STEPS[4] = {1.0f, 0.77f, 0.67f, 0.5f};

static int g_fogW = 160, g_fogH = 90, g_fogD = 64;
static int g_customFogW = 160, g_customFogH = 90, g_customFogD = 64;
static bool g_fogMatchScreen = false;
static int g_fogMatchSlices = 32;
static bool g_lockAspect = true;

static int   g_beamMode = 5; // 0=Froxels 3D, 1=Cones 4K, 2=Analytique 4K, 3=Soft 4K, 4=Hybride, 5=Screen-Space Depth Scattering
static int   g_beamSteps = 10;
static float g_beamIntensity = 1.0f;
static float g_beamSharpness = 1.0f;
static float g_floorRoughness = 1.0f; // Multiplicateur rugosite sol (1.0 = standard)
static float g_floorSpecular = 1.5f;  // Boost reflets speculaires au sol

// Parametres Screen-Space Depth Scattering (Mode 5 + Halo de profondeur)
static int   g_ssDiv = 3;             // Diviseur de resolution Screen-Space : 2 (1/2), 3 (1/3), 4 (1/4)
static float g_ssScatter = 0.50f;     // Intensite de la diffusion atmospherique Screen-Space (Depth Glow)
static float g_ssRadius = 1.0f;       // Rayon d'etendue de la diffusion Screen-Space
static float g_ssDepthSharp = 1.5f;   // Nettete du filtre bilateral de profondeur sur les contours 4K
static bool  g_ssRaymarch = false;    // false = Quadrature Analytique 3-pts (ultra rapide), true = Raymarching dans le cone

// ------------------------------------------------------------------------------------
//  Etat global
// ------------------------------------------------------------------------------------
static GLFWwindow* g_win = nullptr;
static Options opt;
static GLuint progCull, progBake, progGI, progInject, progInteg, progSSBeam, progScene, progPost;
static GLuint vaoScene, vboScene, vaoEmpty;
static int sceneVerts = 0;
static GLuint uboFrame, ssboLights, ssboBoxes, ssboCount, ssboIdx, ssboTile2d;
static GLuint texShadow = 0, texGI = 0, texFog[2] = {0, 0}, texInteg = 0, texHdr = 0, texDepth = 0, texSSBeam = 0, fbo = 0;
static int rw = 0, rh = 0, ow = 0, oh = 0, ssW = 0, ssH = 0;
static int fogQuality = -1, scaleIdx = 0;
static int numLights = 256;
static std::vector<Box> boxes;
static std::vector<LightStatic> lightStatics;
static std::vector<GPULight> lightsGPU;
static GLuint qry[4][6];
static bool qValid[4] = {false, false, false, false};
static double passMs[6] = {0, 0, 0, 0, 0, 0};
static int fogPing = 0;  // texFog[fogPing] = historique, texFog[1-fogPing] = image courante
static int frameIdx = 0;
static bool freeCam = true; // Mode deplacement libre actif par defaut
static V3 camPos = {0.0f, 1.8f, 16.0f}; // Position humaine au milieu de la salle, face a la scene
static float camYaw = 0.0f, camPitch = -0.05f;
static float g_camMoveSpeed = 16.0f;
static float g_mouseSensitivity = 0.6f;
static bool  g_roomCollision = true;
static bool  g_showMenu = true;
static bool  g_mouseLookActive = false;

// Parametres reglables des projecteurs et lumieres
static float g_lightIntensity = 1.0f;
static float g_lightSpeed = 1.0f;
static float g_motionAmp = 1.0f;
static float g_beamAngleMult = 1.0f;
static float g_lightRange = 60.0f;
static float g_colorSpeed = 1.0f;
static float g_pulseSpeed = 1.0f;
static int   g_colorPreset = 0; // 0=Arc-en-ciel, 1=Cyan & Magenta, 2=Or & Ambre, 3=Rouge Passion, 4=Bleu & Blanc, 5=Custom
static bool  g_customColor = false;
static float g_lightColorRGB[3] = {1.0f, 0.85f, 0.35f};
static int   g_goboOverride = 0; // 0=Mix normal, 1=Desactive (lisse), 2=Anneaux, 3=Rayons etoiles

static bool keyToggle[512];
static double lastMouseX = 0, lastMouseY = 0;
static int g_cullDispatch = 0;
static int g_atlasW = 0, g_atlasH = 0, g_tilesPerRow = 0;

static void checkGL(const char* where) {
  GLenum e = glGetError();
  if (e != GL_NO_ERROR) std::fprintf(stderr, "[GL erreur 0x%X] %s\n", e, where);
}

// ------------------------------------------------------------------------------------
//  Shaders : compilation
// ------------------------------------------------------------------------------------
static GLuint compileStage(GLenum type, const char* name, const char* tail) {
  const char* parts[3] = {SRC_COMMON_A, SRC_COMMON_B, tail};
  GLuint s = glCreateShader(type);
  glShaderSource(s, 3, parts, nullptr);
  glCompileShader(s);
  GLint ok = 0; glGetShaderiv(s, GL_COMPILE_STATUS, &ok);
  if (!ok) {
    GLint len = 0; glGetShaderiv(s, GL_INFO_LOG_LENGTH, &len);
    std::vector<char> log(len + 1);
    glGetShaderInfoLog(s, len, nullptr, log.data());
    std::fprintf(stderr, "=== Erreur de compilation du shader '%s' ===\n%s\n", name, log.data());
    std::exit(1);
  }
  return s;
}
static GLuint linkProgram(const char* name, GLuint a, GLuint b) {
  GLuint p = glCreateProgram();
  glAttachShader(p, a);
  if (b) glAttachShader(p, b);
  glLinkProgram(p);
  GLint ok = 0; glGetProgramiv(p, GL_LINK_STATUS, &ok);
  if (!ok) {
    GLint len = 0; glGetProgramiv(p, GL_INFO_LOG_LENGTH, &len);
    std::vector<char> log(len + 1);
    glGetProgramInfoLog(p, len, nullptr, log.data());
    std::fprintf(stderr, "=== Erreur d'edition de liens '%s' ===\n%s\n", name, log.data());
    std::exit(1);
  }
  glDeleteShader(a);
  if (b) glDeleteShader(b);
  return p;
}
static GLuint makeCompute(const char* name, const char* src) {
  return linkProgram(name, compileStage(GL_COMPUTE_SHADER, name, src), 0);
}
static GLuint makeGfx(const char* name, const char* vs, const char* fs) {
  return linkProgram(name, compileStage(GL_VERTEX_SHADER, name, vs), compileStage(GL_FRAGMENT_SHADER, name, fs));
}

// ------------------------------------------------------------------------------------
//  Textures / cibles
// ------------------------------------------------------------------------------------
static GLuint newTex3D(int w, int h, int d) {
  GLuint t = 0;
  glGenTextures(1, &t);
  glBindTexture(GL_TEXTURE_3D, t);
  glTexStorage3D(GL_TEXTURE_3D, 1, GL_RGBA16F, w, h, d);
  GLenum err = glGetError();
  if (err != GL_NO_ERROR) {
    std::fprintf(stderr, "[Erreur OpenGL 0x%X] Echec allocation texture 3D %dx%dx%d\n", err, w, h, d);
    glDeleteTextures(1, &t);
    return 0;
  }
  glTexParameteri(GL_TEXTURE_3D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_3D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_3D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
  glTexParameteri(GL_TEXTURE_3D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
  glTexParameteri(GL_TEXTURE_3D, GL_TEXTURE_WRAP_R, GL_CLAMP_TO_EDGE);
  glClearTexImage(t, 0, GL_RGBA, GL_FLOAT, nullptr);
  return t;
}

static bool createFogExplicit(int w, int h, int d) {
  if (w <= 0 || h <= 0 || d <= 0) {
    if (texFog[0]) { glDeleteTextures(2, texFog); glDeleteTextures(1, &texInteg); }
    texFog[0] = texFog[1] = texInteg = 0;
    g_fogW = g_fogH = g_fogD = 0;
    fogPing = 0;
    g_havePrev = false;
    return true;
  }
  GLuint t0 = newTex3D(w, h, d);
  GLuint t1 = newTex3D(w, h, d);
  GLuint ti = newTex3D(w, h, d);
  if (!t0 || !t1 || !ti) {
    if (t0) glDeleteTextures(1, &t0);
    if (t1) glDeleteTextures(1, &t1);
    if (ti) glDeleteTextures(1, &ti);
    std::fprintf(stderr, "[Froxels 3D] VRAM insuffisante pour %dx%dx%d !\n", w, h, d);
    return false;
  }
  if (texFog[0]) { glDeleteTextures(2, texFog); glDeleteTextures(1, &texInteg); }
  texFog[0] = t0;
  texFog[1] = t1;
  texInteg = ti;
  g_fogW = w;
  g_fogH = h;
  g_fogD = d;
  g_customFogW = w;
  g_customFogH = h;
  g_customFogD = d;
  fogPing = 0;
  g_havePrev = false;
  return true;
}

static void createFog(int q) {
  fogQuality = std::max(0, std::min(q, NUM_FOG_PRESETS - 1));
  const FogPreset& p = FOG_PRESETS[fogQuality];
  if (!createFogExplicit(p.w, p.h, p.d)) {
    if (fogQuality != 2) createFog(2); // repli securise
  }
}

static void setCustomFog(int w, int h, int d) {
  fogQuality = -1;
  for (int i = 0; i < NUM_FOG_PRESETS; ++i) {
    if (FOG_PRESETS[i].w == w && FOG_PRESETS[i].h == h && FOG_PRESETS[i].d == d) {
      fogQuality = i;
      break;
    }
  }
  if (!createFogExplicit(w, h, d)) {
    createFog(2);
  }
}
static void ensureSSBeam(int w, int h) {
  int div = std::max(1, std::min(g_ssDiv, 8));
  int tw = std::max(16, w / div);
  int th = std::max(16, h / div);
  if (texSSBeam && ssW == tw && ssH == th) return;
  if (texSSBeam) glDeleteTextures(1, &texSSBeam);
  ssW = tw; ssH = th;
  glGenTextures(1, &texSSBeam);
  glBindTexture(GL_TEXTURE_2D, texSSBeam);
  glTexStorage2D(GL_TEXTURE_2D, 1, GL_RGBA16F, ssW, ssH);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
}

static void createRT(int w, int h) {
  if (fbo) { glDeleteFramebuffers(1, &fbo); glDeleteTextures(1, &texHdr); glDeleteTextures(1, &texDepth); }
  rw = w; rh = h;
  glGenTextures(1, &texHdr);
  glBindTexture(GL_TEXTURE_2D, texHdr);
  glTexStorage2D(GL_TEXTURE_2D, 1, GL_RGBA16F, w, h);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
  glGenTextures(1, &texDepth);
  glBindTexture(GL_TEXTURE_2D, texDepth);
  glTexStorage2D(GL_TEXTURE_2D, 1, GL_DEPTH_COMPONENT32F, w, h);
  glGenFramebuffers(1, &fbo);
  glBindFramebuffer(GL_FRAMEBUFFER, fbo);
  glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, texHdr, 0);
  glFramebufferTexture2D(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, GL_TEXTURE_2D, texDepth, 0);
  if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) std::fprintf(stderr, "Framebuffer incomplet\n");
  glBindFramebuffer(GL_FRAMEBUFFER, 0);
  ensureSSBeam(w, h);
}
static GLuint newBuffer(GLenum target, GLsizeiptr size, const void* data, GLenum usage) {
  GLuint b; glGenBuffers(1, &b);
  glBindBuffer(target, b);
  glBufferData(target, size, data, usage);
  return b;
}

// ------------------------------------------------------------------------------------
//  Scene : salle de concert (boites) + lumieres
// ------------------------------------------------------------------------------------
static std::vector<float> g_verts;
static void addTri(V3 a, V3 b, V3 c, V3 n, float m) {
  V3 p[3] = {a, b, c};
  for (int i = 0; i < 3; ++i) { float v[7] = {p[i].x, p[i].y, p[i].z, n.x, n.y, n.z, m}; g_verts.insert(g_verts.end(), v, v + 7); }
}
static void addQuad(V3 a, V3 b, V3 c, V3 d, V3 n, float m) { addTri(a, b, c, n, m); addTri(a, c, d, n, m); }
static void addBox(V3 mn, V3 mx, float m) {
  addQuad({mx.x, mn.y, mn.z}, {mx.x, mx.y, mn.z}, {mx.x, mx.y, mx.z}, {mx.x, mn.y, mx.z}, {1, 0, 0}, m);
  addQuad({mn.x, mn.y, mn.z}, {mn.x, mn.y, mx.z}, {mn.x, mx.y, mx.z}, {mn.x, mx.y, mn.z}, {-1, 0, 0}, m);
  addQuad({mn.x, mx.y, mn.z}, {mn.x, mx.y, mx.z}, {mx.x, mx.y, mx.z}, {mx.x, mx.y, mn.z}, {0, 1, 0}, m);
  addQuad({mn.x, mn.y, mn.z}, {mx.x, mn.y, mn.z}, {mx.x, mn.y, mx.z}, {mn.x, mn.y, mx.z}, {0, -1, 0}, m);
  addQuad({mn.x, mn.y, mx.z}, {mx.x, mn.y, mx.z}, {mx.x, mx.y, mx.z}, {mn.x, mx.y, mx.z}, {0, 0, 1}, m);
  addQuad({mn.x, mn.y, mn.z}, {mn.x, mx.y, mn.z}, {mx.x, mx.y, mn.z}, {mx.x, mn.y, mn.z}, {0, 0, -1}, m);
}
static void buildScene() {
  V3 a = ROOM_MIN, b = ROOM_MAX;
  // Interieur de la salle (normales vers l'interieur)
  addQuad({a.x, a.y, a.z}, {a.x, a.y, b.z}, {b.x, a.y, b.z}, {b.x, a.y, a.z}, {0, 1, 0}, 0);   // sol
  addQuad({a.x, b.y, a.z}, {b.x, b.y, a.z}, {b.x, b.y, b.z}, {a.x, b.y, b.z}, {0, -1, 0}, 2);  // plafond
  addQuad({a.x, a.y, a.z}, {b.x, a.y, a.z}, {b.x, b.y, a.z}, {a.x, b.y, a.z}, {0, 0, 1}, 1);   // fond
  addQuad({a.x, a.y, b.z}, {a.x, b.y, b.z}, {b.x, b.y, b.z}, {b.x, a.y, b.z}, {0, 0, -1}, 1);  // arriere
  addQuad({a.x, a.y, a.z}, {a.x, b.y, a.z}, {a.x, b.y, b.z}, {a.x, a.y, b.z}, {1, 0, 0}, 1);   // gauche
  addQuad({b.x, a.y, a.z}, {b.x, a.y, b.z}, {b.x, b.y, b.z}, {b.x, b.y, a.z}, {-1, 0, 0}, 1);  // droite
  // Obstacles
  boxes.push_back({{-12, 0, -30}, {12, 1.2f, -18}, 3});        // scene
  boxes.push_back({{-16, 0, -28}, {-13, 4.5f, -24}, 3});       // enceintes G
  boxes.push_back({{13, 0, -28}, {16, 4.5f, -24}, 3});         // enceintes D
  boxes.push_back({{-2, 0, 8}, {2, 1.2f, 11}, 3});             // regie
  const float px[2] = {-14, 14}, pz[2] = {-6, 10};
  for (int i = 0; i < 2; ++i)
    for (int j = 0; j < 2; ++j)
      boxes.push_back({{px[i] - 0.6f, 0, pz[j] - 0.6f}, {px[i] + 0.6f, 12, pz[j] + 0.6f}, 4});  // piliers
  boxes.push_back({{-6, 0, -2}, {-4, 2.0f, 0}, 3});
  boxes.push_back({{5, 0, 2}, {8, 1.6f, 4}, 3});
  for (const Box& bx : boxes) addBox(bx.mn, bx.mx, bx.mat);
  sceneVerts = (int)(g_verts.size() / 7);
}
static bool insideAnyBox(V3 p, float pad) {
  for (const Box& b : boxes)
    if (p.x > b.mn.x - pad && p.x < b.mx.x + pad && p.y > b.mn.y - pad && p.y < b.mx.y + pad && p.z > b.mn.z - pad && p.z < b.mx.z + pad) return true;
  return false;
}
static float lerpf(float a, float b, float t) { return a + (b - a) * t; }
static void buildLights(int maxN) {
  const float PI = 3.14159265f;
  lightStatics.resize(maxN);
  for (int i = 0; i < maxN; ++i) {
    LightStatic& L = lightStatics[i];
    uint32_t u = (uint32_t)i;
    V3 p = {0, 10, 0};
    for (int attempt = 0; attempt < 60; ++attempt) {
      p = {lerpf(-18, 18, rnd(u, 1 + attempt * 3)), lerpf(7.5f, 11, rnd(u, 2 + attempt * 3)), lerpf(-26, 24, rnd(u, 3 + attempt * 3))};
      if (!insideAnyBox(p, 0.6f)) break;
    }
    L.pos = p;
    float r = rnd(u, 200);
    if (r < 0.70f) { L.target = {lerpf(-14, 14, rnd(u, 201)), 0, lerpf(-27, 12, rnd(u, 202))}; L.ax1 = 0; L.ax2 = 2; L.amp1 = lerpf(3, 7, rnd(u, 203)); L.amp2 = lerpf(3, 7, rnd(u, 204)); }
    else if (r < 0.85f) { L.target = {lerpf(-14, 14, rnd(u, 201)), lerpf(1, 9, rnd(u, 202)), -29.9f}; L.ax1 = 0; L.ax2 = 1; L.amp1 = lerpf(2, 5, rnd(u, 203)); L.amp2 = lerpf(1, 3, rnd(u, 204)); }
    else { L.target = {rnd(u, 205) < 0.5f ? -19.9f : 19.9f, lerpf(1, 9, rnd(u, 202)), lerpf(-25, 10, rnd(u, 201))}; L.ax1 = 1; L.ax2 = 2; L.amp1 = lerpf(1, 3, rnd(u, 203)); L.amp2 = lerpf(2, 5, rnd(u, 204)); }
    bool wash = rnd(u, 210) < 0.15f;
    L.outer = wash ? 22.0f : lerpf(5, 9, rnd(u, 211));
    L.innerFrac = wash ? 0.6f : 0.65f;
    L.baseI = wash ? 220.0f : 800.0f;
    L.range = 60.0f;
    float g = rnd(u, 212);
    L.gobo = wash ? 0 : (g < 0.4f ? 0 : 1 + (int)(rnd(u, 213) * 3.0f));
    L.hue = rnd(u, 214);
    L.f1 = lerpf(0.3f, 1.2f, rnd(u, 215)); L.f2 = lerpf(0.25f, 1.1f, rnd(u, 216));
    L.p1 = 2 * PI * rnd(u, 217); L.p2 = 2 * PI * rnd(u, 218);
    L.pulseF = lerpf(1.0f, 4.0f, rnd(u, 219)); L.pulseP = 2 * PI * rnd(u, 220);
    L.spin = (rnd(u, 221) < 0.5f ? -1.f : 1.f) * lerpf(0.5f, 2.0f, rnd(u, 222));
  }
  lightsGPU.resize(maxN);
}
static void updateLights(double t, int n) {
  const float PI = 3.14159265f;
  float tMotion = (float)t * g_lightSpeed;
  float tColor = (float)t * g_colorSpeed;
  float tPulse = (float)t * g_pulseSpeed;

  for (int i = 0; i < n; ++i) {
    const LightStatic& L = lightStatics[i];
    V3 tg = L.target;
    (&tg.x)[L.ax1] += (L.amp1 * g_motionAmp) * std::sin(L.f1 * tMotion + L.p1);
    (&tg.x)[L.ax2] += (L.amp2 * g_motionAmp) * std::cos(L.f2 * tMotion + L.p2);
    V3 d = norm(tg - L.pos);
    float pulse = 0.5f + 0.5f * std::sin(L.pulseF * tPulse + L.pulseP);
    float I = L.baseI * (0.3f + 0.7f * pulse * pulse) * g_lightIntensity;

    V3 c;
    if (g_customColor) {
      c = {g_lightColorRGB[0], g_lightColorRGB[1], g_lightColorRGB[2]};
    } else if (g_colorPreset == 1) { // Cyan & Magenta
      c = (i % 2 == 0) ? V3{0.10f, 0.95f, 1.0f} : V3{1.0f, 0.12f, 0.85f};
    } else if (g_colorPreset == 2) { // Or & Ambre
      c = (i % 2 == 0) ? V3{1.0f, 0.75f, 0.20f} : V3{1.0f, 0.40f, 0.05f};
    } else if (g_colorPreset == 3) { // Rouge Passion
      c = (i % 2 == 0) ? V3{1.0f, 0.15f, 0.05f} : V3{0.9f, 0.02f, 0.25f};
    } else if (g_colorPreset == 4) { // Bleu & Blanc Electrique
      c = (i % 2 == 0) ? V3{0.15f, 0.45f, 1.0f} : V3{0.95f, 0.95f, 1.0f};
    } else { // 0: Arc-en-ciel concert
      c = hsv(L.hue + 0.02f * tColor * ((i % 3) - 1.0f), 0.9f, 1.0f);
    }

    float outerDeg = std::max(2.0f, std::min(65.0f, L.outer * g_beamAngleMult));
    float outer = outerDeg * PI / 180.0f;

    int goboVal = L.gobo;
    if (g_goboOverride == 1) goboVal = 0;
    else if (g_goboOverride == 2) goboVal = 1;
    else if (g_goboOverride == 3) goboVal = 2;

    GPULight& g = lightsGPU[i];
    g.posRange[0] = L.pos.x; g.posRange[1] = L.pos.y; g.posRange[2] = L.pos.z; g.posRange[3] = g_lightRange;
    g.dirCos[0] = d.x; g.dirCos[1] = d.y; g.dirCos[2] = d.z; g.dirCos[3] = std::cos(outer);
    g.colorInt[0] = c.x; g.colorInt[1] = c.y; g.colorInt[2] = c.z; g.colorInt[3] = I;
    g.params[0] = std::cos(outer * L.innerFrac); g.params[1] = (float)goboVal; g.params[2] = 0; g.params[3] = L.spin * tMotion;
  }
}

// ------------------------------------------------------------------------------------
//  Parametres reglables
// ------------------------------------------------------------------------------------
static float g_scale = 1.0f, g_exposure = 1.0f, g_density = 0.025f, g_giStrength = 0.02f, g_fogGI = 0.05f;
static FrameUBO U;
static float g_prevVP[16];
static double g_lastFrameT = 0;

static void setV4(float* d, float a, float b, float c, float e) { d[0] = a; d[1] = b; d[2] = c; d[3] = e; }
static void setI4(int* d, int a, int b, int c, int e) { d[0] = a; d[1] = b; d[2] = c; d[3] = e; }

static void initStaticUBO() {
  std::memset(&U, 0, sizeof(U));
  setV4(U.roomMin, ROOM_MIN.x, ROOM_MIN.y, ROOM_MIN.z, 0);
  setV4(U.roomMax, ROOM_MAX.x, ROOM_MAX.y, ROOM_MAX.z, 0);
  setI4(U.clusterDim, CLUSTER_DIM[0], CLUSTER_DIM[1], CLUSTER_DIM[2], MAX_PER_CLUSTER);
  setI4(U.giDim, GI_DIM[0], GI_DIM[1], GI_DIM[2], 0);
  setI4(U.misc, opt.shadowRes, g_tilesPerRow, 0, 0);
}
static void uploadUBO() {
  glBindBuffer(GL_UNIFORM_BUFFER, uboFrame);
  glBufferSubData(GL_UNIFORM_BUFFER, 0, sizeof(FrameUBO), &U);
  glBindBufferBase(GL_UNIFORM_BUFFER, 0, uboFrame);
}
static void bindSSBOs() {
  glBindBufferBase(GL_SHADER_STORAGE_BUFFER, 0, ssboLights);
  glBindBufferBase(GL_SHADER_STORAGE_BUFFER, 1, ssboBoxes);
  glBindBufferBase(GL_SHADER_STORAGE_BUFFER, 2, ssboCount);
  glBindBufferBase(GL_SHADER_STORAGE_BUFFER, 3, ssboIdx);
  glBindBufferBase(GL_SHADER_STORAGE_BUFFER, 4, ssboTile2d);
}
static void bindTex(int unit, GLenum target, GLuint tex) {
  glActiveTexture(GL_TEXTURE0 + unit);
  glBindTexture(target, tex);
}

static void bakeShadows() {
  double t0 = glfwGetTime();
  updateLights(0.0, opt.maxLights);
  glBindBuffer(GL_SHADER_STORAGE_BUFFER, ssboLights);
  glBufferSubData(GL_SHADER_STORAGE_BUFFER, 0, (GLsizeiptr)(opt.maxLights * sizeof(GPULight)), lightsGPU.data());
  setI4(U.counts, opt.maxLights, (int)boxes.size(), 1, 1);
  uploadUBO();
  bindSSBOs();
  glUseProgram(progBake);
  glBindImageTexture(3, texShadow, 0, GL_FALSE, 0, GL_WRITE_ONLY, GL_R32F);
  GLuint g = (GLuint)((opt.shadowRes + 7) / 8);
  glDispatchCompute(g, g, (GLuint)(6 * opt.maxLights));
  glMemoryBarrier(GL_TEXTURE_FETCH_BARRIER_BIT | GL_SHADER_IMAGE_ACCESS_BARRIER_BIT);
  glFinish();
  std::printf("Ombres statiques cuites : %d lumieres x 6 faces de %dx%d (atlas %dx%d) en %.0f ms (%.0f Mo de VRAM)\n",
              opt.maxLights, opt.shadowRes, opt.shadowRes, g_atlasW, g_atlasH, (glfwGetTime() - t0) * 1000.0,
              g_atlasW * (double)g_atlasH * 4.0 / 1048576.0);
  checkGL("cuisson des ombres");
  // controle : relit un petit bloc de la premiere tuile. Une distance doit etre > 0.
  float probe[16] = {0};
  glGetTextureSubImage(texShadow, 0, 0, 0, 0, 4, 4, 1, GL_RED, GL_FLOAT, sizeof(probe), probe);
  float mn = 1e30f, mx = -1e30f;
  for (float v : probe) { mn = std::min(mn, v); mx = std::max(mx, v); }
  if (mx > 0.01f) std::printf("Controle des ombres : OK (distances lues %.1f a %.1f m)\n", mn, mx);
  else std::printf("!!! Controle des ombres : ECHEC (tuile vide). Copie-moi tout ce texte. Essaie en attendant la touche O (ombres off).\n");
}

// ------------------------------------------------------------------------------------
//  Camera
// ------------------------------------------------------------------------------------
static void autoCam(double t, V3& eye, V3& tgt) {
  float ft = (float)t;
  eye = {8.0f * std::sin(0.15f * ft), 1.7f + 0.5f * std::sin(0.23f * ft), 18.0f + 6.0f * std::cos(0.11f * ft)};
  tgt = {4.0f * std::sin(0.07f * ft + 1.0f), 3.5f, -22.0f};
}

static void startBench();

// ------------------------------------------------------------------------------------
//  Interface Utilisateur ImGui (Menu d'Options & Reglages en direct)
// ------------------------------------------------------------------------------------
static void renderUI(double simTime) {
  (void)simTime;
  if (!g_showMenu) return;

  ImGui::SetNextWindowPos(ImVec2(16, 16), ImGuiCond_FirstUseEver);
  ImGui::SetNextWindowSize(ImVec2(410, 580), ImGuiCond_FirstUseEver);

  if (ImGui::Begin("LightBench - Reglages des Lumieres & Scene", &g_showMenu)) {
    if (ImGui::BeginTabBar("Tabs")) {
      
      // === ONGLET 1 : LUMIERES ===
      if (ImGui::BeginTabItem("Lumieres")) {
        ImGui::TextColored(ImVec4(1.0f, 0.85f, 0.3f, 1.0f), "Gestion des Lyres & Projecteurs");
        ImGui::Separator();
        
        int curLights = numLights;
        if (ImGui::SliderInt("Nombre de spots", &curLights, 16, opt.maxLights)) {
          numLights = curLights;
        }
        ImGui::Text("Preselections :"); ImGui::SameLine();
        if (ImGui::Button("64")) { numLights = std::min(64, opt.maxLights); } ImGui::SameLine();
        if (ImGui::Button("128")) { numLights = std::min(128, opt.maxLights); } ImGui::SameLine();
        if (ImGui::Button("256")) { numLights = std::min(256, opt.maxLights); } ImGui::SameLine();
        if (ImGui::Button("512")) { numLights = std::min(512, opt.maxLights); } ImGui::SameLine();
        if (ImGui::Button("1024")) { numLights = std::min(1024, opt.maxLights); }

        ImGui::Spacing();
        ImGui::SliderFloat("Intensite lumineuse", &g_lightIntensity, 0.0f, 4.0f, "%.2fx");
        ImGui::SliderFloat("Portee faisceau (Range)", &g_lightRange, 15.0f, 150.0f, "%.1f m");
        ImGui::SliderFloat("Ouverture cone", &g_beamAngleMult, 0.2f, 2.5f, "%.2fx");

        ImGui::Spacing();
        ImGui::TextColored(ImVec4(0.4f, 0.85f, 1.0f, 1.0f), "Mouvement des Lyres");
        ImGui::SliderFloat("Vitesse balayage", &g_lightSpeed, 0.0f, 3.0f, "%.2fx");
        ImGui::SliderFloat("Amplitude balayage", &g_motionAmp, 0.0f, 3.0f, "%.2fx");
        ImGui::SliderFloat("Vitesse pulsation", &g_pulseSpeed, 0.0f, 3.0f, "%.2fx");

        ImGui::Spacing();
        ImGui::TextColored(ImVec4(1.0f, 0.45f, 0.75f, 1.0f), "Couleurs & Gobos");
        const char* colorPresets[] = { "Arc-en-ciel concert", "Cyan & Magenta", "Or & Ambre dore", "Rouge Passion", "Bleu & Blanc", "Couleur Personnalisee" };
        if (ImGui::Combo("Palette de couleurs", &g_colorPreset, colorPresets, 6)) {
          g_customColor = (g_colorPreset == 5);
        }
        if (g_customColor) {
          ImGui::ColorEdit3("Teinte uniforme", g_lightColorRGB);
        }
        ImGui::SliderFloat("Vitesse defilement", &g_colorSpeed, 0.0f, 3.0f, "%.2fx");

        const char* goboModes[] = { "Normal (Mix)", "Desactive (Faisceau lisse)", "Anneaux concentriques", "Rayons etoiles" };
        ImGui::Combo("Gobos (Motifs)", &g_goboOverride, goboModes, 4);

        ImGui::EndTabItem();
      }

      // === ONGLET 2 : BROUILLARD, BEAMS & REFLETS ===
      if (ImGui::BeginTabItem("Beams, Brouillard & Reflets")) {
        // --- 1. CHOIX DE LA TECHNIQUE DE FAISCEAUX ---
        ImGui::TextColored(ImVec4(1.0f, 0.85f, 0.3f, 1.0f), "Technique d'Affichage des Faisceaux (Beams)");
        ImGui::Separator();

        const char* beamModes[] = {
          "0. Froxels 3D (Grille Voxel classique)",
          "1. Cones Raymarches 4K (Ultra Net & Tranchant - 0 Voxel)",
          "2. Integration Analytique (Formule fermee - 250+ FPS)",
          "3. Faisceaux Doux (Soft Optical Beams - 300+ FPS)",
          "4. Hybride (Fumee Froxel Ambiante + Cones 4K)",
          "5. Screen-Space Depth Scattering (Basse-Res + Bilateral 4K - Ultra Fluide)"
        };
        ImGui::Combo("Mode de Beam", &g_beamMode, beamModes, 6);

        // Boutons rapides
        for (int m = 0; m < 6; ++m) {
          if (m > 0 && m != 3) ImGui::SameLine();
          bool sel = (g_beamMode == m);
          if (sel) ImGui::PushStyleColor(ImGuiCol_Button, ImVec4(0.2f, 0.65f, 0.95f, 1.0f));
          const char* btnLabels[] = { "0. Froxels", "1. Cones 4K", "2. Analytique", "3. Faisceaux Doux", "4. Hybride", "5. SS Depth 4K" };
          if (ImGui::Button(btnLabels[m])) g_beamMode = m;
          if (sel) ImGui::PopStyleColor();
        }

        // Explication pedagogique du mode actif
        if (g_beamMode == 0) {
          ImGui::TextColored(ImVec4(0.7f, 0.8f, 0.9f, 1.0f), "-> Mode Voxel : calcule une grille 3D. Flou/pixelise en basse res, rame en 4K.");
        } else if (g_beamMode == 1) {
          ImGui::TextColored(ImVec4(0.4f, 1.0f, 0.5f, 1.0f), "-> Cones Raymarches : 100%% net en 4K ! 10 pas uniquement dans les cones. 0 voxel, 0 lag !");
        } else if (g_beamMode == 2) {
          ImGui::TextColored(ImVec4(0.4f, 0.9f, 1.0f, 1.0f), "-> Analytique : Formule mathematique sans boucle. Zero marche d'escalier, ultra fluide (250+ FPS).");
        } else if (g_beamMode == 3) {
          ImGui::TextColored(ImVec4(1.0f, 0.6f, 1.0f, 1.0f), "-> Faisceaux Doux : Rendu stylise type visualisateur de concert, ultra rapide (300+ FPS).");
        } else if (g_beamMode == 4) {
          ImGui::TextColored(ImVec4(1.0f, 0.9f, 0.4f, 1.0f), "-> Hybride : Fumee d'ambiance douce dans la salle + faisceaux de lyres ultra nets en 4K !");
        } else if (g_beamMode == 5) {
          ImGui::TextColored(ImVec4(0.3f, 1.0f, 0.85f, 1.0f), "-> Screen-Space Depth Scattering : Calcule les beams en basse-res (Min/Max Depth) + Upsampling Bilateral 4K + Halo atmospherique !");
        }

        ImGui::Spacing();
        ImGui::SliderFloat("Intensite des faisceaux", &g_beamIntensity, 0.1f, 5.0f, "%.2fx");
        ImGui::SliderFloat("Nettete des contours", &g_beamSharpness, 0.2f, 3.0f, "%.2fx");
        if (g_beamMode == 1 || g_beamMode == 4 || (g_beamMode == 5 && g_ssRaymarch)) {
          ImGui::SliderInt("Pas de Raymarching (Qualite)", &g_beamSteps, 4, 24);
        }

        // --- 1b. SCREEN-SPACE DEPTH SCATTERING ---
        ImGui::Spacing();
        ImGui::TextColored(ImVec4(0.3f, 0.95f, 1.0f, 1.0f), "Screen-Space Depth Scattering (Diffusion & Upsampling)");
        ImGui::Separator();
        if (g_beamMode == 5) {
          ImGui::Text("Resolution passe Beams : %d x %d (Ecran / %d)", ssW, ssH, g_ssDiv);
          if (ImGui::Button("1/2 Ecran (1080p)")) g_ssDiv = 2;
          ImGui::SameLine();
          if (ImGui::Button("1/3 Ecran (720p) [Optimal]")) g_ssDiv = 3;
          ImGui::SameLine();
          if (ImGui::Button("1/4 Ecran (540p) [Ultra Rapide]")) g_ssDiv = 4;
          ImGui::Checkbox("Raymarching avec ombres d'obstacles dans le cone", &g_ssRaymarch);
          ImGui::SliderFloat("Nettete bords Depth-Bilateral", &g_ssDepthSharp, 0.2f, 4.0f, "%.2fx");
        }
        ImGui::SliderFloat("Diffusion Depth Scattering (Halo)", &g_ssScatter, 0.0f, 2.5f, "%.2fx");
        ImGui::SliderFloat("Rayon de diffusion optique", &g_ssRadius, 0.2f, 3.0f, "%.2fx");
        ImGui::TextDisabled("Aide : Diffuse la lumiere dans la brume autour des faisceaux en respectant la profondeur Z des obstacles.");

        // --- 2. REFLETS SUR LE SOL ---
        ImGui::Spacing();
        ImGui::TextColored(ImVec4(0.4f, 1.0f, 0.8f, 1.0f), "Reflets sur le Sol (PBR Cook-Torrance)");
        ImGui::Separator();
        ImGui::SliderFloat("Intensite des reflets speculaires", &g_floorSpecular, 0.0f, 5.0f, "%.2fx");
        ImGui::SliderFloat("Nettete du sol (Miroir <-> Mat)", &g_floorRoughness, 0.2f, 3.0f, "%.2fx");
        ImGui::TextDisabled("Aide : Les reflets sont speculaires (physique). Une lyre ne reflete que si son angle de rebond va vers la camera.");

        // --- 3. PARAMETRES VOXEL / FROXELS (utilises pour Mode 0 et 4) ---
        ImGui::Spacing();
        if (g_beamMode == 0 || g_beamMode == 4) {
          ImGui::TextColored(ImVec4(0.7f, 0.9f, 1.0f, 1.0f), "Grille Froxels 3D (Fumee Volumetrique)");
          ImGui::Separator();

          if (g_fogW > 0 && g_fogH > 0 && g_fogD > 0) {
            double numVoxels = (double)g_fogW * g_fogH * g_fogD;
            double vramMB = numVoxels * 24.0 / 1048576.0;
            ImGui::Text("Resolution active : %d x %d x %d (%.2f M voxels)", g_fogW, g_fogH, g_fogD, numVoxels / 1e6);
            if (vramMB >= 1024.0) {
              ImGui::TextColored(ImVec4(1.0f, 0.8f, 0.2f, 1.0f), "Memoire VRAM : %.2f Go", vramMB / 1024.0);
            } else {
              ImGui::TextColored(ImVec4(0.4f, 1.0f, 0.4f, 1.0f), "Memoire VRAM : %.0f Mo", vramMB);
            }
          }

          int curFq = fogQuality;
          const char* currentLabel = (curFq >= 0 && curFq < NUM_FOG_PRESETS) ? FOG_PRESETS[curFq].label : "Personnalise (Custom)";
          if (ImGui::BeginCombo("Preselections Froxels", currentLabel)) {
            for (int i = 0; i < NUM_FOG_PRESETS; ++i) {
              bool isSelected = (curFq == i);
              if (ImGui::Selectable(FOG_PRESETS[i].label, isSelected)) {
                g_fogMatchScreen = false;
                createFog(i);
              }
              if (isSelected) ImGui::SetItemDefaultFocus();
            }
            ImGui::EndCombo();
          }

          if (ImGui::Button("1:1 Plein Ecran (32 tranches)")) { g_fogMatchScreen = false; setCustomFog(ow, oh, 32); }
          ImGui::SameLine();
          if (ImGui::Button("1/2 Ecran (50%%)")) { g_fogMatchScreen = false; setCustomFog(std::max(16, ow / 2), std::max(16, oh / 2), 64); }
          ImGui::SameLine();
          if (ImGui::Button("Moyenne (160x90) [Optimal]")) { g_fogMatchScreen = false; createFog(2); }

          ImGui::Spacing();
          if (ImGui::CollapsingHeader("Sliders Froxels Personnalises")) {
            ImGui::Checkbox("Conserver le ratio 16:9", &g_lockAspect);
            if (ImGui::SliderInt("Largeur X", &g_customFogW, 16, 3840)) {
              if (g_lockAspect) g_customFogH = std::max(16, (int)(g_customFogW * 9 / 16));
            }
            if (ImGui::SliderInt("Hauteur Y", &g_customFogH, 16, 2160)) {
              if (g_lockAspect) g_customFogW = std::max(16, (int)(g_customFogH * 16 / 9));
            }
            ImGui::SliderInt("Tranches Z", &g_customFogD, 8, 128);

            double cVoxels = (double)g_customFogW * g_customFogH * g_customFogD;
            double cVramMB = cVoxels * 24.0 / 1048576.0;
            ImGui::Text("Prevision : %d x %d x %d -> %.1f Mo (%.2f Go) VRAM",
                        g_customFogW, g_customFogH, g_customFogD, cVramMB, cVramMB / 1024.0);
            if (ImGui::Button("Appliquer la taille personnalisee", ImVec2(-1, 26))) {
              g_fogMatchScreen = false;
              setCustomFog(g_customFogW, g_customFogH, g_customFogD);
            }
          }
        }

        // --- 4. DENSITE GLOBALE & ATMOSPHERE ---
        ImGui::Spacing();
        ImGui::TextColored(ImVec4(1.0f, 0.8f, 0.4f, 1.0f), "Atmosphere, Ombres & GI");
        ImGui::Separator();
        ImGui::SliderFloat("Densite du brouillard / fumee", &g_density, 0.001f, 0.12f, "%.4f");
        ImGui::SliderFloat("Diffusion GI dans la fumee", &g_fogGI, 0.0f, 0.25f, "%.3f");

        ImGui::Checkbox("Ombres dynamiques (Cubemaps)", &opt.shadows);
        ImGui::Checkbox("Global Illumination (Grille 3D)", &opt.gi);
        if (opt.gi) {
          ImGui::SliderFloat("Rebond GI sur les murs", &g_giStrength, 0.001f, 0.08f, "%.3f");
        }
        ImGui::Checkbox("Accumulation temporelle (TAA)", &opt.temporal);

        ImGui::EndTabItem();
      }

      // === ONGLET 3 : CAMERA & DEPLACEMENT ===
      if (ImGui::BeginTabItem("Deplacement")) {
        ImGui::TextColored(ImVec4(0.5f, 1.0f, 0.5f, 1.0f), "Deplacement dans la piece");
        ImGui::Separator();

        ImGui::Checkbox("Controle libre (Joueur)", &freeCam);
        if (freeCam) {
          ImGui::Checkbox("Collisions murs / sol (Rester dans la piece)", &g_roomCollision);
          ImGui::SliderFloat("Vitesse de marche", &g_camMoveSpeed, 4.0f, 50.0f, "%.1f m/s");
          ImGui::SliderFloat("Sensibilite souris", &g_mouseSensitivity, 0.1f, 2.0f, "%.2f");
          
          ImGui::Spacing();
          bool mLook = g_mouseLookActive;
          if (ImGui::Checkbox("Mode Vue Souris FPS (Touche TAB)", &mLook)) {
            g_mouseLookActive = mLook;
            glfwSetInputMode(g_win, GLFW_CURSOR, g_mouseLookActive ? GLFW_CURSOR_DISABLED : GLFW_CURSOR_NORMAL);
            double curX, curY;
            glfwGetCursorPos(g_win, &curX, &curY);
            lastMouseX = curX;
            lastMouseY = curY;
          }
          ImGui::TextWrapped("Touches : ZQSD ou WASD pour avancer/reculer/strafer. Espace = monter, Ctrl/C/X = descendre, Shift = sprint. Clic droit ou TAB pour orienter la vue.");

          ImGui::Spacing();
          ImGui::Text("Position actuelle : X=%.1f  Y=%.1f  Z=%.1f", camPos.x, camPos.y, camPos.z);
          if (ImGui::Button("Fosse (Milieu de la salle)")) {
            camPos = {0.0f, 1.8f, 16.0f};
            camYaw = 0.0f;
            camPitch = -0.05f;
          }
          ImGui::SameLine();
          if (ImGui::Button("Sur la Scene")) {
            camPos = {0.0f, 2.5f, -22.0f};
            camYaw = 3.14159f;
            camPitch = 0.0f;
          }
          ImGui::SameLine();
          if (ImGui::Button("Regie")) {
            camPos = {0.0f, 2.2f, 9.5f};
            camYaw = 0.0f;
            camPitch = -0.05f;
          }
        } else {
          ImGui::TextColored(ImVec4(1.0f, 0.6f, 0.2f, 1.0f), "Mode camera automatique actif (cochez Controle libre ou appuyez sur F2)");
        }

        ImGui::Spacing();
        ImGui::Separator();
        ImGui::SliderFloat("Exposition camera", &g_exposure, 0.2f, 3.5f, "%.2f");

        ImGui::EndTabItem();
      }

      // === ONGLET 4 : PERFORMANCES & RESOLUTION ===
      if (ImGui::BeginTabItem("Performances")) {
        ImGui::TextColored(ImVec4(0.9f, 0.9f, 0.9f, 1.0f), "Rendu GPU en direct");
        ImGui::Separator();

        double gpuTot = 0;
        for (int p = 0; p < 6; ++p) gpuTot += passMs[p];
        ImGui::Text("Temps GPU total : %.2f ms", gpuTot);
        ImGui::Text("  - Culling clusters  : %.2f ms", passMs[0]);
        ImGui::Text("  - Grille GI 3D      : %.2f ms", passMs[1]);
        ImGui::Text("  - Injection Froxels : %.2f ms", passMs[2]);
        if (g_beamMode == 5)
          ImGui::Text("  - SS Depth Beams    : %.2f ms", passMs[3]);
        else
          ImGui::Text("  - Integr. Froxels   : %.2f ms", passMs[3]);
        ImGui::Text("  - Rendu scene       : %.2f ms", passMs[4]);
        ImGui::Text("  - Post + Scattering : %.2f ms", passMs[5]);

        ImGui::Spacing();
        ImGui::Text("Echelle de resolution interne :");
        const float scales[4] = { 1.0f, 0.77f, 0.67f, 0.50f };
        const char* sLabels[4] = { "100%", "77%", "67%", "50%" };
        for (int i = 0; i < 4; ++i) {
          if (i > 0) ImGui::SameLine();
          bool active = (std::abs(g_scale - scales[i]) < 0.02f);
          if (active) ImGui::PushStyleColor(ImGuiCol_Button, ImVec4(0.2f, 0.6f, 0.9f, 1.0f));
          if (ImGui::Button(sLabels[i])) {
            g_scale = scales[i];
            scaleIdx = i;
          }
          if (active) ImGui::PopStyleColor();
        }

        ImGui::Checkbox("Synchronisation verticale (VSync)", &opt.vsync);
        if (ImGui::IsItemDeactivatedAfterEdit()) {
          glfwSwapInterval(opt.vsync ? 1 : 0);
        }

        ImGui::Spacing();
        if (ImGui::Button("Lancer le Benchmark Automatique")) {
          startBench();
        }

        ImGui::EndTabItem();
      }
    }
    ImGui::EndTabBar();

    ImGui::Separator();
    ImGui::TextDisabled("Aide : Touche M ou F1 pour masquer le menu | TAB pour verrouiller la souris");
  }
  ImGui::End();
}

// ------------------------------------------------------------------------------------
//  Une image complete
// ------------------------------------------------------------------------------------
static void renderFrame(double simTime) {
  ensureSSBeam(rw, rh);
  int slot = frameIdx % 4;
  auto qBegin = [&](int p) { glBeginQuery(GL_TIME_ELAPSED, qry[slot][p]); };
  auto qEnd = [&]() { glEndQuery(GL_TIME_ELAPSED); };

  // --- camera
  V3 eye, tgt;
  if (!freeCam) {
    autoCam(simTime, eye, tgt);
    camPos = eye;
    V3 d = norm(tgt - eye);
    camYaw = std::atan2(d.x, -d.z);
    camPitch = std::asin(d.y);
  } else {
    eye = camPos;
    tgt = eye + V3{std::cos(camPitch) * std::sin(camYaw), std::sin(camPitch), -std::cos(camPitch) * std::cos(camYaw)};
  }
  float fovy = 65.0f * 3.14159265f / 180.0f;
  float aspect = (float)ow / (float)oh;
  Mat4 inv;
  Mat4 view = lookAt(eye, tgt, {0, 1, 0}, &inv);
  Mat4 proj = perspective(fovy, aspect, 0.1f, 200.0f);
  Mat4 vp = mul(proj, view);
  std::memcpy(U.view, view.m, 64);
  std::memcpy(U.invView, inv.m, 64);
  std::memcpy(U.viewProj, vp.m, 64);
  std::memcpy(U.prevViewProj, g_havePrev ? g_prevVP : vp.m, 64);
  std::memcpy(g_prevVP, vp.m, 64);
  g_havePrev = true;

  float tanY = std::tan(fovy * 0.5f);
  bool fogOn = (g_fogW > 0 && g_fogH > 0 && g_fogD > 0);
  setV4(U.cam, eye.x, eye.y, eye.z, (float)simTime);
  setV4(U.proj, tanY * aspect, tanY, 0.1f, 200.0f);
  setV4(U.fog, fogOn ? g_density : 0.0f, 0.3f, 60.0f, g_fogGI);
  setV4(U.fogDim, (float)g_fogW, (float)g_fogH, (float)g_fogD,
        (opt.temporal && frameIdx > 0) ? 0.85f : 0.0f);
  if (opt.temporal)
    setV4(U.jitter, halton(frameIdx % 16 + 1, 2) - 0.5f, halton(frameIdx % 16 + 1, 3) - 0.5f, halton(frameIdx % 16 + 1, 5) - 0.5f, (float)frameIdx);
  else
    setV4(U.jitter, 0, 0, 0, (float)frameIdx);
  setI4(U.counts, numLights, (int)boxes.size(), opt.shadows ? 1 : 0, opt.gi ? 1 : 0);
  setV4(U.clusterZ, 0.3f, 70.0f, 1.0f / (float)opt.shadowRes, g_giStrength);
  setI4(U.giDim, GI_DIM[0], GI_DIM[1], GI_DIM[2], frameIdx % GI_DIV);
  setV4(U.giParams, (float)GI_DIV, 0, 0, g_exposure);
  setV4(U.screen, (float)rw, (float)rh, (float)ow, (float)oh);
  setI4(U.misc, opt.shadowRes, g_tilesPerRow, g_beamMode, g_beamSteps);
  setV4(U.beamParams, g_beamIntensity, g_beamSharpness, g_floorRoughness, g_floorSpecular);
  setV4(U.ssParams, g_ssScatter, g_ssRadius, g_ssDepthSharp, g_ssRaymarch ? 1.0f : 0.0f);
  uploadUBO();

  updateLights(simTime, numLights);
  glBindBuffer(GL_SHADER_STORAGE_BUFFER, ssboLights);
  glBufferSubData(GL_SHADER_STORAGE_BUFFER, 0, (GLsizeiptr)(numLights * sizeof(GPULight)), lightsGPU.data());
  bindSSBOs();

  const GLbitfield BAR = GL_SHADER_STORAGE_BARRIER_BIT | GL_SHADER_IMAGE_ACCESS_BARRIER_BIT | GL_TEXTURE_FETCH_BARRIER_BIT;
  bindTex(0, GL_TEXTURE_2D, texShadow);
  bindTex(1, GL_TEXTURE_3D, texGI);

  // --- 0 : culling clusters
  qBegin(0);
  glUseProgram(progCull);
  glDispatchCompute((GLuint)g_cullDispatch, 1, 1);
  glMemoryBarrier(BAR);
  qEnd();

  // --- 1 : GI en grille (1/4 des tranches par image)
  qBegin(1);
  if (opt.gi) {
    glUseProgram(progGI);
    glBindImageTexture(2, texGI, 0, GL_TRUE, 0, GL_WRITE_ONLY, 0x881A);
    GLuint zg = (GLuint)(((GI_DIM[2] + GI_DIV - 1) / GI_DIV + 3) / 4);
    glDispatchCompute((GLuint)((GI_DIM[0] + 3) / 4), (GLuint)((GI_DIM[1] + 3) / 4), zg);
    glMemoryBarrier(BAR);
  }
  qEnd();

  // --- 2 : injection de lumiere dans les froxels, 3 : integration (uniquement si Mode Froxels ou Hybride)
  bool needFroxels = (g_beamMode == 0 || g_beamMode == 4) && fogOn;
  GLuint cur = texFog[1 - fogPing], hist = texFog[fogPing];
  qBegin(2);
  if (needFroxels) {
    glUseProgram(progInject);
    bindTex(2, GL_TEXTURE_3D, hist);
    glBindImageTexture(0, cur, 0, GL_TRUE, 0, GL_WRITE_ONLY, 0x881A);
    glDispatchCompute((GLuint)((g_fogW + 7) / 8), (GLuint)((g_fogH + 7) / 8), (GLuint)((g_fogD + 3) / 4));
    glMemoryBarrier(BAR);
  }
  qEnd();
  if (g_beamMode != 5) {
    qBegin(3);
    if (needFroxels) {
      glUseProgram(progInteg);
      glBindImageTexture(0, cur, 0, GL_TRUE, 0, GL_READ_ONLY, 0x881A);
      glBindImageTexture(1, texInteg, 0, GL_TRUE, 0, GL_WRITE_ONLY, 0x881A);
      glDispatchCompute((GLuint)((g_fogW + 7) / 8), (GLuint)((g_fogH + 7) / 8), 1);
      glMemoryBarrier(BAR);
      fogPing = 1 - fogPing;
    }
    qEnd();
  }

  // --- 4 : decor (ecrit aussi viewDepth dans texHdr.a)
  qBegin(4);
  glBindFramebuffer(GL_FRAMEBUFFER, fbo);
  glViewport(0, 0, rw, rh);
  glClearColor(0, 0, 0, 100.0f);
  glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
  glEnable(GL_DEPTH_TEST);
  glDepthFunc(GL_LESS);
  glUseProgram(progScene);
  bindTex(3, GL_TEXTURE_3D, texInteg);
  glBindVertexArray(vaoScene);
  glDrawArrays(GL_TRIANGLES, 0, sceneVerts);
  qEnd();

  // --- 3b : Screen-Space Depth Beams (si Mode 5 actif)
  if (g_beamMode == 5) {
    qBegin(3);
    glUseProgram(progSSBeam);
    bindTex(4, GL_TEXTURE_2D, texHdr);
    glBindImageTexture(0, texSSBeam, 0, GL_FALSE, 0, GL_WRITE_ONLY, 0x881A); // GL_RGBA16F
    glDispatchCompute((GLuint)((ssW + 7) / 8), (GLuint)((ssH + 7) / 8), 1);
    glMemoryBarrier(BAR);
    qEnd();
  }

  // --- 5 : Bilateral Upsampling + Screen-Space Depth Scattering + Tonemapping
  qBegin(5);
  glBindFramebuffer(GL_FRAMEBUFFER, 0);
  glViewport(0, 0, ow, oh);
  glDisable(GL_DEPTH_TEST);
  glUseProgram(progPost);
  bindTex(4, GL_TEXTURE_2D, texHdr);
  bindTex(5, GL_TEXTURE_2D, texSSBeam);
  glBindVertexArray(vaoEmpty);
  glDrawArrays(GL_TRIANGLES, 0, 3);
  qEnd();

  // --- lecture des mesures d'il y a 3 images (sans bloquer le GPU)
  int rs = (frameIdx + 1) % 4;
  if (qValid[rs]) {
    for (int p = 0; p < 6; ++p) {
      GLuint64 ns = 0;
      glGetQueryObjectui64v(qry[rs][p], GL_QUERY_RESULT, &ns);
      passMs[p] = (double)ns / 1e6;
    }
  }
  qValid[slot] = true;
}

// ------------------------------------------------------------------------------------
//  Captures d'ecran (BMP)
// ------------------------------------------------------------------------------------
static void saveBMP(const char* path) {
  std::vector<unsigned char> px((size_t)ow * oh * 3);
  glPixelStorei(GL_PACK_ALIGNMENT, 1);
  glReadPixels(0, 0, ow, oh, GL_RGB, GL_UNSIGNED_BYTE, px.data());
  int rowBytes = (ow * 3 + 3) & ~3;
  std::vector<unsigned char> out((size_t)rowBytes * oh, 0);
  for (int y = 0; y < oh; ++y)
    for (int x = 0; x < ow; ++x) {
      out[(size_t)y * rowBytes + x * 3 + 0] = px[((size_t)y * ow + x) * 3 + 2];
      out[(size_t)y * rowBytes + x * 3 + 1] = px[((size_t)y * ow + x) * 3 + 1];
      out[(size_t)y * rowBytes + x * 3 + 2] = px[((size_t)y * ow + x) * 3 + 0];
    }
  FILE* f = std::fopen(path, "wb");
  if (!f) { std::fprintf(stderr, "Impossible d'ecrire %s\n", path); return; }
  unsigned char hdr[54] = {'B', 'M'};
  uint32_t fileSize = 54 + (uint32_t)out.size(), off = 54, dib = 40, planes = 1, bpp = 24;
  std::memcpy(hdr + 2, &fileSize, 4); std::memcpy(hdr + 10, &off, 4); std::memcpy(hdr + 14, &dib, 4);
  std::memcpy(hdr + 18, &ow, 4); std::memcpy(hdr + 22, &oh, 4);
  std::memcpy(hdr + 26, &planes, 2); std::memcpy(hdr + 28, &bpp, 2);
  std::fwrite(hdr, 1, 54, f);
  std::fwrite(out.data(), 1, out.size(), f);
  std::fclose(f);
  std::printf("Capture enregistree : %s\n", path);
}

// ------------------------------------------------------------------------------------
//  Benchmark automatique
// ------------------------------------------------------------------------------------
struct BenchCfg { int lights; float scale; int fog; bool gi, shadows; std::string label; };
struct BenchRow {
  BenchCfg c; int rw, rh, frames;
  double avg, p50, p99, fpsAvg, fpsLow, pass[6];
};
static bool benchActive = false;
static std::vector<BenchCfg> benchCfgs;
static size_t benchIdx = 0;
static int benchFrame = 0;
static double benchStartT = 0;
static std::vector<double> benchDt;
static double benchPass[6];
static int benchPassN = 0;
static std::vector<BenchRow> benchRows;
static Options benchSaved;
static float benchSavedScale = 1.0f;
static int benchSavedLights = 256, benchSavedFog = 2;
static const int BENCH_WARM = 90, BENCH_MIN = 90, BENCH_MAX_FRAMES = 360;
static const double BENCH_MAX_SECONDS = 7.0;

static void applyCfg(const BenchCfg& c) {
  numLights = std::min(c.lights, opt.maxLights);
  g_scale = c.scale;
  if (c.fog != fogQuality) createFog(c.fog);
  opt.gi = c.gi;
  opt.shadows = c.shadows;
  benchFrame = 0;
  benchDt.clear();
  benchPassN = 0;
  for (int p = 0; p < 6; ++p) benchPass[p] = 0;
  g_havePrev = false;
}
static void startBench() {
  benchCfgs.clear();
  benchRows.clear();
  int fogMid = std::max(1, std::min(2, opt.fog > 0 ? opt.fog : 2));
  const int counts[5] = {64, 128, 256, 512, 1024};
  for (int i = 0; i < 5; ++i) if (counts[i] <= opt.maxLights) benchCfgs.push_back({counts[i], 1.0f, fogMid, true, true, "reference"});
  const int c2[3] = {256, 512, 1024};
  for (int i = 0; i < 3; ++i) if (c2[i] <= opt.maxLights) benchCfgs.push_back({c2[i], 0.67f, fogMid, true, true, "echelle 67%"});
  int ref = std::min(512, opt.maxLights);
  benchCfgs.push_back({ref, 1.0f, 0, true, true, "sans brouillard"});
  benchCfgs.push_back({ref, 1.0f, fogMid, false, true, "sans GI"});
  benchCfgs.push_back({ref, 1.0f, fogMid, true, false, "sans ombres"});
  benchCfgs.push_back({ref, 1.0f, 3, true, true, "brouillard haut"});
  benchSaved = opt; benchSavedScale = g_scale; benchSavedLights = numLights; benchSavedFog = fogQuality;
  benchActive = true;
  benchIdx = 0;
  applyCfg(benchCfgs[0]);
  benchStartT = glfwGetTime();
  std::printf("\n=== Benchmark automatique : %zu configurations, ne touche a rien ===\n", benchCfgs.size());
}
static double percentile(std::vector<double> v, double p) {
  if (v.empty()) return 0;
  std::sort(v.begin(), v.end());
  size_t i = (size_t)std::min<double>(v.size() - 1, std::floor(p * (v.size() - 1) + 0.5));
  return v[i];
}
static void printBench(FILE* f, const char* gpuName, const char* glVer) {
  std::fprintf(f, "LightBench - resultats\n");
  std::fprintf(f, "GPU : %s | %s\n", gpuName, glVer);
  std::fprintf(f, "Sortie : %dx%d | ombres %dx%d | max lumieres %d | vsync %s\n\n", ow, oh, opt.shadowRes, opt.shadowRes, opt.maxLights, opt.vsync ? "oui" : "non");
  std::fprintf(f, "%-18s %6s %9s %7s | %7s %7s %7s %7s | %6s %6s %6s %6s %6s %6s\n", "configuration", "lum.", "rendu", "fps", "moy.ms", "p50ms", "p99ms", "1%low", "cull", "gi", "inject", "integ", "scene", "post");
  for (const BenchRow& r : benchRows) {
    char res[32]; std::snprintf(res, sizeof(res), "%dx%d", r.rw, r.rh);
    std::fprintf(f, "%-18s %6d %9s %7.1f | %7.2f %7.2f %7.2f %7.1f | %6.2f %6.2f %6.2f %6.2f %6.2f %6.2f\n", r.c.label.c_str(), r.c.lights, res, r.fpsAvg,
                 r.avg, r.p50, r.p99, r.fpsLow, r.pass[0], r.pass[1], r.pass[2], r.pass[3], r.pass[4], r.pass[5]);
  }
  std::fprintf(f, "\n(1%%low = fps correspondant au p99 du temps d'image ; temps par passe = GPU, en ms)\n");
}
static void finishCfg() {
  BenchRow r;
  r.c = benchCfgs[benchIdx]; r.rw = rw; r.rh = rh; r.frames = (int)benchDt.size();
  double sum = 0; for (double d : benchDt) sum += d;
  r.avg = sum / std::max<size_t>(1, benchDt.size()) * 1000.0;
  r.p50 = percentile(benchDt, 0.5) * 1000.0;
  r.p99 = percentile(benchDt, 0.99) * 1000.0;
  r.fpsAvg = r.avg > 0 ? 1000.0 / r.avg : 0;
  r.fpsLow = r.p99 > 0 ? 1000.0 / r.p99 : 0;
  for (int p = 0; p < 6; ++p) r.pass[p] = benchPassN ? benchPass[p] / benchPassN : 0;
  benchRows.push_back(r);
  std::printf("  [%zu/%zu] %-18s %5d lum. %5.1f fps  (p99 %.2f ms)\n", benchIdx + 1, benchCfgs.size(), r.c.label.c_str(), r.c.lights, r.fpsAvg, r.p99);
}

// ------------------------------------------------------------------------------------
//  Entrees clavier / souris
// ------------------------------------------------------------------------------------
static void keyCb(GLFWwindow* w, int key, int, int action, int) {
  if (action == GLFW_PRESS) {
    if (key == GLFW_KEY_TAB) {
      g_mouseLookActive = !g_mouseLookActive;
      glfwSetInputMode(w, GLFW_CURSOR, g_mouseLookActive ? GLFW_CURSOR_DISABLED : GLFW_CURSOR_NORMAL);
      double curX, curY;
      glfwGetCursorPos(w, &curX, &curY);
      lastMouseX = curX;
      lastMouseY = curY;
    }
    if (key == GLFW_KEY_M || key == GLFW_KEY_F1) {
      g_showMenu = !g_showMenu;
    }
    if (key == GLFW_KEY_ESCAPE) {
      if (g_mouseLookActive) {
        g_mouseLookActive = false;
        glfwSetInputMode(w, GLFW_CURSOR, GLFW_CURSOR_NORMAL);
        return;
      }
    }
    if (key >= 0 && key < 512) keyToggle[key] = true;
  }
}

static void cursorCb(GLFWwindow* w, double x, double y) {
  ImGuiIO& io = ImGui::GetIO();
  if (io.WantCaptureMouse && !g_mouseLookActive) {
    lastMouseX = x; lastMouseY = y;
    return;
  }
  bool rmb = (glfwGetMouseButton(w, GLFW_MOUSE_BUTTON_RIGHT) == GLFW_PRESS);
  bool lmb = (!io.WantCaptureMouse && glfwGetMouseButton(w, GLFW_MOUSE_BUTTON_LEFT) == GLFW_PRESS);
  if (freeCam && (g_mouseLookActive || rmb || lmb)) {
    float dx = (float)(x - lastMouseX);
    float dy = (float)(y - lastMouseY);
    float sens = 0.0032f * g_mouseSensitivity;
    camYaw += dx * sens;
    camPitch -= dy * sens;
    camPitch = std::max(-1.5f, std::min(1.5f, camPitch));
  }
  lastMouseX = x; lastMouseY = y;
}
static bool popKey(int k) { bool v = keyToggle[k]; keyToggle[k] = false; return v; }

static void printHelp() {
  std::printf(
      "\nCommandes :\n"
      "  ZQSD ou WASD  deplacement dans la salle    Espace / Ctrl ou C / X  monter / descendre    Shift  sprint\n"
      "  TAB           activer/desactiver la vue souris FPS (ou maintenir le clic droit)\n"
      "  M ou F1       afficher/masquer le menu de reglages ImGui\n"
      "  Haut/Bas      plus / moins de lumieres      R  echelle de rendu (100/77/67/50 %%)\n"
      "  F             qualite du brouillard         G  GI on/off     O  ombres on/off     T  temporel on/off\n"
      "  V             vsync on/off                  F2 camera auto / libre\n"
      "  B             benchmark automatique        F12  capture BMP  Echap  quitter\n\n");
}

// ------------------------------------------------------------------------------------
//  Main
// ------------------------------------------------------------------------------------
int main(int argc, char** argv) {
  for (int i = 1; i < argc; ++i) {
    std::string a = argv[i];
    auto next = [&]() -> const char* { return i + 1 < argc ? argv[++i] : ""; };
    if (a == "--lights") opt.lights = std::atoi(next());
    else if (a == "--maxlights") opt.maxLights = std::atoi(next());
    else if (a == "--shadowres") opt.shadowRes = std::atoi(next());
    else if (a == "--fog") opt.fog = std::atoi(next());
    else if (a == "--scale") g_scale = (float)std::atof(next());
    else if (a == "--res") { std::sscanf(next(), "%dx%d", &opt.width, &opt.height); }
    else if (a == "--fullscreen") opt.fullscreen = true;
    else if (a == "--nogi") opt.gi = false;
    else if (a == "--noshadow") opt.shadows = false;
    else if (a == "--notemporal") opt.temporal = false;
    else if (a == "--vsync") opt.vsync = true;
    else if (a == "--bench") opt.bench = true;
    else if (a == "--shot") opt.shot = next();
    else if (a == "--frames") opt.frames = std::atoi(next());
    else if (a == "--exposure") g_exposure = (float)std::atof(next());
    else if (a == "--density") g_density = (float)std::atof(next());
    else if (a == "--gi-strength") g_giStrength = (float)std::atof(next());
    else if (a == "--fog-gi") g_fogGI = (float)std::atof(next());
    else if (a == "--beam") g_beamMode = std::atoi(next());
    else if (a == "--beam-steps") g_beamSteps = std::atoi(next());
    else if (a == "--beam-int") g_beamIntensity = (float)std::atof(next());
    else if (a == "--help") {
      std::printf("Options : --lights N --maxlights N --shadowres N --fog 0..3 --scale S --res WxH --fullscreen\n"
                  "          --nogi --noshadow --notemporal --vsync --bench --shot f.bmp --frames N\n"
                  "          --exposure X --density X --gi-strength X --fog-gi X\n");
      return 0;
    }
  }
  opt.maxLights = std::max(16, std::min(opt.maxLights, 4096));
  opt.lights = std::max(1, std::min(opt.lights, opt.maxLights));
  opt.fog = std::max(0, std::min(opt.fog, NUM_FOG_PRESETS - 1));
  opt.shadowRes = std::max(16, std::min(opt.shadowRes, 512));
  numLights = opt.lights;

  if (!glfwInit()) { std::fprintf(stderr, "glfwInit a echoue\n"); return 1; }
  glfwWindowHint(GLFW_CONTEXT_VERSION_MAJOR, 4);
  glfwWindowHint(GLFW_CONTEXT_VERSION_MINOR, 5);
  glfwWindowHint(GLFW_OPENGL_PROFILE, GLFW_OPENGL_CORE_PROFILE);
  GLFWmonitor* mon = nullptr;
  if (opt.fullscreen) {
    mon = glfwGetPrimaryMonitor();
    const GLFWvidmode* vm = glfwGetVideoMode(mon);
    opt.width = vm->width; opt.height = vm->height;
    glfwWindowHint(GLFW_REFRESH_RATE, vm->refreshRate);
  }
  g_win = glfwCreateWindow(opt.width, opt.height, "LightBench", mon, nullptr);
  if (!g_win) { std::fprintf(stderr, "Impossible de creer un contexte OpenGL 4.5 (pilote trop ancien ?)\n"); glfwTerminate(); return 1; }
  glfwMakeContextCurrent(g_win);
  if (!loadGL()) return 1;
  glfwSwapInterval(opt.vsync ? 1 : 0);
  {
    GLint maxTex = 0; glGetIntegerv(GL_MAX_TEXTURE_SIZE, &maxTex);
    int aw = std::min(8192, (int)maxTex);
    aw = (aw / opt.shadowRes) * opt.shadowRes;
    g_tilesPerRow = aw / opt.shadowRes;
    int maxTiles = g_tilesPerRow * ((int)maxTex / opt.shadowRes);
    if (6 * opt.maxLights > maxTiles) {
      opt.maxLights = maxTiles / 6;
      std::printf("Attention : --maxlights reduit a %d (limite de taille de texture du GPU : %d)\n", opt.maxLights, (int)maxTex);
    }
    int rows = (6 * opt.maxLights + g_tilesPerRow - 1) / g_tilesPerRow;
    g_atlasW = aw; g_atlasH = rows * opt.shadowRes;
    numLights = std::min(numLights, opt.maxLights);
  }
  glfwSetKeyCallback(g_win, keyCb);
  glfwSetCursorPosCallback(g_win, cursorCb);

  // --- Initialisation de Dear ImGui
  IMGUI_CHECKVERSION();
  ImGui::CreateContext();
  ImGuiIO& io = ImGui::GetIO(); (void)io;
  ImGui::StyleColorsDark();

  ImGuiStyle& style = ImGui::GetStyle();
  style.WindowRounding = 6.0f;
  style.FrameRounding = 4.0f;
  style.PopupRounding = 4.0f;
  style.GrabRounding = 4.0f;
  style.WindowBorderSize = 1.0f;
  style.Alpha = 0.94f;

  ImGui_ImplGlfw_InitForOpenGL(g_win, true);
  ImGui_ImplOpenGL3_Init("#version 450");

  std::string gpuName = (const char*)glGetString(GL_RENDERER);
  std::string glVer = (const char*)glGetString(GL_VERSION);
  std::printf("GPU : %s\nOpenGL : %s\n", gpuName.c_str(), glVer.c_str());

  // --- programmes
  progCull = makeCompute("cull", SRC_CULL);
  progBake = makeCompute("bake", SRC_BAKE);
  progGI = makeCompute("gi", SRC_GI);
  progInject = makeCompute("inject", SRC_INJECT);
  progInteg = makeCompute("integrate", SRC_INTEGRATE);
  progSSBeam = makeCompute("ssbeam", SRC_SSBEAM);
  progScene = makeGfx("scene", SRC_SCENE_VS, SRC_SCENE_FS);
  progPost = makeGfx("post", SRC_POST_VS, SRC_POST_FS);

  // --- scene + lumieres
  buildScene();
  buildLights(opt.maxLights);
  glGenVertexArrays(1, &vaoScene);
  glBindVertexArray(vaoScene);
  vboScene = newBuffer(GL_ARRAY_BUFFER, (GLsizeiptr)(g_verts.size() * sizeof(float)), g_verts.data(), GL_STATIC_DRAW);
  glVertexAttribPointer(0, 3, GL_FLOAT, GL_FALSE, 7 * 4, (void*)0);
  glVertexAttribPointer(1, 3, GL_FLOAT, GL_FALSE, 7 * 4, (void*)(3 * 4));
  glVertexAttribPointer(2, 1, GL_FLOAT, GL_FALSE, 7 * 4, (void*)(6 * 4));
  glEnableVertexAttribArray(0); glEnableVertexAttribArray(1); glEnableVertexAttribArray(2);
  glGenVertexArrays(1, &vaoEmpty);

  std::vector<float> boxData;
  for (const Box& b : boxes) { float v[8] = {b.mn.x, b.mn.y, b.mn.z, 0, b.mx.x, b.mx.y, b.mx.z, 0}; boxData.insert(boxData.end(), v, v + 8); }
  ssboBoxes = newBuffer(GL_SHADER_STORAGE_BUFFER, (GLsizeiptr)(boxData.size() * 4), boxData.data(), GL_STATIC_DRAW);
  ssboLights = newBuffer(GL_SHADER_STORAGE_BUFFER, (GLsizeiptr)(opt.maxLights * sizeof(GPULight)), nullptr, GL_DYNAMIC_DRAW);
  int numClusters = CLUSTER_DIM[0] * CLUSTER_DIM[1] * CLUSTER_DIM[2];
  int numTiles2D = CLUSTER_DIM[0] * CLUSTER_DIM[1];
  g_cullDispatch = numClusters;
  ssboCount = newBuffer(GL_SHADER_STORAGE_BUFFER, (GLsizeiptr)numClusters * 4, nullptr, GL_DYNAMIC_DRAW);
  ssboIdx = newBuffer(GL_SHADER_STORAGE_BUFFER, (GLsizeiptr)numClusters * MAX_PER_CLUSTER * 4, nullptr, GL_DYNAMIC_DRAW);
  ssboTile2d = newBuffer(GL_SHADER_STORAGE_BUFFER, (GLsizeiptr)numTiles2D * 257 * 4, nullptr, GL_DYNAMIC_DRAW);
  uboFrame = newBuffer(GL_UNIFORM_BUFFER, sizeof(FrameUBO), nullptr, GL_DYNAMIC_DRAW);

  // --- textures
  glGenTextures(1, &texShadow);
  glBindTexture(GL_TEXTURE_2D, texShadow);
  glTexStorage2D(GL_TEXTURE_2D, 1, GL_R32F, g_atlasW, g_atlasH);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
  checkGL("allocation des cubemaps d'ombre (pas assez de VRAM ? essaie --maxlights ou --shadowres plus petits)");
  texGI = newTex3D(GI_DIM[0], GI_DIM[1], GI_DIM[2]);
  createFog(opt.fog);
  for (int s = 0; s < 4; ++s) glGenQueries(6, qry[s]);

  initStaticUBO();
  bakeShadows();
  printHelp();

  if (opt.bench) startBench();
  g_lastFrameT = glfwGetTime();
  double hudT = g_lastFrameT, hudAcc = 0; int hudN = 0;
  std::vector<double> hudDt;
  bool done = false;
  int shotFrame = 0;

  while (!glfwWindowShouldClose(g_win) && !done) {
    double now = glfwGetTime();
    double frameDt = now - g_lastFrameT;
    g_lastFrameT = now;
    if (frameDt <= 0.0001 || frameDt > 0.1) frameDt = 0.01666667;
    float dt = (float)frameDt;

    glfwPollEvents();
    glfwGetFramebufferSize(g_win, &ow, &oh);
    if (ow <= 0 || oh <= 0) { glfwWaitEventsTimeout(0.1); continue; }
    if (g_fogMatchScreen && (g_fogW != ow || g_fogH != oh || g_fogD != g_fogMatchSlices)) {
      setCustomFog(ow, oh, g_fogMatchSlices);
    }

    // --- clavier (desactive pendant le bench automatique)
    if (popKey(GLFW_KEY_ESCAPE)) break;
    if (!benchActive) {
      static const int steps[] = {16, 32, 64, 128, 256, 512, 768, 1024, 1536, 2048, 3072, 4096};
      if (popKey(GLFW_KEY_UP)) { for (int s : steps) if (s > numLights && s <= opt.maxLights) { numLights = s; break; } }
      if (popKey(GLFW_KEY_DOWN)) { for (int i = (int)(sizeof(steps) / sizeof(int)) - 1; i >= 0; --i) if (steps[i] < numLights) { numLights = steps[i]; break; } }
      if (popKey(GLFW_KEY_R)) { scaleIdx = (scaleIdx + 1) % 4; g_scale = SCALE_STEPS[scaleIdx]; }
      if (popKey(GLFW_KEY_F)) { g_fogMatchScreen = false; createFog((fogQuality + 1) % NUM_FOG_PRESETS); g_havePrev = false; }
      if (popKey(GLFW_KEY_G)) opt.gi = !opt.gi;
      if (popKey(GLFW_KEY_O)) opt.shadows = !opt.shadows;
      if (popKey(GLFW_KEY_T)) opt.temporal = !opt.temporal;
      if (popKey(GLFW_KEY_V)) { opt.vsync = !opt.vsync; glfwSwapInterval(opt.vsync ? 1 : 0); }
      if (popKey(GLFW_KEY_F2)) { freeCam = !freeCam; }
      if (popKey(GLFW_KEY_H)) printHelp();
      if (popKey(GLFW_KEY_B)) startBench();
      if (popKey(GLFW_KEY_F12)) opt.shot = "lightbench_capture.bmp", shotFrame = -1;
    }

    // --- taille de rendu
    int nrw = std::max(16, (int)(ow * g_scale)), nrh = std::max(16, (int)(oh * g_scale));
    if (nrw != rw || nrh != rh) { createRT(nrw, nrh); g_havePrev = false; }

    // --- temps de simulation
    double simT;
    if (benchActive || opt.shot) simT = (benchActive ? benchFrame : frameIdx) / 60.0;
    else simT = now;

    // --- camera libre & deplacement dans la piece (ZQSD / WASD)
    if (freeCam && !benchActive) {
      V3 fwdFlat = norm({std::sin(camYaw), 0.0f, -std::cos(camYaw)});
      V3 rightFlat = norm({std::cos(camYaw), 0.0f, std::sin(camYaw)});
      bool fast = (glfwGetKey(g_win, GLFW_KEY_LEFT_SHIFT) == GLFW_PRESS || glfwGetKey(g_win, GLFW_KEY_RIGHT_SHIFT) == GLFW_PRESS);
      float sp = g_camMoveSpeed * (fast ? 2.2f : 1.0f) * dt;

      // AVANCER : Z (AZERTY) ou W (QWERTY) ou Fleche Haut
      if (glfwGetKey(g_win, GLFW_KEY_Z) == GLFW_PRESS || glfwGetKey(g_win, GLFW_KEY_W) == GLFW_PRESS || glfwGetKey(g_win, GLFW_KEY_UP) == GLFW_PRESS)
        camPos = camPos + fwdFlat * sp;
      // RECULER : S ou Fleche Bas
      if (glfwGetKey(g_win, GLFW_KEY_S) == GLFW_PRESS || glfwGetKey(g_win, GLFW_KEY_DOWN) == GLFW_PRESS)
        camPos = camPos - fwdFlat * sp;
      // GAUCHE : Q (AZERTY) ou A (QWERTY) ou Fleche Gauche
      if (glfwGetKey(g_win, GLFW_KEY_Q) == GLFW_PRESS || glfwGetKey(g_win, GLFW_KEY_A) == GLFW_PRESS || glfwGetKey(g_win, GLFW_KEY_LEFT) == GLFW_PRESS)
        camPos = camPos - rightFlat * sp;
      // DROITE : D ou Fleche Droite
      if (glfwGetKey(g_win, GLFW_KEY_D) == GLFW_PRESS || glfwGetKey(g_win, GLFW_KEY_RIGHT) == GLFW_PRESS)
        camPos = camPos + rightFlat * sp;
      // MONTER : Espace ou E
      if (glfwGetKey(g_win, GLFW_KEY_SPACE) == GLFW_PRESS || glfwGetKey(g_win, GLFW_KEY_E) == GLFW_PRESS)
        camPos.y += sp;
      // DESCENDRE : Ctrl Gauche, X ou C
      if (glfwGetKey(g_win, GLFW_KEY_LEFT_CONTROL) == GLFW_PRESS || glfwGetKey(g_win, GLFW_KEY_X) == GLFW_PRESS || glfwGetKey(g_win, GLFW_KEY_C) == GLFW_PRESS)
        camPos.y -= sp;

      // Limites de collision dans la salle (murs, sol, plafond)
      if (g_roomCollision) {
        camPos.x = std::max(ROOM_MIN.x + 0.8f, std::min(ROOM_MAX.x - 0.8f, camPos.x));
        camPos.y = std::max(0.6f, std::min(ROOM_MAX.y - 0.8f, camPos.y));
        camPos.z = std::max(ROOM_MIN.z + 0.8f, std::min(ROOM_MAX.z - 0.8f, camPos.z));
      }
    }

    renderFrame(simT);

    // --- Interface graphique ImGui (Menu de controle des lumieres)
    if (!benchActive) {
      ImGui_ImplOpenGL3_NewFrame();
      ImGui_ImplGlfw_NewFrame();
      ImGui::NewFrame();

      renderUI(simT);

      ImGui::Render();
      ImGui_ImplOpenGL3_RenderDrawData(ImGui::GetDrawData());
    }

    bool wantShot = opt.shot && ((opt.frames > 0 && frameIdx + 1 >= opt.frames) || shotFrame == -1);
    if (wantShot) { saveBMP(opt.shot); if (shotFrame != -1) done = true; opt.shot = (shotFrame == -1) ? nullptr : opt.shot; shotFrame = 0; }

    glfwSwapBuffers(g_win);
    ++frameIdx;

    if (opt.frames > 0 && !opt.shot && !benchActive && frameIdx >= opt.frames) done = true;

    // --- stats
    if (benchActive) {
      ++benchFrame;
      if (benchFrame > BENCH_WARM) {
        benchDt.push_back(frameDt);
        for (int p = 0; p < 6; ++p) benchPass[p] += passMs[p];
        ++benchPassN;
        int measured = benchFrame - BENCH_WARM;
        bool enough = measured >= BENCH_MAX_FRAMES || (measured >= BENCH_MIN && now - benchStartT > BENCH_MAX_SECONDS);
        if (enough) {
          finishCfg();
          ++benchIdx;
          if (benchIdx >= benchCfgs.size()) {
            benchActive = false;
            printBench(stdout, gpuName.c_str(), glVer.c_str());
            FILE* f = std::fopen("lightbench_results.txt", "w");
            if (f) { printBench(f, gpuName.c_str(), glVer.c_str()); std::fclose(f); std::printf("\nResultats enregistres dans lightbench_results.txt\n"); }
            opt = benchSaved; numLights = benchSavedLights; g_scale = benchSavedScale; createFog(benchSavedFog);
            if (opt.bench) done = true;
          } else {
            applyCfg(benchCfgs[benchIdx]);
            benchStartT = glfwGetTime();
          }
        }
      }
    } else {
      hudDt.push_back(frameDt);
      hudAcc += frameDt; ++hudN;
      if (now - hudT > 0.5) {
        double avgMs = hudAcc / hudN * 1000.0;
        double p99 = percentile(hudDt, 0.99) * 1000.0;
        double gpu = 0; for (int p = 0; p < 6; ++p) gpu += passMs[p];
        const char* fogStr = "off";
        char fogCustBuf[64];
        if (g_fogW > 0) {
          if (fogQuality >= 0 && fogQuality < NUM_FOG_PRESETS) fogStr = FOG_PRESETS[fogQuality].shortName;
          else { std::snprintf(fogCustBuf, sizeof(fogCustBuf), "%dx%dx%d", g_fogW, g_fogH, g_fogD); fogStr = fogCustBuf; }
        }
        char title[512];
        std::snprintf(title, sizeof(title),
                      "LightBench | %d lum. | %dx%d -> %dx%d | fog %s | GI %s | ombres %s | %.0f fps  moy %.2f ms  p99 %.2f ms | GPU %.2f (cull %.2f gi %.2f inj %.2f int %.2f scene %.2f post %.2f)",
                      numLights, rw, rh, ow, oh, fogStr, opt.gi ? "on" : "off", opt.shadows ? "on" : "off",
                      1000.0 / avgMs, avgMs, p99, gpu, passMs[0], passMs[1], passMs[2], passMs[3], passMs[4], passMs[5]);
        glfwSetWindowTitle(g_win, title);
        static double lastPrint = 0;
        if (now - lastPrint > 1.0) { std::printf("%s\n", title); lastPrint = now; }
        hudAcc = 0; hudN = 0; hudT = now; hudDt.clear();
      }
    }
  }

  ImGui_ImplOpenGL3_Shutdown();
  ImGui_ImplGlfw_Shutdown();
  ImGui::DestroyContext();

  glfwDestroyWindow(g_win);
  glfwTerminate();
  return 0;
}
