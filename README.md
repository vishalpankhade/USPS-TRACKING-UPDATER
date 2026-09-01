# USPS Bulk Tracker

A Chrome extension that turns repetitive USPS tracking checks into a faster dashboard workflow.

> **Not affiliated with or endorsed by the United States Postal Service.**

[**⬇️ Download Latest Extension**]([https://github.com/YOUR-USERNAME/YOUR-REPO/releases/latest/download/usps-bulk-tracker-v2.6.0.zip](https://github.com/vishalpankhade/USPS-TRACKING-UPDATER/releases/latest/download/usps-bulk-tracker-v2.7.1.zip) · [Releases]([⬇️ Download Latest Extension](https://github.com/vishalpankhade/USPS-TRACKING-UPDATER/releases/latest/download/usps-bulk-tracker-v2.7.1.zip)) · [Report a bug](../../issues)

## What it does

Paste as many USPS tracking numbers as you have, or fetch them directly from Google Sheets. The extension automatically splits them into USPS-compatible batches of up to 35 tracking numbers, opens the official USPS tracking page, reads the visible results, categorizes them, and can write a short status plus USPS link back into your Google Sheet.

## Status categories

- **Delivered** — USPS indicates delivery.
- **Not Delivered** — USPS indicates the package is still in progress or has a delivery-related status.
- **Alerts** — USPS returns an alert message.
- **Awaiting USPS** — USPS indicates the label/item is awaiting USPS acceptance or scan.
- **Tracking Not Available** — USPS cannot provide meaningful tracking information.
- **Not Loaded** — the USPS page for a whole batch failed to load/read after the normal automatic retry. These batches are kept in a separate retry queue.
- **Needs Review** — the parser cannot confidently recognize the USPS response. This is intentionally a safety-net category.

## Safe retry behavior in v2.6.0

This release deliberately keeps the v2.4 timing flow rather than introducing a 45-second initial wait or several automatic retries.

For each USPS batch:

```text
Open USPS batch
      ↓
Normal result wait
      ↓
If failed → one automatic retry of the same batch
      ↓
If still failed → Not Loaded queue
      ↓
Continue with the next batch
```

After the run, you can retry one failed batch or retry all Not Loaded batches. A failed page load is not treated as Needs Review.

## Google Sheets workflow

With the optional Apps Script bridge configured:

```text
Google Sheet
     ↓
Fetch tracking numbers
     ↓
USPS batches of 35
     ↓
Read USPS results
     ↓
Match by tracking number
     ↓
Write short USPS Status + clickable USPS Link
```

See [Google Sheets setup](docs/google-sheets-setup.md).

## Installation

### From a GitHub release

1. Download the latest release ZIP.
2. Extract it.
3. Open `chrome://extensions`.
4. Enable **Developer mode**.
5. Click **Load unpacked**.
6. Select the extracted folder that contains `manifest.json`.

See [Installation](docs/installation.md).

### Chrome Web Store

A future Chrome Web Store release can provide the normal **Add to Chrome** installation experience. Until then, the GitHub release uses Chrome's developer-mode installation flow.

## Project structure

```text
usps-bulk-tracker/
├── extension/
│   ├── manifest.json
│   ├── background.js
│   ├── content.js
│   ├── dashboard.html
│   ├── dashboard.css
│   ├── dashboard.js
│   ├── popup.html
│   ├── popup.js
│   ├── google-apps-script.gs
│   └── README.md
├── docs/
├── release/
├── CHANGELOG.md
├── LICENSE.txt
├── PRIVACY.md
├── SECURITY.md
└── README.md
```

## Privacy and security

The extension is designed to keep tracking data in the user's browser and to use the official USPS tracking website rather than a paid tracking API. Optional Google Sheets syncing uses a Google Apps Script deployment owned by the user.

Do not publish real bridge secrets, customer tracking lists, private spreadsheet data, or confidential screenshots.

See [PRIVACY.md](PRIVACY.md) and [SECURITY.md](SECURITY.md).

## Technical notes

The extension depends on the current USPS tracking webpage structure. USPS may change its page markup or loading behavior; when a result cannot be confidently classified, the extension favors **Needs Review** rather than guessing. A page-load failure is kept separately as **Not Loaded** so it can be retried.

## Roadmap

- Improve USPS parser coverage as USPS wording changes.
- Add better batch diagnostics/history.
- Improve Google Sheets setup and error guidance.
- Publish a Chrome Web Store version.

## License

MIT. See [LICENSE.txt](LICENSE.txt).
