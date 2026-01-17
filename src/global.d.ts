// Type declarations for World-Seed API exposed via preload

declare global {
    interface Window {
        api: {
            /**
             * Test IPC connectivity - returns "pong" from main process
             */
            ping: () => Promise<string>;
        };
    }
}

export { };
