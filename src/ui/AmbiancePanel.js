/**
 * AmbiancePanel.js — Gestionnaire d'ambiance et d'éclairage 3D interactif :
 * - Repères visuels 3D pour toutes les lumières de la scène.
 * - Clic 3D (Raycasting) pour sélectionner n'importe quelle lumière.
 * - Gizmo 3D (TransformControls) avec flèches X (rouge), Y (vert), Z (bleu).
 * - Création de tous les types de lumières Three.js (Point, Spot, Directional, Ambient, Hemisphere, RectArea).
 * - Personnalisation complète avec boutons reset individuels (↺) et reset global (↺).
 * - DA identique aux racks DSP (lil-gui dark glassmorphism).
 */
import * as THREE from 'three';
import GUI from 'lil-gui';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { RectAreaLightHelper } from 'three/addons/helpers/RectAreaLightHelper.js';
import { makeDraggable } from './draggable.js';
import { globalLaserPostParams, enableBloom } from '../laser/LaserManager.js?v=298';
import { LaserInspectorPanel } from '../laser/ui/LaserInspectorPanel.js?v=200';
import { StrobeInspectorPanel } from '../strobe/ui/StrobeInspectorPanel.js?v=8';
import { SpotInspectorPanel } from '../spot/ui/SpotInspectorPanel.js';
import { LASER_PARAMS_SCHEMA } from '../laser/config/laserParams.js?v=27';
import { GI_PRESETS } from '../scene/staticGI.js';
import { probeObjectAdded } from '../audio/debugProbes.js?v=4';

// Réglages propres à chaque machine : jamais synchronisés via le serveur
const LOCAL_ONLY_POST_KEYS = new Set(['antialiasing', 'laserRange']);
const LOCAL_ONLY_LIGHT_KEYS = new Set(['shadowMapSize', 'mapSize']);



export class AmbiancePanel {
    /**
     * @param {object} options
     * @param {THREE.Scene} options.scene
     * @param {THREE.Camera} options.camera
     * @param {THREE.WebGLRenderer} options.renderer
     * @param {object} options.listener
     * @param {THREE.Light[]} [options.initialLights]
     */
    constructor(options = {}) {
        this.scene = options.scene;
        this.camera = options.camera;
        this.renderer = options.renderer;
        this.listener = options.listener;
        this.initialLights = options.initialLights || [];
        this.skybox = options.skybox || null;
        if (this.skybox) this.skybox.renderOrder = -2;
        this.staticGI = options.staticGI || null;



        // Initialisation de la librairie pour RectAreaLight
        try {
            RectAreaLightUniformsLib.init();
        } catch (_) {}

        // DOM elements
        this.ambianceBtn = document.getElementById('ambiance-btn');
        this.ambianceResetAllBtn = document.getElementById('ambiance-reset-all-btn');
        this.panelWrap = document.getElementById('ambiance-panel-wrap');
        this.panelContainer = document.getElementById('ambiance-panel');

        this.isOpen = false;
        this.selectedEntry = null;
        this.selectedLaser = null;
        this.selectedStrobe = null;
        this.strobeManager = options.strobeManager || null;
        this._strobeInspectorPanel = null;
        this.selectedSpot = null;
        this.spotManager = null;
        this._spotInspectorPanel = null;
        this.lights = []; // [{ id, name, light, type, isBuiltin, markerMesh, helper, defaultConfig }]
        this._nextId = 1;

        // Groupes 3D pour repères et helpers (masqués par défaut tant que le menu Ambiance est fermé)
        this.markersGroup = new THREE.Group();
        this.markersGroup.name = 'ambiance-markers-group';
        this.markersGroup.visible = false;
        this.scene.add(this.markersGroup);

        this.helpersGroup = new THREE.Group();
        this.helpersGroup.name = 'ambiance-helpers-group';
        this.helpersGroup.visible = false;
        this.scene.add(this.helpersGroup);

        this.markersVisible = false;
        this.soundMarkersVisible = false; // Ronds d'émission son masqués par défaut
        this.gizmoVisible = true;
        this.showSpotCones = true;
        this._gizmoTargetMode = 'lamp';
        this.isDraggingGizmo = false;

        this.ctrlPosX = null;
        this.ctrlPosY = null;
        this.ctrlPosZ = null;
        this.ctrlTargetX = null;
        this.ctrlTargetY = null;
        this.ctrlTargetZ = null;

        // Raycaster pour sélection au clic
        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();

        // Gizmo TransformControls (flèches 3D X Y Z)
        this._initTransformControls();

        // Interface lil-gui
        this.gui = null;
        this._activeControllers = [];

        // Paramètres pour l'ajout d'une nouvelle lumière
        this.creationParams = {
            type: 'PointLight',
            color: '#ffaa44',
            intensity: 2.0,
            distance: 25.0,
            angle: 45,
            penumbra: 0.4,
            width: 4.0,
            height: 2.0,
        };

        // Enregistrement des lumières initiales de la scène
        this._registerInitialLights();

        // Initialisation de l'ambiance céleste (Jour / Nuit / Crépuscule & Étoiles)
        this._initEnvironment();

        // Référence au LaserManager & Laser sélectionné
        this.laserManager = null;
        this.selectedLaser = null;
        this._laserInspectorPanel = null;

        // Construction du GUI
        this._buildGui();

        // Initialisation de la modal d'export de lampe
        this._exportModalOpen = false;
        this._createExportModalDOM();

        // Initialisation de la modal d'import de configuration lumière JSON
        this._importModalOpen = false;
        this._createImportModalDOM();

        // Événements boutons et clic raycast
        this._bindEvents();
    }

    /**
     * Injecte le LaserManager et initialise le panneau d'inspection laser.
     * @param {LaserManager} laserManager
     */
    setLaserManager(laserManager) {
        this.laserManager = laserManager;
        // Initialiser le panneau d'inspection laser
        this._laserInspectorPanel = new LaserInspectorPanel({
            laserManager,
            ambiancePanel: this
        });
        // Reconstruire le GUI pour afficher la section Laser
        this._buildGui();
    }

    /**
     * Injecte le StrobeManager et initialise le panneau d'inspection stroboscope.
     * @param {import('../strobe/StrobeManager.js').StrobeManager} strobeManager
     */
    setStrobeManager(strobeManager) {
        this.strobeManager = strobeManager;
        // Toute création / modification / suppression de stroboscope est envoyée aux autres joueurs
        strobeManager.setSyncEmitter(payload => this._emitSync(payload));
        this._strobeInspectorPanel = new StrobeInspectorPanel({
            strobeManager,
            ambiancePanel: this
        });
        this._buildGui();
    }

    /**
     * Injecte le panneau du brouillard de salle (bouton dans le menu Ambiance)
     * @param {import('../haze/ui/HazePanel.js').HazePanel} hazePanel
     */
    setHazePanel(hazePanel) {
        this.hazePanel = hazePanel;
        this._buildGui();
    }

    /**
     * Injecte le SpotManager (lyres Spot) et initialise son panneau d'inspection.
     * @param {import('../spot/SpotManager.js').SpotManager} spotManager
     */
    setSpotManager(spotManager) {
        this.spotManager = spotManager;
        this._spotInspectorPanel = new SpotInspectorPanel({
            spotManager,
            ambiancePanel: this
        });
        this._buildGui();
    }

    /**
     * Injecte le système d'Illumination Globale Statique
     * @param {object} staticGI
     */
    setStaticGI(staticGI) {
        this.staticGI = staticGI;
        this._buildGui();
    }

    // ─── 1. TransformControls (Gizmo 3D) ──────────────────────────────
    _initTransformControls() {
        this.transformControls = new TransformControls(this.camera, this.renderer.domElement);
        this.transformControls.size = 0.85;
        this.transformControls.setMode('translate');

        this._dragEndTime = 0;
        this._isSwitchingLight = false;

        // Éviter tout conflit avec la caméra / listener pendant le glissement du gizmo
        this.transformControls.addEventListener('dragging-changed', (event) => {
            this.isDraggingGizmo = event.value;

            // Indiquer au boîtier laser qu'il est en cours de manipulation (pour ne pas écraser sa rotation dans la render loop)
            if (this.selectedLaser && this.selectedLaser.pod && this.selectedLaser.pod.housing) {
                this.selectedLaser.pod.housing.isBeingDragged = Boolean(event.value);
            }

            if (!event.value) {
                this._dragEndTime = performance.now();
                if (this.selectedEntry) {
                    this._syncLightRotationFromTarget(this.selectedEntry);
                    const entry = this.selectedEntry;
                    const finalData = {
                        position: { x: entry.light.position.x, y: entry.light.position.y, z: entry.light.position.z },
                        rotation: { x: entry.light.rotation.x, y: entry.light.rotation.y, z: entry.light.rotation.z },
                    };
                    if (entry.light.target) {
                        finalData.target = { x: entry.light.target.position.x, y: entry.light.target.position.y, z: entry.light.target.position.z };
                    }
                    this._emitSync({
                        category: 'light_update',
                        id: entry.id,
                        data: finalData,
                        immediate: true,
                    });
                } else if (this.selectedSpot) {
                    this.selectedSpot.isBeingDragged = false;
                    this._emitSync({
                        category: 'spot_update',
                        id: this.selectedSpot.id,
                        data: this.selectedSpot.getPlacement(),
                        immediate: true,
                    });
                } else if (this.selectedLaser) {
                    const housing = this.selectedLaser.getHousingGroup();
                    const pos = housing ? housing.position : this.selectedLaser.getPosition();
                    this._emitSync({
                        category: 'laser_transform',
                        id: this.selectedLaser.laserId,
                        data: {
                            position: { x: pos.x, y: pos.y, z: pos.z },
                            rotation: {
                                angle: this.selectedLaser.params.angle || 0,
                                tilt: this.selectedLaser.params.tilt || 0,
                                roll: this.selectedLaser.params.roll || 0,
                            }
                        },
                        immediate: true,
                    });
                }
            } else {
                if (this.selectedEntry && this.selectedEntry.light && this.selectedEntry.light.target) {
                    this._currentLightDist = Math.max(1.0, this.selectedEntry.light.position.distanceTo(this.selectedEntry.light.target.position));
                }
            }
            if (this.listener) {
                if (event.value) {
                    this.listener.resetMovement();
                    this.listener.controls.enabled = false;
                } else {
                    this.listener.controls.enabled = true;
                }
            }
        });

        // Quand le gizmo déplace ou pivote la lumière ou sa cible, synchroniser les repères et l'UI
        this.transformControls.addEventListener('change', () => {
            if (this._isSwitchingLight) return;

            // ── Cas 1 : Gizmo attaché à un Laser ──
            if (this.selectedLaser && this.transformControls.object === this.selectedLaser.getHousingGroup()) {
                if (!this.isDraggingGizmo) return;
                const housing = this.selectedLaser.getHousingGroup();
                const mode = this.transformControls.getMode();

                if (mode === 'translate') {
                    const pos = housing.position;
                    this.selectedLaser.setPosition(pos.x, pos.y, pos.z);
                    if (this._laserPosControllers) {
                        this._laserPosControllers.posState.x = pos.x;
                        this._laserPosControllers.posState.y = pos.y;
                        this._laserPosControllers.posState.z = pos.z;
                        try {
                            this._laserPosControllers.posX.updateDisplay();
                            this._laserPosControllers.posY.updateDisplay();
                            this._laserPosControllers.posZ.updateDisplay();
                        } catch (_) {}
                    }
                } else if (mode === 'rotate') {
                    const euler = new THREE.Euler().setFromQuaternion(housing.quaternion, 'YXZ');
                    const yaw = Math.round(THREE.MathUtils.radToDeg(euler.y));
                    const pitchDeg = Math.round(THREE.MathUtils.radToDeg(-euler.x));
                    const rollDeg = Math.round(THREE.MathUtils.radToDeg(euler.z));

                    this.selectedLaser.setParam('angle', yaw);
                    this.selectedLaser.setParam('tilt', pitchDeg);
                    this.selectedLaser.setParam('roll', rollDeg);

                    if (this._laserRotControllers) {
                        this._laserRotControllers.rotState.angle = yaw;
                        this._laserRotControllers.rotState.tilt = pitchDeg;
                        this._laserRotControllers.rotState.roll = rollDeg;
                        try {
                            this._laserRotControllers.ctrlAngle.updateDisplay();
                            this._laserRotControllers.ctrlTilt.updateDisplay();
                            if (this._laserRotControllers.ctrlRoll) this._laserRotControllers.ctrlRoll.updateDisplay();
                        } catch (_) {}
                    }
                }

                if (this._laserInspectorPanel) {
                    this._laserInspectorPanel.syncFromLaser();
                }

                const pos = housing.position;
                this._emitSync({
                    category: 'laser_transform',
                    id: this.selectedLaser.laserId,
                    data: {
                        position: { x: pos.x, y: pos.y, z: pos.z },
                        rotation: {
                            angle: this.selectedLaser.params.angle || 0,
                            tilt: this.selectedLaser.params.tilt || 0,
                            roll: this.selectedLaser.params.roll || 0
                        }
                    }
                });
                return;
            }

            // ── Cas 4 : Gizmo attaché à une lyre Spot ──
            if (this.selectedSpot && this.transformControls.object === this.selectedSpot.group) {
                if (!this.isDraggingGizmo) return;
                const spot = this.selectedSpot;
                spot.isBeingDragged = true;
                spot.syncFromGizmo();
                if (this._spotInspectorPanel && this._spotInspectorPanel.isOpen) {
                    this._spotInspectorPanel.syncFromSpot();
                }
                this._emitSync({ category: 'spot_update', id: spot.id, data: spot.getPlacement() });
                return;
            }

            // ── Cas 3 : Gizmo attaché à un Stroboscope ──
            if (this.selectedStrobe && this.transformControls.object === this.selectedStrobe.group) {
                if (!this.isDraggingGizmo) return;
                const mode = this.transformControls.getMode();
                if (mode === 'translate') {
                    this.selectedStrobe.syncPositionFromGizmo();
                } else if (mode === 'rotate') {
                    this.selectedStrobe.syncRotationFromGizmo();
                }
                if (this._strobeInspectorPanel) {
                    this._strobeInspectorPanel.syncFromStrobe();
                }
                return;
            }

            // ── Cas 2 : Lumière classique ──
            if (!this.selectedEntry) return;

            const entry = this.selectedEntry;
            const mode = this.transformControls.getMode();

            if (this.transformControls.object === entry.light) {
                if (entry.markerMesh) {
                    entry.markerMesh.position.copy(entry.light.position);
                    entry.markerMesh.quaternion.copy(entry.light.quaternion);
                }

                if (mode === 'rotate') {
                    // Si on pivote une lumière avec cible (SpotLight ou DirectionalLight),
                    // orienter la cible pour qu'elle suive la rotation 3D de la lampe !
                    if (entry.light.target) {
                        const newDir = new THREE.Vector3(0, 0, -1).applyQuaternion(entry.light.quaternion).normalize();
                        const dist = this._currentLightDist || Math.max(2.0, entry.light.position.distanceTo(entry.light.target.position));
                        entry.light.target.position.copy(entry.light.position).addScaledVector(newDir, dist);
                        entry.light.target.updateMatrixWorld();
                        this._syncGuiTarget();
                    }
                } else {
                    // En translation, maintenir le quaternion de la lampe aligné vers la cible
                    this._syncLightRotationFromTarget(entry);
                }

                if (entry.helper && entry.helper.update) {
                    entry.helper.update();
                }
                this._syncGuiPosition();
            } else if (entry.light.target && this.transformControls.object === entry.light.target) {
                entry.light.target.updateMatrixWorld();
                this._syncLightRotationFromTarget(entry);
                if (entry.helper && entry.helper.update) {
                    entry.helper.update();
                }
                this._syncGuiTarget();
            }

            this._emitSync({
                category: 'light_update',
                id: entry.id,
                data: {
                    position: { x: entry.light.position.x, y: entry.light.position.y, z: entry.light.position.z },
                    target: entry.light.target ? { x: entry.light.target.position.x, y: entry.light.target.position.y, z: entry.light.target.position.z } : null,
                    rotation: { x: entry.light.rotation.x, y: entry.light.rotation.y, z: entry.light.rotation.z }
                }
            });
        });

        // Cacher le gizmo par défaut
        this.transformControls.enabled = false;
        this.transformControls.visible = false;
        this.scene.add(this.transformControls);
    }

    _syncLightRotationFromTarget(entry) {
        if (!entry || !entry.light || !entry.light.target) return;
        const origin = entry.light.position;
        const targetPos = entry.light.target.position;
        const dir = new THREE.Vector3().subVectors(targetPos, origin);
        if (dir.length() > 0.001) {
            dir.normalize();
            entry.light.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), dir);
            if (entry.markerMesh) {
                entry.markerMesh.quaternion.copy(entry.light.quaternion);
            }
        }
    }

    setGizmoMode(mode) {
        if (mode !== 'translate' && mode !== 'rotate') return;
        this.transformControls.setMode(mode);

        if (this.selectedEntry) {
            // Pour pivoter la visée d'un spot, le gizmo doit être attaché à la lampe
            if (mode === 'rotate' && this._gizmoTargetMode === 'target') {
                this._gizmoTargetMode = 'lamp';
                this._attachGizmoToCurrentTarget();
            }
            this._syncLightRotationFromTarget(this.selectedEntry);
        }

        if (this._cGizmoMode && this._cGizmoMode.getValue() !== mode) {
            this._cGizmoMode.setValue(mode);
        }

        if (this._laserInspectorPanel && this._laserInspectorPanel.controllers.gizmoMode) {
            if (this._laserInspectorPanel.controllers.gizmoMode.getValue() !== mode) {
                this._laserInspectorPanel.controllers.gizmoMode.setValue(mode);
            }
        }
    }

    // ─── 1b. Environnement Céleste (23 Ambiances & Voûte Étoilée Dynamique) ─
    _initEnvironment() {
        this.envPresets = {
            // ════════════════════════════════════════════════════════════
            // ☀️ CATÉGORIE 1 : PLEIN JOUR (6 ambiances)
            // ════════════════════════════════════════════════════════════
            day: {
                name: '☀️ Plein Jour (Standard)',
                hasStars: false,
                skyboxColor: '#ffffff',
                fogColor: 0x87ceeb,
                fogNear: 150,
                fogFar: 400,
                ambient: { color: '#98ddbc', intensity: 0.1, enabled: true },
                hemi: { skyColor: '#87ceeb', groundColor: '#4a7a2a', intensity: 1.0, enabled: true },
                dir: { color: '#fff5e0', intensity: 3.0, shadowMapSize: 2048, enabled: true },
                stage1: { color: '#ff3366', intensity: 0.5, distance: 30 },
                stage2: { color: '#3366ff', intensity: 0.5, distance: 30 },
            },
            day_zenith: {
                name: '☀️ Zénith Méditerranéen',
                hasStars: false,
                skyboxColor: '#ffffff',
                fogColor: 0x90d2f0,
                fogNear: 160,
                fogFar: 440,
                ambient: { color: '#a2ccf0', intensity: 0.345 },
                hemi: { skyColor: '#8ec5f5', groundColor: '#4a8228', intensity: 1.755 },
                dir: { color: '#fffdf0', intensity: 2.1 },
                stage1: { color: '#ff3366', intensity: 0.4, distance: 28 },
                stage2: { color: '#3366ff', intensity: 0.4, distance: 28 },
            },
            day_tropical: {
                name: '🌴 Soleil Tropical Intense',
                hasStars: false,
                skyboxColor: '#f7fbff',
                fogColor: 0x7eccdf,
                fogNear: 140,
                fogFar: 410,
                ambient: { color: '#9ee0db', intensity: 0.33 },
                hemi: { skyColor: '#72d2e8', groundColor: '#528522', intensity: 1.67 },
                dir: { color: '#fff4cc', intensity: 2.3 },
                stage1: { color: '#ff0066', intensity: 0.45, distance: 30 },
                stage2: { color: '#00d4ff', intensity: 0.45, distance: 30 },
            },
            day_overcast: {
                name: '☁️ Ciel Voilé Scandinave',
                hasStars: false,
                skyboxColor: '#d6dde3',
                fogColor: 0xc4ccd4,
                fogNear: 110,
                fogFar: 330,
                ambient: { color: '#b0b8c2', intensity: 0.375 },
                hemi: { skyColor: '#c0c8d2', groundColor: '#4a5442', intensity: 1.725 },
                dir: { color: '#f0f4f8', intensity: 1.1 },
                stage1: { color: '#ff5577', intensity: 0.6, distance: 30 },
                stage2: { color: '#55aaff', intensity: 0.6, distance: 30 },
            },
            day_spring: {
                name: '🌸 Matinée Printanière',
                hasStars: false,
                skyboxColor: '#fcfaff',
                fogColor: 0xaad4f5,
                fogNear: 135,
                fogFar: 390,
                ambient: { color: '#b5d5ed', intensity: 0.315 },
                hemi: { skyColor: '#9ecbf0', groundColor: '#4f802e', intensity: 1.585 },
                dir: { color: '#fff9ea', intensity: 1.7 },
                stage1: { color: '#ff4081', intensity: 0.5, distance: 30 },
                stage2: { color: '#00e5ff', intensity: 0.5, distance: 30 },
            },
            day_desert_haze: {
                name: '🏜️ Mirage & Brume Déserte',
                hasStars: false,
                skyboxColor: '#fff9ed',
                fogColor: 0xdfcbaf,
                fogNear: 120,
                fogFar: 350,
                ambient: { color: '#d8c29d', intensity: 0.33 },
                hemi: { skyColor: '#e0c99f', groundColor: '#705428', intensity: 1.62 },
                dir: { color: '#fff1d0', intensity: 2.2 },
                stage1: { color: '#ff2200', intensity: 0.5, distance: 30 },
                stage2: { color: '#2255ff', intensity: 0.5, distance: 30 },
            },

            // ════════════════════════════════════════════════════════════
            // 🌇 CATÉGORIE 2 : FIN DE JOURNÉE / GOLDEN HOUR (5 ambiances)
            // ════════════════════════════════════════════════════════════
            golden_california: {
                name: '🌇 Golden Hour Californienne',
                hasStars: false,
                skyboxColor: '#f7a840',
                fogColor: 0xb56525,
                fogNear: 130,
                fogFar: 390,
                ambient: { color: '#7a4218', intensity: 0.225 },
                hemi: { skyColor: '#9e521b', groundColor: '#2b1507', intensity: 1.225 },
                dir: { color: '#ffaa33', intensity: 1.85 },
                stage1: { color: '#ff0055', intensity: 1.4, distance: 35 },
                stage2: { color: '#0099ff', intensity: 1.4, distance: 35 },
            },
            golden_copper: {
                name: '🥉 Couchant Cuivré Ocre',
                hasStars: false,
                skyboxColor: '#d6682b',
                fogColor: 0x8a3814,
                fogNear: 120,
                fogFar: 370,
                ambient: { color: '#662d14', intensity: 0.21 },
                hemi: { skyColor: '#8a3c18', groundColor: '#240d05', intensity: 1.14 },
                dir: { color: '#ff7722', intensity: 1.6 },
                stage1: { color: '#ff2266', intensity: 1.6, distance: 35 },
                stage2: { color: '#2266ff', intensity: 1.6, distance: 35 },
            },
            golden_peach: {
                name: '🍑 Horizon Pêche & Améthyste',
                hasStars: false,
                skyboxColor: '#d98282',
                fogColor: 0x824968,
                fogNear: 125,
                fogFar: 380,
                ambient: { color: '#593246', intensity: 0.195 },
                hemi: { skyColor: '#78405b', groundColor: '#1f1019', intensity: 1.105 },
                dir: { color: '#ff9e80', intensity: 1.45 },
                stage1: { color: '#e040fb', intensity: 1.6, distance: 35 },
                stage2: { color: '#00e5ff', intensity: 1.6, distance: 35 },
            },
            golden_vintage: {
                name: '🎞️ Rétro Vintage 70s',
                hasStars: false,
                skyboxColor: '#e09838',
                fogColor: 0x8c521a,
                fogNear: 115,
                fogFar: 360,
                ambient: { color: '#5c3614', intensity: 0.21 },
                hemi: { skyColor: '#784618', groundColor: '#261405', intensity: 1.14 },
                dir: { color: '#ffb347', intensity: 1.7 },
                stage1: { color: '#d00000', intensity: 1.5, distance: 35 },
                stage2: { color: '#03045e', intensity: 1.5, distance: 35 },
            },
            golden_festival: {
                name: '🔥 Coucher Torride Festival',
                hasStars: false,
                skyboxColor: '#e64a19',
                fogColor: 0x8c2106,
                fogNear: 110,
                fogFar: 350,
                ambient: { color: '#611a09', intensity: 0.225 },
                hemi: { skyColor: '#8a240c', groundColor: '#210702', intensity: 1.225 },
                dir: { color: '#ff5722', intensity: 1.9 },
                stage1: { color: '#ff0077', intensity: 1.8, distance: 36 },
                stage2: { color: '#00d2ff', intensity: 1.8, distance: 36 },
            },

            // ════════════════════════════════════════════════════════════
            // 🌅 CATÉGORIE 3 : CRÉPUSCULE (6 ambiances)
            // ════════════════════════════════════════════════════════════
            sunset: {
                name: '🌅 Crépuscule (Standard)',
                hasStars: true,
                skyboxColor: '#d9653b',
                fogColor: 0x4a2430,
                fogNear: 125,
                fogFar: 380,
                ambient: { color: '#4a2b38', intensity: 0.15 },
                hemi: { skyColor: '#b34d3d', groundColor: '#221318', intensity: 0.85 },
                dir: { color: '#ff7733', intensity: 1.2 },
                stage1: { color: '#ff2255', intensity: 1.6, distance: 35 },
                stage2: { color: '#3355ee', intensity: 1.6, distance: 35 },
            },
            sunset_blue_hour: {
                name: '🌌 Heure Bleue Crépusculaire',
                hasStars: true,
                skyboxColor: '#0b1b3d',
                fogColor: 0x0d1e44,
                fogNear: 110,
                fogFar: 370,
                ambient: { color: '#162b55', intensity: 0.135 },
                hemi: { skyColor: '#1c366a', groundColor: '#081122', intensity: 0.765 },
                dir: { color: '#4488ee', intensity: 0.8 },
                stage1: { color: '#ff3366', intensity: 2.2, distance: 38 },
                stage2: { color: '#00ffcc', intensity: 2.2, distance: 38 },
            },
            sunset_carmine: {
                name: '🍷 Crépuscule Carmin Sanglant',
                hasStars: true,
                skyboxColor: '#45101a',
                fogColor: 0x3d0d17,
                fogNear: 100,
                fogFar: 350,
                ambient: { color: '#42161f', intensity: 0.15 },
                hemi: { skyColor: '#5c1b27', groundColor: '#17060a', intensity: 0.85 },
                dir: { color: '#ff3344', intensity: 1.1 },
                stage1: { color: '#ff8800', intensity: 2.4, distance: 40 },
                stage2: { color: '#ff0055', intensity: 2.4, distance: 40 },
            },
            sunset_synthwave: {
                name: '🌴 Synthwave 80s Outrun',
                hasStars: true,
                skyboxColor: '#541548',
                fogColor: 0x48113e,
                fogNear: 105,
                fogFar: 360,
                ambient: { color: '#42173a', intensity: 0.165 },
                hemi: { skyColor: '#6e1d5e', groundColor: '#1a0717', intensity: 0.935 },
                dir: { color: '#ff2299', intensity: 1.2 },
                stage1: { color: '#ff00a0', intensity: 2.7, distance: 42 },
                stage2: { color: '#00f5d4', intensity: 2.7, distance: 42 },
            },
            sunset_sahara: {
                name: '🏜️ Crépuscule Saharien',
                hasStars: true,
                skyboxColor: '#6e3814',
                fogColor: 0x5a2d10,
                fogNear: 95,
                fogFar: 340,
                ambient: { color: '#542d13', intensity: 0.15 },
                hemi: { skyColor: '#783e18', groundColor: '#211005', intensity: 0.85 },
                dir: { color: '#ff9933', intensity: 1.25 },
                stage1: { color: '#ff4400', intensity: 2.3, distance: 38 },
                stage2: { color: '#ffcc00', intensity: 2.3, distance: 38 },
            },
            sunset_autumn: {
                name: '🍂 Crépuscule d\'Automne',
                hasStars: true,
                skyboxColor: '#3b232e',
                fogColor: 0x331c27,
                fogNear: 85,
                fogFar: 310,
                ambient: { color: '#38222c', intensity: 0.135 },
                hemi: { skyColor: '#4d2d3c', groundColor: '#140c10', intensity: 0.765 },
                dir: { color: '#e88866', intensity: 1.0 },
                stage1: { color: '#e63946', intensity: 2.2, distance: 36 },
                stage2: { color: '#457b9d', intensity: 2.2, distance: 36 },
            },

            // ════════════════════════════════════════════════════════════
            // 🌙 CATÉGORIE 4 : NUIT NOIRE (6 ambiances)
            // ════════════════════════════════════════════════════════════
            night: {
                name: '🌙 Nuit (Standard)',
                hasStars: true,
                skyboxColor: '#050814',
                fogColor: 0x050814,
                fogNear: 110,
                fogFar: 360,
                ambient: { color: '#141d2e', intensity: 0.075 },
                hemi: { skyColor: '#0e1626', groundColor: '#070a10', intensity: 0.375 },
                dir: { color: '#7ba7e8', intensity: 0.45 },
                stage1: { color: '#ff1166', intensity: 2.8, distance: 45 },
                stage2: { color: '#00ccff', intensity: 2.8, distance: 45 },
            },
            night_deep: {
                name: '🌌 Nuit Noire d\'Encre (Atacama)',
                hasStars: true,
                skyboxColor: '#020308',
                fogColor: 0x020308,
                fogNear: 120,
                fogFar: 380,
                ambient: { color: '#090d18', intensity: 0.045 },
                hemi: { skyColor: '#0b1122', groundColor: '#030508', intensity: 0.255 },
                dir: { color: '#6888c0', intensity: 0.3 },
                stage1: { color: '#ff0055', intensity: 3.2, distance: 48 },
                stage2: { color: '#00e5ff', intensity: 3.2, distance: 48 },
            },
            night_aurora: {
                name: '🌠 Nuit Polaire (Aurore Boréale)',
                hasStars: true,
                skyboxColor: '#04161c',
                fogColor: 0x031418,
                fogNear: 90,
                fogFar: 340,
                ambient: { color: '#08252a', intensity: 0.09 },
                hemi: { skyColor: '#093a38', groundColor: '#030d0d', intensity: 0.56 },
                dir: { color: '#44ffcc', intensity: 0.55 },
                stage1: { color: '#00ffaa', intensity: 3.0, distance: 45 },
                stage2: { color: '#aa00ff', intensity: 3.0, distance: 45 },
            },
            night_moon: {
                name: '🌕 Pleine Lune d\'Argent',
                hasStars: true,
                skyboxColor: '#060a18',
                fogColor: 0x070c1e,
                fogNear: 130,
                fogFar: 420,
                ambient: { color: '#162238', intensity: 0.105 },
                hemi: { skyColor: '#1d2e4d', groundColor: '#09101c', intensity: 0.595 },
                dir: { color: '#b8d5ff', intensity: 0.85 },
                stage1: { color: '#ff3388', intensity: 2.6, distance: 42 },
                stage2: { color: '#3388ff', intensity: 2.6, distance: 42 },
            },
            night_cyber: {
                name: '⚡ Nuit Cyberpunk Néon',
                hasStars: true,
                skyboxColor: '#0a0518',
                fogColor: 0x0c061e,
                fogNear: 80,
                fogFar: 320,
                ambient: { color: '#250f38', intensity: 0.12 },
                hemi: { skyColor: '#3d1252', groundColor: '#07020d', intensity: 0.68 },
                dir: { color: '#ff00aa', intensity: 0.6 },
                stage1: { color: '#ff0077', intensity: 3.5, distance: 50 },
                stage2: { color: '#00f0ff', intensity: 3.5, distance: 50 },
            },
            night_storm: {
                name: '🌩️ Nuit d\'Orage Électrique',
                hasStars: true,
                skyboxColor: '#080812',
                fogColor: 0x080914,
                fogNear: 70,
                fogFar: 280,
                ambient: { color: '#141428', intensity: 0.075 },
                hemi: { skyColor: '#1e1c3a', groundColor: '#05050a', intensity: 0.425 },
                dir: { color: '#9d88ff', intensity: 0.7 },
                stage1: { color: '#ffea00', intensity: 3.4, distance: 48 },
                stage2: { color: '#7700ff', intensity: 3.4, distance: 48 },
            },
        };

        this.envState = {
            presetKey: 'day',
            stars: true, // affichées automatiquement dès qu'une ambiance de nuit en prévoit (hasStars)
            starSize: 0.5,
            starCount: 12000,
            starBrightness: 3.0,
            stageBoost: 1.0,
        };

        this._isApplyingEnvPreset = false;
        this.starfield = this._createStarfield();
        this.applyEnvPreset('day');
    }

    _createStarfield() {
        const group = new THREE.Group();
        group.name = 'ambiance-starfield';
        group.renderOrder = -1;
        group.visible = false;
        group.frustumCulled = false;

        const baseColors = [
            new THREE.Color('#ffffff'), // Blanc pur
            new THREE.Color('#e0ecff'), // Blanc bleuté éclatant
            new THREE.Color('#fff4e0'), // Blanc chaud / doré
            new THREE.Color('#8ac5ff'), // Étoile bleue vive
            new THREE.Color('#ffd28a'), // Étoile ambrée
            new THREE.Color('#cce4ff'), // Blanc arctique
        ];

        const radius = 860;
        const maxRegular = 12000;
        const maxBright = 2000;

        const buildPointsLayer = (maxCount, size, opacity, isProminent) => {
            const geometry = new THREE.BufferGeometry();
            const positions = new Float32Array(maxCount * 3);
            const colors = new Float32Array(maxCount * 3);
            const baseColorsArr = new Float32Array(maxCount * 3);

            for (let i = 0; i < maxCount; i++) {
                const theta = Math.random() * Math.PI * 2;
                let cosPhi;
                if (Math.random() < 0.82) {
                    cosPhi = -0.25 + Math.random() * 1.25;
                } else {
                    cosPhi = -1.0 + Math.random() * 0.75;
                }

                const sinPhi = Math.sqrt(Math.max(0, 1 - cosPhi * cosPhi));
                const x = radius * sinPhi * Math.cos(theta);
                const y = radius * cosPhi;
                const z = radius * sinPhi * Math.sin(theta);

                positions[i * 3] = x;
                positions[i * 3 + 1] = y;
                positions[i * 3 + 2] = z;

                const col = baseColors[Math.floor(Math.random() * baseColors.length)];
                let brightness;
                if (isProminent) {
                    brightness = 0.80 + Math.random() * 0.20;
                } else {
                    brightness = 0.35 + Math.pow(Math.random(), 2.0) * 0.65;
                }

                const r = col.r * brightness;
                const g = col.g * brightness;
                const b = col.b * brightness;

                colors[i * 3] = r;
                colors[i * 3 + 1] = g;
                colors[i * 3 + 2] = b;

                baseColorsArr[i * 3] = r;
                baseColorsArr[i * 3 + 1] = g;
                baseColorsArr[i * 3 + 2] = b;
            }

            geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

            const material = new THREE.PointsMaterial({
                size,
                vertexColors: true,
                transparent: true,
                opacity,
                depthWrite: false,
                depthTest: true,
                fog: false,
                sizeAttenuation: false,
            });

            const points = new THREE.Points(geometry, material);
            points.frustumCulled = false;
            points.renderOrder = -1;
            return { points, baseColorsArr };
        };

        const regData = buildPointsLayer(maxRegular, this.envState.starSize, 0.95, false);
        this._starRegular = regData.points;
        this._starBaseColorsReg = regData.baseColorsArr;
        group.add(this._starRegular);

        const brightData = buildPointsLayer(maxBright, this.envState.starSize * 1.65, 1.0, true);
        this._starBright = brightData.points;
        this._starBaseColorsBright = brightData.baseColorsArr;
        group.add(this._starBright);

        // Appliquer la configuration d'étoiles initiale
        this.setStarCount(this.envState.starCount);
        this.setStarBrightness(this.envState.starBrightness);

        if (this.camera) {
            group.position.copy(this.camera.position);
        }

        this.scene.add(group);
        return group;
    }

    setStarCount(count) {
        this.envState.starCount = count;
        if (!this._starRegular || !this._starBright) return;
        const regCount = Math.round(count * 0.88);
        const brtCount = Math.round(count * 0.12);
        this._starRegular.geometry.setDrawRange(0, regCount);
        this._starBright.geometry.setDrawRange(0, brtCount);
    }

    setStarSize(size) {
        this.envState.starSize = size;
        if (this._starRegular) this._starRegular.material.size = size;
        if (this._starBright) this._starBright.material.size = size * 1.65;
    }

    setStarBrightness(brightness) {
        this.envState.starBrightness = brightness;
        if (!this._starRegular || !this._starBright) return;

        const opacityFactor = Math.min(1.0, brightness);
        this._starRegular.material.opacity = 0.95 * opacityFactor;
        this._starBright.material.opacity = 1.0 * opacityFactor;

        const mult = Math.max(0.1, brightness);
        this._applyColorBrightness(this._starRegular, this._starBaseColorsReg, mult);
        this._applyColorBrightness(this._starBright, this._starBaseColorsBright, mult);
    }

    _applyColorBrightness(mesh, baseColors, mult) {
        if (!mesh || !mesh.geometry || !baseColors) return;
        const attr = mesh.geometry.attributes.color;
        if (!attr || !attr.array) return;
        const arr = attr.array;
        const len = arr.length;
        for (let i = 0; i < len; i++) {
            arr[i] = Math.min(1.0, baseColors[i] * mult);
        }
        attr.needsUpdate = true;
    }

    _updateStarsVisibility() {
        if (!this.starfield) return;
        const preset = this.envPresets[this.envState.presetKey] || this.envPresets.day;
        this.starfield.visible = Boolean(this.envState.stars && preset.hasStars);
    }

    setSkybox(skybox) {
        this.skybox = skybox;
        if (this.skybox) {
            this.skybox.renderOrder = -2;
        }
        if (this.skybox && this.envState && this.envState.presetKey !== 'day') {
            const preset = this.envPresets[this.envState.presetKey];
            if (preset) this._tintSkybox(preset.skyboxColor);
        }
    }

    _tintSkybox(colorHex) {
        if (!this.skybox) return;
        this.skybox.traverse((child) => {
            if (child.isMesh && child.material) {
                if (Array.isArray(child.material)) {
                    child.material.forEach(m => {
                        if (m && m.color) m.color.set(colorHex);
                    });
                } else if (child.material.color) {
                    child.material.color.set(colorHex);
                }
            }
        });
    }

    applyEnvPreset(key, isReset = false) {
        if (this._isApplyingEnvPreset) return;
        this._isApplyingEnvPreset = true;

        try {
            const preset = this.envPresets[key];
            if (!preset) return;

            this.envState.presetKey = key;

            // Synchroniser l'affichage du menu déroulant
            if (this._cPreset) this._cPreset.updateDisplay();

            // 1. Teinte de la Skybox
            if (this.skybox) {
                this._tintSkybox(preset.skyboxColor);
            }

            // 2. Couleur du brouillard atmosphérique & fond de scène
            if (this.scene.fog) {
                this.scene.fog.color.set(preset.fogColor);
                if (preset.fogNear) this.scene.fog.near = preset.fogNear;
                if (preset.fogFar) this.scene.fog.far = preset.fogFar;
            }
            if (this.scene.background && this.scene.background.isColor) {
                this.scene.background.set(preset.fogColor);
            }

            // 2b. Brouillard de salle : légère coloration selon la couleur du ciel de l'ambiance
            if (this.hazeVolume && typeof this.hazeVolume.setEnvTint === 'function') {
                this.hazeVolume.setEnvTint(this._hazeTintForPreset(preset));
            }

            // 3. Affichage du ciel étoilé
            this._updateStarsVisibility();

            // 4. Adaptation des lumières intégrées
            this._applyPresetToLights(preset);

            // 5. Synchronisation de la GI Statique (0 lag) adaptée à l'ambiance
            if (this.staticGI && typeof this.staticGI.syncWithEnvPreset === 'function') {
                this.staticGI.syncWithEnvPreset(preset, key);
            }

            // 6. Rafraîchir l'affichage des contrôleurs du dossier GI
            if (this.fGI && this.fGI.controllers) {
                this.fGI.controllers.forEach(c => {
                    try { c.updateDisplay(); } catch (_) {}
                });
            }

            if (!isReset) {
                this._emitSync({
                    category: 'env',
                    data: { presetKey: key }
                });
            }
        } finally {
            this._isApplyingEnvPreset = false;
        }
    }

    /**
     * Teinte du brouillard pour une ambiance : rapport de couleur (teinte seule, luminosité conservée)
     * entre le ciel de l'ambiance et celui du jour par défaut, appliqué à HAZE_ENV_TINT_STRENGTH.
     * Ambiance jour → blanc (aucun changement).
     */
    _hazeTintForPreset(preset) {
        const HAZE_ENV_TINT_STRENGTH = 0.35;
        const day = this.envPresets.day;
        const skyOf = (p) => new THREE.Color((p && p.hemi && p.hemi.skyColor) || (p && p.fogColor) || 0xffffff);
        const norm = (c) => { const m = Math.max(c.r, c.g, c.b, 1e-4); return c.multiplyScalar(1 / m); };
        const cur = norm(skyOf(preset));
        const ref = norm(skyOf(day));
        const ratio = new THREE.Color(
            cur.r / Math.max(ref.r, 1e-3),
            cur.g / Math.max(ref.g, 1e-3),
            cur.b / Math.max(ref.b, 1e-3)
        );
        // Conserver la luminance (seule la teinte change), puis borner
        const lum = 0.2126 * ratio.r + 0.7152 * ratio.g + 0.0722 * ratio.b;
        if (lum > 1e-4) ratio.multiplyScalar(1 / lum);
        ratio.r = Math.min(1.8, Math.max(0.3, ratio.r));
        ratio.g = Math.min(1.8, Math.max(0.3, ratio.g));
        ratio.b = Math.min(1.8, Math.max(0.3, ratio.b));
        return new THREE.Color(1, 1, 1).lerp(ratio, HAZE_ENV_TINT_STRENGTH);
    }

    _updateStageBoost() {
        const preset = this.envPresets[this.envState.presetKey] || this.envPresets.day;
        this.lights.forEach(entry => {
            if (!entry.isBuiltin) return;
            const name = entry.name || '';
            if (name.includes('Gauche') || name.includes('stageLight1')) {
                entry.light.intensity = preset.stage1.intensity * this.envState.stageBoost;
                entry.defaultConfig = this.getDefaultConfigForEntry(entry);
            } else if (name.includes('Droit') || name.includes('stageLight2')) {
                entry.light.intensity = preset.stage2.intensity * this.envState.stageBoost;
                entry.defaultConfig = this.getDefaultConfigForEntry(entry);
            }
        });
        this._syncInspectorDisplays();
    }

    _applyPresetToLights(preset) {
        this.lights.forEach(entry => {
            if (!entry.isBuiltin) return;
            const light = entry.light;
            const name = entry.name || '';

            if (light.isAmbientLight || name.includes('Générale')) {
                light.color.set(preset.ambient.color);
                // Toujours visible (intensité ~0 si désactivée) : changer le nombre de lumières visibles
                // force Three.js à recompiler tous les shaders (gros freeze au premier changement d'ambiance)
                light.intensity = (preset.ambient.enabled !== false) ? Math.max(0.0001, preset.ambient.intensity) : 0.0001;
                light.visible = true;
            } else if (light.isHemisphereLight || name.includes('Ciel')) {
                light.color.set(preset.hemi.skyColor);
                if (light.groundColor) light.groundColor.set(preset.hemi.groundColor);
                light.intensity = (preset.hemi.enabled !== false) ? Math.max(0.0001, preset.hemi.intensity) : 0.0001;
                light.visible = true; // voir remarque ci-dessus : jamais de changement du nombre de lumières
            } else if (light.isDirectionalLight || name.includes('Soleil')) {
                light.color.set(preset.dir.color);
                // Laisser le soleil toujours visible et castShadow=true avec une intensité minimale non-nulle pour éviter toute recompilation de shaders PBR
                const targetIntensity = (preset.dir.enabled !== false) ? preset.dir.intensity : 0.0001;
                light.intensity = Math.max(0.0001, targetIntensity);
                light.visible = true;
                // Ne JAMAIS détruire/réallouer la shadow map 4096 si la taille est déjà identique ou non redéfinie (évite un freeze GPU de 300ms)
                if (preset.dir.shadowMapSize && light.shadow && light.shadow.mapSize) {
                    const sz = preset.dir.shadowMapSize;
                    if (light.shadow.mapSize.width !== sz) {
                        light.shadow.mapSize.set(sz, sz);
                        if (light.shadow.map) {
                            light.shadow.map.dispose();
                            light.shadow.map = null;
                        }
                    }
                }
            } else if (name.includes('Gauche') || name.includes('stageLight1')) {
                light.color.set(preset.stage1.color);
                light.intensity = preset.stage1.intensity * this.envState.stageBoost;
                if (preset.stage1.distance) light.distance = preset.stage1.distance;
            } else if (name.includes('Droit') || name.includes('stageLight2')) {
                light.color.set(preset.stage2.color);
                light.intensity = preset.stage2.intensity * this.envState.stageBoost;
                if (preset.stage2.distance) light.distance = preset.stage2.distance;
            }

            // Maintien de la configuration par défaut synchronisée avec le preset actuel
            entry.defaultConfig = this.getDefaultConfigForEntry(entry);

            // Mise à jour du repère visuel et de son helper
            if (entry.markerMesh) {
                const core = entry.markerMesh.children[0];
                if (core && core.material) {
                    core.material.color.copy(light.color);
                }
            }
            if (light.userData && light.userData.bulbMesh && light.userData.bulbMesh.material) {
                light.userData.bulbMesh.material.color.copy(light.color);
                light.userData.bulbMesh.position.copy(light.position);
                light.userData.bulbMesh.visible = light.visible;
            }
            if (entry.helper && entry.helper.update) {
                entry.helper.update();
            }
        });

        // Rafraîchir directement les valeurs des sliders et contrôleurs de l'inspecteur sans détruire tout le DOM GUI
        this._syncInspectorDisplays();
    }

    _syncInspectorDisplays() {
        if (!this.fInspector) return;
        if (this.selectedEntry && this.selectedEntry.light && this._inspectorProxies) {
            const light = this.selectedEntry.light;
            if (this._inspectorProxies.colorProxy && light.color) {
                this._inspectorProxies.colorProxy.col = '#' + light.color.getHexString();
            }
            if (this._inspectorProxies.groundProxy && light.groundColor) {
                this._inspectorProxies.groundProxy.groundCol = '#' + light.groundColor.getHexString();
            }
            if (this._inspectorProxies.angleProxy && light.angle !== undefined) {
                this._inspectorProxies.angleProxy.deg = THREE.MathUtils.radToDeg(light.angle);
            }
            if (this._inspectorProxies.shadowProxy && light.shadow && light.shadow.mapSize) {
                this._inspectorProxies.shadowProxy.mapSize = light.shadow.mapSize.width;
            }
        }
        const updateFolder = (folder) => {
            if (!folder) return;
            if (folder.controllers) {
                folder.controllers.forEach(c => {
                    try { c.updateDisplay(); } catch (_) {}
                });
            }
            if (folder.folders) {
                folder.folders.forEach(f => updateFolder(f));
            }
        };
        updateFolder(this.fInspector);
    }

    _getGIDefault(paramKey) {
        if (paramKey === 'enabled') return false;
        const key = this.envState?.presetKey || 'night_aurora';
        const p = GI_PRESETS[key] || GI_PRESETS.night_aurora;
        if (p && p[paramKey] !== undefined) return p[paramKey];
        return this.staticGI?.params?.[paramKey];
    }

    // ─── 2. Enregistrement des Lumières ──────────────────────────────
    _registerInitialLights() {
        // Enregistrer les lumières passées explicitement
        this.initialLights.forEach(light => {
            this.registerLight(light, true);
        });

        // Si aucune lumière passée, traverser la scène pour en trouver
        if (this.lights.length === 0) {
            this.scene.traverse(obj => {
                if (obj.isLight && !obj.userData?.isAmbianceInternal) {
                    this.registerLight(obj, true);
                }
            });
        }

        // Assigner la première lumière comme cible par défaut (sans afficher le gizmo tant que le menu n'est pas ouvert)
        if (this.lights.length > 0) {
            this.selectedEntry = this.lights[0];
            this.transformControls.detach();
            this.transformControls.visible = false;
            this.transformControls.enabled = false;
        }
    }

    /**
     * Enregistre une lumière dans le gestionnaire.
     * @param {THREE.Light} light
     * @param {boolean} [isBuiltin=false]
     * @param {string} [customName]
     */
    registerLight(light, isBuiltin = false, customName = null, customId = null) {
        if (!light || this.lights.some(e => e.light === light)) return;

        let type = 'PointLight';
        if (light.isSpotLight) type = 'SpotLight';
        else if (light.isDirectionalLight) type = 'DirectionalLight';
        else if (light.isAmbientLight) type = 'AmbientLight';
        else if (light.isHemisphereLight) type = 'HemisphereLight';
        else if (light.isRectAreaLight) type = 'RectAreaLight';

        const id = customId || ('light_' + (this._nextId++));
        if (typeof customId === 'string' && customId.startsWith('light_')) {
            const num = parseInt(customId.replace('light_', ''), 10);
            if (!isNaN(num) && this._nextId <= num) this._nextId = num + 1;
        }
        const name = customName || light.name || `${type} #${this.lights.length + 1}`;
        light.name = name;

        // Snapshot complet de la configuration par défaut pour le reset unitaire & global
        const defaultConfig = this._captureLightState(light, type);

        // Création du repère visuel 3D interactif (pour les lumières spatialisées)
        let markerMesh = null;
        let helper = null;

        if (type !== 'AmbientLight') {
            markerMesh = this._createLightMarker(light, type);
            markerMesh.userData = { isLightMarker: true, lightId: id };
            this.markersGroup.add(markerMesh);

            helper = this._createLightHelper(light, type);
            if (helper) this.helpersGroup.add(helper);
        }

        const entry = {
            id,
            name,
            light,
            type,
            isBuiltin,
            markerMesh,
            helper,
            defaultConfig,
            creationConfig: { ...defaultConfig },
        };

        this.lights.push(entry);
        return entry;
    }

    _captureLightState(light, type) {
        const state = {
            color: '#' + light.color.getHexString(),
            intensity: light.intensity,
            visible: light.visible,
            position: { x: light.position.x, y: light.position.y, z: light.position.z },
            castShadow: Boolean(light.castShadow),
        };

        if (light.shadow) {
            state.shadowMapSize = light.shadow.mapSize ? light.shadow.mapSize.width : 1024;
            state.shadowBias = light.shadow.bias || 0;
            state.shadowNormalBias = light.shadow.normalBias || 0;
        }

        if (type === 'SpotLight') {
            state.distance = light.distance;
            state.angle = THREE.MathUtils.radToDeg(light.angle);
            state.penumbra = light.penumbra;
            state.decay = light.decay;
            state.target = { x: light.target.position.x, y: light.target.position.y, z: light.target.position.z };
        } else if (type === 'PointLight') {
            state.distance = light.distance;
            state.decay = light.decay;
        } else if (type === 'HemisphereLight') {
            state.groundColor = '#' + light.groundColor.getHexString();
        } else if (type === 'RectAreaLight') {
            state.width = light.width;
            state.height = light.height;
        } else if (type === 'DirectionalLight' && light.target) {
            state.target = { x: light.target.position.x, y: light.target.position.y, z: light.target.position.z };
        }

        return state;
    }

    _createLightMarker(light, type) {
        const group = new THREE.Group();
        group.name = `marker_${light.name}`;
        group.userData.isAmbianceInternal = true;

        // Cœur sphérique émissif (visible à travers la géométrie pour repérer toutes les lumières)
        const coreGeo = new THREE.SphereGeometry(0.42, 16, 12);
        const coreMat = new THREE.MeshBasicMaterial({
            color: light.color,
            wireframe: false,
            depthTest: false,
            transparent: true,
            opacity: 0.95,
        });
        const coreMesh = new THREE.Mesh(coreGeo, coreMat);
        coreMesh.renderOrder = 9998;
        enableBloom(coreMesh);
        group.add(coreMesh);

        // Anneau externe pour un repère technologique précis
        const ringGeo = new THREE.TorusGeometry(0.72, 0.04, 8, 24);
        const ringMat = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0.85,
            depthTest: false,
        });
        const ringMesh = new THREE.Mesh(ringGeo, ringMat);
        ringMesh.renderOrder = 9999;
        ringMesh.rotation.x = Math.PI / 2;
        enableBloom(ringMesh);
        group.add(ringMesh);

        // Sphère invisible large pour faciliter grandement le clic souris (Hit Target)
        const hitGeo = new THREE.SphereGeometry(1.2, 8, 6);
        const hitMat = new THREE.MeshBasicMaterial({
            transparent: true,
            opacity: 0.0,
            depthWrite: false,
        });
        const hitMesh = new THREE.Mesh(hitGeo, hitMat);
        group.add(hitMesh);

        group.position.copy(light.position);
        return group;
    }

    _createLightHelper(light, type) {
        try {
            if (type === 'SpotLight') {
                return this._createSpotLightHelper(light);
            } else if (type === 'DirectionalLight') {
                const helper = new THREE.DirectionalLightHelper(light, 2.5);
                helper.visible = false;
                helper.userData.isAmbianceInternal = true;
                return helper;
            } else if (type === 'PointLight') {
                const helper = new THREE.PointLightHelper(light, 0.8);
                helper.visible = false;
                helper.userData.isAmbianceInternal = true;
                return helper;
            } else if (type === 'RectAreaLight') {
                const helper = new RectAreaLightHelper(light);
                helper.visible = false;
                helper.userData.isAmbianceInternal = true;
                return helper;
            }
        } catch (_) {}
        return null;
    }

    _createSpotLightHelper(light) {
        const helperGroup = new THREE.Group();
        helperGroup.name = `spot-cone-helper-${light.id || Math.random()}`;
        helperGroup.userData.isAmbianceInternal = true;
        helperGroup.userData.light = light;

        // 1. Cône volumétrique translucide (faisceau lumineux 3D avec blend additif)
        // Cône unitaire : apex à (0, 0, 0), base à (0, -1, 0)
        const coneGeo = new THREE.ConeGeometry(1, 1, 32, 1, true);
        coneGeo.translate(0, -0.5, 0);

        const coneMat = new THREE.MeshBasicMaterial({
            color: light.color,
            transparent: true,
            opacity: 0.22,
            side: THREE.DoubleSide,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
        });
        const coneMesh = new THREE.Mesh(coneGeo, coneMat);
        enableBloom(coneMesh);
        helperGroup.add(coneMesh);

        // 2. Lignes d'arêtes longitudinales (wireframe)
        const wireGeo = new THREE.ConeGeometry(1, 1, 8, 1, true);
        wireGeo.translate(0, -0.5, 0);
        const wireMat = new THREE.MeshBasicMaterial({
            color: light.color,
            wireframe: true,
            transparent: true,
            opacity: 0.45,
            depthWrite: false,
        });
        const wireMesh = new THREE.Mesh(wireGeo, wireMat);
        helperGroup.add(wireMesh);

        // 3. Anneau circulaire à la base (délimite le halo au sol/portée)
        const baseSegments = 48;
        const basePositions = new Float32Array((baseSegments + 1) * 3);
        for (let i = 0; i <= baseSegments; i++) {
            const theta = (i / baseSegments) * Math.PI * 2;
            basePositions[i * 3] = Math.cos(theta);
            basePositions[i * 3 + 1] = -1.0;
            basePositions[i * 3 + 2] = Math.sin(theta);
        }
        const baseRingGeo = new THREE.BufferGeometry();
        baseRingGeo.setAttribute('position', new THREE.BufferAttribute(basePositions, 3));
        const baseRingMat = new THREE.LineBasicMaterial({
            color: light.color,
            transparent: true,
            opacity: 0.75,
            depthWrite: false,
        });
        const baseRing = new THREE.Line(baseRingGeo, baseRingMat);
        helperGroup.add(baseRing);

        // 4. Rayon central direct vers la cible (ligne d'axe)
        const rayGeo = new THREE.BufferGeometry();
        rayGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
        const rayMat = new THREE.LineBasicMaterial({
            color: light.color,
            transparent: true,
            opacity: 0.8,
            depthWrite: false,
        });
        const rayLine = new THREE.Line(rayGeo, rayMat);
        helperGroup.add(rayLine);

        // 5. Réticule / Cible au point d'impact
        const reticleGroup = new THREE.Group();
        const reticleRingGeo = new THREE.RingGeometry(0.4, 0.55, 32);
        reticleRingGeo.rotateX(-Math.PI / 2);
        const reticleMat = new THREE.MeshBasicMaterial({
            color: light.color,
            transparent: true,
            opacity: 0.85,
            side: THREE.DoubleSide,
            depthWrite: false,
        });
        const reticleRing = new THREE.Mesh(reticleRingGeo, reticleMat);
        reticleGroup.add(reticleRing);

        // Croix de visée au centre du réticule
        const crossGeo = new THREE.BufferGeometry();
        const crossVerts = new Float32Array([
            -0.7, 0, 0,   0.7, 0, 0,
            0, 0, -0.7,   0, 0, 0.7
        ]);
        crossGeo.setAttribute('position', new THREE.BufferAttribute(crossVerts, 3));
        const crossLine = new THREE.LineSegments(crossGeo, new THREE.LineBasicMaterial({
            color: light.color,
            transparent: true,
            opacity: 0.9,
            depthWrite: false,
        }));
        reticleGroup.add(crossLine);
        helperGroup.add(reticleGroup);

        helperGroup.coneMesh = coneMesh;
        helperGroup.wireMesh = wireMesh;
        helperGroup.baseRing = baseRing;
        helperGroup.rayLine = rayLine;
        helperGroup.reticleGroup = reticleGroup;

        helperGroup.update = () => {
            this._updateSpotLightHelper(helperGroup, light);
        };

        helperGroup.update();
        return helperGroup;
    }

    _updateSpotLightHelper(helperGroup, light) {
        if (!light || !helperGroup || !helperGroup.coneMesh) return;

        light.updateMatrixWorld();
        if (light.target) light.target.updateMatrixWorld();

        const origin = light.position;
        const targetPos = light.target ? light.target.position : new THREE.Vector3(origin.x, origin.y - 10, origin.z);

        const dir = new THREE.Vector3().subVectors(targetPos, origin);
        const distToTarget = dir.length();
        if (distToTarget < 0.001) {
            dir.set(0, -1, 0);
        } else {
            dir.normalize();
        }

        // Longueur du cône : distance si fixée > 0, sinon distance à la cible (min 15)
        const coneLen = (light.distance > 0) ? light.distance : Math.max(15, distToTarget);
        const angle = (light.angle !== undefined) ? light.angle : Math.PI / 4;
        const radius = Math.max(0.1, Math.tan(angle) * coneLen);

        const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir);

        helperGroup.coneMesh.position.copy(origin);
        helperGroup.coneMesh.quaternion.copy(quat);
        helperGroup.coneMesh.scale.set(radius, coneLen, radius);

        helperGroup.wireMesh.position.copy(origin);
        helperGroup.wireMesh.quaternion.copy(quat);
        helperGroup.wireMesh.scale.set(radius, coneLen, radius);

        helperGroup.baseRing.position.copy(origin);
        helperGroup.baseRing.quaternion.copy(quat);
        helperGroup.baseRing.scale.set(radius, coneLen, radius);

        // Mise à jour de la couleur
        helperGroup.coneMesh.material.color.copy(light.color);
        helperGroup.wireMesh.material.color.copy(light.color);
        helperGroup.baseRing.material.color.copy(light.color);

        // Rayon central direct vers la cible
        const rayPos = helperGroup.rayLine.geometry.attributes.position.array;
        rayPos[0] = origin.x;
        rayPos[1] = origin.y;
        rayPos[2] = origin.z;
        rayPos[3] = targetPos.x;
        rayPos[4] = targetPos.y;
        rayPos[5] = targetPos.z;
        helperGroup.rayLine.geometry.attributes.position.needsUpdate = true;
        helperGroup.rayLine.material.color.copy(light.color);

        // Réticule orienté au point d'impact
        helperGroup.reticleGroup.position.copy(targetPos);
        helperGroup.reticleGroup.quaternion.copy(quat);
        helperGroup.reticleGroup.children.forEach(c => {
            if (c.material) c.material.color.copy(light.color);
        });
    }

    _updateAllHelpersVisibility() {
        const canShow = this.isOpen && this.markersVisible;
        this.helpersGroup.visible = canShow;

        this.lights.forEach(e => {
            if (!e.helper) return;
            const isSel = (e === this.selectedEntry);

            if (e.type === 'SpotLight') {
                e.helper.visible = canShow && (isSel || this.showSpotCones);
                if (e.helper.coneMesh) {
                    e.helper.coneMesh.material.opacity = isSel ? 0.28 : 0.12;
                    e.helper.wireMesh.material.opacity = isSel ? 0.55 : 0.22;
                    e.helper.baseRing.material.opacity = isSel ? 0.85 : 0.35;
                    e.helper.rayLine.material.opacity = isSel ? 0.85 : 0.35;
                    e.helper.reticleGroup.visible = isSel || this.showSpotCones;
                }
                if (e.helper.update && e.helper.visible) e.helper.update();
            } else {
                e.helper.visible = canShow && isSel;
                if (e.helper.update && e.helper.visible) e.helper.update();
            }
        });
    }

    // ─── 3. Sélection & Clic 3D ──────────────────────────────────────
    selectLight(entry) {
        if (!entry) {
            this.deselectLight();
            return;
        }

        this.deselectLaser();
        this.deselectStrobe();
        this.deselectSpot();

        // Si cette lumière est déjà sélectionnée et attachée, ne rien faire
        if (this.selectedEntry === entry && this.transformControls.object === entry.light) {
            return;
        }

        this._isSwitchingLight = true;

        try {
            // 1. Détacher et masquer immédiatement le Gizmo de la lumière précédente
            this.transformControls.detach();
            this.transformControls.visible = false;
            this.transformControls.enabled = false;

            // 2. Rompre toute liaison avec les anciens contrôleurs de position
            this.ctrlPosX = null;
            this.ctrlPosY = null;
            this.ctrlPosZ = null;

            // 3. Définir la nouvelle lumière active
            this.selectedEntry = entry;
            this._currentInspectorEntry = entry;

            this._gizmoTargetMode = 'lamp';

            // 4. Mettre en valeur visuelle le repère 3D correspondant
            this.lights.forEach(e => {
                if (e.markerMesh) {
                    const isSel = (e === entry);
                    const ring = e.markerMesh.children[1];
                    if (ring) {
                        ring.scale.setScalar(isSel ? 1.4 : 1.0);
                        ring.material.color.set(isSel ? 0x38bdf8 : 0xffffff);
                        ring.material.opacity = isSel ? 1.0 : 0.6;
                    }
                }
            });

            // 5. Mettre à jour l'affichage de tous les helpers et cônes de spot
            this._updateAllHelpersVisibility();

            // 6. Reconstruire l'interface inspecteur AVANT d'attacher le Gizmo
            this._rebuildInspectorGui();

            // 7. Synchroniser la rotation et attacher le Gizmo à la nouvelle lumière
            this._syncLightRotationFromTarget(entry);
            if (entry.type !== 'AmbientLight') {
                this._attachGizmoToCurrentTarget();
            }
        } finally {
            this._isSwitchingLight = false;
        }
    }

    /**
     * Quitte le mode Gizmo et désélectionne la lumière
     */
    deselectLight() {
        this.selectedEntry = null;
        this.deselectLaser();
        this.deselectStrobe();
        this.deselectSpot();
        this.transformControls.detach();
        this.transformControls.visible = false;
        this.transformControls.enabled = false;

        this.lights.forEach(e => {
            if (e.markerMesh) {
                const ring = e.markerMesh.children[1];
                if (ring) {
                    ring.scale.setScalar(1.0);
                    ring.material.color.set(0xffffff);
                    ring.material.opacity = 0.6;
                }
            }
        });

        this._updateAllHelpersVisibility();
        this._rebuildInspectorGui();
    }

    /**
     * Sélectionne un laser 3D et attache le Gizmo à son boîtier
     * @param {import('../laser/LaserShow.js').LaserShow} laser
     */
    selectLaser(laser) {
        if (!laser) return;
        this.selectedEntry = null;
        this.deselectStrobe();
        this.deselectSpot();
        this.selectedLaser = laser;

        // Détacher gizmo de toute lumière précédente
        this.transformControls.detach();

        // Attacher le gizmo au groupe du boîtier 3D du laser
        const housing = laser.getHousingGroup();
        if (housing) {
            housing.updateMatrixWorld(true);
            this.transformControls.attach(housing);
            this.transformControls.visible = true;
            this.transformControls.enabled = true;
            this.transformControls.updateMatrixWorld(true);
        }

        // Réinitialiser les repères de lumière
        this.lights.forEach(e => {
            if (e.markerMesh) {
                const ring = e.markerMesh.children[1];
                if (ring) {
                    ring.scale.setScalar(1.0);
                    ring.material.color.set(0xffffff);
                    ring.material.opacity = 0.6;
                }
            }
        });
        this._updateAllHelpersVisibility();
        this._rebuildInspectorGui();

        if (this._laserInspectorPanel) {
            this._laserInspectorPanel.openForLaser(laser.laserId, laser);
        }
    }

    /**
     * Désélectionne le laser actuel et détache le Gizmo
     */
    deselectLaser() {
        this.selectedLaser = null;
        if (this.transformControls && this.transformControls.object && !this.selectedEntry && !this.selectedStrobe && !this.selectedSpot) {
            this.transformControls.detach();
            this.transformControls.visible = false;
            this.transformControls.enabled = false;
        }
        if (this._laserInspectorPanel && this._laserInspectorPanel.isOpen) {
            this._laserInspectorPanel.close();
        }
        this._rebuildInspectorGui();
    }

    /**
     * Sélectionne un Stroboscope 3D et attache le Gizmo à son boîtier
     * @param {import('../strobe/StrobeLight.js').StrobeLight} strobe
     */
    selectStrobe(strobe) {
        if (!strobe) return;
        this.selectedEntry = null;
        this.selectedLaser = null;
        this.deselectSpot();
        this.selectedStrobe = strobe;

        // Détacher gizmo de toute lumière/laser précédent
        this.transformControls.detach();

        if (strobe.group) {
            strobe.group.updateMatrixWorld(true);
            this.transformControls.attach(strobe.group);
            this.transformControls.visible = true;
            this.transformControls.enabled = true;
            this.transformControls.updateMatrixWorld(true);
        }

        // Réinitialiser les repères de lumière
        this.lights.forEach(e => {
            if (e.markerMesh) {
                const ring = e.markerMesh.children[1];
                if (ring) {
                    ring.scale.setScalar(1.0);
                    ring.material.color.set(0xffffff);
                    ring.material.opacity = 0.6;
                }
            }
        });
        this._updateAllHelpersVisibility();
        this._rebuildInspectorGui();

        if (this._strobeInspectorPanel) {
            this._strobeInspectorPanel.openForStrobe(strobe.id, strobe);
        }
    }

    /**
     * Désélectionne le stroboscope actuel et détache le Gizmo
     */
    deselectStrobe() {
        this.selectedStrobe = null;
        if (this.transformControls && this.transformControls.object && !this.selectedEntry && !this.selectedLaser && !this.selectedSpot) {
            this.transformControls.detach();
            this.transformControls.visible = false;
            this.transformControls.enabled = false;
        }
        if (this._strobeInspectorPanel && this._strobeInspectorPanel.isOpen) {
            this._strobeInspectorPanel.close();
        }
        this._rebuildInspectorGui();
    }

    /**
     * Sélectionne une lyre Spot et attache le Gizmo à son groupe
     * @param {import('../spot/SpotFixture.js').SpotFixture} spot
     */
    selectSpot(spot) {
        if (!spot) return;
        this.selectedEntry = null;
        this.selectedLaser = null;
        this.selectedStrobe = null;
        if (this._laserInspectorPanel && this._laserInspectorPanel.isOpen) this._laserInspectorPanel.close();
        if (this._strobeInspectorPanel && this._strobeInspectorPanel.isOpen) this._strobeInspectorPanel.close();
        this.selectedSpot = spot;

        this.transformControls.detach();
        spot.group.updateMatrixWorld(true);
        this.transformControls.attach(spot.group);
        this.transformControls.visible = true;
        this.transformControls.enabled = true;
        this.transformControls.updateMatrixWorld(true);

        this.lights.forEach(e => {
            if (e.markerMesh) {
                const ring = e.markerMesh.children[1];
                if (ring) {
                    ring.scale.setScalar(1.0);
                    ring.material.color.set(0xffffff);
                    ring.material.opacity = 0.6;
                }
            }
        });
        this._updateAllHelpersVisibility();
        this._rebuildInspectorGui();

        if (this._spotInspectorPanel) {
            this._spotInspectorPanel.openForSpot(spot);
        }
    }

    /**
     * Désélectionne la lyre Spot actuelle et détache le Gizmo
     */
    deselectSpot() {
        if (!this.selectedSpot && !(this._spotInspectorPanel && this._spotInspectorPanel.isOpen)) return;
        if (this.selectedSpot) this.selectedSpot.isBeingDragged = false;
        this.selectedSpot = null;
        if (this.transformControls && this.transformControls.object && !this.selectedEntry && !this.selectedLaser && !this.selectedStrobe) {
            this.transformControls.detach();
            this.transformControls.visible = false;
            this.transformControls.enabled = false;
        }
        if (this._spotInspectorPanel && this._spotInspectorPanel.isOpen) {
            this._spotInspectorPanel.close();
        }
        this._rebuildInspectorGui();
    }

    /** Duplique une lyre (réglages identiques, décalée de 0.8 m, nouvelle adresse DMX libre) */
    duplicateSelectedSpot(spot = this.selectedSpot) {
        if (!spot || !this.spotManager) return null;
        const res = this.spotManager.duplicateSpot(spot.id);
        if (!res) return null;
        this._emitSync({ category: 'spot_add', data: { id: res.id, params: { ...res.spot.params } } });
        this.selectSpot(res.spot);
        return res;
    }

    deleteSelectedSpot(spot = this.selectedSpot) {
        if (!spot || !this.spotManager) return;
        const id = spot.id;
        if (this.selectedSpot === spot) this.deselectSpot();
        this.spotManager.removeSpot(id);
        this._emitSync({ category: 'spot_remove', id });
        this._rebuildInspectorGui();
    }

    /** Copie la configuration complète de la lyre (JSON) dans le presse-papiers */
    exportSelectedSpot(spot = this.selectedSpot) {
        if (!spot) return;
        const json = JSON.stringify({ name: `Lyre Spot #${spot.number}`, type: 'SpotFixture', params: spot.params }, null, 2);
        try { navigator.clipboard.writeText(json); } catch (_) {}
        console.log('[Lyre Spot] Configuration :', json);
    }

    setGizmoVisible(val) {
        this.gizmoVisible = Boolean(val);
        if (this.selectedEntry && this.selectedEntry.type !== 'AmbientLight') {
            this.transformControls.visible = this.isOpen && this.gizmoVisible;
            this.transformControls.enabled = this.isOpen && this.gizmoVisible;
        } else {
            this.transformControls.visible = false;
            this.transformControls.enabled = false;
        }
        if (this._cShowGizmo && this._cShowGizmo.getValue() !== this.gizmoVisible) {
            this._cShowGizmo.setValue(this.gizmoVisible);
        }
    }

    setShowSpotCones(val) {
        this.showSpotCones = Boolean(val);
        this._updateAllHelpersVisibility();
        if (this._cShowSpotCones && this._cShowSpotCones.getValue() !== this.showSpotCones) {
            this._cShowSpotCones.setValue(this.showSpotCones);
        }
    }

    /** Affiche / masque les ronds d'émission sonore des enceintes et le marqueur FOH */
    setSoundMarkersVisible(val) {
        this.soundMarkersVisible = Boolean(val);
        const g = this.scene.getObjectByName('sound-markers-group');
        if (g) g.visible = this.soundMarkersVisible;
        if (this._cShowSoundMarkers && this._cShowSoundMarkers.getValue() !== this.soundMarkersVisible) {
            this._cShowSoundMarkers.setValue(this.soundMarkersVisible);
        }
    }

    setMarkersVisible(val) {
        this.markersVisible = Boolean(val);
        this.markersGroup.visible = this.markersVisible;
        this._updateAllHelpersVisibility();
        if (this._cShowMarkers && this._cShowMarkers.getValue() !== this.markersVisible) {
            this._cShowMarkers.setValue(this.markersVisible);
        }
    }

    focusSelectedLight() {
        if (!this.selectedEntry || !this.camera) return;
        const targetPos = this.selectedEntry.light.position;
        this.camera.lookAt(targetPos);
        if (this.listener && this.listener._character3D) {
            const dir = new THREE.Vector3().subVectors(targetPos, this.camera.position).normalize();
            this.listener._character3D.orbitYaw = Math.atan2(-dir.x, -dir.z);
        }
    }

    aimSelectedLightAtPlayer() {
        if (!this.selectedEntry || !this.listener) return;
        const light = this.selectedEntry.light;
        if (light.target) {
            light.target.position.copy(this.listener.position);
            light.target.updateMatrixWorld();
            if (this.selectedEntry.helper && this.selectedEntry.helper.update) {
                this.selectedEntry.helper.update();
            }
        }
    }

    /** Vrai (une seule fois) si le dernier clic vient de sélectionner un projecteur : main.js ne doit pas reverrouiller la souris. */
    consumeFixturePick() {
        const picked = performance.now() - (this._lastFixturePick || -1e9) < 2000;
        this._lastFixturePick = 0;
        return picked;
    }

    handleCanvasClick(event) {
        const isLaserOpen = Boolean(this._laserInspectorPanel && this._laserInspectorPanel.isOpen);
        const isStrobeOpen = Boolean(this._strobeInspectorPanel && this._strobeInspectorPanel.isOpen);
        const isSpotOpen = Boolean(this._spotInspectorPanel && this._spotInspectorPanel.isOpen);
        // Mode curseur (Tab / Échap) : le clic sur une lampe ouvre directement ses réglages, même panneau Ambiance fermé
        const cursorMode = Boolean(!this.isOpen && this.listener && this.listener.controls && !this.listener.controls.isLocked
            && !(this.spotConsole && this.spotConsole.isOpen));
        if ((!this.isOpen && !isLaserOpen && !isStrobeOpen && !isSpotOpen && !cursorMode) || this.isDraggingGizmo) return;
        // Si un drag de Gizmo vient tout juste de se terminer, ne pas interpréter comme un clic
        if (performance.now() - (this._dragEndTime || 0) < 120) return;
        // Si la souris survole ou manipule une flèche du Gizmo, ignorer la sélection
        if (this.transformControls && (this.transformControls.axis !== null || this.transformControls.dragging)) return;

        const rect = this.renderer.domElement.getBoundingClientRect();
        this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        this.raycaster.setFromCamera(this.mouse, this.camera);

        // ── Tester d'abord les lasers (avant les repères de lumière) ──
        if (this.laserManager && this.laserManager.count > 0) {
            const laserObjects = this.laserManager.getLaserObjects();
            const laserIntersects = this.raycaster.intersectObjects(laserObjects, true);
            if (laserIntersects.length > 0) {
                const hitObj = laserIntersects[0].object;
                const laser = this.laserManager.getLaserFromObject(hitObj);
                if (laser) {
                    this._lastFixturePick = performance.now();
                    this.selectLaser(laser);
                    return;
                }
            }
        }

        // ── Tester ensuite les stroboscopes ──
        if (this.strobeManager && this.strobeManager.count > 0) {
            const strobeObjects = this.strobeManager.getStrobeObjects();
            const strobeIntersects = this.raycaster.intersectObjects(strobeObjects, true);
            if (strobeIntersects.length > 0) {
                const hitObj = strobeIntersects[0].object;
                const strobe = this.strobeManager.getStrobeFromObject(hitObj);
                if (strobe) {
                    this._lastFixturePick = performance.now();
                    this.selectStrobe(strobe);
                    return;
                }
            }
        }

        // ── Tester les lyres Spot ──
        if (this.spotManager && this.spotManager.count > 0) {
            const spotHits = this.raycaster.intersectObjects(this.spotManager.getSpotObjects(), false);
            if (spotHits.length > 0) {
                const spot = this.spotManager.getSpotFromObject(spotHits[0].object);
                if (spot) {
                    this._lastFixturePick = performance.now();
                    this.selectSpot(spot);
                    return;
                }
            }
        }

        // Panneau Ambiance fermé : seuls les projecteurs sont sélectionnables (les repères de lumière sont masqués)
        if (!this.isOpen) {
            if (this.selectedLaser || this.selectedStrobe || this.selectedSpot) {
                this.deselectLaser();
                this.deselectStrobe();
                this.deselectSpot();
            }
            return;
        }

        // Tester l'intersection avec tous les repères de lumière
        const markerObjects = [];
        this.lights.forEach(e => {
            if (e.markerMesh && e.markerMesh.visible) {
                e.markerMesh.traverse(child => {
                    if (child.isMesh) {
                        child.userData.entry = e;
                        markerObjects.push(child);
                    }
                });
            }
        });

        const intersects = this.raycaster.intersectObjects(markerObjects, false);
        if (intersects.length > 0) {
            const hitEntry = intersects[0].object.userData.entry;
            if (hitEntry) {
                this.selectLight(hitEntry);
            }
        } else {
            // Clic dans le vide 3D : désélectionne la lumière, le laser et le stroboscope
            this.deselectLaser();
            this.deselectStrobe();
            this.deselectSpot();
            this.deselectLight();
        }
    }

    // ─── 4. Création Dynamique de Lumière ────────────────────────────
    addNewLight(type, spawnInFrontOfCamera = true) {
        let light = null;
        const color = new THREE.Color(this.creationParams.color);
        const intensity = this.creationParams.intensity;

        // Position de spawn : 5 mètres devant la caméra du joueur
        let spawnPos = new THREE.Vector3(0, 5, 0);
        if (spawnInFrontOfCamera && this.camera) {
            const forward = new THREE.Vector3();
            this.camera.getWorldDirection(forward);
            spawnPos.copy(this.camera.position).addScaledVector(forward, 5.0);
            spawnPos.y = Math.max(1.0, spawnPos.y); // Au moins 1m du sol
        }

        switch (type) {
            case 'PointLight':
                light = new THREE.PointLight(color, intensity, this.creationParams.distance);
                light.position.copy(spawnPos);
                // Ombres désactivées par défaut sur les nouvelles lampes ponctuelles pour préserver les perfs (activable en 1 clic dans l'inspecteur)
                light.castShadow = false;
                light.shadow.bias = -0.0001;
                light.shadow.mapSize.set(1024, 1024);
                break;

            case 'SpotLight':
                light = new THREE.SpotLight(color, intensity);
                light.position.copy(spawnPos);
                light.distance = this.creationParams.distance || 30.0;
                light.angle = THREE.MathUtils.degToRad(this.creationParams.angle || 35);
                light.penumbra = this.creationParams.penumbra || 0.4;
                // Ombres désactivées par défaut (évite d'allouer une shadow map 2K/4K superflue, activable dans l'inspecteur)
                light.castShadow = false;
                light.shadow.mapSize.set(1024, 1024);
                // Viser en avant et vers le sol pour créer un faisceau visible naturel
                const forwardDir = new THREE.Vector3(0, 0, -1);
                if (this.camera) this.camera.getWorldDirection(forwardDir);
                const targetPos = spawnPos.clone().addScaledVector(forwardDir, 7.0);
                targetPos.y = Math.max(0, spawnPos.y - 3.5);
                light.target.position.copy(targetPos);
                this.scene.add(light.target);
                break;

            case 'DirectionalLight':
                light = new THREE.DirectionalLight(color, intensity);
                light.position.copy(spawnPos);
                light.castShadow = false;
                light.shadow.mapSize.set(2048, 2048);
                this.scene.add(light.target);
                break;

            case 'AmbientLight':
                light = new THREE.AmbientLight(color, intensity);
                break;

            case 'HemisphereLight':
                light = new THREE.HemisphereLight(color, 0x444444, intensity);
                light.position.copy(spawnPos);
                break;

            case 'RectAreaLight':
                light = new THREE.RectAreaLight(color, intensity, this.creationParams.width, this.creationParams.height);
                light.position.copy(spawnPos);
                light.lookAt(spawnPos.x, 0, spawnPos.z);
                break;

            case '⚡ Stroboscope':
                if (!this.strobeManager) {
                    console.warn('[AmbiancePanel] StrobeManager non disponible. Appelez setStrobeManager() depuis main.js.');
                    return null;
                }
                {
                    const strobeSpawnPos = spawnPos.clone();
                    strobeSpawnPos.y = Math.max(3.0, strobeSpawnPos.y);
                    const { id, strobe } = this.strobeManager.addStrobe(strobeSpawnPos);
                    this.selectStrobe(strobe);
                    this._logSceneProbe('⚡ Stroboscope');
                    return null;
                }

            case '🎯 Lyre Spot':
                if (!this.spotManager) {
                    console.warn('[AmbiancePanel] SpotManager non disponible. Appelez setSpotManager() depuis main.js.');
                    return null;
                }
                {
                    // Posée au sol devant le joueur (y = 0), faisceau vers le ciel légèrement incliné
                    const spotPos = spawnPos.clone();
                    spotPos.y = 0.0;
                    const { id, spot } = this.spotManager.addSpot(spotPos, {
                        yaw: this.camera ? Math.round(THREE.MathUtils.radToDeg(Math.atan2(
                            this.camera.position.x - spotPos.x, this.camera.position.z - spotPos.z)) + 180) % 360 - 180 : 0,
                    });
                    this._emitSync({ category: 'spot_add', data: { id, params: { ...spot.params } } });
                    this.selectSpot(spot);
                    this._logSceneProbe('🎯 Lyre Spot');
                    return null;
                }

            case '🔴 LaserPod':
                // Cas spécial : délégation au LaserManager
                if (!this.laserManager) {
                    console.warn('[AmbiancePanel] LaserManager non disponible. Appelez setLaserManager() depuis main.js.');
                    return null;
                }
                {
                    // Placer le laser en hauteur sur la structure/pont de scène (y=12m au lieu de juste au-dessus du DJ booth)
                    const laserSpawnPos = spawnPos.clone();
                    laserSpawnPos.y = Math.max(12.0, laserSpawnPos.y);
                    const { id, laserShow } = this.laserManager.addLaser(laserSpawnPos);
                    this.selectLaser(laserShow);
                    this._emitSync({
                        category: 'laser_add',
                        data: {
                            id,
                            position: { x: laserSpawnPos.x, y: laserSpawnPos.y, z: laserSpawnPos.z },
                            params: { ...laserShow.params }
                        }
                    });
                    this._logSceneProbe('🔴 LaserPod');
                    return null; // Pas d'entry lumière classique
                }

            default:
                light = new THREE.PointLight(color, intensity, 25);
                light.position.copy(spawnPos);
                break;
        }

        this.scene.add(light);
        const entry = this.registerLight(light, false);
        this.selectLight(entry);

        // Warm-up GPU pour compiler les matériaux sans freeze au runtime
        if (this.renderer && this.camera && typeof this.renderer.compile === 'function') {
            try {
                if (entry.markerMesh) this.renderer.compile(entry.markerMesh, this.camera);
            } catch (_) {}
        }

        // Reconstruire le GUI pour mettre à jour la liste
        this._buildGui();
        this._emitSync({
            category: 'light_add',
            data: {
                id: entry.id,
                name: entry.name,
                type: entry.type,
                isBuiltin: false,
                ...this._captureLightState(light, entry.type)
            }
        });
        this._logSceneProbe(entry.type);
        return entry;
    }

    _logSceneProbe(type) {
        let lightsCount = 0, shadowsCount = 0, meshesCount = 0;
        if (this.scene) {
            this.scene.traverse((o) => {
                if (o.isMesh) meshesCount++;
                if (o.isLight) {
                    lightsCount++;
                    if (o.castShadow) shadowsCount++;
                }
            });
        }
        const laserCount = this.laserManager?.getLaserObjects?.().length ?? 0;
        probeObjectAdded(type, lightsCount, shadowsCount, laserCount, meshesCount);
    }

    /**
     * Supprime l'élément actuellement sélectionné (touche Suppr).
     * Reprend exactement les actions des boutons « 🗑️ Supprimer » de l'inspecteur.
     * @returns {boolean} true si quelque chose a été supprimé
     */
    _deleteSelectedWithKey() {
        if (this.selectedLaser && this.laserManager) {
            const id = this.selectedLaser.laserId;
            if (this._laserInspectorPanel && this._laserInspectorPanel.isOpen) this._laserInspectorPanel.close();
            this.laserManager.removeLaser(id);
            this.deselectLaser();
            this._buildGui();
            this._emitSync({ category: 'laser_remove', id });
            return true;
        }
        if (this.selectedSpot && this.spotManager) {
            this.deleteSelectedSpot(this.selectedSpot);
            return true;
        }
        if (this.selectedStrobe && this.strobeManager) {
            const id = this.selectedStrobe.id;
            if (this._strobeInspectorPanel && this._strobeInspectorPanel.isOpen) this._strobeInspectorPanel.close();
            this.strobeManager.removeStrobe(id);
            this.deselectStrobe();
            this._rebuildInspectorGui();
            return true;
        }
        const entry = this.selectedEntry;
        if (entry && !entry.isBuiltin) {
            this.removeLight(entry);
            return true;
        }
        return false;
    }

    removeLight(entry) {
        if (!entry || entry.isBuiltin) return;

        // Détacher le gizmo
        if (this.selectedEntry === entry) {
            this.transformControls.detach();
        }

        // Retirer de la scène
        this.scene.remove(entry.light);
        if (entry.light.target) this.scene.remove(entry.light.target);
        if (entry.markerMesh) this.markersGroup.remove(entry.markerMesh);
        if (entry.helper) this.helpersGroup.remove(entry.helper);

        // Retirer de la liste
        this.lights = this.lights.filter(e => e !== entry);

        // Sélectionner la première restante
        if (this.lights.length > 0) {
            this.selectLight(this.lights[0]);
        } else {
            this.selectedEntry = null;
        }

        this._buildGui();
        this._emitSync({ category: 'light_remove', id: entry.id });
    }

    duplicateSelectedLight() {
        if (!this.selectedEntry) return;
        const src = this.selectedEntry;
        const entry = this.addNewLight(src.type, false);
        if (entry) {
            entry.light.color.copy(src.light.color);
            entry.light.intensity = src.light.intensity;
            entry.light.position.copy(src.light.position).add(new THREE.Vector3(1.0, 0, 1.0));

            if (src.type === 'SpotLight' && src.light.target && entry.light.target) {
                entry.light.distance = src.light.distance;
                entry.light.angle = src.light.angle;
                entry.light.penumbra = src.light.penumbra;
                entry.light.decay = src.light.decay;
                entry.light.target.position.copy(src.light.target.position).add(new THREE.Vector3(1.0, 0, 1.0));
                entry.light.target.updateMatrixWorld();
            }

            if (entry.markerMesh) entry.markerMesh.position.copy(entry.light.position);
            if (entry.helper && entry.helper.update) entry.helper.update();
            entry.creationConfig = this._captureLightState(entry.light, entry.type);
            entry.defaultConfig = entry.creationConfig;
            this.selectLight(entry);
            this._emitSync({
                category: 'light_add',
                data: {
                    id: entry.id,
                    name: entry.name,
                    type: entry.type,
                    isBuiltin: false,
                    ...this._captureLightState(entry.light, entry.type)
                }
            });
        }
    }

    // ─── 5. Réinitialisation Unitaire & Globale (Source Unique de Vérité) ──
    /**
     * Source unique de vérité pour la configuration par défaut d'une lumière.
     * Pour les lumières intégrées (Soleil, Ciel/Sol, Ambiance générale, Spots scène),
     * les valeurs par défaut sont déduites dynamiquement du preset d'ambiance actif.
     * Pour les lumières créées par l'utilisateur, ce sont leurs paramètres initiaux à la création.
     */
    getDefaultConfigForEntry(entry, presetKey = this.envState?.presetKey) {
        if (!entry) return null;
        if (!entry.isBuiltin) {
            return entry.creationConfig || entry.defaultConfig;
        }
        const preset = (this.envPresets && this.envPresets[presetKey]) || this.envPresets?.day || this.envPresets?.night_aurora;
        const name = entry.name || '';
        const light = entry.light;

        if (light.isAmbientLight || name.includes('Générale')) {
            const amb = preset?.ambient || { color: '#98ddbc', intensity: 0.1, enabled: true };
            return {
                color: amb.color,
                intensity: amb.intensity,
                visible: (amb.enabled !== false) && (amb.intensity > 0.0001),
                position: { x: 0, y: 0, z: 0 },
                castShadow: false,
            };
        } else if (light.isHemisphereLight || name.includes('Ciel')) {
            const hemi = preset?.hemi || { skyColor: '#87ceeb', groundColor: '#4a7a2a', intensity: 1.0, enabled: true };
            return {
                color: hemi.skyColor,
                groundColor: hemi.groundColor,
                intensity: hemi.intensity,
                visible: (hemi.enabled !== false) && (hemi.intensity > 0.0001),
                position: { x: 0, y: 0, z: 0 },
                castShadow: false,
            };
        } else if (light.isDirectionalLight || name.includes('Soleil')) {
            const dir = preset?.dir || { color: '#fff5e0', intensity: 3.0, enabled: true, shadowMapSize: 2048 };
            return {
                color: dir.color,
                intensity: dir.intensity,
                visible: (dir.enabled !== false) && (dir.intensity > 0.0001),
                position: { x: 32, y: 45, z: 38 },
                target: { x: 0, y: 0, z: 0 },
                castShadow: true,
                shadowMapSize: dir.shadowMapSize || 2048,
                shadowBias: -0.0003,
                shadowNormalBias: 0.02,
            };
        } else if (name.includes('Gauche') || name.includes('stageLight1')) {
            const s1 = preset?.stage1 || { color: '#ff3366', intensity: 0.5, distance: 30 };
            const boost = this.envState?.stageBoost ?? 1.0;
            return {
                color: s1.color,
                intensity: s1.intensity * boost,
                distance: s1.distance || 30,
                decay: 2,
                position: { x: -8, y: 18, z: -2 },
                visible: true,
                castShadow: false,
            };
        } else if (name.includes('Droit') || name.includes('stageLight2')) {
            const s2 = preset?.stage2 || { color: '#3366ff', intensity: 0.5, distance: 30 };
            const boost = this.envState?.stageBoost ?? 1.0;
            return {
                color: s2.color,
                intensity: s2.intensity * boost,
                distance: s2.distance || 30,
                decay: 2,
                position: { x: 8, y: 18, z: -2 },
                visible: true,
                castShadow: false,
            };
        }

        return entry.defaultConfig;
    }

    getLightDefaultParam(entry, path) {
        const def = this.getDefaultConfigForEntry(entry);
        if (!def) return undefined;
        const parts = path.split('.');
        let val = def;
        for (const part of parts) {
            if (val === undefined || val === null) return undefined;
            val = val[part];
        }
        return val;
    }

    _getEnvPresetDefault(paramKey) {
        const preset = this.envPresets?.[this.envState?.presetKey] || this.envPresets?.day;
        if (!preset) return undefined;
        if (paramKey === 'stars') return Boolean(preset.hasStars);
        if (paramKey === 'starSize') return 0.5;
        if (paramKey === 'starCount') return 12000;
        if (paramKey === 'starBrightness') return 3.0;
        if (paramKey === 'stageBoost') return 1.0;
        return undefined;
    }

    resetLight(entry) {
        if (!entry) return;
        const def = this.getDefaultConfigForEntry(entry);
        if (!def) return;
        entry.defaultConfig = def;
        const light = entry.light;

        if (def.color !== undefined) light.color.set(def.color);
        if (def.intensity !== undefined) light.intensity = def.intensity;
        if (def.visible !== undefined) light.visible = def.visible;
        if (def.position) light.position.set(def.position.x, def.position.y, def.position.z);
        if (def.castShadow !== undefined) light.castShadow = def.castShadow;

        if (entry.type === 'SpotLight') {
            if (def.distance !== undefined) light.distance = def.distance;
            if (def.angle !== undefined) light.angle = THREE.MathUtils.degToRad(def.angle);
            if (def.penumbra !== undefined) light.penumbra = def.penumbra;
            if (def.decay !== undefined) light.decay = def.decay;
            if (light.target && def.target) {
                light.target.position.set(def.target.x, def.target.y, def.target.z);
                light.target.updateMatrixWorld(true);
            }
        } else if (entry.type === 'PointLight') {
            if (def.distance !== undefined) light.distance = def.distance;
            if (def.decay !== undefined) light.decay = def.decay;
        } else if (entry.type === 'HemisphereLight') {
            if (def.groundColor && light.groundColor) light.groundColor.set(def.groundColor);
        } else if (entry.type === 'RectAreaLight') {
            if (def.width !== undefined) light.width = def.width;
            if (def.height !== undefined) light.height = def.height;
        } else if (entry.type === 'DirectionalLight') {
            if (light.target && def.target) {
                light.target.position.set(def.target.x, def.target.y, def.target.z);
                light.target.updateMatrixWorld(true);
            }
            if (def.shadowMapSize && light.shadow && light.shadow.mapSize) {
                const sz = def.shadowMapSize;
                if (light.shadow.mapSize.width !== sz) {
                    light.shadow.mapSize.set(sz, sz);
                    if (light.shadow.map) {
                        light.shadow.map.dispose();
                        light.shadow.map = null;
                    }
                }
            }
            if (def.shadowBias !== undefined && light.shadow) light.shadow.bias = def.shadowBias;
            if (def.shadowNormalBias !== undefined && light.shadow) light.shadow.normalBias = def.shadowNormalBias;
        }

        if (entry.markerMesh) {
            entry.markerMesh.position.copy(light.position);
            const core = entry.markerMesh.children[0];
            if (core && core.material) {
                core.material.color.copy(light.color);
            }
        }
        if (light.userData && light.userData.bulbMesh && light.userData.bulbMesh.material) {
            light.userData.bulbMesh.material.color.copy(light.color);
            light.userData.bulbMesh.position.copy(light.position);
            light.userData.bulbMesh.visible = light.visible;
        }

        if (entry.helper && entry.helper.update) {
            entry.helper.update();
        }

        this._syncInspectorDisplays();
        this._rebuildInspectorGui();
        this._emitSync({ category: 'light_reset', id: entry.id });
    }

    resetAll() {
        // Supprimer toutes les lumières créées par l'utilisateur
        const created = this.lights.filter(e => !e.isBuiltin);
        created.forEach(e => this.removeLight(e));

        // Rétablir l'ambiance céleste par défaut au chargement (Plein Jour Standard)
        this.envState.stageBoost = 1.0;
        this.envState.stars = true;
        this.envState.starSize = 0.5;
        this.envState.starCount = 12000;
        this.envState.starBrightness = 3.0;
        this.setStarSize(0.5);
        this.setStarCount(12000);
        this.setStarBrightness(3.0);
        this.setMarkersVisible(false);
        this.setSoundMarkersVisible(false);
        this.setShowSpotCones(true);
        this.applyEnvPreset('day', true);

        // Réinitialiser toutes les lumières de base aux paramètres de 'day' et positions d'origine
        this.lights.forEach(e => {
            if (e.isBuiltin) this.resetLight(e);
        });

        // Réinitialiser l'Illumination Globale Statique
        if (this.staticGI) {
            this.staticGI.params.enabled = false;
            this.staticGI.params.intensity = 0.85;
            this.staticGI.params.stageBounceIntensity = 0.90;
            this.staticGI.params.roofBounceIntensity = 0.65;
            this.staticGI.params.subwooferBounceIntensity = 0.70;
            this.staticGI.params.skyColor = '#5a78a6';
            this.staticGI.params.groundBounceColor = '#1c2e18';
            this.staticGI.params.stageBounceColor = '#44556a';
            this.staticGI.params.subwooferBounceColor = '#2b3626';
            this.staticGI.update();
            this.staticGI.generateStaticEnvMap();
        }

        // Réinitialiser le Bloom et post-processing
        if (this.laserManager) {
            this.laserManager.setPostProcessingParam('lightsBloomEnabled', true);
            this.laserManager.setPostProcessingParam('lightsBloomStrength', 0.25);
            this.laserManager.setPostProcessingParam('lightsBloomRadius', 0.4);
            this.laserManager.setPostProcessingParam('lightsBloomThreshold', 0.05);

            this.laserManager.setPostProcessingParam('laserBloomEnabled', true);
            this.laserManager.setPostProcessingParam('laserBloomStrength', 0.15);
            this.laserManager.setPostProcessingParam('laserBloomRadius', 0.5);
            this.laserManager.setPostProcessingParam('laserBloomThreshold', 0.0);

            this.laserManager.setPostProcessingParam('chromaEnabled', true);
            this.laserManager.setPostProcessingParam('chroma', 0.25);
            this.laserManager.setPostProcessingParam('fogEnabled', false);
            this.laserManager.setPostProcessingParam('fogDensity', 0.005);
            this.laserManager.setPostProcessingParam('fogColor', '#111122');
        }

        // Remettre la première en sélection
        if (this.lights.length > 0) {
            this.selectLight(this.lights[0]);
        }
        this._buildGui();
        this._emitSync({ category: 'reset_all' });
    }

    // ─── 5b. Export d'une Lampe (Code Three.js & Format JSON) ─────────
    exportLightData(entry) {
        if (!entry || !entry.light) return null;
        const light = entry.light;
        const type = entry.type;
        const data = {
            name: entry.name || 'Lampe',
            type: type,
            color: '#' + light.color.getHexString(),
            colorHex: '0x' + light.color.getHexString(),
            intensity: Number(light.intensity.toFixed(2)),
            position: {
                x: Number(light.position.x.toFixed(2)),
                y: Number(light.position.y.toFixed(2)),
                z: Number(light.position.z.toFixed(2)),
            },
            castShadow: Boolean(light.castShadow),
        };

        if (light.shadow) {
            data.shadow = {
                bias: light.shadow.bias || 0,
                normalBias: light.shadow.normalBias || 0,
                mapSize: light.shadow.mapSize ? {
                    width: light.shadow.mapSize.width,
                    height: light.shadow.mapSize.height,
                } : { width: 1024, height: 1024 }
            };
        }

        if (type === 'SpotLight') {
            data.distance = Number(light.distance.toFixed(1));
            data.angle = Number(light.angle.toFixed(4));
            data.angleDeg = Number(THREE.MathUtils.radToDeg(light.angle).toFixed(1));
            data.penumbra = Number(light.penumbra.toFixed(2));
            data.decay = Number(light.decay.toFixed(2));
            if (light.target) {
                data.target = {
                    x: Number(light.target.position.x.toFixed(2)),
                    y: Number(light.target.position.y.toFixed(2)),
                    z: Number(light.target.position.z.toFixed(2)),
                };
            }
        } else if (type === 'PointLight') {
            data.distance = Number(light.distance.toFixed(1));
            data.decay = Number(light.decay.toFixed(2));
        } else if (type === 'DirectionalLight') {
            if (light.target) {
                data.target = {
                    x: Number(light.target.position.x.toFixed(2)),
                    y: Number(light.target.position.y.toFixed(2)),
                    z: Number(light.target.position.z.toFixed(2)),
                };
            }
        } else if (type === 'HemisphereLight') {
            data.groundColor = light.groundColor ? '#' + light.groundColor.getHexString() : '#444444';
        } else if (type === 'RectAreaLight') {
            data.width = Number(light.width.toFixed(2));
            data.height = Number(light.height.toFixed(2));
        }

        return data;
    }

    generateLightCode(entry) {
        if (!entry || !entry.light) return '';
        const light = entry.light;
        const type = entry.type;
        const name = entry.name || 'Lampe';
        const hex = '0x' + light.color.getHexString();
        const intensity = Number(light.intensity.toFixed(2));
        const px = Number(light.position.x.toFixed(2));
        const py = Number(light.position.y.toFixed(2));
        const pz = Number(light.position.z.toFixed(2));

        // Nom de variable JS propre et sans caractères spéciaux
        let varBase = name
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-zA-Z0-9]/g, '_')
            .replace(/^_+|_+$/g, '')
            .toLowerCase();
        if (!varBase || /^[0-9]/.test(varBase)) varBase = 'lamp_' + (varBase || 'custom');

        const lines = [];
        lines.push(`// ==========================================`);
        lines.push(`// Lampe exportée : ${name} (${type})`);
        lines.push(`// ==========================================`);

        switch (type) {
            case 'SpotLight': {
                const dist = Number(light.distance.toFixed(1));
                const angleRad = Number(light.angle.toFixed(4));
                const angleDeg = Number(THREE.MathUtils.radToDeg(light.angle).toFixed(1));
                const pen = Number(light.penumbra.toFixed(2));
                const decay = Number(light.decay.toFixed(2));
                const tx = light.target ? Number(light.target.position.x.toFixed(2)) : 0;
                const ty = light.target ? Number(light.target.position.y.toFixed(2)) : 0;
                const tz = light.target ? Number(light.target.position.z.toFixed(2)) : 0;

                lines.push(`const ${varBase} = new THREE.SpotLight(${hex}, ${intensity});`);
                lines.push(`${varBase}.name = '${name.replace(/'/g, "\\'")}';`);
                lines.push(`${varBase}.position.set(${px}, ${py}, ${pz});`);
                lines.push(`${varBase}.distance = ${dist};`);
                lines.push(`${varBase}.angle = ${angleRad}; // ${angleDeg}°`);
                lines.push(`${varBase}.penumbra = ${pen};`);
                lines.push(`${varBase}.decay = ${decay};`);
                if (light.castShadow) {
                    lines.push(`${varBase}.castShadow = true;`);
                    if (light.shadow) {
                        lines.push(`${varBase}.shadow.bias = ${light.shadow.bias || -0.0001};`);
                        if (light.shadow.mapSize) {
                            lines.push(`${varBase}.shadow.mapSize.set(${light.shadow.mapSize.width}, ${light.shadow.mapSize.height});`);
                        }
                    }
                }
                lines.push(`${varBase}.target.position.set(${tx}, ${ty}, ${tz});`);
                lines.push(`scene.add(${varBase}.target);`);
                lines.push(`scene.add(${varBase});`);
                break;
            }
            case 'PointLight': {
                const dist = Number(light.distance.toFixed(1));
                const decay = Number(light.decay.toFixed(2));
                lines.push(`const ${varBase} = new THREE.PointLight(${hex}, ${intensity}, ${dist}, ${decay});`);
                lines.push(`${varBase}.name = '${name.replace(/'/g, "\\'")}';`);
                lines.push(`${varBase}.position.set(${px}, ${py}, ${pz});`);
                if (light.castShadow) {
                    lines.push(`${varBase}.castShadow = true;`);
                    if (light.shadow) lines.push(`${varBase}.shadow.bias = ${light.shadow.bias || -0.0001};`);
                }
                lines.push(`scene.add(${varBase});`);
                break;
            }
            case 'DirectionalLight': {
                const tx = light.target ? Number(light.target.position.x.toFixed(2)) : 0;
                const ty = light.target ? Number(light.target.position.y.toFixed(2)) : 0;
                const tz = light.target ? Number(light.target.position.z.toFixed(2)) : 0;
                lines.push(`const ${varBase} = new THREE.DirectionalLight(${hex}, ${intensity});`);
                lines.push(`${varBase}.name = '${name.replace(/'/g, "\\'")}';`);
                lines.push(`${varBase}.position.set(${px}, ${py}, ${pz});`);
                if (light.castShadow) {
                    lines.push(`${varBase}.castShadow = true;`);
                    if (light.shadow) lines.push(`${varBase}.shadow.bias = ${light.shadow.bias || -0.0001};`);
                }
                lines.push(`${varBase}.target.position.set(${tx}, ${ty}, ${tz});`);
                lines.push(`scene.add(${varBase}.target);`);
                lines.push(`scene.add(${varBase});`);
                break;
            }
            case 'AmbientLight': {
                lines.push(`const ${varBase} = new THREE.AmbientLight(${hex}, ${intensity});`);
                lines.push(`${varBase}.name = '${name.replace(/'/g, "\\'")}';`);
                lines.push(`scene.add(${varBase});`);
                break;
            }
            case 'HemisphereLight': {
                const groundHex = light.groundColor ? '0x' + light.groundColor.getHexString() : '0x444444';
                lines.push(`const ${varBase} = new THREE.HemisphereLight(${hex}, ${groundHex}, ${intensity});`);
                lines.push(`${varBase}.name = '${name.replace(/'/g, "\\'")}';`);
                lines.push(`${varBase}.position.set(${px}, ${py}, ${pz});`);
                lines.push(`scene.add(${varBase});`);
                break;
            }
            case 'RectAreaLight': {
                const w = Number(light.width.toFixed(2));
                const h = Number(light.height.toFixed(2));
                lines.push(`const ${varBase} = new THREE.RectAreaLight(${hex}, ${intensity}, ${w}, ${h});`);
                lines.push(`${varBase}.name = '${name.replace(/'/g, "\\'")}';`);
                lines.push(`${varBase}.position.set(${px}, ${py}, ${pz});`);
                if (Math.abs(light.rotation.x) > 0.001 || Math.abs(light.rotation.y) > 0.001 || Math.abs(light.rotation.z) > 0.001) {
                    lines.push(`${varBase}.rotation.set(${Number(light.rotation.x.toFixed(3))}, ${Number(light.rotation.y.toFixed(3))}, ${Number(light.rotation.z.toFixed(3))});`);
                }
                lines.push(`scene.add(${varBase});`);
                break;
            }
            default: {
                lines.push(`const ${varBase} = new THREE.${type}(${hex}, ${intensity});`);
                lines.push(`${varBase}.name = '${name.replace(/'/g, "\\'")}';`);
                lines.push(`${varBase}.position.set(${px}, ${py}, ${pz});`);
                lines.push(`scene.add(${varBase});`);
                break;
            }
        }
        return lines.join('\n');
    }

    // ── Export complet de Laser ──────────────────────────────────────
    exportLaserData(laser) {
        if (!laser) return null;
        const housing = laser.getHousingGroup();
        const pos = housing ? housing.position : laser.getPosition();

        // Extraire rigoureusement TOUS les paramètres sans aucune exception
        const allParams = {};
        for (const [k, def] of Object.entries(LASER_PARAMS_SCHEMA)) {
            allParams[k] = def.value;
        }
        if (laser.params) {
            for (const [k, v] of Object.entries(laser.params)) {
                if (v && typeof v === 'object' && typeof v.clone === 'function') {
                    allParams[k] = v.clone();
                } else {
                    allParams[k] = v;
                }
            }
        }

        return {
            name: `Laser #${laser.laserId}`,
            type: 'LaserPod',
            position: {
                x: Number(pos.x.toFixed(3)),
                y: Number(pos.y.toFixed(3)),
                z: Number(pos.z.toFixed(3)),
            },
            rotation: {
                angle: Number((allParams.angle !== undefined ? allParams.angle : 0).toFixed(1)),
                tilt:  Number((allParams.tilt !== undefined ? allParams.tilt : 0).toFixed(1)),
                roll:  Number((allParams.roll !== undefined ? allParams.roll : 0).toFixed(1)),
            },
            params: allParams
        };
    }

    generateLaserCode(laser, data) {
        if (!data) data = this.exportLaserData(laser);
        const p = data.params;
        const pos = data.position;
        const rot = data.rotation;

        const lines = [];
        lines.push(`// ==========================================`);
        lines.push(`// Laser exporté : ${data.name} (LaserPod)`);
        lines.push(`// Position 3D : x: ${pos.x}, y: ${pos.y}, z: ${pos.z}`);
        lines.push(`// Orientation : Angle ${rot.angle}°, Tilt ${rot.tilt}°, Roll ${rot.roll}°`);
        lines.push(`// ==========================================`);
        lines.push(`const laserPos = new THREE.Vector3(${pos.x}, ${pos.y}, ${pos.z});`);
        lines.push(`const laserParams = {`);

        const keys = Object.keys(p);
        keys.forEach((k, idx) => {
            const v = p[k];
            const comma = (idx < keys.length - 1) ? ',' : '';
            if (typeof v === 'string') {
                lines.push(`    ${k}: '${v}'${comma}`);
            } else if (typeof v === 'boolean' || typeof v === 'number') {
                lines.push(`    ${k}: ${v}${comma}`);
            } else {
                lines.push(`    ${k}: ${JSON.stringify(v)}${comma}`);
            }
        });
        lines.push(`};`);
        lines.push(``);
        lines.push(`// Création du laser dans le LaserManager :`);
        lines.push(`const { laserShow } = laserManager.addLaser(laserPos, laserParams);`);
        lines.push(`laserShow.setRotation(${rot.angle}, ${rot.tilt}, ${rot.roll});`);

        return lines.join('\n');
    }

    exportSelectedLaser(laser = this.selectedLaser) {
        if (!laser) return;
        const data = this.exportLaserData(laser);
        const jsonStr = JSON.stringify(data, null, 2);
        const jsCode = this.generateLaserCode(laser, data);
        const mockEntry = {
            name: data.name,
            type: 'LaserPod',
            light: null
        };
        this._showExportModal(mockEntry, jsCode, jsonStr);
    }

    copyLaserParams(laser = this.selectedLaser) {
        if (!laser) return;
        this._laserParamsClipboard = {};
        for (const [key, def] of Object.entries(LASER_PARAMS_SCHEMA)) {
            this._laserParamsClipboard[key] = def.value;
        }
        for (const [key, val] of Object.entries(laser.params || {})) {
            if (val && typeof val === 'object' && typeof val.clone === 'function') {
                this._laserParamsClipboard[key] = val.clone();
            } else {
                this._laserParamsClipboard[key] = val;
            }
        }
        try {
            const data = this.exportLaserData(laser);
            navigator.clipboard.writeText(JSON.stringify(data, null, 2));
        } catch (_) {}

        alert(`📋 Tous les paramètres du Laser #${laser.laserId} ont été copiés !`);
        this._buildGui();
    }

    pasteLaserParams(laser = this.selectedLaser) {
        if (!laser || !this._laserParamsClipboard) {
            alert('Aucun paramètre de laser enregistré.');
            return;
        }
        for (const [key, val] of Object.entries(this._laserParamsClipboard)) {
            laser.setParam(key, val);
        }
        if (this._laserInspectorPanel && this._laserInspectorPanel.isOpen) {
            this._laserInspectorPanel.syncFromLaser();
        }
        this._buildGui();
        this._emitSync({
            category: 'laser_param',
            id: laser.laserId,
            params: { ...laser.params }
        });
        alert(`📥 Paramètres appliqués sur le Laser #${laser.laserId} !`);
    }

    duplicateSelectedLaser(laser = this.selectedLaser) {
        if (!laser || !this.laserManager) return;
        const srcParams = laser.params || {};
        const paramsCopy = {};
        for (const [key, def] of Object.entries(LASER_PARAMS_SCHEMA)) {
            paramsCopy[key] = def.value;
        }
        for (const key in srcParams) {
            const v = srcParams[key];
            if (v && typeof v === 'object' && typeof v.clone === 'function') {
                paramsCopy[key] = v.clone();
            } else {
                paramsCopy[key] = v;
            }
        }
        paramsCopy.angle = srcParams.angle !== undefined ? srcParams.angle : 0;
        paramsCopy.tilt  = srcParams.tilt  !== undefined ? srcParams.tilt  : 0;
        paramsCopy.roll  = srcParams.roll  !== undefined ? srcParams.roll  : 0;

        const srcPos = laser.getPosition ? laser.getPosition() : laser.getHousingGroup().position;
        const newPos = srcPos.clone();
        newPos.x += 1.5;
        const { laserShow: newLaser } = this.laserManager.addLaser(newPos, paramsCopy);

        const srcHousing = laser.getHousingGroup();
        const dstHousing = newLaser.getHousingGroup();
        if (srcHousing && dstHousing) {
            dstHousing.rotation.copy(srcHousing.rotation);
            dstHousing.quaternion.copy(srcHousing.quaternion);
            dstHousing.updateMatrixWorld(true);
        }
        if (laser.group && newLaser.group) {
            newLaser.group.rotation.copy(laser.group.rotation);
            newLaser.group.quaternion.copy(laser.group.quaternion);
            newLaser.group.updateMatrixWorld(true);
        }
        newLaser._animTime = laser._animTime;
        newLaser.isPaused = laser.isPaused;

        this.selectLaser(newLaser);
        const housingRot = dstHousing ? {
            angle: Math.round(THREE.MathUtils.radToDeg(dstHousing.rotation.y)),
            tilt: Math.round(THREE.MathUtils.radToDeg(-dstHousing.rotation.x)),
            roll: Math.round(THREE.MathUtils.radToDeg(dstHousing.rotation.z))
        } : { angle: paramsCopy.angle || 0, tilt: paramsCopy.tilt || 0, roll: paramsCopy.roll || 0 };

        this._emitSync({
            category: 'laser_add',
            data: {
                id: newLaser.laserId,
                position: { x: newPos.x, y: newPos.y, z: newPos.z },
                rotation: housingRot,
                params: paramsCopy
            }
        });
        this._logSceneProbe('🔴 LaserPod (Duplication)');
        return newLaser;
    }

    // ── Export de Stroboscope ─────────────────────────────────────────
    exportStrobeData(strobe) {
        if (!strobe) return null;
        const p = strobe.params;
        return {
            name: `Stroboscope #${strobe.number}`,
            type: 'StrobeLight',
            position: {
                x: Number(p.posX.toFixed(3)),
                y: Number(p.posY.toFixed(3)),
                z: Number(p.posZ.toFixed(3)),
            },
            rotation: {
                angle: Number((p.angle !== undefined ? p.angle : 0).toFixed(1)),
                tilt:  Number((p.tilt !== undefined ? p.tilt : 0).toFixed(1)),
                roll:  Number((p.roll !== undefined ? p.roll : 0).toFixed(1)),
            },
            params: { ...p }
        };
    }

    exportSelectedStrobe(strobe = this.selectedStrobe) {
        if (!strobe) return;
        const data = this.exportStrobeData(strobe);
        const jsonStr = JSON.stringify(data, null, 2);
        const lines = [
            `// ==========================================`,
            `// Stroboscope exporté : ${data.name}`,
            `// ==========================================`,
            `strobeManager.addStrobe(`,
            `    new THREE.Vector3(${data.position.x}, ${data.position.y}, ${data.position.z}),`,
            `    ${JSON.stringify(data.params, null, 4)}`,
            `);`
        ];
        const jsCode = lines.join('\n');
        const mockEntry = {
            name: data.name,
            type: 'StrobeLight',
            light: null
        };
        this._showExportModal(mockEntry, jsCode, jsonStr);
    }

    // ── Export de TOUS les Lasers et Stroboscopes de la scène ──────────
    exportAllLasersAndStrobes() {
        const lasers = this.laserManager ? this.laserManager.getAllLasers() : [];
        const strobes = this.strobeManager ? this.strobeManager.getAllStrobes() : [];
        const spots = this.spotManager ? this.spotManager.getAllSpots() : [];

        if (lasers.length === 0 && strobes.length === 0 && spots.length === 0) {
            alert('Aucun laser, stroboscope ou lyre placé dans la scène à exporter.');
            return;
        }

        const lasersData = lasers.map(l => this.exportLaserData(l)).filter(Boolean);
        const strobesData = strobes.map(s => this.exportStrobeData(s)).filter(Boolean);
        const spotsData = spots.map(sp => ({
            id: sp.id,
            name: `Lyre #${sp.number}`,
            type: 'SpotFixture',
            position: { x: sp.params.posX, y: sp.params.posY, z: sp.params.posZ },
            params: { ...sp.params }
        }));

        const fullExport = {
            format: 'soundstage-scene',
            exportDate: new Date().toISOString(),
            totalLights: lasersData.length + strobesData.length + spotsData.length,
            lasersCount: lasersData.length,
            strobesCount: strobesData.length,
            spotsCount: spotsData.length,
            lasers: lasersData,
            strobes: strobesData,
            spots: spotsData
        };

        const jsonStr = JSON.stringify(fullExport, null, 2);

        const lines = [
            `// ==========================================`,
            `// Export Scène SoundStage3D (Lasers, Stroboscopes & Lyres)`,
            `// Total : ${lasersData.length + strobesData.length + spotsData.length} (Lasers: ${lasersData.length}, Strobes: ${strobesData.length}, Lyres: ${spotsData.length})`,
            `// Date : ${new Date().toLocaleString()}`,
            `// ==========================================`,
            ``
        ];

        if (lasersData.length > 0) {
            lines.push(`// ── LASERS (${lasersData.length}) ──────────────────────────`);
            lasersData.forEach((ld, idx) => {
                lines.push(`// Laser #${idx + 1} (${ld.name})`);
                lines.push(`{`);
                lines.push(`    const pos = new THREE.Vector3(${ld.position.x}, ${ld.position.y}, ${ld.position.z});`);
                lines.push(`    const params = ${JSON.stringify(ld.params, null, 4)};`);
                lines.push(`    const { laserShow } = laserManager.addLaser(pos, params);`);
                lines.push(`    laserShow.setRotation(${ld.rotation.angle}, ${ld.rotation.tilt}, ${ld.rotation.roll});`);
                lines.push(`}`);
                lines.push(``);
            });
        }

        if (strobesData.length > 0) {
            lines.push(`// ── STROBOSCOPES (${strobesData.length}) ───────────────────`);
            strobesData.forEach((sd, idx) => {
                lines.push(`// Stroboscope #${idx + 1} (${sd.name})`);
                lines.push(`{`);
                lines.push(`    const pos = new THREE.Vector3(${sd.position.x}, ${sd.position.y}, ${sd.position.z});`);
                lines.push(`    const params = ${JSON.stringify(sd.params, null, 4)};`);
                lines.push(`    strobeManager.addStrobe(pos, params);`);
                lines.push(`}`);
                lines.push(``);
            });
        }

        if (spotsData.length > 0) {
            lines.push(`// ── LYRES (${spotsData.length}) ─────────────────────────────`);
            spotsData.forEach((sd) => {
                lines.push(`// ${sd.name}`);
                lines.push(`spotManager.addSpot(null, ${JSON.stringify(sd.params, null, 4)}, ${JSON.stringify(sd.id)});`);
                lines.push(``);
            });
        }

        const jsCode = lines.join('\n');
        const mockEntry = {
            name: `Export Scène (${lasersData.length} Lasers, ${strobesData.length} Strobes, ${spotsData.length} Lyres)`,
            type: 'GlobalExport',
            light: null
        };
        this._showExportModal(mockEntry, jsCode, jsonStr);
    }

    exportSelectedLight() {
        // 1. Si un Laser est actuellement sélectionné : exporter LE laser !
        if (this.selectedLaser) {
            this.exportSelectedLaser(this.selectedLaser);
            return;
        }

        // 2. Si un Stroboscope est sélectionné : exporter le stroboscope !
        if (this.selectedStrobe) {
            this.exportSelectedStrobe(this.selectedStrobe);
            return;
        }

        // 3. Sinon, exporter la lampe de scène sélectionnée
        let entry = this.selectedEntry;
        if (!entry) {
            if (this.lights.length > 0) {
                entry = this.lights[0];
                this.selectLight(entry);
            } else {
                alert('Aucune lumière à exporter.');
                return;
            }
        }

        const jsonStr = JSON.stringify(this.exportLightData(entry), null, 2);
        const jsCode = this.generateLightCode(entry);

        this._showExportModal(entry, jsCode, jsonStr);
    }

    _createExportModalDOM() {
        if (document.getElementById('ambiance-export-overlay')) {
            this.exportOverlay = document.getElementById('ambiance-export-overlay');
            this.exportModal = document.getElementById('ambiance-export-modal');
            this.exportCodeEl = document.getElementById('ambiance-export-code');
            this.exportToastEl = document.getElementById('ambiance-export-toast');
            this.exportTitleEl = document.getElementById('ambiance-export-title');
            this.exportBadgeEl = document.getElementById('ambiance-export-type-badge');
            this.exportStatusEl = document.getElementById('ambiance-export-status');
            this.exportCopyBtn = document.getElementById('ambiance-export-copy-btn');
            this.exportDownloadBtn = document.getElementById('ambiance-export-download-btn');
            this.tabBtnJs = document.getElementById('ambiance-tab-btn-js');
            this.tabBtnJson = document.getElementById('ambiance-tab-btn-json');
            return;
        }

        const overlay = document.createElement('div');
        overlay.id = 'ambiance-export-overlay';
        overlay.className = 'ambiance-export-overlay hidden';

        overlay.innerHTML = `
            <div id="ambiance-export-modal" class="ambiance-export-modal" role="dialog" aria-modal="true">
                <div class="ambiance-export-header">
                    <div class="ambiance-export-title-wrap">
                        <span class="ambiance-export-title-icon">💾</span>
                        <span class="ambiance-export-title-text" id="ambiance-export-title">Export Lampe</span>
                        <span class="ambiance-export-badge" id="ambiance-export-type-badge">SpotLight</span>
                    </div>
                    <button class="ambiance-export-close-btn" id="ambiance-export-close-btn" title="Fermer (Échap)">✕</button>
                </div>

                <div class="ambiance-export-tabs">
                    <button class="ambiance-export-tab active" id="ambiance-tab-btn-js">⚡ Code Three.js (JS)</button>
                    <button class="ambiance-export-tab" id="ambiance-tab-btn-json">📋 Format JSON</button>
                </div>

                <div class="ambiance-export-content">
                    <div class="ambiance-export-code-box">
                        <pre id="ambiance-export-pre"><code id="ambiance-export-code"></code></pre>
                        <div class="ambiance-export-toast hidden" id="ambiance-export-toast">✅ Copié !</div>
                    </div>

                    <div class="ambiance-export-callout">
                        <span class="ambiance-callout-icon">💡</span>
                        <div class="ambiance-callout-text">
                            <strong>Prêt pour intégration :</strong> Transmettez ce code dans le chat en brut pour qu'il soit directement intégré et figé dans le code du projet.
                        </div>
                    </div>
                </div>

                <div class="ambiance-export-footer">
                    <div class="ambiance-export-status" id="ambiance-export-status">📋 Prêt à copier</div>
                    <div class="ambiance-export-footer-actions">
                        <button class="ambiance-modal-btn secondary" id="ambiance-export-download-btn">📥 Télécharger (.js)</button>
                        <button class="ambiance-modal-btn primary" id="ambiance-export-copy-btn">📋 Copier dans le presse-papier</button>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        this.exportOverlay = overlay;
        this.exportModal = overlay.querySelector('#ambiance-export-modal');
        this.exportCodeEl = overlay.querySelector('#ambiance-export-code');
        this.exportToastEl = overlay.querySelector('#ambiance-export-toast');
        this.exportTitleEl = overlay.querySelector('#ambiance-export-title');
        this.exportBadgeEl = overlay.querySelector('#ambiance-export-type-badge');
        this.exportStatusEl = overlay.querySelector('#ambiance-export-status');
        this.exportCopyBtn = overlay.querySelector('#ambiance-export-copy-btn');
        this.exportDownloadBtn = overlay.querySelector('#ambiance-export-download-btn');
        this.tabBtnJs = overlay.querySelector('#ambiance-tab-btn-js');
        this.tabBtnJson = overlay.querySelector('#ambiance-tab-btn-json');

        const closeBtn = overlay.querySelector('#ambiance-export-close-btn');
        closeBtn.addEventListener('click', () => this._hideExportModal());

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                this._hideExportModal();
            }
        });

        this.tabBtnJs.addEventListener('click', () => this._switchExportTab('js'));
        this.tabBtnJson.addEventListener('click', () => this._switchExportTab('json'));

        this.exportCopyBtn.addEventListener('click', () => this._copyCurrentExport());
        this.exportDownloadBtn.addEventListener('click', () => this._downloadCurrentExport());
    }

    _switchExportTab(tab) {
        this._exportActiveTab = tab;
        if (tab === 'js') {
            this.tabBtnJs.classList.add('active');
            this.tabBtnJson.classList.remove('active');
            this.exportCodeEl.textContent = this._exportJsCode || '';
            this.exportDownloadBtn.textContent = '📥 Télécharger (.js)';
            this.exportStatusEl.textContent = '⚡ Code JavaScript Three.js sélectionné';
        } else {
            this.tabBtnJson.classList.add('active');
            this.tabBtnJs.classList.remove('active');
            this.exportCodeEl.textContent = this._exportJsonStr || '';
            this.exportDownloadBtn.textContent = '📥 Télécharger (.json)';
            this.exportStatusEl.textContent = '📋 Structure JSON sélectionnée';
        }
    }

    async _copyCurrentExport() {
        const text = (this._exportActiveTab === 'json') ? this._exportJsonStr : this._exportJsCode;
        if (!text) return;

        const ok = await this._copyToClipboard(text);
        if (ok) {
            this.exportToastEl.classList.remove('hidden');
            this.exportCopyBtn.textContent = '✅ Copié !';
            this.exportStatusEl.textContent = '✅ Texte copié dans le presse-papier !';
            setTimeout(() => {
                if (this.exportToastEl) this.exportToastEl.classList.add('hidden');
                if (this.exportCopyBtn) this.exportCopyBtn.textContent = '📋 Copier dans le presse-papier';
            }, 1800);
        } else {
            this.exportStatusEl.textContent = '⚠️ Erreur lors de la copie automatique.';
        }
    }

    _downloadCurrentExport() {
        const isJson = (this._exportActiveTab === 'json');
        const text = isJson ? this._exportJsonStr : this._exportJsCode;
        if (!text) return;

        const ext = isJson ? 'json' : 'js';
        const mime = isJson ? 'application/json' : 'text/javascript';
        const safeName = (this._exportEntry && this._exportEntry.name)
            ? this._exportEntry.name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase()
            : 'lampe';
        const filename = `light_${safeName}.${ext}`;

        const blob = new Blob([text], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        this.exportStatusEl.textContent = `💾 Fichier "${filename}" téléchargé !`;
    }

    _showExportModal(entry, jsCode, jsonStr) {
        if (!this.exportOverlay) {
            this._createExportModalDOM();
        }

        this._exportEntry = entry;
        this._exportJsCode = jsCode;
        this._exportJsonStr = jsonStr;
        this._exportModalOpen = true;

        if (this.exportTitleEl) {
            this.exportTitleEl.textContent = `Exporter : ${entry.name || 'Lampe'}`;
        }
        if (this.exportBadgeEl) {
            this.exportBadgeEl.textContent = entry.type || 'Light';
        }

        this._switchExportTab('js');

        this.exportOverlay.classList.remove('hidden');

        // Copie automatique immédiate dans le presse-papier
        this._copyCurrentExport();
    }

    _hideExportModal() {
        this._exportModalOpen = false;
        if (this.exportOverlay) {
            this.exportOverlay.classList.add('hidden');
        }
    }

    async _copyToClipboard(text) {
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(text);
                return true;
            }
        } catch (_) {}

        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.left = '-9999px';
            ta.style.top = '-9999px';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.focus();
            ta.select();
            const success = document.execCommand('copy');
            document.body.removeChild(ta);
            return success;
        } catch (_) {
            return false;
        }
    }

    // ─── 5c. Importation de Configuration Lumière (JSON) ─────────────
    _createImportModalDOM() {
        if (document.getElementById('ambiance-import-overlay')) {
            this.importOverlay = document.getElementById('ambiance-import-overlay');
            this.importTextarea = document.getElementById('ambiance-import-textarea');
            this.importStatusEl = document.getElementById('ambiance-import-status');
            this.importFileEl = document.getElementById('ambiance-import-file');
            return;
        }

        const overlay = document.createElement('div');
        overlay.id = 'ambiance-import-overlay';
        overlay.className = 'ambiance-export-overlay hidden';

        overlay.innerHTML = `
            <div id="ambiance-import-modal" class="ambiance-export-modal" role="dialog" aria-modal="true" style="max-width: 640px;">
                <div class="ambiance-export-header">
                    <div class="ambiance-export-title-wrap">
                        <span class="ambiance-export-title-icon">📥</span>
                        <span class="ambiance-export-title-text">Importer une scène (JSON / JS)</span>
                        <span class="ambiance-export-badge" style="background:rgba(34, 197, 94, 0.15); color:#4ade80; border:1px solid rgba(34, 197, 94, 0.35);">Lasers, Strobes, Lyres & Lampes</span>
                    </div>
                    <button class="ambiance-export-close-btn" id="ambiance-import-close-btn" title="Fermer (Échap)">✕</button>
                </div>

                <div class="ambiance-export-content" style="padding-top:10px;">
                    <div style="font-size:12.5px; color:#94a3b8; line-height:1.5; margin-bottom:10px;">
                        Collez ci-dessous le code JSON ou JavaScript issu de « Exporter scène » (ou d'un export de laser, stroboscope, lyre ou lampe). Une scène complète remplace les lasers, stroboscopes et lyres en place ; chaque projecteur est recréé avec sa position 3D, son orientation et ses réglages.
                    </div>

                    <div class="ambiance-export-code-box" style="padding:0; overflow:hidden; border:1px solid #334155;">
                        <textarea id="ambiance-import-textarea" placeholder="Collez votre code JSON ou code JS Three.js ici..." style="width:100%; height:240px; box-sizing:border-box; background:#0a0f1d; color:#38bdf8; font-family:Consolas, Monaco, monospace; font-size:12px; border:none; padding:12px; outline:none; resize:vertical;"></textarea>
                    </div>

                    <input type="file" id="ambiance-import-file" accept=".json,.js,text/plain,application/json" style="display:none;" />
                </div>

                <div class="ambiance-export-footer" style="flex-wrap:wrap; gap:8px;">
                    <div class="ambiance-export-status" id="ambiance-import-status" style="width:100%; margin-bottom:4px;">📋 En attente de JSON ou code JS...</div>
                    <div style="display:flex; gap:8px; width:100%; justify-content:space-between; align-items:center;">
                        <div style="display:flex; gap:8px;">
                            <button class="ambiance-modal-btn secondary" id="ambiance-import-paste-btn" title="Coller depuis le presse-papier">📋 Coller</button>
                            <button class="ambiance-modal-btn secondary" id="ambiance-import-file-btn" title="Ouvrir un fichier .json ou .js">📁 Fichier JSON / JS</button>
                        </div>
                        <button class="ambiance-modal-btn primary" id="ambiance-import-submit-btn" style="background:#0284c7; color:#ffffff; font-weight:bold;">✨ Créer dans la scène</button>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        this.importOverlay = overlay;
        this.importTextarea = overlay.querySelector('#ambiance-import-textarea');
        this.importStatusEl = overlay.querySelector('#ambiance-import-status');
        this.importFileEl = overlay.querySelector('#ambiance-import-file');

        const closeBtn = overlay.querySelector('#ambiance-import-close-btn');
        closeBtn.addEventListener('click', () => this._hideImportModal());

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) this._hideImportModal();
        });

        // Bouton coller
        const pasteBtn = overlay.querySelector('#ambiance-import-paste-btn');
        pasteBtn.addEventListener('click', async () => {
            try {
                if (navigator.clipboard && navigator.clipboard.readText) {
                    const text = await navigator.clipboard.readText();
                    if (text) {
                        this.importTextarea.value = text;
                        this.importStatusEl.textContent = '📋 Contenu collé depuis le presse-papier.';
                    }
                } else {
                    this.importStatusEl.textContent = '⚠️ Utilisez Ctrl+V dans la zone de texte.';
                }
            } catch (_) {
                this.importStatusEl.textContent = '⚠️ Utilisez Ctrl+V dans la zone de texte.';
            }
        });

        // Bouton charger un fichier
        const fileBtn = overlay.querySelector('#ambiance-import-file-btn');
        fileBtn.addEventListener('click', () => this.importFileEl.click());
        this.importFileEl.addEventListener('change', (e) => {
            const file = e.target.files && e.target.files[0];
            if (file) {
                const reader = new FileReader();
                reader.onload = (evt) => {
                    this.importTextarea.value = evt.target.result;
                    this.importStatusEl.textContent = `📁 Fichier "${file.name}" chargé.`;
                };
                reader.readAsText(file);
            }
        });

        // Bouton soumettre
        const submitBtn = overlay.querySelector('#ambiance-import-submit-btn');
        submitBtn.addEventListener('click', async () => {
            const code = this.importTextarea.value.trim();
            if (!code) {
                this.importStatusEl.textContent = '⚠️ Veuillez coller ou charger du JSON ou du code JS valide d\'abord.';
                return;
            }
            submitBtn.disabled = true;
            submitBtn.style.opacity = '0.6';
            submitBtn.textContent = '⏳ Création en cours...';
            try {
                await this.importLightingFromJson(code);
            } finally {
                submitBtn.disabled = false;
                submitBtn.style.opacity = '1';
                submitBtn.textContent = '✨ Créer dans la scène';
            }
        });
    }

    openImportModal() {
        if (!this.importOverlay) {
            this._createImportModalDOM();
        }
        this._importModalOpen = true;
        if (this.importTextarea) {
            this.importTextarea.value = '';
        }
        if (this.importStatusEl) {
            this.importStatusEl.textContent = '📋 En attente de JSON ou code JS...';
        }
        this.importOverlay.classList.remove('hidden');
        if (this.importTextarea) {
            setTimeout(() => this.importTextarea.focus(), 50);
        }
    }

    _hideImportModal() {
        this._importModalOpen = false;
        if (this.importOverlay) {
            this.importOverlay.classList.add('hidden');
        }
    }

    async importLightingFromJson(input) {
        let parsed = null;
        let isJsCode = false;

        if (typeof input === 'object' && input !== null) {
            parsed = input;
        } else if (typeof input === 'string') {
            const trimmed = input.trim();
            try {
                parsed = JSON.parse(trimmed);
            } catch (jsonErr) {
                // Ce n'est pas un JSON pur : on tente l'exécution comme code JavaScript
                isJsCode = true;
            }
        }

        let createdLasersCount = 0;
        let createdStrobesCount = 0;
        let createdLightsCount = 0;
        let createdSpotsCount = 0;
        let lastCreatedLaser = null;
        let lastCreatedStrobe = null;
        let lastCreatedSpot = null;

        const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));

        if (isJsCode) {
            try {
                const laserManagerAdapter = {
                    addLaser: (pos, params) => {
                        const px = (pos && typeof pos.x === 'number') ? pos.x : 0;
                        const py = (pos && typeof pos.y === 'number') ? pos.y : 12;
                        const pz = (pos && typeof pos.z === 'number') ? pos.z : -4;
                        const vec = new THREE.Vector3(px, py, pz);
                        const res = this.laserManager.addLaser(vec, params || {});
                        if (res && res.laserShow) {
                            createdLasersCount++;
                            lastCreatedLaser = res.laserShow;

                            // Intercepter setRotation pour synchroniser en temps réel
                            const origSetRotation = res.laserShow.setRotation.bind(res.laserShow);
                            res.laserShow.setRotation = (a, t, r) => {
                                origSetRotation(a, t, r);
                                this._emitSync({
                                    category: 'laser_update',
                                    id: res.id,
                                    data: {
                                        rotation: {
                                            angle: res.laserShow.params.angle || 0,
                                            tilt: res.laserShow.params.tilt || 0,
                                            roll: res.laserShow.params.roll || 0
                                        },
                                        params: { ...res.laserShow.params }
                                    }
                                });
                            };

                            this._emitSync({
                                category: 'laser_add',
                                data: {
                                    id: res.id,
                                    position: { x: vec.x, y: vec.y, z: vec.z },
                                    rotation: {
                                        angle: res.laserShow.params.angle || 0,
                                        tilt: res.laserShow.params.tilt || 0,
                                        roll: res.laserShow.params.roll || 0
                                    },
                                    params: { ...res.laserShow.params }
                                }
                            });
                        }
                        return res;
                    },
                    getLaser: (id) => this.laserManager?.getLaser(id),
                    removeLaser: (id) => this.laserManager?.removeLaser(id)
                };

                const strobeManagerAdapter = {
                    addStrobe: (pos, params) => {
                        const px = (pos && typeof pos.x === 'number') ? pos.x : 0;
                        const py = (pos && typeof pos.y === 'number') ? pos.y : 8;
                        const pz = (pos && typeof pos.z === 'number') ? pos.z : -5;
                        const vec = new THREE.Vector3(px, py, pz);
                        const res = this.strobeManager.addStrobe(vec, params || {});
                        if (res && res.strobe) {
                            if (params && (params.angle !== undefined || params.tilt !== undefined || params.roll !== undefined)) {
                                res.strobe.setRotation(params.angle || 0, params.tilt !== undefined ? params.tilt : 0, params.roll || 0);
                            }
                            createdStrobesCount++;
                            lastCreatedStrobe = res.strobe;
                        }
                        return res;
                    },
                    getStrobe: (id) => this.strobeManager?.getStrobe(id),
                    removeStrobe: (id) => this.strobeManager?.removeStrobe(id)
                };

                const spotManagerAdapter = {
                    addSpot: (pos, params, id) => {
                        const res = this._importSpot(params || {}, id || null);
                        if (res) createdSpotsCount++;
                        return res;
                    }
                };

                const fn = new Function('THREE', 'laserManager', 'strobeManager', 'scene', 'spotManager', input);
                fn(THREE, laserManagerAdapter, strobeManagerAdapter, this.scene, spotManagerAdapter);

            } catch (jsErr) {
                if (this.importStatusEl) {
                    this.importStatusEl.innerHTML = `<span style="color:#ef4444">❌ Erreur lors de l'exécution du code : ${jsErr.message}</span>`;
                } else {
                    alert('Erreur lors de l\'importation (JSON / JS) : ' + jsErr.message);
                }
                return { success: false, error: jsErr };
            }
        } else {
            if (!parsed) {
                if (this.importStatusEl) this.importStatusEl.textContent = '⚠️ Aucun objet valide trouvé.';
                return { success: false };
            }

            const lasersToCreate = [];
            const strobesToCreate = [];
            const lightsToCreate = [];
            const spotsToCreate = [];

            if (Array.isArray(parsed)) {
                parsed.forEach(item => {
                    if (!item || typeof item !== 'object') return;
                    const type = item.type || '';
                    if (type === 'SpotFixture') {
                        spotsToCreate.push(item);
                    } else if (type === 'LaserPod' || type.includes('Laser') || item.beamCount !== undefined || item.laserId !== undefined) {
                        lasersToCreate.push(item);
                    } else if (type === 'StrobeLight' || type.includes('Strobe') || item.strobeSpeed !== undefined || (item.params && item.params.strobeSpeed !== undefined)) {
                        strobesToCreate.push(item);
                    } else {
                        lightsToCreate.push(item);
                    }
                });
            } else if (typeof parsed === 'object') {
                if (Array.isArray(parsed.lasers)) {
                    lasersToCreate.push(...parsed.lasers);
                }
                if (Array.isArray(parsed.strobes)) {
                    strobesToCreate.push(...parsed.strobes);
                }
                if (Array.isArray(parsed.lights)) {
                    lightsToCreate.push(...parsed.lights);
                }
                if (Array.isArray(parsed.spots)) {
                    spotsToCreate.push(...parsed.spots);
                }

                if (lasersToCreate.length === 0 && strobesToCreate.length === 0 && lightsToCreate.length === 0 && spotsToCreate.length === 0) {
                    const type = parsed.type || '';
                    if (type === 'SpotFixture') {
                        spotsToCreate.push(parsed);
                    } else if (type === 'LaserPod' || type.includes('Laser') || parsed.beamCount !== undefined) {
                        lasersToCreate.push(parsed);
                    } else if (type === 'StrobeLight' || type.includes('Strobe') || parsed.strobeSpeed !== undefined || (parsed.params && parsed.params.strobeSpeed !== undefined)) {
                        strobesToCreate.push(parsed);
                    } else if (['PointLight', 'SpotLight', 'DirectionalLight', 'AmbientLight', 'HemisphereLight', 'RectAreaLight'].includes(type)) {
                        lightsToCreate.push(parsed);
                    }
                }
            }

            const totalQueue = lasersToCreate.length + strobesToCreate.length + lightsToCreate.length + spotsToCreate.length;
            let processed = 0;

            // Import d'une scène complète : elle REMPLACE les lasers, stroboscopes et lyres en place (pas de doublons)
            if (!Array.isArray(parsed) && parsed.format === 'soundstage-scene') {
                this.deselectLaser();
                this.deselectStrobe();
                this.deselectSpot();
                if (this.laserManager) {
                    for (const l of this.laserManager.getAllLasers()) {
                        const id = l.laserId;
                        this.laserManager.removeLaser(id);
                        this._emitSync({ category: 'laser_remove', id });
                    }
                }
                if (this.strobeManager) {
                    for (const st of this.strobeManager.getAllStrobes()) this.strobeManager.removeStrobe(st.id);
                }
                if (this.spotManager) {
                    const keep = new Set(spotsToCreate.map(sd => sd.id).filter(Boolean));
                    for (const sp of this.spotManager.getAllSpots()) {
                        if (keep.has(sp.id)) continue;
                        this.spotManager.removeSpot(sp.id);
                        this._emitSync({ category: 'spot_remove', id: sp.id });
                    }
                }
            }

            const updateProgress = () => {
                if (this.importStatusEl && totalQueue > 1) {
                    this.importStatusEl.innerHTML = `<span>⏳ Création fluide en cours... (${processed}/${totalQueue})</span>`;
                }
            };

            // 1. Création des lasers (time-sliced par paquets de 2 par frame pour 0 freeze)
            if (this.laserManager && lasersToCreate.length > 0) {
                for (let i = 0; i < lasersToCreate.length; i++) {
                    const ld = lasersToCreate[i];
                    const px = ld.position?.x ?? 0;
                    const py = ld.position?.y ?? 12;
                    const pz = ld.position?.z ?? -4;
                    const pos = new THREE.Vector3(px, py, pz);
                    const params = ld.params || {};

                    const { id, laserShow } = this.laserManager.addLaser(pos, params);
                    if (laserShow) {
                        const rot = ld.rotation || {};
                        const angle = rot.angle !== undefined ? rot.angle : (params.angle || 0);
                        const tilt  = rot.tilt  !== undefined ? rot.tilt  : (params.tilt  || 0);
                        const roll  = rot.roll  !== undefined ? rot.roll  : (params.roll  || 0);
                        laserShow.setRotation(angle, tilt, roll);
                        lastCreatedLaser = laserShow;
                        createdLasersCount++;

                        this._emitSync({
                            category: 'laser_add',
                            data: {
                                id,
                                position: { x: pos.x, y: pos.y, z: pos.z },
                                rotation: { angle, tilt, roll },
                                params: { ...laserShow.params }
                            }
                        });
                    }

                    processed++;
                    updateProgress();
                    if ((i + 1) % 2 === 0 && (i + 1) < lasersToCreate.length) {
                        await nextFrame();
                    }
                }
            }

            // 2. Création des stroboscopes (time-sliced par paquets de 2 par frame)
            if (this.strobeManager && strobesToCreate.length > 0) {
                for (let i = 0; i < strobesToCreate.length; i++) {
                    const sd = strobesToCreate[i];
                    const px = sd.position?.x ?? 0;
                    const py = sd.position?.y ?? 8;
                    const pz = sd.position?.z ?? -5;
                    const pos = new THREE.Vector3(px, py, pz);
                    const params = sd.params || {};

                    const res = this.strobeManager.addStrobe(pos, params);
                    if (res && res.strobe) {
                        const rot = sd.rotation || {};
                        const angle = rot.angle !== undefined ? rot.angle : (params.angle !== undefined ? params.angle : 0);
                        const tilt  = rot.tilt  !== undefined ? rot.tilt  : (params.tilt  !== undefined ? params.tilt  : 0);
                        const roll  = rot.roll  !== undefined ? rot.roll  : (params.roll  !== undefined ? params.roll  : 0);
                        res.strobe.setRotation(angle, tilt, roll);
                        lastCreatedStrobe = res.strobe;
                        createdStrobesCount++;
                    }

                    processed++;
                    updateProgress();
                    if ((i + 1) % 2 === 0 && (i + 1) < strobesToCreate.length) {
                        await nextFrame();
                    }
                }
            }

            // 3. Lyres Spot (une lyre déjà présente avec le même identifiant est mise à jour)
            if (this.spotManager && spotsToCreate.length > 0) {
                for (let i = 0; i < spotsToCreate.length; i++) {
                    const sd = spotsToCreate[i];
                    const params = { ...(sd.params || {}) };
                    if (sd.position && params.posX === undefined) {
                        params.posX = sd.position.x;
                        params.posY = sd.position.y;
                        params.posZ = sd.position.z;
                    }
                    const res = this._importSpot(params, sd.id || null);
                    if (res) {
                        createdSpotsCount++;
                        lastCreatedSpot = res.spot;
                    }
                    processed++;
                    updateProgress();
                    if ((i + 1) % 3 === 0 && (i + 1) < spotsToCreate.length) {
                        await nextFrame();
                    }
                }
            }

            // 4. Création des lumières classiques Three.js
            if (lightsToCreate.length > 0) {
                for (let i = 0; i < lightsToCreate.length; i++) {
                    const lightData = lightsToCreate[i];
                    const created = this._createLightFromExportData(lightData);
                    if (created) createdLightsCount++;
                    processed++;
                    updateProgress();
                    if ((i + 1) % 3 === 0 && (i + 1) < lightsToCreate.length) {
                        await nextFrame();
                    }
                }
            }
        }

        const totalCreated = createdLasersCount + createdStrobesCount + createdLightsCount + createdSpotsCount;

        if (totalCreated === 0) {
            if (this.importStatusEl) {
                this.importStatusEl.innerHTML = `<span style="color:#f59e0b">⚠️ Aucun laser, stroboscope ou lumière valide n'a pu être extrait.</span>`;
            }
            return { success: false, totalCreated: 0 };
        }

        // Reconstruire l'inspecteur une seule fois à la fin
        this._buildGui();

        // Sélectionner le dernier élément créé
        if (lastCreatedStrobe) {
            this.selectStrobe(lastCreatedStrobe);
        } else if (lastCreatedLaser) {
            this.selectLaser(lastCreatedLaser);
        }

        const parts = [];
        if (createdLasersCount > 0) parts.push(`${createdLasersCount} laser(s)`);
        if (createdStrobesCount > 0) parts.push(`${createdStrobesCount} stroboscope(s)`);
        if (createdSpotsCount > 0) parts.push(`${createdSpotsCount} lyre(s)`);
        if (createdLightsCount > 0) parts.push(`${createdLightsCount} lampe(s)`);
        const statusMsg = `✅ Succès : ${parts.join(', ')} créé(s) dans la scène !`;

        if (this.importStatusEl) {
            this.importStatusEl.innerHTML = `<span style="color:#22c55e; font-weight:bold;">${statusMsg}</span>`;
            setTimeout(() => {
                this._hideImportModal();
            }, 1600);
        }

        return {
            success: true,
            totalCreated,
            createdLasersCount,
            createdStrobesCount,
            createdSpotsCount,
            createdLightsCount
        };
    }

    /** Crée une lyre importée, ou met à jour celle qui porte déjà le même identifiant ; synchronise le réseau. */
    _importSpot(params, id) {
        if (!this.spotManager) return null;
        const existing = id ? this.spotManager.getSpot(id) : null;
        if (existing) {
            existing.setParams(params);
            this._emitSync({ category: 'spot_update', id: existing.id, data: { ...existing.params } });
            return { id: existing.id, spot: existing };
        }
        const res = this.spotManager.addSpot(null, params, id);
        if (res && res.spot) {
            this._emitSync({ category: 'spot_add', data: { id: res.id, params: { ...res.spot.params } } });
        }
        return res;
    }

    _createLightFromExportData(data) {
        const type = data.type || 'PointLight';
        const color = new THREE.Color(data.color || data.colorHex || '#ffffff');
        const intensity = data.intensity !== undefined ? data.intensity : 2.0;
        const pos = data.position || { x: 0, y: 5, z: 0 };

        let light = null;
        switch (type) {
            case 'SpotLight':
                light = new THREE.SpotLight(color, intensity);
                light.distance = data.distance || 30.0;
                light.angle = data.angle || THREE.MathUtils.degToRad(data.angleDeg || 35);
                light.penumbra = data.penumbra || 0.4;
                light.decay = data.decay || 1.0;
                light.castShadow = Boolean(data.castShadow);
                if (data.target) {
                    light.target.position.set(data.target.x, data.target.y, data.target.z);
                    this.scene.add(light.target);
                }
                break;
            case 'PointLight':
                light = new THREE.PointLight(color, intensity, data.distance || 25);
                light.decay = data.decay || 1.0;
                light.castShadow = Boolean(data.castShadow);
                break;
            case 'DirectionalLight':
                light = new THREE.DirectionalLight(color, intensity);
                light.castShadow = Boolean(data.castShadow);
                if (data.target) {
                    light.target.position.set(data.target.x, data.target.y, data.target.z);
                    this.scene.add(light.target);
                }
                break;
            case 'RectAreaLight':
                light = new THREE.RectAreaLight(color, intensity, data.width || 4.0, data.height || 2.0);
                break;
            case 'HemisphereLight':
                light = new THREE.HemisphereLight(color, data.groundColor || '#444444', intensity);
                break;
            case 'AmbientLight':
                light = new THREE.AmbientLight(color, intensity);
                break;
            default:
                light = new THREE.PointLight(color, intensity, 25);
                break;
        }

        if (light) {
            light.position.set(pos.x, pos.y, pos.z);
            const entry = this._registerLight(light, data.name || type, type, false);
            return entry;
        }
        return null;
    }

    // ─── 6. Interface lil-gui avec DA de DSP ─────────────────────────
    _buildGui() {
        if (this.gui) {
            this.gui.destroy();
            this.gui = null;
        }
        this._activeControllers = [];

        this.gui = new GUI({
            container: this.panelContainer,
            title: '💡 Ambiance & Éclairage 3D',
            autoPlace: false,
            width: 340,
        });

        // Injecter le texte propre et le bouton de réinitialisation générale (↺ Tout reset) dans le titre du panneau
        const titleEl = this.gui.domElement.querySelector('.title');
        if (titleEl) {
            const rawTitle = '💡 Ambiance & Éclairage 3D';
            titleEl.textContent = ''; // Vider le texte brut injecté par lil-gui pour éviter les retours à la ligne flex

            const textSpan = document.createElement('span');
            textSpan.className = 'lil-panel-title-text';
            textSpan.textContent = rawTitle;
            titleEl.appendChild(textSpan);

            const resetBtn = document.createElement('span');
            resetBtn.setAttribute('role', 'button');
            resetBtn.setAttribute('tabindex', '0');
            resetBtn.className = 'lil-panel-reset-btn';
            resetBtn.title = 'Réinitialiser toutes les lumières et l\'ambiance (↺ Tout reset)';
            resetBtn.textContent = '↺ Tout reset';
            const triggerReset = (e) => {
                e.stopPropagation();
                e.preventDefault();
                this.resetAll();
            };
            resetBtn.addEventListener('click', triggerReset);
            resetBtn.addEventListener('mousedown', (e) => e.stopPropagation());
            resetBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
            resetBtn.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') triggerReset(e);
            });
            titleEl.appendChild(resetBtn);
        }

        // ── Dossier Ambiance Céleste ──
        // Brouillard de salle : panneau dédié (fumée éclairée par les strobes / lyres)
        if (this.hazePanel) {
            this.gui.add({ haze: () => this.hazePanel.toggle() }, 'haze').name('🌫️ Brouillard de salle…');
        }

        const fEnv = this.gui.addFolder('🌌 Ambiance & Ciel');
        fEnv.open();

        // 1. Menu déroulant des 23 ambiances classées
        const presetOptions = {
            // ── ☀️ Plein Jour (6) ──
            '☀️ Plein Jour (Standard)': 'day',
            '☀️ Zénith Méditerranéen': 'day_zenith',
            '🌴 Soleil Tropical Intense': 'day_tropical',
            '☁️ Ciel Voilé Scandinave': 'day_overcast',
            '🌸 Matinée Printanière': 'day_spring',
            '🏜️ Mirage & Brume Déserte': 'day_desert_haze',

            // ── 🌇 Fin de Journée (5) ──
            '🌇 Golden Hour Californienne': 'golden_california',
            '🥉 Couchant Cuivré Ocre': 'golden_copper',
            '🍑 Horizon Pêche & Améthyste': 'golden_peach',
            '🎞️ Rétro Vintage 70s': 'golden_vintage',
            '🔥 Coucher Torride Festival': 'golden_festival',

            // ── 🌅 Crépuscule (6) ──
            '🌅 Crépuscule (Standard)': 'sunset',
            '🌌 Heure Bleue Crépusculaire': 'sunset_blue_hour',
            '🍷 Crépuscule Carmin Sanglant': 'sunset_carmine',
            '🌴 Synthwave 80s Outrun': 'sunset_synthwave',
            '🏜️ Crépuscule Saharien': 'sunset_sahara',
            '🍂 Crépuscule d\'Automne': 'sunset_autumn',

            // ── 🌙 Nuit Noire (6) ──
            '🌙 Nuit (Standard)': 'night',
            '🌌 Nuit Noire d\'Encre (Atacama)': 'night_deep',
            '🌠 Nuit Polaire (Aurore Boréale)': 'night_aurora',
            '🌕 Pleine Lune d\'Argent': 'night_moon',
            '⚡ Nuit Cyberpunk Néon': 'night_cyber',
            '🌩️ Nuit d\'Orage Électrique': 'night_storm',
        };

        this._cPreset = fEnv.add(this.envState, 'presetKey', presetOptions).name('Ambiance');
        this._cPreset.onChange(key => {
            this.applyEnvPreset(key);
        });
        this._setupController(this._cPreset, () => 'night_aurora', (key) => {
            this.applyEnvPreset(key);
        });

        // 2. Réglages des Étoiles
        const fStars = fEnv.addFolder('✨ Voûte Étoilée');

        const cStars = fStars.add(this.envState, 'stars').name('Afficher étoiles');
        cStars.onChange(() => {
            this._updateStarsVisibility();
        });
        this._setupController(cStars, () => this._getEnvPresetDefault('stars'), (v) => {
            this.envState.stars = v;
            this._updateStarsVisibility();
        });

        const cStarSize = fStars.add(this.envState, 'starSize', 0.5, 6.0, 0.1).name('Taille étoiles');
        cStarSize.onChange(val => {
            this.setStarSize(val);
        });
        this._setupController(cStarSize, () => this._getEnvPresetDefault('starSize'), (val) => {
            this.setStarSize(val);
        });

        const cStarCount = fStars.add(this.envState, 'starCount', 500, 12000, 100).name('Nombre d\'étoiles');
        cStarCount.onChange(val => {
            this.setStarCount(val);
        });
        this._setupController(cStarCount, () => this._getEnvPresetDefault('starCount'), (val) => {
            this.setStarCount(val);
        });

        const cStarBright = fStars.add(this.envState, 'starBrightness', 0.1, 3.0, 0.05).name('Brillance');
        cStarBright.onChange(val => {
            this.setStarBrightness(val);
        });
        this._setupController(cStarBright, () => this._getEnvPresetDefault('starBrightness'), (val) => {
            this.setStarBrightness(val);
        });

        // 3. Boost projecteurs scène
        const cBoost = fEnv.add(this.envState, 'stageBoost', 0.2, 3.0, 0.1).name('⚡ Boost scène');
        cBoost.onChange(() => {
            this._updateStageBoost();
        });
        this._setupController(cBoost, () => this._getEnvPresetDefault('stageBoost'), (v) => {
            this.envState.stageBoost = v;
            this._updateStageBoost();
        });

        // ── Dossier Illumination Globale Statique (GI 0 lag) ──
        if (this.staticGI) {
            const fGI = this.gui.addFolder('💡 Illumination Globale Statique (GI)');
            fGI.close();
            this.fGI = fGI;

            const p = this.staticGI.params;

            const cEnabled = fGI.add(p, 'enabled').name('Activer GI');
            cEnabled.onChange(() => {
                this.staticGI.update();
            });
            this._setupController(cEnabled, () => this._getGIDefault('enabled'), (v) => {
                p.enabled = v;
                cEnabled.setValue(v);
                this.staticGI.update();
            });

            const cInt = fGI.add(p, 'intensity', 0, 3.0, 0.05).name('Intensité Globale');
            cInt.onChange(() => {
                this.staticGI.update();
            });
            this._setupController(cInt, () => this._getGIDefault('intensity'), (v) => {
                p.intensity = v;
                cInt.setValue(v);
                this.staticGI.update();
            });

            const cStage = fGI.add(p, 'stageBounceIntensity', 0, 3.0, 0.05).name('Rebond Scène');
            cStage.onChange(() => {
                this.staticGI.update();
            });
            this._setupController(cStage, () => this._getGIDefault('stageBounceIntensity'), (v) => {
                p.stageBounceIntensity = v;
                cStage.setValue(v);
                this.staticGI.update();
            });

            const cRoof = fGI.add(p, 'roofBounceIntensity', 0, 3.0, 0.05).name('Rebond Toit & Truss');
            cRoof.onChange(() => {
                this.staticGI.update();
            });
            this._setupController(cRoof, () => this._getGIDefault('roofBounceIntensity'), (v) => {
                p.roofBounceIntensity = v;
                cRoof.setValue(v);
                this.staticGI.update();
            });

            const cSubs = fGI.add(p, 'subwooferBounceIntensity', 0, 3.0, 0.05).name('Rebond Subwoofers');
            cSubs.onChange(() => {
                this.staticGI.update();
            });
            this._setupController(cSubs, () => this._getGIDefault('subwooferBounceIntensity'), (v) => {
                p.subwooferBounceIntensity = v;
                cSubs.setValue(v);
                this.staticGI.update();
            });

            const cSkyCol = fGI.addColor(p, 'skyColor').name('Teinte Ciel (Diffus)');
            cSkyCol.onChange(() => {
                this.staticGI.update();
                this.staticGI.generateStaticEnvMap();
            });
            this._setupController(cSkyCol, () => this._getGIDefault('skyColor'), (v) => {
                p.skyColor = v;
                cSkyCol.setValue(v);
                this.staticGI.update();
                this.staticGI.generateStaticEnvMap();
            });

            const cGndCol = fGI.addColor(p, 'groundBounceColor').name('Teinte Sol (Herbe)');
            cGndCol.onChange(() => {
                this.staticGI.update();
                this.staticGI.generateStaticEnvMap();
            });
            this._setupController(cGndCol, () => this._getGIDefault('groundBounceColor'), (v) => {
                p.groundBounceColor = v;
                cGndCol.setValue(v);
                this.staticGI.update();
                this.staticGI.generateStaticEnvMap();
            });

            const cStageCol = fGI.addColor(p, 'stageBounceColor').name('Teinte Intérieur Scène');
            cStageCol.onChange(() => {
                this.staticGI.update();
            });
            this._setupController(cStageCol, () => this._getGIDefault('stageBounceColor'), (v) => {
                p.stageBounceColor = v;
                cStageCol.setValue(v);
                this.staticGI.update();
            });

            const cSubsCol = fGI.addColor(p, 'subwooferBounceColor').name('Teinte Subwoofers');
            cSubsCol.onChange(() => {
                this.staticGI.update();
            });
            this._setupController(cSubsCol, () => this._getGIDefault('subwooferBounceColor'), (v) => {
                p.subwooferBounceColor = v;
                cSubsCol.setValue(v);
                this.staticGI.update();
            });
        }

        // ── Dossier Outils 3D ──
        const fTools = this.gui.addFolder('👁️ Outils 3D');
        fTools.open();

        const toolsState = {
            showMarkers: this.markersVisible,
            showSpotCones: this.showSpotCones,
            gizmoMode: this.transformControls.getMode() || 'translate',
            exportAll: () => this.exportAllLasersAndStrobes(),
            importJson: () => this.openImportModal(),
        };

        this._cShowMarkers = fTools.add(toolsState, 'showMarkers').name('💡 Lumières 3D');
        this._cShowMarkers.onChange(val => {
            this.setMarkersVisible(val);
        });
        this._setupController(this._cShowMarkers, () => false, (v) => {
            this.setMarkersVisible(v);
        });

        toolsState.showSoundMarkers = this.soundMarkersVisible;
        this._cShowSoundMarkers = fTools.add(toolsState, 'showSoundMarkers').name('🔊 Ronds émission son');
        this._cShowSoundMarkers.onChange(val => {
            this.setSoundMarkersVisible(val);
        });
        this._setupController(this._cShowSoundMarkers, () => false, (v) => {
            this.setSoundMarkersVisible(v);
        });

        this._cShowSpotCones = fTools.add(toolsState, 'showSpotCones').name('🔦 Cônes SpotLights');
        this._cShowSpotCones.onChange(val => {
            this.setShowSpotCones(val);
        });
        this._setupController(this._cShowSpotCones, () => true, (v) => {
            this.setShowSpotCones(v);
        });

        this._cGizmoMode = fTools.add(toolsState, 'gizmoMode', ['translate', 'rotate']).name('Mode Gizmo');
        this._cGizmoMode.onChange(mode => {
            this.setGizmoMode(mode);
        });

        fTools.add(toolsState, 'exportAll').name('💾 Exporter scène');
        fTools.add(toolsState, 'importJson').name('📥 Importer scène');

        // ── Dossier Ajouter une lumière ──
        const fAdd = this.gui.addFolder('➕ Poser une Lumière');
        fAdd.close();

        const cAddType = fAdd.add(this.creationParams, 'type', [
            'PointLight',
            'SpotLight',
            'DirectionalLight',
            'AmbientLight',
            'HemisphereLight',
            'RectAreaLight',
            '⚡ Stroboscope',
            '🎯 Lyre Spot',
            '🔴 LaserPod',
        ]).name('Type');

        const cAddColor = fAdd.addColor(this.creationParams, 'color').name('Couleur');
        const cAddIntensity = fAdd.add(this.creationParams, 'intensity', 0.1, 20.0, 0.1).name('Intensité');

        const updateAddInputsVisibility = (type) => {
            const isCustom = type === '🔴 LaserPod' || type === '⚡ Stroboscope' || type === '🎯 Lyre Spot' || (typeof type === 'string' && (type.includes('Laser') || type.includes('Stroboscope')));
            if (isCustom) {
                if (cAddColor.hide) cAddColor.hide();
                if (cAddColor.domElement) {
                    cAddColor.domElement.style.setProperty('display', 'none', 'important');
                    cAddColor.domElement.classList.add('hidden');
                }
                if (cAddIntensity.hide) cAddIntensity.hide();
                if (cAddIntensity.domElement) {
                    cAddIntensity.domElement.style.setProperty('display', 'none', 'important');
                    cAddIntensity.domElement.classList.add('hidden');
                }
            } else {
                if (cAddColor.show) cAddColor.show();
                if (cAddColor.domElement) {
                    cAddColor.domElement.style.removeProperty('display');
                    cAddColor.domElement.classList.remove('hidden');
                }
                if (cAddIntensity.show) cAddIntensity.show();
                if (cAddIntensity.domElement) {
                    cAddIntensity.domElement.style.removeProperty('display');
                    cAddIntensity.domElement.classList.remove('hidden');
                }
            }
        };

        cAddType.onChange(val => {
            updateAddInputsVisibility(val);
        });

        // Appliquer l'état initial
        updateAddInputsVisibility(this.creationParams.type);

        const addActions = {
            spawn: () => {
                this.addNewLight(this.creationParams.type, true);
            },
            importJson: () => {
                this.openImportModal();
            }
        };
        fAdd.add(addActions, 'spawn').name('✨ Poser devant moi');
        fAdd.add(addActions, 'importJson').name('📥 Importer depuis JSON');

        // ── Dossier Inspecteur de la lumière sélectionnée ──
        this.fInspector = this.gui.addFolder('🎯 Lumière Sélectionnée');
        this.fInspector.open();
        this._rebuildInspectorGui();

        // ── Dossiers Post-traitement et Bloom (visible uniquement si LaserManager disponible) ──
        if (this.laserManager) {
            // 💡 Bloom Lampes & Scène (Spotlights, ampoules, LEDs DJ — SANS aberration chromatique)
            const fLightsBloom = this.gui.addFolder('💡 Bloom Lampes & Scène');
            fLightsBloom.close();

            const cLightsBloomEn = fLightsBloom.add(globalLaserPostParams, 'lightsBloomEnabled').name('Activer Bloom').onChange(v => {
                this.laserManager.setPostProcessingParam('lightsBloomEnabled', v);
            });
            this._setupController(cLightsBloomEn, () => true, v => this.laserManager.setPostProcessingParam('lightsBloomEnabled', v));

            const cLightsBloomStr = fLightsBloom.add(globalLaserPostParams, 'lightsBloomStrength', 0, 2, 0.05).name('Intensité').onChange(v => {
                this.laserManager.setPostProcessingParam('lightsBloomStrength', v);
            });
            this._setupController(cLightsBloomStr, () => 0.25, v => this.laserManager.setPostProcessingParam('lightsBloomStrength', v));

            const cLightsBloomRad = fLightsBloom.add(globalLaserPostParams, 'lightsBloomRadius', 0, 2, 0.05).name('Rayon').onChange(v => {
                this.laserManager.setPostProcessingParam('lightsBloomRadius', v);
            });
            this._setupController(cLightsBloomRad, () => 0.4, v => this.laserManager.setPostProcessingParam('lightsBloomRadius', v));

            const cLightsBloomThresh = fLightsBloom.add(globalLaserPostParams, 'lightsBloomThreshold', 0, 1, 0.01).name('Seuil').onChange(v => {
                this.laserManager.setPostProcessingParam('lightsBloomThreshold', v);
            });
            this._setupController(cLightsBloomThresh, () => 0.05, v => this.laserManager.setPostProcessingParam('lightsBloomThreshold', v));

            // 🔴 Post-traitement Laser (Bloom Laser + Aberration Chromatique Laser uniquement)
            const fLaser = this.gui.addFolder('🔴 Post-traitement Laser');
            fLaser.close();

            const cPlayerColEn = fLaser.add(globalLaserPostParams, 'playerCollisionEnabled').name('👤 Collision Joueurs').onChange(v => {
                this.laserManager.setPostProcessingParam('playerCollisionEnabled', v);
            });
            this._setupController(cPlayerColEn, () => true, v => this.laserManager.setPostProcessingParam('playerCollisionEnabled', v));

            // Bloom Laser
            const fLaserBloom = fLaser.addFolder('✨ Bloom Laser');
            const cLaserBloomEn = fLaserBloom.add(globalLaserPostParams, 'laserBloomEnabled').name('Activer Bloom').onChange(v => {
                this.laserManager.setPostProcessingParam('laserBloomEnabled', v);
            });
            this._setupController(cLaserBloomEn, () => true, v => this.laserManager.setPostProcessingParam('laserBloomEnabled', v));

            const cLaserBloomStr = fLaserBloom.add(globalLaserPostParams, 'laserBloomStrength', 0, 2, 0.05).name('Intensité').onChange(v => {
                this.laserManager.setPostProcessingParam('laserBloomStrength', v);
            });
            this._setupController(cLaserBloomStr, () => 0.15, v => this.laserManager.setPostProcessingParam('laserBloomStrength', v));

            const cLaserBloomRad = fLaserBloom.add(globalLaserPostParams, 'laserBloomRadius', 0, 2, 0.05).name('Rayon').onChange(v => {
                this.laserManager.setPostProcessingParam('laserBloomRadius', v);
            });
            this._setupController(cLaserBloomRad, () => 0.5, v => this.laserManager.setPostProcessingParam('laserBloomRadius', v));

            const cLaserBloomThresh = fLaserBloom.add(globalLaserPostParams, 'laserBloomThreshold', 0, 1, 0.01).name('Seuil').onChange(v => {
                this.laserManager.setPostProcessingParam('laserBloomThreshold', v);
            });
            this._setupController(cLaserBloomThresh, () => 0.0, v => this.laserManager.setPostProcessingParam('laserBloomThreshold', v));

            // Aberration chromatique (UNIQUEMENT SUR LE LASER)
            const fChroma = fLaser.addFolder('🌈 Aberration Chromatique (Laser)');
            const cChromaEn = fChroma.add(globalLaserPostParams, 'chromaEnabled').name('Activer').onChange(v => {
                this.laserManager.setPostProcessingParam('chromaEnabled', v);
            });
            this._setupController(cChromaEn, () => true, v => this.laserManager.setPostProcessingParam('chromaEnabled', v));

            const cChroma = fChroma.add(globalLaserPostParams, 'chroma', 0, 0.5, 0.01).name('Intensité').onChange(v => {
                this.laserManager.setPostProcessingParam('chroma', v);
            });
            this._setupController(cChroma, () => 0.25, v => this.laserManager.setPostProcessingParam('chroma', v));

            // Fumée scénique
            const fFog = fLaser.addFolder('💨 Fumée Scénique');
            const cFogEn = fFog.add(globalLaserPostParams, 'fogEnabled').name('Activer Fumée').onChange(v => {
                this.laserManager.setPostProcessingParam('fogEnabled', v);
            });
            this._setupController(cFogEn, () => false, v => this.laserManager.setPostProcessingParam('fogEnabled', v));

            const cFogDens = fFog.add(globalLaserPostParams, 'fogDensity', 0, 0.02, 0.0005).name('Densité').onChange(v => {
                this.laserManager.setPostProcessingParam('fogDensity', v);
            });
            this._setupController(cFogDens, () => 0.005, v => this.laserManager.setPostProcessingParam('fogDensity', v));

            const cFogCol = fFog.addColor(globalLaserPostParams, 'fogColor').name('Couleur Fumée').onChange(v => {
                this.laserManager.setPostProcessingParam('fogColor', v);
            });
            this._setupController(cFogCol, () => '#111122', v => this.laserManager.setPostProcessingParam('fogColor', v));
        }

        // Rendre le panneau déplaçable avec la souris sur le titre
        makeDraggable(this.panelWrap, titleEl, 'ambiance');
    }

    _rebuildInspectorGui() {
        if (!this.fInspector) return;

        // Vider le dossier inspecteur existant et rompre toute référence
        this.ctrlPosX = null;
        this.ctrlPosY = null;
        this.ctrlPosZ = null;
        this.ctrlTargetX = null;
        this.ctrlTargetY = null;
        this.ctrlTargetZ = null;
        this._laserPosControllers = null;
        this._laserRotControllers = null;

        while (this.fInspector.controllers.length > 0) {
            this.fInspector.controllers[0].destroy();
        }
        while (this.fInspector.folders.length > 0) {
            this.fInspector.folders[0].destroy();
        }

        // Dropdown de sélection parmi toutes les lumières de la scène (Lumières Three.js + Lasers 3D)
        const lightOptions = {};
        const isAnythingSelected = Boolean(this.selectedEntry || this.selectedLaser || this.selectedStrobe || this.selectedSpot);
        if (!isAnythingSelected) {
            lightOptions['— Choisir une lumière —'] = '';
        } else {
            lightOptions['— Aucune (Désélectionner) —'] = '';
        }

        // 1. Lumières classiques Three.js
        this.lights.forEach(e => {
            lightOptions[e.name] = e.id;
        });

        // 2. Lasers 3D de la scène
        if (this.laserManager) {
            const allLasers = this.laserManager.getAllLasers();
            allLasers.forEach(laser => {
                lightOptions[`🔴 Laser #${laser.laserId}`] = `laser_${laser.laserId}`;
            });
        }

        // 3. Stroboscopes 3D de la scène
        if (this.strobeManager) {
            const allStrobes = this.strobeManager.getAllStrobes();
            allStrobes.forEach(strobe => {
                lightOptions[`⚡ Stroboscope #${strobe.number}`] = `strobe_${strobe.id}`;
            });
        }

        // 4. Lyres Spot
        if (this.spotManager) {
            this.spotManager.getAllSpots().forEach(spot => {
                lightOptions[`🎯 Lyre Spot #${spot.number}`] = `spot_${spot.id}`;
            });
        }

        let currentSelectedId = '';
        if (this.selectedSpot) {
            currentSelectedId = `spot_${this.selectedSpot.id}`;
        } else if (this.selectedEntry) {
            currentSelectedId = this.selectedEntry.id;
        } else if (this.selectedLaser) {
            currentSelectedId = `laser_${this.selectedLaser.laserId}`;
        } else if (this.selectedStrobe) {
            currentSelectedId = `strobe_${this.selectedStrobe.id}`;
        }

        const selObj = { currentId: currentSelectedId };
        const cSelector = this.fInspector.add(selObj, 'currentId', lightOptions).name('Sélection');
        cSelector.onChange(id => {
            if (!id) {
                this.deselectLight();
                return;
            }
            if (typeof id === 'string' && id.startsWith('laser_')) {
                const laserId = parseInt(id.replace('laser_', ''), 10);
                const laser = this.laserManager ? this.laserManager.getLaser(laserId) : null;
                if (laser) {
                    this.selectLaser(laser);
                }
                return;
            }
            if (typeof id === 'string' && id.startsWith('spot_')) {
                const spot = this.spotManager ? this.spotManager.getSpot(id.slice(5)) : null;
                if (spot) this.selectSpot(spot);
                return;
            }
            if (typeof id === 'string' && id.startsWith('strobe_')) {
                const strobeId = parseInt(id.replace('strobe_', ''), 10);
                const strobe = this.strobeManager ? this.strobeManager.getStrobe(strobeId) : null;
                if (strobe) {
                    this.selectStrobe(strobe);
                }
                return;
            }
            const target = this.lights.find(e => e.id === id);
            if (target) {
                this.deselectLaser();
                this.deselectStrobe();
                this.selectLight(target);
            }
        });

        // ── Cas Lyre Spot sélectionnée dans l'inspecteur ──
        if (this.selectedSpot) {
            const spot = this.selectedSpot;
            this._currentInspectorEntry = null;

            const spotActions = {
                exportSpot: () => this.exportSelectedSpot(spot),
                duplicateSpot: () => this.duplicateSelectedSpot(spot),
                deleteSpot: () => this.deleteSelectedSpot(spot),
            };

            const fSpotActions = this.fInspector.addFolder(`🎯 Lyre Spot #${spot.number} - Actions`);
            fSpotActions.open();
            fSpotActions.add(spotActions, 'exportSpot').name('💾 Exporter');
            fSpotActions.add(spotActions, 'duplicateSpot').name('📋 Dupliquer');
            fSpotActions.add(spotActions, 'deleteSpot').name('🗑️ Supprimer');
            return;
        }

        // ── Cas Stroboscope sélectionné dans l'inspecteur ──
        if (this.selectedStrobe) {
            const strobe = this.selectedStrobe;
            this._currentInspectorEntry = null;

            const strobeActions = {
                duplicateStrobe: () => {
                    if (!this.strobeManager) return;
                    const res = this.strobeManager.duplicateStrobe(strobe.id);
                    if (res) this.selectStrobe(res.strobe);
                },
                deleteStrobe: () => {
                    if (!this.strobeManager) return;
                    this.strobeManager.removeStrobe(strobe.id);
                    this.deselectStrobe();
                    this._rebuildInspectorGui();
                }
            };

            const fStrobeActions = this.fInspector.addFolder(`⚡ Stroboscope #${strobe.number} - Actions`);
            fStrobeActions.open();
            fStrobeActions.add({ exportStrobe: () => this.exportSelectedStrobe(strobe) }, 'exportStrobe').name('💾 Exporter');
            fStrobeActions.add(strobeActions, 'duplicateStrobe').name('📋 Dupliquer');
            fStrobeActions.add(strobeActions, 'deleteStrobe').name('🗑️ Supprimer');
            return;
        }

        // ── Cas Laser sélectionné dans l'inspecteur ──
        if (this.selectedLaser) {
            const laser = this.selectedLaser;
            const housing = laser.getHousingGroup();
            this._currentInspectorEntry = null;

            const laserActions = {
                exportLaser: () => this.exportSelectedLaser(laser),
                duplicateLaser: () => this.duplicateSelectedLaser(laser),
                deleteLaser: () => {
                    const id = laser.laserId;
                    this.laserManager.removeLaser(id);
                    this.deselectLaser();
                    this._buildGui();
                    this._emitSync({ category: 'laser_remove', id });
                },
            };

            const fLaserActions = this.fInspector.addFolder(`🔴 Laser #${laser.laserId} - Actions`);
            fLaserActions.open();
            fLaserActions.add(laserActions, 'exportLaser').name('💾 Exporter');
            fLaserActions.add(laserActions, 'duplicateLaser').name('📋 Dupliquer');
            fLaserActions.add(laserActions, 'deleteLaser').name('🗑️ Supprimer');

            // Position 3D du laser dans l'inspecteur
            const fPos = this.fInspector.addFolder('📍 Position 3D Laser');
            fPos.open();

            const p = housing ? housing.position : laser.getPosition();
            const posState = { x: p.x, y: p.y, z: p.z };

            const onLaserPosChange = () => {
                laser.setPosition(posState.x, posState.y, posState.z);
                if (housing) housing.position.set(posState.x, posState.y, posState.z);
                if (this.transformControls && this.transformControls.object === housing) {
                    this.transformControls.updateMatrixWorld();
                }
                if (this._laserInspectorPanel) {
                    this._laserInspectorPanel.syncFromLaser();
                }
                this._emitSync({
                    category: 'laser_transform',
                    id: laser.laserId,
                    data: { position: { x: posState.x, y: posState.y, z: posState.z } }
                });
            };

            const ctrlX = fPos.add(posState, 'x', -100, 100, 0.1).name('Pos X').onChange(onLaserPosChange);
            const ctrlY = fPos.add(posState, 'y', 0, 50, 0.1).name('Pos Y').onChange(onLaserPosChange);
            const ctrlZ = fPos.add(posState, 'z', -100, 100, 0.1).name('Pos Z').onChange(onLaserPosChange);
            this._laserPosControllers = { posX: ctrlX, posY: ctrlY, posZ: ctrlZ, posState };

            // Orientation 3D du laser dans l'inspecteur (Angle horizontal & Inclinaison verticale)
            const fRot = this.fInspector.addFolder('🔄 Orientation Laser');
            fRot.open();

            const rotState = {
                angle: Math.round(laser.params.angle || 0),
                tilt: Math.round(laser.params.tilt || 0),
                roll: Math.round(laser.params.roll || 0),
            };

            const onLaserRotChange = () => {
                laser.setParam('angle', rotState.angle);
                laser.setParam('tilt', rotState.tilt);
                laser.setParam('roll', rotState.roll);
                if (housing) {
                    housing.rotation.set(
                        -rotState.tilt * (Math.PI / 180),
                        rotState.angle * (Math.PI / 180),
                        rotState.roll * (Math.PI / 180),
                        'YXZ'
                    );
                    housing.updateMatrixWorld();
                }
                if (this.transformControls && this.transformControls.object === housing) {
                    this.transformControls.updateMatrixWorld();
                }
                if (this._laserInspectorPanel) {
                    this._laserInspectorPanel.syncFromLaser();
                }
                this._emitSync({
                    category: 'laser_transform',
                    id: laser.laserId,
                    data: { rotation: { angle: rotState.angle, tilt: rotState.tilt, roll: rotState.roll } }
                });
            };

            const ctrlAngle = fRot.add(rotState, 'angle', -180, 180, 1).name('Angle Horiz. (°)').onChange(onLaserRotChange);
            const ctrlTilt = fRot.add(rotState, 'tilt', -90, 90, 1).name('Inclinaison (°)').onChange(onLaserRotChange);
            const ctrlRoll = fRot.add(rotState, 'roll', -180, 180, 1).name('Rotation Axiale (°)').onChange(onLaserRotChange);
            this._laserRotControllers = { ctrlAngle, ctrlTilt, ctrlRoll, rotState };
            this._setupController(ctrlAngle, () => 0, (v) => { rotState.angle = v; ctrlAngle.setValue(v); onLaserRotChange(); });
            this._setupController(ctrlTilt, () => 0, (v) => { rotState.tilt = v; ctrlTilt.setValue(v); onLaserRotChange(); });
            this._setupController(ctrlRoll, () => 0, (v) => { rotState.roll = v; ctrlRoll.setValue(v); onLaserRotChange(); });

            return;
        }

        if (!this.selectedEntry) {
            this._currentInspectorEntry = null;
            return;
        }

        this._currentInspectorEntry = this.selectedEntry;
        const entry = this.selectedEntry;
        const light = entry.light;

        // Boutons d'action pour la lumière
        const lightActions = {
            deselect: () => this.deselectLight(),
            setTranslate: () => this.setGizmoMode('translate'),
            setRotate: () => this.setGizmoMode('rotate'),
            exportLight: () => this.exportSelectedLight(),
            reset: () => this.resetLight(entry),
            duplicate: () => this.duplicateSelectedLight(),
            delete: () => this.removeLight(entry),
        };

        const fActions = this.fInspector.addFolder('⚡ Actions');
        fActions.open();
        fActions.add(lightActions, 'exportLight').name('💾 Exporter cette lampe');
        fActions.add(lightActions, 'reset').name('↺ Reset cette lumière');
        fActions.add(lightActions, 'duplicate').name('📋 Dupliquer');
        if (light.target) {
            lightActions.aimAtMe = () => this.aimSelectedLightAtPlayer();
            fActions.add(lightActions, 'aimAtMe').name('🎯 Viser le joueur');
        }
        if (!entry.isBuiltin) {
            fActions.add(lightActions, 'delete').name('🗑️ Supprimer');
        }

        // ── Propriétés Principales ──
        const fProps = this.fInspector.addFolder('⚙️ Propriétés');
        fProps.open();

        // Visible (ON/OFF)
        const cVis = fProps.add(light, 'visible').name('Activée');
        this._setupController(cVis, () => this.getLightDefaultParam(entry, 'visible'), (v) => { light.visible = v; });

        // Couleur
        const colorProxy = { col: '#' + light.color.getHexString() };
        this._inspectorProxies = { colorProxy, angleProxy: null, groundProxy: null };
        const cColor = fProps.addColor(colorProxy, 'col').name('Couleur');
        cColor.onChange(hex => {
            light.color.set(hex);
            if (entry.markerMesh) {
                const core = entry.markerMesh.children[0];
                if (core) core.material.color.set(hex);
            }
            if (light.userData && light.userData.bulbMesh && light.userData.bulbMesh.material) {
                light.userData.bulbMesh.material.color.set(hex);
            }
        });
        this._setupController(cColor, () => this.getLightDefaultParam(entry, 'color'), (v) => {
            colorProxy.col = v;
            cColor.setValue(v);
        });

        // Intensité
        const cInt = fProps.add(light, 'intensity', 0, (entry.type === 'AmbientLight' || entry.type === 'HemisphereLight') ? 5 : 25, 0.05).name('Intensité');
        this._setupController(cInt, () => this.getLightDefaultParam(entry, 'intensity'), (v) => { light.intensity = v; });

        // ── Position X, Y, Z (pour toutes sauf Ambient) ──
        if (entry.type !== 'AmbientLight') {
            const fPos = this.fInspector.addFolder('📍 Position 3D');
            fPos.open();

            this.ctrlPosX = fPos.add(light.position, 'x', -100, 100, 0.1).name('Pos X');
            this.ctrlPosY = fPos.add(light.position, 'y', 0, 50, 0.1).name('Pos Y');
            this.ctrlPosZ = fPos.add(light.position, 'z', -100, 100, 0.1).name('Pos Z');

            const onPosChange = () => {
                if (entry.markerMesh) entry.markerMesh.position.copy(light.position);
                if (entry.helper && entry.helper.update) entry.helper.update();
            };

            this.ctrlPosX.onChange(onPosChange);
            this.ctrlPosY.onChange(onPosChange);
            this.ctrlPosZ.onChange(onPosChange);

            this._setupController(this.ctrlPosX, () => this.getLightDefaultParam(entry, 'position.x') ?? 0, (v) => { light.position.x = v; onPosChange(); });
            this._setupController(this.ctrlPosY, () => this.getLightDefaultParam(entry, 'position.y') ?? 0, (v) => { light.position.y = v; onPosChange(); });
            this._setupController(this.ctrlPosZ, () => this.getLightDefaultParam(entry, 'position.z') ?? 0, (v) => { light.position.z = v; onPosChange(); });
        }

        // ── Paramètres Spécifiques selon le type ──
        if (entry.type === 'SpotLight') {
            const fSpot = this.fInspector.addFolder('🔦 Cône de Spot');
            fSpot.open();

            // Choix du mode Gizmo : Contrôler la position de la lampe OU de la cible
            const gizmoModeObj = {
                target: (this._gizmoTargetMode === 'target') ? '🎯 Cible' : '📍 Lampe'
            };
            const cGizmoTarget = fSpot.add(gizmoModeObj, 'target', ['📍 Lampe', '🎯 Cible']).name('Gizmo déplace');
            cGizmoTarget.onChange(choice => {
                this._gizmoTargetMode = (choice === '🎯 Cible') ? 'target' : 'lamp';
                this._attachGizmoToCurrentTarget();
            });

            const onSpotChange = () => {
                if (entry.helper && entry.helper.update) entry.helper.update();
            };

            const cDist = fSpot.add(light, 'distance', 0, 150, 1).name('Portée (dist)');
            cDist.onChange(onSpotChange);
            this._setupController(cDist, () => this.getLightDefaultParam(entry, 'distance') ?? 25, (v) => { light.distance = v; onSpotChange(); });

            const angleProxy = { deg: THREE.MathUtils.radToDeg(light.angle) };
            if (this._inspectorProxies) this._inspectorProxies.angleProxy = angleProxy;
            const cAngle = fSpot.add(angleProxy, 'deg', 5, 90, 1).name('Ouverture (°)');
            cAngle.onChange(deg => {
                light.angle = THREE.MathUtils.degToRad(deg);
                onSpotChange();
            });
            this._setupController(cAngle, () => this.getLightDefaultParam(entry, 'angle') ?? 45, (v) => {
                angleProxy.deg = v;
                cAngle.setValue(v);
                onSpotChange();
            });

            const cPen = fSpot.add(light, 'penumbra', 0, 1, 0.05).name('Pénombre');
            cPen.onChange(onSpotChange);
            this._setupController(cPen, () => this.getLightDefaultParam(entry, 'penumbra') ?? 0.4, (v) => { light.penumbra = v; onSpotChange(); });

            const cDec = fSpot.add(light, 'decay', 0, 2, 0.1).name('Décroissance');
            this._setupController(cDec, () => this.getLightDefaultParam(entry, 'decay') ?? 1.0, (v) => { light.decay = v; });
        } else if (entry.type === 'PointLight') {
            const fPoint = this.fInspector.addFolder('💡 Atténuation');
            fPoint.open();

            const cDist = fPoint.add(light, 'distance', 0, 150, 1).name('Distance');
            this._setupController(cDist, () => this.getLightDefaultParam(entry, 'distance') ?? 25, (v) => { light.distance = v; });

            const cDec = fPoint.add(light, 'decay', 0, 2, 0.1).name('Décroissance');
            this._setupController(cDec, () => this.getLightDefaultParam(entry, 'decay') ?? 1.0, (v) => { light.decay = v; });
        } else if (entry.type === 'HemisphereLight') {
            const fHemi = this.fInspector.addFolder('🌱 Couleur Sol');
            fHemi.open();

            const groundProxy = { groundCol: '#' + light.groundColor.getHexString() };
            if (this._inspectorProxies) this._inspectorProxies.groundProxy = groundProxy;
            const cGround = fHemi.addColor(groundProxy, 'groundCol').name('Sol');
            cGround.onChange(hex => light.groundColor.set(hex));
            this._setupController(cGround, () => this.getLightDefaultParam(entry, 'groundColor') || '#4a7a2a', (v) => {
                groundProxy.groundCol = v;
                cGround.setValue(v);
            });
        } else if (entry.type === 'RectAreaLight') {
            const fRect = this.fInspector.addFolder('📐 Dimensions');
            fRect.open();

            const cW = fRect.add(light, 'width', 0.2, 20, 0.2).name('Largeur');
            const cH = fRect.add(light, 'height', 0.2, 20, 0.2).name('Hauteur');
            this._setupController(cW, () => this.getLightDefaultParam(entry, 'width') ?? 4.0,  (v) => { light.width  = v; if (entry.helper && entry.helper.update) entry.helper.update(); });
            this._setupController(cH, () => this.getLightDefaultParam(entry, 'height') ?? 2.0, (v) => { light.height = v; if (entry.helper && entry.helper.update) entry.helper.update(); });

            // ── Atténuation ──
            const fAtten = this.fInspector.addFolder('💡 Atténuation');
            fAtten.open();

            // RectAreaLight n'a pas de .distance natif — on approche via intensity scale
            const attenProxy = {
                distance: light.userData._rectDistance || 0,
                decay:    light.userData._rectDecay    || 0,
            };
            const cDist = fAtten.add(attenProxy, 'distance', 0, 150, 1).name('Distance max (m)');
            const cDec  = fAtten.add(attenProxy, 'decay', 0, 2, 0.1).name('Décroissance');
            cDist.onChange(v => { light.userData._rectDistance = v; });
            cDec.onChange( v => { light.userData._rectDecay    = v; });
            this._setupController(cDist, () => 0,   (v) => { attenProxy.distance = v; cDist.setValue(v); });
            this._setupController(cDec,  () => 0,   (v) => { attenProxy.decay    = v; cDec.setValue(v);  });

            // ── Orientation ──
            const fRectTarget = this.fInspector.addFolder('🎯 Orientation (Cible)');
            fRectTarget.close();

            const rtProxy = {
                tx: light.userData._targetX !== undefined ? light.userData._targetX : light.position.x,
                ty: light.userData._targetY !== undefined ? light.userData._targetY : 0,
                tz: light.userData._targetZ !== undefined ? light.userData._targetZ : light.position.z,
            };
            const onRectLookAt = () => {
                light.lookAt(rtProxy.tx, rtProxy.ty, rtProxy.tz);
                light.userData._targetX = rtProxy.tx;
                light.userData._targetY = rtProxy.ty;
                light.userData._targetZ = rtProxy.tz;
                if (entry.helper && entry.helper.update) entry.helper.update();
            };
            const cRTx = fRectTarget.add(rtProxy, 'tx', -100, 100, 0.5).name('Cible X').onChange(onRectLookAt);
            const cRTy = fRectTarget.add(rtProxy, 'ty', -10,  50,  0.5).name('Cible Y').onChange(onRectLookAt);
            const cRTz = fRectTarget.add(rtProxy, 'tz', -100, 100, 0.5).name('Cible Z').onChange(onRectLookAt);
            this._setupController(cRTx, () => light.position.x, (v) => { rtProxy.tx = v; cRTx.setValue(v); onRectLookAt(); });
            this._setupController(cRTy, () => 0,                (v) => { rtProxy.ty = v; cRTy.setValue(v); onRectLookAt(); });
            this._setupController(cRTz, () => light.position.z, (v) => { rtProxy.tz = v; cRTz.setValue(v); onRectLookAt(); });

            // ── Info ombres ──
            const fRectShadow = this.fInspector.addFolder('🌑 Ombres Portées');
            fRectShadow.close();
            // Three.js ne supporte pas castShadow sur RectAreaLight nativement.
            // Workaround : ajouter une SpotLight invisible couplée si nécessaire.
            const infoProxy = { info: '⚠️ Non supporté par Three.js' };
            fRectShadow.add(infoProxy, 'info').name('Statut').disable();
        }

        // ── Ombres Portées ──
        if (entry.type !== 'AmbientLight' && entry.type !== 'HemisphereLight' && entry.type !== 'RectAreaLight') {
            const fShadow = this.fInspector.addFolder('🌑 Ombres Portées');
            fShadow.close();

            const cCast = fShadow.add(light, 'castShadow').name('Ombre Active');
            this._setupController(cCast, () => this.getLightDefaultParam(entry, 'castShadow'), (v) => { light.castShadow = v; });

            if (light.shadow) {
                const shadowProxy = {
                    mapSize: light.shadow.mapSize ? light.shadow.mapSize.width : 1024,
                    bias: light.shadow.bias || 0,
                    normalBias: light.shadow.normalBias || 0,
                };

                const cRes = fShadow.add(shadowProxy, 'mapSize', [512, 1024, 2048, 4096]).name('Résolution');
                cRes.onChange(sz => {
                    light.shadow.mapSize.set(sz, sz);
                    if (light.shadow.map) light.shadow.map.dispose();
                    light.shadow.map = null;
                });
                this._setupController(cRes, () => this.getLightDefaultParam(entry, 'shadowMapSize') || 1024, (v) => { cRes.setValue(v); });

                const cBias = fShadow.add(shadowProxy, 'bias', -0.005, 0.005, 0.00005).name('Bias');
                cBias.onChange(b => { light.shadow.bias = b; });
                this._setupController(cBias, () => this.getLightDefaultParam(entry, 'shadowBias') ?? 0, (v) => { cBias.setValue(v); });

                const cNormBias = fShadow.add(shadowProxy, 'normalBias', 0, 0.2, 0.005).name('Normal Bias');
                cNormBias.onChange(nb => { light.shadow.normalBias = nb; });
                this._setupController(cNormBias, () => this.getLightDefaultParam(entry, 'shadowNormalBias') ?? 0, (v) => { cNormBias.setValue(v); });
            }
        }

        // ── Orientation de la Cible (pour SpotLight et DirectionalLight) ──
        if (light.target) {
            const fTarget = this.fInspector.addFolder('🎯 Orientation & Cible');
            if (entry.type === 'SpotLight') fTarget.open(); else fTarget.close();

            const targetPos = light.target.position;

            const onTargetChange = () => {
                light.target.updateMatrixWorld(true);
                this._syncLightRotationFromTarget(entry);
                if (entry.helper && entry.helper.update) entry.helper.update();
                this._emitSync({
                    category: 'light_update',
                    id: entry.id,
                    data: {
                        target: { x: targetPos.x, y: targetPos.y, z: targetPos.z },
                        rotation: { x: entry.light.rotation.x, y: entry.light.rotation.y, z: entry.light.rotation.z }
                    }
                });
            };

            this.ctrlTargetX = fTarget.add(targetPos, 'x', -100, 100, 0.1).name('Cible X');
            this.ctrlTargetY = fTarget.add(targetPos, 'y', -10, 50, 0.1).name('Cible Y');
            this.ctrlTargetZ = fTarget.add(targetPos, 'z', -100, 100, 0.1).name('Cible Z');

            this.ctrlTargetX.onChange(onTargetChange);
            this.ctrlTargetY.onChange(onTargetChange);
            this.ctrlTargetZ.onChange(onTargetChange);

            this._setupController(this.ctrlTargetX, () => this.getLightDefaultParam(entry, 'target.x') ?? 0, (v) => { targetPos.x = v; onTargetChange(); });
            this._setupController(this.ctrlTargetY, () => this.getLightDefaultParam(entry, 'target.y') ?? 0, (v) => { targetPos.y = v; onTargetChange(); });
            this._setupController(this.ctrlTargetZ, () => this.getLightDefaultParam(entry, 'target.z') ?? 0, (v) => { targetPos.z = v; onTargetChange(); });
        }
    }

    onSync(cb) {
        if (!this._syncCallbacks) this._syncCallbacks = [];
        this._syncCallbacks.push(cb);
    }

    _emitSync(payload) {
        if (this._isRemoteUpdate) return;
        // Réglages de qualité propres à chaque machine : jamais envoyés au réseau
        if (payload && payload.data && (payload.category === 'light_add' || payload.category === 'light_update')) {
            const data = { ...payload.data };
            for (const k of LOCAL_ONLY_LIGHT_KEYS) delete data[k];
            payload = { ...payload, data };
        }
        if (this._syncCallbacks) {
            for (const cb of this._syncCallbacks) {
                try { cb(payload); } catch (e) { console.error('[AmbiancePanelSync] error:', e); }
            }
        }
    }

    _handleControllerChange(ctrl, val) {
        if (this._isRemoteUpdate) return;
        const obj = ctrl.object;
        const prop = ctrl.property;

        // Outils 3D locaux & Création locale -> pas de synchronisation réseau
        if (obj === this.creationParams || prop === 'showMarkers' || prop === 'showSoundMarkers' || prop === 'showSpotCones' || prop === 'gizmoMode' || prop === 'currentId') {
            return;
        }

        // 1. Ambiance & Ciel
        if (obj === this.envState) {
            this._emitSync({
                category: 'env',
                data: { [prop]: val }
            });
            return;
        }

        // 2. GI Statique
        if (this.staticGI && obj === this.staticGI.params) {
            this._emitSync({
                category: 'gi',
                data: { [prop]: val }
            });
            return;
        }

        // 3. Post-traitement Laser
        if (obj === globalLaserPostParams) {
            if (LOCAL_ONLY_POST_KEYS.has(prop)) return;
            this._emitSync({
                category: 'laser_post',
                data: { [prop]: val }
            });
            return;
        }

        // 4. Laser sélectionné
        if (this.selectedLaser) {
            const laser = this.selectedLaser;
            if (this._laserPosControllers && obj === this._laserPosControllers.posState) {
                this._emitSync({
                    category: 'laser_transform',
                    id: laser.laserId,
                    data: { position: { x: obj.x, y: obj.y, z: obj.z } }
                });
                return;
            }
            if (this._laserRotControllers && obj === this._laserRotControllers.rotState) {
                this._emitSync({
                    category: 'laser_transform',
                    id: laser.laserId,
                    data: { rotation: { angle: obj.angle, tilt: obj.tilt, roll: obj.roll } }
                });
                return;
            }
        }

        // 5. Lumière sélectionnée
        if (this.selectedEntry) {
            if (LOCAL_ONLY_LIGHT_KEYS.has(prop)) return;
            const entry = this.selectedEntry;
            const changes = {};
            if (prop === 'col') {
                changes.color = val;
            } else if (prop === 'groundCol' || prop === 'groundColor') {
                changes.groundColor = val;
            } else if (prop === 'deg' || prop === 'angle') {
                changes.angle = typeof val === 'number' ? val : THREE.MathUtils.radToDeg(entry.light.angle);
            } else if (prop === 'x' || prop === 'y' || prop === 'z') {
                if (obj === entry.light.position) {
                    changes.position = { x: entry.light.position.x, y: entry.light.position.y, z: entry.light.position.z };
                } else if (entry.light.target && obj === entry.light.target.position) {
                    changes.target = { x: entry.light.target.position.x, y: entry.light.target.position.y, z: entry.light.target.position.z };
                }
            } else {
                changes[prop] = val;
            }
            this._emitSync({
                category: 'light_update',
                id: entry.id,
                data: changes
            });
        }
    }

    /**
     * Injecte le bouton de reset individuel (↺) dans chaque ligne de contrôleur lil-gui
     */
    _setupController(ctrl, getDefaultVal, applyVal) {
        if (!ctrl || !ctrl.domElement) return;

        const origOnChange = ctrl._onChange;
        ctrl.onChange((val) => {
            if (origOnChange) origOnChange.call(ctrl, val);
            this._handleControllerChange(ctrl, val);
        });

        const resetBtn = document.createElement('button');
        resetBtn.className = 'lil-reset-btn';
        resetBtn.title = 'Réinitialiser ce paramètre (↺)';
        resetBtn.innerHTML = '↺';

        resetBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const defVal = getDefaultVal();
            applyVal(defVal);
            ctrl.setValue(defVal);
            this._handleControllerChange(ctrl, defVal);
        });

        const widgetEl = ctrl.domElement.querySelector('.widget');
        if (widgetEl) {
            widgetEl.appendChild(resetBtn);
        } else {
            ctrl.domElement.appendChild(resetBtn);
        }
    }

    _syncGuiPosition() {
        if (this._isSwitchingLight || !this.selectedEntry) return;
        if (this._currentInspectorEntry !== this.selectedEntry) return;

        const p = this.selectedEntry.light.position;
        if (this.ctrlPosX && typeof this.ctrlPosX.setValue === 'function') {
            this.ctrlPosX.setValue(p.x);
        }
        if (this.ctrlPosY && typeof this.ctrlPosY.setValue === 'function') {
            this.ctrlPosY.setValue(p.y);
        }
        if (this.ctrlPosZ && typeof this.ctrlPosZ.setValue === 'function') {
            this.ctrlPosZ.setValue(p.z);
        }
    }

    _syncGuiTarget() {
        if (this._isSwitchingLight || !this.selectedEntry) return;
        if (this._currentInspectorEntry !== this.selectedEntry) return;
        if (!this.selectedEntry.light || !this.selectedEntry.light.target) return;

        const tp = this.selectedEntry.light.target.position;
        if (this.ctrlTargetX && typeof this.ctrlTargetX.setValue === 'function') {
            this.ctrlTargetX.setValue(tp.x);
        }
        if (this.ctrlTargetY && typeof this.ctrlTargetY.setValue === 'function') {
            this.ctrlTargetY.setValue(tp.y);
        }
        if (this.ctrlTargetZ && typeof this.ctrlTargetZ.setValue === 'function') {
            this.ctrlTargetZ.setValue(tp.z);
        }
    }

    _attachGizmoToCurrentTarget() {
        if (!this.selectedEntry || this.selectedEntry.type === 'AmbientLight') return;
        const entry = this.selectedEntry;
        const targetObj = (this._gizmoTargetMode === 'target' && entry.light.target)
            ? entry.light.target
            : entry.light;

        this.transformControls.detach();
        this.transformControls.attach(targetObj);
        this.transformControls.visible = this.isOpen && this.gizmoVisible;
        this.transformControls.enabled = this.isOpen && this.gizmoVisible;
    }

    // ─── 7. Toggle & Événements ──────────────────────────────────────
    toggle(forceState) {
        this.isOpen = (forceState !== undefined) ? forceState : !this.isOpen;

        if (this.panelWrap) {
            this.panelWrap.classList.toggle('hidden', !this.isOpen);
        }
        if (this.ambianceBtn) {
            this.ambianceBtn.classList.toggle('active', this.isOpen);
        }

        if (this.isOpen) {
            // Ouvrir : afficher les repères et attacher le gizmo si une lumière est sélectionnée
            this.markersGroup.visible = this.markersVisible;
            if (this.selectedEntry && this.selectedEntry.type !== 'AmbientLight') {
                this._attachGizmoToCurrentTarget();
            }
            this._updateAllHelpersVisibility();

            // Déverrouiller le pointeur souris pour permettre l'interaction fluide
            if (this.listener && this.listener.controls.isLocked) {
                this.listener.unlock();
            }
        } else {
            // Quitter le mode Gizmo & fermer : détachement et masquage complet
            this._hideExportModal();
            this._hideImportModal();
            this.deselectLaser();
            this.deselectStrobe();
            this.deselectSpot();
            this.transformControls.detach();
            this.transformControls.visible = false;
            this.transformControls.enabled = false;
            this.markersGroup.visible = false;
            this.helpersGroup.visible = false;
        }

        return this.isOpen;
    }

    _bindEvents() {
        // Bouton Ambiance dans le HUD
        if (this.ambianceBtn) {
            this.ambianceBtn.addEventListener('click', (e) => {
                if (e.target.id === 'ambiance-reset-all-btn' || e.target.closest('#ambiance-reset-all-btn')) {
                    e.stopPropagation();
                    this.resetAll();
                    return;
                }
                this.toggle();
            });
        }

        // Bouton reset-all directement
        if (this.ambianceResetAllBtn) {
            this.ambianceResetAllBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.resetAll();
            });
        }

        // Clic sur le canvas pour la sélection 3D de lumière et laser
        const dom = this.renderer.domElement;
        dom.addEventListener('pointerdown', (e) => {
            this.handleCanvasClick(e);
        });

        // Raccourcis clavier (Échap pour quitter le mode Gizmo ou fermer le panneau)
        window.addEventListener('keydown', (e) => {
            // Suppr : supprime l'élément sélectionné (mêmes actions que les boutons « 🗑️ Supprimer »)
            if (e.code === 'Delete' && this.isOpen && !this._importModalOpen && !this._exportModalOpen) {
                const t = e.target;
                const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
                if (!typing && this._deleteSelectedWithKey()) {
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                }
            }
            if (e.code === 'Escape') {
                if (this._importModalOpen) {
                    this._hideImportModal();
                    e.stopPropagation();
                    return;
                }
                if (this._exportModalOpen) {
                    this._hideExportModal();
                    e.stopPropagation();
                    return;
                }
                if (this.selectedLaser || (this._laserInspectorPanel && this._laserInspectorPanel.isOpen)) {
                    if (this._laserInspectorPanel && this._laserInspectorPanel.isOpen) {
                        this._laserInspectorPanel.close();
                    }
                    this.deselectLaser();
                    e.stopPropagation();
                    return;
                }
                if (this.selectedSpot || (this._spotInspectorPanel && this._spotInspectorPanel.isOpen)) {
                    this.deselectSpot();
                    e.stopPropagation();
                    return;
                }
                if (this.selectedStrobe || (this._strobeInspectorPanel && this._strobeInspectorPanel.isOpen)) {
                    if (this._strobeInspectorPanel && this._strobeInspectorPanel.isOpen) {
                        this._strobeInspectorPanel.close();
                    }
                    this.deselectStrobe();
                    e.stopPropagation();
                    return;
                }
                if (this.isOpen) {
                    if (this.selectedEntry) {
                        // 1er Échap : désélectionne la lumière et quitte le mode Gizmo
                        this.deselectLight();
                    } else {
                        // 2ème Échap : ferme le menu Ambiance et rend la main au joueur
                        this.toggle(false);
                    }
                    e.stopPropagation();
                    return;
                }
            }

            if (!this.isOpen || this.isDraggingGizmo) return;
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

            if (e.key === 'g' || e.key === 'G') {
                this.setGizmoMode('translate');
            } else if (e.key === 'r' || e.key === 'R') {
                this.setGizmoMode('rotate');
            }
        });
    }

    update(dt) {
        // Mettre à jour l'orientation et l'animation des repères si nécessaire
        if (this.markersVisible) {
            this.lights.forEach(entry => {
                if (entry.markerMesh && entry.markerMesh.visible) {
                    // Faire osciller très subtilement l'anneau externe pour le repérer de loin
                    const ring = entry.markerMesh.children[1];
                    if (ring) {
                        ring.rotation.z += dt * 0.8;
                    }
                }
                // Maintenir la visée et la forme des cônes de SpotLight synchronisées
                if (entry.type === 'SpotLight' && entry.helper && entry.helper.visible && entry.helper.update) {
                    entry.helper.update();
                }
            });
        }

        // Mettre à jour la position et la rotation céleste lente des étoiles
        if (this.starfield && this.starfield.visible) {
            if (this.camera) {
                this.starfield.position.copy(this.camera.position);
            }
            this.starfield.rotation.y += dt * 0.0006;
        }
    }
}
