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

## Phase 5 — US Calling List Processor — NOT STARTED

Planned: upload, header-tolerant column mapping, date normalization (`DD-MM-YYYY`), matching engine (IMO → exact normalized name → manual review), proposed-change computation.

## Phase 6 — Review — NOT STARTED

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
