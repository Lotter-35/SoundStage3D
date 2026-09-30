/**
 * resolutionScale.js — Résolution de calcul des effets (fumée, faisceaux de lyres, nappes laser).
 *
 * Une fraction fixe de l'écran donne des effets très grossiers sur un petit écran (½ en 1080p = 960×540)
 * alors qu'elle reste fine en 4K (½ = 1920×1080). Le mode « auto » vise plutôt un nombre de pixels calculés
 * à peu près constant : pleine résolution jusqu'en 1080p, ~¾ en 1440p, ½ en 4K.
 */

export const RES_AUTO = 'Auto (selon l\'écran)';
export const AUTO_TARGET_PIXELS = 1920 * 1080;
const AUTO_MIN_SCALE = 0.25;

/** Échelle (par axe) du mode auto pour une image de width × height pixels */
export function autoResolutionScale(width, height) {
    const px = Math.max(1, width * height);
    return Math.min(1, Math.max(AUTO_MIN_SCALE, Math.sqrt(AUTO_TARGET_PIXELS / px)));
}

/**
 * @param {number|'auto'} setting échelle fixe par axe, ou 'auto'
 * @param {number} width largeur de l'image (pixels réels)
 * @param {number} height hauteur de l'image (pixels réels)
 */
export function resolveResolutionScale(setting, width, height) {
    return setting === 'auto' ? autoResolutionScale(width, height) : setting;
}
