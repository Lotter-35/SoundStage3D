# Maquettes ilda-gen v2 (Forme / Show / Live)

Maquettes de la refonte : trois espaces de travail séparés, choisis par les onglets en haut de la fenêtre.

| Image | Espace | Rôle |
|---|---|---|
| `1-forme.png` | **Forme** | Dessiner la forme (outils façon Photoshop) et la régler par sliders, sans notion de temps. Les effets cycliques (clignotement, rotation continue, oscillateurs) tournent en boucle. |
| `2-show.png` | **Show** | Le temps : timeline calée sur la musique, effets d'animation posés sur les clips (valeur fixe, courbe ou oscillateur), aperçu non modifiable, maîtres. |
| `3-live.png` | **Live** | Grille de cues pour jouer en direct, départ calé sur le tempo, maîtres et effets rapides. |

Les bulles jaunes numérotées sont des annotations, pas des éléments de l'interface.

Sources HTML dans `source/` ; pour régénérer les images : `node source/shot.js forme show live`
(Playwright + Chromium).
