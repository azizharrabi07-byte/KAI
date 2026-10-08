---
name: mcp-integration
description: Wire a repository to MCP servers cleanly — scope, credentials, tool surface, and documentation — so the setup is reproducible for everyone on the project. Use when adding an MCP server to a repo, auditing an existing configuration, or deciding between project and user scope.
---

# MCP Integration Skill

## Purpose
Wire a repository to MCP servers in a reproducible way: correct scope, credentials kept out of the repo, a bounded tool surface, and documentation a teammate can follow.

## When to use
Use this skill when adding an MCP server to a project, auditing an existing configuration, or deciding what belongs in project scope versus a personal setup.

## Inputs
- what the integration must let the agent do, stated as tasks not tools
- the target service and whether an official MCP server exists
- credentials available and how they are currently stored
- who else works in this repo and on what platforms

## Output
Return:
- the server choice with the reason, including why not a plain script or CLI
- the configuration, scoped correctly, with credentials referenced by environment variable
- the permission entries needed so routine calls do not prompt
- a `README` or `CLAUDE.md` section: setup steps, required environment variables, and how to verify it works
- a verification run proving the tools respond

## Constraints
- prefer the official server for a service over a third-party wrapper; check what it actually exposes before committing to it
- **project scope** (`.mcp.json`, committed) for servers everyone on the repo needs; **user scope** for anything personal or credentialed to an individual
- never commit tokens, keys, or connection strings — reference environment variables and document which are required
- prefer read-only credentials unless a write path is the point of the integration
- a large server can add hundreds of tool definitions to every session; enable only what the work needs and say what the token cost is
- verify the server actually connects before declaring the integration done; a configured-but-unreachable server is worse than none
- interactively authenticated servers do not work in headless or scheduled runs — note that where it matters
- document the failure mode: what a teammate sees when the credential is missing, and how to fix it
- do not add a server for something a single shell command already does well

## Examples
- Add a database MCP server to a repo with read-only credentials and setup docs
- Audit an existing configuration for committed secrets and unnecessary tool surface
- Decide whether an integration belongs in project scope or a personal config
