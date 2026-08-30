# USPS Bulk Tracker Extension

This folder is the installable Chrome extension source. Load this folder directly with `chrome://extensions` → **Developer mode** → **Load unpacked**.

The extension processes USPS tracking numbers in batches of up to 35 through the official USPS tracking page. It keeps one automatic retry for a failed batch and places batches that still fail into the dashboard's **Not Loaded** retry queue.
