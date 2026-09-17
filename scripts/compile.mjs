import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import solc from "solc";

const sources = ["TipDisperser", "MockERC20"];
const input = {
  language: "Solidity",
  sources: Object.fromEntries(
    sources.map((name) => [`${name}.sol`, { content: readFileSync(`contracts/${name}.sol`, "utf8") }]),
  ),
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (output.errors ?? []).filter((e) => e.severity === "error");
if (errors.length) {
  for (const error of errors) console.error(error.formattedMessage);
  process.exit(1);
}

mkdirSync("artifacts", { recursive: true });
for (const name of sources) {
  const contract = output.contracts[`${name}.sol`][name];
  writeFileSync(
    `artifacts/${name}.json`,
    JSON.stringify({ abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}` }, null, 2),
  );
  console.log(`${name}: ${contract.evm.bytecode.object.length / 2} bytes`);
}
