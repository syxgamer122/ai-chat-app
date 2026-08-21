export interface RevisionInfo {
  revision?: number;
  revisionOriginClientId?: string;
}

export function compareRevision(
  a: RevisionInfo,
  b: RevisionInfo,
): number {
  const revisionA = a.revision ?? 0;
  const revisionB = b.revision ?? 0;

  if (revisionA !== revisionB) {
    return revisionA - revisionB;
  }

  return (
    (a.revisionOriginClientId ?? "").localeCompare(
      b.revisionOriginClientId ?? "",
    )
  );
}

export function isRevisionNewer(
  incoming: RevisionInfo,
  current: RevisionInfo,
): boolean {
  return compareRevision(incoming, current) > 0;
}
