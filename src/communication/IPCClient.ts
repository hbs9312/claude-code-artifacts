import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import {
  IPCMessage,
  IPCConfig,
  ArtifactMessage,
  FeedbackMessage,
  IPCStatusMessage,
  IPCErrorMessage,
  ClaudeStateMessage,
  OptionSelectionMessage,
  CommentDiscussionMessage,
  DiscussionRequestType,
  Comment,
} from '../artifact/types';

/**
 * Default IPC configuration
 */
const DEFAULT_CONFIG: IPCConfig = {
  mode: 'file',
  pollInterval: 500,
  retryAttempts: 3,
  retryDelay: 1000,
};

/**
 * Adaptive polling configuration
 */
const ADAPTIVE_POLLING = {
  ACTIVE_INTERVAL: 100,    // Fast polling when active
  IDLE_INTERVAL: 500,      // Slow polling when idle
  IDLE_THRESHOLD: 5000,    // Time before switching to idle mode
};

/**
 * Generate a stable project ID from workspace path
 */
function generateProjectId(workspacePath: string): string {
  // Create a short hash from the workspace path for uniqueness
  const hash = crypto.createHash('md5').update(workspacePath).digest('hex').substring(0, 8);
  // Get the folder name for readability
  const folderName = path.basename(workspacePath).toLowerCase().replace(/[^a-z0-9]/g, '-');
  return `${folderName}-${hash}`;
}

/**
 * Get the global artifacts base path
 */
function getGlobalArtifactsPath(): string {
  return path.join(os.homedir(), '.claude-artifacts');
}

/**
 * Message queue item
 */
interface QueuedMessage {
  message: IPCMessage;
  attempts: number;
  resolve: (success: boolean) => void;
  reject: (error: Error) => void;
}

/**
 * IPCClient handles communication between the VS Code extension and Claude Code CLI
 * Supports file-based IPC with message queue and retry logic
 */
export class IPCClient implements vscode.Disposable {
  private config: IPCConfig;
  private basePath: string;
  private inboxPath: string;
  private outboxPath: string;
  private processedPath: string;
  private statePath: string;
  private projectId: string;
  private workspacePath: string;
  private fileWatcher?: vscode.FileSystemWatcher;
  private stateWatcher?: vscode.FileSystemWatcher;
  private pollTimer?: NodeJS.Timeout;
  private messageQueue: QueuedMessage[] = [];
  private isProcessing = false;
  private isConnected = false;
  private processedMessageIds = new Set<string>();

  // Adaptive polling state
  private lastActivityTime = 0;
  private currentPollInterval = ADAPTIVE_POLLING.IDLE_INTERVAL;
  private currentClaudeState: ClaudeStateMessage | null = null;

  private readonly _onDidReceiveMessage = new vscode.EventEmitter<IPCMessage>();
  private readonly _onDidConnect = new vscode.EventEmitter<void>();
  private readonly _onDidDisconnect = new vscode.EventEmitter<void>();
  private readonly _onError = new vscode.EventEmitter<Error>();
  private readonly _onDidChangeClaudeState = new vscode.EventEmitter<ClaudeStateMessage>();

  public readonly onDidReceiveMessage = this._onDidReceiveMessage.event;
  public readonly onDidConnect = this._onDidConnect.event;
  public readonly onDidDisconnect = this._onDidDisconnect.event;
  public readonly onError = this._onError.event;
  public readonly onDidChangeClaudeState = this._onDidChangeClaudeState.event;

  constructor(config?: Partial<IPCConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Get workspace path and generate project ID
    this.workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    this.projectId = this.workspacePath ? generateProjectId(this.workspacePath) : 'default';

    // Set up paths using global ~/.claude-artifacts/{projectId}/
    const globalBase = getGlobalArtifactsPath();
    this.basePath = this.config.basePath || path.join(globalBase, this.projectId);
    this.inboxPath = path.join(this.basePath, 'inbox');
    this.outboxPath = path.join(this.basePath, 'outbox');
    this.processedPath = path.join(this.basePath, 'processed');
    this.statePath = path.join(this.basePath, 'state');
  }

  /**
   * Initialize the IPC client
   */
  public async initialize(): Promise<void> {
    try {
      // Create directories if they don't exist
      await this.ensureDirectories();

      // Register this project in global mapping
      await this.registerProject();

      // Start watching for incoming messages
      this.startWatching();

      // Send status message
      await this.sendStatus('ready');

      this.isConnected = true;
      this._onDidConnect.fire();

      console.log('IPCClient initialized successfully');
      console.log('Project ID:', this.projectId);
      console.log('IPC Path:', this.basePath);
    } catch (error) {
      console.error('Failed to initialize IPCClient:', error);
      this._onError.fire(error as Error);
      throw error;
    }
  }

  /**
   * Ensure IPC directories exist
   */
  private async ensureDirectories(): Promise<void> {
    const dirs = [this.basePath, this.inboxPath, this.outboxPath, this.processedPath, this.statePath];

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  /**
   * Start watching for incoming messages
   */
  private startWatching(): void {
    // Use file system watcher for inbox
    const inboxPattern = new vscode.RelativePattern(this.inboxPath, '*.json');
    this.fileWatcher = vscode.workspace.createFileSystemWatcher(inboxPattern);

    this.fileWatcher.onDidCreate(uri => {
      this.recordActivity();
      this.processIncomingFile(uri.fsPath);
    });
    this.fileWatcher.onDidChange(uri => {
      this.recordActivity();
      this.processIncomingFile(uri.fsPath);
    });

    // Start state file watching
    this.startStateWatching();

    // Also poll periodically with adaptive interval
    this.startAdaptivePolling();

    // Initial poll
    this.pollInbox();
  }

  /**
   * Start watching the Claude state file
   */
  private startStateWatching(): void {
    const stateFile = path.join(this.statePath, 'current.json');
    const stateDir = path.dirname(stateFile);

    // Ensure state directory exists
    if (!fs.existsSync(stateDir)) {
      fs.mkdirSync(stateDir, { recursive: true });
    }

    const statePattern = new vscode.RelativePattern(stateDir, 'current.json');
    this.stateWatcher = vscode.workspace.createFileSystemWatcher(statePattern);

    const handleStateChange = (uri: vscode.Uri) => {
      this.recordActivity();
      this.readStateFile(uri.fsPath);
    };

    this.stateWatcher.onDidCreate(handleStateChange);
    this.stateWatcher.onDidChange(handleStateChange);

    // Read initial state if exists
    if (fs.existsSync(stateFile)) {
      this.readStateFile(stateFile);
    }
  }

  /**
   * Read and emit state file changes
   */
  private readStateFile(filePath: string): void {
    try {
      if (!fs.existsSync(filePath)) {
        return;
      }

      const content = fs.readFileSync(filePath, 'utf-8');
      const state: ClaudeStateMessage = JSON.parse(content);

      // Only emit if state actually changed
      if (JSON.stringify(state) !== JSON.stringify(this.currentClaudeState)) {
        this.currentClaudeState = state;
        this._onDidChangeClaudeState.fire(state);
      }
    } catch (error) {
      console.error('Error reading state file:', error);
    }
  }

  /**
   * Start adaptive polling based on activity
   */
  private startAdaptivePolling(): void {
    const poll = () => {
      this.pollInbox();
      this.updatePollInterval();
      this.pollTimer = setTimeout(poll, this.currentPollInterval);
    };

    this.pollTimer = setTimeout(poll, this.currentPollInterval);
  }

  /**
   * Record activity for adaptive polling
   */
  private recordActivity(): void {
    this.lastActivityTime = Date.now();
  }

  /**
   * Update poll interval based on activity
   */
  private updatePollInterval(): void {
    const timeSinceActivity = Date.now() - this.lastActivityTime;

    if (timeSinceActivity < ADAPTIVE_POLLING.IDLE_THRESHOLD) {
      this.currentPollInterval = ADAPTIVE_POLLING.ACTIVE_INTERVAL;
    } else {
      this.currentPollInterval = ADAPTIVE_POLLING.IDLE_INTERVAL;
    }
  }

  /**
   * Poll inbox directory for new messages
   */
  private pollInbox(): void {
    try {
      if (!fs.existsSync(this.inboxPath)) {
        return;
      }

      const files = fs.readdirSync(this.inboxPath)
        .filter(f => f.endsWith('.json'))
        .sort(); // Process in order

      for (const file of files) {
        const filePath = path.join(this.inboxPath, file);
        this.processIncomingFile(filePath);
      }
    } catch (error) {
      console.error('Error polling inbox:', error);
    }
  }

  /**
   * Process an incoming message file
   */
  private async processIncomingFile(filePath: string): Promise<void> {
    try {
      if (!fs.existsSync(filePath)) {
        return;
      }

      const content = fs.readFileSync(filePath, 'utf-8');
      const message: IPCMessage = JSON.parse(content);

      // Skip already processed messages
      if (this.processedMessageIds.has(message.id)) {
        return;
      }

      this.processedMessageIds.add(message.id);

      // Move to processed directory
      const processedFile = path.join(this.processedPath, path.basename(filePath));
      fs.renameSync(filePath, processedFile);

      // Emit the message
      this._onDidReceiveMessage.fire(message);

      console.log('Processed incoming message:', message.id);
    } catch (error) {
      console.error('Error processing incoming file:', filePath, error);
    }
  }

  /**
   * Send a message to the CLI
   */
  public async send(message: Omit<IPCMessage, 'id' | 'timestamp'>): Promise<boolean> {
    const fullMessage: IPCMessage = {
      ...message,
      id: this.generateMessageId(),
      timestamp: Date.now(),
    } as IPCMessage;

    return this.enqueueMessage(fullMessage);
  }

  /**
   * Send an artifact message to the CLI
   */
  public async sendArtifactMessage(artifactMessage: ArtifactMessage): Promise<boolean> {
    return this.send({
      type: 'artifact',
      payload: artifactMessage,
    });
  }

  /**
   * Send a feedback message to the CLI
   */
  public async sendFeedback(feedback: FeedbackMessage): Promise<boolean> {
    return this.send({
      type: 'feedback',
      payload: feedback,
    });
  }

  /**
   * Send a status message to the CLI
   */
  public async sendStatus(status: IPCStatusMessage['status']): Promise<boolean> {
    const statusMessage: IPCStatusMessage = {
      status,
      extensionVersion: '0.1.0',
    };

    return this.send({
      type: 'status',
      payload: statusMessage,
    });
  }

  /**
   * Send an error message to the CLI
   */
  public async sendError(code: string, errorMessage: string, details?: unknown): Promise<boolean> {
    const error: IPCErrorMessage = {
      code,
      message: errorMessage,
      details,
    };

    return this.send({
      type: 'error',
      payload: error,
    });
  }

  /**
   * Send an option selection to the CLI
   */
  public async sendOptionSelection(
    artifactId: string,
    selectedOptionId: string | null,
    customResponse?: string
  ): Promise<boolean> {
    const selection: OptionSelectionMessage = {
      artifactId,
      action: 'option-selected',
      selectedOptionId,
      customResponse,
      timestamp: Date.now(),
    };

    return this.send({
      type: 'option-response' as 'feedback',
      payload: selection as unknown as FeedbackMessage,
    });
  }

  /**
   * Send a discussion request to the CLI
   */
  public async sendDiscussionRequest(
    artifactId: string,
    threadId: string,
    comments: Comment[],
    requestType: DiscussionRequestType
  ): Promise<boolean> {
    const discussion: CommentDiscussionMessage = {
      action: 'request-discussion',
      artifactId,
      threadId,
      comments,
      requestType,
    };

    return this.send({
      type: 'discussion' as 'feedback',
      payload: discussion as unknown as FeedbackMessage,
    });
  }

  /**
   * Get the current Claude state
   */
  public getClaudeState(): ClaudeStateMessage | null {
    return this.currentClaudeState;
  }

  /**
   * Enqueue a message for sending with retry logic
   */
  private enqueueMessage(message: IPCMessage): Promise<boolean> {
    return new Promise((resolve, reject) => {
      this.messageQueue.push({
        message,
        attempts: 0,
        resolve,
        reject,
      });

      this.processQueue();
    });
  }

  /**
   * Process the message queue
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.messageQueue.length === 0) {
      return;
    }

    this.isProcessing = true;

    while (this.messageQueue.length > 0) {
      const item = this.messageQueue[0];

      try {
        await this.writeMessage(item.message);
        this.messageQueue.shift();
        item.resolve(true);
      } catch (error) {
        item.attempts++;

        if (item.attempts >= (this.config.retryAttempts || 3)) {
          this.messageQueue.shift();
          item.reject(error as Error);
          this._onError.fire(error as Error);
        } else {
          // Wait before retrying
          await this.delay(this.config.retryDelay || 1000);
        }
      }
    }

    this.isProcessing = false;
  }

  /**
   * Write a message to the outbox
   */
  private async writeMessage(message: IPCMessage): Promise<void> {
    const filename = `${message.timestamp}-${message.id}.json`;
    const filePath = path.join(this.outboxPath, filename);

    fs.writeFileSync(filePath, JSON.stringify(message, null, 2), 'utf-8');
    console.log('Sent message:', message.id);
  }

  /**
   * Generate a unique message ID
   */
  private generateMessageId(): string {
    return `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Check if connected
   */
  public get connected(): boolean {
    return this.isConnected;
  }

  /**
   * Get the IPC base path
   */
  public getBasePath(): string {
    return this.basePath;
  }

  /**
   * Get the project ID
   */
  public getProjectId(): string {
    return this.projectId;
  }

  /**
   * Get the workspace path
   */
  public getWorkspacePath(): string {
    return this.workspacePath;
  }

  /**
   * Register this project in the global project mapping
   * This allows hook scripts to find the correct project folder
   */
  public async registerProject(): Promise<void> {
    const globalBase = getGlobalArtifactsPath();
    const mappingFile = path.join(globalBase, 'projects.json');

    let projects: Record<string, { path: string; name: string; lastActive: string }> = {};

    try {
      if (fs.existsSync(mappingFile)) {
        projects = JSON.parse(fs.readFileSync(mappingFile, 'utf-8'));
      }
    } catch {
      projects = {};
    }

    projects[this.workspacePath] = {
      path: this.basePath,
      name: path.basename(this.workspacePath),
      lastActive: new Date().toISOString(),
    };

    fs.writeFileSync(mappingFile, JSON.stringify(projects, null, 2));
  }

  /**
   * Clean up old processed messages
   */
  public async cleanupProcessedMessages(maxAge: number = 24 * 60 * 60 * 1000): Promise<number> {
    let cleaned = 0;
    const now = Date.now();

    try {
      if (!fs.existsSync(this.processedPath)) {
        return 0;
      }

      const files = fs.readdirSync(this.processedPath);

      for (const file of files) {
        const filePath = path.join(this.processedPath, file);
        const stats = fs.statSync(filePath);

        if (now - stats.mtimeMs > maxAge) {
          fs.unlinkSync(filePath);
          cleaned++;
        }
      }
    } catch (error) {
      console.error('Error cleaning up processed messages:', error);
    }

    return cleaned;
  }

  /**
   * Dispose of resources
   */
  public dispose(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }

    this.fileWatcher?.dispose();
    this.stateWatcher?.dispose();

    if (this.isConnected) {
      this.sendStatus('disconnected').catch(() => {});
      this.isConnected = false;
      this._onDidDisconnect.fire();
    }

    this._onDidReceiveMessage.dispose();
    this._onDidConnect.dispose();
    this._onDidDisconnect.dispose();
    this._onError.dispose();
    this._onDidChangeClaudeState.dispose();
  }
}
