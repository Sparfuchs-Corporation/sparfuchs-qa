import type { RunState } from './run-state.js';
import { TtyRenderer } from './renderers/tty-renderer.js';

/**
 * Bridges RunState (data) + TtyRenderer (view) with keyboard input,
 * a 1-second refresh loop, and pause/quit control flow.
 */
export class DashboardController {
  private readonly state: RunState;
  private readonly renderer: TtyRenderer;
  private readonly isTTY: boolean;

  private refreshTimer: NodeJS.Timeout | null = null;
  private keyboardSetup = false;
  private paused = false;
  private quitRequested = false;
  private sortField: 'default' | 'name' | 'status' | 'duration' | 'findings' = 'default';

  constructor(state: RunState, renderer: TtyRenderer) {
    this.state = state;
    this.renderer = renderer;
    this.isTTY = (process.stderr.isTTY ?? false) && (process.stdin.isTTY ?? false);
  }

  isPaused(): boolean {
    return this.paused;
  }

  isQuitRequested(): boolean {
    return this.quitRequested;
  }

  /** Start keyboard input and the 1-second refresh loop. */
  start(): void {
    this.setupKeyboard();
    this.startRefreshLoop();
  }

  /** Stop refresh loop, restore stdin, and clear the TTY table. */
  teardown(): void {
    this.stopRefreshLoop();
    this.teardownKeyboard();
  }

  /** Force a render outside the refresh cycle (e.g., after agent state change). */
  render(): void {
    if (!this.isTTY) return;
    this.renderer.render(this.state.snapshot());
  }

  // --- Keyboard ---

  private setupKeyboard(): void {
    if (this.keyboardSetup || !this.isTTY) return;
    this.keyboardSetup = true;

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    process.stdin.on('data', (key: string) => {
      // Ctrl+C — first press = graceful quit, second = force
      if (key === '\x03') {
        if (this.quitRequested) process.exit(1);
        this.quitRequested = true;
        this.render();
        return;
      }

      const totalRows = this.state.snapshot().agentRows.length;

      switch (key) {
        case 'q':
        case 'Q':
          this.quitRequested = true;
          break;
        case 'p':
        case 'P':
          this.paused = true;
          break;
        case 'r':
        case 'R':
          this.paused = false;
          break;
        case 's':
        case 'S':
          this.cycleSortField();
          break;
        case 'd':
        case 'D':
          this.renderer.toggleDetail();
          break;
        case 'h':
        case '?':
          this.renderer.toggleHelp();
          break;
        case 'k':
        case '\x1b[A': // Arrow up
          this.renderer.scrollUp();
          break;
        case 'j':
        case '\x1b[B': // Arrow down
          this.renderer.scrollDown(5, totalRows);
          break;
        case '\x1b': // Escape (bare, not part of arrow sequence)
          if (this.renderer.isShowingHelp()) this.renderer.toggleHelp();
          break;
      }

      this.render();
    });
  }

  private teardownKeyboard(): void {
    if (!this.keyboardSetup) return;
    this.keyboardSetup = false;
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
  }

  private cycleSortField(): void {
    const order: typeof this.sortField[] = ['default', 'name', 'status', 'duration', 'findings'];
    const idx = order.indexOf(this.sortField);
    this.sortField = order[(idx + 1) % order.length];
  }

  // --- Refresh Loop ---

  private startRefreshLoop(): void {
    if (!this.isTTY || this.refreshTimer) return;
    this.refreshTimer = setInterval(() => {
      this.render();
    }, 1000);
  }

  private stopRefreshLoop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }
}
