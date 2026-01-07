import * as vscode from 'vscode';
import {
  Artifact,
  ArtifactType,
  ArtifactStatus,
  Comment,
  TaskListArtifact,
  ImplementationPlanArtifact,
  WalkthroughArtifact,
  createArtifactId,
  createCommentId,
} from './types';

const STORAGE_KEY = 'claudeArtifacts.artifacts';

/**
 * ArtifactManager handles CRUD operations for artifacts
 * and manages persistence using VS Code's workspace storage
 */
export class ArtifactManager {
  private artifacts: Map<string, Artifact> = new Map();
  private readonly _onDidChangeArtifacts = new vscode.EventEmitter<Artifact[]>();
  private readonly _onDidCreateArtifact = new vscode.EventEmitter<Artifact>();
  private readonly _onDidUpdateArtifact = new vscode.EventEmitter<Artifact>();
  private readonly _onDidDeleteArtifact = new vscode.EventEmitter<string>();

  public readonly onDidChangeArtifacts = this._onDidChangeArtifacts.event;
  public readonly onDidCreateArtifact = this._onDidCreateArtifact.event;
  public readonly onDidUpdateArtifact = this._onDidUpdateArtifact.event;
  public readonly onDidDeleteArtifact = this._onDidDeleteArtifact.event;

  constructor(private context: vscode.ExtensionContext) {
    this.loadArtifacts();
  }

  /**
   * Load artifacts from workspace storage
   */
  private loadArtifacts(): void {
    const stored = this.context.workspaceState.get<Artifact[]>(STORAGE_KEY, []);
    this.artifacts.clear();

    for (const artifact of stored) {
      // Restore Date objects
      artifact.createdAt = new Date(artifact.createdAt);
      artifact.updatedAt = new Date(artifact.updatedAt);
      artifact.comments = artifact.comments.map(c => ({
        ...c,
        createdAt: new Date(c.createdAt),
        updatedAt: c.updatedAt ? new Date(c.updatedAt) : undefined,
      }));
      this.artifacts.set(artifact.id, artifact);
    }
  }

  /**
   * Save artifacts to workspace storage
   */
  private async saveArtifacts(): Promise<void> {
    const artifactArray = Array.from(this.artifacts.values());
    await this.context.workspaceState.update(STORAGE_KEY, artifactArray);
    this._onDidChangeArtifacts.fire(artifactArray);
  }

  /**
   * Get all artifacts
   */
  public getAllArtifacts(): Artifact[] {
    return Array.from(this.artifacts.values())
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  /**
   * Get artifacts by type
   */
  public getArtifactsByType(type: ArtifactType): Artifact[] {
    return this.getAllArtifacts().filter(a => a.type === type);
  }

  /**
   * Get a single artifact by ID
   */
  public getArtifact(id: string): Artifact | undefined {
    return this.artifacts.get(id);
  }

  /**
   * Create a new Task List artifact
   */
  public async createTaskList(title: string): Promise<TaskListArtifact> {
    const artifact: TaskListArtifact = {
      id: createArtifactId(),
      type: 'task-list',
      title,
      status: 'draft',
      comments: [],
      items: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.artifacts.set(artifact.id, artifact);
    await this.saveArtifacts();
    this._onDidCreateArtifact.fire(artifact);

    return artifact;
  }

  /**
   * Create a new Implementation Plan artifact
   */
  public async createImplementationPlan(
    title: string,
    summary: string = ''
  ): Promise<ImplementationPlanArtifact> {
    const artifact: ImplementationPlanArtifact = {
      id: createArtifactId(),
      type: 'implementation-plan',
      title,
      summary,
      status: 'draft',
      comments: [],
      sections: [],
      estimatedChanges: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.artifacts.set(artifact.id, artifact);
    await this.saveArtifacts();
    this._onDidCreateArtifact.fire(artifact);

    return artifact;
  }

  /**
   * Create a new Walkthrough artifact
   */
  public async createWalkthrough(
    title: string,
    summary: string = ''
  ): Promise<WalkthroughArtifact> {
    const artifact: WalkthroughArtifact = {
      id: createArtifactId(),
      type: 'walkthrough',
      title,
      summary,
      status: 'draft',
      comments: [],
      sections: [],
      changedFiles: [],
      keyPoints: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.artifacts.set(artifact.id, artifact);
    await this.saveArtifacts();
    this._onDidCreateArtifact.fire(artifact);

    return artifact;
  }

  /**
   * Update an existing artifact
   */
  public async updateArtifact(
    id: string,
    updates: Record<string, unknown>
  ): Promise<Artifact | undefined> {
    const artifact = this.artifacts.get(id);
    if (!artifact) {
      return undefined;
    }

    const updated = {
      ...artifact,
      ...updates,
      updatedAt: new Date(),
    } as Artifact;

    this.artifacts.set(id, updated);
    await this.saveArtifacts();
    this._onDidUpdateArtifact.fire(updated);

    return updated;
  }

  /**
   * Update artifact status
   */
  public async updateStatus(id: string, status: ArtifactStatus): Promise<Artifact | undefined> {
    return this.updateArtifact(id, { status });
  }

  /**
   * Add a comment to an artifact
   */
  public async addComment(
    artifactId: string,
    content: string,
    author: 'user' | 'agent',
    options?: { lineNumber?: number; sectionId?: string }
  ): Promise<Comment | undefined> {
    const artifact = this.artifacts.get(artifactId);
    if (!artifact) {
      return undefined;
    }

    const comment: Comment = {
      id: createCommentId(),
      artifactId,
      content,
      author,
      resolved: false,
      createdAt: new Date(),
      lineNumber: options?.lineNumber,
      sectionId: options?.sectionId,
    };

    artifact.comments.push(comment);
    artifact.updatedAt = new Date();

    await this.saveArtifacts();
    this._onDidUpdateArtifact.fire(artifact);

    return comment;
  }

  /**
   * Resolve a comment
   */
  public async resolveComment(artifactId: string, commentId: string): Promise<boolean> {
    const artifact = this.artifacts.get(artifactId);
    if (!artifact) {
      return false;
    }

    const comment = artifact.comments.find(c => c.id === commentId);
    if (!comment) {
      return false;
    }

    comment.resolved = true;
    comment.updatedAt = new Date();
    artifact.updatedAt = new Date();

    await this.saveArtifacts();
    this._onDidUpdateArtifact.fire(artifact);

    return true;
  }

  /**
   * Delete an artifact
   */
  public async deleteArtifact(id: string): Promise<boolean> {
    if (!this.artifacts.has(id)) {
      return false;
    }

    this.artifacts.delete(id);
    await this.saveArtifacts();
    this._onDidDeleteArtifact.fire(id);

    return true;
  }

  /**
   * Clear all artifacts
   */
  public async clearAll(): Promise<void> {
    this.artifacts.clear();
    await this.saveArtifacts();
  }

  /**
   * Dispose of resources
   */
  public dispose(): void {
    this._onDidChangeArtifacts.dispose();
    this._onDidCreateArtifact.dispose();
    this._onDidUpdateArtifact.dispose();
    this._onDidDeleteArtifact.dispose();
  }
}
