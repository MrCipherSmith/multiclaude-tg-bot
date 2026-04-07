import { useEffect, useRef } from "react";

type EventHandler = (data: unknown) => void;

export function useEventStream(
  url: string,
  handlers: Record<string, EventHandler>,
  enabled = true,
): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!enabled) return;

    let es: EventSource | null = null;
    let retryTimeout: ReturnType<typeof setTimeout>;

    function connect() {
      es = new EventSource(url);

      for (const [event] of Object.entries(handlersRef.current)) {
        es.addEventListener(event, (e: MessageEvent) => {
          try {
            const data = JSON.parse(e.data);
            handlersRef.current[event]?.(data);
          } catch {}
        });
      }

      es.onerror = () => {
        es?.close();
        // Reconnect after 5s
        retryTimeout = setTimeout(connect, 5_000);
      };
    }

    connect();

    return () => {
      clearTimeout(retryTimeout);
      es?.close();
    };
  }, [url, enabled]);
}
