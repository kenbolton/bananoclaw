---
name: claw
description: Install the claw CLI tool — run NanoClaw agent containers from the command line without opening a chat app.
---

# claw — NanoClaw CLI

`claw` is a Python CLI that sends prompts directly to a NanoClaw agent container from the terminal. It reads registered groups from the NanoClaw database, picks up secrets from `.env`, and pipes a JSON payload into a container run — no chat app required.

## What it does

- Send a prompt to any registered group by name, folder, or JID
- Default target is the main group (no `-g` needed for most use)
- Resume a previous session with `-s <session-id>`
- Read prompts from stdin (`--pipe`) for scripting and piping
- List all registered groups with `--list-groups`
- Auto-detects `container` or `docker` runtime (or override with `--runtime`)
- Prints the agent's response to stdout; session ID to stderr
- Verbose mode (`-v`) shows the command, redacted payload, and exit code
- `claw -f tasks.txt` — read prompt from a file (alternative to `--pipe`)
- `claw ps` — list, inspect, manage, and restart running NanoClaw containers
- `claw sessions` — list groups with a saved session ID (for use with `-s`)
- `claw history` — print recent messages for a group from the local database
- `claw watch` — tail a group's conversation in real time from the DB
- `claw groups` — list, add, and remove registered groups from the CLI
- `claw rebuild` — build (or rebuild) the `nanoclaw-agent` container image
- `claw molt` — export/import NanoClaw installs via the [molt](https://github.com/kenbolton/molt) migration tool (optional dependency)

## Prerequisites

- Python 3.8 or later
- NanoClaw installed with a built and tagged container image (`nanoclaw-agent:latest`)
- Either `container` (Apple Container, macOS 15+) or `docker` available in `PATH`

## Install

Run this skill from within the NanoClaw directory. The script auto-detects its location, so the symlink always points to the right place.

### 1. Copy the script

```bash
mkdir -p scripts
cp "${CLAUDE_SKILL_DIR}/scripts/claw" scripts/claw
chmod +x scripts/claw
```

### 2. Symlink into PATH

```bash
mkdir -p ~/bin
ln -sf "$(pwd)/scripts/claw" ~/bin/claw
```

Make sure `~/bin` is in `PATH`. Add this to `~/.zshrc` or `~/.bashrc` if needed:

```bash
export PATH="$HOME/bin:$PATH"
```

Then reload the shell:

```bash
source ~/.zshrc   # or ~/.bashrc
```

### 3. Verify

```bash
claw --list-groups
```

You should see registered groups. If NanoClaw isn't running or the database doesn't exist yet, the list will be empty — that's fine.

## Usage Examples

```bash
# Send a prompt to the main group
claw "What's on my calendar today?"

# Send to a specific group by name (fuzzy match)
claw -g "family" "Remind everyone about dinner at 7"

# Send to a group by exact JID
claw -j "120363336345536173@g.us" "Hello"

# Resume a previous session
claw -s abc123 "Continue where we left off"

# Read prompt from stdin
echo "Summarize this" | claw --pipe -g dev

# Pipe a file
cat report.txt | claw --pipe "Summarize this report"

# List all registered groups
claw --list-groups

# Force a specific runtime
claw --runtime docker "Hello"

# Use a custom image tag (e.g. after rebuilding with a new tag)
claw --image nanoclaw-agent:dev "Hello"

# Verbose mode (debug info, secrets redacted)
claw -v "Hello"

# Custom timeout for long-running tasks
claw --timeout 600 "Run the full analysis"

# Read prompt from a file
claw -f tasks.txt

# Prefix the file contents with an inline instruction
claw "Summarize this:" -f report.txt
```

### Container management (claw ps)

```bash
# List all running NanoClaw containers
claw ps

# Filter by name substring
claw ps main

# Also show unnamed/zombie containers
claw ps --all

# Dump logs for all named containers
claw ps --logs

# Dump logs for containers matching "main"
claw ps --logs main

# Follow logs (multiplexed, Ctrl-C to stop)
claw ps --tail

# Remove stale unnamed containers
claw ps --kill-zombies

# Stop and remove a specific stuck container (NanoClaw may re-process the pending message)
claw ps --restart main
```

### Session management (claw sessions)

```bash
# List all groups with a saved session ID
claw sessions

# Filter by group name or folder substring
claw sessions main
```

Use the session ID with `-s` to resume a previous conversation:

```bash
claw -s <session-id> "Continue where we left off"
```

### Message history (claw history)

```bash
# Last 20 messages for the main group
claw history

# Last 20 messages for a specific group (fuzzy match)
claw history -g family

# Show more messages
claw history -n 50

# By exact JID
claw history -j "120363336345536173@g.us"
```

### Live message tail (claw watch)

```bash
# Watch the main group in real time (Ctrl-C to stop)
claw watch

# Watch a specific group
claw watch -g family

# Faster poll interval (default is 2s)
claw watch -n 1
```

### Group management (claw groups)

```bash
# List registered groups
claw groups

# Register a new group
claw groups add "120363336345536173@g.us" --name "My Group"

# Register with a custom folder and agent name
claw groups add "120363336345536173@g.us" --name "My Group" --folder my-group --agent-name "Andy"

# Mark as the main group
claw groups add "120363336345536173@g.us" --name "My Group" --main

# Remove a group (prompts for confirmation; group folder on disk is preserved)
claw groups remove "My Group"
```

### Rebuilding the container image (claw rebuild)

```bash
# Rebuild with the default tag (nanoclaw-agent:latest)
claw rebuild

# Build with a custom tag
claw rebuild --tag dev

# Prune builder cache first, then rebuild (use when COPY steps serve stale files)
claw rebuild --clean
```

### Migration (claw molt)

Requires [molt](https://github.com/kenbolton/molt) installed and available in `PATH`.

```bash
# Export this NanoClaw install to a bundle (source defaults to NANOCLAW_DIR)
claw molt export --out ~/my-nanoclaw.molt

# Import a bundle into this install (dest and --arch default to this install)
claw molt import ~/my-nanoclaw.molt

# Import with folder renames
claw molt import ~/my-nanoclaw.molt --rename family=household

# Dry run
claw molt import ~/my-nanoclaw.molt --dry-run

# List available molt drivers
claw molt archs

# Pass any other molt command through directly
claw molt --help
```

## Troubleshooting

### "neither 'container' nor 'docker' found"

Install Docker Desktop or Apple Container (macOS 15+), or pass `--runtime` explicitly.

### "no secrets found in .env"

The script auto-detects your NanoClaw directory and reads `.env` from it. Check that the file exists and contains at least one of: `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`.

### Container times out

The default timeout is 300 seconds. For longer tasks, pass `--timeout 600` (or higher). If the container consistently hangs, check that your `nanoclaw-agent:latest` image is up to date by running `./container/build.sh`.

### "group not found"

Run `claw --list-groups` to see what's registered. Group lookup does a fuzzy partial match on name and folder — if your query matches multiple groups, you'll get an error listing the ambiguous matches.

### Container crashes mid-stream

Containers run with `--rm` so they are automatically removed. If the agent crashes before emitting the output sentinel, `claw` falls back to printing raw stdout. Use `-v` to see what the container produced. Rebuild the image with `./container/build.sh` if crashes are consistent.

### Override the NanoClaw directory

If `claw` can't find your database or `.env`, set the `NANOCLAW_DIR` environment variable:

```bash
export NANOCLAW_DIR=/path/to/your/nanoclaw
```
