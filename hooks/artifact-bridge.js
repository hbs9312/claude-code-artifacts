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
const readline = require('readline');

/**
 * Read all data from stdin (for PreToolUse hooks)
 */
function readStdin() {
  return new Promise((resolve) => {
    let data = '';

    // Check if stdin has data (non-TTY means piped input)
    if (process.stdin.isTTY) {
      resolve(null);
      return;
    }

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      resolve(data.trim() || null);
    });

    // Timeout after 100ms if no data
    setTimeout(() => {
      if (!data) {
        resolve(null);
      }
    }, 100);
  });
}

// Configuration
const GLOBAL_ARTIFACTS_PATH = path.join(os.homedir(), '.claude-artifacts');
const PROJECTS_FILE = path.join(GLOBAL_ARTIFACTS_PATH, 'projects.json');
const LOG_FILE = path.join(GLOBAL_ARTIFACTS_PATH, 'bridge.log');

/**
 * Log to file for debugging
 */
function log(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  try {
    fs.appendFileSync(LOG_FILE, logMessage);
  } catch (e) {
    // Ignore log errors
  }
  console.log(`[artifact-bridge] ${message}`);
}

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
 * Get the outbox path for a workspace (VS Code -> CLI)
 */
function getOutboxPath(workspacePath) {
  const projectId = generateProjectId(workspacePath);
  return path.join(GLOBAL_ARTIFACTS_PATH, projectId, 'outbox');
}

/**
 * Find the latest plan file in ~/.claude/plans/
 */
function findLatestPlanFile(afterTime = 0) {
  const plansDir = path.join(os.homedir(), '.claude', 'plans');

  if (!fs.existsSync(plansDir)) {
    return null;
  }

  const files = fs.readdirSync(plansDir)
    .filter(f => f.endsWith('.md'))
    .map(f => ({
      name: f,
      path: path.join(plansDir, f),
      mtime: fs.statSync(path.join(plansDir, f)).mtimeMs
    }))
    .filter(f => f.mtime > afterTime)
    .sort((a, b) => b.mtime - a.mtime);

  return files.length > 0 ? files[0].path : null;
}

/**
 * Parse plan markdown into sections
 */
function parsePlanMarkdown(content) {
  const lines = content.split('\n');
  const sections = [];
  let currentSection = null;
  let title = 'Implementation Plan';
  let summary = '';

  for (const line of lines) {
    // Extract title from first h1
    if (line.startsWith('# ') && !title.includes(':')) {
      title = line.substring(2).trim();
      continue;
    }

    // h2 starts a new section
    if (line.startsWith('## ')) {
      if (currentSection) {
        sections.push(currentSection);
      }
      currentSection = {
        id: `section-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        title: line.substring(3).trim(),
        description: '',
        files: [],
        changes: [],
        order: sections.length
      };
      continue;
    }

    // Add content to current section or summary
    if (currentSection) {
      currentSection.description += line + '\n';

      // Extract file paths from the content (patterns like `path/to/file.ts`)
      const fileMatches = line.match(/`([^`]+\.[a-z]+)`/g);
      if (fileMatches) {
        for (const match of fileMatches) {
          const filePath = match.replace(/`/g, '');
          if (!currentSection.files.includes(filePath)) {
            currentSection.files.push(filePath);
            currentSection.changes.push({
              filePath,
              changeType: 'modify',
              description: ''
            });
          }
        }
      }
    } else if (line.trim() && !line.startsWith('#')) {
      summary += line + '\n';
    }
  }

  if (currentSection) {
    sections.push(currentSection);
  }

  // Trim descriptions
  sections.forEach(s => {
    s.description = s.description.trim();
  });

  return { title, summary: summary.trim(), sections };
}

/**
 * Wait for approval from VS Code extension
 */
function waitForApproval(workspacePath, planId, timeoutMs = 300000) {
  const outboxPath = getOutboxPath(workspacePath);
  const startTime = Date.now();
  const pollInterval = 1000; // 1 second

  console.log('[artifact-bridge] Waiting for approval from VS Code...');
  console.log('[artifact-bridge] (Timeout:', timeoutMs / 1000, 'seconds)');

  while (Date.now() - startTime < timeoutMs) {
    try {
      if (fs.existsSync(outboxPath)) {
        const files = fs.readdirSync(outboxPath)
          .filter(f => f.endsWith('.json'))
          .sort();

        for (const file of files) {
          const filePath = path.join(outboxPath, file);
          const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

          // Check if this is an approval for our plan
          if (content.type === 'feedback' &&
              content.payload?.artifactId === planId &&
              content.payload?.action === 'proceed') {
            // Remove the processed file
            fs.unlinkSync(filePath);
            console.log('[artifact-bridge] Approval received!');
            return { approved: true };
          }

          // Check for rejection
          if (content.type === 'feedback' &&
              content.payload?.artifactId === planId &&
              content.payload?.action === 'reject') {
            fs.unlinkSync(filePath);
            console.log('[artifact-bridge] Plan rejected by user');
            return { approved: false, reason: 'rejected' };
          }
        }
      }
    } catch (error) {
      // Ignore read errors, continue polling
    }

    // Sleep for poll interval
    const waitUntil = Date.now() + pollInterval;
    while (Date.now() < waitUntil) {
      // Busy wait (Node.js doesn't have sleep)
    }
  }

  console.log('[artifact-bridge] Approval timeout');
  return { approved: false, reason: 'timeout' };
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
    const planStartTime = Date.now();

    // Save plan ID and start time to state file for ExitPlanMode to use
    const stateFile = getStateFile(workspacePath);
    let state = {};
    try {
      state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    } catch {}
    state.currentPlanId = planId;
    state.planStartTime = planStartTime;
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

    const message = createMessage('artifact', {
      action: 'create',
      artifact: {
        id: planId,
        type: 'implementation-plan',
        title: 'Implementation Plan',
        status: 'draft',
        summary: 'Claude Code is creating a plan...',
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
 * Handle ExitPlanMode - finalize Implementation Plan and wait for user approval
 */
function handleExitPlanMode(toolInput, workspacePath) {
  try {
    // Read plan ID and start time from state file
    const stateFile = getStateFile(workspacePath);
    let planId = null;
    let planStartTime = 0;
    try {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      planId = state.currentPlanId;
      planStartTime = state.planStartTime || 0;
    } catch {}

    if (!planId) {
      console.warn('[artifact-bridge] No plan ID found in state file, skipping ExitPlanMode');
      return;
    }

    // Find and read the plan file
    const planFilePath = findLatestPlanFile(planStartTime);
    let planContent = { title: 'Implementation Plan', summary: '', sections: [] };

    if (planFilePath) {
      console.log('[artifact-bridge] Found plan file:', planFilePath);
      const fileContent = fs.readFileSync(planFilePath, 'utf-8');
      planContent = parsePlanMarkdown(fileContent);
    } else {
      console.warn('[artifact-bridge] No plan file found');
    }

    // Update artifact with full plan content
    const message = createMessage('artifact', {
      action: 'update',
      artifact: {
        id: planId,
        title: planContent.title,
        summary: planContent.summary || 'Please review and approve the implementation plan.',
        sections: planContent.sections,
        estimatedChanges: planContent.sections.reduce((sum, s) => sum + s.changes.length, 0),
        status: 'pending-review',
        updatedAt: new Date().toISOString(),
      },
    });

    const inboxPath = getInboxPath(workspacePath);
    writeMessage(inboxPath, message);

    console.log('[artifact-bridge] Implementation Plan updated with content');
    console.log('[artifact-bridge] Sections:', planContent.sections.length);

    // Wait for approval from VS Code
    const result = waitForApproval(workspacePath, planId);

    if (result.approved) {
      // Update status to approved
      const approvalMessage = createMessage('artifact', {
        action: 'update',
        artifact: {
          id: planId,
          status: 'approved',
          updatedAt: new Date().toISOString(),
        },
      });
      writeMessage(inboxPath, approvalMessage);
      console.log('[artifact-bridge] Plan approved, proceeding with implementation');
    } else {
      console.log('[artifact-bridge] Plan not approved:', result.reason);
      // Exit with error to signal CLI to stop
      if (result.reason === 'rejected') {
        process.exit(1);
      }
    }
  } catch (error) {
    console.error('[artifact-bridge] Error handling ExitPlanMode:', error.message);
  }
}

/**
 * Handle PreToolUse ExitPlanMode - intercept before user approval
 * This is called BEFORE the tool executes, allowing us to:
 * 1. Show the plan in VS Code
 * 2. Wait for user approval
 * 3. Return exit code 0 (approve) or 1 (reject)
 */
function handlePreExitPlanMode(stdinData) {
  try {
    const data = JSON.parse(stdinData);
    const workspacePath = data.cwd;
    const planContent = data.tool_input?.plan || '';

    if (!planContent) {
      log('No plan content in PreToolUse, skipping');
      return true; // Allow to proceed
    }

    log('PreToolUse ExitPlanMode intercepted');
    log(`Plan content length: ${planContent.length}`);

    // Parse the plan content first to get title
    const parsed = parsePlanMarkdown(planContent);

    // Generate ID based on title hash (same title = update, different title = new)
    const titleHash = crypto.createHash('md5')
      .update(parsed.title || 'untitled')
      .digest('hex')
      .substring(0, 8);
    const planId = `impl-plan-${titleHash}`;
    log(`Plan title: ${parsed.title}, ID: ${planId}`);

    // Create artifact with full plan content
    const message = createMessage('artifact', {
      action: 'create',
      artifact: {
        id: planId,
        type: 'implementation-plan',
        title: parsed.title || 'Implementation Plan',
        summary: parsed.summary || 'Please review and approve the implementation plan.',
        sections: parsed.sections,
        estimatedChanges: parsed.sections.reduce((sum, s) => sum + s.changes.length, 0),
        status: 'pending-review',
        comments: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });

    const inboxPath = getInboxPath(workspacePath);
    writeMessage(inboxPath, message);

    log(`Workspace: ${workspacePath}`);
    log(`Inbox path: ${inboxPath}`);
    log('Implementation Plan sent to VS Code for review');
    log(`Plan ID: ${planId}`);
    log(`Sections: ${parsed.sections.length}`);

    // Wait for approval from VS Code
    const result = waitForApproval(workspacePath, planId);

    if (result.approved) {
      // Update status to approved
      const approvalMessage = createMessage('artifact', {
        action: 'update',
        artifact: {
          id: planId,
          status: 'approved',
          updatedAt: new Date().toISOString(),
        },
      });
      writeMessage(inboxPath, approvalMessage);
      log('Plan APPROVED - allowing ExitPlanMode to proceed');
      return true; // exit 0 - allow tool to execute
    } else {
      log(`Plan REJECTED: ${result.reason}`);
      // Update status to draft (rejected)
      const rejectMessage = createMessage('artifact', {
        action: 'update',
        artifact: {
          id: planId,
          status: 'draft',
          updatedAt: new Date().toISOString(),
        },
      });
      writeMessage(inboxPath, rejectMessage);
      return false; // exit 1 - block tool execution
    }
  } catch (error) {
    log(`Error in handlePreExitPlanMode: ${error.message}`);
    return true; // On error, allow to proceed
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
 * Handle PreToolUse hooks (stdin-based)
 */
async function handlePreToolUse(stdinData) {
  try {
    const data = JSON.parse(stdinData);
    const hookEvent = data.hook_event_name;
    const toolName = data.tool_name;

    log(`PreToolUse: ${toolName}`);

    if (toolName === 'ExitPlanMode') {
      const approved = handlePreExitPlanMode(stdinData);
      if (!approved) {
        log('Blocking ExitPlanMode (user rejected)');
        process.exit(1); // Block the tool
      }
      log('Allowing ExitPlanMode to proceed');
      process.exit(0); // Allow the tool
    }

    // For other PreToolUse events, allow to proceed
    process.exit(0);
  } catch (error) {
    log(`Error in handlePreToolUse: ${error.message}`);
    process.exit(0); // On error, allow to proceed
  }
}

/**
 * Handle PostToolUse hooks (environment variable-based)
 */
function handlePostToolUse() {
  const toolName = process.env.CLAUDE_TOOL_NAME;
  const toolInput = process.env.CLAUDE_TOOL_INPUT || '{}';
  const toolOutput = process.env.CLAUDE_TOOL_OUTPUT || '{}';
  const workspacePath = process.env.CLAUDE_WORKING_DIR || process.cwd();

  if (!toolName) {
    console.log('[artifact-bridge] No tool name provided (PostToolUse)');
    return;
  }

  console.log(`[artifact-bridge] PostToolUse: ${toolName}`);

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

    // ExitPlanMode is now handled by PreToolUse
    // case 'ExitPlanMode':
    //   handleExitPlanMode(toolInput, workspacePath);
    //   break;

    default:
      // Silently ignore other tools
      break;
  }
}

/**
 * Main entry point
 */
async function main() {
  // Special command line arguments
  if (process.argv[2] === '--clear-session') {
    const workspacePath = process.env.CLAUDE_WORKING_DIR || process.cwd();
    handleClearSession(workspacePath);
    return;
  }

  // Try to read stdin first (for PreToolUse hooks)
  const stdinData = await readStdin();

  if (stdinData) {
    // PreToolUse hook - data comes from stdin
    try {
      const data = JSON.parse(stdinData);
      if (data.hook_event_name === 'PreToolUse') {
        await handlePreToolUse(stdinData);
        return;
      }
    } catch (e) {
      // Not valid JSON, fall through to PostToolUse
    }
  }

  // PostToolUse hook - data comes from environment variables
  handlePostToolUse();
}

// Run
main().catch(err => {
  console.error('[artifact-bridge] Fatal error:', err.message);
  process.exit(1);
});
