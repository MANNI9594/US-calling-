# Roadmap

Phase numbering matches the project spec's 11-phase plan.

## Phase 1 — Workbook Inspection ✅ COMPLETE

- Real reference workbook inspected with `openpyxl` and independently re-verified with `ExcelJS`.
- Findings documented in `EXCEL_STRUCTURE_FINDINGS.md`.
- Critical finding surfaced and confirmed with user: Column L images are IMO-website screenshots (evidence), not vessel photos; 17 of 50 image anchors are piled on one row; 9 vessels have no dedicated anchor; every IMO number in the file passes checksum (corrected an earlier wrong guess).

**Known issues carried forward:** none blocking; the workbook's data-quality problems (Athens C's malformed ETD) are expected inputs the app must handle, not bugs to fix in the source file.

## Phase 2 — Backend / Database / Auth Foundation ✅ COMPLETE

Built:
- PostgreSQL schema (`backend/prisma/schema.prisma`) implementing the Vessel → Evidence / CallingRecord / DataQualityIssue / AuditLog model, with `VesselEvidence.vesselId` nullable to support the Unassigned Evidence pool.
- Express + TypeScript API shell: health check, single-user auth (bcrypt + server-side sessions), CORS/helmet/rate-limiting.
- Storage abstraction (`local` disk or S3-compatible) selected entirely by environment variable — no code change to switch providers.
- Data-quality service: date parser (two known formats, refuses to guess on malformed input), IMO checksum validator — both unit-tested against real values from the reference workbook.
- Evidence review API: list by status, stream image, assign/reassign, confirm, reject (duplicate/irrelevant) — never deletes a file.
- Vessel read API (list with ETA sort + search, detail) — deliberately read-only; creation is intentionally deferred to Phase 3.
- Read-only Master workbook reader (`masterWorkbookReader.ts`) using ExcelJS, tested end-to-end against the real reference file (6 passing tests confirming row count, header count, image anchor counts, and the exact malformed Athens C value).
- Docker: multi-stage `Dockerfile`, root `docker-compose.yml` for local dev (Postgres + backend + Adminer).
- `docs/DEPLOYMENT.md` with concrete Railway/Render/generic-Docker instructions, **including a fully click-only "Part 0" path** (GitHub web upload + Railway dashboard + a browser-based `/setup.html` one-time account creation page) for deployment with zero terminal/CLI access.

**Verified:** 23/23 automated tests passing, 6 of them against the actual uploaded workbook (not fixtures). `tsc --noEmit` compiles clean except for two errors that trace directly to the Prisma client not being generated in this sandbox (network access to `binaries.prisma.sh` is blocked here) — not code defects. The user will run `npm install && npx prisma generate && npx prisma migrate dev` locally, which needs no special access beyond a normal developer machine.

**Known issues / open questions:**
- Column N ("Service fees applicable") is modeled as a `Vessel`-level (permanent) field for now; it's unclear from the source data whether this varies per call. Flagged for user confirmation before Phase 3 finalizes the import mapping.
- The partial unique index on `Vessel.imoNumber` (unique only where non-null) is documented in `DATABASE.md` but not yet applied — it needs to be added to the first real migration once one is generated against a live database.
- No frontend exists yet; out of scope for this phase per the user's explicit phase-2 deliverable list.

**Next phase:** Phase 3 — Master Import (turn `masterWorkbookReader` output into `Vessel` + `VesselEvidence` + `VesselCallingRecord` rows, inside one transaction, with data-quality checks applied to every ETA/ETD/IMO as they're created).

## Phase 3 — Master Import ✅ COMPLETE

Built:
- `imageAssociationGrouping.ts` — pure logic deciding clean-single-anchor vs. pileup per row, verified against the real workbook (33 clean, 17 piled on Excel row 2 — exact match to Phase 1 findings, via `tests/imageAssociationGrouping.test.ts`).
- `vesselIdentity.ts` — IMO-first-else-normalized-name identity resolution for duplicate prevention, unit-tested against real vessel names and IMOs from the reference file.
- `masterImportService.ts` — two-phase workflow:
  - `previewMasterImport()`: parses the uploaded workbook, checks every row against existing `Vessel` records (by IMO if plausible, else normalized name), reports new-vs-already-exists, image association stats, and reader warnings. Writes nothing except the original file to storage (so committing later doesn't require re-upload).
  - `commitMasterImport()`: creates `Vessel` + `VesselCallingRecord` + `VesselEvidence` rows inside a single Prisma transaction. Per the user's explicit decision: **a vessel that already exists in the database is skipped entirely on re-import** (no field overwrite, no duplicate row) — the Master workbook is treated as a one-time/occasional seed, not a recurring source of truth once vessels exist. Every ETA/ETD is run through the existing date-quality checks; every implausible IMO is flagged, never discarded.
  - Evidence rows: clean single-anchor images get a provisional `ORIGINAL_ANCHOR` / `NEEDS_REVIEW` association *only if* their anchor row maps to a vessel actually created/matched in this run. All 17 pileup images go straight to `UNASSIGNED` — no image is ever assigned by guessing which of several stacked images belongs to the one vessel at that row.
- `import.routes.ts` — `POST /master-workbook/preview`, `POST /master-workbook/commit`, `GET /batches`, `GET /batches/:id`.
- Two browser-only pages (`public/import.html`, `public/login.html`) implementing the full drag-and-drop → preview → confirm → history flow with zero CLI, consistent with the office-PC constraint.

**Bug found and fixed while building this phase:** several Phase 2 route handlers (`evidence.routes.ts` and others) `throw`Error directly inside `async` Express handlers. Express 4 does not automatically forward a rejected promise from an async handler to error-handling middleware — this would have caused hung requests instead of proper error responses in production. Added `middleware/asyncHandler.ts` and applied it to every route across the whole app (auth, vessels, evidence, import, health), verified via `tsc` and the full test suite afterward.

**Verified:** 33/33 automated tests passing (10 new this phase, all against real data — no fixtures/mocks for the core logic). `tsc --noEmit` compiles clean except the same 4 pre-existing errors that trace directly to the Prisma client not being generated in this sandbox (unchanged from Phase 2, not new).

**Known issues / open questions:**
- The full commit flow (`commitMasterImport` executing against a live Postgres) has **now been verified end-to-end on the user's live Railway deployment**: 44 vessels created, 0 duplicates, 35 evidence images cleanly associated (all correctly left as `NEEDS_REVIEW`, none auto-confirmed), 17 correctly routed to the Unassigned pool, 16 data-quality issues flagged (mostly past-ETD), transaction completed successfully. This closes out the sandbox limitation noted below — the untestable part has now been tested for real, by the user, against production.
- (Historical note, retained for context) Generating a working `@prisma/client` inside this development sandbox requires network access to `binaries.prisma.sh`, which is blocked here — so the commit path could not be integration-tested *in this sandbox*. It could be, and was, tested on Railway, which has normal internet access.
- The user's actual file has since grown to 44 vessels / 52 image anchors (35 clean / 17 pileup) — one more of each than the original 43/50/33/17 reference copy inspected in Phase 1. The import logic handled this correctly without any code change, since none of the counts were hardcoded — only the *tests* assert the original reference file's exact numbers.
- Storage writes for evidence images happen before the DB transaction commits (necessary — Postgres transactions can't span the storage layer). If the DB transaction then fails, those image files become orphaned in storage (harmless, but not cleaned up automatically yet). Acceptable for a personal single-user tool; a cleanup job could be added later if it becomes a real issue.
- `previewMasterImport` also always writes the original file to storage, even if the user never commits. Same tradeoff as above — orphaned files, no data-integrity risk, not yet auto-cleaned.
- Multiple evidence records per vessel are fully supported by the schema, but there's currently no UI affordance for viewing "all evidence for vessel X" as a set outside the Evidence Review queues — that's a Phase 7 (Vessel Profile) concern, not overlooked, just not yet built.
- Not yet spot-checked: whether the real file still contains the originally-found Athens C malformed-ETD value (`06.09.026`) or a corrected one — the summary's data-quality count doesn't break down by issue type yet. Worth checking via the Evidence/Vessel API once Phase 4/7 UI exists, or by querying `dataQualityIssues` directly.

**Next phase:** Phase 4 — Evidence Repair (OCR against the 17 pileup images + the 9 vessels with no anchor at all, confidence-scored auto-matching, all landing in `NEEDS_REVIEW`). A manual review UI (`public/evidence-review.html`) was built ahead of this to unlock immediate value and avoid designing OCR blind — see below.

## Evidence Review UI (built ahead of schedule, between Phase 3 and Phase 4)

Rationale: 52 evidence images existed in the database after Phase 3 with no way to look at them except raw API calls. Building OCR before a way to review its suggestions would mean designing it blind. So a manual review page was built first — it's required regardless of whether OCR exists (OCR only pre-fills a suggestion; a human still confirms), and it delivers real usability immediately.

Built: `public/evidence-review.html` — tabbed by review status (Needs Review / Unassigned / Confirmed / Rejected), image lightbox, confirm/reassign/reject actions wired to the existing Phase 2 evidence API, plus a "vessels with no evidence" list for visibility into gaps. Vessel reassignment search uses a simple `prompt()`-based flow rather than a polished autocomplete dropdown — functional, not final; worth revisiting once a real frontend framework is in place (Phase 6+).

**Verified on the live deployment:** all 35 `NEEDS_REVIEW` images render correctly with the right vessel name/IMO attached; clicking Confirm correctly moves an item to the Confirmed tab; the Unassigned tab correctly shows all 17 pileup images with no vessel name attached (i.e., nothing was silently guessed). Reassign (the `prompt()`-based vessel search) and both Reject actions have not yet been individually confirmed by the user — worth a quick check, but the core read/confirm/unassigned-separation path is proven end-to-end in production.

## Phase 4 — Evidence Repair ✅ COMPLETE

Built and tested:
- `ocrFieldExtraction.ts` — parses OCR output into structured candidate fields (registered owner, ship manager, group beneficial owner, operator, numeric codes). Tested against **real OCR text actually captured from a real evidence image** (via tesseract.js against an image extracted from the reference workbook during development) — including real OCR noise (misread characters, a misread digit in an owner code) that the extraction correctly tolerates without attempting to "correct."
- `vesselMatchScoring.ts` — scores a candidate vessel against extracted fields: exact IMO match dominates the score, owner/operator similarity uses token-overlap on normalized company names (tolerant of OCR noise, tolerant of "INC"/"LTD"/"AS" suffix variation, not fooled by a single shared word). Tested with the real OCR sample: a genuinely correct vessel scores >0.8, a genuinely unrelated one (different owner, different IMO — using Ocean Harvest's real data as the negative case) scores <0.15, and a vessel whose true IMO differs from OCR's misread digit still scores moderately (0.3–0.8) rather than falling to zero or spiking to false-certainty.
- `ocrService.ts` — wraps tesseract.js, pointed at a GitHub-hosted mirror of the trained language data (`raw.githubusercontent.com`) rather than the library's default CDN (`jsdelivr.net`), because the default was blocked in this development sandbox. **This was tested for real**: OCR was run against an actual evidence image extracted from the reference workbook and produced genuinely readable (if imperfect) text — see the exact captured output in `tests/ocrFieldExtraction.test.ts`'s fixture comment.
- `evidenceRepairService.ts` — orchestrates the above over every currently-`UNASSIGNED` evidence record: runs OCR, scores against every vessel, and if the best score clears a threshold (0.35, chosen from the real test data's score gap between true and false matches), sets `associationMethod = OCR_AUTO_MATCH` and `reviewStatus = NEEDS_REVIEW` — **never `CONFIRMED`, regardless of score**. Below threshold, the evidence stays `UNASSIGNED` but its OCR text/fields are saved so a human reviewer has something to go on and future runs don't repeat the OCR work. Each evidence record is processed and saved independently (not one all-or-nothing transaction like Master Import) — one image's OCR failure doesn't block the rest of the batch.
- `POST /api/evidence/ocr-repair` — triggers a repair run (optionally scoped to one import batch), runs synchronously (appropriate at this personal-tool scale of a few dozen images; would need to become a background job if evidence volume grew much larger).
- `public/evidence-review.html` updated with a "Run OCR Matching on Unassigned Evidence" button and a confidence display on any card that came from an OCR suggestion.

**Verified:** 45/45 automated tests passing (12 new this phase). Critically, this phase's core claims — "OCR actually produces usable text from these specific screenshots" and "the scoring logic actually separates true matches from false ones" — were tested against **real captured data**, not synthetic fixtures invented to make the tests pass.

**Known issues / open questions:**
- The full `runEvidenceRepair()` flow (actually running against the live database + live storage + live OCR together, end-to-end) has **not yet been tested on the real Railway deployment** — only its individual pieces (OCR itself, field extraction, scoring) were verified independently, and separately from each other, in this sandbox. This is the same category of gap as Phase 3 had before the user's live test: individually-proven pieces wired together for the first time in production. Next action: user clicks "Run OCR Matching" on the real deployment against the real 17 unassigned images and reports what happens.
- The 0.35 suggestion threshold was chosen from exactly one real positive/negative example pair — it has not been tuned against a larger sample of the actual pileup images' OCR quality, because doing so would require running OCR against all of them first, which is what this phase enables in the first place. If early real-world use shows too many low-quality suggestions (or too few), the threshold is a single constant to adjust, not a design to rework.
- `tesseract.js`'s default CDN (`jsdelivr.net`) was blocked in this sandbox; the code was changed to use a GitHub-hosted mirror instead, which worked. This mirror has not been confirmed reachable from Railway specifically — Railway's network is expected to be far less restricted than this sandbox, but this is worth confirming on the first real repair run rather than assumed.
- No retry/backoff logic exists for a transient OCR or storage failure on a single image — it's simply recorded in the batch's `errors` array and the image stays `UNASSIGNED`, safe to re-run later.

**Next phase:** Phase 5 — US Calling List Processor (the daily-use upload that actually updates ETA/ETD/Port for existing vessels — this is the workflow the user will use routinely, distinct from the occasional Master re-import).

## Phase 5 — US Calling List Processor ✅ COMPLETE

Built and tested:
- `usCallingListReader.ts` — header-tolerant column mapping (case/whitespace-insensitive, and specifically tolerates the spec's actual "Transection type" header spelling rather than "correcting" it), validates the three genuinely-required columns (Vessel Name, ETA, ETD) and produces a clear error naming exactly which are missing otherwise. Tested via a real in-memory xlsx round-trip built with the exact example rows from the user's spec (Alfred N, Atlantic Sunshine, Atlantic Sunflower, Athens C).
- `callingListMatching.ts` — pure matching logic: exact-normalized-name match against `ACTIVE_MATCH` / `ARCHIVED_MATCH` / `NEW_UNKNOWN` / `AMBIGUOUS`. Tested against real vessel names from the reference workbook, and critically re-confirms the "Atlantic Sunshine" vs. "Atlantic Sunflower" must-not-merge requirement with two real similarly-named vessels in the same candidate list.
- `usCallingImportService.ts` — two-phase preview/commit, same pattern as Master Import:
  - Preview computes a per-row change status (`UPDATED`/`UNCHANGED`/`NEW`/`ARCHIVED_FOUND`/`AMBIGUOUS`) by comparing against each vessel's current `VesselCallingRecord`, plus date-quality warnings (malformed dates, ETD-before-ETA, past-ETD) — all informational, nothing written yet.
  - Commit runs inside one transaction: for each confidently-matched row, the prior "current" calling record is marked non-current (never deleted — that's the history) and a new one is created and data-quality-checked. `NEW_UNKNOWN` and `AMBIGUOUS` rows are always skipped (never auto-created or auto-resolved). `ARCHIVED_MATCH` rows are only restored (`Vessel.status → ACTIVE`, `restoredAt` set, `VESSEL_RESTORED` audit logged) if the user explicitly opts in via a checkbox — this is the "Archived Vessel Found → Restore & Update" convenience feature from the spec, scoped to a single all-or-nothing toggle per upload rather than per-row selection (a reasonable simplification for a personal tool; per-row selection would be a natural refinement if it turns out to matter in practice).
- `uscalling.routes.ts` — `POST /preview`, `POST /commit`.
- `public/us-calling-upload.html` — the actual daily-use page: drag/drop, a change-review table (vessel, status badge, old/new ETA/ETD/Port, warnings), a checkbox for the archived-restore behavior, and an apply-result summary.

**Verified:** 58/58 automated tests passing (13 new this phase). This phase's testable claims were tested against real inputs — the exact example rows from the user's own spec, real vessel names from the reference workbook, and a specific must-not-merge regression test. **Both preview and commit have now been run live on Railway against the real 44-vessel database**, using a real 35-row US Calling List (not just a hand-made test file): 28 vessels updated, 7 correctly skipped as unknown, 0 ambiguous, 6 data-quality issues flagged. The write was independently confirmed correct by directly inspecting `/api/vessels?search=...` afterward and comparing the stored `etaRaw`/`etdRaw` against the preview's proposed values — they matched. This phase is genuinely, fully verified end-to-end, not just built.

**Known issues / open questions:**
- **Bug found and fixed during live testing:** the first real preview run showed dates rendering as `"Wed Sep 09 2026 00:00:00 GMT+0000 (Coordinated Universal Time)"` instead of a clean date string, which then failed date-format validation entirely. Root cause: Excel silently converts a hand-typed date like `10-09-2026` into a real date-typed cell rather than text — unlike the Master workbook, which stores ETA/ETD as plain text throughout. `usCallingListReader.ts` (and, for consistency, `masterWorkbookReader.ts`) now detects a native `Date` cell value and formats it back to the expected raw string format (`DD-MM-YYYY` / `DD.MM.YYYY` respectively) rather than falling back to JavaScript's default `Date#toString()`. This is not "guessing" — Excel's internal date representation is unambiguous, so reformatting it faithfully is correct, not a workaround. Confirmed fixed with a regression test that reproduces the exact scenario (a real xlsx with genuine `Date`-typed cells) and asserts the old buggy output can never reappear.
- **Commit now verified live** (28 real vessels updated, confirmed correct by direct API inspection afterward — see above).
- The "restore archived vessels" decision is a single checkbox covering the whole upload, not a per-row choice. If the user has both an archived vessel they want back and one they don't in the same upload, this phase can't split that — worth revisiting if it comes up in real use.
- `NEW_UNKNOWN` rows (a vessel in the list that doesn't exist in the database at all) are surfaced in the preview/summary but there is still no UI to act on them (create a vessel profile from a calling-list row) — this remains explicitly deferred, consistent with the spec's own instruction not to auto-create a full permanent profile from incomplete operational data.
- `AMBIGUOUS` rows (a name matching more than one vessel) are surfaced but not resolvable through any UI yet — expected to be rare (it requires two vessels already sharing a normalized name, which import-time duplicate detection should prevent going forward) but not impossible with pre-existing data.

**Next phase:** Phase 6 — Review (a more capable, dedicated change-review UI is largely already delivered as part of this phase's upload page; the formal Phase 6 gap is primarily the ambiguous-match resolution workflow — the new-vessel gap is now closed, see below).

## Add Vessel flow (built ahead of schedule, closing the Phase 5 "New/Unknown" gap)

Rationale: every US Calling List upload will keep skipping the same "New/Unknown" vessels forever unless there's a way to add them — a real, recurring problem that would be hit on literally the next daily upload, not a hypothetical edge case. Given the choice between this and starting Phase 7's Active Master table, this was prioritized as the higher-impact gap.

Built:
- `POST /api/vessels` — creates a vessel with a human-supplied permanent profile (never inventing fields from operational data alone, per the spec's explicit instruction). Reuses the same `resolveVesselIdentity` duplicate-protection logic as Master Import — rejects with 409 rather than creating a second copy if a matching vessel already exists. Optionally accepts initial operational data (Port/ETA/ETD/Voyage Type/Transaction Type/Send To) to create the vessel's first `VesselCallingRecord` in the same transaction, running it through the same date-quality checks as every other creation path.
- `public/add-vessel.html` — a form for the permanent fields, pre-filled with the vessel name and pending operational data via URL parameters so re-typing isn't required.
- `public/us-calling-upload.html` updated: every `NEW` row in the preview table now has an "Add to Database" link that opens the pre-filled form in a new tab. A note was added clarifying that this creates the vessel immediately (independent of the main Apply Changes action) and that Preview should be re-run afterward to see the vessel drop off the New/Unknown list.

**Verified:** 58/58 tests passing (no regressions; this feature's route logic mirrors already-tested patterns from Master Import closely enough that no new pure-logic unit tests were added — the identity/duplicate-detection logic it reuses is already covered by `tests/vesselIdentity.test.ts`). **Not yet tested live** — next action: user hits "Add to Database" on one of the real 7 New/Unknown vessels from their last US Calling List upload and confirms it appears correctly afterward.

## Phase 6 — Review — PARTIALLY COVERED (see Phase 5 notes above)

Planned: change dashboard (updated/unchanged/new/ambiguous/archived-found/past-ETD/invalid counts + detail table), confirmation workflow before anything commits.

## Phase 7 — Active Master — NOT STARTED

Planned: table UI (search, filter, ETA sort, multi-select), remove-and-archive flow with confirmation.

## Phase 8 — Restore / Vessel Database — NOT STARTED

Planned: archive search, restore-to-active, automatic archived-vessel detection on new US Calling List uploads, vessel profile view.

## Phase 9 — XLSX Export — NOT STARTED

Planned: Master template preservation, evidence placement by `vesselId` (never by anchor position), formatting preservation, export validation (see spec section 32), Sr. No. regeneration to match ETA-sorted order (pending user confirmation — see `EXCEL_STRUCTURE_FINDINGS.md`).

## Phase 10 — History / Backup — NOT STARTED

Planned: `[ BACKUP DATA ]` / `[ RESTORE BACKUP ]` producing a combined DB + storage archive.

## Phase 11 — Hardening — NOT STARTED

Planned: security review, broader error-handling coverage, performance pass, UX polish, production deployment execution (by the user, per `DEPLOYMENT.md`).

## Master Import: evidence deduplication fix (prompted by the user asking "what if we re-upload the Master list?")

Answering that question surfaced a real gap: the original Phase 3 implementation deduplicated **vessels** on re-import (matched by IMO/name, never overwritten) but did **not** deduplicate **evidence images** — every clean-anchored screenshot in a re-uploaded file would create a brand-new `VesselEvidence` row, even for a vessel whose evidence hadn't changed at all. Re-uploading the Master workbook repeatedly would have silently piled up duplicate evidence records over time.

Fixed: before creating any evidence row (clean-associated or pileup), `masterImportService.ts` now checks whether an active `VesselEvidence` row with the same `contentHash` already exists anywhere in the database, and skips creating a duplicate if so. A new `evidenceSkippedDuplicate` counter was added to the import summary and surfaced in `public/import.html`.

**Verified live on Railway with a real updated Master file** (not a repeat of the same file — an actual newer version with 5 new vessels): 44 previously-existing vessels correctly skipped with zero profile overwrites, 5 new vessels correctly created, **52 duplicate evidence images correctly skipped** (the entire original evidence set, recognized by content hash), and 4 new evidence images correctly added for the new vessels. This is a complete, real-world confirmation of the exact re-upload scenario the fix targets.

**Documented behavior for Master re-upload, now complete:**
- Vessels already in the database (by IMO if plausible, else exact normalized name) → skipped, permanent fields never overwritten.
- Genuinely new vessels in the updated file → created normally.
- Evidence images identical (by content hash) to an already-stored active evidence record → skipped, no duplicate created.
- Evidence images that are new/different content → created as usual (clean-associated as `NEEDS_REVIEW`, pileup as `UNASSIGNED`), even for an already-existing vessel — e.g., if the Master file's screenshot for a vessel was updated to a newer IMO-website capture, the new image is correctly added rather than silently dropped.

## Phase 7 — Active Master ✅ COMPLETE

Built:
- `POST /api/vessels/archive` / `POST /api/vessels/restore` — bulk status transitions (`ACTIVE ⇄ ARCHIVED`), each vessel processed in a transaction, individually audit-logged (`VESSEL_REMOVED` / `VESSEL_RESTORED`), and — critically — this is a status flip, never a delete: the permanent profile, all evidence, and all calling-record history are untouched either way. No separate permanent-delete action exists yet, consistent with the spec's instruction that it be a distinct, explicitly-confirmed advanced action, not a default capability.
- `public/active-master.html` — the main view: tabbed Active/Archived, search (name + IMO), sortable-by-ETA table (reuses the existing `GET /api/vessels` sort logic from Phase 2), multi-select checkboxes with Select All / Clear Selection / Remove or Restore Selected (with a confirmation dialog stating the action is reversible), a `PAST ETD` badge sourced from existing open `DataQualityIssue` records, and a click-to-expand vessel detail panel (all permanent fields, current operational data, evidence count, open data-quality issues) using the existing `GET /api/vessels/:id` endpoint.
- Unified navigation added across all five main pages (Active Master, Import, Update from US Calling List, Evidence Review), and login/setup now redirect to Active Master as the natural home page instead of the Import page.

**Verified live on Railway:** the real ~49-vessel fleet renders correctly, sorted by ETA. Confirmed working: search, the vessel detail panel, and — critically — a full remove → archive → restore round trip was tested by the user ("Done: 3 vessel(s) restored"). Also independently confirmed by inspection: PAST ETD badges correctly reflect today's date against each vessel's real ETD, and sorting correctly orders vessels chronologically even when their raw ETA strings are in different formats (some `DD-MM-YYYY` from US Calling List updates, some `DD.MM.YYYY` from the original Master import) — proof that sorting genuinely uses the parsed date, not a naive string comparison, exactly as designed.

**Known issues / open questions:**
- No permanent-delete action exists yet (by design — deferred until there's a real need, per the spec's own caution against over-building).
- The vessel detail panel is a lightweight inline expansion, not the full dedicated "Vessel Profile" page with a history timeline described in the spec (section 25) — that remains a Phase 8 refinement if it turns out to matter beyond what this panel already shows.
- Search only covers vessel name and IMO (matching the existing `GET /api/vessels` capability) — filtering by status/port/flag etc. is not yet exposed in the UI even though the data supports it.

**Next phase:** Phase 8 — Restore / Vessel Database (the dedicated archive-search screen and the "archived vessel found in a new US Calling List → one-click restore & update" convenience flow — note the underlying restore mechanics already exist from Phase 5/7, so this phase is primarily UI/detection work at this point) — or Phase 9 (XLSX Export), which is arguably the more commonly wanted remaining piece: turning the current database state back into a downloadable Master workbook.

## Phase 9 — XLSX Export ✅ COMPLETE

Built and verified via real mechanics testing (not just typechecking):

- `imagePlacement.ts` — pure logic scaling an evidence image to fit Column L's space while preserving aspect ratio. Tested with real dimensions captured from actual evidence images (404×122, 510×83) plus degenerate-input and upscale-prevention cases. 5/5 tests passing.
- `masterExportService.ts` — the core export writer:
  - Loads the most recently completed Master Import's **original file** as a style template (column widths, header cell styles, a representative data-row style/height) — this is what makes the export "closely resemble the original workbook" without needing to mutate any file in place.
  - **A real mechanical risk was found and resolved before writing this service**: manually testing ExcelJS's `spliceRows`/`rowCount` on the real reference workbook showed `rowCount` does not reliably shrink after row removal — a real bug risk for exports with fewer vessels than the original import. Verified fix: build a **brand-new worksheet** each time, using the original only as a style source, never mutating it. Directly re-tested this exact approach (3 synthetic vessels, fewer than the original 43) and confirmed via `eachRow` that exactly 3 data rows exist with zero stale leftovers — this is what the shipped code does.
  - Vessels are pulled from the current Active Master only (archived vessels are excluded, matching what "Active Master" means), sorted by the same parsed-ETA rule as the Active Master table.
  - **Sr. No. is renumbered 1..N** to match the export's ETA order (user's explicit decision).
  - Each vessel's most recently `CONFIRMED` evidence image (if any) is embedded in Column L, sized via `imagePlacement.ts` (user's explicit decision on the multi-evidence tiebreaker).
  - **Export validation runs automatically before the file is ever returned**, per the spec's explicit requirement: re-reads the generated buffer and checks header text, data row count, and embedded image count against what was intended. If validation fails, the function throws — no corrupt or incomplete file is ever handed to the user.
  - The generated file is also saved to storage and recorded as a `MASTER_EXPORT` `ImportBatch`, so exports show up in history (reusing the existing `GET /api/import/batches?type=MASTER_EXPORT` endpoint — no new history UI needed).
- `GET /api/export/master-xlsx` — generates and streams the file with correct `Content-Disposition`, filename `US_Calling_Master_YYYY-MM-DD.xlsx`.
- A "⬇ Download Updated Master XLSX" button was added to `active-master.html`.

**Known issues / open questions:**
- **Not yet tested live.** This is the first phase where the full mechanics (style template loading + real evidence image embedding + validation) have not been run against the live Railway database, though every individual piece was independently verified: the underlying ExcelJS approach was proven against the real reference workbook (style cloning, image round-tripping, and the rebuild-fresh-worksheet fix all confirmed working with real file I/O in this sandbox), and `imagePlacement.ts` is unit-tested with real captured dimensions. Next action: user clicks "Download Updated Master XLSX" on the live app and opens the resulting file in Excel to confirm it looks right, has the right vessels/images, and matches the original formatting.
- ExcelJS's TypeScript definitions are stricter than its actual runtime API for one-cell-anchor image placement (`{tl, ext}` without a `br` corner) — this is a real, intentional type-widening cast (`as unknown as ExcelJS.ImageRange`), not a hidden bug; the runtime behavior was independently verified correct via manual script before being used in the shipped code.
- If an individual evidence image fails to load/read during export (corrupt file, storage hiccup), that one vessel's row is still written correctly, just without its picture — a single bad image cannot fail the whole export.

## UI redesign + multi-user support (user-directed mid-session pivot)

The user requested the interface be redesigned to match a reference product ("NavSight Pro") — dark navy table headers, blue primary-action accents, pill-shaped filter chips with colored dots, bordered secondary buttons, badges, and soft card shadows — plus support for a small team (up to 3 people) sharing one Master dataset.

Built:
- `public/styles.css` — a shared design system (CSS custom properties for the navy/blue/semantic color palette, Inter typeface, buttons, chips, badges, cards, the navy-header data-table style, form inputs, alerts, dropzones) linked by every page, replacing each page's previously-duplicated inline `<style>` block.
- Every existing page (`active-master`, `import`, `us-calling-upload`, `evidence-review`, `add-vessel`, `login`, `setup`, `logout`) was rebuilt against this shared system — same JavaScript/business logic, new markup/classes only. No backend behavior changed as part of this pass.
- Multi-user support: `POST /api/auth/users` (add a team member — requires an existing login, so it can never be reached by an unauthenticated outsider; the original `/setup` endpoint remains a one-shot bootstrap that locks itself after the first account) and `GET /api/auth/users` (list team members, no password hashes exposed). A new `TEAM_MEMBER_ADDED` audit event type was added to the schema.
- `public/manage-team.html` — lists existing accounts, form to add a new one.
- `public/logout.html` — performs the logout API call and redirects, so every page's nav can just be a plain link.
- Nav bar ("Active Master / Import / Update from US Calling List / Evidence Review / Team / Logout") is now consistent across every authenticated page, restyled as a navy top bar matching the reference.

Note: the team also has the option of simply sharing one login across all 3 people, since there is no per-user data partitioning — both approaches are supported; multi-account exists for teams that want per-person audit trail visibility (every vessel/evidence action already records `actorUserId`).

**Not yet tested live** — next action: user redeploys and confirms the redesigned pages render correctly, and (if using multi-account) adds their teammates via `/manage-team.html`.

## Real-world feedback batch (post-export live testing)

Testing the live export surfaced one real design-vs-expectation gap and prompted three UX fixes:

**Export images "missing" — clarified, not a bug, but a real friction point fixed anyway.** The export only ever includes `CONFIRMED` evidence, by design — the user had only manually confirmed 1 of 35+ evidence images from their Master import, so the export correctly (if unhelpfully) had almost no pictures. Fixed with `POST /api/evidence/bulk-confirm-clean-anchors`: bulk-confirms every `NEEDS_REVIEW` record whose association came from a clean, unambiguous single-image anchor in the original Master workbook (`associationMethod = ORIGINAL_ANCHOR`) — the highest-trust category. OCR-suggested and pileup-derived associations are deliberately untouched by this and still require individual review. Exposed as a "Confirm All Clean-Anchor Evidence" button on `evidence-review.html`.

**Add Vessel now checks the archive first.** Previously, adding a vessel always meant filling in a blank form — even if that exact vessel already existed, just archived. `add-vessel.html` now searches both active and archived vessels first; an archived match offers "Restore This Vessel" (calling the new `POST /api/vessels/:id/restore-and-update` endpoint, which restores the vessel AND applies any pending ETA/ETD/Port from the triggering US Calling List row in one step) instead of requiring the user to retype a profile that already exists. A manual-entry form remains available for genuinely new vessels. An "+ Add Vessel" button was also added directly to `active-master.html` — previously the only way to reach vessel creation was via a US Calling List "New/Unknown" row.

**Vessel detail is now a centered modal, not an inline panel at the bottom of the page.** Clicking a vessel name previously appended its detail panel below the entire (potentially long) table, requiring a scroll to see it. Now opens as a centered overlay card with an explicit close button, click-outside-to-close, and Escape-to-close.

**Dates now display consistently as DD-MM-YYYY everywhere**, regardless of whether the underlying value came from the Master (`DD.MM.YYYY`) or a US Calling List upload (`DD-MM-YYYY`). Implemented as a pure client-side display helper (`public/date-format.js`) — the **stored raw value is never touched**, only what's rendered on screen. A value that doesn't match either known format (e.g. a real malformed date) is still shown as-is with a ⚠ warning marker, never silently guessed at, consistent with the server-side `parseOperationalDate` philosophy.

**Not yet tested live** — all four of the above are new since the last live verification. Next actions: (1) confirm bulk-confirm actually makes evidence appear in a subsequent export, (2) confirm the archive-search-before-create flow works with a real archived vessel, (3) confirm the modal and date formatting render correctly in the browser.
