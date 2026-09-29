/**
 * SpotMotion.js
 * ─────────────────────────────────────────────────────────────
 * Simulation MÉCANIQUE d'une lyre : les paramètres (panneau ou DMX) sont des
 * CONSIGNES, cette classe calcule l'état physique réel image par image :
 *   - Pan / Tilt : vitesse et accélération maximales (inertie de la tête),
 *     réglées par le canal « vitesse de mouvement »
 *   - Roue de couleurs : rotation réelle (demi-couleurs et transitions qui
 *     traversent le faisceau, défilement rainbow continu)
 *   - Roues de gobos : glissement des motifs dans la fenêtre, secousse, rotation
 *   - Prisme et roue d'animation : insertion / retrait progressifs
 *   - Zoom, focus, iris, frost, couteaux : moteurs avec temps de course
 *   - Obturateur : strobe régulier, pulse, strobe aléatoire
 *   - Reset : routines de calibration (pan/tilt, effets, complet)
 * ─────────────────────────────────────────────────────────────
 */

import {
    COLOR_WHEEL, GOBO_FIXED_WHEEL, GOBO_ROT_WHEEL, ANIM_WHEEL, PRISMS, PAN_RANGE, TILT_RANGE
} from './config/spotParams.js';
import { cmyOf } from './SpotProfile.js';

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Déplace `cur` vers `target` d'au plus `maxStep` */
function approach(cur, target, maxStep) {
    const d = target - cur;
    if (Math.abs(d) <= maxStep) return target;
    return cur + Math.sign(d) * maxStep;
}

/** Position circulaire d'une roue à N positions : chemin le plus court vers la cible */
function approachWheel(cur, target, n, maxStep) {
    let d = target - cur;
    d -= Math.round(d / n) * n;
    if (Math.abs(d) <= maxStep) return target;
    return cur + Math.sign(d) * maxStep;
}

const wrap = (v, n) => ((v % n) + n) % n;

function srgbToLinear(c) {
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Axe motorisé avec limitation de vitesse et d'accélération (profil trapézoïdal) */
function driveAxis(ax, target, maxV, acc, dt) {
    const err = target - ax.pos;
    const desired = Math.sign(err) * Math.min(maxV, Math.sqrt(2 * acc * Math.abs(err)));
    ax.vel += clamp(desired - ax.vel, -acc * dt, acc * dt);
    ax.pos += ax.vel * dt;
    if (Math.abs(target - ax.pos) < 0.02 && Math.abs(ax.vel) < 2) {
        ax.pos = target;
        ax.vel = 0;
    }
}

const RESET_DURATION = { panTilt: 3.6, effects: 3.2, all: 5.0 };

export class SpotMotion {
    /** @param {object} params Paramètres initiaux (l'état physique démarre sur les consignes) */
    constructor(params) {
        const nC = COLOR_WHEEL.length;
        this.pan = { pos: params.pan, vel: 0 };
        this.tilt = { pos: params.tilt, vel: 0 };
        this.dimmer = params.dimmer / 100;
        this.cmy = cmyOf(params.color);
        this.colorPos = wrap(this._colorTarget(params), nC);
        this.goboFixedPos = Math.max(0, GOBO_FIXED_WHEEL.indexOf(params.goboFixed));
        this.goboRotPos = Math.max(0, GOBO_ROT_WHEEL.indexOf(params.goboRot));
        this.goboAngle = params.goboIndex * DEG;
        this.goboVel = 0;
        this.shakeTime = 0;
        this.animSlot = Math.max(0, ANIM_WHEEL.indexOf(params.animWheel));
        this.animIn = this.animSlot > 0 ? 1 : 0;
        this.animAngle = 0;
        this.prismType = Math.max(0, PRISMS.indexOf(params.prism));
        this.prismIn = this.prismType > 0 ? 1 : 0;
        this.prismAngle = params.prismIndex * DEG;
        this.prismVel = 0;
        this.zoom = params.zoom;
        this.focus = params.focus;
        this.iris = params.iris;
        this.frost = params.frost;
        this.blades = [params.blade1, params.blade2, params.blade3, params.blade4];
        this.bladeAngles = [params.blade1Angle, params.blade2Angle, params.blade3Angle, params.blade4Angle];
        this.bladeRot = params.bladeRot;

        // Obturateur
        this.shutterTime = 0;
        this._rndNext = 0;
        this._rndLen = 0;

        // Reset en cours
        this.reset = null; // { mode, t }

        // Sortie (réutilisée, 0 allocation par frame)
        this.out = {
            pan: 0, tilt: 0,
            intensity: 0,
            colorA: [1, 1, 1], colorB: [1, 1, 1], split: 2,
            zoom: 14, iris: 1, frost: 0, focus: 0.5,
            goboFixedPos: 0, goboRotPos: 0, goboAngle: 0,
            animSlot: 0, animIn: 0, animAngle: 0,
            prismType: 0, prismIn: 0, prismAngle: 0,
            blades: [0, 0, 0, 0], bladeAngles: [0, 0, 0, 0], bladeRot: 0,
        };
    }

    _colorTarget(p) {
        const slot = Math.max(0, COLOR_WHEEL.findIndex(c => c.name === p.colorWheel));
        return slot + (p.colorHalf ? 0.5 : 0);
    }

    /** Lance une routine de calibration : 'panTilt' | 'effects' | 'all' */
    startReset(mode) {
        if (!RESET_DURATION[mode]) return;
        this.reset = { mode, t: 0 };
    }

    get isResetting() {
        return this.reset !== null;
    }

    /**
     * @param {number} dt secondes
     * @param {object} p paramètres (consignes)
     */
    update(dt, p) {
        dt = clamp(dt, 0, 0.1);
        const out = this.out;
        const nC = COLOR_WHEEL.length;
        const nGF = GOBO_FIXED_WHEEL.length;
        const nGR = GOBO_ROT_WHEEL.length;

        // ── Reset (calibration) ────────────────────────────────────────────
        let resetPT = false, resetFX = false, closed = false, rt = 0;
        if (this.reset) {
            this.reset.t += dt;
            rt = this.reset.t;
            const dur = RESET_DURATION[this.reset.mode];
            if (rt >= dur) {
                this.reset = null;
            } else {
                resetPT = this.reset.mode !== 'effects';
                resetFX = this.reset.mode !== 'panTilt';
                closed = true; // l'obturateur reste fermé pendant toute la calibration
            }
        }

        // ── Pan / Tilt ─────────────────────────────────────────────────────
        const sp = clamp(p.ptSpeed / 100, 0, 1);
        const panMaxV = 10 + sp * sp * 250;   // °/s
        const tiltMaxV = 8 + sp * sp * 200;
        const panAcc = 40 + sp * 680;         // °/s²
        const tiltAcc = 35 + sp * 620;
        let panT = clamp(p.pan, -PAN_RANGE / 2, PAN_RANGE / 2);
        let tiltT = clamp(p.tilt, -TILT_RANGE / 2, TILT_RANGE / 2);
        if (resetPT) {
            // Recherche des butées (capteurs de position) puis retour en position
            const half = RESET_DURATION[this.reset.mode] * 0.45;
            if (rt < half) {
                panT = -PAN_RANGE / 2;
                tiltT = -TILT_RANGE / 2;
            }
            driveAxis(this.pan, panT, 300, 900, dt);
            driveAxis(this.tilt, tiltT, 260, 820, dt);
        } else {
            // Sous-pas pour garder un freinage exact même à bas FPS
            const steps = dt > 0.02 ? Math.ceil(dt / 0.02) : 1;
            const h = dt / steps;
            for (let i = 0; i < steps; i++) {
                driveAxis(this.pan, panT, panMaxV, panAcc, h);
                driveAxis(this.tilt, tiltT, tiltMaxV, tiltAcc, h);
            }
        }
        out.pan = this.pan.pos;
        out.tilt = this.tilt.pos;

        // ── Dimmer (dimmer mécanique rapide) + obturateur ──────────────────
        const dimT = clamp(p.dimmer / 100, 0, 1);
        this.dimmer += (dimT - this.dimmer) * (1 - Math.exp(-dt / 0.035));
        out.intensity = this.dimmer * (closed ? 0 : this._shutter(dt, p));

        // ── Couleur : drapeaux CMY (lissés) × roue de couleurs ─────────────
        const cmyT = cmyOf(p.color);
        const kc = 1 - Math.exp(-dt / 0.09);
        for (let i = 0; i < 3; i++) this.cmy[i] += (cmyT[i] - this.cmy[i]) * kc;

        if (resetFX && rt < 1.6) {
            this.colorPos = wrap(this.colorPos + dt * 14, nC);
        } else if (Math.abs(p.rainbow) >= 1) {
            const s = Math.abs(p.rainbow) / 100;
            this.colorPos = wrap(this.colorPos + Math.sign(p.rainbow) * dt * (0.15 + s * s * 9), nC);
        } else {
            this.colorPos = wrap(approachWheel(this.colorPos, this._colorTarget(p), nC, dt * 9), nC);
        }
        const ca = Math.floor(this.colorPos) % nC;
        const cb = (ca + 1) % nC;
        const cf = this.colorPos - Math.floor(this.colorPos);
        // Transmission des drapeaux CMY (couleur choisie en sRGB → linéaire pour le rendu)
        const r0 = srgbToLinear(1 - this.cmy[0]), g0 = srgbToLinear(1 - this.cmy[1]), b0 = srgbToLinear(1 - this.cmy[2]);
        const wa = COLOR_WHEEL[ca].rgb, wb = COLOR_WHEEL[cb].rgb;
        out.colorA[0] = r0 * wa[0]; out.colorA[1] = g0 * wa[1]; out.colorA[2] = b0 * wa[2];
        out.colorB[0] = r0 * wb[0]; out.colorB[1] = g0 * wb[1]; out.colorB[2] = b0 * wb[2];
        // Frontière entre 2 filtres : ligne qui traverse la fenêtre (+x → −x)
        out.split = cf < 1e-3 ? 2 : 1.12 - 2.24 * cf;

        // ── Roues de gobos ─────────────────────────────────────────────────
        const gfT = Math.max(0, GOBO_FIXED_WHEEL.indexOf(p.goboFixed));
        const grT = Math.max(0, GOBO_ROT_WHEEL.indexOf(p.goboRot));
        if (resetFX && rt < 1.6) {
            this.goboFixedPos = wrap(this.goboFixedPos + dt * 11, nGF);
            this.goboRotPos = wrap(this.goboRotPos + dt * 10, nGR);
        } else {
            this.goboFixedPos = wrap(approachWheel(this.goboFixedPos, gfT, nGF, dt * 8), nGF);
            this.goboRotPos = wrap(approachWheel(this.goboRotPos, grT, nGR, dt * 7), nGR);
        }
        // Secousse : la roue oscille autour du gobo sélectionné
        let shake = 0;
        if (p.goboShake > 0.5 && gfT > 0) {
            const s = p.goboShake / 100;
            this.shakeTime += dt * (3 + s * 22);
            shake = Math.sin(this.shakeTime) * 0.075;
        }
        out.goboFixedPos = wrap(this.goboFixedPos + shake, nGF);
        out.goboRotPos = this.goboRotPos;

        // Rotation / indexation du gobo rotatif
        if (p.goboRotMode === 'Index') {
            this.goboVel = 0;
            const target = p.goboIndex * DEG;
            let d = target - this.goboAngle;
            d -= Math.round(d / TAU) * TAU;
            this.goboAngle += clamp(d, -dt * 7, dt * 7);
        } else {
            const s = p.goboSpeed / 100;
            const vT = Math.sign(s) * s * s * 9.0; // rad/s (≈ 1.4 tour/s max)
            this.goboVel = approach(this.goboVel, vT, dt * 12);
            this.goboAngle += this.goboVel * dt;
        }
        this.goboAngle = wrap(this.goboAngle, TAU);
        out.goboAngle = this.goboAngle;

        // ── Roue d'animation (retrait → changement → insertion) ────────────
        const aT = Math.max(0, ANIM_WHEEL.indexOf(p.animWheel));
        if (aT !== this.animSlot) {
            this.animIn = approach(this.animIn, 0, dt * 3.5);
            if (this.animIn === 0) this.animSlot = aT;
        } else {
            this.animIn = approach(this.animIn, aT > 0 ? 1 : 0, dt * 3.5);
        }
        this.animAngle = wrap(this.animAngle + (p.animSpeed / 100) * dt * 1.6, TAU);
        out.animSlot = this.animSlot;
        out.animIn = this.animIn;
        out.animAngle = this.animAngle;

        // ── Prisme ─────────────────────────────────────────────────────────
        let prT = Math.max(0, PRISMS.indexOf(p.prism));
        if (resetFX && rt > 0.4 && rt < 1.8) prT = 2;
        if (prT !== this.prismType) {
            this.prismIn = approach(this.prismIn, 0, dt * 5);
            if (this.prismIn === 0) this.prismType = prT;
        } else {
            this.prismIn = approach(this.prismIn, prT > 0 ? 1 : 0, dt * 5);
        }
        if (Math.abs(p.prismSpeed) >= 1) {
            const s = p.prismSpeed / 100;
            this.prismVel = approach(this.prismVel, Math.sign(s) * s * s * 7.0, dt * 10);
            this.prismAngle += this.prismVel * dt;
        } else {
            this.prismVel = 0;
            let d = p.prismIndex * DEG - this.prismAngle;
            d -= Math.round(d / TAU) * TAU;
            this.prismAngle += clamp(d, -dt * 6, dt * 6);
        }
        this.prismAngle = wrap(this.prismAngle, TAU);
        out.prismType = this.prismType;
        out.prismIn = this.prismIn;
        out.prismAngle = this.prismAngle;

        // ── Optique : zoom, focus, iris, frost, couteaux ───────────────────
        let zoomT = p.zoom, irisT = p.iris, frostT = p.frost;
        if (resetFX) {
            zoomT = rt < 1.2 ? 48 : rt < 2.2 ? 5 : p.zoom;
            irisT = rt < 1.4 ? 5 : p.iris;
            frostT = 0;
        }
        this.zoom = approach(this.zoom, zoomT, dt * 75);
        this.focus = approach(this.focus, p.focus, dt * 160);
        this.iris = approach(this.iris, irisT, dt * 320);
        this.frost = approach(this.frost, frostT, dt * 280);
        for (let i = 0; i < 4; i++) {
            const insT = resetFX ? 0 : p['blade' + (i + 1)];
            this.blades[i] = approach(this.blades[i], insT, dt * 260);
            this.bladeAngles[i] = approach(this.bladeAngles[i], p['blade' + (i + 1) + 'Angle'], dt * 140);
            out.blades[i] = this.blades[i] / 100;
            out.bladeAngles[i] = this.bladeAngles[i] * DEG;
        }
        this.bladeRot = approach(this.bladeRot, p.bladeRot, dt * 120);
        out.bladeRot = this.bladeRot * DEG;

        out.zoom = this.zoom;
        out.iris = clamp(this.iris / 100, 0.05, 1);
        out.frost = clamp(this.frost / 100, 0, 1);
        out.focus = clamp(this.focus / 100, 0, 1);
        return out;
    }

    /** Facteur d'obturation [0…1] selon le mode d'obturateur */
    _shutter(dt, p) {
        const s = clamp(p.shutterSpeed / 100, 0, 1);
        this.shutterTime += dt;
        switch (p.shutter) {
            case 'Fermé':
                return 0;
            case 'Strobe': {
                const f = 0.8 + s * s * 24;      // 0.8 … 25 Hz
                const ph = (this.shutterTime * f) % 1;
                return ph < 0.22 ? 1 : 0;
            }
            case 'Pulse ouverture': {
                const f = 0.3 + s * 6;
                const ph = (this.shutterTime * f) % 1;
                return ph * ph;
            }
            case 'Pulse fermeture': {
                const f = 0.3 + s * 6;
                const ph = (this.shutterTime * f) % 1;
                return (1 - ph) * (1 - ph);
            }
            case 'Strobe aléatoire': {
                // Éclair de 20 à 70 ms, puis pause aléatoire (d'autant plus courte que la vitesse est haute)
                if (this.shutterTime >= this._rndNext) {
                    this._rndLen = this.shutterTime + 0.02 + Math.random() * 0.05;
                    const rate = 0.6 + s * 14;
                    this._rndNext = this._rndLen + (0.2 + Math.random() * 1.6) / rate;
                }
                return this.shutterTime < this._rndLen ? 1 : 0;
            }
            default:
                return 1;
        }
    }
}
