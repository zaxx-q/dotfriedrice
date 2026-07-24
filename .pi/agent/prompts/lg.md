---
name: lg
description: Summarize unstaged git changes with per-file +/- counts
---

Run git status, inspect what has changed, then respond with only:

1. A short 1-2 sentence summary of the unstaged changes.
2. A list of changed unstaged files with their +/- line counts.
3. A total +/- line count at the bottom.

Keep it concise. Use git commands to calculate the line counts; do not include staged changes unless they also have unstaged modifications.
