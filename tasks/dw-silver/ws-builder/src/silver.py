#!/usr/bin/env python
"""Silver layer — see the specification. Derive data/silver/ from data/bronze/."""
from __future__ import annotations

import argparse
import sys

sys.path.insert(0, "contract")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bronze", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--states", nargs="*", default=["tx", "nm", "ok"])
    a = ap.parse_args()
    raise NotImplementedError("silver transform not implemented")


if __name__ == "__main__":
    sys.exit(main())
