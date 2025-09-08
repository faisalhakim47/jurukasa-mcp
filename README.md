# Jurukasa MCP Server

A small, self-contained Model Context Protocol (MCP) server implementation for Jurukasa accounting operations.

This repository provides an MCP server that exposes accounting-related tools and resources, including account management, tagging, journal entry workflows, reporting, and SQL execution. It includes lightweight repository adapters for SQLite (local or in-memory) and LibSQL backends.

## Features

- **MCP Server Tools**:
  - Account management (ensure, rename, set control, hierarchical chart, list)
  - Account tagging (set/unset multiple tags)
  - Journal entry lifecycle (draft, update, post, delete drafts, reverse)
  - Reporting (trial balance, balance sheet, generate reports)
  - SQL execution tool for ad-hoc queries
  - Configuration get/set
- **Storage Adapters**:
  - `SqliteAccountingRepository` — Supports local file or in-memory SQLite with bundled schema
  - `LibsqlAccountingRepository` — For hosted LibSQL backends
- **Additional Features**:
  - Typed TypeScript codebase
  - Small CLI wrapper for running the MCP server via stdio transport

## Prerequisites

- Node.js (with ESM support)
- npm (for installing dependencies)

## Installation

Clone the repository and install dependencies:

```bash
npm install
```

## Build

The build process compiles TypeScript to the `dist/` directory and copies SQL schema files into `dist/app/data/` so the compiled code can read them using the same relative paths as the source.

Run the build:

```bash
npm run build
```

After building, the runnable CLI is available at `dist/cli.js` (referenced in `package.json` as the `bin` entry). The project `package.json` defines the `build` and `test` scripts; run `npm run build` to produce `dist/` and `npm test` to run the test suite using Node's built-in test runner.

## Usage

The CLI starts the MCP server using stdio for MCP transport. It accepts an optional database URL as an argument or reads `DATABASE_URL` and `DATABASE_AUTH_TOKEN` from environment variables.

### Examples

- **In-memory SQLite** (default if no DB URL is provided):

  ```bash
  node dist/cli.js
  # Or, for development (before building):
  npx tsx ./app/cli.ts
  ```

- **SQLite file**:

  ```bash
  node dist/cli.js "sqlite:/absolute/path/to/jurukasa.db"
  ```

- **LibSQL backend**:

  ```bash
  export DATABASE_AUTH_TOKEN="<your-token>"
  node dist/cli.js "libsql:https://your-libsql-endpoint"
  ```

If no `DATABASE_URL` is provided, the server logs a warning and defaults to an in-memory SQLite instance.

## Database Options and Schema

- **In-memory SQLite**: Pass no DB URL or use `:memory:`. Ideal for tests and small ad-hoc runs.
- **File-backed SQLite**: Pass `sqlite:/path/to/file` as the first CLI argument.
- **LibSQL**: Pass a `libsql:` URL and set `DATABASE_AUTH_TOKEN` if authentication is required.

The SQL schema files are located in `app/data/*.sql` and are applied by the `SqliteAccountingRepository` and exposed as an MCP resource by `app/mcp-server/resources/sqlite-accounting-schema.ts`. The build process copies these files into `dist/app/data/` so the compiled code can read them at runtime.

## Testing

Run the tests using Node's built-in test runner:

```bash
npm test
```

Unit tests are located near the tools and data directories.

## Development

- The project uses TypeScript and compiles to `dist/`. The build script runs `tsc-alias` to handle path aliases.
- Use `tsx` (available as a dev dependency) to run TypeScript files directly during development: `npx tsx ./app/cli.ts`.
- When modifying SQL schema files, rebuild the project (`npm run build`) or manually copy updated schemas to `dist/data/` to keep the packaged schema in sync.

**Developer Note**: A `.profile` file is included in the repository to set helpful environment variables (e.g., `IMPORT_MAP_PATH` and `NODE_OPTIONS`). Source it in your shell for convenience:

```bash
source .profile
```

This is optional but simplifies running the TypeScript CLI with `tsx` and the import map.

## License

This project is licensed under the `FSL-1.1-MIT` license. See the `LICENSE` file for details.
