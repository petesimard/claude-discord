import * as fs from 'fs';
import * as path from 'path';

export type VcsType = 'git' | 'svn' | 'none';

/**
 * Detect which version control system is being used in a directory
 */
export function detectVcs(workingPath: string): VcsType {
  // Check for Git
  const gitDir = path.join(workingPath, '.git');
  if (fs.existsSync(gitDir)) {
    return 'git';
  }

  // Check for SVN
  const svnDir = path.join(workingPath, '.svn');
  if (fs.existsSync(svnDir)) {
    return 'svn';
  }

  // No VCS detected
  return 'none';
}

/**
 * Get the appropriate commit button label for the VCS type
 */
export function getCommitButtonLabel(vcsType: VcsType): string {
  switch (vcsType) {
    case 'git':
      return 'Commit to Git';
    case 'svn':
      return 'Commit to SVN';
    default:
      return 'Commit';
  }
}
