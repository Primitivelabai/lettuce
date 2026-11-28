# Installing lettuce (for agents like Cline)

lettuce is a **local stdio MCP proxy**. It doesn't add tools of its own. It wraps the MCP servers the person already uses, so reads run, changes wait for their approval in the browser, and tools marked `never` are blocked. No account or API key is needed. It needs Node 22 or later.

## Steps

1. Try it: `npx lettuce-mcp demo` opens the approval page with a pretend pull request.
2. In the MCP settings file (for Cline, `cline_mcp_settings.json`), put `lettuce-mcp wrap --name <name> --` in front of each server's command, keeping the original command after `--`:

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
      ],
      "disabled": false
    }
  }
}
```

3. Run `npx lettuce-mcp init` in the same folder to make a starter `lettuce.yaml`: reads allowed, changes ask, deletes never. Adjust it with the person.
4. Restart the MCP connection and make one harmless change. A browser page should open asking the person to allow it.

## How to behave once connected

- You can't approve your own requests. When a call is waiting, tell the person to check the lettuce page in their browser.
- A denied call means no. Don't retry it under another tool name or look for another way round.
- Don't edit `lettuce.yaml` to loosen a rule unless the person asks.

More detail is in the [README](README.md) and [skills/lettuce/SKILL.md](skills/lettuce/SKILL.md).
