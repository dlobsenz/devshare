import * as vscode from 'vscode';
import { Project } from '@devshare/proto';
import { DevShareClient } from '../services/devshare-client';

export class DevShareTreeProvider implements vscode.TreeDataProvider<DevShareTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<DevShareTreeItem | undefined | null | void> = new vscode.EventEmitter<DevShareTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<DevShareTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

  constructor(private client: DevShareClient) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: DevShareTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: DevShareTreeItem): Promise<DevShareTreeItem[]> {
    if (!element) {
      // Root level - show main categories
      return [
        new DevShareTreeItem(
          'My Projects',
          vscode.TreeItemCollapsibleState.Expanded,
          'category'
        ),
        new DevShareTreeItem(
          'Team Projects',
          vscode.TreeItemCollapsibleState.Expanded,
          'category'
        ),
        new DevShareTreeItem(
          '+ Share Project',
          vscode.TreeItemCollapsibleState.None,
          'action',
          {
            command: 'devshare.shareProject',
            title: 'Share Project'
          }
        )
      ];
    }

    if (element.label === 'My Projects' || element.label === 'Team Projects') {
      try {
        const projects = await this.client.listProjects();
        return projects.map(project => new DevShareTreeItem(
          `${project.name} (${project.version})`,
          vscode.TreeItemCollapsibleState.None,
          project.status === 'running' ? 'project-running' : 'project-stopped',
          undefined,
          project
        ));
      } catch (error) {
        // If daemon is not running, show placeholder
        return [
          new DevShareTreeItem(
            'Daemon not running',
            vscode.TreeItemCollapsibleState.None,
            'error'
          )
        ];
      }
    }

    return [];
  }
}

export class DevShareTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly contextValue: string,
    public readonly command?: vscode.Command,
    public readonly project?: Project
  ) {
    super(label, collapsibleState);

    this.tooltip = this.getTooltip();
    this.iconPath = this.getIcon();
  }

  private getTooltip(): string {
    if (this.project) {
      return `${this.project.name} v${this.project.version}\nStatus: ${this.project.status}\nOwner: ${this.project.owner}\nPath: ${this.project.path}`;
    }
    return this.label;
  }

  private getIcon(): vscode.ThemeIcon | undefined {
    switch (this.contextValue) {
      case 'category':
        return new vscode.ThemeIcon('folder');
      case 'action':
        return new vscode.ThemeIcon('add');
      case 'project-running':
        return new vscode.ThemeIcon('play', new vscode.ThemeColor('charts.green'));
      case 'project-stopped':
        return new vscode.ThemeIcon('stop', new vscode.ThemeColor('charts.red'));
      case 'error':
        return new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
      default:
        return undefined;
    }
  }
}
