#!/usr/bin/env node
// Launcher for the GridPulse MCP server: runs src/mcp.ts via tsx (no build step).
import { register } from "tsx/esm/api";
register();
await import("../src/mcp.ts");
