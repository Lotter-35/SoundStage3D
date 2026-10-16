# Scènes du moteur de rendu

Quarante programmations toutes faites, chacune un univers différent, pour montrer ce que sait faire le rendu de LyreViz. Elles s'ajoutent aux 20 ambiances de `src/ambiances.cpp` : **ambiances 21 à 60** de l'onglet Ambiances (sous le titre « Scènes du moteur de rendu »), ou au lancement avec `--ambiance N`.

```bat
LyreViz.exe --ambiance 21
```

## Fichiers

| Fichier | Contenu |
|---|---|
| `scenes.h` | Nombre de scènes, table des noms, `apply(i)`. |
| `scenes.cpp` | Nom, description et couleur du bouton de chaque scène. |
| `scenes_a.cpp` | Scènes 21 à 40. |
| `scenes_b.cpp` | Scènes 41 à 60. |
| `scene_kit.h` | Outils communs : repères de la salle, groupes d'appareils, couleurs, gobos, effets, fichiers ILDA. |
| `references/` | Photos d'inspiration données par l'utilisateur (15 octobre 2026). |
| `apercus/` | Une image de chaque scène, vue du public au lancement (4 planches de 10). |

## Comment une scène est faite

`apply_ambiance` (dans `src/ambiances.cpp`) remet tout à zéro avant chaque scène :
- lyres et lasers éteints, effets supprimés ;
- fumée, sol mouillé, aberration, points de visée aux réglages de départ ;
- réglages de l'image : exposition, bloom, éclat des lentilles, intensité, blanchiment et lueur de sortie des lasers, volutes ;
- puissance et angle maximal des lasers.

La scène n'écrit ensuite que ce qu'elle change. Exemple :

```cpp
case 7: {   // Aurore boreale
    fog.haze = 0.5f;
    r.floor_wet = 0.35f;
    lasers(G_TRUSS, [](LaserParams& p, LaserFixture&, int kg) {
        if (kg % 6 != 2) return;          // un laser sur six
        p.dimmer = 1;
        p.shape = LS_WAVE;
        ...
    });
    laser_fx(G_TRUSS, LFX_ROLL, 10, 0.04f, 360);
    break;
}
```

Pour ajouter une scène : une ligne dans la table de `scenes.cpp`, un `case` dans `scenes_b.cpp`, et monter `NUM_SCENES` (`scenes.h`) ; `NUM_AMBIANCES` (`src/ambiances.h`) suit (vérifié à la compilation).

Repères :
- **Salle** : scène à −X, public à +X ; la caméra du lancement est à x = 30 m, à 70 m de la scène. Une fumée plus dense que 1,3 fois celle de départ noie la scène (2 % de lumière transmise sur 70 m) : jouer plutôt sur la brume (`haze`) et les amas (`smoke`).
- **Puissance des lasers** : 2 W par défaut. Une nappe continue de 60° étale sa puissance : les scènes en nappes la montent à 5 à 15 W (`app.lasers.power_w`, remis à zéro par la scène suivante).

## Les 40 scènes

| N° | Nom | Ce qu'elle montre |
|---|---|---|
| 21 | Ciel liquide | Nappes rouges et blanches en plafond, fumée épaisse, volutes fortes (référence 05) |
| 22 | Pyramide laser | Nappes arc-en-ciel du sol et du nez qui se croisent (référence 01) |
| 23 | Couronne blanche | Faisceaux blancs serrés vers un même point (référence 03) |
| 24 | Traits croisés | Traits roses et cyan au hasard, colonnes rouges (référence 02) |
| 25 | Vert pur | Show laser vert, contre-jour blanc (référence 06) |
| 26 | Nappes bleues | Nappes bleues et traits blancs qui blanchissent (référence 07) |
| 27 | Volutes | Bandes de couleur aléatoires dans une fumée turbulente (référence 04) |
| 28 | Aurore boréale | Vagues laser vertes qui défilent, sol légèrement mouillé |
| 29 | Néon Tokyo | Sol inondé, prismes linéaires, grilles laser, aberration chromatique |
| 30 | Désert | Brume basse, vent, lumière ambre ; aucun laser |
| 31 | Abysses | Bleu profond, gobos breakup, rayons laser verticaux |
| 32 | Orage | Éclairs stroboscopiques, traits blancs qui fouettent |
| 33 | Feu d'artifice | Fichiers ILDA (feux d'artifice, explosions), lyres scintillantes |
| 34 | Textes ILDA | Banque Texte |
| 35 | Géométrie ILDA | Banque Géométrie depuis les trusses |
| 36 | Tunnels ILDA | Banque Tunnels sur les 16 lasers du pont |
| 37 | Dessins | Banque Crayon (dessins à main levée en courbes exactes) |
| 38 | Lissajous | Banque Sinus depuis les trusses |
| 39 | Formes | Carrés, triangles, étoiles, cœurs, cercles arc-en-ciel |
| 40 | Cœurs | Cœurs qui battent, gobos fleur |
| 41 | Étoiles filantes | Étoiles laser au hasard, gobo galaxie |
| 42 | Nef de lasers | Nappes verticales et colonnes de lumière |
| 43 | Rave rouge | Chenillards rapides, stroboscope |
| 44 | Cercles au sol | Cônes laser vers le bas, impacts en cercles |
| 45 | Disco | Prismes 8 et gobos points, grilles laser en diffraction |
| 46 | Spirale | Gobos spirale, tunnels laser qui tournent |
| 47 | Matrice | Grilles laser en diffraction ×9, gobos barres |
| 48 | Jungle | Feuillages, fumée qui monte, rayons ambre |
| 49 | Lagune | Sol inondé, nappe turquoise au ras des têtes |
| 50 | Glace | Prismes en grille, flocons laser, aberration |
| 51 | Volcan | Jets laser rouges du sol, fumée qui monte |
| 52 | Hypnose | Doubles éventails et tunnels blancs en rotation |
| 53 | Minimal | Quelques faisceaux fins, un seul trait vert, air clair |
| 54 | Brume dorée | Brume dorée, faisceaux doux, nappes ambre |
| 55 | Scanner | Un faisceau par laser qui balaie vite, arc-en-ciel |
| 56 | Pluie de points | Traits vers le sol : points qui dansent |
| 57 | Contre-jour | Le pont éblouit le public, silhouettes |
| 58 | Kaléidoscope | Prismes, cercles de points, étoiles laser en diffraction |
| 59 | Synthwave | Grille laser au sol mouillé, soleil orange |
| 60 | Final ILDA | Tous les fichiers ILDA à la fois, lyres arc-en-ciel |

Coût : ces scènes ne changent pas le moteur ; certaines (27, 33, 36, 60 : beaucoup de lasers ou de grandes figures) sont lourdes, comme les cas I1 à I4 du banc des lasers.
