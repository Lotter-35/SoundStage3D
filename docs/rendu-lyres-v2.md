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

## Phase B — faite (branche `lyres-v2-b`)

**Fichiers** : `src/spot/lighting/shadowGLSL.js` (lecture des ombres, GLSL commun), `SpotShadowAtlas.js` (cuisson),
`LightPoolShaders.js` + `LightPoolPass.js` (taches de lumière) ; `src/spot/ssdepth/SSConeGLSL.js` (lecture d'un cône
et image de fenêtre, partagés par les faisceaux SS et les taches). **Supprimés** : `SpotLightPool.js` (8 SpotLight
three.js + textures de projection), `createGateMapMaterial`, les réglages « Éclairage réel » / « Ombres (2 max) »,
`poolWeight`.

### R3 — Ombres statiques

- Une « cubemap » de **distances** par lyre (6 faces S × S en bloc 3 × 2, 8 blocs par ligne d'un atlas 2D R16F,
  64 lyres au plus). Centre = **pivot de la tête** (fixe en pan / tilt) : l'ombre reste juste quand la lyre bouge.
- Choix cubemap plutôt qu'octaédrique : faces dessinées directement (rendu perspective 90°), lecture = choix de face
  + 1 lecture, pas de passe de reprojection ; 6 × 128² ≈ octaédrique 256² en densité moyenne.
- Cuisson : maillages visibles qui projettent une ombre (`castShadow`), hors personnages (maillages à squelette) et
  hors appareils instanciés mobiles (barres LED) ; ni faisceaux, ni lasers, ni boîtiers de lyres. Doublures légères
  (même géométrie, même matrice monde, matériau « distance »), rendu dans une cible 3S × 2S avec profondeur puis
  recopie dans l'atlas (l'atlas n'a pas de tampon de profondeur).
- **Étalée** : 2 lyres par image au plus ; une lyre déplacée perd son ombre jusqu'à ce qu'elle soit immobile
  4 images, puis est recuite ; empreinte du décor relevée toutes les 30 images (objet ajouté / déplacé, modèle GLB
  chargé) → tout est recuit progressivement (les anciennes ombres restent en attendant).
- Lecture `shadowHard(slot, origine, P, biais)` (1 lecture, faisceaux) et `shadowPCF` (2 × 2 bilinéaire sans
  déborder sur la face voisine, taches) ; biais = taille d'un texel à cette distance (+ pente, + décalage le long de
  la normale pour les taches).
- Utilisée par : faisceaux SS Depth (point « OMBRE », 3 échantillons), faisceaux classiques (option, chaque
  échantillon), taches de lumière. Une lyre dont la cubemap est cuite n'utilise plus les boîtes de `SpotOcclusion`
  (elles restent le repli : ombres désactivées, lyre au-delà de 64, cuisson en attente).

### R4 — Taches de lumière de toutes les lyres

- `SSDepthLights.collect` décrit maintenant les cônes de **toutes** les lyres allumées (faisceau Classique ou
  SS Depth) ; `bin` remplit **deux** listes par tuile : faisceaux SS (cône jusqu'à la longueur visible) et taches
  (cône jusqu'à la portée), une seule projection quand les longueurs sont égales. Tri fait une fois par image par la
  première passe qui en a besoin (`ensureBinned`). Texel L8 : éclairement des taches (lumière émise) et emplacement
  d'ombre ; ligne de paramètres r[50] (T12.z) : emplacement d'ombre pour le shader classique.
- `LightPoolPass` (avant la passe SS Depth) : par pixel, profondeur → position, **normale reconstruite** depuis la
  profondeur (voisin de plus petit écart en x et en y ; pas de passe de normales : le relief des normal maps est
  ignoré), liste de la tuile, test « point dans le cône » (3 lectures), image de fenêtre complète (gobos,
  couteaux, couleurs, prisme = un cône par facette), ombre PCF, N·L, **diffus + Cook-Torrance** (GGX, Schlick
  F0 = 0,04, visibilité de Kelemen, comme le banc C++).
- Matériaux sans G-buffer (comme `material()` du banc C++) : sol herbe (texture de la pelouse du matériau du sol,
  rugosité 0,9), dessus du plateau / marches / table (lino noir brillant, rugosité 0,3, spéculaire × 1,5), reste du
  décor (lino satiné, rugosité 0,6). Échelle = celle des anciennes SpotLight (60 × lumière émise / (π tan²)).
- Sortie rgb + profondeur ; ajoutée par `FinalCompositePass` **avant le brouillard** (pleine résolution : 1 lecture ;
  ½ : même remontée bilatérale 3×3 que les faisceaux SS, factorisée en `bilateralUp`). Le halo atmosphérique lit
  aussi les taches.
- La tache simple des phases précédentes (calculée en basse résolution dans les faisceaux) n'est plus utilisée que
  si « Taches de lumière » est désactivé (repli bon marché, sans ombre ni reflet). Barres LED : inchangées.

### Réglages

- Globaux synchronisés (🌫️ Rendu global des lyres) : **Taches de lumière** (oui), **Taches de lumière (intensité)**
  (1), **Reflets spéculaires** (oui).
- Locaux (⚙️ Options › Lyres) : **Ombres des lyres** (Désactivées / 128 / 256, défaut 128), **Ombres dans les
  faisceaux classiques** (oui), **Résolution des taches** (Auto / Pleine / ½ ; Auto = pleine jusqu'en 1080p, ½
  au-delà).
- Mesures GPU par passe : sections « Taches de lumière » et « Cuisson des ombres » ; le tableau indique aussi le
  nombre de cônes de taches, la résolution de la passe et l'état des ombres.

### Mesures (rendu logiciel SwiftShader, 1280 × 720, relatives, ±10 % de bruit)

| Scène (SS Depth) | Avant : total / Scène | Après : total / Scène | Taches (pleine) | Taches (½) |
|---|---|---|---|---|
| gobos (9 lyres) | 3075 / 1574 | 3745 / 1641 | 300 | – |
| vue de côté | 3129 / 1736 | 3493 / 1756 | 309 | – |
| sol (9 taches au sol) | – | 3905 / 1974 | 352 | ≈ 80 |
| 50 lyres | 2978 / 1652 | 3567 / 1528 | 318 | 68 |

- Taches de lumière en pleine résolution ≈ 20 % de la passe de scène, **≈ 4 % en ½** (4,7 × moins) : d'où « Auto ».
- Ombres : coût non mesurable dans les faisceaux et les taches (128 ou 256, ombres dans les faisceaux classiques
  ou non : dans le bruit). Cuisson : ≈ 65 (2 lyres, 6 faces de 128²) pour une passe de scène de ≈ 1800, seulement
  pendant les images qui cuisent.
- Les 8 SpotLight supprimées allègent tous les matériaux éclairés (8 textures de projection, 8 lumières) : la passe
  de scène n'augmente pas malgré l'éclairage de toutes les lyres.
- Captures avant / après : `cmp_gobos`, `cmp_side`, `cmp_floor`, `cmp_cut` (faisceau coupé par la table DJ),
  `cmp_gloss` (reflet sur le plateau), `cmp_many` (scratchpad de la session).

### Limites / à savoir

- Pas d'albédo réel : classement par position / normale (personnages et objets posés reçoivent l'albédo du lino).
- Les personnages et objets mobiles ne projettent pas d'ombre (décor statique seulement) ; ils reçoivent la lumière.
- Origine de l'ombre = pivot de la tête (lentille à 22 cm) : léger décalage tout près de la lyre.
- 128² par face : texel de 1,6 cm à 1 m, 1,6 m à 100 m → bords d'ombre doux / crénelés au loin (256 conseillé si
  la VRAM le permet : 44 Mo pour 50 lyres, 11 Mo en 128).
- Éclairage direct seulement : le rebond (GI) arrive en phase C (voir plus bas).

## Phase C — faite (branche `lyres-v2-c`)

**Fichiers** : `src/spot/gi/` (`GIGridPass.js` grille et mise à jour, `GIShaders.js` lumières virtuelles et
grille, `giGLSL.js` lecture), `src/spot/reflect/` (`BeamReflectPass.js`, `BeamReflectShaders.js`,
`SSReflectBins.js` tri des cônes en miroir), `src/spot/SpotLightingFX.js` (branchement et réglages),
GLSL partagé : `src/spot/ssdepth/SSBeamGLSL.js` (intersection rayon / cône, quadrature 3 points, ombres, phase —
sorti de `SSDepthShaders.js`, image identique), `src/spot/lighting/surfaceGLSL.js` (profondeur → position,
normale, matériau — sorti de `LightPoolShaders.js`). Modifiés : `LightPoolShaders/Pass` (rebond de la GI),
`HazeShaders/HazePass` (brume éclairée), `FinalCompositePass` (reflets), `shadowGLSL` (`shadowDepth`).

### R5 — Lumière indirecte (GI) en grille 3D

- **Grille** : texture 3D RGBA16F posée sur la salle (x −24…24, y −0,5…21,5, z −12…52 : plateau, mur, toit et
  50 m de public). Haute : 48 × 16 × 64 (comme le banc C++), Basse : 32 × 12 × 40.
  Texture 3D plutôt qu'atlas 2D : la **lecture** est le chemin chaud (chaque pixel du décor, chaque tranche du
  brouillard) et le filtrage trilinéaire matériel la fait en 1 lecture (atlas : 2 lectures + interpolation en z) ;
  l'écriture se fait couche par couche (`setRenderTarget(cible, couche)`), 16 dessins minuscules par image au plus.
- **Ce qui l'éclaire** (une passe de « lumières virtuelles », texture 48 × cônes) :
  1. **rebond sur le décor** : K rayons par cône (spirale de Vogel dans l'iris, tournée à chaque image) arrêtés
     sur le décor par la **cubemap de distances** de la lyre (ombres de la phase B ; repli : le sol), normale
     par 2 rayons voisins, albédo par le classement des taches ; lumière virtuelle diffuse de flux
     albédo × intensité × angle solide (gobos, couleurs, prisme compris) ;
  2. **faisceaux dans la fumée** : M points le long de chaque faisceau jusqu'au décor (tirés au hasard à chaque
     image), source isotrope de flux densité × longueur × flux du faisceau. Sur un plateau et un mur en lino noir
     (albédo ≈ 0,07) le vrai rebond est presque invisible : dans un vrai concert, c'est surtout la lumière des
     faisceaux diffusée par la fumée qui « allume » la salle.
  Budget fixe de lumières virtuelles (Basse 192, Haute 512 ; ⅗ décor, ⅖ faisceaux ; 2 à 16 + 1 à 8 par cône).
- **Mise à jour** par tranches : 1/8 des couches par image en Basse, 1/4 en Haute ; chaque cellule additionne
  toutes les lumières virtuelles (Φ/π × cos / (r² + r0²), demi-espace devant la surface seulement : pas de fuite
  sous le plateau ni derrière le mur ; pas de visibilité entre lumière virtuelle et cellule). **Lissage temporel**
  par mélange alpha (α = 0,6 / 0,5 par mise à jour : ≈ 8 images) — pas de double tampon, une lyre qui bouge ne
  fait pas scintiller la GI ; premier cycle sans lissage ; grille vidée quand plus aucune lyre n'est allumée.
- **Décor** : la passe des taches de lumière ajoute albédo / π × grille (lue 0,7 m devant la surface) pour tous
  les pixels du décor (elle tourne même si « Taches de lumière » est désactivé : GI seule).
- **Brume** : `HazeShaders` ajoute la grille lue au milieu de chaque tranche (1 lecture par tranche, diffusion
  isotrope) × densité × transmittance.
- **Intensité 1** = rendu de concert lisible : ≈ 12 × la valeur physique sur le décor (0,08 ≈ physique), ≈ 4 ×
  dans la brume (plus fort : voile gris sur toute la salle avec beaucoup de faisceaux).

### R6 — Reflets

- **Spéculaire des taches** : phase B (Cook-Torrance), inchangé.
- **Reflets des faisceaux** sur le dessus brillant du plateau (lino noir, rugosité 0,3) : passe en ¼ (défaut) ou ⅛
  de résolution ; pour chaque pixel du plateau, rayon de vue réfléchi autour de la normale reconstruite, diffusion
  des faisceaux SS Depth le long de ce rayon avec **exactement** le code des faisceaux (intersection exacte,
  3 échantillons, gobos, prisme, ombres statiques), × Fresnel de Schlick (F0 = 0,04) × brillance 1,5 × intensité ;
  flou de rugosité 3 × 3 guidé par la profondeur ; remontée bilatérale par la passe finale, avant le brouillard.
- **Liste des cônes** : un rayon réfléchi ne passe pas par les tuiles de l'écran. Le reflet dans un plan y = h est
  le rayon de vue prolongé sous le plan : les cônes sont triés par tuile avec la vue « caméra × miroir du plan »
  (même code CPU que le tri des faisceaux, 0,1 à 0,3 ms pour 50 lyres). Mesuré : boucle sur tous les faisceaux
  dans chaque tuile 1,55 × plus lente (9 lyres sur le plateau) et tronquée à 128 cônes → tri en miroir retenu.
- Lasers et barres LED : **non reflétés** (pas de description en cônes ; leur rendu n'est pas un tracé de rayon) ;
  faisceaux des lyres en rendu Classique non reflétés non plus.

### Réglages

- Globaux synchronisés (🌫️ Rendu global des lyres) : **Lumière indirecte (GI)** (oui), **Lumière indirecte
  (intensité)** (1, 0 à 4), **Brume éclairée par la GI** (oui), **Reflets des faisceaux** (oui), **Reflets des
  faisceaux (intensité)** (1, 0 à 3).
- Locaux (⚙️ Options › Effets › Lyres) : **Qualité GI** (Désactivée / **Basse** / Haute ; Désactivée = aucun
  coût), **Résolution des reflets** (**¼** / ⅛).
- Mesures GPU par passe : sections « GI (lumières virtuelles) », « GI (grille) », « Reflets des faisceaux » ;
  lignes « GI : grille, couches / image, lumières virtuelles » et « Reflets : cônes, résolution ».

### Mesures (rendu logiciel SwiftShader, 1280 × 720, relatives, ±10 % de bruit — ±20 % sur la passe de scène)

Passes ajoutées (même image, variantes activées / désactivées sur la même page) :

| Scène | Scène (passe) | GI (lumières virtuelles) | GI (grille) Basse / Haute | Reflets ¼ / ⅛ | Reflets ¼ sans tri en miroir | Taches (GI off → on) |
|---|---|---|---|---|---|---|
| 50 lyres (`many`) | ≈ 1600 | 1,3 | 6 / 69 | 26 / 6 | 32 | ≈ +5 % |
| plateau brillant, 9 lyres (`gloss`) | ≈ 1700 | 1,3 | 5 / 36 | 45 / 11 | 70 | ≈ +4 % |

- Par défaut (GI Basse, reflets ¼) la phase C coûte **≈ 1 à 3 % de la passe de scène** ; GI Haute ≈ 2 à 4 % ;
  reflets ⅛ ≈ 4 × moins chers que ¼. Le rebond sur le décor ajoute la normale et 1 lecture 3D à chaque pixel de
  la passe des taches (½ résolution en 4K). Brume éclairée : 1 lecture par tranche, dans le bruit de mesure.
- Totaux avant (phase B) / après (phase C, défaut) : gobos 3430 / 3387, 50 lyres 3484 / 3463, plateau brillant
  3506 / 3748 (bruit ±10 %). À confirmer sur la GTX 1080 avec « Mesures GPU par passe ».
- Captures (scratchpad de la session) : `cmp_gloss` (reflets des faisceaux sur le plateau), `cmp_wall_gi`
  (lyres rouge et bleue sur le mur : désactivé / GI sur le décor / + brume éclairée), `cmp_gobos_haze` (brume
  éclairée par la GI). Aucune erreur de shader ni de console, tout activé et chaque option désactivée.

### Limites / à savoir

- GI : grille fixe sur le plateau et le public proche (hors grille : pas de GI) ; pas de visibilité entre une
  lumière virtuelle et une cellule (lumière qui passe à travers un poteau ou une enceinte) ; grille scalaire
  (pas de direction) : une surface éclairée reçoit aussi un peu de sa propre lumière (halo coloré doux autour des
  taches, comme le banc C++) ; matériaux classés par position / normale (pas d'albédo réel) ; une cellule de
  1 à 1,8 m : pas de détail fin, c'est une lumière d'ambiance. Sans ombres statiques, les rayons s'arrêtent sur le
  sol seulement.
- Brume éclairée : une lecture par tranche du brouillard (2 tranches par défaut) : variations lentes seulement.
- Reflets : seulement le dessus du plateau (plan y = 3 m ; marches, table DJ et sol non reflétés), seulement les
  faisceaux SS Depth ; le rayon réfléchi n'a pas de profondeur : un faisceau caché derrière un objet peut se
  refléter (le toit et le mur coupent déjà les faisceaux par leurs ombres) ; caméra sous le plateau : passe
  sautée. En ⅛ les reflets sont plus flous / plus grossiers.

## Résumé de tous les réglages des lyres v2 (phases A, B, C)

| Réglage | Où | Défaut | Effet / coût |
|---|---|---|---|
| Rendu du faisceau (par lyre) | ✨ Rendu de la lyre | Global | Classique / SS Depth |
| Rendu des faisceaux (défaut) | 🌫️ global | SS Depth | faisceaux en basse résolution, coût ∝ pixels touchés |
| Halo atmosphérique (intensité / rayon) | 🌫️ global | 0,5 / 1 | halo autour des sources ; 0 = passe sautée |
| Taches de lumière (+ intensité) | 🌫️ global | oui / 1 | éclairage du décor par toutes les lyres |
| Reflets spéculaires | 🌫️ global | oui | reflets des taches (Cook-Torrance) |
| Lumière indirecte (GI) (+ intensité) | 🌫️ global | oui / 1 | rebond sur le décor + lumière des faisceaux dans la salle |
| Brume éclairée par la GI | 🌫️ global | oui | la fumée de la salle prend la couleur des lyres |
| Reflets des faisceaux (+ intensité) | 🌫️ global | oui / 1 | faisceaux reflétés dans le plateau brillant |
| Résolution des faisceaux SS | ⚙️ local | ⅓ | ½ / ⅓ / ¼ |
| Netteté des bords | ⚙️ local | 1,5 | remontée bilatérale des faisceaux |
| Ombres des lyres | ⚙️ local | 128 | Désactivées / 128 / 256 (cubemaps cuites une fois) |
| Ombres dans les faisceaux classiques | ⚙️ local | oui | |
| Résolution des taches | ⚙️ local | Auto | pleine jusqu'en 1080p, ½ au-delà |
| Qualité GI | ⚙️ local | Basse | Désactivée / Basse / Haute |
| Résolution des reflets | ⚙️ local | ¼ | ¼ / ⅛ |
| Mesures GPU par passe | ⚙️ Affichage | non | tableau des temps par passe |
