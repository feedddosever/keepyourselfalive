import { mkdirSync, writeFileSync } from "node:fs";
import { runScenario } from "../dist/src/firewall/scenario.js";

const result = await runScenario();
mkdirSync("public", { recursive: true });
writeFileSync("public/scenario.json", JSON.stringify(result));
console.log(`scenario.json: ${result.steps.length} steps, ${result.audit.length} audit entries`);
