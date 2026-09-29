/**
 * SkyMoon.js — Lune dans le ciel de nuit.
 *
 * Sphère texturée (texture lunaire des exemples three.js, licence MIT : moon_1024.jpg) + halo doux,
 * placée dans la direction de la lumière directionnelle (qui joue le rôle du clair de lune dans les
 * ambiances de nuit), à l'intérieur de la skybox (rayon 900) et devant les étoiles (860).
 * Visible uniquement dans les ambiances de nuit (ambiances avec étoiles).
 */
import * as THREE from 'three';

const MOON_DISTANCE = 780;  // m (skybox 900, étoiles 860)
const MOON_RADIUS = 34;     // m → ~5° apparents (la vraie lune fait 0,5° : agrandie pour la lisibilité)

function createHaloTexture() {
    const size = 256;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grd.addColorStop(0.0, 'rgba(210,225,255,0.55)');
    grd.addColorStop(0.25, 'rgba(180,200,255,0.22)');
    grd.addColorStop(0.6, 'rgba(150,175,255,0.06)');
    grd.addColorStop(1.0, 'rgba(150,175,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}

export class SkyMoon {
    constructor(scene) {
        this.group = new THREE.Group();
        this.group.name = 'sky-moon';
        this.group.visible = false;

        const tex = new THREE.TextureLoader().load('src/assets/textures/sky/moon_1024.jpg');
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        this.moon = new THREE.Mesh(
            new THREE.SphereGeometry(MOON_RADIUS, 48, 32),
            new THREE.MeshBasicMaterial({ map: tex, color: 0xe8eeff, fog: false })
        );
        this.moon.renderOrder = -1; // après la skybox (-2), avant le reste
        this.group.add(this.moon);

        this.halo = new THREE.Sprite(new THREE.SpriteMaterial({
            map: createHaloTexture(),
            color: 0xffffff,
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            fog: false,
        }));
        this.halo.scale.setScalar(MOON_RADIUS * 9);
        this.halo.renderOrder = -1;
        this.group.add(this.halo);

        scene.add(this.group);
        this._dir = new THREE.Vector3();
    }

    /**
     * @param {THREE.Camera} camera
     * @param {THREE.DirectionalLight} light lumière directionnelle (clair de lune la nuit)
     * @param {boolean} isNight
     */
    update(camera, light, isNight) {
        this.group.visible = Boolean(isNight && light);
        if (!this.group.visible) return;
        this._dir.copy(light.position).sub(light.target.position);
        if (this._dir.lengthSq() < 1e-6) this._dir.set(0.5, 0.6, 0.6);
        this._dir.normalize();
        // Jamais sous l'horizon
        if (this._dir.y < 0.15) { this._dir.y = 0.15; this._dir.normalize(); }
        this.group.position.copy(camera.position).addScaledVector(this._dir, MOON_DISTANCE);
        // Face visible de la lune tournée vers la caméra
        this.moon.lookAt(camera.position);
        this.moon.rotateY(-Math.PI / 2);
    }
}
