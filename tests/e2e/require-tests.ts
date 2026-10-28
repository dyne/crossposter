import type { FullResult, Reporter, Suite } from "@playwright/test/reporter";

export default class RequireTests implements Reporter {
  private suite?: Suite;
  onBegin(_config: unknown, suite: Suite) { this.suite = suite; }
  async onEnd(result: FullResult): Promise<{ status: FullResult["status"] }> {
    const executed = this.suite?.allTests().some((test) => test.results.some((run) => run.status !== "skipped"));
    if (!executed) {
      console.error("No browser tests executed; zero matches or blanket skips cannot pass.");
      return { status: "failed" };
    }
    return { status: result.status };
  }
}
