# Publication maintenance

The source project builds packages separately. This repository downloads only a successful build artifact, validates its runtime allowlist and source checksum, then publishes a versioned Release and submits the same bytes to MiaoMiao. The official store is disabled.

Actions Secrets:

- `LPK_SOURCE_REPOSITORY`: source `owner/repo`; keep the actual value out of public files.
- `SOURCE_REPO_TOKEN`: source Actions Read-only access; prefer the authorized organization Secret. Do not copy a local GitHub login token or grant source Contents access.
- `APPSTORE_URL`, `APPSTORE_TOKEN`: MiaoMiao organization credentials.
- `PRIVATE_STORE_GROUP_CODES`: optional organization Secret.

Organization Secrets must authorize this repository. The source token must cover the source project and satisfy its approval, expiration and organization policies. `LPK_SOURCE_BRANCH` optionally selects a trusted branch; it defaults to `main`. Builds must come from `release.yml`, not pull requests or forks.

Add user-facing notes to `releases/v<version>.md`. Dispatch `publish.yml` with the successful source run ID and `dry-run=true` first, then the same ID with `dry-run=false`. Scheduled runs poll twice an hour. Source artifacts expire after three days; publication must finish within that window.

Existing Release assets are downloaded and hashed before reuse. Different bytes at the same version fail without replacement. A recoverable draft is reused instead of creating a second Release. Store submission occurs only after the canonical public download URL is read back, and existing store versions are skipped.
