# Générateur ILDA — catalogue des modifieurs

Ce sont les modifieurs qu'on trouve dans les logiciels laser (Pangolin Beyond / QuickShow, Modulaser,
LaserOS, MadMapper) et dans les outils génératifs proches (effecteurs de Cinema 4D, modifieurs de Blender,
TouchDesigner, After Effects).

**À faire : choisir ceux qu'on intègre.** ★ = ma recommandation pour la première version.
« Statique » = valeur fixe ; tous deviennent animables dans la timeline.

## A. Position et transformation

| N° | Modifieur | Effet | |
|---|---|---|---|
| A1 | Translation X / Y | Déplace la forme | ★ demandé |
| A2 | Rotation (Z) | Tourne la forme à plat autour d'un pivot | ★ demandé |
| A3 | Inclinaison 3D X / Y | Bascule la forme en perspective (comme une carte qu'on penche) | ★ demandé |
| A4 | Profondeur Z | Éloigne / rapproche en perspective (la forme rétrécit) | ★ |
| A5 | Échelle | Agrandit / rétrécit (uniforme ou X et Y séparés) | ★ |
| A6 | Cisaillement (skew) | Penche la forme comme un texte en italique | |
| A7 | Miroir (flip) | Retourne horizontalement / verticalement | ★ |
| A8 | Pivot | Déplace le point autour duquel tournent / grandissent les autres modifieurs | ★ |
| A9 | Perspective / caméra | Angle de vue (focale) commun aux inclinaisons 3D | |

## B. Duplication et répétition

| N° | Modifieur | Effet | |
|---|---|---|---|
| B1 | Symétrie miroir | 2, 4, N axes de miroir, centre déplaçable | ★ demandé |
| B2 | Symétrie radiale (kaléidoscope) | N copies tournées autour du centre | ★ demandé |
| B3 | Répétition linéaire | N copies avec un décalage constant (position, rotation, échelle) | ★ |
| B4 | Répétition en grille | Copies en lignes × colonnes | |
| B5 | Répétition circulaire | Copies réparties sur un cercle (comme un tunnel / une fleur) | |
| B6 | Écho / traînée | Copies successives de plus en plus petites ou sombres | |
| B7 | Copies le long d'un tracé | Répète la forme le long d'une autre forme | |

## C. Déformation

| N° | Modifieur | Effet | |
|---|---|---|---|
| C1 | Onde (sinus) | Fait onduler la forme en X ou Y (amplitude, fréquence, phase) | ★ |
| C2 | Bruit / tremblement | Décale les points au hasard (graine réglable) | |
| C3 | Tourbillon (twist) | Tourne plus fort près du centre qu'au bord | |
| C4 | Gonflement / pincement | Bombe ou creuse la forme autour d'un point | |
| C5 | Fisheye | Effet grand-angle | |
| C6 | Ondulation concentrique (ripple) | Vagues circulaires depuis un point | |
| C7 | Zigzag | Transforme les segments en dents de scie | |
| C8 | Évasement (taper) | Rétrécit un côté de la forme | |
| C9 | Courbure (bend) | Plie la forme en arc | |
| C10 | Polaire | Enroule la forme autour du centre (une ligne droite devient un cercle) | |
| C11 | Arrondi des coins | Adoucit les angles vifs | |
| C12 | Simplification | Réduit le nombre de points (laser plus stable) | ★ |
| C13 | Attraction (aimant) | Attire / repousse les points vers un point | |
| C14 | Morphing | Transition d'une forme vers une autre | |

## D. Tracé et découpe

| N° | Modifieur | Effet | |
|---|---|---|---|
| D1 | Dots (pointillés) | Ligne → suite de points ; espacement, taille, **phase** | ★ demandé |
| D2 | Tirets (dash) | Ligne → tirets ; longueur, espace, phase | ★ |
| D3 | Dessin progressif (trim) | N'affiche que le tracé entre un début et une fin en % (effet « se dessine ») | ★ |
| D4 | Décalage du point de départ | Change où commence le tracé (phase) | |
| D5 | Inverser le sens | Parcourt le tracé à l'envers | |
| D6 | Masque de zone | N'affiche que ce qui est dans (ou hors de) un rectangle / cercle | ★ |
| D7 | Beams | Remplace la forme par des points fixes très lumineux (faisceaux dans la fumée) | |

## E. Couleur

| N° | Modifieur | Effet | |
|---|---|---|---|
| E1 | Couleur unie | Couleur des éléments en dessous | ★ demandé |
| E2 | Dégradé | Le long du tracé, linéaire, radial, angulaire ; N couleurs | ★ demandé |
| E3 | Défilement de couleur | Fait glisser couleurs / dégradé le long du tracé, direction réglable | ★ demandé |
| E4 | Arc-en-ciel | Cycle de toutes les teintes | ★ |
| E5 | Teinte / saturation / luminosité | Ajuste la couleur existante | |
| E6 | Segments alternés | Couleur différente par segment (rouge, vert, rouge…) | |
| E7 | Couleur aléatoire | Couleur au hasard par segment ou par copie ; palette : toutes les teintes, couleurs laser pures, ou **couleurs choisies** (liste modifiable : clic = changer, clic droit = retirer, + = ajouter) | |
| E8 | Remplacement de couleur | Remplace une couleur par une autre | |

## F. Intensité

| N° | Modifieur | Effet | |
|---|---|---|---|
| F1 | Luminosité (dimmer) | Intensité globale | ★ |
| F2 | Fondu le long du tracé | La ligne s'éteint progressivement d'un bout à l'autre | |
| F3 | Stroboscope | Clignote (fréquence, rapport cyclique) | |
| F4 | Pulsation | Variation douce d'intensité | |

## G. Dynamiques (pour plus tard : demandent le temps réel)

| N° | Modifieur | Effet |
|---|---|---|
| G1 | LFO | Fait osciller n'importe quel paramètre (sinus, triangle, carré, dent de scie, aléatoire), calé sur le BPM |
| G2 | Décalage entre copies (stagger) | Chaque copie d'une répétition / symétrie réagit avec un retard |
| G3 | Audio-réactif | Un paramètre suit le volume ou une bande de fréquence de la musique |
| G4 | Atténuation par zone (falloff) | L'effet d'un modifieur faiblit avec la distance à un point |

## H. Sortie laser (réglages techniques, plutôt dans les Paramètres)

| N° | Réglage | Effet |
|---|---|---|
| H1 | Zone de sécurité | Interdit au laser de sortir d'une zone |
| H2 | Correction trapèze (keystone) | Compense un mur vu de biais |
| H3 | Taille / position de sortie | Recadre toute la projection |
| H4 | Optimisation des points | Points de coin, points éteints (blanking), vitesse |
