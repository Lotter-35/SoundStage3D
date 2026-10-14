/**
 * GIGridPass.js
 * ─────────────────────────────────────────────────────────────
 * LUMIÈRE INDIRECTE (GI, plan R5) : grille 3D de la salle (comme le banc C++ : 48 × 16 × 64), éclairée par
 * la lumière des lyres renvoyée par le décor (un rebond), mise à jour par TRANCHES et lissée dans le temps.
 * Lue par le décor (LightPoolShaders : rebond × albédo) et par le brouillard de salle (HazeShaders).
 *
 * Par image :
 *   1. lumières virtuelles : K rayons par cône de lyre (budget total fixe, K = budget / cônes, 2 à 16),
 *      arrêtés sur le décor par la cubemap de distances de la lyre (GIShaders.js) — une petite texture ;
 *   2. 1/div des couches z de la grille (div = 4 en Haute, 8 en Basse), une couche par dessin ; mélange
 *      alpha (nouvelle valeur × α + ancienne × (1 − α)) : une lyre qui bouge ne fait pas scintiller la GI ;
 *   3. champ lointain (5 texels) : toutes les lumières virtuelles résumées, lu hors de la grille et sur ses
 *      bords (fondu) — la lumière ne s'arrête pas net au bord de la boîte.
 *
 * Choix de la texture 3D (WebGL3DRenderTarget, RGBA16F) plutôt qu'un atlas 2D de couches : la lecture est
 * le chemin chaud (chaque pixel du décor, chaque tranche du brouillard) et le filtrage trilinéaire matériel
 * la fait en 1 lecture (atlas 2D : 2 lectures + interpolation en z à la main) ; l'écriture couche par
 * couche ne coûte qu'un dessin par couche (16 par image au plus) sur une cible minuscule (48 × 16).
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { createVPLMaterial, createGIGridMaterial, createGIFarMaterial, GI_MAX_VPL_PER_CONE, GI_MAX_BEAM_PTS } from './GIShaders.js';
import { createGIUniforms } from './giGLSL.js';
import { SS_MAX_LIGHTS, SS_GEO } from '../ssdepth/SSDepthLights.js';
import { gpuPassTimer } from '../../render/GpuPassTimer.js';

/** Qualités (option locale « Qualité GI ») : taille de la grille, couches par image (1/div), budget de
 *  lumières virtuelles, lissage temporel (α par mise à jour d'une cellule) */
export const GI_QUALITIES = {
    low:  { dims: [32, 12, 40], div: 8, vpl: 192, alpha: 0.6 },
    high: { dims: [48, 16, 64], div: 4, vpl: 512, alpha: 0.5 },
};

/** Volume couvert au départ (m) ; ensuite placé automatiquement autour des lyres et de leurs taches
 *  (_autoBounds) : la GI fonctionne n'importe où sur la carte */
export const GI_BOUNDS_MIN = [-30, 0, -15];
export const GI_BOUNDS_SIZE = [60, 25, 80];

const _bMin = new THREE.Vector3();
const _bSize = new THREE.Vector3();
const _n0 = new THREE.Vector3();
const _n1 = new THREE.Vector3();

export class GIGridPass extends Pass {
    /**
     * @param {import('../ssdepth/SSDepthLights.js').SSDepthLights} lights
     * @param {import('../SpotBatch.js').SpotBatch} batch
     * @param {object} shadowUniforms uniformes partagés des ombres statiques
     */
    constructor(lights, batch, shadowUniforms) {
        super();
        this.lights = lights;
        this.batch = batch;
        this.needsSwap = false;
        this.profileSelf = true;
        this.enabled = false;
        /** Uniformes de lecture partagés par le décor et le brouillard */
        this.uniforms = createGIUniforms();
        this._min = new THREE.Vector3().fromArray(GI_BOUNDS_MIN);
        this._size = new THREE.Vector3().fromArray(GI_BOUNDS_SIZE);
        this.uniforms.uGIMin.value.copy(this._min);
        this.uniforms.uGISize.value.copy(this._size);
        /** Vrai quand la grille contient de la lumière (les lecteurs peuvent la lire) */
        this.active = false;
        this.quality = null;
        this.grid = null;
        this.gain = 60;
        this.hazeK = 0.6 * 0.035;      // densité de la fumée des faisceaux (lumière diffusée autour d'eux)
        this.vplCount = 0;
        this.layersPerFrame = 0;
        this._frame = 0;
        this._bmin = new THREE.Vector3();
        this._bmax = new THREE.Vector3();
        this._winSince = 0;            // début de la fenêtre de rétrécissement (0 : aucune)
        this._win0 = new THREE.Vector3();
        this._win1 = new THREE.Vector3();
        this._hasLight = false;
        this.vplTarget = new THREE.WebGLRenderTarget(2 * (GI_MAX_VPL_PER_CONE + GI_MAX_BEAM_PTS), SS_MAX_LIGHTS, {
            type: THREE.FloatType, depthBuffer: false, stencilBuffer: false,
            minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
        });
        this.vplMaterial = createVPLMaterial(shadowUniforms);
        this.gridMaterial = createGIGridMaterial();
        this.farTarget = new THREE.WebGLRenderTarget(5, 1, {
            type: THREE.FloatType, depthBuffer: false, stencilBuffer: false,
            minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
        });
        this.farMaterial = createGIFarMaterial();
        this._farQuad = new FullScreenQuad(this.farMaterial);
        this.uniforms.uGIFar.value = this.farTarget.texture;
        this._vplQuad = new FullScreenQuad(this.vplMaterial);
        this._gridQuad = new FullScreenQuad(this.gridMaterial);
    }

    /** @param {'off'|'low'|'high'} q qualité (option locale) */
    setQuality(q) {
        const Q = GI_QUALITIES[q] || null;
        if (Q === this.quality) return;
        this.quality = Q;
        if (this.grid) { this.grid.dispose(); this.grid = null; }
        this.active = false;
        this._hasLight = false;
        if (!Q) { this.uniforms.uGI.value = null; return; }
        const [nx, ny, nz] = Q.dims;
        const grid = new THREE.WebGL3DRenderTarget(nx, ny, nz, {
            type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false,
        });
        // three r160 : la texture 3D de la cible ignore les options (type à poser à la main)
        const t = grid.texture;
        t.type = THREE.HalfFloatType;
        t.format = THREE.RGBAFormat;
        t.minFilter = THREE.LinearFilter;
        t.magFilter = THREE.LinearFilter;
        t.wrapS = t.wrapT = t.wrapR = THREE.ClampToEdgeWrapping;
        t.generateMipmaps = false;
        this.grid = grid;
        this.uniforms.uGI.value = t;
        this.uniforms.uGIEdge.value.set(0.5 / nx, 0.5 / ny, 0.5 / nz);
        this._applyCells();
        this._cleared = false;
    }

    /**
     * Volume couvert par la grille (boîte du brouillard de salle) ; la lumière déjà calculée est effacée
     * @param {THREE.Vector3} min coin bas
     * @param {THREE.Vector3} size dimensions (m)
     */
    setBounds(min, size) {
        if (this._min.equals(min) && this._size.equals(size)) return;
        this._min.copy(min);
        this._size.set(Math.max(size.x, 1), Math.max(size.y, 1), Math.max(size.z, 1));
        this.uniforms.uGIMin.value.copy(this._min);
        this.uniforms.uGISize.value.copy(this._size);
        this._applyCells();
        this._hasLight = false;
        this.active = false;
        this._cleared = false;
    }

    /**
     * Grille placée autour des lyres allumées et des points où leurs cônes touchent le sol (+ marge pour le
     * rebond : la moitié de l'étendue, 12 à 30 m, pour que le fondu vers le champ lointain se fasse là où la
     * lumière est déjà faible), arrondie à 4 m. Lyres en mouvement : la boîte choisie a du jeu (8 m de plus de
     * chaque côté, hauteur arrondie à 8 m) pour ne pas se recaler à chaque balayage ; elle grandit dès que le
     * volume utile en sort (sans rétrécir ailleurs), rétrécit seulement si tout ce qui a servi pendant 10 s en
     * occupe moins de 60 % (un balayage régulier finit donc avec une boîte qui ne bouge plus). Chaque recalage
     * recalcule toute la grille d'un coup (render) : pas de lumière décalée qui clignote.
     */
    _autoBounds(n, now) {
        const geo = this.lights._geo;
        const G = SS_GEO;
        const lo = this._bmin.set(Infinity, Infinity, Infinity);
        const hi = this._bmax.set(-Infinity, -Infinity, -Infinity);
        for (let i = 0; i < n; i++) {
            const g = i * G;
            const sx = geo[g], sy = geo[g + 1], sz = geo[g + 2];
            // Bout du cône le plus lointain (taches) et sa section
            const e = geo[g + 19] > 0.5 ? 14 : 4;
            const ex = geo[g + e], ey = geo[g + e + 1], ez = geo[g + e + 2], er = geo[g + e + 3];
            let dx = ex - sx, dy = ey - sy, dz = ez - sz;
            const len = Math.hypot(dx, dy, dz) || 1;
            dx /= len; dy /= len; dz /= len;
            // Jusqu'au sol, borné à 1,5 × la hauteur (40 m au moins) que le cône touche le sol ou non : sinon la
            // boîte bondit quand une lyre qui balaie passe l'horizontale ; au-delà, le champ lointain prend le relais
            const cap = Math.max(40, 1.5 * sy);
            const t = Math.min(len, cap, dy < -0.02 ? sy / -dy : Infinity);
            const k = t / len;
            const r = geo[g + 3] + (er - geo[g + 3]) * k;
            const px = sx + dx * t, py = sy + dy * t, pz = sz + dz * t;
            lo.x = Math.min(lo.x, sx, px - r); hi.x = Math.max(hi.x, sx, px + r);
            lo.y = Math.min(lo.y, sy, py); hi.y = Math.max(hi.y, sy, py);
            lo.z = Math.min(lo.z, sz, pz - r); hi.z = Math.max(hi.z, sz, pz + r);
        }
        if (!(lo.x <= hi.x)) return;
        const mg = Math.min(30, Math.max(12, 0.5 * Math.max(hi.x - lo.x, hi.z - lo.z)));
        // Volume utile de cette image
        const n0 = _n0.set(lo.x - mg, Math.min(-1.5, lo.y - 1.5), lo.z - mg);
        const n1 = _n1.set(hi.x + mg, Math.max(8, hi.y + 3), hi.z + mg);
        const cur = this._min, cs = this._size;
        const fits = n0.x >= cur.x && n0.z >= cur.z && n0.y >= cur.y - 0.01
            && n1.x <= cur.x + cs.x && n1.z <= cur.z + cs.z && n1.y <= cur.y + cs.y + 0.01;
        if (!fits) {
            // Grandit tout de suite, sans rétrécir ailleurs (union avec la boîte actuelle : pas de va-et-vient
            // pendant un balayage)
            this._winSince = 0;
            this._boxAround(n0, n1);
            _bSize.add(_bMin);   // coin haut
            _bMin.min(cur);
            _bSize.max(_n1.copy(cur).add(cs)).sub(_bMin);
            this.setBounds(_bMin, _bSize);
            return;
        }
        // Rétrécit vers l'union des volumes utiles des 10 dernières secondes, s'il en occupe moins de 60 %
        if (!this._winSince) { this._winSince = now; this._win0.copy(n0); this._win1.copy(n1); }
        else { this._win0.min(n0); this._win1.max(n1); }
        this._boxAround(this._win0, this._win1);
        if (_bSize.x * _bSize.y * _bSize.z >= 0.6 * cs.x * cs.y * cs.z) {
            this._winSince = now; this._win0.copy(n0); this._win1.copy(n1);
            return;
        }
        if (now - this._winSince < 10000) return;
        this._winSince = 0;
        this.setBounds(_bMin, _bSize);
    }

    /** Boîte de la grille (_bMin, _bSize) autour du volume [a, b] : 8 m de jeu de chaque côté, arrondie à 4 m,
     *  hauteur arrondie à 8 m ; sol à plus d'une cellule du bas (fondu d'une demi-cellule en hauteur), même
     *  avec des lyres très hautes */
    _boxAround(a, b) {
        const S = 4, SLACK = 8;
        const minX = Math.floor((a.x - SLACK) / S) * S, maxX = Math.ceil((b.x + SLACK) / S) * S;
        const minZ = Math.floor((a.z - SLACK) / S) * S, maxZ = Math.ceil((b.z + SLACK) / S) * S;
        const maxY = Math.ceil((b.y + 4) / 8) * 8;
        const ny = this.quality.dims[1];
        const minY = Math.min(Math.floor(a.y), -Math.ceil(1.6 * (maxY + 1.5) / ny));
        _bMin.set(minX, minY, minZ);
        _bSize.set(maxX - minX, maxY - minY, maxZ - minZ);
    }

    _applyCells() {
        if (!this.quality) return;
        const [nx, ny, nz] = this.quality.dims;
        const u = this.gridMaterial.uniforms;
        u.uMin.value.copy(this._min);
        u.uCell.value.set(this._size.x / nx, this._size.y / ny, this._size.z / nz);
        u.uR0.value = 0.35 * u.uCell.value.lengthSq();
        this.uniforms.uGIR0.value = u.uR0.value;
    }

    /** Lumière effacée (GI désactivée puis réactivée : pas de reste d'une ancienne image) */
    reset() {
        this._hasLight = false;
        this.active = false;
    }

    /** Texture de la pelouse (albédo du sol) */
    setGrassTexture(tex) {
        this.vplMaterial.uniforms.uGrass.value = tex || null;
        this.vplMaterial.uniforms.uGrassOn.value = tex ? 1 : 0;
    }

    /** Couches de la grille remises à zéro (aucune lumière) */
    _clear(renderer) {
        const nz = this.quality.dims[2];
        const old = renderer.getClearColor(new THREE.Color());
        const oldA = renderer.getClearAlpha();
        renderer.setClearColor(0x000000, 0);
        for (let z = 0; z < nz; z++) {
            renderer.setRenderTarget(this.grid, z);
            renderer.clear(true, false, false);
        }
        renderer.setClearColor(old, oldA);
    }

    render(renderer) {
        const Q = this.quality;
        if (!Q || !this.grid) { this.active = false; return; }
        const n = Math.min(this.lights.count, SS_MAX_LIGHTS);
        const oldAutoClear = renderer.autoClear;
        renderer.autoClear = false;
        if (n === 0) {
            // Plus aucune lyre allumée : grille vidée une fois, plus rien à lire
            if (this._hasLight || !this._cleared) { this._clear(renderer); this._cleared = true; }
            this._hasLight = false;
            this.active = false;
            this.vplCount = 0;
            renderer.autoClear = oldAutoClear;
            return;
        }
        this._autoBounds(n, performance.now());
        // Première lumière, grille neuve ou recalée : TOUTES les couches recalculées dans cette image, sans
        // lissage (sinon, pendant div images, les couches pas encore refaites montrent l'ancienne lumière décalée)
        const full = !this._hasLight;
        this._hasLight = true;
        const timer = gpuPassTimer.enabled ? gpuPassTimer : null;
        // Budget : ⅗ sur le décor, ⅖ le long des faisceaux
        const K = Math.max(2, Math.min(GI_MAX_VPL_PER_CONE, Math.floor(Q.vpl * 0.6 / n)));
        const M = this.hazeK > 0 ? Math.max(1, Math.min(GI_MAX_BEAM_PTS, Math.floor(Q.vpl * 0.4 / n))) : 0;
        this.vplCount = (K + M) * n;

        // 1. Lumières virtuelles (K par cône)
        const v = this.vplMaterial.uniforms;
        v.uSpotParams.value = this.batch.paramsTexture;
        v.uGobos.value = this.batch.goboTexture;
        v.uGateAtlas.value = this.batch.gateAtlas.texture;
        v.uSSLights.value = this.lights.lightsTexture;
        v.uK.value = K;
        v.uM.value = M;
        v.uHazeK.value = this.hazeK;
        // Rayons fixes (pas de rotation d'une image à l'autre) : lumières immobiles → GI immobile
        // (la rotation faisait glisser des traits sur le sol)
        v.uSpin.value = 0;
        v.uGain.value = this.gain;
        if (timer) timer.begin('GI (lumières virtuelles)');
        this.vplTarget.viewport.set(0, 0, 2 * (K + M), n);
        renderer.setRenderTarget(this.vplTarget);
        this._vplQuad.render(renderer);

        // 2. Couches de la grille : 1/div par image, lissées dans le temps
        if (timer) timer.begin('GI (grille)');
        const g = this.gridMaterial.uniforms;
        g.uVPL.value = this.vplTarget.texture;
        g.uCones.value = n;
        g.uK.value = K;
        g.uM.value = M;
        g.uAlpha.value = full ? 1 : Q.alpha;
        const nz = Q.dims[2];
        const step = full ? 1 : Q.div;
        let layers = 0;
        for (let z = full ? 0 : this._frame % Q.div; z < nz; z += step) {
            g.uZ.value = z;
            renderer.setRenderTarget(this.grid, z);
            this._gridQuad.render(renderer);
            layers++;
        }

        // 3. Champ lointain (toutes les lumières virtuelles de l'image, sans lissage : 5 pixels)
        const f = this.farMaterial.uniforms;
        f.uVPL.value = this.vplTarget.texture;
        f.uCones.value = n;
        f.uK.value = K;
        f.uM.value = M;
        renderer.setRenderTarget(this.farTarget);
        this._farQuad.render(renderer);
        if (timer) timer.end();
        this.layersPerFrame = layers;
        this._frame++;
        this.active = true;
        renderer.autoClear = oldAutoClear;
    }

    dispose() {
        if (this.grid) this.grid.dispose();
        this.vplTarget.dispose();
        this.vplMaterial.dispose();
        this.gridMaterial.dispose();
        this.farTarget.dispose();
        this.farMaterial.dispose();
        this._farQuad.dispose();
        this._vplQuad.dispose();
        this._gridQuad.dispose();
    }
}
