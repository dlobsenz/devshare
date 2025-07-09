import * as vscode from 'vscode';
import { Project, Peer, TransferProgress } from '@devshare/proto';
import { DevShareClient } from '../services/devshare-client';

export class DevShareTreeProvider implements vscode.TreeDataProvider<DevShareTreeItem>, vscode.TreeDragAndDropController<DevShareTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<DevShareTreeItem | undefined | null | void> = new vscode.EventEmitter<DevShareTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<DevShareTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;
  
  // Drag and drop support
  readonly dropMimeTypes = ['application/vnd.code.tree.devshare', 'text/uri-list'];
  readonly dragMimeTypes = ['application/vnd.code.tree.devshare'];
  
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

  // Drag and Drop Implementation
  async handleDrag(source: DevShareTreeItem[], treeDataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): Promise<void> {
    // For now, we'll support dragging projects to share them
    const projectItems = source.filter(item => item.project);
    
    if (projectItems.length > 0) {
      const projectData = projectItems.map(item => ({
        id: item.project!.id,
        name: item.project!.name,
        path: item.project!.path
      }));
      
      treeDataTransfer.set('application/vnd.code.tree.devshare', new vscode.DataTransferItem(JSON.stringify(projectData)));
    }
  }

  async handleDrop(target: DevShareTreeItem | undefined, dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): Promise<void> {
    // Handle dropping files/folders from VS Code explorer
    const uriListData = dataTransfer.get('text/uri-list');
    if (uriListData) {
      const uriList = uriListData.value as string;
      const uris = uriList.split('\n').filter(line => line.trim().length > 0).map(line => vscode.Uri.parse(line.trim()));
      
      if (uris.length > 0) {
        await this.handleFolderDrop(uris, target);
        return;
      }
    }

    // Handle dropping DevShare projects onto peers
    const devshareData = dataTransfer.get('application/vnd.code.tree.devshare');
    if (devshareData && target?.peer) {
      const projectData = JSON.parse(devshareData.value as string);
      await this.handleProjectDropOnPeer(projectData, target.peer);
      return;
    }
  }

  private async handleFolderDrop(uris: vscode.Uri[], target?: DevShareTreeItem): Promise<void> {
    // Filter to only directories
    const folders = [];
    for (const uri of uris) {
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.type === vscode.FileType.Directory) {
          folders.push(uri);
        }
      } catch (error) {
        // Skip files that can't be accessed
        continue;
      }
    }

    if (folders.length === 0) {
      vscode.window.showWarningMessage('Please drop folders, not individual files.');
      return;
    }

    // If dropped on a peer, share directly
    if (target?.peer) {
      for (const folder of folders) {
        await this.shareProjectWithPeer(folder.fsPath, target.peer);
      }
    } else {
      // Show peer selection dialog
      await this.showPeerSelectionForFolders(folders);
    }
  }

  private async handleProjectDropOnPeer(projectData: any[], peer: Peer): Promise<void> {
    for (const project of projectData) {
      try {
        // Request the project bundle from the daemon and share with peer
        await vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification,
          title: `Sharing ${project.name} with ${peer.name}`,
          cancellable: true
        }, async (progress, token) => {
          // This would trigger the sharing workflow
          await vscode.commands.executeCommand('devshare.shareProjectWithPeer', project.path, peer.id);
        });
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to share ${project.name}: ${error}`);
      }
    }
  }

  private async shareProjectWithPeer(projectPath: string, peer: Peer): Promise<void> {
    try {
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Sharing project with ${peer.name}`,
        cancellable: true
      }, async (progress, token) => {
        // Create and share bundle
        const result = await this.client.share({
          projectPath,
          recipients: [peer.id],
          name: require('path').basename(projectPath),
          version: '1.0.0'
        });

        if (result.bundleId) {
          // Track the transfer
          this.addTransfer(result.transferId);
          vscode.window.showInformationMessage(`Started sharing project with ${peer.name}. Transfer ID: ${result.transferId}`);
        } else {
          throw new Error('Failed to create bundle');
        }
      });
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to share project: ${error}`);
    }
  }

  private async showPeerSelectionForFolders(folders: vscode.Uri[]): Promise<void> {
    try {
      // Get available peers
      const peers = await this.client.discoverPeers();
      
      if (peers.length === 0) {
        vscode.window.showWarningMessage('No peers found. Make sure other DevShare instances are running on your network.');
        return;
      }

      // Show peer selection
      const peerItems = peers.map(peer => ({
        label: peer.name,
        description: peer.online ? 'Online' : 'Offline',
        detail: `${peer.address} - Last seen: ${peer.lastSeen}`,
        peer
      }));

      const selectedPeer = await vscode.window.showQuickPick(peerItems, {
        placeHolder: 'Select a peer to share with',
        title: `Share ${folders.length} folder(s)`
      });

      if (selectedPeer) {
        for (const folder of folders) {
          await this.shareProjectWithPeer(folder.fsPath, selectedPeer.peer);
        }
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to discover peers: ${error}`);
    }
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
