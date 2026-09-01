# Changelog

## v2.7.1

- Keeps USPS batch-processing tabs in the background so the dashboard stays focused.
- USPS batch result pages no longer steal browser focus while a check is running.
- Existing v2.7.0 features and Google Sheets workflow remain unchanged.

## v2.7.0

- Added a polished, persistent light/dark mode for the full dashboard.
- Added tracking-format filters, including **IMpb / Long**.
- Tracking input now accepts USPS package identifiers up to 34 digits, including IMpb-style formats.
- Cleans surrounding quotes, spaces, and hyphens before checking.
- Keeps the existing fast v2.4-style batch flow: one normal attempt plus one automatic retry, then a separate Not Loaded queue.
- Keeps Recheck non-delivered, Needs Review retry, and Stop/Resume behavior.
- Google Sheets reader now uses displayed cell text so long tracking numbers and formatting are preserved.
- Google Sheets setup messaging now clearly distinguishes `/exec` (production) from `/dev` (development).
- Added an Open Apps Script Web App button to make Workspace authorization/setup easier.

## v2.6.0

- Added non-delivered recheck workflow and Sheets browser-login fallback.
