# Changelog

## 2.5.0

- Kept the v2.4 normal 30-second USPS result wait.
- Kept one automatic retry for a failed batch instead of adding a longer 45-second wait or multiple automatic retries.
- Added a dedicated **Not Loaded** state for batches where the USPS page could not be read after the automatic retry.
- Added a **Not Loaded batches** recovery section with retry-one and retry-all actions.
- Kept **Needs Review** as the safety-net category for unknown/unrecognized USPS results.
- Added individual retry actions for Not Loaded and Needs Review results.
- Kept the current USPS multi-tracking URL format.
- Updated the dashboard primary blue to `#88a5ed` with dark primary text.
- Kept clickable summary cards and Google Sheets sync.
