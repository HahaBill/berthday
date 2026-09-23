# PRD — Berthday

*Every vessel, the right berth, on the right day.* A dock scheduling app for the Harborview Marine
Research Center (the facility named in the sample workbook).

**Audience:** an autonomous coding agent (Codex) building and deploying this app end to end.
**Owner:** Bill Nguyen. **Deadline:** today. Ship P0 first, deploy it, then add P1, then P2.
**Inputs in the repo root:** this `PRD.md` and the legacy workbook (`Dock Schedule - Synthetic Sample*.xlsx`).

> Read the whole document before writing code. Sections marked **MUST** are acceptance criteria.
> Appendix A is a *verified* migration script and Appendix B its golden tests: they were run against
> the provided workbook and pass. Copy them verbatim; do not rewrite the parsing logic.

---

## 1. Problem

A marine research facility schedules berths of different lengths. Vessels reserve a berth for a range of
days; non-vessel events (community sail days) and maintenance closures also occupy berths. Today this lives
in a workbook with one sheet per year (1997–2019), where a booking is a coloured bar on a berth-by-day grid.
Staff check double-bookings by eye and check by hand that each vessel fits its berth.

**Goal:** a web app where the software, not a person, guarantees:

1. **No double-bookings.** A berth is never booked twice on the same day.
2. **Vessels fit.** A vessel is never booked into a berth shorter than it is.

…and that makes 23 years of messy legacy data usable and reviewable instead of silently "cleaned".

The reviewers grade: *does it work, how is it structured, what assumptions were made, how clearly are the
decisions explained.* Polish is secondary. Correctness, clarity and a written rationale are primary.

## 2. Users and jobs

The primary user is the **dock coordinator**, who books berths and answers "what's where". Their jobs:

- *Book a vessel* for a date range and be told immediately, with a reason, if it clashes or doesn't fit, and
  what would work instead.
- *Find a berth:* "which berths can take a 120 ft vessel from 3–10 July?"
- *See the month* at a glance, in the berth × day layout they already know.
- *Clean up history:* review double-bookings and fit problems found in the legacy data.
- *Fill in missing facts:* 470+ vessels have no recorded length; entering one re-checks that vessel's history.

Reviewers will open the public URL cold, on a laptop, probably in New York (UTC−4).

## 3. Scope

| Priority | Feature |
|---|---|
| **P0** | Migration of the workbook (Appendix A) into D1 via CI; import report page |
| **P0** | Month schedule grid (berth × day) generated from records, with issue highlighting |
| **P0** | Create / edit / delete bookings with server-side validation (rules O, F, V in §6) |
| **P0** | 409/422 responses that carry concrete alternatives (other berths, shifted dates) |
| **P0** | "Find a berth" availability search |
| **P0** | Issues page: legacy double-bookings, fit violations, vessel-in-two-places; mark reviewed |
| **P0** | Vessel registry with editable length; editing a length re-checks fit |
| **P0** | CI/CD: GitHub Actions tests, provisions D1, migrates, seeds once, deploys to Workers |
| **P0** | README + DECISIONS.md (assumptions, decisions, questions for the client) |
| **P1** | Natural-language "Ask" bar → structured filter (Workers AI) with a deterministic fallback |
| **P1** | Bookings list page with filters + CSV export |
| **P1** | API integration tests with `@cloudflare/vitest-pool-workers` |
| **P2** | Drag-to-select a date range on the grid; keyboard month navigation |

**Non-goals:** authentication/roles, payments, notifications, time-of-day scheduling, multi-facility,
the `Tours` sheet, vessel contact directories, rafting/length-sharing (see §6.4).

## 4. What is in the workbook (verified facts)

These were verified by running Appendix A. The migration handles every one; the app must surface them.

- 23 annual sheets (`1997`–`2019`) plus `8YR Dock Summary`, `Science`, `Yachts`, `Tours`.
- Six berths with lengths in their row label: North Pier West 410', North Pier Face 75', North Pier East
  240', Inner Channel 55', South Float West 90', South Float East 90'. Two shared resources without a length
  appear later: `Small craft slips (institution boats)` (from 2011) and `North Finger Piers` (from 2014).
- A booking is a bar: a merged range and/or same-coloured cells, with the name somewhere in it (sometimes not
  at the start), continuing across month boundaries. Colours are reused between vessels.
- 1997–2001 day numbers are `=SUM(B3+1)` formulas **with no cached values** (a naive reader sees blanks).
- The day-1 column moves (B, C, E, F, G…). Sheet 2010's last two months are headed `NOVEMBER 2018` /
  `DECEMBER 2018` and their day numbers are split across two rows that disagree. June 2008 lists a 31st,
  February 2009 a 29th, January 2012 stops at the 30th.
- Sheets 2002–2004 open with a copy of the previous December; all three copies disagree with the original.
- Some months have two rows for the same berth (North Pier West, Sept 1998; South Float East every month
  from April 2017). These are the only place literal double-bookings exist.
- Rows with no label under South Float East hold bookings (imported to "Unassigned (legacy rows)").
- Only ~165 of 635 vessels have a length (from `Science`/`Yachts`, e.g. `M/V IRON HERON 100'`); 5 have
  conflicting lengths (e.g. M/V Deep Reef 24' vs 100').
- `8YR Dock Summary` credits North Pier West with 648 days in 2012 — more days than a year has — implying
  several vessels share that pier at once. See §6.4.

Expected migration output (asserted by Appendix B): **2,587 reservations** (2,047 vessel, 89 event,
49 closure, 402 hold), **635 vessels**, **9 resources**, **48 schedule issues** (4 overlap, 29 fit,
15 vessel-in-two-places), data range **1997-08-01 → 2019-12-31**, longest stay **425 days**.

## 5. Architecture

- **Single Cloudflare Worker** serving the React SPA as static assets and a JSON API under `/api/*`.
- **D1** (SQLite) for storage. **Workers AI** for the Ask bar (P1).
- **TypeScript** everywhere except the one-off migration (Python 3.12 + openpyxl, Appendix A).
- Business rules live once in `shared/domain.ts`, used by the Worker (authoritative) and the UI (hints only).

```
Browser (React SPA) ──fetch /api/*──▶ Worker (Hono) ──▶ D1
                                         └──────────▶ Workers AI (Ask bar only; never decides availability)
GitHub Actions: pytest → migration → vitest → build → ensure D1 → migrate → seed-if-empty → deploy → smoke test
```

### 5.1 Stack (use latest stable versions unless pinned)

Runtime deps: `react`, `react-dom`, `react-router` (v7, library mode), `@tanstack/react-query`, `zod`,
`hono`, `@hono/zod-validator`, `@fontsource/barlow`, `@fontsource/barlow-semi-condensed`.
Dev deps: `vite`, `@vitejs/plugin-react`, `typescript`, `wrangler@^4` (**≥ 4.20** for `run_worker_first`
arrays), `vitest`, `concurrently`; P1: `@cloudflare/vitest-pool-workers`.
Styling: plain CSS with custom properties (no Tailwind, no component kit). Python: `openpyxl>=3.1,<4`,
`pytest>=8` in `migration/requirements.txt` (verified with openpyxl 3.1.5, Python 3.12).

### 5.2 Repository layout (MUST)

```
PRD.md
README.md                     # how to run, deploy, reseed; links to DECISIONS.md
DECISIONS.md                  # assumptions, decisions, open questions (see §14)
data/dock_schedule.xlsx       # move the uploaded workbook here (rename)
migration/
  extract.py                  # Appendix A, verbatim
  requirements.txt            # openpyxl>=3.1,<4 ; pytest>=8
  tests/test_extract.py       # Appendix B, verbatim
  out/                        # generated; gitignored
migrations/0001_init.sql      # §7, verbatim
shared/
  dates.ts  domain.ts  schemas.ts  types.ts
  __tests__/dates.test.ts  domain.test.ts  parity.test.ts
worker/
  index.ts                    # Hono app, error handler, route mounting
  db.ts                       # all SQL lives here
  routes/{meta,berths,vessels,reservations,availability,issues,imports,ask,export}.ts
  ask/{prompt.ts,fallback.ts}
src/                          # React SPA
  main.tsx  App.tsx  api.ts  styles/tokens.css  styles/app.css
  views/{ScheduleView,BookingsView,IssuesView,VesselsView,ImportView}.tsx
  components/{MonthGrid,BookingForm,BookingDrawer,FindBerthPanel,AskBar,IssueList,LengthGauge}.tsx
index.html  vite.config.ts  tsconfig.json  tsconfig.worker.json  wrangler.jsonc  package.json
worker-configuration.d.ts     # from `wrangler types`, committed
scripts/ci/ensure-d1.mjs  scripts/ci/seed-if-empty.sh
.github/workflows/deploy.yml
```

## 6. Domain rules (MUST)

### 6.1 Dates

- A date is an ISO string `YYYY-MM-DD`. A booking covers `start_date` **through** `end_date` inclusive
  (a coloured cell in the old grid = occupied that day). `end_date >= start_date`.
- All date math goes through `shared/dates.ts` using **UTC only** (`Date.UTC`, `getUTC*`). Never
  `new Date('2019-12-01').getDate()` or any local-time getter: in New York that returns Nov 30.
  `dates.ts` exports: `isValidDate`, `addDays`, `diffDays`, `daysInMonth`, `monthStart`, `monthEnd`,
  `eachDay`, `sharedDays(a, b)`, `todayIn(tz?)`. Test February 29 in 2000, 2019, 2020.
- The client sends its local "today" to endpoints that need it (the Ask bar); the server never guesses.

### 6.2 Resources (berths)

`berths.is_exclusive = 1` for the six length-labelled berths. `0` for `small-craft-slips`,
`north-finger-piers` (shared pools) and `unassigned` (legacy holding pen). `length_ft` is `NULL` for all three.

### 6.3 Booking kinds

`vessel` (requires `vessel_id`), `event` (e.g. community sail day), `closure` (maintenance, "no docking"),
`hold` (berth held without a name; legacy unlabelled bars import as holds). Every kind occupies the berth.

### 6.4 The three rules

| Rule | Applies to | Definition | On write |
|---|---|---|---|
| **O — overlap** | exclusive berths | two bookings on the same berth share ≥ 1 day | reject 409 `BERTH_CONFLICT` |
| **F — fit** | `vessel` bookings on berths with a length | `vessel.length_ft > berth.length_ft` | reject 422 `FIT_VIOLATION` |
| **V — vessel in two places** | `vessel` bookings | same vessel on different berths sharing **≥ 2** days | reject 409 `VESSEL_CONFLICT` |

- Rule O is strict: same-day turnover (one leaves 0600, another arrives 1400) is **not** supported because the
  model is day-granular, exactly like the old grid. Documented as future work.
- Rule V allows exactly one shared day: a vessel shifting berths shows on both that day (the legacy data
  does this 14 times).
- Rule F with unknown length (`vessel.length_ft` or `berth.length_ft` NULL): allowed; `fitStatus = 'unverified'`.
  Disputed lengths use the larger value (conservative) and say so.
- No new booking may target `unassigned` (422 `UNASSIGNED_TARGET`); legacy ones there can be moved *out*.
- App-created bookings span at most **366** days (400 `VALIDATION_ERROR`).
- **Assumption to document:** a berth takes one booking at a time. The workbook hints otherwise for the
  410' pier (§4). Length-sharing ("sum of LOAs ≤ berth length") is the first extension; it replaces rule O
  per berth via an `is_exclusive`-style flag and is listed in DECISIONS.md as the #1 client question.

### 6.5 Fit status (derived, never stored)

`'ok'` | `'violation'` | `'unverified'` (either length unknown) | `'n/a'` (non-vessel booking). Computed with a
JOIN at read time, so entering a vessel length immediately changes every booking of that vessel.

### 6.6 Alternatives (the "smart resolution", deterministic, no LLM)

`suggestAlternatives(candidate, context) → { berths: BerthOption[], dateShifts: DateShift[] }`:

1. **Other berths:** every exclusive berth except the requested one and `unassigned` where rules O and V pass
   for the same dates. Include berths where fit is `ok` or `unverified`; exclude `violation`. Sort: `ok`
   before `unverified`, then **ascending length** (best fit keeps big berths free for big ships). Max 3.
2. **Same berth, shifted dates:** keep the duration; search the nearest free window up to 60 days later and
   up to 60 days earlier where O and V pass. Return at most one earlier and one later, with `days` moved.
3. Closures and holds are never suggested to move.

Pure function in `shared/domain.ts`; the Worker supplies the candidate reservations for the window.

### 6.7 Schedule issues (the review queue)

Table `issues` holds legacy violations of O, F, V, produced by the migration. The Worker keeps it consistent:

- **Create:** validated, so creates no issues.
- **Update** of a key field (`berth_id`, `start_date`, `end_date`, `kind`, `vessel_id`): validated like a
  create (excluding itself); on success `DELETE FROM issues WHERE reservation_id = ?1 OR other_reservation_id = ?1`.
  Updates of `title`/`notes` only skip validation and leave issues untouched (so a legacy record in conflict
  can still get a note).
- **Delete:** its issues go too (FK `ON DELETE CASCADE`; also delete explicitly).
- **Vessel length change:** delete that vessel's `fit` issues, then insert a `fit` issue for each of its
  bookings that now violates F (id `fi-` + random). Return the count so the UI can say
  "2 bookings for M/V Clear Tern are now too long for their berth".
- **Mark reviewed:** sets `reviewed_at` and optional `review_note`; reviewed issues are hidden by default.

## 7. Data model (MUST, verbatim as `migrations/0001_init.sql`)

```sql
-- Berthday schema. Dates are ISO 'YYYY-MM-DD' strings; ranges are INCLUSIVE on both ends.
CREATE TABLE berths (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  length_ft INTEGER CHECK (length_ft IS NULL OR length_ft > 0),
  is_exclusive INTEGER NOT NULL DEFAULT 1 CHECK (is_exclusive IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  source TEXT
);

CREATE TABLE vessels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  length_ft INTEGER CHECK (length_ft IS NULL OR length_ft > 0),
  length_status TEXT NOT NULL CHECK (length_status IN ('known', 'unknown', 'disputed')),
  length_note TEXT,
  source TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE reservations (
  id TEXT PRIMARY KEY,
  berth_id TEXT NOT NULL REFERENCES berths(id),
  kind TEXT NOT NULL CHECK (kind IN ('vessel', 'event', 'closure', 'hold')),
  vessel_id TEXT REFERENCES vessels(id),
  title TEXT,
  start_date TEXT NOT NULL CHECK (start_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  end_date TEXT NOT NULL CHECK (end_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  notes TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('legacy', 'app')),
  source_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (end_date >= start_date),
  CHECK ((kind = 'vessel') = (vessel_id IS NOT NULL)),
  CHECK (kind = 'vessel' OR (title IS NOT NULL AND length(trim(title)) > 0))
);
CREATE INDEX idx_res_berth_start ON reservations (berth_id, start_date);
CREATE INDEX idx_res_start ON reservations (start_date);
CREATE INDEX idx_res_vessel_start ON reservations (vessel_id, start_date);

CREATE TABLE issues (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('overlap', 'fit', 'vessel_double')),
  reservation_id TEXT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  other_reservation_id TEXT REFERENCES reservations(id) ON DELETE CASCADE,
  berth_id TEXT REFERENCES berths(id),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  details TEXT,
  reviewed_at TEXT,
  review_note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_issues_start ON issues (start_date);
CREATE INDEX idx_issues_res ON issues (reservation_id);
CREATE INDEX idx_issues_other ON issues (other_reservation_id);

CREATE TABLE import_issues (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warn', 'error')),
  sheet TEXT,
  cell TEXT,
  message TEXT NOT NULL,
  reservation_id TEXT
);
CREATE INDEX idx_import_issues_code ON import_issues (code);

CREATE TABLE app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

`app_meta` keys written by the seed: `import_summary` (JSON), `data_range` (JSON `{from,to}`),
`max_span_days` (integer as text).

## 8. Performance and platform limits (MUST)

D1 on the free plan allows 5 million rows read and 100,000 rows written per day; when exceeded, queries fail
until 00:00 UTC. A Worker on the free plan gets 10 ms CPU per request and 50 D1 queries per invocation.
Design so a reviewer clicking around all day stays far below that:

- **Every date-window query is bounded below** so it uses an index range, never a full scan:
  `start_date <= :to AND end_date >= :from AND start_date >= date(:from, '-' || :span || ' days')`
  where `:span = max(app_meta.max_span_days, 366)` (cache per isolate in a module variable).
- Conflicts are **not** computed by self-joins at read time; they come from the `issues` table (§6.7).
- Lists paginate (`limit` ≤ 200, keyset cursor on `(start_date, id)`).
- Never parse the workbook in the Worker. Seeding happens only via `wrangler d1 execute --file` in CI.
- Seeding writes ~14k rows; a reseed is manual (workflow input) and at most once a day on the free plan.

## 9. API (MUST)

JSON over `/api`. Validate every input with zod (`shared/schemas.ts`). Responses use camelCase DTOs; the DB
uses snake_case; map in `worker/db.ts`. Errors always have this shape:

```json
{ "error": { "code": "BERTH_CONFLICT", "message": "North Pier East is booked by R/V Golden Compass on 12–14 Apr 2010.",
             "conflicts": [ /* ReservationDTO[] */ ], "alternatives": { "berths": [], "dateShifts": [] } } }
```

Codes: `VALIDATION_ERROR` 400, `NOT_FOUND` 404, `BERTH_CONFLICT` 409, `VESSEL_CONFLICT` 409,
`VESSEL_EXISTS` 409, `FIT_VIOLATION` 422, `UNASSIGNED_TARGET` 422, `INTERNAL` 500. Messages are specific
and name the berth, vessel, lengths and dates ("M/Y Wild Tern is 145 ft; South Float East takes up to 90 ft.").

### 9.1 DTOs (`shared/types.ts`)

```ts
type Kind = 'vessel' | 'event' | 'closure' | 'hold';
type FitStatus = 'ok' | 'violation' | 'unverified' | 'n/a';
interface BerthDTO { id: string; name: string; lengthFt: number | null; isExclusive: boolean; sortOrder: number }
interface VesselDTO { id: string; name: string; lengthFt: number | null;
  lengthStatus: 'known' | 'unknown' | 'disputed'; lengthNote: string | null; bookingCount?: number }
interface ReservationDTO { id: string; berthId: string; kind: Kind; vesselId: string | null;
  vessel: { id: string; name: string; lengthFt: number | null; lengthStatus: string } | null;
  title: string | null; startDate: string; endDate: string; notes: string | null;
  origin: 'legacy' | 'app'; sourceRef: string | null; fitStatus: FitStatus;
  issues: { id: string; type: IssueType; reviewed: boolean }[]; createdAt: string; updatedAt: string }
type IssueType = 'overlap' | 'fit' | 'vessel_double';
interface IssueDTO { id: string; type: IssueType; startDate: string; endDate: string; berthId: string | null;
  reservation: ReservationDTO; other: ReservationDTO | null; details: Record<string, unknown>;
  reviewedAt: string | null; reviewNote: string | null }
interface Alternatives { berths: { berthId: string; berthName: string; lengthFt: number | null; fit: 'ok' | 'unverified' }[];
  dateShifts: { startDate: string; endDate: string; direction: 'earlier' | 'later'; days: number }[] }
```

### 9.2 Endpoints

| Method & path | Purpose |
|---|---|
| `GET /api/health` | `{ ok: true, version: env.APP_VERSION }` (CI sets it to the short git SHA) |
| `GET /api/meta` | `{ dataRange, importSummary, berths: BerthDTO[] }` — one call to boot the UI |
| `GET /api/reservations?from&to&berthId&vesselId&kind&q&hasIssues&limit&cursor` | window query (§8). `from`/`to` required, max 400 days apart. `q` matches vessel name or title (`LIKE`, case-insensitive) |
| `GET /api/reservations/:id` | one booking with issues |
| `POST /api/reservations` | body `{ berthId, kind, vesselId?, title?, startDate, endDate, notes? }` → 201 DTO, or 400/409/422 with alternatives |
| `PATCH /api/reservations/:id` | partial body; validation rules in §6.7 |
| `DELETE /api/reservations/:id` | 204 |
| `GET /api/availability?start&end&lengthFt?&vesselId?&excludeId?` | per berth: `{ berth, status: 'available'｜'too_short'｜'busy'｜'unverified'｜'shared', conflicts: ReservationDTO[] }`, sorted available-first then by length |
| `GET /api/vessels?q&lengthStatus&limit&cursor` | registry, with `bookingCount` |
| `POST /api/vessels` | `{ name, lengthFt }` (length required, 1–1000) → 201; 409 `VESSEL_EXISTS` if `name_key` exists |
| `PATCH /api/vessels/:id` | `{ lengthFt?, name? }` → `{ vessel, newFitIssues: number, clearedFitIssues: number }`; sets `length_status='known'`, clears `length_note` |
| `GET /api/issues?type&from&to&berthId&includeReviewed=false&limit&cursor` | review queue, newest-first by default |
| `POST /api/issues/:id/review` | `{ note? }` → IssueDTO |
| `GET /api/import/issues?code&severity&limit&offset` | migration log; plus `GET /api/import/codes` → counts per code |
| `POST /api/ask` (P1) | §11 |
| `GET /api/export.csv?from&to` (P1) | CSV of bookings in window, same columns as the DTO |

### 9.3 Write path (MUST, race-safe)

D1 runs a database's queries one at a time, so a single conditional statement is atomic:

1. Validate shape (zod), dates, kind/vessel/title consistency, span ≤ 366, target ≠ `unassigned`.
2. Load berth and vessel; check rule F in code → 422 with alternatives.
3. Run the conflict SELECTs (for a good error message).
4. Insert with the guard below; if `meta.changes === 0`, re-run step 3 and return 409 with alternatives.

```sql
INSERT INTO reservations (id, berth_id, kind, vessel_id, title, start_date, end_date, notes,
                          origin, source_ref, created_at, updated_at)
SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'app', NULL, ?9, ?9
WHERE ((SELECT is_exclusive FROM berths WHERE id = ?2) = 0 OR NOT EXISTS (
        SELECT 1 FROM reservations o
        WHERE o.berth_id = ?2 AND o.start_date <= ?7 AND o.end_date >= ?6
          AND o.start_date >= date(?6, '-' || ?10 || ' days')))
  AND (?4 IS NULL OR NOT EXISTS (
        SELECT 1 FROM reservations o
        WHERE o.vessel_id = ?4 AND o.berth_id <> ?2 AND o.start_date <= ?7 AND o.end_date >= ?6
          AND o.start_date >= date(?6, '-' || ?10 || ' days')
          AND julianday(min(o.end_date, ?7)) - julianday(max(o.start_date, ?6)) >= 1));
```

`UPDATE` uses the same guard plus `AND o.id <> ?id` inside both subqueries. IDs for new rows:
`crypto.randomUUID()`. Timestamps: `new Date().toISOString()`.

## 10. UI (MUST unless marked)

### 10.1 Design tokens (`src/styles/tokens.css`)

Grounded in harbour charts and navigation marks, not a generic dashboard. Calm, dense, legible.
The product name is **Berthday**; the pun lives in the name and the tagline only, while the interface
copy stays plain and operational ("Save booking", not "Party time").

| Token | Value | Use |
|---|---|---|
| `--chart` | `#F4F7F8` | page background (cool chart paper, not cream) |
| `--ink` | `#14212B` | text, grid lines at 12% opacity |
| `--harbour` | `#1F5F8B` | vessel bars, primary buttons |
| `--port-red` | `#C23B32` | overlap / vessel-in-two-places, destructive actions |
| `--starboard` | `#2E7D4F` | "available" |
| `--signal-amber` | `#C98A0B` | fit violation (solid outline), unverified fit (dotted) |
| `--slate` | `#6B7A86` | closures (diagonal hatch), holds (dashed outline, 40% fill) |
| `--sail` | `#2B8C8C` | events |

Type: **Barlow** for UI text, **Barlow Semi Condensed** for grid labels and bars (vessel names must fit in
day cells), both self-hosted via `@fontsource`. `font-variant-numeric: tabular-nums` for dates and lengths.
Sentence case everywhere; no all-caps labels. Buttons say what they do: "Save booking", "Delete booking",
"Mark reviewed", "Book this berth". Errors name the fix. Quality floor: visible keyboard focus, AA contrast,
`prefers-reduced-motion` respected, usable at 1280 px and down to 390 px (grid scrolls horizontally).

**Signature element — the length gauge:** each berth row header shows a thin horizontal bar proportional to
its length (410' = full width). When a vessel or length is chosen in the booking form or Find a berth, a
vertical marker appears at that length across every gauge and berths shorter than it dim. This is the one
bold visual; keep everything else quiet.

### 10.2 Layout

```
┌ Berthday · Harborview ─────────────── [ Ask about the schedule…        ] [Find a berth] [New booking] ┐
│ Schedule · Bookings · Issues (48) · Vessels · Migration                                               │
├───────────────────────────────────────────────────────────────┬───────────────────────────────────────┤
│ ◀ December 2019 ▶  [month picker] [Latest data] [Today]       │ Issues this month (n)                 │
│ Berth / gauge        │ 1 2 3 4 5 … 31                         │  • double-booking …   [Show]          │
│ North Pier West 410' │ ███ R/V Golden Compass ███             │  • too long for berth … [Show]        │
│ …                    │                                        │                                       │
└──────────────────────┴────────────────────────────────────────┴───────────────────────────────────────┘
```

### 10.3 Schedule (`/?month=YYYY-MM&focus=<id>`)

- Default month on first load: the month of `dataRange.to` (**December 2019**), not today — otherwise
  reviewers land on an empty grid. "Today" and "Latest data" buttons both exist.
- Rows: exclusive berths by `sort_order`, then pools; `Unassigned (legacy rows)` only when it has bookings
  in the month. Row header: name, length, gauge.
- Columns: one per day; header shows day number and weekday initial; weekends lightly shaded.
- Bars: CSS grid, `grid-column: startDay / endDay+1` clipped to the month; a notch on the edge when the
  booking continues into the previous/next month. Overlapping bars on one berth stack in lanes (greedy
  interval partitioning) so nothing hides. Kind styles per tokens. Label = vessel name or title, ellipsised;
  `title` attribute with full name, dates, length, fit status, source.
- Issue decoration: unreviewed overlap / vessel-in-two-places → port-red outline and a small triangle marker;
  fit violation → amber outline; unverified fit → none on the grid (shown in the drawer).
- Click a bar → **Booking drawer**: details, fit status with lengths, issues with links, provenance
  ("Imported from 2010!E30:AA30"), notes, Edit / Delete.
- Click an empty cell → **Booking form** prefilled with that berth and date.
- Right sidebar: unreviewed issues in the visible month; "Show" focuses and pulses the bar once.

### 10.4 Booking form (modal)

Fields: kind (segmented), vessel (combobox over `/api/vessels?q=`, with "Add vessel" inline requiring a
length), title (non-vessel kinds), berth (select showing length; options that fail rule F are labelled
"too short" but still selectable so the server message can be shown), start date, **last day at berth**
(inclusive, labelled as such), notes. As berth, dates or vessel change (debounced 300 ms), call
`GET /api/availability` for those dates and show the chosen berth's status inline ("Free", "Booked by …",
"Too short: 145 ft vessel, 90 ft berth"). The server remains the authority on save.
On 409/422: show the server message, the conflicting bookings, and alternatives as one-click buttons
("Use South Float West (90 ft)", "Move to 14–20 Jul") that fill the form; the user then saves.

### 10.5 Find a berth (panel)

Inputs: start, last day, vessel *or* length. Results from `/api/availability`: status chips
(Available / Too short / Busy — with the conflicting booking / Length unknown / Shared pool). "Book this
berth" opens the form prefilled. The gauge marker shows the requested length.

### 10.6 Issues (`/issues`)

Tabs: Double-bookings · Too long for berth · Vessel in two places. Filters: year, berth, include reviewed.
Each item shows both bookings, dates, source cells, lengths (flag "disputed length" when relevant) and
actions: Show on schedule, Edit booking, Mark reviewed (with optional note). One sentence at the top of each
tab explains the rule in plain words.

### 10.7 Vessels (`/vessels`)

Table: name, length (inline edit), status (known / unknown / disputed with the note), bookings count.
Filter "Missing length". Saving a length shows the `newFitIssues` / `clearedFitIssues` result as a toast.

### 10.8 Migration (`/import`)

Summary cards from `importSummary` (reservations by kind, vessels by length status, schedule issues), then
the migration log grouped by code with counts and a plain-English description of each code (write a map in
the UI: e.g. `CARRYOVER_MISMATCH` → "A sheet repeats the previous December and disagrees with it; the
original was kept"). Expand a code to list its entries with sheet!cell references.

### 10.9 Bookings (`/bookings`, P1)

Table with filters (date range, berth, kind, vessel/title search, has issues), keyset pagination, row →
drawer, "Export CSV" for the current filter.

## 11. Ask bar (P1)

Natural language → a **structured filter the user can see and edit** → the same deterministic queries as the
manual UI. The model never sees booking data and never decides availability or conflicts.

`POST /api/ask` body `{ q: string (1–300 chars), today: 'YYYY-MM-DD', viewedMonth: 'YYYY-MM' }`.
Response `{ intent, filters, chips: {key, label}[], source: 'ai' | 'fallback', message? }` where

```ts
type AskIntent = {
  intent: 'search' | 'availability' | 'issues' | 'navigate' | 'unsupported';
  dateFrom?: string; dateTo?: string;          // ISO; server swaps if reversed, clamps to 1997-01-01..2100-12-31
  berthIds?: string[];                          // enum of berth ids from /api/meta
  vesselQuery?: string;                         // free text; server resolves to vessel ids via LIKE (top 5)
  kinds?: Kind[]; lengthFt?: number; issueTypes?: IssueType[]; reason?: string;
};
```

- Model: `env.NL_MODEL` (default `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, a Workers AI model with JSON
  mode). Call `env.AI.run(model, { messages, response_format: { type: 'json_schema', json_schema }, max_tokens: 300 })`.
  The response's `response` field may be an object or a JSON string: handle both. Validate with zod.
  8-second timeout. On any failure (no binding, error, invalid JSON) use the fallback parser and set
  `source: 'fallback'`.
- System prompt (in `worker/ask/prompt.ts`): today's date, the data range, berth ids with names/lengths and
  aliases (NPW, NPF, NPE, IC, SFW, SFE, slips, finger piers), the schema in plain text, "respond only with
  JSON", and these examples:
  - "who was at inner channel in july 2010" → `{intent:'search', berthIds:['inner-channel'], dateFrom:'2010-07-01', dateTo:'2010-07-31'}`
  - "which berths fit a 120 ft boat 3–10 July 2026" → `{intent:'availability', lengthFt:120, dateFrom:'2026-07-03', dateTo:'2026-07-10'}`
  - "double bookings in 2017" → `{intent:'issues', issueTypes:['overlap'], dateFrom:'2017-01-01', dateTo:'2017-12-31'}`
  - "everything for clear tern" → `{intent:'search', vesselQuery:'clear tern'}`
  - "go to march 2012" → `{intent:'navigate', dateFrom:'2012-03-01'}`
- Fallback parser (`worker/ask/fallback.ts`, unit-tested): month name + year, "next week"/"this month"
  relative to `today`, ISO dates, "3–10 July 2026" ranges, berth names/aliases, `(\d+)\s*(ft|feet|')`
  → lengthFt, keywords (`conflict|double|overlap` → issues; `free|available|fit|space` → availability;
  `go to|show me <month>` → navigate), vessel prefixes (R/V, M/V, …) or quoted text → vesselQuery.
- Client: render chips under the bar ("Berth: Inner Channel ✕", "Dates: 1–31 Jul 2010 ✕"); removing a chip
  edits the filter. Apply: search → Bookings view (Schedule if no P1 Bookings view: navigate to the month
  and highlight matches); availability → Find a berth panel, prefilled and run; issues → Issues page
  filtered; navigate → Schedule at that month; unsupported → show `message`.
- Guardrails: cap input length, `max_tokens: 300`, no data rows in the prompt, errors never expose prompts.

## 12. Migration (MUST)

- Copy **Appendix A** to `migration/extract.py` and **Appendix B** to `migration/tests/test_extract.py`
  verbatim. Move the workbook to `data/dock_schedule.xlsx`.
- `npm run migrate` → `python3 migration/extract.py --input data/dock_schedule.xlsx --out migration/out
  --generated-at 2026-09-22T00:00:00+00:00` (fixed timestamp → reproducible `seed.sql`).
- `migration/out/` is gitignored; CI regenerates it (via pytest, which runs the script) and passes
  `seed.sql` from the test job to the deploy job as an artifact.
- What the script does (for the README; do not re-implement): finds month blocks by header text; takes the
  year from the sheet name; locates day 1 by majority vote over numeric day labels (handles formula days,
  split and conflicting headers); resolves theme/indexed/RGB fills to real colours; builds bars from merged
  ranges and runs of the same colour, adopting a name found mid-bar; treats timing/service text (ETA,
  Departs 0600, Fueling…) as notes, never bookings; stitches bars across months and years; skips the
  carry-over Decembers after diffing them; imports unlabelled booking rows to `unassigned`; reads vessel
  lengths from `Science`/`Yachts` (name suffix and `LOA:`), flagging disputes; computes schedule issues with
  rules O/F/V; writes `seed.sql` (no BEGIN/COMMIT, idempotent DELETE-then-INSERT) and JSON outputs.
- **Parity test (`shared/__tests__/parity.test.ts`):** load `migration/out/{reservations,berths,vessels,issues}.json`,
  run `detectIssues` from `shared/domain.ts`, and assert the set of `(type, sorted reservation-id pair)`
  equals Python's. Skip with a clear message if the files are absent. This proves the TS and Python rules agree.

## 13. Configuration, CI and deployment (MUST)

### 13.1 `wrangler.jsonc`

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "berthday",
  "main": "worker/index.ts",
  "compatibility_date": "2026-09-01",
  "assets": {
    "directory": "./dist",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*"]
  },
  "d1_databases": [{
    "binding": "DB",
    "database_name": "berthday",
    "database_id": "00000000-0000-0000-0000-000000000000",
    "migrations_dir": "migrations"
  }],
  "ai": { "binding": "AI" },
  "vars": { "NL_MODEL": "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "APP_VERSION": "dev" },
  "observability": { "enabled": true }
}
```

The zero UUID is a placeholder; `scripts/ci/ensure-d1.mjs` replaces it in the CI workspace (committing a
real ID is also fine; D1 IDs are not secrets). `run_worker_first: ["/api/*"]` is required: without it the
SPA fallback can answer API calls with `index.html`.

### 13.2 `package.json` scripts

```json
{
  "dev": "concurrently -k \"vite\" \"wrangler dev --port 8787\"",
  "build": "vite build",
  "typecheck": "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.worker.json --noEmit",
  "test": "TZ=America/New_York vitest run",
  "migrate": "python3 migration/extract.py --input data/dock_schedule.xlsx --out migration/out --generated-at 2026-09-22T00:00:00+00:00",
  "db:local": "wrangler d1 migrations apply berthday --local && wrangler d1 execute berthday --local --file migration/out/seed.sql",
  "cf-typegen": "wrangler types"
}
```

`vite.config.ts`: React plugin, `build.outDir = 'dist'`, dev proxy `/api → http://localhost:8787`.
`wrangler dev` serves `dist` + API; run `npm run build` once before `npm run dev` so assets exist.

### 13.3 `scripts/ci/ensure-d1.mjs`

```js
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const NAME = 'berthday';
const run = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
const listDbs = () => {
  const out = run('npx wrangler d1 list --json');
  return JSON.parse(out.slice(out.indexOf('['), out.lastIndexOf(']') + 1));
};
const find = (dbs) => dbs.find((d) => (d.name ?? d.database_name) === NAME);

let id = (process.env.D1_DATABASE_ID || '').trim();
if (!id) {
  let db = find(listDbs());
  if (!db) {
    console.log(`Creating D1 database ${NAME}`);
    execSync(`npx wrangler d1 create ${NAME}`, { stdio: 'inherit' });
    db = find(listDbs());
  }
  id = db?.uuid ?? db?.id ?? db?.database_id ?? '';
}
if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error(`Could not resolve D1 id for ${NAME} (got "${id}")`);
const path = 'wrangler.jsonc';
writeFileSync(path, readFileSync(path, 'utf8').replace(/"database_id":\s*"[^"]*"/, `"database_id": "${id}"`));
console.log(`D1 ${NAME} -> ${id}`);
```

### 13.4 `scripts/ci/seed-if-empty.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail
DB=berthday
COUNT=$(npx wrangler d1 execute "$DB" --remote --json --command "SELECT COUNT(*) AS n FROM reservations" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s.slice(s.indexOf("[")));console.log((Array.isArray(j)?j[0]:j).results[0].n)})')
echo "reservations in remote D1: $COUNT"
if [ "$COUNT" = "0" ] || [ "${FORCE_RESEED:-false}" = "true" ]; then
  npx wrangler d1 execute "$DB" --remote --file migration/out/seed.sql
  echo "seeded"
else
  echo "already seeded; skipping (run the workflow with reseed=true to reset)"
fi
```

### 13.5 `.github/workflows/deploy.yml`

```yaml
name: Test and deploy
on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:
    inputs:
      reseed:
        description: "Wipe the database and reload the legacy seed"
        type: boolean
        default: false

concurrency:
  group: deploy-${{ github.ref }}
  cancel-in-progress: false

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - run: pip install -r migration/requirements.txt
      - run: python -m pytest -q migration/tests        # also generates migration/out/*
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm run typecheck
      - run: npm test                                    # includes the TS/Python parity test
      - run: npm run build
      - uses: actions/upload-artifact@v4
        with: { name: seed, path: migration/out/seed.sql, if-no-files-found: error }

  deploy:
    needs: test
    if: github.event_name != 'pull_request' && github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    env:
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
      D1_DATABASE_ID: ${{ secrets.D1_DATABASE_ID }}      # optional; looked up or created by name if empty
      FORCE_RESEED: ${{ inputs.reseed || false }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - uses: actions/download-artifact@v4
        with: { name: seed, path: migration/out }
      - run: node scripts/ci/ensure-d1.mjs
      - run: npx wrangler d1 migrations apply berthday --remote
      - run: bash scripts/ci/seed-if-empty.sh
      - run: npm run build
      - name: Deploy
        run: npx wrangler deploy --var APP_VERSION:${GITHUB_SHA::7} | tee deploy.log
      - name: Smoke test
        run: |
          URL=$(grep -oE 'https://[a-zA-Z0-9.-]+\.workers\.dev' deploy.log | head -1)
          echo "Deployed to $URL" >> "$GITHUB_STEP_SUMMARY"
          curl -fsS "$URL/api/health"
          curl -fsS "$URL/api/meta" | grep -q '"dataRange"'
          curl -fsS "$URL/" | grep -qi '<div id="root"'
```

D1 steps run **before** `vite build` on purpose. Wrangler runs non-interactively in CI (`CI=true`).

### 13.6 Secrets the owner adds (document in README)

- `CLOUDFLARE_API_TOKEN` — from the "Edit Cloudflare Workers" template, plus **Account → D1 → Edit** and
  **Account → Workers AI → Read** if the template lacks them.
- `CLOUDFLARE_ACCOUNT_ID`.
- `D1_DATABASE_ID` — optional.
- The account needs a `workers.dev` subdomain (Workers dashboard, one-time). The public URL is
  `https://berthday.<subdomain>.workers.dev`.

## 14. Documentation (MUST)

**README.md:** title "Berthday" with the tagline, what it is (3 sentences), live URL placeholder, screenshots optional, how to run locally
(`npm ci`, `pip install -r migration/requirements.txt`, `npm run migrate`, `npm run db:local`,
`npm run build`, `npm run dev`), tests, deploy/reseed, architecture diagram (§5), a 60-second demo script (§16).

**DECISIONS.md** — short, first person, specific. Must cover:

- *Assumptions:* inclusive day-granular bookings; one booking per berth at a time; vessel may share one day
  between berths (shift day); unknown length = unverified, disputed = larger value; events/closures/holds
  occupy the berth; sheet year beats header year; the original December beats its carry-over copy.
- *Decisions:* one-time offline migration instead of an in-app legacy upload (a recurring legacy import keeps
  the spreadsheet alive as a second source of truth; the Worker CPU budget can't parse it anyway); import
  everything and flag it rather than silently clean; conflicts materialised in `issues` because of D1 read
  limits; deterministic alternatives instead of LLM suggestions; the Ask bar only produces filters the user
  can see; race-safe conditional insert instead of check-then-write; default view is December 2019.
- *Questions for the client:* can North Pier West (410') host several vessels at once — and should length
  sharing replace rule O there? Is berth length a hard maximum or is there a margin? Do same-day turnovers
  happen often enough to need times? Is "Marsh Landing" (summary only) the unlabelled rows under South Float
  East? What are the column-B names in 2011–2019 (resident vessels?)? Who may override a rule, and should
  overrides be recorded?
- *Future work:* length-sharing berths, time-of-day turnovers, auth and audit log, override-with-reason,
  vessel contacts from Science/Yachts, `Tours` import.

## 15. Tests (MUST)

- `migration/tests/test_extract.py` (Appendix B) — 13 tests, all must pass.
- `shared/__tests__/dates.test.ts` — month lengths incl. leap years, `addDays` across month/year ends,
  `sharedDays` (0, 1, containment), UTC safety (run with `TZ=America/New_York` in the npm script).
- `shared/__tests__/domain.test.ts` — rule O: back-to-back (Jan 1–5 then Jan 6–9 → OK), same last/first day
  (Jan 1–5 then Jan 5–9 → conflict), containment; pools never conflict; rule F: 145 vs 90 → violation,
  unknown → unverified, disputed uses larger value; rule V: 1 shared day OK, 2 → conflict;
  `suggestAlternatives` ordering (best fit first, excludes too-short and busy, date shift nearest first).
- `shared/__tests__/parity.test.ts` — §12.
- `worker/ask/fallback.test.ts` (P1) — the five example queries in §11 map to the listed intents.
- P1: API tests with `@cloudflare/vitest-pool-workers` (apply migrations, seed a tiny fixture, then: create
  OK → overlapping create 409 with alternatives → fit 422 → vessel length PATCH creates a fit issue →
  delete removes issues). If setting this up exceeds 20 minutes, skip and say so in DECISIONS.md.

## 16. Acceptance / demo script (MUST pass on the deployed URL)

1. Open `/` → the December 2019 grid (latest month in the data) renders within 2 s, with its bookings.
2. Go to April 2010 → R/V Golden Compass bars on North Pier West; March 2010 shows its 4–26 Mar stay.
3. Issues → 4 double-bookings, 29 too-long, 15 vessel-in-two-places. "Show" on the South Float East
   11 Jul 2017 item opens July 2017 with OSV Amber Reef and "Utility work on pier face" outlined red.
4. New booking: M/Y Wild Tern (145 ft), South Float East, 3–10 Jul 2026 → 422 naming both lengths, with
   North Pier East / North Pier West offered; click one → saves.
5. Book another vessel on the same berth/dates → 409 with the conflicting booking and a date shift offered.
6. Vessels → set R/V Golden Compass to 300 ft → toast reports 23 new fit issues (its stays on the 240 ft
   North Pier East). Set it to 200 ft → 23 cleared.
7. Find a berth: 120 ft, 1–7 Aug 2026 → North Pier East and North Pier West available; shorter berths dimmed
   on the gauge.
8. Migration page shows 2,587 reservations and the log grouped by code.
9. (P1) Ask "which berths fit a 120 ft boat 3–10 July 2026" → chips → availability results.
10. Hard refresh on `/issues` works (SPA fallback); `/api/does-not-exist` returns JSON 404, not HTML.

## 17. Build order for the agent

1. Scaffold repo per §5.2; copy Appendices A/B; `pip install`, run pytest (must pass).
2. Schema + `shared/dates.ts` + `shared/domain.ts` + tests (incl. parity) — green before any UI.
3. Worker: meta, berths, reservations (read), issues, import routes. Then write path (§9.3), vessels, availability, alternatives.
4. CI files (§13) — push; confirm the deploy job goes green and the smoke test passes **before** building UI.
5. UI: Schedule grid → drawer → booking form with errors/alternatives → Issues → Vessels → Find a berth → Migration.
6. README + DECISIONS.md. Deploy. Walk the §16 script on the live URL.
7. P1: Ask bar, Bookings list + CSV, API tests. Redeploy after each.

Definition of done: all MUST items met, CI green, §16 steps 1–8 pass on the live URL, docs written.

---

## Appendix A — `migration/extract.py` (verified; copy verbatim)

```python
#!/usr/bin/env python3
"""One-time migration: legacy dock workbook -> reservations, issues, import report, seed.sql.

Usage:
    python migration/extract.py --input data/dock_schedule.xlsx --out migration/out \
        [--generated-at 2026-09-22T00:00:00+00:00]

The annual sheets are a presentation grid, not data. A booking is a coloured bar (a merged
range and/or a run of same-coloured cells) on a berth row, with the vessel name somewhere in
it. This script turns bars into explicit reservations and logs every heuristic decision as an
import issue with a sheet!cell reference, so a person can review what was guessed.
Only dependency: openpyxl.
"""
from __future__ import annotations

import argparse
import calendar
import colorsys
import datetime as dt
import hashlib
import json
import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from xml.etree import ElementTree as ET

from openpyxl import load_workbook
from openpyxl.styles.colors import COLOR_INDEX
from openpyxl.utils import get_column_letter

MONTHS = [m.upper() for m in calendar.month_name[1:]]
WEEKDAY_TOKENS = {"M", "T", "W", "TR", "TH", "F", "S", "SA", "SU"}
BERTH_RE = re.compile(r"^(?P<name>.+?)\s*-\s*(?P<len>\d+)\s*'\s*$")
POOLS = [  # shared resources: no length, no overlap rule
    ("NORTH FINGER PIERS", "north-finger-piers", "North Finger Piers"),
    ("SMALL CRAFT SLIPS", "small-craft-slips", "Small craft slips (institution boats)"),
]
UNASSIGNED = {"id": "unassigned", "name": "Unassigned (legacy rows)", "length_ft": None, "is_exclusive": 0}
VESSEL_RE = re.compile(r"^(R/V|M/V|S/V|S/Y|M/Y|OSV|OS/V|F/V|TUG|BARGE)\s+(.+)$", re.I)
PREFIX_DISPLAY = {"TUG": "Tug", "BARGE": "Barge"}
ANNOTATION_RE = re.compile(r"^(ETA|ETD|ARRIVAL|ARRIVES|DEPARTURE|DEPARTS|DELAYED|TOUCH AND GO|PROVISIONING|"
                           r"FUELING|FUEL TRUCK|BUNKERING|LOAD EQUIPMENT)\b", re.I)
CLOSURE_RE = re.compile(r"REPAIR|MAINTENANCE|REBUILD|NO DOCKING|NO USAGE|INSPECTION|\bTEST\b|REPLACEMENT|"
                        r"UTILITY WORK|PAVING|CONCRETE", re.I)
BACKGROUND_RGB = {"FFFFFF", "F2F2F2", "D9D9D9"}  # white and the grey shading used on quiet rows
THEME_ORDER = ["lt1", "dk1", "lt2", "dk2", "accent1", "accent2", "accent3", "accent4",
               "accent5", "accent6", "hlink", "folHlink"]  # Excel theme index -> scheme slot
DRAWING_NS = {"a": "http://schemas.openxmlformats.org/drawingml/2006/main"}


# ----------------------------------------------------------------------------- helpers
def norm_text(value) -> str:
    return re.sub(r"\s+", " ", str(value)).strip()


def norm_key(value) -> str:
    return norm_text(value).upper()


def slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower().replace("/", "")).strip("-")


def short_hash(*parts) -> str:
    return hashlib.sha1("|".join(str(p) for p in parts).encode()).hexdigest()[:12]


def is_text(value) -> bool:
    return isinstance(value, str) and value.strip() != "" and not value.startswith("=")


def vessel_display(key: str) -> str:
    m = VESSEL_RE.match(key)
    if not m:
        return key.title()
    prefix = m.group(1).upper()
    return f"{PREFIX_DISPLAY.get(prefix, prefix)} {m.group(2).title()}"


def classify(label_key: str) -> str:
    if VESSEL_RE.match(label_key):
        return "vessel"
    return "closure" if CLOSURE_RE.search(label_key) else "event"


def day_number(value) -> int | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return int(value)
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    return None


# ----------------------------------------------------------------------------- colours
def theme_palette(wb) -> list[str]:
    if not wb.loaded_theme:
        return []
    scheme = ET.fromstring(wb.loaded_theme).find(".//a:clrScheme", DRAWING_NS)
    palette = []
    for name in THEME_ORDER:
        el = scheme.find(f"a:{name}", DRAWING_NS) if scheme is not None else None
        child = el[0] if el is not None and len(el) else None
        palette.append(((child.get("lastClr") or child.get("val")) if child is not None else "000000").upper())
    return palette


def apply_tint(rgb: str, tint: float) -> str:
    if not tint:
        return rgb
    r, g, b = (int(rgb[i:i + 2], 16) / 255 for i in (0, 2, 4))
    h, lum, s = colorsys.rgb_to_hls(r, g, b)
    lum = lum * (1 + tint) if tint < 0 else lum * (1 - tint) + tint
    return "".join(f"{round(x * 255):02X}" for x in colorsys.hls_to_rgb(h, min(1.0, max(0.0, lum)), s))


def fill_rgb(cell, palette: list[str]) -> str | None:
    """Resolved solid fill as RRGGBB; None for no fill or background shading."""
    fill = getattr(cell, "fill", None)
    if fill is None or fill.fill_type != "solid" or fill.fgColor is None:
        return None
    c, rgb = fill.fgColor, None
    if c.type == "rgb" and isinstance(c.rgb, str):
        rgb = c.rgb[-6:].upper()
    elif c.type == "theme" and c.theme is not None and c.theme < len(palette):
        rgb = apply_tint(palette[c.theme], c.tint or 0.0)
    elif c.type == "indexed" and c.indexed is not None and c.indexed < 64:
        rgb = COLOR_INDEX[c.indexed][-6:].upper()
    return None if rgb is None or rgb in BACKGROUND_RGB else rgb


# ----------------------------------------------------------------------------- extraction
@dataclass
class Segment:
    resource_id: str
    lane: int
    start: dt.date
    end: dt.date
    label_key: str | None
    raw_label: str | None
    fill: str | None
    sources: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    merge_id: str | None = None


class Extractor:
    def __init__(self, path: Path):
        self.wb = load_workbook(path)  # formula mode on purpose: 1997-2001 day numbers have no cached values
        self.palette = theme_palette(self.wb)
        self.issues: list[dict] = []
        self.resources: dict[str, dict] = {}
        self.segments: list[Segment] = []
        self.carryover: dict[tuple[int, int], list[Segment]] = defaultdict(list)
        self.by_month: dict[tuple[int, int], list[Segment]] = defaultdict(list)
        self.stats = Counter()

    def issue(self, code, severity, message, sheet=None, cell=None, reservation_id=None):
        self.issues.append({"code": code, "severity": severity, "sheet": sheet, "cell": cell,
                            "message": message, "reservation_id": reservation_id})

    # -- resources ------------------------------------------------------------------
    @staticmethod
    def is_resource_label(label) -> bool:
        if not is_text(label):
            return False
        text = norm_text(label)
        return bool(BERTH_RE.match(text)) or any(text.upper().startswith(p) for p, _, _ in POOLS)

    def resource_for_label(self, label, sheet: str, row: int) -> str | None:
        if not self.is_resource_label(label):
            return None
        text = norm_text(label)
        m = BERTH_RE.match(text)
        if m:
            name, length = m.group("name").strip(), int(m.group("len"))
            rid = slug(name)
            known = self.resources.get(rid)
            if known is None:
                self.resources[rid] = {"id": rid, "name": name, "length_ft": length, "is_exclusive": 1,
                                       "sort_order": len(self.resources), "source": f"{sheet}!A{row}"}
            elif known["length_ft"] != length:
                self.issue("BERTH_LENGTH_CHANGED", "warn",
                           f"{name} labelled {length}' here but {known['length_ft']}' earlier", sheet, f"A{row}")
            return rid
        for prefix, rid, name in POOLS:
            if text.upper().startswith(prefix):
                self.resources.setdefault(rid, {"id": rid, "name": name, "length_ft": None, "is_exclusive": 0,
                                                "sort_order": len(self.resources), "source": f"{sheet}!A{row}"})
                return rid
        return None

    # -- sheets ---------------------------------------------------------------------
    def run(self):
        for sheet in sorted((s for s in self.wb.sheetnames if s.isdigit()), key=int):
            self.parse_sheet(sheet)
        self.compare_carryovers()
        for name in self.wb.sheetnames:
            if not name.isdigit():
                self.issue("SHEET_NOT_IMPORTED", "info", f"Sheet '{name}' is reference/reporting data", name)

    def parse_sheet(self, sheet: str):
        ws, year = self.wb[sheet], int(sheet)
        anchors = {}  # (row, col) -> (anchor_row, anchor_col, range_id, min_col, max_col)
        for rng in ws.merged_cells.ranges:
            for r in range(rng.min_row, rng.max_row + 1):
                for c in range(rng.min_col, rng.max_col + 1):
                    anchors[(r, c)] = (rng.min_row, rng.min_col, f"{sheet}!{rng.coord}", rng.min_col, rng.max_col)
        headers = []
        for r in range(1, ws.max_row + 1):
            a = ws.cell(r, 1).value
            if isinstance(a, str):
                month = next((i + 1 for i, m in enumerate(MONTHS) if norm_key(a).startswith(m)), None)
                if month:
                    headers.append((r, month, norm_text(a)))
        formula_days = 0
        for i, (hrow, month, header) in enumerate(headers):
            end_row = headers[i + 1][0] - 1 if i + 1 < len(headers) else ws.max_row
            header_year = int(m.group(1)) if (m := re.search(r"(\d{4})", header)) else None
            carry, block_year = False, year
            if header_year is not None and header_year != year:
                if month == 12 and header_year == year - 1 and i == 0:
                    carry, block_year = True, year - 1
                else:
                    self.issue("HEADER_YEAR_MISMATCH", "warn",
                               f"Header '{header}' in sheet {sheet}; used {year} from the sheet name", sheet, f"A{hrow}")
            rows = self.block_rows(ws, sheet, hrow, end_row, header)
            if not rows:
                continue
            day1_col, n_formulas = self.day_one(ws, sheet, hrow, rows[0][0], header, block_year, month)
            formula_days += n_formulas
            if day1_col is None:
                continue
            ndays = calendar.monthrange(block_year, month)[1]
            for row, rid, lane in rows:
                segs = self.parse_row(ws, sheet, row, rid, lane, block_year, month, day1_col, ndays, anchors)
                (self.carryover[(block_year, month)] if carry else self.segments).extend(segs)
                if not carry:
                    self.by_month[(block_year, month)].extend(segs)
            self.stats["carryover_blocks" if carry else "blocks"] += 1
        if formula_days:
            self.issue("DAY_NUMBERS_ARE_FORMULAS", "info",
                       f"{formula_days} day-number cells are uncached formulas; dates derived from column offsets",
                       sheet)

    def block_rows(self, ws, sheet, hrow, end_row, header) -> list[tuple[int, str, int]]:
        """Berth rows of one month block, plus unlabelled rows that carry bookings."""
        rows, lanes, last_rid = [], Counter(), None
        for r in range(hrow + 1, end_row + 1):
            label = ws.cell(r, 1).value
            rid = self.resource_for_label(label, sheet, r)
            texts = [norm_text(ws.cell(r, c).value) for c in range(2, ws.max_column + 1) if is_text(ws.cell(r, c).value)]
            if rid is not None:
                last_rid = rid
            elif last_rid is None or is_text(label):
                continue
            elif not any(not ANNOTATION_RE.match(t) for t in texts):
                if texts:
                    self.issue("NOTE_ROW", "info", f"Row of notes in '{header}' not tied to a berth: "
                               f"{'; '.join(texts)[:160]}", sheet, f"A{r}")
                continue
            elif not self.resources[last_rid]["is_exclusive"]:
                rid = last_rid
                self.issue("UNLABELLED_POOL_ROW", "info", f"Unlabelled row under {self.resources[rid]['name']} in "
                           f"'{header}'; imported as part of that shared resource", sheet, f"A{r}")
            else:
                rid = UNASSIGNED["id"]
                self.resources.setdefault(rid, {**UNASSIGNED, "sort_order": 999, "source": f"{sheet}!A{r}"})
                self.issue("UNLABELLED_ROW", "warn", f"Row with no berth label under "
                           f"{self.resources[last_rid]['name']} in '{header}' holds bookings "
                           f"({'; '.join(texts)[:120]}); imported to '{UNASSIGNED['name']}' for review. Possibly "
                           f"Marsh Landing, which appears in the 8YR summary but never as a row label.", sheet, f"A{r}")
            lane = lanes[rid]
            lanes[rid] += 1
            if lane > 0 and self.resources[rid]["is_exclusive"]:
                self.issue("DUPLICATE_BERTH_ROW", "warn", f"{self.resources[rid]['name']} has {lane + 1} rows in "
                           f"'{header}'; bookings on the extra row are imported as the same berth", sheet, f"A{r}")
            rows.append((r, rid, lane))
        return rows

    def day_one(self, ws, sheet, hrow, first_row, header, year, month) -> tuple[int | None, int]:
        """Column of day 1, by majority vote of every numeric day label around the header."""
        votes, labels, junk, formulas = Counter(), {}, 0, 0
        for r in range(max(1, hrow - 1), first_row):
            if r < hrow and self.is_resource_label(ws.cell(r, 1).value):
                continue
            for c in range(2, ws.max_column + 1):
                v = ws.cell(r, c).value
                n = day_number(v)
                if isinstance(v, str) and v.startswith("="):
                    formulas += 1
                elif n is not None and 1 <= n <= 31 and 2 <= c - n + 1 <= 12:
                    votes[c - n + 1] += 1
                    labels[c] = n
                elif is_text(v) and norm_key(v) not in WEEKDAY_TOKENS and r in (hrow, hrow + 1):
                    junk += 1
        if not votes:
            self.issue("NO_DAY_HEADER", "error", f"No day numbers found for '{header}'; block skipped", sheet, f"A{hrow}")
            return None, formulas
        day1 = votes.most_common(1)[0][0]
        if len(votes) > 1:
            detail = ", ".join(f"column {get_column_letter(k)} ({n} labels)" for k, n in votes.most_common())
            self.issue("HEADER_DAY_CONFLICT", "warn", f"Day numbers around '{header}' disagree on where day 1 is "
                       f"({detail}); used column {get_column_letter(day1)}", sheet, f"A{hrow}")
        if junk:
            self.issue("HEADER_ROW_TEXT", "warn", f"{junk} text cells sit in the day/weekday rows of '{header}'; "
                       f"ignored", sheet, f"A{hrow}")
        ndays = calendar.monthrange(year, month)[1]
        agreed = [n for c, n in labels.items() if c - n + 1 == day1]
        if invalid := sorted(n for n in agreed if n > ndays):
            self.issue("HEADER_INVALID_DAY", "warn", f"'{header}' lists day(s) {invalid} but the month has {ndays} "
                       f"days; cells under those columns are not imported", sheet, f"A{hrow}")
        if len(agreed) >= 20 and max(agreed) < ndays:
            self.issue("HEADER_MISSING_DAY", "warn", f"'{header}' stops at day {max(agreed)} of {ndays}; dates "
                       f"derived from column position", sheet, f"A{hrow}")
        return day1, formulas

    def parse_row(self, ws, sheet, row, rid, lane, year, month, day1_col, ndays, anchors) -> list[Segment]:
        segs: list[Segment] = []
        cur: Segment | None = None

        def close():
            nonlocal cur
            if cur is not None:
                segs.append(cur)
            cur = None

        for c in range(2, ws.max_column + 1):
            coord = f"{get_column_letter(c)}{row}"
            anchor = anchors.get((row, c))
            src = ws.cell(anchor[0], anchor[1]) if anchor else ws.cell(row, c)
            value, fill, merge_id = src.value, fill_rgb(src, self.palette), (anchor[2] if anchor else None)
            day = c - day1_col + 1
            if not 1 <= day <= ndays:
                own = ws.cell(row, c).value
                reaches_month = anchor is not None and anchor[3] <= day1_col + ndays - 1 and anchor[4] >= day1_col
                if is_text(own) and not reaches_month:
                    code, sev, where = ("PRE_GRID_LABEL", "info", "left of day 1") if day < 1 else \
                        ("OUT_OF_RANGE_TEXT", "warn", "past the last day")
                    self.issue(code, sev, f"'{norm_text(own)}' sits {where} of {calendar.month_name[month]} {year}; "
                               f"not imported as a booking", sheet, coord)
                continue
            date = dt.date(year, month, day)
            text = norm_text(value) if is_text(value) else None
            adjacent = cur is not None and cur.end == date - dt.timedelta(days=1)
            same_merge = adjacent and merge_id is not None and merge_id == cur.merge_id

            if text and ANNOTATION_RE.match(text):  # timing/service notes never create bookings
                note = f"{text} ({sheet}!{coord})"
                if adjacent and (fill is None or fill == cur.fill or same_merge):
                    cur.end = date
                    cur.notes.append(note)
                elif fill is not None:
                    close()
                    cur = Segment(rid, lane, date, date, None, None, fill, [f"{sheet}!{coord}"], [note], merge_id)
                else:
                    close()
                    self.issue("ORPHAN_NOTE", "info", f"Note '{text}' is not attached to any booking", sheet, coord)
                continue
            if text:
                key = norm_key(text)
                if same_merge or (adjacent and cur.label_key == key and
                                  (fill == cur.fill or fill is None or cur.fill is None)):
                    cur.end = date
                    cur.merge_id = merge_id or cur.merge_id
                elif adjacent and cur.label_key is None and cur.fill is not None and fill == cur.fill:
                    cur.label_key, cur.raw_label, cur.end = key, text, date  # the name sits mid-bar
                    cur.merge_id = merge_id or cur.merge_id
                    cur.sources.append(f"{sheet}!{coord}")
                else:
                    close()
                    cur = Segment(rid, lane, date, date, key, text, fill, [f"{sheet}!{coord}"], [], merge_id)
                continue
            if fill is not None:
                if adjacent and (fill == cur.fill or same_merge):
                    cur.end = date
                else:
                    close()
                    cur = Segment(rid, lane, date, date, None, None, fill, [f"{sheet}!{coord}"], [], merge_id)
                continue
            if same_merge:
                cur.end = date
                continue
            close()
        close()
        for s in segs:  # turn the first source into a cell range covering the bar within this month
            first = s.sources[0].split("!")[1]
            last = f"{get_column_letter(day1_col + s.end.day - 1)}{row}"
            if first != last:
                s.sources[0] = f"{sheet}!{first}:{last}"
        return segs

    # -- carry-over Decembers -------------------------------------------------------
    def compare_carryovers(self):
        key = lambda s: (s.resource_id, s.lane, s.start, s.end, s.label_key)
        for (year, month), copy in sorted(self.carryover.items()):
            original = {key(s) for s in self.by_month.get((year, month), [])}
            dup = {key(s) for s in copy}
            sheet = str(year + 1)
            if original == dup:
                self.issue("CARRYOVER_DUPLICATE", "info",
                           f"Sheet {sheet} repeats {calendar.month_name[month]} {year}; identical copy skipped", sheet)
                continue
            examples = "; ".join(f"{k[4] or 'unlabelled'} on {k[0]} {k[2]}..{k[3]}"
                                 for k in sorted(dup - original, key=lambda k: (k[2], k[0]))[:3])
            self.issue("CARRYOVER_MISMATCH", "warn",
                       f"Sheet {sheet} repeats {calendar.month_name[month]} {year} but disagrees with sheet {year} "
                       f"({len(dup - original)} bookings only in the copy, {len(original - dup)} only in the "
                       f"original; e.g. {examples}). Copy skipped; sheet {year} is the source of truth.", sheet)

    # -- stitching across month boundaries ------------------------------------------
    def stitched(self) -> list[Segment]:
        out: list[Segment] = []
        for s in sorted(self.segments, key=lambda s: (s.resource_id, s.lane, s.start)):
            prev = out[-1] if out else None
            if prev and (prev.resource_id, prev.lane) == (s.resource_id, s.lane) \
                    and s.start == prev.end + dt.timedelta(days=1):
                same_label = s.label_key is not None and s.label_key == prev.label_key
                colour_continues = s.label_key is None and s.fill is not None and s.fill == prev.fill and s.start.day == 1
                if same_label or colour_continues:
                    prev.end = s.end
                    prev.sources += s.sources
                    prev.notes += s.notes
                    continue
            out.append(s)
        return out

    # -- vessel reference sheets ----------------------------------------------------
    def reference_vessels(self) -> dict[str, dict]:
        found: dict[str, list[tuple[int, str]]] = defaultdict(list)
        for sheet in ("Science", "Yachts"):
            if sheet not in self.wb.sheetnames:
                continue
            ws = self.wb[sheet]
            for r in range(1, ws.max_row + 1):
                a = ws.cell(r, 1).value
                if not is_text(a):
                    continue
                text = norm_text(a)
                if text.upper().startswith("LOA:"):
                    self.issue("ORPHAN_SPEC_ROW", "info", f"'{text}' has no vessel name on its row; not attached",
                               sheet, f"A{r}")
                    continue
                m = re.match(r"^(.*?)\s+(\d+)\s*'$", text)
                if not m or not VESSEL_RE.match(m.group(1)):
                    continue
                key = norm_key(m.group(1))
                found[key].append((int(m.group(2)), f"{sheet}!A{r}"))
                for c in range(2, ws.max_column + 1):
                    v = ws.cell(r, c).value
                    loa = re.search(r"LOA:\s*(\d+)\s*'", v) if isinstance(v, str) else None
                    if loa and int(loa.group(1)) != int(m.group(2)):
                        found[key].append((int(loa.group(1)), f"{sheet}!{get_column_letter(c)}{r}"))
        out = {}
        for key, cands in found.items():
            lengths = sorted({n for n, _ in cands})
            listing = ", ".join(f"{n}' ({src})" for n, src in cands)
            disputed = len(lengths) > 1
            if disputed:
                sheet, cell = cands[0][1].split("!")
                self.issue("VESSEL_LENGTH_DISPUTED", "warn", f"{vessel_display(key)} has conflicting lengths: "
                           f"{listing}; the larger value is used for fit checks", sheet, cell)
            out[key] = {"length_ft": max(lengths), "status": "disputed" if disputed else "known",
                        "note": f"Disputed: {listing}" if disputed else None,
                        "source": ", ".join(src for _, src in cands)}
        return out

    # -- assemble -------------------------------------------------------------------
    def build(self, generated_at: str) -> dict:
        self.run()
        segments = self.stitched()
        ref = self.reference_vessels()
        vessels: dict[str, dict] = {}

        def vessel_for(key: str) -> dict:
            if key not in vessels:
                vid = slug(key)
                while any(v["id"] == vid for v in vessels.values()):
                    vid += "-x"
                info = ref.get(key)
                vessels[key] = {"id": vid, "name": vessel_display(key), "name_key": key,
                                "length_ft": info["length_ft"] if info else None,
                                "length_status": info["status"] if info else "unknown",
                                "length_note": info["note"] if info else None,
                                "source": info["source"] if info else "schedule only"}
            return vessels[key]

        for key in sorted(ref):
            vessel_for(key)
        reservations = []
        for s in segments:
            kind = "hold" if s.label_key is None else classify(s.label_key)
            vessel = vessel_for(s.label_key) if kind == "vessel" else None
            res = {"id": "lg-" + short_hash(s.resource_id, s.lane, s.start, s.end, s.label_key, s.sources[0]),
                   "berth_id": s.resource_id, "kind": kind, "vessel_id": vessel["id"] if vessel else None,
                   "title": None if vessel else ("Unlabelled block" if kind == "hold" else s.raw_label),
                   "start_date": s.start.isoformat(), "end_date": s.end.isoformat(),
                   "notes": "; ".join(s.notes) or None, "origin": "legacy",
                   "source_ref": "; ".join(s.sources), "lane": s.lane}
            reservations.append(res)
            if kind == "hold":
                sheet, cell = s.sources[0].split("!")
                self.issue("UNLABELLED_BLOCK", "info", f"Coloured cells with no name on "
                           f"{self.resources[s.resource_id]['name']} {res['start_date']}..{res['end_date']}; "
                           f"imported as a hold", sheet, cell, res["id"])
        reservations.sort(key=lambda r: (r["start_date"], r["berth_id"], r["id"]))
        issues = detect_issues(reservations, self.resources, {v["id"]: v for v in vessels.values()}, generated_at)
        unknown = sum(v["length_status"] == "unknown" for v in vessels.values())
        self.issue("VESSEL_LENGTH_UNKNOWN", "info", f"{unknown} vessels have no length in Science/Yachts; their "
                   f"bookings show 'fit unverified' until someone enters a length")
        self.issue("SUMMARY_NOT_IMPORTED", "info", "'8YR Dock Summary' credits North Pier West with 648 days in "
                   "2012, more days than a year has, which implies several vessels share that pier. The app treats "
                   "each berth as one booking at a time; confirm with the dock coordinator.", "8YR Dock Summary")
        span = lambda r: (dt.date.fromisoformat(r["end_date"]) - dt.date.fromisoformat(r["start_date"])).days + 1
        summary = {
            "generated_at": generated_at, "source_file": None,
            "sheets_parsed": sum(s.isdigit() for s in self.wb.sheetnames),
            "month_blocks": self.stats["blocks"], "carryover_blocks_skipped": self.stats["carryover_blocks"],
            "reservations": len(reservations),
            "reservations_by_kind": dict(Counter(r["kind"] for r in reservations)),
            "vessels": len(vessels),
            "vessels_by_length_status": dict(Counter(v["length_status"] for v in vessels.values())),
            "berths": len(self.resources),
            "schedule_issues_by_type": dict(Counter(i["type"] for i in issues)),
            "import_issues_by_code": dict(Counter(i["code"] for i in self.issues)),
            "data_range": {"from": reservations[0]["start_date"], "to": max(r["end_date"] for r in reservations)},
            "max_span_days": max(span(r) for r in reservations),
        }
        return {"berths": sorted(self.resources.values(), key=lambda b: b["sort_order"]),
                "vessels": sorted(vessels.values(), key=lambda v: v["name_key"]),
                "reservations": reservations, "issues": issues, "import_issues": self.issues, "summary": summary}


# ----------------------------------------------------------------------------- schedule rules
def shared_days(a: dict, b: dict) -> int:
    """Days two INCLUSIVE ranges have in common (0 when they don't overlap)."""
    start, end = max(a["start_date"], b["start_date"]), min(a["end_date"], b["end_date"])
    return 0 if start > end else (dt.date.fromisoformat(end) - dt.date.fromisoformat(start)).days + 1


def detect_issues(reservations: list[dict], berths: dict, vessels: dict, created_at: str) -> list[dict]:
    """Same rules the Worker enforces on writes (PRD section 6)."""
    out = []

    def add(kind, a, b, berth_id, details):
        out.append({"id": f"{kind[:2]}-" + short_hash(kind, a["id"], b["id"] if b else ""), "type": kind,
                    "reservation_id": a["id"], "other_reservation_id": b["id"] if b else None, "berth_id": berth_id,
                    "start_date": max(a["start_date"], b["start_date"]) if b else a["start_date"],
                    "end_date": min(a["end_date"], b["end_date"]) if b else a["end_date"],
                    "details": details, "created_at": created_at})

    by_berth, by_vessel = defaultdict(list), defaultdict(list)
    for r in reservations:
        by_berth[r["berth_id"]].append(r)
        if r["vessel_id"]:
            by_vessel[r["vessel_id"]].append(r)
    for berth_id, rows in by_berth.items():  # rule O: exclusive berths, any shared day conflicts
        if not berths[berth_id]["is_exclusive"]:
            continue
        active: list[dict] = []
        for r in sorted(rows, key=lambda r: (r["start_date"], r["id"])):
            active = [a for a in active if a["end_date"] >= r["start_date"]]
            for a in active:
                add("overlap", a, r, berth_id, {"shared_days": shared_days(a, r)})
            active.append(r)
    for r in reservations:  # rule F: vessel longer than the berth
        if r["kind"] == "vessel":
            v, b = vessels[r["vessel_id"]], berths[r["berth_id"]]
            if v["length_ft"] is not None and b["length_ft"] is not None and v["length_ft"] > b["length_ft"]:
                add("fit", r, None, r["berth_id"], {"vessel_length_ft": v["length_ft"],
                                                    "berth_length_ft": b["length_ft"],
                                                    "length_status": v["length_status"]})
    for rows in by_vessel.values():  # rule V: same vessel at two berths for 2+ days (1 day = shift day)
        rows = sorted(rows, key=lambda r: (r["start_date"], r["id"]))
        for i, a in enumerate(rows):
            for b in rows[i + 1:]:
                if b["start_date"] > a["end_date"]:
                    break
                if b["berth_id"] != a["berth_id"] and shared_days(a, b) >= 2:
                    add("vessel_double", a, b, None, {"berths": [a["berth_id"], b["berth_id"]],
                                                      "shared_days": shared_days(a, b)})
    return sorted(out, key=lambda i: (i["start_date"], i["type"], i["id"]))


# ----------------------------------------------------------------------------- SQL output
def sql_value(v) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, (int, float)):
        return str(v)
    if isinstance(v, (dict, list)):
        v = json.dumps(v, separators=(",", ":"))
    return "'" + str(v).replace("'", "''") + "'"


def inserts(table: str, cols: list[str], rows: list[dict], chunk: int = 100) -> list[str]:
    return [f"INSERT INTO {table} ({','.join(cols)}) VALUES\n" +
            ",\n".join("(" + ",".join(sql_value(r.get(c)) for c in cols) + ")" for r in rows[i:i + chunk]) + ";"
            for i in range(0, len(rows), chunk)]


def to_sql(data: dict, generated_at: str) -> str:
    stamp = {"created_at": generated_at, "updated_at": generated_at}
    parts = ["-- Generated by migration/extract.py. Do not edit by hand.",
             "-- No BEGIN/COMMIT: `wrangler d1 execute --file` rejects explicit transactions.",
             "DELETE FROM issues;", "DELETE FROM import_issues;", "DELETE FROM reservations;",
             "DELETE FROM vessels;", "DELETE FROM berths;", "DELETE FROM app_meta;"]
    parts += inserts("berths", ["id", "name", "length_ft", "is_exclusive", "sort_order", "source"], data["berths"])
    parts += inserts("vessels", ["id", "name", "name_key", "length_ft", "length_status", "length_note", "source",
                                 "created_at", "updated_at"], [{**v, **stamp} for v in data["vessels"]])
    parts += inserts("reservations", ["id", "berth_id", "kind", "vessel_id", "title", "start_date", "end_date",
                                      "notes", "origin", "source_ref", "created_at", "updated_at"],
                     [{**r, **stamp} for r in data["reservations"]])
    parts += inserts("issues", ["id", "type", "reservation_id", "other_reservation_id", "berth_id", "start_date",
                                "end_date", "details", "created_at"], data["issues"])
    parts += inserts("import_issues", ["id", "code", "severity", "sheet", "cell", "message", "reservation_id"],
                     [{**i, "id": n + 1} for n, i in enumerate(data["import_issues"])])
    parts += inserts("app_meta", ["key", "value"], [
        {"key": "import_summary", "value": json.dumps(data["summary"], separators=(",", ":"))},
        {"key": "data_range", "value": json.dumps(data["summary"]["data_range"])},
        {"key": "max_span_days", "value": str(data["summary"]["max_span_days"])}])
    return "\n".join(parts) + "\n"


def main():
    ap = argparse.ArgumentParser(description="Migrate the legacy dock workbook")
    ap.add_argument("--input", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--generated-at", default=None, help="fixed ISO timestamp for reproducible output")
    args = ap.parse_args()
    generated_at = args.generated_at or dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
    data = Extractor(args.input).build(generated_at)
    data["summary"]["source_file"] = args.input.name
    args.out.mkdir(parents=True, exist_ok=True)
    for name in ("berths", "vessels", "reservations", "issues", "import_issues"):
        (args.out / f"{name}.json").write_text(json.dumps(data[name], indent=1))
    (args.out / "import_report.json").write_text(json.dumps(
        {"summary": data["summary"], "import_issues": data["import_issues"]}, indent=1))
    (args.out / "seed.sql").write_text(to_sql(data, generated_at))
    print(json.dumps(data["summary"], indent=2))


if __name__ == "__main__":
    main()
```

## Appendix B — `migration/tests/test_extract.py` (copy verbatim)

```python
"""Golden tests: every trap found in the legacy workbook, pinned to a concrete record."""
import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "migration" / "out"


@pytest.fixture(scope="session")
def data():
    subprocess.run([sys.executable, str(ROOT / "migration" / "extract.py"), "--input", str(ROOT / "data" / "dock_schedule.xlsx"),
                    "--out", str(OUT), "--generated-at", "2026-09-22T00:00:00+00:00"], check=True, capture_output=True)
    load = lambda n: json.loads((OUT / f"{n}.json").read_text())
    report = json.loads((OUT / "import_report.json").read_text())
    return {"res": load("reservations"), "vessels": {v["id"]: v for v in load("vessels")},
            "berths": {b["id"]: b for b in load("berths")}, "issues": load("issues"),
            "codes": report["summary"]["import_issues_by_code"], "summary": report["summary"],
            "import_issues": report["import_issues"]}


def find(data, **kw):
    return [r for r in data["res"] if all(r.get(k) == v for k, v in kw.items())]


def test_berths(data):
    lengths = {k: (b["length_ft"], b["is_exclusive"]) for k, b in data["berths"].items()}
    assert lengths == {"north-pier-west": (410, 1), "north-pier-face": (75, 1), "north-pier-east": (240, 1),
                       "inner-channel": (55, 1), "south-float-west": (90, 1), "south-float-east": (90, 1),
                       "small-craft-slips": (None, 0), "north-finger-piers": (None, 0), "unassigned": (None, 0)}


def test_all_23_years_and_date_range(data):
    years = {r["start_date"][:4] for r in data["res"]}
    assert {str(y) for y in range(1997, 2020)} <= years
    assert data["summary"]["data_range"] == {"from": "1997-08-01", "to": "2019-12-31"}


def test_formula_day_numbers_1990s(data):
    assert data["codes"]["DAY_NUMBERS_ARE_FORMULAS"] == 8
    assert any(r["vessel_id"] == "mv-northern-harbor" and r["start_date"] == "1997-11-01"
               and r["end_date"] == "1998-01-18" for r in data["res"])  # stitched across the year boundary


def test_bars_built_from_merges_and_fill(data):
    gc = [(r["start_date"], r["end_date"]) for r in find(data, berth_id="north-pier-west", vessel_id="rv-golden-compass")
          if r["start_date"].startswith("2010-0")][:3]
    assert gc == [("2010-01-01", "2010-01-08"), ("2010-01-21", "2010-02-28"), ("2010-03-04", "2010-03-26")]


def test_header_year_typo_uses_sheet_year(data):
    assert data["codes"]["HEADER_YEAR_MISMATCH"] == 2
    assert find(data, berth_id="north-pier-west", vessel_id="rv-golden-compass", start_date="2010-11-09")


def test_impossible_and_missing_header_days(data):
    assert data["codes"]["HEADER_INVALID_DAY"] == 2  # June 2008 lists 31, Feb 2009 lists 29
    assert data["codes"]["HEADER_MISSING_DAY"] == 3
    assert not [r for r in data["res"] if r["start_date"] in ("2008-06-31", "2009-02-29")]


def test_carryover_december_copies_are_skipped(data):
    assert data["summary"]["carryover_blocks_skipped"] == 3
    assert data["codes"]["CARRYOVER_MISMATCH"] == 3
    anchor = [r["start_date"] for r in find(data, berth_id="north-pier-west", vessel_id="rv-long-anchor")
              if r["start_date"].startswith("2001-12")]
    assert anchor[:2] == ["2001-12-05", "2001-12-07"]  # sheet 2001 wins over the shifted copy in sheet 2002


def test_duplicate_berth_rows_surface_overlaps(data):
    assert data["codes"]["DUPLICATE_BERTH_ROW"] == 10
    res = {r["id"]: r for r in data["res"]}
    pairs = {(res[i["reservation_id"]]["berth_id"], i["start_date"]) for i in data["issues"] if i["type"] == "overlap"}
    assert ("south-float-east", "2017-07-11") in pairs  # OSV Amber Reef vs "Utility work on pier face"
    assert ("north-pier-west", "1998-09-16") in pairs


def test_known_fit_violations(data):
    res = {r["id"]: r for r in data["res"]}
    combos = {(res[i["reservation_id"]]["vessel_id"], res[i["reservation_id"]]["berth_id"])
              for i in data["issues"] if i["type"] == "fit" and i["details"]["length_status"] == "known"}
    assert combos == {("mv-iron-heron", "inner-channel"), ("rv-clear-tern", "north-pier-face"),
                      ("sy-high-gannet", "south-float-east"), ("my-wild-tern", "south-float-east"),
                      ("sy-clear-beacon", "south-float-east")}


def test_disputed_lengths_use_larger_value(data):
    v = data["vessels"]
    assert (v["mv-deep-reef"]["length_ft"], v["mv-deep-reef"]["length_status"]) == (100, "disputed")
    assert (v["rv-high-reef"]["length_ft"], v["rv-high-reef"]["length_status"]) == (72, "disputed")
    assert (v["my-western-strand"]["length_ft"], v["my-western-strand"]["length_status"]) == (65, "disputed")
    assert v["rv-golden-compass"]["length_status"] == "unknown"


def test_shift_days_are_not_vessel_conflicts(data):
    assert all(i["details"]["shared_days"] >= 2 for i in data["issues"] if i["type"] == "vessel_double")


def test_record_integrity(data):
    for r in data["res"]:
        assert r["start_date"] <= r["end_date"]
        assert (r["kind"] == "vessel") == (r["vessel_id"] is not None)
        assert r["kind"] == "vessel" or r["title"]
        assert r["berth_id"] in data["berths"]
        assert r["vessel_id"] is None or r["vessel_id"] in data["vessels"]
    assert len({r["id"] for r in data["res"]}) == len(data["res"])


def test_counts_are_stable(data):
    s = data["summary"]
    assert s["reservations"] == 2587
    assert s["reservations_by_kind"] == {"vessel": 2047, "event": 89, "hold": 402, "closure": 49}
    assert s["schedule_issues_by_type"] == {"fit": 29, "vessel_double": 15, "overlap": 4}
    assert s["max_span_days"] == 425
```
