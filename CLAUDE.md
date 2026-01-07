# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

VS Code extension for viewing and managing Claude Code artifacts (Task Lists, Implementation Plans, and Walkthroughs). It communicates with the Claude Code CLI via file-based IPC.

## Commands

```bash
# Install dependencies
npm install

# Development build with watch mode
npm run watch

# Production build
npm run compile

# Lint TypeScript source files
npm run lint

# Create VSIX package for distribution
npx vsce package
```

## Architecture

### Entry Point
- `src/extension.ts` - Extension activation, command registration, and initialization of all managers

### Core Components

**Artifact Layer** (`src/artifact/`)
- `ArtifactManager.ts` - CRUD operations for artifacts, persists to VS Code workspace storage
- `ArtifactProvider.ts` - Webview panel rendering, handles all webview message routing
- `ArtifactTreeProvider.ts` - TreeView sidebar provider
- `types.ts` - All TypeScript type definitions for artifacts, messages, and IPC

**Communication Layer** (`src/communication/`)
- `IPCClient.ts` - File-based IPC with Claude Code CLI using `~/.claude-artifacts/{projectId}/inbox|outbox|processed` directories
- `MessageHandler.ts` - Routes incoming IPC messages to appropriate handlers

**Agent Mode** (`src/agent/`)
- `AgentModeManager.ts` - Planning vs Fast mode switching, task groups, review policies

**Type-Specific Providers** (`src/providers/`)
- `TaskListProvider.ts` - Task list operations (add, delete, update status, progress calculation)
- `ImplPlanProvider.ts` - Implementation plan sections and file changes
- `WalkthroughProvider.ts` - Walkthrough sections, key points, and changed files

**Comments System** (`src/comments/`)
- `CommentController.ts` - Comment CRUD, threading by section/line number
- `CommentThread.ts` - Comment thread utilities and styles

### IPC Protocol

The extension uses file-based IPC with a workspace-specific project ID (hash of workspace path):
- **Inbox**: CLI writes messages here, extension polls and processes
- **Outbox**: Extension writes responses here
- **Processed**: Processed messages are moved here

Hook bridge script (`~/.claude-artifacts/hooks/artifact-bridge.js`) transforms Claude Code tool outputs into IPC messages.

### Artifact Types

1. **TaskList** - Items with status (pending/in-progress/completed) and category (research/implementation/verification/other)
2. **ImplementationPlan** - Sections containing file changes with types (create/modify/delete)
3. **Walkthrough** - Key points, content sections, and changed files with line stats

### Build Configuration

- Webpack bundles to `dist/extension.js` (target: node, commonjs2)
- TypeScript strict mode with ES2022 target
- VS Code extension activates on `onStartupFinished`
