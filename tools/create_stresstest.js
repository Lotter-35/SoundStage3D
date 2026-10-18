const fs = require('fs');
const path = require('path');

const baseWorld = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../server/storage/worlds/SPECTACLE.json'), 'utf8'));

const world = {
    name: 'STRESSTEST',
    savedAt: Date.now(),
    lightingVersion: 1,
    lightingState: {
        env: {
            presetKey: 'night_deep',
            stageBoost: 0.1,
            stars: true,
            starSize: 0.5,
            starCount: 12000,
            starBrightness: 3
        },
        gi: baseWorld.lightingState.gi || { enabled: false },
        laserPost: baseWorld.lightingState.laserPost || { enabled: true },
        lights: {},
        lasers: {},
        strobes: {},
        spots: {},
        spotGlobals: {
            hazeDensity: 0.6,
            hazeContrast: 0.65,
            hazeScale: 1.0,
            scattering: 0.72,
            beamRender: 'Rapide'
        },
        spotFx: {},
        ledBars: {},
        laser2s: {},
        haze: {
            strobeGain: 2,
            laserGain: 1,
            spotGain: 1,
            sceneGain: 1,
            density: 0.008,
            tint: '#020308',
            intensity: 1,
            beamLink: 'Indépendante'
        }
    },
    dspState: baseWorld.dspState,
    queue: baseWorld.queue
};

// ── Coordonnées 50m de haut ──
// Y: 5 rangées pour les grilles 5x5 (45.0, 47.5, 50.0, 52.5, 55.0)
const Y_ROWS_5 = [45.0, 47.5, 50.0, 52.5, 55.0];

// X:
// Lasers gauche (5 colonnes) : -52.6, -49.8, -47.0, -44.2, -41.4
const X_LASER_LEFT = [-52.6, -49.8, -47.0, -44.2, -41.4];
// Lyres gauche (5 colonnes) : -30.6, -27.8, -25.0, -22.2, -19.4
const X_SPOT_LEFT = [-30.6, -27.8, -25.0, -22.2, -19.4];
// Centre (8 colonnes) : -11.2, -8.0, -4.8, -1.6, 1.6, 4.8, 8.0, 11.2
const X_CENTER = [-11.2, -8.0, -4.8, -1.6, 1.6, 4.8, 8.0, 11.2];
// Lyres droite (5 colonnes) : 19.4, 22.2, 25.0, 27.8, 30.6
const X_SPOT_RIGHT = [19.4, 22.2, 25.0, 27.8, 30.6];
// Lasers droite (5 colonnes) : 41.4, 44.2, 47.0, 49.8, 52.6
const X_LASER_RIGHT = [41.4, 44.2, 47.0, 49.8, 52.6];

// 1. ── Lasers ILDA (25 gauche + 25 droite = 50 lasers) ──
let laserIdx = 0;
function createLaser2(id, x, y, z) {
    const dmxAddr = ((laserIdx * 36) % 500) + 1;
    const dmxUniv = 10 + Math.floor((laserIdx * 36) / 500);
    laserIdx++;
    return {
        id,
        params: {
            posX: Math.round(x * 100) / 100,
            posY: Math.round(y * 100) / 100,
            posZ: z,
            yaw: 0,
            pitch: 0,
            roll: 0,
            dmxUniverse: dmxUniv,
            dmxAddress: dmxAddr,
            dmxMode: 'Standard (36 canaux)',
            dmxControl: false,
            source: 'Motif interne',
            pattern: 'Nappe + faisceaux',
            ildaFile: '',
            liveChannel: 1,
            playMode: 'Boucle',
            ildaFps: 30,
            ildaFrame: 0,
            ildaColor: 'Couleurs du fichier',
            scanRate: 40,
            beamCount: 24,
            beamDwell: 14,
            fanSpread: 100,
            fanBlend: 50,
            density: 60,
            cornerPoints: 4,
            blankPoints: 6,
            sizeX: 60,
            sizeY: 60,
            offsetX: 0,
            offsetY: 0,
            rotation: 0,
            rotSpeed: 0,
            rotX: 0,
            rotXSpeed: 0,
            rotY: 0,
            rotYSpeed: 0,
            drawStart: 0,
            drawEnd: 100,
            dots: 0,
            zoomFx: 'Aucun',
            zoomFxSpeed: 30,
            sweepX: 0,
            sweepY: 0,
            sweepSpeed: 30,
            sweepShape: 'Sinus',
            waveAmp: 0,
            waveSpeed: 40,
            grating: 'Aucun',
            color: '#00ff66',
            colorMode: 'Arc-en-ciel défilant',
            colorSpeed: 35,
            dimmer: 100,
            shutter: 'Ouvert',
            strobeRate: 8,
            preset: 'RGB 30 W (festival)',
            powerR: 8,
            powerG: 7,
            powerB: 15,
            scanner: '60k',
            maxAngle: 30,
            damping: 0.8,
            aperture: 7,
            divergence: 0.6,
            modulation: 'Analogique',
            colorShift: 6,
            galvoFx: true,
            smokeOn: true,
            smokeAmount: 60,
            smokeScale: 2.5,
            smokeSpeed: 25,
            smokeContrast: 50,
            smokeBeams: true,
            persistence: 'Œil',
            visibility: 1,
            forwardScatter: 35,
            audienceMask: false,
            sourceGlow: 1,
            sourceGlowRadius: 0.4
        }
    };
}

// Lasers gauche (carré 5x5 noir)
for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
        const id = `laser2-left-r${r}-c${c}`;
        world.lightingState.laser2s[id] = createLaser2(id, X_LASER_LEFT[c], Y_ROWS_5[r], 0);
    }
}
// Lasers droite (carré 5x5 noir)
for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
        const id = `laser2-right-r${r}-c${c}`;
        world.lightingState.laser2s[id] = createLaser2(id, X_LASER_RIGHT[c], Y_ROWS_5[r], 0);
    }
}

// 2. ── Lyres Spot rouges (25 gauche + 25 droite = 50 lyres) ──
let spotIdx = 0;
const GOBO_TYPES = [
    { goboFixed: 'Ouvert', prism: 'Aucun', prismSpeed: 0, zoom: 14 },
    { goboFixed: 'Points', prism: 'Aucun', prismSpeed: 0, zoom: 16 },
    { goboFixed: 'Points', prism: '3 facettes', prismSpeed: 22, zoom: 18 },
    { goboFixed: 'Ouvert', prism: '8 facettes', prismSpeed: 15, zoom: 20 },
    { goboFixed: 'Ouvert', goboRot: 'Rayons', goboRotMode: 'Rotation', goboSpeed: 20, prism: '3 facettes', prismSpeed: -18, zoom: 16 }
];

function createSpot(id, x, y, z, variantIdx) {
    const v = GOBO_TYPES[variantIdx % GOBO_TYPES.length];
    const dmxAddr = ((spotIdx * 34) % 480) + 1;
    const dmxUniv = 1 + Math.floor((spotIdx * 34) / 480);
    spotIdx++;
    return {
        id,
        params: {
            posX: Math.round(x * 100) / 100,
            posY: Math.round(y * 100) / 100,
            posZ: z,
            yaw: 0,
            pitch: 0,
            roll: 0,
            mount: 'Suspendu',
            invertPan: false,
            invertTilt: false,
            dmxUniverse: dmxUniv,
            dmxAddress: dmxAddr,
            dmxMode: 'Étendu (34 canaux)',
            dmxControl: false,
            dimmer: 100,
            shutter: 'Ouvert',
            shutterSpeed: 40,
            pan: 0,
            tilt: 0,
            ptSpeed: 100,
            color: '#ff002b',
            colorWheel: 'Ouvert (blanc)',
            colorHalf: false,
            rainbow: 0,
            goboFixed: v.goboFixed || 'Ouvert',
            goboShake: 0,
            goboRot: v.goboRot || 'Ouvert',
            goboRotMode: v.goboRotMode || 'Rotation',
            goboIndex: 0,
            goboSpeed: v.goboSpeed || 25,
            animWheel: 'Aucune',
            animSpeed: 30,
            prism: v.prism || 'Aucun',
            prismSpeed: v.prismSpeed || 20,
            prismIndex: 0,
            frost: 0,
            iris: 100,
            zoom: v.zoom || 14,
            focus: 50,
            blade1: 0, blade1Angle: 0,
            blade2: 0, blade2Angle: 0,
            blade3: 0, blade3Angle: 0,
            blade4: 0, blade4Angle: 0,
            bladeRot: 0,
            beamIntensity: 1.25,
            lightOutput: 1,
            lensGlare: 1,
            beamLength: 140
        }
    };
}

// Lyres gauche
for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
        const k = r * 5 + c;
        const id = `spot-left-r${r}-c${c}`;
        world.lightingState.spots[id] = createSpot(id, X_SPOT_LEFT[c], Y_ROWS_5[r], 0, k);
    }
}
// Lyres droite
for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
        const k = r * 5 + c;
        const id = `spot-right-r${r}-c${c}`;
        world.lightingState.spots[id] = createSpot(id, X_SPOT_RIGHT[c], Y_ROWS_5[r], 0, k + 1);
    }
}

// 3. ── Strobes orange (2 rangées de 8 au centre haut = 16 strobes) ──
const Y_STROBE = [51.5, 54.0];
let strobeCount = 0;
for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 8; c++) {
        const id = 7000 + strobeCount;
        world.lightingState.strobes[id] = {
            id,
            params: {
                posX: Math.round(X_CENTER[c] * 100) / 100,
                posY: Y_STROBE[r],
                posZ: 0,
                angle: 0,
                tilt: -15,
                roll: 0,
                power: 55,
                color: '#ff7700',
                emissivePower: 4.0,
                castShadow: true,
                shadowIntensity: 1,
                shadowSoftness: 0.5,
                distanceFactor: 10,
                showHousing: true,
                width: 1.2,
                height: 0.38,
                depth: 0.24,
                strobeEnabled: true,
                strobeSpeed: 12,
                pulseWidth: 50,
                strobeRandom: false,
                dimmer: 100,
                dmxUniverse: 5,
                dmxAddress: 1 + strobeCount * 8,
                dmxMode: 'Standard (8 canaux)',
                dmxControl: false
            }
        };
        strobeCount++;
    }
}

// 4. ── Barres LED bleues (2 rangées de 8 au centre bas = 16 barres) ──
const Y_LEDBAR = [46.0, 48.5];
let barCount = 0;
for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 8; c++) {
        const id = `ledbar-stresstest-r${r}-c${c}`;
        world.lightingState.ledBars[id] = {
            id,
            params: {
                posX: Math.round(X_CENTER[c] * 100) / 100,
                posY: Y_LEDBAR[r],
                posZ: 0,
                yaw: 0,
                pitch: 0,
                roll: 0,
                pixelCount: '16',
                invertTilt: false,
                dmxUniverse: 6 + Math.floor((barCount * 26) / 500),
                dmxAddress: ((barCount * 26) % 500) + 1,
                dmxMode: 'Standard (26 canaux)',
                dmxControl: false,
                dimmer: 100,
                shutter: 'Ouvert',
                strobeRate: 8,
                tilt: -15,
                rotation: 0,
                moveSpeed: 100,
                moveFx: 'Vague entre barres',
                moveFxAmp: 25,
                moveFxSpeed: 30,
                zoom: 7,
                zoomSplit: false,
                zoomRight: 30,
                color: '#0055ff',
                white: 0,
                halfMode: 'Aucune',
                halfColor: '#0020ff',
                halfPos: 0,
                pixelMode: false,
                pixels: new Array(32).fill('#0055ff'),
                fxPattern: 'Aucun',
                beamIntensity: 1.2,
                splash: true,
                lensGlare: 1
            }
        };
        barCount++;
    }
}

const outPath = path.resolve(__dirname, '../server/storage/worlds/STRESSTEST.json');
fs.writeFileSync(outPath, JSON.stringify(world, null, 2), 'utf8');

console.log('STRESSTEST.json créé avec succès à :', outPath);
console.log('Lasers 2 count:', Object.keys(world.lightingState.laser2s).length);
console.log('Spots count:', Object.keys(world.lightingState.spots).length);
console.log('Strobes count:', Object.keys(world.lightingState.strobes).length);
console.log('LedBars count:', Object.keys(world.lightingState.ledBars).length);
console.log('Total fixtures:', Object.keys(world.lightingState.laser2s).length + Object.keys(world.lightingState.spots).length + Object.keys(world.lightingState.strobes).length + Object.keys(world.lightingState.ledBars).length);
