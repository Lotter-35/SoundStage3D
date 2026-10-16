# Fumée des lasers, v2 (« fumée spatiale ») : plan

Plan du 16 octobre 2026, validé dans ses grandes lignes par l'utilisateur. **Lasers seulement** : les lyres gardent leur fumée (on verra après). Étapes 1 à 4 codées le 16 octobre 2026 (non commitées) ; reste l'étape 5 (banc complet, optimisation, lyres), à la demande de l'utilisateur.

Images de référence : `docs/references-lasers/fumee-v2/` (9 images, README). La 09 est LyreViz avant la v2 : c'est ce qu'il faut quitter.

## 1. Demande de l'utilisateur

- **Le problème.** Les volutes actuelles (texture 64³ périodique de 1,6 m, 2e octave de 0,44 m) se répètent : de loin, la nappe montre un motif « camouflage » régulier, le même partout (image 09). Pas réaliste.
- **Ce qu'il aime.** Le rendu sans volutes, avec les bords brillants : une nappe lisse, comme dans une fumée diluée parfaitement uniforme. Ce rendu doit rester possible (brume diluée = nappe lisse).
- **Ce qu'il veut.** Une fumée de la pièce **en 3D, statique dans l'espace et commune à tous les lasers**, avec :
  - des endroits très chargés (amas, panaches) : volutes, nuages épais à bords nets (images 01, 05) ;
  - des endroits dilués : nappe fine et lisse, sans volutes (image 04) ;
  - des endroits sans fumée : le laser n'y passe pas (trous, images 01 et 05).
- **Mouvement de fluide.** De près, dans un amas, la fumée doit bouger comme un fluide (se tordre, s'étirer, tourbillonner), pas glisser comme un plan. Vent, courants d'air. Sans vraie simulation de fluide en temps réel : « tricher ».
- **Niveau de détail.** De près : détail fin (image 06, marbré). De loin : seulement la forme d'ensemble, sans le détail (moins de calcul, pas de motif répétitif).
- **Commun à tous les lasers.** Un laser qui balaie fait défiler la fumée dans sa nappe ; deux lasers au même endroit voient la même fumée.
- **Interface.** Un 2e modèle de fumée, à côté de l'actuel (pour ne rien casser) : « Classique » / « Spatiale (v2) ». Plusieurs préréglages à comparer, puis tous les réglages en dessous.
- **Performance.** Doit rester optimisé (4K à 120 img/s sur GTX 1080), mais pas de grande campagne de bancs pour l'instant : l'utilisateur veut d'abord choisir le rendu. Mesurer l'ordre de grandeur à chaque étape ; le banc complet et l'optimisation viendront après.
- **Images avant / après** pour tout changement visuel.

Précision donnée à l'utilisateur : le vent ne déplace pas le rayon ; c'est la fumée qui traverse la nappe. On anime donc la fumée, pas les lasers.

## 2. Existant (à garder intact en modèle « Classique »)

Voir README, « Lasers dans la fumée (étape 3) » ; PLAN-LASERS.md, section 4 ; PERFORMANCE.md, « Étape 3 : fumée ».

- Tout est lu au point P où le rayon de la caméra traverse la nappe (une coupe de la fumée), dans `laser_fetch` / `laser_sigma_of` (`shaders/lyreviz.glsl`). Traits fins, nappes et arcs passent tous par là.
- **Fumée de la pièce** : texture des amas des lyres, 64 × 24 × 32, RG8, envoyée à chaque image (`FogSim::update`, `src/fog.cpp`). Le hangar fait 100 × 34 × 44 m (`scene.cpp`, HX 50, HZ 22, H 34) : cases d'environ 1,5 m.
  - r : amas / 2 (lyres) ;
  - g : (brume × décroissance en hauteur + amas) / room_max (lasers). Shader : `lroom.x + lroom.y * g`.
- **Volutes** : `src/volutes.cpp`, 64³ BC5 (2 instants d'une boucle de 16 s), 1re octave 1,6 m, 2e octave 0,44 m à moins de ~7 m ; mip selon la taille du pixel en P étirée par 1 / |n·v|.
- **Variantes** `LASER_FOG` 0 à 3, choisies à chaque image dans `renderer.cpp` (autour de `fogv`) ; pipelines `pip_laser_shade[2][4][2]` (`renderer.h`) ; réserve de shaders sokol 64 (`main.cpp`, `shader_pool_size`).
- **Réglages** : `RenderSettings` (`renderer.h`, `laser_air`, `laser_room_fog`, `laser_volutes`, `laser_vol_*`) ; clés `--set` dans `main.cpp` (`laserfog`, `volutes`...) ; interface `ui.cpp`, section « Dans la fumee ».
- **Coût mesuré** (base du banc d'exploration, 50 éventails, passes laser 3,25 ms) : fumée de la pièce + 2 lobes ≈ 0,38 ms, 1re octave ≈ 0,24 ms, 2e octave ≈ 0,38 ms ; tout ≈ 1,0 ms (31 %). La densité ne change pas le coût : seul le nombre de lectures compte. Sur les arcs, c'est la lecture de la pièce qui pèse (≈ 15 %).
- Leçons de l'étape 3 (à respecter) :
  - la passe est limitée par le calcul, les registres et l'**attente des lectures** : lancer les lectures tôt, indépendantes les unes des autres ;
  - tout code ajouté ralentit même coupé : **nouvelle variante du shader**, pas un `if` sur un réglage ;
  - une **2e texture envoyée à chaque image** faisait attendre la carte sous Direct3D 11 (+1 à +2,7 ms) ; la texture des amas, elle, non ;
  - une petite texture lue à un niveau de mip grossier coûte peu (cache) ; une grande texture lue finement coûte cher (128³ RGBA8 : +60 à +90 %).

## 3. Principe de la v2 : trois échelles, une seule fonction

La v2 **remplace** les volutes (elle ne s'y ajoute pas). Même point de lecture P, même fonction pour traits, nappes et arcs : cohérence garantie.

```
diffusion(P) = air + k × densité(P)
densité(P)   = carte(P)  érodée par  nuages(P)   × (1 + filaments(P), de près seulement)
```

### 3.1 Carte de la pièce (grande échelle, ~1,5 m) : où il y a de la fumée

- La même grille 64 × 24 × 32, calculée sur le CPU à chaque image, déjà lue par le shader : **aucune lecture de plus**.
- En modèle v2, le canal g contient : brume de fond × **bancs de fumée** × décroissance en hauteur + amas des machines.
  - **Bancs** : champ procédural 3D à grande échelle (5 à 15 m), qui dérive avec le vent de la simulation et évolue lentement (deux instants mélangés). Il fait des zones denses, des zones diluées et des **zones vides** (le laser n'y passe pas).
  - Pour le coût CPU : ne pas évaluer un bruit à plusieurs octaves dans chacune des 49 152 cases à chaque image (~4 ms sur un cœur). Générer au lancement une table périodique (par exemple 32³) et la lire en trilinéaire avec un décalage (vent) : ~0,2 ms. Ou répartir sur les fils existants. À mesurer (CPU de la simulation de fumée).
- **Canal b (nouveau) : « structure »** = part chargée / turbulente de la densité locale (amas et bancs denses, bords d'amas), entre 0 et 1. Brume uniforme → 0 (nappe lisse) ; amas de machine → 1 (nuages, filaments).
  - Passer la texture des amas de RG8 à **RGBA8** (196 Ko par image au lieu de 98 Ko). Les lyres ne lisent que r : leur image ne doit pas changer.
  - **À vérifier tout de suite** : aucune attente de la carte à l'envoi (passe « scene (surfaces) » sur le banc des lyres et des lasers, en mouvement), et banc des lyres inchangé.
  - Le canal a reste libre (champ de mouvement, voir 3.4, si utile).
- **Précision des faibles densités** : avec des trous et des bancs denses, 8 bits relatifs à room_max peuvent faire des marches dans la brume fine. Stocker √g et élever au carré dans le shader (1 multiplication), si des marches se voient.
- Coût GPU : 0 (même lecture). C'est le niveau « de loin ».

### 3.2 Nuages (moyenne échelle, 0,3 à 4 m) : la forme des amas, par érosion

- **Nouvelle texture 3D** « nuages » : bruit de type cumulus (Perlin-Worley : Worley inversé à plusieurs octaves, mélangé à un fbm de Perlin), périodique, motif d'environ 10 à 12 m, 64³ (texels de ~17 cm), BC5 avec 2 instants d'une boucle d'évolution comme les volutes actuelles (ou BC4 si l'évolution se fait autrement). Générée au lancement (nouveau fichier, sur le modèle de `src/volutes.cpp`, multifil).
- **Érosion** (méthode des nuages temps réel des jeux, Schneider, Horizon Zero Dawn) : la texture ne multiplie pas la fumée partout pareil, elle **ronge les bords** de la carte.
  - c = densité de la carte (0..1, normalisée), n = nuages(P) (0..1), e = érosion = réglage × structure (canal b) ;
  - densité = c × clamp((c' − e × (1 − n)) / (1 − e × (1 − n)), 0, 1), avec c' la couverture locale (la carte normalisée, ou 1 dans un amas) : la forme exacte est à régler sur les images ;
  - structure 0 (brume uniforme) → e = 0 → **nappe lisse** ;
  - structure forte, densité forte → nuage épais, bords nets ;
  - structure forte, densité faible → filaments isolés, trous.
- **Pas de répétition visible** : la carte, qui n'est pas périodique, décide où et comment la texture apparaît ; le motif de 10 à 12 m est grand devant les nappes.
- **Niveau de détail** : mip selon la taille du pixel en P étirée par 1 / |n·v| (comme aujourd'hui) ; les nuages restent visibles de loin (c'est la forme d'ensemble que veut l'utilisateur), leur contraste fin s'efface avec le mip.
- Coût : 1 lecture (petite texture, niveaux grossiers : bon pour le cache). À mesurer contre la 1re octave actuelle.

### 3.3 Filaments de près (< ~6 m) : le détail de fluide

- Motif marbré (image 06) : filaments étirés, centimétriques.
- Commencer par la texture des volutes existante (64³ BC5), lue plus petite (0,4 à 0,6 m) et déformée par le mouvement (3.4). Si ce n'est pas assez « fluide » : générer au lancement une texture marbrée par **advection d'un colorant** dans un champ tourbillonnaire périodique (version B de PLAN-LASERS.md 4.1 : quelques centaines de pas sur 64³, < 1 s, multifil).
- Modulation de moyenne 1 (la brillance moyenne ne change pas), force × structure (rien dans la brume diluée).
- **Seulement de près** : lue tant qu'un pixel couvre moins de quelques millimètres (réglage de distance), effacée progressivement au-delà ; variante du shader choisie à chaque image si un segment passe assez près de la caméra (même calcul CPU que la variante 3 actuelle).

### 3.4 Mouvement de fluide, sans simulation fine

- **Grande échelle** : les bancs (3.1) dérivent avec le vent et la turbulence de la simulation, et évoluent lentement ; les amas des machines viennent de la simulation existante.
- **Moyenne et petite échelle**, deux options à comparer en images et en coût :
  1. **Déformation bornée, sans lecture de plus** (par défaut) : les coordonnées de lecture sont déplacées par un petit champ de tourbillons analytique (2 ou 3 sinus de fréquences non entières, phases tirées d'un bruit grossier), oscillant dans le temps, plus la dérive du vent ; les 2 instants de la boucle d'évolution (canaux de la BC5) font le reste. Les volutes tournent et se tordent sur place au lieu de glisser.
  2. **Flow map à deux phases** (méthode de Valve, en 3D) : deux lectures décalées d'une demi-période, mélangées en triangle, transportées par un champ de vitesse (canal a de la carte, ou analytique). Plus fluide (étirement réel), mais une lecture de plus : réservé aux filaments de près si l'option 1 ne suffit pas.
- La petite échelle bouge plus vite que la grande (cascade turbulente).

### 3.5 Lectures par couple (pixel, nappe)

| Distance | Lectures | Comparé à aujourd'hui (variante 3) |
|---|---|---|
| Loin (au-delà du dernier niveau des nuages) | 1 (carte) | 3 → 1 |
| Moyenne | 2 (carte + nuages) | 3 → 2 |
| Près (< ~6 m) | 3 (+ filaments) | égal |

- Variantes du shader : `LASER_FOG` 4 (v2 : carte + nuages) et 5 (v2 avec filaments), choisies à chaque image ; v2 en préréglage « lisse » (érosion et filaments nuls) peut utiliser une variante sans la texture des nuages (= coût du niveau 1).
- `pip_laser_shade[2][4][2]` → `[2][6][2]` : 8 shaders de plus ; vérifier la réserve de sokol (64, `main.cpp`) : au-delà, les derniers ne sont pas créés, sans message.
- Lectures lancées tôt, indépendantes (les coordonnées des nuages ne doivent pas dépendre de la lecture de la carte : la déformation est analytique).
- Piste d'optimisation pour plus tard : dans les trous (densité ≈ 0), sauter le reste du calcul du segment.

## 4. Interface et réglages

Section « Dans la fumee » de l'onglet des lasers (`ui.cpp`), en haut :

- **Modèle de fumée** : Classique (l'actuel, intact) / Spatiale (v2). Clé `--set laserfogmodel=0|1`.
- **Préréglages** (liste, clé `--set sfpreset=n`) ; choisir un préréglage remplit les réglages en dessous :

| Préréglage | Référence | Idée |
|---|---|---|
| Hazer propre | rendu sans volutes | brume uniforme, aucun banc, érosion 0, filaments 0 : nappe lisse |
| Hazer + panache local | 04 | brume uniforme diluée, amas des machines seuls structurés |
| Concert, machines à fumée | 01, 05 | bancs denses, zones vides, érosion forte, bords nets |
| Nuages larges et doux | 03, 07, 08 | bancs larges, érosion moyenne, pas de trous |
| Marbré de près | 06 | comme « Concert », filaments forts de près |

- **Tous les réglages** en dessous (chacun avec sa clé `--set`, préfixe `sf`) :
  - brume de fond (densité uniforme) ;
  - bancs : quantité (couverture), taille, zones vides (seuil), vitesse d'évolution ;
  - nuages : taille, netteté des bords (érosion), contraste ;
  - filaments : force, taille, distance d'apparition ;
  - mouvement : tourbillons (force, taille), vitesse d'évolution (le vent et la turbulence restent ceux de la simulation) ;
  - densité selon la hauteur ;
  - part de la simulation (amas des machines) contre les bancs procéduraux.
- Les réglages de l'air (`laserair`), de l'intensité dans la fumée et des 2 lobes restent communs aux deux modèles.
- Vérifier les ambiances (`ambiances.cpp`) : celles qui règlent la fumée des lasers ne doivent pas casser ; ne pas changer leur rendu (elles restent en modèle Classique tant que l'utilisateur n'a pas choisi).

## 5. Étapes

Chacune finie avant la suivante, avec images avant / après montrées à l'utilisateur.

1. **Carte v2** : bancs procéduraux, zones vides, canal b (structure), passage en RGBA8, choix du modèle (case + clé), variante du shader « v2 carte seule ».
   - Vérifier : banc des lyres inchangé (images identiques, aucune attente à l'envoi) ; modèle Classique identique à avant (PSNR).
   - **Fait (16 octobre 2026, non commité).** `src/fumee_spatiale.h/.cpp` (réglages, table des bancs, clés `--set`, interface), `FogSim::update_spatial` (`fog.cpp`).
     - Bancs : table périodique 64³ (bruit de gradient à 3 octaves dans un domaine déformé), ramenée à une loi normale exacte (rang → quantile) ; période 10 tailles de banc (80 m pour 8 m), bancs 1,6 fois plus minces en hauteur. Deux couches déplacées au hasard à chaque cycle, qui glissent d'une demi-taille de banc pendant le cycle, mélangées en triangle et ramenées au même écart type : la loi, donc la couverture, ne change pas dans le temps. Vent de la simulation. Table : 111 ms au 1er usage ; champ : 0,27 ms par pas de la simulation (20 par seconde).
     - Profil : seuil = quantile de la couverture ; bords en smoothstep (netteté) ; cœurs plus denses ; hors des bancs, 1 − zones vides ; moyenne ramenée à 1 sur la loi normale. Quantité : la fumée moyenne du modèle Classique (brume + amas moyens) × `sfhaze`, répartie par les bancs ; amas des machines en plus (× `sfsim`, 0,25 : à 1 ils noyaient les bancs).
     - Canal g relatif au maximum réel de l'image (pas de marches visibles : encodage en racine carrée inutile pour l'instant). Canal b : (bancs au-delà de la brume restante + amas) / densité.
     - Variante du shader : la variante 1 (fumée de la pièce, sans volutes) sert telle quelle de « v2 carte seule » : aucun shader de plus.
     - Vue `--demo-laser 10` : la vue de l'image 09 (un éventail vert continu du nez de scène).
     - Vérifié : modèle Classique identique (PSNR ∞ ou > 80 dB) ; banc des lyres inchangé (images identiques, temps dans le bruit) ; aucune attente à l'envoi en RGBA8 (« scene (surfaces) » inchangée, en mouvement). Seule trace : « fumée : faisceaux » +0,03 ms (texels 2 fois plus gros) ; si besoin, garder une texture RG8 en modèle Classique.
     - Coût (banc des lasers rapide, historique 33) : v2 carte seule contre Classique, passe des lasers L1 10,4 → 8,1 ms, L3 9,4 → 7,6, L4 3,05 → 2,06, M1 5,4 → 4,4 (sans volutes : moins de lectures).
     - Images : `bench/lasers_images/fumee_v2/e1_*.png`.
2. **Nuages par érosion** : texture, lecture, niveau de détail, variante 4.
   - **Fait (16 octobre 2026, non commité).**
     - Texture `SpatialFogClouds` (`fumee_spatiale.cpp`) : 64³ BC5 périodique, Perlin remappé par un Worley inversé à 3 octaves (périodes 4, 8, 16), 2 instants (domaine déformé dans un sens, puis dans l'autre), ramenée à une loi normale exacte (0,5 + z × 0,15). Générée au 1er usage du modèle v2 : 226 ms. Contraste des niveaux : 1 ; 0,97 ; 0,89 ; 0,74 ; 0,50 ; 0,17 ; 0, soit 1 − 0,031 × niveau² jusqu'au niveau 4 : le shader divise z par cette valeur (les formes restent nettes et à la bonne couverture de loin), l'érosion s'efface au niveau 5.
     - Variante `LASER_FOG 4` (`#if LASER_FOG >= 4` / `#elif >= 1` : le code Classique compile comme avant) ; la texture est liée à la place des volutes (même échantillonneur), les uniformes des volutes portent ses paramètres (`spatial_fog_cloud_params`). 4 shaders de plus (49 sur 64).
     - Érosion : seuil en écarts types (couverture des nuages au cœur des bancs), plus haut au bord des bancs (structure faible), bord doux en smoothstep, relief interne (densité qui monte du bord vers le cœur sur 1,5 écart type : sans lui, les nuages ressemblaient à des taches de peinture plates), masque ramené à une moyenne de 1 au cœur des bancs ; force = érosion × structure ; l'air n'est pas rongé.
     - Vérifié : Classique identique (PSNR ∞ ou 107 dB), banc des lyres inchangé.
     - Coût (banc des lasers rapide, historique 34), passe des lasers : nuages contre carte seule L1 8,0 → 9,7 ms, L3 7,6 → 9,3, L4 2,05 → 2,8, M1 4,4 → 5,3, arcs de L2 12,0 → 13,5 ; v2 avec nuages contre Classique (volutes et 2e octave) : L1 10,0 → 9,6, L3 9,8 → 9,3, L4 3,0 → 2,8, M1 5,4 → 5,4, arcs 14,1 → 13,5.
     - Images : `bench/lasers_images/fumee_v2/e2_*.png`.
3. **Filaments de près et mouvement** : option 1 (déformation bornée), puis option 2 si besoin ; variante 5 ; choix par la distance.
   - **Fait (16 octobre 2026, non commité)**, option 1 seulement.
     - Tourbillons (`laser_swirl`) : déplacement des coordonnées de lecture par un champ analytique borné de type ABC (Arnold-Beltrami-Childress) : 3 sinus, chaque composante ne dépend que d'un autre axe (divergence nulle), nombres d'onde différents par axe, phases qui avancent avec le temps. Grands tourbillons (0,4 m, 4 m, 0,35 rad/s) sur les nuages et les filaments ; petits (3,3 fois plus petits, 2,5 fois plus rapides, 3 fois plus faibles) sur les filaments seuls. Pas de lecture de plus.
     - Filaments : la texture des volutes (liaison 16, `laser_fil_tex`), motif de 0,5 m, axes permutés et cisaillés, 2 instants (boucle de 8 s), dérive 1,6 fois le vent ; modulation de moyenne 1 × force × structure (rien dans la brume diluée), effacée au-delà du niveau −1 (à moins de ~7 m). Variante 5, choisie si un segment passe assez près de la caméra (même calcul que la 2e octave du Classique). 4 shaders de plus (53 sur 64).
     - `--play` : vues d'essai sans pause, pas de 1/60 s (séquences reproductibles).
     - Vérifié : Classique identique (PSNR ∞ ou > 85 dB) et dans le bruit malgré le bloc d'uniformes agrandi.
     - Coût (banc rapide, historique 35), passe des lasers :
       - tourbillons (3 sinus) contre étape 2 : L3 +0,37, L4 +0,3, M1 +0,2, arcs de L2 +0,55 ms, L1 dans le bruit. Avec 6 sinus, à peine plus. Le coût vient surtout de l'attente : la lecture des nuages dépend maintenant du calcul des sinus.
       - filaments (variante 5) : L1 +1,55, L3 +1,3, L4 +1,1, M1 +0,45, arcs +0,4 ms, dès qu'un éventail passe à moins de ~7 m (cas du public) même si peu de pixels les lisent : c'est la variante (registres, chemin de lecture) qui coûte. Sans les petits tourbillons : pareil.
       - Pistes pour l'étape 5 : portée plus courte (`sffillod` −1,5 à −2 : ~5 m), variante 5 seulement pour les tuiles proches (liste des segments proches à part), lecture des nuages lancée avant les sinus (déformation appliquée à une 2e lecture ?), flow map (option 2) si le marbré doit rester net pendant le mélange des 2 instants.
     - Images : `bench/lasers_images/fumee_v2/e3_*.png`, séquences `e3_mouvement_*.gif` (une image toutes les 0,5 s).
4. **Préréglages et tous les réglages** dans l'interface et en `--set`.
   - **Fait (16 octobre 2026, non commité).** `spatial_fog_preset` (`fumee_spatiale.cpp`) : 0 par défaut, 1 hazer propre (aucun banc, rien de rongé : variante 1), 2 hazer + panache local (brume uniforme, seuls les amas des machines sont rongés), 3 concert (bancs à bords nets, zones vides 0,95, nuages nets), 4 nuages larges et doux (bancs de 14 m sans trous, nuages de 20 m à bords doux), 5 marbré de près (concert + filaments forts, petits tourbillons). Clé `--set sfpreset=n` (passe en v2 ; les `--set sf...` suivants s'appliquent par-dessus). Interface : liste des préréglages (« (modifié) » si un réglage a changé, bouton « Revenir »), puis les réglages en groupes (bancs, nuages, mouvement, filaments).
     - Ambiances : elles ne touchent pas au modèle (`reset_all` ne copie que quelques réglages) ; en v2, la quantité de fumée suit leur brume et leurs amas. Rendu Classique des ambiances inchangé.
     - Limite vue : le préréglage 2 montre peu de « panache local », car le remplissage de départ de la simulation (`FogSim::prefill`) met des amas partout ; un vrai panache demanderait de ne garder que les amas des machines (à voir avec l'utilisateur).
     - Coût (banc rapide, historique 36), passe des lasers : concert contre Classique L1 11,7 → 12,9 ms, L3 11,5 → 12,1, L4 3,0 → 4,15, M1 6,4 → 7,1, arcs 16,5 → 17,4 (lancement lent des deux côtés) ; hazer propre → marbré de près L1 9,6 → 13,0, L3 9,4 → 12,8, L4 2,45 → 4,8, M1 5,6 → 7,2, arcs 14,9 → 17,3.
     - Images : `bench/lasers_images/fumee_v2/e4_*.png` (les 6 préréglages dans les 3 vues).
   - **Correction après essai de l'utilisateur (16 octobre 2026) : bancs en « gros carrés ».** Avec des bords nets (netteté 4 à 8) et des zones vides fortes, le bord des bancs dessinait des marches et des rectangles (captures de l'utilisateur, vue 09 et vue d'un laser de truss). Trois causes, trois corrections :
     - le profil des bancs (seuil, netteté, zones vides) était appliqué sur le CPU case par case (cases de ~1,5 m), puis interpolé : les bords nets suivaient la grille. **Le CPU envoie maintenant le champ continu des bancs (canal a, loi normale, 0,5 + z / 8), la brume (canal g : décroissance en hauteur) et les amas (canal r) ; le profil est appliqué par pixel dans le shader** (`laser_sigma_of`, uniformes `lbank`, `lbank2`). Le canal b n'est plus utilisé ; la structure est calculée par pixel ;
     - le champ des bancs avait une 3e octave (période ~4 m, ~2,5 m en hauteur) que la grille ne pouvait pas porter : pentes droites entre deux cases, bords rectilignes. **2 octaves seulement**, bancs 1,3 fois plus minces en hauteur (au lieu de 1,6) ;
     - le contour des bancs restait une grande courbe lisse, que les nuages ne rongeaient que de l'intérieur (bord droit et net). **Le seuil des bancs se fait sur le champ des bancs + les nuages** (`sfbankrag`, « Bords nuageux », 0,7 ; 0,9 pour Concert et Marbré, 0,5 pour Nuages larges) : le contour prend la forme des nuages et bouge avec les tourbillons.
     - **Erreur trouvée en passant (depuis l'étape 3)** : dans le choix de la variante (`renderer.cpp`), le `if` des filaments s'était glissé entre le `if` de la v2 et le `else` du Classique ; en v2 sans filaments (`sffil=0`), le `else` repassait sur la variante 2 du Classique (volutes) avec les réglages v2 : nappe presque uniforme. Corrigé. Les mesures « sans filaments » de l'étape 3 (historique 35, marquées « INVALIDE ») et le coût des filaments qui en était tiré sont faux ; refaits (historique 37).
     - Réserve de pipelines de sokol portée à 128 (`main.cpp`, `pipeline_pool_size` ; 64 par défaut) : par précaution, les variantes de la fumée des lasers s'en approchent.
     - Vérifié : Classique identique (PSNR ∞ ou 107 dB).
     - Coût (banc rapide, historique 37), passe des lasers : Concert sans filaments (variante 4) contre Classique L1 9,7 → 10,6 ms, L3 9,6 → 10,7, L4 3,0 → 3,7, M1 5,6 → 5,9, arcs 14,0 → 14,3 ; filaments (variante 5) en plus : L1 +1,1, L3 +1,0, L4 +0,75, M1 +0,8, arcs +0,9 ms.
     - Images : `bench/lasers_images/fumee_v2/e5_*.png` (avant / après avec les réglages de la capture de l'utilisateur).

5. (plus tard, à la demande de l'utilisateur) banc complet, optimisation, puis les lyres.

## 6. Vérification

- **Vues** :
  - la vue de l'image 09 : `--cam 7.14,0.36,2.84,189.3,23.5` (éventail vert, vu de dessous) ;
  - gros plan : `--demo-laser 3` (à comparer à la photo 5 de `docs/references-lasers/` et à l'image 06) ;
  - vue du public avec plusieurs éventails (cas L1 du banc des lasers, ou la base du banc d'exploration) : pas de répétition visible de loin ;
  - caméra dans les nappes (L3).
- **Planches** : modèle Classique / v2, puis chaque préréglage, dans `bench/lasers_images/fumee_v2/` ; agrandissements des bords d'amas et des trous.
- **Mouvement** : quelques images à 0,5 s d'écart (ou une courte séquence) : la fumée doit se tordre sur place, sans glisser comme un plan ; aucun scintillement de loin ni en vue rasante.
- **Critères** :
  - aucune répétition visible de loin ;
  - « Hazer propre » = nappe lisse, comme sans volutes ;
  - trous où le laser disparaît, bancs à bords nets (préréglage Concert) ;
  - détail fin de près seulement ;
  - modèle Classique inchangé (PSNR, temps dans le bruit) ;
  - coût de la fumée sur la base ≤ celui d'aujourd'hui (~1,0 ms) : objectif, à donner à l'utilisateur avec le budget restant.
- **Coût** : à chaque étape, une mesure rapide (`tools\perf_ab.ps1 ... -Lasers -Fast`, et la base de `--bench-explore` si utile), comme le demande `CLAUDE.md`, ajoutée à `historique_perf.xlsx`. Pas de campagne complète tant que l'utilisateur n'a pas choisi le rendu.

## 7. Risques

- **Envoi de la texture en RGBA8** : si la carte se met à attendre (comme la 2e texture de l'étape 3), revenir à RG8 et mettre la structure dans les bits de g (par exemple 6 bits densité + 2 bits structure), ou la déduire de g dans le shader.
- **Marches dans la brume fine** (8 bits) : encodage en racine carrée.
- **Registres** : l'érosion et la déformation ajoutent du calcul dans une passe limitée par les registres ; écrire en scalaires (les `vec2` coûtaient 6 registres de plus à l'étape 3) et mesurer.
- **Fichiers partagés** : d'autres sessions modifient `main.cpp`, `ambiances.cpp`, `ui.cpp` ; faire des modifications courtes et localisées ; **ne rien commiter sans demander à l'utilisateur**.
