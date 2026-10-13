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

## Phase A — faite (branche `lyres-v2-a`)

**Fichiers** : `src/spot/ssdepth/SSDepthLights.js` (cônes + tri par tuile, CPU), `SSDepthShaders.js` (faisceaux,
halo), `SSDepthPass.js` (passe de scène) ; `src/render/GpuPassTimer.js` (mesures GPU par passe) ; remontée dans
`src/laser/FinalCompositePass.js`.

**Pipeline** (lyres en mode SS Depth) :
1. `SSDepthLights.collect` (après la mise à jour des lyres) : un cône par facette du prisme (faisceau central +
   facettes ; facette = cône **oblique** dont les sections perpendiculaires à l'axe restent des cercles, intersection
   toujours du 2e degré), 9 texels RGBA32F par cône ; lyres éteintes / noires ignorées.
2. `SSDepthLights.bin` (au rendu, caméra de l'image) : tronc octogonal circonscrit projeté, découpé par le plan
   proche, étendue exacte de chaque ligne de tuiles (32 × 18 tuiles, 128 cônes max par tuile) → texture RGBA16UI.
   Coût mesuré (conteneur de test, CPU lent) : 0,17 ms pour 50 lyres, 1,2 ms pour 50 lyres à prisme 8 facettes.
3. Passe des faisceaux à ½ / ⅓ / ¼ : profondeur 2×2 en damier min/max (seulement sur une vraie silhouette ;
   surface continue → moyenne, sinon le damier se voit), liste de la tuile, test d'intersection en 3 lectures,
   quadrature de Gauss 3 points (en 1/z quand le rayon remonte le faisceau : 1/z² intégré exactement), image de
   fenêtre complète sur l'échantillon du milieu, phase identique au classique, ombre des boîtes (SpotOcclusion)
   à chaque échantillon, tache au sol (lyres sans lumière réelle). Sortie rgb + profondeur linéaire.
4. Halo (si intensité > 0) à la même résolution : 8 échantillons de Poisson (tournés par pixel) de la scène +
   faisceaux SS + faisceaux classiques, occultation asymétrique, ajouté à l'image des faisceaux.
5. Passe finale : remontée bilatérale 3×3 guidée par la profondeur (tente bilinéaire + plancher 3×3, repli sur le
   texel de profondeur la plus proche), **avant** le brouillard (transmittance et bloom s'appliquent).

**Réglages** : par lyre « Rendu du faisceau » (Global / Classique / SS Depth, dossier ✨ Rendu) ; globaux
synchronisés « Rendu des faisceaux (défaut) » (SS Depth), « Halo atmosphérique (intensité / rayon) » (0,5 / 1) ;
locaux (⚙️ Options › Lyres) « Résolution des faisceaux SS » (⅓), « Netteté des bords » (1,5) ; « Mesures GPU par
passe » (⚙️ Options › Affichage : tableau en haut à droite, résolution dynamique figée pendant la mesure).

**Écarts / à savoir** :
- Barres LED : toujours en rendu classique (une barre = jusqu'à 32 faisceaux fusionnés, gérés par leur volume).
- Gobos : l'image complète est sur l'échantillon du milieu ; quand la lyre a une tuile dans l'atlas de fenêtre
  (cas normal), les 2 autres échantillons lisent aussi l'atlas (1 lecture) — sinon disque coloré comme le C++.
- Ombres : boîtes de SpotOcclusion testées aux 3 échantillons (point d'accroche « OMBRE » dans le shader pour la
  cubemap statique de la phase B). Tache au sol calculée en basse résolution (passe dédiée plein écran en phase B).
- Pas de sphère englobante (les faisceaux de 140 m la rendent inutile) : le test exact coûte 3 lectures.
- Faisceaux très fins (près de la lentille, de loin) plus larges qu'en classique : limite de la basse résolution
  (⅓ en 4K = 1280 × 720 ; ½ si besoin).
- Correction du rayon de lentille (`SpotFixture.js`, r[19]) et de r[50]/r[51].
