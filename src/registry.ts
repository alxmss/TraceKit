// [timestamp, traceId, sliceName, fnPath]
export type TraceRecord = readonly [
  timestamp: number,
  traceId: string,
  sliceName: string,
  fnPath: string,
];

export interface TraceRegistry {
  record(traceId: string, sliceName: string, fnPath: string): void;
  drain(): TraceRecord[];
  snapshot(): readonly TraceRecord[];
  onFlush: ((record: TraceRecord) => void) | undefined;
}

const MAX_RECORDS =
  typeof process !== "undefined" && process.env["TRACEKIT_MAX_RECORDS"]
    ? parseInt(process.env["TRACEKIT_MAX_RECORDS"], 10)
    : 10_000;

function createRegistry(): TraceRegistry {
  const buf: TraceRecord[] = [];
  let head = 0;
  let full = false;

  return {
    onFlush: undefined,

    record(traceId, sliceName, fnPath) {
      const entry: TraceRecord = [Date.now(), traceId, sliceName, fnPath];

      if (!full) {
        buf.push(entry);
        if (buf.length === MAX_RECORDS) full = true;
      } else {
        buf[head] = entry;
        head = (head + 1) % MAX_RECORDS;
      }

      this.onFlush?.(entry);
    },

    drain() {
      const out = full
        ? [...buf.slice(head), ...buf.slice(0, head)]
        : buf.slice();
      buf.length = 0;
      head = 0;
      full = false;
      return out;
    },

    snapshot() {
      return full
        ? [...buf.slice(head), ...buf.slice(0, head)]
        : buf.slice();
    },
  };
}

export const registry: TraceRegistry = createRegistry();
