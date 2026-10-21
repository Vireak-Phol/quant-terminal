import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BRIDGE = os.path.dirname(HERE)
for p in (BRIDGE, HERE):
    if p not in sys.path:
        sys.path.insert(0, p)
