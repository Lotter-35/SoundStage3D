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
  | `wet` | Eau au sol : 0 sec, 0,4 humide, 1 inondé. |
  | `shadows` | Ombres exactes des obstacles (1) ou non (0). |
  | `flooraniso` | Filtrage anisotrope de la texture du sol (1 à 16, 4 par défaut). |

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
- `--quick` : seulement la vue public (3 cas). `--benchdir dossier` : dossier de sortie. Les options `--set` s'appliquent à tous les cas.
- `--static` : lyres et fumée immobiles, pour comparer des images sans mouvement. `--stats` : compte les couples (pixel, faisceau) de la fumée (ralentit un peu).
- Les mesures varient de 10 à 20 % d'un lancement à l'autre (fréquence de la carte, autres programmes) : pour comparer deux versions, les lancer en alternance plusieurs fois.
- Comparer deux versions (temps et écart entre les images) :

```bat
python tools\compare_bench.py bench\avant bench\apres --diff bench\ecarts
```

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
7. **Accumulation temporelle.** Elle lisse le bruit qui reste (lumière indirecte de la fumée).
8. **Composition.** La scène est atténuée par la fumée, puis la lumière diffusée est agrandie en tenant compte de la profondeur.
9. **Bloom, puis image finale.**

### Calcul analytique des faisceaux

C'est ce qui rend les gobos, les prismes et le frost presque gratuits dans la fumée.

- La lumière qu'un faisceau envoie vers la caméra le long d'un rayon est une intégrale de l'image projetée (gobo, prisme…) le long de ce rayon.
- Dans un repère propre à chaque lyre, orienté vers la caméra (repère « épipolaire »), chaque rayon de la caméra reste dans un plan, et y parcourt une ligne de l'image projetée.
- Une table par lyre, recalculée à chaque image, contient pour chaque ligne l'intégrale **cumulée** de l'image.
- L'intégrale sur un morceau de rayon devient la différence de deux valeurs lues dans la table. Il n'y a plus d'échantillons au hasard, donc plus de bruit, et le coût ne dépend plus du gobo ni du nombre de facettes.
- Ce qui varie lentement (densité de la fumée, diffusion, atténuation, distance) est pris au milieu de quelques morceaux du rayon.
- La table existe en plusieurs niveaux de flou, pour la mise au point et le frost.
- L'ancien calcul par échantillons reste disponible : décocher « calcul analytique » dans l'onglet Rendu.

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
- **Limites.**
  - Dans la fumée, le bord de l'ombre reste net (la pénombre n'est que sur les surfaces).
  - Deux ombres qui se chevauchent le long d'un même rayon dans la fumée seraient retirées deux fois : le résultat est borné à 0.
  - Seuls les obstacles fixes : le personnage (mode F) et les lyres ne font pas d'ombre.

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
- **Eau au sol** (onglet Rendu, `--set wet=...`), d'après Lagarde, « Water drop 3b – Physically based wet surfaces ».
  - **0 à 0,5 : le béton s'imbibe, sans flaque.** L'eau remplit les pores : il fonce selon sa porosité (les creux et les joints davantage) et devient plus brillant. La texture reste visible.
  - **0,5 à 1 : le niveau d'eau monte.** Film d'eau puis flaques, d'abord dans les cuvettes (2 à 3 m) et les joints, jusqu'à couvrir le sol. Dans l'eau, le sol est plat et lisse.
  - **Reflet** (méthode des sols plats des jeux : reflet planaire).
    - Une caméra miroir sous le sol redessine la scène à demi-résolution : surfaces éclairées par toutes les lyres, lentilles, faisceaux dans la fumée (avec leurs propres tables analytiques, deux fois moins fines). Le reflet contient donc aussi ce qui est au-dessus de la caméra, hors de l'écran.
    - Béton humide : reflet étiré verticalement (flou vertical continu), comme une route mouillée la nuit. Flaques : miroir net.
    - Fresnel de l'eau : fort en rasant, faible en regardant vers le bas.
    - Seule la partie de l'écran où le sol est visible est calculée, et seulement les lyres dont le cône est visible dans le reflet. Rien n'est calculé quand le sol est sec ou hors de l'écran.
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
| `assets/Concrete031/` | Texture du sol (ambientCG, CC0). |
| `shaders/lyreviz.glsl` | Tous les shaders (passes ci-dessus). |
| `tools/compare_bench.py` | Compare deux résultats du banc d'essai (temps et images). |
| `tools/perf_ab.ps1`, `tools/perf_report.py` | Compare deux versions en les lançant en alternance (voir `PERFORMANCE.md`). |
| `tools/set_ab.ps1` | Compare deux jeux de réglages avec le même exécutable : coût d'une option seule. |
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
- **Eau au sol :** le reflet coûte environ 1,5 ms (4 ms avec gobo + prisme 8 sur toutes les lyres) : avec de l'eau, le cas par défaut passe un peu sous 120 img/s sans la qualité adaptative. Pas encore de pluie ni d'ondulations dans les flaques.
- **Gobos personnels :** pas encore de chargement de vos propres images de gobo.
- **Art-Net / DMX :** pas de pilotage par une vraie console. Non prévu pour l'instant.
