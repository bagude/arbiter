#!/usr/bin/env python
"""Bronze ingester — see the specification. Materialise remote/ into data/bronze/."""
from __future__ import annotations

import argparse
import sys


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--remote", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--pull-date", required=True)
    ap.add_argument("--states", nargs="*", default=["tx", "nm", "ok"])
    a = ap.parse_args()
    raise NotImplementedError("bronze ingestion not implemented")


if __name__ == "__main__":
    sys.exit(main())
