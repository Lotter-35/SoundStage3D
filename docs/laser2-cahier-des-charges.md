# Nouveau laser (laser2) — cahier des charges

Refonte complète du boîtier laser, écrite de zéro dans `src/laser2/`.
L'ancien laser (`src/laser/`) reste en place pendant la construction, puis sera supprimé.

Objectif : un laser qui se comporte comme un vrai (réalisme type Depence R4), piloté en **ILDA** et en **DMX**,
avec les contraintes physiques visibles (vitesse de dessin, inertie des galvos…), **50 boîtiers simultanés
projetant des formes complexes sans lag**, et tout synchronisé en multijoueur.

---

## 1. Principe : un seul faisceau qui dessine

Un vrai laser de spectacle a **un seul faisceau** (diodes rouge, verte, bleue combinées) renvoyé par
**deux miroirs galvanométriques** (X et Y) qui tracent une suite de points (ex. 30 000 points/s).
Éventails, nappes, tunnels, texte sur un mur : c'est ce point qui bouge très vite, intégré par l'œil.

Le nouveau laser est donc un **moteur de points**. Les effets réalistes en découlent :

| Ce qu'on voit en vrai | D'où ça vient dans la simulation |
|---|---|
| Coins et points d'arrêt très lumineux, nappes plus faibles | Luminosité = temps passé par le faisceau à chaque endroit |
| Un éventail de 90° est plus sombre qu'un de 20° | Même puissance étalée sur plus d'angle |
| Coins arrondis, dépassements, cercle qui rétrécit en accélérant | Inertie des galvos (modèle physique) |
| Une image trop complexe scintille | Trop de points pour la vitesse (< ~20 images/s) |
| Faisceau qui s'épaissit au loin | Divergence réelle (mrad) + diamètre de sortie |

## 2. Chaîne de calcul (par laser)

1. **Contenu** : points (x, y, couleur, masqué ou non) depuis un fichier ILDA, le générateur interne (DMX) ou l'ILDA live.
2. **Sortie** : points émis au rythme choisi (kpps). L'index du point courant découle de **l'horloge commune** :
   tous les joueurs voient le même point au même instant, aucun point n'est envoyé sur le réseau.
3. **Galvos** : chaque axe suit un modèle physique (second ordre, vitesse et accélération limitées, amortissement réglable).
   Étalonnage avec la **mire de test ILDA** : à la vitesse nominale du scanner (à 8°), le cercle touche le carré ;
   plus vite, il rétrécit et les coins s'arrondissent. Modulation des diodes : seuil, décalage couleur/position.
4. **Intégration (persistance)** : trajectoire réelle accumulée sur une fenêtre fixe, **indépendante des FPS**.
   - Mode **Œil** (par défaut) : ~33 ms, image stable.
   - Mode **Caméra** (option) : fenêtre courte, on voit le tracé et le scintillement comme sur une vidéo de téléphone.
   Les points sont regroupés en primitives : **faisceau** (point quasi immobile) ou **portion de nappe** (balayage, énergie répartie sur l'angle).
5. **Collisions** : impacts calculés aux sommets des primitives (obstacles de la scène + joueurs), nappe découpée quand la distance d'impact saute.
6. **Rendu GPU batché** : ~3 draw calls pour tous les lasers (faisceaux, nappes, tracés sur les surfaces), bloom laser.
7. **Éblouissement réaliste** : l'énergie reçue par la caméra (puissance × temps passé sur l'œil) pilote l'éblouissement.
   Faisceau qui balaie = flash bref ; faisceau fixe = éblouissement fort.

## 3. Visibilité et volutes (décisions)

- **Le laser est toujours visible**, même sans fumée dans la scène.
- **Aucun lien avec le brouillard `HazeVolume`** posé devant la scène.
- Visibilité = réglage propre aux lasers (global + par laser). Calcul analytique simple, moins coûteux que de lire le brouillard.
- Option peu coûteuse : faisceaux plus brillants quand on regarde vers le laser (diffusion vers l'avant).
- **Volutes dans les nappes** : nouveau code (l'ancienne fumée PAN n'est pas reprise), configurables
  (on/off, intensité, taille, vitesse, contraste), optimisées : calculées une seule fois par pixel même si plusieurs nappes se superposent,
  en résolution réduite, avec atténuation au loin.

## 4. Performance : 50 boîtiers à formes complexes

- Aucune lumière Three.js.
- **Web Worker** : le moteur de points, les galvos, le regroupement en primitives et les collisions tournent dans un
  second fil d'exécution du navigateur, en parallèle du rendu. Le jeu ne l'attend pas ; il récupère le résultat prêt.
- **Cache partagé** : plusieurs lasers qui jouent la même forme avec les mêmes réglages partagent un seul calcul.
  Une forme fixe qui boucle n'est calculée qu'une fois.
- **Budget global de primitives** avec tolérance adaptative (on simplifie un peu plus quand la charge monte).
- Nappes en résolution réduite, volutes calculées une fois par pixel, niveaux de qualité automatiques.
- Cibles : 50 lasers actifs, CPU du fil principal quasi nul pour les lasers, 3 draw calls.

## 5. Fiche technique du boîtier (inspecteur, hors DMX)

- Puissance par couleur (W) et longueurs d'onde réelles (638 / 520 / 450 nm) : à puissance égale le vert paraît bien plus lumineux que le bleu.
- Scanners : vitesse nominale (20k / 30k / 40k / 60k à 8°), angle max (±20° à ±30°), amortissement.
- Optique : diamètre de sortie (mm), divergence (mrad).
- Modulation : analogique ou tout-ou-rien, seuil des diodes, décalage couleur.
- Zones de masquage : disponibles mais **désactivées par défaut**.
- Préréglages : « RGB 1 W club », « RGB 5 W », « RGB 20 W festival »…
- **Couleurs** : RGB dans le code, **sélecteur de couleur classique** dans les options du laser.

## 6. ILDA

### Bibliothèque sur le serveur

```
server/storage/ilda/
├── Faisceaux/
│   ├── eventail_8.ild
│   └── tunnel.ild
├── Graphiques/
│   └── logo.ild
└── Animations/
    └── vague.ild
```

- Chaque **sous-dossier = une banque** (catégorie) ; chaque fichier `.ild` = une forme.
- Le serveur scanne le dossier au démarrage et **le surveille** : un fichier ajouté apparaît automatiquement
  dans la liste des formes de chaque laser (menu de config et canaux DMX Banque / Motif), chez tous les joueurs.
- Les clients téléchargent un fichier la première fois qu'il sert, puis le gardent en cache.
- Formats ILDA 0, 1, 2, 4, 5 (palette par défaut + palettes personnalisées, animations multi-images).
- Lecteur : vitesse de sortie (kpps), boucle / une fois / aller-retour, vitesse d'animation, image fixe.

### ILDA live

- Mode ILDA live voulu.
- Protocole : **IDN** (ILDA Digital Network, standard réseau officiel de l'ILDA) en priorité ;
  émulation d'une interface **Ether Dream** en complément si le logiciel choisi ne gère pas IDN (à vérifier au choix du logiciel).
- Reçu par le serveur Node (sur le PC), relayé aux joueurs. Pour les amis hors réseau local : on relaie des **images**
  (formes), dédupliquées (une image répétée n'est pas renvoyée) et compressées, pas le flux brut de points.

## 7. DMX (36 canaux, 16 bits là où la précision compte)

Entrée : **Art-Net** reçu par le serveur Node, relayé aux joueurs (même patch DMX que les lyres et barres LED).
Le générateur interne produit des points qui passent par la même physique des galvos.

| # | Canal | Valeurs |
|---|---|---|
| 1 | Mode | Éteint · DMX (générateur interne) · ILDA fichier · ILDA live · Mire de test |
| 2–3 | Dimmer + fin | 0–100 % |
| 4 | Shutter / Strobe | fermé, ouvert, strobe lent → rapide, aléatoire, pulse |
| 5 | Banque | Faisceaux · Nappes & tunnels · Graphiques · Animations · banques ILDA du serveur |
| 6 | Motif | numéro dans la banque |
| 7 | Image / lecture | 0–127 image fixe, 128–255 lecture auto lente → rapide |
| 8 | Vitesse de dessin | kpps envoyés aux galvos (plus vite = plus fluide mais plus déformé) |
| 9–10 | Tracé début / fin | dessin progressif 0–100 % |
| 11 | Pointillés | trait continu → points de plus en plus espacés |
| 12–13 | Taille X / Taille Y | 0–100 % de l'angle max |
| 14 | Zoom auto | fixe, pulse, avant-arrière + vitesse |
| 15–16 | Position X + fin | pan des galvos |
| 17–18 | Position Y + fin | tilt des galvos |
| 19 | Rotation Z | 0–127 angle, 128–191 horaire, 192–255 anti-horaire |
| 20 | Rotation X (3D) | angle / rotation continue |
| 21 | Rotation Y (3D) | angle / rotation continue |
| 22–23 | Balayage X / Y | amplitude du mouvement automatique |
| 24 | Vitesse balayage | lent → rapide |
| 25 | Forme balayage | sinus, triangle, carré, cercle, 8, aléatoire |
| 26 | Vague | déformation ondulée (amplitude / vitesse) |
| 27 | Couleur | macros (blanc, R, V, B, jaune, cyan, magenta) + segments, arc-en-ciel défilant, chenillard, aléatoire par point |
| 28–30 | Rouge / Vert / Bleu | 0–100 % |
| 31 | Vitesse effet couleur | lent → rapide |
| 32 | Nombre de faisceaux | 1…64 (éventails) |
| 33 | Ouverture | angle de l'éventail |
| 34 | Faisceaux ↔ nappe | 0 = faisceaux séparés → 255 = nappe continue |
| 35 | Réseau de diffraction | ×1, ×3, ×5, ×9 |
| 36 | Fonctions | reset, zones on/off |

## 8. Multijoueur

- Tout est déterministe à partir de l'horloge commune : seuls les réglages, les trames DMX et les images ILDA live circulent.
- Fichiers ILDA : servis par le serveur, identiques pour tous.
- Messages dédiés (`laser2_add / update / remove / action`), état complet envoyé à la connexion.

## 9. Étapes (un commit par étape, ancien laser intact)

1. Moteur de points, galvos, intégration (modes Œil / Caméra), rendu faisceaux + nappes, mire ILDA, motifs de test,
   aperçu 2D du tracé dans le panneau (trajectoire demandée vs réelle).
2. Collisions, tracés sur les surfaces, éblouissement réaliste.
3. Bibliothèque ILDA sur le serveur (dossiers = banques, surveillance), lecteur, synchro.
4. Profil DMX, bibliothèque de motifs internes, panneau complet avec sélecteur de couleur.
5. Web Worker, cache partagé, budget global : validation à 50 lasers.
6. Passerelles réseau : Art-Net (DMX) et IDN / Ether Dream (ILDA live).
7. Volutes configurables.
8. Remplacement des 2 lasers de départ, puis suppression de l'ancien code.

Premier nouveau laser de test : à côté des 2 actuels (x = ±12 m, y = 14 m).

## 10. Réponses de l'utilisateur

| Question | Réponse |
|---|---|
| Logiciels | Laser : aucun pour l'instant. Lumière : régie maison, sans doute Art-Net. ILDA : le protocole réseau le plus répandu. |
| Serveur | Sur le PC, ports ouverts pour les amis hors réseau local. |
| ILDA live | Oui. |
| Persistance | Deux modes, Œil par défaut. |
| Fumée | Pas de lien avec le brouillard de la scène, laser toujours visible ; volutes nouvelles et configurables. |
| Couleurs | RGB dans le code, sélecteur de couleur dans les options. |
| Texte | Pas besoin (un fichier ILDA contenant du texte reste lisible). |
| Nombre de lasers | 50 boîtiers maximum, formes complexes. |
| Éblouissement | Réaliste. Zones de masquage : non activées par défaut. |
| Emplacement | À côté des 2 lasers actuels. |
