# Google Sheets setup

The Google Sheets integration uses a Google Apps Script web app that you own. No paid tracking API is required.

## 1. Open Apps Script

Open your Google Sheet → **Extensions → Apps Script**.

Open `extension/google-apps-script.gs` from this repository and paste its contents into the Apps Script editor.

## 2. Set a private bridge secret

Change the placeholder secret in Apps Script to a random value. Use the same value in the extension's **Bridge secret** field.

Never commit your real secret to GitHub.

## 3. Deploy

In Apps Script:

**Deploy → New deployment → Web app**

Use:

- **Execute as:** Me
- **Who has access:** Anyone

Authorize the project when Google asks.

Copy the resulting Web App URL ending in `/exec`.

## 4. Configure the extension

Enter:

- **Google Sheet URL:** the spreadsheet you want to update
- **Apps Script Web App URL:** the `/exec` URL from the deployment
- **Sheet tab name:** optional; leave blank to use the first tab
- **Tracking column:** optional; leave blank for automatic detection
- **Bridge secret:** the same secret used in Apps Script

Save the settings.

## 5. Run

Use **Fetch from Google Sheet & Check USPS**.

The extension reads the tracking numbers, checks USPS in batches of up to 35, and can update the matching rows as results arrive when automatic sync is enabled.

The sync writes a short USPS status and a clickable USPS tracking link. It does not write the full USPS page text into the status column.
