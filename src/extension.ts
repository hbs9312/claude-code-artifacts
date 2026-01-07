import * as vscode from 'vscode';
import { ArtifactManager } from './artifact/ArtifactManager';
import { ArtifactProvider } from './artifact/ArtifactProvider';
import { ArtifactTreeProvider } from './artifact/ArtifactTreeProvider';
import { IPCClient, MessageHandler } from './communication';
import { AgentModeManager } from './agent';
import { Artifact, TaskListItem, PlanSection, createTaskId, createSectionId, AgentMode } from './artifact/types';

let artifactManager: ArtifactManager;
let artifactProvider: ArtifactProvider;
let artifactTreeProvider: ArtifactTreeProvider;
let ipcClient: IPCClient;
let messageHandler: MessageHandler;
let agentModeManager: AgentModeManager;
let agentModeStatusBar: vscode.StatusBarItem;

/**
 * Extension activation
 */
export function activate(context: vscode.ExtensionContext): void {
  console.log('Claude Code Artifacts extension is now active');

  // Initialize managers
  artifactManager = new ArtifactManager(context);
  artifactProvider = new ArtifactProvider(context.extensionUri, artifactManager);
  artifactTreeProvider = new ArtifactTreeProvider(artifactManager);

  // Initialize IPC communication
  ipcClient = new IPCClient();
  messageHandler = new MessageHandler(ipcClient, artifactManager, artifactProvider);

  // Initialize Agent Mode Manager
  agentModeManager = new AgentModeManager(context, artifactManager);

  // Create status bar item for agent mode
  agentModeStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  agentModeStatusBar.command = 'claudeArtifacts.toggleAgentMode';
  updateAgentModeStatusBar();
  agentModeStatusBar.show();

  // Listen for mode changes
  agentModeManager.onDidChangeMode(() => {
    updateAgentModeStatusBar();
  });

  // Initialize IPC (non-blocking)
  ipcClient.initialize().then(() => {
    console.log('IPC Client initialized, base path:', ipcClient.getBasePath());
  }).catch(error => {
    console.warn('IPC initialization failed (CLI may not be running):', error.message);
  });

  // Register tree view
  const treeView = vscode.window.createTreeView('claudeArtifacts.artifactList', {
    treeDataProvider: artifactTreeProvider,
    showCollapseAll: true,
  });

  // Register commands
  const commands = [
    vscode.commands.registerCommand('claudeArtifacts.showPanel', () => {
      vscode.window.showInformationMessage('Claude Artifacts Panel');
    }),

    vscode.commands.registerCommand('claudeArtifacts.openArtifact', (artifact: Artifact) => {
      artifactProvider.showArtifactPanel(artifact);
    }),

    vscode.commands.registerCommand('claudeArtifacts.createTaskList', async () => {
      const title = await vscode.window.showInputBox({
        prompt: 'Enter task list title',
        placeHolder: 'My Task List',
      });

      if (title) {
        const artifact = await artifactManager.createTaskList(title);
        artifactProvider.showArtifactPanel(artifact);
        vscode.window.showInformationMessage(`Created task list: ${title}`);
      }
    }),

    vscode.commands.registerCommand('claudeArtifacts.createImplementationPlan', async () => {
      const title = await vscode.window.showInputBox({
        prompt: 'Enter implementation plan title',
        placeHolder: 'Feature Implementation Plan',
      });

      if (title) {
        const summary = await vscode.window.showInputBox({
          prompt: 'Enter a brief summary (optional)',
          placeHolder: 'This plan covers...',
        });

        const artifact = await artifactManager.createImplementationPlan(title, summary || '');
        artifactProvider.showArtifactPanel(artifact);
        vscode.window.showInformationMessage(`Created implementation plan: ${title}`);
      }
    }),

    vscode.commands.registerCommand('claudeArtifacts.createWalkthrough', async () => {
      const title = await vscode.window.showInputBox({
        prompt: 'Enter walkthrough title',
        placeHolder: 'Changes Summary',
      });

      if (title) {
        const summary = await vscode.window.showInputBox({
          prompt: 'Enter a brief summary (optional)',
          placeHolder: 'This walkthrough covers...',
        });

        const artifact = await artifactManager.createWalkthrough(title, summary || '');
        artifactProvider.showArtifactPanel(artifact);
        vscode.window.showInformationMessage(`Created walkthrough: ${title}`);
      }
    }),

    vscode.commands.registerCommand('claudeArtifacts.deleteArtifact', async (item: any) => {
      if (item?.artifact) {
        const confirm = await vscode.window.showWarningMessage(
          `Delete artifact "${item.artifact.title}"?`,
          { modal: true },
          'Delete'
        );

        if (confirm === 'Delete') {
          await artifactManager.deleteArtifact(item.artifact.id);
          vscode.window.showInformationMessage('Artifact deleted');
        }
      }
    }),

    vscode.commands.registerCommand('claudeArtifacts.refreshArtifacts', () => {
      artifactTreeProvider.refresh();
    }),

    // Demo command to create sample artifacts
    vscode.commands.registerCommand('claudeArtifacts.createSampleArtifacts', async () => {
      await createSampleArtifacts();
      vscode.window.showInformationMessage('Sample artifacts created');
    }),

    // Test command to add sample comments to an artifact
    vscode.commands.registerCommand('claudeArtifacts.testComments', async (item: any) => {
      if (item?.artifact) {
        const artifact = item.artifact;
        const commentController = artifactProvider.getCommentController();

        // Add some test comments
        await commentController.addComment(artifact.id, 'This looks good overall!', 'user');
        await commentController.addComment(artifact.id, 'Thanks for the feedback!', 'agent');
        await commentController.addComment(artifact.id, 'Could we add more error handling?', 'user');

        // If there are sections, add section-specific comments
        if (artifact.sections && artifact.sections.length > 0) {
          const firstSection = artifact.sections[0];
          await commentController.addComment(artifact.id, 'This section needs more detail.', 'user', {
            sectionId: firstSection.id,
          });
          await commentController.addComment(artifact.id, 'I will expand on this section.', 'agent', {
            sectionId: firstSection.id,
          });
        }

        artifactProvider.showArtifactPanel(artifact);
        vscode.window.showInformationMessage('Test comments added to artifact');
      }
    }),

    // Quick add task to existing task list
    vscode.commands.registerCommand('claudeArtifacts.addTask', async (item: any) => {
      if (item?.artifact?.type === 'task-list') {
        const text = await vscode.window.showInputBox({
          prompt: 'Enter task description',
          placeHolder: 'New task...',
        });

        if (text) {
          const category = await vscode.window.showQuickPick(
            ['other', 'research', 'implementation', 'verification'],
            { placeHolder: 'Select task category' }
          );

          const taskListProvider = artifactProvider.getTaskListProvider();
          await taskListProvider.addTask(item.artifact.id, text, category as any || 'other');
          artifactTreeProvider.refresh();
        }
      }
    }),

    // Clear completed tasks
    vscode.commands.registerCommand('claudeArtifacts.clearCompletedTasks', async (item: any) => {
      if (item?.artifact?.type === 'task-list') {
        const taskListProvider = artifactProvider.getTaskListProvider();
        const count = await taskListProvider.clearCompletedTasks(item.artifact.id);
        vscode.window.showInformationMessage(`Cleared ${count} completed tasks`);
        artifactTreeProvider.refresh();
      }
    }),

    // Request review for implementation plan
    vscode.commands.registerCommand('claudeArtifacts.requestReview', async (item: any) => {
      if (item?.artifact?.type === 'implementation-plan') {
        const implPlanProvider = artifactProvider.getImplPlanProvider();
        await implPlanProvider.requestReview(item.artifact.id);
        artifactTreeProvider.refresh();
      }
    }),

    // Approve implementation plan
    vscode.commands.registerCommand('claudeArtifacts.approvePlan', async (item: any) => {
      if (item?.artifact?.type === 'implementation-plan') {
        const implPlanProvider = artifactProvider.getImplPlanProvider();
        await implPlanProvider.approve(item.artifact.id);
        artifactTreeProvider.refresh();
      }
    }),

    // IPC Status command
    vscode.commands.registerCommand('claudeArtifacts.ipcStatus', () => {
      const status = ipcClient.connected ? 'Connected' : 'Disconnected';
      const basePath = ipcClient.getBasePath();
      vscode.window.showInformationMessage(`IPC Status: ${status}\nPath: ${basePath}`);
    }),

    // ============ Agent Mode Commands ============

    // Toggle agent mode
    vscode.commands.registerCommand('claudeArtifacts.toggleAgentMode', async () => {
      const newMode = await agentModeManager.toggleMode();
      updateAgentModeStatusBar();
    }),

    // Set planning mode
    vscode.commands.registerCommand('claudeArtifacts.setPlanningMode', async () => {
      await agentModeManager.setMode('planning');
    }),

    // Set fast mode
    vscode.commands.registerCommand('claudeArtifacts.setFastMode', async () => {
      await agentModeManager.setMode('fast');
    }),

    // Toggle review policy
    vscode.commands.registerCommand('claudeArtifacts.toggleReviewPolicy', async () => {
      const currentPolicy = agentModeManager.getReviewPolicy();
      const newPolicy = currentPolicy === 'request-review' ? 'always-proceed' : 'request-review';
      await agentModeManager.setReviewPolicy(newPolicy);
      const label = newPolicy === 'always-proceed' ? 'Always Proceed' : 'Request Review';
      vscode.window.showInformationMessage(`Review policy set to: ${label}`);
    }),

    // Create task group
    vscode.commands.registerCommand('claudeArtifacts.createTaskGroup', async () => {
      const name = await vscode.window.showInputBox({
        prompt: 'Enter task group name',
        placeHolder: 'Feature Implementation',
      });

      if (name) {
        const description = await vscode.window.showInputBox({
          prompt: 'Enter description (optional)',
          placeHolder: 'Description of the task group...',
        });

        const taskGroup = await agentModeManager.createTaskGroup(name, description || undefined);
        vscode.window.showInformationMessage(`Task group "${name}" created`);
        artifactTreeProvider.refresh();
      }
    }),

    // Complete task group
    vscode.commands.registerCommand('claudeArtifacts.completeTaskGroup', async () => {
      const activeGroup = agentModeManager.getActiveTaskGroup();
      if (activeGroup) {
        await agentModeManager.completeTaskGroup(activeGroup.id);
        artifactTreeProvider.refresh();
      } else {
        vscode.window.showWarningMessage('No active task group');
      }
    }),

    // Show agent mode status
    vscode.commands.registerCommand('claudeArtifacts.agentModeStatus', () => {
      const state = agentModeManager.getState();
      const modeLabel = state.mode === 'planning' ? 'Planning Mode' : 'Fast Mode';
      const policyLabel = state.reviewPolicy === 'request-review' ? 'Request Review' : 'Always Proceed';
      const groupLabel = state.activeTaskGroup ? state.activeTaskGroup.name : 'None';

      vscode.window.showInformationMessage(
        `Agent Mode: ${modeLabel}\nReview Policy: ${policyLabel}\nActive Group: ${groupLabel}\nArtifacts: ${state.artifactCount}`
      );
    }),

    // Setup hooks for Claude Code integration
    vscode.commands.registerCommand('claudeArtifacts.setupHooks', async () => {
      await setupClaudeCodeHooks(context);
    }),

    // Show hook configuration instructions
    vscode.commands.registerCommand('claudeArtifacts.showHookInstructions', () => {
      showHookInstructions();
    }),

    // Show current IPC info
    vscode.commands.registerCommand('claudeArtifacts.showIPCInfo', () => {
      const basePath = ipcClient.getBasePath();
      const projectId = ipcClient.getProjectId();
      const workspacePath = ipcClient.getWorkspacePath();

      const panel = vscode.window.createWebviewPanel(
        'ipcInfo',
        'IPC Configuration',
        vscode.ViewColumn.One,
        {}
      );

      panel.webview.html = `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: var(--vscode-font-family); padding: 20px; }
            code { background: var(--vscode-textBlockQuote-background); padding: 2px 6px; border-radius: 3px; }
            pre { background: var(--vscode-textBlockQuote-background); padding: 12px; border-radius: 6px; overflow-x: auto; }
            h2 { border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 8px; }
          </style>
        </head>
        <body>
          <h1>IPC Configuration</h1>

          <h2>Current Project</h2>
          <p><strong>Workspace:</strong> <code>${workspacePath}</code></p>
          <p><strong>Project ID:</strong> <code>${projectId}</code></p>
          <p><strong>IPC Path:</strong> <code>${basePath}</code></p>

          <h2>Directory Structure</h2>
          <pre>
~/.claude-artifacts/
└── ${projectId}/
    ├── inbox/      ← CLI writes here
    ├── outbox/     ← Extension writes here
    └── processed/  ← Processed messages
          </pre>

          <h2>Hook Configuration</h2>
          <p>Add to <code>~/.claude/settings.json</code>:</p>
          <pre>
{
  "hooks": {
    "postToolUse": [
      {
        "matcher": "TodoWrite",
        "command": "node ~/.claude-artifacts/hooks/artifact-bridge.js"
      }
    ]
  }
}
          </pre>
        </body>
        </html>
      `;
    }),

    // Test IPC command - simulate CLI message
    vscode.commands.registerCommand('claudeArtifacts.testIPC', async () => {
      const basePath = ipcClient.getBasePath();
      const inboxPath = require('path').join(basePath, 'inbox');
      const fs = require('fs');

      // Ensure inbox exists
      if (!fs.existsSync(inboxPath)) {
        fs.mkdirSync(inboxPath, { recursive: true });
      }

      // Create a test message (simulating CLI)
      const testMessage = {
        id: `test-${Date.now()}`,
        timestamp: Date.now(),
        type: 'artifact',
        payload: {
          action: 'create',
          artifact: {
            id: `artifact-${Date.now()}`,
            type: 'task-list',
            title: 'Test Task List from CLI',
            status: 'draft',
            comments: [],
            items: [
              { id: 'task-1', text: 'Task from CLI simulation', status: 'pending', category: 'other', order: 1 }
            ],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }
        }
      };

      const filename = `${testMessage.timestamp}-${testMessage.id}.json`;
      const filePath = require('path').join(inboxPath, filename);
      fs.writeFileSync(filePath, JSON.stringify(testMessage, null, 2));

      vscode.window.showInformationMessage('Test IPC message sent! Check the artifacts panel.');
    }),
  ];

  // Register disposables
  context.subscriptions.push(
    treeView,
    artifactManager,
    artifactProvider,
    artifactTreeProvider,
    ipcClient,
    messageHandler,
    agentModeManager,
    agentModeStatusBar,
    ...commands
  );

  // Listen for feedback from webview and forward to CLI
  artifactProvider.onDidSendFeedback(feedback => {
    console.log('Feedback received:', feedback);
    // Send feedback to Claude Code CLI via IPC
    if (ipcClient.connected) {
      ipcClient.sendFeedback(feedback).catch(error => {
        console.error('Failed to send feedback to CLI:', error);
      });
    }
  });

  // Listen for IPC errors
  ipcClient.onError(error => {
    console.error('IPC Error:', error);
  });

  // Listen for IPC connection events
  ipcClient.onDidConnect(() => {
    vscode.window.showInformationMessage('Connected to Claude Code CLI');
  });

  ipcClient.onDidDisconnect(() => {
    console.log('Disconnected from Claude Code CLI');
  });

  // Show welcome message on first activation
  const hasShownWelcome = context.globalState.get('hasShownWelcome');
  if (!hasShownWelcome) {
    vscode.window.showInformationMessage(
      'Claude Code Artifacts extension activated! View artifacts in the sidebar.',
      'Open Artifacts'
    ).then(selection => {
      if (selection === 'Open Artifacts') {
        vscode.commands.executeCommand('workbench.view.extension.claude-artifacts');
      }
    });
    context.globalState.update('hasShownWelcome', true);
  }
}

/**
 * Setup Claude Code hooks for artifact integration
 */
async function setupClaudeCodeHooks(context: vscode.ExtensionContext): Promise<void> {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');

  const globalArtifactsPath = path.join(os.homedir(), '.claude-artifacts');
  const hooksPath = path.join(globalArtifactsPath, 'hooks');
  const bridgeScriptDest = path.join(hooksPath, 'artifact-bridge.js');

  // Create hooks directory
  if (!fs.existsSync(hooksPath)) {
    fs.mkdirSync(hooksPath, { recursive: true });
  }

  // Copy bridge script from extension
  const bridgeScriptSrc = path.join(context.extensionPath, 'hooks', 'artifact-bridge.js');

  if (fs.existsSync(bridgeScriptSrc)) {
    fs.copyFileSync(bridgeScriptSrc, bridgeScriptDest);
    vscode.window.showInformationMessage(`Hook script installed to: ${bridgeScriptDest}`);
  } else {
    // If source doesn't exist, create it directly
    const bridgeScript = getBridgeScriptContent();
    fs.writeFileSync(bridgeScriptDest, bridgeScript);
    vscode.window.showInformationMessage(`Hook script created at: ${bridgeScriptDest}`);
  }

  // Show next steps
  const action = await vscode.window.showInformationMessage(
    'Hook script installed! Add the hook configuration to ~/.claude/settings.json',
    'Show Instructions',
    'Open settings.json'
  );

  if (action === 'Show Instructions') {
    showHookInstructions();
  } else if (action === 'Open settings.json') {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const doc = await vscode.workspace.openTextDocument(settingsPath);
      await vscode.window.showTextDocument(doc);
    } else {
      // Create the file if it doesn't exist
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify({
        hooks: {
          postToolUse: [
            {
              matcher: '.*',
              command: `node ${bridgeScriptDest}`
            }
          ]
        }
      }, null, 2));
      const doc = await vscode.workspace.openTextDocument(settingsPath);
      await vscode.window.showTextDocument(doc);
    }
  }
}

/**
 * Show hook configuration instructions
 */
function showHookInstructions(): void {
  const os = require('os');
  const path = require('path');

  const bridgeScriptPath = path.join(os.homedir(), '.claude-artifacts', 'hooks', 'artifact-bridge.js');

  const panel = vscode.window.createWebviewPanel(
    'hookInstructions',
    'Claude Code Hook Setup',
    vscode.ViewColumn.One,
    {}
  );

  panel.webview.html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: var(--vscode-font-family); padding: 20px; line-height: 1.6; }
        code { background: var(--vscode-textBlockQuote-background); padding: 2px 6px; border-radius: 3px; }
        pre { background: var(--vscode-textBlockQuote-background); padding: 12px; border-radius: 6px; overflow-x: auto; }
        h2 { border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 8px; margin-top: 24px; }
        .step { margin: 16px 0; padding: 12px; background: var(--vscode-editor-inactiveSelectionBackground); border-radius: 6px; }
        .step-number { display: inline-block; width: 24px; height: 24px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-radius: 50%; text-align: center; line-height: 24px; margin-right: 8px; }
      </style>
    </head>
    <body>
      <h1>🔗 Claude Code Hook 설정</h1>

      <p>Claude Code의 Hook 기능을 사용하여 VS Code Extension과 연동합니다.</p>

      <h2>설정 단계</h2>

      <div class="step">
        <span class="step-number">1</span>
        <strong>Hook 스크립트 설치</strong>
        <p>명령 팔레트에서 <code>Claude Artifacts: Setup Hooks</code> 실행</p>
        <p>또는 아래 경로에 스크립트가 설치됩니다:</p>
        <pre>${bridgeScriptPath}</pre>
      </div>

      <div class="step">
        <span class="step-number">2</span>
        <strong>Claude Code 설정 파일 수정</strong>
        <p><code>~/.claude/settings.json</code> 파일을 열고 다음을 추가:</p>
        <pre>{
  "hooks": {
    "postToolUse": [
      {
        "matcher": ".*",
        "command": "node ${bridgeScriptPath}"
      }
    ]
  }
}</pre>
        <p><em>참고: <code>.*</code>는 모든 도구를 매칭합니다. 필요한 도구만 지정할 수도 있습니다.</em></p>
      </div>

      <div class="step">
        <span class="step-number">3</span>
        <strong>테스트</strong>
        <p>Claude Code에서 작업하면 VS Code Extension에 자동으로 동기화됩니다:</p>
        <ul>
          <li>TodoWrite → Task List 동기화</li>
          <li>Write/Edit → Walkthrough에 파일 변경 기록</li>
          <li>EnterPlanMode → Implementation Plan 생성</li>
        </ul>
      </div>

      <h2>지원되는 Hook</h2>
      <table style="width: 100%; border-collapse: collapse;">
        <tr style="background: var(--vscode-editor-inactiveSelectionBackground);">
          <th style="padding: 8px; text-align: left;">Tool</th>
          <th style="padding: 8px; text-align: left;">Artifact</th>
          <th style="padding: 8px; text-align: left;">Action</th>
        </tr>
        <tr>
          <td style="padding: 8px;"><code>TodoWrite</code></td>
          <td style="padding: 8px;">Task List</td>
          <td style="padding: 8px;">실시간 동기화</td>
        </tr>
        <tr>
          <td style="padding: 8px;"><code>Write</code></td>
          <td style="padding: 8px;">Walkthrough</td>
          <td style="padding: 8px;">파일 생성 기록</td>
        </tr>
        <tr>
          <td style="padding: 8px;"><code>Edit</code></td>
          <td style="padding: 8px;">Walkthrough</td>
          <td style="padding: 8px;">파일 수정 기록</td>
        </tr>
        <tr>
          <td style="padding: 8px;"><code>Bash (rm)</code></td>
          <td style="padding: 8px;">Walkthrough</td>
          <td style="padding: 8px;">파일 삭제 기록</td>
        </tr>
        <tr>
          <td style="padding: 8px;"><code>EnterPlanMode</code></td>
          <td style="padding: 8px;">Implementation Plan</td>
          <td style="padding: 8px;">계획 생성</td>
        </tr>
        <tr>
          <td style="padding: 8px;"><code>ExitPlanMode</code></td>
          <td style="padding: 8px;">Implementation Plan</td>
          <td style="padding: 8px;">계획 완료</td>
        </tr>
      </table>

      <h2>폴더 구조</h2>
      <pre>
~/.claude-artifacts/
├── hooks/
│   └── artifact-bridge.js    ← Hook 스크립트
├── projects.json              ← 프로젝트 매핑
└── {project-id}/
    ├── inbox/                 ← CLI → Extension
    ├── outbox/                ← Extension → CLI
    └── processed/             ← 처리 완료
      </pre>

      <h2>문제 해결</h2>
      <ul>
        <li>Hook이 실행되지 않으면 <code>~/.claude/settings.json</code> 경로 확인</li>
        <li>Node.js가 설치되어 있어야 합니다</li>
        <li>VS Code Extension이 활성화되어 있어야 합니다</li>
      </ul>
    </body>
    </html>
  `;
}

/**
 * Get bridge script content (for dynamic creation)
 */
function getBridgeScriptContent(): string {
  return `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const GLOBAL_ARTIFACTS_PATH = path.join(os.homedir(), '.claude-artifacts');

function generateProjectId(workspacePath) {
  const hash = crypto.createHash('md5').update(workspacePath).digest('hex').substring(0, 8);
  const folderName = path.basename(workspacePath).toLowerCase().replace(/[^a-z0-9]/g, '-');
  return \`\${folderName}-\${hash}\`;
}

function getInboxPath(workspacePath) {
  const projectId = generateProjectId(workspacePath);
  return path.join(GLOBAL_ARTIFACTS_PATH, projectId, 'inbox');
}

function writeMessage(inboxPath, message) {
  fs.mkdirSync(inboxPath, { recursive: true });
  const filename = \`\${message.timestamp}-\${message.id}.json\`;
  fs.writeFileSync(path.join(inboxPath, filename), JSON.stringify(message, null, 2));
}

function createMessage(type, payload) {
  return {
    id: \`msg-\${Date.now()}-\${Math.random().toString(36).substr(2, 9)}\`,
    timestamp: Date.now(),
    type,
    payload,
  };
}

function mapStatus(status) {
  return status === 'completed' ? 'completed' : status === 'in_progress' ? 'in-progress' : 'pending';
}

function handleTodoWrite(toolInput, workspacePath) {
  try {
    const input = JSON.parse(toolInput);
    const todos = input.todos || [];
    const items = todos.map((t, i) => ({
      id: \`task-\${i}-\${Date.now()}\`,
      text: t.content || t.text || '',
      status: mapStatus(t.status),
      category: 'other',
      order: i + 1,
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

    writeMessage(getInboxPath(workspacePath), message);
  } catch (e) {
    console.error('[artifact-bridge] Error:', e.message);
  }
}

const toolName = process.env.CLAUDE_TOOL_NAME;
const toolInput = process.env.CLAUDE_TOOL_INPUT || '{}';
const workspacePath = process.env.CLAUDE_WORKING_DIR || process.cwd();

if (toolName === 'TodoWrite') {
  handleTodoWrite(toolInput, workspacePath);
}
`;
}

/**
 * Update the agent mode status bar item
 */
function updateAgentModeStatusBar(): void {
  const mode = agentModeManager.getMode();
  const policy = agentModeManager.getReviewPolicy();
  const activeGroup = agentModeManager.getActiveTaskGroup();

  const modeIcon = mode === 'planning' ? '$(checklist)' : '$(zap)';
  const modeLabel = mode === 'planning' ? 'Planning' : 'Fast';
  const policyIcon = policy === 'request-review' ? '$(eye)' : '$(check)';

  let text = `${modeIcon} ${modeLabel}`;
  if (activeGroup) {
    text += ` | ${activeGroup.name}`;
  }

  agentModeStatusBar.text = text;
  agentModeStatusBar.tooltip = `Agent Mode: ${modeLabel}\nReview Policy: ${policy === 'request-review' ? 'Request Review' : 'Always Proceed'}\nClick to toggle mode`;
}

/**
 * Create sample artifacts for demonstration
 */
async function createSampleArtifacts(): Promise<void> {
  // Sample Task List
  const taskList = await artifactManager.createTaskList('Authentication Feature Tasks');
  const tasks: TaskListItem[] = [
    { id: createTaskId(), text: 'Research OAuth 2.0 implementation patterns', status: 'completed', category: 'research', order: 1 },
    { id: createTaskId(), text: 'Design authentication flow', status: 'completed', category: 'research', order: 2 },
    { id: createTaskId(), text: 'Implement login endpoint', status: 'in-progress', category: 'implementation', order: 3 },
    { id: createTaskId(), text: 'Implement token refresh', status: 'pending', category: 'implementation', order: 4 },
    { id: createTaskId(), text: 'Add logout functionality', status: 'pending', category: 'implementation', order: 5 },
    { id: createTaskId(), text: 'Write unit tests', status: 'pending', category: 'verification', order: 6 },
    { id: createTaskId(), text: 'Integration testing', status: 'pending', category: 'verification', order: 7 },
  ];
  await artifactManager.updateArtifact(taskList.id, { items: tasks });

  // Sample Implementation Plan
  const plan = await artifactManager.createImplementationPlan(
    'User Authentication System',
    'This plan outlines the implementation of a secure user authentication system using JWT tokens and OAuth 2.0.'
  );
  const sections: PlanSection[] = [
    {
      id: createSectionId(),
      title: 'Database Schema',
      description: 'Create user and session tables to store authentication data.',
      files: ['src/models/user.ts', 'src/models/session.ts'],
      changes: [
        { filePath: 'src/models/user.ts', changeType: 'create', description: 'Create User model with password hashing' },
        { filePath: 'src/models/session.ts', changeType: 'create', description: 'Create Session model for refresh tokens' },
      ],
      order: 1,
    },
    {
      id: createSectionId(),
      title: 'Authentication Service',
      description: 'Implement core authentication logic including login, logout, and token management.',
      files: ['src/services/auth.ts'],
      changes: [
        { filePath: 'src/services/auth.ts', changeType: 'create', description: 'Implement AuthService with JWT handling' },
      ],
      order: 2,
    },
    {
      id: createSectionId(),
      title: 'API Endpoints',
      description: 'Create REST API endpoints for authentication operations.',
      files: ['src/routes/auth.ts', 'src/middleware/auth.ts'],
      changes: [
        { filePath: 'src/routes/auth.ts', changeType: 'create', description: 'Add /login, /logout, /refresh endpoints' },
        { filePath: 'src/middleware/auth.ts', changeType: 'create', description: 'Add authentication middleware' },
      ],
      order: 3,
    },
  ];
  await artifactManager.updateArtifact(plan.id, {
    sections,
    estimatedChanges: 5,
    status: 'pending-review',
  });

  // Sample Walkthrough
  const walkthrough = await artifactManager.createWalkthrough(
    'Authentication Implementation Complete',
    'Summary of changes made to implement the user authentication system.'
  );
  await artifactManager.updateArtifact(walkthrough.id, {
    keyPoints: [
      'JWT-based authentication with secure token handling',
      'Refresh token rotation for enhanced security',
      'Protected routes using authentication middleware',
      'Comprehensive error handling for auth failures',
    ],
    sections: [
      {
        id: createSectionId(),
        title: 'What was implemented',
        content: 'The authentication system now supports user login with email/password, JWT token generation, token refresh, and secure logout with token invalidation.',
        order: 1,
      },
      {
        id: createSectionId(),
        title: 'Security considerations',
        content: 'Passwords are hashed using bcrypt. Tokens have configurable expiration times. Refresh tokens are rotated on each use to prevent replay attacks.',
        order: 2,
      },
    ],
    changedFiles: [
      { filePath: 'src/models/user.ts', changeType: 'create', linesAdded: 45, linesRemoved: 0, summary: 'User model' },
      { filePath: 'src/models/session.ts', changeType: 'create', linesAdded: 32, linesRemoved: 0, summary: 'Session model' },
      { filePath: 'src/services/auth.ts', changeType: 'create', linesAdded: 128, linesRemoved: 0, summary: 'Auth service' },
      { filePath: 'src/routes/auth.ts', changeType: 'create', linesAdded: 67, linesRemoved: 0, summary: 'Auth routes' },
      { filePath: 'src/middleware/auth.ts', changeType: 'create', linesAdded: 34, linesRemoved: 0, summary: 'Auth middleware' },
    ],
    status: 'completed',
  });
}

/**
 * Extension deactivation
 */
export function deactivate(): void {
  console.log('Claude Code Artifacts extension is now deactivated');
}
