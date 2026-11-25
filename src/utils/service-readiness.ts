/**
 * Stable startup events for the external release supervisor. They are emitted
 * independently of the operator's log level and contain no runtime secrets.
 */
export function reportServiceReadiness(
  component: "daemon" | "telegram",
  state: "ready" | "disabled",
): void {
  process.stdout.write(`BLACKDOGBOT_READY ${component} ${state}\n`);
}
