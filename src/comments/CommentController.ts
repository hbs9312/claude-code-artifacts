import * as vscode from 'vscode';
import { ArtifactManager } from '../artifact/ArtifactManager';
import { Comment, Artifact, CommentThread, CommentStats } from '../artifact/types';

/**
 * CommentController manages comment operations for artifacts
 * Provides threading, filtering, and feedback capabilities
 */
export class CommentController {
  private readonly _onDidAddComment = new vscode.EventEmitter<Comment>();
  private readonly _onDidResolveComment = new vscode.EventEmitter<Comment>();
  private readonly _onDidDeleteComment = new vscode.EventEmitter<string>();
  private readonly _onDidUpdateThread = new vscode.EventEmitter<CommentThread>();

  public readonly onDidAddComment = this._onDidAddComment.event;
  public readonly onDidResolveComment = this._onDidResolveComment.event;
  public readonly onDidDeleteComment = this._onDidDeleteComment.event;
  public readonly onDidUpdateThread = this._onDidUpdateThread.event;

  constructor(private readonly artifactManager: ArtifactManager) {}

  /**
   * Add a comment to an artifact
   */
  public async addComment(
    artifactId: string,
    content: string,
    author: 'user' | 'agent',
    options?: {
      lineNumber?: number;
      sectionId?: string;
      parentCommentId?: string;
    }
  ): Promise<Comment | undefined> {
    const comment = await this.artifactManager.addComment(
      artifactId,
      content,
      author,
      options
    );

    if (comment) {
      this._onDidAddComment.fire(comment);
    }

    return comment;
  }

  /**
   * Reply to an existing comment (creates a comment in the same thread)
   */
  public async replyToComment(
    artifactId: string,
    parentComment: Comment,
    content: string,
    author: 'user' | 'agent'
  ): Promise<Comment | undefined> {
    return this.addComment(artifactId, content, author, {
      lineNumber: parentComment.lineNumber,
      sectionId: parentComment.sectionId,
    });
  }

  /**
   * Resolve a comment
   */
  public async resolveComment(
    artifactId: string,
    commentId: string
  ): Promise<boolean> {
    const success = await this.artifactManager.resolveComment(artifactId, commentId);

    if (success) {
      const artifact = this.artifactManager.getArtifact(artifactId);
      const comment = artifact?.comments.find(c => c.id === commentId);
      if (comment) {
        this._onDidResolveComment.fire(comment);
      }
    }

    return success;
  }

  /**
   * Resolve all comments in a thread
   */
  public async resolveThread(
    artifactId: string,
    sectionId?: string,
    lineNumber?: number
  ): Promise<boolean> {
    const artifact = this.artifactManager.getArtifact(artifactId);
    if (!artifact) {
      return false;
    }

    const threadComments = this.getThreadComments(artifact, sectionId, lineNumber);

    for (const comment of threadComments) {
      if (!comment.resolved) {
        await this.resolveComment(artifactId, comment.id);
      }
    }

    return true;
  }

  /**
   * Delete a comment from an artifact
   */
  public async deleteComment(
    artifactId: string,
    commentId: string
  ): Promise<boolean> {
    const artifact = this.artifactManager.getArtifact(artifactId);
    if (!artifact) {
      return false;
    }

    const commentIndex = artifact.comments.findIndex(c => c.id === commentId);
    if (commentIndex === -1) {
      return false;
    }

    artifact.comments.splice(commentIndex, 1);
    artifact.updatedAt = new Date();

    await this.artifactManager.updateArtifact(artifactId, {
      comments: artifact.comments,
    });

    this._onDidDeleteComment.fire(commentId);
    return true;
  }

  /**
   * Get all comments for an artifact
   */
  public getComments(artifactId: string): Comment[] {
    const artifact = this.artifactManager.getArtifact(artifactId);
    return artifact?.comments || [];
  }

  /**
   * Get comments filtered by section
   */
  public getCommentsBySection(artifactId: string, sectionId: string): Comment[] {
    return this.getComments(artifactId).filter(c => c.sectionId === sectionId);
  }

  /**
   * Get comments filtered by line number
   */
  public getCommentsByLine(artifactId: string, lineNumber: number): Comment[] {
    return this.getComments(artifactId).filter(c => c.lineNumber === lineNumber);
  }

  /**
   * Get unresolved comments for an artifact
   */
  public getUnresolvedComments(artifactId: string): Comment[] {
    return this.getComments(artifactId).filter(c => !c.resolved);
  }

  /**
   * Get resolved comments for an artifact
   */
  public getResolvedComments(artifactId: string): Comment[] {
    return this.getComments(artifactId).filter(c => c.resolved);
  }

  /**
   * Group comments into threads
   */
  public getCommentThreads(artifactId: string): CommentThread[] {
    const artifact = this.artifactManager.getArtifact(artifactId);
    if (!artifact) {
      return [];
    }

    const threadMap = new Map<string, CommentThread>();

    for (const comment of artifact.comments) {
      const threadKey = this.getThreadKey(comment);

      if (!threadMap.has(threadKey)) {
        threadMap.set(threadKey, {
          id: `thread-${threadKey}`,
          artifactId,
          sectionId: comment.sectionId,
          lineNumber: comment.lineNumber,
          comments: [],
          resolved: true,
          createdAt: comment.createdAt,
          updatedAt: comment.createdAt,
        });
      }

      const thread = threadMap.get(threadKey)!;
      thread.comments.push(comment);

      // Update thread resolved status (thread is resolved only if all comments are resolved)
      if (!comment.resolved) {
        thread.resolved = false;
      }

      // Update thread timestamps
      if (comment.createdAt < thread.createdAt) {
        thread.createdAt = comment.createdAt;
      }
      if (comment.updatedAt && comment.updatedAt > thread.updatedAt) {
        thread.updatedAt = comment.updatedAt;
      } else if (comment.createdAt > thread.updatedAt) {
        thread.updatedAt = comment.createdAt;
      }
    }

    // Sort comments within each thread by creation time
    for (const thread of threadMap.values()) {
      thread.comments.sort((a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
    }

    return Array.from(threadMap.values())
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }

  /**
   * Get threads for a specific section
   */
  public getThreadsBySection(artifactId: string, sectionId: string): CommentThread[] {
    return this.getCommentThreads(artifactId).filter(t => t.sectionId === sectionId);
  }

  /**
   * Get unresolved threads
   */
  public getUnresolvedThreads(artifactId: string): CommentThread[] {
    return this.getCommentThreads(artifactId).filter(t => !t.resolved);
  }

  /**
   * Get comment statistics for an artifact
   */
  public getCommentStats(artifactId: string): CommentStats {
    const comments = this.getComments(artifactId);
    const threads = this.getCommentThreads(artifactId);

    return {
      total: comments.length,
      resolved: comments.filter(c => c.resolved).length,
      unresolved: comments.filter(c => !c.resolved).length,
      byAuthor: {
        user: comments.filter(c => c.author === 'user').length,
        agent: comments.filter(c => c.author === 'agent').length,
      },
      threadCount: threads.length,
    };
  }

  /**
   * Check if artifact has unresolved comments
   */
  public hasUnresolvedComments(artifactId: string): boolean {
    return this.getUnresolvedComments(artifactId).length > 0;
  }

  /**
   * Generate a unique key for grouping comments into threads
   */
  private getThreadKey(comment: Comment): string {
    if (comment.sectionId && comment.lineNumber !== undefined) {
      return `section-${comment.sectionId}-line-${comment.lineNumber}`;
    } else if (comment.sectionId) {
      return `section-${comment.sectionId}`;
    } else if (comment.lineNumber !== undefined) {
      return `line-${comment.lineNumber}`;
    }
    return 'general';
  }

  /**
   * Get comments that belong to a specific thread
   */
  private getThreadComments(
    artifact: Artifact,
    sectionId?: string,
    lineNumber?: number
  ): Comment[] {
    return artifact.comments.filter(c => {
      if (sectionId && lineNumber !== undefined) {
        return c.sectionId === sectionId && c.lineNumber === lineNumber;
      } else if (sectionId) {
        return c.sectionId === sectionId && c.lineNumber === undefined;
      } else if (lineNumber !== undefined) {
        return c.lineNumber === lineNumber && !c.sectionId;
      }
      return !c.sectionId && c.lineNumber === undefined;
    });
  }

  /**
   * Prepare feedback data for sending to CLI
   */
  public prepareFeedback(artifactId: string): {
    unresolvedComments: Comment[];
    allComments: Comment[];
    stats: ReturnType<CommentController['getCommentStats']>;
  } {
    return {
      unresolvedComments: this.getUnresolvedComments(artifactId),
      allComments: this.getComments(artifactId),
      stats: this.getCommentStats(artifactId),
    };
  }

  /**
   * Dispose of resources
   */
  public dispose(): void {
    this._onDidAddComment.dispose();
    this._onDidResolveComment.dispose();
    this._onDidDeleteComment.dispose();
    this._onDidUpdateThread.dispose();
  }
}
