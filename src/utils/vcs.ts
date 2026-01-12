import * as fs from 'fs';
import * as path from 'path';

export type VcsType = 'git' | 'none';

/**
 * Detect if Git is being used in a directory
 */
export function detectVcs(workingPath: string): VcsType {
  // Check for Git
  const gitDir = path.join(workingPath, '.git');
  if (fs.existsSync(gitDir)) {
    return 'git';
  }

  // No VCS detected
  return 'none';
}

/**
 * Get the commit button label
 */
export function getCommitButtonLabel(vcsType: VcsType): string {
  return vcsType === 'git' ? 'Commit to Git' : 'Commit';
}
