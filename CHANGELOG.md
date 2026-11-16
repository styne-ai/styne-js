# Changelog

## 0.2.0 - 2026-11-16

- Regions: `new Styne({ region: "ams" })` or `STYNE_REGION` pick `https://<region>.api.styne.ai`. Regions are `ash` (US East) and `ams` (Europe);
  `us-east`, `ashburn`, `eu` and `eu-central` are accepted too. The chosen region is also the region of every browser and VM create that names none
  (a create from a snapshot keeps the snapshot's region). `baseUrl` and `STYNE_BASE_URL` take precedence.
- The default API host is now `ash.api.styne.ai` (it was `api.styne.ai`).
- `browser.withReconnect` and `isSocketClosed`: connect again and run your function again after the CDP socket closes; pass your own
  `isDisconnect` to change what counts as one.
- A rejected base URL no longer appears in full in the error message.

## 0.1.0

- First release as `styne-sdk`: VMs, files, ports, checkpoints, snapshots, cloud browsers.
