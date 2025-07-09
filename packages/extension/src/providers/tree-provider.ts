import * as vscode from 'vscode';
import { Project, Peer, TransferProgress } from '@devshare/proto';
import { DevShareClient } from '../services/devshare-client';

export class DevShareTreeProvider implements vscode.TreeDataProvider<DevShareTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<DevShareTreeItem | undefined | null | void> = new vscode.EventEmitter<DevShareTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<DevShareTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;
  
  private activeTransfers = new Map<string, TransferProgress>();
  private refreshInterval: NodeJS.Timeout | undefined;

  constructor(private client: DevShareClient) {
    // Start periodic refresh for transfer progress
    this.startProgressTracking();
  }

  private startProgressTracking(): void {
    this.refreshInterval = setInterval(async () => {
      // Update transfer progress and refresh tree if needed
      let hasUpdates = false;
      for (const [transferId] of this.activeTransfers) {
        try {
          const progress = await this.client.getTransferProgress({ transferId });
          if (progress) {
            this.activeTransfers.set(transferId, progress);
            hasUpdates = true;
            
            // Remove completed/failed transfers after a delay
            if (progress.status === 'completed' || progress.status === 'failed' || progress.status === 'cancelled') {
              setTimeout(() => {
                this.activeTransfers.delete(transferId);
                this.refresh();
              }, 3000);
            }
          } else {
            this.activeTransfers.delete(transferId);
            hasUpdates = true;
          }
        } catch (error) {
          // Transfer might be completed or cancelled
          this.activeTransfers.delete(transferId);
          hasUpdates = true;
        }
      }
      
      if (hasUpdates) {
        this.refresh();
      }
    }, 1000); // Update every second
  }

  addTransfer(transferId: string): void {
    // Add a new transfer to track
    this.activeTransfers.set(transferId, {
      transferId,
      bundleId: '',
      totalChunks: 0,
      completedChunks: 0,
      totalBytes: 0,
      transferredBytes: 0,
      speed: 0,
      eta: 0,
      status: 'pending'
    });
    this.refresh();
  }

  dispose(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: DevShareTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: DevShareTreeItem): Promise<DevShareTreeItem[]> {
    if (!element) {
      // Root level - show main categories
      const items = [
        new DevShareTreeItem(
          'My Projects',
          vscode.TreeItemCollapsibleState.Expanded,
          'category'
        ),
        new DevShareTreeItem(
          'Team Projects',
          vscode.TreeItemCollapsibleState.Expanded,
          'category'
        )
      ];

      // Add transfers section if there are active transfers
      if (this.activeTransfers.size > 0) {
        items.push(new DevShareTreeItem(
          'Active Transfers',
          vscode.TreeItemCollapsibleState.Expanded,
          'transfers'
        ));
      }

      // Add peers section
      items.push(new DevShareTreeItem(
        'Network Peers',
        vscode.TreeItemCollapsibleState.Collapsed,
        'peers'
      ));

      // Add actions
      items.push(new DevShareTreeItem(
        '+ Share Project',
        vscode.TreeItemCollapsibleState.None,
        'action',
        {
          command: 'devshare.shareProject',
          title: 'Share Project'
        }
      ));

      return items;
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

    if (element.label === 'Active Transfers') {
      return Array.from(this.activeTransfers.values()).map(transfer => {
        const progress = Math.round((transfer.transferredBytes / transfer.totalBytes) * 100) || 0;
        const speed = transfer.speed > 0 ? `${Math.round(transfer.speed / 1024)}KB/s` : '';
        const eta = transfer.eta > 0 ? `${Math.round(transfer.eta)}s` : '';
        
        return new DevShareTreeItem(
          `${transfer.bundleId} (${progress}%) ${speed} ${eta}`,
          vscode.TreeItemCollapsibleState.None,
          `transfer-${transfer.status}`,
          {
            command: 'devshare.showTransferProgress',
            title: 'Show Transfer Progress',
            arguments: [transfer.transferId]
          },
          undefined,
          undefined,
          transfer
        );
      });
    }

    if (element.label === 'Network Peers') {
      try {
        const peers = await this.client.listPeers();
        const items = peers.map(peer => new DevShareTreeItem(
          `${peer.name} (${peer.online ? 'online' : 'offline'})`,
          vscode.TreeItemCollapsibleState.None,
          peer.online ? 'peer-online' : 'peer-offline',
          undefined,
          undefined,
          peer
        ));

        // Add manual peer addition option
        items.push(new DevShareTreeItem(
          '+ Add Peer',
          vscode.TreeItemCollapsibleState.None,
          'add-peer',
          {
            command: 'devshare.addManualPeer',
            title: 'Add Manual Peer'
          }
        ));

        return items;
      } catch (error) {
        return [
          new DevShareTreeItem(
            'Unable to load peers',
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
    public readonly project?: Project,
    public readonly peer?: Peer,
    public readonly transfer?: TransferProgress
  ) {
    super(label, collapsibleState);

    this.tooltip = this.getTooltip();
    this.iconPath = this.getIcon();
  }

  private getTooltip(): string {
    if (this.project) {
      return `${this.project.name} v${this.project.version}\nStatus: ${this.project.status}\nOwner: ${this.project.owner}\nPath: ${this.project.path}`;
    }
    if (this.peer) {
      return `${this.peer.name}\nID: ${this.peer.id}\nAddress: ${this.peer.address || 'Unknown'}\nLast seen: ${this.peer.lastSeen}`;
    }
    if (this.transfer) {
      const progress = Math.round((this.transfer.transferredBytes / this.transfer.totalBytes) * 100) || 0;
      return `Transfer: ${this.transfer.bundleId}\nProgress: ${progress}%\nStatus: ${this.transfer.status}\nSpeed: ${Math.round(this.transfer.speed / 1024)}KB/s`;
    }
    return this.label;
  }

  private getIcon(): vscode.ThemeIcon | undefined {
    switch (this.contextValue) {
      case 'category':
        return new vscode.ThemeIcon('folder');
      case 'transfers':
        return new vscode.ThemeIcon('sync');
      case 'peers':
        return new vscode.ThemeIcon('organization');
      case 'action':
        return new vscode.ThemeIcon('add');
      case 'add-peer':
        return new vscode.ThemeIcon('person-add');
      case 'project-running':
        return new vscode.ThemeIcon('play', new vscode.ThemeColor('charts.green'));
      case 'project-stopped':
        return new vscode.ThemeIcon('stop', new vscode.ThemeColor('charts.red'));
      case 'peer-online':
        return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'));
      case 'peer-offline':
        return new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('charts.red'));
      case 'transfer-pending':
        return new vscode.ThemeIcon('clock', new vscode.ThemeColor('charts.yellow'));
      case 'transfer-transferring':
        return new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.blue'));
      case 'transfer-completed':
        return new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
      case 'transfer-failed':
        return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
      case 'transfer-cancelled':
        return new vscode.ThemeIcon('close', new vscode.ThemeColor('charts.orange'));
      case 'error':
        return new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
      default:
        return undefined;
    }
  }
}
