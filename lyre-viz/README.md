# LyreViz — banc d'essai de lyres en C++

Projet de test, séparé du simulateur web. Il sert à mesurer si un moteur natif C++ tient beaucoup de lyres (200 et plus) dans une fumée volumétrique réaliste. Les références visuelles sont Depence R4 et les vraies salles de concert.

- Rendu natif sur chaque système : **Metal** sur Mac, **Direct3D 11** sur Windows, OpenGL 4.3 sur Linux.
- Bibliothèques : [sokol](https://github.com/floooh/sokol) (fenêtre et accès à la carte graphique), [Dear ImGui](https://github.com/ocornut/imgui) (panneau de contrôle) et [stb_image](https://github.com/nothings/stb) (lecture des images de texture).
- Elles sont copiées dans `external/` : rien à installer à part le compilateur.

## Compiler

### Windows

Il faut **Visual Studio 2022** ou les **Build Tools for Visual Studio**, avec la charge de travail « Développement Desktop en C++ ».

```bat
build.bat
LyreViz.exe
```

`build.bat` trouve Visual Studio tout seul et produit `LyreViz.exe` dans ce dossier.

### macOS

Il faut les outils Xcode : `xcode-select --install`.

```sh
./build.sh
./LyreViz
```

### Options

- **Version de débogage :** `build.bat debug` ou `./build.sh debug`. La couche de validation de sokol est alors active et signale toute erreur d'utilisation de la carte graphique.
- **Options de lancement :**

  | Option | Effet |
  |---|---|
  | `--novsync` | Désactive la synchro verticale, pour mesurer le nombre réel d'images par seconde. |
  | `--scale 0.75` | Résolution interne. |
  | `--noui` | Cache le panneau de contrôle. |
  | `--nogi` | Coupe les rebonds de lumière. |
  | `--frames N` | Quitte après N images. |
  | `--shot image.bmp` | Avec `--frames` : enregistre la dernière image (Direct3D 11). |
  | `--fullscreen` | Plein écran, à la résolution de l'écran. |
  | `--set nom=valeur` | Change un réglage au lancement (voir la liste ci-dessous). Exemple : `--set gi=0 --set analytic=0`. |
  | `--bench` | Banc d'essai (voir plus bas). |
  | `--bench-lasers` | Banc d'essai des lasers (voir plus bas). Mêmes options que `--bench`. |
  | `--fast` | Banc rapide : 30 images de chauffe et 60 mesurées par cas (au lieu de 60 et 150). |
  | `--behind` | La fenêtre s'ouvre derrière les autres sans prendre le clavier. Attention : le GPU est alors 5 à 15 % plus lent (Windows donne la priorité à la fenêtre active). |
  | `--demo [0..5]` | Vue d'essai des gobos au sol (aberration chromatique) : 3 lyres en blanc, gobo étoile, prisme 8. Variantes : 1 hors de la mise au point, 2 frost 0,4, 3 iris 0,6 et zoom plus large, 4 pont de scène en orange (gobo barres, zoom 2,2°, tilt 69°) : taches très allongées vues en rasant ; 5 eau au sol (6 taches blanches larges, avec `--set wet=...`). |
  | `--demo-laser [0..3]` | Vue d'essai des lasers, lyres éteintes, effets figés : 0 les formes (éventail, double éventail, cône, tunnel, vague, grille, diffraction ×9) sur le pont de scène ; 1 les dégradés (aucun, 2 et 3 couleurs, défilant, arc-en-ciel, au hasard) ; 2 la programmation de démonstration sur les 200 lasers (cas L7 du banc), vue du public ; 3 un éventail vert vu de près, en biais, dans une fumée épaisse : les volutes (à comparer à la photo 5 de `docs/references-lasers/`) ; 4 des fichiers ILDA : 7 lasers du pont, un fichier chacun (nappe, faisceaux, cube, tunnel, texte, cœur, éventail), vus du public (dans l'axe : `--cam -44.5,11.8,0,0,-12`). |
  | `--ilda dossier` | Bibliothèque ILDA (par défaut `server/storage/ilda`, cherchée en remontant depuis l'exécutable ; un sous-dossier = une banque). |
  | `--ambiance N` | Démarre sur l'ambiance N (1 à 20) de l'onglet Ambiances. Captures : `--ambiance 15 --frames 300 --noui --shot a15.bmp`. |
  | `--cam x,y,z,cap,site` | Place la caméra au lancement (position en mètres, cap et site en degrés ; cap 180 = vers la scène). Exemple : `--demo-laser 0 --cam 6,1.7,0,180,9`. |

  Réglages de `--set` :

  | Nom | Réglage |
  |---|---|
  | `analytic` | Fumée : calcul analytique (1) ou échantillons au hasard (0). |
  | `samples` | Fumée : échantillons par faisceau (calcul par échantillons) ; en analytique, densité des morceaux de rayon. |
  | `tiers` | Fumée : faisceaux doux calculés à 1/2 ou 1/4 de la résolution. |
  | `soft` | Surfaces : lyres très douces (frost) éclairées à 1/4 de la résolution. |
  | `adaptive`, `fps` | Qualité adaptative et cadence visée. |
  | `voldiv`, `temporal`, `history` | Résolution de la fumée, accumulation dans le temps. |
  | `gi`, `volumetrics`, `surfaces`, `specular`, `prepass`, `bloom`, `scale` | Options de l'onglet Rendu. |
  | `density`, `haze`, `smoke`, `detail` | Fumée : densité, brume, amas, volutes. |
  | `floor` | Sol en béton texturé (1) ou béton uni (0). |
  | `floortile` | Taille de répétition de la texture du sol, en mètres (8 par défaut). |
  | `wet` | Eau au sol : 0 sec, 0,1 creux remplis et quelques flaques, 0,5 environ 30 % de flaques, 1 inondé. |
  | `shadows` | Ombres exactes des obstacles (1) ou non (0). |
  | `chroma`, `chromaforce` | Aberration chromatique des lyres sur les surfaces (0 par défaut, 1 active) et son intensité (1 = lyre courante). |
  | `flooraniso` | Filtrage anisotrope de la texture du sol (1 à 16, 4 par défaut). |
  | `lasers` | Lasers dans la fumée (1 par défaut) ou coupés (0). |
  | `laserpattern`, `lasercount`, `laserpower` | Pilotage des lasers (0 éteints, 1 à 6 : motifs des cas L1 à L6, 7 : programmeur de l'onglet Lasers), boîtiers allumés dans les motifs d'essai (1 à 200), puissance d'un boîtier (W). |
  | `lasergain`, `laserwidth`, `laserair` | Intensité des lasers dans la fumée, largeur minimale d'un trait (sigma, en pixels, 0,6 par défaut), diffusion de l'air (traits visibles sans fumée). |
  | `laserfog` | Lasers : fumée de la pièce (amas, brume plus dense en bas) au point de chaque nappe (1 par défaut) ou fumée uniforme (0). |
  | `laserphase`, `laserfwd`, `laserg`, `laserg2` | Lasers : diffusion vers l'avant à deux lobes (1 par défaut) ou un seul comme les lyres (0) ; part du lobe très avant (0,42), son g (0,88), g du lobe doux (0,35). |
  | `volutes`, `volforce`, `voltaille`, `volperiode` | Lasers : volutes fines dans les nappes (1 par défaut), contraste (0,6), taille d'un motif (1,6 m), durée de la boucle d'évolution (16 s). |
  | `volfine`, `volfinelod`, `volfinepoids` | Volutes : 2e octave de près (1 par défaut), sa portée (niveau −1 : pixel de moins de 3,5 mm, soit à moins de ~7 m) et son poids (0,6). |

### Banc d'essai

> Procédure complète pour vérifier qu'une modification n'ajoute pas de lenteur : voir `PERFORMANCE.md`.

```bat
LyreViz.exe --bench --fullscreen
```

- Vues, scénarios et pas de temps fixes : deux lancements donnent les mêmes images.
- Cas mesurés :
  - 3 scénarios de lyres : par défaut, gobo + prisme 8 + zoom 25°, zoom 45° + frost 0,6 ;
  - chacun avec 3 vues : public, scène, sous les trusses ;
  - puis le scénario par défaut en coupant les options une par une.
- Pour chaque cas : 60 images de chauffe, puis 150 images mesurées.
- Résultats dans `bench/resultats.txt` :
  - temps GPU par passe (médiane et moyenne) ;
  - durée moyenne d'une image (= images par seconde réelles) ;
  - détail du temps CPU, qualité adaptative, nombre de faisceaux par niveau de résolution.
- `bench/images.csv` : les temps image par image.
- La dernière image de chaque cas est enregistrée (`bench/01.bmp`, …) pour comparer deux versions.
- `--quick` : seulement la vue public (3 cas). `--cases 2,5` : seulement ces cas (numéros du banc complet). `--benchdir dossier` : dossier de sortie. Les options `--set` s'appliquent à tous les cas.
- `--static` : lyres et fumée immobiles, pour comparer des images sans mouvement. `--stats` : compte les couples (pixel, faisceau) de la fumée (ralentit un peu).
- Les mesures varient de 10 à 20 % d'un lancement à l'autre (fréquence de la carte, autres programmes) : pour comparer deux versions, les lancer en alternance plusieurs fois.
- Comparer deux versions (temps et écart entre les images) :

```bat
python tools\compare_bench.py bench\avant bench\apres --diff bench\ecarts
```

### Banc d'essai des lasers

```bat
LyreViz.exe --bench-lasers --fullscreen
```

- Cas (`PLAN-LASERS.md`, section 10) : L1 200 éventails de 1 000 traits en mouvement (3 vues), L2 200 cônes de 32 segments (2 vues), L3 caméra au milieu des nappes, L4 200 × 8 traits séparés, L5 nappes en gros plan dans une fumée épaisse, L6 traits vers le sol et les obstacles, M1 100 lyres + 100 lasers (3 vues), la scène sans lasers, puis L7 la programmation de démonstration (toutes les formes, dégradés, diffraction et effets sur les 200 lasers, vue du public). Lyres éteintes sauf en M1.
- Puis les fichiers ILDA (cas 15 à 18) : I1 à I4, les 200 lasers jouent chacun un fichier d'une banque (Nappes, Faisceaux, Géométrie, Tunnels), vue du public ; et le cas 19, L1 en mode ligne (les mêmes éventails en nappes continues). Ligne « ILDA » par cas : points, faisceaux, nappes, niveau de tolérance de la réduction.
- `--quick` : 5 cas (L1, L2 et M1 vus du public, L3, L4). Les autres options sont celles du banc des lyres ; `--stats` compte aussi les couples (pixel, segment) des lasers et les segments par tuile.
- Même format de sortie que le banc des lyres, avec une ligne « Lasers » par cas : boîtiers, segments, traits, temps CPU du moteur laser.
- Scripts : option `-Lasers` de `tools\perf_ab.ps1` et `tools\set_ab.ps1` (voir `PERFORMANCE.md`).

## Commandes

| Action | Touche |
|---|---|
| Regarder | clic droit maintenu + souris |
| Avancer / reculer / côtés | W A S D (Z Q S D en AZERTY) ou flèches |
| Monter / descendre | Espace ou E / C ou A (Q en AZERTY) |
| Aller vite | Maj, la molette règle la vitesse |
| Mode personnage (vue à la 3e personne, saut avec Espace) | F |
| Cacher le panneau | H |
| Pause des effets et de la fumée | P |

## Ce qui est en place

### Scène

- Un hangar de 100 × 44 × 34 m, avec poteaux et poutres de toit.
- Un cube suspendu à 9 m sous le truss 2, pour tester les ombres : sa face coupe en deux, dans leur longueur, les faisceaux bleus qui passent dessous.
- Un sol en béton texturé (voir « Sol en béton » plus bas), avec un réglage d'eau au sol.
- 4 lignes de trusses à 18 m de haut.
- Une scène avec pont, mur LED éteint, stacks, régie et mannequins.
- Des cubes de couleur dans la salle pour vérifier que chaque surface renvoie sa vraie couleur.
- **200 lyres** :
  - 168 sur les trusses,
  - 16 sur le pont de scène,
  - 8 au sol de la scène,
  - 8 en nez de scène.

### Lyres

Chaque lyre a les canaux d'une vraie lyre :
- pan et tilt, avec vitesse et accélération des moteurs ;
- dimmer et strobe ;
- couleur ;
- roue de 14 gobos, avec indexation et rotation ;
- prismes 3, 6, 8, **9 (8 + centre)**, **9 (grille 3×3)** et linéaire 4, avec écartement et rotation ;
- zoom (de 1,5 à 50°), mise au point (le gobo est net à une distance donnée, flou ailleurs), frost et iris.

### Ambiances

Premier onglet du panneau : une grille de 20 boutons, une ambiance par bouton (programmation des lyres, des lasers, de la fumée, de l'eau au sol et de l'aberration chromatique). Tant que l'onglet est ouvert, les **flèches du clavier** passent d'une case à l'autre (la caméra garde Z Q S D). Les lyres rejoignent leur nouvelle position à leur vitesse ; les onglets Lyres, Effets, Lasers et Fumée montrent la programmation, qu'on peut retoucher. Code : `src/ambiances.cpp`.

1. Démarrage (lyres du lancement, lasers éteints) ; 2. Lasers simples (verts, au-dessus du public : nappes pleines et éventails de quelques traits) ; 3. Ballet blanc ; 4. Gobos au sol ; 5. Prismes ; 6. Arc-en-ciel ; 7. Sol mouillé ; 8. Cathédrale ; 9. Couronne (toutes les lyres visent un point) ; 10. Techno strobe ; 11. Aube pastel ; 12. Brasier ; 13. Optique nette (aberration chromatique) ; 14. Tunnel laser ; 15. Plafond laser ; 16. Rideaux laser ; 17. Constellation (grilles en diffraction) ; 18. Océan ; 19. Galaxie ; 20. Grand final (toutes les formes laser + lyres). Le grand final reprend la démonstration des lasers (cas L7 du banc) : au-dessus du budget.

### Sélection à l'écran (debug)

Onglet Lyres ou Lasers ouvert, souris libre : un clic dans la scène sélectionne l'appareil le plus proche (Ctrl + clic l'ajoute ou le retire), un glisser sélectionne ceux du rectangle (Ctrl ajoute, Maj retire). Les boutons « < Précédent » et « Suivant > » ne gardent qu'un appareil et passent au voisin (avec « Inverser » : tous sauf celui-là). Un cadre entoure chaque appareil sélectionné (jaune : lyres, vert d'eau : lasers), avec son numéro s'il y en a 24 au plus ; un petit point marque les autres. Seuls les appareils de l'onglet ouvert sont marqués (lyres dans Lyres, lasers dans Lasers), rien dans les autres onglets.

### Lasers (étapes 1 à 3 de `PLAN-LASERS.md`)

- 200 boîtiers : 168 sur les trusses (entre les lyres), 16 sur le pont de scène, 8 au sol de la scène, 8 en nez de scène. Chaque boîtier est fixe (axe d'accroche par groupe) et place sa figure dans le champ de son scanner (angle maximal réglable, 60° par défaut), avec l'inertie des galvos. Les corps des boîtiers sont dessinés (pavés sombres, sortie claire).
- **Onglet Lasers** (même principe que les lyres) :
  - sélection : tous, groupes, une sur deux, inverser, ou laser par laser ;
  - intensité : dimmer, strobe ; couleur (nuancier) et **dégradé le long de la figure** : aucun, 2 ou 3 couleurs, défilant, arc-en-ciel, au hasard par trait ;
  - **figure** : éventail, double éventail, cône, tunnel, vague, grille de points ; ouverture (0 = un point, jusqu'à l'angle maximal), nombre de traits (1 à 2 000), écart, amplitude, rangées ; **réseau de diffraction** ×3, ×5, ×9 avec l'écart des copies ;
  - position : pan, tilt, roulis, rotation continue ;
  - **effets** sur la sélection (même moteur que les lyres : forme d'onde, vitesse, amplitude, décalage, ailes) : vagues pan et tilt, cercle, huit, éventail, roulis, pulsation de l'ouverture, chenillard de traits, chenillard d'intensité, arc-en-ciel, alternance de deux couleurs ;
  - réglages des boîtiers : pilotage (programmeur ou motifs d'essai du banc), programmation de départ, démonstration, grand master, puissance, angle maximal, inertie des galvos, diamètre de sortie, divergence ; dans la fumée : intensité, largeur minimale d'un trait, diffusion de l'air.
- Au lancement : tous les lasers éteints (le pont et le nez de scène sont prêts en éventails qui balaient lentement : monter leur dimmer). Ambiance 2 pour les voir.
- **Fichiers ILDA** (comme le laser 2 du simulateur web) : source « Fichier ILDA » dans l'onglet Lasers ; bibliothèque `server/storage/ilda` (une banque par sous-dossier) ; lecture en boucle, aller-retour ou image fixe, cadence, couleurs du fichier ou couleur du laser ; la taille (ouverture), le pan, le tilt, le roulis, la rotation, la diffraction et les effets s'appliquent comme aux formes. Voir « Lasers : fichiers ILDA » plus bas.
- **Mode ligne** : 0 trait (bouton « Ligne ») = nappe continue, comme un balayage sans coupure ; un peu moins cher qu'un éventail de traits (L1 : −15 %).
- **Dans la fumée** (étape 3, onglet Rendu et onglet Lasers) : la fumée de la pièce éclaire plus ou moins les nappes (amas des machines, brume plus dense en bas) ; la diffusion très avant rend une nappe tournée vers soi beaucoup plus brillante ; les **volutes fines** animées (filaments, trous sombres) se voient dans les nappes, surtout de près.
- Pas encore : blanc à la sortie, impacts sur les surfaces, coupure des nappes par les obstacles et les joueurs, éblouissement (étapes suivantes du plan).

### Panneau

- **Sélection :** toutes, groupes, une sur deux, inverser, ou lyre par lyre.
- **Réglages :** chaque réglage s'applique à toute la sélection.
- **Points de visée :** 4 points, que l'on place à la souris dans la scène. Les lyres sélectionnées les suivent.
- **Effets décalés sur la sélection :**
  - mouvements : cercle, vagues pan et tilt, huit, éventail ;
  - lumière : chenillard de dimmer, arc-en-ciel, alternance de deux couleurs, pulsation du zoom ;
  - réglages de chaque effet : forme d'onde, vitesse, amplitude, décalage de phase, ailes.

### Fumée

- **Brume de fond.** Un voile uniforme (hazer), réglable.
- **Amas de fumée simulés.** Ils dérivent avec le vent, tourbillonnent, montent avec la chaleur et se dissipent. Cinq machines à fumée les alimentent.
- **Volutes fines.** Une texture 3D de détail ajoute des volutes qui avancent avec le vent.
- **Visibilité des faisceaux.** C'est la densité locale qui fait voir plus ou moins les faisceaux et leurs gobos.
- **Diffusion vers l'avant.** Un faisceau tourné vers soi est beaucoup plus lumineux, comme en vrai.

### Lumière

- **Éclairage direct.** Chaque surface reçoit l'image projetée (gobo × prisme × iris × frost) multipliée par sa couleur : un cube orange éclairé en blanc renvoie de l'orange.
- **Reflets brillants.** Le sol en béton lisse reflète les taches de lumière. Le relief et la rugosité de la texture du sol modulent ces reflets ; l'eau au sol les rend plus nets.
- **Rebonds de lumière.**
  - Chaque tache de lumière (sur le sol, les murs, le décor) renvoie sa couleur dans la pièce.
  - La lumière diffusée par la fumée éclaire aussi la salle.
  - Les deux sont réunis dans une grille 3D de sondes, qui éclaire les surfaces et la fumée.
- **Aberration chromatique** (coupée par défaut). Franges bleues d'un côté et orange de l'autre au bord des taches et des gobos, comme sur les photos de vraies lyres (voir plus bas).
- **Bloom.** Le halo autour des lentilles et des zones très lumineuses.
- **Tonemapping ACES.** Les couleurs saturées tirent vers le blanc quand elles sont très intenses, comme sur une photo.

Toutes ces options s'activent et se désactivent dans l'onglet **Rendu**, avec les compteurs : images par seconde, temps CPU, nombre de faisceaux.

## Comment c'est fait

Toutes les passes sont dans `shaders/lyreviz.glsl`. Voici une image, étape par étape :

1. **Images projetées des lyres à prisme** (calcul GPU).
   - L'image complète (gobo × facettes × iris × frost), en 256 × 256 avec ses niveaux de flou.
   - Calculée une fois par réglage : les lyres réglées pareil la partagent.
   - Les surfaces et la fumée la lisent en 2 fois, au lieu d'additionner jusqu'à 9 facettes.
2. **Tri des lumières par case 3D de l'écran** (calcul GPU). Chaque pixel ne regarde que les lyres qui peuvent le toucher, au lieu des 200. Dans chaque case, les lyres nettes sont rangées avant les douces.
3. **Sondes de lumière indirecte** (calcul GPU).
   - Elles reçoivent environ 1 600 « lumières virtuelles », posées sur les taches de lumière et le long des faisceaux.
   - Les lumières virtuelles sont lues par paquets de 64 en mémoire partagée.
   - Les sondes sont écrites dans 3 textures, que les passes suivantes lisent avec le filtrage de la carte graphique.
4. **Tables des faisceaux** (calcul GPU, voir plus bas).
5. **Pré-passe de profondeur,** puis **géométrie et éclairage des surfaces.**
   - Tout est dessiné en instances : 4 appels de dessin pour toute la scène.
   - Grâce à la pré-passe, chaque pixel n'est éclairé qu'une fois (rien n'est calculé pour les pixels cachés).
   - Les lyres très douces (frost, grande tache) sont éclairées à part, à 1/4 de la résolution, puis ajoutées en respectant les bords des objets et les normales.
6. **Faisceaux dans la fumée,** à résolution réduite.
   - Chaque faisceau est dessiné comme un cône : seuls les pixels qu'il couvre font un calcul.
   - Chaque cône s'arrête là où il est entièrement sorti du hangar (sol, murs, toit). Au-delà, il serait de toute façon caché.
   - Les faisceaux sans détail fin à l'écran (frost, flou, très larges) sont calculés à 1/2 ou 1/4 de cette résolution, puis ajoutés en tenant compte de la profondeur.
   - La lumière indirecte diffusée par la fumée est ajoutée dans la même passe.
7. **Lasers dans la fumée** (tuiles en calcul, pleine résolution, voir plus bas).
8. **Accumulation temporelle.** Elle lisse le bruit qui reste (lumière indirecte de la fumée).
9. **Composition.** La scène est atténuée par la fumée, puis la lumière diffusée est agrandie en tenant compte de la profondeur ; les lasers sont ajoutés.
10. **Bloom, puis image finale.**

### Calcul analytique des faisceaux

C'est ce qui rend les gobos, les prismes et le frost presque gratuits dans la fumée.

- La lumière qu'un faisceau envoie vers la caméra le long d'un rayon est une intégrale de l'image projetée (gobo, prisme…) le long de ce rayon.
- Dans un repère propre à chaque lyre, orienté vers la caméra (repère « épipolaire »), chaque rayon de la caméra reste dans un plan, et y parcourt une ligne de l'image projetée.
- Une table par lyre, recalculée à chaque image, contient pour chaque ligne l'intégrale **cumulée** de l'image.
- L'intégrale sur un morceau de rayon devient la différence de deux valeurs lues dans la table. Il n'y a plus d'échantillons au hasard, donc plus de bruit, et le coût ne dépend plus du gobo ni du nombre de facettes.
- Ce qui varie lentement (densité de la fumée, diffusion, atténuation, distance) est pris au milieu de quelques morceaux du rayon.
- La table existe en plusieurs niveaux de flou, pour la mise au point et le frost.
- L'ancien calcul par échantillons reste disponible : décocher « calcul analytique » dans l'onglet Rendu.

### Lasers : segments d'éventail analytiques

Un laser balaie une figure avec un seul faisceau : tout se décompose en **segments d'éventail** plans (une source, n traits répartis entre deux directions). Le coût ne dépend pas du nombre de traits : 200 lasers de 1 000 traits font 200 segments.

- **Un segment dans un rayon de la caméra** (`laser_eval`) : le rayon traverse le plan de l'éventail en P. Près de P, les traits sont presque parallèles. Chaque trait est une gaussienne autour de sa droite (formule des « photon beams », Jarosz 2011 : noyau / sinus de l'angle rayon–trait). Leur somme se calcule en forme fermée :
  - traits séparés à l'écran (plus de 4 pixels d'écart) : les gaussiennes des traits voisins ;
  - traits serrés : la nappe (puissance / (ouverture × distance × |n·v|)), plus l'ondulation des traits (somme de Poisson). Elle s'efface quand les traits se serrent ou quand leur écart à l'écran approche 2 pixels : aucun moiré.
- **Largeur minimale qui conserve l'énergie** : un trait plus fin qu'un pixel devient plus large (0,6 pixel) et plus sombre. Largeur physique : sortie de 5 mm, divergence de 1 mrad.
- **Diffusion vers l'avant** et atténuation ; fumée de la pièce et volutes fines : voir « Lasers dans la fumée » plus bas.
- **Tuiles en calcul** (`cs_laser_setup`, `cs_laser_bin`, `cs_laser_shade`) :
  - chaque segment devient un polygone à l'écran : son triangle coupé par les parois du hangar (rien n'est visible au-delà), le plan proche et l'écran élargi, puis bordé de 3,5 largeurs de trait ;
  - tri par grosses tuiles de 128 pixels, puis chaque tuile de 16 pixels garde les siens ;
  - chaque pixel additionne tous ses segments dans ses registres et écrit une seule fois. Pas de mélange additif : il coûtait à lui seul environ 2,8 ms sur le cas L1 (voir `PERFORMANCE.md`).
- La caméra est exprimée une fois par image dans le repère de chaque segment (CPU) : par pixel, il ne reste qu'à exprimer le rayon dans ce repère.
- **Nappe lisse** (traits confondus, cas le plus courant) : 4 opérations spéciales seulement ; les bords sont testés avec le sinus des angles vus de la source (sinus et cosinus de la demi-ouverture calculés une fois par segment).
- **Éventails de 16 traits au plus** : un segment par trait. À l'écran, chaque trait n'occupe qu'une bande fine : seules les tuiles qu'elle traverse le calculent, et un pixel hors de la bande est rejeté en 3 opérations (cas L4 : 4 fois plus rapide). Chaque trait est alors calculé exactement (point le plus proche du rayon), ce qui donne aussi des traits propres là où ils se rejoignent, près de la source.
- Chaque fil calcule 2 pixels (8 lignes d'écart) : chaque segment est lu une fois en mémoire partagée pour les deux. 1 ou 4 pixels par fil sont plus lents (mesuré).

### Lasers dans la fumée (étape 3)

Une nappe laser n'éclaire qu'une tranche de la fumée : on y voit une coupe de sa densité. Pour chaque couple (pixel, segment), tout est lu au point P où le rayon de la caméra traverse la nappe.

- **Fumée de la pièce.** Diffusion par mètre en P = air (visibilité minimale : traits visibles sans fumée) + densité × albédo × (brume × décroissance en hauteur + amas simulés). C'est la fumée des lyres, sans leur texture de détail « coton » (les volutes la remplacent).
  - Préparée sur le CPU dans le 2e canal de la texture des amas des lyres (64 × 24 × 32, RG8 ; les lyres lisent le 1er canal, inchangé) : une lecture et 2 opérations par couple.
  - Une 2e texture envoyée à chaque image faisait attendre la carte sous Direct3D 11 (`UpdateSubresource` : +1 à +1,3 ms par image en moyenne, même avec 3 textures en rotation) ; tout calculer dans le shader (exponentielle, division) coûtait 3 à 10 % de plus.
- **Diffusion vers l'avant à deux lobes** (Henyey-Greenstein) : un lobe très avant (g 0,88, 42 % de la lumière) et un lobe doux (g 0,35). Vue de côté, la même brillance qu'avec un seul lobe g 0,55 (celui des lyres) ; dans l'axe, 7 fois plus. Écrite en scalaires : en vecteurs, le compilateur HLSL prenait 6 registres de plus.
- **Volutes fines** (`src/volutes.cpp`) : texture 3D périodique 64³ générée au lancement (0,3 s, 12 fils), compressée en **BC5** (1 octet par texel) : 2 Mo en RGBA8 rendaient la passe 60 à 90 % plus lente (mémoire lue par couple).
  - Motif : bruit à 4 octaves dans un domaine déformé deux fois (déformations de Quilez), puis un contraste par seuil doux : plaques claires à bords vifs, trous sombres, filaments étirés. Prototype comparé à la photo 5 des références.
  - **1re octave** : motif de 1,6 m (texels de 2,5 cm), avance avec le vent. Les 2 canaux sont le même champ à deux instants opposés d'une boucle d'évolution (16 s), mélangés en aller-retour avec une seule lecture et ramenés au même écart type : les volutes se tordent et se défont au lieu de glisser comme un décor.
  - **2e octave**, de près seulement : la même texture 3,6 fois plus petite (0,44 m, texels de 7 mm), axes permutés et cisaillés, 1,6 fois plus rapide, à l'autre instant de l'évolution. Lue quand un pixel couvre moins de 3,5 mm (à moins de ~7 m).
  - **Niveau de détail** : mip choisi selon la taille du pixel en P, étirée quand la nappe est vue en biais (1 / |n·v|) : pas de scintillement ; effacement progressif au loin (au-delà du niveau 6, rien n'est lu).
  - Moyenne 1 : la brillance moyenne ne change pas, seule sa répartition change. Plus fortes dans les amas des machines à fumée que dans la brume du hazer.
  - Les lectures (fumée, volutes) partent ensemble, tôt dans le calcul du segment ; leur résultat ne sert qu'à la fin (la passe a peu de groupes actifs pour masquer leur attente).
- **Variantes du shader** (comme pour les dégradés), choisies à chaque image : 0 fumée uniforme et un lobe (le code d'avant l'étape 3), 1 fumée de la pièce et deux lobes, 2 avec les volutes, 3 avec leur 2e octave (seulement si un segment passe à moins de la portée de la caméra : distance au triangle de chaque segment, calculée sur le CPU). Ce code, même coupé par un réglage, ralentissait la passe de 6 à 15 % : tout coupé, on retrouve exactement la vitesse d'avant.
- **Coût** (lasers seuls, passe des lasers) : niveau 1 +8 à +14 % ; volutes +25 à +35 % (L1 +1,3 à +1,8 ms, L2 +3,2, L7 +4,8). Détail : `PERFORMANCE.md`, « Étape 3 : fumée ».

### Lasers : fichiers ILDA

Même principe que le laser 2 du simulateur web (`src/laser2/`, `docs/laser2-cahier-des-charges.md`) : un laser est un seul faisceau renvoyé par deux miroirs, et chaque image ILDA se réduit à deux primitives, déjà présentes dans le rendu (`src/ilda.cpp`).

- **Lecture** : formats 0, 1 (couleur indexée, palette ILDA par défaut), 2 (palette), 4, 5 (couleur vraie) ; point masqué (bit 6) gardé en noir ; 60 000 points au plus par image. Bibliothèque scannée au lancement, fichiers lus à la première utilisation.
- **Complément des traits** (comme le web) : un point tous les 0,035 le long des traits allumés (la puissance est répartie entre les points : un long trait de 2 points paraîtrait sinon plus sombre qu'un court).
- **Réduction** (reprise de `Laser2Scanner._extractPass` du web) :
  - un point resté sur place (à moins de la demi-divergence, 2,5e-4 rad au moins) : **faisceau**, toute l'énergie de ses points dans un **trait seul** ;
  - un point qui s'éloigne du précédent : **nappe** entre les deux, prolongée tant que le tracé reste droit, à espacement, niveau et teinte constants ; rendue comme un **segment d'éventail en nappe continue** (énergie des points répartie sur l'angle balayé) ;
  - chaque point compte 1 / N du temps de l'image (points masqués compris) : un éventail large est plus sombre qu'un étroit, un faisceau fixe éclatant.
- **Une réduction par image du fichier, en cache**, dans les coordonnées du fichier : la taille, la rotation et la position d'un laser ne changent pas les primitives. 200 lasers qui jouent le même fichier ne la calculent qu'une fois.
- **Tolérance** : 4 niveaux (×2 chacun) ; un laser dont l'image dépasse 700 primitives passe au suivant, et le niveau monte pour tous quand les segments approchent du plafond (16 384), comme le budget adaptatif du web.
- **Pas d'inertie des galvos** (comme le web depuis sa refonte : « laser parfait ») ; l'inertie du programmeur s'applique au pan, au tilt et au roulis.
- **Coût** : celui de la surface couverte, comme pour les formes. 200 lasers en faisceaux (I2) : 1,9 ms ; 200 lasers qui jouent des nappes, des figures ou des tunnels (I1, I3, I4) : 31 à 49 ms (des centaines de millions de couples pixel × segment). Détail : `PERFORMANCE.md`, « Fichiers ILDA ».

### Ombres des obstacles

Les obstacles fixes font de l'ombre aux faisceaux, sur les surfaces et dans la fumée : scène, mur LED, stacks, régie, décor, cube suspendu, mannequins (2 pavés chacun). Les parois du hangar, elles, reçoivent la lumière sans faire d'ombre. Onglet Rendu : « Ombres des obstacles », `--set shadows=0/1`.

- **Ombres exactes, sans cartes d'ombre précalculées.**
  - Tous les obstacles sont des pavés. Pour chaque lyre, à chaque image, le CPU garde les pavés qui touchent son cône (8 au plus) et calcule le **volume d'ombre** de chacun vu de la lentille : un convexe d'au plus 9 plans (faces éclairées, plans des arêtes de silhouette).
  - Surface : distance du point au volume (produits scalaires, arrêt dès qu'il est hors de la pénombre), adoucie sur la largeur de la **pénombre** : rayon de la lentille × (distance obstacle → surface) / (distance lentille → obstacle). Bord net quand l'obstacle est près de la surface, flou quand il est près de la lyre (environ 14 cm au sol sous le cube suspendu).
  - Fumée : morceau exact du rayon dans le volume (découpe de la droite par les plans). Son intégrale (différence de deux valeurs de la table du faisceau) est retirée.
  - Ne dépend ni du gobo, ni du prisme, ni du zoom, ni du frost : seulement de la lentille et des pavés.
  - Des cartes d'ombre par lyre auraient demandé des centaines de Mo pour des faisceaux de 1,5°, avec des bords en escalier.
- **Ne calculer que là où une ombre peut tomber.**
  - CPU : rectangle d'écran et plage de profondeur de chaque volume (coupé au plan avant de la caméra et aux parois), puis masque par tuile d'écran (32 × 18) et par lyre.
  - Calcul des cases de lumière : pour chaque case et chaque lyre, les pavés dont l'ombre peut toucher la case (8 bits). Une surface ne teste que ceux-là.
  - Fumée : une lecture du masque de la tuile ; rien de plus sans ombre près du pixel.
- **Le faisceau entier arrêté par un obstacle** (les 9 rayons de son axe et de son bord touchent) est en plus raccourci à l'obstacle : moins de pixels à calculer.
  - Longueur : le plus loin des 9 points touchés le long de l'axe. Si les 9 points sont sur un même plan (le sol), la distance exacte où le cône entier l'a franchi. Sinon, sur un sol vu en rasant (pont de scène, tilt 69°), le bout de la tache, très allongée, tombait entre deux rayons du bord et était coupé net (`--demo 4`).
  - Pas de calcul exact quand les points touchés sont sur des faces différentes : le plan d'une face presque parallèle au faisceau l'allongerait pour rien (mesuré : +0,5 à +1 ms dans les surfaces, avec gobo + prisme).
- **Limites.**
  - Dans la fumée, le bord de l'ombre reste net (la pénombre n'est que sur les surfaces).
  - Deux ombres qui se chevauchent le long d'un même rayon dans la fumée seraient retirées deux fois : le résultat est borné à 0.
  - Seuls les obstacles fixes : le personnage (mode F) et les lyres ne font pas d'ombre.

### Aberration chromatique

Sur les photos de lyres, le bord des taches de gobo au sol est bleu d'un côté et rouge puis jaune / orange de l'autre. Ce n'est pas de la diffraction (franges de l'ordre du micron, pareilles des deux côtés du bord) : c'est la **dispersion** du verre, qui dévie plus le bleu que le rouge. Onglet Rendu : « Aberration chromatique » et son intensité, `--set chroma=1`, `--set chromaforce=...`.

- **Ce qui est simulé**, pour chaque couleur (rouge, vert, bleu), dans l'image projetée de la lyre (en angle) :
  - **aberration latérale** : l'image bleue est 0,6 % plus grande, la rouge 0,6 % plus petite. Le décalage croît avec la distance à l'axe : rien au centre ; frange bleue côté extérieur, rouge puis jaune côté axe ;
  - **prisme** : il écarte les facettes bleues de 2 % de plus, les rouges de 2 % de moins. Les copies du prisme, loin de l'axe, ont les franges les plus visibles ;
  - **aberration axiale** : le bleu est net 5 % plus près, le rouge 5 % plus loin. Hors de la mise au point, les couleurs ne sont pas floues pareil (halo coloré) ; le frost, qui diffuse toutes les couleurs pareil, efface cet écart.
- Le vert est l'image sans aberration. Tout est calculé dans l'image projetée, donc l'effet suit n'importe quel gobo, prisme, zoom, frost, mise au point et iris. L'étirement des franges sur une surface de travers (incidence rasante) vient tout seul de la projection.
- **Ce n'est pas l'incidence qui crée les franges, mais la distance à l'axe.** À la verticale, une tache sans prisme n'a qu'une frange de quelques millimètres ; les copies d'un prisme, loin de l'axe, en ont de plusieurs centimètres. Une surface de travers les étire (1 / cos de l'angle d'incidence) et sort une partie de la tache de la mise au point.
- **Sur les surfaces seulement.** Dans la fumée, la frange ferait 1 à 3 % de la largeur d'un faisceau (quelques millimètres à quelques centimètres) et serait moyennée sur toute la traversée du faisceau : invisible, alors qu'il faudrait des tables en 3 couleurs (3 fois le calcul des tables et des lectures dans la passe la plus chère). Sur les photos non plus, les faisceaux dans la fumée n'ont pas de franges.
- **Comment c'est calculé.**
  - Images projetées en cache (lyres à prisme ; avec l'effet, toutes les lyres) : en couleur dans un atlas RGBA16F (r : image sans aberration, g : rouge, b : bleu), créé à la première activation. L'effet coupé, l'atlas reste en R32F (2 fois moins d'octets à lire).
  - Les surfaces font toujours 2 lectures par lyre ; l'aberration axiale ne change que le mélange des deux niveaux de flou, couleur par couleur.
  - Lyres sans prisme : avec l'effet, elles ont aussi leur image en cache, lue en 2 fois (au lieu de 3 lectures du gobo, une par couleur, chacune sur 2 niveaux de flou).
  - **Une image en cache n'est recalculée que si les réglages de sa lyre changent** (gobo, prisme, rotation, zoom, frost, iris). Lyres immobiles en gobo et en prisme : aucun calcul. Avant, la recalculer à chaque image obligeait aussi la carte à attendre que les surfaces de l'image précédente aient fini de la lire.
  - La fumée lit le canal r : son image ne change pas.
- **Coût** (GTX 1080, 4K, effet coupé contre actif, en mouvement) : défaut +0,05 à +0,14 ms ; gobo + prisme 8 +0,5 à +0,8 ms ; zoom 45° + frost 0,6 environ +0,2 ms. Coupé par défaut, car le cas gobo + prisme 8 est déjà au-dessus du budget (voir `PERFORMANCE.md`).
- **Vue d'essai** : `LyreViz.exe --demo` (3 lyres en blanc, gobo étoile, prisme 8, vues en biais), avec `--demo 1` à `3` pour la mise au point, le frost, l'iris.

### Sol en béton

Texture [Concrete031](https://ambientcg.com/view?id=Concrete031) d'ambientCG, en 2K : couleur, normales (format DirectX) et rugosité, dans `assets/Concrete031/`.

- **Placement.** Le sol est un cube sans coordonnées de texture : la texture est posée en coordonnées monde (plan XZ). Elle contient 4 × 4 dalles séparées par des joints ; elle se répète tous les 8 m (dalles de 2 m ; réglable par `--set floortile=...`).
- **Aucune répétition visible.** Chaque dalle du sol prend une dalle de la texture au hasard, tournée d'un quart de tour et retournée au hasard (128 variantes). Les joints restent alignés, et cela ne coûte aucune lecture de plus.
- **Une seule lecture de texture par pixel.**
  - Au chargement, `src/floor_texture.cpp` range tout dans une texture RGBA8 : racine de la luminance, normale x et y, rugosité.
  - La teinte du béton varie de moins de 3 % : la couleur est la luminance multipliée par la teinte moyenne.
  - Les mipmaps sont calculées au chargement, en lumière linéaire.
- **Pas de moiré ni de scintillement en 4K.**
  - Filtrage anisotrope (×4 : même image qu'en ×16, trois fois moins cher).
  - Dans les mipmaps, la normale moyenne n'est pas ramenée à 1. Là où les normales divergent, la rugosité augmente d'autant (méthode de Toksvig) : au loin, le relief ne scintille pas et le reflet garde sa largeur réelle.
- **Luminosité.** La texture est mise à l'échelle pour garder la luminance moyenne du béton uni (albédo 0,20). Sa rugosité est recentrée sur celle du béton uni (0,32).
- **Éclairage.**
  - La normale et la rugosité de la texture servent aux taches des lyres, aux gobos et aux reflets (`ggx_spec`), ainsi qu'à la lumière indirecte reçue.
  - La passe des lyres douces lit la même normale, la même rugosité et la même couleur (sorties normale et matière de la passe des surfaces).
  - Les rebonds de lumière (sondes) prennent la couleur du sol sous chaque tache : même mélange des dalles, calculé sur le CPU.
- **Eau au sol** (onglet Rendu, `--set wet=...`), d'après Lagarde, « Water drop 2b » (niveau d'eau qui monte dans une carte de hauteur) et « 3b » (béton mouillé). Le niveau d'eau monte :
  1. **Les creux du béton se remplissent d'abord** (trous, pores, joints : les taches sombres) : eau affleurante, lisse et réfléchissante. 10 % de la texture remplis à 0,35.
  2. **Puis des flaques** de plus en plus nombreuses et grandes : environ 2 % du sol à 0,1, 10 % à 0,3, 30 % à 0,5, 60 % à 0,75, tout à 1. Chaque flaque a un bord de béton détrempé (plus sombre, plus brillant) d'environ 5 à 10 cm.
  3. **Le reste du sol reste sec** jusqu'à 0,45, puis se mouille (plus sombre, plus brillant) ; à 1, l'eau couvre tout.
  - **Creux du béton** : la texture n'a pas de carte de hauteur. Au chargement (`src/floor_texture.cpp`), les creux sont tirés du passe-haut de la luminance (plus sombre que le voisinage : pas les grandes taches, simples salissures) et de la divergence des normales (elles convergent dans un trou ou un joint). Texture R8 avec mipmaps, lue seulement s'il y a de l'eau.
  - **Cuvettes** : 3 octaves de bruit en coordonnées du monde (motifs de 1,5 à 5 m), sans répétition ; le bord des flaques suit les creux de la texture.
  - **Part de sol voulue** : le CPU tabule la répartition des creux et celle des cuvettes. Le niveau d'eau donne exactement la part de sol couverte prévue, quelle que soit la forme du bruit.
  - **Dans l'eau** (flaques et creux remplis) : surface plate et lisse ; **le reflet est toujours le miroir net**, avec le Fresnel de l'eau (F0 = 0,02) : fort en rasant, faible en regardant vers le bas. Hors de l'eau, pas de reflet miroir : le béton mouillé garde seulement les reflets des lampes, rugueux, de la passe des surfaces (plus de reflet flou ou étiré intermédiaire).
  - **Reflet** (méthode des sols plats des jeux : reflet planaire). Une caméra miroir sous le sol redessine la scène à demi-résolution : surfaces éclairées par toutes les lyres, lentilles, faisceaux dans la fumée (avec leurs propres tables analytiques, deux fois moins fines). Le reflet contient donc aussi ce qui est au-dessus de la caméra, hors de l'écran. Seule la partie de l'écran où le sol est visible est calculée, et seulement les lyres dont le cône est visible dans le reflet. Rien n'est calculé quand le sol est sec ou hors de l'écran.
  - **Reflet calculé seulement dans l'eau.** Une passe de masque cherche, pour chaque pixel du miroir, s'il y a de l'eau sous les 4 pixels de l'écran qu'il couvre (même calcul que le matériau du sol, creux compris). Puis, par blocs de 2 × 2 pixels du miroir (un pixel des faisceaux du miroir) : hors des blocs mouillés, la profondeur du miroir est mise au plus près, et la scène miroir y est rejetée avant le shader ; les faisceaux du miroir s'y arrêtent tout de suite. La composition lit le reflet sans les pixels du miroir non calculés. Image identique ; à 10 % d'eau, le reflet coûte 2 à 3 fois moins.
  - **Sol sec : aucun coût.** La passe des surfaces existe en deux variantes : sol sec (sans aucun code d'eau) et sol mouillé. Le code de l'eau, même jamais exécuté, ralentissait la boucle des lyres.
  - Vue d'essai : `LyreViz.exe --demo 5 --set wet=0.3` (6 taches blanches larges vues en biais).
- **Non utilisée : l'occlusion ambiante.** Il faudrait une deuxième texture, donc doubler le coût du filtrage anisotrope.
- **Coût mesuré** (GTX 1080, 4K, passe des surfaces) :
  - par défaut : +0,2 ms ;
  - zoom 45° + frost 0,6 : +0,2 à +0,3 ms ;
  - gobo + prisme 8 sur toutes les lyres : +0,6 à +0,7 ms (les lectures du sol y concurrencent celles des gobos).
- La case « Sol en béton texturé » de l'onglet Rendu revient au béton uni.

**Source et licence.** Concrete031 par [ambientCG](https://ambientcg.com/view?id=Concrete031), licence [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) (domaine public). Les fichiers `Color.jpg`, `NormalDX.jpg` et `Roughness.jpg` sont ceux du paquet 2K-JPG, renommés et non modifiés.

### Qualité adaptative

- Si une image dépasse la cadence visée (120 img/s par défaut), le facteur de qualité baisse un peu :
  - plus de faisceaux calculés à 1/2 ou 1/4 de la résolution ;
  - tables un peu plus légères.
- Il remonte doucement dès qu'il y a de la marge. Il ne descend pas sous 80 %, pour que l'image ne se dégrade pas.
- Réglable dans l'onglet Rendu.

Les shaders sont écrits une seule fois en GLSL. L'outil `sokol-shdc` les traduit en Metal, HLSL et GLSL dans `src/shaders/lyreviz.glsl.h`, qui est déjà généré. Après une modification de `shaders/lyreviz.glsl`, lancer `tools/compile_shaders.sh` (Mac) ou `tools\compile_shaders.bat` (Windows).

- Sous Windows, le script précompile le HLSL en bytecode : le programme démarre sans compiler de shader.
- Sur Mac, il ne peut produire que le source HLSL. Direct3D le compile alors au lancement, ce qui prend environ 1 s.
- Dans les boucles, toujours lire les textures avec `textureLod`, jamais avec `texture`. Sinon, le compilateur HLSL doit dérouler la boucle : cela lui prend 25 s, puis il échoue, et les faisceaux disparaissent sous Direct3D 11.

## Fichiers

| Fichier | Rôle |
|---|---|
| `src/main.cpp` | Fenêtre, caméra, mode personnage, souris et clavier. |
| `src/scene.cpp` | Hangar, trusses, décor, emplacements des lyres. |
| `src/fixtures.cpp` | Canaux des lyres, mouvements, effets, visée. |
| `src/gobos.cpp` | Roue de gobos générée par programme. |
| `src/fog.cpp` | Simulation de la fumée. |
| `src/renderer.cpp` | Ressources de la carte graphique et enchaînement des passes. |
| `src/ui.cpp` | Panneau de contrôle. |
| `src/gpu_profiler.cpp` | Temps GPU par passe, limiteur de latence et capture d'image (Direct3D 11). |
| `src/floor_texture.cpp` | Chargement de la texture du sol (stb_image), mipmaps, couleur du sol pour les rebonds. |
| `src/lasers.cpp` | Lasers : emplacements des 200 boîtiers, programmeur (formes, dégradés, diffraction, effets, galvos), motifs d'essai, découpage en segments d'éventail. |
| `src/volutes.cpp` | Lasers : texture 3D des volutes fines (génération au lancement, mipmaps, compression BC5). |
| `src/ilda.cpp` | Lasers : fichiers ILDA (lecture, bibliothèque, complément des traits, réduction en faisceaux et nappes, cache). |
| `assets/Concrete031/` | Texture du sol (ambientCG, CC0). |
| `shaders/lyreviz.glsl` | Tous les shaders (passes ci-dessus). |
| `tools/compare_bench.py` | Compare deux résultats du banc d'essai (temps et images). |
| `tools/perf_ab.ps1`, `tools/perf_report.py` | Compare deux versions en les lançant en alternance (voir `PERFORMANCE.md`). |
| `tools/set_ab.ps1` | Compare deux jeux de réglages avec le même exécutable : coût d'une option seule. |
| `tools/nettoyer_bench.py` | Liste les résultats de banc inutiles (non cités dans les documents ni dans l'historique) ; `--supprimer` les efface. |
| `tools/historique.py`, `historique_perf.xlsx` | Historique des performances : chaque modification mesurée y est ajoutée (évolution des img/s). |
| `PERFORMANCE.md` | Comment mesurer : procédure, valeurs de référence, pièges. À suivre pour toute nouvelle fonctionnalité. |

## Limites actuelles et prochaines étapes

- **Temps GPU :** mesurés passe par passe sous Direct3D 11 seulement (onglet Rendu et banc d'essai). Sous Metal et OpenGL, on ne voit que le temps total par image.
- **Latence :** sous Direct3D 11, le CPU ne prend pas plus de 2 images d'avance sur le GPU. Sans cette limite, le pilote acceptait des dizaines d'images en attente, ce qui retardait les commandes.
- **Performances mesurées** (GTX 1080, 3840 × 2160, lyres en mouvement, temps GPU) :

  | Cas (200 lyres) | Avant | Après | Images/s réelles |
  |---|---|---|---|
  | Scénario par défaut (3 vues) | 17 à 21 ms | 5,4 à 5,6 ms | 149 à 154 |
  | Zoom 45° + frost 0,6 | 116 à 129 ms | 7,3 à 7,8 ms | 100 à 120 |
  | Gobo + prisme 8 + zoom 25° | 82 à 109 ms | 9,8 à 13,6 ms | 70 à 95 |

  - Le dernier cas (toutes les lyres avec gobo et prisme 8, faisceaux larges qui se superposent partout) reste au-dessus de 8,3 ms.
  - Ce qui coûte encore : le dessin des cônes (environ 25 millions de pixels de fumée à additionner), l'éclairage des surfaces par ces faisceaux, et les tables.
- **Ombres :** obstacles fixes seulement (pavés), pénombre sur les surfaces mais bord net dans la fumée ; le personnage et les lyres ne font pas d'ombre.
- **Reflet des faisceaux :** les faisceaux ne se reflètent pas encore dans le sol brillant (seules les taches le font). Prévu. Avec de l'eau au sol, ce serait le reflet le plus visible.
- **Eau au sol :** le reflet coûte environ 1 ms (4 ms avec gobo + prisme 8 sur toutes les lyres, 11 ms avec zoom 45° + frost : faisceaux larges vus dans le reflet) quand l'eau couvre le sol ; 2 à 3 fois moins à 10 % d'eau (calculé seulement dans l'eau). Les tables des faisceaux du miroir (1,5 à 2,6 ms avec gobo + prisme ou frost) sont encore calculées pour toutes les lyres vues dans le reflet, même si peu de sol est dans l'eau (piste dans `PERFORMANCE.md`, « Pistes d'optimisation futures »). Pas encore de pluie ni d'ondulations dans les flaques.
- **Aberration chromatique :** sur les surfaces seulement (pas dans la fumée, où elle serait invisible). Coupée par défaut (+0,5 à +0,8 ms avec gobo + prisme 8 sur toutes les lyres).
- **Gobos personnels :** pas encore de chargement de vos propres images de gobo.
- **Art-Net / DMX :** pas de pilotage par une vraie console. Non prévu pour l'instant.
- **Lasers :** étapes 1 à 3 de `PLAN-LASERS.md` (rendu par tuiles, moteur et onglet Lasers, fumée). Au-dessus du budget dans les cas lourds, avec la fumée de la pièce et les volutes (réglages par défaut, en mouvement) : lasers seuls 7,1 à 10,2 ms sur L1 (200 × 1 000 traits, selon la vue), 11,9 à 12,1 ms sur L2 (cônes), 7,1 ms sur L3, 20,6 ms sur L7 (démonstration), pour ~4,6 ms disponibles ; L4 (traits séparés) 1,5 ms ; mix 100 lyres + 100 lasers à 9,2 – 11 ms au total. Sans les volutes (`--set volutes=0`) : environ 25 % de moins sur la passe des lasers. Fichiers ILDA : 1,9 ms pour 200 lasers en faisceaux, 31 à 49 ms pour 200 lasers qui jouent des nappes, des figures ou des tunnels. Puissance provisoire (pas encore en watts par couleur), pas encore d'impacts sur les surfaces ni de coupure par les obstacles et les joueurs.
