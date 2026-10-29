/**
 * Capture BEFORE session/cancel: a server can exit during the cancellation grace
 * period, after which taskkill /T on the server PID cannot find its children.
 * The returned cleanup must run even if the root process has already exited.
 * POSIX callers already own a process group and need no additional snapshot.
 */
export declare function captureAcpDescendants(pid: number): Promise<() => Promise<void>>;
