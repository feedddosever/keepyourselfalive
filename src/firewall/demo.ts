import { runScenario } from "./scenario.js";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const { steps, audit } = await runScenario();

steps.forEach((step, index) => {
  console.log(`\n${BOLD}${index + 1}. ${step.title}${RESET}`);
  for (const line of step.lines) console.log(`   ${line}`);
  if (step.note) console.log(`   ${DIM}${step.note}${RESET}`);
});

console.log(`\n${BOLD}Audit trail${RESET}`);
for (const entry of audit) {
  const reason = entry.reason ? ` ${DIM}${entry.reason}${RESET}` : "";
  console.log(`   ${entry.laneKey}  ${entry.intentId.padEnd(18)} ${entry.decision}${reason}`);
}
