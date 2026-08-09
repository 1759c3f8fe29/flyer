# Security-rules tests

Runs `database.rules.json` against the Firebase emulator and asserts what it
permits and what it refuses. These are the tests H-03 asks for first, and each
case below maps to a bug that actually shipped.

## Why this is a separate npm package

The app's `package-lock.json` cannot be regenerated on this machine. `eas.json`
pins the builder to node 20.18.0 / npm 10.8.2, and npm 11 prunes nested
`@react-native-async-storage/async-storage` entries that npm 10 requires — the
regression `npm run check:lock` exists to catch, and which has broken two builds
already. Adding a devDependency to the root `package.json` means running
`npm install` there, which rewrites the lock as a side effect.

So the harness owns its own `package.json` and its own lock. Installing here
cannot touch the app's. Run `npm run check:lock` from the repo root afterwards
if you want to prove it.

## Why `node --test` rather than jest

H-03 suggests jest. Nothing here needs it: these tests import the firebase SDK
and talk to a socket, with no JSX, no React Native module resolution and no
transform step. Node 20+ ships a test runner that covers it, and the repo has no
jest config to inherit — adding one would mean `jest`, `babel-jest`, a preset,
and a transform allowlist for a suite that needs none of them. Unit tests for
the `StateManager` reducers (H-03's second deliverable) are a different call:
those run in-process against TypeScript and may well want a real runner.

## Running

    npm install        # first time only, in this directory
    npm test           # boots the database emulator, runs, tears it down

`emulators:exec` starts the emulator, runs the command, and stops it — so a
failing test never leaves a process on port 9000. The port comes from
`firebase.json` at the repo root, which is also where the rules file is read
from, so there is no second copy of either to drift.
