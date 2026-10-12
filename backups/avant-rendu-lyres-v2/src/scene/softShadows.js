/**
 * softShadows.js
 * ─────────────────────────────────────────────────────────────
 * Ombres douces à rayon réglable, sans changer le type d'ombre du moteur.
 *
 * three.js r160 ignore `light.shadow.radius` en mode PCFSoftShadowMap (filtre fixe de ~2 texels) : les
 * bords d'ombre restent donc nets. Ce module remplace la branche PCF_SOFT du shader d'ombre :
 *   - radius <= 1.5 (défaut, soleil, lumières ajoutées) : filtre d'origine, rendu inchangé
 *   - radius  > 1.5 (stroboscopes) : disque de Vogel de 12 échantillons (précédé d'un test à 5 points : hors pénombre le coût est quasi nul), tourné pixel par pixel
 *     (bruit interleaved gradient), de rayon `radius` texels → pénombre douce sans bandes
 *
 * À importer AVANT le premier rendu (les shaders sont assemblés à la compilation).
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';

const MARKER = /#elif\s+defined\(\s*SHADOWMAP_TYPE_PCF_SOFT\s*\)/;
const END_OF_ORIGINAL = /\*\s*\(\s*1\.0\s*\/\s*9\.0\s*\)\s*;/;

const SOFT_BRANCH = /* glsl */`#elif defined( SHADOWMAP_TYPE_PCF_SOFT )

			if ( shadowRadius > 1.5 ) {

				vec2 softTexel = vec2( 1.0 ) / shadowMapSize;
				float softRot = 6.2831853 * fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
				// Test rapide (centre + 4 points sur le bord du disque) : loin d'un bord d'ombre tous les points
				// donnent le même résultat et on s'arrête là ; le filtre complet ne sert que dans la pénombre.
				vec2 softR0 = vec2( cos( softRot ), sin( softRot ) ) * shadowRadius * softTexel;
				vec2 softR1 = vec2( -softR0.y, softR0.x );
				float softProbe = texture2DCompare( shadowMap, shadowCoord.xy, shadowCoord.z )
					+ texture2DCompare( shadowMap, shadowCoord.xy + softR0, shadowCoord.z )
					+ texture2DCompare( shadowMap, shadowCoord.xy - softR0, shadowCoord.z )
					+ texture2DCompare( shadowMap, shadowCoord.xy + softR1, shadowCoord.z )
					+ texture2DCompare( shadowMap, shadowCoord.xy - softR1, shadowCoord.z );
				if ( softProbe < 0.001 ) {
					shadow = 0.0;
				} else if ( softProbe > 4.999 ) {
					shadow = 1.0;
				} else {
					float softAcc = 0.0;
					for ( int i = 0; i < 12; i ++ ) {
						float softR = sqrt( ( float( i ) + 0.5 ) / 12.0 );
						float softA = float( i ) * 2.39996323 + softRot;
						vec2 softOffset = vec2( cos( softA ), sin( softA ) ) * softR * shadowRadius * softTexel;
						softAcc += texture2DCompare( shadowMap, shadowCoord.xy + softOffset, shadowCoord.z );
					}
					shadow = softAcc / 12.0;
				}

			} else {
`;

const chunk = THREE.ShaderChunk.shadowmap_pars_fragment;
if (typeof chunk === 'string' && MARKER.test(chunk) && !chunk.includes('softTexel')) {
    const start = chunk.search(MARKER);
    const head = chunk.slice(0, start);
    let tail = chunk.slice(start).replace(MARKER, '');
    const end = tail.search(END_OF_ORIGINAL);
    if (end >= 0) {
        const endMatch = tail.match(END_OF_ORIGINAL)[0];
        tail = tail.slice(0, end + endMatch.length) + '\n\n\t\t\t}' + tail.slice(end + endMatch.length);
        THREE.ShaderChunk.shadowmap_pars_fragment = head + SOFT_BRANCH + tail;
    } else {
        console.warn('[softShadows] Fin du filtre PCF_SOFT introuvable : ombres douces désactivées.');
    }
} else if (!chunk || !chunk.includes('softTexel')) {
    console.warn('[softShadows] Shader d\'ombre inattendu : ombres douces désactivées.');
}
