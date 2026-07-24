- When referencing files in your responses, always use relative paths from the current working directory.
- Prefer calling as many tools as are reasonably needed in a single response (e.g., reading multiple files, or combining file reads with searches) to reduce back-and-forth and complete tasks faster.
- Only use the read tool IF the file is NOT already in context.
- If a file's contents are already present in the context or conversation history (e.g., via `[content for ...]` blocks, file attachments, or pasted content), completely trust the provided content and do NOT use the `read` or other exploratory tool to fetch that file again.
- When using `ffgrep`, escape regex metacharacters (e.g., `\(\)`, `\[\]`, `\^`) for literal symbol searches; `ffgrep` executes valid regex patterns first and only falls back to literal matching on regex parse errors.

