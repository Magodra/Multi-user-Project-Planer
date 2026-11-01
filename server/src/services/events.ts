/** In-process change notifications, consumed by the WebSocket layer. */

export interface ChangeEvent {
  projectId: string;
  entityType: string;
  entityId: string;
  action: string;
  /** Plans whose views are affected (owner and recipient plans). */
  planIds: string[];
}

/** The same change for every project involved (references and approvals can span projects). */
export function perProject(
  projectIds: Iterable<string>,
  event: Omit<ChangeEvent, "projectId">,
): ChangeEvent[] {
  return [...new Set(projectIds)].map((projectId) => ({ ...event, projectId }));
}

type Listener = (event: ChangeEvent) => void;

export class EventBus {
  private readonly listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(events: ChangeEvent | ChangeEvent[]): void {
    for (const event of Array.isArray(events) ? events : [events]) {
      for (const listener of this.listeners) {
        try {
          listener(event);
        } catch (err) {
          console.error("Event listener failed", err);
        }
      }
    }
  }
}
