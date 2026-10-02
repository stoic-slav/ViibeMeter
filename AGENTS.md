# AGENTS.md

Instructions for any AI coding agent working in this repository. Read this file first.

## Read these before starting
1. **`docs/HANDOFF.md`**: current state, decisions, and the ordered "Do next" list. Start here to continue work in progress. If it conflicts with anything older, trust it, and update it when you finish a task.
2. **`CLAUDE.md`**: architecture, commands, singleton services, scoring system, iOS build quirks and privacy constraints. It applies to every agent, not just Claude.
3. **`README.md`**: product background, signal table, data-collection strategy and success criteria.

## How the owner works
They want the agent to drive the work end to end and give only minimal direction and oversight. Do the work, verify it, and report outcomes faithfully, including failures. Ask only when a decision is genuinely theirs: spending money, deleting data, anything outward-facing.

## Rules that are easy to break
- **Privacy:** never store raw audio, BLE device identifiers or GPS coordinates. Only aggregated per-window metrics leave the phone.
- **Do not run `npx expo prebuild --clean`.** It wipes the local iOS build patches (Podfile, `fmt/base.h`, entitlements). See "iOS Build Quirks" in `CLAUDE.md`.
- **Beat sync, movement energy and crowd sync are collect-only.** Do not add them to the composite vibe score until the analysis validates them.
- **Singleton services:** do not re-instantiate them (see `CLAUDE.md`).
- **Only commit to the branch you were assigned.** Do not open a pull request unless asked.
- **Never commit secrets.** The `.env` file with Supabase and AudD keys stays local.

## Checks
- Type-check from `vibemeter-app/`: `npx tsc --noEmit`. There are no test or lint scripts, so this is the main correctness check.
- Analysis scripts, from `analysis/`: `python3 crowd_sync.py --selftest`. Install deps with `pip install -r requirements.txt` (use a virtualenv).

## Keeping the handoff current
When you finish a meaningful chunk of work, or stop mid-task, update `docs/HANDOFF.md`: what changed, what was verified, what is still untested, and the next steps in order. A later agent should be able to continue from the repo alone, without your chat history.
