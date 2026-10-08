# Générateur ILDA — direction artistique

Ligne directrice : **un outil de travail, pas une vitrine.** L'interface s'efface derrière le contenu :
les seules couleurs vives à l'écran sont celles des faisceaux laser. Références de ton : Ableton Live,
Blender, DaVinci Resolve, Figma (mode sombre).

## 1. Ce qu'on s'interdit

- Dégradés décoratifs, lueurs (glow), néons, ombres portées marquées, effets de verre. Seule exception : le
  halo des faisceaux dans l'aperçu laser (c'est le contenu, pas l'interface).
- Emojis dans l'interface.
- Couleurs d'accent multiples : **un seul accent**, plus le rouge réservé au danger (BLACKOUT) et le vert à
  l'état « connecté / live ».
- Le **bleu** par défaut et les **couleurs délavées** (pastels, teintes grisées, fonds teintés à 20 %) : l'interface
  est en **gris neutres** (sans dominante bleue) et l'accent est une couleur **franche**.
- Le « look IA » : logo en dégradé, pastilles colorées, panneaux flottants arrondis, notes et badges décoratifs.
- Coins très arrondis, gros boutons « pilule », espacements généreux de site web.
- Icônes partout : une icône n'est mise que si elle se lit plus vite qu'un mot.
- Animations d'interface décoratives (seules les transitions utiles, < 120 ms).

## 2. Palette et thèmes

Base **neutre** : gris purs (aucune dominante bleue). L'état actif se lit d'abord par la luminosité ; un **seul
accent franc** marque ce qui est actif ou sélectionné. Le thème se choisit dans **Paramètres → Apparence**.

| Rôle | Graphite (par défaut) | Usage |
|---|---|---|
| Fond application | `#141414` | Derrière les panneaux |
| Fond panneau | `#1c1c1c` | Calques, réglages, timeline |
| Fond mire | `#000000` | Zone de projection et vignettes |
| Champ / survol | `#262626` / `#2c2c2c` | Champs, sliders, survol |
| Sélection | `#383838` | Fond de la ligne / de l'onglet sélectionné |
| Bordure | `#2b2b2b` | Lignes de 1 px |
| Texte | `#e4e4e4` / `#9b9b9b` / `#5f5f5f` | Principal / secondaire / désactivé |
| Remplissage slider | `#3c3c3c` | Barre des sliders au repos |
| **Accent** | `#ff7a00` (orange) | Outil actif, sélection, tête de lecture, slider en cours, interrupteur « oui », cue en cours |
| Danger | `#e03b3b` | BLACKOUT, suppression |
| Live / connecté | `#22b14c` | Pastille de connexion, icône du bouton Live |

Thèmes fournis (un fond + un accent), dans `tools/ilda-gen/ildagen/ui/theme.py` (`THEMES`) :

| Thème | Fond | Accent |
|---|---|---|
| Graphite · Orange (par défaut) | Graphite | `#ff7a00` |
| Graphite · Jaune | Graphite | `#ffc800` |
| Graphite · Citron vert | Graphite | `#9bff00` |
| Graphite · Framboise | Graphite | `#ff2d78` |
| Graphite · Magenta | Graphite | `#ff2bd6` |
| Noir · Violet | Noir | `#c04dff` |
| Noir · Ambre | Noir | `#ffb000` |
| Noir · Menthe | Noir | `#00e5a8` |
| Ardoise · Corail | Ardoise | `#ff6b4a` |
| Monochrome | Graphite | `#e8e8e8` (blanc) |

Fonds : **Graphite** (tableau ci-dessus) ; **Noir** : application `#0a0a0a`, panneau `#111111`, champ `#1c1c1c`,
sélection `#2a2a2a`, bordure `#222222` ; **Ardoise** (gris chauds) : application `#171615`, panneau `#1f1e1c`,
champ `#2a2826`, sélection `#3a3734`, bordure `#2e2c29`. Le rouge (danger), le vert (live) et les couleurs de
piste ne changent pas avec le thème. Le texte posé sur un fond accent (cue en cours, effet rapide actif) est
presque noir (`#111111`), lisible sur tous les accents.

Couleurs **franches** autorisées pour l'identification : pistes de la timeline (bande à gauche de l'en-tête,
liseré en haut des clips) et marqueurs de parties (étiquette pleine, texte noir).

Les couleurs sont centralisées dans le fichier de thème (aucune couleur écrite en dur ailleurs). Le thème change
à chaud : le code qui peint lit `theme.ACCENT`, `theme.BG_PANEL`… au moment de peindre, jamais une copie prise
au chargement.

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

- Sélection : cadre fin couleur accent, poignées carrées de 7 px (fond sombre, bord accent),
  poignée de rotation ronde au-dessus.
- Glisser-déposer des calques : **ligne d'insertion** de 2 px couleur accent ; cadre accent quand on dépose dans un groupe.
- Envoi live actif : bouton « Live » enfoncé avec l'icône en vert. **BLACKOUT** : texte rouge au repos, **rouge
  plein** quand il est engagé — les deux états ne se ressemblent jamais.
- Maîtres (lumière, taille, vitesse, position, rotation, couleur) : cachés, dans un panneau déroulant ouvert par
  le bouton « Maîtres » tout en haut à droite.
- Barre du haut : **menus** (Fichier, Édition, Affichage, Lecture, Paramètres) à gauche, onglets **Forme · Show ·
  Live** au centre, connexion · Live · BLACKOUT · Maîtres à droite. Pas de logo.
- Éléments masqués / verrouillés : texte en couleur désactivée, pas d'autre décoration.

## Timeline : hiérarchie visuelle

- **L'accent est réservé à ce qui est actif** : tête de lecture, clip sélectionné (liseré), point de
  courbe sélectionné, sélection en cours. Tout le reste est en gris.
- Priorité de lecture : 1) les formes (vignettes) et leur nom, 2) les courbes (gris clair), 3) les noms des
  modifieurs et réglages (gris, petits), 4) les aides (grille, ↺, flèches : très discrets).
- Pas de compteur ni de résumé dans les clips ; la zone de boucle est une fine barre grise.
- Les noms des réglages ont leur bande en haut de la ligne : la courbe passe toujours dessous.

## Réglages oui / non

Interrupteur (pastille qui glisse, accent = oui, gris = non) suivi du mot **« Oui »** ou **« Non »** : jamais une
simple case pleine sans coche, dont l'état est ambigu.
