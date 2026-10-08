"""Lecture des projets d'avant la refonte (format v1 à v4, D12).

Les formes et les clips sont gardés ; les anciennes automations (dans les formes ou les clips) et les copies
cachées de formes (clips « déliés ») sont abandonnées : un clip délié reprend sa forme d'origine (ou garde
sa copie, devenue une forme normale, si l'origine n'existe plus). Les clips reçoivent ensuite des animations
vides, liées par forme (D5).
"""


def legacy_library(raw_lib, timeline_dict):
    """Renvoie (formes à lire, {ancienne forme des clips: forme à jouer}, des animations ont-elles été
    retirées ?)."""
    ids = {x.get("id") for x in raw_lib if not x.get("hidden")}
    dropped = False
    out, remap = [], {}
    for x in raw_lib:
        if x.get("automations"):
            dropped = True
        clean = {k: v for k, v in x.items() if k not in ("automations", "hidden", "source")}
        if x.get("hidden"):
            dropped = True
            if x.get("source") in ids:
                remap[x.get("id")] = x["source"]
                continue
        out.append(clean)
    tracks = timeline_dict.get("tracks") if isinstance(timeline_dict, dict) else None
    for tr in tracks if isinstance(tracks, list) else []:
        clips = tr.get("clips") if isinstance(tr, dict) else None
        for c in clips if isinstance(clips, list) else []:
            if isinstance(c, dict) and c.get("automations"):
                dropped = True
    return out, remap, dropped
