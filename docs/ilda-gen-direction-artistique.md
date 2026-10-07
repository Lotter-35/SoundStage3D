# Générateur ILDA — direction artistique

Ligne directrice : **un outil de travail, pas une vitrine.** L'interface s'efface derrière le contenu :
les seules couleurs vives à l'écran sont celles des faisceaux laser. Références de ton : Ableton Live,
Blender, DaVinci Resolve, Figma (mode sombre).

## 1. Ce qu'on s'interdit

- Dégradés décoratifs, lueurs (glow), néons, ombres portées marquées, effets de verre.
- Emojis dans l'interface.
- Couleurs d'accent multiples : **un seul accent**, plus le rouge réservé au danger.
- Coins très arrondis, gros boutons « pilule », espacements généreux de site web.
- Icônes partout : une icône n'est mise que si elle se lit plus vite qu'un mot.
- Animations d'interface décoratives (seules les transitions utiles, < 120 ms).

## 2. Palette (thème sombre)

| Rôle | Valeur | Usage |
|---|---|---|
| Fond application | `#16171a` | Derrière les panneaux |
| Fond panneau | `#1d1e22` | Calques, propriétés, timeline |
| Fond mire | `#0b0b0d` | Zone de projection (quasi noir, comme un mur dans le noir) |
| Fond champ / ligne survolée | `#26272c` | Champs de saisie, survol |
| Bordure / séparateur | `#2e3036` | Lignes de 1 px |
| Texte principal | `#d6d7db` | |
| Texte secondaire | `#8a8d96` | Libellés, unités |
| Texte désactivé | `#55585f` | |
| **Accent** | `#4a90e2` | Sélection, outil actif, tête de lecture, focus |
| Accent atténué | `#4a90e2` à 20 % | Fond des lignes sélectionnées |
| Danger | `#e5484d` | Blackout, envoi live actif, suppression |
| Succès | `#3fb950` | Pastille « connecté » uniquement |
| Grille mire | `#ffffff` à 6 % / 12 % (axes, croix) | Discrète, ne doit jamais rivaliser avec le laser |
| Grille timeline | mesure `#ffffff` 14 %, temps 7 %, subdivision 3 % | |

Les couleurs sont centralisées dans un seul fichier de thème (aucune couleur écrite en dur ailleurs).

## 3. Typographie et densité

- Police système : **SF Pro** (macOS), **Segoe UI** (Windows). Taille de base 12 px, titres de panneau 11 px en
  petites capitales, couleur secondaire.
- Chiffres (timecode, coordonnées, BPM) en **police à chasse fixe** (SF Mono / Consolas) pour qu'ils ne bougent pas.
- Interface **dense** : lignes de calques de 24 px, barres d'outils de 28 px, marges internes de 6 à 8 px.
- Rayon des coins : **3 px** maximum.

## 4. Icônes

- **Un seul jeu**, au trait, monochrome : **Lucide** (licence ISC), fichiers SVG intégrés au projet, recolorés
  par le thème (texte secondaire au repos, texte principal au survol, accent quand actif).
- Taille 16 px (calques, timeline) et 18 px (barre d'outils), trait 1,5 px.
- Toute icône seule a une **infobulle** avec le nom et le raccourci clavier.

Emplacements retenus :

| Zone | Icônes |
|---|---|
| Barre d'outils | Sélection, Crayon ; formes de base : trait, carré, cercle, triangle, étoile, polygone, mire ILDA |
| Barre de connexion | Pastille d'état (pas une icône : simple rond coloré), Live (antenne), **Blackout** (bouton rouge avec icône d'arrêt + texte) |
| Calques | Œil / œil barré, cadenas, chevron déplier, dossier (groupe), icône propre à chaque type de modifieur, forme |
| Propriétés | Chevron pour replier le panneau |
| Mire | Grille orthogonale, grille polaire, zoom ajusté |
| Timeline | Lecture / pause, stop, boucle, aimant (snap), zoom, métronome (BPM) |
| Menus | **Aucune icône** (texte + raccourci, comme les logiciels pro) |

## 5. Comportements visuels

- Sélection : cadre en **pointillés** couleur accent, poignées carrées de 7 px (fond sombre, bord accent),
  poignée de rotation ronde au-dessus.
- Glisser-déposer des calques : **ligne d'insertion** de 2 px couleur accent ; cadre accent quand on dépose dans un groupe.
- Envoi live actif : le bouton passe en rouge plein — on doit toujours savoir d'un coup d'œil si le laser émet.
- Éléments masqués / verrouillés : texte en couleur désactivée, pas d'autre décoration.

## Timeline : hiérarchie visuelle

- **Le bleu (accent) est réservé à ce qui est actif** : tête de lecture, clip sélectionné (liseré), point de
  courbe sélectionné, sélection en cours. Tout le reste est en gris.
- Priorité de lecture : 1) les formes (vignettes) et leur nom, 2) les courbes (gris clair), 3) les noms des
  modifieurs et réglages (gris, petits), 4) les aides (grille, ↺, flèches : très discrets).
- Pas de compteur ni de résumé dans les clips ; la zone de boucle est une fine barre grise.
- Les noms des réglages ont leur bande en haut de la ligne : la courbe passe toujours dessous.
