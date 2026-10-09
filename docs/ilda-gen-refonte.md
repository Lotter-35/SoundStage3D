# ilda-gen v2 — plan de la refonte (Forme / Show / Live)

> **Statut : livré** (socle, coquille, espaces Forme, Show et Live ; tests `test_core`, `test_ui`, `test_widgets`,
> `test_forme`, `test_show`, `test_live`). Exigences correspondantes : cahier des charges §17.

Document de référence de la refonte : décisions prises avec l'utilisateur, modèle de données, découpage du code
et ordre des travaux. Maquettes : `docs/ilda-gen-maquettes/`. Direction artistique :
`docs/ilda-gen-direction-artistique.md`. Version d'avant la refonte (lançable) : `tools/ilda-gen-v1/`.

## 1. Décisions

| # | Décision |
|---|---|
| D1 | Trois **espaces de travail** séparés, choisis par des onglets au centre de la barre du haut : **Forme** (⌘1), **Show** (⌘2), **Live** (⌘3). Chaque espace a sa propre disposition, mémorisée. |
| D2 | **Forme** = la forme sans la notion de temps : dessin (outils façon Photoshop), calques, modifieurs **statiques**, réglés par **sliders**. Les mouvements **cycliques** (clignotement, rotation continue, oscillateurs) y sont permis : ils tournent en boucle, ils n'évoluent pas au fil du morceau. Pas de timeline ici. |
| D3 | **Show** = le temps : timeline calée sur la musique, clips de formes, **effets d'animation posés sur les clips** (valeur fixe, courbe ou oscillateur), chaque effet vise toute la forme ou un seul calque. Aperçu non modifiable, **aucun outil de dessin**. Double-clic sur un clip → sa forme s'ouvre dans Forme. |
| D4 | Dans Show on ne modifie pas les réglages statiques d'une forme (lecture seule + bouton « Ouvrir dans Forme »). L'effet « Réglage de la forme » permet quand même d'**animer** un réglage existant de la forme. |
| D5 | Même forme placée plusieurs fois : les clips **partagent leur animation** par défaut (icône chaîne). « Délier » copie seulement l'animation (la forme reste commune). Pour changer le dessin d'un seul clip : « Dupliquer la forme ». Plus de copies cachées de formes. |
| D6 | **Live** = grille de cues (8 × 4 par page, une page par partie du morceau) ; une case = **une forme** (avec ses effets en boucle) ; clic ou touche du clavier pour la lancer ; départ immédiat / au prochain temps / à la prochaine mesure ; un ou plusieurs cues à la fois ; **effets rapides** à maintenir. |
| D7 | **Maîtres** (lumière, taille, vitesse, position X/Y, rotation, couleur forcée) : cachés dans un panneau déroulant ouvert par le bouton « Maîtres » tout en haut à droite. Ils agissent sur toute la sortie et sur les aperçus. |
| D8 | **Barre du haut** : menus Fichier · Édition · Affichage · Lecture · Paramètres **dans la fenêtre** (aussi sur Mac), onglets au centre, à droite : état de connexion · Live · **BLACKOUT** · Maîtres. Pas de logo. |
| D9 | **DA neutre** : gris purs, un seul accent franc, pas de bleu par défaut, pas de couleurs délavées, pas de « look IA ». **10 thèmes** au choix (Paramètres → Apparence). Couleurs franches pour les pistes et les marqueurs. |
| D10 | Un seul endroit pour les réglages dans Forme : le panneau **Réglages** (sous Calques). L'arbre des calques n'affiche plus de réglages dans ses lignes. Quand un calque est sélectionné, Réglages montre ses réglages puis les **modifieurs qui agissent dessus** (cartes repliables). |
| D11 | **Ce qui est envoyé au laser suit l'espace actif** : Forme → la forme en cours (en boucle) ; Show → la timeline (à la tête de lecture, en lecture ou non) ; Live → les cues en cours + effets rapides. Maîtres puis réglages de sortie par-dessus. |
| D12 | Anciens projets : **on repart de zéro** pour l'animation. À l'ouverture d'un projet v1–v4, les formes et les clips sont gardés ; les anciennes automations et les copies cachées sont abandonnées (message d'information). |
| D13 | Molette : souris = **zoom** (comme Cmd + molette) ; pavé tactile = défilement à deux doigts, pincement = zoom. |
| D14 | Pas de message d'aide à la découverte (P13 refusé). |

## 2. Modèle de données (format de fichier v5)

```
Document
  library : Library            formes (ShapeDef) — seulement des formes visibles
  timeline : Timeline           pistes, clips, animations, marqueurs, musique, BPM
  live : LiveSet                pages de cues, mode de départ, plusieurs cues
  masters : Masters             état d'affichage (hors annulation, enregistré avec le projet)
  grid : GridSettings           état d'affichage (hors annulation)
  network
```

### 2.1 Forme (`core/library.py`, `core/nodes.py`, `core/oscillator.py`)

- `ShapeDef` : `id`, `name`, `root`. **Supprimés** : `automations`, `hidden`, `source_id`, `legacy`,
  `unlink_clip`, `relink_clip`, `link_clips`.
- Chaque nœud (forme, groupe, instance, modifieur) peut porter des **oscillateurs** sur ses réglages
  numériques : `node.osc = {clé: Osc}` (clés identiques aux clés de réglage actuelles : clés de modifieur,
  `tf.*`, `sp.*`, `col.*` numériques). Enregistré avec le nœud (`"osc": {...}`), copié avec lui.
- `Osc` (`core/oscillator.py`) :
  - `mode` : `"onde"` (la valeur oscille autour de la valeur réglée) ou `"vitesse"` (la valeur avance à vitesse
    constante : rotation continue, défilement) ;
  - onde : `wave` ∈ sine, triangle, square, saw, random (aléatoire lissé, graine fixe) ; `depth` (amplitude, en
    unités du réglage) ; `phase` 0..1 ;
  - cadence : `sync` (bool) + `division` (index dans `DIVISIONS` : 4 mesures, 2 mesures, 1 mesure, 1/2, 1/4,
    1/8, 1/16 de mesure… en temps) ou `hz` (si non synchronisé) ;
  - vitesse : `speed` (unités par seconde, ou par temps si `sync`) ;
  - `value(base, t, spec, bpm, bar_offset)` → valeur bornée par le `ParamSpec` ; en mode vitesse, un réglage
    borné des deux côtés (angle 0..360, phase…) **reboucle** (modulo) au lieu de se bloquer.
- Temps d'une forme : `t` = temps de boucle (heure murale depuis le début de la boucle × maître Vitesse),
  calé sur le tempo du projet (`timeline.bpm`, `timeline.bar_offset`).
- L'évaluation applique les oscillateurs via le mécanisme existant des `overrides {(node_id, clé): valeur}` de
  `EvalContext` (fonction `osc_overrides(root, t, ctx)`).

### 2.2 Show (`core/timeline.py`, `core/animation.py`, `core/effects/`)

- `Timeline` : `bpm`, `bar_offset`, `beats_per_bar`, `subdivision`, `snap`, boucle, musique, `tracks`,
  `animations: {anim_id: Animation}`, `markers: [Marker]`.
- `Track` : `id`, `name`, `color` (une des couleurs franches de `TRACK_COLORS`), `muted`, `solo`, `clips`.
- `Clip` : `id`, `def_id`, `start`, `duration`, `anim_id`, `fade_in`, `fade_out` (secondes, ≥ 0, somme ≤
  durée). Affichage (hors annulation) : `expanded`. **Supprimés** : `automations`, `closed_nodes`,
  `lane_sizes`, `overrides_at` (remplacé par l'évaluation des effets).
- **Pas de chevauchement** sur une piste : les opérations (déplacer, redimensionner, coller, déposer) bornent
  le clip contre ses voisins ; un dépôt sur une place occupée va juste après, ou sur une nouvelle piste.
- `Animation` : `id`, `effects: [Effect]` (appliqués dans l'ordre de la liste, de haut en bas).
- `Effect` : `id`, `type_id`, `target` (`""` = toute la forme, sinon l'id d'un calque de la forme),
  `enabled`, `params: {clé: ParamTrack}`.
- `ParamTrack` : `mode` ∈ `"fixe"`, `"courbe"`, `"osc"` ; `value` (fixe) ; `curve` (une `Automation` existante :
  clés en proportion 0..1 de la durée du clip, types de courbe actuels) ; `osc` (`Osc`).
- Liaison (D5) : `Clip.anim_id`. Un nouveau clip d'une forme déjà présente dans la timeline reprend
  l'`anim_id` d'un clip existant de cette forme ; sinon nouvelle animation vide. Coller / dupliquer : même
  `anim_id`. **Délier** : copie de l'animation (nouveaux ids) pour ce clip seul. **Relier** : reprendre
  l'animation d'un autre clip de la même forme. Une animation qui ne sert plus à aucun clip est supprimée.
- `Marker` : `id`, `t`, `name`, `color`.
- **Registre des effets** (`core/effects/`) : chaque effet réutilise un modifieur existant (même code
  d'application) avec un libellé, une catégorie et une liste de réglages animables :
  - Mouvement : Rotation (`rotate`), Taille (`scale`), Position (`translate`), Bascule 3D (`tilt3d`) ;
  - Apparition : Fondu (`dimmer`), Dessin progressif (`trim`), **Masquer** (nouveau : réglage booléen
    « Masqué ») ;
  - Division : Répétition (`repeat`), Symétrie radiale (`radial_sym`), **Éclatement** (nouveau : écarte les
    tracés du centre) ;
  - Couleur et rythme : Couleur (`color`), Arc-en-ciel (`rainbow`), Stroboscope (`strobe`), Pulsation (`pulse`) ;
  - Déformation : Onde (`wave`) ;
  - Avancé : **Réglage de la forme** (cible = un calque + une clé de réglage ; anime ce réglage).
- Évaluation d'un clip au temps `t` : `u = (t − start) / duration` ; valeur de chaque réglage d'effet selon son
  mode (fixe / courbe(u) / osc(t)) ; les effets visant un calque s'appliquent au résultat de ce calque pendant
  le parcours de l'arbre (`ctx.node_effects`), ceux visant toute la forme s'appliquent au résultat final ;
  « Réglage de la forme » passe par `ctx.overrides`. Les oscillateurs de la forme tournent aussi (temps
  local du clip). Fondus d'entrée et de sortie : intensité multipliée par une rampe.

### 2.3 Live (`core/live.py`)

- `LiveSet` : `pages: [Page]`, `launch` (0 immédiat, 1 au temps, 2 à la mesure), `multi` (bool).
- `Page` : `id`, `name`, `cues` (32 cases, `Cue` ou `None`).
- `Cue` : `id`, `def_id`, `key` (touche du clavier, par défaut AZERTYUI / QSDFGHJK / WXCVBN,; selon la case).
- État d'exécution (non enregistré, dans `editor/live_runtime.py`) : cues en cours (id → heure de départ
  quantifiée), cues en attente, effets rapides maintenus. Évaluation : chaque cue en cours = sa forme au temps
  local depuis son départ (oscillateurs compris) ; puis effets rapides.
- **Effets rapides** : liste fixe de 8 (`QUICK_EFFECTS`) : Strobo 1/8, Rotation, Arc-en-ciel, Fondu noir,
  Pulsation, Onde, Miroir, Points — chacun = un effet du registre avec des réglages tout faits.

### 2.4 Maîtres (`core/masters.py`)

- `Masters` : `brightness` (0..100 %), `size` (10..200 %), `speed` (0..4 ×), `x`, `y` (−1..1),
  `rotation` (°), `color` (None ou (r, g, b) : couleur forcée de tous les points allumés).
- Appliqués à la sortie live (avant les réglages de sortie) et aux aperçus. La vitesse multiplie le temps des
  oscillateurs et des cues (pas la lecture de la musique). Hors annulation, enregistrés avec le projet.

### 2.5 Fichier

- `FORMAT_VERSION = 5`. Lecture d'un fichier v1–v4 : formes gardées (automations et copies cachées
  ignorées), clips gardés avec une animation vide (liée par forme comme D5), pas de Live ; message
  « Projet d'une ancienne version : les animations ont été retirées ».
- État d'affichage hors annulation (`core/view_state.py`) : grille, maîtres, clips dépliés, calques dépliés,
  espace actif et dispositions.

## 3. Éditeur (`editor/`)

- `EditorState.workspace` ∈ `"forme"`, `"show"`, `"live"` ; `set_workspace()` ; signal `workspaceChanged`.
- Forme : `current_form_id`, sélection de calques, outils (inchangés), oscillateurs (`set_osc(node, key, osc)`,
  `clear_osc`), réglages.
- Show : sélection de clips (un seul modèle de sélection : le clip actif fait toujours partie de la
  sélection), opérations de clips (ajout, déplacement, redimension, couper/coller, délier/relier, fondus),
  effets (`add_effect`, `remove_effect`, `move_effect`, `set_effect_target`, `set_track_mode`, clés de courbe),
  marqueurs, pistes (couleur, nom, ordre).
- Live : pages, cues (`set_cue`, `clear_cue`, `set_cue_key`), lancement / arrêt (`trigger_cue`), effets rapides.
- Maîtres : `set_master(key, value)` ; signal `mastersChanged`.
- Sortie (`editor/live_snapshot.py`) : la source suit `workspace` (D11).
- Annuler / rétablir : inchangé (instantanés), l'état d'affichage n'est jamais annulé.

## 4. Interface (`ui/`)

| Paquet | Contenu |
|---|---|
| `ui/theme.py` | Thèmes (10), jetons de couleur, feuille de style, changement à chaud (`theme.set_theme`, signal) |
| `ui/widgets/` | Briques communes : `SliderField` (barre remplie façon Blender : glisser, molette, flèches, saisie, Échap, ↺), `Switch` (Oui/Non), `Segmented`, `ColorChips`, `Card`, `LaserView` (rendu laser avec halo léger, désactivable), `Tile` (vignette animée) |
| `ui/shell/` | Barre du haut (menus dans la fenêtre, onglets, connexion, Live, BLACKOUT, Maîtres), panneau des maîtres, pile des trois espaces, barre d'état |
| `ui/forme/` | Espace Forme : outils, liste des formes en vignettes, mire, barre de boucle, Calques, Réglages (sliders, cartes de modifieurs, oscillateurs) |
| `ui/show/` | Espace Show : bibliothèque (formes + effets), aperçu, timeline, inspecteur du clip (effets d'animation) |
| `ui/live/` | Espace Live : pages, grille de cues, sortie, effets rapides |
| `ui/canvas/`, `ui/layers/`, `ui/timeline/` | Code existant réutilisé et adapté par les espaces |

## 5. Thèmes (D9)

Base Graphite : app `#141414`, panneau `#1c1c1c`, champ `#262626`, survol `#2c2c2c`, sélection `#383838`,
bordure `#2b2b2b`, texte `#e4e4e4` / `#9b9b9b` / `#5f5f5f`. Base Noir : app `#0a0a0a`, panneau `#111111`,
champ `#1c1c1c`, sélection `#2a2a2a`, bordure `#222222`. Base Ardoise (chaude) : app `#171615`, panneau
`#1f1e1c`, champ `#2a2826`, sélection `#3a3734`, bordure `#2e2c29`.

| Thème | Base | Accent |
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
| Monochrome | Graphite | `#e8e8e8` |

Rouge `#e03b3b` réservé à BLACKOUT / danger, vert `#22b14c` à « connecté / live », quel que soit le thème.
Couleurs de piste (`TRACK_COLORS`) : `#00c853`, `#ffd000`, `#d500f9`, `#ff3d00`, `#00e5ff`, `#ff4081`,
`#c6ff00`, `#ff9100`.

## 6. Vocabulaire

| Avant | Après |
|---|---|
| Formes de base (outils) | **Tracés de base** |
| Envoi live / BLACKOUT | **Live** / **BLACKOUT** (gardé) |
| Images/s, img/s, images/s | **images/s** partout |
| Intensité (dosage d'un modifieur) | **Dosage** |
| Dots | **Points** |
| Beams | **Faisceaux** |
| « Mesure 1 à » / « Ici » | **Début de la mesure 1** / **Caler sur la tête de lecture** |
| Paramètres → « À propos » | Menu **Aide → À propos** |

Réglages : unités partout (%, °, s, ×), réglages inutiles **masqués** selon le mode (ex. Fréquence ou
Division du stroboscope selon Synchro), plages de glisser confortables (Graine).

## 7. Bugs à corriger pendant la refonte

Listes T (timeline), C (calques / propriétés), L (clips liés), F (fenêtre / DA) et M (mire / outils) de l'audit,
rangées par espace :
- **Forme** : C1–C17, M1–M8, F3, F6.
- **Show** : T1–T13, L1–L10 (la plupart disparaissent avec D5), F1.
- **Coquille** : F2, F4, F5, D13.

## 8. Ordre des travaux

1. **Socle (en parallèle)** : (a) modèle v5, évaluation, éditeur, sortie qui suit l'espace actif ;
   (b) thèmes, briques d'interface, molette.
2. **Coquille** : barre du haut, onglets, maîtres, pile des espaces.
3. **Espaces (en parallèle)** : Forme, Show, Live.
4. **Intégration** : tests, documentation (cahier des charges v2, README), captures comparées aux maquettes.

Pendant la refonte, `tools/ilda-gen/` peut avoir des fonctions temporairement absentes : la version
`tools/ilda-gen-v1/` reste utilisable.

## 9. Mise en œuvre du modèle v5 : précisions et écarts

Ce qui a été fait différemment du plan (ou précisé) en écrivant le socle (a), et pourquoi :

- **Temps des oscillateurs** : forme en boucle, clip (temps local du clip) et cue (temps depuis son départ)
  comptent leurs cycles à partir de 0, pas de `timeline.bar_offset` (qui est une heure de la timeline) ; les
  départs des clips et des cues étant calés sur la grille, les cycles le sont aussi. Les modifieurs calés sur
  le tempo (stroboscope…) gardent l'heure de la timeline dans Show.
- **Maître Vitesse** : une horloge accélérée continue (`core/masters.py`, `SpeedClock`) au lieu de « heure
  murale × vitesse », pour que changer la vitesse ne fasse pas sauter les animations (laser en direct). Dans
  Show, la vitesse multiplie le temps local des oscillateurs (forme et effets) ; elle n'agit pas sur l'image.
- **Grille des départs du Live** : `LiveRuntime.origin` (heure murale d'un début de mesure, remise à zéro par
  `set_live_origin`, pour Tap) avec `timeline.bpm` ; `bar_offset` ne s'applique pas à l'heure murale.
  Relancer un cue en cours l'arrête (au prochain départ calé) ; relancer un cue en attente l'annule.
- **Effets** : `Effect.key` en plus (réglage animé par « Réglage de la forme », dont l'unique réglage s'appelle
  `value`). Les effets d'une liste s'appliquent dans l'ordre (le premier d'abord). Un effet qui vise un
  calque supprimé ne fait rien. Le registre contient aussi un effet interne « Points » (`dots`, absent de la
  bibliothèque de Show) : l'effet rapide « Points » en a besoin. « Miroir » = Symétrie radiale ×2 en
  kaléidoscope. Les effets rapides partent au moment de l'appui ; « Fondu noir » descend en 0,5 s (`attack`).
- **Maîtres et aperçus** : `display_strokes()` (mire) rend le contenu sans les maîtres (on dessine dans le
  repère de la forme) ; les aperçus qui doivent les montrer appellent `apply_masters(strokes, masters)`.
  La sortie laser les applique toujours (avant les réglages de sortie).
- **Outils de la mire** : `eval_context()` ignore les oscillateurs (on déplace les valeurs de base, jamais
  une valeur qui oscille) ; seul l'affichage les montre.
- **Anciens projets** : des clips qui se chevauchaient passent sur une autre piste (même instant) ; une copie
  cachée dont la forme d'origine n'existe plus est gardée comme forme normale. Le message n'est montré que si
  des animations ont réellement été retirées (`Document.load_notice()`).
- **Live dans le fichier** : pages, cues, mode de départ et « plusieurs cues » sont du contenu (annulables) ;
  la page affichée est de l'état d'affichage (`doc.view["live_page"]`, avec `workspace` et `layouts` pour les
  dispositions des espaces). Touches par défaut de la 4e ligne : `F1` à `F8` (espace Live : les chiffres 1 à 8 tiennent les effets rapides, ils ne sont jamais donnés à un cue ; `normalize_key` accepte aussi
  la rangée des chiffres d'un clavier AZERTY sans Maj). Une touche déjà prise sur la page n'est pas donnée deux
  fois.
- **Compatibilité** : `Library.visible()` (toutes les formes) et `EditorState.contextChanged` (forme en cours ou
  espace changés) sont gardés pour l'interface actuelle ; `enter_def()` = « Ouvrir dans Forme ».
