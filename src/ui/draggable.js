/**
 * Draggable helper for SoundStage3D UI panels and windows.
 * Supports lil-gui root panels, custom floating divs, and HUD panels.
 * Preserves user-dragged positions in localStorage.
 */

let highestZIndex = 300;

export function makeDraggable(panelEl, handleEl = panelEl, storageKey = null) {
    if (!panelEl || !handleEl) return;

    handleEl.style.cursor = 'grab';

    // Restore saved position from localStorage if valid
    if (storageKey) {
        try {
            const saved = localStorage.getItem(`soundstage3d:win-pos:${storageKey}`);
            if (saved) {
                const { left, top } = JSON.parse(saved);
                if (Number.isFinite(left) && Number.isFinite(top)) {
                    const maxLeft = Math.max(10, window.innerWidth - 60);
                    const maxTop = Math.max(10, window.innerHeight - 40);
                    const clLeft = Math.max(10, Math.min(maxLeft, left));
                    const clTop = Math.max(10, Math.min(maxTop, top));
                    panelEl.style.position = 'fixed';
                    panelEl.style.left = `${clLeft}px`;
                    panelEl.style.top = `${clTop}px`;
                    panelEl.style.bottom = 'auto';
                    panelEl.style.right = 'auto';
                    panelEl.style.transform = 'none';
                    panelEl.style.margin = '0';
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

        // Do not drag on interactive elements
        if (e.target.closest('button, input, select, .lil-reset-btn, .lil-panel-reset-btn, .pb-icon-btn, a')) {
            return;
        }

        // Bring active window to front
        highestZIndex++;
        panelEl.style.zIndex = highestZIndex;

        const rect = panelEl.getBoundingClientRect();
        startX = e.clientX;
        startY = e.clientY;
        initialLeft = rect.left;
        initialTop = rect.top;
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
                // Save custom position
                if (storageKey) {
                    try {
                        const finalRect = panelEl.getBoundingClientRect();
                        localStorage.setItem(
                            `soundstage3d:win-pos:${storageKey}`,
                            JSON.stringify({ left: finalRect.left, top: finalRect.top })
                        );
                    } catch (_) {}
                }

                // Suppress click on title bar so lil-gui doesn't toggle fold on drag release
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
}
