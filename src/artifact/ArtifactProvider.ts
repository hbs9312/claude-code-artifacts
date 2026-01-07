import * as vscode from 'vscode';
import { ArtifactManager } from './ArtifactManager';
import {
  Artifact,
  FeedbackMessage,
  TaskCategory,
  TaskStatus,
  CommentThread,
  ClaudeStateMessage,
  PlanOptionsMessage,
  ClaudeDiscussionResponse,
  PlanRevision,
} from './types';
import { TaskListProvider } from '../providers/TaskListProvider';
import { ImplPlanProvider } from '../providers/ImplPlanProvider';
import { WalkthroughProvider } from '../providers/WalkthroughProvider';
import { CommentController } from '../comments/CommentController';
import { getCommentStyles } from '../comments/CommentThread';

/**
 * ArtifactProvider manages the Webview panel for displaying artifacts
 */
export class ArtifactProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'claudeArtifacts.artifactPanel';

  private _view?: vscode.WebviewView;
  private _panel?: vscode.WebviewPanel;
  private _currentArtifact?: Artifact;

  private readonly _onDidSendFeedback = new vscode.EventEmitter<FeedbackMessage>();
  public readonly onDidSendFeedback = this._onDidSendFeedback.event;

  // Type-specific providers
  private taskListProvider: TaskListProvider;
  private implPlanProvider: ImplPlanProvider;
  private walkthroughProvider: WalkthroughProvider;
  private commentController: CommentController;

  // Real-time sync state
  private currentClaudeState: ClaudeStateMessage | null = null;
  private pendingOptions: PlanOptionsMessage | null = null;
  private pendingRevisions: PlanRevision[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly artifactManager: ArtifactManager
  ) {
    // Initialize type-specific providers
    this.taskListProvider = new TaskListProvider(artifactManager);
    this.implPlanProvider = new ImplPlanProvider(artifactManager);
    this.walkthroughProvider = new WalkthroughProvider(artifactManager);
    this.commentController = new CommentController(artifactManager);

    // Listen for artifact updates
    artifactManager.onDidUpdateArtifact(artifact => {
      if (this._currentArtifact?.id === artifact.id) {
        this._currentArtifact = artifact;
        this.updateWebview();
      }
    });
  }

  // Expose providers for external use
  public getTaskListProvider(): TaskListProvider {
    return this.taskListProvider;
  }

  public getImplPlanProvider(): ImplPlanProvider {
    return this.implPlanProvider;
  }

  public getWalkthroughProvider(): WalkthroughProvider {
    return this.walkthroughProvider;
  }

  public getCommentController(): CommentController {
    return this.commentController;
  }

  // ============ Real-time Sync Methods ============

  /**
   * Update Claude state and refresh UI
   */
  public updateClaudeState(state: ClaudeStateMessage): void {
    this.currentClaudeState = state;
    this.updateWebview();
  }

  /**
   * Show options selector in webview
   */
  public showOptionsSelector(options: PlanOptionsMessage): void {
    this.pendingOptions = options;
    this.updateWebview();
  }

  /**
   * Clear options selector
   */
  public clearOptionsSelector(): void {
    this.pendingOptions = null;
    this.updateWebview();
  }

  /**
   * Handle discussion response from Claude
   */
  public handleDiscussionResponse(response: ClaudeDiscussionResponse): void {
    if (response.response.suggestedRevisions && response.response.suggestedRevisions.length > 0) {
      this.pendingRevisions = response.response.suggestedRevisions;
    }
    this.updateWebview();
  }

  /**
   * Clear pending revisions
   */
  public clearPendingRevisions(): void {
    this.pendingRevisions = [];
    this.updateWebview();
  }

  /**
   * Called when the webview view is resolved
   */
  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtmlContent(webviewView.webview);

    this.setupMessageHandler(webviewView.webview);
  }

  /**
   * Show artifact in a separate panel
   */
  public showArtifactPanel(artifact: Artifact): void {
    this._currentArtifact = artifact;

    if (this._panel) {
      this._panel.reveal(vscode.ViewColumn.Beside);
    } else {
      this._panel = vscode.window.createWebviewPanel(
        'artifactView',
        `Artifact: ${artifact.title}`,
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [this.extensionUri],
        }
      );

      this._panel.onDidDispose(() => {
        this._panel = undefined;
      });
    }

    // Always setup message handler when showing artifact
    this.setupMessageHandler(this._panel.webview);

    this._panel.title = `Artifact: ${artifact.title}`;
    this._panel.webview.html = this.getHtmlContent(this._panel.webview, artifact);
  }

  /**
   * Update the webview content
   */
  private updateWebview(): void {
    if (this._panel && this._currentArtifact) {
      // Re-render the entire webview with updated artifact
      this._panel.webview.html = this.getHtmlContent(this._panel.webview, this._currentArtifact);
    } else if (this._view && this._currentArtifact) {
      this._view.webview.html = this.getHtmlContent(this._view.webview, this._currentArtifact);
    }
  }

  /**
   * Setup message handler for webview communication
   */
  private setupMessageHandler(webview: vscode.Webview): void {
    webview.onDidReceiveMessage(async message => {
      console.log('Received message from webview:', message);

      switch (message.type) {
        case 'proceed':
          await this.handleProceed(message.artifactId);
          break;

        case 'reject':
          await this.handleReject(message.artifactId, message.reason);
          break;

        case 'addComment':
          await this.handleAddComment(
            message.artifactId,
            message.content,
            message.lineNumber,
            message.sectionId
          );
          break;

        case 'resolveComment':
          await this.handleResolveComment(message.artifactId, message.commentId);
          break;

        case 'submitReview':
          await this.handleSubmitReview(message.artifactId, message.feedback);
          break;

        case 'openFile':
          await this.handleOpenFile(message.filePath);
          break;

        // Task List operations
        case 'addTask':
          await this.handleAddTask(message.artifactId, message.text, message.category);
          break;

        case 'updateTaskStatus':
          await this.handleUpdateTaskStatus(message.artifactId, message.taskId, message.status);
          break;

        case 'deleteTask':
          await this.handleDeleteTask(message.artifactId, message.taskId);
          break;

        case 'editTask':
          await this.handleEditTask(message.artifactId, message.taskId, message.text);
          break;

        // Implementation Plan operations
        case 'addSection':
          await this.handleAddSection(message.artifactId, message.title, message.description);
          break;

        case 'updateSection':
          await this.handleUpdateSection(message.artifactId, message.sectionId, message.title, message.description);
          break;

        case 'deleteSection':
          await this.handleDeleteSection(message.artifactId, message.sectionId);
          break;

        case 'addFileChange':
          await this.handleAddFileChange(
            message.artifactId,
            message.sectionId,
            message.filePath,
            message.changeType,
            message.description
          );
          break;

        case 'removeFileChange':
          await this.handleRemoveFileChange(message.artifactId, message.sectionId, message.filePath);
          break;

        case 'requestReview':
          await this.handleRequestReview(message.artifactId);
          break;

        // Walkthrough operations
        case 'addKeyPoint':
          await this.handleAddKeyPoint(message.artifactId, message.keyPoint);
          break;

        case 'removeKeyPoint':
          await this.handleRemoveKeyPoint(message.artifactId, message.index);
          break;

        case 'addWalkthroughSection':
          await this.handleAddWalkthroughSection(message.artifactId, message.title, message.content);
          break;

        case 'updateWalkthroughSection':
          await this.handleUpdateWalkthroughSection(
            message.artifactId,
            message.sectionId,
            message.title,
            message.content
          );
          break;

        case 'deleteWalkthroughSection':
          await this.handleDeleteWalkthroughSection(message.artifactId, message.sectionId);
          break;

        case 'addChangedFile':
          await this.handleAddChangedFile(
            message.artifactId,
            message.filePath,
            message.changeType,
            message.linesAdded,
            message.linesRemoved,
            message.summary
          );
          break;

        case 'removeChangedFile':
          await this.handleRemoveChangedFile(message.artifactId, message.filePath);
          break;

        // Comment operations
        case 'deleteComment':
          await this.handleDeleteComment(message.artifactId, message.commentId);
          break;

        case 'resolveThread':
          await this.handleResolveThread(message.artifactId, message.sectionId, message.lineNumber);
          break;

        case 'replyToThread':
          await this.handleReplyToThread(
            message.artifactId,
            message.content,
            message.sectionId,
            message.lineNumber
          );
          break;

        // Option selection
        case 'selectOption':
          await this.handleSelectOption(message.artifactId, message.optionId);
          break;

        case 'submitCustomOption':
          await this.handleSubmitCustomOption(message.artifactId, message.customResponse);
          break;

        // Revision handling
        case 'applyRevision':
          await this.handleApplyRevision(message.artifactId, message.revisionIndex);
          break;

        case 'dismissRevision':
          await this.handleDismissRevision(message.artifactId, message.revisionIndex);
          break;

        case 'applyAllRevisions':
          await this.handleApplyAllRevisions(message.artifactId);
          break;

        case 'dismissAllRevisions':
          await this.handleDismissAllRevisions(message.artifactId);
          break;

        // Ask Claude
        case 'askClaude':
          await this.handleAskClaude(message.artifactId, message.threadId, message.sectionId);
          break;
      }
    });
  }

  // ============ Option Selection Handlers ============

  private readonly _onOptionSelected = new vscode.EventEmitter<{
    artifactId: string;
    optionId: string | null;
    customResponse?: string;
  }>();
  public readonly onOptionSelected = this._onOptionSelected.event;

  private async handleSelectOption(artifactId: string, optionId: string): Promise<void> {
    this._onOptionSelected.fire({ artifactId, optionId, customResponse: undefined });
    this.pendingOptions = null;
    this.updateWebview();
  }

  private async handleSubmitCustomOption(artifactId: string, customResponse: string): Promise<void> {
    this._onOptionSelected.fire({ artifactId, optionId: null, customResponse });
    this.pendingOptions = null;
    this.updateWebview();
  }

  // ============ Revision Handlers ============

  private async handleApplyRevision(artifactId: string, revisionIndex: number): Promise<void> {
    const revision = this.pendingRevisions[revisionIndex];
    if (!revision) return;

    // Apply the revision to the artifact
    // This would update the section with the proposed content
    if (revision.revisionType === 'modify' || revision.revisionType === 'add') {
      await this.implPlanProvider.updateSection(artifactId, revision.sectionId, {
        description: revision.proposedContent,
      });
    } else if (revision.revisionType === 'remove') {
      await this.implPlanProvider.deleteSection(artifactId, revision.sectionId);
    }

    // Remove the revision from pending
    this.pendingRevisions.splice(revisionIndex, 1);
    this.updateWebview();

    vscode.window.showInformationMessage('Revision applied successfully.');
  }

  private async handleDismissRevision(artifactId: string, revisionIndex: number): Promise<void> {
    this.pendingRevisions.splice(revisionIndex, 1);
    this.updateWebview();
  }

  private async handleApplyAllRevisions(artifactId: string): Promise<void> {
    for (const revision of this.pendingRevisions) {
      if (revision.revisionType === 'modify' || revision.revisionType === 'add') {
        await this.implPlanProvider.updateSection(artifactId, revision.sectionId, {
          description: revision.proposedContent,
        });
      } else if (revision.revisionType === 'remove') {
        await this.implPlanProvider.deleteSection(artifactId, revision.sectionId);
      }
    }

    this.pendingRevisions = [];
    this.updateWebview();

    vscode.window.showInformationMessage('All revisions applied successfully.');
  }

  private async handleDismissAllRevisions(_artifactId: string): Promise<void> {
    this.pendingRevisions = [];
    this.updateWebview();
  }

  // ============ Ask Claude Handler ============

  private readonly _onAskClaude = new vscode.EventEmitter<{
    artifactId: string;
    threadId: string;
    sectionId?: string;
  }>();
  public readonly onAskClaude = this._onAskClaude.event;

  private async handleAskClaude(artifactId: string, threadId: string, sectionId?: string): Promise<void> {
    this._onAskClaude.fire({ artifactId, threadId, sectionId });
    vscode.window.showInformationMessage('Asking Claude for a response...');
  }

  /**
   * Handle proceed action
   */
  private async handleProceed(artifactId: string): Promise<void> {
    await this.artifactManager.updateStatus(artifactId, 'approved');

    this._onDidSendFeedback.fire({
      artifactId,
      action: 'proceed',
    });

    vscode.window.showInformationMessage('Artifact approved. Proceeding with execution.');
  }

  /**
   * Handle reject action
   */
  private async handleReject(artifactId: string, reason?: string): Promise<void> {
    await this.artifactManager.updateStatus(artifactId, 'draft');

    this._onDidSendFeedback.fire({
      artifactId,
      action: 'reject',
      reason,
    });

    vscode.window.showWarningMessage('Plan rejected. Claude Code will stop.');
  }

  /**
   * Handle add comment
   */
  private async handleAddComment(
    artifactId: string,
    content: string,
    lineNumber?: number,
    sectionId?: string
  ): Promise<void> {
    await this.artifactManager.addComment(artifactId, content, 'user', {
      lineNumber,
      sectionId,
    });
  }

  /**
   * Handle resolve comment
   */
  private async handleResolveComment(artifactId: string, commentId: string): Promise<void> {
    await this.artifactManager.resolveComment(artifactId, commentId);
  }

  /**
   * Handle submit review
   */
  private async handleSubmitReview(artifactId: string, feedback?: string): Promise<void> {
    const artifact = this.artifactManager.getArtifact(artifactId);
    if (!artifact) {
      return;
    }

    const unresolvedComments = artifact.comments.filter(c => !c.resolved);

    this._onDidSendFeedback.fire({
      artifactId,
      action: 'review-submitted',
      comments: unresolvedComments,
      feedback,
    });

    vscode.window.showInformationMessage('Review submitted to agent.');
  }

  /**
   * Handle open file
   */
  private async handleOpenFile(filePath: string): Promise<void> {
    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (workspaceFolder) {
        const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, filePath);
        const doc = await vscode.workspace.openTextDocument(fileUri);
        await vscode.window.showTextDocument(doc);
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Could not open file: ${filePath}`);
    }
  }

  // ============ Task List Handlers ============

  /**
   * Handle add task
   */
  private async handleAddTask(
    artifactId: string,
    text: string,
    category: TaskCategory = 'other'
  ): Promise<void> {
    await this.taskListProvider.addTask(artifactId, text, category);
  }

  /**
   * Handle update task status
   */
  private async handleUpdateTaskStatus(
    artifactId: string,
    taskId: string,
    status: TaskStatus
  ): Promise<void> {
    await this.taskListProvider.updateTaskStatus(artifactId, taskId, status);
  }

  /**
   * Handle delete task
   */
  private async handleDeleteTask(artifactId: string, taskId: string): Promise<void> {
    await this.taskListProvider.deleteTask(artifactId, taskId);
  }

  /**
   * Handle edit task text
   */
  private async handleEditTask(artifactId: string, taskId: string, text: string): Promise<void> {
    await this.taskListProvider.updateTask(artifactId, taskId, { text });
  }

  // ============ Implementation Plan Handlers ============

  /**
   * Handle add section to plan
   */
  private async handleAddSection(
    artifactId: string,
    title: string,
    description: string = ''
  ): Promise<void> {
    await this.implPlanProvider.addSection(artifactId, title, description);
  }

  /**
   * Handle update section
   */
  private async handleUpdateSection(
    artifactId: string,
    sectionId: string,
    title: string,
    description: string
  ): Promise<void> {
    await this.implPlanProvider.updateSection(artifactId, sectionId, { title, description });
  }

  /**
   * Handle delete section
   */
  private async handleDeleteSection(artifactId: string, sectionId: string): Promise<void> {
    await this.implPlanProvider.deleteSection(artifactId, sectionId);
  }

  /**
   * Handle add file change to section
   */
  private async handleAddFileChange(
    artifactId: string,
    sectionId: string,
    filePath: string,
    changeType: 'create' | 'modify' | 'delete',
    description: string = ''
  ): Promise<void> {
    await this.implPlanProvider.addFileChange(artifactId, sectionId, filePath, changeType, description);
  }

  /**
   * Handle remove file change from section
   */
  private async handleRemoveFileChange(
    artifactId: string,
    sectionId: string,
    filePath: string
  ): Promise<void> {
    await this.implPlanProvider.removeFileChange(artifactId, sectionId, filePath);
  }

  /**
   * Handle request review for plan
   */
  private async handleRequestReview(artifactId: string): Promise<void> {
    await this.implPlanProvider.requestReview(artifactId);
    vscode.window.showInformationMessage('Review requested for implementation plan.');
  }

  // ============ Walkthrough Handlers ============

  /**
   * Handle add key point
   */
  private async handleAddKeyPoint(artifactId: string, keyPoint: string): Promise<void> {
    await this.walkthroughProvider.addKeyPoint(artifactId, keyPoint);
  }

  /**
   * Handle remove key point
   */
  private async handleRemoveKeyPoint(artifactId: string, index: number): Promise<void> {
    await this.walkthroughProvider.removeKeyPoint(artifactId, index);
  }

  /**
   * Handle add walkthrough section
   */
  private async handleAddWalkthroughSection(
    artifactId: string,
    title: string,
    content: string = ''
  ): Promise<void> {
    await this.walkthroughProvider.addSection(artifactId, title, content);
  }

  /**
   * Handle update walkthrough section
   */
  private async handleUpdateWalkthroughSection(
    artifactId: string,
    sectionId: string,
    title: string,
    content: string
  ): Promise<void> {
    await this.walkthroughProvider.updateSection(artifactId, sectionId, { title, content });
  }

  /**
   * Handle delete walkthrough section
   */
  private async handleDeleteWalkthroughSection(artifactId: string, sectionId: string): Promise<void> {
    await this.walkthroughProvider.deleteSection(artifactId, sectionId);
  }

  /**
   * Handle add changed file to walkthrough
   */
  private async handleAddChangedFile(
    artifactId: string,
    filePath: string,
    changeType: 'create' | 'modify' | 'delete',
    linesAdded: number = 0,
    linesRemoved: number = 0,
    summary: string = ''
  ): Promise<void> {
    await this.walkthroughProvider.addChangedFile(
      artifactId,
      filePath,
      changeType,
      linesAdded,
      linesRemoved,
      summary
    );
  }

  /**
   * Handle remove changed file from walkthrough
   */
  private async handleRemoveChangedFile(artifactId: string, filePath: string): Promise<void> {
    await this.walkthroughProvider.removeChangedFile(artifactId, filePath);
  }

  // ============ Comment Handlers ============

  /**
   * Handle delete comment
   */
  private async handleDeleteComment(artifactId: string, commentId: string): Promise<void> {
    await this.commentController.deleteComment(artifactId, commentId);
  }

  /**
   * Handle resolve thread
   */
  private async handleResolveThread(
    artifactId: string,
    sectionId?: string | null,
    lineNumber?: string | number | null
  ): Promise<void> {
    await this.commentController.resolveThread(
      artifactId,
      sectionId || undefined,
      lineNumber !== undefined && lineNumber !== null && lineNumber !== '' ? parseInt(String(lineNumber)) : undefined
    );
  }

  /**
   * Handle reply to thread
   */
  private async handleReplyToThread(
    artifactId: string,
    content: string,
    sectionId?: string | null,
    lineNumber?: string | number | null
  ): Promise<void> {
    if (!content.trim()) {
      return;
    }
    await this.commentController.addComment(artifactId, content.trim(), 'user', {
      sectionId: sectionId || undefined,
      lineNumber: lineNumber !== undefined && lineNumber !== null && lineNumber !== '' ? parseInt(String(lineNumber)) : undefined,
    });
  }

  /**
   * Generate HTML content for the webview
   */
  private getHtmlContent(webview: vscode.Webview, artifact?: Artifact): string {
    const nonce = getNonce();

    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'src', 'webview', 'styles.css')
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Claude Artifacts</title>
  <style>
    :root {
      --vscode-font-family: var(--vscode-editor-font-family, 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif);
    }

    * {
      box-sizing: border-box;
    }

    body {
      font-family: var(--vscode-font-family);
      padding: 16px;
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
      line-height: 1.6;
    }

    .artifact-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .artifact-title {
      font-size: 1.4em;
      font-weight: 600;
      margin: 0;
    }

    .artifact-type {
      font-size: 0.75em;
      padding: 2px 8px;
      border-radius: 12px;
      background-color: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      text-transform: uppercase;
    }

    .artifact-status {
      font-size: 0.8em;
      padding: 4px 12px;
      border-radius: 4px;
      margin-left: 8px;
    }

    .status-draft { background-color: var(--vscode-inputValidation-infoBackground); }
    .status-pending-review { background-color: var(--vscode-inputValidation-warningBackground); }
    .status-approved { background-color: var(--vscode-testing-iconPassed); color: white; }
    .status-completed { background-color: var(--vscode-testing-iconPassed); color: white; }

    .artifact-content {
      margin-bottom: 20px;
    }

    .section {
      margin-bottom: 16px;
      padding: 12px;
      background-color: var(--vscode-editor-inactiveSelectionBackground);
      border-radius: 6px;
    }

    .section-title {
      font-weight: 600;
      margin-bottom: 8px;
    }

    .task-item {
      display: flex;
      align-items: center;
      padding: 8px 0;
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .task-item:last-child {
      border-bottom: none;
    }

    .task-status {
      width: 20px;
      height: 20px;
      margin-right: 12px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
    }

    .task-pending { background-color: var(--vscode-inputValidation-infoBackground); }
    .task-in-progress { background-color: var(--vscode-inputValidation-warningBackground); }
    .task-completed { background-color: var(--vscode-testing-iconPassed); color: white; }

    .task-category {
      font-size: 0.7em;
      padding: 2px 6px;
      border-radius: 4px;
      background-color: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      margin-left: auto;
    }

    .file-change {
      display: flex;
      align-items: center;
      padding: 6px 8px;
      margin: 4px 0;
      background-color: var(--vscode-editor-background);
      border-radius: 4px;
      cursor: pointer;
    }

    .file-change:hover {
      background-color: var(--vscode-list-hoverBackground);
    }

    .file-change-icon {
      margin-right: 8px;
    }

    .change-create { color: var(--vscode-testing-iconPassed); }
    .change-modify { color: var(--vscode-inputValidation-warningBackground); }
    .change-delete { color: var(--vscode-testing-iconFailed); }

    .actions {
      display: flex;
      gap: 12px;
      margin-top: 20px;
      padding-top: 16px;
      border-top: 1px solid var(--vscode-panel-border);
    }

    button {
      padding: 8px 16px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
      transition: opacity 0.2s;
    }

    button:hover {
      opacity: 0.9;
    }

    .btn-primary {
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }

    .btn-secondary {
      background-color: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }

    .btn-danger {
      background-color: var(--vscode-testing-iconFailed);
      color: white;
    }

    .comments-section {
      margin-top: 20px;
    }

    .comment {
      padding: 10px;
      margin: 8px 0;
      background-color: var(--vscode-editor-inactiveSelectionBackground);
      border-radius: 6px;
      border-left: 3px solid var(--vscode-button-background);
    }

    .comment.resolved {
      opacity: 0.6;
      border-left-color: var(--vscode-testing-iconPassed);
    }

    .comment-header {
      display: flex;
      justify-content: space-between;
      font-size: 0.85em;
      margin-bottom: 6px;
      color: var(--vscode-descriptionForeground);
    }

    .comment-content {
      white-space: pre-wrap;
    }

    .add-comment {
      margin-top: 12px;
    }

    .add-comment textarea {
      width: 100%;
      min-height: 80px;
      padding: 8px;
      border: 1px solid var(--vscode-input-border);
      background-color: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 4px;
      resize: vertical;
      font-family: inherit;
    }

    .add-comment-actions {
      display: flex;
      justify-content: flex-end;
      margin-top: 8px;
    }

    .empty-state {
      text-align: center;
      padding: 40px 20px;
      color: var(--vscode-descriptionForeground);
    }

    .empty-state-icon {
      font-size: 48px;
      margin-bottom: 16px;
    }

    .key-points {
      list-style: none;
      padding: 0;
    }

    .key-points li {
      padding: 6px 0;
      padding-left: 20px;
      position: relative;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .key-points li::before {
      content: "\\2713";
      position: absolute;
      left: 0;
      color: var(--vscode-testing-iconPassed);
    }

    /* Progress bar */
    .progress-bar-container {
      position: relative;
      height: 24px;
      background-color: var(--vscode-editor-inactiveSelectionBackground);
      border-radius: 4px;
      margin-bottom: 16px;
      overflow: hidden;
    }

    .progress-bar {
      height: 100%;
      background-color: var(--vscode-testing-iconPassed);
      transition: width 0.3s ease;
    }

    .progress-text {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      font-size: 12px;
      font-weight: 600;
    }

    /* Task status buttons */
    .task-status-buttons {
      display: flex;
      gap: 4px;
      margin-right: 12px;
    }

    .task-status-btn {
      width: 24px;
      height: 24px;
      padding: 0;
      border-radius: 50%;
      font-size: 14px;
      background-color: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .task-status-btn.active {
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }

    .task-text.completed {
      text-decoration: line-through;
      opacity: 0.7;
    }

    .task-delete-btn, .remove-btn, .section-delete-btn, .file-remove-btn {
      width: 20px;
      height: 20px;
      padding: 0;
      margin-left: 8px;
      border-radius: 50%;
      font-size: 14px;
      background-color: transparent;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
    }

    .task-delete-btn:hover, .remove-btn:hover, .section-delete-btn:hover, .file-remove-btn:hover {
      background-color: var(--vscode-testing-iconFailed);
      color: white;
    }

    /* Forms */
    .add-task-form, .add-section-form, .add-key-point-form, .add-file-change-form, .add-changed-file-form {
      display: flex;
      gap: 8px;
      margin-top: 12px;
      padding: 12px;
      background-color: var(--vscode-editor-inactiveSelectionBackground);
      border-radius: 6px;
      flex-wrap: wrap;
    }

    .add-task-form input, .add-section-form input, .add-key-point-form input,
    .add-file-change-form input, .add-changed-file-form input {
      flex: 1;
      min-width: 150px;
      padding: 6px 10px;
      border: 1px solid var(--vscode-input-border);
      background-color: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 4px;
    }

    .add-section-form textarea, .add-changed-file-form textarea {
      width: 100%;
      min-height: 60px;
      padding: 8px;
      border: 1px solid var(--vscode-input-border);
      background-color: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 4px;
      resize: vertical;
      font-family: inherit;
    }

    select {
      padding: 6px 10px;
      border: 1px solid var(--vscode-input-border);
      background-color: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 4px;
    }

    .btn-small {
      padding: 6px 12px;
      font-size: 12px;
    }

    /* Stats */
    .plan-stats, .walkthrough-stats {
      display: flex;
      gap: 16px;
      margin-bottom: 16px;
      padding: 8px 12px;
      background-color: var(--vscode-editor-inactiveSelectionBackground);
      border-radius: 4px;
    }

    .stat {
      font-size: 0.9em;
    }

    .stat.create, .stat.add { color: var(--vscode-testing-iconPassed); }
    .stat.modify { color: var(--vscode-inputValidation-warningBackground); }
    .stat.delete, .stat.remove { color: var(--vscode-testing-iconFailed); }

    /* Section header */
    .section-header {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .section-header .section-title {
      flex: 1;
    }

    /* File changes */
    .file-path {
      cursor: pointer;
      flex: 1;
    }

    .file-path:hover {
      text-decoration: underline;
    }

    .file-description {
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
      margin-left: 8px;
    }

    .file-stats {
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
      margin-left: auto;
      margin-right: 8px;
    }

    input[type="number"] {
      width: 80px;
    }

    /* Comment Thread Styles */
    .comment-thread {
      margin-bottom: 16px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      overflow: hidden;
    }

    .comment-thread.thread-resolved {
      opacity: 0.7;
    }

    .thread-header {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px 12px;
      background-color: var(--vscode-editor-inactiveSelectionBackground);
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .thread-location {
      font-size: 0.85em;
      font-weight: 500;
      color: var(--vscode-descriptionForeground);
    }

    .thread-count {
      font-size: 0.8em;
      color: var(--vscode-descriptionForeground);
    }

    .thread-resolve-btn {
      margin-left: auto;
      padding: 2px 8px;
      font-size: 0.75em;
    }

    .thread-status-resolved {
      font-size: 0.75em;
      color: var(--vscode-testing-iconPassed);
      margin-left: auto;
    }

    .thread-comments {
      padding: 8px;
    }

    .thread-reply {
      display: flex;
      gap: 8px;
      padding: 8px;
      border-top: 1px solid var(--vscode-panel-border);
      background-color: var(--vscode-editor-background);
    }

    .reply-input {
      flex: 1;
      min-height: 36px;
      padding: 6px 8px;
      border: 1px solid var(--vscode-input-border);
      background-color: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 4px;
      resize: none;
      font-family: inherit;
      font-size: 0.9em;
    }

    .comment-author-user {
      color: var(--vscode-button-background);
    }

    .comment-author-agent {
      color: var(--vscode-testing-iconPassed);
    }

    .comment-stats-bar {
      display: flex;
      gap: 16px;
      padding: 8px 12px;
      background-color: var(--vscode-editor-inactiveSelectionBackground);
      border-radius: 4px;
      margin-bottom: 12px;
    }

    .comment-stats-bar .stat-item {
      display: flex;
      align-items: baseline;
      gap: 4px;
    }

    .comment-stats-bar .stat-value {
      font-weight: 600;
    }

    .comment-stats-bar .stat-label {
      font-size: 0.8em;
      color: var(--vscode-descriptionForeground);
    }

    .comment-stats-bar .unresolved .stat-value {
      color: var(--vscode-inputValidation-warningBackground);
    }

    .comment-stats-bar .resolved .stat-value {
      color: var(--vscode-testing-iconPassed);
    }

    .comments-filter {
      display: flex;
      gap: 8px;
      margin-bottom: 12px;
    }

    .filter-btn {
      padding: 4px 12px;
      font-size: 0.85em;
      background-color: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
    }

    .filter-btn.active {
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }

    .inline-comment-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 6px;
      background: transparent;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.8em;
      color: var(--vscode-descriptionForeground);
    }

    .inline-comment-btn:hover {
      background-color: var(--vscode-button-secondaryBackground);
    }

    .inline-comment-btn.has-comments {
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-color: var(--vscode-button-background);
    }

    .threads-container {
      max-height: 400px;
      overflow-y: auto;
    }

    /* Claude State Indicator */
    .claude-state-indicator {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
      background: var(--vscode-editor-inactiveSelectionBackground);
      border-radius: 6px;
      margin-bottom: 16px;
    }

    .claude-state-indicator .state-icon {
      font-size: 18px;
    }

    .claude-state-indicator .state-label {
      font-weight: 500;
    }

    .claude-state-indicator .state-progress {
      flex: 1;
      max-width: 150px;
      height: 6px;
      background: var(--vscode-progressBar-background);
      border-radius: 3px;
      overflow: hidden;
      position: relative;
    }

    .claude-state-indicator .progress-label {
      font-size: 0.8em;
      color: var(--vscode-descriptionForeground);
      margin-left: 8px;
    }

    /* Options Selector */
    .options-selector {
      border: 2px solid var(--vscode-button-background);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 20px;
      background: var(--vscode-editor-inactiveSelectionBackground);
    }

    .options-header h3 {
      margin: 0 0 8px 0;
      color: var(--vscode-button-background);
    }

    .options-prompt {
      margin: 0 0 16px 0;
      color: var(--vscode-descriptionForeground);
    }

    .options-list {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .option-card {
      padding: 12px 16px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.2s;
      background: var(--vscode-editor-background);
    }

    .option-card:hover {
      background: var(--vscode-list-hoverBackground);
      border-color: var(--vscode-button-background);
    }

    .option-card.recommended {
      border-color: var(--vscode-testing-iconPassed);
      border-width: 2px;
    }

    .option-card .option-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 6px;
    }

    .option-card .option-title {
      font-weight: 600;
    }

    .recommended-badge {
      background: var(--vscode-testing-iconPassed);
      color: white;
      padding: 2px 6px;
      border-radius: 10px;
      font-size: 0.7em;
    }

    .effort-badge {
      padding: 2px 6px;
      border-radius: 10px;
      font-size: 0.7em;
    }

    .effort-low { background: var(--vscode-testing-iconPassed); color: white; }
    .effort-medium { background: var(--vscode-charts-yellow); color: black; }
    .effort-high { background: var(--vscode-charts-red); color: white; }

    .option-description {
      margin: 0;
      color: var(--vscode-descriptionForeground);
      font-size: 0.9em;
    }

    .option-pros, .option-cons {
      margin-top: 8px;
      font-size: 0.85em;
    }

    .option-pros ul, .option-cons ul {
      margin: 4px 0 0 0;
      padding-left: 20px;
    }

    .option-pros { color: var(--vscode-testing-iconPassed); }
    .option-cons { color: var(--vscode-charts-red); }

    .custom-option {
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid var(--vscode-panel-border);
    }

    .custom-option textarea {
      width: 100%;
      min-height: 60px;
      margin-bottom: 8px;
    }

    /* Pending Revisions */
    .pending-revisions {
      border: 2px dashed var(--vscode-charts-orange);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 20px;
      background: rgba(255, 165, 0, 0.05);
    }

    .pending-revisions h3 {
      margin: 0 0 8px 0;
      color: var(--vscode-charts-orange);
    }

    .revision-list {
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin-top: 12px;
    }

    .revision-suggestion {
      padding: 12px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      background: var(--vscode-editor-background);
    }

    .revision-header {
      display: flex;
      gap: 8px;
      margin-bottom: 8px;
    }

    .revision-type {
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 0.75em;
      font-weight: 600;
    }

    .revision-modify { background: var(--vscode-charts-yellow); color: black; }
    .revision-add { background: var(--vscode-testing-iconPassed); color: white; }
    .revision-remove { background: var(--vscode-charts-red); color: white; }

    .revision-reason {
      font-size: 0.9em;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 8px;
    }

    .revision-content pre {
      padding: 8px;
      background: var(--vscode-editor-inactiveSelectionBackground);
      border-radius: 4px;
      overflow-x: auto;
      font-size: 0.85em;
    }

    .revision-original {
      margin-bottom: 8px;
    }

    .revision-actions {
      display: flex;
      gap: 8px;
      margin-top: 12px;
    }

    .revision-bulk-actions {
      display: flex;
      gap: 8px;
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid var(--vscode-panel-border);
    }

    /* Ask Claude Button */
    .ask-claude-btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 4px 8px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.8em;
      margin-left: 8px;
    }

    .ask-claude-btn:hover {
      background: var(--vscode-button-hoverBackground);
    }

    .thread-pending .thread-header {
      background: var(--vscode-inputValidation-warningBackground);
    }
  </style>
</head>
<body>
  <div id="app">
    ${artifact ? this.renderArtifact(artifact) : this.renderEmptyState()}
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    // Handle messages from extension
    window.addEventListener('message', event => {
      const message = event.data;
      switch (message.type) {
        case 'updateArtifact':
          // Re-render would happen here in a real implementation
          console.log('Artifact updated:', message.artifact);
          break;
      }
    });

    // Event delegation - handle all clicks through a single listener
    document.addEventListener('click', (event) => {
      const target = event.target.closest('[data-action]');
      if (!target) return;

      const action = target.dataset.action;
      const artifactId = target.dataset.artifactId;
      const taskId = target.dataset.taskId;
      const sectionId = target.dataset.sectionId;
      const commentId = target.dataset.commentId;
      const filePath = target.dataset.filePath;
      const status = target.dataset.status;
      const index = target.dataset.index;

      switch (action) {
        // ============ Common Actions ============
        case 'proceed':
          vscode.postMessage({ type: 'proceed', artifactId });
          break;

        case 'reject':
          vscode.postMessage({ type: 'reject', artifactId });
          break;

        case 'submit-review': {
          const textarea = document.getElementById('review-feedback');
          const feedback = textarea?.value.trim();
          vscode.postMessage({ type: 'submitReview', artifactId, feedback });
          break;
        }

        case 'open-file':
          vscode.postMessage({ type: 'openFile', filePath });
          break;

        // ============ Comment Actions ============
        case 'add-comment': {
          const textarea = document.getElementById('new-comment');
          const content = textarea.value.trim();
          if (content) {
            vscode.postMessage({ type: 'addComment', artifactId, content });
            textarea.value = '';
          }
          break;
        }

        case 'resolve-comment':
          vscode.postMessage({ type: 'resolveComment', artifactId, commentId });
          break;

        // ============ Task List Actions ============
        case 'update-task-status':
          vscode.postMessage({ type: 'updateTaskStatus', artifactId, taskId, status });
          break;

        case 'delete-task':
          vscode.postMessage({ type: 'deleteTask', artifactId, taskId });
          break;

        case 'add-task': {
          const textInput = document.getElementById('new-task-text');
          const categorySelect = document.getElementById('new-task-category');
          const text = textInput.value.trim();
          if (text) {
            vscode.postMessage({
              type: 'addTask',
              artifactId,
              text,
              category: categorySelect.value
            });
            textInput.value = '';
          }
          break;
        }

        // ============ Implementation Plan Actions ============
        case 'delete-section':
          vscode.postMessage({ type: 'deleteSection', artifactId, sectionId });
          break;

        case 'add-section': {
          const titleInput = document.getElementById('new-section-title');
          const descInput = document.getElementById('new-section-description');
          const title = titleInput.value.trim();
          if (title) {
            vscode.postMessage({
              type: 'addSection',
              artifactId,
              title,
              description: descInput.value.trim()
            });
            titleInput.value = '';
            descInput.value = '';
          }
          break;
        }

        case 'add-file-change': {
          const form = document.querySelector('.add-file-change-form[data-section-id="' + sectionId + '"]');
          if (!form) return;

          const pathInput = form.querySelector('.file-path-input');
          const typeSelect = form.querySelector('.change-type-select');
          const filePathVal = pathInput.value.trim();

          if (filePathVal) {
            vscode.postMessage({
              type: 'addFileChange',
              artifactId,
              sectionId,
              filePath: filePathVal,
              changeType: typeSelect.value,
              description: ''
            });
            pathInput.value = '';
          }
          break;
        }

        case 'remove-file-change':
          vscode.postMessage({ type: 'removeFileChange', artifactId, sectionId, filePath });
          break;

        case 'request-review':
          vscode.postMessage({ type: 'requestReview', artifactId });
          break;

        // ============ Walkthrough Actions ============
        case 'remove-key-point':
          vscode.postMessage({ type: 'removeKeyPoint', artifactId, index: parseInt(index) });
          break;

        case 'add-key-point': {
          const input = document.getElementById('new-key-point');
          const keyPoint = input.value.trim();
          if (keyPoint) {
            vscode.postMessage({ type: 'addKeyPoint', artifactId, keyPoint });
            input.value = '';
          }
          break;
        }

        case 'delete-walkthrough-section':
          vscode.postMessage({ type: 'deleteWalkthroughSection', artifactId, sectionId });
          break;

        case 'add-walkthrough-section': {
          const titleInput = document.getElementById('new-wt-section-title');
          const contentInput = document.getElementById('new-wt-section-content');
          const title = titleInput.value.trim();
          if (title) {
            vscode.postMessage({
              type: 'addWalkthroughSection',
              artifactId,
              title,
              content: contentInput.value.trim()
            });
            titleInput.value = '';
            contentInput.value = '';
          }
          break;
        }

        case 'remove-changed-file':
          vscode.postMessage({ type: 'removeChangedFile', artifactId, filePath });
          break;

        case 'add-changed-file': {
          const pathInput = document.getElementById('new-changed-file-path');
          const typeSelect = document.getElementById('new-changed-file-type');
          const addedInput = document.getElementById('new-changed-file-added');
          const removedInput = document.getElementById('new-changed-file-removed');

          const filePathVal = pathInput.value.trim();
          if (filePathVal) {
            vscode.postMessage({
              type: 'addChangedFile',
              artifactId,
              filePath: filePathVal,
              changeType: typeSelect.value,
              linesAdded: parseInt(addedInput.value) || 0,
              linesRemoved: parseInt(removedInput.value) || 0,
              summary: ''
            });
            pathInput.value = '';
            addedInput.value = '0';
            removedInput.value = '0';
          }
          break;
        }

        // ============ Comment Actions ============
        case 'delete-comment':
          vscode.postMessage({ type: 'deleteComment', artifactId, commentId });
          break;

        case 'resolve-thread':
          vscode.postMessage({
            type: 'resolveThread',
            artifactId,
            sectionId: target.dataset.sectionId || null,
            lineNumber: target.dataset.lineNumber || null
          });
          break;

        case 'reply-to-thread': {
          const threadId = target.dataset.threadId || (sectionId ? 'section-' + sectionId : 'general');
          const replyInput = document.querySelector('.reply-input[data-thread-id="' + threadId + '"]');
          if (replyInput && replyInput.value.trim()) {
            vscode.postMessage({
              type: 'replyToThread',
              artifactId,
              content: replyInput.value.trim(),
              sectionId: target.dataset.sectionId || null,
              lineNumber: target.dataset.lineNumber || null
            });
            replyInput.value = '';
          }
          break;
        }

        case 'show-section-comments': {
          // Toggle section comments visibility or scroll to them
          const sectionComments = document.querySelector('.section-comments[data-section-id="' + sectionId + '"]');
          if (sectionComments) {
            sectionComments.classList.toggle('expanded');
            sectionComments.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }
          break;
        }

        case 'add-section-comment': {
          // Prompt user for comment and add it to the section
          const commentText = prompt('Add a comment for this section:');
          if (commentText && commentText.trim()) {
            vscode.postMessage({
              type: 'addComment',
              artifactId,
              content: commentText.trim(),
              sectionId
            });
          }
          break;
        }

        // ============ Option Selection Actions ============
        case 'select-option':
          vscode.postMessage({
            type: 'selectOption',
            artifactId,
            optionId: target.dataset.optionId
          });
          break;

        case 'submit-custom': {
          const customInput = document.getElementById('custom-response');
          if (customInput && customInput.value.trim()) {
            vscode.postMessage({
              type: 'submitCustomOption',
              artifactId,
              customResponse: customInput.value.trim()
            });
          }
          break;
        }

        // ============ Revision Actions ============
        case 'apply-revision':
          vscode.postMessage({
            type: 'applyRevision',
            artifactId,
            revisionIndex: parseInt(target.dataset.revisionIndex)
          });
          break;

        case 'dismiss-revision':
          vscode.postMessage({
            type: 'dismissRevision',
            artifactId,
            revisionIndex: parseInt(target.dataset.revisionIndex)
          });
          break;

        case 'apply-all-revisions':
          vscode.postMessage({ type: 'applyAllRevisions', artifactId });
          break;

        case 'dismiss-all-revisions':
          vscode.postMessage({ type: 'dismissAllRevisions', artifactId });
          break;

        // ============ Ask Claude Action ============
        case 'ask-claude': {
          vscode.postMessage({
            type: 'askClaude',
            artifactId,
            threadId: target.dataset.threadId,
            sectionId: target.dataset.sectionId
          });
          break;
        }
      }
    });

    // Filter button handling
    document.addEventListener('click', (event) => {
      const filterBtn = event.target.closest('.filter-btn');
      if (!filterBtn) return;

      const filter = filterBtn.dataset.filter;
      document.querySelectorAll('.filter-btn').forEach(btn => btn.classList.remove('active'));
      filterBtn.classList.add('active');

      document.querySelectorAll('.comment-thread').forEach(thread => {
        if (filter === 'all') {
          thread.style.display = '';
        } else if (filter === 'unresolved') {
          thread.style.display = thread.classList.contains('thread-resolved') ? 'none' : '';
        } else if (filter === 'resolved') {
          thread.style.display = thread.classList.contains('thread-resolved') ? '' : 'none';
        }
      });
    });
  </script>
</body>
</html>`;
  }

  /**
   * Render empty state
   */
  private renderEmptyState(): string {
    return `
      <div class="empty-state">
        <div class="empty-state-icon">📋</div>
        <h3>No Artifact Selected</h3>
        <p>Select an artifact from the list to view its details.</p>
      </div>
    `;
  }

  /**
   * Render artifact content
   */
  private renderArtifact(artifact: Artifact): string {
    return `
      ${this.renderClaudeStateIndicator()}
      ${this.renderOptionsSelector()}
      ${this.renderPendingRevisions(artifact)}

      <div class="artifact-header">
        <div>
          <h1 class="artifact-title">${escapeHtml(artifact.title)}</h1>
          <span class="artifact-type">${artifact.type.replace('-', ' ')}</span>
          <span class="artifact-status status-${artifact.status}">${artifact.status.replace('-', ' ')}</span>
        </div>
      </div>

      <div class="artifact-content">
        ${this.renderArtifactBody(artifact)}
      </div>

      ${this.renderActions(artifact)}
      ${this.renderComments(artifact)}
    `;
  }

  /**
   * Render Claude state indicator
   */
  private renderClaudeStateIndicator(): string {
    if (!this.currentClaudeState || this.currentClaudeState.state === 'idle') {
      return '';
    }

    const stateIcons: Record<string, string> = {
      'thinking': '🔄',
      'planning': '📋',
      'executing': '⚡',
      'waiting-for-input': '💬',
      'waiting-for-approval': '👁️',
      'error': '❌',
    };

    const stateColors: Record<string, string> = {
      'thinking': 'var(--vscode-charts-yellow)',
      'planning': 'var(--vscode-charts-blue)',
      'executing': 'var(--vscode-charts-green)',
      'waiting-for-input': 'var(--vscode-charts-orange)',
      'waiting-for-approval': 'var(--vscode-charts-purple)',
      'error': 'var(--vscode-charts-red)',
    };

    const icon = stateIcons[this.currentClaudeState.state] || '⚪';
    const color = stateColors[this.currentClaudeState.state] || 'var(--vscode-foreground)';
    const description = this.currentClaudeState.description || this.currentClaudeState.state;
    const progress = this.currentClaudeState.progress;

    return `
      <div class="claude-state-indicator" style="border-left: 3px solid ${color};">
        <span class="state-icon">${icon}</span>
        <span class="state-label">${escapeHtml(description)}</span>
        ${progress ? `
          <div class="state-progress">
            <div class="progress-bar" style="width: ${(progress.current / progress.total) * 100}%"></div>
            <span class="progress-label">${progress.current}/${progress.total}</span>
          </div>
        ` : ''}
      </div>
    `;
  }

  /**
   * Render options selector UI
   */
  private renderOptionsSelector(): string {
    if (!this.pendingOptions) {
      return '';
    }

    const { artifactId, prompt, options, allowCustom } = this.pendingOptions;

    return `
      <div class="options-selector" data-artifact-id="${artifactId}">
        <div class="options-header">
          <h3>Claude is asking for your input</h3>
          <p class="options-prompt">${escapeHtml(prompt)}</p>
        </div>

        <div class="options-list">
          ${options.map(opt => `
            <div class="option-card ${opt.recommended ? 'recommended' : ''}"
                 data-action="select-option"
                 data-artifact-id="${artifactId}"
                 data-option-id="${opt.id}">
              <div class="option-header">
                <span class="option-title">${escapeHtml(opt.title)}</span>
                ${opt.recommended ? '<span class="recommended-badge">Recommended</span>' : ''}
                ${opt.estimatedEffort ? `<span class="effort-badge effort-${opt.estimatedEffort}">${opt.estimatedEffort}</span>` : ''}
              </div>
              <p class="option-description">${escapeHtml(opt.description)}</p>
              ${opt.pros && opt.pros.length > 0 ? `
                <div class="option-pros">
                  <strong>Pros:</strong>
                  <ul>${opt.pros.map(p => `<li>${escapeHtml(p)}</li>`).join('')}</ul>
                </div>
              ` : ''}
              ${opt.cons && opt.cons.length > 0 ? `
                <div class="option-cons">
                  <strong>Cons:</strong>
                  <ul>${opt.cons.map(c => `<li>${escapeHtml(c)}</li>`).join('')}</ul>
                </div>
              ` : ''}
            </div>
          `).join('')}
        </div>

        ${allowCustom ? `
          <div class="custom-option">
            <textarea id="custom-response" placeholder="Or provide a custom response..."></textarea>
            <button class="btn-secondary" data-action="submit-custom" data-artifact-id="${artifactId}">
              Submit Custom Response
            </button>
          </div>
        ` : ''}
      </div>
    `;
  }

  /**
   * Render pending revision suggestions
   */
  private renderPendingRevisions(artifact: Artifact): string {
    if (this.pendingRevisions.length === 0) {
      return '';
    }

    return `
      <div class="pending-revisions">
        <h3>Suggested Revisions from Claude</h3>
        <p>Based on your comments, Claude suggests the following changes:</p>

        <div class="revision-list">
          ${this.pendingRevisions.map((rev, index) => `
            <div class="revision-suggestion" data-revision-index="${index}">
              <div class="revision-header">
                <span class="revision-type revision-${rev.revisionType}">${rev.revisionType}</span>
                <span class="revision-section">Section: ${rev.sectionId}</span>
              </div>
              <div class="revision-reason">${escapeHtml(rev.reason)}</div>
              <div class="revision-content">
                ${rev.originalContent ? `
                  <div class="revision-original">
                    <strong>Original:</strong>
                    <pre>${escapeHtml(rev.originalContent)}</pre>
                  </div>
                ` : ''}
                <div class="revision-proposed">
                  <strong>Proposed:</strong>
                  <pre>${escapeHtml(rev.proposedContent)}</pre>
                </div>
              </div>
              <div class="revision-actions">
                <button class="btn-primary btn-small" data-action="apply-revision" data-artifact-id="${artifact.id}" data-revision-index="${index}">Apply</button>
                <button class="btn-secondary btn-small" data-action="dismiss-revision" data-artifact-id="${artifact.id}" data-revision-index="${index}">Dismiss</button>
              </div>
            </div>
          `).join('')}
        </div>

        <div class="revision-bulk-actions">
          <button class="btn-primary" data-action="apply-all-revisions" data-artifact-id="${artifact.id}">Apply All</button>
          <button class="btn-secondary" data-action="dismiss-all-revisions" data-artifact-id="${artifact.id}">Dismiss All</button>
        </div>
      </div>
    `;
  }

  /**
   * Render artifact body based on type
   */
  private renderArtifactBody(artifact: Artifact): string {
    switch (artifact.type) {
      case 'task-list':
        return this.renderTaskList(artifact);
      case 'implementation-plan':
        return this.renderImplementationPlan(artifact);
      case 'walkthrough':
        return this.renderWalkthrough(artifact);
      default:
        return '<p>Unknown artifact type</p>';
    }
  }

  /**
   * Render task list
   */
  private renderTaskList(artifact: Artifact): string {
    if (artifact.type !== 'task-list') return '';

    const statusIcons: Record<string, string> = {
      pending: '○',
      'in-progress': '◐',
      completed: '●',
    };

    const progress = this.taskListProvider.getProgress(artifact.id);

    return `
      <div class="progress-bar-container">
        <div class="progress-bar" style="width: ${progress.percentage}%"></div>
        <span class="progress-text">${progress.completed}/${progress.total} (${progress.percentage}%)</span>
      </div>

      <div class="task-list">
        ${artifact.items
          .sort((a, b) => a.order - b.order)
          .map(
            item => `
          <div class="task-item" data-task-id="${item.id}">
            <div class="task-status-buttons">
              <button class="task-status-btn ${item.status === 'pending' ? 'active' : ''}"
                      data-action="update-task-status" data-artifact-id="${artifact.id}" data-task-id="${item.id}" data-status="pending" title="Pending">○</button>
              <button class="task-status-btn ${item.status === 'in-progress' ? 'active' : ''}"
                      data-action="update-task-status" data-artifact-id="${artifact.id}" data-task-id="${item.id}" data-status="in-progress" title="In Progress">◐</button>
              <button class="task-status-btn ${item.status === 'completed' ? 'active' : ''}"
                      data-action="update-task-status" data-artifact-id="${artifact.id}" data-task-id="${item.id}" data-status="completed" title="Completed">●</button>
            </div>
            <span class="task-text ${item.status === 'completed' ? 'completed' : ''}">${escapeHtml(item.text)}</span>
            <span class="task-category">${item.category}</span>
            <button class="task-delete-btn" data-action="delete-task" data-artifact-id="${artifact.id}" data-task-id="${item.id}" title="Delete">×</button>
          </div>
        `
          )
          .join('')}
      </div>

      <div class="add-task-form">
        <input type="text" id="new-task-text" placeholder="New task..." />
        <select id="new-task-category">
          <option value="other">Other</option>
          <option value="research">Research</option>
          <option value="implementation">Implementation</option>
          <option value="verification">Verification</option>
        </select>
        <button class="btn-primary" data-action="add-task" data-artifact-id="${artifact.id}">Add Task</button>
      </div>
    `;
  }

  /**
   * Render implementation plan
   */
  private renderImplementationPlan(artifact: Artifact): string {
    if (artifact.type !== 'implementation-plan') return '';

    const stats = this.implPlanProvider.getStats(artifact.id);

    return `
      ${artifact.summary ? `<div class="plan-summary"><p>${escapeHtml(artifact.summary)}</p></div>` : ''}

      <div class="plan-stats">
        <span class="stat"><strong>${stats.totalSections}</strong> sections</span>
        <span class="stat"><strong>${stats.totalFiles}</strong> files</span>
        <span class="stat create">+${stats.filesByType.create}</span>
        <span class="stat modify">~${stats.filesByType.modify}</span>
        <span class="stat delete">-${stats.filesByType.delete}</span>
      </div>

      ${artifact.sections
        .sort((a, b) => a.order - b.order)
        .map(
          section => `
        <div class="section" data-section-id="${section.id}">
          <div class="section-header">
            <div class="section-title">${escapeHtml(section.title)}</div>
            ${this.renderInlineCommentButton(artifact.id, section.id)}
            <button class="section-delete-btn" data-action="delete-section" data-artifact-id="${artifact.id}" data-section-id="${section.id}" title="Delete section">×</button>
          </div>
          <p>${escapeHtml(section.description)}</p>

          <div class="file-changes">
            ${section.changes
              .map(
                change => `
              <div class="file-change">
                <span class="file-change-icon change-${change.changeType}">
                  ${change.changeType === 'create' ? '+' : change.changeType === 'delete' ? '-' : '~'}
                </span>
                <span class="file-path" data-action="open-file" data-file-path="${escapeHtml(change.filePath)}">${escapeHtml(change.filePath)}</span>
                ${change.description ? `<span class="file-description">${escapeHtml(change.description)}</span>` : ''}
                <button class="file-remove-btn" data-action="remove-file-change" data-artifact-id="${artifact.id}" data-section-id="${section.id}" data-file-path="${escapeHtml(change.filePath)}" title="Remove">×</button>
              </div>
            `
              )
              .join('')}

            <div class="add-file-change-form" data-section-id="${section.id}">
              <input type="text" class="file-path-input" placeholder="File path..." />
              <select class="change-type-select">
                <option value="modify">Modify</option>
                <option value="create">Create</option>
                <option value="delete">Delete</option>
              </select>
              <button class="btn-small" data-action="add-file-change" data-artifact-id="${artifact.id}" data-section-id="${section.id}">Add</button>
            </div>
          </div>
        </div>
      `
        )
        .join('')}

      <div class="add-section-form">
        <input type="text" id="new-section-title" placeholder="Section title..." />
        <input type="text" id="new-section-description" placeholder="Description..." />
        <button class="btn-primary" data-action="add-section" data-artifact-id="${artifact.id}">Add Section</button>
      </div>

      ${artifact.status === 'draft' ? `
        <div class="actions">
          <button class="btn-primary" data-action="request-review" data-artifact-id="${artifact.id}">Request Review</button>
        </div>
      ` : ''}
    `;
  }

  /**
   * Render walkthrough
   */
  private renderWalkthrough(artifact: Artifact): string {
    if (artifact.type !== 'walkthrough') return '';

    const stats = this.walkthroughProvider.getStats(artifact.id);

    return `
      ${artifact.summary ? `<div class="walkthrough-summary"><p>${escapeHtml(artifact.summary)}</p></div>` : ''}

      <div class="walkthrough-stats">
        <span class="stat"><strong>${stats.totalFiles}</strong> files changed</span>
        <span class="stat add">+${stats.totalLinesAdded}</span>
        <span class="stat remove">-${stats.totalLinesRemoved}</span>
      </div>

      <div class="section key-points-section">
        <div class="section-header">
          <div class="section-title">Key Points</div>
        </div>
        <ul class="key-points">
          ${artifact.keyPoints.map((point, index) => `
            <li>
              <span>${escapeHtml(point)}</span>
              <button class="remove-btn" data-action="remove-key-point" data-artifact-id="${artifact.id}" data-index="${index}" title="Remove">×</button>
            </li>
          `).join('')}
        </ul>
        <div class="add-key-point-form">
          <input type="text" id="new-key-point" placeholder="Add key point..." />
          <button class="btn-small" data-action="add-key-point" data-artifact-id="${artifact.id}">Add</button>
        </div>
      </div>

      ${artifact.sections
        .sort((a, b) => a.order - b.order)
        .map(
          section => `
        <div class="section" data-section-id="${section.id}">
          <div class="section-header">
            <div class="section-title">${escapeHtml(section.title)}</div>
            ${this.renderInlineCommentButton(artifact.id, section.id)}
            <button class="section-delete-btn" data-action="delete-walkthrough-section" data-artifact-id="${artifact.id}" data-section-id="${section.id}" title="Delete section">×</button>
          </div>
          <div class="section-content">${escapeHtml(section.content)}</div>
        </div>
      `
        )
        .join('')}

      <div class="add-section-form">
        <input type="text" id="new-wt-section-title" placeholder="Section title..." />
        <textarea id="new-wt-section-content" placeholder="Section content..."></textarea>
        <button class="btn-primary" data-action="add-walkthrough-section" data-artifact-id="${artifact.id}">Add Section</button>
      </div>

      <div class="section changed-files-section">
        <div class="section-header">
          <div class="section-title">Changed Files</div>
        </div>
        ${artifact.changedFiles
          .map(
            file => `
          <div class="file-change">
            <span class="file-change-icon change-${file.changeType}">
              ${file.changeType === 'create' ? '+' : file.changeType === 'delete' ? '-' : '~'}
            </span>
            <span class="file-path" data-action="open-file" data-file-path="${escapeHtml(file.filePath)}">${escapeHtml(file.filePath)}</span>
            <span class="file-stats">+${file.linesAdded} -${file.linesRemoved}</span>
            <button class="file-remove-btn" data-action="remove-changed-file" data-artifact-id="${artifact.id}" data-file-path="${escapeHtml(file.filePath)}" title="Remove">×</button>
          </div>
        `
          )
          .join('')}

        <div class="add-changed-file-form">
          <input type="text" id="new-changed-file-path" placeholder="File path..." />
          <select id="new-changed-file-type">
            <option value="modify">Modify</option>
            <option value="create">Create</option>
            <option value="delete">Delete</option>
          </select>
          <input type="number" id="new-changed-file-added" placeholder="+lines" min="0" value="0" />
          <input type="number" id="new-changed-file-removed" placeholder="-lines" min="0" value="0" />
          <button class="btn-small" data-action="add-changed-file" data-artifact-id="${artifact.id}">Add</button>
        </div>
      </div>
    `;
  }

  /**
   * Render action buttons
   */
  private renderActions(artifact: Artifact): string {
    if (artifact.status === 'completed' || artifact.status === 'approved') {
      return '';
    }

    const showProceed = artifact.type === 'implementation-plan' && artifact.status === 'pending-review';

    return `
      <div class="actions">
        ${showProceed ? `<button class="btn-primary" data-action="proceed" data-artifact-id="${artifact.id}">Approve</button>` : ''}
        ${showProceed ? `<button class="btn-danger" data-action="reject" data-artifact-id="${artifact.id}">Reject</button>` : ''}
        ${showProceed ? `<button class="btn-secondary" data-action="submit-review" data-artifact-id="${artifact.id}">Submit Review</button>` : ''}
      </div>
    `;
  }

  /**
   * Render comments section with threading support
   */
  private renderComments(artifact: Artifact): string {
    const threads = this.commentController.getCommentThreads(artifact.id);
    const stats = this.commentController.getCommentStats(artifact.id);

    return `
      <div class="comments-section">
        <div class="comments-header">
          <h3>Comments</h3>
          ${stats.total > 0 ? `
            <div class="comment-stats-bar">
              <span class="stat-item">
                <span class="stat-value">${stats.total}</span>
                <span class="stat-label">total</span>
              </span>
              <span class="stat-item unresolved">
                <span class="stat-value">${stats.unresolved}</span>
                <span class="stat-label">open</span>
              </span>
              <span class="stat-item resolved">
                <span class="stat-value">${stats.resolved}</span>
                <span class="stat-label">resolved</span>
              </span>
            </div>
          ` : ''}
        </div>

        ${threads.length > 0 ? `
          <div class="comments-filter">
            <button class="filter-btn active" data-filter="all">All</button>
            <button class="filter-btn" data-filter="unresolved">Open (${stats.unresolved})</button>
            <button class="filter-btn" data-filter="resolved">Resolved (${stats.resolved})</button>
          </div>
        ` : ''}

        <div class="threads-container">
          ${threads.length > 0 ? threads.map(thread => this.renderCommentThread(thread, artifact.id)).join('') : ''}
        </div>

        <div class="add-comment">
          <textarea id="new-comment" placeholder="Add a comment..."></textarea>
          <div class="add-comment-actions">
            <button class="btn-primary" data-action="add-comment" data-artifact-id="${artifact.id}">Add Comment</button>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Render a single comment thread
   */
  private renderCommentThread(thread: CommentThread, artifactId: string): string {
    const resolvedClass = thread.resolved ? 'thread-resolved' : '';
    const threadLocation = this.getThreadLocationLabel(thread);

    return `
      <div class="comment-thread ${resolvedClass}" data-thread-id="${thread.id}">
        <div class="thread-header">
          <span class="thread-location">${threadLocation}</span>
          <span class="thread-count">${thread.comments.length} comment${thread.comments.length !== 1 ? 's' : ''}</span>
          ${!thread.resolved ? `
            <button class="thread-resolve-btn btn-small" data-action="resolve-thread"
                    data-artifact-id="${artifactId}"
                    data-section-id="${thread.sectionId || ''}"
                    data-line-number="${thread.lineNumber ?? ''}">
              Resolve All
            </button>
          ` : '<span class="thread-status-resolved">All Resolved</span>'}
        </div>
        <div class="thread-comments">
          ${thread.comments.map(comment => this.renderSingleComment(comment, artifactId)).join('')}
        </div>
        <div class="thread-reply">
          <textarea class="reply-input" placeholder="Reply..." data-thread-id="${thread.id}"></textarea>
          <button class="btn-small" data-action="reply-to-thread"
                  data-artifact-id="${artifactId}"
                  data-thread-id="${thread.id}"
                  data-section-id="${thread.sectionId || ''}"
                  data-line-number="${thread.lineNumber ?? ''}">
            Reply
          </button>
        </div>
      </div>
    `;
  }

  /**
   * Render a single comment within a thread
   */
  private renderSingleComment(comment: { id: string; content: string; author: string; resolved: boolean; createdAt: Date }, artifactId: string): string {
    const authorLabel = comment.author === 'user' ? 'You' : 'Agent';
    const authorClass = comment.author === 'user' ? 'comment-author-user' : 'comment-author-agent';
    const resolvedClass = comment.resolved ? 'comment-resolved' : '';

    return `
      <div class="comment ${resolvedClass}" data-comment-id="${comment.id}">
        <div class="comment-header">
          <span class="comment-author ${authorClass}">${authorLabel}</span>
          <span class="comment-time">${this.formatDate(comment.createdAt)}</span>
          ${!comment.resolved ? `
            <button class="btn-small" data-action="resolve-comment"
                    data-artifact-id="${artifactId}" data-comment-id="${comment.id}">
              Resolve
            </button>
          ` : '<span class="comment-status-resolved">Resolved</span>'}
          <button class="comment-delete-btn" data-action="delete-comment"
                  data-artifact-id="${artifactId}" data-comment-id="${comment.id}" title="Delete">
            ×
          </button>
        </div>
        <div class="comment-content">${escapeHtml(comment.content)}</div>
      </div>
    `;
  }

  /**
   * Render inline comment button for sections
   */
  private renderInlineCommentButton(artifactId: string, sectionId: string): string {
    const commentCount = this.commentController.getCommentsBySection(artifactId, sectionId).length;
    const hasComments = commentCount > 0;

    return `
      <button class="inline-comment-btn ${hasComments ? 'has-comments' : ''}"
              data-action="add-section-comment"
              data-artifact-id="${artifactId}"
              data-section-id="${sectionId}"
              title="${hasComments ? `${commentCount} comment(s)` : 'Add comment'}">
        <span class="comment-icon">💬</span>
        ${hasComments ? `<span class="comment-count">${commentCount}</span>` : ''}
      </button>
    `;
  }

  /**
   * Get a human-readable label for thread location
   */
  private getThreadLocationLabel(thread: CommentThread): string {
    if (thread.sectionId && thread.lineNumber !== undefined) {
      return `Section • Line ${thread.lineNumber}`;
    } else if (thread.sectionId) {
      return 'Section';
    } else if (thread.lineNumber !== undefined) {
      return `Line ${thread.lineNumber}`;
    }
    return 'General';
  }

  /**
   * Format date for display
   */
  private formatDate(date: Date): string {
    const now = new Date();
    const diff = now.getTime() - new Date(date).getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) {
      return 'just now';
    } else if (minutes < 60) {
      return `${minutes}m ago`;
    } else if (hours < 24) {
      return `${hours}h ago`;
    } else if (days < 7) {
      return `${days}d ago`;
    }
    return new Date(date).toLocaleDateString();
  }

  /**
   * Dispose of resources
   */
  public dispose(): void {
    this._panel?.dispose();
    this._onDidSendFeedback.dispose();
    this._onOptionSelected.dispose();
    this._onAskClaude.dispose();
    this.commentController.dispose();
  }
}

/**
 * Generate a nonce for Content Security Policy
 */
function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };
  return text.replace(/[&<>"']/g, m => map[m]);
}
