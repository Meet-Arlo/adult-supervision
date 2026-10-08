const BUILDER_BRANCH = /^slop-stop\/([^/]+)\/.+$/;

export function parseBuilderBranch(headBranch: string): string | null {
  const match = headBranch.match(BUILDER_BRANCH);
  if (!match) {
    return null;
  }
  return match[1];
}

export function builderBranchPrefix(builder: string): string {
  return `slop-stop/${builder}/`;
}
