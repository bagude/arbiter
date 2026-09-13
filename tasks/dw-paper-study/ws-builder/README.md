# dw-paper-study workspace — a close reading of SPE 162910

`paper/` is a **read-only mount** of the paper's text: `paper/index.md` (page → first line) and `paper/pages/p01.txt … p61.txt`, one file per page, extracted from the PDF. Pages 11–58 are figures with almost no text; the substance is on pages 1–10 and Appendix A on pages 59–61. Equations extract garbled (symbols dropped, terms reordered); the nomenclature on page 10 and the prose around each equation are reliable, the equation glyphs are not.

Deliverable: `src/study.json` and `src/study.md` (see the specification). Only `src/` is graded; scratch notes go under `src/notes/`.

Python for numeric checks: `uv run --no-project --python 3.13 --with-requirements requirements.txt python -c "…"` with `numpy` and `scipy`. A check's code must read nothing from disk and print one JSON line; it may import `json`, `sys`, `math`, `numpy`, `scipy`.
