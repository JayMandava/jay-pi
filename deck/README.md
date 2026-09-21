# Harness Engineering: pi-harness

A 28-slide deck walking through this repo's actual design: the payload-vs-narration
mechanism (`record_cycle`, the five run statuses), Grilling Discipline and the
`grill` tool, the Plan Approval Gate, the patch self-heal system, and the Jev
cross-check as a worked example of extending the harness.

## View it

Open `index.html` directly in a browser — no build step, no server required.

- **Arrow keys / space** to move between slides
- **On-screen prev/next** at the bottom of the window
- The URL hash tracks the current slide, so you can link directly to one
  (e.g. `index.html#s12`)

Or serve it locally if your browser blocks local file access to fonts:

```sh
cd deck
python3 -m http.server 8000
# open http://localhost:8000
```

## Export to PDF

Open `index.html`, then use your browser's print dialog (Cmd/Ctrl+P), choose
**Landscape**, and save as PDF. Each slide prints on its own page.

## Editing

Everything is in the one `index.html` file — one `<section class="slide dark|light">`
per slide, plain CSS custom properties for the palette (`--navy`, `--paper`,
`--coral`, etc.), and a small vanilla-JS pager at the bottom of the file. No
framework, no dependencies beyond the Google Fonts link for Rubik and Fira Code.
