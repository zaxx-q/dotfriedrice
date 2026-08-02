---
name: librarian
description: >-
  Clone, cache, and search remote git repositories locally. Use this skill when
  the user points you to a remote git repo, asks about code in a remote repo, or
  you encounter a remote git repo through other means.
disable-model-invocation: true
---

Use this skill when the user references a remote git repository (GitHub/GitLab/Bitbucket URLs, `git@...`, or `owner/repo` shorthand) or asks questions that require searching one.

The goal is to keep a reusable local checkout that is:
- **stable** (predictable path)
- **up to date** (periodic fetch + fast-forward when safe)
- **efficient** (partial clone with `--filter=blob:none`, no repeated full clones)

## Cache location

Repositories are stored at:

`~/.cache/checkouts/<host>/<org>/<repo>`

Example:

`github.com/mitsuhiko/minijinja` → `~/.cache/checkouts/github.com/mitsuhiko/minijinja`

## Command

```bash
bash checkout.sh <repo> --path-only
```

Examples:

```bash
bash checkout.sh mitsuhiko/minijinja --path-only
bash checkout.sh github.com/mitsuhiko/minijinja --path-only
bash checkout.sh https://github.com/mitsuhiko/minijinja --path-only
```

The script will:
1. Parse the repo reference into host/org/repo.
2. Clone if missing.
3. Reuse existing checkout if present.
4. Fetch from `origin` when stale (default interval: 300s).
5. Attempt a fast-forward merge if the checkout is clean and has an upstream.

## Update strategy

- Default behavior is **throttled refresh** (every 5 minutes) to avoid unnecessary network calls.
- Force immediate refresh with:

```bash
bash checkout.sh <repo> --force-update --path-only
```

## Workflow

1. **Resolve**: Run `checkout.sh --path-only` to get the local path.
2. **Search**: Search the repo at that path for the needed information.
3. **Present**: Answer with citations, complete code snippets (don't omit imports or other important context), and bulleted/numbered lists for readability.

- If the user provides a link to a repo, always use that.
- If no repo is specified, make your best guess from context.
- On later references to the same repo, call `checkout.sh` again; it will reuse and update the cached checkout.

## Startup behavior

### Invoked with no prompt

List all previously cached repos under `~/.cache/checkouts`, then output:

```md
## Librarian

_Search any git repo — give me a link or owner/repo_

Previously cached:

- repo 1
- ...
```

### Invoked with a user prompt

Answer the prompt using the workflow above.

## If edits are needed

Prefer not to edit directly in the shared cache. Create a separate worktree or copy from the cached checkout for task-specific modifications.

## Notes

- `owner/repo` defaults to `github.com`.
