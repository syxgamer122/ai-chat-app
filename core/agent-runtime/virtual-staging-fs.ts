/**
 * core/agent-runtime/virtual-staging-fs.ts
 *
 * Virtual Staging OverlayFS in RAM.
 * Mọi thao tác tạo mới, ghi đè hoặc chỉnh sửa file từ Subagent đều được bẫy
 * và lưu trữ độc quyền trong bộ nhớ RAM, bảo vệ 100% tệp trên đĩa thật
 * cho tới khi Orchestrator và người dùng phê duyệt merge.
 */

export interface VirtualFileChange {
  path: string;
  originalContent: string | null;
  newContent: string;
  modifiedAt: number;
}

export class VirtualStagingOverlayFS {
  private overlayFiles = new Map<string, VirtualFileChange>();

  public normalizePath(p: string): string {
    return p.replace(/\\/g, '/').replace(/^\.\//, '');
  }

  public async readFile(
    relPath: string,
    fallbackDiskReader?: (path: string) => Promise<string>
  ): Promise<string> {
    const key = this.normalizePath(relPath);
    const inMemory = this.overlayFiles.get(key);
    if (inMemory) {
      return inMemory.newContent;
    }

    if (fallbackDiskReader) {
      return fallbackDiskReader(relPath);
    }

    throw new Error(`[VirtualStagingOverlayFS] File '${relPath}' không tồn tại trong RAM overlay.`);
  }

  public async writeFile(
    relPath: string,
    newContent: string,
    originalContent: string | null = null
  ): Promise<void> {
    const key = this.normalizePath(relPath);
    const existing = this.overlayFiles.get(key);

    this.overlayFiles.set(key, {
      path: key,
      originalContent: existing ? existing.originalContent : originalContent,
      newContent,
      modifiedAt: Date.now(),
    });
  }

  public getModifiedPaths(): string[] {
    return Array.from(this.overlayFiles.keys());
  }

  public getChange(relPath: string): VirtualFileChange | undefined {
    return this.overlayFiles.get(this.normalizePath(relPath));
  }

  public generateConsolidatedDiff(): VirtualFileChange[] {
    return Array.from(this.overlayFiles.values());
  }

  public clear(): void {
    this.overlayFiles.clear();
  }
}
