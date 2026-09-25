/**
 * LightingSync.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Module autonome dédié à la synchronisation multijoueur :
 * - Ambiance & Ciel (preset 23 ambiances, étoiles, boost scène, reset global)
 * - Illumination Globale Statique (GI 0 lag, intensités, rebonds, couleurs)
 * - Post-traitement Laser (bloom, aberration chromatique, fumée scénique)
 * - Lumières 3D de la scène (déplacement gizmo/sliders, couleurs, intensité, spots, ombres)
 *     * Synchronisé dans le menu si l'autre joueur a sélectionné la même lumière
 *     * Sinon synchronisation invisible en arrière-plan dans la scène 3D
 * - Lasers 3D de la scène (déplacement, rotation, duplication, suppression)
 * - Personnalisation laser (LaserInspectorPanel) :
 *     * Synchronisé dans le menu si l'autre joueur a ouvert le même laser
 *     * Sinon synchronisation en arrière-plan dans la scène 3D
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';
import { LASER_PARAMS_SCHEMA } from '../laser/config/laserParams.js';

export class LightingSync {
    /**
     * @param {object} options
     * @param {import('./MultiplayerClient.js').MultiplayerClient} options.mp
     * @param {import('../ui/AmbiancePanel.js').AmbiancePanel} options.ambiancePanel
     * @param {import('../laser/LaserManager.js').LaserManager} options.laserManager
     * @param {import('../scene/staticGI.js').StaticGlobalIllumination} options.staticGI
     * @param {THREE.Scene} options.scene
     */
    constructor({ mp, ambiancePanel, laserManager, staticGI, scene }) {
        this.mp = mp;
        this.ambiancePanel = ambiancePanel;
        this.laserManager = laserManager;
        this.staticGI = staticGI;
        this.scene = scene;

        this._isApplyingRemote = false;
        this._throttleTimers = new Map();
        this._pendingThrottled = new Map();
        this._THROTTLE_MS = 30; // ~33 fps pour les manipulations fluides sans saturer le réseau
    }

    /**
     * Initialise les écouteurs réseau et branche les interfaces
     */
    init() {
        if (!this.mp) return;

        // 1. Écoute des mises à jour réseau
        this.mp.onLightingUpdate((msg) => {
            this.handleRemoteUpdate(msg);
        });

        // 2. Si un état complet est disponible (connexion à une room déjà existante)
        if (this.mp.lightingState) {
            this.applyFullState(this.mp.lightingState);
        }

        // 3. Écoute des actions de l'AmbiancePanel
        if (this.ambiancePanel) {
            this.ambiancePanel.onSync((event) => {
                this.handleLocalEvent(event);
            });
        }

        // 4. Écoute des actions de l'inspecteur laser
        if (this.ambiancePanel && this.ambiancePanel._laserInspectorPanel) {
            this.ambiancePanel._laserInspectorPanel.onSync((event) => {
                this.handleLocalEvent(event);
            });
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Envoi Local ➔ Réseau
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Traite un événement émis par l'interface locale et l'envoie sur le réseau
     * @param {object} event
     */
    handleLocalEvent(event) {
        if (!this.mp || !this.mp.connected || !this.mp.roomId) return;
        if (this._isApplyingRemote) return;

        const { category, id, data } = event;

        // Événements continus nécessitant un throttling (sliders, gizmo)
        if (category === 'laser_transform' || (category === 'light_update' && data && (data.position || data.target || data.color || data.intensity)) || category === 'laser_param') {
            const throttleKey = `${category}_${id || 'global'}_${data ? Object.keys(data).join('_') : (event.param || '')}`;
            this._sendThrottled(throttleKey, event);
            return;
        }

        // Événements discrets / immédiats (presets, ajouts, suppressions, resets)
        this.mp.sendLighting(event);
    }

    _sendThrottled(key, payload) {
        this._pendingThrottled.set(key, payload);

        if (!this._throttleTimers.has(key)) {
            // Premier événement : envoi immédiat
            this.mp.sendLighting(payload);
            this._pendingThrottled.delete(key);

            const timer = setTimeout(() => {
                this._throttleTimers.delete(key);
                if (this._pendingThrottled.has(key)) {
                    const latest = this._pendingThrottled.get(key);
                    this._pendingThrottled.delete(key);
                    this.mp.sendLighting(latest);
                }
            }, this._THROTTLE_MS);

            this._throttleTimers.set(key, timer);
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Réception Réseau ➔ Application Scène 3D & Interface
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Applique une mise à jour reçue d'un autre joueur
     * @param {object} msg
     */
    handleRemoteUpdate(msg) {
        this._isApplyingRemote = true;
        if (this.ambiancePanel) this.ambiancePanel._isRemoteUpdate = true;
        if (this.ambiancePanel?._laserInspectorPanel) this.ambiancePanel._laserInspectorPanel._isRemoteUpdate = true;

        try {
            const { category, data, id } = msg;

            switch (category) {
                // ── 1. Ambiance Céleste ──
                case 'env':
                    this._applyEnvUpdate(data);
                    break;

                // ── 2. Illumination Globale Statique (GI) ──
                case 'gi':
                    this._applyGIUpdate(data);
                    break;

                // ── 3. Post-traitement Laser ──
                case 'laser_post':
                    this._applyLaserPostUpdate(data);
                    break;

                // ── 4. Lumières de la Scène ──
                case 'light_update':
                    this._applyLightUpdate(id, data);
                    break;

                case 'light_add':
                    this._applyLightAdd(data);
                    break;

                case 'light_remove':
                    this._applyLightRemove(id);
                    break;

                case 'light_reset':
                    this._applyLightReset(id);
                    break;

                // ── 5. Lasers 3D de la Scène ──
                case 'laser_transform':
                    this._applyLaserTransform(id, data);
                    break;

                case 'laser_param':
                    this._applyLaserParam(id, msg.param, msg.value);
                    break;

                case 'laser_add':
                    this._applyLaserAdd(data);
                    break;

                case 'laser_remove':
                    this._applyLaserRemove(id);
                    break;

                case 'laser_reset_all':
                    this._applyLaserResetAll(id);
                    break;

                // ── 6. Reset Global ──
                case 'reset_all':
                    if (this.ambiancePanel) {
                        this.ambiancePanel.resetAll();
                    }
                    break;
            }
        } catch (err) {
            console.error('[LightingSync] Erreur lors de l\'application distante :', err);
        } finally {
            this._isApplyingRemote = false;
            if (this.ambiancePanel) this.ambiancePanel._isRemoteUpdate = false;
            if (this.ambiancePanel?._laserInspectorPanel) this.ambiancePanel._laserInspectorPanel._isRemoteUpdate = false;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Handlers spécifiques
    // ─────────────────────────────────────────────────────────────────────────

    _applyEnvUpdate(data) {
        if (!data || !this.ambiancePanel) return;

        if (data.presetKey !== undefined) {
            this.ambiancePanel.applyEnvPreset(data.presetKey);
            if (this.ambiancePanel._cPreset) {
                try { this.ambiancePanel._cPreset.updateDisplay(); } catch (_) {}
            }
        }

        if (data.stars !== undefined) {
            this.ambiancePanel.envState.stars = Boolean(data.stars);
            this.ambiancePanel._updateStarsVisibility();
        }
        if (data.starSize !== undefined) {
            this.ambiancePanel.setStarSize(data.starSize);
        }
        if (data.starCount !== undefined) {
            this.ambiancePanel.setStarCount(data.starCount);
        }
        if (data.starBrightness !== undefined) {
            this.ambiancePanel.setStarBrightness(data.starBrightness);
        }
        if (data.stageBoost !== undefined) {
            this.ambiancePanel.envState.stageBoost = data.stageBoost;
            this.ambiancePanel._updateStageBoost();
        }

        // Rafraîchir l'affichage du menu Ambiance & Ciel si ouvert
        if (this.ambiancePanel.gui) {
            const fEnv = this.ambiancePanel.gui.folders?.find(f => f._title === '🌌 Ambiance & Ciel');
            if (fEnv) {
                fEnv.controllers?.forEach(c => { try { c.updateDisplay(); } catch (_) {} });
                fEnv.folders?.forEach(f => f.controllers?.forEach(c => { try { c.updateDisplay(); } catch (_) {} }));
            }
        }
    }

    _applyGIUpdate(data) {
        if (!data || !this.staticGI) return;

        let needsEnvMap = false;
        for (const [key, val] of Object.entries(data)) {
            this.staticGI.params[key] = val;
            if (key.includes('Color')) needsEnvMap = true;
        }

        this.staticGI.update();
        if (needsEnvMap) {
            this.staticGI.generateStaticEnvMap();
        }

        if (this.ambiancePanel && this.ambiancePanel.fGI) {
            this.ambiancePanel.fGI.controllers?.forEach(c => { try { c.updateDisplay(); } catch (_) {} });
        }
    }

    _applyLaserPostUpdate(data) {
        if (!data || !this.laserManager) return;

        for (const [key, val] of Object.entries(data)) {
            this.laserManager.setPostProcessingParam(key, val);
        }

        if (this.ambiancePanel && this.ambiancePanel.gui) {
            const fLaser = this.ambiancePanel.gui.folders?.find(f => f._title === '🔴 Post-traitement Laser');
            if (fLaser) {
                fLaser.controllers?.forEach(c => { try { c.updateDisplay(); } catch (_) {} });
                fLaser.folders?.forEach(f => f.controllers?.forEach(c => { try { c.updateDisplay(); } catch (_) {} }));
            }
        }
    }

    _applyLightUpdate(id, data) {
        if (!this.ambiancePanel || !id || !data) return;

        const entry = this.ambiancePanel.lights.find(e => e.id === id);
        if (!entry || !entry.light) return;

        const light = entry.light;

        // Position 3D
        if (data.position) {
            light.position.set(data.position.x, data.position.y, data.position.z);
            if (entry.markerMesh) entry.markerMesh.position.copy(light.position);
        }

        // Cible (Target)
        if (data.target && light.target) {
            light.target.position.set(data.target.x, data.target.y, data.target.z);
            light.target.updateMatrixWorld();
        }

        // Propriétés scalaires et visuelles
        if (data.color !== undefined) {
            light.color.set(data.color);
            if (entry.markerMesh) {
                const core = entry.markerMesh.children[0];
                if (core && core.material) core.material.color.set(data.color);
            }
            if (light.userData?.bulbMesh?.material) {
                light.userData.bulbMesh.material.color.set(data.color);
            }
        }
        if (data.intensity !== undefined) light.intensity = data.intensity;
        if (data.visible !== undefined) {
            light.visible = data.visible;
            if (light.userData?.bulbMesh) light.userData.bulbMesh.visible = data.visible;
        }
        if (data.distance !== undefined) light.distance = data.distance;
        if (data.angle !== undefined) light.angle = THREE.MathUtils.degToRad(data.angle);
        if (data.penumbra !== undefined) light.penumbra = data.penumbra;
        if (data.decay !== undefined) light.decay = data.decay;
        if (data.width !== undefined) light.width = data.width;
        if (data.height !== undefined) light.height = data.height;
        if (data.groundColor !== undefined && light.groundColor) light.groundColor.set(data.groundColor);
        if (data.castShadow !== undefined) light.castShadow = Boolean(data.castShadow);

        if (entry.helper && typeof entry.helper.update === 'function') {
            entry.helper.update();
        }

        // ── Règle demandée : mise à jour du panneau UNIQUEMENT si la personne a sélectionné la même lumière ──
        if (this.ambiancePanel.selectedEntry && this.ambiancePanel.selectedEntry.id === id) {
            this.ambiancePanel._syncInspectorDisplays();
            if (this.ambiancePanel.ctrlPosX) this.ambiancePanel.ctrlPosX.setValue(light.position.x);
            if (this.ambiancePanel.ctrlPosY) this.ambiancePanel.ctrlPosY.setValue(light.position.y);
            if (this.ambiancePanel.ctrlPosZ) this.ambiancePanel.ctrlPosZ.setValue(light.position.z);
            if (light.target && this.ambiancePanel.ctrlTargetX) {
                this.ambiancePanel.ctrlTargetX.setValue(light.target.position.x);
                this.ambiancePanel.ctrlTargetY.setValue(light.target.position.y);
                this.ambiancePanel.ctrlTargetZ.setValue(light.target.position.z);
            }
        }
    }

    _applyLightAdd(data) {
        if (!data || !this.ambiancePanel) return;

        // Éviter tout doublon si la lumière existe déjà
        const existing = this.ambiancePanel.lights.find(e => e.id === data.id);
        if (existing) return;

        const color = new THREE.Color(data.color || '#ffffff');
        const intensity = data.intensity !== undefined ? data.intensity : 2.0;
        let light = null;

        switch (data.type) {
            case 'SpotLight':
                light = new THREE.SpotLight(color, intensity);
                if (data.distance !== undefined) light.distance = data.distance;
                if (data.angle !== undefined) light.angle = THREE.MathUtils.degToRad(data.angle);
                if (data.penumbra !== undefined) light.penumbra = data.penumbra;
                if (data.decay !== undefined) light.decay = data.decay;
                if (data.target) {
                    light.target.position.set(data.target.x, data.target.y, data.target.z);
                    this.scene.add(light.target);
                }
                break;
            case 'DirectionalLight':
                light = new THREE.DirectionalLight(color, intensity);
                if (data.target) {
                    light.target.position.set(data.target.x, data.target.y, data.target.z);
                    this.scene.add(light.target);
                }
                break;
            case 'AmbientLight':
                light = new THREE.AmbientLight(color, intensity);
                break;
            case 'HemisphereLight':
                light = new THREE.HemisphereLight(color, data.groundColor || 0x444444, intensity);
                break;
            case 'RectAreaLight':
                light = new THREE.RectAreaLight(color, intensity, data.width || 4, data.height || 2);
                break;
            default:
                light = new THREE.PointLight(color, intensity, data.distance || 25);
                if (data.decay !== undefined) light.decay = data.decay;
                break;
        }

        if (data.position) {
            light.position.set(data.position.x, data.position.y, data.position.z);
        }
        if (data.visible !== undefined) light.visible = Boolean(data.visible);
        if (data.castShadow !== undefined) light.castShadow = Boolean(data.castShadow);

        this.scene.add(light);
        this.ambiancePanel.registerLight(light, Boolean(data.isBuiltin), data.name, data.id);

        if (this.ambiancePanel.isOpen) {
            this.ambiancePanel._rebuildInspectorGui();
        }
    }

    _applyLightRemove(id) {
        if (!this.ambiancePanel || !id) return;
        const entry = this.ambiancePanel.lights.find(e => e.id === id);
        if (entry) {
            this.ambiancePanel.removeLight(entry);
        }
    }

    _applyLightReset(id) {
        if (!this.ambiancePanel || !id) return;
        const entry = this.ambiancePanel.lights.find(e => e.id === id);
        if (entry) {
            this.ambiancePanel.resetLight(entry);
            if (this.ambiancePanel.selectedEntry && this.ambiancePanel.selectedEntry.id === id) {
                this.ambiancePanel._syncInspectorDisplays();
            }
        }
    }

    _applyLaserTransform(id, data) {
        if (!this.laserManager || !id || !data) return;

        const laser = this.laserManager.getLaser(id);
        if (!laser) return;

        const housing = laser.getHousingGroup();

        if (data.position) {
            laser.setPosition(data.position.x, data.position.y, data.position.z);
            if (housing) housing.position.set(data.position.x, data.position.y, data.position.z);
        }

        if (data.rotation) {
            const { angle = 0, tilt = 0, roll = 0 } = data.rotation;
            laser.setParam('angle', angle);
            laser.setParam('tilt', tilt);
            laser.setParam('roll', roll);
            if (housing) {
                housing.rotation.set(-tilt * (Math.PI / 180), angle * (Math.PI / 180), roll * (Math.PI / 180), 'YXZ');
                housing.updateMatrixWorld();
            }
        }

        const numId = typeof id === 'number' ? id : parseInt(id, 10);
        // ── Règle : mise à jour du panneau si le même laser est sélectionné ──
        if (this.ambiancePanel && this.ambiancePanel.selectedLaser) {
            const selId = this.ambiancePanel.selectedLaser.laserId;
            const selNumId = typeof selId === 'number' ? selId : parseInt(selId, 10);
            if (selId === id || selNumId === numId) {
                if (this.ambiancePanel._laserPosControllers && data.position) {
                    this.ambiancePanel._laserPosControllers.posState.x = data.position.x;
                    this.ambiancePanel._laserPosControllers.posState.y = data.position.y;
                    this.ambiancePanel._laserPosControllers.posState.z = data.position.z;
                    try {
                        this.ambiancePanel._laserPosControllers.posX.updateDisplay();
                        this.ambiancePanel._laserPosControllers.posY.updateDisplay();
                        this.ambiancePanel._laserPosControllers.posZ.updateDisplay();
                    } catch (_) {}
                }
                if (this.ambiancePanel._laserRotControllers && data.rotation) {
                    this.ambiancePanel._laserRotControllers.rotState.angle = data.rotation.angle || 0;
                    this.ambiancePanel._laserRotControllers.rotState.tilt = data.rotation.tilt || 0;
                    this.ambiancePanel._laserRotControllers.rotState.roll = data.rotation.roll || 0;
                    try {
                        this.ambiancePanel._laserRotControllers.ctrlAngle.updateDisplay();
                        this.ambiancePanel._laserRotControllers.ctrlTilt.updateDisplay();
                        if (this.ambiancePanel._laserRotControllers.ctrlRoll) {
                            this.ambiancePanel._laserRotControllers.ctrlRoll.updateDisplay();
                        }
                    } catch (_) {}
                }
            }
        }

        // ── Règle : synchroniser l'inspecteur laser individuel s'il est ouvert sur ce laser ──
        const curInspId = this.ambiancePanel?._laserInspectorPanel?._currentLaserId;
        const curInspNumId = typeof curInspId === 'number' ? curInspId : parseInt(curInspId, 10);
        if (this.ambiancePanel?._laserInspectorPanel?.isOpen && (curInspId === id || curInspNumId === numId)) {
            this.ambiancePanel._laserInspectorPanel.syncFromLaser();
        }
    }

    _applyLaserParam(id, param, value) {
        if (!this.laserManager || id === undefined || param === undefined) return;

        const numId = typeof id === 'number' ? id : parseInt(id, 10);
        const laser = this.laserManager.getLaser(numId) || this.laserManager.getLaser(id);
        if (!laser) {
            console.warn('[LightingSync] Laser introuvable pour param:', id, param, value);
            return;
        }

        laser.setParam(param, value);

        // ── Règle : synchroniser si le même menu de personnalisation laser est ouvert ──
        const curInspId = this.ambiancePanel?._laserInspectorPanel?._currentLaserId;
        const curInspNumId = typeof curInspId === 'number' ? curInspId : parseInt(curInspId, 10);
        if (this.ambiancePanel?._laserInspectorPanel?.isOpen && (curInspId === id || curInspNumId === numId)) {
            this.ambiancePanel._laserInspectorPanel.syncFromLaser();
        }
    }

    _applyLaserAdd(data) {
        if (!data || !this.laserManager) return;

        const id = parseInt(data.id, 10);
        if (this.laserManager.getLaser(id)) return; // Déjà présent

        const pos = data.position ? new THREE.Vector3(data.position.x, data.position.y, data.position.z) : new THREE.Vector3(0, 5, 0);
        const { laserShow } = this.laserManager.addLaser(pos, data.params || {}, id);

        if (data.rotation) {
            const { angle = 0, tilt = 0, roll = 0 } = data.rotation;
            laserShow.setParam('angle', angle);
            laserShow.setParam('tilt', tilt);
            laserShow.setParam('roll', roll);
            const housing = laserShow.getHousingGroup();
            if (housing) {
                housing.rotation.set(-tilt * (Math.PI / 180), angle * (Math.PI / 180), roll * (Math.PI / 180), 'YXZ');
                housing.updateMatrixWorld();
            }
        }

        if (this.ambiancePanel && this.ambiancePanel.isOpen) {
            this.ambiancePanel._rebuildInspectorGui();
        }
    }

    _applyLaserRemove(id) {
        if (!this.laserManager || !id) return;
        const laserId = parseInt(id, 10);

        if (this.ambiancePanel) {
            if (this.ambiancePanel.selectedLaser && this.ambiancePanel.selectedLaser.laserId === laserId) {
                this.ambiancePanel.deselectLaser();
            }
            if (this.ambiancePanel._laserInspectorPanel && this.ambiancePanel._laserInspectorPanel._currentLaserId === laserId) {
                this.ambiancePanel._laserInspectorPanel.close();
            }
        }

        this.laserManager.removeLaser(laserId);

        if (this.ambiancePanel && this.ambiancePanel.isOpen) {
            this.ambiancePanel._rebuildInspectorGui();
        }
    }

    _applyLaserResetAll(id) {
        if (!this.laserManager || !id) return;
        const laser = this.laserManager.getLaser(id);
        if (!laser) return;

        if (this.ambiancePanel?._laserInspectorPanel?.isOpen && this.ambiancePanel._laserInspectorPanel._currentLaserId === id) {
            this.ambiancePanel._laserInspectorPanel.resetAllLaserParams();
        } else {
            for (const [k, schema] of Object.entries(LASER_PARAMS_SCHEMA)) {
                laser.setParam(k, schema.value);
            }
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Synchronisation de l'état complet à la connexion (ROOM_CREATED / ROOM_JOINED)
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Applique l'état complet de la pièce (Ambiance, GI, Post-laser, Lumières, Lasers)
     * @param {object} state
     */
    applyFullState(state) {
        if (!state) return;
        this._isApplyingRemote = true;
        if (this.ambiancePanel) this.ambiancePanel._isRemoteUpdate = true;

        try {
            // 1. Ambiance & Ciel
            if (state.env) {
                this._applyEnvUpdate(state.env);
            }

            // 2. GI Statique
            if (state.gi) {
                this._applyGIUpdate(state.gi);
            }

            // 3. Post-traitement Laser
            if (state.laserPost) {
                this._applyLaserPostUpdate(state.laserPost);
            }

            // 4. Lumières de la scène
            if (state.lights && typeof state.lights === 'object') {
                for (const [lightId, lightData] of Object.entries(state.lights)) {
                    const existing = this.ambiancePanel?.lights.find(e => e.id === lightId);
                    if (existing) {
                        this._applyLightUpdate(lightId, lightData);
                    } else if (lightData && lightData.type) {
                        this._applyLightAdd(lightData);
                    }
                }
            }

            // 5. Lasers de la scène
            if (state.lasers && typeof state.lasers === 'object') {
                for (const [laserIdStr, laserData] of Object.entries(state.lasers)) {
                    const laserId = parseInt(laserIdStr, 10);
                    const existing = this.laserManager?.getLaser(laserId);
                    if (existing) {
                        if (laserData.position || laserData.rotation) {
                            this._applyLaserTransform(laserId, laserData);
                        }
                        if (laserData.params) {
                            for (const [p, v] of Object.entries(laserData.params)) {
                                existing.setParam(p, v);
                            }
                        }
                    } else if (laserData) {
                        this._applyLaserAdd({ id: laserId, ...laserData });
                    }
                }
            }

            if (this.ambiancePanel && this.ambiancePanel.isOpen) {
                this.ambiancePanel._buildGui();
            }
        } catch (err) {
            console.error('[LightingSync] Erreur lors de applyFullState :', err);
        } finally {
            this._isApplyingRemote = false;
            if (this.ambiancePanel) this.ambiancePanel._isRemoteUpdate = false;
        }
    }
}
