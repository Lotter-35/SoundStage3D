/**
 * laserParams.js
 * Source de vérité unique pour TOUS les paramètres d'un laser individuel.
 * Chaque laser posé dans la scène a sa propre instance de params (createLaserParams()).
 */

export const LASER_PARAMS_SCHEMA = {
    // ── Style laser (exactement comme dans le repo GitHub LaserSimulation) ──
    count:               { value: 8,         min: 1,    max: 32,   step: 1,     label: 'Nombre Trait',           group: 'laserStyle' },
    beamWidth:           { value: 1.0,       min: 0,    max: 3,    step: 0.05,  label: 'Taille Trait',           group: 'laserStyle' },
    spread:              { value: 50,        min: 0,    max: 110,  step: 0.1,   label: 'Écart laser',            group: 'laserStyle' },
    color:               { value: '#0055ff',                                     label: 'Couleur',                group: 'laserStyle', type: 'color' },
    laserPan:            { value: true,                                          label: 'Laser PAN',              group: 'laserStyle', type: 'bool' },
    masterPower:         { value: 0.8,       min: 0,    max: 1.5,  step: 0.05,  label: 'Puissance Générale',     group: 'laserStyle' },
    beamPower:           { value: 0.8,       min: 0,    max: 1.5,  step: 0.05,  label: 'Puissance Traits',       group: 'laserStyle' },
    panPower:            { value: 0.8,       min: 0,    max: 1.5,  step: 0.05,  label: 'Puissance PAN',          group: 'laserStyle' },
    strobe:              { value: false,                                         label: 'Clignotement',           group: 'laserStyle', type: 'bool' },
    strobeSpeed:         { value: 12.0,      min: 0.5,  max: 30,   step: 0.5,   label: 'Vitesse Cligno (Hz)',    group: 'laserStyle' },
    patternShape:        { value: 'Horizontal', options: ['Horizontal', 'Sinusoïde', 'Parabolique', 'Zigzag', 'Vague Double'],
                                                                                 label: 'Forme Tracé',           group: 'laserStyle', type: 'select' },
    curveAmplitude:      { value: 0.30,      min: 0,    max: 1.5,  step: 0.01,  label: 'Amplitude Courbe',       group: 'laserStyle' },
    curveFrequency:      { value: 1.0,       min: 0.25, max: 6,    step: 0.25,  label: 'Fréquence Courbe',       group: 'laserStyle' },
    pauseMotion:         { value: false,                                         label: 'Pause Balayage',         group: 'laserStyle', type: 'bool' },

    // ── Tweeking visuel source (exactement comme dans le repo GitHub LaserSimulation) ──
    sourceEmissionPower: { value: 1.5,       min: 0,    max: 4,    step: 0.05,  label: 'Puissance Buse',         group: 'sourceVisual' },
    sourceGlowRadius:    { value: 0.7,       min: 0.2,  max: 3,    step: 0.1,   label: 'Rayon Halo Buse',        group: 'sourceVisual' },
    giIntensity:         { value: 2.0,       min: 0,    max: 10,   step: 0.1,   label: 'Intensité Éclairage',    group: 'sourceVisual' },
    giDistance:          { value: 15.0,      min: 2,    max: 60,   step: 0.5,   label: 'Portée Éclairage',       group: 'sourceVisual' },
    giWallOffset:        { value: 5.8,       min: -5,   max: 10,   step: 0.1,   label: 'Recul Lumière Mur',      group: 'sourceVisual' },
    enableImpactLights:  { value: false,                                         label: 'Lumières Impacts',       group: 'sourceVisual', type: 'bool' },
    giImpactIntensity:   { value: 2.0,       min: 0,    max: 10,   step: 0.1,   label: 'Intensité Lumière',      group: 'sourceVisual' },
    giImpactDistance:    { value: 16.0,      min: 2,    max: 40,   step: 0.5,   label: 'Portée Lumière',         group: 'sourceVisual' },
    giBounceColor:       { value: true,                                          label: 'Rebond couleur',         group: 'sourceVisual', type: 'bool' },
    angle:               { value: 0,         min: -180, max: 180,  step: 1,     label: 'Angle horizontal',       group: 'sourceVisual' },

    // ── Glow & Fumée ─────────────────────────────────────────────────────
    glowIntensity:       { value: 1.0,       min: 0,    max: 3,    step: 0.05,  label: 'Intensité glow',         group: 'glow' },
    glowScattering:      { value: 1.0,       min: 0,    max: 3,    step: 0.05,  label: 'Diffusion faisceau',     group: 'glow' },
    glowFalloff:         { value: 2.0,       min: 0.5,  max: 5,    step: 0.1,   label: 'Atténuation glow',       group: 'glow' },
    fogDensity:          { value: 0.015,     min: 0,    max: 0.05, step: 0.001, label: 'Densité fumée',          group: 'glow' },
    fogGlowCoupling:     { value: 1.0,       min: 0,    max: 3,    step: 0.05,  label: 'Couplage fumée/glow',    group: 'glow' },
    impactGlowIntensity: { value: 1.0,       min: 0,    max: 3,    step: 0.05,  label: 'Intensité halo impact',  group: 'glow' },
    impactGlowRadius:    { value: 1.0,       min: 0.2,  max: 3,    step: 0.1,   label: 'Rayon halo impact',      group: 'glow' },
};

/**
 * Crée une instance de params indépendante pour un laser.
 * Chaque laser posé obtient son propre objet de params.
 */
export function createLaserParams(overrides = {}) {
    const p = Object.fromEntries(
        Object.entries(LASER_PARAMS_SCHEMA).map(([key, def]) => [key, def.value])
    );
    return Object.assign(p, overrides);
}
