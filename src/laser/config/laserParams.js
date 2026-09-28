/**
 * laserParams.js
 * Source de vérité unique pour TOUS les paramètres d'un laser individuel.
 * Chaque laser posé dans la scène a sa propre instance de params (createLaserParams()).
 */

export const LASER_PARAMS_SCHEMA = {
    // ── Style laser (exactement comme dans le repo GitHub LaserSimulation) ──
    count:               { value: 8,         min: 1,    max: 512,  step: 1,     label: 'Nombre Trait',           group: 'laserStyle' },
    beamWidth:           { value: 3.0,       min: 0,    max: 5,    step: 0.05,  label: 'Taille Trait',           group: 'laserStyle' },
    spread:              { value: 50,        min: 0,    max: 110,  step: 0.1,   label: 'Écart laser',            group: 'laserStyle' },
    color:               { value: '#1100ff',                                     label: 'Couleur',                group: 'laserStyle', type: 'color' },
    laserPan:            { value: true,                                          label: 'Laser PAN',              group: 'laserStyle', type: 'bool' },
    masterPower:         { value: 0.8,       min: 0,    max: 1.5,  step: 0.05,  label: 'Puissance Générale',     group: 'laserStyle' },
    beamPower:           { value: 0.8,       min: 0,    max: 1.5,  step: 0.05,  label: 'Puissance Traits',       group: 'laserStyle' },
    panPower:            { value: 0.5,       min: 0,    max: 1.5,  step: 0.05,  label: 'Puissance PAN',          group: 'laserStyle' },
    strobe:              { value: false,                                         label: 'Clignotement',           group: 'laserStyle', type: 'bool' },
    strobeSpeed:         { value: 12.0,      min: 0.5,  max: 30,   step: 0.5,   label: 'Vitesse Cligno (Hz)',    group: 'laserStyle' },
    patternShape:        { value: 'Horizontal', options: ['Horizontal', 'Sinusoïde', 'Parabolique', 'Zigzag', 'Vague Double'],
                                                                                 label: 'Forme Tracé',           group: 'laserStyle', type: 'select' },
    curveAmplitude:      { value: 0.30,      min: 0,    max: 1.5,  step: 0.01,  label: 'Amplitude Courbe',       group: 'laserStyle' },
    curveFrequency:      { value: 1.0,       min: 0.25, max: 6,    step: 0.25,  label: 'Fréquence Courbe',       group: 'laserStyle' },
    pauseMotion:         { value: false,                                         label: 'Pause Balayage',         group: 'sweep', type: 'bool' },

    // ── Balayage Automatisé sur les 3 axes (Oscillations buse fixe) ──
    // Axe 1 : Haut / Bas (Pitch / X)
    pitchSweepAmp:       { value: 0.0,       min: 0,    max: 60,   step: 0.5,   label: 'Amplitude Haut/Bas (°)', group: 'sweep' },
    pitchSweepSpeed:     { value: 0.0,       min: 0.0,  max: 30.0, step: 0.1,   label: 'Vitesse Haut/Bas',       group: 'sweep' },
    // Axe 2 : Gauche / Droite (Yaw / Y)
    yawSweepAmp:         { value: 0.0,       min: 0,    max: 60,   step: 0.5,   label: 'Amplitude G/D (°)',       group: 'sweep' },
    yawSweepSpeed:       { value: 0.0,       min: 0.0,  max: 30.0, step: 0.1,   label: 'Vitesse G/D',            group: 'sweep' },
    // Axe 3 : Rotation / Roulis (Roll / Z)
    rollContinuous:      { value: false,                                         label: 'Rotation Continue 360°', group: 'sweep', type: 'bool' },
    rollSweepAmp:        { value: 0.0,       min: 0,    max: 360,  step: 1,     label: 'Amplitude Rotation (°)', group: 'sweep' },
    rollSweepSpeed:      { value: 0.0,       min: 0.0,  max: 10.0, step: 0.1,   label: 'Vitesse Rotation',       group: 'sweep' },

    // ── Déviation Faisceau (Position statique de la buse — boîtier reste fixe) ──
    beamYawOffset:       { value: 0, min: -60, max: 60,  step: 1, label: 'Gauche / Droite (°)', group: 'beamAim' },
    beamPitchOffset:     { value: 0, min: -60, max: 60,  step: 1, label: 'Haut / Bas (°)',       group: 'beamAim' },
    beamRollOffset:      { value: 0, min: 0,   max: 360, step: 1, label: 'Rotation Faisceau (°)', group: 'beamAim' },

    // ── Fumée Laser PAN (SimonDev Noise & Turbulence) ────────────────────
    panSmokeEnabled:     { value: true,                                          label: 'Activer Fumée',          group: 'panSmoke', type: 'bool' },
    panSmokeIntensity:   { value: 1.0,       min: 0.0,  max: 2.0,  step: 0.05,  label: 'Intensité visuelle',     group: 'panSmoke' },
    panSmokeSpeed:       { value: 0.30,      min: 0.05, max: 3.0,  step: 0.05,  label: 'Vitesse Fumée',          group: 'panSmoke' },
    panSmokeScale:       { value: 0.35,      min: 0.10, max: 1.0,  step: 0.01,  label: 'Échelle Volutes',       group: 'panSmoke' },
    panSmokeContrast:    { value: 0.50,      min: 0.0,  max: 1.0,  step: 0.05,  label: 'Contraste Turbulence',   group: 'panSmoke' },
    panSmokeBrightness:     { value: 2.0,       min: 0.0,  max: 3.0,  step: 0.05,  label: 'Brillance Fumée',        group: 'panSmoke' },
    panSmokeWindChange:     { value: 1.0,       min: 0.0,  max: 3.0,  step: 0.05,  label: 'Variation Vent',         group: 'panSmoke' },
    panSmokeSpeedVariation: { value: 1.0,       min: 0.0,  max: 2.0,  step: 0.05,  label: 'Accélération Rafales',   group: 'panSmoke' },
    panSmokePerpSpeed:      { value: 0.15,      min: 0.01, max: 1.0,  step: 0.01,  label: 'Vitesse Balayage Perp.', group: 'panSmoke' },

    // ── Surcouche Poches / Amas Hétérogènes de Fumée ──
    panSmokePatchContrast:  { value: 0.40,      min: 0.0,  max: 1.5,  step: 0.05,  label: 'Contraste Poches',       group: 'panSmoke' },
    panSmokePatchScale:     { value: 0.04,      min: 0.01, max: 0.30, step: 0.01,  label: 'Taille Poches',          group: 'panSmoke' },
    panSmokePatchDensity:   { value: 0.50,      min: 0.0,  max: 1.0,  step: 0.05,  label: 'Densité Poches',         group: 'panSmoke' },
    panSmokePatchSpeed:     { value: 0.04,      min: 0.0,  max: 1.0,  step: 0.02,  label: 'Vitesse Dérive Poches',  group: 'panSmoke' },

    // ── Couches de fumée supplémentaires ──
    // Turbulence : les volutes se tordent et tourbillonnent davantage
    smkTurbEnabled:      { value: true,                                          label: 'Turbulence',             group: 'smokeLayers', type: 'bool' },
    smkTurbStrength:     { value: 0.5,       min: 0,    max: 2,    step: 0.05,  label: 'Force',                  group: 'smokeLayers' },
    smkTurbScale:        { value: 0.3,       min: 0.05, max: 2,    step: 0.05,  label: 'Échelle',                group: 'smokeLayers' },
    smkTurbSpeed:        { value: 0.2,       min: 0,    max: 2,    step: 0.05,  label: 'Vitesse',                group: 'smokeLayers' },
    // Poches & amas géants : même principe que les poches, à bien plus grande échelle
    smkGiantEnabled:     { value: true,                                          label: 'Poches géantes',         group: 'smokeLayers', type: 'bool' },
    smkGiantContrast:    { value: 0.7,       min: 0,    max: 1.5,  step: 0.05,  label: 'Contraste',              group: 'smokeLayers' },
    smkGiantScale:       { value: 0.009,     min: 0.001, max: 0.05, step: 0.001, label: 'Taille (petit = énorme)', group: 'smokeLayers' },
    smkGiantDensity:     { value: 0.5,       min: 0,    max: 1,    step: 0.05,  label: 'Densité',                group: 'smokeLayers' },
    smkGiantSpeed:       { value: 0.04,      min: 0,    max: 0.5,  step: 0.01,  label: 'Dérive',                 group: 'smokeLayers' },
    // Rayons radiaux : stries de lumière qui partent de la source (mis de côté pour le futur système ILDA)
    smkRayEnabled:       { value: false,                                         label: 'Rayons radiaux',         group: 'smokeLayers', type: 'bool' },
    smkRayIntensity:     { value: 2.0,       min: 0,    max: 2,    step: 0.05,  label: 'Intensité',              group: 'smokeLayers' },
    smkRayScale:         { value: 5,         min: 5,    max: 150,  step: 1,     label: 'Nombre de stries',       group: 'smokeLayers' },
    smkRaySpeed:         { value: 0.3,       min: 0,    max: 2,    step: 0.05,  label: 'Vitesse',                group: 'smokeLayers' },

    // ── Points scintillants dans les faisceaux (vus de près, 1 px, positions aléatoires) ──
    beamSpeckleEnabled:   { value: true,                                          label: 'Points scintillants',    group: 'laserStyle', type: 'bool' },
    beamSpeckleDensity:   { value: 0.5,      min: 0,    max: 1,    step: 0.05,  label: 'Densité des points',     group: 'laserStyle' },
    beamSpeckleDistance:  { value: 8,        min: 1,    max: 40,   step: 0.5,   label: 'Distance d’apparition (m)', group: 'laserStyle' },
    beamSpeckleIntensity: { value: 1.0,      min: 0,    max: 2,    step: 0.05,  label: 'Intensité des points',   group: 'laserStyle' },

    // ── Tweeking visuel source (exactement comme dans le repo GitHub LaserSimulation) ──
    sourceEmissionPower: { value: 4.0,       min: 0,    max: 4,    step: 0.05,  label: 'Puissance Buse',         group: 'sourceVisual' },
    sourceGlowRadius:    { value: 0.4,       min: 0.2,  max: 3,    step: 0.1,   label: 'Rayon Halo Buse',        group: 'sourceVisual' },
    giIntensity:         { value: 10.0,      min: 0,    max: 10,   step: 0.1,   label: 'Intensité Éclairage',    group: 'sourceVisual' },
    giDistance:          { value: 60.0,      min: 2,    max: 60,   step: 0.5,   label: 'Portée Éclairage',       group: 'sourceVisual' },
    giWallOffset:        { value: 5.6,       min: -5,   max: 10,   step: 0.1,   label: 'Recul Lumière Mur',      group: 'sourceVisual' },
    enableImpactLights:  { value: false,                                         label: 'Lumières Impacts',       group: 'sourceVisual', type: 'bool' },
    giImpactIntensity:   { value: 2.0,       min: 0,    max: 10,   step: 0.1,   label: 'Intensité Lumière',      group: 'sourceVisual' },
    giImpactDistance:    { value: 16.0,      min: 2,    max: 40,   step: 0.5,   label: 'Portée Lumière',         group: 'sourceVisual' },
    giBounceColor:       { value: true,                                          label: 'Rebond couleur',         group: 'sourceVisual', type: 'bool' },
    angle:               { value: 0,         min: -180, max: 180,  step: 1,     label: 'Angle horizontal',       group: 'sourceVisual' },
    tilt:                { value: 0,         min: -90,  max: 90,   step: 1,     label: 'Inclinaison verticale',  group: 'sourceVisual' },
    roll:                { value: 0,         min: -180, max: 180,  step: 1,     label: 'Rotation axiale (Roll)', group: 'sourceVisual' },

    // ── Glow & Fumée ─────────────────────────────────────────────────────
    glowIntensity:       { value: 1.0,       min: 0,    max: 3,    step: 0.05,  label: 'Intensité glow',         group: 'glow' },
    glowScattering:      { value: 0.5,       min: 0,    max: 3,    step: 0.05,  label: 'Diffusion faisceau',     group: 'laserStyle' },
    sourceWhitePower:    { value: 1.0,       min: 0,    max: 2.0,  step: 0.05,  label: 'Blanc Sortie Laser',     group: 'laserStyle' },
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
    const result = Object.assign(p, overrides);
    if (overrides.sweepSpeed !== undefined && overrides.pitchSweepSpeed === undefined) {
        result.pitchSweepSpeed = overrides.sweepSpeed;
    }
    if (overrides.horizontalSweepAmp !== undefined && overrides.yawSweepAmp === undefined) {
        result.yawSweepAmp = overrides.horizontalSweepAmp;
    }
    return result;
}
