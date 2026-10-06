# Générateur ILDA (ilda-gen) — cahier des charges

Reformulation complète de la note de projet. **Rien n'est codé à ce stade** : ce document liste tout ce qui
devra l'être. Chaque exigence a un identifiant (ex. `CAL-07`) pour pouvoir la suivre pendant le développement.

> Note : dans la dictée d'origine, « Hilda » = **ILDA** (format et protocole des lasers de spectacle).

Légende :
- **[Demandé]** : explicitement dans la note.
- **[Déduit]** : pas écrit mais nécessaire pour que le demandé fonctionne.
- **[Proposé]** : amélioration suggérée, à valider (voir § 14, questions).

---

## 1. Vision générale

| ID | Exigence | Statut |
|---|---|---|
| GEN-01 | Générateur ILDA **différent de ce qui existe sur le marché**, écrit soi-même. | Demandé |
| GEN-02 | Écrit en **Python**. | Demandé |
| GEN-03 | Envoie l'ILDA **directement à un serveur DAC** par le réseau. | Demandé |
| GEN-04 | Workflow en 3 étages : **dessin** (calques/formes) → **modifieurs** (statiques) → **timeline** (modifieurs animés dans le temps, calée sur la musique). | Demandé |
| GEN-05 | Tout doit être **fluide** (dessin, déplacement des calques, timeline). | Demandé |

---

## 2. Fenêtre principale et disposition

| ID | Exigence | Statut |
|---|---|---|
| WIN-01 | Fenêtre principale **redimensionnable / agrandissable** (plein écran possible). | Demandé |
| WIN-02 | Interface **responsive** : tout se réorganise quand la fenêtre change de taille. | Demandé |
| WIN-03 | **Tous les panneaux internes sont redimensionnables** (séparateurs déplaçables : colonnes, sous-fenêtres). | Demandé |
| WIN-04 | Disposition : barre de menus (haut) → barre de connexion (haut) → barre d'outils (gauche) → mire (centre) → calques (droite, collés au bord droit de la fenêtre) → timeline (bas). | Demandé (timeline en bas : Déduit) |
| WIN-05 | Toutes les actions secondaires passent par le **clic droit** (menus contextuels), pas de boutons partout. | Demandé |

---

## 3. Barre de menus

### 3.1 Menu « Fichier »

| ID | Exigence | Statut |
|---|---|---|
| MEN-01 | Bouton **Fichier** classique en haut à gauche. | Demandé |
| MEN-02 | **Nouveau projet**. | Demandé |
| MEN-03 | **Sauvegarder le projet** = sauvegarde de **l'état complet du logiciel** (calques, groupes, modifieurs, formes personnalisées, timeline, musique liée, BPM, réglages réseau…). | Demandé |
| MEN-04 | **Exporter en ILDA** (fichier `.ild`). | Demandé |
| MEN-05 | **Ouvrir un projet** existant. | Déduit |
| MEN-06 | **Enregistrer sous…**, fichiers récents. | Proposé |
| MEN-07 | **Importer une musique** (peut aussi être dans la timeline). | Demandé (emplacement à définir) |

### 3.2 Menu « Paramètres »

| ID | Exigence | Statut |
|---|---|---|
| MEN-10 | Menu **Paramètres** pour modifier des réglages. **Vide pour l'instant**, mais la structure doit exister. | Demandé |

---

## 4. Barre de connexion (haut de la zone principale)

| ID | Exigence | Statut |
|---|---|---|
| NET-01 | Champ **IP** du DAC. | Demandé |
| NET-02 | Champ **Port**. | Demandé |
| NET-03 | Choix du **réseau utilisé** (carte réseau / interface). | Demandé (sens exact à confirmer) |
| NET-04 | **Indicateur de connexion** au DAC (connecté / non connecté). | Demandé |
| NET-05 | Bouton **Envoi live ON/OFF** : envoie en direct au laser ce qu'on est en train de faire. | Demandé |
| NET-06 | Bouton **Blackout / arrêt d'urgence** (coupe immédiatement la sortie laser). | Proposé |

---

## 5. Barre d'outils (gauche)

| ID | Exigence | Statut |
|---|---|---|
| TLB-01 | Outil **Flèche de sélection**. | Demandé |
| TLB-02 | Outil **Crayon**. | Demandé |
| TLB-03 | Section **Formes de base** : trait, carré, rond, triangle (« des choses assez basiques »). | Demandé |
| TLB-04 | Forme de base **Mire ILDA de test** (pour les réglages du laser). | Demandé |
| TLB-05 | Autres formes de base possibles : étoile, polygone à N côtés, arc… | Proposé (l'étoile est citée plus loin dans la note) |
| TLB-06 | Section **Formes personnalisées** : reçoit les formes créées depuis les calques (voir § 10). | Demandé |
| TLB-07 | Raccourcis clavier pour les outils (ex. `V` sélection, `B` crayon). | Proposé |

---

## 6. Mire (zone centrale)

| ID | Exigence | Statut |
|---|---|---|
| MIR-01 | Au centre : la **mire** = le carré de projection du laser (espace ILDA). | Demandé |
| MIR-02 | Affichage optionnel d'une **grille orthogonale** classique. | Demandé |
| MIR-03 | Affichage optionnel d'une **grille polaire** : cercles concentriques + rayons, avec la **croix au centre**. | Demandé |
| MIR-04 | Les deux modes de grille sont **exclusifs** (on choisit l'un ou l'autre, ou aucun). | Demandé |
| MIR-05 | Densité des grilles réglable (pas, nombre de cercles, nombre de rayons). | Proposé |
| MIR-06 | Zoom / déplacement de la vue de la mire. | Proposé |
| MIR-07 | Rendu fidèle de ce que fait le laser (couleurs, points, trajets éteints optionnels). | Proposé |

---

## 7. Outil Crayon

| ID | Exigence | Statut |
|---|---|---|
| CRA-01 | **Clic gauche maintenu** : dessin **à main levée**, le trait suit la souris. | Demandé |
| CRA-02 | Pendant le dessin, la forme est **envoyée directement en ILDA au laser** (si envoi live actif). | Demandé |
| CRA-03 | Chaque trait dessiné crée **un nouveau calque** dans la pile. | Demandé |
| CRA-04 | **Shift maintenu** : un **point d'aperçu** s'affiche et se **colle (snap) à la grille active** (intersections orthogonales, ou cercles/rayons polaires). | Demandé |
| CRA-05 | **Shift + clic** : pose un point précisément sur la grille. | Demandé |
| CRA-06 | **Shift + glisser** en grille orthogonale : trace une **ligne droite** entre deux points snappés. | Demandé |
| CRA-07 | **Shift + glisser** en grille polaire : le long d'un cercle → **arc de cercle** (arc, demi-cercle, cercle complet) ; le long d'un rayon de la croix → **trait radial**. | Demandé |
| CRA-08 | Enchaîner plusieurs segments/arcs pour construire une forme complexe facilement. | Demandé (« on peut dessiner tout ça facilement ») |
| CRA-09 | Lissage / simplification du trait à main levée (moins de points, laser plus stable). | Proposé |

---

## 8. Outil Sélection et transformations

### 8.1 Sélection

| ID | Exigence | Statut |
|---|---|---|
| SEL-01 | Clic sur une forme dans la mire = sélection (et sélection du calque correspondant). | Demandé |
| SEL-02 | Forme sélectionnée entourée d'un **cadre en pointillés** (boîte englobante), quelle que soit la forme (triangle, étoile…). | Demandé |
| SEL-03 | Sélection multiple dans la mire (Ctrl/Shift + clic). | Demandé (« on sélectionne différentes formes ») |
| SEL-04 | Sélection par **rectangle** (glisser dans le vide). | Proposé |
| SEL-05 | Copier / couper / coller / supprimer **depuis la mire** comme depuis les calques. | Demandé |
| SEL-06 | Glisser la forme = **déplacement**. | Demandé |

### 8.2 Transformations type Photoshop (liste complète demandée)

Poignées : 4 coins, 4 milieux de côtés, 1 poignée de **rotation au-dessus** du cadre, 1 **point de pivot** au centre.

| ID | Geste | Effet | Statut |
|---|---|---|---|
| TRF-01 | Glisser un **coin** | Redimensionnement libre (largeur et hauteur indépendantes) | Demandé |
| TRF-02 | **Shift** + coin | Redimensionnement **proportionnel** | Demandé |
| TRF-03 | **Alt** + coin | Redimensionnement libre **depuis le centre** | Demandé |
| TRF-04 | **Shift + Alt** + coin | Proportionnel **depuis le centre** | Demandé |
| TRF-05 | Glisser un **milieu de côté** | Étirement sur un seul axe | Demandé |
| TRF-06 | **Alt** + milieu de côté | Étirement symétrique depuis le centre | Demandé |
| TRF-07 | **Ctrl** + coin | **Distorsion** libre (déplace un coin seul) | Demandé (« Ctrl ») |
| TRF-08 | **Ctrl + Shift** + milieu de côté | **Inclinaison** (skew/cisaillement) | Demandé |
| TRF-09 | **Ctrl + Alt + Shift** + coin | **Perspective** (coin opposé symétrique) | Demandé |
| TRF-10 | Glisser la **poignée au-dessus** du cadre | **Rotation** | Demandé |
| TRF-11 | **Shift** + rotation | Rotation par pas de 15° | Demandé |
| TRF-12 | Déplacer le **point de pivot** | Change le centre de rotation/échelle | Proposé |
| TRF-13 | **Shift** + déplacement | Contraint à l'axe H/V **et/ou** snap sur la grille : la forme se **centre** sur les lignes, la croix, les cercles | Demandé |
| TRF-14 | **Alt** + déplacement | Duplique la forme | Proposé |
| TRF-15 | Flèches clavier / Shift + flèches | Déplacement fin (1 / 10 unités) | Proposé |
| TRF-16 | Clic droit → Symétrie horizontale / verticale (flip) | Retourne la forme | Proposé |
| TRF-17 | **Déplacement en 3 dimensions** : rotation autour de X et Y (inclinaison en perspective) et position Z | Demandé (sens à confirmer) |
| TRF-18 | Lignes simples : poignées dédiées (2 extrémités + rotation) | Déduit (existe déjà dans l'outil actuel) |

### 8.3 Création des formes de base

| ID | Exigence | Statut |
|---|---|---|
| FRM-01 | Choisir une forme dans la barre d'outils puis la tracer en glissant dans la mire. | Déduit |
| FRM-02 | Shift = proportions forcées (carré parfait, cercle parfait), Alt = depuis le centre, snap à la grille. | Proposé (cohérent avec § 8.2) |
| FRM-03 | Chaque forme posée = un nouveau calque. | Demandé |

---

## 9. Panneau des calques (droite)

### 9.1 Pile et manipulation

| ID | Exigence | Statut |
|---|---|---|
| CAL-01 | Panneau à **droite de la mire**, collé au bord droit de la fenêtre. | Demandé |
| CAL-02 | Chaque forme dessinée **s'empile** comme un nouveau calque. | Demandé |
| CAL-03 | **Ctrl + A** : sélectionne tous les calques. | Demandé |
| CAL-04 | **Suppr** : supprime les calques sélectionnés. | Demandé |
| CAL-05 | **Glisser-déposer** pour réordonner, mettre les calques les uns sur les autres / dans des groupes. | Demandé |
| CAL-06 | Pendant le glisser, un **indicateur montre où le calque va arriver**. | Demandé |
| CAL-07 | Clic sur un calque = **sélection de la forme dans la mire** (avec son cadre pointillé), et inversement. | Demandé |
| CAL-08 | **Ctrl + clic** : ajoute / retire de la sélection. | Demandé |
| CAL-09 | **Shift + clic** : sélection d'une plage de calques. | Proposé |
| CAL-10 | **Ctrl + C / Ctrl + X / Ctrl + V** : copier, couper, coller. | Demandé |
| CAL-11 | Toutes ces actions aussi au **clic droit** (copier, couper, coller, supprimer, sélectionner…). | Demandé |
| CAL-12 | Renommer un calque (double-clic ou clic droit). | Proposé |
| CAL-13 | Glisser-déposer **fluide**. | Demandé |

### 9.2 Groupes

| ID | Exigence | Statut |
|---|---|---|
| GRP-01 | Clic droit → **Grouper** les calques sélectionnés. | Demandé |
| GRP-02 | Clic droit → **Dégrouper**. | Demandé |
| GRP-03 | **Sous-groupes** (groupes dans des groupes, sans limite de profondeur). | Demandé |
| GRP-04 | Clic droit → **Créer un groupe vide**, puis y glisser des calques / groupes. | Demandé |
| GRP-05 | Chaque groupe se **déplie / replie**. | Demandé |
| GRP-06 | **Verrouiller (lock)** un groupe : il ne peut plus être déplié, son contenu est figé. | Demandé |
| GRP-07 | **Déverrouiller** pour éditer à nouveau les sous-groupes et calques internes. | Demandé |
| GRP-08 | Un groupe verrouillé se sélectionne et se transforme comme **un seul bloc** dans la mire. | Déduit |

### 9.3 Visibilité

| ID | Exigence | Statut |
|---|---|---|
| VIS-01 | **Œil** sur chaque calque et chaque groupe : afficher / masquer. | Demandé |
| VIS-02 | Masquer un groupe **met l'œil masqué sur tous ses éléments** (récursif). | Demandé |
| VIS-03 | Un élément masqué n'est **ni affiché, ni envoyé au laser, ni exporté**. | Déduit |

---

## 10. Formes personnalisées

| ID | Exigence | Statut |
|---|---|---|
| FPS-01 | Sélectionner des calques (ou tout) → clic droit → **Créer une forme**. | Demandé |
| FPS-02 | La forme apparaît dans la barre d'outils gauche, section **Formes personnalisées**. | Demandé |
| FPS-03 | La forme personnalisée **contient tout** : calques, groupes **et modifieurs**. | Demandé |
| FPS-04 | Les formes personnalisées sont **sauvegardées dans le projet**. | Demandé |
| FPS-05 | Une forme personnalisée peut être replacée dans la mire (dessin) **et dans la timeline**. | Demandé |
| FPS-06 | Bibliothèque de formes partagée entre projets. | Proposé |

---

## 11. Modifieurs (statiques)

### 11.1 Principe

| ID | Exigence | Statut |
|---|---|---|
| MOD-01 | Un modifieur est un **élément de la pile des calques**, placé comme un calque. | Demandé |
| MOD-02 | Il **agit sur tous les éléments situés en dessous de lui**. | Demandé (portée exacte à confirmer) |
| MOD-03 | Permet de choisir **quelles zones** sont touchées (ex. colorer une partie, pas une autre) grâce à sa position dans la pile / les groupes. | Demandé |
| MOD-04 | La **couleur n'est pas choisie au dessin** : elle vient des modifieurs de couleur. | Demandé |
| MOD-05 | **Modifieurs sur modifieurs** : un modifieur peut modifier le résultat ou les réglages d'un autre (ex. translation X appliquée à un Dots → décale les points). | Demandé |
| MOD-06 | **Statiques pour l'instant** : ils figent la forme d'une certaine manière, sans animation. | Demandé |
| MOD-07 | Ajout d'un modifieur via **clic droit** dans les calques. | Déduit (règle « tout au clic droit ») |
| MOD-08 | Réglage des paramètres d'un modifieur (valeurs numériques, couleurs). | Déduit (emplacement à définir) |
| MOD-09 | Activer / désactiver un modifieur (œil ou bouton bypass). | Proposé |
| MOD-10 | Liste de modifieurs **extensible** facilement (architecture plug-in). | Demandé (« on verra pour en rajouter ») |

### 11.2 Liste des modifieurs demandés

| ID | Modifieur | Effet | Statut |
|---|---|---|---|
| MDL-01 | **Couleur** | Tous les éléments en dessous prennent la couleur (ex. rouge). | Demandé |
| MDL-02 | **Translation X / Y** | Déplace les formes (haut/bas, gauche/droite). | Demandé |
| MDL-03 | **Translation Z** | Profondeur (cité « X, Y, Z »). | Demandé (sens à confirmer) |
| MDL-04 | **Rotation** | Tourne les formes. | Demandé |
| MDL-05 | **Dégradé de couleur** | Couleur variable le long de la forme. | Demandé |
| MDL-06 | **Dots (pointillés)** | Transforme la ligne en suite de petits points. | Demandé |
| MDL-07 | **Symétrie** | x2, x4, x8… « toutes les symétries possibles ». | Demandé |
| MDL-08 | **Centre de symétrie déplaçable** | Le miroir n'est pas forcément au centre : déplaçable en X (et Y/Z) via un modifieur de translation appliqué sur la symétrie. | Demandé |
| MDL-09 | **Translation de couleur** | Décalage / défilement du dégradé, avec direction réglable. | Demandé |
| MDL-10 | Autres idées : échelle, ondulation (sinus), scintillement, découpe partielle (tracé de 0 à 100 %), luminosité. | Proposé |

### 11.3 Création automatique de modifieurs (style FL Studio)

| ID | Exigence | Statut |
|---|---|---|
| AUT-01 | Mode où **manipuler une forme crée automatiquement le modifieur correspondant** : déplacer en X → ajoute un modifieur Translation X avec la valeur. | Demandé |
| AUT-02 | Le modifieur ainsi créé reste **réglable après coup** (comme un paramètre « dernier touché » dans FL Studio). | Demandé |
| AUT-03 | But : les modifieurs créés deviennent **animables dans la timeline**. | Demandé |

---

## 12. Timeline

### 12.1 Clips

| ID | Exigence | Statut |
|---|---|---|
| TML-01 | On place des **formes personnalisées** dans la timeline. | Demandé |
| TML-02 | Réglage de la **durée d'affichage** du clip (présent / absent). | Demandé |
| TML-03 | Un clip peut être **déplié en hauteur** pour faire apparaître ses **modifieurs** (une ligne d'automation par modifieur / paramètre). | Demandé |
| TML-04 | Un modifieur peut n'être actif que **sur une partie de la durée** du clip (ex. clip de 5 s, Dots seulement pendant 2 s). | Demandé |
| TML-05 | Les paramètres (ex. position X/Y) **évoluent dans le temps**. | Demandé |
| TML-06 | Chaque modifieur a une **courbe d'intensité** dessinable (pas seulement 0/1), comme les transitions des logiciels de montage : lent au début puis rapide, etc. | Demandé |
| TML-07 | **Tout** paramètre de modifieur est animable (ex. direction de la translation de couleur). | Demandé |
| TML-08 | Plusieurs clips en même temps (plusieurs pistes). | Déduit |

### 12.2 Navigation et lecture

| ID | Exigence | Statut |
|---|---|---|
| TMN-01 | **Zoom / dézoom**. | Demandé |
| TMN-02 | **Tête de lecture** déplaçable. | Demandé |
| TMN-03 | **Play / Pause**, raccourci **Espace**. | Demandé |
| TMN-04 | **Lecture en boucle** (zone de boucle). | Demandé |
| TMN-05 | Pendant la lecture, le rendu est affiché dans la mire et **envoyé au laser** si l'envoi live est actif. | Déduit |

### 12.3 Grille musicale et magnétisme

| ID | Exigence | Statut |
|---|---|---|
| TMG-01 | La grille est en **BPM / mesures / temps**, pas en secondes. | Demandé |
| TMG-02 | **BPM réglable à la main**. | Demandé |
| TMG-03 | **Point de départ de la mesure 1** réglable (morceau qui ne commence pas sur une mesure). | Demandé |
| TMG-04 | **Nombre de temps par mesure** réglable (4, 3…). | Demandé |
| TMG-05 | Barres **plus claires pour les mesures**, sous-barres pour les **temps**. | Demandé |
| TMG-06 | Subdivisions : **demi-temps, quarts, triolets**… grille réglable. | Demandé |
| TMG-07 | **Mode magnétique (snap) ON/OFF** : les débuts/fins de clips et points de courbe s'accrochent à la grille. | Demandé |
| TMG-08 | Détection automatique du BPM. | Futur (pas maintenant) |
| TMG-09 | Tap tempo. | Proposé |

### 12.4 Musique

| ID | Exigence | Statut |
|---|---|---|
| AUD-01 | **Importer une musique**. | Demandé |
| AUD-02 | Afficher la **forme d'onde (waveform)** dans la timeline. | Demandé |
| AUD-03 | **Jouer la musique** synchronisée avec la tête de lecture. | Demandé |

---

## 13. Sauvegarde, export, réseau (technique)

| ID | Exigence | Statut |
|---|---|---|
| SAV-01 | Deux formats : **projet** (état complet du logiciel) et **fichier ILDA** exporté. | Demandé |
| SAV-02 | Sauvegarde auto / récupération après plantage. | Proposé (existe déjà dans l'outil actuel) |
| SAV-03 | **Annuler / Rétablir** (Ctrl + Z / Ctrl + Y) sur toutes les actions. | Proposé (indispensable) |
| SAV-04 | Conversion forme → points laser : interpolation, points de coin, points éteints (blanking) pour les sauts. | Déduit |
| SAV-05 | Protocole d'envoi au DAC (IDN UDP ou autre selon le DAC). | Déduit |

---

## 14. Points à clarifier

Voir la réponse associée dans la conversation ; les réponses seront reportées ici.

---

## 15. Hors périmètre pour l'instant

- Modifieurs dynamiques en dehors de la timeline.
- Détection automatique du BPM.
- Contenu du menu Paramètres (structure seulement).
