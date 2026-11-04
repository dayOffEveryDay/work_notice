# Frozen pre-0.4 Worker

`legacy-worker-0002.mjs` is the unchanged local Wrangler dev bundle recovered from
`.wrangler/tmp/dev-3HegLt/index.js`, last modified 2026-11-02T15:33:34.619Z.
SHA-256: `0b5676826fef6238d2e1fe4cb370bf26ed96947acdbf9cb87079313d9bcfdd4d`.

It contains the actual pre-monitoring application code (including authentication,
legacy alert-settings SQL, outbox dispatcher and the native-fetch receiver fix),
plus Wrangler's generated dev middleware. It has no monitoring_settings reference.
It is not a reconstructed policy stub and does not contain deployed secrets.
The source map is not needed by tests and is not included.

This is a **local historical build**, not a byte-for-byte archive or attestation of
Cloudflare version 25a61ebf-935e-4b69-9b71-e7c108d11dc9. Tests require no remote
download. That distinction remains a rollback warning.

The B1 helper copies it to its isolated temporary directory and appends only an
export for the existing dispatchPush function. An in-memory entrypoint calls the
unchanged handle/dispatchPush functions with a test clock. Both old and current
Workers use the same persisted D1 and all outbound fetches are intercepted by
the test's mock OAuth/FCM service. No real FCM token or secret is used.
