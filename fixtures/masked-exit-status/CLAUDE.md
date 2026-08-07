# Pre-commit checks

## Verify types (POSITIVE CASE)

```bash
npx tsc --noEmit | head -20 && echo "tsc clean"
```

## Verify lint (POSITIVE CASE)

```bash
npx eslint . | tail -n 5 && echo "lint OK"
```

## Verify tests (NEGATIVE CONTROL -- no filter in the pipeline)

```bash
npm test && echo "tests pass"
```

## Verify build (NEGATIVE CONTROL -- pipefail restores the real status)

```bash
set -o pipefail
npx tsc --noEmit | head -20 && echo "tsc clean"
```

## Read-only inspection (NEGATIVE CONTROL -- no success claim)

```bash
npm test | tail -50
```

<!--
  A pipeline's exit status is the LAST command's, so `tsc | head` reports
  head's success and the `&& echo "tsc clean"` fires over a real type error.
  Observed live: a type error printed "tsc clean" and the run continued.

  Expected: commands/exit-status-masked on the first two blocks only.

  The three negative controls encode the false-positive boundary:
    - no filter in the pipeline    -> && is a genuine gate, not a mask
    - `set -o pipefail` in scope   -> the status is no longer masked
    - no success-claiming echo     -> piping to a pager for reading is fine
-->
