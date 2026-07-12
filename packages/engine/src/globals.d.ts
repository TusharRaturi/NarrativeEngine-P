// The engine compiles against pure ES2022 (no DOM, no Node types) so that
// platform APIs cannot creep in. `console` is the one host global it may
// use; it exists in every host we target (browser, WebView, Node).
declare const console: {
    log(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
};
