---
name: clawhub-security-dataset
description: Use when generating, publishing, validating, or changing the ClawHub security/eval dataset export, nightly snapshot workflow, Hugging Face dataset upload, Convex export ingestion, or sanitizer/redaction logic.
---

# ClawHub Security Dataset

This skill covers the maintainer-facing ClawHub security/eval dataset export.
The dataset is public; raw Convex exports, broad production credentials, storage
ids, internal document ids, and obvious secrets are not.

## First Pass

- Read `AGENTS.md`, `convex/_generated/ai/guidelines.md`, and the current
  Linear coordination issue when this is issue-backed work.
- Check recent commits and security branches before editing:

```sh
git fetch --all --prune
git log --oneline --decorate --date-order -18 origin/main
```

- Inspect the current command and data path:

```sh
node -e "const p=require('./package.json'); for (const [k,v] of Object.entries(p.scripts)) if(k.includes('dataset')) console.log(k+'='+v)"
rg -n "securityDataset|dataset:snapshot|hf-dataset|convex-export|storageId|redaction" convex scripts .github/workflows package.json
```

## Command Map

Dry-run a tiny live export against the configured Convex deployment:

```sh
bun run dataset:snapshot -- --dry-run --limit 10
```

Dry-run production only when the target deployment and auth boundary are clear:

```sh
bun run dataset:snapshot:prod:dry-run
```

Build sanitized files from a local Convex export ZIP:

```sh
bun run dataset:snapshot -- \
  --convex-export-zip /path/to/export.zip \
  --source-snapshot-id <snapshot-id> \
  --out-dir .data/security-dataset/snapshots \
  --hf-dataset
```

Useful flags:

- `--prod` or `--deployment <name>` selects the Convex runtime. Do not use both.
- `--push` pushes current Convex functions before `convex run`; use only when
  that is intentional.
- `--limit <n>` caps source artifacts for proof runs.
- `--source-kind skill|package|all` narrows source rows.
- `--created-after <date>` and `--created-before <date>` constrain by created
  time.
- `--hf-dataset`, `--hf-repo`, `--hf-revision`, and `--hf-commit` control the
  Hugging Face-shaped split files and manifest metadata.

## Security Rules

- Prefer the live sanitized Convex export path for nightly automation unless a
  genuinely narrow Convex backup-reader credential exists.
- Do not automate backup downloads with broad deploy/admin credentials.
- Do not upload raw Convex backups, raw `_storage` blobs, raw `storageId`, or
  internal Convex document ids to Hugging Face.
- The backup ZIP importer must resolve `_storage/<storageId>` only so sanitizer
  logic can redact and cap public output content.
- Reuse the shared sanitizer/normalizer for live exports and backup ZIP imports.
  Do not add a second redaction policy without a manifest version bump.
- Hugging Face writes should use the dataset repo `OpenClaw/clawhub-security-signals`
  and OIDC/trusted publishing when available.

## Output Shape

The maintained output is:

- normalized JSONL: `artifacts.jsonl`, `scan_results.jsonl`,
  `static_findings.jsonl`, `clawscan_findings.jsonl`, `labels.jsonl`,
  `splits.jsonl`
- optional HF rows under `hf-dataset/data/{train,validation,test,eval_holdout}.jsonl`
- `manifest.json` with source id, exporter git SHA, redaction policy version,
  row counts, output sizes, selected splits/configs, and HF repo/revision/commit
  metadata when applicable

## Validation

Run focused tests after changing this subsystem:

```sh
bun test scripts/security-dataset
```

For workflow or publish-path changes, also produce a dry-run proof with a small
limit and inspect the generated manifest/output:

```sh
bun run dataset:snapshot -- --dry-run --limit 10 --hf-dataset
```

Before claiming output is safe, search generated sanitized files for forbidden
markers:

```sh
grep -R -E 'storageId|skillVersions:|packageReleases:|_storage/' <snapshot-dir>
grep -R -E 'gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z0-9 ]*(PRIVATE KEY|CERTIFICATE)-----' <snapshot-dir>
```

If credentials are available, validate a manual workflow run against a test HF
revision before enabling or trusting the scheduled production upload.

## Common Mistakes

- Treating Convex Team Access Tokens as read-only backup credentials without
  verifying Custom Roles or an equivalent permission boundary.
- Blessing a backup-based workflow after the team decided a live sanitized
  export is safer without narrow backup-read auth.
- Documenting a successful dry run as a successful HF upload.
- Forgetting that `--dry-run` does not write snapshot files.
- Removing manual/admin export commands before the nightly path has equivalent
  proof and a maintained entrypoint.
