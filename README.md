# rvl-sbqr-mocks

Mock services supporting development and integration testing around the
RVL SBQR platform.

This is a monorepo of independently deployable mock applications. Each
directory under `services/` is a standalone mock with its own `src/`,
`Dockerfile`, and `README.md`. The repository is polyglot by design:
services may use different programming languages, frameworks, build
systems, or runtimes.

> Scaffolding only — no mock functionality is implemented yet. Service
> `src/` directories are intentionally empty and the `Dockerfile` files
> are placeholders.

## Layout

```text
rvl-sbqr-mocks/
├── services/
│   ├── fi-idp-mock/
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
| [`services/bb-trust-store-mock/`](services/bb-trust-store-mock/README.md) | Mock Bangladesh Bank trust-store integration |
| [`services/hsm-mock/`](services/hsm-mock/README.md) | Mock HSM-related functionality (never a real HSM) |

## Shared

[`shared/`](shared/README.md) may later hold artefacts intentionally
shared between mocks (contracts, schemas, fixtures, sample payloads,
development certificates, common test data). It must not introduce
runtime coupling between services.
