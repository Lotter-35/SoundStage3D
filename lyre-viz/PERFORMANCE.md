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
- `--cases 1,14` : seulement ces cas, numérotés comme dans le banc complet ; dans `perf_ab.ps1` : `-Cases "4,14,17,22"` (implique tous les cas, ignore `-Full`).
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
- C'étaient les valeurs de référence des lasers jusqu'à l'étape 3 (fumée uniforme) ; voir « Étape 3 : fumée » pour les valeurs actuelles.

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

### Étape 3 : fumée (15 octobre 2026)

Fumée de la pièce, diffusion vers l'avant à deux lobes, volutes fines (README, « Lasers dans la fumée »). Mesures contre la version d'avant l'étape 3 (`bench\ref\avant_etape3.exe`), banc laser rapide, ou même exécutable avec l'option coupée puis active (`set_ab.ps1`). Passe des lasers en ms ; L1, L2 : vue public. Les temps de cette session variaient beaucoup d'un lancement à l'autre (jusqu'à ±15 %) : seuls les écarts répétés à chaque lancement sont retenus.

**Ce qu'a appris cette étape : la passe des lasers est limitée par le calcul et les registres, et par l'attente des lectures de texture.**

- Le code ajouté coûte même coupé par un réglage : tout coupé, la passe restait 6 à 15 % plus lente qu'avant. Les mesures « coupé contre actif » avec le même exécutable sous-estimaient donc le coût (2 lobes : « 0 » ainsi, +13 % en réalité). D'où des **variantes du shader** (0 à 3), comme pour les dégradés ; tout coupé, la variante 0 est le code d'avant (images identiques, PSNR > 82 dB, temps dans le bruit).
- Écrire les deux lobes en `vec2` faisait prendre 6 registres de plus au compilateur HLSL (DXBC : 24 → 30) ; en scalaires, aucun.
- Une lecture de texture dont le résultat sert dans la même itération coûte surtout son attente (peu de groupes actifs pour la masquer) : lancer les lectures tôt dans le calcul du segment, et ne pas faire dépendre une lecture d'une autre.
- **Envoyer une texture à chaque image sous Direct3D 11** (`sg_write_image_transient` : `UpdateSubresource`) peut faire attendre la carte : +1 à +2,7 ms par image en moyenne (pics dans « scene (surfaces) », la médiane ne bouge pas), même avec 3 textures en rotation. La texture des amas des lyres, elle, ne le fait pas : la densité des lasers a été mise dans son 2e canal (RG8).
- La réserve de shaders de sokol est de 32 par défaut : au-delà, les derniers ne sont pas créés, sans message en version normale (la passe des lasers donnait 0 ms). Portée à 64 (`main.cpp`).

Fumée de la pièce (modification 14) :

| Version | Passe des lasers L1 / L2 / L3 / L4 / M1 |
|---|---|
| v1 : `fog_density` des lyres au point P (amas + détail « coton » : 2 lectures 3D, exponentielle) | +1,3 / +2,1 / +1,4 / +0,2 / +0,6 ms |
| v2 : la même, lue plus tôt | dans le bruit contre v1 |
| v3 : texture préparée sur le CPU (diffusion par mètre, R16F, 64 × 24 × 32), une lecture | passe ~0, mais attente de l'envoi : « scene (surfaces) » +1,3 à +2,7 ms en moyenne |
| v4 : 3 textures en rotation | +0,2 / +0,8 / +0,6 / +0,1 / +0,7 ms en scène immobile ; les pics reviennent en mouvement (+1 à +1,3 ms) |
| v5 : lecture directe de la texture des amas, brume et hauteur calculées dans le shader | aucun pic, mais passe +3 à +10 % (exponentielle, division ; +0,25 à +1,1 ms même avec un polynôme) |
| **v6 : densité préparée sur le CPU dans le 2e canal de la texture des amas (RG8), une lecture, 2 opérations** | **aucun pic ; au niveau de v4 sans ses pics : gardée.** Banc des lyres inchangé, images identiques (PSNR 61 à 105 dB) |

Diffusion vers l'avant (modification 15) : coupé contre actif dans le bruit (−0,3 à +0,2 ms), mais la présence du code coûtait +1,0 / +1,3 / +1,0 / 0 / +0,8 ms (branchement, `vec2`) : corrigé par les variantes et l'écriture en scalaires.

Volutes fines (modifications 16 et 17) ; « coût seul » avec le code présent des deux côtés, sauf la dernière ligne :

| Version | Passe des lasers L1 / L2 / L3 / L4 / M1 |
|---|---|
| 128³ RGBA8, 4 instants, 1,25 cm par texel | +5,7 / +7,7 / +5,1 / +1,1 / +2,6 ms (L7 +10,4) |
| même lecture forcée dans un niveau de 4³ | revient au niveau sans volutes : c'est la mémoire et l'attente, pas le calcul |
| 128³ BC5, 2 instants | +2,8 / +4,1 / +2,5 / +0,8 / +1,5 ms |
| 64³ BC5 (motif de 0,8 m) | +2,0 / +3,0 / +1,7 / +0,3 / +1,05 ms |
| lectures lancées un segment à l'avance | pire : lit aussi pour les couples rejetés (L4 sans volutes +0,75 ms) |
| lectures indépendantes, lancées tôt | +1,35 / +1,6 / +1,45 / +0,07 / +0,67 ms |
| **motif de 1,6 m (texels de 2,5 cm) : niveaux plus petits lus** | **+0,8 / +1,2 / +0,65 / +0,04 / +0,4 ms : gardé** |
| BC4 (1 canal, 0,5 octet par texel) | −2 à −4 % seulement : BC5 gardé (il porte l'évolution) |
| 2e octave (0,44 m), lue quand un pixel couvre moins de 2 texels | +0,3 à +0,7 / +1,0 à +1,3 / +0,7 ms ; L5 +1,1, L7 +2,2 ; invisible à la distance de L1 et L5 |
| **2e octave lue quand un pixel couvre moins de 3,5 mm (à moins de ~7 m)** | **0 à +0,5 / +0,85 / +0,6 ms ; L5 +0,95, L7 +1,7 : gardée, dans sa propre variante** |
| rotation de la 2e octave remplacée par une permutation (3 opérations au lieu de 9), normalisation sans racine | dans le bruit : gardé (plus simple) |
| **variantes séparées, niveau 3 (volutes et 2e octave) contre niveau 1, banc complet** | **L1 +1,3 à +1,8, L2 +3,2, L3 +2,3, L4 +0,24, L5 +2,2, L6 +2,8, M1 +0,7 à +1,2, L7 +4,8 ms (+25 à +35 %)** |

- Niveau 1 (fumée de la pièce + 2 lobes) contre niveau 0 : +0,6 / +1,5 / +0,6 / +0,1 / +0,6 ms (+8 à +14 %).
- Contraste des volutes par niveau de mip : 0,170 / 0,165 / 0,155 / 0,134 / 0,102 / 0,059 / 0 (en-tête de `resultats.txt` du banc des lasers) : les grosses structures restent visibles jusqu'au niveau 4, on ne peut pas arrêter de lire plus tôt.
- Génération au lancement : 0,3 s (12 fils).

**Banc complet en mouvement, avant → après l'étape 3** (réglages par défaut, tout actif ; `bench\e3_complet_*`, historique 19) :

| Cas | Lasers seuls | Image (GPU) |
|---|---|---|
| L1 / public, scène, sous les trusses | 7,29 / 4,80 / 5,26 → **10,19 / 7,07 / 7,25 ms** | 11,0 / 8,2 / 9,4 → 14,4 / 11,1 / 11,0 ms |
| L2 / public, scène | 7,56 / 7,79 → **11,92 / 12,14 ms** | 11,5 / 12,3 → 15,9 / 16,1 ms |
| L3 caméra dans les nappes | 5,01 → **7,05 ms** | 8,6 → 11,1 ms |
| L4 8 traits séparés | 1,22 → **1,52 ms** | 5,2 → 5,1 ms |
| L5 gros plan | 5,56 → **8,08 ms** | 10,1 → 12,0 ms |
| L6 sol et obstacles | 7,57 → **10,80 ms** | 11,1 → 15,0 ms |
| M1 / public, scène, sous les trusses | 3,97 / 2,64 / 2,86 → **5,31 / 3,65 / 3,92 ms** | 10,3 / 7,5 / 7,6 → 11,0 / 9,4 / 9,2 ms |
| L7 programmeur | 13,71 → **20,59 ms** | 18,7 → 24,5 ms |

- Ce sont les nouvelles valeurs de référence des lasers (réglages par défaut). Sans les volutes (`volutes=0`), environ 25 % de moins sur la passe des lasers.
- Banc des lyres (lasers éteints, 16 cas, `bench\e3_lyres_rg8_*`) : images identiques (PSNR 61 à 105 dB, aucun pixel au-dessus de 4/255 sauf 0,05 % sur un cas), temps dans le bruit. Les deux cas « sol mouillé » paraissaient +13 et +18 % : la passe « reflet : tables » vaut tantôt 0,85 ms, tantôt 2,1 à 2,3 ms, **avec n'importe quel exécutable** (même celui d'avant l'étape 3) : comportement de la carte, pas une régression.

### Fichiers ILDA (15 octobre 2026)

Lecture ILDA, réduction en faisceaux et nappes (README, « Lasers : fichiers ILDA »), mode ligne. Banc complet en mouvement, banc rapide (`bench\ilda_final_*`, historique 20) : les cas L1 à L7 et M1 sont ceux de l'étape 3, à ±2 % (aucun changement de leur rendu) ; banc des lyres inchangé (+0,4 / +0,4 / +2,4 %, images identiques).

| Cas (200 lasers, vue public) | Primitives | Lasers seuls | Image (GPU) |
|---|---|---|---|
| I1 banque Nappes | 825 faisceaux, 11 825 nappes | 31,2 à 32,3 ms | 36 à 37 ms |
| I2 banque Faisceaux | 2 000 faisceaux | 1,9 ms | 5,6 à 5,7 ms |
| I3 banque Géométrie | 1 080 faisceaux, 12 660 nappes (tolérance 3) | 47,8 à 49,4 ms | 53 à 55 ms |
| I4 banque Tunnels | 1 883 faisceaux, 12 368 nappes | 32,7 à 33,7 ms | 38 à 39 ms |
| L1 en mode ligne (200 nappes continues) | 200 segments | 8,4 à 8,9 ms (L1 : 10,1) | 12,7 à 13,5 ms |

- Le coût est celui de la surface couverte : I3 fait environ 1 milliard de couples (pixel, segment), 4 fois L2. Chaque figure de 40° se découpe en dizaines de nappes planes qui partent toutes de la sortie : près de la source, une tuile contient toutes les nappes de la figure. Lecture des fichiers et moteur CPU : 1,2 à 2,3 ms.
- Moteur CPU : une réduction par image du fichier, en cache (200 lasers sur un même fichier : une seule).

| Essai | Résultat |
|---|---|
| Plafond de 8 192 segments | I1, I3, I4 tronqués sans bruit (I3 : 12 660 nappes voulues), d'où des temps trop flatteurs (17 à 23 ms) : plafond porté à 16 384, compteur des segments perdus dans le tri (`--stats`) : 0 partout |
| Variante du shader « nappes et traits seuls » (sans le calcul des traits séparés ni de leur ondulation, choisie quand aucune figure n'en a besoin) | images identiques, temps à ±2 % sur les 19 cas (historique 20a) : **retirée** (8 shaders de moins). Le −20 % mesuré à l'étape 1 sans ce chemin ne se retrouve pas avec le code de la fumée de l'étape 3 |
| Mode ligne contre 1 000 traits (L1) | −15 % : le gain vient de l'image (nappe lisse calculée partout au lieu des traits séparés), pas d'une variante |

- Piège : le nettoyage des bancs ne garde que les exécutables `bench\ref\avant*.exe` : nommer ainsi toute référence à garder.

### Étape 5 : collisions et impacts (15 octobre 2026)

Historique 21 et 22 (banc rapide, immobile, 19 cas).

- **Collisions** (`--set lasercoll=0/1`, case de l'onglet Lasers) : les traits s'arrêtent sur les pavés du décor, des mannequins et du personnage ; les nappes y sont coupées exactement (trou d'ombre à bord net). Calcul sur le CPU, à la construction des segments : coût GPU dans le bruit.
- **Impacts sur les surfaces** (`--set laserimpacts=0/1`, case de l'onglet Rendu) : passe « lasers : impacts », lignes et points là où les lasers touchent sol, murs, plafond et obstacles. Coût (image, GPU) : +0,5 à +2 ms sur L1 à L6, +2,8 ms sur L7, +5 à +6 ms sur les fichiers ILDA chargés (I1, I3, I4).
- **Traits au sol continus au loin** (toujours actif, choix de l'utilisateur) : la largeur minimale des impacts (0,6 pixel de sigma) est comptée à l'écran sur la surface touchée, énergie conservée, et non plus en travers du faisceau ; vu en rasant, un trait au sol plus fin qu'un pixel devenait des pointillés qui scintillent. Seulement en travers des lignes (les points d'un motif restent séparés). Coût de la passe « lasers : impacts » (banc rapide, immobile, `adaptive=0`) : L7 0,27 → 0,46 ms, I3 1,76 → 2,50 ms, P3 2,03 → 2,82 ms ; image entière dans le bruit. Historique 50.

### Nappes coniques exactes (cônes, tunnels) (15 octobre 2026)

À la demande de l'utilisateur : plus de cercles faits de traits droits. Un cône est une nappe conique exacte (`laser_arc`), en morceaux de 90° au plus ; ses impacts sont des arcs exacts. Historique 23. Banc rapide, immobile, 2 lancements chacun, contre `bench\ref\avant_etape6.exe` (cônes en 32 nappes planes ; `bench\arcs4_*`, lyres `bench\arcs4ly_*`) :

| Cas | Avant (polygones) | Nappes coniques | Note |
|---|---|---|---|
| L2 cônes / public | 18,4 ms | 19,3 ms | première version des arcs : +7,7 ms sur la passe |
| L2 cônes / scène | 18,6 ms | 19,4 ms | |
| L7 programmeur | 24,8 ms | 28,3 ms | passe des arcs 10,2 ms + reste 10,1 ms |
| autres cas L, M1, I | | dans le bruit (±3 %) | images identiques |
| banc des lyres | | −3,9 / +0,8 / −1,5 % | images identiques |

Ce qui a été fait, dans l'ordre :

1. **Silhouettes en escalier** : au bord d'un cône vu de côté, le rayon frôle la nappe sans la couper ; le calcul rendait 0 là où la nappe est la plus brillante. Ajout du rayon qui frôle (point le plus proche, poids gaussien selon l'écart à la nappe) et de la corde d'une nappe courbe vue par la tranche (comme la corde des nappes planes). Bord lisse ; le code, minimal (un appel de plus coûtait 4 ms), coûte 0,7 ms sur L2.
2. **Enveloppe à l'écran** (la vraie cause du surcoût) : la pyramide d'un morceau d'arc était coupée par le plan proche (5 cm), sans les bords de l'écran ; ces points, loin hors de l'écran, avaient des marges de centaines de pixels, appliquées à des bords entiers. L'enveloppe est maintenant coupée à l'écran élargi de moitié, comme les segments droits, avec la profondeur exacte des nouveaux sommets : L2 de 413 à 145 millions de couples, image identique.
3. **Base de la pyramide sur la paroi** quand ses 6 coins sortent du hangar par la même paroi : 165 → 145 millions de couples (−0,5 ms).
4. **Passe des arcs à part** (variantes `_a`, image `lasers-arcs` ajoutée par la passe principale) : le calcul des arcs gardait des registres pour toute la boucle (37 registres contre 27) et ralentissait aussi les éventails : L7 23,5 → 21,9 ms ; puis un pixel par fil dans cette passe (−0,6 ms sur L2).
5. **L'autre côté du cône** : chaque morceau voit tout le cône ; une intersection à plus de 90° du milieu du morceau (et à plus de 4 épaisseurs de nappe, pour garder la pointe près de la source) est rejetée avant le long calcul (−0,5 à −1 ms).

| Essai écarté | Résultat |
|---|---|
| Morceaux de 45° ou 22,5° au lieu de 90° | plus de couples (165 et 1 071 millions) : la marge près de la caméra dominait, puis le nombre de morceaux |
| Rejet angulaire avec une marge fixe de 4 sigma | image changée (coutures entre morceaux) ; avec la bonne marge, aucun gain |
| Seuil du rayon qui frôle à 1 sigma | aucun gain : le coût est par couple (code ajouté), pas par évaluation |
| Biarcs (arcs raccordés) pour la vague et les nappes ILDA, une paire d'arcs par corde | trop cher : passe des arcs 35 à 45 ms sur I1 à I4, moteur CPU 64 à 116 ms (arcs à l'ombre redécoupés tous les 1°), I3 au plafond de 16 384 segments ; L7 +5 ms. Retiré : remplacé par le moteur de tracé (`PLAN-LASERS.md`, étape 9) |

Pointe des cônes : quelques pixels changent d'un lancement à l'autre (déjà dans la référence, image crénelée sur 1 à 2 pixels) ; certaines programmations ont deux états d'image possibles d'un lancement à l'autre (0,02 % des pixels), quel que soit l'exécutable.

### Étape 9 : moteur de tracé (15 octobre 2026)

`PLAN-LASERS.md`, « Étape 9 » ; historique 24 (lasers et lyres). Fichiers ILDA, dessins, sinus et formes du programmeur passent par le moteur de tracé (`src/trace.cpp`) : miroirs avec inertie, faisceaux, droites et arcs de cercle raccordés ; arcs à l'ombre arrêtés sur le plan de la face du pavé (shader) ; moteur CPU sur tous les cœurs, cache des figures fixes.

Banc complet en mouvement, banc rapide, 2 lancements chacun, contre `bench\ref\avant_etape9.exe` (`bench\e9_las_*`, lyres `bench\e9_ly_*`), image entière (GPU) :

| Cas | Avant | Étape 9 | Note |
|---|---|---|---|
| L1, L3 à L6, M1, L1 en mode ligne | | dans le bruit (−7 à +1 %) | images identiques |
| L2 cônes (public, scène) | 18,8 / 19,2 ms | 19,6 / 19,5 ms | +2 à +4 % ; ombres des cônes arrêtées sur les faces (0,1 à 0,3 % des pixels) |
| L7 programmeur | 32,9 ms | 34,2 ms | +4 % : vague, double éventail, grille et formes en droites et arcs exacts |
| I1 nappes | 42,7 ms | 46,9 ms | +10 % : arcs au lieu de polygones |
| I2 faisceaux | 7,4 ms | 6,7 ms | −10 % |
| I3 géométrie | 58,7 ms | 91,6 ms | +56 % : passe des arcs 72 ms |
| I4 tunnels | 44,6 ms | 48,6 ms | +9 % |
| P1 dessins à main levée | (nouveau) | 99 ms | passe des arcs 82 ms, 11 400 arcs |
| P2 formes | (nouveau) | 45 ms | passe des arcs 31 ms |
| P3 sinus, Lissajous | (nouveau) | 92 ms | passe des arcs 81 ms, 8 400 arcs |
| banc des lyres | | images identiques | temps dans le bruit (1er lancement de la référence perturbé) |

**Moteur CPU** (moyenne par image) :

| Cas | Avant (un cœur) | Plusieurs cœurs | + cache des figures fixes (immobile) | En mouvement (cache actif) |
|---|---|---|---|---|
| L7 | 3,4 ms | 1,7 ms | 0,4 ms | 1,4 ms |
| I1 | 7,2 ms (9,1 au début de l'étape 9) | 1,8 ms | 0,5 ms | 1,3 ms |
| I3 | 9,1 ms (14,6) | 2,7 ms | 0,7 ms | 2,6 ms |
| P1 | (24,4) | 4,1 ms | 1,0 ms | 1,0 ms |
| P3 | (18,5) | 3,1 ms | 0,7 ms | 2,2 ms |

- Plusieurs cœurs : un laser par tâche (12 fils sur le i7-5820K, 6 cœurs), morceaux puis impacts mis bout à bout dans l'ordre : images identiques (0 % de pixels changés). Une allocation mémoire par arc retirée (freinait les fils).
- Cache (`--set lasercache=0` pour couper, case de l'onglet Rendu) : clé = toutes les entrées de la figure (position, angles des galvos, couleurs, forme, image ILDA, puissance), et hangar et obstacles pour tout le cache (le personnage qui bouge invalide tout).
- Ligne « Lasers » du banc : `moteur CPU x ms (morceaux a, impacts b)`.

**Passe des arcs : où va le temps** (diagnostics, cas L2, L7, I3, P3, immobile, passe des arcs) :

| Essai (non gardé) | L2 | L7 | I3 | P3 |
|---|---|---|---|---|
| version de l'étape 9 | 14,0 ms | 15,2 ms | 62,2 ms | 75,9 ms |
| sans le calcul d'un point de nappe (`laser_arc_at`) : racines, boucle, lectures | 5,0 | 5,1 | 21,1 | 25,9 |
| sans fumée ni volutes dans les arcs | 11,7 | 13,4 | 54,5 | 66,5 |
| une seule intersection par couple (image fausse) | 7,9 | 7,6 | 32,5 | 40,2 |

- Comptage (P3, `--stats`) : 809 millions de couples (pixel, morceau), 867 millions d'intersections calculées en entier, **589 millions qui éclairent vraiment (73 %)**, deux intersections éclairées pour un même couple dans 0,4 % des cas. Le travail est presque entièrement utile : 70 nappes traversées par pixel en moyenne (200 figures de ±40° vues du public).
- **Un point de nappe conique coûte environ 2 fois un point de nappe plane** : ≈ 95 ps contre ≈ 45 ps (référence : I1 31,5 ms pour 698 millions de couples, I3 45,4 ms pour 977 millions). En plus : les racines (équation du 2e degré), l'angle le long de l'arc (arc tangente), la normale, la limite de courbure, la vitesse angulaire.
- Les arcs couvrent moins de couples que les polygones (I1 : 506 contre 698 millions ; I3 : 845 contre 977), mais chacun coûte le double.

| Essai d'allègement (exact) | Résultat |
|---|---|
| Rejet de l'intersection hors du morceau avant l'arc tangente et la lecture de la fumée (borne de Taylor, jamais plus strict que le test exact) | dans le bruit (−1 à +4 %) : retiré |
| Tri des intersections par fil avant le long calcul (le 1er tour pour la 1re gardée) | +2 à +13 % (test rapide fait deux fois par couple) : retiré |
| Arc tangente relative au milieu du morceau, demi-angle précalculé par tuile (sans recalage ni division) | −5 instructions, temps dans le bruit (−1 à +2 %) : retiré |
| Faits avant (15 octobre) : fumée lue plus tôt, `kpr` sans division, limite de courbure sans racine, morceaux de 30° ou 45° | aucun gain |

- La passe n'est limitée ni par les instructions ni par les intersections inutiles : par le nombre de points de nappe réellement éclairés et le coût de chacun. Un vrai gain demande soit moins de points (moins de lasers, figures plus petites, résolution réduite des passes laser), soit un compromis sur l'image : à décider avec l'utilisateur (voir `PLAN-LASERS.md`, « Étape 9 : résultats »).
- Défaut existant (déjà dans la référence) : les impacts lointains sur le sol, vus en rasant, sont en pointillés (lignes plus fines qu'un pixel).

### Blanc à la sortie (15 octobre 2026)

`PLAN-LASERS.md`, « Étape 4 (en partie) » ; historique 25. Banc rapide, immobile, 8 cas (`-Cases "1,4,6,7,10,14,15,22"`), contre `bench\ref\avant_sortie.exe` (`bench\blanc_las_*`, lyres `bench\blanc_ly_*`) : +1 à +3 % à l'image (L1 14,4 → 14,6 ms, L7 32,3 → 33,1 ms, I1 48,7 → 49,6 ms) ; passe « lasers : sorties » ~0,25 ms pour 200 lasers ; blanchiment dans la composition : coût nul. Banc des lyres : images identiques, temps dans le bruit.

### Pistes pour la suite (sans dégrader l'image)

1. Profondeur maximale par tuile : ignorer les segments entièrement derrière les surfaces de la tuile (peu de gain attendu dans les cas du banc, plus dans une vraie scène).
2. Cônes (L2) : test par pixel des deux grands bords du segment à l'écran (comme la bande des traits seuls) avant le calcul ; ~44 % des couples de L2 sont rejetés après 25 à 60 opérations.
3. Registres : alléger le chemin des traits (moins de variables vivantes), puisque sa seule présence coûte ~1,3 ms sur L1.
4. **L7 à alléger plus tard** (décision de l'utilisateur, 15 octobre 2026 : on continue d'abord le plan) : 15,4 ms de lasers seuls, dû à la surface couverte (doubles éventails des trusses 3, tunnels du sol de scène). Pistes : profondeur maximale par tuile, rejet plus tôt des pixels hors des bords (cônes, tunnels), moins de morceaux pour les cônes de petite ouverture ; mesurer chaque groupe avec `--cases 14` (voir « Étape 2 »).
5. Si les cibles L1 / L2 restent hors d'atteinte : décider avec l'utilisateur (par exemple, une qualité adaptative qui baisse la largeur minimale des traits au loin) ; aucune dégradation sans son accord.
6. **Variante « nappes et traits seuls »** (sans le code des traits séparés et de l'ondulation), choisie quand aucune figure n'a de traits visibles : ~−20 % attendu (sans ce chemin, L1 passait de 6,9 à 5,6 ms à l'étape 1). Prévue avec la lecture ILDA (`PLAN-LASERS.md`, « Étape 3 bis »).
8. Fichiers ILDA : les figures planes découpées en dizaines de nappes depuis la même sortie sont le pire cas (I3 : 1 milliard de couples). Pistes : rejet plus tôt des pixels hors du coin de chaque nappe (test des deux bords à l'écran, comme pour les cônes, piste 2) ; grosses tuiles plus fines près des sorties.
7. Volutes : un cas de banc « L1 sans volutes » mesurerait leur coût dans le même lancement (moins de bruit) ; la 2e octave est choisie dans tous les cas du banc (il y a toujours une nappe à moins de 7 m de la caméra) : un test par segment plus fin (part de l'écran à moins de 7 m) la couperait plus souvent.

## Lasers : d'où vient le lag (16 octobre 2026)

Banc d'exploration `--bench-explore` (216 cas, lasers seuls) : résultats et tableau récapitulatif dans `docs/analyse-lag-lasers.md` (mesures `bench\explore_t2`, compteurs `bench\explore_s1`).

- Temps des lasers ≈ 0,074 ms par million de couples (pixel, nappe) + 0,56 ms par millier de segments + 0,2 ms (R² 0,89) ; nappes courbes (arcs) ~117 ps par couple contre ~73 ps.
- Base (50 éventails de 40°, vue du public) : 3,25 ms de lasers, 8,2 ms à l'image, juste à 120 img/s. Coût fixe des lasers allumés ~0,7 ms.
- Plus grosses sources : fichiers ILDA et figures courbes (×4,5 à ×8,4), diffraction (×2,4 / ×3,8 / ×6,5), figures à plusieurs nappes (grille ×4,3), nombre de lasers et ouverture (proportionnels), impacts (jusqu'à 8 ms ; ×5 sur sol mouillé), moteur CPU des vagues et de l'ILDA avec diffraction (jusqu'à 7,4 ms).
- Sans effet : densité de fumée, puissance, largeur des traits, mouvement, vue (pour des éventails).
- Passe des arcs, essais exacts (16 octobre 2026, rien de gardé) : au mieux −1,4 % ; détail, découpage du temps et comptages dans `docs/optimisations-lasers.md`, « Passe des arcs : essais exacts ». Pour comparer deux variantes d'une passe longue, mesurer dans un même lancement : d'un lancement à l'autre, la passe des arcs dérive de 10 à 20 % (puissance et chaleur de la carte) alors que les autres passes ne bougent pas.

## Lasers : fumée spatiale v2 (16 octobre 2026)

Mesures rapides seulement (banc des lasers `-Fast`, immobile), pour l'ordre de grandeur : l'utilisateur choisit d'abord le rendu ; banc complet et optimisation viendront après (étape 5 de `PLAN-FUMEE-LASERS-V2.md`, où chaque mesure est détaillée ; historique 33 à 36).

- Texture des amas en RGBA8 (structure dans le canal b) : aucune attente à l'envoi (« scene (surfaces) » inchangée en mouvement), banc des lyres dans le bruit, images identiques ; « fumée : faisceaux » +0,03 ms (texels 2 fois plus gros).
- Modèle Classique : images identiques et temps dans le bruit à chaque étape (le code v2 est dans ses propres variantes, `LASER_FOG` 4 et 5).
- Passe des lasers, contre le Classique (volutes et 2e octave), après la correction des bancs (seuil par pixel, bords nuageux ; historique 37) : Concert sans filaments (variante 4) +0,3 à +1,0 ms (L1 9,7 → 10,6, L3 9,6 → 10,7, L4 3,0 → 3,7, M1 5,6 → 5,9, arcs 14,0 → 14,3) ; filaments de près (variante 5) encore +0,75 à +1,1 ms dès qu'un éventail passe à moins de ~7 m de la caméra, même pour peu de pixels (registres de la variante). Les mesures « sans filaments » de l'historique 35 sont fausses (mauvaise variante, voir `PLAN-FUMEE-LASERS-V2.md`).
- Salle composée et filaments de l'utilisateur (force 1, 2 m, portée 1) : historique 38, +2,3 à +5,7 ms contre le Classique ; après le fondu des deux ambiances (historique 39) : L1 10,5 → 15,3, L3 9,7 → 15,0, L4 3,0 → 6,2, M1 5,6 → 8,6, arcs 14,3 → 18,4 ms, dont les filaments, lus presque partout, +1,1 à +2,8 ms.
- Pistes : variante 5 seulement pour les tuiles proches, portée des filaments plus courte, lecture des nuages lancée avant la déformation, saut du calcul dans les trous (densité nulle), fondu des ambiances seulement dans une variante à part (salle composée), transitions plus courtes ou calcul partagé entre les deux ambiances (la lecture et la déformation sont déjà communes).

## Lasers : rendu « photo » (16 octobre 2026)

Bords brillants des éventails (rebroussement du scanner, `laseredge` 1, largeur 0,025), halo des lasers (`laserhalo` 0,1, étendue 0,5), réglés à l'œil par l'utilisateur dans la vue `--demo-laser 8`, et corrections des coupes par les obstacles (bords adoucis en différence de marches au lieu d'un produit ; portée d'un morceau coupé = la plus grande de ses deux bords). Banc laser rapide, immobile, 5 cas, 2 lancements en alternance (`bench\rendu_photo_*`, historique 30). Pas encore optimisé.

| Cas | Avant (`avant_arcs.exe`) | Après (réglages par défaut) | Bords et halo coupés |
|---|---|---|---|
| L1 éventails / public | 13,4 ms (passe des nappes 8,3) | 14,8 ms (nappes 9,3, halo 0,47) | 14,4 ms (nappes 8,8) |
| L2 cônes / public | 19,3 ms | 19,6 ms | 19,5 ms |
| L3 caméra dans les nappes | 12,4 ms (nappes 8,1) | 13,4 ms (nappes 8,7) | 12,7 ms |
| L4 traits séparés | 7,0 ms | 6,5 ms (bruit) | 6,7 ms |
| M1 lyres + lasers | 10,9 ms (nappes 4,8) | 11,4 ms (nappes 5,1) | 10,9 ms |

- **Halo** : passe « lasers : halo » de 0,47 à 0,50 ms, constante (pyramide du bloom sur l'image des lasers en 4K, dès qu'un laser est allumé).
- **Bords brillants** : passe des nappes +0,3 à +0,5 ms (+4 à +9 %) sur les éventails ; rien sur les traits séparés et les arcs.
- **Code présent, effets coupés** : passe des nappes encore +0,4 à +0,6 ms (+5 à +7 %) contre avant (registres : le code ajouté coûte même coupé). À reprendre à l'optimisation : variante du shader sans bords brillants, première réduction du halo à moindre coût.
- Banc des lyres inchangé (+0,3 à +0,8 %, images identiques).

## Lasers : convergence RGB et aberration de l'objectif (16 octobre 2026)

Convergence RGB (`laserconv` 0,3 mrad : les diodes rouge et bleue partent avec un petit écart d'angle ; franges sur les traits, les bords des nappes et les impacts) et aberration de l'objectif sur l'image des lasers (`laserlensca` 0,2 %), réglées à l'œil dans la vue `--demo-laser 9`. Banc laser rapide, immobile, 5 cas, 2 lancements (`bench\conv_*`, historique 31). Pas encore optimisé.

| Cas | Avant la journée (`avant_arcs.exe`) | Maintenant (tout actif) | Convergence et objectif coupés → actifs |
|---|---|---|---|
| L1 éventails | 14,8 ms | 17,5 ms (+18 %) | 15,3 → 15,7 ms (nappes 9,0 → 9,5 ; impacts 0,8 → 1,35) |
| L2 cônes | 21,5 ms | 22,1 ms (+3 %) | 19,6 → 19,6 ms |
| L3 caméra dans les nappes | 13,0 ms | 15,0 ms (+15 %) | dans le bruit |
| L4 200 × 8 traits séparés | 5,6 ms | 9,9 ms (+78 %) | 6,8 → 10,4 ms (traits 1,7 → 3,8 ; impacts 0,01 → 1,13) |
| M1 lyres + lasers | 12,0 ms | 13,7 ms (+14 %) | 11,7 → 12,8 ms (nappes 5,0 → 5,8 ; impacts 0,35 → 0,79) |

- Le plus cher : les **traits séparés**, calculés 3 fois (un trait par couleur, chacun avec son point le plus proche du rayon : vu dans son axe, celui du vert ne convient pas aux autres), et les **impacts** (bandes élargies de l'écart des couleurs, 3 gaussiennes par pixel). Le bord des nappes ne coûte presque rien (3 marches au lieu d'une, seulement près des bords).
- **Gaspillage à corriger à l'optimisation** : le calcul par couleur est fait aussi pour les lasers d'une seule couleur (L4 : rouge, vert, bleu purs), qui n'ont pas de franges. Un test par segment (couleur pure : un seul calcul) devrait ramener L4 et la plupart des programmations à leur coût d'avant.
- Aberration de l'objectif : 2 lectures de plus par pixel dans la composition (+0,03 à +0,1 ms).
- **Couleurs pures : un seul calcul** (historique 32) : un segment ou un impact dont un seul canal est allumé (une seule diode) n'a pas de franges ; le calcul par couleur est sauté (image identique pour les lasers blancs, PSNR infini sur la vue 9 ; les lasers de couleur pure ne sont plus décalés de 0,3 mrad, invisible). L4 : traits 3,75 → 3,04 ms, peu de gain car ses couleurs sont presque toutes mélangées (une petite part d'une 2e couleur suffit).
- **Scène multicolore (L7 : 194 lasers, dégradés, arc-en-ciel, grilles en diffraction ; 3 lancements)** : avant la journée 34,5 ms (29 img/s) → maintenant 42,8 ms (23 img/s). Convergence et objectif seuls : 36,0 → 42,8 ms (+6,7 ms : passe des nappes et traits 11,2 → 16,6 ms, impacts 2,1 → 3,1 ms) ; bords brillants, halo et code présent : +1,5 ms.
- Piste pour l'optimisation : l'écart des couleurs ne se voit qu'à plus d'environ un demi-pixel à l'écran (loin de la source, ou de près). Ailleurs (la plupart des couples), un seul calcul suffirait : test par couple (écart x distance / taille du pixel).

**Optimisation (18 octobre 2026, historique 41)** ; banc laser rapide, immobile, 2 lancements, contre `bench\ref\avant_conv_opt.exe` (fumée v2 par défaut : tous les temps sont plus hauts qu'avant) :

1. Traits séparés : point le plus proche du rayon calculé une fois ; distance de chaque couleur sur la normale commune du rayon et du trait (exacte pour des droites infinies). Calcul complet par couleur seulement pour un trait vu presque dans son axe (sinus < 0,1).
2. Impacts : convergence seulement pour un impact multicolore, devant la caméra, dont les couleurs s'écartent d'au moins 0,3 pixel ; élargissement de la bande plafonné à 64 pixels. Sans plafond, quelques bandes aberrantes couvraient l'écran sans rien éclairer : L4 impacts 1,09 → 0,014 ms, image identique au pixel près.
3. Variantes du shader avec la convergence (`LASER_CONV`, 12 de plus ; réserve de shaders portée à 96), choisies seulement si l'écart est réglé et qu'un éventail ou un trait allumé a des couleurs mélangées.
4. Halo : pyramide à partir du quart (première réduction 4 x 4 en 4 lectures bilinéaires) : 0,50 → 0,32 ms.
5. Franges invisibles sautées : écart des couleurs sous 0,25 fois la largeur du faisceau (pixel compris), fondu jusqu'à 0,5 : un seul calcul. Concerne les lasers lointains qui ne visent pas la caméra ; un laser qui la vise garde ses franges.
6. Nouveau : franges sur les impacts des nappes courbes (cônes, tunnels, fichiers ILDA) au sol et sur les surfaces. Pas encore dans la fumée des nappes courbes (passe des arcs, la plus chère).

| Cas | Avant | Après | Convergence coupée → active (après) |
|---|---|---|---|
| L4 traits séparés | 11,3 ms (82 img/s) | 6,8 ms (117 img/s) | 6,5 → 7,0 ms (+8 %) |
| L7 multicolore | 52,1 ms (19 img/s) | 45,3 ms (22 img/s) | 39,8 → 44,3 ms (+11 %) |
| I1 ILDA nappes | 63,9 ms | 65,7 ms (bruit) | 61,7 → 62,1 ms (+1 %) |
| L1, L2, L3, M1 | | dans le bruit (−1 à +2 %) | |

- Images : vues 0, 4, 8, 9 (`bench\conv_opt_vues2`) : PSNR 47 à 68 dB, différences seulement dans l'image d'écart x8 (bords des franges, halo), sauf la nouveauté 6 (impacts des formes courbes frangés).

**Impacts en quadrilatère exact, bords des nappes au plus près (18 octobre 2026, historique 42)** ; contre `bench\ref\avant_impacts_cap.exe`, banc laser rapide, 2 lancements :

- Chaque impact était dessiné en carrés de marge autour de ses bouts (la plus grande marge, dans tous les sens) : dans les vues obliques, des milliers de pixels sans lumière. Il est maintenant dessiné en quadrilatère : les 4 coins de la bande éclairée sur la surface (en travers de la ligne : 4 sigma / pente ; le long de la ligne : 8 sigma ; sigma lu au bout et au coin, le plus grand gardé), projetés à l'écran, plus 3 pixels dans leurs deux directions. Un plafond fixe des marges (64 pixels, essayé) gagnait autant sur L7 mais coupait les vrais gros plans (caméra à 35 cm d'une ligne au sol) : écarté.
- Passe des impacts : L1 0,80 → 0,14 ms ; L2 0,52 → 0,25 ; M1 0,36 → 0,07 ; L7 2,16 → 0,26 ; I1 1,98 → 0,85 ; I3 4,99 → 1,75 ms. Image entière : L1 −7 %, L7 −5 %, M1 −4 %, autres dans le bruit.
- Images (10 vues, dont gros plans au sol, `bench\ab_final_vues`) : au plus 0,005 % de pixels changés, quelques pixels au bout de lignes d'impact et sur des points d'impact lointains.
- Bords des nappes : l'écart des couleurs (et son fondu) n'est calculé que près d'un bord. Coût de la convergence sur L7 mesuré avant (6 tours, passe des nappes et traits) : coupée 15,7 ms, active 18,8 ms, dont traits 1,5, bords 0,4 et présence du code 1,2 ms.
- Banc des lyres inchangé (−0,6 %, images identiques).

## Lasers : optimisation, étape 1 (18 octobre 2026, historique 43)

Plan : `PLAN-OPTIM-LASERS.md` (détail des mesures en section 8). Mesures seulement, image et variantes du shader inchangées (bancs `bench\e1_journal_*`, `bench\e1_stats`).

- `images.csv` a 4 colonnes de plus : `fumee_ms` (simulation de la fumée, CPU), `lasers_cpu_ms`, `present_ms` et `non_presentee` (`Present` de l'image précédente, mesuré dans `sokol_app.h`). `resultats.txt` : ligne « Presentation ».
- `--stats` choisit des variantes de mesure de la passe des lasers (`LASER_STATS`, fumée spatiale seulement, image identique) : lumière noyée, couples faibles, lumière lente interpolable. Plus lentes (L1 21 → 39 ms) : ne pas s'en servir pour les temps.
- Constats : le pas de la simulation de fumée (5 à 8 ms sur le CPU, une image sur trois au banc) règle le rythme des images et ajoute 1,8 à 2,7 ms de GPU à l'image qui le suit (passe « fumée : faisceaux ») ; au banc, 55 à 66 % des images ne sont pas présentées (`DO_NOT_WAIT`, 2 tampons) ; aucun couple ne tombe dans un pixel saturé (piste 1.3 abandonnée) ; 42 à 76 % des couples des éventails pourraient prendre la lumière lente interpolée (piste 1.1).
- Banc des lyres inchangé.

## Lasers : optimisation, étape 2 (18 octobre 2026, historique 44)

Détail : `PLAN-OPTIM-LASERS.md`, section 8.

- **Fumée du CPU en tâche de fond** (`src/fog.cpp`) : 1,9 à 2,3 ms → 0,3 ms par image sur le fil principal ; l'attente du GPU après chaque pas de la simulation disparaît. Images identiques en scène immobile.
- **Présentation** (`sokol_app.h`) : drapeau de déchirure, latence DXGI 2 ; spectacle 3 tampons avec la synchro ; bancs 2 tampons, `ALLOW_TEARING | DO_NOT_WAIT`.
- **Attention aux bancs** : Windows affiche la fenêtre directement (déchirure, 0 % d'images jetées) ou compose l'image (9 à 20 % d'images jetées, passe finale un peu plus longue), selon ce qui se passe à l'écran. Colonne `non_presentee` de `images.csv` ; comparer A et B lancés dans le même état.
- `--vsync` : banc avec la synchro verticale (cadence du spectacle). À 120 Hz, une image doit tenir en ~7 ms de GPU : la carte reste inactive 1 à 1,6 ms entre deux images (cause à confirmer avec PresentMon).
- Banc des lasers : la plupart des cas gagnent 0,3 à 1,6 ms par image ; spectacles sans synchro : moyenne 10,80 → 10,27 ms, 11 scènes sur 30 sous 8,4 ms ; avec la synchro, 6 scènes tiennent 120 img/s.

## Lasers : optimisation, étape 3 (18 octobre 2026, historique 45)

Détail : `PLAN-OPTIM-LASERS.md`, section 8.

- **Passes de fumée des lyres sautées sans lyre allumée** : −0,4 à −0,65 ms par image dans les cas sans lyre, image identique.
- Variante du shader par grosse tuile (0.4) et tuiles vides (0.3) : essayées, sans gain, retirées.
- **Biais de mesure** : le premier lancement d'une série est 10 à 15 % plus rapide (carte froide). `perf_ab.ps1` et `set_ab.ps1` alternent maintenant l'ordre (A B, puis B A) ; les A/B faits avant en favorisaient A.
- `--abset clé=valeur` : chaque cas du banc joué deux fois de suite (A avec le réglage, B sans), pour comparer une option dans un même lancement (lancer aussi l'ordre inverse).

## Lasers : optimisation, étape 4 (18 octobre 2026, historique 46)

- Lumière lente interpolée par tuile (1.1, nappes planes) : image invisible, mais le gain (−9 à −19 % dans un même lancement) est mangé par le coût de la présence du code (registres, mémoire partagée) : contre l'avant, L3 −7,6 %, L1 et M1 ±0, traits seuls +6 %. **Pas gardée** ; détail et méthode dans `PLAN-OPTIM-LASERS.md`, section 8.
- `perf_ab.ps1` et `set_ab.ps1` : lancement de chauffe (jeté) avant la série.

## Lasers : optimisation, étape 5 (18 octobre 2026, historique 47)

- Morceaux voisins d'un même cercle fusionnés à l'envoi au GPU (`lasermerge`) : un cercle entier fait 2 morceaux au lieu de 4. L2 −5 à −8 %, L7 −1 à −3 %, ILDA et tracés inchangés (rien à fusionner). Image : L2 0,01 % de pixels au-delà de 4/255, invisible ; autres cas identiques.
- Le cercle en un seul morceau gagnerait encore ~5 % sur L2, mais supprime la ligne doublée de la jonction des cercles complets (défaut existant) : à décider. Détail : `PLAN-OPTIM-LASERS.md`, section 8.

## Lasers : optimisation, étape 7, résolution adaptative (18 octobre 2026, historique 48)

- Passes des lasers à 80, 70 puis 50 % de la résolution, seulement quand l'image passe sous 60 img/s (`laseradaptive`, avec `adaptive`) ; agrandissement selon la profondeur (0,33 à 0,4 ms). Palier fixe pour les mesures : `laserscale`. Bancs (`adaptive=0`) : inchangés.
- Gains, image entière : 80 % −19 à −29 %, 70 % −26 à −44 %, 50 % −41 à −65 % (L1 16,5 → 12,4 → 7,0 ms).
- Spectacles : les 30 scènes au-dessus de 60 img/s ; 13 à 120 img/s sans synchro (5 au départ du plan). Détail : `PLAN-OPTIM-LASERS.md`, section 8.

## Lyres superposées (16 octobre 2026)

Constat (banc `--bench-lyres`, historique n°26 et 27) : quand toutes les lyres visent le même point, chaque pixel du sol est éclairé par presque toutes les lyres : la passe des surfaces passe de 3,8 ms (zoom 3) à 38 ms (zoom 20) et 110 ms (zoom 50), alors que le sol n'y montre plus que du flou. Le mouvement des lyres ne coûte presque rien de plus : c'est la superposition qui coûte. Part du temps d'une lyre dans un pixel : tache (image projetée) ~55 %, ombres ~27 %, le reste (direction, reflet GGX ~2 %) ~20 %.

1. **Gobo ouvert sans lecture de texture** (image identique) : une lyre sans gobo peu floue ne lit plus la texture du gobo (disque plein). −1 à −6 % sur les surfaces.
2. **Lyres superposées à 1/4** (réglage `crowd`, onglet Rendu « Lyres superposées à 1/4 au-delà de », 24 par défaut depuis le 16 octobre 2026 ; 0 = jamais) :
   - Seules les lyres sans gobo ni prisme dont le bord de la tache fait au moins 10 pixels à l'écran, là où elle arrive (grand zoom, frost, hors de la mise au point), sont éligibles (`Renderer::assign_beam_tiers`, marque `prism.x = -1`). Les petites taches nettes (Couronne d'origine, zoom 3) restent à pleine résolution.
   - Le CPU projette la tache de chaque lyre éligible sur 32 × 18 tuiles : le mode n'est actif que si plus de N taches se superposent quelque part. Sinon rien ne change (pas de passe à 1/4, pas de normales à écrire).
   - Le GPU (`cs_cull_clusters`) passe ces lyres dans la liste des lyres douces des cases où plus de N se superposent.
   - Passe à 1/4 (`fs_soft_light`) : éclairement **par direction** (somme des E_i · l_i par couleur) : la composition en tire N·D avec la normale fine, donc le relief est exact. Reflet calculé sur la normale moyenne du bloc 4 × 4 avec une rugosité élargie (Toksvig). Bord de la tache adouci sur au moins 8 pixels (pas d'escalier).
   - **Scintillement** (réglage `sparkle`, 1,75) : la composition multiplie le reflet du bloc par la réponse du relief fin du pixel dans la direction moyenne des lyres, divisée par la moyenne de cette réponse sur le bloc (calculée sur ses 16 pixels). La moyenne ne change pas et le béton scintille. À 1,75, la part de grains brillants est celle de la pleine résolution (1 : moitié moins ; mesures sur C2, C3, C6, K4).
   - Lyres frost seules (sans lyres superposées) : variante légère `fs_soft_simple`, la passe d'avant (même image, même coût).
   - L'eau au sol est dans la longueur de la normale du G-buffer (1 + eau) : pas de reflet des lyres à 1/4 dans l'eau (comme la passe des surfaces).
   - Mesures alternées (`-Fast`, crowd=24, contre `bench\ref\avant_lyres.exe`) : C2 52,6 → 21,5 ms (−59 %) ; C3 127 → 31,9 ms (−75 %) ; C6 78,6 → 25,0 ms (−68 %) ; M1 44,6 → 24,7 ms (−45 %) ; M3 125 → 30,4 ms (−76 %) ; C1, C4, C5, D1 à D3, M2 inchangés. Couronne (crowd 0 contre 24) : ambiance d'origine inchangée (7,5 et 11,4 ms) ; zoom 20 30,8 → 16,8 ms ; zoom 45 59,9 → 19,8 ms. Banc général : images identiques (PSNR 61 à 84 dB), temps inchangés.
   - Image (cases chargées) : PSNR 24 à 30 dB contre la pleine résolution, car les grains brillants ne tombent pas aux mêmes pixels. Vues entières et agrandissements : `bench\ly_images`.
3. **Couronne d'origine (ambiance 9)** : 11,4 ms vers le point (faisceaux dans la fumée ~5 ms, surfaces ~4 ms). Ses taches sont petites et nettes : elle n'est pas concernée par le 1/4. Ses à-coups au banc venaient surtout du GPU occupé entre deux images par d'autres programmes (attente jusqu'à 20 ms pour 7 ms de rendu).

Essais écartés (images ou mesures) :

| Essai | Résultat |
|---|---|
| Lyres superposées à 1/4 comme les lyres douces d'avant (un pixel du bloc pour la normale) | reflets en pavés de 4 × 4 : refusé |
| Toutes les lyres sans gobo éligibles (sans critère de taille du bord) | taches nettes abîmées dans les scènes ordinaires (escaliers) : refusé |
| Une seule direction moyenne pour le reflet (lobe élargi selon l'écart des directions) | plus de scintillement, sol terne |
| Lyres une par une à pleine résolution sans tache ni ombres, multipliées par un taux de passage calculé à 1/4 | bord de la convergence et ombre du cube perdus : les lyres cachées n'arrivent pas sous le même angle que les visibles ; C3 55 à 78 ms |
| Scintillement renforcé selon l'écart des directions des lyres | aucun effet (l'écart varie peu) |
| Moyenne du scintillement par la normale moyenne (Toksvig) au lieu des 16 pixels | image 3 à 9 niveaux plus sombre |
| Nouvelle passe à 1/4 aussi pour les lyres frost seules | +0,7 ms (1/4) et +0,3 ms (composition) : variante légère gardée |
| Sinus et cosinus du prisme et log2 de la mise au point précalculés | aucun gain (le compilateur les sort déjà) |
| Sans lecture du gobo ouvert même flou | aucun gain |
| Sans la branche des images en cache (prisme) | −3 à −5 % seulement |

## Marches dans la fumée des faisceaux 1/2 et 1/4 (16 octobre 2026)

Scène Contre-jour (57) : marches droites et bords de rectangles dans la fumée autour des lyres. Cause : les faisceaux doux calculés à 1/2 ou 1/4 (`beam_tiers`) prenaient un flou d'anti-crénelage de la taille d'un pixel de leur niveau ; ce flou débordait de l'enveloppe du cône dessiné et y était coupé net. Le flou est maintenant celui d'un pixel de la fumée (`tvp.tiles[3]`, `Renderer::render`) ; l'agrandissement bilatéral adoucit le reste. Image plus proche du calcul tout en pleine résolution (fumée un peu plus lumineuse), banc général : PSNR 50 à 86 dB, coût inchangé (historique 29). Avant / après : `bench	ier_images`.

Reste (vu du public, près des lentilles et du truss) : de petits blocs, parce que la pointe des faisceaux et les pièces fines (étriers, barres) sont plus fines qu'un point des niveaux 1/2 et 1/4. Essais écartés : agrandissement sur 4 × 4 points quand les 4 voisins sont à une autre profondeur (aucun effet visible) ; pointe des faisceaux (tant qu'ils font moins de 8 points du niveau) recalculée à la résolution de la fumée (blocs du bas supprimés, mais 7 % de lumière perdue : la coupure le long du faisceau n'est pas additive dans le calcul analytique) ; pixels de bord de profondeur recalculés à la résolution de la fumée (presque aucun pixel concerné autour du truss : les blocs ne viennent pas de la profondeur). Couper les niveaux (`--set tiers=0`) enlève tout, mais coûte ×1,3 à ×4,8 (zoom 45 + frost 10,9 → 40,8 ms ; C3 31,9 → 135 ms ; Couronne zoom 45 19,8 → 73,5 ms).

## AMD FSR 1 (16 octobre 2026)

Dernier recours, **coupé par défaut** (onglet Rendu « AMD FSR 1 », `--set fsr=1`, `fsrdiv`, `fsrsharp`). L'image est calculée à la résolution de l'écran / diviseur, tonalité et gamma compris (`fs_final` dans `fsr_in`), puis agrandie par EASU (`fs_fsr_easu`) et rendue nette par RCAS (`fs_fsr_rcas`) : portage GLSL de `ffx_fsr1.h` (AMD, licence MIT). Le tramage et l'interface (ImGui) sont ajoutés après, à pleine résolution : le menu n'est pas touché. Marche en fenêtré comme en plein écran (taille de la fenêtre). Remplace la « Résolution interne » (étirement bilinéaire) quand il est actif.

- Coût de FSR en 4K (GTX 1080) : EASU 0,72 ms, RCAS + interface 0,28 ms, image finale réduite 0,07 ms.
- Banc général (un lancement, historique 28) : ÷1,5 : ×1,2 à ×1,6 (défaut public 7,5 → 5,9 ms ; gobo + prisme 17,0 → 11,5 ms) ; ÷2 : ×1,5 à ×2,1 (défaut 7,5 → 4,7 ms ; gobo + prisme 17,0 → 9,2 ms). Lasers ÷2 : L1 15,7 → 6,8 ms, L2 22,6 → 6,7 ms. Le gain est moindre que le nombre de pixels : tables de la fumée, tri et CPU ne dépendent pas de la résolution.
- Image (`bench\fsr_images`) : plus nette que l'ancien étirement ; à ÷2 les traits laser fins s'épaississent et deviennent un peu granuleux, le scintillement du sol s'adoucit.

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
- **Textures envoyées à chaque image** (Direct3D 11) : une texture transitoire de plus peut faire attendre la carte (+1 à +2,7 ms en moyenne, pics). Préférer ajouter un canal à une texture déjà envoyée, ou un tampon (renommé par le pilote).
- **Code présent mais coupé** dans une passe limitée par les registres (lasers) : il ralentit quand même (6 à 15 %). Faire des variantes du shader, choisies à chaque image ; vérifier les registres (`dcl_temps` de `fxc /Fc`).
- **Basse résolution :** à n'utiliser que pour ce qui est vraiment flou.
  - La lumière indirecte de la brume calculée à 1/4 a rendu la brume tachée : annulé.
  - Les faisceaux très doux (frost) et les lyres très douces sur les surfaces, eux, passent à 1/2 ou 1/4 sans différence visible.

## Pistes d'optimisation futures (pas encore essayées)

### Lasers

Liste à jour (18 octobre 2026) : `PLAN-OPTIM-LASERS.md`, section 9 (cercle en un seul morceau, carte inactive entre deux images, niveau de détail de la fumée, halo tiré du bloom, lumière lente interpolée en variante séparée, seuil de la qualité adaptative, tri plus fin, profondeur maximale par tuile, moteur CPU). Bilan avant / après du plan : section 8, « Bilan ».

### Faisceaux doux en 1/2 seulement (sans le 1/4)

- **Constat** (16 octobre 2026, scène Contre-jour 57 vue du public) : petits blocs dans la fumée autour des lentilles et du truss, venant des faisceaux doux calculés à 1/2 et 1/4 (voir « Marches dans la fumée »). Les couper coûte ×3 à ×4 sur les faisceaux larges.
- **Idée** (demandée par l'utilisateur, à faire plus tard) : n'utiliser que le niveau 1/2 (`assign_beam_tiers` : plus de niveau 2), éventuellement en réglage. Mesurer le coût (banc général cas 4 à 9, banc des lyres C2, C3, K3, K4) et montrer les images de Contre-jour (`--ambiance 57 --cam 5,1.7,0,180,5`).
- **Selon la cadence** (demande du 16 octobre 2026) : choisir le niveau selon les images par seconde. Si la cadence visée est tenue (par exemple 120 img/s), calculer ces faisceaux à la résolution de la fumée (ni 1/2 ni 1/4) ; si ça rame, passer à 1/2, puis à 1/4. La qualité adaptative abaisse déjà les seuils de `assign_beam_tiers` (`detail_px >= 12 * quality`) : il faudrait qu'à pleine qualité aucun faisceau ne soit à 1/2 ou 1/4, et que le 1/2 puis le 1/4 n'arrivent qu'en dessous de la cadence visée. Vérifier que le passage d'un niveau à l'autre ne se voit pas (pas de saut d'image quand la qualité bouge).

### Tables des faisceaux du miroir : seulement pour les lyres reflétées dans l'eau

- **Constat** (14 octobre 2026, historique 10a à 10c) : depuis que le reflet n'est calculé que dans l'eau, les surfaces et les faisceaux du miroir coûtent 2 à 3 fois moins à 10 % d'eau. Les tables des faisceaux du miroir, elles, sont toujours calculées pour toutes les lyres dont le cône est visible dans le reflet : 1,5 à 2,6 ms avec gobo + prisme 8 ou zoom 45° + frost, autant à 10 % d'eau qu'à 100 %. C'est maintenant la plus grosse part du reflet quand il y a peu d'eau.
- **Idée** : ne calculer la table (et ne dessiner le cône) d'une lyre dans le miroir que si son reflet tombe sur de l'eau visible à l'écran.
  - Sur le CPU, le modèle de l'eau existe déjà (`puddle_height`, `FloorTexture::water_levels`) : pour chaque lyre visible dans le reflet, tester quelques points du sol où son cône reflété peut apparaître à l'écran (rectangle d'écran du cône reflété, intersecté avec le sol visible), et la sauter si aucun n'est dans une flaque.
  - Les creux remplis sont partout (de près) dès 0,1 : la piste ne vaut que pour les flaques ; garder une marge, et toujours calculer quand les creux remplis couvrent une part notable du sol proche.
  - Variante sans CPU : réduire le masque de l'eau (`refl_beam_mask`) à une grille grossière lue par le calcul des tables, qui s'arrêterait pour les lignes dont le plan épipolaire ne traverse aucune case mouillée.
- **À vérifier** : image identique dans l'eau (vue public et `--demo 5`, à 0,1, 0,3 et 1) ; gain attendu de l'ordre de 1 à 2 ms à 0,1 avec gobo + prisme ou frost, rien à 1.

### FSR dynamique (scènes lourdes)

- **Idée** (demande du 16 octobre 2026) : activer FSR 1 tout seul quand la scène est trop lourde pour la cadence visée, et faire varier le diviseur (1 → 1,5 → 2, plafonné) selon les images par seconde ; revenir à la pleine résolution dès que la cadence est tenue. Toujours en dernier recours, après les autres réglages de la qualité adaptative (lyres superposées, faisceaux 1/2 et 1/4).
- **À soigner** : changer de diviseur sans à-coup (paliers, pas plus d'un changement par seconde environ, hystérésis) ; les cibles de résolution interne sont recréées à chaque changement de taille (`Renderer::resize`) : garder des tailles fixes par palier, ou réserver la taille pleine et ne rendre que dans une partie (viewport) ; l'accumulation temporelle de la fumée doit suivre (historique à la bonne taille) ; une case « FSR dynamique » coupée par défaut, réglable dans l'onglet Rendu.

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
