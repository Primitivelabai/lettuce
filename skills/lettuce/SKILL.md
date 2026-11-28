---
name: lettuce
description: Put lettuce in front of the person's MCP servers so reads run, changes wait for their yes, and some tools never run. Use when the person asks to add approvals or guardrails to their agent, says "let us check first", wants to stop an agent changing things without asking, asks to set up or tune lettuce.yaml, or wants to see what their agent did (receipts).
---

# Setting up lettuce

lettuce sits between an agent and its MCP servers. Reading runs. Changes pause and open a small page in the person's browser, where they allow once, allow for a while, or deny. Tools marked `never` are hidden and blocked. Every decision is written to a hash-chained receipt file.

You are setting up the gate that will check you. Be straight about that: never loosen a rule the person didn't ask to loosen, never approve your own requests, and never edit receipts.

## 1. Look first (read-only)

1. Find the MCP config: `.mcp.json` in the project, `claude_desktop_config.json`, or Cursor's MCP settings.
2. List each server and what it can change (GitHub can push and merge, Postgres can write and drop, a filesystem server can delete).
3. Note tokens written in plain text under `env`.

Tell the person what you found in two or three lines before changing anything.

## 2. Try it (optional)

`npx lettuce-mcp demo` opens the approval page with a pretend pull request, so the person sees what they're agreeing to.

## 3. Wrap each server

Put `lettuce-mcp wrap --name <name> --` in front of the server's command. Keep the original command and args after the `--`:

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": [
        "-y",
        "lettuce-mcp",
        "wrap",
        "--name",
        "github",
        "--",
        "npx",
        "-y",
        "@modelcontextprotocol/server-github"
      ]
    }
  }
}
```

## 4. Write lettuce.yaml

Run `npx lettuce-mcp init` next to the config, then fit the rules to the servers you found:

- `allow` for reads: `get_*`, `list_*`, `read_*`, `search_*`.
- `ask` for changes, with `lease_options: ['once', '15m', '1h']` and a `max_calls_per_lease`.
- `never` for anything that can't be undone: deleting repos, dropping tables, merging to main, force pushes.
- Keep `default_action: ask`. Only change it if the person says so, and say what it means.

`never` beats `ask`, and `ask` beats `allow`. A rule with `constraints` only matches calls whose arguments fit (for example `owner: { equals: 'their-org' }`).

Show the person the rules in plain words ("reads run, pull requests ask, deleting a repo never happens") and let them adjust.

## 5. Move tokens out of plain text

For each token in `env`, have the person run `npx lettuce-mcp secret set <name>` themselves and paste the value into that prompt, not into chat. Then reference it in `lettuce.yaml`:

```yaml
secrets:
  GITHUB_PERSONAL_ACCESS_TOKEN: 'keychain://lettuce/github-token'
```

and remove the plain-text value from the MCP config.

## 6. Check it

Restart the agent's MCP connection, then make one harmless change request. The approval page should open. Afterwards:

- `npx lettuce-mcp receipts --tail` shows decisions as they happen.
- `npx lettuce-mcp verify` checks the receipts haven't been edited and prints the latest hash. Suggest the person saves it somewhere else.
- `npx lettuce-mcp revoke` ends every active approval at once.

## What lettuce can't do

lettuce gates MCP tools. An agent with an unsandboxed shell running as the person can get around any local tool. If the agent has one, say so and suggest a sandbox for it.
