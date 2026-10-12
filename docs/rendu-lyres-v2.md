# Rendu des lyres v2 — plan

Inspiré du banc d'essai C++ « LightBench » (mode 5, Screen-Space Depth Scattering), adapté à WebGL2 / three.js
0.160 (pas de compute shaders : passes plein écran + tri des lyres par tuile sur le CPU). Sauvegarde du code
d'avant : `backups/avant-rendu-lyres-v2/`.

**Cible** : GTX 1080, 4K, 120 images/s constantes avec 50 lyres allumées (budget ≈ 8,3 ms par image).

## Décisions (avec l'utilisateur)

| # | Décision |
|---|---|
| R1 | Faisceaux en mode **SS Depth** : tri des lyres par tuile d'écran (CPU → texture), passe des faisceaux en basse résolution (½, ⅓, ¼), profondeur réduite en damier min/max, intersection exacte rayon/cône + **3 échantillons** (quadrature de Gauss), gobo sur l'échantillon du milieu, prisme = plusieurs cônes, remontée **bilatérale 3×3** guidée par la profondeur. Pas de texture de fumée dans les faisceaux. Pas de froxels. |
| R2 | **Halo atmosphérique** en espace écran (8 échantillons, occultation asymétrique par la profondeur). |
| R3 | **Ombres statiques** : cubemap de distances par lyre (atlas 2D), calculée une fois (et quand une lyre est déplacée) ; le décor ne bouge pas pendant un show. Utilisée par les faisceaux, les taches de lumière, la GI et la brume. |
| R4 | **Taches de lumière pour toutes les lyres** dans une passe à l'écran (profondeur + normales) : spot × gobo × couleur × ombre × N·L, diffus + **spéculaire Cook-Torrance** (reflets). Les **8 vraies lumières three.js des lyres sont supprimées**. |
| R5 | **GI en grille 3D** de la salle (≈ 48 × 16 × 64), mise à jour par tranches, éclaire le décor (rebond) et la brume. |
| R6 | **Reflets** « comme en vrai concert » : spéculaire au sol (R4) + **reflet des faisceaux** sur les surfaces brillantes (passe miroir basse résolution), chaque effet activable. |
| R7 | Choix du rendu **par lyre** (« Rendu du faisceau » : Global / Classique / SS Depth) ; réglages globaux synchronisés (halo, GI, reflets) ; qualité locale par machine (résolution SS, netteté, ombres, GI, reflets). Mesures GPU par passe affichées. |

## Phases

1. **A — Faisceaux SS Depth** (R1, R2, R7, mesures GPU, correction du rayon de lentille `SpotFixture.js:248`).
2. **B — Ombres statiques et taches de lumière** (R3, R4), suppression de `SpotLightPool`.
3. **C — GI et reflets** (R5, R6), brume éclairée par la GI.
