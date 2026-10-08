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
Dans le jeu, régler un laser sur « ILDA live » et le même canal (1 à 16) que dans la barre de connexion.

Au démarrage, le générateur **rouvre le dernier projet** et **reprend l'envoi live s'il était actif** à la
dernière fermeture (sinon il reste coupé). Chaque modification est **enregistrée automatiquement** dans le
fichier du projet (un projet sans nom est gardé dans la sauvegarde automatique et rouvert la fois suivante).
L'enregistrement automatique et la réouverture se désactivent dans Paramètres → Général.

La sauvegarde automatique d'un projet sans nom n'est **jamais écrasée** par un autre travail : avant, elle est
copiée dans des sauvegardes datées (les 10 dernières sont gardées), à rouvrir par **Fichier → Récupérer une
sauvegarde automatique…**. Un projet ou un fichier de réglages abîmé n'empêche jamais de démarrer : un message
explique le problème et l'on repart d'un projet vide (ou des réglages par défaut). Un projet créé par une
version plus récente est ouvert avec un avertissement, sans être réenregistré automatiquement.

## Disposition

| Zone | Contenu |
|---|---|
| Haut | Menus · IP / port / canal / images par seconde · état de la connexion · **Envoi live** · **BLACKOUT** |
| Gauche | Outils (sélection, crayon, seau), formes de base, couleur de tracé, **liste des formes** du projet |
| Centre | La mire (zone de projection), grille orthogonale ou polaire, compteur de points |
| Droite | Calques, puis Propriétés (repliable) — **sur toute la hauteur** (sous la barre de connexion) |
| Bas (à gauche du panneau de droite) | Timeline : transport, BPM, grille musicale, musique, pistes, clips ; elle s'arrête contre le panneau Calques / Propriétés |

Tous les séparateurs se déplacent ; la disposition est mémorisée.

## Raccourcis

Sur Mac : `Ctrl` = `Cmd` (la touche `Ctrl` marche aussi) et `Alt` = `Option`. `Suppr` = `⌫`.

| Action | Raccourci |
|---|---|
| Sélection / Crayon / Seau | `V` / `B` / `G` |
| Inverser les deux couleurs / couleurs par défaut | `X` / `D` |
| Trait, Carré, Cercle, Triangle, Étoile, Polygone, Mire ILDA | `L` `R` `E` `T` `S` `P` `M` |
| Annuler / Rétablir | `Ctrl+Z` / `Ctrl+Maj+Z` ou `Ctrl+Y` (pendant un glisser : annulent seulement ce glisser) |
| Annuler le geste en cours (tracé, déplacement, poignée, réglage glissé, clip ou point glissé…) | `Échap` |
| Couper / Copier / Coller / Dupliquer | `Ctrl+X` / `Ctrl+C` / `Ctrl+V` / `Ctrl+D` |
| Supprimer | `Suppr` ou `Retour arrière` |
| Tout sélectionner | `Ctrl+A` |
| Grouper / Dégrouper | `Ctrl+G` / `Ctrl+Maj+G` |
| Réinitialiser les réglages de la sélection | `Ctrl+Maj+R` (ou bouton ↺ de Propriétés, ou clic droit) |
| Réinitialiser un seul réglage | bouton ↺ à droite du réglage, `Alt` + clic sur sa valeur (ou clic droit sur son nom / sa valeur) |
| Sans grille / orthogonale / polaire | `Ctrl+1` / `Ctrl+2` / `Ctrl+3` |
| Aimant (les poignées s'accrochent à la grille) | `Ctrl+;` ou bouton aimant au-dessus de la mire |
| Symétrie de dessin marche / arrêt | `Ctrl+Maj+M` ou bouton symétrie au-dessus de la mire (petite flèche à sa droite : choisir le mode) |
| Ajuster la vue | `Ctrl+0` |
| Lecture / pause | `Espace` |
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

## Calques et modifieurs

Boutons sous les calques : **Modifieur** (menu de tous les modifieurs), **nouveau calque** (vide ; le prochain trait au crayon le remplit), **nouveau
groupe** (groupe la sélection s'il y en a une), **forme personnalisée**, **supprimer**.


- Le panneau Calques montre **le contenu de la forme choisie à gauche** (son nom est écrit en haut du panneau).
- Chaque forme est un calque. Glisser-déposer pour réordonner (ligne bleue = position, toujours au niveau des
  modifieurs, jamais décalée) ou ranger dans un groupe (lâcher au milieu de sa ligne : cadre bleu). On ne dépose
  jamais *dans* un modifieur : sur sa ligne, on va au-dessus ou en dessous.
- Œil : afficher / masquer (masquer un groupe masque tout son contenu). Cadenas (toujours affiché, ouvert ou fermé) : verrouiller. Un groupe
  verrouillé ne se déplie plus mais se sélectionne et se déplace comme un seul bloc.
- **Modifieurs** (bouton « Modifieur » sous les calques, ou clic droit → Ajouter un modifieur) : ils agissent sur tout ce qui est **en dessous d'eux dans
  le même groupe**. Leurs réglages s'affichent sous la ligne du calque et dans Propriétés.
  Dans la liste, une **ligne verticale part de chaque modifieur et longe tous les calques qu'il modifie**
  (ils sont décalés d'un cran vers la droite, comme rangés sous lui ; plusieurs modifieurs empilés restent
  alignés entre eux et partagent la même ligne, seules les formes sont décalées).
  Modifieur sélectionné ou survolé : une barre bleue à gauche relie le modifieur aux calques qu'il modifie,
  ces formes sont entourées en pointillés dans la mire et Propriétés indique « Agit sur : … ».
- **Modifieur sur modifieur** : clic droit sur un modifieur → Ajouter un sous-modifieur (Translation, Rotation,
  Échelle). Exemples : Translation sur Dots = décalage des points le
  long du trait ; Translation sur Symétrie = déplacement du centre du miroir.
- Couleur par défaut : blanc (modifiable dans Paramètres).

Modifieurs disponibles : Translation, Rotation, Inclinaison 3D, Profondeur Z, Échelle, Miroir, Pivot ·
Symétrie miroir, Symétrie radiale / kaléidoscope, Répétition linéaire · Onde, Simplification · Dots, Tirets,
Dessin progressif, Masque de zone, Beams · Couleur, Dégradé, Défilement de couleur, Arc-en-ciel,
Teinte / saturation / luminosité, Segments alternés, Couleur aléatoire, Remplacement de couleur ·
Luminosité, Fondu le long du tracé, Stroboscope, Pulsation.

## Formes (liste de gauche)

Un projet, ce sont des **formes** (la liste « Formes perso » à gauche) et la **timeline** qui les joue. Il n'y
a pas de « scène » : il y a toujours au moins une forme (« Forme 1 »).

- **Clic** sur une forme : elle est sélectionnée (en bleu), la mire l'affiche et le panneau Calques montre son
  contenu. On la modifie directement (traits, formes, modifieurs, autres formes…), sans bouton « Terminer ».
- **+** (en haut de la liste, ou clic droit → Nouvelle forme) : nouvelle forme vide, « Forme 2 », « Forme 3 »…
- **Double-clic** : renommer. **Clic droit** : renommer, dupliquer, placer dans la forme en cours, supprimer.
  `Suppr` : supprimer la forme et toutes ses occurrences (annulable).
- **Glisser** une forme : sur une piste de la timeline (clip) ou dans la mire (elle est placée dans la forme en
  cours, liée : la modifier met à jour toutes ses occurrences).
- Une forme peut aussi naître d'une sélection : clic droit → **Créer une forme personnalisée** (les calques
  sont remplacés par une occurrence de la nouvelle forme).
- Les **groupes** servent seulement à ranger les calques d'une forme.
- Au-dessus de la mire, **Forme / Show / Live** : l'espace actif (en attendant les onglets de la refonte, voir
  `docs/ilda-gen-refonte.md`). Forme : la forme choisie (modifiable), ses oscillateurs tournent en boucle ;
  Show : la sortie de la timeline à la tête de lecture (non modifiable) ; Live : les cues en cours. **L'envoi
  live suit l'espace actif.**

## Timeline (espace Show)

Refonte en cours : les anciennes automations sont remplacées par des **effets d'animation posés sur les clips**
(valeur fixe, courbe ou oscillateur ; modèle prêt, leur interface arrive avec l'espace Show). Un projet d'une
ancienne version s'ouvre avec ses formes et ses clips, sans ses animations (message à l'ouverture).

1. **Musique…** pour importer un morceau (forme d'onde affichée), régler le **BPM** (ou **Tap**), le nombre de
   temps par mesure, la **grille** (temps, 1/2, 1/4, 1/8, triolets) et le départ de la **mesure 1** (« Ici » =
   tête de lecture).
2. Glisser une forme (liste de gauche) sur une piste : un clip est créé (des vignettes montrent la forme tout le
   long du clip, effets compris ; une place occupée : juste après). Glisser le clip pour le déplacer, ses bords
   pour changer sa durée : **jamais de chevauchement** sur une piste (le clip s'arrête contre son voisin). Les
   courbes des effets sont en proportion de la durée du clip. L'**aimant** accroche tout à la grille (`Alt`
   pendant un glisser = libre). Double-clic sur un clip : sa forme s'ouvre dans l'espace Forme.
   **Clips liés** : les clips d'une même forme **partagent leur animation** (chaîne 🔗 en haut à droite).
   Clic sur la chaîne (ou clic droit → **Délier**) : ce clip reçoit sa propre copie de l'animation (la forme
   reste commune ; chaîne brisée). Clic sur la chaîne brisée (ou **Relier**) : il reprend celle des autres clips.
3. Propriétés du clip sélectionné : début, durée, **fondus** d'entrée et de sortie (dessinés en diagonale).
4. Molette : défilement de gauche à droite ; `Maj` + molette : pistes de haut en bas ; `Ctrl` + molette : zoom.
   Pavé tactile : glisser à deux doigts vers le haut / le bas = pistes, sur le côté = temps.
5. Zone de boucle : glisser dans la bande en haut de la règle, puis activer la boucle. Clic droit dans la règle :
   ajouter un **repère**.
6. **Sélection de clips** (comme une vraie timeline) : glisser dans le vide = **rectangle de sélection** ;
   `Ctrl` (`Cmd`) + clic ou `Maj` + clic sur un clip = l'ajouter / le retirer ; `Ctrl+A` = tous les clips ;
   glisser un clip sélectionné déplace toute la sélection ; un simple clic dans le vide désélectionne et place
   la tête de lecture.
7. **Copier / coller des clips** (la timeline doit avoir le focus : cliquer dedans) : `Ctrl` (`Cmd`) + glisser
   dans les pistes sélectionne une **zone de temps** (clips + vide, aimantée à la grille). `Ctrl+C` copie la
   zone (sans zone : les clips sélectionnés), `Ctrl+D` les recopie juste après eux-mêmes, `Ctrl+V` colle à la
   **tête de lecture**, sur les mêmes pistes (place occupée : piste suivante), avec leur animation (liée), puis
   **avance la tête de la longueur copiée** : `Ctrl+V` répété enchaîne les copies avec le même écart.
   `Ctrl+X` coupe, `Suppr` supprime les clips de la zone (ou sélectionnés), `Échap` annule la zone.

En lecture, la mire montre la sortie de la timeline et l'envoi live suit.

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

Général (couleur par défaut, lissage, enregistrement automatique, réouverture) · Grille · Sortie laser (vitesse de
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
```

## Structure du code

| Dossier | Rôle |
|---|---|
| `ildagen/core/` | Modèle sans interface : calques, transformations, modifieurs (`modifiers/`), oscillateurs, évaluation, timeline, animations et effets (`effects/`), live, maîtres, document |
| `ildagen/laser/` | Optimisation des points, réglages de sortie, paquets IDN, fichiers ILDA |
| `ildagen/editor/` | État de l'éditeur (espaces Forme / Show / Live), opérations, annuler / rétablir et gestes (`history_ops.py`), état d'exécution du live, sortie live, lecture, forme d'onde, export |
| `ildagen/ui/` | Interface Qt : thème, icônes, mire et outils, calques, propriétés, timeline, fenêtres |

Ajouter un modifieur : écrire une classe dans `ildagen/core/modifiers/` et l'ajouter à la liste `MODIFIERS` du module.
