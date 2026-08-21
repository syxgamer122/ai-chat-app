export interface StreamGeneration {
  streamId: string;
  generation: number;
}

export function shouldAcceptStreamUpdate(
  active: StreamGeneration | null | undefined,
  incoming: StreamGeneration,
): boolean {
  if (!active) {
    return false;
  }

  return (
    active.streamId === incoming.streamId &&
    active.generation === incoming.generation
  );
}
