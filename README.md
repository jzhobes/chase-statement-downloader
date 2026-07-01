# Chase Statement Downloader 🚀

Automated Playwright script to download monthly credit card statements from Chase Bank. Supports year-by-year retrieval and bulk archival.

## Features

- 🔐 **Session Persistence**: Saves cookies to `chase_session.json` to reduce MFA frequency.
- 📱 **MFA Ready**: Handles "Confirm in Mobile App" identity verification flow.
- 📂 **Auto-Organization**: Sorts PDFs into `Chase-{accountMask}` folders.
- 📅 **Year Selection**: Downloads every statement from `CURRENT_YEAR` through `CURRENT_YEAR_MINUS_7`.
- 🔄 **Bulk Mode**: Scans `CURRENT_YEAR` through `CURRENT_YEAR_MINUS_7`.
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

Build the TypeScript source first:

```bash
npm run build
```

### Current Year

Downloads every current-year statement for every found credit card (type 'BAC'):

```bash
npm start
```

By default, the browser runs headed so Chase sees a session closer to a normal manual login.
To run headless:

```bash
HEADLESS=true npm start
```

### Specific Year

Pass a year offset from `1` through `7`. For example, this downloads every statement from `CURRENT_YEAR_MINUS_1`:

```bash
npm start -- 1
```

This downloads every statement from `CURRENT_YEAR_MINUS_7`:

```bash
npm start -- 7
```

### Bulk Archive

Downloads every statement from `CURRENT_YEAR` through `CURRENT_YEAR_MINUS_7`:

```bash
npm run bulk
```

Headless bulk mode:

```bash
HEADLESS=true npm run bulk
```

## Development

- **Run without building**: `npm run dev` or `npm run dev:bulk`
- **Build**: `npm run build`
- **Type Checking**: `npm run typecheck`
- **Linting**: `npm run lint`
- **Formatting**: `npm run format`
- **Screenshots**: Check the `screenshots/` directory for visual debugging after a run.

## Tech Stack

- TypeScript
- [Playwright](https://playwright.dev/)
- [Dotenv](https://github.com/motdotla/dotenv)
- Node.js
