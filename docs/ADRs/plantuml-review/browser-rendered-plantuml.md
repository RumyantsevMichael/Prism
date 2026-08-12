# Render PlantUML in a local human review page

Status: Proposed
Created: 2026-08-12

## Requirements

This repository has no requirement file for the approved PlantUML review design.

## Problem Statement

Humans need visual artifact review without making agents read images or committing generated files.
The plugin must start the review capability automatically across supported agent harnesses.

## Goals

- Store every diagram as reviewable `.puml` source.
- Render diagrams locally without Java, Docker, or a remote service.
- Let a human open any current artifact during or outside a harness session.
- Keep rendered images out of agent context and version control.

## Non-Goals

- Replace reasoning-shaped prose with diagrams.
- Add diagrams to requirements, Gherkin files, or the glossary.
- Provide a remote hosted review service.

## Decision

Prism MUST bundle the MIT JavaScript PlantUML core and the C4 library asset.
The MCP server MUST bind to `127.0.0.1` and MUST select an available port.
The review server MUST render `.puml` sources in the human's browser.
MCP tools MUST NOT return rendered image content to an agent.
The server MUST NOT create or commit generated image files.
Every review URL MUST contain a random session token.
Every file request MUST resolve inside the active project root.

## Mechanism

The harness starts `prism-review` through the bundled `.mcp.json` definition.
The MCP server starts the HTTP review server only after the first review request.
The standalone `prism review` command starts the same server without a harness.
The browser loads `.puml` source and renders SVG in memory with PlantUML TeaVM.

## Rationale

The MIT JavaScript build is smaller than the JAR and needs no Java runtime.
The current MIT core is 10.6 MB unpacked before unused assets are removed.
The selected runtime files total about 8.9 MB and support every required diagram type.
A local browser renderer keeps project source off remote services.
A bundled MCP server lets a harness manage the review-server lifecycle.

## Consequences

The plugin now contains a small Node.js runtime and server tests.
The vendored PlantUML files increase the plugin size by about 8.9 MB unpacked.
The browser performs diagram validation and SVG generation.
Headless agent work can continue when a human review page cannot open.

## Decision Log
