/**
 * Draggable & Resizable helpers for SoundStage3D UI panels and windows.
 * Supports lil-gui root panels, custom floating divs, and HUD panels.
 * Preserves user-dragged positions and sizes in localStorage.
 */

let highestZIndex = 500;

export function makeDraggable(panelEl, handleEl = panelEl, storageKey = null, allowRightAnchor = true) {
    if (!panelEl || !handleEl) return;

    handleEl.style.cursor = 'grab';

    // Restore saved position from localStorage if valid
    if (storageKey) {
        try {
            const savedRaw = localStorage.getItem(`soundstage3d:win-pos:${storageKey}`);
            if (savedRaw) {
                const saved = JSON.parse(savedRaw);
                const top = saved.top;
                if (Number.isFinite(top)) {
                    const maxTop = Math.max(10, window.innerHeight - 40);
                    const clTop = Math.max(10, Math.min(maxTop, top));
                    panelEl.style.position = 'fixed';
                    panelEl.style.top = `${clTop}px`;
                    panelEl.style.bottom = 'auto';
                    panelEl.style.transform = 'none';
                    panelEl.style.margin = '0';

                    const rightKeys = ['master', 'sub', 'env', 'user', 'fill'];
                    const isRight = allowRightAnchor && (saved.isRightAnchored || (saved.right !== undefined) ||
                        rightKeys.includes(storageKey) || ((saved.left ?? 0) > window.innerWidth / 2));

                    if (isRight) {
                        let rightVal = saved.right;
                        if (!Number.isFinite(rightVal)) {
                            if (storageKey === 'master' || storageKey === 'sub' || storageKey === 'env') {
                                rightVal = 16;
                            } else if (storageKey === 'user') {
                                rightVal = 328;
                            } else if (saved.left !== undefined) {
                                rightVal = Math.max(10, window.innerWidth - saved.left - (panelEl.offsetWidth || 300));
                            } else {
                                rightVal = 16;
                            }
                        }
                        const clRight = Math.max(10, Math.min(window.innerWidth - 60, rightVal));
                        panelEl.style.right = `${clRight}px`;
                        panelEl.style.left = 'auto';
                    } else {
                        const maxLeft = Math.max(10, window.innerWidth - 60);
                        const clLeft = Math.max(10, Math.min(maxLeft, saved.left ?? 60));
                        panelEl.style.left = `${clLeft}px`;
                        panelEl.style.right = 'auto';
                    }
                }
            }
        } catch (_) {}
    }

    let startX = 0;
    let startY = 0;
    let initialLeft = 0;
    let initialTop = 0;
    let isDragging = false;

    const onPointerDown = (e) => {
        // Only primary mouse button or touch
        if (e.button !== undefined && e.button !== 0) return;

        // Do not drag on interactive elements or resize handles
        if (e.target.closest('button, input, select, .lil-reset-btn, .lil-panel-reset-btn, .pb-icon-btn, a, .win-resize-handle')) {
            return;
        }

        // Bring to front
        highestZIndex++;
        panelEl.style.zIndex = highestZIndex;

        const rect = panelEl.getBoundingClientRect();
        initialLeft = rect.left;
        initialTop = rect.top;
        startX = e.clientX;
        startY = e.clientY;
        isDragging = false;

        const onPointerMove = (moveEvent) => {
            const dx = moveEvent.clientX - startX;
            const dy = moveEvent.clientY - startY;

            if (!isDragging && Math.hypot(dx, dy) > 3) {
                isDragging = true;
                handleEl.style.cursor = 'grabbing';
                document.body.style.userSelect = 'none';

                // Lock element to fixed viewport coordinates
                panelEl.style.position = 'fixed';
                panelEl.style.transform = 'none';
                panelEl.style.bottom = 'auto';
                panelEl.style.right = 'auto';
                panelEl.style.margin = '0';
            }

            if (isDragging) {
                let newLeft = initialLeft + dx;
                let newTop = initialTop + dy;

                const maxLeft = Math.max(10, window.innerWidth - 60);
                const maxTop = Math.max(10, window.innerHeight - 40);
                newLeft = Math.max(10, Math.min(maxLeft, newLeft));
                newTop = Math.max(10, Math.min(maxTop, newTop));

                panelEl.style.left = `${newLeft}px`;
                panelEl.style.top = `${newTop}px`;
            }
        };

        const onPointerUp = (upEvent) => {
            window.removeEventListener('pointermove', onPointerMove);
            window.removeEventListener('pointerup', onPointerUp);
            window.removeEventListener('pointercancel', onPointerUp);

            handleEl.style.cursor = 'grab';
            document.body.style.userSelect = '';

            if (isDragging) {
                const finalRect = panelEl.getBoundingClientRect();
                const isRightAnchored = allowRightAnchor && ((finalRect.left + finalRect.width / 2) > (window.innerWidth / 2));
                const rightVal = Math.max(10, window.innerWidth - finalRect.right);

                // If on right half of viewport and allowed, anchor to right
                if (isRightAnchored) {
                    panelEl.style.right = `${rightVal}px`;
                    panelEl.style.left = 'auto';
                } else {
                    panelEl.style.left = `${finalRect.left}px`;
                    panelEl.style.right = 'auto';
                }

                // Save custom position
                if (storageKey) {
                    try {
                        localStorage.setItem(
                            `soundstage3d:win-pos:${storageKey}`,
                            JSON.stringify({
                                top: finalRect.top,
                                isRightAnchored,
                                right: isRightAnchored ? rightVal : undefined,
                                left: finalRect.left
                            })
                        );
                    } catch (_) {}
                }

                // Suppress click on title bar
                upEvent.stopPropagation();
                const captureClick = (cEvt) => {
                    cEvt.stopPropagation();
                    window.removeEventListener('click', captureClick, true);
                };
                window.addEventListener('click', captureClick, true);
            }
        };

        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp);
        window.addEventListener('pointercancel', onPointerUp);
    };

    handleEl.addEventListener('pointerdown', onPointerDown);

    // Keep panel in bounds if window is resized
    window.addEventListener('resize', () => {
        if (panelEl.style.position === 'fixed') {
            if (panelEl.style.right && panelEl.style.right !== 'auto') {
                const r = parseFloat(panelEl.style.right) || 16;
                panelEl.style.right = `${Math.max(10, Math.min(window.innerWidth - 60, r))}px`;
            } else if (panelEl.style.left && panelEl.style.left !== 'auto') {
                const l = parseFloat(panelEl.style.left) || 16;
                panelEl.style.left = `${Math.max(10, Math.min(window.innerWidth - 60, l))}px`;
            }
        }
    });
}

/**
 * Permet de redimensionner une fenêtre flottante en tirant sur les côtés et les coins.
 * Mémorise la taille personnalisée dans localStorage.
 */
export function makeResizable(panelEl, {
    minWidth = 360,
    minHeight = 260,
    maxWidth = window.innerWidth * 0.95,
    maxHeight = window.innerHeight * 0.95,
    storageKey = null,
    onResize = null
} = {}) {
    if (!panelEl) return;

    // Restaurer les dimensions sauvegardées
    if (storageKey) {
        try {
            const savedRaw = localStorage.getItem(`soundstage3d:win-size:${storageKey}`);
            if (savedRaw) {
                const saved = JSON.parse(savedRaw);
                const curMinWidth = typeof minWidth === 'function' ? minWidth() : minWidth;
                const curMinHeight = typeof minHeight === 'function' ? minHeight() : minHeight;
                if (Number.isFinite(saved.width)) {
                    panelEl.style.width = `${Math.max(curMinWidth, Math.min(window.innerWidth - 20, saved.width))}px`;
                }
                if (Number.isFinite(saved.height)) {
                    let targetH = saved.height;
                    if (storageKey === 'playback') {
                        const isCompactSaved = localStorage.getItem('soundstage3d:playback-compact') === 'true';
                        if (!isCompactSaved && targetH < 300) {
                            targetH = 480;
                        }
                    }
                    const clampedH = Math.max(curMinHeight, Math.min(window.innerHeight - 20, targetH));
                    panelEl.style.height = `${clampedH}px`;
                    if (saved.height < curMinHeight) {
                        saved.height = clampedH;
                        try { localStorage.setItem(`soundstage3d:win-size:${storageKey}`, JSON.stringify(saved)); } catch (_) {}
                    }
                }
            }
        } catch (_) {}
    }
    if (panelEl.offsetWidth > 0 || panelEl.offsetHeight > 0) {
        if (onResize) onResize(panelEl.offsetWidth, panelEl.offsetHeight);
    }

    const handles = [
        { dir: 'r',  cursor: 'ew-resize',   style: 'top: 0; right: 0; width: 8px; height: 100%;' },
        { dir: 'l',  cursor: 'ew-resize',   style: 'top: 0; left: 0; width: 8px; height: 100%;' },
        { dir: 'b',  cursor: 'ns-resize',   style: 'bottom: 0; left: 0; width: 100%; height: 8px;' },
        { dir: 'br', cursor: 'nwse-resize', style: 'bottom: 0; right: 0; width: 14px; height: 14px;' },
        { dir: 'bl', cursor: 'nesw-resize', style: 'bottom: 0; left: 0; width: 14px; height: 14px;' },
    ];

    for (const h of handles) {
        const el = document.createElement('div');
        el.className = `win-resize-handle win-resize-${h.dir}`;
        el.style.cssText = `position: absolute; ${h.style} cursor: ${h.cursor}; z-index: 30; touch-action: none;`;
        panelEl.appendChild(el);

        el.addEventListener('pointerdown', (downEvt) => {
            downEvt.preventDefault();
            downEvt.stopPropagation();

            // Placer au premier plan
            highestZIndex++;
            panelEl.style.zIndex = highestZIndex;

            // Toujours verrouiller en left/top fixes pour que l'agrandissement vers la droite s'étende bien vers la droite
            const startRect = panelEl.getBoundingClientRect();
            panelEl.style.position = 'fixed';
            panelEl.style.left = `${startRect.left}px`;
            panelEl.style.top = `${startRect.top}px`;
            panelEl.style.right = 'auto';
            panelEl.style.bottom = 'auto';
            panelEl.style.width = `${startRect.width}px`;
            panelEl.style.height = `${startRect.height}px`;

            const startX = downEvt.clientX;
            const startY = downEvt.clientY;
            const startW = startRect.width;
            const startH = startRect.height;
            const startL = startRect.left;
            const startT = startRect.top;

            document.body.style.userSelect = 'none';

            const onPointerMove = (moveEvt) => {
                const dx = moveEvt.clientX - startX;
                const dy = moveEvt.clientY - startY;

                // Tirer côté Droit ou coin Bas-Droit
                if (h.dir.includes('r')) {
                    const curMinW = typeof minWidth === 'function' ? minWidth() : minWidth;
                    const w = Math.max(curMinW, Math.min(window.innerWidth - startL - 10, startW + dx));
                    panelEl.style.width = `${w}px`;
                }

                // Tirer côté Gauche ou coin Bas-Gauche
                if (h.dir.includes('l')) {
                    const curMinW = typeof minWidth === 'function' ? minWidth() : minWidth;
                    let newW = startW - dx;
                    let newL = startL + dx;
                    if (newW < curMinW) {
                        newL = startL + (startW - curMinW);
                        newW = curMinW;
                    } else if (newL < 10) {
                        newW += newL - 10;
                        newL = 10;
                    }
                    panelEl.style.left = `${newL}px`;
                    panelEl.style.width = `${newW}px`;
                }

                // Tirer côté Bas ou coins Bas
                if (h.dir.includes('b')) {
                    const currentMinH = typeof minHeight === 'function' ? minHeight() : minHeight;
                    const heightVal = Math.max(currentMinH, Math.min(window.innerHeight - startT - 10, startH + dy));
                    panelEl.style.height = `${heightVal}px`;
                    if (onResize) onResize(panelEl.offsetWidth, heightVal);
                } else {
                    if (onResize) onResize(panelEl.offsetWidth, panelEl.offsetHeight);
                }
            };

            const onPointerUp = () => {
                window.removeEventListener('pointermove', onPointerMove);
                window.removeEventListener('pointerup', onPointerUp);
                window.removeEventListener('pointercancel', onPointerUp);
                document.body.style.userSelect = '';
                if (onResize) onResize(panelEl.offsetWidth, panelEl.offsetHeight);

                if (storageKey) {
                    try {
                        const finalRect = panelEl.getBoundingClientRect();
                        const curMinW = typeof minWidth === 'function' ? minWidth() : minWidth;
                        const curMinH = typeof minHeight === 'function' ? minHeight() : minHeight;
                        localStorage.setItem(
                            `soundstage3d:win-size:${storageKey}`,
                            JSON.stringify({
                                width: Math.max(curMinW, finalRect.width),
                                height: Math.max(curMinH, finalRect.height)
                            })
                        );
                        // Mettre à jour left/top sauvegardés
                        const posRaw = localStorage.getItem(`soundstage3d:win-pos:${storageKey}`);
                        const pos = posRaw ? JSON.parse(posRaw) : {};
                        pos.left = finalRect.left;
                        pos.top = finalRect.top;
                        pos.isRightAnchored = false;
                        delete pos.right;
                        localStorage.setItem(`soundstage3d:win-pos:${storageKey}`, JSON.stringify(pos));
                    } catch (_) {}
                }
            };

            window.addEventListener('pointermove', onPointerMove);
            window.addEventListener('pointerup', onPointerUp);
            window.addEventListener('pointercancel', onPointerUp);
        });
    }
}
