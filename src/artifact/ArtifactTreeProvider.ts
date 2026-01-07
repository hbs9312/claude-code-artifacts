import * as vscode from 'vscode';
import { ArtifactManager } from './ArtifactManager';
import { Artifact, ArtifactType, ArtifactStatus } from './types';

/**
 * Tree item representing an artifact in the sidebar
 */
class ArtifactTreeItem extends vscode.TreeItem {
  constructor(
    public readonly artifact: Artifact,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(artifact.title, collapsibleState);

    this.id = artifact.id;
    this.tooltip = `${artifact.type} - ${artifact.status}`;
    this.description = artifact.status;

    // Set icon based on artifact type
    this.iconPath = this.getIcon(artifact.type, artifact.status);

    // Set context value for context menu (includes type and status)
    this.contextValue = `artifact-${artifact.type}-${artifact.status}`;

    // Command to open artifact when clicked
    this.command = {
      command: 'claudeArtifacts.openArtifact',
      title: 'Open Artifact',
      arguments: [artifact],
    };
  }

  private getIcon(type: ArtifactType, status: ArtifactStatus): vscode.ThemeIcon {
    // Use different icon colors based on status
    let color: vscode.ThemeColor | undefined;
    if (status === 'completed' || status === 'approved') {
      color = new vscode.ThemeColor('testing.iconPassed');
    } else if (status === 'pending-review') {
      color = new vscode.ThemeColor('editorWarning.foreground');
    }

    switch (type) {
      case 'task-list':
        return new vscode.ThemeIcon('tasklist', color);
      case 'implementation-plan':
        return new vscode.ThemeIcon('file-code', color);
      case 'walkthrough':
        return new vscode.ThemeIcon('book', color);
      default:
        return new vscode.ThemeIcon('file', color);
    }
  }
}

/**
 * Tree item representing a group of artifacts by type
 */
class ArtifactGroupTreeItem extends vscode.TreeItem {
  constructor(
    public readonly type: ArtifactType,
    public readonly count: number
  ) {
    super(
      ArtifactGroupTreeItem.getLabel(type),
      count > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed
    );

    this.contextValue = 'artifact-group';
    this.iconPath = this.getIcon(type);
    this.description = `${count}`;
  }

  private static getLabel(type: ArtifactType): string {
    switch (type) {
      case 'task-list':
        return 'Task Lists';
      case 'implementation-plan':
        return 'Implementation Plans';
      case 'walkthrough':
        return 'Walkthroughs';
      default:
        return type;
    }
  }

  private getIcon(type: ArtifactType): vscode.ThemeIcon {
    switch (type) {
      case 'task-list':
        return new vscode.ThemeIcon('checklist');
      case 'implementation-plan':
        return new vscode.ThemeIcon('symbol-method');
      case 'walkthrough':
        return new vscode.ThemeIcon('notebook');
      default:
        return new vscode.ThemeIcon('folder');
    }
  }
}

/**
 * ArtifactTreeProvider provides the tree data for the artifacts sidebar view
 */
export class ArtifactTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
  public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private artifactManager: ArtifactManager) {
    // Refresh tree when artifacts change
    artifactManager.onDidChangeArtifacts(() => {
      this.refresh();
    });
  }

  /**
   * Refresh the tree view
   */
  public refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  /**
   * Get tree item representation
   */
  public getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  /**
   * Get children of a tree item
   */
  public getChildren(element?: vscode.TreeItem): Thenable<vscode.TreeItem[]> {
    if (!element) {
      // Root level - show groups
      return Promise.resolve(this.getArtifactGroups());
    }

    if (element instanceof ArtifactGroupTreeItem) {
      // Group level - show artifacts of that type
      return Promise.resolve(this.getArtifactsOfType(element.type));
    }

    return Promise.resolve([]);
  }

  /**
   * Get artifact groups
   */
  private getArtifactGroups(): ArtifactGroupTreeItem[] {
    const types: ArtifactType[] = ['task-list', 'implementation-plan', 'walkthrough'];

    return types.map(type => {
      const count = this.artifactManager.getArtifactsByType(type).length;
      return new ArtifactGroupTreeItem(type, count);
    });
  }

  /**
   * Get artifacts of a specific type
   */
  private getArtifactsOfType(type: ArtifactType): ArtifactTreeItem[] {
    return this.artifactManager
      .getArtifactsByType(type)
      .map(artifact => new ArtifactTreeItem(artifact, vscode.TreeItemCollapsibleState.None));
  }

  /**
   * Dispose of resources
   */
  public dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
