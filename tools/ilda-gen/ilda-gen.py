"""
ilda-gen.py — Générateur IDN direct pour les lasers de SoundStage3D (entrée « ILDA live »).

Point d'entrée modulaire de l'application ILDA Generator Studio.
"""

import os
import sys
import tkinter as tk

# S'assurer que le dossier contenant ilda-gen est dans sys.path pour les sous-modules
CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
if CURRENT_DIR not in sys.path:
    sys.path.insert(0, CURRENT_DIR)

try:
    from .core import (
        ILDA_MIN,
        ILDA_MAX,
        CANVAS_SIZE,
        MAX_PAYLOAD,
        LIVE_REFRESH_MS,
        CMD_RT_CNLMSG,
        CHUNK_FRAME,
        CHUNK_FRAME_FIRST,
        CHUNK_FRAME_SEQUEL,
        CONTENT_CHANNEL_MSG,
        CONTENT_CONFIG_OR_LAST,
        SERVICE_MODE_FRAMES,
        CONFIG_ROUTING,
        IDN_LAYOUT_TAGS,
        IDN_SCWC,
        SAMPLE,
        LINE_STEP,
        CORNER_POINTS,
        BLANK_POINTS,
        CORNER_ANGLE,
        norm_to_canvas,
        canvas_to_norm,
        dist_pt_seg,
        prepare_stroke,
        is_corner,
        Transform2D,
        Layer,
        TimelineClip,
        TimelineTrack,
        TimelineModel,
        create_square_shape,
        create_triangle_shape,
        create_star_shape,
        load_user_custom_shapes,
        save_user_custom_shapes,
        instantiate_custom_template,
        SYM_MODES_MAPPING,
        get_sym_mode_info,
        compute_symmetry,
        snap_polar,
    )
    from .app import IDNGeneratorApp
except (ImportError, ValueError):
    from core import (
        ILDA_MIN,
        ILDA_MAX,
        CANVAS_SIZE,
        MAX_PAYLOAD,
        LIVE_REFRESH_MS,
        CMD_RT_CNLMSG,
        CHUNK_FRAME,
        CHUNK_FRAME_FIRST,
        CHUNK_FRAME_SEQUEL,
        CONTENT_CHANNEL_MSG,
        CONTENT_CONFIG_OR_LAST,
        SERVICE_MODE_FRAMES,
        CONFIG_ROUTING,
        IDN_LAYOUT_TAGS,
        IDN_SCWC,
        SAMPLE,
        LINE_STEP,
        CORNER_POINTS,
        BLANK_POINTS,
        CORNER_ANGLE,
        norm_to_canvas,
        canvas_to_norm,
        dist_pt_seg,
        prepare_stroke,
        is_corner,
        Transform2D,
        Layer,
        TimelineClip,
        TimelineTrack,
        TimelineModel,
        create_square_shape,
        create_triangle_shape,
        create_star_shape,
        load_user_custom_shapes,
        save_user_custom_shapes,
        instantiate_custom_template,
        SYM_MODES_MAPPING,
        get_sym_mode_info,
        compute_symmetry,
        snap_polar,
    )
    from app import IDNGeneratorApp

__all__ = [
    "IDNGeneratorApp",
    "Layer",
    "Transform2D",
    "TimelineClip",
    "TimelineTrack",
    "TimelineModel",
    "create_square_shape",
    "create_triangle_shape",
    "create_star_shape",
    "load_user_custom_shapes",
    "save_user_custom_shapes",
    "instantiate_custom_template",
    "CANVAS_SIZE",
    "ILDA_MIN",
    "ILDA_MAX",
    "MAX_PAYLOAD",
    "LIVE_REFRESH_MS",
    "CMD_RT_CNLMSG",
    "CHUNK_FRAME",
    "CHUNK_FRAME_FIRST",
    "CHUNK_FRAME_SEQUEL",
    "CONTENT_CHANNEL_MSG",
    "CONTENT_CONFIG_OR_LAST",
    "SERVICE_MODE_FRAMES",
    "CONFIG_ROUTING",
    "IDN_LAYOUT_TAGS",
    "IDN_SCWC",
    "SAMPLE",
    "LINE_STEP",
    "CORNER_POINTS",
    "BLANK_POINTS",
    "CORNER_ANGLE",
    "norm_to_canvas",
    "canvas_to_norm",
    "dist_pt_seg",
    "prepare_stroke",
    "is_corner",
    "SYM_MODES_MAPPING",
    "get_sym_mode_info",
    "compute_symmetry",
    "snap_polar",
]


def main():
    root = tk.Tk()
    app = IDNGeneratorApp(root)

    # Ouvrir un fichier de projet si passé en argument CLI
    if len(sys.argv) > 1 and sys.argv[1].lower().endswith((".ildagen", ".json")):
        target = sys.argv[1]
        if os.path.exists(target):
            app.open_project(target)

    root.mainloop()


if __name__ == "__main__":
    main()
