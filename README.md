# Chase Statement Downloader 🚀

Automated Playwright script to download monthly credit card statements from Chase Bank. Supports both latest statement retrieval and bulk archival (up to 7 years).

## Features

- 🔐 **Session Persistence**: Saves cookies to `chase_session.json` to reduce MFA frequency.
- 📱 **MFA Ready**: Handles "Confirm in Mobile App" identity verification flow.
- 📂 **Auto-Organization**: Sorts PDFs into `Chase-{accountMask}` folders.
- 🔄 **Bulk Mode**: Scans history from `CURRENT_YEAR_MINUS_1` through `CURRENT_YEAR_MINUS_7`.
- ⚡ **Smart Skipping**: Won't re-download PDFs that already exist locally.

## Setup

1. Clone the repository and install dependencies:
   ```bash
   npm install
   ```
2. Create a `.env` file in the root:
   ```env
   USERNAME=your_username
   PASSWORD=your_password
   ```

## Usage

### Latest Statements

Downloads the most recent statement for every found credit card (type 'BAC'):

```bash
node chaseAutoDownloader.js
```

### Bulk Archive

Iterates through the last 7 years of history for all cards:

```bash
node chaseAutoDownloader.js --bulk
```

## Development

- **Linting**: `npm run lint`
- **Formatting**: `npm run format`
- **Screenshots**: Check the `screenshots/` directory for visual debugging after a run.

## Tech Stack

- [Playwright](https://playwright.dev/)
- [Dotenv](https://github.com/motdotla/dotenv)
- Node.js
