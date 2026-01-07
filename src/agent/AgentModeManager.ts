import * as vscode from 'vscode';
import {
  AgentMode,
  ReviewPolicy,
  TaskGroup,
  AgentModeConfig,
  AgentModeState,
  createTaskGroupId,
} from '../artifact/types';
import { ArtifactManager } from '../artifact/ArtifactManager';

/**
 * Default agent mode configuration
 */
const DEFAULT_CONFIG: AgentModeConfig = {
  currentMode: 'planning',
  reviewPolicy: 'request-review',
  autoCreateArtifacts: true,
  skipArtifactsInFastMode: true,
};

/**
 * AgentModeManager handles agent mode switching, task groups,
 * and automatic artifact creation based on mode settings
 */
export class AgentModeManager implements vscode.Disposable {
  private config: AgentModeConfig;
  private taskGroups: Map<string, TaskGroup> = new Map();
  private disposables: vscode.Disposable[] = [];

  private readonly _onDidChangeMode = new vscode.EventEmitter<AgentMode>();
  private readonly _onDidChangeTaskGroup = new vscode.EventEmitter<TaskGroup | undefined>();
  private readonly _onDidChangeConfig = new vscode.EventEmitter<AgentModeConfig>();

  public readonly onDidChangeMode = this._onDidChangeMode.event;
  public readonly onDidChangeTaskGroup = this._onDidChangeTaskGroup.event;
  public readonly onDidChangeConfig = this._onDidChangeConfig.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly artifactManager: ArtifactManager
  ) {
    this.config = this.loadConfig();
    this.loadTaskGroups();
    this.setupConfigWatcher();
  }

  /**
   * Load configuration from workspace state
   */
  private loadConfig(): AgentModeConfig {
    const saved = this.context.workspaceState.get<AgentModeConfig>('agentModeConfig');
    return saved ? { ...DEFAULT_CONFIG, ...saved } : { ...DEFAULT_CONFIG };
  }

  /**
   * Save configuration to workspace state
   */
  private async saveConfig(): Promise<void> {
    await this.context.workspaceState.update('agentModeConfig', this.config);
  }

  /**
   * Load task groups from workspace state
   */
  private loadTaskGroups(): void {
    const saved = this.context.workspaceState.get<TaskGroup[]>('taskGroups', []);
    this.taskGroups.clear();
    for (const group of saved) {
      this.taskGroups.set(group.id, {
        ...group,
        createdAt: new Date(group.createdAt),
        updatedAt: new Date(group.updatedAt),
      });
    }
  }

  /**
   * Save task groups to workspace state
   */
  private async saveTaskGroups(): Promise<void> {
    const groups = Array.from(this.taskGroups.values());
    await this.context.workspaceState.update('taskGroups', groups);
  }

  /**
   * Setup configuration watcher
   */
  private setupConfigWatcher(): void {
    const configWatcher = vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('claudeArtifacts.reviewPolicy')) {
        const newPolicy = vscode.workspace.getConfiguration('claudeArtifacts')
          .get<string>('reviewPolicy', 'requestReview');

        this.config.reviewPolicy = newPolicy === 'alwaysProceed'
          ? 'always-proceed'
          : 'request-review';

        this.saveConfig();
        this._onDidChangeConfig.fire(this.config);
      }
    });

    this.disposables.push(configWatcher);
  }

  // ============================================
  // Mode Management
  // ============================================

  /**
   * Get current agent mode
   */
  public getMode(): AgentMode {
    return this.config.currentMode;
  }

  /**
   * Set agent mode
   */
  public async setMode(mode: AgentMode): Promise<void> {
    if (this.config.currentMode === mode) {
      return;
    }

    this.config.currentMode = mode;
    await this.saveConfig();
    this._onDidChangeMode.fire(mode);

    // Show notification
    const modeLabel = mode === 'planning' ? 'Planning Mode' : 'Fast Mode';
    vscode.window.showInformationMessage(`Agent mode switched to: ${modeLabel}`);
  }

  /**
   * Toggle between planning and fast mode
   */
  public async toggleMode(): Promise<AgentMode> {
    const newMode: AgentMode = this.config.currentMode === 'planning' ? 'fast' : 'planning';
    await this.setMode(newMode);
    return newMode;
  }

  /**
   * Check if in planning mode
   */
  public isPlanningMode(): boolean {
    return this.config.currentMode === 'planning';
  }

  /**
   * Check if in fast mode
   */
  public isFastMode(): boolean {
    return this.config.currentMode === 'fast';
  }

  // ============================================
  // Review Policy Management
  // ============================================

  /**
   * Get current review policy
   */
  public getReviewPolicy(): ReviewPolicy {
    return this.config.reviewPolicy;
  }

  /**
   * Set review policy
   */
  public async setReviewPolicy(policy: ReviewPolicy): Promise<void> {
    this.config.reviewPolicy = policy;
    await this.saveConfig();
    this._onDidChangeConfig.fire(this.config);

    // Update VS Code configuration
    const configValue = policy === 'always-proceed' ? 'alwaysProceed' : 'requestReview';
    await vscode.workspace.getConfiguration('claudeArtifacts')
      .update('reviewPolicy', configValue, vscode.ConfigurationTarget.Workspace);
  }

  /**
   * Check if review is required based on current policy
   */
  public isReviewRequired(): boolean {
    return this.config.reviewPolicy === 'request-review';
  }

  // ============================================
  // Task Group Management
  // ============================================

  /**
   * Create a new task group
   */
  public async createTaskGroup(name: string, description?: string): Promise<TaskGroup> {
    const now = new Date();
    const taskGroup: TaskGroup = {
      id: createTaskGroupId(),
      name,
      description,
      artifactIds: [],
      status: 'active',
      mode: this.config.currentMode,
      createdAt: now,
      updatedAt: now,
    };

    this.taskGroups.set(taskGroup.id, taskGroup);
    await this.saveTaskGroups();

    // Set as active task group
    this.config.activeTaskGroupId = taskGroup.id;
    await this.saveConfig();

    this._onDidChangeTaskGroup.fire(taskGroup);

    return taskGroup;
  }

  /**
   * Get active task group
   */
  public getActiveTaskGroup(): TaskGroup | undefined {
    if (!this.config.activeTaskGroupId) {
      return undefined;
    }
    return this.taskGroups.get(this.config.activeTaskGroupId);
  }

  /**
   * Set active task group
   */
  public async setActiveTaskGroup(groupId: string | undefined): Promise<void> {
    this.config.activeTaskGroupId = groupId;
    await this.saveConfig();

    const group = groupId ? this.taskGroups.get(groupId) : undefined;
    this._onDidChangeTaskGroup.fire(group);
  }

  /**
   * Get task group by ID
   */
  public getTaskGroup(groupId: string): TaskGroup | undefined {
    return this.taskGroups.get(groupId);
  }

  /**
   * Get all task groups
   */
  public getAllTaskGroups(): TaskGroup[] {
    return Array.from(this.taskGroups.values());
  }

  /**
   * Get active task groups
   */
  public getActiveTaskGroups(): TaskGroup[] {
    return Array.from(this.taskGroups.values())
      .filter(g => g.status === 'active');
  }

  /**
   * Add artifact to task group
   */
  public async addArtifactToGroup(groupId: string, artifactId: string): Promise<boolean> {
    const group = this.taskGroups.get(groupId);
    if (!group) {
      return false;
    }

    if (!group.artifactIds.includes(artifactId)) {
      group.artifactIds.push(artifactId);
      group.updatedAt = new Date();
      await this.saveTaskGroups();
      this._onDidChangeTaskGroup.fire(group);
    }

    return true;
  }

  /**
   * Remove artifact from task group
   */
  public async removeArtifactFromGroup(groupId: string, artifactId: string): Promise<boolean> {
    const group = this.taskGroups.get(groupId);
    if (!group) {
      return false;
    }

    const index = group.artifactIds.indexOf(artifactId);
    if (index > -1) {
      group.artifactIds.splice(index, 1);
      group.updatedAt = new Date();
      await this.saveTaskGroups();
      this._onDidChangeTaskGroup.fire(group);
    }

    return true;
  }

  /**
   * Complete a task group
   */
  public async completeTaskGroup(groupId: string): Promise<boolean> {
    const group = this.taskGroups.get(groupId);
    if (!group) {
      return false;
    }

    group.status = 'completed';
    group.updatedAt = new Date();
    await this.saveTaskGroups();

    // Clear active task group if it was this one
    if (this.config.activeTaskGroupId === groupId) {
      this.config.activeTaskGroupId = undefined;
      await this.saveConfig();
    }

    this._onDidChangeTaskGroup.fire(group);
    vscode.window.showInformationMessage(`Task group "${group.name}" completed`);

    return true;
  }

  /**
   * Cancel a task group
   */
  public async cancelTaskGroup(groupId: string): Promise<boolean> {
    const group = this.taskGroups.get(groupId);
    if (!group) {
      return false;
    }

    group.status = 'cancelled';
    group.updatedAt = new Date();
    await this.saveTaskGroups();

    // Clear active task group if it was this one
    if (this.config.activeTaskGroupId === groupId) {
      this.config.activeTaskGroupId = undefined;
      await this.saveConfig();
    }

    this._onDidChangeTaskGroup.fire(group);

    return true;
  }

  /**
   * Delete a task group
   */
  public async deleteTaskGroup(groupId: string): Promise<boolean> {
    if (!this.taskGroups.has(groupId)) {
      return false;
    }

    this.taskGroups.delete(groupId);
    await this.saveTaskGroups();

    // Clear active task group if it was this one
    if (this.config.activeTaskGroupId === groupId) {
      this.config.activeTaskGroupId = undefined;
      await this.saveConfig();
    }

    this._onDidChangeTaskGroup.fire(undefined);

    return true;
  }

  // ============================================
  // Artifact Auto-Creation
  // ============================================

  /**
   * Check if artifacts should be created based on current mode
   */
  public shouldCreateArtifact(): boolean {
    if (this.isFastMode() && this.config.skipArtifactsInFastMode) {
      return false;
    }
    return this.config.autoCreateArtifacts;
  }

  /**
   * Auto-create implementation plan for planning mode
   */
  public async autoCreatePlan(title: string, summary?: string): Promise<string | undefined> {
    if (!this.shouldCreateArtifact()) {
      return undefined;
    }

    const artifact = await this.artifactManager.createImplementationPlan(title, summary || '');

    // Add to active task group if exists
    const activeGroup = this.getActiveTaskGroup();
    if (activeGroup) {
      await this.addArtifactToGroup(activeGroup.id, artifact.id);
    }

    // Set status based on review policy
    if (this.isReviewRequired()) {
      await this.artifactManager.updateStatus(artifact.id, 'pending-review');
    }

    return artifact.id;
  }

  /**
   * Auto-create task list for planning mode
   */
  public async autoCreateTaskList(title: string): Promise<string | undefined> {
    if (!this.shouldCreateArtifact()) {
      return undefined;
    }

    const artifact = await this.artifactManager.createTaskList(title);

    // Add to active task group if exists
    const activeGroup = this.getActiveTaskGroup();
    if (activeGroup) {
      await this.addArtifactToGroup(activeGroup.id, artifact.id);
    }

    return artifact.id;
  }

  /**
   * Auto-create walkthrough after task completion
   */
  public async autoCreateWalkthrough(title: string, summary?: string): Promise<string | undefined> {
    if (!this.shouldCreateArtifact()) {
      return undefined;
    }

    const artifact = await this.artifactManager.createWalkthrough(title, summary || '');

    // Add to active task group if exists
    const activeGroup = this.getActiveTaskGroup();
    if (activeGroup) {
      await this.addArtifactToGroup(activeGroup.id, artifact.id);
    }

    return artifact.id;
  }

  // ============================================
  // State Export
  // ============================================

  /**
   * Get current agent mode state
   */
  public getState(): AgentModeState {
    const activeGroup = this.getActiveTaskGroup();

    return {
      mode: this.config.currentMode,
      reviewPolicy: this.config.reviewPolicy,
      activeTaskGroup: activeGroup,
      artifactCount: this.artifactManager.getAllArtifacts().length,
    };
  }

  /**
   * Get full configuration
   */
  public getConfig(): AgentModeConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  public async updateConfig(updates: Partial<AgentModeConfig>): Promise<void> {
    this.config = { ...this.config, ...updates };
    await this.saveConfig();
    this._onDidChangeConfig.fire(this.config);
  }

  /**
   * Dispose of resources
   */
  public dispose(): void {
    this.disposables.forEach(d => d.dispose());
    this._onDidChangeMode.dispose();
    this._onDidChangeTaskGroup.dispose();
    this._onDidChangeConfig.dispose();
  }
}
