/**
 * params.js
 * ─────────────────────────────────────────────────────────────
 * Source de vérité unique de TOUS les paramètres laser.
 *
 * PARAMS_SCHEMA : métadonnées complètes (min, max, step, label, group)
 *   → utilisé par GUI.js pour construire les contrôles dat.GUI
 *   → seul endroit à modifier pour changer une plage ou un défaut
 *
 * params : objet live dérivé du schéma (valeurs par défaut)
 *   → muté directement par la GUI et le code métier
 *   → importé par LaserShow, DazzleEffect, GlobalIllumination, etc.
 * ─────────────────────────────────────────────────────────────
 */

export const PARAMS_SCHEMA = {

    // ── Style laser (Toujours ouvert en haut) ─────────────────────────────────
    count:               { value: 8,        min: 1,    max: 64,   step: 1,     label: 'Nombre Trait',        group: 'laserStyle' },
    beamWidth:           { value: 1.0,      min: 0,    max: 3,    step: 0.05,  label: 'Taille Trait',        group: 'laserStyle' },
    spread:              { value: 50,       min: 0,    max: 110,  step: 0.1,   label: 'Écart laser',         group: 'laserStyle' },
    color:               { value: '#0055ff',                                     label: 'Couleur',             group: 'laserStyle', type: 'color' },
    laserPan:            { value: true,                                          label: 'Laser PAN',           group: 'laserStyle', type: 'bool' },
    masterPower:         { value: 0.8,      min: 0,    max: 1.5,  step: 0.05,  label: 'Puissance Générale',  group: 'laserStyle' },
    beamPower:           { value: 0.8,      min: 0,    max: 1.5,  step: 0.05,  label: 'Puissance Traits',    group: 'laserStyle' },
    panPower:            { value: 0.8,      min: 0,    max: 1.5,  step: 0.05,  label: 'Puissance PAN',       group: 'laserStyle' },

    patternShape:        { value: 'Horizontal', options: ['Horizontal', 'Sinusoïde', 'Parabolique', 'Zigzag', 'Vague Double'],
                                                                                label: 'Forme Tracé',         group: 'laserStyle', type: 'select' },
    curveAmplitude:      { value: 0.30,     min: 0,    max: 1.5,  step: 0.01,  label: 'Amplitude Courbe',    group: 'laserStyle' },
    curveFrequency:      { value: 1.0,      min: 0.25, max: 6,    step: 0.25,  label: 'Fréquence Courbe',    group: 'laserStyle' },

    strobe:              { value: false,                                         label: 'Clignotement',        group: 'laserStyle', type: 'bool' },
    strobeSpeed:         { value: 12.0,     min: 0.5,  max: 30,   step: 0.5,   label: 'Vitesse Cligno (Hz)', group: 'laserStyle' },

    // ── Rigging (Toujours ouvert en haut) ─────────────────────────────────────
    numPods:             { value: 2,        min: 1,    max: 12,   step: 1,     label: 'Nombres',             group: 'rigging' },
    angle:               { value: 0,        min: -180, max: 180,  step: 1,     label: 'Angle',               group: 'rigging' },
    podSpacing2:         { value: 6.0,      min: 1,    max: 30,   step: 0.5,   label: 'Écart (2 boîtiers)',  group: 'rigging' },
    podHeightAboveUser:  { value: 5.0,      min: 1,    max: 25,   step: 0.5,   label: 'Hauteur Boîtiers',    group: 'rigging' },
    sourceDistanceOffset:{ value: 0.6,      min: 0,    max: 5,    step: 0.05,  label: 'Avancer Boîtiers',    group: 'rigging' },

    // ── Tweeking visuel source (Fermé par défaut) ────────────────────────────
    sourceEmissionPower: { value: 1.5,      min: 0,    max: 4,    step: 0.05,  label: 'Puissance Buse',              group: 'sourceVisual' },
    sourceGlowRadius:    { value: 0.7,      min: 0.2,  max: 3,    step: 0.1,   label: 'Rayon Halo Buse',             group: 'sourceVisual' },
    giIntensity:         { value: 2.0,      min: 0,    max: 10,   step: 0.1,   label: 'Intensité Éclairage Source',  group: 'sourceVisual' },
    giDistance:          { value: 15.0,     min: 2,    max: 60,   step: 0.5,   label: 'Portée Éclairage Source',     group: 'sourceVisual' },
    giWallOffset:        { value: 5.8,      min: -5,   max: 10,   step: 0.1,   label: 'Recul Lumière Mur',           group: 'sourceVisual' },
    enableImpactLights:  { value: false,                                         label: 'Lumières Impacts (Mur/Sol)', group: 'sourceVisual', type: 'bool' },
    giImpactIntensity:   { value: 2.0,      min: 0,    max: 10,   step: 0.1,   label: 'Intensité Lumière Impacts',   group: 'sourceVisual' },
    giImpactDistance:    { value: 16.0,     min: 2,    max: 40,   step: 0.5,   label: 'Portée Lumière Impacts',      group: 'sourceVisual' },
    giBounceColor:       { value: true,                                          label: 'Rebond Couleur',              group: 'sourceVisual', type: 'bool' },

    // ── Post-Traitement & Ambiance (Fermé par défaut) ────────────────────────
    fogDensity:          { value: 0.015,    min: 0,    max: 0.05, step: 0.001, label: 'Densité Fumée',          group: 'post' },
    floorRoughness:      { value: 0.90,     min: 0.2,  max: 1.0,  step: 0.05,  label: 'Rugosité Sol (Mat)',     group: 'post' },
    bloomIntensity:      { value: 0.1,      min: 0,    max: 0.25, step: 0.01,  label: 'Éclat Lumineux (Bloom)', group: 'post' },
    bloomRadius:         { value: 0.5,      min: 0,    max: 2,    step: 0.05,  label: 'Rayon du Bloom',         group: 'post' },
    chroma:              { value: 0.25,     min: 0,    max: 0.5,  step: 0.01,  label: 'Aberration Chromatique', group: 'post' },
    antialiasing:        { value: 'Aucun',  options: ['Aucun', 'FXAA', 'SMAA'],label: 'Antialiasing',           group: 'post', type: 'select' },
    enableDazzle:        { value: true,                                          label: 'Éblouissement (Dazzle)',  group: 'post', type: 'bool' },

    // ── Contrôle du Glow & Fumée (Fermé par défaut) ──────────────────────────
    glowIntensity:       { value: 1.0,      min: 0,    max: 3,    step: 0.05,  label: 'Intensité du Glow',      group: 'glow' },
    glowScattering:      { value: 1.0,      min: 0,    max: 3,    step: 0.05,  label: 'Diffusion Faisceau',     group: 'glow' },
    glowFalloff:         { value: 2.0,      min: 0.5,  max: 5,    step: 0.1,   label: 'Atténuation Glow',       group: 'glow' },
    fogGlowCoupling:     { value: 1.0,      min: 0,    max: 3,    step: 0.05,  label: 'Couplage Fumée/Glow',    group: 'glow' },
    impactGlowIntensity: { value: 1.0,      min: 0,    max: 3,    step: 0.05,  label: 'Intensité Halo Impact',   group: 'glow' },
    impactGlowRadius:    { value: 1.0,      min: 0.2,  max: 3,    step: 0.1,   label: 'Rayon Halo Impact',      group: 'glow' },
};

/**
 * Objet `params` live — valeurs actives utilisées partout dans le code.
 * Dérivé automatiquement du schéma : si tu ajoutes un paramètre dans
 * PARAMS_SCHEMA, il apparaît automatiquement ici avec sa valeur par défaut.
 */
export const params = Object.fromEntries(
    Object.entries(PARAMS_SCHEMA).map(([key, def]) => [key, def.value])
);
