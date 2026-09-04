# End-to-end tests

`smoke.mjs` drives two real browser sessions against a running stack. It exists to check the
one thing no server-side test can: that a message encrypted in one browser is decryptable in
another, and that it gets there in realtime.

## Running

```bash
npm run dev        # terminal one
npm run e2e        # terminal two
```

Against a deployed environment:

```bash
E2E_BASE_URL=https://app.veylo.chat npm run e2e
```

Watch it happen:

```bash
E2E_HEADED=true npm run e2e
```

## What it covers

| Step | Assertion |
| --- | --- |
| Landing | The marketing page renders |
| Accounts | Two accounts are created with no phone number |
| Requests | An unaccepted sender does not appear in the recipient's inbox; accepting activates the thread |
| Encryption | Browser B decrypts a message browser A encrypted |
| Realtime | The reply arrives without a reload |
| Actions | Reactions propagate; an edit is re-encrypted and re-decrypted |
| Attachments | A file is encrypted, uploaded and its filename recovered by the recipient |
| Groups | A second group member decrypts a group message |
| Privacy | Turning off discovery removes an account from search |
| Session | A reload keeps messages readable without re-entering the passphrase |

## Notes

It creates real accounts with a random suffix. Do not point it at a production database.

If Chromium is installed somewhere Playwright does not look, set `PLAYWRIGHT_CHROMIUM_PATH`.
