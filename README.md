# 🎶 SoundStage3D - Simulateur de Sonorisation de Festival

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**SoundStage3D est une expérience de simulation acoustique et audio 3D immersive en temps réel qui s'exécute entièrement dans votre navigateur. Chargez vos morceaux et déplacez-vous librement dans un environnement de festival pour ressentir comment un système de sonorisation professionnel interagit avec l'espace et le public.**

> ℹ️ *L'ancienne version 2025 reste archivée et accessible sur la branche [`backup-2025-main`](https://github.com/Lotter-35/SoundStage3D/tree/backup-2025-main).*

---

<h2 align="center">✨ <a href="https://Lotter-35.github.io/SoundStage3D/">🚀 ACCÉDER À LA DÉMONSTRATION LIVE 🚀</a> ✨</h2>

*(Note : L'expérience est optimisée pour les ordinateurs de bureau. Pour une immersion maximale, l'utilisation d'un casque audio de qualité avec une bonne restitution des basses est fortement recommandée.)*

---

![Aperçu de la scène 3D](./src/assets/screenshots/stage.PNG)

## 🌟 Nouveautés & Fonctionnalités (Édition 2026)

*   **Routage Stéréo Physique Réaliste :** Séparation stricte des canaux gauche (`Left`) et droit (`Right`) vers leurs enceintes physiques respectives (`arrayLeft`, `midLeft`, `fillLeft` à gauche ; `arrayRight`, `midRight`, `fillRight` à droite) et sommation mono `(L + R) * 0.5` pour la ligne de 7 caissons de basse centraux.
*   **Visualiseur de Spectre FFT (RTA Casque) :** Analyseur de spectre temps réel haute résolution (2048 bins, échelle logarithmique 20 Hz – 20 kHz, repères en dB, peak hold et détection du pic fréquentiel en direct) branché tout au bout de la chaîne audio pour visualiser précisément le son perçu à votre position d'écoute.
*   **Sonorisation 4-voies Pro :** Séparation du spectre en **SUB** (<90 Hz), **MID** (90 Hz – 2 kHz), **TOP** (>2 kHz) et **FILL** via filtres Linkwitz-Riley 24 dB/oct.
*   **Chaîne DSP par Bus :** Compresseurs dynamiques, saturation harmonique à sur-échantillonnage 2x, limiteurs acoustiques dédiés et volume indépendant par bus.
*   **Acoustique & Proximité Sub :** Atténuation physique inverse de distance, absorption atmosphérique de l'air en fonction de la météo/distance (24 dB/oct), saturation non-linéaire de proximité au pied des subs, et réflexions au sol.
*   **Spatialisation 3D & HRTF :** Panning spatial 3D ultra-précis avec lissage sans craquement lors des rotations rapides de tête.
*   **Générateur de Fréquences Intégré :** Générateur de sinus pur (20 Hz à 20 kHz) accessible directement depuis la barre d'outils HUD pour calibrer et tester les fréquences de coupure et la réponse impulsionnelle.
*   **Navigation FPS & Mode Personnage :** Déplacement fluide à la première personne ou au sol (`Z/Q/S/D`, saut avec Espace, touche `F` pour basculer en mode personnage).
*   **Protection du Volume Local :** Sortie casque calibrée avec marge dynamique saine pour éliminer toute saturation numérique intempestive.

![Panneaux de contrôle DSP](./src/assets/screenshots/DSP.PNG)

## 🚀 Comment Lancer le Projet Localement

Aucune compilation ou dépendance n'est nécessaire ! Le projet utilise des modules ES6 natifs.

1.  **Clonez le dépôt :**
    ```sh
    git clone https://github.com/Lotter-35/SoundStage3D.git
    cd SoundStage3D
    ```
2.  **Lancez un serveur web local :**
    La méthode la plus simple est d'utiliser Python :
    ```sh
    # Python 3
    python -m http.server 8080
    ```
3.  **Ouvrez votre navigateur :**
    Rendez-vous sur [http://localhost:8080](http://localhost:8080).

## ⌨️ Contrôles

| Action                  | Touche / Commande               |
| ----------------------- | ------------------------------- |
| **Se déplacer**         | `ZQSD`, `WASD`, ou touches fléchées |
| **Regarder**            | `Souris`                        |
| **Monter / Sauter**     | `Barre d'espace`                |
| **Descendre**           | `Shift` (en mode vol)           |
| **Changer de mode**     | `F` (Vol libre ↔ Personnage)    |
| **Libérer la souris**   | `Échap` ou `Tab`                |
| **Spectre FFT**         | Bouton `📊 Spectre` dans le HUD |
| **Générateur Sinus**    | Bouton `🔊 Sinus ▾` dans le HUD |

## 🛠️ Technologies Utilisées

*   [**Three.js**](https://threejs.org/) - Pour le moteur de rendu 3D.
*   **Web Audio API** - Pour tout le traitement audio avancé.
*   **JavaScript (ES6+ Modules)** - Code source moderne, sans bundler.
*   **HTML5 / CSS3**

## 🤝 Contribution

Les contributions, les corrections de bugs et les suggestions de fonctionnalités sont les bienvenues ! N'hésitez pas à ouvrir une *issue* ou une *pull request*.

1.  Forkez le projet.
2.  Créez votre branche de fonctionnalité (`git checkout -b feature/AmazingFeature`).
3.  Commitez vos changements (`git commit -m 'Add some AmazingFeature'`).
4.  Poussez vers la branche (`git push origin feature/AmazingFeature`).
5.  Ouvrez une Pull Request.

## 📄 Licence

Ce projet est distribué sous la licence MIT. Voir le fichier `LICENSE` pour plus d'informations.
