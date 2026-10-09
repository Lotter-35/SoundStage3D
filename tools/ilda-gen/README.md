# ILDA Gen

Générateur ILDA en Python (PySide6) qui envoie en direct au serveur SoundStage3D (IDN / UDP) et exporte des
fichiers `.ild`. Cahier des charges : `docs/ilda-gen-cahier-des-charges.md`.

L'ancien outil (tkinter) est conservé dans `tools/ilda-gen-legacy/`.

## Installation (macOS et Windows)

Python 3.10 ou plus récent. Les dépendances s'installent dans un environnement virtuel `.venv` à la racine
du dépôt (obligatoire avec le Python de Homebrew sur Mac, conseillé partout). À faire une seule fois :

```sh
# macOS
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r tools/ilda-gen/requirements.txt

# Windows (PowerShell)
py -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install -r tools/ilda-gen/requirements.txt
```

Ensuite, à chaque nouveau terminal : activer l'environnement (`source .venv/bin/activate` sur Mac,
`.venv\Scripts\Activate.ps1` sur Windows) puis lancer :

```sh
python tools/ilda-gen/ilda-gen.py            # ou : python tools/ilda-gen/ilda-gen.py mon-projet.ildaproj
```

Pour le direct, lancer aussi le serveur SoundStage3D (`node server/server.js`) : il écoute l'IDN sur UDP 7255.
Dans le jeu, régler un laser sur « ILDA live » et le même canal (1 à 16) que dans la connexion (en haut à droite).

Au démarrage, le générateur **rouvre le dernier projet** et **reprend l'envoi live s'il était actif** à la
dernière fermeture (sinon il reste coupé). Chaque modification est **enregistrée automatiquement** dans le
fichier du projet (un projet sans nom est gardé dans la sauvegarde automatique et rouvert la fois suivante).
L'enregistrement automatique et la réouverture se désactivent dans Paramètres → Général.

La sauvegarde automatique d'un projet sans nom n'est **jamais écrasée** par un autre travail : avant, elle est
copiée dans des sauvegardes datées (les 10 dernières sont gardées), à rouvrir par **Fichier → Récupérer une
sauvegarde automatique…**. Un projet ou un fichier de réglages abîmé n'empêche jamais de démarrer : un message
explique le problème et l'on repart d'un projet vide (ou des réglages par défaut). Un projet créé par une
version plus récente est ouvert avec un avertissement, sans être réenregistré automatiquement.

## Disposition : trois espaces de travail

Barre du haut : **menus** à gauche · onglets **Forme · Show · Live** au centre (`Cmd+1` / `Cmd+2` / `Cmd+3`) ·
à droite l'état de connexion (clic : adresse, port, canal, cadence), **Live**, **BLACKOUT** et **Maîtres**
(lumière, taille, vitesse, position, rotation, couleur forcée de toute la sortie). Ce qui part au laser
**suit l'espace affiché**.

| Espace | Contenu |
|---|---|
| **Forme** | La forme sans le temps : outils de dessin, liste des formes en vignettes, mire, barre de boucle (aperçu des mouvements cycliques, tempo, compteur de points), **Calques** puis **Réglages** (sliders, oscillateurs, modifieurs qui agissent sur le calque) |
| **Show** | Le temps : formes et effets à glisser, aperçu (ou « Sortie corrigée »), timeline calée sur la musique, inspecteur du clip (effets d'animation) |
| **Live** | Jouer en direct : pages, grille de cues 8 × 4, départ calé sur le tempo, sortie, effets rapides |

Chaque espace garde sa disposition (séparateurs mémorisés) ; **Affichage → Réinitialiser la disposition**
remet les tailles d'origine. Thème : **Paramètres → Apparence** (10 thèmes).

## Raccourcis

Sur Mac : `Ctrl` = `Cmd` (la touche `Ctrl` marche aussi) et `Alt` = `Option`. `Suppr` = `⌫`.

| Action | Raccourci |
|---|---|
| Sélection / Crayon / Seau (espace Forme) | `V` / `B` / `G` |
| Inverser les deux couleurs / couleurs par défaut | `X` / `D` |
| Trait, Carré, Cercle, Triangle, Étoile, Polygone, Mire ILDA | `L` `R` `E` `T` `S` `P` `M` |
| Annuler / Rétablir | `Ctrl+Z` / `Ctrl+Maj+Z` ou `Ctrl+Y` (pendant un glisser : annulent seulement ce glisser) |
| Annuler le geste en cours (tracé, déplacement, poignée, réglage glissé, clip ou point glissé…) | `Échap` |
| Couper / Copier / Coller / Dupliquer | `Ctrl+X` / `Ctrl+C` / `Ctrl+V` / `Ctrl+D` |
| Supprimer | `Suppr` ou `Retour arrière` |
| Tout sélectionner | `Ctrl+A` |
| Grouper / Dégrouper | `Ctrl+G` / `Ctrl+Maj+G` |
| Réinitialiser les réglages de la sélection | `Ctrl+Maj+R` (ou bouton ↺ de Réglages) |
| Réinitialiser un seul réglage | clic droit (ou `Alt` + clic) sur son slider |
| Espace Forme / Show / Live | `Ctrl+1` / `Ctrl+2` / `Ctrl+3` |
| Sans grille / orthogonale / polaire | `Ctrl+Alt+1` / `Ctrl+Alt+2` / `Ctrl+Alt+3` |
| Aimant (les poignées s'accrochent à la grille) | `Ctrl+;` ou bouton aimant au-dessus de la mire |
| Symétrie de dessin marche / arrêt | `Ctrl+Maj+M` ou bouton symétrie au-dessus de la mire (petite flèche à sa droite : choisir le mode) |
| Ajuster la vue | `Ctrl+0` |
| Lecture / pause (Show) | `Espace` |
| Live : lancer un cue / effets rapides / tout arrêter | sa touche (A Z E R T Y U I, Q S D F…, F1–F8) / `1`–`8` maintenus / `Échap` |
| Enregistrer / Ouvrir / Nouveau | `Ctrl+S` / `Ctrl+O` / `Ctrl+N` |
| Exporter en ILDA | `Ctrl+E` |

### Mire

| Geste | Effet |
|---|---|
| Molette, pincement (pavé tactile) | Zoom autour du curseur (jusqu'à voir les points laser) |
| Glisser à deux doigts, bouton du milieu | Déplacer la vue |
| Clic droit | Toutes les actions sur les calques |

### Crayon

| Geste | Effet |
|---|---|
| Glisser | Dessin à main levée (un calque par trait, lissage réglable dans Paramètres) |
| `Maj` | Affiche le point aimanté sur la grille |
| `Maj` + clic | Pose un point (un calque) |
| `Maj` + glisser | Une ligne (grille orthogonale) ; un arc le long d'un cercle ou un trait le long d'un rayon (grille polaire) |
| Clic simple dans le vide | Désélectionne |

### Symétrie de dessin

Bouton **symétrie** au-dessus de la mire (ou Affichage → Mode de symétrie, `Ctrl+Maj+M`) : modes miroir
gauche / droite, miroir haut / bas, miroir 4 quarts, radiale et kaléidoscope (2 à 16 branches), autour du
centre de la mire. Les axes s'affichent en pointillés.

Ce qu'on dessine (crayon ou formes) est rangé automatiquement dans un groupe **« Symétrie »**, sous le
**modifieur Symétrie** correspondant (ajouté tout seul) : le trait dessiné reste **un seul trait**, les
copies viennent du modifieur, qu'on peut ensuite régler ou animer. Les traits suivants dessinés avec le même
mode vont sous le même modifieur ; changer de mode crée un nouveau groupe.

### Formes

`Maj` : proportions forcées et aimant de grille. `Alt` : tracé depuis le centre. Un simple clic pose la forme
à une taille par défaut (la mire ILDA prend toute la zone). Une forme glissée puis ramenée à son point de
départ (taille quasi nulle) n'est pas créée.

### Gestes et annulation

Un geste (tracer, déplacer, une poignée, glisser un réglage ou un clip) compte pour **une
seule étape** d'annulation. Il est **annulé** — tout revient comme avant le geste — par `Échap`, par `Ctrl+Z`
pendant le geste, en changeant d'outil (`V`, `B`, `R`…) avant de relâcher, ou si l'application perd la main
(autre application au premier plan). Les flèches maintenues ou répétées rapidement font une seule étape.

L'annulation ne touche pas à l'**affichage** : grille, aimant, symétrie de dessin, clips et calques dépliés,
maîtres, espace actif restent comme ils sont (ils sont quand même enregistrés avec le projet).

### Sélection et transformations (comme Photoshop)

| Geste | Effet |
|---|---|
| Clic / `Ctrl` + clic / `Maj` + clic | Sélectionner / ajouter ou retirer / ajouter |
| Glisser dans le vide | Sélection rectangle |
| Glisser une forme | Déplacer ; `Maj` : magnétisme (centre, bords, autres formes, grille) ; `Alt` : copie |
| Flèches / `Maj` + flèches | Déplacement fin / rapide (touche maintenue : une seule étape d'annulation) |
| `Échap` | Pendant un geste : l'annule ; sinon : désélectionner |
| Coin | Redimensionner ; `Maj` : proportionnel ; `Alt` : depuis le centre ; `Alt` + `Maj` : proportionnel depuis le centre |
| Milieu d'un côté | Étirer ; `Alt` : symétrique |
| `Ctrl` + coin | Distorsion libre |
| `Ctrl` + `Maj` + côté | Inclinaison (cisaillement) ; `Alt` : symétrique |
| `Ctrl` + `Alt` + `Maj` + coin | Perspective |
| Poignée ronde au-dessus, ou juste à l'extérieur d'un coin | Rotation ; `Maj` : pas de 15° |
| Poignée en losange | Inclinaison 3D (gauche / droite = axe Y, haut / bas = axe X) |
| Croix au centre | Déplacer le pivot ; `Maj` : aimanté (coins, milieux, centre, grille) |
| Double-clic sur une forme placée dans une autre | Afficher cette forme (toutes ses occurrences suivent) |

Une **ligne** seule n'a pas d'épaisseur : pas de cadre, seulement ses deux extrémités (glisser ; `Maj` =
aimant de grille, ou pas de 15° sans grille) et une poignée de rotation.

### Couleur de tracé et seau

Section **Couleur** de la barre de gauche (comme Photoshop) : le **grand carré** est la couleur active (clic
pour la changer), le **petit carré** derrière est la seconde couleur (clic ou `X` pour inverser, `D` pour
blanc / rouge). Les nouvelles formes et le seau prennent la couleur active ; si des formes sont sélectionnées,
changer la couleur les recolore en direct (annulable). **Les dégradés se font avec le modifieur Dégradé.**

| Geste (outil Seau, `G`) | Effet |
|---|---|
| Clic sur une forme | Lui applique la couleur active |
| Clic sur une forme sélectionnée | Colorie toute la sélection (groupes compris) |
| `Alt` + clic | Colorie tout le groupe qui contient la forme |

Un modifieur de couleur placé au-dessus
d'une forme reste prioritaire sur sa couleur propre.

## Calques et Réglages (espace Forme)

- **Calques** : la forme choisie à gauche, calque par calque (œil, cadenas). Glisser-déposer pour réordonner ou
  ranger dans un groupe ; on ne dépose jamais *dans* un modifieur. Un calque verrouillé n'est plus modifiable
  (réglages grisés). En haut du panneau : nouveau calque, nouveau groupe, forme personnalisée, supprimer ;
  en bas : **+ Modifieur** (liste par catégories avec **recherche**).
- **Modifieurs** : ils agissent sur tout ce qui est **en dessous d'eux dans le même groupe** (comme les calques de
  réglage de Photoshop). Modifieur sur modifieur : clic droit → sous-modifieur (Translation, Rotation, Échelle).
- **Réglages** (un seul endroit) : tous les réglages du calque sélectionné en **sliders** (glisser, molette après
  un clic, flèches, double-clic pour taper, `Échap` annule, clic droit = valeur par défaut), puis **les
  modifieurs qui agissent sur ce calque** en cartes repliables (interrupteur = modifieur actif). Les réglages
  inutiles dans le mode choisi sont masqués.
- **Oscillateur** (bouton ∿ à droite d'un réglage numérique) : la valeur bouge toute seule, en boucle — **onde**
  (sinus, triangle, carré, scie, aléatoire ; amplitude, cadence calée sur le tempo ou en Hz) ou **vitesse**
  (rotation continue, défilement). Le champ affiche alors « ~ Sinus · 1 temps » ou « ~ 45 °/s ».

Modifieurs disponibles : Translation, Rotation, Inclinaison 3D, Profondeur Z, Échelle, Miroir, Pivot ·
Symétrie miroir, Symétrie radiale / kaléidoscope, Répétition linéaire · Onde, Simplification · Points, Tirets,
Dessin progressif, Masque de zone, Faisceaux · Couleur, Dégradé, Défilement de couleur, Arc-en-ciel,
Teinte / saturation / luminosité, Segments alternés, Couleur aléatoire, Remplacement de couleur ·
Luminosité, Fondu le long du tracé, Stroboscope, Pulsation. Le réglage commun « Dosage » mélange l'effet du
modifieur avec ce qu'il reçoit.

## Formes

Un projet, ce sont des **formes** (vignettes à gauche dans Forme et Show), la **timeline** qui les joue (Show)
et la **grille de cues** (Live). Il y a toujours au moins une forme.

- **Clic** sur une vignette : la forme s'ouvre dans la mire et dans Calques ; on la modifie directement.
- **+** : nouvelle forme vide. **Double-clic** : renommer. **Clic droit** : renommer, dupliquer, placer dans
  la forme en cours, supprimer (`Suppr`, annulable).
- **Glisser** une vignette : sur une piste de la timeline (clip), dans une case du Live (cue), ou dans la mire
  (occurrence liée dans la forme en cours).
- Une forme peut aussi naître d'une sélection : clic droit → **Créer une forme personnalisée**.

## Espace Show

- **Bibliothèque** : formes (glisser sur une piste = clip ; double-clic = clip à la tête de lecture) et
  **effets** (recherche, catégories, favoris ★ ; glisser sur un clip, ou double-clic pour l'ajouter au clip
  actif).
- **Aperçu** de la timeline à la tête de lecture, maîtres compris ; « Sortie corrigée » = après les réglages de
  sortie, avec la zone de sécurité en pointillés.
- **Transport** : lecture / stop / boucle, position (mesure.temps.sub · temps), BPM + Tap, grille (1/2, 1/4,
  1/8 ; ▾ : 1/16, 1/32, triolets), aimant, zoom, musique ; menu ⋯ : début de la mesure 1, caler sur la tête de
  lecture, temps par mesure.
- **Règle** : numéros de mesure, **repères** nommés et colorés (`M` ou clic droit ; glisser, double-clic pour
  renommer), bande de boucle.
- **Pistes** : couleur (clic sur la bande), nom (double-clic), M / S / verrou, ordre (glisser l'en-tête).
- **Clips** : jamais de chevauchement sur une piste (contour rouge si la place est prise) ; aimant sur la
  grille, les bords des autres clips, les repères, la tête de lecture et la boucle (`Alt` = libre) ; bords =
  durée (l'animation s'étire ; `Maj` = les clés gardent leur instant) ; poignées de **fondu** aux coins du haut.
  Les clips d'une même forme **partagent leur animation** (chaîne) : **Délier** (inspecteur ou clic droit)
  lui donne sa propre copie, **Relier** la lui rend. Double-clic : ouvrir la forme dans Forme.
- **Sélection** : clic, `Ctrl`/`Maj` + clic, rectangle, `Ctrl+A` ; flèches = un pas de grille (↑/↓ : piste),
  `Début`/`Fin`, `Z` / `Maj+Z` : tout voir / la sélection, `Échap` : désélectionner. `Ctrl+C/X/V/D`, `Suppr`.
- **Molette** : défilement vertical ; `Maj` : le temps ; `Ctrl`/`Cmd` ou pincement : zoom ; pavé tactile : 2D.
- **Inspecteur du clip** : début, durée, fondus ; animation partagée ou propre ; **effets d'animation** en
  cartes (interrupteur, cible « Toute la forme » ou un calque, réordonnables) ; chaque réglage en **Fixe**,
  **Courbe** (clés : clic = sélection, glisser, double-clic = nouvelle clé, clic droit = type de courbe ou
  supprimer) ou **Oscillateur** ; « + Ajouter » ; « Ouvrir dans Forme ». Un clip déplié montre ses courbes
  dans la timeline.
- Un projet d'une ancienne version s'ouvre avec ses formes et ses clips, sans ses anciennes automations.

## Espace Live

- **Pages** (une par partie du morceau) : double-clic = renommer, glisser = réordonner, « + », clic droit.
- **Grille de cues 8 × 4** : une case = une forme (ses oscillateurs tournent). Clic = lancer (re-clic =
  arrêter), touche du clavier de la case (A Z E R T Y U I / Q S D F G H J K / W X C V B N , ; / F1–F8),
  `Échap` = tout arrêter. Clic droit : placer une forme, changer la touche, ouvrir dans Forme, vider ; glisser
  une case sur une autre pour les échanger, ou une forme depuis la liste.
- **Départ** : immédiat, au prochain temps ou à la prochaine mesure (« en attente » en pointillés) ;
  **Plusieurs cues** : sinon un nouveau cue remplace le précédent.
- **Sortie** (aperçu), BPM + **Tap** (le dernier tap cale le début de mesure), **effets rapides** actifs tant
  qu'on les maintient (souris ou touches `1`–`8`).

## Sortie laser

- **Envoi live dans un fil dédié** : les images partent au rythme choisi (images/s), calculées à l'instant exact
  de l'envoi, même si l'interface est occupée ; une image lourde ne bloque plus l'interface. Les gros envois sont
  étalés dans le temps (pas de rafale perdue) ; le serveur jette une image dont un fragment s'est perdu.
- **BLACKOUT** coupe immédiatement ; couper l'envoi live envoie quelques images éteintes et la fermeture IDN.
  Hors live, rien n'est envoyé ni calculé en continu (l'aperçu de la mire est recalculé seulement quand
  l'affichage change).
- **Budget de points** : une image compte au plus *vitesse de balayage (kpps) × 1000 / images par seconde*
  points (1 000 à 30 kpps et 30 images/s ; jamais plus de 20 000, limite du serveur). Au-delà, l'image est
  allégée : points espacés, temps d'arrêt raccourcis, tracés simplifiés, et en dernier recours éclaircis. Le
  compteur sous la mire indique les points envoyés et « réduit » quand l'image a été allégée.
- La géométrie est **découpée au champ** avant d'ajouter des points : une répétition géante ne coûte rien de ce
  qui tombe hors de la mire. Toute combinaison de réglages reste rapide (plafonds de sécurité).
- Coins : temps d'arrêt selon l'angle (coin de fermeture des formes fermées compris, coins arrondis détectés) ;
  sauts laser éteint avec accélération / freinage ; points éteints avant / après chaque tracé réglables.
- **Anti point fixe** (Paramètres → Zone de sécurité, actif par défaut) : une image dont tous les points allumés
  tiennent en un point est éteinte (forme de taille nulle, sortie réduite à rien…).

## Paramètres

Apparence (10 thèmes, appliqués aussitôt) · Général (couleur par défaut, lissage, enregistrement automatique, réouverture) · Grille · Sortie laser (vitesse de
balayage en kpps et budget de points, distance entre points, blanking, coins) · Couleurs (décalage couleur, gamma,
gains rouge / vert / bleu, puissance minimale) · Zone de sécurité (et anti point fixe) · Trapèze · Taille / position
(taille minimale 5 %, puissance max). Les nombres de points sont réglés pour 30 kpps et suivent la vitesse de
balayage.

Export ILDA : par défaut le fichier contient le **contenu seul**, sans les réglages de sortie de ce laser (case
« Appliquer les réglages de sortie » pour les inclure). Limites du format : 65 535 points par image et
65 535 images. Formats à palette (0 et 1) : teinte la plus proche, luminosité rendue par tramage (une partie
des points éteints).

## Tests

```sh
python tools/ilda-gen/tests/test_core.py
QT_QPA_PLATFORM=offscreen python tools/ilda-gen/tests/test_ui.py
QT_QPA_PLATFORM=offscreen python tools/ilda-gen/tests/test_widgets.py
QT_QPA_PLATFORM=offscreen python tools/ilda-gen/tests/test_forme.py
QT_QPA_PLATFORM=offscreen python tools/ilda-gen/tests/test_show.py
QT_QPA_PLATFORM=offscreen python tools/ilda-gen/tests/test_live.py
```

## Structure du code

| Dossier | Rôle |
|---|---|
| `ildagen/core/` | Modèle sans interface : calques, transformations, modifieurs (`modifiers/`), oscillateurs, évaluation, timeline, animations et effets (`effects/`), live, maîtres, document |
| `ildagen/laser/` | Optimisation des points, réglages de sortie, paquets IDN, fichiers ILDA |
| `ildagen/editor/` | État de l'éditeur (espaces Forme / Show / Live), opérations, annuler / rétablir et gestes (`history_ops.py`), état d'exécution du live, sortie live, lecture, forme d'onde, export |
| `ildagen/ui/` | Interface Qt : thèmes (`theme.py`), briques communes (`widgets/`), barre du haut (`shell/`), espaces `forme/`, `show/`, `live/`, mire et outils (`canvas/`), calques, réglages, timeline, fenêtres |

Ajouter un modifieur : écrire une classe dans `ildagen/core/modifiers/` et l'ajouter à la liste `MODIFIERS` du module.
