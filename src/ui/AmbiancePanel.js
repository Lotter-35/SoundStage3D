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
        this.lights = []; // [{ id, name, light, type, isBuiltin, markerMesh, helper, defaultConfig }]
        this._nextId = 1;

        // Groupes 3D pour repères et helpers
        this.markersGroup = new THREE.Group();
        this.markersGroup.name = 'ambiance-markers-group';
        this.scene.add(this.markersGroup);

        this.helpersGroup = new THREE.Group();
        this.helpersGroup.name = 'ambiance-helpers-group';
        this.scene.add(this.helpersGroup);

        this.markersVisible = true;
        this.isDraggingGizmo = false;

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

        // Construction du GUI
        this._buildGui();

        // Événements boutons et clic raycast
        this._bindEvents();
    }

    // ─── 1. TransformControls (Gizmo 3D) ──────────────────────────────
    _initTransformControls() {
        this.transformControls = new TransformControls(this.camera, this.renderer.domElement);
        this.transformControls.size = 0.85;
        this.transformControls.setMode('translate');

        // Éviter tout conflit avec la caméra / listener pendant le glissement du gizmo
        this.transformControls.addEventListener('dragging-changed', (event) => {
            this.isDraggingGizmo = event.value;
            if (this.listener) {
                if (event.value) {
                    this.listener.resetMovement();
                    this.listener.controls.enabled = false;
                } else {
                    this.listener.controls.enabled = true;
                }
            }
        });

        // Quand le gizmo déplace la lumière, synchroniser les repères et l'UI
        this.transformControls.addEventListener('change', () => {
            if (this.selectedEntry) {
                const entry = this.selectedEntry;
                if (entry.markerMesh) {
                    entry.markerMesh.position.copy(entry.light.position);
                }
                if (entry.helper && entry.helper.update) {
                    entry.helper.update();
                }
                this._syncGuiPosition();
            }
        });

        // Cacher le gizmo par défaut
        this.transformControls.enabled = false;
        this.scene.add(this.transformControls);
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

        // Sélectionner par défaut la première lumière s'il y en a une
        if (this.lights.length > 0) {
            this.selectLight(this.lights[0]);
        }
    }

    /**
     * Enregistre une lumière dans le gestionnaire.
     * @param {THREE.Light} light
     * @param {boolean} [isBuiltin=false]
     * @param {string} [customName]
     */
    registerLight(light, isBuiltin = false, customName = null) {
        if (!light || this.lights.some(e => e.light === light)) return;

        let type = 'PointLight';
        if (light.isSpotLight) type = 'SpotLight';
        else if (light.isDirectionalLight) type = 'DirectionalLight';
        else if (light.isAmbientLight) type = 'AmbientLight';
        else if (light.isHemisphereLight) type = 'HemisphereLight';
        else if (light.isRectAreaLight) type = 'RectAreaLight';

        const id = 'light_' + (this._nextId++);
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
                const helper = new THREE.SpotLightHelper(light);
                helper.visible = false;
                helper.userData.isAmbianceInternal = true;
                return helper;
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

    // ─── 3. Sélection & Clic 3D ──────────────────────────────────────
    selectLight(entry) {
        this.selectedEntry = entry;

        if (!entry || entry.type === 'AmbientLight') {
            this.transformControls.detach();
            this.transformControls.enabled = false;
        } else {
            this.transformControls.attach(entry.light);
            this.transformControls.enabled = this.isOpen;
        }

        // Mettre en valeur le repère sélectionné
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
            if (e.helper) {
                e.helper.visible = (e === entry) && this.markersVisible && this.isOpen;
                if (e.helper.update) e.helper.update();
            }
        });

        // Reconstruire la section de l'inspecteur pour la lumière sélectionnée
        this._rebuildInspectorGui();
    }

    setMarkersVisible(val) {
        this.markersVisible = Boolean(val);
        this.markersGroup.visible = this.markersVisible;
        if (this.helpersGroup) {
            this.helpersGroup.visible = this.markersVisible && this.isOpen;
        }
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

    handleCanvasClick(event) {
        if (!this.isOpen || this.isDraggingGizmo) return;
        // Si la souris survole ou manipule une flèche du Gizmo, ignorer la sélection
        if (this.transformControls && (this.transformControls.axis !== null || this.transformControls.dragging)) return;

        const rect = this.renderer.domElement.getBoundingClientRect();
        this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        this.raycaster.setFromCamera(this.mouse, this.camera);

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
                light.castShadow = true;
                light.shadow.bias = -0.0001;
                break;

            case 'SpotLight':
                light = new THREE.SpotLight(color, intensity);
                light.position.copy(spawnPos);
                light.distance = this.creationParams.distance;
                light.angle = THREE.MathUtils.degToRad(this.creationParams.angle);
                light.penumbra = this.creationParams.penumbra;
                light.castShadow = true;
                light.target.position.set(spawnPos.x, Math.max(0, spawnPos.y - 4), spawnPos.z);
                this.scene.add(light.target);
                break;

            case 'DirectionalLight':
                light = new THREE.DirectionalLight(color, intensity);
                light.position.copy(spawnPos);
                light.castShadow = true;
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

            default:
                light = new THREE.PointLight(color, intensity, 25);
                light.position.copy(spawnPos);
                break;
        }

        this.scene.add(light);
        const entry = this.registerLight(light, false);
        this.selectLight(entry);

        // Reconstruire le GUI pour mettre à jour la liste
        this._buildGui();
        return entry;
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
    }

    duplicateSelectedLight() {
        if (!this.selectedEntry) return;
        const src = this.selectedEntry;
        const entry = this.addNewLight(src.type, false);
        if (entry) {
            entry.light.color.copy(src.light.color);
            entry.light.intensity = src.light.intensity;
            entry.light.position.copy(src.light.position).add(new THREE.Vector3(1.0, 0, 1.0));
            if (entry.markerMesh) entry.markerMesh.position.copy(entry.light.position);
            this.selectLight(entry);
        }
    }

    // ─── 5. Réinitialisation Unitaire & Globale ──────────────────────
    resetLight(entry) {
        if (!entry || !entry.defaultConfig) return;
        const def = entry.defaultConfig;
        const light = entry.light;

        light.color.set(def.color);
        light.intensity = def.intensity;
        light.visible = def.visible;
        light.position.set(def.position.x, def.position.y, def.position.z);
        light.castShadow = def.castShadow;

        if (entry.type === 'SpotLight') {
            light.distance = def.distance;
            light.angle = THREE.MathUtils.degToRad(def.angle);
            light.penumbra = def.penumbra;
            light.decay = def.decay;
            if (light.target && def.target) {
                light.target.position.set(def.target.x, def.target.y, def.target.z);
            }
        } else if (entry.type === 'PointLight') {
            light.distance = def.distance;
            light.decay = def.decay;
        } else if (entry.type === 'HemisphereLight') {
            light.groundColor.set(def.groundColor);
        } else if (entry.type === 'RectAreaLight') {
            light.width = def.width;
            light.height = def.height;
        } else if (entry.type === 'DirectionalLight' && light.target && def.target) {
            light.target.position.set(def.target.x, def.target.y, def.target.z);
        }

        if (entry.markerMesh) {
            entry.markerMesh.position.copy(light.position);
            const core = entry.markerMesh.children[0];
            if (core) core.material.color.copy(light.color);
        }

        if (entry.helper && entry.helper.update) {
            entry.helper.update();
        }

        this._rebuildInspectorGui();
    }

    resetAll() {
        // Supprimer toutes les lumières créées par l'utilisateur
        const created = this.lights.filter(e => !e.isBuiltin);
        created.forEach(e => this.removeLight(e));

        // Réinitialiser toutes les lumières de base
        this.lights.forEach(e => {
            if (e.isBuiltin) this.resetLight(e);
        });

        // Remettre la première en sélection
        if (this.lights.length > 0) {
            this.selectLight(this.lights[0]);
        }
        this._buildGui();
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
            width: 320,
        });

        // Injecter le bouton de réinitialisation générale (↺ Tout reset) dans le titre du panneau
        const titleEl = this.gui.domElement.querySelector('.title');
        if (titleEl) {
            const resetBtn = document.createElement('button');
            resetBtn.className = 'lil-panel-reset-btn';
            resetBtn.title = 'Réinitialiser toutes les lumières et l\'ambiance (↺ Tout reset)';
            resetBtn.innerHTML = '↺ Tout reset';
            resetBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.resetAll();
            });
            titleEl.appendChild(resetBtn);
        }

        // ── Dossier Outils Généraux & Gizmo ──
        const fTools = this.gui.addFolder('👁️ Outils 3D & Affichage');
        fTools.open();

        const toolsState = {
            showMarkers: this.markersVisible,
            toggleMarkers: () => {
                this.setMarkersVisible(!this.markersVisible);
            },
            focusLight: () => {
                this.focusSelectedLight();
            },
            gizmoMode: this.transformControls.getMode() || 'translate',
        };

        this._cShowMarkers = fTools.add(toolsState, 'showMarkers').name('Repères 3D');
        this._cShowMarkers.onChange(val => {
            this.setMarkersVisible(val);
        });

        fTools.add(toolsState, 'toggleMarkers').name('💡 Afficher / Cacher lumières');
        fTools.add(toolsState, 'focusLight').name('🎯 Voir la lumière (Focus)');

        const cMode = fTools.add(toolsState, 'gizmoMode', ['translate', 'rotate']).name('Mode Gizmo');
        cMode.onChange(mode => {
            this.transformControls.setMode(mode);
        });

        // ── Dossier Ajouter une lumière ──
        const fAdd = this.gui.addFolder('➕ Poser une Lumière');
        fAdd.close();

        fAdd.add(this.creationParams, 'type', [
            'PointLight',
            'SpotLight',
            'DirectionalLight',
            'AmbientLight',
            'HemisphereLight',
            'RectAreaLight',
        ]).name('Type');

        fAdd.addColor(this.creationParams, 'color').name('Couleur');
        fAdd.add(this.creationParams, 'intensity', 0.1, 20.0, 0.1).name('Intensité');

        const addActions = {
            spawn: () => {
                this.addNewLight(this.creationParams.type, true);
            }
        };
        fAdd.add(addActions, 'spawn').name('✨ Poser devant moi');

        // ── Dossier Inspecteur de la lumière sélectionnée ──
        this.fInspector = this.gui.addFolder('🎯 Lumière Sélectionnée');
        this.fInspector.open();
        this._rebuildInspectorGui();

        // Rendre le panneau déplaçable avec la souris sur le titre
        makeDraggable(this.panelWrap, titleEl, 'ambiance');
    }

    _rebuildInspectorGui() {
        if (!this.fInspector) return;

        // Vider le dossier inspecteur existant
        while (this.fInspector.controllers.length > 0) {
            this.fInspector.controllers[0].destroy();
        }
        while (this.fInspector.folders.length > 0) {
            this.fInspector.folders[0].destroy();
        }

        if (!this.selectedEntry) {
            const noSel = { info: 'Aucune lumière sélectionnée' };
            this.fInspector.add(noSel, 'info').name('Statut').disable();
            return;
        }

        const entry = this.selectedEntry;
        const light = entry.light;
        const def = entry.defaultConfig;

        // Dropdown de sélection rapide parmi toutes les lumières
        const lightOptions = {};
        this.lights.forEach(e => {
            lightOptions[e.name] = e.id;
        });

        const selObj = { currentId: entry.id };
        const cSelector = this.fInspector.add(selObj, 'currentId', lightOptions).name('Sélection');
        cSelector.onChange(id => {
            const target = this.lights.find(e => e.id === id);
            if (target) this.selectLight(target);
        });

        // Boutons d'action pour la lumière
        const lightActions = {
            reset: () => this.resetLight(entry),
            duplicate: () => this.duplicateSelectedLight(),
            delete: () => this.removeLight(entry),
        };

        const fActions = this.fInspector.addFolder('⚡ Actions');
        fActions.open();
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
        this._setupController(cVis, () => def.visible, (v) => { light.visible = v; });

        // Couleur
        const colorProxy = { col: '#' + light.color.getHexString() };
        const cColor = fProps.addColor(colorProxy, 'col').name('Couleur');
        cColor.onChange(hex => {
            light.color.set(hex);
            if (entry.markerMesh) {
                const core = entry.markerMesh.children[0];
                if (core) core.material.color.set(hex);
            }
        });
        this._setupController(cColor, () => def.color, (v) => {
            colorProxy.col = v;
            cColor.setValue(v);
        });

        // Intensité
        const cInt = fProps.add(light, 'intensity', 0, (entry.type === 'AmbientLight' || entry.type === 'HemisphereLight') ? 5 : 25, 0.05).name('Intensité');
        this._setupController(cInt, () => def.intensity, (v) => { light.intensity = v; });

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

            this._setupController(this.ctrlPosX, () => def.position.x, (v) => { light.position.x = v; onPosChange(); });
            this._setupController(this.ctrlPosY, () => def.position.y, (v) => { light.position.y = v; onPosChange(); });
            this._setupController(this.ctrlPosZ, () => def.position.z, (v) => { light.position.z = v; onPosChange(); });
        }

        // ── Paramètres Spécifiques selon le type ──
        if (entry.type === 'SpotLight') {
            const fSpot = this.fInspector.addFolder('🔦 Cône de Spot');
            fSpot.open();

            const cDist = fSpot.add(light, 'distance', 0, 150, 1).name('Distance');
            this._setupController(cDist, () => def.distance, (v) => { light.distance = v; });

            const angleProxy = { deg: THREE.MathUtils.radToDeg(light.angle) };
            const cAngle = fSpot.add(angleProxy, 'deg', 5, 90, 1).name('Angle (°)');
            cAngle.onChange(deg => {
                light.angle = THREE.MathUtils.degToRad(deg);
                if (entry.helper && entry.helper.update) entry.helper.update();
            });
            this._setupController(cAngle, () => def.angle, (v) => {
                angleProxy.deg = v;
                cAngle.setValue(v);
            });

            const cPen = fSpot.add(light, 'penumbra', 0, 1, 0.05).name('Pénombre');
            this._setupController(cPen, () => def.penumbra, (v) => { light.penumbra = v; });

            const cDec = fSpot.add(light, 'decay', 0, 2, 0.1).name('Décroissance');
            this._setupController(cDec, () => def.decay, (v) => { light.decay = v; });
        } else if (entry.type === 'PointLight') {
            const fPoint = this.fInspector.addFolder('💡 Atténuation');
            fPoint.open();

            const cDist = fPoint.add(light, 'distance', 0, 150, 1).name('Distance');
            this._setupController(cDist, () => def.distance, (v) => { light.distance = v; });

            const cDec = fPoint.add(light, 'decay', 0, 2, 0.1).name('Décroissance');
            this._setupController(cDec, () => def.decay, (v) => { light.decay = v; });
        } else if (entry.type === 'HemisphereLight') {
            const fHemi = this.fInspector.addFolder('🌱 Couleur Sol');
            fHemi.open();

            const groundProxy = { col: '#' + light.groundColor.getHexString() };
            const cGround = fHemi.addColor(groundProxy, 'col').name('Sol');
            cGround.onChange(hex => light.groundColor.set(hex));
            this._setupController(cGround, () => def.groundColor, (v) => {
                groundProxy.col = v;
                cGround.setValue(v);
            });
        } else if (entry.type === 'RectAreaLight') {
            const fRect = this.fInspector.addFolder('📐 Dimensions');
            fRect.open();

            const cW = fRect.add(light, 'width', 0.2, 20, 0.2).name('Largeur');
            const cH = fRect.add(light, 'height', 0.2, 20, 0.2).name('Hauteur');
            this._setupController(cW, () => def.width, (v) => { light.width = v; });
            this._setupController(cH, () => def.height, (v) => { light.height = v; });
        }

        // ── Ombres Portées ──
        if (entry.type !== 'AmbientLight' && entry.type !== 'HemisphereLight' && entry.type !== 'RectAreaLight') {
            const fShadow = this.fInspector.addFolder('🌑 Ombres Portées');
            fShadow.close();

            const cCast = fShadow.add(light, 'castShadow').name('Ombre Active');
            this._setupController(cCast, () => def.castShadow, (v) => { light.castShadow = v; });

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
                this._setupController(cRes, () => def.shadowMapSize || 1024, (v) => { cRes.setValue(v); });

                const cBias = fShadow.add(shadowProxy, 'bias', -0.005, 0.005, 0.00005).name('Bias');
                cBias.onChange(b => { light.shadow.bias = b; });
                this._setupController(cBias, () => def.shadowBias || 0, (v) => { cBias.setValue(v); });

                const cNormBias = fShadow.add(shadowProxy, 'normalBias', 0, 0.2, 0.005).name('Normal Bias');
                cNormBias.onChange(nb => { light.shadow.normalBias = nb; });
                this._setupController(cNormBias, () => def.shadowNormalBias || 0, (v) => { cNormBias.setValue(v); });
            }
        }

        // ── Orientation de la Cible (pour SpotLight et DirectionalLight) ──
        if (light.target) {
            const fTarget = this.fInspector.addFolder('🎯 Orientation & Cible');
            fTarget.close();

            const targetPos = light.target.position;
            const defTarget = def.target || { x: targetPos.x, y: targetPos.y, z: targetPos.z };

            const onTargetChange = () => {
                light.target.updateMatrixWorld();
                if (entry.helper && entry.helper.update) entry.helper.update();
            };

            const cTx = fTarget.add(targetPos, 'x', -100, 100, 0.1).name('Cible X');
            const cTy = fTarget.add(targetPos, 'y', -10, 50, 0.1).name('Cible Y');
            const cTz = fTarget.add(targetPos, 'z', -100, 100, 0.1).name('Cible Z');

            cTx.onChange(onTargetChange);
            cTy.onChange(onTargetChange);
            cTz.onChange(onTargetChange);

            this._setupController(cTx, () => defTarget.x, (v) => { targetPos.x = v; onTargetChange(); });
            this._setupController(cTy, () => defTarget.y, (v) => { targetPos.y = v; onTargetChange(); });
            this._setupController(cTz, () => defTarget.z, (v) => { targetPos.z = v; onTargetChange(); });
        }
    }

    /**
     * Injecte le bouton de reset individuel (↺) dans chaque ligne de contrôleur lil-gui
     */
    _setupController(ctrl, getDefaultVal, applyVal) {
        if (!ctrl || !ctrl.domElement) return;

        const resetBtn = document.createElement('button');
        resetBtn.className = 'lil-reset-btn';
        resetBtn.title = 'Réinitialiser ce paramètre (↺)';
        resetBtn.innerHTML = '↺';

        resetBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const defVal = getDefaultVal();
            applyVal(defVal);
            ctrl.setValue(defVal);
        });

        const widgetEl = ctrl.domElement.querySelector('.widget');
        if (widgetEl) {
            widgetEl.appendChild(resetBtn);
        } else {
            ctrl.domElement.appendChild(resetBtn);
        }
    }

    _syncGuiPosition() {
        if (!this.selectedEntry) return;
        const p = this.selectedEntry.light.position;
        if (this.ctrlPosX) this.ctrlPosX.setValue(p.x);
        if (this.ctrlPosY) this.ctrlPosY.setValue(p.y);
        if (this.ctrlPosZ) this.ctrlPosZ.setValue(p.z);
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

        // Activer / désactiver TransformControls et helpers
        this.transformControls.enabled = this.isOpen && (this.selectedEntry && this.selectedEntry.type !== 'AmbientLight');
        if (this.selectedEntry && this.selectedEntry.helper) {
            this.selectedEntry.helper.visible = this.isOpen && this.markersVisible;
        }

        // Si le panneau s'ouvre, déverrouiller le pointeur souris pour permettre l'interaction fluide
        if (this.isOpen && this.listener && this.listener.controls.isLocked) {
            this.listener.unlock();
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

        // Clic sur le canvas pour la sélection 3D de lumière
        const dom = this.renderer.domElement;
        dom.addEventListener('pointerdown', (e) => {
            if (this.isOpen) {
                this.handleCanvasClick(e);
            }
        });

        // Raccourcis clavier quand le panneau est ouvert (W = Déplacement, E = Rotation)
        window.addEventListener('keydown', (e) => {
            if (!this.isOpen || this.isDraggingGizmo) return;
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

            if (e.key === 'w' || e.key === 'W') {
                this.transformControls.setMode('translate');
            } else if (e.key === 'e' || e.key === 'E') {
                this.transformControls.setMode('rotate');
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
            });
        }
    }
}
