/**
 * Git utility functions for committing and managing changes
 */

/**
 * Commits changes and returns the commit hash and message.
 * @param workingPath The path to the working directory
 * @returns Promise that resolves to commit info (hash and message) or null if no changes or error
 */
export async function commitAndGetInfo(
  workingPath: string
): Promise<{ hash: string; message: string } | null> {
  try {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    // Git workflow
    const statusResult = await execAsync('git status --porcelain', { cwd: workingPath });

    if (!statusResult.stdout.trim()) {
      // No changes to commit
      return null;
    }

    // Parse git status to generate commit message
    const changes = statusResult.stdout.trim().split('\n');
    const added = changes.filter(line => line.startsWith('A') || line.startsWith('??')).length;
    const modified = changes.filter(line => line.startsWith('M') || line.startsWith(' M')).length;
    const deleted = changes.filter(line => line.startsWith('D') || line.startsWith(' D')).length;

    // Generate auto commit message
    const messageParts = [];
    if (added > 0) messageParts.push(`${added} file${added > 1 ? 's' : ''} added`);
    if (modified > 0) messageParts.push(`${modified} file${modified > 1 ? 's' : ''} modified`);
    if (deleted > 0) messageParts.push(`${deleted} file${deleted > 1 ? 's' : ''} deleted`);

    const commitMessage = messageParts.length > 0
      ? `Auto-commit: ${messageParts.join(', ')}`
      : 'Auto-commit: Changes made via Claude Code';

    // Add all changes and commit
    await execAsync('git add -A', { cwd: workingPath });
    await execAsync(`git commit -m "${commitMessage.replace(/"/g, '\\"')}\n\nCo-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"`, {
      cwd: workingPath
    });

    // Get the commit hash
    const hashResult = await execAsync('git log -1 --pretty=format:"%H"', { cwd: workingPath });
    const hash = hashResult.stdout.trim();

    return { hash, message: commitMessage };
  } catch (error) {
    // Handle any errors during execution
    console.error('Error committing:', error);
    return null;
  }
}
