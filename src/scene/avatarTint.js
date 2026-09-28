/**
 * Teinte d'avatar partagée (joueur local + avatars distants).
 * Remplace la teinte du matériau du corps par celle choisie en conservant sa luminosité
 * relative ; les articulations ne sont pas modifiées. Idempotent : peut être
 * rappelée avec une autre couleur sans que la luminosité dérive.
 */
import * as THREE from 'three';

const _hsl = { h: 0, s: 0, l: 0 };
const _tint = new THREE.Color();

export function tintAvatarMaterial(mat, hex) {
    const m = mat.clone();
    m.roughness = 0.8;
    // Les articulations (Alpha_Joints_MAT) gardent leur couleur d'origine : seul le corps est teinté
    if (/joint/i.test(m.name)) return m;
    if (m.userData.baseLightness === undefined) {
        m.color.getHSL(_hsl);
        m.userData.baseLightness = _hsl.l;
    }
    _tint.set(hex).getHSL(_hsl);
    const l = Math.min(0.6, Math.max(0.3, m.userData.baseLightness * 2.6));
    m.color.setHSL(_hsl.h, Math.max(_hsl.s, 0.7), l);
    return m;
}
