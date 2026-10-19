# Spectacles (lyres + lasers) : images des scènes

Générateur de scènes de l'onglet Ambiances (catégorie « Spectacles ») : voir « Spectacles » dans le `README.md` du dossier `lyre-viz`. Code : `src/spectacles.cpp`.

## Les 30 scènes (19/10/2026)

Écrites comme un spectacle, du calme au final. Chaque scène a une idée, ses couleurs (1 à 4, dans l'ordre : dominante, puis accents) et beaucoup de noir ; les gobos 14 à 33 de la roue y servent presque tous.

| Scène | Couleurs | Lasers | Lyres |
|---|---|---|---|
| 1. Aube | ambre, lavande | ligne d'horizon du nez de scène | soleil levant (gobo soleil) du sol de scène, ciel lavande |
| 2. Fenêtres | blanc chaud | quelques rayons de poussière | rais de lumière par de hautes fenêtres (gobo fenêtre) |
| 3. Océan | bleu roi, cyan | ciel liquide au-dessus des têtes | reflets d'eau au sol (gobo eau) |
| 4. Aurore boréale | émeraude, turquoise, violet | grandes vagues dont les couleurs défilent | nuages au sol |
| 5. Constellations | bleu lunaire, blanc froid | ciel d'étoiles (grilles en diffraction × 9) | lune et étoiles au sol, galaxie dans la fumée |
| 6. Glacier | blanc froid, bleu glace, azur | stalactites de traits qui scintillent | flocons au sol, colonnes blanches |
| 7. Cathédrale de verre | bleu roi, carmin, or | arches dorées du pont et du sol | vitraux dans la fumée |
| 8. Désert | ambre, bleu nuit | horizon brûlant qui tremble | dunes (gobo vagues), rayons rasants du couchant |
| 9. Jungle | vert, citron vert, jaune | canopée de vagues, rayons de soleil | feuillages au sol |
| 10. Bulles | cyan, rose, lilas | cercles qui flottent, respirent, éclatent | bulles au sol |
| 11. Cœurs | rose néon, rouge | cœurs qui battent sur le temps | cœurs rouges au sol, lavage rose |
| 12. Pluie d'or | or, blanc chaud | averse de faisceaux dorés | soleils d'aiguilles dans la fumée |
| 13. Ruche dorée | ambre, jaune | abeilles (petits éventails) qui butinent | alvéoles au sol (gobo nid d'abeille) |
| 14. Feu sacré | rouge, orange, or | flammes qui montent du nez de scène | flammes au sol et dans la fumée |
| 15. Monolithe | rouge | une lame horizontale qui balaie la salle | forêt de colonnes immobiles |
| 16. Vert laser | vert | éventails qui balaient, tunnels qui tournent | contre-jour vert en éventail |
| 17. Tubes | magenta, blanc froid | tunnels blancs | faisceaux en tube (gobo anneau) en cercle |
| 18. Hélices | cyan, violet | doubles éventails en hélice | hélices dans les faisceaux (gobo hélice) |
| 19. Géométrie sacrée | or, magenta, cyan | triangles, carrés, étoiles, cercles en orbite | tubes triangulaires (gobo triangle) |
| 20. Mandala | fuchsia, mandarine, violet | 4 étoiles concentriques en sens contraires | rosaces et prismes 6 dans la fumée |
| 21. Kaléidoscope | rouge, jaune, cyan, violet | étoile de plans par un même point | spirales au sol (et prisme) |
| 22. Néon | rose néon, cyan | grille synthwave | faisceaux en huit |
| 23. Op art | blanc, rouge | rideaux de traits en ciseaux | damiers qui tournent au sol |
| 24. Toile d'araignée | vert acide, violet | filets de traits qui se croisent | toiles d'araignée au sol |
| 25. Matrice | vert matrice, blanc froid | faisceaux de traits en grille 4 × 4 | faisceaux blancs en ciseaux |
| 26. Vortex | indigo, cyan | tunnels doubles en sens contraires | spirales qui tournoient dans la fumée |
| 27. Éclats | blanc froid, cyan | éclats projetés dans tous les sens | verre brisé au sol |
| 28. Tempête | violet, blanc | plafond de nuages, éclairs des trusses | nuages au sol, éclairs du pont (stroboscope) |
| 29. Pulsar | blanc | lames qui s'ouvrent sur le temps | éventail de faisceaux qui flashe (stroboscope) |
| 30. Apothéose | or, blanc, magenta, cyan | tout en même temps | soleils d'aiguilles et prismes, cercles, ciseaux |

## Images

- `planche.jpg` : les 30 scènes à l'énergie 0,5, couleurs de la scène, lyres et lasers, après 200 images à 1/60 s, vues du public (`--cam 5,2.5,0,180,12`).
- `energie.jpg` : 30 Apothéose à l'énergie 0, 0,35, 0,65 et 1.

Refaire une image :

```bat
LyreViz.exe --windowed --noui --play --frames 200 --cam 5,2.5,0,180,12 --set spectacle=14 --set spenergie=0.5 --shot feu.bmp
```

## Coût des scènes

Pas encore mesuré pour ces scènes (celles d'avant allaient de 5,2 à 20 ms, voir l'historique git de ce fichier). Mesure, une ligne par lancement ajoutée au fichier :

```bat
LyreViz.exe --fullscreen --novsync --noui --play --frames 460 --cam 5,2.5,0,180,12 --set adaptive=0 --set spectacle=15 --set spenergie=0.65 --set spjournal=couts.tsv
```
