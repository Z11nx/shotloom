/**
 * Opens a folder in the OS file manager. Arguments are passed as an array, so
 * paths are never parsed by a shell.
 */
export type FolderOpener = (absPath: string) => Promise<void>;

export const openFolderInFileManager: FolderOpener = async (absPath) => {
  const cmd =
    process.platform === "win32"
      ? ["explorer.exe", absPath]
      : process.platform === "darwin"
        ? ["open", absPath]
        : ["xdg-open", absPath];
  try {
    const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: false });
    // explorer.exe exits with code 1 even on success, so the exit code is not checked.
    proc.unref();
  } catch (err) {
    throw new Error(`Could not open the file manager (${cmd[0]}): ${(err as Error).message}`);
  }
};
