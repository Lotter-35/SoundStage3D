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
