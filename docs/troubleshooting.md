# Troubleshooting

## USPS page is slow or stuck

The extension keeps the normal v2.4 timing flow. A batch gets the normal result wait and one automatic retry. It does not wait 45 seconds before the first retry.

If the same batch still cannot be loaded, it is placed in the dedicated **Not Loaded** section. Use **Retry batch** or **Retry all not-loaded batches** after the main run finishes.

## Needs Review is empty

That is normally a good sign. Needs Review is a safety net for USPS responses that the parser does not confidently recognize. A USPS page that failed to load belongs in **Not Loaded**, not Needs Review.

## Google Sheet cannot be read

Check that:

- The spreadsheet URL is correct.
- The Apps Script Web App URL ends with `/exec`.
- The deployment is active.
- The bridge secret matches exactly.
- The sheet tab name is correct, or is left blank for automatic selection.
- Your Google Apps Script contains the latest `google-apps-script.gs` from this release.

## Chrome says the extension cannot run

Make sure you selected the folder that directly contains `manifest.json` when using **Load unpacked**.

On a company-managed computer, your organization may restrict developer-mode extensions. Contact your administrator if Chrome blocks installation.
