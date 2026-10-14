# LyreViz : consignes pour Claude

Banc d'essai C++ de lyres (moving heads) dans une fumée volumétrique, séparé du projet web. Lire d'abord `README.md`, puis `PERFORMANCE.md`.

## Priorités de l'utilisateur

- **Objectif : 3840 × 2160 à 120 images/s sur une GTX 1080**, soit 8,3 ms par image.
- **Aucune dégradation visible de l'image** : un rendu plus rapide mais visiblement plus flou, taché ou moins fin n'est pas accepté. Les petites différences invisibles sont acceptées.
- Répondre en français.

## Règle : toute modification est mesurée

Avant de garder une nouvelle fonctionnalité ou une optimisation, suivre la procédure de `PERFORMANCE.md`.

1. Avant de modifier : `build.bat`, puis copier `LyreViz.exe` vers `bench\ref\avant.exe`.
2. Après : `tools\compile_shaders.bat` (si `shaders/lyreviz.glsl` a changé), puis `build.bat`.
3. Comparer en alternance, **en banc rapide (`-Fast`) par défaut** (l'utilisateur ne veut pas attendre) :
   ```bat
   powershell -ExecutionPolicy Bypass -File tools\perf_ab.ps1 -ExeA bench\ref\avant.exe -ExeB LyreViz.exe -Fast -Name essai
   ```
   - Sans `-Fast` seulement pour une décision serrée ou les valeurs de référence.
   - Un ancien exécutable qui ne connaît pas `--fast` l'ignore et fait le banc normal : comparer alors sans `-Fast`.
   - Pas de `-Behind` pour des mesures à garder : derrière les autres fenêtres, le GPU est 5 à 15 % plus lent.
4. Pour une fonctionnalité qui coûte du temps :
   - la rendre activable (case dans l'onglet Rendu et clé `--set`) ;
   - mesurer son coût seul ;
   - donner à l'utilisateur le temps ajouté et ce qui reste du budget.
5. Vérifier l'image : PSNR en scène immobile, puis agrandissements (brume, bords des faisceaux, gobos, lentilles).
6. Avant de conclure : banc complet en mouvement (`-Full -Moving`), et comparaison aux valeurs de référence de `PERFORMANCE.md`. Mettre ces valeurs à jour si elles changent.
7. Les mesures varient de 10 à 20 % d'un lancement à l'autre : ne jamais conclure sur un seul lancement.
8. **À chaque modification mesurée, ajouter les résultats à l'historique `historique_perf.xlsx`** (obligatoire, sans attendre qu'on le demande) :
   ```bat
   python tools\historique.py --modif "N. nom court de la modification" --reglages "adaptive=0, en mouvement" bench\essai_B0 bench\essai_B1
   ```
   - Un ajout par version mesurée (et par jeu de réglages : par exemple option à 0, puis à 1). Numéroter les modifications dans l'ordre.
   - Le banc complet en mouvement (`-Full -Moving`) de préférence, pour que les lignes se comparent.
   - Si Excel a le fichier ouvert, l'enregistrement échoue : demander à l'utilisateur de le fermer.

## Rappels techniques

- Les shaders sont dans `shaders/lyreviz.glsl`. Ils sont traduits par `sokol-shdc` (version figée b975d56) dans `src/shaders/lyreviz.glsl.h`, avec le bytecode HLSL précompilé.
- Dans les boucles, toujours `textureLod`, jamais `texture` (sinon échec du compilateur HLSL sous Direct3D 11).
- Mesures GPU par passe : Direct3D 11 seulement. Les appels `gpuprof::mark("nom")` dans `Renderer::render` découpent l'image en passes ; en ajouter un pour chaque nouvelle passe.
- Vérifier aussi que le code compile pour OpenGL : `cl /c /DSOKOL_GLCORE` sur les fichiers de `src`.
- Aucune autre instance de LyreViz pendant les mesures (elles faussent tout) : si une instance est ouverte, demander a l'utilisateur de la fermer, ne pas la fermer soi-meme.
- L'utilisateur travaille sur le PC pendant les mesures : c'est la principale source d'ecarts. Alterner A et B, ne pas conclure sur un ecart sous le bruit, et preferer la scene immobile (sans `-Moving`) pour juger d'une optimisation.
- Depuis l'outil, appeler `build.bat` par son chemin complet (`cmd //c "C:\...\lyre-viz\build.bat"`) : `cmd /c build.bat` ne le trouve pas.
