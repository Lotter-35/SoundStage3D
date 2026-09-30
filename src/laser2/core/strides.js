/**
 * strides.js — format des instances GPU des nouveaux lasers (partagé par le cœur de calcul, qui peut
 * tourner dans un Web Worker sans Three.js, et par le rendu batché).
 */
export const BEAM_STRIDE = 13;   // aO(4) aE(4) aC(4) aG(1)
export const SHEET_STRIDE = 17;  // aO(4) aA(4) aB(4) aC(4) aG(1)
export const IMPACT_STRIDE = 14; // aP0(4) aP1(4) aN(3) aC(3)
