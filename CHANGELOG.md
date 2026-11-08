## 2.0.1

### Patch Changes

- Lucide icons render at the right size with `@lucide/icons` 1.70+, whose icon data no longer
  always includes a size: a missing size falls back to Lucide's 24-unit grid. Also fixes the
  typecheck against those versions.

## 2.0.0

### Major Changes

- Upgrade to `@quartz-community/types@^1.0.0`.

  This package re-exports types from `@quartz-community/types`, so the dependency is part
  of its public type surface. The move from `0.x` to `1.0.0` is therefore a breaking change
  for consumers and requires a major version bump.
