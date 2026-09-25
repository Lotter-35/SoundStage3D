/**
 * PlaybackUI — Manages the bottom Playback controller, Waveform display,
 * Server Playlists management, and Spotify-style Queues (manual & context).
 */
import { makeDraggable, makeResizable } from './draggable.js';

export class PlaybackUI {
    constructor(options = {}) {
        this.callbacks = options.callbacks || {};

        this._playbackVisible = false;
        this._isPlaying = false;
        this._isPlaybackLocked = false;
        this._hasTrack = false;
        this._lockedText = '';
        this._isUserScrubbing = false;

        this._queue = [];
        this._currentQueueIndex = -1;
        this._currentTrack = null;
        this._manualQueue = [];
        this._contextQueue = [];
        this._contextName = '';
        this._contextPlaylistId = null;

        this._isShuffle = false;

        // Playlists state
        this._playlists = [];
        this._selectedPlaylistId = '';
        this._playlistSnapshots = new Map();
        this._autoSaveTimer = null;
        this._isReloading = false;
        this._reloadResetTimer = null;
        this._isPlCollapsed = false;
        this._isQueueCollapsed = false;

        // Waveform state
        this._peaksCache = new WeakMap();
        this._currentPeaks = null;
        this._currentAudioBuffer = null;
        this._defaultPeaks = this._generateDefaultPeaks(300);
        this._hoverWaveformRatio = -1;
        this._hoverWaveformX = -1;
        this._isDraggingWaveform = false;
        this._currentTime = 0;
        this._duration = 0;

        // Drag & drop state
        this._plDraggedIndex = null;
        this._plDraggedTrackId = null;
        this._draggedIndex = null;
        this._draggedTrackId = null;
        this._dragOverTrackId = null;
        this._dragOverIsTop = null;

        this._splitRatio = 0.45;
        this._savedPlaybackHeight = null;

        // DOM elements
        this.playbackBtn = document.getElementById('playback-btn');
        this.playbackBarWrap = document.getElementById('playback-bar-wrap');
        this.pbTrackTitle = document.getElementById('pb-track-title');
        if (this.pbTrackTitle) this.pbTrackTitle.textContent = '';
        this.pbCollapseBtn = document.getElementById('pb-collapse-btn');
        this.pbAddBtn = document.getElementById('pb-add-btn');
        this.pbCloseBtn = document.getElementById('pb-close-btn');
        this.pbTimeCurrent = document.getElementById('pb-time-current');
        this.pbTimeTotal = document.getElementById('pb-time-total');
        this.pbSlider = document.getElementById('pb-slider');
        this.pbWaveformWrap = document.getElementById('pb-waveform-wrap');
        this.pbWaveformCanvas = document.getElementById('pb-waveform-canvas');
        this.pbWaveformHoverLine = document.getElementById('pb-waveform-hover-line');
        this.pbWaveformHoverTime = document.getElementById('pb-waveform-hover-time');
        this.pbWaveformPlayhead = document.getElementById('pb-waveform-playhead');
        this._wfCtx = this.pbWaveformCanvas ? this.pbWaveformCanvas.getContext('2d') : null;

        this.pbPrevBtn = document.getElementById('pb-prev-btn');
        this.pbPlayBtn = document.getElementById('pb-play-btn');
        this.pbNextBtn = document.getElementById('pb-next-btn');
        this.pbShuffleBtn = document.getElementById('pb-shuffle-btn');

        this.pbPlaylistSelect = document.getElementById('pb-playlist-select');
        this.pbPlaylistStatus = document.getElementById('pb-playlist-status');
        this.pbPlRefreshBtn = document.getElementById('pb-pl-refresh-btn');
        this.pbPlNewBtn = document.getElementById('pb-pl-new-btn');
        this.pbPlRenameBtn = document.getElementById('pb-pl-rename-btn');
        this.pbPlDeleteBtn = document.getElementById('pb-pl-delete-btn');

        this.pbListsSplit = document.getElementById('pb-lists-split');
        this.pbSplitResizer = document.getElementById('pb-split-resizer');
        this.pbPlSection = document.getElementById('pb-pl-section');
        this.pbPlToggleBtn = document.getElementById('pb-pl-toggle-btn');
        this.pbPlChevron = document.getElementById('pb-pl-chevron');
        this.pbPlCount = document.getElementById('pb-pl-count');
        this.pbPlAddFilesBtn = document.getElementById('pb-pl-add-files-btn');
        this.pbPlLoadBtn = document.getElementById('pb-pl-load-btn');
        this.pbPlQueueAllBtn = document.getElementById('pb-pl-queue-all-btn');
        this.pbPlContainer = document.getElementById('pb-pl-container');
        this.pbPlList = document.getElementById('pb-pl-list');

        this.pbQueueSection = document.getElementById('pb-queue-section');
        this.pbQueueToggleBtn = document.getElementById('pb-queue-toggle-btn');
        this.pbQueueChevron = document.getElementById('pb-queue-chevron');
        this.pbQueueCount = document.getElementById('pb-queue-count');
        this.pbQueueContainer = document.getElementById('pb-queue-container');

        this.pbQNowSection = document.getElementById('pb-q-now-section');
        this.pbQNowItem = document.getElementById('pb-q-now-item');
        this.pbQManualSection = document.getElementById('pb-q-manual-section');
        this.pbQClearBtn = document.getElementById('pb-q-clear-btn');
        this.pbQManualList = document.getElementById('pb-q-manual-list');
        this.pbQContextSection = document.getElementById('pb-q-context-section');
        this.pbQContextTitle = document.getElementById('pb-q-context-title');
        this.pbQContextList = document.getElementById('pb-q-context-list');

        this._initEvents();
    }

    _initEvents() {
        try {
            const savedSize = JSON.parse(localStorage.getItem('soundstage3d:win-size:playback'));
            if (savedSize && typeof savedSize.height === 'number' && savedSize.height >= 240) {
                this._savedPlaybackHeight = savedSize.height;
            }
        } catch (_) {}
        try {
            const savedRatio = parseFloat(localStorage.getItem('soundstage3d:playback-split-ratio'));
            if (Number.isFinite(savedRatio) && savedRatio >= 0.1 && savedRatio <= 0.9) {
                this._splitRatio = savedRatio;
            }
        } catch (_) {}
        this._setSplitRatio(this._splitRatio);

        if (this.pbPlToggleBtn && this.pbPlContainer) {
            this.pbPlToggleBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._isPlCollapsed = !this._isPlCollapsed;
                if (!this._isPlCollapsed && this.playbackBarWrap?.classList.contains('pb-compact')) {
                    this.playbackBarWrap.classList.remove('pb-compact');
                    if (this.pbCollapseBtn) this.pbCollapseBtn.textContent = '▾';
                }
                this.pbPlContainer.classList.toggle('collapsed', this._isPlCollapsed);
                if (this.pbPlSection) {
                    this.pbPlSection.classList.toggle('collapsed', this._isPlCollapsed);
                }
                if (this.pbPlChevron) {
                    this.pbPlChevron.textContent = this._isPlCollapsed ? '▸' : '▾';
                }
                this._updateListsLayout();
            });
        }

        if (this.pbPlAddFilesBtn) {
            this.pbPlAddFilesBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const input = document.createElement('input');
                input.type = 'file';
                input.multiple = true;
                input.accept = '.mp3,.wav,.ogg,.flac,.m4a,audio/*';
                input.addEventListener('change', (ev) => {
                    const files = Array.from(ev.target.files || []);
                    if (files.length > 0) {
                        this._handlePlaylistFilesSelected(files);
                    }
                });
                input.click();
            });
        }

        if (this.pbPlContainer) {
            this.pbPlContainer.addEventListener('dragover', (e) => {
                if (e.dataTransfer && e.dataTransfer.types && Array.from(e.dataTransfer.types).includes('Files')) {
                    e.preventDefault();
                    e.stopPropagation();
                    e.dataTransfer.dropEffect = 'copy';
                }
            });
            this.pbPlContainer.addEventListener('drop', (e) => {
                if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                    const audioFiles = Array.from(e.dataTransfer.files).filter(f => f.type?.startsWith('audio/') || /\.(mp3|wav|ogg|flac|m4a)$/i.test(f.name));
                    if (audioFiles.length > 0) {
                        e.preventDefault();
                        e.stopPropagation();
                        this._handlePlaylistFilesSelected(audioFiles);
                    }
                }
            });
        }

        if (this.pbPlLoadBtn) {
            this.pbPlLoadBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                try {
                    if (window.__DEBUG?.audioEngine?.ctx?.state === 'suspended') {
                        window.__DEBUG.audioEngine.ctx.resume().catch(() => {});
                    }
                } catch (_) {}
                const targetId = this._selectedPlaylistId || (this.pbPlaylistSelect ? this.pbPlaylistSelect.value : '') || (this._playlists.length > 0 ? this._playlists[0].id : null);
                if (targetId) {
                    this._selectedPlaylistId = targetId;
                    if (this.pbPlaylistSelect) this.pbPlaylistSelect.value = targetId;
                    this._renderPlaylistTracks();
                    if (this.callbacks.onPlaylistLoad) {
                        this.callbacks.onPlaylistLoad(targetId);
                    }
                }
            });
        }

        if (this.pbPlQueueAllBtn) {
            this.pbPlQueueAllBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const targetId = this._selectedPlaylistId || (this.pbPlaylistSelect ? this.pbPlaylistSelect.value : '') || (this._playlists.length > 0 ? this._playlists[0].id : null);
                if (targetId && this.callbacks.onPlaylistQueueAll) {
                    this.callbacks.onPlaylistQueueAll(targetId);
                }
            });
        }

        if (this.pbPlaylistSelect) {
            this.pbPlaylistSelect.addEventListener('change', (e) => {
                e.stopPropagation();
                const plId = this.pbPlaylistSelect.value;
                this._selectedPlaylistId = plId;
                this._renderPlaylistTracks();
                this._updatePlaylistDirtyState();
            });
        }

        if (this.pbPlRefreshBtn) {
            this.pbPlRefreshBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                this.setPlaylistReloadingState();
                try {
                    if (this.callbacks.onPlaylistRefresh) {
                        await Promise.all([
                            this.callbacks.onPlaylistRefresh(),
                            new Promise(resolve => setTimeout(resolve, 350))
                        ]);
                    } else {
                        await new Promise(resolve => setTimeout(resolve, 350));
                    }
                } catch (err) {
                    console.warn('[Playlist] Error refreshing:', err);
                } finally {
                    this.setPlaylistReloadedState();
                }
            });
        }

        if (this.pbPlNewBtn) {
            this.pbPlNewBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const name = window.prompt("Nom de la nouvelle playlist :", "Nouvelle Playlist");
                if (name && name.trim()) {
                    const cleanName = name.trim();
                    const newId = `pl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
                    const newPl = {
                        id: newId,
                        name: cleanName,
                        tracks: [],
                        createdAt: Date.now(),
                        updatedAt: Date.now()
                    };
                    this._playlists.push(newPl);
                    this.updatePlaylists(this._playlists, newId);
                    if (this.callbacks.onPlaylistSave) {
                        this.callbacks.onPlaylistSave(cleanName, newId, []);
                    }
                }
            });
        }

        if (this.pbPlRenameBtn) {
            this.pbPlRenameBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!this._selectedPlaylistId) {
                    window.alert("Veuillez d'abord sélectionner une playlist à renommer.");
                    return;
                }
                const pl = this._playlists.find(p => p.id === this._selectedPlaylistId);
                const currentName = pl ? pl.name : '';
                const newName = window.prompt("Nouveau nom de la playlist :", currentName);
                if (newName && newName.trim() && this.callbacks.onPlaylistRename) {
                    this.callbacks.onPlaylistRename(this._selectedPlaylistId, newName.trim());
                }
            });
        }

        if (this.pbPlDeleteBtn) {
            this.pbPlDeleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!this._selectedPlaylistId) {
                    window.alert("Veuillez d'abord sélectionner une playlist à supprimer.");
                    return;
                }
                const pl = this._playlists.find(p => p.id === this._selectedPlaylistId);
                const name = pl ? pl.name : '';
                if (window.confirm(`Supprimer définitivement la playlist "${name}" du serveur ?`)) {
                    if (this.callbacks.onPlaylistDelete) {
                        this.callbacks.onPlaylistDelete(this._selectedPlaylistId);
                        this._selectedPlaylistId = '';
                    }
                }
            });
        }

        if (this.pbQClearBtn) {
            this.pbQClearBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this.callbacks.onManualQueueClear) this.callbacks.onManualQueueClear();
            });
        }

        if (this.pbShuffleBtn) {
            this.pbShuffleBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._isShuffle = !this._isShuffle;
                this.setShuffleState(this._isShuffle);
                if (this.callbacks.onShuffleToggle) this.callbacks.onShuffleToggle(this._isShuffle);
            });
        }

        if (this.pbSplitResizer && this.pbListsSplit) {
            this.pbSplitResizer.addEventListener('pointerdown', (e) => {
                if (e.button !== 0) return;
                if (this._isPlCollapsed || this._isQueueCollapsed) return;

                e.preventDefault();
                e.stopPropagation();

                this.pbSplitResizer.classList.add('is-resizing');
                document.body.style.userSelect = 'none';
                document.body.style.cursor = 'row-resize';

                const splitRect = this.pbListsSplit.getBoundingClientRect();
                const resizerH = this.pbSplitResizer.offsetHeight || 10;
                const availableHeight = splitRect.height - resizerH;

                const onPointerMove = (moveEvt) => {
                    if (availableHeight <= 0) return;
                    const relY = moveEvt.clientY - splitRect.top - (resizerH / 2);
                    const minH = 40;
                    const clampedY = Math.max(minH, Math.min(availableHeight - minH, relY));
                    const newRatio = clampedY / availableHeight;
                    this._setSplitRatio(newRatio);
                };

                const onPointerUp = () => {
                    window.removeEventListener('pointermove', onPointerMove);
                    window.removeEventListener('pointerup', onPointerUp);
                    window.removeEventListener('pointercancel', onPointerUp);
                    this.pbSplitResizer.classList.remove('is-resizing');
                    document.body.style.userSelect = '';
                    document.body.style.cursor = '';

                    try {
                        localStorage.setItem('soundstage3d:playback-split-ratio', this._splitRatio.toFixed(4));
                    } catch (_) {}
                };

                window.addEventListener('pointermove', onPointerMove);
                window.addEventListener('pointerup', onPointerUp);
                window.addEventListener('pointercancel', onPointerUp);
            });
        }

        if (this.pbQueueToggleBtn && this.pbQueueContainer) {
            this.pbQueueToggleBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._isQueueCollapsed = !this._isQueueCollapsed;
                if (!this._isQueueCollapsed && this.playbackBarWrap?.classList.contains('pb-compact')) {
                    this.playbackBarWrap.classList.remove('pb-compact');
                    if (this.pbCollapseBtn) this.pbCollapseBtn.textContent = '▾';
                }
                this.pbQueueContainer.classList.toggle('collapsed', this._isQueueCollapsed);
                if (this.pbQueueSection) {
                    this.pbQueueSection.classList.toggle('collapsed', this._isQueueCollapsed);
                }
                if (this.pbQueueChevron) {
                    this.pbQueueChevron.textContent = this._isQueueCollapsed ? '▸' : '▾';
                }
                this._updateListsLayout();
            });
        }
        this._updateListsLayout();

        if (this.pbAddBtn) {
            this.pbAddBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const input = document.createElement('input');
                input.type = 'file';
                input.multiple = true;
                input.accept = '.mp3,.wav,.ogg,.flac,.m4a,audio/*';
                input.addEventListener('change', (ev) => {
                    const files = Array.from(ev.target.files || []);
                    if (files.length > 0 && this.callbacks.onQueueAdd) {
                        this.callbacks.onQueueAdd(files);
                    }
                });
                input.click();
            });
        }

        if (this.pbCollapseBtn) {
            this.pbCollapseBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!this.playbackBarWrap) return;
                const isCompact = this.playbackBarWrap.classList.contains('pb-compact');
                this.setPlaybackCompact(!isCompact, true);
            });
        }

        if (this.playbackBtn) {
            this.playbackBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._playbackVisible = !this._playbackVisible;
                if (this.playbackBarWrap) this.playbackBarWrap.classList.toggle('hidden', !this._playbackVisible);
                this.playbackBtn.classList.toggle('active', this._playbackVisible);

                if (this._playbackVisible && this.pbPlayBtn) {
                    this.pbPlayBtn.textContent = this._isPlaying ? '⏸' : '▶';
                }
            });
        }

        if (this.playbackBarWrap) {
            this.playbackBarWrap.addEventListener('pointerdown', (e) => e.stopPropagation());
            this.playbackBarWrap.addEventListener('mousedown', (e) => e.stopPropagation());
            this.playbackBarWrap.addEventListener('click', (e) => e.stopPropagation());
        }

        if (this.pbCloseBtn) {
            this.pbCloseBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._playbackVisible = false;
                if (this.playbackBarWrap) this.playbackBarWrap.classList.add('hidden');
                if (this.playbackBtn) {
                    this.playbackBtn.classList.remove('active');
                }
            });
        }

        if (this.pbSlider) {
            this.pbSlider.addEventListener('mousedown', () => {
                if (this._isPlaybackLocked) return;
                this._isUserScrubbing = true;
            });
            this.pbSlider.addEventListener('touchstart', () => {
                if (this._isPlaybackLocked) return;
                this._isUserScrubbing = true;
            }, { passive: true });
            this.pbSlider.addEventListener('input', () => {
                if (this._isPlaybackLocked) return;
                const val = Number(this.pbSlider.value);
                if (this.pbTimeCurrent) this.pbTimeCurrent.textContent = this._formatTime(val);
            });
            this.pbSlider.addEventListener('change', () => {
                if (this._isPlaybackLocked) return;
                const val = Number(this.pbSlider.value);
                if (this.callbacks.onSeek) this.callbacks.onSeek(val);
                this._isUserScrubbing = false;
            });
            this.pbSlider.addEventListener('mouseup', () => { this._isUserScrubbing = false; });
            this.pbSlider.addEventListener('touchend', () => { this._isUserScrubbing = false; });
        }

        if (this.pbWaveformWrap) {
            const getProgressFromEvent = (e) => {
                const rect = this.pbWaveformWrap.getBoundingClientRect();
                if (rect.width <= 0) return 0;
                const clientX = (e.touches && e.touches.length > 0) ? e.touches[0].clientX : e.clientX;
                return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
            };

            const updateHover = (e) => {
                const rect = this.pbWaveformWrap.getBoundingClientRect();
                if (rect.width <= 0) return;
                const clientX = (e.touches && e.touches.length > 0) ? e.touches[0].clientX : e.clientX;
                const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
                this._hoverWaveformRatio = ratio;
                this._hoverWaveformX = ratio * rect.width;

                const pct = `${(ratio * 100).toFixed(2)}%`;
                if (this.pbWaveformHoverLine) {
                    this.pbWaveformHoverLine.classList.remove('hidden');
                    this.pbWaveformHoverLine.style.left = pct;
                }
                if (this.pbWaveformHoverTime) {
                    this.pbWaveformHoverTime.classList.remove('hidden');
                    this.pbWaveformHoverTime.style.left = pct;
                    const hoverTime = ratio * (this._duration || 0);
                    this.pbWaveformHoverTime.textContent = this._formatTime(hoverTime);
                }
            };

            const clearHover = () => {
                this._hoverWaveformRatio = -1;
                this._hoverWaveformX = -1;
                if (this.pbWaveformHoverLine) this.pbWaveformHoverLine.classList.add('hidden');
                if (this.pbWaveformHoverTime) this.pbWaveformHoverTime.classList.add('hidden');
                this._drawWaveform();
            };

            this.pbWaveformWrap.addEventListener('mousemove', (e) => {
                if (this._isDraggingWaveform || !this._hasTrack) return;
                updateHover(e);
                this._drawWaveform();
            });

            this.pbWaveformWrap.addEventListener('mouseleave', () => {
                if (!this._isDraggingWaveform) {
                    clearHover();
                }
            });

            const onStartScrub = (e) => {
                if (this._isPlaybackLocked || !this._hasTrack) return;
                this._isUserScrubbing = true;
                this._isDraggingWaveform = true;
                updateHover(e);
                const progress = getProgressFromEvent(e);
                const seekTime = progress * (this._duration || 0);
                this._currentTime = seekTime;
                if (this.pbTimeCurrent) this.pbTimeCurrent.textContent = this._formatTime(seekTime);
                if (this.pbSlider) this.pbSlider.value = seekTime;
                this._drawWaveform();

                const onMove = (moveEvt) => {
                    updateHover(moveEvt);
                    const p = getProgressFromEvent(moveEvt);
                    const t = p * (this._duration || 0);
                    this._currentTime = t;
                    if (this.pbTimeCurrent) this.pbTimeCurrent.textContent = this._formatTime(t);
                    if (this.pbSlider) this.pbSlider.value = t;
                    this._drawWaveform();
                };

                const onEnd = (endEvt) => {
                    window.removeEventListener('mousemove', onMove);
                    window.removeEventListener('mouseup', onEnd);
                    window.removeEventListener('touchmove', onMove);
                    window.removeEventListener('touchend', onEnd);
                    window.removeEventListener('touchcancel', onEnd);

                    this._isDraggingWaveform = false;
                    this._isUserScrubbing = false;
                    const finalProgress = endEvt ? getProgressFromEvent(endEvt) : progress;
                    const finalTime = finalProgress * (this._duration || 0);
                    this._currentTime = finalTime;
                    if (this.callbacks.onSeek) {
                        this.callbacks.onSeek(finalTime);
                    }
                    clearHover();
                };

                window.addEventListener('mousemove', onMove);
                window.addEventListener('mouseup', onEnd);
                window.addEventListener('touchmove', onMove);
                window.addEventListener('touchend', onEnd);
                window.addEventListener('touchcancel', onEnd);
            };

            this.pbWaveformWrap.addEventListener('mousedown', onStartScrub);
            this.pbWaveformWrap.addEventListener('touchstart', onStartScrub, { passive: true });

            if (window.ResizeObserver) {
                const ro = new ResizeObserver(() => {
                    this._drawWaveform();
                });
                ro.observe(this.pbWaveformWrap);
            }
        }

        if (this.pbPrevBtn) {
            this.pbPrevBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this._isPlaybackLocked || !this._hasTrack) return;
                if (this.callbacks.onPrev) {
                    this.callbacks.onPrev();
                } else if (this.callbacks.onSeek) {
                    this.callbacks.onSeek(0);
                }
            });
        }

        if (this.pbNextBtn) {
            this.pbNextBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this._isPlaybackLocked || !this._hasTrack) return;
                if (this.callbacks.onNext) {
                    this.callbacks.onNext();
                } else if (this.callbacks.onSeek) {
                    this.callbacks.onSeek(0);
                }
            });
        }

        if (this.pbPlayBtn) {
            this.pbPlayBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this._isPlaybackLocked || !this._hasTrack) return;
                if (this.callbacks.onPlayPause) this.callbacks.onPlayPause();
            });
        }

        if (this.playbackBarWrap) {
            const pbHandle = this.playbackBarWrap.querySelector('.pb-info') || this.playbackBarWrap;
            makeDraggable(this.playbackBarWrap, pbHandle, 'playback', false);
            makeResizable(this.playbackBarWrap, {
                minWidth: () => this._getPlaybackMinWidth(),
                minHeight: () => this._getPlaybackMinHeight(),
                storageKey: 'playback',
                onResize: (w, h) => {
                    const isCompact = this.playbackBarWrap.classList.contains('pb-compact');
                    if (isCompact) {
                        if (h >= 180) {
                            this.playbackBarWrap.classList.remove('pb-compact');
                            if (this.pbCollapseBtn) {
                                this.pbCollapseBtn.textContent = '▾';
                                this.pbCollapseBtn.title = "Réduire la fenêtre (masquer la playlist et la file d'attente)";
                            }
                            const minW = this._getPlaybackMinWidth();
                            if (this.playbackBarWrap.offsetWidth < minW) {
                                this.playbackBarWrap.style.width = `${minW}px`;
                            }
                            try { localStorage.setItem('soundstage3d:playback-compact', 'false'); } catch (_) {}
                        }
                    } else {
                        if (h > 0 && h < 200) {
                            const curH = this.playbackBarWrap.offsetHeight;
                            if (curH >= 240) this._savedPlaybackHeight = curH;
                            this.playbackBarWrap.classList.add('pb-compact');
                            if (this.pbCollapseBtn) {
                                this.pbCollapseBtn.textContent = '▴';
                                this.pbCollapseBtn.title = "Agrandir la fenêtre (afficher la playlist et la file d'attente)";
                            }
                            try { localStorage.setItem('soundstage3d:playback-compact', 'true'); } catch (_) {}
                        } else if (h >= 240) {
                            this._savedPlaybackHeight = h;
                            try { localStorage.setItem('soundstage3d:playback-compact', 'false'); } catch (_) {}
                        }
                    }
                    this._drawWaveform();
                }
            });
            this.playbackBarWrap.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });

            let initialCompact = false;
            try {
                initialCompact = localStorage.getItem('soundstage3d:playback-compact') === 'true';
            } catch (_) {}
            this.setPlaybackCompact(initialCompact, false);
        }
    }

    _handlePlaylistFilesSelected(files) {
        if (!files || files.length === 0) return;
        if (!this._selectedPlaylistId) {
            let plName = window.prompt("Nom de la nouvelle playlist pour ces morceaux :", "Ma Playlist");
            if (!plName || !plName.trim()) plName = "Ma Playlist";
            const newId = `pl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
            const newPl = {
                id: newId,
                name: plName.trim(),
                tracks: [],
                createdAt: Date.now(),
                updatedAt: Date.now()
            };
            this._playlists.push(newPl);
            this.updatePlaylists(this._playlists, newId);
        }

        if (this._isPlCollapsed) {
            this._isPlCollapsed = false;
            if (this.pbPlContainer) this.pbPlContainer.classList.remove('collapsed');
            if (this.pbPlSection) this.pbPlSection.classList.remove('collapsed');
            if (this.pbPlChevron) this.pbPlChevron.textContent = '▾';
            this._updateListsLayout();
        }

        if (this.callbacks.onPlaylistFilesAdd) {
            this.callbacks.onPlaylistFilesAdd(this._selectedPlaylistId, files);
        }
    }

    notifyPlaylistTracksUpdated(playlistId) {
        if (!playlistId) return;
        const pl = this._playlists.find(p => p.id === playlistId);
        if (!pl) return;

        if (this.pbPlaylistSelect) {
            const opt = this.pbPlaylistSelect.querySelector(`option[value="${playlistId}"]`);
            if (opt) {
                opt.textContent = `${pl.name} (${(pl.tracks ? pl.tracks.length : pl.trackCount) || 0} morceaux)`;
            }
        }

        if (this._selectedPlaylistId === playlistId) {
            this._renderPlaylistTracks();
            this._updatePlaylistDirtyState();
        }

        if (this.callbacks.onPlaylistTracksChange) {
            this.callbacks.onPlaylistTracksChange(playlistId, pl.tracks);
        }
    }

    getPlaylist(playlistId) {
        return this._playlists.find(p => p.id === playlistId) || null;
    }

    updatePlaylists(playlists, activeId = null) {
        this._playlists = Array.isArray(playlists) ? playlists : [];
        for (const pl of this._playlists) {
            if (Array.isArray(pl.tracks)) {
                this._playlistSnapshots.set(pl.id, JSON.stringify(pl.tracks));
            }
        }

        if (activeId !== null && activeId !== undefined && activeId !== '') {
            this._selectedPlaylistId = activeId;
        } else if (this._selectedPlaylistId && !this._playlists.some(p => p.id === this._selectedPlaylistId)) {
            this._selectedPlaylistId = this._playlists.length > 0 ? this._playlists[0].id : '';
        } else if (!this._selectedPlaylistId && this._playlists.length > 0) {
            this._selectedPlaylistId = this._playlists[0].id;
        }

        if (!this.pbPlaylistSelect) return;
        this.pbPlaylistSelect.innerHTML = '';

        const defOpt = document.createElement('option');
        defOpt.value = '';
        defOpt.textContent = this._playlists.length === 0 ? '-- Aucune playlist serveur --' : '-- Choisir une playlist --';
        this.pbPlaylistSelect.appendChild(defOpt);

        for (const pl of this._playlists) {
            const opt = document.createElement('option');
            opt.value = pl.id;
            opt.textContent = `${pl.name} (${(pl.tracks ? pl.tracks.length : pl.trackCount) || 0} morceaux)`;
            if (pl.id === this._selectedPlaylistId) {
                opt.selected = true;
            }
            this.pbPlaylistSelect.appendChild(opt);
        }
        this._renderPlaylistTracks();
        this.setPlaylistSavedState(this._selectedPlaylistId);
    }

    markPlaylistSaved(playlistId) {
        this.setPlaylistSavedState(playlistId);
    }

    _renderPlaylistTracks() {
        if (!this.pbPlList) return;
        this.pbPlList.innerHTML = '';

        const pl = this._selectedPlaylistId ? this._playlists.find(p => p.id === this._selectedPlaylistId) : null;
        const tracks = pl && Array.isArray(pl.tracks) ? pl.tracks : [];

        if (this.pbPlCount) {
            this.pbPlCount.textContent = tracks.length;
        }

        if (this.pbPlLoadBtn) {
            const hasTracks = tracks.length > 0;
            this.pbPlLoadBtn.disabled = !hasTracks;
            this.pbPlLoadBtn.classList.toggle('disabled', !hasTracks);
            this.pbPlLoadBtn.title = hasTracks ? `Lire "${pl ? pl.name : 'la playlist'}"` : 'Playlist vide ou aucune sélection';
        }

        if (this.pbPlQueueAllBtn) {
            const hasTracks = tracks.length > 0;
            this.pbPlQueueAllBtn.disabled = !hasTracks;
            this.pbPlQueueAllBtn.classList.toggle('disabled', !hasTracks);
            this.pbPlQueueAllBtn.title = hasTracks ? `Ajouter les ${tracks.length} morceau(x) de "${pl ? pl.name : 'la playlist'}" à la suite` : 'Playlist vide ou aucune sélection';
        }

        if (!pl) {
            const empty = document.createElement('div');
            empty.className = 'pb-queue-empty';
            empty.textContent = 'Sélectionnez une playlist pour voir ses morceaux';
            this.pbPlList.appendChild(empty);
            return;
        }

        if (tracks.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'pb-queue-empty';
            empty.innerHTML = 'Cette playlist est vide.<br><button class="pb-pl-empty-add-btn">➕ Ajouter des musiques</button>';
            const emptyBtn = empty.querySelector('.pb-pl-empty-add-btn');
            if (emptyBtn) {
                emptyBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (this.pbPlAddFilesBtn) this.pbPlAddFilesBtn.click();
                });
            }
            this.pbPlList.appendChild(empty);
            return;
        }

        const isContextPlaylist = Boolean(this._selectedPlaylistId && (this._selectedPlaylistId === this._contextPlaylistId));

        tracks.forEach((track, index) => {
            const el = document.createElement('div');
            el.className = 'pb-queue-item pb-pl-item';
            el.draggable = true;
            el.dataset.index = index;
            el.dataset.trackId = track.id;

            const isCurrentlyPlaying = isContextPlaylist && this._currentTrack &&
                ((track.id && this._currentTrack.id && track.id === this._currentTrack.id) ||
                 (track.name && this._currentTrack.name && track.name === this._currentTrack.name));

            if (isCurrentlyPlaying) {
                el.classList.add('playing');
                el.classList.add('active');
            }

            const handle = document.createElement('span');
            handle.className = 'pb-pl-drag-handle';
            handle.textContent = '⋮⋮';
            handle.title = 'Glisser pour réorganiser dans la playlist';

            const num = document.createElement('span');
            num.className = 'pb-queue-num';
            if (isCurrentlyPlaying) {
                num.classList.add('pb-pl-playing-icon');
                num.textContent = this._isPlaying ? '▶' : '⏸';
                num.title = this._isPlaying ? 'Morceau en cours de lecture' : 'Morceau en pause';
            } else {
                num.textContent = `${index + 1}.`;
            }

            const name = document.createElement('span');
            name.className = 'pb-queue-name';
            name.textContent = track.name || `Piste ${index + 1}`;
            name.title = track.name || '';

            let serverBadge = null;
            if (track.uploading) {
                serverBadge = document.createElement('span');
                serverBadge.className = 'pb-pl-server-badge uploading';
                serverBadge.title = 'Envoi vers le serveur en cours...';
                serverBadge.textContent = '⏳ Envoi...';
            } else if (track.onServer === false) {
                el.classList.add('not-on-server');
                serverBadge = document.createElement('span');
                serverBadge.className = 'pb-pl-server-badge offline';
                serverBadge.title = 'Fichier audio non chargé sur le serveur (non accessible aux autres participants)';
                serverBadge.textContent = '⚠️ Hors serveur';
            }

            let badge = null;
            if (isCurrentlyPlaying) {
                badge = document.createElement('span');
                badge.className = 'pb-pl-playing-badge';
                if (this._isPlaying) {
                    badge.innerHTML = '<span class="pb-eq-bars"><span></span><span></span><span></span></span> En lecture';
                } else {
                    badge.textContent = '⏸ En pause';
                }
            }

            const actions = document.createElement('div');
            actions.className = 'pb-pl-actions';

            const addBtn = document.createElement('button');
            addBtn.className = 'pb-pl-add-track-btn';
            addBtn.innerHTML = `<svg viewBox="0 0 512 512" width="13" height="13" fill="none" stroke="currentColor" stroke-width="40" stroke-linecap="round" stroke-linejoin="round">
                <line x1="48" y1="124" x2="396" y2="124"></line>
                <line x1="48" y1="248" x2="396" y2="248"></line>
                <line x1="48" y1="372" x2="196" y2="372"></line>
                <polygon points="236,372 396,276 396,468"></polygon>
            </svg>`;
            addBtn.title = "Ajouter à la file d'attente (prioritaire)";
            addBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this.callbacks.onPlaylistTrackAdd) {
                    this.callbacks.onPlaylistTrackAdd(track);
                }
            });

            const removeBtn = document.createElement('button');
            removeBtn.className = 'pb-pl-remove-btn';
            removeBtn.innerHTML = '✕';
            removeBtn.title = 'Supprimer ce morceau de la playlist';
            removeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                pl.tracks.splice(index, 1);
                this._renderPlaylistTracks();
                this._triggerAutoSave();
                if (this.callbacks.onPlaylistTracksChange) {
                    this.callbacks.onPlaylistTracksChange(this._selectedPlaylistId, pl.tracks);
                }
            });

            actions.appendChild(addBtn);
            actions.appendChild(removeBtn);

            el.appendChild(handle);
            el.appendChild(num);
            el.appendChild(name);
            if (serverBadge) el.appendChild(serverBadge);
            if (badge) el.appendChild(badge);
            el.appendChild(actions);

            el.addEventListener('click', (e) => {
                if (e.target.closest('button')) return;
                try {
                    if (window.__DEBUG?.audioEngine?.ctx?.state === 'suspended') {
                        window.__DEBUG.audioEngine.ctx.resume().catch(() => {});
                    }
                } catch (_) {}
                if (this.callbacks.onPlaylistTrackPlay) {
                    this.callbacks.onPlaylistTrackPlay(this._selectedPlaylistId, index, track);
                }
            });

            // Drag & drop
            el.addEventListener('dragstart', (e) => {
                this._plDraggedIndex = index;
                this._plDraggedTrackId = track.id;
                el.classList.add('dragging');
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', String(index));
            });

            el.addEventListener('dragend', () => {
                el.classList.remove('dragging');
                if (this.pbPlList) {
                    this.pbPlList.querySelectorAll('.pb-pl-item').forEach(it => {
                        it.classList.remove('drag-over-top', 'drag-over-bottom', 'dragging');
                    });
                }
                this._plDraggedIndex = null;
                this._plDraggedTrackId = null;
            });

            el.addEventListener('dragover', (e) => {
                e.preventDefault();
                if (this._plDraggedTrackId === track.id) return;
                e.dataTransfer.dropEffect = 'move';

                const rect = el.getBoundingClientRect();
                const isTop = (e.clientY - rect.top) < (rect.height / 2);
                el.classList.toggle('drag-over-top', isTop);
                el.classList.toggle('drag-over-bottom', !isTop);
            });

            el.addEventListener('dragleave', (e) => {
                if (e.relatedTarget && el.contains(e.relatedTarget)) return;
                el.classList.remove('drag-over-top', 'drag-over-bottom');
            });

            el.addEventListener('drop', (e) => {
                e.preventDefault();
                el.classList.remove('drag-over-top', 'drag-over-bottom');
                if (this._plDraggedIndex === null || this._plDraggedIndex === undefined || this._plDraggedIndex === index) return;

                const rect = el.getBoundingClientRect();
                const isTop = (e.clientY - rect.top) < (rect.height / 2);
                let targetIdx = isTop ? index : index + 1;
                if (this._plDraggedIndex < targetIdx) targetIdx--;

                const [moved] = pl.tracks.splice(this._plDraggedIndex, 1);
                pl.tracks.splice(targetIdx, 0, moved);

                this._renderPlaylistTracks();
                this._triggerAutoSave();
                if (this.callbacks.onPlaylistTracksChange) {
                    this.callbacks.onPlaylistTracksChange(this._selectedPlaylistId, pl.tracks);
                }
            });

            this.pbPlList.appendChild(el);
        });
    }

    triggerAutoSave() {
        this._triggerAutoSave();
    }

    _triggerAutoSave() {
        const pl = this._selectedPlaylistId ? this._playlists.find(p => p.id === this._selectedPlaylistId) : null;
        if (!pl || !this._selectedPlaylistId) return;

        if (this.pbPlaylistStatus) {
            this.pbPlaylistStatus.classList.remove('hidden', 'saved');
            this.pbPlaylistStatus.classList.add('saving');
            this.pbPlaylistStatus.textContent = 'Sauvegarde...';
        }

        if (this._autoSaveTimer) {
            clearTimeout(this._autoSaveTimer);
        }

        this._autoSaveTimer = setTimeout(() => {
            this._autoSaveTimer = null;
            if (this.callbacks.onPlaylistSave) {
                const name = pl.name || 'Ma Playlist';
                const tracks = Array.isArray(pl.tracks) ? pl.tracks : [];
                this.callbacks.onPlaylistSave(name, pl.id, tracks);
            }
            this.setPlaylistSavedState(pl.id);
        }, 300);
    }

    setPlaylistSavedState(playlistId = null) {
        const targetId = playlistId || this._selectedPlaylistId;
        const pl = targetId ? this._playlists.find(p => p.id === targetId) : null;
        if (pl && Array.isArray(pl.tracks)) {
            this._playlistSnapshots.set(pl.id, JSON.stringify(pl.tracks));
        }
        if (this._isReloading) return;
        if (this.pbPlaylistStatus) {
            if (this._selectedPlaylistId) {
                this.pbPlaylistStatus.classList.remove('hidden', 'saving', 'reloading');
                this.pbPlaylistStatus.classList.add('saved');
                this.pbPlaylistStatus.textContent = 'Sauvegardé';
            } else {
                this.pbPlaylistStatus.classList.add('hidden');
                this.pbPlaylistStatus.textContent = '';
            }
        }
    }

    setPlaylistReloadingState() {
        this._isReloading = true;
        if (this._reloadResetTimer) {
            clearTimeout(this._reloadResetTimer);
            this._reloadResetTimer = null;
        }
        if (this.pbPlaylistStatus) {
            this.pbPlaylistStatus.classList.remove('hidden', 'saved', 'reloaded');
            this.pbPlaylistStatus.classList.add('saving', 'reloading');
            this.pbPlaylistStatus.textContent = 'Reload...';
        }
    }

    setPlaylistReloadedState() {
        this._isReloading = false;
        if (this.pbPlaylistStatus) {
            if (this._selectedPlaylistId) {
                this.pbPlaylistStatus.classList.remove('hidden', 'saving', 'reloading');
                this.pbPlaylistStatus.classList.add('saved', 'reloaded');
                this.pbPlaylistStatus.textContent = 'Reload';
            } else {
                this.pbPlaylistStatus.classList.add('hidden');
                this.pbPlaylistStatus.textContent = '';
            }
        }
        if (this._reloadResetTimer) {
            clearTimeout(this._reloadResetTimer);
        }
        this._reloadResetTimer = setTimeout(() => {
            this._reloadResetTimer = null;
            if (this.pbPlaylistStatus && this.pbPlaylistStatus.textContent === 'Reload' && this._selectedPlaylistId) {
                this.pbPlaylistStatus.textContent = 'Sauvegardé';
            }
        }, 2500);
    }

    _updatePlaylistDirtyState() {
        const pl = this._selectedPlaylistId ? this._playlists.find(p => p.id === this._selectedPlaylistId) : null;
        if (!pl || !this._selectedPlaylistId) {
            if (this.pbPlaylistStatus) {
                this.pbPlaylistStatus.classList.add('hidden');
                this.pbPlaylistStatus.textContent = '';
            }
            return;
        }

        const originalJson = this._playlistSnapshots.get(pl.id);
        const currentJson = JSON.stringify(pl.tracks || []);
        const isModified = originalJson !== undefined && originalJson !== currentJson;

        if (isModified) {
            this._triggerAutoSave();
        } else {
            this.setPlaylistSavedState(pl.id);
        }
    }

    updateQueue(options = {}) {
        if (Array.isArray(options)) {
            const queue = options;
            const currentIndex = arguments[1] !== undefined ? arguments[1] : -1;
            const cur = (currentIndex >= 0 && currentIndex < queue.length) ? queue[currentIndex] : null;
            const rest = currentIndex >= 0 ? queue.slice(currentIndex + 1) : [...queue];
            return this.updateQueue({
                currentTrack: cur,
                manualQueue: [],
                contextQueue: rest,
                contextName: '',
                isShuffle: this._isShuffle
            });
        }
        const {
            currentTrack = null,
            manualQueue = [],
            contextQueue = [],
            contextName = '',
            contextPlaylistId = undefined,
            isShuffle = false
        } = options;
        this._currentTrack = currentTrack;
        this._manualQueue = manualQueue || [];
        this._contextQueue = contextQueue || [];
        this._contextName = contextName || '';
        if (contextPlaylistId !== undefined) {
            this._contextPlaylistId = contextPlaylistId;
        }
        this._isShuffle = !!isShuffle;

        if (!this._currentTrack) {
            this.setHasTrack(false);
        }

        const totalCount = (currentTrack ? 1 : 0) + this._manualQueue.length + this._contextQueue.length;
        if (this.pbQueueCount) {
            this.pbQueueCount.textContent = totalCount;
        }
        this._renderSpotifyQueue();
        this._renderPlaylistTracks();
    }

    _renderSpotifyQueue() {
        if (!this.pbQueueContainer) return;

        // 1. Titre en cours de lecture
        if (this._currentTrack && this.pbQNowSection && this.pbQNowItem) {
            this.pbQNowSection.classList.remove('hidden');
            this.pbQNowItem.innerHTML = '';

            const num = document.createElement('span');
            num.className = 'pb-queue-num';
            num.textContent = '▶';

            let spinner = null;
            if (this._currentTrack.loading) {
                spinner = document.createElement('span');
                spinner.className = 'pb-queue-spinner';
                spinner.title = 'Chargement en cours...';
            }

            const name = document.createElement('span');
            name.className = 'pb-queue-name';
            name.textContent = this._currentTrack.name || 'Piste en cours';
            name.title = this._currentTrack.name || '';

            this.pbQNowItem.appendChild(num);
            if (spinner) this.pbQNowItem.appendChild(spinner);
            this.pbQNowItem.appendChild(name);
        } else if (this.pbQNowSection) {
            this.pbQNowSection.classList.add('hidden');
        }

        // 2. À suivre dans la file d'attente (manuelle prioritaire)
        if (this.pbQManualSection && this.pbQManualList) {
            this.pbQManualList.innerHTML = '';
            if (this._manualQueue.length > 0) {
                this.pbQManualSection.classList.remove('hidden');
                this._manualQueue.forEach((item, index) => {
                    const el = this._createQueueItemElement(item, index, 'manual');
                    this.pbQManualList.appendChild(el);
                });
            } else {
                this.pbQManualSection.classList.add('hidden');
            }
        }

        // 3. À suivre (contexte playlist)
        if (this.pbQContextSection && this.pbQContextList) {
            this.pbQContextList.innerHTML = '';
            if (this.pbQContextTitle) {
                const shuffleSuffix = this._isShuffle ? ' 🔀' : '';
                this.pbQContextTitle.textContent = this._contextName ? `À suivre • ${this._contextName}${shuffleSuffix}` : `À suivre${shuffleSuffix}`;
            }

            if (this._contextQueue.length > 0) {
                this.pbQContextSection.classList.remove('hidden');
                this._contextQueue.forEach((item, index) => {
                    const el = this._createQueueItemElement(item, index, 'context');
                    this.pbQContextList.appendChild(el);
                });
            } else {
                if (!this._currentTrack && this._manualQueue.length === 0) {
                    this.pbQContextSection.classList.remove('hidden');
                    const empty = document.createElement('div');
                    empty.className = 'pb-queue-empty';
                    empty.textContent = 'Aucune musique en attente';
                    this.pbQContextList.appendChild(empty);
                } else {
                    this.pbQContextSection.classList.add('hidden');
                }
            }
        }
    }

    _createQueueItemElement(item, index, type) {
        const el = document.createElement('div');
        el.className = `pb-queue-item${item.loading ? ' loading' : ''}`;
        el.draggable = true;
        el.dataset.index = index;
        el.dataset.type = type;
        const trackId = String(item.id || item.name || index);
        el.dataset.trackId = trackId;

        const handle = document.createElement('span');
        handle.className = 'pb-queue-drag-handle';
        handle.textContent = '⋮⋮';

        let spinner = null;
        if (item.loading) {
            spinner = document.createElement('span');
            spinner.className = 'pb-queue-spinner';
            spinner.title = 'Chargement en cours...';
        }

        const name = document.createElement('span');
        name.className = 'pb-queue-name';
        name.textContent = item.name || 'Piste audio';
        name.title = item.name || '';
        if (type === 'context') {
            name.style.cursor = 'pointer';
            name.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this.callbacks.onContextQueueSelect) this.callbacks.onContextQueueSelect(index);
            });
        }

        const removeBtn = document.createElement('button');
        removeBtn.className = 'pb-queue-remove';
        removeBtn.innerHTML = '✕';
        removeBtn.title = 'Supprimer de la file';
        removeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (type === 'manual' && this.callbacks.onManualQueueRemove) {
                this.callbacks.onManualQueueRemove(index);
            } else if (type === 'context' && this.callbacks.onContextQueueRemove) {
                this.callbacks.onContextQueueRemove(index);
            }
        });

        el.appendChild(handle);
        if (spinner) el.appendChild(spinner);
        el.appendChild(name);
        el.appendChild(removeBtn);

        // Drag and drop events
        el.addEventListener('dragstart', (e) => {
            this._draggedIndex = index;
            this._draggedType = type;
            this._draggedTrackId = trackId;
            el.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', String(index));
        });

        el.addEventListener('dragend', () => {
            el.classList.remove('dragging');
            const parentList = type === 'manual' ? this.pbQManualList : this.pbQContextList;
            if (parentList) {
                parentList.querySelectorAll('.pb-queue-item').forEach(itemEl => {
                    itemEl.classList.remove('drag-over-top', 'drag-over-bottom', 'dragging');
                });
            }
            this._draggedIndex = null;
            this._draggedType = null;
            this._draggedTrackId = null;
        });

        el.addEventListener('dragover', (e) => {
            e.preventDefault();
            if (this._draggedType !== type || this._draggedTrackId === trackId) return;
            e.dataTransfer.dropEffect = 'move';

            const rect = el.getBoundingClientRect();
            const isTop = (e.clientY - rect.top) < (rect.height / 2);
            el.classList.toggle('drag-over-top', isTop);
            el.classList.toggle('drag-over-bottom', !isTop);
        });

        el.addEventListener('dragleave', (e) => {
            if (e.relatedTarget && el.contains(e.relatedTarget)) return;
            el.classList.remove('drag-over-top', 'drag-over-bottom');
        });

        el.addEventListener('drop', (e) => {
            e.preventDefault();
            el.classList.remove('drag-over-top', 'drag-over-bottom');
            if (this._draggedType !== type || this._draggedIndex === null || this._draggedIndex === undefined || this._draggedIndex === index) return;

            const rect = el.getBoundingClientRect();
            const isTop = (e.clientY - rect.top) < (rect.height / 2);
            let targetIdx = isTop ? index : index + 1;
            if (this._draggedIndex < targetIdx) targetIdx--;

            if (type === 'manual' && this.callbacks.onManualQueueReorder) {
                this.callbacks.onManualQueueReorder(this._draggedIndex, targetIdx);
            } else if (type === 'context' && this.callbacks.onContextQueueReorder) {
                this.callbacks.onContextQueueReorder(this._draggedIndex, targetIdx);
            }
        });

        return el;
    }

    setHasTrack(hasTrack) {
        this._hasTrack = Boolean(hasTrack);
        if (!this._hasTrack) {
            this._currentTime = 0;
            this._duration = 0;
            this._currentPeaks = null;
            this._currentAudioBuffer = null;
            this._drawWaveform();
            if (this.pbTrackTitle && !this._isPlaybackLocked) {
                this.pbTrackTitle.textContent = '';
            }
            if (this.pbTimeCurrent) this.pbTimeCurrent.textContent = '00:00';
            if (this.pbTimeTotal) this.pbTimeTotal.textContent = '00:00';
            if (this.pbSlider) this.pbSlider.value = 0;
        }
        this._updatePlayButtonState();
    }

    setPlaybackLocked(locked, text = '') {
        this._isPlaybackLocked = Boolean(locked);
        this._lockedText = text;

        if (this.pbTrackTitle) {
            if (this._isPlaybackLocked && text) {
                this.pbTrackTitle.textContent = text;
            } else if (!this._isPlaying) {
                this.pbTrackTitle.textContent = '';
            }
        }

        this._updatePlayButtonState();
    }

    setPlayState(isPlaying) {
        this._isPlaying = Boolean(isPlaying);
        this._updatePlayButtonState();
        if (!this._isPlaying) {
            if (this.pbTrackTitle && !this._isPlaybackLocked) {
                this.pbTrackTitle.textContent = '';
            }
        }
        this._renderPlaylistTracks();
    }

    _updatePlayButtonState() {
        const canTrackPlay = this._hasTrack && !this._isPlaybackLocked;

        if (this.pbPlayBtn) {
            this.pbPlayBtn.disabled = !canTrackPlay;
            this.pbPlayBtn.style.opacity = !canTrackPlay ? '0.35' : '';
            this.pbPlayBtn.style.pointerEvents = !canTrackPlay ? 'none' : '';
            this.pbPlayBtn.style.cursor = !canTrackPlay ? 'not-allowed' : 'pointer';

            if (this._isPlaybackLocked) {
                this.pbPlayBtn.textContent = '⏳';
                this.pbPlayBtn.title = this._lockedText || 'Chargement en cours...';
            } else if (!this._hasTrack) {
                this.pbPlayBtn.textContent = '▶';
                this.pbPlayBtn.title = 'Aucune musique chargée';
            } else {
                this.pbPlayBtn.textContent = this._isPlaying ? '⏸' : '▶';
                this.pbPlayBtn.title = this._isPlaying ? 'Mettre en pause' : 'Lancer la lecture';
            }
        }

        if (this.pbSlider) {
            this.pbSlider.disabled = !canTrackPlay;
            this.pbSlider.style.opacity = !canTrackPlay ? '0.35' : '';
            this.pbSlider.style.pointerEvents = !canTrackPlay ? 'none' : '';
            this.pbSlider.style.cursor = !canTrackPlay ? 'not-allowed' : 'pointer';
            if (!this._hasTrack) {
                this.pbSlider.value = 0;
            }
        }

        if (this.pbWaveformWrap) {
            this.pbWaveformWrap.classList.toggle('disabled', !canTrackPlay);
            this.pbWaveformWrap.title = canTrackPlay ? "Cliquer ou glisser pour naviguer" : "Aucune musique chargée";
        }
        if (!this._hasTrack) {
            this._currentTime = 0;
            this._duration = 0;
            this._currentPeaks = null;
            this._drawWaveform();
        }

        if (this.pbPrevBtn) {
            this.pbPrevBtn.disabled = !canTrackPlay;
            this.pbPrevBtn.style.opacity = !canTrackPlay ? '0.35' : '';
            this.pbPrevBtn.style.pointerEvents = !canTrackPlay ? 'none' : '';
            this.pbPrevBtn.style.cursor = !canTrackPlay ? 'not-allowed' : 'pointer';
        }

        if (this.pbNextBtn) {
            this.pbNextBtn.disabled = !canTrackPlay;
            this.pbNextBtn.style.opacity = !canTrackPlay ? '0.35' : '';
            this.pbNextBtn.style.pointerEvents = !canTrackPlay ? 'none' : '';
            this.pbNextBtn.style.cursor = !canTrackPlay ? 'not-allowed' : 'pointer';
        }

        if (this.callbacks.onPlayButtonStateChange) {
            this.callbacks.onPlayButtonStateChange(this._hasTrack, this._isPlaying, this._isPlaybackLocked, this._lockedText);
        }
    }

    _formatTime(sec) {
        if (!Number.isFinite(sec) || sec < 0) sec = 0;
        const m = Math.floor(sec / 60);
        const s = Math.floor(sec % 60);
        return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
    }

    updatePlayback(currentTime, duration, isPlaying, trackName, hasTrackExplicit) {
        this._isPlaying = Boolean(isPlaying);
        const hasTrack = hasTrackExplicit !== undefined
            ? Boolean(hasTrackExplicit)
            : Boolean((duration > 0 || (trackName && trackName !== 'Aucun fichier chargé')) && this._currentTrack);
        if (hasTrack !== this._hasTrack) {
            this._hasTrack = hasTrack;
            this._updatePlayButtonState();
        }
        this._duration = hasTrack ? (duration || 0) : 0;
        if (!this._isUserScrubbing) {
            this._currentTime = hasTrack ? (currentTime || 0) : 0;
            if (this.pbSlider) {
                this.pbSlider.max = this._duration > 0 ? this._duration : 100;
                this.pbSlider.value = this._currentTime;
            }
            if (this.pbTimeCurrent) this.pbTimeCurrent.textContent = this._formatTime(this._currentTime);
            if (this.pbTimeTotal) this.pbTimeTotal.textContent = this._formatTime(this._duration);
            this._drawWaveform();
        }
        if (this.pbTrackTitle && !this._isPlaybackLocked) {
            const expectedText = (this._isPlaying && this._hasTrack && trackName && trackName !== 'Aucun fichier chargé') ? trackName : '';
            if (this.pbTrackTitle.textContent !== expectedText) {
                this.pbTrackTitle.textContent = expectedText;
            }
        }
        if (this._hasTrack && !this._isPlaybackLocked) {
            const pbPlayText = this._isPlaying ? '⏸' : '▶';
            if (this.pbPlayBtn && this.pbPlayBtn.textContent !== pbPlayText) {
                this.pbPlayBtn.textContent = pbPlayText;
            }
        }
    }

    setAudioBuffer(audioBuffer) {
        if (!audioBuffer) {
            this._currentAudioBuffer = null;
            this._currentPeaks = null;
            this._drawWaveform();
            return;
        }
        this._currentAudioBuffer = audioBuffer;
        if (this._peaksCache.has(audioBuffer)) {
            this._currentPeaks = this._peaksCache.get(audioBuffer);
        } else {
            const peaks = this._extractPeaks(audioBuffer);
            this._peaksCache.set(audioBuffer, peaks);
            this._currentPeaks = peaks;
        }
        this._drawWaveform();
    }

    _generateDefaultPeaks(num = 300) {
        const peaks = new Float32Array(num);
        for (let i = 0; i < num; i++) {
            const env = Math.sin((i / num) * Math.PI);
            const wave = Math.sin(i * 0.18) * 0.25 + Math.cos(i * 0.07) * 0.25 + 0.5;
            peaks[i] = Math.max(0.08, Math.min(0.85, env * wave * 0.8 + 0.1));
        }
        return peaks;
    }

    _extractPeaks(buffer, numSamples = 400) {
        if (!buffer || !buffer.length) return this._defaultPeaks;
        const totalSamples = buffer.length;
        const numChannels = buffer.numberOfChannels;
        const ch0 = buffer.getChannelData(0);
        const ch1 = numChannels > 1 ? buffer.getChannelData(1) : null;

        const samplesPerBar = Math.floor(totalSamples / numSamples);
        const peaks = new Float32Array(numSamples);
        let max = 0.001;
        const step = Math.max(1, Math.floor(samplesPerBar / 35));

        for (let i = 0; i < numSamples; i++) {
            const start = i * samplesPerBar;
            const end = Math.min(start + samplesPerBar, totalSamples);
            let peak = 0;
            for (let j = start; j < end; j += step) {
                const val0 = Math.abs(ch0[j]);
                if (val0 > peak) peak = val0;
                if (ch1) {
                    const val1 = Math.abs(ch1[j]);
                    if (val1 > peak) peak = val1;
                }
            }
            peaks[i] = peak;
            if (peak > max) max = peak;
        }

        for (let i = 0; i < numSamples; i++) {
            peaks[i] = Math.max(0.06, Math.min(1.0, peaks[i] / max));
        }
        return peaks;
    }

    _drawWaveform() {
        if (!this.pbWaveformCanvas || !this._wfCtx || !this.pbWaveformWrap) return;
        const rect = this.pbWaveformWrap.getBoundingClientRect();
        const W = rect.width;
        const H = rect.height;
        if (W <= 0 || H <= 0) return;

        const dpr = window.devicePixelRatio || 1;
        const targetW = Math.round(W * dpr);
        const targetH = Math.round(H * dpr);
        if (this.pbWaveformCanvas.width !== targetW || this.pbWaveformCanvas.height !== targetH) {
            this.pbWaveformCanvas.width = targetW;
            this.pbWaveformCanvas.height = targetH;
        }

        const ctx = this._wfCtx;
        ctx.resetTransform ? ctx.resetTransform() : ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, W, H);

        if (!this._hasTrack) {
            if (this.pbWaveformPlayhead) this.pbWaveformPlayhead.style.display = 'none';
            if (this.pbWaveformHoverLine) this.pbWaveformHoverLine.classList.add('hidden');
            if (this.pbWaveformHoverTime) this.pbWaveformHoverTime.classList.add('hidden');
            return;
        }

        const peaks = this._currentPeaks || this._defaultPeaks;
        const barWidth = 2;
        const gap = 1.5;
        const pitch = barWidth + gap;
        const numBars = Math.floor((W + gap) / pitch);
        if (numBars <= 0) return;

        const baselineY = Math.floor(H * 0.70);
        const progress = (this._hasTrack && this._duration > 0)
            ? Math.max(0, Math.min(1, this._currentTime / this._duration))
            : 0;
        const hoverRatio = this._hoverWaveformRatio;

        if (this.pbWaveformPlayhead) {
            if (this._hasTrack && this._duration > 0) {
                this.pbWaveformPlayhead.style.display = 'block';
                this.pbWaveformPlayhead.style.left = `${(progress * 100).toFixed(2)}%`;
            } else {
                this.pbWaveformPlayhead.style.display = 'none';
            }
        }

        if (hoverRatio >= 0) {
            const pct = `${(hoverRatio * 100).toFixed(2)}%`;
            if (this.pbWaveformHoverLine && !this.pbWaveformHoverLine.classList.contains('hidden')) {
                this.pbWaveformHoverLine.style.left = pct;
            }
            if (this.pbWaveformHoverTime && !this.pbWaveformHoverTime.classList.contains('hidden')) {
                this.pbWaveformHoverTime.style.left = pct;
                const hoverTime = hoverRatio * (this._duration || 0);
                this.pbWaveformHoverTime.textContent = this._formatTime(hoverTime);
            }
        }

        const hasRound = typeof ctx.roundRect === 'function';

        for (let b = 0; b < numBars; b++) {
            const x = b * pitch;
            const pIdx = Math.floor((b / numBars) * peaks.length);
            const peak = peaks[pIdx] || 0.08;
            const barProgress = (x + barWidth / 2) / W;
            const isPlayed = this._hasTrack && (barProgress <= progress);
            const isHoverPreview = hoverRatio >= 0 && !isPlayed && (barProgress <= hoverRatio);

            const maxUpperH = baselineY - 2;
            const upperH = Math.max(2, peak * maxUpperH);
            const upperY = baselineY - upperH;

            const maxLowerH = (H - baselineY - 2) * 0.75;
            const lowerH = Math.max(1, peak * maxLowerH);
            const lowerY = baselineY + 1.5;

            let upperFill = 'rgba(255, 255, 255, 0.30)';
            let lowerFill = 'rgba(255, 255, 255, 0.14)';

            if (isPlayed) {
                upperFill = '#ff5500';
                lowerFill = '#cc4400';
            } else if (isHoverPreview) {
                upperFill = 'rgba(255, 125, 45, 0.75)';
                lowerFill = 'rgba(204, 68, 0, 0.45)';
            }

            ctx.fillStyle = upperFill;
            if (hasRound) {
                ctx.beginPath();
                ctx.roundRect(x, upperY, barWidth, upperH, [1, 1, 0, 0]);
                ctx.fill();
            } else {
                ctx.fillRect(x, upperY, barWidth, upperH);
            }

            ctx.fillStyle = lowerFill;
            if (hasRound) {
                ctx.beginPath();
                ctx.roundRect(x, lowerY, barWidth, lowerH, [0, 0, 1, 1]);
                ctx.fill();
            } else {
                ctx.fillRect(x, lowerY, barWidth, lowerH);
            }
        }
    }

    _setSplitRatio(ratio) {
        const clamped = Math.max(0.12, Math.min(0.88, ratio));
        this._splitRatio = clamped;
        if (this.pbListsSplit) {
            this.pbListsSplit.style.setProperty('--pl-flex', clamped.toFixed(4));
            this.pbListsSplit.style.setProperty('--q-flex', (1 - clamped).toFixed(4));
        }
    }

    _updateListsLayout() {
        const plOpen = !this._isPlCollapsed;
        const qOpen = !this._isQueueCollapsed;

        if (this.pbSplitResizer) {
            this.pbSplitResizer.style.display = (plOpen && qOpen) ? 'flex' : 'none';
        }
        if (this.pbListsSplit) {
            this.pbListsSplit.classList.toggle('no-split', !(plOpen && qOpen));
        }

        if (!this.playbackBarWrap) return;

        if (!plOpen && !qOpen) {
            this.setPlaybackCompact(true, true);
        } else {
            let savedCompact = false;
            try {
                savedCompact = localStorage.getItem('soundstage3d:playback-compact') === 'true';
            } catch (_) {}
            if (!savedCompact && this.playbackBarWrap.classList.contains('pb-compact')) {
                this.setPlaybackCompact(false, true);
            }
        }
    }

    setPlaybackCompact(isCompact, saveToStorage = true) {
        if (!this.playbackBarWrap) return;
        if (isCompact) {
            const curH = this.playbackBarWrap.offsetHeight;
            if (curH >= 240) {
                this._savedPlaybackHeight = curH;
            }
            this.playbackBarWrap.classList.add('pb-compact');
            this.playbackBarWrap.style.height = 'auto';
            if (this.pbCollapseBtn) {
                this.pbCollapseBtn.textContent = '▴';
                this.pbCollapseBtn.title = "Agrandir la fenêtre (afficher la playlist et la file d'attente)";
            }
        } else {
            this.playbackBarWrap.classList.remove('pb-compact');
            const restoreH = Math.max(320, this._savedPlaybackHeight || 480);
            this.playbackBarWrap.style.height = `${restoreH}px`;
            const minW = this._getPlaybackMinWidth();
            if (this.playbackBarWrap.offsetWidth < minW) {
                this.playbackBarWrap.style.width = `${minW}px`;
            }
            if (this.pbCollapseBtn) {
                this.pbCollapseBtn.textContent = '▾';
                this.pbCollapseBtn.title = "Réduire la fenêtre (masquer la playlist et la file d'attente)";
            }
        }
        this._drawWaveform();
        if (saveToStorage) {
            try {
                localStorage.setItem('soundstage3d:playback-compact', isCompact ? 'true' : 'false');
                const finalRect = this.playbackBarWrap.getBoundingClientRect();
                const saveH = isCompact ? 145 : Math.max(320, this._savedPlaybackHeight || finalRect.height || 480);
                localStorage.setItem('soundstage3d:win-size:playback', JSON.stringify({
                    width: Math.max(this._getPlaybackMinWidth(), finalRect.width || 680),
                    height: saveH
                }));
            } catch (_) {}
        }
    }

    _getPlaybackMinHeight() {
        return 145;
    }

    _getPlaybackMinWidth() {
        const isCompact = this.playbackBarWrap && this.playbackBarWrap.classList.contains('pb-compact');
        if (isCompact) {
            return 320;
        }
        const plOpen = !this._isPlCollapsed;
        const qOpen = !this._isQueueCollapsed;
        if (plOpen && qOpen) {
            return 500;
        }
        if (plOpen || qOpen) {
            return 380;
        }
        return 320;
    }

    setShuffleState(isShuffle) {
        this._isShuffle = !!isShuffle;
        if (this.pbShuffleBtn) {
            this.pbShuffleBtn.classList.toggle('active', this._isShuffle);
            this.pbShuffleBtn.title = this._isShuffle ? 'Lecture aléatoire activée' : 'Lecture aléatoire désactivée';
        }
    }
}
