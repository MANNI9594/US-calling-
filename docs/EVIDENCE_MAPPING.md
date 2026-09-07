# Evidence Mapping & Review Workflow

## What "evidence" means here

Column L of the Master workbook ("Data extracted from IMO WEBSITE") holds cropped screenshots of an IMO vessel-lookup website — classification society, registered owner, ship manager, group beneficial owner, operator. These are **reference/business documentation**, not vessel photographs. See `EXCEL_STRUCTURE_FINDINGS.md` for the visual confirmation. Everywhere in this codebase, "evidence" refers to these images plus their metadata — never treated as decorative.

## The problem this workflow solves

The reference workbook itself already has 17 image anchors piled onto one row (Ocean Harvest's) and 9 vessels with no anchor of their own at all. Any import logic that trusts "the image nearest this row belongs to this vessel" would silently misattribute evidence for at least those cases — and there is no way to know, from Excel alone, which of the 17 piled images belongs to which of the (up to) 9 unaccounted-for vessels, or to Ocean Harvest itself.

## Review states (`VesselEvidence.reviewStatus`)

| Status | Meaning | Who can reach it |
|---|---|---|
| `UNASSIGNED` | Not associated with any vessel yet | Import (default for anything not confidently matched) |
| `NEEDS_REVIEW` | Associated with a vessel, but not yet human-confirmed | Import (clean anchor) or OCR auto-match |
| `CONFIRMED` | Human has confirmed the association is correct | User action only |
| `REJECTED_DUPLICATE` | User determined this is a duplicate of another evidence record | User action only |
| `REJECTED_IRRELEVANT` | User determined this image isn't usable evidence | User action only |

**No automated process may set `CONFIRMED`.** OCR/content analysis, however confident, can only produce `NEEDS_REVIEW`. This is a hard rule, not a tunable threshold — see Phase 4 notes below for why.

## Association methods (`VesselEvidence.associationMethod`)

| Method | Meaning |
|---|---|
| `ORIGINAL_ANCHOR` | The source workbook anchored this image cleanly to exactly one row (33 of 43 vessels in the reference file) |
| `OCR_AUTO_MATCH` | OCR/content analysis proposed a vessel; carries `associationConfidence` (0.000–1.000) |
| `MANUAL` | A human assigned or reassigned it via the review UI |
| `UNASSIGNED` | No association yet |

Even `ORIGINAL_ANCHOR` starts life as `reviewStatus = NEEDS_REVIEW`, not `CONFIRMED` — "the source file happened to anchor this correctly" and "a human has verified it's correct" are different claims, and conflating them is exactly the mistake that let the row-2 pileup go unnoticed in the original workbook for however long it existed.

## API surface

Evidence review (implemented in Phase 2, `backend/src/routes/evidence.routes.ts`):
- `GET /api/evidence?status=NEEDS_REVIEW` — review queues by status
- `GET /api/evidence/:id/image` — stream the actual image bytes (via the storage abstraction, never a public URL)
- `POST /api/evidence/:id/assign { vesselId }` — manual assign/reassign; always sets `associationMethod = MANUAL`, `reviewStatus = CONFIRMED`
- `POST /api/evidence/:id/confirm` — confirm an existing (OCR or anchor-derived) association without changing the vessel
- `POST /api/evidence/:id/reject { reason: 'DUPLICATE' | 'IRRELEVANT' }` — never deletes the stored file or the DB row

Master import (implemented in Phase 3, `backend/src/routes/import.routes.ts`, browser UI at `public/import.html`):
- `POST /api/import/master-workbook/preview` — parses the uploaded workbook, checks proposed vessel identities against the database, writes only the original file to storage. No Vessel/Evidence rows created.
- `POST /api/import/master-workbook/commit { storageKey, originalFilename }` — commits the previewed file inside one atomic transaction. This is where the clean/pileup grouping actually produces `VesselEvidence` rows — clean anchors get `ORIGINAL_ANCHOR`/`NEEDS_REVIEW` (only if the row maps to a vessel created in this run), pileup images always get `UNASSIGNED`.
- `GET /api/import/batches` / `GET /api/import/batches/:id` — import history

## Phase 4 plan: OCR-based repair (not yet implemented)

For the 17 piled-up images and the 9 unaccounted-for vessels:

1. Run OCR (planned: Tesseract via a Node binding, or a cloud OCR API — decision deferred to Phase 4 so it can be evaluated against the real screenshots' actual text quality, not guessed now) against each evidence image, storing raw output in `ocrExtractedText`.
2. Attempt to extract structured fields (`ocrExtractedFields`: owner name, operator, classification society, any IMO-like number visible) — the screenshots are lookup-result pages, so a registered owner name is often visible even when a ship name isn't.
3. Compare extracted fields against the 43 `Vessel` records' `registeredOwnerPerCor` / `registeredOwnerPerCsr` / `operatorNameInCofr` / `imoNumber` fields. A match on owner *and* operator *and* (if visible) IMO is treated very differently from a fuzzy name-only match — score accordingly.
4. Any match above a confidence threshold (to be set empirically against the real 17-image pileup once OCR output is in hand, not assumed in advance) becomes `OCR_AUTO_MATCH` / `NEEDS_REVIEW`. Anything below stays `UNASSIGNED`.
5. Nothing in this step ever deletes an image, and nothing in this step ever sets `CONFIRMED`.

## Export rule (Phase 9, not yet implemented)

Only `CONFIRMED` evidence is written into the exported workbook, into column L of the vessel's row, keyed strictly by `Vessel.id` → `VesselEvidence.vesselId` — never by re-deriving a position from the original file. If a vessel has more than one `CONFIRMED` evidence record, the export rule is: **place the most recently confirmed image** in column L, and note in `docs/ROADMAP.md` / the export summary that additional evidence exists and was not lost, just not placed in the single-image column (the workbook layout only has one evidence cell per row). This rule is provisional and will be confirmed with the user before Phase 9 ships, per the instruction not to decide export behavior before the data model is settled.
