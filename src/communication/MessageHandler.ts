import * as vscode from 'vscode';
import { ArtifactManager } from '../artifact/ArtifactManager';
import { ArtifactProvider } from '../artifact/ArtifactProvider';
import { IPCClient } from './IPCClient';
import {
  IPCMessage,
  ArtifactMessage,
  ArtifactCreateMessage,
  ArtifactUpdateMessage,
  ArtifactDeleteMessage,
  ArtifactRequestReviewMessage,
  Artifact,
  TaskListArtifact,
  ImplementationPlanArtifact,
  WalkthroughArtifact,
  ClaudeStateMessage,
  PlanOptionsMessage,
  ClaudeDiscussionResponse,
  isPlanOptionsMessage,
  isClaudeDiscussionResponse,
} from '../artifact/types';

/**
 * MessageHandler processes incoming IPC messages from the CLI
 * and orchestrates appropriate actions in the extension
 */
export class MessageHandler implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private statusBarItem: vscode.StatusBarItem;

  constructor(
    private readonly ipcClient: IPCClient,
    private readonly artifactManager: ArtifactManager,
    private readonly artifactProvider: ArtifactProvider
  ) {
    // Create status bar item for Claude state
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.statusBarItem.name = 'Claude State';
    this.disposables.push(this.statusBarItem);

    this.setupMessageListener();
    this.setupStateListener();
  }

  /**
   * Set up listener for incoming messages
   */
  private setupMessageListener(): void {
    const messageDisposable = this.ipcClient.onDidReceiveMessage(message => {
      this.handleMessage(message).catch(error => {
        console.error('Error handling message:', error);
        this.ipcClient.sendError('HANDLER_ERROR', error.message, { messageId: message.id });
      });
    });

    this.disposables.push(messageDisposable);
  }

  /**
   * Set up listener for Claude state changes
   */
  private setupStateListener(): void {
    const stateDisposable = this.ipcClient.onDidChangeClaudeState(state => {
      this.handleStateChange(state);
    });

    this.disposables.push(stateDisposable);
  }

  /**
   * Handle an incoming IPC message
   */
  private async handleMessage(message: IPCMessage): Promise<void> {
    console.log('Handling message:', message.type, message.id);

    // Handle extended message types
    const extendedType = (message as any).type;

    switch (extendedType) {
      case 'artifact':
        await this.handleArtifactMessage(message.payload as ArtifactMessage);
        break;

      case 'status':
        // CLI status update - can be logged or used for UI updates
        console.log('CLI status:', message.payload);
        break;

      case 'error':
        // CLI error - show notification
        const errorPayload = message.payload as { code: string; message: string };
        vscode.window.showErrorMessage(`CLI Error [${errorPayload.code}]: ${errorPayload.message}`);
        break;

      case 'state':
        // Claude state update
        this.handleStateChange(message.payload as unknown as ClaudeStateMessage);
        break;

      case 'options':
        // Options for user selection
        await this.handleOptionsMessage(message.payload as unknown as PlanOptionsMessage);
        break;

      case 'discussion-response':
        // Claude's response to a discussion
        await this.handleDiscussionResponse(message.payload as unknown as ClaudeDiscussionResponse);
        break;

      default:
        console.warn('Unknown message type:', extendedType);
    }
  }

  /**
   * Handle Claude state changes
   */
  private handleStateChange(state: ClaudeStateMessage): void {
    // Update status bar
    this.updateStatusBar(state);

    // Update artifact provider
    this.artifactProvider.updateClaudeState(state);

    // Show notification for waiting states
    if (state.state === 'waiting-for-approval') {
      vscode.window.showInformationMessage(
        'Claude is waiting for plan approval',
        'View Plan'
      ).then(action => {
        if (action === 'View Plan') {
          vscode.commands.executeCommand('claudeArtifacts.showPanel');
        }
      });
    }
  }

  /**
   * Update status bar with Claude state
   */
  private updateStatusBar(state: ClaudeStateMessage): void {
    const stateIcons: Record<string, string> = {
      'idle': '$(circle-outline)',
      'thinking': '$(loading~spin)',
      'planning': '$(list-unordered)',
      'executing': '$(debug-start)',
      'waiting-for-input': '$(comment-discussion)',
      'waiting-for-approval': '$(eye)',
      'error': '$(error)',
    };

    const stateColors: Record<string, string> = {
      'idle': 'statusBar.foreground',
      'thinking': 'charts.yellow',
      'planning': 'charts.blue',
      'executing': 'charts.green',
      'waiting-for-input': 'charts.orange',
      'waiting-for-approval': 'charts.purple',
      'error': 'charts.red',
    };

    const icon = stateIcons[state.state] || '$(circle-outline)';
    const description = state.description || state.state;

    this.statusBarItem.text = `${icon} Claude: ${description}`;
    this.statusBarItem.tooltip = `Claude Code State: ${state.state}\n${description}`;

    if (state.state === 'idle') {
      this.statusBarItem.hide();
    } else {
      this.statusBarItem.show();
    }
  }

  /**
   * Handle options message - show options in VS Code
   */
  private async handleOptionsMessage(options: PlanOptionsMessage): Promise<void> {
    console.log('Handling options message:', options.artifactId);

    // Show options in the artifact provider webview
    this.artifactProvider.showOptionsSelector(options);

    // Also show VS Code quick pick as an alternative/fallback
    const items = options.options.map(opt => ({
      label: opt.recommended ? `$(star) ${opt.title}` : opt.title,
      description: opt.description,
      detail: opt.pros?.length ? `Pros: ${opt.pros.join(', ')}` : undefined,
      optionId: opt.id,
    }));

    if (options.allowCustom) {
      items.push({
        label: '$(edit) Custom Response',
        description: 'Type a custom response',
        detail: undefined,
        optionId: '__custom__',
      });
    }

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: options.prompt,
      title: 'Select an Option',
      ignoreFocusOut: true,
    });

    if (selected) {
      if (selected.optionId === '__custom__') {
        const customResponse = await vscode.window.showInputBox({
          prompt: 'Enter your custom response',
          placeHolder: 'Type here...',
          ignoreFocusOut: true,
        });

        if (customResponse) {
          await this.ipcClient.sendOptionSelection(options.artifactId, null, customResponse);
        }
      } else {
        await this.ipcClient.sendOptionSelection(options.artifactId, selected.optionId);
      }

      // Clear the options selector in webview
      this.artifactProvider.clearOptionsSelector();
    }
  }

  /**
   * Handle Claude's discussion response
   */
  private async handleDiscussionResponse(response: ClaudeDiscussionResponse): Promise<void> {
    console.log('Handling discussion response:', response.artifactId, response.threadId);

    // Add Claude's response as a comment (use threadId as sectionId for threading)
    await this.artifactManager.addComment(
      response.artifactId,
      response.response.content,
      'agent',
      { sectionId: response.threadId }
    );

    // Update the artifact provider with revision suggestions
    this.artifactProvider.handleDiscussionResponse(response);

    // Refresh the panel
    const artifact = this.artifactManager.getArtifact(response.artifactId);
    if (artifact) {
      this.artifactProvider.showArtifactPanel(artifact);
    }
  }

  /**
   * Handle artifact-related messages
   */
  private async handleArtifactMessage(message: ArtifactMessage): Promise<void> {
    switch (message.action) {
      case 'create':
        await this.handleCreate(message as ArtifactCreateMessage);
        break;

      case 'update':
        await this.handleUpdate(message as ArtifactUpdateMessage);
        break;

      case 'delete':
        await this.handleDelete(message as ArtifactDeleteMessage);
        break;

      case 'request-review':
        await this.handleRequestReview(message as ArtifactRequestReviewMessage);
        break;

      default:
        console.warn('Unknown artifact action:', (message as any).action);
    }
  }

  /**
   * Handle artifact creation from CLI (uses upsert to preserve IDs)
   */
  private async handleCreate(message: ArtifactCreateMessage): Promise<void> {
    const artifact = message.artifact;

    // Use upsert to preserve the ID from CLI
    const createdArtifact = await this.artifactManager.upsertArtifact(artifact);

    if (createdArtifact) {
      // Show the artifact panel
      this.artifactProvider.showArtifactPanel(createdArtifact);

      // Notify user
      vscode.window.showInformationMessage(`Artifact created: ${artifact.title}`);
    }
  }

  /**
   * Handle artifact update from CLI (with upsert support)
   */
  private async handleUpdate(message: ArtifactUpdateMessage): Promise<void> {
    const { id, ...updates } = message.artifact;
    const existingArtifact = this.artifactManager.getArtifact(id);
    const artifactData = message.artifact as any;

    // Upsert: if artifact doesn't exist and we have type info, create it
    if (!existingArtifact && artifactData.type) {
      console.log('Artifact not found, creating via upsert:', id);
      const newArtifact = await this.artifactManager.upsertArtifact({
        ...artifactData,
        id,
        createdAt: artifactData.createdAt || new Date(),
        updatedAt: new Date(),
        comments: artifactData.comments || [],
      });
      this.artifactProvider.showArtifactPanel(newArtifact);
      vscode.window.showInformationMessage(`Artifact created: ${newArtifact.title}`);
      return;
    }

    if (!existingArtifact) {
      console.warn('Artifact not found for update:', id);
      await this.ipcClient.sendError('ARTIFACT_NOT_FOUND', `Artifact ${id} not found`);
      return;
    }

    // Merge updates with existing artifact
    const mergedArtifact = {
      ...existingArtifact,
      ...updates,
      updatedAt: new Date(),
    };

    await this.artifactManager.upsertArtifact(mergedArtifact as Artifact);

    // Refresh the panel
    const updatedArtifact = this.artifactManager.getArtifact(id);
    if (updatedArtifact) {
      this.artifactProvider.showArtifactPanel(updatedArtifact);
    }

    // Show notification if status changed
    if (updates.status && updates.status !== existingArtifact.status) {
      vscode.window.showInformationMessage(
        `Artifact "${existingArtifact.title}" status: ${updates.status}`
      );
    }
  }

  /**
   * Handle artifact deletion from CLI
   */
  private async handleDelete(message: ArtifactDeleteMessage): Promise<void> {
    const artifact = this.artifactManager.getArtifact(message.artifactId);

    if (!artifact) {
      console.warn('Artifact not found for deletion:', message.artifactId);
      return;
    }

    const title = artifact.title;
    await this.artifactManager.deleteArtifact(message.artifactId);

    vscode.window.showInformationMessage(`Artifact deleted: ${title}`);
  }

  /**
   * Handle review request from CLI
   */
  private async handleRequestReview(message: ArtifactRequestReviewMessage): Promise<void> {
    const artifact = this.artifactManager.getArtifact(message.artifactId);

    if (!artifact) {
      console.warn('Artifact not found for review request:', message.artifactId);
      await this.ipcClient.sendError('ARTIFACT_NOT_FOUND', `Artifact ${message.artifactId} not found`);
      return;
    }

    // Update status to pending-review
    await this.artifactManager.updateStatus(message.artifactId, 'pending-review');

    // Show the artifact panel
    const updatedArtifact = this.artifactManager.getArtifact(message.artifactId);
    if (updatedArtifact) {
      this.artifactProvider.showArtifactPanel(updatedArtifact);
    }

    // Show notification with actions
    const action = await vscode.window.showInformationMessage(
      `Review requested for: ${artifact.title}`,
      'Open',
      'Approve',
      'Later'
    );

    if (action === 'Open' && updatedArtifact) {
      this.artifactProvider.showArtifactPanel(updatedArtifact);
    } else if (action === 'Approve') {
      await this.artifactManager.updateStatus(message.artifactId, 'approved');
      await this.ipcClient.sendFeedback({
        artifactId: message.artifactId,
        action: 'proceed',
      });
    }
  }

  /**
   * Dispose of resources
   */
  public dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }
}
