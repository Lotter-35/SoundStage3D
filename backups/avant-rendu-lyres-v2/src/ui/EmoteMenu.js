/**
 * EmoteMenu.js — Menu flottant sobre, redimensionnable et déplaçable d'animations (Touche 'T').
 *
 * Fonctionnalités :
 * - Fenêtre déplaçable et redimensionnable (resizable) par les coins.
 * - Aucune ombre ou fond bloquant (pas de backdrop).
 * - Clic sur une animation pour la lancer, re-clic pour l'arrêter (pause/stop).
 * - Appui sur 'X' arrête la danse et met à jour instantanément le menu.
 * - Toggle Loop / One-shot (🔁 / 🔂) sans T-pose en fin de lecture.
 * - Raccourcis 1-9 exclusifs (réassigner un slot libère automatiquement l'ancien).
 * - Bouton "Actualiser" discret.
 * - Mention discrète "(X pour arrêter)".
 */

import { DanceManager } from '../scene/DanceManager.js';
import { makeDraggable, makeResizable } from './draggable.js';

export class EmoteMenu {
    constructor(listener, character3D) {
        this.listener = listener;
        this.character3D = character3D;
        this.isOpen = false;
        this.searchQuery = '';
        this.activeSlotToAssign = null; // 1..9 si l'utilisateur sélectionne un slot

        this._createDOM();
        this._bindEvents();

        // Callback quand la danse s'arrête (via X ou fin d'animation one-shot) ou démarre
        if (this.character3D) {
            this.character3D._onDanceStop = () => {
                this.updateActiveHighlight();
            };
            this.character3D._onDanceChange = () => {
                this.updateActiveHighlight();
            };
        }

        // Réagir aux changements de slots
        DanceManager.onSlotsChange(() => {
            this.renderSlots();
            this.renderList();
        });

        // Réagir aux mises à jour dynamiques du catalogue (fichiers ajoutés/supprimés)
        DanceManager.onCatalogChange(() => {
            this.renderSlots();
            this.renderList();
        });
    }

    _createDOM() {
        this.container = document.createElement('div');
        this.container.id = 'emote-window';
        this.container.className = 'emote-window hidden';

        // Position initiale par défaut si non mémorisée
        this.container.style.top = '90px';
        this.container.style.left = '60px';

        this.container.innerHTML = `
            <div class="emote-window-header" id="emote-window-header">
                <span class="emote-window-title">
                    🕺 Animations <span class="emote-hint-x">(X pour arrêter)</span>
                </span>
                <div class="emote-header-actions">
                    <button class="emote-refresh-text-btn" id="emote-refresh-btn">Actualiser</button>
                    <button class="emote-close-btn" id="emote-close-btn" title="Fermer">✕</button>
                </div>
            </div>

            <!-- Barre de raccourcis 1 à 9 -->
            <div class="emote-slots-bar" id="emote-slots-bar"></div>

            <!-- Barre de recherche sobre -->
            <div class="emote-search-bar">
                <input type="text" id="emote-search-input" placeholder="🔍 Rechercher..." autocomplete="off">
            </div>

            <!-- Liste des animations -->
            <div class="emote-list-scroll">
                <div class="emote-list" id="emote-list"></div>
            </div>
        `;

        document.body.appendChild(this.container);

        this.header = this.container.querySelector('#emote-window-header');
        this.slotsBar = this.container.querySelector('#emote-slots-bar');
        this.list = this.container.querySelector('#emote-list');
        this.searchInput = this.container.querySelector('#emote-search-input');
        this.closeBtn = this.container.querySelector('#emote-close-btn');
        this.refreshBtn = this.container.querySelector('#emote-refresh-btn');

        // Rendre la fenêtre librement déplaçable (sans ancrage droit pour préserver l'orientation du resize)
        makeDraggable(this.container, this.header, 'emote-menu', false);

        // Rendre la fenêtre redimensionnable par tous les côtés et coins avec sauvegarde de taille
        makeResizable(this.container, { minWidth: 360, minHeight: 260, storageKey: 'emote-menu' });
        this.container.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });

        this.renderSlots();
        this.renderList();
    }

    _bindEvents() {
        this.closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.close();
        });

        if (this.refreshBtn) {
            this.refreshBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                this.refreshBtn.textContent = 'Scan...';
                if (this.character3D && typeof this.character3D.clearDanceActions === 'function') {
                    this.character3D.clearDanceActions();
                }
                await DanceManager.refreshCatalog(true);
                this.renderSlots();
                this.renderList();
                this.refreshBtn.textContent = 'Actualiser';
            });
        }

        this.searchInput.addEventListener('input', (e) => {
            this.searchQuery = e.target.value.toLowerCase().trim();
            this.renderList();
        });
    }

    renderSlots() {
        if (!this.slotsBar) return;
        this.slotsBar.innerHTML = '';

        const currentDance = this.character3D?.currentDanceId ? String(this.character3D.currentDanceId).toLowerCase().trim() : null;

        for (let i = 1; i <= 9; i++) {
            const danceId = DanceManager.getSlot(i);
            const info = danceId ? DanceManager.getInfo(danceId) : null;
            const isSelecting = this.activeSlotToAssign === i;
            const isPlaying = (currentDance && danceId && String(danceId).toLowerCase().trim() === currentDance);

            const slotBtn = document.createElement('button');
            slotBtn.className = `emote-slot-btn ${info ? 'assigned' : 'empty'} ${isSelecting ? 'selecting' : ''} ${isPlaying ? 'playing' : ''}`;
            slotBtn.title = info ? `${i}: ${info.name}` : `${i}`;
            if (danceId) slotBtn.setAttribute('data-dance-id', danceId);

            slotBtn.innerHTML = `
                <span class="slot-num">${i}</span>
                <span class="slot-name">${info ? info.name : ''}</span>
                ${info ? `<span class="slot-clear" title="Effacer">×</span>` : ''}
            `;

            slotBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (e.target.classList.contains('slot-clear')) {
                    DanceManager.setSlot(i, null);
                    this.renderSlots();
                    this.renderList();
                    return;
                }

                if (this.activeSlotToAssign === i) {
                    this.activeSlotToAssign = null;
                    this.renderSlots();
                } else if (!info) {
                    this.activeSlotToAssign = i;
                    this.renderSlots();
                } else {
                    this._toggleDance(danceId);
                }
            });

            this.slotsBar.appendChild(slotBtn);
        }
    }

    renderList() {
        if (!this.list) return;
        this.list.innerHTML = '';

        const catalog = (DanceManager.catalog || []).filter(d => 
            !d.name.toLowerCase().includes('standing up') && 
            !d.file.toLowerCase().includes('standing up')
        );
        let filtered = catalog;

        if (this.searchQuery) {
            filtered = filtered.filter(d => d.name.toLowerCase().includes(this.searchQuery));
        }

        if (filtered.length === 0) {
            this.list.innerHTML = `<div class="emote-empty-item">Aucune animation</div>`;
            return;
        }

        const currentDance = this.character3D?.currentDanceId ? String(this.character3D.currentDanceId).toLowerCase().trim() : null;

        filtered.forEach(dance => {
            const isPlaying = Boolean(currentDance && String(dance.id).toLowerCase().trim() === currentDance);
            const assignedSlot = DanceManager.slots.findIndex(id => id && String(id).toLowerCase().trim() === String(dance.id).toLowerCase().trim()) + 1;

            const card = document.createElement('div');
            card.className = `emote-card ${isPlaying ? 'playing' : ''}`;
            card.setAttribute('data-id', dance.id);

            card.innerHTML = `
                <div class="emote-card-top">
                    <span class="emote-card-play-icon">${isPlaying ? '⏸' : '▶'}</span>
                    <select class="emote-slot-dropdown" title="Raccourci 1 à 9">
                        <option value="">-</option>
                        ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<option value="${n}" ${assignedSlot === n ? 'selected' : ''}>${n}</option>`).join('')}
                    </select>
                </div>
                <div class="emote-card-body">
                    <div class="emote-card-name" title="${dance.name}">${dance.name}</div>
                </div>
            `;

            // Assignation rapide via dropdown slot (unicité garantie)
            const select = card.querySelector('.emote-slot-dropdown');
            select.addEventListener('click', (e) => e.stopPropagation());
            select.addEventListener('change', (e) => {
                e.stopPropagation();
                const slot = parseInt(e.target.value, 10);
                if (slot >= 1 && slot <= 9) {
                    DanceManager.setSlot(slot, dance.id);
                } else if (assignedSlot > 0) {
                    DanceManager.setSlot(assignedSlot, null);
                }
                this.renderSlots();
                this.renderList();
            });

            // Clic sur toute la carte = toggle play/pause ou assigner au slot actif
            card.addEventListener('click', () => {
                if (this.activeSlotToAssign) {
                    DanceManager.setSlot(this.activeSlotToAssign, dance.id);
                    this.activeSlotToAssign = null;
                    this.renderSlots();
                    this.renderList();
                    this._toggleDance(dance.id);
                    return;
                }
                this._toggleDance(dance.id);
            });

            this.list.appendChild(card);
        });
    }

    /**
     * Met à jour instantanément la mise en surbrillance (vert / ⏸)
     * de l'animation en cours dans la grille et les slots sans re-créer tout le DOM.
     */
    updateActiveHighlight() {
        const currentDance = this.character3D?.currentDanceId ? String(this.character3D.currentDanceId).toLowerCase().trim() : null;

        if (this.list) {
            const cards = this.list.querySelectorAll('.emote-card');
            cards.forEach(card => {
                const id = card.getAttribute('data-id');
                const isPlaying = Boolean(currentDance && id && String(id).toLowerCase().trim() === currentDance);
                if (isPlaying) {
                    card.classList.add('playing');
                } else {
                    card.classList.remove('playing');
                }
                const icon = card.querySelector('.emote-card-play-icon');
                if (icon) {
                    icon.textContent = isPlaying ? '⏸' : '▶';
                }
            });
        }

        if (this.slotsBar) {
            const slotBtns = this.slotsBar.querySelectorAll('.emote-slot-btn');
            slotBtns.forEach(btn => {
                const danceId = btn.getAttribute('data-dance-id');
                const isPlaying = Boolean(currentDance && danceId && String(danceId).toLowerCase().trim() === currentDance);
                if (isPlaying) {
                    btn.classList.add('playing');
                } else {
                    btn.classList.remove('playing');
                }
            });
        }
    }

    async _toggleDance(danceId) {
        if (!this.character3D || !danceId) return;
        const norm = String(danceId).toLowerCase().trim();
        const cur = this.character3D.currentDanceId ? String(this.character3D.currentDanceId).toLowerCase().trim() : null;

        if (cur === norm) {
            this.character3D.stopDance();
            this.updateActiveHighlight();
        } else {
            await this.character3D.playDance(danceId, true);
            this.updateActiveHighlight();
        }
    }

    async open() {
        if (this.isOpen) return;
        this.isOpen = true;
        this.container.classList.remove('hidden');

        // Déverrouiller la souris pour naviguer dans la fenêtre
        if (this.listener && this.listener.controls && this.listener.controls.isLocked) {
            this.listener.controls.unlock();
        }

        // Rafraîchir le catalogue au moment de l'ouverture
        await DanceManager.refreshCatalog();
        this.renderSlots();
        this.renderList();

        setTimeout(() => this.searchInput.focus(), 80);
    }

    close() {
        if (!this.isOpen) return;
        this.isOpen = false;
        this.container.classList.add('hidden');
        this.activeSlotToAssign = null;
    }

    toggle() {
        if (this.isOpen) {
            this.close();
        } else {
            this.open();
        }
    }

    dispose() {
        if (this.container && this.container.parentNode) {
            this.container.parentNode.removeChild(this.container);
        }
    }
}
