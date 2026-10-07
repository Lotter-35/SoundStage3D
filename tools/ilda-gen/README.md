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

Au démarrage, le générateur **rouvre le dernier projet** et passe **en envoi live**. Chaque modification est
**enregistrée automatiquement** dans le fichier du projet (un projet sans nom est gardé dans la sauvegarde
automatique et rouvert la fois suivante). Ces trois comportements se désactivent dans Paramètres → Général.

## Disposition

| Zone | Contenu |
|---|---|
| Haut | Menus · IP / port / canal / images par seconde · état de la connexion · **Envoi live** · **BLACKOUT** |
| Gauche | Outils (sélection, crayon, seau), formes de base, couleur de tracé, **liste des formes** du projet |
| Centre | La mire (zone de projection), grille orthogonale ou polaire, compteur de points |
| Droite | Calques, puis Propriétés (repliable) — **sur toute la hauteur** (sous la barre de connexion) |
| Bas (à gauche du panneau de droite) | Timeline : transport, BPM, grille musicale, musique, pistes, automations ; elle s'arrête contre le panneau Calques / Propriétés |

Tous les séparateurs se déplacent ; la disposition est mémorisée.

## Raccourcis

Sur Mac : `Ctrl` = `Cmd` (la touche `Ctrl` marche aussi) et `Alt` = `Option`. `Suppr` = `⌫`.

| Action | Raccourci |
|---|---|
| Sélection / Crayon / Seau | `V` / `B` / `G` |
| Inverser les deux couleurs / couleurs par défaut | `X` / `D` |
| Trait, Carré, Cercle, Triangle, Étoile, Polygone, Mire ILDA | `L` `R` `E` `T` `S` `P` `M` |
| Annuler / Rétablir | `Ctrl+Z` / `Ctrl+Maj+Z` ou `Ctrl+Y` |
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
à une taille par défaut (la mire ILDA prend toute la zone).

### Sélection et transformations (comme Photoshop)

| Geste | Effet |
|---|---|
| Clic / `Ctrl` + clic / `Maj` + clic | Sélectionner / ajouter ou retirer / ajouter |
| Glisser dans le vide | Sélection rectangle |
| Glisser une forme | Déplacer ; `Maj` : magnétisme (centre, bords, autres formes, grille) ; `Alt` : copie |
| Flèches / `Maj` + flèches | Déplacement fin / rapide |
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
- Au-dessus de la mire, **Forme / Timeline** : la forme choisie (modifiable) ou la sortie de la timeline à la
  tête de lecture (aussi pendant la lecture). Cliquer sur un clip affiche sa forme telle qu'elle est à la tête
  de lecture (automations comprises).

## Timeline

1. **Musique…** pour importer un morceau (forme d'onde affichée), régler le **BPM** (ou **Tap**), le nombre de
   temps par mesure, la **grille** (temps, 1/2, 1/4, 1/8, triolets) et le départ de la **mesure 1** (« Ici » =
   tête de lecture).
2. Glisser une forme (liste de gauche) sur une piste : un clip est créé (des vignettes montrent la forme tout le
   long du clip, automations comprises). Glisser le clip pour le déplacer, ses bords
   pour changer sa durée : les **automations s'étirent proportionnellement** (une montée sur 10 s ramenée à
   5 s va toujours jusqu'au bout) ; `Maj` pendant le glisser = les clés gardent leurs instants (on coupe). L'**aimant** accroche tout à la grille (`Alt` pendant un glisser = libre).
3. **Envoyer un réglage dans la timeline** : à côté de chaque réglage (dans Calques et dans Propriétés), le
   bouton **〰 (courbe)** l'envoie dans la timeline : une ligne apparaît sous le clip de la forme, avec une clé
   à la tête de lecture. Le bouton devient bleu ; re-cliquer retire le réglage de la timeline (annulable).
   Le clip visé : le clip sélectionné, sinon le seul clip de cette forme (ou celui sous la tête de lecture).
   **Mini-courbe** : un réglage envoyé a une petite **flèche** devant son nom (fermée par défaut) ; elle ouvre,
   sous le réglage (Calques et Propriétés), un petit rectangle qui montre sa courbe sur **toute la durée du
   clip**, avec les traits de la grille choisie (mesures, temps, subdivisions) en fond, sans numéros (gauche = début de la forme, droite = fin), quel que soit le zoom de
   la timeline : clic = ajouter un point, glisser = le déplacer (la mire montre cet instant), clic droit =
   le supprimer, `Alt` = sans aimant, `Maj` = aimant sur la valeur par défaut ; ↺ à sa droite = réinitialiser la courbe (un seul point, valeur par défaut).
   **Déplier le clip** (chevron à gauche du clip, ou double-clic) : on ne voit **que les réglages envoyés**,
   regroupés sous leur calque / modifieur (cliquer sur son nom pour les replier). Rien au départ.
   Autre méthode : clic droit sur le clip → **Nouvelle automation** : elle attend son réglage. Toucher ensuite n'importe quel
   réglage (Propriétés, ligne du modifieur, ou déplacer / tourner la forme dans la mire) : l'automation s'y lie.
   Chaque réglage touché ensuite écrit une clé à la tête de lecture.
4. Dans la ligne d'automation : clic = ajouter une clé, glisser = déplacer, clic droit sur un point = le supprimer,
   `Maj` + clic droit = menu (réinitialiser la valeur, type de courbe : linéaire, accélération, ralentissement,
   en S, palier, Bézier personnalisé avec poignées). Le bouton ↺ (en haut à droite de la ligne, dans le clip) supprime son automation
   (retire le réglage de la timeline).
   **Tout est dans le clip** : la colonne de gauche ne montre que les pistes. Sous un clip déplié, chaque
   modifieur (flèche, icône, nom : clic = replier / déplier pour ce clip) et chaque réglage (flèche pour
   réduire / agrandir, nom, ↺ à droite) sont écrits dans la largeur du clip. Plusieurs clips dépliés sur une
   piste sont côte à côte, sur les mêmes lignes (pas d'empilement). Replié : seulement le carré de la forme.
   La piste forme un seul bloc avec les lignes de ses clips dépliés (en-tête étendu, barre à gauche, trait de
   fin de bloc) et chaque clip déplié est encadré, de la forme jusqu'à son dernier réglage.
   **Hauteur des lignes** : un réglage pas utilisé (pas animé, valeur par défaut) est grisé et sa ligne est
   réduite automatiquement ; la flèche devant son nom réduit / agrandit la ligne, et un clic
   dans une ligne réduite l'agrandit (le clic suivant pose une clé).
   Pendant qu'on **glisse un point**, la mire (et le laser en live) montre l'instant de ce point avec sa
   nouvelle valeur (trait pointillé dans la timeline) ; au relâchement, elle revient à la tête de lecture.
5. Réglage **Actif** d'un modifieur (Propriétés) : automatisé, il n'active le modifieur que sur une partie du clip.
6. Molette : défilement de gauche à droite ; `Maj` + molette : pistes de haut en bas ; `Ctrl` + molette : zoom.
   Pavé tactile : glisser à deux doigts vers le haut / le bas = pistes, sur le côté = temps.
7. Zone de boucle : glisser dans la bande en haut de la règle, puis activer la boucle.
8. **Sélection de clips** (comme une vraie timeline) : glisser dans le vide = **rectangle de sélection** ;
   `Ctrl` (`Cmd`) + clic ou `Maj` + clic sur un clip = l'ajouter / le retirer ; `Ctrl+A` = tous les clips ;
   glisser un clip sélectionné déplace toute la sélection ; un simple clic dans le vide désélectionne et place
   la tête de lecture.
9. **Copier / coller des clips** (la timeline doit avoir le focus : cliquer dedans) : `Ctrl` (`Cmd`) + glisser
   dans les pistes sélectionne une **zone de temps** (clips + vide, aimantée à la grille). `Ctrl+C` copie la
   zone (sans zone : les clips sélectionnés), `Ctrl+D` les recopie juste après eux-mêmes, `Ctrl+V` colle à la **tête de lecture**, sur les mêmes pistes, avec
   les automations, puis **avance la tête de la longueur copiée** : `Ctrl+V` répété enchaîne les copies avec le
   même écart. `Ctrl+X` coupe, `Suppr` supprime les clips de la zone (ou sélectionnés), `Échap` annule la zone.

En lecture, la mire montre la sortie de la timeline et l'envoi live suit.

## Paramètres

Général (couleur par défaut, lissage, enregistrement automatique, réouverture, live au démarrage) · Grille · Sortie laser (vitesse, points,
blanking, coins) · Zone de sécurité · Trapèze · Taille / position (et puissance max).

## Tests

```sh
python tools/ilda-gen/tests/test_core.py
QT_QPA_PLATFORM=offscreen python tools/ilda-gen/tests/test_ui.py
```

## Structure du code

| Dossier | Rôle |
|---|---|
| `ildagen/core/` | Modèle sans interface : calques, transformations, modifieurs (`modifiers/`), évaluation, timeline, automations, document |
| `ildagen/laser/` | Optimisation des points, réglages de sortie, paquets IDN, fichiers ILDA |
| `ildagen/editor/` | État de l'éditeur, opérations, annuler / rétablir, sortie live, lecture, forme d'onde, export |
| `ildagen/ui/` | Interface Qt : thème, icônes, mire et outils, calques, propriétés, timeline, fenêtres |

Ajouter un modifieur : écrire une classe dans `ildagen/core/modifiers/` et l'ajouter à la liste `MODIFIERS` du module.
