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
