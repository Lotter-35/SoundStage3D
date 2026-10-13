/**
 * costDebug.js — Vue « coût des lyres » (⚙️ Options › Affichage) : les passes des lyres (faisceaux SS Depth, flous,
 * analytiques, taches de lumière) écrivent leur TRAVAIL par pixel au lieu de leur lumière, et la passe finale
 * l'affiche en carte de chaleur logarithmique : ≈ 2 bleu, 10 vert, 40 jaune, 200 rouge, 1000 blanc.
 *
 * Unité de travail ≈ une évaluation de l'image de la fenêtre + phase (un « point » de faisceau) ; un test
 * d'intersection de cône ≈ 0,3 ; une lecture d'ombre ≈ 1. Écrit dans les images × 0,01.
 */
export const costDebug = { on: false };
