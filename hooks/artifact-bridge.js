#!/usr/bin/env node

/**
 * Claude Code Artifacts - Hook Bridge Script
 *
 * This script bridges Claude Code CLI with the VS Code Extension
 * through file-based IPC. It's triggered by Claude Code hooks.
 *
 * Supported Tools:
 *   - TodoWrite: Task List 동기화
 *   - Write/Edit: Walkthrough에 파일 변경 기록
 *   - EnterPlanMode: Implementation Plan 생성
 *
 * Usage:
 *   Hook configuration in .claude/settings.json or ~/.claude/settings.json:
 *   {
 *     "hooks": {
 *       "postToolUse": [
 *         {
 *           "matcher": ".*",
 *           "command": "node ~/.claude-artifacts/hooks/artifact-bridge.js"
 *         }
 *       ]
 *     }
 *   }
 *
 * Environment variables (set by Claude Code):
 *   CLAUDE_TOOL_NAME - Name of the tool that was called
 *   CLAUDE_TOOL_INPUT - JSON input to the tool
 *   CLAUDE_TOOL_OUTPUT - JSON output from the tool
 *   CLAUDE_WORKING_DIR - Current working directory (or use cwd)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// Configuration
const GLOBAL_ARTIFACTS_PATH = path.join(os.homedir(), '.claude-artifacts');
const PROJECTS_FILE = path.join(GLOBAL_ARTIFACTS_PATH, 'projects.json');

// State file for tracking changes across tool calls
const getStateFile = (workspacePath) => {
  const projectId = generateProjectId(workspacePath);
  return path.join(GLOBAL_ARTIFACTS_PATH, projectId, 'session-state.json');
};

/**
 * Generate project ID from workspace path (must match IPCClient logic)
 */
function generateProjectId(workspacePath) {
  const hash = crypto.createHash('md5').update(workspacePath).digest('hex').substring(0, 8);
  const folderName = path.basename(workspacePath).toLowerCase().replace(/[^a-z0-9]/g, '-');
  return `${folderName}-${hash}`;
}

/**
 * Get the inbox path for a workspace
 */
function getInboxPath(workspacePath) {
  const projectId = generateProjectId(workspacePath);
  return path.join(GLOBAL_ARTIFACTS_PATH, projectId, 'inbox');
}

/**
 * Write a message to the inbox
 */
function writeMessage(inboxPath, message) {
  // Ensure inbox directory exists
  fs.mkdirSync(inboxPath, { recursive: true });

  const filename = `${message.timestamp}-${message.id}.json`;
  const filePath = path.join(inboxPath, filename);

  fs.writeFileSync(filePath, JSON.stringify(message, null, 2));
  console.log(`[artifact-bridge] Message written: ${filename}`);
}

/**
 * Create an IPC message
 */
function createMessage(type, payload) {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    timestamp: Date.now(),
    type,
    payload,
  };
}

/**
 * Handle TodoWrite tool - sync task list to VS Code
 */
function handleTodoWrite(toolInput, workspacePath) {
  try {
    const input = JSON.parse(toolInput);
    const todos = input.todos || [];

    const items = todos.map((todo, index) => ({
      id: `task-${index}-${Date.now()}`,
      text: todo.content || todo.text || '',
      status: mapTodoStatus(todo.status),
      category: 'other',
      order: index + 1,
    }));

    const message = createMessage('artifact', {
      action: 'update',
      artifact: {
        id: 'claude-code-tasks',
        type: 'task-list',
        title: 'Claude Code Tasks',
        status: 'draft',
        items,
        comments: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });

    const inboxPath = getInboxPath(workspacePath);
    writeMessage(inboxPath, message);

    console.log(`[artifact-bridge] Task list synced: ${items.length} tasks`);
  } catch (error) {
    console.error('[artifact-bridge] Error handling TodoWrite:', error.message);
  }
}

/**
 * Map Claude Code todo status to artifact status
 */
function mapTodoStatus(status) {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'in_progress':
      return 'in-progress';
    case 'pending':
    default:
      return 'pending';
  }
}

// ============================================
// Session State Management (for Walkthrough)
// ============================================

/**
 * Load session state
 */
function loadState(workspacePath) {
  const stateFile = getStateFile(workspacePath);
  try {
    if (fs.existsSync(stateFile)) {
      return JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    }
  } catch (e) {
    console.error('[artifact-bridge] Error loading state:', e.message);
  }
  return {
    sessionId: `session-${Date.now()}`,
    startedAt: new Date().toISOString(),
    changedFiles: [],
    keyPoints: [],
  };
}

/**
 * Save session state
 */
function saveState(workspacePath, state) {
  const stateFile = getStateFile(workspacePath);
  const dir = path.dirname(stateFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

/**
 * Add file change to state
 */
function addFileChange(workspacePath, filePath, changeType, linesAdded = 0, linesRemoved = 0) {
  const state = loadState(workspacePath);

  // Check if file already tracked
  const existing = state.changedFiles.find(f => f.filePath === filePath);
  if (existing) {
    existing.linesAdded += linesAdded;
    existing.linesRemoved += linesRemoved;
    existing.changeCount = (existing.changeCount || 1) + 1;
  } else {
    state.changedFiles.push({
      filePath,
      changeType,
      linesAdded,
      linesRemoved,
      changeCount: 1,
      timestamp: new Date().toISOString(),
    });
  }

  saveState(workspacePath, state);
  return state;
}

// ============================================
// Tool Handlers
// ============================================

/**
 * Handle Write tool - track new file creation
 */
function handleWrite(toolInput, workspacePath) {
  try {
    const input = JSON.parse(toolInput);
    const filePath = input.file_path || input.path || '';
    const content = input.content || '';

    if (filePath) {
      const relativePath = filePath.startsWith(workspacePath)
        ? filePath.substring(workspacePath.length + 1)
        : filePath;

      const linesAdded = content.split('\n').length;
      const state = addFileChange(workspacePath, relativePath, 'create', linesAdded, 0);

      // Update walkthrough artifact
      updateWalkthroughArtifact(workspacePath, state);

      console.log(`[artifact-bridge] Write tracked: ${relativePath} (+${linesAdded} lines)`);
    }
  } catch (error) {
    console.error('[artifact-bridge] Error handling Write:', error.message);
  }
}

/**
 * Handle Edit tool - track file modifications
 */
function handleEdit(toolInput, workspacePath) {
  try {
    const input = JSON.parse(toolInput);
    const filePath = input.file_path || input.path || '';
    const oldString = input.old_string || '';
    const newString = input.new_string || '';

    if (filePath) {
      const relativePath = filePath.startsWith(workspacePath)
        ? filePath.substring(workspacePath.length + 1)
        : filePath;

      const linesRemoved = oldString.split('\n').length;
      const linesAdded = newString.split('\n').length;
      const state = addFileChange(workspacePath, relativePath, 'modify', linesAdded, linesRemoved);

      // Update walkthrough artifact
      updateWalkthroughArtifact(workspacePath, state);

      console.log(`[artifact-bridge] Edit tracked: ${relativePath} (+${linesAdded}/-${linesRemoved})`);
    }
  } catch (error) {
    console.error('[artifact-bridge] Error handling Edit:', error.message);
  }
}

/**
 * Handle Bash tool - track file deletions (rm commands)
 */
function handleBash(toolInput, workspacePath) {
  try {
    const input = JSON.parse(toolInput);
    const command = input.command || '';

    // Detect file deletion commands
    const rmMatch = command.match(/rm\s+(?:-[rf]+\s+)?(.+)/);
    if (rmMatch) {
      const filePath = rmMatch[1].trim();
      const relativePath = filePath.startsWith(workspacePath)
        ? filePath.substring(workspacePath.length + 1)
        : filePath;

      const state = addFileChange(workspacePath, relativePath, 'delete', 0, 0);
      updateWalkthroughArtifact(workspacePath, state);

      console.log(`[artifact-bridge] Delete tracked: ${relativePath}`);
    }
  } catch (error) {
    console.error('[artifact-bridge] Error handling Bash:', error.message);
  }
}

/**
 * Update Walkthrough artifact with current state
 */
function updateWalkthroughArtifact(workspacePath, state) {
  const changedFiles = state.changedFiles.map(f => ({
    filePath: f.filePath,
    changeType: f.changeType,
    linesAdded: f.linesAdded,
    linesRemoved: f.linesRemoved,
    summary: `${f.changeCount} change(s)`,
  }));

  // Calculate totals
  const totalAdded = changedFiles.reduce((sum, f) => sum + f.linesAdded, 0);
  const totalRemoved = changedFiles.reduce((sum, f) => sum + f.linesRemoved, 0);

  const message = createMessage('artifact', {
    action: 'update',
    artifact: {
      id: 'claude-code-walkthrough',
      type: 'walkthrough',
      title: 'Session Changes',
      status: 'draft',
      summary: `${changedFiles.length} files changed (+${totalAdded}/-${totalRemoved} lines)`,
      sections: [
        {
          id: 'changes-summary',
          title: 'Changes Summary',
          content: `This session started at ${state.startedAt}.\n\n${changedFiles.length} files have been modified.`,
          order: 1,
        },
      ],
      changedFiles,
      keyPoints: state.keyPoints || [],
      comments: [],
      createdAt: state.startedAt,
      updatedAt: new Date().toISOString(),
    },
  });

  const inboxPath = getInboxPath(workspacePath);
  writeMessage(inboxPath, message);
}

/**
 * Handle EnterPlanMode - create Implementation Plan
 */
function handleEnterPlanMode(toolInput, workspacePath) {
  try {
    const planId = `impl-plan-${Date.now()}`;

    // Save plan ID to state file for ExitPlanMode to use
    const stateFile = getStateFile(workspacePath);
    let state = {};
    try {
      state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    } catch {}
    state.currentPlanId = planId;
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

    const message = createMessage('artifact', {
      action: 'create',
      artifact: {
        id: planId,
        type: 'implementation-plan',
        title: 'Implementation Plan',
        status: 'pending-review',
        summary: 'Claude Code is entering planning mode. Please review the implementation plan.',
        sections: [],
        estimatedChanges: 0,
        comments: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });

    const inboxPath = getInboxPath(workspacePath);
    writeMessage(inboxPath, message);

    console.log('[artifact-bridge] Implementation Plan created with ID:', planId);
  } catch (error) {
    console.error('[artifact-bridge] Error handling EnterPlanMode:', error.message);
  }
}

/**
 * Handle ExitPlanMode - finalize Implementation Plan (ready for user review)
 */
function handleExitPlanMode(toolInput, workspacePath) {
  try {
    // Read plan ID from state file
    const stateFile = getStateFile(workspacePath);
    let planId = null;
    try {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      planId = state.currentPlanId;
    } catch {}

    if (!planId) {
      console.warn('[artifact-bridge] No plan ID found in state file, skipping ExitPlanMode');
      return;
    }

    // Update plan summary to indicate it's ready for review
    // Status remains 'pending-review' - user approves via VS Code extension
    const message = createMessage('artifact', {
      action: 'update',
      artifact: {
        id: planId,
        summary: 'Planning complete. Please review and approve the implementation plan.',
      },
    });

    const inboxPath = getInboxPath(workspacePath);
    writeMessage(inboxPath, message);

    console.log('[artifact-bridge] Implementation Plan ready for review, ID:', planId);
  } catch (error) {
    console.error('[artifact-bridge] Error handling ExitPlanMode:', error.message);
  }
}

/**
 * Clear session state (for new sessions)
 */
function handleClearSession(workspacePath) {
  const stateFile = getStateFile(workspacePath);
  if (fs.existsSync(stateFile)) {
    fs.unlinkSync(stateFile);
    console.log('[artifact-bridge] Session state cleared');
  }
}

/**
 * Main entry point
 */
function main() {
  const toolName = process.env.CLAUDE_TOOL_NAME;
  const toolInput = process.env.CLAUDE_TOOL_INPUT || '{}';
  const toolOutput = process.env.CLAUDE_TOOL_OUTPUT || '{}';
  const workspacePath = process.env.CLAUDE_WORKING_DIR || process.cwd();

  // Special command line arguments
  if (process.argv[2] === '--clear-session') {
    handleClearSession(workspacePath);
    return;
  }

  if (!toolName) {
    console.log('[artifact-bridge] No tool name provided, exiting');
    return;
  }

  console.log(`[artifact-bridge] Tool: ${toolName}`);

  switch (toolName) {
    case 'TodoWrite':
      handleTodoWrite(toolInput, workspacePath);
      break;

    case 'Write':
      handleWrite(toolInput, workspacePath);
      break;

    case 'Edit':
      handleEdit(toolInput, workspacePath);
      break;

    case 'Bash':
      handleBash(toolInput, workspacePath);
      break;

    case 'EnterPlanMode':
      handleEnterPlanMode(toolInput, workspacePath);
      break;

    case 'ExitPlanMode':
      handleExitPlanMode(toolInput, workspacePath);
      break;

    default:
      // Silently ignore other tools
      break;
  }
}

// Run
main();
