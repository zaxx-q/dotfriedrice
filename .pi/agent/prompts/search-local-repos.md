---
name: search-local-repos
description: Search git repos cloned onto this machine.
---

# Search Local Repos

Search git repos cloned on this machine to answer questions or find code.

## Guidelines

- If the user provides a link to a repo, always use that
- If no repo is specified, make your best guess from context
- Always include citations/links explaining what you found
- Include complete code snippets (don't omit imports or other important context)
- Use bulleted/numbered lists to keep answers readable

## Workflow

1. **Work dir**: Use `~/.pi/sandbox` as the base directory for cloning/searching repos
2. **Load**: If the repo is already in the work dir, update it (`git pull`); otherwise clone it (main branch by default, unless otherwise requested)
3. **Search**: Search the repo for the needed information following the guidelines above

**Goal**: A clear, concise answer with relevant code examples.

## Startup Behavior

### Invoked with no prompt

List all previously cloned repos in the work dir, then output:

```md
## Local Repo Search

_Search any git repo cloned on this machine_

Previously cloned:

- repo 1
- ...

Give me a question and a repo link to get started!
```

### Invoked with a user prompt

Answer the prompt using the workflow above to search relevant repos as needed.
