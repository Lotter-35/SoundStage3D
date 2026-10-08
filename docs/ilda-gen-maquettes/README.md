# Maquettes ilda-gen v2 (Forme / Show / Live)

Maquettes de la refonte : trois espaces de travail séparés, choisis par les onglets en haut de la fenêtre.

| Image | Espace | Rôle |
|---|---|---|
| `1-forme.png` | **Forme** | Dessiner la forme (outils façon Photoshop) et la régler par sliders, sans notion de temps. Les effets cycliques (clignotement, rotation continue, oscillateurs) tournent en boucle. |
| `2-show.png` | **Show** | Le temps : timeline calée sur la musique, effets d'animation posés sur les clips (valeur fixe, courbe ou oscillateur), aperçu non modifiable, maîtres. |
| `3-live.png` | **Live** | Grille de cues pour jouer en direct, départ calé sur le tempo, effets rapides. |
| `4-themes.png` | Thèmes | Le même écran dans quatre des dix thèmes proposés (Paramètres → Apparence). |

DA neutre (voir `docs/ilda-gen-direction-artistique.md`) : gris purs, un seul accent franc (orange par défaut),
menus en haut à gauche, maîtres cachés derrière le bouton « Maîtres » en haut à droite (ouvert sur `2-show.png`).

Sources HTML dans `source/` ; pour régénérer les images : `node source/shot.js forme show live "forme?theme=jaune"`
(Playwright + Chromium).
