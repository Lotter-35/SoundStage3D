/**
 * DmxUniverse.js
 * ─────────────────────────────────────────────────────────────
 * Un univers DMX512 : 512 canaux de 8 bits (adresses 1 à 512).
 * - Lecture 8 bits (get) et 16 bits coarse/fine (get16)
 * - Compteur de version incrémenté à chaque modification (les projecteurs
 *   patchés ne décodent leurs canaux que si l'univers a changé)
 *
 * Générique : utilisé par les lyres aujourd'hui, réutilisable demain par les
 * lasers, stroboscopes ou toute autre machine pilotée en DMX.
 * ─────────────────────────────────────────────────────────────
 */

export const DMX_CHANNELS = 512;

export class DmxUniverse {
    /** @param {number} number Numéro de l'univers (1…) */
    constructor(number) {
        this.number = number;
        this.data = new Uint8Array(DMX_CHANNELS);
        this.version = 0;
    }

    /** Valeur 8 bits d'une adresse DMX (1…512) */
    get(address) {
        return this.data[address - 1] || 0;
    }

    /** Valeur 16 bits (coarse sur `address`, fine sur `address + 1`), 0…65535 */
    get16(address) {
        return ((this.data[address - 1] || 0) << 8) | (this.data[address] || 0);
    }

    set(address, value) {
        const i = address - 1;
        if (i < 0 || i >= DMX_CHANNELS) return;
        const v = value < 0 ? 0 : value > 255 ? 255 : value | 0;
        if (this.data[i] !== v) {
            this.data[i] = v;
            this.version++;
        }
    }

    /** Remplace tout ou partie de l'univers (trame Art-Net / sACN reçue) */
    setFrame(bytes, startAddress = 1) {
        const off = startAddress - 1;
        const n = Math.min(bytes.length, DMX_CHANNELS - off);
        let changed = false;
        for (let i = 0; i < n; i++) {
            if (this.data[off + i] !== bytes[i]) {
                this.data[off + i] = bytes[i];
                changed = true;
            }
        }
        if (changed) this.version++;
    }

    clear() {
        this.data.fill(0);
        this.version++;
    }
}
