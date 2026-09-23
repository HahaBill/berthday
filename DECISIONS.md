# Decisions

## Assumptions

I model bookings as inclusive whole days: the last day is still occupied. Each of the six length-labelled berths accepts one booking at a time, including events, closures, and holds. The two shared pools do not enforce berth overlap, and the unassigned resource preserves history without accepting new bookings. A vessel can appear on two berths for exactly one shared day to represent a berth shift; two or more shared days are a conflict.

I allow unknown vessel or berth lengths with an explicit unverified fit status. Where the workbook disputes a vessel length, I use the larger value and preserve the competing source values for review. Fit is derived from the current vessel and berth lengths so entering a length immediately affects all of that vessel's bookings.

I use the annual sheet's year when a month heading disagrees, and the original December when the next year's carry-over copy disagrees. These are explicit, logged migration decisions rather than claims that the source data was correct. The supplied workbook copies are identical; I preserve the latest supplied `Dock Schedule - Synthetic Sample (1).xlsx` as `data/dock_schedule.xlsx`.

## Implementation choices

I use one offline migration rather than a recurring in-app workbook uploader. A recurring legacy import would keep the spreadsheet alive as a second source of truth, and parsing a workbook also does not fit the Worker's request CPU budget. I copied the provided extractor, golden tests, and schema verbatim, generated deterministic output with a fixed timestamp, and included the workbook so another developer can reproduce the import.

I import legacy bookings with their source references and materialise their problems in `issues`; I do not silently adjust bookings to make the rules pass. Materialised issues keep ordinary schedule reads away from expensive conflict self-joins and within D1's read budget. Date-window queries use the recorded maximum legacy span to bound the indexed search, including 425-day stays; new bookings are limited to 366 days.

I account for D1's 50-byte `LIKE` pattern limit after escaping wildcard characters and measuring UTF-8 bytes. Longer search text uses a parameterised literal substring check with `instr(lower(...), lower(?))`, preserving the full name instead of truncating it or failing on long, multibyte, or percent/underscore-heavy searches. Integration tests cover booking search, vessel search, exports, and model-produced vessel queries.

I use UTC-only calendar helpers because reviewers may be in New York and JavaScript local-time getters can display the previous date. The first view opens December 2019 so a first-time reviewer sees real records immediately, with Today and Latest data providing explicit navigation.

I enforce overlap and vessel-location rules inside the conditional database write as well as checking them beforehand for clear errors. The single write closes the check-then-insert race. Title or notes edits can still annotate a conflicted legacy booking; changing a scheduling field requires normal validation and removes the old issue records on success.

I implement all-history searches as progressive 400-day windows with keyset pagination inside each window. A cross-window stay appears once, and CSV export visits every window instead of exporting only the currently loaded table rows. This preserves the API’s query bounds while making “everything for a vessel” search the complete imported history.

I make alternative berths and shifted dates deterministic. Best-fit berth ordering preserves large berths for large vessels, and the model cannot decide whether a booking is safe. Ask applies search/navigation requests directly to the spreadsheet-style schedule after a brief typing pause, using a debounce of about 400 ms. Enter or the arrow button runs the current request immediately. Editing the text cancels the previous request and prevents stale responses from changing the filters; clearing the input removes the filters while preserving the current month. I store filters in the URL and show removable chips, so there is no hidden pending state or Apply step. I retain every selected berth, vessel, kind, and issue type. A full-year request begins in January, month arrows preserve and respect the date bounds, and deliberate month/Today/Latest data navigation removes only those bounds. Counts and occupancy identify their filtered scope, and clipped bars still open the unmodified booking details. Issue-type filters use dated issue records for the visible window so a problem earlier in a long stay cannot incorrectly appear in a later month.

For a booking request, Ask waits for an explicit Enter or arrow-button submission before opening a single editable draft. Typing alone neither opens a draft nor writes to the database. I leave missing or ambiguous facts blank rather than inventing them. Save booking remains the only write action and uses the usual server-side rules, conflicts, and alternatives; after success, the schedule focuses the saved record. A deterministic parser provides the same filter/draft flow when Workers AI is unavailable.

I retain the joke only in “Berthday” and its tagline. Operational actions and error messages use plain language such as “Save booking” and identify the actual berth, vessel, dates, or lengths involved.

I provision the D1 database by the name `berthday` and verify a supplied ID against that name and the configured account. This adds the name check missing from the PRD's example provisioning script. Deployments only seed an empty database; resetting edited data requires the workflow's explicit reseed input. The Worker name, database name, artifact names, CI labels, and smoke-test URL consistently use Berthday.

## Questions for the dock coordinator

1. Can North Pier West (410 ft) host several vessels at once? The summary credits it with 648 days in 2012. If so, should a sum-of-vessel-lengths rule replace the exclusive booking rule there, and what clearance is required between vessels? This is the first decision to confirm.
2. Is the labelled berth length a hard maximum, or does safe mooring require a margin?
3. Are same-day turnovers common enough to justify arrival/departure times instead of whole days?
4. Is “Marsh Landing,” which appears only in the summary, the unlabelled booking rows below South Float East?
5. What do the column-B names in 2011–2019 represent—resident vessels or another convention?
6. Who may override a rule, and what reason and audit record should an override require?

## Future work

I would start with length sharing on explicitly configured berths and time-of-day turnovers once the coordinator confirms those operating rules. Authentication, roles, an audit log, and override-with-reason are the next steps for a production multi-user service. Vessel contacts from Science/Yachts and the separate Tours schedule remain out of scope for this migration.

## Validation

The initial release verification included all 13 unmodified Python golden tests on Python 3.12 with openpyxl 3.1.5. Its output is 2,587 reservations, 635 vessels, nine resources, and 48 schedule issues. I also applied the schema and seed to SQLite with foreign keys enabled, verified integrity and references, and applied the seed twice to confirm repeatability. The 75 TypeScript unit tests include UTC edge cases, all shared rules and alternatives, deterministic Ask parsing, and parity with every imported Python issue. The 16 Worker integration tests exercise actual local D1, including simultaneous conflicting creates, notes-only legacy edits, a 425-day stay, issue review and cleanup, validation, pagination, Ask responses, and CSV escaping. Six provisioning tests cover reuse, creation, malformed IDs, missing IDs, and rejection of an ID that belongs to another database.

I resolved the local integration environment with Vitest 4.1.11, the Cloudflare pool 0.22.0, and the declared Miniflare `sharp` 0.35.4 override. The test runtime uses compatibility date `2026-08-22`, the latest date its bundled workerd accepts; production remains on the PRD's `2026-09-01`. Python uses an isolated Python 3.12 environment with openpyxl 3.1.5, and CI installs the same declared dependencies on Node.js 22. The Python tests generate migration fixtures before JavaScript tests, so CI runs the parity check instead of skipping it.

The initial release’s local check passed 110 automated tests, both TypeScript checks, and the production build. Local browser verification covered all five pages at 390 px without document overflow; both historical Clear Tern records; the 4/29/15 issue counts; the July 2017 overlap and March 2010 Golden Compass bar; Wild Tern's fit rejection and successful North Pier East alternative; 23 new fit issues at 300 ft and 23 cleared at 200 ft for Golden Compass; 120 ft availability on North Pier East and North Pier West; and the required Ask example through filter application.

The initial deployment at [Berthday](https://berthday.bill-nguyentonhoang.workers.dev) used version `initial-20260922`. The deployed smoke script and 16 live API checks passed, including the imported months and issue counts, 120 ft availability, fit/conflict errors with alternatives, temporary create/edit/delete operations, Ask fallback, JSON API 404s, and direct SPA routing. The temporary booking was removed, leaving the remote database at its original 2,587 reservations, zero app-created reservations, and 48 schedule issues. Live browser verification at 1280 px confirmed that the document and viewport were both 1280 px wide, the initial month was December 2019, and the schedule showed nine booking bars, seven vessels, 17% occupancy, and zero issues that month. Loading `/issues` directly showed the 4/29/15 category counts. The broader interactive and mobile checks listed above were performed locally.

The schedule/Ask update passed 188 automated tests: 146 unit, 23 Worker API, 6 provisioning, and 13 migration, plus both TypeScript checks and the production build. Local browser verification covered one-submit January 2000 navigation, year/berth/event filters, immediate chip removal, event draft/save/focus, conflict rejection with alternatives, and preservation of blank required fields. The schedule and event form fit a 390 px viewport without document overflow, and the temporary local event was removed.

The live deployment used existing local Cloudflare OAuth credentials. The initial GitHub Actions test job passed, but its deployment job failed because `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are not configured as repository secrets. Manual Wrangler deployment does not supply those secrets to GitHub Actions.
