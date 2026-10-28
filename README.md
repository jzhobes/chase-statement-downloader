# Chase Statement Downloader 🚀

A personal tool for downloading monthly Chase credit card statements with Playwright. Download one year or archive all available statements from the current year through seven years back.

Built for Chase’s personal online banking experience. Business cards and Chase Business Online profiles, including linked personal accounts, are outside the supported scope.

This is an unofficial tool with no affiliation with Chase. Changes to Chase’s website may break it. Maintenance is best effort.

## Setup

Install [Bun](https://bun.sh/) 1.4.4 or later, clone the repository, and install the dependencies and Chromium:

```bash
bun install
bunx --bun playwright install chromium
```

Copy the environment template and fill in your Chase credentials in `.env`:

```bash
cp .env.example .env
```

## Usage

Run commands from the project root. The browser is visible by default so you can complete verification when needed.

| Command           | Downloads                                           |
| ----------------- | --------------------------------------------------- |
| `bun run start`   | Current year                                        |
| `bun run start 1` | Previous year; accepts offsets from `1` through `7` |
| `bun run bulk`    | Current year through seven years back               |

To run without a visible browser:

```bash
HEADLESS=true bun run bulk
```

Statements are saved to `statements/Chase-{accountMask}/`. Completed PDFs are skipped on subsequent runs. If multiple documents share a date, their filenames include a document fingerprint to keep them separate. Session cookies are saved to reduce repeated logins and MFA.

## Troubleshooting

- If headless mode fails, check `screenshots/error_state.png` and retry with `HEADLESS=false`.
- If a saved session cannot be loaded, delete `chase_session.json` and sign in again.
- Set `DEBUG_MFA=true` in `.env` for extra verification diagnostics.
- If downloads fail, check the final summary and rerun the same command to retry.

Keep `.env`, `chase_session.json`, screenshots, and statements private. They are excluded from Git. Screenshots may contain account information or verification codes and can be overwritten on later runs.

## Development

- Run all checks: `bun run check`
- Run offline tests: `bun run test`
- Check types: `bun run typecheck`
- Lint: `bun run lint`
- Format: `bun run format`

## License

[ISC](LICENSE)
