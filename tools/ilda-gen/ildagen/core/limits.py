"""Garde-fous de l'évaluation : toute combinaison de réglages permise reste rapide (jamais de blocage).

Au-delà de ces limites, le résultat est simplifié (copies en moins, points plus espacés) : cela n'arrive
qu'avec des géométries démesurées (répétitions géantes, tirets minuscules sur des kilomètres de tracé…),
dont l'essentiel tombe de toute façon hors de la mire.
"""

MAX_STROKES = 2000          # tracés en sortie d'un modifieur de duplication (une image en montre bien moins)
MAX_COPY_POINTS = 400_000   # points en sortie d'un modifieur de duplication
MAX_RESAMPLE = 200_000      # points créés par un rééchantillonnage (couleurs, onde, masque)
MAX_PIECES = 8000           # tirets / points créés par un modifieur de tracé (une image n'en montre
                            # jamais autant : 20 000 points au plus, au moins 2 ou 3 par tiret)
