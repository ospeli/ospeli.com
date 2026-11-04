# Ospeli

**Healthcare operations.** Map processes. Optimise flow. Improve care.

Ospeli is an open-core, offline-first operations platform for hospitals and clinics: a live bed board, engineering work orders, A&E and patient flow, process mapping, and playbooks for redesign. It is built for health systems everywhere, starting with low-resource public hospitals.

Live demo (fictional hospital, synthetic data): https://demo.ospeli.com

## What is in this repository
| Folder | Holds |
|---|---|
| `web/` | The demo site: bed board at `/`, product site at `/site/` |
| `brand/` | Logo masters (brand kit v3.1) |
| `scripts/check.py` | Checks run on every push and every night |
| `docs/` | Rules and design principles |

## How it builds
Every push to `main`, and every night at 02:17 Trinidad time, GitHub Actions runs `scripts/check.py` and, if it passes, publishes `web/` to GitHub Pages at demo.ospeli.com.

## Ground rules
Read [docs/RULES.md](docs/RULES.md) before contributing. In short: synthetic data only, people decide and Ospeli suggests, and patient data stays in the hospital.
