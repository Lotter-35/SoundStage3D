"""Lance ILDA Gen :  python tools/ilda-gen/ilda-gen.py  [projet.ildaproj]"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from ildagen.app import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
