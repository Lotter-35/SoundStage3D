/**
 * V3.js — vecteur 3D minimal (le cœur de calcul des lasers tourne sans Three.js, dans un Web Worker).
 */
export class V3 {
    constructor(x = 0, y = 0, z = 0) {
        this.x = x; this.y = y; this.z = z;
    }

    set(x, y, z) {
        this.x = x; this.y = y; this.z = z;
        return this;
    }

    copy(v) {
        this.x = v.x; this.y = v.y; this.z = v.z;
        return this;
    }

    addScaledVector(v, s) {
        this.x += v.x * s; this.y += v.y * s; this.z += v.z * s;
        return this;
    }

    lerpVectors(a, b, t) {
        this.x = a.x + (b.x - a.x) * t;
        this.y = a.y + (b.y - a.y) * t;
        this.z = a.z + (b.z - a.z) * t;
        return this;
    }

    normalize() {
        const l = Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z) || 1;
        this.x /= l; this.y /= l; this.z /= l;
        return this;
    }
}
