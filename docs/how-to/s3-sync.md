# Sync a vault through your own S3 bucket

Zotly can sync a vault through an S3 bucket you own, with no server in between.
Each device runs the same sync engine as ZenNotes Cloud; the bucket holds an
append-only change log, the file bytes and periodic snapshots
(`packages/shared-domain/src/s3-sync-remote.ts` describes the layout).

## What the bucket needs

- **Conditional writes.** Sync claims each log entry with `If-None-Match: *`.
  Amazon S3 supports this; check any S3-compatible service before using it.
- **Versioning is not required.** Log entries and blobs are never overwritten.
- **Keep the log.** Don't add a lifecycle rule that expires `log/` or `blobs/`
  objects yet; pruning is not implemented.

## Least-privilege IAM policy for one device

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": "arn:aws:s3:::YOUR-BUCKET/zotly/*"
    },
    {
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::YOUR-BUCKET",
      "Condition": { "StringLike": { "s3:prefix": "zotly/*" } }
    }
  ]
}
```

No `s3:DeleteObject` is needed: sync never deletes objects.

## Turning it on in the desktop app

Open Settings, then Vault, then S3 sync. Fill in the bucket, region, folder
in the bucket (`zotly/` by default) and a vault name, then the access key ID
and secret, and press Connect and sync. Leave the endpoint empty for Amazon
S3; for Cloudflare R2 or MinIO put the service address there.

On a second computer, open the vault folder you want to fill and use the
same bucket, folder and vault name. A note already on both computers with
different text is held until you pick a version on that page: keep this
computer's, use the bucket's, or keep both.

The secret key is kept in the system keychain (or Electron's safeStorage
where there is no keychain), never in `settings.json`. A vault syncs with
either ZenNotes Cloud or S3, not both.

## Status

Done: the S3 sync remote and its client (`packages/shared-domain`), the
desktop service (`apps/desktop/src/main/s3-sync/`), keychain storage and the
settings page, with tests for two computers syncing and for both kinds of
conflict. Not done yet: syncing on a timer or on save (it runs on Connect and
Sync now), end-to-end encryption of the bucket, and the iOS shell.
