# RSI standalone plugin

Maintain RSI application code here. Use published, pinned official DSH packages; never patch or vendor DSH runtime sources, and never reference the former pm-rsi checkout in executable code or build scripts.

All application processes launch through the official dsh CLI and project-owned profiles. Preserve existing Session logs, cognitive evidence and human-review ownership. Keep project settings writable and durable, and keep credentials out of profiles and published artifacts.

Before finishing changes, run the affected tests, typecheck and build. Packaging changes also run the packed-install smoke against a clean temporary home with the official DSH runtime. Use ephemeral ports and owned temporary directories; await process cleanup. Publish or change running user deployments only when requested.

Write concise Chinese explanations. Keep public documentation and examples current. Use one trailing newline per file.
