# End-to-end tests

`smoke.mjs` drives two real browser sessions against a running stack. It exists to check the
one thing no server-side test can: that a message encrypted in one browser is decryptable in
another, and that it gets there in realtime.

There are two suites:

| Suite | Command | Covers |
| --- | --- | --- |
| `smoke.mjs` | `npm run e2e` | The messaging flow end to end, on a desktop viewport |
| `mobile-keyboard.mjs` | `npm run e2e:mobile` | Layout against a phone's on-screen keyboard |

## Running

```bash
npm run dev            # terminal one
npm run e2e            # terminal two
npm run e2e:mobile
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

## The mobile keyboard suite

`mobile-keyboard.mjs` guards a specific regression. The app shell was once sized with
`height: 100%`, which follows the *layout* viewport — and iOS Safari does not shrink that when
the keyboard opens; it slides the keyboard over the top instead. The composer ended up behind
the keyboard, Safari tried to scroll the focused input into view, the shell's `overflow:
hidden` fought it, and the view snapped back down on every tap.

Headless Chromium has no soft keyboard, so the suite simulates the exact iOS shape: the layout
viewport stays at full height while `visualViewport.height` shrinks. It then asserts the shell
tracked the visual viewport, stopped where the keyboard starts, and dropped its safe-area
inset so no dead strip is left above the keys.

## Notes

Both suites create real accounts with a random suffix. Do not point them at a production
database.

If Chromium is installed somewhere Playwright does not look, set `PLAYWRIGHT_CHROMIUM_PATH`.
