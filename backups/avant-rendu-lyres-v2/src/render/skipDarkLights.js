/**
 * skipDarkLights.js — Les lumières éteintes (intensité 0) ne coûtent plus rien au GPU.
 *
 * Les pools de lumières (lasers, strobes, lyres) restent TOUJOURS dans la scène avec une
 * intensité 0 quand ils ne servent pas : le nombre de lumières ne change jamais, donc aucun
 * shader n'est recompilé quand on pose un strobe / laser / lyre (pas de freeze).
 * Mais three.js calculait quand même chaque lumière éteinte pour chaque pixel
 * (BRDF + lecture de carte d'ombre + lecture de gobo).
 *
 * Ce module modifie UNE FOIS, au démarrage (avant toute compilation), le chunk d'éclairage :
 *  - chaque lumière ponctuelle / spot / directionnelle est entourée d'un test
 *    « couleur × intensité > 0 » : une lumière éteinte est sautée (test uniforme → le GPU
 *    branche réellement, aucun coût de divergence) ;
 *  - les lectures de carte d'ombre et de gobo utilisent un niveau de détail explicite (LOD 0)
 *    au lieu d'un LOD implicite : sous Windows (ANGLE → Direct3D), un branchement contenant des
 *    lectures à LOD implicite est « aplati » par le compilateur (tout est calculé quand même).
 *    Ces textures n'ont pas de mipmaps : LOD 0 = résultat strictement identique.
 *
 * Rendu identique (une lumière d'intensité 0 n'ajoutait déjà rien). Si la version de three.js
 * ne correspond pas aux motifs attendus, rien n'est modifié (avertissement en console).
 */
import * as THREE from 'three';

const LOD0_MACRO = `
#ifndef SS3D_TEX_LOD0
	#if __VERSION__ >= 300
		#define SS3D_TEX_LOD0( s, uv ) textureLod( s, uv, 0.0 )
	#else
		#define SS3D_TEX_LOD0( s, uv ) texture2D( s, uv )
	#endif
#endif
`;

/** Entoure le corps d'une boucle de lumières d'un test « lumière allumée ». */
function wrapLoop(src, loopHead, colorExpr) {
    const start = src.indexOf(loopHead);
    if (start < 0) return null;
    const bodyStart = start + loopHead.length;
    const endMarker = src.indexOf('#pragma unroll_loop_end', bodyStart);
    if (endMarker < 0) return null;
    const closeIdx = src.lastIndexOf('}', endMarker);
    if (closeIdx <= bodyStart) return null;
    return src.slice(0, bodyStart)
        + `\n\t\tif ( dot( ${colorExpr}, vec3( 1.0 ) ) > 0.0 ) {\n`
        + src.slice(bodyStart, closeIdx)
        + '\t\t}\n\t'
        + src.slice(closeIdx);
}

function patch() {
    const chunks = THREE.ShaderChunk;
    let lights = chunks.lights_fragment_begin;
    let shadows = chunks.shadowmap_pars_fragment;
    if (typeof lights !== 'string' || typeof shadows !== 'string') return false;
    if (lights.includes('SS3D_TEX_LOD0')) return true; // déjà appliqué

    // 1. Gobo des spots : lecture à LOD explicite
    const goboOld = 'texture2D( spotLightMap[ SPOT_LIGHT_MAP_INDEX ], spotLightCoord.xy )';
    if (!lights.includes(goboOld)) return false;
    lights = lights.replace(goboOld, 'SS3D_TEX_LOD0( spotLightMap[ SPOT_LIGHT_MAP_INDEX ], spotLightCoord.xy )');

    // 2. Sauter les lumières éteintes
    lights = wrapLoop(lights, 'for ( int i = 0; i < NUM_POINT_LIGHTS; i ++ ) {', 'pointLights[ i ].color');
    if (!lights) return false;
    lights = wrapLoop(lights, 'for ( int i = 0; i < NUM_SPOT_LIGHTS; i ++ ) {', 'spotLights[ i ].color');
    if (!lights) return false;
    lights = wrapLoop(lights, 'for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {', 'directionalLights[ i ].color');
    if (!lights) return false;

    // 3. Cartes d'ombre : lectures à LOD explicite
    const shadowReads = [
        ['texture2D( depths, uv )', 'SS3D_TEX_LOD0( depths, uv )'],
        ['texture2D( shadow, uv )', 'SS3D_TEX_LOD0( shadow, uv )'],
    ];
    for (const [a, b] of shadowReads) {
        if (!shadows.includes(a)) return false;
        shadows = shadows.split(a).join(b);
    }

    chunks.lights_fragment_begin = LOD0_MACRO + lights;
    chunks.shadowmap_pars_fragment = LOD0_MACRO + shadows;
    return true;
}

let ok = false;
try { ok = patch(); } catch (err) { ok = false; }
if (!ok) {
    console.warn('[skipDarkLights] Chunks three.js inattendus : optimisation des lumières éteintes non appliquée.');
}
export const SKIP_DARK_LIGHTS_ACTIVE = ok;
