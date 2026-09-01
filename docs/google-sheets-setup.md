# Google Sheets setup

## 1. Add the Apps Script

Open the target Google Sheet → **Extensions → Apps Script**. Paste `extension/google-apps-script.gs`, change `SECRET`, and save.

## 2. Deploy the Web App

Go to **Deploy → New deployment → Web app**. Use:

- **Execute as:** Me
- **Who has access:** `Anyone` is the simplest option when your Workspace allows it.
- If your Workspace only offers **Anyone with Google account**, the extension can work after the Web App is opened once in the same Chrome profile and Google authorization is completed.

Use the deployed URL ending in **`/exec`** in the extension. Do not use `/dev` for the production extension; `/dev` is the development/test deployment.

## 3. Configure the extension

Enter:

- Google Sheet URL
- Apps Script Web App URL ending in `/exec`
- Sheet tab name (optional)
- Tracking column (optional, e.g. `D`)
- The same Bridge secret used in Apps Script

Click **Save settings**.

If Google returns HTTP 403 or an HTML authorization page, click **Open Apps Script Web App**, sign in/authorize the Web App, return to the dashboard, and try the action again. If your Workspace permits anonymous Web Apps, `Anyone` is the most reliable deployment for direct extension requests.

## 4. What sync writes

The bridge creates/reuses:

- `USPS Status`
- `USPS Link`

Rows are matched using normalized tracking numbers. Spaces, hyphens, quotation marks, and long IMpb-style numeric formats are supported.

## 5. Long tracking numbers in Sheets

For best results, format the tracking-number column as **Plain text** before pasting very long identifiers. The bridge also reads displayed cell text to preserve what the sheet shows.
