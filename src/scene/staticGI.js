/**
 * staticGI.js — Illumination Globale Statique (Static GI) haute performance
 * ─────────────────────────────────────────────────────────────────────────────
 * Éclaire les éléments architecturaux et statiques (scène, structures truss,
 * dessous du toit, subwoofers au sol, sol herbeux) avec 0 lag garanti :
 * 1. THREE.LightProbe : irradiance diffuse hémisphérique à base d'harmoniques sphériques (SH3).
 * 2. THREE.PMREMGenerator : carte d'environnement IBL diffuse/spéculaire pré-calculée.
 * 3. Rebonds diffus ciblés (castShadow: false = 0 shadow map = 60 FPS constants) :
 *    - Rebond plancher et fond de scène (stageFloorBounce)
 *    - Rebond sous le toit truss (stageRoofBounce)
 *    - Rebond frontal au sol devant les caissons de basse (subwoofersLipBounce)
 */

import * as THREE from 'three';

export const GI_PRESETS = {
    // ☀️ Plein Jour (6)
    day: {
        skyColor: '#7eb5e6',
        groundBounceColor: '#386622',
        stageBounceColor: '#506880',
        subwooferBounceColor: '#26381e',
        intensity: 0.95,
        stageBounceIntensity: 0.85,
        roofBounceIntensity: 0.65,
        subwooferBounceIntensity: 0.75,
    },
    day_zenith: {
        skyColor: '#82bbf2',
        groundBounceColor: '#427820',
        stageBounceColor: '#5c7490',
        subwooferBounceColor: '#2e4420',
        intensity: 1.05,
        stageBounceIntensity: 0.90,
        roofBounceIntensity: 0.70,
        subwooferBounceIntensity: 0.80,
    },
    day_tropical: {
        skyColor: '#58c8df',
        groundBounceColor: '#387520',
        stageBounceColor: '#3a6874',
        subwooferBounceColor: '#224522',
        intensity: 1.00,
        stageBounceIntensity: 0.85,
        roofBounceIntensity: 0.65,
        subwooferBounceIntensity: 0.75,
    },
    day_overcast: {
        skyColor: '#b0bac5',
        groundBounceColor: '#3c4538',
        stageBounceColor: '#4a535e',
        subwooferBounceColor: '#2b332b',
        intensity: 0.80,
        stageBounceIntensity: 0.75,
        roofBounceIntensity: 0.60,
        subwooferBounceIntensity: 0.70,
    },
    day_spring: {
        skyColor: '#94c2ec',
        groundBounceColor: '#447828',
        stageBounceColor: '#556882',
        subwooferBounceColor: '#28401e',
        intensity: 0.90,
        stageBounceIntensity: 0.85,
        roofBounceIntensity: 0.65,
        subwooferBounceIntensity: 0.75,
    },
    day_desert_haze: {
        skyColor: '#d8be94',
        groundBounceColor: '#664c24',
        stageBounceColor: '#64503c',
        subwooferBounceColor: '#44321c',
        intensity: 0.95,
        stageBounceIntensity: 0.85,
        roofBounceIntensity: 0.65,
        subwooferBounceIntensity: 0.75,
    },

    // 🌇 Fin de Journée / Golden Hour (5)
    golden_california: {
        skyColor: '#d97825',
        groundBounceColor: '#361c0c',
        stageBounceColor: '#6b3d1c',
        subwooferBounceColor: '#3d200e',
        intensity: 0.85,
        stageBounceIntensity: 0.85,
        roofBounceIntensity: 0.65,
        subwooferBounceIntensity: 0.75,
    },
    golden_copper: {
        skyColor: '#ba5222',
        groundBounceColor: '#2d140a',
        stageBounceColor: '#5e2c16',
        subwooferBounceColor: '#33160a',
        intensity: 0.85,
        stageBounceIntensity: 0.85,
        roofBounceIntensity: 0.65,
        subwooferBounceIntensity: 0.75,
    },
    golden_peach: {
        skyColor: '#a65373',
        groundBounceColor: '#281420',
        stageBounceColor: '#5a3048',
        subwooferBounceColor: '#301625',
        intensity: 0.80,
        stageBounceIntensity: 0.85,
        roofBounceIntensity: 0.60,
        subwooferBounceIntensity: 0.70,
    },
    golden_vintage: {
        skyColor: '#b8782a',
        groundBounceColor: '#301a0a',
        stageBounceColor: '#5e3c1a',
        subwooferBounceColor: '#361e0e',
        intensity: 0.85,
        stageBounceIntensity: 0.85,
        roofBounceIntensity: 0.65,
        subwooferBounceIntensity: 0.75,
    },
    golden_festival: {
        skyColor: '#cc3814',
        groundBounceColor: '#280a04',
        stageBounceColor: '#661f0e',
        subwooferBounceColor: '#3b1107',
        intensity: 0.90,
        stageBounceIntensity: 0.90,
        roofBounceIntensity: 0.70,
        subwooferBounceIntensity: 0.80,
    },

    // 🌅 Crépuscule (6)
    sunset: {
        skyColor: '#9e3f32',
        groundBounceColor: '#201218',
        stageBounceColor: '#4c2430',
        subwooferBounceColor: '#241218',
        intensity: 0.75,
        stageBounceIntensity: 0.85,
        roofBounceIntensity: 0.60,
        subwooferBounceIntensity: 0.70,
    },
    sunset_blue_hour: {
        skyColor: '#1b3c78',
        groundBounceColor: '#0a1426',
        stageBounceColor: '#1c2e54',
        subwooferBounceColor: '#0e1830',
        intensity: 0.70,
        stageBounceIntensity: 0.80,
        roofBounceIntensity: 0.60,
        subwooferBounceIntensity: 0.70,
    },
    sunset_carmine: {
        skyColor: '#6e1828',
        groundBounceColor: '#1c070d',
        stageBounceColor: '#46141f',
        subwooferBounceColor: '#240a10',
        intensity: 0.75,
        stageBounceIntensity: 0.85,
        roofBounceIntensity: 0.65,
        subwooferBounceIntensity: 0.75,
    },
    sunset_synthwave: {
        skyColor: '#821c70',
        groundBounceColor: '#1a0620',
        stageBounceColor: '#501848',
        subwooferBounceColor: '#280a30',
        intensity: 0.80,
        stageBounceIntensity: 0.90,
        roofBounceIntensity: 0.65,
        subwooferBounceIntensity: 0.75,
    },
    sunset_sahara: {
        skyColor: '#8a431c',
        groundBounceColor: '#241108',
        stageBounceColor: '#522b16',
        subwooferBounceColor: '#2b140a',
        intensity: 0.75,
        stageBounceIntensity: 0.85,
        roofBounceIntensity: 0.60,
        subwooferBounceIntensity: 0.70,
    },
    sunset_autumn: {
        skyColor: '#5a3045',
        groundBounceColor: '#180e14',
        stageBounceColor: '#402434',
        subwooferBounceColor: '#20111a',
        intensity: 0.70,
        stageBounceIntensity: 0.80,
        roofBounceIntensity: 0.60,
        subwooferBounceIntensity: 0.65,
    },

    // 🌙 Nuit Noire (6)
    night: {
        skyColor: '#121e36',
        groundBounceColor: '#08120c',
        stageBounceColor: '#1a263c',
        subwooferBounceColor: '#0b1422',
        intensity: 0.60,
        stageBounceIntensity: 0.75,
        roofBounceIntensity: 0.55,
        subwooferBounceIntensity: 0.65,
    },
    night_deep: {
        skyColor: '#0a1222',
        groundBounceColor: '#030605',
        stageBounceColor: '#101828',
        subwooferBounceColor: '#060b14',
        intensity: 0.50,
        stageBounceIntensity: 0.70,
        roofBounceIntensity: 0.50,
        subwooferBounceIntensity: 0.60,
    },
    night_aurora: {
        skyColor: '#0d554a',
        groundBounceColor: '#041c17',
        stageBounceColor: '#0e3e37',
        subwooferBounceColor: '#06241f',
        intensity: 0.75,
        stageBounceIntensity: 0.85,
        roofBounceIntensity: 0.70,
        subwooferBounceIntensity: 0.75,
    },
    night_moon: {
        skyColor: '#22385c',
        groundBounceColor: '#0e1a16',
        stageBounceColor: '#25344c',
        subwooferBounceColor: '#121c2c',
        intensity: 0.70,
        stageBounceIntensity: 0.80,
        roofBounceIntensity: 0.60,
        subwooferBounceIntensity: 0.70,
    },
    night_cyber: {
        skyColor: '#461266',
        groundBounceColor: '#110420',
        stageBounceColor: '#34114d',
        subwooferBounceColor: '#1a0728',
        intensity: 0.80,
        stageBounceIntensity: 0.90,
        roofBounceIntensity: 0.70,
        subwooferBounceIntensity: 0.80,
    },
    night_storm: {
        skyColor: '#1a243c',
        groundBounceColor: '#080c14',
        stageBounceColor: '#1c263c',
        subwooferBounceColor: '#0e1422',
        intensity: 0.65,
        stageBounceIntensity: 0.75,
        roofBounceIntensity: 0.60,
        subwooferBounceIntensity: 0.65,
    },
};

export class StaticGlobalIllumination {
    /**
     * @param {object} options
     * @param {THREE.Scene} options.scene
     * @param {THREE.WebGLRenderer} options.renderer
     */
    constructor({ scene, renderer }) {
        this.scene = scene;
        this.renderer = renderer;

        const defaultPreset = GI_PRESETS.night_aurora;
        this.params = {
            enabled: false, // Désactivé par défaut
            intensity: defaultPreset.intensity,
            skyColor: defaultPreset.skyColor,
            groundBounceColor: defaultPreset.groundBounceColor,
            stageBounceIntensity: defaultPreset.stageBounceIntensity,
            stageBounceColor: defaultPreset.stageBounceColor,
            roofBounceIntensity: defaultPreset.roofBounceIntensity,
            subwooferBounceIntensity: defaultPreset.subwooferBounceIntensity,
            subwooferBounceColor: defaultPreset.subwooferBounceColor,
        };

        this.group = new THREE.Group();
        this.group.name = 'static-global-illumination-group';
        this.scene.add(this.group);

        // ── 1. LightProbe à Harmoniques Sphériques (Diffuse SH3 à 360°, 0 lag) ──
        this.probe = new THREE.LightProbe();
        this.probe.name = 'gi-sh3-light-probe';
        this.group.add(this.probe);

        // ── 2. Rebond intérieur de scène (au cœur de la scène, z = -5m, y = 4.5m) ──
        // Éclaire doucement le plancher, les marches et le fond de scène
        this.stageBounce = new THREE.PointLight(this.params.stageBounceColor, this.params.stageBounceIntensity, 40, 1.2);
        this.stageBounce.position.set(0, 4.5, -5.0);
        this.stageBounce.castShadow = false; // 0 shadow map = 0 lag
        this.stageBounce.name = 'gi-stage-bounce-fill';
        this.group.add(this.stageBounce);

        // ── 3. Rebond sous le toit de scène (y = 15m, z = -3.5m) ──
        // Dirigé vers le haut pour révéler la structure métallique des trusses et le dessous du toit
        this.roofBounce = new THREE.PointLight(this.params.stageBounceColor, this.params.roofBounceIntensity, 30, 1.4);
        this.roofBounce.position.set(0, 15.0, -3.5);
        this.roofBounce.castShadow = false;
        this.roofBounce.name = 'gi-roof-underside-bounce';
        this.group.add(this.roofBounce);

        // ── 4. Rebond frontal rasant au sol devant les caissons de basse (y = 1.2m, z = 4.0m) ──
        // Révèle le relief des 7 piles de subwoofers et le nez de scène
        this.subBounce = new THREE.DirectionalLight(this.params.subwooferBounceColor, this.params.subwooferBounceIntensity);
        this.subBounce.position.set(0, 1.8, 5.0);
        this.subBounce.target.position.set(0, 1.0, -0.5);
        this.subBounce.castShadow = false;
        this.subBounce.name = 'gi-subwoofers-lip-bounce';
        this.group.add(this.subBounce);
        this.group.add(this.subBounce.target);

        // ── 5. IBL Statique via PMREMGenerator pour scene.environment ──
        this.pmremGen = (this.renderer && THREE.PMREMGenerator) ? new THREE.PMREMGenerator(this.renderer) : null;
        this.envRenderTarget = null;

        this._cSky = new THREE.Color();
        this._cGnd = new THREE.Color();
        this._cStage = new THREE.Color();
        this._cSub = new THREE.Color();

        this.update();
        this.generateStaticEnvMap();
    }

    /**
     * Met à jour les harmoniques sphériques du LightProbe et les lumières de rebond
     */
    update() {
        const p = this.params;
        const isEnabled = Boolean(p.enabled);

        this.group.visible = isEnabled;
        if (!isEnabled) {
            if (this.scene.environment === this.envRenderTarget?.texture) {
                this.scene.environment = null;
            }
            return;
        }

        this._cSky.set(p.skyColor);
        this._cGnd.set(p.groundBounceColor);
        this._cStage.set(p.stageBounceColor);
        this._cSub.set(p.subwooferBounceColor);

        // ── Harmoniques Sphériques SH3 (Ramamoorthi & Hanrahan) ──
        // L00 : irradiance omnidirectionnelle moyenne
        // L10 (Y) : gradient vertical ciel/sol
        const sh = this.probe.sh;
        const totalInt = p.intensity;

        const avgR = (this._cSky.r + this._cGnd.r) * 0.5 * totalInt;
        const avgG = (this._cSky.g + this._cGnd.g) * 0.5 * totalInt;
        const avgB = (this._cSky.b + this._cGnd.b) * 0.5 * totalInt;

        const diffR = (this._cSky.r - this._cGnd.r) * 0.5 * totalInt;
        const diffG = (this._cSky.g - this._cGnd.g) * 0.5 * totalInt;
        const diffB = (this._cSky.b - this._cGnd.b) * 0.5 * totalInt;

        sh.coefficients[0].set(avgR, avgG, avgB);
        sh.coefficients[2].set(diffR, diffG, diffB); // Composante Y

        // Lumières de rebond intérieures
        this.stageBounce.color.copy(this._cStage);
        this.stageBounce.intensity = p.stageBounceIntensity * totalInt;

        this.roofBounce.color.copy(this._cStage);
        this.roofBounce.intensity = p.roofBounceIntensity * totalInt;

        this.subBounce.color.copy(this._cSub);
        this.subBounce.intensity = p.subwooferBounceIntensity * totalInt;

        if (this.envRenderTarget && !this.scene.environment) {
            this.scene.environment = this.envRenderTarget.texture;
        }
    }

    /**
     * Génère une texture IBL statique douce pré-filtrée pour scene.environment
     */
    generateStaticEnvMap() {
        if (!this.pmremGen || !this.params.enabled) return;

        try {
            const tempScene = new THREE.Scene();
            const sphereGeo = new THREE.SphereGeometry(60, 24, 16);
            const pos = sphereGeo.attributes.position;
            const colors = [];

            const cSky = new THREE.Color(this.params.skyColor);
            const cGnd = new THREE.Color(this.params.groundBounceColor);

            for (let i = 0; i < pos.count; i++) {
                const yNorm = pos.getY(i) / 60; // [-1, +1]
                const t = Math.max(0, Math.min(1, (yNorm + 0.9) * 0.55));
                const col = cGnd.clone().lerp(cSky, t);
                colors.push(col.r, col.g, col.b);
            }

            sphereGeo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
            const sphereMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide });
            const skyMesh = new THREE.Mesh(sphereGeo, sphereMat);
            tempScene.add(skyMesh);

            if (this.envRenderTarget) this.envRenderTarget.dispose();
            this.envRenderTarget = this.pmremGen.fromScene(tempScene, 0.04);
            this.scene.environment = this.envRenderTarget.texture;

            sphereGeo.dispose();
            sphereMat.dispose();
            console.log('[StaticGI] Environment map IBL générée avec succès pour la Global Illumination');
        } catch (err) {
            console.warn('[StaticGI] Erreur lors de la génération PMREM :', err);
        }
    }

    /**
     * Harmonise la GI statique lors d'un changement de preset d'ambiance céleste
     * @param {object} preset - Objet de preset issu de envPresets dans AmbiancePanel
     * @param {string} [presetKey] - Identifiant du preset (ex: 'night_aurora', 'golden_festival')
     */
    syncWithEnvPreset(preset, presetKey) {
        if (!preset && !presetKey) return;

        const key = presetKey || preset?.key || preset?.id;
        const giPreset = (key && GI_PRESETS[key]) ? GI_PRESETS[key] : (preset?.gi || null);

        if (giPreset) {
            this.params.skyColor = giPreset.skyColor;
            this.params.groundBounceColor = giPreset.groundBounceColor;
            this.params.stageBounceColor = giPreset.stageBounceColor;
            this.params.subwooferBounceColor = giPreset.subwooferBounceColor || '#2b3626';
            if (giPreset.intensity !== undefined) this.params.intensity = giPreset.intensity;
            if (giPreset.stageBounceIntensity !== undefined) this.params.stageBounceIntensity = giPreset.stageBounceIntensity;
            if (giPreset.roofBounceIntensity !== undefined) this.params.roofBounceIntensity = giPreset.roofBounceIntensity;
            if (giPreset.subwooferBounceIntensity !== undefined) this.params.subwooferBounceIntensity = giPreset.subwooferBounceIntensity;
        } else {
            // Repli automatique si preset dynamique ou personnalisé
            if (preset.hemi) {
                this.params.skyColor = preset.hemi.skyColor || this.params.skyColor;
                this.params.groundBounceColor = preset.hemi.groundColor || this.params.groundBounceColor;
            }
            if (preset.ambient) {
                this.params.stageBounceColor = preset.ambient.color || this.params.stageBounceColor;
                this.params.subwooferBounceColor = preset.ambient.color || this.params.subwooferBounceColor;
            }
        }

        this.update();
        this.generateStaticEnvMap();
    }

    dispose() {
        this.scene.remove(this.group);
        if (this.envRenderTarget) {
            if (this.scene.environment === this.envRenderTarget.texture) {
                this.scene.environment = null;
            }
            this.envRenderTarget.dispose();
        }
        if (this.pmremGen) {
            this.pmremGen.dispose();
        }
    }
}
