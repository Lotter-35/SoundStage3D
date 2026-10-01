# Optimisations futures du rendu

Pistes discutées le 2026-10-02. Aucune n'est commencée.

Contexte : à terme, la scène sera **figée** (décor et positions des lumières). Seules les lumières seront pilotées en DMX / ILDA.

État actuel : uniquement WebGL (`THREE.WebGLRenderer` dans `src/main.js`, three.js 0.160, shaders GLSL dans des `ShaderMaterial`).

## Plan recommandé (par ordre)

### Tier 1 — gros gain, peu d'effort

1. **Mesurer d'abord** : afficher le temps GPU de chaque passe (faisceaux, lasers, ombres, bloom, décor) et le nombre d'appels de dessin, sur la scène SPECTACLE.
2. **Ombres du soleil à la demande** : `shadowMap.autoUpdate = false`, et ne recalculer la carte d'ombre que si un objet ou un joueur bouge. Autre option : séparer décor fixe et objets mobiles. Gain attendu : 1 à 3 ms.
3. **Décor figé** : `matrixAutoUpdate = false` sur ce qui ne bouge pas, et fusion des objets fixes qui partagent un matériau.
4. **Instancier les corps des appareils** (lyres, barres LED, lasers) avec `InstancedMesh`. À vérifier d'abord : nombre d'appels de dessin par appareil.
5. **Pré-compiler les shaders au chargement** (`renderer.compileAsync`, `KHR_parallel_shader_compile`). Probable cause du blocage sur « préparation du rendu » et des à-coups quand un effet apparaît.

### Tier 2 — gros gain, effort moyen

6. **Taches des lyres au sol calculées à l'écran (deferred decal)**.
   - Aujourd'hui : 8 vraies `SpotLight` (`src/spot/SpotLightPool.js`), présentes dans TOUS les matériaux éclairés, donc un coût sur chaque pixel du décor.
   - Proposé : un petit volume par tache, qui lit la profondeur, plus de limite de 8. Le code existe déjà pour les lyres hors pool (`splashW` dans `SpotShaders.js`).
   - À ajouter : la couleur de la surface (approximée depuis l'image rendue ou écrite dans une cible à part) et son orientation (retrouvée depuis la profondeur).
   - Alternative plus simple : passer de 8 à 2-4 `SpotLight`.
7. **Fumée pré-calculée en texture 3D** (cases d'environ 30 cm, par exemple 128×64×128, 1 à 4 Mo).
   - Les faisceaux lisent la texture au lieu de calculer 2 à 4 octaves de bruit à chaque pas.
   - Animation : dérive lente de la texture et une octave de bruit fin en direct.
   - Permet une fumée non uniforme (plus dense près des machines et au plafond).
8. **Effets d'image à demi-résolution** (bloom, assemblage des faisceaux) : à vérifier selon l'existant.
9. **Distance d'affichage par type d'objet et modèles simplifiés de loin (LOD)** pour les petits objets et les appareils éloignés.

### Tier 3 — si besoin

10. **Assets compressés** : textures KTX2, modèles meshopt.
11. **Processeur** : DMX et réseau traités seulement quand une valeur change ; pas de création d'objets à chaque image dans les boucles de mise à jour.
12. **Lumière ambiante pré-calculée** (lightmaps en mode mixte), seulement si la scène a beaucoup de lumières fixes.

## Déconseillé pour l'instant

- **Migration WebGPU**.
  - Il faudrait tout réécrire en WGSL ou TSL, passer tout le rendu à un seul moteur, et garder une version WebGL de secours.
  - Le vrai intérêt : fumée en grille 3D (froxels) avec des compute shaders.
- **Pré-calcul complet par lyre**, à garder si les faisceaux restent la passe la plus lourde après les points 6 et 7.
  - Principe : séparer le fixe (position de la lyre, décor) du DMX (orientation, gobo, zoom, couleur).
  - Par lyre : une cubemap de distance au premier obstacle (ombres et coupure du faisceau pour tout pan/tilt) et la fumée cumulée par direction et par distance.
  - Pour la tache au sol : la direction vue depuis la lyre et le facteur fixe (distance, angle, ombre) de chaque point de surface. En direct, il ne reste qu'à lire le gobo tourné selon pan/tilt (zoom et frost = niveau de mipmap).
  - Mémoire : environ 1 à 2 Mo par lyre. Les objets mobiles ne sont pas pris en compte.
- **Lightmaps complètes**.
  - En mode mixte, l'ombre du joueur reste dynamique : la carte d'ombre du soleil ne contient plus que les objets mobiles, éclairés par des sondes de lumière.
  - Les lyres et les lasers ne sont jamais cuits.
  - Gros chantier de cuisson (Blender ou outil intégré).
