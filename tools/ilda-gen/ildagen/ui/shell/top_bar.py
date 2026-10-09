"""Barre du haut : menus (dans la fenêtre, aussi sur Mac) · onglets Forme / Show / Live au centre ·
connexion, Live, BLACKOUT et Maîtres à droite. Pas de logo."""

import time

from PySide6.QtCore import QSize, Qt
from PySide6.QtGui import QPainter
from PySide6.QtWidgets import QHBoxLayout, QMenuBar, QWidget

from ...core.document import WORKSPACES
from .. import theme
from ..widgets import Segmented, TopBarButton
from .connection_popup import ConnectionPopup
from .masters_popup import MastersPopup

SPACE_LABELS = (("Forme", "⌘1"), ("Show", "⌘2"), ("Live", "⌘3"))


class StatusDot(QWidget):
    """Pastille de connexion : verte = le serveur répond."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.on = False
        self.setFixedSize(QSize(10, 10))
        self.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents)

    def set_on(self, on):
        self.on = on
        self.update()

    def paintEvent(self, _e):
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(theme.qc(theme.LIVE if self.on else theme.TEXT_OFF))
        p.drawEllipse(1, 1, 8, 8)


class TopBar(QWidget):
    def __init__(self, editor, live, parent=None):
        super().__init__(parent)
        self.editor = editor
        self.live = live
        self.settings = editor.settings
        self.setObjectName("topbar")
        self.setAttribute(Qt.WidgetAttribute.WA_StyledBackground)
        self.setFixedHeight(38)
        lay = QHBoxLayout(self)
        lay.setContentsMargins(4, 0, 6, 0)
        lay.setSpacing(6)

        self.menu_bar = QMenuBar()
        self.menu_bar.setNativeMenuBar(False)       # les menus restent dans la fenêtre, aussi sur Mac
        lay.addWidget(self.menu_bar)
        lay.addStretch(1)

        # Onglets des espaces : centrés sur la fenêtre (placés à la main dans resizeEvent)
        self.spaces = Segmented(SPACE_LABELS, WORKSPACES.index(editor.workspace), large=True, parent=self)
        self.spaces.setToolTip("Espace de travail")
        self.spaces.set_tooltips(["Forme : dessiner et régler la forme, sans le temps (⌘1)",
                                  "Show : la timeline calée sur la musique, effets d'animation sur les clips (⌘2)",
                                  "Live : jouer les formes en direct depuis la grille de cues (⌘3)"])
        self.spaces.currentChanged.connect(lambda i: editor.set_workspace(WORKSPACES[i]))
        editor.workspaceChanged.connect(self._workspace)

        # Droite : connexion (ouvre ses réglages), Live, BLACKOUT, Maîtres
        self.dot = StatusDot()
        lay.addWidget(self.dot)
        self.btn_conn = TopBarButton("", None, "plain")
        self.btn_conn.setToolTip("Connexion au serveur SoundStage3D (adresse, port, canal, cadence)")
        self.btn_conn.clicked.connect(self._open_connection)
        lay.addWidget(self.btn_conn)

        self.btn_live = TopBarButton("Live", "radio", "live", checkable=True)
        self.btn_live.setToolTip("Envoyer au laser ce que montre l'espace actif")
        self.btn_live.toggled.connect(live.set_live)
        lay.addWidget(self.btn_live)

        self.btn_black = TopBarButton("BLACKOUT", None, "danger", checkable=True)
        self.btn_black.setToolTip("Arrêt d'urgence : coupe immédiatement la sortie laser (cliquer à nouveau pour réarmer)")
        self.btn_black.toggled.connect(live.set_blackout)
        lay.addWidget(self.btn_black)

        self.btn_masters = TopBarButton("Maîtres", "sliders-vertical", "normal", checkable=True)
        self.btn_masters.setToolTip("Maîtres : lumière, taille, vitesse, position, rotation et couleur de toute la sortie")
        self.btn_masters.clicked.connect(self._toggle_masters)
        lay.addWidget(self.btn_masters)

        self.masters = MastersPopup(editor, self)
        self._masters_closed = 0.0
        self.masters.closed.connect(self._masters_hidden)
        self.connection = ConnectionPopup(self.settings, live, self)

        live.connectionChanged.connect(self._connection)
        live.liveChanged.connect(self._live_changed)
        live.blackoutChanged.connect(self._blackout_changed)
        editor.projectChanged.connect(self.masters.refresh)
        self._connection(live.connected)

    # ── Onglets ──────────────────────────────────────────────────────────
    def _workspace(self, ws):
        self.spaces.set_current(WORKSPACES.index(ws))

    def resizeEvent(self, e):
        super().resizeEvent(e)
        self._place_spaces()

    def showEvent(self, e):
        super().showEvent(e)
        self._place_spaces()

    def _place_spaces(self):
        s = self.spaces.sizeHint()
        x = (self.width() - s.width()) // 2
        # Jamais par-dessus les menus (fenêtre étroite) : décalé vers la droite au besoin
        x = max(x, self.menu_bar.geometry().right() + 12)
        self.spaces.setGeometry(x, (self.height() - s.height()) // 2, s.width(), s.height())
        self.spaces.raise_()

    # ── Connexion ────────────────────────────────────────────────────────
    def _connection(self, ok):
        self.dot.set_on(ok)
        ch = self.settings.get("network", "channel")
        self.btn_conn.setText(f"SoundStage3D · canal {ch}" if ok else "Non connecté")

    def _open_connection(self):
        self.connection.reload()
        self.connection.show_under(self.btn_conn)

    def reload(self):
        """Réglages réseau changés ailleurs (projet ouvert, Paramètres)."""
        self.connection.reload()
        self._connection(self.live.connected)

    # ── Live / BLACKOUT / Maîtres ────────────────────────────────────────
    def _live_changed(self, on):
        self.btn_live.blockSignals(True)
        self.btn_live.setChecked(on)
        self.btn_live.blockSignals(False)

    def _blackout_changed(self, on):
        self.btn_black.blockSignals(True)
        self.btn_black.setChecked(on)
        self.btn_black.blockSignals(False)
        self.btn_live.setEnabled(not on)

    def _masters_hidden(self):
        self._masters_closed = time.monotonic()
        self.btn_masters.setChecked(False)

    def _toggle_masters(self, on):
        if on and time.monotonic() - self._masters_closed < 0.3:
            # Le clic sur le bouton a déjà fermé le panneau (clic à côté d'un panneau flottant) : il reste fermé
            self.btn_masters.setChecked(False)
            return
        if on:
            self.masters.refresh()
            self.masters.show_under(self.btn_masters)
        else:
            self.masters.hide()
