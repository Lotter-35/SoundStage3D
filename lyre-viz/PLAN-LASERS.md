# Lasers dans LyreViz : plan

**État (15 octobre 2026) : étapes 1, 2 et 3 faites** (banc `--bench-lasers` et prototype mesuré, moteur et onglet Lasers, fumée ; voir « Étape 1 : résultats », « Étape 2 : résultats » et « Étape 3 : résultats » à la fin). Méthode retenue sur les chiffres : **tuiles en calcul**. Lecture ILDA faite (étape 3 bis, avancée à la demande de l'utilisateur). Prochaine étape : les intersections (étape 5 : collisions avec les obstacles et les joueurs, nappe coupée au passage d'un joueur).

Objectif : des boîtiers laser aussi réalistes que Depence R3 / R4 (vidéo de référence : « Royallaser | Depence R3 Showcase », Syncronorm).

Cibles, sur une GTX 1080 en 3840 × 2160 à 120 images/s (8,3 ms par image) :

- **Lasers seuls** : 200 boîtiers × 1 000 traits (200 000 traits), en mouvement ;
- **Mix** : par exemple 100 lyres (réglages par défaut) + 100 lasers. La répartition est à confirmer.

200 lasers et 200 lyres ensemble ne sont pas une cible.

**Règle d'arbitrage entre rendu et performance** (demandée par l'utilisateur) :

- Par défaut, **optimiser à fond**, sans dégrader le rendu : une optimisation qui ne change rien de visible est toujours prise.
- Une optimisation qui dégrade l'image de façon visible n'est pas gardée, même si elle fait gagner du temps.
- **Le réalisme passe avant la performance seulement si le gain visuel est énorme.** Dans ce cas, montrer à l'utilisateur les images avant/après et le temps ajouté, et le laisser décider.
- Un effet coûteux au gain visuel faible est abandonné, ou laissé en option coupée par défaut.

---

## 1. Ce que montrent les images de référence

| Ce qu'on voit | D'où ça vient | Comment le simuler |
|---|---|---|
| Traits très fins et nets, même au loin | Faisceau gaussien de 5 mm, divergence 0,4 à 1,1 mrad : 3 cm à 30 m, soit 1 à 4 pixels en 4K | Largeur physique, avec une largeur minimale d'un pixel qui conserve l'énergie (voir 3.2) |
| Blanc / jaune près de la sortie, couleur saturée plus loin (photo rouge, photos verte et jaune) | La lumière est très concentrée près de la source. Le capteur sature canal par canal, et le rouge « déborde » dans le vert puis dans le bleu | Réponse du capteur (voir 6) |
| Un trait seul est plus blanc qu'un éventail | Toute la puissance est dans une ligne, au lieu d'être étalée sur l'angle | Vient tout seul si l'énergie est conservée |
| Volutes dans la nappe (photo verte en gros plan) | La nappe n'éclaire qu'une tranche de la fumée : on voit une coupe 2D de la densité 3D | Densité de la fumée lue au point où le rayon de la caméra traverse la nappe (voir 4) |
| Bords de la nappe plus lumineux (même photo) | Les galvos ralentissent aux extrémités du balayage : le faisceau y reste plus longtemps | Profil d'éventail avec des « bords lumineux » (réglage) |
| Plus lumineux quand on regarde vers le laser | Diffusion vers l'avant des gouttelettes de fumée (Mie) | Fonction de phase très orientée vers l'avant, déjà présente pour les lyres |
| Éventail vu par la tranche = lame très brillante | Le rayon de la caméra traverse la nappe sur une grande longueur | Terme 1 / \|n·v\|, plafonné par l'épaisseur de la nappe |
| Étoile blanche à chaque sortie | Tous les traits partent du même point, et le capteur sature | Densité qui croît en 1/r près de la source (plafonnée par l'ouverture), et éclat avec branches (« Glow & Glare » de Depence) |
| Pièce teintée en rouge (photo 1) | Lumière diffusée par la fumée et renvoyée par les murs | Lumières virtuelles dans les sondes de lumière indirecte existantes |
| Grille verte au sol (photo des feux d'artifice) | Traits qui touchent le sol | Impacts dessinés sur les surfaces (voir 7) |

## 2. Ce qu'on sait de Depence

Leur code n'est pas public. Ce que montre le manuel :

- **Réglages laser :**
  - *Divergence Simulation* : les « hot-beams » s'épaississent au loin ;
  - *Intensity Factor* des faisceaux atmosphériques ;
  - *Laser Fog Fluid* : fumée « façon fluide » propre aux lasers ;
  - *Smoke Scale* et *Smoke Structure* (taille et quantité des nuages) ;
  - *Ambient Light* ;
  - *Scanner Simulation* : inertie des galvos, calée sur des scanners 30K.
- **Post-traitement :** Glow, Lens Flare, et « Glow & Glare » (ouverture à lamelles, branches d'étoile, seuil), ACES avec exposition automatique.
- **Boîtier :** puissance totale, angle de balayage maximal, épaisseur des tracés projetés.

Ce que j'en déduis :

- deux couches : un cœur fin (« hot-beam », avec divergence) et la diffusion dans la fumée, qui ont des intensités séparées ;
- une fumée fine propre aux lasers, animée comme un fluide, plus détaillée que la brume générale ;
- le blanc des sorties : des valeurs HDR au-dessus de la saturation, plus un éclat de diffraction.

C'est ce que reprend ce plan.

Référence technique principale : la formule des « photon beams » de Jarosz et al. (2011). Elle donne en forme fermée la lumière qu'un faisceau mince envoie dans un rayon de la caméra, sans échantillons ni bruit.

## 3. L'idée centrale : le segment d'éventail analytique

### 3.1 Une seule primitive, dont le coût ne dépend pas du nombre de traits

Rendre 200 000 traits un par un est impossible en 4K à 120 images/s : chaque trait couvre des milliers de pixels, soit plusieurs milliards de calculs par image.

Un vrai laser est **un seul faisceau** qui balaie une figure. Tout se décompose donc en **segments d'éventail** plans :

- une source, deux directions de bord, et **n traits** répartis entre elles ;
- un profil le long de l'angle : intensité, couleur, dégradé, traits allumés ou éteints ;
- un mélange traits ↔ nappe : n → ∞ donne une nappe continue ;
- un trait seul est un segment avec n = 1 ;
- un cercle (cône de traits) est fait de 16 à 32 segments ;
- un réseau de diffraction ×9 est fait de 9 copies.

Pour un pixel, le calcul est le suivant :

1. Intersection du rayon de la caméra avec le plan de l'éventail : point P, à la distance r de la source et à l'angle θ.
2. Hors de l'éventail (angle, portée, profondeur de la scène) : rien.
3. Trait le plus proche : k = arrondi((θ − θ0) / Δθ). Sa distance au rayon donne sa contribution.
4. Contribution (photon beams) : densité(P) × phase(angle) × puissance × noyau gaussien(distance) / sin(angle rayon–trait) × atténuation.

**Le coût dépend du nombre de segments et des pixels qu'ils couvrent, plus du nombre de traits.** 200 lasers × 1 000 traits en éventail font 200 segments. En cercles, 200 × 32 = 6 400 segments. Plafond prévu : 8 192 segments.

### 3.2 Passage continu des traits séparés à la nappe, sans scintillement

- **Largeur minimale qui conserve l'énergie :** largeur du noyau = max(largeur physique du trait, ~0,7 pixel à cette distance). Un trait plus fin qu'un pixel devient plus large et plus sombre, avec la même énergie. Pas d'escalier, pas de trait qui clignote.
- **Traits plus serrés que le pixel** (1 000 traits près de la source) : la somme des gaussiennes espacées régulièrement a une forme fermée (sommation de Poisson) : la moyenne, plus une ondulation qui s'efface quand les traits se serrent.
  - Écartement grand : les 2 traits voisins.
  - Écartement moyen : moyenne + 1 terme cosinus.
  - Écartement petit : la nappe lisse.
  - Aucun moiré, quelle que soit la distance.
- **Profils libres** (chenillard de traits, 1 sur 2, aléatoire) : une table par segment (jusqu'à 1 024 positions) avec ses niveaux de flou, lue au niveau qui correspond à la taille du pixel. C'est le même principe que les gobos et les tables des faisceaux.

### 3.3 Formules (pour l'implémentation)

- **Trait** : L = σs(P) · f(θ) · Φ · k(u) / sin θ · T.
  - u est la distance rayon–trait, k une gaussienne d'intégrale 1, θ l'angle rayon–trait, f la phase, T la transmission.
  - 1 / sin θ est plafonné par la longueur visible du trait.
- **Nappe** d'angle α : L = σs(P) · f(θ) · Φ / (α · r · |n·ω|) · T.
  - |n·ω| est plafonné par l'épaisseur de la nappe divisée par la taille d'un pixel. Vue par la tranche, la nappe donne une lame brillante sans valeur infinie.
- **Bords lumineux** : profil en arc sinus (balayage sinusoïdal), réglable entre uniforme et bords marqués.
- **Divergence** : w(r) = √(w0² + (θdiv · r / 2)²). Ouverture de 4 à 7 mm, divergence de 0,4 à 1,1 mrad (fiches Kvant ClubMAX).

## 4. Fumée : liée à celle de la pièce, avec des volutes fines dans les nappes

- **Même fumée que les lyres :** la densité en P combine la grille simulée 64 × 24 × 32 (amas, vent, machines) et la texture de détail existante. Un laser qui traverse un amas s'y illumine davantage, comme une lyre.
- **Visible même sans fumée :** σs = visibilité minimale (air, poussière : réglage) + k × densité de la fumée. Sans fumée, les traits restent faiblement visibles ; avec un peu de brume, ils sont nets. C'est ce qu'on voit en vrai, grâce au 1 / sin θ et à la concentration de la puissance.
- **Diffusion vers l'avant :**
  - deux lobes : un très avant (g ≈ 0,8) et un plus doux ;
  - ou Henyey-Greenstein + Draine, qui colle mieux à la fumée réelle ;
  - à mesurer : c'est l'effet « beaucoup plus brillant face au laser ».
- **Volutes dans les nappes : le travail principal (« Laser Fog Fluid » de Depence).**
  - La texture de détail actuelle (64³, 11 cm par point sur 7 m) est trop grossière pour la photo en gros plan. Il faut des filaments de l'ordre du centimètre.
  - Nouvelle texture 3D périodique de fumée fine : 128³, compressée en 1 octet.
    - Générée au lancement : bruit « curl » à plusieurs octaves, avec une déformation de domaine pour les filaments.
    - Ou mieux : une courte simulation de fluide hors ligne, en boucle.
  - **Animation :**
    - les volutes avancent avec le vent de la simulation ;
    - elles se tordent par mélange de deux phases décalées (méthode « flow map » de Valve, en 3D) ;
    - aucune simulation fine à chaque image.
  - **Une seule lecture par (pixel, segment)**, au point P : la nappe est une coupe de la fumée. Les traits fins traversent la même fumée, donc leur brillance varie le long du trait.
  - **Niveau de détail selon la taille du pixel en P :**
    - une nappe vue en rasant compresse les volutes : on lit un niveau plus flou pour éviter le scintillement ;
    - au loin, on garde seulement les gros amas.
  - **Réglages :** volutes (intensité), taille, structure (contraste, filaments), vitesse, et intensité des faisceaux atmosphériques, comme dans Depence.

### 4.1 Détail de la texture de volutes fines

- **Pourquoi.** La fumée actuelle a deux niveaux :
  - les amas simulés, en cases de ~1,5 m ;
  - le détail 64³ sur 7 m (11 cm par point), en bruit « coton » qui glisse avec le vent.
  
  En gros plan, une nappe de 2 m n'en montre que des taches floues. La photo 5 montre des filaments et des enroulements de 1 à 5 cm, à bords contrastés, avec des trous sombres.
- **Contenu.** Volume 3D périodique 128³, couvrant ~1,6 m (1,2 cm par point).
  - BC4 (4 bits par point, 1 Mo) si `sokol` le permet en 3D, sinon R8 (2 Mo). Mipmaps.
  - **Version A (procédurale, au lancement) :**
    - bruit déformé par un champ « curl » (sans divergence, donc étiré comme un fluide) ;
    - bruit « ridged » (1 − |bruit|), dont la coupe par un plan donne des lignes fines ;
    - contraste resserré.
  - **Version B (mini-simulation de fluide, au lancement ou hors ligne) :**
    - bouffées de fumée injectées dans une boîte périodique 128³ ;
    - transportées par un champ tourbillonnaire pendant quelques centaines de pas ;
    - l'étirement crée de vrais filaments.
  - Commencer par A, comparer à B sur le cas L5 et la photo 5, et ne garder B que si l'écart est nettement visible.
- **Lecture.**
  - Deux octaves de la même texture : ~1,6 m et ~0,45 m. Échelles non entières et axes tournés, pour qu'aucune répétition ne se voie.
  - Une lecture par (pixel, segment) au point P, deux en gros plan.
- **Animation, sans simulation fine à chaque image :**
  - transport par le vent de la simulation de la pièce ;
  - **deux phases décalées** (méthode des « flow maps » de Valve) : la texture est lue à deux instants décalés d'une demi-période (4 à 8 s), mélangés en triangle. Les volutes se tordent et se défont au lieu de glisser comme un décor, sans s'étirer à l'infini ;
  - un champ de vitesse tourbillonnaire lent (16³ ou analytique) pour les enroulements locaux ;
  - la petite octave bouge plus vite que la grande (cascade turbulente).
- **Lien avec la fumée de la pièce :**
  - densité = densité de la pièce (amas, brume) × modulation fine de moyenne 1. La brillance moyenne ne change pas, seule sa répartition change ;
  - force de la structure ∝ part d'amas dans la densité locale : brume de hazer → volutes faibles ; nuage de machine à fumée → volutes fortes ;
  - lasers seulement : dans les cônes larges des lyres, ce détail se moyenne sur la traversée et serait invisible, pour un coût dans leur passe la plus chère.
- **Sans scintillement :**
  - niveau de mip choisi selon la taille du pixel en P, divisée par |n·v| (nappe vue en rasant = plus flou) ;
  - contraste de la petite octave réduit au loin.
- **Bonus.** Les traits fins traversent la même texture : leur brillance varie le long du trait, ce qui donne l'aspect perlé et vivant des vrais faisceaux.
- **Coût estimé :**
  - pire cas (~170 millions de couples) : ~0,5 à 1,5 ms de lectures 3D, compris dans l'estimation du 5.3 ;
  - leviers : une seule octave au loin, rien sous un seuil de contribution, BC4.
- **Vérification :**
  - cas L5 en face de la photo 5, même cadrage ;
  - agrandissements ;
  - courte séquence en mouvement (scintillement, glissement) ;
  - vue de loin (répétition).

## 5. Rendu : une passe de calcul par tuiles d'écran (pas de mélange additif)

### 5.1 Pourquoi pas des triangles dessinés en addition

C'est la méthode simple (celle du laser web et des photon beams), mais elle coûte trop cher en 4K :

- 200 nappes qui couvrent chacune 10 % de l'écran représentent ~170 millions de pixels à additionner ;
- en RGBA16F, chaque pixel est lu puis écrit (16 octets) : ~2,7 Go par image, soit ~8 ms rien qu'en mémoire sur une GTX 1080 ;
- le README le note déjà : l'addition des cônes de fumée est ce qui coûte le plus pour les lyres.

### 5.2 Méthode retenue : chaque pixel calcule tous ses lasers d'un coup

1. **CPU : moteur laser.**
   - Effets, mouvements, figures → liste de segments (≤ 8 192), avec la puissance par couleur, le profil et le flou de mouvement (voir 8).
   - Envoyée au GPU dans un tampon (sb_laser, compact : la taille de la structure coûte, voir PERFORMANCE.md).
2. **Calcul GPU : portées des traits** (voir 7).
   - Pour chaque segment, jusqu'à 1 024 rayons (un par trait si n ≤ 1 024) contre le sol, les murs, les pavés et les joueurs.
   - Résultat : une table de portées par segment.
3. **Calcul GPU : tri par tuiles** (16 × 16 pixels).
   - Pour chaque tuile, la liste des segments dont le triangle (élargi du halo) la touche, et dont la profondeur est devant le fond de la tuile.
   - En deux niveaux (grosses tuiles de 128 px, puis tuiles de 16 px), comme le tri des lyres par cases.
4. **Calcul GPU : lasers dans la fumée, pleine résolution.**
   - Chaque groupe de 16 × 16 pixels charge les segments de sa tuile en mémoire partagée.
   - Chaque pixel les additionne dans ses registres, puis écrit **une seule fois**.
   - Il n'y a ni lecture ni écriture par segment, et la profondeur de la scène est lue une fois.
5. **Impacts** sur les surfaces (points et lignes, voir 7) et **sorties** (éclat de chaque boîtier) : petits dessins instanciés.
6. La couche laser est ajoutée après la composition (avec la transmission de la fumée), avant le bloom.

### 5.3 Estimation (à vérifier par la mesure, étape 1)

- **Pire cas du banc** (200 nappes en mouvement, ~170 millions de couples pixel–segment) :
  - ~60 instructions par couple, soit ~10 milliards ;
  - plus une lecture 3D de fumée par couple ;
  - **≈ 2,5 à 4 ms**, contre ~8 ms en addition.
- **Si c'est trop :**
  - calculer la partie lisse (nappe et volutes) à demi-résolution et garder les traits nets en pleine résolution, comme les tiers des lyres ;
  - ignorer les segments de contribution négligeable ;
  - qualité adaptative (finesse des volutes au loin).
- À vérifier tôt : les opérations atomiques en mémoire partagée avec `sokol-shdc` sous Direct3D 11. Sinon, compaction par sommes préfixes, comme `cs_beam_tables`.

## 6. Le blanc à la sortie et dans les traits

- **Énergie :** la nappe a une intensité en Φ / (α · r). Près de la source elle est énorme, ce qui explique le blanc à la sortie. Un trait concentre toute la puissance : il est plus blanc que la nappe. Rien à forcer, si l'énergie est conservée.
- **Réponse du capteur (nouveau)** : c'est ce qui donne rouge → orange → jaune → blanc sur la photo 1.
  - Une petite matrice de fuite entre canaux, déduite de la longueur d'onde (638 / 520 / 450 nm) :
    - un rouge laser donne aussi un peu de vert et un soupçon de bleu ;
    - un vert donne un peu de rouge et de bleu.
  - L'ACES actuel sature canal par canal : le rouge sature d'abord, puis le vert, puis le bleu, et la couleur tire vers le blanc **seulement quand c'est très intense**.
  - Appliquée à la couleur émise par chaque laser : rien à calculer en plus par pixel.
  - Réglage « blanchiment » : 0 = œil (couleurs pures), 1 = caméra (comme les vidéos Depence).
- **Luminosité perçue :** à puissance égale, le vert paraît beaucoup plus lumineux que le rouge et surtout que le bleu (efficacité lumineuse 0,71 / 0,19 / 0,04). La puissance se règle en watts par couleur, avec des préréglages « 1 W club », « 5 W », « 20 W festival ».
- **Sorties :**
  - point très chaud, de la taille de l'ouverture ;
  - halo, plus une étoile à branches (lamelles, rotation, seuil, comme le « Glow & Glare » de Depence) proportionnelle à la puissance qui part vers la caméra ;
  - un trait braqué sur la caméra fait une sortie aveuglante, un éventail qui passe à côté seulement un point vif.

## 7. Intersections : obstacles, sol, murs, joueurs

- **Portée de chaque trait** (calcul GPU à chaque image) : rayons contre le sol, les parois du hangar, les pavés existants (`Scene::occluders` : scène, mur LED, stacks, régie, cube suspendu, mannequins) et le personnage (mode F, sous forme de capsule).
  - 200 lasers × 1 024 rayons ≈ 200 000 rayons, contre ~40 pavés : ~0,1 à 0,3 ms.
  - Exacte par trait ; interpolée entre deux rayons pour une nappe.
- **Dans la fumée :** un pixel ne reçoit la lumière que si r < portée(θ).
  - Le trait s'arrête net sur l'obstacle.
  - Une personne dans une nappe y découpe un **trou d'ombre** à bord net. C'est très visible sur les vrais shows : la portée par angle le donne gratuitement.
- **Impacts :**
  - points (traits) et lignes (nappes qui coupent un mur ou le sol), éclairés selon la couleur de la surface, avec le reflet du sol brillant ou mouillé ;
  - 200 000 petits points de quelques pixels : bon marché ;
  - le bloom fait leur halo.
- **Lumière dans la pièce :** quelques lumières virtuelles par laser (impacts, et le long des nappes) envoyées dans les sondes existantes. Les murs et la fumée prennent la couleur des lasers. *(fait le 19 octobre 2026, option `lasergi`, active par défaut : voir « Étape 7 (en partie) » à la fin)*
- **Plus tard :** reflet des lasers dans le sol mouillé (caméra miroir déjà en place), et miroirs.

## 8. Mouvements et réglages (onglet « Lasers »)

**Réglages de base, demandés :**

- ouverture de l'éventail, de 0 (un seul point, tous les traits confondus) à l'angle maximal du boîtier (50 à 60°) ;
- nombre de traits (1 à 1 000 et plus), et mélange traits ↔ nappe continue ;
- intensité de l'éventail (dimmer, et puissance du boîtier en W par couleur) ;
- couleur (sélecteur RGB) ;
- dégradé le long de l'éventail : 2 ou 3 couleurs, fixe, défilant, arc-en-ciel, ou aléatoire par trait.

**Formes :**

- éventail ;
- double éventail ;
- cône (cercle de traits) ;
- tunnel ;
- vague (traits qui ondulent) ;
- réseau de diffraction ×3 / ×5 / ×9 ;
- grille de points (plusieurs éventails).

**Mouvements automatiques** (ou position fixe) :

- position pan / tilt de la figure, rotation autour de l'axe (roll) ;
- balayages : sinus, triangle, cercle, 8, aléatoire ;
- rotation continue ;
- pulsation de l'ouverture ;
- chenillard de traits (vague de traits allumés), strobe.

Comme pour les lyres, chaque effet a sa forme d'onde, sa vitesse, son amplitude, un décalage de phase sur la sélection et des ailes. On réutilise le moteur d'effets des lyres, pour un panneau identique.

**Physique du boîtier :**

- divergence, diamètre de sortie, angle maximal ;
- inertie simple des galvos sur les mouvements de la figure ;
- bords lumineux.

**Flou de mouvement (persistance) :**

- Un trait qui tourne vite en 1/120 s balaie un angle : il est rendu comme une petite nappe entre sa position précédente et la nouvelle, avec la même énergie.
- Un éventail qui balaie perpendiculairement à son plan reçoit une épaisseur angulaire.
- Sans cela, un balayage rapide « saute » d'image en image (stroboscopie). Depence R4 a ajouté le flou de mouvement.
- Réglage : œil (~33 ms) ou caméra (temps de pose court).

**Placement :**

- 200 boîtiers sur les trusses, le pont de scène et le nez de scène, en sélection par groupes comme les lyres ;
- vues d'essai `--demo laser N` : nappe en gros plan avec volutes, sortie vue de face, trait dans l'œil, personne dans une nappe.

**Plus tard :** ILDA et DMX, en reprenant `docs/laser2-cahier-des-charges.md` (36 canaux, moteur de points). Les segments d'éventail sont justement la forme compacte de ce que produirait le moteur de points.

## 9. Éblouissement

- **Calcul sur le CPU, par segment :**
  - distance de l'œil (la caméra) au trait le plus proche, comparée au rayon du faisceau à cette distance ;
  - éclairement reçu = puissance du trait × gaussienne ;
  - « œil » de taille réglable : 7 mm en vrai, quelques cm pour que ce soit perceptible en jeu.
- **Intégré sur le temps de l'image**, avec le balayage : un faisceau qui passe donne un flash bref, un faisceau fixe donne un éblouissement fort et durable.
- **Effets :**
  - étoile et halo géants centrés sur la sortie (même éclat qu'au 6, agrandi) ;
  - voile blanc sur toute l'image ;
  - baisse d'exposition qui revient en ~1 s (adaptation) ;
  - en option, une image rémanente colorée qui s'efface.
- Même si la sortie est hors de l'écran : voile et flash.

## 10. Mesures : un nouveau banc d'essai pour les lasers

C'est un banc séparé du banc des lyres actuel, à construire **dès l'étape 1**, avant d'optimiser quoi que ce soit.

- **Lancement :** `LyreViz.exe --bench-lasers`.
  - Mêmes options que le banc des lyres : `--fast`, `--static`, `--quick`, `--fullscreen`, `--set`, `--benchdir`, `--stats`.
  - Pas de temps fixe et animations déterministes : deux lancements donnent les mêmes images.
- **Cas :**

  | Cas | Contenu | Vues |
  |---|---|---|
  | L1 | 200 lasers × 1 000 traits, éventails en mouvement (balayage + rotation) | public, scène, sous les trusses |
  | L2 | 200 lasers en cônes (32 segments chacun : 6 400 segments) | public, scène |
  | L3 | caméra au milieu des nappes (plus grand recouvrement) | 1 vue |
  | L4 | 200 lasers × 8 traits (traits séparés et nets) | public |
  | L5 | nappes dans une fumée épaisse, volutes au maximum, gros plan | 1 vue (comme la photo 5) |
  | L6 | traits coupés par les obstacles et le personnage, impacts au sol | public |
  | M1 | mix : 100 lyres par défaut + 100 lasers | public, scène, sous les trusses |
  | — | L1 en coupant chaque option une par une (volutes, portées, impacts, éblouissement, flou de mouvement, blanchiment) | public |

- **Sorties** dans le même format que le banc des lyres, pour que les outils existants servent sans changement :
  - `resultats.txt` : temps GPU par passe, avec un `gpuprof::mark` pour chaque nouvelle passe laser (moteur CPU, portées, tri par tuiles, lasers dans la fumée, impacts, sorties, éblouissement) ;
  - `images.csv` et une image `.bmp` par cas.
  - Compteurs propres aux lasers : nombre de segments et de traits, segments par tuile (moyenne et maximum), couples pixel–segment évalués, temps CPU du moteur laser.
- **Outils :**
  - `tools\perf_ab.ps1` et `tools\set_ab.ps1` : ajouter une option `-Lasers` qui lance `--bench-lasers` au lieu de `--bench` ;
  - `tools\compare_bench.py` (PSNR, images d'écart) et `tools\historique.py` doivent accepter ces dossiers ;
  - dans l'historique, une colonne ou une feuille distingue les cas laser des cas lyres.
- **Valeurs de référence :** une section « Lasers » dans `PERFORMANCE.md`, remplie à la fin de l'étape 1, puis tenue à jour.
- **Règles :** celles de `CLAUDE.md` et `PERFORMANCE.md`.
  - Banc rapide par défaut, alternance A/B, aucune autre instance ouverte.
  - Chaque fonction activable (case dans l'onglet Rendu et `--set`) et mesurée seule.
  - Images vérifiées (PSNR, agrandissements des traits fins, des volutes et des sorties).

## 10 bis. Images de référence

Dans `docs/references-lasers/` :

| Fichier | Ce qu'il faut y regarder |
|---|---|
| `1-photo-reelle-eventails-rouges-blanc-sortie.webp` | Vraie photo : nappes rouges, jaune puis blanc près des sorties, pièce teintée en rouge, volutes dans les nappes |
| `2-depence-eventails-verts-festival.webp` | Depence : des centaines de traits verts fins qui se croisent, blanc aux sorties, éventails en couches |
| `3-depence-grille-au-sol-feux-artifice.webp` | Depence : grille de traits verts au sol (impacts et nappes rasantes) |
| `4-depence-eventails-jaunes-sorties-blanches.webp` | Depence : éventails jaunes, sorties saturées en blanc, traits nets |
| `5-depence-nappe-gros-plan-volutes.png` | Depence : gros plan d'une nappe, volutes fines contrastées, bords plus lumineux |

Vidéo : « Royallaser | Depence R3 Showcase » (Syncronorm), https://youtu.be/M31Exa5mOwg.

**Budget visé :**

- **Lasers seuls :**
  - surfaces ~1,5 ms + fumée simulée et post-traitement ~1 ms (sans les lyres, plus de tables ni de cônes) ;
  - laisse ~5 ms aux lasers (L1 à L3) ;
  - l'estimation du 5.3 (2,5 à 4 ms) y entre.
- **Mix :**
  - 100 lyres ≈ 3 à 3,5 ms (la moitié du cas actuel, hors parties fixes) ;
  - 100 lasers ≈ 1,5 à 2 ms ;
  - ~8 ms au total : serré, à vérifier dès l'étape 1.

## 11. Étapes (une modification mesurée à la fois)

1. **Banc laser et prototype mesuré.** *(fait le 15 octobre 2026 : tuiles en calcul retenues)*
   - D'abord le banc `--bench-lasers` (section 10) et l'option `-Lasers` des scripts.
   - Puis le segment d'éventail analytique (traits + nappe, densité uniforme) en deux versions : triangles en addition, et tuiles en calcul.
   - Bancs L1 à L4 : on choisit la voie sur les chiffres, pas sur l'estimation.
2. **Moteur et panneau.** *(fait le 15 octobre 2026)*
   - Boîtiers, placement des 200, réglages de base (ouverture, traits, intensité, couleur, dégradé), formes, mouvements automatiques, effets décalés ;
   - vues `--demo`, bancs.
3. **Fumée.** *(faite le 15 octobre 2026)*
   - Lien avec la fumée de la pièce, visibilité minimale, diffusion avant ;
   - nouvelle texture de volutes fines animées, niveaux de détail.
   - C'est l'étape la plus longue côté réglage visuel (gros plan de la photo verte, comparaisons à la vidéo).
4. **Blanc.** Réponse du capteur, sorties (point chaud, halo, étoile), bords lumineux, divergence. *(blanchiment et lueur de sortie faits le 15 octobre 2026 : voir « Étape 4 (en partie) » à la fin)*
3 bis. **Lecture ILDA** (étape 8 avancée, demande de l'utilisateur du 15 octobre 2026 : « le but final, un laser qui lit de l'ILDA, le plus optimisé possible ») : voir la section « Étape 3 bis » à la fin.
5. **Intersections.** *(collisions et impacts faits le 15 octobre 2026 : voir « Étape 5 » à la fin)* Portées par trait, ombres dans les nappes, impacts sur les surfaces, personnage. **Rappel de l'utilisateur (15 octobre 2026)** : gérer la collision avec tous les obstacles (joueur, décor, etc.), et **la nappe laser doit se couper au passage d'un joueur** (trou d'ombre à bord net, section 7).
6. **Éblouissement.**
7. **Persistance et lumière dans la pièce.** Flou de mouvement, lumières virtuelles dans les sondes, puis reflet dans le sol mouillé. *(lumières virtuelles faites le 19 octobre 2026 : voir « Étape 7 (en partie) » à la fin)*
8. **Plus tard.** DMX, inertie complète des galvos (cahier laser2) ; l'ILDA est avancé en 3 bis.
9. **Moteur de tracé unique** (demande de l'utilisateur du 15 octobre 2026) : toute figure devient un tracé de scanner (points ILDA), rendu en arcs et en droites raccordés ; remplace les formes codées une à une. *(9a à 9d faits le 15 octobre 2026 ; coût de la passe des arcs à décider avec l'utilisateur : voir « Étape 9 : résultats » à la fin)*

## 12. Sources

- Manuel Depence, réglages laser : https://help3.depence.com/depence-rendering/depence-render-settings/depence-laser-render-settings
- Manuel Depence, post-traitement (Glow & Glare) : https://help3.depence.com/depence-rendering/depence-render-settings/depence-post-fx.md
- Jarosz et al., *Progressive Photon Beams* (2011), formule faisceau × rayon : https://cs.dartmouth.edu/wjarosz/publications/jarosz11progressive.pdf
- Lignes fines sans escalier (« phone-wire AA », Persson) : https://geeks3d.com/?p=8334
- ILDA, fumée et brume : https://www.ilda.com/hazefoglasers.htm
- Curl noise (Bridson 2007) : https://www.dneg.com/wp-content/uploads/2022/11/2007.pdf
- Flow maps (Vlachos, Valve 2010) : https://www.advances.realtimerendering.com/s2010/Vlachos-Waterflow(SIGGRAPH%202010%20Advanced%20RealTime%20Rendering%20Course).pdf
- Éblouissement : Spencer et al. 1995 (https://w1.graphics.cornell.edu/pubs/1995/SSZG95.pdf), Ritschel et al. 2009 (https://resources.mpi-inf.mpg.de/hdr/TemporalGlare/)
- Fiche Kvant ClubMAX (ouverture, divergence, longueurs d'onde) : https://cdn.shopify.com/s/files/1/2680/6950/files/Clubmax_10_FB4.pdf

## Étape 1 : résultats (15 octobre 2026)

Détail des mesures : `PERFORMANCE.md`, section « Lasers ». Historique : modifications 11, 11a, 11b.

- **Banc `--bench-lasers`** : cas L1 à L6, M1 (3 vues) et la scène sans lasers ; même format que le banc des lyres ; option `-Lasers` de `perf_ab.ps1` et `set_ab.ps1` ; colonnes « Lasers (ms) » et « Banc » dans l'historique ; `perf_report.py` affiche aussi les passes qui n'existent que dans B.
- **Les deux versions donnent la même image** (PSNR 64 à 70 dB), sauf quand la caméra est à quelques centimètres d'une nappe : les triangles ne la dessinent pas (caméra dans le prisme).
- **Tuiles en calcul retenues** : lasers seuls, L1 7,8 ms contre 12,3 ms en triangles (−36 %), de −25 à −43 % selon les cas ; image entière de −16 à −28 %. Le mélange additif des triangles coûte à lui seul ~2,8 ms sur L1.
- **Encore au-dessus du budget** (4,6 ms pour les lasers seuls) : L1 7,8 ms, L2 9,5 ms, L3 5,6 ms ; mix M1 8,6 à 10,8 ms au total (après l'optimisation du 15 octobre : voir plus bas). Pistes sans dégradation d'image : `PERFORMANCE.md`, « Pistes pour la suite ».
- **Ce qui diffère de l'estimation du 5.3** : ~185 millions de couples sur L1 (prévu ~170), mais ~40 ps par couple au lieu de ~15 : les opérations spéciales (divisions, racines, exponentielles) et la boucle elle-même pèsent plus que prévu.
- **Écarts au plan, sans changer les décisions** :
  - les cas « L1 en coupant chaque option » viendront avec les options ; une base « scène sans lasers » est ajoutée ;
  - L5 et L6 mesurent ce qui existe (pas encore de volutes, de portées ni d'impacts) ; le cadrage de L5 sur la photo 5 se fera à l'étape 3 ;
  - largeur minimale d'un trait : sigma de 0,6 pixel (réglable, `--set laserwidth`) ; l'ondulation des traits s'efface quand leur écart à l'écran approche 2 pixels (anti-moiré) ;
  - puissance provisoire (20 unités de flux par W, comme les lyres) jusqu'à l'étape 4 ;
  - la version triangles a été retirée du code (15 octobre 2026), après accord de l'utilisateur.

### Optimisation des tuiles (15 octobre 2026)

Détail : `PERFORMANCE.md`, « Optimisation des tuiles » ; historique 12.

- **Gardé** : éventails de 16 traits au plus découpés en traits seuls, avec un test de leur bande à l'écran (L4 : 7,5 → 1,2 ms) ; nappe lisse allégée ; moteur CPU des cônes 1,5 → 0,8 ms.
- **Écarté après mesure** : interpolation de la lumière sur les tuiles intérieures (2 versions : trop peu de tuiles concernées, classement coûteux), 1 ou 4 pixels par fil, boucle non déroulée.
- **Constat** : la passe est limitée par le calcul et par les registres ; un éventail de 1 000 traits vu de près montre réellement ses traits (60 % des couples sur L1), ce qui demande un calcul par pixel.
- **État** : L1 5,2 – 7,6 ms, L2 8,5 ms, L3 5,2 ms, L4 1,2 ms pour ~4,6 ms disponibles ; mix M1 8,1 – 10,2 ms. Les pistes restantes (`PERFORMANCE.md`) promettent peu : la suite du plan (étape 2) peut commencer, en gardant ces cas sous surveillance.

## Étape 2 : résultats (15 octobre 2026)

Détail des mesures : `PERFORMANCE.md`, « Étape 2 : moteur et panneau ». Historique : modification 13.

- **Boîtiers** : 200, fixes, axe d'accroche par groupe ; la figure se place dans le champ du scanner (pan, tilt, roulis, angle maximal 60° réglable), avec l'inertie des galvos (constante de temps, 8 ms par défaut). Corps dessinés (pavé sombre, sortie claire).
- **Programmeur** (onglet Lasers, même principe que les lyres) : sélection, dimmer, strobe, couleur, dégradés (2 ou 3 couleurs, défilant, arc-en-ciel, au hasard par trait), formes (éventail, double éventail, cône, tunnel, vague, grille de points), ouverture de 0 (un point) à l'angle maximal, 1 à 2 000 traits, réseau de diffraction ×3 / ×5 / ×9, rotation continue ; réglages des boîtiers (puissance, diamètre de sortie, divergence, inertie).
- **Effets** (moteur des lyres : forme d'onde, vitesse, amplitude, décalage, ailes) : vagues pan et tilt, cercle, huit, balayage aléatoire, éventail des figures, roulis, pulsation de l'ouverture, chenillard de traits, chenillard d'intensité, arc-en-ciel, alternance de couleurs.
- **Rendu** : chaque segment a une couleur à chaque bord (dégradé linéaire) ; une figure en dégradé est découpée en morceaux (au moins un par 15° d'ouverture, 12 pour un dégradé qui défile ou un chenillard). Deux variantes du shader : une programmation sans dégradé ne paie rien.
- **Vues d'essai** : `--demo-laser 0` (formes), `1` (dégradés), `2` (programmation de démonstration) ; option `--cam` pour cadrer ; cas **L7** du banc (la démonstration sur 194 lasers) ; option `--cases` du banc (seulement certains cas).
- **Mesures** : L1 à L6 et M1 inchangés (dans le bruit). L7 : 15,4 ms de lasers seuls (349 millions de couples, 42 segments par pixel) : le coût suit la surface couverte à l'écran, le coût par couple est le même que pour L1.
- **À faire plus tard : alléger L7** (décision de l'utilisateur, 15 octobre 2026 : on continue d'abord le plan, étape 3). Pistes : `PERFORMANCE.md`, « Pistes pour la suite ».
- **Écarts au plan, sans changer les décisions** :
  - la puissance reste en W par boîtier (pas encore par couleur) et les bords lumineux viennent avec le blanc (étape 4) ;
  - le flou de mouvement des balayages rapides reste à l'étape 7 ;
  - les vues d'essai de la section 8 (nappe en gros plan avec volutes, sortie vue de face, trait dans l'œil, personne dans une nappe) viendront avec les étapes 3, 4, 6 ; `--demo-laser` montre pour l'instant les formes, les dégradés et la démonstration.

## Étape 3 : résultats (15 octobre 2026)

Détail des mesures : `PERFORMANCE.md`, « Étape 3 : fumée » ; historique : modifications 14 à 19. Images : `bench/lasers_images/etape3_*.png`.

- **Fumée de la pièce** : diffusion en P = air + densité × albédo × (brume × décroissance en hauteur + amas simulés), préparée sur le CPU dans le 2e canal de la texture des amas des lyres (RG8) ; une lecture et 2 opérations par couple. Un laser qui traverse un amas s'y illumine.
- **Visibilité minimale** : la diffusion de l'air (`laserair`, étape 1) s'ajoute à la fumée.
- **Diffusion vers l'avant** : deux lobes de Henyey-Greenstein (g 0,88 pour 42 %, g 0,35), même brillance de côté qu'un lobe g 0,55, 7 fois plus dans l'axe. Draine non essayé : deux lobes suffisent pour l'effet « face au laser ».
- **Volutes fines** : texture 3D périodique 64³ en BC5 (2 instants d'une boucle d'évolution, 1 octet par texel), générée au lancement (version A du plan : bruit déformé deux fois, contraste par seuil) ; 1re octave de 1,6 m, 2e octave de 0,44 m de près ; mip selon la taille du pixel étirée par 1 / |n·v|, effacement au loin ; plus fortes dans les amas que dans la brume.
- **Vue d'essai** `--demo-laser 3` : un éventail vert vu de près dans une fumée épaisse, à comparer à la photo 5.
- **Variantes du shader** (0 à 3) choisies à chaque image : tout coupé, le code et la vitesse d'avant l'étape 3.
- **Coût** (lasers seuls) : niveau 1 (fumée de la pièce + 2 lobes) +8 à +14 % ; volutes +25 à +35 % de plus. Tout actif, en mouvement : L1 7,1 à 10,2 ms, L2 12 ms, L3 7 ms, L7 20,6 ms (budget ~4,6 ms) ; mix M1 9,2 à 11 ms au total.
- **Réglages par défaut** : tout actif (choix laissé à Claude par l'utilisateur, « on modifiera après »). `--set volutes=0` revient au niveau 1, `laserfog=0 laserphase=0 volutes=0` à l'image d'avant.
- **Écarts au plan, sans changer les décisions** :
  - 64³ en BC5 avec 2 instants, au lieu de 128³ (1 octet) avec 4 instants : en RGBA8, la passe était 60 à 90 % plus lente (mémoire et attente des lectures) ; 128³ en BC5 ne gagne presque rien en image ;
  - les lasers ne lisent pas la texture de détail « coton » des lyres (les volutes la remplacent ; une 2e lecture 3D coûtait 20 à 25 %) ;
  - version B (mini-simulation de fluide) non faite : la version A ressemble déjà à la photo 5 de près ; à revoir si le gros plan ne suffit pas ;
  - L5 garde son cadrage (pour comparer avec l'historique) : la comparaison à la photo 5 se fait avec `--demo-laser 3` ;
  - pas de comparaison à la vidéo Depence R3 (Claude ne peut pas lire une vidéo) ; seulement aux photos.
- **Pistes** : volutes encore chères dans les cas lourds ; un cas de banc « L1 sans volutes » permettrait de mesurer leur coût dans le même lancement.

## Étape 3 bis : lecture ILDA (demande de l'utilisateur, 15 octobre 2026)

L'utilisateur veut, comme le laser 2 du simulateur web (`src/laser2/`, `docs/laser2-cahier-des-charges.md`), des lasers qui lisent des fichiers ILDA, de la façon la plus optimisée possible : un laser fait en général des traits (faisceau fixe) ou une nappe lisse (balayage).

Ce que fait le laser 2 web (relevé du 15 octobre 2026) :
- lecture des formats 0, 1, 2, 4, 5 (bit 6 : point masqué, conservé), bibliothèque du serveur (`server/storage/ilda`, 56 fichiers), ILDA en direct par IDN ; cadence réglable (30 images/s par défaut) ;
- scanner « laser parfait » (sans inertie depuis le commit `40e1d87`) : transformations, angle maximal, équilibrage des couleurs ;
- **réduction de chaque image en deux primitives** : *faisceau* (le point reste à moins d'une tolérance du précédent : énergie concentrée, position moyenne) et *nappe* (segment entre deux points allumés, énergie des points répartie sur l'angle balayé) ; nappes colinéaires fusionnées (écart, retour, espacement, niveau, teinte), budget de primitives par laser et global avec tolérance adaptative.

Correspondance avec LyreViz : une nappe ILDA est un segment d'éventail en nappe lisse ; un faisceau, un trait seul. Plan proposé (accepté par l'utilisateur) :
1. lecteur ILDA en C++ (formats 0, 1, 2, 4, 5), lecture directe de `server/storage/ilda` ; lecture en boucle, aller-retour, image fixe ;
2. scanner « laser parfait » comme le web (inertie des galvos actuelle en option) ;
3. réduction en traits seuls et nappes, reprise du web, budget de 8 192 segments ; des faisceaux régulièrement espacés sur une ligne regroupés en un seul segment à n traits ;
4. variante du shader « nappes et traits seuls », sans le code des traits séparés (attendu ~−20 % sur les nappes, mesure de l'étape 1) ;
5. le programmeur actuel reste ; ses figures pourront aussi passer par des images de points ;
6. bancs avec de vrais fichiers ILDA (nappes, tunnels, texte, faisceaux) et un cas « L1 en mode ligne » ; chaque étape mesurée.

### Étape 3 bis : résultats (15 octobre 2026)

Détail des mesures : `PERFORMANCE.md`, « Fichiers ILDA » ; historique : modification 20. Images : `bench/lasers_images/ilda_*.png`.

- **Fait** : lecteur ILDA en C++ (`src/ilda.cpp`, formats 0, 1, 2, 4, 5), bibliothèque `server/storage/ilda` lue directement (56 fichiers, 8 banques), complément des traits et réduction en faisceaux et nappes repris du web, en cache par image du fichier ; source « Fichier ILDA » dans l'onglet Lasers (fichier, lecture, cadence, couleurs) avec tous les réglages de position, de taille et les effets ; vue `--demo-laser 4` ; bancs I1 à I4 (une banque par cas, 200 lasers) ; **mode ligne** (0 trait = nappe continue) et cas « L1 en mode ligne ».
- **Plafond des segments porté à 16 384** : à 8 192, les figures ILDA chargées de 200 lasers étaient tronquées sans bruit (I3 voulait 12 660 nappes) ; compteur des segments perdus dans le tri par grosses tuiles (`--stats`) : 0 sur tous les cas.
- **Écarts au plan** :
  - point 3 (« des faisceaux régulièrement espacés regroupés en un segment à n traits ») : non fait ; les traits seuls sont déjà le chemin le moins cher (bande à l'écran), le regroupement ferait passer par le calcul des traits séparés ;
  - point 4 (variante du shader « nappes et traits seuls ») : faite, mesurée, **retirée** : aucun gain (images identiques, temps à ±2 %) ; le −20 % de l'étape 1 ne se retrouve pas avec le code de la fumée de l'étape 3 ;
  - pas d'ILDA en direct (IDN) ni de choix par DMX : à faire avec le DMX.
- **Coût** : faisceaux (I2) 1,9 ms ; nappes, figures, tunnels sur 200 lasers 31 à 49 ms : la surface couverte (jusqu'à 1 milliard de couples pixel × segment), pas la lecture du fichier (moteur CPU 1,2 à 2,3 ms). À alléger avec L7 (mêmes pistes).

## Étape 5 : résultats (15 octobre 2026)

Détail : `PERFORMANCE.md`, « Étape 5 : collisions et impacts » ; historique 21 et 22.

- **Collisions** : les traits s'arrêtent sur les pavés (décor, mannequins, personnage en mode F) ; dans une nappe, chaque pavé proche est coupé par le plan de l'éventail, et l'éventail est découpé aux angles de ces coupes, chaque morceau s'arrêtant exactement sur l'arête du pavé : trou d'ombre à bord net. Sur le CPU, coût GPU dans le bruit. `--set lasercoll=0` pour couper.
- **Impacts** : passe « lasers : impacts » ; la ligne d'arrivée de chaque morceau (sol, murs, plafond, faces des pavés) ou le point d'un trait, dessinés par pixel (distance 3D au plan de la nappe ou à l'axe du trait). +0,5 à +2,8 ms sur L1 à L7. `--set laserimpacts=0` pour couper.
- Vue d'essai `--demo-laser 5` : une nappe verte à hauteur de poitrine à travers les mannequins et le personnage.

## Nappes coniques exactes : résultats (15 octobre 2026)

Demande de l'utilisateur : aucun cercle, sinus ni cône fait de traits droits, avec un rendu des nappes identique (lumière, bords, fumée). Détail : `PERFORMANCE.md`, « Nappes coniques exactes » ; historique 23.

- **Primitive** : nappe conique exacte (`laser_arc`) : les directions passent par un cercle du plan de projection du scanner ; intersection du rayon de la caméra avec le cône (équation du 2e degré), même lumière que les nappes planes (traits, fumée, volutes, diffusion avant). Cônes et tunnels en morceaux de 90° au plus ; impacts en arcs exacts.
- **Silhouettes** sans escalier (rayon qui frôle la nappe), enveloppe à l'écran coupée comme celle des segments droits, base posée sur la paroi du hangar, passe des arcs à part (un pixel par fil), rejet de l'autre côté du cône.
- **Coût** : L2 +0,9 ms, L7 +3,5 ms à l'image (première version des arcs : +7,7 ms sur L2).
- **Écarté** : biarcs pour la vague et les fichiers ILDA (une paire d'arcs par corde) : beaucoup trop cher (35 à 45 ms GPU et 64 à 116 ms CPU sur les bancs ILDA). C'est ce qui a conduit à l'étape 9.

## Étape 9 : moteur de tracé unique (plan du 15 octobre 2026, validé)

### Demande

L'utilisateur (15 octobre 2026) : au lieu de traiter les formes une à une (cônes, sinus…), un seul moteur de laser qui marche pour **n'importe quelle forme**, en partant du principe qu'un laser **projette de l'ILDA** : les formes (et les volutes dans la fumée) en découlent. Le cas le plus dur : le **dessin au crayon** de son logiciel ILDA (tracé arbitraire de l'utilisateur, à rendre fidèlement), mais aussi carré, étoile, cœur, lignes, points, sinus qui se déplacent et sont modulés. Le rendu peut changer un peu ; il doit rester très beau (comme Depence) et surtout **fluide**. Choix de l'utilisateur :
- galvos **réalistes sans défaut** : inertie des miroirs (tremblement lissé, coins rapides un peu arrondis, intensité selon la vitesse), mais jamais de scintillement ni de baisse d'intensité quand la figure est chargée ;
- le travail sur les cônes (ci-dessus) est gardé ; les biarcs par corde sont retirés ;
- plan écrit d'abord, puis étapes mesurées.

### Constat (mesures du 15 octobre 2026)

- Les formes du programmeur sont codées une à une (éventail, cône, vague en ligne brisée, grille…) et les fichiers ILDA passent par une autre voie (réduction en faisceaux et cordes).
- La réduction ILDA est faite pour des figures propres : sur un trait de crayon simulé (1 200 points, vitesse irrégulière), elle coupe une nappe à chaque changement d'espacement de 12 % et à chaque tremblement : 370 à 450 cordes sans tremblement, **860 à 1 170 avec**, au-delà du budget de 700 par laser à tous les niveaux. Le rendu reste un polygone.
- Les nappes à l'ombre d'un obstacle sont redécoupées sur le CPU (tous les 1° pour un arc) : c'est ce qui fait exploser le nombre de segments et le temps CPU dès qu'il y a beaucoup de petites nappes.

### Principe

1. **Un tracé par laser et par image** : suite de points dans le champ du scanner (angles), couleur, allumé ou éteint, et durée de chaque point (cadence en points par seconde). Sources :
   - fichiers ILDA (tels quels) ; dessin au crayon (même format, connexion plus tard) ;
   - **générateurs** pour les formes du programmeur, qui remplacent le code forme par forme : éventail (N points allumés séparés par des sauts éteints, ou une ligne continue), cône et tunnel (cercles), vague, grille, et de nouvelles formes simples (carré, étoile, cœur, ligne, point ; texte plus tard) ;
   - **effets** appliqués au tracé (déplacement, rotation, taille, ondulation, modulation d'un sinus, couleurs, chenillards).
2. **Scanner** : les miroirs suivent les points avec leur inertie (filtre du 2e ordre, réglable ; l'inertie actuelle des boîtiers s'y range). Le tremblement du crayon est lissé, les coins pris vite s'arrondissent un peu, un point où le faisceau s'attarde devient un faisceau. L'intensité le long du tracé vient du temps passé (passage lent = plus lumineux). Pas de limite de cadence (choix « sans défaut ») : la figure entière est rendue à chaque image.
3. **Ajustement en courbes** : le tracé des miroirs (allumé) est découpé en morceaux d'**arcs de cercle et de droites** qui se raccordent sans cassure, à une tolérance d'angle plus fine que la largeur du faisceau (ordre de grandeur : 0,02°). Les vrais coins (carré, étoile) restent des coins. Chaque morceau porte sa couleur et son intensité à chaque bout (dégradé, déjà dans le rendu). Un cercle tient en 1 à 4 arcs, un trait de crayon en quelques dizaines.
   - Suites régulières de points allumés séparés par des sauts éteints, sur une droite ou un arc (éventail de 1 000 traits, cône de traits) : reconnues comme **un morceau à n traits** ; le rendu rapide actuel des traits séparés est gardé tel quel.
   - Points où le faisceau s'attarde : traits seuls (chemin le moins cher).
4. **Budget et fluidité** :
   - budget global de morceaux par image ; si une image le dépasse, la tolérance s'élargit d'abord pour les figures petites ou lointaines ;
   - mise en cache du résultat tant que le tracé ne change pas (figure fixe, image ILDA qui se répète) ;
   - calcul sur plusieurs cœurs du CPU (un laser par tâche).
5. **Rendu** : les deux nappes actuelles (plane et conique) avec dégradé, les traits seuls et les impacts. Les obstacles passent **dans le shader** : chaque morceau garde la liste des quelques pavés qui peuvent l'ombrer, et le pixel teste le segment source → point de la nappe contre ces pavés ; plus de redécoupage sur le CPU. À mesurer contre la méthode actuelle (bord net exact) : on garde la moins chère à image égale.
6. **Bancs** : nouveaux cas P1 trait de crayon (tracé généré, avec tremblement), P2 formes (carré, étoile, cœur), P3 sinus modulés en mouvement, P4 mélange ; les cas actuels (L1 à L7, M1, I1 à I4) restent. Chaque étape mesurée contre `bench\ref\avant_etape9.exe` (version actuelle), images avant / après, historique.

### Étapes

1. **9a. Tracé et ajustement en courbes pour les fichiers ILDA** (le plus gros gain attendu : I1 à I4) : modèle du tracé, scanner (inertie), ajustement en arcs et droites, morceaux à n traits, budget ; remplace la réduction en faisceaux et cordes. Bancs I1 à I4 et P1 (le crayon).
2. **9b. Obstacles dans le shader** : supprime le redécoupage CPU ; mesure contre la méthode actuelle.
3. **9c. Générateurs** : les formes du programmeur passent par le tracé (éventail, double éventail, cône, tunnel, vague, grille, puis carré, étoile, cœur) ; les effets s'appliquent au tracé. Bancs L1 à L7 : mêmes images à la tolérance près (éventails, cônes), vague et nouvelles formes lisses.
4. **9d. Cache et plusieurs cœurs** ; banc complet en mouvement (`-Full -Moving`), comparaison aux valeurs de référence.
5. **9e. Connexion au logiciel ILDA** (dessin au crayon en direct) : plus tard, à la demande de l'utilisateur.

### Critères

- Aucun polygone visible sur une courbe ; les coins voulus restent nets ; aucun trou (coutures entre morceaux comprises).
- Rendu des nappes (lumière, bords, fumée, volutes) inchangé pour une même forme ; les petites différences de forme dues au scanner sont acceptées (choix de l'utilisateur).
- Pas plus lent que la version actuelle sur L1 à L7 et M1 ; plus rapide sur I1 à I4 (moins de morceaux) ; moteur CPU sous 2 ms pour 200 lasers en figures fixes, à mesurer en mouvement.

## Étape 9 : résultats (15 octobre 2026)

Détail des mesures : `PERFORMANCE.md`, « Étape 9 : moteur de tracé » ; historique 24. Images : `bench/lasers_images/etape9/` (vues `--demo-laser 0` et `4`, avant et après) ; captures des cas P1 à P3, I1 à I4, L7 dans `bench/v9_cache/`.

- **9a. Tracé et ajustement** (`src/trace.cpp`) :
  - miroirs : suivi du 2e ordre amorti (60 µs, 30 000 points/s), couleur retardée du retard des miroirs ; **chaque course allumée part de son premier point** (correction du 15 octobre au soir : la couleur retardée allumait le laser 4 points après le départ des miroirs, d'où des traînées entre les faisceaux d'I2, 2 920 droites et 180 arcs parasites ; maintenant 2 000 faisceaux, comme la référence, 7 ms au lieu de 16 ms) ;
  - faisceaux : point où les miroirs restent sur place, étendue sous 4 fois la demi-divergence (les points tenus d'un coin, que les miroirs finissent de rejoindre, restent un faisceau) ;
  - droites et arcs : cercle par trois points du tracé, sans tangente imposée, à 5e-4 du champ près ; lumière linéaire par morceau ; un crayon de 1 222 points donne ~100 arcs ;
  - fichiers ILDA par le tracé, banques générées « Crayon », « Formes », « Sinus », bancs P1 à P3.
- **9b. Obstacles** : chaque morceau d'arc à l'ombre s'arrête exactement sur le plan de la face du pavé touché (`sb_laser.stop`, test dans le shader) ; coupures aux 12 arêtes projetées ; impacts sur la face sans trous. Le redécoupage tous les 1° a disparu (moteur CPU d'I1 34 → 11,5 ms avant 9d).
- **9c. Formes du programmeur** : éventail, double éventail, grille, cône, tunnel, vague et nouvelles formes (carré, triangle, étoile à n branches, cœur) en droites et arcs exacts (`Builder::figure`) ; la vague et le cœur sont ajustés, les droites, polygones et cercles donnés exacts. Les motifs des bancs L1 à L6 gardent leur code (comparables).
- **9d. Plusieurs cœurs et cache** : un laser par tâche sur tous les fils du processeur (même résultat qu'un seul cœur), impacts aussi ; cache des figures fixes (morceaux et impacts repris tant que rien ne change ; `--set lasercache=0`, case de l'onglet Rendu). Moteur CPU en mouvement : 0,2 à 2,6 ms sur tous les cas (avant : jusqu'à 24 ms sur P1) ; immobile, figures fixes : 0,2 à 1 ms. **Critère « moteur CPU sous 2 ms » tenu** sauf I3 et P3 en mouvement (2,6 et 2,2 ms : images du fichier qui changent).
- **Images** : courbes lisses (crayon, sinus, Lissajous, cœur), coins des formes nets mais légèrement arrondis par l'inertie des miroirs (voulu : « réalistes sans défaut »), aucun trou ni couture visibles ; I2 identique à la référence. Défaut existant, pas dû à l'étape 9 : impacts lointains en pointillés quand le sol est vu en rasant.
- **Coût GPU** (image entière, en mouvement) : L1, L3 à L6, M1 inchangés ; L2 +2 à +4 %, L7 +4 % ; I2 −10 % ; I1 +10 %, I4 +9 %, **I3 +56 %** (91,6 ms) ; P1 99 ms, P2 45 ms, P3 92 ms. **Critère « plus rapide sur I1 à I4 » non tenu.**
- **Pourquoi** : un point de nappe conique coûte environ 2 fois un point de nappe plane (≈ 95 contre ≈ 45 ps), et presque tout le travail est utile (P3 : 73 % des couples éclairent, ~70 nappes traversées par pixel). Les arcs couvrent moins de couples que les polygones (I1 506 contre 698 millions), mais chacun coûte le double. Trois allègements exacts de la passe des arcs essayés et mesurés, sans gain (`PERFORMANCE.md`).
- **À décider avec l'utilisateur** (aucun compromis appliqué) : voir le compte rendu de la session ; pistes : résolution des passes laser réduite quand l'image dépasse le budget (comme la qualité adaptative des lyres, plancher 80 %), volutes coupées dans les nappes coniques des figures chargées (−15 % sur la passe des arcs), ou accepter le coût (les cas ILDA à 200 lasers en plein champ ne sont pas une cible du plan).
- **9e** (connexion au logiciel ILDA, dessin au crayon en direct) : plus tard, à la demande de l'utilisateur.

## Étape 4 (en partie) : blanc à la sortie et dans les traits (15 octobre 2026)

Demande de l'utilisateur (photo de référence : sorties blanches, halo vert, cœur des traits blanc, éventails verts). Historique 25. Images : `bench/lasers_images/blanc/`.

- **Traits parasites en croix à la sortie** (signalés par l'utilisateur, ambiance Océan) : le plafond de 1 / |n.v| d'une nappe vue en rasant avait un plancher de 0,5 m (`max(rP, 0.5)`) ; à quelques cm de la sortie, une nappe (surtout le cône d'un arc, qui s'enroule autour de la source) s'allumait hors de son ouverture, en traits fins et très lumineux. Plafond lié à rP jusqu'à la source (`laser_eval`, `laser_arc_at`). Il restait un petit trait (~30 pixels) sur les arcs : le bout d'un morceau, étiré par 1 / |n.v| dans le test de sortie de la portion, s'étalait sur des dizaines de cm le long du cône ; étirement de ce test plafonné à max(4, rP / (20 sigma)) (près de la sortie seulement : vues d'essai 0 et 4 identiques à 0,003 % près, jonctions des morceaux vus par la tranche inchangées). Plus de trait parasite.
- **Blanchiment** (réponse du capteur, section 6, version simplifiée) : dans la composition, ce qui dépasse le début de la saturation (1 après exposition) déborde à parts égales sur les deux autres couleurs. Les couleurs ordinaires restent pures ; la sortie et le cœur des traits, très intenses, virent au blanc ; l'éventail (lumière étalée) beaucoup moins. `--set laserwhite` (0,6 par défaut ; 0 : œil, 1 et plus : caméra), réglage de l'onglet Rendu. Coût nul (quelques opérations par pixel, calque des lasers seulement : les lyres ne changent pas). La matrice de fuite par longueur d'onde du plan n'est pas faite (le débordement suffit sur les images).
- **Lueur de sortie** : la fenêtre de sortie diffuse une petite part de la puissance (point source) ; point chaud (sigma 1 pixel, 88 %) et halo (sigma 6 pixels, 12 %), intensité réduite deux fois à la demande de l'utilisateur (lueur trop grosse), blanchis comme le calque des lasers, puis le bloom. Passe « lasers : sorties » après la composition (un éblouissement de l'optique : pas atténué par la fumée pixel par pixel, sinon le halo prenait la forme du truss derrière lui) ; visible si la source l'est (5 lectures de profondeur autour d'elle : le boîtier la cache vue de derrière) ; intensité constante sous 10 m (sinon un disque blanc de près). Couleur : celle du laser, ou la moyenne de l'image ILDA. `--set laserexit` (×1 par défaut), réglage de l'onglet Rendu.
- **Coût** (banc rapide, immobile, 8 cas) : +1 à +3 % à l'image (passe des sorties ~0,25 ms pour 200 lasers) ; banc des lyres : images identiques.
- **Pas encore** : étoile à branches (lamelles, rotation), puissance en watts par couleur, éblouissement d'un trait braqué sur la caméra.

## Étape 7 (en partie) : lumière des lasers dans la pièce (19 octobre 2026)

Historique 51. Images : `docs/lumiere-lasers/` (ambiance 16 « Rideaux laser » et vue `--demo-laser 2`, 200 lasers, lyres éteintes ; avant, après, et la différence ×4).

- **Principe** (`Renderer::build_laser_vpls`) : des lumières virtuelles ajoutées à celles des lyres, dans les mêmes sondes (`cs_probes` inchangé).
  - Impacts : points répartis en angle le long de chaque morceau d'impact déjà calculé pour le dessin (`LaserRig::hits`, nouveau champ `span` : étendue du morceau, d'où sa puissance), environ un par case des sondes. Puissance × réglage des impacts × couleur de la surface (sol texturé et mouillé comme pour les lyres, sinon celle du pavé, lue par un rayon court) × atténuation par la fumée.
  - Fumée : 1 à 3 points le long de chaque nappe ou trait (quelques directions par nappe), puissance × diffusion (air + fumée de la pièce, uniforme) × longueur, comme les 3 points d'un faisceau de lyre.
  - Regroupement par case de la grille des sondes (2,5 m), par face pour les surfaces ; cases 2 fois plus grandes tant qu'il y a plus de 1 024 groupes de surface ou 384 de fumée. Bancs : 500 à 1 040 lumières, même avec 200 lasers et 28 000 impacts.
  - Calcul sur tous les cœurs (fils du moteur laser, `laser_parallel`), chaque fil dans sa propre grille.
  - Sans lyre allumée, la fumée est maintenant calculée (le raccourci de `PLAN-OPTIM-LASERS.md` 0.9 ne s'applique plus que sans lumière des lasers).
  - Aucun laser allumé : rien (le moteur garde les impacts de la dernière figure).
- **Réglages** : case « Lumière des lasers dans la pièce » et sa force (onglet Rendu, catégorie Lasers), `--set lasergi=0` pour couper, `--set lasergiforce=x`. **Active par défaut** (choix de l'utilisateur, 19 octobre 2026, après la mesure du coût ci-dessous) : les bancs des lasers la comprennent depuis. Demande la lumière renvoyée (`gi`).
- **Image** : murs, sol, décor et fumée prennent la couleur des lasers, en lumière douce et étendue (résolution des sondes) ; image moyenne +45 % (rideaux), +25 % (200 lasers). Pas de tache ni de scintillement. La lueur très locale autour d'une ligne d'impact (moins de 2 m) n'est pas rendue : plus fine que la grille des sondes.
- **Coût** (banc des lasers complet, en mouvement, rapide ; même exécutable, option coupée puis active, en alternance) :
  - GPU, lasers seuls : **+0,6 à +0,9 ms** (fumée et son accumulation, maintenant calculées, +0,55 ms ; sondes et composition, le reste) ;
  - GPU, avec des lyres (M1) : +0 à +0,2 ms (sondes seulement) ; scène sans lasers : 0 ;
  - CPU : +0,35 à +0,65 ms ; ILDA et tracés (jusqu'à 28 000 impacts) +0,65 à +1,3 ms (5,5 ms avant le calcul sur tous les cœurs).
- **Banc des lyres** (lasers éteints : aucune lumière des lasers) : images identiques (PSNR 75 à 84 dB, aucun pixel au-delà de 4/255), temps dans le bruit.
- **Pas encore** : flou de mouvement (persistance), reflet des lasers dans le sol mouillé.
