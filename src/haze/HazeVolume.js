/**
 * HazeVolume.js
 * ─────────────────────────────────────────────────────────────
 * Brouillard de salle : une boîte de fumée (espace public + scène par défaut) éclairée par
 * les projecteurs, pour que la couleur des strobes / lyres « envahisse » la salle et l'écran.
 *
 * Chaque frame (CPU, ~0,05 ms) :
 *   - collecte des sources : stroboscopes (flash en cours), lyres (lumière le long du faisceau),
 *     lumières des lasers ; soleil / lune et lumière ambiante
 *   - priorité : « Strobes prioritaires » ou « La plus forte gagne »
 *   - au-delà du nombre maximal de lumières, les sources proches sont REGROUPÉES (énergie et
 *     couleur moyenne conservées) → une lyre bleue à gauche et une rouge à droite restent deux
 *     taches de couleur distinctes même avec des dizaines de projecteurs
 *   - persistance optionnelle après un flash
 * Le rendu (GPU) est une seule passe analytique, voir HazeShaders.js.
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';
import { getSmokeNoiseTexture } from '../laser/LaserSmokeNoise.js';
import { getStageObstacles } from '../laser/LaserSceneIntersector.js';
import { createHazeMaterial, HAZE_MAX_LIGHTS } from './HazeShaders.js';
import { HazePass } from './HazePass.js';
import { defaultHazeParams, HAZE_PARAMS_SCHEMA } from './hazeParams.js';

// Calibrage des puissances (unités différentes selon le type de source)
const STROBE_K = 1.0;
const SPOT_K = 12.0;
const LASER_K = 1.0;
const SCENE_K = 1.0;
const BEAM_MAX = 40;    // longueur (m) de faisceau de lyre prise en compte dans la fumée
const BEAM_POINTS = 3;  // une lyre = 3 sources réparties le long de son faisceau
const _obstacles = getStageObstacles();

/** Longueur libre d'un faisceau (sol, structure de la scène), bornée à BEAM_MAX */
function beamFreeLength(o, d) {
    let tMax = BEAM_MAX;
    if (d.y < -1e-3) tMax = Math.min(tMax, o.y / -d.y);
    const ix = 1 / (Math.abs(d.x) < 1e-6 ? 1e-6 : d.x);
    const iy = 1 / (Math.abs(d.y) < 1e-6 ? 1e-6 : d.y);
    const iz = 1 / (Math.abs(d.z) < 1e-6 ? 1e-6 : d.z);
    for (const b of _obstacles) {
        let a = (b.minX - o.x) * ix, c = (b.maxX - o.x) * ix;
        let t0 = Math.min(a, c), t1 = Math.max(a, c);
        a = (b.minY - o.y) * iy; c = (b.maxY - o.y) * iy;
        t0 = Math.max(t0, Math.min(a, c)); t1 = Math.min(t1, Math.max(a, c));
        a = (b.minZ - o.z) * iz; c = (b.maxZ - o.z) * iz;
        t0 = Math.max(t0, Math.min(a, c)); t1 = Math.min(t1, Math.max(a, c));
        // Obstacle devant la lyre (on ignore celui dans lequel elle est accrochée)
        if (t0 <= t1 && t0 > 0.3 && t0 < tMax) tMax = t0;
    }
    return Math.max(0.5, tMax);
}
const LOCAL_R = 7; // rayon (m) d'influence locale pour le choix des sources
const SUN_K = 0.25;
const AMBIENT_K = 0.12;
const LINK_K = 30; // densité du brouillard (m⁻¹) → densité de fumée des faisceaux des lyres

const RES_SCALE = { '1/16 de résolution': 1 / 16, '1/8 de résolution': 0.125, 'Quart de résolution': 0.25, 'Demi-résolution': 0.5, 'Pleine résolution': 1.0 };

const _pos = new THREE.Vector3();
const _tgt = new THREE.Vector3();
const _col = new THREE.Color();

export class HazeVolume {
    /**
     * @param {object} o
     * @param {THREE.Scene} o.scene
     * @param {THREE.PerspectiveCamera} o.camera
     * @param {import('../laser/LaserManager.js').LaserManager} o.laserManager
     * @param {import('../strobe/StrobeManager.js').StrobeManager} [o.strobeManager]
     * @param {import('../spot/SpotManager.js').SpotManager} [o.spotManager]
     */
    constructor({ scene, camera, laserManager, strobeManager, spotManager }) {
        this.scene = scene;
        this.camera = camera;
        this.laserManager = laserManager;
        this.strobeManager = strobeManager;
        this.spotManager = spotManager;
        this.params = defaultHazeParams();

        this.material = createHazeMaterial(getSmokeNoiseTexture());

        this.pass = new HazePass(this.material, camera, null);
        this.pass.enabled = false;
        this._hasPass = Boolean(laserManager && laserManager.addScenePass && laserManager.addScenePass(this.pass));
        if (this._hasPass) this.pass.sceneDepth = laserManager.sceneDepth;

        // Contour de la boîte (affichable pour la régler)
        this.boxHelper = new THREE.LineSegments(
            new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
            new THREE.LineBasicMaterial({ color: 0x7dd3fc, transparent: true, opacity: 0.8, depthTest: true })
        );
        this.boxHelper.name = 'haze-box-helper';
        this.boxHelper.visible = false;
        this.boxHelper.userData.isAmbianceInternal = true;
        scene.add(this.boxHelper);

        // Poignée déplaçable au gizmo (centre de la boîte)
        this.handle = new THREE.Object3D();
        this.handle.name = 'haze-box-handle';
        scene.add(this.handle);

        this._cands = [];
        this._pool = [];
        for (let i = 0; i < 64; i++) this._pool.push(this._newCand());
        this._directional = null;
        this._ambientLights = [];
        this._sceneLights = [];
        this._scanTimer = 0;
        this._levels = new WeakMap(); // persistance par source
        // Teinte d'ambiance (menu Ambiance) : multipliée à la teinte de la fumée. Blanc = neutre (ambiance jour).
        this._envTint = new THREE.Color(1, 1, 1);
        this._applyAll();
    }

    _newCand() {
        return { x: 0, y: 0, z: 0, range: 0, r: 0, g: 0, b: 0, dx: 0, dy: 0, dz: 0, cos: -1, cosIn: 1, soft: 0, power: 0, score: 0, strobe: false, n: 1 };
    }

    // ── Réglages ──────────────────────────────────────────────────────────
    setParam(key, value) {
        if (!(key in HAZE_PARAMS_SCHEMA)) return;
        this.params[key] = value;
        this._applyAll();
    }

    /** Teinte légère liée à l'ambiance choisie (blanc = aucune coloration). */
    setEnvTint(color) {
        this._envTint.copy(color);
        this.material.uniforms.uTint.value.set(this.params.tint).multiply(this._envTint);
    }

    setParams(obj) {
        for (const [k, v] of Object.entries(obj || {})) if (k in HAZE_PARAMS_SCHEMA) this.params[k] = v;
        this._applyAll();
    }

    _applyAll() {
        const p = this.params;
        const u = this.material.uniforms;
        u.uBoxMin.value.set(p.boxX - p.sizeX / 2, p.boxY - p.sizeY / 2, p.boxZ - p.sizeZ / 2);
        u.uBoxMax.value.set(p.boxX + p.sizeX / 2, p.boxY + p.sizeY / 2, p.boxZ + p.sizeZ / 2);
        u.uEdge.value = Math.min(p.edge, Math.min(p.sizeX, p.sizeY, p.sizeZ) / 2);
        u.uDensity.value = p.density;
        u.uTint.value.set(p.tint).multiply(this._envTint);
        u.uIntensity.value = p.intensity;
        u.uMS.value = p.multiScatter;
        u.uMSReach.value = p.scatterReach;
        u.uG.value = p.anisotropy;
        u.uHeight.value = p.layerHeight;
        u.uNoise.value = p.noise;
        u.uSegments.value = Math.round(p.segments);
        this.pass.setResolutionScale(RES_SCALE[p.resolution] || 0.5);
        this.boxHelper.position.set(p.boxX, p.boxY, p.boxZ);
        this.boxHelper.scale.set(p.sizeX, p.sizeY, p.sizeZ);
        this.boxHelper.updateMatrixWorld();
        this.handle.position.set(p.boxX, p.boxY, p.boxZ);
        this.handle.updateMatrixWorld();

        // Fumée des faisceaux des lyres : indépendante ou liée à la densité du brouillard
        if (this.spotManager && typeof this.spotManager.setHazeOverride === 'function') {
            const linked = p.beamLink === 'Liée au brouillard de salle' && p.enabled;
            this.spotManager.setHazeOverride(linked ? p.density * LINK_K : null);
        }
    }

    setBoxVisible(v) {
        this.boxHelper.visible = Boolean(v);
    }

    /** Recopie la position de la poignée (déplacée au gizmo) dans les réglages */
    syncFromHandle() {
        const h = this.handle.position;
        this.params.boxX = Math.round(h.x * 10) / 10;
        this.params.boxY = Math.round(h.y * 10) / 10;
        this.params.boxZ = Math.round(h.z * 10) / 10;
        this._applyAll();
    }

    // ── Lumières directionnelles / ambiantes de la scène ──────────────────
    _scanSceneLights() {
        this._directional = null;
        this._ambientLights.length = 0;
        this._sceneLights.length = 0;
        // Lampes posées dans le moteur (panneau Ambiance, y compris celles reçues du multijoueur)
        const entries = this.ambiancePanel && this.ambiancePanel.lights;
        if (entries) {
            for (const e of entries) {
                const l = e.light;
                if (l && (l.isPointLight || l.isSpotLight || l.isRectAreaLight)) this._sceneLights.push(l);
            }
        }
        let best = 0;
        this.scene.traverse(o => {
            if (!o.isLight) return;
            if (o.isDirectionalLight) {
                if (o.intensity > best) { best = o.intensity; this._directional = o; }
            } else if (o.isAmbientLight || o.isHemisphereLight) {
                this._ambientLights.push(o);
            }
        });
    }

    // ── Sources ───────────────────────────────────────────────────────────
    _level(key, on, dt) {
        const persist = this.params.persistence;
        let lv = this._levels.get(key) || 0;
        if (on >= lv || persist <= 0.001) lv = on;
        else lv = on + (lv - on) * Math.exp(-dt / (persist * 0.6));
        this._levels.set(key, lv);
        return lv;
    }

    _collect(dt) {
        const p = this.params;
        const out = this._cands;
        out.length = 0;
        let k = 0;
        const take = () => (k < this._pool.length ? this._pool[k++] : (this._pool.push(this._newCand()), this._pool[k++]));
        const camPos = this.camera.position;

        // 1. Stroboscopes (flash en cours)
        if (p.useStrobes && this.strobeManager) {
            for (const st of this.strobeManager.getAllStrobes()) {
                const lv = this._level(st, st.flash ? 1 : 0, dt);
                if (lv <= 0.002) continue;
                const power = st.getEffectiveIntensity() * p.strobeGain * STROBE_K * lv;
                if (power <= 0.001) continue;
                st.getLightSetup(_pos, _tgt);
                const c = take();
                _col.set(st.params.color);
                c.x = _pos.x; c.y = _pos.y; c.z = _pos.z;
                _tgt.sub(_pos).normalize();
                c.dx = _tgt.x; c.dy = _tgt.y; c.dz = _tgt.z;
                c.cos = Math.cos(1.40);
                c.cosIn = Math.cos(1.40 * (1 - 0.8)); // pénombre 0.8 du stroboscope
                c.range = st.getEffectiveLightDistance();
                c.r = _col.r * power; c.g = _col.g * power; c.b = _col.b * power;
                c.power = power;
                c.strobe = true;
                c.soft = 0;
                c.n = 1;
                out.push(c);
            }
        }

        // 2. Lyres : la fumée s'éclaire LE LONG du faisceau (sources réparties jusqu'au sol / à la structure),
        //    donc la lumière suit le rayon quand la lyre balaie (gauche/droite, haut/bas)
        if (p.useSpots && this.spotManager) {
            for (const s of this.spotManager.getAllSpots()) {
                const lv = this._level(s, s.lightFlux || 0, dt);
                if (lv <= 0.002) continue;
                const ax = s.axis, lp = s.lensPos;
                const len = beamFreeLength(lp, ax);
                // La fumée s'éclaire en proportion de la longueur de faisceau qui la traverse :
                // un faisceau coupé court (plafond, mur) éclaire MOINS, sans concentrer sa lumière à l'impact
                const power = lv * p.spotGain * SPOT_K * (len / BEAM_MAX) / BEAM_POINTS;
                const col = s.motion.out.colorA;
                for (let j = 0; j < BEAM_POINTS; j++) {
                    const dist = len * (j + 0.5) / BEAM_POINTS;
                    const c = take();
                    c.x = lp.x + ax.x * dist; c.y = lp.y + ax.y * dist; c.z = lp.z + ax.z * dist;
                    c.dx = 0; c.dy = 0; c.dz = 0; c.cos = -1; c.range = 0;
                    c.r = col[0] * power; c.g = col[1] * power; c.b = col[2] * power;
                    c.power = power * (col[0] + col[1] + col[2]) / 3;
                    c.strobe = false;
                    // Source « étalée » sur son tronçon de faisceau : pas de point lumineux visible dans la fumée
                    c.soft = Math.max(1.5, 0.7 * len / BEAM_POINTS);
                    c.n = 1;
                    out.push(c);
                }
            }
        }

        // 3. Lumières émises par les lasers
        if (p.useLasers && this.laserManager && this.laserManager._laserLights) {
            for (const l of this.laserManager._laserLights) {
                if (!(l.intensity > 0.001)) continue;
                const power = l.intensity * p.laserGain * LASER_K;
                const c = take();
                c.x = l.position.x; c.y = l.position.y; c.z = l.position.z;
                // Pas de coupure de portée three.js dans la fumée (elle dessinerait une sphère visible) : 1/d² seul
                c.dx = 0; c.dy = 0; c.dz = 0; c.cos = -1; c.range = 0;
                c.r = l.color.r * power; c.g = l.color.g * power; c.b = l.color.b * power;
                c.power = power;
                c.strobe = false;
                c.soft = 0;
                c.n = 1;
                out.push(c);
            }
        }

        // 4. Lampes posées (point, spot, panneau) : même la plus faible éclaire la fumée autour d'elle
        if (p.useScene) {
            for (const l of this._sceneLights) {
                if (!l.visible || !l.parent || !(l.intensity > 0.001)) continue;
                let power = l.intensity * p.sceneGain * SCENE_K;
                if (l.isRectAreaLight) power *= l.width * l.height * 0.3; // luminance → intensité équivalente
                if (power <= 0.001) continue;
                l.getWorldPosition(_pos);
                const c = take();
                c.x = _pos.x; c.y = _pos.y; c.z = _pos.z;
                c.dx = 0; c.dy = 0; c.dz = 0; c.cos = -1; c.cosIn = 1;
                if (l.isSpotLight) {
                    l.target.getWorldPosition(_tgt);
                    _tgt.sub(_pos).normalize();
                    c.dx = _tgt.x; c.dy = _tgt.y; c.dz = _tgt.z;
                    c.cos = Math.cos(l.angle);
                    c.cosIn = Math.cos(l.angle * (1 - l.penumbra));
                } else if (l.isRectAreaLight) {
                    _tgt.set(0, 0, -1).transformDirection(l.matrixWorld); // un panneau éclaire devant lui
                    c.dx = _tgt.x; c.dy = _tgt.y; c.dz = _tgt.z;
                    c.cos = 0.0; c.cosIn = 0.7;
                }
                c.range = l.distance > 0 ? l.distance : 0;
                c.r = l.color.r * power; c.g = l.color.g * power; c.b = l.color.b * power;
                c.power = power * (l.color.r + l.color.g + l.color.b) / 3;
                c.strobe = false;
                c.soft = 0;
                c.n = 1;
                out.push(c);
            }
        }

        // Score : puissance, proximité du joueur ; strobes prioritaires selon le mode
        const strobeFirst = p.mode === 'Strobes prioritaires';
        for (const c of out) {
            const d = Math.hypot(c.x - camPos.x, c.y - camPos.y, c.z - camPos.z);
            c.score = c.power / (1 + d / 40) * (strobeFirst && c.strobe ? 1e4 : 1);
        }
        out.sort((a, b) => b.score - a.score);
        return out;
    }

    /**
     * Choisit K sources par IMPORTANCE LOCALE : une lampe faible mais isolée domine la fumée
     * autour d'elle (les grosses sources lointaines y sont atténuées en 1/d²) → elle garde sa place.
     * Les sources couvertes par une source retenue proche y sont fusionnées (énergie conservée) ;
     * celles qui ne dominent nulle part sont négligées.
     */
    _cluster(cands, K) {
        if (cands.length <= K) return cands;
        const strobeFirst = this.params.mode === 'Strobes prioritaires';
        const R2 = LOCAL_R * LOCAL_R;
        const seeds = [];
        for (const c of cands) { c._cov = 0; c._taken = false; }
        while (seeds.length < K) {
            let best = null, bk = -1;
            for (const c of cands) {
                if (c._taken) continue;
                // Part de la lumière locale (autour de c) qui vient de c lui-même
                const imp = c.power / (c.power + c._cov);
                const key = imp * Math.pow(c.score + 1e-6, 0.25) * (strobeFirst && c.strobe ? 1e4 : 1);
                if (key > bk) { bk = key; best = c; }
            }
            if (!best) break;
            best._taken = true;
            seeds.push(best);
            for (const c of cands) {
                if (c._taken) continue;
                const d2 = (best.x - c.x) ** 2 + (best.y - c.y) ** 2 + (best.z - c.z) ** 2;
                c._cov += best.power * R2 / (R2 + d2);
            }
        }
        for (const s of seeds) { s._wx = s.x * s.power; s._wy = s.y * s.power; s._wz = s.z * s.power; s._w = s.power; }
        const maxD2 = (LOCAL_R * 1.5) ** 2;
        for (const c of cands) {
            if (c._taken) continue;
            let best = null, bd = Infinity;
            for (const s of seeds) {
                const d = (s.x - c.x) ** 2 + (s.y - c.y) ** 2 + (s.z - c.z) ** 2;
                if (d < bd) { bd = d; best = s; }
            }
            if (!best || bd > maxD2) continue; // trop loin : la fusionner déplacerait sa lumière ailleurs
            best.r += c.r; best.g += c.g; best.b += c.b;
            best._wx += c.x * c.power; best._wy += c.y * c.power; best._wz += c.z * c.power; best._w += c.power;
            best.power += c.power;
            if (best.cos > -0.5 && (c.cos < -0.5 || best.dx * c.dx + best.dy * c.dy + best.dz * c.dz < 0.9)) best.cos = -1;
            if (c.soft > best.soft) best.soft = c.soft;
            best.n++;
        }
        for (const s of seeds) {
            if (s.n > 1 && s._w > 0) { s.x = s._wx / s._w; s.y = s._wy / s._w; s.z = s._wz / s._w; s.range = 0; }
        }
        return seeds;
    }

    // ── Boucle ────────────────────────────────────────────────────────────
    update(dt) {
        const p = this.params;
        const active = this._hasPass && p.enabled && p.density > 0;
        this.pass.enabled = active;
        if (!active) return;

        this._scanTimer -= dt;
        if (this._scanTimer <= 0) { this._scanTimer = 1; this._scanSceneLights(); }

        const u = this.material.uniforms;
        const K = Math.max(1, Math.min(HAZE_MAX_LIGHTS, Math.round(p.maxLights)));
        const lights = this._cluster(this._collect(dt), K);
        const n = Math.min(K, lights.length);
        for (let i = 0; i < n; i++) {
            const c = lights[i];
            u.uLPos.value[i].set(c.x, c.y, c.z, c.range);
            u.uLCol.value[i].set(c.r, c.g, c.b, c.cos > -0.5 ? c.cosIn : c.soft); // w : pénombre (projecteur) ou rayon d'étalement (source omni)
            u.uLDir.value[i].set(c.dx, c.dy, c.dz, c.cos);
        }
        u.uLCount.value = n;

        // Soleil / lune et lumière ambiante
        const sun = this._directional;
        if (p.useSun && sun && sun.visible && sun.intensity > 0) {
            _pos.setFromMatrixPosition(sun.matrixWorld);
            _tgt.setFromMatrixPosition(sun.target.matrixWorld);
            u.uSunDir.value.subVectors(_pos, _tgt).normalize();
            u.uSunCol.value.copy(sun.color).multiplyScalar(sun.intensity * SUN_K);
        } else {
            u.uSunCol.value.setRGB(0, 0, 0);
        }
        u.uAmbient.value.setRGB(0.02, 0.022, 0.028); // lueur minimale (nuit, écrans, public)
        for (const a of this._ambientLights) {
            if (!a.visible) continue;
            u.uAmbient.value.r += a.color.r * a.intensity * AMBIENT_K;
            u.uAmbient.value.g += a.color.g * a.intensity * AMBIENT_K;
            u.uAmbient.value.b += a.color.b * a.intensity * AMBIENT_K;
        }
        u.uAmbient.value.multiplyScalar(p.ambient / 0.15);

        const smoke = this.laserManager && this.laserManager._globalSmokeState;
        if (smoke && smoke.wind) u.uWind.value.copy(smoke.wind);
    }

    dispose() {
        this.scene.remove(this.boxHelper);
        this.scene.remove(this.handle);
        this.pass.dispose();
        this.material.dispose();
    }
}
