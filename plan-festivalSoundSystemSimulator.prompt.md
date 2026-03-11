## Plan : Festival Sound System Simulator

Simulateur 3D d'un système son de festival en navigateur web. L'utilisateur charge un fichier audio, se déplace librement autour d'une scène virtuelle (Three.js), et entend le son en rendu binaural HRTF (Web Audio API) avec effets psychoacoustiques réalistes. **Approche** : CDN + importmap (pas de bundler), ES6 modules natifs, 4 phases séquentielles.

---

### Phase 1 — Squelette projet & fichiers de base

1. Créer l'arborescence complète (10 fichiers).
2. `index.html` : page HTML5, canvas Three.js plein écran, overlay UI (input fichier, boutons, position), importmap pour Three.js via CDN, import ES6 de `src/main.js`.
3. `style.css` : layout plein écran, overlay en position absolue.

---

### Phase 2 — Moteur Audio (Web Audio API)

4. **`audioEngine.js`** — `AudioContext` + chargement fichier avec `decodeAudioData` → `AudioBufferSourceNode`, loop activé. Méthodes `start()`, `stop()`, `pause()`, `resume()`.
5. **`crossover.js`** — Crossover Linkwitz-Riley 24dB @ 90 Hz : deux `BiquadFilterNode` lowpass en cascade (SUB BUS) + deux highpass en cascade (TOP BUS). Expose `subBusOutput` et `topBusOutput`.
6. **`speakers.js`** — 3 émetteurs virtuels, chacun avec sa chaîne DSP :
   - `GainNode` (atténuation distance) → `DelayNode` (propagation, `distance/343` s) → `BiquadFilterNode` (air absorption, cutoff dynamique) → `PannerNode` (HRTF)
   - Positions : subCenter (0,1,0), arrayLeft (-12,12,0), arrayRight (12,12,0)
   - Directivité : arrays cone 60°/120°/0.3 ; sub omnidirectionnel
   - Routing : SUB BUS → subCenter ; TOP BUS → arrayLeft + arrayRight
7. **`effects.js`** — Trois effets :
   - **Ground reflection** : branche parallèle par speaker → `DelayNode` (~5-15ms) → lowpass (~1500 Hz) → `GainNode` (0.15-0.25) → `PannerNode` (position miroir Y)
   - **PA Saturation** : `WaveShaperNode` soft clip, courbe `(3/2)x - (1/2)x³`, placé après crossover
   - **PA Compression** : `DynamicsCompressorNode` (threshold -24, knee 30, ratio 4), après crossover

**Graph audio complet** :
```
AudioSource → Crossover LR4
  → SUB BUS → Compression → Saturation → [subCenter: Gain→Delay→AirAbsorb→PannerHRTF]
                                            + [ground reflection branch]
  → TOP BUS → Compression → Saturation → [arrayLeft: Gain→Delay→AirAbsorb→PannerHRTF]
                                            + [ground reflection branch]
                                          [arrayRight: Gain→Delay→AirAbsorb→PannerHRTF]
                                            + [ground reflection branch]
```

---

### Phase 3 — Scène 3D (Three.js)

8. **`stage.js`** — Géométrie : sol (grand plan vert/terre), plateau de scène (boîte 30×20×10m, sombre), marqueurs speakers (sphères lumineuses), éclairage basique (ambient + directionnel), skybox ou fond ciel.
9. **`listener.js`** — Contrôles FPS desktop :
   - `PointerLockControls` pour la souris
   - WASD/flèches pour le déplacement (~5 m/s), Space/Shift pour monter/descendre
   - Bornes : X [-100, 100], Z [-50, 200], Y [0, 40]
   - Sync `AudioContext.listener` (position + orientation) avec la caméra Three.js à chaque frame

---

### Phase 4 — Intégration & UI

10. **`controls.js`** — UI overlay : input fichier (`.mp3`, `.wav`), boutons Play/Pause/Stop, affichage position (X, Y, Z), distance FOH, instructions clavier.
11. **`main.js`** — Point d'entrée & boucle principale :
    - Init Three.js (scene, renderer, camera)
    - Init AudioEngine au premier geste utilisateur
    - `requestAnimationFrame` loop :
      1. Update position listener
      2. Borner la position
      3. Sync AudioContext.listener ↔ caméra
      4. Pour chaque speaker, recalculer : gain (`1/(1+k*d)`), délai (`d/343`), filtre air (`max(2000, 18000 - d*40)`)
      5. Update réflexion sol
      6. Render Three.js

---

### Fichiers à créer

| Fichier | Rôle |
|---|---|
| `index.html` | Page HTML, canvas, overlay, importmap CDN |
| `style.css` | Styles plein écran + overlay |
| `src/main.js` | Orchestration, boucle render |
| `src/scene/stage.js` | Géométrie 3D scène |
| `src/scene/listener.js` | Mouvement FPS + sync audio |
| `src/audio/audioEngine.js` | AudioContext, chargement, play/pause |
| `src/audio/crossover.js` | Crossover LR4 @ 90Hz |
| `src/audio/speakers.js` | 3 émetteurs spatiaux + chaînes DSP |
| `src/audio/effects.js` | Reflection, saturation, compression |
| `src/ui/controls.js` | UI overlay |

---

### Vérification

1. Charger un MP3/WAV → le son joue correctement.
2. Position FOH (0, 1.7, 50) → son équilibré, centré.
3. Mouvement latéral → arrayLeft/Right balance perceptible.
4. Éloignement → volume baisse, aigus atténués, délai perceptible.
5. Derrière la scène (Z < 0) → son fortement filtré par les cônes directionnels.
6. Réflexion sol audible comme légère coloration.
7. Saturation/compression → son dense et puissant sans distorsion évidente.
8. 60 FPS sur desktop.
9. Listener ne sort pas des bornes.

---

### Décisions

- **AudioBufferSourceNode** pour V1 (contrôle précis, loop natif).
- **CDN + importmap** pour Three.js (pas de bundler).
- **PointerLockControls** depuis `three/addons/controls/PointerLockControls.js`.
- **Mobile** reporté en V2.
- **Boucle audio** activée par défaut ; futur : playlist multi-fichiers.
- **Scope exclu** : foule, météo, delay towers, diffraction, interférences, ray tracing.
