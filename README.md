# SoundStage3D

Simulateur 3D de système son de festival en plein air, dans le navigateur.

## Fonctionnalités

- **Scène 3D** — Scène de festival avec line-arrays, subs, médiums et front-fills
- **Crossover 3 bandes** — SUB (<90 Hz), MID (90 Hz–2 kHz), TOP (>2 kHz) en LR4 24 dB/oct
- **Spatialisation** — Positionnement réaliste des sources, atténuation par distance, absorption de l'air
- **Réflexions au sol** — Rebond simulé pour chaque enceinte
- **Mode personnage** — Gravité + saut (touche F) ou vol libre
- **Contrôles en temps réel** — Volume par bus, portée, clarté, Doppler, cônes de directivité
- **Level meters** — SUB / MID / TOP / FILL / Master

## Lancer

```bash
# Serveur local (Python 3)
python3 -m http.server 8080
```

Ouvrir [http://localhost:8080](http://localhost:8080) et charger un fichier audio.

## Contrôles

| Touche | Action |
|--------|--------|
| ZQSD / WASD / Flèches | Se déplacer |
| Souris | Regarder |
| Espace | Monter (vol libre) / Sauter (personnage) |
| Shift | Descendre (vol libre) |
| F | Basculer mode personnage ↔ vol libre |
| ESC | Libérer la souris |

## Tech

- Three.js v0.160.0
- Web Audio API
- ES6 modules — aucun bundler, aucune dépendance npm

## Licence

MIT
