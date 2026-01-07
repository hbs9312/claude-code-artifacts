import * as vscode from 'vscode';
import { ArtifactManager } from '../artifact/ArtifactManager';
import {
  TaskListArtifact,
  TaskListItem,
  TaskStatus,
  TaskCategory,
  createTaskId,
} from '../artifact/types';

/**
 * TaskListProvider handles Task List artifact operations
 */
export class TaskListProvider {
  private readonly _onDidUpdateTaskList = new vscode.EventEmitter<TaskListArtifact>();
  public readonly onDidUpdateTaskList = this._onDidUpdateTaskList.event;

  constructor(private readonly artifactManager: ArtifactManager) {}

  /**
   * Get a Task List artifact by ID
   */
  public getTaskList(id: string): TaskListArtifact | undefined {
    const artifact = this.artifactManager.getArtifact(id);
    if (artifact?.type === 'task-list') {
      return artifact as TaskListArtifact;
    }
    return undefined;
  }

  /**
   * Get all Task List artifacts
   */
  public getAllTaskLists(): TaskListArtifact[] {
    return this.artifactManager.getArtifactsByType('task-list') as TaskListArtifact[];
  }

  /**
   * Create a new Task List
   */
  public async createTaskList(title: string): Promise<TaskListArtifact> {
    return this.artifactManager.createTaskList(title);
  }

  /**
   * Add a task item to a Task List
   */
  public async addTask(
    taskListId: string,
    text: string,
    category: TaskCategory = 'other',
    status: TaskStatus = 'pending'
  ): Promise<TaskListItem | undefined> {
    const taskList = this.getTaskList(taskListId);
    if (!taskList) {
      return undefined;
    }

    const maxOrder = taskList.items.reduce((max, item) => Math.max(max, item.order), 0);

    const newTask: TaskListItem = {
      id: createTaskId(),
      text,
      status,
      category,
      order: maxOrder + 1,
    };

    const updatedItems = [...taskList.items, newTask];
    await this.artifactManager.updateArtifact(taskListId, { items: updatedItems });

    const updated = this.getTaskList(taskListId);
    if (updated) {
      this._onDidUpdateTaskList.fire(updated);
    }

    return newTask;
  }

  /**
   * Update a task item
   */
  public async updateTask(
    taskListId: string,
    taskId: string,
    updates: Partial<Omit<TaskListItem, 'id'>>
  ): Promise<TaskListItem | undefined> {
    const taskList = this.getTaskList(taskListId);
    if (!taskList) {
      return undefined;
    }

    const taskIndex = taskList.items.findIndex(t => t.id === taskId);
    if (taskIndex === -1) {
      return undefined;
    }

    const updatedTask = {
      ...taskList.items[taskIndex],
      ...updates,
    };

    const updatedItems = [...taskList.items];
    updatedItems[taskIndex] = updatedTask;

    await this.artifactManager.updateArtifact(taskListId, { items: updatedItems });

    const updated = this.getTaskList(taskListId);
    if (updated) {
      this._onDidUpdateTaskList.fire(updated);
    }

    return updatedTask;
  }

  /**
   * Update task status
   */
  public async updateTaskStatus(
    taskListId: string,
    taskId: string,
    status: TaskStatus
  ): Promise<TaskListItem | undefined> {
    return this.updateTask(taskListId, taskId, { status });
  }

  /**
   * Mark task as completed
   */
  public async completeTask(taskListId: string, taskId: string): Promise<TaskListItem | undefined> {
    return this.updateTaskStatus(taskListId, taskId, 'completed');
  }

  /**
   * Mark task as in progress
   */
  public async startTask(taskListId: string, taskId: string): Promise<TaskListItem | undefined> {
    return this.updateTaskStatus(taskListId, taskId, 'in-progress');
  }

  /**
   * Delete a task item
   */
  public async deleteTask(taskListId: string, taskId: string): Promise<boolean> {
    const taskList = this.getTaskList(taskListId);
    if (!taskList) {
      return false;
    }

    const taskIndex = taskList.items.findIndex(t => t.id === taskId);
    if (taskIndex === -1) {
      return false;
    }

    const updatedItems = taskList.items.filter(t => t.id !== taskId);
    await this.artifactManager.updateArtifact(taskListId, { items: updatedItems });

    const updated = this.getTaskList(taskListId);
    if (updated) {
      this._onDidUpdateTaskList.fire(updated);
    }

    return true;
  }

  /**
   * Reorder tasks
   */
  public async reorderTasks(taskListId: string, taskIds: string[]): Promise<boolean> {
    const taskList = this.getTaskList(taskListId);
    if (!taskList) {
      return false;
    }

    const updatedItems = taskIds
      .map((id, index) => {
        const task = taskList.items.find(t => t.id === id);
        if (task) {
          return { ...task, order: index + 1 };
        }
        return null;
      })
      .filter((t): t is TaskListItem => t !== null);

    await this.artifactManager.updateArtifact(taskListId, { items: updatedItems });

    const updated = this.getTaskList(taskListId);
    if (updated) {
      this._onDidUpdateTaskList.fire(updated);
    }

    return true;
  }

  /**
   * Get tasks by category
   */
  public getTasksByCategory(taskListId: string, category: TaskCategory): TaskListItem[] {
    const taskList = this.getTaskList(taskListId);
    if (!taskList) {
      return [];
    }
    return taskList.items.filter(t => t.category === category).sort((a, b) => a.order - b.order);
  }

  /**
   * Get tasks by status
   */
  public getTasksByStatus(taskListId: string, status: TaskStatus): TaskListItem[] {
    const taskList = this.getTaskList(taskListId);
    if (!taskList) {
      return [];
    }
    return taskList.items.filter(t => t.status === status).sort((a, b) => a.order - b.order);
  }

  /**
   * Get progress statistics
   */
  public getProgress(taskListId: string): {
    total: number;
    completed: number;
    inProgress: number;
    pending: number;
    percentage: number;
  } {
    const taskList = this.getTaskList(taskListId);
    if (!taskList) {
      return { total: 0, completed: 0, inProgress: 0, pending: 0, percentage: 0 };
    }

    const total = taskList.items.length;
    const completed = taskList.items.filter(t => t.status === 'completed').length;
    const inProgress = taskList.items.filter(t => t.status === 'in-progress').length;
    const pending = taskList.items.filter(t => t.status === 'pending').length;
    const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;

    return { total, completed, inProgress, pending, percentage };
  }

  /**
   * Bulk add tasks
   */
  public async addTasks(
    taskListId: string,
    tasks: Array<{ text: string; category?: TaskCategory; status?: TaskStatus }>
  ): Promise<TaskListItem[]> {
    const taskList = this.getTaskList(taskListId);
    if (!taskList) {
      return [];
    }

    const maxOrder = taskList.items.reduce((max, item) => Math.max(max, item.order), 0);

    const newTasks: TaskListItem[] = tasks.map((task, index) => ({
      id: createTaskId(),
      text: task.text,
      status: task.status || 'pending',
      category: task.category || 'other',
      order: maxOrder + index + 1,
    }));

    const updatedItems = [...taskList.items, ...newTasks];
    await this.artifactManager.updateArtifact(taskListId, { items: updatedItems });

    const updated = this.getTaskList(taskListId);
    if (updated) {
      this._onDidUpdateTaskList.fire(updated);
    }

    return newTasks;
  }

  /**
   * Clear completed tasks
   */
  public async clearCompletedTasks(taskListId: string): Promise<number> {
    const taskList = this.getTaskList(taskListId);
    if (!taskList) {
      return 0;
    }

    const completedCount = taskList.items.filter(t => t.status === 'completed').length;
    const updatedItems = taskList.items.filter(t => t.status !== 'completed');

    await this.artifactManager.updateArtifact(taskListId, { items: updatedItems });

    const updated = this.getTaskList(taskListId);
    if (updated) {
      this._onDidUpdateTaskList.fire(updated);
    }

    return completedCount;
  }

  /**
   * Dispose of resources
   */
  public dispose(): void {
    this._onDidUpdateTaskList.dispose();
  }
}
