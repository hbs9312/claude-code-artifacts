/**
 * Artifact Types for Claude Code Artifacts Extension
 */

// Base Artifact Types
export type ArtifactType = 'task-list' | 'implementation-plan' | 'walkthrough';
export type ArtifactStatus = 'draft' | 'pending-review' | 'approved' | 'completed';

// Comment Types
export interface Comment {
  id: string;
  artifactId: string;
  lineNumber?: number;      // For inline comments
  sectionId?: string;       // For section-level comments
  content: string;
  author: 'user' | 'agent';
  resolved: boolean;
  createdAt: Date;
  updatedAt?: Date;
}

// Comment Thread - groups related comments together
export interface CommentThread {
  id: string;
  artifactId: string;
  sectionId?: string;
  lineNumber?: number;
  comments: Comment[];
  resolved: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// Comment Statistics
export interface CommentStats {
  total: number;
  resolved: number;
  unresolved: number;
  byAuthor: { user: number; agent: number };
  threadCount: number;
}

// Base Artifact Interface
export interface BaseArtifact {
  id: string;
  type: ArtifactType;
  title: string;
  status: ArtifactStatus;
  comments: Comment[];
  createdAt: Date;
  updatedAt: Date;
}

// Task List Types
export type TaskStatus = 'pending' | 'in-progress' | 'completed';
export type TaskCategory = 'research' | 'implementation' | 'verification' | 'other';

export interface TaskListItem {
  id: string;
  text: string;
  status: TaskStatus;
  category: TaskCategory;
  order: number;
}

export interface TaskListArtifact extends BaseArtifact {
  type: 'task-list';
  items: TaskListItem[];
}

// Implementation Plan Types
export interface FileChange {
  filePath: string;
  changeType: 'create' | 'modify' | 'delete';
  description: string;
}

export interface PlanSection {
  id: string;
  title: string;
  description: string;
  files: string[];
  changes: FileChange[];
  order: number;
}

export interface ImplementationPlanArtifact extends BaseArtifact {
  type: 'implementation-plan';
  summary: string;
  sections: PlanSection[];
  estimatedChanges: number;
}

// Walkthrough Types
export interface WalkthroughFileChange {
  filePath: string;
  changeType: 'create' | 'modify' | 'delete';
  linesAdded: number;
  linesRemoved: number;
  summary: string;
}

export interface WalkthroughSection {
  id: string;
  title: string;
  content: string;  // Markdown content
  order: number;
}

export interface WalkthroughArtifact extends BaseArtifact {
  type: 'walkthrough';
  summary: string;
  sections: WalkthroughSection[];
  changedFiles: WalkthroughFileChange[];
  keyPoints: string[];
}

// Union type for all artifacts
export type Artifact = TaskListArtifact | ImplementationPlanArtifact | WalkthroughArtifact;

// Message types for CLI communication
export interface ArtifactCreateMessage {
  action: 'create';
  artifact: Artifact;
}

export interface ArtifactUpdateMessage {
  action: 'update';
  artifact: Partial<Artifact> & { id: string };
}

export interface ArtifactDeleteMessage {
  action: 'delete';
  artifactId: string;
}

export interface ArtifactRequestReviewMessage {
  action: 'request-review';
  artifactId: string;
}

export type ArtifactMessage =
  | ArtifactCreateMessage
  | ArtifactUpdateMessage
  | ArtifactDeleteMessage
  | ArtifactRequestReviewMessage;

// Feedback types from Extension to CLI
export interface FeedbackProceedMessage {
  artifactId: string;
  action: 'proceed';
}

export interface FeedbackRejectMessage {
  artifactId: string;
  action: 'reject';
  reason?: string;
}

export interface FeedbackReviewMessage {
  artifactId: string;
  action: 'review-submitted';
  comments: Comment[];
  feedback?: string;
}

export type FeedbackMessage = FeedbackProceedMessage | FeedbackRejectMessage | FeedbackReviewMessage;

// IPC Message wrapper for communication
export interface IPCMessage {
  id: string;
  timestamp: number;
  type: 'artifact' | 'feedback' | 'status' | 'error';
  payload: ArtifactMessage | FeedbackMessage | IPCStatusMessage | IPCErrorMessage;
}

export interface IPCStatusMessage {
  status: 'connected' | 'disconnected' | 'ready' | 'busy';
  extensionVersion?: string;
}

export interface IPCErrorMessage {
  code: string;
  message: string;
  details?: unknown;
}

// IPC Configuration
export interface IPCConfig {
  mode: 'file' | 'websocket' | 'named-pipe';
  basePath?: string;        // For file-based IPC
  port?: number;            // For WebSocket
  pipeName?: string;        // For named pipe
  pollInterval?: number;    // Polling interval in ms
  retryAttempts?: number;
  retryDelay?: number;
}

// Utility functions
export function createArtifactId(): string {
  return `artifact-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

export function createCommentId(): string {
  return `comment-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

export function createSectionId(): string {
  return `section-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

export function createTaskId(): string {
  return `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

export function createTaskGroupId(): string {
  return `group-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// ============================================
// Agent Mode Types
// ============================================

/**
 * Agent operation modes
 */
export type AgentMode = 'planning' | 'fast';

/**
 * Review policy for artifacts
 */
export type ReviewPolicy = 'always-proceed' | 'request-review';

/**
 * Task Group - groups related artifacts together
 */
export interface TaskGroup {
  id: string;
  name: string;
  description?: string;
  artifactIds: string[];
  status: 'active' | 'completed' | 'cancelled';
  mode: AgentMode;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Agent Mode configuration
 */
export interface AgentModeConfig {
  currentMode: AgentMode;
  reviewPolicy: ReviewPolicy;
  autoCreateArtifacts: boolean;
  skipArtifactsInFastMode: boolean;
  activeTaskGroupId?: string;
}

/**
 * Agent Mode state for IPC communication
 */
export interface AgentModeState {
  mode: AgentMode;
  reviewPolicy: ReviewPolicy;
  activeTaskGroup?: TaskGroup;
  artifactCount: number;
}

/**
 * Agent Mode change message
 */
export interface AgentModeChangeMessage {
  action: 'mode-change';
  mode: AgentMode;
  taskGroupId?: string;
}

/**
 * Task Group message
 */
export interface TaskGroupMessage {
  action: 'create-group' | 'update-group' | 'complete-group' | 'cancel-group';
  taskGroup: TaskGroup;
}

// Extended IPC Message types for Agent Mode
export type AgentMessage = AgentModeChangeMessage | TaskGroupMessage;
