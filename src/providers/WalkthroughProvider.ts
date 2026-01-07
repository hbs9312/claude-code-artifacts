import * as vscode from 'vscode';
import { ArtifactManager } from '../artifact/ArtifactManager';
import {
  WalkthroughArtifact,
  WalkthroughSection,
  WalkthroughFileChange,
  createSectionId,
} from '../artifact/types';

/**
 * WalkthroughProvider handles Walkthrough artifact operations
 */
export class WalkthroughProvider {
  private readonly _onDidUpdateWalkthrough = new vscode.EventEmitter<WalkthroughArtifact>();
  public readonly onDidUpdateWalkthrough = this._onDidUpdateWalkthrough.event;

  constructor(private readonly artifactManager: ArtifactManager) {}

  /**
   * Get a Walkthrough artifact by ID
   */
  public getWalkthrough(id: string): WalkthroughArtifact | undefined {
    const artifact = this.artifactManager.getArtifact(id);
    if (artifact?.type === 'walkthrough') {
      return artifact as WalkthroughArtifact;
    }
    return undefined;
  }

  /**
   * Get all Walkthrough artifacts
   */
  public getAllWalkthroughs(): WalkthroughArtifact[] {
    return this.artifactManager.getArtifactsByType('walkthrough') as WalkthroughArtifact[];
  }

  /**
   * Create a new Walkthrough
   */
  public async createWalkthrough(title: string, summary: string = ''): Promise<WalkthroughArtifact> {
    return this.artifactManager.createWalkthrough(title, summary);
  }

  /**
   * Update walkthrough summary
   */
  public async updateSummary(
    walkthroughId: string,
    summary: string
  ): Promise<WalkthroughArtifact | undefined> {
    const walkthrough = this.getWalkthrough(walkthroughId);
    if (!walkthrough) {
      return undefined;
    }

    await this.artifactManager.updateArtifact(walkthroughId, { summary });

    const updated = this.getWalkthrough(walkthroughId);
    if (updated) {
      this._onDidUpdateWalkthrough.fire(updated);
    }

    return updated;
  }

  /**
   * Add a key point
   */
  public async addKeyPoint(walkthroughId: string, keyPoint: string): Promise<string[] | undefined> {
    const walkthrough = this.getWalkthrough(walkthroughId);
    if (!walkthrough) {
      return undefined;
    }

    const updatedKeyPoints = [...walkthrough.keyPoints, keyPoint];
    await this.artifactManager.updateArtifact(walkthroughId, { keyPoints: updatedKeyPoints });

    const updated = this.getWalkthrough(walkthroughId);
    if (updated) {
      this._onDidUpdateWalkthrough.fire(updated);
    }

    return updatedKeyPoints;
  }

  /**
   * Update a key point
   */
  public async updateKeyPoint(
    walkthroughId: string,
    index: number,
    keyPoint: string
  ): Promise<string[] | undefined> {
    const walkthrough = this.getWalkthrough(walkthroughId);
    if (!walkthrough || index < 0 || index >= walkthrough.keyPoints.length) {
      return undefined;
    }

    const updatedKeyPoints = [...walkthrough.keyPoints];
    updatedKeyPoints[index] = keyPoint;

    await this.artifactManager.updateArtifact(walkthroughId, { keyPoints: updatedKeyPoints });

    const updated = this.getWalkthrough(walkthroughId);
    if (updated) {
      this._onDidUpdateWalkthrough.fire(updated);
    }

    return updatedKeyPoints;
  }

  /**
   * Remove a key point
   */
  public async removeKeyPoint(walkthroughId: string, index: number): Promise<string[] | undefined> {
    const walkthrough = this.getWalkthrough(walkthroughId);
    if (!walkthrough || index < 0 || index >= walkthrough.keyPoints.length) {
      return undefined;
    }

    const updatedKeyPoints = walkthrough.keyPoints.filter((_, i) => i !== index);
    await this.artifactManager.updateArtifact(walkthroughId, { keyPoints: updatedKeyPoints });

    const updated = this.getWalkthrough(walkthroughId);
    if (updated) {
      this._onDidUpdateWalkthrough.fire(updated);
    }

    return updatedKeyPoints;
  }

  /**
   * Set all key points
   */
  public async setKeyPoints(walkthroughId: string, keyPoints: string[]): Promise<string[] | undefined> {
    const walkthrough = this.getWalkthrough(walkthroughId);
    if (!walkthrough) {
      return undefined;
    }

    await this.artifactManager.updateArtifact(walkthroughId, { keyPoints });

    const updated = this.getWalkthrough(walkthroughId);
    if (updated) {
      this._onDidUpdateWalkthrough.fire(updated);
    }

    return keyPoints;
  }

  /**
   * Add a section
   */
  public async addSection(
    walkthroughId: string,
    title: string,
    content: string = ''
  ): Promise<WalkthroughSection | undefined> {
    const walkthrough = this.getWalkthrough(walkthroughId);
    if (!walkthrough) {
      return undefined;
    }

    const maxOrder = walkthrough.sections.reduce((max, s) => Math.max(max, s.order), 0);

    const newSection: WalkthroughSection = {
      id: createSectionId(),
      title,
      content,
      order: maxOrder + 1,
    };

    const updatedSections = [...walkthrough.sections, newSection];
    await this.artifactManager.updateArtifact(walkthroughId, { sections: updatedSections });

    const updated = this.getWalkthrough(walkthroughId);
    if (updated) {
      this._onDidUpdateWalkthrough.fire(updated);
    }

    return newSection;
  }

  /**
   * Update a section
   */
  public async updateSection(
    walkthroughId: string,
    sectionId: string,
    updates: Partial<Omit<WalkthroughSection, 'id'>>
  ): Promise<WalkthroughSection | undefined> {
    const walkthrough = this.getWalkthrough(walkthroughId);
    if (!walkthrough) {
      return undefined;
    }

    const sectionIndex = walkthrough.sections.findIndex(s => s.id === sectionId);
    if (sectionIndex === -1) {
      return undefined;
    }

    const updatedSection = {
      ...walkthrough.sections[sectionIndex],
      ...updates,
    };

    const updatedSections = [...walkthrough.sections];
    updatedSections[sectionIndex] = updatedSection;

    await this.artifactManager.updateArtifact(walkthroughId, { sections: updatedSections });

    const updated = this.getWalkthrough(walkthroughId);
    if (updated) {
      this._onDidUpdateWalkthrough.fire(updated);
    }

    return updatedSection;
  }

  /**
   * Delete a section
   */
  public async deleteSection(walkthroughId: string, sectionId: string): Promise<boolean> {
    const walkthrough = this.getWalkthrough(walkthroughId);
    if (!walkthrough) {
      return false;
    }

    const sectionIndex = walkthrough.sections.findIndex(s => s.id === sectionId);
    if (sectionIndex === -1) {
      return false;
    }

    const updatedSections = walkthrough.sections.filter(s => s.id !== sectionId);
    await this.artifactManager.updateArtifact(walkthroughId, { sections: updatedSections });

    const updated = this.getWalkthrough(walkthroughId);
    if (updated) {
      this._onDidUpdateWalkthrough.fire(updated);
    }

    return true;
  }

  /**
   * Reorder sections
   */
  public async reorderSections(walkthroughId: string, sectionIds: string[]): Promise<boolean> {
    const walkthrough = this.getWalkthrough(walkthroughId);
    if (!walkthrough) {
      return false;
    }

    const updatedSections = sectionIds
      .map((id, index) => {
        const section = walkthrough.sections.find(s => s.id === id);
        if (section) {
          return { ...section, order: index + 1 };
        }
        return null;
      })
      .filter((s): s is WalkthroughSection => s !== null);

    await this.artifactManager.updateArtifact(walkthroughId, { sections: updatedSections });

    const updated = this.getWalkthrough(walkthroughId);
    if (updated) {
      this._onDidUpdateWalkthrough.fire(updated);
    }

    return true;
  }

  /**
   * Add a changed file
   */
  public async addChangedFile(
    walkthroughId: string,
    filePath: string,
    changeType: WalkthroughFileChange['changeType'],
    linesAdded: number = 0,
    linesRemoved: number = 0,
    summary: string = ''
  ): Promise<WalkthroughFileChange | undefined> {
    const walkthrough = this.getWalkthrough(walkthroughId);
    if (!walkthrough) {
      return undefined;
    }

    // Check if file already exists
    const existingIndex = walkthrough.changedFiles.findIndex(f => f.filePath === filePath);

    const fileChange: WalkthroughFileChange = {
      filePath,
      changeType,
      linesAdded,
      linesRemoved,
      summary,
    };

    let updatedChangedFiles: WalkthroughFileChange[];

    if (existingIndex !== -1) {
      // Update existing
      updatedChangedFiles = [...walkthrough.changedFiles];
      updatedChangedFiles[existingIndex] = fileChange;
    } else {
      // Add new
      updatedChangedFiles = [...walkthrough.changedFiles, fileChange];
    }

    await this.artifactManager.updateArtifact(walkthroughId, { changedFiles: updatedChangedFiles });

    const updated = this.getWalkthrough(walkthroughId);
    if (updated) {
      this._onDidUpdateWalkthrough.fire(updated);
    }

    return fileChange;
  }

  /**
   * Update a changed file
   */
  public async updateChangedFile(
    walkthroughId: string,
    filePath: string,
    updates: Partial<Omit<WalkthroughFileChange, 'filePath'>>
  ): Promise<WalkthroughFileChange | undefined> {
    const walkthrough = this.getWalkthrough(walkthroughId);
    if (!walkthrough) {
      return undefined;
    }

    const fileIndex = walkthrough.changedFiles.findIndex(f => f.filePath === filePath);
    if (fileIndex === -1) {
      return undefined;
    }

    const updatedFile = {
      ...walkthrough.changedFiles[fileIndex],
      ...updates,
    };

    const updatedChangedFiles = [...walkthrough.changedFiles];
    updatedChangedFiles[fileIndex] = updatedFile;

    await this.artifactManager.updateArtifact(walkthroughId, { changedFiles: updatedChangedFiles });

    const updated = this.getWalkthrough(walkthroughId);
    if (updated) {
      this._onDidUpdateWalkthrough.fire(updated);
    }

    return updatedFile;
  }

  /**
   * Remove a changed file
   */
  public async removeChangedFile(walkthroughId: string, filePath: string): Promise<boolean> {
    const walkthrough = this.getWalkthrough(walkthroughId);
    if (!walkthrough) {
      return false;
    }

    const fileIndex = walkthrough.changedFiles.findIndex(f => f.filePath === filePath);
    if (fileIndex === -1) {
      return false;
    }

    const updatedChangedFiles = walkthrough.changedFiles.filter(f => f.filePath !== filePath);
    await this.artifactManager.updateArtifact(walkthroughId, { changedFiles: updatedChangedFiles });

    const updated = this.getWalkthrough(walkthroughId);
    if (updated) {
      this._onDidUpdateWalkthrough.fire(updated);
    }

    return true;
  }

  /**
   * Set all changed files
   */
  public async setChangedFiles(
    walkthroughId: string,
    changedFiles: WalkthroughFileChange[]
  ): Promise<WalkthroughFileChange[] | undefined> {
    const walkthrough = this.getWalkthrough(walkthroughId);
    if (!walkthrough) {
      return undefined;
    }

    await this.artifactManager.updateArtifact(walkthroughId, { changedFiles });

    const updated = this.getWalkthrough(walkthroughId);
    if (updated) {
      this._onDidUpdateWalkthrough.fire(updated);
    }

    return changedFiles;
  }

  /**
   * Mark walkthrough as completed
   */
  public async complete(walkthroughId: string): Promise<WalkthroughArtifact | undefined> {
    const walkthrough = this.getWalkthrough(walkthroughId);
    if (!walkthrough) {
      return undefined;
    }

    await this.artifactManager.updateStatus(walkthroughId, 'completed');

    const updated = this.getWalkthrough(walkthroughId);
    if (updated) {
      this._onDidUpdateWalkthrough.fire(updated);
    }

    return updated;
  }

  /**
   * Get statistics for the walkthrough
   */
  public getStats(walkthroughId: string): {
    totalSections: number;
    totalFiles: number;
    totalKeyPoints: number;
    totalLinesAdded: number;
    totalLinesRemoved: number;
    filesByType: { create: number; modify: number; delete: number };
  } {
    const walkthrough = this.getWalkthrough(walkthroughId);
    if (!walkthrough) {
      return {
        totalSections: 0,
        totalFiles: 0,
        totalKeyPoints: 0,
        totalLinesAdded: 0,
        totalLinesRemoved: 0,
        filesByType: { create: 0, modify: 0, delete: 0 },
      };
    }

    const filesByType = { create: 0, modify: 0, delete: 0 };
    let totalLinesAdded = 0;
    let totalLinesRemoved = 0;

    for (const file of walkthrough.changedFiles) {
      filesByType[file.changeType]++;
      totalLinesAdded += file.linesAdded;
      totalLinesRemoved += file.linesRemoved;
    }

    return {
      totalSections: walkthrough.sections.length,
      totalFiles: walkthrough.changedFiles.length,
      totalKeyPoints: walkthrough.keyPoints.length,
      totalLinesAdded,
      totalLinesRemoved,
      filesByType,
    };
  }

  /**
   * Generate walkthrough from git diff (placeholder for future implementation)
   */
  public async generateFromGitDiff(
    walkthroughId: string,
    _diffOutput: string
  ): Promise<WalkthroughArtifact | undefined> {
    const walkthrough = this.getWalkthrough(walkthroughId);
    if (!walkthrough) {
      return undefined;
    }

    // This is a placeholder - actual implementation would parse git diff output
    // and populate changedFiles with the extracted information
    vscode.window.showInformationMessage('Git diff parsing not yet implemented');

    return walkthrough;
  }

  /**
   * Dispose of resources
   */
  public dispose(): void {
    this._onDidUpdateWalkthrough.dispose();
  }
}
