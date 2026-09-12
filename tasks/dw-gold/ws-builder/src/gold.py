#!/usr/bin/env python
"""Gold layer — see the specification. Build data/gold/warehouse.duckdb from data/silver/."""
from __future__ import annotations

import argparse
import sys


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--silver", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--county-cycle")
    a = ap.parse_args()
    raise NotImplementedError("gold build not implemented")


if __name__ == "__main__":
    sys.exit(main())
