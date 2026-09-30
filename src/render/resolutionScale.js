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

// Résolution dynamique (DynamicResolution.js) : fraction de l'échelle de rendu choisie actuellement appliquée.
// Le mode auto et le MSAA auto raisonnent sur l'image SANS cette réduction : les effets baissent avec elle
// (sinon ils reprendraient les pixels économisés) et le nombre d'échantillons ne change pas en cours de jeu.
let _dynamicFactor = 1;
export function setDynamicResolutionFactor(f) { _dynamicFactor = f; }
export function getDynamicResolutionFactor() { return _dynamicFactor; }

/** Échelle (par axe) du mode auto pour une image de width × height pixels */
export function autoResolutionScale(width, height) {
    const f = _dynamicFactor;
    const px = Math.max(1, (width * height) / (f * f));
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

// ── Charge : beaucoup de nappes laser / faisceaux de lyres à l'écran ──
// En mode auto seulement (un réglage fixe est respecté tel quel), leur résolution baisse d'un cran
// (½ par axe : ¼ des pixels) au-delà de BUSY_ON instances et remonte sous BUSY_OFF (pas de va-et-vient).
// Mesuré en 4K à 50 lasers / 50 lyres : −3,7 ms.
export const BUSY_ON = 24;
export const BUSY_OFF = 16;
export const BUSY_RES_FACTOR = 0.5;

/**
 * @param {boolean} busy état précédent
 * @param {number} count instances affichées
 * @param {number|'auto'} setting réglage choisi
 * @returns {boolean} nouvel état
 */
export function nextBusyState(busy, count, setting) {
    if (setting !== 'auto') return false;
    return busy ? count > BUSY_OFF : count >= BUSY_ON;
}
