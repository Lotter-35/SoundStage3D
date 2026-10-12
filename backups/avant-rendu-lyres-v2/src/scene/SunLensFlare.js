/**
 * SunLensFlare.js — Lens flare du SOLEIL uniquement.
 *
 * Portage « vanilla three.js » (EffectComposer) de R3F-Ultimate-Lens-Flare
 * (Anderson Mancini, https://github.com/ektogamat/R3F-Ultimate-Lens-Flare — licence CC0).
 * Différences avec l'original :
 *  - Occlusion calculée sur le GPU à partir de la profondeur de la scène (le ciel n'écrit pas la
 *    profondeur) : 9 lectures autour du soleil, pas de lancer de rayons côté CPU.
 *  - Le flare est calculé dans une cible réduite (demi-résolution par défaut) puis ajouté à l'image :
 *    le shader d'origine est lourd (fbm, ghosts, streaks) et c'est un halo doux.
 *  - Texture de saleté d'objectif générée procéduralement (pas de téléchargement externe).
 *  - Désactivé la nuit (ambiances avec étoiles) et quand le soleil est sous l'horizon / hors champ.
 * Réglages locaux au joueur (sauvegardés dans le navigateur, jamais synchronisés).
 */
import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const STORAGE_KEY = 'soundstage3d:sun-lensflare';

export const LENS_FLARE_RESOLUTIONS = {
    'Pleine résolution': 1.0,
    'Demi-résolution': 0.5,
    'Quart de résolution': 0.25,
};

export const LENS_FLARE_DEFAULTS = {
    enabled: true,
    intensity: 0.5,
    resolution: 'Demi-résolution',
    glareSize: 0.35,
    starPoints: 6,
    flareSize: 0.005,
    flareSpeed: 0.3,
    flareShape: 0.02,
    animated: true,
    anamorphic: false,
    color: '#ff6432',
    colorGain: 56,
    haloScale: 0.5,
    secondaryGhosts: true,
    aditionalStreaks: true,
    ghostScale: 0.5,
    starBurst: true,
};

// ── Shader d'origine (fonctions reprises telles quelles) ─────────────────────
const FLARE_GLSL = /* glsl */`
  uniform float iTime;
  uniform vec2 lensPosition;
  uniform vec2 iResolution;
  uniform vec3 colorGain;
  uniform float starPoints;
  uniform float glareSize;
  uniform float flareSize;
  uniform float flareSpeed;
  uniform float flareShape;
  uniform float haloScale;
  uniform bool animated;
  uniform bool anamorphic;
  uniform bool secondaryGhosts;
  uniform bool starBurst;
  uniform float ghostScale;
  uniform bool aditionalStreaks;
  uniform sampler2D lensDirtTexture;
  vec2 vxtC;

  float rndf(float n){return fract(sin(n) * 43758.5453123);}float niz(float p){float fl = floor(p);float fc = fract(p);return mix(rndf(fl),rndf(fl + 1.0), fc);}
  vec3 hsv2rgb(vec3 c){vec4 k = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);vec3 p = abs(fract(c.xxx + k.xyz) * 6.0 - k.www);return c.z * mix(k.xxx, clamp(p - k.xxx, 0.0, 1.0), c.y);}
  float satU(float x){return clamp(x, 0.,1.);}vec2 rtU(vec2 naz, float rtn){return vec2(cos(rtn) * naz.x + sin(rtn) * naz.y,cos(rtn) * naz.y - sin(rtn) * naz.x);}
  vec3 drwF(vec2 p, float intensity, float rnd, float speed, int id){float flhos = (1. / 32.) * float(id) * 0.1;float lingrad = distance(vec2(0.), p);float expg = 1. / exp(lingrad * (fract(rnd) * 0.66 + 0.33));vec3 qzTg = hsv2rgb(vec3( fract( (expg * 8.) + speed * flareSpeed + flhos), pow(1.-abs(expg*2.-1.), 0.45), 20.0 * expg * intensity));float internalStarPoints;if(anamorphic){internalStarPoints = 1.0;} else{internalStarPoints = starPoints;}float ams = length(p * flareShape * sin(internalStarPoints * atan(p.x, p.y)));float kJhg = pow(1.-satU(ams), ( anamorphic ? 100. : 12.));kJhg += satU(expg-0.9) * 3.;kJhg = pow(kJhg * expg, 8. + (1.-intensity) * 5.);if(flareSpeed > 0.0){return vec3(kJhg) * qzTg;} else{return vec3(kJhg) * flareSize * 15.;}}
  float ams2(vec3 a, vec3 b) { return abs(a.x - b.x) + abs(a.y - b.y) + abs(a.z - b.z);}vec3 satU(vec3 x){return clamp(x, vec3(0.0), vec3(1.0));}
  float glR(vec2 naz, vec2 pos, float zsi){vec2 mni;if(animated){mni = rtU(naz-pos, iTime * 0.1);} else{mni = naz-pos;}float ang = atan(mni.y, mni.x) * (anamorphic ? 1.0 : starPoints);float ams2 = length(mni);ams2 = pow(ams2, .9);float f0 = 1.0/(length(naz-pos)*(1.0/zsi*16.0)+.2);return f0+f0*(sin((ang))*.2 +.3);}
  float sdHex(vec2 p){p = abs(p);vec2 q = vec2(p.x*2.0*0.5773503, p.y + p.x*0.5773503);return dot(step(q.xy,q.yx), 1.0-q.yx);}float fpow(float x, float k){return x > k ? pow((x-k)/(1.0-k),2.0) : 0.0;}
  vec3 rHx(vec2 naz, vec2 p, float s, vec3 col){naz -= p;if (abs(naz.x) < 0.2*s && abs(naz.y) < 0.2*s){return mix(vec3(0),mix(vec3(0),col,0.1 + fpow(length(naz/s),0.1)*10.0),smoothstep(0.0,0.1,sdHex(naz*20.0/s)));}return vec3(0);}
  vec3 mLs(vec2 naz, vec2 pos){vec2 mni = naz-pos;vec2 zxMp = naz*(length(naz));float ang = atan(mni.x,mni.y);float f0 = .3/(length(naz-pos)*16.0+1.0);f0 = f0*(sin(niz(sin(ang*3.9-(animated ? iTime : 0.0) * 0.3) * starPoints))*.2 );float f1 = max(0.01-pow(length(naz+1.2*pos),1.9),.0)*7.0;float f2 = max(.9/(10.0+32.0*pow(length(zxMp+0.99*pos),2.0)),.0)*0.35;float f22 = max(.9/(11.0+32.0*pow(length(zxMp+0.85*pos),2.0)),.0)*0.23;float f23 = max(.9/(12.0+32.0*pow(length(zxMp+0.95*pos),2.0)),.0)*0.6;vec2 ztX = mix(naz,zxMp, 0.1);float f4 = max(0.01-pow(length(ztX+0.4*pos),2.9),.0)*4.02;float f42 = max(0.0-pow(length(ztX+0.45*pos),2.9),.0)*4.1;float f43 = max(0.01-pow(length(ztX+0.5*pos),2.9),.0)*4.6;ztX = mix(naz,zxMp,-.4);float f5 = max(0.01-pow(length(ztX+0.1*pos),5.5),.0)*2.0;float f52 = max(0.01-pow(length(ztX+0.2*pos),5.5),.0)*2.0;float f53 = max(0.01-pow(length(ztX+0.1*pos),5.5),.0)*2.0;ztX = mix(naz,zxMp, 2.1);float f6 = max(0.01-pow(length(ztX-0.3*pos),1.61),.0)*3.159;float f62 = max(0.01-pow(length(ztX-0.325*pos),1.614),.0)*3.14;float f63 = max(0.01-pow(length(ztX-0.389*pos),1.623),.0)*3.12;vec3 c = vec3(glR(naz,pos, glareSize));vec2 prot;if(animated){prot = rtU(naz - pos, (iTime * 0.1));} else if(anamorphic){prot = rtU(naz - pos, 1.570796);} else {prot = naz - pos;}c += drwF(prot, (anamorphic ? flareSize * 10. : flareSize), 0.1, iTime, 1);c.r+=f1+f2+f4+f5+f6; c.g+=f1+f22+f42+f52+f62; c.b+=f1+f23+f43+f53+f63;c = c*1.3 * vec3(length(zxMp)+.09);c+=vec3(f0);return c;}
  vec3 cc(vec3 clr, float fct,float fct2){float w = clr.x+clr.y+clr.z;return mix(clr,vec3(w)*fct,w*fct2);}float rnd(vec2 p){float f = fract(sin(dot(p, vec2(12.1234, 72.8392) )*45123.2));return f;}float rnd(float w){float f = fract(sin(w)*1000.);return f;}
  float rShp(vec2 p, int N){float f;float a=atan(p.x,p.y)+.2;float b=6.28319/float(N);f=smoothstep(.5,.51, cos(floor(.5+a/b)*b-a)*length(p.xy)* 2.0  -ghostScale);return f;}
  vec3 drC(vec2 p, float zsi, float dCy, vec3 clr, vec3 clr2, float ams2, vec2 esom){float l = length(p + esom*(ams2*2.))+zsi/2.;float l2 = length(p + esom*(ams2*4.))+zsi/3.;float c = max(0.01-pow(length(p + esom*ams2), zsi*ghostScale), 0.0)*10.;float c1 = max(0.001-pow(l-0.3, 1./40.)+sin(l*20.), 0.0)*3.;float c2 =  max(0.09/pow(length(p-esom*ams2/.5)*1., .95), 0.0)/20.;float s = max(0.02-pow(rShp(p*5. + esom*ams2*5. + dCy, 6) , 1.), 0.0)*1.5;clr = cos(vec3(0.44, .24, .2)*8. + ams2*4.)*0.5+.5;vec3 f = c*clr;f += c1*clr;f += c2*clr;f +=  s*clr;return f-0.01;}
  vec4 geLC(float x){return vec4(vec3(mix(mix(mix(mix(mix(mix(mix(mix(mix(mix(mix(mix(mix(mix(mix(vec3(0., 0., 0.),vec3(0., 0., 0.), smoothstep(0.0, 0.063, x)),vec3(0., 0., 0.), smoothstep(0.063, 0.125, x)),vec3(0.0, 0., 0.), smoothstep(0.125, 0.188, x)),vec3(0.188, 0.131, 0.116), smoothstep(0.188, 0.227, x)),vec3(0.31, 0.204, 0.537), smoothstep(0.227, 0.251, x)),vec3(0.192, 0.106, 0.286), smoothstep(0.251, 0.314, x)),vec3(0.102, 0.008, 0.341), smoothstep(0.314, 0.392, x)),vec3(0.086, 0.0, 0.141), smoothstep(0.392, 0.502, x)),vec3(1.0, 0.31, 0.0), smoothstep(0.502, 0.604, x)),vec3(.1, 0.1, 0.1), smoothstep(0.604, 0.643, x)),vec3(1.0, 0.929, 0.0), smoothstep(0.643, 0.761, x)),vec3(1.0, 0.086, 0.424), smoothstep(0.761, 0.847, x)),vec3(1.0, 0.49, 0.0), smoothstep(0.847, 0.89, x)),vec3(0.945, 0.275, 0.475), smoothstep(0.89, 0.941, x)),vec3(0.251, 0.275, 0.796), smoothstep(0.941, 1.0, x))),1.0);}
  float diTN(vec2 p){vec2 f = fract(p);f = (f * f) * (3.0 - (2.0 * f));float n = dot(floor(p), vec2(1.0, 157.0));vec4 a = fract(sin(vec4(n + 0.0, n + 1.0, n + 157.0, n + 158.0)) * 43758.5453123);return mix(mix(a.x, a.y, f.x), mix(a.z, a.w, f.x), f.y);}
  float fbm(vec2 p){const mat2 m = mat2(0.80, -0.60, 0.60, 0.80);float f = 0.0;f += 0.5000*diTN(p); p = m*p*2.02;f += 0.2500*diTN(p); p = m*p*2.03;f += 0.1250*diTN(p); p = m*p*2.01;f += 0.0625*diTN(p);return f/0.9375;}
  vec4 geLS(vec2 p){vec2 pp = (p - vec2(0.5)) * 2.0;float a = atan(pp.y, pp.x);vec4 cp = vec4(sin(a * 1.0), length(pp), sin(a * 13.0), sin(a * 53.0));float d = sin(clamp(pow(length(vec2(0.5) - p) * 0.5 + haloScale /2., 5.0), 0.0, 1.0) * 3.14159);vec3 c = vec3(d) * vec3(fbm(cp.xy * 16.0) * fbm(cp.zw * 9.0) * max(max(max(max(0.5, sin(a * 1.0)), sin(a * 3.0) * 0.8), sin(a * 7.0) * 0.8), sin(a * 9.0) * 10.6));c *= vec3(mix(2.0, (sin(length(pp.xy) * 256.0) * 0.5) + 0.5, sin((clamp((length(pp.xy) - 0.875) / 0.1, 0.0, 1.0) + 0.0) * 2.0 * 3.14159) * 1.5) + 0.5) * 0.3275;return vec4(vec3(c * 1.0), d);}
  vec4 geLD(vec2 p){p.xy += vec2(fbm(p.yx * 3.0), fbm(p.yx * 2.0)) * 0.0825;vec3 o = vec3(mix(0.125, 0.25, max(max(smoothstep(0.1, 0.0, length(p - vec2(0.25))),smoothstep(0.4, 0.0, length(p - vec2(0.75)))),smoothstep(0.8, 0.0, length(p - vec2(0.875, 0.125))))));o += vec3(max(fbm(p * 1.0) - 0.5, 0.0)) * 0.5;o += vec3(max(fbm(p * 2.0) - 0.5, 0.0)) * 0.5;o += vec3(max(fbm(p * 4.0) - 0.5, 0.0)) * 0.25;o += vec3(max(fbm(p * 8.0) - 0.75, 0.0)) * 1.0;o += vec3(max(fbm(p * 16.0) - 0.75, 0.0)) * 0.75;o += vec3(max(fbm(p * 64.0) - 0.75, 0.0)) * 0.5;return vec4(clamp(o, vec3(0.15), vec3(1.0)), 1.0);}
  vec4 txL(sampler2D tex, vec2 xtC){if(((xtC.x < 0.) || (xtC.y < 0.)) || ((xtC.x > 1.) || (xtC.y > 1.))){return vec4(0.0);}else{return texture(tex, xtC); }}
  vec4 txD(sampler2D tex, vec2 xtC, vec2 dir, vec3 ditn) {return vec4(txL(tex, (xtC + (dir * ditn.r))).r,txL(tex, (xtC + (dir * ditn.g))).g,txL(tex, (xtC + (dir * ditn.b))).b,1.0);}
  vec4 strB(){vec2 aspXtc = vec2(1.0) - (((vxtC - vec2(0.5)) * vec2(1.0)) + vec2(0.5)); vec2 xtC = vec2(1.0) - vxtC; vec2 ghvc = (vec2(0.5) - xtC) * 0.3 - lensPosition; vec2 ghNm = normalize(ghvc * vec2(1.0)) * vec2(1.0);vec2 haloVec = normalize(ghvc) * 0.6;vec2 hlNm = ghNm * 0.6;vec2 texelSize = vec2(1.0) / vec2(iResolution.xy);vec3 ditn = vec3(-(texelSize.x * 1.5), 0.2, texelSize.x * 1.5);vec4 c = vec4(0.0);for (int i = 0; i < 8; i++) {vec2 offset = xtC + (ghvc * float(i));c += txD(lensDirtTexture, offset, ghNm, ditn) * pow(max(0.0, 1.0 - (length(vec2(0.5) - offset) / length(vec2(0.5)))), 10.0);}vec2 uyTrz = xtC + hlNm; return (c * geLC((length(vec2(0.5) - aspXtc) / length(vec2(haloScale))))) +(txD(lensDirtTexture, uyTrz, ghNm, ditn) * pow(max(0.0, 1.0 - (length(vec2(0.5) - uyTrz) / length(vec2(0.5)))), 10.0));}

  // mainImage d'origine, réduit au calcul du flare seul (ajouté ensuite à l'image)
  vec3 flareColor(vec2 r){vec2 g=r-.5;g.y*=iResolution.y/iResolution.x;vec2 l=lensPosition*.5;l.y*=iResolution.y/iResolution.x;vec3 f=mLs(g,l)*20.*colorGain/256.;if(aditionalStreaks){vec3 o=vec3(.9,.2,.1),p=vec3(.3,.1,.9);for(float n=0.;n<10.;n++)f+=drC(g,pow(rnd(n*2e3)*2.8,.1)+1.41,0.,o+n,p+n,rnd(n*20.)*3.+.2-.5,lensPosition);}if(secondaryGhosts){vec3 n=vec3(0);n+=rHx(g,-lensPosition*.25,ghostScale*1.4,vec3(.25,.35,0));n+=rHx(g,lensPosition*.25,ghostScale*.5,vec3(1,.5,.5));n+=rHx(g,lensPosition*.1,ghostScale*1.6,vec3(1));n+=rHx(g,lensPosition*1.8,ghostScale*2.,vec3(0,.5,.75));n+=rHx(g,lensPosition*1.25,ghostScale*.8,vec3(1,1,.5));n+=rHx(g,-lensPosition*1.25,ghostScale*5.,vec3(.5,.5,.25));n+=fpow(1.-abs(distance(lensPosition*.8,g)-.7),.985)*colorGain/2100.;f+=n;}if(starBurst){vxtC=g+.5;vec4 n=geLD(g);float o=1.-clamp(0.5,0.,.5)*2.;n+=mix(n,pow(n*2.,vec4(2))*.5,o);float s=(g.x+g.y)*(1./6.);vec2 d=mat2(cos(s),-sin(s),sin(s),cos(s))*vxtC;n+=geLS(d)*2.;f+=clamp(n.xyz*strB().xyz,.01,1.);}return f;}
`;

const VERTEX = /* glsl */`
    varying vec2 vUv;
    void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
    }
`;

function createFlareMaterial(dirt) {
    return new THREE.ShaderMaterial({
        uniforms: {
            iTime: { value: 0 },
            lensPosition: { value: new THREE.Vector2() },
            iResolution: { value: new THREE.Vector2(1, 1) },
            colorGain: { value: new THREE.Color(56, 22, 11) },
            starPoints: { value: 6 },
            glareSize: { value: 0.35 },
            flareSize: { value: 0.005 },
            flareSpeed: { value: 0.3 },
            flareShape: { value: 0.02 },
            haloScale: { value: 0.5 },
            animated: { value: true },
            anamorphic: { value: false },
            secondaryGhosts: { value: true },
            starBurst: { value: true },
            ghostScale: { value: 0.5 },
            aditionalStreaks: { value: true },
            lensDirtTexture: { value: dirt },
            tDepth: { value: null },
            uVisibility: { value: 0 },
            uIntensity: { value: 1 },
            uOccRadius: { value: new THREE.Vector2(0.004, 0.007) },
        },
        vertexShader: VERTEX,
        fragmentShader: FLARE_GLSL + /* glsl */`
            uniform highp sampler2D tDepth;
            uniform float uVisibility;
            uniform float uIntensity;
            uniform vec2 uOccRadius;
            varying vec2 vUv;

            // Part visible du disque solaire : 9 lectures de profondeur (le ciel n'écrit pas la profondeur)
            float sunVisibility() {
                vec2 suv = lensPosition * 0.5 + 0.5;
                float v = 0.0;
                for (int i = 0; i < 9; i++) {
                    vec2 o = vec2(float(i % 3) - 1.0, float(i / 3) - 1.0) * uOccRadius;
                    v += step(0.99999, texture(tDepth, clamp(suv + o, 0.0, 1.0)).r);
                }
                return v / 9.0;
            }

            void main() {
                float vis = uVisibility * sunVisibility();
                if (vis <= 0.001) { gl_FragColor = vec4(0.0); return; }
                vec3 f = max(flareColor(vUv), vec3(0.0));
                gl_FragColor = vec4(f * vis * uIntensity, 1.0);
            }
        `,
        depthTest: false,
        depthWrite: false,
    });
}

function createCompositeMaterial() {
    return new THREE.ShaderMaterial({
        uniforms: { tDiffuse: { value: null }, tFlare: { value: null } },
        vertexShader: VERTEX,
        fragmentShader: /* glsl */`
            uniform sampler2D tDiffuse;
            uniform sampler2D tFlare;
            varying vec2 vUv;
            void main() {
                vec4 base = texture2D(tDiffuse, vUv);
                gl_FragColor = vec4(base.rgb + texture2D(tFlare, vUv).rgb, base.a);
            }
        `,
        depthTest: false,
        depthWrite: false,
    });
}

/** Saleté d'objectif procédurale (taches douces) — remplace la texture téléchargée de l'original */
function createLensDirtTexture() {
    const size = 512;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    g.fillStyle = '#101010';
    g.fillRect(0, 0, size, size);
    let seed = 1337;
    const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const blob = (x, y, r, a) => {
        const grd = g.createRadialGradient(x, y, 0, x, y, r);
        grd.addColorStop(0, `rgba(255,255,255,${a})`);
        grd.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = grd;
        g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    };
    for (let i = 0; i < 260; i++) blob(rand() * size, rand() * size, 2 + rand() * 10, 0.15 + rand() * 0.35);
    for (let i = 0; i < 40; i++) blob(rand() * size, rand() * size, 20 + rand() * 60, 0.05 + rand() * 0.12);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.NoColorSpace;
    return tex;
}

function loadParams() {
    const p = { ...LENS_FLARE_DEFAULTS };
    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
        if (saved && typeof saved === 'object') {
            for (const k of Object.keys(p)) if (k in saved && typeof saved[k] === typeof p[k]) p[k] = saved[k];
        }
    } catch (_) {}
    return p;
}

/**
 * Passe de post-traitement (à insérer avant la sortie finale) : calcule le flare dans une cible
 * réduite puis l'ajoute à l'image.
 */
export class SunLensFlarePass extends Pass {
    constructor(camera, sceneDepth) {
        super();
        this.camera = camera;
        this.sceneDepth = sceneDepth;
        this.needsSwap = true;
        this.enabled = false;
        this.params = loadParams();

        this._dirt = createLensDirtTexture();
        this._flareMat = createFlareMaterial(this._dirt);
        this._compMat = createCompositeMaterial();
        this._flareQuad = new FullScreenQuad(this._flareMat);
        this._compQuad = new FullScreenQuad(this._compMat);
        this.flareTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false });
        this.flareTarget.texture.generateMipmaps = false;
        this._w = 1;
        this._h = 1;

        this._vis = 0;           // visibilité lissée (fondu d'apparition / disparition)
        this._sunDir = new THREE.Vector3();
        this._tmp = new THREE.Vector3();
        this._camDir = new THREE.Vector3();
        this._applyParams();
    }

    _applyParams() {
        const p = this.params;
        const u = this._flareMat.uniforms;
        u.glareSize.value = p.glareSize;
        u.starPoints.value = p.starPoints;
        u.flareSize.value = p.flareSize;
        u.flareSpeed.value = p.flareSpeed;
        u.flareShape.value = p.flareShape;
        u.animated.value = p.animated;
        u.anamorphic.value = p.anamorphic;
        u.colorGain.value.set(p.color).multiplyScalar(p.colorGain);
        u.haloScale.value = p.haloScale;
        u.secondaryGhosts.value = p.secondaryGhosts;
        u.aditionalStreaks.value = p.aditionalStreaks;
        u.ghostScale.value = p.ghostScale;
        u.starBurst.value = p.starBurst;
        u.uIntensity.value = p.intensity;
        this.setSize(this._w, this._h);
    }

    setParam(key, value) {
        if (!(key in LENS_FLARE_DEFAULTS)) return;
        this.params[key] = value;
        this._applyParams();
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.params)); } catch (_) {}
    }

    resetParams() {
        Object.assign(this.params, LENS_FLARE_DEFAULTS); // même objet : les contrôles restent liés
        this._applyParams();
        try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
    }

    setSize(width, height) {
        this._w = width;
        this._h = height;
        const s = LENS_FLARE_RESOLUTIONS[this.params.resolution] || 0.5;
        const w = Math.max(1, Math.round(width * s));
        const h = Math.max(1, Math.round(height * s));
        this.flareTarget.setSize(w, h);
        this._flareMat.uniforms.iResolution.value.set(w, h);
        // Rayon du test d'occlusion ≈ taille apparente du disque solaire (indépendant de la résolution)
        const aspect = width / Math.max(1, height);
        this._flareMat.uniforms.uOccRadius.value.set(0.004, 0.004 * aspect);
    }

    /**
     * À appeler chaque image : position du soleil à l'écran, visibilité, activation de la passe.
     * @param {THREE.DirectionalLight} sun
     * @param {number} dt
     * @param {boolean} isNight ambiance de nuit (la lumière directionnelle est alors la lune)
     */
    update(sun, dt, isNight) {
        const u = this._flareMat.uniforms;
        let target = 0;
        if (this.params.enabled && sun && !isNight && sun.intensity > 0.05) {
            this._sunDir.copy(sun.position).sub(sun.target.position).normalize();
            if (this._sunDir.y > -0.02) {
                const cam = this.camera;
                cam.getWorldDirection(this._camDir);
                if (this._camDir.dot(this._sunDir) > 0.05) {
                    this._tmp.copy(cam.position).addScaledVector(this._sunDir, 1000).project(cam);
                    u.lensPosition.value.set(this._tmp.x, this._tmp.y);
                    const m = Math.max(Math.abs(this._tmp.x), Math.abs(this._tmp.y));
                    // Fondu quand le soleil sort de l'écran, et près de l'horizon
                    target = (1 - THREE.MathUtils.smoothstep(m, 1.0, 1.35)) * THREE.MathUtils.smoothstep(this._sunDir.y, -0.02, 0.06);
                }
            }
        }
        this._vis += (target - this._vis) * Math.min(1, dt * 6);
        if (this._vis < 0.002 && target === 0) this._vis = 0;
        u.uVisibility.value = this._vis;
        if (this.params.animated) u.iTime.value += dt;
        this.enabled = this._vis > 0.002;
    }

    render(renderer, writeBuffer, readBuffer) {
        const depth = (this.sceneDepth && this.sceneDepth.texture) || readBuffer.depthTexture;
        this._flareMat.uniforms.tDepth.value = depth;
        renderer.setRenderTarget(this.flareTarget);
        this._flareQuad.render(renderer);

        this._compMat.uniforms.tDiffuse.value = readBuffer.texture;
        this._compMat.uniforms.tFlare.value = this.flareTarget.texture;
        renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
        this._compQuad.render(renderer);
    }

    dispose() {
        this.flareTarget.dispose();
        this._flareMat.dispose();
        this._compMat.dispose();
        this._flareQuad.dispose();
        this._compQuad.dispose();
        this._dirt.dispose();
    }
}
