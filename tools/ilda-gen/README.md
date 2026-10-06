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
| Gauche | Outils (sélection, crayon, seau), formes de base, couleur de tracé, formes personnalisées |
| Centre | La mire (zone de projection), grille orthogonale ou polaire, compteur de points |
| Droite | Calques, puis Propriétés (repliable) |
| Bas | Timeline : transport, BPM, grille musicale, musique, pistes, automations |

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
| Sans grille / orthogonale / polaire | `Ctrl+1` / `Ctrl+2` / `Ctrl+3` |
| Aimant (les poignées s'accrochent à la grille) | `Ctrl+;` ou bouton aimant au-dessus de la mire |
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
| Double-clic sur une forme personnalisée | L'éditer (toutes ses occurrences suivent) |

Une **ligne** seule n'a pas d'épaisseur : pas de cadre, seulement ses deux extrémités (glisser ; `Maj` =
aimant de grille, ou pas de 15° sans grille) et une poignée de rotation.

### Couleur de tracé et seau

Section **Couleur** de la barre de gauche (comme Photoshop) : le **grand carré** est la couleur active (clic
pour la changer), le **petit carré** derrière est la seconde couleur (clic ou `X` pour inverser, `D` pour
blanc / rouge). L'**aperçu du dégradé** à côté : clic pour tracer en dégradé ; son éditeur s'affiche dessous
(le long du tracé, linéaire, radial ou angulaire). Les nouvelles formes et le seau prennent la couleur ou le
dégradé actif. **Si des formes sont sélectionnées, tout changement de couleur ou de dégradé s'applique à elles
en direct** (annulable). La couleur d'une forme se modifie aussi dans Propriétés.

| Geste (outil Seau, `G`) | Effet |
|---|---|
| Clic sur une forme | Lui applique la couleur de tracé |
| Clic sur une forme sélectionnée | Colorie toute la sélection (groupes compris) |
| `Alt` + clic | Colorie tout le groupe qui contient la forme |

Un modifieur de couleur placé au-dessus
d'une forme reste prioritaire sur sa couleur propre.

## Calques et modifieurs

Boutons sous les calques : **Modifieur** (menu de tous les modifieurs), **nouveau calque** (vide ; le prochain trait au crayon le remplit), **nouveau
groupe** (groupe la sélection s'il y en a une), **forme personnalisée**, **supprimer**.


- Chaque forme est un calque. Glisser-déposer pour réordonner ou ranger dans un groupe (ligne bleue = position).
- Œil : afficher / masquer (masquer un groupe masque tout son contenu). Cadenas : verrouiller. Un groupe
  verrouillé ne se déplie plus mais se sélectionne et se déplace comme un seul bloc.
- **Modifieurs** (bouton « Modifieur » sous les calques, ou clic droit → Ajouter un modifieur) : ils agissent sur tout ce qui est **en dessous d'eux dans
  le même groupe**. Leurs réglages s'affichent sous la ligne du calque et dans Propriétés.
  Modifieur sélectionné ou survolé : une barre bleue à gauche relie le modifieur aux calques qu'il modifie,
  ces formes sont entourées en pointillés dans la mire et Propriétés indique « Agit sur : … ».
- **Modifieur sur modifieur** : clic droit sur un modifieur → Ajouter un sous-modifieur (Translation, Rotation,
  Échelle), ou glisser une Translation sur un modifieur. Exemples : Translation sur Dots = décalage des points le
  long du trait ; Translation sur Symétrie = déplacement du centre du miroir.
- Couleur par défaut : blanc (modifiable dans Paramètres).

Modifieurs disponibles : Translation, Rotation, Inclinaison 3D, Profondeur Z, Échelle, Miroir, Pivot ·
Symétrie miroir, Symétrie radiale / kaléidoscope, Répétition linéaire · Onde, Simplification · Dots, Tirets,
Dessin progressif, Masque de zone, Beams · Couleur, Dégradé, Défilement de couleur, Arc-en-ciel,
Teinte / saturation / luminosité, Segments alternés, Couleur aléatoire, Remplacement de couleur ·
Luminosité, Fondu le long du tracé, Stroboscope, Pulsation.

## Formes personnalisées

Sélectionner des calques (ou rien = tout) → clic droit → **Créer une forme personnalisée**. Les calques sont
remplacés par une occurrence de la forme, qui apparaît à gauche. Glisser : vers la mire ou la timeline ;
double-clic : l'éditer ; `Suppr` : la supprimer avec toutes ses occurrences (annulable).

## Timeline

1. **Musique…** pour importer un morceau (forme d'onde affichée), régler le **BPM** (ou **Tap**), le nombre de
   temps par mesure, la **grille** (temps, 1/2, 1/4, 1/8, triolets) et le départ de la **mesure 1** (« Ici » =
   tête de lecture).
2. Glisser une forme personnalisée sur une piste : un clip est créé. Glisser le clip pour le déplacer, ses bords
   pour changer sa durée. L'**aimant** accroche tout à la grille (`Alt` pendant un glisser = libre).
3. Clic droit sur le clip → **Nouvelle automation** : elle attend son réglage. Toucher ensuite n'importe quel
   réglage (Propriétés, ligne du modifieur, ou déplacer / tourner la forme dans la mire) : l'automation s'y lie.
   Chaque réglage touché ensuite écrit une clé à la tête de lecture.
4. Dans la ligne d'automation : clic = ajouter une clé, glisser = déplacer, clic droit = type de courbe
   (linéaire, accélération, ralentissement, en S, palier, Bézier personnalisé avec poignées) ou supprimer.
5. Réglage **Actif** d'un modifieur (Propriétés) : automatisé, il n'active le modifieur que sur une partie du clip.
6. Zone de boucle : glisser dans la bande en haut de la règle, puis activer la boucle.

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
