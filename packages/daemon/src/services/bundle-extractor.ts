import { createReadStream, createWriteStream } from 'fs';
import { mkdir, writeFile, stat } from 'fs/promises';
import { join, dirname } from 'path';
import { createGunzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { ProjectManifest } from '@devshare/proto';
import { Logger } from '../utils/logger';

const logger = new Logger('bundle-extractor');

export interface ExtractionOptions {
  bundlePath: string;
  extractPath: string;
  overwrite?: boolean;
}

export interface ExtractionResult {
  extractPath: string;
  manifest: ProjectManifest;
  fileCount: number;
  totalSize: number;
}

export class BundleExtractor {
  async extractBundle(options: ExtractionOptions): Promise<ExtractionResult> {
    logger.info(`Extracting bundle ${options.bundlePath} to ${options.extractPath}`);
    
    try {
      // Ensure extract directory exists
      await mkdir(options.extractPath, { recursive: true });
      
      // Check if directory is empty (unless overwrite is true)
      if (!options.overwrite) {
        await this.validateExtractPath(options.extractPath);
      }
      
      // Extract bundle
      const result = await this.performExtraction(options.bundlePath, options.extractPath);
      
      logger.info(`Extraction completed: ${result.fileCount} files, ${Math.round(result.totalSize / 1024)}KB`);
      return result;
      
    } catch (error) {
      logger.error(`Failed to extract bundle: ${error}`);
      throw error;
    }
  }

  private async validateExtractPath(extractPath: string): Promise<void> {
    try {
      const { readdir } = await import('fs/promises');
      const files = await readdir(extractPath);
      
      if (files.length > 0) {
        throw new Error(`Extract directory is not empty: ${extractPath}`);
      }
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        // Directory doesn't exist, which is fine
        return;
      }
      throw error;
    }
  }

  private async performExtraction(bundlePath: string, extractPath: string): Promise<ExtractionResult> {
    const readStream = createReadStream(bundlePath);
    const gunzipStream = createGunzip();
    
    let manifest: ProjectManifest;
    let fileCount = 0;
    let totalSize = 0;
    
    // Create pipeline for decompression
    const decompressedStream = readStream.pipe(gunzipStream);
    
    // Read manifest
    const manifestLengthBuffer = await this.readBytes(decompressedStream, 4);
    const manifestLength = manifestLengthBuffer.readUInt32BE(0);
    
    const manifestBuffer = await this.readBytes(decompressedStream, manifestLength);
    manifest = JSON.parse(manifestBuffer.toString('utf-8'));
    
    logger.info(`Extracting project: ${manifest.name} v${manifest.version}`);
    
    // Read file count
    const fileCountBuffer = await this.readBytes(decompressedStream, 4);
    const expectedFileCount = fileCountBuffer.readUInt32BE(0);
    
    // Extract files
    for (let i = 0; i < expectedFileCount; i++) {
      // Read file path length
      const pathLengthBuffer = await this.readBytes(decompressedStream, 4);
      const pathLength = pathLengthBuffer.readUInt32BE(0);
      
      // Read file path
      const pathBuffer = await this.readBytes(decompressedStream, pathLength);
      const filePath = pathBuffer.toString('utf-8');
      
      // Read file size
      const fileSizeBuffer = await this.readBytes(decompressedStream, 8);
      const fileSize = Number(fileSizeBuffer.readBigUInt64BE(0));
      
      // Create file directory if needed
      const fullFilePath = join(extractPath, filePath);
      await mkdir(dirname(fullFilePath), { recursive: true });
      
      // Extract file content
      const fileContent = await this.readBytes(decompressedStream, fileSize);
      await writeFile(fullFilePath, fileContent);
      
      fileCount++;
      totalSize += fileSize;
      
      logger.debug(`Extracted: ${filePath} (${Math.round(fileSize / 1024)}KB)`);
    }
    
    // Write manifest to extracted project
    const manifestPath = join(extractPath, 'devshare.yml');
    const manifestYaml = this.manifestToYaml(manifest);
    await writeFile(manifestPath, manifestYaml, 'utf-8');
    
    return {
      extractPath,
      manifest,
      fileCount,
      totalSize
    };
  }

  private async readBytes(stream: NodeJS.ReadableStream, count: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      
      const onData = (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        
        if (buffer.length >= count) {
          stream.removeListener('data', onData);
          stream.removeListener('error', onError);
          stream.removeListener('end', onEnd);
          
          const result = buffer.subarray(0, count);
          const remaining = buffer.subarray(count);
          
          // Put remaining data back
          if (remaining.length > 0) {
            stream.unshift(remaining);
          }
          
          resolve(result);
        }
      };
      
      const onError = (error: Error) => {
        stream.removeListener('data', onData);
        stream.removeListener('end', onEnd);
        reject(error);
      };
      
      const onEnd = () => {
        stream.removeListener('data', onData);
        stream.removeListener('error', onError);
        reject(new Error('Unexpected end of stream'));
      };
      
      stream.on('data', onData);
      stream.on('error', onError);
      stream.on('end', onEnd);
    });
  }

  private manifestToYaml(manifest: ProjectManifest): string {
    const lines: string[] = [];
    
    lines.push(`name: ${manifest.name}`);
    lines.push(`version: ${manifest.version}`);
    lines.push(`language: ${manifest.language}`);
    lines.push(`run: ${manifest.run}`);
    
    if (manifest.engines) {
      lines.push('engines:');
      if (manifest.engines.node) lines.push(`  node: "${manifest.engines.node}"`);
      if (manifest.engines.python) lines.push(`  python: "${manifest.engines.python}"`);
    }
    
    if (manifest.ports && manifest.ports.length > 0) {
      lines.push('ports:');
      manifest.ports.forEach(port => lines.push(`  - ${port}`));
    }
    
    if (manifest.env && manifest.env.length > 0) {
      lines.push('env:');
      manifest.env.forEach(env => lines.push(`  - ${env}`));
    }
    
    if (manifest.secrets && manifest.secrets.length > 0) {
      lines.push('secrets:');
      manifest.secrets.forEach(secret => lines.push(`  - ${secret}`));
    }
    
    return lines.join('\n') + '\n';
  }

  async validateBundle(bundlePath: string): Promise<{ valid: boolean; manifest?: ProjectManifest; error?: string }> {
    try {
      const stats = await stat(bundlePath);
      if (!stats.isFile()) {
        return { valid: false, error: 'Bundle path is not a file' };
      }

      // Try to read just the manifest to validate
      const readStream = createReadStream(bundlePath);
      const gunzipStream = createGunzip();
      const decompressedStream = readStream.pipe(gunzipStream);
      
      const manifestLengthBuffer = await this.readBytes(decompressedStream, 4);
      const manifestLength = manifestLengthBuffer.readUInt32BE(0);
      
      if (manifestLength > 1024 * 1024) { // 1MB max manifest size
        return { valid: false, error: 'Manifest too large' };
      }
      
      const manifestBuffer = await this.readBytes(decompressedStream, manifestLength);
      const manifest = JSON.parse(manifestBuffer.toString('utf-8'));
      
      // Validate required fields
      if (!manifest.name || !manifest.version || !manifest.language || !manifest.run) {
        return { valid: false, error: 'Invalid manifest: missing required fields' };
      }
      
      readStream.destroy();
      
      return { valid: true, manifest };
      
    } catch (error) {
      return { valid: false, error: `Bundle validation failed: ${error}` };
    }
  }
}
