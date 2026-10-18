# Optimisations des lasers : pistes après l'étape 9

Analyse du 15 octobre 2026. Rien n'est codé : c'est une base de décision. GTX 1080, 3840 × 2160, cible 120 img/s (8,3 ms par image). Mesures : `PERFORMANCE.md`, « Étape 9 : moteur de tracé ».

## Où en est-on

- Un point de nappe courbe (arc, nappe conique exacte) coûte **≈ 95 ps**, contre **≈ 45 ps** pour une nappe plane.
- **73 %** des calculs éclairent vraiment (cas P3) : il y a peu de travail inutile à supprimer.
- **≈ 70 nappes** sont empilées dans chaque pixel avec 200 lasers ILDA en plein champ.
- Passe des arcs sur P3 (sinus et Lissajous) : **81 ms**, pour un budget total de 8,3 ms.
- Trois allègements qui ne changent pas l'image ont déjà été essayés et mesurés, sans gain. Le coût vient du nombre de points de nappe vraiment éclairés et du prix de chacun.

## Les deux idées de départ

- **Lasers cachés par ceux du premier plan.** Dans la fumée, un laser ne cache pas celui de derrière : leurs lumières s'additionnent. En revanche, quand un pixel est déjà éblouissant, un laser faible de plus ne se voit plus. On peut alors le calculer en version simplifiée, ou le sauter (piste 5).
- **Pas de volutes pour les lasers au loin.** Sur les nappes courbes, les volutes ne coûtent presque rien (mesuré : `--set volutes=0` ne change pas le temps de P1 et P3) ; c'est la lecture de la fumée de la pièce qui pèse (≈ 15 %). Sur les nappes planes (éventails), les volutes coûtent 25 à 35 % : là, l'idée rapporte (piste 6).

## Niveaux de dégradation

| Niveau | Effet sur l'image |
|---|---|
| 0 | Image strictement identique |
| 1 | Invisible à l'œil, petites différences mesurables |
| 2 | Visible sur une image fixe, discret en mouvement |
| 3 | Destructif |

Les gains sont des estimations, en % de la passe concernée, à confirmer par la mesure.

## Niveau 0 : image strictement identique

| # | Idée | Plus | Moins | Gain attendu |
|---|---|---|---|---|
| 1 | Tri plus précis des nappes courbes par tuile de 16 px : vérifier aux 4 coins de la tuile que la courbe y passe vraiment | Aucun risque visuel | Les 27 % de calculs inutiles sont les moins chers | −5 à −12 % (arcs) |
| 2 | Profondeur maximale par tuile : ignorer les nappes entièrement derrière un mur ou le public | Aucun risque | Presque rien sur le banc (hangar vide), plus dans une vraie scène | 0 à −10 % |
| 3 | Un seul calcul de cercle pour les morceaux d'un même cône ; fusion des arcs voisins d'un même cercle | Aucun risque | Surtout utile aux cônes et tunnels | −5 % (L2, L7), ~0 en ILDA |
| 4 | Réglages de la passe (taille des groupes, ordre des lectures) | Aucun risque | Résultat incertain | ±5 % |

## Niveau 1 : invisible à l'œil

| # | Idée | Plus | Moins | Gain attendu |
|---|---|---|---|---|
| 5 | **Lumière noyée** : une nappe qui apporterait moins de ~1 % de la lumière déjà présente dans le pixel est calculée sans fumée ni volutes, ou sautée | Gagne justement quand la scène est chargée ; rien à perdre sur une scène légère | Il faut traiter les nappes les plus fortes d'abord ; mal réglée, de petits sauts de lumière le long de contours | −20 à −40 % (scènes chargées) |
| 6 | Volutes coupées plus tôt au loin et là où beaucoup de nappes se superposent | Simple à faire | Les nappes lointaines perdent leur grain fin | −10 à −20 % (nappes planes), ~0 (arcs) |
| 7 | Fumée de la pièce lue une fois par tuile pour les nappes lointaines vues de face | Vise ce qui coûte vraiment dans les arcs | Risque de petits carrés sur les nappes vues par la tranche : à limiter aux cas sûrs | −5 à −10 % (arcs) |

## Niveau 2 : visible sur une image fixe, discret en mouvement

| # | Idée | Plus | Moins | Gain attendu |
|---|---|---|---|---|
| 8 | **Résolution 80 % seulement quand l'image dépasse le budget** (acceptée par l'utilisateur) | Ne coûte rien en scène légère : filet de sécurité | Traits plus doux pendant les moments chargés (`bench/lasers_images/etape9/compromis_resolution_80.png`) | −30 à −36 % quand elle est active |
| 9 | Demi-résolution seulement pour les nappes lointaines, pleine résolution pour les traits et les bords | Gros gain | Complexe ; risque de halos aux jonctions | −20 à −30 % |

## Niveau 3 : destructif, déconseillé

| # | Idée | Plus | Moins | Gain attendu |
|---|---|---|---|---|
| 10 | Une moitié des pixels par image, en damier, complétée par l'image précédente | Gros gain | Traînées et scintillement sur les lasers rapides | −40 à −50 % |
| 11 | Courbes lointaines en petits segments droits, invisibles à l'écran | Bon gain sur les petites figures lointaines | Ce sont des polygones (refusés) ; ~0 sur les figures proches | variable |
| — | Volutes coupées dans toutes les nappes courbes | — | Nappes plates (`bench/lasers_images/etape9/compromis_sans_volutes.png`) ; refusé | ≈ 0 mesuré (P1, P3) |

## Ce qu'on peut en attendre

- Avec tout le niveau 0, le niveau 1 et la résolution adaptative, P3 passerait d'environ **81 ms à environ 30 ms**. Les bancs « 200 lasers ILDA en plein champ » ne seront jamais à 120 img/s : ce sont des tests de limite, pas un spectacle réel.
- Pour une scène réaliste, la cible reste atteignable. Une grande figure courbe vue du public coûte aujourd'hui ~0,4 ms. Le budget laser (~4,6 ms) en accepte donc une dizaine, et environ 25 après ces optimisations. Les figures petites ou lointaines coûtent beaucoup moins.

## Ordre proposé

1. **Mesurer la lumière noyée** (comptage seul, rendu inchangé) : quelle part des calculs sert à moins de 1 % de la lumière du pixel. Ça décide si la piste 5 vaut le coup.
2. Pistes 1 et 2 : sans aucun risque.
3. Pistes 6 puis 5, avec agrandissements avant / après à valider par l'utilisateur.
4. Piste 8 (résolution 80 % adaptative) en dernier, comme filet de sécurité.

Écartés : volutes coupées dans les nappes courbes, rendu en damier, polygones.

## Passe des arcs : essais exacts du 16 octobre 2026 (rien de gardé)

Objectif : rapprocher le coût d'un couple de nappe courbe (~117 ps) de celui d'une nappe plane (~73 ps), sans changer l'image. Cas du banc d'exploration : Cône, Tunnel, Vague, Cœur (14, 15, 16, 21), ILDA Géométrie, Texte, Crayon, Sinus (57, 59, 62, 65). Patchs et scripts des essais : dossier de notes de la session (`arcs-essais`).

**Méthode de mesure.** D'un lancement à l'autre, seule la passe des arcs varie (12,6 → 15,2 ms pour le même exécutable ; les autres passes ne bougent pas) : passe longue, limitée par la puissance et la chaleur de la carte, qui dérive au fil des lancements. Les essais ont donc été mesurés **dans un même lancement** : option temporaire `--arcab` (chaque cas rejoué aussitôt avec une variante du shader, choisie par `--set arcexp=n`). Les deux mesures d'une paire concordent à ±0,5 % (contre 10 à 20 % entre deux lancements). Plancher des images entre deux passages identiques, en mouvement : PSNR ~51,5 dB, 0,001 à 0,003 % des pixels au-dessus de 4/255.

**Où va le temps** (Cône, 12,45 ms ; même allure pour tous les cas ; fonction arrêtée à différents endroits) :

| Étape | Part |
|---|---|
| Boucle, lecture des segments, rayon dans le repère | 15 % |
| Racines (2e degré) | 8 % |
| Tests rapides des 2 intersections | 11 % |
| Angle (arc tangente), normale, plafonds, rejet hors du morceau | 18 % |
| Vitesse angulaire, somme des traits | 23 % |
| Phase, atténuation, couleur | 10 % |
| Lecture de la fumée (3 textures 3D) | 15 % |

**Comptage** (`--stats`) : presque tout le travail est utile.

| Cas | Couples | Calculs complets | Qui éclairent |
|---|---|---|---|
| Cône | 135 M | 130 M | 88 % |
| Tunnel | 240 M | 232 M | 73 % |
| Vague / Cœur | 160 / 138 M | 174 / 151 M | 63 / 71 % |
| ILDA Géométrie / Sinus | 251 / 254 M | 231 / 272 M | 71 / 69 % |
| ILDA Texte / Crayon | 139 / 281 M | 105 / 291 M | 49 / 50 % |
| Nappes planes (base, 200 éventails, grille, diffraction ×5) | 50 à 245 M | — | 79 à 92 % |

- Par couple **qui éclaire** : 65 à 93 ps pour les nappes planes, 116 ps (Cône) à 175 ps (Crayon) pour les arcs. L'écart est réel : il vient du calcul propre aux nappes coniques (racines, deux intersections, arc tangente, normale, vitesse angulaire), réparti sur une dizaine d'étapes de 10 à 40 instructions.

**Essais** (écart de la passe des arcs, moyenne des 8 cas, dans un même lancement) :

| Essai (image identique) | Résultat |
|---|---|
| Chaque pixel cherche lui-même son prochain couple (segment, intersection) avant le long calcul, pour qu'un warp ne le fasse pas deux fois par segment | **+17,5 %** (ILDA +25 à +29 %) : écarté |
| Allègements du long calcul (plafonds en minimums, une racine inverse au lieu d'une division et d'une racine, vitesse angulaire sans vecteur, angle depuis le milieu du morceau sans recalage) | −0,7 % |
| + constantes du morceau préparées par tuile (test du demi-plan en 1 opération par intersection, \|X\|² sans produit scalaire), une seule inversion dans les racines, segments lus seulement avant le long calcul | **−1,2 à −1,9 %** selon les lancements (−1,4 % en moyenne) ; écarts d'image invisibles (pointe d'un cône, un bord de vague, visibles seulement dans l'image d'écart ×8) |
| + arc tangente par polynôme direct dans le morceau (\|angle\| ≤ 45°) | +0,1 % (branche de plus) |
| + chemin court pour un point de nappe lisse loin des bouts du morceau (S = 1 exactement : ni arc tangente, ni rejet, ni somme des traits) | +3 % |
| Lots de 64 ou 32 segments en mémoire partagée (plus de groupes actifs) | 0 % / +9 % |
| Moins de groupes actifs (mémoire partagée factice : 4 puis 3 groupes par SM au lieu de 5) | +1 % / +5 à +15 % sur l'ILDA : l'occupation n'est pas la limite |
| *Limite (image fausse)* : rejet angulaire serré (demi-morceau + 0,1 rad) avant le long calcul | −8 % (−4 à −13 %) : c'est le plus qu'un meilleur tri par morceau pourrait rapporter. Une borne exacte de la marge demande la normale et l'épaisseur vue, aussi chères que ce qu'elles évitent |

- Le compilateur de NVIDIA fait déjà la plupart des simplifications d'écriture : retirer des opérations du HLSL ne change presque rien. Ajouter une branche ralentit (code plus long, divergence dans les warps).
- **Conclusion : par des changements exacts du shader, on ne gagne pas plus de ~1,5 % sur la passe des arcs.** Le coût vient du nombre de points de nappe courbe vraiment éclairés et du calcul de chacun. Rapprocher le coût des nappes planes demande un compromis sur l'image (niveaux 1 et 2 ci-dessus : lumière noyée, résolution réduite des passes laser, fumée lue moins souvent), à décider avec l'utilisateur.
- **Décision de l'utilisateur (16 octobre 2026) : ces compromis restent un recours possible, rien n'est codé pour l'instant.** Ils seront mesurés seulement s'il les demande, avec des agrandissements avant / après à valider.
