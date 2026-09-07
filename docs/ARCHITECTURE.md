# Architecture

## Conceptual model

```
VESSEL
  |
  +-- Permanent Master Data (name, IMO, flag, type, owners, bridge letter, ...)
  |
  +-- Evidence Records (0..N)
  |       +-- original image asset (never overwritten)
  |       +-- OCR text / extracted fields (if available)
  |       +-- association method + confidence
  |       +-- review status (CONFIRMED / NEEDS_REVIEW / UNASSIGNED / REJECTED_*)
  |
  +-- Calling Records (history; exactly one is "current")
  |       +-- Arrival Port, ETA, ETD, Ballast/Loaded, Voyage Type, ...
  |
  +-- Active / Archived status
  |
  +-- Data Quality Issues (open/acknowledged/resolved flags, never silent fixes)
  |
  +-- Audit Log entries
```

This mirrors the conceptual model the user specified directly. The key departure from a naive "just model the 17 Excel columns" approach is that **Evidence is a first-class, independently reviewable entity**, not an attachment inferred from Excel row position — because the source workbook proved position isn't trustworthy (see `EXCEL_STRUCTURE_FINDINGS.md`).

## Why this stack

| Layer | Choice | Why |
|---|---|---|
| API | Node.js + TypeScript + Express | Small, well-understood, no framework magic to fight when the core work is file processing + CRUD + auth |
| ORM | Prisma | Schema-as-code, generated types keep the Vessel/Evidence/CallingRecord relationships correct at compile time, straightforward migrations |
| Database | PostgreSQL | Relational integrity for the Vessel↔Evidence↔CallingRecord graph; JSON columns where genuinely unstructured (OCR field guesses, audit detail) |
| Excel | ExcelJS | Can read *and* write existing workbooks (formatting, images, styles) rather than only flattening to values — required by the "don't destroy the original workbook" constraint |
| Storage | Provider-agnostic interface (local disk or S3-compatible) | Deployment must not be locked to one cloud provider |
| Auth | Server-side sessions (bcrypt + hashed session tokens in an httpOnly cookie) | Single user, but "simple" should still mean revocable sessions, not a JWT no one can invalidate |

## Provider independence

Nothing in the application code imports a cloud SDK directly except inside `src/services/storage/S3StorageProvider.ts`, and that file is selected only via `STORAGE_PROVIDER=s3` — swapping to `local` disk, or to a different S3-compatible vendor (Cloudflare R2, Backblaze B2, MinIO, DigitalOcean Spaces) via `STORAGE_S3_ENDPOINT`, is a config change, not a code change. The same principle applies to the database (`DATABASE_URL` — any managed Postgres works) and to the reverse proxy/TLS termination (handled by whichever host is chosen; the app itself just trusts `X-Forwarded-*` headers via `trust proxy`).

The `docker-compose.yml` at the repo root runs the whole stack locally with zero cloud dependency, and the same `Dockerfile` is what a host like Railway or Render builds from — there is no "local-only" code path that diverges from what runs in production.

## Atomicity

Every operation that changes the vessel/evidence graph in a way the user cares about not being half-done — Master import, US Calling List processing, evidence bulk-repair, restore, backup restore — runs inside a single Prisma `$transaction`. If any step throws, Postgres rolls the whole thing back; the API returns an error and the previous state is exactly as it was. This is enforced structurally (the route handler owns one transaction boundary) rather than by convention, so "did this partially apply" is not a question that can come up.

`ImportBatch.status` tracks this at the application level too (`PENDING` → `PROCESSING` → `COMPLETED` or `FAILED`), so the UI and audit log can show "this US Calling List upload from Tuesday failed and changed nothing" rather than just silently not showing new data.

## Evidence review pipeline (implemented in phases)

1. **Extraction** (Phase 3): every embedded image, plus its raw anchor position, is read from the uploaded workbook and stored as a `VesselEvidence` row. Cleanly-anchored images (33 of 43 in the reference file) get `associationMethod = ORIGINAL_ANCHOR` and `reviewStatus = NEEDS_REVIEW` — even a clean anchor is not auto-confirmed, because "clean in the source file" and "correct" are different claims.
2. **Repair** (Phase 4): the row-2 pileup and unanchored vessels get OCR run against them (`ocrExtractedText`, `ocrExtractedFields`), a best-effort vessel match with a confidence score, `associationMethod = OCR_AUTO_MATCH`, and `reviewStatus = NEEDS_REVIEW`. Anything below a confidence threshold (to be tuned against the real file, not guessed) goes to `UNASSIGNED` instead of a low-confidence guess.
3. **Review** (ongoing, UI + API already built in Phase 2): the user confirms, reassigns, or rejects (duplicate/irrelevant) each record. Rejection never deletes the file — it only changes `reviewStatus` so the record stops appearing in active queues.
4. **Export** (Phase 9): only `CONFIRMED` evidence is placed into the exported workbook, keyed by `vesselId`, never by original anchor position.

## What's deliberately NOT built yet (see ROADMAP.md)

Master import, the matching engine, US Calling List processing, and XLSX export all depend on the schema and review workflow being right first — per explicit instruction, none of that logic was rushed ahead of Phase 2. The read-only `masterWorkbookReader.ts` exists now because it's foundational and independently testable against the real file; it does not yet create any database records.
