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

1. **Tri des lumières par case 3D de l'écran** (calcul GPU). Chaque pixel ne regarde que les lyres qui peuvent le toucher, au lieu des 200.
2. **Tri des faisceaux par tuile 2D** (calcul GPU), pour la fumée.
3. **Sondes de lumière indirecte** (calcul GPU). Elles reçoivent environ 1 600 « lumières virtuelles », posées sur les taches de lumière et le long des faisceaux.
4. **Géométrie et éclairage des surfaces.** Tout est dessiné en instances : 4 appels de dessin pour toute la scène.
5. **Faisceaux dans la fumée,** à résolution réduite.
   - Intersection exacte du rayon avec le cône de chaque faisceau.
   - Échantillonnage *équiangulaire* : les échantillons se resserrent près de la source, là où la lumière varie le plus vite.
6. **Accumulation temporelle.** Elle lisse le bruit des échantillons d'une image à l'autre.
7. **Composition.** La scène est atténuée par la fumée, puis la lumière diffusée est agrandie en tenant compte de la profondeur.
8. **Bloom, puis image finale.**

Les shaders sont écrits une seule fois en GLSL. L'outil `sokol-shdc` les traduit en Metal, HLSL et GLSL dans `src/shaders/lyreviz.glsl.h`, qui est déjà généré. Après une modification de `shaders/lyreviz.glsl`, lancer `tools/compile_shaders.sh` (Mac) ou `tools\compile_shaders.bat` (Windows).

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

## Limites actuelles et prochaines étapes

- **Temps GPU :** sokol ne mesure pas le temps passé par la carte graphique dans chaque passe. On voit le temps total par image (et le temps CPU).
  - Pour mesurer, lancer avec `--novsync`, puis regarder les images par seconde en coupant les options une par une.
- **Ombres :** pas encore d'ombres (les trusses et les objets ne cachent pas la lumière). Prévu en option, activable.
- **Reflet des faisceaux :** les faisceaux ne se reflètent pas encore dans le sol brillant (seules les taches le font). Prévu.
- **Gobos personnels :** pas encore de chargement de vos propres images de gobo.
- **Art-Net / DMX :** pas de pilotage par une vraie console. Non prévu pour l'instant.
