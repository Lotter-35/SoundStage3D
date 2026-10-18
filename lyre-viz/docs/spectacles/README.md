# Spectacles (lyres + lasers) : images et coût des scènes

Générateur de scènes de l'onglet Ambiances (catégorie « Spectacles ») : voir « Spectacles » dans le `README.md` du dossier `lyre-viz`. Code : `src/spectacles.cpp`.

## Images

- `planche.jpg` : les 30 scènes à l'énergie 0,65, couleurs tirées au hasard (graine = numéro de la scène), lyres et lasers, après 4 s (240 images à 1/60 s). Vue du public (`--cam 5,2.5,0,180,12`) ; scènes des trusses (4, 5, 6, 21) vues du fond (`--cam 40,3.5,6,185,16`), 25 Chenillard vue d'un coin (`--cam 48,14,-20,156,-5`).
- `energie.jpg` : 30 Grand final, palette Orange + bleu, énergie 0, 0,35, 0,65 et 1.
- `08-ciseaux.jpg` (vert, énergie 0,7), `09-rencontre.jpg`, `12-kaleidoscope.jpg`, `19-geometrie.jpg` (énergie 0,65).

Refaire une image :

```bat
LyreViz.exe --windowed --noui --play --frames 240 --cam 5,2.5,0,180,12 --set spectacle=9 --set spenergie=0.65 --set spcouleurs=0 --set sptirage=9 --shot rencontre.bmp
```

## Coût des scènes

GTX 1080, 3840 × 2160 plein écran, sans synchro verticale, fumée des lasers v2 par défaut, `adaptive=0`, vue du public (`--cam 5,2.5,0,180,12`), énergie 0,65, couleurs tirées au hasard (graine = numéro de la scène), **lyres et lasers** (18/10/2026). Temps GPU de chaque image (Direct3D 11), images 120 à 420 après le lancement, **un seul lancement par scène** (les mesures varient de 10 à 20 % ; le PC servait pendant la mesure). Le 90e centile compte les images où tout est allumé : dans les scènes qui clignotent, la moyenne mélange images allumées et éteintes. « Lasers allumés » et « Segments » : la dernière image mesurée.

| Scène | GPU moyen (ms) | 90e centile | Lasers allumés | Segments laser |
|---|---|---|---|---|
| 1. Horizon | 10,42 | 13,82 | 8 | 126 |
| 2. Plafond | 7,15 | 9,18 | 8 | 37 |
| 3. Cathedrale | 7,71 | 7,98 | 16 | 192 |
| 4. Rideaux | 6,78 | 9,52 | 20 | 26 |
| 5. Portiques | 6,27 | 10,25 | 14 | 18 |
| 6. Pluie | 7,03 | 10,74 | 24 | 24 |
| 7. Convergence | 8,06 | 8,97 | 12 | 12 |
| 8. Ciseaux | 7,98 | 8,05 | 12 | 59 |
| 9. Rencontre | 10,52 | 13,23 | 24 | 47 |
| 10. Balayage | 9,33 | 11,20 | 24 | 208 |
| 11. Radar | 10,45 | 14,79 | 8 | 126 |
| 12. Kaleidoscope | 11,14 | 13,03 | 8 | 56 |
| 13. Helice | 10,95 | 13,65 | 8 | 75 |
| 14. Tunnel | 16,00 | 18,96 | 5 | 80 |
| 15. Vortex | 14,83 | 17,99 | 4 | 112 |
| 16. Rosace | 16,27 | 19,69 | 8 | 124 |
| 17. Spirale | 11,38 | 13,53 | 16 | 197 |
| 18. Etoiles | 13,91 | 17,61 | 8 | 160 |
| 19. Geometrie | 14,43 | 18,15 | 8 | 74 |
| 20. Constellation | 13,89 | 17,99 | 3 | 432 |
| 21. Diamants | 7,81 | 8,99 | 13 | 117 |
| 22. Vague | 19,86 | 24,58 | 8 | 366 |
| 23. Ressac | 7,24 | 7,94 | 8 | 136 |
| 24. Aurore | 10,88 | 13,79 | 8 | 208 |
| 25. Chenillard | 5,21 | 7,01 | 24 | 72 |
| 26. Pulsation | 10,99 | 16,95 | 8 | 32 |
| 27. Etincelles | 5,68 | 7,52 | 7 | 15 |
| 28. Mur de lumiere | 6,99 | 10,60 | 8 | 104 |
| 29. Toile | 7,34 | 10,96 | 24 | 192 |
| 30. Grand final | 12,79 | 14,80 | 29 | 138 |

- Budget : 8,3 ms par image ; la salle seule (tout éteint) en prend 3,3. 13 scènes tiennent le budget en moyenne (5,2 à 8,1 ms) ; les autres vont de 9 à 20 ms : nappes coniques (cônes, tunnels, cercles, vagues découpées en arcs : environ 2 fois le coût d'une nappe plane), diffraction, et gobos ou prismes de lyres. Les plus chères : Vague 19,9, Rosace 16,3, Tunnel 16,0, Vortex 14,8.
- Les lyres ajoutent environ 0,5 à 4 ms selon la scène (mesure du 16/10, lasers seuls : 4,9 à 17,9 ms).
- Scènes à cônes, étoiles, vagues et diffraction déjà allégées (moins de boîtiers, diffraction seulement au maximum).
- Refaire une mesure (une ligne par lancement, ajoutée au fichier) :

```bat
LyreViz.exe --fullscreen --novsync --noui --play --frames 460 --cam 5,2.5,0,180,12 --set adaptive=0 --set spectacle=15 --set spenergie=0.65 --set spjournal=couts.tsv
```
