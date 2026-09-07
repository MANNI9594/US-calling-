# US Calling Master Manager

A personal, single-user, browser-based tool for managing a US Calling Vessel Master Excel workbook: uploading updated ETA/ETD lists, matching vessels, reviewing changes, archiving/restoring vessels, and exporting an updated Master workbook — without ever requiring software installation on the office PC.

**Status:** Phase 3 of 11 complete (Master Import). See `docs/ROADMAP.md` for exactly what's built, tested, and what's next. **Currently deployed and live on Railway** — `/api/health` on your deployed URL confirms it's running.

## Start here

| Document | What it covers |
|---|---|
| `docs/EXCEL_STRUCTURE_FINDINGS.md` | Phase 1 findings from the real reference workbook — read this first, it explains *why* the schema looks the way it does |
| `docs/ARCHITECTURE.md` | System design, stack choices, provider-independence, atomicity |
| `docs/DATABASE.md` | Schema documentation |
| `docs/EVIDENCE_MAPPING.md` | The evidence review workflow (why images are a reviewable entity, not a decoration) |
| `docs/DEPLOYMENT.md` | Local dev setup + production deployment (Railway/Render/any Docker host) — **run this yourself, no IT needed** |
| `docs/ROADMAP.md` | Phase-by-phase status, known issues, what's next |

## Project layout

```
us-calling-master-manager/
├── docker-compose.yml      # local dev: Postgres + backend + Adminer
├── docs/                   # all project documentation
└── backend/
    ├── prisma/schema.prisma
    ├── src/
    │   ├── config/         # env validation
    │   ├── db/             # Prisma client singleton
    │   ├── middleware/     # auth, error handling
    │   ├── routes/         # auth, vessels, evidence, health
    │   └── services/
    │       ├── storage/    # local disk / S3-compatible, swappable via env
    │       ├── audit/      # audit log writer
    │       ├── dataQuality/# date/IMO validators + flag creation
    │       └── excel/      # Master workbook reader (ExcelJS)
    └── tests/              # includes tests run against the real reference workbook
```

## Quick start (development)

```bash
docker compose up -d db
cd backend
cp .env.example .env      # then set SESSION_SECRET
npm install
npx prisma generate
npx prisma migrate dev --name init
npm test
npm run dev
```

Full detail, including production deployment, is in `docs/DEPLOYMENT.md`.

## Core principles this codebase enforces structurally, not just by convention

- **Remove from Active Master ≠ delete.** There is no code path that deletes a `Vessel` row as part of the normal remove flow — only a status flip to `ARCHIVED`, with a separate, explicitly-confirmed permanent-delete action planned for later.
- **Evidence images are never silently dropped, overwritten, or auto-confirmed.** Every review-state transition to `CONFIRMED` requires a human action (`backend/src/routes/evidence.routes.ts`).
- **Data quality is flagged, never silently fixed.** `parseOperationalDate()` returns `null` rather than guessing on a malformed date like the real `06.09.026` value found in the reference workbook; the caller is required to record a `DataQualityIssue`.
- **Vessel name matching cannot silently merge different vessels.** `normalizeVesselName()` only collapses whitespace/case/punctuation — it has no fuzzy/phonetic logic, by design (see its doc comment).
