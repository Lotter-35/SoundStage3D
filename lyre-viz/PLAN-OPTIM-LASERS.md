# Optimisation des lasers : plan

Plan du 18 octobre 2026. **Rien n'est codé** : c'est une base de discussion avant de lancer une session de codage. Lasers seulement ; les lyres ne changent pas (sauf mention).

- Objectif : 3840 × 2160 à 120 img/s sur la GTX 1080, soit **8,33 ms par image**.
- Mesures de départ (état du dépôt au commit `4fc3f93`, réglages par défaut : fumée v2 « Nuages larges et doux », rendu photo, convergence RGB) :
  - `bench\plan_las_0` et `bench\plan_las_1` : banc des lasers complet, en mouvement, banc rapide, 2 lancements ;
  - `bench\plan_las_stats` : compteurs (`--stats`) ;
  - `bench\plan_opt_*` : coût de chaque option, scène immobile, 10 cas ;
  - `bench\plan_spectacles.tsv` : les 30 scènes de spectacle (lyres + lasers).
- Documents relus : `README.md`, `PERFORMANCE.md`, `PLAN-LASERS.md`, `PLAN-FUMEE-LASERS-V2.md`, `docs/optimisations-lasers.md`, `docs/analyse-lag-lasers.md`, `docs/spectacles/README.md`.

## 1. Où on en est

Moyenne des 2 lancements. « × budget » : durée de l'image divisée par 8,33 ms.

| Cas | Image (img/s) | GPU | Passes laser | dont arcs | Couples (millions) | × budget |
|---|---|---|---|---|---|---|
| L1 éventails 200 × 1 000 traits / public | 22,5 ms (44) | 21,6 | 17,4 | 0 | 164 | 2,7 |
| L1 / scène | 19,5 ms (51) | 18,6 | 14,7 | 0 | 157 | 2,3 |
| L1 / sous les trusses | 18,7 ms (53) | 18,0 | 13,8 | 0 | 127 | 2,2 |
| L2 cônes / public | 24,0 ms (42) | 22,9 | 18,5 | 17,1 | 137 | 2,9 |
| L2 cônes / scène | 24,7 ms (40) | 23,8 | 19,2 | 17,6 | 136 | 3,0 |
| L3 caméra dans les nappes | 18,5 ms (54) | 17,8 | 13,6 | 0 | 148 | 2,2 |
| L4 200 × 8 traits séparés | 9,9 ms (101) | 7,2 | 3,5 | 0 | 34 | 1,2 |
| L5 gros plan, fumée épaisse | 21,0 ms (48) | 20,2 | 16,0 | 0 | 179 | 2,5 |
| L6 traits vers le sol et les obstacles | 23,5 ms (43) | 22,5 | 18,2 | 0 | 196 | 2,8 |
| M1 100 lyres + 100 lasers / public | 15,9 ms (63) | 15,3 | 10,1 | 0 | 82 | 1,9 |
| M1 / scène | 14,5 ms (69) | 13,6 | 8,4 | 0 | 71 | 1,7 |
| M1 / sous les trusses | 13,9 ms (72) | 13,2 | 8,2 | 0 | 61 | 1,7 |
| Scène seule, sans lasers | 5,2 ms (192) | 3,5 | 0 | 0 | — | 0,6 |
| L7 programmeur (toutes les formes) | 46,1 ms (22) | 45,1 | 40,9 | 21,0 | 330 | 5,5 |
| I1 ILDA Nappes | 62,2 ms (16) | 61,3 | 57,1 | 38,1 | 484 | 7,5 |
| I2 ILDA Faisceaux | 10,5 ms (95) | 8,3 | 4,5 | 0 | 54 | 1,3 |
| I3 ILDA Géométrie | 114,6 ms (9) | 113,7 | 109,6 | 90,9 | 862 | 13,8 |
| I4 ILDA Tunnels | 65,6 ms (15) | 64,6 | 60,2 | 50,8 | 422 | 7,9 |
| L1 en mode ligne | 23,2 ms (43) | 22,1 | 17,5 | 0 | 165 | 2,8 |
| P1 tracé : dessins (Crayon) | 119,2 ms (8) | 118,4 | 114,4 | 103,9 | 851 | 14,3 |
| P2 tracé : formes | 60,9 ms (16) | 60,3 | 56,1 | 42,6 | 431 | 7,3 |
| P3 tracé : sinus, Lissajous | 114,2 ms (9) | 113,3 | 109,4 | 104,0 | 863 | 13,7 |

Les ajouts du 16 au 18 octobre (rendu photo, convergence RGB, fumée v2 par défaut) ont alourdi tous les cas : L1 / public est passé de 13,4 ms (`avant_arcs.exe`, `PERFORMANCE.md`) à 22,5 ms. Aucun cas du banc des lasers ne tient 120 img/s ; L4 et I2 en sont les plus proches.

## 2. Ce qui coûte

### 2.1 Une règle : couples × prix d'un couple

Un **couple** est un pixel traversé par une nappe. Le temps des passes laser est presque entièrement le nombre de couples multiplié par le prix d'un couple (`docs/analyse-lag-lasers.md` : modèle R² = 0,89).

| | Prix d'un couple aujourd'hui | Toutes options coupées (`plan_opt_minimal`) |
|---|---|---|
| Nappes planes (L1) | ~105 ps | ~43 ps |
| Nappes courbes, ou arcs (L2, I3, P1, P3) | 122 à 132 ps | ~77 ps |

- **Le prix d'un couple a plus que doublé avec les options de réalisme**, la fumée v2 surtout. C'est le premier levier.
- Les couples, eux, viennent du contenu : nombre de lasers, copies de la diffraction, figures à plusieurs nappes, ouverture, nappes braquées vers la caméra. Ce sont surtout des couples **utiles** : 49 à 92 % éclairent vraiment (`docs/optimisations-lasers.md`).

### 2.2 Coût de chaque option

Mesure : scène immobile, 10 cas, contre la moyenne de 2 lancements par défaut, dont l'écart est de 0 à 3 %. Chiffres : écart du GPU de l'image.

| Option coupée | L1 | L2 | L3 | L4 | M1 | L7 | I1 | I3 | P3 |
|---|---|---|---|---|---|---|---|---|---|
| Fumée v2 → Classique (volutes) | −5,1 (−25 %) | −4,3 | −4,0 | −1,3 | −2,3 | −9,9 | −15,3 | −27,4 | −28,9 (−25 %) |
| Fumée v2 → « Hazer propre » (carte seule) | −3,2 (−16 %) | −2,4 | −4,1 | −0,8 | −2,1 | −9,7 | −15,3 | −27,2 | −32,0 (−27 %) |
| Fumée uniforme, un lobe | −7,6 (−38 %) | −5,3 | −6,5 | −1,6 | −3,8 | −15,1 | −23,2 | −41,3 | −42,2 (−36 %) |
| Convergence RGB et objectif | −1,6 (−8 %) | 0 | −1,3 | −1,0 | −0,2 | −3,2 | −2,2 | −6,1 | −6,2 (−5 %) |
| Impacts | −0,5 | −0,4 | −0,9 | −0,7 | −0,3 | ~0 | −1,4 | −4,6 | −2,9 |
| Halo | −0,3 | −0,5 | −0,2 | −0,6 | −0,3 | ~0 | (bruit) | −0,8 | (bruit) |
| Bords brillants | dans le bruit (0 à −8 %) | | | | | | | | |
| Lueur de sortie | 0 | | | | | | | | |
| **Tout coupé** | **−9,5 (−47 %)** | −7,0 (−29 %) | −8,6 (−45 %) | −2,6 (−35 %) | −4,3 (−30 %) | −18,3 (−43 %) | −26,8 (−41 %) | −45,1 (−40 %) | −44,7 (−38 %) |
| Résolution 80 % (`scale=0.8`, toute l'image) | −6,3 (−31 %) | −7,5 | −5,7 | −0,5 | −3,9 | −12,9 | −21,0 | −36,0 | −38,8 (−33 %) |
| AMD FSR ÷1,5 | −9,2 (−46 %) | −9,9 | −8,6 | −0,4 | −5,3 | −18,7 | −31,2 | −57,2 | −59,3 (−51 %) |
| AMD FSR ÷2 | −12,7 (−63 %) | −13,8 | −12,2 | −2,6 | −7,8 | −27,3 | −44,4 | −75,9 | −79,6 (−68 %) |

### 2.3 Trois coûts hors du calcul des couples

1. **La cadence d'affichage** (le plus inattendu). Dans les cas légers, une image dure 1,7 à 2,7 ms de plus que son temps GPU :
   - L4 : GPU 7,2 ms, image 9,9 ms ;
   - I2 : GPU 8,3 ms, image 10,5 ms ;
   - scène seule : GPU 3,5 ms, image 5,2 ms.

   Image par image (`images.csv`), les durées vont par cycles de 3, par exemple 23 / 1,2 / 6,5 ms pour L4. Chaque image ne demande que 6,5 à 7,3 ms de GPU : la carte reste inactive près d'un tiers du temps, et les cycles tombent sur des multiples de 8,33 ms (l'écran est à 120 Hz). Causes probables :
   - sokol crée la chaîne d'échange avec 2 tampons, `SetMaximumFrameLatency(1)`, et présente sans le drapeau « tearing » (`external/sokol/sokol_app.h`). En plein écran sans bordure, la carte attend alors le rafraîchissement pour récupérer un tampon ;
   - le CPU fait sa part de l'image (≈ 2,5 à 3 ms) pendant que la carte attend.

   À 120 Hz, c'est 1,5 à 2,5 ms perdues par image, justement dans les cas proches du but.
2. **La simulation de fumée sur le CPU** : en moyenne 2 à 2,3 ms par image, en réalité un pas d'environ 6 ms (20 pas par seconde) sur le fil principal. À 120 Hz, un à-coup toutes les 6 images.
3. **Le coût fixe des lasers allumés**, environ 1 ms dès qu'un laser est allumé :
   - la passe des nappes calcule toutes les tuiles de l'écran, même vides (lecture de profondeur, rayon, écriture) ;
   - la passe des arcs écrit toute l'image des arcs (4K, RGBA16F), relue ensuite ;
   - halo 0,32 ms ;
   - composition +0,25 ms.

   S'y ajoutent, côté salle : avec les lyres éteintes, les passes de fumée des lyres tournent encore (« fumée : faisceaux » 0,52 ms + accumulation 0,13 ms).

### 2.4 Déjà essayé : ne pas refaire

- **Passe des arcs** : optimisations exactes du shader épuisées. Au mieux −1,4 %, et le meilleur rejet serré imaginable rapporterait au plus −8 % (`docs/optimisations-lasers.md`).
- **Tuiles intérieures** : lumière entière interpolée sur la tuile, coins et centre. Plus lent, seulement 32 % des couples étaient intérieurs.
- **Nombre de pixels par fil** : 1 ou 4 au lieu de 2, boucle non déroulée, segments lus dans le tampon, lots de 32 ou 64 segments. Tous plus lents.
- **Variante « nappes et traits seuls »** : aucun gain.
- **Morceaux d'arcs plus petits** (45° ou 22,5°) : plus de couples. Biarcs par corde : trop chers.
- **Règles de la passe** :
  - tout code ajouté la ralentit, même coupé (registres) : une option chère passe par une **variante du shader** ;
  - une 2e texture envoyée à chaque image fait attendre la carte sous Direct3D 11 ;
  - une passe longue (arcs) dérive de 10 à 20 % d'un lancement à l'autre : la comparer **dans un même lancement**.

## 3. Pistes, de la moins à la plus destructive

Niveaux (ceux de `docs/optimisations-lasers.md`) :
- **0** : image strictement identique ;
- **1** : invisible à l'œil (petits écarts mesurables) ;
- **2** : visible sur une image fixe, discret en mouvement ;
- **3** : destructif.

Les gains sont des estimations (± 30 %), à confirmer par la mesure.

### Niveau 0 : image identique

| # | Piste | Comment | Gain estimé | Effort |
|---|---|---|---|---|
| 0.1 | **Cadence d'affichage** | Chaîne d'échange : présentation avec « tearing » sans synchro verticale (bancs), 3 tampons et latence DXGI 2 ; synchro à 120 Hz pour le spectacle. Le CPU prépare l'image suivante pendant que la carte calcule. Petite modification de `sokol_app.h` (Direct3D 11) | Image = GPU + ~0,3 ms au lieu de + 1,7 à 2,7 : **L4 9,9 → ~7,5 ms (101 → ~130 img/s), I2 10,5 → ~8,7, scène seule 5,2 → ~3,9** ; cas lourds −1 ms. Touche aussi les lyres (en mieux) | Petit |
| 0.2 | **Fumée du CPU en parallèle** | Le pas de simulation (≈ 6 ms) dans une tâche de fond, sur plusieurs cœurs, avec un envoi à l'image suivante. Le moteur des lasers est déjà multicœur | Plus d'à-coup toutes les 6 images ; le CPU (≈ 3 ms) ne s'ajoute plus au GPU (avec 0.1) | Moyen |
| 0.3 | **Tuiles vides sautées** | Passes des nappes et des arcs : rien à faire dans une tuile sans segment ; image des arcs écrite et lue seulement là où il y en a ; halo et composition limités aux tuiles allumées (masque par tuile) | −0,2 à −0,5 ms sur tous les cas laser | Petit |
| 0.4 | **Variante du shader par grosse tuile (128 px)** | Aujourd'hui, une seule variante pour toute l'image : si un seul segment passe près de la caméra, toute la passe prend les filaments (variante 5). De même pour la convergence RGB (un seul laser multicolore suffit) et les dégradés. Le tri (`cs_laser_bin`) note pour chaque grosse tuile ce dont ses segments ont besoin ; 2 ou 3 passes, chacune ne traite que ses tuiles (les autres sortent tout de suite) | L1, L3 −1 à −2 ms ; L7, I1, I3, P3 −2 à −5 ms (environ la moitié du coût des filaments et de la convergence) | Moyen |
| 0.5 | **Cônes et cercles en une seule nappe conique** | Un cône est découpé en 4 morceaux de 90° : chaque morceau calcule l'équation du cône entier dans les pixels qu'il couvre, puis rejette l'autre côté. Un seul morceau de 360° (enveloppe à l'écran : la source et l'ellipse de la base), et les arcs voisins d'un même cercle fusionnés dans les tracés ILDA | Passe des arcs −15 à −20 % sur les cônes et tunnels : L2 −3 ms, L7 −1,5 ms, I4 et P2 −5 %, spectacles Tunnel, Vortex, Rosace | Moyen |
| 0.6 | Tri plus fin par bande de 16 × 2 pixels (un warp) | Un warp entier saute un segment dont le polygone ne touche pas sa bande | −2 à −5 % (le maximum mesuré pour les arcs est −8 %) | Moyen |
| 0.7 | Profondeur maximale par tuile | Ignorer les segments entièrement derrière les surfaces de la tuile | ~0 sur le banc (hangar vide) ; plus dans une vraie scène (scène, mur LED, public) | Petit |
| 0.8 | Moteur CPU des lasers | Diffraction : l'ajustement du tracé fait une fois pour toutes les copies (la même figure dans le plan du scanner) ; vagues : ajustement partagé entre les lasers qui ont les mêmes réglages | CPU −1 à −5 ms dans les cas extrêmes (vagues ou ILDA avec diffraction ×5 à ×9 : jusqu'à 7,4 ms aujourd'hui) ; rien sur le GPU | Moyen |
| 0.9 | Salle : passes de fumée des lyres sautées quand aucune lyre n'est allumée | À vérifier : la lumière indirecte de la fumée doit être nulle sans lyre (image identique) | −0,6 ms sur les bancs « lasers seuls ». Touche le code des lyres, pas leur image | Petit |

### Niveau 1 : invisible à l'œil

| # | Piste | Comment | Gain estimé | Effort |
|---|---|---|---|---|
| 1.1 | **Lumière lente interpolée par tuile** | Pour chaque couple, une partie du calcul varie lentement d'un pixel à l'autre : fumée au point de la nappe (carte, nuages, tourbillons), diffusion vers l'avant, atténuation. Elle est calculée aux 4 coins et au centre de la tuile de 16 px pour chaque segment, pendant le chargement des segments en mémoire partagée (2 % du travail), puis interpolée par pixel. Tout ce qui fait la netteté reste exact par pixel : position dans la nappe, traits, bords, bords brillants, convergence, coupures, profondeur. Le centre sert de contrôle : si l'interpolation s'en écarte de plus de ~1 %, la tuile garde le calcul par pixel pour ce segment. Cas concernés : nappe vue par la tranche, près de la source, bord net d'un banc, filaments de près. La décision vaut pour toute la tuile : aucune divergence dans les warps. Différence avec les « tuiles intérieures » écartées : seule la partie lente est interpolée (jamais la nappe ni les traits), donc presque tous les couples en profitent ; et le choix se fait pendant le chargement des segments, sans qu'un fil fasse attendre le groupe | **Nappes −25 à −35 %, arcs −20 à −30 %** : L1 −4 à −5 ms, L2 −3,5, L7 −10, I1 −13, I3 et P3 −25 à −30 ms. C'est le plus gros levier sans perte visible | Gros (nappes planes d'abord, puis arcs) |
| 1.2 | Niveau de détail de la fumée v2 selon la distance | Filaments sur une portée plus courte (~5 m au lieu de ~7 m) ; au loin, nuages lus à un niveau plus grossier, puis remplacés par leur moyenne (c'était la demande : « de loin, seulement la forme d'ensemble ») | −3 à −8 % (moins après 1.1) | Petit |
| 1.3 | **Lumière noyée** | Un pixel déjà saturé (bien au-delà du blanc après l'exposition et ACES) : les nappes suivantes y sont calculées sans le détail de la fumée. **Mesurer d'abord** la part des couples concernés (compteur seul, image inchangée) | 0 dans les cas légers ; −10 à −20 % quand les nappes s'empilent (L7, ILDA : 40 à 100 couples par pixel) | Moyen |
| 1.4 | Halo tiré de la pyramide du bloom | Une seule pyramide au lieu de deux | −0,3 ms sur tous les cas laser | Petit |

### Niveau 2 : visible sur une image fixe, discret en mouvement

Ce niveau ne se déclenche **que quand l'image dépasse le budget** : une scène légère garde la pleine qualité (qualité adaptative, comme pour les lyres).

| # | Piste | Comment | Gain estimé | Effort |
|---|---|---|---|---|
| 2.1 | **Échelle de qualité des lasers en charge** | Au-delà du budget, par paliers avec hystérésis (sans saut visible) : filaments coupés → convergence RGB coupée → passes laser à 80 % de la résolution → 70 % → 50 %. Traits élargis en gardant leur énergie ; image des lasers agrandie en tenant compte de la profondeur. Le 80 % était déjà accepté (`docs/optimisations-lasers.md`, piste 8) | Filaments −5 %, convergence −5 à −13 %, 80 % −30 %, 70 % −45 %, 50 % −60 à −65 % des passes laser. Traits plus doux pendant les moments chargés | Moyen |
| 2.2 | Résolution mixte | Intérieurs lisses des nappes à 1/2 de la résolution ; détails (traits, bords, silhouettes) à pleine résolution, repérés par le contraste de l'image réduite | −20 à −40 % dans les cas lourds et lisses (ILDA, cônes), moins dans L1 (traits visibles partout) ; moins utile après 1.1 et 2.1 | Très gros |
| 2.3 | FSR dynamique | `PERFORMANCE.md`, « FSR dynamique » : toute l'image (lyres comprises), en dernier palier | ÷1,5 : −45 % ; ÷2 : −63 % | Moyen |

### Niveau 3 : destructif (déconseillé)

| # | Piste | Effet | Gain |
|---|---|---|---|
| 3.1 | Fumée uniforme pour les lasers | Ni nuages, ni bancs, ni volutes (le rendu que la v2 a remplacé) | −30 à −45 % |
| 3.2 | Moitié des pixels par image, en damier | Traînées et scintillement sur les lasers rapides | −40 à −50 % |
| 3.3 | ILDA : tolérance du tracé plus large | Moins de morceaux, coins arrondis, formes moins exactes | −10 à −30 % sur I et P |
| 3.4 | Contenu des spectacles | Moins de copies de diffraction, moins de nappes braquées sur le public | selon la scène |

## 4. Ce qu'on peut en attendre, banc par banc

Estimation par modèle : gains de la section 3 appliqués aux passes mesurées de chaque cas ; ± 30 %, à remplacer par les mesures au fil du travail. Chaque colonne s'ajoute à la précédente. Format : ms par image / img/s.

- Niveau 0 : 0.1 (image = GPU + 0,4 ms), 0.3, 0.4 (moitié du coût mesuré de la convergence et des filaments), 0.5 (18 % des arcs pour L2, moins ailleurs), 0.6, 0.9.
- Niveau 1 : 1.1 (nappes −30 %, arcs −25 %), 1.2 (−4 %), 1.3 seulement quand les nappes s'empilent (−5 % à 15 couples par pixel, −15 % à 35, −20 % à 80), 1.4.
- Niveau 2 : 2.1, palier à 80 % (−32 % des passes laser restantes) puis à 50 % (−62 %).

| Cas | Aujourd'hui | Niveau 0 | + niveau 1 | + 2.1 à 80 % | + 2.1 à 50 % |
|---|---|---|---|---|---|
| L1 / public | 22,5 / 44 | 19,3 / 52 | 14,8 / 68 | 11,3 / 88 | 8,1 / **124** |
| L1 / scène | 19,5 / 51 | 16,9 / 59 | 12,8 / 78 | 9,9 / 101 | 7,2 / **140** |
| L1 / sous les trusses | 18,7 / 53 | 16,4 / 61 | 12,5 / 80 | 9,8 / 102 | 7,3 / **138** |
| L2 cônes / public | 24,0 / 42 | 17,5 / 57 | 14,1 / 71 | 11,0 / 91 | 8,0 / **125** |
| L2 cônes / scène | 24,7 / 40 | 18,2 / 55 | 14,7 / 68 | 11,4 / 88 | 8,3 / **120** |
| L3 caméra dans les nappes | 18,5 / 54 | 15,9 / 63 | 12,4 / 81 | 9,7 / 103 | 7,1 / **140** |
| L4 traits séparés | 9,9 / 101 | 6,0 / **166** | 5,5 / **182** | — | — |
| L5 gros plan | 21,0 / 48 | 18,4 / 54 | 14,0 / 72 | 10,8 / 93 | 7,7 / **129** |
| L6 sol et obstacles | 23,5 / 43 | 20,4 / 49 | 15,4 / 65 | 11,8 / 85 | 8,4 / 120 |
| M1 / public (dont ~5 ms de lyres) | 15,9 / 63 | 14,8 / 67 | 12,3 / 81 | 10,2 / 98 | 8,2 / **122** |
| M1 / scène | 14,5 / 69 | 13,2 / 76 | 11,3 / 89 | 9,5 / 105 | 7,8 / **128** |
| M1 / sous les trusses | 13,9 / 72 | 12,7 / 79 | 10,8 / 93 | 9,1 / 110 | 7,4 / **134** |
| Scène seule | 5,2 / 192 | 3,3 / 300 | | | |
| L7 programmeur | 46,1 / 22 | 38,6 / 26 | 26,7 / 37 | 19,5 / 51 | 12,8 / 78 |
| I1 ILDA Nappes | 62,2 / 16 | 55,7 / 18 | 37,5 / 27 | 26,8 / 37 | 16,9 / 59 |
| I2 ILDA Faisceaux | 10,5 / 95 | 7,5 / **133** | 6,4 / **157** | — | — |
| I3 ILDA Géométrie | 114,6 / 9 | 101,9 / 10 | 65,1 / 15 | 45,8 / 22 | 27,6 / 36 |
| I4 ILDA Tunnels | 65,6 / 15 | 54,8 / 18 | 37,9 / 26 | 27,2 / 37 | 17,2 / 58 |
| L1 en mode ligne | 23,2 / 43 | 20,1 / 50 | 15,3 / 65 | 11,8 / 85 | 8,5 / 117 |
| P1 dessins | 119,2 / 8 | 105,9 / 9 | 68,0 / 15 | 47,9 / 21 | 29,0 / 34 |
| P2 formes | 60,9 / 16 | 51,5 / 19 | 35,4 / 28 | 25,4 / 39 | 16,1 / 62 |
| P3 sinus, Lissajous | 114,2 / 9 | 101,3 / 10 | 65,0 / 15 | 45,6 / 22 | 27,4 / 36 |

Ce que ça veut dire :

- **Niveaux 0 et 1, sans perte visible** : L4 et I2 passent nettement au-dessus de 120 img/s ; les autres cas de 200 lasers gagnent 35 à 45 % (L1 de 44 à ~68 img/s), sans encore tenir le budget.
- **Avec la qualité adaptative (2.1)** : tous les cas L et M1 atteignent ~120 img/s, au prix de traits plus doux dans les moments les plus chargés.
- **L7 et les bancs ILDA à 200 figures** (I1 à I4, P1 à P3) restent loin du but : 6 à 14 fois le budget aujourd'hui, encore 2 à 4 fois avec tout le plan. Ce sont des tests de limite (200 figures en plein champ). Les amener à 120 img/s demanderait le niveau 3 (fumée uniforme, damier) ou FSR ÷2 en plus de tout le reste. Proposition : les garder comme repères de progrès, pas comme cible.

## 5. Spectacles (cas réalistes)

Les 30 scènes du générateur (lyres + lasers, 3 à 29 lasers allumés), vue du public, énergie 0,65, un lancement par scène (`bench\plan_spectacles.tsv`, méthode de `docs/spectacles/README.md`).

- « Image » : durée réelle moyenne entre deux images (img/s).
- « GPU » : temps GPU moyen ; « 90e c. » : son 90e centile.
- Estimations : les lyres comptées environ 2 ms et la salle 3,5 ms, le reste aux lasers ; mêmes gains que la section 4 ; ± 30 %.

| Scène | Image (img/s) | GPU | 90e c. | Lasers | Niveaux 0 + 1 | + 2.1 à 80 % | + 2.1 à 50 % |
|---|---|---|---|---|---|---|---|
| 1. Horizon | 11,6 (86) | 10,7 | 14,2 | 8 | 8,5 | 7,5 | 6,5 |
| 2. Plafond | 9,7 (103) | 7,3 | 8,0 | 8 | 6,4 | 6,1 | 5,7 |
| 3. Cathédrale | 9,3 (107) | 7,2 | 9,0 | 16 | 6,3 | 6,0 | 5,7 |
| 4. Rideaux | 8,8 (114) | 7,1 | 10,6 | 20 | 6,3 | 6,0 | 5,7 |
| 5. Portiques | 7,7 (130) | 6,0 | 9,3 | 14 | 5,6 | 5,5 | 5,4 |
| 6. Pluie | 8,5 (118) | 7,2 | 11,2 | 24 | 6,4 | 6,0 | 5,7 |
| 7. Convergence | 10,2 (98) | 8,2 | 9,7 | 12 | 7,0 | 6,5 | 5,9 |
| 8. Ciseaux | 10,4 (96) | 7,8 | 8,2 | 12 | 6,7 | 6,3 | 5,8 |
| 9. Rencontre | 11,0 (91) | 9,7 | 14,1 | 24 | 7,9 | 7,1 | 6,3 |
| 10. Balayage | 8,7 (115) | 7,0 | 10,7 | 24 | 6,2 | 5,9 | 5,6 |
| 11. Radar | 11,4 (88) | 10,5 | 14,4 | 8 | 8,4 | 7,5 | 6,5 |
| 12. Kaléidoscope | 12,2 (82) | 11,3 | 13,0 | 8 | 8,9 | 7,8 | 6,7 |
| 13. Hélice | 12,7 (79) | 11,6 | 13,9 | 8 | 9,1 | 7,9 | 6,7 |
| 14. Tunnel | 17,1 (59) | 16,2 | 19,4 | 5 | 11,9 | 10,0 | 7,8 |
| 15. Vortex | 16,1 (62) | 15,3 | 18,6 | 4 | 11,4 | 9,6 | 7,6 |
| 16. Rosace | 17,2 (58) | 16,5 | 19,6 | 8 | 12,1 | 10,1 | 7,9 |
| 17. Spirale | 12,1 (83) | 11,0 | 13,4 | 16 | 8,7 | 7,7 | 6,6 |
| 18. Étoiles | 15,0 (67) | 14,2 | 17,9 | 8 | 10,7 | 9,1 | 7,4 |
| 19. Géométrie | 16,3 (62) | 15,5 | 16,8 | 8 | 11,5 | 9,6 | 7,7 |
| 20. Constellation | 11,0 (91) | 9,9 | 14,3 | 3 | 8,1 | 7,2 | 6,3 |
| 21. Diamants | 9,8 (102) | 7,8 | 9,0 | 13 | 6,8 | 6,3 | 5,9 |
| 22. Vague | 22,3 (45) | 21,5 | 25,6 | 8 | 15,2 | 12,3 | 9,1 |
| 23. Ressac | 9,5 (105) | 7,2 | 8,1 | 8 | 6,4 | 6,1 | 5,7 |
| 24. Aurore | 11,7 (85) | 10,7 | 13,5 | 8 | 8,5 | 7,6 | 6,5 |
| 25. Chenillard | 6,4 (156) | 5,1 | 6,7 | 24 | 4,9 | 4,9 | 4,9 |
| 26. Pulsation | 12,3 (81) | 11,1 | 17,4 | 8 | 8,7 | 7,7 | 6,6 |
| 27. Étincelles | 7,0 (143) | 5,6 | 7,6 | 7 | 5,4 | 5,3 | 5,3 |
| 28. Mur de lumière | 8,4 (119) | 6,4 | 9,0 | 8 | 5,9 | 5,7 | 5,5 |
| 29. Toile | 8,4 (119) | 6,5 | 10,1 | 24 | 5,9 | 5,7 | 5,5 |
| 30. Grand final | 12,8 (78) | 12,0 | 14,0 | 29 | 9,3 | 8,1 | 6,8 |

Scènes à 120 img/s (moyenne) :

| Aujourd'hui | Avec 0.1 seul | Niveaux 0 + 1 | + 2.1 à 80 % | + 2.1 à 50 % |
|---|---|---|---|---|
| **3** / 30 | 13 / 30 | ~16 / 30 | ~24 / 30 | ~29 / 30 (sauf Vague) |

- **La cadence d'affichage (0.1) est la première marche** : 13 scènes ont un temps GPU sous le budget, mais 3 seulement tiennent vraiment 120 img/s.
- Les scènes les plus chères ont peu de lasers, mais braqués sur le public et en nappes coniques : Tunnel (5 lasers), Vortex (4), Rosace, Géométrie, Vague. D'où l'intérêt de 0.5 et de 1.1 sur les arcs.
- Le 90e centile (images où tout est allumé) dépasse la moyenne de 2 à 6 ms : pour des images régulières, viser la moyenne ne suffit pas. C'est le rôle de la qualité adaptative (2.1).

## 6. Ordre de travail proposé (session de codage)

Chaque étape suit `CLAUDE.md` :
- mesure avant / après ;
- banc rapide en alternance ; passes longues (arcs) comparées dans un même lancement ;
- images comparées (PSNR, agrandissements) ;
- historique `historique_perf.xlsx` ;
- banc des lyres inchangé.

1. **Mesurer pour décider** (sans rien changer à l'image ; pour comparer deux variantes d'une passe longue, mesurer dans un même lancement, comme l'option temporaire `--arcab` de `docs/optimisations-lasers.md`) :
   - journal par image du temps CPU de la fumée et de l'attente de présentation ;
   - compteur de la « lumière noyée » (1.3) ;
   - part des couples qui pourraient prendre la lumière interpolée (1.1).
2. **0.1 et 0.2**, cadence et fumée du CPU : petit travail, gain immédiat pour tous les cas proches du but (lyres comprises).
3. **0.3, 0.9 et 0.4** : tuiles vides, salle sans lyres, variantes par grosse tuile.
4. **1.1 sur les nappes planes**, puis **1.1 sur les arcs**. Le plus gros morceau, à valider sur agrandissements :
   - nappes vues par la tranche ;
   - bords des bancs ;
   - près des sorties ;
   - filaments de près.
5. **0.5** : cônes en une seule nappe.
6. **1.3** si la mesure de l'étape 1 le justifie, puis **1.2** et **1.4**.
7. **2.1**, qualité adaptative des lasers, en dernier : c'est le filet de sécurité.
8. Plus tard, au besoin : 0.6, 0.7, 0.8, 2.2, 2.3.

## 7. À décider avec l'utilisateur

Réponses du 18 octobre 2026 :

1. Cible : **oui**. Cas L, M1 et spectacles à 120 img/s ; L7 et les bancs ILDA à 200 figures restent des repères.
2. Niveau 1 : **accepté**, si les agrandissements avant / après ne montrent rien.
3. Niveau 2 : paliers de résolution des lasers **80 %, 70 %, 50 %**, seulement **sous 60 img/s**. À 60 img/s et plus, lasers à 100 % de la résolution (pas de palier « filaments » ni « convergence »). Les estimations des sections 4 et 5 pour 2.1 supposaient une baisse dès 120 img/s : avec ce seuil, les scènes entre 60 et 120 img/s gardent la pleine qualité et ne tiennent 120 img/s que grâce aux niveaux 0 et 1.
4. Synchro verticale : **à 120 Hz en spectacle, avec 3 tampons** (une image en retard ne fait pas chuter l'affichage d'un coup) ; **affichage libre avec « tearing » aux bancs** (mesure de la carte, pas de l'attente de l'écran). Aujourd'hui : synchro à 120 Hz hors banc (2 tampons, latence 1), libre au banc mais sans « tearing ».

Plan validé par l'utilisateur le 18 octobre 2026 : prêt pour la session de codage (section 6).

Questions posées :

1. **Cible** : les cas L, M1 et les spectacles à 120 img/s ; L7 et les bancs ILDA à 200 figures comme repères seulement. D'accord ?
2. **Niveau 1** (1.1 à 1.4) : accepté, à condition que les agrandissements avant / après ne montrent rien ?
3. **Niveau 2** : quels paliers, et dans quel ordre ? Par exemple : filaments → convergence → 80 % → 70 % → 50 %, puis FSR.
4. **Synchro verticale** pour le spectacle : à 120 Hz (images régulières), ou libre avec « tearing » (comme les bancs) ?
