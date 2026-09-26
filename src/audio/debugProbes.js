/**
 * Debug Probes — Sonde de Rollback / Recalage Audio Musique.
 * (Toutes les sondes lourdes de test ont été désactivées pour garder la console propre).
 */

/**
 * SONDE ACTIVE : Recalage audio multijoueur (HeartbeatSync seek / Rollback)
 */
export function probeHeartbeatSeek(drift, reason) {
    console.warn(
        `%c[Rollback Musique] 🔄 Recalage audio : décalage de ${(drift * 1000).toFixed(0)}ms (${reason || 'synchronisation serveur'}). Seek audio fluide (fade 12ms).`,
        'color: #fff; background: #08979c; font-weight: bold; padding: 2px 6px; border-radius: 3px;'
    );
}

// ── Sondes désactivées (no-op) ──────────────────────────────────────────────
export function probeFrameSpike() {}
export function probeSpatialAudio() {}
export function probeAudioClock() {}
export function probeMetersTime() {}
export function probeObjectAdded() {}
export function setupAudioDebugProbes() {}
