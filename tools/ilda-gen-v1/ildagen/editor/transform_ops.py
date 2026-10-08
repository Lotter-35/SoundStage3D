"""Transformations depuis la mire : appliquer une transformation « monde » à des calques.

Les outils travaillent dans le repère de la racine (la mire). Chaque calque garde sa transformation
dans le repère de son parent : on convertit avec la matrice des groupes parents.
"""

import numpy as np

from ..core import mathutil as mu
from ..core.evaluator import node_transform
from ..core.path import Path
from ..core.transform import TRANSFORM_KEYS


# Ordre de grandeur de chaque réglage (pour comparer leurs variations)
KEY_SCALE = {"rot": 180.0, "tilt_x": 90.0, "tilt_y": 90.0}


class TransformOpsMixin:
    def parent_matrix(self, node, ctx):
        """Matrice affine parent → racine (sans les inclinaisons 3D)."""
        m = np.eye(3)
        for a in node.ancestors():
            if a.parent is None:
                break
            if a.has_transform:
                m = node_transform(a, ctx).affine() @ m
        return m

    def effective_transform(self, node, ctx=None):
        ctx = ctx or self.eval_context()
        return node_transform(node, ctx).copy()

    def write_transform(self, node, tf):
        """Écrit une transformation : seules les valeurs qui changent passent par set_param (automations)."""
        cur = self.effective_transform(node)
        changed = False
        diffs = []
        for k in TRANSFORM_KEYS:
            d = abs(getattr(tf, k) - getattr(cur, k))
            if d > 1e-9:
                diffs.append((d / KEY_SCALE.get(k, 1.0), k))
        # Le réglage qui change le plus passe en premier : c'est lui qu'une automation en attente prendra
        for _, k in sorted(diffs, reverse=True):
            self._set_param_quiet(node, "tf." + k, getattr(tf, k))
            changed = True
        if (tf.px, tf.py) != (node.transform.px, node.transform.py):
            node.transform.px, node.transform.py = tf.px, tf.py
            changed = True
        if changed:
            self._touch()
            self.docChanged.emit()

    def _set_param_quiet(self, node, key, value):
        blocker = self.signalsBlocked()
        self.blockSignals(True)
        try:
            self.set_param(node, key, value)
        finally:
            self.blockSignals(blocker)
        if self.current_clip() is not None:
            self.timelineChanged.emit()

    def apply_world_matrix(self, node, base_tf, world_m, ctx):
        """Nouvelle transformation de node = (monde) world_m appliquée à son état de départ base_tf."""
        p = self.parent_matrix(node, ctx)
        try:
            pinv = np.linalg.inv(p)
        except np.linalg.LinAlgError:
            return
        tf = base_tf.copy()
        tf.set_affine(pinv @ world_m @ p @ base_tf.affine())
        tf.tilt_x, tf.tilt_y = base_tf.tilt_x, base_tf.tilt_y
        self.write_transform(node, tf)

    def world_pivot(self, node, ctx):
        tf = node_transform(node, ctx)
        wx, wy = tf.world_pivot()
        return mu.apply_point(self.parent_matrix(node, ctx), wx, wy)

    def set_world_pivot(self, node, wx, wy, ctx):
        p = self.parent_matrix(node, ctx)
        qx, qy = mu.apply_point(np.linalg.inv(p), wx, wy)
        tf = node.transform
        lin = tf.linear()[:2, :2]
        try:
            d = np.linalg.solve(lin, np.array([qx - tf.tx - tf.px, qy - tf.ty - tf.py]))
        except np.linalg.LinAlgError:
            return
        tf.set_pivot(tf.px + float(d[0]), tf.py + float(d[1]))
        self._touch()
        self.docChanged.emit()

    def flip_selection(self, horizontal):
        """Retourne la sélection autour de son centre (horizontalement ou verticalement)."""
        from ..core.evaluator import node_quad
        ctx = self.eval_context()
        nodes = [n for n in self.top_selected() if n.kind != "modifier" and not (n.locked and n.kind != "group")]
        quads = [q for q in (node_quad(n, ctx) for n in nodes) if q is not None]
        if not quads:
            return
        a = np.vstack(quads)
        cx, cy = (a[:, 0].min() + a[:, 0].max()) / 2, (a[:, 1].min() + a[:, 1].max()) / 2
        w = mu.about(mu.scaling(-1.0, 1.0) if horizontal else mu.scaling(1.0, -1.0), cx, cy)
        self.begin_action("Retourner")
        for n in nodes:
            self.apply_world_matrix(n, self.effective_transform(n, ctx), w, ctx)
        self.commit()
        self.notify()

    def bake_homography(self, node, base_tf, base_paths, h_world, ctx):
        """Déformation libre / perspective d'une forme : la géométrie est recalculée (comme Photoshop)."""
        if node.kind != "shape":
            return
        p = self.parent_matrix(node, ctx)
        pinv = np.linalg.inv(p)
        new_paths = []
        for path in base_paths:
            w = mu.apply(p, base_tf.apply(path.pts))
            w = mu.apply(h_world, w)
            new_paths.append(Path(mu.apply(pinv, w), path.closed))
        node.bake(new_paths)
        node.transform = type(node.transform)()
        node.center_pivot()
        self._touch()
        self.docChanged.emit()
