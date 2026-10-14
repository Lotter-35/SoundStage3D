# Tests de performance de LyreViz

Objectif : **3840 × 2160 à 120 images/s sur une GTX 1080**, sans dégradation visible de l'image.
Une image doit donc tenir en **8,3 ms**. Toute nouvelle fonctionnalité doit être mesurée avant d'être gardée : temps **et** image.

## Règles

1. **Mesurer avant et après.** Garder l'exécutable d'avant (`bench\ref\avant.exe`), compiler le nouveau, comparer avec `tools\perf_ab.ps1`.
2. **Ne jamais conclure sur un seul lancement.**
   - Sur cette machine, les temps varient de 10 à 20 % d'un lancement à l'autre (fréquence et température de la carte, autres programmes).
   - Lancer les deux versions **en alternance** (A B A B) et comparer les moyennes. C'est ce que fait `perf_ab.ps1`.
3. **Regarder le temps GPU total**, pas seulement la passe modifiée.
   - Quand une passe travaille plus, la carte baisse sa fréquence et toutes les passes ralentissent un peu.
   - Les temps par passe peuvent aussi glisser d'une passe à la suivante.
4. **Vérifier l'image.**
   - PSNR et part de pixels changés (`compare_bench.py`), sur une scène immobile (`--static`).
   - Puis regarder des **agrandissements** : brume, bords des faisceaux, gobos au sol, près des lentilles.
   - Une moyenne chiffrée peut cacher un défaut visible (la brume en taches est passée inaperçue dans les chiffres).
5. **Une nouvelle fonctionnalité doit être activable** (case dans l'onglet Rendu, réglage `--set`). On peut alors mesurer son coût seul avec le même exécutable :
   ```bat
   powershell -ExecutionPolicy Bypass -File tools\set_ab.ps1 -SetA "adaptive=0","nouvelle=0" -SetB "adaptive=0","nouvelle=1" -Name essai
   ```
   - Avec `powershell -File`, une liste `"a=1","b=2"` arrive en une seule chaîne `a=1,b=2`. Les deux scripts la redécoupent sur les virgules. Avant cette correction, seul le premier réglage était appliqué, sans message d'erreur.
6. **Aucune autre instance de LyreViz (ni jeu, ni vidéo) pendant les mesures.**
   - Elles partagent la carte graphique et faussent tout.
   - `perf_ab.ps1` prévient si une instance est ouverte.
   - Exemple : une mesure faite avec une instance ouverte donnait +0,3 ms pour les faisceaux au diamètre de la lentille ; refaite proprement, c'était +0,7 ms.

## Procédure pas à pas

```bat
rem 1. Garder la version actuelle comme reference
build.bat
copy LyreViz.exe bench\ref\avant.exe

rem 2. Faire la modification, recompiler les shaders si besoin, puis le programme
tools\compile_shaders.bat
build.bat

rem 3. Comparer (3 cas, scene immobile, qualite fixe, 2 alternances, banc rapide)
powershell -ExecutionPolicy Bypass -File tools\perf_ab.ps1 -ExeA bench\ref\avant.exe -ExeB LyreViz.exe -Fast -Name essai

rem 4. Avant de garder : tous les cas, en mouvement
powershell -ExecutionPolicy Bypass -File tools\perf_ab.ps1 -ExeA bench\ref\avant.exe -ExeB LyreViz.exe -Fast -Name essai_complet -Full -Moving

rem 5. Toujours : ajouter la nouvelle version a l'historique des performances (historique_perf.xlsx)
python tools\historique.py --modif "N. nom de la modification" --reglages "adaptive=0, en mouvement" bench\essai_complet_B0 bench\essai_complet_B1
```

**Banc rapide (`-Fast`, option `--fast` du programme) : à utiliser par défaut.**

- 30 images de chauffe et 60 mesurées par cas, au lieu de 60 et 150. Un lancement du banc complet prend environ 20 s au lieu de 46 s.
- Le banc normal (sans `-Fast`) reste pour une décision serrée et pour les valeurs de référence.
- Un ancien exécutable qui ne connaît pas `--fast` l'ignore et fait le banc normal : comparer alors sans `-Fast`.
- La comparaison d'images n'écrit l'image d'écart que pour les cas qui changent, à demi-résolution (le plus grand écart de chaque carré de 2 × 2 pixels) : 4 fois plus rapide.

**La fenêtre du banc doit rester la fenêtre active.**

- Windows donne la priorité à la fenêtre active. Mesuré (même exécutable, en alternance) : derrière les autres fenêtres, ou si l'on clique ailleurs pendant le banc, le GPU est 5 à 15 % plus lent dans les cas lourds (gobo + prisme / public : 17,8 et 18,5 ms devant ; 20,1 et 21,4 ms derrière). Les images sont identiques.
- L'option `-Behind` (`--behind`) ouvre la fenêtre derrière les autres sans prendre le clavier. Elle n'est pas utilisée par défaut : seulement pour comparer A et B entre eux pendant que l'on travaille, jamais pour des valeurs de référence.
- Pendant le banc, le clavier et la souris sont ignorés : un clic ou une touche ne déplace pas la caméra.
- Utiliser le PC pendant les mesures est la principale source d'écarts : alterner A et B, et juger une optimisation en scène immobile.

`perf_ab.ps1` affiche :

- pour chaque cas, le temps GPU moyen de A et de B, l'écart en %, les images/s, et le résultat de chaque lancement (pour juger du bruit) ;
- le temps de chaque passe ;
- l'écart entre les images (PSNR, pixels changés de plus de 4/255 et de 16/255).
- Les images d'écart amplifiées sont écrites dans `bench\<nom>_ecarts\`.

### Lire les résultats

| Mesure | Bon | À regarder de près |
|---|---|---|
| Écart de temps GPU | sous le bruit (moins de 3 à 5 %, et le même sens à chaque lancement) | plus de 5 %, ou A et B qui se croisent selon les lancements |
| PSNR (scène immobile) | plus de 60 dB : image identique | moins de 50 dB |
| Pixels changés de plus de 4/255 | 0 % | plus de 0,5 % |

- Deux lancements de la **même** version donnent environ 63 à 75 dB entre eux.
- En mouvement (`-Moving`), les écarts d'image sont plus grands : les effets ne sont pas exactement synchronisés avec le lissage dans le temps. Comparer les images en scène immobile.

## Historique des performances (`historique_perf.xlsx`)

- Une ligne par cas du banc et par modification, dans la feuille « Mesures » : date, version (commit), modification, réglages, durée d'une image, img/s réelles, temps GPU, surfaces, fumée, reflet du sol, paires d'ombre.
- La feuille « Comparaison » montre l'évolution : un cas par ligne, une modification par colonne (img/s, puis temps GPU).
- Rempli par `tools\historique.py` après chaque mesure (plusieurs dossiers = lancements moyennés). Ne comparer que des colonnes aux mêmes réglages.

## Le banc d'essai (`LyreViz.exe --bench`)

- Cas mesurés :
  - 3 scénarios de lyres : par défaut ; gobo + prisme 8 + zoom 25° ; zoom 45° + frost 0,6 ;
  - chacun avec 3 vues : public, scène, sous les trusses ;
  - puis le scénario par défaut en coupant les options une par une.
- Pour chaque cas : 60 images de chauffe, puis 150 images mesurées, avec un pas de temps fixe (mêmes images à chaque lancement).
- Options :

  | Option | Effet |
  |---|---|
  | `--quick` | Seulement la vue public (3 cas). |
  | `--static` | Lyres et fumée immobiles. |
  | `--fullscreen` | Plein écran (4K sur l'écran de test). |
  | `--set nom=valeur` | Change un réglage (liste dans le README). |
  | `--stats` | Compte les couples (pixel, faisceau) de la fumée. Ralentit un peu. |
  | `--benchdir dossier` | Dossier des résultats. |

- Sorties, dans le dossier choisi :
  - `resultats.txt` : par cas, durée moyenne d'une image et images/s ; temps GPU moyen et médian ; temps de chaque passe (médiane et moyenne) ; détail CPU ; qualité adaptative ; nombre de faisceaux par niveau de résolution ; taille des tables.
  - `01.bmp` … : la dernière image de chaque cas.
  - `images.csv` : les temps image par image (pour repérer des images qui alternent lent / rapide).
- Les temps GPU par passe ne sont mesurés que sous Direct3D 11 (`src/gpu_profiler.cpp`). Ils s'affichent aussi en direct dans l'onglet Rendu.

### Pièges connus

- **« image finale + interface »** contient aussi l'attente de l'écran : sans synchro verticale, une image sur deux attend que l'écran libère son tampon. Ce n'est pas du calcul ; la qualité adaptative l'ignore.
- **Durée d'une image** = moyenne, pas médiane : les images alternent souvent entre très courtes et très longues, et la médiane trompe.
- **Changer une seule chose à la fois** et la mesurer. Plusieurs « optimisations » essayées se sont révélées plus lentes une fois mesurées en alternance (voir plus bas).

## Valeurs de référence (14 octobre 2026, avec le sol en béton texturé, GTX 1080, 3840 × 2160)

Banc complet (`bench\reference`) :

- réglages par défaut, lyres en mouvement ;
- qualité adaptative active (plancher 80 %) ;
- faisceaux au diamètre de la lentille (0,26 m) ;
- aucune autre instance ouverte.

| Cas (200 lyres) | GPU | Images/s réelles |
|---|---|---|
| Défaut / public, scène, sous les trusses | 5,8 à 6,3 ms | 131 à 142 |
| Gobo + prisme 8 + zoom 25° | 10,2 à 14,7 ms | 66 à 93 |
| Zoom 45° + frost 0,6 | 7,4 à 8,1 ms | 97 à 119 |
| Sans fumée volumétrique | 3,2 ms | 194 |

- Mesuré pendant que le PC servait à autre chose (navigation, vidéo) : à remesurer au calme si un écart paraît anormal.
- Avant le sol texturé (`bench\reference_avant_sol`) : 5,6 à 6,0 ms ; 10,1 à 14,1 ms ; 7,2 à 7,7 ms ; 2,8 ms.
- **Budget restant dans le cas par défaut : environ 2 ms** (8,3 − 6,3 ms ; 2,4 ms avant le sol texturé) avant de descendre sous 120 images/s.
- Une nouvelle fonctionnalité active par défaut doit tenir dans ce budget, ou se payer ailleurs.
- Le cas gobo + prisme 8 sur toutes les lyres est déjà au-dessus du budget : ne pas l'alourdir.
- Pour remettre ces valeurs à jour : `LyreViz.exe --bench --fullscreen --benchdir bench\reference`, rien d'autre d'ouvert.

Répartition du cas par défaut, vue public (GPU, médiane) :

| Passe | Temps |
|---|---|
| Calcul : tri + sondes | 0,31 ms |
| Calcul : tables fumée | 0,86 ms |
| Pré-passe de profondeur | 0,12 ms |
| Surfaces (sol texturé compris) | 1,55 ms |
| Fumée (faisceaux + lumière indirecte) | 1,7 ms |
| Accumulation | 0,17 ms |
| Composition | 0,39 ms |
| Bloom | 0,38 ms |
| Image finale | 0,25 ms |

Coûts mesurés de fonctionnalités, à titre d'exemple :

- **Faisceaux au diamètre de la lentille** (au lieu d'un point) : +0,7 ms dans le cas par défaut. Les faisceaux sont plus larges près des lyres et couvrent plus de pixels.
- **Sol en béton texturé** (passe des surfaces, médianes, même exécutable, `floor=0` contre `floor=1`, en mouvement) :
  - par défaut : +0,2 ms (vue sous les trusses : +0,05 ms) ;
  - zoom 45° + frost 0,6 : +0,2 à +0,3 ms ;
  - gobo + prisme 8 : +0,6 à +0,7 ms (vue sous les trusses : +0,2 ms).
  - Le coût vient du filtrage anisotrope, pas du calcul. Il grandit avec le nombre de lectures de gobos de la boucle des lyres, qui partagent les unités de texture.

### Ombres des obstacles (14 octobre 2026)

Même exécutable, `shadows=0` contre `shadows=1`, banc complet en mouvement, qualité fixe, 2 lancements :

| Cas | Sans ombres | Avec ombres |
|---|---|---|
| Défaut (3 vues) | 6,4 à 7,1 ms | +0,15 à +0,27 ms |
| Gobo + prisme 8 (3 vues) | 11,9 à 17,6 ms | +0,9 à +1,4 ms |
| Zoom 45° + frost 0,6 (3 vues) | 8,0 à 10,6 ms | +0,4 à +0,5 ms |
| Sol mouillé (2 cas) | 9,1 et 21,2 ms | +0,3 et +0,9 ms |

**Avec la pénombre sur les surfaces** (même mesure refaite, `bench\penombre_*`, historique 6a / 6b) :

| Cas | Sans ombres | Avec ombres et pénombre |
|---|---|---|
| Défaut (3 vues) | 6,5 à 7,2 ms | +0,01 à +0,18 ms |
| Gobo + prisme 8 (3 vues) | 11,9 à 17,6 ms | +0,9 à +1,6 ms |
| Zoom 45° + frost 0,6 (3 vues) | 7,6 à 10,5 ms | +0,7 à +0,9 ms |

- La pénombre coûte surtout avec le frost : +0,3 à +0,5 ms de plus qu'avec le bord net, dans la passe des lyres douces (1/4) et les cases de lumière (plus de cases touchées par la pénombre).
- Ailleurs, l'écart avec le bord net reste dans le bruit de mesure.

Paires (lyre, pavé) : 95 par défaut, 282 avec gobo + prisme 8, 941 avec zoom 45° + frost (presque toutes les lyres ont des pavés dans leur cône large).

| Essai | Résultat (cas zoom 45° + frost, vue scène) |
|---|---|
| Volume d'ombre recalculé par pixel (12 arêtes), tableaux de 8 morceaux triés dans la fumée | +11 ms : tous les pixels ralentis (registres), même sans obstacle |
| Volumes calculés sur le CPU (plans), sans tri à l'écran | +12 ms : chaque pixel de fumée testait ~5 volumes |
| + rectangle d'écran par paire, lu dans la fumée | +3 ms |
| + bit « ombre » par case de lumière (plans testés dans le calcul des cases) | surfaces quasi gratuites, mais calcul des cases +1,2 ms |
| + masques par tuile d'écran (CPU) et plages de profondeur dans le calcul des cases | calcul des cases +0,15 ms ; fumée et lyres douces encore +4,2 ms au total (rectangles « tout l'écran ») |
| **+ volume coupé au plan avant de la caméra et prolongé au-delà des parois (au lieu de « tout l'écran »)** | **+0,5 ms : gardé.** Images identiques (PSNR > 73 dB) |

Longueur des faisceaux arrêtés par un obstacle (correction : bout des taches rasantes coupé net, `--demo 4`), banc rapide complet, scène immobile, contre la version d'avant :

| Essai | Résultat |
|---|---|
| Distance exacte pour le plan de chaque face touchée | surfaces +0,5 à +1 ms avec gobo + prisme, images identiques : une face presque parallèle au faisceau l'allongeait pour rien |
| **Distance exacte seulement si les 9 points touchés sont sur un même plan (le sol), sinon comme avant** | **neutre (écarts dans le bruit), images identiques sur le banc (PSNR > 66 dB), bout des taches rasantes corrigé : gardé** (historique 8) |

### Aberration chromatique (14 octobre 2026)

Franges colorées au bord des taches et des gobos (voir le README). Coupée par défaut : `--set chroma=1`, intensité `--set chromaforce=...`.

Coût (même exécutable, `chroma=0` contre `chroma=1`, banc complet en mouvement, banc rapide, qualité fixe, 2 lancements ; historique 7b / 7c) :

| Cas | Effet coupé | Effet actif |
|---|---|---|
| Défaut (3 vues) | 6,9 à 7,0 ms | +0,05 à +0,14 ms |
| Gobo + prisme 8 (3 vues) | 12,3 à 18,4 ms | +0,5 à +0,8 ms |
| Zoom 45° + frost 0,6 (3 vues) | 7,2 à 11,1 ms | −0,2 à +0,5 ms (environ +0,2) |
| Sol mouillé + gobo + prisme 8 | 22,0 ms | +3 ms, dont +1,1 ms dans les surfaces (le reflet varie de 0,9 à 2,8 ms d'un lancement à l'autre) |

- Budget restant dans le cas par défaut avec l'effet : environ 1 ms (8,3 − 7,2 ms sans qualité adaptative).
- Effet coupé, rien n'est perdu par rapport à avant (historique 7a, banc normal : −0,5 à +0,3 ms, dans le bruit ; images identiques, PSNR > 69 dB).
- Dans la fumée : non fait. La frange ferait 1 à 3 % de la largeur d'un faisceau, moyennée sur toute sa traversée : invisible. Il faudrait des tables en 3 couleurs : 3 fois le calcul des tables (0,9 à 2,4 ms aujourd'hui) et des lectures plus grosses dans la passe des faisceaux, la plus chère.

| Essai | Résultat (effet actif contre coupé) |
|---|---|
| v0 : 3 lectures du gobo par lyre sans prisme, image en cache RGBA16F, enveloppe des faisceaux élargie de 2 % pour le bleu | défaut +0,1 à +0,2 ms ; prisme +1,5 à +2,2 ; frost +0,4 à +0,8 |
| v1 : enveloppe inchangée (la marge de 0,01 suffit jusqu'à l'intensité 2), flou des 3 couleurs en un seul calcul | prisme encore +1,3 à +2,3 ms : pas de gain mesurable |
| Intensité 0,001 contre 1 (effet actif) | +0,02 à +0,3 ms : les franges elles-mêmes (taches un peu plus larges) ne coûtent presque rien ; c'est le calcul en couleur qui coûte |
| v2 : image en cache aussi pour les lyres sans prisme (2 lectures au lieu de 3 × 2) | lyres douces −0,1 à −0,2 ms ; le reste dans le bruit : gardé |
| v3 : images en cache calculées après le tri et les sondes | neutre : gardé (mesure propre de cette passe) |
| v4 : image en cache recalculée seulement si les réglages de sa lyre changent | défaut et frost : coût de l'effet dans le bruit (au lieu de +0,5 à +1,1 ms) ; prisme +0,4 à +0,5 ms (au lieu de +1,9 à +2,9). Le calcul à chaque image obligeait la carte à attendre que les surfaces de l'image précédente aient fini de lire l'atlas |
| v4, effet coupé, contre avant | prisme +0,45 à +1,0 ms : l'atlas RGBA16F (8 octets par point au lieu de 4) coûte même sans l'effet |
| **v5 : atlas R32F quand l'effet est coupé, RGBA16F créé à la première activation** | **effet coupé : comme avant ; effet actif : voir le tableau ci-dessus. Gardé** |

- Formats essayés pour l'atlas en couleur : `R11G11B10F` (4 octets) est refusé en écriture par `sokol-shdc` ; RGBA8 donnerait des marches visibles dans les dégradés sombres (frost) : RGBA16F gardé.
- Images (vue d'essai `--demo 0..3`, agrandissements des bords) : franges bleues côté extérieur, rouges puis orange côté axe, comme sur les photos ; elles suivent la mise au point, le frost et l'iris.

### Eau au sol : creux, flaques, reflet net (14 octobre 2026)

Nouveau modèle (voir le README) : les creux du béton se remplissent d'abord, puis des flaques de plus en plus grandes, le reste sec jusqu'à 0,45 ; reflet miroir net seulement dans l'eau (les passes de flou et de traînée du reflet sont supprimées).

Mesures (banc rapide, scène immobile, contre la version d'avant ; historique 9a, 9b) :

| Cas | Résultat |
|---|---|
| Sol sec (14 cas) | inchangé : 4 alternances, défaut 7,5 → 7,3 ms, gobo + prisme 8 19,4 → 19,2 ms (dans le bruit) ; images identiques (PSNR > 60 dB) |
| Sol mouillé 0,8 (cas 15 et 16) | surfaces +0,4 et +0,6 ms (lecture des creux et bruit des cuvettes) ; reflet : composition −0,1 ms (flou et traînée supprimés) ; total +0,2 et +0,4 ms |
| Eau à 0,1 (3 cas) | surfaces +0,3 ms (défaut), +0,6 ms (gobo + prisme 8) ; reflet inchangé |

| Essai | Résultat |
|---|---|
| Une seule passe des surfaces, code de l'eau dans un vrai branchement (`[[dont_flatten]]`) | sol SEC plus lent : surfaces +0,25 ms (défaut), jusqu'à +0,9 ms (gobo + prisme), même registres (29) mais 47 instructions de plus : écarté |
| Sans garder la quantité d'eau jusqu'après la boucle des lyres | défaut +0,07 ms : mieux, pas assez |
| **Deux variantes de la passe des surfaces (sol sec sans aucun code d'eau, sol mouillé)** | **sol sec inchangé (907 instructions, contre 1 030 avant, l'ancien code de l'eau en est sorti aussi) : gardé** |
| Creux lus en trilinéaire au lieu d'anisotrope ×4 | aucun gain (surfaces 1,97 → 1,98 ms), image changée (PSNR 49 dB) : écarté (historique 9e) |

#### Reflet calculé seulement dans l'eau (historique 10a à 10c)

Masque de l'eau à la résolution du miroir, puis par blocs de 2 × 2 (voir le README). Banc rapide, scène immobile, contre la version sans masque, 2 lancements :

| Eau | Défaut | Gobo + prisme 8 | Zoom 45° + frost 0,6 |
|---|---|---|---|
| 0,1 | dans le bruit (reflet 0,69 → 0,32 ms) | −1,4 ms (25,1 → 23,7) | **−4,6 ms** (21,7 → 17,0) |
| 0,3 | dans le bruit (reflet 0,69 → 0,50 ms) | −0,6 ms | −2,2 ms (21,4 → 19,3) |
| 1 | dans le bruit | dans le bruit | dans le bruit |

- Images identiques à toutes les quantités d'eau (PSNR > 68 dB, aucun pixel changé de plus de 4/255).
- Le masque coûte environ 0,15 ms (2 passes à la résolution du miroir).
- Reste à faire : les tables des faisceaux du miroir (1,5 à 2,6 ms) sont calculées pour toutes les lyres vues dans le reflet, qu'il y ait beaucoup d'eau ou peu (voir « Pistes d'optimisation futures »).

| Essai | Résultat (eau 0,3) |
|---|---|
| Masque : 1 point de l'écran par pixel du miroir | frost −3,5 ms, mais des creux remplis d'un pixel manqués (points sans reflet, PSNR 52 dB) : écarté |
| + 4 points de l'écran par pixel du miroir, composition qui ignore les pixels du miroir non calculés | images identiques ; frost −1,3 ms seulement : les faisceaux du miroir lisaient la profondeur d'un seul des 4 pixels du miroir qu'ils couvrent |
| + faisceaux du miroir seulement dans les flaques (pas dans les creux) | frost −3,4 ms, mais les creux paraissent plus sombres (sans la lueur des faisceaux reflétés) : écarté |
| **+ masque par blocs de 2 × 2 pixels du miroir (= un pixel des faisceaux)** | **images identiques, frost −2,2 ms (−4,6 ms à 0,1) : gardé** |
- Compter les registres et instructions d'un shader : compiler le HLSL de `sokol-shdc -l hlsl5` avec `fxc /T ps_5_0 /O3 /Fc` (`dcl_temps`, « instruction slots »).

### Sol mouillé : reflet miroir (14 octobre 2026)

Cas 15 et 16 du banc complet (`floor_wet = 0,8`), qualité fixe, en mouvement, 2 lancements :

| Cas | GPU | Tables | Surfaces | Faisceaux | Composition et flou |
|---|---|---|---|---|---|
| Sol mouillé / public (défaut) | 8,6 ms (sec : 7,0) | 0,18 ms | 0,39 ms | 0,27 ms | 0,13 ms |
| Sol mouillé + gobo + prisme 8 / scène | 20,3 ms (sec : 16,3) | 1,15 ms | 0,72 ms | 1,64 ms | 0,13 ms |

S'y ajoutent les cases de lumière de la caméra miroir (environ 0,2 ms) et la composition (+0,2 ms).

| Essai | Résultat |
|---|---|
| Reflet en espace écran (rayon suivi dans l'image) | rien à refléter en regardant vers le bas, marches dans les reflets : remplacé |
| Faisceaux du miroir par échantillons (sans tables) | 12 ms avec gobo + prisme 8 (9 facettes par point) : remplacé par des tables propres au miroir |
| Tables du miroir en pleine finesse, pour toutes les lyres | 4,9 ms (la caméra miroir voit les faisceaux plonger vers elle) : demi-finesse et seulement les cônes visibles, 1,15 ms |
| Traînée du béton humide en 7 lectures espacées | chaque lentille recopiée en échelle de points : flou vertical continu (31 points) dans une passe à quart de résolution |
| Reflet décalé par le relief du béton | paillettes (lecture au hasard du reflet) : retiré, le flou suffit |

### Sol texturé : ce qui a été mesuré

| Version | Surfaces en plus (défaut / gobo + prisme / frost) |
|---|---|
| 2 textures RGBA8 (couleur + occlusion, normale + rugosité), anisotrope ×16 | +0,9 / +1,0 / +1,0 ms |
| 2 textures, anisotrope ×4 | +0,5 / +0,6 / +0,45 ms |
| 2 textures, trilinéaire (×1) | +0,1 / 0 / +0,1 ms, mais sol flou au loin |
| **1 texture (luminance, normale, rugosité), anisotrope ×4 : gardée** | +0,3 / +0,57 / +0,22 ms (mesure rapide) |
| 1 texture, anisotrope ×8 | +0,33 / +0,48 à 0,93 / +0,33 ms |
| 1 texture, anisotrope ×2 | +0,13 / +0,38 / +0,12 ms, mais 8 % de détail en moins de près |

- Image : ×4, ×8 et ×16 sont identiques à l'œil. Écart moyen ×4 contre ×8 : 0,07/255 (au plus 7/255).
- Le matériau du sol est dans un vrai branchement (`[[dont_flatten]]`). Sans cela, le compilateur HLSL peut aplatir le test et lire la texture sur tous les pixels de tous les objets.

## Lasers : banc `--bench-lasers` (14 octobre 2026, étape 1 de `PLAN-LASERS.md`)

Banc séparé de celui des lyres, mêmes règles et même format de sortie (`resultats.txt`, `images.csv`, une image par cas) : `perf_ab.ps1`, `set_ab.ps1`, `compare_bench.py` et `historique.py` s'en servent tels quels.

```bat
rem comparer deux versions sur le banc des lasers
powershell -ExecutionPolicy Bypass -File tools\perf_ab.ps1 -ExeA bench\ref\avant.exe -ExeB LyreViz.exe -Lasers -Fast -Name essai
rem cout d'une option laser seule (meme executable)
powershell -ExecutionPolicy Bypass -File tools\set_ab.ps1 -Lasers -SetA "adaptive=0","laserwidth=0.6" -SetB "adaptive=0","laserwidth=0.8" -Full -Moving -Fast -Name essai
```

- Sans `-Full` : 5 cas (L1 public, L2 public, L3, L4, M1 public). Avec `-Full` : les 14 cas.
- `--cases 1,14` (lancement direct, pas encore dans les scripts) : seulement ces cas, numérotés comme dans le banc complet.
- Cas : L1 éventails 200 × 1 000 traits (3 vues), L2 cônes 200 × 32 segments (2 vues), L3 caméra dans les nappes, L4 200 × 8 traits séparés, L5 nappes en gros plan dans une fumée 4 fois plus dense, L6 traits vers le sol et les obstacles, M1 100 lyres + 100 lasers (3 vues), la scène sans lasers (base de comparaison), puis L7 la programmation de démonstration (depuis l'étape 2).
- Lasers seuls : les lyres sont éteintes (leurs corps restent dessinés).
- Les cas « L1 en coupant chaque option » viendront avec les options (volutes, portées, impacts, éblouissement, flou de mouvement, blanchiment).
- Compteurs ajoutés à chaque cas : boîtiers, segments, traits, temps CPU du moteur laser. Avec `--stats` : tuiles de 16 px touchées, segments par tuile (moyenne, maximum), couples (pixel, segment) calculés.
- Historique : colonnes « Lasers (ms) » (passes laser) et « Banc » (lyres / lasers).

### Choix de la méthode : tuiles en calcul

Les deux versions du prototype calculent le même segment d'éventail (même fonction `laser_eval`) :

- **triangles en addition** (`--set lasermode=0` au moment de la mesure, retirée depuis) : un prisme par segment, ajouté à l'image composée ;
- **tuiles en calcul** (gardée) : tri des segments par tuiles de 128 puis 16 pixels, chaque pixel additionne ses segments dans ses registres et écrit une fois.

Images identiques entre les deux (PSNR 64 à 70 dB, scène immobile), sauf L6 : une nappe horizontale passe à quelques centimètres de la caméra, la caméra est dans le prisme et les triangles ne la dessinent pas (les tuiles la montrent, c'est juste).

Banc complet en mouvement, banc rapide, `adaptive=0`, 2 lancements en alternance (`bench\lasers_methode_*`, historique 11a / 11b) :

| Cas | GPU de l'image, triangles → tuiles | Lasers seuls, triangles → tuiles |
|---|---|---|
| L1 / public | 15,8 → **11,6 ms** | 12,3 → **7,8 ms** |
| L1 / scène | 13,4 → **9,9 ms** | 9,2 → **5,2 ms** |
| L1 / sous les trusses | 13,1 → **11,0 ms** | 8,9 → **6,0 ms** |
| L2 / public | 17,3 → **13,9 ms** | 13,4 → **9,5 ms** |
| L2 / scène | 18,7 → **13,7 ms** | 14,0 → **9,1 ms** |
| L3 caméra dans les nappes | 13,5 → **10,5 ms** | 8,9 → **5,6 ms** |
| L4 8 traits séparés | 14,3 → **11,5 ms** | 9,7 → **7,3 ms** |
| L5 gros plan | 15,2 → **11,3 ms** | 11,2 → **6,4 ms** |
| L6 sol et obstacles | 17,4 → **12,5 ms** | 13,2 → **8,4 ms** |
| M1 / public | 11,4 → **10,8 ms** | 6,0 → **4,4 ms** |
| M1 / scène | 10,7 → **9,1 ms** | 4,4 → **2,7 ms** |
| M1 / sous les trusses | 10,5 → **8,6 ms** | 4,4 → **2,9 ms** |
| Scène sans lasers | 3,7 ms | — |

- Les tuiles gagnent partout : de −16 à −28 % sur l'image, de −25 à −43 % sur les lasers. La composition lit en plus l'image des lasers (+0,18 ms, compris dans le total).
- Pourquoi les triangles ne peuvent pas rattraper : chaque couple (pixel, segment) est mélangé en RGBA16F (environ 16 ps par couple : 2,8 ms pour L1, rien que pour le mélange), et chaque pixel de chaque segment relit la profondeur, recalcule son rayon et relit le segment. Arrêtée juste après le calcul du point P, la version triangles prenait déjà 8,8 ms sur L1, contre 3,7 ms pour les tuiles.
- Banc des lyres inchangé (lasers éteints) : 3 cas immobiles −0,9 %, +0,6 %, +0,9 % ; banc complet en mouvement dans le bruit ; images identiques (PSNR > 62 dB). Historique 11.

Budget à l'étape 1 : L3 5,6 ms, L1 7,8 ms, L2 9,5 ms pour 4,6 ms disponibles ; voir plus bas après l'optimisation.

### Ce qui a été essayé (prototype)

Temps des lasers seuls, banc rapide, 5 cas, 1 lancement par version (L1 / L2 ; v2 et v3 mesurées avec `--stats`, un peu plus lent) :

| Version | Triangles | Tuiles |
|---|---|---|
| v1 : 3 traits voisins calculés exactement (point le plus proche de chaque trait) | 17,6 / 12,5 ms | 16,4 / 45 ms |
| v2 : une seule formule pour traits et nappe (traits voisins approchés près de P), triangles testés contre la profondeur de la scène (faces avant) | 11,3 / 11,7 ms | 12,6 / 31,5 ms |
| v3 : 9 à 12 opérations spéciales par couple au lieu de ~22 ; tuiles : polygone coupé par les parois du hangar et l'écran élargi | 11,2 / 13,8 ms | 8,0 / 9,9 ms |
| v4 : caméra dans le repère de chaque segment (une fois par image, sur le CPU), chemin court pour la nappe lisse et entre deux traits | 11,9 / 12,8 ms | 7,6 / 8,7 ms |
| **v5 : tuiles, 2 pixels par fil (chaque segment lu une fois pour deux pixels) : gardée** | — | 7,3 – 7,6 / 8,0 ms |
| Essai : segments lus dans le tampon (cache) au lieu de la mémoire partagée | — | 9,3 / 11,0 ms : écarté |

- Couples (pixel, segment) sur L1 (`--stats`) : triangles 241 → 175 millions (test de profondeur) ; tuiles 321 → 185 millions (polygone coupé).
- Cônes (L2) en tuiles : un sommet coupé au plan proche (à 5 cm de la caméra, loin hors de l'écran) recevait une marge de ~650 pixels, appliquée à tout le bord : 1 490 millions de couples. Coupé à l'écran élargi de moitié : 244 millions.
- Opérations spéciales (divisions, racines, exponentielles, cosinus) : 4 fois plus lentes que les multiplications sur la GTX 1080, elles pesaient lourd (d'après l'assembleur HLSL, ~22 par couple en v2). Divisions regroupées, diffusion vers l'avant en une racine inverse, arc tangente en polynôme (erreur < 1e-5 rad, 1 % de l'écart de deux traits à 1 000 traits sur 60°).
- Où passe le temps (L1, tuiles v3, fonction arrêtée à différents endroits) : boucle et mémoire partagée 1,9 ms ; point P 1,8 ms ; position du trait (arc tangente, largeurs) 1,5 ms ; somme des traits 2,7 ms ; diffusion et atténuation 0,4 ms.
- Moiré : des traits espacés de 1,5 à 3 pixels, plus fins que le pixel, faisaient un quadrillage. L'ondulation de la nappe s'efface maintenant quand l'écart des traits à l'écran approche 2 pixels (fondu de 4 à 2 pixels), et les traits ne sont calculés un par un qu'à plus de 4 pixels d'écart.

### Optimisation des tuiles (15 octobre 2026)

La version triangles est retirée du code. Mesures contre la version de l'étape 1 (`bench\ref\avant_tuiles.exe`), banc laser rapide, scène immobile, 2 lancements en alternance, sauf mention :

| Essai | Résultat (passe des lasers) |
|---|---|
| Version triangles retirée | dans le bruit (−2,5 à +1 %), images identiques (PSNR > 82 dB) |
| Nappe lisse sans arc tangente ni racines (Q et f comparés au carré, bords par le sinus des angles) | dans le bruit (L1 6,8 → 7,0 ms, L4 6,7 → 7,3 ms), images identiques : gardée (plus simple) |
| Chemin des traits sans racine pour f, bords de la nappe seulement près d'un bord | dans le bruit : gardé |
| Tuiles intérieures v1 : lumière aux 4 coins + contrôle au centre (un fil fait les 5 calculs d'un segment), interpolée | images identiques, mais L1 6,7 → 7,9 ms, L2 8,3 → 12,0 ms : seuls 32 % (L1) des couples sont « intérieurs », et tout le groupe attend le fil qui classe : écartée |
| Tuiles intérieures v2 : un fil par coin, écart des coins ≤ 3 % | 4 % de couples intérieurs (la lumière varie plus de 3 % sur 16 pixels), L1 6,3 → 9,2 ms : écartée |
| 1 pixel par fil (au lieu de 2) | L1 6,7 → 8,0 ms, L2 8,1 → 10,1 ms : écarté |
| 4 pixels par fil | L1 6,7 → 7,3 ms, L2 8,3 → 9,6 ms : écarté |
| 2 pixels par fil dans une boucle non déroulée (un seul exemplaire du calcul) | L1 6,3 → 7,1 ms : écarté |
| **Éventails de 16 traits au plus : un segment par trait ; à l'écran, test de la bande du trait (3 opérations) avant tout calcul** | **L4 7,0 → 1,8 ms (−74 %)**, autres cas inchangés ; image de L4 meilleure (voir plus bas) : **gardé** |
| Même chose, avec le trait seul encore traité aussi dans la fonction de l'éventail | autres cas +8 à +13 % (code présent 4 fois : registres) : corrigé |
| **Moteur CPU : trigonométrie des cônes calculée une fois par cône, portée par rotations** | **cônes 1,5 → 0,8 ms (CPU) : gardé** |

- Ce que montrent ces essais : la passe est limitée par le calcul, et par le nombre de registres. Retirer 15 opérations sur ~150 ne se voit pas ; ajouter un chemin de code, même jamais exécuté, ralentit tout (moins de groupes actifs). Mesuré : sans le chemin des traits dans le shader, L1 passe de 6,9 à 5,6 ms.
- Répartition des couples qui passent les premiers tests (carte d'essai, L1 / L3 / M1 / L4 / L2) : 60 / 51 / 55 / 100 / 27 % en traits séparés ou en ondulation. C'est physiquement juste : un éventail de 1 000 traits vu de près montre ses traits un par un.
- Où passe le temps (L1, après ces essais, fonction arrêtée à différents endroits) : boucle 1,2 ms ; test de profondeur 0,7 ms ; point P et bords 1,1 ms ; largeurs, Q et f 1,6 ms ; somme des traits 3 ms ; diffusion et atténuation ~0 ms.
- Image de L4 : avant, les 8 traits d'un éventail étaient calculés par la formule de l'éventail ; près de la source, ses coupures nettes faisaient des pointes en coin. Calculés un par un (point le plus proche de chaque trait), ils se rejoignent proprement (PSNR 40 dB contre l'ancienne image : c'est la correction).

Banc complet en mouvement, banc rapide, 2 lancements (`bench\lasers_opt_complet_*`, historique 12), étape 1 → maintenant :

| Cas | Lasers seuls | Image (GPU) |
|---|---|---|
| L1 / public, scène, sous les trusses | 7,8 / 5,3 / 5,7 → **7,6 / 5,2 / 6,4 ms** (dans le bruit) | 11,6 / 10,0 / 10,8 → **11,4 / 9,6 / 10,3 ms** |
| L2 / public, scène | 9,4 / 9,3 → **8,6 / 8,5 ms** | 13,0 / 13,2 → **12,2 / 12,2 ms** |
| L3 caméra dans les nappes | 5,6 → **5,2 ms** | 10,4 → **9,7 ms** |
| L4 8 traits séparés | 7,5 → **1,2 ms** | 11,5 → **5,5 ms** |
| L5 gros plan | 6,3 → **6,0 ms** | 10,9 → **10,1 ms** |
| L6 sol et obstacles | 8,3 → **8,3 ms** | 11,9 → **12,0 ms** |
| M1 / public, scène, sous les trusses | 3,9 / 2,7 / 2,8 → **4,0 / 2,7 / 3,0 ms** (dans le bruit) | 10,3 / 8,2 / 8,3 → **10,2 / 8,1 / 8,1 ms** |

- Banc des lyres inchangé (0,0 %, +0,9 %, −0,4 %, images identiques).
- Ce sont les valeurs de référence actuelles des lasers.

**Budget.** La scène sans lasers prend 3,4 à 3,8 ms : il reste ~4,6 ms pour les lasers seuls. L4 (1,2 ms) tient largement ; L3 (5,2 ms) est proche ; L1 (5,2 à 7,6 ms selon la vue) et L2 (8,5 ms) le dépassent encore. Le mix M1 est à 8,1 – 10,2 ms (cible 8,3 ms).

### Étape 2 : moteur et panneau (15 octobre 2026)

Moteur des lasers (programmeur, formes, dégradés, diffraction, effets, galvos), onglet Lasers, corps des boîtiers, vues `--demo-laser`. Mesures contre la version d'avant l'étape 2 (`bench\ref\avant_etape2.exe`), banc laser rapide, 2 lancements en alternance.

**Dégradés dans le shader** (couleur différente aux deux bords d'un segment, interpolée), scène immobile, 5 cas, passe des lasers :

| Version | L1 | L2 | L3 | L4 | M1 |
|---|---|---|---|---|---|
| v1 : couleur des deux bords dans le même shader (6 vec4 par segment) | 6,71 → 7,00 | 8,09 → 8,82 | 6,16 → 6,42 | 1,15 → 1,24 | 3,48 → 3,72 |
| v2 : interpolation allégée | 6,81 → 6,76 | 8,20 → 8,68 | 6,04 → 6,39 | 1,09 → 1,22 | 3,48 → 3,62 |
| **v3 : deux variantes du shader (avec et sans dégradé), choisie à chaque image : gardée** | **6,49 → 6,46** | **8,23 → 8,22** | **5,69 → 5,68** | **1,22 → 1,22** | **3,49 → 3,49** |

- v1 et v2 coûtaient de 0 à 9 % même sans aucun dégradé (registres, comme pour les traits seuls). Avec deux variantes, une programmation sans dégradé ne paie rien ; la variante avec dégradé lit 6 vec4 par segment au lieu de 5.
- Le coût par couple (pixel, segment) est le même dans les deux variantes : ~40 ps (L1 : 7,6 ms pour 185 millions ; L7 : 14,1 ms pour 349 millions).

**Banc complet en mouvement** (`bench\e2_complet_*`, historique 13), passe des lasers, avant → après :

| Cas | Lasers seuls | Image (GPU) |
|---|---|---|
| L1 / public, scène, sous les trusses | 7,47 / 4,85 / 5,71 → 7,82 / 4,94 / 5,73 ms | 11,4 / 9,5 / 10,6 → 11,8 / 9,4 / 10,5 ms |
| L2 / public, scène | 7,89 / 8,12 → 8,16 / 8,31 ms | 12,4 / 12,6 → 12,5 / 13,0 ms |
| L3 caméra dans les nappes | 5,28 → 5,36 ms | 9,9 → 10,3 ms |
| L4 8 traits séparés | 1,23 → 1,23 ms | 5,9 → 5,5 ms |
| L5 gros plan | 5,97 → 5,90 ms | 10,8 → 11,1 ms |
| L6 sol et obstacles | 8,06 → 8,32 ms | 12,4 → 12,1 ms |
| M1 / public, scène, sous les trusses | 4,23 / 2,65 / 2,93 → 4,19 / 2,67 / 2,95 ms | 10,6 / 8,6 / 8,4 → 11,0 / 8,5 / 8,7 ms |
| **L7 programmeur (nouveau)** | **15,4 ms** | **19,8 ms (48 img/s)** |

- L1 à L6 et M1 : dans le bruit (de −1 à +5 % selon le cas et le lancement ; scène immobile, 0 %). Les motifs d'essai sont calculés comme avant ; les images diffèrent seulement par les corps des boîtiers, maintenant dessinés (PSNR 48 à 57 dB, écarts au-dessus de 4/255 sur 0,01 à 0,3 % des pixels).
- Moteur CPU (sans effet sur l'image : le GPU limite) : 0,05 → 0,07 ms sur L1, 0,85 → 0,95 ms sur les cônes de L2 (parcours du programmeur ajouté) ; 0,7 ms sur L7 (194 boîtiers, 4 580 segments).

**L7 : la programmation de démonstration** (`program_showcase`, vue du public) : toutes les formes, dégradés et effets à la fois sur 194 lasers. 349 millions de couples (pixel, segment), 42 segments par tuile en moyenne, contre 185 millions sur L1. Coût de chaque groupe seul (`bench\essai_grp_*`, banc rapide, 1 lancement) :

| Groupe | Figure | Segments | Couples | Passe des lasers |
|---|---|---|---|---|
| trusses 1 (42) | éventails 1 000 traits, arc-en-ciel qui défile, rotation | 504 | 15,6 M | 0,83 ms |
| trusses 2 (42) | cônes 600 traits, 3 couleurs, cercle | 1 344 | 78,9 M | 3,74 ms |
| trusses 3 (42) | doubles éventails 400 traits, 2 couleurs | 252 | 103,3 M | 5,56 ms |
| trusses 4 (42) | vagues 500 traits, chenillard de traits | 1 008 | 29,6 M | 1,33 ms |
| pont (16) | grilles 5 × 5, diffraction ×3 | 1 200 | 52,3 M | 1,54 ms |
| sol de scène (8) | tunnels 800 traits, 2 couleurs | 256 | 70,4 M | 3,84 ms |
| nez de scène (2 allumés sur 8) | 8 traits au hasard | 16 | 1,4 M | 0,46 ms |

- Le coût suit la surface couverte à l'écran, pas le nombre de segments ni les dégradés : les trusses 3 et 4 sont juste au-dessus du public, leurs nappes descendent sur la caméra ; les 8 tunnels du sol de scène visent le public et couvrent chacun une grande partie de l'image (4 nappes par pixel : avant et arrière des deux cônes).
- Découper une figure en morceaux (dégradés, cônes) coûte peu : les morceaux ne se recouvrent pas, seules les tuiles de leurs bords les comptent deux fois.
- L7 dépasse largement le budget (15,4 ms pour ~4,6 ms) : c'est un cas extrême (presque tous les lasers allumés, figures larges braquées vers la caméra), gardé comme repère. Les pistes ci-dessous valent aussi pour lui.

- Banc des lyres (lasers éteints, `bench\e2_lyres_*`) : images identiques (PSNR 75 à 114 dB, aucun pixel au-dessus de 4/255), temps dans le bruit (−4,9 à +7,3 % selon le cas, passes identiques). Historique 13.
- Les valeurs de référence des lasers restent celles du tableau précédent (« Optimisation des tuiles »), plus L7.

### Pistes pour la suite (sans dégrader l'image)

1. Profondeur maximale par tuile : ignorer les segments entièrement derrière les surfaces de la tuile (peu de gain attendu dans les cas du banc, plus dans une vraie scène).
2. Cônes (L2) : test par pixel des deux grands bords du segment à l'écran (comme la bande des traits seuls) avant le calcul ; ~44 % des couples de L2 sont rejetés après 25 à 60 opérations.
3. Registres : alléger le chemin des traits (moins de variables vivantes), puisque sa seule présence coûte ~1,3 ms sur L1.
4. **L7 à alléger plus tard** (décision de l'utilisateur, 15 octobre 2026 : on continue d'abord le plan) : 15,4 ms de lasers seuls, dû à la surface couverte (doubles éventails des trusses 3, tunnels du sol de scène). Pistes : profondeur maximale par tuile, rejet plus tôt des pixels hors des bords (cônes, tunnels), moins de morceaux pour les cônes de petite ouverture ; mesurer chaque groupe avec `--cases 14` (voir « Étape 2 »).
5. Si les cibles L1 / L2 restent hors d'atteinte : décider avec l'utilisateur (par exemple, une qualité adaptative qui baisse la largeur minimale des traits au loin) ; aucune dégradation sans son accord.

## Ce qui coûte cher (à garder en tête)

- **Dessin des cônes de fumée.**
  - Chaque pixel couvert par un faisceau est calculé puis additionné : jusqu'à 25 millions par image avec des faisceaux larges.
  - L'addition (mélange) se fait dans un tampon RGBA16F : en 32 bits, elle était deux fois plus lente pour la même image.
- **Lectures mémoire dans les boucles par lyre.**
  - Agrandir `sb_light` de 96 à 112 octets a ralenti, même en supprimant des calculs.
  - Préférer recalculer (sin, cos, produit vectoriel) plutôt que stocker.
- **Boucles avec des lectures de texture.**
  - Toujours `textureLod`, jamais `texture`. Sinon le compilateur HLSL déroule la boucle : 25 s de compilation, puis échec sous Direct3D 11.
  - Une boucle avec `continue` autour d'une lecture de texture empêche les lectures de partir ensemble.
- **Basse résolution :** à n'utiliser que pour ce qui est vraiment flou.
  - La lumière indirecte de la brume calculée à 1/4 a rendu la brume tachée : annulé.
  - Les faisceaux très doux (frost) et les lyres très douces sur les surfaces, eux, passent à 1/2 ou 1/4 sans différence visible.

## Pistes d'optimisation futures (pas encore essayées)

### Tables des faisceaux du miroir : seulement pour les lyres reflétées dans l'eau

- **Constat** (14 octobre 2026, historique 10a à 10c) : depuis que le reflet n'est calculé que dans l'eau, les surfaces et les faisceaux du miroir coûtent 2 à 3 fois moins à 10 % d'eau. Les tables des faisceaux du miroir, elles, sont toujours calculées pour toutes les lyres dont le cône est visible dans le reflet : 1,5 à 2,6 ms avec gobo + prisme 8 ou zoom 45° + frost, autant à 10 % d'eau qu'à 100 %. C'est maintenant la plus grosse part du reflet quand il y a peu d'eau.
- **Idée** : ne calculer la table (et ne dessiner le cône) d'une lyre dans le miroir que si son reflet tombe sur de l'eau visible à l'écran.
  - Sur le CPU, le modèle de l'eau existe déjà (`puddle_height`, `FloorTexture::water_levels`) : pour chaque lyre visible dans le reflet, tester quelques points du sol où son cône reflété peut apparaître à l'écran (rectangle d'écran du cône reflété, intersecté avec le sol visible), et la sauter si aucun n'est dans une flaque.
  - Les creux remplis sont partout (de près) dès 0,1 : la piste ne vaut que pour les flaques ; garder une marge, et toujours calculer quand les creux remplis couvrent une part notable du sol proche.
  - Variante sans CPU : réduire le masque de l'eau (`refl_beam_mask`) à une grille grossière lue par le calcul des tables, qui s'arrêterait pour les lignes dont le plan épipolaire ne traverse aucune case mouillée.
- **À vérifier** : image identique dans l'eau (vue public et `--demo 5`, à 0,1, 0,3 et 1) ; gain attendu de l'ordre de 1 à 2 ms à 0,1 avec gobo + prisme ou frost, rien à 1.

## Essais écartés (mesurés, pas gardés)

| Essai | Résultat |
|---|---|
| Données des lyres précalculées sur le CPU (struct plus grande) | 2 à 5 % plus lent |
| Boucle analytique sans branchement | plus lent (prisme : +15 %) |
| Latence du pilote portée à 3 images | plus lent (+0,6 ms) |
| Test de profondeur sur les cônes de fumée | −0,3 à −0,6 ms dans les cas lourds, +0,5 ms par défaut |
| Tuiles de 16 px pour le tri des faisceaux (avant les cônes) | aucun gain |
| Qualité adaptative descendant à 20 % | image trop dégradée : plancher remis à 80 % |
| Sol texturé en 2 textures (occlusion ambiante comprise) | 2 fois plus de lectures anisotropes : +0,9 ms en ×16 ; occlusion abandonnée |
