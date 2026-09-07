# Database Schema

Full source of truth: `backend/prisma/schema.prisma`. This document explains the *why* behind it; the schema file itself carries inline comments for the *what*.

## Entity summary

| Model | Purpose |
|---|---|
| `User` / `Session` | Single-user auth. Modeled as real tables (not a hardcoded env-var login) so password changes and session revocation are data operations. |
| `Vessel` | Permanent Master profile only. Never touched by a US Calling List upload except through explicit, reviewed edits. |
| `VesselCallingRecord` | One row per "version" of operational data (Port/ETA/ETD/Ballast-Loaded/Voyage Type/...). Exactly one `isCurrent = true` per vessel; prior rows are history, not overwritten in place. |
| `VesselEvidence` | The IMO-website screenshots. `vesselId` is nullable (Unassigned Evidence pool). Carries association method/confidence, review status, OCR output, and forensic source-anchor fields. |
| `MatchReviewItem` | Ambiguous vessel matches surfaced during a US Calling List upload, pending user resolution. |
| `DataQualityIssue` | Every flagged-not-fixed problem (bad date, implausible IMO, ETD before ETA, past ETD, etc.), scoped to a Vessel, CallingRecord, or Evidence record. |
| `ImportBatch` | Every Master import, US Calling List upload, export, and backup operation, with a status and JSON summary — the atomicity/audit backbone. |
| `AuditLog` | Practical single-user history: one row per meaningful event, with a human-readable summary and structured `detailJson`. |

## Why operational fields live where they do

The spec's own phrasing ("Ballast/Loaded", "Arrival Port", "ETA", "ETD" are properties of *a call*, not of the ship) is taken literally: all four live on `VesselCallingRecord`, not `Vessel`. This means:

- Updating ETA/ETD from a new US Calling List never touches the `Vessel` row at all — it creates (or updates, per the "one current record" rule) a `VesselCallingRecord`.
- History is automatic: querying non-current `VesselCallingRecord` rows for a vessel *is* its ETA/ETD/Port history, with no separate change-log table needed for those fields specifically (the generic `AuditLog` still records the *event* of a change, for a unified timeline).

## Why `VesselEvidence.vesselId` is nullable

This is the single most load-bearing decision in the schema, driven directly by the Phase 1 finding that 17 image anchors in the real file are stacked on one row with no reliable owner. An evidence record must be able to exist in the database **before** anyone — human or OCR — has decided which vessel it belongs to. Making `vesselId` required would force a guess at import time; making it nullable lets "Unassigned Evidence" be a real, queryable state (`reviewStatus = UNASSIGNED`) rather than something bolted on later.

## Why matching isn't done with a fuzzy-similarity column

There is deliberately no `similarity_score` float column on `Vessel` for name matching. Fuzzy scoring for an *incoming* US Calling List row is a point-in-time computation belonging to `MatchReviewItem` (one row per ambiguous incoming record, with a `candidateScore`), not a property of the vessel itself — a vessel isn't "70% similar to itself" in any lasting sense. This keeps `Vessel.vesselNameNormalized` doing exactly one job (deterministic exact-match comparison after whitespace/case/punctuation normalization) and keeps the fuzzy, human-reviewed logic in its own table where it can't accidentally get treated as ground truth.

## Partial unique index (documented now, applied in the first migration)

Prisma's schema DSL can't express "unique only where not null" directly. Once `npx prisma migrate dev --name init` is run (see `DEPLOYMENT.md`), add this by hand to the generated migration SQL, or as a follow-up migration:

```sql
CREATE UNIQUE INDEX vessels_imo_number_unique
  ON vessels (imo_number)
  WHERE imo_number IS NOT NULL;
```

This prevents two `Vessel` rows from silently sharing an IMO number, while still allowing any number of vessels with no IMO recorded at all.

## Enums over free-text

Every status field (`VesselStatus`, `EvidenceReviewStatus`, `DataQualityIssueType`, `AuditEventType`, etc.) is a Postgres enum via Prisma, not a `varchar`. For a single-user tool this trades a small amount of migration friction (adding a new enum value needs a migration) for the API and UI never having to defend against a typo'd status string silently creating a fourth, unintended state.

## Migrations

No migration has been generated inside this sandbox — `prisma migrate dev` needs a live Postgres connection (via `docker-compose up db`) and network access to Prisma's engine binaries, neither of which this build environment has (see `DEPLOYMENT.md` for exactly what to run and where). The schema itself has been syntax-checked by hand and via `tsc` against the fields it's expected to expose; the actual `migrations/` SQL will be generated the first time you run it locally.
