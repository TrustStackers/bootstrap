# Contributing

Thank you for your interest in contributing!

## Before you start: sign the CLA

All contributions are accepted only under the [Contributor License
Agreement](./CLA.md). This is what allows the project to remain **dual-licensed**
(copyleft plus a commercial license): the CLA grants Trust Stackers the right to
relicense contributions. Opening a pull request constitutes your acceptance.

The requirement is enforced on every pull request (currently by maintainer
review; an automated check will be added).

## Dependency policy (hard rule)

The project is dual-licensed, and the commercial license can only cover code
that Trust Stackers is entitled to relicense. Therefore:

- **All runtime dependencies MUST be permissively licensed** — MIT, Apache-2.0,
  BSD, or ISC.
- **No copyleft dependencies** (GPL, AGPL, LGPL, SSPL, EUPL) may be added to
  `dependencies`. If a feature needs one, raise an issue first: it would make the
  commercial branch unlicensable for the whole repository.
- `devDependencies` are not redistributed and are held to a looser standard, but
  ask first if you are unsure.
- CI runs a dependency-license check and will fail on a new copyleft runtime
  dependency.

## Local development

```bash
npm ci                 # reproducible install from the committed lockfile
npm run typecheck      # if defined
npm test               # if defined
```

See `package.json` for the exact scripts in this repository.

## Workflow

1. Open an issue describing the change (bug, feature, documentation).
2. Fork the repository and create a branch.
3. Make a focused change; add or update tests.
4. Run the repository's gates (typecheck and tests) before opening the PR.
5. Open the pull request and describe the motivation.

## Code style

- TypeScript strict mode is on; keep `tsc --noEmit` clean.
- Match existing naming and module structure.
- Prefer small, typed, exported functions; avoid new global state.

## License of contributions

By contributing, you agree that your contribution is licensed under the same
dual-license terms as the rest of the project (see [LICENSE](./LICENSE),
[COMMERCIAL-LICENSE.md](./COMMERCIAL-LICENSE.md) and [CLA.md](./CLA.md)).

If you contribute to a directory carrying its own license (for example
`examples/` in the agent app, which is Apache-2.0), your contribution there is
accepted under that license as well; the CLA still applies so the project can
relicense.
