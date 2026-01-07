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
} from '../artifact/types';

/**
 * MessageHandler processes incoming IPC messages from the CLI
 * and orchestrates appropriate actions in the extension
 */
export class MessageHandler implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly ipcClient: IPCClient,
    private readonly artifactManager: ArtifactManager,
    private readonly artifactProvider: ArtifactProvider
  ) {
    this.setupMessageListener();
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
   * Handle an incoming IPC message
   */
  private async handleMessage(message: IPCMessage): Promise<void> {
    console.log('Handling message:', message.type, message.id);

    switch (message.type) {
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

      default:
        console.warn('Unknown message type:', message.type);
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
   * Handle artifact creation from CLI
   */
  private async handleCreate(message: ArtifactCreateMessage): Promise<void> {
    const artifact = message.artifact;
    let createdArtifact: Artifact | undefined;

    switch (artifact.type) {
      case 'task-list':
        createdArtifact = await this.artifactManager.createTaskList(artifact.title);
        // Update with full data
        if (createdArtifact) {
          const taskListData = artifact as TaskListArtifact;
          await this.artifactManager.updateArtifact(createdArtifact.id, {
            items: taskListData.items || [],
            status: taskListData.status,
          });
        }
        break;

      case 'implementation-plan':
        const planData = artifact as ImplementationPlanArtifact;
        createdArtifact = await this.artifactManager.createImplementationPlan(
          artifact.title,
          planData.summary || ''
        );
        if (createdArtifact) {
          await this.artifactManager.updateArtifact(createdArtifact.id, {
            sections: planData.sections || [],
            estimatedChanges: planData.estimatedChanges || 0,
            status: planData.status,
          });
        }
        break;

      case 'walkthrough':
        const walkthroughData = artifact as WalkthroughArtifact;
        createdArtifact = await this.artifactManager.createWalkthrough(
          artifact.title,
          walkthroughData.summary || ''
        );
        if (createdArtifact) {
          await this.artifactManager.updateArtifact(createdArtifact.id, {
            sections: walkthroughData.sections || [],
            changedFiles: walkthroughData.changedFiles || [],
            keyPoints: walkthroughData.keyPoints || [],
            status: walkthroughData.status,
          });
        }
        break;
    }

    if (createdArtifact) {
      // Show the artifact panel
      const updatedArtifact = this.artifactManager.getArtifact(createdArtifact.id);
      if (updatedArtifact) {
        this.artifactProvider.showArtifactPanel(updatedArtifact);
      }

      // Notify user
      vscode.window.showInformationMessage(`Artifact created: ${artifact.title}`);
    }
  }

  /**
   * Handle artifact update from CLI
   */
  private async handleUpdate(message: ArtifactUpdateMessage): Promise<void> {
    const { id, ...updates } = message.artifact;
    const artifact = this.artifactManager.getArtifact(id);

    if (!artifact) {
      console.warn('Artifact not found for update:', id);
      await this.ipcClient.sendError('ARTIFACT_NOT_FOUND', `Artifact ${id} not found`);
      return;
    }

    await this.artifactManager.updateArtifact(id, updates);

    // Show notification if status changed
    if (updates.status && updates.status !== artifact.status) {
      vscode.window.showInformationMessage(
        `Artifact "${artifact.title}" status: ${updates.status}`
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
