import { Comment, CommentThread, CommentStats } from '../artifact/types';

/**
 * Helper functions for rendering comment threads in webview
 */

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

/**
 * Format date for display
 */
function formatDate(date: Date): string {
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
  } else {
    return new Date(date).toLocaleDateString();
  }
}

/**
 * Render a single comment
 */
export function renderComment(comment: Comment, artifactId: string): string {
  const authorLabel = comment.author === 'user' ? 'You' : 'Agent';
  const authorClass = comment.author === 'user' ? 'comment-author-user' : 'comment-author-agent';
  const resolvedClass = comment.resolved ? 'comment-resolved' : '';

  return `
    <div class="comment ${resolvedClass}" data-comment-id="${comment.id}">
      <div class="comment-header">
        <span class="comment-author ${authorClass}">${authorLabel}</span>
        <span class="comment-time">${formatDate(comment.createdAt)}</span>
        ${!comment.resolved ? `
          <button class="comment-resolve-btn" data-action="resolve-comment"
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
 * Render a comment thread
 */
export function renderCommentThread(thread: CommentThread): string {
  const resolvedClass = thread.resolved ? 'thread-resolved' : '';
  const threadLocation = getThreadLocationLabel(thread);

  return `
    <div class="comment-thread ${resolvedClass}" data-thread-id="${thread.id}">
      <div class="thread-header">
        <span class="thread-location">${threadLocation}</span>
        <span class="thread-count">${thread.comments.length} comment${thread.comments.length !== 1 ? 's' : ''}</span>
        ${!thread.resolved ? `
          <button class="thread-resolve-btn" data-action="resolve-thread"
                  data-artifact-id="${thread.artifactId}"
                  data-section-id="${thread.sectionId || ''}"
                  data-line-number="${thread.lineNumber ?? ''}">
            Resolve All
          </button>
        ` : '<span class="thread-status-resolved">All Resolved</span>'}
      </div>
      <div class="thread-comments">
        ${thread.comments.map(c => renderComment(c, thread.artifactId)).join('')}
      </div>
      <div class="thread-reply">
        <textarea class="reply-input" placeholder="Reply..." data-thread-id="${thread.id}"></textarea>
        <button class="btn-small reply-btn" data-action="reply-to-thread"
                data-artifact-id="${thread.artifactId}"
                data-section-id="${thread.sectionId || ''}"
                data-line-number="${thread.lineNumber ?? ''}">
          Reply
        </button>
      </div>
    </div>
  `;
}

/**
 * Get a human-readable label for thread location
 */
function getThreadLocationLabel(thread: CommentThread): string {
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
 * Render comment statistics
 */
export function renderCommentStats(stats: CommentStats): string {
  if (stats.total === 0) {
    return '<div class="comment-stats empty">No comments yet</div>';
  }

  return `
    <div class="comment-stats">
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
      <span class="stat-item">
        <span class="stat-value">${stats.threadCount}</span>
        <span class="stat-label">threads</span>
      </span>
    </div>
  `;
}

/**
 * Render the full comments section with threads
 */
export function renderCommentsSection(
  artifactId: string,
  threads: CommentThread[],
  stats: CommentStats
): string {
  return `
    <div class="comments-section">
      <div class="comments-header">
        <h3>Comments</h3>
        ${renderCommentStats(stats)}
      </div>

      <div class="comments-filter">
        <button class="filter-btn active" data-filter="all">All</button>
        <button class="filter-btn" data-filter="unresolved">Open (${stats.unresolved})</button>
        <button class="filter-btn" data-filter="resolved">Resolved (${stats.resolved})</button>
      </div>

      <div class="threads-container">
        ${threads.length > 0
          ? threads.map(t => renderCommentThread(t)).join('')
          : '<div class="no-comments">No comments in this category</div>'
        }
      </div>

      <div class="add-comment-section">
        <div class="add-comment-header">Add New Comment</div>
        <div class="add-comment-options">
          <label>
            <input type="checkbox" id="comment-to-section" />
            Attach to section
          </label>
          <select id="comment-section-select" disabled>
            <option value="">Select section...</option>
          </select>
        </div>
        <textarea id="new-comment" placeholder="Write a comment..."></textarea>
        <div class="add-comment-actions">
          <button class="btn-primary" data-action="add-comment" data-artifact-id="${artifactId}">
            Add Comment
          </button>
        </div>
      </div>
    </div>
  `;
}

/**
 * Render inline comment button for sections
 */
export function renderInlineCommentButton(
  artifactId: string,
  sectionId: string,
  commentCount: number = 0
): string {
  const hasComments = commentCount > 0;
  return `
    <button class="inline-comment-btn ${hasComments ? 'has-comments' : ''}"
            data-action="show-section-comments"
            data-artifact-id="${artifactId}"
            data-section-id="${sectionId}"
            title="${hasComments ? `${commentCount} comment(s)` : 'Add comment'}">
      <span class="comment-icon">💬</span>
      ${hasComments ? `<span class="comment-count">${commentCount}</span>` : ''}
    </button>
  `;
}

/**
 * Get CSS styles for comments
 */
export function getCommentStyles(): string {
  return `
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

    .thread-resolve-btn, .comment-resolve-btn {
      margin-left: auto;
      padding: 2px 8px;
      font-size: 0.75em;
      background-color: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
    }

    .thread-resolve-btn:hover, .comment-resolve-btn:hover {
      background-color: var(--vscode-button-secondaryHoverBackground);
    }

    .thread-status-resolved, .comment-status-resolved {
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

    .reply-btn {
      align-self: flex-end;
    }

    /* Individual Comment Styles */
    .comment {
      padding: 8px 10px;
      margin: 4px 0;
      background-color: var(--vscode-editor-background);
      border-radius: 4px;
      border-left: 3px solid var(--vscode-button-background);
    }

    .comment.comment-resolved {
      opacity: 0.6;
      border-left-color: var(--vscode-testing-iconPassed);
    }

    .comment-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 4px;
      font-size: 0.85em;
    }

    .comment-author {
      font-weight: 500;
    }

    .comment-author-user {
      color: var(--vscode-button-background);
    }

    .comment-author-agent {
      color: var(--vscode-testing-iconPassed);
    }

    .comment-time {
      color: var(--vscode-descriptionForeground);
    }

    .comment-delete-btn {
      margin-left: auto;
      width: 18px;
      height: 18px;
      padding: 0;
      background: transparent;
      border: none;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      border-radius: 50%;
      font-size: 14px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .comment-delete-btn:hover {
      background-color: var(--vscode-testing-iconFailed);
      color: white;
    }

    .comment-content {
      white-space: pre-wrap;
      line-height: 1.5;
    }

    /* Comment Stats */
    .comment-stats {
      display: flex;
      gap: 16px;
      padding: 8px 12px;
      background-color: var(--vscode-editor-inactiveSelectionBackground);
      border-radius: 4px;
      margin-bottom: 12px;
    }

    .comment-stats.empty {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
    }

    .stat-item {
      display: flex;
      align-items: baseline;
      gap: 4px;
    }

    .stat-value {
      font-weight: 600;
      font-size: 1.1em;
    }

    .stat-label {
      font-size: 0.8em;
      color: var(--vscode-descriptionForeground);
    }

    .stat-item.unresolved .stat-value {
      color: var(--vscode-inputValidation-warningBackground);
    }

    .stat-item.resolved .stat-value {
      color: var(--vscode-testing-iconPassed);
    }

    /* Comment Filter */
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

    .filter-btn:hover:not(.active) {
      background-color: var(--vscode-button-secondaryHoverBackground);
    }

    /* Inline Comment Button */
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
      border-color: var(--vscode-button-secondaryBackground);
    }

    .inline-comment-btn.has-comments {
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-color: var(--vscode-button-background);
    }

    .comment-icon {
      font-size: 12px;
    }

    .comment-count {
      font-weight: 600;
    }

    /* Add Comment Section */
    .add-comment-section {
      margin-top: 20px;
      padding: 12px;
      background-color: var(--vscode-editor-inactiveSelectionBackground);
      border-radius: 6px;
    }

    .add-comment-header {
      font-weight: 500;
      margin-bottom: 8px;
    }

    .add-comment-options {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 8px;
      font-size: 0.9em;
    }

    .add-comment-options label {
      display: flex;
      align-items: center;
      gap: 4px;
      cursor: pointer;
    }

    .add-comment-options select {
      padding: 4px 8px;
      border: 1px solid var(--vscode-input-border);
      background-color: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 4px;
    }

    .add-comment-options select:disabled {
      opacity: 0.5;
    }

    .comments-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }

    .comments-header h3 {
      margin: 0;
    }

    .no-comments {
      padding: 20px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
      font-style: italic;
    }

    .threads-container {
      max-height: 400px;
      overflow-y: auto;
    }
  `;
}
