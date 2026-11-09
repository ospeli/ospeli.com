# Ospeli

**Healthcare operations.** Map processes. Optimise flow. Improve care.

Ospeli is an open-core, offline-first healthcare operations platform for hospitals and clinics. It is not a bed-management tool: the bed board is one module alongside engineering and maintenance, emergency department and patient flow, process mapping, playbooks for redesign, and guides for administrators. It is built for health systems everywhere, from small clinics to large hospitals, including sites with unreliable power and networks.

Website: https://ospeli.com · Demos (fictional hospital, synthetic data): https://ospeli.com/demo/

## What is in this repository
| Folder | Holds |
|---|---|
| `web/` | ospeli.com: product site at `/`, demo hub at `/demo/`, bed board at `/demo/bed-board/` |
| `web/app/` | The Ospeli app at `/app/`: offline-first PWA, shared core in `core/`, modules in `modules/` |
| `tests/` | Node unit tests (`npm test`) and Playwright end-to-end tests (`npm run test:e2e`) |
| `brand/` | Logo masters (brand kit v3.1) |
| `scripts/check.py` | Checks run on every push and every night |
| `docs/` | Rules and design principles |

## How it builds
Every push to `main`, and every night at 06:17 UTC, GitHub Actions runs `scripts/check.py`, the unit tests and the end-to-end tests and, if all pass, publishes `web/` to GitHub Pages at ospeli.com.

## Run it locally
`npm run serve` serves `web/` at http://localhost:8080/ (the app is at `/app/`). No build step and no dependencies; the end-to-end tests need Playwright with Chromium.

## Ground rules
Read [docs/RULES.md](docs/RULES.md) before contributing. In short: synthetic data only, people decide and Ospeli suggests, and patient data stays in the hospital.
