# Ospeli

**Healthcare operations.** Map processes. Optimise flow. Improve care.

Ospeli is an open-core, offline-first healthcare operations platform for hospitals and clinics. It is not a bed-management tool: the bed board is one module alongside engineering and maintenance, A&E and patient flow, process mapping, playbooks for redesign, and guides for administrators. It is built for health systems everywhere, starting with low-resource public hospitals.

Website: https://ospeli.com · Demos (fictional hospital, synthetic data): https://ospeli.com/demo/

## What is in this repository
| Folder | Holds |
|---|---|
| `web/` | ospeli.com: product site at `/`, demo hub at `/demo/`, bed board at `/demo/bed-board/` |
| `brand/` | Logo masters (brand kit v3.1) |
| `scripts/check.py` | Checks run on every push and every night |
| `docs/` | Rules and design principles |

## How it builds
Every push to `main`, and every night at 02:17 Trinidad time, GitHub Actions runs `scripts/check.py` and, if it passes, publishes `web/` to GitHub Pages at ospeli.com.

## Ground rules
Read [docs/RULES.md](docs/RULES.md) before contributing. In short: synthetic data only, people decide and Ospeli suggests, and patient data stays in the hospital.
