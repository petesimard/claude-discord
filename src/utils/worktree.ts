import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';

const execAsync = promisify(exec);

export interface WorktreeInfo {
  path: string;
  branch: string;
}

/**
 * Create a new Git worktree for a conversation session
 * @param mainRepoPath The path to the main Git repository
 * @param workTreeBase The base directory for worktrees (defaults to ../)
 * @param sessionId The session ID to use for the worktree name
 * @returns Information about the created worktree (path and branch)
 */
export async function createWorktree(
  mainRepoPath: string,
  workTreeBase: string,
  sessionId: string
): Promise<WorktreeInfo> {
  // Extract the base repo folder name
  const repoFolderName = path.basename(mainRepoPath);

  // Generate a worktree directory name using the repo folder name
  const worktreeName = `${repoFolderName}-${sessionId}`;
  const worktreePath = path.resolve(workTreeBase, worktreeName);

  console.log(`[Worktree] Creating worktree at: ${worktreePath}`);
  console.log(`[Worktree] Main repo: ${mainRepoPath}`);

  // Ensure the base directory exists
  if (!fs.existsSync(workTreeBase)) {
    fs.mkdirSync(workTreeBase, { recursive: true });
  }

  // Check if the main repo is a git repository
  const gitDir = path.join(mainRepoPath, '.git');
  if (!fs.existsSync(gitDir)) {
    throw new Error(`Not a git repository: ${mainRepoPath}`);
  }

  try {
    // Get the current branch name
    const { stdout: currentBranch } = await execAsync('git rev-parse --abbrev-ref HEAD', {
      cwd: mainRepoPath
    });
    const baseBranch = currentBranch.trim();

    console.log(`[Worktree] Base branch: ${baseBranch}`);

    // Create a unique branch name for this worktree
    const worktreeBranch = `worktree/${repoFolderName}-${sessionId}`;
    console.log(`[Worktree] Creating branch: ${worktreeBranch}`);

    // Create the worktree with a new branch based on the current branch
    // This creates both the worktree and a new branch in one command
    await execAsync(`git worktree add -b "${worktreeBranch}" "${worktreePath}" "${baseBranch}"`, {
      cwd: mainRepoPath
    });

    console.log(`[Worktree] ✅ Created worktree: ${worktreePath} on branch ${worktreeBranch}`);
    return {
      path: worktreePath,
      branch: worktreeBranch
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[Worktree] ❌ Failed to create worktree: ${errorMessage}`);
    throw new Error(`Failed to create worktree: ${errorMessage}`);
  }
}

/**
 * Remove a Git worktree and its associated branch
 * @param mainRepoPath The path to the main Git repository
 * @param worktreePath The path to the worktree to remove
 */
export async function removeWorktree(
  mainRepoPath: string,
  worktreePath: string
): Promise<void> {
  console.log(`[Worktree] Removing worktree: ${worktreePath}`);

  try {
    // Get the branch name before removing the worktree
    let branchName: string | undefined;
    try {
      const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', {
        cwd: worktreePath
      });
      branchName = stdout.trim();
      console.log(`[Worktree] Worktree is on branch: ${branchName}`);
    } catch (error) {
      console.log(`[Worktree] Could not determine branch name, will skip branch deletion`);
    }

    // Remove the worktree
    await execAsync(`git worktree remove "${worktreePath}" --force`, {
      cwd: mainRepoPath
    });

    console.log(`[Worktree] ✅ Removed worktree: ${worktreePath}`);

    // Delete the branch if it's a worktree branch
    if (branchName && branchName.startsWith('worktree/')) {
      try {
        await execAsync(`git branch -D "${branchName}"`, {
          cwd: mainRepoPath
        });
        console.log(`[Worktree] ✅ Deleted branch: ${branchName}`);
      } catch (error) {
        console.log(`[Worktree] ⚠️  Could not delete branch ${branchName}:`, error);
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[Worktree] ⚠️  Failed to remove worktree: ${errorMessage}`);
    // Don't throw - worktree cleanup is not critical
  }
}

/**
 * Clean up old worktrees that are no longer in use
 * @param workTreeBase The base directory containing worktrees
 * @param maxAgeHours Maximum age in hours before a worktree is considered stale
 * @param repoFolderName Optional repo folder name to filter worktrees (e.g., "my-project")
 */
export async function cleanupOldWorktrees(
  workTreeBase: string,
  maxAgeHours: number = 24,
  repoFolderName?: string
): Promise<void> {
  console.log(`[Worktree] Cleaning up worktrees older than ${maxAgeHours} hours in: ${workTreeBase}`);

  try {
    if (!fs.existsSync(workTreeBase)) {
      console.log(`[Worktree] Base directory doesn't exist, nothing to clean`);
      return;
    }

    const entries = fs.readdirSync(workTreeBase, { withFileTypes: true });
    const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
    const now = Date.now();

    for (const entry of entries) {
      // Only process directories
      if (!entry.isDirectory()) {
        continue;
      }

      // If repoFolderName is specified, only clean worktrees matching that repo
      if (repoFolderName && !entry.name.startsWith(`${repoFolderName}-`)) {
        continue;
      }

      const worktreePath = path.join(workTreeBase, entry.name);

      // Check if this is a Git worktree by looking for .git file
      const gitFilePath = path.join(worktreePath, '.git');
      if (!fs.existsSync(gitFilePath)) {
        continue;
      }

      // Verify it's a worktree (not a main repo) by checking if .git is a file
      const gitStats = fs.statSync(gitFilePath);
      if (!gitStats.isFile()) {
        continue;
      }

      const stats = fs.statSync(worktreePath);
      const age = now - stats.mtimeMs;

      if (age > maxAgeMs) {
        console.log(`[Worktree] Found stale worktree (${(age / 3600000).toFixed(1)}h old): ${entry.name}`);

        // Try to determine the main repo path from the worktree
        try {
          const { stdout } = await execAsync('git rev-parse --git-common-dir', {
            cwd: worktreePath
          });
          const gitCommonDir = stdout.trim();
          const mainRepoPath = path.dirname(gitCommonDir);

          await removeWorktree(mainRepoPath, worktreePath);
        } catch (error) {
          console.error(`[Worktree] ⚠️  Could not clean up ${entry.name}:`, error);
        }
      }
    }

    console.log(`[Worktree] ✅ Cleanup complete`);
  } catch (error) {
    console.error(`[Worktree] ⚠️  Cleanup failed:`, error);
    // Don't throw - cleanup failures are not critical
  }
}
