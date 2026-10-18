# D'où vient le lag des lasers ? (banc d'exploration, 16 octobre 2026)

Lasers seuls (lyres éteintes), GTX 1080, 3840 × 2160, réglages par défaut. Objectif : 120 img/s, soit 8,33 ms par image.

- Banc : `LyreViz.exe --bench-explore --fullscreen` (`src/bench_explore.cpp`). Voir « Le banc » en fin de document.
- Mesures :
  - `bench\explore_t2` : mesure de référence, 216 cas ;
  - `bench\explore_t1` : 1er lancement. La rotation continue d'un cas y restait acquise pour les cas suivants (corrigé depuis) : sa partie « balayage » n'est juste que jusqu'au cas 53.
  - `bench\explore_s1` : compteurs (`--stats`).
- Rapports chiffrés complets : `bench\explore_rapport_t2.md` (t2 + compteurs) et `bench\explore_rapport.md` (t1 et t2 moyennés). Script : `python tools\explore_report.py bench\explore_t2 --stats bench\explore_s1`.
- Bruit : t2 est globalement 12 % plus rapide que t1 (état de la carte, PC utilisé à côté), mais l'écart cas par cas autour de cette dérive n'est que de 4,7 %. La base, répétée 6 fois dans t2, varie de 3,15 à 3,37 ms.

## Le budget

| Cas | Passes laser (GPU) | Image | img/s |
|---|---|---|---|
| Scène seule, lasers coupés | 0 | 3,3 ms | 301 |
| 1 laser (éventail) | 0,75 ms | 6,0 ms | 167 |
| **Base : 50 lasers répartis, éventails 1 000 traits, 40°, vague pan, vue du public** | **3,25 ms** | **8,2 ms** | **122** |
| 200 éventails | 10,0 ms | 14,8 ms | 68 |

- La base est juste à la limite des 120 img/s.
- **Dans cette scène, il reste environ 3,3 ms de GPU pour les lasers** (avec des lyres allumées, moins).
- **Coût fixe des lasers allumés : environ 0,7 ms, même pour un seul laser.**
  - La passe des nappes parcourt toutes les tuiles de l'écran 4K, même vides (0,4 à 0,45 ms).
  - S'y ajoutent le tri (0,1 ms) et la lecture de l'image des lasers dans la composition (0,2 ms).

## La règle qui explique presque tout

**Temps des lasers ≈ 0,074 ms par million de couples (pixel, nappe) + 0,56 ms par millier de segments + 0,2 ms**

- Ce modèle explique 89 % des écarts sur les 216 cas (R² = 0,89).
- Un **couple** est un pixel de l'écran traversé par une nappe. Le coût est donc celui de la **surface à l'écran × nombre de nappes empilées**. Le nombre de traits, la couleur, la puissance et la fumée n'y entrent presque pas.
- **Les nappes courbes coûtent 1,6 fois plus par couple** : environ 117 ps contre 73 ps pour les nappes planes et les traits. Elles concernent les cônes, tunnels, vagues, cœurs et la plupart des fichiers ILDA (passe « lasers : arcs »).
- Ce qui fait monter les couples :
  - plus de lasers ;
  - plus de copies (diffraction) ;
  - plus de nappes par figure (grille, étoile, carré) ;
  - une plus grande ouverture ;
  - des figures braquées vers la caméra ou proches d'elle.

## Tableau récapitulatif : les plus grosses sources de lag

Balayage autour de la base (50 lasers, un réglage changé à la fois, mesure t2). « × base » = temps des passes laser divisé par celui de la base (3,25 ms). « Lasers à 120 img/s » : estimation du nombre de lasers de ce type que tient le budget (3,3 ms, coût fixe de 0,7 ms déduit), vus du public.

| Rang | Source | Valeur testée | Passes laser | × base | Image | Lasers à 120 img/s | Pourquoi |
|---|---|---|---|---|---|---|---|
| 1 | **Fichiers ILDA** (figures courbes, tracés) | Crayon | 27,3 ms | ×8,4 | 32 ms | ~5 | passe des arcs 23 ms ; 281 M couples ; 5 500 segments |
| | | Géométrie | 25,6 ms | ×7,9 | 30 ms | ~5 | arcs 21 ms |
| | | Sinus | 22,9 ms | ×7,1 | 27 ms | ~6 | arcs 20 ms |
| | | Texte, Animations | 16,8 – 16,9 ms | ×5,2 | 21 ms | ~8 | arcs 12 – 13 ms ; 2 000 à 3 000 segments |
| | | Exemples, Formes, Tunnels, Nappes | 11,1 – 12,0 ms | ×3,4 – 3,7 | 16 ms | ~12 | arcs 7 – 10 ms |
| | | Faisceaux | 1,3 ms | ×0,4 | 6 ms | 200 et plus | aucun arc, traits fins |
| 2 | **Figures courbes** du programmeur | Tunnel | 23,2 ms | ×7,1 | 28 ms | ~6 | 2 cônes = 4 nappes par pixel ; arcs 21 ms |
| | | Vague | 17,7 ms | ×5,4 | 22 ms | ~7 | arcs 15,6 ms ; moteur CPU 1,4 ms |
| | | Cône, Cœur | 14,6 – 14,9 ms | ×4,5 | 19 – 20 ms | ~9 | arcs 12,6 – 13,2 ms |
| 3 | **Diffraction** | ×3 / ×5 / ×9 | 7,7 / 12,3 / 21,1 ms | ×2,4 / ×3,8 / ×6,5 | 12,5 / 17 / 26 ms | 50 ÷ (copies) | chaque copie est une figure de plus : 151 / 245 / 441 M couples |
| 4 | **Figures à plusieurs nappes** | Grille 5 rangées | 14,0 ms | ×4,3 | 19 ms | ~10 | 5 nappes empilées (230 M couples) |
| | | Étoile | 8,7 ms | ×2,7 | 14 ms | ~16 | 10 côtés |
| | | Carré, Triangle | 6,9 – 7,1 ms | ×2,2 | 12 ms | ~20 | |
| | | Double éventail | 5,8 ms | ×1,8 | 11 ms | ~25 | 2 nappes |
| 5 | **Nombre de lasers** (éventails) | 1 / 25 / 100 / 200 | 0,75 / 2,0 / 5,1 / 10,0 ms | — | 6,0 / 6,8 / 10,6 / 14,8 ms | ~50 | presque proportionnel : ~0,05 ms par éventail de 40°, plus le coût fixe |
| 6 | **Ouverture** | 0° / 10° / 20° / 60° | 0,8 / 1,5 / 2,1 / 4,6 ms | ×0,25 à ×1,4 | 5,8 à 10 ms | | surface de la nappe : presque proportionnel à l'ouverture |
| 7 | **Impacts sur les surfaces** | base / cas extrêmes | 0,13 ms / 6 à 8 ms | | | | 200 cœurs ×9 : 10 000 impacts, 7,9 ms ; tunnels vers le sol devant la caméra : 6,5 ms |
| | | sol mouillé 0,3 / inondé | +0,6 / +0,8 ms | ×1,1 – 1,2 | | | les impacts coûtent 5 à 7 fois plus sur le sol mouillé (0,13 → 0,73 / 0,94 ms) ; les lasers ne se reflètent pas dans l'eau |
| 8 | **Moteur CPU** | vagues, ILDA + diffraction | jusqu'à 7,4 ms de CPU | | | | une vague change à chaque image (pas de cache possible). 150 vagues ×5 : CPU 7,8 ms, plus que le GPU (5,6 ms), seul cas limité par le CPU |
| 9 | **Fumée des nappes** (options du rendu) | volutes coupées | −0,62 ms | ×0,81 | 7,8 ms | | lectures de la texture 3D |
| | | 2e octave coupée | −0,38 ms | ×0,88 | | | |
| | | tout coupé (fumée uniforme, un lobe) | −1,0 ms | ×0,69 | 7,0 ms | | variante 0 du shader |
| 10 | **Traits par figure** | 1 à 16 | 0,9 à 1,4 ms | ×0,3 – 0,45 | 5,6 – 6,3 ms | ~170 | chaque trait est une bande fine : seules ses tuiles sont calculées (1 à 20 M couples) |
| | | 17 à 100 | 3,6 – 3,7 ms | ×1,1 | 9,1 – 9,4 ms | ~45 | la nappe entière est calculée (49 M couples), en traits séparés : un peu plus cher que 1 000 traits |
| | | 300, 1 000, nappe continue (0) | 3,0 – 3,5 ms | ×0,9 – 1,05 | 8,2 – 8,7 ms | ~50 | nappe lisse (le calcul le plus court) |
| 11 | **Emplacement et visée** (16 lasers) | trusses / trusses loin | 1,0 / 0,95 ms | | | | faisceaux vers le bas, vus de loin : peu de pixels |
| | | au-dessus du public / répartis / scène (pont, sol, nez) | 1,6 / 1,9 / 2,2 ms | | | | nappes tournées vers la caméra : plus de pixels |
| | | tilt −25° / +25° (base) | 2,3 / 3,4 ms | ×0,7 / ×1,04 | | | vers le sol : moins d'écran couvert |
| 12 | **Dégradés** | défilant, arc-en-ciel, au hasard | +0,4 à +0,6 ms | ×1,15 – 1,2 | | | 639 à 840 segments au lieu de 88 (morceaux de couleur), variante du shader |
| | | 2 et 3 couleurs | +0,1 à +0,2 ms | | | | |

### Ce qui ne coûte rien (dans le bruit, ±0,3 ms)

- **Densité de fumée** (de 0 à ×4) et amas coupés : le calcul est le même, seule la valeur change.
- **Puissance** (0,2 à 8 W), **largeur minimale des traits** (0,3 à 2 px), blanchiment, lueur de sortie, bloom.
- **Mouvement** des figures (fixe, vague, cercle, balayage aléatoire, rotation) : seulement le moteur CPU (≤ 0,2 ms ici) ; le cache des figures fixes ne change rien au GPU.
- **Collisions** (−0,25 ms coupées, avec moins de segments).
- **Vue** pour des éventails : public, scène, sous les trusses, gros plan à ±0,4 ms ; « dans les nappes » +0,6 ms.

### Dernier recours

- **FSR 1,5** : lasers −51 % (3,25 → 1,58 ms, image 5,8 ms).
- **FSR 2** : lasers −75 % (0,80 ms), au prix de traits plus doux.

## Programmations au hasard (120 cas croisés)

- **55 % tiennent 120 img/s.**
- Selon le nombre de lasers allumés :
  - 1 laser : 94 % ;
  - 10 lasers : 67 % ;
  - 50 lasers : 35 % ;
  - 200 lasers : 33 %.
- Réglages les plus importants (forêt aléatoire, log du temps des lasers) :
  1. **lasers × copies de la diffraction**, de loin ;
  2. traits séparés ou trait seul (beaucoup moins cher) ;
  3. visée ;
  4. ouverture.
  - Tout le reste est presque nul.
- Les cas les plus lourds :
  - 100 vagues en nappe continue, diffraction ×3, vues de près : 88 ms (arcs 77 ms, 800 M couples) ;
  - 100 fichiers ILDA Texte, diffraction ×9 : 78 ms ;
  - 50 mélanges près du public avec diffraction ×9 : 53 ms ;
  - 50 grilles, diffraction ×5, vues sous les trusses : 48 ms (680 M couples, sans aucun arc) ;
  - 200 cœurs avec diffraction ×9 : 44 ms, dont 7,9 ms d'impacts.

## Priorités pour optimiser plus tard

1. **Passe des arcs** (figures courbes et ILDA) : c'est le plus gros levier. Chaque couple y coûte 1,6 fois plus, et ces figures couvrent plus de pixels. Pistes déjà notées : `docs/optimisations-lasers.md` (lumière noyée, tri plus fin des nappes courbes par tuile, fumée lue moins souvent).
   - Essais exacts du 16 octobre 2026 : au mieux −1,4 %, rien de gardé (`docs/optimisations-lasers.md`, « Passe des arcs : essais exacts »). Il ne reste que des compromis sur l'image : un recours possible, non codé, sur demande de l'utilisateur.
2. **Nappes empilées depuis une même sortie** : diffraction, grilles, étoiles et fichiers ILDA. Une tuile près de la sortie contient toutes les nappes de la figure. Piste : rejet plus tôt des pixels hors du coin de chaque nappe (`PERFORMANCE.md`, pistes 2 et 8).
3. **Impacts** : leur coût monte avec leur nombre et leur taille à l'écran, et sur le sol mouillé.
4. **Moteur CPU** : vagues (recalculées à chaque image) et ILDA avec diffraction. Avec les lyres et la fumée sur le CPU (1,6 ms), il peut devenir la limite.
5. **Coût fixe** : la passe des nappes calcule toutes les tuiles, même vides (0,4 ms) ; ne lancer que les tuiles touchées.
6. **Fumée des nappes** (31 % de la base) : déjà en variantes du shader ; un niveau de détail au loin (`docs/optimisations-lasers.md`, piste 6).

## Le banc

```bat
LyreViz.exe --bench-explore --fullscreen --random 120 --seed 1 --benchdir bench\explore_t2
LyreViz.exe --bench-explore --fullscreen --random 120 --seed 1 --stats --measure 8,16 --benchdir bench\explore_s1
python tools\explore_report.py bench\explore_t2 --stats bench\explore_s1 --out bench\explore_rapport_t2.md
```

- **Balayage** : la base, puis 90 cas qui changent chacun un seul réglage. La base revient tous les 20 cas pour suivre la dérive de la carte.
  - Réglages : nombre de lasers, emplacement, forme, traits, ouverture, diffraction, dégradé, visée, écart en pan, mouvement, 10 banques ILDA, mélange, vue, fumée, options du rendu, eau au sol, FSR.
- **Hasard** : `--random N` programmations tirées au hasard (graine `--seed`), avec tous les réglages à la fois. `--nosweep` : sans le balayage.
- 30 images de chauffe et 60 mesurées par cas (`--measure chauffe,mesure` pour changer). Pas d'image enregistrée, sauf avec `--shots` (25 Mo par cas). `--cases` permet de rejouer un cas.
- Sortie : `exploration.csv`, un cas par ligne :
  - réglages ;
  - temps moyen de chaque passe ;
  - moteur CPU ;
  - segments, traits, impacts, variante de la fumée, primitives ILDA ;
  - avec `--stats` : couples (pixel, segment) et segments par tuile.
- Chaque cas part du même état : galvos, rotation continue et défilement sont remis à zéro.
  - Le banc `--bench-lasers`, lui, ne le fait pas. La rotation de L7 reste acquise pour les cas ILDA et P qui suivent ; un sous-ensemble lancé avec `--cases` part donc d'un autre état que le banc complet.
