# Excel Structure Findings (Phase 1)

Source file inspected: `Copy of US Calling VECS Updated list.xlsx` (the user's real reference workbook — not a mock/dummy file). Inspected with `openpyxl` (structure/styles) and independently re-verified with `ExcelJS` (`backend/src/services/excel/masterWorkbookReader.ts` + `backend/tests/masterWorkbookReader.test.ts`), so every finding below is backed by a passing automated test against the actual file, not eyeballing.

## Workbook structure

- Single worksheet: **`Sheet2`**.
- 44 rows total: **1 header row + 43 vessel rows**.
- **17 columns, A–Q.**
- No merged cells, no frozen panes, no sheet protection, no conditional formatting, no hyperlinks, no formulas.
- An orphaned `_FilterDatabase` defined name (`Sheet2!$M$1:$M$44`) and a leftover `printerSettings1.bin` exist in the file but have no visible effect — not touched by this app.

## Formatting

| Element | Value |
|---|---|
| Font | Times New Roman, 11pt, throughout |
| Header row | Bold, fill `#C0E6F5`, centered, wrapped text |
| Data rows | Not bold, thin border all sides, wrapped text |
| Row height | ~76–81pt (tall — sized to fit the embedded evidence screenshots) |
| Column L width | 52.4 chars (by far the widest — this is the evidence-image column) |

## The 17 columns (exact headers, in order)

| Col | Header (verbatim) | Classification |
|---|---|---|
| A | Sr. No. | Display/derived — not stored as permanent identity |
| B | Vessel Name | **Permanent** |
| C | IMO No | **Permanent** |
| D | Flag | **Permanent** |
| E | Vessel Type Bulk / Container / Tanker / LNG / Car Carrier | **Permanent** |
| F | Summer Deadweight / TEU (for container ships) | **Permanent** |
| G | Ballast/Loaded | **Operational** (see note below) |
| H | Registered Owners Name / Country as per Certificate of Registry | **Permanent** |
| I | Registered Owners Name / Country as per CSR | **Permanent** |
| J | Operator's Name in COFR | **Permanent** |
| K | Bridge Letter | **Permanent** |
| L | Data extracted from IMO WEBSITE | **Evidence** (images only — see below) |
| M | Built Location | **Permanent** |
| N | Service fees applicable Yes/No/NA | **Permanent** (see note below) |
| O | Arrival Port | **Operational** |
| P | ETA | **Operational** |
| Q | ETD | **Operational** |

**Two deliberate deviations from a naive "match the spec's example categories" reading, flagged rather than silently decided:**

1. **Column G (Ballast/Loaded)** describes the vessel's loading condition on a specific call — this changes call to call, so it lives on `VesselCallingRecord`, not `Vessel`, even though earlier drafts of the spec implicitly grouped it with permanent fields.
2. **Column N (Service fees applicable)** is kept on `Vessel` as a default/policy field for now, since the source data doesn't make clear whether it varies per call. This is an open question for the user to confirm, not a hard assumption — flagged in `ROADMAP.md` known issues.

## Column L is NOT a vessel photograph

Every embedded image was opened and visually inspected. They are **cropped screenshots of an IMO vessel-lookup website**, showing fields like classification society, registered owner, ship manager, group beneficial owner, and operator — reference/business documentation, not ship photos. The data model treats these as **Evidence records**, not decorative images (see `DATABASE.md` / `EVIDENCE_MAPPING.md`).

Sample extracted image content (image2.png, verified visually):
```
Classification society: American Bureau of Shipping
Registered owner: MAGNUS LINE INC (1816098)
Ship manager: NORDEN AS DAMPSKIBSSELSKABET (6176243)
Group beneficial owner: FUKUJIN KISEN KK (0208451)
Operator: NORDEN AS DAMPSKIBSSELSKABET (6176243)
```

## Critical finding: image-to-vessel association is NOT reliable by position

Both `openpyxl` (raw XML anchor inspection) and `ExcelJS` (via the actual reader we ship) independently confirm:

- **50 image anchors** exist in the workbook drawing layer, referencing **43 unique underlying image files** (a handful of images are anchored twice).
- **33 vessels have exactly one image cleanly anchored to their own row.**
- **17 image anchors are stacked on top of each other at row 2** (Ocean Harvest's row), nudged sideways by small pixel offsets — consistent with a paste mistake where multiple screenshots landed on the same cell instead of their intended rows.
- **9 vessels have no dedicated anchor at all:** MH Highlander, TAC Odessa, Paris Trader, Soya Tianjin, Spar Mira, Celsius Goa, ASP Avana, Iris Ace, Crimson Ark. Their evidence is presumably among the row-2 pileup, but this cannot be assumed — it must be resolved through the evidence review workflow (OCR + manual confirmation), never inferred from position.

**Design consequence:** the application's database is the sole source of truth for vessel↔evidence association (`Vessel.id` → `VesselEvidence.vesselId`). Excel anchor position is recorded only as forensic metadata (`VesselEvidence.sourceAnchorRow/Col`) for audit purposes — it is never read back as authority during import, export, sort, or removal. See `EVIDENCE_MAPPING.md`.

## Date handling

- ETA/ETD are stored as **plain text**, not Excel date values (`data_type == 's'`, `number_format == General`).
- Master format: **`DD.MM.YYYY`** with dots, e.g. `20.08.2026`.
- The US Calling List (separate document) uses **`DD-MM-YYYY`** with dashes, e.g. `06-09-2026`.
- **A real malformed value exists in the source file today:** Athens C's ETD is `06.09.026` — a 3-digit year. `parseOperationalDate()` deliberately fails to parse this rather than guessing `2026`; it must surface as an open `DataQualityIssue` (`INVALID_DATE_FORMAT`, severity `ERROR`). Verified by an automated test reading the real file.

## IMO number findings — a correction

An earlier informal note in this project speculated that four IMO numbers (MH Highlander, Mizar, Athens C, Celsius Goa) "looked like invalid placeholders" because they start with `1` rather than `9`. **This was wrong** — it was a visual guess, not a computation. The mod-10 IMO check-digit algorithm (`validateImoNumber()`) was run against **all 43 IMO numbers in the real workbook, and every single one passes the checksum**, including those four. There is currently no IMO data-quality issue in this workbook. The validator and its test suite remain in place because future Master imports or US Calling List uploads may well contain a genuinely invalid IMO — the correction is about this file, not about removing the check.

## Sr. No. (column A)

Column A is a simple sequential counter (1–43) matching the current row order, which is presently unsorted by ETA. Once the app enforces ETA-ascending sort, `Sr. No.` on export should be regenerated to match the new order (1..N in the exported sheet) rather than preserved from the original file — this is a display/derived field, not a stored identity. Confirmed by data inspection; to be implemented in Phase 9 (export) and re-confirmed with the user before that phase ships.
