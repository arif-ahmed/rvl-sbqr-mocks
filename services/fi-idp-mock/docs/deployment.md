# fi-idp-mock — Fly.io deployment runbook

One Docker image, one Fly app per FI (same pattern as local compose):

| App | Fly hostname | Local port |
|---|---|---|
| `fi-idp-dhakabank` | `https://fi-idp-dhakabank.fly.dev` | `:5105` |
| `fi-idp-ebl` | `https://fi-idp-ebl.fly.dev` | `:5106` |

Configs: `fly.dhakabank.toml`, `fly.ebl.toml` (in `services/fi-idp-mock/`).
Both set `PORT = '8080'` in `[env]` — Fly's `[http_service]` targets
`internal_port = 8080`. Without that override the image default
(`ENV PORT=5105` in the `Dockerfile`) wins and the proxy health check
fails with `connect: connection refused` (seen 2026-09-24, fixed in `a2aa42e`).

## 1. Prerequisites

- `flyctl` installed (`flyctl.exe v0.4.107`, lives in `~/.fly/bin`).
  Windows install (own PowerShell):
  ```powershell
  powershell -Command "iwr https://fly.io/install.ps1 -useb | iex"
  $env:Path += ";$env:USERPROFILE\.fly\bin"
  flyctl version
  ```
- A Fly.io account (repo uses the `personal` org, `sin` region).

## 2. Login (console — must be interactive)

`fly auth login` **does not work from headless/agent shells**:

```text
Error: fly auth login requires an interactive terminal. In headless
environments, set FLY_API_TOKEN to a token created with `fly tokens create`
```

Dashboard "Access Tokens" only offers *App* / *Org* deploy tokens, which
cannot create apps — so first-time setup must go through the CLI login.
In your **own** PowerShell:

```powershell
$env:Path += ";$env:USERPROFILE\.fly\bin"
fly auth login      # browser tab opens — sign in there
fly auth whoami     # expect your account email/name
```

Optional, for driving deploys from automation later:

```powershell
fly auth token                 # prints a personal token (revoke after use)
fly tokens revoke <token-id>   # afterwards, or via dashboard Access Tokens
```

## 3. First-time setup (already done — do not repeat)

```powershell
cd services\fi-idp-mock
fly apps create fi-idp-dhakabank
fly apps create fi-idp-ebl
```

Optional: pin the public issuer explicitly (normally unnecessary —
`server.js` derives `https://<FLY_APP_NAME>.fly.dev` automatically):

```powershell
fly secrets set -a fi-idp-dhakabank ISSUER=https://fi-idp-dhakabank.fly.dev
fly secrets set -a fi-idp-ebl ISSUER=https://fi-idp-ebl.fly.dev
```

## 4. Deploy (what we executed)

Deploy each FI separately; verify Dhaka Bank before doing EBL:

```powershell
cd services\fi-idp-mock
fly deploy -c fly.dhakabank.toml   # ~2-4 min first run (remote builder)
fly deploy -c fly.ebl.toml
```

Expected tail: `Updating existing machines … rolling strategy`,
`✓ DNS configuration verified`,
`Visit your newly deployed app at https://fi-idp-<fi>.fly.dev/`.

## 5. Verify (run after every deploy)

```powershell
fly status -a fi-idp-dhakabank
fly checks list -a fi-idp-dhakabank
fly machine list -a fi-idp-dhakabank
fly logs -a fi-idp-dhakabank
curl.exe -s https://fi-idp-dhakabank.fly.dev/health; echo ""
curl.exe -s -X POST https://fi-idp-dhakabank.fly.dev/connect/token `
  -d "grant_type=password&username=fatima&password=fatima@1234"
```

Healthy state:

- `fly status` → `CHECKS 1/1`, log line `on :8080`,
  issuer `https://fi-idp-dhakabank.fly.dev`
- `/health` → `{"status":"ok","fi_id":"dhakabank",…,"users":5}` (EBL: `"users":4`)
- `/connect/token` → `token_type: Bearer`, `expires_in: 300` + `refresh_token`

Repeat with `-a fi-idp-ebl` / the EBL hostname for the second app.

## 6. "Service is down" — read this first

**A `stopped` machine is usually not an outage.** Both tomls set
`auto_stop_machines = true, min_machines_running = 0`, so idle machines
sleep; `fly status` then shows `stopped` and the check shows
`warning … the machine hasn't started`. Any request (including `curl
…/health`) wakes it via autostart within seconds.

Real failure vs. autostop — check in order:

```powershell
fly machine list -a fi-idp-<fi>    # started or stopped? CHECKS n/n?
fly checks list -a fi-idp-<fi>     # passing / warning / critical?
fly logs -a fi-idp-<fi>            # "on :8080"? crash loop? OOM?
curl.exe -s https://fi-idp-<fi>.fly.dev/health; echo ""
```

| Symptom | Meaning | Action |
|---|---|---|
| `stopped`, check `warning`, wakes on curl, then `1/1` | autostop idle | none — expected |
| check `critical`, `connection refused`, log says `on :5105` | port mismatch regressed | confirm `PORT='8080'` in toml `[env]`, redeploy |
| log shows crash / `Out of memory` on 256 MB | under-provisioned | bump `memory_mb` in `[[vm]]`, redeploy |
| stale `failed` machine from an old deploy alongside a healthy one | leftover | `fly machine destroy <id> -a fi-idp-<fi>` (only with explicit approval) |

## 7. Open / future investigation

- [ ] **Service showing down in dashboard** (reported 2026-09-24): run the
      §6 sequence against that app and record which row of the table it
      matches — autostop, port regression, OOM, or stale machine.
- [ ] Verify EBL end to end (`/health` users=4 + password login) if not
      already done — only Dhaka Bank verification output was reviewed.
- [ ] Decide alerting: with `min_machines_running = 0`, Fly sends no
      down-alerts; consider `min_machines_running = 1` for demo-critical
      windows (costs ~$2–3/mo per idle shared machine).
- [ ] Wire BFF `Auth__Authority` to the Fly issuers and add the emulator
      FI switcher (companion changes in `rvl-sbqr-fi-gateway`).
- [ ] Optional hardening: drop `PORT=5105` from the `Dockerfile` default
      so a missing `PORT` fails loudly — weighs against bare
      `docker run` convenience; no action until agreed.
