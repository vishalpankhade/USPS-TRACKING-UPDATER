# Changelog

## v2.9.0

- Alerts are classified whenever the USPS result text contains `Alert`.
- Added **Check newly pasted numbers** so additional tracking numbers can be checked without rerunning existing ones.
- Existing results are preserved/replaced by tracking number without duplicates.
- Corrected release packaging so the installable ZIP contains `manifest.json` at the ZIP root.

## v2.9.0
- Improved USPS Alert detection: any tracking detail containing `Alert` is classified as Alerts.
- Improved Awaiting USPS detection for USPS Awaiting Item, Shipping Label Created, and pre-shipment wording.
- Added **Check newly pasted numbers** so users can append tracking numbers after a completed run and check only the new ones.
- Existing results are preserved and replaced by tracking number when new checks are run.

## v2.8.0

- Improved USPS response classification for alerts written with a dash/em dash.
- Classifies `USPS Awaiting Item` / shipping-label waiting responses as **Awaiting USPS**.
- Classifies USPS acceptance / possession / on-the-way responses as **Not Delivered** instead of Needs Review.
- Replaced the fixed “Retry Needs Review” action with a context-aware **Retry [current section]** action.
- Removed the IMpb badge from every result card. Long numeric tracking is now treated as a format filter rather than a claim that every long number is definitely IMpb. USPS describes IMpb as variable-length package barcodes, so length alone is not proof of IMpb.
- Kept long numeric tracking input support, including spaced/quoted values.

## v2.7.1

- USPS processing tabs open in the background so the dashboard keeps focus.
