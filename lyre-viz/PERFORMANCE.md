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

rem 3. Comparer (3 cas, scene immobile, qualite fixe, 2 alternances)
powershell -ExecutionPolicy Bypass -File tools\perf_ab.ps1 -ExeA bench\ref\avant.exe -ExeB LyreViz.exe -Name essai

rem 4. Avant de garder : les 14 cas, en mouvement
powershell -ExecutionPolicy Bypass -File tools\perf_ab.ps1 -ExeA bench\ref\avant.exe -ExeB LyreViz.exe -Name essai_complet -Full -Moving
```

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
