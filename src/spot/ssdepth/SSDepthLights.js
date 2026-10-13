/**
 * SSDepthLights.js
 * ─────────────────────────────────────────────────────────────
 * Côté CPU du rendu des faisceaux « SS Depth » (Screen-Space Depth, mode 5 du banc LightBench) :
 *
 * 1. collect() — une fois par image, après la mise à jour des lyres : chaque lyre en mode SS Depth (faisceau)
 *    et, quand les taches de lumière sont actives, CHAQUE lyre allumée (tache, quel que soit le rendu de son
 *    faisceau) donne un CÔNE par facette du prisme (faisceau central + facettes), décrit dans une texture de
 *    paramètres (SS_LIGHT_TEXELS texels RGBA32F par cône). Lyres éteintes / noires : aucun cône.
 * 2. bin() — au moment du rendu (matrices de la caméra à jour) : chaque cône est projeté à l'écran
 *    (octogone circonscrit aux deux bouts, découpé par le plan proche) et ajouté aux listes des tuiles
 *    qu'il touche réellement (étendue de chaque ligne de tuiles : coût ∝ tuiles touchées).
 *    DEUX listes : faisceaux SS Depth (cône jusqu'à la longueur visible) et taches de lumière (cône jusqu'à
 *    la portée : la lumière éclaire plus loin que le faisceau visible). Une seule projection quand les deux
 *    longueurs sont égales.
 *    Listes envoyées dans des textures entières RGBA16UI : une ligne par tuile (nombre, puis 4 indices par texel).
 *
 * Cône d'une facette : les facettes sortent toutes de la lentille. Dans le repère du faisceau central
 * (W axe, R/U fenêtre), la facette est un cône OBLIQUE : sections perpendiculaires à W circulaires, centre
 * décalé de V·z (V = décalage de la facette × tan(zoom/2)). Son intersection avec un rayon reste une
 * équation du 2e degré (cisaillement linéaire), voir SSDepthShaders.js.
 *
 * Aucune allocation par image : tableaux typés et vecteurs réutilisés.
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';

/** Tuiles de l'écran (listes de cônes) */
export const SS_TILES_X = 32;
export const SS_TILES_Y = 18;
export const SS_TILE_COUNT = SS_TILES_X * SS_TILES_Y;
/** Cônes au plus par tuile = tous les cônes (SS_MAX_LIGHTS) : une tuile pleine perdait des faisceaux, d'où des
 *  carrés de la taille d'une tuile (126 lyres à prisme 8 facettes = 1008 cônes, tous près des lyres) */
export const SS_MAX_PER_TILE = 1024;
/** Texels par ligne de tuile : nombre (texel 0), puis 4 indices par texel */
export const SS_TILE_TEXELS = 1 + SS_MAX_PER_TILE / 4;
/** Texels RGBA32F par cône (voir le format ci-dessous) */
export const SS_LIGHT_TEXELS = 9;
/** Cônes au plus (50 lyres × 9 facettes = 450) */
export const SS_MAX_LIGHTS = 1024;

/*
 * Format d'un cône (ligne de la texture uSSLights). Les 3 premiers texels suffisent au test d'intersection
 * (rayon et tache au sol) : un cône que le pixel ne touche pas ne coûte que 3 lectures.
 * L0 : apex du cône oblique (xyz)          , tan du demi-angle (iris + marges de flou)
 * L1 : axe central W (xyz)                 , z de la lentille depuis l'apex (= LENS_RADIUS / tan(zoom/2))
 * L2 : décalage des sections V (monde)     , z de fin (diffusion ou tache au sol, la plus lointaine)
 * L3 : droite de la fenêtre R (xyz)        , ligne de paramètres de la lyre (texture uSpotParams)
 * L4 : couleur A (rgb)                     , éclairement à 1 m de l'apex (flux × poids / (π tan²))
 * L5 : tan(zoom/2) , iris , flou du frost , log(distance de mise au point)
 * L6 : image de fenêtre (0 disque, 1 disque × transmission moyenne, 2 atlas, 3 calculée) , tuile de l'atlas ,
 *      poids de la tache au sol , obstacles (0/1)
 * L7 : longueur visible , début du fondu de la diffusion , portée , début du fondu de la tache
 * L8 : décalage de la facette en unités de fenêtre (xy) , éclairement des taches à 1 m de l'apex
 *      (lumière émise × poids / (π tan²)) , emplacement de l'ombre statique (−1 = aucune, voir lighting/)
 */

/** Flottants de géométrie de projection par cône (bin) ; drapeaux (faisceau SS Depth, tache) */
export const SS_GEO = 20;
export const SS_FLAG_BEAM = 1;
const GEO = SS_GEO;
const FLAG_BEAM = SS_FLAG_BEAM, FLAG_POOL = 2, FLAG_SOFT = 4;
/** Faisceau « flou » (frost ≥ 60 % : flou de fenêtre ≥ 0,25) : que des dégradés, calculé à part en très basse
 *  résolution (SSDepthPass, 1/8) — l'agrandissement d'un dégradé ne se voit pas */
export const SS_SOFT_BLUR = 0.25;

const OCT = 8;
const OCT_K = 1 / Math.cos(Math.PI / OCT);   // octogone circonscrit au cercle
const COS = new Float32Array(OCT), SIN = new Float32Array(OCT);
for (let k = 0; k < OCT; k++) { COS[k] = Math.cos(k * 2 * Math.PI / OCT); SIN[k] = Math.sin(k * 2 * Math.PI / OCT); }

// Arêtes du tronc octogonal : 8 latérales, 8 de chaque anneau
const EDGES = new Uint8Array(OCT * 3 * 2);
for (let k = 0; k < OCT; k++) {
    EDGES[k * 2] = k; EDGES[k * 2 + 1] = OCT + k;
    EDGES[(OCT + k) * 2] = k; EDGES[(OCT + k) * 2 + 1] = (k + 1) % OCT;
    EDGES[(2 * OCT + k) * 2] = OCT + k; EDGES[(2 * OCT + k) * 2 + 1] = OCT + (k + 1) % OCT;
}
const MAX_CROSS = OCT * 3;
const MAX_SEG = OCT * 3 + (MAX_CROSS * (MAX_CROSS - 1)) / 2;

const _W = new THREE.Vector3();
const _Vw = new THREE.Vector3();
const _A = new THREE.Vector3();
const _P = new THREE.Vector3();
const _WV = new THREE.Vector3();

export class SSDepthLights {
    /** @param {import('../SpotBatch.js').SpotBatch} batch */
    constructor(batch) {
        this.batch = batch;
        this.count = 0;            // cônes décrits cette image
        this.visible = 0;          // cônes présents dans au moins une tuile (dernier bin)
        this.fixtures = 0;         // lyres SS Depth allumées
        this._capacity = 0;
        this.lightsTexture = null;
        this._allocLights(64);

        // Listes des tuiles (entiers 16 bits)
        this._tileData = new Uint16Array(SS_TILE_COUNT * SS_TILE_TEXELS * 4);
        this.tilesTexture = new THREE.DataTexture(this._tileData, SS_TILE_TEXELS, SS_TILE_COUNT, THREE.RGBAIntegerFormat, THREE.UnsignedShortType);
        this.tilesTexture.internalFormat = 'RGBA16UI';
        this.tilesTexture.minFilter = THREE.NearestFilter;
        this.tilesTexture.magFilter = THREE.NearestFilter;
        this.tilesTexture.generateMipmaps = false;
        this.tilesTexture.needsUpdate = true;
        this._tileCount = new Uint16Array(SS_TILE_COUNT);
        this._dirtyTiles = true;
        // Listes des taches de lumière (toutes les lyres allumées)
        this._poolData = new Uint16Array(SS_TILE_COUNT * SS_TILE_TEXELS * 4);
        this.poolTilesTexture = new THREE.DataTexture(this._poolData, SS_TILE_TEXELS, SS_TILE_COUNT, THREE.RGBAIntegerFormat, THREE.UnsignedShortType);
        this.poolTilesTexture.internalFormat = 'RGBA16UI';
        this.poolTilesTexture.minFilter = THREE.NearestFilter;
        this.poolTilesTexture.magFilter = THREE.NearestFilter;
        this.poolTilesTexture.generateMipmaps = false;
        this.poolTilesTexture.needsUpdate = true;
        this._poolCount = new Uint16Array(SS_TILE_COUNT);
        // Listes des faisceaux flous (passe à part en très basse résolution)
        this._softData = new Uint16Array(SS_TILE_COUNT * SS_TILE_TEXELS * 4);
        this.softTilesTexture = new THREE.DataTexture(this._softData, SS_TILE_TEXELS, SS_TILE_COUNT, THREE.RGBAIntegerFormat, THREE.UnsignedShortType);
        this.softTilesTexture.internalFormat = 'RGBA16UI';
        this.softTilesTexture.minFilter = THREE.NearestFilter;
        this.softTilesTexture.magFilter = THREE.NearestFilter;
        this.softTilesTexture.generateMipmaps = false;
        this.softTilesTexture.needsUpdate = true;
        this._softCount = new Uint16Array(SS_TILE_COUNT);
        this.softVisible = 0;      // faisceaux flous présents dans au moins une tuile
        this.beamCones = 0;        // cônes à faisceau SS Depth
        this.poolCones = 0;        // cônes à tache de lumière
        this.poolVisible = 0;
        this._collectId = 0;
        this._binnedId = -1;

        // Géométrie de projection de chaque cône (pour bin) : bouts de l'axe, rayons, base R/U, bout des taches, drapeaux
        this._geo = new Float32Array(SS_MAX_LIGHTS * GEO);
        // Sommets (vue) et segments projetés (en unités de tuiles), réutilisés
        this._vx = new Float32Array(OCT * 2); this._vy = new Float32Array(OCT * 2); this._vz = new Float32Array(OCT * 2);
        this._cx = new Float32Array(MAX_CROSS); this._cy = new Float32Array(MAX_CROSS);
        this._seg = new Float32Array(MAX_SEG * 4);
        this._ns = 0;
        this._order = new Uint16Array(SS_MAX_LIGHTS);
        this._score = new Float32Array(SS_MAX_LIGHTS);
    }

    _allocLights(n) {
        const cap = Math.min(SS_MAX_LIGHTS, Math.max(16, THREE.MathUtils.ceilPowerOfTwo(n)));
        if (cap <= this._capacity) return;
        const data = new Float32Array(SS_LIGHT_TEXELS * cap * 4);
        if (this.lightsTexture) data.set(this.lightsTexture.image.data.subarray(0, data.length));
        const tex = new THREE.DataTexture(data, SS_LIGHT_TEXELS, cap, THREE.RGBAFormat, THREE.FloatType);
        tex.minFilter = THREE.NearestFilter;
        tex.magFilter = THREE.NearestFilter;
        tex.generateMipmaps = false;
        tex.needsUpdate = true;
        const old = this.lightsTexture;
        this.lightsTexture = tex;
        this._capacity = cap;
        if (this.onTexture) this.onTexture(tex);
        if (old) old.dispose();
    }

    /**
     * Décrit les cônes (après SpotFixture.update : ligne de paramètres à jour) : faisceaux des lyres en mode
     * SS Depth et, si `pools`, taches de lumière de toutes les lyres allumées.
     * @param {Iterable<import('../SpotFixture.js').SpotFixture>} fixtures
     * @param {boolean} [pools] taches de lumière actives
     */
    collect(fixtures, pools = false) {
        let n = 0, nf = 0, nb = 0, np = 0;
        let d = this.lightsTexture.image.data;
        const geo = this._geo;
        this._collectId++;
        for (const f of fixtures) {
            if (!(f.flux > 1e-4) || !f.lensPos) continue;
            const beam = Boolean(f.ssDepth);
            const pool = pools && f.lightFlux > 1e-4;
            if (!beam && !pool) continue;
            const r = this.batch.paramsRow(f.row);
            const half = r[7] < 1.9;
            // Lyre noire (couleur nulle) : rien à dessiner
            if (r[0] + r[1] + r[2] + (half ? r[4] + r[5] + r[6] : 0) < 1e-4) continue;
            const tanHalf = r[8];
            if (!(tanHalf > 0)) continue;
            const iris = Math.min(r[9], 1);
            const frostBlur = r[10] * 0.42;
            const apexDist = r[31];
            const range = f.beamRange || 140;
            const beamEnd = r[49] > 0 ? Math.min(r[49], range) : range;
            const fadeB = beamEnd < range ? beamEnd * 0.75 : range * 0.7;
            const splashW = r[18];
            const hasOcc = r[32] >= 0 ? 1 : 0;
            // Image de la fenêtre : disque (cas courant), atlas (gobos, couteaux, demi-couleurs, frost compris :
            // 1 lecture), ou, atlas plein : disque × transmission moyenne (frost fort) ou calculée dans le shader
            const blades = r[20] >= 0.001 || r[22] >= 0.001 || r[24] >= 0.001 || r[26] >= 0.001;
            const detail = r[12] > 0.001 || r[13] > 0.001 || (r[16] > 0.001 && r[15] > 0.5) || blades || half;
            let kind = 0;
            if (detail) {
                if (r[48] > 0) kind = 2;
                else if (r[10] >= 0.7 && !blades && !half) kind = 1;
                else kind = 3;
            }
            const outR = iris + 0.012 + frostBlur + 0.14 + 0.01;
            const tanO = tanHalf * outR;
            const zS = apexDist;
            const zEnd = apexDist + (splashW > 0.001 ? range : beamEnd);
            const zPool = apexDist + range;
            const irr0 = r[3] / (Math.PI * tanHalf * tanHalf);
            const irrL = (f.lightFlux || 0) / (Math.PI * tanHalf * tanHalf);
            const flags = (beam ? FLAG_BEAM : 0) | (pool ? FLAG_POOL : 0) | (frostBlur >= SS_SOFT_BLUR ? FLAG_SOFT : 0);
            const slot = f.shadowSlot >= 0 ? f.shadowSlot : -1;
            const W = f.axis, R = f.right, U = f.up;
            let any = false;
            for (let i = 0; i < f.facetCount; i++) {
                const fc = f.facets[i];
                if (!(fc.weight > 1e-4)) continue;
                if (n >= this._capacity) {
                    if (this._capacity >= SS_MAX_LIGHTS) break;
                    this._allocLights(n + 1);
                    d = this.lightsTexture.image.data;
                }
                any = true;
                const vx = fc.gx * tanHalf, vy = fc.gy * tanHalf;
                _Vw.copy(R).multiplyScalar(vx).addScaledVector(U, vy);
                _WV.copy(W).add(_Vw);                                  // direction du centre des sections
                _A.copy(f.lensPos).addScaledVector(_WV, -apexDist);    // apex du cône oblique
                const o = n * SS_LIGHT_TEXELS * 4;
                d[o] = _A.x; d[o + 1] = _A.y; d[o + 2] = _A.z; d[o + 3] = tanO;
                d[o + 4] = W.x; d[o + 5] = W.y; d[o + 6] = W.z; d[o + 7] = zS;
                d[o + 8] = _Vw.x; d[o + 9] = _Vw.y; d[o + 10] = _Vw.z; d[o + 11] = zEnd;
                d[o + 12] = R.x; d[o + 13] = R.y; d[o + 14] = R.z; d[o + 15] = f.row;
                d[o + 16] = r[0]; d[o + 17] = r[1]; d[o + 18] = r[2]; d[o + 19] = irr0 * fc.weight;
                d[o + 20] = tanHalf; d[o + 21] = iris; d[o + 22] = frostBlur; d[o + 23] = Math.log(Math.max(1e-3, r[11]));
                d[o + 24] = kind; d[o + 25] = r[48] - 1; d[o + 26] = splashW; d[o + 27] = hasOcc;
                d[o + 28] = beamEnd; d[o + 29] = fadeB; d[o + 30] = range; d[o + 31] = range * 0.7;
                d[o + 32] = fc.gx; d[o + 33] = fc.gy; d[o + 34] = irrL * fc.weight; d[o + 35] = slot;
                const g = n * GEO;
                _P.copy(_A).addScaledVector(_WV, zS);
                geo[g] = _P.x; geo[g + 1] = _P.y; geo[g + 2] = _P.z; geo[g + 3] = tanO * zS * OCT_K;
                _P.copy(_A).addScaledVector(_WV, zEnd);
                geo[g + 4] = _P.x; geo[g + 5] = _P.y; geo[g + 6] = _P.z; geo[g + 7] = tanO * zEnd * OCT_K;
                geo[g + 8] = R.x; geo[g + 9] = R.y; geo[g + 10] = R.z;
                geo[g + 11] = U.x; geo[g + 12] = U.y; geo[g + 13] = U.z;
                _P.copy(_A).addScaledVector(_WV, zPool);
                geo[g + 14] = _P.x; geo[g + 15] = _P.y; geo[g + 16] = _P.z; geo[g + 17] = tanO * zPool * OCT_K;
                geo[g + 18] = flags; geo[g + 19] = zPool > zEnd + 1e-3 ? 1 : 0;
                n++;
                if (beam) nb++;
                if (pool) np++;
            }
            if (any && beam) nf++;
        }
        this.count = n;
        this.beamCones = nb;
        this.poolCones = np;
        this.fixtures = nf;
        if (n > 0) this.lightsTexture.needsUpdate = true;
    }

    /** Tri par tuile une seule fois par image (appelé par la première passe qui en a besoin) */
    ensureBinned(camera) {
        if (this._binnedId === this._collectId) return;
        this._binnedId = this._collectId;
        this.bin(camera);
    }

    /**
     * Projette le tronc du cône li (bout `end` : 4 = faisceau, 14 = tache) : segments dans this._seg.
     * Retourne false si rien n'est à l'écran.
     */
    _project(li, end, v, p, near) {
        const geo = this._geo;
        const g = li * GEO;
        const vx = this._vx, vy = this._vy, vz = this._vz;
        const cx = this._cx, cy = this._cy;
        const seg = this._seg;
        const TX = SS_TILES_X, TY = SS_TILES_Y;
        const sx = 0.5 * TX, sy = 0.5 * TY;
        const zc = -near * 1.0001;
        const Rx = geo[g + 8], Ry = geo[g + 9], Rz = geo[g + 10];
        const Ux = geo[g + 11], Uy = geo[g + 12], Uz = geo[g + 13];
        // 16 sommets du tronc octogonal, en repère caméra
        for (let e = 0; e < 2; e++) {
            const b = g + (e === 0 ? 0 : end);
            const cX = geo[b], cY = geo[b + 1], cZ = geo[b + 2], rad = geo[b + 3];
            for (let k = 0; k < OCT; k++) {
                const c = COS[k] * rad, s = SIN[k] * rad;
                const x = cX + Rx * c + Ux * s, y = cY + Ry * c + Uy * s, z = cZ + Rz * c + Uz * s;
                const j = e * OCT + k;
                vx[j] = v[0] * x + v[4] * y + v[8] * z + v[12];
                vy[j] = v[1] * x + v[5] * y + v[9] * z + v[13];
                vz[j] = v[2] * x + v[6] * y + v[10] * z + v[14];
            }
        }
        // Segments projetés (arêtes découpées par le plan proche) + points de coupe
        let ns = 0, nc = 0;
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (let e = 0; e < OCT * 3; e++) {
            const a = EDGES[e * 2], b = EDGES[e * 2 + 1];
            let ax = vx[a], ay = vy[a], az = vz[a];
            let bx = vx[b], by = vy[b], bz = vz[b];
            const aIn = az <= zc, bIn = bz <= zc;
            if (!aIn && !bIn) continue;
            if (!aIn || !bIn) {
                const t = (zc - az) / (bz - az);
                const ix = ax + (bx - ax) * t, iy = ay + (by - ay) * t;
                if (!aIn) { ax = ix; ay = iy; az = zc; } else { bx = ix; by = iy; bz = zc; }
                if (nc < MAX_CROSS) { cx[nc] = ix; cy[nc] = iy; nc++; }
            }
            // Projection (perspective, centre éventuellement décalé)
            const o = ns * 4;
            seg[o] = Math.max(-1e4, Math.min(1e4, (p[0] * ax + p[8] * az) / -az * sx + sx));
            seg[o + 1] = Math.max(-1e4, Math.min(1e4, (p[5] * ay + p[9] * az) / -az * sy + sy));
            seg[o + 2] = Math.max(-1e4, Math.min(1e4, (p[0] * bx + p[8] * bz) / -bz * sx + sx));
            seg[o + 3] = Math.max(-1e4, Math.min(1e4, (p[5] * by + p[9] * bz) / -bz * sy + sy));
            ns++;
        }
        if (ns === 0) return false;
        // Cône coupé par le plan proche : bord de la section de coupe (toutes les paires de points de coupe)
        if (nc > 1) {
            for (let i = 0; i < nc; i++) {
                cx[i] = Math.max(-1e4, Math.min(1e4, (p[0] * cx[i] + p[8] * zc) / -zc * sx + sx));
                cy[i] = Math.max(-1e4, Math.min(1e4, (p[5] * cy[i] + p[9] * zc) / -zc * sy + sy));
            }
            for (let i = 0; i < nc; i++) {
                for (let j = i + 1; j < nc; j++) {
                    const o = ns * 4;
                    seg[o] = cx[i]; seg[o + 1] = cy[i]; seg[o + 2] = cx[j]; seg[o + 3] = cy[j];
                    ns++;
                }
            }
        }
        for (let s = 0; s < ns; s++) {
            const o = s * 4;
            const x0 = seg[o], y0 = seg[o + 1], x1 = seg[o + 2], y1 = seg[o + 3];
            if (x0 < minX) minX = x0; if (x0 > maxX) maxX = x0;
            if (x1 < minX) minX = x1; if (x1 > maxX) maxX = x1;
            if (y0 < minY) minY = y0; if (y0 > maxY) maxY = y0;
            if (y1 < minY) minY = y1; if (y1 > maxY) maxY = y1;
        }
        if (maxX < 0 || minX >= TX || maxY < 0 || minY >= TY) return false;
        this._ns = ns;
        this._minY = minY;
        this._maxY = maxY;
        return true;
    }

    /** Ajoute le cône li aux tuiles couvertes par la projection courante ; vrai si au moins une tuile */
    _raster(li, counts, data) {
        const seg = this._seg, ns = this._ns;
        const TX = SS_TILES_X, TY = SS_TILES_Y;
        const row0 = Math.max(0, Math.floor(this._minY)), row1 = Math.min(TY - 1, Math.floor(this._maxY));
        let hit = false;
        for (let ty = row0; ty <= row1; ty++) {
            // Étendue en x de la projection (polygone convexe) dans la bande [ty, ty + 1]
            let bx0 = Infinity, bx1 = -Infinity;
            for (let s = 0; s < ns; s++) {
                const o = s * 4;
                const x0 = seg[o], y0 = seg[o + 1], x1 = seg[o + 2], y1 = seg[o + 3];
                const ylo = Math.min(y0, y1), yhi = Math.max(y0, y1);
                if (yhi < ty || ylo > ty + 1) continue;
                const dy = y1 - y0;
                if (Math.abs(dy) < 1e-9) {
                    const lo = Math.min(x0, x1), hi = Math.max(x0, x1);
                    if (lo < bx0) bx0 = lo; if (hi > bx1) bx1 = hi;
                    continue;
                }
                let ta = (ty - y0) / dy, tb = (ty + 1 - y0) / dy;
                if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
                ta = Math.max(0, ta); tb = Math.min(1, tb);
                const xa = x0 + (x1 - x0) * ta, xb = x0 + (x1 - x0) * tb;
                const lo = Math.min(xa, xb), hi = Math.max(xa, xb);
                if (lo < bx0) bx0 = lo; if (hi > bx1) bx1 = hi;
            }
            if (bx1 < 0 || bx0 >= TX) continue;
            const tx0 = Math.max(0, Math.floor(bx0 - 0.02)), tx1 = Math.min(TX - 1, Math.floor(bx1 + 0.02));
            for (let tx = tx0; tx <= tx1; tx++) {
                const t = ty * TX + tx;
                const c = counts[t];
                if (c >= SS_MAX_PER_TILE) continue;
                data[(t * SS_TILE_TEXELS + 1 + (c >> 2)) * 4 + (c & 3)] = li;
                counts[t] = c + 1;
                hit = true;
            }
        }
        return hit;
    }

    /**
     * Listes de cônes par tuile (faisceaux, taches) pour la caméra courante (matrices du rendu de la scène).
     * @param {THREE.PerspectiveCamera} camera
     */
    bin(camera) {
        const counts = this._tileCount, data = this._tileData;
        const pCounts = this._poolCount, pData = this._poolData;
        const sCounts = this._softCount, sData = this._softData;
        if (this.count === 0) {
            this.visible = 0;
            this.poolVisible = 0;
            this.softVisible = 0;
            if (this._dirtyTiles) {
                counts.fill(0);
                pCounts.fill(0);
                sCounts.fill(0);
                for (let t = 0; t < SS_TILE_COUNT; t++) {
                    const o = t * SS_TILE_TEXELS * 4;
                    data[o] = 0; pData[o] = 0; sData[o] = 0;
                }
                this.tilesTexture.needsUpdate = true;
                this.poolTilesTexture.needsUpdate = true;
                this.softTilesTexture.needsUpdate = true;
                this._dirtyTiles = false;
            }
            return;
        }
        counts.fill(0);
        pCounts.fill(0);
        sCounts.fill(0);
        const v = camera.matrixWorldInverse.elements;
        const p = camera.projectionMatrix.elements;
        const near = camera.near;
        const geo = this._geo;
        // Ordre d'importance : flux du cône (éclairement × section) atténué par la distance à la caméra. Les
        // shaders s'arrêtent quand le pixel est saturé ou après 48 cônes : ce sont alors les moins lumineux qui sautent
        const order = this._order, score = this._score, d = this.lightsTexture.image.data;
        const cx = camera.matrixWorld.elements[12], cy = camera.matrixWorld.elements[13], cz = camera.matrixWorld.elements[14];
        for (let li = 0; li < this.count; li++) {
            const o = li * SS_LIGHT_TEXELS * 4, g = li * GEO;
            const t = d[o + 20];
            const flux = Math.max(d[o + 19], d[o + 34]) * t * t;
            const dx = geo[g] - cx, dy = geo[g + 1] - cy, dz = geo[g + 2] - cz;
            score[li] = flux / (1 + (dx * dx + dy * dy + dz * dz) / 400);
            order[li] = li;
        }
        const sorted = order.subarray(0, this.count);
        sorted.sort((a, b) => score[b] - score[a]);
        let visible = 0, poolVisible = 0, softVisible = 0;
        for (let oi = 0; oi < this.count; oi++) {
            const li = sorted[oi];
            const g = li * GEO;
            const flags = geo[g + 18];
            // Bout déjà projeté : 4 (faisceau), 0 (faisceau hors écran), −1 (rien)
            let projected = -1;
            if (flags & FLAG_BEAM) {
                if (this._project(li, 4, v, p, near)) {
                    projected = 4;
                    if (flags & FLAG_SOFT) { if (this._raster(li, sCounts, sData)) softVisible++; }
                    else if (this._raster(li, counts, data)) visible++;
                } else projected = 0;
            }
            if (flags & FLAG_POOL) {
                const end = geo[g + 19] > 0.5 ? 14 : 4;
                let ok;
                if (end === 4 && projected === 4) ok = true;
                else if (end === 4 && projected === 0) ok = false;
                else ok = this._project(li, end, v, p, near);
                if (ok && this._raster(li, pCounts, pData)) poolVisible++;
            }
        }
        for (let t = 0; t < SS_TILE_COUNT; t++) {
            const o = t * SS_TILE_TEXELS * 4;
            data[o] = counts[t];
            pData[o] = pCounts[t];
            sData[o] = sCounts[t];
        }
        this.visible = visible;
        this.poolVisible = poolVisible;
        this.softVisible = softVisible;
        this.tilesTexture.needsUpdate = true;
        this.poolTilesTexture.needsUpdate = true;
        this.softTilesTexture.needsUpdate = true;
        this._dirtyTiles = true;
    }

    dispose() {
        this.lightsTexture.dispose();
        this.tilesTexture.dispose();
        this.poolTilesTexture.dispose();
        this.softTilesTexture.dispose();
    }
}
