# Security

lettuce decides whether an AI agent's tool calls run, so we treat any way past a check as a real bug: an agent approving its own call, a `never` tool running, a lease outliving its time or call limit, receipts that verify after an edit, or a token showing up somewhere it shouldn't.

**Report it privately** with GitHub's [private vulnerability reporting](https://github.com/Primitivelabai/lettuce/security/advisories/new). Include your OS, Node version, your `lettuce.yaml` and the steps.

We'll reply within a week.

Out of scope: an agent that can already run any command as you, without a sandbox. See "What it protects against" in the README.
