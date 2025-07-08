import * as vscode from 'vscode';
import { DevShareTreeProvider } from './providers/tree-provider';
import { DevShareClient } from './services/devshare-client';

export function activate(context: vscode.ExtensionContext) {
  console.log('DevShare extension is now active!');

  // Initialize DevShare client
  const client = new DevShareClient();
  
  // Initialize tree provider
  const treeProvider = new DevShareTreeProvider(client);
  
  // Register tree data provider
  vscode.window.registerTreeDataProvider('devshare', treeProvider);

  // Register commands
  const commands = [
    vscode.commands.registerCommand('devshare.ping', async () => {
      try {
        const result = await client.ping();
        vscode.window.showInformationMessage(
          `DevShare daemon is running! Version: ${result.version}, Uptime: ${result.uptime}s`
        );
      } catch (error) {
        vscode.window.showErrorMessage(
          `Failed to ping daemon: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }),

    vscode.commands.registerCommand('devshare.shareProject', async () => {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showErrorMessage('No workspace folder open');
        return;
      }

      const projectPath = workspaceFolders[0].uri.fsPath;
      
      try {
        const result = await client.share({
          projectPath,
          recipients: [], // TODO: Implement peer selection
          name: workspaceFolders[0].name
        });
        
        vscode.window.showInformationMessage(
          `Project shared successfully! Bundle ID: ${result.bundleId}`
        );
        
        treeProvider.refresh();
      } catch (error) {
        vscode.window.showErrorMessage(
          `Failed to share project: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }),

    vscode.commands.registerCommand('devshare.importProject', async () => {
      const bundleId = await vscode.window.showInputBox({
        prompt: 'Enter bundle ID to import',
        placeHolder: 'bundle_1234567890'
      });

      if (!bundleId) {
        return;
      }

      try {
        const result = await client.import({
          bundleId,
          transferId: `transfer_${Date.now()}`
        });
        
        vscode.window.showInformationMessage(
          `Project imported successfully to: ${result.path}`
        );
        
        treeProvider.refresh();
      } catch (error) {
        vscode.window.showErrorMessage(
          `Failed to import project: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }),

    vscode.commands.registerCommand('devshare.runProject', async (item) => {
      if (!item || !item.project) {
        vscode.window.showErrorMessage('No project selected');
        return;
      }

      try {
        const result = await client.run({
          projectId: item.project.id
        });
        
        vscode.window.showInformationMessage(
          `Project started on port ${result.port} (PID: ${result.pid})`
        );
        
        treeProvider.refresh();
      } catch (error) {
        vscode.window.showErrorMessage(
          `Failed to run project: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }),

    vscode.commands.registerCommand('devshare.stopProject', async (item) => {
      if (!item || !item.project) {
        vscode.window.showErrorMessage('No project selected');
        return;
      }

      try {
        await client.stop({
          projectId: item.project.id
        });
        
        vscode.window.showInformationMessage('Project stopped successfully');
        treeProvider.refresh();
      } catch (error) {
        vscode.window.showErrorMessage(
          `Failed to stop project: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }),

    vscode.commands.registerCommand('devshare.refreshProjects', () => {
      treeProvider.refresh();
    })
  ];

  // Add all commands to subscriptions
  commands.forEach(command => context.subscriptions.push(command));

  // Initialize client connection
  client.connect().catch(error => {
    console.error('Failed to connect to DevShare daemon:', error);
    vscode.window.showWarningMessage(
      'DevShare daemon is not running. Some features may not be available.'
    );
  });

  // Update status bar
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = '$(rocket) DevShare';
  statusBarItem.tooltip = 'DevShare is active';
  statusBarItem.command = 'devshare.ping';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);
}

export function deactivate() {
  console.log('DevShare extension is now deactivated');
}
