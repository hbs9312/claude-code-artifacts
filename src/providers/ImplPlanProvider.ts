import * as vscode from 'vscode';
import { ArtifactManager } from '../artifact/ArtifactManager';
import {
  ImplementationPlanArtifact,
  PlanSection,
  FileChange,
  createSectionId,
} from '../artifact/types';

/**
 * ImplPlanProvider handles Implementation Plan artifact operations
 */
export class ImplPlanProvider {
  private readonly _onDidUpdatePlan = new vscode.EventEmitter<ImplementationPlanArtifact>();
  public readonly onDidUpdatePlan = this._onDidUpdatePlan.event;

  constructor(private readonly artifactManager: ArtifactManager) {}

  /**
   * Get an Implementation Plan artifact by ID
   */
  public getPlan(id: string): ImplementationPlanArtifact | undefined {
    const artifact = this.artifactManager.getArtifact(id);
    if (artifact?.type === 'implementation-plan') {
      return artifact as ImplementationPlanArtifact;
    }
    return undefined;
  }

  /**
   * Get all Implementation Plan artifacts
   */
  public getAllPlans(): ImplementationPlanArtifact[] {
    return this.artifactManager.getArtifactsByType('implementation-plan') as ImplementationPlanArtifact[];
  }

  /**
   * Create a new Implementation Plan
   */
  public async createPlan(title: string, summary: string = ''): Promise<ImplementationPlanArtifact> {
    return this.artifactManager.createImplementationPlan(title, summary);
  }

  /**
   * Update plan summary
   */
  public async updateSummary(planId: string, summary: string): Promise<ImplementationPlanArtifact | undefined> {
    const plan = this.getPlan(planId);
    if (!plan) {
      return undefined;
    }

    await this.artifactManager.updateArtifact(planId, { summary });

    const updated = this.getPlan(planId);
    if (updated) {
      this._onDidUpdatePlan.fire(updated);
    }

    return updated;
  }

  /**
   * Add a section to the plan
   */
  public async addSection(
    planId: string,
    title: string,
    description: string = '',
    files: string[] = []
  ): Promise<PlanSection | undefined> {
    const plan = this.getPlan(planId);
    if (!plan) {
      return undefined;
    }

    const maxOrder = plan.sections.reduce((max, s) => Math.max(max, s.order), 0);

    const newSection: PlanSection = {
      id: createSectionId(),
      title,
      description,
      files,
      changes: [],
      order: maxOrder + 1,
    };

    const updatedSections = [...plan.sections, newSection];
    await this.artifactManager.updateArtifact(planId, { sections: updatedSections });

    const updated = this.getPlan(planId);
    if (updated) {
      this._onDidUpdatePlan.fire(updated);
    }

    return newSection;
  }

  /**
   * Update a section
   */
  public async updateSection(
    planId: string,
    sectionId: string,
    updates: Partial<Omit<PlanSection, 'id'>>
  ): Promise<PlanSection | undefined> {
    const plan = this.getPlan(planId);
    if (!plan) {
      return undefined;
    }

    const sectionIndex = plan.sections.findIndex(s => s.id === sectionId);
    if (sectionIndex === -1) {
      return undefined;
    }

    const updatedSection = {
      ...plan.sections[sectionIndex],
      ...updates,
    };

    const updatedSections = [...plan.sections];
    updatedSections[sectionIndex] = updatedSection;

    await this.artifactManager.updateArtifact(planId, { sections: updatedSections });

    const updated = this.getPlan(planId);
    if (updated) {
      this._onDidUpdatePlan.fire(updated);
    }

    return updatedSection;
  }

  /**
   * Delete a section
   */
  public async deleteSection(planId: string, sectionId: string): Promise<boolean> {
    const plan = this.getPlan(planId);
    if (!plan) {
      return false;
    }

    const sectionIndex = plan.sections.findIndex(s => s.id === sectionId);
    if (sectionIndex === -1) {
      return false;
    }

    const updatedSections = plan.sections.filter(s => s.id !== sectionId);
    await this.artifactManager.updateArtifact(planId, { sections: updatedSections });

    // Update estimated changes
    await this.updateEstimatedChanges(planId);

    const updated = this.getPlan(planId);
    if (updated) {
      this._onDidUpdatePlan.fire(updated);
    }

    return true;
  }

  /**
   * Reorder sections
   */
  public async reorderSections(planId: string, sectionIds: string[]): Promise<boolean> {
    const plan = this.getPlan(planId);
    if (!plan) {
      return false;
    }

    const updatedSections = sectionIds
      .map((id, index) => {
        const section = plan.sections.find(s => s.id === id);
        if (section) {
          return { ...section, order: index + 1 };
        }
        return null;
      })
      .filter((s): s is PlanSection => s !== null);

    await this.artifactManager.updateArtifact(planId, { sections: updatedSections });

    const updated = this.getPlan(planId);
    if (updated) {
      this._onDidUpdatePlan.fire(updated);
    }

    return true;
  }

  /**
   * Add a file change to a section
   */
  public async addFileChange(
    planId: string,
    sectionId: string,
    filePath: string,
    changeType: FileChange['changeType'],
    description: string = ''
  ): Promise<FileChange | undefined> {
    const plan = this.getPlan(planId);
    if (!plan) {
      return undefined;
    }

    const sectionIndex = plan.sections.findIndex(s => s.id === sectionId);
    if (sectionIndex === -1) {
      return undefined;
    }

    const newChange: FileChange = {
      filePath,
      changeType,
      description,
    };

    const section = plan.sections[sectionIndex];
    const updatedChanges = [...section.changes, newChange];
    const updatedFiles = [...new Set([...section.files, filePath])];

    const updatedSection = {
      ...section,
      changes: updatedChanges,
      files: updatedFiles,
    };

    const updatedSections = [...plan.sections];
    updatedSections[sectionIndex] = updatedSection;

    await this.artifactManager.updateArtifact(planId, { sections: updatedSections });

    // Update estimated changes
    await this.updateEstimatedChanges(planId);

    const updated = this.getPlan(planId);
    if (updated) {
      this._onDidUpdatePlan.fire(updated);
    }

    return newChange;
  }

  /**
   * Update a file change
   */
  public async updateFileChange(
    planId: string,
    sectionId: string,
    filePath: string,
    updates: Partial<Omit<FileChange, 'filePath'>>
  ): Promise<FileChange | undefined> {
    const plan = this.getPlan(planId);
    if (!plan) {
      return undefined;
    }

    const sectionIndex = plan.sections.findIndex(s => s.id === sectionId);
    if (sectionIndex === -1) {
      return undefined;
    }

    const section = plan.sections[sectionIndex];
    const changeIndex = section.changes.findIndex(c => c.filePath === filePath);
    if (changeIndex === -1) {
      return undefined;
    }

    const updatedChange = {
      ...section.changes[changeIndex],
      ...updates,
    };

    const updatedChanges = [...section.changes];
    updatedChanges[changeIndex] = updatedChange;

    const updatedSection = {
      ...section,
      changes: updatedChanges,
    };

    const updatedSections = [...plan.sections];
    updatedSections[sectionIndex] = updatedSection;

    await this.artifactManager.updateArtifact(planId, { sections: updatedSections });

    const updated = this.getPlan(planId);
    if (updated) {
      this._onDidUpdatePlan.fire(updated);
    }

    return updatedChange;
  }

  /**
   * Remove a file change from a section
   */
  public async removeFileChange(planId: string, sectionId: string, filePath: string): Promise<boolean> {
    const plan = this.getPlan(planId);
    if (!plan) {
      return false;
    }

    const sectionIndex = plan.sections.findIndex(s => s.id === sectionId);
    if (sectionIndex === -1) {
      return false;
    }

    const section = plan.sections[sectionIndex];
    const changeIndex = section.changes.findIndex(c => c.filePath === filePath);
    if (changeIndex === -1) {
      return false;
    }

    const updatedChanges = section.changes.filter(c => c.filePath !== filePath);
    const updatedFiles = section.files.filter(f => f !== filePath);

    const updatedSection = {
      ...section,
      changes: updatedChanges,
      files: updatedFiles,
    };

    const updatedSections = [...plan.sections];
    updatedSections[sectionIndex] = updatedSection;

    await this.artifactManager.updateArtifact(planId, { sections: updatedSections });

    // Update estimated changes
    await this.updateEstimatedChanges(planId);

    const updated = this.getPlan(planId);
    if (updated) {
      this._onDidUpdatePlan.fire(updated);
    }

    return true;
  }

  /**
   * Update estimated changes count
   */
  private async updateEstimatedChanges(planId: string): Promise<void> {
    const plan = this.getPlan(planId);
    if (!plan) {
      return;
    }

    // Collect all unique files across all sections
    const allFiles = new Set<string>();
    for (const section of plan.sections) {
      for (const file of section.files) {
        allFiles.add(file);
      }
    }

    await this.artifactManager.updateArtifact(planId, { estimatedChanges: allFiles.size });
  }

  /**
   * Request review for the plan
   */
  public async requestReview(planId: string): Promise<ImplementationPlanArtifact | undefined> {
    const plan = this.getPlan(planId);
    if (!plan) {
      return undefined;
    }

    await this.artifactManager.updateStatus(planId, 'pending-review');

    const updated = this.getPlan(planId);
    if (updated) {
      this._onDidUpdatePlan.fire(updated);
    }

    return updated;
  }

  /**
   * Approve the plan
   */
  public async approve(planId: string): Promise<ImplementationPlanArtifact | undefined> {
    const plan = this.getPlan(planId);
    if (!plan) {
      return undefined;
    }

    await this.artifactManager.updateStatus(planId, 'approved');

    const updated = this.getPlan(planId);
    if (updated) {
      this._onDidUpdatePlan.fire(updated);
    }

    vscode.window.showInformationMessage(`Implementation Plan "${plan.title}" approved.`);

    return updated;
  }

  /**
   * Mark plan as completed
   */
  public async complete(planId: string): Promise<ImplementationPlanArtifact | undefined> {
    const plan = this.getPlan(planId);
    if (!plan) {
      return undefined;
    }

    await this.artifactManager.updateStatus(planId, 'completed');

    const updated = this.getPlan(planId);
    if (updated) {
      this._onDidUpdatePlan.fire(updated);
    }

    return updated;
  }

  /**
   * Get all affected files from the plan
   */
  public getAllAffectedFiles(planId: string): string[] {
    const plan = this.getPlan(planId);
    if (!plan) {
      return [];
    }

    const allFiles = new Set<string>();
    for (const section of plan.sections) {
      for (const file of section.files) {
        allFiles.add(file);
      }
    }

    return Array.from(allFiles).sort();
  }

  /**
   * Get changes by file path
   */
  public getChangesByFile(planId: string, filePath: string): FileChange[] {
    const plan = this.getPlan(planId);
    if (!plan) {
      return [];
    }

    const changes: FileChange[] = [];
    for (const section of plan.sections) {
      for (const change of section.changes) {
        if (change.filePath === filePath) {
          changes.push(change);
        }
      }
    }

    return changes;
  }

  /**
   * Get statistics for the plan
   */
  public getStats(planId: string): {
    totalSections: number;
    totalFiles: number;
    filesByType: { create: number; modify: number; delete: number };
  } {
    const plan = this.getPlan(planId);
    if (!plan) {
      return { totalSections: 0, totalFiles: 0, filesByType: { create: 0, modify: 0, delete: 0 } };
    }

    const filesByType = { create: 0, modify: 0, delete: 0 };
    const uniqueFiles = new Set<string>();

    for (const section of plan.sections) {
      for (const change of section.changes) {
        uniqueFiles.add(change.filePath);
        filesByType[change.changeType]++;
      }
    }

    return {
      totalSections: plan.sections.length,
      totalFiles: uniqueFiles.size,
      filesByType,
    };
  }

  /**
   * Dispose of resources
   */
  public dispose(): void {
    this._onDidUpdatePlan.dispose();
  }
}
