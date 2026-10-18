# Analyse du banc d'exploration des lasers (LyreViz.exe --bench-explore) : d'ou vient le lag ?
#
#   python tools\explore_report.py bench\explore_t1 [bench\explore_t2 ...] [--stats bench\explore_s1] [--out rapport.md]
#
# - Plusieurs dossiers de mesure (memes cas) : temps moyennes.
# - --stats : un lancement avec --stats (compteurs : couples (pixel, segment), tuiles), joint par numero de cas.
# Sorties : tableaux du balayage (ecart a la base, reglage par reglage), programmations au hasard (part a 120 img/s,
# effet de chaque reglage, cas les plus lourds), cout par couple, importance des reglages (foret aleatoire).
import argparse
import csv
import math
import os
import sys

BUDGET = 1000.0 / 120.0

NUM = ["image_ms", "gpu_ms", "gpu_mediane_ms", "lasers_gpu_ms", "las_impacts", "las_tri", "las_arcs", "las_nappes",
       "las_sorties", "composition", "surfaces", "fumee_lyres", "reflet", "bloom", "image_finale", "autres_gpu", "cpu_ms",
       "cpu_laser_ms", "cpu_morceaux_ms", "cpu_impacts_ms", "attente_gpu_ms", "allumes", "segments", "traits", "impacts",
       "variante_fumee", "ilda_faisceaux", "ilda_droites", "ilda_arcs", "en_cache", "couples_M", "tuiles", "seg_par_tuile",
       "seg_par_tuile_max", "traits_total", "lasers_voulus", "ouverture", "diffraction", "tilt", "ecart_pan", "fumee"]
TIMES = ["image_ms", "gpu_ms", "gpu_mediane_ms", "lasers_gpu_ms", "las_impacts", "las_tri", "las_arcs", "las_nappes",
         "las_sorties", "composition", "surfaces", "fumee_lyres", "reflet", "bloom", "image_finale", "autres_gpu", "cpu_ms",
         "cpu_laser_ms", "cpu_morceaux_ms", "cpu_impacts_ms", "attente_gpu_ms"]


def read(path):
    rows = {}
    with open(os.path.join(path, "exploration.csv"), encoding="utf-8", newline="") as f:
        rd = csv.reader(f, delimiter=";")
        head = next(rd)
        # 2e colonne "traits" (anciens fichiers) : traits de toutes les figures
        seen = set()
        for i, h in enumerate(head):
            if h in seen:
                head[i] = h + "_total"
            seen.add(h)
        for vals in rd:
            r = dict(zip(head, vals))
            for k in NUM:
                if k in r and r[k] != "":
                    r[k] = float(r[k])
            r["cas"] = int(r["cas"])
            r["traits"] = int(float(r["traits"]))
            rows[r["cas"]] = r
    return rows


def merge(runs, stats):
    base = runs[0]
    out = []
    for k, r in sorted(base.items()):
        r = dict(r)
        vals = [run[k] for run in runs if k in run]
        for t in TIMES:
            r[t] = sum(v[t] for v in vals) / len(vals)
        r["n_runs"] = len(vals)
        r["spread"] = (max(v["gpu_ms"] for v in vals) - min(v["gpu_ms"] for v in vals)) if len(vals) > 1 else 0.0
        if stats and k in stats:
            for t in ["couples_M", "tuiles", "seg_par_tuile", "seg_par_tuile_max"]:
                r[t] = stats[k][t]
        out.append(r)
    return out


def f1(x):
    return "%.1f" % x


def f2(x):
    return "%.2f" % x


def fps(ms):
    return "%.0f" % (1000.0 / ms) if ms > 0 else "-"


def table(lines, head, rows):
    lines.append("| " + " | ".join(head) + " |")
    lines.append("|" + "---|" * len(head))
    for r in rows:
        lines.append("| " + " | ".join(str(c) for c in r) + " |")
    lines.append("")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dirs", nargs="+")
    ap.add_argument("--stats", default="")
    ap.add_argument("--out", default="")
    a = ap.parse_args()
    runs = [read(d) for d in a.dirs]
    stats = read(a.stats) if a.stats else None
    rows = merge(runs, stats)
    L = []
    L.append("# Banc d'exploration des lasers : resultats")
    L.append("")
    L.append("Mesures : " + ", ".join(a.dirs) + (" ; compteurs : " + a.stats if a.stats else "") + ". GPU = moyenne par image (ms) ; "
             "lasers = somme des passes laser (impacts, tri, arcs, nappes, sorties). Budget 120 img/s : %.2f ms." % BUDGET)
    L.append("")

    # ---- base et derive ----
    bases = [r for r in rows if r["famille"] == "base"]
    if bases:
        g = [b["gpu_ms"] for b in bases]
        l = [b["lasers_gpu_ms"] for b in bases]
        L.append("## Base (50 lasers repartis, eventails 1 000 traits, 40 deg, vague pan, vue du public)")
        L.append("")
        L.append("Repetee %d fois au fil du banc : GPU %s a %s ms, lasers %s a %s ms (derive / bruit de mesure)." % (
            len(bases), f2(min(g)), f2(max(g)), f2(min(l)), f2(max(l))))
        L.append("")

    def base_near(i):
        # base la plus proche dans l'ordre du banc (derive)
        best = None
        for b in bases:
            if best is None or abs(b["cas"] - i) < abs(best["cas"] - i):
                best = b
        return best

    # ---- balayage ----
    sweep = [r for r in rows if r["famille"] == "balayage"]
    if sweep:
        L.append("## Balayage : un reglage change a la fois (ecart a la base la plus proche)")
        L.append("")
        head = ["Reglage", "Valeur", "Image (ms)", "img/s", "GPU (ms)", "Lasers GPU (ms)", "Ecart lasers", "Arcs", "Nappes",
                "Impacts", "Tri", "Moteur CPU (ms)", "Segments", "Couples (M)"]
        out = []
        for r in sweep:
            b = base_near(r["cas"])
            d = r["lasers_gpu_ms"] - b["lasers_gpu_ms"]
            out.append([r["facteur"], r["niveau"], f1(r["image_ms"]), fps(r["image_ms"]), f2(r["gpu_ms"]), f2(r["lasers_gpu_ms"]),
                        ("%+.2f" % d), f2(r["las_arcs"]), f2(r["las_nappes"]), f2(r["las_impacts"]), f2(r["las_tri"]),
                        f2(r["cpu_laser_ms"]), "%d" % r["segments"],
                        (f1(r["couples_M"]) if r.get("couples_M", -1) >= 0 else "-")])
        b0 = bases[0]
        out.insert(0, ["(base)", "", f1(b0["image_ms"]), fps(b0["image_ms"]), f2(b0["gpu_ms"]), f2(b0["lasers_gpu_ms"]), "0",
                       f2(b0["las_arcs"]), f2(b0["las_nappes"]), f2(b0["las_impacts"]), f2(b0["las_tri"]), f2(b0["cpu_laser_ms"]),
                       "%d" % b0["segments"], (f1(b0["couples_M"]) if b0.get("couples_M", -1) >= 0 else "-")])
        table(L, head, out)

    # ---- hasard ----
    rnd = [r for r in rows if r["famille"] == "hasard"]
    if rnd:
        ok = [r for r in rnd if r["image_ms"] <= BUDGET]
        L.append("## Programmations au hasard (%d cas)" % len(rnd))
        L.append("")
        L.append("- A 120 img/s ou plus : %d cas sur %d (%.0f %%)." % (len(ok), len(rnd), 100.0 * len(ok) / len(rnd)))
        cpu_bound = [r for r in rnd if r["cpu_ms"] > r["gpu_ms"] * 0.95]
        L.append("- Limites par le CPU (CPU >= GPU) : %d cas." % len(cpu_bound))
        L.append("")

        def by(key, label, fmtv=str):
            groups = {}
            for r in rnd:
                groups.setdefault(r[key], []).append(r)
            res = []
            for k in sorted(groups, key=lambda x: (isinstance(x, str), x)):
                g = groups[k]
                med = sorted(x["lasers_gpu_ms"] for x in g)[len(g) // 2]
                img = sorted(x["image_ms"] for x in g)[len(g) // 2]
                share = sum(1 for x in g if x["image_ms"] <= BUDGET) / len(g)
                res.append([fmtv(k), len(g), f2(med), f1(img), "%.0f %%" % (100 * share)])
            L.append("### Selon : " + label)
            L.append("")
            table(L, [label, "Cas", "Lasers GPU (mediane, ms)", "Image (mediane, ms)", "A 120 img/s"], res)

        by("lasers_voulus", "lasers allumes", lambda x: "%d" % x)
        by("emplacement", "emplacement")
        rc = []
        for r in rnd:
            c = r["contenu"]
            r["contenu_g"] = "ILDA" if c.startswith("ILDA") else c
            t = r["traits"]
            r["traits_g"] = ("(sans objet)" if c.startswith("ILDA") or c == "melange" else
                             "0 (nappe continue)" if t == 0 else "1 (trait seul)" if t == 1 else
                             "2 a 16 (traits separes)" if t <= 16 else "17 a 100" if t <= 100 else "plus de 100")
            r["copies"] = r["allumes"] * r["diffraction"]
        by("contenu_g", "contenu")
        by("vue", "vue")
        by("traits_g", "traits par figure")
        by("diffraction", "diffraction", lambda x: "%d" % x)
        by("mouvement", "mouvement")

        # cout par laser allume
        L.append("### Cout par laser allume (lasers GPU / lasers allumes)")
        L.append("")
        groups = {}
        for r in rnd:
            if r["allumes"] > 0:
                groups.setdefault(r["contenu_g"], []).append(r["lasers_gpu_ms"] / r["allumes"])
        table(L, ["Contenu", "Cas", "ms par laser (mediane)", "max"],
              [[k, len(v), "%.3f" % sorted(v)[len(v) // 2], "%.3f" % max(v)] for k, v in sorted(groups.items())])

        # les plus lourds
        L.append("### Les 25 cas les plus lourds")
        L.append("")
        heavy = sorted(rnd, key=lambda r: -r["image_ms"])[:25]
        table(L, ["Cas", "Image (ms)", "Lasers GPU", "Arcs", "Nappes", "Impacts", "CPU laser", "Lasers", "Emplacement", "Contenu",
                  "Traits", "Ouv.", "Diffr.", "Vue", "Reglages", "Couples (M)"],
              [[r["cas"], f1(r["image_ms"]), f2(r["lasers_gpu_ms"]), f2(r["las_arcs"]), f2(r["las_nappes"]), f2(r["las_impacts"]),
                f2(r["cpu_laser_ms"]), "%d" % r["allumes"], r["emplacement"], r["contenu"], r["traits"], "%.0f" % r["ouverture"],
                "%d" % r["diffraction"], r["vue"], r["reglages"], (f1(r["couples_M"]) if r.get("couples_M", -1) >= 0 else "-")]
               for r in heavy])

    # ---- cout par couple ----
    allr = [r for r in rows if r.get("couples_M", -1) > 0 and r["lasers_gpu_ms"] > 0]
    if allr:
        L.append("## Cout par couple (pixel, segment)")
        L.append("")
        pl = [r for r in allr if r["las_arcs"] < 0.05 * r["lasers_gpu_ms"]]
        ar = [r for r in allr if r["las_arcs"] > 0.5 * r["lasers_gpu_ms"]]

        def ps(g, key):
            v = sorted(1000.0 * r[key] / r["couples_M"] for r in g)
            return "%.0f ps (%d cas, de %.0f a %.0f)" % (v[len(v) // 2], len(v), v[len(v) // 10], v[len(v) * 9 // 10]) if v else "-"

        L.append("- Nappes planes et traits (sans arcs) : %s par couple pour les passes laser." % ps(pl, "lasers_gpu_ms"))
        L.append("- Cas surtout en arcs (passe des arcs > 50 %%) : %s." % ps(ar, "lasers_gpu_ms"))
        L.append("")
        try:
            import numpy as np
            X = np.array([[r["couples_M"], r["segments"] / 1000.0, 1.0] for r in allr])
            y = np.array([r["lasers_gpu_ms"] for r in allr])
            c, *_ = np.linalg.lstsq(X, y, rcond=None)
            pred = X @ c
            r2 = 1 - ((y - pred) ** 2).sum() / ((y - y.mean()) ** 2).sum()
            L.append("- Modele lineaire : lasers GPU = %.4f ms par million de couples + %.3f ms par millier de segments + %.2f ms "
                     "(R2 = %.2f)." % (c[0], c[1], c[2], r2))
            L.append("")
        except Exception as e:
            L.append("(numpy indisponible : %s)" % e)

    # ---- importance des reglages (foret aleatoire sur les programmations au hasard) ----
    if rnd and len(rnd) >= 30:
        try:
            import numpy as np
            from sklearn.ensemble import RandomForestRegressor
            from sklearn.inspection import permutation_importance
            feats = {}

            def add(name, fn):
                feats[name] = [fn(r) for r in rnd]

            add("lasers allumes (log)", lambda r: math.log2(max(r["allumes"], 1)))
            add("copies = lasers x diffraction (log)", lambda r: math.log2(max(r["copies"], 1)))
            add("ouverture", lambda r: r["ouverture"])
            for v in sorted(set(r["traits_g"] for r in rnd)):
                add("traits " + v, lambda r, v=v: 1.0 if r["traits_g"] == v else 0.0)
            add("diffraction", lambda r: r["diffraction"])
            add("visee (tilt)", lambda r: r["tilt"])
            add("ecart en pan", lambda r: r["ecart_pan"])
            add("fumee", lambda r: r["fumee"])
            for v in sorted(set(r["vue"] for r in rnd)):
                add("vue " + v, lambda r, v=v: 1.0 if r["vue"] == v else 0.0)
            for v in sorted(set(r["emplacement"] for r in rnd)):
                add("empl. " + v, lambda r, v=v: 1.0 if r["emplacement"] == v else 0.0)
            for v in sorted(set(r["contenu_g"] for r in rnd)):
                add("contenu " + v, lambda r, v=v: 1.0 if r["contenu_g"] == v else 0.0)
            for v in sorted(set(r["mouvement"] for r in rnd)):
                add("mvt " + v, lambda r, v=v: 1.0 if r["mouvement"] == v else 0.0)
            add("degrade", lambda r: 0.0 if r["degrade"] == "Uni" else 1.0)
            for k in ["volutes=0", "volfine=0", "laserfog=0", "laserimpacts=0", "laserexit=0", "lasercoll=0", "lasercache=0"]:
                add(k, lambda r, k=k: 1.0 if k in r["reglages"].split() else 0.0)
            add("laserwidth", lambda r: next((float(s.split("=")[1]) for s in r["reglages"].split() if s.startswith("laserwidth=")), 0.6))
            add("wet", lambda r: next((float(s.split("=")[1]) for s in r["reglages"].split() if s.startswith("wet=")), 0.0))
            names = list(feats)
            X = np.array([feats[n] for n in names]).T
            y = np.log(np.array([max(r["lasers_gpu_ms"], 0.02) for r in rnd]))
            rf = RandomForestRegressor(n_estimators=500, min_samples_leaf=2, random_state=0, oob_score=True)
            rf.fit(X, y)
            pi = permutation_importance(rf, X, y, n_repeats=20, random_state=0)
            order = np.argsort(-pi.importances_mean)
            L.append("## Importance des reglages (foret aleatoire, log du temps des lasers, programmations au hasard)")
            L.append("")
            L.append("Score hors sac R2 = %.2f. Importance : baisse du R2 quand on melange ce reglage." % rf.oob_score_)
            L.append("")
            table(L, ["Reglage", "Importance"], [[names[i], "%.3f" % pi.importances_mean[i]] for i in order[:20]])
        except Exception as e:
            L.append("(sklearn indisponible : %s)" % e)
            L.append("")

    text = "\n".join(L) + "\n"
    if a.out:
        with open(a.out, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        print("ecrit :", a.out)
    else:
        sys.stdout.reconfigure(encoding="utf-8")
        print(text)


if __name__ == "__main__":
    main()
