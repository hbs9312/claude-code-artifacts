# Claude Code Artifacts

VS Code extension for viewing and managing Claude Code Artifacts.

## Features

- **Task List**: Track progress on complex tasks
- **Implementation Plan**: Review and approve code change plans
- **Walkthrough**: View summaries of completed changes

## Artifact Types

### Task List
A markdown list showing task progress for research, implementation, and verification items.

### Implementation Plan
Detailed code change plans with:
- Section-by-section breakdown
- File change previews
- Inline comments for feedback
- Proceed/Review workflow

### Walkthrough
Post-completion summaries including:
- Key points
- Changed files with diff stats
- Section-by-section explanations

## Commands

- `Claude Artifacts: Show Panel` - Open the artifacts panel
- `Claude Artifacts: Create Task List` - Create a new task list
- `Claude Artifacts: Create Implementation Plan` - Create a new plan
- `Claude Artifacts: Create Walkthrough` - Create a new walkthrough

## Development

```bash
# Install dependencies
npm install

# Compile
npm run compile

# Watch mode
npm run watch
```

## Building

```bash
# Create VSIX package
npx vsce package
```

## License

MIT
