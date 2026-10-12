/**
 * FixtureSelection.js — Sélection multiple des lumières de la scène (lasers, stroboscopes, lyres, barres LED,
 * lumières posées), en mode curseur (Tab) ou panneau Ambiance ouvert :
 *
 *   - glisser sur l'écran dans le vide : sélection rectangulaire (Ctrl / Maj : ajoute à la sélection) ;
 *   - Ctrl + clic sur une lumière : l'ajoute à la sélection, ou l'en retire si elle y était ;
 *   - sélection de plusieurs lumières : un seul gizmo au centre du groupe les déplace (G) ou les fait pivoter
 *     autour du centre (R, chaque appareil tourne aussi sur lui-même) ; Suppr les
 *     supprime toutes ; Dupliquer (bandeau, Ctrl + D ou bouton d'un inspecteur) les copie toutes à 1,5 m
 *     sur la droite, disposition conservée, et la sélection passe sur les copies ; les réglages changés dans l'inspecteur ouvert (celui de la lumière « de référence »)
 *     s'appliquent à toutes les lumières du même type (position, orientation du support et adresse DMX exceptées) ;
 *   - un bandeau résume la sélection : type à modifier, supprimer, désélectionner (Échap).
 *
 * Tout passe par les mêmes messages que les modifications une par une (synchro multijoueur, sauvegarde du monde).
 */

import * as THREE from 'three';

const DRAG_THRESHOLD = 6; // pixels avant de commencer un rectangle
const KIND_LABELS = { laser: 'lasers', strobe: 'stroboscopes', spot: 'lyres', ledbar: 'barres LED', laser2: 'lasers (points)', light: 'lumières' };
const KIND_LABEL_ONE = { laser: 'laser', strobe: 'stroboscope', spot: 'lyre', ledbar: 'barre LED', laser2: 'laser (points)', light: 'lumière' };
/** Réglages propres à chaque appareil : jamais recopiés sur le reste de la sélection */
const PER_FIXTURE_KEYS = new Set(['posX', 'posY', 'posZ', 'yaw', 'pitch', 'roll', 'position', 'rotation', 'target',
    'dmxAddress', 'dmxUniverse', 'dmx']);
/** Message émis par l'inspecteur d'un type d'appareil quand un réglage change */
const UPDATE_CATEGORY = { laser: 'laser_param', strobe: 'strobe_update', spot: 'spot_update', ledbar: 'ledbar_update', laser2: 'laser2_update', light: 'light_update' };

const _v = new THREE.Vector3();
const _d = new THREE.Vector3();
const _dq = new THREE.Quaternion();
const _e = new THREE.Euler();
/** Décalage commun des copies d'une sélection (même vecteur pour toutes : la disposition est conservée) */
const DUPLICATE_OFFSET = new THREE.Vector3(1.5, 0, 0);

export class FixtureSelection {
    /**
     * @param {object} o
     * @param {import('./AmbiancePanel.js').AmbiancePanel} o.ambiancePanel
     * @param {THREE.Camera} o.camera
     * @param {THREE.WebGLRenderer} o.renderer
     * @param {THREE.Scene} o.scene
     * @param {object} o.listener
     * @param {Function} o.LightingSync classe LightingSync (applique localement les réglages recopiés)
     */
    constructor({ ambiancePanel, camera, renderer, scene, listener, LightingSync }) {
        this.ap = ambiancePanel;
        this.camera = camera;
        this.dom = renderer.domElement;
        this.scene = scene;
        this.listener = listener;
        /** @type {Map<string, {kind: string, obj: any}>} */
        this.items = new Map();
        this.primaryKind = null;
        this._applier = new LightingSync({ mp: null, ambiancePanel, laserManager: ambiancePanel.laserManager, staticGI: null, scene });
        this._mirroring = false;
        this._press = null;   // { x, y, ctrl, rect: bool }
        this._groupActive = false;
        this._duplicating = false;
        this._frame = 0;

        // Pivot du gizmo de groupe (centre de la sélection)
        this._pivot = new THREE.Object3D();
        this._pivot.name = 'fixture-selection-pivot';
        this._pivot.userData.isAmbianceInternal = true;
        scene.add(this._pivot);
        this._lastPivot = new THREE.Vector3();
        this._lastPivotQ = new THREE.Quaternion();

        // Repères des éléments sélectionnés (cube filaire, toujours visible)
        this._markerGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
        this._markerMat = new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.8 });
        this._markers = new THREE.Group();
        this._markers.name = 'fixture-selection-markers';
        this._markers.renderOrder = 999;
        scene.add(this._markers);

        this._buildDom();
        this._wireEvents();
    }

    // ── Accès aux appareils ─────────────────────────────────────────────

    _idOf(kind, obj) {
        if (kind === 'laser') return obj.laserId;
        return obj.id;
    }

    _key(kind, obj) {
        return `${kind}:${this._idOf(kind, obj)}`;
    }

    _kindOfFixture(obj) {
        if (obj && obj.isLaser2) return 'laser2';
        return obj && obj.isLedBar ? 'ledbar' : 'spot';
    }

    /** Position monde de l'appareil (pour le rectangle et le centre du groupe) */
    _worldPos(item, out) {
        const { kind, obj } = item;
        if (kind === 'laser') return (obj.getHousingGroup() || obj.group).getWorldPosition(out);
        if (kind === 'light') return out.copy(obj.light.position);
        return obj.group.getWorldPosition(out);
    }

    /** Tous les appareils sélectionnables actuellement */
    _allItems() {
        const ap = this.ap;
        const out = [];
        if (ap.laserManager) for (const l of ap.laserManager.getAllLasers()) out.push({ kind: 'laser', obj: l });
        if (ap.strobeManager) for (const s of ap.strobeManager.getAllStrobes()) out.push({ kind: 'strobe', obj: s });
        if (ap.spotManager) for (const s of ap.spotManager.getAllSpots()) out.push({ kind: 'spot', obj: s });
        if (ap.ledBarManager) for (const b of ap.ledBarManager.getAllBars()) out.push({ kind: 'ledbar', obj: b });
        if (ap.laser2Manager) for (const l of ap.laser2Manager.getAllLasers()) out.push({ kind: 'laser2', obj: l });
        // Lumières posées : seulement quand leurs repères sont visibles (panneau Ambiance ouvert)
        if (ap.isOpen) {
            for (const e of ap.lights) {
                if (!e.isBuiltin && e.markerMesh && e.markerMesh.visible && e.type !== 'AmbientLight' && e.type !== 'HemisphereLight') {
                    out.push({ kind: 'light', obj: e });
                }
            }
        }
        return out;
    }

    /** Appareil sous le pointeur (mêmes tests que le clic du panneau Ambiance) */
    _pick(clientX, clientY) {
        const ap = this.ap;
        const rect = this.dom.getBoundingClientRect();
        const mouse = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
        const rc = new THREE.Raycaster();
        rc.setFromCamera(mouse, this.camera);
        if (ap.laserManager && ap.laserManager.count > 0) {
            const hit = rc.intersectObjects(ap.laserManager.getLaserObjects(), true)[0];
            const l = hit && ap.laserManager.getLaserFromObject(hit.object);
            if (l) return { kind: 'laser', obj: l };
        }
        if (ap.strobeManager && ap.strobeManager.count > 0) {
            const hit = rc.intersectObjects(ap.strobeManager.getStrobeObjects(), true)[0];
            const s = hit && ap.strobeManager.getStrobeFromObject(hit.object);
            if (s) return { kind: 'strobe', obj: s };
        }
        if (ap.spotManager && ap.spotManager.count > 0) {
            const hit = rc.intersectObjects(ap.spotManager.getSpotObjects(), false)[0];
            const s = hit && ap.spotManager.getSpotFromObject(hit.object);
            if (s) return { kind: 'spot', obj: s };
        }
        if (ap.ledBarManager && ap.ledBarManager.count > 0) {
            const hit = rc.intersectObjects(ap.ledBarManager.getBarObjects(), false)[0];
            const b = hit && ap.ledBarManager.getBarFromObject(hit.object);
            if (b) return { kind: 'ledbar', obj: b };
        }
        if (ap.laser2Manager && ap.laser2Manager.count > 0) {
            const hit = rc.intersectObjects(ap.laser2Manager.getLaserObjects(), false)[0];
            const l = hit && ap.laser2Manager.getLaserFromObject(hit.object);
            if (l) return { kind: 'laser2', obj: l };
        }
        if (ap.isOpen) {
            const meshes = [];
            for (const e of ap.lights) {
                if (e.isBuiltin || !e.markerMesh || !e.markerMesh.visible) continue;
                e.markerMesh.traverse(c => { if (c.isMesh) { c.userData.entry = e; meshes.push(c); } });
            }
            const hit = rc.intersectObjects(meshes, false)[0];
            if (hit && hit.object.userData.entry) return { kind: 'light', obj: hit.object.userData.entry };
        }
        return null;
    }

    /** Élément actuellement sélectionné seul dans le panneau Ambiance */
    _currentSingle() {
        const ap = this.ap;
        if (ap.selectedLaser) return { kind: 'laser', obj: ap.selectedLaser };
        if (ap.selectedStrobe) return { kind: 'strobe', obj: ap.selectedStrobe };
        if (ap.selectedSpot) return { kind: this._kindOfFixture(ap.selectedSpot), obj: ap.selectedSpot };
        if (ap.selectedEntry && !ap.selectedEntry.isBuiltin) return { kind: 'light', obj: ap.selectedEntry };
        return null;
    }

    // ── Sélection ───────────────────────────────────────────────────────

    get count() { return this.items.size; }

    has(item) { return this.items.has(this._key(item.kind, item.obj)); }

    /** Remplace (ou complète) la sélection */
    setItems(list, additive = false) {
        if (!additive) this.items.clear();
        for (const it of list) this.items.set(this._key(it.kind, it.obj), it);
        this._afterChange(list.length ? list[0].kind : null);
    }

    toggle(item) {
        const k = this._key(item.kind, item.obj);
        if (this.items.has(k)) this.items.delete(k);
        else this.items.set(k, item);
        this._afterChange(this.items.has(k) ? item.kind : null);
    }

    /** Vide la sélection multiple (la sélection simple du panneau Ambiance n'est pas touchée) */
    clear() {
        if (this.items.size === 0 && !this._groupActive) return;
        this.items.clear();
        this._leaveGroup();
        this._refreshMarkers();
        this._refreshBar();
    }

    /** Vide tout : sélection multiple et sélection simple */
    deselectAll() {
        this.clear();
        const ap = this.ap;
        ap.deselectLaser();
        ap.deselectStrobe();
        ap.deselectSpot();
        ap.deselectLight();
    }

    _afterChange(preferKind) {
        const kinds = this._kinds();
        if (!kinds.has(this.primaryKind)) this.primaryKind = kinds.has(preferKind) ? preferKind : (kinds.keys().next().value || null);
        if (this.items.size === 1) {
            // Un seul élément : sélection habituelle (gizmo et réglages de cet élément)
            const only = this.items.values().next().value;
            this._leaveGroup();
            this._selectSingle(only);
        } else if (this.items.size >= 2) {
            this._enterGroup();
        } else {
            this._leaveGroup();
            this.deselectAllSingles();
        }
        this._refreshMarkers();
        this._refreshBar();
    }

    deselectAllSingles() {
        const ap = this.ap;
        ap.deselectLaser();
        ap.deselectStrobe();
        ap.deselectSpot();
        if (ap.selectedEntry) ap.deselectLight();
    }

    _kinds() {
        const m = new Map();
        for (const it of this.items.values()) m.set(it.kind, (m.get(it.kind) || 0) + 1);
        return m;
    }

    _primary() {
        for (const it of this.items.values()) if (it.kind === this.primaryKind) return it;
        return null;
    }

    _selectSingle(item) {
        const ap = this.ap;
        if (!item) return;
        if (item.kind === 'laser') ap.selectLaser(item.obj);
        else if (item.kind === 'strobe') ap.selectStrobe(item.obj);
        else if (item.kind === 'light') ap.selectLight(item.obj);
        else ap.selectSpot(item.obj);
    }

    // ── Groupe : gizmo commun et inspecteur de référence ───────────────

    _enterGroup() {
        const ap = this.ap;
        // Inspecteur de la lumière de référence (ses réglages sont recopiés sur les autres du même type)
        this._groupActive = false;
        ap._groupGizmoActive = false;
        this._selectSingle(this._primary());
        this._groupActive = true;
        ap._groupGizmoActive = true;
        this._centerPivot();
        const tc = ap.transformControls;
        tc.detach();
        if (tc.getMode() !== 'translate') tc.setMode('translate');
        tc.attach(this._pivot);
        tc.visible = true;
        tc.enabled = true;
    }

    _leaveGroup() {
        const ap = this.ap;
        if (!this._groupActive) return;
        this._groupActive = false;
        ap._groupGizmoActive = false;
        if (ap.transformControls.object === this._pivot) {
            ap.transformControls.detach();
            ap.transformControls.visible = false;
            ap.transformControls.enabled = false;
        }
    }

    _centerPivot() {
        const c = new THREE.Vector3();
        let n = 0;
        for (const it of this.items.values()) { c.add(this._worldPos(it, _v)); n++; }
        if (n) c.multiplyScalar(1 / n);
        this._pivot.position.copy(c);
        this._pivot.quaternion.identity();
        this._pivot.updateMatrixWorld(true);
        this._lastPivot.copy(c);
        this._lastPivotQ.identity();
    }

    /** Déplace un appareil d'un vecteur (monde) */
    _moveItem(item, d) {
        const { kind, obj } = item;
        if (kind === 'laser') {
            const p = obj.getPosition();
            obj.setPosition(p.x + d.x, p.y + d.y, p.z + d.z);
        } else if (kind === 'strobe') {
            const p = obj.params;
            obj.setPosition(p.posX + d.x, p.posY + d.y, p.posZ + d.z);
        } else if (kind === 'light') {
            obj.light.position.add(d);
            obj.light.updateMatrixWorld();
            if (obj.light.target) { obj.light.target.position.add(d); obj.light.target.updateMatrixWorld(); }
            if (obj.markerMesh) obj.markerMesh.position.copy(obj.light.position);
            if (obj.helper && obj.helper.update) obj.helper.update();
        } else {
            obj.isBeingDragged = true;
            obj.group.position.add(d);
            obj.group.updateMatrixWorld(true);
            obj.syncFromGizmo();
        }
        this._emitPlacement(item, false);
    }

    /** Fait pivoter un appareil de dq autour du point c (position autour du centre + orientation propre) */
    _rotateItem(item, dq, c) {
        const { kind, obj } = item;
        // Position : tourne autour du centre du groupe
        this._worldPos(item, _v);
        _d.copy(_v).sub(c).applyQuaternion(dq).add(c).sub(_v);
        if (kind === 'light') {
            const l = obj.light;
            l.position.sub(c).applyQuaternion(dq).add(c);
            l.updateMatrixWorld();
            if (l.target) { l.target.position.sub(c).applyQuaternion(dq).add(c); l.target.updateMatrixWorld(); }
            if (obj.markerMesh) obj.markerMesh.position.copy(l.position);
            if (obj.helper && obj.helper.update) obj.helper.update();
            this._emitPlacement(item, false);
            return;
        }
        if (_d.lengthSq() > 1e-12) this._moveItem(item, _d);
        // Orientation propre
        if (kind === 'laser') {
            const h = obj.getHousingGroup();
            h.quaternion.premultiply(dq);
            h.updateMatrixWorld(true);
            _e.setFromQuaternion(h.quaternion, 'YXZ');
            obj.setParam('angle', Math.round(THREE.MathUtils.radToDeg(_e.y)));
            obj.setParam('tilt', Math.round(THREE.MathUtils.radToDeg(-_e.x)));
            obj.setParam('roll', Math.round(THREE.MathUtils.radToDeg(_e.z)));
        } else if (kind === 'strobe') {
            obj.group.quaternion.premultiply(dq);
            obj.group.updateMatrixWorld(true);
            obj.syncRotationFromGizmo(); // envoie sa mise à jour
            return;
        } else {
            obj.isBeingDragged = true;
            obj.group.quaternion.premultiply(dq);
            obj.group.updateMatrixWorld(true);
            obj.syncFromGizmo();
        }
        this._emitPlacement(item, false);
    }

    _emitPlacement(item, immediate) {
        const ap = this.ap;
        const { kind, obj } = item;
        if (kind === 'laser') {
            const pos = obj.getPosition();
            ap._emitSync({
                category: 'laser_transform', id: obj.laserId, immediate,
                data: {
                    position: { x: pos.x, y: pos.y, z: pos.z },
                    rotation: { angle: obj.params.angle || 0, tilt: obj.params.tilt || 0, roll: obj.params.roll || 0 },
                },
            });
        } else if (kind === 'spot' || kind === 'ledbar' || kind === 'laser2') {
            ap._emitSync({ category: `${kind}_update`, id: obj.id, data: obj.getPlacement(), immediate });
        } else if (kind === 'light') {
            const l = obj.light;
            const data = { position: { x: l.position.x, y: l.position.y, z: l.position.z } };
            if (l.target) data.target = { x: l.target.position.x, y: l.target.position.y, z: l.target.position.z };
            ap._emitSync({ category: 'light_update', id: obj.id, data, immediate });
        }
        // Stroboscopes : setPosition envoie déjà sa mise à jour
    }

    // ── Réglages recopiés sur toute la sélection ────────────────────────

    /** Un réglage de l'élément de référence a changé : même réglage pour les autres éléments du même type */
    _mirror(payload) {
        if (this._mirroring || this.items.size < 2 || !payload) return;
        const primary = this._primary();
        if (!primary || payload.category !== UPDATE_CATEGORY[primary.kind]) return;
        if (String(payload.id) !== String(this._idOf(primary.kind, primary.obj))) return;
        let data = payload.data;
        if (payload.category === 'laser_param') {
            if (PER_FIXTURE_KEYS.has(payload.param)) return;
        } else {
            if (!data || typeof data !== 'object') return;
            data = {};
            for (const [k, v] of Object.entries(payload.data)) if (!PER_FIXTURE_KEYS.has(k)) data[k] = v;
            if (Object.keys(data).length === 0) return;
        }
        this._mirroring = true;
        try {
            for (const it of this.items.values()) {
                if (it === primary || it.kind !== primary.kind) continue;
                const ev = { ...payload, id: this._idOf(it.kind, it.obj), data };
                this._applier.handleRemoteUpdate(ev); // application locale (sans renvoi réseau)
                this._origEmit(ev);                  // puis envoi réseau / sauvegarde, comme un réglage manuel
            }
        } finally {
            this._mirroring = false;
        }
    }

    // ── Suppression ─────────────────────────────────────────────────────

    deleteAll() {
        const ap = this.ap;
        const list = [...this.items.values()];
        this.items.clear();
        this._leaveGroup();
        this.deselectAllSingles();
        let lasersRemoved = false;
        for (const { kind, obj } of list) {
            if (kind === 'laser') {
                ap.laserManager.removeLaser(obj.laserId);
                ap._emitSync({ category: 'laser_remove', id: obj.laserId });
                lasersRemoved = true;
            } else if (kind === 'strobe') {
                ap.strobeManager.removeStrobe(obj.id); // envoie strobe_remove
            } else if (kind === 'spot' || kind === 'ledbar' || kind === 'laser2') {
                ap.deleteSelectedSpot(obj);
            } else if (kind === 'light') {
                ap.removeLight(obj);
            }
        }
        if (ap._laserInspectorPanel && ap._laserInspectorPanel.isOpen) ap._laserInspectorPanel.close();
        if (ap._strobeInspectorPanel && ap._strobeInspectorPanel.isOpen) ap._strobeInspectorPanel.close();
        this.deselectAllSingles();
        if (lasersRemoved) ap._buildGui();
        this._refreshMarkers();
        this._refreshBar();
    }

    // ── Duplication ─────────────────────────────────────────────────────

    /** Copie d'un appareil (mêmes fonctions que les boutons « Dupliquer » des inspecteurs) */
    _duplicateOne({ kind, obj }) {
        const ap = this.ap;
        if (kind === 'laser') {
            const l = ap.duplicateSelectedLaser(obj);
            return l ? { kind, obj: l } : null;
        }
        if (kind === 'strobe') {
            const res = ap.strobeManager.duplicateStrobe(obj.id);
            return res ? { kind, obj: res.strobe } : null;
        }
        if (kind === 'light') {
            ap.selectLight(obj);
            ap.duplicateSelectedLight();
            const e = ap.selectedEntry;
            return e && e !== obj ? { kind, obj: e } : null;
        }
        const res = ap.duplicateSelectedSpot(obj);
        const copy = res && (res.laser || res.bar || res.spot);
        return copy ? { kind, obj: copy } : null;
    }

    /** Duplique toute la sélection (décalage commun) et sélectionne les copies */
    duplicateAll() {
        const list = [...this.items.values()];
        if (!list.length) return;
        this._duplicating = true;
        const copies = [];
        try {
            this.items.clear();
            this._leaveGroup();
            this.deselectAllSingles();
            for (const it of list) {
                const target = this._worldPos(it, new THREE.Vector3()).add(DUPLICATE_OFFSET);
                const copy = this._duplicateOne(it);
                if (!copy) continue;
                // Chaque type a son propre décalage de copie : ramené au décalage commun
                _d.copy(target).sub(this._worldPos(copy, _v));
                if (_d.lengthSq() > 1e-8) this._moveItem(copy, _d);
                if (copy.kind === 'spot' || copy.kind === 'ledbar' || copy.kind === 'laser2') copy.obj.isBeingDragged = false;
                this._emitPlacement(copy, true);
                copies.push(copy);
            }
        } finally {
            this._duplicating = false;
        }
        this.deselectAllSingles();
        this.setItems(copies);
        this.ap._lastFixturePick = performance.now(); // la souris reste libre
    }

    // ── Évènements ──────────────────────────────────────────────────────

    /** Mode où la sélection à la souris est possible : curseur libre (Tab) ou panneau Ambiance ouvert */
    _canSelect() {
        const ap = this.ap;
        if (ap.spotConsole && ap.spotConsole.isOpen) return false;
        const locked = this.listener && this.listener.controls && this.listener.controls.isLocked;
        return ap.isOpen || !locked;
    }

    _wireEvents() {
        const ap = this.ap;

        // Réglages : tout ce qu'émettent le panneau Ambiance et les inspecteurs passe par _emitSync
        this._origEmit = ap._emitSync.bind(ap);
        ap._emitSync = (payload) => {
            this._origEmit(payload);
            if (!ap._isRemoteUpdate) this._mirror(payload);
        };
        if (ap._laserInspectorPanel && typeof ap._laserInspectorPanel.onSync === 'function') {
            ap._laserInspectorPanel.onSync((payload) => this._mirror(payload));
        }

        // Bouton « Dupliquer » d'un inspecteur pendant une sélection multiple : toute la sélection est copiée
        const groupDuplicate = (orig) => (...args) => {
            if (this._duplicating || this.items.size < 2) return orig(...args);
            this.duplicateAll();
            return null;
        };
        ap.duplicateSelectedSpot = groupDuplicate(ap.duplicateSelectedSpot.bind(ap));
        ap.duplicateSelectedLaser = groupDuplicate(ap.duplicateSelectedLaser.bind(ap));
        ap.duplicateSelectedLight = groupDuplicate(ap.duplicateSelectedLight.bind(ap));
        if (ap.strobeManager) ap.strobeManager.duplicateStrobe = groupDuplicate(ap.strobeManager.duplicateStrobe.bind(ap.strobeManager));

        // Pointeur : capture, avant la sélection du panneau Ambiance et du gizmo
        this.dom.addEventListener('pointerdown', (e) => {
            if (e.button !== 0 || !this._canSelect()) return;
            const tc = ap.transformControls;
            if (tc && (tc.axis !== null || tc.dragging)) return; // manipulation du gizmo
            const ctrl = e.ctrlKey || e.metaKey;
            const shift = e.shiftKey;
            if (ctrl) {
                // Ctrl + clic : géré ici seulement (pas de sélection simple ni de gizmo)
                e.stopImmediatePropagation();
                e.preventDefault();
            } else if (!shift) {
                // Clic simple : la sélection multiple laisse la place à la sélection habituelle
                this.clear();
            }
            this._press = { x: e.clientX, y: e.clientY, ctrl, additive: ctrl || shift, rect: false };
        }, true);

        window.addEventListener('pointermove', (e) => {
            const p = this._press;
            if (!p) return;
            if (!p.rect && Math.hypot(e.clientX - p.x, e.clientY - p.y) >= DRAG_THRESHOLD) {
                p.rect = true;
                this._rectEl.style.display = 'block';
            }
            if (p.rect) this._drawRect(p.x, p.y, e.clientX, e.clientY);
        });

        window.addEventListener('pointerup', (e) => {
            const p = this._press;
            if (!p) return;
            this._press = null;
            this._rectEl.style.display = 'none';
            if (p.rect) {
                this._selectRect(p.x, p.y, e.clientX, e.clientY, p.additive);
                ap._lastFixturePick = performance.now(); // la souris reste libre
            } else if (p.ctrl) {
                const hit = this._pick(e.clientX, e.clientY);
                if (hit) {
                    // Première lumière ajoutée au Ctrl + clic : la lumière déjà sélectionnée seule en fait partie
                    if (this.items.size === 0) {
                        const cur = this._currentSingle();
                        if (cur && this._key(cur.kind, cur.obj) !== this._key(hit.kind, hit.obj)) {
                            this.items.set(this._key(cur.kind, cur.obj), cur);
                        }
                    }
                    this.toggle(hit);
                }
                ap._lastFixturePick = performance.now();
            }
        });

        // Gizmo de groupe : déplacement de toute la sélection
        const tc = ap.transformControls;
        tc.addEventListener('objectChange', () => {
            if (!this._groupActive || tc.object !== this._pivot) return;
            if (tc.getMode() === 'rotate') {
                // Rotation du groupe : écart depuis la dernière image, appliqué autour du centre
                _dq.copy(this._pivot.quaternion).multiply(this._lastPivotQ.invert());
                this._lastPivotQ.copy(this._pivot.quaternion);
                if (Math.abs(_dq.w) > 1 - 1e-12) return;
                const c = this._pivot.position;
                for (const it of this.items.values()) this._rotateItem(it, _dq, c);
                this._refreshMarkers();
                return;
            }
            _d.copy(this._pivot.position).sub(this._lastPivot);
            if (_d.lengthSq() === 0) return;
            this._lastPivot.copy(this._pivot.position);
            for (const it of this.items.values()) this._moveItem(it, _d);
            this._refreshMarkers();
        });
        tc.addEventListener('dragging-changed', (event) => {
            if (!this._groupActive || event.value) return;
            for (const it of this.items.values()) {
                if (it.kind === 'spot' || it.kind === 'ledbar' || it.kind === 'laser2') it.obj.isBeingDragged = false;
                this._emitPlacement(it, true);
            }
        });

        // Clavier : Suppr (toute la sélection), Échap (désélectionner)
        window.addEventListener('keydown', (e) => {
            const t = e.target;
            if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
            // Ctrl + D avec un seul appareil sélectionné : même duplication que son bouton « Dupliquer »
            if (this.items.size < 2 && e.code === 'KeyD' && (e.ctrlKey || e.metaKey) && !e.repeat) {
                const cur = this._currentSingle();
                if (!cur) return;
                e.preventDefault();
                e.stopImmediatePropagation();
                const copy = this._duplicateOne(cur);
                if (copy) this._selectSingle(copy);
                ap._lastFixturePick = performance.now(); // la souris reste libre
                return;
            }
            if (this.items.size < 2) return;
            if (e.code === 'Delete' || e.key === 'Delete') {
                e.preventDefault();
                e.stopImmediatePropagation();
                this.deleteAll();
            } else if (e.code === 'KeyD' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                e.stopImmediatePropagation();
                this.duplicateAll();
            } else if (e.code === 'Escape') {
                e.stopImmediatePropagation();
                this.deselectAll();
            }
        }, true);
    }

    _selectRect(x0, y0, x1, y1, additive) {
        const rect = this.dom.getBoundingClientRect();
        const minX = Math.min(x0, x1), maxX = Math.max(x0, x1);
        const minY = Math.min(y0, y1), maxY = Math.max(y0, y1);
        this.camera.updateMatrixWorld();
        const found = [];
        for (const it of this._allItems()) {
            this._worldPos(it, _v).project(this.camera);
            if (_v.z < -1 || _v.z > 1) continue; // derrière la caméra
            const sx = rect.left + (_v.x + 1) / 2 * rect.width;
            const sy = rect.top + (1 - _v.y) / 2 * rect.height;
            if (sx >= minX && sx <= maxX && sy >= minY && sy <= maxY) found.push(it);
        }
        if (!found.length && !additive) return;
        if (additive && this.items.size === 0) {
            const cur = this._currentSingle();
            if (cur) this.items.set(this._key(cur.kind, cur.obj), cur);
        }
        this.setItems(found, additive);
    }

    // ── Affichage ───────────────────────────────────────────────────────

    _buildDom() {
        const r = document.createElement('div');
        r.style.cssText = 'position:fixed;display:none;z-index:9000;pointer-events:none;'
            + 'border:1px solid rgba(255,255,255,0.7);background:rgba(255,255,255,0.06);';
        document.body.appendChild(r);
        this._rectEl = r;

        // Bandeau sobre : texte, type réglé, deux actions
        const bar = document.createElement('div');
        bar.style.cssText = 'position:fixed;left:50%;bottom:64px;transform:translateX(-50%);z-index:9001;display:none;'
            + 'align-items:center;gap:12px;padding:6px 8px 6px 12px;border-radius:3px;'
            + 'background:#141414;border:1px solid #333;color:#ddd;font:12px/1.2 system-ui,sans-serif;white-space:nowrap;';
        const text = document.createElement('span');
        const ctrl = 'background:#1c1c1c;color:#ddd;border:1px solid #333;border-radius:2px;padding:3px 8px;font:inherit;cursor:pointer;';
        const kindSel = document.createElement('select');
        kindSel.title = 'Réglages appliqués à toutes les lumières de ce type (inspecteur ouvert)';
        kindSel.style.cssText = ctrl;
        kindSel.addEventListener('change', () => {
            this.primaryKind = kindSel.value;
            if (this.items.size >= 2) this._enterGroup();
        });
        const btn = (label, title, fn) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = label;
            b.title = title;
            b.style.cssText = ctrl;
            b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
            return b;
        };
        const dup = btn('Dupliquer', 'Dupliquer la sélection à droite et sélectionner les copies (Ctrl + D)', () => this.duplicateAll());
        const del = btn('Supprimer', 'Supprimer la sélection (Suppr)', () => this.deleteAll());
        const close = btn('×', 'Désélectionner (Échap)', () => this.deselectAll());
        for (const el of [bar, kindSel]) {
            ['pointerdown', 'mousedown', 'click'].forEach(ev => el.addEventListener(ev, e => e.stopPropagation()));
        }
        bar.append(text, kindSel, dup, del, close);
        document.body.appendChild(bar);
        this._bar = bar;
        this._barText = text;
        this._kindSel = kindSel;
    }

    _drawRect(x0, y0, x1, y1) {
        const s = this._rectEl.style;
        s.left = `${Math.min(x0, x1)}px`;
        s.top = `${Math.min(y0, y1)}px`;
        s.width = `${Math.abs(x1 - x0)}px`;
        s.height = `${Math.abs(y1 - y0)}px`;
    }

    _refreshBar() {
        const n = this.items.size;
        if (n < 2) {
            this._bar.style.display = 'none';
            return;
        }
        const kinds = this._kinds();
        const parts = [...kinds.entries()].map(([k, c]) => `${c} ${c > 1 ? KIND_LABELS[k] : KIND_LABEL_ONE[k]}`);
        this._barText.textContent = `${n} sélectionnées — ${parts.join(', ')}`;
        this._kindSel.innerHTML = '';
        for (const [k, c] of kinds) {
            const o = document.createElement('option');
            o.value = k;
            o.textContent = `Régler : ${KIND_LABELS[k]} (${c})`;
            this._kindSel.appendChild(o);
        }
        this._kindSel.value = this.primaryKind;
        this._bar.style.display = 'flex';
    }

    _refreshMarkers() {
        const g = this._markers;
        const list = this.items.size >= 2 ? [...this.items.values()] : [];
        while (g.children.length > list.length) g.remove(g.children[g.children.length - 1]);
        while (g.children.length < list.length) {
            const m = new THREE.LineSegments(this._markerGeo, this._markerMat);
            m.renderOrder = 999;
            m.frustumCulled = false;
            g.add(m);
        }
        list.forEach((it, i) => {
            const m = g.children[i];
            this._worldPos(it, m.position);
            m.scale.setScalar(it.kind === 'light' ? 0.6 : 0.9);
            m.updateMatrixWorld();
        });
    }

    /** Une fois par image */
    update() {
        if (this.items.size === 0) return;
        // Appareils supprimés ailleurs (autre joueur, inspecteur) : retirés de la sélection
        if ((++this._frame & 15) === 0) {
            const alive = new Set(this._allItems().map(it => this._key(it.kind, it.obj)));
            let changed = false;
            for (const k of [...this.items.keys()]) {
                if (!alive.has(k) && !k.startsWith('light:')) { this.items.delete(k); changed = true; }
            }
            if (changed) this._afterChange(this.primaryKind);
        }
        // Gizmo de groupe détaché par une autre action (Échap, autre sélection) : fin de la sélection multiple
        const tc = this.ap.transformControls;
        if (this._groupActive && tc.object !== this._pivot && !tc.dragging) {
            this.clear();
            return;
        }
        if (this.items.size >= 2) this._refreshMarkers();
    }
}
