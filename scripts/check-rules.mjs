#!/usr/bin/env node
/**
 * Validate database.rules.json before `firebase deploy` sends it anywhere.
 *
 * The rules file is uploaded verbatim and parsed on Firebase's side, so a
 * malformed file is only discovered after a round trip — and the parser's
 * errors are terse line/column pairs with no path context.
 *
 * The mistake that motivated this: documenting a node with a `"//"` key.
 *
 *   "uid": {
 *     "//": "Denormalised copy of the key.",
 *     ".validate": "..."
 *   }
 *
 * In the rules language any key that does not begin with `.` is a *child node
 * name*, and a child must map to an object. So `"//"` declares a child called
 * `//` whose value is a string, and the parser reports
 *
 *   Syntax error in database rules: 13:17: Expected '{'.
 *
 * Comments are legal, but only as real `//` line comments, never as keys.
 * This script catches that whole class of error — any child mapping to a
 * non-object, and any unrecognised `.keyword` — and reports the rule path
 * instead of a column number.
 *
 * WHAT THIS DOES NOT CATCH, and why there is a second check. Everything above is
 * *structural*. It never looks inside a `.read`/`.write`/`.validate` string, so
 * an expression that is perfectly placed but unparseable sails through — which
 * is exactly what BUG-33 was: a `\s` the rules regex engine does not implement,
 * in a file this script called "OK", rejected wholesale by the server. Since the
 * only faithful parser for that language is Firebase's own, `--expressions`
 * hands the file to the emulator and reports what it says. That needs Java and
 * the emulator jar, so it is opt-in rather than part of the default run: see
 * `npm run check:rules:full`.
 *
 * Run via `npm run check:rules`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = join(root, 'database.rules.json');

/**
 * Remove `//` line comments without touching ones inside string values.
 *
 * A regex would corrupt the rules themselves — `.validate` expressions contain
 * `matches(/^[a-z0-9_.]{3,24}$/)` and similar — so this tracks string state.
 */
function stripLineComments(src) {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];

    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }

    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }

    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      out += '\n'; // keep line numbers aligned with the source file
      continue;
    }

    out += c;
  }

  return out;
}

/** Rule keywords whose value is an expression or a literal boolean. */
const EXPRESSION_RULES = new Set(['.read', '.write', '.validate']);
/** Rule keywords whose value indexes children. */
const INDEX_RULES = new Set(['.indexOn']);
/** Recognised but unconstrained here. */
const OTHER_RULES = new Set(['.priority']);

const errors = [];

function walk(node, path) {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) {
    errors.push(`${path}: expected an object`);
    return;
  }

  for (const [key, value] of Object.entries(node)) {
    const here = `${path}/${key}`;

    if (EXPRESSION_RULES.has(key)) {
      if (typeof value !== 'string' && typeof value !== 'boolean') {
        errors.push(`${here}: must be an expression string or a boolean, got ${typeof value}`);
      }
    } else if (INDEX_RULES.has(key)) {
      if (!Array.isArray(value) && typeof value !== 'string') {
        errors.push(`${here}: must be an array of child names (or a single name)`);
      }
    } else if (OTHER_RULES.has(key)) {
      // Recognised; nothing worth asserting.
    } else if (key.startsWith('.')) {
      errors.push(`${here}: unknown rule keyword`);
    } else {
      // A child node name. This is the case that bites: the parser demands an
      // object here and says "Expected '{'" if it gets anything else.
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        const got = Array.isArray(value) ? 'array' : typeof value;
        const hint = key === '//' ? " — use a real `// ...` line comment, not a \"//\" key" : '';
        errors.push(`${here}: a child node must map to an object, got ${got}${hint}`);
      } else {
        walk(value, here);
      }
    }
  }
}

let parsed;
try {
  parsed = JSON.parse(stripLineComments(readFileSync(file, 'utf8')));
} catch (e) {
  console.error(`\ndatabase.rules.json is not valid JSON (after stripping comments):\n  ${e.message}\n`);
  process.exit(1);
}

if (!parsed.rules || typeof parsed.rules !== 'object') {
  console.error('\ndatabase.rules.json must have a top-level "rules" object.\n');
  process.exit(1);
}

walk(parsed.rules, 'rules');

if (errors.length > 0) {
  console.error('\ndatabase.rules.json will be rejected by the rules parser:\n');
  for (const e of errors) console.error(`  ${e}`);
  console.error('');
  process.exit(1);
}

console.log(`database.rules.json OK — ${Object.keys(parsed.rules).length} top-level nodes, structure valid.`);

if (!process.argv.includes('--expressions')) {
  process.exit(0);
}

/*
 * Expression check. Everything above validated shape; this validates meaning, by
 * asking the only parser whose opinion counts.
 *
 * The emulator loads the rules exactly as the deploy endpoint does and refuses
 * to start on a bad file, so its exit status *is* the answer — no need to
 * interpret its output beyond echoing the diagnostic. Reusing the emulator here
 * rather than reimplementing the expression language is the whole point: a
 * hand-rolled checker would have its own idea of what `matches()` supports, and
 * being subtly wrong about that is the bug this is meant to prevent.
 */

const { spawnSync } = await import('node:child_process');
const { existsSync } = await import('node:fs');

const rulesTestDir = join(root, 'tests', 'rules');
const firebaseBin = join(rulesTestDir, 'node_modules', '.bin', 'firebase');

if (!existsSync(firebaseBin)) {
  console.error(
    '\n--expressions needs the emulator, which lives in the rules-test package.\n' +
      '  npm --prefix tests/rules install\n'
  );
  process.exit(1);
}

// A bundled JRE, if someone put one here because the machine has no system Java
// and no passwordless sudo to install one. Prepending is safe when absent.
const localJre = join(root, '.jre', 'bin');

const result = spawnSync(
  firebaseBin,
  [
    'emulators:exec',
    '--only',
    'database',
    '--project',
    'flyer-rules-check',
    '--config',
    join(root, 'firebase.json'),
    // The emulator has already parsed the rules by the time any script runs, so
    // the script itself has nothing to do.
    'true',
  ],
  {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${localJre}:${process.env.PATH}` },
  }
);

if (result.error?.code === 'ENOENT') {
  console.error(`\nCould not run ${firebaseBin}.\n`);
  process.exit(1);
}

const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

if (result.status !== 0) {
  if (/Could not spawn `java/.test(output)) {
    console.error(
      '\nThe database emulator needs a Java runtime, which this machine does not have:\n' +
        '  sudo apt-get install -y default-jre-headless\n' +
        'The structural check above still passed; only the expression check was skipped.\n'
    );
    process.exit(1);
  }
  // Rules failures arrive as warning lines rather than a stack, so surface those
  // specifically and fall back to the whole output if the shape ever changes.
  const diagnostics = output
    .split('\n')
    .filter((l) => /rules|Illegal|Syntax|error/i.test(l) && !/^\s*i\s/.test(l))
    .join('\n');
  console.error('\ndatabase.rules.json does not compile:\n');
  console.error(diagnostics.trim() || output.trim());
  console.error('');
  process.exit(1);
}

console.log('database.rules.json OK — expressions compile against the emulator.');
