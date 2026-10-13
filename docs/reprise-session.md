# Reprise de session — à lire en premier

Fichier de passation pour reprendre le travail dans une nouvelle discussion Claude (par exemple sur le PC de
l'utilisateur, avec sa vraie carte graphique). Dis simplement à Claude : « lis docs/reprise-session.md et continue ».

## Façon de travailler

- On parle **français**, on se tutoie. Réponses claires, sans jargon inutile.
- Design de l'interface : sombre, pro, épuré, cohérent avec les panneaux existants.
- Code découpé en **petits fichiers** (< ~400 lignes), commentaires en français, même style que le code autour.
- Branche de travail : **`dev-ambiant`** (ne jamais pousser ailleurs sans demander). `git push -u origin dev-ambiant`.
- **Faire une sauvegarde avant les gros changements** (copie dans `backups/`).
- Ne **pas** toucher aux réglages par défaut du laser du jeu (Taille X/Y 60 %, ±30°).
- Pas de froxels (trop lourd). Pas de bruit de fumée dans les faisceaux.

## Chantier en cours : nouveau rendu des lyres (« Lyres v2 »)

Tout est décrit dans **`docs/rendu-lyres-v2.md`** (décisions R1–R7, bilans des phases). Code de référence :
`docs/lightbench-reference-main.cpp` (mode 5 « SS Depth »). Sauvegarde d'avant : `backups/avant-rendu-lyres-v2/`.

**Cible** : GTX 1080 en 4K, **120 images/s constantes avec 50 lyres** (≈ 8,3 ms par image).

| Phase | Contenu | État |
|---|---|---|
| A | Faisceaux SS Depth (tri par tuile, basse résolution, quadrature de Gauss), halo, choix du rendu par lyre, mesures GPU | ✅ poussée |
| B | Ombres statiques (cubemaps cuites par lyre), taches de lumière de toutes les lyres (Cook-Torrance), suppression des 8 SpotLights | ✅ poussée |
| C | GI en grille 3D (rebond sur le décor + brume éclairée), reflets des faisceaux sur le plateau brillant | ✅ poussée |

Fichiers principaux : `src/spot/ssdepth/`, `src/spot/lighting/`, `src/laser/FinalCompositePass.js`,
`src/spot/gi/`, `src/spot/reflect/`, `src/spot/SpotLightingFX.js`, `src/render/GpuPassTimer.js`, `src/spot/config/spotParams.js`, `src/ui/ClientOptions.js`.

## Premiers essais sur la GTX 1080 (2026-10-13)

- **Bug corrigé** (`305a4ec`) : les `EffectComposer` reprenaient le pixelRatio du renderer alors que les tailles
  leur sont déjà données en pixels réels. Écran zoomé à 150 % (4K Windows) : post-traitement en 5760 × 3240,
  faisceaux SS limités à un rectangle des ⅔ de l'écran, pointillés, gros lag. Désormais `setPixelRatio(1)`.
- **Halo atmosphérique des lyres supprimé** (code et réglages) à la demande de l'utilisateur.
- Gobos dans les faisceaux SS : 4 à 12 échantillons réguliers décalés par pixel (`81d2d89`).
- Faisceaux SS : nœuds de Gauss à 3 points corrigés (le faisceau était 20 à 40 % trop lumineux) et retouche
  des bords en pleine résolution (« Bords des faisceaux SS »), seulement dans les tuiles de ≤ 24 cônes.
- Tuiles : jusqu'à 1024 cônes par tuile (128 débordait avec 126 lyres à prisme : gros carrés à l'écran).
- Grille de GI = boîte du brouillard de salle (`GIGridPass.setBounds`) ; boîte par défaut 60 × 25 × 80 m
  (x −30…30, y 0…25, z −15…65) ; l'ancienne boîte par défaut (100 × 90 × 200) est remplacée à la lecture.
- GI : la lumière des faisceaux dans la fumée va jusqu'à la portée (raccourcir le faisceau ne change plus le sol).
- Shader GI : sorties de `hitDecor` initialisées (Direct3D le recompilait sans optimisation : chargement long).
- 4K (3840 × 2160), scène par défaut, 13 à 20 lyres : ≈ 10 à 12 ms. Postes principaux : Scène 4 à 5 ms
  (MSAA, déjà là avant les lyres v2), Brouillard ≈ 1,7 ms (constant, déjà là avant), Composition finale ≈ 1,4 ms.
- Les ombres statiques sont limitées à 64 lyres (la salle SPECTACLE du serveur en a 138).

## Prochaine étape : mesurer sur la vraie carte graphique

Les mesures faites jusqu'ici l'ont été en rendu logiciel (pas de GPU dans le cloud) : elles ne sont que relatives.

1. Lancer le jeu, mettre 50 lyres allumées, écran en 4K.
2. ⚙️ Options › Affichage › **« Mesures GPU par passe »** : tableau du coût de chaque étape en haut à droite.
3. Comparer à 8,3 ms. Si ça dépasse, ajuster à partir des vrais chiffres : résolution des faisceaux SS (½ ⅓ ¼),
   résolution des taches (Auto / Pleine / ½), ombres (128 / 256), qualité GI, résolution des reflets.
4. Vérifier à l'œil : ombres qui coupent les faisceaux, taches au sol, reflets sur le plateau, mélange
   Classique / SS Depth par lyre (« ✨ Rendu › Rendu du faisceau »).

## Points connus à revoir après les mesures

- GI : le rebond coloré sur le décor reste discret (gain ≈ 12× le physique sur le plateau noir) ; la brume éclairée
  et les reflets se voient bien. Grille sans direction : léger halo coloré autour des taches.
- Reflets des faisceaux : seulement sur le dessus du plateau (pas les marches, la table DJ, le sol) ; pas les lasers,
  barres LED ni faisceaux en mode Classique.
- `SpotManager.js` fait 453 lignes (à découper).
- Les personnages et objets mobiles ne projettent pas d'ombre (seul le décor fixe est cuit).

## Autre projet du dépôt : ilda-gen

Générateur ILDA en PySide6 (`tools/ilda-gen/`), refonte en trois espaces Forme / Show / Live **terminée**
(`docs/ilda-gen-refonte.md`). Tests : `cd tools/ilda-gen && python3 tests/test_core.py` et
`QT_QPA_PLATFORM=offscreen python3 tests/test_ui.py` (doivent finir par « TOUT EST OK »).
