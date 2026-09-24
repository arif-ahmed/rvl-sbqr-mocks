# rvl-sbqr-mocks

Mock services supporting development and integration testing around the
RVL SBQR platform.

This is a monorepo of independently deployable mock applications. Each
directory under `services/` is a standalone mock with its own `src/`,
`Dockerfile`, and `README.md`. The repository is polyglot by design:
services may use different programming languages, frameworks, build
systems, or runtimes.

> Some services are real implementations (`fi-idp-mock`,
> `sbqr-api-mock`); others are still scaffolding with empty `src/`
> directories and placeholder `Dockerfile`s (`bb-trust-store-mock`,
> `hsm-mock`). The `Services` table below marks each accordingly.

## Layout

```text
rvl-sbqr-mocks/
├── services/
│   ├── fi-idp-mock/
│   │   ├── src/
│   │   ├── Dockerfile
│   │   └── README.md
│   ├── sbqr-api-mock/
│   │   ├── src/
│   │   ├── Dockerfile
│   │   └── README.md
│   ├── bb-trust-store-mock/
│   │   ├── src/
│   │   ├── Dockerfile
│   │   └── README.md
│   └── hsm-mock/
│       ├── src/
│       ├── Dockerfile
│       └── README.md
├── shared/
├── docker-compose.yml
├── .gitignore
└── README.md
```

## Services

| Service | Purpose |
|---|---|
| [`services/fi-idp-mock/`](services/fi-idp-mock/README.md) | Mock Financial Institution Identity Provider |
| [`services/sbqr-api-mock/`](services/sbqr-api-mock/README.md) | Mock sbqr.api (BanglaQR P2P upstream, signed payloads, verdict vocabulary) |
| [`services/bb-trust-store-mock/`](services/bb-trust-store-mock/README.md) | Mock Bangladesh Bank trust-store integration |
| [`services/hsm-mock/`](services/hsm-mock/README.md) | Mock HSM-related functionality (never a real HSM) |

## Shared

[`shared/`](shared/README.md) may later hold artefacts intentionally
shared between mocks (contracts, schemas, fixtures, sample payloads,
development certificates, common test data). It must not introduce
runtime coupling between services.

## Companion repos

`rvl-sbqr-mocks` is one of several sibling repositories that make up
the SBQR workflow. Each is independently versioned and buildable:

- **`rvl-sbqr-fi-gateway`** — the FI Backend BFF. The
  `tmp/fakes/fake-sbqr-api.js` family there is a CI smoke fixture;
  the canonical upstream stand-in is `sbqr-api-mock` in this repo.
- **`rvl-sbqr-app-emulator`** — the React + Vite SPA that emulates the
  FI mobile app. It consumes this stack for offline end-to-end runs.
  The previously-shared `mock/mock-sbqr-api.cjs` was promoted into
  this repo as `services/sbqr-api-mock/src/mock-sbqr-api.cjs`.
- **`rvl-sbqr-workspace`** *(planned)* — a thin umbrella repo
  (`README.md` + `scripts/bootstrap.sh` + cross-repo docs) that
  orchestrates bringing the four repos up side-by-side. Not a
  monorepo, not a build orchestrator — just an onboarding landing
  pad.
