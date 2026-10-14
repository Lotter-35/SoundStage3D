# LyreViz — banc d'essai de lyres en C++

Projet de test, séparé du simulateur web. Il sert à mesurer si un moteur natif C++ tient beaucoup de lyres (200 et plus) dans une fumée volumétrique réaliste. Les références visuelles sont Depence R4 et les vraies salles de concert.

- Rendu natif sur chaque système : **Metal** sur Mac, **Direct3D 11** sur Windows, OpenGL 4.3 sur Linux.
- Bibliothèques : [sokol](https://github.com/floooh/sokol) (fenêtre et accès à la carte graphique) et [Dear ImGui](https://github.com/ocornut/imgui) (panneau de contrôle).
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
- **Reflets brillants.** Le sol en béton lisse reflète les taches de lumière.
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
| `shaders/lyreviz.glsl` | Tous les shaders (passes ci-dessus). |
| `tools/compare_bench.py` | Compare deux résultats du banc d'essai (temps et images). |
| `tools/perf_ab.ps1`, `tools/perf_report.py` | Compare deux versions en les lançant en alternance (voir `PERFORMANCE.md`). |
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
- **Ombres :** pas encore d'ombres (les trusses et les objets ne cachent pas la lumière). Prévu en option, activable.
- **Reflet des faisceaux :** les faisceaux ne se reflètent pas encore dans le sol brillant (seules les taches le font). Prévu.
- **Gobos personnels :** pas encore de chargement de vos propres images de gobo.
- **Art-Net / DMX :** pas de pilotage par une vraie console. Non prévu pour l'instant.
