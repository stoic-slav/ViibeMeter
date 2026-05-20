# git-sync

Update all project documentation to reflect the current state of the codebase, then commit and push.

## Steps

### 1. Check what changed since the last commit

Run `git diff HEAD` and `git log -1 --format="%H %s"` to understand what has changed since the last commit. This diff is the source of truth for the commit message you will write at the end.

### 2. Check for documentation

Look for `README.md` and `CLAUDE.md` in the project root.

- If **neither exists**, create both from scratch based on the current codebase:
  - `README.md` — project overview, signals collected, scoring system, architecture, build instructions, privacy
  - `CLAUDE.md` — project overview for Claude Code: commands, architecture, data flow, singleton services, scoring system with exact formula weights, storage schema, build quirks, privacy constraints
- If **only one exists**, create the missing one.
- If **both exist**, proceed to step 3.

### 3. Audit existing docs against the code

Read the source files to understand the current state of the project: entry points, core modules, data flow, configuration, and schema. Compare against the existing docs and update only what is stale or missing. Do not rewrite sections that are still accurate — surgical edits only. Do not add speculative or planned content; document only what the code currently does.

### 4. Git commit

Stage all modified or created documentation files plus any other unstaged changes in the working tree.

Write a commit message that:
- Summarises the key features and changes visible in the `git diff` from step 1
- Notes any documentation that was created or updated
- Is concise (title line + bullet points if needed)
- Ends with: `Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>`

Use a HEREDOC to pass the message:
```
git commit -m "$(cat <<'EOF'
<message here>

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

### 5. Git push

Always push after committing, even if only docs changed.

```
git push
```

## Rules

- Do not skip the commit or push for any reason — this skill always ends with a push.
- If the working tree is already clean (nothing to commit), say so clearly and do not push.
- Do not use `--no-verify` or any flag that bypasses hooks.
