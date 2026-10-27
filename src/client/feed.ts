/** A reconnectable workflow catalog data source over the shared RSI Remote API. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

/** Minimal transport required by the operator's status source. */
export interface StatusReader<T> {
  /** @returns the latest authoritative server status. */
  status(): Promise<T>
}

/** Server facts and transport state published together to the console. */
export interface ConsoleSnapshot<T> {
  status: T | null
  loading: boolean
  busy: boolean
  error: string | null
}

/** Read server state without allowing older responses to replace newer control results. */
export class ConsoleFeed<T> {
  /** Stable status source consumed through renderer-bound hooks. */
  readonly source = createSnapshotStore<ConsoleSnapshot<T>>({ status: null, loading: true, busy: false, error: null })
  private timer: ReturnType<typeof setTimeout> | undefined
  private epoch = 0
  private targetGeneration = 0
  private stopped = false

  /**
   * @param remote - RSI status transport.
   * @param intervalMs - Polling interval after each completed read.
   */
  constructor(private readonly remote: StatusReader<T>, private readonly intervalMs: number | (() => number)) {}

  private pollInterval(): number { return typeof this.intervalMs === 'number' ? this.intervalMs : this.intervalMs() }

  private alive(): boolean {
    return !this.stopped
  }

  /** Start one status read and its subsequent polling chain. */
  start(): void {
    void this.refresh()
  }

  /** Clear a changed read target and reject responses admitted for its predecessor. */
  reset(): void {
    if (this.stopped) return
    clearTimeout(this.timer)
    this.epoch++
    this.targetGeneration++
    this.source.set({ status: null, loading: true, busy: false, error: null })
  }

  /**
   * Fetch current server state and reject stale in-flight response publication.
   * @returns when this read settles, including a retained transport failure.
   */
  async refresh(): Promise<void> {
    if (this.stopped) return
    clearTimeout(this.timer)
    const epoch = ++this.epoch
    try {
      const status = await this.remote.status()
      if (!this.alive() || epoch !== this.epoch) return
      this.source.set({ ...this.source.getSnapshot(), status, loading: false, error: null })
    } catch (error) {
      if (!this.alive() || epoch !== this.epoch) return
      this.source.set({ ...this.source.getSnapshot(), loading: false, error: error instanceof Error ? error.message : String(error) })
    } finally {
      if (this.alive() && epoch === this.epoch) this.timer = setTimeout(() => { void this.refresh() }, this.pollInterval())
    }
  }

  /**
   * Run one operator action and fetch the committed server state afterward.
   * @param action - Remote operation with server-side revision validation.
   * @returns whether the operation completed; errors remain visible in the console.
   */
  async command(action: () => Promise<unknown>): Promise<boolean> {
    if (this.stopped) return false
    const target = this.targetGeneration
    const current = () => this.alive() && target === this.targetGeneration
    this.epoch++
    clearTimeout(this.timer)
    this.source.set({ ...this.source.getSnapshot(), busy: true, error: null })
    try {
      await action()
      if (current()) await this.refresh()
      return true
    } catch (error) {
      if (current()) this.source.set({ ...this.source.getSnapshot(), error: error instanceof Error ? error.message : String(error) })
      return false
    } finally {
      if (current()) {
        this.source.set({ ...this.source.getSnapshot(), busy: false })
        clearTimeout(this.timer)
        this.timer = setTimeout(() => { void this.refresh() }, this.pollInterval())
      }
    }
  }

  /** Stop polling and reject every outstanding read's publication. */
  stop(): void {
    this.stopped = true
    this.epoch++
    this.targetGeneration++
    clearTimeout(this.timer)
  }
}
