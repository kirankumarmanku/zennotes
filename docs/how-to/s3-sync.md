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

## Status

The remote and its S3 client are in `packages/shared-domain` with tests
(`s3-sync-remote.test.ts`), including two devices syncing through the real
`CloudSyncCoordinator`. Not done yet: the desktop settings screen, keychain
storage for the access key, end-to-end encryption of the bucket, and the iOS
shell.
