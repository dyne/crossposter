import type { Reporter, TestModule } from "vitest/node";

export default class RequireTests implements Reporter {
  onTestRunEnd(modules: ReadonlyArray<TestModule>) {
    const executed = modules.flatMap((module) => Array.from(module.children.allTests()))
      .some((test) => test.result().state === "passed" || test.result().state === "failed");
    if (!executed) {
      console.error("No application tests executed; zero matches or blanket skips cannot pass.");
      process.exitCode = 1;
    }
  }
}
