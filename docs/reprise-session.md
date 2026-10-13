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
| C | GI en grille 3D (rebond sur le décor + brume éclairée), reflets des faisceaux sur le plateau brillant | en cours (branche `lyres-v2-c`, pas encore sur `dev-ambiant`) |

Fichiers principaux : `src/spot/ssdepth/`, `src/spot/lighting/`, `src/laser/FinalCompositePass.js`,
`src/render/GpuPassTimer.js`, `src/spot/config/spotParams.js`, `src/ui/ClientOptions.js`.

## Prochaine étape : mesurer sur la vraie carte graphique

Les mesures faites jusqu'ici l'ont été en rendu logiciel (pas de GPU dans le cloud) : elles ne sont que relatives.

1. Lancer le jeu, mettre 50 lyres allumées, écran en 4K.
2. ⚙️ Options › Affichage › **« Mesures GPU par passe »** : tableau du coût de chaque étape en haut à droite.
3. Comparer à 8,3 ms. Si ça dépasse, ajuster à partir des vrais chiffres : résolution des faisceaux SS (½ ⅓ ¼),
   résolution des taches (Auto / Pleine / ½), ombres (128 / 256), qualité GI, résolution des reflets.
4. Vérifier à l'œil : ombres qui coupent les faisceaux, taches au sol, reflets sur le plateau, mélange
   Classique / SS Depth par lyre (« ✨ Rendu › Rendu du faisceau »).

## Autre projet du dépôt : ilda-gen

Générateur ILDA en PySide6 (`tools/ilda-gen/`), refonte en trois espaces Forme / Show / Live **terminée**
(`docs/ilda-gen-refonte.md`). Tests : `cd tools/ilda-gen && python3 tests/test_core.py` et
`QT_QPA_PLATFORM=offscreen python3 tests/test_ui.py` (doivent finir par « TOUT EST OK »).
